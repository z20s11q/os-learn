/**
 * T07d 单元测试：文件解析（fd 表 → file → path/dentry/inode → address_space/页缓存）。
 *
 * 偏移来自 T07a 的真实 DWARF 布局清单，字段值由合成内存提供。
 * 覆盖 XArray 编码与遍历、files->fdt 寻址、dentry 名字存储与畸形结构分类。
 * scripts/verify-t07d.mjs 使用 GDB 独立实现核对真实偏移与字段值。
 *
 * 运行：node --test tests/linux-files.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AddressSpaceParseError,
  BufferCapture,
  KernelLayout,
  KernelMemoryView,
  PAGES_PER_SECTION,
  SECTION_HAS_MEM_MAP,
  SECTION_MAP_MASK,
  SECTION_MARKED_PRESENT,
  VMEMMAP_BASE_L4,
  XA_RETRY_ENTRY,
  XA_ZERO_ENTRY,
  decodeDentryFlags,
  decodeFlagBits,
  decodeInodeMode,
  decodeOpenFlags,
  describeDevice,
  describeXaEntry,
  inlineFdArrayLayout,
  listOpenFds,
  pageAddressForPfn,
  pageMappingKind,
  pageCacheFolioRef,
  pfnForPageAddress,
  readAddressSpace,
  readDentry,
  readFdBitmaps,
  readFdtable,
  readFile,
  readFileChain,
  readFiles,
  readInode,
  readPageCache,
  readSuperBlock,
  readXarrayEntry,
  resolveDentryPath,
  resolveVmemmapBase,
  toFileRef,
  u64,
  walkXarray,
  xaErr,
  xaIsSibling,
  xaIsValue,
  xaMkInternal,
  xaMkSibling,
  xaMkValue,
  xaToNode,
  xaToValue,
} from '../packages/linux-decoder/index.ts';

const LAYOUT_DIR = 'artifacts/layout';

function loadLayout() {
  const files = existsSync(LAYOUT_DIR) ? readdirSync(LAYOUT_DIR).filter((name) => name.endsWith('.json')) : [];
  if (files.length === 0) return null;
  return KernelLayout.load(join(LAYOUT_DIR, files[0]));
}

const layout = loadLayout();

/* -------------------------------------------------------------------------- */
/* 造数据的小工具                                                               */
/* -------------------------------------------------------------------------- */

