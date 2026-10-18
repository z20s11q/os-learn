/**
 * T07e 单元测试：ext2 盘面解析（超级块 / 块组 / inode / 目录项 / 块映射）。
 *
 * 合成字节按内核源码的偏移与判据构造，覆盖畸形目录项、64 位文件大小、
 * 间接块映射与保留 GDT 边界。真实镜像由 scripts/verify-t07e.mjs
 * 使用 dumpe2fs/debugfs 独立对照。
 *
 * 运行：node --test tests/linux-ext2.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BufferDiskSource,
  EXT2_INCOMPAT_SUPP,
  EXT2_INDEX_FL,
  EXT2_ROOT_INO,
  Ext2ParseError,
  assertExt2Parseable,
  ext2BlockToPath,
  ext2RecLen,
  findDirEntry,
  formatExt2Mode,
  lookupExt2Path,
  mapExt2FileOffset,
  modeToFileType,
  parseExt2DirBlock,
  readExt2BlockMap,
  readExt2Directory,
  readExt2GroupDescriptors,
  readExt2Inode,
  readExt2Superblock,
} from '../packages/linux-decoder/index.ts';

// ---------------------------------------------------------------------------
// 合成镜像
// ---------------------------------------------------------------------------

function putU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function putU32(bytes, offset, value) {
  const v = BigInt(value);
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = Number((v >> BigInt(index * 8)) & 0xffn);
  }
}

/**
 * 造一张只够跑解析的最小 ext2 盘。
 *
 * 块 1024 字节时 `first_data_block = 1`（超级块自己占一块），所以块组描述符表在块 2；
 * 块 4096 字节时超级块坐在块 0 里，`first_data_block = 0`，表在块 1。这个差别正是
 * 解析器要处理的那个坑，所以两种都要能造。
 */
function buildImage(options = {}) {
  const blockSize = options.blockSize ?? 1024;
  const firstDataBlock = blockSize === 1024 ? 1 : 0;
  const blocksCount = options.blocksCount ?? 96;
  const inodesPerGroup = options.inodesPerGroup ?? 16;
  const inodeSize = options.inodeSize ?? 128;
  const blockBitmap = firstDataBlock + 2;
  const inodeBitmap = firstDataBlock + 3;
  const inodeTable = firstDataBlock + 4;
  const bytes = new Uint8Array(blocksCount * blockSize);
  const sb = 1024;
  putU32(bytes, sb + 0x00, inodesPerGroup);
  putU32(bytes, sb + 0x04, blocksCount);
  putU32(bytes, sb + 0x0c, options.freeBlocksCount ?? blocksCount - 8);
  putU32(bytes, sb + 0x10, inodesPerGroup - 4);
  putU32(bytes, sb + 0x14, firstDataBlock);
  putU32(bytes, sb + 0x18, Math.round(Math.log2(blockSize)) - 10);
  putU32(bytes, sb + 0x20, options.blocksPerGroup ?? 8192);
  putU32(bytes, sb + 0x28, inodesPerGroup);
  putU16(bytes, sb + 0x34, 0);
  putU16(bytes, sb + 0x38, options.magic ?? 0xef53);
  putU16(bytes, sb + 0x3a, 1);
  putU16(bytes, sb + 0x3c, 1);
  putU32(bytes, sb + 0x48, 0);
  putU32(bytes, sb + 0x4c, options.revLevel ?? 1);
  putU32(bytes, sb + 0x54, options.firstIno ?? 11);
  putU16(bytes, sb + 0x58, options.revLevel === 0 ? (options.legacyInodeSize ?? 0) : inodeSize);
  putU32(bytes, sb + 0x5c, options.featureCompat ?? 0x0008);
  putU32(bytes, sb + 0x60, options.featureIncompat ?? 0x0002);
  putU32(bytes, sb + 0x64, options.featureRoCompat ?? 0x0002);
  const gdt = (firstDataBlock + 1) * blockSize;
  putU32(bytes, gdt + 0x00, blockBitmap);
  putU32(bytes, gdt + 0x04, inodeBitmap);
  putU32(bytes, gdt + 0x08, inodeTable);
  putU32(bytes, gdt + 0x0c, 0);
  putU32(bytes, gdt + 0x10, 0);
  return {
    bytes,
    blockSize,
    firstDataBlock,
    blockBitmap,
    inodeBitmap,
    inodeTable,
    inodesPerGroup,
    inodeSize,
    blocksCount,
  };
}

function inodeOffset(image, ino) {
  return image.inodeTable * image.blockSize + (ino - 1) * image.inodeSize;
}

