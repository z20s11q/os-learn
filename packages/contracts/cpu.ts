/** CPU 快照：单步、断点和通用寄存器来自 GDB/MI，段缓存及控制状态来自观察接口。
 * 寄存器名称与编号依据目标描述发现。
 */

import type { Hex } from './common.ts';

/** 执行模式，决定后续按哪种分段/分页规则解析地址。 */
export type CpuExecutionMode =
  /** 实模式，CS:IP 线性拼接 */
  | 'real-16'
  /** 保护模式 16 位代码段 */
  | 'protected-16'
  /** 保护模式 32 位 */
  | 'protected-32'
  /** 长模式 64 位 */
  | 'long-64'
  | 'unknown';

/** 段寄存器：选择子、隐藏基址、限长和属性（含 DPL 与粒度位）。 */
export interface SegmentRegister {
  selector: Hex;
  base: Hex;
  limit: Hex;
  /** 原始属性字，例如 0x9b00 表示 16 位代码段 DPL0 已访问 */
  attributes: Hex;
  /** 真实模式下段缓存未加载时为 false */
  usable: boolean;
}

export interface RegisterValue {
  name: string;
  /** 位宽，例如 rax=64、eax=32；显示时据此截断 */
  width: number;
  value: Hex;
}

/** Supplementary registers read inside one stopped VM interval. */
export interface ExtendedRegisterValue {
  name: string;
  width: number;
  /** Fixed-width hex bit pattern. Strings preserve binary80 and 128-bit vectors. */
  value: string | null;
  raw: string | null;
  source: string | null;
  captureId: string;
  encoding?: string;
  reason?: string;
}

export interface ExtendedCpuSnapshot {
  schema: 'oslab.cpu.extended/1';
  captureId: string;
  observerCaptureId: string | null;
  cpuId: number;
  barrier: 'vm-stopped-before-and-after-read' | 'unverified';
  registers: ExtendedRegisterValue[];
  rawQmpRegisters: string | null;
  errors: string[];
  note: string;
}

export interface ControlRegisters {
  cr0: Hex | null;
  cr2: Hex | null;
  cr3: Hex | null;
  cr4: Hex | null;
  cr8: Hex | null;
}

/** 当前 PC 处的指令，来自实际内存字节的反汇编。 */
export interface InstructionView {
  /** 指令首字节的线性地址 */
  address: Hex | null;
  /** 原始指令字节，十六进制连续字符串 */
  bytes: Hex | null;
  /** 反汇编文本，例如 `endbr64` */
  text: string | null;
  /** 长度，字节 */
  length: number | null;
  /** 指令证据为 decoded；原始内存字节缺失时为 unavailable。 */
  evidence: 'decoded' | 'unavailable';
}

export interface CpuSnapshot {
  cpuId: number;
  mode: CpuExecutionMode;
  modeDetail?: string;
  /** 当前特权级 CPL */
  cpl: number;
  /** 本次停止位置的 PC */
  rip: Hex | null;
  rsp: Hex | null;
  /** 通用寄存器，按名字发现而非固定顺序 */
  general: RegisterValue[];
  extended?: ExtendedCpuSnapshot;
  /** 段寄存器，键为 cs/ss/ds/es/fs/gs */
  segments: Record<string, SegmentRegister>;
  control: ControlRegisters;
  /** 扩展功能寄存器，长模式标志 LMA/LME、NXE 等从这里读 */
  efer: Hex | null;
  eflags: Hex | null;
  /** CPU 处于 HLT 状态 */
  halted: boolean;
  /** 当前 PC 处的指令视图 */
  instruction: InstructionView;
  /**
   * 该快照的采信说明。段缓存/控制寄存器必须以 `observed` 或 `decoded`
   * 进入，模型不得凭模式推测值。
   */
  evidence: string;
}
