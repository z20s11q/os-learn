/** 只读块层对象视图，包含 bio、request、队列和标签表的地址与字段。
 * bio 游标与原始向量区间分别返回，PDU 使用布局结构宽度寻址，标签连地址和生命周期记录。
 */

import { CaptureReadError, memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef, Hex } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';
import { readStruct, StructBuffer } from '../objects/task.ts';
import {
  BIO_FLAG_BITS,
  BIO_FLAG_COUNT,
  REQ_OP_BITS,
  RQ_FLAG_BITS,
  RQ_FLAG_COUNT,
  SECTOR_SHIFT,
  blkStatusName,
  decodeBioOpf,
  decodeBitMask,
  mqRqStateName,
  structRequestSizeOf,
  type FlagDecode,
  type OpDecode,
} from './blocks.ts';

export const BIO_TYPE = 'bio';
export const BIO_VEC_TYPE = 'bio_vec';
export const REQUEST_TYPE = 'request';
export const REQUEST_QUEUE_TYPE = 'request_queue';
export const BLK_MQ_HW_CTX_TYPE = 'blk_mq_hw_ctx';
export const BLK_MQ_CTX_TYPE = 'blk_mq_ctx';
export const BLK_MQ_TAGS_TYPE = 'blk_mq_tags';

/** 默认的 bio 链遍历上限。一次 `fsync` 的写回在 lab 上不到十个 bio，几十个就够。 */
export const DEFAULT_MAX_BIOS = 512;

/** 默认一次读多少个 bio 向量。4096 字节写回通常只有 1 个向量。 */
export const DEFAULT_MAX_BIO_VECS = 64;

export class IoParseError extends CaptureReadError {}

/* --------------------------------------------------------------------------
 * bio_vec
 * ------------------------------------------------------------------------ */

export interface KernelBioVec {
  /** 在这个 bio 的向量表里的下标 */
  index: number;
  /** 向量表项的地址（`&bio->bi_io_vec[index]`） */
  address: bigint;
  /** `bv_page`：指向 `struct page`（6.12 里页缓存用 folio，但向量里存的仍是 page） */
  pageAddress: bigint | null;
  /** `bv_len`：这一段多少字节 */
  length: number;
  /** `bv_offset`：从该页的第几字节开始 */
  offset: number;
  notes: string[];
}

/** 读一个 `struct bio_vec`。 */
export function readBioVec(
  layout: KernelLayout,
  address: bigint,
  bytes: Uint8Array,
  index: number,
): KernelBioVec {
  const view = new StructBuffer(address, bytes, layout, BIO_VEC_TYPE);
  const notes: string[] = [];
  const length = view.u32('bv_len');
  const offset = view.u32('bv_offset');
  if (length === 0) {
    notes.push('bv_len 为 0：这个向量是空的，块层在清理时会留下这种项');
  }
  if (offset % 512 !== 0) {
    notes.push(
      `bv_offset = ${offset} 不是 512 的整数倍：页内偏移不按扇区对齐是合法的，`
      + `但说明这一段的扇区边界落在页中间，按"page 号推扇区"会算错`,
    );
  }
  return {
    index,
    address,
    pageAddress: view.pointer('bv_page'),
    length,
    offset,
    notes,
  };
}

/* --------------------------------------------------------------------------
 * bio
 * ------------------------------------------------------------------------ */

