/**
 * ext2 盘面结构：超级块与块组描述符（T07e 上半部分）。
 *
 * 这一层要回答四个问题，每一个都有"看起来对但其实错"的坑：
 *
 * 1. **超级块在哪**。前 1024 字节是引导块，超级块固定从字节 1024 开始 —— 与块大小无关。
 *    块大小 ≥ 2048 时，超级块就坐在第 0 块里面（所以 `s_first_data_block = 0`）；
 *    块大小 = 1024 时它是独立的第 1 块（`s_first_data_block = 1`）。这两件事互相牵连，
 *    推导块组描述符表的位置时要用同一个 `s_first_data_block`。
 * 2. **块大小怎么来的**。盘上存的是 `s_log_block_size`（对 1024 取对数），
 *    即 `blockSize = 1024 << s_log_block_size`。把它当"就是块大小"会得到 0/2 这种数。
 * 3. **inode 大小看版本**。`s_rev_level = 0`（GOOD_OLD_REV）时 inode 固定 128 字节，
 *    那 128 字节之后的字段根本不存在；只有 `EXT2_DYNAMIC_REV` 才有 `s_inode_size`。
 *    照抄 `s_inode_size` 在旧盘上会读到 0，然后"每个 inode 都落在同一个位置"。
 * 4. **特性位决定"这个盘我到底能不能解析"**。INCOMPAT 位里有内核不认识的位时内核会拒绝挂载；
 *    解析器必须同样拒绝，而不是按自己认识的那部分继续解 —— 那会读出结构对但语义错的结果。
 *    这里刻意不"尽力而为"。
 *
 * 字节布局的判据来自内核源码（`fs/ext2/ext2.h` 的 `struct ext2_super_block` /
 * `struct ext2_group_desc`），偏移量另有内核自己的常量对照：
 * `include/linux/ext2_fs.h` 的 `EXT2_SB_MAGIC_OFFSET = 0x38`、`EXT2_SB_BLOCKS_OFFSET = 0x04`、
 * `EXT2_SB_BSIZE_OFFSET = 0x18`。
 */

import { toHex } from '../../contracts/common.ts';
import { DiskReadError, diskEvidence, formatUuid, readCString, readU16, readU32 } from './source.ts';
import type { DiskByteSource } from './source.ts';

export class Ext2ParseError extends DiskReadError {}

/** 超级块在盘面上的固定位置（前 1024 字节是引导块）。 */
export const EXT2_SUPERBLOCK_OFFSET = 1024n;

/** `EXT2_SUPER_MAGIC`（`fs/ext2/ext2.h`）。 */
export const EXT2_SUPER_MAGIC = 0xef53;

export const EXT2_GOOD_OLD_REV = 0;
export const EXT2_DYNAMIC_REV = 1;
export const EXT2_GOOD_OLD_INODE_SIZE = 128;
export const EXT2_GOOD_OLD_FIRST_INO = 11;

/** 目录项长度必须是 4 的倍数：`EXT2_DIR_REC_LEN(name_len) = (name_len + 8 + 3) & ~3`。 */
export const EXT2_DIR_PAD = 4;

export function ext2RecLen(nameLen: number): number {
  return (nameLen + 8 + EXT2_DIR_PAD - 1) & ~(EXT2_DIR_PAD - 1);
}

/** 一位的特性描述，`note` 写清"这一位对我们的解析意味着什么"。 */
export interface Ext2FeatureBit {
  name: string;
  masked: number;
  note: string;
}

/**
 * COMPAT 特性：不认识也能安全读写（只是丢功能）。
 *
 * `HAS_JOURNAL` 单独标出来：它在 ext2 的超级块里出现，说明这张盘其实是 ext3/ext4 的盘
 * （或者曾经挂过日志）。那不属于"ext2 盘面"这一课，要如实说，而不是当作 ext2 继续讲。
 */
