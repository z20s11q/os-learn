/** 通用类型：地址与大计数用字符串，字节用 base64，小端数值由解码层解释。
 * 可读字段分别表达 ok、unavailable、uninitialized、not-collected 和 partial 状态。
 */

/** 十六进制字面量，统一 `0x` 前缀，小写数字。 */
export type Hex = `0x${string}`;

/** 十进制整数，用字符串承载，防止超过 Number.MAX_SAFE_INTEGER。 */
export type Decimal = string;

/** base64 编码的原始字节。 */
export type Base64 = string;

/** sha256 十六进制摘要（小写，64 字符）。 */
export type Sha256 = string;

/** 事件全局序号，十进制字符串。 */
export type Seq = string;

export type EvidenceKind =
  /** 直接从设备/内存/寄存器读到的原始字节 */
  | 'observed'
  /** 由原始字节按已知结构解析得到，例如反汇编、页表项、ext2 inode */
  | 'decoded'
  /** 教学解说文字，必须引用同帧已有字段 */
  | 'explanation'
  /** 本次采集缺口及其原因 */
  | 'unavailable';

/**
 * 事实引用。任何进入 Frame 的值都应能追溯到一个 EvidenceRef，
 * 面板上点击数值可以显示它的来源。
 */
export interface EvidenceRef {
  kind: EvidenceKind;
  /** gdb / observer / memory / disk / lesson / ext2 等 */
  source: string;
  captureId?: string;
  /** 原始事件 ID、字节范围 ID、或是产物清单里的路径 */
  refs: string[];
  reason?: string;
}

/** 字段采信状态，ok 表示有效值，其余状态说明能力、初始化或覆盖缺口。 */
export type FieldStatus =
  /** 取到有效值 */
  | 'ok'
  /** 构建或平台能力缺口及原因 */
  | 'unavailable'
  /** 硬件或内核结构在该停止时刻尚未初始化，例如 CR3 仍为 0 */
  | 'uninitialized'
  /** 能力存在，本次覆盖范围为所选子集 */
  | 'not-collected'
  /** 解析进行中或已中断，附部分值和缺口说明 */
  | 'partial';

export interface FieldOk<T> {
  status: 'ok';
  value: T;
}

export interface FieldMissing {
  status: Exclude<FieldStatus, 'ok'>;
  /** 展示给用户的原因，要求非空字符串 */
  reason: string;
}

export type Field<T> = FieldOk<T> | FieldMissing;

/** 便于构造缺失字段。 */
export function missing(
  status: Exclude<FieldStatus, 'ok'>,
  reason: string,
): FieldMissing {
  if (!reason) throw new Error('FieldMissing.reason 不能为空');
  return { status, reason };
}

/** 便于构造有效字段。 */
export function ok<T>(value: T): FieldOk<T> {
  return { status: 'ok', value };
}

/** 所有采集对象共同携带的归属信息。 */
export interface CaptureAttribution {
  sessionId: string;
  /** 重启后递增，服务按 epoch 拒绝迟到响应 */
  epoch: number;
  frameId: number;
  captureId: string;
}

/** 本次实际采集覆盖范围，供界面展示 */
export interface CoverageReport {
  /** selected-pages：只采了可见页/页表/栈；full-ram-delta：有全量 RAM 基线并记脏页 */
  memory: 'selected-pages' | 'full-ram-delta';
  /** complete：区间完整；filtered：按规则过滤；lost：存在序号缺口 */
  events: 'complete' | 'filtered' | 'lost';
  /** 本次采集缺口的字段名列表，供面板显示覆盖提示 */
  unavailable: string[];
}

const HEX_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && HEX_RE.test(value);
}

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === 'string' && DECIMAL_RE.test(value);
}

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/** 把 bigint 转成协议用的小写十六进制字符串。 */
export function toHex(value: bigint): Hex {
  if (value < 0n) throw new Error('地址不能为负');
  return `0x${value.toString(16)}`;
}

/** 从协议字符串恢复 bigint，用于比较与运算。 */
export function fromHex(value: Hex): bigint {
  return BigInt(value);
}

/**
 * 地址往返无损检查。0x 前缀 + 十进制字符串是唯一合法表示，
 * 前导零、大写数字、空字符串都要被拒绝。
 */
export function canonicalHex(value: string): Hex {
  const parsed = BigInt(value);
  const canonical = toHex(parsed);
  if (canonical !== value) {
    throw new Error(`非规范十六进制表示: ${value}`);
  }
  return canonical;
}
