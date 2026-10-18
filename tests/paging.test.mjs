/**
 * T06 单元测试：分页/分段解析器（纯字节）。
 *
 * 全部页表都是这里手工搭出来的合成页表，断言的是「解析器把字节解释成什么」，
 * 真实客体上的对照由 scripts/verify-t06.mjs 执行。
 *
 * 运行：node --test tests/paging.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HUGE_PAGE_1G,
  HUGE_PAGE_2M,
  HUGE_PAGE_4M,
  PhysicalReadError,
  createPageCache,
  describePaging,
  resolvePagingMode,
  translateLinear,
} from '../packages/trace-format/paging.ts';

const ATTRIBUTION = { sessionId: 's', epoch: 1, frameId: 3, captureId: 'cap-test-3' };
const P = 1n;
const RW = 1n << 1n;
const US = 1n << 2n;
const PS = 1n << 7n;
const NX = 1n << 63n;

/** 合成物理内存提供范围内的字节，越界读取抛错。 */
function makeRam(bytes = 0x1000000) {
  const ram = Buffer.alloc(bytes);
  const calls = [];
  return {
    ram,
    calls,
    async read(address, length) {
      calls.push({ address, length });
      const start = Number(address);
      if (start + length > ram.length) {
        throw new PhysicalReadError('range-not-captured', `物理地址不在范围内: 0x${start.toString(16)}`);
      }
      return ram.subarray(start, start + length);
    },
    entry(tableBase, index, entrySize = 8) {
      const offset = Number(tableBase) + index * entrySize;
      return entrySize === 8 ? ram.readBigUInt64LE(offset) : BigInt(ram.readUInt32LE(offset));
    },
    setEntry(tableBase, index, value, entrySize = 8) {
      const offset = Number(tableBase) + index * entrySize;
      if (entrySize === 8) ram.writeBigUInt64LE(value, offset);
      else ram.writeUInt32LE(Number(value), offset);
    },
  };
}

function ctx(overrides = {}) {
  return {
    cr0: 1n << 31n,
    cr3: 0x1000n,
    cr4: 0n,
    efer: 0n,
    cpl: 0,
    attribution: ATTRIBUTION,
    readerSource: 'test',
    ...overrides,
  };
}

const LONG = { cr0: (1n << 31n) | 1n, cr4: 1n << 5n, efer: 1n << 8n };

/**
 * 把四级页表的测试地址放进内核半区。PML4 索引 0x100 会让第 47 位为 1，
 * 63:48 全为 1 构成规范地址；高位为 0 时触发 #GP。
 */
const KVA = (value) => 0xffff000000000000n | value;

/* ---------- 模式判定与分段 ---------- */

test('PG=0 时线性地址直接换算为物理地址', async () => {
  const ram = makeRam();
  const mode = resolvePagingMode(ctx({ cr0: 0n }));
  assert.equal(mode.kind, 'none');
  const state = describePaging(ctx({ cr0: 0n }));
  assert.equal(state.enabled, false);
  assert.equal(state.levels, null);
  assert.equal(state.rootTable, null);
  const result = await translateLinear(ram, ctx({ cr0: 0n }), 0x1234n);
  assert.equal(result.physical, '0x1234');
  assert.equal(result.fault, null);
  assert.deepEqual(result.walk, []);
});

test('实模式的段基址参与换算，16 位段按 20 位物理地址截断', async () => {
  const ram = makeRam();
  const result = await translateLinear(
    ram,
    ctx({ cr0: 0n, addressSize: 16, segment: { base: 0xf0000n } }),
    0xffffn,
  );
  assert.equal(result.linear, '0xfffff');
  assert.equal(result.physical, '0xfffff');
});

test('保护模式未开分页（PG=0 但 PE=1）的说明与实模式区分开', () => {
  const mode = resolvePagingMode(ctx({ cr0: 1n }));
  assert.equal(mode.kind, 'none');
  assert.match(mode.note, /保护模式但未启用分页/);
});

