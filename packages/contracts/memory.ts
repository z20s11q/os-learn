/**
 * 内存类型。
 *
 * 采集规则见总体方案 6.3：实时调试只保证选中页/页表/栈；完整录制才有
 * 全量 RAM 基线与脏页增量。历史帧缺页时必须显示「本次未记录」，
 * 不允许读取当前 VM 的新值填补。
 */

import type { Base64, CaptureAttribution, EvidenceRef, Hex, Sha256 } from './common.ts';

export type AddressSpace = 'physical' | 'linear' | 'io-port' | 'disk-lba';

/** 页/区间的采集状态。 */
export type PageCoverage =
  /** 本次 capture 内有相应字节 */
  | 'recorded'
  /** 本次范围外 */
  | 'not-recorded'
  /** 有地址空间但读取失败，例如越界或设备拒绝 */
  | 'read-failed'
  /** 按当前页表该地址未映射 */
  | 'unmapped';

/** 指向一块已采集内存的引用，实际字节通过 blobRef 去重存储。 */
export interface MemoryPageRef {
  addressSpace: 'physical' | 'linear';
  /** 页起始地址，4 KiB 对齐 */
  address: Hex;
  /** 页大小，通常 4096，大页时可为 2 MiB 或 1 GiB */
  length: number;
  coverage: PageCoverage;
  /** 内容散列，用于引用与去重；未采集时为 null */
  blobRef: Sha256 | null;
  reason?: string;
}

/** 单次内存读取结果。 */
export interface MemoryReadResult {
  attribution: CaptureAttribution;
  addressSpace: AddressSpace;
  address: Hex;
  length: number;
  /** 原始字节，base64（可能被分块重组成一条） */
  bytes: Base64;
  /** 便于展示的十六进制，连续小写，不含 0x 前缀 */
  hex: string;
  blobRef: Sha256 | null;
  /** 该范围完全落在本次 capture 允许区域内 */
  withinCapture: boolean;
  evidence: EvidenceRef;
}

/** 分页结构。按当前模式解析，未启用分页时为 null。 */
export interface PagingState {
  enabled: boolean;
  /** 10=32 位二级，4=64 位四级，5=五级；未启用为 null */
  levels: 4 | 5 | 2 | null;
  /** 当前 CR3 指向的顶层表物理地址 */
  rootTable: Hex | null;
  /** 被解析的具体条目，键为地址字符串 */
  entries?: Record<string, PageTableEntry>;
  note?: string;
}

export interface PageTableEntry {
  /** 条目自身的物理地址 */
  tableAddress: Hex;
  index: number;
  /** PTE 原始 64/32 位值 */
  raw: Hex;
  present: boolean;
  writable: boolean;
  user: boolean;
  /** 是否为大页（2 MiB / 1 GiB） */
  huge: boolean;
  /** 指向的下一级表或最终物理页框号 */
  physicalAddress: Hex | null;
  /** 权限错误/NX 等 */
  noExecute?: boolean;
  evidence: EvidenceRef;
}

export interface AddressTranslation {
  linear: Hex;
  physical: Hex | null;
  pageSize: number | null;
  huge: boolean;
  fault: null | {
    kind: 'not-present' | 'permission' | 'reserved' | 'unsupported';
    level: number | null;
    detail: string;
  };
  walk: PageTableEntry[];
  attribution: CaptureAttribution;
}

/** 内存采集统计，用于界面显示覆盖范围。 */
export interface MemoryCoverageStats {
  mode: 'selected-pages' | 'full-ram-delta';
  /** 已采集页数 */
  pages: number;
  /** 已采集字节数 */
  bytes: number;
  /** 相对基线发生变化的页数（仅 full-ram-delta） */
  dirtyPages: number | null;
  /** 全量 RAM 散列，仅在具备完整 RAM 时提供 */
  ramSha256: Sha256 | null;
  note?: string;
}