function writeInode(image, ino, fields = {}) {
  const at = inodeOffset(image, ino);
  putU16(image.bytes, at + 0x00, fields.mode ?? 0o100644);
  putU16(image.bytes, at + 0x02, fields.uid ?? 0);
  putU32(image.bytes, at + 0x04, fields.sizeLow ?? 0);
  putU16(image.bytes, at + 0x18, fields.gid ?? 0);
  putU16(image.bytes, at + 0x1a, fields.links ?? 1);
  putU32(image.bytes, at + 0x1c, fields.blocks ?? 0);
  putU32(image.bytes, at + 0x20, fields.flags ?? 0);
  for (let index = 0; index < 15; index += 1) {
    putU32(image.bytes, at + 0x28 + index * 4, (fields.block ?? [])[index] ?? 0);
  }
  putU32(image.bytes, at + 0x68, fields.fileAcl ?? 0);
  putU32(image.bytes, at + 0x6c, fields.dirAcl ?? 0);
  return at;
}

function markInodeAllocated(image, ino) {
  const index = ino - 1;
  image.bytes[image.inodeBitmap * image.blockSize + (index >> 3)] |= 1 << (index & 7);
}

function writePointer(image, block, slot, value) {
  putU32(image.bytes, block * image.blockSize + slot * 4, value);
}

function dirent(name, inode, fileType, recLen) {
  const buf = new Uint8Array(recLen);
  putU32(buf, 0, inode);
  putU16(buf, 4, recLen);
  buf[6] = name.length;
  buf[7] = fileType;
  for (let index = 0; index < name.length; index += 1) buf[8 + index] = name.charCodeAt(index);
  return buf;
}

function writeEntries(image, block, entries) {
  let offs = 0;
  for (const entry of entries) {
    image.bytes.set(dirent(entry.name, entry.inode, entry.fileType, entry.recLen), block * image.blockSize + offs);
    offs += entry.recLen;
  }
  return offs;
}

async function openImage(image) {
  const source = new BufferDiskSource({ bytes: image.bytes, diskId: 'synthetic' });
  const sb = await readExt2Superblock(source);
  const groupTable = await readExt2GroupDescriptors(source, sb);
  return { source, sb, groupTable };
}

// ---------------------------------------------------------------------------
// 超级块与块组
// ---------------------------------------------------------------------------

test('ext2：块大小由 s_log_block_size 推出，inode 大小看版本', async () => {
  const small = buildImage({ blockSize: 1024 });
  const one = await openImage(small);
  assert.equal(one.sb.magic, 0xef53);
  assert.equal(one.sb.magicOk, true);
  assert.equal(one.sb.logBlockSize, 0);
  assert.equal(one.sb.blockSize, 1024);
  assert.equal(one.sb.inodeSize, 128);
  assert.equal(one.sb.firstDataBlock, 1n);
  assert.equal(one.sb.groupDescTableBlock, 2n);
  assert.equal(one.sb.parseable, true);

  const big = buildImage({ blockSize: 4096 });
  const two = await openImage(big);
  assert.equal(two.sb.logBlockSize, 2);
  assert.equal(two.sb.blockSize, 4096);
  assert.equal(two.sb.firstDataBlock, 0n);
  assert.equal(two.sb.groupDescTableBlock, 1n);
});

test('ext2：非法 s_log_block_size 标记盘面错误并保留原始字段', async () => {
  const image = buildImage({ blockSize: 1024 });
  // 盘上这个字段可以是任意 32 位数（0x18 处）。塞一个 0xffffffff 进去：
  // `1024 << 0xffffffff` 在 JS 里按移位计数取模 32 算，得不到合法块大小。
  putU32(image.bytes, 1024 + 0x18, 0xffffffff);
  const source = new BufferDiskSource({ bytes: image.bytes, diskId: 'synthetic' });
  const sb = await readExt2Superblock(source);
  // 超级块保留原始字段，parseable 标记解析资格。
  assert.equal(sb.logBlockSize, 0xffffffff);
  assert.equal(sb.parseable, false);
  assert.ok(sb.notes.some((note) => note.includes('不自洽')), '要说明这个块大小不合法');
  // 块大小非法时 imageBytes 为 null，保留字段错误的分类。
  assert.equal(sb.imageBytes, null);
  assert.throws(
    () => assertExt2Parseable(sb),
    (error) => error instanceof Ext2ParseError && error.code === 'bad-block-size',
  );
});

test('ext2：s_rev_level = 0 时 inode 固定 128 字节，0x58 处的值当保留区扔掉', async () => {
  const image = buildImage({ revLevel: 0, legacyInodeSize: 0x1234, inodeSize: 128 });
  const { sb } = await openImage(image);
  assert.equal(sb.revLevelName, 'EXT2_GOOD_OLD_REV');
  assert.equal(sb.inodeSize, 128);
  assert.ok(sb.notes.some((note) => note.includes('保留区')), '要说明那个 0x1234 不是 inode 大小');
});

