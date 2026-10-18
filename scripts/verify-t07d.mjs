#!/usr/bin/env node
/**
 * T07d 验收：文件解析（task.files → fdtable → file → path/dentry/inode → address_space/folio）。
 *
 *   node scripts/verify-t07d.mjs        （约 10–20 分钟，TCG 上要真启动一台 Linux）
 *
 * 这一节要验的是"打开文件"这条链，而这条链上的错有一个共同特征：**错的结果照样
 * 是个合法对象**。
 *
 * - `files_struct` 里的内嵌 `fdtab` 与扩容后那份 `fdtable` 混着读，照样能读出一张
 *   看起来正常的 fd 表（`max_fds`、位图、fd 数组都在，只是内容是陈旧的）。
 * - `struct file` 的 `f_pos` 按 8 字节读还是按 4 字节读，读出来的"当前位置"都像个偏移；
 *   `f_path` 少读 8 字节，取出来的 dentry 会指向紧挨着的另一个真实指针。
 * - `dentry` 的名字有**两种存法**（内嵌 `d_iname` 与外部 `struct external_name`），
 *   判据是 `d_name.name != &d_iname`。判错方向的小名字也能读出个像名字的字符串。
 * - 页缓存不是数组也不是链表，是 **XArray**：`xa_head` 为 0 是"整个数组空"、
 *   `xa_head` 不是节点时它**本身就是下标 0 的条目**、条目里的指针低两位有含义
 *   （`(v<<1)|1` 是值、`(v<<2)|2` 是内部条目）、按 `node->shift` 的台阶下降。
 *   把 XArray 当成"指针数组"读，第一条就已经是另一件事了。
 *
 * 所以每一条断言都要靠**另一套独立机制**读同一份事实。本脚本用了六条互不相干的通道：
 *
 *   1. 解析器（`packages/linux-decoder/objects/files.ts`）：布局来自 T07a 的 DWARF 产物，
 *      字节来自服务的线性地址读。
 *   2. GDB 侧参照（`scripts/t07d-gdb-reference.py`）：类型/偏移/字段宽度/枚举取值全部由
 *      **GDB 自己的 DWARF 解释**给出（`&((struct file *)0)->f_path`、
 *      `sizeof(((struct qstr *)0)->len)`、`gdb.parse_and_eval('PG_dirty')`），
 *      `current` 走 **`%gs` 基址 + `pcpu_hot.current_task`**（我方走 `__per_cpu_offset[0]`），
 *      XArray 遍历**自己重写一遍**，名字的内嵌/外部也按源码判据自己判。
 *   3. **帧里的寄存器**：停在 `ext2_file_read_iter` 时 `rdi` 是 `struct kiocb *`，而
 *      `ki_filp` 是它的第一个成员 —— 于是"内核此刻要读的那个 file"有一份完全不经过
 *      我们 fd 表的来源；两者地址不同就说明 fd 表读错了位置。
 *   4. **QEMU 的 HMP** `x/gx`（宿主侧直接按当前 CPU 的页表读内存）：`struct file` 与
 *      `i_pages` 的头几个字由第三种读内存实现给出，不是我们的采集器、也不是 GDB。
 *   5. **内核源码现场重解析**：`include/linux/fs.h` 的 `FMODE_*`/`I_*`、
 *      `include/linux/dcache.h` 的 `DCACHE_*`/`DCACHE_ENTRY_TYPE`、
 *      `include/uapi/asm-generic/fcntl.h` 的 `O_*`、`include/uapi/linux/stat.h` 的 `S_IF*`、
 *      `include/linux/kdev_t.h` 的 `MINORBITS`、`include/linux/xarray.h` 的
 *      `xa_mk_value`/`xa_mk_internal`/`xa_is_node`/`xa_is_sibling`/`XA_CHUNK_SHIFT`、
 *      `include/linux/fdtable.h` 的 `NR_OPEN_DEFAULT`、`include/linux/page-flags.h` 的
 *      `PAGE_MAPPING_*` —— 全部现读现比，不抄一份常量进脚本。
 *   6. **客体自报**：同一台客体上另一个进程用真实系统调用拿到的同一份事实 ——
 *      `stat` 报的 `st_dev/st_ino/st_size/st_mode`、`/proc/<pid>/fdinfo/<fd>` 报的
 *      `pos`（就是 `f_pos`）、`readlink /proc/<pid>/fd/<fd>` 报的路径，
 *      以及 `lab-read` 自己读出来并写回串口的文件内容。
 *
 * 唯一停点：`ext2_file_read_iter` + `current.comm == lab-read`，全部用**软件断点**
 * （理由同 T07b/T07c：内核在任务切换时会按任务调试状态重写 DR0/DR7，硬件断点会静默失效）。
 * 客体此时刚 `open("/data/hello.txt")` 拿到 fd 3、`read()` 刚进内核还没读，
 * 所以 `f_pos` 应当是 0，而页缓存里还没有这一页 —— 这两个"应该是什么"都要先立住，
 * 后面读出来的东西才算对得上。
 *
 * 检查项：
 *   V1a 布局产物与现场 vmlinux 绑定（build ID + sha256 现场重算）；客体内核 release 一致
 *   V1b 必需类型一个不缺；T07d 用到的 14 个结构宽度与 GDB 的 `sizeof` 逐项一致
 *   V1c 符号事实三方一致（readelf vs 服务）：pcpu_hot/__per_cpu_offset/init_task/ext2_file_read_iter
 *   V1d 客体自己编进去的配置（/proc/config.gz）与本地构建配置一致（条件位判定才有依据）
 *   V0  停点落在 lab-read 的 `ext2_file_read_iter`；且 `rdi → ki_filp` 的 file 地址与
 *       fd 表里 fd 3 的槽值相同（寄存器通道 vs 解析器）
 *   V2  current/files 三源一致；`files_struct` 逐字段与 GDB 一致（含走的是内嵌 fdtab 还是扩容表）
 *   V3  fd 位图：打开的 fd 集合逐位与 GDB 相同；`openCount` 相同；`full_fds_bits` 语义与
 *       `fs/file.c` 的用法一致（它按"open_fds 的字号"分位，不是按 fd 分位）
 *   V4  `struct file` 逐字段与 GDB 一致，且 **HMP `x/gx` 读到的原始字**与我们的值相同；
 *       `f_mode` 解出的名字与源码 `FMODE_*` 一致；`f_flags` 的访问模式是 O_RDONLY
 *   V5  `dentry` 逐字段与 GDB 一致；名字的内嵌/外部判据按源码 `dname_external()`；
 *       名字文本就是 `hello.txt`；`d_flags` 解码与 `dcache.h` 一致（含三位类型字段）
 *   V6  路径从根往下拼出 `/data/hello.txt`：与我们、GDB、客体 `readlink` 三处相同；
 *       且没有环、没有截断
 *   V7  `inode` 逐字段与 GDB 一致；`i_mode` 是普通文件且权限 644；
 *       `i_ino`/`i_size`/`i_mode` 与客体 `stat` 报的完全相同
 *   V8  `super_block` 逐字段与 GDB 一致；`s_magic` 等于源码 `EXT2_SUPER_MAGIC`；
 *       `s_dev` 与客体 `stat` 的 `%d` 相同；`s_blocksize` = 4096
 *   V9  `address_space` 逐字段与 GDB 一致；`host` 就是那个 inode；
 *       `f_mapping == i_mapping == 这个 address_space`
 *   V10 页缓存这棵 XArray 与 GDB 自己重写的遍历逐项一致（头形态、条目下标集合、
 *       每个条目的 kind/pointer/span/slot/shift、节点地址集合）
 *   V11 页缓存条目 → `struct page` → folio：`mapping` 等于 `file->f_mapping`、
 *       `index` 等于该条目下标、不是匿名页；pfn 由 vmemmap 现场解出；
 *       契约 `pageCacheFolioRef` 的 `fileOffset` 是字节口径
 *   V12 位表与内核源码现场重解析逐项一致（FMODE 系列、I_ 系列、DCACHE 系列、
 *       O_ 系列、MINORBITS、S_IFMT、PAGE_MAPPING 系列、NR_OPEN_DEFAULT、XA_CHUNK_SHIFT）
 *   V13 XArray 编码与源码函数体逐条一致（`xa_mk_value` 是 `<<1|1`、`xa_to_node` 是"减 2"、
 *       `xa_is_node` 的 4096 分界、`xa_is_sibling` 的上界）；现场这棵树里没有 retry/zero 条目
 *   V14 契约 `toFileRef` 诚实：fd/地址/offset/路径/inode 号/设备号/大小/引用数与结构字段对应
 *   V15 边界与错误码：null-files/null-fdt/null-fdtable/null-file/null-dentry/null-inode/
 *       null-superblock/fd-not-open/fd-out-of-range 各自的 code 与 message 如实
 *   V16 会话关闭且无残留 QEMU/GDB 进程
 *
 * 结果写入 `artifacts/verify/t07d.json` 与 `artifacts/verify/t07d.log`。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../services/lab-server/main.mjs';
import {
  CaptureReadError,
  DCACHE_ENTRY_TYPE_MASK,
  DCACHE_ENTRY_TYPE_SHIFT,
  DENTRY_ENTRY_TYPES,
  DENTRY_FLAG_BITS,
  FMODE_BITS,
  FilesParseError,
  INODE_DIRTY_ALL_MASK,
  INODE_DIRTY_MASK,
  INODE_FILE_TYPES,
  INODE_STATE_BITS,
  KernelLayout,
  KernelMemoryView,
  MINORBITS,
  O_ACCMODE,
  O_COMPOSITE_FLAGS,
  O_FLAG_BITS,
  PAGE_FLAG_NAMES,
  PAGE_SHIFT,
  S_IFMT,
  XA_CHUNK_SHIFT,
  XA_RETRY_ENTRY,
  XA_ZERO_ENTRY,
  decodeDentryFlags,
  decodeFlagBits,
  decodeInodeMode,
  decodeOpenFlags,
  describeDevice,
  describeXaEntry,
  dedupedManifest,
  listOpenFds,
  pageAddressForPfn,
  pageCacheFolioRef,
  pageMappingKind,
  pfnForPageAddress,
  readAddressSpace,
  readDentry,
  readFdBitmaps,
  readFdtable,
  readFile,
  readFileChain,
  readFiles,
  readFilesForTask,
  readInode,
  readPageCache,
  readSuperBlock,
  readTask,
  readXaNode,
  readXarrayEntry,
  resolveDentryPath,
  resolveVmemmapBase,
  toFileRef,
  u64,
  walkXarray,
  xaErr,
  xaIsNode,
  xaIsRetry,
  xaIsSibling,
  xaIsValue,
  xaIsZero,
  xaMkInternal,
  xaMkValue,
  xaToInternal,
  xaToValue,
} from '../packages/linux-decoder/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VMLINUX = path.join(ROOT, 'artifacts/build/linux/vmlinux');
const LAYOUT_PATH = path.join(ROOT, 'artifacts/layout/linux-6.12.112-observatory-f5e5edc1c572.json');
const REFERENCE_PY = path.join(ROOT, 'scripts/t07d-gdb-reference.py');
const KERNEL_CONFIG = path.join(ROOT, 'labs/linux-x86_64/kernel.config');
const ROOTFS_IMG = path.join(ROOT, 'artifacts/rootfs.img');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t07d.json');
const EVIDENCE_LOG = path.join(ROOT, 'artifacts/verify/t07d.log');

/** 第 5 条通道要现场重解析的内核源码（全部只读，改了它们就是改了判据）。 */
const SRC = path.join(ROOT, 'src/linux-6.12.112');
const FS_H = path.join(SRC, 'include/linux/fs.h');
const DCACHE_H = path.join(SRC, 'include/linux/dcache.h');
/**
 * `dname_external()` 的判据在 6.12 里**不在头文件里**，而是 `fs/dcache.c` 里的
 * `static inline int dname_external()`（`dentry->d_name.name != dentry->d_iname`）。
 * 只扫头文件会得到一个"看起来很正常"的 false —— 而 false 恰好是最常见的真实情况
 * （短名字都内嵌），错得毫无征兆，所以两份都要扫。
 */
const DCACHE_C = path.join(SRC, 'fs/dcache.c');
const FCNTL_H = path.join(SRC, 'include/uapi/asm-generic/fcntl.h');
const STAT_H = path.join(SRC, 'include/uapi/linux/stat.h');
const KDEV_T_H = path.join(SRC, 'include/linux/kdev_t.h');
const XARRAY_H = path.join(SRC, 'include/linux/xarray.h');
const FDTABLE_H = path.join(SRC, 'include/linux/fdtable.h');
const PAGE_FLAGS_H = path.join(SRC, 'include/linux/page-flags.h');
const FILE_C = path.join(SRC, 'fs/file.c');
const EXT2_H = path.join(SRC, 'fs/ext2/ext2.h');
const MAGIC_H = path.join(SRC, 'include/uapi/linux/magic.h');
/** `CONFIG_BASE_SMALL` 在 x86_64 上默认关，`XA_CHUNK_SHIFT` 走 6 那一支；这里要现场读它。 */
const CONFIGS = path.join(ROOT, 'labs/linux-x86_64/kernel.config');

/** 客体里那个待读文件。它来自 `scripts/build-rootfs.sh` 的 ext2 镜像，不是内存里的。 */
const LAB_FILE = '/data/hello.txt';

const PROMPT = /linux-lab:[^\r\n]*# /;
/** 认领停点时最多重新 continue 多少次、每次最多等多久。 */
const MAX_STOPS = 900;
const CLAIM_BUDGET_MS = 300000;

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

/** `hex()` 的空值安全版：GDB 侧读不到的字段是 `null`，不该让一次"读不到"炸掉整轮验收。 */
function hexOrNull(value) {
  return value === null || value === undefined ? null : hex(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 证据里可能混着 bigint（地址、flags），JSON 序列化前统一转十进制字符串。 */
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

/**
 * 读取 JSON，但**不让大整数掉进双精度陷阱**（理由与实现同 T07b/T07c）。
 *
 * GDB 侧对照数据里的内核地址全在 `0xffff…` 量级（约 1.8e19），一落进 JS 的 `number`
 * 就被就近取整成几百字节外的另一个地址，症状是"地址集合差了几个"而 pid 之类小整数完好，
 * 极容易被误判成符号解析错乱。做法是把字符串之外 ≥16 位的整数字面量加引号再交给
 * `JSON.parse`，它们以十进制字符串的身份完整抵达，`BigInt()` 一取就是精确值。
 */
function parseBigJson(text) {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === '\\') { out += text[index + 1] ?? ''; index += 2; continue; }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') { inString = true; out += char; index += 1; continue; }
    if (char >= '0' && char <= '9') {
      let end = index;
      while (end < text.length && text[end] >= '0' && text[end] <= '9') end += 1;
      const digits = text.slice(index, end);
      const before = text[index - 1];
      const after = text[end];
      const touched = after === '.' || after === 'e' || after === 'E' || /[0-9A-Za-z_.]/.test(before ?? '');
      if (!touched && digits.length >= 16) {
        const negative = before === '-' && !/[0-9A-Za-z_.]/.test(text[index - 2] ?? '');
        if (negative) out = out.slice(0, -1);
        out += `"${negative ? '-' : ''}${digits}"`;
      } else {
        out += digits;
      }
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return JSON.parse(out);
}

/** 把 GDB 侧对照值取成 `BigInt`；`null` 原样返回（`BigInt(null)` 会抛异常）。 */
function refBig(value) {
  return value === null || value === undefined ? null : BigInt(value);
}

/** 跨通道比较用：`0x…`/十进制/bigint/number 统一成 `bigint | null`。 */
function asBig(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
}

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
 * 等串口出现标记。
 *
 * `marker` 必须**不可能**出现在"命令行的回显"里，否则等待会立刻返回、断言变成空转。
 * 调用方传入的标记所以都写成 `PRO""BE-END` 这种**成对的空引号**形式：回显里是
 * `PRO""BE-END`，而真正的输出是 `PROBE-END`。引号必须成对，否则 shell 会停在 PS2
 * 续行提示符上等输入，命令根本不执行（T07b 踩过这个坑）。
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
 * 认领循环的**全局**请求序号。服务端按 `requestId` 幂等，重复的 `requestId` 会把首次
 * 结果原样返回、且跳过新鲜度检查 —— 那样 `terminal.input` 会被"缓存命中"短路掉，
 * 命令根本送不进客体。所以整轮运行内必须唯一。
 */
let claimSeq = 0;

/**
 * 反复"装断点 → 递命令 → 认领停点"，直到认领成功（或尝试次数用完）。
 *
 * 为什么必须重试（T07b 实测出来的事实）：断点是"先装、后由客体里的另一个进程去触发"的，
 * 两次之间隔着一次 `execve`，而 `execve` 会换掉地址空间、重置线程状态，GDB 把 `int3`
 * 补回内核文本这一步有概率失败 —— 断点静默消失：GDB 不报错、QEMU 不报错，症状只是
 * "命令明明跑完了、串口上输出都对，却一次都没停"。所以每次尝试都**重新装**一遍。
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
    // 基线帧号必须在 `continue` **之前**取：`continue` 之后可能立刻停一次
    // （上一次停点把某个进程中断在系统调用中间，它接着跑完、正好撞上新断点）。
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
        requestId: `t07d-claim-${++claimSeq}-${attempt}-${symbol}`,
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

/** 从 `readelf -sW` 输出里取符号地址与大小（第三条独立来源）。 */
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

function parseBuildId(text) {
  const match = /Build ID:\s*([0-9a-f]+)/i.exec(String(text));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// 通道一：解析器用的字节从哪来（服务的线性地址读）
// ---------------------------------------------------------------------------

let captureReadSeq = 0;

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
      requestId: `t07d-capture-${this.attribution.frameId}-${++captureReadSeq}`,
      epoch: this.attribution.epoch,
      expectedFrameId: this.attribution.frameId,
      type: 'memory.read',
      mode: 'read',
      addressSpace: 'linear',
      address: text,
      length,
    });
    if (response.status !== 200 || typeof response.body?.hex !== 'string') {
      throw new CaptureReadError(
        'capture-read-failed',
        `读线性地址 ${text}+${length} 失败：${describe(response.body)}`,
        { address: text, length, captureId: this.attribution.captureId },
      );
    }
    const bytes = Buffer.from(response.body.hex, 'hex');
    if (bytes.length !== length) {
      throw new CaptureReadError('short-read', `读 ${text}+${length} 只拿到 ${bytes.length} 字节`, {
        address: text, length, got: bytes.length,
      });
    }
    this.sources.add(String(response.body?.evidence?.source ?? 'unknown'));
    this.reads += 1;
    this.bytes += bytes.length;
    return new Uint8Array(bytes);
  }

  symbolAddress(name) {
    return this.symbols.get(name) ?? null;
  }

  symbolSize(name) {
    return this.sizes.get(name) ?? null;
  }
}

