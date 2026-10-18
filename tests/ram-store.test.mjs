/**
 * T06 单元测试：RAM 基线与增量的落盘存储（合成字节）。
 *
 * 断言的是「记账与重建口径」：基线写盘后能按页读回、增量能覆盖基线、
 * 重建散列与手工拼接的整份 RAM 一致、缺页读取报错。
 * 与 QEMU 自己的 pmemsave 全量 dump 的真实对照在 scripts/verify-t06.mjs。
 *
 * 运行：node --test tests/ram-store.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { PhysicalReadError } from '../packages/trace-format/paging.ts';
import { diffSweep, sweepRam } from '../packages/trace-format/ram.ts';
import {
  DenseRamBaseline,
  RamStore,
  normalizeRegions,
  pageCounts,
} from '../services/lab-server/src/collect/ram-store.mjs';

const PAGE = 4096;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oslab-ram-'));
}

/** 一块可以随时改写的「客体物理内存」。 */
function makeRam(size = 0x10000, blockers = []) {
  const bytes = Buffer.alloc(size);
  const blocked = new Set(blockers.map((address) => address.toString(16)));
  const reads = [];
  return {
    bytes,
    reads,
    write(address, content) {
      Buffer.from(content).copy(bytes, Number(address));
    },
    async read(address, length) {
      reads.push({ address: BigInt(address), length });
      if (blocked.has(BigInt(address).toString(16))) {
        throw new PhysicalReadError('range-not-captured', `这一页没有采到: 0x${BigInt(address).toString(16)}`);
      }
      const start = Number(address);
      if (start + length > bytes.length) {
        throw new PhysicalReadError('range-not-captured', `越界: 0x${start.toString(16)}`);
      }
      return bytes.subarray(start, start + length);
    },
  };
}

const REGIONS = [{ base: 0n, size: 0x10000n, name: 'pc.ram', kind: 'ram' }];

/* ---------- 区域表规范化 ---------- */

test('normalizeRegions 只留可直读区域并排序，pageCounts 把尾部不足一页也算一页', () => {
  const regions = normalizeRegions([
    { base: '0x10000', size: '0x100', name: 'pc.bios', kind: 'rom', readable: true },
    { base: '0x0', size: '0x1010', name: 'pc.ram', kind: 'ram', readable: true },
    { base: '0x20000', size: '0x1000', name: 'vga-lowmem', kind: 'mmio', readable: false },
    { base: '0x30000', size: '0x0', name: 'empty', kind: 'ram', readable: true },
  ], { kinds: ['ram', 'rom'] });
  assert.deepEqual(regions.map((region) => region.base), [0n, 0x10000n]);
  assert.deepEqual(pageCounts(regions, 4096n), [2, 1]);
});

test('normalizeRegions 按 names 选择系统内存区域，过滤设备侧 RAM', () => {
  const regions = normalizeRegions([
    { base: '0x0', size: '0xa0000', name: 'pc.ram', kind: 'ram', readable: true },
    { base: '0x100000', size: '0x100000', name: 'pc.ram', kind: 'ram', readable: true },
    // QEMU 里显存就是 RAM 区域，只看 kind 会把它算进「完整 RAM 基线」
    { base: '0xfd000000', size: '0x1000000', name: 'vga.vram', kind: 'ram', readable: true },
  ], { kinds: ['ram'], names: ['pc.ram'] });
  assert.deepEqual(regions.map((region) => region.base), [0n, 0x100000n]);
  assert.equal(regions.every((region) => region.name === 'pc.ram'), true);
});

/* ---------- 基线的写与读 ---------- */

