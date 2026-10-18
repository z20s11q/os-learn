/**
 * T07f 单元测试（上半）：块层对象与队列侧对象（bio / request / request_queue /
 * hw_ctx / tags / virtqueue / 描述符链 / 描述符归属表 / 设备请求私有区）。
 *
 * 做法与 T07b–T07e 一致：**偏移来自 T07a 用真实 DWARF 生成的布局清单**，值由测试自己摆。
 * 覆盖 bio 游标、请求私有区偏移、描述符归属与畸形结构分类。
 * scripts/verify-t07f.mjs 使用真实停点与 GDB 独立实现核对偏移及字段值。
 *
 * 运行：node --test tests/linux-io.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BIO_FLAG_BITS,
  BIO_FLAG_COUNT,
  BLK_STATUS_NAMES,
  BufferCapture,
  IoParseError,
  KernelLayout,
  KernelMemoryView,
  REQ_FLAG_BITS,
  REQ_OP_BITS,
  REQ_OP_MASK,
  RQ_FLAG_BITS,
  RQ_FLAG_COUNT,
  VIRTIO_BLK_S,
  VIRTIO_BLK_T,
  VRING_DESC_F,
  addressSpaceOfDescriptors,
  availRingOffset,
  availSuppressesInterrupt,
  blkStatusName,
  classifyFileWriteState,
  classifyLifecycle,
  classifyMergeSplit,
  classifyReadahead,
  decodeBioOpf,
  decodeBitMask,
  decodeOp,
  describeVirtioBlkType,
  describeVringDescFlags,
  isReadahead,
  linkBioToFolios,
  lookupToken,
  mqRqStateName,
  readAvailRingHead,
  readBio,
  readDescriptorOwners,
  readGendisk,
  readHwCtx,
  readMqCtx,
  readMqTags,
  readRequest,
  readRequestQueue,
  readUsedRingElem,
  readVirtblkReq,
  readVirtqueue,
  readVringDescriptor,
  requestFlagBits,
  requestPduAddress,
  sectorsToBytes,
  structRequestSizeOf,
  traceRequest,
  usedElemSize,
  usedRingOffset,
  walkBioChain,
  walkDescriptorChain,
} from '../packages/linux-decoder/index.ts';

const LAYOUT_DIR = 'artifacts/layout';

function loadLayout() {
  const files = existsSync(LAYOUT_DIR) ? readdirSync(LAYOUT_DIR).filter((name) => name.endsWith('.json')) : [];
  if (files.length === 0) return null;
  return KernelLayout.load(join(LAYOUT_DIR, files[0]));
}

const layout = loadLayout();

function need(t) {
  if (layout === null) {
    t.skip(`需要在 ${LAYOUT_DIR} 下有一份布局清单，先跑 node packages/linux-decoder/tools/gen-layout.mjs`);
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* 造数据的小工具（按布局清单里的真实偏移写字段）                                */
/* -------------------------------------------------------------------------- */