function putInt(bytes, offset, value, width) {
  let rest = BigInt(value);
  if (rest < 0n) rest += 1n << BigInt(width * 8);
  for (let index = 0; index < width; index += 1) {
    bytes[offset + index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/** 按布局清单里的偏移往合成内存里写字段（支持 `f_ra.start` 这种点号下钻路径）。 */
function putField(bytes, base, typeName, path, value) {
  const field = layout.fieldPath(typeName, path);
  putInt(bytes, Number(BigInt(base) + BigInt(field.byteOffset)), value, field.byteSize ?? 8);
}

function putString(bytes, base, typeName, path, text) {
  const field = layout.fieldPath(typeName, path);
  const width = field.byteSize;
  const at = Number(BigInt(base) + BigInt(field.byteOffset));
  const encoded = Buffer.from(text, 'utf8');
  bytes.fill(0, at, at + width);
  bytes.set(encoded.subarray(0, width - 1), at);
}

function offsetOf(typeName, path) {
  return layout.byteOffset(typeName, path);
}

/** 小端读 8 字节（位图按字操作，直接读比走 view 少一层）。 */
function readWord(bytes, address) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[address + index]);
  return value;
}

/** 把 `open_fds` 这类的第 `index` 位立起来。 */
function setBit(bytes, base, index) {
  const address = Number(base) + Math.floor(index / 64) * 8;
  putInt(bytes, address, readWord(bytes, address) | (1n << BigInt(index % 64)), 8);
}

function putXarray(capture, address, head) {
  putField(capture.bytes, address, 'xarray', 'xa_head', head);
}

/** 在合成内存里摆一个 `struct xa_node`；`slots` 是「槽号 → 条目原始值」。 */
function putXaNode(capture, address, options = {}) {
  const {
    shift = 0, offset = 0, count = 0, nrValues = 0, parent = 0n, array = 0n, slots = {},
  } = options;
  const bytes = capture.bytes;
  putField(bytes, address, 'xa_node', 'shift', shift);
  putField(bytes, address, 'xa_node', 'offset', offset);
  putField(bytes, address, 'xa_node', 'count', count);
  putField(bytes, address, 'xa_node', 'nr_values', nrValues);
  putField(bytes, address, 'xa_node', 'parent', parent);
  putField(bytes, address, 'xa_node', 'array', array);
  const slotsBase = Number(address) + offsetOf('xa_node', 'slots');
  for (const [slot, value] of Object.entries(slots)) putInt(bytes, slotsBase + Number(slot) * 8, value, 8);
  return address;
}

/** 一个最小的 `VmemmapFacts`：只要基址与步长对，`pfnForPageAddress` 的逆运算就能对账。 */
function fakeVmemmap(base, pageStructSize = 64n) {
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

/* -------------------------------------------------------------------------- */
/* XArray 的条目编码（纯函数）                                                   */
/* -------------------------------------------------------------------------- */

test('运行环境提供真实布局清单', () => {
  assert.ok(layout !== null, `需要在 ${LAYOUT_DIR} 下有一份布局清单，先跑 gen-layout.mjs`);
});

test('XArray 值条目：xa_mk_value 为 <<1，xa_to_value 为 >>1', () => {
  // 这一条写错的症状极其隐蔽：`<<2` 会让"值 5"与"值 10"在某些下标上互相冒充，
  // 而两者都是合法的值条目，`xa_is_value` 都为真，看不出任何异常。
  assert.equal(xaMkValue(5n), 11n);
  assert.equal(xaToValue(xaMkValue(5n)), 5n);
  assert.equal(xaIsValue(11n), true);
  assert.equal(xaIsValue(10n), false);
  // 0 表示空槽。
  assert.equal(xaIsValue(0n), false);
  assert.equal(describeXaEntry(0n).kind, 'pointer');
});

test('XArray 内部条目：retry/zero 是固定编码，兄弟条目受 CONFIG_XARRAY_MULTI 支配', () => {
  assert.equal(XA_RETRY_ENTRY, (256n << 2n) | 2n);
  assert.equal(XA_ZERO_ENTRY, (257n << 2n) | 2n);
  assert.equal(describeXaEntry(XA_RETRY_ENTRY).kind, 'retry');
  assert.equal(describeXaEntry(XA_ZERO_ENTRY).kind, 'zero');
  // 兄弟条目：`(offset << 2) | 2`，且必须小于 `xa_mk_sibling(XA_CHUNK_SIZE - 1)`。
  assert.equal(xaMkSibling(3), 14n);
  assert.equal(xaIsSibling(xaMkSibling(3), true), true);
  assert.equal(xaIsSibling(xaMkSibling(63), true), false);
  // CONFIG_XARRAY_MULTI 关闭时 xa_is_sibling 返回 false。
  assert.equal(xaIsSibling(xaMkSibling(3), false), false);
  // 普通内部条目（例如节点指针编码）分类为 internal-unknown。
  assert.equal(describeXaEntry(xaMkInternal(1024n)).kind, 'internal-unknown');
});

test('XArray 节点判据：xa_is_node 以 4096 为界，xa_to_node 减 2', () => {
  const nodeAddress = 0x10000n;
  const entry = nodeAddress | 2n;
  assert.equal(xaToNode(entry), nodeAddress);
  // 内部条目数值 <= 4096 时按兄弟、retry 或 zero 等小值分类。
  assert.equal(describeXaEntry(xaMkInternal(1024n)).kind, 'internal-unknown');
  assert.equal(xaToNode(0x10006n), 0x10004n);
  assert.equal(xaToNode(0x10004n), 0x10002n);
});

test('XArray 错误条目：负 errno 要先归一成无符号 64 位，否则结论会反转', () => {
  // C 里 `xa_mk_internal(-ENOMEM)` 是**无符号**运算，得到一个接近 2^64 的大正数；
  // JS 的 bigint 是有符号的，`-12n << 2n | 2n` 会得到 -46n。直接拿 -46n 去比大小，
  // 判定就反了 —— 一个 -ENOMEM 会被报成"正常条目"。
  const memoryError = u64((-12n << 2n) | 2n);
  assert.equal(memoryError, (1n << 64n) - 46n);
  assert.equal(xaErr(memoryError), -12);
  assert.equal(describeXaEntry(memoryError).kind, 'error');
  assert.equal(xaErr(0n), 0);
  assert.equal(xaErr(0x1234n), 0);
});

test('位解码：O_*、FMODE_*、DCACHE_* 的组合名与条件位都按源码口径报', () => {
  const rdwr = decodeOpenFlags(0o2 | 0o2000000);
  assert.equal(rdwr.accessMode, 'O_RDWR');
  assert.ok(rdwr.names.some((entry) => entry.name === 'O_CLOEXEC'));
  assert.equal(rdwr.composites.length, 0);
  // O_SYNC 由 __O_SYNC 与 O_DSYNC 两位拼成。
  const sync = decodeOpenFlags(0o4000000 | 0o10000);
  assert.deepEqual(sync.composites, ['O_SYNC']);
  // O_NDELAY 与 O_NONBLOCK 为同值别名，解码时同时出现。
  assert.deepEqual(decodeOpenFlags(0o4000).composites, ['O_NDELAY']);

  // bit 20..22 按 DCACHE_ENTRY_TYPE 三位字段整体解码。
  const decoded = decodeDentryFlags(4 << 20);
  assert.equal(decoded.entryType.name, 'DCACHE_REGULAR_TYPE');
  assert.deepEqual(decoded.names, []);
  assert.equal(decoded.unknownBits, 0);

  // 条件位：给了配置集合才报出来，否则归入 unknownBits。
  const withoutConfig = decodeFlagBits(1 << 14, [{ name: 'DCACHE_FSNOTIFY_PARENT_WATCHED', value: 1 << 14, config: 'CONFIG_FSNOTIFY' }], new Set());
  assert.equal(withoutConfig.names.length, 0);
  assert.equal(withoutConfig.unknownBits, 1 << 14);
  const withConfig = decodeFlagBits(1 << 14, [{ name: 'DCACHE_FSNOTIFY_PARENT_WATCHED', value: 1 << 14, config: 'CONFIG_FSNOTIFY' }], new Set(['CONFIG_FSNOTIFY']));
  assert.equal(withConfig.names[0].conditional, true);

  assert.equal(describeDevice((8n << 20n) | 1n), '8:1');
});

test('decodeInodeMode：0644 按普通权限解码，特殊位决定 s/S/t/T', () => {
  // setuid/setgid/sticky 分别取 bit 11/10/9。
  const regular = decodeInodeMode(0o100644);
  assert.equal(regular.type, 'S_IFREG');
  assert.ok(regular.permissions.endsWith('644 rw-r--r--'), regular.permissions);
  // 执行位置 1 时写小写，置 0 时写大写。
  assert.ok(decodeInodeMode(0o104755).permissions.endsWith('4755 rwsr-xr-x'), decodeInodeMode(0o104755).permissions);
  assert.ok(decodeInodeMode(0o104644).permissions.endsWith('4644 rwSr--r--'), decodeInodeMode(0o104644).permissions);
  assert.ok(decodeInodeMode(0o041777).permissions.endsWith('1777 rwxrwxrwt'), decodeInodeMode(0o041777).permissions);
  assert.equal(decodeInodeMode(0o040755).type, 'S_IFDIR');
});

/* -------------------------------------------------------------------------- */
/* XArray 容器：遍历与按下标取                                                  */
/* -------------------------------------------------------------------------- */

test('XArray：xa_head 为 0 表示整个数组为空', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putXarray(capture, 0x100n, 0n);
  const facts = await walkXarray(view, layout, 0x100n);
  assert.equal(facts.headKind, 'empty');
  assert.equal(facts.rootNode, null);
  assert.deepEqual(facts.entries, []);
  assert.match(facts.notes.join(' '), /这个 XArray 是空的/);
});

test('XArray：single-entry 头本身就是下标 0 的条目', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putXarray(capture, 0x100n, xaMkValue(7n));
  const facts = await walkXarray(view, layout, 0x100n);
  assert.equal(facts.headKind, 'single-entry');
  assert.equal(facts.rootShift, 0);
  assert.equal(facts.entries.length, 1);
  assert.equal(facts.entries[0].index, 0n);
  assert.equal(facts.entries[0].kind, 'value');
  assert.equal(facts.entries[0].value, 7n);
  assert.equal(facts.entries[0].node, null);
  assert.equal(facts.entries[0].slot, null);
  // 单条目数组仅覆盖下标 0，查询下标 1 返回空。
  const miss = await readXarrayEntry(view, layout, 0x100n, 1n);
  assert.equal(miss.present, false);
  assert.equal(miss.kind, 'absent');
});

test('XArray：一层树（shift=0）按下标散布条目，条目的槽号留在结果里', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const nodeAddress = 0x1000n;
  putXarray(capture, arrayAddress, nodeAddress | 2n);
  putXaNode(capture, nodeAddress, {
    shift: 0, count: 2, nrValues: 1, array: arrayAddress,
    slots: { 5: 0xaaaa0n, 9: xaMkValue(42n) },
  });
  const facts = await walkXarray(view, layout, arrayAddress);
  assert.equal(facts.headKind, 'node');
  assert.equal(facts.rootShift, 0);
  assert.deepEqual(
    facts.entries.map((entry) => [entry.index.toString(), entry.kind, entry.slot]),
    [['5', 'pointer', 5], ['9', 'value', 9]],
  );
  assert.equal(facts.entries[0].pointer, 0xaaaa0n);
  assert.equal(facts.entries[1].value, 42n);
  assert.equal(facts.entries[0].span, 1n);
  assert.equal(facts.entries[0].shift, 0);
  assert.deepEqual(facts.violations, []);
});

test('XArray：两层树按 node->shift 的台阶下降，子节点下标由父槽补高位', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  const child = 0x2000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 6, count: 1, array: arrayAddress, slots: { 1: child | 2n } });
  putXaNode(capture, child, { shift: 0, count: 1, array: arrayAddress, parent: root, slots: { 3: 0xbbbb0n } });
  const facts = await walkXarray(view, layout, arrayAddress);
  assert.deepEqual(facts.nodeAddresses, [root, child]);
  assert.equal(facts.entries.length, 1);
  // 下标 = (父槽号 << 父 shift) | (子槽号 << 子 shift) = 64 + 3。
  assert.equal(facts.entries[0].index, (1n << 6n) | 3n);
  assert.equal(facts.entries[0].node, child);
  assert.equal(facts.entries[0].shift, 0);
});