test('ext2：未知 INCOMPAT 位使后续 ext2 解析被拒绝', async () => {
  const image = buildImage({ featureIncompat: 0x0002 | 0x1000 });
  // 超级块保留原始字段，后续块组描述符读取校验 parseable。
  const sb = await readExt2Superblock(new BufferDiskSource({ bytes: image.bytes }));
  assert.equal(sb.unsupportedIncompat, 0x1000);
  assert.equal(sb.parseable, false);
  assert.equal(EXT2_INCOMPAT_SUPP, 0x0002 | 0x0010);
  assert.throws(() => assertExt2Parseable(sb), (error) => {
    assert.ok(error instanceof Ext2ParseError);
    assert.equal(error.code, 'incompat-feature-unsupported');
    return true;
  });
  // readExt2GroupDescriptors 也要走同一道闸
  await assert.rejects(
    readExt2GroupDescriptors(new BufferDiskSource({ bytes: image.bytes }), sb),
    (error) => error.code === 'incompat-feature-unsupported',
  );
});

test('ext2：magic 错误时保留字段并拒绝后续解析', async () => {
  const image = buildImage({ magic: 0x1234 });
  const sb = await readExt2Superblock(new BufferDiskSource({ bytes: image.bytes }));
  assert.equal(sb.magicOk, false);
  assert.equal(sb.parseable, false);
  assert.throws(() => assertExt2Parseable(sb), (error) => error.code === 'bad-magic');
  // 块组描述符位置依赖超级块字段，读取前校验 magic。
  await assert.rejects(
    readExt2GroupDescriptors(new BufferDiskSource({ bytes: image.bytes }), sb),
    (error) => error.code === 'bad-magic',
  );
});

test('ext2：块组描述符与保留 GDT 块数的边界（要算上块位图/inode 位图）', async () => {
  const image = buildImage({ blockSize: 1024 });
  const { groupTable } = await openImage(image);
  assert.equal(groupTable.tableBlock, 2n);
  assert.equal(groupTable.descriptors.length, 1);
  assert.equal(groupTable.descriptors[0].inodeTable, BigInt(image.inodeTable));
  assert.equal(groupTable.descriptors[0].firstBlock, 1n);
  // 表在块 2、占 1 块；最早的元数据为块 3 的块位图，保留 GDT 以块 3 为边界。
  assert.equal(groupTable.reservedGdtBlocks, 0n);
});

test('ext2：块组覆盖范围（最后一组可能不满）', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 96, blocksPerGroup: 8192, inodesPerGroup: 16 });
  const { groupTable } = await openImage(image);
  assert.equal(groupTable.descriptors[0].blocksCount, 96n);
  assert.equal(groupTable.descriptors[0].inodesCount, 16n);
});

// ---------------------------------------------------------------------------
// inode
// ---------------------------------------------------------------------------