function putInt(bytes, offset, value, width) {
  let rest = BigInt(value);
  if (rest < 0n) rest += 1n << BigInt(width * 8);
  for (let index = 0; index < width; index += 1) {
    bytes[offset + index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/** 按清单里的偏移（支持 `bi_iter.bi_sector`、`split.vring.desc` 这种点号路径）往内存里写值。 */
function putField(bytes, base, typeName, path, value) {
  const field = layout.fieldPath(typeName, path);
  putInt(bytes, Number(BigInt(base) + BigInt(field.byteOffset)), value, field.byteSize ?? 8);
}

function offsetOf(typeName, path) {
  return layout.fieldPath(typeName, path).byteOffset;
}

/** 一小段合成内存 + 一个内存视图。 */
function makeMemory(size = 0x20000) {
  const capture = new BufferCapture({ size });
  return { capture, view: new KernelMemoryView(capture) };
}

/**
 * 换一个新的内存视图。
 *
 * `KernelMemoryView` 自带**页缓存**（真实场景里这是必需的：内核结构散着放，一个 `task_struct`
 * 横跨两页）。测试改写合成内存后创建新视图，使后续读取获取改写后的字节。
 */
function freshView(capture) {
  return new KernelMemoryView(capture);
}

/* -------------------------------------------------------------------------- */
/* 常量表：哪些该从产物读、哪些只能抄                                            */
/* -------------------------------------------------------------------------- */

test('操作码从布局产物读：低 8 位是操作码，最低位是"写往设备"', (t) => {
  if (!need(t)) return;
  const read = decodeOp(layout, 0);
  assert.equal(read.op, 0);
  assert.equal(read.symbol, 'REQ_OP_READ');
  assert.equal(read.short, 'read');
  assert.equal(read.writesToDevice, false);
  assert.equal(read.flagBits, 0);

  const write = decodeOp(layout, 1);
  assert.equal(write.symbol, 'REQ_OP_WRITE');
  assert.equal(write.writesToDevice, true);

  // 低 8 位解为操作码，高位解为标志。
  const withFlag = decodeOp(layout, (1 << 19) | 1);
  assert.equal(withFlag.symbol, 'REQ_OP_WRITE');
  assert.equal(withFlag.flagBits, 1 << 19);

  // enum req_op 的空洞值映射为 unknown。
  assert.equal(decodeOp(layout, 4).symbol, null);

  assert.equal(REQ_OP_BITS, 8);
  assert.equal(REQ_OP_MASK, 0xff);
  assert.ok(layout.type('req_op').enumerators.every((entry) => entry.value === null || entry.value < (1 << REQ_OP_BITS)));
});

test('REQ_* 标志来自产物的 req_flag_bits，`__REQ_NR_BITS` 哨兵被滤掉', (t) => {
  if (!need(t)) return;
  const table = requestFlagBits(layout);
  assert.ok(table.length > 0);
  assert.ok(table.every((entry) => !entry.name.startsWith('__')), '名字里的 __ 前缀要剥掉');
  assert.ok(table.every((entry) => entry.raw.startsWith('__REQ_')), 'raw 保留原名以便对账');
  assert.ok(!table.some((entry) => entry.name === 'REQ_NR_BITS'), '哨兵不是真标志');

  const rahead = table.find((entry) => entry.name === 'REQ_RAHEAD');
  assert.ok(rahead, 'req_flag_bits 里应当有 __REQ_RAHEAD');
  const decoded = decodeBioOpf(layout, rahead.mask);
  assert.equal(decoded.op.symbol, 'REQ_OP_READ');
  assert.deepEqual(decoded.flags.names, ['REQ_RAHEAD']);
  assert.equal(decoded.flags.unknown, 0);
  assert.equal(isReadahead(decoded.flags), true);

  // bi_opf 高 24 位保留标志原位；req_flag_bits 表外的第 30 位计入 unknown。
  const opfStray = decodeBioOpf(layout, 1 << 30);
  assert.equal(opfStray.flags.unknown, 1 << 30);
  assert.equal(opfStray.flags.beyond, 0);
  assert.equal(isReadahead(opfStray.flags), false);

  // `req_flag_bits` 从第 8 位起（低 8 位是操作码），所以窗口内第 3 位是"表里没有的位"。
  const lowStray = decodeBitMask(1 << 3, requestFlagBits(layout), REQ_FLAG_BITS);
  assert.equal(lowStray.unknown, 1 << 3);
  assert.deepEqual(lowStray.names, []);

  // 这组位之外多出来的位单独报（`bi_flags` 只有 16 位宽）。
  const beyond = decodeBitMask(0x80000000, BIO_FLAG_BITS, 16);
  assert.equal(beyond.beyond, 0x80000000);
  assert.equal(beyond.unknown, 0);
});

test('BIO_* 与 RQF_* 是匿名枚举，表按头文件抄且逐位对齐', (t) => {
  if (!need(t)) return;
  assert.equal(BIO_FLAG_BITS.length, BIO_FLAG_COUNT);
  assert.ok(BIO_FLAG_COUNT > 0);
  BIO_FLAG_BITS.forEach((entry, index) => {
    assert.equal(entry.bit, index, '位号按表里的顺序递增');
    assert.equal(entry.mask, 2 ** index);
  });
  assert.equal(BIO_FLAG_BITS[0].name, 'BIO_PAGE_PINNED');
  assert.equal(BIO_FLAG_BITS[4].name, 'BIO_CHAIN');

  assert.equal(RQ_FLAG_BITS.length, RQ_FLAG_COUNT);
  RQ_FLAG_BITS.forEach((entry, index) => assert.equal(entry.bit, index));
  assert.equal(RQ_FLAG_BITS[0].name, 'RQF_STARTED');
  assert.equal(RQ_FLAG_BITS[1].name, 'RQF_FLUSH_SEQ', 'RQF_FLUSH_SEQ 与 REQ_PREFLUSH 是两个不同的位');

  // BIO_*、RQF_* 与 REQ_* 按各自名字空间解码。
  const reqNames = new Set(requestFlagBits(layout).map((entry) => entry.name));
  for (const entry of RQ_FLAG_BITS) assert.equal(reqNames.has(entry.name), false);
});

test('blk_status_t 在产物里只有 typedef、零枚举项，所以取值名只能从头文件抄', (t) => {
  if (!need(t)) return;
  assert.equal(layout.has('blk_status_t'), true);
  const type = layout.type('blk_status_t');
  assert.equal(type.byteSize, 1, '`typedef u8 __bitwise blk_status_t` 宽度 1 字节');
  assert.deepEqual(type.enumerators, [], '6.12 里取值是一串 #define，不是枚举');

  assert.equal(blkStatusName(0), 'BLK_STS_OK');
  assert.equal(blkStatusName(VIRTIO_BLK_S.IOERR + 9), 'BLK_STS_IOERR');
  assert.equal(blkStatusName(18), null, '查不到就是 null，不能拿 BLK_STS_OK 冒充');
  assert.ok(BLK_STATUS_NAMES.every((entry, index) => index === 0 || entry.value > BLK_STATUS_NAMES[index - 1].value));
});

test('uapi 协议常量：virtio-blk 类型（含 BARRIER 兼容位）与描述符标志', () => {
  // `VIRTIO_BLK_T_IN` 是"设备把数据读进来"，方向与块层 REQ_OP_* 相反，容易记反。
  assert.equal(VIRTIO_BLK_T.IN, 0);
  assert.equal(VIRTIO_BLK_T.OUT, 1);
  const plain = describeVirtioBlkType(VIRTIO_BLK_T.OUT);
  assert.equal(plain.symbol, 'VIRTIO_BLK_T_OUT');
  assert.equal(plain.barrier, false);

  const compat = describeVirtioBlkType((VIRTIO_BLK_T.OUT | VIRTIO_BLK_T.BARRIER) >>> 0);
  assert.equal(compat.barrier, true);
  assert.equal(compat.value, VIRTIO_BLK_T.OUT, '兼容位必须先剥掉再查表');
  assert.equal(compat.symbol, 'VIRTIO_BLK_T_OUT');

  assert.equal(describeVirtioBlkType(7).symbol, null);

  const flags = describeVringDescFlags(VRING_DESC_F.NEXT | VRING_DESC_F.WRITE | 0x8);
  assert.deepEqual(flags.names, ['VRING_DESC_F_NEXT', 'VRING_DESC_F_WRITE']);
  assert.equal(flags.unknown, 0x8, '低 3 位之外的位要报出来');
});

test('结构宽度与 PDU 偏移从布局产物读取', (t) => {
  if (!need(t)) return;
  const size = structRequestSizeOf(layout);
  assert.equal(size, layout.type('request').byteSize);
  assert.equal(requestPduAddress(layout, 0x1000n), 0x1000n + BigInt(size));
  assert.equal(sectorsToBytes(8n), 4096n);
  assert.equal(mqRqStateName(layout, layout.enumValue('mq_rq_state', 'MQ_RQ_IN_FLIGHT')), 'MQ_RQ_IN_FLIGHT');
  assert.equal(mqRqStateName(layout, 99), null);
});

/* -------------------------------------------------------------------------- */
/* bio                                                                        */
/* -------------------------------------------------------------------------- */

const BIO_AT = 0x9000n;
const BIO_VEC_AT = 0x9100n;

function putBioVec(capture, address, { page = 0n, length = 0, offset = 0 } = {}) {
  putField(capture.bytes, address, 'bio_vec', 'bv_page', page);
  putField(capture.bytes, address, 'bio_vec', 'bv_len', length);
  putField(capture.bytes, address, 'bio_vec', 'bv_offset', offset);
  return address;
}

function putBio(capture, address, options = {}) {
  const {
    next = 0n,
    bdev = 0x100n,
    opf = 0,
    biFlags = 0,
    status = 0,
    sector = 0n,
    size = 0,
    idx = 0,
    bvecDone = 0,
    vcnt = 0,
    maxVecs = 1,
    ioVec = 0n,
    endIo = 0n,
    private: priv = 0n,
  } = options;
  putField(capture.bytes, address, 'bio', 'bi_next', next);
  putField(capture.bytes, address, 'bio', 'bi_bdev', bdev);
  putField(capture.bytes, address, 'bio', 'bi_opf', opf);
  putField(capture.bytes, address, 'bio', 'bi_flags', biFlags);
  putField(capture.bytes, address, 'bio', 'bi_status', status);
  putField(capture.bytes, address, 'bio', 'bi_iter.bi_sector', sector);
  putField(capture.bytes, address, 'bio', 'bi_iter.bi_size', size);
  putField(capture.bytes, address, 'bio', 'bi_iter.bi_idx', idx);
  putField(capture.bytes, address, 'bio', 'bi_iter.bi_bvec_done', bvecDone);
  putField(capture.bytes, address, 'bio', 'bi_vcnt', vcnt);
  putField(capture.bytes, address, 'bio', 'bi_max_vecs', maxVecs);
  putField(capture.bytes, address, 'bio', 'bi_io_vec', ioVec);
  putField(capture.bytes, address, 'bio', 'bi_end_io', endIo);
  putField(capture.bytes, address, 'bio', 'bi_private', priv);
  return address;
}

/** 一个"页缓存回写"形状的 bio：一个向量，4096 字节，写往设备。 */
function putWriteBio(capture, address, options = {}) {
  const { next = 0n, sector = 8192n, bytes = 4096, ioVec = BIO_VEC_AT, page = 0xe000n, status = 0 } = options;
  putBio(capture, address, {
    next,
    opf: 1,
    status,
    sector,
    size: bytes,
    vcnt: 1,
    maxVecs: 1,
    ioVec,
    endIo: 0x1200n,
    private: 0x1300n,
  });
  putBioVec(capture, ioVec, { page, length: bytes, offset: 0 });
  return address;
}

test('读一个 bio：字段、区间与状态名都对得上', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putWriteBio(capture, BIO_AT);

  const bio = await readBio(view, layout, BIO_AT);
  assert.equal(bio.next, null);
  assert.equal(bio.bdev, 0x100n);
  assert.equal(bio.op.symbol, 'REQ_OP_WRITE');
  assert.equal(bio.op.writesToDevice, true);
  assert.deepEqual(bio.flags.names, []);
  assert.equal(bio.statusName, 'BLK_STS_OK');
  assert.equal(bio.vcnt, 1);
  assert.equal(bio.vectors.length, 1);
  assert.equal(bio.vectors[0].pageAddress, 0xe000n);
  assert.equal(bio.vectors[0].length, 4096);
  assert.equal(bio.totalBytes, 4096);
  assert.equal(bio.doneBytes, 0, 'bi_idx/bi_bvec_done 为 0 表示还没搬');
  assert.equal(bio.extentStart, 8192n);
  assert.equal(bio.extentEnd, 8200n);
  assert.deepEqual(bio.violations, []);
  assert.equal(bio.evidence.captureId, 'unit-test-capture');
});

test('bio 的完成状态用头文件名字表：非 0 值也要给出名字', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putWriteBio(capture, BIO_AT, { status: 10 });
  const bio = await readBio(view, layout, BIO_AT);
  assert.equal(bio.status, 10);
  assert.equal(bio.statusName, 'BLK_STS_IOERR');
});

test('bio 中断点：游标走过前几段时，区间要从当前扇区往回推算', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  // 两个向量各 4096 字节，游标已经到了第 2 个向量的第 512 字节：
  // 当前扇区只代表"还没搬完的那一段"的起点，原始起点要往前退 4096+512 字节。
  putBio(capture, BIO_AT, {
    opf: 1,
    sector: 100n,
    size: 3584,
    idx: 1,
    bvecDone: 512,
    vcnt: 2,
    maxVecs: 2,
    ioVec: BIO_VEC_AT,
  });
  putBioVec(capture, BIO_VEC_AT, { page: 0xe000n, length: 4096, offset: 0 });
  putBioVec(capture, BIO_VEC_AT + 16n, { page: 0xf000n, length: 4096, offset: 0 });

  const bio = await readBio(view, layout, BIO_AT);
  assert.equal(bio.totalBytes, 8192);
  assert.equal(bio.doneBytes, 4608, '已经搬完 4096 + 512');
  assert.equal(bio.bytesRemaining, 3584);
  assert.equal(bio.extentStart, 100n - 9n, '4608 字节 = 9 个扇区');
  assert.equal(bio.extentEnd, 91n + 16n);
  assert.deepEqual(bio.violations, []);
});

test('bio 字段自相矛盾时报告 violation', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putWriteBio(capture, BIO_AT);
  // 向量表说 4096 字节，游标说还没搬，而 bi_iter.bi_size 说只剩 1024。
  putField(capture.bytes, BIO_AT, 'bio', 'bi_iter.bi_size', 1024);
  const bio = await readBio(view, layout, BIO_AT);
  assert.equal(bio.violations.length, 1);
  assert.match(bio.violations[0], /对不上/);
});

test('bio 的操作码落在空洞、或是未知标志位时，都报出来', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  // 低 8 位 = 4（req_op 的空洞），高 24 位的第 30 位不属于 req_flag_bits。
  putBio(capture, BIO_AT, { opf: 4 | (1 << 30), vcnt: 0 });
  const bio = await readBio(view, layout, BIO_AT);
  assert.equal(bio.op.symbol, null);
  assert.equal(bio.flags.unknown, 1 << 30);
  assert.equal(bio.violations.length, 2);
  assert.ok(bio.violations.some((line) => line.includes('enum req_op')));
  assert.ok(bio.violations.some((line) => line.includes('req_flag_bits')));
});

