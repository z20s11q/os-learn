/**
 * T06 单元测试：RAM 镜像与脏页增量（纯字节）。
 *
 * 物理内存由合成 Buffer 提供，覆盖镜像记账与重建散列。
 * scripts/verify-t06.mjs 使用 QEMU HMP pmemsave 全量 dump 独立对照。
 *
 * 运行：node --test tests/ram.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PhysicalReadError } from '../packages/trace-format/paging.ts';
import {
  RamImage,
  diffSweep,
  missedByEvents,
  overlap,
  pagesForRange,
  sweepRam,
} from '../packages/trace-format/ram.ts';

const PAGE = 4096;
const REGIONS = [
  { base: 0n, size: 0x2000n, name: 'pc.ram', kind: 'ram' },
  { base: 0x10000n, size: 0x1000n, name: 'pc.bios', kind: 'rom' },
];

/** 使用 node:crypto 计算独立的对照散列。 */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const fill = (byte, length = PAGE) => Buffer.alloc(length, byte);

/** 一块可读的合成物理内存；越界读抛 PhysicalReadError，与真实读取器同形。 */
function makeRam(size = 0x20000, blockers = []) {
  const ram = Buffer.alloc(size);
  const calls = [];
  const blocked = new Set(blockers.map((address) => address.toString(16)));
  return {
    ram,
    calls,
    async read(address, length) {
      calls.push({ address, length });
      if (blocked.has(address.toString(16))) {
        throw new PhysicalReadError('range-not-captured', `这一页没有采到: 0x${address.toString(16)}`);
      }
      const start = Number(address);
      if (start + length > ram.length) {
        throw new PhysicalReadError('range-not-captured', `越界: 0x${start.toString(16)}`);
      }
      return ram.subarray(start, start + length);
    },
  };
}

/** 把一个「页起始地址 -> 内容」的表包成 hash() 需要的 loadPage。 */
function loadPageFrom(contents) {
  return async (address, length) => {
    const bytes = contents.get(address.toString(16));
    if (bytes === undefined) return null;
    return bytes.subarray(0, length);
  };
}

/* ---------- 区间与区域的纯函数 ---------- */

test('pagesForRange 返回区间覆盖的页，零长度返回空列表', () => {
  assert.deepEqual(pagesForRange(0n, 1), [0n]);
  assert.deepEqual(pagesForRange(0x1000n, 1), [0x1000n]);
  assert.deepEqual(pagesForRange(0xfffn, 2), [0n, 0x1000n]);
  assert.deepEqual(pagesForRange(0x1fffn, 2), [0x1000n, 0x2000n]);
  assert.deepEqual(pagesForRange(0n, 0), []);
  assert.deepEqual(pagesForRange(0n, PAGE), [0n]);
  assert.deepEqual(pagesForRange(0n, PAGE + 1), [0n, 0x1000n]);
});

test('overlap 按半开区间判断相交，首尾相接返回 false', () => {
  assert.equal(overlap({ base: 0n, size: 0x1000n }, { base: 0x1000n, size: 0x1000n }), false);
  assert.equal(overlap({ base: 0x1000n, size: 0x1000n }, { base: 0n, size: 0x1000n }), false);
  assert.equal(overlap({ base: 0n, size: 0x2000n }, { base: 0x1000n, size: 0x1000n }), true);
  assert.equal(overlap({ base: 0n, size: 0x3000n }, { base: 0x1000n, size: 0x1000n }), true);
  assert.equal(overlap({ base: 0x2000n, size: 0x1000n }, { base: 0x1000n, size: 0x1000n }), false);
});

/* ---------- 镜像的构造与归属 ---------- */

test('区域重叠时拒绝构造镜像，确保每页来源唯一', () => {
  assert.throws(
    () => new RamImage({
      regions: [
        { base: 0n, size: 0x2000n, name: 'pc.ram' },
        { base: 0x1000n, size: 0x1000n, name: 'shadow' },
      ],
    }),
    /重叠/,
  );
});