test('ext2：inode 定位按块组、组内 inode 与表偏移换算', async () => {
  const image = buildImage({ blockSize: 1024, inodeSize: 128, inodesPerGroup: 16 });
  const { sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(
    new BufferDiskSource({ bytes: image.bytes }),
    sb,
    groupTable,
    3n,
  );
  assert.equal(inode.location.indexInGroup, 2n);
  assert.equal(inode.location.groupByteOffset, 256n);
  assert.equal(inode.location.block, BigInt(image.inodeTable));
  assert.equal(inode.location.offsetInBlock, 256);
  assert.equal(inode.location.byteOffset, BigInt(image.inodeTable * 1024 + 256));
  assert.equal(inode.location.spansBlock, false);
});

test('ext2：inode 号越界/为 0 时如实报错', async () => {
  const image = buildImage({ inodesPerGroup: 16 });
  const { sb, groupTable } = await openImage(image);
  const source = new BufferDiskSource({ bytes: image.bytes });
  await assert.rejects(readExt2Inode(source, sb, groupTable, 0n), (error) => error.code === 'bad-inode');
  await assert.rejects(readExt2Inode(source, sb, groupTable, 99n), (error) => error.code === 'inode-out-of-range');
});

test('ext2：普通文件拼接 i_size 与 i_dir_acl，其他类型只取 i_size', async () => {
  const image = buildImage({});
  writeInode(image, 1, { mode: 0o100644, sizeLow: 0x00001000, dirAcl: 1, links: 1 });
  writeInode(image, 2, { mode: 0o040755, sizeLow: 0x00001000, dirAcl: 1, links: 2 });
  const { sb, groupTable } = await openImage(image);
  const source = new BufferDiskSource({ bytes: image.bytes });
  const regular = await readExt2Inode(source, sb, groupTable, 1n);
  assert.equal(regular.sizeHighUsed, true);
  assert.equal(regular.size, (1n << 32n) | 0x00001000n);
  assert.equal(regular.isRegular, true);
  assert.equal(regular.fileTypeName, 'EXT2_FT_REG_FILE');
  const directory = await readExt2Inode(source, sb, groupTable, 2n);
  assert.equal(directory.sizeHighUsed, false);
  assert.equal(directory.size, 0x00001000n);
  assert.equal(directory.dirAcl, 1);
  assert.equal(directory.fileTypeName, 'EXT2_FT_DIR');
});

test('ext2：i_blocks 的单位是 512 字节扇区', async () => {
  const image = buildImage({});
  writeInode(image, 1, { mode: 0o100644, sizeLow: 4096, blocks: 8, block: [7], links: 1 });
  const { sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(new BufferDiskSource({ bytes: image.bytes }), sb, groupTable, 1n);
  assert.equal(inode.blocks, 8);
  assert.equal(inode.blocksBytes, 4096);
});

test('ext2：快速符号链接从 i_block[] 读取目标', async () => {
  const image = buildImage({ blockSize: 1024 });
  const target = '/bin/busybox';
  const at = writeInode(image, 1, { mode: 0o120777, sizeLow: target.length, blocks: 0, links: 1 });
  for (let index = 0; index < target.length; index += 1) {
    image.bytes[at + 0x28 + index] = target.charCodeAt(index);
  }
  const { sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(new BufferDiskSource({ bytes: image.bytes }), sb, groupTable, 1n);
  assert.equal(inode.isSymlink, true);
  assert.equal(inode.fastSymlink, true);
  assert.equal(inode.symlinkTarget, target);
});

test('ext2：inode 位图说这块 inode 是空闲的就要说出来', async () => {
  const image = buildImage({});
  writeInode(image, 1, { mode: 0o100644, sizeLow: 10, blocks: 8, links: 1 });
  const { sb, groupTable } = await openImage(image);
  const source = new BufferDiskSource({ bytes: image.bytes });
  const free = await readExt2Inode(source, sb, groupTable, 1n);
  assert.equal(free.allocated, false);
  assert.ok(free.notes.some((note) => note.includes('残留')));
  markInodeAllocated(image, 1);
  const taken = await readExt2Inode(new BufferDiskSource({ bytes: image.bytes }), sb, groupTable, 1n);
  assert.equal(taken.allocated, true);
});

test('ext2：EXT2_INDEX_FL 是索引目录，ext2 驱动仍按线性读', async () => {
  const image = buildImage({});
  writeInode(image, 1, { mode: 0o040755, sizeLow: 1024, flags: EXT2_INDEX_FL, links: 2, block: [7] });
  const { sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(new BufferDiskSource({ bytes: image.bytes }), sb, groupTable, 1n);
  assert.equal(inode.indexedDirectory, true);
  assert.deepEqual(inode.flagNames, ['EXT2_INDEX_FL']);
  assert.ok(inode.notes.some((note) => note.includes('不实现索引查找')));
});

// ---------------------------------------------------------------------------
// 目录项
// ---------------------------------------------------------------------------

function dirBlockOptions(image, overrides = {}) {
  return {
    source: new BufferDiskSource({ bytes: image.bytes }),
    block: 7n,
    byteOffset: BigInt(7 * image.blockSize),
    blockSize: image.blockSize,
    validBytes: image.blockSize,
    inodesCount: BigInt(image.inodesPerGroup),
    hasFileType: true,
    ...overrides,
  };
}

test('ext2：目录项正常遍历，inode == 0 的槽计入空闲空间', async () => {
  const image = buildImage({ blockSize: 1024 });
  const used = writeEntries(image, 7, [
    { name: '.', inode: 1, fileType: 2, recLen: 12 },
    { name: '..', inode: 1, fileType: 2, recLen: 12 },
    { name: 'hello.txt', inode: 3, fileType: 1, recLen: 24 },
    { name: '', inode: 0, fileType: 0, recLen: 1024 - 48 },
  ]);
  assert.equal(used, 1024);
  const parsed = parseExt2DirBlock(image.bytes.subarray(7 * 1024, 8 * 1024), dirBlockOptions(image));
  assert.equal(parsed.faults.length, 0);
  assert.equal(parsed.reachedEnd, true);
  assert.equal(parsed.entries.length, 4);
  assert.equal(parsed.entries[2].name, 'hello.txt');
  assert.equal(parsed.entries[2].inode, 3n);
  assert.equal(parsed.entries[3].free, true);
  assert.equal(parsed.freeBytes, 1024 - 48);
  assert.equal(findDirEntry(parsed.entries, 'hello.txt').inode, 3n);
  assert.equal(findDirEntry(parsed.entries, ''), null, '空闲槽不能被当成一个名字查到');
});

test('ext2：目录项校验逐条生效（Eshort/Ealign/Enamelen/Espan/Einumber/Eend）', async () => {
  const cases = [
    { label: 'Eshort', name: 'a', inode: 1, recLen: 8 },
    { label: 'Ealign', name: 'a', inode: 1, recLen: 14 },
    { label: 'Enamelen', name: 'x'.repeat(200), inode: 1, recLen: 12 },
    { label: 'Einumber', name: 'a', inode: 99, recLen: 12 },
  ];
  for (const item of cases) {
    const image = buildImage({ blockSize: 1024 });
    writeEntries(image, 7, [item]);
    const parsed = parseExt2DirBlock(image.bytes.subarray(7 * 1024, 8 * 1024), dirBlockOptions(image));
    assert.equal(parsed.faults.length, 1, `${item.label} 应当报一条`);
    assert.equal(parsed.faults[0].label, item.label);
    assert.equal(parsed.reachedEnd, false);
    assert.ok(parsed.faults[0].reason.length > 0, '要带内核原文的理由');
  }

  // rec_len=0 命中 ext2_check_folio() 的首条判据 rec_len < EXT2_DIR_REC_LEN(1)，标签为 Eshort。
  const zero = buildImage({ blockSize: 1024 });
  writeEntries(zero, 7, [{ name: 'a', inode: 1, fileType: 1, recLen: 0 }]);
  const zeroed = parseExt2DirBlock(zero.bytes.subarray(7 * 1024, 8 * 1024), dirBlockOptions(zero));
  assert.equal(zeroed.faults.length, 1);
  assert.equal(zeroed.faults[0].label, 'Eshort');
  assert.ok(zeroed.faults[0].reason.includes('rec_len is smaller than minimal'));
  assert.ok(zeroed.faults[0].reason.includes('zero-length'));

  // Espan：第一条铺到离块尾 12 字节处，第二条 rec_len 跨过块尾
  const span = buildImage({ blockSize: 1024 });
  writeEntries(span, 7, [
    { name: '', inode: 0, fileType: 0, recLen: 1012 },
    { name: 'a', inode: 1, fileType: 1, recLen: 1024 },
  ]);
  const spanned = parseExt2DirBlock(span.bytes.subarray(7 * 1024, 8 * 1024), dirBlockOptions(span));
  assert.equal(spanned.faults[0].label, 'Espan');

  // Eend：一条项铺到 1016 字节就没了 —— offs 已经越过"还放得下一条最短项"的位置（1012），
  // 但没走到块尾 1024，两个数对不上。内核这一条报的是 `offs != limit`。
  const gap = buildImage({ blockSize: 1024 });
  writeEntries(gap, 7, [{ name: 'a', inode: 1, fileType: 1, recLen: 1016 }]);
  const ended = parseExt2DirBlock(gap.bytes.subarray(7 * 1024, 8 * 1024), dirBlockOptions(gap));
  assert.equal(ended.faults[0].label, 'Eend');
  assert.equal(ended.faults[0].offsetInBlock, 1016);
  assert.equal(ended.entries.length, 1);
});

test('ext2：目录项错误时终止当前块扫描', async () => {
  const image = buildImage({ blockSize: 1024 });
  writeEntries(image, 7, [
    { name: 'ok', inode: 1, fileType: 1, recLen: 12 },
    { name: 'bad', inode: 1, fileType: 1, recLen: 13 },
    { name: 'never', inode: 1, fileType: 1, recLen: 12 },
  ]);
  const parsed = parseExt2DirBlock(image.bytes.subarray(7 * 1024, 8 * 1024), dirBlockOptions(image));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.faults.length, 1);
  assert.equal(parsed.faults[0].label, 'Ealign');
  assert.ok(parsed.notes.some((note) => note.includes('失去依据')));
});

test('ext2：末块 validBytes 按 i_size 截短', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 96 });
  // 目录 inode 1：2 个块，size = 1024 + 512
  writeInode(image, 1, { mode: 0o040755, sizeLow: 1536, links: 2, block: [7, 8] });
  markInodeAllocated(image, 1);
  writeEntries(image, 7, [
    { name: '.', inode: 1, fileType: 2, recLen: 12 },
    { name: '..', inode: 1, fileType: 2, recLen: 12 },
    { name: 'a', inode: 2, fileType: 1, recLen: 12 },
    { name: '', inode: 0, fileType: 0, recLen: 1024 - 36 },
  ]);
  writeEntries(image, 8, [
    { name: '', inode: 0, fileType: 0, recLen: 500 },
    { name: 'b', inode: 2, fileType: 1, recLen: 12 },
  ]);
  const { source, sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(source, sb, groupTable, 1n);
  const directory = await readExt2Directory(source, sb, groupTable, inode);
  assert.equal(directory.blocks.length, 2);
  assert.equal(directory.blocks[0].validBytes, 1024);
  assert.equal(directory.blocks[1].validBytes, 512);
  assert.equal(directory.faults.length, 0);
  assert.ok(directory.notes.some((note) => note.includes('Ebadsize')), 'size 不是块大小整数倍要说明');
});

test('ext2：目录项跨入间接块时继续读取', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 96 });
  // 1024 字节块：i_block[0..11] 是前 12 个逻辑块，第 13 个逻辑块（下标 12）只能走单间接块。
  // 真实盘上大目录就是这么长的，所以"目录只看直接块"会在大目录上悄悄漏掉后半段。
  const direct = Array.from({ length: 12 }, (_, index) => 7 + index);
  writeInode(image, 1, {
    mode: 0o040755,
    sizeLow: 1024 * 13,
    links: 2,
    block: [...direct, 20, 0, 0],
  });
  markInodeAllocated(image, 1);
  writePointer(image, 20, 0, 19);
  const blocks = [...direct, 19];
  const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'last'];
  for (let index = 0; index < blocks.length; index += 1) {
    const nameLen = ext2RecLen(names[index].length);
    writeEntries(image, blocks[index], [
      { name: '.', inode: 1, fileType: 2, recLen: 12 },
      { name: '..', inode: 1, fileType: 2, recLen: 12 },
      { name: names[index], inode: 2, fileType: 1, recLen: nameLen },
      { name: '', inode: 0, fileType: 0, recLen: 1024 - 24 - nameLen },
    ]);
  }
  const { source, sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(source, sb, groupTable, 1n);
  const directory = await readExt2Directory(source, sb, groupTable, inode);
  assert.equal(directory.logicalBlocks, 13);
  assert.equal(directory.holes.length, 0);
  assert.deepEqual(directory.blocks.map((block) => block.block), blocks.map((block) => BigInt(block)));
  assert.equal(directory.blocks[12].block, 19n, '第 13 个逻辑块来自单间接块 20 的第 0 项');
  assert.equal(directory.faults.length, 0);
  assert.equal(findDirEntry(directory.entries, 'last').inode, 2n);
});