test('bio 向量表读取缺口标记原始范围为未知', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putBio(capture, BIO_AT, { opf: 1, sector: 8192n, size: 12288, vcnt: 3, maxVecs: 3, ioVec: BIO_VEC_AT });
  for (let index = 0; index < 3; index += 1) {
    putBioVec(capture, BIO_VEC_AT + BigInt(index * 16), { page: 0xe000n + BigInt(index * 0x100), length: 4096, offset: 0 });
  }
  const bio = await readBio(view, layout, BIO_AT, { maxVectors: 1 });
  assert.equal(bio.vectors.length, 1);
  assert.equal(bio.doneBytes, -1, '-1 表示"算不出已搬字节数"，不是 0');
  assert.equal(bio.extentStart, bio.sector);
  assert.ok(bio.notes.some((line) => line.includes('上限')));
});

test('bio：vcnt 大于 0 且向量表为空指针时报告 violation', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putBio(capture, BIO_AT, { opf: 1, sector: 1n, size: 512, vcnt: 1, ioVec: 0n });
  const bio = await readBio(view, layout, BIO_AT);
  assert.equal(bio.violations.length, 1);
  assert.match(bio.violations[0], /bi_io_vec/);
});

test('bio 地址为 0 时报告空指针错误', async (t) => {
  if (!need(t)) return;
  const { view } = makeMemory();
  await assert.rejects(() => readBio(view, layout, 0n), IoParseError);
});

test('bio 链：相邻 bio 判为合并，间隔区间单独记录', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  const second = 0x9200n;
  putWriteBio(capture, BIO_AT, { next: second, sector: 8192n });
  putWriteBio(capture, second, { sector: 8200n, ioVec: 0x9300n, page: 0xf000n });

  const chain = await walkBioChain(view, layout, BIO_AT, { tail: second });
  assert.equal(chain.bios.length, 2);
  assert.equal(chain.contiguous, true, '相邻 bio 的扇区区间首尾相接');
  assert.deepEqual(chain.seams, []);
  assert.equal(chain.sectorStart, 8192n);
  assert.equal(chain.sectorEnd, 8208n);
  assert.equal(chain.cycle, false);
  assert.equal(chain.truncated, false);
  assert.deepEqual(chain.notes, [], '链尾与 biotail 一致时没有额外说明');

  // 把第二个 bio 的起点往后挪 100 个扇区：这就是"缝"。
  putWriteBio(capture, second, { sector: 8300n, ioVec: 0x9300n, page: 0xf000n });
  const seams = await walkBioChain(freshView(capture), layout, BIO_AT, { tail: second });
  assert.equal(seams.contiguous, false);
  assert.equal(seams.seams.length, 1);
  assert.match(seams.seams[0], /有缝/);
});

test('bio 链：成环被检出，而且 biotail 对不上要单独说明', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putWriteBio(capture, BIO_AT, { next: BIO_AT });
  const chain = await walkBioChain(view, layout, BIO_AT);
  assert.equal(chain.cycle, true);
  assert.equal(chain.bios.length, 1);

  const { capture: broken, view: brokenView } = makeMemory();
  putWriteBio(broken, BIO_AT, { next: 0x9200n });
  putWriteBio(broken, 0x9200n, { sector: 8200n, ioVec: 0x9300n });
  const mismatch = await walkBioChain(brokenView, layout, BIO_AT, { tail: 0x9990n });
  assert.ok(mismatch.notes.some((line) => line.includes('biotail')));
});

test('bio 链：空链与达到上限都如实给出', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  const empty = await walkBioChain(view, layout, null);
  assert.deepEqual(empty.bios, []);
  assert.equal(empty.sectorStart, null);

  const second = 0x9200n;
  putWriteBio(capture, BIO_AT, { next: second });
  putWriteBio(capture, second, { sector: 8200n, ioVec: 0x9300n });
  const limited = await walkBioChain(view, layout, BIO_AT, { limit: 1 });
  assert.equal(limited.bios.length, 1);
  assert.equal(limited.truncated, true);
  assert.ok(limited.notes.some((line) => line.includes('上限')));
});

/* -------------------------------------------------------------------------- */
/* request / request_queue / hw_ctx / mq_ctx / tags                            */
/* -------------------------------------------------------------------------- */

const REQUEST_AT = 0x1000n;
const QUEUE_AT = 0x2000n;
const HWCTX_AT = 0x3000n;
const TAGS_AT = 0xa000n;
const RQS_AT = 0xa200n;
const DISK_AT = 0xb000n;

function putRequest(capture, address, options = {}) {
  const {
    q = QUEUE_AT,
    mqCtx = 0n,
    mqHctx = HWCTX_AT,
    cmdFlags = 1,
    rqFlags = 0,
    tag = 3,
    internalTag = -1,
    timeout = 30000,
    dataLen = 4096,
    sector = 8192n,
    bio = 0n,
    bioTail = 0n,
    part = 0n,
    nrPhysSegments = 1,
    state = 1,
    ref = 1,
    endIo = 0x1400n,
  } = options;
  putField(capture.bytes, address, 'request', 'q', q);
  putField(capture.bytes, address, 'request', 'mq_ctx', mqCtx);
  putField(capture.bytes, address, 'request', 'mq_hctx', mqHctx);
  putField(capture.bytes, address, 'request', 'cmd_flags', cmdFlags);
  putField(capture.bytes, address, 'request', 'rq_flags', rqFlags);
  putField(capture.bytes, address, 'request', 'tag', tag);
  putField(capture.bytes, address, 'request', 'internal_tag', internalTag);
  putField(capture.bytes, address, 'request', 'timeout', timeout);
  putField(capture.bytes, address, 'request', '__data_len', dataLen);
  putField(capture.bytes, address, 'request', '__sector', sector);
  putField(capture.bytes, address, 'request', 'bio', bio);
  putField(capture.bytes, address, 'request', 'biotail', bioTail);
  putField(capture.bytes, address, 'request', 'part', part);
  putField(capture.bytes, address, 'request', 'nr_phys_segments', nrPhysSegments);
  putField(capture.bytes, address, 'request', 'state', state);
  putField(capture.bytes, address, 'request', 'ref', ref);
  putField(capture.bytes, address, 'request', 'end_io', endIo);
  return address;
}

function putQueue(capture, address, options = {}) {
  const {
    queuedata = 0n,
    disk = DISK_AT,
    nrHwQueues = 1,
    rqTimeout = 30000,
    queueDepth = 128,
    nrRequests = 128n,
    tagSet = 0x2100n,
    mqOps = 0x2200n,
    elevator = 0x2300n,
    mqFreezeDepth = 0,
  } = options;
  putField(capture.bytes, address, 'request_queue', 'queuedata', queuedata);
  putField(capture.bytes, address, 'request_queue', 'disk', disk);
  putField(capture.bytes, address, 'request_queue', 'nr_hw_queues', nrHwQueues);
  putField(capture.bytes, address, 'request_queue', 'rq_timeout', rqTimeout);
  putField(capture.bytes, address, 'request_queue', 'queue_depth', queueDepth);
  putField(capture.bytes, address, 'request_queue', 'nr_requests', nrRequests);
  putField(capture.bytes, address, 'request_queue', 'tag_set', tagSet);
  putField(capture.bytes, address, 'request_queue', 'mq_ops', mqOps);
  putField(capture.bytes, address, 'request_queue', 'elevator', elevator);
  putField(capture.bytes, address, 'request_queue', 'mq_freeze_depth', mqFreezeDepth);
  return address;
}

function putHwCtx(capture, address, options = {}) {
  const { queue = QUEUE_AT, tags = TAGS_AT, queueNum = 0, nrCtx = 1, type = 0, driverData = 0n, nrActive = 1 } = options;
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'queue', queue);
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'tags', tags);
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'queue_num', queueNum);
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'nr_ctx', nrCtx);
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'type', type);
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'driver_data', driverData);
  putField(capture.bytes, address, 'blk_mq_hw_ctx', 'nr_active', nrActive);
  return address;
}

function putTags(capture, address, options = {}) {
  const { nrTags = 8, nrReserved = 0, activeQueues = 1, rqs = RQS_AT } = options;
  putField(capture.bytes, address, 'blk_mq_tags', 'nr_tags', nrTags);
  putField(capture.bytes, address, 'blk_mq_tags', 'nr_reserved_tags', nrReserved);
  putField(capture.bytes, address, 'blk_mq_tags', 'active_queues', activeQueues);
  putField(capture.bytes, address, 'blk_mq_tags', 'rqs', rqs);
  return address;
}

test('读 request：同时报告 tag、地址与状态', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putRequest(capture, REQUEST_AT, { bio: BIO_AT, bioTail: BIO_AT, state: 1 });
  const request = await readRequest(view, layout, REQUEST_AT);

  assert.equal(request.queue, QUEUE_AT);
  assert.equal(request.mqHctx, HWCTX_AT);
  assert.equal(request.op.symbol, 'REQ_OP_WRITE');
  assert.equal(request.tag, 3);
  assert.equal(request.stateName, 'MQ_RQ_IN_FLIGHT');
  assert.equal(request.dataLen, 4096);
  assert.equal(request.sector, 8192n);
  assert.equal(request.sectorEnd, 8200n);
  assert.equal(request.bio, BIO_AT);
  assert.equal(request.nrPhysSegments, 1);
  assert.equal(request.pduAddress, REQUEST_AT + BigInt(structRequestSizeOf(layout)));
  assert.deepEqual(request.violations, []);

  await assert.rejects(() => readRequest(view, layout, 0n), IoParseError);
});