test('基线写盘后能按页读回，索引里每页的散列与内容一致', async () => {
  const ram = makeRam(0x10000);
  for (let page = 0; page < 16; page += 1) ram.write(page * PAGE, Buffer.alloc(PAGE, page));
  const dir = tempDir();
  const store = new RamStore({ dir });

  const meta = await store.writeBaseline({ captureId: 'cap-test-1', regions: REGIONS, reader: ram });
  assert.equal(meta.pages, 16);
  assert.equal(meta.regionPages, 16);
  assert.equal(meta.bytes, 0x10000);
  assert.equal(meta.complete, true);
  assert.equal(meta.skipped.length, 0);
  assert.equal(meta.rawSha256, sha(ram.bytes));

  const baseline = await store.openBaseline('cap-test-1');
  try {
    assert.equal(baseline.index.regionPageCount, 16);
    assert.equal(baseline.index.ordinalOf(0x5000n), 5);
    assert.equal(baseline.index.addressOf(5), 0x5000n);
    assert.equal(baseline.index.get(0x5000n).sha256, sha(Buffer.alloc(PAGE, 5)));
    assert.equal(baseline.index.get(0x20000n), null, '区域外的页在索引里是「没有」而不是「全零」');
    assert.deepEqual(await baseline.page(0x5000n, PAGE), Buffer.alloc(PAGE, 5));
  } finally {
    await baseline.close();
  }

  const read = await store.readRecorded({ captureId: 'cap-test-1', address: 0x5008n, length: 16 });
  assert.equal(read.from, 'baseline');
  assert.deepEqual(read.bytes, Buffer.alloc(16, 5));

  const verified = await store.verifyBaseline('cap-test-1');
  assert.equal(verified.ok, true);
});

test('基线缺页时 complete=false 并记录缺口，读取缺口抛错', async () => {
  const ram = makeRam(0x4000, [0x1000n]);
  ram.write(0, Buffer.alloc(PAGE, 0xa1));
  ram.write(0x2000, Buffer.alloc(PAGE, 0xa2));
  ram.write(0x3000, Buffer.alloc(PAGE, 0xa3));
  const store = new RamStore({ dir: tempDir() });

  const meta = await store.writeBaseline({
    captureId: 'cap-hole',
    regions: [{ base: 0n, size: 0x4000n, name: 'pc.ram', kind: 'ram' }],
    reader: ram,
  });
  assert.equal(meta.complete, false);
  assert.equal(meta.pages, 3);
  assert.equal(meta.regionPages, 4);
  assert.equal(meta.missingCount, 1);
  assert.equal(meta.skipped.length, 1);
  assert.equal(meta.skipped[0].address, '0x1000');
  assert.equal(meta.skipped[0].code, 'range-not-captured');
  assert.equal(meta.bytes, 3 * PAGE, '未采到的页不计入已采字节数');
  assert.equal(meta.fileBytes, 4 * PAGE, '内容文件保持稠密布局，缺页写等长零占位以保住偏移');

  // 读取缺口页抛 PhysicalReadError。
  await assert.rejects(
    () => store.readRecorded({ captureId: 'cap-hole', address: 0x1000n, length: 16 }),
    (error) => error.code === 'ram-page-not-recorded',
  );
  // 缺口两侧的已采页各自读回原始内容。
  const ok = await store.readRecorded({ captureId: 'cap-hole', address: 0x2000n, length: 16 });
  assert.deepEqual(ok.bytes, Buffer.alloc(16, 0xa2));
  const ok3 = await store.readRecorded({ captureId: 'cap-hole', address: 0x3000n, length: 4 });
  assert.deepEqual(ok3.bytes, Buffer.alloc(4, 0xa3));
});

test('空采集的历史读取抛 PhysicalReadError', async () => {
  const store = new RamStore({ dir: tempDir() });
  await assert.rejects(
    () => store.readRecorded({ captureId: 'cap-empty', address: 0n, length: 8 }),
    (error) => error.code === 'ram-page-not-recorded',
  );
});

/* ---------- 增量与重建 ---------- */

