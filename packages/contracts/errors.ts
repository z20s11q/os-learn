/** 机器可读的协议错误码与载荷，覆盖幂等、新鲜度、序号、分块、散列和能力校验。 */

export const ErrorCode = {
  /** 请求参数不合法（白名单之外、类型错误） */
  INVALID_REQUEST: 'invalid-request',
  /** 会话不存在或已关闭 */
  SESSION_NOT_FOUND: 'session-not-found',
  /** 迟到 epoch 消息，服务丢弃并记录诊断 */
  STALE_EPOCH: 'stale-epoch',
  /** expectedFrameId 与当前最新帧不符，说明前端视图过期 */
  FRAME_MISMATCH: 'frame-mismatch',
  /** 同 requestId 命中幂等缓存，返回既有结果 */
  DUPLICATE_REQUEST: 'duplicate-request',
  /** 上一个控制命令尚未完成，命令队列拒绝并发 */
  CONTROL_BUSY: 'control-busy',
  /** 命令超时；已经请求停止，需要用户重新决定下一步 */
  COMMAND_TIMEOUT: 'command-timeout',
  /** 目标（寄存器/地址/符号）不存在 */
  TARGET_UNAVAILABLE: 'target-unavailable',
  /** 能力缺失，例如请求的事件类别当前构建不支持 */
  CAPABILITY_MISSING: 'capability-missing',
  /** 事件序号出现缺口 */
  SEQUENCE_GAP: 'sequence-gap',
  /** 二进制分块不完整或块序号越界 */
  CHUNK_INVALID: 'chunk-invalid',
  /** 校验散列不匹配 */
  CHECKSUM_MISMATCH: 'checksum-mismatch',
  /** 读取的内存范围不在本次 capture 的允许区域内 */
  RANGE_NOT_CAPTURED: 'range-not-captured',
  /** 试图读取有副作用的 MMIO */
  MMIO_SIDE_EFFECT: 'mmio-side-effect',
  /** 历史模式不允许执行控制或客体输入 */
  HISTORY_READ_ONLY: 'history-read-only',
  /** 空间配额耗尽，受控停止记录 */
  QUOTA_EXCEEDED: 'quota-exceeded',
  /** 服务内部错误 */
  INTERNAL: 'internal',
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ProtocolErrorBody {
  error: {
    code: ErrorCodeName;
    message: string;
    /** 可选的结构化补充，例如缺口区间、期望与实际 frameId */
    detail?: Record<string, unknown>;
  };
}

/** 序号缺口描述，用于 `sequence-gap` 与诊断帧。 */
export interface SequenceGap {
  /** 缺口前最后一个已知 seq */
  after: string;
  /** 缺口后第一个已知 seq */
  before: string;
  /** 缺失条数下界，无法精确时给下界并标记近似 */
  missingAtLeast: number;
  approximate: boolean;
}

/** 迟到消息丢弃的服务诊断记录。 */
export interface DroppedMessage {
  reason: 'stale-epoch' | 'frame-mismatch' | 'duplicate-request';
  requestId?: string;
  epoch: number;
  frameId: number;
  at: string;
}

export function protocolError(
  code: ErrorCodeName,
  message: string,
  detail?: Record<string, unknown>,
): ProtocolErrorBody {
  return { error: { code, message, ...(detail ? { detail } : {}) } };
}