test('XArray：兄弟条目计入正主条目的 span', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, {
    shift: 6, count: 3, array: arrayAddress,
    slots: { 3: 0xccc0n, 4: xaMkSibling(3), 5: xaMkSibling(3) },
  });
  const facts = await walkXarray(view, layout, arrayAddress);
  assert.equal(facts.entries.length, 1);
  assert.equal(facts.entries[0].slot, 3);
  assert.equal(facts.entries[0].index, 3n << 6n);
  // 正主 + 两个兄弟共占 3 个槽，槽粒度是 2^6 个下标。
  assert.equal(facts.entries[0].span, 3n << 6n);
});

test('XArray：叶子槽的 retry/zero 条目按各自语义分类', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 0, array: arrayAddress, slots: { 2: XA_RETRY_ENTRY, 4: XA_ZERO_ENTRY } });
  const facts = await walkXarray(view, layout, arrayAddress);
  assert.deepEqual(facts.entries.map((entry) => entry.kind), ['retry', 'zero']);
  assert.equal(facts.entries[0].pointer, null);
  // 按下标取时 retry 表示重试标记，内核会重新遍历。
  const lookup = await readXarrayEntry(view, layout, arrayAddress, 2n);
  assert.equal(lookup.present, false);
  assert.equal(lookup.kind, 'retry');
  assert.match(lookup.notes.join(' '), /retry 条目/);
});

test('XArray：要查的下标超出这棵树的覆盖面时如实报"没这个下标"', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 6, array: arrayAddress, slots: { 0: 0xddd0n } });
  const facts = await walkXarray(view, layout, arrayAddress, { indexMin: 1n << 20n });
  assert.deepEqual(facts.entries, []);
  assert.match(facts.notes.join(' '), /超出/);
  const lookup = await readXarrayEntry(view, layout, arrayAddress, 1n << 20n);
  assert.equal(lookup.present, false);
  assert.equal(lookup.inRange, false);
});

test('XArray：节点重复访问时报告成环并终止遍历', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  const child = 0x2000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 12, array: arrayAddress, slots: { 0: child | 2n } });
  putXaNode(capture, child, { shift: 6, array: arrayAddress, parent: root, slots: { 0: root | 2n } });
  const facts = await walkXarray(view, layout, arrayAddress);
  assert.equal(facts.cycle, true);
  assert.match(facts.violations.join(' '), /环/);
});

test('XArray：子节点 shift 与 array 跟父节点对不上时记成结构违规', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  const child = 0x2000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 6, array: arrayAddress, slots: { 2: child | 2n } });
  putXaNode(capture, child, { shift: 2, array: 0x999n, slots: { 1: 0xee0n } });
  const facts = await walkXarray(view, layout, arrayAddress);
  const text = facts.violations.join(' ');
  assert.match(text, /shift = 2/);
  assert.match(text, /array 字段是 0x999/);
});

test('XArray：条目数达到上限时标记截断，条数就是上限', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  const slots = {};
  for (let slot = 0; slot < 10; slot += 1) slots[slot] = 0x1000n + BigInt(slot) * 16n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 0, array: arrayAddress, slots });
  const facts = await walkXarray(view, layout, arrayAddress, { maxEntries: 4 });
  assert.equal(facts.entries.length, 4);
  assert.equal(facts.truncated, true);
});

test('readXarrayEntry：兄弟槽跳回正主槽，steps 记下每一步走的节点/槽', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const arrayAddress = 0x100n;
  const root = 0x1000n;
  const child = 0x2000n;
  putXarray(capture, arrayAddress, root | 2n);
  putXaNode(capture, root, { shift: 6, array: arrayAddress, slots: { 1: child | 2n } });
  // 子节点槽 3 是正主、槽 4 是它的兄弟：查下标 68 会先落在槽 4 上。
  putXaNode(capture, child, { shift: 0, array: arrayAddress, parent: root, slots: { 3: 0xf000n, 4: xaMkSibling(3) } });
  const lookup = await readXarrayEntry(view, layout, arrayAddress, 68n);
  assert.equal(lookup.present, true);
  assert.equal(lookup.kind, 'pointer');
  assert.equal(lookup.pointer, 0xf000n);
  assert.equal(lookup.slot, 3);
  assert.equal(lookup.node, child);
  assert.deepEqual(lookup.steps.map((step) => step.slot), [1, 3]);
  assert.deepEqual(lookup.steps.map((step) => step.shift), [6, 0]);
  assert.deepEqual(lookup.violations, []);
});

/* -------------------------------------------------------------------------- */
/* fd 表：files_struct → fdtable → fd 数组与三张位图                            */
/* -------------------------------------------------------------------------- */

/** 摆一个 `struct fdtable`（fd 指针、三张位图指针、max_fds）。 */
function putFdtable(capture, address, options = {}) {
  const {
    maxFds = 64, fd = 0n, openFds = 0n, closeOnExec = 0n, fullFdsBits = 0n, rcu = 0n,
  } = options;
  const bytes = capture.bytes;
  putField(bytes, address, 'fdtable', 'max_fds', maxFds);
  putField(bytes, address, 'fdtable', 'fd', fd);
  putField(bytes, address, 'fdtable', 'open_fds', openFds);
  putField(bytes, address, 'fdtable', 'close_on_exec', closeOnExec);
  putField(bytes, address, 'fdtable', 'full_fds_bits', fullFdsBits);
  putField(bytes, address, 'fdtable', 'rcu', rcu);
  return address;
}

/**
 * 摆一个 `struct files_struct`。
 *
 * 默认让 `fdt` 指向**内嵌**的 `fdtab` 与内嵌的 fd 数组/位图（也就是 `alloc_files()` 刚做完的
 * 那个状态）；想测"扩容后"就得显式给一组外面的指针，这正是最容易读错的那一半。
 */
function putFiles(capture, address, options = {}) {
  const bytes = capture.bytes;
  const inline = inlineFdArrayLayout(layout, address);
  const fdtabAddress = address + BigInt(offsetOf('files_struct', 'fdtab'));
  const {
    count = 1, nextFd = 4, resizeInProgress = 0, fdt = fdtabAddress, maxFds = 64,
    fdArray = inline.fdArray, openFds = inline.openFds, closeOnExec = inline.closeOnExec,
    fullFdsBits = inline.fullFdsBits,
  } = options;
  putField(bytes, address, 'files_struct', 'count', count);
  putField(bytes, address, 'files_struct', 'resize_in_progress', resizeInProgress);
  putField(bytes, address, 'files_struct', 'next_fd', nextFd);
  putField(bytes, address, 'files_struct', 'fdt', fdt);
  putFdtable(capture, fdt === null ? fdtabAddress : fdt, { maxFds, fd: fdArray, openFds, closeOnExec, fullFdsBits });
  return { inline, fdtabAddress, filesAddress: address };
}

test('fd 表：fdtable 地址为 0 时抛错', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  await assert.rejects(
    () => readFdtable(view, layout, 0n),
    (error) => error.code === 'null-fdtable',
  );
});

test('files：fdt 指向内嵌 fdtab 时报"没扩容过"，位图只读需要的那些字', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { inline } = putFiles(capture, 0x8000n, { maxFds: 64 });
  setBit(capture.bytes, inline.openFds, 3);

  const files = await readFiles(view, layout, 0x8000n);
  assert.equal(files.inlineFdtable, true);
  assert.equal(files.inlineFdtableAddress, 0x8000n + BigInt(offsetOf('files_struct', 'fdtab')));
  assert.equal(files.fdtable.maxFds, 64);
  assert.equal(files.fdArrayCount, 64);
  assert.equal(files.wordBytes, 8);
  assert.equal(files.inlineArrays.fdArray, inline.fdArray);
  assert.match(files.notes.join(' '), /内嵌的 fdtab/);

  const bitmaps = await readFdBitmaps(view, layout, files);
  assert.equal(bitmaps.openFds.length, 1);
  // full_fds_bits 按"open_fds 的字号"分位：一个 64 个 fd 的表只需要 1 个字，
  // 把它也按 64 个 fd 分字是错的（那样会去读 64 个字）。
  assert.equal(bitmaps.fullFdsBits.length, 1);
  assert.equal(bitmaps.openCount, 1);
  assert.equal(bitmaps.openFds[0], 8n);
});