/* ---------- 长模式四级 ---------- */

test('四级页表：PML4→PDPT→PD→PT 逐级解析并给出条目证据', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x100, 0x2000n | P | RW | US);
  ram.setEntry(0x2000n, 0x80, 0x3000n | P | RW | US);
  ram.setEntry(0x3000n, 0x10, 0x4000n | P | RW | US);
  ram.setEntry(0x4000n, 0x5, 0x5000n | P | RW | US);
  const va = KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n) | (0x5n << 12n) | 0x123n);
  const result = await translateLinear(ram, ctx(LONG), va);
  assert.equal(result.fault, null);
  assert.equal(result.huge, false);
  assert.equal(result.pageSize, 4096);
  assert.equal(result.physical, `0x${(0x5000n + 0x123n).toString(16)}`);
  assert.deepEqual(
    result.walk.map((entry) => `${entry.index}:${entry.present}:${entry.writable}:${entry.user}`),
    ['256:true:true:true', '128:true:true:true', '16:true:true:true', '5:true:true:true'],
  );
  assert.equal(result.walk[0].tableAddress, '0x1800');
  assert.equal(result.walk[3].physicalAddress, '0x5000');
  assert.equal(result.walk[3].evidence.captureId, 'cap-test-3');
  assert.equal(result.walk[3].evidence.kind, 'decoded');
  assert.equal(result.walk[3].evidence.refs[0], 'physical:0x4028:8');
});

test('四级页表的 2 MiB 与 1 GiB 大页都按声明的页大小换算', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x100, 0x2000n | P | RW);
  ram.setEntry(0x2000n, 0x80, 0x3000n | P | RW);
  ram.setEntry(0x3000n, 0x10, 0x400000n | P | RW | PS);
  const va2m = KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n) | 0x1234n);
  const big = await translateLinear(ram, ctx(LONG), va2m);
  assert.equal(big.fault, null);
  assert.equal(big.huge, true);
  assert.equal(big.pageSize, Number(HUGE_PAGE_2M));
  assert.equal(big.physical, `0x${(0x400000n + 0x1234n).toString(16)}`);
  assert.equal(big.walk.length, 3);
  assert.equal(big.walk[2].huge, true);

  ram.setEntry(0x2000n, 0x80, 0x40000000n | P | RW | PS);
  const va1g = KVA((0x100n << 39n) | (0x80n << 30n) | 0x4321n);
  const giant = await translateLinear(ram, ctx(LONG), va1g);
  assert.equal(giant.fault, null);
  assert.equal(giant.pageSize, Number(HUGE_PAGE_1G));
  assert.equal(giant.physical, `0x${(0x40000000n + 0x4321n).toString(16)}`);
});

test('未映射地址报 not-present 并指出是哪一级的哪一项', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x100, 0x2000n | P | RW);
  ram.setEntry(0x2000n, 0x80, 0x3000n | P | RW);
  // PD 项 present=0
  ram.setEntry(0x3000n, 0x10, 0x0n);
  const va = KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n));
  const result = await translateLinear(ram, ctx(LONG), va);
  assert.equal(result.physical, null);
  assert.equal(result.fault.kind, 'not-present');
  assert.equal(result.fault.level, 2);
  assert.match(result.fault.detail, /PD 第 16 项 present=0/);
  assert.equal(result.walk.length, 3);
  assert.equal(result.walk[2].present, false);
});

test('用户态访问 U/S=0 页报 permission，内核态访问用户页成功', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x100, 0x2000n | P | RW | US);
  ram.setEntry(0x2000n, 0x80, 0x3000n | P | RW | US);
  ram.setEntry(0x3000n, 0x10, 0x4000n | P | RW | US);
  ram.setEntry(0x4000n, 0x5, 0x5000n | P | RW); // 最后一级 U/S=0
  const va = KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n) | (0x5n << 12n));
  const asUser = await translateLinear(ram, ctx({ ...LONG, cpl: 3 }), va);
  assert.equal(asUser.fault.kind, 'permission');
  assert.equal(asUser.fault.level, 3);
  const asKernel = await translateLinear(ram, ctx({ ...LONG, cpl: 0 }), va);
  assert.equal(asKernel.fault, null);
});

