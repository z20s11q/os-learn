/** task_struct 字节解析及限定链表遍历。
 * 结构整块读取后按 DWARF 偏移访问；空指针保留 null，读取失败单独报告。
 * 遍历以链表头、空指针、上限及重复节点区分终止原因。
 */

import { CaptureReadError, KernelMemoryView, memoryEvidence } from '../capture.ts';
import type { ReadOnlyCapture } from '../capture.ts';
import type { KernelLayout, LayoutField } from '../layout.ts';
import { readField } from '../layout.ts';
import type { EvidenceRef, Hex } from '../../contracts/common.ts';
import type { ProcessRef, TaskState } from '../../contracts/os.ts';
import { toHex } from '../../contracts/common.ts';
import { PerCpuIndex } from './percpu.ts';
import { decodeTaskState, describeStateBits } from './task-state.ts';

/** `task_struct` 在各处引用时用的类型名（清单里的键）。 */
export const TASK_TYPE = 'task_struct';
export const MM_TYPE = 'mm_struct';
export const SIGNAL_TYPE = 'signal_struct';
export const RQ_TYPE = 'rq';

/** 任务遍历节点上限。 */
export const DEFAULT_MAX_TASKS = 4096;

export class TaskParseError extends CaptureReadError {}

/** 已采集结构体字节及其布局，字段访问在该字节缓冲内完成。 */
export class StructBuffer {
  readonly base: bigint;

  readonly bytes: Uint8Array;

  readonly typeName: string;

  private readonly layout: KernelLayout;

  constructor(base: bigint, bytes: Uint8Array, layout: KernelLayout, typeName: string) {
    this.base = base;
    this.bytes = bytes;
    this.layout = layout;
    this.typeName = typeName;
  }

  /** 按点号路径取字段布局；路径不存在时抛错并列出候选。 */
  field(path: string): LayoutField {
    return this.layout.fieldPath(this.typeName, path);
  }

