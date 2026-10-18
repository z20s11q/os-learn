#!/usr/bin/env node
/**
 * T07e 验收：ext2 盘面（超级块 / 块组 / inode / 目录项 / 块映射 / 文件偏移 → LBA）。
 *
 *   node scripts/verify-t07e.mjs     （离线部分几秒；活体部分真启动一台 Linux，10–20 分钟）
 *
 * 这一节的问题是：**盘面解析错了照样能读出一份看起来很正常的答案**。
 *
 * - 超级块不在盘头，而是在**固定字节偏移 1024**；块大小不是常量，是 `1024 << s_log_block_size`；
 *   块组描述符表的位置要看 `s_first_data_block`（1024 字节块时从第 2 块起、4096 字节块时从第 1 块起）。
 *   任何一处取错，读出来的还是"一张 ext2 盘"，只是字段全错位。
 * - inode 不在"inode 号 × inode 大小"处，而是要先按 `inodes_per_group` 换算块组，
 *   再换算到那个组的 inode 表里的块与块内偏移（`ext2_get_inode()`）。
 * - 目录项的 rec_len 是**步进量**：五条校验少一条、或把 `& ~(chunk_size-1)` 看成低位掩码，
 *   要么把垃圾字节读成名字，要么一条目录项都读不出来（后者至少响声大，前者才是安静的错）。
 * - 普通文件大小有两个字（`i_size` 与 `i_dir_acl` 里的高位），只读低 32 位时 5 GiB 会显示成 1 GiB 出头。
 * - 文件偏移到块要走一棵指针树（12 直接 + 单/双/三间接），前 12 个块对、之后全错。
 *
 * 所以每一条结论都要靠**另一套独立机制**读同一份事实。本脚本用了八条互不相干的通道：
 *
 *   1. **我们的解析器**（`packages/linux-decoder/disk/ext2.ts` + `ext2-tree.ts`）：读
 *      **关闭后的** `artifacts/rootfs.img` 原始字节（`BufferDiskSource`），不是会话里的覆盖层。
 *   2. **e2fsprogs 独立工具**：`dumpe2fs -h`（超级块）、`dumpe2fs`（块组段）、
 *      `debugfs`（`stat`/`imap`/`bmap`/`ls -l`）、`e2fsck -fn`（整盘一致性）。
 *      这些工具与我们没有一行共享代码，判据也不是我们写的。
 *   3. **原始字节通道**：用 `dd` 按**绝对字节偏移**切出字节，再用脚本里另写的一份最小字段
 *      解码器读字段（不复用我们的解析器、也不复用 e2fsprogs）。它专门验"我们算的那个字节偏移
 *      到底是不是那个字段所在的位置"。
 *   4. **内核源码现场重解析**：`include/uapi/linux/magic.h`、`fs/ext2/ext2.h`、
 *      `fs/ext2/dir.c`（`ext2_check_folio` 的六条出口与原文错误串）、`fs/ext2/inode.c`
 *      （`ext2_get_inode` 的换算、`ext2_block_to_path` 的四段）、`include/linux/ext2_fs.h`、
 *      `include/uapi/linux/fs.h`（`FS_INDEX_FL`）、`include/linux/fs_types.h`（`FT_*`）。
 *      宏、结构字段顺序、枚举取值一律现读现算，不抄一份常量进脚本。
 *   5. **DWARF 布局产物**（`artifacts/layout/*.json`，T07a 生成的）：`ext2_super_block`、
 *      `ext2_inode`、`ext2_group_desc`、`ext2_dir_entry_2`、`ext2_inode_info` 的
 *      **字段名/偏移/宽度**。我们那份手写的偏移表要逐项与它对齐（名字映射写在脚本里）。
 *   6. **生成盘面的脚本**（`scripts/build-rootfs.sh`）：盘上那两个文件的内容是它写进去的，
 *      脚本按**同一公式独立重算**一遍期望字节，再与盘上真实字节逐字节比。期望值不是从盘上抄的。
 *   7. **活体会话的服务磁盘接口**（`GET /api/sessions/:id/disk`）：帧绑定的逻辑版本视图。
 *      它自己就把两个来源分得很开 —— `evidence.source` 是 `baseline-image`（基座镜像）
 *      还是 `virtio-write-payload`（本代采到的写载荷）。这一条要验的正是"**缓存/版本与盘面
 *      是两个来源**"：同一段 LBA，版本视图给出的字节与关闭镜像同一位置的字节一致；
 *      不一致时说的必须是不一致，不能悄悄拿基线冒充版本。
 *   8. **内存侧的 VFS inode**（T07d 那条链）：停在 `lab-read` 的 `ext2_file_read_iter` 上，
 *      从 `current → files → fd 3 → file → dentry → inode → super_block` 走出来，
 *      把**内存里那份 inode**（内核当年从盘上读上来、驻留在内存里的副本）与**盘面上那份 inode**
 *      逐字段比。再从 `struct ext2_inode_info` 里 `vfs_inode` 的位置**往回推**出 `i_data[15]`
 *      （ext2 私有的块指针数组），与盘面 `i_block[15]` 比 —— 这一条是"缓存与盘面两个来源"
 *      最直接的样子：内存里 15 个指针，盘上 15 个指针，必须一样，但它们是两份字节。
 *
 * 检查项（离线 A 段 / 活体 B 段）：
 *   A0  镜像就是关闭状态的那份：大小 96 MiB、`e2fsck -fn` 干净、我们没写过它（mtime 早于本轮）
 *   A1  超级块三方一致（我们 vs `dumpe2fs -h` vs `dd` 原始字节独立解码）：magic/块大小/inode 大小/
 *      首数据块/块数/inode 数/每组数/首次 inode/版本/特性/保留 GDT 块数
 *   A2  块组描述符三方一致（我们 vs `dumpe2fs` 的 Group 段 vs `debugfs stats`）：位图与 inode 表位置、
 *      空闲计数、目录数；保留 GDT 块数用「GDT 之后到第一个元数据块」的定义独立算一遍
 *   A3  我们的 ext2 偏移表与 **DWARF** 逐项一致（四个盘面结构 + `ext2_inode_info`），且结构宽度与
 *      `EXT2_SB_SIZE`/`EXT2_GOOD_OLD_INODE_SIZE`/`EXT2_GROUP_DESC_SIZE` 一致
 *   A4  我们的常量与内核源码现场重解析一致（magic/GOOD_OLD 系列/NDIR_BLOCKS/ADDR_PER_BLOCK/
 *      NAME_LEN/DIR_PAD/DIR_REC_LEN 宏语义/FS_INDEX_FL/FT_* 取值表）
 *   A5  inode 定位：`debugfs imap` 报的 (块组, 块, 块内偏移) 与我们的 `ext2InodeLocation` 一致；
 *      `dd` 在那个绝对字节偏移处切出的 128 字节，用独立解码器读出的字段与我们的 inode facts 一致
 *   A6  inode 字段：mode/uid/gid/size/links/blocks/块指针 与我们、`debugfs stat`、`dd` 三方一致
 *   A7  目录项：`/` 与 `/data` 的目录项集合（名字 + inode 号）与 `debugfs ls -l` 一一对应，
 *      真盘上 0 fault、`reachedEnd` 为真、空闲槽的字节数算得对
 *   A8  路径查找逐段落到与 `debugfs imap` 相同的 inode 上，且每一段的目录项字节偏移能用 `dd` 验出名字
 *   A9  块映射：`hello.txt` 与 `probe.bin` 的若干文件偏移 → 盘面块 → LBA 与 `debugfs bmap` 一致
 *   A10 内容：盘上块里的字节与 `build-rootfs.sh` 的公式独立重算的期望字节逐字节一致
 *   A11 契约与证据：盘面 facts 的证据 `source` 是 `disk`、字节偏移落在镜像内、LBA 换算自洽（×512）
 *   A12 边界与错误码：bad-magic / incompat-feature-unsupported / bad-inode / inode-out-of-range /
 *      not-a-directory / negative-offset；目录项六条出口用**镜像副本**造坏块逐条触发
 *   B0  会话启动到交互提示符（活体通道的前提）
 *   B1  服务磁盘视图：`diskId`/基线 sha256 与本地重算的 `rootfs.img` 散列一致；两个来源的名字如实
 *   B2  同一段 LBA：服务的版本视图字节 vs 关闭镜像的同一偏移字节，逐字节一致；`fromBase` 如实
 *   B3  客体自报：`stat -c`、`ls -i`、`dd if=/dev/vda`（客体自己从块设备读）与我们解析的结果一致
 *   B4  内存侧 inode（T07d 链路）与盘面 inode 逐字段一致；`ext2_inode_info.i_data[0]` 与盘面 `i_block[0]`
 *      一致 —— 缓存与盘面两个来源同源同值
 *   B5  会话关闭后无残留 QEMU/GDB 进程；离线校验接口在 VM 运行时明确拒绝
 *
 * 结果写入 `artifacts/verify/t07e.json` 与 `artifacts/verify/t07e.log`。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../services/lab-server/main.mjs';
import {
  BufferDiskSource,
  EXT2_DIR_ENTRY_FIELDS,
  EXT2_FT_TYPES,
  EXT2_GD_FIELDS,
  EXT2_GOOD_OLD_INODE_SIZE,
  EXT2_GROUP_DESC_SIZE,
  EXT2_INDEX_FL,
  EXT2_INCOMPAT_SUPP,
  EXT2_INODE_FIELDS,
  EXT2_INODE_FLAGS,
  EXT2_NAME_LEN,
  EXT2_N_BLOCKS,
  EXT2_NDIR_BLOCKS,
  EXT2_ROOT_INO,
  EXT2_RO_COMPAT_SUPP,
  EXT2_SB_FIELDS,
  EXT2_SB_SIZE,
  EXT2_SUPERBLOCK_OFFSET,
  EXT2_SUPER_MAGIC,
  Ext2ParseError,
  KernelLayout,
  KernelMemoryView,
  SECTOR_SIZE,
  assertExt2Parseable,
  byteOffsetForBlock,
  ext2AddrPerBlock,
  ext2BlockToPath,
  ext2FileOffsetToLba,
  ext2InodeLocation,
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
  readDentry,
  readFile,
  readFileChain,
  readFiles,
  readInode,
  readSuperBlock,
  readTask,
} from '../packages/linux-decoder/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IMAGE = path.join(ROOT, 'artifacts/rootfs.img');
const VMLINUX = path.join(ROOT, 'artifacts/build/linux/vmlinux');
const LAYOUT_PATH = path.join(ROOT, 'artifacts/layout/linux-6.12.112-observatory-f5e5edc1c572.json');
const BUILD_ROOTFS = path.join(ROOT, 'scripts/build-rootfs.sh');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t07e.json');
const EVIDENCE_LOG = path.join(ROOT, 'artifacts/verify/t07e.log');

/** 现场重解析的内核源码（全部只读；这些是判据本身，改了它们就等于改了"什么算对"）。 */
const SRC = path.join(ROOT, 'src/linux-6.12.112');
const EXT2_H = path.join(SRC, 'fs/ext2/ext2.h');
const EXT2_C = path.join(SRC, 'fs/ext2/inode.c');
const EXT2_DIR_C = path.join(SRC, 'fs/ext2/dir.c');
const EXT2_FS_H = path.join(SRC, 'include/linux/ext2_fs.h');
const MAGIC_H = path.join(SRC, 'include/uapi/linux/magic.h');
const UAPI_FS_H = path.join(SRC, 'include/uapi/linux/fs.h');
const FS_TYPES_H = path.join(SRC, 'include/linux/fs_types.h');
const FS_TYPES_C = path.join(SRC, 'fs/fs_types.c');

/** 盘上那两个文件。它们的**内容**由 `scripts/build-rootfs.sh` 决定，不从这里抄。 */
const HELLO_FILE = '/data/hello.txt';
const PROBE_FILE = '/data/probe.bin';
const PROBE_BLOCKS = 512;
/** `rootfs.img` 是 `truncate -s 96M` 出来的。 */
const IMAGE_BYTES = 96 * 1024 * 1024;

const PROMPT = /linux-lab:[^\r\n]*# /;

const results = [];
const logLines = [];

function log(line) {
  logLines.push(line);
  console.log(line);
}

function check(id, ok, detail) {
  results.push({ id, ok: ok === true, detail: detail ?? null });
  log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
  return ok === true;
}

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function hexOrNull(value) {
  return value === null || value === undefined ? null : hex(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 证据里混着 bigint（地址、块号、偏移），JSON 序列化前统一转十进制字符串。 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = jsonSafe(entry);
    return out;
  }
  return value;
}

/** 跨通道比较用：`0x…`/十进制/bigint/number 统一成 `bigint | null`。 */
function asBig(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
}

/** 把 `undefined`/`null` 折成同一个"读不到"，避免 `null !== undefined` 这种假不一致。 */
function sameNumber(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function sameBig(a, b) {
  const left = asBig(a);
  const right = asBig(b);
  if (left === null || right === null) return left === right;
  return left === right;
}

// ---------------------------------------------------------------------------
// 通道三用：shell 与原始字节
// ---------------------------------------------------------------------------

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 跑一条 shell 命令并取回 stdout（stderr 由调用方自己决定要不要并进来）。
 *
 * 用 shell 而不是 `execFileSync(name, args)`：e2fsprogs 的几支会往 stderr 打自己的
 * banner（`debugfs 1.45.6 …`），把两支流合起来解析省掉一次"到底是没输出还是打到了 stderr"。
 */
function sh(command, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  try {
    const text = execFileSync('bash', ['-c', command], { encoding: 'utf8', maxBuffer });
    return { ok: true, code: 0, text };
  } catch (error) {
    return {
      ok: false,
      code: typeof error.status === 'number' ? error.status : null,
      text: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      error: error.message,
    };
  }
}

/**
 * `dd` 切出的原始字节（`count` 以字节计，用 `bs=1`）。
 *
 * 刻意不用我们的 `BufferDiskSource`：这一段要验的正是"我们算出来的那个**绝对字节偏移**
 * 是不是那个字段所在的位置"，所以字节必须由另一支程序按偏移取。
 */
function ddBytes(byteOffset, length, image = IMAGE) {
  const out = execFileSync(
    'dd',
    [`if=${image}`, 'bs=1', `skip=${byteOffset}`, `count=${length}`, 'status=none'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return Buffer.from(out);
}

/** 独立的最小字段解码器（小端）。与我们的 `readU16`/`readU32` 是两份互不相干的实现。 */
function leU16(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function leU32(bytes, offset) {
  return ((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0);
}

function leBytesToBigInt(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

function resolveNested(table, name) {
  const entry = table[name];
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'number') return { offset: entry, width: null };
  return { offset: entry.offset ?? null, width: entry.width ?? null };
}

// ---------------------------------------------------------------------------
// 通道二：e2fsprogs 输出的解析
// ---------------------------------------------------------------------------

/** `dumpe2fs -h` 的 `键: 值` 表。 */
function parseDumpe2fsHead(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const match = /^([A-Za-z][^:]*?):\s*(.*)$/.exec(raw);
    if (match === null) continue;
    out.set(match[1].trim(), match[2].trim());
  }
  return out;
}

/** 从 `dumpe2fs -h` 的表里取一个数值字段（`128` / `0xEF53` / `1 (dynamic)` 都吃）。 */
function dumpe2fsNumber(table, key) {
  const value = table.get(key);
  if (value === undefined) return null;
  // 先看十六进制：`dumpe2fs -h` 的魔数是 `0xEF53`，如果先跑十进制那条正则，
  // 它会匹配到开头那个 `0` 然后返回 0 —— 看上去"读到了一个数"，其实是错的。
  const hexMatch = /^0[xX]([0-9a-fA-F]+)/.exec(value);
  if (hexMatch !== null) return Number.parseInt(hexMatch[1], 16);
  const dec = /^-?\d+/.exec(value);
  if (dec !== null) return Number(dec[0]);
  return null;
}

/** `dumpe2fs`（不带 `-h`）的 `Group N:` 段。 */
function parseDumpe2fsGroups(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const head = /^Group (\d+): \(Blocks (\d+)-(\d+)\)\s*$/.exec(raw);
    if (head !== null) {
      current = { index: Number(head[1]), firstBlock: BigInt(head[2]), lastBlock: BigInt(head[3]) };
      groups.push(current);
      continue;
    }
    if (current === null) continue;
    const primary = /^\s*Primary superblock at (\d+), Group descriptors at (\d+)-(\d+)\s*$/.exec(raw);
    if (primary !== null) {
      current.primarySuperBlock = BigInt(primary[1]);
      current.descFrom = BigInt(primary[2]);
      current.descTo = BigInt(primary[3]);
      continue;
    }
    const reserved = /^\s*Reserved GDT blocks at (\d+)-(\d+)\s*$/.exec(raw);
    if (reserved !== null) {
      current.reservedGdtFrom = BigInt(reserved[1]);
      current.reservedGdtTo = BigInt(reserved[2]);
      continue;
    }
    const blockBitmap = /^\s*Block bitmap at (\d+) \(\+\d+\)\s*$/.exec(raw);
    if (blockBitmap !== null) { current.blockBitmap = BigInt(blockBitmap[1]); continue; }
    const inodeBitmap = /^\s*Inode bitmap at (\d+) \(\+\d+\)\s*$/.exec(raw);
    if (inodeBitmap !== null) { current.inodeBitmap = BigInt(inodeBitmap[1]); continue; }
    const inodeTable = /^\s*Inode table at (\d+)-(\d+) \(\+\d+\)\s*$/.exec(raw);
    if (inodeTable !== null) {
      current.inodeTable = BigInt(inodeTable[1]);
      current.inodeTableTo = BigInt(inodeTable[2]);
      continue;
    }
    const counts = /^\s*(\d+) free blocks, (\d+) free inodes, (\d+) directories\s*$/.exec(raw);
    if (counts !== null) {
      current.freeBlocks = Number(counts[1]);
      current.freeInodes = Number(counts[2]);
      current.directories = Number(counts[3]);
      continue;
    }
  }
  return groups;
}

/**
 * `debugfs -R "stat <N>"` 头一行的 `Type:` 词 → mode 里的类型位。
 *
 * 为什么要单独有这张表：`debugfs stat` 打的是 `Type: directory    Mode:  0755` —— 它把
 * 类型和权限拆成两栏，`Mode:` 里**只有权限位**。直接把那一栏当 mode 读，会得到 0o755
 * 而不是 0o40755，看上去"读到了个数"，其实丢了类型位。
 */
const DEBUGFS_TYPE_BITS = new Map([
  ['regular', 0o100000],
  ['directory', 0o040000],
  ['character special', 0o020000],
  ['block special', 0o060000],
  ['fifo', 0o010000],
  ['socket', 0o140000],
  ['symlink', 0o120000],
]);

/** `debugfs -R "stat <N>"`。 */
function parseDebugfsStat(text) {
  const head = /^Inode:\s*(\d+)\s+Type:\s*(.+?)\s+Mode:\s*0?(\d+)\s+Flags:\s*0x([0-9a-fA-F]+)/m.exec(text);
  const owner = /^User:\s*(\d+)\s+Group:\s*(\d+)\s+Size:\s*(\d+)/m.exec(text);
  const links = /^Links:\s*(\d+)\s+Blockcount:\s*(\d+)/m.exec(text);
  const total = /^TOTAL:\s*(\d+)/m.exec(text);
  if (head === null) return null;
  const typeWord = head[2].trim();
  const permissions = Number.parseInt(head[3], 8);
  const typeBits = DEBUGFS_TYPE_BITS.get(typeWord) ?? null;
  return {
    inode: Number(head[1]),
    type: typeWord,
    typeBits,
    permissions,
    // 类型位来自 `Type:` 栏、权限位来自 `Mode:` 栏，合成后才是与 inode 里 `i_mode` 可比的数
    mode: typeBits === null ? null : (typeBits | permissions),
    flags: Number.parseInt(head[4], 16),
    uid: owner === null ? null : Number(owner[1]),
    gid: owner === null ? null : Number(owner[2]),
    size: owner === null ? null : Number(owner[3]),
    links: links === null ? null : Number(links[1]),
    blockCount: links === null ? null : Number(links[2]),
    total: total === null ? null : Number(total[1]),
    blocks: parseDebugfsBlocks(text),
    raw: text.trim().split('\n').slice(0, 14),
  };
}

/**
 * `debugfs stat` 的 `BLOCKS:` 段 → 「文件内逻辑块 → 盘面块」。
 *
 * 形如 `(0):1901`（单块）、`(0-11):1902-1913`（连续一段）、`(IND):1914`（间接块自身）。
 * 这里按"逻辑区间与物理区间等长"展开连续段，间接块那几项不进映射（它们是元数据，不是文件内容）。
 */
function parseDebugfsBlocks(text) {
  const section = /BLOCKS:\s*([\s\S]*?)\n\s*TOTAL:/.exec(text);
  if (section === null) return { map: new Map(), indirect: [] };
  const map = new Map();
  const indirect = [];
  for (const match of section[1].matchAll(/\(([^)]*)\):\s*([0-9A-Za-z\-]+)/g)) {
    const logical = match[1].trim();
    const physical = match[2].trim();
    if (!/^\d+(?:-\d+)?$/.test(logical)) { indirect.push(`${logical}:${physical}`); continue; }
    if (!/^\d+(?:-\d+)?$/.test(physical)) { indirect.push(`${logical}:${physical}`); continue; }
    const logicalParts = logical.split('-').map(Number);
    const physicalParts = physical.split('-').map(Number);
    const count = logicalParts.length === 1 ? 1 : logicalParts[1] - logicalParts[0] + 1;
    const physicalCount = physicalParts.length === 1 ? 1 : physicalParts[1] - physicalParts[0] + 1;
    if (count !== physicalCount) { indirect.push(`${logical}:${physical}（长度不等，不展开）`); continue; }
    for (let index = 0; index < count; index += 1) {
      map.set(logicalParts[0] + index, BigInt(physicalParts[0] + index));
    }
  }
  return { map, indirect };
}

/** `debugfs -R "imap <路径>"`。 */
function parseDebugfsImap(text) {
  const group = /^Inode (\d+) is part of block group (\d+)/m.exec(text);
  const located = /located at block (\d+), offset 0x([0-9a-fA-F]+)/m.exec(text);
  if (group === null || located === null) return null;
  return {
    inode: Number(group[1]),
    groupIndex: Number(group[2]),
    block: BigInt(located[1]),
    offsetInBlock: Number.parseInt(located[2], 16),
  };
}

/** `debugfs -R "ls -l <目录>"`：`inode mode (links) uid gid size 日期 时间 名字`。 */
function parseDebugfsLs(text) {
  const entries = [];
  for (const raw of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+\((\d+)\)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(raw);
    if (match === null) continue;
    entries.push({
      inode: BigInt(match[1]),
      mode: Number.parseInt(match[2], 8),
      links: Number(match[3]),
      uid: Number(match[4]),
      gid: Number(match[5]),
      size: Number(match[6]),
      name: match[9].trim(),
    });
  }
  return entries;
}

/** `debugfs -R "bmap <文件> <逻辑块>"`：输出就是一个块号（或空）。 */
function parseDebugfsBmap(text) {
  const match = /^\s*(\d+)\s*$/m.exec(String(text));
  return match === null ? null : BigInt(match[1]);
}

// ---------------------------------------------------------------------------
// 通道四：内核源码现场重解析
// ---------------------------------------------------------------------------

/** 从一份 C 文本里取 `#define NAME value`（找不到返回 `null`）。 */
function readDefine(text, name) {
  const match = new RegExp(`^\\s*#\\s*define\\s+${name}\\s+(.+?)\\s*(?:/\\*.*\\*/)?$`, 'm').exec(text);
  if (match === null) return null;
  return match[1].trim();
}

/** 把 `#define` 的右边取成整数（支持 `0x…`/十进制/简单的 `(1 << 5)` 形式）。 */
function evalDefineValue(text, name, depth = 0) {
  if (depth > 8) return null;
  const raw = readDefine(text, name);
  if (raw === null) return null;
  let expression = String(raw).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  // 宏的右边可以引用同一份头文件里别的宏，而且可能是好几层：
  // `EXT2_DIR_ROUND` 就是 `(EXT2_DIR_PAD - 1)`，`EXT2_N_BLOCKS` 是 `(EXT2_TIND_BLOCK + 1)`
  // 而 `EXT2_TIND_BLOCK` 又引用下一个。所以先把认识的名字逐个换成它们的值再算；
  // 不认识的名字（类型名、函数名）原样留着，会被下面那条白名单正则挡下来。
  for (const token of [...new Set(expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]) {
    const nested = evalDefineValue(text, token, depth + 1);
    if (nested === null) continue;
    expression = expression.replace(new RegExp(`\\b${token}\\b`, 'g'), `(${nested})`);
  }
  return evalIntExpression(expression);
}

/** 只认识十进制、十六进制、移位与括号 —— 够读 ext2.h 里的那几个宏，且不执行任意代码。 */
function evalIntExpression(raw) {
  let expression = String(raw).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (expression.endsWith(')') && /^\(.*\)$/.test(expression)) expression = expression;
  if (!/^[\dxa-fA-F\s()<>+*|\-]+$/.test(expression)) return null;
  const normalized = expression
    .replace(/\b0[xX]([0-9a-fA-F]+)\b/g, (_, digits) => String(Number.parseInt(digits, 16)))
    .replace(/\(/g, '(')
    .replace(/\)/g, ')');
  try {
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict";return (${normalized});`)();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 从一份 C 文本里取 `static inline ... name(...) { ... }` 或 `... name(...)\n{ ... }` 的函数体。 */
function readFunctionBody(text, name) {
  const head = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').exec(text);
  if (head === null) return null;
  const start = head.index + head[0].length;
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    }
    index += 1;
  }
  return text.slice(start, index - 1);
}

/** 从一份 C 文本里取一个 `struct NAME { ... };` 的字段区（顶层字段，不下钻嵌套）。 */
function readStructBody(text, name) {
  const head = new RegExp(`^\\s*struct\\s+${name}\\s*\\{`, 'm').exec(text);
  if (head === null) return null;
  const start = head.index + head[0].length;
  let depth = 1;
  let index = start;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  return text.slice(start, index - 1);
}

/**
 * 把 `struct NAME` 的**顶层**字段按出现顺序列成 `[{ name, width, typeName }]`。
 *
 * 这是给 `ext2_super_block`/`ext2_group_desc`/`ext2_dir_entry_2` 用的：它们都是平铺的，
 * 宽度由 C 类型直接给出。嵌套的联合（`ext2_inode.osd2`）在这里只登记为一项。
 */
const C_WIDTHS = new Map([
  ['__u8', 1], ['unsigned char', 1], ['char', 1],
  ['__u16', 2], ['unsigned short', 2], ['short', 2],
  ['__u32', 4], ['unsigned int', 4], ['int', 4], ['__le32', 4], ['__le16', 2], ['__be16', 2],
  ['__u64', 8], ['unsigned long', 8], ['long', 8], ['__le64', 8],
]);

function parseCStructFields(body) {
  const fields = [];
  const lines = String(body).split('\n');
  let pending = '';
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (line.length === 0) continue;
    pending += ` ${line}`;
    if (!pending.trim().endsWith(';')) continue;
    const statement = pending.trim().replace(/\s+/g, ' ');
    pending = '';
    const arrayMatch = /^(?<type>[A-Za-z_][\w\s]*?)\s+(?<name>[A-Za-z_]\w*)\s*\[\s*(?<count>\d+)\s*\]\s*;/.exec(statement);
    if (arrayMatch !== null) {
      fields.push({
        name: arrayMatch.groups.name,
        width: (C_WIDTHS.get(arrayMatch.groups.type.trim()) ?? null) === null
          ? null
          : (C_WIDTHS.get(arrayMatch.groups.type.trim()) ?? 0) * Number(arrayMatch.groups.count),
        typeName: arrayMatch.groups.type.trim(),
        arrayCount: Number(arrayMatch.groups.count),
      });
      continue;
    }
    const plainMatch = /^(?<type>[A-Za-z_][\w\s]*?)\s+(?<name>[A-Za-z_]\w*)\s*;/.exec(statement);
    if (plainMatch !== null) {
      const typeName = plainMatch.groups.type.trim();
      fields.push({
        name: plainMatch.groups.name,
        width: C_WIDTHS.get(typeName) ?? null,
        typeName,
        arrayCount: null,
      });
      continue;
    }
    const unionMatch = /^}\s*(?<name>[A-Za-z_]\w*)\s*;/.exec(statement);
    if (unionMatch !== null) {
      fields.push({ name: unionMatch.groups.name, width: null, typeName: '（嵌套联合/结构）', arrayCount: null });
    }
  }
  return fields;
}

/**
 * 从一份 C 文本里取"以 `} tag;` 结尾的那个聚合体"的函数体（`{` 与 `}` 之间）。
 *
 * 给 `ext2_inode` 里那两个**匿名联合**用：`osd1`/`osd2` 没有类型名，DWARF 产物按
 * 设计不下钻它们（只给联合的起点与宽度），所以要靠 `} linux2;` 这样的结尾标记
 * **往回**找它自己的 `{`，才能拿到里面的字段顺序。
 */
function readAggregateBodyBefore(text, tag) {
  const match = new RegExp(`\\}\\s*${tag}\\s*;`).exec(text);
  if (match === null) return null;
  let index = match.index - 1;
  let depth = 0;
  while (index >= 0) {
    const char = text[index];
    if (char === '}') depth += 1;
    else if (char === '{') {
      if (depth === 0) return text.slice(index + 1, match.index);
      depth -= 1;
    }
    index -= 1;
  }
  return null;
}

/** 从 `include/linux/fs_types.h` 取 `FT_*` 的取值（6.12 里它们是 `#define`，不是枚举）。 */
function parseFtDefineValues(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const match = /^\s*#\s*define\s+(FT_[A-Z_]+)\s+(\d+)\s*$/.exec(raw);
    if (match !== null) out.set(match[1], Number(match[2]));
  }
  return out;
}

