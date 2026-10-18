/**
 * T07b 单元测试：任务解析。
 *
 * 做法是**用真实的布局清单在合成内存里摆一个 task_struct**：偏移全部来自 T07a 生成的
 * 清单（来自真实 DWARF），值由测试构造；覆盖字段读取、链表边界与状态解码。
 * scripts/verify-t07b.mjs 使用 GDB 独立对照真实偏移与字段值。
 *
 * 为什么必须这么分：真实 VM 上很难制造"链表成环""遍历到上限""字段读不到"这些分支，
 * 而它们恰恰是最容易写错、写错了又最难在界面上发现的部分（表现都是"面板空着"）。
 *
 * 运行：node --test tests/linux-task.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BufferCapture,
  KernelLayout,
  KernelMemoryView,
  PerCpuIndex,
  decodeTaskState,
  describeStateBits,
  fls,
  readChildren,
  readCurrentTask,
  readRunqueue,
  readTask,
  readTaskList,
  readThreadGroup,
  threadSizeOf,
  toProcessRef,
  walkList,
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

function fieldOf(typeName, path) {
  return layout.fieldPath(typeName, path);
}

function putField(bytes, base, typeName, path, value) {
  const field = fieldOf(typeName, path);
  putInt(bytes, Number(BigInt(base) + BigInt(field.byteOffset)), value, field.byteSize ?? 8);
}

function putString(bytes, base, typeName, path, text) {
  const field = fieldOf(typeName, path);
  const width = field.byteSize;
  const at = Number(BigInt(base) + BigInt(field.byteOffset));
  const encoded = Buffer.from(text, 'utf8');
  bytes.fill(0, at, at + width);
  bytes.set(encoded.subarray(0, width - 1), at);
}

/** 建立内核栈所需的符号（THREAD_SIZE 从 init_stack 的起止地址算）。 */
function defineStackSymbols(capture, base = 0x100000n, size = 0x4000n) {
  capture.defineSymbol('__start_init_stack', base);
  capture.defineSymbol('__end_init_stack', base + size);
  return size;
}

/**
 * 建立 per-CPU 换算所需的符号与元数据。
 *
 * 地址刻意放得很散：任务结构本身有 7296 字节，如果元数据和任务摆在同一段内存里，
 * putTask 会把 `__per_cpu_offset[]`/`nr_cpu_ids` 悄悄覆盖成任务字段的值 ——
 * 测试会因此"通过"或"失败"在一个和被测逻辑无关的原因上。
 */
function definePerCpuSymbols(capture, { offsetTable, nrCpuIds = offsetTable + 0x100n, cpus = 1, bases }) {
  capture.defineSymbol('__per_cpu_start', 0n);
  capture.defineSymbol('__per_cpu_end', 0x10000n);
  capture.defineSymbol('__per_cpu_offset', offsetTable);
  capture.defineSymbol('nr_cpu_ids', nrCpuIds);
  putInt(capture.bytes, Number(nrCpuIds), cpus, 4);
  for (let cpu = 0; cpu < cpus; cpu += 1) putInt(capture.bytes, Number(offsetTable) + cpu * 8, bases[cpu], 8);
}

/**
 * 在合成内存里摆一个任务。
 *
 * `next`/`prev` 是"链表上的下一个/上一个任务的地址"，`member` 是链表成员名
 * （`tasks` 或 `sibling` 或 `thread_node`）。内核的链表指针指向的是成员的地址，
 * 因此这里给结构地址加上成员偏移。
 */
