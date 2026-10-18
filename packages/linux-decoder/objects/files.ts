/** 文件对象链：task.files → fdtable → file → dentry/inode → address_space → folio。
 * fdtable 经 files->fdt 读取，页缓存按 XArray 解释，名字按 d_name.name 判断内嵌或外部存储。
 * 路径遍历报告断链、环和上限；空指针保留内核语义，读取失败独立报告。
 * 位掩码来源为内核头文件，验收时逐项核对。
 */

import { CaptureReadError, memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef, Hex } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';
import type { FileRef, FolioRef } from '../../contracts/os.ts';
import { TASK_TYPE, readStruct } from './task.ts';
import type { KernelTask, StructBuffer } from './task.ts';
import { PAGE_SHIFT, resolveVmemmapBase } from './page-table.ts';
import type { VmemmapFacts } from './page-table.ts';
import { PAGE_MAPPING_ANON, PAGE_MAPPING_FLAGS, readFolioForPfn } from './mm.ts';
import type { KernelFolio } from './mm.ts';

export class FilesParseError extends CaptureReadError {}

/* --------------------------------------------------------------------------
 * 清单里的类型名
 * ------------------------------------------------------------------------ */

export const FILES_TYPE = 'files_struct';
export const FDTABLE_TYPE = 'fdtable';
export const FILE_TYPE = 'file';
export const PATH_TYPE = 'path';
export const VFSMOUNT_TYPE = 'vfsmount';
export const DENTRY_TYPE = 'dentry';
export const QSTR_TYPE = 'qstr';
export const INODE_TYPE = 'inode';
export const SUPER_BLOCK_TYPE = 'super_block';
export const XARRAY_TYPE = 'xarray';
export const XA_NODE_TYPE = 'xa_node';
export const ADDRESS_SPACE_TYPE = 'address_space';

/** `dev_t` 里低位是次设备号（`include/linux/kdev_t.h`：`MINORBITS = 20`）。 */
export const MINORBITS = 20;
export const MINORMASK = (1 << MINORBITS) - 1;

/** 把 `dev_t` 拆成主/次设备号（`MAJOR()` / `MINOR()` 的同一算法）。 */
export function majorOf(dev: bigint): bigint {
  return dev >> BigInt(MINORBITS);
}

export function minorOf(dev: bigint): bigint {
  return dev & BigInt(MINORMASK);
}

/** `dev_t` 的展示形式：`主:次`。 */
export function describeDevice(dev: bigint): string {
  return `${majorOf(dev)}:${minorOf(dev)}`;
}

/* --------------------------------------------------------------------------
 * 位表：f_flags（open）、f_mode、i_state、d_flags
 * ------------------------------------------------------------------------ */

export interface FlagBit {
  name: string;
  /** 这一位（或这几位）的掩码。源码里写作 `BIT(n)` 或八进制常量，这里照抄它的数值。 */
  value: number;
  /** 依赖的配置项；null 表示源码里无条件定义 */
  config: string | null;
  note?: string;
}

export interface FlagName extends FlagBit {
  /** 这一位是否来自"依赖配置"的那张表 */
  conditional: boolean;
}

/**
 * 解一位表里立着的位。
 *
 * `enabledConfigs` 为 null 时把依赖配置的那些位也报出来（`conditional: true`），由调用方判；
 * 给了配置集合就只报真正存在的位，把其余归到 `unknownBits`。
 * 这套参数与 `mm.ts` 的 `decodeVmaFlags()` 保持一致，免得同一件事在两处有两种语义。
 */
export function decodeFlagBits(
  flags: number,
  table: FlagBit[],
  enabledConfigs: Set<string> | null = null,
): { names: FlagName[]; unknownBits: number } {
  const names: FlagName[] = [];
  let matched = 0;
  for (const entry of table) {
    if ((flags & entry.value) === 0) continue;
    const conditional = entry.config !== null;
    if (conditional && enabledConfigs !== null && !enabledConfigs.has(entry.config as string)) continue;
    names.push({ ...entry, conditional });
    matched |= entry.value;
  }
  return { names, unknownBits: flags & ~matched };
}

/* ---------- open(2) 的 flags ---------- */

/** open flags 来自 include/uapi/asm-generic/fcntl.h。
 * 低两位由 FILE_ACCESS_MODES 解释；O_SYNC 和 O_TMPFILE 由 O_COMPOSITE_FLAGS 解释组合。
 */
export const O_FLAG_BITS: FlagBit[] = [
  { name: 'O_CREAT', value: 0o0000100, config: null },
  { name: 'O_EXCL', value: 0o0000200, config: null },
  { name: 'O_NOCTTY', value: 0o0000400, config: null },
  { name: 'O_TRUNC', value: 0o0001000, config: null },
  { name: 'O_APPEND', value: 0o0002000, config: null },
  { name: 'O_NONBLOCK', value: 0o0004000, config: null },
  { name: 'O_DSYNC', value: 0o0010000, config: null, note: '2.6.33 之前它与 O_SYNC 同义，现在只表示数据同步' },
  { name: 'FASYNC', value: 0o0020000, config: null, note: '源码用的是 `FASYNC`，没有 O_ 前缀' },
  { name: 'O_DIRECT', value: 0o0040000, config: null },
  { name: 'O_LARGEFILE', value: 0o0100000, config: null, note: 'x86_64 上由内核自动加上，用户几乎不会显式给' },
  { name: 'O_DIRECTORY', value: 0o0200000, config: null },
  { name: 'O_NOFOLLOW', value: 0o0400000, config: null },
  { name: 'O_NOATIME', value: 0o1000000, config: null },
  { name: 'O_CLOEXEC', value: 0o2000000, config: null },
  { name: '__O_SYNC', value: 0o4000000, config: null, note: '源码注释明确写"__O_SYNC 永远不要直接用"，要连同 O_DSYNC 一起看' },
  { name: 'O_PATH', value: 0o10000000, config: null, note: '只想拿到路径本身，不做 I/O；这种 file 的 f_mode 里没有 FMODE_READ/WRITE' },
  { name: '__O_TMPFILE', value: 0o20000000, config: null, note: '要连同 O_DIRECTORY 一起看' },
];

/** 由多位掩码组成的 open flags。 */
export const O_COMPOSITE_FLAGS: FlagBit[] = [
  { name: 'O_SYNC', value: 0o4000000 | 0o0010000, config: null, note: '= __O_SYNC|O_DSYNC' },
  { name: 'O_TMPFILE', value: 0o20000000 | 0o0200000, config: null, note: '= __O_TMPFILE|O_DIRECTORY' },
  { name: 'O_NDELAY', value: 0o0004000, config: null, note: '= O_NONBLOCK，老名字' },
];

/** `O_ACCMODE` 低两位的三个合法取值（`#define O_ACCMODE 00000003`）。 */
export const FILE_ACCESS_MODES: Array<{ value: number; name: string }> = [
  { value: 0o0, name: 'O_RDONLY' },
  { value: 0o1, name: 'O_WRONLY' },
  { value: 0o2, name: 'O_RDWR' },
];

export const O_ACCMODE = 0o3;

export interface OpenFlagDecode {
  names: FlagName[];
  /** 由多位拼出来的名字（`O_SYNC`、`O_TMPFILE`、`O_NDELAY`） */
  composites: string[];
  /** 低两位访问模式，3 表示 O_ACCMODE 掩码值，解码时报告非法模式 */
  accessMode: string;
  accessModeRaw: number;
  unknownBits: number;
}

/** 解 `file->f_flags`（用户 `open()` 时给的 flags，内核几乎原样存下来）。 */
export function decodeOpenFlags(flags: number, enabledConfigs: Set<string> | null = null): OpenFlagDecode {
  const decoded = decodeFlagBits(flags, O_FLAG_BITS, enabledConfigs);
  const raw = flags & O_ACCMODE;
  const mode = FILE_ACCESS_MODES.find((entry) => entry.value === raw);
  const composites: string[] = [];
  for (const entry of O_COMPOSITE_FLAGS) {
    if ((flags & entry.value) === entry.value) composites.push(entry.name);
  }
  return {
    names: decoded.names,
    composites,
    accessMode: mode === undefined ? `O_ACCMODE(${raw})：不是合法的访问模式` : mode.name,
    accessModeRaw: raw,
    unknownBits: decoded.unknownBits,
  };
}

/* ---------- file->f_mode ---------- */

/** FMODE_* 来自 include/linux/fs.h，表示内核对 file 的访问与操作能力。 */
export const FMODE_BITS: FlagBit[] = [
  { name: 'FMODE_READ', value: 1 << 0, config: null, note: '这个 file 可读' },
  { name: 'FMODE_WRITE', value: 1 << 1, config: null, note: '这个 file 可写' },
  { name: 'FMODE_LSEEK', value: 1 << 2, config: null },
  { name: 'FMODE_PREAD', value: 1 << 3, config: null },
  { name: 'FMODE_PWRITE', value: 1 << 4, config: null },
  { name: 'FMODE_EXEC', value: 1 << 5, config: null, note: '以执行的方式打开（`open_exec`）' },
  { name: 'FMODE_WRITE_RESTRICTED', value: 1 << 6, config: null },
  { name: 'FMODE_CAN_ATOMIC_WRITE', value: 1 << 7, config: null },
  { name: 'FMODE_32BITHASH', value: 1 << 9, config: null },
  { name: 'FMODE_64BITHASH', value: 1 << 10, config: null },
  { name: 'FMODE_NOCMTIME', value: 1 << 11, config: null },
  { name: 'FMODE_RANDOM', value: 1 << 12, config: null, note: '顺序读的想法被放弃，改成随机读' },
  { name: 'FMODE_PATH', value: 1 << 14, config: null, note: '`O_PATH` 打开的那种 file' },
  { name: 'FMODE_ATOMIC_POS', value: 1 << 15, config: null, note: '改文件位置要用 f_pos_lock，普通文件与目录都置这一位' },
  { name: 'FMODE_WRITER', value: 1 << 16, config: null, note: '写过东西，`i_writecount` 相应地被加上' },
  { name: 'FMODE_CAN_READ', value: 1 << 17, config: null, note: '文件系统提供了 read/read_iter' },
  { name: 'FMODE_CAN_WRITE', value: 1 << 18, config: null, note: '文件系统提供了 write/write_iter' },
  { name: 'FMODE_OPENED', value: 1 << 19, config: null, note: '`do_dentry_open()` 跑完了' },
  { name: 'FMODE_CREATED', value: 1 << 20, config: null, note: '这次 open 是 `O_CREAT` 建出来的' },
  { name: 'FMODE_STREAM', value: 1 << 21, config: null },
  { name: 'FMODE_CAN_ODIRECT', value: 1 << 22, config: null, note: '文件系统支持 O_DIRECT' },
  { name: 'FMODE_NOREUSE', value: 1 << 23, config: null, note: '用完即弃，不要留在页缓存里' },
  { name: 'FMODE_BACKING', value: 1 << 24, config: null },
  { name: 'FMODE_NONOTIFY', value: 1 << 25, config: null },
  { name: 'FMODE_NONOTIFY_PERM', value: 1 << 26, config: null },
  { name: 'FMODE_NOWAIT', value: 1 << 27, config: null },
  { name: 'FMODE_NEED_UNMOUNT', value: 1 << 28, config: null },
  { name: 'FMODE_NOACCOUNT', value: 1 << 29, config: null },
];

/* ---------- inode->i_state ---------- */

/** I_* 位号来自 include/linux/fs.h，前三位由 __I_* 定义，其余直接给出位号。 */
export const INODE_STATE_BITS: FlagBit[] = [
  { name: 'I_NEW', value: 1 << 0, config: null, note: 'inode 刚分配，还没被文件系统填好' },
  { name: 'I_SYNC', value: 1 << 1, config: null },
  { name: 'I_LRU_ISOLATING', value: 1 << 2, config: null },
  { name: 'I_DIRTY_SYNC', value: 1 << 3, config: null },
  { name: 'I_DIRTY_DATASYNC', value: 1 << 4, config: null },
  { name: 'I_DIRTY_PAGES', value: 1 << 5, config: null, note: '页缓存里有脏页' },
  { name: 'I_WILL_FREE', value: 1 << 6, config: null },
  { name: 'I_FREEING', value: 1 << 7, config: null },
  { name: 'I_CLEAR', value: 1 << 8, config: null },
  { name: 'I_REFERENCED', value: 1 << 9, config: null },
  { name: 'I_LINKABLE', value: 1 << 10, config: null },
  { name: 'I_DIRTY_TIME', value: 1 << 11, config: null },
  { name: 'I_WB_SWITCH', value: 1 << 12, config: null },
  { name: 'I_OVL_INUSE', value: 1 << 13, config: null },
  { name: 'I_CREATING', value: 1 << 14, config: null },
  { name: 'I_DONTCACHE', value: 1 << 15, config: null },
  { name: 'I_SYNC_QUEUED', value: 1 << 16, config: null },
  { name: 'I_PINNING_NETFS_WB', value: 1 << 17, config: null },
];

