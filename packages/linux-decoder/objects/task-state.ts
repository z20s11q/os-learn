/** 依据 sched.h 的 __task_state_index 规则解码状态位图和 exit_state。
 * TASK_* 与状态字符来自 include/linux/sched.h，状态文案来自 fs/proc/array.c。
 */

import type { TaskState } from '../../contracts/os.ts';

/* ---------- 状态位（include/linux/sched.h:99-120） ---------- */
export const TASK_BITS = {
  RUNNING: 0x00000000,
  INTERRUPTIBLE: 0x00000001,
  UNINTERRUPTIBLE: 0x00000002,
  __STOPPED: 0x00000004,
  __TRACED: 0x00000008,
  EXIT_DEAD: 0x00000010,
  EXIT_ZOMBIE: 0x00000020,
  EXIT_TRACE: 0x00000030,
  PARKED: 0x00000040,
  DEAD: 0x00000080,
  WAKEKILL: 0x00000100,
  WAKING: 0x00000200,
  NOLOAD: 0x00000400,
  NEW: 0x00000800,
  RTLOCK_WAIT: 0x00001000,
  FREEZABLE: 0x00002000,
  FROZEN: 0x00008000,
  STATE_MAX: 0x00010000,
} as const;

/** `TASK_IDLE = TASK_UNINTERRUPTIBLE | TASK_NOLOAD` */
export const TASK_IDLE = TASK_BITS.UNINTERRUPTIBLE | TASK_BITS.NOLOAD;
/** `TASK_KILLABLE = TASK_WAKEKILL | TASK_UNINTERRUPTIBLE` */
export const TASK_KILLABLE = TASK_BITS.WAKEKILL | TASK_BITS.UNINTERRUPTIBLE;

/** 能出现在 `/proc` 状态里的那些位。 */
export const TASK_REPORT =
  TASK_BITS.RUNNING
  | TASK_BITS.INTERRUPTIBLE
  | TASK_BITS.UNINTERRUPTIBLE
  | TASK_BITS.__STOPPED
  | TASK_BITS.__TRACED
  | TASK_BITS.EXIT_DEAD
  | TASK_BITS.EXIT_ZOMBIE
  | TASK_BITS.PARKED;

export const TASK_REPORT_IDLE = TASK_REPORT + 1;
export const TASK_REPORT_MAX = TASK_REPORT_IDLE << 1;

/** `/proc` 的状态字符表（`include/linux/sched.h:1666`）。索引是 `fls(state)`。 */
export const STATE_CHARS = 'RSDTtXZPI';

/** 每个状态字符的契约映射与人类说明。 */
export const STATE_DETAIL: Record<string, { state: TaskState; label: string }> = {
  R: { state: 'running', label: '运行中（可运行或正在运行）' },
  S: { state: 'sleeping', label: '可中断睡眠（等事件，收到信号会醒）' },
  D: { state: 'disk-sleep', label: '不可中断睡眠（通常在等 I/O，连 kill 都不理）' },
  T: { state: 'stopped', label: '已停止（收到 SIGSTOP 等停止信号被挂起）' },
  t: { state: 'tracing-stop', label: '被调试器停止（ptrace 断点/单步）' },
  X: { state: 'dead', label: '已死亡（即将被回收）' },
  Z: { state: 'zombie', label: '僵尸（已退出，等父进程 wait 收尸）' },
  I: { state: 'idle', label: '空闲（TASK_IDLE：不可中断睡眠但不计入负载）' },
  // parked 映射为 unknown，保留原始 P 字符说明。
  // 契约与内核字符分别保留。
  P: { state: 'unknown', label: '已停放（kthread 的 TASK_PARKED，契约状态里没有对应值）' },
};

/** 循环计算最高有效位位置，1 起始，fls(0)=0。 */
export function fls(value: number): number {
  let position = 0;
  let rest = value >>> 0;
  while (rest !== 0) {
    position += 1;
    rest >>>= 1;
  }
  return position;
}

export interface TaskStateDecoded {
  /** 契约用的状态 */
  state: TaskState;
  /** `/proc` 会显示的状态字符 */
  char: string;
  /** 人类说明 */
  label: string;
  /** `__task_struct.__state` 的原始值 */
  rawState: number;
  /** `exit_state` 的原始值 */
  rawExitState: number;
  /** 内核 `__task_state_index()` 的返回值（0–8） */
  index: number;
  /** 中间量：`(state|exit_state) & TASK_REPORT` 之后、特殊态覆盖之前的值 */
  masked: number;
}

/** 按内核顺序计算 masked，再根据原始 state 覆盖 TASK_IDLE 和 RTLOCK/FROZEN 状态。 */
export function decodeTaskState(rawState: number, exitState: number): TaskStateDecoded {
  const raw = rawState >>> 0;
  const exit = exitState >>> 0;
  let masked = (raw | exit) & TASK_REPORT;
  if ((raw & TASK_IDLE) === TASK_IDLE) masked = TASK_REPORT_IDLE;
  if ((raw & (TASK_BITS.RTLOCK_WAIT | TASK_BITS.FROZEN)) !== 0) masked = TASK_BITS.UNINTERRUPTIBLE;
  const index = fls(masked);
  const char = STATE_CHARS[index] ?? '?';
  const detail = STATE_DETAIL[char] ?? { state: 'unknown' as TaskState, label: `未识别的状态位 0x${masked.toString(16)}` };
  return {
    state: detail.state,
    char,
    label: detail.label,
    rawState: raw,
    rawExitState: exit,
    index,
    masked,
  };
}

/** 把状态位拆成人类可读的位名清单，用于"这个状态是怎么来的"的展开说明。 */
export function describeStateBits(rawState: number): string[] {
  const raw = rawState >>> 0;
  const names: string[] = [];
  for (const [name, bit] of Object.entries(TASK_BITS)) {
    if (bit === 0 || (raw & bit) === 0) continue;
    if (name === 'STATE_MAX') continue;
    names.push(name.replace(/^__/, ''));
  }
  if (names.length === 0) return ['（无状态位：0x0 就是 TASK_RUNNING）'];
  return names;
}
