/**
 * ext2 盘面结构：inode、目录项、路径查找、文件偏移 → 块/LBA（T07e 下半部分）。
 *
 * 上半部分（`ext2.ts`）回答"这张盘是什么"，这一层回答"盘上某个文件的内容在哪"。
 * 四个地方各有一个"看起来对但其实错"的坑，注释写在对应函数上：
 *
 * 1. **inode 在哪**：inode 号先换算成"第几个块组 + 组内第几个 inode"，再换算成块号
 *    + 块内偏移（内核 `fs/ext2/inode.c:1313 ext2_get_inode()`）。直接拿 `ino * inodeSize`
 *    当盘面偏移，只有在 inode 表恰好落在盘头时才对。
 * 2. **目录项怎么算有效**：内核 `fs/ext2/dir.c:99 ext2_check_folio()` 有**五条**校验
 *    （最短长度、4 字节对齐、`rec_len` 装得下 `name_len`、不跨块、inode 号不超总数），
 *    少任何一条都会把"垃圾字节"读成一条像模像样的目录项 —— 名字、inode 号、类型都像真的。
 * 3. **普通文件的大小有两个字**：`i_size` 只是低 32 位，高位存在 `i_dir_acl` 那个位置
 *    （`i_size_high` 是同一字段的别名，`fs/ext2/ext2.h:344`）。只读 `i_size` 时，
 *    一个 5 GiB 的文件会显示成 1 GiB 出头 —— 照样是个"合理的文件大小"。
 * 4. **文件偏移到块要走过一棵树**：前 12 个块在 `i_block[0..11]`，之后是单/双/三间接块，
 *    路径由 `ext2_block_to_path()`（`fs/ext2/inode.c:163`）算出。按"第 n 个块就是
 *    `i_block[n]`"读，前 12 个块对、之后全错。
 *
 * 本层的判据全部现读内核源码（`fs/ext2/inode.c`、`fs/ext2/dir.c`、`fs/ext2/ext2.h`、
 * `include/linux/fs_types.h`、`include/uapi/linux/fs.h`、`include/linux/ext2_fs.h`），
 * 不把常量抄成"我记得是多少"。
 */

import { toHex } from '../../contracts/common.ts';
import type { EvidenceRef } from '../../contracts/common.ts';
import { byteOffsetForBlock, diskEvidence, lbaForBlock, readU16, readU32 } from './source.ts';
import type { DiskByteSource } from './source.ts';
import { EXT2_INDEX_FL, Ext2ParseError, ext2RecLen } from './ext2.ts';
import type { Ext2GroupDescriptorFacts, Ext2GroupTableFacts, Ext2SuperblockFacts } from './ext2.ts';

/** 根 inode 号恒为 2（`EXT2_ROOT_INO`，`fs/ext2/ext2.h:162`）。 */
export const EXT2_ROOT_INO = 2n;

/** 目录项名字上限（`EXT2_NAME_LEN`，`include/linux/ext2_fs.h:23`）。 */
export const EXT2_NAME_LEN = 255;

/** `i_block[]` 共 15 个指针：12 直接 + 单/双/三间接各 1（`fs/ext2/ext2.h:214-218`）。 */
export const EXT2_N_BLOCKS = 15;
export const EXT2_NDIR_BLOCKS = 12;
export const EXT2_IND_BLOCK = EXT2_NDIR_BLOCKS;
export const EXT2_DIND_BLOCK = EXT2_IND_BLOCK + 1;
export const EXT2_TIND_BLOCK = EXT2_DIND_BLOCK + 1;

/**
 * `struct ext2_inode` 的字节偏移（`fs/ext2/ext2.h:290`）。
 *
 * 顺序就是结构体字段顺序，字段都自然对齐，所以偏移可以直接累加。两个必须点名的：
 * - `dirAcl`（0x6c）同时是 `i_size_high`，普通文件的高 32 位大小就在这里；
 * - `uidHigh`/`gidHigh`（0x78/0x7a）在 `osd2` 联合体里，属于"不用 `NO_UID32` 时才生效"
 *   的 32 位 uid/gid 高位（`fs/ext2/inode.c:1414-1418`）。
 */
export const EXT2_INODE_FIELDS = {
  mode: 0x00,
  uid: 0x02,
  size: 0x04,
  atime: 0x08,
  ctime: 0x0c,
  mtime: 0x10,
  dtime: 0x14,
  gid: 0x18,
  linksCount: 0x1a,
  blocks: 0x1c,
  flags: 0x20,
  osd1: 0x24,
  block: 0x28,
  generation: 0x64,
  fileAcl: 0x68,
  dirAcl: 0x6c,
  faddr: 0x70,
  frag: 0x74,
  fsize: 0x75,
  uidHigh: 0x78,
  gidHigh: 0x7a,
} as const;

/** `struct ext2_dir_entry_2` 的字节偏移（`fs/ext2/ext2.h:591`）。 */
export const EXT2_DIR_ENTRY_FIELDS = {
  inode: 0x00,
  recLen: 0x04,
  nameLen: 0x06,
  fileType: 0x07,
  name: 0x08,
} as const;

/** 目录项头部固定 8 字节：inode(4) + rec_len(2) + name_len(1) + file_type(1)。 */
export const EXT2_DIR_ENTRY_HEADER_SIZE = 8;

/**
 * 目录项 `file_type` 的取值（`include/linux/fs_types.h` 的 `FT_*`）。
 *
 * `mode` 列写"这种类型对应的 `i_mode` 类型位"，用来做一致性检查：
 * 内核写目录项时用的是 `fs_umode_to_ftype(i_mode)` = `fs_ftype_by_dtype[S_DT(mode)]`，
 * 也就是按 `mode >> 12` 查表（`fs/fs_types.c`）。
 */
export const EXT2_FT_TYPES: Array<{ value: number; name: string; mode: number | null }> = [
  { value: 0, name: 'EXT2_FT_UNKNOWN', mode: null },
  { value: 1, name: 'EXT2_FT_REG_FILE', mode: 0o100000 },
  { value: 2, name: 'EXT2_FT_DIR', mode: 0o040000 },
  { value: 3, name: 'EXT2_FT_CHRDEV', mode: 0o020000 },
  { value: 4, name: 'EXT2_FT_BLKDEV', mode: 0o060000 },
  { value: 5, name: 'EXT2_FT_FIFO', mode: 0o010000 },
  { value: 6, name: 'EXT2_FT_SOCK', mode: 0o140000 },
  { value: 7, name: 'EXT2_FT_SYMLINK', mode: 0o120000 },
];

const FT_BY_FILE_TYPE_BITS = new Map<number, number>();
for (const entry of EXT2_FT_TYPES) {
  if (entry.mode !== null) FT_BY_FILE_TYPE_BITS.set(entry.mode, entry.value);
}

/** `fs_umode_to_ftype()` 的等价实现：把 `i_mode` 换成目录项里该写的 `file_type`。 */
export function modeToFileType(mode: number): number {
  return FT_BY_FILE_TYPE_BITS.get(mode & 0o170000) ?? 0;
}