export const EXT2_COMPAT_FEATURES: Ext2FeatureBit[] = [
  { name: 'EXT2_FEATURE_COMPAT_DIR_PREALLOC', masked: 0x0001, note: '目录预分配' },
  { name: 'EXT2_FEATURE_COMPAT_IMAGIC_INODES', masked: 0x0002, note: 'AFS 的 imagic inode（Linux 不用）' },
  { name: 'EXT3_FEATURE_COMPAT_HAS_JOURNAL', masked: 0x0004, note: '有日志：这张盘是 ext3/ext4 形态，不是纯 ext2' },
  { name: 'EXT2_FEATURE_COMPAT_EXT_ATTR', masked: 0x0008, note: '扩展属性块（inode 的 i_file_acl 指向它）' },
  { name: 'EXT2_FEATURE_COMPAT_RESIZE_INO', masked: 0x0010, note: '保留块组描述符块，供扩容用（GDT 后面会多出几块保留块）' },
  { name: 'EXT2_FEATURE_COMPAT_DIR_INDEX', masked: 0x0020, note: '目录可以建成 htree 索引目录' },
];

/** INCOMPAT 特性：内核有不认识的位就**拒绝挂载**。 */
export const EXT2_INCOMPAT_FEATURES: Ext2FeatureBit[] = [
  { name: 'EXT2_FEATURE_INCOMPAT_COMPRESSION', masked: 0x0001, note: '压缩（内核 ext2 不支持）' },
  { name: 'EXT2_FEATURE_INCOMPAT_FILETYPE', masked: 0x0002, note: '目录项带 file_type 字节（`ext2_dir_entry_2`）' },
  { name: 'EXT3_FEATURE_INCOMPAT_RECOVER', masked: 0x0004, note: '日志需要恢复：盘面还没收拾干净' },
  { name: 'EXT3_FEATURE_INCOMPAT_JOURNAL_DEV', masked: 0x0008, note: '这张盘本身就是日志设备' },
  { name: 'EXT2_FEATURE_INCOMPAT_META_BG', masked: 0x0010, note: '元块组：备份超级块的位置另有算法' },
];

/** RO_COMPAT 特性：不认识时只能**只读**挂载。 */
export const EXT2_RO_COMPAT_FEATURES: Ext2FeatureBit[] = [
  { name: 'EXT2_FEATURE_RO_COMPAT_SPARSE_SUPER', masked: 0x0001, note: '稀疏超级块：只有部分块组存超级块备份' },
  { name: 'EXT2_FEATURE_RO_COMPAT_LARGE_FILE', masked: 0x0002, note: '大文件：普通文件的 i_dir_acl 当 i_size 的高 32 位用' },
  { name: 'EXT2_FEATURE_RO_COMPAT_BTREE_DIR', masked: 0x0004, note: '目录用 B 树（老 ext2 的可选特性）' },
];

/**
 * 内核认识的 INCOMPAT 位（`EXT2_FEATURE_INCOMPAT_SUPP` = FILETYPE | META_BG）。
 *
 * 这里刻意照抄内核那一行，而不是"我们实现了什么就算支持什么"：支持与否是内核的判据，
 * 我们的解析能力是另一回事（解析器认识的位少一些时，只在需要那一处时才拒绝）。
 */
export const EXT2_INCOMPAT_SUPP = 0x0002 | 0x0010;

/** 内核认识的 RO_COMPAT 位（`EXT2_FEATURE_RO_COMPAT_SUPP`）。 */
export const EXT2_RO_COMPAT_SUPP = 0x0001 | 0x0002 | 0x0004;

/** inode 的 `i_flags` 里"这个目录是 htree 索引目录"那一位（`EXT2_INDEX_FL` = `FS_INDEX_FL` = 0x1000）。 */
export const EXT2_INDEX_FL = 0x00001000;

/**
 * 超级块字段的字节偏移。
 *
 * 顺序就是 `struct ext2_super_block` 的顺序（字段都是自然对齐，所以偏移可以直接累加）；
 * 三个带名字的偏移由内核自己的常量对照（见文件头注释）。
 */
export const EXT2_SB_FIELDS = {
  inodesCount: 0x00,
  blocksCount: 0x04,
  reservedBlocksCount: 0x08,
  freeBlocksCount: 0x0c,
  freeInodesCount: 0x10,
  firstDataBlock: 0x14,
  logBlockSize: 0x18,
  logFragmentSize: 0x1c,
  blocksPerGroup: 0x20,
  fragmentsPerGroup: 0x24,
  inodesPerGroup: 0x28,
  mountTime: 0x2c,
  writeTime: 0x30,
  mountCount: 0x34,
  maxMountCount: 0x36,
  magic: 0x38,
  state: 0x3a,
  errors: 0x3c,
  minorRevLevel: 0x3e,
  lastCheck: 0x40,
  checkInterval: 0x44,
  creatorOs: 0x48,
  revLevel: 0x4c,
  defResuid: 0x50,
  defResgid: 0x52,
  firstIno: 0x54,
  inodeSize: 0x58,
  blockGroupNr: 0x5a,
  featureCompat: 0x5c,
  featureIncompat: 0x60,
  featureRoCompat: 0x64,
  uuid: 0x68,
  volumeName: 0x78,
  lastMounted: 0x88,
  hashSeed: 0xec,
  defHashVersion: 0xfc,
  defaultMountOpts: 0x100,
  firstMetaBg: 0x104,
} as const;