/** `I_DIRTY` 由三位拼成（`I_DIRTY_INODE | I_DIRTY_PAGES`），单独报会漏掉"脏"这个结论。 */
export const INODE_DIRTY_MASK = (1 << 3) | (1 << 4) | (1 << 5);
export const INODE_DIRTY_ALL_MASK = INODE_DIRTY_MASK | (1 << 11);

/* ---------- dentry->d_flags ---------- */

export const DCACHE_ENTRY_TYPE_SHIFT = 20;
export const DCACHE_ENTRY_TYPE_MASK = 7 << DCACHE_ENTRY_TYPE_SHIFT;

/** d_flags 单位位表；bit 20..22 作为 DCACHE_ENTRY_TYPE 多位字段单独解码。 */
export const DENTRY_FLAG_BITS: FlagBit[] = [
  { name: 'DCACHE_OP_HASH', value: 1 << 0, config: null, note: '文件系统提供了 d_hash，要按名字哈希' },
  { name: 'DCACHE_OP_COMPARE', value: 1 << 1, config: null },
  { name: 'DCACHE_OP_REVALIDATE', value: 1 << 2, config: null },
  { name: 'DCACHE_OP_DELETE', value: 1 << 3, config: null },
  { name: 'DCACHE_OP_PRUNE', value: 1 << 4, config: null },
  { name: 'DCACHE_DISCONNECTED', value: 1 << 5, config: null, note: '这个 dentry 现在可能不在这棵目录树上' },
  { name: 'DCACHE_REFERENCED', value: 1 << 6, config: null, note: '最近用过，回收时要排在后面' },
  { name: 'DCACHE_DONTCACHE', value: 1 << 7, config: null },
  { name: 'DCACHE_CANT_MOUNT', value: 1 << 8, config: null },
  { name: 'DCACHE_GENOCIDE', value: 1 << 9, config: null },
  { name: 'DCACHE_SHRINK_LIST', value: 1 << 10, config: null },
  { name: 'DCACHE_OP_WEAK_REVALIDATE', value: 1 << 11, config: null },
  { name: 'DCACHE_NFSFS_RENAMED', value: 1 << 12, config: null },
  // dcache.h 中 BIT(14) 和 BIT(25) 始终定义。
  // 配置决定监听和加密名的语义使用。
  // 两个位的定义按头文件固定掩码核对。
  { name: 'DCACHE_FSNOTIFY_PARENT_WATCHED', value: 1 << 14, config: null,
    note: '父目录被 fsnotify 监听（位的存在与 CONFIG_FSNOTIFY 无关）' },
  { name: 'DCACHE_DENTRY_KILLED', value: 1 << 15, config: null },
  { name: 'DCACHE_MOUNTED', value: 1 << 16, config: null, note: '这里是一个挂载点' },
  { name: 'DCACHE_NEED_AUTOMOUNT', value: 1 << 17, config: null },
  { name: 'DCACHE_MANAGE_TRANSIT', value: 1 << 18, config: null },
  { name: 'DCACHE_LRU_LIST', value: 1 << 19, config: null },
  { name: 'DCACHE_NOKEY_NAME', value: 1 << 25, config: null,
    note: '加密名没带密钥（位的存在与 CONFIG_FS_ENCRYPTION 无关）' },
  { name: 'DCACHE_OP_REAL', value: 1 << 26, config: null },
  { name: 'DCACHE_PAR_LOOKUP', value: 1 << 28, config: null, note: '正在被查找（父目录只拿了共享锁）' },
  { name: 'DCACHE_DENTRY_CURSOR', value: 1 << 29, config: null },
  { name: 'DCACHE_NORCU', value: 1 << 30, config: null },
];

/** `DCACHE_ENTRY_TYPE` 这个三位字段的七个取值（`(n << 20)`）。 */
export const DENTRY_ENTRY_TYPES: Array<{ value: number; name: string; note: string }> = [
  { value: 0 << 20, name: 'DCACHE_MISS_TYPE', note: '负 dentry：查过但不存在' },
  { value: 1 << 20, name: 'DCACHE_WHITEOUT_TYPE', note: 'whiteout（overlayfs 用），路径查找到此为止' },
  { value: 2 << 20, name: 'DCACHE_DIRECTORY_TYPE', note: '普通目录' },
  { value: 3 << 20, name: 'DCACHE_AUTODIR_TYPE', note: '不需要查找的目录（被当成自动挂载点）' },
  { value: 4 << 20, name: 'DCACHE_REGULAR_TYPE', note: '普通文件' },
  { value: 5 << 20, name: 'DCACHE_SPECIAL_TYPE', note: '其它类型（设备、管道、socket……）' },
  { value: 6 << 20, name: 'DCACHE_SYMLINK_TYPE', note: '符号链接' },
];

export interface DentryFlagDecode {
  names: FlagName[];
  entryType: { raw: number; name: string | null; note: string | null };
  unknownBits: number;
}

export function decodeDentryFlags(dFlags: number, enabledConfigs: Set<string> | null = null): DentryFlagDecode {
  const decoded = decodeFlagBits(dFlags & ~DCACHE_ENTRY_TYPE_MASK, DENTRY_FLAG_BITS, enabledConfigs);
  const raw = dFlags & DCACHE_ENTRY_TYPE_MASK;
  const entry = DENTRY_ENTRY_TYPES.find((candidate) => candidate.value === raw);
  return {
    names: decoded.names,
    entryType: {
      raw,
      name: entry === undefined ? null : entry.name,
      note: entry === undefined ? null : entry.note,
    },
    unknownBits: decoded.unknownBits,
  };
}

/** i_mode 类型和权限掩码来自 include/uapi/linux/stat.h 的宏定义。 */
export const S_IFMT = 0o170000;
export const INODE_FILE_TYPES: Array<{ value: number; name: string; note: string }> = [
  { value: 0o010000, name: 'S_IFIFO', note: '命名管道' },
  { value: 0o020000, name: 'S_IFCHR', note: '字符设备' },
  { value: 0o040000, name: 'S_IFDIR', note: '目录' },
  { value: 0o060000, name: 'S_IFBLK', note: '块设备' },
  { value: 0o100000, name: 'S_IFREG', note: '普通文件' },
  { value: 0o120000, name: 'S_IFLNK', note: '符号链接' },
  { value: 0o140000, name: 'S_IFSOCK', note: '套接字' },
];

/** i_mode 转类型和权限串：setuid/setgid/sticky 位为 11/10/9，覆盖对应执行位字符。
 * 执行位为 1 时用 s/t，为 0 时用 S/T。
 */
export function decodeInodeMode(mode: number): { type: string; typeRaw: number; permissions: string } {
  const raw = mode & S_IFMT;
  const entry = INODE_FILE_TYPES.find((candidate) => candidate.value === raw);
  const bits = mode & 0o7777;
  const specialBits = [0o4000, 0o2000, 0o1000];
  const specialLower = ['s', 's', 't'];
  const specialUpper = ['S', 'S', 'T'];
  const chars = [0, 1, 2].map((index) => {
    // `i_mode` 的低 12 位：other = bit 2..0、group = bit 5..3、user = bit 8..6，
    // 特殊位在 bit 11/10/9。写成 8/5/2 会让每一组都错开两位（0644 会变成 `--xr-x--x`）。
    const shift = 6 - index * 3;
    const triplet = (bits >> shift) & 0o7;
    const special = (bits & specialBits[index]) !== 0;
    const read = triplet & 0o4 ? 'r' : '-';
    const write = triplet & 0o2 ? 'w' : '-';
    const execute = triplet & 0o1
      ? (special ? specialLower[index] : 'x')
      : (special ? specialUpper[index] : '-');
    return `${read}${write}${execute}`;
  });
  const special = bits & 0o7000;
  return {
    type: entry === undefined ? `未知文件类型(${toHex(BigInt(raw))})` : entry.name,
    typeRaw: raw,
    permissions: `${special !== 0 ? `特殊位=${toHex(BigInt(special))} ` : ''}${bits.toString(8)} ${chars.join('')}`,
  };
}

/* --------------------------------------------------------------------------
 * XArray：页缓存/文件表的实际容器
 * ------------------------------------------------------------------------ */

export const XA_CHUNK_SHIFT = 6;
export const XA_CHUNK_SIZE = 1 << XA_CHUNK_SHIFT;
export const XA_CHUNK_MASK = XA_CHUNK_SIZE - 1;
export const XA_MAX_MARKS = 3;
export const XA_MARK_LONGS = XA_CHUNK_SIZE / 64;

const MASK64 = (1n << 64n) - 1n;

/** 将 XArray 原始条目归一为无符号 64 位，与内核 unsigned long 编码一致。 */
export function u64(value: bigint): bigint {
  return value & MASK64;
}

/** `xa_mk_value(v)`：值条目（最低位为 1）。`v` 必须非负（内核里 `WARN_ON((long)v < 0)`）。 */
export function xaMkValue(value: bigint): bigint {
  return u64((value << 1n) | 1n);
}

/** `xa_to_value(entry)` = `entry >> 1`。 */
export function xaToValue(entry: bigint): bigint {
  return u64(entry) >> 1n;
}

/** `xa_is_value(entry)`：最低位为 1。 */
export function xaIsValue(entry: bigint): boolean {
  return (u64(entry) & 1n) === 1n;
}

/** `xa_mk_internal(v)`：`(v << 2) | 2`。 */
export function xaMkInternal(value: bigint): bigint {
  return u64((value << 2n) | 2n);
}

/** `xa_to_internal(entry)` = `entry >> 2`。 */
export function xaToInternal(entry: bigint): bigint {
  return u64(entry) >> 2n;
}

/** `xa_is_internal(entry)`：低两位是 `10`。 */
export function xaIsInternal(entry: bigint): boolean {
  return (u64(entry) & 3n) === 2n;
}

export const XA_ZERO_ENTRY = xaMkInternal(257n);
export const XA_RETRY_ENTRY = xaMkInternal(256n);

/** `xa_is_zero()`：保留条目，表示"这里有一个明确的 0"。 */
export function xaIsZero(entry: bigint): boolean {
  return u64(entry) === XA_ZERO_ENTRY;
}

/** `xa_is_retry()`。 */
export function xaIsRetry(entry: bigint): boolean {
  return u64(entry) === XA_RETRY_ENTRY;
}

/** `xa_is_node(entry)`：内部条目且数值大于 4096（小于它的都是兄弟/retry/zero 这些小数值）。 */
export function xaIsNode(entry: bigint): boolean {
  return xaIsInternal(entry) && u64(entry) > 4096n;
}

/** xa_to_node(entry) = entry - 2。 */
export function xaToNode(entry: bigint): bigint {
  return u64(entry) - 2n;
}

/** `xa_mk_sibling(offset)`。 */
export function xaMkSibling(offset: number): bigint {
  return xaMkInternal(BigInt(offset));
}

/** `xa_to_sibling(entry)`。 */
export function xaToSibling(entry: bigint): bigint {
  return xaToInternal(entry);
}

/** CONFIG_XARRAY_MULTI 决定兄弟条目识别；启用时按内部条目编码及范围判断。 */
export function xaIsSibling(entry: bigint, xarrayMulti = true): boolean {
  if (!xarrayMulti) return false;
  return xaIsInternal(entry) && u64(entry) < xaMkSibling(XA_CHUNK_SIZE - 1);
}

/** `xa_to_internal()` 的反向：切片/乘法等"数组下标"编码用的低位值。 */
export function xaIsSingle(entry: bigint): boolean {
  return !xaIsInternal(entry);
}

/** `xa_err(entry)`：错误条目（内部条目且数值落在 `-MAX_ERRNO..-1` 那段）。 */
export function xaErr(entry: bigint): number {
  const raw = u64(entry);
  if (!xaIsInternal(entry) || raw < xaMkInternal(-4095n)) return 0;
  return Number(BigInt.asIntN(64, raw) >> 2n);
}

/** `xa_maxindex(node)`：一个节点能覆盖的下标上界。 */
export function xaMaxIndex(shift: number): bigint {
  return (1n << BigInt(shift + XA_CHUNK_SHIFT)) - 1n;
}