/** `include/linux/fs_types.h` 里的 `DT_*`（dirent 类型，= `(mode & S_IFMT) >> 12`）。 */
function parseDtDefineValues(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const match = /^\s*#\s*define\s+(DT_[A-Z]+)\s+(\d+)\s*$/.exec(raw);
    if (match !== null) out.set(match[1], Number(match[2]));
  }
  return out;
}

/**
 * `fs/fs_types.c` 里那张 `fs_ftype_by_dtype[DT_MAX]`：`[DT_*] = FT_*`。
 *
 * 内核的 `fs_umode_to_ftype(mode)` 就是 `fs_ftype_by_dtype[S_DT(mode)]`，而
 * `S_DT(mode) = (mode & S_IFMT) >> 12`。所以这一张表加上 `DT_*` 的取值，就能
 * **现场重算**出"这个 mode 该写成哪个 file_type"，用来验我们的 `modeToFileType()`。
 * 没写出来的项按 C 语义是 0（= `FT_UNKNOWN`），这里照实留着不补。
 */
function parseFtypeByDtypeTable(text) {
  const body = /fs_ftype_by_dtype\[DT_MAX\]\s*=\s*\{([\s\S]*?)\};/.exec(text);
  if (body === null) return null;
  const table = new Map();
  for (const match of body[1].matchAll(/\[(DT_[A-Z]+)\]\s*=\s*(FT_[A-Z_]+)/g)) {
    table.set(match[1], match[2]);
  }
  return table;
}

/**
 * 从 `fs/ext2/dir.c` 的 `ext2_check_folio()` 里取出六条出口的**原文错误串**与出现顺序。
 *
 * 为什么必须现场读：这六串字在我们这边是"标签"（Eshort/Ealign/…），在内核那边是
 * `error = "…"` 赋值加一个 `goto bad_entry`。要是只在自己代码里写死一套标签，
 * 就永远发现不了"内核换了措辞"或者"我们少了一条判据"。
 */
function readCheckFolioExits(text) {
  const body = readFunctionBody(text, 'ext2_check_folio');
  if (body === null) return null;
  const labels = ['Eshort', 'Ealign', 'Enamelen', 'Espan', 'Einumber', 'Eend'];
  const allLabels = [...labels, 'Ebadsize'];
  const reasons = {};
  for (const label of allLabels) {
    const block = new RegExp(`\\n${label}:\\n([\\s\\S]*?)(?=\\n(?:${allLabels.join('|')}):\\n|\\nout:\\n|\\nfail:\\n|$)`)
      .exec(body);
    if (block === null) { reasons[label] = null; continue; }
    const literal = /error\s*=\s*"([^"]*)"/.exec(block[1]);
    if (literal !== null) { reasons[label] = literal[1]; continue; }
    const eend = /ext2_error\s*\(\s*sb\s*,\s*"ext2_check_folio"\s*,\s*\n\s*"([^"]*)"/.exec(block[1]);
    reasons[label] = eend === null ? null : eend[1];
  }
  // 六条判据在**校验顺序**里的出现次序（`goto X;` 的位置），要与我们的实现一致。
  const order = labels
    .map((label) => ({ label, at: body.indexOf(`goto ${label};`) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.label);
  return { body, reasons, order, hasZeroLengthNote: /zero-length directory entry/.test(text) };
}
// ---------------------------------------------------------------------------
// 通道五：DWARF 布局产物的字段对照
// ---------------------------------------------------------------------------

/**
 * 我们四张表里的 camelCase ←→ C 结构里的字段名。
 *
 * 名字映射必须**写在脚本里**、不能靠"把 camelCase 转成 snake_case"猜：`i_size` 与
 * `sizeLow`、`i_dir_acl` 与 `dirAcl` 这种转换猜不出来，猜错了还会**看起来对**
 * （两边都得到 null，判成"这个字段产物里没有"就跳过了）。
 */
const SB_FIELD_NAMES = {
  inodesCount: 's_inodes_count',
  blocksCount: 's_blocks_count',
  reservedBlocksCount: 's_r_blocks_count',
  freeBlocksCount: 's_free_blocks_count',
  freeInodesCount: 's_free_inodes_count',
  firstDataBlock: 's_first_data_block',
  logBlockSize: 's_log_block_size',
  logFragmentSize: 's_log_frag_size',
  blocksPerGroup: 's_blocks_per_group',
  fragmentsPerGroup: 's_frags_per_group',
  inodesPerGroup: 's_inodes_per_group',
  mountTime: 's_mtime',
  writeTime: 's_wtime',
  mountCount: 's_mnt_count',
  maxMountCount: 's_max_mnt_count',
  magic: 's_magic',
  state: 's_state',
  errors: 's_errors',
  minorRevLevel: 's_minor_rev_level',
  lastCheck: 's_lastcheck',
  checkInterval: 's_checkinterval',
  creatorOs: 's_creator_os',
  revLevel: 's_rev_level',
  defResuid: 's_def_resuid',
  defResgid: 's_def_resgid',
  firstIno: 's_first_ino',
  inodeSize: 's_inode_size',
  blockGroupNr: 's_block_group_nr',
  featureCompat: 's_feature_compat',
  featureIncompat: 's_feature_incompat',
  featureRoCompat: 's_feature_ro_compat',
  uuid: 's_uuid',
  volumeName: 's_volume_name',
  lastMounted: 's_last_mounted',
  hashSeed: 's_hash_seed',
  defHashVersion: 's_def_hash_version',
  defaultMountOpts: 's_default_mount_opts',
  firstMetaBg: 's_first_meta_bg',
};

const GD_FIELD_NAMES = {
  blockBitmap: 'bg_block_bitmap',
  inodeBitmap: 'bg_inode_bitmap',
  inodeTable: 'bg_inode_table',
  freeBlocksCount: 'bg_free_blocks_count',
  freeInodesCount: 'bg_free_inodes_count',
  usedDirsCount: 'bg_used_dirs_count',
  pad: 'bg_pad',
  reserved: 'bg_reserved',
};

const INODE_FIELD_NAMES = {
  mode: 'i_mode',
  uid: 'i_uid',
  size: 'i_size',
  atime: 'i_atime',
  ctime: 'i_ctime',
  mtime: 'i_mtime',
  dtime: 'i_dtime',
  gid: 'i_gid',
  linksCount: 'i_links_count',
  blocks: 'i_blocks',
  flags: 'i_flags',
  osd1: 'osd1',
  block: 'i_block',
  generation: 'i_generation',
  fileAcl: 'i_file_acl',
  dirAcl: 'i_dir_acl',
  faddr: 'i_faddr',
};

/**
 * `ext2_inode.osd2` 是个**匿名联合**，DWARF 产物按设计不下钻它（只给 `osd2@116/12`），
 * 所以这四个字段的位置要另算：联合的起点从 DWARF 拿，里面的排布从 C 源码里那层
 * `struct { … } linux2;` 现场解析（见 `compareInodeOsd2Fields`）。
 */
const INODE_OSD2_FIELDS = {
  frag: 'l_i_frag',
  fsize: 'l_i_fsize',
  uidHigh: 'l_i_uid_high',
  gidHigh: 'l_i_gid_high',
};

const DIR_ENTRY_FIELD_NAMES = {
  inode: 'inode',
  recLen: 'rec_len',
  nameLen: 'name_len',
  fileType: 'file_type',
  name: 'name',
};

/**
 * 把一张 `{ 我们的字段名: 字节偏移 }` 表逐项对着 DWARF 产物核一遍。
 *
 * 只比"我们表里有的那些字段"，不比结构宽度就完事：一个少写了一项的偏移表，
 * 只要后面每一项都跟着错，宽度照样是对的。
 */
function compareOffsetTable(label, layout, typeName, table, nameMap) {
  const checked = [];
  const mismatches = [];
  for (const [key, offset] of Object.entries(table)) {
    const cName = nameMap[key] ?? null;
    if (cName === null) {
      mismatches.push(`${key}：脚本里没有给出它对应的 C 名，没法核`);
      continue;
    }
    if (!layout.hasField(typeName, cName)) {
      mismatches.push(`${key}(${cName})：布局产物 ${typeName} 里没有这个字段`);
      continue;
    }
    const dwarf = layout.byteOffset(typeName, cName);
    if (dwarf !== offset) mismatches.push(`${key}(${cName})：我们 ${hex(offset)} vs DWARF ${hex(dwarf)}`);
    else checked.push(`${key}@${hex(offset)}`);
  }
  return { label, typeName, checked, mismatches };
}

/**
 * `ext2_inode` 的 `osd2` 里那四个字段：联合起点来自 DWARF，内部排布来自 C 源码。
 *
 * 这两个来源缺一不可：只看 DWARF 得到"联合在 116 处、宽 12 字节"，说不出
 * `l_i_uid_high` 在联合内第 4 字节；只看源码也定不出这个联合在结构里的起点。
 */
function compareInodeOsd2Fields(layout, ext2hText) {
  const osd2Base = layout.hasField('ext2_inode', 'osd2') ? layout.byteOffset('ext2_inode', 'osd2') : null;
  const body = readAggregateBodyBefore(ext2hText, 'linux2');
  if (osd2Base === null || body === null) {
    return {
      osd2Base, bodyFound: body !== null, checked: [], mismatches: ['读不到 osd2 的起点或 linux2 的字段区'],
    };
  }
  const inner = parseCStructFields(body);
  const checked = [];
  const mismatches = [];
  let cursor = 0;
  const absolute = new Map();
  for (const field of inner) {
    if (field.width === null) { mismatches.push(`linux2.${field.name}：宽度未知（${field.typeName}）`); continue; }
    absolute.set(field.name, osd2Base + cursor);
    cursor += field.width;
  }
  for (const [key, innerName] of Object.entries(INODE_OSD2_FIELDS)) {
    const expected = absolute.get(innerName);
    if (expected === undefined) { mismatches.push(`${key}(${innerName})：源码里没找到这个字段`); continue; }
    if (EXT2_INODE_FIELDS[key] !== expected) {
      mismatches.push(`${key}(${innerName})：我们 ${hex(EXT2_INODE_FIELDS[key])} vs 现场算 ${hex(expected)}`);
    } else {
      checked.push(`${key}(${innerName})@${hex(expected)}`);
    }
  }
  return { osd2Base, linux2Bytes: cursor, bodyFound: true, checked, mismatches };
}

/** `struct inode` 的宽度：`ext2_inode_info` 的 `vfs_inode` 是内嵌的，两者必须同宽。 */
function vfsInodeLayoutFacts(layout) {
  const info = layout.type('ext2_inode_info');
  const hasVfs = layout.hasField('ext2_inode_info', 'vfs_inode');
  const hasData = layout.hasField('ext2_inode_info', 'i_data');
  const vfsOffset = hasVfs ? layout.byteOffset('ext2_inode_info', 'vfs_inode') : null;
  let vfsType = null;
  let inodeSize = null;
  if (hasVfs) {
    vfsType = info.fields?.vfs_inode?.typeName ?? null;
    const nested = String(vfsType ?? '').replace(/\b(struct|union|enum|const|volatile)\b/g, '').trim();
    inodeSize = layout.typeNames().includes(nested) ? layout.type(nested).byteSize : null;
  }
  const dataField = info.fields?.i_data ?? null;
  return {
    infoSize: info.byteSize,
    vfsOffset,
    vfsType,
    inodeSize,
    dataOffset: hasData ? layout.byteOffset('ext2_inode_info', 'i_data') : null,
    dataBytes: dataField?.byteSize ?? null,
    dataType: dataField?.typeName ?? null,
    /** `container_of(inode, struct ext2_inode_info, vfs_inode)` = inode 地址 − 这个数 */
    backshift: vfsOffset,
  };
}

// ---------------------------------------------------------------------------
// 通道六：生成盘面的脚本（期望值从生成器重算，不从盘上抄）
// ---------------------------------------------------------------------------

/**
 * 从 `scripts/build-rootfs.sh` 里**读出**两个文件的生成公式。
 *
 * 这一步的关键是"期望值不来自盘面"：`hello.txt` 的字节从那条 `printf` 的字面量
 * 重新解码出来，`probe.bin` 的每块内容从那个 python f-string 模板重新拼出来。
 * 如果改成"先 `cat` 一遍盘上的文件再比"，那就只是拿盘面验盘面。
 */
function readRootfsRecipe(scriptText) {
  const printfLine = /printf\s+'((?:[^'\\]|\\.)*)'\s*>\s*"\$ROOTFS\/data\/hello\.txt"/.exec(scriptText);
  const pythonLoop = /for\s+i\s+in\s+range\((\d+)\)\s*:\s*f\.write\(\(f'((?:[^'\\]|\\.)*)'\.encode\(\)\)\.ljust\((\d+)\s*,\s*b'(.)'\)\)/
    .exec(scriptText);
  const mke2fs = /mke2fs\s+(-[^\n]*?)"\$ROOTFS\/data"/.exec(scriptText);
  const truncate = /truncate\s+-s\s+(\S+)\s+"\$ROOT\/artifacts\/rootfs\.img"/.exec(scriptText);
  return {
    helloLiteral: printfLine === null ? null : printfLine[1],
    helloBytes: printfLine === null ? null : Buffer.from(unescapeSingleQuoted(printfLine[1]), 'latin1'),
    probeCount: pythonLoop === null ? null : Number(pythonLoop[1]),
    probeTemplate: pythonLoop === null ? null : pythonLoop[2],
    probeLineBytes: pythonLoop === null ? null : Number(pythonLoop[3]),
    probeFill: pythonLoop === null ? null : pythonLoop[4],
    mke2fsArgs: mke2fs === null ? null : mke2fs[1].trim(),
    truncateSize: truncate === null ? null : truncate[1],
  };
}

/** shell 单引号里那点转义：只有 `\n` `\t` `\\` 会用到，其余反斜杠原样保留。 */
function unescapeSingleQuoted(literal) {
  let out = '';
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index];
    if (char !== '\\') { out += char; continue; }
    const next = literal[index + 1];
    if (next === 'n') { out += '\n'; index += 1; continue; }
    if (next === 't') { out += '\t'; index += 1; continue; }
    if (next === '\\') { out += '\\'; index += 1; continue; }
    if (next === 'x') {
      const digits = literal.slice(index + 2, index + 4);
      if (/^[0-9a-fA-F]{2}$/.test(digits)) { out += String.fromCharCode(Number.parseInt(digits, 16)); index += 3; continue; }
    }
    out += char;
  }
  return out;
}

/** 按 python 那个 f-string 模板重算 `probe.bin` 的第 `index` 块（4096 字节）。 */
function expectedProbeBlock(recipe, index) {
  if (recipe.probeTemplate === null) return null;
  const rendered = recipe.probeTemplate
    .replace(/\{i:0(\d+)d\}/g, (_, width) => String(index).padStart(Number(width), '0'))
    .replace(/\{i:d\}/g, String(index))
    .replace(/\{i\}/g, String(index));
  const line = Buffer.from(unescapeSingleQuoted(rendered), 'latin1');
  if (line.length > recipe.probeLineBytes) return null;
  const block = Buffer.alloc(recipe.probeLineBytes, Buffer.from(recipe.probeFill, 'latin1')[0]);
  line.copy(block, 0);
  return block;
}

// ---------------------------------------------------------------------------
// 活体通道：服务的会话接口（与离线 A 段共用同一套解析器，来源却不同）
// ---------------------------------------------------------------------------

async function call(app, method, url, payload) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body };
}

function describe(body) {
  if (body === null || body === undefined) return '（空响应）';
  if (typeof body === 'string') return body.slice(0, 300);
  if (body.error) return `code=${body.error.code} message=${body.error.message}`;
  return JSON.stringify(body).slice(0, 300);
}

function waitForTerminal(app, base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const terminal = await call(app, 'GET', `${base}/terminal`);
      const text = terminal.body?.text ?? '';
      if (PROMPT.test(text)) return resolve(text);
      if (Date.now() >= deadline) {
        return reject(new Error(`等待客体提示符超时（${timeoutMs} ms）；串口末尾：${JSON.stringify(text.slice(-400))}`));
      }
      setTimeout(tick, 500);
      return undefined;
    };
    tick();
  });
}

/**
 * 等串口出现一个标记。
 *
 * 标记必须**不可能**出现在命令行的回显里，否则等待立刻返回、断言变成空转。所以调用方
 * 传进来的都写成 `PRO""BE-END` 这种**成对的空引号**形式：回显里是 `PRO""BE-END`，
 * 真正打出来的是 `PROBE-END`。引号必须成对，落单的引号会让 shell 停在 PS2 续行提示符
 * 上等输入，命令根本不执行。
 */