test('保留位报 reserved；SDM 忽略位允许置位；NXE 决定 bit63 的 noExecute 语义', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x100, 0x2000n | P | RW);
  ram.setEntry(0x2000n, 0x80, 0x3000n | P | RW);
  // 真正会被硬件判成保留位的，只有「物理地址字段里超出 MAXPHYADDR 的那几个位」。
  // 这里按 MAXPHYADDR=48 的 CPU 给上下文，在第 2 级（PD 项）的 bit 50 上做手脚（48 ≤ 50 < 52）。
  ram.setEntry(0x3000n, 0x10, 0x4000n | P | RW | (1n << 50n));
  const va = KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n));
  const reserved = await translateLinear(ram, ctx({ ...LONG, maxPhysBits: 48 }), va);
  assert.equal(reserved.fault.kind, 'reserved');
  assert.equal(reserved.fault.level, 2);
  assert.match(reserved.fault.detail, /保留位非 0/);

  // 58:52 是 SDM 中 PTE 的 Ignored 位，供内核保存软件状态：
  // `_PAGE_BIT_SOFT_DIRTY = _PAGE_BIT_SOFTW3 = 54`、
  // `_PAGE_BIT_SAVED_DIRTY = _PAGE_BIT_SOFTW5 = 58`
  // （arch/x86/include/asm/pgtable_types.h，注释写着 "available for programmer"）。
  // 真实的 COW 页 PTE 就长这样：fork 把页面写保护时把脏位搬进 bit 58，
  // raw=0x8400000002284025 同时带 NX 与 bit58 软件状态，按合法 PTE 翻译。
  ram.setEntry(0x3000n, 0x10, 0x4000n | P | RW);
  ram.setEntry(0x4000n, 0x5, 0x5000n | P | RW | (1n << 54n) | (1n << 58n));
  const ignored = await translateLinear(
    ram,
    ctx({ ...LONG, maxPhysBits: 52 }),
    KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n) | (0x5n << 12n)),
  );
  assert.equal(ignored.fault, null);
  assert.equal(ignored.physical, '0x5000');

  // bit63 在 NXE=0 时也是保留位
  ram.setEntry(0x3000n, 0x10, 0x4000n | P | RW | NX);
  const nxReserved = await translateLinear(ram, ctx(LONG), va);
  assert.equal(nxReserved.fault.kind, 'reserved');

  // 开 NXE 后 bit63 是 NX：翻译成功，但条目标出 noExecute
  ram.setEntry(0x3000n, 0x10, 0x4000n | P | RW);
  ram.setEntry(0x4000n, 0x5, 0x5000n | P | RW | NX);
  const withNx = await translateLinear(
    ram,
    ctx({ ...LONG, efer: (1n << 8n) | (1n << 11n) }),
    KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n) | (0x5n << 12n)),
  );
  assert.equal(withNx.fault, null);
  assert.equal(withNx.walk[3].noExecute, true);
});

test('非规范线性地址报告 #GP 分类', async () => {
  const ram = makeRam();
  const result = await translateLinear(ram, ctx(LONG), 0x0000800000000000n);
  assert.equal(result.physical, null);
  assert.equal(result.fault.kind, 'unsupported');
  assert.match(result.fault.detail, /非规范线性地址/);
  assert.deepEqual(result.walk, []);
});

/* ---------- 长模式五级 ---------- */