export const EXT2_SB_SIZE = 1024;

/** 组描述符的字节偏移（`struct ext2_group_desc`，32 字节）。 */
export const EXT2_GD_FIELDS = {
  blockBitmap: 0x00,
  inodeBitmap: 0x04,
  inodeTable: 0x08,
  freeBlocksCount: 0x0c,
  freeInodesCount: 0x0e,
  usedDirsCount: 0x10,
  pad: 0x12,
  reserved: 0x14,
} as const;

export const EXT2_GROUP_DESC_SIZE = 32;

/** `s_state` 的取值（`EXT2_VALID_FS` / `EXT2_ERROR_FS`）。 */
export const EXT2_FS_STATES: Array<{ value: number; name: string }> = [
  { value: 1, name: 'EXT2_VALID_FS' },
  { value: 2, name: 'EXT2_ERROR_FS' },
];

/** `s_errors` 的取值。 */
export const EXT2_ERROR_BEHAVIOURS: Array<{ value: number; name: string }> = [
  { value: 1, name: 'EXT2_ERRORS_CONTINUE' },
  { value: 2, name: 'EXT2_ERRORS_RO' },
  { value: 3, name: 'EXT2_ERRORS_PANIC' },
];

/** `s_creator_os` 的取值。 */
export const EXT2_CREATOR_OS: Array<{ value: number; name: string }> = [
  { value: 0, name: 'EXT2_OS_LINUX' },
  { value: 1, name: 'EXT2_OS_HURD' },
  { value: 2, name: 'EXT2_OS_MASIX' },
  { value: 3, name: 'EXT2_OS_FREEBSD' },
  { value: 4, name: 'EXT2_OS_LITES' },
];

/** `s_def_hash_version` 的取值（dir_index 用的哈希）。 */
export const EXT2_HASH_VERSIONS: Array<{ value: number; name: string }> = [
  { value: 0, name: 'legacy' },
  { value: 1, name: 'half_md4' },
  { value: 2, name: 'tea' },
];

function bitsSet(value: number, table: Ext2FeatureBit[]): string[] {
  return table.filter((entry) => (value & entry.masked) !== 0).map((entry) => entry.name);
}

function bitsUnknown(value: number, table: Ext2FeatureBit[]): number {
  const known = table.reduce((mask, entry) => mask | entry.masked, 0);
  return value & ~known;
}

function nameOf(table: Array<{ value: number; name: string }>, value: number): string | null {
  return table.find((entry) => entry.value === value)?.name ?? null;
}