// ---------------------------------------------------------------------------
// 路径查找
// ---------------------------------------------------------------------------

test('ext2：从根逐段查路径，顺带报出每一段的目录项位置', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 96 });
  // 根为 inode 2（EXT2_ROOT_INO）；inode 1 用于坏块记录。
  writeInode(image, 2, { mode: 0o040755, sizeLow: 1024, links: 3, block: [7] });
  writeInode(image, 3, { mode: 0o040755, sizeLow: 1024, links: 2, block: [8] });
  writeInode(image, 4, { mode: 0o100644, sizeLow: 85, blocks: 8, links: 1, block: [9] });
  for (const ino of [2, 3, 4]) markInodeAllocated(image, ino);
  writeEntries(image, 7, [
    { name: '.', inode: 2, fileType: 2, recLen: 12 },
    { name: '..', inode: 2, fileType: 2, recLen: 12 },
    { name: 'data', inode: 3, fileType: 2, recLen: 16 },
    { name: '', inode: 0, fileType: 0, recLen: 1024 - 40 },
  ]);
  writeEntries(image, 8, [
    { name: '.', inode: 3, fileType: 2, recLen: 12 },
    { name: '..', inode: 2, fileType: 2, recLen: 12 },
    { name: 'hello.txt', inode: 4, fileType: 1, recLen: 24 },
    { name: '', inode: 0, fileType: 0, recLen: 1024 - 48 },
  ]);
  const { source, sb, groupTable } = await openImage(image);
  const resolved = await lookupExt2Path(source, sb, groupTable, '/data/hello.txt');
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.missing, null);
  assert.equal(resolved.inode.ino, 4n);
  assert.deepEqual(resolved.components.map((part) => `${part.name}:${part.ino}`), ['/:2', 'data:3', 'hello.txt:4']);
  assert.equal(resolved.inode.block[0], 9);

  const missing = await lookupExt2Path(source, sb, groupTable, '/data/nope.txt');
  assert.equal(missing.resolved, false);
  assert.equal(missing.missing, 'nope.txt');
  assert.equal(missing.inode.ino, 3n, '卡住时留在那个目录上');

  const dotdot = await lookupExt2Path(source, sb, groupTable, '/data/../data/hello.txt');
  assert.equal(dotdot.resolved, true);
  assert.equal(dotdot.inode.ino, 4n);
});