/** `get_offset(index, node)` = `(index >> node->shift) & XA_CHUNK_MASK`。 */
export function xaOffsetOf(index: bigint, shift: number): number {
  return Number((index >> BigInt(shift)) & BigInt(XA_CHUNK_MASK));
}

/** 从一个已读进内存的节点槽数组里取第 slot 个条目（小端 8 字节）。 */
export function xaSlotAt(slots: Uint8Array, slot: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(slots[slot * 8 + index]);
  return value;
}

export interface XaNodeFacts {
  address: bigint;
  shift: number;
  offset: number;
  count: number;
  nrValues: number;
  parent: bigint | null;
  array: bigint | null;
  /** 槽数组的地址（`&node->slots[0]`） */
  slotsAddress: bigint;
  /** 已读进来的槽数组（64 × 8 字节） */
  slots: Uint8Array;
  /** `node->marks[3][1]`（脏页/回写这两位就是从这里读的） */
  marks: bigint[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 读一个 `struct xa_node`，并把它的整个槽数组一起读进来。 */
export async function readXaNode(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<XaNodeFacts> {
  if (address === 0n) {
    throw new FilesParseError('null-xa-node', 'xa_node 地址为 0：XArray 里"没有节点"就是空，不该走到这里', {});
  }
  const node = await readStruct(view, layout, XA_NODE_TYPE, address);
  const notes: string[] = [];
  const slotsOffset = node.field('slots').byteOffset;
  const slotsAddress = address + BigInt(slotsOffset);
  const slots = await view.bytes(slotsAddress, XA_CHUNK_SIZE * 8);
  const marks: bigint[] = [];
  if (node.has('marks')) {
    const marksAddress = node.addressOf('marks');
    for (let mark = 0; mark < XA_MAX_MARKS; mark += 1) {
      // marks 是 unsigned long[3][1]，按数组地址逐项读取。
      marks.push(await view.u64(marksAddress + BigInt(mark * XA_MARK_LONGS * 8)));
    }
  } else {
    notes.push('布局清单里 xa_node 没有 marks 字段，节点上的脏页/回写标记读不出来');
  }
  return {
    address,
    shift: node.u32('shift'),
    offset: node.u32('offset'),
    count: node.u32('count'),
    nrValues: node.has('nr_values') ? node.u32('nr_values') : 0,
    parent: node.pointer('parent'),
    array: node.pointer('array'),
    slotsAddress,
    slots,
    marks,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, node.bytes.length, [
      `type:${XA_NODE_TYPE}`,
      `slots:${toHex(slotsAddress)}`,
    ]),
  };
}

export type XArrayEntryKind = 'pointer' | 'value' | 'zero' | 'retry' | 'error' | 'internal-unknown';

export interface XArrayEntry {
  /** 这个条目覆盖的第一个下标 */
  index: bigint;
  /** 原始条目值（无符号 64 位） */
  raw: bigint;
  kind: XArrayEntryKind;
  /** 值条目的取值（`xa_to_value`）；非值条目为 null */
  value: bigint | null;
  /** 指向的地址（普通指针条目）；其它条目为 null */
  pointer: bigint | null;
  /** 这个条目一共覆盖多少个下标（多下标条目 + 兄弟条目一起算） */
  span: bigint;
  /** 承载它的节点地址；"整个数组只有一个下标 0 的条目"时为 null */
  node: bigint | null;
  /** 在节点里的槽号；同上为 null */
  slot: number | null;
  /** 节点的 shift（0 表示叶子层） */
  shift: number | null;
  notes: string[];
}

export interface XArrayWalkOptions {
  /** 只要这个区间里的条目（闭区间）。默认全都要。 */
  indexMin?: bigint;
  indexMax?: bigint;
  /** 最多报多少个条目 */
  maxEntries?: number;
  /** 最多访问多少个节点（防环、防爆） */
  maxNodes?: number;
  /** `CONFIG_XARRAY_MULTI`：决定兄弟条目是否参与解释 */
  xarrayMulti?: boolean;
}

export interface XArrayFacts {
  address: bigint;
  /** `xa_head` 的原始值 */
  head: bigint;
  headKind: 'empty' | 'single-entry' | 'node';
  /** `xa_head` 指向的根节点地址（`headKind === 'node'` 时非空） */
  rootNode: bigint | null;
  /** 根节点的 shift（树高 = shift / XA_CHUNK_SHIFT + 1）；单条目时为 0，空时为 null */
  rootShift: number | null;
  xaFlags: number;
  entries: XArrayEntry[];
  nodesVisited: number;
  nodeAddresses: bigint[];
  truncated: boolean;
  cycle: boolean;
  /** 结构层面的自相矛盾（`node->array` 指错、shift 不成台阶、父指针不指回来……） */
  violations: string[];
  notes: string[];
  evidence: EvidenceRef;
}

export const DEFAULT_MAX_XARRAY_NODES = 4096;
export const DEFAULT_MAX_XARRAY_ENTRIES = 512;

/** xas_descend 等价读取：兄弟槽跳到正主槽；正主为节点指针时返回 retry 并记录 violation。 */
async function xaDescend(
  view: KernelMemoryView,
  node: XaNodeFacts,
  index: bigint,
  xarrayMulti: boolean,
): Promise<{ entry: bigint; slot: number; violation: string | null }> {
  let slot = xaOffsetOf(index, node.shift);
  let entry = xaSlotAt(node.slots, slot);
  let violation: string | null = null;
  let hops = 0;
  while (xaIsSibling(entry, xarrayMulti)) {
    if (hops > XA_CHUNK_SIZE) {
      violation = `节点 ${toHex(node.address)} 的兄弟条目链走不出正主（绕了 ${hops} 次）`;
      break;
    }
    hops += 1;
    slot = Number(xaToSibling(entry));
    if (slot < 0 || slot >= XA_CHUNK_SIZE) {
      violation = `节点 ${toHex(node.address)} 的兄弟条目指向越界槽 ${slot}`;
      break;
    }
    entry = xaSlotAt(node.slots, slot);
    if (node.shift !== 0 && xaIsNode(entry)) {
      violation = `节点 ${toHex(node.address)}（shift=${node.shift}）的兄弟条目正主槽 ${slot} 里是节点指针：`
        + '这一层不该再出现下一级节点，源码在同样情形下返回 XA_RETRY_ENTRY';
      entry = XA_RETRY_ENTRY;
      break;
    }
  }
  return { entry, slot, violation };
}

/** 限定遍历 XArray：xa_head=0 是空树，直接条目覆盖下标 0，节点树按 node->shift 下降。 */
export async function walkXarray(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: XArrayWalkOptions = {},
): Promise<XArrayFacts> {
  const multi = options.xarrayMulti ?? true;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_XARRAY_NODES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_XARRAY_ENTRIES;
  const indexMin = options.indexMin ?? 0n;
  const indexMax = options.indexMax ?? (1n << 64n) - 1n;

  const array = await readStruct(view, layout, XARRAY_TYPE, address);
  const head = array.u64('xa_head');
  const xaFlags = array.u32('xa_flags');
  const entries: XArrayEntry[] = [];
  const nodeAddresses: bigint[] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let nodesVisited = 0;
  let truncated = false;
  let cycle = false;

  const evidence = memoryEvidence(view.evidenceSource, address, array.bytes.length, [
    `type:${XARRAY_TYPE}`,
    `head:${toHex(head)}`,
  ]);

  const emit = (entry: XArrayEntry): boolean => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return false;
    }
    entries.push(entry);
    return true;
  };

  const describeRaw = (raw: bigint, node: bigint | null, shift: number | null): XArrayEntry => {
    const base = {
      raw: u64(raw),
      node,
      shift,
      slot: null as number | null,
      value: null as bigint | null,
      pointer: null as bigint | null,
      span: 1n,
      notes: [] as string[],
    };
    if (xaIsZero(raw)) {
      return { ...base, index: 0n, kind: 'zero', notes: ['保留条目（值为 0 的明确占位）'] };
    }
    if (xaIsRetry(raw)) {
      return { ...base, index: 0n, kind: 'retry', notes: ['retry 条目：内核遇到它要重新走一遍'] };
    }
    if (xaIsValue(raw)) {
      return { ...base, index: 0n, kind: 'value', value: xaToValue(raw) };
    }
    if (xaIsInternal(raw)) {
      const err = xaErr(raw);
      return {
        ...base,
        index: 0n,
        kind: err !== 0 ? 'error' : 'internal-unknown',
        notes: err !== 0
          ? [`错误条目：errno = ${err}`]
          : [`不认识的内部条目（xa_to_internal = ${toHex(xaToInternal(raw))}）`],
      };
    }
    return { ...base, index: 0n, kind: 'pointer', pointer: u64(raw) };
  };

  const walkNode = async (nodeAddress: bigint, baseIndex: bigint, expectedShift: number): Promise<void> => {
    const key = nodeAddress.toString(16);
    if (seen.has(key)) {
      cycle = true;
      violations.push(`节点 ${toHex(nodeAddress)} 被访问了两次：树的链接里出现了环`);
      return;
    }
    seen.add(key);
    if (nodesVisited >= maxNodes) {
      truncated = true;
      notes.push(`达到节点上限 ${maxNodes} 个，停止遍历`);
      return;
    }
    nodesVisited += 1;
    nodeAddresses.push(nodeAddress);

    const node = await readXaNode(view, layout, nodeAddress);
    if (node.shift !== expectedShift) {
      violations.push(
        `节点 ${toHex(nodeAddress)} 的 shift = ${node.shift}，但按父节点的台阶算应当是 ${expectedShift}：`
        + '这棵树的层级对不上（按"第几层"数层数的实现会在这里开始读错）',
      );
    }
    if (node.array !== null && node.array !== address) {
      violations.push(
        `节点 ${toHex(nodeAddress)} 的 array 字段是 ${toHex(node.array)}，不是被查询的 XArray ${toHex(address)}`,
      );
    }
    if (node.parent === null && node.shift !== expectedShift) {
      notes.push('根节点的 parent 为 0 是正常的（源码注释写 "NULL at top of tree"）');
    }

    // 先扫一遍兄弟条目，弄清每个正主槽被多少兄弟槽跟着。
    const siblings = new Map<number, number>();
    for (let slot = 0; slot < XA_CHUNK_SIZE; slot += 1) {
      const raw = xaSlotAt(node.slots, slot);
      if (raw === 0n) continue;
      if (xaIsSibling(raw, multi)) {
        const owner = Number(xaToSibling(raw));
        siblings.set(owner, (siblings.get(owner) ?? 0) + 1);
      }
    }

    for (let slot = 0; slot < XA_CHUNK_SIZE; slot += 1) {
      const raw = xaSlotAt(node.slots, slot);
      if (raw === 0n) continue;
      if (xaIsSibling(raw, multi)) continue; // 兄弟槽信息合入正主条目的 span。
      const index = baseIndex | (BigInt(slot) << BigInt(node.shift));
      const span = BigInt(1 + (siblings.get(slot) ?? 0)) << BigInt(node.shift);
      if (xaIsNode(raw)) {
        if (node.shift < XA_CHUNK_SHIFT) {
          violations.push(
            `节点 ${toHex(nodeAddress)}（shift=${node.shift}）的槽 ${slot} 里是节点指针，`
            + '但叶子层的槽里只该有真实条目',
          );
          continue;
        }
        await walkNode(xaToNode(raw), index, node.shift - XA_CHUNK_SHIFT);
        continue;
      }
      if (index + span - 1n < indexMin || index > indexMax) continue;
      const described = describeRaw(raw, nodeAddress, node.shift);
      described.index = index;
      described.span = span;
      described.slot = slot;
      if (!emit(described)) return;
    }
  };

  if (head === 0n) {
    notes.push('xa_head 为 0：这个 XArray 是空的（不是"下标 0 是空"）');
    return {
      address,
      head,
      headKind: 'empty',
      rootNode: null,
      rootShift: null,
      xaFlags,
      entries,
      nodesVisited,
      nodeAddresses,
      truncated,
      cycle,
      violations,
      notes,
      evidence,
    };
  }

  if (!xaIsNode(head)) {
    // 整个数组只有下标 0 处有东西：`xa_head` 本身就是那个条目。
    notes.push('xa_head 不是节点指针：整个数组只有下标 0 可能有条目，此时 xa_head 就是那个条目本身');
    if (indexMin === 0n) {
      const described = describeRaw(head, null, null);
      described.index = 0n;
      described.span = 1n;
      described.notes.push('来源是 xa_head 本身（数组里不存在节点）');
      emit(described);
    }
    return {
      address,
      head,
      headKind: 'single-entry',
      rootNode: null,
      rootShift: 0,
      xaFlags,
      entries,
      nodesVisited,
      nodeAddresses,
      truncated,
      cycle,
      violations,
      notes,
      evidence,
    };
  }