export interface Ext2SuperblockFacts {
  /** 超级块在盘面上的字节偏移（恒为 1024） */
  offset: bigint;
  magic: number;
  magicOk: boolean;
  revLevel: number;
  revLevelName: string;
  minorRevLevel: number;
  inodesCount: bigint;
  blocksCount: bigint;
  reservedBlocksCount: bigint;
  freeBlocksCount: bigint;
  freeInodesCount: bigint;
  firstDataBlock: bigint;
  logBlockSize: number;
  /** `1024 << s_log_block_size` */
  blockSize: number;
  logFragmentSize: number;
  blocksPerGroup: bigint;
  fragmentsPerGroup: bigint;
  inodesPerGroup: bigint;
  mountTime: number;
  writeTime: number;
  mountCount: number;
  maxMountCount: number;
  state: number;
  stateName: string | null;
  errors: number;
  errorsName: string | null;
  lastCheck: number;
  checkInterval: number;
  creatorOs: number;
  creatorOsName: string | null;
  defResuid: number;
  defResgid: number;
  firstIno: bigint;
  /** `s_rev_level = 0` 时这里没有这个字段，按 GOOD_OLD_INODE_SIZE 报，并记 notes */
  inodeSize: number;
  blockGroupNr: number;
  featureCompat: number;
  featureIncompat: number;
  featureRoCompat: number;
  compatNames: string[];
  incompatNames: string[];
  roCompatNames: string[];
  /** 内核不认识的 INCOMPAT 位（非 0 意味着内核会拒绝挂载） */
  unsupportedIncompat: number;
  /** 内核不认识的 RO_COMPAT 位（非 0 意味着只能只读挂载） */
  unsupportedRoCompat: number;
  /** 我们连名字都没有的位（表里没有的位） */
  unnamedIncompat: number;
  uuid: string;
  volumeName: string;
  lastMounted: string;
  hashSeed: number[];
  defHashVersion: number;
  defHashVersionName: string | null;
  defaultMountOpts: number;
  firstMetaBg: number;
  /** `blocksCount << logBlockSize`：内核 `ext2_image_size()` 的算法；块大小不自洽时给 `null` */
  imageBytes: bigint | null;
  /** 本盘的块组个数（向上取整） */
  groupCount: bigint;
  /** 每个块组里 inode 表占多少块（向上取整） */
  inodeTableBlocksPerGroup: bigint;
  /** 块组描述符表从哪个块开始 */
  groupDescTableBlock: bigint;
  /** 能否继续解析（INCOMPAT 全认识、magic 对、块大小合法） */
  parseable: boolean;
  notes: string[];
  evidence: ReturnType<typeof diskEvidence>;
}

/**
 * 读并解释超级块。
 *
 * 刻意**不抛错**的场景：magic 不对、有内核不认识的 INCOMPAT 位。这两种都属于"盘面本身
 * 就说明了它是什么"，调用方需要看到盘上到底写了什么（比如课程里要展示"这张盘不是 ext2"），
 * 所以这里照实填字段，把 `parseable = false` 与原因放进 `notes`；
 * 真正阻止继续解析的判据由 `assertExt2Parseable()` 提供，交给上层决定是否中止。
 */