test('读 request：cmd_flags 落在空洞里时报 violation', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putRequest(capture, REQUEST_AT, { cmdFlags: 6 });
  const request = await readRequest(view, layout, REQUEST_AT);
  assert.equal(request.op.symbol, null);
  assert.equal(request.violations.length, 1);
});

test('读 request_queue：queuedata 是 virtio-blk 实际用的那一条', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putQueue(capture, QUEUE_AT, { queuedata: 0x4000n });
  const queue = await readRequestQueue(view, layout, QUEUE_AT);
  assert.equal(queue.queuedata, 0x4000n);
  assert.equal(queue.disk, DISK_AT);
  assert.equal(queue.nrHwQueues, 1);
  assert.equal(queue.nrRequests, 128n);
  assert.equal(queue.tagSet, 0x2100n);
  assert.equal(queue.mqFreezeDepth, 0);
  assert.equal(queue.hctxTableAddress, QUEUE_AT + BigInt(offsetOf('request_queue', 'hctx_table')));

  // 异常字段值进入结构告警。
  putQueue(capture, QUEUE_AT, { queuedata: 0x4000n, nrHwQueues: 100000 });
  const bogus = await readRequestQueue(freshView(capture), layout, QUEUE_AT);
  assert.equal(bogus.nrHwQueues, 100000);
  assert.ok(bogus.notes.some((line) => line.includes('nr_hw_queues')));

  await assert.rejects(() => readRequestQueue(view, layout, 0n), IoParseError);
});

test('读 hw_ctx 与 mq_ctx：queue_num 与 index_hw 是两套编号', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putHwCtx(capture, HWCTX_AT, { queueNum: 2 });
  const hwCtx = await readHwCtx(view, layout, HWCTX_AT);
  assert.equal(hwCtx.queue, QUEUE_AT);
  assert.equal(hwCtx.tags, TAGS_AT);
  assert.equal(hwCtx.queueNum, 2, 'virtio-blk 用它选 vqs[queue_num]');
  assert.equal(hwCtx.nrCtx, 1);
  assert.equal(hwCtx.ctxsAddress, HWCTX_AT + BigInt(offsetOf('blk_mq_hw_ctx', 'ctxs')));

  const CTX_AT = 0x5000n;
  putField(capture.bytes, CTX_AT, 'blk_mq_ctx', 'cpu', 3);
  putField(capture.bytes, CTX_AT, 'blk_mq_ctx', 'queue', QUEUE_AT);
  // `index_hw` 是 `unsigned short[3]`：这里让第 0 个元素是 2（CPU3 归到硬件队列 2）。
  const indexHwAt = Number(CTX_AT) + offsetOf('blk_mq_ctx', 'index_hw');
  putInt(capture.bytes, indexHwAt, 2, 2);
  putInt(capture.bytes, indexHwAt + 2, 5, 2);
  const mqCtx = await readMqCtx(view, layout, CTX_AT);
  assert.equal(mqCtx.cpu, 3);
  assert.equal(mqCtx.indexHw, 2, '取数组第一个元素，不是把整段当一个数');
  assert.equal(mqCtx.queue, QUEUE_AT);
});

test('读 tags：tag → 请求的映射，复用中的槽位会被发现', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putTags(capture, TAGS_AT);
  putInt(capture.bytes, Number(RQS_AT) + 3 * 8, BigInt(REQUEST_AT), 8);
  const tags = await readMqTags(view, layout, TAGS_AT);
  assert.equal(tags.nrTags, 8);
  assert.equal(tags.tagged.length, 8);
  assert.equal(tags.tagged[3].request, REQUEST_AT);
  assert.equal(tags.tagged[0].request, null);
  assert.equal(tags.rqsAddress, TAGS_AT + BigInt(offsetOf('blk_mq_tags', 'rqs')));
});

/* -------------------------------------------------------------------------- */
/* virtqueue / 描述符链 / 描述符归属表                                          */
/* -------------------------------------------------------------------------- */

const VQ_AT = 0x5000n;
const DESC_AT = 0x6000n;
const AVAIL_AT = 0x7000n;
const USED_AT = 0x7100n;
const DESC_STATE_AT = 0x8000n;
const QNAME_AT = 0x9400n;
const PDU_AT = REQUEST_AT + 248n;

function putVirtqueue(capture, address, options = {}) {
  const {
    num = 8,
    desc = DESC_AT,
    avail = AVAIL_AT,
    used = USED_AT,
    descState = DESC_STATE_AT,
    descExtra = 0x8100n,
    name = QNAME_AT,
    nameText = 'vda-io',
    packedRing = 0,
    useDmaApi = 0,
    indirect = 1,
    index = 0,
    numFree = 7,
    numMax = 8,
    availIdxShadow = 1,
    availFlagsShadow = 0,
    freeHead = 1,
    lastUsedIdx = 0,
  } = options;
  putField(capture.bytes, address, 'vring_virtqueue', 'packed_ring', packedRing);
  putField(capture.bytes, address, 'vring_virtqueue', 'use_dma_api', useDmaApi);
  putField(capture.bytes, address, 'vring_virtqueue', 'indirect', indirect);
  putField(capture.bytes, address, 'vring_virtqueue', 'broken', 0);
  putField(capture.bytes, address, 'vring_virtqueue', 'event', 0);
  putField(capture.bytes, address, 'vring_virtqueue', 'free_head', freeHead);
  putField(capture.bytes, address, 'vring_virtqueue', 'last_used_idx', lastUsedIdx);
  putField(capture.bytes, address, 'vring_virtqueue', 'vq.index', index);
  putField(capture.bytes, address, 'vring_virtqueue', 'vq.num_free', numFree);
  putField(capture.bytes, address, 'vring_virtqueue', 'vq.num_max', numMax);
  putField(capture.bytes, address, 'vring_virtqueue', 'vq.name', name);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.vring.num', num);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.vring.desc', desc);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.vring.avail', avail);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.vring.used', used);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.desc_state', descState);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.desc_extra', descExtra);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.avail_flags_shadow', availFlagsShadow);
  putField(capture.bytes, address, 'vring_virtqueue', 'split.avail_idx_shadow', availIdxShadow);
  if (name !== 0n) {
    const bytes = Buffer.from(nameText, 'utf8');
    capture.bytes.fill(0, Number(name), Number(name) + bytes.length + 1);
    capture.bytes.set(bytes, Number(name));
  }
  return address;
}

/** avail/used 环头（flags/idx）与可选的环内容。 */
function putRings(capture, layoutRef, { availFlags = 0, availIdx = 1, heads = [0], usedFlags = 0, usedIdx = 0, usedEntries = [] } = {}) {
  const availRing = Number(AVAIL_AT) + availRingOffset(layoutRef);
  putInt(capture.bytes, Number(AVAIL_AT), availFlags, 2);
  putInt(capture.bytes, Number(AVAIL_AT) + 2, availIdx, 2);
  heads.forEach((head, index) => putInt(capture.bytes, availRing + index * 2, head, 2));

  const usedRing = Number(USED_AT) + usedRingOffset(layoutRef);
  const elemSize = usedElemSize(layoutRef);
  putInt(capture.bytes, Number(USED_AT), usedFlags, 2);
  putInt(capture.bytes, Number(USED_AT) + 2, usedIdx, 2);
  usedEntries.forEach((entry, index) => {
    putInt(capture.bytes, usedRing + index * elemSize, entry.id, 4);
    putInt(capture.bytes, usedRing + index * elemSize + 4, entry.len, 4);
  });
}

function putDesc(capture, base, index, { addr = 0n, len = 0, flags = 0, next = 0 } = {}) {
  const at = base + BigInt(index * 16);
  putField(capture.bytes, at, 'vring_desc', 'addr', addr);
  putField(capture.bytes, at, 'vring_desc', 'len', len);
  putField(capture.bytes, at, 'vring_desc', 'flags', flags);
  putField(capture.bytes, at, 'vring_desc', 'next', next);
}

function putDescState(capture, base, index, { data = 0n, indir = 0n } = {}) {
  const at = base + BigInt(index * 16);
  putField(capture.bytes, at, 'vring_desc_state_split', 'data', data);
  putField(capture.bytes, at, 'vring_desc_state_split', 'indir_desc', indir);
}

/** 一条普通的 3 段链：请求头 → 数据 → 状态。 */
function putSimpleChain(capture, layoutRef, { head = 0, dataAddr = 0x9500n, dataLen = 4096, dataFlags = VRING_DESC_F.WRITE } = {}) {
  putDesc(capture, DESC_AT, head, { addr: PDU_AT, len: 16, flags: VRING_DESC_F.NEXT, next: head + 1 });
  putDesc(capture, DESC_AT, head + 1, { addr: dataAddr, len: dataLen, flags: VRING_DESC_F.NEXT | dataFlags, next: head + 2 });
  putDesc(capture, DESC_AT, head + 2, { addr: PDU_AT + 16n, len: 1, flags: VRING_DESC_F.WRITE, next: 0 });
  putRings(capture, layoutRef, { availIdx: 1, heads: [head], usedIdx: 0 });
  putDescState(capture, DESC_STATE_AT, head, { data: PDU_AT });
}