function putTask(capture, address, options = {}) {
  const bytes = capture.bytes;
  const base = Number(address);
  const {
    pid = 1, tgid = null, comm = 'task', state = 0, exitState = 0,
    mm = 0n, activeMm = null, stack = 0x100000n,
    realParent = 0n, parent = null, groupLeader = null, threadPid = 0n,
    signal = 0n, cred = 0n, files = 0n, nsproxy = 0n,
    cpu = 0, prio = 120, staticPrio = 120, normalPrio = 120, rtPriority = 0, policy = 0,
    utime = 0n, stime = 0n, startTime = 0n, nvcsw = 0n, nivcsw = 0n,
    exitCode = 0, flags = 0x400000n,
    listMember = 'tasks', next = 0n, prev = 0n,
    childrenNext = 0n, childrenPrev = 0n, threadNodeNext = 0n, threadNodePrev = 0n,
  } = options;

  putField(bytes, base, 'task_struct', 'pid', pid);
  putField(bytes, base, 'task_struct', 'tgid', tgid ?? pid);
  putString(bytes, base, 'task_struct', 'comm', comm);
  putField(bytes, base, 'task_struct', '__state', state);
  putField(bytes, base, 'task_struct', 'exit_state', exitState);
  putField(bytes, base, 'task_struct', 'exit_code', exitCode);
  putField(bytes, base, 'task_struct', 'flags', flags);
  putField(bytes, base, 'task_struct', 'mm', mm);
  putField(bytes, base, 'task_struct', 'active_mm', activeMm ?? mm);
  putField(bytes, base, 'task_struct', 'stack', stack);
  putField(bytes, base, 'task_struct', 'real_parent', realParent);
  putField(bytes, base, 'task_struct', 'parent', parent ?? realParent);
  putField(bytes, base, 'task_struct', 'group_leader', groupLeader ?? address);
  putField(bytes, base, 'task_struct', 'thread_pid', threadPid);
  putField(bytes, base, 'task_struct', 'signal', signal);
  putField(bytes, base, 'task_struct', 'cred', cred);
  putField(bytes, base, 'task_struct', 'files', files);
  putField(bytes, base, 'task_struct', 'nsproxy', nsproxy);
  putField(bytes, base, 'task_struct', 'thread_info.cpu', cpu);
  putField(bytes, base, 'task_struct', 'prio', prio);
  putField(bytes, base, 'task_struct', 'static_prio', staticPrio);
  putField(bytes, base, 'task_struct', 'normal_prio', normalPrio);
  putField(bytes, base, 'task_struct', 'rt_priority', rtPriority);
  putField(bytes, base, 'task_struct', 'policy', policy);
  putField(bytes, base, 'task_struct', 'utime', utime);
  putField(bytes, base, 'task_struct', 'stime', stime);
  putField(bytes, base, 'task_struct', 'start_time', startTime);
  putField(bytes, base, 'task_struct', 'nvcsw', nvcsw);
  putField(bytes, base, 'task_struct', 'nivcsw', nivcsw);
  putField(bytes, base, 'task_struct', 'se.vruntime', 4242n);

  const memberOffset = layout.byteOffset('task_struct', listMember);
  putInt(bytes, base + memberOffset, next, 8);
  putInt(bytes, base + memberOffset + 8, prev, 8);
  const childrenOffset = layout.byteOffset('task_struct', 'children');
  putInt(bytes, base + childrenOffset, childrenNext, 8);
  putInt(bytes, base + childrenOffset + 8, childrenPrev, 8);
  const threadNodeOffset = layout.byteOffset('task_struct', 'thread_node');
  putInt(bytes, base + threadNodeOffset, threadNodeNext, 8);
  putInt(bytes, base + threadNodeOffset + 8, threadNodePrev, 8);
  return address;
}

/** 把一组任务串成一条 `tasks` 链表，返回表头地址。 */
function linkTaskRing(capture, addresses, order = null) {
  const bytes = capture.bytes;
  const offset = layout.byteOffset('task_struct', 'tasks');
  const sequence = order ?? addresses;
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index];
    const next = sequence[(index + 1) % sequence.length];
    const prev = sequence[(index - 1 + sequence.length) % sequence.length];
    putInt(bytes, Number(current + BigInt(offset)), next + BigInt(offset), 8);
    putInt(bytes, Number(current + BigInt(offset) + 8n), prev + BigInt(offset), 8);
  }
  return sequence[0] + BigInt(offset);
}