export async function readExt2Superblock(source: DiskByteSource): Promise<Ext2SuperblockFacts> {
  const bytes = await source.read(EXT2_SUPERBLOCK_OFFSET, EXT2_SB_SIZE);
  const f = EXT2_SB_FIELDS;
  const notes: string[] = [];

  const magic = readU16(bytes, f.magic);
  const revLevel = Number(readU32(bytes, f.revLevel));
  const logBlockSize = Number(readU32(bytes, f.logBlockSize));
  const rawInodeSize = readU16(bytes, f.inodeSize);
  const dynamic = revLevel === EXT2_DYNAMIC_REV;
  let inodeSize = rawInodeSize;
  if (!dynamic) {
    // 旧格式超级块里 0x58 之后是"保留"，读出来的数字没有意义。
    inodeSize = EXT2_GOOD_OLD_INODE_SIZE;
    if (rawInodeSize !== 0 && rawInodeSize !== EXT2_GOOD_OLD_INODE_SIZE) {
      notes.push(
        `s_rev_level=${revLevel}（GOOD_OLD_REV），这个版本固定用 ${EXT2_GOOD_OLD_INODE_SIZE} 字节的 inode；`
        + `盘上 0x58 处的 ${rawInodeSize} 属于旧格式的保留区，不当 inode 大小用`,
      );
    }
  }

  const blockSize = 1024 << logBlockSize;
  if (blockSize < 1024 || blockSize > 65536 || (blockSize & (blockSize - 1)) !== 0) {
    notes.push(`s_log_block_size=${logBlockSize} 算出的块大小 ${blockSize} 不是 1024..65536 的 2 的幂，盘面不自洽`);
  }

  const blocksCount = readU32(bytes, f.blocksCount);
  const inodesCount = readU32(bytes, f.inodesCount);
  const blocksPerGroup = readU32(bytes, f.blocksPerGroup);
  const inodesPerGroup = readU32(bytes, f.inodesPerGroup);
  const featureCompat = Number(readU32(bytes, f.featureCompat));
  const featureIncompat = Number(readU32(bytes, f.featureIncompat));
  const featureRoCompat = Number(readU32(bytes, f.featureRoCompat));
  const firstDataBlock = readU32(bytes, f.firstDataBlock);
  const groupDescTableBlock = firstDataBlock + 1n;

  const unsupportedIncompat = featureIncompat & ~EXT2_INCOMPAT_SUPP;
  const unsupportedRoCompat = featureRoCompat & ~EXT2_RO_COMPAT_SUPP;
  const groupCount = blocksPerGroup === 0n ? 0n : (blocksCount + blocksPerGroup - 1n) / blocksPerGroup;
  const inodeBytesPerGroup = inodesPerGroup * BigInt(inodeSize);
  const inodeTableBlocksPerGroup = blockSize === 0
    ? 0n
    : (inodeBytesPerGroup + BigInt(blockSize - 1)) / BigInt(blockSize);

  const magicOk = magic === EXT2_SUPER_MAGIC;
  const parseable = magicOk && unsupportedIncompat === 0 && blockSize >= 1024 && inodeSize >= EXT2_GOOD_OLD_INODE_SIZE;

  if (!magicOk) {
    notes.push(`超级块 magic = ${toHex(BigInt(magic))}，不是 EXT2_SUPER_MAGIC(0xef53)：这张盘不是 ext2 文件系统`);
  }
  if (unsupportedIncompat !== 0) {
    notes.push(
      `s_feature_incompat 里有内核不认识的位 ${toHex(BigInt(unsupportedIncompat))}`
      + `（内核认识的只有 ${toHex(BigInt(EXT2_INCOMPAT_SUPP))} = FILETYPE|META_BG）：`
      + '内核会拒绝挂载这样一张盘，解析器同样不按"自己认识的那部分"继续读',
    );
  }
  if (unsupportedRoCompat !== 0) {
    notes.push(
      `s_feature_ro_compat 里有不认识的位 ${toHex(BigInt(unsupportedRoCompat))}：`
      + '这种情况内核只允许只读挂载，写盘的语义不成立',
    );
  }
  if ((featureCompat & 0x0004) !== 0) {
    notes.push('COMPAT 位里有 HAS_JOURNAL：这张盘带日志（ext3/ext4 形态），不是纯 ext2');
  }
  if (dynamic && (rawInodeSize === 0 || rawInodeSize % 4 !== 0)) {
    notes.push(`s_inode_size=${rawInodeSize} 不是 4 的倍数（或为 0），inode 定位会落在半个字段上`);
  }

  return {
    offset: EXT2_SUPERBLOCK_OFFSET,
    magic,
    magicOk,
    revLevel,
    revLevelName: dynamic ? 'EXT2_DYNAMIC_REV' : (revLevel === EXT2_GOOD_OLD_REV ? 'EXT2_GOOD_OLD_REV' : `未知(${revLevel})`),
    minorRevLevel: readU16(bytes, f.minorRevLevel),
    inodesCount,
    blocksCount,
    reservedBlocksCount: readU32(bytes, f.reservedBlocksCount),
    freeBlocksCount: readU32(bytes, f.freeBlocksCount),
    freeInodesCount: readU32(bytes, f.freeInodesCount),
    firstDataBlock,
    logBlockSize,
    blockSize,
    logFragmentSize: Number(readU32(bytes, f.logFragmentSize)) << 0,
    blocksPerGroup,
    fragmentsPerGroup: readU32(bytes, f.fragmentsPerGroup),
    inodesPerGroup,
    mountTime: Number(readU32(bytes, f.mountTime)),
    writeTime: Number(readU32(bytes, f.writeTime)),
    mountCount: readU16(bytes, f.mountCount),
    maxMountCount: readU16(bytes, f.maxMountCount),
    state: readU16(bytes, f.state),
    stateName: nameOf(EXT2_FS_STATES, readU16(bytes, f.state)),
    errors: readU16(bytes, f.errors),
    errorsName: nameOf(EXT2_ERROR_BEHAVIOURS, readU16(bytes, f.errors)),
    lastCheck: Number(readU32(bytes, f.lastCheck)),
    checkInterval: Number(readU32(bytes, f.checkInterval)),
    creatorOs: Number(readU32(bytes, f.creatorOs)),
    creatorOsName: nameOf(EXT2_CREATOR_OS, Number(readU32(bytes, f.creatorOs))),
    defResuid: readU16(bytes, f.defResuid),
    defResgid: readU16(bytes, f.defResgid),
    firstIno: readU32(bytes, f.firstIno),
    inodeSize,
    blockGroupNr: readU16(bytes, f.blockGroupNr),
    featureCompat,
    featureIncompat,
    featureRoCompat,
    compatNames: bitsSet(featureCompat, EXT2_COMPAT_FEATURES),
    incompatNames: bitsSet(featureIncompat, EXT2_INCOMPAT_FEATURES),
    roCompatNames: bitsSet(featureRoCompat, EXT2_RO_COMPAT_FEATURES),
    unsupportedIncompat,
    unsupportedRoCompat,
    unnamedIncompat: bitsUnknown(featureIncompat, EXT2_INCOMPAT_FEATURES),
    uuid: formatUuid(bytes, f.uuid),
    volumeName: readCString(bytes, f.volumeName, 16),
    lastMounted: readCString(bytes, f.lastMounted, 64),
    hashSeed: [0, 1, 2, 3].map((index) => Number(readU32(bytes, f.hashSeed + index * 4))),
    defHashVersion: bytes[f.defHashVersion],
    defHashVersionName: nameOf(EXT2_HASH_VERSIONS, bytes[f.defHashVersion]),
    defaultMountOpts: Number(readU32(bytes, f.defaultMountOpts)),
    firstMetaBg: Number(readU32(bytes, f.firstMetaBg)),
    // `ext2_image_size()` 的算法是 `blocksCount << s_log_block_size`。这里**必须**先确认
    // 块大小自洽：盘面坏掉时 `s_log_block_size` 可以是任意 32 位数，直接左移会造出一个
    // 天文数字的 BigInt 并抛 `RangeError: Maximum BigInt size exceeded` —— 那不是"解析失败"，
    // 而是被一个坏字段带崩，连"盘面不自洽"这句实话都说不出来。自洽时才算，否则给 null。
    imageBytes: blockSize >= 1024 && blockSize <= 65536 && (blockSize & (blockSize - 1)) === 0
      ? blocksCount << BigInt(logBlockSize)
      : null,
    groupCount,
    inodeTableBlocksPerGroup,
    groupDescTableBlock,
    parseable,
    notes,
    evidence: diskEvidence(source, EXT2_SUPERBLOCK_OFFSET, EXT2_SB_SIZE, [
      `ext2:superblock`,
      `magic:${toHex(BigInt(magic))}`,
      `blockSize:${blockSize}`,
    ]),
  };
}