/** 一位 `i_flags`（取值来自 `include/uapi/linux/fs.h:265` 的 `FS_*_FL`）。 */
export interface Ext2InodeFlagBit {
  masked: number;
  name: string;
  note: string;
}

export const EXT2_INODE_FLAGS: Ext2InodeFlagBit[] = [
  { masked: 0x00000001, name: 'EXT2_SECRM_FL', note: '安全删除（内容会被覆写）' },
  { masked: 0x00000002, name: 'EXT2_UNRM_FL', note: '可恢复删除' },
  { masked: 0x00000004, name: 'EXT2_COMPR_FL', note: '压缩' },
  { masked: 0x00000008, name: 'EXT2_SYNC_FL', note: '同步写' },
  { masked: 0x00000010, name: 'EXT2_IMMUTABLE_FL', note: '不可变（连 root 也不能改）' },
  { masked: 0x00000020, name: 'EXT2_APPEND_FL', note: '只能追加' },
  { masked: 0x00000040, name: 'EXT2_NODUMP_FL', note: '备份时跳过' },
  { masked: 0x00000080, name: 'EXT2_NOATIME_FL', note: '不更新 atime' },
  { masked: 0x00000100, name: 'EXT2_DIRTY_FL', note: '压缩相关（保留）' },
  { masked: 0x00000200, name: 'EXT2_COMPRBLK_FL', note: '压缩簇' },
  { masked: 0x00000400, name: 'EXT2_NOCOMP_FL', note: '不压缩' },
  { masked: 0x00000800, name: 'EXT2_ENCRYPT_FL', note: '加密文件' },
  { masked: 0x00001000, name: 'EXT2_INDEX_FL', note: '哈希索引目录（与 BTREE_FL 同一位）' },
  { masked: 0x00002000, name: 'EXT2_IMAGIC_FL', note: 'AFS 目录' },
  { masked: 0x00004000, name: 'EXT2_JOURNAL_DATA_FL', note: 'ext3 遗留' },
  { masked: 0x00008000, name: 'EXT2_NOTAIL_FL', note: '不合并文件尾' },
  { masked: 0x00010000, name: 'EXT2_DIRSYNC_FL', note: '目录同步写' },
  { masked: 0x00020000, name: 'EXT2_TOPDIR_FL', note: '目录树顶端' },
  { masked: 0x00040000, name: 'EXT2_HUGE_FILE_FL', note: 'ext4 遗留' },
  { masked: 0x00080000, name: 'EXT2_EXTENT_FL', note: 'ext4 的 extent 树（ext2 不用）' },
  { masked: 0x00100000, name: 'EXT2_VERITY_FL', note: 'fs-verity 保护' },
  { masked: 0x00200000, name: 'EXT2_EA_INODE_FL', note: '大扩展属性 inode' },
  { masked: 0x00400000, name: 'EXT2_EOFBLOCKS_FL', note: 'ext4 遗留' },
  { masked: 0x00800000, name: 'EXT2_NOCOW_FL', note: '不做写时复制' },
  { masked: 0x02000000, name: 'EXT2_DAX_FL', note: 'DAX 直接访问' },
  { masked: 0x10000000, name: 'EXT2_INLINE_DATA_FL', note: 'ext4 内联数据' },
  { masked: 0x20000000, name: 'EXT2_PROJINHERIT_FL', note: '项目继承' },
  { masked: 0x40000000, name: 'EXT2_CASEFOLD_FL', note: '大小写不敏感' },
  { masked: 0x80000000, name: 'EXT2_RESERVED_FL', note: '为 ext2 库保留' },
];

const MODE_TYPE_CHARS: Array<{ masked: number; char: string }> = [
  { masked: 0o010000, char: 'p' },
  { masked: 0o020000, char: 'c' },
  { masked: 0o040000, char: 'd' },
  { masked: 0o060000, char: 'b' },
  { masked: 0o100000, char: '-' },
  { masked: 0o120000, char: 'l' },
  { masked: 0o140000, char: 's' },
];

const SPECIAL_BITS = [0o4000, 0o2000, 0o1000];
const SPECIAL_LOWER = ['s', 's', 't'];
const SPECIAL_UPPER = ['S', 'S', 'T'];

/**
 * 把 `i_mode` 打成 `ls -l` 那样的 10 个字符。
 *
 * `s`/`S`/`t`/`T` 是**顶掉**所在那一组的执行位、不是另外加一位：有执行位写小写，
 * 没有执行位写大写。所以 0644 是 `-rw-r--r--`，4755 是 `-rwsr-xr-x`。
 */
export function formatExt2Mode(mode: number): string {
  const type = MODE_TYPE_CHARS.find((entry) => (mode & 0o170000) === entry.masked);
  const groups = [0, 1, 2].map((index) => {
    const triplet = (mode >> (6 - index * 3)) & 0o7;
    const read = triplet & 0o4 ? 'r' : '-';
    const write = triplet & 0o2 ? 'w' : '-';
    const special = (mode & SPECIAL_BITS[index]) !== 0;
    let execute = '-';
    if (triplet & 0o1) execute = special ? SPECIAL_LOWER[index] : 'x';
    else if (special) execute = SPECIAL_UPPER[index];
    return `${read}${write}${execute}`;
  }).join('');
  return `${type?.char ?? '?'}${groups}`;
}

/** `i_mode` 的类型位对应的 `S_IF*` 名字。 */
const MODE_TYPE_NAMES: Array<{ masked: number; name: string }> = [
  { masked: 0o010000, name: 'S_IFIFO' },
  { masked: 0o020000, name: 'S_IFCHR' },
  { masked: 0o040000, name: 'S_IFDIR' },
  { masked: 0o060000, name: 'S_IFBLK' },
  { masked: 0o100000, name: 'S_IFREG' },
  { masked: 0o120000, name: 'S_IFLNK' },
  { masked: 0o140000, name: 'S_IFSOCK' },
];

/** `i_flags` 里认识的位名。 */
export function decodeInodeFlags(flags: number): { names: string[]; unknownBits: number } {
  const names = EXT2_INODE_FLAGS.filter((entry) => (flags & entry.masked) !== 0).map((entry) => entry.name);
  const known = EXT2_INODE_FLAGS.reduce((mask, entry) => mask | entry.masked, 0);
  // `>>> 0` 是因为最高位那面旗（0x80000000）在 32 位按位运算里是负数，
  // 不转回无符号的话"未知位"会显示成一个负值。
  return { names, unknownBits: ((flags & ~known) >>> 0) };
}

// ---------------------------------------------------------------------------
// inode 定位与解析
// ---------------------------------------------------------------------------

export interface Ext2InodeLocation {
  ino: bigint;
  /** 第几个块组 */
  groupIndex: bigint;
  /** 组内第几个 inode（从 0 数） */
  indexInGroup: bigint;
  inodeSize: number;
  /** 组内字节偏移：`indexInGroup * inodeSize` */
  groupByteOffset: bigint;
  /** 这个 inode 落在哪个盘面块 */
  block: bigint;
  /** 块内字节偏移 */
  offsetInBlock: number;
  /** 盘面上的绝对字节偏移 */
  byteOffset: bigint;
  /** 读一个 inode 会不会跨过块边界（inode 大小整除块大小时不会） */
  spansBlock: boolean;
  group: Ext2GroupDescriptorFacts;
}