function waitForTerminalMarker(app, base, marker, timeoutMs, cursor = 0) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const terminal = await call(app, 'GET', `${base}/terminal`);
      const text = (terminal.body?.text ?? '').slice(cursor);
      if (text.includes(marker)) return resolve(text);
      if (Date.now() >= deadline) {
        return reject(new Error(`等待串口标记 ${marker} 超时（${timeoutMs} ms）；串口末尾：${JSON.stringify(text.slice(-400))}`));
      }
      setTimeout(tick, 500);
      return undefined;
    };
    tick();
  });
}

async function waitForNextFrame(live, afterFrameId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = live.frames.at(-1);
    if (frame && frame.frameId > afterFrameId) return frame;
    await sleep(200);
  }
  return null;
}

/** 认领失败时把客体当下看到的东西带进错误信息，省掉一次"再启动一次才知道"的重跑。 */
async function terminalTailOf(app, base, maxChars = 400) {
  try {
    const terminal = await call(app, 'GET', `${base}/terminal`);
    return JSON.stringify(String(terminal.body?.text ?? '').slice(-maxChars));
  } catch (error) {
    return `（串口读取也失败：${error.message}）`;
  }
}

/**
 * 认领循环的**全局**请求序号。服务端按 `requestId` 幂等：重复的 `requestId` 会把首次
 * 结果原样返回、并跳过新鲜度检查，于是 `terminal.input` 会被"缓存命中"短路掉、命令
 * 根本送不进客体。所以整轮运行内必须唯一。
 */
let claimSeq = 0;

/**
 * 反复"装断点 → 递命令 → 认领停点"，直到认领成功（或尝试次数用完）。
 *
 * 为什么必须重试：断点是"先装、后由客体里的另一个进程去触发"的，两次之间隔着一次
 * `execve`，而 `execve` 会换掉地址空间、重置线程状态，GDB 把 `int3` 补回内核文本这一步
 * 有概率失败 —— 断点静默消失：GDB 不报错、QEMU 不报错，症状只是"命令明明跑完了、
 * 串口上输出都对，却一次都没停"。所以每次尝试都**重新装**一遍。
 */
async function claimWithRetry(options) {
  const {
    app, base, live, cmd, symbol, module: stageId = 'linux-kernel',
    commandFor, markerFor, inspect,
    maxAttempts = 8, perFrameWaitMs = 10000, settleMs = 4000, attemptBudgetMs = 60000,
  } = options;
  const attempts = [];
  let breakpoint = null;
  const stopTally = () => ({
    frames: live.frames.length,
    signals: live.stopSignals?.count ?? null,
    qmpStops: live.events.filter((event) => event.kind === 'qmp.STOP').length,
    state: live.state ?? null,
    pendingCapture: Boolean(live.pendingCapture),
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const text = commandFor(attempt);
    const marker = markerFor(attempt);
    const trace = [];
    let removeStatus = null;
    await cmd('pause');
    if (breakpoint !== null && breakpoint.id !== null) {
      const removed = await cmd('breakpoint.remove', { breakpointId: breakpoint.id });
      removeStatus = removed.status;
    }
    const inserted = await cmd('breakpoint.insert', { location: { symbol, module: stageId }, kind: 'software' });
    if (inserted.status !== 200) throw new Error(`在 ${symbol} 下断点失败：${describe(inserted.body)}`);
    breakpoint = inserted.body?.breakpoint ?? null;
    if (breakpoint?.pending === true) {
      log(`[认领] 警告：${symbol} 的断点 pending=true（地址=${breakpoint.address ?? '未解出'}），它不会触发`);
    }
    const cursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    const tallyBefore = stopTally();
    // 基线帧号必须在 `continue` **之前**取：`continue` 之后可能立刻停一次。
    const baselineFrameId = live.frames.at(-1)?.frameId ?? 0;
    for (let waited = 0; waited < 50 && live.pendingCapture; waited += 1) await sleep(200);
    let continueStatus = null;
    let continueBody = null;
    for (let tries = 1; tries <= 4 && continueStatus !== 200; tries += 1) {
      const response = await cmd('continue');
      continueStatus = response.status;
      continueBody = response.status === 200 ? null : describe(response.body);
      if (response.status !== 200) {
        log(`[认领] continue 被拒（HTTP ${response.status}：${continueBody}），刷新帧号重试第 ${tries} 次`);
        await sleep(200);
      }
    }
    let lastFrameId = baselineFrameId;
    let inputStatus = null;
    let inputBody = null;
    for (let tries = 1; tries <= 5 && inputStatus !== 200; tries += 1) {
      const posted = await call(app, 'POST', `${base}/commands`, {
        requestId: `t07e-claim-${++claimSeq}-${attempt}-${symbol}`,
        epoch: live.epoch,
        expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
        type: 'terminal.input',
        text,
      });
      inputStatus = posted.status;
      inputBody = posted.status === 200 ? null : describe(posted.body);
      if (posted.status !== 200) {
        log(`[认领] 递命令被拒（HTTP ${posted.status}：${inputBody}），刷新帧号后重试第 ${tries} 次`);
        await cmd('continue');
        await sleep(300);
      }
    }
    if (inputStatus !== 200) {
      log(`[认领] 警告：命令没能递进客体（HTTP ${inputStatus}：${inputBody}），这一次尝试大概率白等`);
    }

    const startedAt = Date.now();
    let claimed = null;
    let stopsSeen = 0;
    let markerSeen = false;
    while (Date.now() - startedAt < attemptBudgetMs) {
      const frame = await waitForNextFrame(live, lastFrameId, perFrameWaitMs);
      if (frame !== null) {
        lastFrameId = frame.frameId;
        stopsSeen += 1;
        const tailNow = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
        const hit = await inspect(frame, tailNow.slice(cursor));
        trace.push(`${frame.frameId}@${Date.now() - startedAt}ms:${hit.label}`);
        if (hit.claimed) { claimed = { frame, value: hit.value }; break; }
        await cmd('continue');
        continue;
      }
      const tail = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
      if (Date.now() - startedAt > settleMs && tail.slice(cursor).includes(marker)) {
        markerSeen = true;
        break;
      }
    }
    attempts.push({
      attempt, symbol, stopsSeen, claimed: claimed !== null, markerSeen,
      trace: trace.slice(-60),
      tally: { before: tallyBefore, after: stopTally() },
      breakpoint: breakpoint === null ? null : {
        id: breakpoint.id, spec: breakpoint.spec, hardware: breakpoint.hardware,
        address: breakpoint.address, pending: breakpoint.pending,
      },
      insertedStatus: inserted.status, continueStatus, continueBody, inputStatus, inputBody,
      baselineFrameId, removeStatus, budgetMs: attemptBudgetMs,
    });
    if (claimed !== null) {
      return { frame: claimed.frame, value: claimed.value, attempts, breakpoint, stops: stopsSeen, failed: false };
    }
    log(`[认领] ${symbol} 第 ${attempt} 次尝试没逮到（停点 ${stopsSeen} 次：${trace.slice(-8).join(' ') || '一次都没停'}；`
      + `命令跑完=${markerSeen} continue=${continueStatus} 递命令=${inputStatus} `
      + `帧=${tallyBefore.frames}→${live.frames.length} 断点=${breakpoint === null ? '缺' : `#${breakpoint.id}@${breakpoint.address}`}），重装断点再试`);
  }
  return { frame: null, value: null, attempts, breakpoint, stops: 0, failed: true };
}

function countSessionProcesses(sessionId) {
  try {
    const output = execFileSync('bash', [
      '-c', `ps -eo args | grep -F '${sessionId}' | grep -v grep | wc -l`,
    ], { encoding: 'utf8' });
    return Number(output.trim());
  } catch {
    return -1;
  }
}

let captureReadSeq = 0;

/** 从活体会话读客体线性地址（内存侧那条链的来源）。 */
class LiveCapture {
  constructor(options) {
    this.app = options.app;
    this.base = options.base;
    this.kernelRelease = options.kernelRelease;
    this.symbols = options.symbols;
    this.sizes = options.sizes;
    this.attribution = {
      sessionId: options.sessionId,
      epoch: options.epoch,
      frameId: options.frameId,
      captureId: options.captureId,
    };
    this.reads = 0;
    this.bytes = 0;
    this.sources = new Set();
  }

  async readVirtual(address, length) {
    const text = hex(address);
    const response = await call(this.app, 'POST', `${this.base}/commands`, {
      requestId: `t07e-capture-${this.attribution.frameId}-${++captureReadSeq}`,
      epoch: this.attribution.epoch,
      expectedFrameId: this.attribution.frameId,
      type: 'memory.read',
      mode: 'read',
      addressSpace: 'linear',
      address: text,
      length,
    });
    if (response.status !== 200 || typeof response.body?.hex !== 'string') {
      throw new Error(`读线性地址 ${text}+${length} 失败：${describe(response.body)}`);
    }
    const bytes = Buffer.from(response.body.hex, 'hex');
    if (bytes.length !== length) {
      throw new Error(`读 ${text}+${length} 只拿到 ${bytes.length} 字节`);
    }
    this.sources.add(String(response.body?.evidence?.source ?? 'unknown'));
    this.reads += 1;
    this.bytes += bytes.length;
    return new Uint8Array(bytes);
  }

  symbolAddress(name) {
    return this.symbols.get(name) ?? null;
  }
}

function littleEndian(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

/**
 * 认领停点时唯一要回答的问题是"现在停在谁身上"。只读 `comm` 不够：`fork` 出来的孩子在
 * `execve` 装载 ELF 期间 `comm` 还是父进程的名字。把 pid/tgid/mm/父进程一起读出来，
 * 才分得清"父进程自己"和"还没换名字的孩子"。
 */
async function describeStoppedTask(capture, percpuHotLink, offsets) {
  const offsetTable = capture.symbolAddress('__per_cpu_offset');
  if (offsetTable === null || percpuHotLink === null) return { comm: null, label: '读不到', pid: null };
  const percpuBase = littleEndian(await capture.readVirtual(offsetTable, 8));
  const task = littleEndian(await capture.readVirtual(percpuBase + percpuHotLink, 8));
  if (task === 0n) return { comm: null, label: 'current=0（空闲任务）', pid: null };
  const commBytes = await capture.readVirtual(task + BigInt(offsets.comm), 16);
  const zero = commBytes.indexOf(0);
  const comm = Buffer.from(zero < 0 ? commBytes : commBytes.subarray(0, zero)).toString('utf8');
  const pid = littleEndian(await capture.readVirtual(task + BigInt(offsets.pid), 4));
  const tgid = littleEndian(await capture.readVirtual(task + BigInt(offsets.tgid), 4));
  const mm = littleEndian(await capture.readVirtual(task + BigInt(offsets.mm), 8));
  const parent = littleEndian(await capture.readVirtual(task + BigInt(offsets.realParent), 8));
  let parentText = '父=无';
  if (parent !== 0n && parent !== task) {
    const parentComm = await capture.readVirtual(parent + BigInt(offsets.comm), 16);
    const parentZero = parentComm.indexOf(0);
    parentText = `父=${Buffer.from(parentZero < 0 ? parentComm : parentComm.subarray(0, parentZero)).toString('utf8')}`;
  }
  return {
    comm,
    pid: Number(pid),
    tgid: Number(tgid),
    taskAddress: task,
    mmAddress: mm,
    label: `${comm}#pid${pid}/tgid${tgid} mm=${mm === 0n ? '0' : hex(mm)} ${parentText}`,
  };
}
// ---------------------------------------------------------------------------
// A 段用到的补充解析器与"另一份实现"
// ---------------------------------------------------------------------------

/** `debugfs -R "stats"` 的 ` Group  N: block bitmap at 7, inode bitmap at 8, inode table at 9` 加下一行计数。 */
function parseDebugfsStatsGroups(text) {
  const groups = [];
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^\s*Group\s+(\d+):\s*block bitmap at (\d+),\s*inode bitmap at (\d+),\s*inode table at (\d+)\s*$/
      .exec(lines[index]);
    if (head === null) continue;
    const counts = /^\s*(\d+) free blocks,\s*(\d+) free inodes,\s*(\d+) used directories\s*$/.exec(lines[index + 1] ?? '');
    groups.push({
      index: Number(head[1]),
      blockBitmap: BigInt(head[2]),
      inodeBitmap: BigInt(head[3]),
      inodeTable: BigInt(head[4]),
      freeBlocks: counts === null ? null : Number(counts[1]),
      freeInodes: counts === null ? null : Number(counts[2]),
      usedDirs: counts === null ? null : Number(counts[3]),
    });
  }
  return groups;
}

/**
 * 我们自己的 `mode` → `ls -l` 风格字符串（与 `ext2-tree.ts` 里那份实现互不相干）。
 *
 * 存在的意义：`formatExt2Mode()` 里 `s`/`S`/`t`/`T` 那一处是"顶掉执行位、不是另加一位"，
 * 写错的时候只在带 setuid/setgid/sticky 的文件上表现出来，而这张盘上恰好一个都没有 ——
 * 所以要用一份独立实现把这些边界组合也验一遍。
 */
function independentModeText(mode) {
  const typeChars = [[0o010000, 'p'], [0o020000, 'c'], [0o040000, 'd'], [0o060000, 'b'],
    [0o100000, '-'], [0o120000, 'l'], [0o140000, 's']];
  let type = '?';
  for (const [masked, char] of typeChars) if ((mode & 0o170000) === masked) type = char;
  const specialBits = [0o4000, 0o2000, 0o1000];
  let rest = '';
  for (let group = 0; group < 3; group += 1) {
    const triplet = (mode >> (6 - group * 3)) & 0o7;
    const read = (triplet & 0o4) !== 0 ? 'r' : '-';
    const write = (triplet & 0o2) !== 0 ? 'w' : '-';
    const special = (mode & specialBits[group]) !== 0;
    const execute = (triplet & 0o1) !== 0 ? (special ? 'sst'[group] : 'x') : (special ? 'SST'[group] : '-');
    rest += `${read}${write}${execute}`;
  }
  return `${type}${rest}`;
}

/** `ext2_block_to_path()` 的独立实现：按内核那四段"先减容量再判"重写一遍。 */
function independentBlockToPath(blockIndex, blockSize) {
  const ptrs = blockSize / 4;
  const bits = Math.round(Math.log2(blockSize)) - 2;
  const direct = 12;
  const double = 1 << (bits * 2);
  let index = blockIndex;
  if (index < 0) return { outOfRange: true, offsets: [] };
  if (index < direct) return { outOfRange: false, offsets: [index] };
  index -= direct;
  if (index < ptrs) return { outOfRange: false, offsets: [12, index] };
  index -= ptrs;
  if (index < double) return { outOfRange: false, offsets: [13, index >> bits, index & (ptrs - 1)] };
  index -= double;
  if ((index >> (bits * 2)) < ptrs) {
    return { outOfRange: false, offsets: [14, index >> (bits * 2), (index >> bits) & (ptrs - 1), index & (ptrs - 1)] };
  }
  return { outOfRange: true, offsets: [] };
}

/** 内核 `EXT2_DIR_REC_LEN(name_len)` = `((name_len) + 8 + 3) & ~3` 的独立重写。 */
function independentRecLen(nameLen) {
  return (nameLen + 8 + 3) & ~3;
}

/** 从 `fs/ext2/inode.c` 的 `ext2_block_to_path()` 里取那四段分支与告警串。 */
function readBlockToPathSource(text) {
  const body = readFunctionBody(text, 'ext2_block_to_path');
  if (body === null) return null;
  // 6.12 里越界是**两种情形、两句话**，都走 `ext2_msg(inode->i_sb, KERN_WARNING, …)`：
  // 负数打 `warning: %s: block < 0`，太大打 `warning: %s: block is too big`。
  // （写成老的 `ext2_warning(... "block > big")` 会一条都读不到，然后静默"全通过"。）
  const messages = [...body.matchAll(/ext2_msg\s*\([^;]*?"([^"]*)"/g)].map((match) => match[1]);
  const elseTail = body.slice(body.lastIndexOf('} else {'));
  const tooBig = /ext2_msg\s*\([^;]*?"([^"]*)"/.exec(elseTail);
  return {
    directBlocksDecl: /const\s+long\s+direct_blocks\s*=\s*EXT2_NDIR_BLOCKS/.test(body),
    indirectBlocksDecl: /indirect_blocks\s*=\s*ptrs/.test(body),
    doubleBlocksDecl: /double_blocks\s*=\s*\(\s*1\s*<<\s*\(\s*ptrs_bits\s*\*\s*2\s*\)\s*\)/.test(body),
    ptrsDecl: /ptrs\s*=\s*EXT2_ADDR_PER_BLOCK\s*\(\s*inode->i_sb\s*\)/.test(body),
    directSegment: /i_block\s*<\s*direct_blocks/.test(body),
    indirectSegment: /-=\s*direct_blocks\s*\)\s*<\s*indirect_blocks/.test(body),
    doubleSegment: /-=\s*indirect_blocks\s*\)\s*<\s*double_blocks/.test(body),
    tripleSegment: /-=\s*double_blocks\s*\)\s*>>\s*\(\s*ptrs_bits\s*\*\s*2\s*\)\s*\)\s*<\s*ptrs/.test(body),
    negativeWarning: messages[0] ?? null,
    bigWarning: tooBig === null ? null : tooBig[1],
  };
}

/** 小端编码的两个小工具（造坏块用）。 */
function u16le(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value & 0xffff, 0);
  return bytes;
}