  const rootNode = xaToNode(head);
  const root = await readXaNode(view, layout, rootNode);
  if ((indexMin >> BigInt(root.shift)) > BigInt(XA_CHUNK_MASK)) {
    notes.push(
      `要查的下标 ${toHex(indexMin)} 右移根节点的 ${root.shift} 位后还是超出 ${XA_CHUNK_SIZE} 个槽：`
      + '这个下标已经出了这棵树的覆盖范围（源码同样情形下直接返回"没这个下标"）',
    );
    return {
      address,
      head,
      headKind: 'node',
      rootNode,
      rootShift: root.shift,
      xaFlags,
      entries,
      nodesVisited,
      nodeAddresses,
      truncated,
      cycle,
      violations,
      notes,
      evidence,
    };
  }
  // 复用已读取根节点的字节与 shift。
  await walkNodeWithFirst(rootNode, root);
  return {
    address,
    head,
    headKind: 'node',
    rootNode,
    rootShift: root.shift,
    xaFlags,
    entries,
    nodesVisited,
    nodeAddresses,
    truncated,
    cycle,
    violations,
    notes,
    evidence,
  };

  /** 把"已经读好的根节点"塞进遍历，避免重复读一次。 */
  async function walkNodeWithFirst(first: bigint, facts: XaNodeFacts): Promise<void> {
    const key = first.toString(16);
    seen.add(key);
    nodesVisited += 1;
    nodeAddresses.push(first);
    const siblings = new Map<number, number>();
    for (let slot = 0; slot < XA_CHUNK_SIZE; slot += 1) {
      const raw = xaSlotAt(facts.slots, slot);
      if (raw === 0n) continue;
      if (xaIsSibling(raw, multi)) {
        const owner = Number(xaToSibling(raw));
        siblings.set(owner, (siblings.get(owner) ?? 0) + 1);
      }
    }
    for (let slot = 0; slot < XA_CHUNK_SIZE; slot += 1) {
      const raw = xaSlotAt(facts.slots, slot);
      if (raw === 0n) continue;
      if (xaIsSibling(raw, multi)) continue;
      const index = BigInt(slot) << BigInt(facts.shift);
      const span = BigInt(1 + (siblings.get(slot) ?? 0)) << BigInt(facts.shift);
      if (xaIsNode(raw)) {
        await walkNode(xaToNode(raw), index, facts.shift - XA_CHUNK_SHIFT);
        continue;
      }
      if (index + span - 1n < indexMin || index > indexMax) continue;
      const described = describeRaw(raw, first, facts.shift);
      described.index = index;
      described.span = span;
      described.slot = slot;
      if (!emit(described)) return;
    }
  }
}

/* --------------------------------------------------------------------------
 * XArray：按下标取单个条目（`xas_load` 的等价物）
 * ------------------------------------------------------------------------ */