test('files：扩容后的 fdt 指向外部表，按该表读取', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const externalFdtable = 0x5000n;
  const externalArray = 0x6000n;
  const externalOpenFds = 0x7000n;
  const externalCloseOnExec = 0x7010n;
  const externalFullFds = 0x7020n;
  putFiles(capture, 0x8000n, {
    fdt: externalFdtable, maxFds: 128,
    fdArray: externalArray, openFds: externalOpenFds,
    closeOnExec: externalCloseOnExec, fullFdsBits: externalFullFds,
  });
  setBit(capture.bytes, externalOpenFds, 65);
  putInt(capture.bytes, Number(externalArray) + 65 * 8, 0xdead0n, 8);

  const files = await readFiles(view, layout, 0x8000n);
  assert.equal(files.inlineFdtable, false);
  assert.equal(files.fdtable.address, externalFdtable);
  assert.equal(files.fdtable.maxFds, 128);
  assert.match(files.notes.join(' '), /扩容过/);
  assert.match(files.notes.join(' '), /陈旧数据/);

  const bitmaps = await readFdBitmaps(view, layout, files);
  assert.equal(bitmaps.openFds.length, 2);
  assert.equal(bitmaps.fullFdsBits.length, 1);
  const list = await listOpenFds(view, layout, files);
  assert.deepEqual(list.entries.map((entry) => [entry.fd, entry.fileAddress]), [[65, 0xdead0n]]);
});

test('files：fdt 为空指针时抛 null-fdt', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putFiles(capture, 0x8000n, { maxFds: 64 });
  putField(capture.bytes, 0x8000n, 'files_struct', 'fdt', 0n);
  await assert.rejects(() => readFiles(view, layout, 0x8000n), (error) => error.code === 'null-fdt');
});

test('files：地址为 0 时报告内核线程的文件表缺省状态', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  await assert.rejects(
    () => readFiles(view, layout, 0n),
    (error) => error.code === 'null-files' && /内核线程/.test(error.message),
  );
});

test('files：resize_in_progress 为真时标记扩容进行中', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putFiles(capture, 0x8000n, { resizeInProgress: 1 });
  const files = await readFiles(view, layout, 0x8000n);
  assert.equal(files.resizeInProgress, true);
  assert.match(files.notes.join(' '), /正在换 fd 表/);
});

test('readFdBitmaps：max_fds 不是字长整数倍时记一条（源码说它永远是）', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putFiles(capture, 0x8000n, { maxFds: 100 });
  const files = await readFiles(view, layout, 0x8000n);
  const bitmaps = await readFdBitmaps(view, layout, files);
  assert.equal(bitmaps.openFds.length, 2);
  assert.match(bitmaps.notes.join(' '), /不是 64 的整数倍/);
});

test('listOpenFds：仅展开 open_fds 位图中置位的槽', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { inline } = putFiles(capture, 0x8000n, { maxFds: 64 });
  // 槽 1 保留指针但 open_fds 位为 0，按位图跳过该槽。
  putInt(capture.bytes, Number(inline.fdArray) + 1 * 8, 0xd100n, 8);
  putInt(capture.bytes, Number(inline.fdArray) + 3 * 8, 0xd000n, 8);
  setBit(capture.bytes, inline.openFds, 3);
  setBit(capture.bytes, inline.closeOnExec, 3);

  const files = await readFiles(view, layout, 0x8000n);
  const list = await listOpenFds(view, layout, files);
  assert.deepEqual(list.entries.map((entry) => entry.fd), [3]);
  assert.equal(list.entries[0].fileAddress, 0xd000n);
  assert.equal(list.entries[0].closeOnExec, true);
  assert.equal(list.entries[0].slotAddress, inline.fdArray + 24n);
  assert.deepEqual(list.violations, []);
});

test('listOpenFds：位图说开着而槽为空时报成结构自相矛盾', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { inline } = putFiles(capture, 0x8000n, { maxFds: 64 });
  setBit(capture.bytes, inline.openFds, 5);
  const files = await readFiles(view, layout, 0x8000n);
  const list = await listOpenFds(view, layout, files);
  assert.equal(list.entries[0].inconsistent, true);
  assert.match(list.violations.join(' '), /空指针/);
});

/* -------------------------------------------------------------------------- */
/* struct file / dentry / path / inode / super_block                            */
/* -------------------------------------------------------------------------- */

function putFile(capture, address, options = {}) {
  const {
    fCount = 1n, fMode = 0, fFlags = 0, fPos = 0n, fInode = 0n, fMapping = 0n,
    fCred = 0n, fOp = 0n, privateData = 0n, dentry = 0n, mnt = 0n,
    raStart = 0n, raSize = 0, raPages = 0,
  } = options;
  const bytes = capture.bytes;
  putField(bytes, address, 'file', 'f_count', fCount);
  putField(bytes, address, 'file', 'f_mode', fMode);
  putField(bytes, address, 'file', 'f_flags', fFlags);
  putField(bytes, address, 'file', 'f_pos', fPos);
  putField(bytes, address, 'file', 'f_inode', fInode);
  putField(bytes, address, 'file', 'f_mapping', fMapping);
  putField(bytes, address, 'file', 'f_cred', fCred);
  putField(bytes, address, 'file', 'f_op', fOp);
  putField(bytes, address, 'file', 'private_data', privateData);
  putField(bytes, address, 'file', 'f_ra.start', raStart);
  putField(bytes, address, 'file', 'f_ra.size', raSize);
  putField(bytes, address, 'file', 'f_ra.ra_pages', raPages);
  const pathAddress = address + BigInt(offsetOf('file', 'f_path'));
  putField(bytes, pathAddress, 'path', 'mnt', mnt);
  putField(bytes, pathAddress, 'path', 'dentry', dentry);
  return address;
}

/**
 * 摆一个 `struct dentry`。
 *
 * `external` 为假时把 `d_name.name` 指回 `d_iname`（名字在结构里）；为真时指向 `nameAddress`
 * （名字在 `struct external_name` 的 `name[]` 里）。内核判"内嵌还是外部"只看这个名字指针，
 * 因此这里按指针布置名字存储。
 */
function putDentry(capture, address, options = {}) {
  const {
    dFlags = 0, parent = 0n, inode = 0n, sb = 0n, op = 0n,
    name = '', hash = 0, len = null, external = false, nameAddress = null,
  } = options;
  const bytes = capture.bytes;
  putField(bytes, address, 'dentry', 'd_flags', dFlags);
  putField(bytes, address, 'dentry', 'd_parent', parent);
  putField(bytes, address, 'dentry', 'd_inode', inode);
  putField(bytes, address, 'dentry', 'd_sb', sb);
  putField(bytes, address, 'dentry', 'd_op', op);
  const inameAddress = address + BigInt(offsetOf('dentry', 'd_iname'));
  const nameFieldAddress = address + BigInt(offsetOf('dentry', 'd_name'));
  putField(bytes, nameFieldAddress, 'qstr', 'hash', hash);
  putField(bytes, nameFieldAddress, 'qstr', 'len', len === null ? Buffer.byteLength(name, 'utf8') : len);
  if (external) {
    putField(bytes, nameFieldAddress, 'qstr', 'name', nameAddress ?? 0n);
  } else {
    putField(bytes, nameFieldAddress, 'qstr', 'name', inameAddress);
    bytes.set(Buffer.from(name, 'utf8').subarray(0, 39), Number(inameAddress));
  }
  return { inameAddress, nameFieldAddress };
}

