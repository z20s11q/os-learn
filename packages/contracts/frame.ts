/** Frame 表达一次采集完成的停止状态；时间线分别记录执行前 PC、停止 PC 和原因。 */

import type {
  CaptureAttribution,
  CoverageReport,
  EvidenceRef,
  Hex,
} from './common.ts';
import type { CpuSnapshot } from './cpu.ts';
import type { DeviceSnapshot } from './device.ts';
import type { EventRange } from './event.ts';
import type { MemoryPageRef } from './memory.ts';
import type { LessonMatch, OsSnapshot, SourceLocation } from './os.ts';

/** 停止原因。取值来自 GDB 停止通知与 QMP 运行状态的交叉核对。 */
export type StopReason =
  /** 断点命中 */
  | 'breakpoint'
  /** 单步完成 */
  | 'step'
  /** 用户请求暂停 */
  | 'pause'
  /** 复位后停在第一条固件指令 */
  | 'reset'
  /** 客体关机/退出 */
  | 'exited'
  /** 收到信号（例如 Ctrl-C） */
  | 'signal'
  /** 未知或解析失败，必须保留原始文本 */
  | 'unknown';

export interface StopInfo {
  reason: StopReason;
  /** 原始停止通知文本，未知原因时用于排查 */
  rawReason?: string;
  /** 本次停止位置的 PC */
  pc: Hex | null;
  cpuId: number;
  /** 命中的断点编号，reason=breakpoint 时给出 */
  breakpointId?: number;
  /** 单步前 PC，用于时间线显示「执行前地址」 */
  previousPc?: Hex | null;
  /** 命中的 watchpoint 地址 */
  watchAddress?: Hex;
}

/** 录制覆盖为必填项，回放据此展示实际记录区间与缺口。 */
export interface RecordingCoverage {
  /** 本帧之前是否有清晰的起点/检查点，决定能否重建画面 */
  reconstructible: boolean;
  /** 最近的数据检查点 frameId */
  checkpointFrameId: number;
  /** 未记录指令区间说明 */
  instructionGaps: Array<{ fromFrameId: number; toFrameId: number; note: string }>;
  /** 未记录内存范围 */
  memoryGaps: string[];
  /** 事件是否完整 */
  events: 'complete' | 'filtered' | 'lost';
  note?: string;
}

/** 待完成块请求：状态字节回写客体时移出台账，hostIoDone 单独表示宿主回调状态。 */
export interface PendingBlockRequest {
  /** 设备名（与 dma.* / block.* 事件同一写法） */
  deviceId: string;
  /** 观察层设备注册表里的数字 id */
  deviceIndex: number;
  /** vq<队列索引>-<描述符>；只在同一设备内唯一，跨设备会重复 */
  requestId: string;
  /** (队列索引 << 32) | 描述符 的打包值原样，零值合法 */
  requestIdRaw: Hex;
  lba: Hex;
  byteOffset: Hex;
  length: number;
  reqType: number;
  op: 'read' | 'write';
  outSeg: number;
  inSeg: number;
  /** 宿主块层完成回调是否已经进入 */
  hostIoDone: boolean;
  /** hostIoDone=false → host-io-pending；true → host-io-done-awaiting-visibility */
  state: 'host-io-pending' | 'host-io-done-awaiting-visibility';
  /** 登记水位线；0 表示对应事件记录缺失 */
  submitSeq: Hex;
  hostDoneSeq: Hex;
}

/** T05e：某一刻的待完成块请求台账快照（随 capture 一起冻结）。 */
export interface PendingIoSnapshot {
  pendingCriterion: string;
  count: number;
  hostIoDoneCount: number;
  ledgerCapacity: number;
  ledgerOverflow: Hex;
  resubmitCount: Hex;
  notes: string[];
  blockRequests: PendingBlockRequest[];
}

/** 帧分界说明；fenceSeq=0 表示 fence 记录缺失 */
export interface FrameBoundary {
  rule: string;
  fenceRecorded: boolean;
  fenceSeq: Hex;
  pendingBlockRequests: number;
  pendingHostIoDone: number;
  serializationPoint: string;
  captureDoesNot: string;
}

export interface Frame {
  schemaVersion: 1;
  sessionId: string;
  /** 重启后递增，服务按 epoch 拒绝迟到响应 */
  epoch: number;
  frameId: number;
  parentFrameId: number | null;
  /** 触发本帧的请求 ID，便于幂等与追溯 */
  requestId: string;
  captureId: string;
  executionMode: 'live' | 'recorded';
  stop: StopInfo;
  /** 本帧的服务编排记录区间（session.events，GET /events?source=service）。
 * 客体环使用独立序号域，客体事件归属由 eventWatermark 和 frameBoundary 表达。
 */
  eventRange: EventRange;
  /**
   * T05e：本帧的帧分界标记（观察者 x-oslab-capture.fenceSeq）。
   * 「seq <= eventWatermark」与「属于本帧」严格等价，采集关闭或该 kind 被
   * 记录期掩码排除时为 null（此时 frameBoundary.fenceRecorded 为 false）。
   */
  fenceSeq?: Hex | null;
  /** T05e：本帧的事件水位线；有 fence 时就等于 fenceSeq */
  eventWatermark?: Hex | null;
  /** T05e：帧分界说明与同一瞬间的 pending 计数 */
  frameBoundary?: FrameBoundary | null;
  /** T05e：这一刻仍未对客体可见的块请求台账 */
  pendingIo?: PendingIoSnapshot | null;
  coverage: CoverageReport;
  cpu: CpuSnapshot;
  memory: MemoryPageRef[];
  devices: DeviceSnapshot[];
  /** 键为 diskId，值为逻辑版本 ID */
  diskVersions: Record<string, string>;
  os: OsSnapshot | null;
  source: SourceLocation | null;
  lesson: LessonMatch | null;
  /** 字段名 → 证据引用；面板点击数值时展示 */
  evidence: Record<string, EvidenceRef>;
  /** 录制覆盖信息（历史模式必填） */
  recording: RecordingCoverage;
  /** 采集完成时间，ISO 8601 */
  committedAt: string;
}

/** 帧清单：大数据时用散列引用替代内联内容。 */
export interface FrameManifest {
  attribution: CaptureAttribution;
  frameId: number;
  /** 内联帧内容；null 表示通过 blob 引用传输 */
  inline: Frame | null;
  /** 分块二进制引用：路径或散列 + 长度 */
  blobs: Array<{ name: string; sha256: string; length: number }>;
  /** 本帧在录制包中的偏移，便于随机定位 */
  indexOffset: number;
}

/** 帧提交通知。前端收到后一次性替换 activeFrame。 */
export interface FrameCommitted {
  type: 'frame.committed';
  attribution: CaptureAttribution;
  /** liveFrameId：最新实时帧；viewFrameId：当前视图帧 */
  liveFrameId: number;
  viewFrameId: number;
  /** 事件是否可能被过滤，前端据此显示覆盖提示 */
  eventsFiltered: boolean;
}

/** 回看/实时模式切换状态。 */
export interface ViewMode {
  mode: 'live' | 'recorded';
  liveFrameId: number;
  viewFrameId: number;
  /** 进入回看前是否已暂停；历史模式禁用客体输入与执行控制 */
  pausedBeforeHistory: boolean;
}