/** 继续解析前的一道闸：magic 不对或 INCOMPAT 不认识就停在这里。 */
export function assertExt2Parseable(sb: Ext2SuperblockFacts): void {
  if (!sb.magicOk) {
    throw new Ext2ParseError(
      'bad-magic',
      `超级块 magic = ${toHex(BigInt(sb.magic))}，不是 ext2 的 0xef53：不按 ext2 继续解析`,
      { magic: toHex(BigInt(sb.magic)), offset: toHex(sb.offset) },
    );
  }
  if (sb.unsupportedIncompat !== 0) {
    throw new Ext2ParseError(
      'incompat-feature-unsupported',
      `s_feature_incompat 的 ${toHex(BigInt(sb.unsupportedIncompat))} 位内核不认识，`
      + '这类盘内核会拒绝挂载；解析器不假装能读',
      { unsupportedIncompat: toHex(BigInt(sb.unsupportedIncompat)) },
    );
  }
  if (sb.blockSize < 1024) {
    throw new Ext2ParseError('bad-block-size', `块大小 ${sb.blockSize} 不合法（盘面不自洽）`, {
      blockSize: sb.blockSize,
    });
  }
}

export interface Ext2GroupDescriptorFacts {
  index: number;
  /** 这一个描述符在盘面上的字节偏移 */
  address: bigint;
  blockBitmap: bigint;
  inodeBitmap: bigint;
  inodeTable: bigint;
  freeBlocksCount: number;
  freeInodesCount: number;
  usedDirsCount: number;
  pad: number;
  reserved: number[];
  /** 本组覆盖的第一个块号 */
  firstBlock: bigint;
  /** 本组实际覆盖的块数（最后一组可能不满） */
  blocksCount: bigint;
  /** 本组覆盖的第一个 inode 号 */
  firstInode: bigint;
  /** 本组实际覆盖的 inode 数（最后一组可能不满） */
  inodesCount: bigint;
}

export interface Ext2GroupTableFacts {
  address: bigint;
  tableBlock: bigint;
  /** 描述符表占多少块 */
  tableBlocks: bigint;
  descriptors: Ext2GroupDescriptorFacts[];
  /** 描述符表之后紧跟的保留块数（`CONFIG_...RESIZE_INO` 时非 0） */
  reservedGdtBlocks: bigint;
  notes: string[];
  evidence: ReturnType<typeof diskEvidence>;
}