function putInode(capture, address, options = {}) {
  const {
    mode = 0o100644, uid = 0, gid = 0, ino = 1n, nlink = 1, rdev = 0, size = 0n,
    state = 0, blocks = 0n, blkbits = 10, writeHint = 0, count = 1,
    sb = 0n, mapping = 0n, op = 0n, fop = 0n,
  } = options;
  const bytes = capture.bytes;
  putField(bytes, address, 'inode', 'i_mode', mode);
  putField(bytes, address, 'inode', 'i_uid', uid);
  putField(bytes, address, 'inode', 'i_gid', gid);
  putField(bytes, address, 'inode', 'i_ino', ino);
  putField(bytes, address, 'inode', 'i_nlink', nlink);
  putField(bytes, address, 'inode', 'i_rdev', rdev);
  putField(bytes, address, 'inode', 'i_size', size);
  putField(bytes, address, 'inode', 'i_state', state);
  putField(bytes, address, 'inode', 'i_blocks', blocks);
  putField(bytes, address, 'inode', 'i_blkbits', blkbits);
  putField(bytes, address, 'inode', 'i_write_hint', writeHint);
  putField(bytes, address, 'inode', 'i_count', count);
  putField(bytes, address, 'inode', 'i_sb', sb);
  putField(bytes, address, 'inode', 'i_mapping', mapping);
  putField(bytes, address, 'inode', 'i_op', op);
  putField(bytes, address, 'inode', 'i_fop', fop);
  return address;
}

function putSuperBlock(capture, address, options = {}) {
  const {
    dev = 0, blocksize = 1024n, blocksizeBits = 10, magic = 0xef53n,
    id = 'ext2', count = 1, active = 1, rootDentry = 0n,
  } = options;
  const bytes = capture.bytes;
  putField(bytes, address, 'super_block', 's_dev', dev);
  putField(bytes, address, 'super_block', 's_blocksize', blocksize);
  putField(bytes, address, 'super_block', 's_blocksize_bits', blocksizeBits);
  putField(bytes, address, 'super_block', 's_magic', magic);
  putField(bytes, address, 'super_block', 's_count', count);
  putField(bytes, address, 'super_block', 's_active', active);
  putField(bytes, address, 'super_block', 's_root', rootDentry);
  putString(bytes, address, 'super_block', 's_id', id);
  return address;
}

test('readFile：字段按清单取，union 成员与"f_mapping 为空"都写成说明', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const FMODE_READ = 1 << 0;
  const FMODE_OPENED = 1 << 19;
  putFile(capture, 0xa000n, {
    fCount: 2n, fMode: FMODE_READ | FMODE_OPENED, fFlags: 0o2 | 0o2000000, fPos: 4096n,
    fInode: 0x2000n, fMapping: 0n, dentry: 0x1000n, mnt: 0x5000n,
    raStart: 0x1800n, raSize: 4, raPages: 32,
  });
  const file = await readFile(view, layout, 0xa000n, { fd: 3 });
  assert.equal(file.fd, 3);
  assert.equal(file.fCount, 2n);
  assert.equal(file.fFlagsDecoded.accessMode, 'O_RDWR');
  assert.ok(file.fFlagsDecoded.names.some((entry) => entry.name === 'O_CLOEXEC'));
  assert.deepEqual(file.fModeNames, ['FMODE_READ', 'FMODE_OPENED']);
  assert.equal(file.fModeUnknownBits, 0);
  assert.equal(file.fInode, 0x2000n);
  assert.equal(file.fMapping, null);
  assert.equal(file.fRa.start, 0x1800n);
  assert.equal(file.fRa.raPages, 32);
  assert.equal(file.path.dentry, 0x1000n);
  assert.equal(file.path.mnt, 0x5000n);
  // f_ra 与 f_llist/f_freeptr/f_task_work 共用同一段字节，这一点必须写在说明里。
  assert.match(file.notes.join(' '), /union/);
  // f_mapping 为空时继续核对 f_inode->i_mapping。
  assert.match(file.notes.join(' '), /i_mapping/);
});

test('readFile/readDentry/readInode 对地址 0 各有自己的稳定错码', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  await assert.rejects(() => readFile(view, layout, 0n), (error) => error.code === 'null-file');
  await assert.rejects(() => readDentry(view, layout, 0n), (error) => error.code === 'null-dentry');
  // 负 dentry 表示查找缺失，d_inode 为空，错误码保留该分类。
  await assert.rejects(
    () => readInode(view, layout, 0n),
    (error) => error.code === 'null-inode' && /负 dentry/.test(error.message),
  );
});

test('readDentry：内嵌名字复用已读结构字节', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: 'hello.txt', dFlags: 4 << 20, inode: 0x2000n });
  const dentry = await readDentry(view, layout, 0x1000n);
  assert.equal(dentry.name.external, false);
  assert.equal(dentry.name.text, 'hello.txt');
  assert.equal(dentry.name.len, 9);
  assert.equal(dentry.name.consistent, true);
  assert.equal(dentry.dFlagsDecoded.entryType.name, 'DCACHE_REGULAR_TYPE');
  assert.equal(dentry.inode, 0x2000n);
  // 整个 dentry 落在一页里：读到的访问次数应当只有 1（读它自己那一页）。
  const seen = capture.reads.map((entry) => `${entry.address.toString(16)}+${entry.length}`).join(', ');
  assert.equal(capture.reads.length, 1, `内嵌名字多发了读取：${seen}`);
});

test('readDentry：按名字指针识别外部存储并读取', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const longName = 'b'.repeat(60); // 超过 DNAME_INLINE_LEN - 1 = 39
  putInt(capture.bytes, Number(0x8000n), 0n, 8);
  capture.bytes.set(Buffer.from(longName, 'utf8'), 0x8000);
  putDentry(capture, 0x1000n, { name: longName, external: true, nameAddress: 0x8000n });
  const dentry = await readDentry(view, layout, 0x1000n);
  assert.equal(dentry.name.external, true);
  assert.equal(dentry.name.text, longName);
  assert.equal(dentry.name.consistent, true);
  assert.equal(dentry.name.nameAddress, 0x8000n);
});

test('readDentry：d_name.name 为空时报告名字读取缺口', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: '', len: 5, external: true, nameAddress: 0n });
  const dentry = await readDentry(view, layout, 0x1000n);
  assert.equal(dentry.name.text, null);
  assert.equal(dentry.name.external, null);
  assert.match(dentry.name.unavailableReason, /空指针/);
});

test('readDentry：d_name.len 超过上限时拒绝按那个长度读内存', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { inameAddress } = putDentry(capture, 0x1000n, { name: 'x', len: 99999 });
  const dentry = await readDentry(view, layout, 0x1000n, { maxNameBytes: 64 });
  assert.equal(dentry.name.text, null);
  assert.match(dentry.name.unavailableReason, /超过上限/);
  assert.equal(dentry.name.inlineAddress, inameAddress);
});

test('readDentry：内嵌数组里的名字与 d_name.len 对不上时记下来', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: 'abc', len: 5 });
  const dentry = await readDentry(view, layout, 0x1000n);
  assert.equal(dentry.name.text, 'abc');
  assert.equal(dentry.name.consistent, false);
  assert.match(dentry.name.notes.join(' '), /对不上/);
});