export interface KernelBio {
  address: bigint;
  /** `bi_next`：同一个请求里下一个 bio；为 null 表示这是链尾 */
  next: bigint | null;
  /** `bi_bdev`：这次 I/O 打到哪个块设备 */
  bdev: bigint | null;
  /** `bi_opf` 原始值 */
  opf: number;
  /** 操作码判读（读写等） */
  op: OpDecode;
  /** 高 24 位标志的判读（`REQ_RAHEAD`/`REQ_SYNC`/`REQ_FUA`/…） */
  flags: FlagDecode;
  /** `bi_flags` 原始值 */
  biFlags: number;
  /** `bi_flags` 的位判读（`BIO_CLONED`/`BIO_CHAIN`/…） */
  biFlagsDecode: FlagDecode;
  /** bi_status 原始状态码，初值为 BLK_STS_OK；完成状态结合请求生命周期判定 */
  status: number;
  statusName: string | null;
  ioprio: number;
  writeHint: number;
  /** `bi_iter.bi_sector`：当前起始扇区 */
  sector: bigint;
  /** `bi_iter.bi_size`：**还没搬完**的字节数 */
  bytesRemaining: number;
  /** `bi_iter.bi_idx`：游标在第几个向量 */
  idx: number;
  /** `bi_iter.bi_bvec_done`：在 `idx` 那个向量的内部已经走了多少字节 */
  bvecDone: number;
  /** `bi_vcnt`：向量表里实际用了几个 */
  vcnt: number;
  /** `bi_max_vecs`：向量表一共分配了几个 */
  maxVecs: number;
  /** `bi_end_io`：完成回调（ext2 写回时是 `end_buffer_write_sync` 之类） */
  endIo: bigint | null;
  /** `bi_private`：回调的私有数据。ext2 写回时这里就是 `struct buffer_head *` */
  private: bigint | null;
  /** `&bio->bi_io_vec[0]` */
  ioVecAddress: bigint;
  /** 向量表（只读前 limit 个） */
  vectors: KernelBioVec[];
  /** 从向量表算出的**总字节数**（全部向量长度之和） */
  totalBytes: number;
  /** 从向量表与游标反算出的**已经搬完**的字节数 */
  doneBytes: number;
  /** 从向量表算出的**整段扇区区间** `[start, end)` */
  extentStart: bigint;
  extentEnd: bigint;
  /** 对账失败的地方（读到了自相矛盾的字段） */
  violations: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 读取 bio 及其向量，状态名称通过 BLK_STATUS_NAMES 查找。 */
export async function readBio(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: { maxVectors?: number } = {},
): Promise<KernelBio> {
  if (address === 0n) {
    throw new IoParseError('null-bio', 'struct bio 地址为 0：这里没有 bio', {});
  }
  const struct = await readStruct(view, layout, BIO_TYPE, address);
  const notes: string[] = [];
  const violations: string[] = [];

  const opf = struct.u32('bi_opf');
  const decoded = decodeBioOpf(layout, opf);
  if (decoded.op.symbol === null) {
    violations.push(
      `bi_opf 的低 ${REQ_OP_BITS} 位是 ${decoded.op.op}，这个值不在本内核的 enum req_op 里：`
      + '要么这块内存不是 bio，要么操作码被改过',
    );
  }
  if (decoded.flags.unknown !== 0) {
    violations.push(
      `bi_opf 高位里立着 ${toHex(BigInt(decoded.flags.unknown))}，但 enum req_flag_bits 里没有这几位：`
      + '标志表与内核不同步，不能用"没有标志"解释',
    );
  }

  const biFlags = struct.u16('bi_flags');
  const biFlagsDecode = decodeBitMask(biFlags, BIO_FLAG_BITS, BIO_FLAG_COUNT);
  if (biFlagsDecode.unknown !== 0) {
    notes.push(
      `bi_flags 里立着 ${toHex(BigInt(biFlagsDecode.unknown))}，本实现的 BIO_* 位表里没有这几位`
      + `（该枚举是匿名枚举，表由源码抄来，共 ${BIO_FLAG_COUNT} 位）`,
    );
  }

  const status = struct.has('bi_status') ? struct.value('bi_status', false) : 0;
  const statusNumber = Number(status);
  // 注意：`blk_status_t` 在 6.12 里是 `typedef u8 __bitwise blk_status_t`，取值是
  // BLK_STS_* 名称对应头文件中的宏定义。
  // 名字只能从头文件抄（见 `blocks.ts` 的 BLK_STATUS_NAMES），验收脚本会对账。
  const statusName = blkStatusName(statusNumber);

  const sector = struct.u64('bi_iter.bi_sector');
  const bytesRemaining = Number(struct.value('bi_iter.bi_size', false));
  const idx = Number(struct.value('bi_iter.bi_idx', false));
  const bvecDone = Number(struct.value('bi_iter.bi_bvec_done', false));
  const vcnt = struct.u16('bi_vcnt');
  const maxVecs = struct.u16('bi_max_vecs');
  const ioVecAddress = struct.pointer('bi_io_vec');

  const vectors: KernelBioVec[] = [];
  const limit = Math.min(vcnt, options.maxVectors ?? DEFAULT_MAX_BIO_VECS);
  if (vcnt > limit) {
    notes.push(`bi_vcnt = ${vcnt} 超过本次读取上限 ${limit}，只读前 ${limit} 个向量`);
  }
  if (ioVecAddress !== null && limit > 0) {
    const vecType = layout.type(BIO_VEC_TYPE);
    const vecSize = vecType.byteSize ?? 16;
    const raw = await view.bytes(ioVecAddress, vecSize * limit);
    for (let index = 0; index < limit; index += 1) {
      const slice = raw.subarray(index * vecSize, (index + 1) * vecSize);
      vectors.push(readBioVec(layout, ioVecAddress + BigInt(index * vecSize), slice, index));
    }
  } else if (vcnt > 0 && ioVecAddress === null) {
    violations.push('bi_vcnt 大于 0 但 bi_io_vec 是空指针：拿不到向量表，这次 I/O 说不清搬的是哪些页');
  }

  const totalBytes = vectors.reduce((sum, vec) => sum + vec.length, 0);
  if (vectors.length === vcnt) {
    const prefixes = vectors.slice(0, Math.min(idx, vectors.length));
    const doneBytes = prefixes.reduce((sum, vec) => sum + vec.length, 0) + bvecDone;
    if (doneBytes + bytesRemaining !== totalBytes) {
      violations.push(
        `向量表一共 ${totalBytes} 字节，游标走过 ${doneBytes} 字节，而 bi_iter.bi_size（还没搬完）= `
        + `${bytesRemaining}：三者对不上（${doneBytes} + ${bytesRemaining} ≠ ${totalBytes}）`,
      );
    }
    if (doneBytes % 512 !== 0) {
      notes.push(`游标走过的字节数 ${doneBytes} 不是 512 的整数倍，反算原始扇区时会丢掉不足一扇区的部分`);
    }
    // `bio_advance()` 会同时推进 bi_sector 与 bi_iter，所以原始起点 = 当前起点 - 走过的扇区数。
    const extentStart = sector - BigInt(Math.floor(doneBytes / 512));
    const extentEnd = extentStart + BigInt(Math.ceil(totalBytes / 512));
    return finish({
      vectors, totalBytes, doneBytes, extentStart, extentEnd, notes, violations,
    });
  }

  // 向量覆盖缺口时使用当前游标给出下限区间。
  notes.push(
    `只读到 ${vectors.length}/${vcnt} 个向量，原始范围只能按游标给下限：`
    + '真正的起点还要往前减掉已经搬完的字节',
  );
  return finish({
    vectors,
    totalBytes,
    doneBytes: -1,
    extentStart: sector,
    extentEnd: sector + BigInt(Math.ceil(bytesRemaining / 512)),
    notes,
    violations,
  });

  function finish(extra: {
    vectors: KernelBioVec[];
    totalBytes: number;
    doneBytes: number;
    extentStart: bigint;
    extentEnd: bigint;
    notes: string[];
    violations: string[];
  }): KernelBio {
    return {
      address,
      next: struct.pointer('bi_next'),
      bdev: struct.pointer('bi_bdev'),
      opf,
      op: decoded.op,
      flags: decoded.flags,
      biFlags,
      biFlagsDecode,
      status: statusNumber,
      statusName,
      ioprio: struct.u16('bi_ioprio'),
      writeHint: Number(struct.value('bi_write_hint', false)),
      sector,
      bytesRemaining,
      idx,
      bvecDone,
      vcnt,
      maxVecs,
      endIo: struct.has('bi_end_io') ? struct.pointer('bi_end_io') : null,
      private: struct.has('bi_private') ? struct.pointer('bi_private') : null,
      ioVecAddress: ioVecAddress ?? 0n,
      vectors: extra.vectors,
      totalBytes: extra.totalBytes,
      doneBytes: extra.doneBytes,
      extentStart: extra.extentStart,
      extentEnd: extra.extentEnd,
      violations: extra.violations,
      notes: extra.notes,
      evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
        `type:${BIO_TYPE}`,
        `sector:${toHex(sector)}`,
        `opf:${toHex(BigInt(opf >>> 0))}`,
        `vcnt:${vcnt}`,
      ]),
    };
  };
}