test('五级页表按 LA57 取 PML5，索引位移与规范地址位数都跟着变', async () => {
  const ram = makeRam();
  const five = ctx({ ...LONG, cr4: (1n << 5n) | (1n << 12n) });
  const mode = resolvePagingMode(five);
  assert.equal(mode.kind, 'long');
  assert.equal(mode.levels, 5);
  ram.setEntry(0x1000n, 0x1, 0x2000n | P | RW); // PML5[1]
  ram.setEntry(0x2000n, 0x2, 0x3000n | P | RW); // PML4[2]
  ram.setEntry(0x3000n, 0x3, 0x4000n | P | RW); // PDPT[3]
  ram.setEntry(0x4000n, 0x4, 0x5000n | P | RW); // PD[4]
  ram.setEntry(0x5000n, 0x6, 0x6000n | P | RW); // PT[6]
  const va = (1n << 48n) | (2n << 39n) | (3n << 30n) | (4n << 21n) | (6n << 12n) | 0x7fn;
  const result = await translateLinear(ram, five, va);
  assert.equal(result.fault, null);
  assert.equal(result.walk.length, 5);
  assert.equal(result.physical, `0x${(0x6000n + 0x7fn).toString(16)}`);

  // 五级下 bit56 是符号位；0x0100000000000000 的高位为 0，符号扩展校验失败。
  const bad = await translateLinear(ram, five, 0x0200000000000000n);
  assert.equal(bad.fault.kind, 'unsupported');
});

/* ---------- 32 位两级与 PAE ---------- */

test('32 位两级页表：CR4.PSE=0 时 PDE.PS 被忽略，PSE=1 时 4 MiB 大页生效', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x300, 0x2000n | P | RW | PS, 4);
  const va = (0x300n << 22n) | (0x40n << 12n) | 0x55n;

  const noPse = await translateLinear(ram, ctx({ cr3: 0x1000n }), va);
  // PDE.PS 被忽略 → 走 0x2000 处的页表，而那里 present=0
  assert.equal(noPse.fault.kind, 'not-present');
  assert.equal(noPse.fault.level, 1);

  ram.setEntry(0x2000n, 0x40, 0x4000n | P | RW, 4);
  const withPt = await translateLinear(ram, ctx({ cr3: 0x1000n }), va);
  assert.equal(withPt.fault, null);
  assert.equal(withPt.pageSize, 4096);
  assert.equal(withPt.physical, `0x${(0x4000n + 0x55n).toString(16)}`);

  const withPse = await translateLinear(ram, ctx({ cr3: 0x1000n, cr4: 1n << 4n }), va);
  // 4 MiB 大页的 PDE 物理基址必须 4 MiB 对齐，所以要换一个对齐的 PDE 再试
  ram.setEntry(0x1000n, 0x300, 0x400000n | P | RW | PS, 4);
  const pse = await translateLinear(ram, ctx({ cr3: 0x1000n, cr4: 1n << 4n }), va);
  assert.equal(pse.fault, null);
  assert.equal(pse.huge, true);
  assert.equal(pse.pageSize, Number(HUGE_PAGE_4M));
  assert.equal(pse.physical, `0x${(0x400000n + (va & (HUGE_PAGE_4M - 1n))).toString(16)}`);
  assert.equal(describePaging(ctx({ cr3: 0x1000n })).levels, 2);
});

test('PAE 三级页表：PDPT 只有 4 项，可报 2 MiB 大页；levels 如实报 null', async () => {
  const ram = makeRam();
  const pae = ctx({ cr3: 0x1000n, cr4: 1n << 5n, cr0: (1n << 31n) | 1n });
  assert.equal(resolvePagingMode(pae).kind, 'pae');
  assert.equal(describePaging(pae).levels, null);
  assert.match(describePaging(pae).note, /PAE 三级页表/);

  ram.setEntry(0x1000n, 1, 0x2000n | P | RW);
  ram.setEntry(0x2000n, 0x100, 0x3000n | P | RW, 8);
  ram.setEntry(0x3000n, 0x7, 0x4000n | P | RW, 8);
  const va = (1n << 30n) | (0x100n << 21n) | (0x7n << 12n) | 0x20n;
  const result = await translateLinear(ram, pae, va);
  assert.equal(result.fault, null);
  assert.equal(result.physical, `0x${(0x4000n + 0x20n).toString(16)}`);
  assert.deepEqual(result.walk.map((entry) => entry.index), [1, 256, 7]);

  ram.setEntry(0x2000n, 0x100, 0x200000n | P | RW | PS, 8);
  const huge = await translateLinear(ram, pae, va);
  assert.equal(huge.huge, true);
  assert.equal(huge.pageSize, Number(HUGE_PAGE_2M));
});