  has(path: string): boolean {
    try {
      this.field(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 按布局读取字段；signed 控制补码解释，省略时按无符号读取。 */
  value(path: string, signed?: boolean): number | bigint {
    const field = this.field(path);
    const sign = signed ?? (field.bitSize !== null ? false : undefined);
    return readField(this.bytes, field, sign === undefined ? {} : { signed: sign });
  }

  u32(path: string): number {
    return Number(this.value(path, false));
  }

  s32(path: string): number {
    return Number(this.value(path, true));
  }

  u64(path: string): bigint {
    return BigInt(this.value(path, false));
  }

  s64(path: string): bigint {
    return BigInt(this.value(path, true));
  }

  u16(path: string): number {
    return Number(this.value(path, false));
  }

  /** 指针字段：0 归一成 null。 */
  pointer(path: string): bigint | null {
    const raw = this.u64(path);
    return raw === 0n ? null : raw;
  }

  /** 定长字符数组（`comm`、`name` 这种）。 */
  cstring(path: string): { text: string; truncated: boolean } {
    const field = this.field(path);
    if (field.byteSize === null) {
      throw new TaskParseError('field-width-unknown', `${this.typeName}.${path} 的宽度未知，读不了字符串`, {
        typeName: this.typeName,
        path,
      });
    }
    const start = field.byteOffset;
    const end = start + field.byteSize;
    if (end > this.bytes.length) {
      throw new TaskParseError('out-of-struct', `${this.typeName}.${path} 越过结构末尾`, {
        typeName: this.typeName,
        path,
        byteOffset: start,
        byteSize: field.byteSize,
        structBytes: this.bytes.length,
      });
    }
    const slice = this.bytes.subarray(start, end);
    const zero = slice.indexOf(0);
    if (zero < 0) return { text: Buffer.from(slice).toString('utf8'), truncated: true };
    return { text: Buffer.from(slice.subarray(0, zero)).toString('utf8'), truncated: false };
  }

  /** 字段的绝对地址（结构基址 + 字段偏移），读链表指针时要用。 */
  addressOf(path: string): bigint {
    return this.base + BigInt(this.field(path).byteOffset);
  }
}

/** 把内存里的一个结构读成一个 `StructBuffer`。 */
export async function readStruct(
  view: KernelMemoryView,
  layout: KernelLayout,
  typeName: string,
  address: bigint,
): Promise<StructBuffer> {
  const type = layout.type(typeName);
  if (type.declaration) {
    throw new TaskParseError(
      'type-not-defined',
      `${typeName} 在这份内核的 DWARF 里只有前向声明，没有定义，读不出字段`,
      { typeName, address: toHex(address) },
    );
  }
  if (type.byteSize === null) {
    throw new TaskParseError('type-size-unknown', `${typeName} 的大小未知，不能整块读`, { typeName });
  }
  const bytes = await view.bytes(address, type.byteSize);
  return new StructBuffer(address, bytes, layout, typeName);
}

/* --------------------------------------------------------------------------
 * 链表遍历
 * ------------------------------------------------------------------------ */

export interface ListWalkOptions {
  /** 最多访问多少个节点 */
  limit?: number;
  /** 链表头所在地址（用于识别"回到头部"这个正常终止条件） */
  head?: bigint | null;
}

export interface ListWalkResult {
  /** 每个节点的地址（已从"成员地址"还原成"结构地址"） */
  entries: bigint[];
  /** 是否因为达到上限而停止 */
  truncated: boolean;
  /** 是否检测到环（重复访问同一个节点） */
  cycle: boolean;
  /** 实际读了多少个链表节点 */
  visited: number;
  /** 出现问题的节点与原因（指针为 0、回到头部之外的重复等） */
  notes: string[];
}

/** 遍历 list_head，成员地址减 memberOffset 得结构地址。
 * 分别报告回头、空指针、节点上限和环。
 */
export async function walkList(
  view: KernelMemoryView,
  layout: KernelLayout,
  firstNodeAddress: bigint,
  memberOffset: number,
  options: ListWalkOptions = {},
): Promise<ListWalkResult> {
  const limit = options.limit ?? DEFAULT_MAX_TASKS;
  const head = options.head ?? null;
  const seen = new Set<string>();
  const entries: bigint[] = [];
  const notes: string[] = [];
  let truncated = false;
  let cycle = false;
  let cursor: bigint | null = firstNodeAddress;
  const listHeadType = 'list_head';
  const nextOffset = layout.byteOffset(listHeadType, 'next');

  while (cursor !== null) {
    if (head !== null && cursor === head) break;
    const key = cursor.toString(16);
    if (seen.has(key)) {
      cycle = true;
      notes.push(`链表在 0x${key} 处回到已访问过的节点：要么是环，要么是遍历中途被改过`);
      break;
    }
    seen.add(key);
    if (entries.length >= limit) {
      truncated = true;
      notes.push(`达到遍历上限 ${limit} 个节点，停止；链表可能还有更多节点`);
      break;
    }
    let next: bigint;
    try {
      const node = await view.bytes(cursor, 16);
      next = littleEndianAt(node, nextOffset, 8);
    } catch (error) {
      notes.push(
        `读节点 0x${key} 的 next 指针失败：${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
    entries.push(cursor - BigInt(memberOffset));
    if (next === 0n) {
      // next 为 0 只可能出现在"已经摘链"的节点上；正常链表尾节点会指回头部。
      notes.push(`节点 0x${key} 的 next 为 0：节点已摘链或内存被改写`);
      break;
    }
    cursor = next;
  }

  return { entries, truncated, cycle, visited: entries.length, notes };
}

function littleEndianAt(bytes: Uint8Array, offset: number, width: number): bigint {
  let value = 0n;
  for (let index = width - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

/* --------------------------------------------------------------------------
 * task_struct
 * ------------------------------------------------------------------------ */

export interface KernelTask {
  address: bigint;
  pid: number;
  tgid: number;
  comm: string;
  commTruncated: boolean;
  state: TaskState;
  stateChar: string;
  stateLabel: string;
  stateBits: string[];
  rawState: number;
  rawExitState: number;
  flags: number;
  mm: bigint | null;
  activeMm: bigint | null;
  stack: bigint;
  /** 内核栈顶（栈底地址 + THREAD_SIZE） */
  stackTop: bigint;
  threadSize: bigint;
  realParent: bigint | null;
  parent: bigint | null;
  groupLeader: bigint | null;
  threadPid: bigint | null;
  signal: bigint | null;
  cred: bigint | null;
  files: bigint | null;
  nsproxy: bigint | null;
  /** 从 `thread_info`（内嵌在 task_struct 里）读出的 CPU 号 */
  onCpu: number | null;
  prio: number;
  staticPrio: number;
  normalPrio: number;
  rtPriority: number;
  policy: number;
  utime: bigint;
  stime: bigint;
  startTime: bigint;
  nvcsw: bigint;
  nivcsw: bigint;
  exitState: number;
  exitCode: number;
  /** CFS 调度实体摘要 */
  cfs: { vruntime: bigint | null; onRq: number | null; sumExecRuntime: bigint | null } | null;
  evidence: EvidenceRef;
}

/** 读一个 `task_struct`。地址为 0 时返回 null（调用方通常把它当"没有"处理）。 */
export async function readTask(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelTask> {
  if (address === 0n) {
    throw new TaskParseError('null-task-address', 'task_struct 地址为 0，指向不了任何任务');
  }
  const task = await readStruct(view, layout, TASK_TYPE, address);
  const capture = view.evidenceSource;
  const bytes = task.bytes;

  // COMM_MAX：优先用布局里真实的宽度，布局没给才退回 16（TASK_COMM_LEN）。
  const commWidth = layout.type(TASK_TYPE).fields.comm?.byteSize ?? 16;
  const { text: comm, truncated: commTruncated } = task.cstring('comm');

  const rawState = task.u32('__state');
  const exitState = task.u32('exit_state');
  const decoded = decodeTaskState(rawState, exitState);

  const threadSize = await threadSizeOf(view);

  // CFS 调度实体：只有定义存在才读（有的内核配置里字段位置会变），读不到就如实为 null。
  let cfs: KernelTask['cfs'] = null;
  if (task.has('se.vruntime')) {
    cfs = {
      vruntime: safeValue(() => BigInt(task.value('se.vruntime', false))),
      onRq: safeValue(() => Number(task.value('se.on_rq', false))),
      sumExecRuntime: safeValue(() => BigInt(task.value('se.sum_exec_runtime', false))),
    };
  }

  // thread_info 内嵌在 task_struct 里（CONFIG_THREAD_INFO_IN_TASK），cpu 号从那里取。
  let onCpu: number | null = null;
  if (task.has('thread_info.cpu')) {
    onCpu = safeValue(() => Number(task.value('thread_info.cpu', true)));
  }

  const stack = task.u64('stack');
  return {
    address,
    pid: task.s32('pid'),
    tgid: task.s32('tgid'),
    comm,
    commTruncated: commTruncated || commWidth === 0,
    state: decoded.state,
    stateChar: decoded.char,
    stateLabel: decoded.label,
    stateBits: describeStateBits(rawState),
    rawState,
    rawExitState: exitState,
    flags: task.u32('flags'),
    mm: task.pointer('mm'),
    activeMm: task.pointer('active_mm'),
    stack,
    stackTop: stack + threadSize,
    threadSize,
    realParent: task.pointer('real_parent'),
    parent: task.pointer('parent'),
    groupLeader: task.pointer('group_leader'),
    threadPid: task.pointer('thread_pid'),
    signal: task.pointer('signal'),
    cred: task.pointer('cred'),
    files: task.pointer('files'),
    nsproxy: task.pointer('nsproxy'),
    onCpu,
    prio: task.s32('prio'),
    staticPrio: task.s32('static_prio'),
    normalPrio: task.s32('normal_prio'),
    rtPriority: task.u32('rt_priority'),
    policy: task.u32('policy'),
    utime: task.u64('utime'),
    stime: task.u64('stime'),
    startTime: task.u64('start_time'),
    nvcsw: task.u64('nvcsw'),
    nivcsw: task.u64('nivcsw'),
    exitState,
    exitCode: task.s32('exit_code'),
    cfs,
    evidence: memoryEvidence(capture, address, bytes.length, [
      `type:${TASK_TYPE}`,
      `structBytes:${bytes.length}`,
    ]),
  };
}

/** 字段读取失败时返回 null，供任务摘要降级。 */
function safeValue<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** 内核栈宽度由 init_stack 或 __start_init_stack 到 __end_init_stack 的符号差求得。 */
export async function threadSizeOf(view: KernelMemoryView): Promise<bigint> {
  const end = view.evidenceSource.symbolAddress('__end_init_stack');
  const start = view.evidenceSource.symbolAddress('__start_init_stack')
    ?? view.evidenceSource.symbolAddress('init_stack');
  if (end === null || start === null || end <= start) {
    throw new TaskParseError(
      'thread-size-unknown',
      '符号表里取不到 init_stack 的起止地址（__start_init_stack/__end_init_stack），算不出内核栈大小',
      {
        start: start === null ? null : toHex(start),
        end: end === null ? null : toHex(end),
      },
    );
  }
  return end - start;
}

/* --------------------------------------------------------------------------
 * 任务链表、父子、线程组
 * ------------------------------------------------------------------------ */

export interface TaskListResult {
  tasks: KernelTask[];
  truncated: boolean;
  cycle: boolean;
  notes: string[];
  /** init_task 地址（遍历起点） */
  initTask: bigint;
  evidence: EvidenceRef;
}

/** 从 init_task.tasks.next 遍历到链表头，单独读取 init_task 并放在首项。 */
export async function readTaskList(
  view: KernelMemoryView,
  layout: KernelLayout,
  options: { initTaskAddress?: bigint; limit?: number } = {},
): Promise<TaskListResult> {
  const capture = view.evidenceSource;
  const initTask = options.initTaskAddress ?? view.symbol('init_task');
  const init = await readTask(view, layout, initTask);
  const tasksOffset = layout.byteOffset(TASK_TYPE, 'tasks');
  const headAddress = initTask + BigInt(tasksOffset);

  const head = await view.u64(headAddress); // init_task.tasks.next
  const walk = await walkList(view, layout, head, tasksOffset, {
    limit: options.limit ?? DEFAULT_MAX_TASKS,
    head: headAddress,
  });

  const tasks: KernelTask[] = [init];
  const notes = [...walk.notes];
  for (const address of walk.entries) {
    if (address === initTask) continue; // init_task 已在首项，重复遇到时跳过。
    try {
      tasks.push(await readTask(view, layout, address));
    } catch (error) {
      notes.push(
        `读任务 0x${address.toString(16)} 失败，已跳过：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    tasks,
    truncated: walk.truncated,
    cycle: walk.cycle,
    notes,
    initTask,
    evidence: memoryEvidence(capture, headAddress, 8, [`symbol:init_task`, `walked:${tasks.length}`]),
  };
}

/** 读一个任务的子进程（`children` 链表 + `sibling` 成员）。 */
export async function readChildren(
  view: KernelMemoryView,
  layout: KernelLayout,
  task: KernelTask,
  options: { limit?: number } = {},
): Promise<{ children: bigint[]; truncated: boolean; cycle: boolean; notes: string[] }> {
  const siblingOffset = layout.byteOffset(TASK_TYPE, 'sibling');
  const headAddress = task.address + BigInt(layout.byteOffset(TASK_TYPE, 'children'));
  const first = await view.u64(headAddress);
  const walk = await walkList(view, layout, first, siblingOffset, {
    limit: options.limit ?? DEFAULT_MAX_TASKS,
    head: headAddress,
  });
  return { children: walk.entries, truncated: walk.truncated, cycle: walk.cycle, notes: walk.notes };
}

/** 按 signal_struct.thread_head 与 task_struct.thread_node 遍历线程组。
 * signal 为空时返回空列表并记录原因。
 */
export async function readThreadGroup(
  view: KernelMemoryView,
  layout: KernelLayout,
  task: KernelTask,
  options: { limit?: number } = {},
): Promise<{ threads: bigint[]; truncated: boolean; cycle: boolean; notes: string[] }> {
  if (task.signal === null) {
    return {
      threads: [],
      truncated: false,
      cycle: false,
      notes: ['该任务的 signal_struct 指针为空，取不到线程组'],
    };
  }
  const threadNodeOffset = layout.byteOffset(TASK_TYPE, 'thread_node');
  const headAddress = task.signal + BigInt(layout.byteOffset(SIGNAL_TYPE, 'thread_head'));
  const first = await view.u64(headAddress);
  const walk = await walkList(view, layout, first, threadNodeOffset, {
    limit: options.limit ?? DEFAULT_MAX_TASKS,
    head: headAddress,
  });
  return { threads: walk.entries, truncated: walk.truncated, cycle: walk.cycle, notes: walk.notes };
}

/* --------------------------------------------------------------------------
 * current 与 runqueue
 * ------------------------------------------------------------------------ */

/** `pcpu_hot.current_task` 的符号名（6.12 里 current 走这条链）。 */
export const PCPU_HOT = 'pcpu_hot';
export const PCPU_HOT_TYPE = 'pcpu_hot';

export interface CurrentTaskResult {
  cpu: number;
  /** 每 CPU 基址 + pcpu_hot 链接地址 + current_task 偏移 */
  hotAddress: bigint;
  taskAddress: bigint;
  task: KernelTask;
}

/** current 取自 CPU 对应 per-CPU 基址上的 pcpu_hot.current_task 字段。 */
export async function readCurrentTask(
  view: KernelMemoryView,
  layout: KernelLayout,
  percpu: PerCpuIndex,
  cpu: number,
): Promise<CurrentTaskResult> {
  const hotAddress = await percpu.address(PCPU_HOT, cpu);
  const currentOffset = layout.byteOffset(PCPU_HOT_TYPE, 'current_task');
  const taskAddress = await view.u64(hotAddress + BigInt(currentOffset));
  if (taskAddress === 0n) {
    throw new TaskParseError(
      'no-current-task',
      `CPU ${cpu} 的 pcpu_hot.current_task 是 0：该 CPU 还没有 current（尚未进入调度）`,
      { cpu, hotAddress: toHex(hotAddress) },
    );
  }
  const task = await readTask(view, layout, taskAddress);
  return { cpu, hotAddress, taskAddress, task };
}

export interface RunqueueSummary {
  cpu: number;
  address: bigint;
  /** `rq.nr_running`：可运行任务总数（含 CFS/RT/DL） */
  nrRunning: number;
  /** `rq.cfs.nr_running` */
  cfsNrRunning: number | null;
  /** `rq.rt.rt_nr_running` */
  rtNrRunning: number | null;
  /** `rq.dl.dl_nr_running` */
  dlNrRunning: number | null;
  nrSwitches: bigint | null;
  /** `rq.curr`：本 CPU 当前在跑的任务 */
  curr: bigint | null;
  /** `rq.idle`：本 CPU 的空闲任务 */
  idle: bigint | null;
  /** `rq.cpu` 字段自述的 CPU 号（应当等于查询的 cpu） */
  cpuField: number | null;
  evidence: EvidenceRef;
}

/** runqueues 是每 CPU 一份的 struct rq，地址由 per-CPU 基址加链接地址求得。 */
export async function readRunqueue(
  view: KernelMemoryView,
  layout: KernelLayout,
  percpu: PerCpuIndex,
  cpu: number,
): Promise<RunqueueSummary> {
  const address = await percpu.address('runqueues', cpu);
  const rq = await readStruct(view, layout, RQ_TYPE, address);
  const cpuField = rq.has('cpu') ? safeValue(() => rq.s32('cpu')) : null;
  return {
    cpu,
    address,
    nrRunning: rq.u32('nr_running'),
    cfsNrRunning: rq.has('cfs.nr_running') ? safeValue(() => rq.u32('cfs.nr_running')) : null,
    rtNrRunning: rq.has('rt.rt_nr_running') ? safeValue(() => rq.u32('rt.rt_nr_running')) : null,
    dlNrRunning: rq.has('dl.dl_nr_running') ? safeValue(() => rq.u32('dl.dl_nr_running')) : null,
    nrSwitches: rq.has('nr_switches') ? safeValue(() => rq.u64('nr_switches')) : null,
    curr: rq.pointer('curr'),
    idle: rq.pointer('idle'),
    cpuField,
    evidence: memoryEvidence(view.evidenceSource, address, rq.bytes.length, [`type:${RQ_TYPE}`]),
  };
}

/* --------------------------------------------------------------------------
 * 与契约对接
 * ------------------------------------------------------------------------ */

/** KernelTask 转 ProcessRef：threads 放其他线程 pid，mmAddress 保留真实 null。 */
export function toProcessRef(
  task: KernelTask,
  options: { parentPid?: number | null; threadPids?: number[]; childPids?: number[] } = {},
): ProcessRef {
  return {
    pid: task.pid,
    tgid: task.tgid,
    taskAddress: toHex(task.address) as Hex,
    comm: task.comm,
    state: task.state,
    stateRaw: task.rawState,
    parentPid: options.parentPid ?? null,
    mmAddress: task.mm === null ? null : (toHex(task.mm) as Hex),
    stackAddress: toHex(task.stack) as Hex,
    threads: options.threadPids ?? [],
    evidence: task.evidence,
  };
}

/** 线程组里除自己以外的线程号；没有 signal 信息时返回空数组。 */
export function threadPidsFrom(tasks: KernelTask[], selfPid: number): number[] {
  return tasks.filter((entry) => entry.pid !== selfPid).map((entry) => entry.pid).sort((a, b) => a - b);
}