test('区域按基址排序，区域页数把每段尾部不足一页也算一页', () => {
  const image = new RamImage({ regions: [...REGIONS].reverse() });
  assert.deepEqual(image.regionList.map((region) => region.base), [0n, 0x10000n]);
  assert.equal(image.regionBytes, 0x3000n);
  assert.equal(image.regionPageCount, 3);

  const tail = new RamImage({ regions: [{ base: 0n, size: 0x1010n }] });
  assert.equal(tail.regionPageCount, 2);
  assert.equal(tail.regionBytes, 0x1010n);
});

test('一个镜像只能属于一次采集：换 captureId 写入就抛，避免混合帧', async () => {
  const image = new RamImage({ regions: REGIONS });
  assert.equal(image.captureId, null);

  image.bindCapture('cap-1');
  assert.equal(image.captureId, 'cap-1');
  image.bindCapture('cap-1');

  assert.throws(() => image.bindCapture('cap-2'), /混合帧/);
  const record = await image.setPage(0n, fill(0xaa));
  assert.equal(record.captureId, 'cap-1');
});

/* ---------- 页记录 ---------- */

test('setPage 校验页对齐与区域边界，越界地址被拒绝', async () => {
  const image = new RamImage({ regions: REGIONS });
  await assert.rejects(() => image.setPage(0x10n, fill(0xaa)), /对齐/);
  await assert.rejects(() => image.setPage(0x2000n, fill(0xaa)), /不在任何 RAM 区域/);
  await assert.rejects(() => image.setPage(0x20000n, fill(0xaa)), /不在任何 RAM 区域/);

  const record = await image.setPage(0x1000n, fill(0xaa));
  assert.equal(record.address, 0x1000n);
  assert.equal(record.length, PAGE);
  assert.equal(record.sha256, sha(fill(0xaa)));
  // store 缺省时 blobRef 使用内容散列。
  assert.equal(record.blobRef, record.sha256);
});

test('给了 store 时 blobRef 用存储引用，内容相同的页指向同一个 blob', async () => {
  const blobs = new Map();
  const image = new RamImage({
    regions: REGIONS,
    store: async (bytes) => {
      const digest = sha(bytes);
      blobs.set(digest, Buffer.from(bytes));
      return digest;
    },
  });
  await image.setPage(0n, fill(0xaa));
  await image.setPage(0x1000n, fill(0xaa));

  assert.equal(blobs.size, 1, '两页内容相同应该只落一个 blob');
  assert.equal(image.get(0n).blobRef, image.get(0x1000n).blobRef);
  assert.equal(image.get(0n).sha256, image.get(0x1000n).sha256);
});

test('setPageHash 记录散列元数据，stats 标注内容缺口', () => {
  const image = new RamImage({ regions: REGIONS });
  image.setPageHash(0n, 'a'.repeat(64), PAGE);
  image.setPageHash(0x1000n, 'b'.repeat(64), PAGE, 'blob-b');

  const stats = image.stats;
  assert.equal(stats.pages, 2);
  assert.equal(stats.bytes, 2 * PAGE);
  assert.equal(stats.regionPages, 3);
  assert.equal(stats.missingPages, 1);
  assert.equal(stats.regionBytes, '12288');
  assert.equal(image.recordedPages.length, 2);

  // 查询按页起始地址归一：0x800 与 0x1000 落在同一页的判定上要说清楚
  assert.equal(image.get(0n)?.sha256, 'a'.repeat(64));
  assert.equal(image.get(0x1000n)?.blobRef, 'blob-b');
  assert.equal(image.get(0x2000n), null);
  assert.equal(image.inRegions(0x1fffn), true);
  assert.equal(image.inRegions(0x2000n), false);
  assert.equal(image.inRegions(0x10000n), true);
});

/* ---------- 重建散列（E14 的对照口径） ---------- */