function u32le(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

/**
 * 从事实对象里摘出"多方对照"的一行。统一折成 `bigint`，避免 `null !== undefined` 这种假不一致；
 * 某一方是 `null` 表示"这个量在那一方本来就不存在"（例如 `dd` 读不出"组数"，`dumpe2fs -h` 里
 * 没有特性位的掩码），只比**先到场的那些方**。
 */
function tripleRow(label, ours, raw, other, otherName = 'e2fsprogs') {
  const a = asBig(ours);
  const b = asBig(raw);
  const c = asBig(other);
  const present = [a, b, c].filter((value) => value !== null);
  return {
    label,
    ours: a,
    raw: b,
    other: c,
    otherName,
    arity: present.length,
    ok: a !== null && present.every((value) => value === a),
  };
}

// ---------------------------------------------------------------------------
// A 段：离线（关闭镜像 + e2fsprogs + 原始字节 + 内核源码 + DWARF + 生成脚本）
// ---------------------------------------------------------------------------

async function offlineSection(evidence, layout) {
  const out = {};

  // 内核源码原文在这里统一读一次：A1（特性位掩码）、A3（`osd2` 内部排布）、A4（常量与算式）、
  // A7/A12（目录项校验逻辑）都要用。放在函数开头而不是下面某一段，是因为段与段之间是顺序执行的，
  // 后面才声明的 `const` 在前面用会直接报"先用后声明"。
  const ext2hText = fs.readFileSync(EXT2_H, 'utf8');
  const ext2FsText = fs.readFileSync(EXT2_FS_H, 'utf8');
  const magicText = fs.readFileSync(MAGIC_H, 'utf8');
  const uapiFsText = fs.readFileSync(UAPI_FS_H, 'utf8');
  const fsTypesText = fs.readFileSync(FS_TYPES_H, 'utf8');
  const fsTypesCText = fs.readFileSync(FS_TYPES_C, 'utf8');
  const dirCText = fs.readFileSync(EXT2_DIR_C, 'utf8');
  const inodeCText = fs.readFileSync(EXT2_C, 'utf8');

  // ---------- A0 镜像就是"关闭后"的那一份 ----------

  const imageStat = fs.statSync(IMAGE);
  const imageBytes = fs.readFileSync(IMAGE);
  const imageSha = crypto.createHash('sha256').update(imageBytes).digest('hex');
  const e2fsck = sh(`e2fsck -fn ${shq(IMAGE)}`);
  const e2fsckSummary = /:\s*(\d+)\/(\d+) files \(([^)]*)\),\s*(\d+)\/(\d+) blocks/.exec(e2fsck.text);
  const e2fsckComplaining = /\*\*\*|Corrupt|corrupt|invalid|Illegal|Cannot/i.test(e2fsck.text);
  evidence.image = {
    path: path.relative(ROOT, IMAGE),
    bytes: imageStat.size,
    mtime: imageStat.mtime.toISOString(),
    sha256: imageSha,
    e2fsck: {
      code: e2fsck.code,
      ok: e2fsck.ok,
      summary: e2fsckSummary === null ? null : {
        files: Number(e2fsckSummary[1]),
        inodesTotal: Number(e2fsckSummary[2]),
        blocks: Number(e2fsckSummary[4]),
        blocksTotal: Number(e2fsckSummary[5]),
      },
      tail: e2fsck.text.trim().split('\n').slice(-2),
    },
  };
  check(
    'T07e-A0 基座镜像是"关闭后"的那一份：大小正好 96 MiB、`e2fsck -fn` 干净（0 退出码、无 *** 抱怨）、mtime 早于本轮起点'
      + '（我们从头到尾只以只读方式碰它）',
    imageStat.size === IMAGE_BYTES
      && e2fsck.ok === true && e2fsckSummary !== null && !e2fsckComplaining
      && imageStat.mtimeMs < new Date(evidence.startedAt).getTime(),
    `大小=${imageStat.size}B（期望 ${IMAGE_BYTES}B=${IMAGE_BYTES / 1024 / 1024}MiB，差 ${imageStat.size - IMAGE_BYTES}）`
      + `；e2fsck 退出码=${e2fsck.code} 摘要=${e2fsckSummary === null ? e2fsck.text.trim().split('\n').slice(-2).join(' | ') : e2fsckSummary[0]}`
      + `；mtime=${imageStat.mtime.toISOString()}（本轮起点 ${evidence.startedAt}）`,
  );
  out.imageBytes = imageBytes;
  out.imageSha = imageSha;

  // ---------- 通道一：我们的解析器读关闭镜像 ----------

  const source = new BufferDiskSource({ bytes: imageBytes });
  const sb = await readExt2Superblock(source);
  const groupTable = await readExt2GroupDescriptors(source, sb);
  assertExt2Parseable(sb);
  out.source = source;
  out.sb = sb;
  out.groupTable = groupTable;

  // ---------- A1 超级块三方一致 ----------

  const dumpe2fsHead = parseDumpe2fsHead(sh(`dumpe2fs -h ${shq(IMAGE)}`).text);
  const dumpe2fsFull = sh(`dumpe2fs ${shq(IMAGE)}`).text;
  const dumpe2fsGroups = parseDumpe2fsGroups(dumpe2fsFull);
  const rawSb = ddBytes(Number(EXT2_SUPERBLOCK_OFFSET), EXT2_SB_SIZE);
  const raw = {
    inodesCount: leU32(rawSb, EXT2_SB_FIELDS.inodesCount),
    blocksCount: leU32(rawSb, EXT2_SB_FIELDS.blocksCount),
    reservedBlocksCount: leU32(rawSb, EXT2_SB_FIELDS.reservedBlocksCount),
    freeBlocksCount: leU32(rawSb, EXT2_SB_FIELDS.freeBlocksCount),
    freeInodesCount: leU32(rawSb, EXT2_SB_FIELDS.freeInodesCount),
    firstDataBlock: leU32(rawSb, EXT2_SB_FIELDS.firstDataBlock),
    logBlockSize: leU32(rawSb, EXT2_SB_FIELDS.logBlockSize),
    blocksPerGroup: leU32(rawSb, EXT2_SB_FIELDS.blocksPerGroup),
    inodesPerGroup: leU32(rawSb, EXT2_SB_FIELDS.inodesPerGroup),
    magic: leU16(rawSb, EXT2_SB_FIELDS.magic),
    state: leU16(rawSb, EXT2_SB_FIELDS.state),
    revLevel: leU32(rawSb, EXT2_SB_FIELDS.revLevel),
    firstIno: leU32(rawSb, EXT2_SB_FIELDS.firstIno),
    inodeSize: leU16(rawSb, EXT2_SB_FIELDS.inodeSize),
    featureCompat: leU32(rawSb, EXT2_SB_FIELDS.featureCompat),
    featureIncompat: leU32(rawSb, EXT2_SB_FIELDS.featureIncompat),
    featureRoCompat: leU32(rawSb, EXT2_SB_FIELDS.featureRoCompat),
    blockGroupNr: leU16(rawSb, EXT2_SB_FIELDS.blockGroupNr),
  };
  const dumpe2fsBlockSize = dumpe2fsNumber(dumpe2fsHead, 'Block size');
  const sbRows = [
    tripleRow('magic', sb.magic, raw.magic, dumpe2fsNumber(dumpe2fsHead, 'Filesystem magic number')),
    tripleRow('blockSize', sb.blockSize, 1024 << raw.logBlockSize, dumpe2fsBlockSize),
    // ext2 的定义是 `blockSize = 1024 << s_log_block_size`（1024 = 2^10），
    // 所以盘上那个字段等于 `log2(块大小) - 10`：4096 字节的块对应 2，不是 12。
    tripleRow('logBlockSize', sb.logBlockSize, raw.logBlockSize, Math.log2(dumpe2fsBlockSize) - 10),
    tripleRow('inodeSize', sb.inodeSize, raw.inodeSize, dumpe2fsNumber(dumpe2fsHead, 'Inode size')),
    tripleRow('firstDataBlock', sb.firstDataBlock, raw.firstDataBlock, dumpe2fsNumber(dumpe2fsHead, 'First block')),
    tripleRow('blocksCount', sb.blocksCount, raw.blocksCount, dumpe2fsNumber(dumpe2fsHead, 'Block count')),
    tripleRow('inodesCount', sb.inodesCount, raw.inodesCount, dumpe2fsNumber(dumpe2fsHead, 'Inode count')),
    tripleRow('blocksPerGroup', sb.blocksPerGroup, raw.blocksPerGroup, dumpe2fsNumber(dumpe2fsHead, 'Blocks per group')),
    tripleRow('inodesPerGroup', sb.inodesPerGroup, raw.inodesPerGroup, dumpe2fsNumber(dumpe2fsHead, 'Inodes per group')),
    tripleRow('firstIno', sb.firstIno, raw.firstIno, dumpe2fsNumber(dumpe2fsHead, 'First inode')),
    tripleRow('freeBlocksCount', sb.freeBlocksCount, raw.freeBlocksCount, dumpe2fsNumber(dumpe2fsHead, 'Free blocks')),
    tripleRow('freeInodesCount', sb.freeInodesCount, raw.freeInodesCount, dumpe2fsNumber(dumpe2fsHead, 'Free inodes')),
    tripleRow('reservedBlocksCount', sb.reservedBlocksCount, raw.reservedBlocksCount, dumpe2fsNumber(dumpe2fsHead, 'Reserved block count')),
    tripleRow('revLevel', sb.revLevel, raw.revLevel, dumpe2fsNumber(dumpe2fsHead, 'Filesystem revision #')),
    tripleRow('featureCompat', sb.featureCompat, raw.featureCompat, null),
    tripleRow('featureIncompat', sb.featureIncompat, raw.featureIncompat, null),
    tripleRow('featureRoCompat', sb.featureRoCompat, raw.featureRoCompat, null),
    tripleRow('state(VALID_FS=1)', sb.state, raw.state, dumpe2fsHead.get('Filesystem state') === 'clean' ? 1 : null),
    tripleRow('groupCount', sb.groupCount, Math.ceil(raw.blocksCount / raw.blocksPerGroup), dumpe2fsGroups.length),
    tripleRow('inodeTableBlocksPerGroup', sb.inodeTableBlocksPerGroup, null, dumpe2fsNumber(dumpe2fsHead, 'Inode blocks per group')),
    tripleRow('reservedGdtBlocks', groupTable.reservedGdtBlocks, null, dumpe2fsNumber(dumpe2fsHead, 'Reserved GDT blocks')),
    tripleRow('groupDescTableBlock', sb.groupDescTableBlock, groupTable.tableBlock, null),
  ];
  // "某一方本来就没有这个量"的行只比先到场的那些方，如实标出来（不假装三方都验过）。
  const sbRowsTwoWay = sbRows.filter((row) => row.arity < 3);
  const sbRowsThreeWay = sbRows.filter((row) => row.arity === 3);
  const sbBadThree = sbRowsThreeWay.filter((row) => row.ok !== true);
  const sbBadTwo = sbRowsTwoWay.filter((row) => row.ok !== true || row.ours === null);

  /**
   * 特性位单独比：e2fsprogs 打的是短名（`sparse_super`），内核是一串 `EXT2_FEATURE_*`
   * 宏。短名到宏的映射写在脚本里，掩码值从源码现读，然后**双向**比：
   * e2fsprogs 列的每一项我们都要置位，我们置的每一位也都要在 e2fsprogs 的名单里。
   * 只做前一半的写法漏得掉"我们多置了一位"。
   */
  const FEATURE_SHORT_TO_DEFINE = {
    dir_prealloc: 'EXT2_FEATURE_COMPAT_DIR_PREALLOC',
    imagic_inodes: 'EXT2_FEATURE_COMPAT_IMAGIC_INODES',
    has_journal: 'EXT3_FEATURE_COMPAT_HAS_JOURNAL',
    ext_attr: 'EXT2_FEATURE_COMPAT_EXT_ATTR',
    resize_inode: 'EXT2_FEATURE_COMPAT_RESIZE_INO',
    dir_index: 'EXT2_FEATURE_COMPAT_DIR_INDEX',
    compression: 'EXT2_FEATURE_INCOMPAT_COMPRESSION',
    filetype: 'EXT2_FEATURE_INCOMPAT_FILETYPE',
    recover: 'EXT3_FEATURE_INCOMPAT_RECOVER',
    journal_dev: 'EXT3_FEATURE_INCOMPAT_JOURNAL_DEV',
    meta_bg: 'EXT2_FEATURE_INCOMPAT_META_BG',
    sparse_super: 'EXT2_FEATURE_RO_COMPAT_SPARSE_SUPER',
    large_file: 'EXT2_FEATURE_RO_COMPAT_LARGE_FILE',
    btree_dir: 'EXT2_FEATURE_RO_COMPAT_BTREE_DIR',
  };
  const dumpe2fsFeatures = String(dumpe2fsHead.get('Filesystem features') ?? '')
    .trim().split(/\s+/).filter((name) => name.length > 0);
  const featureUnion = sb.featureCompat | sb.featureIncompat | sb.featureRoCompat;
  const featureFromSource = [];
  const featureBad = [];
  for (const name of dumpe2fsFeatures) {
    const define = FEATURE_SHORT_TO_DEFINE[name] ?? null;
    if (define === null) { featureBad.push(`${name}: 脚本里没有"短名 → 内核宏"的映射`); continue; }
    const masked = evalDefineValue(ext2hText, define);
    if (masked === null) { featureBad.push(`${name}(${define}): 源码里没有这个宏`); continue; }
    featureFromSource.push({ name, define, masked });
    if ((featureUnion & masked) === 0) {
      featureBad.push(`${name}(${define}=${hex(masked)}): 我们三个特性字段的并集里没有这一位`);
    }
  }
  const featureMaskFromNames = featureFromSource.reduce((mask, entry) => mask | entry.masked, 0);
  if (featureUnion !== featureMaskFromNames) {
    featureBad.push(`我们的并集 ${hex(featureUnion)} ≠ e2fsprogs 名单推出的并集 ${hex(featureMaskFromNames)}`
      + `（多出 ${hex(featureUnion & ~featureMaskFromNames)}，少了 ${hex(featureMaskFromNames & ~featureUnion)}）`);
  }
  evidence.superblock = {
    ours: {
      offset: hex(sb.offset), magic: hex(sb.magic), revLevel: sb.revLevel, revLevelName: sb.revLevelName,
      blockSize: sb.blockSize, logBlockSize: sb.logBlockSize, inodeSize: sb.inodeSize,
      firstDataBlock: hex(sb.firstDataBlock), blocksCount: hex(sb.blocksCount), inodesCount: hex(sb.inodesCount),
      blocksPerGroup: hex(sb.blocksPerGroup), inodesPerGroup: hex(sb.inodesPerGroup),
      firstIno: hex(sb.firstIno), groupCount: hex(sb.groupCount),
      featureCompat: hex(sb.featureCompat), featureIncompat: hex(sb.featureIncompat),
      featureRoCompat: hex(sb.featureRoCompat), compatNames: sb.compatNames, incompatNames: sb.incompatNames,
      roCompatNames: sb.roCompatNames, unsupportedIncompat: hex(sb.unsupportedIncompat),
      unsupportedRoCompat: hex(sb.unsupportedRoCompat), parseable: sb.parseable,
    },
    raw: raw,
    dumpe2fsHead: Object.fromEntries(dumpe2fsHead),
    dumpe2fsFeatures,
    rows: sbRows.map((row) => ({ ...row, ours: jsonSafe(row.ours), raw: jsonSafe(row.raw), other: jsonSafe(row.other) })),
    threeWayMismatch: sbBadThree.map((row) => `${row.label}: 我们=${row.ours} dd原始字节=${row.raw} ${row.otherName}=${row.other}`),
    twoWayMismatch: sbBadTwo.map((row) => `${row.label}: 我们=${row.ours} ${row.raw === null ? `${row.otherName}=${row.other}` : `dd原始字节=${row.raw}`}`),
    features: {
      fromDumpe2fs: dumpe2fsFeatures,
      fromSource: featureFromSource,
      ourUnion: hex(featureUnion),
      maskFromNames: hex(featureMaskFromNames),
      mismatch: featureBad,
    },
  };
  check(
    'T07e-A1 超级块三方一致（我们 vs `dumpe2fs -h` vs `dd` 在绝对字节偏移 1024 处切出的原始字节，用脚本里另写的解码器读）：'
      + 'magic/块大小/inode 大小/首数据块/块数/inode 数/每组块数与 inode 数/首次 inode/空闲计数/版本/保留 GDT 块数/描述符表位置；'
      + '特性位名单双向比对（e2fsprogs 列的每一项掩码值现从源码读、我们三位并集里必须都有；我们置的每一位也必须在名单里）',
    sbBadThree.length === 0 && sbBadTwo.length === 0
      && asBig(sb.magic) === BigInt(EXT2_SUPER_MAGIC)
      && asBig(sb.inodeSize) === BigInt(EXT2_GOOD_OLD_INODE_SIZE)
      && sb.unsupportedIncompat === 0 && sb.parseable === true
      && featureBad.length === 0 && featureFromSource.length === dumpe2fsFeatures.length
      && featureFromSource.length > 0,
    `magic=${hex(sb.magic)} 块大小=${sb.blockSize} inode 大小=${sb.inodeSize} 首数据块=${sb.firstDataBlock} `
      + `块数=${sb.blocksCount} inode 数=${sb.inodesCount} 每组 inode=${sb.inodesPerGroup} 首次 inode=${sb.firstIno} `
      + `保留 GDT 块=${groupTable.reservedGdtBlocks}（dumpe2fs=${dumpe2fsNumber(dumpe2fsHead, 'Reserved GDT blocks')}）`
      + `；三方不一致 ${sbBadThree.length} 项${sbBadThree.length === 0 ? '' : `：${sbBadThree.map((row) => row.label).join('/')}`}`
      + `；两方不一致 ${sbBadTwo.length} 项${sbBadTwo.length === 0 ? '' : `：${sbBadTwo.map((row) => row.label).join('/')}`}`
      + `；特性 ${dumpe2fsFeatures.join(' ')}（并集 ${hex(featureUnion)}，名单推出 ${hex(featureMaskFromNames)}，不一致 ${featureBad.length}）`,
  );

  // ---------- A2 块组描述符 ----------

  const debugfsStatsGroups = parseDebugfsStatsGroups(sh(`debugfs -R "stats" ${shq(IMAGE)}`).text);
  const group0 = groupTable.descriptors[0];
  const fsGroup0 = dumpe2fsGroups[0] ?? {};
  const dfGroup0 = debugfsStatsGroups[0] ?? {};
  // 保留 GDT 块数的**定义**再独立算一遍：GDT 之后到"块位图/inode 位图/inode 表三者里最靠前的一个"。
  const metaBlocks = groupTable.descriptors
    .flatMap((entry) => [entry.blockBitmap, entry.inodeBitmap, entry.inodeTable])
    .filter((value) => value > groupTable.tableBlock)
    .sort((a, b) => (a < b ? -1 : 1));
  const reservedByDefinition = metaBlocks.length === 0
    ? null : metaBlocks[0] - groupTable.tableBlock - groupTable.tableBlocks;
  const reservedByDumpe2fsRange = fsGroup0.reservedGdtFrom === undefined
    ? null : fsGroup0.reservedGdtTo - fsGroup0.reservedGdtFrom + 1n;
  const groupRows = [
    tripleRow('group0.blockBitmap', group0.blockBitmap, null, fsGroup0.blockBitmap),
    tripleRow('group0.inodeBitmap', group0.inodeBitmap, null, fsGroup0.inodeBitmap),
    tripleRow('group0.inodeTable', group0.inodeTable, null, fsGroup0.inodeTable),
    tripleRow('group0.freeBlocksCount', group0.freeBlocksCount, null, fsGroup0.freeBlocks),
    tripleRow('group0.freeInodesCount', group0.freeInodesCount, null, fsGroup0.freeInodes),
    tripleRow('group0.usedDirsCount', group0.usedDirsCount, null, fsGroup0.directories),
    tripleRow('group0.debugfs.blockBitmap', group0.blockBitmap, null, dfGroup0.blockBitmap),
    tripleRow('group0.debugfs.inodeBitmap', group0.inodeBitmap, null, dfGroup0.inodeBitmap),
    tripleRow('group0.debugfs.inodeTable', group0.inodeTable, null, dfGroup0.inodeTable),
    tripleRow('group0.debugfs.freeBlocks', group0.freeBlocksCount, null, dfGroup0.freeBlocks),
    tripleRow('group0.debugfs.freeInodes', group0.freeInodesCount, null, dfGroup0.freeInodes),
    tripleRow('group0.debugfs.usedDirs', group0.usedDirsCount, null, dfGroup0.usedDirs),
    tripleRow('groupCount(dumpe2fs 段数)', groupTable.descriptors.length, null, dumpe2fsGroups.length),
  ];
  const groupBad = groupRows.filter((row) => row.ok !== true);
  evidence.groups = {
    tableBlock: hex(groupTable.tableBlock),
    tableBlocks: hex(groupTable.tableBlocks),
    reservedGdtBlocks: hex(groupTable.reservedGdtBlocks),
    reservedByDefinition: hexOrNull(reservedByDefinition),
    reservedByDumpe2fsRange: hexOrNull(reservedByDumpe2fsRange),
    descriptors: groupTable.descriptors.map((entry) => ({
      index: entry.index, address: hex(entry.address), blockBitmap: hex(entry.blockBitmap),
      inodeBitmap: hex(entry.inodeBitmap), inodeTable: hex(entry.inodeTable),
      freeBlocksCount: entry.freeBlocksCount, freeInodesCount: entry.freeInodesCount,
      usedDirsCount: entry.usedDirsCount, firstBlock: hex(entry.firstBlock),
      blocksCount: hex(entry.blocksCount), firstInode: hex(entry.firstInode), inodesCount: hex(entry.inodesCount),
    })),
    dumpe2fsGroups: dumpe2fsGroups.map((entry) => ({ ...entry })),
    debugfsStatsGroups: debugfsStatsGroups.map((entry) => ({
      ...entry, blockBitmap: hex(entry.blockBitmap), inodeBitmap: hex(entry.inodeBitmap), inodeTable: hex(entry.inodeTable),
    })),
    rows: groupRows.map((row) => ({ ...row, ours: jsonSafe(row.ours), raw: jsonSafe(row.raw), other: jsonSafe(row.other) })),
    mismatch: groupBad.map((row) => `${row.label}: 我们=${row.ours} ${row.otherName}=${row.other}`),
  };
  check(
    'T07e-A2 块组描述符一致（我们 vs `dumpe2fs` 的 Group 段 vs `debugfs stats` 的 Group 行）：位图与 inode 表位置、'
      + '空闲块/inode 数、目录数；描述符表位置按 `s_first_data_block + 1` 重算，保留 GDT 块数用定义（GDT 之后到最靠前的元数据块）'
      + '与 dumpe2fs 打出的块范围（`Reserved GDT blocks at 2-6` = 5 块）两条独立路径各算一遍',
    groupBad.length === 0 && dumpe2fsGroups.length > 0
      && asBig(groupTable.tableBlock) === asBig(sb.firstDataBlock) + 1n
      && asBig(groupTable.reservedGdtBlocks) === asBig(reservedByDefinition)
      && asBig(groupTable.reservedGdtBlocks) === asBig(reservedByDumpe2fsRange)
      && asBig(group0.blockBitmap) < asBig(group0.inodeBitmap)
      && asBig(group0.inodeBitmap) < asBig(group0.inodeTable),
    `描述符表=块 ${groupTable.tableBlock} 起、占 ${groupTable.tableBlocks} 块（=firstDataBlock+1）；`
      + `组 0：块位图=${group0.blockBitmap} inode 位图=${group0.inodeBitmap} inode 表=${group0.inodeTable} 起；`
      + `空闲块=${group0.freeBlocksCount} 空闲 inode=${group0.freeInodesCount} 目录数=${group0.usedDirsCount}；`
      + `保留 GDT 块=${groupTable.reservedGdtBlocks}（定义重算=${reservedByDefinition}，dumpe2fs 范围重算=${reservedByDumpe2fsRange}）；`
      + `不一致 ${groupBad.length} 项${groupBad.length === 0 ? '' : `：${groupBad.map((row) => row.label).join('/')}`}`,
  );

  // ---------- A3 我们的偏移表 vs DWARF 布局产物 ----------

  const sbCompare = compareOffsetTable('ext2_super_block', layout, 'ext2_super_block', EXT2_SB_FIELDS, SB_FIELD_NAMES);
  const gdCompare = compareOffsetTable('ext2_group_desc', layout, 'ext2_group_desc', EXT2_GD_FIELDS, GD_FIELD_NAMES);
  // `frag`/`fsize`/`uidHigh`/`gidHigh` 在 `ext2_inode` 的匿名联合 `osd2` 里，DWARF 产物按设计不
  // 下钻匿名联合，所以它们不能在这张表里核：剔出去，交给下面 `compareInodeOsd2Fields` 用
  // "联合起点取 DWARF + 内部排布从 C 源码算"的方式核。不剔的话这里会报四条"没有 C 名"。
  const inodeTableForDwarf = Object.fromEntries(
    Object.entries(EXT2_INODE_FIELDS).filter(([key]) => INODE_OSD2_FIELDS[key] === undefined),
  );
  const inodeCompare = compareOffsetTable('ext2_inode', layout, 'ext2_inode', inodeTableForDwarf, INODE_FIELD_NAMES);
  const dirCompare = compareOffsetTable('ext2_dir_entry_2', layout, 'ext2_dir_entry_2', EXT2_DIR_ENTRY_FIELDS, DIR_ENTRY_FIELD_NAMES);
  const osd2Compare = compareInodeOsd2Fields(layout, ext2hText);
  const infoFacts = vfsInodeLayoutFacts(layout);
  const widths = [
    { label: 'ext2_super_block', ours: EXT2_SB_SIZE, dwarf: layout.type('ext2_super_block').byteSize },
    { label: 'ext2_inode', ours: EXT2_GOOD_OLD_INODE_SIZE, dwarf: layout.type('ext2_inode').byteSize },
    { label: 'ext2_group_desc', ours: EXT2_GROUP_DESC_SIZE, dwarf: layout.type('ext2_group_desc').byteSize },
    { label: 'ext2_dir_entry_2', ours: 8, dwarf: layout.type('ext2_dir_entry_2').byteSize },
  ];
  const widthBad = widths.filter((row) => row.ours !== row.dwarf);
  const compares = [sbCompare, gdCompare, inodeCompare, dirCompare];
  const compareBad = compares.filter((entry) => entry.mismatches.length > 0);
  evidence.layout = {
    file: path.basename(LAYOUT_PATH),
    linuxRelease: layout.linuxRelease,
    compares: compares.map((entry) => ({
      type: entry.typeName, checked: entry.checked.length, mismatch: entry.mismatches,
    })),
    osd2: {
      osd2Base: hexOrNull(osd2Compare.osd2Base), linux2Bytes: osd2Compare.linux2Bytes,
      checked: osd2Compare.checked, mismatch: osd2Compare.mismatches,
      note: 'ext2_inode.osd2 是匿名联合，DWARF 产物只给联合起点；里面 l_i_frag/l_i_fsize/l_i_uid_high/l_i_gid_high 的排布从 C 源码的 linux2 现场解析',
    },
    widths: widths.map((row) => ({ ...row, ok: row.ours === row.dwarf })),
    ext2InodeInfo: {
      infoSize: infoFacts.infoSize, vfsInodeOffset: infoFacts.vfsOffset, vfsInodeType: infoFacts.vfsType,
      vfsInodeSize: infoFacts.inodeSize, iDataOffset: infoFacts.dataOffset, iDataBytes: infoFacts.dataBytes,
      iDataType: infoFacts.dataType, backshift: infoFacts.backshift,
    },
    missingTypes: layout.missing.map((entry) => entry.name),
  };
  check(
    'T07e-A3 我们手写的四张 ext2 偏移表与 DWARF 布局产物逐项一致（含 `ext2_inode` 的 `osd2` —— 它是匿名联合，'
      + '联合起点取 DWARF、内部排布现场从 C 源码算）',
    compareBad.length === 0 && osd2Compare.mismatches.length === 0
      && widthBad.length === 0
      && osd2Compare.checked.length === Object.keys(INODE_OSD2_FIELDS).length,
    `逐项一致：superblock ${sbCompare.checked.length} 项、group_desc ${gdCompare.checked.length} 项、`
      + `inode ${inodeCompare.checked.length} 项 + osd2 ${osd2Compare.checked.length} 项、dir_entry ${dirCompare.checked.length} 项`
      + `；结构宽度：${widths.map((row) => `${row.label}=${row.dwarf}`).join(' ')}`
      + `（不一致 ${compareBad.length + (osd2Compare.mismatches.length > 0 ? 1 : 0) + widthBad.length} 处）`
      + `${compareBad.length === 0 ? '' : `；${compareBad.flatMap((entry) => entry.mismatches).join(' | ')}`}`
      + `${osd2Compare.mismatches.length === 0 ? '' : `；${osd2Compare.mismatches.join(' | ')}`}`,
  );

  // ---------- A4 常量与源码现场重解析 ----------
  // 源码原文（`ext2hText` 等）在函数开头已经读过，这里直接用。

  const magicFromSource = evalDefineValue(magicText, 'EXT2_SUPER_MAGIC');
  const constantRows = [
    ['EXT2_SUPER_MAGIC', EXT2_SUPER_MAGIC, magicFromSource],
    ['EXT2_GOOD_OLD_REV', 0, evalDefineValue(ext2hText, 'EXT2_GOOD_OLD_REV')],
    ['EXT2_DYNAMIC_REV', 1, evalDefineValue(ext2hText, 'EXT2_DYNAMIC_REV')],
    ['EXT2_GOOD_OLD_FIRST_INO', 11, evalDefineValue(ext2hText, 'EXT2_GOOD_OLD_FIRST_INO')],
    ['EXT2_GOOD_OLD_INODE_SIZE', 128, evalDefineValue(ext2hText, 'EXT2_GOOD_OLD_INODE_SIZE')],
    ['EXT2_NAME_LEN', EXT2_NAME_LEN, evalDefineValue(ext2FsText, 'EXT2_NAME_LEN')],
    ['EXT2_DIR_PAD', 4, evalDefineValue(ext2hText, 'EXT2_DIR_PAD')],
    ['EXT2_DIR_ROUND', 3, evalDefineValue(ext2hText, 'EXT2_DIR_ROUND')],
    ['EXT2_NDIR_BLOCKS', EXT2_NDIR_BLOCKS, evalDefineValue(ext2hText, 'EXT2_NDIR_BLOCKS')],
    ['EXT2_N_BLOCKS', EXT2_N_BLOCKS, evalDefineValue(ext2hText, 'EXT2_N_BLOCKS')],
    ['EXT2_ROOT_INO', Number(EXT2_ROOT_INO), evalDefineValue(ext2hText, 'EXT2_ROOT_INO')],
    ['EXT2_INDEX_FL', EXT2_INDEX_FL, evalDefineValue(uapiFsText, 'FS_INDEX_FL')],
    ['EXT2_INCOMPAT_SUPP', EXT2_INCOMPAT_SUPP,
      (evalDefineValue(ext2hText, 'EXT2_FEATURE_INCOMPAT_FILETYPE') ?? 0)
      | (evalDefineValue(ext2hText, 'EXT2_FEATURE_INCOMPAT_META_BG') ?? 0)],
    ['EXT2_RO_COMPAT_SUPP', EXT2_RO_COMPAT_SUPP,
      (evalDefineValue(ext2hText, 'EXT2_FEATURE_RO_COMPAT_SPARSE_SUPER') ?? 0)
      | (evalDefineValue(ext2hText, 'EXT2_FEATURE_RO_COMPAT_LARGE_FILE') ?? 0)
      | (evalDefineValue(ext2hText, 'EXT2_FEATURE_RO_COMPAT_BTREE_DIR') ?? 0)],
  ];
  const constantBad = constantRows.filter(([, ours, fromSource]) => ours === null || ours !== fromSource);

  // `EXT2_DIR_REC_LEN` 不是常量，是一个宏：逐值跑一遍 0..300 才叫"验了语义"。
  const recLenBad = [];
  for (let nameLen = 0; nameLen <= 300; nameLen += 1) {
    if (ext2RecLen(nameLen) !== independentRecLen(nameLen)) {
      recLenBad.push(`name_len=${nameLen}: 我们 ${ext2RecLen(nameLen)} vs 独立重算 ${independentRecLen(nameLen)}`);
    }
  }
  const recLenMacroPresent = /#define\s+EXT2_DIR_REC_LEN\(name_len\)/.test(ext2hText);

  // `ext2AddrPerBlock(s)` = `EXT2_BLOCK_SIZE(s) / sizeof(__u32)`。
  const addrPerBlockRow = {
    ours: ext2AddrPerBlock(sb.blockSize),
    expected: sb.blockSize / 4,
    sourcePresent: /EXT2_ADDR_PER_BLOCK\(s\)\s*\(EXT2_BLOCK_SIZE\(s\)\s*\/\s*sizeof\s*\(__u32\)\)/.test(ext2hText),
  };

  // `ext2_block_to_path()` 的四段与告警串。
  const blockToPath = readBlockToPathSource(inodeCText);
  // 4096 字节块：ptrs=1024、直接 12、单间接 1024、双间接 1024²、三间接 1024³。
  // 三间接能表达的最大块号是 12+1024+1024²+1024³-1，再大内核就把它当出错。
  const lastTripleBlock = 12 + 1024 + 1024 * 1024 + 1024 * 1024 * 1024 - 1;
  const pathProbes = [0, 11, 12, 13, 12 + 1023, 12 + 1024, 12 + 1024 + 1024 * 1023,
    12 + 1024 + 1024 * 1024 - 1, 12 + 1024 + 1024 * 1024,
    lastTripleBlock, lastTripleBlock + 1, -1];
  const pathBad = [];
  const pathOutOfRange = [];
  for (const probe of pathProbes) {
    const ours = ext2BlockToPath(BigInt(probe), sb.blockSize);
    const mine = independentBlockToPath(probe, sb.blockSize);
    const sameOffsets = ours.offsets.length === mine.offsets.length
      && ours.offsets.every((value, index) => value === mine.offsets[index]);
    if (ours.outOfRange !== mine.outOfRange || (!ours.outOfRange && !sameOffsets)) {
      pathBad.push(`块 ${probe}: 我们 ${JSON.stringify(ours.offsets)}${ours.outOfRange ? '(越界)' : ''}`
        + ` vs 独立重算 ${JSON.stringify(mine.offsets)}${mine.outOfRange ? '(越界)' : ''}`);
    }
    if (ours.outOfRange) pathOutOfRange.push(probe);
  }
  // 两种越界各自对应源码里哪句话：负数那句在最前面（`block < 0`），太大那句在最后的 `else` 里。
  const outOfRangeKind = {
    negative: blockToPath?.negativeWarning ?? null,
    tooBig: blockToPath?.bigWarning ?? null,
    probesOutOfRange: pathOutOfRange,
    negativeOutOfRange: (() => {
      try {
        return ext2BlockToPath(-1n, sb.blockSize).outOfRange;
      } catch {
        return null;
      }
    })(),
    tooBigOutOfRange: ext2BlockToPath(BigInt(lastTripleBlock + 1), sb.blockSize).outOfRange,
  };

  // `FT_*` / `DT_*` / `fs_ftype_by_dtype`：现场重算 `modeToFileType()`。
  const ftValues = parseFtDefineValues(fsTypesText);
  const dtValues = parseDtDefineValues(fsTypesText);
  const ftypeByDtype = parseFtypeByDtypeTable(fsTypesCText);
  const ftRows = EXT2_FT_TYPES.map((entry) => {
    const fromSource = ftValues.get(entry.name.replace('EXT2_', '')) ?? null;
    return { name: entry.name, ours: entry.value, fromSource, ok: entry.value === fromSource };
  });
  const ftBad = ftRows.filter((row) => row.ok !== true);
  const dtypeBad = [];
  for (const entry of EXT2_FT_TYPES) {
    if (entry.mode === null) continue;
    const dtIndex = (entry.mode & 0o170000) >> 12;
    const dtName = [...dtValues.entries()].find(([, value]) => value === dtIndex)?.[0] ?? null;
    const expectedFt = dtName === null ? null : (ftypeByDtype?.get(dtName) ?? 'FT_UNKNOWN');
    const oursFt = entry.name.replace('EXT2_', '');
    if (expectedFt !== oursFt || modeToFileType(entry.mode) !== entry.value) {
      dtypeBad.push(`mode=0o${entry.mode.toString(8)} → S_DT=${dtIndex}(${dtName}) 表里是 ${expectedFt}，我们写 ${oursFt}/值 ${entry.value}`);
    }
  }
  if (modeToFileType(0o170000) !== 0) dtypeBad.push('S_IFMT 自身（0o170000）不是任何一种类型，应当得到 FT_UNKNOWN(0)');

  // `i_flags` 的 29 位：名字去掉 `EXT2_` 前缀换成 `FS_`，取值必须与 `uapi/linux/fs.h` 里那一条相同。
  const flagRows = EXT2_INODE_FLAGS.map((entry) => {
    const fsName = entry.name.replace(/^EXT2_/, 'FS_');
    const fromSource = readDefine(uapiFsText, fsName) === null ? null : evalDefineValue(uapiFsText, fsName);
    return { name: entry.name, fsName, ours: entry.masked, fromSource, ok: entry.masked === fromSource };
  });
  const flagBad = flagRows.filter((row) => row.ok !== true);

  // `formatExt2Mode()`：与脚本里另写的一份实现逐组合比（含 setuid/setgid/sticky 的边界）。
  const modeBad = [];
  for (const typeBits of [0o010000, 0o020000, 0o040000, 0o060000, 0o100000, 0o120000, 0o140000, 0]) {
    for (const special of [0, 0o4000, 0o2000, 0o1000]) {
      for (let perm = 0; perm <= 0o777; perm += 1) {
        const mode = typeBits | special | perm;
        if (formatExt2Mode(mode) !== independentModeText(mode)) {
          modeBad.push(`mode=0o${mode.toString(8)}: 我们 ${formatExt2Mode(mode)} vs 独立实现 ${independentModeText(mode)}`);
          if (modeBad.length > 5) break;
        }
      }
    }
  }

  // `ext2_check_folio()` 的六条出口：标签、原文错误串、出现顺序，一律现场从 dir.c 读。
  const folioExits = readCheckFolioExits(dirCText);
  const expectedExitReasons = {
    Eshort: 'rec_len is smaller than minimal',
    Ealign: 'unaligned directory entry',
    Enamelen: 'rec_len is too small for name_len',
    Espan: 'directory entry across blocks',
    Einumber: 'inode out of bounds',
    Eend: 'entry in directory #%lu spans the page boundary',
  };
  const exitBad = folioExits === null ? ['读不到 ext2_check_folio'] : Object.entries(expectedExitReasons)
    .filter(([label, reason]) => !String(folioExits.reasons[label] ?? '').startsWith(reason))
    .map(([label, reason]) => `${label}: 源码里是 ${JSON.stringify(folioExits.reasons[label])}，期望以 ${JSON.stringify(reason)} 开头`);
  const expectedOrder = ['Eshort', 'Ealign', 'Enamelen', 'Espan', 'Einumber'];
  const orderBad = folioExits !== null && folioExits.order.slice(0, 5).join(',') !== expectedOrder.join(',')
    ? `判据顺序 ${folioExits.order.join('>')} ≠ ${expectedOrder.join('>')}` : null;

  evidence.kernelConstants = {
    constants: constantRows.map(([name, ours, fromSource]) => ({ name, ours, fromSource, ok: ours === fromSource })),
    constantMismatch: constantBad.map(([name, ours, fromSource]) => `${name}: 我们 ${ours} vs 源码 ${fromSource}`),
    dirRecLen: { macroPresent: recLenMacroPresent, probes: 301, mismatch: recLenBad.slice(0, 10) },
    addrPerBlock: addrPerBlockRow,
    blockToPathSource: blockToPath,
    blockToPathProbes: pathProbes.length,
    blockToPathMismatch: pathBad,
    blockToPathOutOfRange: outOfRangeKind,
    fileTypes: { ft: ftRows, dtype: dtypeBad, ftypeByDtypeEntries: ftypeByDtype === null ? null : ftypeByDtype.size },
    inodeFlags: { rows: flagRows, mismatch: flagBad.map((row) => `${row.name}(${row.fsName}): 我们 ${hex(row.ours)} vs 源码 ${row.fromSource === null ? '（没这个宏）' : hex(row.fromSource)}`) },
    modeFormat: { probes: modeBad.length === 0 ? '全部组合一致' : modeBad.slice(0, 5), mismatch: modeBad.length },
    checkFolio: {
      reasons: folioExits === null ? null : folioExits.reasons,
      order: folioExits === null ? null : folioExits.order,
      hasZeroLengthNote: folioExits === null ? null : folioExits.hasZeroLengthNote,
      mismatch: exitBad, orderMismatch: orderBad,
    },
  };
  check(
    'T07e-A4 我们的常量与内核源码现场重解析一致：magic/GOOD_OLD 系列/NDIR/N_BLOCKS/ROOT_INO/NAME_LEN/DIR_PAD/DIR_ROUND/'
      + 'INCOMPAT_SUPP/RO_COMPAT_SUPP/FS_INDEX_FL；`EXT2_DIR_REC_LEN` 逐值验语义；`EXT2_ADDR_PER_BLOCK` 按源码算式重算；'
      + '`ext2_block_to_path` 四段与告警串现读现比；`FT_*`/`DT_*`/`fs_ftype_by_dtype` 重算 `modeToFileType`；'
      + '`i_flags` 29 位逐个对 `FS_*_FL`；`formatExt2Mode` 与另一份实现比对（含 setuid/setgid/sticky 边界）；'
      + '`ext2_check_folio` 六条出口的标签与原文错误串',
    constantBad.length === 0 && recLenBad.length === 0 && recLenMacroPresent
      && addrPerBlockRow.ours === addrPerBlockRow.expected && addrPerBlockRow.sourcePresent
     && blockToPath !== null && blockToPath.directBlocksDecl && blockToPath.doubleBlocksDecl
     && blockToPath.directSegment && blockToPath.indirectSegment && blockToPath.doubleSegment
     && blockToPath.tripleSegment
     && blockToPath.bigWarning === 'warning: %s: block is too big'
     && blockToPath.negativeWarning === 'warning: %s: block < 0'
     && outOfRangeKind.negativeOutOfRange === true && outOfRangeKind.tooBigOutOfRange === true
     && pathBad.length === 0
      && ftBad.length === 0 && dtypeBad.length === 0 && flagBad.length === 0
      && modeBad.length === 0
      && exitBad.length === 0 && orderBad === null
      && folioExits !== null && folioExits.hasZeroLengthNote === true,
    `常量 ${constantRows.length} 条不一致 ${constantBad.length}；DIR_REC_LEN 宏在=${recLenMacroPresent} 逐值 ${recLenBad.length} 处不一致；`
      + `ADDR_PER_BLOCK=${addrPerBlockRow.ours}（源码算式=${addrPerBlockRow.expected}）；`
      + `block_to_path 源码四段齐=${blockToPath === null ? '读不到' : [blockToPath.directSegment, blockToPath.indirectSegment, blockToPath.doubleSegment, blockToPath.tripleSegment].every(Boolean)}`
      + ` 告警串=${JSON.stringify([blockToPath?.negativeWarning, blockToPath?.bigWarning])}`
      + ` 越界探针=${JSON.stringify(outOfRangeKind.probesOutOfRange)} 探针 ${pathProbes.length} 个不一致 ${pathBad.length}；`
      + `FT 取值不一致 ${ftBad.length}、dtype 重算不一致 ${dtypeBad.length}、i_flags 位不一致 ${flagBad.length}、mode 打印不一致 ${modeBad.length}；`
      + `check_folio 出口不一致 ${exitBad.length}${orderBad === null ? '' : `/${orderBad}`}`
      + `${constantBad.length === 0 ? '' : `；常量问题：${constantBad.map(([name]) => name).join('/')}`}`
      + `${exitBad.length === 0 ? '' : `；出口：${exitBad.join(' | ')}`}`
      + `${flagBad.length === 0 ? '' : `；标志位：${flagBad.slice(0, 4).map((row) => row.name).join('/')}`}`,
  );

  return out;
}
// ---------------------------------------------------------------------------
// A 段续：inode / 目录项 / 路径 / 块映射 / 内容 / 契约 / 边界（全部离线）
// ---------------------------------------------------------------------------