function littleEndian(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

/**
 * 认领失败时唯一要回答的问题是"现在停在谁身上"，只读 `comm` 不够：`fork` 出来的孩子在
 * `execve` 装载 ELF 期间 `comm` 还是父进程的名字。把 `pid/tgid/mm/父进程` 一起读出来
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
// 通道二：GDB 侧参照（类型/偏移/枚举一律由 GDB 自己的 DWARF 解释）
// ---------------------------------------------------------------------------

/**
 * 在**当前停点**跑一遍 GDB 侧参照实现，把结果 JSON 读回来。
 *
 * 走 `source` 而不是让脚本自己读内存：参照实现必须用 GDB 自己的 DWARF 解释与 `%gs` 基址。
 * 时间上限给得很大 —— 逐字段读 file/dentry/inode/super_block 加一遍 XArray 遍历，
 * 在 TCG + 远程 gdbstub 上要几十秒，而 MI 适配器默认只有 20 秒。读回来时必须走 `parseBigJson`。
 */
async function runReference(live, label, args) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `t07d-ref-${label}-`));
  const outPath = path.join(dir, 'reference.json');
  const scriptPath = path.join(dir, 'reference.py');
  try {
    const source = fs.readFileSync(REFERENCE_PY, 'utf8')
      .replace('__OUT_PATH__', JSON.stringify(outPath))
      .replace('__FILES__', String(args.files ?? 0n))
      .replace('__FD__', String(args.fd ?? 0))
      .replace('__FILE__', String(args.file ?? 0n))
      .replace('__DENTRY__', String(args.dentry ?? 0n))
      .replace('__INODE__', String(args.inode ?? 0n))
      .replace('__MAPPING__', String(args.mapping ?? 0n))
      .replace('__PFN__', String(args.pfn ?? 0n));
    fs.writeFileSync(scriptPath, source);
    const record = await live.mi.console(`source ${scriptPath}`, { timeoutMs: 900000 });
    if (!fs.existsSync(outPath)) {
      const stream = String(record?.stream ?? '');
      fs.writeFileSync(path.join(path.dirname(EVIDENCE), `t07d-reference-${label}-failed.txt`), stream);
      return { ok: false, error: '参照脚本没有写出结果文件', stream: stream.slice(-800) };
    }
    const data = parseBigJson(fs.readFileSync(outPath, 'utf8'));
    fs.writeFileSync(
      path.join(path.dirname(EVIDENCE), `t07d-reference-${label}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 通道四：QEMU 的 HMP（第三种读内存实现）
// ---------------------------------------------------------------------------

/**
 * `x/gx` 的输出形如：
 *   ffff888002c96a40: 0x0000000000000001 0x0000000000000000
 *   ffff888002c96a50: 0x0000000000000000 0x0000000000000000
 * 这里把每行冒号之后的十六进制字按顺序收下来，和我们的字段逐个比。
 */
function parseHmpWords(text) {
  const words = [];
  for (const raw of String(text ?? '').split('\n')) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const head = raw.slice(0, colon).trim();
    if (!/^[0-9a-f]+$/.test(head)) continue;
    for (const match of raw.slice(colon + 1).matchAll(/0x([0-9a-f]+)/g)) {
      words.push(BigInt(`0x${match[1]}`));
    }
  }
  return words;
}

async function hmpWords(live, address, count) {
  const text = await live.qmp.hmp(`x/${count}gx ${hex(address)}`, { timeoutMs: 120000 });
  return { raw: String(text).trim(), words: parseHmpWords(text) };
}

// ---------------------------------------------------------------------------
// 通道五：内核源码现场重解析
// ---------------------------------------------------------------------------

/** 读 `.config`，返回 `CONFIG_X` 形式的集合（只收 `=y` 的）。 */
function readEnabledConfigs(text) {
  const set = new Set();
  for (const raw of text.split('\n')) {
    const match = /^(CONFIG_[A-Z0-9_]+)=y\s*$/.exec(raw.trim());
    if (match) set.add(match[1]);
  }
  return set;
}

/**
 * 把 `#define` 解析成"名字 → 取值"的表。
 *
 * 与 T07c 那版相比，这里多认了三种真实写法（不认它们就会把正确的表判成错的）：
 *   - `#define I_NEW (1 << __I_NEW)`   —— 位移量是个宏，要先解出那个宏
 *   - `#define FMODE_READ ((__force fmode_t)(1 << 0))` —— 中间夹了类型转换
 *   - `#define O_CREAT 00000100`       —— **八进制**字面量，按十进制读会得到 100 而不是 64
 *   - `#define O_SYNC (__O_SYNC|O_DSYNC)` —— 由两位拼出来的组合名
 *
 * 条件编译栈与"是否落在结构体声明体内"照旧记下来：`DCACHE_NOKEY_NAME` 定义在
 * `#ifdef CONFIG_FS_ENCRYPTION` 里，本配置没开时它不该算数。
 */
function readDefineTable(text) {
  const values = new Map();
  const aliases = new Map();
  const contexts = new Map();
  const conditions = [];
  let aggregate = null;
  const push = (map, name, rhs, line) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(rhs);
    if (!contexts.has(name)) contexts.set(name, []);
    contexts.get(name).push({ line, conditions: [...conditions], aggregate });
  };
  const literal = (raw) => {
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
    if (/^0[0-7]+$/.test(raw)) return BigInt(`0o${raw.slice(1)}`);
    if (/^[0-9]+$/.test(raw)) return BigInt(raw);
    return null;
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    if (/^#\s*(if|ifdef|ifndef)\b/.test(line)) { conditions.push(raw.trim()); continue; }
    if (/^#\s*(else|elif)\b/.test(line)) {
      if (conditions.length > 0) conditions[conditions.length - 1] = `${conditions[conditions.length - 1]} ${raw.trim()}`;
      continue;
    }
    if (/^#\s*endif\b/.test(line)) { conditions.pop(); continue; }
    const opened = /^(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/.exec(line);
    if (opened) { aggregate = opened[1]; continue; }
    if (/^\}\s*;/.test(line)) { aggregate = null; continue; }
    let match = /^#define\s+([A-Za-z_]\w*)\s+(0x[0-9a-fA-F]+|0[0-7]+|[0-9]+)$/.exec(line);
    if (match) { const value = literal(match[2]); if (value !== null) { push(values, match[1], value, index + 1); continue; } }
    match = /^#define\s+([A-Za-z_]\w*)\s+(0x[0-9a-fA-F]+|0[0-7]+|[0-9]+)\b/.exec(line);
    if (match) { const value = literal(match[2]); if (value !== null) { push(values, match[1], value, index + 1); continue; } }
    // 位移：`(1 << N)`、`(N << M)`、`((__force T)(1 << N))`、`_AC(N,UL) << M`
    match = /^#define\s+([A-Za-z_]\w*)\s+\(+\s*(?:_AC|_AT)\(\s*([0-9]+)\s*,[^)]*\)\s*<<\s*([A-Za-z_]\w*)\s*\)+$/.exec(line);
    if (match) { push(aliases, match[1], `SHIFT(${match[3]}):${match[2]}`, index + 1); continue; }
    match = /^#define\s+([A-Za-z_]\w*)\s+\(+\s*(?:(?:__force|__bitwise)\s+\w+\s*\)\s*\()?\s*1\s*<<\s*([A-Za-z_0-9]+)\s*\)+$/.exec(line);
    if (match) { push(aliases, match[1], `SHIFT(${match[2]})`, index + 1); continue; }
    match = /^#define\s+([A-Za-z_]\w*)\s+\(+\s*([A-Za-z_0-9]+)\s*<<\s*([A-Za-z_0-9]+)\s*\)+$/.exec(line);
    if (match) { push(aliases, match[1], `LSHIFT(${match[2]},${match[3]})`, index + 1); continue; }
    // BIT 家族：`BIT(16)`、`_BITUL(0)`
    match = /^#define\s+([A-Za-z_]\w*)\s+((?:_BITUL|_BITULL|BIT_ULL|_BIT|BIT)\([^)]*\))$/.exec(line);
    if (match) { push(aliases, match[1], match[2], index + 1); continue; }
    // 组合：`(A|B|C)`
    match = /^#define\s+([A-Za-z_]\w*)\s+\(+\s*([A-Za-z_0-9]+(?:\s*\|\s*[A-Za-z_0-9]+)+)\s*\)+$/.exec(line);
    if (match) { push(aliases, match[1], `OR(${match[2].split('|').map((x) => x.trim()).join(',')})`, index + 1); continue; }
    // 纯别名：`#define O_NDELAY O_NONBLOCK`
    match = /^#define\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)$/.exec(line);
    if (match) { push(aliases, match[1], match[2], index + 1); }
  }
  return { values, aliases, contexts };
}

/** 把多个头文件合成一张表（`NR_OPEN_DEFAULT` 要顺着 `BITS_PER_LONG` 走出本文件）。 */
function mergeTables(entries) {
  const merged = {
    values: new Map(), aliases: new Map(), contexts: new Map(), fileOf: new Map(),
  };
  for (const entry of entries) {
    const table = readDefineTable(entry.text);
    for (const map of ['values', 'aliases']) {
      for (const [name, list] of table[map]) {
        if (!merged[map].has(name)) merged[map].set(name, []);
        merged[map].get(name).push(...list);
        if (!merged.fileOf.has(name)) merged.fileOf.set(name, entry.name);
      }
    }
    for (const [name, list] of table.contexts) {
      if (!merged.contexts.has(name)) merged.contexts.set(name, []);
      for (const item of list) merged.contexts.get(name).push({ ...item, file: entry.file });
    }
  }
  return merged;
}

/**
 * 把一个定义的全部可能取值解出来（处理 `BIT(x)`、`SHIFT(x)`、`LSHIFT(a,b)`、
 * `OR(a,b)` 与别名链）。遇到环就停（`seen`），不会转不出来。
 */
function resolveDefineAll(table, name, seen = new Set()) {
  const out = new Set();
  if (seen.has(name)) return out;
  seen.add(name);
  /**
   * 别名表达式里的一个记号，可能是**数字字面量**也可能是宏名。
   * `(0 << 20)` 的左边就是数字 0 —— 把它当宏名去查表会查到空集，而空集不会报错，
   * 只会让 `DCACHE_*_TYPE` 这一族静默变成"源码里没有定义"。
   */
  const tokenValues = (token) => (/^[0-9]+$/.test(token)
    ? new Set([BigInt(token)])
    : resolveDefineAll(table, token, new Set(seen)));
  for (const value of table.values.get(name) ?? []) out.add(value);
  for (const rhs of table.aliases.get(name) ?? []) {
    let match = /^(?:_BITUL|_BITULL|BIT_ULL|_BIT|BIT)\(([^)]*)\)$/.exec(rhs);
    if (match) {
      for (const value of tokenValues(match[1])) out.add(1n << value);
      continue;
    }
    match = /^SHIFT\(([A-Za-z_0-9]+)\)(?::([0-9]+))?$/.exec(rhs);
    if (match) {
      const base = match[2] === undefined ? 1n : BigInt(match[2]);
      for (const value of tokenValues(match[1])) out.add(base << value);
      continue;
    }
    match = /^LSHIFT\(([A-Za-z_0-9]+),([A-Za-z_0-9]+)\)$/.exec(rhs);
    if (match) {
      for (const a of tokenValues(match[1])) for (const b of tokenValues(match[2])) out.add(a << b);
      continue;
    }
    match = /^OR\((.+)\)$/.exec(rhs);
    if (match) {
      // `(A|B)` 是"或起来"，不是"两个值并列"。`O_SYNC` 就是 `(__O_SYNC|O_DSYNC)`：
      // 并列会得到 {0x100000, 0x1000} 两个值，而它的真实取值只有一个 0x101000；
      // `I_DIRTY` 同理（`I_DIRTY_INODE` 与 `I_DIRTY_PAGES` 必须合成 0x38 这一个数）。
      const parts = match[1].split(',').map((piece) => piece.trim());
      let combos = [0n];
      for (const part of parts) {
        const values = [...tokenValues(part)];
        if (values.length === 0) { combos = []; break; }
        combos = combos.flatMap((acc) => values.map((value) => acc | value));
      }
      for (const value of combos) out.add(value);
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(rhs)) {
      for (const value of tokenValues(rhs)) out.add(value);
    }
  }
  return out;
}

/** 一个定义在源码里的所有出现处（文件与行号），用于把"对不上"说清楚。 */
function defineSites(table, name) {
  return (table.contexts.get(name) ?? []).map((entry) => `${path.basename(entry.file ?? '?')}:${entry.line}`).join('/');
}

/** 某个名字的取值是否全部落在某配置的条件分支里（配置没开时用来判"它不该算数"）。 */
function guardedByConfig(table, name, config) {
  const sites = table.contexts.get(name) ?? [];
  return sites.length > 0 && sites.every((entry) => entry.conditions.some((line) => line.includes(config)));
}

/** `enum X { ... }` 里的裸标识符表（跳过注释与条件编译指令行，保留顺序）。 */
function parseEnumMembers(text, enumName) {
  const at = text.indexOf(`enum ${enumName} {`);
  if (at < 0) return [];
  const end = text.indexOf('\n};', at);
  const body = text.slice(at, end < 0 ? text.length : end + 3);
  const names = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    for (const piece of line.split(',')) {
      const token = piece.trim();
      if (token.length === 0) continue;
      const match = /^([A-Za-z_]\w*)\s*(?:=|$)/.exec(token);
      if (match) names.push(match[1]);
    }
  }
  return names;
}

/** 取某个函数体的开头若干行（`static inline T name(...) { ... }`）。 */
function readFunctionBody(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  const close = text.indexOf('\n}', open);
  if (open < 0 || close < 0) return null;
  return text.slice(open + 1, close);
}

/**
 * XArray 的编码/解码在源码里是**函数体**而不是常量，所以现场重解析要读函数体：
 * `xa_mk_value` 是 `(v << 1) | 1`（**不是** `<<2`）、`xa_to_value` 是 `>> 1`、
 * `xa_mk_internal` 是 `(v << 2) | 2`、`xa_to_node` 是 `entry - 2`、
 * `xa_is_node` 是"内部条目且数值 > 4096"。
 */
function readXarrayEncoding(text) {
  const mkValue = readFunctionBody(text, 'static inline void *xa_mk_value(');
  const toValue = readFunctionBody(text, 'static inline unsigned long xa_to_value(');
  const mkInternal = readFunctionBody(text, 'static inline void *xa_mk_internal(');
  const toInternal = readFunctionBody(text, 'static inline unsigned long xa_to_internal(');
  const toNode = readFunctionBody(text, 'static inline struct xa_node *xa_to_node(');
  const isNode = readFunctionBody(text, 'static inline bool xa_is_node(');
  const isSibling = readFunctionBody(text, 'static inline bool xa_is_sibling(');
  return {
    mkValue: { body: mkValue, shifts1: /<<\s*1/.test(mkValue ?? ''), ors1: /\|\s*1\b/.test(mkValue ?? '') },
    toValue: { body: toValue, shifts1: />>\s*1/.test(toValue ?? '') },
    mkInternal: { body: mkInternal, shifts2: /<<\s*2/.test(mkInternal ?? ''), ors2: /\|\s*2\b/.test(mkInternal ?? '') },
    toInternal: { body: toInternal, shifts2: />>\s*2/.test(toInternal ?? '') },
    toNode: { body: toNode, subtracts2: /-\s*2\b/.test(toNode ?? '') },
    isNode: { body: isNode, threshold4096: />\s*4096\b/.test(isNode ?? ''), usesInternal: /xa_is_internal/.test(isNode ?? '') },
    isSibling: {
      body: isSibling,
      usesMulti: /CONFIG_XARRAY_MULTI/.test(isSibling ?? ''),
      upperBound: /xa_mk_sibling\(\s*XA_CHUNK_SIZE\s*-\s*1\s*\)/.test(isSibling ?? ''),
    },
    chunkShiftLine: /#define XA_CHUNK_SHIFT\s+\(IS_ENABLED\(CONFIG_BASE_SMALL\)\s*\?\s*(\d+)\s*:\s*(\d+)\)/.exec(text),
    retryEntry: /#define XA_RETRY_ENTRY\s+xa_mk_internal\((\d+)\)/.exec(text),
    zeroEntry: /#define XA_ZERO_ENTRY\s+xa_mk_internal\((\d+)\)/.exec(text),
    refRandomRecalc: /#define XA_REF_RANDOM_RECALC\b/.test(text),
  };
}

/** `struct kiocb` 的第一个成员必须真的是 `struct file *ki_filp`，"读 rdi 头 8 字节"才立得住。 */
function readKiocbSource(text) {
  const at = text.indexOf('struct kiocb {');
  if (at < 0) return null;
  const body = text.slice(at, text.indexOf('\n};', at));
  const first = /\{\s*\n\s*([^;\n]+);/.exec(`${body.split('\n').slice(0, 3).join('\n')}`);
  const member = /struct\s+file\s*\*\s*ki_filp/.test(body.slice(0, 200));
  return {
    member,
    firstDeclaration: first === null ? null : first[1].trim(),
    bodyHead: body.split('\n').slice(1, 6).join('\n'),
  };
}

/** `fs/file.c` 里 `full_fds_bits` 的用法：`__set_bit(fd, full_fds_bits)` 还是按 open_fds 的字号。 */
function readFullFdsBitsUsage(text) {
  const hits = [];
  for (const raw of text.split('\n')) {
    if (raw.includes('full_fds_bits')) hits.push(raw.trim());
  }
  return {
    count: hits.length,
    lines: hits.slice(0, 8),
    setOnWordIndex: hits.some((line) => /BIT_WORD\(fd\)|__set_bit\(fd,|set_bit\(fd,/.test(line)),
  };
}

/**
 * `dname_external()` 的判据与 `DNAME_INLINE_LEN`：名字内嵌还是外置就靠这两处。
 *
 * 判据要**按文件**找：6.12 里 `dname_external()` 定义在 `fs/dcache.c`，头文件里根本没有。
 * 只扫头文件会得到 `comparesNameToIname = false` —— 而 false 恰好是最常见真实情况
 * （短名字都内嵌）的答案，看起来完全正常，错得毫无征兆。所以调用方把两份源码都传进来，
 * 谁有就用谁，并把"判据来自哪个文件、原文是哪一行"一并记进证据。
 *
 * `DNAME_INLINE_LEN` 是三份条件定义（`CONFIG_64BIT` → 40；否则看 `CONFIG_SMP` 是 36 还是 44），
 * 所以要按本内核的配置选中**生效的那一份**，不能拿正则抓第一个数字。
 */
function readDcacheNameFacts(sources, enabledConfigs = new Set()) {
  const list = sources.filter((entry) => typeof entry?.text === 'string' && entry.text.length > 0);
  let externalBody = null;
  let externalSource = null;
  let judgeLine = null;
  for (const entry of list) {
    const body = readFunctionBody(entry.text, 'static inline int dname_external(');
    if (body === null) continue;
    externalBody = body;
    externalSource = entry.file ?? null;
    const matched = /dentry->d_name\.name\s*!=\s*dentry->d_iname/.exec(body);
    if (matched !== null) judgeLine = matched[0].trim();
    break;
  }
  const headerEntry = list.find((entry) => /#\s*define\s+DNAME_INLINE_LEN/.test(entry.text)) ?? list[0] ?? null;
  const inlineFacts = readDnameInlineLen(headerEntry?.text ?? '', enabledConfigs);
  return {
    externalBody,
    externalSource,
    judgeLine,
    comparesNameToIname: judgeLine !== null,
    ...inlineFacts,
  };
}

/**
 * 从一份 C 源码里选出 `DNAME_INLINE_LEN` 当前生效的值。
 *
 * 这段定义是条件块（外层 `#ifdef CONFIG_64BIT`，32 位那一支里还有 `#ifdef CONFIG_SMP`），
 * 所以要按"预处理器会走哪一支"手动过一遍：入栈记下「这一层当前是否生效 / 是否已经进过真分支」，
 * 遇到 `#define` 时要求整摞栈都生效才算数，遇到这段源码里没出现过的条件形式（`#if` / `#elif`）
 * 就如实放弃 —— 宁可报 `null`，也不要猜一个"看着合理"的数字。
 */
function readDnameInlineLen(text, enabledConfigs = new Set()) {
  const lines = text.split('\n');
  const defineIndex = lines.findIndex((line) => /^\s*#\s*define\s+DNAME_INLINE_LEN\b/.test(line));
  if (defineIndex < 0) return { inlineLen: null, inlineLenLine: null, inlineLenBranches: [] };
  // 从定义那一行往上找最近的 `#if`/`#ifdef`/`#ifndef` 作为行走起点。
  // 不直接找"第一个 CONFIG_64BIT 的 #ifdef"：头文件里将来多出别的条件块时，那样会从错的块起步，
  // 走到 #endif 就放弃，最后返回一个"没找到"（而它看起来和"这段定义不存在"一模一样）。
  let start = -1;
  for (let index = defineIndex; index >= 0; index -= 1) {
    if (/^\s*#\s*if(n?def)?\b/.test(lines[index])) {
      start = index;
      break;
    }
  }
  if (start < 0) return { inlineLen: null, inlineLenLine: null, inlineLenBranches: [] };
  const stack = [];
  const branches = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    let matched = /^\s*#\s*ifdef\s+([A-Za-z_0-9]+)/.exec(line);
    if (matched !== null) {
      const active = enabledConfigs.has(matched[1]);
      stack.push({ active, taken: active });
      continue;
    }
    matched = /^\s*#\s*ifndef\s+([A-Za-z_0-9]+)/.exec(line);
    if (matched !== null) {
      const active = !enabledConfigs.has(matched[1]);
      stack.push({ active, taken: active });
      continue;
    }
    if (/^\s*#\s*if\b/.test(line) || /^\s*#\s*elif\b/.test(line) || /^\s*#\s*else\s+if\b/.test(line)) {
      return { inlineLen: null, inlineLenLine: null, inlineLenBranches: branches };
    }
    if (/^\s*#\s*else\b/.test(line)) {
      const top = stack[stack.length - 1];
      if (top === undefined) return { inlineLen: null, inlineLenLine: null, inlineLenBranches: branches };
      top.active = !top.taken;
      top.taken = true;
      continue;
    }
    if (/^\s*#\s*endif\b/.test(line)) {
      stack.pop();
      if (stack.length === 0) break;
      continue;
    }
    matched = /^\s*#\s*define\s+DNAME_INLINE_LEN\s+(\d+)/.exec(line);
    if (matched !== null) {
      const active = stack.every((level) => level.active);
      branches.push({ line: line.trim(), active });
      if (active) {
        return { inlineLen: Number(matched[1]), inlineLenLine: line.trim(), inlineLenBranches: branches };
      }
    }
  }
  return { inlineLen: null, inlineLenLine: null, inlineLenBranches: branches };
}

/** `ext2` 的魔数：`s_magic` 该等于它。 */
function readExt2Magic(magicText) {
  const match = /#define EXT2_SUPER_MAGIC\s+(0x[0-9a-fA-F]+)/.exec(magicText);
  return match === null ? null : BigInt(match[1]);
}

/** `stat.h` 的 `S_IF*`（八进制）：`i_mode` 的类型字段与它对照。 */
function readStatTypes(text) {
  const table = readDefineTable(text);
  const out = new Map();
  for (const name of ['S_IFMT', 'S_IFSOCK', 'S_IFLNK', 'S_IFREG', 'S_IFBLK', 'S_IFDIR', 'S_IFCHR', 'S_IFIFO']) {
    const resolved = resolveDefineAll(table, name);
    if (resolved.size > 0) out.set(name, resolved);
  }
  return { table, types: out };
}

// ---------------------------------------------------------------------------
// 通道六：客体自报（真实系统调用的结果）
// ---------------------------------------------------------------------------

/**
 * `stat -c "STAT %d %i %s %f %h %u %g %o" <file>` 的输出。
 *
 * 每个格式字母打出来的进制不是猜的，而是去读**客体里那份 busybox 自己的源码**
 * （`artifacts/build/busybox/coreutils/stat.c`）：
 * - `%d` → `strcat(pformat, "llu")` + `st_dev`：十进制；
 * - `%i`/`%s`/`%h`/`%u`/`%g`/`%o` 全是 `llu`/`lu`：十进制；
 * - `%f` → `strcat(pformat, "lx")` + `st_mode`：**十六进制，且不带 `0x` 前缀**。
 *
 * 所以 mode 一律按十六进制解：`%f` 打出来的 `81a4` 就是 `0o100644` = 33188。
 * 反过来，如果按十进制读那个 `81a4`，会读出一个"看着也挺像权限"的错值。
 */
function parseGuestStat(text) {
  const match = /^STAT\s+(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m
    .exec(String(text ?? ''));
  if (match === null) return null;
  return {
    dev: BigInt(match[1]),
    ino: BigInt(match[2]),
    size: BigInt(match[3]),
    mode: Number.parseInt(match[4], 16),
    nlink: Number(match[5]),
    uid: Number(match[6]),
    gid: Number(match[7]),
    blksize: BigInt(match[8]),
    raw: match[0],
  };
}

/** `/proc/<pid>/fdinfo/<fd>` 的 `pos:` 与 `flags:`（flags 是八进制）。 */
function parseFdinfo(text) {
  const body = String(text ?? '');
  const pos = /^pos:\s*(\d+)/m.exec(body);
  const flags = /^flags:\s*0?([0-7]+)/m.exec(body);
  const ino = /^ino:\s*(\d+)/m.exec(body);
  return {
    pos: pos === null ? null : BigInt(pos[1]),
    flags: flags === null ? null : Number.parseInt(flags[1], 8),
    ino: ino === null ? null : BigInt(ino[1]),
    raw: body.trim().split('\n').slice(0, 8).join(' | '),
  };
}

/** `readlink /proc/<pid>/fd/<fd>` 的输出（一行路径）。 */
function parseGuestPath(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('/')) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t07d-evidence/1', startedAt: new Date().toISOString() };
  let session = null;
  let live = null;
  let layout = null;
  let symbols = null;
  let sizes = null;
  let base = null;
  let seq = 0;
  let localConfigs = new Set();
  let removeBreakpointId = null;
  // V16 要在 `finally` 里复查「会话关掉之后还读不读得到客体内存」；`file1` 是 try 块里的
  // 局部量，所以在块内先把这条链上一个真实存在的地址抄到外层。
  let probeAddress = null;

  const cmd = async (type, extra = {}) => call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    requestId: `t07d-${++seq}-${type}`,
    epoch: live.epoch,
    expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
    type,
    ...extra,
  });

  const captureFor = (frame) => new LiveCapture({
    app,
    base,
    sessionId: session.id,
    epoch: live.epoch,
    frameId: frame.frameId,
    captureId: frame.captureId,
    kernelRelease: layout?.linuxRelease ?? null,
    symbols,
    sizes,
  });

  try {
    // ---------- 建会话、启动到 shell ----------

    log('创建会话并采集复位帧（加载 vmlinux 符号，约 1–2 分钟）...');
    const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
    if (created.status !== 201) throw new Error(`会话创建失败：${describe(created.body)}`);
    session = created.body;
    live = registry.get(session.id);
    base = `/api/sessions/${session.id}`;
    evidence.session = {
      id: session.id, profile: session.profile, epoch: live.epoch, qemu: live.process.qemuPath,
    };
    const bootCont = await cmd('continue');
    if (bootCont.status !== 200) throw new Error(`continue（启动）失败：${describe(bootCont.body)}`);
    log('等待客体启动到交互提示符（最多 300 秒，TCG 上较慢）...');
    const bootText = await waitForTerminal(app, base, 300000);
    check('T07d-B0 客体真实启动到交互提示符', PROMPT.test(bootText), `串口字节=${bootText.length}`);

    // ---------- V1a 布局产物与现场 vmlinux 绑定 ----------

    if (!fs.existsSync(LAYOUT_PATH)) throw new Error(`找不到布局产物 ${LAYOUT_PATH}`);
    layout = KernelLayout.load(LAYOUT_PATH, { vmlinux: VMLINUX });
    const liveSha256 = crypto.createHash('sha256').update(fs.readFileSync(VMLINUX)).digest('hex');
    const required = dedupedManifest().filter((entry) => entry.required).map((entry) => entry.name);
    const missingRequired = required.filter((name) => layout.missing.some((entry) => entry.name === name));

    const parsedSymbols = parseReadelfSymbols(
      execFileSync('readelf', ['-sW', VMLINUX], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }),
    );
    symbols = parsedSymbols.addresses;
    sizes = parsedSymbols.sizes;
    const vmlinuxBuildId = parseBuildId(execFileSync('readelf', ['-nW', VMLINUX], { encoding: 'utf8' }));

    const probeSymbols = ['pcpu_hot', '__per_cpu_offset', 'init_task', 'ext2_file_read_iter'];
    const symbolFacts = {};
    for (const name of probeSymbols) {
      const resolved = live.symbols.resolve(name, { module: 'linux-kernel' });
      const serviceAddress = resolved.found && !resolved.ambiguous
        ? BigInt(resolved.candidates[0].address) : null;
      const readelfAddress = symbols.get(name) ?? null;
      symbolFacts[name] = {
        service: hexOrNull(serviceAddress), readelf: hexOrNull(readelfAddress),
        equal: serviceAddress !== null && readelfAddress !== null && serviceAddress === readelfAddress,
      };
    }

    const unameCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07d-${++seq}-uname`, epoch: live.epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0, type: 'terminal.input',
      text: 'echo KERNEL"RELEASE=$(uname -r)"\n',
    });
    const unameText = await waitForTerminalMarker(app, base, 'KERNELRELEASE=', 60000, unameCursor);
    const guestRelease = /KERNELRELEASE=([^\s\r\n]+)/.exec(unameText)?.[1] ?? null;

    evidence.kernel = {
      layoutFile: path.basename(LAYOUT_PATH),
      layoutRelease: layout.linuxRelease,
      layoutBuildId: layout.buildId,
      layoutSha256: layout.sha256,
      liveSha256,
      vmlinuxBuildId,
      guestRelease,
      requiredTypes: required.length,
      missingRequired,
      optionalMissing: layout.missing.map((entry) => entry.name),
      readelfSymbolCount: symbols.size,
      readelfDuplicates: parsedSymbols.duplicates,
      symbolFacts,
    };
    check(
      'T07d-V1a 布局产物与现场 vmlinux 绑定：build ID 与 sha256 由 load() 现场重算并比对通过，客体内核 release 与产物一致',
      layout.sha256 === liveSha256
        && typeof layout.buildId === 'string' && layout.buildId.length === 40
        && (vmlinuxBuildId === null || vmlinuxBuildId === layout.buildId)
        && guestRelease !== null && guestRelease === layout.linuxRelease,
      `buildId=${String(layout.buildId).slice(0, 12)}（readelf=${String(vmlinuxBuildId).slice(0, 12)}）`
        + ` 产物 release=${layout.linuxRelease} 客体 uname -r=${guestRelease ?? '未知'}`,
    );
    check(
      'T07d-V1c 符号事实三方一致（readelf vs 服务）：pcpu_hot/__per_cpu_offset/init_task/ext2_file_read_iter 地址相同',
      Object.values(symbolFacts).every((entry) => entry.equal === true),
      Object.entries(symbolFacts).map(([name, entry]) => `${name}=${entry.service ?? '缺'}`).join(' '),
    );

    // ---------- V1d 客体自己编进去的配置 ----------

    const configProbed = ['CONFIG_XARRAY_MULTI', 'CONFIG_MULTIUSER', 'CONFIG_PROC_FS',
      'CONFIG_EXT2_FS', 'CONFIG_IKCONFIG_PROC', 'CONFIG_FSNOTIFY', 'CONFIG_FS_ENCRYPTION', 'CONFIG_BASE_SMALL'];
    const configCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07d-${++seq}-config`, epoch: live.epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0, type: 'terminal.input',
      text: `zcat /proc/config.gz | grep -E "^(# )?CONFIG_(${configProbed.map((name) => name.replace('CONFIG_', '')).join('|')})[= ]" ; echo CONFIG""DONE\n`,
    });
    const configText = await waitForTerminalMarker(app, base, 'CONFIGDONE', 60000, configCursor);
    const guestConfig = new Map();
    for (const raw of configText.split('\n')) {
      const line = raw.trim();
      const set = /^CONFIG_([A-Z0-9_]+)=(.*?)\s*$/.exec(line);
      if (set) { guestConfig.set(`CONFIG_${set[1]}`, set[2]); continue; }
      const unset = /^#\s*CONFIG_([A-Z0-9_]+)\s+is not set\s*$/.exec(line);
      if (unset) guestConfig.set(`CONFIG_${unset[1]}`, 'n');
    }
    localConfigs = readEnabledConfigs(fs.readFileSync(CONFIGS, 'utf8'));
    /**
     * 比"开没开"，不比字面值。`/proc/config.gz` 是内核把自己那份 `.config` 原样编进去的，
     * 一个没开的 `bool` 有两种表现：写着 `# CONFIG_X is not set`，或者这个符号压根没被写进
     * `.config`（Kconfig 依赖不满足时就是这样）。两种都是"没开"，按字面值硬比会把它们
     * 判成不一致；真正会让条件位判断出错的只有"一边开着、另一边没开"。
     */
    const guestEnabled = (name) => guestConfig.get(name) === 'y';
    const localEnabled = (name) => localConfigs.has(name);
    const configMismatches = configProbed
      .filter((name) => guestEnabled(name) !== localEnabled(name))
      .map((name) => `${name}: 客体=${guestConfig.get(name) ?? '（/proc/config.gz 里没有这一行）'}`
        + ` 本地=${localEnabled(name) ? 'y' : 'n'}`);
    evidence.kernel.guestConfig = Object.fromEntries(guestConfig);
    evidence.kernel.configMismatches = configMismatches;
    check(
      'T07d-V1d 客体自己编进去的配置（/proc/config.gz）与本地构建配置一致，条件位判定才有依据（XARRAY_MULTI=y/FSNOTIFY=y/FS_ENCRYPTION 未开/BASE_SMALL 未开）',
      configMismatches.length === 0
        && guestEnabled('CONFIG_XARRAY_MULTI')
        && guestEnabled('CONFIG_FSNOTIFY')
        && !guestEnabled('CONFIG_FS_ENCRYPTION')
        && !guestEnabled('CONFIG_BASE_SMALL'),
      configProbed.map((name) => `${name}=${guestConfig.get(name) ?? '（config.gz 里没有这一行）'}`).join(' ')
        + (configMismatches.length === 0 ? '' : `；不一致：${configMismatches.join(' | ')}`),
    );

    // ---------- 客体自报（第 6 条通道）：真实系统调用拿到同一份事实 ----------

    /**
     * 这一段必须在**下断点之前**跑完：断点命中之后整个客体都冻住了，串口上递进去的命令
     * 不会被执行。所以用一个和 `lab-read` 不同的进程（交互 shell）去 `open()` 同一个文件、
     * `stat()` 同一个文件 —— 这些是真实系统调用的结果，出自内核自己，不经过我们任何代码。
     */
    log('让客体自己用真实系统调用报一遍：open + fstat + readlink + fdinfo + 真读一遍文件内容 ...');
    const probeCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    /**
     * 探针里为什么要 `cat` 一遍文件内容：
     *
     * `lab-read` 停在下断的那个函数**入口**上，也就是说它自己那一页还没读进来；如果只
     * `open` 而不读，`i_pages` 这棵 XArray 到停点时还是**空的**，"页缓存条目 → struct page"
     * 这一环就没有东西可验。让**另一个进程**（交互 shell）先真读一遍，页缓存里就真的有了
     * 那一页，而 `lab-read` 自己的 `f_pos` 不受影响（`f_pos` 是每个 `struct file` 各一份）。
     * 顺带这份内容也成了"同一个文件的字节"的独立来源，供 V14b 与 `lab-read` 读出的字节比。
     */
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07d-${++seq}-probe`, epoch: live.epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0, type: 'terminal.input',
      text: `echo PRO""BE-BEGIN; exec 7<${LAB_FILE}; readlink /proc/$$/fd/7; echo FDI""NFO; cat /proc/$$/fdinfo/7; echo FST""AT; stat -c "STAT %d %i %s %f %h %u %g %o" ${LAB_FILE}; echo GUE""STCAT-BEGIN; cat ${LAB_FILE}; echo GUE""STCAT-END; echo PRO""BE-END\n`,
    });
    const probeRegion = await waitForTerminalMarker(app, base, 'PROBE-END', 60000, probeCursor);
    const fdinfoPart = probeRegion.split('FDINFO')[1] ?? '';
    const guestFdinfo = parseFdinfo(fdinfoPart.split('FSTAT')[0] ?? '');
    const guestStat = parseGuestStat(probeRegion);
    const guestPath = parseGuestPath(probeRegion.split('FDINFO')[0] ?? '');
    // `cat` 打的字节：`echo MARKER` 之后紧跟内容，所以只掐掉紧跟边界的那一个换行。
    const guestCat = (probeRegion.split('GUESTCAT-BEGIN')[1] ?? '').split('GUESTCAT-END')[0]
      .replace(/^\r?\n/, '');
    evidence.guestProbe = {
      cat: { bytes: guestCat.length, text: guestCat },
      stat: guestStat === null ? null : { ...guestStat, ino: guestStat.ino.toString(), size: guestStat.size.toString() },
      fdinfo: guestFdinfo === null ? null : {
        pos: guestFdinfo.pos === null ? null : guestFdinfo.pos.toString(),
        flags: guestFdinfo.flags === null ? null : `0o${guestFdinfo.flags.toString(8)}`,
        ino: guestFdinfo.ino === null ? null : guestFdinfo.ino.toString(),
        raw: guestFdinfo.raw,
      },
      path: guestPath,
      region: probeRegion.slice(-1200),
    };
    check(
      `T07d-V1e 客体自己报得出同一份事实：shell 用真实 open()/fstat()/stat() 拿到 ${LAB_FILE} 的路径、fdinfo 与 stat`,
      guestStat !== null && guestFdinfo.pos !== null && guestPath === LAB_FILE,
      `readlink=${guestPath ?? '未拿到'} fdinfo.pos=${guestFdinfo.pos === null ? '未拿到' : guestFdinfo.pos} `
        + `fdinfo.flags=${guestFdinfo.flags === null ? '未拿到' : `0o${guestFdinfo.flags.toString(8)}`} `
        + `stat=${guestStat === null ? '未拿到' : `dev=${guestStat.dev} ino=${guestStat.ino} size=${guestStat.size} mode=0o${guestStat.mode.toString(8)} nlink=${guestStat.nlink}`}`,
    );

    // ---------- 唯一停点：lab-read 读文件 ----------

    const percpuHotLink = symbols.get('pcpu_hot') ?? null;
    const taskOffsets = {
      comm: layout.byteOffset('task_struct', 'comm'),
      pid: layout.byteOffset('task_struct', 'pid'),
      tgid: layout.byteOffset('task_struct', 'tgid'),
      mm: layout.byteOffset('task_struct', 'mm'),
      realParent: layout.byteOffset('task_struct', 'real_parent'),
      files: layout.byteOffset('task_struct', 'files'),
    };

    log('停点：lab-read 停在 ext2_file_read_iter ...');
    const readClaim = await claimWithRetry({
      app, base, live, cmd,
      symbol: 'ext2_file_read_iter',
      commandFor: (n) => `lab-read ${LAB_FILE}; echo READ${n}""Y-DONE-$?\n`,
      markerFor: (n) => `READ${n}Y-DONE-`,
      inspect: async (frame) => {
        const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
        return { claimed: info.comm === 'lab-read', label: info.label, value: frame };
      },
    });
    if (readClaim.failed) {
      throw new Error(
        `没有等到 lab-read 停在 ext2_file_read_iter（尝试 ${readClaim.attempts.length} 次，帧总数 ${live.frames.length}）；`
        + `串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const frame1 = readClaim.frame;
    removeBreakpointId = readClaim.breakpoint?.id ?? null;
    const capture1 = captureFor(frame1);
    const view1 = new KernelMemoryView(capture1);
    const current1 = await describeStoppedTask(capture1, percpuHotLink, taskOffsets);
    const task1 = await readTask(view1, layout, current1.taskAddress);
    evidence.stop1 = {
      frameId: frame1.frameId,
      captureId: frame1.captureId,
      claimStops: readClaim.stops,
      attempts: readClaim.attempts,
      rip: frame1.cpu?.rip ?? null,
      cr3: frame1.cpu?.control?.cr3 ?? null,
      gsBase: frame1.cpu?.segments?.gs?.base ?? null,
      comm: current1.comm,
      pid: current1.pid,
      taskAddress: hex(current1.taskAddress),
      filesAddress: task1.files === null ? null : hex(task1.files),
      breakpoint: readClaim.breakpoint,
      captureReads: capture1.reads,
      captureSources: [...capture1.sources],
    };
    check(
      'T07d-V0a 停点落在 lab-read 读文件的内核函数 ext2_file_read_iter 上（认领靠最小读取读出的 comm，不靠 pid 猜）',
      current1.comm === 'lab-read'
        && frame1.stop?.reason === 'breakpoint'
        && (String(frame1.source?.symbol ?? 'ext2_file_read_iter') === 'ext2_file_read_iter'),
      `comm=${current1.comm} pid=${current1.pid} rip=${frame1.cpu?.rip} 停点符号=${frame1.source?.symbol ?? '（帧里没给）'} stop=${frame1.stop?.reason}`,
    );

    // ---------- V0b `rdi → kiocb → ki_filp`：不经 fd 表的第二个 file 来源 ----------

    const kiocbSource = readKiocbSource(fs.readFileSync(FS_H, 'utf8'));
    // 帧里的通用寄存器是**按名字发现的数组**（`cpu.general`），不是 `cpu.registers.rdi`；
    // 从数组里按名字取，取不到就是真的没采到 —— 不许拿别的寄存器顶替 `rdi`。
    const generalRegister = (cpu, name) => {
      for (const entry of cpu?.general ?? []) {
        if (String(entry?.name ?? '').toLowerCase() !== name) continue;
        return entry.value === null || entry.value === undefined ? null : BigInt(entry.value);
      }
      return null;
    };
    const rdi = generalRegister(frame1.cpu, 'rdi');
    const kiFilpAddress = rdi === null ? null : littleEndian(await capture1.readVirtual(rdi, 8));
    const files1 = await readFiles(view1, layout, task1.files ?? 0n);
    const fdSlotAddress = files1.fdtable.fdArray === null ? null : files1.fdtable.fdArray + 3n * 8n;
    const fileFromFd3 = fdSlotAddress === null ? null : await view1.u64(fdSlotAddress);
    evidence.stop1.kiocb = {
      sourceMember: kiocbSource === null ? null : kiocbSource.member,
      sourceFirstDeclaration: kiocbSource === null ? null : kiocbSource.firstDeclaration,
      rdi: hexOrNull(rdi),
      kiFilp: hexOrNull(kiFilpAddress),
      fileFromFd3: hexOrNull(fileFromFd3),
      fdSlot: hexOrNull(fdSlotAddress),
    };
    check(
      'T07d-V0b 帧里的寄存器给出第二个 file 来源：`rdi` 是 `struct kiocb *`（源码里第一个成员就是 `struct file *ki_filp`），它指的 file 与 fd 表里 fd 3 的槽值是**同一个**',
      kiocbSource !== null && kiocbSource.member === true
        && kiFilpAddress !== null && fileFromFd3 !== null && kiFilpAddress === fileFromFd3,
      `kiocb 首成员=${kiocbSource === null ? '读不到源码' : kiocbSource.firstDeclaration}；`
        + `rdi=${hexOrNull(rdi)} → ki_filp=${hexOrNull(kiFilpAddress)}；fd 3 槽（${hexOrNull(fdSlotAddress)}）=${hexOrNull(fileFromFd3)}`,
    );

    // ---------- 通道二：GDB 参照（在这一停点上跑一遍） ----------

    log('在本停点跑 GDB 侧参照实现（$gs + DWARF 偏移、自己重写 XArray 遍历）...');
    const ref = await runReference(live, 'stop1', {
      files: task1.files ?? 0n,
      fd: 3,
      file: fileFromFd3 ?? 0n,
    });
    if (!ref.ok) log(`GDB 侧参照失败：${ref.error}`);
    const refData = ref.ok ? ref.data : {};
    const refFiles = refData.files ?? {};
    const refFdtable = refData.fdtable ?? {};
    const refBitmaps = refData.bitmaps ?? {};
    const refFile = refData.file ?? {};
    const refDentry = refData.dentry ?? {};
    const refPath = refData.path ?? {};
    const refInode = refData.inode ?? {};
    const refSuper = refData.superBlock ?? {};
    const refMapping = refData.addressSpace ?? {};
    const refXarray = refData.ipages ?? {};
    const refCurrent = refData.current ?? {};
    evidence.reference = {
      ok: ref.ok,
      error: ref.ok ? null : ref.error,
      notes: refData.notes ?? [],
      current: {
        gsBase: hexOrNull(refBig(refCurrent.gsBase)),
        current: hexOrNull(refBig(refCurrent.current)),
        pid: refCurrent.pid ?? null,
        comm: refCurrent.comm ?? null,
        filesAddress: hexOrNull(refBig(refCurrent.filesAddress)),
      },
      sizes: refData.layout?.sizes ?? null,
    };

    // ---------- V1b 布局清单的宽度与 GDB 自己的 sizeof 逐项一致 ----------

    const gdbSizes = refData.layout?.sizes ?? null;
    const sizePairs = ['files_struct', 'fdtable', 'file', 'path', 'vfsmount', 'dentry', 'qstr',
      'inode', 'super_block', 'xarray', 'xa_node', 'address_space', 'page', 'folio'];
    const sizeMismatches = [];
    const sizeMissing = [];
    let sizesCompared = 0;
    for (const name of sizePairs) {
      const ours = layout.has(name) ? layout.type(name).byteSize : null;
      const theirs = gdbSizes === null ? null : gdbSizes[name];
      if (theirs === null || theirs === undefined || ours === null) { sizeMissing.push(name); continue; }
      sizesCompared += 1;
      if (Number(theirs) !== Number(ours)) sizeMismatches.push(`${name}: 我们=${ours} GDB=${theirs}`);
    }
    evidence.structSizes = {
      ours: Object.fromEntries(sizePairs.map((name) => [name, layout.has(name) ? layout.type(name).byteSize : null])),
      gdb: gdbSizes,
      compared: sizesCompared,
      mismatches: sizeMismatches,
      missing: sizeMissing,
    };
    check(
      'T07d-V1b 清单里必需类型一个都不缺；文件链上用到的结构宽度与 GDB 自己的 sizeof 逐项一致（files_struct=704、fdtable=56、file=184、dentry=192、inode=592、address_space=192、xa_node=576）',
      required.length > 0 && missingRequired.length === 0 && sizeMismatches.length === 0
        && sizesCompared >= 12
        && Number(layout.type('file').byteSize) === 184
        && Number(layout.type('dentry').byteSize) === 192
        && Number(layout.type('super_block').byteSize) === 1280
        && Number(layout.type('xa_node').byteSize) === 576,
      `必需 ${required.length} 个全部存在；可选缺失 ${layout.missing.length} 个（${layout.missing.map((e) => e.name).join(',') || '无'}）；`
        + `宽度比对 ${sizesCompared} 项，不一致 ${sizeMismatches.length}${sizeMismatches.length === 0 ? '' : `：${sizeMismatches.join(' | ')}`}；`
        + `读不到的：${sizeMissing.join(',') || '无'}；我们：file=${layout.type('file').byteSize} dentry=${layout.type('dentry').byteSize} `
        + `fdtable=${layout.type('fdtable').byteSize} files=${layout.type('files_struct').byteSize} inode=${layout.type('inode').byteSize}`,
    );

    // ---------- V2 current / files 两源一致 + files_struct 逐字段与 GDB 一致 ----------

    const offsetTable = symbols.get('__per_cpu_offset') ?? null;
    const percpuBase0 = offsetTable === null ? null : await view1.u64(offsetTable);
    const gsBaseFrame = frame1.cpu?.segments?.gs?.base === undefined ? null : BigInt(frame1.cpu.segments.gs.base);
    const gdbCurrent = refBig(refCurrent.current);
    const gdbGsBase = refBig(refCurrent.gsBase);
    const gdbPcpuHot = refBig(refCurrent.pcpuHotLink);
    const filesFieldPairs = [
      ['count', 'count'], ['nextFd', 'nextFd'],
      ['fdtable.address', 'fdt'], ['inlineFdtableAddress', 'inlineFdtableAddress'],
      ['fdArrayCount', 'fdArrayCount'], ['wordBytes', 'wordBytes'],
    ];
    const filesMismatches = [];
    let filesCompared = 0;
    for (const [minePath, refKey] of filesFieldPairs) {
      const mine = minePath.split('.').reduce((acc, key) => (acc === null ? null : acc[key]), files1);
      const theirs = refFiles[refKey];
      if (theirs === null || theirs === undefined) continue;
      filesCompared += 1;
      if (BigInt(mine) !== BigInt(theirs)) filesMismatches.push(`${minePath}: 我们=${mine} GDB=${theirs}`);
    }
    filesCompared += 1;
    if ((files1.resizeInProgress ? 1 : 0) !== Number(refFiles.resizeInProgress ?? -1)) {
      filesMismatches.push(`resizeInProgress: 我们=${files1.resizeInProgress} GDB=${refFiles.resizeInProgress}`);
    }
    filesCompared += 1;
    if (Boolean(files1.inlineFdtable) !== Boolean(refFiles.inlineFdtable)) {
      filesMismatches.push(`inlineFdtable: 我们=${files1.inlineFdtable} GDB=${refFiles.inlineFdtable}`);
    }
    for (const key of ['fdArray', 'openFds', 'closeOnExec', 'fullFdsBits']) {
      if (refFiles.inlineArrays?.[key] === undefined) continue;
      filesCompared += 1;
      if (files1.inlineArrays[key] !== BigInt(refFiles.inlineArrays[key])) {
        filesMismatches.push(`inlineArrays.${key}: 我们=${hex(files1.inlineArrays[key])} GDB=${hex(refFiles.inlineArrays[key])}`);
      }
    }
    const fdtablePairs = [
      ['maxFds', 'maxFds'], ['fdArray', 'fd'], ['closeOnExec', 'closeOnExec'],
      ['openFds', 'openFds'], ['fullFdsBits', 'fullFdsBits'],
    ];
    const fdtableMismatches = [];
    for (const [mineKey, refKey] of fdtablePairs) {
      const mine = files1.fdtable[mineKey];
      const theirs = refFdtable[refKey];
      if (theirs === null || theirs === undefined || mine === null) continue;
      filesCompared += 1;
      if (BigInt(mine) !== BigInt(theirs)) {
        fdtableMismatches.push(`${mineKey}: 我们=${typeof mine === 'number' ? mine : hex(mine)} GDB=${typeof theirs === 'number' ? theirs : hex(theirs)}`);
      }
    }
    filesCompared += 1;
    const rcuExpected = files1.fdtable.address + BigInt(refFdtable.rcuOffset ?? 0);
    if (files1.fdtable.rcuHead !== rcuExpected) {
      fdtableMismatches.push(`rcu：我们=${hex(files1.fdtable.rcuHead)} 期望（表地址 + DWARF 偏移 ${refFdtable.rcuOffset}）=${hex(rcuExpected)}`);
    }
    evidence.files = {
      address: hex(files1.address),
      count: files1.count,
      resizeInProgress: files1.resizeInProgress,
      nextFd: files1.nextFd,
      inlineFdtable: files1.inlineFdtable,
      inlineFdtableAddress: hex(files1.inlineFdtableAddress),
      fdArrayCount: files1.fdArrayCount,
      wordBytes: files1.wordBytes,
      fdtable: {
        address: hex(files1.fdtable.address),
        maxFds: files1.fdtable.maxFds,
        fdArray: hexOrNull(files1.fdtable.fdArray),
        openFds: hexOrNull(files1.fdtable.openFds),
        closeOnExec: hexOrNull(files1.fdtable.closeOnExec),
        fullFdsBits: hexOrNull(files1.fdtable.fullFdsBits),
        rcuHead: hex(files1.fdtable.rcuHead),
      },
      gdb: refFiles,
      gdbFdtable: refFdtable,
      compared: filesCompared,
      mismatches: [...filesMismatches, ...fdtableMismatches],
      notes: files1.notes,
    };
    check(
      'T07d-V2 current 与 files_struct 两源一致：`__per_cpu_offset[0] + pcpu_hot.current_task`（我们）与 GDB 的 `%gs` 路径算出同一个任务、同一个 files（也与帧里的 %gs 基址相同）；`files_struct`/`fdtable` 的每个字段（含内嵌还是扩容后那份表、`rcu` 是内嵌结构不是指针）与 GDB 逐字段相同',
      gdbCurrent !== null && gdbCurrent === current1.taskAddress
        && gdbGsBase !== null && gsBaseFrame !== null && gdbGsBase === gsBaseFrame
        && gdbPcpuHot !== null && percpuBase0 !== null
        && filesMismatches.length === 0 && fdtableMismatches.length === 0
        && Number(refCurrent.pid) === Number(task1.pid)
        && refCurrent.comm === task1.comm,
      `__per_cpu_offset[0]=${hexOrNull(percpuBase0)} 帧里 %gs 基址=${hexOrNull(gsBaseFrame)} GDB $gs_base=${hexOrNull(gdbGsBase)}；`
        + `current：我们=${hex(current1.taskAddress)} GDB=${hexOrNull(gdbCurrent)}；`
        + `pid/comm：我们=${task1.pid}/${task1.comm} GDB=${refCurrent.pid}/${refCurrent.comm}；`
        + `files=${hex(files1.address)}（GDB ${hexOrNull(refBig(refCurrent.filesAddress))}）；`
        + `表形态=${files1.inlineFdtable ? '内嵌 fdtab' : '扩容表'} max_fds=${files1.fdtable.maxFds}；`
        + `字段比对 ${filesCompared} 次，不一致 ${filesMismatches.length + fdtableMismatches.length}`
        + `${filesMismatches.length + fdtableMismatches.length === 0 ? '' : `：${[...filesMismatches, ...fdtableMismatches].slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V3 fd 位图：打开的 fd 逐位、以及 full_fds_bits 的真实粒度 ----------

    /**
     * 这里要验的不是"读出了几个非零位"，而是**位图的粒度**。
     *
     * `fs/file.c` 里置位分两步：`__set_bit(fd, fdt->open_fds)` 之后
     * `fd /= BITS_PER_LONG; if (!~fdt->open_fds[fd]) __set_bit(fd, fdt->full_fds_bits)` ——
     * 也就是说 `full_fds_bits` 的第 i 位对应的是 **`open_fds` 的第 i 个字**，而不是第 i 个 fd。
     * 把两者按同一个 64 位粒度分字，一张 64 个 fd 的表里就会去 `full_fds_bits` 读 64 位、
     * 而它真的只需要 1 位；读出来的内容（全 0）看着完全正常，只是**含义**已经错了。
     */
    const bitmaps1 = await readFdBitmaps(view1, layout, files1);
    const openFds1 = await listOpenFds(view1, layout, files1);
    const bitsPerWord = files1.wordBytes * 8;
    const wordAllOnes = (1n << BigInt(bitsPerWord)) - 1n;
    const collectBits = (words, maxFds) => {
      const out = [];
      for (let word = 0; word < words.length; word += 1) {
        for (let bit = 0; bit < bitsPerWord; bit += 1) {
          const fd = word * bitsPerWord + bit;
          if (fd >= maxFds) break;
          if ((((words[word] ?? 0n) >> BigInt(bit)) & 1n) === 1n) out.push(fd);
        }
      }
      return out;
    };
    const oursOpenBits = collectBits(bitmaps1.openFds, bitmaps1.maxFds);
    const oursCloseBits = collectBits(bitmaps1.closeOnExec, bitmaps1.maxFds);

    const bitWordPairs = [
      ['openFds', 'openWords'], ['closeOnExec', 'closeOnExecWords'], ['fullFdsBits', 'fullFdsBitsWords'],
    ];
    const bitWordMismatches = [];
    let bitWordsCompared = 0;
    for (const [mineKey, refKey] of bitWordPairs) {
      const mine = bitmaps1[mineKey];
      const theirs = Array.isArray(refBitmaps[refKey]) ? refBitmaps[refKey] : [];
      if (mine.length !== theirs.length) {
        bitWordMismatches.push(`${mineKey} 的字数：我们=${mine.length} GDB=${theirs.length}`);
      }
      for (let index = 0; index < Math.max(mine.length, theirs.length); index += 1) {
        bitWordsCompared += 1;
        const a = mine[index] ?? null;
        const b = theirs[index] === undefined ? null : asBig(theirs[index]);
        if (a === null || b === null || a !== b) {
          bitWordMismatches.push(`${mineKey}[第 ${index} 个字]：我们=${hexOrNull(a)} GDB=${hexOrNull(b)}`);
        }
      }
    }
    const refOpenBits = (refBitmaps.openBits ?? []).map((value) => Number(value));
    const refCloseBits = (refBitmaps.closeOnExecBits ?? []).map((value) => Number(value));
    const sameNumberList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

    // `full_fds_bits` 的语义：第 i 位 ⇔ `open_fds[i]` 整字全 1。这一条是**从源码推出来的**
    // 独立结论，不是把同一个值换个地方再读一遍。
    const fullFdsBitAt = (index) => (
      ((bitmaps1.fullFdsBits[Math.floor(index / bitsPerWord)] ?? 0n) >> BigInt(index % bitsPerWord)) & 1n
    );
    const fullFdsSemantics = [];
    for (let index = 0; index < bitmaps1.openFds.length; index += 1) {
      const expected = bitmaps1.openFds[index] === wordAllOnes ? 1n : 0n;
      if (fullFdsBitAt(index) !== expected) {
        fullFdsSemantics.push(
          `第 ${index} 个 open_fds 字（fd ${index * bitsPerWord} 起）：full_fds_bits 说 ${fullFdsBitAt(index)}，`
          + `按源码（该字全 1 才置位）应为 ${expected}`,
        );
      }
    }
    const fileSourceLines = fs.readFileSync(FILE_C, 'utf8').split('\n');
    const fullFdsSites = [];
    let fullFdsWordIndexEvidence = null;
    fileSourceLines.forEach((line, index) => {
      if (!line.includes('full_fds_bits')) return;
      fullFdsSites.push(`${index + 1}: ${line.trim()}`);
      const before = fileSourceLines.slice(Math.max(0, index - 4), index).join('\n');
      if (/fd\s*\/=\s*BITS_PER_LONG|BIT_WORD\s*\(\s*fd\s*\)/.test(before)) {
        fullFdsWordIndexEvidence = `fs/file.c:${index + 1}`;
      }
    });
    const inconsistentFds = openFds1.entries.filter((entry) => entry.inconsistent);
    evidence.fdBitmaps = {
      maxFds: bitmaps1.maxFds,
      wordBytes: files1.wordBytes,
      openFdsWords: bitmaps1.openFds.map((word) => hex(word)),
      closeOnExecWords: bitmaps1.closeOnExec.map((word) => hex(word)),
      fullFdsBitsWords: bitmaps1.fullFdsBits.map((word) => hex(word)),
      openBits: oursOpenBits,
      closeOnExecBits: oursCloseBits,
      openCount: bitmaps1.openCount,
      fullFdsBitsNonZeroWords: fullFdsSemantics.length === 0
        ? bitmaps1.fullFdsBits.map((word, index) => (word !== 0n ? index : -1)).filter((index) => index >= 0)
        : null,
      openFdEntries: openFds1.entries.map((entry) => ({
        fd: entry.fd, fileAddress: hex(entry.fileAddress), slotAddress: hex(entry.slotAddress),
        closeOnExec: entry.closeOnExec, inconsistent: entry.inconsistent,
      })),
      fullFdsSites,
      fullFdsWordIndexEvidence,
      gdb: refBitmaps,
      compared: bitWordsCompared,
      mismatches: bitWordMismatches,
      notes: [...bitmaps1.notes, ...openFds1.notes, ...openFds1.violations],
    };
    check(
      'T07d-V3 fd 位图逐位与 GDB 相同（三张位图的每个字、立着的位、openCount），'
        + '且 `full_fds_bits` 的粒度按 `fs/file.c` 的真实用法成立（它按 `open_fds` 的字分位，不是按 fd 分位）',
      bitWordMismatches.length === 0
        && sameNumberList(oursOpenBits, refOpenBits)
        && sameNumberList(oursCloseBits, refCloseBits)
        && Number(refBitmaps.openCount) === bitmaps1.openCount
        && bitmaps1.openCount === openFds1.entries.length
        && inconsistentFds.length === 0
        && fullFdsSemantics.length === 0
        && fullFdsWordIndexEvidence !== null
        && bitmaps1.maxFds % bitsPerWord === 0
        && oursOpenBits.includes(3),
      `max_fds=${bitmaps1.maxFds}（${files1.wordBytes} 字节字，${bitmaps1.openFds.length} 个字）；`
        + `打开的 fd=[${oursOpenBits.join(',')}]（GDB=[${refOpenBits.join(',')}]）openCount=${bitmaps1.openCount}；`
        + `open_fds=${bitmaps1.openFds.map(hex).join(' ')}；full_fds_bits=${bitmaps1.fullFdsBits.map(hex).join(' ')}；`
        + `full_fds_bits 粒度证据=${fullFdsWordIndexEvidence ?? '没在 fs/file.c 里找到 fd 折成字号的语句'}；`
        + `字比对 ${bitWordsCompared} 次，不一致 ${bitWordMismatches.length}`
        + `${bitWordMismatches.length === 0 ? '' : `：${bitWordMismatches.slice(0, 6).join(' | ')}`}`
        + `${fullFdsSemantics.length === 0 ? '' : `；粒度不符：${fullFdsSemantics.join(' | ')}`}`,
    );

    // ---------- V4 struct file：逐字段 + HMP 的原始字 + 两个位表 ----------

    /**
     * 跨通道比较的小工具：把"我们读到的"和"另一套实现读到的"按字段比。
     * 只比对面**给得出**的字段 —— GDB 侧读不到的字段是 `null`，那是"这次没读到"，
     * 不该算成"对不上"，否则一次读不到会把整轮结论染红。
     */
    const fmtValue = (value) => {
      if (value === null || value === undefined) return 'null';
      const big = typeof value === 'bigint' ? value : BigInt(value);
      if (big < 0n || big > 0xFFFFFFFFn) return hex(big);
      return `${big}(0x${big.toString(16)})`;
    };
    const compareFieldPairs = (pairs) => {
      const mismatches = [];
      const nullForZero = [];
      let compared = 0;
      for (const [label, mine, theirs] of pairs) {
        if (theirs === null || theirs === undefined) continue;
        compared += 1;
        let target = null;
        try { target = BigInt(theirs); } catch { mismatches.push(`${label}：GDB 的值 ${theirs} 不是整数`); continue; }
        if (mine === null || mine === undefined) {
          // 我方把"这个指针是空的"读成 `null`（读到 0 就不返回 0n），GDB 那侧把空指针报成 0。
          // 同一件事的两种写法，记一笔账但不判成对不上；只有"一边空、另一边不是 0"才是真不一致。
          if (target === 0n) { nullForZero.push(label); continue; }
          mismatches.push(`${label}：我们读不到，GDB=${fmtValue(theirs)}`);
          continue;
        }
        if (BigInt(mine) !== target) mismatches.push(`${label}：我们=${fmtValue(mine)} GDB=${fmtValue(theirs)}`);
      }
      return { compared, mismatches, nullForZero };
    };

    const file1 = fileFromFd3 === null ? null : await readFile(view1, layout, fileFromFd3, {
      fd: 3, enabledConfigs: localConfigs,
    });
    if (file1 === null) throw new Error('fd 3 的槽是空的：取不到 lab-read 正在读的那个 struct file');

    const refFilePath = refFile.path ?? {};
    const fileFields = compareFieldPairs([
      ['f_count', file1.fCount, refFile.fCount],
      ['f_mode', file1.fMode, refFile.fMode],
      ['f_flags', file1.fFlags, refFile.fFlags],
      ['f_iocb_flags', file1.fIocbFlags, refFile.fIocbFlags],
      ['f_pos', file1.fPos, refFile.fPos],
      ['f_op', file1.fOp, refFile.fOp],
      ['f_mapping', file1.fMapping, refFile.fMapping],
      ['private_data', file1.privateData, refFile.privateData],
      ['f_inode', file1.fInode, refFile.fInode],
      ['f_cred', file1.fCred, refFile.fCred],
      ['f_wb_err', file1.fWbErr, refFile.fWbErr],
      ['&f_path', file1.path.address, refFilePath.address],
      ['f_path.mnt', file1.path.mnt, refFilePath.mnt],
      ['f_path.dentry', file1.path.dentry, refFilePath.dentry],
    ]);
    const fileFromFd1 = await readFile(view1, layout, fileFromFd3, { fd: null, enabledConfigs: localConfigs });
    if (fileFromFd1.fd !== null) fileFields.mismatches.push(`fd 参数：按地址读时 fd 应为 null，实际 ${fileFromFd1.fd}`);

    /**
     * 通道四：QEMU 的 HMP。`x/32gx` 一次把 `struct file` 的前 256 字节原样打出来，
     * 这是**第三种读内存实现**（既不经过我们的采集器，也不经过 GDB 的 DWARF）。
     * 每个字段的偏移仍然由布局清单给出，比对的是"同一段字节在这条通道上读出来是什么"。
     */
    const fileOffsetOf = (name) => {
      try { return Number(layout.byteOffset('file', name)); } catch { return null; }
    };
    const pathOffsetOf = (name) => {
      const base = fileOffsetOf('f_path');
      if (base === null) return null;
      try { return base + Number(layout.byteOffset('path', name)); } catch { return null; }
    };
    const hmpFileWords = await hmpWords(live, file1.address, 32);
    // `hmpWords` 返回的是 `{ raw, words }`（原始文本 + 解析出的 64 位字），不是裸数组；
    // 下面统一走 `.words`，`raw` 存进证据便于人工复核"这行字确实来自 QEMU"。
    const hmpWordsList = hmpFileWords.words;
    const hmpPairs = [];
    const addHmpPair = (label, offset, width, mine) => {
      if (offset === null || (width === 8 && offset % 8 !== 0)) return;
      const wordIndex = Math.floor(offset / 8);
      if (wordIndex >= hmpWordsList.length) return;
      const shift = BigInt((offset % 8) * 8);
      const mask = (1n << BigInt(width * 8)) - 1n;
      hmpPairs.push([label, mine === null ? null : u64(BigInt(mine)), (hmpWordsList[wordIndex] >> shift) & mask]);
    };
    addHmpPair('f_count', fileOffsetOf('f_count'), 8, file1.fCount);
    addHmpPair('f_mode', fileOffsetOf('f_mode'), 4, file1.fMode);
    addHmpPair('f_flags', fileOffsetOf('f_flags'), 4, file1.fFlags);
    addHmpPair('f_iocb_flags', fileOffsetOf('f_iocb_flags'), 4, file1.fIocbFlags);
    addHmpPair('f_pos', fileOffsetOf('f_pos'), 8, file1.fPos);
    addHmpPair('f_op', fileOffsetOf('f_op'), 8, file1.fOp);
    addHmpPair('f_mapping', fileOffsetOf('f_mapping'), 8, file1.fMapping);
    addHmpPair('f_inode', fileOffsetOf('f_inode'), 8, file1.fInode);
    addHmpPair('private_data', fileOffsetOf('private_data'), 8, file1.privateData);
    addHmpPair('f_cred', fileOffsetOf('f_cred'), 8, file1.fCred);
    addHmpPair('f_path.mnt', pathOffsetOf('mnt'), 8, file1.path.mnt);
    addHmpPair('f_path.dentry', pathOffsetOf('dentry'), 8, file1.path.dentry);
    const hmpResult = compareFieldPairs(hmpPairs);
    const gdbDecodeAgrees = (() => {
      const theirs = refFile.fModeDecoded ?? {};
      const theirNames = (theirs.names ?? []).map(String).sort();
      const ourNames = [...file1.fModeNames].sort();
      return sameNumberList(ourNames, theirNames) && Number(theirs.unknownBits ?? 0) === file1.fModeUnknownBits;
    })();
    const refFlagsDecoded = refFile.fFlagsDecoded ?? {};
    const flagsDecodeAgrees = String(refFlagsDecoded.accessMode ?? '') === file1.fFlagsDecoded.accessMode
      && Number(refFlagsDecoded.accessModeRaw ?? -1) === file1.fFlagsDecoded.accessModeRaw
      && Number(refFlagsDecoded.unknownBits ?? -1) === file1.fFlagsDecoded.unknownBits
      && sameNumberList(
        [...file1.fFlagsDecoded.names.map((entry) => entry.name)].sort(),
        (refFlagsDecoded.names ?? []).map(String).sort(),
      )
      && sameNumberList([...file1.fFlagsDecoded.composites].sort(), (refFlagsDecoded.composites ?? []).map(String).sort());

    evidence.file = {
      address: hex(file1.address),
      fCount: hex(file1.fCount),
      fMode: file1.fMode,
      fModeNames: file1.fModeNames,
      fModeUnknownBits: file1.fModeUnknownBits,
      fFlags: file1.fFlags,
      fFlagsDecoded: {
        names: file1.fFlagsDecoded.names.map((entry) => entry.name),
        composites: file1.fFlagsDecoded.composites,
        accessMode: file1.fFlagsDecoded.accessMode,
        accessModeRaw: file1.fFlagsDecoded.accessModeRaw,
        unknownBits: file1.fFlagsDecoded.unknownBits,
      },
      fIocbFlags: file1.fIocbFlags,
      fPos: file1.fPos.toString(),
      fOp: hexOrNull(file1.fOp),
      fMapping: hexOrNull(file1.fMapping),
      privateData: hexOrNull(file1.privateData),
      fInode: hexOrNull(file1.fInode),
      fCred: hexOrNull(file1.fCred),
      fWbErr: file1.fWbErr,
      path: {
        address: hex(file1.path.address),
        mnt: hexOrNull(file1.path.mnt),
        dentry: hexOrNull(file1.path.dentry),
      },
      notes: file1.notes,
      gdb: refFile,
      gdbCompared: fileFields.compared,
      gdbMismatches: fileFields.mismatches,
      hmp: {
        raw: hmpFileWords.raw,
        words: hmpWordsList.map((word) => hex(word)),
        compared: hmpResult.compared,
        mismatches: hmpResult.mismatches,
      },
    };
    check(
      'T07d-V4 `struct file` 逐字段与 GDB 相同；HMP `x/gx` 读到的原始字与我们的字段逐个相同（第三种读内存实现）；'
        + '`f_mode` 解出的名字与 GDB 的解码相同；`f_flags` 的访问模式是 O_RDONLY（用户 open 时给的就是只读）',
      fileFields.compared >= 10 && fileFields.mismatches.length === 0
        && hmpResult.compared >= 8 && hmpResult.mismatches.length === 0
        && gdbDecodeAgrees && flagsDecodeAgrees
        && file1.fModeNames.includes('FMODE_READ') && !file1.fModeNames.includes('FMODE_WRITE')
        && file1.fFlagsDecoded.accessMode === 'O_RDONLY' && file1.fFlagsDecoded.accessModeRaw === 0
        && file1.fPos === 0n
        && file1.path.dentry !== null && file1.path.mnt !== null,
      `file=${hex(file1.address)} f_count=${file1.fCount} f_mode=${fmtValue(file1.fMode)}（${file1.fModeNames.join('+') || '无位'}）`
        + ` f_flags=${fmtValue(file1.fFlags)}（${file1.fFlagsDecoded.accessMode}${file1.fFlagsDecoded.names.length === 0 ? '' : `+${file1.fFlagsDecoded.names.map((e) => e.name).join('+')}`}）`
        + ` f_pos=${file1.fPos} f_inode=${hexOrNull(file1.fInode)} f_mapping=${hexOrNull(file1.fMapping)}；`
        + `字段比对 ${fileFields.compared} 次（不一致 ${fileFields.mismatches.length}）`
        + `${fileFields.mismatches.length === 0 ? '' : `：${fileFields.mismatches.slice(0, 6).join(' | ')}`}；`
        + `HMP 比对 ${hmpResult.compared} 次（不一致 ${hmpResult.mismatches.length}）`
        + `${hmpResult.mismatches.length === 0 ? '' : `：${hmpResult.mismatches.slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V5 dentry：逐字段 + 名字的两种存法 + d_flags 的三位类型字段 ----------

    /**
     * `dentry` 这一段最容易出的错不是"读错地址"，而是**名字读错地方**：
     * `d_name.name` 指回 `d_iname` 时名字在结构里，指向别处时它在 `struct external_name`
     * 的 `name[]` 里。判据是内核的 `dname_external()`（`dentry->d_name.name != dentry->d_iname`），
     * 所以这里把它**从源码现场读出来**，而不是照抄一句注释；而且两份源码都要扫 ——
     * 6.12 里这个函数定义在 `fs/dcache.c`，头文件里没有。
     */
    const dcacheText = fs.readFileSync(DCACHE_H, 'utf8');
    const dcacheCText = fs.readFileSync(DCACHE_C, 'utf8');
    const dcacheFacts = readDcacheNameFacts([
      { file: DCACHE_H, text: dcacheText },
      { file: DCACHE_C, text: dcacheCText },
    ], localConfigs);
    const dcacheTable = readDefineTable(dcacheText);
    const dentry1 = file1.path.dentry === null ? null : await readDentry(view1, layout, file1.path.dentry, {
      enabledConfigs: localConfigs,
    });
    if (dentry1 === null) throw new Error('`f_path.dentry` 是空的：取不到这个文件的目录项');
    const dentryFields = compareFieldPairs([
      ['d_flags', dentry1.dFlags, refDentry.dFlags],
      ['d_parent', dentry1.parent, refDentry.parent],
      ['d_inode', dentry1.inode, refDentry.inode],
      ['d_sb', dentry1.superBlock, refDentry.superBlock],
      ['d_op', dentry1.dentryOps, refDentry.dentryOps],
      ['d_name.hash', dentry1.name.hash, refDentry.nameHash],
      ['d_name.len', dentry1.name.len, refDentry.nameLen],
      ['d_name.name', dentry1.name.nameAddress, refDentry.namePointer],
      ['&d_iname', dentry1.name.inlineAddress, refDentry.dInameAddress],
    ]);
    const refEntryTypeRaw = refDentry.dFlagsDecoded?.entryTypeRaw ?? null;
    const refEntryTypeName = refDentry.dFlagsDecoded?.entryTypeName ?? null;
    const sourceRegularType = resolveDefineAll(dcacheTable, 'DCACHE_REGULAR_TYPE');
    const nameTextAgrees = dentry1.name.text !== null && dentry1.name.text === refDentry.nameText;
    const externalAgrees = dentry1.name.external !== null && refDentry.external !== null
      && Boolean(dentry1.name.external) === Boolean(refDentry.external);
    evidence.dentry = {
      address: hex(dentry1.address),
      dFlags: dentry1.dFlags,
      dFlagsDecoded: {
        names: dentry1.dFlagsDecoded.names.map((entry) => entry.name),
        entryTypeRaw: dentry1.dFlagsDecoded.entryType.raw,
        entryTypeName: dentry1.dFlagsDecoded.entryType.name,
        unknownBits: dentry1.dFlagsDecoded.unknownBits,
      },
      parent: hexOrNull(dentry1.parent),
      inode: hexOrNull(dentry1.inode),
      superBlock: hexOrNull(dentry1.superBlock),
      dentryOps: hexOrNull(dentry1.dentryOps),
      isSelfParent: dentry1.isSelfParent,
      name: {
        hash: dentry1.name.hash,
        len: dentry1.name.len,
        nameAddress: hexOrNull(dentry1.name.nameAddress),
        inlineAddress: hex(dentry1.name.inlineAddress),
        inlineCapacity: dentry1.name.inlineCapacity,
        external: dentry1.name.external,
        text: dentry1.name.text,
        consistent: dentry1.name.consistent,
        unavailableReason: dentry1.name.unavailableReason,
      },
      sourceFacts: {
        dnameExternalJudgement: dcacheFacts.comparesNameToIname,
        dnameExternalSource: dcacheFacts.externalSource,
        dnameExternalLine: dcacheFacts.judgeLine,
        dnameInlineLen: dcacheFacts.inlineLen,
        dnameInlineLenLine: dcacheFacts.inlineLenLine,
        dnameInlineLenBranches: dcacheFacts.inlineLenBranches,
        dcacheRegularType: [...sourceRegularType].map(String),
      },
      gdb: refDentry,
      compared: dentryFields.compared,
      mismatches: dentryFields.mismatches,
      notes: dentry1.notes,
    };
    check(
      'T07d-V5 `dentry` 逐字段与 GDB 相同；名字按源码判据 `d_name.name != &d_iname` 判成内嵌；'
        + '名字文本就是 `hello.txt`；名字数组的容量与源码按本内核配置选出的 `DNAME_INLINE_LEN` 相等；'
        + '`d_flags` 的三位类型字段解成 `DCACHE_REGULAR_TYPE`（6 个独立事实同时成立）',
      dentryFields.compared >= 7 && dentryFields.mismatches.length === 0
        && nameTextAgrees && externalAgrees
        && dentry1.name.external === false
        && dentry1.name.nameAddress === dentry1.name.inlineAddress
        && dentry1.name.consistent === true
        && dcacheFacts.comparesNameToIname === true
        && dcacheFacts.inlineLen !== null && dentry1.name.inlineCapacity === dcacheFacts.inlineLen
        && dentry1.dFlagsDecoded.entryType.raw === refEntryTypeRaw
        && dentry1.dFlagsDecoded.entryType.name === refEntryTypeName
        && dentry1.dFlagsDecoded.entryType.name === 'DCACHE_REGULAR_TYPE'
        && sourceRegularType.has(BigInt(dentry1.dFlagsDecoded.entryType.raw))
        && (dentry1.inode !== null && dentry1.inode === file1.fInode),
      `dentry=${hex(dentry1.address)} d_flags=${fmtValue(dentry1.dFlags)}（${dentry1.dFlagsDecoded.names.map((e) => e.name).join('+') || '无单位位'}`
        + ` 类型字段=${fmtValue(dentry1.dFlagsDecoded.entryType.raw)}=${dentry1.dFlagsDecoded.entryType.name}）`
        + ` d_parent=${hexOrNull(dentry1.parent)} d_inode=${hexOrNull(dentry1.inode)}；`
        + `名字：len=${dentry1.name.len} hash=${fmtValue(dentry1.name.hash)} 指针=${hexOrNull(dentry1.name.nameAddress)}`
        + ` 内嵌数组=${hex(dentry1.name.inlineAddress)}（容量 ${dentry1.name.inlineCapacity}）`
        + ` 外部=${dentry1.name.external} 文本=${JSON.stringify(dentry1.name.text)}；`
        + `源码判据：dname_external=${dcacheFacts.comparesNameToIname}`
        + `（来自 ${dcacheFacts.externalSource ?? '没找到'}：${dcacheFacts.judgeLine ?? '没找到那一行'}）`
        + ` DNAME_INLINE_LEN=${dcacheFacts.inlineLen}（取自 ${dcacheFacts.inlineLenLine ?? '没找到'}）；`
        + `字段比对 ${dentryFields.compared} 次（不一致 ${dentryFields.mismatches.length}）`
        + `${dentryFields.mismatches.length === 0 ? '' : `：${dentryFields.mismatches.slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V6 路径：我们 / GDB / 客体 readlink 三处拼出同一条路径 ----------

    const path1 = await resolveDentryPath(view1, layout, file1.path.dentry, { enabledConfigs: localConfigs });
    const refPathNames = (refPath.components ?? []).map((entry) => entry.nameText ?? null);
    const ourPathNames = path1.components.map((entry) => entry.name);
    const ourDepthRight = path1.components.length === (refPath.components ?? []).length;
    const topAgrees = ourDepthRight && path1.components.length > 0
      && path1.components[0].dentry === asBig((refPath.components ?? [])[0]?.address ?? null);
    const leafAgrees = path1.components.length > 0
      && path1.components[path1.components.length - 1].dentry === dentry1.address;
    evidence.path = {
      path: path1.path,
      rooted: path1.rooted,
      depth: path1.depth,
      truncated: path1.truncated,
      cycle: path1.cycle,
      issues: path1.issues,
      notes: path1.notes,
      components: path1.components.map((entry) => ({
        dentry: hex(entry.dentry), name: entry.name, inode: hexOrNull(entry.inode),
        mountPoint: entry.mountPoint, issue: entry.issue,
      })),
      gdb: { path: refPath.path, rooted: refPath.rooted, cycle: refPath.cycle, truncated: refPath.truncated, names: refPathNames },
      guest: {
        readlink: guestPath,
        mountSource: '客体里另一个进程 exec 7< 同一个文件后 readlink /proc/$$/fd/7',
      },
    };
    check(
      `T07d-V6 路径三方一致：我们沿 \`d_parent\` 拼出 ${path1.path ?? '（拼不出）'}、GDB 自己走一遍也是 `
        + `${refPath.path ?? '（拼不出）'}、客体真实 \`readlink\` 报的是 ${guestPath ?? '（没拿到）'}；且走到根（父指针指向自己）、无环、无截断`,
      path1.path === LAB_FILE && refPath.path === LAB_FILE && guestPath === LAB_FILE
        && path1.rooted === true && path1.cycle === false && path1.truncated === false
        && ourDepthRight && topAgrees && leafAgrees
        && sameNumberList(ourPathNames, refPathNames.map((name) => String(name))),
      `路径=/${path1.path === null ? '' : path1.path.replace(/^\//, '')} 深度=${path1.depth}（GDB ${(refPath.components ?? []).length}）；`
        + `各级名字=[${ourPathNames.map((name) => JSON.stringify(name)).join(', ')}]；`
        + `rooted=${path1.rooted} cycle=${path1.cycle} truncated=${path1.truncated}；`
        + `叶子 dentry=${hex(path1.components[path1.components.length - 1]?.dentry ?? 0n)}=f_path.dentry=${hex(dentry1.address)}`,
    );

    // ---------- V7 inode：逐字段 + 与客体 stat 的四个字段完全相同 ----------

    const inode1 = file1.fInode === null ? null : await readInode(view1, layout, file1.fInode);
    if (inode1 === null) throw new Error('`f_inode` 是空的：普通文件的 file 不该没有 inode');
    const inodeFields = compareFieldPairs([
      ['i_mode', inode1.mode, refInode.mode],
      ['i_uid', inode1.uid, refInode.uid],
      ['i_gid', inode1.gid, refInode.gid],
      ['i_flags', inode1.flags, refInode.flags],
      ['i_ino', inode1.ino, refInode.ino],
      ['i_nlink', inode1.nlink, refInode.nlink],
      ['i_rdev', inode1.rdev, refInode.rdev],
      ['i_size', inode1.size, refInode.size],
      ['i_bytes', inode1.bytes, refInode.bytes],
      ['i_blkbits', inode1.blkbits, refInode.blkbits],
      ['i_blocks', inode1.blocks, refInode.blocks],
      ['i_state', inode1.state, refInode.state],
      ['i_count', inode1.count, refInode.count],
      ['i_dio_count', inode1.dioCount, refInode.dioCount],
      ['i_writecount', inode1.writeCount, refInode.writeCount],
      ['i_sb', inode1.superBlock, refInode.superBlock],
      ['i_mapping', inode1.mapping, refInode.mapping],
      ['i_op', inode1.inodeOps, refInode.inodeOps],
      ['i_fop', inode1.fops, refInode.fops],
      ['i_private', inode1.isPrivate, refInode.isPrivate],
    ]);
    const inodeStateAgrees = sameNumberList(
      [...inode1.stateNames].sort(),
      (refInode.stateDecoded?.names ?? []).map(String).sort(),
    ) && Number(refInode.stateDecoded?.dirty ? 1 : 0) === (inode1.dirty ? 1 : 0)
      && Number(refInode.stateDecoded?.dirtyTime ? 1 : 0) === (inode1.dirtyTime ? 1 : 0);
    const guestInodeAgrees = guestStat !== null
      && guestStat.ino === inode1.ino
      && guestStat.size === inode1.size
      && guestStat.mode === inode1.mode
      && guestStat.nlink === inode1.nlink
      && guestStat.uid === inode1.uid
      && guestStat.gid === inode1.gid;
    const posAgrees = guestFdinfo.pos !== null && guestFdinfo.pos === file1.fPos;
    evidence.inode = {
      address: hex(inode1.address),
      mode: inode1.mode,
      modeDecoded: inode1.modeDecoded,
      uid: inode1.uid,
      gid: inode1.gid,
      flags: inode1.flags,
      ino: inode1.ino.toString(),
      nlink: inode1.nlink,
      rdev: inode1.rdev.toString(),
      rdevDecoded: inode1.rdevDecoded,
      size: inode1.size.toString(),
      bytes: inode1.bytes,
      blkbits: inode1.blkbits,
      blocks: inode1.blocks.toString(),
      state: inode1.state,
      stateNames: inode1.stateNames,
      dirty: inode1.dirty,
      dirtyTime: inode1.dirtyTime,
      count: inode1.count,
      dioCount: inode1.dioCount,
      writeCount: inode1.writeCount,
      superBlock: hexOrNull(inode1.superBlock),
      mapping: hexOrNull(inode1.mapping),
      inodeOps: hexOrNull(inode1.inodeOps),
      fops: hexOrNull(inode1.fops),
      isPrivate: hexOrNull(inode1.isPrivate),
      gdb: refInode,
      guest: guestStat === null ? null : {
        ino: guestStat.ino.toString(), size: guestStat.size.toString(),
        mode: `0o${guestStat.mode.toString(8)}`, nlink: guestStat.nlink,
        uid: guestStat.uid, gid: guestStat.gid, blksize: guestStat.blksize.toString(),
      },
      compared: inodeFields.compared,
      mismatches: inodeFields.mismatches,
      notes: inode1.notes,
    };
    check(
      'T07d-V7 `inode` 逐字段与 GDB 相同；`i_mode` 是普通文件（S_IFREG）且权限 644；'
        + '`i_ino`/`i_size`/`i_mode`/`i_nlink`/`i_uid`/`i_gid` 与客体 `stat` 报的完全相同；`f_pos` 与客体 fdinfo 的 `pos` 相同',
      inodeFields.compared >= 15 && inodeFields.mismatches.length === 0
        && inode1.modeDecoded.type === 'S_IFREG'
        && (inode1.mode & 0o7777) === 0o644
        && inode1.modeDecoded.permissions.includes('644')
        && guestInodeAgrees && posAgrees
        && inodeStateAgrees
        && inode1.blkbits === 12
        && guestStat !== null && (1n << BigInt(inode1.blkbits)) === guestStat.blksize,
      `inode=${hex(inode1.address)} i_mode=${fmtValue(inode1.mode)}=0o${inode1.mode.toString(8)}（${inode1.modeDecoded.type} ${inode1.modeDecoded.permissions}）`
        + ` 权限位=${fmtValue(inode1.mode & 0o7777)}；`
        + `i_ino=${inode1.ino} i_size=${inode1.size} i_nlink=${inode1.nlink} i_uid=${inode1.uid} i_gid=${inode1.gid}`
        + `（客体 stat：ino=${guestStat?.ino} size=${guestStat?.size} mode=0o${guestStat?.mode.toString(8)} nlink=${guestStat?.nlink} uid=${guestStat?.uid} gid=${guestStat?.gid}）`
        + ` f_pos=${file1.fPos}（客体 fdinfo pos=${guestFdinfo.pos}）；`
        + `i_blkbits=${inode1.blkbits} → ${1n << BigInt(inode1.blkbits)}（客体 st_blksize=${guestStat?.blksize}）；`
        + `字段比对 ${inodeFields.compared} 次（不一致 ${inodeFields.mismatches.length}）`
        + `${inodeFields.mismatches.length === 0 ? '' : `：${inodeFields.mismatches.slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V8 super_block：逐字段 + s_dev 与客体 st_dev 的编码关系 + 魔数 ----------

    /**
     * `stat()` 报出来的 `st_dev` 与 `super_block.s_dev` **不是同一个数**，这一点必须当场算清楚：
     * `fs/stat.c` 的 `cp_new_stat()` 写的是 `tmp.st_dev = new_encode_dev(stat->dev)`（x86_64 用
     * `struct stat`、不走 `cp_new_stat64` 那条 `huge_encode_dev`），而 `new_encode_dev()` 在
     * `include/linux/kdev_t.h` 里是 `(minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12)`。
     * 所以要比的是"经内核那套 uapi 编码之后"的值；直接拿两个数相等来判，会永远判不过，
     * 而且很容易被误认为"s_dev 读错了"。
     */
    const newEncodeDev = (dev) => {
      const value = BigInt(dev) & 0xFFFFFFFFn;
      const major = value >> BigInt(MINORBITS);
      const minor = value & ((1n << BigInt(MINORBITS)) - 1n);
      return ((minor & 0xffn) | (major << 8n) | ((minor & ~0xffn) << 12n)) & 0xFFFFFFFFn;
    };
    const super1 = inode1.superBlock === null ? null : await readSuperBlock(view1, layout, inode1.superBlock);
    if (super1 === null) throw new Error('`i_sb` 是空的：inode 必然属于某个超级块');
    const superFields = compareFieldPairs([
      ['s_dev', super1.dev, refSuper.dev],
      ['s_blocksize', super1.blocksize, refSuper.blocksize],
      ['s_blocksize_bits', super1.blocksizeBits, refSuper.blocksizeBits],
      ['s_maxbytes', super1.maxbytes, refSuper.maxbytes],
      ['s_type', super1.fsType, refSuper.fsType],
      ['s_op', super1.superOps, refSuper.superOps],
      ['s_flags', super1.flags, refSuper.flags],
      ['s_magic', super1.magic, refSuper.magic],
      ['s_root', super1.rootDentry, refSuper.rootDentry],
      ['s_count', super1.count, refSuper.count],
      ['s_active', super1.active, refSuper.active],
    ]);
    const ext2Magic = readExt2Magic(fs.readFileSync(MAGIC_H, 'utf8'));
    const superIdAgrees = typeof refSuper.id === 'string' && super1.id === refSuper.id;
    const guestDevAgrees = guestStat !== null && newEncodeDev(super1.dev) === guestStat.dev;
    evidence.superBlock = {
      address: hex(super1.address),
      dev: hex(super1.dev),
      devDecoded: super1.devDecoded,
      blocksize: super1.blocksize.toString(),
      blocksizeBits: super1.blocksizeBits,
      maxbytes: super1.maxbytes.toString(),
      fsType: hexOrNull(super1.fsType),
      superOps: hexOrNull(super1.superOps),
      flags: hex(super1.flags),
      iflags: hex(super1.iflags),
      magic: hex(super1.magic),
      rootDentry: hexOrNull(super1.rootDentry),
      count: super1.count,
      active: super1.active,
      id: super1.id,
      fsInfo: hexOrNull(super1.fsInfo),
      sourceMagic: ext2Magic === null ? null : hex(ext2Magic),
      guestDev: guestStat === null ? null : guestStat.dev.toString(),
      encodedDev: hex(newEncodeDev(super1.dev)),
      gdb: refSuper,
      compared: superFields.compared,
      mismatches: superFields.mismatches,
      notes: super1.notes,
    };
    check(
      'T07d-V8 `super_block` 逐字段与 GDB 相同；`s_magic` 等于源码里的 `EXT2_SUPER_MAGIC`；'
        + '`s_dev` 经内核那套 `new_encode_dev()` 编码后等于客体 `stat` 报的 `st_dev`；`s_blocksize`=4096（=客体 st_blksize）',
      superFields.compared >= 10 && superFields.mismatches.length === 0
        && ext2Magic !== null && super1.magic === ext2Magic
        && guestDevAgrees && superIdAgrees
        && super1.blocksize === 4096n && super1.blocksizeBits === 12
        && super1.maxbytes > 0n
        && super1.rootDentry !== null && super1.count > 0,
      `sb=${hex(super1.address)} s_id=${JSON.stringify(super1.id)} s_magic=${hex(super1.magic)}（源码 EXT2_SUPER_MAGIC=${hexOrNull(ext2Magic)}）`
        + ` s_blocksize=${super1.blocksize}（bits=${super1.blocksizeBits}）s_root=${hexOrNull(super1.rootDentry)} s_count=${super1.count}；`
        + `s_dev=${hex(super1.dev)}（${super1.devDecoded.text}）→ new_encode_dev=${hex(newEncodeDev(super1.dev))}`
        + ` / 客体 stat %d=${guestStat?.dev}；`
        + `字段比对 ${superFields.compared} 次（不一致 ${superFields.mismatches.length}）`
        + `${superFields.mismatches.length === 0 ? '' : `：${superFields.mismatches.slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V9 address_space：逐字段 + host 就是那个 inode + 三个指针同一份 ----------

    const mappingAddress = file1.fMapping ?? inode1.mapping;
    const addrSpace1 = mappingAddress === null ? null : await readAddressSpace(view1, layout, mappingAddress);
    if (addrSpace1 === null) throw new Error('`f_mapping` 与 `i_mapping` 都是空的：普通文件必然有页缓存');
    const mappingFields = compareFieldPairs([
      ['host', addrSpace1.host, refMapping.host],
      ['&i_pages', addrSpace1.pagesAddress, refMapping.pagesAddress],
      ['nrpages', addrSpace1.nrpages, refMapping.nrpages],
      ['writeback_index', addrSpace1.writebackIndex, refMapping.writebackIndex],
      ['a_ops', addrSpace1.aOps, refMapping.aOps],
      ['flags', addrSpace1.flags, refMapping.flags],
      ['gfp_mask', addrSpace1.gfpMask, refMapping.gfpMask],
      ['i_mmap_writable', addrSpace1.mmapWritable, refMapping.mmapWritable],
      ['i_private_data', addrSpace1.privateData, refMapping.privateData],
    ]);
    evidence.addressSpace = {
      address: hex(addrSpace1.address),
      host: hexOrNull(addrSpace1.host),
      pagesAddress: hex(addrSpace1.pagesAddress),
      nrpages: addrSpace1.nrpages.toString(),
      writebackIndex: addrSpace1.writebackIndex.toString(),
      aOps: hexOrNull(addrSpace1.aOps),
      flags: hex(addrSpace1.flags),
      gfpMask: addrSpace1.gfpMask,
      mmapWritable: addrSpace1.mmapWritable,
      privateData: hexOrNull(addrSpace1.privateData),
      pointers: {
        fileFMapping: hexOrNull(file1.fMapping),
        inodeIMapping: hexOrNull(inode1.mapping),
        resolved: hex(mappingAddress),
      },
      gdb: refMapping,
      compared: mappingFields.compared,
      mismatches: mappingFields.mismatches,
      notes: addrSpace1.notes,
    };
    check(
      'T07d-V9 `address_space` 逐字段与 GDB 相同；`host` 就是这条链上的那个 inode；'
        + '`file->f_mapping` / `inode->i_mapping` / 我们解析到的 address_space 是同一个地址（三个指针互为独立来源）',
      mappingFields.compared >= 7 && mappingFields.mismatches.length === 0
        && addrSpace1.host !== null && addrSpace1.host === inode1.address
        && file1.fMapping !== null && inode1.mapping !== null
        && file1.fMapping === inode1.mapping && file1.fMapping === addrSpace1.address
        && addrSpace1.pagesAddress === asBig(refMapping.pagesAddress)
        && addrSpace1.address === asBig(refMapping.address),
      `mapping=${hex(addrSpace1.address)} i_pages=${hex(addrSpace1.pagesAddress)} host=${hexOrNull(addrSpace1.host)}`
        + `（inode=${hex(inode1.address)}）nrpages=${addrSpace1.nrpages}；`
        + `三个指针：f_mapping=${hexOrNull(file1.fMapping)} i_mapping=${hexOrNull(inode1.mapping)}`
        + ` GDB addressSpace.address=${hexOrNull(asBig(refMapping.address))}；`
        + `字段比对 ${mappingFields.compared} 次（不一致 ${mappingFields.mismatches.length}）`
        + `${mappingFields.mismatches.length === 0 ? '' : `：${mappingFields.mismatches.slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V10 i_pages 这棵 XArray：与 GDB 自己重写的遍历逐项一致 ----------

    /**
     * 页缓存这一层最容易出的错是"把它当成数组或链表"：
     *   - `xa_head` 为 0 是**整棵树空**，不是"下标 0 是空"；
     *   - `xa_head` 不是节点指针时，它**本身就是下标 0 的那个条目**；
     *   - 逐级下降用的是 `node->shift` 的台阶（每级 6 位），不是"第几层"的计数。
     * 把 XArray 按"指针数组"读，第一条就已经是另一件事了 —— 而且读出来的照样是个
     * 合法的内核地址，拿去当 `struct page` 解能得出一份"像模像样"的页快照。
     *
     * 所以这里要拿 GDB **自己重写的那一遍遍历**逐项对：头形态、条目下标集合、
     * 每个条目的 kind/raw/pointer/value/span/slot/shift/node、节点地址集合；
     * 再加一路 HMP（宿主侧按当前页表直接读内存）把 `struct xarray` 的头几个字原样打出来。
     */
    const xarrayMulti = localConfigs.has('CONFIG_XARRAY_MULTI');
    const xarray1 = await walkXarray(view1, layout, addrSpace1.pagesAddress, {
      maxEntries: 64, xarrayMulti,
    });
    const hmpXarray = await hmpWords(live, addrSpace1.pagesAddress, 4);
    const xaFlagsOffset = Number(layout.byteOffset('xarray', 'xa_flags'));
    const xaHeadOffset = Number(layout.byteOffset('xarray', 'xa_head'));
    const hmpWordAt = (words, offset) => (offset % 8 === 0 ? (words[offset / 8] ?? null) : null);
    const hmpXaHead = hmpWordAt(hmpXarray.words, xaHeadOffset);
    const hmpXaFlagsWord = hmpWordAt(hmpXarray.words, 0);
    const hmpXaFlags = hmpXaFlagsWord === null
      ? null
      : (hmpXaFlagsWord >> BigInt(xaFlagsOffset * 8)) & 0xFFFFFFFFn;

    const refXaEntries = Array.isArray(refXarray.entries) ? refXarray.entries : [];
    const refXaByIndex = new Map(refXaEntries.map((entry) => [String(entry.index), entry]));
    const xaMismatches = [];
    let xaCompared = 0;
    const refBigOrNull = (value) => (value === null || value === undefined ? null : asBig(value));
    for (const entry of xarray1.entries) {
      const theirs = refXaByIndex.get(entry.index.toString());
      if (theirs === undefined) {
        xaMismatches.push(
          `下标 ${entry.index}：GDB 那份遍历里没有这个条目（我们 kind=${entry.kind} raw=${hex(entry.raw)}`
          + ` pointer=${hexOrNull(entry.pointer)}）`,
        );
        continue;
      }
      xaCompared += 1;
      const theirRaw = refBigOrNull(theirs.raw);
      const theirSpan = refBigOrNull(theirs.span);
      const theirPointer = refBigOrNull(theirs.pointer);
      const theirValue = refBigOrNull(theirs.value);
      const theirNode = refBigOrNull(theirs.node);
      const theirSlot = theirs.slot === null || theirs.slot === undefined ? null : Number(theirs.slot);
      const theirShift = theirs.shift === null || theirs.shift === undefined ? null : Number(theirs.shift);
      if (entry.raw !== theirRaw) xaMismatches.push(`下标 ${entry.index} raw：我们=${hex(entry.raw)} GDB=${hexOrNull(theirRaw)}`);
      if (theirs.kind !== undefined && entry.kind !== String(theirs.kind)) {
        xaMismatches.push(`下标 ${entry.index} kind：我们=${entry.kind} GDB=${theirs.kind}`);
      }
      if (entry.pointer !== theirPointer) {
        xaMismatches.push(`下标 ${entry.index} pointer：我们=${hexOrNull(entry.pointer)} GDB=${hexOrNull(theirPointer)}`);
      }
      if (entry.value !== theirValue) {
        xaMismatches.push(`下标 ${entry.index} value：我们=${hexOrNull(entry.value)} GDB=${hexOrNull(theirValue)}`);
      }
      if (entry.span !== theirSpan) xaMismatches.push(`下标 ${entry.index} span：我们=${entry.span} GDB=${theirSpan}`);
      if (entry.slot !== theirSlot) xaMismatches.push(`下标 ${entry.index} slot：我们=${entry.slot} GDB=${theirSlot}`);
      if (entry.shift !== theirShift) xaMismatches.push(`下标 ${entry.index} shift：我们=${entry.shift} GDB=${theirShift}`);
      if (entry.node !== theirNode) {
        xaMismatches.push(`下标 ${entry.index} node：我们=${hexOrNull(entry.node)} GDB=${hexOrNull(theirNode)}`);
      }
      if (entry.kind === 'error' && theirRaw !== null) {
        const theirErrno = Number(theirs.errno ?? NaN);
        if (!Number.isNaN(theirErrno) && theirErrno !== xaErr(entry.raw)) {
          xaMismatches.push(`下标 ${entry.index} errno：我们=${xaErr(entry.raw)} GDB=${theirErrno}`);
        }
      }
    }
    const xaHeadMismatches = [];
    if (xarray1.head !== asBig(refXarray.head)) {
      xaHeadMismatches.push(`xa_head：我们=${hex(xarray1.head)} GDB=${hexOrNull(asBig(refXarray.head))}`);
    }
    if (refXarray.headKind !== undefined && xarray1.headKind !== String(refXarray.headKind)) {
      xaHeadMismatches.push(`headKind：我们=${xarray1.headKind} GDB=${refXarray.headKind}`);
    }
    if (refXarray.rootShift !== undefined && refXarray.rootShift !== null
      && xarray1.rootShift !== Number(refXarray.rootShift)) {
      xaHeadMismatches.push(`rootShift：我们=${xarray1.rootShift} GDB=${refXarray.rootShift}`);
    }
    if (refXarray.xaFlags !== undefined && Number(refXarray.xaFlags) !== xarray1.xaFlags) {
      xaHeadMismatches.push(`xa_flags：我们=${xarray1.xaFlags} GDB=${refXarray.xaFlags}`);
    }
    if (hmpXaHead === null || hmpXaHead !== xarray1.head) {
      xaHeadMismatches.push(`HMP 读到的 xa_head：${hexOrNull(hmpXaHead)}，我们解析的是 ${hex(xarray1.head)}`);
    }
    if (hmpXaFlags === null || Number(hmpXaFlags) !== xarray1.xaFlags) {
      xaHeadMismatches.push(
        `HMP 读到的 xa_flags：${hmpXaFlags === null ? '（取不到）' : hmpXaFlags}，我们解析的是 ${xarray1.xaFlags}`,
      );
    }
    const ourXaIndexSet = xarray1.entries.map((entry) => entry.index.toString()).sort();
    const refXaIndexSet = refXaEntries.map((entry) => String(entry.index)).sort();
    const ourXaNodes = xarray1.nodeAddresses.map((value) => hex(value)).sort();
    const refXaNodes = (refXarray.nodeAddresses ?? []).map((value) => asBig(value))
      .filter((value) => value !== null).map((value) => hex(value)).sort();
    const xarrayIndexAgrees = sameNumberList(ourXaIndexSet, refXaIndexSet);
    const xarrayNodesAgree = sameNumberList(ourXaNodes, refXaNodes);
    const pointerEntries0 = xarray1.entries.filter((entry) => entry.kind === 'pointer');
    evidence.xarray = {
      address: hex(addrSpace1.pagesAddress),
      head: hex(xarray1.head),
      headKind: xarray1.headKind,
      rootShift: xarray1.rootShift,
      rootNode: hexOrNull(xarray1.rootNode),
      xaFlags: xarray1.xaFlags,
      xarrayMulti,
      entries: xarray1.entries.map((entry) => ({
        index: entry.index.toString(),
        raw: hex(entry.raw),
        kind: entry.kind,
        value: entry.value === null ? null : entry.value.toString(),
        pointer: hexOrNull(entry.pointer),
        span: entry.span.toString(),
        node: hexOrNull(entry.node),
        slot: entry.slot,
        shift: entry.shift,
        notes: entry.notes,
      })),
      nodesVisited: xarray1.nodesVisited,
      nodeAddresses: xarray1.nodeAddresses.map((value) => hex(value)),
      truncated: xarray1.truncated,
      cycle: xarray1.cycle,
      violations: xarray1.violations,
      notes: xarray1.notes,
      hmp: {
        raw: hmpXarray.raw,
        words: hmpXarray.words.map((word) => hex(word)),
        xaHead: hexOrNull(hmpXaHead),
        xaFlags: hmpXaFlags === null ? null : Number(hmpXaFlags),
      },
      gdb: refXarray,
      compared: xaCompared,
      mismatches: [...xaHeadMismatches, ...xaMismatches],
    };
    check(
      'T07d-V10 页缓存这棵 XArray 与 GDB 自己重写的遍历逐项一致（头形态/rootShift/xa_flags、条目下标集合、'
        + '每个条目的 kind/raw/pointer/value/span/slot/shift/node、访问过的节点地址集合），'
        + '且 `xa_head` 与 `xa_flags` 与 HMP 直接读到的原始字相同（第三种读内存实现）',
      xaCompared >= 1 && xaMismatches.length === 0
        && xaHeadMismatches.length === 0
        && xarrayIndexAgrees && xarrayNodesAgree
        && xarray1.violations.length === 0 && xarray1.cycle === false
        && xarray1.head !== 0n
        // 头形态不写死成 `node`：`i_pages` 里只有一个条目时，`xa_head` **就是**下标 0 的
        // 条目本身（`single-entry`），这时根本不存在节点可走。要的是"这两种形态都认、
        // 而且与 GDB 判成同一种"，而不是"必须是节点"。
        && (xarray1.headKind === 'node'
          || (xarray1.headKind === 'single-entry' && xarray1.entries.length === 1))
        && pointerEntries0.length >= 1
        && xarray1.entries.some((entry) => entry.index === 0n)
        && refXarray.headKind !== undefined && String(refXarray.headKind) === xarray1.headKind,
      `i_pages=${hex(addrSpace1.pagesAddress)} xa_head=${hex(xarray1.head)}（HMP ${hexOrNull(hmpXaHead)}）`
        + ` 头形态=${xarray1.headKind} rootShift=${xarray1.rootShift}（GDB ${refXarray.rootShift}）xa_flags=${xarray1.xaFlags}；`
        + `条目下标=[${ourXaIndexSet.join(',')}]（GDB [${refXaIndexSet.join(',')}]，逐项比 ${xaCompared} 个）；`
        + `节点 ${ourXaNodes.length} 个：[${ourXaNodes.join(' ')}]（GDB [${refXaNodes.join(' ')}]）；`
        + `violations=${xarray1.violations.length}`
        + `${[...xaHeadMismatches, ...xaMismatches].length === 0 ? '' : `；不一致：${[...xaHeadMismatches, ...xaMismatches].slice(0, 6).join(' | ')}`}`,
    );

    // ---------- V11 页缓存条目 → struct page → folio ----------

    /**
     * `readPageCache` 会把"页缓存槽 → `struct page`"整条走完，并且**自己解一遍 vmemmap 基址**
     * （不是抄编译期常量 `__VMEMMAP_BASE_L4`）：`mem_section[..].section_mem_map` 里存的是
     * `mem_map - section_nr_to_pfn(section_nr)`，加回起始页框号、再减掉 `sectionStartPfn × sizeof(struct page)`
     * 才是基址。这一步错了的症状是"`struct page` 解出来字段全对，但那其实是另一页的字段"。
     *
     * 下面三件事分开做：
     * 1. `pfn → 地址 → pfn` 往返（用我们自己的 vmemmap），确认步长就是 `sizeof(struct page)`；
     * 2. 换一个页框号**再解一次** vmemmap，两次要给出同一个基址；
     * 3. 拿 GDB 侧的 `resolve_vmemmap()`（它用的是 DWARF 里真正的 `sizeof(struct mem_section)`，
     *    而 `struct mem_section` 根本不在我方布局清单里）作为**独立来源**比基址，并把同一个页框上的
     *    `struct page` 与 GDB 逐字段比一遍。
     */
    const pageCache1 = await readPageCache(view1, layout, addrSpace1, {
      maxEntries: 16, xarrayMulti, decodeFolios: true,
    });
    const folioEntries = pageCache1.entries.filter((entry) => entry.folio !== null && entry.pfn !== null);
    const firstFolioEntry = folioEntries[0] ?? null;
    const pfnProbe = firstFolioEntry === null ? null : firstFolioEntry.pfn;
    const vmemmapLive = pageCache1.vmemmap;
    const vmemmapFromProbe = pfnProbe === null
      ? null
      : await resolveVmemmapBase(view1, layout, { pfn: pfnProbe, symbol: 'mem_section' });
    const pageStructSize = vmemmapLive === null ? null : vmemmapLive.pageStructSize;
    const pfnRoundTrip = firstFolioEntry === null || vmemmapLive === null
      ? null
      : pfnForPageAddress(vmemmapLive, firstFolioEntry.pageAddress);
    const pageAddressRoundTrip = firstFolioEntry === null || vmemmapLive === null || pageStructSize === null
      ? null
      : pageAddressForPfn(vmemmapLive.base, firstFolioEntry.pfn, pageStructSize);
    const vmemmapBasesAgree = vmemmapLive !== null && vmemmapFromProbe !== null
      && vmemmapLive.base === vmemmapFromProbe.base;

    // 第三条独立来源：GDB 用 DWARF 的 `struct mem_section` 自己解一遍 vmemmap，并在同一个页框上解一页。
    const vmemmapRefRun = pfnProbe === null
      ? { ok: false, error: '这次没有可用的页框号（页缓存里没有页指针条目）' }
      : await runReference(live, 'vmemmap', {
        files: task1.files ?? 0n,
        fd: 3,
        file: file1.address,
        pfn: pfnProbe,
      });
    const vmemmapRef = vmemmapRefRun.ok ? (vmemmapRefRun.data.vmemmap ?? {}) : {};
    const pageAtPfnRef = vmemmapRefRun.ok ? (vmemmapRefRun.data.pageAtPfn ?? null) : null;
    const vmemmapRefBase = vmemmapRef.base === undefined || vmemmapRef.base === null ? null : asBig(vmemmapRef.base);
    const vmemmapRefAgrees = vmemmapLive !== null && vmemmapRefBase !== null && vmemmapLive.base === vmemmapRefBase;

    const refFolios = Array.isArray(refData.pageCachePages) ? refData.pageCachePages : [];
    const folioMismatches = [];
    let folioCompared = 0;
    for (const entry of pageCache1.entries) {
      const theirs = refFolios.find((item) => String(item.index) === entry.index.toString());
      if (theirs === undefined || theirs.page === undefined || theirs.page === null) continue;
      if (entry.folio === null) {
        folioMismatches.push(`下标 ${entry.index}：我们解不出 struct page（${entry.error ?? '未知原因'}），GDB 解出来了`);
        continue;
      }
      folioCompared += 1;
      const folioPairs = [
        ['address', entry.folio.address, theirs.page.address],
        ['flags', entry.folio.flags, theirs.page.flags],
        ['mapping', entry.folio.mapping, theirs.page.mapping],
        ['index', entry.folio.index, theirs.page.index],
        ['refcount', BigInt(entry.folio.refcount), theirs.page.refcount],
        ['compound_head', entry.folio.compoundHeadRaw, theirs.page.compoundHeadRaw],
        ['page_type', entry.folio.pageType === null ? null : BigInt(entry.folio.pageType), theirs.page.pageType],
      ];
      for (const [label, mine, theirValue] of folioPairs) {
        const target = theirValue === null || theirValue === undefined ? null : asBig(theirValue);
        if (target === null) continue;
        if (mine === null) { folioMismatches.push(`下标 ${entry.index} ${label}：我们读不到，GDB=${hex(target)}`); continue; }
        if (BigInt(mine) !== target) {
          folioMismatches.push(
            `下标 ${entry.index} ${label}：我们=${typeof mine === 'bigint' ? hex(mine) : mine} GDB=${hex(target)}`,
          );
        }
      }
      const ourFlagNames = [...entry.folio.pageFlags].sort();
      const theirFlagNames = (theirs.page.pageFlags ?? []).map(String).sort();
      if (!sameNumberList(ourFlagNames, theirFlagNames)) {
        folioMismatches.push(
          `下标 ${entry.index} page->flags 解出的名字：我们=[${ourFlagNames.join(',')}] GDB=[${theirFlagNames.join(',')}]`,
        );
      }
      if (Number(theirs.page.mapcount) !== entry.folio.mapcount) {
        folioMismatches.push(
          `下标 ${entry.index} mapcount（按有符号读）：我们=${entry.folio.mapcount} GDB=${theirs.page.mapcount}`,
        );
      }
    }
    const refFlagBits = pageAtPfnRef === null ? null : (pageAtPfnRef.pageFlagBits ?? null);
    const pageFlagBitsAgree = refFlagBits === null
      ? null
      : PAGE_FLAG_NAMES.every((name) => {
        const theirs = refFlagBits[name];
        if (theirs === undefined || theirs === null) return true;
        try { return Number(layout.enumValue('pageflags', name)) === Number(theirs); } catch { return false; }
      });

    /**
     * 契约的**字节口径**：`pageCacheFolioRef(...).fileOffset` 必须是"下标 × 页大小"的字节数。
     * 这次页缓存里只有下标 0 的条目，真跑出来的 `fileOffset` 是 0 —— 那条恒等式对任何位移都成立，
     * 等于没验。所以这里再做一次**非平凡**的检查：把同一条 folio 换个下标（3）喂进同一个契约函数，
     * `fileOffset` 必须是 `3 × 4096 = 0x3000`。页大小本身有两个来源对账：我方导出的 `PAGE_SHIFT`
     * 与本地内核配置里的 `CONFIG_PAGE_SHIFT`。
     */
    const localConfigText = fs.readFileSync(CONFIGS, 'utf8');
    const pageShiftFromConfig = /^CONFIG_PAGE_SHIFT=(\d+)\s*$/m.exec(localConfigText);
    const pageShiftConfig = pageShiftFromConfig === null ? null : Number(pageShiftFromConfig[1]);
    const folioRefMismatches = [];
    const liveFolioRef = firstFolioEntry === null ? null : pageCacheFolioRef(firstFolioEntry, { inodeAddress: inode1.address });
    if (firstFolioEntry !== null) {
      if (liveFolioRef === null) {
        folioRefMismatches.push('pageCacheFolioRef 对真实条目返回了 null');
      } else {
        if (liveFolioRef.fileOffset !== hex(firstFolioEntry.index << BigInt(PAGE_SHIFT))) {
          folioRefMismatches.push(
            `fileOffset：契约=${liveFolioRef.fileOffset} 期望=${hex(firstFolioEntry.index << BigInt(PAGE_SHIFT))}`,
          );
        }
        if (liveFolioRef.address !== hex(firstFolioEntry.folio.address)) {
          folioRefMismatches.push(`address：契约=${liveFolioRef.address} 期望=${hex(firstFolioEntry.folio.address)}`);
        }
        if (liveFolioRef.pfn !== hex(firstFolioEntry.pfn)) {
          folioRefMismatches.push(`pfn：契约=${liveFolioRef.pfn} 期望=${hex(firstFolioEntry.pfn)}`);
        }
        if (liveFolioRef.inodeAddress !== hex(inode1.address)) {
          folioRefMismatches.push(`inodeAddress：契约=${liveFolioRef.inodeAddress} 期望=${hex(inode1.address)}`);
        }
      }
      const shifted = pageCacheFolioRef({ ...firstFolioEntry, index: 3n }, { inodeAddress: inode1.address });
      const shiftedExpected = hex(3n << BigInt(PAGE_SHIFT));
      if (shifted === null || shifted.fileOffset !== shiftedExpected) {
        folioRefMismatches.push(
          `把同一条 folio 换成下标 3：契约的 fileOffset=${shifted === null ? 'null' : shifted.fileOffset}，期望=${shiftedExpected}`,
        );
      }
    }
    const mappingKinds = pageCache1.entries.map((entry) => (
      entry.folio === null ? null : pageMappingKind(entry.folio.mapping)
    ));
    evidence.pageCache = {
      mapping: hex(addrSpace1.address),
      pagesAddress: hex(addrSpace1.pagesAddress),
      nrpages: addrSpace1.nrpages.toString(),
      entries: pageCache1.entries.map((entry) => ({
        index: entry.index.toString(),
        pageAddress: hex(entry.pageAddress),
        pfn: entry.pfn === null ? null : entry.pfn.toString(),
        pfnRemainder: entry.pfnRemainder.toString(),
        error: entry.error,
        notes: entry.notes,
        folio: entry.folio === null ? null : {
          address: hex(entry.folio.address),
          flags: hex(entry.folio.flags),
          pageFlags: entry.folio.pageFlags,
          pageFlagBitCount: entry.folio.pageFlagBitCount,
          undecodedFlagBits: hex(entry.folio.undecodedFlagBits),
          pageType: entry.folio.pageType,
          pageTypeCode: entry.folio.pageTypeCode,
          pageTypeName: entry.folio.pageTypeName,
          pageTypeIsType: entry.folio.pageTypeIsType,
          refcount: entry.folio.refcount,
          mapcount: entry.folio.mapcount,
          mapping: hex(entry.folio.mapping),
          mappingIsAnon: entry.folio.mappingIsAnon,
          mappingIsMovable: entry.folio.mappingIsMovable,
          mappingKind: pageMappingKind(entry.folio.mapping),
          index: entry.folio.index.toString(),
          isTail: entry.folio.isTail,
          compoundHeadRaw: hex(entry.folio.compoundHeadRaw),
          folioNrPages: entry.folio.folioNrPages,
        },
      })),
      violations: pageCache1.violations,
      notes: pageCache1.notes,
      vmemmap: vmemmapLive === null ? null : {
        base: hex(vmemmapLive.base),
        source: vmemmapLive.source,
        pageStructSize: vmemmapLive.pageStructSize.toString(),
        sectionNumber: vmemmapLive.sectionNumber.toString(),
        sectionStartPfn: vmemmapLive.sectionStartPfn.toString(),
        sectionArray: hexOrNull(vmemmapLive.sectionArray),
        sectionAddress: hexOrNull(vmemmapLive.sectionAddress),
        sectionMemMapRaw: hexOrNull(vmemmapLive.sectionMemMapRaw),
        sectionMarkedPresent: vmemmapLive.sectionMarkedPresent,
        sectionHasMemMap: vmemmapLive.sectionHasMemMap,
        matchesCompiledDefault: vmemmapLive.matchesCompiledDefault,
        notes: vmemmapLive.notes,
      },
      vmemmapFromProbe: vmemmapFromProbe === null ? null : {
        pfn: pfnProbe === null ? null : pfnProbe.toString(),
        base: hex(vmemmapFromProbe.base),
        matchesCompiledDefault: vmemmapFromProbe.matchesCompiledDefault,
      },
      vmemmapRef: vmemmapRefRun.ok ? {
        pfn: pfnProbe === null ? null : pfnProbe.toString(),
        base: vmemmapRefBase === null ? null : hex(vmemmapRefBase),
        sectionStartPfn: vmemmapRef.sectionStartPfn ?? null,
        memoryMap: vmemmapRef.memoryMap === undefined || vmemmapRef.memoryMap === null
          ? null : hex(asBig(vmemmapRef.memoryMap)),
        pageStructSize: vmemmapRef.pageStructSize ?? null,
        memSectionSize: vmemmapRef.memSectionSize ?? null,
        sectionsPerRoot: vmemmapRef.sectionsPerRoot ?? null,
        sectionAddress: vmemmapRef.sectionAddress === undefined || vmemmapRef.sectionAddress === null
          ? null : hex(asBig(vmemmapRef.sectionAddress)),
        sectionMemMapRaw: vmemmapRef.sectionMemMapRaw === undefined || vmemmapRef.sectionMemMapRaw === null
          ? null : hex(asBig(vmemmapRef.sectionMemMapRaw)),
        aligned: vmemmapRef.aligned ?? null,
        inKernelHalf: vmemmapRef.inKernelHalf ?? null,
        notes: vmemmapRef.notes ?? [],
      } : { error: vmemmapRefRun.error ?? '未运行' },
      pfnRoundTrip: pfnRoundTrip === null ? null : {
        pfn: pfnRoundTrip.pfn === null ? null : pfnRoundTrip.pfn.toString(),
        remainder: pfnRoundTrip.remainder.toString(),
      },
      pageAddressRoundTrip: hexOrNull(pageAddressRoundTrip),
      pageShift: { decoder: PAGE_SHIFT, kernelConfig: pageShiftConfig },
      gdb: {
        ipages: refXarray,
        pageCachePages: refData.pageCachePages ?? null,
        pageAtPfn: pageAtPfnRef,
      },
      folioCompared,
      folioMismatches,
      pageFlagBitsAgree,
      contract: {
        mismatches: folioRefMismatches,
        mappingKinds,
        live: liveFolioRef === null ? null : {
          address: liveFolioRef.address,
          fileOffset: liveFolioRef.fileOffset,
          pfn: liveFolioRef.pfn,
          dirty: liveFolioRef.dirty,
          uptodate: liveFolioRef.uptodate,
          inodeAddress: liveFolioRef.inodeAddress,
        },
      },
    };
    check(
      'T07d-V11 页缓存条目 → `struct page` → folio：条目是真正的页指针、页的 `mapping` 就是 `file->f_mapping`、'
        + '不是匿名页（`pageMappingKind` 判为 file）、页自报的 `index` 就是条目下标；'
        + '`pfn → 地址 → pfn` 往返成立（步长 = `sizeof(struct page)`）；vmemmap 基址由 `mem_section` 现场解出'
        + '（按内核 `sparse_decode_mem_map` 的口径：编码值本身就是基址，与起始页框号无关），'
        + '换一个页框号再解仍是同一个基址，且与 GDB 用 DWARF 里真正的 `sizeof(struct mem_section)` 解出的基址相同、'
        + '两路解出的基址都 512 GiB 对齐且落在内核半区；'
        + '页的字段与我们/GDB 两路读到的逐个相同；契约 `pageCacheFolioRef` 的 `fileOffset` 是"下标 × 页大小"的字节数',
      pageCache1.entries.length >= 1
        && folioCompared >= 1 && folioMismatches.length === 0
        && pageCache1.violations.length === 0
        && firstFolioEntry !== null
        && firstFolioEntry.index === 0n
        && firstFolioEntry.folio.mapping === addrSpace1.address
        && firstFolioEntry.folio.mappingIsAnon === false
        && pageMappingKind(firstFolioEntry.folio.mapping) === 'file'
        && firstFolioEntry.folio.index === firstFolioEntry.index
        && pfnRoundTrip !== null && pfnRoundTrip.pfn === firstFolioEntry.pfn && pfnRoundTrip.remainder === 0n
        && pageAddressRoundTrip !== null && pageAddressRoundTrip === firstFolioEntry.pageAddress
        && vmemmapLive !== null && pageStructSize === BigInt(layout.type('page').byteSize)
        && vmemmapLive.matchesCompiledDefault === true
        && vmemmapRef.aligned === true && vmemmapRef.inKernelHalf === true
        && vmemmapBasesAgree && vmemmapRefAgrees
        && pageShiftConfig !== null && pageShiftConfig === PAGE_SHIFT
        && folioRefMismatches.length === 0
        && (pageFlagBitsAgree === null || pageFlagBitsAgree === true),
      `i_pages 有 ${pageCache1.entries.length} 个条目，其中 ${folioEntries.length} 个解成了页；`
        + `下标 ${firstFolioEntry === null ? '（无）' : firstFolioEntry.index} 的页=`
        + `${firstFolioEntry === null ? '（无）' : hex(firstFolioEntry.pageAddress)} pfn=${pfnProbe}`
        + ` mapping=${firstFolioEntry === null ? '（无）' : hex(firstFolioEntry.folio.mapping)}`
        + `（等于 f_mapping=${hexOrNull(file1.fMapping)}；类型 ${firstFolioEntry === null ? '（无）' : pageMappingKind(firstFolioEntry.folio.mapping)}）`
        + ` index=${firstFolioEntry === null ? '（无）' : firstFolioEntry.folio.index}；`
        + `vmemmap：我们=${vmemmapLive === null ? '（解不出）' : hex(vmemmapLive.base)}`
        + `（源=${vmemmapLive === null ? '无' : vmemmapLive.source}，与常量一致=${String(vmemmapLive === null ? null : vmemmapLive.matchesCompiledDefault)}`
        + `，section 号=${vmemmapLive === null ? '无' : vmemmapLive.sectionNumber}`
        + `，起始页框号=${vmemmapLive === null ? '无' : vmemmapLive.sectionStartPfn}`
        + `，section_mem_map=${vmemmapLive === null ? '无' : hex(vmemmapLive.sectionMemMapRaw ?? 0n)}）`
        + ` / 换页框号=${vmemmapFromProbe === null ? '（未做）' : hex(vmemmapFromProbe.base)}`
        + ` / GDB=${vmemmapRefBase === null ? '（未拿到）' : hex(vmemmapRefBase)}`
        + `（对齐=${String(vmemmapRef.aligned ?? null)} 内核半区=${String(vmemmapRef.inKernelHalf ?? null)}`
        + ` 本节首页=${vmemmapRef.memoryMap === undefined || vmemmapRef.memoryMap === null ? '无' : hex(asBig(vmemmapRef.memoryMap))}）；`
        + `页字段比对 ${folioCompared} 个条目（不一致 ${folioMismatches.length}）`
        + `${folioMismatches.length === 0 ? '' : `：${folioMismatches.slice(0, 6).join(' | ')}`}；`
        + `契约检查 ${folioRefMismatches.length === 0 ? '通过' : `不通过：${folioRefMismatches.slice(0, 4).join(' | ')}`}`,
    );

    // ---------- V12 位表：与内核源码现场重解析逐项一致 ----------

    /**
     * `f_flags`/`f_mode`/`i_state`/`d_flags` 全是 `#define`（DWARF 里没有），所以解析器里只能
     * 写下一张表；而"位表错一位"的表现是**安静地显示了相反的权限**。所以这里把源码头文件
     * 现场重解析一遍，然后**双向**对：我们认得的每一位在源码里是同一个值；源码里所有单位
     * 定义的名字我们也一个不缺（缺一个名字，那一类权限就永远显示不出来）。
     */
    const bitsPerLongH = path.join(SRC, 'include/asm-generic/bitsperlong.h');
    const pageTypesH = path.join(SRC, 'arch/x86/include/asm/page_types.h');
    const pageTypesText = fs.readFileSync(pageTypesH, 'utf8');
    const xarrayText = fs.readFileSync(XARRAY_H, 'utf8');
    const statText = fs.readFileSync(STAT_H, 'utf8');
    const fsText = fs.readFileSync(FS_H, 'utf8');
    const sourceTables = mergeTables([
      { name: 'fs.h', text: fsText, file: FS_H },
      { name: 'dcache.h', text: dcacheText, file: DCACHE_H },
      { name: 'fcntl.h', text: fs.readFileSync(FCNTL_H, 'utf8'), file: FCNTL_H },
      { name: 'stat.h', text: statText, file: STAT_H },
      { name: 'kdev_t.h', text: fs.readFileSync(KDEV_T_H, 'utf8'), file: KDEV_T_H },
      { name: 'xarray.h', text: xarrayText, file: XARRAY_H },
      { name: 'fdtable.h', text: fs.readFileSync(FDTABLE_H, 'utf8'), file: FDTABLE_H },
      { name: 'page-flags.h', text: fs.readFileSync(PAGE_FLAGS_H, 'utf8'), file: PAGE_FLAGS_H },
      { name: 'bitsperlong.h', text: fs.readFileSync(bitsPerLongH, 'utf8'), file: bitsPerLongH },
    ]);
    const sourceValues = (name) => resolveDefineAll(sourceTables, name);
    const sourceSingle = (name) => {
      const set = sourceValues(name);
      return set.size === 1 ? [...set][0] : null;
    };
    const popcount = (value) => {
      let rest = value;
      let count = 0;
      while (rest > 0n) { if ((rest & 1n) === 1n) count += 1; rest >>= 1n; }
      return count;
    };
    const bitMismatches = [];
    const bitConfigFindings = [];
    let bitCompared = 0;
    const compareBitTable = (label, table) => {
      for (const bit of table) {
        const values = sourceValues(bit.name);
        if (values.size === 0) { bitMismatches.push(`${label}:${bit.name} 在源码里找不到定义`); continue; }
        bitCompared += 1;
        if (![...values].some((value) => value === BigInt(bit.value))) {
          bitMismatches.push(
            `${label}:${bit.name}：我们=${bit.value}(0x${bit.value.toString(16)})`
            + ` 源码=${[...values].map((value) => `0x${value.toString(16)}`).join('/')}（${defineSites(sourceTables, bit.name)}）`,
          );
        }
        if (bit.config !== null && !guardedByConfig(sourceTables, bit.name, bit.config)) {
          bitConfigFindings.push(
            `${label}:${bit.name} 被我们标成依赖 ${bit.config}，但源码里它是无条件定义的（${defineSites(sourceTables, bit.name)}）`,
          );
        }
      }
    };
    compareBitTable('FMODE', FMODE_BITS);
    compareBitTable('I_STATE', INODE_STATE_BITS);
    compareBitTable('DCACHE', DENTRY_FLAG_BITS);
    compareBitTable('O_FLAGS', O_FLAG_BITS);
    compareBitTable('O_COMPOSITE', O_COMPOSITE_FLAGS);

    const entryTypeMismatches = [];
    for (const entry of DENTRY_ENTRY_TYPES) {
      const value = sourceSingle(entry.name);
      if (value === null || value !== BigInt(entry.value)) {
        entryTypeMismatches.push(`${entry.name}：我们=${entry.value} 源码=${value === null ? '（解不出唯一值）' : value}`);
      }
    }
    const entryTypeMask = sourceSingle('DCACHE_ENTRY_TYPE');
    if (entryTypeMask === null || entryTypeMask !== BigInt(DCACHE_ENTRY_TYPE_MASK)) {
      entryTypeMismatches.push(
        `DCACHE_ENTRY_TYPE：我们=${hex(BigInt(DCACHE_ENTRY_TYPE_MASK))}`
        + ` 源码=${entryTypeMask === null ? '（解不出）' : hex(entryTypeMask)}`,
      );
    }
    const inodeTypeMismatches = [];
    for (const entry of INODE_FILE_TYPES) {
      const value = sourceSingle(entry.name);
      if (value === null || value !== BigInt(entry.value)) {
        inodeTypeMismatches.push(
          `${entry.name}：我们=0o${entry.value.toString(8)} 源码=${value === null ? '（解不出）' : `0o${value.toString(8)}`}`,
        );
      }
    }
    const sIfmtSource = sourceSingle('S_IFMT');
    if (sIfmtSource === null || sIfmtSource !== BigInt(S_IFMT)) {
      inodeTypeMismatches.push(
        `S_IFMT：我们=0o${S_IFMT.toString(8)} 源码=${sIfmtSource === null ? '（解不出）' : `0o${sIfmtSource.toString(8)}`}`,
      );
    }
    const minorBitsSource = sourceSingle('MINORBITS');
    const pageMappingSource = {
      anon: sourceSingle('PAGE_MAPPING_ANON'),
      movable: sourceSingle('PAGE_MAPPING_MOVABLE'),
      flags: sourceSingle('PAGE_MAPPING_FLAGS'),
    };
    const oAccModeSource = sourceSingle('O_ACCMODE');
    const bitsPerLongValues = sourceValues('BITS_PER_LONG');
    const nrOpenDefault = sourceSingle('NR_OPEN_DEFAULT');
    const wordBitsSource = localConfigs.has('CONFIG_64BIT') ? 64n : 32n;
    const bitsPerLongOk = [...bitsPerLongValues].includes(wordBitsSource)
      && files1.wordBytes * 8 === Number(wordBitsSource)
      && guardedByConfig(sourceTables, 'BITS_PER_LONG', 'CONFIG_64BIT');
    // `NR_OPEN_DEFAULT` 的定义体就是 `BITS_PER_LONG`，而 `BITS_PER_LONG` 在
    // `#ifdef CONFIG_64BIT` 下有两份候选（64/32）。所以这里比的不是"唯一值"（多候选时
    // `sourceSingle` 只会给 null），而是"本次构建按配置挑中的那一份在我们的候选里"，
    // 并且两份候选都真的存在 —— 说明条件编译确实被解析到了，不是碰巧只剩一个。
    const nrOpenDefaultValues = sourceValues('NR_OPEN_DEFAULT');
    const nrOpenDefaultOk = nrOpenDefaultValues.has(wordBitsSource)
      && nrOpenDefaultValues.size === 2;

    /**
     * 反向对：源码里所有"恰好一位"的定义名，我们的表里不许缺。多位的组合宏（`I_DIRTY`、
     * `DCACHE_MANAGED_DENTRY`、`PAGE_MAPPING_FLAGS`）不在这条规则里 —— 它们本来就该由多位拼出来。
     */
    const sourceSingleBitNames = (prefix, file) => {
      const names = [];
      // 名字要**同时**看 `values`（字面量）与 `aliases`（`BIT(n)`、`(1 << n)` 这类表达式）：
      // `FMODE_READ` 在源码里写的是 `((__force fmode_t)(1 << 0))`，只查字面量表的话，
      // 整个 FMODE/I_/DCACHE 家族都会被当成"源码里没有"，反向集合比对就成了空转。
      const all = new Set([...sourceTables.values.keys(), ...sourceTables.aliases.keys()]);
      for (const name of all) {
        if (!name.startsWith(`${prefix}_`)) continue;
        if (file !== undefined && sourceTables.fileOf.get(name) !== file) continue;
        if (prefix === 'FMODE' && name.includes('FSNOTIFY')) continue;
        for (const value of resolveDefineAll(sourceTables, name)) {
          if (value > 0n && value <= (1n << 40n) && popcount(value) === 1) names.push(name);
        }
      }
      return [...new Set(names)].sort();
    };
    const ourNamesOf = (table) => [...new Set(table.map((entry) => entry.name))].sort();
    // 第二个参数是**表里的文件别名**（`'fs.h'`/`'dcache.h'`），不是绝对路径 —— `mergeTables`
    // 记下来的就是别名。传绝对路径会让每一处过滤都失配，集合静默变空。
    const setAgreements = [
      ['FMODE', sourceSingleBitNames('FMODE', 'fs.h'), ourNamesOf(FMODE_BITS)],
      [
        'I_STATE',
        sourceSingleBitNames('I', 'fs.h').filter((name) => !['I_DIRTY', 'I_DIRTY_ALL', 'I_DIRTY_INODE'].includes(name)),
        ourNamesOf(INODE_STATE_BITS),
      ],
      [
        'DCACHE',
        sourceSingleBitNames('DCACHE', 'dcache.h').filter((name) => !name.endsWith('_TYPE')),
        ourNamesOf(DENTRY_FLAG_BITS),
      ],
    ].map(([label, theirs, ours]) => {
      const missing = theirs.filter((name) => !ours.includes(name));
      const extra = ours.filter((name) => !theirs.includes(name));
      return { label, ours: ours.length, theirs: theirs.length, missing, extra };
    });
    const setMismatches = setAgreements
      .filter((entry) => entry.missing.length > 0 || entry.extra.length > 0)
      .map((entry) => `${entry.label}：源码多出 [${entry.missing.join(',')}]，我们多出 [${entry.extra.join(',')}]`);
    const iDirtySource = sourceSingle('I_DIRTY');
    const iDirtyAllSource = sourceSingle('I_DIRTY_ALL');
    const dirtyMaskOk = iDirtySource === BigInt(INODE_DIRTY_MASK)
      && iDirtyAllSource === BigInt(INODE_DIRTY_ALL_MASK);

    evidence.bitTables = {
      compared: bitCompared,
      mismatches: bitMismatches,
      configFindings: bitConfigFindings,
      entryTypes: {
        compared: DENTRY_ENTRY_TYPES.length + 1,
        mismatches: entryTypeMismatches,
        mask: hex(BigInt(DCACHE_ENTRY_TYPE_MASK)),
        shift: DCACHE_ENTRY_TYPE_SHIFT,
        sourceMask: entryTypeMask === null ? null : hex(entryTypeMask),
      },
      inodeTypes: {
        compared: INODE_FILE_TYPES.length + 1,
        mismatches: inodeTypeMismatches,
        sIfmt: { ours: `0o${S_IFMT.toString(8)}`, source: sIfmtSource === null ? null : `0o${sIfmtSource.toString(8)}` },
      },
      minorBits: {
        ours: MINORBITS,
        source: minorBitsSource === null ? null : Number(minorBitsSource),
        sites: defineSites(sourceTables, 'MINORBITS'),
      },
      pageMapping: {
        ours: { anon: hex(0x1n), movable: hex(0x2n), flags: hex(0x3n) },
        source: {
          anon: pageMappingSource.anon === null ? null : hex(pageMappingSource.anon),
          movable: pageMappingSource.movable === null ? null : hex(pageMappingSource.movable),
          flags: pageMappingSource.flags === null ? null : hex(pageMappingSource.flags),
        },
      },
      oAccMode: { ours: `0o${O_ACCMODE.toString(8)}`, source: oAccModeSource === null ? null : `0o${oAccModeSource.toString(8)}` },
      bitsPerLong: {
        ours: 64,
        source: [...bitsPerLongValues].map((value) => Number(value)).sort((a, b) => a - b),
        guardedBy64Bit: guardedByConfig(sourceTables, 'BITS_PER_LONG', 'CONFIG_64BIT'),
        filesWordBits: files1.wordBytes * 8,
      },
      nrOpenDefault: {
        ours: 64,
        source: nrOpenDefault === null ? null : Number(nrOpenDefault),
        sites: defineSites(sourceTables, 'NR_OPEN_DEFAULT'),
      },
      reverseSets: setAgreements,
      reverseMismatches: setMismatches,
      dirtyMask: {
        ours: hex(BigInt(INODE_DIRTY_MASK)),
        oursAll: hex(BigInt(INODE_DIRTY_ALL_MASK)),
        source: iDirtySource === null ? null : hex(iDirtySource),
        sourceAll: iDirtyAllSource === null ? null : hex(iDirtyAllSource),
      },
      pageShift: {
        decoderPAGE_SHIFT: PAGE_SHIFT,
        kernelConfig: pageShiftConfig,
        archHeaderSites: defineSites(
          mergeTables([{ name: 'page_types.h', text: pageTypesText, file: pageTypesH }]),
          'PAGE_SHIFT',
        ),
      },
    };
    check(
      'T07d-V12 位表与内核源码现场重解析逐项一致，而且是双向的：我们认得的每一位（FMODE_*/I_*/DCACHE_*/DCACHE_ENTRY_TYPE/O_*）'
        + '在源码里是同一个值；源码里所有单位定义的名字我们一个不缺；`MINORBITS`/`S_IFMT`/`S_IF*`/`PAGE_MAPPING_*`/`O_ACCMODE`/'
        + '`NR_OPEN_DEFAULT`/`BITS_PER_LONG`/`I_DIRTY` 这些也逐项相同',
      bitCompared >= 70 && bitMismatches.length === 0
        && entryTypeMismatches.length === 0 && inodeTypeMismatches.length === 0
        && setMismatches.length === 0
        && minorBitsSource !== null && Number(minorBitsSource) === MINORBITS
        && pageMappingSource.anon === 0x1n && pageMappingSource.movable === 0x2n && pageMappingSource.flags === 0x3n
        && oAccModeSource !== null && Number(oAccModeSource) === O_ACCMODE
        && bitsPerLongOk && nrOpenDefaultOk && dirtyMaskOk
        && pageShiftConfig !== null && pageShiftConfig === PAGE_SHIFT,
      `位表逐项比对 ${bitCompared} 次（不一致 ${bitMismatches.length}）`
        + `${bitMismatches.length === 0 ? '' : `：${bitMismatches.slice(0, 4).join(' | ')}`}；反向集合：`
        + setAgreements.map((entry) => `${entry.label} 我们 ${entry.ours} / 源码 ${entry.theirs}`).join('，')
        + `${setMismatches.length === 0 ? '' : `；集合不一致：${setMismatches.join(' | ')}`}；`
        + `类型表（文件类型 ${INODE_FILE_TYPES.length}、dentry 类型 ${DENTRY_ENTRY_TYPES.length}）不一致 `
        + `${entryTypeMismatches.length + inodeTypeMismatches.length}；`
        + `BITS_PER_LONG=${wordBitsSource}（NR_OPEN_DEFAULT 源码=${nrOpenDefault}，fd 表的字宽=${files1.wordBytes * 8} 位）；`
        + `MINORBITS=${MINORBITS} S_IFMT=0o${S_IFMT.toString(8)} PAGE_MAPPING_ANON/MOVABLE/FLAGS=0x1/0x2/0x3`
        + `${bitConfigFindings.length === 0 ? '' : `；条件标注与源码不符：${bitConfigFindings.slice(0, 4).join(' | ')}`}`,
    );

    // ---------- V13 XArray 的编码：与源码函数体逐条一致 ----------

    /**
     * XArray 的编码/解码在源码里是**函数体**而不是常量：`xa_mk_value` 是 `(v << 1) | 1`、
     * `xa_to_value` 是 `>> 1`、`xa_mk_internal` 是 `(v << 2) | 2`、`xa_to_node` 是 `entry - 2`、
     * `xa_is_node` 是"内部条目且**编码后的数值** > 4096"。抄错一处（比如把 `<< 1` 写成 `<< 2`）
     * 读出来的东西照样像条目，所以这里既读函数体，也在活数据上把恒等式跑一遍。
     *
     * 两个容易写错的边界（都照源码而不是照直觉）：
     *   - `xa_is_sibling` 的上界是 `xa_mk_sibling(XA_CHUNK_SIZE - 1)`，而 `xa_mk_sibling(off)`
     *     就是 `xa_mk_internal(off)`，且比较是**严格小于**，所以 `xaMkInternal(63)` 不算兄弟条目；
     *   - `xa_is_node` 的 4096 比的是**编码后的值**，所以分界落在 `xa_mk_internal(1024) = 4098`
     *     与 `xa_mk_internal(1023) = 4094` 之间，不是落在 `v = 4096` 上。
     */
    const xarrayEncoding = readXarrayEncoding(xarrayText);
    const liveIdentities = [];
    for (const sample of [0n, 1n, 42n, 0xDEADBEEFn]) {
      const encoded = xaMkValue(sample);
      if (encoded !== ((sample << 1n) | 1n)) {
        liveIdentities.push(`xaMkValue(${sample}) 得到 ${hex(encoded)}，按 (v<<1)|1 应为 ${hex((sample << 1n) | 1n)}`);
      }
      if (!xaIsValue(encoded)) liveIdentities.push(`xaMkValue(${sample}) 的结果没被认成值条目`);
      if (xaToValue(encoded) !== sample) {
        liveIdentities.push(`xaToValue(xaMkValue(${sample})) = ${xaToValue(encoded)}，应为 ${sample}`);
      }
      if (xaIsNode(encoded)) liveIdentities.push(`xaMkValue(${sample}) 的结果被认成了节点`);
    }
    for (const internal of [0n, 1n, 62n, 63n, 256n, 257n, 1023n, 1024n]) {
      const encoded = xaMkInternal(internal);
      if (encoded !== ((internal << 2n) | 2n)) {
        liveIdentities.push(
          `xaMkInternal(${internal}) 得到 ${hex(encoded)}，按 (v<<2)|2 应为 ${hex((internal << 2n) | 2n)}`,
        );
      }
      if (xaToInternal(encoded) !== internal) {
        liveIdentities.push(`xaToInternal(xaMkInternal(${internal})) = ${xaToInternal(encoded)}，应为 ${internal}`);
      }
    }
    const siblingUpperBound = xaMkInternal(BigInt((1 << XA_CHUNK_SHIFT) - 1));
    const nodeBoundary = [
      ['xaMkInternal(1024)（编码后 4098 > 4096）应当被当成节点指针', xaIsNode(xaMkInternal(1024n)), true],
      ['xaMkInternal(1023)（编码后 4094 < 4096）不该被当成节点指针', xaIsNode(xaMkInternal(1023n)), false],
      ['XA_RETRY_ENTRY 就是 xaMkInternal(256)', XA_RETRY_ENTRY, xaMkInternal(256n)],
      ['XA_ZERO_ENTRY 就是 xaMkInternal(257)', XA_ZERO_ENTRY, xaMkInternal(257n)],
      ['xaIsRetry(XA_RETRY_ENTRY)', xaIsRetry(XA_RETRY_ENTRY), true],
      ['xaIsZero(XA_ZERO_ENTRY)', xaIsZero(XA_ZERO_ENTRY), true],
      [`xaIsSibling(xaMkInternal(62))（62 < 上界 ${hex(siblingUpperBound)}）`, xaIsSibling(xaMkInternal(62n)), true],
      [`xaIsSibling(xaMkInternal(63))（正好是上界 ${hex(siblingUpperBound)}，比较是严格小于）`, xaIsSibling(xaMkInternal(63n)), false],
      ['xaIsSibling(XA_RETRY_ENTRY)', xaIsSibling(XA_RETRY_ENTRY), false],
      ['关掉 CONFIG_XARRAY_MULTI 的语义：xaIsSibling(..., false) 恒为假', xaIsSibling(xaMkInternal(62n), false), false],
      ['describeXaEntry(xaMkValue(7)) 是值条目', describeXaEntry(xaMkValue(7n)).kind, 'value'],
      ['describeXaEntry(XA_RETRY_ENTRY) 是 retry 条目', describeXaEntry(XA_RETRY_ENTRY).kind, 'retry'],
      ['describeXaEntry(XA_ZERO_ENTRY) 是 zero 条目', describeXaEntry(XA_ZERO_ENTRY).kind, 'zero'],
      ['现场这棵树里没有 retry 条目', xarray1.entries.every((entry) => entry.kind !== 'retry'), true],
      ['现场这棵树里没有 zero 条目', xarray1.entries.every((entry) => entry.kind !== 'zero'), true],
    ];
    const identityFailures = liveIdentities.concat(
      nodeBoundary.filter(([, actual, expected]) => actual !== expected)
        .map(([label, actual, expected]) => `${label}：实际=${String(actual)} 期望=${String(expected)}`),
    );
    const retryValue = xarrayEncoding.retryEntry === null ? null : BigInt(xarrayEncoding.retryEntry[1]);
    const zeroValue = xarrayEncoding.zeroEntry === null ? null : BigInt(xarrayEncoding.zeroEntry[1]);
    const chunkShiftFromSource = xarrayEncoding.chunkShiftLine === null
      ? null
      : (localConfigs.has('CONFIG_BASE_SMALL')
        ? Number(xarrayEncoding.chunkShiftLine[1])
        : Number(xarrayEncoding.chunkShiftLine[2]));
    const encodingFacts = {
      mkValueShifts1: xarrayEncoding.mkValue.shifts1 && xarrayEncoding.mkValue.ors1,
      toValueShifts1: xarrayEncoding.toValue.shifts1,
      mkInternalShifts2: xarrayEncoding.mkInternal.shifts2 && xarrayEncoding.mkInternal.ors2,
      toInternalShifts2: xarrayEncoding.toInternal.shifts2,
      toNodeSubtracts2: xarrayEncoding.toNode.subtracts2,
      isNodeThreshold: xarrayEncoding.isNode.threshold4096 && xarrayEncoding.isNode.usesInternal,
      isSiblingUpperBound: xarrayEncoding.isSibling.upperBound && xarrayEncoding.isSibling.usesMulti,
      retryFromSource: retryValue === null ? null : retryValue.toString(),
      zeroFromSource: zeroValue === null ? null : zeroValue.toString(),
      chunkShiftFromSource,
    };
    const encodingBodiesOk = encodingFacts.mkValueShifts1 && encodingFacts.toValueShifts1
      && encodingFacts.mkInternalShifts2 && encodingFacts.toInternalShifts2
      && encodingFacts.toNodeSubtracts2 && encodingFacts.isNodeThreshold && encodingFacts.isSiblingUpperBound;
    evidence.xarrayEncoding = {
      source: encodingFacts,
      bodies: {
        mkValue: xarrayEncoding.mkValue.body,
        toValue: xarrayEncoding.toValue.body,
        mkInternal: xarrayEncoding.mkInternal.body,
        toNode: xarrayEncoding.toNode.body,
        isNode: xarrayEncoding.isNode.body,
        isSibling: xarrayEncoding.isSibling.body,
      },
      liveIdentities,
      nodeBoundary: nodeBoundary.map(([label, actual, expected]) => ({
        label, actual: String(actual), expected: String(expected),
      })),
      identityFailures,
      chunkShift: { ours: XA_CHUNK_SHIFT, source: chunkShiftFromSource, chunkSize: 1 << XA_CHUNK_SHIFT },
    };
    check(
      'T07d-V13 XArray 的编码与源码函数体逐条一致（`xa_mk_value` 是 `(v<<1)|1`、`xa_mk_internal` 是 `(v<<2)|2`、'
        + '`xa_to_node` 是"减 2"、`xa_is_node` 比的是编码后数值与 4096、`xa_is_sibling` 的严格上界与 `CONFIG_XARRAY_MULTI`、'
        + '`XA_RETRY_ENTRY`=xa_mk_internal(256)、`XA_ZERO_ENTRY`=xa_mk_internal(257)、`XA_CHUNK_SHIFT`），'
        + '并且这些恒等式在活数据上全部成立、现场这棵树里没有 retry/zero 条目',
      encodingBodiesOk
        && retryValue === 256n && zeroValue === 257n
        && chunkShiftFromSource !== null && chunkShiftFromSource === XA_CHUNK_SHIFT
        && siblingUpperBound === xaMkInternal(BigInt((1 << XA_CHUNK_SHIFT) - 1))
        && identityFailures.length === 0,
      `函数体判据：值条目 <<1|1=${encodingFacts.mkValueShifts1} 右移 1=${encodingFacts.toValueShifts1} `
        + `内部条目 <<2|2=${encodingFacts.mkInternalShifts2} 右移 2=${encodingFacts.toInternalShifts2} `
        + `xa_to_node 减 2=${encodingFacts.toNodeSubtracts2} 4096 分界=${encodingFacts.isNodeThreshold} `
        + `兄弟上界=${encodingFacts.isSiblingUpperBound}（=${hex(siblingUpperBound)}）；`
        + `源码 XA_RETRY_ENTRY=xa_mk_internal(${retryValue}) XA_ZERO_ENTRY=xa_mk_internal(${zeroValue}) `
        + `XA_CHUNK_SHIFT=${chunkShiftFromSource}（我们=${XA_CHUNK_SHIFT}）；`
        + `活体恒等式失败 ${identityFailures.length} 条`
        + `${identityFailures.length === 0 ? '' : `：${identityFailures.slice(0, 4).join(' | ')}`}`,
    );

    // ---------- V14 整条链的入口：readFileChain 与逐字段解析一致 + toFileRef 契约诚实 ----------

    /**
     * 前面每一节都是"自己按地址逐字段读"。这一节换**链式入口**再走一遍，看两条路是不是同一份结论：
     * 逐字段那一遍要是哪里悄悄走错了（比如内嵌 fdtab / 扩容表的岔路），链式入口就会给出另一个地址。
     */
    const chain1 = await readFileChain(view1, layout, {
      files: files1,
      fd: 3,
      resolvePath: true,
      readSuperBlock: true,
      readAddressSpace: true,
      readPageCache: true,
      pageCacheLimit: 8,
      enabledConfigs: localConfigs,
    });
    const chainMismatches = [];
    const chainPair = (label, mine, theirs) => {
      if (mine === null || theirs === null) { chainMismatches.push(`${label}：一边是 null（我们=${mine === null ? 'null' : '有值'}，链式=${theirs === null ? 'null' : '有值'}）`); return; }
      if (BigInt(mine) !== BigInt(theirs)) chainMismatches.push(`${label}：我们=${hex(BigInt(mine))} 链式=${hex(BigInt(theirs))}`);
    };
    chainPair('file', file1.address, chain1.file.address);
    chainPair('fdSlotAddress', fdSlotAddress, chain1.fdSlotAddress);
    chainPair('dentry', dentry1.address, chain1.dentry === null ? null : chain1.dentry.address);
    chainPair('inode', inode1.address, chain1.inode === null ? null : chain1.inode.address);
    chainPair('superBlock', super1.address, chain1.superBlock === null ? null : chain1.superBlock.address);
    chainPair('addressSpace', addrSpace1.address, chain1.addressSpace === null ? null : chain1.addressSpace.address);
    chainPair('f_path.mnt', file1.path.mnt, chain1.mount === null ? null : chain1.mount.vfsmount);
    if (chain1.path === null || chain1.path.path !== path1.path) {
      chainMismatches.push(`路径：我们=${path1.path} 链式=${chain1.path === null ? 'null' : chain1.path.path}`);
    }
    if (chain1.closeOnExec !== false) chainMismatches.push(`closeOnExec：链式=${chain1.closeOnExec}，fd 3 不该置这一位`);

    /**
     * 契约的诚实性：`toFileRef` 的每一项都要能对上**已经独立验过的**那份事实，
     * 而不是"把同一处内存再读一遍"：`inodeNumber` 对客体 `stat` 报的 `i_ino`、
     * `size` 对 `i_size`、`offset` 对 `f_pos`（也与客体 `fdinfo` 的 `pos` 相同）、
     * `path` 对客体 `readlink`、`deviceId` 对 `s_dev` 解出来的主:次。
     */
    const fileRef = toFileRef(chain1);
    const newDecodeDev = (encoded) => {
      // `new_encode_dev` 的逆：`major = (dev >> 8) & 0xfff`、`minor = (dev & 0xff) | ((dev >> 12) & 0xfff00)`。
      const major = (encoded >> 8n) & 0xfffn;
      const minor = (encoded & 0xffn) | ((encoded >> 12n) & 0xfff00n);
      return { major, minor };
    };
    const devDecodedFromGuest = guestStat === null ? null : newDecodeDev(guestStat.dev);
    const deviceIdExpected = chain1.superBlock === null ? null : chain1.superBlock.devDecoded.text;
    const fileRefMismatches = [];
    const refExpect = (label, actual, expected) => {
      if (actual !== expected) fileRefMismatches.push(`${label}：契约=${String(actual)} 期望=${String(expected)}`);
    };
    refExpect('fd', fileRef.fd, 3);
    refExpect('fileAddress', fileRef.fileAddress, hex(file1.address));
    refExpect('offset', fileRef.offset, hex(file1.fPos));
    refExpect('flags', fileRef.flags, hex(BigInt(file1.fFlags >>> 0)));
    refExpect('dentryAddress', fileRef.dentryAddress, hex(dentry1.address));
    refExpect('inodeAddress', fileRef.inodeAddress, hex(inode1.address));
    refExpect('path', fileRef.path, LAB_FILE);
    refExpect('inodeNumber', fileRef.inodeNumber, inode1.ino.toString());
    refExpect('size', fileRef.size, hex(inode1.size));
    refExpect('refCount', fileRef.refCount, Number(file1.fCount));
    refExpect('deviceId', fileRef.deviceId, deviceIdExpected);
    if (guestStat !== null) {
      refExpect('inodeNumber 对客体 stat', fileRef.inodeNumber, guestStat.ino.toString());
      refExpect('size 对客体 stat', fileRef.size, hex(guestStat.size));
      refExpect('offset 对客体 fdinfo.pos', fileRef.offset, `0x${guestFdinfo.pos.toString(16)}`);
      refExpect(
        'deviceId 对客体 stat 的 %d 反解出的主:次',
        fileRef.deviceId,
        devDecodedFromGuest === null ? null : `${devDecodedFromGuest.major}:${devDecodedFromGuest.minor}`,
      );
    }
    if (fileRef.evidence === null || fileRef.evidence === undefined) fileRefMismatches.push('evidence 缺失');
    evidence.fileChain = {
      fd: chain1.fd,
      fdSlotAddress: hex(chain1.fdSlotAddress),
      closeOnExec: chain1.closeOnExec,
      fileAddress: hex(chain1.file.address),
      dentryAddress: chain1.dentry === null ? null : hex(chain1.dentry.address),
      inodeAddress: chain1.inode === null ? null : hex(chain1.inode.address),
      mount: chain1.mount === null ? null : {
        vfsmount: hexOrNull(chain1.mount.vfsmount),
        rootDentry: hexOrNull(chain1.mount.rootDentry),
        superBlock: hexOrNull(chain1.mount.superBlock),
        flags: chain1.mount.flags,
      },
      superBlockAddress: chain1.superBlock === null ? null : hex(chain1.superBlock.address),
      addressSpaceAddress: chain1.addressSpace === null ? null : hex(chain1.addressSpace.address),
      path: chain1.path === null ? null : chain1.path.path,
      notes: chain1.notes,
      compared: chainMismatches.length,
      mismatches: chainMismatches,
      fileRef: {
        fd: fileRef.fd,
        fileAddress: fileRef.fileAddress,
        offset: fileRef.offset,
        flags: fileRef.flags,
        dentryAddress: fileRef.dentryAddress,
        inodeAddress: fileRef.inodeAddress,
        path: fileRef.path,
        inodeNumber: fileRef.inodeNumber,
        deviceId: fileRef.deviceId,
        size: fileRef.size,
        refCount: fileRef.refCount,
        mismatches: fileRefMismatches,
      },
      deviceFromGuestStat: devDecodedFromGuest === null ? null : `${devDecodedFromGuest.major}:${devDecodedFromGuest.minor}`,
    };
    check(
      'T07d-V14 契约的链式入口 `readFileChain` 走出来的每一环都与逐字段解析的那一份相同（同一个 file/dentry/inode/super_block/address_space、'
        + '同样的路径与 close_on_exec 位）；`toFileRef` 的每一项都诚实：fd/地址/偏移/路径/inode 号/设备号/大小/引用数都能对上'
        + '已经独立验过的事实（`i_ino`/`i_size`/`f_pos` 与客体 `stat`/`fdinfo`、`s_dev` 与客体 `st_dev`）',
      chainMismatches.length === 0
        && chain1.fd === 3 && chain1.closeOnExec === false
        && chain1.file.address === file1.address
        && chain1.inode !== null && chain1.inode.address === inode1.address
        && chain1.superBlock !== null && chain1.superBlock.address === super1.address
        && chain1.addressSpace !== null && chain1.addressSpace.address === addrSpace1.address
        && chain1.path !== null && chain1.path.path === LAB_FILE
        && fileRefMismatches.length === 0
        && fileRef.path === LAB_FILE && fileRef.inodeNumber === inode1.ino.toString()
        && fileRef.size === hex(inode1.size) && fileRef.offset === hex(file1.fPos),
      `链式：fd=${chain1.fd} slot=${hex(chain1.fdSlotAddress)} file=${hex(chain1.file.address)} `
        + `dentry=${chain1.dentry === null ? 'null' : hex(chain1.dentry.address)} inode=${chain1.inode === null ? 'null' : hex(chain1.inode.address)} `
        + `sb=${chain1.superBlock === null ? 'null' : hex(chain1.superBlock.address)} `
        + `mapping=${chain1.addressSpace === null ? 'null' : hex(chain1.addressSpace.address)} path=${chain1.path === null ? 'null' : chain1.path.path}；`
        + `链式与逐字段不一致 ${chainMismatches.length}${chainMismatches.length === 0 ? '' : `：${chainMismatches.slice(0, 4).join(' | ')}`}；`
        + `toFileRef：ino=${fileRef.inodeNumber} size=${fileRef.size} offset=${fileRef.offset} dev=${fileRef.deviceId} `
        + `count=${fileRef.refCount} path=${fileRef.path}`
        + `${fileRefMismatches.length === 0 ? '' : `；不一致：${fileRefMismatches.slice(0, 5).join(' | ')}`}`,
    );

    // ---------- V14b 卸掉断点，让 lab-read 真的把文件读完 ----------

    /**
     * 到这一步客体还**冻在断点上**：`lab-read` 刚进 `ext2_file_read_iter` 的入口，那一页还没读。
     * 卸掉断点再 `continue`，它才会真的读、真的把 89 字节写到串口。这段输出是"同一个文件的字节"
     * 的第三个来源（我们读的 `i_size`、交互 shell `cat` 出来的内容、`lab-read` 自己读出来又写回去的内容），
     * 三者相同才说明这条链上的"大小/内容"没有两套说法。
     *
     * 顺带这也是"卸掉断点之后不再有停点"的证据：帧号不再增长，停点总数不超过本轮的上限。
     */
    const framesBeforeResume = live.frames.length;
    const frameIdBeforeResume = live.frames.at(-1)?.frameId ?? 0;
    let removeAfterClaimStatus = null;
    if (removeBreakpointId !== null) {
      const removed = await cmd('breakpoint.remove', { breakpointId: removeBreakpointId });
      removeAfterClaimStatus = removed.status;
      removeBreakpointId = null;
    }
    const resumeCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    const resumeContinue = await cmd('continue');
    const readMarker = `READ${readClaim.attempts.length}Y-DONE-`;
    let resumedText = '';
    let resumeError = null;
    try {
      resumedText = await waitForTerminalMarker(app, base, readMarker, 120000, resumeCursor);
    } catch (error) {
      resumeError = error.message;
    }
    await sleep(2000);
    const readPayload = resumedText.split(readMarker)[0];
    const stopsAfterResume = live.frames.length - framesBeforeResume;
    const frameIdAfterResume = live.frames.at(-1)?.frameId ?? 0;
    const payloadBytes = Buffer.from(readPayload, 'utf8');
    const catBytes = Buffer.from(guestCat, 'utf8');
    /**
     * 串口把 `\\n` 展成 `\\r\\n`（tty 的 ONLCR），所以"读出来多少字节"和"文件有多大"之间
     * 差的正好是行数。两路输出先按**原始流**逐字节比，再把行尾归一后与 `i_size` 比 ——
     * 不归一就直接比长度，会把一次正确的读判成"多读了几个字节"。
     */
    const normalizeTerminal = (text) => text.replace(/\r\n/g, '\n');
    const payloadNormalized = normalizeTerminal(readPayload);
    const catNormalized = normalizeTerminal(guestCat);
    const payloadBytesNormalized = Buffer.from(payloadNormalized, 'utf8');
    const catBytesNormalized = Buffer.from(catNormalized, 'utf8');
    const payloadsAgree = readPayload === guestCat;
    const payloadsAgreeNormalized = payloadNormalized === catNormalized;
    const crlfExpandedBytes = payloadBytes.length - payloadBytesNormalized.length;
    evidence.resume = {
      attempts: readClaim.attempts.length,
      marker: readMarker,
      removeAfterClaimStatus,
      continueStatus: resumeContinue.status,
      error: resumeError,
      payload: { text: readPayload, bytes: payloadBytes.length, sha256: crypto.createHash('sha256').update(payloadBytes).digest('hex') },
      guestCat: { text: guestCat, bytes: catBytes.length, sha256: crypto.createHash('sha256').update(catBytes).digest('hex') },
      inodeSize: inode1.size.toString(),
      payloadsAgree,
      payloadsAgreeNormalized,
      normalized: {
        payloadBytes: payloadBytesNormalized.length,
        catBytes: catBytesNormalized.length,
        crlfExpandedBytes,
      },
      stopsAfterResume,
      frameIdBeforeResume,
      frameIdAfterResume,
      maxStopsBudget: MAX_STOPS,
    };
    check(
      'T07d-V14b 卸掉断点后 `lab-read` 真的把文件读完：它读出来写到串口的字节与交互 shell `cat` 出来的内容逐字节相同，'
        + '长度也等于 `i_size`；且卸掉断点之后再没有新的停点（帧号不增长、停点总数不超过本轮上限）',
      resumeError === null && removeAfterClaimStatus === 200
        && payloadsAgree && payloadsAgreeNormalized
        && payloadBytesNormalized.length === Number(inode1.size)
        && payloadBytes.length > 0
        && stopsAfterResume === 0 && frameIdAfterResume === frameIdBeforeResume
        && live.frames.length <= MAX_STOPS,
      `lab-read 读出 ${payloadBytes.length} 字节（sha256=${crypto.createHash('sha256').update(payloadBytes).digest('hex').slice(0, 16)}…），`
        + `shell cat 出来 ${catBytes.length} 字节（原始流逐字节相同=${payloadsAgree}），`
        + `行尾归一后 ${payloadBytesNormalized.length} 字节（串口 ONLCR 多出 ${crlfExpandedBytes} 字节），i_size=${inode1.size}；`
        + `卸断点 HTTP=${removeAfterClaimStatus}，continue=${resumeContinue.status}，`
        + `卸点后新增停点 ${stopsAfterResume} 个（帧号 ${frameIdBeforeResume}→${frameIdAfterResume}，本轮总帧数 ${live.frames.length}/上限 ${MAX_STOPS}）`
        + `${resumeError === null ? '' : `；等串口标记失败：${resumeError}`}`
        + `${payloadsAgree ? '' : `；内容不同：lab-read=${JSON.stringify(readPayload.slice(0, 120))} cat=${JSON.stringify(guestCat.slice(0, 120))}`}`,
    );

    // ---------- V15 边界与错误码：读不到就报读不到，不许把 0 当结论 ----------

    /**
     * 这一节要证明的是"空地址报的是空地址，不是 0"，以及"fd 越界与 fd 没打开分得开"。
     * 每一条都用**真实调用**去触发，比对错误码 —— 只比"有没有抛错"是不够的：
     * 把 `fd-not-open` 写成 `fd-out-of-range` 也是抛错，但面板上那句话就变了意思。
     */
    const captureError = async (label, run) => {
      try {
        await run();
        return { label, code: null, message: '（没有抛错：本该报错却没报）' };
      } catch (error) {
        return {
          label,
          code: typeof error?.code === 'string' ? error.code : null,
          isFilesParseError: error instanceof FilesParseError,
          isCaptureReadError: error instanceof CaptureReadError,
          message: String(error?.message ?? error).slice(0, 200),
        };
      }
    };
    const maxFdsNow = files1.fdtable.maxFds;
    const closedFd = maxFdsNow - 1;
    const boundaryCases = [];
    boundaryCases.push(await captureError('readFiles(0)', () => readFiles(view1, layout, 0n)));
    boundaryCases.push(await captureError('readFdtable(0)', () => readFdtable(view1, layout, 0n)));
    boundaryCases.push(await captureError('readFile(0)', () => readFile(view1, layout, 0n)));
    boundaryCases.push(await captureError('readDentry(0)', () => readDentry(view1, layout, 0n)));
    boundaryCases.push(await captureError('readInode(0)', () => readInode(view1, layout, 0n)));
    boundaryCases.push(await captureError('readSuperBlock(0)', () => readSuperBlock(view1, layout, 0n)));
    boundaryCases.push(await captureError('readAddressSpace(0)', () => readAddressSpace(view1, layout, 0n)));
    boundaryCases.push(await captureError('readXaNode(0)', () => readXaNode(view1, layout, 0n)));
    boundaryCases.push(await captureError(
      `readFileChain(fd=${maxFdsNow}，超出这张表的范围)`,
      () => readFileChain(view1, layout, { files: files1, fd: maxFdsNow }),
    ));
    boundaryCases.push(await captureError(
      `readFileChain(fd=${closedFd}，槽是空的)`,
      () => readFileChain(view1, layout, { files: files1, fd: closedFd }),
    ));
    const expectedCodes = [
      ['readFiles(0)', 'null-files'],
      ['readFdtable(0)', 'null-fdtable'],
      ['readFile(0)', 'null-file'],
      ['readDentry(0)', 'null-dentry'],
      ['readInode(0)', 'null-inode'],
      ['readSuperBlock(0)', 'null-superblock'],
      ['readAddressSpace(0)', 'null-address-space'],
      ['readXaNode(0)', 'null-xa-node'],
      [`readFileChain(fd=${maxFdsNow}，超出这张表的范围)`, 'fd-out-of-range'],
      [`readFileChain(fd=${closedFd}，槽是空的)`, 'fd-not-open'],
    ];
    const codeMismatches = expectedCodes
      .map(([label, expected]) => {
        const found = boundaryCases.find((entry) => entry.label === label);
        return found === undefined || found.code !== expected
          ? `${label}：期望 code=${expected} 实际=${found === undefined ? '（这一条没跑）' : `${found.code}（${found.message}）`}`
          : null;
      })
      .filter((line) => line !== null);
    const allFilesParseErrors = boundaryCases.every((entry) => entry.isFilesParseError === true);
    evidence.boundaries = {
      cases: boundaryCases,
      expected: Object.fromEntries(expectedCodes),
      mismatches: codeMismatches,
      allFilesParseErrors,
      unreachable: [
        'null-fdt（`files_struct.fdt` 是空指针）与 fd-array-missing（`fdt->fd` 是空指针）：'
        + '在这台客体的这个停点上两者都不是空，没有合法的办法凭空造出来，所以只记下它们存在，不假装验过',
        'null-vfsmount：需要 `f_path.mnt` 为空，正常打开的普通文件不会出现',
      ],
    };
    check(
      'T07d-V15 边界与错误码如实：空地址分别报 null-files/null-fdtable/null-file/null-dentry/null-inode/'
        + 'null-superblock/null-address-space/null-xa-node，fd 越界报 fd-out-of-range、fd 没打开报 fd-not-open；'
        + '全部是 `FilesParseError`（属于采集读错误这一类），没有把"空"当成 0 悄悄读下去',
      codeMismatches.length === 0 && allFilesParseErrors
        && boundaryCases.every((entry) => entry.code !== null)
        && closedFd > 3,
      boundaryCases.map((entry) => `${entry.label}→${entry.code}`).join('；')
        + `；不一致 ${codeMismatches.length}${codeMismatches.length === 0 ? '' : `：${codeMismatches.join(' | ')}`}`
        + `；读不到的几种（如实记下不假装验过）：${evidence.boundaries.unreachable.length} 类`,
    );

    /* ---------- 收尾：暂停会话、留档现场 ---------- */

    // 收尾前先把会话停住：`lab-read` 已经读完、断点也卸了，此时 pause 让它停在当前
    // PC 上不再空转吃 CPU；再留一段终端尾巴，日后回看这一轮"到底看到了什么"时不用重建。
    await cmd('pause');
    const finalTail = await call(app, 'GET', `${base}/terminal`);
    evidence.terminalTail = String(finalTail.body?.text ?? '').slice(-1500);
    // 把构建锁原样留一份：这条验收用的 vmlinux / QEMU / 内核源码树版本，日后回看
    // 证据时不必再去猜"当时是哪个构建"。
    evidence.buildLock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'instrumentation/qemu-observer/build.lock.json'), 'utf8'),
    );
    // V16 复查用的是**这条链上真实存在的地址**：一个已经关掉的会话如果还能从这个地址
    // 读出字段，那读到的只能是缓存或另一个进程里的旧现场。
    probeAddress = file1?.address ?? chain1?.file?.address ?? null;

  } catch (error) {
    check('T07d 脚本异常', false, error.message);
    evidence.error = { message: error.message, stack: String(error.stack).slice(0, 2000) };
  } finally {
    // 会话必须**真的关掉**：这里跑的是真实 QEMU + GDB，一个没关干净的会话会在后台
    // 持续吃 CPU，并且留下一个占着端口与磁盘文件的 TCG 进程。所以关掉之后按会话号
    // 数一遍进程（`ps` 里命令行含这个会话号的都算），必须是 0 —— 同时还要证明它
    // **不再答得出客体字段**：只看接口返回的 `closed: true` 就收工，等于自己给自己盖章。
    if (session) {
      const closedByUs = await call(app, 'DELETE', `/api/sessions/${session.id}`);
      await sleep(1500);
      const leftover = countSessionProcesses(session.id);
      const afterClose = probeAddress === null ? null : await call(
        app, 'GET',
        `/api/sessions/${session.id}/memory?address=${hex(probeAddress)}&length=16`
        + `&frameId=${live?.frames?.at(-1)?.frameId ?? 0}`,
      );
      check(
        'T07d-V16 会话关闭成功、没有残留 QEMU/GDB 进程，而且关闭后拒绝再读客体内存'
          + '（404 session-not-found，而不是把缓存里的旧值当作现场继续答）',
        closedByUs.status === 200 && closedByUs.body?.closed === true && leftover === 0
          && afterClose !== null && afterClose.status === 404
          && afterClose.body?.error?.code === 'session-not-found',
        `${describe(closedByUs.body)}；残留进程数=${leftover}；`
          + `关闭后再读 ${probeAddress === null ? '（没有可读地址，说明更早就失败了）' : hex(probeAddress)}：`
          + `${afterClose === null ? '没测' : `HTTP ${afterClose.status} ${describe(afterClose.body)}`}`,
      );
    } else {
      check(
        'T07d-V16 会话关闭成功、没有残留 QEMU/GDB 进程，而且关闭后拒绝再读客体内存'
          + '（404 session-not-found，而不是把缓存里的旧值当作现场继续答）',
        false,
        '会话压根没建起来，无从关闭',
      );
    }
    await app.close();
    // GDB 会把 `source` 进来的脚本编译成字节码缓存；缓存里带着本轮的输出路径与
    // 地址参数，留着既没用又容易让下一次误读成"这轮的结果"。
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