test('resolveDentryPath：父目录指向自身时结束，根名统一为斜杠', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: '', parent: 0x1000n, inode: 0x2000n }); // 根
  putDentry(capture, 0x3000n, { name: 'hello.txt', parent: 0x1000n, inode: 0x2000n });
  const resolved = await resolveDentryPath(view, layout, 0x3000n);
  assert.equal(resolved.path, '/hello.txt');
  assert.equal(resolved.rooted, true);
  assert.equal(resolved.cycle, false);
  assert.equal(resolved.depth, 2);
  assert.equal(resolved.components[0].dentry, 0x1000n);
  assert.equal(resolved.components[1].dentry, 0x3000n);
});

test('resolveDentryPath：s_root 名为斜杠时规范化根路径', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  // s_root 的名字为 /，根路径与子目录统一按单个斜杠连接。
  putDentry(capture, 0x1000n, { name: '/', parent: 0x1000n, inode: 0x2000n }); // 根
  putDentry(capture, 0x2000n, { name: 'data', parent: 0x1000n, inode: 0x2000n });
  putDentry(capture, 0x3000n, { name: 'hello.txt', parent: 0x2000n, inode: 0x2000n, dFlags: 4 << 20 });
  const resolved = await resolveDentryPath(view, layout, 0x3000n);
  assert.equal(resolved.path, '/data/hello.txt');
  assert.equal(resolved.rooted, true);
  assert.equal(resolved.depth, 3);
});

test('resolveDentryPath：父链断开时保留已读首级目录名', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  // 父指针为空表示父链断开，已读首级目录名原样保留。
  putDentry(capture, 0x1000n, { name: 'data', parent: 0n });
  putDentry(capture, 0x3000n, { name: 'hello.txt', parent: 0x1000n });
  const resolved = await resolveDentryPath(view, layout, 0x3000n);
  assert.equal(resolved.rooted, false);
  assert.equal(resolved.truncated, false);
  assert.equal(resolved.cycle, false);
  assert.equal(resolved.path, '/data/hello.txt');
});

test('resolveDentryPath：d_parent 成环时报告原因并终止遍历', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: 'a', parent: 0x2000n });
  putDentry(capture, 0x2000n, { name: 'b', parent: 0x1000n });
  const resolved = await resolveDentryPath(view, layout, 0x1000n);
  assert.equal(resolved.cycle, true);
  assert.match(resolved.issues.join(' '), /环/);
  assert.equal(resolved.rooted, false);
});

test('resolveDentryPath：中间目录名字读取失败时路径为空', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: '', parent: 0x1000n });
  putDentry(capture, 0x2000n, { name: '', len: 3, external: true, nameAddress: 0n });
  putDentry(capture, 0x3000n, { name: 'x', parent: 0x2000n });
  const resolved = await resolveDentryPath(view, layout, 0x3000n);
  assert.equal(resolved.path, null);
  assert.match(resolved.notes.join(' '), /整条路径不给/);
  assert.match(resolved.issues.join(' '), /名字读不到/);
});

test('resolveDentryPath：父指针为空是"链条断在这里"，与"到了根"分开报', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putDentry(capture, 0x1000n, { name: 'a', parent: 0n });
  const resolved = await resolveDentryPath(view, layout, 0x1000n);
  assert.equal(resolved.rooted, false);
  assert.match(resolved.issues.join(' '), /d_parent 为空/);
});

test('resolveDentryPath：达到深度上限时标记截断并说明上面还有父目录', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  for (let index = 0; index < 5; index += 1) {
    putDentry(capture, 0x1000n + BigInt(index) * 0x200n, {
      name: `d${index}`, parent: index === 4 ? 0x1000n + 4n * 0x200n : 0x1000n + BigInt(index + 1) * 0x200n,
    });
  }
  const resolved = await resolveDentryPath(view, layout, 0x1000n, { maxDepth: 3 });
  assert.equal(resolved.truncated, true);
  assert.equal(resolved.depth, 3);
  assert.match(resolved.issues.join(' '), /上限 3 级/);
});

test('readInode：i_mode 的类型与权限、i_state 的位与"脏"结论', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const I_DIRTY_SYNC = 1 << 3;
  const I_DIRTY_PAGES = 1 << 5;
  putInode(capture, 0x2000n, {
    mode: 0o100644, ino: 0x1234n, nlink: 1, size: 4096n, state: I_DIRTY_SYNC | I_DIRTY_PAGES,
    blocks: 8n, blkbits: 10, writeHint: 1, count: 2, sb: 0x3000n, mapping: 0x4000n,
  });
  const inode = await readInode(view, layout, 0x2000n);
  assert.equal(inode.modeDecoded.type, 'S_IFREG');
  assert.ok(inode.modeDecoded.permissions.endsWith('rw-r--r--'), inode.modeDecoded.permissions);
  assert.equal(inode.ino, 0x1234n);
  assert.equal(inode.size, 4096n);
  assert.deepEqual(inode.stateNames, ['I_DIRTY_SYNC', 'I_DIRTY_PAGES']);
  assert.equal(inode.dirty, true);
  assert.equal(inode.dirtyTime, false);
  assert.equal(inode.writeHintName, 'WRITE_LIFE_NONE');
  assert.equal(inode.superBlock, 0x3000n);
  assert.equal(inode.mapping, 0x4000n);
});

test('readInode：i_rdev 拆出主次设备号只对设备节点有意义', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putInode(capture, 0x2000n, { mode: 0o020600, rdev: Number((1n << 20n) | 3n) });
  const inode = await readInode(view, layout, 0x2000n);
  assert.equal(inode.modeDecoded.type, 'S_IFCHR');
  assert.equal(inode.rdevDecoded.text, '1:3');
  assert.equal(inode.rdevDecoded.major, 1n);
  assert.equal(inode.rdevDecoded.minor, 3n);
});

test('readSuperBlock：s_dev 拆主次设备号，s_id 读出文件系统名', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putSuperBlock(capture, 0x3000n, { dev: Number((8n << 20n) | 1n), id: 'ext2' });
  const sb = await readSuperBlock(view, layout, 0x3000n);
  assert.equal(sb.devDecoded.text, '8:1');
  assert.equal(sb.id, 'ext2');
  assert.equal(sb.blocksize, 1024n);
  assert.equal(sb.magic, 0xef53n);
});

/* -------------------------------------------------------------------------- */
/* 整条链：task.files → fd → file → dentry/inode → super_block → address_space   */
/* -------------------------------------------------------------------------- */