/* -------------------------------------------------------------------------- */

test('运行环境提供真实布局清单', () => {
  assert.ok(layout !== null, `需要在 ${LAYOUT_DIR} 下有一份布局清单，先跑 gen-layout.mjs`);
});

test('读一个 task_struct：字段按清单偏移取到正确的值', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  const address = 0x400n;
  putTask(capture, address, {
    pid: 1234, tgid: 1234, comm: 'lab-read', mm: 0x800n, stack: 0x200000n,
    realParent: 0x600n, signal: 0xa00n, files: 0xc00n, cred: 0xe00n,
    utime: 700n, stime: 300n, nvcsw: 11n, nivcsw: 22n, startTime: 99n,
  });

  const task = await readTask(view, layout, address);
  assert.equal(task.pid, 1234);
  assert.equal(task.tgid, 1234);
  assert.equal(task.comm, 'lab-read');
  assert.equal(task.state, 'running');
  assert.equal(task.stateChar, 'R');
  assert.equal(task.mm, 0x800n);
  assert.equal(task.activeMm, 0x800n);
  assert.equal(task.stack, 0x200000n);
  assert.equal(task.threadSize, 0x4000n);
  assert.equal(task.stackTop, 0x204000n);
  assert.equal(task.realParent, 0x600n);
  assert.equal(task.utime, 700n);
  assert.equal(task.nvcsw, 11n);
  assert.equal(task.cfs.vruntime, 4242n);
  assert.equal(task.evidence.captureId, 'unit-test-capture');
});

test('mm 指针为 0 时以 null 表示内核线程地址空间', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  putTask(capture, 0x400n, { pid: 2, comm: 'kthreadd', mm: 0n, activeMm: 0x800n });
  const task = await readTask(view, layout, 0x400n);
  assert.equal(task.mm, null);
  assert.equal(task.activeMm, 0x800n);
  const ref = toProcessRef(task);
  assert.equal(ref.mmAddress, null);
});

test('comm 达到长度上限仍为字符时标记截断', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  const comm = fieldOf('task_struct', 'comm');
  const at = Number(0x400n + BigInt(comm.byteOffset));
  capture.bytes.fill(0x41, at, at + comm.byteSize); // 16 个 'A'
  const task = await readTask(view, layout, 0x400n);
  assert.equal(task.commTruncated, true);
  assert.equal(task.comm, 'A'.repeat(16));
});

test('任务链表：能走完整条环，并认出 init_task 是表头', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  capture.defineSymbol('init_task', 0x400n);
  putTask(capture, 0x400n, { pid: 0, comm: 'swapper/0' });
  putTask(capture, 0x2000n, { pid: 1, comm: 'init' });
  putTask(capture, 0x4000n, { pid: 2, comm: 'kthreadd' });
  linkTaskRing(capture, [0x400n, 0x2000n, 0x4000n]);

  const result = await readTaskList(view, layout);
  assert.deepEqual(result.tasks.map((task) => task.pid), [0, 1, 2]);
  assert.equal(result.truncated, false);
  assert.equal(result.cycle, false);
});

test('任务链表：指针成环时报告原因并终止遍历', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  capture.defineSymbol('init_task', 0x400n);
  putTask(capture, 0x400n, { pid: 0 });
  putTask(capture, 0x2000n, { pid: 1 });
  putTask(capture, 0x4000n, { pid: 2 });
  // 1 → 2 → 1 的小环与 init_task 表头分离；第二次访问 1 时报环。
  const offset = layout.byteOffset('task_struct', 'tasks');
  const link = (from, to) => {
    putInt(capture.bytes, Number(from + BigInt(offset)), to + BigInt(offset), 8);
    putInt(capture.bytes, Number(from + BigInt(offset) + 8n), to + BigInt(offset), 8);
  };
  link(0x400n, 0x2000n);
  link(0x2000n, 0x4000n);
  link(0x4000n, 0x2000n);

  const result = await readTaskList(view, layout);
  assert.equal(result.cycle, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.tasks.map((task) => task.pid), [0, 1, 2]);
  assert.match(result.notes.join(' '), /回到已访问过的节点/);
});