/**
 * inode 号 → 盘面位置（`ext2_get_inode()` 的逐行翻译）。
 *
 * 三步：`block_group = (ino - 1) / inodes_per_group`；
 * `offset = ((ino - 1) % inodes_per_group) * inode_size`；
 * `block = bg_inode_table + (offset >> block_size_bits)`，块内偏移 `offset & (blockSize - 1)`。
 * 注意 `bg_inode_table` 是**这个块组**的 inode 表起点，不同块组不一样。
 */
export function ext2InodeLocation(
  sb: Ext2SuperblockFacts,
  groupTable: Ext2GroupTableFacts,
  ino: bigint,
): Ext2InodeLocation {
  if (ino <= 0n) {
    throw new Ext2ParseError('bad-inode', `inode 号 ${ino} 不合法：盘上没有第 0 号 inode`, {
      ino: ino.toString(),
    });
  }
  if (ino > sb.inodesCount) {
    throw new Ext2ParseError(
      'inode-out-of-range',
      `inode 号 ${ino} 超出盘上 inode 总数 ${sb.inodesCount}`,
      { ino: ino.toString(), inodesCount: sb.inodesCount.toString() },
    );
  }
  const groupIndex = (ino - 1n) / sb.inodesPerGroup;
  if (groupIndex >= BigInt(groupTable.descriptors.length)) {
    throw new Ext2ParseError(
      'inode-group-out-of-range',
      `inode ${ino} 落在第 ${groupIndex} 个块组，但盘上只有 ${groupTable.descriptors.length} 个块的描述符`,
      { ino: ino.toString(), groupIndex: groupIndex.toString() },
    );
  }
  const group = groupTable.descriptors[Number(groupIndex)];
  const indexInGroup = (ino - 1n) % sb.inodesPerGroup;
  const groupByteOffset = indexInGroup * BigInt(sb.inodeSize);
  const blockBits = BigInt(Math.round(Math.log2(sb.blockSize)));
  const block = group.inodeTable + (groupByteOffset >> blockBits);
  const offsetInBlock = Number(groupByteOffset & BigInt(sb.blockSize - 1));
  return {
    ino,
    groupIndex,
    indexInGroup,
    inodeSize: sb.inodeSize,
    groupByteOffset,
    block,
    offsetInBlock,
    byteOffset: byteOffsetForBlock(block, sb.blockSize) + BigInt(offsetInBlock),
    spansBlock: offsetInBlock + sb.inodeSize > sb.blockSize,
    group,
  };
}