test('ext2：路径中间段为普通文件时报告 not-a-directory', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 96 });
  writeInode(image, 2, { mode: 0o040755, sizeLow: 1024, links: 2, block: [7] });
  writeInode(image, 3, { mode: 0o100644, sizeLow: 85, blocks: 8, links: 1, block: [9] });
  markInodeAllocated(image, 2);
  markInodeAllocated(image, 3);
  writeEntries(image, 7, [
    { name: '.', inode: 2, fileType: 2, recLen: 12 },
    { name: '..', inode: 2, fileType: 2, recLen: 12 },
    { name: 'hello.txt', inode: 3, fileType: 1, recLen: 24 },
    { name: '', inode: 0, fileType: 0, recLen: 1024 - 48 },
  ]);
  const { source, sb, groupTable } = await openImage(image);
  const resolved = await lookupExt2Path(source, sb, groupTable, '/hello.txt/inner');
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.missing, 'inner');
  assert.ok(resolved.notes.some((note) => note.includes('不是目录')));
});

// ---------------------------------------------------------------------------
// 块映射
// ---------------------------------------------------------------------------

test('ext2：块路径按"减容量再判"分四段', () => {
  // 1024 字节块 → 每块 256 个指针
  assert.deepEqual(ext2BlockToPath(0n, 1024).offsets, [0]);
  assert.deepEqual(ext2BlockToPath(11n, 1024).offsets, [11]);
  assert.deepEqual(ext2BlockToPath(12n, 1024).offsets, [12, 0]);
  assert.deepEqual(ext2BlockToPath(267n, 1024).offsets, [12, 255]);
  assert.deepEqual(ext2BlockToPath(268n, 1024).offsets, [13, 0, 0]);
  assert.deepEqual(ext2BlockToPath(268n + 255n, 1024).offsets, [13, 0, 255]);
  assert.deepEqual(ext2BlockToPath(268n + 256n, 1024).offsets, [13, 1, 0]);
  const tripleStart = 12n + 256n + 256n * 256n;
  assert.deepEqual(ext2BlockToPath(tripleStart, 1024).offsets, [14, 0, 0, 0]);
  assert.equal(ext2BlockToPath(tripleStart, 1024).outOfRange, false);
  assert.equal(ext2BlockToPath(tripleStart + BigInt(256 ** 3), 1024).outOfRange, true);
  // 4096 字节块 → 每块 1024 个指针
  assert.deepEqual(ext2BlockToPath(12n, 4096).offsets, [12, 0]);
  assert.deepEqual(ext2BlockToPath(12n + 1024n, 4096).offsets, [13, 0, 0]);
});