test('读 virtqueue：环长、环头、影子值与坐标系结论', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtqueue(capture, VQ_AT);
  putRings(capture, layout, { availIdx: 3, usedIdx: 1, heads: [0, 3, 5] });

  const vq = await readVirtqueue(view, layout, VQ_AT);
  assert.equal(vq.num, 8);
  assert.equal(vq.name, 'vda-io');
  assert.equal(vq.availIdx, 3, '公开的 avail->idx 与影子值是两回事');
  assert.equal(vq.availIdxShadow, 1);
  assert.equal(vq.usedIdx, 1);
  assert.equal(vq.packedRing, false);
  assert.equal(vq.useDmaApi, false);
  assert.deepEqual(vq.violations, []);
  assert.equal(await readAvailRingHead(view, layout, vq, 1), 3);
  assert.deepEqual(await readUsedRingElem(view, layout, vq, 0), { id: 0, len: 0 });
  assert.equal(availSuppressesInterrupt(vq), false);

  const physical = addressSpaceOfDescriptors(vq);
  assert.equal(physical.kind, 'physical');
  assert.match(physical.reason, /use_dma_api/);
});

test('读 virtqueue：packed 环、非法环长或空环地址被明确拒绝', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtqueue(capture, VQ_AT, { packedRing: 1, num: 6, desc: 0n, avail: 0n, used: 0n, descState: 0n });
  const vq = await readVirtqueue(view, layout, VQ_AT);
  assert.equal(vq.packedRing, true);
  assert.ok(vq.violations.some((line) => line.includes('packed_ring')));
  assert.ok(vq.violations.some((line) => line.includes('2 的幂')));
  assert.ok(vq.violations.some((line) => line.includes('空指针')));

  const dma = addressSpaceOfDescriptors(vq);
  assert.equal(dma.kind, 'physical', 'use_dma_api 没立着就是物理地址');
  putVirtqueue(capture, VQ_AT, { useDmaApi: 1 });
  const withdma = await readVirtqueue(freshView(capture), layout, VQ_AT);
  assert.equal(withdma.useDmaApi, true);
  assert.equal(addressSpaceOfDescriptors(withdma).kind, 'dma');
});

test('描述符链：NEXT=0 标记链尾，段数与长度合计正确', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtqueue(capture, VQ_AT);
  putSimpleChain(capture, layout);
  const vq = await readVirtqueue(view, layout, VQ_AT);

  const chain = await walkDescriptorChain(view, layout, vq, 0);
  assert.deepEqual(chain.descriptors.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(chain.descriptors.map((item) => item.flagsDecode.names), [
    ['VRING_DESC_F_NEXT'],
    ['VRING_DESC_F_NEXT', 'VRING_DESC_F_WRITE'],
    ['VRING_DESC_F_WRITE'],
  ]);
  assert.equal(chain.totalLength, 16 + 4096 + 1);
  assert.equal(chain.indirect, false);
  assert.equal(chain.cycle, false);
  assert.equal(chain.truncated, false);
  assert.deepEqual(chain.violations, []);

  const descriptor = await readVringDescriptor(view, layout, DESC_AT, 1);
  assert.equal(descriptor.addr, 0x9500n);
  assert.equal(descriptor.isIndirect, false);
});

test('描述符链：成环与 next 越界时报告原因并终止展开', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtqueue(capture, VQ_AT);
  putDesc(capture, DESC_AT, 0, { addr: 0x100n, len: 16, flags: VRING_DESC_F.NEXT, next: 1 });
  putDesc(capture, DESC_AT, 1, { addr: 0x200n, len: 16, flags: VRING_DESC_F.NEXT, next: 0 });
  const vq = await readVirtqueue(view, layout, VQ_AT);
  const cycle = await walkDescriptorChain(view, layout, vq, 0);
  assert.equal(cycle.cycle, true);
  assert.equal(cycle.descriptors.length, 2);

  putDesc(capture, DESC_AT, 0, { addr: 0x100n, len: 16, flags: VRING_DESC_F.NEXT, next: 99 });
  const outOfRange = await walkDescriptorChain(freshView(capture), layout, vq, 0);
  assert.ok(outOfRange.violations.some((line) => line.includes('超出环长')));
});

test('描述符链：INDIRECT 时主环那一个只是"指向一张表"，表里的段单独展开', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  const TABLE_AT = 0x9600n;
  putVirtqueue(capture, VQ_AT);
  putDesc(capture, DESC_AT, 0, { addr: TABLE_AT, len: 48, flags: VRING_DESC_F.INDIRECT, next: 0 });
  putDesc(capture, TABLE_AT, 0, { addr: PDU_AT, len: 16, flags: VRING_DESC_F.NEXT, next: 1 });
  putDesc(capture, TABLE_AT, 1, { addr: 0x9700n, len: 512, flags: VRING_DESC_F.WRITE, next: 0 });
  putRings(capture, layout, { availIdx: 1, heads: [0] });

  const vq = await readVirtqueue(view, layout, VQ_AT);
  const chain = await walkDescriptorChain(view, layout, vq, 0);
  assert.equal(chain.indirect, true);
  assert.equal(chain.indirectTableAddress, TABLE_AT);
  assert.equal(chain.descriptors.length, 1, '主环里只有一个描述符');
  assert.equal(chain.indirectDescriptors.length, 2);
  assert.equal(chain.totalLength, 48 + 16 + 512);
  assert.ok(chain.notes.some((line) => line.includes('INDIRECT')));
});

test('描述符归属表：token 是"描述符头 → 请求"的权威关联，缺与重都要报歧义', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtqueue(capture, VQ_AT);
  putSimpleChain(capture, layout);
  putDescState(capture, DESC_STATE_AT, 2, { data: 0x1200n });
  const vq = await readVirtqueue(view, layout, VQ_AT);

  const owners = await readDescriptorOwners(view, layout, vq);
  assert.equal(owners.owners.length, 8, '每个描述符头一个槽');
  assert.equal(owners.occupied, 2);
  assert.equal(owners.distinctTokens, 2);

  const unique = lookupToken(owners, PDU_AT);
  assert.equal(unique.unique, true);
  assert.deepEqual(unique.heads, [0]);
  assert.equal(unique.ambiguity, null);

  const missing = lookupToken(owners, 0xdeadn);
  assert.equal(missing.unique, false);
  assert.equal(missing.heads.length, 0);
  assert.match(missing.ambiguity, /没有任何描述符头/);

  putDescState(capture, DESC_STATE_AT, 3, { data: PDU_AT });
  const duplicated = lookupToken(await readDescriptorOwners(freshView(capture), layout, vq), PDU_AT);
  assert.equal(duplicated.unique, false);
  assert.deepEqual(duplicated.heads, [0, 3]);
  assert.match(duplicated.ambiguity, /都等于/);
});

/* -------------------------------------------------------------------------- */
/* 设备请求私有区：virtblk_req                                                  */
/* -------------------------------------------------------------------------- */

const SG_AT = 0x9200n;

function putVirtblkReq(capture, address, options = {}) {
  const {
    outType = VIRTIO_BLK_T.OUT,
    ioprio = 0,
    sector = 8192n,
    inHdrLen = 1,
    status = 0,
    sgNents = 1,
    sgOrigNents = 1,
    sgl = SG_AT,
  } = options;
  putField(capture.bytes, address, 'virtblk_req', 'out_hdr.type', outType);
  putField(capture.bytes, address, 'virtblk_req', 'out_hdr.ioprio', ioprio);
  putField(capture.bytes, address, 'virtblk_req', 'out_hdr.sector', sector);
  putField(capture.bytes, address, 'virtblk_req', 'in_hdr_len', inHdrLen);
  putField(capture.bytes, address, 'virtblk_req', 'sg_table.nents', sgNents);
  putField(capture.bytes, address, 'virtblk_req', 'sg_table.orig_nents', sgOrigNents);
  putField(capture.bytes, address, 'virtblk_req', 'sg_table.sgl', sgl);
  const inHdrAt = Number(address) + offsetOf('virtblk_req', 'in_hdr');
  putInt(capture.bytes, inHdrAt, status, 1);
  return address;
}

function putSgEntry(capture, base, index, options = {}) {
  const { pageLink = 0xe000n, offset = 0, length = 4096, dmaAddress = 0n, dmaLength = 0 } = options;
  const at = base + BigInt(index * 32);
  putField(capture.bytes, at, 'scatterlist', 'page_link', pageLink);
  putField(capture.bytes, at, 'scatterlist', 'offset', offset);
  putField(capture.bytes, at, 'scatterlist', 'length', length);
  putField(capture.bytes, at, 'scatterlist', 'dma_address', dmaAddress);
  putField(capture.bytes, at, 'scatterlist', 'dma_length', dmaLength);
}