/* --------------------------------------------------------------------------
 * bio 链（一个请求里的所有 bio）
 * ------------------------------------------------------------------------ */

export interface BioChainResult {
  bios: KernelBio[];
  /** 是否因为达到上限而停止 */
  truncated: boolean;
  /** 是否检测到环（指针指回已访问过的 bio） */
  cycle: boolean;
  /** 链上所有 bio 合起来的扇区区间 `[start, end)`；链为空时为 null */
  sectorStart: bigint | null;
  sectorEnd: bigint | null;
  /** 相邻 bio 的区间是否首尾相接（合并后的样子） */
  contiguous: boolean;
  /** 相邻 bio 区间之间的间隙，供合并/拆分诊断 */
  seams: string[];
  notes: string[];
}

/** 限定遍历 bio 链，记录环、节点上限、链尾冲突与相邻区间间隙。 */
export async function walkBioChain(
  view: KernelMemoryView,
  layout: KernelLayout,
  head: bigint | null,
  options: { tail?: bigint | null; limit?: number; maxVectors?: number } = {},
): Promise<BioChainResult> {
  const limit = options.limit ?? DEFAULT_MAX_BIOS;
  const notes: string[] = [];
  const seams: string[] = [];
  const bios: KernelBio[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let cycle = false;
  let cursor = head;

  while (cursor !== null) {
    const key = cursor.toString(16);
    if (seen.has(key)) {
      cycle = true;
      notes.push(`bio 链在 0x${key} 处回到已经访问过的节点：要么是环，要么遍历中途被改过`);
      break;
    }
    seen.add(key);
    if (bios.length >= limit) {
      truncated = true;
      notes.push(`达到遍历上限 ${limit} 个 bio，停止；链上可能还有更多`);
      break;
    }
    let bio: KernelBio;
    try {
      bio = await readBio(view, layout, cursor, { maxVectors: options.maxVectors });
    } catch (error) {
      notes.push(`读 bio 0x${key} 失败：${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    bios.push(bio);
    notes.push(...bio.violations.map((line) => `bio ${toHex(bio.address)}：${line}`));
    if (bio.next === null) break;
    cursor = bio.next;
  }

  if (options.tail !== undefined && options.tail !== null && bios.length > 0) {
    const last = bios[bios.length - 1].address;
    if (last !== options.tail && !truncated && !cycle) {
      notes.push(
        `走到链尾时停在 ${toHex(last)}，但 request->biotail 是 ${toHex(options.tail)}：`
        + '两者不一致说明链被改过，或 bi_next 的偏移不对',
      );
    }
  }

  for (let index = 1; index < bios.length; index += 1) {
    const previous = bios[index - 1];
    const current = bios[index];
    if (current.extentStart !== previous.extentEnd) {
      seams.push(
        `第 ${index} 与第 ${index + 1} 个 bio 之间有缝：前一个结束于扇区 ${previous.extentEnd}，`
        + `后一个从扇区 ${current.extentStart} 开始（差 ${current.extentStart - previous.extentEnd} 个扇区）`,
      );
    }
  }

  return {
    bios,
    truncated,
    cycle,
    sectorStart: bios.length === 0 ? null : bios[0].extentStart,
    sectorEnd: bios.length === 0 ? null : bios.reduce((max, bio) => (bio.extentEnd > max ? bio.extentEnd : max), 0n),
    contiguous: bios.length > 1 && seams.length === 0,
    seams,
    notes,
  };
}

/* --------------------------------------------------------------------------
 * request
 * ------------------------------------------------------------------------ */

export interface KernelRequest {
  address: bigint;
  queue: bigint | null;
  mqCtx: bigint | null;
  mqHctx: bigint | null;
  cmdFlags: number;
  op: OpDecode;
  flags: FlagDecode;
  rqFlags: number;
  rqFlagsDecode: FlagDecode;
  /** `tag`：请求 ID。同一个 tag 会被反复复用，必须连地址与生命周期一起看 */
  tag: number;
  internalTag: number;
  timeout: number;
  dataLen: number;
  sector: bigint;
  bio: bigint | null;
  bioTail: bigint | null;
  part: bigint | null;
  startTimeNs: bigint;
  ioStartTimeNs: bigint;
  nrPhysSegments: number;
  state: number;
  stateName: string | null;
  ref: number;
  endIo: bigint | null;
  /** `blk_mq_rq_to_pdu(rq)` 的地址 = `rq + sizeof(struct request)` */
  pduAddress: bigint;
  /** 本次请求覆盖的扇区区间 `[sector, sector + dataLen/512)` */
  sectorEnd: bigint;
  violations: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** `blk_mq_rq_to_pdu(rq)`：驱动私有区紧跟在 `struct request` 之后。 */
export function requestPduAddress(layout: KernelLayout, requestAddress: bigint): bigint {
  return requestAddress + BigInt(structRequestSizeOf(layout));
}

/** 读一个 `struct request`。 */
export async function readRequest(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelRequest> {
  if (address === 0n) {
    throw new IoParseError('null-request', 'struct request 地址为 0：这里没有请求', {});
  }
  const struct = await readStruct(view, layout, REQUEST_TYPE, address);
  const notes: string[] = [];
  const violations: string[] = [];

  const cmdFlags = struct.u32('cmd_flags');
  const decoded = decodeBioOpf(layout, cmdFlags);
  if (decoded.op.symbol === null) {
    violations.push(`cmd_flags 的低 8 位是 ${decoded.op.op}，不在本内核的 enum req_op 里`);
  }
  const rqFlags = struct.u32('rq_flags');
  const rqFlagsDecode = decodeBitMask(rqFlags, RQ_FLAG_BITS, RQ_FLAG_COUNT);
  if (rqFlagsDecode.unknown !== 0) {
    notes.push(
      `rq_flags 里立着 ${toHex(BigInt(rqFlagsDecode.unknown))}，本实现的 RQF_* 位表里没有这几位`
      + `（该枚举是匿名枚举，表由源码抄来，共 ${RQ_FLAG_COUNT} 位）`,
    );
  }

  const state = struct.has('state') ? struct.u32('state') : 0;
  const dataLen = struct.u32('__data_len');
  const sector = struct.u64('__sector');
  const pduAddress = address + BigInt(structRequestSizeOf(layout));

  // __sector 和 __data_len 表示请求当前剩余区间。
  // 部分完成时游标随已完成字节推进。
  // 原始范围通过 bio 向量另行核对。
  if (dataLen % 512 !== 0) {
    notes.push(`__data_len = ${dataLen} 不是 512 的整数倍：请求区间不能整扇区表述，取上整`);
  }

  return {
    address,
    queue: struct.pointer('q'),
    mqCtx: struct.has('mq_ctx') ? struct.pointer('mq_ctx') : null,
    mqHctx: struct.has('mq_hctx') ? struct.pointer('mq_hctx') : null,
    cmdFlags,
    op: decoded.op,
    flags: decoded.flags,
    rqFlags,
    rqFlagsDecode,
    tag: struct.has('tag') ? Number(struct.value('tag', true)) : -1,
    internalTag: struct.has('internal_tag') ? Number(struct.value('internal_tag', true)) : -1,
    timeout: struct.has('timeout') ? struct.u32('timeout') : 0,
    dataLen,
    sector,
    bio: struct.pointer('bio'),
    bioTail: struct.has('biotail') ? struct.pointer('biotail') : null,
    part: struct.has('part') ? struct.pointer('part') : null,
    startTimeNs: struct.has('start_time_ns') ? struct.u64('start_time_ns') : 0n,
    ioStartTimeNs: struct.has('io_start_time_ns') ? struct.u64('io_start_time_ns') : 0n,
    nrPhysSegments: struct.has('nr_phys_segments')
      ? Number(struct.value('nr_phys_segments', false))
      : 0,
    state,
    stateName: layout.has('mq_rq_state') ? mqRqStateName(layout, state) : null,
    ref: struct.has('ref') ? Number(struct.value('ref', true)) : 0,
    endIo: struct.has('end_io') ? struct.pointer('end_io') : null,
    pduAddress,
    sectorEnd: sector + BigInt(Math.ceil(dataLen / 512)),
    violations,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${REQUEST_TYPE}`,
      `tag:${struct.has('tag') ? struct.value('tag', true) : '?'}`,
      `sector:${toHex(sector)}`,
      `pdu:${toHex(pduAddress)}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * request_queue / hw_ctx / mq_ctx / tags
 * ------------------------------------------------------------------------ */

export interface KernelRequestQueue {
  address: bigint;
  /** `queuedata`：驱动私有数据。**virtio-blk 就是从它找回 `struct virtio_blk` 的** */
  queuedata: bigint | null;
  elevator: bigint | null;
  mqOps: bigint | null;
  queueCtx: bigint | null;
  queueFlags: bigint;
  rqTimeout: number;
  queueDepth: number;
  refs: number;
  nrHwQueues: number;
  /** `&q->hctx_table`：硬件上下文表的 XArray */
  hctxTableAddress: bigint;
  lastMerge: bigint | null;
  disk: bigint | null;
  nrRequests: bigint;
  tagSet: bigint | null;
  mqFreezeDepth: number;
  notes: string[];
  evidence: EvidenceRef;
}

export async function readRequestQueue(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelRequestQueue> {
  if (address === 0n) {
    throw new IoParseError('null-queue', 'struct request_queue 地址为 0', {});
  }
  const struct = await readStruct(view, layout, REQUEST_QUEUE_TYPE, address);
  const notes: string[] = [];
  const nrHwQueues = struct.u32('nr_hw_queues');
  if (nrHwQueues > 4096) {
    notes.push(`nr_hw_queues = ${nrHwQueues} 大得不像真的：要么读错了结构，要么内存被改过`);
  }
  return {
    address,
    queuedata: struct.has('queuedata') ? struct.pointer('queuedata') : null,
    elevator: struct.has('elevator') ? struct.pointer('elevator') : null,
    mqOps: struct.has('mq_ops') ? struct.pointer('mq_ops') : null,
    queueCtx: struct.has('queue_ctx') ? struct.pointer('queue_ctx') : null,
    queueFlags: struct.u64('queue_flags'),
    rqTimeout: struct.has('rq_timeout') ? struct.u32('rq_timeout') : 0,
    queueDepth: struct.has('queue_depth') ? struct.u32('queue_depth') : 0,
    refs: struct.has('refs') ? Number(struct.value('refs', true)) : 0,
    nrHwQueues,
    hctxTableAddress: struct.addressOf('hctx_table'),
    lastMerge: struct.has('last_merge') ? struct.pointer('last_merge') : null,
    disk: struct.has('disk') ? struct.pointer('disk') : null,
    nrRequests: struct.has('nr_requests') ? struct.u64('nr_requests') : 0n,
    tagSet: struct.has('tag_set') ? struct.pointer('tag_set') : null,
    mqFreezeDepth: struct.has('mq_freeze_depth') ? struct.u32('mq_freeze_depth') : 0,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${REQUEST_QUEUE_TYPE}`,
      `queuedata:${struct.has('queuedata') && struct.pointer('queuedata') !== null ? toHex(struct.pointer('queuedata') as bigint) : 'null'}`,
    ]),
  };
}

export interface KernelHwCtx {
  address: bigint;
  /** `queue`：这个硬件上下文属于哪个请求队列。virtio-blk 从这里取 `queuedata` */
  queue: bigint | null;
  /** `driver_data`：驱动自己挂的数据 */
  driverData: bigint | null;
  /** `&hctx->ctxs[0]`：这个硬件上下文上排队的软件上下文数组 */
  ctxsAddress: bigint;
  nrCtx: number;
  /** `tags`：本硬件上下文的标签表（tag → request） */
  tags: bigint | null;
  schedTags: bigint | null;
  /** `queue_num`：这是第几个硬件队列。**virtio-blk 用它选 `vqs[queue_num]`** */
  queueNum: number;
  /** `nr_active`：还挂在这个硬件上下文上的活跃请求数 */
  nrActive: number;
  type: number;
  flags: bigint;
  state: bigint;
  notes: string[];
  evidence: EvidenceRef;
}

export async function readHwCtx(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelHwCtx> {
  if (address === 0n) {
    throw new IoParseError('null-hw-ctx', 'struct blk_mq_hw_ctx 地址为 0', {});
  }
  const struct = await readStruct(view, layout, BLK_MQ_HW_CTX_TYPE, address);
  const notes: string[] = [];
  const queueNum = struct.has('queue_num') ? struct.u32('queue_num') : 0;
  const nrCtx = struct.has('nr_ctx') ? struct.u16('nr_ctx') : 0;
  if (nrCtx > 4096) {
    notes.push(`nr_ctx = ${nrCtx} 大得不像真的：要么读错了结构，要么内存被改过`);
  }
  return {
    address,
    queue: struct.has('queue') ? struct.pointer('queue') : null,
    driverData: struct.has('driver_data') ? struct.pointer('driver_data') : null,
    ctxsAddress: struct.addressOf('ctxs'),
    nrCtx,
    tags: struct.has('tags') ? struct.pointer('tags') : null,
    schedTags: struct.has('sched_tags') ? struct.pointer('sched_tags') : null,
    queueNum,
    nrActive: struct.has('nr_active') ? Number(struct.value('nr_active', true)) : 0,
    type: struct.has('type') ? struct.u16('type') : 0,
    flags: struct.has('flags') ? struct.u64('flags') : 0n,
    state: struct.has('state') ? struct.u64('state') : 0n,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${BLK_MQ_HW_CTX_TYPE}`,
      `queue_num:${queueNum}`,
    ]),
  };
}

export interface KernelMqCtx {
  address: bigint;
  /** `cpu`：这个软件上下文对应哪个 CPU */
  cpu: number;
  /** `index_hw[0]`：在默认映射下这个 CPU 属于第几个硬件队列 */
  indexHw: number;
  queue: bigint | null;
  /** `&ctx->hctxs[0]` */
  hctxsAddress: bigint;
  /** `&ctx->rq_lists[0]` */
  rqListsAddress: bigint;
  notes: string[];
  evidence: EvidenceRef;
}

export async function readMqCtx(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelMqCtx> {
  if (address === 0n) {
    throw new IoParseError('null-mq-ctx', 'struct blk_mq_ctx 地址为 0', {});
  }
  const struct = await readStruct(view, layout, BLK_MQ_CTX_TYPE, address);
  const numbers: number[] = [];
  return {
    address,
    cpu: struct.has('cpu') ? struct.u32('cpu') : 0,
    indexHw: readFirstU16(struct, 'index_hw', numbers),
    queue: struct.has('queue') ? struct.pointer('queue') : null,
    hctxsAddress: struct.addressOf('hctxs'),
    rqListsAddress: struct.addressOf('rq_lists'),
    notes: [],
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [`type:${BLK_MQ_CTX_TYPE}`]),
  };
}

/** `index_hw` 是 `unsigned short[3]`，取第一个（默认映射）。取不到就是 0。 */
function readFirstU16(struct: StructBuffer, path: string, scratch: number[]): number {
  scratch.length = 0;
  if (!struct.has(path)) return 0;
  const field = struct.field(path);
  const bytes = struct.bytes.subarray(field.byteOffset, field.byteOffset + 2);
  if (bytes.length < 2) return 0;
  return bytes[0] | (bytes[1] << 8);
}

export interface KernelMqTags {
  address: bigint;
  nrTags: number;
  nrReservedTags: number;
  activeQueues: number;
  /** `&tags->rqs[0]`：tag → request 的数组 */
  rqsAddress: bigint;
  /** `&tags->static_rqs[0]`：预分配的请求数组 */
  staticRqsAddress: bigint;
  /** tag → 请求地址（只读前 limit 个） */
  tagged: Array<{ tag: number; request: bigint | null }>;
  notes: string[];
  evidence: EvidenceRef;
}

/** 读取标签表，tags->rqs[tag] 提供当前请求地址以核对身份，冲突作为关联歧义报告。 */
export async function readMqTags(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: { limit?: number } = {},
): Promise<KernelMqTags> {
  if (address === 0n) {
    throw new IoParseError('null-tags', 'struct blk_mq_tags 地址为 0', {});
  }
  const struct = await readStruct(view, layout, BLK_MQ_TAGS_TYPE, address);
  const nrTags = struct.u32('nr_tags');
  const limit = Math.min(nrTags, options.limit ?? 256);
  const notes: string[] = [];
  if (nrTags > limit) {
    notes.push(`nr_tags = ${nrTags} 超过本次读取上限 ${limit}，只读了前 ${limit} 个槽`);
  }
  const rqsAddress = struct.addressOf('rqs');
  const staticRqsAddress = struct.has('static_rqs') ? struct.addressOf('static_rqs') : 0n;
  const tagged: Array<{ tag: number; request: bigint | null }> = [];
  const rqs = struct.pointer('rqs');
  if (rqs !== null) {
    const raw = await view.bytes(rqs, limit * 8);
    for (let tag = 0; tag < limit; tag += 1) {
      const pointer = littleEndianPointer(raw, tag * 8);
      tagged.push({ tag, request: pointer === 0n ? null : pointer });
    }
  } else {
    notes.push('tags->rqs 是空指针：拿不到 tag → 请求的映射');
  }
  return {
    address,
    nrTags,
    nrReservedTags: struct.u32('nr_reserved_tags'),
    activeQueues: struct.u32('active_queues'),
    rqsAddress,
    staticRqsAddress,
    tagged,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${BLK_MQ_TAGS_TYPE}`,
      `nr_tags:${nrTags}`,
    ]),
  };
}

function littleEndianPointer(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

/* --------------------------------------------------------------------------
 * 与契约对接
 * ------------------------------------------------------------------------ */

/** 请求 → 契约里的地址/ID 三元组（T08 的 DiskPanel 要用）。 */
export interface RequestIdentity {
  address: Hex;
  tag: number;
  state: string | null;
  pduAddress: Hex;
}

export function requestIdentity(request: KernelRequest): RequestIdentity {
  return {
    address: toHex(request.address) as Hex,
    tag: request.tag,
    state: request.stateName,
    pduAddress: toHex(request.pduAddress) as Hex,
  };
}

/** 扇区 → 字节（面板上统一用字节表述区间，扇区只作旁证）。 */
export function sectorsToBytes(sectors: bigint): bigint {
  return sectors << BigInt(SECTOR_SHIFT);
}