test('readFileChain：按 fd 走完整条链，deviceId 取 super_block.s_dev', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const rootDentry = 0x0000n;
  const fileDentry = 0x1000n;
  const inodeAddress = 0x2000n;
  const sbAddress = 0x3000n;
  const mappingAddress = 0x4000n;
  const fileAddress = 0xa000n;

  putDentry(capture, rootDentry, { name: '', parent: rootDentry, inode: inodeAddress });
  putDentry(capture, fileDentry, { name: 'hello.txt', parent: rootDentry, inode: inodeAddress, sb: sbAddress, dFlags: 4 << 20 });
  putInode(capture, inodeAddress, {
    mode: 0o100644, ino: 0x1234n, size: 4096n, sb: sbAddress, mapping: mappingAddress,
    rdev: Number((1n << 20n) | 7n),
  });
  putSuperBlock(capture, sbAddress, { dev: Number((8n << 20n) | 1n), id: 'ext2', rootDentry });
  putField(capture.bytes, mappingAddress, 'address_space', 'nrpages', 1n);
  putField(capture.bytes, mappingAddress, 'address_space', 'host', inodeAddress);
  putFile(capture, fileAddress, {
    fCount: 1n, fMode: (1 << 0) | (1 << 19), fFlags: 0o2, fPos: 4096n,
    fInode: inodeAddress, dentry: fileDentry, mnt: 0x5000n,
  });
  const { inline } = putFiles(capture, 0x8000n, { maxFds: 64 });
  putInt(capture.bytes, Number(inline.fdArray) + 3 * 8, fileAddress, 8);
  setBit(capture.bytes, inline.openFds, 3);

  const files = await readFiles(view, layout, 0x8000n);
  const chain = await readFileChain(view, layout, { files, fd: 3 });
  assert.equal(chain.fd, 3);
  assert.equal(chain.fdSlotAddress, inline.fdArray + 24n);
  assert.equal(chain.file.address, fileAddress);
  assert.equal(chain.path.path, '/hello.txt');
  assert.equal(chain.inode.modeDecoded.type, 'S_IFREG');
  assert.equal(chain.superBlock.devDecoded.text, '8:1');
  assert.equal(chain.addressSpace.address, mappingAddress);
  assert.equal(chain.mount.vfsmount, 0x5000n);

  const ref = toFileRef(chain);
  assert.equal(ref.fd, 3);
  assert.equal(ref.fileAddress, '0xa000');
  assert.equal(ref.offset, '0x1000');
  assert.equal(ref.flags, '0x2');
  assert.equal(ref.path, '/hello.txt');
  assert.equal(ref.inodeNumber, '4660');
  // i_rdev 是 1:7，但"这个文件在哪个设备上"要问 super_block。
  assert.equal(ref.deviceId, '8:1');
  assert.equal(ref.refCount, 1);
  assert.equal(ref.size, '0x1000');
});

test('readFileChain：fd 越界、fd 没打开、fd 数组缺失各有稳定的错码', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { inline } = putFiles(capture, 0x8000n, { maxFds: 64 });
  const files = await readFiles(view, layout, 0x8000n);
  await assert.rejects(
    () => readFileChain(view, layout, { files, fd: 64 }),
    (error) => error.code === 'fd-out-of-range',
  );
  await assert.rejects(
    () => readFileChain(view, layout, { files, fd: 3 }),
    (error) => error.code === 'fd-not-open',
  );

  const capture2 = new BufferCapture();
  const view2 = new KernelMemoryView(capture2);
  putFiles(capture2, 0x8000n, { maxFds: 64, fdArray: 0n });
  const files2 = await readFiles(view2, layout, 0x8000n);
  assert.equal(files2.fdtable.fdArray, null);
  await assert.rejects(
    () => readFileChain(view2, layout, { files: files2, fd: 3 }),
    (error) => error.code === 'fd-array-missing',
  );
  assert.ok(inline.fdArray > 0n);
});

/* -------------------------------------------------------------------------- */
/* 页缓存：address_space.i_pages 这个 XArray                                     */
/* -------------------------------------------------------------------------- */

/** 摆一个只有 1 个页缓存条目的 address_space：`i_pages` 是 shift=0 的根节点。 */
function putPageCacheMapping(capture, mappingAddress, slot, entryValue) {
  const pagesAddress = mappingAddress + BigInt(offsetOf('address_space', 'i_pages'));
  const root = 0x1000n;
  putField(capture.bytes, mappingAddress, 'address_space', 'nrpages', 1n);
  putXarray(capture, pagesAddress, root | 2n);
  putXaNode(capture, root, { shift: 0, count: 1, array: pagesAddress, slots: { [slot]: entryValue } });
  return { pagesAddress, root };
}

test('readPageCache：槽为特殊编码时报告页指针错误', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putPageCacheMapping(capture, 0x400n, 0, xaMkValue(5n));
  const mapping = await readAddressSpace(view, layout, 0x400n);
  const result = await readPageCache(view, layout, mapping);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].folio, null);
  assert.match(result.entries[0].error, /不是普通指针/);
  assert.match(result.violations.join(' '), /页缓存里应当只放 struct page/);
});

test('readPageCache：页指针不对齐、或与 vmemmap 步长不合时报错', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putPageCacheMapping(capture, 0x400n, 0, 0x1234567890ab4n); // 低位非 0，但不是值条目（最低位为 0）
  const mapping = await readAddressSpace(view, layout, 0x400n);
  const misaligned = await readPageCache(view, layout, mapping);
  assert.equal(misaligned.entries[0].pfn, null);
  assert.match(misaligned.entries[0].error, /8 字节对齐/);

  const capture2 = new BufferCapture();
  const view2 = new KernelMemoryView(capture2);
  // 页地址相对 vmemmap 基址的偏移带余数，触发 struct page 步长校验失败。
  putPageCacheMapping(capture2, 0x400n, 0, 0x10000n + 8n);
  const mapping2 = await readAddressSpace(view2, layout, 0x400n);
  const uneven = await readPageCache(view2, layout, mapping2, { vmemmap: fakeVmemmap(0x10000n) });
  assert.equal(uneven.entries[0].pfn, null);
  assert.equal(uneven.entries[0].pfnRemainder, 8n);
  assert.match(uneven.entries[0].error, /整数倍/);
  assert.equal(pfnForPageAddress(fakeVmemmap(0x10000n), 0x10000n + 8n).pfn, null);
});

test('readPageCache：解出 struct page 的 pfn/mapping/index，并与被查的 address_space 对上', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const mappingAddress = 0x400n;
  const vmemmap = fakeVmemmap(0x10000n);
  const pfn = 2n;
  const pageAddress = vmemmap.base + pfn * vmemmap.pageStructSize;
  putPageCacheMapping(capture, mappingAddress, 2, pageAddress);
  putField(capture.bytes, pageAddress, 'folio', 'flags', 1 << 3); // PG_uptodate
  putField(capture.bytes, pageAddress, 'folio', 'mapping', mappingAddress);
  putField(capture.bytes, pageAddress, 'folio', 'index', pfn);
  putField(capture.bytes, pageAddress, 'folio', '_refcount', 1);
  putField(capture.bytes, pageAddress, 'folio', '_mapcount', 0xffffffff);

  const mapping = await readAddressSpace(view, layout, mappingAddress);
  const result = await readPageCache(view, layout, mapping, { vmemmap });
  const entry = result.entries[0];
  assert.equal(entry.index, 2n);
  assert.equal(entry.pfn, pfn);
  assert.equal(entry.error, null);
  assert.equal(entry.folio.mapping, mappingAddress);
  assert.equal(entry.folio.index, 2n);
  assert.equal(entry.folio.refcount, 1);
  assert.equal(entry.folio.mapcount, -1);
  assert.ok(entry.folio.pageFlags.includes('PG_uptodate'));
  assert.deepEqual(result.violations, []);

  const ref = pageCacheFolioRef(entry, { inodeAddress: 0x2000n });
  assert.equal(ref.pfn, '0x2');
  assert.equal(ref.fileOffset, '0x2000');
  assert.equal(ref.uptodate, true);
  assert.equal(ref.dirty, false);
  assert.equal(ref.inodeAddress, '0x2000');
});