async function diskTreeSection(evidence, offline) {
  const { source, sb, groupTable, imageBytes } = offline;
  const blockSize = sb.blockSize;
  const imageLength = BigInt(imageBytes.length);

  /** 跑一条 `debugfs -R` 并把它的 stderr banner 一起去掉后返回。 */
  const debugfs = (command) => sh(`debugfs -R ${shq(command)} ${shq(IMAGE)}`).text;

  /** 与 `ext2InodeLocation()` 的**另一份**实现：用 `/` 与 `%` 写，不用 `>>` 与 `&`。 */
  const independentLocation = (ino) => {
    const groupIndex = (ino - 1n) / sb.inodesPerGroup;
    const indexInGroup = (ino - 1n) % sb.inodesPerGroup;
    const groupByteOffset = indexInGroup * BigInt(sb.inodeSize);
    const group = groupTable.descriptors[Number(groupIndex)];
    const blockWithinTable = groupByteOffset / BigInt(blockSize);
    const block = group.inodeTable + blockWithinTable;
    const offsetInBlock = Number(groupByteOffset % BigInt(blockSize));
    return {
      groupIndex, indexInGroup, block, offsetInBlock,
      byteOffset: block * BigInt(blockSize) + BigInt(offsetInBlock),
    };
  };

  // ---------- 先从 e2fsprogs 取"盘上真的有谁"（不是从我们的解析器取） ----------

  const lsRoot = parseDebugfsLs(debugfs('ls -l /'));
  const lsData = parseDebugfsLs(debugfs('ls -l /data'));
  const byName = (entries, name) => entries.find((entry) => entry.name === name) ?? null;
  const dataEntry = byName(lsRoot, 'data');
  const lostFoundEntry = byName(lsRoot, 'lost+found');
  const helloEntry = byName(lsData, 'hello.txt');
  const probeEntry = byName(lsData, 'probe.bin');
  if (dataEntry === null || helloEntry === null || probeEntry === null) {
    throw new Error(`e2fsprogs 没列出预期的那几个名字：/ 里 ${lsRoot.length} 条、/data 里 ${lsData.length} 条`);
  }
  const helloIno = helloEntry.inode;
  const probeIno = probeEntry.inode;

  const helloInode = await readExt2Inode(source, sb, groupTable, helloIno);
  const probeInode = await readExt2Inode(source, sb, groupTable, probeIno);
  const dataInode = await readExt2Inode(source, sb, groupTable, dataEntry.inode);
  const rootInode = await readExt2Inode(source, sb, groupTable, EXT2_ROOT_INO);
  const dataDir = await readExt2Directory(source, sb, groupTable, dataInode);

  // ---------- A5 inode 定位：我们 vs `debugfs imap` vs 独立重算 vs dd 原始字节 ----------

  const locationTargets = [
    { label: '/（根目录）', ino: EXT2_ROOT_INO },
    { label: 'lost+found', ino: lostFoundEntry === null ? null : lostFoundEntry.inode },
    { label: '/data', ino: dataEntry.inode },
    { label: '/data/hello.txt', ino: helloIno },
    { label: '/data/probe.bin', ino: probeIno },
  ].filter((entry) => entry.ino !== null);
  const locationRows = [];
  for (const target of locationTargets) {
    const ours = ext2InodeLocation(sb, groupTable, target.ino);
    const imap = parseDebugfsImap(debugfs(`imap <${target.ino}>`));
    const mine = independentLocation(target.ino);
    const ddRaw = ddBytes(Number(ours.byteOffset), sb.inodeSize);
    const viaSource = await source.read(ours.byteOffset, sb.inodeSize);
    const bytesAgree = Buffer.compare(Buffer.from(ddRaw), Buffer.from(viaSource)) === 0;
    const rawMode = leU16(ddRaw, EXT2_INODE_FIELDS.mode);
    const ok = imap !== null
      && asBig(ours.groupIndex) === BigInt(imap.groupIndex)
      && asBig(ours.block) === imap.block
      && ours.offsetInBlock === imap.offsetInBlock
      && asBig(ours.block) === mine.block
      && ours.offsetInBlock === mine.offsetInBlock
      && asBig(ours.byteOffset) === mine.byteOffset
      && bytesAgree
      && rawMode !== 0
      && ours.spansBlock === false
      && asBig(ours.byteOffset) + BigInt(sb.inodeSize) <= imageLength;
    locationRows.push({
      label: target.label, ino: target.ino.toString(),
      ours: {
        groupIndex: ours.groupIndex.toString(), indexInGroup: ours.indexInGroup.toString(),
        block: hex(ours.block), offsetInBlock: ours.offsetInBlock, byteOffset: hex(ours.byteOffset),
        spansBlock: ours.spansBlock,
      },
      imap: imap === null ? null : { groupIndex: imap.groupIndex, block: hex(imap.block), offsetInBlock: imap.offsetInBlock },
      independent: { block: hex(mine.block), offsetInBlock: mine.offsetInBlock, byteOffset: hex(mine.byteOffset) },
      ddAgreesWithSource: bytesAgree,
      rawMode: hex(rawMode),
      ok,
    });
  }
  const locationBad = locationRows.filter((row) => row.ok !== true);
  evidence.inodeLocation = { rows: locationRows, mismatch: locationBad.map((row) => row.label) };
  check(
    'T07e-A5 inode 定位与 e2fsprogs 的 `debugfs imap`（它自己按 `ext2_get_inode()` 算）逐块组/块/块内偏移一致，'
      + '并且与脚本里另写的一份定位实现（用 `/`、`%`，不用 `>>`、`&`）也一致；算出来的**绝对字节偏移**处用 `dd` 切出的 '
      + `${EXT2_GOOD_OLD_INODE_SIZE} 字节与解析器读到的字节逐字节相同；每个 inode 都不跨块`,
    locationBad.length === 0 && locationRows.length === locationTargets.length && locationRows.length >= 4,
    locationRows.map((row) => `${row.label}(ino ${row.ino})=块 ${row.ours.block}/${row.ours.offsetInBlock}`
      + `${row.ours.offsetInBlock === row.imap?.offsetInBlock ? '' : `≠imap ${row.imap?.offsetInBlock}`}`
      + ` @${row.ours.byteOffset}`).join('；'),
  );

  // ---------- A6 inode 字段：我们 vs `debugfs stat` vs dd 原始字节 ----------

  const inodeFieldRows = [];
  for (const target of [
    { label: '/', facts: rootInode },
    { label: '/data', facts: dataInode },
    { label: '/data/hello.txt', facts: helloInode },
    { label: '/data/probe.bin', facts: probeInode },
  ]) {
    const facts = target.facts;
    const stat = parseDebugfsStat(debugfs(`stat <${facts.ino}>`));
    const ddRaw = ddBytes(Number(facts.location.byteOffset), sb.inodeSize);
    const rawFields = {
      mode: leU16(ddRaw, EXT2_INODE_FIELDS.mode),
      uid: leU16(ddRaw, EXT2_INODE_FIELDS.uid),
      gid: leU16(ddRaw, EXT2_INODE_FIELDS.gid),
      sizeLow: leU32(ddRaw, EXT2_INODE_FIELDS.size),
      dirAcl: leU32(ddRaw, EXT2_INODE_FIELDS.dirAcl),
      linksCount: leU16(ddRaw, EXT2_INODE_FIELDS.linksCount),
      blocks: leU32(ddRaw, EXT2_INODE_FIELDS.blocks),
      flags: leU32(ddRaw, EXT2_INODE_FIELDS.flags),
      block0: leU32(ddRaw, EXT2_INODE_FIELDS.block),
      block12: leU32(ddRaw, EXT2_INODE_FIELDS.block + 12 * 4),
    };
    const rows = [
      tripleRow('mode', facts.mode, rawFields.mode, stat?.mode ?? null, 'debugfs stat'),
      tripleRow('uid', facts.uid, rawFields.uid, stat?.uid ?? null, 'debugfs stat'),
      tripleRow('gid', facts.gid, rawFields.gid, stat?.gid ?? null, 'debugfs stat'),
      tripleRow('size', Number(facts.size), facts.isRegular
        ? Number(BigInt(rawFields.sizeLow) | (BigInt(rawFields.dirAcl) << 32n))
        : rawFields.sizeLow, stat?.size ?? null, 'debugfs stat'),
      tripleRow('linksCount', facts.linksCount, rawFields.linksCount, stat?.links ?? null, 'debugfs stat'),
      tripleRow('blocks(512B 扇区)', facts.blocks, rawFields.blocks, stat?.blockCount ?? null, 'debugfs stat'),
      tripleRow('block[0]', facts.block[0], rawFields.block0, stat === null ? null : (stat.blocks.map.get(0) ?? null), 'debugfs stat'),
    ];
    const bad = rows.filter((row) => row.ok !== true);
    const fsBlockCount = stat === null ? null : (stat.blocks.map.get(0) ?? null);
    inodeFieldRows.push({
      label: target.label, ino: facts.ino.toString(), modeText: facts.modeText, fileTypeName: facts.fileTypeName,
      size: facts.size.toString(), blocks: facts.blocks, blocksBytes: facts.blocksBytes,
      dirAcl: hex(rawFields.dirAcl), sizeHighUsed: facts.sizeHighUsed,
      allocations: facts.allocated, flags: hex(facts.flags), indexedDirectory: facts.indexedDirectory,
      block: facts.block.map((value) => value),
      block12: rawFields.block12,
      block12Agrees: facts.block[12] === rawFields.block12,
      statBlocks: stat === null ? null : { total: stat.total, indirect: stat.blocks.indirect },
      statTypeWord: stat === null ? null : stat.type,
      // 更强的交叉：e2fsprogs 是用**自己那套**代码从同一个 inode 里读出类型位的，
      // 它印出来的类型词（regular/directory/symlink）换算成类型位后必须与我们 i_mode 的高 4 位相同。
      statTypeBitsAgrees: stat !== null && stat.typeBits !== null
        && stat.typeBits === (facts.mode & 0o170000),
      statBlockCount512: stat === null ? null : stat.blockCount * 512,
      iBlocksBytesAgrees: stat !== null && stat.blockCount * 512 === facts.blocksBytes,
      firstBlockMatchesStat: fsBlockCount === null || asBig(facts.block[0]) === fsBlockCount,
      rows: rows.map((row) => ({ ...row, ours: jsonSafe(row.ours), raw: jsonSafe(row.raw), other: jsonSafe(row.other) })),
      mismatch: bad.map((row) => `${row.label}: 我们=${row.ours} dd=${row.raw} ${row.otherName}=${row.other}`),
      notes: facts.notes,
    });
  }
  const inodeFieldBad = inodeFieldRows.flatMap((row) => row.mismatch);
  const inodeExtraBad = inodeFieldRows.filter((row) => row.block12Agrees !== true
    || row.iBlocksBytesAgrees !== true || row.firstBlockMatchesStat !== true || row.allocations !== true
    || row.statTypeBitsAgrees !== true);
  evidence.inodes = inodeFieldRows;
  check(
    'T07e-A6 inode 字段三方一致（我们 vs `debugfs stat` vs `dd` 在那个绝对字节偏移切出的 128 字节）：'
      + 'mode/uid/gid/size/链接数/`i_blocks`（512 字节扇区口径）/首个块指针；`i_block[12]`（单间接）单独比一次；'
      + '`i_blocks × 512` 与 debugfs 的 Blockcount 对得上；debugfs 印出来的 `Type:` 词（它自己按那套代码判的）'
      + '换算成类型位后与我们 `i_mode` 的高 4 位相同；inode 位图说这四个 inode 都被占用',
    inodeFieldBad.length === 0 && inodeExtraBad.length === 0 && inodeFieldRows.length === 4,
    inodeFieldRows.map((row) => `${row.label}: ${row.modeText} size=${row.size} blocks=${row.blocks} block[0]=${row.block[0]}`
      + `${row.mismatch.length === 0 ? '' : `（不一致 ${row.mismatch.length}：${row.mismatch[0]}）`}`).join('；'),
  );

  // ---------- A7 目录项：我们 vs `debugfs ls -l` ----------

  const dirRows = [];
  for (const target of [
    { label: '/', ino: EXT2_ROOT_INO, fsEntries: lsRoot },
    { label: '/data', ino: dataEntry.inode, fsEntries: lsData },
  ]) {
    const inode = await readExt2Inode(source, sb, groupTable, target.ino);
    const directory = await readExt2Directory(source, sb, groupTable, inode);
    const ourPairs = directory.entries.filter((entry) => !entry.free)
      .map((entry) => `${entry.name}@${entry.inode}`).sort();
    const fsPairs = target.fsEntries.map((entry) => `${entry.name}@${entry.inode}`).sort();
    const setAgrees = ourPairs.length === fsPairs.length
      && ourPairs.every((value, index) => value === fsPairs[index]);
    // 每条目录项的 rec_len 累加起来必须正好铺满这块的有效字节。
    const fillBad = directory.blocks.filter((block) => {
      const sum = block.entries.reduce((total, entry) => total + entry.recLen, 0);
      return sum !== block.validBytes;
    }).map((block) => `${block.block}: 目录项 rec_len 和 ${block.entries.reduce((total, entry) => total + entry.recLen, 0)} ≠ 有效字节 ${block.validBytes}`);
    // 空闲槽的字节数要等于各空闲项 rec_len 之和；每条目录项的字节偏移要在有效范围内。
    const freeBad = directory.blocks.filter((block) => {
      const sum = block.entries.filter((entry) => entry.free).reduce((total, entry) => total + entry.recLen, 0);
      return sum !== block.freeBytes;
    }).map((block) => `${block.block}: 空闲槽统计不符`);
    const rangeBad = [];
    for (const block of directory.blocks) {
      for (const entry of block.entries) {
        if (entry.offsetInBlock < 0 || entry.offsetInBlock + entry.recLen > block.validBytes) {
          rangeBad.push(`${block.block}#${entry.offsetInBlock}+${entry.recLen}>${block.validBytes}`);
        }
      }
    }
    // 目录项里的 `file_type` 必须与那个 inode 的 `i_mode` 推出的一致（内核用 `fs_umode_to_ftype()` 写它）。
    const typeBad = [];
    for (const entry of directory.entries) {
      if (entry.free || entry.name === '.' || entry.name === '..') continue;
      const child = entry.inode === target.ino
        ? inode : await readExt2Inode(source, sb, groupTable, entry.inode);
      const expected = modeToFileType(child.mode);
      if (expected !== entry.fileType) {
        typeBad.push(`${entry.name}: 目录项写 ${entry.fileType}(${entry.fileTypeName})，inode 的 mode 推出 ${expected}`);
      }
    }
    // 每块都读到末尾、零 fault；名字字节用 dd 在那条目录项的绝对偏移 + 8 处独立切出来比。
    const nameBad = [];
    for (const entry of directory.entries.slice(0, 6)) {
      const raw = ddBytes(Number(entry.byteOffset), 8 + Math.max(entry.nameLen, 1));
      const ddInode = leU32(raw, EXT2_DIR_ENTRY_FIELDS.inode);
      const ddNameLen = raw[EXT2_DIR_ENTRY_FIELDS.nameLen];
      const ddName = Buffer.from(raw.subarray(EXT2_DIR_ENTRY_FIELDS.name, EXT2_DIR_ENTRY_FIELDS.name + ddNameLen)).toString('utf8');
      if (asBig(entry.inode) !== BigInt(ddInode) || ddNameLen !== entry.nameLen || ddName !== entry.name) {
        nameBad.push(`${entry.name}: 我们 inode=${entry.inode}/nameLen=${entry.nameLen}，dd 读出 inode=${ddInode}/nameLen=${ddNameLen}/name=${JSON.stringify(ddName)}`);
      }
    }
    dirRows.push({
      label: target.label, ino: target.ino.toString(), size: directory.size.toString(),
      logicalBlocks: directory.logicalBlocks, blockCount: directory.blocks.length, holes: directory.holes,
      blockNumbers: directory.blocks.map((block) => hex(block.block)),
      entries: directory.entries.length, realEntries: ourPairs.length,
      freeBytes: directory.blocks.reduce((total, block) => total + block.freeBytes, 0),
      faults: directory.faults.map((fault) => ({ label: fault.label, reason: fault.reason, offsetInBlock: fault.offsetInBlock })),
      reachedEnd: directory.blocks.map((block) => block.reachedEnd),
      ourPairs, fsPairs, setAgrees,
      fillBad, freeBad, nameBad, typeBad, rangeBad: rangeBad.length,
      fileTypesUsed: [...new Set(directory.entries.filter((entry) => !entry.free).map((entry) => `${entry.fileType}:${entry.fileTypeName}`))],
      notes: directory.notes,
    });
  }
  const dirBad = dirRows.filter((row) => row.setAgrees !== true || row.faults.length !== 0
    || row.reachedEnd.some((value) => value !== true) || row.fillBad.length !== 0
    || row.freeBad.length !== 0 || row.nameBad.length !== 0 || row.typeBad.length !== 0
    || row.rangeBad !== 0 || row.holes.length !== 0);
  evidence.directories = {
    dumpe2fs: { root: lsRoot, data: lsData },
    rows: dirRows,
    mismatch: dirBad.map((row) => row.label),
  };
  check(
    'T07e-A7 目录项与 `debugfs ls -l` 一一对应（名字 + inode 号，两个方向都比）：`/` 与 `/data` 两块真盘上 0 条 fault、'
      + '每块都读到目录大小的末尾（`reachedEnd`）、目录项 rec_len 恰好铺满有效字节、空闲槽字节数自洽、'
      + '目录项里的 file_type 与那个 inode 的 i_mode 推出的类型一致、名字字节能用 `dd` 在那条目录项的绝对偏移处独立读出来',
    dirBad.length === 0 && dirRows.length === 2 && dirRows.every((row) => row.realEntries > 0),
    dirRows.map((row) => `${row.label}: 我们 ${row.realEntries} 条 / debugfs ${row.fsPairs.length} 条（一致=${row.setAgrees}）`
      + ` 块=${row.blockNumbers.join(',')} fault=${row.faults.length} 空闲槽字节=${row.freeBytes}`).join('；'),
  );

  // ---------- A8 路径查找：逐段落到同一个 inode 上 ----------

  const pathCases = [
    { path: '/', resolved: true, chain: [`/:${EXT2_ROOT_INO}`] },
    { path: '/data', resolved: true, chain: [`/:${EXT2_ROOT_INO}`, `data:${dataEntry.inode}`] },
    { path: '/data/hello.txt', resolved: true, chain: [`/:${EXT2_ROOT_INO}`, `data:${dataEntry.inode}`, `hello.txt:${helloIno}`] },
    { path: '/data/probe.bin', resolved: true, chain: [`/:${EXT2_ROOT_INO}`, `data:${dataEntry.inode}`, `probe.bin:${probeIno}`] },
    { path: '/data/..', resolved: true, chain: [`/:${EXT2_ROOT_INO}`, `data:${dataEntry.inode}`, `..:${EXT2_ROOT_INO}`] },
    { path: '/data/nope', resolved: false, chain: [`/:${EXT2_ROOT_INO}`, `data:${dataEntry.inode}`], missing: 'nope', finalIno: dataEntry.inode },
  ];
  const pathRows = [];
  for (const probe of pathCases) {
    const resolution = await lookupExt2Path(source, sb, groupTable, probe.path);
    const chain = resolution.components.map((component) => `${component.name}:${component.ino}`);
    const chainAgrees = chain.length === probe.chain.length
      && chain.every((value, index) => value === probe.chain[index]);
    // 每一条走过的目录项都要能在盘上原样读出来（偏移 + inode 号 + 名字）。
    const entryBad = [];
    for (const component of resolution.components) {
      if (component.entryByteOffset === null) continue;
      const raw = ddBytes(Number(component.entryByteOffset), 8 + Math.max(component.name.length, 1));
      const ddInode = leU32(raw, EXT2_DIR_ENTRY_FIELDS.inode);
      const ddNameLen = raw[EXT2_DIR_ENTRY_FIELDS.nameLen];
      const ddName = Buffer.from(raw.subarray(8, 8 + ddNameLen)).toString('utf8');
      if (asBig(component.ino) !== BigInt(ddInode) || ddName !== component.name) {
        entryBad.push(`${component.name}: 组件说 ino=${component.ino}，盘上那条目录项 ino=${ddInode} name=${JSON.stringify(ddName)}`);
      }
    }
    const missingOk = probe.resolved === true
      ? resolution.missing === null && resolution.resolved === true
      : resolution.missing === probe.missing && resolution.resolved === false
        && asBig(resolution.inode.ino) === BigInt(probe.finalIno);
    const stepsOk = probe.resolved === false
      ? resolution.steps.length >= 1 && resolution.steps.at(-1).found === false
      : resolution.steps.every((step) => step.found === true);
    pathRows.push({
      path: probe.path, resolved: resolution.resolved, missing: resolution.missing,
      finalIno: resolution.inode.ino.toString(), chain, expectedChain: probe.chain,
      chainAgrees, missingOk, stepsOk, steps: resolution.steps.length,
      entryByteOffsets: resolution.components.map((component) => hexOrNull(component.entryByteOffset)),
      entryBad, notes: resolution.notes,
      ok: chainAgrees && missingOk && stepsOk && entryBad.length === 0,
    });
  }
  const pathBad = pathRows.filter((row) => row.ok !== true);
  evidence.paths = { rows: pathRows, mismatch: pathBad.map((row) => row.path) };
  check(
    'T07e-A8 路径查找逐段落到同一个 inode 上（起点是 `EXT2_ROOT_INO`=2，`.` 跳过、`..` 用下降过程记的父栈弹栈）：'
      + '`/`、`/data`、`/data/hello.txt`、`/data/probe.bin`、`/data/..` 全解析成功且每一段能在盘上原样读出那条目录项；'
      + '`/data/nope` 如实说"在 /data 里找不到 nope"并把 inode 停在 /data（不返回根、也不返回空）',
    pathBad.length === 0 && pathRows.length === pathCases.length
      && pathRows.some((row) => row.resolved === false),
    pathRows.map((row) => `${row.path}→${row.chain.join('/')}${row.resolved ? '' : `（缺 ${row.missing}，停在 ino ${row.finalIno}）`}`).join('；'),
  );

  // ---------- A9 文件偏移 → 盘面块 → LBA：我们 vs `debugfs bmap` ----------

  const mapCases = [
    { label: '/data/hello.txt 偏移 0', inode: helloInode, fileOffset: 0n, expectPath: 'direct' },
    { label: '/data/hello.txt 偏移 84（最后一个字节所在块）', inode: helloInode, fileOffset: 84n, expectPath: 'direct' },
    { label: '/data/probe.bin 偏移 0', inode: probeInode, fileOffset: 0n, expectPath: 'direct' },
    { label: '/data/probe.bin 第 11 块', inode: probeInode, fileOffset: 11n * BigInt(blockSize), expectPath: 'direct' },
    { label: '/data/probe.bin 第 12 块（第一个间接块）', inode: probeInode, fileOffset: 12n * BigInt(blockSize), expectPath: 'indirect' },
    { label: '/data/probe.bin 第 500 块', inode: probeInode, fileOffset: 500n * BigInt(blockSize), expectPath: 'indirect' },
    { label: '/data/probe.bin 第 511 块（最后一块）', inode: probeInode, fileOffset: 511n * BigInt(blockSize), expectPath: 'indirect' },
  ];
  const mapRows = [];
  for (const probe of mapCases) {
    const mapping = await mapExt2FileOffset(source, sb, probe.inode, probe.fileOffset);
    const blockIndex = probe.fileOffset / BigInt(blockSize);
    const fsBlock = parseDebugfsBmap(debugfs(`bmap <${probe.inode.ino}> ${blockIndex}`));
    const viaLba = await ext2FileOffsetToLba(source, sb, probe.inode, probe.fileOffset);
    const lbaSelfConsistent = mapping.lba !== null && mapping.byteOffset !== null
      && mapping.lba * BigInt(SECTOR_SIZE) === mapping.byteOffset - BigInt(mapping.offsetInBlock);
    const withinImage = mapping.byteOffset === null
      || (mapping.byteOffset >= 0n && mapping.byteOffset + BigInt(blockSize) <= imageLength);
    mapRows.push({
      label: probe.label, blockIndex: blockIndex.toString(),
      offsetInBlock: mapping.offsetInBlock,
      block: hexOrNull(mapping.block), fsBlock: hexOrNull(fsBlock),
      blockAgrees: asBig(mapping.block) === fsBlock,
      hole: mapping.hole, pathName: mapping.pathName, pathAgrees: mapping.pathName === probe.expectPath,
      indirectBlocks: mapping.indirectBlocks.map((value) => hex(value)),
      pointerByteOffset: hexOrNull(mapping.pointerByteOffset),
      blockValid: mapping.blockValid, lba: hexOrNull(mapping.lba),
      lbaSelfConsistent, withinImage,
      lbaAgreesWithStep: asBig(viaLba.lba) === asBig(mapping.lba),
    });
  }
  const mapBad = mapRows.filter((row) => row.blockAgrees !== true || row.pathAgrees !== true
    || row.lbaSelfConsistent !== true || row.withinImage !== true || row.blockValid !== true
    || row.lbaAgreesWithStep !== true || row.hole === true);

  // 整个文件的区间表：区间数、洞、用到的间接块。
  const helloMap = await readExt2BlockMap(source, sb, helloInode);
  const probeMap = await readExt2BlockMap(source, sb, probeInode);
  const readsBeforeProbe = source.reads.length;
  await readExt2BlockMap(source, sb, probeInode);
  const probeMapReads = source.reads.length - readsBeforeProbe;
  const extentsOf = (map) => map.extents.map((extent) => `${extent.startBlock}+${extent.blockCount}=>${extent.physicalStart}`);
  evidence.blockMap = {
    rows: mapRows,
    mismatch: mapBad.map((row) => row.label),
    helloTxt: {
      fileBlocks: helloMap.fileBlocks, scannedBlocks: helloMap.scannedBlocks, truncated: helloMap.truncated,
      extents: extentsOf(helloMap), indirectBlocks: helloMap.indirectBlocks.map((value) => hex(value)),
      holes: helloMap.holes.map((hole) => `${hole.startBlock}+${hole.blockCount}`),
    },
    probeBin: {
      fileBlocks: probeMap.fileBlocks, scannedBlocks: probeMap.scannedBlocks, truncated: probeMap.truncated,
      extents: extentsOf(probeMap), indirectBlocks: probeMap.indirectBlocks.map((value) => hex(value)),
      holes: probeMap.holes.map((hole) => `${hole.startBlock}+${hole.blockCount}`),
      readsFor512Blocks: probeMapReads,
    },
  };
  check(
    'T07e-A9 文件偏移 → 逻辑块 → 盘面块 → LBA 与 `debugfs bmap` 逐块一致：hello.txt 的 0/84 字节、probe.bin 的第 0/11/12/500/511 块；'
      + '第 12 块起走的是**单间接**（`i_block[12]` 指向间接块），路径名如实报 `direct`/`indirect`；'
      + '每个映射的 `lba × 512 === 数据块字节偏移`、块号落在文件系统数据区内、数据块整个落在镜像内',
    mapBad.length === 0 && mapRows.length === mapCases.length
      && mapRows.some((row) => row.pathName === 'indirect')
      && probeMap.fileBlocks === 512 && probeMap.truncated === false
      && extentsOf(helloMap).length === 1
      && extentsOf(probeMap).length === 2
      && probeMap.holes.length === 0 && probeMap.indirectBlocks.length === 1
      && probeMapReads <= 2,
    mapRows.map((row) => `${row.label}: 块 ${row.block}（debugfs ${row.fsBlock}，${row.pathName}）LBA ${row.lba}`).join('；')
      + `；probe.bin 区间 ${extentsOf(probeMap).join(' ')} 间接块 ${probeMap.indirectBlocks.map((value) => hex(value)).join(',')}`
      + `（解 512 个逻辑块只读了 ${probeMapReads} 次盘：同一个间接块被缓存住，不逐块重读）`,
  );

  // ---------- A10 内容：与生成脚本的公式重算逐字节比 ----------

  const recipe = readRootfsRecipe(fs.readFileSync(BUILD_ROOTFS, 'utf8'));
  const helloMapped = await mapExt2FileOffset(source, sb, helloInode, 0n);
  const helloBytesOnDisk = (await source.read(helloMapped.byteOffset, blockSize)).subarray(0, Number(helloInode.size));
  const helloRecipeAgrees = recipe.helloBytes !== null
    && helloBytesOnDisk.length === recipe.helloBytes.length
    && Buffer.compare(Buffer.from(helloBytesOnDisk), recipe.helloBytes) === 0;
  // 同一段字节再从 `debugfs bmap` 给的块号用 `dd` 独立取一遍（偏移不来自我们的映射）。
  const helloFsBlock = parseDebugfsBmap(debugfs(`bmap <${helloIno}> 0`));
  const helloBytesViaDd = helloFsBlock === null
    ? null : ddBytes(Number(helloFsBlock * BigInt(blockSize)), Number(helloInode.size));
  const helloDdAgrees = helloBytesViaDd !== null && recipe.helloBytes !== null
    && Buffer.compare(helloBytesViaDd, recipe.helloBytes) === 0;
  const probeBlockChecks = [];
  for (const index of [0, 1, 11, 12, 500, 511]) {
    const expected = expectedProbeBlock(recipe, index);
    const mapped = await mapExt2FileOffset(source, sb, probeInode, BigInt(index) * BigInt(blockSize));
    if (expected === null || mapped.byteOffset === null) {
      probeBlockChecks.push({ index, agrees: false, note: expected === null ? '期望值算不出来' : '映射是洞' });
      continue;
    }
    const onDisk = await source.read(mapped.byteOffset, blockSize);
    const agrees = Buffer.compare(Buffer.from(onDisk), expected) === 0;
    const firstLine = Buffer.from(onDisk.subarray(0, 28)).toString('utf8');
    probeBlockChecks.push({
      index, block: hex(mapped.block), agrees, firstLine,
      expectedFirstLine: Buffer.from(expected.subarray(0, 28)).toString('utf8'),
      bytes: blockSize,
    });
  }
  const probeBad = probeBlockChecks.filter((entry) => entry.agrees !== true);
  evidence.content = {
    recipe: {
      source: path.relative(ROOT, BUILD_ROOTFS),
      helloLiteral: recipe.helloLiteral,
      helloBytes: recipe.helloBytes === null ? null : recipe.helloBytes.length,
      probeCount: recipe.probeCount, probeTemplate: recipe.probeTemplate,
      probeLineBytes: recipe.probeLineBytes, probeFill: recipe.probeFill,
      mke2fsArgs: recipe.mke2fsArgs, truncateSize: recipe.truncateSize,
    },
    hello: {
      size: Number(helloInode.size), block: hex(helloMapped.block),
      ours: { text: Buffer.from(helloBytesOnDisk).toString('utf8'), bytes: helloBytesOnDisk.length, sha256: crypto.createHash('sha256').update(Buffer.from(helloBytesOnDisk)).digest('hex') },
      recipeAgrees: helloRecipeAgrees,
      viaDdBlockFromDebugfs: helloFsBlock === null ? null : hex(helloFsBlock),
      ddAgrees: helloDdAgrees,
    },
    probeBlocks: probeBlockChecks,
    mismatch: [
      ...(helloRecipeAgrees ? [] : ['hello.txt：盘上字节 ≠ build-rootfs.sh 的 printf 重算']),
      ...(helloDdAgrees ? [] : ['hello.txt：dd 在 debugfs 给的块号处读到的字节 ≠ 公式重算']),
      ...probeBad.map((entry) => `probe.bin 第 ${entry.index} 块不同`),
    ],
  };
  check(
    'T07e-A10 盘上内容与生成脚本按同一公式**独立重算**的期望字节逐字节相同：hello.txt（`build-rootfs.sh` 里那条 printf 的字面量'
      + '重新解码）与 probe.bin 的第 0/1/11/12/500/511 块（那个 python f-string 模板 + `ljust(4096, b\'.\')` 重新拼出来）；'
      + 'hello.txt 的字节还另用 `dd` 在 `debugfs bmap` 给出的块号处读过一遍（偏移不来自我们的映射）',
    helloRecipeAgrees && helloDdAgrees && probeBad.length === 0 && probeBlockChecks.length === 6
      && recipe.probeCount === 512 && recipe.probeLineBytes === blockSize,
    `hello.txt：盘上 ${helloBytesOnDisk.length} 字节，与公式重算一致=${helloRecipeAgrees}，`
      + `dd（块 ${helloFsBlock}）一致=${helloDdAgrees}；probe.bin 抽查 ${probeBlockChecks.length} 块，不一致 ${probeBad.length}`
      + `${probeBad.length === 0 ? '' : `：${probeBad.map((entry) => entry.index).join(',')}`}`,
  );

  // ---------- A11 契约与证据 ----------

  const evidenceChecks = [
    { label: '超级块', ref: sb.evidence, expectOffset: EXT2_SUPERBLOCK_OFFSET, expectLength: EXT2_SB_SIZE },
    { label: 'inode(/data/hello.txt)', ref: helloInode.evidence, expectOffset: helloInode.location.byteOffset, expectLength: sb.inodeSize },
    { label: '目录(/data)', ref: dataDir.evidence, expectOffset: dataDir.blocks[0]?.byteOffset ?? null, expectLength: null },
    { label: '目录块(/data 第 0 块)', ref: dataDir.blocks[0]?.evidence ?? null, expectOffset: dataDir.blocks[0]?.byteOffset ?? null, expectLength: blockSize },
  ];
  const evidenceBad = [];
  for (const entry of evidenceChecks) {
    if (entry.ref === null) { evidenceBad.push(`${entry.label}: 没有证据对象`); continue; }
    if (entry.ref.source !== 'disk') evidenceBad.push(`${entry.label}: source=${entry.ref.source}（应为 disk）`);
    const offsetRef = entry.ref.refs.find((text) => text.startsWith('offset:'));
    if (offsetRef === undefined) { evidenceBad.push(`${entry.label}: refs 里没有 offset:`); continue; }
    const match = /^offset:0x([0-9a-f]+):(\d+)$/.exec(offsetRef);
    if (match === null) { evidenceBad.push(`${entry.label}: offset 引用格式不认识（${offsetRef}）`); continue; }
    const offset = BigInt(`0x${match[1]}`);
    const length = Number(match[2]);
    if (entry.expectOffset !== null && offset !== BigInt(entry.expectOffset)) {
      evidenceBad.push(`${entry.label}: 证据偏移 ${offset} ≠ 事实里的偏移 ${entry.expectOffset}`);
    }
    if (entry.expectLength !== null && length !== entry.expectLength) {
      evidenceBad.push(`${entry.label}: 证据长度 ${length} ≠ ${entry.expectLength}`);
    }
    if (offset + BigInt(length) > imageLength) evidenceBad.push(`${entry.label}: 证据范围越出镜像`);
  }
  // inode facts 的证据偏移要落在镜像内；LBA 与字节偏移自洽（已在 A9 逐条验过，这里再抽样确认换算口径）。
  const lbaProbe = (await mapExt2FileOffset(source, sb, helloInode, 0n));
  const lbaProbeOk = lbaProbe.block !== null && lbaProbe.lba !== null
    && lbaProbe.lba === lbaProbe.block * BigInt(blockSize / SECTOR_SIZE);
  evidence.contract = {
    checks: evidenceChecks.map((entry) => ({
      label: entry.label,
      source: entry.ref?.source ?? null,
      refs: entry.ref?.refs ?? null,
      expectOffset: jsonSafe(entry.expectOffset),
    })),
    mismatch: evidenceBad,
    lbaProbe: { block: hexOrNull(lbaProbe.block), lba: hexOrNull(lbaProbe.lba), ok: lbaProbeOk },
    sectorSize: SECTOR_SIZE,
  };
  check(
    'T07e-A11 契约与证据如实：盘面事实的 `evidence.source` 一律是 `disk`（与内存侧的 `memory` 分得开），'
      + '证据里写的 `offset:0x…:长度` 与事实里的字节偏移/长度吻合、且不越出镜像；LBA 与数据块号按 512 字节扇区自洽换算',
    evidenceBad.length === 0 && lbaProbeOk && evidenceChecks.every((entry) => entry.ref !== null),
    `证据对象 ${evidenceChecks.length} 个，问题 ${evidenceBad.length}`
      + `${evidenceBad.length === 0 ? '' : `：${evidenceBad.join(' | ')}`}；`
      + `抽样：块 ${lbaProbe.block} → LBA ${lbaProbe.lba}（×${SECTOR_SIZE} 字节/扇区）`,
  );

  // ---------- A12 边界与错误码 ----------

  const captureError = async (label, run, expectedCode) => {
    try {
      await run();
      return { label, expected: expectedCode, code: null, thrown: false, isExt2: false, message: '（没有抛错：本该报错却没报）' };
    } catch (error) {
      return {
        label,
        expected: expectedCode,
        code: typeof error?.code === 'string' ? error.code : null,
        thrown: true,
        isExt2: error instanceof Ext2ParseError,
        message: String(error?.message ?? error).slice(0, 220),
      };
    }
  };
  /** 在共享的镜像缓冲上临时改几个字节 → 用新的来源读 → 立刻改回来，绝不留下坏字节。 */
  const withPatchedImage = async (patches, run) => {
    const saved = patches.map((patch) => ({
      offset: patch.offset, bytes: Buffer.from(imageBytes.subarray(patch.offset, patch.offset + patch.bytes.length)),
    }));
    for (const patch of patches) Buffer.from(patch.bytes).copy(imageBytes, patch.offset);
    try {
      const patched = new BufferDiskSource({ bytes: imageBytes });
      return await run(patched);
    } finally {
      for (const savedOne of saved) savedOne.bytes.copy(imageBytes, savedOne.offset);
    }
  };

  const boundaryCases = [];
  // magic 被改坏
  boundaryCases.push(await withPatchedImage(
    [{ offset: Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.magic, bytes: u16le(0x0000) }],
    async (patched) => {
      const corruptSb = await readExt2Superblock(patched);
      const row = await captureError('assertExt2Parseable(magic=0x0000)', () => {
        assertExt2Parseable(corruptSb);
      }, 'bad-magic');
      row.observations = { magicOk: corruptSb.magicOk, magic: hex(corruptSb.magic) };
      return row;
    },
  ));
  // INCOMPAT 里多一位内核不认识的（COMPRESSION = 0x0001）
  boundaryCases.push(await withPatchedImage(
    [{ offset: Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.featureIncompat, bytes: u32le(0x0001) }],
    async (patched) => {
      const corruptSb = await readExt2Superblock(patched);
      const row = await captureError('assertExt2Parseable(INCOMPAT 多 0x0001)',
        () => assertExt2Parseable(corruptSb), 'incompat-feature-unsupported');
      row.observations = { unsupportedIncompat: hex(corruptSb.unsupportedIncompat), parseable: corruptSb.parseable };
      const groupRow = await captureError('readExt2GroupDescriptors(INCOMPAT 多 0x0001)',
        () => readExt2GroupDescriptors(patched, corruptSb), 'incompat-feature-unsupported');
      row.alsoViaGroupDescriptors = groupRow.code;
      return row;
    },
  ));
  // 块大小不合理
  boundaryCases.push(await withPatchedImage(
    [{ offset: Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.logBlockSize, bytes: u32le(0xffffffff) }],
    async (patched) => {
      const corruptSb = await readExt2Superblock(patched);
      const row = await captureError('assertExt2Parseable(块大小 < 1024)',
        () => assertExt2Parseable(corruptSb), 'bad-block-size');
      row.observations = { blockSize: corruptSb.blockSize };
      return row;
    },
  ));
  boundaryCases.push(await captureError('ext2InodeLocation(ino=0)',
    () => ext2InodeLocation(sb, groupTable, 0n), 'bad-inode'));
  boundaryCases.push(await captureError('ext2InodeLocation(ino=块上 inode 总数+1)',
    () => ext2InodeLocation(sb, groupTable, sb.inodesCount + 1n), 'inode-out-of-range'));
  boundaryCases.push(await captureError('readExt2Inode(ino=0)',
    () => readExt2Inode(source, sb, groupTable, 0n), 'bad-inode'));
  boundaryCases.push(await captureError('readExt2Directory(普通文件 hello.txt)',
    () => readExt2Directory(source, sb, groupTable, helloInode), 'not-a-directory'));
  boundaryCases.push(await captureError('mapExt2FileOffset(偏移 = -1)',
    () => mapExt2FileOffset(source, sb, helloInode, -1n), 'negative-offset'));

  const codeBad = boundaryCases.filter((row) => row.code !== row.expected);
  const notExt2 = boundaryCases.filter((row) => row.isExt2 !== true && row.code !== null);

  // 目录块的六条出口：在**真盘的那一块**上逐条造坏，逐条核标签、原文错误串与报出的偏移。
  const firstEntry = dataDir.blocks[0].entries[0];
  const lastEntry = dataDir.blocks[0].entries.at(-1);
  const blockBase = Number(dataDir.blocks[0].byteOffset);
  const dirFaultCases = [
    { label: 'Eshort', patch: { offset: blockBase + firstEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.recLen, bytes: u16le(0) }, expectOffset: firstEntry.offsetInBlock, expectEntries: 0 },
    { label: 'Eshort（rec_len 小于最小但非 0）', patch: { offset: blockBase + firstEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.recLen, bytes: u16le(8) }, expectOffset: firstEntry.offsetInBlock, expectEntries: 0 },
    { label: 'Ealign', patch: { offset: blockBase + firstEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.recLen, bytes: u16le(13) }, expectOffset: firstEntry.offsetInBlock, expectEntries: 0 },
    { label: 'Enamelen', patch: { offset: blockBase + firstEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.nameLen, bytes: Buffer.from([40]) }, expectOffset: firstEntry.offsetInBlock, expectEntries: 0 },
    { label: 'Espan', patch: { offset: blockBase + firstEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.recLen, bytes: u16le(blockSize + 4) }, expectOffset: firstEntry.offsetInBlock, expectEntries: 0 },
    { label: 'Einumber', patch: { offset: blockBase + firstEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.inode, bytes: u32le(0xffffffff) }, expectOffset: firstEntry.offsetInBlock, expectEntries: 0 },
    {
      label: 'Eend',
      patch: {
        offset: blockBase + lastEntry.offsetInBlock + EXT2_DIR_ENTRY_FIELDS.recLen,
        bytes: u16le(blockSize - lastEntry.offsetInBlock - 4),
      },
      expectOffset: lastEntry.offsetInBlock + (blockSize - lastEntry.offsetInBlock - 4),
      expectEntries: dataDir.blocks[0].entries.length,
    },
  ];
  const dirFaultRows = [];
  for (const probe of dirFaultCases) {
    const row = await withPatchedImage([probe.patch], async (patched) => {
      const patchedSb = await readExt2Superblock(patched);
      const patchedGroups = await readExt2GroupDescriptors(patched, patchedSb);
      const patchedInode = await readExt2Inode(patched, patchedSb, patchedGroups, dataEntry.inode);
      const patchedDir = await readExt2Directory(patched, patchedSb, patchedGroups, patchedInode);
      const fault = patchedDir.faults[0] ?? null;
      return {
        label: probe.label,
        fault: fault === null ? null : { label: fault.label, reason: fault.reason, offsetInBlock: fault.offsetInBlock, recLen: fault.recLen, nameLen: fault.nameLen },
        entries: patchedDir.blocks[0]?.entries.length ?? null,
        offsetInBlock: fault?.offsetInBlock ?? null,
        expectedOffset: probe.expectOffset,
        expectedEntries: probe.expectEntries,
      };
    });
    const expectedLabel = probe.label.startsWith('Eshort') ? 'Eshort' : probe.label;
    const sourceReason = expectedLabel === 'Eend'
      ? 'entry in directory #%lu spans the page boundary'
      : (evidence.kernelConstants?.checkFolio?.reasons?.[expectedLabel] ?? null);
    row.labelOk = row.fault?.label === expectedLabel;
    row.reasonOk = row.fault !== null && sourceReason !== null
      && (expectedLabel === 'Eend'
        ? row.fault.reason === 'entry in directory spans the page boundary'
          && sourceReason.startsWith('entry in directory #%lu spans the page boundary')
        : row.fault.reason.startsWith(sourceReason));
    row.offsetOk = row.offsetInBlock === row.expectedOffset;
    row.entriesOk = row.entries === row.expectedEntries;
    dirFaultRows.push(row);
  }
  const dirFaultBad = dirFaultRows.filter((row) => row.labelOk !== true || row.reasonOk !== true
    || row.offsetOk !== true || row.entriesOk !== true);

  evidence.boundaries = {
    cases: boundaryCases,
    expected: Object.fromEntries(boundaryCases.map((row) => [row.label, row.expected])),
    codeMismatch: codeBad.map((row) => `${row.label}: 期望 ${row.expected} 实际 ${row.code}（${row.message}）`),
    notExt2: notExt2.map((row) => row.label),
    dirFaults: dirFaultRows,
    dirFaultMismatch: dirFaultBad.map((row) => row.label),
    note: '目录块那一组是在真盘 /data 的第 0 块上临时改字节触发，改完立刻改回来；判据（标签与原文错误串）现场从 fs/ext2/dir.c 的 ext2_check_folio() 读',
  };
  check(
    'T07e-A12 边界与错误码如实（每一条都是真调用触发，比对的是**具体**错误码，不是"有没有抛错"）：'
      + 'bad-magic / incompat-feature-unsupported / bad-block-size / bad-inode / inode-out-of-range / not-a-directory / negative-offset；'
      + '目录块的六条出口（Eshort/Ealign/Enamelen/Espan/Einumber/Eend）在真盘的那一块上逐条触发，'
      + '标签与原文错误串与 `fs/ext2/dir.c` 逐字对得上，报出的块内偏移也对（Eend 落在"已经放不下最短目录项"的位置）',
    codeBad.length === 0 && notExt2.length === 0 && boundaryCases.length === 8
      && boundaryCases.every((row) => row.thrown === true)
      && dirFaultBad.length === 0 && dirFaultRows.length === 7,
    boundaryCases.map((row) => `${row.label}→${row.code}`).join('；')
      + `；目录块出口：${dirFaultRows.map((row) => `${row.label}→${row.fault?.label}@${row.offsetInBlock}`).join('，')}`
      + `${codeBad.length === 0 ? '' : `；不一致：${codeBad.map((row) => row.label).join(' | ')}`}`
      + `${dirFaultBad.length === 0 ? '' : `；六条出口不一致：${dirFaultBad.map((row) => row.label).join(' | ')}`}`,
  );

  // 坏镜像副本：证明我们改的字节"在 e2fsprogs 眼里也是真的坏了"。
  const corruptPath = path.join(tmpdir(), `t07e-corrupt-${process.pid}.img`);
  try {
    fs.copyFileSync(IMAGE, corruptPath);
    const fdMagic = fs.openSync(corruptPath, 'r+');
    fs.writeSync(fdMagic, u16le(0x0000), 0, 2, Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.magic);
    fs.closeSync(fdMagic);
    const dumpe2fsBadMagic = sh(`dumpe2fs -h ${shq(corruptPath)}`);
    const fdRestore = fs.openSync(corruptPath, 'r+');
    fs.writeSync(fdRestore, u16le(EXT2_SUPER_MAGIC & 0xffff), 0, 2, Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.magic);
    fs.closeSync(fdRestore);
    const fdFeatures = fs.openSync(corruptPath, 'r+');
    // 只**或上** COMPRESSION(0x1)，不覆盖原有的 FILE_TYPE(0x2)：要验的是"多了一位不认识的"，
    // 而不是"把认识的位也删了"。真盘上的原值从盘面读，不写死。
    const originalIncompat = imageBytes.readUInt32LE(Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.featureIncompat);
    fs.writeSync(fdFeatures, u32le(originalIncompat | 0x0001), 0, 4, Number(EXT2_SUPERBLOCK_OFFSET) + EXT2_SB_FIELDS.featureIncompat);
    fs.closeSync(fdFeatures);
    const dumpe2fsFeatures = sh(`dumpe2fs -h ${shq(corruptPath)}`);
    // `sh()` 在命令失败时已经把 stdout 与 stderr 合进 `text`（e2fsprogs 的抱怨都打在 stderr）。
    const featuresText = String(dumpe2fsFeatures.text);
    // e2fsprogs 对"不认识的 INCOMPAT 位"的反应与内核一致：拒绝打开这份文件系统。
    // 这就是"这位真的是一位 e2fsprogs 也不认识的能力"的独立旁证 —— 不是我们一家在挑剔。
    const corruptCopyOk = dumpe2fsBadMagic.ok === false
      && /magic|Magic/.test(String(dumpe2fsBadMagic.text))
      && dumpe2fsFeatures.ok === false
      && /unsupported feature/i.test(featuresText);
    evidence.corruptCopy = {
      path: corruptPath,
      badMagic: { code: dumpe2fsBadMagic.code, tail: String(dumpe2fsBadMagic.text).trim().split('\n').slice(-3) },
      incompatPatched: {
        code: dumpe2fsFeatures.code,
        originalIncompat: hex(originalIncompat),
        patchedIncompat: hex(originalIncompat | 0x0001),
        tail: featuresText.trim().split('\n').slice(-3),
      },
      ok: corruptCopyOk,
    };
    check(
      'T07e-A12b 坏字节是"真的坏"而不是只有我们一家认为是坏的：把 magic 改掉之后连 `dumpe2fs -h` 都拒绝这份副本；'
        + '把 INCOMPAT 或上一位 `compression(0x1)`（原有的 filetype 位留着）之后，它同样拒绝打开这份文件系统 '
        + '—— e2fsprogs 与我们对"这位认不认识"的判断一致，改的确实是同一位真字节',
      corruptCopyOk,
      `magic 改坏后 dumpe2fs 退出码=${dumpe2fsBadMagic.code}（${evidence.corruptCopy.badMagic.tail.join(' / ')}）；`
        + `INCOMPAT ${evidence.corruptCopy.incompatPatched.originalIncompat} → ${evidence.corruptCopy.incompatPatched.patchedIncompat}`
        + ` 后退出码=${dumpe2fsFeatures.code}（${evidence.corruptCopy.incompatPatched.tail.join(' / ')}）`,
    );
  } finally {
    fs.rmSync(corruptPath, { force: true });
  }

  // 收尾：确认我们这一整段只读过镜像、没写过（散列与 A0 一致）。
  const afterSha = crypto.createHash('sha256').update(fs.readFileSync(IMAGE)).digest('hex');
  evidence.image.sha256AfterOffline = afterSha;
  check(
    'T07e-A12c 整段离线解析没有写过基座镜像：跑完 A 段后再算一遍 sha256，与开头算的一致',
    afterSha === offline.imageSha,
    `开头=${offline.imageSha.slice(0, 16)}… 现在=${afterSha.slice(0, 16)}…`,
  );

  // 交给 B 段的几个"已经确认过的"锚点：活体段要读同一份事实，不该在那边另算一遍或另抄一份数值。
  return {
    helloIno,
    probeIno,
    helloInode,
    probeInode,
    dataInode,
    dataEntryIno: dataEntry.inode,
    helloBlock: helloMapped.block,
    helloFileBlocks: helloMap.fileBlocks,
    probeFileBlocks: probeMap.fileBlocks,
  };
}
// ---------------------------------------------------------------------------
// B 段：活体（真启动一台 Linux，从"另一个来源"读同一份盘面事实）
// ---------------------------------------------------------------------------

