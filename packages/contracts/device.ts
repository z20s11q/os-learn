/** 设备与磁盘快照：设备字段来自只读结构快照，磁盘由基线与逻辑扇区版本表达。
 * 待完成写入单独记录为 pending。
 */

import type { Base64, EvidenceRef, Field, Hex, Sha256 } from './common.ts';

export type DeviceKind =
  | 'vga'
  | 'i8042'
  | 'uart'
  | 'pic'
  | 'apic'
  | 'timer'
  | 'virtio-blk'
  | 'virtio-net'
  | 'pci'
  | 'other';

/** 设备快照中的单个字段，允许缺失。 */
export interface DeviceField {
  /** 寄存器/域的名字，例如 status、irq、lba */
  name: string;
  /** 原始值，十六进制或十进制字符串 */
  value: string;
  /** 值的人类可读解释，例如 "DRDY set" */
  meaning?: string;
  /** 位宽 */
  width?: number;
}

export interface DeviceSnapshot {
  deviceId: string;
  kind: DeviceKind;
  /** 该快照是否保证无副作用 */
  readOnly: boolean;
  /** PCI 位置 (bus:device.function)，非 PCI 设备可空 */
  pciAddress?: string;
  fields: DeviceField[];
  /** virtio 队列状态 */
  virtqueues?: VirtqueueSnapshot[];
  /** 该快照涉及的寄存器/MMIO 范围 */
  registerRanges?: Array<{ address: Hex; length: number }>;
  /** 采集说明：观察点、锁上下文 */
  evidence: EvidenceRef;
}

/** 队列描述符。 */
export interface VirtqueueDescriptor {
  index: number;
  /** 描述符表项地址（客体物理地址） */
  address: Hex;
  length: number;
  flags: number;
  /** 读/写方向，按 flags 中的 VIRTQ_DESC_F_WRITE 解释 */
  direction: 'device-read' | 'device-write';
  next: number | null;
  /** 该描述符指向的缓冲首字节，已采集时给出 */
  bytesRef: Sha256 | null;
}

export interface VirtqueueSnapshot {
  queueIndex: number;
  /** 队列大小（协商结果，非默认值） */
  size: number;
  ready: boolean;
  /** 已协商 feature 位 */
  negotiatedFeatures: Hex;
  descTable: Hex | null;
  availRing: Hex | null;
  usedRing: Hex | null;
  lastAvailIndex: number | null;
  lastUsedIndex: number | null;
  descriptors?: VirtqueueDescriptor[];
  /** 队列快照的只读采信说明 */
  evidence: EvidenceRef;
}

/** 块请求生命周期。 */
export interface BlockRequest {
  /** 观察扩展分配的请求 ID，用于关联 submit/complete 与 virtqueue 描述符 */
  requestId: string;
  deviceId: string;
  /** 起始逻辑块地址 */
  lba: Hex;
  /** 扇区数 */
  count: number;
  operation: 'read' | 'write' | 'flush' | 'discard' | 'unknown';
  status: 'pending' | 'completed' | 'failed';
  /** 完成的字节数，部分完成时小于请求量 */
  completedBytes: number | null;
  /** 关联的 virtqueue 索引与描述符链 */
  queueIndex: number | null;
  descriptorChain: number[];
  /** 写请求的数据，可能为空（未采集） */
  dataRef: Sha256 | null;
  submittedAt: string;
  completedAt: string | null;
  evidence: EvidenceRef;
}

/** 逻辑磁盘版本：versionId 按客体可见的成功完成点推进，供同帧文件和磁盘视图使用。 */
export interface DiskVersion {
  diskId: string;
  versionId: string;
  /** 基线镜像的散列；版本链必须与基线一起绑定 */
  baseSha256: Sha256;
  /** 该版本下已对客体可见的扇区范围 */
  visible: Array<{ lba: Hex; count: number }>;
  /** 尚未对客体可见的写入，单独保存 */
  pending: Array<{
    requestId: string;
    lba: Hex;
    count: number;
    dataRef: Sha256 | null;
    bytes: number;
  }>;
  createdAt: string;
}

/** 按 LBA 读取帧绑定的逻辑版本数据。 */
export interface DiskBlockData {
  diskId: string;
  versionId: string;
  lba: Hex;
  count: number;
  /** 原始字节 base64 */
  bytes: Base64;
  /** 该范围是否来自基线而非增量覆盖 */
  fromBase: boolean;
  evidence: EvidenceRef;
}

export interface DeviceSnapshotBundle {
  devices: DeviceSnapshot[];
  /** 设备快照缺口的来源与原因 */
  unavailable: string[];
}
