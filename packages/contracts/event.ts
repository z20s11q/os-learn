/** 事件来自真实执行点，以 seq、CPU/设备/requestId 和可选 instructionId 关联。
 * 异步事件缺可靠 PC 时留空；TCG begin 表示尝试执行，retire 单独表示完成。
 * 异常、rep 指令和分拆访存保留原始粒度。
 */

import type { Base64, CaptureAttribution, EvidenceRef, Hex, Seq } from './common.ts';

/** 字符串事件类别，支持观察扩展增加新类型。 */
export type MachineEventKind =
  /** 即将尝试执行一条指令 */
  | 'instruction.begin'
  /** 指令成功退休 */
  | 'instruction.retire'
  /** CPU 访存 */
  | 'memory.read'
  | 'memory.write'
  /** 设备 DMA */
  | 'dma.read'
  | 'dma.write'
  /** 端口 I/O */
  | 'io.read'
  | 'io.write'
  /** 中断线电平变化 */
  | 'irq.raise'
  | 'irq.lower'
  /** 中断被 CPU 接受 */
  | 'interrupt.accept'
  /** 块请求生命周期 */
  | 'block.submit'
  | 'block.complete'
  /** 输入设备产生一次按键/鼠标事件并被读取 */
  | 'input.accept'
  /** 串口输出一个字节 */
  | 'serial.output'
  /** 观察屏障本身，标记事件区间右端 */
  | 'capture.fence'
  /** 发生了一次访存/端口异常 */
  | 'exception.raise'
  /** 观察扩展自身丢事件 */
  | 'observer.drop';

export type EventPhase = 'begin' | 'complete' | 'raise' | 'lower' | 'fence';

/** bytes 的字节序，供解码层转换为数值。 */
export type ByteOrder = 'little' | 'big';

export interface MachineEvent {
  /** 十进制字符串，全局递增，跨 capture 连续（丢失时用 observer.drop 标记） */
  seq: Seq;
  kind: MachineEventKind;
  cpuId?: number;
  /** 关联到某条指令的事件，便于把访存归到指令 */
  instructionId?: string;
  deviceId?: string;
  requestId?: string;
  /** 线性 PC；异步事件的可靠 PC 缺失时留空 */
  pc?: Hex;
  addressSpace?: 'physical' | 'linear' | 'io-port' | 'disk-lba';
  address?: Hex;
  /** 访问宽度，字节 */
  size?: number;
  /** 原始字节，base64，按 byteOrder 解码 */
  bytes?: Base64;
  byteOrder?: ByteOrder;
  phase: EventPhase;
  /** 与该事件直接对应的证据 */
  evidence?: EvidenceRef;
}

/** 一批按水位线截取的事件。 */
export interface MachineEventChunk {
  attribution: CaptureAttribution;
  /** 该 capture 的事件水位线：本 chunk 最大 seq 不超过它 */
  watermark: Seq;
  events: MachineEvent[];
  /** 这一批是否因为过滤/分页被截断 */
  truncated: boolean;
  /** 区间内已知丢失的事件数 */
  dropped: number;
}

/** 事件区间引用，对应 Frame.eventRange。 */
export interface EventRange {
  first: Seq | null;
  last: Seq | null;
}

/** 按 seq 范围请求事件分页。 */
export interface EventQuery {
  epoch: number;
  /** 起始 seq，含 */
  from: Seq;
  /** 结束 seq，含；省略时取 watermark */
  to?: Seq;
  limit?: number;
}