/** `readelf -sW` 里的符号地址表（认领停点要找 `pcpu_hot` / `__per_cpu_offset`）。 */
function parseReadelfSymbols(text) {
  const addresses = new Map();
  const sizes = new Map();
  let duplicates = 0;
  for (const raw of text.split('\n')) {
    const match = /^\s*\d+:\s+([0-9a-f]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(raw);
    if (!match) continue;
    const name = match[7].trim();
    if (name.length === 0) continue;
    if (addresses.has(name)) { duplicates += 1; continue; }
    addresses.set(name, BigInt(`0x${match[1]}`));
    sizes.set(name, BigInt(match[2]));
  }
  return { addresses, sizes, duplicates };
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function liveSection(ctx) {
  const { app, registry, evidence, layout, offline } = ctx;
  const { sb, groupTable } = offline;
  const blockSize = sb.blockSize;

  const cmd = async (type, extra = {}) => call(app, 'POST', `/api/sessions/${ctx.session.id}/commands`, {
    requestId: `t07e-${++ctx.seq}-${type}`,
    epoch: ctx.live.epoch,
    expectedFrameId: ctx.live.frames.at(-1)?.frameId ?? 0,
    type,
    ...extra,
  });
  const captureFor = (frame) => new LiveCapture({
    app,
    base: ctx.base,
    sessionId: ctx.session.id,
    epoch: ctx.live.epoch,
    frameId: frame.frameId,
    captureId: frame.captureId,
    kernelRelease: layout.linuxRelease,
    symbols: ctx.symbols,
    sizes: ctx.sizes,
  });

  // ---------- B0 启动到交互提示符 ----------

  log('创建会话并启动（加载 vmlinux 符号、TCG 上跑真内核，约 1–2 分钟）...');
  const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
  if (created.status !== 201) throw new Error(`会话创建失败：${describe(created.body)}`);
  ctx.session = created.body;
  ctx.live = registry.get(ctx.session.id);
  ctx.base = `/api/sessions/${ctx.session.id}`;
  evidence.session = {
    id: ctx.session.id, profile: ctx.session.profile, epoch: ctx.live.epoch,
    qemu: ctx.live.process?.qemuPath ?? null,
  };
  const bootCont = await cmd('continue');
  if (bootCont.status !== 200) throw new Error(`continue（启动）失败：${describe(bootCont.body)}`);
  log('等待客体启动到交互提示符（最多 300 秒，TCG 上较慢）...');
  const bootText = await waitForTerminal(app, ctx.base, 300000);
  check('T07e-B0 客体真的启动到交互提示符（活体通道的前提）', PROMPT.test(bootText), `串口字节=${bootText.length}`);

  // ---------- B1 服务的磁盘视图 ----------

  const diskView = await call(app, 'GET', `${ctx.base}/disk`);
  const baseSha = diskView.body?.baseline?.sha256 ?? null;
  const localSha = crypto.createHash('sha256').update(fs.readFileSync(IMAGE)).digest('hex');
  evidence.diskView = {
    schema: diskView.body?.schema ?? null,
    diskId: diskView.body?.diskId ?? null,
    versionId: diskView.body?.versionId ?? null,
    visible: diskView.body?.visible ?? null,
    pending: diskView.body?.pending ?? null,
    notes: diskView.body?.notes ?? null,
    baseline: diskView.body?.baseline ?? null,
    localSha256: localSha,
    localBytes: fs.statSync(IMAGE).size,
  };
  check(
    'T07e-B1 服务的磁盘视图把两个来源分得很开：`baseline.sha256` 与本地重算的 `rootfs.img` 散列一致、字节数一致，'
      + '版本表（`visible`/`pending`）与盘面基线各是一份东西',
    diskView.status === 200 && diskView.body?.schema === 'oslab.disk/1'
      && baseSha === localSha && diskView.body?.baseline?.bytes === IMAGE_BYTES
      && Array.isArray(diskView.body?.visible) && Array.isArray(diskView.body?.pending)
      && typeof diskView.body?.diskId === 'string' && diskView.body.diskId.length > 0,
    `diskId=${diskView.body?.diskId} 基线 sha256=${String(baseSha).slice(0, 16)}… vs 本地 ${localSha.slice(0, 16)}… `
      + `（字节 ${diskView.body?.baseline?.bytes} vs ${IMAGE_BYTES}）；可见写 ${diskView.body?.visible?.length ?? '?'} 条、`
      + `未可见写 ${diskView.body?.pending?.length ?? '?'} 条`,
  );

  // ---------- B2 同一段 LBA：版本视图 vs 关闭镜像 ----------

  const helloInode = offline.helloInode;
  const probeIno = offline.probeIno;
  const helloIno = offline.helloIno;
  const helloBlock = offline.helloBlock;
  const lba = helloBlock * BigInt(blockSize / SECTOR_SIZE);
  const sectors = blockSize / SECTOR_SIZE;
  const diskRead = await call(app, 'GET', `${ctx.base}/disk?lba=${lba}&count=${sectors}`);
  const viewBytes = diskRead.status === 200 && typeof diskRead.body?.hex === 'string'
    ? Buffer.from(diskRead.body.hex, 'hex') : null;
  const imageSlice = fs.readFileSync(IMAGE).subarray(Number(lba) * SECTOR_SIZE, Number(lba) * SECTOR_SIZE + blockSize);
  const viewAgreesWithImage = viewBytes !== null && Buffer.compare(viewBytes, imageSlice) === 0;
  evidence.diskRead = {
    lba: lba.toString(), count: sectors,
    status: diskRead.status,
    schema: diskRead.body?.schema ?? null,
    fromBase: diskRead.body?.fromBase ?? null,
    evidenceSource: diskRead.body?.evidence?.source ?? null,
    evidenceKind: diskRead.body?.evidence?.kind ?? null,
    blobRef: diskRead.body?.blobRef ?? null,
    localSha256: crypto.createHash('sha256').update(imageSlice).digest('hex'),
    agreesWithImage: viewAgreesWithImage,
    tail: describe(diskRead.body),
  };
  check(
    'T07e-B2 同一段盘面（hello.txt 的数据块所在的 LBA 范围）：服务的**版本视图**给的字节与**关闭镜像**同一偏移的字节逐字节相同；'
      + '它自己如实标出这一段的来源是 `baseline-image`（`fromBase = true`），不是偷偷拿覆盖层或宿主文件顶替',
    viewAgreesWithImage && diskRead.body?.fromBase === true
      && diskRead.body?.evidence?.source === 'baseline-image'
      && diskRead.body?.schema === 'oslab.disk.read/1'
      && diskRead.body?.blobRef === crypto.createHash('sha256').update(imageSlice).digest('hex'),
    `LBA ${lba}（${sectors} 个扇区 = 1 个 ${blockSize}B 块）：版本视图 sha256=${String(diskRead.body?.blobRef).slice(0, 16)}…，`
      + `关闭镜像同一段 sha256=${crypto.createHash('sha256').update(imageSlice).digest('hex').slice(0, 16)}…；`
      + `fromBase=${diskRead.body?.fromBase} 来源=${diskRead.body?.evidence?.source}`,
  );

  // ---------- B3 客体自报（它自己从块设备读） ----------

  const recipe = readRootfsRecipe(fs.readFileSync(BUILD_ROOTFS, 'utf8'));
  const expectedMd5 = recipe.helloBytes === null ? null : md5(recipe.helloBytes);
  const blockMd5 = md5(imageSlice);
  const cursor = (await call(app, 'GET', `${ctx.base}/terminal`)).body?.text?.length ?? 0;
  await call(app, 'POST', `${ctx.base}/commands`, {
    requestId: `t07e-${++ctx.seq}-guestdisk`,
    epoch: ctx.live.epoch,
    expectedFrameId: ctx.live.frames.at(-1)?.frameId ?? 0,
    type: 'terminal.input',
    // 标记串在**命令里**拆成 `GUE""STDISK`：这样回显出来的那一行不含完整标记（回显里是
    // 带引号的原文），否则下面按标记切区间会先切到"回显"那一份、解析出空内容。
    // `--color=never` 是因为 busybox 的 `ls` 在 tty 上会给文件名套颜色转义，会和名字一起被读进来。
    text: `echo GUE""STDISK-BEGIN; stat -c "STAT %i %s %h %u %g %f" ${HELLO_FILE}; ls -i1 --color=never /data; `
      + `md5sum ${HELLO_FILE}; dd if=/dev/vda bs=${blockSize} skip=${helloBlock} count=1 2>/dev/null | md5sum; `
      + `echo GUE""STDISK-END\n`,
  });
  const region = await waitForTerminalMarker(app, ctx.base, 'GUESTDISK-END', 60000, cursor);
  // 兜底再剥一遍 ANSI 转义（提示符、颜色、光标控制都可能混在串口流里）。
  const clean = region.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const body = (clean.split('GUESTDISK-BEGIN')[1] ?? '').split('GUESTDISK-END')[0].replace(/^\r?\n/, '');
  const statLine = /STAT (\d+) (\d+) (\d+) (\d+) (\d+) ([0-9a-f]+)/.exec(body);
  const lsDataGuest = new Map();
  for (const match of body.matchAll(/^\s*(\d+)\s+(\S+)\s*$/gm)) lsDataGuest.set(match[2], BigInt(match[1]));
  const md5Lines = [...body.matchAll(/^([0-9a-f]{32})\s+(.*)$/gm)].map((match) => ({ digest: match[1], target: match[2].trim() }));
  const guestFileMd5 = md5Lines.find((entry) => entry.target === HELLO_FILE) ?? null;
  const guestBlockMd5 = md5Lines.find((entry) => entry.target === '-') ?? null;
  const guestIno = statLine === null ? null : BigInt(statLine[1]);
  const guestSize = statLine === null ? null : BigInt(statLine[2]);
  const guestNlink = statLine === null ? null : BigInt(statLine[3]);
  const guestMode = statLine === null ? null : Number.parseInt(statLine[6], 16);
  const lsAgrees = lsDataGuest.get('hello.txt') === helloIno && lsDataGuest.get('probe.bin') === probeIno;
  evidence.guestSelfReport = {
    command: `${HELLO_FILE} 的 stat/ls -i/md5sum 与 dd if=/dev/vda 的 md5sum`,
    region: body.slice(0, 1200),
    stat: statLine === null ? null : {
      ino: statLine[1], size: statLine[2], nlink: statLine[3], uid: statLine[4], gid: statLine[5], modeHex: statLine[6],
    },
    lsData: Object.fromEntries([...lsDataGuest].map(([name, ino]) => [name, ino.toString()])),
    md5Lines,
    guestFileMd5: guestFileMd5?.digest ?? null,
    guestBlockMd5: guestBlockMd5?.digest ?? null,
    expectedFileMd5: expectedMd5,
    expectedBlockMd5: blockMd5,
  };
  check(
    'T07e-B3 客体自己报得出同一份事实：壳里的 `stat -c`（inode 号/大小/链接数/mode）、`ls -i /data`、'
      + '`md5sum /data/hello.txt` 与公式重算的字节散列一致；`dd if=/dev/vda` 直接读**裸块设备**那一个块，'
      + '散列与关闭镜像同一块的散列一致（客体看到的就是我们解析的那张盘）',
    statLine !== null && guestIno === helloIno && guestSize === helloInode.size
      && guestNlink === BigInt(helloInode.linksCount)
      && guestMode !== null && guestMode === helloInode.mode
      && lsAgrees && guestFileMd5 !== null && guestFileMd5.digest === expectedMd5
      && guestBlockMd5 !== null && guestBlockMd5.digest === blockMd5,
    `客体 stat：ino=${guestIno}（我们 ${helloIno}）/ size=${guestSize}（我们 ${helloInode.size}）/ `
      + `nlink=${guestNlink}（我们 ${helloInode.linksCount}）/ mode=0o${guestMode === null ? '?' : guestMode.toString(8)}（我们 ${helloInode.modeText}）；`
      + `ls -i 一致=${lsAgrees}；文件 md5 ${String(guestFileMd5?.digest).slice(0, 12)}… vs 期望 ${String(expectedMd5).slice(0, 12)}…；`
      + `裸块设备 md5 ${String(guestBlockMd5?.digest).slice(0, 12)}… vs 关闭镜像 ${blockMd5.slice(0, 12)}…`,
  );

  // ---------- B4 内存侧 inode vs 盘面 inode（缓存与盘面两个来源） ----------

  const percpuHotLink = ctx.symbols.get('pcpu_hot') ?? null;
  const taskOffsets = {
    comm: layout.byteOffset('task_struct', 'comm'),
    pid: layout.byteOffset('task_struct', 'pid'),
    tgid: layout.byteOffset('task_struct', 'tgid'),
    mm: layout.byteOffset('task_struct', 'mm'),
    realParent: layout.byteOffset('task_struct', 'real_parent'),
    files: layout.byteOffset('task_struct', 'files'),
  };
  log(`停点：lab-read 停在 ext2_file_read_iter（读 ${HELLO_FILE}）...`);
  const claim = await claimWithRetry({
    app, base: ctx.base, live: ctx.live, cmd,
    symbol: 'ext2_file_read_iter',
    commandFor: (attempt) => `lab-read ${HELLO_FILE}; echo READ${attempt}""Y-DONE-$?\n`,
    markerFor: (attempt) => `READ${attempt}Y-DONE-`,
    inspect: async (frame) => {
      const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
      return { claimed: info.comm === 'lab-read', label: info.label, value: frame };
    },
  });
  if (claim.failed) {
    throw new Error(`没有等到 lab-read 停在 ext2_file_read_iter（尝试 ${claim.attempts.length} 次，帧总数 ${ctx.live.frames.length}）；`
      + `串口尾部=${await terminalTailOf(app, ctx.base)}`);
  }
  const frame = claim.frame;
  const capture = captureFor(frame);
  const view = new KernelMemoryView(capture);
  const current = await describeStoppedTask(capture, percpuHotLink, taskOffsets);
  const task = await readTask(view, layout, current.taskAddress);
  const files = await readFiles(view, layout, task.files ?? 0n);
  const chain = await readFileChain(view, layout, { files, fd: 3 });
  const memInode = chain.inode;
  if (memInode === null) throw new Error('fd 3 的 file 上取不到 inode（f_inode 为空）');

  // `container_of(inode, struct ext2_inode_info, vfs_inode)`：内存里那个 VFS inode 是**内嵌**在
  // ext2 私有结构里的，往回减 `offsetof(vfs_inode)` 就得到 ext2 私有结构的起点，`i_data` 在 +0。
  const vfsOffset = layout.byteOffset('ext2_inode_info', 'vfs_inode');
  const dataOffset = layout.byteOffset('ext2_inode_info', 'i_data');
  const ext2InfoBase = memInode.address - BigInt(vfsOffset);
  const memDataBytes = await capture.readVirtual(ext2InfoBase + BigInt(dataOffset), EXT2_N_BLOCKS * 4);
  const memBlock = [];
  for (let index = 0; index < EXT2_N_BLOCKS; index += 1) memBlock.push(leU32(memDataBytes, index * 4));
  const diskDataBytes = ddBytes(Number(helloInode.location.byteOffset) + EXT2_INODE_FIELDS.block, EXT2_N_BLOCKS * 4);
  const diskBlockRaw = [];
  for (let index = 0; index < EXT2_N_BLOCKS; index += 1) diskBlockRaw.push(leU32(diskDataBytes, index * 4));

  const inodePairs = [
    ['mode', memInode.mode, helloInode.mode],
    ['uid', memInode.uid, helloInode.uid],
    ['gid', memInode.gid, helloInode.gid],
    ['ino', Number(memInode.ino), Number(helloInode.ino)],
    ['size', Number(memInode.size), Number(helloInode.size)],
    ['nlink', memInode.nlink, helloInode.linksCount],
    ['blocks(512B 扇区)', Number(memInode.blocks), helloInode.blocks],
    ['flags', memInode.flags, helloInode.flags],
  ];
  const inodePairBad = inodePairs.filter(([, memory, disk]) => memory !== disk)
    .map(([name, memory, disk]) => `${name}: 内存=${memory} 盘面=${disk}`);
  const blockPointersAgree = memBlock.every((value, index) => value === helloInode.block[index])
    && diskBlockRaw.every((value, index) => value === helloInode.block[index]);
  evidence.memoryInode = {
    stop: {
      frameId: frame.frameId, captureId: frame.captureId, comm: current.comm, pid: current.pid,
      taskAddress: hex(current.taskAddress), rip: frame.cpu?.rip ?? null,
      breakpoint: claim.breakpoint, claimStops: claim.stops,
      captureReads: capture.reads, captureSources: [...capture.sources],
    },
    chain: {
      filesAddress: hex(task.files ?? 0n),
      fdSlotAddress: hex(chain.fdSlotAddress),
      fileAddress: hex(chain.file.address),
      fileInode: hexOrNull(chain.file.fInode),
      dentryAddress: chain.file.path.dentry === null ? null : hex(chain.file.path.dentry),
      inodeAddress: hex(memInode.address),
      path: chain.path?.text ?? null,
    },
    ext2Info: {
      vfsInodeOffset: vfsOffset, iDataOffset: dataOffset,
      base: hex(ext2InfoBase),
      basePlusVfsOffsetEqualsInode: ext2InfoBase + BigInt(vfsOffset) === memInode.address,
      memBlock: memBlock.map((value) => hex(value)),
      diskBlockOnDiskViaDd: diskBlockRaw.map((value) => hex(value)),
      diskBlockFromParser: helloInode.block.map((value) => hex(value)),
      pointersAgree: blockPointersAgree,
    },
    pairs: inodePairs.map(([name, memory, disk]) => ({ name, memory, disk, ok: memory === disk })),
    pairMismatch: inodePairBad,
    modeTextFromMemory: formatExt2Mode(memInode.mode),
    diskModeText: helloInode.modeText,
  };
  check(
    'T07e-B4 内存里那份 inode 与盘面上那份 inode 逐字段一致（mode/uid/gid/ino/size/nlink/`i_blocks`/`i_flags`）——'
      + '它们是同一个文件的两份字节；再从 `struct ext2_inode_info` 的 `vfs_inode` 位置往回推出 ext2 私有的 '
      + '`i_data[15]`（内存里 15 个块指针），与盘面 `i_block[15]` 以及 `dd` 在 inode 里那一处切出的 60 字节三个来源全一致',
    inodePairBad.length === 0 && blockPointersAgree
      && memBlock[0] === helloInode.block[0]
      && capture.reads > 0
      && current.comm === 'lab-read',
    `comm=${current.comm} pid=${current.pid} inode=${hex(memInode.address)}；`
      + `内存 i_data[0]=${hex(memBlock[0])} 与盘面 i_block[0]=${hex(helloInode.block[0])} 一致=${memBlock[0] === helloInode.block[0]}；`
      + `15 个指针三方全一致=${blockPointersAgree}；字段不一致 ${inodePairBad.length}`
      + `${inodePairBad.length === 0 ? '' : `：${inodePairBad.join(' | ')}`}`,
  );

  // ---------- B5a 离线校验在 VM 还在跑时必须被拒 ----------

  const offlineWhileRunning = await call(app, 'GET', `${ctx.base}/disk?mode=offline`);
  evidence.offlineWhileRunning = {
    status: offlineWhileRunning.status,
    code: offlineWhileRunning.body?.error?.code ?? null,
    message: offlineWhileRunning.body?.error?.message ?? null,
  };
  check(
    'T07e-B5a 会话还在跑的时候，离线校验接口明确拒绝（`control-busy`），而不是"顺手试一下"——'
      + '活跃的 qcow2 边写边读会得到不一致的内容，那种"校验通过"没有意义',
    offlineWhileRunning.status !== 200 && offlineWhileRunning.body?.error?.code === 'control-busy',
    `HTTP ${offlineWhileRunning.status} ${describe(offlineWhileRunning.body)}`,
  );

  await cmd('pause');
  const finalTail = await call(app, 'GET', `${ctx.base}/terminal`);
  evidence.terminalTail = String(finalTail.body?.text ?? '').slice(-1200);
  ctx.probeFrameId = ctx.live.frames.at(-1)?.frameId ?? 0;
  evidence.inode = {
    hello: inodeToJson(helloInode),
    probe: inodeToJson(offline.probeInode),
    data: inodeToJson(offline.dataInode),
  };
}

function inodeToJson(facts) {
  return {
    ino: facts.ino.toString(), mode: facts.mode, modeText: facts.modeText, fileTypeName: facts.fileTypeName,
    uid: facts.uid, gid: facts.gid, size: facts.size.toString(), linksCount: facts.linksCount,
    blocks: facts.blocks, flags: facts.flags, block: facts.block.map((value) => value),
    location: { block: facts.location.block.toString(), offsetInBlock: facts.location.offsetInBlock, byteOffset: facts.location.byteOffset.toString() },
    allocated: facts.allocated, notes: facts.notes,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const startedAt = new Date();
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t07e-evidence/1', startedAt: startedAt.toISOString() };
  const ctx = { app, registry, evidence, layout: null, offline: null, session: null, live: null, base: null, seq: 0, symbols: null, sizes: null, probeFrameId: 0 };

  try {
    if (!fs.existsSync(LAYOUT_PATH)) throw new Error(`找不到布局产物 ${LAYOUT_PATH}`);
    if (!fs.existsSync(IMAGE)) throw new Error(`找不到基座镜像 ${IMAGE}`);
    ctx.layout = KernelLayout.load(LAYOUT_PATH, { vmlinux: VMLINUX });
    evidence.layoutArtifact = {
      file: path.basename(LAYOUT_PATH),
      linuxRelease: ctx.layout.linuxRelease,
      buildId: ctx.layout.buildId,
      sha256: ctx.layout.sha256,
    };
    const parsed = parseReadelfSymbols(execFileSync('readelf', ['-sW', VMLINUX], {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    }));
    ctx.symbols = parsed.addresses;
    ctx.sizes = parsed.sizes;
    evidence.readelf = { symbols: ctx.symbols.size, duplicates: parsed.duplicates };

    log('A 段：离线读关闭后的镜像，并用 e2fsprogs / dd 原始字节 / 内核源码 / DWARF / 生成脚本做多通道交叉 ...');
    ctx.offline = await offlineSection(evidence, ctx.layout);
    // `diskTreeSection` 会把它确认过的几个锚点（两个文件的 inode、hello.txt 的数据块号）交回来，
    // 活体段直接用它们读同一份事实，而不是在那边另算一遍、另抄一份数值。
    Object.assign(ctx.offline, await diskTreeSection(evidence, ctx.offline));

    log('B 段：真启动一台 Linux，从服务的磁盘视图 / 客体自报 / 内存侧 inode 三个方向读同一份盘面事实 ...');
    await liveSection(ctx);
  } catch (error) {
    check('T07e 脚本异常', false, error.message);
    evidence.error = { message: error.message, stack: String(error.stack).slice(0, 2000) };
  } finally {
    if (ctx.session) {
      const closedByUs = await call(app, 'DELETE', `/api/sessions/${ctx.session.id}`);
      await sleep(1500);
      const leftover = countSessionProcesses(ctx.session.id);
      const afterClose = await call(app, 'GET', `/api/sessions/${ctx.session.id}/disk?lba=0&count=1`);
      check(
        'T07e-B5b 会话关闭成功、没有残留 QEMU/GDB 进程，而且关闭后连盘面接口都不再答（404 session-not-found，'
          + '而不是把缓存或另一个进程里的旧现场当成结果继续给）',
        closedByUs.status === 200 && closedByUs.body?.closed === true && leftover === 0
          && afterClose.status === 404 && afterClose.body?.error?.code === 'session-not-found',
        `${describe(closedByUs.body)}；残留进程数=${leftover}；关闭后再读盘面：HTTP ${afterClose.status} ${describe(afterClose.body)}`,
      );
    } else {
      check(
        'T07e-B5b 会话关闭成功、没有残留 QEMU/GDB 进程，而且关闭后连盘面接口都不再答（404 session-not-found）',
        false, '会话压根没建起来，无从关闭',
      );
    }
    // 整轮跑完再看一眼基座镜像：不管是 A 段的解析、B 段的活体会话还是会话关闭，
    // 都不该改动 `artifacts/rootfs.img` 一个字节。
    const finalSha = crypto.createHash('sha256').update(fs.readFileSync(IMAGE)).digest('hex');
    evidence.image = evidence.image ?? {};
    evidence.image.sha256AfterAll = finalSha;
    check(
      'T07e-B5c 整轮跑完基座镜像的散列没变：从 A 段解析到 B 段活体会话（含会话启动与关闭）全程只以只读方式碰它',
      evidence.image.sha256 !== undefined && finalSha === evidence.image.sha256,
      `${String(evidence.image.sha256).slice(0, 16)}… → ${finalSha.slice(0, 16)}…`,
    );
    await app.close();
    fs.rmSync(path.join(ROOT, 'scripts/__pycache__'), { recursive: true, force: true });
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.checks = results;
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(jsonSafe(evidence), null, 2)}\n`);
  fs.writeFileSync(EVIDENCE_LOG, `${logLines.join('\n')}\n`);

  const failed = results.filter((entry) => !entry.ok);
  log(`\n汇总：${results.length - failed.length}/${results.length} 通过，失败 ${failed.length} 项`);
  for (const entry of failed) log(`  未通过：${entry.id} :: ${entry.detail ?? ''}`);
  log(`证据：${path.relative(ROOT, EVIDENCE)}（日志 ${path.relative(ROOT, EVIDENCE_LOG)}）`);
  return failed.length;
}

main()
  .then((failed) => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