test('readPageCache：页的 mapping 带匿名标记时报告结构违规', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const mappingAddress = 0x400n;
  const vmemmap = fakeVmemmap(0x10000n);
  const pageAddress = vmemmap.base;
  putPageCacheMapping(capture, mappingAddress, 0, pageAddress);
  putField(capture.bytes, pageAddress, 'folio', 'mapping', mappingAddress | 1n);
  putField(capture.bytes, pageAddress, 'folio', 'index', 0n);
  const mapping = await readAddressSpace(view, layout, mappingAddress);
  const result = await readPageCache(view, layout, mapping, { vmemmap });
  assert.equal(result.entries[0].folio.mappingIsAnon, true);
  assert.match(result.violations.join(' '), /PAGE_MAPPING_ANON/);
});

test('readPageCache：页自报的 index 与它被挂的位置不一致时报违规', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const mappingAddress = 0x400n;
  const vmemmap = fakeVmemmap(0x10000n);
  const pageAddress = vmemmap.base;
  putPageCacheMapping(capture, mappingAddress, 3, pageAddress);
  putField(capture.bytes, pageAddress, 'folio', 'mapping', mappingAddress);
  putField(capture.bytes, pageAddress, 'folio', 'index', 7n);
  const mapping = await readAddressSpace(view, layout, mappingAddress);
  const result = await readPageCache(view, layout, mapping, { vmemmap });
  assert.match(result.violations.join(' '), /page->index/);
});

/* -------------------------------------------------------------------------- */
/* vmemmap：mem_section 里那串编码值到底怎么解                                    */
/* -------------------------------------------------------------------------- */

/**
 * 合成一份 `mem_section`：`CONFIG_SPARSEMEM_EXTREME` 下符号里存的是**根数组**的地址，
 * 根数组每一项指向一个 4096 字节的 section 数组。
 *
 * 写入时刻意**照抄内核的编码式**（`mm/internal.h` 的 `sparse_init_one_section()`）：
 * `coded_mem_map = (unsigned long)(mem_map - section_nr_to_pfn(pnum))`。
 * 这一句是指针减法，减掉的是 `起始页框号 × sizeof(struct page)` 个字节 ——
 * 因此基址判据由内核编码式推导。
 */
function putMemSection(capture, options) {
  const {
    vmemmapBase,
    sections,
    memSectionSymbol = 0x1000n,
    rootArray = 0x2000n,
    sectionArray = 0x4000n,
  } = options;
  const stride = layout.has('mem_section') && layout.type('mem_section').byteSize
    ? BigInt(layout.type('mem_section').byteSize)
    : 16n;
  const pageStructSize = BigInt(layout.type('page').byteSize);
  capture.defineSymbol('mem_section', memSectionSymbol);
  putInt(capture.bytes, Number(memSectionSymbol), rootArray, 8);
  putInt(capture.bytes, Number(rootArray), sectionArray, 8);
  for (const item of sections) {
    // VMEMMAP 形态下 `__pfn_to_page(pfn) = 基址 + pfn × 步长`，所以本节的首页地址
    // 就是 `基址 + 起始页框号 × 步长`；再按内核那句指针减法减回去。
    const memMap = vmemmapBase + item.startPfn * pageStructSize;
    const coded = memMap - item.startPfn * pageStructSize;
    const flags = item.flags ?? (SECTION_MARKED_PRESENT | SECTION_HAS_MEM_MAP);
    const address = sectionArray + (item.startPfn / PAGES_PER_SECTION) * stride;
    putInt(capture.bytes, Number(address), coded | flags, 8);
  }
  return { stride, pageStructSize };
}

test('resolveVmemmapBase：编码值本身就是基址，页框号落到别的 section 也解出同一个基址', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { pageStructSize } = putMemSection(capture, {
    vmemmapBase: VMEMMAP_BASE_L4,
    sections: [{ startPfn: 0n }, { startPfn: 3n * PAGES_PER_SECTION }],
  });

  const inSection0 = await resolveVmemmapBase(view, layout, { pfn: 7n });
  const inSection3 = await resolveVmemmapBase(view, layout, { pfn: 3n * PAGES_PER_SECTION + 40n });

  assert.equal(inSection0.base, VMEMMAP_BASE_L4);
  assert.equal(inSection3.base, VMEMMAP_BASE_L4);
  assert.equal(inSection3.sectionNumber, 3n);
  assert.equal(inSection3.sectionStartPfn, 3n * PAGES_PER_SECTION);
  assert.equal(inSection3.source, 'mem-section');
  assert.equal(inSection3.matchesCompiledDefault, true);
  // mem_section 的布局缺口按每节 16 字节推导；notes 允许记录该来源，基址告警列表应为空。
  assert.equal(inSection3.notes.filter((line) => line.includes('与编译期常量')).length, 0);
  // "起始页框号"唯一该出现的地方是"本节首页地址 = 基址 + 起始页框号 × 步长"。
  assert.equal(
    pageAddressForPfn(inSection3.base, inSection3.sectionStartPfn, pageStructSize),
    VMEMMAP_BASE_L4 + 3n * PAGES_PER_SECTION * pageStructSize,
  );
  // 非零 section 的编码也应直接解出相同 vmemmap 基址。
  const asIfPfnUnits = (inSection3.sectionMemMapRaw & SECTION_MAP_MASK)
    + inSection3.sectionStartPfn
    - inSection3.sectionStartPfn * pageStructSize;
  assert.equal(inSection3.base - asIfPfnUnits, 3n * PAGES_PER_SECTION * (pageStructSize - 1n));
});

test('resolveVmemmapBase：实读基址与编译期常量的差异进入说明', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const synthetic = VMEMMAP_BASE_L4 + 0x4000_0000n;
  putMemSection(capture, { vmemmapBase: synthetic, sections: [{ startPfn: 0n }] });
  const facts = await resolveVmemmapBase(view, layout, { pfn: 1n });
  assert.equal(facts.base, synthetic);
  assert.equal(facts.matchesCompiledDefault, false);
  assert.match(facts.notes.join(' '), /与编译期常量/);
});

test('resolveVmemmapBase：section 存在位为 0 时报告错误', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  putMemSection(capture, { vmemmapBase: VMEMMAP_BASE_L4, sections: [{ startPfn: 0n, flags: 0n }] });
  await assert.rejects(
    () => resolveVmemmapBase(view, layout, { pfn: 1n }),
    (error) => error instanceof AddressSpaceParseError && error.code === 'section-not-present',
  );
});

/* -------------------------------------------------------------------------- */
/* 与布局清单对账的小工具                                                        */
/* -------------------------------------------------------------------------- */

test('inlineFdArrayLayout 计算的内嵌地址与 readFiles 一致', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  const { inline } = putFiles(capture, 0x8000n, { maxFds: 64 });
  const predicted = inlineFdArrayLayout(layout, 0x8000n);
  assert.equal(predicted.fdArray, inline.fdArray);
  assert.equal(predicted.openFds, inline.openFds);
  assert.equal(predicted.closeOnExec, inline.closeOnExec);
  assert.equal(predicted.fullFdsBits, inline.fullFdsBits);
  assert.equal(predicted.count, 64);
  const files = await readFiles(view, layout, 0x8000n);
  assert.equal(files.inlineArrays.fdArray, predicted.fdArray);
  assert.equal(files.fdArrayCount, predicted.count);
});

test('pageMappingKind：最低位是匿名标记，其余低位是 movable，0 是文件页', () => {
  assert.equal(pageMappingKind(0n), 'file');
  assert.equal(pageMappingKind(0x1n), 'anon');
  assert.equal(pageMappingKind(0x3n), 'movable');
  assert.equal(pageMappingKind(0xffffea0000000000n), 'file');
  assert.equal(pageMappingKind(0xffffea0000000003n), 'movable');
});