test('任务链表：达到上限时标记截断，并且上限真的被遵守', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture({ size: 0x40000 });
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  capture.defineSymbol('init_task', 0x400n);
  const addresses = [];
  for (let index = 0; index < 12; index += 1) {
    const address = 0x400n + BigInt(index) * 0x2000n;
    putTask(capture, address, { pid: index });
    addresses.push(address);
  }
  linkTaskRing(capture, addresses);

  const result = await readTaskList(view, layout, { limit: 5 });
  assert.equal(result.truncated, true);
  assert.equal(result.cycle, false);
  // init_task 自己也算一个，所以是 1 + 5。
  assert.equal(result.tasks.length, 6);
  assert.match(result.notes.join(' '), /达到遍历上限 5/);
});

test('链表节点 next 为 0 时报告摘链原因', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  putTask(capture, 0x400n, { pid: 1, next: 0n, prev: 0n });
  const offset = layout.byteOffset('task_struct', 'tasks');
  const walk = await walkList(view, layout, 0x400n + BigInt(offset), offset, {});
  assert.deepEqual(walk.entries, [0x400n]);
  assert.match(walk.notes.join(' '), /next 为 0/);
});

test('父子：children 链表里的 sibling 成员被还原成任务地址', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  const parent = 0x400n;
  const childA = 0x2000n;
  const childB = 0x4000n;
  putTask(capture, parent, { pid: 100, comm: 'sh' });
  putTask(capture, childA, { pid: 101, comm: 'lab-read', realParent: parent });
  putTask(capture, childB, { pid: 102, comm: 'lab-write', realParent: parent });

  // sh.children → lab-read.sibling → lab-write.sibling → sh.children
  const siblingOffset = layout.byteOffset('task_struct', 'sibling');
  const childrenOffset = layout.byteOffset('task_struct', 'children');
  const childHead = parent + BigInt(childrenOffset);
  // 链表指针指的是"成员的地址"，所以要加上 sibling 偏移；只有链表头例外。
  const sib = (task) => task + BigInt(siblingOffset);
  const link = (prev, next) => {
    putInt(capture.bytes, Number(prev), next, 8);
    putInt(capture.bytes, Number(prev) + 8, next, 8);
  };
  link(childHead, sib(childA));
  link(sib(childA), sib(childB));
  link(sib(childB), childHead);
  // prev 方向也指回头部，避免"成环检测"误伤正常链表。
  putInt(capture.bytes, Number(childHead) + 8, sib(childB), 8);
  putInt(capture.bytes, Number(sib(childA)) + 8, childHead, 8);
  putInt(capture.bytes, Number(sib(childB)) + 8, sib(childA), 8);

  const sh = await readTask(view, layout, parent);
  const children = await readChildren(view, layout, sh);
  assert.deepEqual(children.children.sort((a, b) => (a < b ? -1 : 1)), [childA, childB]);
  assert.equal(children.cycle, false);
});