test('大页项的页内偏移保留位置位时报 reserved', async () => {
  const ram = makeRam();
  ram.setEntry(0x1000n, 0x100, 0x2000n | P | RW);
  ram.setEntry(0x2000n, 0x80, 0x3000n | P | RW);
  ram.setEntry(0x3000n, 0x10, 0x400000n | P | RW | PS | (1n << 15n));
  const va = KVA((0x100n << 39n) | (0x80n << 30n) | (0x10n << 21n) | 0x10n);
  const result = await translateLinear(ram, ctx(LONG), va);
  assert.equal(result.physical, null);
  assert.equal(result.fault.kind, 'reserved');
  assert.match(result.fault.detail, /声明为大页/);
});

test('页表物理页超出采集范围时报告读取缺口并保留已读层级', async () => {
  const ram = makeRam(0x3000);
  ram.setEntry(0x1000n, 0x100, 0x9000n | P | RW); // 指向超出合成内存的表
  const va = KVA((0x100n << 39n) | (0x80n << 30n));
  const result = await translateLinear(ram, ctx(LONG), va);
  assert.equal(result.physical, null);
  assert.equal(result.fault.kind, 'unsupported');
  assert.equal(result.fault.level, 1);
  assert.match(result.fault.detail, /读不到/);
  assert.equal(result.walk.length, 1);
});

/* ---------- 页缓存 ---------- */

test('页缓存：同页重复读只发一次物理读，跨页读正确拼接', async () => {
  const ram = makeRam();
  ram.ram.fill(0xaa, 0x1ff0, 0x2010);
  const reader = {
    calls: [],
    async read(address, length) {
      this.calls.push(`${address.toString(16)}+${length}`);
      return ram.read(address, length);
    },
  };
  const cached = createPageCache(reader);
  const first = await cached.read(0x1ff0n, 8);
  const second = await cached.read(0x1ff8n, 8);
  assert.equal(Buffer.from(first).toString('hex'), 'aaaaaaaaaaaaaaaa');
  assert.equal(Buffer.from(second).toString('hex'), 'aaaaaaaaaaaaaaaa');
  assert.equal(reader.calls.length, 1, `同页应命中缓存，实际 ${JSON.stringify(reader.calls)}`);
  assert.equal(cached.stats.hits, 1);
  assert.equal(cached.stats.reads, 1);

  const across = await cached.read(0x1ffcn, 8);
  assert.equal(across.length, 8);
  assert.equal(Buffer.from(across).toString('hex'), 'aaaaaaaaaaaaaaaa');
  assert.equal(reader.calls.length, 2, `跨页只该多读一页，实际 ${JSON.stringify(reader.calls)}`);
});

test('页缓存：整页读不到时退回按需要的子范围读', async () => {
  const calls = [];
  const reader = {
    async read(address, length) {
      calls.push(`${address.toString(16)}+${length}`);
      if (length === 4096) {
        throw new PhysicalReadError('range-not-captured', '整页超出区域');
      }
      return Buffer.alloc(length, 0x5a);
    },
  };
  const cached = createPageCache(reader);
  const bytes = await cached.read(0x100n, 4);
  assert.equal(bytes.length, 4);
  assert.deepEqual(calls, ['0+4096', '100+4']);
});
