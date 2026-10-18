/**
 * 录制包格式（manifest + 索引 + 分块）。
 *
 * 依据总体方案 9.2：录制包包含 manifest.json、帧索引、事件分块、
 * RAM 起点/增量、磁盘逻辑版本、输入与终端输出、源码/符号清单及课程版本。
 * 每个文件有校验散列。快照中的客体数据随历史帧切换，
 * 历史帧不能再读取当前 VM 的新值填补缺项。
 */

import type { Sha256 } from './common.ts';

export const RECORDING_SCHEMA_VERSION = 1 as const;

/** 录制包内的单个文件条目。 */
export interface RecordingFileEntry {
  /** 包内相对路径，例如 frames/0000000001.json */
  path: string;
  sha256: Sha256;
  /** 字节长度 */
  length: number;
  /** 允许的用途，导入时按此限制访问范围 */
  role:
    | 'frame'
    | 'event-chunk'
    | 'ram-base'
    | 'ram-delta'
    | 'disk-version'
    | 'terminal-output'
    | 'input'
    | 'source-manifest'
    | 'lesson'
    | 'blob'
    | 'other';
  /** 该文件属于哪个 frameId（若适用） */
  frameId?: number;
}

/** 帧索引：每帧在包内的偏移与类型，用于随机定位。 */
export interface FrameIndexEntry {
  frameId: number;
  parentFrameId: number | null;
  epoch: number;
  /** 是否为数据检查点，回放时从这里开始重建再应用增量 */
  checkpoint: boolean;
  /** 该帧承载帧数据与事件的包内路径 */
  framePath: string;
  eventChunkPath: string | null;
  /** 该帧相对检查点的增量路径 */
  deltaPaths: string[];
  committedAt: string;
}

/** 数据检查点间隔，初值 100 帧，按大小调整。 */
export interface CheckpointPolicy {
  everyNFrames: number;
  /** 每会话存储硬上限，字节；达到时受控停止记录 */
  quotaBytes: number;
  /** 达到配额时的行为 */
  onQuotaExceeded: 'stop-recording' | 'degrade';
}

export interface ArtifactManifest {
  /** 产物清单散列，会话创建时用于确认镜像/符号版本匹配 */
  hash: Sha256;
  entries: Array<{
    name: string;
    path: string;
    sha256: Sha256;
    /** 是否允许被 /api/artifacts/:hash/source 读取源码 */
    sourceReadable: boolean;
  }>;
}

export interface RecordingManifest {
  schema: typeof RECORDING_SCHEMA_VERSION;
  recordingId: string;
  sessionId: string;
  profileId: string;
  /** 起始 epoch；同一包的 epoch 必须一致 */
  epoch: number;
  createdAt: string;
  closedAt: string | null;
  /** 产物清单，决定了可读源码与镜像范围 */
  artifactManifest: ArtifactManifest;
  /** 会话启动参数（argv），用于复现 */
  launchArgv: string[];
  /** QEMU 版本与观察扩展协议版本 */
  qemuVersion: string;
  observerProtocolVersion: number;
  /** 内核与符号版本 */
  kernelRelease: string;
  vmlinuxSha256: Sha256;
  /** 课程版本 */
  curriculumVersion: string;
  files: RecordingFileEntry[];
  frames: FrameIndexEntry[];
  checkpointPolicy: CheckpointPolicy;
  /** 实际占用字节数，用于配额判断 */
  bytesUsed: number;
  /** 是否因配额被截断，前端必须显式提示 */
  truncatedByQuota: boolean;
  /** 导入时必须通过散列校验的清单散列 */
  manifestSha256: Sha256;
}

export interface RecordingVerification {
  manifestOk: boolean;
  /** 校验失败的文件路径与原因 */
  failures: Array<{ path: string; expected: Sha256; actual: Sha256 | null; reason: string }>;
  /** schema 版本是否兼容当前代码 */
  schemaCompatible: boolean;
  /** 缺失的帧 ID，导入后必须显示为未记录 */
  missingFrames: number[];
  /** 导入的数据一律按数据对待，禁止执行其中的脚本 */
  scriptsExecuted: false;
}

/** 帧清单/分块的传输结构：首次可整帧传 JSON，数据增大后用散列引用。 */
export interface FrameBundle {
  framePath: string;
  frameSha256: Sha256;
  /** 内联内容，或 null 表示需要按 blob 拉取 */
  inline: unknown | null;
  blobs: Array<{ name: string; sha256: Sha256; length: number }>;
}
