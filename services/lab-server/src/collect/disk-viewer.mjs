/**
 * 盘面视图（T08 FilePanel/DiskPanel 的数据底座）。
 *
 * 复用 T07e 的 ext2 解析器，字节来自 `DiskVersionStore.read()`——也就是
 * 「基线镜像 + 已对客体可见的写载荷」，由该逻辑版本读取器提供字节。这样：
 * - 版本号与帧里的 `diskVersions` 可以对上；
 * - pending 写不会混进盘面；
 * - 活跃镜像不会被绕过锁读取。
 *
 * 读取器按 4 KiB 缓存：ext2 一次路径查找会反复读组描述符/inode 表/目录块，
 * 每个逻辑块都走一次 QEMU 观测通道会让面板变得不可用。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  EXT2_ROOT_INO,
  assertExt2Parseable,
  lookupExt2Path,
  readExt2BlockMap,
  readExt2Directory,
  readExt2GroupDescriptors,
  readExt2Inode,
  readExt2Superblock,
} from '../../../../packages/linux-decoder/disk/index.ts';

const SECTOR = 512;
const CACHE_BYTES = 8 * 1024 * 1024;

export class DiskByteReader {
  constructor({ store, basePath, versionId = null }) {
    this.store = store;
    this.basePath = basePath;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.reads = 0;
    this.versionId = versionId;
    this.requestedVersionId = versionId;
    this.diskId = store.diskId;
    this.byteLength = BigInt(fs.existsSync(basePath) ? fs.statSync(basePath).size : 0);
    this.notes = [];
  }

  async #sector(lba) {
    const key = String(lba);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const result = await this.store.read({
      lba: BigInt(lba),
      count: 1,
      versionId: this.requestedVersionId,
    });
    const bytes = Buffer.from(result.bytes, 'base64');
    this.versionId = result.versionId ?? this.versionId;
    this.reads += 1;
    if (this.cacheBytes + bytes.length <= CACHE_BYTES) {
      this.cache.set(key, bytes);
      this.cacheBytes += bytes.length;
    }
    return bytes;
  }

  async read(byteOffset, length) {
    const start = BigInt(byteOffset);
    const end = start + BigInt(length);
    const first = Number(start / BigInt(SECTOR));
    const last = Number((end + BigInt(SECTOR) - 1n) / BigInt(SECTOR)) - 1;
    const chunks = [];
    for (let lba = first; lba <= last; lba += 1) chunks.push(await this.#sector(lba));
    const joined = Buffer.concat(chunks);
    const inFirst = Number(start - BigInt(first) * BigInt(SECTOR));
    return new Uint8Array(joined.subarray(inFirst, inFirst + length));
  }

  /** 给 ext2 解析器用的只读来源。 */
  source() {
    const reader = this;
    return {
      diskId: this.diskId,
      get versionId() {
        return reader.versionId;
      },
      byteLength: this.byteLength,
      read: (byteOffset, length) => this.read(byteOffset, length),
    };
  }
}

export class DiskViewer {
  constructor({ store }) {
    this.store = store;
    this.basePath = store.basePath;
    this.last = null;
  }

  async open(versionId = null) {
    if (!this.basePath || !fs.existsSync(this.basePath)) {
      throw new Error(`没有基线镜像：${this.basePath ?? '(未配置)'}`);
    }
    const bytes = new DiskByteReader({
      store: this.store,
      basePath: this.basePath,
      versionId,
    });
    const source = bytes.source();
    const superblock = await readExt2Superblock(source);
    assertExt2Parseable(superblock);
    const groupTable = await readExt2GroupDescriptors(source, superblock);
    this.last = { bytes, source, superblock, groupTable, versionId: bytes.versionId };
    return this.last;
  }

  async ensure(versionId = null) {
    // 请求的版本是当前可见版本时用缓存；历史版本也要按版本做 key，不能拿
    // “当前版本”的缓存冒充历史帧的盘面。
    const current = this.store.version({ createdAt: null })?.versionId ?? null;
    const target = versionId ?? current;
    if (this.last !== null && this.last.versionId === target && this.last.requestedVersion === target) return this.last;
    const opened = await this.open(target);
    opened.requestedVersion = target;
    return opened;
  }