test('读 virtblk_req：状态字节在 in_hdr + in_hdr_len - 1', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtblkReq(capture, PDU_AT, { status: 0 });
  putSgEntry(capture, SG_AT, 0, { pageLink: 0xe000n | 0x1n, length: 4096 });

  const req = await readVirtblkReq(view, layout, PDU_AT);
  assert.equal(req.outTypeSymbol, 'VIRTIO_BLK_T_OUT');
  assert.equal(req.outSector, 8192n);
  assert.equal(req.inHdrLen, 1);
  assert.equal(req.status, 0);
  assert.equal(req.statusName, 'VIRTIO_BLK_S_OK');
  assert.equal(req.sgNents, 1);
  assert.equal(req.sgEntries.length, 1);
  assert.equal(req.sgEntries[0].pageAddress, 0xe000n, 'page_link 低两位是标记，不是地址的一部分');
  assert.equal(req.sgEntries[0].pageLink, 0xe001n);
  assert.deepEqual(req.violations, []);

  // in_hdr_len=2 时状态字节位于偏移 1。
  putVirtblkReq(capture, PDU_AT, { inHdrLen: 2, status: 0 });
  const inHdrAt = Number(PDU_AT) + offsetOf('virtblk_req', 'in_hdr');
  putInt(capture.bytes, inHdrAt + 1, VIRTIO_BLK_S.IOERR, 1);
  const shifted = await readVirtblkReq(freshView(capture), layout, PDU_AT);
  assert.equal(shifted.status, VIRTIO_BLK_S.IOERR);
  assert.equal(shifted.statusName, 'VIRTIO_BLK_S_IOERR');
});

test('读 virtblk_req：类型认不出、in_hdr_len 为 0、BARRIER 兼容位各自有说法', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putVirtblkReq(capture, PDU_AT, { outType: 7, inHdrLen: 0, sgNents: 0 });
  const broken = await readVirtblkReq(view, layout, PDU_AT);
  assert.equal(broken.outTypeSymbol, null);
  assert.equal(broken.status, -1, '定位不到状态字节时给 -1，不是 0');
  assert.equal(broken.statusName, null);
  assert.ok(broken.violations.some((line) => line.includes('VIRTIO_BLK_T_*')));
  assert.ok(broken.violations.some((line) => line.includes('in_hdr_len')));
  assert.ok(broken.notes.some((line) => line.includes('不带数据段')));

  putVirtblkReq(capture, PDU_AT, { outType: (VIRTIO_BLK_T.IN | VIRTIO_BLK_T.BARRIER) >>> 0, inHdrLen: 1 });
  const compat = await readVirtblkReq(freshView(capture), layout, PDU_AT);
  assert.equal(compat.outTypeSymbol, 'VIRTIO_BLK_T_IN');
  assert.equal(compat.outTypeBarrier, true);
  assert.ok(compat.notes.some((line) => line.includes('BARRIER')));

  await assert.rejects(() => readVirtblkReq(view, layout, 0n), IoParseError);
});

/* -------------------------------------------------------------------------- */
/* 关联层：请求追踪 → 生命周期 → 合并/拆分 → 预读 → bio→folio → 缓存命中          */
/* -------------------------------------------------------------------------- */

const VBLK_AT = 0x4000n;
const VQS_AT = 0x4200n;
const MAPPING_AT = 0xc000n;
/** vmemmap 的合成基址：页框 0 的 `struct page` 就在这个地址上。 */
const PAGE_BASE = 0xd000n;
const PAGE_STRUCT_SIZE = 64n;

/** 写一个"virtio_blk 上的写请求正在设备里"的完整场景：请求 → 队列 → 硬件上下文 →
 *  驱动状态 → virtqueue → 描述符链 → 描述符归属表 → 设备请求私有区 → bio 链。 */
function buildVirtioBlkTrace(capture, options = {}) {
  const {
    tag = 3,
    rqsTag = REQUEST_AT,
    availIdx = 1,
    usedIdx = 0,
    descStateToken = PDU_AT,
    nrPhysSegments = 1,
    sgNents = 1,
    requestState = 1,
  } = options;

  putRequest(capture, REQUEST_AT, {
    q: QUEUE_AT,
    mqHctx: HWCTX_AT,
    tag,
    bio: BIO_AT,
    bioTail: BIO_AT,
    nrPhysSegments,
    state: requestState,
    dataLen: 4096,
    sector: 8192n,
  });
  putQueue(capture, QUEUE_AT, { queuedata: VBLK_AT, disk: DISK_AT, nrHwQueues: 1 });
  putHwCtx(capture, HWCTX_AT, { queue: QUEUE_AT, queueNum: 0, tags: TAGS_AT, nrCtx: 1 });

  // `struct virtio_blk`：virtio-blk 取队列走的是 `hctx->queue->queuedata`。
  putField(capture.bytes, VBLK_AT, 'virtio_blk', 'vdev', 0n);
  putField(capture.bytes, VBLK_AT, 'virtio_blk', 'disk', DISK_AT);
  putField(capture.bytes, VBLK_AT, 'virtio_blk', 'index', 0);
  putField(capture.bytes, VBLK_AT, 'virtio_blk', 'num_vqs', 1);
  putField(capture.bytes, VBLK_AT, 'virtio_blk', 'vqs', VQS_AT);
  const ioQueueAt = Number(VBLK_AT) + offsetOf('virtio_blk', 'io_queues');
  [0, 0, 0].forEach((value, index) => putInt(capture.bytes, ioQueueAt + index * 4, value, 4));
  // `virtio_blk.vqs[0].vq`
  putInt(capture.bytes, Number(VQS_AT), BigInt(VQ_AT), 8);

  putVirtqueue(capture, VQ_AT, { num: 8, availIdxShadow: availIdx });
  putSimpleChain(capture, layout, { head: 0 });
  putRings(capture, layout, { availIdx, usedIdx, heads: [0] });
  putDescState(capture, DESC_STATE_AT, 0, { data: descStateToken });

  putWriteBio(capture, BIO_AT, { sector: 8192n, page: PAGE_BASE, ioVec: BIO_VEC_AT });
  putVirtblkReq(capture, PDU_AT, {
    outType: VIRTIO_BLK_T.OUT,
    sector: 8192n,
    inHdrLen: 1,
    status: 0,
    sgNents,
  });
  putSgEntry(capture, SG_AT, 0, { pageLink: PAGE_BASE, length: 4096 });

  putTags(capture, TAGS_AT);
  putInt(capture.bytes, Number(RQS_AT) + tag * 8, BigInt(rqsTag), 8);

  putField(capture.bytes, DISK_AT, 'gendisk', 'major', 254);
  putField(capture.bytes, DISK_AT, 'gendisk', 'minors', 16);
  putField(capture.bytes, DISK_AT, 'gendisk', 'queue', QUEUE_AT);
  putField(capture.bytes, DISK_AT, 'gendisk', 'private_data', VBLK_AT);
  const nameAt = Number(DISK_AT) + offsetOf('gendisk', 'disk_name');
  capture.bytes.fill(0, nameAt, nameAt + 32);
  capture.bytes.set(Buffer.from('vda', 'utf8'), nameAt);
  return capture;
}

/** 算一个 `VmemmapFacts`：只要基址与步长对，"页地址 ↔ 页框号"的换算就能对账。 */
function fakeVmemmap(base = PAGE_BASE, pageStructSize = PAGE_STRUCT_SIZE) {
  return {
    base,
    source: 'compiled-default',
    pageStructSize,
    sectionNumber: 0n,
    sectionArray: null,
    sectionAddress: null,
    sectionMemMapRaw: null,
    sectionStartPfn: 0n,
    sectionMarkedPresent: false,
    sectionHasMemMap: false,
    matchesCompiledDefault: null,
    notes: [],
    evidence: { kind: 'decoded', source: 'test', captureId: 'unit-test-capture', refs: [] },
  };
}

/** 按 `pageflags` 枚举把若干位立起来（`PG_dirty` 之类）。 */
function folioFlagBits(...names) {
  let flags = 0n;
  for (const name of names) flags |= 1n << BigInt(layout.enumValue('pageflags', name));
  return flags;
}

/** 在合成内存里摆一个 `struct folio`（页框 0 的位置）。 */
function putFolio(capture, address, options = {}) {
  const { mapping = MAPPING_AT, index = 0n, labels = [] } = options;
  putField(capture.bytes, address, 'folio', 'flags', folioFlagBits(...labels));
  putField(capture.bytes, address, 'folio', 'mapping', mapping);
  putField(capture.bytes, address, 'folio', 'index', index);
  return address;
}

/**
 * 一个"够用来测判读函数"的假 trace：只有 `classifyMergeSplit` / `classifyReadahead`
 * 会看的那几个字段。真正的一整条 trace 由 `traceRequest` 现读（下面另有用例）。
 */
function fakeTrace(options = {}) {
  const { chain, nrPhysSegments = 0, dataLen = 0, flagNames = [] } = options;
  return {
    request: {
      address: REQUEST_AT,
      tag: 3,
      dataLen,
      nrPhysSegments,
      flags: { names: flagNames, bits: [], unknown: 0, beyond: 0, raw: 0 },
    },
    bioChain: chain,
  };
}