test('线程组：走 signal_struct.thread_head，用的是 thread_node 成员', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  const signal = 0x10000n;
  const main = 0x400n;
  const worker = 0x2000n;
  putTask(capture, main, { pid: 200, tgid: 200, comm: 'main', signal });
  putTask(capture, worker, { pid: 201, tgid: 200, comm: 'worker', signal });

  const threadNodeOffset = layout.byteOffset('task_struct', 'thread_node');
  const threadHeadOffset = layout.byteOffset('signal_struct', 'thread_head');
  const head = signal + BigInt(threadHeadOffset);
  putInt(capture.bytes, Number(head), worker + BigInt(threadNodeOffset), 8);
  putInt(capture.bytes, Number(head) + 8, worker + BigInt(threadNodeOffset), 8);
  putInt(capture.bytes, Number(worker + BigInt(threadNodeOffset)), main + BigInt(threadNodeOffset), 8);
  putInt(capture.bytes, Number(worker + BigInt(threadNodeOffset)) + 8, main + BigInt(threadNodeOffset), 8);

  const task = await readTask(view, layout, main);
  const group = await readThreadGroup(view, layout, task);
  assert.deepEqual(group.threads.sort((a, b) => (a < b ? -1 : 1)), [main, worker]);
});

test('线程组：signal 为空时返回空列表并说明原因', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  putTask(capture, 0x400n, { pid: 1, signal: 0n });
  const task = await readTask(view, layout, 0x400n);
  const group = await readThreadGroup(view, layout, task);
  assert.deepEqual(group.threads, []);
  assert.match(group.notes.join(' '), /signal_struct 指针为空/);
});

test('每 CPU：__per_cpu_start 偏离 0 时拒绝换算', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  capture.defineSymbol('__per_cpu_start', 0x1000n); // 故意破坏前提
  capture.defineSymbol('__per_cpu_end', 0x20000n);
  capture.defineSymbol('__per_cpu_offset', 0x800n);
  capture.defineSymbol('pcpu_hot', 0x2000n);
  const view = new KernelMemoryView(capture);
  const percpu = new PerCpuIndex(view, capture);
  await assert.rejects(() => percpu.address('pcpu_hot', 0), /约定在这个核上不成立/);
});

test('每 CPU：地址 = __per_cpu_offset[cpu] + 链接地址，取到 current', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture({ size: 0x40000 });
  defineStackSymbols(capture);
  // 内存分段：任务在 0x400 起（每个 task_struct 7296 字节），
  // per-CPU 区在 0x20000/0x28000，符号元数据在 0x30000 之外。
  const bases = [0x20000n, 0x28000n];
  definePerCpuSymbols(capture, { offsetTable: 0x30000n, nrCpuIds: 0x31000n, cpus: 2, bases });
  capture.defineSymbol('pcpu_hot', 0x100n);
  capture.defineSymbol('runqueues', 0x1000n);
  capture.defineSymbol('init_task', 0x100000n); // 普通全局符号，位于 per-CPU 区间之外。
  const view = new KernelMemoryView(capture);

  // 两个 CPU 各自的 current 不同：这是 per-CPU 寻址是否真的生效的判据。
  const taskOnCpu0 = 0x400n;
  const taskOnCpu1 = 0x2000n;
  putTask(capture, taskOnCpu0, { pid: 10, comm: 'cpu0-task', cpu: 0 });
  putTask(capture, taskOnCpu1, { pid: 20, comm: 'cpu1-task', cpu: 1 });
  const currentOffset = layout.byteOffset('pcpu_hot', 'current_task');
  putInt(capture.bytes, Number(bases[0] + 0x100n + BigInt(currentOffset)), taskOnCpu0, 8);
  putInt(capture.bytes, Number(bases[1] + 0x100n + BigInt(currentOffset)), taskOnCpu1, 8);

  const percpu = new PerCpuIndex(view, capture);
  assert.equal(await percpu.cpuCount(), 2);
  assert.equal(await percpu.base(0), bases[0]);
  assert.equal(await percpu.base(1), bases[1]);
  assert.equal(await percpu.isPerCpuSymbol('pcpu_hot'), true);
  assert.equal(await percpu.isPerCpuSymbol('init_task'), false);
  assert.equal(await percpu.address('pcpu_hot', 1), bases[1] + 0x100n);
  // 普通全局变量的 per-CPU 换算请求被拒绝。
  await assert.rejects(() => percpu.address('init_task', 0), /不是 per-CPU 变量/);

  const on0 = await readCurrentTask(view, layout, percpu, 0);
  const on1 = await readCurrentTask(view, layout, percpu, 1);
  assert.equal(on0.hotAddress, bases[0] + 0x100n);
  assert.equal(on0.taskAddress, taskOnCpu0);
  assert.equal(on0.task.comm, 'cpu0-task');
  assert.equal(on0.task.onCpu, 0);
  assert.equal(on1.task.comm, 'cpu1-task');
  assert.notEqual(on0.taskAddress, on1.taskAddress);
  await assert.rejects(() => percpu.base(2), /超出 nr_cpu_ids=2/);
});

