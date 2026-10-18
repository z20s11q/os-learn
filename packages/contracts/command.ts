/** 控制命令进入单会话串行队列，requestId 命中时返回既有结果。
 * 参数按白名单校验，epoch 和 expectedFrameId 用于拒绝迟到及过期请求。
 */

import type { Base64, Hex } from './common.ts';

/** 所有命令共有的信封。 */
export interface CommandEnvelope {
  requestId: string;
  /** 会话 epoch，重启后变化 */
  epoch: number;
  /** 前端认为的最新帧；与最新帧不符时服务返回 frame-mismatch */
  expectedFrameId: number;
}

export type BreakpointKind = 'software' | 'hardware' | 'watch-write' | 'watch-read';

/** 断点位置：符号 + 可选偏移，或直接给出线性地址。 */
export interface BreakpointLocation {
  /** 符号名，例如 start_kernel；与 address 二选一 */
  symbol?: string;
  /** 限定符号所属阶段。startup_64 在解压器和主内核同名，模块缺失时返回歧义错误。 */
  module?: string;
  /** 线性地址 */
  address?: Hex;
  /** 符号内偏移字节 */
  offset?: number;
}

export interface StepCommand extends CommandEnvelope {
  type: 'step';
  /** 指令级单步 */
  granularity: 'instruction' | 'source-into' | 'source-over';
  /** 单步次数，默认 1 */
  count?: number;
}

export interface ContinueCommand extends CommandEnvelope {
  type: 'continue';
}

export interface PauseCommand extends CommandEnvelope {
  type: 'pause';
}

export interface StopCommand extends CommandEnvelope {
  type: 'stop';
  /** 是否同时销毁会话进程 */
  teardown?: boolean;
}

export interface BreakpointInsertCommand extends CommandEnvelope {
  type: 'breakpoint.insert';
  kind: BreakpointKind;
  location: BreakpointLocation;
}

export interface BreakpointRemoveCommand extends CommandEnvelope {
  type: 'breakpoint.remove';
  breakpointId: number;
}

export interface RunToCommand extends CommandEnvelope {
  type: 'run-to';
  location: BreakpointLocation;
  /** 超时毫秒；超时后服务请求停止并返回 command-timeout */
  timeoutMs?: number;
}

/** 客体终端输入。历史模式下服务拒绝该命令。 */
export interface TerminalInputCommand extends CommandEnvelope {
  type: 'terminal.input';
  /** 目标终端：串口或 VGA/PS2 */
  device: 'serial' | 'vga';
  /** 文本输入 */
  text?: string;
  /** 原始字节（base64），用于发送控制字符 */
  bytes?: Base64;
}

/** PS/2 键盘事件注入，支持按下/抬起。 */
export interface KeyboardCommand extends CommandEnvelope {
  type: 'keyboard';
  /** key-down 或 key-up；失焦时前端必须发送 key-up */
  action: 'down' | 'up' | 'press';
  /** 键码，Linux input 事件码或 QKeyCode 名称 */
  key: string;
  modifiers?: string[];
}

/** 按需读取内存。当前帧可从有效 capture 补充；历史帧只能读存档。 */
export interface MemoryReadCommand extends CommandEnvelope {
  type: 'memory.read';
  addressSpace: 'physical' | 'linear';
  address: Hex;
  length: number;
}

/** 自动校准并运行启动阶段（T10a）：装载 setup/解压器符号、停在各自入口。 */
export interface BootCalibrateCommand extends CommandEnvelope {
  type: 'boot.calibrate';
  /** 每段等待停止的超时；默认 120 秒 */
  timeoutMs?: number;
}

/** 按实测装载地址加载启动阶段符号。 */
export interface StageLoadCommand extends CommandEnvelope {
  type: 'stage.load';
  module: 'linux-setup' | 'linux-decompressor';
  /** 该阶段镜像的装载地址（hex） */
  address: Hex;
}

/** 切换视图到历史帧或返回最新位置。 */
export interface ViewCommand extends CommandEnvelope {
  type: 'view';
  mode: 'live' | 'recorded';
  targetFrameId?: number;
}

export type CommandRequest =
  | StepCommand
  | ContinueCommand
  | PauseCommand
  | StopCommand
  | BreakpointInsertCommand
  | BreakpointRemoveCommand
  | RunToCommand
  | TerminalInputCommand
  | KeyboardCommand
  | MemoryReadCommand
  | StageLoadCommand
  | BootCalibrateCommand
  | ViewCommand;

export type CommandType = CommandRequest['type'];

/** 命令受理结果。幂等时返回相同 requestId 与既有结果。 */
export interface CommandAccepted {
  type: 'command.accepted';
  requestId: string;
  /** 是否命中幂等缓存并返回既有结果 */
  duplicate: boolean;
  /** 若命令直接产生结果，例如内存读取 */
  result?: unknown;
}

/** 命令执行失败。 */
export interface CommandFailed {
  type: 'command.failed';
  requestId: string;
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export const COMMAND_TYPES: readonly CommandType[] = [
  'step',
  'continue',
  'pause',
  'stop',
  'breakpoint.insert',
  'breakpoint.remove',
  'run-to',
  'terminal.input',
  'keyboard',
  'memory.read',
  'stage.load',
  'boot.calibrate',
  'view',
] as const;

/** 命令白名单校验用。 */
export function isCommandType(value: unknown): value is CommandType {
  return typeof value === 'string' && (COMMAND_TYPES as readonly string[]).includes(value);
}

/**
 * 需要客体正在运行的命令。历史模式与 VM 已退出时都要拒绝，
 * 否则回看过程中的误操作会作用到当前 VM。
 */
export const EXECUTION_COMMANDS: readonly CommandType[] = [
  'step',
  'continue',
  'pause',
  'stop',
  'breakpoint.insert',
  'breakpoint.remove',
  'run-to',
  'keyboard',
  'terminal.input',
] as const;