test('ext2：文件偏移到 LBA 要走过单/双/三间接块', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 256 });
  writeInode(image, 1, {
    mode: 0o100644,
    sizeLow: 1024 * 20,
    blocks: 8,
    links: 1,
    block: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 30, 40],
  });
  // 单间接：块 20 的第 0 项 → 21
  writePointer(image, 20, 0, 21);
  // 双间接：块 30[0] = 31（一层间接），31[1] = 33
  writePointer(image, 30, 0, 31);
  writePointer(image, 31, 1, 33);
  // 三间接：40[0] = 41, 41[0] = 42, 42[0] = 43
  writePointer(image, 40, 0, 41);
  writePointer(image, 41, 0, 42);
  writePointer(image, 42, 0, 43);

  const { source, sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(source, sb, groupTable, 1n, { checkAllocation: false });

  const direct = await mapExt2FileOffset(source, sb, inode, 3n * 1024n);
  assert.equal(direct.block, 10n);
  assert.equal(direct.pathName, 'direct');
  assert.deepEqual(direct.offsets, [3]);
  assert.deepEqual(direct.indirectBlocks, []);
  assert.equal(direct.lba, 10n * 2n, '1024 字节块 = 2 个 512 扇区');
  assert.equal(direct.pointerByteOffset, inode.location.byteOffset + 0x28n + 3n * 4n);

  const single = await mapExt2FileOffset(source, sb, inode, 12n * 1024n);
  assert.equal(single.block, 21n);
  assert.equal(single.pathName, 'indirect');
  assert.deepEqual(single.indirectBlocks, [20n]);
  assert.equal(single.pointerByteOffset, 20n * 1024n);

  const double = await mapExt2FileOffset(source, sb, inode, (268n + 1n) * 1024n);
  assert.equal(double.block, 33n);
  assert.equal(double.pathName, 'double-indirect');
  assert.deepEqual(double.indirectBlocks, [30n, 31n]);
  assert.deepEqual(double.offsets, [13, 0, 1]);

  const tripleStart = 12n + 256n + 256n * 256n;
  const triple = await mapExt2FileOffset(source, sb, inode, tripleStart * 1024n);
  assert.equal(triple.block, 43n);
  assert.equal(triple.pathName, 'triple-indirect');
  assert.deepEqual(triple.indirectBlocks, [40n, 41n, 42n]);
});

test('ext2：洞分两种（数据块没分配 / 中间间接块不存在）', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 256 });
  writeInode(image, 1, { mode: 0o100644, sizeLow: 1024 * 300, links: 1, block: [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  const { source, sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(source, sb, groupTable, 1n, { checkAllocation: false });
  const dataHole = await mapExt2FileOffset(source, sb, inode, 1n * 1024n);
  assert.equal(dataHole.hole, true);
  assert.equal(dataHole.holeKind, 'data');
  assert.equal(dataHole.lba, null);
  assert.ok(dataHole.notes.some((note) => note.includes('洞')));
  const indirectHole = await mapExt2FileOffset(source, sb, inode, 20n * 1024n);
  assert.equal(indirectHole.hole, true);
  assert.equal(indirectHole.holeKind, 'indirect');
});

test('ext2：块号越界时报告错误', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 96 });
  writeInode(image, 1, { mode: 0o100644, sizeLow: 1024, links: 1, block: [1000] });
  const { source, sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(source, sb, groupTable, 1n, { checkAllocation: false });
  const mapped = await mapExt2FileOffset(source, sb, inode, 0n);
  assert.equal(mapped.block, 1000n);
  assert.equal(mapped.blockValid, false);
  assert.ok(mapped.notes.some((note) => note.includes('越界')));
});