test('增量覆盖基线，且重建散列与「改写后的整份 RAM」一致', async () => {
  const ram = makeRam(0x10000);
  for (let page = 0; page < 16; page += 1) ram.write(page * PAGE, Buffer.alloc(PAGE, page));
  const store = new RamStore({ dir: tempDir() });
  await store.writeBaseline({ captureId: 'cap-a', regions: REGIONS, reader: ram });

  const baseline = await store.openBaseline('cap-a');
  let sweep;
  try {
    // 模拟客体写入：第 3 页（CPU 侧）与第 9 页（DMA 侧）被改写
    ram.write(3 * PAGE, Buffer.alloc(PAGE, 0xc3));
    ram.write(9 * PAGE, Buffer.alloc(PAGE, 0xd9));
    sweep = await sweepRam(ram, { regions: REGIONS });
    const diff = diffSweep(baseline.index, sweep);
    assert.deepEqual(diff.changed, [3n * 4096n, 9n * 4096n]);
    assert.equal(diff.unchanged, 14);
    assert.equal(diff.absent, 0);

    const pages = diff.changed.map((address) => ({
      address,
      bytes: Buffer.from(ram.bytes.subarray(Number(address), Number(address) + PAGE)),
    }));
    await store.writeDelta({ captureId: 'cap-a', parentCaptureId: 'cap-a', pages });
  } finally {
    await baseline.close();
  }

  const deltas = await store.listDeltas('cap-a');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].pages, 2);
  assert.equal(deltas[0].bytes, 2 * PAGE);

  // 历史读取优先命中该页的增量。
  const read = await store.readRecorded({ captureId: 'cap-a', address: 3n * 4096n, length: 4 });
  assert.equal(read.from, 'delta-0');
  assert.deepEqual(read.bytes, Buffer.alloc(4, 0xc3));

  const rebuilt = await store.reconstructedHash({ captureId: 'cap-a' });
  assert.equal(rebuilt.complete, true);
  assert.equal(rebuilt.missing, 0);
  assert.equal(rebuilt.bytes, 0x10000);
  assert.equal(rebuilt.sha256, sha(ram.bytes), '重建散列必须等于「基线 + 增量」拼出来的整份 RAM');
  assert.equal(rebuilt.fromDelta, 2);
  assert.equal(rebuilt.fromBaseline, 14);
});

test('重建缺页时 complete=false，strict 模式抛错', async () => {
  const ram = makeRam(0x4000, [0x2000n]);
  ram.write(0, Buffer.alloc(PAGE, 0x11));
  ram.write(0x1000, Buffer.alloc(PAGE, 0x22));
  ram.write(0x3000, Buffer.alloc(PAGE, 0x44));
  const store = new RamStore({ dir: tempDir() });
  await store.writeBaseline({
    captureId: 'cap-b',
    regions: [{ base: 0n, size: 0x4000n, name: 'pc.ram', kind: 'ram' }],
    reader: ram,
  });

  const rebuilt = await store.reconstructedHash({ captureId: 'cap-b' });
  assert.equal(rebuilt.complete, false);
  assert.equal(rebuilt.missing, 1);
  assert.deepEqual(rebuilt.missingPages, ['0x2000']);
  assert.equal(rebuilt.fromBaseline, 3);

  await assert.rejects(
    () => store.reconstructedHash({ captureId: 'cap-b', strict: true }),
    (error) => error.code === 'ram-incomplete' && error.detail.missing === 1,
  );
});

/* ---------- 多区域与稠密索引 ---------- */

test('多区域基线连续编号，跨区域读取各自的页内容', async () => {
  const low = Buffer.alloc(0x10, 1);
  const high = Buffer.alloc(0x10, 2);
  const reader = {
    async read(address, length) {
      const value = BigInt(address);
      const source = value < 0x1000n ? low : high;
      const offset = Number(value - (value < 0x1000n ? 0n : 0x10000n));
      return source.subarray(offset, offset + length);
    },
  };
  const regions = [
    { base: 0n, size: 0x10n, name: 'low', kind: 'ram' },
    { base: 0x10000n, size: 0x10n, name: 'high', kind: 'ram' },
  ];
  const store = new RamStore({ dir: tempDir() });
  const meta = await store.writeBaseline({ captureId: 'cap-c', regions, reader });
  assert.equal(meta.regionPages, 2);

  const baseline = await store.openBaseline('cap-c');
  try {
    const index = baseline.index;
    assert.equal(index.ordinalOf(0n), 0);
    assert.equal(index.ordinalOf(0x10000n), 1);
    assert.equal(index.get(0n).sha256, sha(low));
    assert.equal(index.get(0x10000n).sha256, sha(high));
    assert.equal(index.addressOf(1), 0x10000n);
  } finally {
    await baseline.close();
  }

  const lowRead = await store.readRecorded({ captureId: 'cap-c', address: 0n, length: 16 });
  assert.deepEqual(lowRead.bytes, Buffer.alloc(16, 1));
  const highRead = await store.readRecorded({ captureId: 'cap-c', address: 0x10000n, length: 16 });
  assert.deepEqual(highRead.bytes, Buffer.alloc(16, 2));
});

test('DenseRamBaseline 拒绝索引长度与区域页数不符的数据', () => {
  assert.throws(
    () => new DenseRamBaseline({ regions: REGIONS, pageSize: 4096, digests: Buffer.alloc(32) }),
    /不符/,
  );
});