  async tree({ path: wanted = '/', depth = 1, maxEntries = 64, versionId = null } = {}) {
    const opened = await this.ensure(versionId);
    const { source, superblock, groupTable } = opened;
    const resolved = await lookupExt2Path(source, superblock, groupTable, wanted, { maxBlocks: 256 });
    const result = {
      schema: 'oslab.filesystem/1',
      requestedPath: wanted,
      resolved: resolved.resolved,
      missing: resolved.missing,
      path: resolved.path,
      inode: await describeInode(source, superblock, groupTable, resolved.inode),
      versionId: opened.bytes.versionId,
      requestedVersionId: versionId,
      historical: versionId !== null && versionId !== this.store.version({ createdAt: null })?.versionId,
      baseSha256: this.store.baseSha256,
      diskId: this.store.diskId,
      superblock: {
        blockSize: superblock.blockSize,
        blocksCount: Number(superblock.blocksCount),
        inodesCount: Number(superblock.inodesCount),
        inodeSize: superblock.inodeSize,
        volumeName: superblock.volumeName,
        featureIncompat: `0x${(superblock.featureIncompat >>> 0).toString(16)}`,
      },
      entries: [],
      notes: [...resolved.notes],
      diskReads: opened.bytes.reads,
      evidence: resolved.evidence,
    };
    if (!resolved.resolved || !resolved.inode.isDirectory || depth <= 0) return result;
    const directory = await readExt2Directory(source, superblock, groupTable, resolved.inode, {
      maxBlocks: 256,
    });
    result.notes.push(...directory.notes);
    const entries = directory.entries.filter((entry) => !entry.free && entry.name !== '.' && entry.name !== '..');
    for (const entry of entries.slice(0, maxEntries)) {
      let inode = null;
      try {
        const facts = await readExt2Inode(source, superblock, groupTable, entry.inode);
        inode = await describeInode(source, superblock, groupTable, facts, { withBlocks: false });
      } catch (error) {
        inode = { ino: entry.inode.toString(), error: error.message };
      }
      result.entries.push({
        name: entry.name,
        ino: entry.inode.toString(),
        fileType: entry.fileTypeName,
        byteOffset: entry.byteOffset.toString(),
        inode,
      });
    }
    if (depth > 1) {
      for (const entry of result.entries) {
        if (entry.fileType !== 'EXT2_FT_DIR') continue;
        try {
          result.entries.push({
            childOf: entry.name,
            ...(await this.tree({
              path: path.posix.join(wanted === '/' ? '' : wanted, entry.name),
              depth: depth - 1,
              maxEntries: Math.min(maxEntries, 24),
              versionId,
            })),
          });
        } catch (error) {
          result.notes.push(`展开 ${entry.name} 失败：${error.message}`);
        }
      }
    }
    return result;
  }
}

async function describeInode(source, superblock, groupTable, inode, { withBlocks = true } = {}) {
  const base = {
    ino: inode.ino.toString(),
    mode: `0o${(inode.mode & 0o7777).toString(8)}`,
    modeText: inode.modeText,
    fileType: inode.fileTypeName,
    size: inode.size.toString(),
    links: inode.linksCount ?? null,
    blocks: inode.blocks === undefined ? null : String(inode.blocks),
    flags: inode.flags,
    mtime: inode.mtime === undefined ? null : String(inode.mtime),
    location: {
      group: inode.location.groupIndex.toString(),
      index: inode.location.indexInGroup.toString(),
      byteOffset: inode.location.byteOffset.toString(),
    },
  };
  if (withBlocks && inode.size > 0n) {
    try {
      const map = await readExt2BlockMap(source, superblock, inode, { maxBlocks: 128 });
      return {
        ...base,
        extents: map.extents.map((extent) => ({
          startBlock: extent.startBlock.toString(),
          blockCount: extent.blockCount,
          physicalStart: extent.physicalStart === null ? null : extent.physicalStart.toString(),
          hole: extent.hole,
          pathName: extent.pathName,
        })),
        indirectBlocks: map.indirectBlocks.map((block) => block.toString()),
        truncated: map.truncated,
        notes: map.notes,
      };
    } catch (error) {
      return { ...base, blockMapError: error.message };
    }
  }
  return base;
}

export { EXT2_ROOT_INO };