test('traceRequest：从请求一路走到描述符链与设备请求，地址与区间全程留档', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  buildVirtioBlkTrace(capture);

  const trace = await traceRequest(view, layout, REQUEST_AT);
  assert.equal(trace.queue.queuedata, VBLK_AT);
  assert.equal(trace.hwCtx.queueNum, 0);
  assert.equal(trace.driverState.address, VBLK_AT);
  assert.equal(trace.driverState.disk, DISK_AT);
  assert.equal(trace.vq.address, VQ_AT);
  assert.equal(trace.vq.num, 8);
  assert.equal(trace.disk, DISK_AT);
  assert.equal(trace.pdu.outTypeSymbol, 'VIRTIO_BLK_T_OUT');
  assert.equal(trace.pdu.outSector, 8192n);
  assert.equal(trace.identity.tag, 3);
  assert.equal(trace.identity.pduAddress, `0x${PDU_AT.toString(16)}`);
  assert.equal(trace.identity.state, 'MQ_RQ_IN_FLIGHT');

  assert.equal(trace.owners.occupied, 1);
  assert.equal(trace.tokenLookup.unique, true);
  assert.deepEqual(trace.tokenLookup.heads, [0]);
  assert.deepEqual(trace.descriptorChain.descriptors.map((item) => item.index), [0, 1, 2]);
  assert.equal(trace.bioChain.bios.length, 1);
  assert.equal(trace.lifecycle, 'in-flight-on-device');
  assert.deepEqual(trace.ambiguities, []);
  assert.equal(trace.unique, true);
  assert.equal(trace.evidence.captureId, 'unit-test-capture');
});

test('traceRequest：tag 被复用、段数对不上、设备头扇区不符都不给唯一结论', async (t) => {
  if (!need(t)) return;

  // tags->rqs[tag] 指向另一个请求时报告身份歧义。
  const reused = makeMemory();
  buildVirtioBlkTrace(reused.capture, { rqsTag: 0x9900n });
  const reusedTrace = await traceRequest(reused.view, layout, REQUEST_AT);
  assert.equal(reusedTrace.unique, false);
  assert.ok(reusedTrace.ambiguities.some((line) => line.includes('tag')));

  // 私有区说 sg 有 2 段，而环上只有 3 段（1 + 2 + 1 = 4 才对）。
  const segment = makeMemory();
  buildVirtioBlkTrace(segment.capture, { sgNents: 2 });
  const segmentTrace = await traceRequest(segment.view, layout, REQUEST_AT);
  assert.equal(segmentTrace.unique, false);
  assert.ok(segmentTrace.ambiguities.some((line) => line.includes('段')));

  // 设备头里的扇区与块层请求不是同一处。
  const shifted = makeMemory();
  buildVirtioBlkTrace(shifted.capture);
  putVirtblkReq(shifted.capture, PDU_AT, { outType: VIRTIO_BLK_T.OUT, sector: 9000n, inHdrLen: 1, sgNents: 1 });
  const shiftedTrace = await traceRequest(shifted.view, layout, REQUEST_AT);
  assert.equal(shiftedTrace.unique, false);
  assert.ok(shiftedTrace.ambiguities.some((line) => line.includes('设备头里的扇区')));
});

test('classifyLifecycle：两个计数器 + 状态表才能把四个阶段分开', async (t) => {
  if (!need(t)) return;
  const cases = [
    { label: '还没加进环', availIdx: 1, usedIdx: 0, token: 0n, expected: 'not-submitted' },
    { label: '在环上等设备', availIdx: 1, usedIdx: 0, token: PDU_AT, expected: 'in-flight-on-device' },
    { label: '设备已用完、驱动还没回收', availIdx: 1, usedIdx: 1, token: PDU_AT, expected: 'completed-on-device' },
    { label: '描述符已回收', availIdx: 1, usedIdx: 1, token: 0n, expected: 'recycled' },
  ];
  for (const item of cases) {
    const { capture, view } = makeMemory();
    buildVirtioBlkTrace(capture, {
      availIdx: item.availIdx,
      usedIdx: item.usedIdx,
      descStateToken: item.token,
    });
    const vq = await readVirtqueue(view, layout, VQ_AT);
    const owners = await readDescriptorOwners(view, layout, vq);
    const lookup = lookupToken(owners, PDU_AT);
    const lifecycle = classifyLifecycle(vq, owners, lookup, { pduAddress: PDU_AT });
    assert.equal(lifecycle, item.expected, item.label);
  }
  assert.equal(classifyLifecycle(null, null, null, { pduAddress: PDU_AT }), 'unknown');
});

test('classifyLifecycle：token 缺失时按 rq->state 区分提交前与回收后', async (t) => {
  if (!need(t)) return;
  // 三个状态值与名字的对应关系从布局产物读取。
  assert.deepEqual(
    [0, 1, 2].map((value) => mqRqStateName(layout, value)),
    ['MQ_RQ_IDLE', 'MQ_RQ_IN_FLIGHT', 'MQ_RQ_COMPLETE'],
  );

  // virtblk_prep_rq() 先将请求置为 IN_FLIGHT，virtblk_add_req() 随后写入 token。
  // 两步之间由 rq->state 区分生命周期，环计数器可以相等。
  const cases = [
    { label: 'IN_FLIGHT 且环上没 token：还没提交', stateValue: 1, stateName: 'MQ_RQ_IN_FLIGHT', availIdx: 0, usedIdx: 0, token: 0n, expected: 'not-submitted' },
    { label: 'IDLE 且环上没 token：已经回收', stateValue: 0, stateName: 'MQ_RQ_IDLE', availIdx: 1, usedIdx: 1, token: 0n, expected: 'recycled' },
    { label: 'COMPLETE 且 token 已清：设备回话、请求还没释放', stateValue: 2, stateName: 'MQ_RQ_COMPLETE', availIdx: 1, usedIdx: 1, token: 0n, expected: 'completed-on-device' },
  ];
  for (const item of cases) {
    assert.equal(mqRqStateName(layout, item.stateValue), item.stateName);
    const { capture, view } = makeMemory();
    buildVirtioBlkTrace(capture, {
      availIdx: item.availIdx,
      usedIdx: item.usedIdx,
      descStateToken: item.token,
      requestState: item.stateValue,
    });
    const request = await readRequest(view, layout, REQUEST_AT);
    assert.equal(request.stateName, item.stateName, '请求状态名应当从布局产物里的 mq_rq_state 读出来');
    const vq = await readVirtqueue(view, layout, VQ_AT);
    const owners = await readDescriptorOwners(view, layout, vq);
    const lookup = lookupToken(owners, PDU_AT);
    assert.equal(classifyLifecycle(vq, owners, lookup, request), item.expected, item.label);
  }

  // mq_rq_state 的布局缺口使判读退回计数器口径，调用方同时显示生命周期歧义。
  const { capture, view } = makeMemory();
  buildVirtioBlkTrace(capture, { availIdx: 1, usedIdx: 1, descStateToken: 0n });
  const vq = await readVirtqueue(view, layout, VQ_AT);
  const owners = await readDescriptorOwners(view, layout, vq);
  const lookup = lookupToken(owners, PDU_AT);
  assert.equal(classifyLifecycle(vq, owners, lookup, { pduAddress: PDU_AT }), 'recycled');
  assert.notEqual(lookup.ambiguity, null, '找不到 token 时必须带着"关联不上"的理由');
});

test('classifyReadahead：请求或它的 bio 上立着 REQ_RAHEAD 就算预读', async (t) => {
  if (!need(t)) return;
  const rahead = requestFlagBits(layout).find((entry) => entry.name === 'REQ_RAHEAD');

  const plain = makeMemory();
  putWriteBio(plain.capture, BIO_AT, { sector: 8192n });
  const plainChain = await walkBioChain(plain.view, layout, BIO_AT);
  const notReadahead = classifyReadahead(fakeTrace({ chain: plainChain }));
  assert.equal(notReadahead.readahead, false);
  assert.match(notReadahead.reason, /没有 REQ_RAHEAD/);

  const viaBio = makeMemory();
  putWriteBio(viaBio.capture, BIO_AT, { sector: 8192n });
  putField(viaBio.capture.bytes, BIO_AT, 'bio', 'bi_opf', 1 | rahead.mask);
  const viaBioChain = await walkBioChain(viaBio.view, layout, BIO_AT);
  const flaggedBio = classifyReadahead(fakeTrace({ chain: viaBioChain }));
  assert.equal(flaggedBio.readahead, true);
  assert.ok(flaggedBio.flags.some((line) => line.includes('bio')));
  assert.match(flaggedBio.reason, /内核替程序提前读/);

  const viaRequest = classifyReadahead(fakeTrace({ chain: plainChain, flagNames: ['REQ_RAHEAD'] }));
  assert.equal(viaRequest.readahead, true);
  assert.ok(viaRequest.flags.some((line) => line.includes('request')));
});

