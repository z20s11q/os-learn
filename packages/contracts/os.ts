/** Linux 对象快照：解析器接收 ReadOnlyCapture，地址与计数用字符串，字段携带覆盖状态。 */

import type { EvidenceRef, Field, Hex, Sha256 } from './common.ts';

/** 进程状态，取值对应 task_struct 的 state 字段。 */
export type TaskState =
  | 'running'
  | 'sleeping'
  | 'disk-sleep'
  | 'stopped'
  | 'tracing-stop'
  | 'zombie'
  | 'dead'
  | 'idle'
  | 'unknown';

export interface ProcessRef {
  pid: number;
  /** 线程组 ID，与 pid 相同表示主线程 */
  tgid: number;
  /** task_struct 地址 */
  taskAddress: Hex;
  comm: string;
  state: TaskState;
  /** 原始 state 数值，便于与内核结构对照 */
  stateRaw: number;
  parentPid: number | null;
  /** mm_struct 地址，内核线程为 null */
  mmAddress: Hex | null;
  /** 内核栈顶 */
  stackAddress: Hex | null;
  /** 线程组内其他线程的 pid */
  threads: number[];
  evidence: EvidenceRef;
}

/** 地址空间（mm_struct）摘要。 */
export interface AddressSpaceRef {
  pid: number;
  mmAddress: Hex;
  /** 用户态代码/数据/栈边界 */
  startCode: Hex | null;
  endCode: Hex | null;
  startStack: Hex | null;
  /** 页表顶层物理地址 */
  pgdPhysical: Hex | null;
  /** 已加载的 VMA 摘要 */
  vmas: VmaRef[];
  /** 遍历是否被深度限制截断 */
  truncated: boolean;
  /** 使用的结构访问方式，例如 maple-tree；说明解析依据 */
  structure: string;
  evidence: EvidenceRef;
}

export interface VmaRef {
  address: Hex;
  end: Hex;
  permissions: string;
  /** 映射来源：文件路径或 [heap]/[stack] */
  source: string | null;
  fileOffset: Hex | null;
}

/** 文件对象链：task.files → fdtable → file → dentry/inode → address_space。 */
export interface FileRef {
  /** 文件描述符编号 */
  fd: number;
  /** struct file 地址 */
  fileAddress: Hex;
  /** 当前偏移 */
  offset: Hex;
  flags: Hex;
  /** dentry 与 inode 地址 */
  dentryAddress: Hex | null;
  inodeAddress: Hex | null;
  /** 路径字符串，可能为空（例如已 unlink 的匿名文件） */
  path: string | null;
  /** inode 号与设备号 */
  inodeNumber: string | null;
  deviceId: string | null;
  /** 文件大小 */
  size: Hex | null;
  /** 引用计数，用于展示 dup/独立 open 的共享关系 */
  refCount: number | null;
  evidence: EvidenceRef;
}

/** 页缓存中的 folio/page。 */
export interface FolioRef {
  /** struct page / folio 地址 */
  address: Hex;
  /** 对应文件内偏移 */
  fileOffset: Hex | null;
  /** 物理页框号 */
  pfn: Hex | null;
  dirty: boolean;
  uptodate: boolean;
  inodeAddress: Hex | null;
  evidence: EvidenceRef;
}

/** ext2 盘面对象。 */
export interface Ext2Object {
  inode: string;
  /** 文件类型：regular/dir/symlink 等 */
  type: string;
  size: number;
  /** 直接/间接块映射，文件偏移 → LBA */
  blocks: Array<{ fileOffset: Hex; lba: Hex; length: number; indirect: string }>;
  /** 目录项（仅目录） */
  entries?: Array<{ name: string; inode: string }>;
  superblock: {
    blockSize: number;
    inodesCount: number;
    blocksCount: number;
    inodeSize: number;
  };
  evidence: EvidenceRef;
}

/** 源码位置。必须绑定文件散列，源码更新后映射失效需重校验。 */
export interface SourceLocation {
  /** 产物清单内的相对路径 */
  path: string;
  fileHash: Sha256;
  symbol: string;
  /** 1 起始行号 */
  line: number;
  column?: number;
  /** 对应的模块：seabios/grub/linux-setup/decompressor/kernel/user-elf */
  module: string;
}

/** 教学点匹配结果。 */
export interface LessonMatch {
  lessonId: string;
  /** 所在阶段：boot/terminal/process/memory/file */
  stage: string;
  title: string;
  /** 命中依据，例如 pc 落在符号内、断点命中 */
  reason: string;
  /** 是否满足 checks 中的后置条件 */
  checksPassed: boolean;
  /** 未通过时展示的实际差异 */
  checksDiff?: string[];
}

/** 内核整体对象快照。 */
export interface OsSnapshot {
  /** 内核 release 字符串，必须与 vmlinux 匹配 */
  kernelRelease: string;
  /** init_task 地址 */
  initTaskAddress: Hex | null;
  /** 当前正在运行的进程 */
  current: ProcessRef | null;
  /** 界面选中的进程，供只读详情解析 */
  selected: ProcessRef | null;
  processes: ProcessRef[];
  /** 遍历是否被深度限制截断 */
  processesTruncated: boolean;
  /** 选中进程的地址空间 */
  addressSpace: AddressSpaceRef | null;
  /** 选中进程打开的文件 */
  files: FileRef[];
  /** 相关页缓存 folio */
  folios: FolioRef[];
  /** 生成该快照的解析器版本，用于判断结构布局是否匹配 */
  decoderVersion: string;
  evidence: EvidenceRef;
}
