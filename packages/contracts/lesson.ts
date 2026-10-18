/** 课程定义：trigger 解析失败时禁用并说明原因；explain 引用同帧字段，checks 展示状态差异。 */

import type { Hex } from './common.ts';

export interface LessonTrigger {
  /** 所属模块：seabios/grub/linux-setup/decompressor/kernel/user-elf */
  module: string;
  /** 符号名；解析失败时禁用该课 */
  symbol?: string;
  /** 符号内偏移字节，用于对齐到具体指令 */
  offset?: number;
  /** 直接给出线性地址（与 symbol 二选一） */
  address?: Hex;
  /** 前置状态，例如 cr0.PG=0、当前进程 comm */
  preconditions?: Array<{ field: string; equals: string }>;
}

export interface LessonExecution {
  /** 运行到的边界：单步 N 次、运行到符号、运行到下一个断点 */
  runTo: 'next-instruction' | 'symbol' | 'breakpoint' | 'time-budget';
  /** 目标符号或地址 */
  target?: string;
  /** 允许的中断策略 */
  interruptPolicy: 'allow' | 'defer' | 'disable';
  /** 预算：最多执行多少条指令或多少毫秒 */
  budgetInstructions?: number;
  budgetMs?: number;
}

export interface LessonObserve {
  /** 要读取的实现寄存器名列表 */
  registers: string[];
  /** 要读取的内存对象：表达式 + 地址空间 */
  memory: Array<{ name: string; addressSpace: 'physical' | 'linear'; address: Hex; length: number }>;
  /** 要读取的设备字段：deviceId → 字段名 */
  devices: Array<{ deviceId: string; fields: string[] }>;
  /** complete 要求覆盖齐全；覆盖缺口导致检查失败 */
  coverage: 'complete' | 'best-effort';
}

export interface LessonFocus {
  /** 联动选中的 CPU 字段 */
  cpuFields: string[];
  /** 联动选中的地址 */
  addresses: Hex[];
  /** 联动选中的源码位置 */
  source?: { module: string; symbol: string };
  /** 联动选中的设备 */
  deviceId?: string;
}

export interface LessonExplain {
  /** 本步目的 */
  purpose: string;
  /** 函数输入输出 */
  io: string;
  /** 关键指令含义，键为指令文本，值为解释 */
  instructions: Record<string, string>;
  /** 相关原理 */
  concepts: string[];
  /** 引用字段：模板中的占位符只能来自这些 Frame 字段名 */
  fieldRefs: string[];
}

export interface LessonCheck {
  /** 后置条件描述 */
  description: string;
  /** 判定表达式：字段名 + 期望值 */
  expect: Array<{ field: string; equals: string }>;
}

export interface LessonQuestion {
  prompt: string;
  /** 展开后展示的证据引用 */
  evidenceRefs: string[];
}

export interface Lesson {
  id: string;
  /** 限定课程适用的 profile */
  profileId: string;
  /** 限定架构与适配产物 */
  artifactConstraints: { arch: string; kernelRelease?: string; artifactHash?: string };
  title: string;
  /** 阶段：boot/terminal/process/memory/file */
  stage: string;
  trigger: LessonTrigger;
  execution: LessonExecution;
  observe: LessonObserve;
  focus: LessonFocus;
  explain: LessonExplain;
  checks: LessonCheck[];
  questions: LessonQuestion[];
  /** 使用的检查点/证据路径 */
  evidence: string[];
}

/** 课程匹配失败的原因，用于在界面上禁用该课。 */
export interface LessonUnavailable {
  lessonId: string;
  reason: string;
}