test('classifyMergeSplit：合并、跨页拆段、同页重复、段数不符各有说法', async (t) => {
  if (!need(t)) return;

  // 一个请求挂两个首尾相接的 bio：这是"块层把两次提交合成了一个请求"。
  const merged = makeMemory();
  putWriteBio(merged.capture, BIO_AT, { next: 0x9200n, sector: 8192n });
  putWriteBio(merged.capture, 0x9200n, { sector: 8200n, ioVec: 0x9300n, page: 0xf000n });
  const mergedChain = await walkBioChain(merged.view, layout, BIO_AT);
  const verdict = classifyMergeSplit(fakeTrace({ chain: mergedChain, nrPhysSegments: 2, dataLen: 8192 }));
  assert.equal(verdict.bioCount, 2);
  assert.equal(verdict.coalesced, true);
  assert.equal(verdict.contiguous, true);
  assert.equal(verdict.vectorCount, 2);
  assert.equal(verdict.distinctPages, 2);
  assert.ok(verdict.reasons.some((line) => line.includes('合成了一个请求')));

  // 一个 bio 两个向量：这一次 I/O 本身跨了两页，是被拆开描述的。
  const split = makeMemory();
  putBio(split.capture, BIO_AT, { opf: 1, sector: 8192n, size: 8192, vcnt: 2, maxVecs: 2, ioVec: BIO_VEC_AT });
  putBioVec(split.capture, BIO_VEC_AT, { page: 0xe000n, length: 4096, offset: 0 });
  putBioVec(split.capture, BIO_VEC_AT + 16n, { page: 0xe100n, length: 4096, offset: 0 });
  const splitChain = await walkBioChain(split.view, layout, BIO_AT);
  const splitVerdict = classifyMergeSplit(fakeTrace({ chain: splitChain, nrPhysSegments: 2, dataLen: 8192 }));
  assert.equal(splitVerdict.multiVector, true);
  assert.equal(splitVerdict.coalesced, false);
  assert.equal(splitVerdict.vectorCount, 2);
  assert.ok(splitVerdict.reasons.some((line) => line.includes('跨了多页')));

  // 段数对不上：`nr_phys_segments` 是块层算的，段数是 bio 自己记的。
  const mismatched = classifyMergeSplit(fakeTrace({ chain: splitChain, nrPhysSegments: 1, dataLen: 8192 }));
  assert.ok(mismatched.reasons.some((line) => line.includes('nr_phys_segments')));

  // 同一页在两段里各出现一次：一次逻辑写被拆到同一页的不同位置。
  const repeated = makeMemory();
  putBio(repeated.capture, BIO_AT, { opf: 1, sector: 8192n, size: 4608, vcnt: 2, maxVecs: 2, ioVec: BIO_VEC_AT });
  putBioVec(repeated.capture, BIO_VEC_AT, { page: 0xe000n, length: 4096, offset: 0 });
  putBioVec(repeated.capture, BIO_VEC_AT + 16n, { page: 0xe000n, length: 512, offset: 4096 });
  const repeatedVerdict = classifyMergeSplit(fakeTrace({
    chain: await walkBioChain(repeated.view, layout, BIO_AT),
    nrPhysSegments: 2,
    dataLen: 4608,
  }));
  assert.equal(repeatedVerdict.repeatedPages, true);
  assert.ok(repeatedVerdict.reasons.some((line) => line.includes('同一个页')));

  // bio 为空的请求按零数据段分类。
  const empty = classifyMergeSplit(fakeTrace({ chain: await walkBioChain(split.view, layout, null) }));
  assert.equal(empty.bioCount, 0);
  assert.equal(empty.coalesced, false);
  assert.ok(empty.reasons.some((line) => line.includes('没挂 bio')));
});

test('linkBioToFolios：逐段关联 struct page/folio，失败段报告原因', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  putWriteBio(capture, BIO_AT, { sector: 8192n, page: PAGE_BASE, ioVec: BIO_VEC_AT });
  putFolio(capture, PAGE_BASE, { index: 0n, labels: ['PG_dirty'] });

  const links = await linkBioToFolios(view, layout, await readBio(view, layout, BIO_AT), {
    vmemmap: fakeVmemmap(),
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].pfn, 0n);
  assert.equal(links[0].pfnRemainder, 0n);
  assert.equal(links[0].error, null);
  assert.equal(links[0].offset, 0);
  assert.equal(links[0].length, 4096);
  assert.equal(links[0].end, 4096);
  assert.equal(links[0].folio.mapping, MAPPING_AT);
  assert.equal(links[0].folio.index, 0n);
  assert.equal(links[0].folio.pageFlags.includes('PG_dirty'), true);

  // 空页指针与 vmemmap 边界错误分别进入该段的 error。
  const broken = makeMemory();
  putBio(broken.capture, BIO_AT, { opf: 1, sector: 8192n, size: 8192, vcnt: 2, maxVecs: 2, ioVec: BIO_VEC_AT });
  putBioVec(broken.capture, BIO_VEC_AT, { page: 0n, length: 4096, offset: 0 });
  putBioVec(broken.capture, BIO_VEC_AT + 16n, { page: PAGE_BASE + 8n, length: 4096, offset: 0 });
  const brokenLinks = await linkBioToFolios(broken.view, layout, await readBio(broken.view, layout, BIO_AT), {
    vmemmap: fakeVmemmap(),
  });
  assert.match(brokenLinks[0].error, /空指针/);
  assert.equal(brokenLinks[0].folio, null);
  assert.equal(brokenLinks[1].pfn, null);
  assert.equal(brokenLinks[1].pfnRemainder, 8n);
  assert.match(brokenLinks[1].error, /不属于这套 vmemmap/);
});

test('classifyFileWriteState：脏页没有 I/O 在搬就是"缓存命中"，有 bio 在搬才是落盘', async (t) => {
  if (!need(t)) return;
  const folios = [
    { address: PAGE_BASE, index: 0n, mapping: MAPPING_AT, mappingIsAnon: false, pageFlags: ['PG_dirty'] },
    { address: PAGE_BASE + 64n, index: 1n, mapping: MAPPING_AT, mappingIsAnon: false, pageFlags: [] },
  ];
  const range = { mappingAddress: MAPPING_AT, fileOffsetStart: 0n, fileOffsetEnd: 8192n };

  // 一、脏页在缓存里，没有任何请求在搬它 —— 这就是缓存命中。
  const hit = classifyFileWriteState({ ...range, folios, traces: [], links: new Map() });
  assert.equal(hit.phase, 'in-cache-dirty-no-io');
  assert.equal(hit.dirtyPages, 1);
  assert.equal(hit.pagesCarried, 0);
  assert.equal(hit.pagesInCache, 2);
  assert.ok(hit.reasons.some((line) => line.includes('缓存命中')));
  assert.deepEqual(hit.violations, []);

  const carrying = {
    traces: [{ request: { address: REQUEST_AT, tag: 3 }, bioChain: { bios: [{ address: BIO_AT }] } }],
    links: new Map([[BIO_AT.toString(), [{ bioAddress: BIO_AT, bioVecIndex: 0, pfn: 0n, folio: folios[0] }]]]),
  };

  // 二、脏页且有 bio 在搬：回写正在进行。
  const pending = classifyFileWriteState({ ...range, folios, ...carrying });
  assert.equal(pending.phase, 'in-cache-dirty-io-pending');
  assert.equal(pending.pagesCarried, 1);

  // 三、页不脏但有 I/O 在搬：数据已经交给设备。
  const flushed = classifyFileWriteState({
    ...range,
    folios: folios.map((folio) => ({ ...folio, pageFlags: [] })),
    ...carrying,
  });
  assert.equal(flushed.phase, 'io-in-flight');
  assert.equal(flushed.dirtyPages, 0);
  assert.equal(flushed.pagesCarried, 1);

  // 四、目标页的缓存缺口按页记录。
  const partial = classifyFileWriteState({ ...range, folios: [folios[0]], traces: [], links: new Map() });
  assert.equal(partial.phase, 'partly-uncached');
  assert.equal(partial.violations.length, 1);
  assert.match(partial.violations[0], /不在页缓存里/);

  // 五、mapping 指向其他文件时报告目标文件关联错误。
  const foreign = classifyFileWriteState({
    mappingAddress: MAPPING_AT,
    fileOffsetStart: 0n,
    fileOffsetEnd: 4096n,
    folios: [{ address: PAGE_BASE, index: 0n, mapping: 0xdeadn, mappingIsAnon: false, pageFlags: [] }],
    traces: [],
    links: new Map(),
  });
  assert.equal(foreign.phase, 'in-cache-clean');
  assert.ok(foreign.violations.some((line) => line.includes('address_space')));
});

test('读 gendisk：给出人能看懂的名字，并如实标出可疑字段', async (t) => {
  if (!need(t)) return;
  const { capture, view } = makeMemory();
  buildVirtioBlkTrace(capture);
  const disk = await readGendisk(view, layout, DISK_AT);
  assert.equal(disk.diskName, 'vda');
  assert.equal(disk.diskNameTruncated, false);
  assert.equal(disk.major, 254);
  assert.equal(disk.minors, 16);
  assert.equal(disk.queue, QUEUE_AT);
  assert.equal(disk.privateData, VBLK_AT);
  assert.deepEqual(disk.notes, []);

  // minors 不是 2 的幂、disk_name 是空串都要说清楚（分区号换算依赖前者）。
  const odd = makeMemory();
  buildVirtioBlkTrace(odd.capture);
  putField(odd.capture.bytes, DISK_AT, 'gendisk', 'minors', 20);
  const nameAt = Number(DISK_AT) + offsetOf('gendisk', 'disk_name');
  odd.capture.bytes.fill(0, nameAt, nameAt + 32);
  const oddDisk = await readGendisk(odd.view, layout, DISK_AT);
  assert.equal(oddDisk.diskName, '');
  assert.ok(oddDisk.notes.some((line) => line.includes('2 的幂')));
  assert.ok(oddDisk.notes.some((line) => line.includes('空串')));

  await assert.rejects(() => readGendisk(view, layout, 0n), IoParseError);
});