test('hash 按区域顺序、页内升序拼字节流；未记录的页按 fillByte 参与比较', async () => {
  const contents = new Map([
    ['0', fill(0xaa)],
    ['1000', fill(0xbb)],
  ]);
  const image = new RamImage({ regions: REGIONS });
  await image.setPage(0n, contents.get('0'));
  await image.setPage(0x1000n, contents.get('1000'));

  const result = await image.hash({ loadPage: loadPageFrom(contents) });
  const expected = Buffer.concat([contents.get('0'), contents.get('1000'), Buffer.alloc(PAGE, 0)]);
  assert.equal(result.sha256, sha(expected), 'BIOS 那一页没采到，必须按 0 占位而不是被跳过');
  assert.equal(result.recorded, 2);
  assert.equal(result.filled, 1);
  assert.equal(result.bytes, String(3 * PAGE));

  // 换 fillByte 散列就该变：证明填充字节确实进了散列
  const filledWrong = await image.hash({ fillByte: 0xff, loadPage: loadPageFrom(contents) });
  assert.notEqual(filledWrong.sha256, result.sha256);
});

test('缺采页按 fillByte 占位，缺口内容差异反映在散列中', async () => {
  const contents = new Map([
    ['0', fill(0x11)],
    ['2000', fill(0x33)],
  ]);
  const image = new RamImage({ regions: [{ base: 0n, size: 0x3000n, name: 'pc.ram' }] });
  await image.setPage(0n, contents.get('0'));
  await image.setPage(0x2000n, contents.get('2000'));

  const result = await image.hash({ loadPage: loadPageFrom(contents) });
  const expected = Buffer.concat([contents.get('0'), Buffer.alloc(PAGE, 0), contents.get('2000')]);
  assert.equal(result.sha256, sha(expected), '中间的洞必须占位');
  assert.equal(result.recorded, 2);
  assert.equal(result.filled, 1);

  // 独立 dump 里这一页其实不是全 0，散列就对不上：这就是漏采要被发现的方式
  const actual = Buffer.concat([contents.get('0'), fill(0x99), contents.get('2000')]);
  assert.notEqual(result.sha256, sha(actual));
});

test('区域尾页按实际长度参与散列', async () => {
  const tailBytes = fill(0x44, 0x10);
  const image = new RamImage({ regions: [{ base: 0n, size: 0x1010n, name: 'pc.ram' }] });
  await image.setPage(0x1000n, tailBytes);

  const seen = [];
  const result = await image.hash({
    loadPage: async (address, length) => {
      seen.push({ address, length });
      return address === 0x1000n ? tailBytes : null;
    },
  });

  assert.deepEqual(seen, [
    { address: 0n, length: PAGE },
    { address: 0x1000n, length: 0x10 },
  ]);
  assert.equal(result.bytes, String(PAGE + 0x10));
  assert.equal(result.recorded, 1);
  assert.equal(result.filled, 1);
  assert.equal(result.sha256, sha(Buffer.concat([Buffer.alloc(PAGE, 0), tailBytes])));
});

/* ---------- 扫描（基线/脏页共用动作） ---------- */

test('sweepRam 逐页读取与计算散列，读取失败页进入 skipped', async () => {
  const ram = makeRam(0x20000, [0x1000n]);
  const result = await sweepRam(ram, { regions: [{ base: 0n, size: 0x2000n, name: 'pc.ram' }] });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].address, 0n);
  assert.equal(result.pages[0].length, PAGE);
  assert.equal(result.pages[0].sha256, sha(Buffer.alloc(PAGE, 0)));
  assert.equal(result.bytesRead, BigInt(PAGE));
  assert.equal(result.physicalReads, 1, '读失败的页不计入物理读次数');

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].address, 0x1000n);
  assert.equal(result.skipped[0].code, 'range-not-captured');
  assert.match(result.skipped[0].reason, /没有采到/);
  assert.equal(typeof result.elapsedMs, 'number');
});