/**
 * 读块组描述符表。
 *
 * 位置：`(s_first_data_block + 1) * blockSize`。为什么加 1：超级块占了它自己那一块
 * （块大小 1024 时超级块是独立的第 1 块，所以表从第 2 块开始；块大小 ≥ 2048 时超级块
 * 坐在第 0 块里，所以表从第 1 块开始）。两种情形都靠 `s_first_data_block` 这一个数区分。
 */
export async function readExt2GroupDescriptors(
  source: DiskByteSource,
  sb: Ext2SuperblockFacts,
): Promise<Ext2GroupTableFacts> {
  assertExt2Parseable(sb);
  const notes: string[] = [];
  const groupCount = Number(sb.groupCount);
  const tableBlock = sb.groupDescTableBlock;
  const byteOffset = tableBlock * BigInt(sb.blockSize);
  const tableBlocks = BigInt(Math.max(1, Math.ceil((groupCount * EXT2_GROUP_DESC_SIZE) / sb.blockSize)));
  const byteLength = Number(tableBlocks) * sb.blockSize;
  const bytes = await source.read(byteOffset, byteLength);
  const descriptors: Ext2GroupDescriptorFacts[] = [];
  const g = EXT2_GD_FIELDS;

  for (let index = 0; index < groupCount; index += 1) {
    const at = index * EXT2_GROUP_DESC_SIZE;
    const firstBlock = BigInt(index) * sb.blocksPerGroup + sb.firstDataBlock;
    const remainingBlocks = sb.blocksCount - BigInt(index) * sb.blocksPerGroup;
    const blocksCount = remainingBlocks < sb.blocksPerGroup ? remainingBlocks : sb.blocksPerGroup;
    const firstInode = BigInt(index) * sb.inodesPerGroup + 1n;
    const remainingInodes = sb.inodesCount - BigInt(index) * sb.inodesPerGroup;
    descriptors.push({
      index,
      address: byteOffset + BigInt(at),
      blockBitmap: readU32(bytes, at + g.blockBitmap),
      inodeBitmap: readU32(bytes, at + g.inodeBitmap),
      inodeTable: readU32(bytes, at + g.inodeTable),
      freeBlocksCount: readU16(bytes, at + g.freeBlocksCount),
      freeInodesCount: readU16(bytes, at + g.freeInodesCount),
      usedDirsCount: readU16(bytes, at + g.usedDirsCount),
      pad: readU16(bytes, at + g.pad),
      reserved: [0, 1, 2].map((slot) => Number(readU32(bytes, at + g.reserved + slot * 4))),
      firstBlock,
      blocksCount,
      firstInode,
      inodesCount: remainingInodes < sb.inodesPerGroup ? remainingInodes : sb.inodesPerGroup,
    });
  }

  // 保留 GDT 块数没有存在超级块里，判据是「GDT 之后、第一个元数据块之前」那几块。
  // 边界必须是**块位图 / inode 位图 / inode 表这三者里最靠前的**那一个：只拿 inode 表
  // 当边界会把中间那两块位图也算进保留区（这张盘上 5 会算成 7，与 dumpe2fs 对不上）。
  const nextMetaBlock = descriptors.length === 0
    ? undefined
    : descriptors
      .flatMap((entry) => [entry.blockBitmap, entry.inodeBitmap, entry.inodeTable])
      .filter((value) => value > tableBlock)
      .sort((a, b) => (a < b ? -1 : 1))[0];
  const reservedGdtBlocks = nextMetaBlock === undefined
    ? 0n
    : nextMetaBlock - tableBlock - tableBlocks;
  if (reservedGdtBlocks > 0n) {
    notes.push(
      `块组描述符表从块 ${tableBlock} 起、占 ${tableBlocks} 块；到第一个元数据块（块 ${nextMetaBlock}）`
      + `之间的 ${reservedGdtBlocks} 块是保留 GDT 块（RESIZE_INO 特性留的扩容位）`,
    );
  }
  return {
    address: byteOffset,
    tableBlock,
    tableBlocks,
    descriptors,
    reservedGdtBlocks,
    notes,
    evidence: diskEvidence(source, byteOffset, byteLength, [
      'ext2:group-descriptors',
      `groups:${groupCount}`,
    ]),
  };
}