test('ext2：块区间表把连续分配合成段，并列出用到的间接块', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 512 });
  // 12 个直接块都指向 100..111（连续），间接块 20 的第 0..1 项指向 200、201
  const direct = Array.from({ length: 12 }, (_, index) => 100 + index);
  writeInode(image, 1, {
    mode: 0o100644,
    sizeLow: 1024 * 14,
    blocks: 8,
    links: 1,
    block: [...direct, 20, 0, 0],
  });
  writePointer(image, 20, 0, 200);
  writePointer(image, 20, 1, 201);
  const { source, sb, groupTable } = await openImage(image);
  const inode = await readExt2Inode(source, sb, groupTable, 1n, { checkAllocation: false });
  const map = await readExt2BlockMap(source, sb, inode);
  assert.equal(map.fileBlocks, 14);
  assert.equal(map.scannedBlocks, 14);
  assert.deepEqual(map.extents.map((extent) => `${extent.startBlock}+${extent.blockCount}=>${extent.physicalStart}`), [
    '0+12=>100',
    '12+2=>200',
  ]);
  assert.deepEqual(map.indirectBlocks, [20n]);
  assert.equal(map.holes.length, 0);
});

test('ext2：解块映射时同一个间接块只读一次', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 512 });
  // 前 12 个逻辑块没分配（洞），第 13..20 这 8 个逻辑块都靠同一个单间接块 20 上的指针。
  // 这些逻辑块共享间接块缓存，块 20 只读取一次。
  writeInode(image, 1, {
    mode: 0o100644,
    sizeLow: 1024 * 20,
    blocks: 8,
    links: 1,
    block: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0],
  });
  for (let slot = 0; slot < 8; slot += 1) writePointer(image, 20, slot, 300 + slot);
  const source = new BufferDiskSource({ bytes: image.bytes });
  const sb = await readExt2Superblock(source);
  const groupTable = await readExt2GroupDescriptors(source, sb);
  const inode = await readExt2Inode(source, sb, groupTable, 1n, { checkAllocation: false });
  const map = await readExt2BlockMap(source, sb, inode);
  assert.deepEqual(
    map.extents.map((extent) => `${extent.startBlock}+${extent.blockCount}=>${extent.physicalStart}`),
    ['0+12=>null', '12+8=>300'],
  );
  assert.deepEqual(map.holes, [{ startBlock: 0n, blockCount: 12 }]);
  assert.deepEqual(map.indirectBlocks, [20n]);
  const indirectReads = source.reads.filter((entry) => entry.byteOffset === 20n * 1024n);
  assert.equal(indirectReads.length, 1, `间接块 20 被读了 ${indirectReads.length} 次`);
});

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

test('ext2：mode 文本、类型映射与 dir 项长度公式', () => {
  assert.equal(formatExt2Mode(0o100644), '-rw-r--r--');
  assert.equal(formatExt2Mode(0o040755), 'drwxr-xr-x');
  assert.equal(formatExt2Mode(0o120777), 'lrwxrwxrwx');
  assert.equal(formatExt2Mode(0o104755), '-rwsr-xr-x');
  assert.equal(formatExt2Mode(0o041777), 'drwxrwxrwt');
  assert.equal(modeToFileType(0o100644), 1);
  assert.equal(modeToFileType(0o040755), 2);
  assert.equal(modeToFileType(0o120777), 7);
  assert.equal(ext2RecLen(1), 12);
  assert.equal(ext2RecLen(2), 12);
  assert.equal(ext2RecLen(10), 20);
  assert.equal(ext2RecLen(11), 20);
  assert.equal(ext2RecLen(12), 20);
  assert.equal(ext2RecLen(13), 24);
  assert.equal(EXT2_ROOT_INO, 2n);
});

test('ext2：按目标结构读取所需块，读取量受限', async () => {
  const image = buildImage({ blockSize: 1024, blocksCount: 4096 });
  writeInode(image, 1, { mode: 0o100644, sizeLow: 1024, links: 1, block: [3000] });
  const { source, sb, groupTable } = await openImage(image);
  const before = source.reads.length;
  const inode = await readExt2Inode(source, sb, groupTable, 1n, { checkAllocation: false });
  await mapExt2FileOffset(source, sb, inode, 0n);
  const after = source.reads.slice(before);
  assert.ok(after.length <= 4, `只该读 inode、inode 表，实际读了 ${after.length} 次`);
  const bytesRead = after.reduce((sum, entry) => sum + entry.length, 0);
  assert.ok(bytesRead < image.bytes.length / 10, '这次解析读掉的字节应当远小于整张盘');
});