test('sweepRam 对每页回调，尾部不足一页按实际长度读', async () => {
  const ram = makeRam(0x20000);
  const seen = [];
  const result = await sweepRam(ram, {
    regions: [{ base: 0n, size: 0x1010n, name: 'pc.ram' }],
    onPage: (page, index) => {
      seen.push({ address: page.address, index });
    },
  });

  assert.deepEqual(seen, [
    { address: 0n, index: 0 },
    { address: 0x1000n, index: 1 },
  ]);
  assert.deepEqual(result.pages.map((page) => page.length), [PAGE, 0x10]);
  assert.equal(result.bytesRead, BigInt(PAGE + 0x10));
  assert.equal(result.physicalReads, 2);
  assert.deepEqual(result.skipped, []);
});

/* ---------- 差分 ---------- */

test('diffSweep 分别统计变化、新增与两侧读取缺口', () => {
  const image = new RamImage({ regions: [{ base: 0n, size: 0x4000n, name: 'pc.ram' }] });
  image.setPageHash(0n, sha(fill(0x01)), PAGE);
  image.setPageHash(0x1000n, sha(fill(0x02)), PAGE);
  image.setPageHash(0x2000n, sha(fill(0x03)), PAGE);

  const sweep = {
    pages: [
      { address: 0n, sha256: sha(fill(0x01)), length: PAGE },
      { address: 0x1000n, sha256: sha(fill(0x02)), length: PAGE },
      { address: 0x3000n, sha256: sha(fill(0x04)), length: PAGE },
    ],
    bytesRead: 3n * BigInt(PAGE),
    physicalReads: 3,
    skipped: [{ address: 0x2000n, code: 'range-not-captured', reason: '这一页没有采到' }],
    elapsedMs: 1,
  };

  const diff = diffSweep(image, sweep);
  assert.equal(diff.unchanged, 2);
  assert.deepEqual(diff.added, [0x3000n]);
  assert.deepEqual(diff.changed, [0x3000n], 'changed 是导出用的「变了或新增」合集');
  assert.deepEqual(diff.unreadable, [0x2000n], '扫不到的页只在 unreadable 里，不混进 changed');
  assert.equal(diff.absent, 1);
});

test('diffSweep 对内容变化的页报 changed，两侧齐全时 absent 为 0', () => {
  const image = new RamImage({ regions: [{ base: 0n, size: 0x2000n, name: 'pc.ram' }] });
  image.setPageHash(0n, sha(fill(0x01)), PAGE);
  image.setPageHash(0x1000n, sha(fill(0x02)), PAGE);

  const sweep = {
    pages: [
      { address: 0n, sha256: sha(fill(0x01)), length: PAGE },
      { address: 0x1000n, sha256: sha(fill(0x99)), length: PAGE },
    ],
    bytesRead: 2n * BigInt(PAGE),
    physicalReads: 2,
    skipped: [],
    elapsedMs: 0,
  };

  const diff = diffSweep(image, sweep);
  assert.deepEqual(diff.changed, [0x1000n]);
  assert.deepEqual(diff.added, []);
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.unreadable, []);
  assert.equal(diff.absent, 0);
});

test('missedByEvents 只报「事件说变过但扫描没看到」的页', () => {
  assert.deepEqual(missedByEvents([0n, 0x1000n], [0n, 0x1000n]), []);
  // CPU 写入由扫描覆盖，DMA 事件旁证仅核对事件记录的页。
  assert.deepEqual(missedByEvents([0n], [0n, 0x2000n]), []);
  assert.deepEqual(missedByEvents([], [0n]), []);
  // 反过来：事件说这一页变过、扫描却说没变，才是漏采
  assert.deepEqual(missedByEvents([0x1000n], []), [0x1000n]);
  assert.deepEqual(missedByEvents([0n, 0x2000n], [0n]), [0x2000n]);
});