test('runqueue 摘要：cfs/rt/dl 三个子队列按嵌套路径取值', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture({ size: 0x40000 });
  defineStackSymbols(capture);
  const bases = [0x20000n];
  definePerCpuSymbols(capture, { offsetTable: 0x30000n, nrCpuIds: 0x31000n, cpus: 1, bases });
  capture.defineSymbol('runqueues', 0x1000n);
  const view = new KernelMemoryView(capture);

  const curr = 0x400n;
  const idle = 0x2000n;
  putTask(capture, curr, { pid: 7, comm: 'busy' });
  const rq = bases[0] + 0x1000n;
  const setRq = (path, value) => {
    const field = layout.fieldPath('rq', path);
    putInt(capture.bytes, Number(rq) + field.byteOffset, value, field.byteSize ?? 4);
  };
  setRq('nr_running', 3);
  setRq('cfs.nr_running', 2);
  setRq('rt.rt_nr_running', 1);
  setRq('dl.dl_nr_running', 0);
  setRq('nr_switches', 12345n);
  setRq('cpu', 0);
  setRq('curr', curr);
  setRq('idle', idle);

  const percpu = new PerCpuIndex(view, capture);
  const summary = await readRunqueue(view, layout, percpu, 0);
  assert.equal(summary.address, rq);
  assert.equal(summary.nrRunning, 3);
  assert.equal(summary.cfsNrRunning, 2);
  assert.equal(summary.rtNrRunning, 1);
  assert.equal(summary.dlNrRunning, 0);
  assert.equal(summary.nrSwitches, 12345n);
  assert.equal(summary.curr, curr);
  assert.equal(summary.idle, idle);
  assert.equal(summary.cpuField, 0);
});

test('嵌套路径下钻：路径缺失或中间段为标量时抛错', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  // cfs 为具名成员，使用嵌套路径查找；摊平表中该键为 undefined。
  const flattened = layout.type('rq').fields['cfs.nr_running'];
  assert.equal(flattened, undefined);
  // 下钻能拿到。
  const nested = layout.fieldPath('rq', 'cfs.nr_running');
  assert.equal(nested.byteOffset, fieldOf('rq', 'cfs').byteOffset + fieldOf('cfs_rq', 'nr_running').byteOffset);
  // 中间段写成标量（nr_running 是 unsigned int）时报错。
  assert.throws(() => layout.fieldPath('rq', 'nr_running.cfs'), /不是内嵌的结构\/联合/);
  assert.throws(() => layout.fieldPath('rq', 'no_such_field'), /没有字段 no_such_field/);
});

test('地址读取失败时抛 CaptureReadError', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture({ size: 0x1000 });
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  await assert.rejects(() => readTask(view, layout, 0x8000n), /测试内存越界|range-not-captured/);
});

test('页缓存：重复读同一页只发一次真实读取', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture({ size: 0x10000 });
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  putTask(capture, 0x400n, { pid: 1, comm: 'aaa' });
  putTask(capture, 0x500n, { pid: 2, comm: 'bbb' });
  await readTask(view, layout, 0x400n);
  const after = capture.reads.length;
  await readTask(view, layout, 0x500n); // 同一个页，应当全部命中缓存
  assert.equal(capture.reads.length, after, '同一页的第二次解析不应再发真实读取');
  assert.ok(view.counters.hits > 0);
});