export interface Ext2InodeFacts {
  ino: bigint;
  location: Ext2InodeLocation;
  /** inode 位图里这一位是否被占用；`null` 表示这次没查位图 */
  allocated: boolean | null;
  mode: number;
  modeText: string;
  /** `S_IFREG`/`S_IFDIR` 这类名字 */
  modeTypeName: string | null;
  fileType: number;
  fileTypeName: string;
  uid: number;
  gid: number;
  size: bigint;
  /** `i_size` 字段本身（低 32 位） */
  sizeLow: number;
  /** `i_dir_acl` 位置上的值，普通文件时是大小的高 32 位 */
  dirAcl: number;
  /** 是否把这个高位用进了 `size`（只有普通文件才用） */
  sizeHighUsed: boolean;
  atime: number;
  ctime: number;
  mtime: number;
  dtime: number;
  linksCount: number;
  /** `i_links_count == 0`：内核认为这是个已删除的 inode（`ext2_iget` 会报 ESTALE） */
  deleted: boolean;
  /** `i_blocks`，单位是 **512 字节扇区**，不是文件系统块 */
  blocks: number;
  blocksBytes: number;
  flags: number;
  flagNames: string[];
  unknownFlagBits: number;
  /** `i_flags & EXT2_INDEX_FL`：这个目录带哈希索引 */
  indexedDirectory: boolean;
  /** 15 个块指针，原样带出（不解引用） */
  block: number[];
  generation: number;
  fileAcl: number;
  faddr: number;
  frag: number;
  fsize: number;
  /** 快速符号链接的目标（存在 `i_block[]` 里，不走数据块） */
  symlinkTarget: string | null;
  fastSymlink: boolean;
  isDirectory: boolean;
  isRegular: boolean;
  isSymlink: boolean;
  /** 盘面上的原始 128 字节中的前 128 字节（够展示一行 Hex） */
  rawBytes: number[];
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 读一个 inode。
 *
 * 会照实报出来的三件事，都不是"解析失败"而是"盘面本身就是这个意思"：
 * - `i_links_count == 0` → 已删除的 inode（`deleted = true`）；
 * - `i_flags` 里有 `EXT2_INDEX_FL` → 索引目录，而 **ext2 驱动根本没有索引查找代码**
 *   （`fs/ext2/` 里搜不到 `dx_root`/`is_dx_dir`），它按线性遍历读目录；
 * - 普通文件的 `size` 由 `i_size | (i_dir_acl << 32)` 拼成 —— 内核是无条件拼的，
 *   并不检查 `large_file` 特性位（`fs/ext2/inode.c:1470-1473`）。
 */
export async function readExt2Inode(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
  groupTable: Ext2GroupTableFacts,
  ino: bigint,
  options: { checkAllocation?: boolean } = {},
): Promise<Ext2InodeFacts> {
  const location = ext2InodeLocation(sb, groupTable, ino);
  const notes: string[] = [];
  const bytes = await source.read(location.byteOffset, sb.inodeSize);
  const f = EXT2_INODE_FIELDS;
  const read = (offset: number): number => (offset < bytes.length ? bytes[offset] : 0);

  const mode = readU16(bytes, f.mode);
  const sizeLow = Number(readU32(bytes, f.size));
  const dirAcl = Number(readU32(bytes, f.dirAcl));
  const linksCount = readU16(bytes, f.linksCount);
  const blocks = Number(readU32(bytes, f.blocks));
  const flags = Number(readU32(bytes, f.flags));
  const isRegular = (mode & 0o170000) === 0o100000;
  const isDirectory = (mode & 0o170000) === 0o040000;
  const isSymlink = (mode & 0o170000) === 0o120000;

  // 内核无条件用 i_dir_acl 拼普通文件的高 32 位；非普通文件那个字段是目录 ACL。
  const sizeHighUsed = isRegular;
  const size = sizeHighUsed ? BigInt(sizeLow) | (BigInt(dirAcl) << 32n) : BigInt(sizeLow);

  const block: number[] = [];
  for (let index = 0; index < EXT2_N_BLOCKS; index += 1) {
    block.push(Number(readU32(bytes, f.block + index * 4)));
  }

  // 32 位 uid/gid：高 16 位在 osd2 里（`fs/ext2/inode.c:1414-1418`，除非挂了 NO_UID32）。
  const uid = readU16(bytes, f.uid) | (readU16(bytes, f.uidHigh) << 16);
  const gid = readU16(bytes, f.gid) | (readU16(bytes, f.gidHigh) << 16);

  // 快速符号链接：`ext2_inode_is_fast_symlink()` = 是链接且 (i_blocks - ea_blocks) == 0，
  // 目标就存在 i_block[] 这 60 字节里，不走数据块。
  const eaBlocks = Number(readU32(bytes, f.fileAcl)) !== 0 ? Math.floor(sb.blockSize / 512) : 0;
  const fastSymlink = isSymlink && blocks - eaBlocks === 0;
  let symlinkTarget: string | null = null;
  if (fastSymlink) {
    const raw = Buffer.from(bytes.subarray(f.block, f.block + 60));
    const end = raw.indexOf(0);
    symlinkTarget = raw.subarray(0, end === -1 ? Math.min(Number(size), 60) : end).toString('utf8');
  }

  const flagDecode = decodeInodeFlags(flags);
  const indexedDirectory = (flags & EXT2_INDEX_FL) !== 0;
  if (indexedDirectory) {
    notes.push(
      'i_flags 里有 EXT2_INDEX_FL（0x1000）：这个目录被 ext3/ext4 建过哈希索引。'
      + '注意 ext2 的内核驱动**不实现索引查找**（fs/ext2/ 里没有 dx 代码），'
      + 'ext2_find_entry/ext2_readdir 都是线性遍历，所以这里也按线性读，'
      + '第 0 块里目录项 ".." 的 rec_len 覆盖到块尾，索引节点不会被读成目录项',
    );
  }
  if (linksCount === 0) {
    notes.push(
      `i_links_count = 0：这是个已删除的 inode（内核 ext2_iget 对它报 ESTALE）。`
      + `${mode === 0 || readU32(bytes, f.dtime) !== 0n ? 'i_mode 为 0 或 i_dtime 非 0，判据完整。' : ''}`,
    );
  }
  if (location.spansBlock) {
    notes.push(
      `inode 在第 ${location.block} 块内的偏移 ${location.offsetInBlock} 处、长 ${sb.inodeSize} 字节，`
      + '会跨过块边界：ext2 的 inode 大小应当整除块大小，这张盘不自洽',
    );
  }
  if (!fastSymlink && blocks * 512 < Number(size)) {
    notes.push(
      `i_blocks = ${blocks}（512 字节扇区，合 ${blocks * 512} 字节）比 i_size = ${size} 小：`
      + '要么是稀疏文件（中间有洞），要么盘面不自洽。两者都能出现在正常盘上，所以只记事实不下结论',
    );
  }

  let allocated: boolean | null = null;
  if (options.checkAllocation !== false) {
    const bitmapByte = location.indexInGroup >> 3n;
    const bit = Number(location.indexInGroup & 7n);
    const bitmapOffset = byteOffsetForBlock(location.group.inodeBitmap, sb.blockSize) + bitmapByte;
    const bitmapBytes = await source.read(bitmapOffset, 1);
    allocated = (bitmapBytes[0] & (1 << bit)) !== 0;
    if (!allocated) {
      notes.push(
        `inode 位图（块 ${location.group.inodeBitmap}，第 ${location.indexInGroup} 位）说这个 inode 是空闲的，`
        + '但它的字节里读得出内容：说明这段内容是**残留**，不该当有效 inode 用',
      );
    }
  }

  return {
    ino,
    location,
    allocated,
    mode,
    modeText: formatExt2Mode(mode),
    modeTypeName: MODE_TYPE_NAMES.find((entry) => (mode & 0o170000) === entry.masked)?.name ?? null,
    fileType: modeToFileType(mode),
    fileTypeName: EXT2_FT_TYPES.find((entry) => entry.value === modeToFileType(mode))?.name ?? 'EXT2_FT_UNKNOWN',
    uid,
    gid,
    size,
    sizeLow,
    dirAcl,
    sizeHighUsed,
    atime: Number(readU32(bytes, f.atime)),
    ctime: Number(readU32(bytes, f.ctime)),
    mtime: Number(readU32(bytes, f.mtime)),
    dtime: Number(readU32(bytes, f.dtime)),
    linksCount,
    deleted: linksCount === 0,
    blocks,
    blocksBytes: blocks * 512,
    flags,
    flagNames: flagDecode.names,
    unknownFlagBits: flagDecode.unknownBits,
    indexedDirectory,
    block,
    generation: Number(readU32(bytes, f.generation)),
    fileAcl: Number(readU32(bytes, f.fileAcl)),
    faddr: Number(readU32(bytes, f.faddr)),
    frag: read(f.frag),
    fsize: read(f.fsize),
    symlinkTarget,
    fastSymlink,
    isDirectory,
    isRegular,
    isSymlink,
    rawBytes: Array.from(bytes.subarray(0, Math.min(128, bytes.length))),
    notes,
    evidence: diskEvidence(source, location.byteOffset, sb.inodeSize, ['ext2:inode', `ino:${ino}`]),
  };
}

// ---------------------------------------------------------------------------
// 目录项
// ---------------------------------------------------------------------------

export interface Ext2DirEntry {
  /** 这条目录项在所属块内的偏移 */
  offsetInBlock: number;
  /** 盘面上的绝对字节偏移 */
  byteOffset: bigint;
  inode: bigint;
  recLen: number;
  nameLen: number;
  fileType: number;
  fileTypeName: string;
  name: string;
  /** `inode == 0` 的槽：这块空间是空的（内核 `dir_emit` 直接跳过） */
  free: boolean;
  notes: string[];
}

/** 一条与内核 `ext2_check_folio()` 对齐的目录块校验失败。 */
export interface Ext2DirBlockFault {
  /**
   * 内核 `ext2_check_folio()` 的 goto 标签：Eshort/Ealign/Enamelen/Espan/Einumber/Eend。
   * 注意这里**没有** Ezero：内核校验页那条路上 rec_len = 0 也落在 `rec_len < EXT2_DIR_REC_LEN(1)`
   * 这一条上（报 Eshort）。"zero-length directory entry" 是 `ext2_readdir()` /
   * `ext2_find_entry()` 读到长度 0 的目录项时另设的一道闸（`ext2_error()` + -EIO），
   * 不是校验页的标签。
   */
  label: string;
  /** 内核 `ext2_error()` 里的原文，便于逐字对照 */
  reason: string;
  offsetInBlock: number;
  byteOffset: bigint;
  inode: bigint;
  recLen: number;
  nameLen: number;
}

export interface Ext2DirBlockFacts {
  block: bigint;
  byteOffset: bigint;
  /** 按目录 `i_size` 算，这一块里有效的字节数（最后一块可能不满） */
  validBytes: number;
  entries: Ext2DirEntry[];
  faults: Ext2DirBlockFault[];
  /** 全部目录项正好铺满有效范围（内核 `offs == limit`） */
  reachedEnd: boolean;
  /** 空闲槽占掉的字节数（`inode == 0` 的那些） */
  freeBytes: number;
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 解析一个目录块里的目录项。
 *
 * 五条校验逐条照 `ext2_check_folio()` 抄，顺序也一样（先短、再对齐、再装得下名字、
 * 再不许跨块、最后 inode 号范围）。任何一条不过就**停下并报出来**，不继续往下扫：
 * 一旦一条错了，后面每个字节的位置都失去意义，继续扫只会产出更多假目录项。
 *
 * `rec_len == 0` 不是一个单独的标签：内核这里的第一条判据就是
 * `rec_len < EXT2_DIR_REC_LEN(1)`，0 也落在里面（报 Eshort）。"zero-length directory entry"
 * 是 `ext2_readdir()` / `ext2_find_entry()` 里另设的一道闸（读到长度 0 的项就
 * `ext2_error()` 并返回 -EIO）—— 这也是 rec_len 必须为零长度项单独把关的原因：
 * 它是循环的步进量，为 0 就死循环了。理由文本里会把这两层都点出来。
 */
export function parseExt2DirBlock(
  bytes: Uint8Array,
  options: {
    source: DiskByteSource;
    block: bigint;
    byteOffset: bigint;
    blockSize: number;
    validBytes: number;
    inodesCount: bigint;
    hasFileType: boolean;
  },
): Ext2DirBlockFacts {
  const { source, block, byteOffset, blockSize, validBytes, inodesCount, hasFileType } = options;
  const entries: Ext2DirEntry[] = [];
  const faults: Ext2DirBlockFault[] = [];
  const notes: string[] = [];
  const minRecLen = ext2RecLen(1); // 12
  // 内核写的是 `& ~(chunk_size-1)`，也就是"块内偏移的高位"掩码：所以这里直接把
  // `~(blockSize-1)` 存成 mask 后用 `& mask`。再取一次反（`& ~mask`）会变成判低位，
  // 结果每条正常目录项都会被判成"跨块"—— 所有目录都读出 0 条目录项。
  const mask = ~(blockSize - 1);
  let freeBytes = 0;
  let offs = 0;

  // 循环条件与内核一致：`offs <= limit - EXT2_DIR_REC_LEN(1)`。
  while (offs <= validBytes - minRecLen) {
    const inode = readU32(bytes, offs + EXT2_DIR_ENTRY_FIELDS.inode);
    const recLen = readU16(bytes, offs + EXT2_DIR_ENTRY_FIELDS.recLen);
    const nameLen = bytes[offs + EXT2_DIR_ENTRY_FIELDS.nameLen];
    const fileType = bytes[offs + EXT2_DIR_ENTRY_FIELDS.fileType];
    const fault = (label: string, reason: string): void => {
      faults.push({
        label,
        reason,
        offsetInBlock: offs,
        byteOffset: byteOffset + BigInt(offs),
        inode,
        recLen,
        nameLen,
      });
    };

    if (recLen < minRecLen) {
      // 内核 `ext2_check_folio()` 里 rec_len 为 0 也走这一条（0 < 12）。标签与内核保持一致，
      // 只在理由里点明它同时也是 readdir/find_entry 眼里的"零长度目录项"。
      fault('Eshort', recLen === 0
        ? 'rec_len is smaller than minimal（rec_len = 0：ext2_readdir()/ext2_find_entry() 另称 zero-length directory entry）'
        : 'rec_len is smaller than minimal');
      break;
    }
    if ((recLen & 3) !== 0) {
      fault('Ealign', 'unaligned directory entry');
      break;
    }
    if (recLen < ext2RecLen(nameLen)) {
      fault('Enamelen', 'rec_len is too small for name_len');
      break;
    }
    // 内核这一条是对 chunk（= 块大小）起点做的位运算，判的是"目录项不能跨过块边界"。
    if ((((offs + recLen - 1) ^ offs) & mask) !== 0) {
      fault('Espan', 'directory entry across blocks');
      break;
    }
    if (inode > inodesCount) {
      fault('Einumber', 'inode out of bounds');
      break;
    }

    const nameBytes = bytes.subarray(offs + EXT2_DIR_ENTRY_HEADER_SIZE, offs + EXT2_DIR_ENTRY_HEADER_SIZE + nameLen);
    const name = Buffer.from(nameBytes).toString('utf8');
    const entryNotes: string[] = [];
    if (nameLen === 0) entryNotes.push('name_len 为 0：这条项没有名字（内核 still 会按 rec_len 跳过它）');
    if (nameLen > EXT2_NAME_LEN) entryNotes.push(`name_len = ${nameLen} 超过 EXT2_NAME_LEN(${EXT2_NAME_LEN})`);
    if (name.includes('\0')) entryNotes.push('名字里出现 0 字节：这不是正常目录项该有的形态');

    entries.push({
      offsetInBlock: offs,
      byteOffset: byteOffset + BigInt(offs),
      inode,
      recLen,
      nameLen,
      fileType,
      fileTypeName: hasFileType
        ? (EXT2_FT_TYPES.find((entry) => entry.value === fileType)?.name ?? `未知(${fileType})`)
        : '（无 file_type：这张盘没开 FILETYPE 特性）',
      name,
      free: inode === 0n,
      notes: entryNotes,
    });
    if (inode === 0n) freeBytes += recLen;
    offs += recLen;
  }

  const reachedEnd = offs === validBytes;
  if (!reachedEnd && faults.length === 0) {
    faults.push({
      label: 'Eend',
      reason: 'entry in directory spans the page boundary',
      offsetInBlock: offs,
      byteOffset: byteOffset + BigInt(offs),
      inode: 0n,
      recLen: 0,
      nameLen: 0,
    });
  }
  if (faults.length > 0) {
    notes.push(
      `这个块在第 ${offs} 字节处停了（剩余 ${validBytes - offs} 字节没解析）：`
      + '一条目录项不合法之后，后面每个字节的归属都失去依据，继续扫只会产出更多假目录项',
    );
  }
  if (!hasFileType) {
    notes.push(
      's_feature_incompat 里没有 FILETYPE：目录项的 file_type 那个字节不存在'
      + '（是老式 ext2_dir_entry，name_len 占 2 字节），这里按结构体的 name_len 单字节读',
    );
  }

  return {
    block,
    byteOffset,
    validBytes,
    entries,
    faults,
    reachedEnd,
    freeBytes,
    notes,
    evidence: diskEvidence(source, byteOffset, validBytes, [
      'ext2:dir-block',
      `block:${block}`,
      `entries:${entries.length}`,
      ...(faults.length === 0 ? [] : [`fault:${faults[0].label}`]),
    ]),
  };
}

export interface Ext2DirectoryFacts {
  inode: Ext2InodeFacts;
  /** 目录大小（字节）；ext2 的目录大小一定是块大小的整数倍 */
  size: bigint;
  logicalBlocks: number;
  blocks: Ext2DirBlockFacts[];
  /** 汇总后的目录项（含 `inode == 0` 的空闲槽，面板要能显示"这块空间是空的"） */
  entries: Ext2DirEntry[];
  faults: Ext2DirBlockFault[];
  /** 逻辑块里是洞的下标（目录文件出现洞说明盘面有问题） */
  holes: number[];
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 读一个目录的全部目录项。
 *
 * 逐块走：先按目录 `i_size` 算出一共有几个逻辑块，再用块映射（`mapExt2FileOffset`，
 * 支持间接块）把逻辑块换成盘面块，最后逐块解析。目录大小不是块大小整数倍时会记一条
 * note —— 内核在 `ext2_check_folio()` 里对这种情况直接判 `Ebadsize`（文件系统损坏）。
 */
export async function readExt2Directory(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
  groupTable: Ext2GroupTableFacts,
  inode: Ext2InodeFacts,
  options: { maxBlocks?: number } = {},
): Promise<Ext2DirectoryFacts> {
  if (!inode.isDirectory) {
    throw new Ext2ParseError(
      'not-a-directory',
      `inode ${inode.ino} 的 i_mode = ${toHex(BigInt(inode.mode))}（${inode.modeText}）不是目录`,
      { ino: inode.ino.toString(), mode: toHex(BigInt(inode.mode)) },
    );
  }
  const notes: string[] = [];
  const maxBlocks = options.maxBlocks ?? 4096;
  const blockSize = sb.blockSize;
  const totalBlocks = Number((inode.size + BigInt(blockSize - 1)) / BigInt(blockSize));
  const logicalBlocks = Math.min(totalBlocks, maxBlocks);
  if (totalBlocks > logicalBlocks) {
    notes.push(`目录有 ${totalBlocks} 个块，这次只读了前 ${logicalBlocks} 个（maxBlocks 上限）`);
  }
  if (inode.size % BigInt(blockSize) !== 0n) {
    notes.push(
      `目录 i_size = ${inode.size} 不是块大小 ${blockSize} 的整数倍：`
      + '内核 ext2_check_folio() 对这个情况直接判 Ebadsize（文件系统损坏）',
    );
  }
  const hasFileType = (sb.featureIncompat & 0x0002) !== 0;
  const blocks: Ext2DirBlockFacts[] = [];
  const holes: number[] = [];

  for (let index = 0; index < logicalBlocks; index += 1) {
    const mapped = await mapExt2FileOffset(source, sb, inode, BigInt(index) * BigInt(blockSize));
    if (mapped.block === null) {
      holes.push(index);
      notes.push(`目录的第 ${index} 个逻辑块是个洞（没有分配）：内核读它得到全 0，会被判 Eshort（rec_len = 0）`);
      continue;
    }
    const blockByteOffset = byteOffsetForBlock(mapped.block, blockSize);
    const bytes = await source.read(blockByteOffset, blockSize);
    const validBytes = Math.min(blockSize, Number(inode.size - BigInt(index) * BigInt(blockSize)));
    blocks.push(parseExt2DirBlock(bytes, {
      source,
      block: mapped.block,
      byteOffset: blockByteOffset,
      blockSize,
      validBytes,
      inodesCount: sb.inodesCount,
      hasFileType,
    }));
  }

  const entries = blocks.flatMap((block) => block.entries);
  const faults = blocks.flatMap((block) => block.faults);
  const dot = entries.find((entry) => entry.name === '.' && !entry.free);
  if (dot !== undefined && dot.inode !== inode.ino) {
    notes.push(`目录项 "." 指向 inode ${dot.inode}，但这个目录自己的 inode 是 ${inode.ino}：盘面不自洽`);
  }
  if (inode.indexedDirectory) {
    notes.push('这是索引目录（EXT2_INDEX_FL）：ext2 驱动按线性遍历读它，上面的目录项就是叶子块里的真实内容');
  }

  return {
    inode,
    size: inode.size,
    logicalBlocks,
    blocks,
    entries,
    faults,
    holes,
    notes,
    evidence: diskEvidence(source, byteOffsetForBlock(
      blocks.length > 0 ? blocks[0].block : 0n,
      blockSize,
    ), blocks.length * blockSize, [
      'ext2:directory',
      `ino:${inode.ino}`,
      `entries:${entries.length}`,
    ]),
  };
}

/** 在目录项里按名字找一个（跳过空闲槽）。 */
export function findDirEntry(names: Ext2DirEntry[], name: string): Ext2DirEntry | null {
  return names.find((entry) => !entry.free && entry.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// 路径查找
// ---------------------------------------------------------------------------

export interface Ext2PathStep {
  /** 在哪一个目录里找 */
  directoryIno: bigint;
  name: string;
  found: boolean;
  entry: Ext2DirEntry | null;
}

export interface Ext2PathComponent {
  name: string;
  ino: bigint;
  fileType: number;
  fileTypeName: string;
  /** 通往这一段的目录项在盘面上的字节偏移；根是 `null`（没有目录项指向它） */
  entryByteOffset: bigint | null;
}

export interface Ext2PathResolution {
  path: string;
  resolved: boolean;
  /** 找不到的那一段（`resolved` 为 true 时是 `null`） */
  missing: string | null;
  /** 最后落到哪个 inode（解析失败时是"卡住的那个目录"） */
  inode: Ext2InodeFacts;
  components: Ext2PathComponent[];
  steps: Ext2PathStep[];
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 从根开始逐段查路径。
 *
 * `.` 直接跳过、`..` 用下降过程里记的父 inode 弹栈（不重新查 `..` 目录项：那会在
 * dentry 缓存缺失时读到不一样的东西，而我们这里只有一层来源）。每一段都要
 * **重新读一次目录**，因为 ext2 的目录项不保证有序、也没有索引可用。
 */
export async function lookupExt2Path(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
  groupTable: Ext2GroupTableFacts,
  path: string,
  options: { maxBlocks?: number } = {},
): Promise<Ext2PathResolution> {
  const notes: string[] = [];
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  let current = await readExt2Inode(source, sb, groupTable, EXT2_ROOT_INO);
  const stack: bigint[] = [EXT2_ROOT_INO];
  const components: Ext2PathComponent[] = [{
    name: '/',
    ino: EXT2_ROOT_INO,
    fileType: current.fileType,
    fileTypeName: current.fileTypeName,
    entryByteOffset: null,
  }];
  const steps: Ext2PathStep[] = [];
  const finish = (missing: string | null): Ext2PathResolution => ({
    path,
    resolved: missing === null,
    missing,
    inode: current,
    components,
    steps,
    notes,
    evidence: diskEvidence(source, current.location.byteOffset, sb.inodeSize, [
      'ext2:path',
      `path:${path}`,
      `ino:${current.ino}`,
      ...(missing === null ? [] : [`missing:${missing}`]),
    ]),
  });

  for (const part of parts) {
    if (part === '..') {
      if (stack.length > 1) stack.pop();
      current = await readExt2Inode(source, sb, groupTable, stack[stack.length - 1]);
      components.push({
        name: '..',
        ino: current.ino,
        fileType: current.fileType,
        fileTypeName: current.fileTypeName,
        entryByteOffset: null,
      });
      continue;
    }
    if (!current.isDirectory) {
      notes.push(`再往下找 ${JSON.stringify(part)} 之前，inode ${current.ino} 不是目录（${current.modeText}）`);
      steps.push({ directoryIno: current.ino, name: part, found: false, entry: null });
      return finish(part);
    }
    const directory = await readExt2Directory(source, sb, groupTable, current, options);
    const entry = findDirEntry(directory.entries, part);
    steps.push({ directoryIno: current.ino, name: part, found: entry !== null, entry });
    if (entry === null) {
      notes.push(
        `目录 inode ${current.ino}（${directory.entries.length} 条目录项）里没有名字 ${JSON.stringify(part)}`,
      );
      return finish(part);
    }
    current = await readExt2Inode(source, sb, groupTable, entry.inode);
    stack.push(entry.inode);
    components.push({
      name: part,
      ino: entry.inode,
      fileType: entry.fileType,
      fileTypeName: entry.fileTypeName,
      entryByteOffset: entry.byteOffset,
    });
  }
  return finish(null);
}

// ---------------------------------------------------------------------------
// 文件偏移 → 盘面块 → LBA
// ---------------------------------------------------------------------------

/** 一个块里能放多少个 32 位块指针（`EXT2_ADDR_PER_BLOCK`，`fs/ext2/ext2.h:182`）。 */
export function ext2AddrPerBlock(blockSize: number): number {
  return blockSize / 4;
}

export interface Ext2BlockPath {
  /** 每一层里指针的下标；第 0 层是 inode 里的 `i_block[]` */
  offsets: number[];
  /** 需要几层指针：1 = 直接、2 = 单间接、3 = 双间接、4 = 三间接 */
  depth: number;
  /** 这条路每一层最多有多少个指针 */
  final: number;
  /** 超出三间接能表达的范围（内核在这里打 "block is too big" 并当作出错） */
  outOfRange: boolean;
}

/**
 * `ext2_block_to_path()`（`fs/ext2/inode.c:163`）的等价实现。
 *
 * 关键是"减去前面各段的容量再判"：先减 12 个直接块，再减一个间接块能装的数量
 * （`ptrs = blockSize / 4`，4096 字节块 → 1024），再减双间接容量（`ptrs²`），
 * 剩下的才用三间接。写成"第 n 个块就查 `i_block[n]`"，第 12 个块之后全部错位。
 */
export function ext2BlockToPath(blockIndex: bigint, blockSize: number): Ext2BlockPath {
  const ptrs = BigInt(ext2AddrPerBlock(blockSize));
  const ptrsBits = BigInt(Math.round(Math.log2(blockSize)) - 2);
  const directBlocks = BigInt(EXT2_NDIR_BLOCKS);
  const doubleBlocks = ptrs * ptrs;
  const offsets: number[] = [];
  let final = 0;
  let outOfRange = false;
  let index = blockIndex;

  if (index < 0n) {
    outOfRange = true;
  } else if (index < directBlocks) {
    offsets.push(Number(index));
    final = EXT2_NDIR_BLOCKS;
  } else if ((index -= directBlocks) < ptrs) {
    offsets.push(EXT2_IND_BLOCK, Number(index));
    final = Number(ptrs);
  } else if ((index -= ptrs) < doubleBlocks) {
    offsets.push(EXT2_DIND_BLOCK, Number(index >> ptrsBits), Number(index & (ptrs - 1n)));
    final = Number(ptrs);
  } else if (((index -= doubleBlocks) >> (ptrsBits * 2n)) < ptrs) {
    offsets.push(
      EXT2_TIND_BLOCK,
      Number(index >> (ptrsBits * 2n)),
      Number((index >> ptrsBits) & (ptrs - 1n)),
      Number(index & (ptrs - 1n)),
    );
    final = Number(ptrs);
  } else {
    outOfRange = true;
  }
  return { offsets, depth: offsets.length, final, outOfRange };
}

const PATH_NAME_BY_DEPTH = ['direct', 'indirect', 'double-indirect', 'triple-indirect'];

export interface Ext2BlockMapping {
  /** 文件内的逻辑块号 */
  blockIndex: bigint;
  /** 文件偏移落在这个块内的第几个字节 */
  offsetInBlock: number;
  /** 盘面块号；洞的时候是 `null` */
  block: bigint | null;
  hole: boolean;
  /** 洞的种类：`data` = 数据块没分配，`indirect` = 中间某层间接块不存在 */
  holeKind: 'data' | 'indirect' | null;
  /** `direct`/`indirect`/`double-indirect`/`triple-indirect` */
  pathName: string;
  offsets: number[];
  /** 途中读过的间接块（盘面块号），按层次顺序 */
  indirectBlocks: bigint[];
  /** 指向这个数据块的**最后一级指针**在盘面上的字节偏移（T07f 要的"谁指向它"） */
  pointerByteOffset: bigint | null;
  /** 块号是否落在文件系统的数据区里（对应内核 `ext2_data_block_valid()`） */
  blockValid: boolean;
  /** 512 字节扇区口径的 LBA；洞的时候是 `null` */
  lba: bigint | null;
  /** 数据块在盘面上的字节偏移；洞的时候是 `null` */
  byteOffset: bigint | null;
  outOfRange: boolean;
  notes: string[];
  evidence: EvidenceRef;
}

async function readBlockCached(
  source: DiskByteSource,
  cache: Map<string, Uint8Array> | undefined,
  block: bigint,
  blockSize: number,
): Promise<Uint8Array> {
  const key = block.toString();
  const hit = cache?.get(key);
  if (hit !== undefined) return hit;
  const bytes = await source.read(byteOffsetForBlock(block, blockSize), blockSize);
  cache?.set(key, bytes);
  return bytes;
}

/**
 * 文件偏移 → 盘面块（→ LBA）。
 *
 * 走指针树：`offsets[0]` 在 inode 里，之后每一级都在上一级指的间接块里。
 * 任何一级指针是 0 就到此为止 —— 内核 `ext2_get_branch()` 遇到 0 指针会把
 * "这条路径不存在"报给上层，读这段偏移得到的是全 0，**不是**盘上的数据。
 * 这两种洞要分开说（`holeKind`），否则一个"读到 0 的稀疏文件"会被解释成"盘上写了 0"。
 */
export async function mapExt2FileOffset(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
  inode: Ext2InodeFacts,
  fileOffset: bigint,
  options: { cache?: Map<string, Uint8Array> } = {},
): Promise<Ext2BlockMapping> {
  if (fileOffset < 0n) {
    throw new Ext2ParseError('negative-offset', `文件偏移不能为负：${fileOffset}`, {
      fileOffset: fileOffset.toString(),
    });
  }
  const blockSize = sb.blockSize;
  const blockIndex = fileOffset / BigInt(blockSize);
  const offsetInBlock = Number(fileOffset % BigInt(blockSize));
  const path = ext2BlockToPath(blockIndex, blockSize);
  const notes: string[] = [];
  const indirectBlocks: bigint[] = [];
  const evidence = (extra: string[]): EvidenceRef => diskEvidence(
    source,
    inode.location.byteOffset,
    sb.inodeSize,
    ['ext2:block-map', `ino:${inode.ino}`, `block:${blockIndex}`, ...extra],
  );

  if (path.outOfRange) {
    notes.push(
      `逻辑块号 ${blockIndex} 超出三间接能表达的范围（每块 ${ext2AddrPerBlock(blockSize)} 个指针）：`
      + '内核 ext2_block_to_path() 在这里打 "block is too big" 并把它当作出错',
    );
    return {
      blockIndex,
      offsetInBlock,
      block: null,
      hole: false,
      holeKind: null,
      pathName: 'out-of-range',
      offsets: path.offsets,
      indirectBlocks,
      pointerByteOffset: null,
      blockValid: false,
      lba: null,
      byteOffset: null,
      outOfRange: true,
      notes,
      evidence: evidence(['out-of-range']),
    };
  }

  let containerByteOffset = inode.location.byteOffset + BigInt(EXT2_INODE_FIELDS.block);
  let block = BigInt(inode.block[path.offsets[0]]);
  let holeKind: 'data' | 'indirect' | null = null;

  for (let level = 1; level < path.depth; level += 1) {
    if (block === 0n) {
      holeKind = 'indirect';
      break;
    }
    indirectBlocks.push(block);
    containerByteOffset = byteOffsetForBlock(block, blockSize);
    const bytes = await readBlockCached(source, options.cache, block, blockSize);
    block = readU32(bytes, path.offsets[level] * 4);
  }

  const pointerByteOffset = containerByteOffset + BigInt(path.offsets[path.depth - 1] * 4);
  if (block === 0n && holeKind === null) holeKind = 'data';
  const hole = block === 0n;

  if (hole) {
    notes.push(holeKind === 'indirect'
      ? `第 ${indirectBlocks.length} 级间接块指针是 0：这条路径整个不存在，读这段偏移得到全 0`
      : `逻辑块号 ${blockIndex} 的指针是 0（洞）：读这段偏移得到全 0，盘上并没有这些字节`);
  }

  const firstValidBlock = sb.firstDataBlock;
  const lastValidBlock = sb.firstDataBlock + sb.blocksCount;
  const blockValid = !hole && block >= firstValidBlock && block < lastValidBlock;
  if (!hole && !blockValid) {
    notes.push(
      `指针指向块 ${block}，但文件系统的数据区是 [${firstValidBlock}, ${lastValidBlock})：`
      + '这个块号越界（内核 ext2_data_block_valid() 会拒绝这样的盘）',
    );
  }

  return {
    blockIndex,
    offsetInBlock,
    block: hole ? null : block,
    hole,
    holeKind,
    pathName: PATH_NAME_BY_DEPTH[path.depth - 1] ?? `depth-${path.depth}`,
    offsets: path.offsets,
    indirectBlocks,
    pointerByteOffset,
    blockValid,
    lba: hole ? null : lbaForBlock(block, blockSize),
    byteOffset: hole ? null : byteOffsetForBlock(block, blockSize) + BigInt(offsetInBlock),
    outOfRange: false,
    notes,
    evidence: evidence([
      hole ? `hole:${holeKind}` : `block:${block}`,
      `path:${PATH_NAME_BY_DEPTH[path.depth - 1] ?? 'unknown'}`,
    ]),
  };
}

export interface Ext2Extent {
  /** 文件内的起始逻辑块 */
  startBlock: bigint;
  blockCount: number;
  /** 盘面上的起始块；洞是 `null` */
  physicalStart: bigint | null;
  hole: boolean;
  pathName: string;
}

export interface Ext2BlockMapFacts {
  inode: Ext2InodeFacts;
  /** 按 `i_size` 算，文件一共有几个逻辑块 */
  fileBlocks: number;
  /** 这次真的解了几个 */
  scannedBlocks: number;
  truncated: boolean;
  /** 连续区间（盘面上连续分配的一段合成一条，洞也合成一条） */
  extents: Ext2Extent[];
  /** 用到的间接块（去重后，按发现顺序） */
  indirectBlocks: bigint[];
  holes: Array<{ startBlock: bigint; blockCount: number }>;
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 把整个文件的块映射解成区间表。
 *
 * 用途有两个：一是面板上"probe.bin 占了盘上哪几段"这种一眼能看的东西，
 * 二是 T07f 要把文件区间接到 I/O 上，需要区间而不是单个块。
 * 中间用一张按块号的缓存：双间接/三间接块在连续解的时候会被反复穿过，
 * 每个逻辑块都重读一遍间接块会让 2 MiB 的文件多读几百次同一块。
 */
export async function readExt2BlockMap(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
  inode: Ext2InodeFacts,
  options: { maxBlocks?: number } = {},
): Promise<Ext2BlockMapFacts> {
  const blockSize = sb.blockSize;
  const fileBlocks = inode.size === 0n
    ? 0
    : Number((inode.size + BigInt(blockSize - 1)) / BigInt(blockSize));
  const maxBlocks = options.maxBlocks ?? 4096;
  const scannedBlocks = Math.min(fileBlocks, maxBlocks);
  const notes: string[] = [];
  if (fileBlocks > scannedBlocks) {
    notes.push(`文件有 ${fileBlocks} 个逻辑块，这次只解了前 ${scannedBlocks} 个（maxBlocks 上限）`);
  }
  const cache = new Map<string, Uint8Array>();
  const extents: Ext2Extent[] = [];
  const holes: Array<{ startBlock: bigint; blockCount: number }> = [];
  const indirectSeen = new Set<string>();
  const indirectBlocks: bigint[] = [];

  for (let index = 0; index < scannedBlocks; index += 1) {
    const mapped = await mapExt2FileOffset(source, sb, inode, BigInt(index) * BigInt(blockSize), { cache });
    for (const block of mapped.indirectBlocks) {
      if (!indirectSeen.has(block.toString())) {
        indirectSeen.add(block.toString());
        indirectBlocks.push(block);
      }
    }
    const last = extents[extents.length - 1];
    if (mapped.hole) {
      if (last !== undefined && last.hole && last.startBlock + BigInt(last.blockCount) === BigInt(index)) {
        last.blockCount += 1;
      } else {
        extents.push({
          startBlock: BigInt(index),
          blockCount: 1,
          physicalStart: null,
          hole: true,
          pathName: mapped.pathName,
        });
      }
      const lastHole = holes[holes.length - 1];
      if (lastHole !== undefined && lastHole.startBlock + BigInt(lastHole.blockCount) === BigInt(index)) {
        lastHole.blockCount += 1;
      } else {
        holes.push({ startBlock: BigInt(index), blockCount: 1 });
      }
      continue;
    }
    if (last !== undefined && !last.hole && last.physicalStart !== null && mapped.block !== null
      && last.physicalStart + BigInt(last.blockCount) === mapped.block) {
      last.blockCount += 1;
    } else {
      extents.push({
        startBlock: BigInt(index),
        blockCount: 1,
        physicalStart: mapped.block,
        hole: false,
        pathName: mapped.pathName,
      });
    }
  }

  return {
    inode,
    fileBlocks,
    scannedBlocks,
    truncated: fileBlocks > scannedBlocks,
    extents,
    indirectBlocks,
    holes,
    notes,
    evidence: diskEvidence(source, inode.location.byteOffset, sb.inodeSize, [
      'ext2:block-map-range',
      `ino:${inode.ino}`,
      `blocks:${scannedBlocks}`,
      `extents:${extents.length}`,
    ]),
  };
}

/** 一步到位：文件内的字节偏移 → 盘面块 → LBA。 */
export async function ext2FileOffsetToLba(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
  inode: Ext2InodeFacts,
  fileOffset: bigint,
  options: { cache?: Map<string, Uint8Array> } = {},
): Promise<{ mapping: Ext2BlockMapping; lba: bigint | null }> {
  const mapping = await mapExt2FileOffset(source, sb, inode, fileOffset, options);
  return { mapping, lba: mapping.lba };
}