export interface XArrayLookup {
  address: bigint;
  index: bigint;
  /** 是否落在这棵树覆盖的范围里。false 表示"没这个下标" */
  inRange: boolean;
  /** 条目原始值；present=false 时为 0，对应内核 NULL */
  raw: bigint;
  present: boolean;
  kind: XArrayEntryKind | 'absent';
  value: bigint | null;
  pointer: bigint | null;
  /** 承载它的节点地址（下标 0 的顶层单条目时为 null） */
  node: bigint | null;
  nodeShift: number | null;
  /** 实际命中的槽号（兄弟条目已经跳回正主槽） */
  slot: number | null;
  /** 节点走过的每一步（调试与证据用） */
  steps: Array<{ node: bigint; shift: number; slot: number; raw: string }>;
  violations: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 按下标读取 XArray 条目，steps 记录逐级节点、槽位与原始值。 */
export async function readXarrayEntry(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  index: bigint,
  options: { xarrayMulti?: boolean; maxNodes?: number } = {},
): Promise<XArrayLookup> {
  const multi = options.xarrayMulti ?? true;
  const maxNodes = options.maxNodes ?? 8;
  const array = await readStruct(view, layout, XARRAY_TYPE, address);
  const head = array.u64('xa_head');
  const evidence = memoryEvidence(view.evidenceSource, address, array.bytes.length, [
    `type:${XARRAY_TYPE}`,
    `index:${toHex(index)}`,
  ]);
  const steps: XArrayLookup['steps'] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  const absent = (inRange: boolean, reason: string): XArrayLookup => {
    notes.push(reason);
    return {
      address,
      index,
      inRange,
      raw: 0n,
      present: false,
      kind: 'absent',
      value: null,
      pointer: null,
      node: null,
      nodeShift: null,
      slot: null,
      steps,
      violations,
      notes,
      evidence,
    };
  };

  if (head === 0n) return absent(true, 'xa_head 为 0：整个 XArray 是空的');

  if (!xaIsNode(head)) {
    if (index !== 0n) {
      return absent(true, 'xa_head 不是节点指针（只可能是下标 0 的条目），而这次查的下标不是 0');
    }
    const described = describeXaEntry(head);
    return {
      address,
      index,
      inRange: true,
      raw: u64(head),
      present: true,
      kind: described.kind,
      value: described.value,
      pointer: described.pointer,
      node: null,
      nodeShift: null,
      slot: null,
      steps,
      violations,
      notes: [...notes, '来源是 xa_head 本身（数组里不存在节点）', ...described.notes],
      evidence,
    };
  }

  let entry = head;
  let lastNode: XaNodeFacts | null = null;
  let hops = 0;
  const rootNode = await readXaNode(view, layout, xaToNode(head));
  if ((index >> BigInt(rootNode.shift)) > BigInt(XA_CHUNK_MASK)) {
    return absent(false, `下标右移根节点的 ${rootNode.shift} 位后超出 ${XA_CHUNK_SIZE} 个槽：这个下标不在树的覆盖范围内`);
  }
  while (xaIsNode(entry)) {
    if (hops >= maxNodes) {
      violations.push(`下降步数达到上限 ${maxNodes} 步仍未到底：这棵树可能成环`);
      break;
    }
    hops += 1;
    const node = hops === 1 ? rootNode : await readXaNode(view, layout, xaToNode(entry));
    lastNode = node;
    const step = await xaDescend(view, node, index, multi);
    steps.push({ node: node.address, shift: node.shift, slot: step.slot, raw: toHex(step.entry) });
    if (step.violation !== null) violations.push(step.violation);
    entry = step.entry;
    if (node.shift === 0) break;
  }

  if (entry === 0n) return absent(true, '走到叶子层的那个槽是空指针：这个下标没有条目');
  if (xaIsRetry(entry)) {
    return {
      address,
      index,
      inRange: true,
      raw: u64(entry),
      present: false,
      kind: 'retry',
      value: null,
      pointer: null,
      node: lastNode === null ? null : lastNode.address,
      nodeShift: lastNode === null ? null : lastNode.shift,
      slot: steps.length === 0 ? null : steps[steps.length - 1].slot,
      steps,
      violations,
      notes: [...notes, '读到 retry 条目：内核在同样情形下会重新走一遍，这里如实报"这次没拿到"'],
      evidence,
    };
  }

  const described = describeXaEntry(entry);
  return {
    address,
    index,
    inRange: true,
    raw: u64(entry),
    present: true,
    kind: described.kind,
    value: described.value,
    pointer: described.pointer,
    node: lastNode === null ? null : lastNode.address,
    nodeShift: lastNode === null ? null : lastNode.shift,
    slot: steps.length === 0 ? null : steps[steps.length - 1].slot,
    steps,
    violations,
    notes: [...notes, ...described.notes],
    evidence,
  };
}

/** 把一个原始条目分类（`walkXarray` 与 `readXarrayEntry` 共用同一套判据）。 */
export function describeXaEntry(raw: bigint): {
  kind: XArrayEntryKind;
  value: bigint | null;
  pointer: bigint | null;
  notes: string[];
} {
  if (xaIsZero(raw)) return { kind: 'zero', value: null, pointer: null, notes: ['保留条目（明确的"0"占位）'] };
  if (xaIsRetry(raw)) return { kind: 'retry', value: null, pointer: null, notes: ['retry 条目'] };
  if (xaIsValue(raw)) return { kind: 'value', value: xaToValue(raw), pointer: null, notes: [] };
  if (xaIsInternal(raw)) {
    const err = xaErr(raw);
    return {
      kind: err !== 0 ? 'error' : 'internal-unknown',
      value: null,
      pointer: null,
      notes: [
        err !== 0
          ? `错误条目：errno = ${err}`
          : `不认识的内部条目（xa_to_internal = ${toHex(xaToInternal(raw))}）`,
      ],
    };
  }
  return { kind: 'pointer', value: null, pointer: u64(raw), notes: [] };
}

/* --------------------------------------------------------------------------
 * fd 表：files_struct → fdtable → fd 数组与三张位图
 * ------------------------------------------------------------------------ */

export interface KernelFdtable {
  address: bigint;
  /** `max_fds`：这张表能装多少个 fd；源码保证它是 BITS_PER_LONG 的整数倍 */
  maxFds: number;
  /** `&fdt->fd[0]` */
  fdArray: bigint | null;
  closeOnExec: bigint | null;
  openFds: bigint | null;
  fullFdsBits: bigint | null;
  /** 内嵌 fdt->rcu 结构的地址，供 RCU 释放回调使用。 */
  rcuHead: bigint;
  evidence: EvidenceRef;
}

/** 读一个 `struct fdtable`。地址为 0 时抛错（`alloc_files()` 一定会给它赋上值）。 */
export async function readFdtable(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelFdtable> {
  if (address === 0n) {
    throw new FilesParseError(
      'null-fdtable',
      'fdtable 地址为 0：fd 表的指针不该是空的（alloc_files() 一定会把 fdt 指到内嵌的 fdtab）',
      { address: '0x0' },
    );
  }
  const fdt = await readStruct(view, layout, FDTABLE_TYPE, address);
  return {
    address,
    maxFds: fdt.u32('max_fds'),
    fdArray: fdt.pointer('fd'),
    closeOnExec: fdt.pointer('close_on_exec'),
    openFds: fdt.pointer('open_fds'),
    fullFdsBits: fdt.pointer('full_fds_bits'),
    rcuHead: fdt.addressOf('rcu'),
    evidence: memoryEvidence(view.evidenceSource, address, fdt.bytes.length, [
      `type:${FDTABLE_TYPE}`,
      `max_fds:${fdt.u32('max_fds')}`,
    ]),
  };
}

export interface KernelFiles {
  address: bigint;
  /** `files_struct.count`：这个打开文件表被多少份（fork 出来的）表共享 */
  count: number;
  resizeInProgress: boolean;
  nextFd: number;
  /** `files->fdt` 指向的那份 fdtable —— 内核实际在用的就是这一份 */
  fdtable: KernelFdtable;
  /** fdt 是否等于内嵌 files->fdtab 的地址 */
  inlineFdtable: boolean;
  inlineFdtableAddress: bigint;
  /** 内嵌那三张位图与 fd 数组的地址（用来核对 `fdt` 里的指针是不是指向它们） */
  inlineArrays: { fdArray: bigint; openFds: bigint; closeOnExec: bigint; fullFdsBits: bigint };
  /** `fd_array` 的元素个数（`NR_OPEN_DEFAULT`，x86_64 上是 64） */
  fdArrayCount: number;
  /** `unsigned long` 的字节宽度（位图按它分字） */
  wordBytes: number;
  notes: string[];
  evidence: EvidenceRef;
}

/** 沿 files->fdt 读取活动 fdtable，报告内嵌或动态分配来源及 resize_in_progress。 */
export async function readFiles(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelFiles> {
  if (address === 0n) {
    throw new FilesParseError(
      'null-files',
      'files_struct 地址为 0：内核线程与已经退出的任务本来就没有打开文件表，这不是读取失败',
      { address: '0x0' },
    );
  }
  const files = await readStruct(view, layout, FILES_TYPE, address);
  const notes: string[] = [];
  const inlineFdtableAddress = files.addressOf('fdtab');
  const inlineArrays = {
    fdArray: files.addressOf('fd_array'),
    openFds: files.addressOf('open_fds_init'),
    closeOnExec: files.addressOf('close_on_exec_init'),
    fullFdsBits: files.addressOf('full_fds_bits_init'),
  };
  const fdArrayField = files.field('fd_array');
  const fdArrayCount = fdArrayField.byteSize === null ? 0 : fdArrayField.byteSize / 8;
  const wordBytes = files.field('open_fds_init').byteSize ?? 8;

  const fdtPointer = files.pointer('fdt');
  if (fdtPointer === null) {
    throw new FilesParseError(
      'null-fdt',
      'files_struct.fdt 是空指针：`alloc_files()` 会把它指到内嵌的 fdtab 上，所以这里为空说明'
      + '这份结构还没初始化完（或者内存已经变了）',
      { files: toHex(address) },
    );
  }
  const fdtable = await readFdtable(view, layout, fdtPointer);
  const inlineFdtable = fdtPointer === inlineFdtableAddress;
  if (inlineFdtable) {
    notes.push(
      'fdt 指向的就是内嵌的 fdtab：这张表还没扩容过，fd 数组与三张位图都在 files_struct 内部'
      + `（max_fds = ${fdtable.maxFds} = NR_OPEN_DEFAULT）`,
    );
    if (fdtable.fdArray !== null && fdtable.fdArray !== inlineArrays.fdArray) {
      notes.push(
        `fdt->fd 是 ${toHex(fdtable.fdArray)}，而内嵌 fd_array 在 ${toHex(inlineArrays.fdArray)}：`
        + '两者不一致（源码在 alloc_files() 里会把它指到内嵌数组上）',
      );
    }
  } else {
    notes.push(
      'fdt 指向的是另一份 fdtable（不是内嵌的 fdtab）：说明这张表扩容过，'
      + '此时 files->fdtab 里那份是陈旧数据，读它会把 fd 表读错',
    );
  }
  const resizeInProgress = files.has('resize_in_progress')
    ? Number(files.value('resize_in_progress', false)) !== 0
    : false;
  if (resizeInProgress) {
    notes.push('resize_in_progress 为真：内核正在换 fd 表，这一帧读到的 fdt 可能不是最终那份');
  }

  return {
    address,
    count: files.u32('count'),
    resizeInProgress,
    nextFd: files.u32('next_fd'),
    fdtable,
    inlineFdtable,
    inlineFdtableAddress,
    inlineArrays,
    fdArrayCount,
    wordBytes,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, files.bytes.length, [
      `type:${FILES_TYPE}`,
      `fdt:${toHex(fdtPointer)}`,
      `fdt-source:${inlineFdtable ? 'inline-fdtab' : 'expanded'}`,
    ]),
  };
}

export interface FdBitmaps {
  maxFds: number;
  /** `open_fds` 的每个字（`unsigned long`） */
  openFds: bigint[];
  closeOnExec: bigint[];
  fullFdsBits: bigint[];
  /** 位图里立着的位数（= 打开的 fd 个数，只数到 max_fds 为止） */
  openCount: number;
  notes: string[];
  evidence: EvidenceRef;
}

function popcount64(value: bigint): number {
  let rest = u64(value);
  let count = 0;
  while (rest !== 0n) {
    rest &= rest - 1n;
    count += 1;
  }
  return count;
}

/**
 * 读 fd 表的三张位图。
 *
 * `full_fds_bits` 是"哪些字是全 1"的加速位图（`open_fd()` 里：
 * `if (!~fdt->open_fds[fd]) __set_bit(fd, fdt->full_fds_bits)`），所以它按"open_fds 的字号"
 * 分位 —— 即第 `i` 位对应 `open_fds[i]` 这个字。把它和 open_fds 同样按 64 位分字是错的：
 * 一个 64 个 fd 的表里只有一个 `open_fds` 字，`full_fds_bits` 只需要一位。
 */
export async function readFdBitmaps(
  view: KernelMemoryView,
  layout: KernelLayout,
  files: KernelFiles,
): Promise<FdBitmaps> {
  const fdt = files.fdtable;
  const notes: string[] = [];
  const wordBits = files.wordBytes * 8;
  const openWords = Math.ceil(fdt.maxFds / wordBits);
  const fullWords = Math.ceil(Math.max(1, fdt.maxFds / wordBits) / wordBits);
  const readWords = async (base: bigint | null, count: number, what: string): Promise<bigint[]> => {
    const out: bigint[] = [];
    if (base === null) {
      notes.push(`${what} 的指针是空的：这张位图读不到`);
      return out;
    }
    for (let index = 0; index < count; index += 1) {
      const address = base + BigInt(index * files.wordBytes);
      out.push(files.wordBytes === 8 ? await view.u64(address) : BigInt(await view.uint(address, files.wordBytes)));
    }
    return out;
  };
  const openFds = await readWords(fdt.openFds, openWords, 'fdt->open_fds');
  const closeOnExec = await readWords(fdt.closeOnExec, openWords, 'fdt->close_on_exec');
  const fullFdsBits = await readWords(fdt.fullFdsBits, fullWords, 'fdt->full_fds_bits');

  let openCount = 0;
  for (let index = 0; index < openWords; index += 1) {
    const word = openFds[index] ?? 0n;
    // 最后一个字可能有多余的位（max_fds 之外的），只数 max_fds 以内的。
    const limit = fdt.maxFds - index * wordBits;
    const masked = limit >= wordBits ? word : word & ((1n << BigInt(limit)) - 1n);
    openCount += popcount64(masked);
  }

  if (fdt.maxFds % wordBits !== 0) {
    notes.push(
      `max_fds = ${fdt.maxFds} 不是 ${wordBits} 的整数倍：fs/file.c 的注释明确说它"永远是`
      + 'BITS_PER_LONG 的整数倍"，这个值说明结构可能读偏了',
    );
  }
  return {
    maxFds: fdt.maxFds,
    openFds,
    closeOnExec,
    fullFdsBits,
    openCount,
    notes,
    evidence: memoryEvidence(view.evidenceSource, fdt.openFds ?? fdt.address, openWords * files.wordBytes, [
      `max_fds:${fdt.maxFds}`,
      `open_fds:${fdt.openFds === null ? 'null' : toHex(fdt.openFds)}`,
    ]),
  };
}

export interface OpenFdEntry {
  fd: number;
  /** `fd_array[fd]`：`struct file *` */
  fileAddress: bigint;
  /** `fd_array[fd]` 这个槽本身的地址 */
  slotAddress: bigint;
  closeOnExec: boolean;
  /** 位图说这个 fd 开着，但槽里是空指针（结构自相矛盾） */
  inconsistent: boolean;
}

export interface OpenFdList {
  entries: OpenFdEntry[];
  bitmaps: FdBitmaps;
  truncated: boolean;
  violations: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 按 open_fds 位图列出 fd；位为 1 而 file 槽为空时记录结构矛盾。 */
export async function listOpenFds(
  view: KernelMemoryView,
  layout: KernelLayout,
  files: KernelFiles,
  options: { limit?: number } = {},
): Promise<OpenFdList> {
  const limit = options.limit ?? 1024;
  const bitmaps = await readFdBitmaps(view, layout, files);
  const entries: OpenFdEntry[] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  const fdt = files.fdtable;
  let truncated = false;
  for (let fd = 0; fd < fdt.maxFds; fd += 1) {
    const word = bitmaps.openFds[Math.floor(fd / (files.wordBytes * 8))] ?? 0n;
    const bit = (word >> BigInt(fd % (files.wordBytes * 8))) & 1n;
    if (bit === 0n) continue;
    if (entries.length >= limit) {
      truncated = true;
      notes.push(`达到 fd 条数上限 ${limit}，停止列举`);
      break;
    }
    if (fdt.fdArray === null) {
      violations.push(`位图说 fd ${fd} 开着，但 fdt->fd 指针是空的，读不到 fd 数组`);
      break;
    }
    const slotAddress = fdt.fdArray + BigInt(fd * 8);
    const fileAddress = await view.u64(slotAddress);
    const cexWord = bitmaps.closeOnExec[Math.floor(fd / (files.wordBytes * 8))] ?? 0n;
    entries.push({
      fd,
      fileAddress,
      slotAddress,
      closeOnExec: ((cexWord >> BigInt(fd % (files.wordBytes * 8))) & 1n) === 1n,
      inconsistent: fileAddress === 0n,
    });
    if (fileAddress === 0n) {
      violations.push(`位图说 fd ${fd} 开着，但 fd_array[${fd}]（${toHex(slotAddress)}）是空指针`);
    }
  }
  return {
    entries,
    bitmaps,
    truncated,
    violations,
    notes,
    evidence: memoryEvidence(view.evidenceSource, fdt.fdArray ?? fdt.address, entries.length * 8, [
      `open-fds:${entries.length}`,
      `max_fds:${fdt.maxFds}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * struct file
 * ------------------------------------------------------------------------ */

export interface KernelFileRaState {
  start: bigint;
  size: number;
  asyncSize: number;
  raPages: number;
  mmapMiss: number;
  prevPos: bigint;
}

export interface KernelFilePath {
  /** `&file->f_path` */
  address: bigint;
  mnt: bigint | null;
  dentry: bigint | null;
  notes: string[];
}

export interface KernelFile {
  address: bigint;
  /** 这个 file 是从哪个 fd 找到的；直接按地址读时为 null */
  fd: number | null;
  fCount: bigint;
  fMode: number;
  fModeNames: string[];
  fModeUnknownBits: number;
  fFlags: number;
  fFlagsDecoded: OpenFlagDecode;
  fIocbFlags: number;
  fPos: bigint;
  fOp: bigint | null;
  fInode: bigint | null;
  fMapping: bigint | null;
  privateData: bigint | null;
  fCred: bigint | null;
  fSecurity: bigint | null;
  fOwner: bigint | null;
  fEp: bigint | null;
  fWbErr: number;
  fSbErr: number;
  fRa: KernelFileRaState | null;
  path: KernelFilePath;
  notes: string[];
  evidence: EvidenceRef;
}

/** 读取 file：f_ra 带 union 来源说明，f_mapping 为空时保留 inode 映射入口，f_count 按 64 位读取。 */
export async function readFile(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: { fd?: number | null; enabledConfigs?: Set<string> | null } = {},
): Promise<KernelFile> {
  if (address === 0n) {
    throw new FilesParseError('null-file', 'struct file 地址为 0：fd 数组里为空就表示这个 fd 没打开', {});
  }
  const file = await readStruct(view, layout, FILE_TYPE, address);
  const notes: string[] = [];
  const fMode = file.u32('f_mode');
  const fFlags = file.u32('f_flags');
  const modeDecoded = decodeFlagBits(fMode, FMODE_BITS, options.enabledConfigs ?? null);

  let fRa: KernelFileRaState | null = null;
  if (file.has('f_ra.start')) {
    try {
      fRa = {
        start: BigInt(file.value('f_ra.start', false)),
        size: Number(file.value('f_ra.size', false)),
        asyncSize: Number(file.value('f_ra.async_size', false)),
        raPages: Number(file.value('f_ra.ra_pages', false)),
        mmapMiss: Number(file.value('f_ra.mmap_miss', false)),
        prevPos: BigInt(file.value('f_ra.prev_pos', true)),
      };
      notes.push(
        'f_ra 与 f_llist/f_freeptr/f_task_work 在源码里是同一个 union 的成员：'
        + '这四者共用同一段字节，所以 f_ra 只有在这个 file 真的拿它做预读时才有意义',
      );
    } catch (error) {
      notes.push(`读 f_ra 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push('布局清单里没有 file.f_ra（或它的内层字段），预读状态读不出来');
  }

  const fMapping = file.pointer('f_mapping');
  const fInode = file.pointer('f_inode');
  if (fMapping === null && fInode !== null) {
    notes.push('f_mapping 为空但 f_inode 不为空：映射要看 f_inode->i_mapping（两者通常指向同一个 address_space）');
  }

  return {
    address,
    fd: options.fd ?? null,
    fCount: file.u64('f_count'),
    fMode,
    fModeNames: modeDecoded.names.map((entry) => entry.name),
    fModeUnknownBits: modeDecoded.unknownBits,
    fFlags,
    fFlagsDecoded: decodeOpenFlags(fFlags, options.enabledConfigs ?? null),
    fIocbFlags: file.u32('f_iocb_flags'),
    fPos: file.s64('f_pos'),
    fOp: file.pointer('f_op'),
    fInode,
    fMapping,
    privateData: file.pointer('private_data'),
    fCred: file.pointer('f_cred'),
    fSecurity: file.has('f_security') ? file.pointer('f_security') : null,
    fOwner: file.has('f_owner') ? file.pointer('f_owner') : null,
    fEp: file.has('f_ep') ? file.pointer('f_ep') : null,
    fWbErr: file.has('f_wb_err') ? file.u32('f_wb_err') : 0,
    fSbErr: file.has('f_sb_err') ? file.u32('f_sb_err') : 0,
    fRa,
    path: await readFilePath(view, layout, file.addressOf('f_path')),
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, file.bytes.length, [
      `type:${FILE_TYPE}`,
      `fd:${options.fd ?? 'n/a'}`,
      `f_inode:${fInode === null ? 'null' : toHex(fInode)}`,
    ]),
  };
}

/** 读一个 `struct path`（`vfsmount` + `dentry` 两个指针）。 */
export async function readFilePath(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelFilePath> {
  const path = await readStruct(view, layout, PATH_TYPE, address);
  return {
    address,
    mnt: path.pointer('mnt'),
    dentry: path.pointer('dentry'),
    notes: [],
  };
}

export interface KernelVfsmount {
  address: bigint;
  rootDentry: bigint | null;
  superBlock: bigint | null;
  flags: number;
  idmap: bigint | null;
  evidence: EvidenceRef;
}

/** 读一个 `struct vfsmount`（挂载点：根 dentry + 所属超级块 + 挂载标志）。 */
export async function readVfsmount(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelVfsmount> {
  if (address === 0n) {
    throw new FilesParseError('null-vfsmount', 'vfsmount 地址为 0', {});
  }
  const mount = await readStruct(view, layout, VFSMOUNT_TYPE, address);
  return {
    address,
    rootDentry: mount.pointer('mnt_root'),
    superBlock: mount.pointer('mnt_sb'),
    flags: mount.s32('mnt_flags'),
    idmap: mount.has('mnt_idmap') ? mount.pointer('mnt_idmap') : null,
    evidence: memoryEvidence(view.evidenceSource, address, mount.bytes.length, [`type:${VFSMOUNT_TYPE}`]),
  };
}

/* dentry 和 qstr：内嵌或外部名字存储。 */

export interface KernelQstr {
  address: bigint;
  hash: number;
  len: number;
  /** `qstr` 里那个 `union { {u32 hash; u32 len;}; u64 hash_len; }` 的原始 8 字节 */
  hashLenRaw: bigint;
  nameAddress: bigint | null;
  notes: string[];
}

/** 读 `struct qstr`：`hash`/`len` 与 `name` 指针。 */
export async function readQstr(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelQstr> {
  const qstr = await readStruct(view, layout, QSTR_TYPE, address);
  const notes: string[] = [];
  const len = qstr.u32('len');
  const hash = qstr.u32('hash');
  if (qstr.has('hash_len')) {
    const raw = qstr.u64('hash_len');
    // `HASH_LEN_DECLARE` 在 64 位上是 `u32 hash; u32 len;`，两级拼成一个 u64：
    // 低 32 位是 hash，高 32 位是 len（小端下 hash 在前）。这里对账一次，
    // 因为"哪一半是 len"读反了会让名字长度变成一个巨大的数，然后去读一段无界内存。
    const low = Number(raw & 0xffffffffn);
    const high = Number((raw >> 32n) & 0xffffffffn);
    if (low !== hash || high !== len) {
      notes.push(
        `qstr.hash_len 的拆法与按字段读出来的不一致（hash_len=${toHex(raw)} → hash=${low} len=${high}，`
        + `而字段读出 hash=${hash} len=${len}）：这份布局里 hash/len 的顺序与源码 HASH_LEN_DECLARE 的 `
        + '"u32 hash; u32 len" 写法不同',
      );
    }
  }
  return { address, hash, len, hashLenRaw: qstr.has('hash_len') ? qstr.u64('hash_len') : 0n, nameAddress: qstr.pointer('name'), notes };
}

export interface KernelDentryName {
  hash: number;
  len: number;
  nameAddress: bigint | null;
  /** `&dentry->d_iname`：内嵌名字数组的地址 */
  inlineAddress: bigint;
  inlineCapacity: number;
  /** `d_name.name != d_iname`（内核 `dname_external()` 的同一判据）；名字指针为空时为 null */
  external: boolean | null;
  text: string | null;
  unavailableReason: string | null;
  /** 已读名字长度与 d_name.len 的一致性，长度取结尾零之前的字节数 */
  consistent: boolean | null;
  notes: string[];
}

export interface KernelDentry {
  address: bigint;
  dFlags: number;
  dFlagsDecoded: DentryFlagDecode;
  parent: bigint | null;
  inode: bigint | null;
  name: KernelDentryName;
  superBlock: bigint | null;
  dentryOps: bigint | null;
  /** 父指针是否指向自己（源码里根 dentry 的正常形态） */
  isSelfParent: boolean;
  notes: string[];
  evidence: EvidenceRef;
}

/** d_name.name 指向 d_iname 时从结构字节切取，指向外部时读取 len 字节，空指针时记录缺口。 */
export async function readDentry(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: { maxNameBytes?: number; enabledConfigs?: Set<string> | null } = {},
): Promise<KernelDentry> {
  if (address === 0n) {
    throw new FilesParseError('null-dentry', 'dentry 地址为 0：路径里没有目录项', {});
  }
  const dentry = await readStruct(view, layout, DENTRY_TYPE, address);
  const notes: string[] = [];
  const dFlags = dentry.u32('d_flags');
  const inameField = dentry.field('d_iname');
  const inlineCapacity = inameField.byteSize ?? 0;
  const qstr = await readQstr(view, layout, dentry.addressOf('d_name'));
  notes.push(...qstr.notes);

  const maxNameBytes = options.maxNameBytes ?? 4096;
  const name: KernelDentryName = {
    hash: qstr.hash,
    len: qstr.len,
    nameAddress: qstr.nameAddress,
    inlineAddress: dentry.addressOf('d_iname'),
    inlineCapacity,
    external: null,
    text: null,
    unavailableReason: null,
    consistent: null,
    notes: [],
  };

  if (qstr.nameAddress === null) {
    name.unavailableReason = 'd_name.name 是空指针：这个名字这次读不到（结构未填完或内存已变）';
  } else if (qstr.len > maxNameBytes) {
    name.unavailableReason = `d_name.len = ${qstr.len} 超过上限 ${maxNameBytes} 字节：不按这个长度去读内存`;
  } else {
    name.external = qstr.nameAddress !== name.inlineAddress;
    try {
      if (!name.external) {
        // 内嵌名字：直接从已经读进来的 dentry 字节里切，省一次内存读，也避免读到别的时刻。
        const slice = dentry.bytes.subarray(inameField.byteOffset, inameField.byteOffset + inlineCapacity);
        const zero = slice.indexOf(0);
        const end = zero < 0 ? Math.min(qstr.len, slice.length) : Math.min(zero, qstr.len);
        name.text = Buffer.from(slice.subarray(0, end)).toString('utf8');
        name.consistent = end === qstr.len;
        if (!name.consistent) {
          name.notes.push(
            `内嵌名字里第 ${end} 字节就是结尾 0，而 d_name.len = ${qstr.len}：两者对不上`,
          );
        }
        if (qstr.len > inlineCapacity - 1) {
          name.notes.push(
            `d_name.len = ${qstr.len} 超过了内嵌数组能放的长度（DNAME_INLINE_LEN - 1 = ${inlineCapacity - 1}）：`
            + '按源码 `__d_alloc()` 的分支，这么长的名字应该放在外部，这里却指回 d_iname',
          );
        }
      } else {
        const bytes = await view.bytes(qstr.nameAddress, qstr.len);
        name.text = Buffer.from(bytes).toString('utf8');
        name.consistent = true;
      }
    } catch (error) {
      name.unavailableReason = `读名字失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (qstr.len === 0) {
    name.notes.push('d_name.len 为 0：这是文件系统根 dentry 的正常形态（根的名字是空的）');
  }

  const parent = dentry.pointer('d_parent');
  return {
    address,
    dFlags,
    dFlagsDecoded: decodeDentryFlags(dFlags, options.enabledConfigs ?? null),
    parent,
    inode: dentry.pointer('d_inode'),
    name,
    superBlock: dentry.pointer('d_sb'),
    dentryOps: dentry.pointer('d_op'),
    isSelfParent: parent === address,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, dentry.bytes.length, [
      `type:${DENTRY_TYPE}`,
      `d_name.len:${qstr.len}`,
      `d_name.name:${qstr.nameAddress === null ? 'null' : toHex(qstr.nameAddress)}`,
      `d_name.source:${name.external === null ? 'unknown' : name.external ? 'external' : 'inline'}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * 路径：从 d_parent 走回根
 * ------------------------------------------------------------------------ */

export interface PathComponent {
  dentry: bigint;
  name: string | null;
  inode: bigint | null;
  /** 这一级是挂载点（`d_flags` 里立着 `DCACHE_MOUNTED`） */
  mountPoint: boolean;
  /** 读这一级时出现的问题 */
  issue: string | null;
}

export interface PathResolution {
  start: bigint;
  /** 从根往下排列的各级（`components[0]` 是根那一级） */
  components: PathComponent[];
  /** 从根往下拼出来的路径；拼不出（某一级名字读不到）时为 null */
  path: string | null;
  /** 是否走到了链条的尽头（`d_parent == self`） */
  rooted: boolean;
  depth: number;
  truncated: boolean;
  cycle: boolean;
  issues: string[];
  notes: string[];
  evidence: EvidenceRef;
}

export const DEFAULT_MAX_PATH_DEPTH = 64;

/** 沿 d_parent 回溯并记录终止原因：自指根、空父指针、重复节点和深度上限。 */
export async function resolveDentryPath(
  view: KernelMemoryView,
  layout: KernelLayout,
  dentryAddress: bigint,
  options: { maxDepth?: number; maxNameBytes?: number; enabledConfigs?: Set<string> | null } = {},
): Promise<PathResolution> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PATH_DEPTH;
  const components: PathComponent[] = [];
  const issues: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let cycle = false;
  let rooted = false;
  let cursor: bigint | null = dentryAddress;

  while (cursor !== null) {
    const key = cursor.toString(16);
    if (seen.has(key)) {
      cycle = true;
      issues.push(`d_parent 链在 ${toHex(cursor)} 处回到已访问过的 dentry：出现了环`);
      break;
    }
    seen.add(key);
    if (components.length >= maxDepth) {
      truncated = true;
      issues.push(`路径深度达到上限 ${maxDepth} 级，停止；上面还有父目录没走`);
      break;
    }
    let dentry: KernelDentry;
    try {
      dentry = await readDentry(view, layout, cursor, {
        maxNameBytes: options.maxNameBytes,
        enabledConfigs: options.enabledConfigs ?? null,
      });
    } catch (error) {
      issues.push(`读 dentry ${toHex(cursor)} 失败：${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    components.push({
      dentry: cursor,
      name: dentry.name.text,
      inode: dentry.inode,
      mountPoint: dentry.dFlagsDecoded.names.some((entry) => entry.name === 'DCACHE_MOUNTED'),
      issue: dentry.name.unavailableReason,
    });
    if (dentry.name.unavailableReason !== null && dentry.name.text === null) {
      issues.push(`dentry ${toHex(cursor)} 的名字读不到：${dentry.name.unavailableReason}`);
    }
    if (dentry.isSelfParent) {
      rooted = true;
      break;
    }
    if (dentry.parent === null) {
      issues.push(`dentry ${toHex(cursor)} 的 d_parent 为空：链条断在这里（源码里根 dentry 会指向自己，不是空）`);
      break;
    }
    cursor = dentry.parent;
  }

  // 逐级名字齐全时从根往下拼接路径。
  // 名字读取缺口导致整条路径返回 null。
  const ordered = [...components].reverse();
  let path: string | null = '/';
  const missing = ordered.findIndex((entry) => entry.name === null);
  if (missing >= 0) {
    path = null;
    notes.push(
      `从根往下的第 ${missing + 1} 级（dentry ${toHex(ordered[missing].dentry)}）名字读不到，`
      + '所以整条路径不给：跳过去拼出来的路径会少一段，而它看起来仍然像一条正常路径',
    );
  } else {
    // 确认根节点后跳过其名称，保留中间目录名。
    // 根可使用 slash 名称，路径前缀统一由 join 构造。
    // 断链或截断时首项仍作为真实目录名处理。
    // 拼接依据 reachedRoot 区分根和局部路径。
    const segments = ordered
      .map((entry, index) => ({ name: entry.name as string, index }))
      .filter((entry) => {
        if (entry.index !== 0) return true;
        if (!rooted) return true;
        return entry.name !== '' && entry.name !== '/';
      })
      .map((entry) => entry.name);
    path = `/${segments.join('/')}`;
  }
  if (!rooted && !truncated && !cycle) {
    notes.push('没有走到"父目录是自己"这个终止条件：路径可能不完整');
  }
  if (ordered.length > 0 && ordered[0].mountPoint) {
    notes.push(
      `路径最上面那一级（dentry ${toHex(ordered[0].dentry)}）带 DCACHE_MOUNTED：`
      + '它是另一个文件系统的根，d_parent 链在这里就断了（挂载点之上要另看 vfsmount）',
    );
  }

  return {
    start: dentryAddress,
    // 走的时候是"从叶子往根"，返回给调用方的是**从根往下**（与上面的字段说明一致，
    // 也与面板上要打印的顺序一致）。
    components: ordered,
    path,
    rooted,
    depth: components.length,
    truncated,
    cycle,
    issues,
    notes,
    evidence: memoryEvidence(view.evidenceSource, dentryAddress, 8, [
      `path:${path ?? 'unavailable'}`,
      `depth:${components.length}`,
      ...components.slice(0, 16).map((entry) => `dentry:${toHex(entry.dentry)}`),
    ]),
  };
}

/* --------------------------------------------------------------------------
 * inode 与 super_block
 * ------------------------------------------------------------------------ */

export interface KernelInode {
  address: bigint;
  mode: number;
  modeDecoded: { type: string; typeRaw: number; permissions: string };
  uid: number;
  gid: number;
  flags: number;
  ino: bigint;
  nlink: number;
  rdev: bigint;
  rdevDecoded: { major: bigint; minor: bigint; text: string };
  size: bigint;
  atimeSec: bigint;
  mtimeSec: bigint;
  ctimeSec: bigint;
  bytes: number;
  blkbits: number;
  writeHint: number;
  writeHintName: string | null;
  blocks: bigint;
  state: number;
  stateNames: string[];
  stateUnknownBits: number;
  dirty: boolean;
  dirtyTime: boolean;
  count: number;
  dioCount: number;
  writeCount: number;
  superBlock: bigint | null;
  mapping: bigint | null;
  inodeOps: bigint | null;
  fops: bigint | null;
  fsnotifyMask: number | null;
  isPrivate: bigint | null;
  notes: string[];
  evidence: EvidenceRef;
}

/** 读一个 `struct inode`。`i_mapping` 才是页缓存的入口（`i_data` 是它内嵌的那份）。 */
export async function readInode(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelInode> {
  if (address === 0n) {
    throw new FilesParseError(
      'null-inode',
      'inode 地址为 0：负 dentry（查过但不存在）的 d_inode 就是空，这是合法形态',
      {},
    );
  }
  const inode = await readStruct(view, layout, INODE_TYPE, address);
  const notes: string[] = [];
  const mode = inode.u16('i_mode');
  const state = inode.u32('i_state');
  const decodedState = decodeFlagBits(state, INODE_STATE_BITS, null);
  const rdev = BigInt(inode.u32('i_rdev'));
  const writeHint = inode.has('i_write_hint') ? Number(inode.value('i_write_hint', false)) : 0;
  let writeHintName: string | null = null;
  if (inode.has('i_write_hint')) {
    try {
      const enumerators = layout.type('rw_hint').enumerators;
      const found = enumerators.find((entry) => entry.value === writeHint);
      writeHintName = found === undefined ? null : found.name;
    } catch {
      writeHintName = null;
    }
  }
  const blocks = inode.s64('i_blocks');
  const blkbits = Number(inode.value('i_blkbits', false));

  return {
    address,
    mode,
    modeDecoded: decodeInodeMode(mode),
    uid: inode.u32('i_uid'),
    gid: inode.u32('i_gid'),
    flags: inode.u32('i_flags'),
    ino: inode.u64('i_ino'),
    nlink: inode.has('i_nlink') ? inode.u32('i_nlink') : inode.u32('__i_nlink'),
    rdev,
    rdevDecoded: { major: majorOf(rdev), minor: minorOf(rdev), text: describeDevice(rdev) },
    size: inode.s64('i_size'),
    atimeSec: inode.s64('i_atime_sec'),
    mtimeSec: inode.s64('i_mtime_sec'),
    ctimeSec: inode.s64('i_ctime_sec'),
    bytes: inode.u16('i_bytes'),
    blkbits,
    writeHint,
    writeHintName,
    blocks,
    state,
    stateNames: decodedState.names.map((entry) => entry.name),
    stateUnknownBits: decodedState.unknownBits,
    dirty: (state & INODE_DIRTY_MASK) !== 0,
    dirtyTime: (state & (1 << 11)) !== 0,
    count: inode.u32('i_count'),
    dioCount: inode.has('i_dio_count') ? inode.u32('i_dio_count') : 0,
    writeCount: inode.has('i_writecount') ? inode.u32('i_writecount') : 0,
    superBlock: inode.pointer('i_sb'),
    mapping: inode.pointer('i_mapping'),
    inodeOps: inode.pointer('i_op'),
    fops: inode.pointer('i_fop'),
    fsnotifyMask: inode.has('i_fsnotify_mask') ? inode.u32('i_fsnotify_mask') : null,
    isPrivate: inode.pointer('i_private'),
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, inode.bytes.length, [
      `type:${INODE_TYPE}`,
      `i_ino:${toHex(inode.u64('i_ino'))}`,
      `i_size:${inode.s64('i_size').toString()}`,
    ]),
  };
}

export interface KernelSuperBlock {
  address: bigint;
  dev: bigint;
  devDecoded: { major: bigint; minor: bigint; text: string };
  blocksize: bigint;
  blocksizeBits: number;
  maxbytes: bigint;
  fsType: bigint | null;
  superOps: bigint | null;
  flags: bigint;
  iflags: bigint;
  magic: bigint;
  rootDentry: bigint | null;
  count: number;
  active: number;
  id: string;
  fsInfo: bigint | null;
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 读一个 `struct super_block`。
 *
 * 为什么 T07d 也要读它：`inode->i_sb->s_dev` 才是"这个文件在哪个设备上"的正主，
 * `inode->i_rdev` 只对设备节点有意义（普通文件上是 0）。这两者混用会让面板把
 * 根文件系统的设备号显示成 0:0。
 */
export async function readSuperBlock(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelSuperBlock> {
  if (address === 0n) {
    throw new FilesParseError('null-superblock', 'super_block 地址为 0', {});
  }
  const sb = await readStruct(view, layout, SUPER_BLOCK_TYPE, address);
  const dev = inodeDevOf(sb.u32('s_dev'));
  return {
    address,
    dev,
    devDecoded: { major: majorOf(dev), minor: minorOf(dev), text: describeDevice(dev) },
    blocksize: sb.u64('s_blocksize'),
    blocksizeBits: Number(sb.value('s_blocksize_bits', false)),
    maxbytes: sb.s64('s_maxbytes'),
    fsType: sb.pointer('s_type'),
    superOps: sb.pointer('s_op'),
    flags: sb.u64('s_flags'),
    iflags: sb.has('s_iflags') ? sb.u64('s_iflags') : 0n,
    magic: sb.u64('s_magic'),
    rootDentry: sb.pointer('s_root'),
    count: sb.s32('s_count'),
    active: sb.u32('s_active'),
    id: sb.has('s_id') ? sb.cstring('s_id').text : '',
    fsInfo: sb.pointer('s_fs_info'),
    notes: [],
    evidence: memoryEvidence(view.evidenceSource, address, sb.bytes.length, [
      `type:${SUPER_BLOCK_TYPE}`,
      `s_id:${sb.has('s_id') ? sb.cstring('s_id').text : ''}`,
    ]),
  };
}

/** `s_dev`/`i_rdev` 都是 `dev_t`（`u32`），读出来直接转成 bigint。 */
function inodeDevOf(raw: number): bigint {
  return BigInt(raw >>> 0);
}

/* --------------------------------------------------------------------------
 * address_space 与页缓存
 * ------------------------------------------------------------------------ */

export interface KernelAddressSpace {
  address: bigint;
  host: bigint | null;
  /** `&mapping->i_pages`：页缓存 XArray 的地址 */
  pagesAddress: bigint;
  nrpages: bigint;
  writebackIndex: bigint;
  aOps: bigint | null;
  flags: bigint;
  gfpMask: number;
  mmapWritable: number;
  privateData: bigint | null;
  notes: string[];
  evidence: EvidenceRef;
}

/** 读一个 `struct address_space`。页缓存的入口是 `i_pages`（一个内嵌的 XArray）。 */
export async function readAddressSpace(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelAddressSpace> {
  if (address === 0n) {
    throw new FilesParseError(
      'null-address-space',
      'address_space 地址为 0：这个文件没有页缓存（普通文件的 i_mapping 不该为空）',
      {},
    );
  }
  const mapping = await readStruct(view, layout, ADDRESS_SPACE_TYPE, address);
  return {
    address,
    host: mapping.pointer('host'),
    pagesAddress: mapping.addressOf('i_pages'),
    nrpages: mapping.u64('nrpages'),
    writebackIndex: mapping.u64('writeback_index'),
    aOps: mapping.pointer('a_ops'),
    flags: mapping.u64('flags'),
    gfpMask: mapping.u32('gfp_mask'),
    mmapWritable: mapping.u32('i_mmap_writable'),
    privateData: mapping.pointer('i_private_data'),
    notes: [],
    evidence: memoryEvidence(view.evidenceSource, address, mapping.bytes.length, [
      `type:${ADDRESS_SPACE_TYPE}`,
      `nrpages:${mapping.u64('nrpages').toString()}`,
    ]),
  };
}

/** 把 `struct page *` 反推回页框号（`__pfn_to_page` 的逆运算）。 */
export function pfnForPageAddress(
  vmemmap: VmemmapFacts,
  address: bigint,
): { pfn: bigint | null; remainder: bigint } {
  const offset = address - vmemmap.base;
  const remainder = offset % vmemmap.pageStructSize;
  if (offset < 0n || remainder !== 0n) return { pfn: null, remainder };
  return { pfn: offset / vmemmap.pageStructSize, remainder };
}

export interface PageCacheFolio {
  index: bigint;
  /** 页缓存槽里那个 `struct page *` */
  pageAddress: bigint;
  pfn: bigint | null;
  /** 页地址与 struct page 步长的对齐校验结果 */
  pfnRemainder: bigint;
  folio: KernelFolio | null;
  error: string | null;
  notes: string[];
}

export interface PageCacheResult {
  mapping: KernelAddressSpace;
  xarray: XArrayFacts;
  entries: PageCacheFolio[];
  vmemmap: VmemmapFacts | null;
  violations: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 限定读取页缓存，验证条目是普通页指针且 mapping 对应文件 address_space。
 * 条目种类、匿名标记、页地址与下标冲突分别记录为 violation。
 */
export async function readPageCache(
  view: KernelMemoryView,
  layout: KernelLayout,
  mapping: KernelAddressSpace,
  options: {
    indexMin?: bigint;
    indexMax?: bigint;
    maxEntries?: number;
    maxNodes?: number;
    xarrayMulti?: boolean;
    vmemmap?: VmemmapFacts;
    decodeFolios?: boolean;
  } = {},
): Promise<PageCacheResult> {
  const xarray = await walkXarray(view, layout, mapping.pagesAddress, {
    indexMin: options.indexMin,
    indexMax: options.indexMax,
    maxEntries: options.maxEntries,
    maxNodes: options.maxNodes,
    xarrayMulti: options.xarrayMulti,
  });
  const violations: string[] = [];
  const notes: string[] = [...xarray.notes];
  const entries: PageCacheFolio[] = [];
  let vmemmap = options.vmemmap ?? null;
  const decode = options.decodeFolios ?? true;

  for (const entry of xarray.entries) {
    const item: PageCacheFolio = {
      index: entry.index,
      pageAddress: entry.pointer ?? 0n,
      pfn: null,
      pfnRemainder: 0n,
      folio: null,
      error: null,
      notes: [],
    };
    if (entry.kind !== 'pointer' || entry.pointer === null) {
      item.error = `这个槽里的条目不是普通指针（kind=${entry.kind}）：页缓存里应当只放 struct page *`;
      violations.push(`${toHex(mapping.pagesAddress)} 下标 ${entry.index}：${item.error}`);
      entries.push(item);
      continue;
    }
    if (entry.pointer % 8n !== 0n) {
      item.error = `页指针 ${toHex(entry.pointer)} 不是 8 字节对齐：不像一个 struct page 地址`;
      violations.push(item.error);
      entries.push(item);
      continue;
    }
    if (vmemmap === null) {
      vmemmap = await resolveVmemmapBase(view, layout, { pfn: 0n });
    }
    const derived = pfnForPageAddress(vmemmap, entry.pointer);
    item.pfn = derived.pfn;
    item.pfnRemainder = derived.remainder;
    if (derived.pfn === null) {
      item.error =
        `页地址 ${toHex(entry.pointer)} 减掉 vmemmap 基址 ${toHex(vmemmap.base)} 之后`
        + `不是 sizeof(struct page) = ${vmemmap.pageStructSize} 的整数倍（余 ${derived.remainder}）：`
        + 'vmemmap 基址与本页不属于同一套映射，或这个槽里不是页指针';
      violations.push(item.error);
      entries.push(item);
      continue;
    }
    if (decode) {
      try {
        const folio = await readFolioForPfn(view, layout, { pfn: derived.pfn, vmemmap });
        item.folio = folio;
        if (folio.mappingIsAnon) {
          violations.push(
            `页缓存下标 ${entry.index} 的页（${toHex(folio.address)}）的 mapping 最低位立着：`
            + '那是匿名页的标记（PAGE_MAPPING_ANON），页缓存里不该出现匿名页',
          );
        }
        if (folio.mapping !== 0n && !folio.mappingIsAnon && folio.mapping !== mapping.address) {
          violations.push(
            `页缓存下标 ${entry.index} 的页的 mapping 是 ${toHex(folio.mapping)}，`
            + `不是被查询的 address_space ${toHex(mapping.address)}`,
          );
        }
        const expectedIndex = entry.index;
        if (folio.index !== expectedIndex) {
          violations.push(
            `页缓存下标 ${entry.index} 上的页自报 page->index = ${folio.index}：`
            + '两个下标不一致，说明页被挂到了别的位置',
          );
        }
      } catch (error) {
        item.error = `解 struct page 失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    entries.push(item);
  }

  return {
    mapping,
    xarray,
    entries,
    vmemmap,
    violations: [...xarray.violations, ...violations],
    notes,
    evidence: memoryEvidence(view.evidenceSource, mapping.pagesAddress, 16, [
      `i_pages:${toHex(mapping.pagesAddress)}`,
      `entries:${entries.length}`,
      `nodes:${xarray.nodesVisited}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * 整条链：task.files → fdtable → file → path/dentry/inode → address_space
 * ------------------------------------------------------------------------ */

export async function readFilesForTask(
  view: KernelMemoryView,
  layout: KernelLayout,
  task: KernelTask,
): Promise<KernelFiles | null> {
  if (task.files === null) {
    return null;
  }
  return readFiles(view, layout, task.files);
}

export interface FileChainMount {
  vfsmount: bigint | null;
  rootDentry: bigint | null;
  superBlock: bigint | null;
  flags: number | null;
}

export interface FileChain {
  files: KernelFiles;
  fd: number;
  /** `fd_array[fd]` 这个槽的地址 */
  fdSlotAddress: bigint;
  closeOnExec: boolean;
  file: KernelFile;
  path: PathResolution | null;
  dentry: KernelDentry | null;
  inode: KernelInode | null;
  mount: FileChainMount | null;
  superBlock: KernelSuperBlock | null;
  addressSpace: KernelAddressSpace | null;
  /** readPageCache=true 时返回本次页缓存解析结果，其他情形为 null */
  pageCache: PageCacheResult | null;
  notes: string[];
  evidence: EvidenceRef;
}

/** 按 fd 读取文件对象链，可选环节由选项控制，读取缺口写入 notes。 */
export async function readFileChain(
  view: KernelMemoryView,
  layout: KernelLayout,
  options: {
    files: KernelFiles;
    fd: number;
    resolvePath?: boolean;
    readSuperBlock?: boolean;
    readAddressSpace?: boolean;
    readPageCache?: boolean;
    pageCacheLimit?: number;
    enabledConfigs?: Set<string> | null;
  },
): Promise<FileChain> {
  const { files, fd } = options;
  const notes: string[] = [];
  const fdt = files.fdtable;
  if (fd < 0 || fd >= fdt.maxFds) {
    throw new FilesParseError(
      'fd-out-of-range',
      `fd ${fd} 超出这张 fd 表的范围（max_fds = ${fdt.maxFds}）`,
      { fd, maxFds: fdt.maxFds },
    );
  }
  if (fdt.fdArray === null) {
    throw new FilesParseError('fd-array-missing', 'fdt->fd 指针为空，取不到 fd 数组', { fd });
  }
  const fdSlotAddress = fdt.fdArray + BigInt(fd * 8);
  const fileAddress = await view.u64(fdSlotAddress);
  if (fileAddress === 0n) {
    throw new FilesParseError(
      'fd-not-open',
      `fd ${fd} 的槽（${toHex(fdSlotAddress)}）是空指针：这个 fd 没有打开的文件`,
      { fd, slot: toHex(fdSlotAddress) },
    );
  }
  const file = await readFile(view, layout, fileAddress, { fd, enabledConfigs: options.enabledConfigs ?? null });
  const bitmaps = await readFdBitmaps(view, layout, files);
  const cexWord = bitmaps.closeOnExec[Math.floor(fd / (files.wordBytes * 8))] ?? 0n;
  const closeOnExec = ((cexWord >> BigInt(fd % (files.wordBytes * 8))) & 1n) === 1n;

  let mount: FileChainMount | null = null;
  if (file.path.mnt !== null) {
    try {
      const vfsmount = await readVfsmount(view, layout, file.path.mnt);
      mount = {
        vfsmount: file.path.mnt,
        rootDentry: vfsmount.rootDentry,
        superBlock: vfsmount.superBlock,
        flags: vfsmount.flags,
      };
    } catch (error) {
      notes.push(`读 vfsmount ${toHex(file.path.mnt)} 失败：${error instanceof Error ? error.message : String(error)}`);
      mount = { vfsmount: file.path.mnt, rootDentry: null, superBlock: null, flags: null };
    }
  } else {
    notes.push('f_path.mnt 为空：这个 file 不属于任何挂载点（未完成的 open 会出现这种中间态）');
  }

  let dentry: KernelDentry | null = null;
  let path: PathResolution | null = null;
  if (file.path.dentry !== null) {
    try {
      dentry = await readDentry(view, layout, file.path.dentry, {
        enabledConfigs: options.enabledConfigs ?? null,
      });
    } catch (error) {
      notes.push(`读 dentry ${toHex(file.path.dentry)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.resolvePath !== false) {
      try {
        path = await resolveDentryPath(view, layout, file.path.dentry, {
          enabledConfigs: options.enabledConfigs ?? null,
        });
      } catch (error) {
        notes.push(`拼路径失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    notes.push('f_path.dentry 为空：拿不到这个文件的名字');
  }

  let inode: KernelInode | null = null;
  if (file.fInode !== null) {
    try {
      inode = await readInode(view, layout, file.fInode);
    } catch (error) {
      notes.push(`读 inode ${toHex(file.fInode)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push('f_inode 为空：这个 file 还没绑定到 inode（`do_dentry_open()` 还没跑完）');
  }

  let superBlock: KernelSuperBlock | null = null;
  const sbAddress = inode?.superBlock ?? mount?.superBlock ?? null;
  if (options.readSuperBlock !== false && sbAddress !== null) {
    try {
      superBlock = await readSuperBlock(view, layout, sbAddress);
    } catch (error) {
      notes.push(`读 super_block ${toHex(sbAddress)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let addressSpace: KernelAddressSpace | null = null;
  let pageCache: PageCacheResult | null = null;
  const mappingAddress = file.fMapping ?? inode?.mapping ?? null;
  if (mappingAddress !== null) {
    try {
      addressSpace = await readAddressSpace(view, layout, mappingAddress);
      if (options.readPageCache === true) {
        const cache = await readPageCache(view, layout, addressSpace, { maxEntries: options.pageCacheLimit });
        pageCache = cache;
        notes.push(...cache.notes, ...cache.violations.map((line) => `页缓存不一致：${line}`));
      }
    } catch (error) {
      notes.push(`读 address_space ${toHex(mappingAddress)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (inode !== null) {
    notes.push('f_mapping 与 i_mapping 都为空：这个文件没有页缓存入口（伪文件系统上的文件常是这样）');
  }

  return {
    files,
    fd,
    fdSlotAddress,
    closeOnExec,
    file,
    path,
    dentry,
    inode,
    mount,
    superBlock,
    addressSpace,
    pageCache,
    notes,
    evidence: memoryEvidence(view.evidenceSource, fileAddress, 184, [
      `fd:${fd}`,
      `file:${toHex(fileAddress)}`,
      `dentry:${file.path.dentry === null ? 'null' : toHex(file.path.dentry)}`,
      `inode:${file.fInode === null ? 'null' : toHex(file.fInode)}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * 与契约对接
 * ------------------------------------------------------------------------ */

/** FileChain 转 FileRef：offset 取 f_pos 并对负值归零，deviceId 优先取 s_dev，refCount 取 f_count。 */
export function toFileRef(chain: FileChain): FileRef {
  const file = chain.file;
  const inode = chain.inode;
  const offsetNegative = file.fPos < 0n;
  const sizeNegative = inode !== null && inode.size < 0n;
  return {
    fd: chain.fd,
    fileAddress: toHex(file.address) as Hex,
    offset: toHex(offsetNegative ? 0n : file.fPos) as Hex,
    flags: toHex(BigInt(file.fFlags >>> 0)) as Hex,
    dentryAddress: file.path.dentry === null ? null : (toHex(file.path.dentry) as Hex),
    inodeAddress: file.fInode === null ? null : (toHex(file.fInode) as Hex),
    path: chain.path?.path ?? null,
    inodeNumber: inode === null ? null : inode.ino.toString(),
    deviceId: chain.superBlock?.devDecoded.text ?? inode?.rdevDecoded.text ?? null,
    size: inode === null ? null : (toHex(sizeNegative ? 0n : inode.size) as Hex),
    refCount: file.fCount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(file.fCount) : null,
    evidence: file.evidence,
  };
}

/** 页缓存条目 → 契约的 `FolioRef`（`mm.ts` 的 `toFolioRef` 需要先有 `KernelFolio`）。 */
export function pageCacheFolioRef(
  entry: PageCacheFolio,
  options: { inodeAddress?: bigint | null } = {},
): FolioRef | null {
  if (entry.folio === null) return null;
  const folio = entry.folio;
  return {
    address: toHex(folio.address) as Hex,
    fileOffset: (toHex(entry.index << BigInt(PAGE_SHIFT))) as Hex,
    pfn: toHex(folio.pfn) as Hex,
    dirty: folio.pageFlags.includes('PG_dirty'),
    uptodate: folio.pageFlags.includes('PG_uptodate'),
    inodeAddress:
      options.inodeAddress === undefined || options.inodeAddress === null
        ? null
        : (toHex(options.inodeAddress) as Hex),
    evidence: folio.evidence,
  };
}

/** 测试用纯地址计算：files_struct 内嵌位图及 fd 数组。 */
export function inlineFdArrayLayout(layout: KernelLayout, filesAddress: bigint): {
  fdArray: bigint;
  openFds: bigint;
  closeOnExec: bigint;
  fullFdsBits: bigint;
  count: number;
} {
  const fdArray = layout.byteOffset(FILES_TYPE, 'fd_array');
  const fdArrayField = layout.field(FILES_TYPE, 'fd_array');
  return {
    fdArray: filesAddress + BigInt(fdArray),
    openFds: filesAddress + BigInt(layout.byteOffset(FILES_TYPE, 'open_fds_init')),
    closeOnExec: filesAddress + BigInt(layout.byteOffset(FILES_TYPE, 'close_on_exec_init')),
    fullFdsBits: filesAddress + BigInt(layout.byteOffset(FILES_TYPE, 'full_fds_bits_init')),
    count: fdArrayField.byteSize === null ? 0 : fdArrayField.byteSize / 8,
  };
}

/** 页缓存里的页本该是文件页：这个判断与 `mm.ts` 用同一套位掩码，避免两处各写一遍。 */
export function pageMappingKind(mapping: bigint): 'anon' | 'movable' | 'file' {
  const flags = mapping & PAGE_MAPPING_FLAGS;
  if (flags === PAGE_MAPPING_ANON) return 'anon';
  if (flags !== 0n) return 'movable';
  return 'file';
}