test('threadSizeOf：符号缺失时报告计算错误', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  const view = new KernelMemoryView(capture);
  await assert.rejects(() => threadSizeOf(view), /算不出内核栈大小/);
});

/* -------------------------------------------------------------------------- */
/* 状态解码                                                                      */
/* -------------------------------------------------------------------------- */

test('状态位图按内核 __task_state_index 解码', () => {
  const cases = [
    { raw: 0x0, exit: 0, char: 'R', state: 'running' },
    { raw: 0x1, exit: 0, char: 'S', state: 'sleeping' },
    { raw: 0x2, exit: 0, char: 'D', state: 'disk-sleep' },
    { raw: 0x4, exit: 0, char: 'T', state: 'stopped' },
    { raw: 0x8, exit: 0, char: 't', state: 'tracing-stop' },
    { raw: 0x0, exit: 0x20, char: 'Z', state: 'zombie' },   // 僵尸看 exit_state
    { raw: 0x0, exit: 0x10, char: 'X', state: 'dead' },
    { raw: 0x40, exit: 0, char: 'P', state: 'unknown' },    // parked：契约里没有对应值
    { raw: 0x402, exit: 0, char: 'I', state: 'idle' },      // TASK_IDLE
    { raw: 0x102, exit: 0, char: 'D', state: 'disk-sleep' }, // TASK_KILLABLE → 最高位是 bit1
    { raw: 0x1000, exit: 0, char: 'D', state: 'disk-sleep' }, // RTLOCK_WAIT → 内核撒谎报 D
    { raw: 0x8000, exit: 0, char: 'D', state: 'disk-sleep' }, // FROZEN → 同样报 D
  ];
  for (const probe of cases) {
    const decoded = decodeTaskState(probe.raw, probe.exit);
    assert.equal(decoded.char, probe.char, `raw=0x${probe.raw.toString(16)} exit=0x${probe.exit.toString(16)}`);
    assert.equal(decoded.state, probe.state);
  }
});

test('fls 与内核一致：fls(0)=0，其余是最高有效位的位置（1 起始）', () => {
  assert.equal(fls(0), 0);
  assert.equal(fls(1), 1);
  assert.equal(fls(2), 2);
  assert.equal(fls(4), 3);
  assert.equal(fls(8), 4);
  assert.equal(fls(0x10), 5);
  assert.equal(fls(0x20), 6);
  assert.equal(fls(0x40), 7);
  assert.equal(fls(0x80), 8);
  assert.equal(fls(0x102), 9); // TASK_KILLABLE：最高位是 bit8（TASK_WAKEKILL）
});

test('状态位说明把原始位拆开，0 说明就是 running', () => {
  assert.deepEqual(describeStateBits(0), ['（无状态位：0x0 就是 TASK_RUNNING）']);
  assert.deepEqual(describeStateBits(0x2 | 0x400), ['UNINTERRUPTIBLE', 'NOLOAD']);
});

test('toProcessRef 保留 null 语义，并把地址写成规范化十六进制', async (t) => {
  if (layout === null) return t.skip('没有布局清单');
  const capture = new BufferCapture();
  defineStackSymbols(capture);
  const view = new KernelMemoryView(capture);
  putTask(capture, 0x400n, { pid: 42, comm: 'init', mm: 0x800n, stack: 0x100000n });
  const task = await readTask(view, layout, 0x400n);
  const ref = toProcessRef(task, { parentPid: 0, threadPids: [43] });
  assert.equal(ref.taskAddress, '0x400');
  assert.equal(ref.mmAddress, '0x800');
  assert.equal(ref.stackAddress, '0x100000');
  assert.equal(ref.stateRaw, 0);
  assert.equal(ref.parentPid, 0);
  assert.deepEqual(ref.threads, [43]);
});
