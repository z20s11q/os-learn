#!/usr/bin/env node
/**
 * T07f 验收：I/O 关联（文件/folio/bio/request/virtqueue/device request）。
 *
 *   node scripts/verify-t07f.mjs        （约 12–25 分钟，TCG 上要真启动一台 Linux）
 *
 * 这一节要验的是"这一次 I/O 到底在搬哪个文件的哪一页、在设备侧走到哪一步了"。
 * 这一层上的错有一个共同特征：**错的答案照样是个合法对象**：
 *
 * - `rq->tag` 是个小整数，偏移读错也照样落在一个"像请求号"的范围里；
 * - PDU 是 `blk_mq_rq_to_pdu(rq)`。本内核里它的函数体就是 `return rq + 1;` ——
 *   C 的指针加法等于 `rq + sizeof(struct request)`；`sizeof` 少算一点，读到的
 *   `out_hdr.type` 仍然会是 0/1/4 里的一个合法值，扇区号也照样"像个扇区号"；
 * - `struct virtqueue` 是 `struct vring_virtqueue` 的**第一个成员**（两者同址）。
 *   把 `vq->split.vring` 读成"vq 里的一个指针"还是"vq 偏移处内嵌的结构"，
 *   两种都读得出来，只是 `desc/avail/used` 三个地址会整体错开、指向另一片内存，
 *   而那片内存里常常正好也有一组"看着合理"的描述符；
 * - "这个描述符槽属于哪个请求"唯一权威的答案是 `split.desc_state[head].data`：
 *   `virtqueue_add_sgs()` 传进去的 token 就是**请求私有区的地址**（`virtblk_add_req`
 *   最后一句 `virtqueue_add_sgs(vq, sgs, num_out, num_in, vbr, GFP_ATOMIC)`），
 *   而 `detach_buf_split()` 的**第一句**把它清成 NULL。靠描述符里的地址反推只是旁证。
 *
 * 所以每条断言都要靠**另一套独立机制**读同一份事实。本脚本用了五条互不相干的通道：
 *
 *   1. 解析器（`packages/linux-decoder/io/`）：布局来自 T07a 的 DWARF 产物，
 *      字节来自服务的线性地址读（`KernelMemoryView`）。
 *   2. GDB 侧参照（`scripts/t07f-gdb-reference.py`）：类型/偏移/字段宽度/枚举取值全部
 *      由 **GDB 自己的 DWARF 解释**给出；描述符链、bio 链、`desc_state` 的 token、
 *      `bv_page` → 页框号（页框号要现场解 vmemmap 基址）**全部自己重写一遍**，
 *      不调用我方任何代码。
 *   3. **停点的寄存器**：`virtblk_add_req(vq, vbr)` 的 `$rdi` 是 vq、`$rsi` 是 vbr（= PDU），
 *      而 `blk_mq_rq_from_pdu(pdu)` 就是 `pdu - sizeof(struct request)`；`file_write_and_wait_range` 的
 *      `$rdi` 是 `struct file *`。于是"设备此刻在搬的请求"和"文件此刻在落盘的 file"
 *      各有一份完全不经过我们解析器的来源。
 *   4. **内核源码现场重解析**：`blk_types.h` 的 `REQ_OP_BITS`/`REQ_FLAG_BITS`/`enum req_op`/
 *      `enum req_flag_bits`/`BLK_STS_*`、`blk-mq.h` 的 `enum mq_rq_state`/`blk_mq_rq_to_pdu`、
 *      `virtio_blk.h` 的 `VIRTIO_BLK_T_*`/`VIRTIO_BLK_S_*`、`virtio_ring.h` 的 `VRING_DESC_F_*`、
 *      `virtio_blk.c` 的 `get_virtio_blk_vq`/`virtblk_add_req`/`virtblk_prep_rq`、
 *      `virtio_ring.c` 的 `desc_state[head].data` 写入/清空与 `last_used_idx++` 的先后、
 *      `mpage.c` 的 `REQ_RAHEAD`、`labs/linux-x86_64/lab.c` 里那段被测字节数
 *      —— 全部现读现比，不抄一份常量进脚本。
 *   5. **客体自报**：`lab-write` 写完并 `fsync` 之后自己回读同一个文件；`lab-read`
 *      从 `/data/probe.bin` 读回的字节数。这些是"程序真的做了这件事"的旁证。
 *
 * 四个真实停点（全部软件断点，理由同 T07b/T07c：内核在任务切换时会按任务的调试状态
 * 重写 DR0/DR7，硬件断点会静默失效）：
 *
 *   B1 `file_write_and_wait_range`（fsync 的第一步：`write()` 已经返回、页是脏的、
 *      还没有任何 I/O 在搬）—— 期望"缓存命中"：页在页缓存里、`PG_dirty` 立着、
 *      `carriedBy` 为空，判读必须是 `in-cache-dirty-no-io`。
 *   B2 `virtblk_add_req`（`$rdi=vq`、`$rsi=vbr`）—— 这一刻请求**还没进环**
 *      （`virtqueue_add_sgs` 还没跑），所以 `desc_state` 里没有它的 token，
 *      生命周期必须是 `not-submitted`，并且必须**如实报出"环上没有 token"这条歧义**，
 *      而不是把它说成"已经回收"。
 *   B3 同 B2，但由 `lab-read /data/probe.bin` 触发：方向必须是 `VIRTIO_BLK_T_IN`，
 *      并且 bio 上立着 `REQ_RAHEAD`（这是内核替程序提前读的那一段）。
 *   B4 `detach_buf_split`（`$rdi=vq`、`$rsi=head`）—— token 还挂在 `desc_state` 上、
 *      设备已经把这一项写进 used 环：生命周期必须是 `completed-on-device`；
 *      在这一点上描述符链还没被拆，所以"段数 = 1 + sgNents + 1"可以直接对账。
 *
 * 检查项：
 *   A0 布局产物与现场 vmlinux 绑定（build ID + sha256 现场重算）；T07f 需要的类型与符号一个不缺
 *   A1 常量表与内核源码现场重解析双向一致（REQ_OP_BITS/REQ_FLAG_BITS/req_op/req_flag_bits/
 *      BLK_STS_、MQ_RQ_、VIRTIO_BLK_T_、VIRTIO_BLK_S_、VRING_DESC_F_、BIO_、RQF_ 这几组名字）
 *   A2 GDB 的 DWARF（`sizeof`/`&((struct X *)0)->f`/枚举取值）与布局产物逐项一致
 *   A3 结构性事实（源码函数体）：`blk_mq_rq_to_pdu` 是 `rq + 1`；`desc_state[head].data`
 *      在 add 里写入、在 `detach_buf_split` 第一句清空、`last_used_idx++` 在其后；
 *      `virtblk_add_req` 传给队列的 token 是 `vbr` 且摊成 `1 (+ nents) + 1` 段；
 *      `get_virtio_blk_vq` 走 `hctx->queue->queuedata` + `vqs[hctx->queue_num]`；
 *      `virtblk_prep_rq` 在 `virtblk_add_req` **之前**调 `blk_mq_start_request`；
 *      `mpage.c` 在 `is_readahead` 时立 `REQ_RAHEAD`
 *   A4 导出面与契约：`io/index.ts` 的导出名一个不缺；`RequestLifecycle` 五态齐全
 *   B0 客体真实启动到交互提示符
 *   B1 `lab-write` 停在 `file_write_and_wait_range`：`f_pos` = lab.c 里那段字符串的字节数、
 *      页在缓存里且脏、没有任何 bio 在搬它 → `in-cache-dirty-no-io`；GDB 侧参照独立读
 *      同一个 file/address_space/页，`mapping`/`index`/标志位与解析器一致
 *   B2 `virtblk_add_req`：全链（request→queue→hw_ctx→queuedata→vqs[]→virtqueue→desc_state→
 *      pdu→bio→folio）逐字段与 GDB 一致；生命周期 `not-submitted` 且歧义如实；
 *      请求搬的页与 B1 是同一页
 *   B3 `lab-read` 的 `virtblk_add_req`：方向 `VIRTIO_BLK_T_IN`、bio 上立着 `REQ_RAHEAD`
 *   B4 `detach_buf_split`：token 仍在、used 环里有这个头、描述符链段数 = 1 + sgNents + 1、
 *      生命周期 `completed-on-device`
 *   B5 会话关闭、没有残留 QEMU/GDB 进程、关闭后拒绝再读客体内存
 *
 * 结果写入 `artifacts/verify/t07f.json` 与 `artifacts/verify/t07f.log`。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../services/lab-server/main.mjs';
import {
  BIO_FLAG_BITS,
  BLK_STATUS_NAMES,
  CaptureReadError,
  KernelLayout,
  KernelMemoryView,
  REQ_FLAG_BITS,
  REQ_OP_BITS,
  RQ_FLAG_BITS,
  SECTOR_SHIFT,
  VIRTIO_BLK_S_NAMES,
  VIRTIO_BLK_T,
  VIRTIO_BLK_T_NAMES,
  VRING_DESC_F,
  VRING_DESC_F_NAMES,
  classifyFileWriteState,
  classifyLifecycle,
  classifyMergeSplit,
  classifyReadahead,
  decodeBioOpf,
  dedupedManifest,
  describeVirtioBlkType,
  linkBioToFolios,
  lookupToken,
  mqRqStateName,
  mqRqStates,
  readAddressSpace,
  readDescriptorOwners,
  readFile,
  readFiles,
  readHwCtx,
  readInode,
  readMqTags,
  readPageCache,
  readRequest,
  readRequestQueue,
  readTask,
  readVirtblkReq,
  readVirtioBlk,
  readVirtqueue,
  requestFlagBits,
  requestIdentity,
  requestOpNames,
  requestPduAddress,
  resolveVmemmapBase,
  structRequestSizeOf,
  traceRequest,
  virtqueueAddressForQueue,
  walkDescriptorChain,
} from '../packages/linux-decoder/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VMLINUX = path.join(ROOT, 'artifacts/build/linux/vmlinux');
const LAYOUT_PATH = path.join(ROOT, 'artifacts/layout/linux-6.12.112-observatory-f5e5edc1c572.json');
const REFERENCE_PY = path.join(ROOT, 'scripts/t07f-gdb-reference.py');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t07f.json');
const EVIDENCE_LOG = path.join(ROOT, 'artifacts/verify/t07f.log');

/** A 段要现场重解析的内核源码（全部只读；改了它们就是改了判据）。 */
const SRC = path.join(ROOT, 'src/linux-6.12.112');
const BLK_TYPES_H = path.join(SRC, 'include/linux/blk_types.h');
const BLK_MQ_H = path.join(SRC, 'include/linux/blk-mq.h');
const VIRTIO_BLK_H = path.join(SRC, 'include/uapi/linux/virtio_blk.h');
const VIRTIO_RING_H = path.join(SRC, 'include/uapi/linux/virtio_ring.h');
const VIRTIO_BLK_C = path.join(SRC, 'drivers/block/virtio_blk.c');
const VIRTIO_RING_C = path.join(SRC, 'drivers/virtio/virtio_ring.c');
const MPAGE_C = path.join(SRC, 'fs/mpage.c');
const IO_INDEX_TS = path.join(ROOT, 'packages/linux-decoder/io/index.ts');
/** 被测程序自己：B1 期望写下去多少字节，直接从这份 C 源码里现算。 */
const LAB_C = path.join(ROOT, 'labs/linux-x86_64/lab.c');

/** 客体里被测的两个文件（来自 `scripts/build-rootfs.sh` 的 ext2 镜像）。 */
const LAB_WRITE_FILE = '/data/written.txt';
const LAB_READ_FILE = '/data/probe.bin';
/** `build-rootfs.sh` 里 `probe.bin` 是 512 个 4096 字节块，共 2 MiB。 */
const PROBE_BYTES = 512 * 4096;

const PROMPT = /linux-lab:[^\r\n]*# /;
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

/**
 * 把可能带 bigint 的结构渲染成一行。
 *
 * `JSON.stringify` 遇到 `bigint` 会直接抛 `Do not know how to serialize a BigInt`，
 * 而这里要打印的（"这一页被哪个请求的哪一段搬着"）恰恰全是大地址 —— 用 replacer 先把
 * bigint 换成十六进制字符串，明细文字才不会在运行时炸掉。
 */
function jsonHex(value) {
  return JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? hex(item) : item));
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
 * 读取 JSON，但**不让大整数掉进双精度陷阱**（理由与实现同 T07b/T07c/T07d）。
 *
 * GDB 侧对照数据里的内核地址全在 `0xffff…` 量级（约 1.8e19），一落进 JS 的 `number`
 * 就被就近取整成几百字节外的另一个地址，症状是"地址集合差了几个"而小整数完好，
 * 极容易被误判成符号解析错乱。做法是把字符串之外 ≥16 位的整数字面量加引号再交给
 * `JSON.parse`：它们以十进制字符串的身份完整抵达，`BigInt()` 一取就是精确值。
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
 * 调用方传入的标记所以都写成 `WR${n}ITE1-DONE-` 这种**成对的空引号**形式：回显里是
 * `W${n}""RITE1-DONE-`，而真正的输出是 `W${n}RITE1-DONE-`。引号必须成对，否则 shell
 * 会停在 PS2 续行提示符上等输入，命令根本不执行（T07b 踩过这个坑）。
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
    maxAttempts = 8, perFrameWaitMs = 10000, settleMs = 4000, attemptBudgetMs = CLAIM_BUDGET_MS,
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
        requestId: `t07f-claim-${++claimSeq}-${attempt}-${symbol}`,
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
    sizes.set(name, Number(match[2]));
  }
  return { addresses, sizes, duplicates };
}

function parseBuildId(text) {
  const match = /Build ID:\s*([0-9a-f]+)/.exec(text);
  return match === null ? null : match[1];
}

/**
 * 帧里的通用寄存器是**按名字发现的数组**（`cpu.general`），不是 `cpu.registers.rdi`；
 * 从数组里按名字取，取不到就是真的没采到 —— 不许拿别的寄存器顶替。
 */
function generalRegister(cpu, name) {
  for (const entry of cpu?.general ?? []) {
    if (String(entry?.name ?? '').toLowerCase() !== name) continue;
    return entry.value === null || entry.value === undefined ? null : BigInt(entry.value);
  }
  return null;
}

/* ==========================================================================
 * 通道一：把服务的 `memory.read` 包成解析器要的"只读采集"
 *
 * 解析器（`packages/linux-decoder/io/`）只吃 `ReadOnlyCapture` 这一个接口：给它地址和
 * 长度，它拿回字节。这里把服务的线性地址读包成同一个接口，于是**同一份解析器**既能对着
 * 服务刚读回来的真实内核内存跑，也能对着单测拼出来的内存跑。
 *
 * 为什么每次读都要带 `requestId`/`epoch`/`expectedFrameId`：服务按这三个字段做幂等与
 * 新鲜度检查。`requestId` 重复会让服务把**上一次**的结果原样返回（并跳过新鲜度检查），
 * 于是"读到的其实是别处的字节"这件事永远不会报错。所以整轮运行内必须唯一。
 * ========================================================================== */

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
      requestId: `t07f-capture-${this.attribution.frameId}-${++captureReadSeq}`,
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
    return this.symbols?.get(name) ?? null;
  }

  symbolSize(name) {
    return this.sizes?.get(name) ?? null;
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
  if (offsetTable === null || percpuHotLink === null) return { comm: null, label: '读不到', pid: null, taskAddress: null };
  const percpuBase = littleEndian(await capture.readVirtual(offsetTable, 8));
  const task = littleEndian(await capture.readVirtual(percpuBase + percpuHotLink, 8));
  if (task === 0n) return { comm: null, label: 'current=0（空闲任务）', pid: null, taskAddress: null };
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

/* ==========================================================================
 * 通道二：GDB 侧参照实现（类型/偏移/枚举一律由 GDB 自己的 DWARF 解释）
 * ========================================================================== */

/**
 * 在**当前停点**跑一遍 GDB 侧参照实现，把结果 JSON 读回来。
 *
 * 走 `source` 而不是让脚本自己读内存：参照实现必须用 GDB 自己的 DWARF 解释。时间上限
 * 给得很大 —— 它要逐字段读 request/pdu/queue/hw_ctx/virtqueue/描述符链/bio 链/XArray，
 * 在 TCG + 远程 gdbstub 上要几十秒，而 MI 适配器默认只有 20 秒。读回来必须走
 * `parseBigJson`：内核地址在 `0xffff…` 量级，落进 JS 的 `number` 会被就近取整。
 *
 * 六个输入里只有 `request` 是必需的（读不出请求，下面就全空）；B1 那个停点上还没有
 * 请求，所以 `request = 0` 是合法输入，此时参照实现只读文件那一侧。
 */
async function runReference(live, label, args) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `t07f-ref-${label}-`));
  const outPath = path.join(dir, 'reference.json');
  const scriptPath = path.join(dir, 'reference.py');
  try {
    const source = fs.readFileSync(REFERENCE_PY, 'utf8')
      .replace('__OUT_PATH__', JSON.stringify(outPath))
      .replace('__REQUEST__', String(args.request ?? 0n))
      .replace('__PDU__', String(args.pdu ?? 0n))
      .replace('__VQ__', String(args.vq ?? 0n))
      .replace('__FILE__', String(args.file ?? 0n))
      .replace('__MAPPING__', String(args.mapping ?? 0n))
      .replace('__PAGE_INDEX__', String(args.pageIndex ?? -1));
    fs.writeFileSync(scriptPath, source);
    const record = await live.mi.console(`source ${scriptPath}`, { timeoutMs: 900000 });
    if (!fs.existsSync(outPath)) {
      const stream = String(record?.stream ?? '');
      fs.writeFileSync(path.join(path.dirname(EVIDENCE), `t07f-reference-${label}-failed.txt`), stream);
      return { ok: false, error: '参照脚本没有写出结果文件', stream: stream.slice(-800) };
    }
    const data = parseBigJson(fs.readFileSync(outPath, 'utf8'));
    fs.writeFileSync(
      path.join(path.dirname(EVIDENCE), `t07f-reference-${label}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ==========================================================================
 * 通道四：内核源码现场重解析
 *
 * 这一条通道的意义是"**判据本身**也是现读的"：常量表、位号、函数体里的先后顺序，全部
 * 从本次构建用的那棵源码树里现读现算，不抄一份进脚本。抄一份的话，将来内核改了、
 * 常量表没跟着改，验收会**继续通过**，而它本该失败。
 * ========================================================================== */

/** 去掉 `/* *\/` 与 `//` 注释（枚举体里两种都有，且注释里含逗号）。 */
function stripCComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** `#define NAME ...` 的原始右侧文本（只取第一行；续行的宏这里用不到）。 */
function defineText(text, name) {
  const pattern = new RegExp(`^\\s*#\\s*define\\s+${name}\\s+([^\\n]*)$`, 'm');
  const match = pattern.exec(text);
  return match === null ? null : match[1].trim();
}

/**
 * 算一个**编译期常量表达式**的值。支持：十进制/十六进制/八进制/二进制整数（含 `U`/`L`
 * 后缀）、已解析的标识符、括号、一元 `+ - ~ !`、二元 `+ - * / % << >> | & ^`。
 *
 * 为什么非要算表达式而不是"抓最后一个整数"：`blk_types.h` 里 `__REQ_FAILFAST_DEV =
 * REQ_OP_BITS`（**引用另一个宏**），`REQ_OP_MASK = ((1 << REQ_OP_BITS) - 1)`，
 * `BLK_STS_IOERR` 是 `((__force blk_status_t)10)`。只抓数字的实现会在引用宏那里
 * 悄悄退化成"读不到"，而"读不到"很容易被当成"这条不用比"。
 *
 * 类型转换 `(__force blk_status_t)10` 靠**先剥掉 `__force`、再把"只含一个不在表里的
 * 标识符"的括号当成类型转换丢掉**来处理；`(REQ_OP_BITS)` 因为名字在表里，不会被丢。
 */
function evalConstExpr(expression, env) {
  let text = String(expression).trim();
  text = text.replace(/\(\s*__force\s+/g, '(');
  // 强转：`(blk_status_t)` / `(unsigned long)`——只含标识符与空格的括号，且里面的名字
  // 不在已知常量表里，就当类型转换丢掉。含运算符的括号（如 `(1 << BITS)`）不会命中。
  for (let round = 0; round < 6; round += 1) {
    const next = text.replace(/\(\s*([A-Za-z_]\w*)\s*\)/g, (whole, name) => (name in env ? whole : ''));
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\b(__u\d+|u\d+|long|int|bool|void)\b/g, '');
  const tokens = text.match(/\d+[uUlL]*|0[xX][0-9a-fA-F]+[uUlL]*|0[bB][01]+[uUlL]*|[A-Za-z_]\w*|<<|>>|[()+\-~!*/%|&^]/g);
  if (tokens === null) return null;
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const parsePrimary = () => {
    const token = take();
    if (token === undefined) return null;
    if (token === '(') {
      const inner = parser.parseBinary(0);
      if (inner === null || take() !== ')') return null;
      return inner;
    }
    if (/^\d/.test(token) || /^0[xXbB]/.test(token)) {
      const bare = token.replace(/[uUlL]+$/, '');
      try {
        if (/^0[xX]/.test(bare)) return BigInt(bare);
        if (/^0[bB]/.test(bare)) return BigInt(`0b${bare.slice(2)}`);
        if (/^0[0-7]+$/.test(bare)) return BigInt(`0o${bare.slice(1)}`);
        return BigInt(bare);
      } catch {
        return null;
      }
    }
    return env[token] === undefined ? null : env[token];
  };
  const parseUnary = () => {
    const token = peek();
    if (token === '-' || token === '+' || token === '~' || token === '!') {
      take();
      const value = parseUnary();
      if (value === null) return null;
      if (token === '-') return -value;
      if (token === '+') return value;
      if (token === '~') return ~value;
      return value === 0n ? 1n : 0n;
    }
    return parsePrimary();
  };
  const PRECEDENCE = {
    '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
  };
  const parser = { parseBinary: null };
  parser.parseBinary = (minPrecedence) => {
    let left = parseUnary();
    if (left === null) return null;
    for (;;) {
      const operator = peek();
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minPrecedence) return left;
      take();
      const right = parser.parseBinary(precedence + 1);
      if (right === null) return null;
      if (operator === '+') left += right;
      else if (operator === '-') left -= right;
      else if (operator === '*') left *= right;
      else if (operator === '/') { if (right === 0n) return null; left /= right; }
      else if (operator === '%') { if (right === 0n) return null; left %= right; }
      else if (operator === '<<') left <<= right;
      else if (operator === '>>') left >>= right;
      else if (operator === '|') left |= right;
      else if (operator === '&') left &= right;
      else if (operator === '^') left ^= right;
    }
  };
  const value = parser.parseBinary(0);
  if (value === null || cursor !== tokens.length) return null;
  return value;
}

/** 取 `enum [name] { ... }` 的枚举体文本；`name` 为 null 时取**匿名**枚举（第一处）。 */
function enumBody(text, name) {
  const clean = stripCComments(text);
  const pattern = name === null
    ? /enum\s*\{/
    : new RegExp(`enum\\s+${name}\\s*\\{`);
  const match = pattern.exec(clean);
  if (match === null) return null;
  const close = clean.indexOf('};', match.index);
  return close < 0 ? clean.slice(match.index) : clean.slice(match.index, close + 2);
}

/**
 * 解析枚举：显式取值走 `evalConstExpr`，没写取值的按"上一个 +1"（C 的规则）。
 * `stopAt` 是哨兵名字（例如 `__REQ_NR_BITS`/`BIO_FLAG_LAST`）：它自己要算出来，但不进结果。
 */
function parseEnum(text, name, env, stopAt = null) {
  const body = enumBody(text, name);
  if (body === null) return { members: [], unresolved: ['（源码里没有这个枚举）'] };
  const open = body.indexOf('{');
  const inner = body.slice(open + 1, body.lastIndexOf('}'));
  const members = [];
  const unresolved = [];
  let previous = null;
  for (const raw of inner.split(',')) {
    const piece = raw.trim();
    if (piece.length === 0) continue;
    const match = /^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(piece);
    if (match === null) continue;
    const memberName = match[1];
    let value = null;
    if (match[2] === undefined) {
      value = previous === null ? 0n : previous + 1n;
    } else {
      value = evalConstExpr(match[2], env);
      if (value === null) unresolved.push(`${memberName} = ${match[2].trim()}`);
    }
    if (value === null) continue;
    env[memberName] = value;
    previous = value;
    if (stopAt !== null && memberName === stopAt) break;
    members.push({ name: memberName, value });
  }
  return { members, unresolved };
}

/** `#define` 里"纯数值/常量表达式"的那一批（跳过带参数与多行的宏）。 */
function parseNumericDefines(text, namePattern, env) {
  const out = new Map();
  const unresolved = [];
  const pattern = new RegExp(`^\\s*#\\s*define\\s+(${namePattern})\\s+([^\\n]*)$`, 'gm');
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const body = match[2].replace(/\/\/.*$/, '').replace(/\\$/, '').trim();
    if (body.includes('(') && new RegExp(`^${name}\\s*\\(`).test(body)) continue;
    const value = evalConstExpr(body, env);
    if (value === null) { unresolved.push(`${name} ${body}`); continue; }
    env[name] = value;
    out.set(name, value);
  }
  return { values: out, unresolved };
}

/**
 * 取某个函数的函数体（`static inline T name(...) { ... }`）。
 *
 * 判"哪一句在前"靠的就是这个：`virtblk_prep_rq` 里 `blk_mq_start_request(req)` 与
 * 调用方 `virtio_queue_rq` 里的 `virtblk_add_req(...)` 谁先谁后，决定了"请求算在飞了
 * 但还没进环"这一瞬是真实存在的状态，还是我们编出来的。
 */
function readFunctionBody(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) return null;
  const open = text.indexOf('{', at);
  if (open < 0) return null;
  const close = text.indexOf('\n}', open);
  if (close < 0) return null;
  return text.slice(open + 1, close);
}

/** 某个函数体里两个字符串谁先出现：都出现才给结论，否则 null（不猜）。 */
function orderInBody(body, first, second) {
  if (body === null) return null;
  const atFirst = body.indexOf(first);
  const atSecond = body.indexOf(second);
  if (atFirst < 0 || atSecond < 0) return null;
  return atFirst < atSecond ? 'first-before-second' : 'second-before-first';
}

/* ==========================================================================
 * 通道二之补充：A2 用的内嵌 GDB 驱动
 *
 * 只问一件事：**GDB 自己的 DWARF 说这些结构多大、字段在第几字节**。它不读内存、不碰
 * 参照脚本，所以可以在任何一次停住的时候跑（`sizeof`/`&((T*)0)->f` 是编译期常量，
 * 不需要活着的栈帧）。T07f 需要的 19 个结构与几十个字段在这里逐项问一遍。
 * ========================================================================== */

/** A2 要比对的结构与字段（字段名就是 GDB 表达式里 `->` 后面的路径）。 */
const DWARF_PROBE_TYPES = {
  request: ['q', 'mq_ctx', 'mq_hctx', 'cmd_flags', 'rq_flags', 'tag', 'internal_tag', 'timeout',
    '__data_len', '__sector', 'bio', 'biotail', 'part', 'nr_phys_segments', 'state', 'ref', 'end_io'],
  bio: ['bi_next', 'bi_bdev', 'bi_opf', 'bi_flags', 'bi_ioprio', 'bi_status',
    'bi_iter.bi_sector', 'bi_iter.bi_size', 'bi_iter.bi_idx', 'bi_iter.bi_bvec_done',
    'bi_vcnt', 'bi_max_vecs', 'bi_end_io', 'bi_private', 'bi_io_vec'],
  bio_vec: ['bv_page', 'bv_len', 'bv_offset'],
  scatterlist: ['page_link', 'offset', 'length', 'dma_address', 'dma_length'],
  virtblk_req: ['out_hdr.type', 'out_hdr.ioprio', 'out_hdr.sector', 'in_hdr', 'in_hdr_len',
    'sg_table.nents', 'sg_table.orig_nents', 'sg_table.sgl'],
  request_queue: ['queuedata', 'elevator', 'mq_ops', 'queue_ctx', 'queue_flags', 'rq_timeout',
    'queue_depth', 'refs', 'nr_hw_queues', 'hctx_table', 'last_merge', 'disk', 'nr_requests',
    'tag_set', 'mq_freeze_depth'],
  blk_mq_hw_ctx: ['queue', 'driver_data', 'ctxs', 'nr_ctx', 'tags', 'sched_tags', 'queue_num',
    'nr_active', 'type', 'flags', 'state'],
  blk_mq_ctx: ['cpu', 'index_hw', 'queue', 'hctxs', 'rq_lists'],
  blk_mq_tags: ['nr_tags', 'nr_reserved_tags', 'active_queues', 'bitmap_tags', 'breserved_tags', 'rqs'],
  virtio_blk: ['vdev', 'disk', 'index', 'num_vqs', 'io_queues', 'vqs', 'zone_sectors'],
  virtio_blk_vq: ['vq', 'lock', 'name'],
  virtio_blk_outhdr: ['type', 'ioprio', 'sector'],
  vring_virtqueue: ['vq.index', 'vq.num_free', 'vq.num_max', 'vq.name', 'vq.vdev', 'vq.priv',
    'packed_ring', 'indirect', 'event', 'broken', 'use_dma_api', 'premapped', 'do_unmap',
    'free_head', 'num_added', 'last_used_idx', 'split'],
  vring: ['num', 'desc', 'avail', 'used'],
  vring_desc: ['addr', 'len', 'flags', 'next'],
  vring_desc_state_split: ['data', 'indir_desc'],
  vring_avail: ['flags', 'idx', 'ring'],
  vring_used: ['flags', 'idx', 'ring'],
  vring_used_elem: ['id', 'len'],
};

/**
 * A2 要问取的单个标识符常量。宏（`REQ_OP_BITS`）GDB 通常答不出来，答不出就进
 * `unresolved` —— 那是"这一条 GDB 给不了第二来源"，不是"值不一致"，两者要分开。
 * 枚举项（`REQ_OP_READ`/`__REQ_RAHEAD`/`MQ_RQ_IN_FLIGHT`）来自 DWARF，能答出来，
 * 它们正是"布局产物里的枚举取值"的第二来源。
 */
const DWARF_PROBE_NAMES = [
  'REQ_OP_BITS', 'REQ_FLAG_BITS', 'REQ_OP_LAST', 'REQ_OP_MASK',
  'REQ_OP_READ', 'REQ_OP_WRITE', 'REQ_OP_FLUSH', 'REQ_OP_DISCARD', 'REQ_OP_SECURE_ERASE',
  'REQ_OP_ZONE_APPEND', 'REQ_OP_WRITE_ZEROES', 'REQ_OP_ZONE_OPEN', 'REQ_OP_ZONE_CLOSE',
  'REQ_OP_ZONE_FINISH', 'REQ_OP_ZONE_RESET', 'REQ_OP_ZONE_RESET_ALL',
  'REQ_OP_DRV_IN', 'REQ_OP_DRV_OUT',
  '__REQ_FAILFAST_DEV', '__REQ_FAILFAST_TRANSPORT', '__REQ_FAILFAST_DRIVER', '__REQ_SYNC',
  '__REQ_META', '__REQ_PRIO', '__REQ_NOMERGE', '__REQ_IDLE', '__REQ_INTEGRITY', '__REQ_FUA',
  '__REQ_PREFLUSH', '__REQ_RAHEAD', '__REQ_BACKGROUND', '__REQ_NOWAIT', '__REQ_POLLED',
  '__REQ_ALLOC_CACHE', '__REQ_SWAP', '__REQ_DRV', '__REQ_FS_PRIVATE', '__REQ_ATOMIC',
  '__REQ_NOUNMAP', '__REQ_NR_BITS',
  'MQ_RQ_IDLE', 'MQ_RQ_IN_FLIGHT', 'MQ_RQ_COMPLETE',
];

/**
 * 内嵌 GDB 驱动：把 `sizeof(struct X)`、`&((struct X *)0)->f`、标识符取值问一遍。
 *
 * 表达式写法与 `t07f-gdb-reference.py` 里逐字一致，理由也是同一条：这三样都是编译期
 * 常量，走 DWARF 解释，不读内存、不需要活的栈帧。
 */
function dwarfProbeSource(spec) {
  return `import json, traceback

OUT = ${JSON.stringify('__OUT_PATH__')}
TYPES = ${JSON.stringify(spec.types)}
NAMES = ${JSON.stringify(spec.names)}

def safe(fn):
    try:
        return fn()
    except Exception:
        return None

def sizeof(name):
    return safe(lambda: int(gdb.parse_and_eval('sizeof(struct %s)' % name)))

def offsetof(name, field):
    return safe(lambda: int(gdb.parse_and_eval('(unsigned long)&((struct %s *)0)->%s' % (name, field))))

def const_value(name):
    return safe(lambda: int(gdb.parse_and_eval('(long)%s' % name)))

out = {'sizes': {}, 'offsets': {}, 'values': {}, 'unresolved': {'sizes': [], 'offsets': [], 'values': []},
       'notes': []}
try:
    for name in TYPES:
        size = sizeof(name)
        if size is None:
            out['unresolved']['sizes'].append(name)
        else:
            out['sizes'][name] = size
        fields = {}
        for field in TYPES[name]:
            value = offsetof(name, field)
            if value is None:
                out['unresolved']['offsets'].append('%s.%s' % (name, field))
            else:
                fields[field] = value
        out['offsets'][name] = fields
    for name in NAMES:
        value = const_value(name)
        if value is None:
            out['unresolved']['values'].append(name)
        else:
            out['values'][name] = value
except Exception as exc:
    out['notes'].append('%s: %s' % (type(exc).__name__, exc))
    out['traceback'] = traceback.format_exc().splitlines()[-6:]

with open(OUT, 'w') as handle:
    json.dump(out, handle)
gdb.write('[t07f-dwarf] 对照数据已写入 %s\\n' % OUT)
`;
}

/** 跑一次 A2 的 DWARF 探针（写临时脚本 → source → 读回 JSON → 删）。 */
async function runDwarfProbe(live, label) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `t07f-dwarf-${label}-`));
  const outPath = path.join(dir, 'dwarf.json');
  const scriptPath = path.join(dir, 'dwarf.py');
  try {
    const source = dwarfProbeSource({
      types: DWARF_PROBE_TYPES,
      names: DWARF_PROBE_NAMES,
    }).replace('"__OUT_PATH__"', JSON.stringify(outPath));
    fs.writeFileSync(scriptPath, source);
    const record = await live.mi.console(`source ${scriptPath}`, { timeoutMs: 600000 });
    if (!fs.existsSync(outPath)) {
      return { ok: false, error: 'DWARF 探针没有写出结果文件', stream: String(record?.stream ?? '').slice(-600) };
    }
    const data = parseBigJson(fs.readFileSync(outPath, 'utf8'));
    fs.writeFileSync(
      path.join(path.dirname(EVIDENCE), `t07f-dwarf-${label}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ==========================================================================
 * A 段：与"活着的客体"无关的静态对账
 *
 * 这一段的目的是：**在花二十分钟启动一台 Linux 之前**，先把"判据本身"钉死。上面五条
 * 通道里有四条（解析器、源码重解析、DWARF、布局产物）都能在这一段里互相对完；剩下的
 * 第五条（停点与寄存器）才需要真的跑一台客体。
 * ========================================================================== */

/**
 * T07f 需要的类型。少一个，下面的解析器要么在某一步抛错，要么**读到一个合法但错的数**
 * （例如 `request` 的真实宽度取不到，退回一个猜的宽度，PDU 地址就整体偏，读到的
 * `out_hdr.type` 仍然是 0/1/4 里的一个）。
 */
const T07F_TYPES = [
  'request', 'bio', 'bio_vec', 'scatterlist', 'virtblk_req', 'virtio_blk_outhdr',
  'virtio_blk', 'virtio_blk_vq', 'request_queue', 'blk_mq_hw_ctx', 'blk_mq_ctx', 'blk_mq_tags',
  'virtqueue', 'vring_virtqueue', 'vring_virtqueue_split', 'vring', 'vring_desc',
  'vring_desc_state_split', 'vring_avail', 'vring_used', 'vring_used_elem',
  'page', 'folio', 'task_struct', 'file', 'address_space', 'xarray',
  'req_op', 'req_flag_bits', 'mq_rq_state', 'blk_status_t',
];

/** A0 要比的符号：三个真实停点 + 它们所在调用链上的两个函数。 */
const T07F_SYMBOLS = [
  'file_write_and_wait_range', 'generic_buffers_fsync_noflush', 'ext2_fsync',
  'virtblk_add_req', 'detach_buf_split', 'virtqueue_add_sgs',
];

/** 把 `__REQ_RAHEAD` 这种内核内部名换成表里的对外名。 */
function stripNamePrefix(name, prefix) {
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * 逐条比"名字 → 数值"。
 *
 * 两个方向都要报：我们多出来的名字（表比内核新）、内核多出来的名字（表比内核旧）。
 * 只报"不一致"会把后两种悄悄放过，而它们正是"表与内核不同步"的两种形态。
 */
function compareNameValueTables(ours, theirs) {
  const ourMap = new Map(ours.map((entry) => [entry.name, Number(entry.value)]));
  const mismatches = [];
  const oursOnly = [];
  const theirsOnly = [];
  let compared = 0;
  for (const [name, value] of ourMap) {
    if (!theirs.has(name)) { oursOnly.push(name); continue; }
    compared += 1;
    if (BigInt(value) !== BigInt(theirs.get(name))) {
      mismatches.push(`${name}: 我们=${value} 源码=${theirs.get(name)}`);
    }
  }
  for (const name of theirs.keys()) if (!ourMap.has(name)) theirsOnly.push(name);
  return { compared, mismatches, oursOnly, theirsOnly };
}

/** 从 `export { ... } from '...'` 里收集**运行时存在**的导出名（跳过 `export type`）。 */
function parseExportNames(text) {
  const names = [];
  for (const block of text.matchAll(/export\s+(type\s+)?\{([\s\S]*?)\}\s*from/g)) {
    if (block[1] !== undefined) continue;
    for (const raw of block[2].split(',')) {
      const token = raw.trim().replace(/\/\/[^\n]*/g, '').trim();
      if (token.length === 0 || token.startsWith('type ')) continue;
      const alias = /^(\S+)\s+as\s+(\S+)$/.exec(token);
      names.push(alias === null ? token : alias[2]);
    }
  }
  return names;
}

/**
 * 跑完 A 段全部检查。返回的证据随后写进 `artifacts/verify/t07f.json`。
 *
 * `live` 只在 A0（符号表三方一致）与 A2（GDB 的 DWARF）里用；A1/A3/A4 是纯源码/纯产物。
 */
async function runStaticChecks({ live, layout, symbols, sizes, api }) {
  const evidence = {};

  /* ---------------- A0：布局产物与现场 vmlinux 绑定 ---------------- */

  const liveSha256 = crypto.createHash('sha256').update(fs.readFileSync(VMLINUX)).digest('hex');
  const vmlinuxBuildId = parseBuildId(execFileSync('readelf', ['-nW', VMLINUX], { encoding: 'utf8' }));
  const required = dedupedManifest().filter((entry) => entry.required).map((entry) => entry.name);
  const missingRequired = required.filter((name) => layout.missing.some((entry) => entry.name === name));
  const missingNeeded = T07F_TYPES
    .filter((name) => !layout.has(name) || layout.type(name).declaration === true);

  const symbolFacts = {};
  for (const name of T07F_SYMBOLS) {
    const resolved = live.symbols.resolve(name, { module: 'linux-kernel' });
    const serviceAddress = resolved.found && !resolved.ambiguous
      ? BigInt(resolved.candidates[0].address) : null;
    const readelfAddress = symbols.get(name) ?? null;
    symbolFacts[name] = {
      service: hexOrNull(serviceAddress),
      readelf: hexOrNull(readelfAddress),
      size: sizes.get(name) ?? null,
      equal: serviceAddress !== null && readelfAddress !== null && serviceAddress === readelfAddress,
    };
  }

  evidence.binding = {
    layoutFile: path.basename(LAYOUT_PATH),
    layoutRelease: layout.linuxRelease,
    layoutBuildId: layout.buildId,
    layoutSha256: layout.sha256,
    liveSha256,
    vmlinuxBuildId,
    requiredTypes: required.length,
    missingRequired,
    t07fTypes: T07F_TYPES.length,
    missingNeeded,
    symbolFacts,
  };
  check(
    'T07f-A0 布局产物与现场 vmlinux 绑定：build ID 与 sha256 由 load() 现场重算并比对通过；'
      + `T07f 需要的 ${T07F_TYPES.length} 个类型一个不缺；${T07F_SYMBOLS.length} 个真实停点符号在服务与 readelf 两侧同址`,
    layout.sha256 === liveSha256
      && typeof layout.buildId === 'string' && layout.buildId.length === 40
      && (vmlinuxBuildId === null || vmlinuxBuildId === layout.buildId)
      && missingRequired.length === 0
      && missingNeeded.length === 0
      && Object.values(symbolFacts).every((entry) => entry.equal === true),
    `buildId=${String(layout.buildId).slice(0, 12)}（readelf=${String(vmlinuxBuildId).slice(0, 12)}）`
      + ` 缺失必需类型=${missingRequired.length} 缺失 T07f 类型=${missingNeeded.join('、') || '无'}`
      + `；符号：${Object.entries(symbolFacts).map(([name, entry]) => `${name}@${entry.service ?? '缺'}`).join(' ')}`,
  );

  /* ---------------- A1：常量表 ↔ 内核源码现场重解析 ---------------- */

  const blkTypesText = fs.readFileSync(BLK_TYPES_H, 'utf8');
  const blkMqText = fs.readFileSync(BLK_MQ_H, 'utf8');
  const virtioBlkText = fs.readFileSync(VIRTIO_BLK_C, 'utf8');
  const virtioBlkHeaderText = fs.readFileSync(VIRTIO_BLK_H, 'utf8');
  const virtioRingText = fs.readFileSync(VIRTIO_RING_C, 'utf8');
  const virtioRingHeaderText = fs.readFileSync(VIRTIO_RING_H, 'utf8');
  const mpageText = fs.readFileSync(MPAGE_C, 'utf8');

  const env = Object.create(null);
  const reqOpBits = evalConstExpr(defineText(blkTypesText, 'REQ_OP_BITS') ?? 'null', env);
  // 枚举里有多行初始化项：`__REQ_FAILFAST_DEV = /* 注释 */ REQ_OP_BITS,`。这些 `#define`
  // 必须先落进 env，否则那一项算不出来 → 它不进表、也不更新"上一项"，从它之后的每一项
  // 都会整体错位（`__REQ_RAHEAD` 会算成第 10 位）。错得还"自洽"，只有拿表来对才发现。
  if (reqOpBits !== null) env.REQ_OP_BITS = reqOpBits;
  const reqFlagBits = evalConstExpr(defineText(blkTypesText, 'REQ_FLAG_BITS') ?? 'null', env);
  if (reqFlagBits !== null) env.REQ_FLAG_BITS = reqFlagBits;
  const reqOpMask = evalConstExpr(defineText(blkTypesText, 'REQ_OP_MASK') ?? 'null', env);
  const opEnum = parseEnum(blkTypesText, 'req_op', env);
  const flagEnum = parseEnum(blkTypesText, 'req_flag_bits', env, '__REQ_NR_BITS');
  const bioEnum = parseEnum(blkTypesText, null, env, 'BIO_FLAG_LAST');
  const rqfEnum = parseEnum(blkMqText, null, env, '__RQF_BITS');
  const mqEnum = parseEnum(blkMqText, 'mq_rq_state', env);
  const blkStsDefines = parseNumericDefines(blkTypesText, 'BLK_STS_\\w+', env);
  const virtioTypeDefines = parseNumericDefines(virtioBlkHeaderText, 'VIRTIO_BLK_T_\\w+', env);
  const virtioStatusDefines = parseNumericDefines(virtioBlkHeaderText, 'VIRTIO_BLK_S_\\w+', env);
  const vringFlagDefines = parseNumericDefines(virtioRingHeaderText, 'VRING_DESC_F_\\w+', env);

  const opCompare = compareNameValueTables(
    requestOpNames(layout),
    new Map(opEnum.members.map((entry) => [entry.name, entry.value])),
  );
  // `__REQ_*` 的位号：内核里是枚举的"第几项"，从 `REQ_OP_BITS` 起算。表里的 `raw` 是原名。
  const flagSource = new Map(flagEnum.members.map((entry) => [entry.name, entry.value]));
  const flagMismatches = [];
  let flagCompared = 0;
  for (const entry of requestFlagBits(layout)) {
    if (!flagSource.has(entry.raw)) continue;
    flagCompared += 1;
    if (BigInt(entry.bit) !== BigInt(flagSource.get(entry.raw))) {
      flagMismatches.push(`${entry.raw}: 表=${entry.bit} 源码=${flagSource.get(entry.raw)}`);
    }
  }
  const bioMismatches = [];
  let bioCompared = 0;
  for (const entry of BIO_FLAG_BITS) {
    const found = bioEnum.members.find((member) => member.name === entry.name);
    if (found === undefined) continue;
    bioCompared += 1;
    if (BigInt(entry.bit) !== found.value) bioMismatches.push(`${entry.name}: 表=${entry.bit} 源码=${found.value}`);
  }
  const rqfMismatches = [];
  let rqfCompared = 0;
  for (const entry of RQ_FLAG_BITS) {
    const raw = `__${entry.name}`;
    const found = rqfEnum.members.find((member) => member.name === raw);
    if (found === undefined) continue;
    rqfCompared += 1;
    if (BigInt(entry.bit) !== found.value) rqfMismatches.push(`${raw}: 表=${entry.bit} 源码=${found.value}`);
  }
  const mqCompare = compareNameValueTables(
    mqRqStates(layout),
    new Map(mqEnum.members.map((entry) => [entry.name, entry.value])),
  );
  const statusCompare = compareNameValueTables(BLK_STATUS_NAMES, blkStsDefines.values);
  const virtioTypeCompare = compareNameValueTables(VIRTIO_BLK_T_NAMES, virtioTypeDefines.values);
  const virtioStatusCompare = compareNameValueTables(VIRTIO_BLK_S_NAMES, virtioStatusDefines.values);
  const vringFlagCompare = compareNameValueTables(VRING_DESC_F_NAMES, vringFlagDefines.values);

  // `BIO_FLAG_LAST` 与 `__REQ_NR_BITS` 是哨兵：它们等于"真实位的个数"，用来抓"表少抄了一位"。
  const sentinelBio = bioEnum.members.length;
  const sentinelRqf = rqfEnum.members.length;

  // 常量表光"数值对得上"不够，还要真的能判读：把 `1 << 19` 交给解析器，它必须说出
  // "REQ_RAHEAD"。这一条把表与行为绑在一起（表对了但 mask 算错，这里就会失败）。
  const raheadBit = flagSource.get('__REQ_RAHEAD');
  const raheadDecode = raheadBit === undefined ? null : decodeBioOpf(layout, Number(1n << raheadBit));
  const readDecode = decodeBioOpf(layout, 0);
  const writeDecode = decodeBioOpf(layout, 1);

  const a1Problem = [
    opCompare.mismatches.length === 0 && opCompare.oursOnly.length === 0 && opCompare.theirsOnly.length === 0
      ? null : `req_op：${[...opCompare.mismatches, ...opCompare.oursOnly.map((n) => `${n}(我们独有)`), ...opCompare.theirsOnly.map((n) => `${n}(源码独有)`)]}`,
    flagMismatches.length === 0 ? null : `req_flag_bits：${flagMismatches.join(' | ')}`,
    bioMismatches.length === 0 ? null : `BIO_*：${bioMismatches.join(' | ')}`,
    rqfMismatches.length === 0 ? null : `__RQF_*：${rqfMismatches.join(' | ')}`,
    mqCompare.mismatches.length === 0 ? null : `mq_rq_state：${mqCompare.mismatches.join(' | ')}`,
    statusCompare.mismatches.length === 0 ? null : `BLK_STS_*：${statusCompare.mismatches.join(' | ')}`,
    virtioTypeCompare.mismatches.length === 0 ? null : `VIRTIO_BLK_T_*：${virtioTypeCompare.mismatches.join(' | ')}`,
    virtioStatusCompare.mismatches.length === 0 ? null : `VIRTIO_BLK_S_*：${virtioStatusCompare.mismatches.join(' | ')}`,
    vringFlagCompare.mismatches.length === 0 ? null : `VRING_DESC_F_*：${vringFlagCompare.mismatches.join(' | ')}`,
  ].filter((line) => line !== null);

  evidence.constants = {
    source: {
      reqOpBits: reqOpBits === null ? null : Number(reqOpBits),
      reqFlagBits: reqFlagBits === null ? null : Number(reqFlagBits),
      reqOpMask: reqOpMask === null ? null : Number(reqOpMask),
      opEnumMembers: opEnum.members.length,
      opEnumUnresolved: opEnum.unresolved,
      flagEnumMembers: flagEnum.members.length,
      flagEnumUnresolved: flagEnum.unresolved,
      raheadBit: raheadBit === undefined ? null : Number(raheadBit),
      bioFlags: bioEnum.members.length,
      rqfFlags: rqfEnum.members.length,
      mqStates: mqEnum.members.map((entry) => `${entry.name}=${entry.value}`),
      blkStsUnresolved: blkStsDefines.unresolved,
      virtioTypeUnresolved: virtioTypeDefines.unresolved,
      virtioStatusUnresolved: virtioStatusDefines.unresolved,
      vringFlagUnresolved: vringFlagDefines.unresolved,
    },
    ours: {
      reqOpBits: REQ_OP_BITS,
      reqFlagBits: REQ_FLAG_BITS,
      raheadBit: raheadBit === undefined ? null : Number(raheadBit),
      bioFlags: BIO_FLAG_BITS.length,
      rqfFlags: RQ_FLAG_BITS.length,
      virtioStatusNames: VIRTIO_BLK_S_NAMES.length,
    },
    compare: {
      op: { compared: opCompare.compared, mismatches: opCompare.mismatches, oursOnly: opCompare.oursOnly, theirsOnly: opCompare.theirsOnly },
      flags: { compared: flagCompared, mismatches: flagMismatches, sourceMembers: flagEnum.members.length },
      bio: { compared: bioCompared, mismatches: bioMismatches },
      rqf: { compared: rqfCompared, mismatches: rqfMismatches },
      mq: { compared: mqCompare.compared, mismatches: mqCompare.mismatches },
      blkStatus: { compared: statusCompare.compared, mismatches: statusCompare.mismatches, theirsOnly: statusCompare.theirsOnly },
      virtioType: { compared: virtioTypeCompare.compared, mismatches: virtioTypeCompare.mismatches, theirsOnly: virtioTypeCompare.theirsOnly },
      virtioStatus: { compared: virtioStatusCompare.compared, mismatches: virtioStatusCompare.mismatches, theirsOnly: virtioStatusCompare.theirsOnly },
      vringFlags: { compared: vringFlagCompare.compared, mismatches: vringFlagCompare.mismatches },
    },
    decodeProbe: {
      raheadNames: raheadDecode === null ? null : raheadDecode.flags.names,
      read: readDecode.op.symbol,
      write: writeDecode.op.symbol,
      readWritesToDevice: readDecode.op.writesToDevice,
      writeWritesToDevice: writeDecode.op.writesToDevice,
    },
    sentinels: { bioFlagLast: sentinelBio, rqfBits: sentinelRqf },
  };
  check(
    'T07f-A1 常量表与内核源码现场重解析双向一致：REQ_OP_BITS/REQ_FLAG_BITS 来自 blk_types.h 的 #define；'
      + 'req_op/req_flag_bits/BIO_/__RQF_/mq_rq_state 逐项取值相同（`__REQ_RAHEAD` 是第 19 位，不是第 11 位）；'
      + 'BLK_STS_/VIRTIO_BLK_T_/VIRTIO_BLK_S_/VRING_DESC_F_ 这些宏逐条抄对；`1 << 19` 交给解析器必须说出 REQ_RAHEAD',
    a1Problem.length === 0
      && reqOpBits !== null && Number(reqOpBits) === REQ_OP_BITS
      && reqFlagBits !== null && Number(reqFlagBits) === REQ_FLAG_BITS
      && opCompare.compared === opEnum.members.length
      && flagCompared === flagEnum.members.length
      && bioCompared === BIO_FLAG_BITS.length
      && rqfCompared === RQ_FLAG_BITS.length
      && sentinelBio === BIO_FLAG_BITS.length
      && mqCompare.compared === mqEnum.members.length
      && statusCompare.compared === BLK_STATUS_NAMES.length
      && virtioTypeCompare.compared === VIRTIO_BLK_T_NAMES.length
      && virtioStatusCompare.compared === VIRTIO_BLK_S_NAMES.length
      && vringFlagCompare.compared === VRING_DESC_F_NAMES.length
      && raheadDecode !== null && raheadDecode.flags.names.includes('REQ_RAHEAD')
      && readDecode.op.symbol === 'REQ_OP_READ' && writeDecode.op.symbol === 'REQ_OP_WRITE'
      && readDecode.op.writesToDevice === false && writeDecode.op.writesToDevice === true,
    a1Problem.length === 0
      ? `req_op ${opCompare.compared}/${opEnum.members.length} 项、req_flag_bits ${flagCompared}/${flagEnum.members.length} 项、`
        + `BIO_ ${bioCompared} 项（哨兵 BIO_FLAG_LAST=${sentinelBio}）、__RQF_ ${rqfCompared} 项（哨兵 __RQF_BITS=${sentinelRqf}）、`
        + `mq_rq_state ${mqCompare.compared} 项、BLK_STS_ ${statusCompare.compared} 项、VIRTIO_BLK_T_ ${virtioTypeCompare.compared} 项、`
        + `VIRTIO_BLK_S_ ${virtioStatusCompare.compared} 项（源码多出的：${virtioStatusCompare.theirsOnly.join('、') || '无'}）、`
        + `VRING_DESC_F_ ${vringFlagCompare.compared} 项；__REQ_RAHEAD=${raheadBit === undefined ? '读不到' : raheadBit}`
      : a1Problem.join('；'),
  );

  /* ---------------- A2：GDB 自己的 DWARF ↔ 布局产物 ---------------- */

  const probe = await runDwarfProbe(live, 'boot');
  if (!probe.ok) log(`A2 的 DWARF 探针失败：${probe.error}`);
  const probeData = probe.ok ? probe.data : {};
  const gdbSizes = probeData.sizes ?? {};
  const gdbOffsets = probeData.offsets ?? {};

  const sizePairs = Object.keys(DWARF_PROBE_TYPES);
  const sizeMismatches = [];
  const sizeUnresolved = [];
  let sizesCompared = 0;
  for (const name of sizePairs) {
    const ours = layout.has(name) ? layout.type(name).byteSize : null;
    const theirs = gdbSizes[name];
    if (ours === null || theirs === undefined) { sizeUnresolved.push(`${name}（我们=${ours === null ? '缺' : ours} GDB=${theirs ?? '缺'}）`); continue; }
    sizesCompared += 1;
    if (Number(theirs) !== Number(ours)) sizeMismatches.push(`${name}: 我们=${ours} GDB=${theirs}`);
  }

  const offsetMismatches = [];
  const offsetUnresolved = [];
  let offsetsCompared = 0;
  let offsetPairs = 0;
  for (const [name, fields] of Object.entries(DWARF_PROBE_TYPES)) {
    for (const field of fields) {
      offsetPairs += 1;
      let ours = null;
      try {
        ours = layout.byteOffset(name, field);
      } catch {
        ours = null;
      }
      const theirs = gdbOffsets[name] === undefined ? undefined : gdbOffsets[name][field];
      if (ours === null || theirs === undefined) {
        offsetUnresolved.push(`${name}.${field}（我们=${ours === null ? '缺' : ours} GDB=${theirs ?? '缺'}）`);
        continue;
      }
      offsetsCompared += 1;
      if (Number(theirs) !== Number(ours)) offsetMismatches.push(`${name}.${field}: 我们=${ours} GDB=${theirs}`);
    }
  }

  // 枚举取值：GDB 直接对枚举项求值，与我方产物里的枚举逐项比。
  const enumPairs = [
    ['req_op', opEnum.members.map((entry) => entry.name)],
    ['req_flag_bits', flagEnum.members.map((entry) => entry.name)],
    ['mq_rq_state', mqEnum.members.map((entry) => entry.name)],
  ];
  const enumMismatches = [];
  const enumUnresolved = [];
  let enumsCompared = 0;
  for (const [typeName, memberNames] of enumPairs) {
    for (const memberName of memberNames) {
      const theirs = probeData.values?.[memberName];
      let ours = null;
      try {
        ours = layout.enumValue(typeName, memberName);
      } catch {
        ours = null;
      }
      if (ours === null || theirs === undefined) {
        enumUnresolved.push(`${typeName}.${memberName}（我们=${ours ?? '缺'} GDB=${theirs ?? '缺'}）`);
        continue;
      }
      enumsCompared += 1;
      if (Number(theirs) !== Number(ours)) enumMismatches.push(`${typeName}.${memberName}: 我们=${ours} GDB=${theirs}`);
    }
  }
  // 宏在 DWARF 里通常取不到：那一类要报成"GDB 给不出第二来源"，与"值不一致"分开。
  const macroNames = ['REQ_OP_BITS', 'REQ_FLAG_BITS', 'REQ_OP_LAST', 'REQ_OP_MASK'];
  const macroUnresolved = macroNames.filter((name) => probeData.values?.[name] === undefined);

  evidence.dwarf = {
    ok: probe.ok,
    error: probe.ok ? null : probe.error,
    notes: probeData.notes ?? [],
    sizes: { compared: sizesCompared, total: sizePairs.length, mismatches: sizeMismatches, unresolved: sizeUnresolved },
    offsets: { compared: offsetsCompared, total: offsetPairs, mismatches: offsetMismatches, unresolved: offsetUnresolved },
    enums: { compared: enumsCompared, mismatches: enumMismatches, unresolved: enumUnresolved },
    macros: { unresolved: macroUnresolved, values: Object.fromEntries(macroNames.map((name) => [name, probeData.values?.[name] ?? null])) },
    unresolvedFromGdb: probeData.unresolved ?? null,
  };
  check(
    'T07f-A2 GDB 自己的 DWARF（sizeof / &((T*)0)->f / 枚举项取值）与布局产物逐项一致：'
      + `${sizePairs.length} 个结构的宽度、${offsetPairs} 个字段的偏移、三类枚举的每一项取值都对得上`,
    probe.ok
      && sizeMismatches.length === 0 && sizeUnresolved.length === 0 && sizesCompared === sizePairs.length
      && offsetMismatches.length === 0 && offsetUnresolved.length === 0 && offsetsCompared === offsetPairs
      && enumMismatches.length === 0 && enumUnresolved.length === 0 && enumsCompared > 0,
    probe.ok
      ? `宽度 ${sizesCompared}/${sizePairs.length} 项一致（request=${layout.type('request').byteSize} bio=${layout.type('bio').byteSize} `
        + `virtblk_req=${layout.type('virtblk_req').byteSize} vring_virtqueue=${layout.type('vring_virtqueue').byteSize}）；`
        + `偏移 ${offsetsCompared}/${offsetPairs} 项一致；枚举 ${enumsCompared} 项一致；`
        + `GDB 给不出的宏：${macroUnresolved.join('、') || '无'}`
        + `（宏不在 DWARF 里，这一条由 A1 的源码重解析负责）`
      : `${probe.error}；未解出的字段：${[...sizeUnresolved, ...offsetUnresolved].slice(0, 6).join(' | ')}`,
  );

  /* ---------------- A3：源码里的结构性事实 ---------------- */

  const toPduBody = readFunctionBody(blkMqText, 'static inline void *blk_mq_rq_to_pdu(');
  const fromPduBody = readFunctionBody(blkMqText, 'static inline struct request *blk_mq_rq_from_pdu(');
  const addReqBody = readFunctionBody(virtioBlkText, 'static int virtblk_add_req(');
  const getVqBody = readFunctionBody(virtioBlkText, 'static inline struct virtio_blk_vq *get_virtio_blk_vq(');
  const prepRqBody = readFunctionBody(virtioBlkText, 'static blk_status_t virtblk_prep_rq(');
  const queueRqBody = readFunctionBody(virtioBlkText, 'static blk_status_t virtio_queue_rq(');
  const addSplitBody = readFunctionBody(virtioRingText, 'static inline int virtqueue_add_split(');
  const detachBody = readFunctionBody(virtioRingText, 'static void detach_buf_split(');
  const getBufBody = readFunctionBody(virtioRingText, 'static void *virtqueue_get_buf_ctx_split(');
  const mpageBody = readFunctionBody(mpageText, 'static struct bio *do_mpage_readpage(');

  const structural = {
    toPdu: {
      body: toPduBody,
      returnsRqPlusOne: /return\s+rq\s*\+\s*1\s*;/.test(toPduBody ?? ''),
      // `sizeof(struct request)` 是我方算 PDU 的写法；内核实指同一个地址。
      equivalentToSizeof: structRequestSizeOf(layout) > 0,
    },
    fromPdu: {
      subtractsSizeof: /return\s+pdu\s*-\s*sizeof\(struct request\)\s*;/.test(fromPduBody ?? ''),
    },
    addReq: {
      tokenIsVbr: /virtqueue_add_sgs\(\s*vq\s*,\s*sgs\s*,\s*num_out\s*,\s*num_in\s*,\s*vbr\s*,/.test(addReqBody ?? ''),
      outHeader: /sg_init_one\(\s*&out_hdr\s*,\s*&vbr->out_hdr\s*,\s*sizeof\(vbr->out_hdr\)\s*\)/.test(addReqBody ?? ''),
      inHeader: /sg_init_one\(\s*&in_hdr\s*,\s*&vbr->in_hdr\.status\s*,\s*vbr->in_hdr_len\s*\)/.test(addReqBody ?? ''),
      dataSegmentGuardedByNents: /if\s*\(\s*vbr->sg_table\.nents\s*\)/.test(addReqBody ?? ''),
    },
    getVq: {
      fromQueuedata: /hctx->queue->queuedata/.test(getVqBody ?? ''),
      byQueueNum: /vblk->vqs\[hctx->queue_num\]/.test(getVqBody ?? ''),
    },
    prepRq: {
      startsRequest: /blk_mq_start_request\(\s*req\s*\)/.test(prepRqBody ?? ''),
      doesNotAddReq: !/virtblk_add_req\(/.test(prepRqBody ?? ''),
      order: orderInBody(queueRqBody, 'virtblk_prep_rq(', 'virtblk_add_req('),
    },
    addSplit: {
      storesToken: /vq->split\.desc_state\[head\]\.data\s*=\s*data\s*;/.test(addSplitBody ?? ''),
      // 先记 token、再往 avail 环里公开这个 head（换成 `avail->ring[avail]` 这条最贴近的公开语句做顺序判据）。
      tokenBeforeRingSlot: orderInBody(addSplitBody, 'split.desc_state[head].data = data', 'split.vring.avail->ring[avail]'),
      // 同理，token 也必须先于 avail->idx 的推进（idx 一涨，设备那边就算这块可用）。
      tokenBeforeAvailIdx: orderInBody(addSplitBody, 'split.desc_state[head].data = data', 'split.vring.avail->idx ='),
    },
    detach: {
      clearsToken: /vq->split\.desc_state\[head\]\.data\s*=\s*NULL\s*;/.test(detachBody ?? ''),
      // 顺序不变量：清 token 必须在"开始回收描述符"之前——不然会出现"描述符已经还给别人、token 还指着旧请求"的窗口。
      tokenClearedBeforeRecycle: orderInBody(detachBody, 'desc_state[head].data = NULL;', 'vring_unmap_one_split(vq, i)'),
      // 而且必须在"把这个 head 挂回 free_head"之前清（挂回去就意味着别人可以立刻拿它用）。
      freesHeadAfterClearing: orderInBody(detachBody, 'desc_state[head].data = NULL;', 'vq->free_head = head;'),
      doesNotAdvanceLastUsedIdx: !/last_used_idx\+\+/.test(detachBody ?? ''),
    },
    getBuf: {
      readsDataBeforeDetach: orderInBody(getBufBody, 'desc_state[i].data;', 'detach_buf_split(vq, i, ctx);'),
      detachThenAdvance: orderInBody(getBufBody, 'detach_buf_split(vq, i, ctx);', 'vq->last_used_idx++;'),
      usesLastUsedIdxAsSlot: /last_used\s*=\s*\(vq->last_used_idx\s*&\s*\(vq->split\.vring\.num\s*-\s*1\)\)/.test(getBufBody ?? ''),
      checksHeadNotNull: /if\s*\(unlikely\(!vq->split\.desc_state\[i\]\.data\)\)/.test(getBufBody ?? ''),
    },
    mpage: {
      isReadaheadGuarded: /if\s*\(\s*args->is_readahead\s*\)/.test(mpageBody ?? ''),
      setsReadahead: /opf\s*\|=\s*REQ_RAHEAD\s*;/.test(mpageBody ?? ''),
      order: orderInBody(mpageBody, 'args->is_readahead', 'opf |= REQ_RAHEAD'),
    },
  };
  const a3Problems = [];
  if (!structural.toPdu.returnsRqPlusOne) a3Problems.push('blk_mq_rq_to_pdu 不是 `rq + 1`');
  if (!structural.fromPdu.subtractsSizeof) a3Problems.push('blk_mq_rq_from_pdu 不是减 sizeof(struct request)');
  if (!structural.addReq.tokenIsVbr) a3Problems.push('virtblk_add_req 的 token 不是 vbr');
  if (!structural.addReq.outHeader || !structural.addReq.inHeader) a3Problems.push('virtblk_add_req 的头/状态段与源码不符');
  if (!structural.addReq.dataSegmentGuardedByNents) a3Problems.push('virtblk_add_req 的数据段没有按 nents 判');
  if (!structural.getVq.fromQueuedata || !structural.getVq.byQueueNum) a3Problems.push('get_virtio_blk_vq 的两步与源码不符');
  if (!structural.prepRq.startsRequest) a3Problems.push('virtblk_prep_rq 里没有 blk_mq_start_request');
  if (!structural.prepRq.doesNotAddReq) a3Problems.push('virtblk_prep_rq 里也调了 virtblk_add_req（那"在飞但没进环"就不存在）');
  if (structural.prepRq.order !== 'first-before-second') a3Problems.push('virtio_queue_rq 里 virtblk_prep_rq 不在 virtblk_add_req 之前');
  if (!structural.addSplit.storesToken) a3Problems.push('virtqueue_add_split 没有把 token 写进 desc_state[head].data');
  if (structural.addSplit.tokenBeforeRingSlot !== 'first-before-second') a3Problems.push('virtqueue_add_split 先把 head 公开进 avail 环、才写 token（顺序反了，设备可能先看到空 token）');
  if (structural.addSplit.tokenBeforeAvailIdx !== 'first-before-second') a3Problems.push('virtqueue_add_split 先推 avail->idx、才写 token');
  if (!structural.detach.clearsToken) a3Problems.push('detach_buf_split 没有清 desc_state[head].data');
  if (structural.detach.tokenClearedBeforeRecycle !== 'first-before-second') a3Problems.push('detach_buf_split 在回收描述符之后才清 token');
  if (structural.detach.freesHeadAfterClearing !== 'first-before-second') a3Problems.push('detach_buf_split 先把 head 挂回 free_head 才清 token（别人可能已经拿到这个槽位了）');
  if (!structural.detach.doesNotAdvanceLastUsedIdx) a3Problems.push('detach_buf_split 里也有 last_used_idx++（那"设备完成但驱动未回收"这个窗口就不成立）');
  if (structural.getBuf.readsDataBeforeDetach !== 'first-before-second') a3Problems.push('get_buf 不是"先取 token 再 detach"');
  if (structural.getBuf.detachThenAdvance !== 'first-before-second') a3Problems.push('get_buf 里 last_used_idx++ 不在 detach 之后');
  if (!structural.getBuf.usesLastUsedIdxAsSlot) a3Problems.push('get_buf 读 used 环的下标不是 last_used_idx');
  if (!structural.getBuf.checksHeadNotNull) a3Problems.push('get_buf 没有检查 desc_state[i].data 非空');
  if (!structural.mpage.isReadaheadGuarded || !structural.mpage.setsReadahead) a3Problems.push('mpage 的 REQ_RAHEAD 置位与源码不符');
  if (structural.mpage.order !== 'first-before-second') a3Problems.push('mpage 里 REQ_RAHEAD 不在 is_readahead 分支内');

  evidence.structural = {
    problems: a3Problems,
    toPdu: { returnsRqPlusOne: structural.toPdu.returnsRqPlusOne, requestSize: structRequestSizeOf(layout), body: structural.toPdu.body },
    fromPdu: structural.fromPdu,
    addReq: { ...structural.addReq, segmentsFormula: '1 + sg_table.nents + 1' },
    getVq: structural.getVq,
    prepRq: structural.prepRq,
    addSplit: structural.addSplit,
    detach: structural.detach,
    getBuf: structural.getBuf,
    mpage: structural.mpage,
  };
  check(
    'T07f-A3 源码里的结构性事实逐条成立：`blk_mq_rq_to_pdu` 就是 `return rq + 1;`；`virtblk_add_req` 把 `vbr` 当 token、'
      + '摊成 1 + nents + 1 段；`get_virtio_blk_vq` 走 `hctx->queue->queuedata` + `vqs[hctx->queue_num]`；'
      + '`virtblk_prep_rq` 在 `virtblk_add_req` 之前调 `blk_mq_start_request`；`virtqueue_add_split` 先写 token 再公开到 avail 环/推 idx；'
      + '`detach_buf_split` 清 token 在回收描述符与挂回 free_head 之前、且自己不推 `last_used_idx`；`get_buf` 先取 token 再 detach 再推计数器；'
      + '`mpage.c` 只在 `is_readahead` 分支里立 REQ_RAHEAD',
    a3Problems.length === 0,
    a3Problems.length === 0
      ? `sizeof(request)=${structRequestSizeOf(layout)}；PDU = rq + ${structRequestSizeOf(layout)}（等价于源码的 rq + sizeof(struct request)）`
      : a3Problems.join('；'),
  );

  /* ---------------- A4：导出面与契约 ---------------- */

  const indexText = fs.readFileSync(IO_INDEX_TS, 'utf8');
  const exportedNames = parseExportNames(indexText);
  const missingExports = exportedNames.filter((name) => api[name] === undefined);

  const associateText = fs.readFileSync(path.join(path.dirname(IO_INDEX_TS), 'associate.ts'), 'utf8');
  const lifecycleMatch = /export type RequestLifecycle =([\s\S]*?);/.exec(associateText);
  const lifecycleStates = lifecycleMatch === null
    ? []
    : [...lifecycleMatch[1].matchAll(/'([a-z-]+)'/g)].map((entry) => entry[1]);
  const expectedLifecycle = ['not-submitted', 'in-flight-on-device', 'completed-on-device', 'recycled', 'unknown'];
  const lifecycleMissing = expectedLifecycle.filter((state) => !lifecycleStates.includes(state));

  evidence.exports = {
    indexFile: path.relative(ROOT, IO_INDEX_TS),
    count: exportedNames.length,
    names: exportedNames,
    missing: missingExports,
    lifecycleStates,
    lifecycleMissing,
  };
  check(
    'T07f-A4 导出面与契约：`io/index.ts` 里写的每个导出名都能从包入口取到（不是"写了但没导"）；'
      + '`RequestLifecycle` 的五个状态一个不缺（判生命周期不允许只给"对不对"两态）',
    exportedNames.length > 60 && missingExports.length === 0 && lifecycleMissing.length === 0,
    `${exportedNames.length} 个导出名，缺 ${missingExports.length}${missingExports.length === 0 ? '' : `（${missingExports.join('、')}）`}；`
      + `RequestLifecycle = ${lifecycleStates.join('/')}`,
  );

  return evidence;
}

// ==== PART4 ====
/* ==========================================================================
 * B 段用的比较工具
 *
 * B 段的每个结论都是"两份互不相干的读法给出的同一件事"。所以比较本身要写清两件事，
 * 否则整段会**悄悄空转**：一条断言都做不成，却显示通过。
 *
 * 1. `null` 与 `undefined` 含义不同：`null` 是"读到了，值是空"（`file.private_data`
 *    在 ext2 普通文件上是 0，不是"读不到"），`undefined` 才是"这条路径两边都没有" ——
 *    那说明字段名写错了，必须单独报出来，不能算成"两侧都没有所以一致"。
 * 2. 数字有三套写法（`0x…` 字符串、十进制字符串、BigInt），比的是值不是写法；
 *    字符串（状态名、枚举名）则按字面比。
 * ========================================================================== */

/** 把任意一侧的值规整成"可比较"的形态；真正读不到的一律折成 `null`。 */
function toComparable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

/** 两份读法给出的同一个标量是否相同（认 `0x…`/十进制/布尔三套写法）。 */
function sameScalar(left, right) {
  const mine = toComparable(left);
  const theirs = toComparable(right);
  if (mine === null || theirs === null) return mine === theirs;
  if (typeof mine === 'boolean' || typeof theirs === 'boolean') return Boolean(mine) === Boolean(theirs);
  try {
    return BigInt(mine) === BigInt(theirs);
  } catch {
    return String(mine) === String(theirs);
  }
}

/** 比较失败时的可读写法：地址给十六进制，别甩一长串十进制。 */
function formatValue(value) {
  if (value === undefined) return '（路径不存在）';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}（${hex(value)}）`;
  if (Array.isArray(value)) return `[${value.map(formatValue).join(',')}]`;
  return String(value);
}

/** 按 `a.b.c` 取嵌套字段；中间缺一环就返回 `undefined`（不抛）。数组下标也是键。 */
function getPath(root, path) {
  let cursor = root;
  for (const key of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * 逐路径比两份读法，三种结果分开报。
 *
 * - `compared`：两边都读到、而且一致（这才是"对上"的项数）；
 * - `mismatches`：两边都读到、但值不同（真问题）；
 * - `absent`：**两侧都是 `undefined`** —— 这只能是路径写错了，不是"这次读不到"。
 */
function comparePaths(ours, theirs, paths) {
  const compared = [];
  const mismatches = [];
  const absent = [];
  for (const entry of paths) {
    const path = typeof entry === 'string' ? entry : entry.path;
    // 对象项允许分别指定两边的字段名（`{path, ours, theirs}`）；只写 `path` 时两边都用它
    // —— `ptr()` 生成的指针项就是这样，缺了这个回落 `getPath` 会拿到 undefined 而崩掉。
    const mine = getPath(ours, typeof entry === 'string' ? path : (entry.ours ?? entry.path));
    const other = getPath(theirs, typeof entry === 'string' ? path : (entry.theirs ?? entry.path));
    if (mine === undefined && other === undefined) { absent.push(path); continue; }
    // 指针字段额外允许"空指针的两种写法"：我方把 0 记成 `null`（"这个指针是空的"比
    // "它的值是 0"更有信息量），参照脚本给的是它读出来的数值 0。这是同一个事实，
    // 不该报成不一致；非空时仍然必须逐位相同。
    const pointer = typeof entry === 'object' && entry.pointer === true;
    if (!sameScalar(mine, other) && !(pointer && isEmptyPointer(mine) && isEmptyPointer(other))) {
      mismatches.push(`${path}（我方 ${formatValue(mine)} / 参照 ${formatValue(other)}）`);
      continue;
    }
    compared.push(path);
  }
  return { compared, mismatches, absent };
}

/** 空指针的常见写法：`null`、`0`、`0x0`。`undefined` 不算 —— 那是"这条路径不存在"。 */
function isEmptyPointer(value) {
  if (value === null) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'bigint') return value === 0n;
  if (typeof value === 'string') return /^(0|0x0+)$/i.test(value.trim());
  return false;
}

/** 把一次比较的结论说成人话（直接当 `check` 的 detail 用）。 */
function compareText(label, comparison) {
  const parts = [`${label}：一致 ${comparison.compared.length} 项`];
  if (comparison.absent.length > 0) parts.push(`两侧都没有的路径 ${comparison.absent.join('、')}`);
  if (comparison.mismatches.length > 0) parts.push(`不一致 ${comparison.mismatches.join('；')}`);
  return parts.join('；');
}

/** 名字集合比较：顺序无关、重复无关（标志名、页标志名用）。 */
function sameNameSet(left, right) {
  const mine = [...new Set((left ?? []).map(String))].sort();
  const theirs = [...new Set((right ?? []).map(String))].sort();
  return mine.length === theirs.length && mine.every((name, index) => name === theirs[index]);
}

/** 从一段字节里读一个无符号小整数（2 字节；地址运算走 BigInt，不许退化成 number）。 */
async function u16Of(view, address) {
  const raw = await view.bytes(address, 2);
  return raw[0] | (raw[1] << 8);
}

async function u32Of(view, address) {
  const raw = await view.bytes(address, 4);
  return (raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0;
}

/** 从一段字节里读一个小端指针（8 字节）。 */
async function u64Of(view, address) {
  const raw = await view.bytes(address, 8);
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(raw[index]);
  return value;
}

/**
 * 把 C 源码里的一个字符串字面量解成字节（只覆盖这份 `lab.c` 里出现过的转义）。
 *
 * `write(fd, text, sizeof(text) - 1)` 写下去的**不是** `strlen(text)`，而是"字面量占的
 * 字节数减掉结尾那个 0"。所以"这次该写几个字节"必须从**这份源码**现算；抄一个 33 进来
 * 等于把判据从源码搬进了脚本，将来改了字符串，验收会继续通过，而它本该失败。
 */
function cStringBytes(literal) {
  const inner = literal.slice(1, -1);
  const out = [];
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== '\\') { out.push(char.charCodeAt(0)); continue; }
    const next = inner[index + 1];
    index += 1;
    if (next === 'n') out.push(10);
    else if (next === 't') out.push(9);
    else if (next === 'r') out.push(13);
    else if (next === '0') out.push(0);
    else if (next === '\\') out.push(92);
    else if (next === '"') out.push(34);
    else if (next === "'") out.push(39);
    else if (next === 'x') {
      let digits = '';
      while (index + 1 < inner.length && /[0-9a-fA-F]/.test(inner[index + 1])) { digits += inner[index + 1]; index += 1; }
      out.push(digits.length === 0 ? 120 : Number.parseInt(digits, 16));
    } else out.push(next === undefined ? 92 : next.charCodeAt(0));
  }
  return out;
}

/** 从 `lab.c` 里现算 `write_file()` 这次写下去的字节数（`sizeof(text) - 1`）。 */
function expectedWriteBytes(text) {
  const match = /const\s+char\s+text\[\]\s*=\s*("(?:[^"\\]|\\.)*")\s*;/.exec(text);
  if (match === null) return null;
  const bytes = cStringBytes(match[1]);
  // `char text[] = "…";` 的数组长度 = 字面量字节数 + 1（编译期补的那个结尾 0），
  // 所以 `sizeof(text) - 1` 正好是字面量的字节数 —— `write()` 写下去的就是这么多。
  return { literal: match[1], sizeOfText: bytes.length + 1, written: bytes.length };
}

/**
 * 一个请求上挂的 bio 都落在哪些页上（每个向量一项，带页自己的 `mapping`/`index`）。
 *
 * 为什么在**认领停点的谓词里**要手写一遍而不直接调 `traceRequest()`：谓词会对每个停点
 * 都跑一次，而 `traceRequest()` 一次要把队列、硬件上下文、驱动状态、virtqueue、
 * 描述符状态表全读一遍（几十次内存读）。这里只读"请求→bio→bi_io_vec→bv_page→page"
 * 四跳，够用来判"这个请求搬的是不是那一页"，剩下的等逮到了再用完整解析器读。
 */
async function bioPagesOfRequest(view, layout, requestAddress, options = {}) {
  const maxBios = options.maxBios ?? 8;
  const maxVectors = options.maxVectors ?? 16;
  const vectorStride = BigInt(layout.type('bio_vec').byteSize ?? 16);
  const fileOffsetDelta = BigInt(layout.byteOffset('request', 'bio'));
  const nextDelta = BigInt(layout.byteOffset('bio', 'bi_next'));
  const vcntDelta = BigInt(layout.byteOffset('bio', 'bi_vcnt'));
  const ioVecDelta = BigInt(layout.byteOffset('bio', 'bi_io_vec'));
  const pageDelta = BigInt(layout.byteOffset('bio_vec', 'bv_page'));
  const mappingDelta = BigInt(layout.byteOffset('page', 'mapping'));
  const indexDelta = BigInt(layout.byteOffset('page', 'index'));
  const pages = [];
  let bioAddress = await u64Of(view, requestAddress + fileOffsetDelta);
  for (let guard = 0; guard < maxBios && bioAddress !== 0n; guard += 1) {
    const vcnt = await u16Of(view, bioAddress + vcntDelta);
    const ioVec = await u64Of(view, bioAddress + ioVecDelta);
    if (ioVec !== 0n) {
      const count = Math.min(vcnt, maxVectors);
      for (let index = 0; index < count; index += 1) {
        const pageAddress = await u64Of(view, ioVec + BigInt(index) * vectorStride + pageDelta);
        const record = { bioAddress, vectorIndex: index, pageAddress, mapping: null, index: null };
        if (pageAddress !== 0n) {
          record.mapping = await u64Of(view, pageAddress + mappingDelta);
          record.index = await u64Of(view, pageAddress + indexDelta);
        }
        pages.push(record);
      }
    }
    bioAddress = await u64Of(view, bioAddress + nextDelta);
  }
  return pages;
}

/** 两条描述符列表（链或间接表）逐项比。 */
function compareDescriptors(ours, theirs, limit) {
  const mismatches = [];
  let compared = 0;
  const count = Math.min(ours.length, theirs.length, limit);
  for (let index = 0; index < count; index += 1) {
    const mine = ours[index];
    const other = theirs[index];
    for (const path of ['index', 'address', 'addr', 'len', 'flags', 'next', 'hasNext', 'isIndirect']) {
      const left = getPath(mine, path);
      const right = getPath(other, path);
      if (!sameScalar(left, right)) {
        mismatches.push(`[${index}].${path}（我方 ${formatValue(left)} / 参照 ${formatValue(right)}）`);
        continue;
      }
      compared += 1;
    }
    const mineNames = mine.flagsDecode?.names ?? [];
    const theirNames = other.flagNames ?? [];
    if (!sameNameSet(mineNames, theirNames)) {
      mismatches.push(`[${index}].flags 名字（我方 ${mineNames.join('|')} / 参照 ${theirNames.join('|')}）`);
    } else {
      compared += 1;
    }
    if (mine.flagsDecode?.unknown !== (other.unknownFlagBits ?? 0)) {
      mismatches.push(`[${index}].flags 里表没有的位（我方 ${mine.flagsDecode?.unknown} / 参照 ${other.unknownFlagBits}）`);
    } else {
      compared += 1;
    }
  }
  return { compared, mismatches, lengths: [ours.length, theirs.length] };
}

/** `cmd_flags` / `bi_opf` 的三件套：操作码、操作码符号、标志原始位。 */
function compareOpf(ours, theirs) {
  const compared = [];
  const mismatches = [];
  const pairs = [
    ['op', ours.op?.op, theirs.opRaw],
    ['op.symbol', ours.op?.symbol, theirs.opSymbol],
    ['flagBits', ours.flags?.raw, theirs.flagBits],
  ];
  for (const [name, mine, other] of pairs) {
    if (!sameScalar(mine, other)) mismatches.push(`${name}（我方 ${formatValue(mine)} / 参照 ${formatValue(other)}）`);
    else compared.push(name);
  }
  const mineNames = ours.flags?.names ?? [];
  const theirNames = theirs.flagNames ?? [];
  if (!sameNameSet(mineNames, theirNames)) {
    mismatches.push(`flags 名字（我方 ${mineNames.join('|')} / 参照 ${theirNames.join('|')}）`);
  } else {
    compared.push('flags.names');
  }
  return { compared, mismatches, absent: [] };
}

/** 一个指针字段：`null` 与 `0` 都表示"空指针"，按同一个事实比。 */
const ptr = (path) => ({ path, pointer: true });

const FILE_PATHS = ['fCount', 'fMode', 'fFlags', 'fIocbFlags', 'fPos', 'fOp', 'fWbErr',
  ptr('address'), ptr('fMapping'), ptr('privateData'), ptr('fInode'), ptr('fCred'),
  ptr('path.address'), ptr('path.mnt'), ptr('path.dentry')];
const ADDRESS_SPACE_PATHS = ['nrpages', 'writebackIndex', 'flags', 'gfpMask', 'mmapWritable',
  ptr('address'), ptr('host'), ptr('pagesAddress'), ptr('aOps'), ptr('privateData')];
const PAGE_PATHS = ['flags', 'compoundHeadRaw', 'isTail', 'mappingIsAnon', 'mappingIsMovable', 'index',
  'refcount', 'mapcount', 'pageType', 'pageTypeCode',
  ptr('address'), ptr('compoundHeadAddress'), ptr('mapping')];
const REQUEST_PATHS = ['cmdFlags', 'rqFlags', 'tag', 'internalTag',
  'timeout', 'dataLen', 'sector', 'startTimeNs', 'ioStartTimeNs',
  'nrPhysSegments', 'state', 'stateName', 'ref', 'sectorEnd',
  ptr('address'), ptr('queue'), ptr('mqCtx'), ptr('mqHctx'), ptr('bio'), ptr('bioTail'), ptr('part'),
  ptr('endIo'), ptr('pduAddress')];
const QUEUE_PATHS = ['queueFlags', 'rqTimeout', 'queueDepth', 'refs', 'nrHwQueues', 'nrRequests',
  'mqFreezeDepth',
  ptr('address'), ptr('queuedata'), ptr('elevator'), ptr('mqOps'), ptr('queueCtx'), ptr('hctxTableAddress'),
  ptr('lastMerge'), ptr('disk'), ptr('tagSet')];
const HWCTX_PATHS = ['nrCtx', 'queueNum', 'nrActive', 'type', 'flags', 'state',
  ptr('address'), ptr('queue'), ptr('driverData'), ptr('ctxsAddress'), ptr('tags'), ptr('schedTags')];
const VIRTIO_BLK_PATHS = ['index', 'numVqs', 'zoneSectors',
  ptr('address'), ptr('vdev'), ptr('disk'), ptr('vqsAddress'),
  ptr('ioQueues.0'), ptr('ioQueues.1'), ptr('ioQueues.2')];
const VQ_PATHS = ['index', 'numFree', 'numMax', 'packedRing', 'indirect',
  'event', 'broken', 'useDmaApi', 'premapped', 'doUnmap', 'freeHead', 'numAdded', 'lastUsedIdx', 'num',
  'availFlagsShadow', 'availIdxShadow', 'availIdx', 'availFlags', 'usedIdx', 'usedFlags', 'name',
  ptr('address'), ptr('vdev'), ptr('priv'), ptr('descAddress'), ptr('availAddress'), ptr('usedAddress'),
  ptr('descStateAddress'), ptr('descExtraAddress')];
const PDU_PATHS = ['outType', 'outTypeSymbol', 'outTypeBarrier', 'outHdrIoprio', 'outSector',
  'inHdrLen', 'status', 'statusName', 'sgNents', 'sgOrigNents',
  ptr('address'), ptr('inHdrAddress'), ptr('sgTableAddress')];
const BIO_PATHS = ['biFlags', 'status', 'statusName', 'ioprio', 'writeHint',
  'sector', 'bytesRemaining', 'idx', 'bvecDone', 'vcnt', 'maxVecs', 'totalBytes', 'doneBytes',
  'extentStart', 'extentEnd',
  ptr('address'), ptr('next'), ptr('bdev'), ptr('endIo'), ptr('private'), ptr('ioVecAddress')];
const TAGS_PATHS = ['nrTags', 'nrReservedTags', 'activeQueues',
  ptr('address'), ptr('rqsAddress'), ptr('staticRqsAddress')];

/* ==========================================================================
 * B 段：真跑一台 Linux，用"停点的寄存器 + 客体自报 + GDB 侧参照"读同一份事实
 * ========================================================================== */

async function liveSection(ctx) {
  const { app, registry, evidence, layout } = ctx;

  /* ---------------- B0：真启动一台 Linux ---------------- */

  log('B0：创建会话（加载 vmlinux 符号、TCG 上跑真内核，约 1–2 分钟）...');
  const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
  const sessionOk = created.status === 201 && typeof created.body?.id === 'string';
  check(
    'T07f-B0a 会话创建成功（后面四个真实停点的前提）',
    sessionOk,
    sessionOk ? `id=${created.body.id} profile=${created.body.profile}` : `${created.status} ${describe(created.body)}`,
  );
  if (!sessionOk) throw new Error(`会话创建失败：${describe(created.body)}`);
  ctx.session = created.body;
  ctx.live = registry.get(ctx.session.id);
  if (!ctx.live) throw new Error('会话已创建但注册表里取不到它的现场');
  ctx.base = `/api/sessions/${ctx.session.id}`;
  evidence.session = {
    id: ctx.session.id,
    profile: ctx.session.profile,
    epoch: ctx.live.epoch,
    qemu: ctx.live.process?.qemuPath ?? null,
    framesAtCreation: ctx.live.frames.length,
  };

  const cmd = async (type, extra = {}) => call(app, 'POST', `${ctx.base}/commands`, {
    requestId: `t07f-${++ctx.seq}-${type}`,
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
  const viewFor = (frame) => new KernelMemoryView(captureFor(frame));
  const typeAt = (frame, extra = {}) => call(app, 'POST', `${ctx.base}/commands`, {
    requestId: `t07f-${++ctx.seq}-terminal.input`,
    epoch: ctx.live.epoch,
    expectedFrameId: frame.frameId,
    type: 'terminal.input',
    ...extra,
  });
  const termText = async () => (await call(app, 'GET', `${ctx.base}/terminal`)).body?.text ?? '';

  /* ---------------- A 段：先把"判据本身"对完 ---------------- */

  // `kernelfast` 起来时核是停在复位向量上的；A2 的 DWARF 探针只问"这个结构多大、
  // 字段在第几字节"，不需要活着的栈帧，所以这一段可以在客体还没跑起来时做完 ——
  // 判据不对就别浪费二十分钟等它启动。
  await cmd('pause');
  log('A 段：布局产物 ↔ 现场 vmlinux、常量表 ↔ 内核源码、GDB 的 DWARF ↔ 布局产物、源码里的结构性事实 ...');
  evidence.static = await runStaticChecks({
    live: ctx.live,
    layout,
    symbols: ctx.symbols,
    sizes: ctx.sizes,
    api: ctx.api,
  });

  /* ---------------- B0b：把客体真的跑起来 ---------------- */

  const boot = await cmd('continue');
  if (boot.status !== 200) throw new Error(`continue（启动客体）被拒：${describe(boot.body)}`);
  log('等待客体启动到交互提示符（最多 300 秒；TCG 上真启动一台 Linux 比较慢）...');
  const bootText = await waitForTerminal(app, ctx.base, 300000);
  check(
    'T07f-B0b 客体真的启动到交互提示符：后面每条断言都发生在真实运行的内核里，'
      + '而不是我们对着镜像文件推出来的',
    PROMPT.test(bootText),
    `串口字节=${bootText.length}`,
  );

  log('B0c：问客体自己是哪个内核版本（`uname -r`），与布局产物的版本号对照 ...');
  const unameCursor = bootText.length;
  const unamePost = await typeAt(ctx.live.frames.at(-1), { text: 'uname -r; echo UN""AME-DONE-\n' });
  const unameText = unamePost.status === 200
    ? await waitForTerminalMarker(app, ctx.base, 'UNAME-DONE-', 90000, unameCursor)
    : '';
  const unameLines = unameText.split('\n');
  const unameAt = unameLines.findIndex((line) => line.includes('UNAME-DONE-'));
  const releaseLine = unameAt > 0 ? unameLines[unameAt - 1].trim() : null;
  evidence.guest = {
    status: unamePost.status,
    uname: releaseLine,
    layoutRelease: layout.linuxRelease,
    tail: unameText.slice(-300),
  };
  check(
    'T07f-B0c 客体自报的内核版本就是布局产物对应的那个内核：解析器的结构偏移只对得上"这一个内核"，'
      + '这件事必须由客体自己作证，不能由我们假定（断点与 `sizeof` 用的是同一份符号，'
      + '版本错了后面所有偏移都会整体偏）',
    typeof releaseLine === 'string' && releaseLine.length > 0
      && (releaseLine === layout.linuxRelease
        || releaseLine.includes(layout.linuxRelease)
        || layout.linuxRelease.includes(releaseLine)),
    `uname -r = ${releaseLine ?? '（没读到）'}；布局产物 = ${layout.linuxRelease}`,
  );

  /* ---------------- B1：fsync 的第一步：页是脏的、还没有 I/O ---------------- */

  const writeInfo = expectedWriteBytes(fs.readFileSync(LAB_C, 'utf8'));
  if (writeInfo === null) throw new Error('从 lab.c 里读不到 write_file() 那段字符串字面量，B1 的期望值算不出来');
  const writeBytes = BigInt(writeInfo.written);
  ctx.percpuHotLink = ctx.symbols.get('pcpu_hot') ?? null;
  ctx.taskOffsets = {
    comm: layout.byteOffset('task_struct', 'comm'),
    pid: layout.byteOffset('task_struct', 'pid'),
    tgid: layout.byteOffset('task_struct', 'tgid'),
    mm: layout.byteOffset('task_struct', 'mm'),
    realParent: layout.byteOffset('task_struct', 'real_parent'),
    files: layout.byteOffset('task_struct', 'files'),
  };
  if (ctx.percpuHotLink === null) throw new Error('符号表里没有 pcpu_hot，认不出停点停在谁身上');

  log(`停点 1/4：lab-write 停在 file_write_and_wait_range（写 ${LAB_WRITE_FILE}，期望 f_pos = ${writeBytes}）...`);
  const claim1 = await claimWithRetry({
    app,
    base: ctx.base,
    live: ctx.live,
    cmd,
    symbol: 'file_write_and_wait_range',
    commandFor: (attempt) => `lab-write ${LAB_WRITE_FILE}; echo WR${attempt}""ITE1-DONE-$?\n`,
    markerFor: (attempt) => `WR${attempt}ITE1-DONE-`,
    inspect: async (frame) => {
      const view = viewFor(frame);
      const fileAddress = generalRegister(frame.cpu, 'rdi');
      if (fileAddress === null || fileAddress === 0n) return { claimed: false, label: '$rdi 为空' };
      const info = await describeStoppedTask(captureFor(frame), ctx.percpuHotLink, ctx.taskOffsets);
      let file = null;
      try {
        file = await readFile(view, layout, fileAddress, { fd: null });
      } catch (error) {
        return { claimed: false, label: `读 file 失败：${error.message}` };
      }
      const hit = info.comm === 'lab-write' && file.fPos === writeBytes;
      return { claimed: hit, label: `${info.label} f_pos=${file.fPos}`, value: { fileAddress, info } };
    },
  });
  evidence.stop1 = {
    symbol: 'file_write_and_wait_range',
    failed: claim1.failed,
    attempts: claim1.attempts,
    stops: claim1.stops,
    breakpoint: claim1.breakpoint === null ? null : {
      id: claim1.breakpoint.id, address: claim1.breakpoint.address, pending: claim1.breakpoint.pending,
    },
  };
  if (claim1.failed) {
    throw new Error(`没有等到 lab-write 停在 file_write_and_wait_range（试了 ${claim1.attempts.length} 次）；`
      + `串口尾部=${await terminalTailOf(app, ctx.base)}`);
  }
  const frame1 = claim1.frame;
  const capture1 = captureFor(frame1);
  const view1 = new KernelMemoryView(capture1);
  const fileAddress1 = claim1.value.fileAddress;
  const file1 = await readFile(view1, layout, fileAddress1, { fd: null });
  const task1 = await describeStoppedTask(capture1, ctx.percpuHotLink, ctx.taskOffsets);
  const reg1 = {
    rdi: generalRegister(frame1.cpu, 'rdi'),
    rsi: generalRegister(frame1.cpu, 'rsi'),
    rdx: generalRegister(frame1.cpu, 'rdx'),
    rcx: generalRegister(frame1.cpu, 'rcx'),
    rip: generalRegister(frame1.cpu, 'rip'),
    rsp: generalRegister(frame1.cpu, 'rsp'),
  };
  evidence.stop1.frame = {
    frameId: frame1.frameId, rip: hexOrNull(reg1.rip), rsp: hexOrNull(reg1.rsp),
    task: task1, registers: {
      rdi: hexOrNull(reg1.rdi), rsi: hexOrNull(reg1.rsi), rdx: hexOrNull(reg1.rdx), rcx: hexOrNull(reg1.rcx),
    },
  };

  check(
    'T07f-B1a 停点 1 确实是 `fsync()` 的第一步：`file_write_and_wait_range(file, 0, LLONG_MAX)`。'
      + '`$rdi` 就是那个 `struct file *`，`$rsi`=0 与 `$rdx`=`0x7fffffffffffffff` 两个常量来自'
      + '`vfs_fsync()`→`vfs_fsync_range(file, 0, LLONG_MAX, …)`→`ext2_fsync()`→`generic_buffers_fsync()`'
      + '→`generic_buffers_fsync_noflush()` 这条链（现读源码确认过），也正是"这一刻还没有任何 I/O 在搬"的判据',
    reg1.rdi === fileAddress1 && reg1.rsi === 0n && reg1.rdx === 0x7fffffffffffffffn,
    `$rdi=${hexOrNull(reg1.rdi)}（读出的 file 地址=${hexOrNull(file1.address)}）`
      + ` $rsi=${hexOrNull(reg1.rsi)} $rdx=${hexOrNull(reg1.rdx)}；停在 ${task1.label}`,
  );

  let mappingAddress = file1.fMapping;
  let inode1 = null;
  if (file1.fInode !== null) inode1 = await readInode(view1, layout, file1.fInode);
  if (mappingAddress === null && inode1 !== null) mappingAddress = inode1.mapping;
  check(
    'T07f-B1b 同一个 file：`f_pos` 正好是 lab.c 里那 33 个字节（`write()` 已经返回、数据在页缓存里、'
      + 'fsync 刚进门），而且 `file->f_mapping` 与 `file->f_inode->i_mapping` 是**同一个** `address_space`'
      + '（`do_dentry_open()` 里就是 `f_mapping = i_mapping`）—— 页缓存的入口从此没有第二种可能',
    mappingAddress !== null && file1.fPos === writeBytes
      && file1.fInode !== null && inode1 !== null && inode1.mapping === file1.fMapping,
    `f_pos=${file1.fPos}（期望 ${writeBytes}，来自 lab.c 的 ${writeInfo.literal}：`
      + `sizeof(text)=${writeInfo.sizeOfText} 减掉编译期补的结尾 0）`
      + `；f_mapping=${hexOrNull(file1.fMapping)} i_mapping=${hexOrNull(inode1?.mapping)}`
      + ` inode.size=${inode1?.size ?? '（没读到）'} inode.blocks=${inode1?.blocks ?? '（没读到）'}`,
  );

  const mapping1 = await readAddressSpace(view1, layout, mappingAddress);
  ctx.vmemmap = await resolveVmemmapBase(view1, layout, { pfn: 0n });
  const cache1 = await readPageCache(view1, layout, mapping1, {
    indexMin: 0n,
    indexMax: 0n,
    maxEntries: 8,
    vmemmap: ctx.vmemmap,
  });
  const entry1 = cache1.entries.find((entry) => entry.index === 0n) ?? null;
  const folio1 = entry1 === null ? null : entry1.folio;
  evidence.pageCache = {
    mapping: hexOrNull(mappingAddress),
    nrpages: mapping1.nrpages.toString(),
    vmemmapBase: hexOrNull(ctx.vmemmap.base),
    pageStructSize: String(ctx.vmemmap.pageStructSize),
    entries: cache1.entries.map((entry) => ({
      index: entry.index.toString(),
      page: hexOrNull(entry.pageAddress),
      pfn: hexOrNull(entry.pfn),
      error: entry.error,
    })),
    violations: cache1.violations,
    notes: cache1.notes,
  };
  const writeState1 = classifyFileWriteState({
    mappingAddress,
    fileOffsetStart: 0n,
    fileOffsetEnd: writeBytes,
    folios: folio1 === null ? [] : [folio1],
    traces: [],
    links: new Map(),
  });
  check(
    'T07f-B1c 停点 1 是"缓存命中、还没落盘"：被写的那一页在页缓存里、`PG_dirty` 立着、'
      + '而且没有任何 bio/请求在搬它 → 判读必须是 `in-cache-dirty-no-io`。'
      + '这一条就是"页缓存与盘面必须是两个来源"里**页缓存那一侧**的判据',
    folio1 !== null && folio1.mapping === mappingAddress && folio1.index === 0n
      && folio1.pageFlags.includes('PG_dirty')
      && writeState1.phase === 'in-cache-dirty-no-io'
      && writeState1.dirtyPages === 1 && writeState1.pagesCarried === 0,
    `页=${hexOrNull(folio1?.address)} index=${folio1?.index} mapping=${hexOrNull(folio1?.mapping)}`
      + ` 标志=${(folio1?.pageFlags ?? []).join('|') || '（无）'}`
      + `；phase=${writeState1.phase} 脏页=${writeState1.dirtyPages} 被搬=${writeState1.pagesCarried}`
      + `；reasons=${writeState1.reasons.join(' / ')}`,
  );

  log('停点 1 的参照：让 GDB 用它自己的 DWARF 把同一个 file / address_space / 那一页重读一遍 ...');
  const ref1 = await runReference(ctx.live, 'stop1', {
    file: fileAddress1,
    mapping: mappingAddress,
    pageIndex: 0,
  });
  if (!ref1.ok) throw new Error(`停点 1 的参照实现失败了：${ref1.error}`);
  const ref1Data = ref1.data;
  const fileCmp1 = comparePaths(file1, ref1Data.file, FILE_PATHS);
  const spaceCmp1 = comparePaths(mapping1, ref1Data.addressSpace, ADDRESS_SPACE_PATHS);
  const refPage1 = ref1Data.pageCacheEntry?.page ?? null;
  const pageCmp1 = comparePaths(folio1 ?? {}, refPage1 ?? {}, PAGE_PATHS);
  const refEntry1 = ref1Data.pageCacheEntry ?? null;
  // 参照脚本只有在带了 request 的停点上才解 vmemmap（它挂在 request 那一支里），
  // 停点 1 只给 file/mapping/pageIndex，所以这里可能没有 —— 不硬取，改成"给了就比"，
  // 而"页地址 ↔ 页框号"这条换算的三方同址断言放在停点 2（那时两侧都解了 vmemmap）。
  const refVmemmap1 = ref1Data.vmemmap ?? null;
  // `folio_nr_pages` 两侧口径不同，**不能**按"逐字节相同"比：参照读的是
  // `_folio_nr_pages` 那 4 个字节的原始值（order-0 页上是复用存储的垃圾/0），
  // 我方按内核 `folio_nr_pages()` 的语义（非大页直接返回 1、根本不读那个字段）留空。
  // 所以判据是"口径本身"：PG_head 立着时两边必须相等；没立着我方必须是空。
  const folioNrPages1 = folio1 === null || refPage1 === null
    ? null
    : (folio1.pageFlags.includes('PG_head')
      ? {
        kind: 'large-folio',
        ours: folio1.folioNrPages,
        theirs: refPage1.folioNrPages ?? null,
        ok: folio1.folioNrPages !== null && Number(refPage1.folioNrPages) === folio1.folioNrPages,
      }
      : {
        kind: 'order-0',
        ours: folio1.folioNrPages,
        theirs: refPage1.folioNrPages ?? null,
        ok: folio1.folioNrPages === null && refPage1.folioNrPages !== undefined,
      });
  const pageFlags1 = {
    mine: [...(folio1?.pageFlags ?? [])].sort(),
    theirs: [...(refPage1?.pageFlags ?? [])].sort(),
  };
  evidence.stop1.reference = {
    ok: ref1.ok,
    stop: ref1Data.stop,
    registers: ref1Data.registers,
    widths: ref1Data.widths,
    file: fileCmp1,
    addressSpace: spaceCmp1,
    page: pageCmp1,
    pageFlags: pageFlags1,
    folioNrPages: folioNrPages1,
    entry: refEntry1 === null ? null : {
      index: refEntry1.index, present: refEntry1.present, kind: refEntry1.kind, pointer: refEntry1.pointer,
    },
    ourEntry: entry1 === null ? null : { index: entry1.index.toString(), page: hexOrNull(entry1.pageAddress) },
    ipages: ref1Data.ipages,
    ourXarray: { head: hexOrNull(cache1.xarray.head), rootShift: cache1.xarray.rootShift, headKind: cache1.xarray.headKind },
    vmemmap: refVmemmap1,
    ambiguities: ref1Data.ambiguities,
    notes: ref1Data.notes,
  };
  check(
    'T07f-B1d 文件这一侧逐字段对上：`struct file`（15 项）、`address_space`（10 项）、那一页（13 项）'
      + '全部由 GDB 的 DWARF 独立读一遍再比；页标志名字集合两边一致；'
      + '页缓存槽里那个 `struct page *` 与我们的页地址同址；'
      + '`folio_nr_pages` 按各自口径判（order-0 页上内核根本不读那 4 个字节，我方必须留空、'
      + '参照必须给出它读到的原始值）—— 这一项不能按"逐字节相同"比，否则会把口径差异当成解析错误；'
      + '`private_data` 这类可能是空指针的字段按"空指针"比：我方记 `null`、参照记 `0`，是同一个事实',
    fileCmp1.mismatches.length === 0 && fileCmp1.absent.length === 0
      && spaceCmp1.mismatches.length === 0 && spaceCmp1.absent.length === 0
      && pageCmp1.mismatches.length === 0 && pageCmp1.absent.length === 0
      && sameNameSet(pageFlags1.mine, pageFlags1.theirs)
      && refEntry1 !== null && refEntry1.present === true
      && entry1 !== null && BigInt(refEntry1.pointer) === entry1.pageAddress
      && folioNrPages1 !== null && folioNrPages1.ok === true
      && (refVmemmap1 === null || BigInt(refVmemmap1.base) === ctx.vmemmap.base),
    `${compareText('file', fileCmp1)}；${compareText('address_space', spaceCmp1)}；`
      + `${compareText('page', pageCmp1)}；页标志 我方=${pageFlags1.mine.join('|')} 参照=${pageFlags1.theirs.join('|')}；`
      + `页缓存槽 pointer=${refEntry1?.pointer ?? '（无）'} vs 我方 ${hexOrNull(entry1?.pageAddress)}；`
      + `folio_nr_pages（${folioNrPages1?.kind ?? '没读到页'}）我方=${folioNrPages1?.ours ?? '（空）'}`
      + ` 参照=${folioNrPages1?.theirs ?? '（空）'}；`
      + `vmemmap 基址：参照${refVmemmap1 === null
        ? '这一次没给（参照只在带 request 的停点上解 vmemmap）'
        : `=${hex(BigInt(refVmemmap1.base))}`} vs 我方=${hex(ctx.vmemmap.base)}；`
      + `停点符号=${ref1Data.stop?.symbolLine ?? '（没读到）'}`,
  );

  // 这一条断点已经用完：不摘掉的话，后面 guest 里任何一次 fsync 都会把我们再停一次，
  // 而那些停点不属于这次验收，只会把"下一个停点"搞乱。
  if (claim1.breakpoint?.id !== null && claim1.breakpoint?.id !== undefined) {
    const removed1 = await cmd('breakpoint.remove', { breakpointId: claim1.breakpoint.id });
    evidence.stop1.breakpointRemoved = removed1.status;
  }
  evidence.stop1.continued = (await cmd('continue')).status;
  await sleep(1500);

  /** 一个停点用完之后：摘掉断点再放开客体（断点留着的话，后面每个同名调用都会把我们停一次）。 */
  const retire = async (claim, record) => {
    if (claim.breakpoint?.id !== null && claim.breakpoint?.id !== undefined) {
      const removed = await cmd('breakpoint.remove', { breakpointId: claim.breakpoint.id });
      record.breakpointRemoved = removed.status;
    }
    const continued = await cmd('continue');
    record.continued = continued.status;
    await sleep(1500);
  };

  if (folio1 === null) throw new Error('停点 1 没读到文件第 0 页的 folio：后面"请求搬的是不是这一页"无从谈起');

  /* ---------------- B2：请求已经算"在飞"，但还没进 virtio 环 ---------------- */

  log(`停点 2/4：lab-write 停下 virtblk_add_req（$rdi=vq、$rsi=PDU），只认"搬的是那个文件第 0 页"的那一次 ...`);
  const claim2 = await claimWithRetry({
    app,
    base: ctx.base,
    live: ctx.live,
    cmd,
    symbol: 'virtblk_add_req',
    commandFor: (attempt) => `lab-write ${LAB_WRITE_FILE}; echo WR${attempt}""ITE2-DONE-$?\n`,
    markerFor: (attempt) => `WR${attempt}ITE2-DONE-`,
    inspect: async (frame) => {
      const view = viewFor(frame);
      const pduAddress = generalRegister(frame.cpu, 'rsi');
      const vqAddress = generalRegister(frame.cpu, 'rdi');
      if (pduAddress === null || pduAddress === 0n || vqAddress === null) {
        return { claimed: false, label: '$rdi/$rsi 为空' };
      }
      let typeWord = null;
      try {
        typeWord = await u32Of(view, pduAddress + BigInt(layout.byteOffset('virtblk_req', 'out_hdr.type')));
      } catch (error) {
        return { claimed: false, label: `读 out_hdr.type 失败：${error.message}` };
      }
      const kind = (typeWord & ~VIRTIO_BLK_T.BARRIER) >>> 0;
      if (kind !== VIRTIO_BLK_T.OUT) return { claimed: false, label: `type=${kind}` };
      const requestAddress = pduAddress - BigInt(structRequestSizeOf(layout));
      let pages = [];
      try {
        pages = await bioPagesOfRequest(view, layout, requestAddress);
      } catch (error) {
        return { claimed: false, label: `顺 bio 失败：${error.message}` };
      }
      const hit = pages.find((page) => page.mapping === mappingAddress && page.index === 0n) ?? null;
      return {
        claimed: hit !== null,
        label: `type=OUT pdu=${hex(pduAddress)} pages=${pages.map((page) => `${hexOrNull(page.pageAddress)}@${page.index}`).join(', ') || '无'}`,
        value: hit === null ? null : { pduAddress, vqAddress, requestAddress, pageAddress: hit.pageAddress },
      };
    },
  });
  evidence.stop2 = {
    symbol: 'virtblk_add_req',
    failed: claim2.failed,
    attempts: claim2.attempts,
    stops: claim2.stops,
  };
  if (claim2.failed) {
    throw new Error(`没有等到 lab-write 在 virtblk_add_req 上搬那个文件的第 0 页（试了 ${claim2.attempts.length} 次）；`
      + `串口尾部=${await terminalTailOf(app, ctx.base)}`);
  }
  const frame2 = claim2.frame;
  const view2 = viewFor(frame2);
  const pduAddress2 = claim2.value.pduAddress;
  const requestAddress2 = claim2.value.requestAddress;
  const trace2 = await traceRequest(view2, layout, requestAddress2, { readTags: true, readBios: true });
  const task2 = await describeStoppedTask(captureFor(frame2), ctx.percpuHotLink, ctx.taskOffsets);
  const reg2 = {
    rdi: generalRegister(frame2.cpu, 'rdi'),
    rsi: generalRegister(frame2.cpu, 'rsi'),
    rip: generalRegister(frame2.cpu, 'rip'),
  };
  evidence.stop2.frame = {
    frameId: frame2.frameId,
    task: task2,
    registers: { rdi: hexOrNull(reg2.rdi), rsi: hexOrNull(reg2.rsi), rip: hexOrNull(reg2.rip) },
    request: hexOrNull(requestAddress2),
    pdu: hexOrNull(pduAddress2),
  };

  check(
    'T07f-B2a 停点 2 的位置信息来自寄存器本身，不是猜的：`virtblk_add_req(vq, vbr)` 的第一个参数是 virtqueue、'
      + '第二个是请求私有区（PDU）的地址，所以 `$rdi` 就是环、`$rsi` 就是 `blk_mq_rq_to_pdu(rq)` = '
      + '`rq + sizeof(struct request)`；把 `$rsi` 减掉 `sizeof(struct request)`（从布局产物取，'
      + `本内核是 ${structRequestSizeOf(layout)} 字节）得到的请求地址，读出来的 \`pduAddress\` 必须正好回到 \`$rsi\``,
    reg2.rdi !== null && reg2.rdi === trace2.vq?.address
      && reg2.rsi === pduAddress2 && trace2.request.address === requestAddress2
      && trace2.request.pduAddress === pduAddress2,
    `$rdi=${hexOrNull(reg2.rdi)}（virtqueue=${hexOrNull(trace2.vq?.address ?? null)}）`
      + ` $rsi=${hexOrNull(reg2.rsi)}（PDU=${hexOrNull(pduAddress2)}）`
      + ` rq=$rsi-${structRequestSizeOf(layout)}=${hex(requestAddress2)}`
      + ` 反向算出 pduAddress=${hex(trace2.request.pduAddress)}；停在 ${task2.label}`,
  );

  const links2 = new Map();
  for (const bio of trace2.bioChain.bios) {
    links2.set(bio.address.toString(), await linkBioToFolios(view2, layout, bio, { vmemmap: ctx.vmemmap }));
  }
  const flatLinks2 = [...links2.values()].flat();
  const samePage2 = flatLinks2.find((link) => link.folio !== null && link.folio.address === folio1.address) ?? null;
  evidence.stop2.pageJoint = {
    fromBio: hexOrNull(claim2.value.pageAddress),
    fromPageCache: hexOrNull(folio1.address),
    bioVectors: flatLinks2.map((link) => ({
      bio: hexOrNull(link.bioAddress), index: link.bioVecIndex, page: hexOrNull(link.pageAddress),
      pfn: hexOrNull(link.pfn), folio: hexOrNull(link.folio?.address ?? null),
      mapping: hexOrNull(link.folio?.mapping ?? null), folioIndex: link.folio === null ? null : link.folio.index.toString(),
    })),
    bioChain: {
      bios: trace2.bioChain.bios.length,
      sectorStart: hexOrNull(trace2.bioChain.sectorStart),
      sectorEnd: hexOrNull(trace2.bioChain.sectorEnd),
      contiguous: trace2.bioChain.contiguous,
      seams: trace2.bioChain.seams,
    },
  };
  check(
    'T07f-B2c "请求搬的页"与"文件被写的那一页"是**同一个 `struct page`**：停点 2 的请求 → `bio` → `bio_vec` → '
      + '`bv_page` 与停点 1 的 file → `f_mapping` → XArray 槽 → `struct page` 是两条毫不相干的路径，'
      + '它们必须落到同一个地址上，而且这一页的 `mapping`/`index` 也必须是那个文件的第 0 页。'
      + '这就是"文件与设备请求之间那一跳"的全部内容 —— 靠扇区区间去猜是做不到的',
    samePage2 !== null && claim2.value.pageAddress === folio1.address
      && samePage2.folio.mapping === mappingAddress && samePage2.folio.index === 0n
      && trace2.bioChain.bios.length >= 1,
    `bio 里的页=${hexOrNull(claim2.value.pageAddress)} vs 页缓存里的页=${hexOrNull(folio1.address)}`
      + `（bio 共 ${flatLinks2.length} 段、${trace2.bioChain.bios.length} 个 bio）；`
      + `命中段=${samePage2 === null ? '无' : `bio ${hex(samePage2.bioAddress)} 的第 ${samePage2.bioVecIndex} 段`}`
      + ` pfn=${hexOrNull(samePage2?.pfn ?? null)} mapping=${hexOrNull(samePage2?.folio?.mapping ?? null)}`
      + ` index=${samePage2?.folio?.index ?? '?'}`,
  );

  const writeState2 = classifyFileWriteState({
    mappingAddress,
    fileOffsetStart: 0n,
    fileOffsetEnd: writeBytes,
    folios: [folio1],
    traces: [trace2],
    links: links2,
  });
  check(
    'T07f-B2d 同一页、同一个文件偏移区间，只是多了一个"设备侧正在搬它"的事实，判读就从 `in-cache-dirty-no-io` '
      + '变成 `in-cache-dirty-io-pending`：这一对状态正是面板上必须分开显示的"缓存命中"与"正在落盘"，'
      + '而且搬运者要指名道姓到"哪个请求的第几个 bio 向量"',
    writeState2.phase === 'in-cache-dirty-io-pending' && writeState2.pagesCarried === 1
      && writeState2.pages[0].carriedBy.length >= 1
      && writeState2.pages[0].carriedBy[0].requestAddress === requestAddress2,
    `phase=${writeState1.phase}（无 I/O）→ ${writeState2.phase}（有 I/O）；被搬 ${writeState2.pagesCarried} 页；`
      + `搬运者=${jsonHex(writeState2.pages[0]?.carriedBy ?? [])}；`
      + `reasons=${writeState2.reasons.join(' / ')}；violations=${writeState2.violations.join('；') || '无'}`,
  );

  check(
    'T07f-B2b 生命周期是 `not-submitted`，并且**必须如实报出"环上没有 token"这条歧义**：'
      + '`virtblk_prep_rq()` 先调 `blk_mq_start_request()`（`rq->state` 已经是 `MQ_RQ_IN_FLIGHT`）、'
      + '`virtblk_add_req()` 还没跑到最后那句 `virtqueue_add_sgs(…, vbr, …)`，所以这一刻 `desc_state` 里'
      + '没有它的 token、`avail->idx` 与 `used->idx` 也相等。只看两个计数器会把它说成"已经回收"，'
      + '而回收之后 tag 立刻会被别的请求拿走 —— 那种错法每个字段都自洽，只有把 `rq->state` 一起读才分得开',
    trace2.lifecycle === 'not-submitted' && trace2.request.stateName === 'MQ_RQ_IN_FLIGHT'
      && trace2.tokenLookup !== null && trace2.tokenLookup.unique === false
      && trace2.tokenLookup.ambiguity !== null
      && trace2.unique === false && trace2.ambiguities.length > 0
      && trace2.pdu !== null && trace2.pdu.outTypeSymbol === 'VIRTIO_BLK_T_OUT'
      && trace2.descriptorChain === null,
    `rq->state=${trace2.request.stateName}（${trace2.request.state}）phase=${trace2.lifecycle}；`
      + `token=${hexOrNull(trace2.tokenLookup?.token ?? null)} heads=${JSON.stringify(trace2.tokenLookup?.heads ?? [])} `
      + `unique=${trace2.tokenLookup?.unique}；ambiguity=${trace2.tokenLookup?.ambiguity ?? '（无）'}；`
      + `歧义共 ${trace2.ambiguities.length} 条、unique=${trace2.unique}；设备头类型=${trace2.pdu?.outTypeSymbol}`,
  );

  log('停点 2 的参照：GDB 用自己的 DWARF 把 request/queue/hw_ctx/virtio_blk/virtqueue/desc_state/PDU/bio 重读一遍 ...');
  const ref2 = await runReference(ctx.live, 'stop2', {
    request: requestAddress2,
    pdu: pduAddress2,
    vq: trace2.vq === null ? 0n : trace2.vq.address,
    file: fileAddress1,
    mapping: mappingAddress,
    pageIndex: 0,
  });
  if (!ref2.ok) throw new Error(`停点 2 的参照实现失败了：${ref2.error}`);
  const ref2Data = ref2.data;
  const requestCmp2 = comparePaths(trace2.request, ref2Data.request ?? {}, REQUEST_PATHS);
  const opfCmp2 = compareOpf(trace2.request, ref2Data.request ?? {});
  const pduCmp2 = comparePaths(trace2.pdu ?? {}, ref2Data.pdu ?? {}, PDU_PATHS);
  const queueCmp2 = comparePaths(trace2.queue ?? {}, ref2Data.queue ?? {}, QUEUE_PATHS);
  const hwCtxCmp2 = comparePaths(trace2.hwCtx ?? {}, ref2Data.hwCtx ?? {}, HWCTX_PATHS);
  const vblkCmp2 = comparePaths(trace2.driverState ?? {}, ref2Data.virtioBlk ?? {}, VIRTIO_BLK_PATHS);
  const vqCmp2 = comparePaths(trace2.vq ?? {}, ref2Data.vq ?? {}, VQ_PATHS);
  const ownersCmp2 = comparePaths(trace2.owners ?? {}, ref2Data.owners ?? {}, ['occupied', 'distinctTokens']);
  const ownerCountOk2 = trace2.owners !== null && ref2Data.owners !== undefined
    && trace2.owners.owners.length === ref2Data.owners.amount;
  const bioCmp2 = trace2.bioChain.bios.map((bio, index) => ({
    index,
    fields: comparePaths(bio, (ref2Data.bios ?? [])[index] ?? {}, BIO_PATHS),
    opf: compareOpf(bio, (ref2Data.bios ?? [])[index] ?? {}),
  }));
  const refTagSlot2 = (ref2Data.tags?.tagged ?? []).find((entry) => entry.tag === trace2.request.tag) ?? null;
  const ourTagSlot2 = (trace2.tags?.tagged ?? []).find((entry) => entry.tag === trace2.request.tag) ?? null;
  const tagsCmp2 = comparePaths(trace2.tags ?? {}, ref2Data.tags ?? {}, TAGS_PATHS);
  const comparisons2 = [requestCmp2, opfCmp2, pduCmp2, queueCmp2, hwCtxCmp2, vblkCmp2, vqCmp2, ownersCmp2,
    tagsCmp2, ...bioCmp2.map((entry) => entry.fields), ...bioCmp2.map((entry) => entry.opf)];
  evidence.stop2.reference = {
    ok: ref2.ok,
    stop: ref2Data.stop,
    registers: ref2Data.registers,
    comparisons: {
      request: requestCmp2,
      requestOpf: opfCmp2,
      pdu: pduCmp2,
      queue: queueCmp2,
      hwCtx: hwCtxCmp2,
      virtioBlk: vblkCmp2,
      vq: vqCmp2,
      owners: ownersCmp2,
      tags: tagsCmp2,
      bios: bioCmp2,
    },
    ownerCount: { ours: trace2.owners?.owners.length ?? null, theirs: ref2Data.owners?.amount ?? null, equal: ownerCountOk2 },
    tokenLookup: { ours: trace2.tokenLookup, theirs: ref2Data.tokenLookup },
    descriptorChain: { ours: trace2.descriptorChain, theirs: ref2Data.descriptorChain ?? null },
    segmentReconciliation: ref2Data.segmentReconciliation ?? null,
    tagSlot: { ours: ourTagSlot2, theirs: refTagSlot2 },
    lifecycle: { ours: trace2.lifecycle, theirs: ref2Data.lifecycle },
    vmemmap: ref2Data.vmemmap ?? null,
    ourVmemmap: { base: hex(ctx.vmemmap.base), pageStructSize: String(ctx.vmemmap.pageStructSize) },
    driverStateIdentity: { disk: hexOrNull(trace2.disk ?? null), vblkDisk: hexOrNull(trace2.driverState?.disk ?? null) },
    ambiguities: ref2Data.ambiguities,
    ambiguitiesOurs: trace2.ambiguities,
    notes: ref2Data.notes,
  };
  check(
    'T07f-B2e 设备侧整条链逐字段对上：`request`（23 项 + `cmd_flags` 的"操作码/符号/标志位"三件套）、'
      + '`request_queue`（16 项）、`blk_mq_hw_ctx`（12 项）、`virtio_blk`（含 `io_queues[3]`）、'
      + '`virtqueue`（29 项）、请求私有区（13 项）、`blk_mq_tags`（6 项）、`desc_state` 的槽数与不同 token 数、'
      + '`bio`（21 项 + `bi_opf` 三件套）—— 全部由 GDB 用自己的 DWARF 重读一遍再比。'
      + '两侧的 `lifecycle` 由两套独立实现分别判出来，也必须是同一个阶段；'
      + '两侧各自解出的 vmemmap 基址也必须相同 —— 它是"`bv_page` 这种页结构地址 ↔ 页框号"'
      + '这条换算的唯一依据，基址错了后面每一段数据落在哪个页上都会整体偏',
    comparisons2.every((entry) => entry.mismatches.length === 0 && entry.absent.length === 0)
      && ownerCountOk2
      && ref2Data.lifecycle?.phase === trace2.lifecycle
      && ref2Data.vmemmap !== undefined && ref2Data.vmemmap !== null
      && BigInt(ref2Data.vmemmap.base) === ctx.vmemmap.base
      && BigInt(ref2Data.vmemmap.pageStructSize ?? 0) === BigInt(ctx.vmemmap.pageStructSize)
      && (refTagSlot2 === null || ourTagSlot2 === null
        || BigInt(refTagSlot2.request ?? 0) === BigInt(ourTagSlot2.request ?? 0))
      && ourTagSlot2 !== null && ourTagSlot2.request === requestAddress2,
    `一致项数=${comparisons2.reduce((sum, entry) => sum + entry.compared.length, 0)}；`
      + `不一致=${comparisons2.flatMap((entry) => entry.mismatches).join('；') || '无'}；`
      + `两侧都没有的路径=${comparisons2.flatMap((entry) => entry.absent).join('、') || '无'}；`
      + `desc_state 槽数 我方=${trace2.owners?.owners.length} 参照=${ref2Data.owners?.amount}；`
      + `vmemmap 我方=${hex(ctx.vmemmap.base)}(page=${ctx.vmemmap.pageStructSize})`
      + ` 参照=${ref2Data.vmemmap === undefined || ref2Data.vmemmap === null
        ? '（没给）' : `${hex(BigInt(ref2Data.vmemmap.base))}(page=${ref2Data.vmemmap.pageStructSize})`}；`
      + `lifecycle 我方=${trace2.lifecycle} 参照=${ref2Data.lifecycle?.phase}；`
      + `tags->rqs[${trace2.request.tag}] 我方=${hexOrNull(ourTagSlot2?.request ?? null)} 参照=${hexOrNull(refTagSlot2?.request ?? null)}`,
  );

  await retire(claim2, evidence.stop2);

  /* ---------------- B3：预读（内核替程序提前读的那一段） ---------------- */

  log(`停点 3/4：lab-read ${LAB_READ_FILE} 停下 virtblk_add_req，只认方向是读、且 bio 上立着 REQ_RAHEAD 的那一次 ...`);
  const claim3 = await claimWithRetry({
    app,
    base: ctx.base,
    live: ctx.live,
    cmd,
    symbol: 'virtblk_add_req',
    commandFor: (attempt) => `lab-read ${LAB_READ_FILE}; echo READ${attempt}""Y3-DONE-$?\n`,
    markerFor: (attempt) => `READ${attempt}Y3-DONE-`,
    inspect: async (frame) => {
      const view = viewFor(frame);
      const pduAddress = generalRegister(frame.cpu, 'rsi');
      const vqAddress = generalRegister(frame.cpu, 'rdi');
      if (pduAddress === null || pduAddress === 0n || vqAddress === null) {
        return { claimed: false, label: '$rdi/$rsi 为空' };
      }
      let typeWord = null;
      try {
        typeWord = await u32Of(view, pduAddress + BigInt(layout.byteOffset('virtblk_req', 'out_hdr.type')));
      } catch (error) {
        return { claimed: false, label: `读 out_hdr.type 失败：${error.message}` };
      }
      const kind = (typeWord & ~VIRTIO_BLK_T.BARRIER) >>> 0;
      if (kind !== VIRTIO_BLK_T.IN) return { claimed: false, label: `type=${kind}` };
      const requestAddress = pduAddress - BigInt(structRequestSizeOf(layout));
      const bioPointer = await u64Of(view, requestAddress + BigInt(layout.byteOffset('request', 'bio')));
      if (bioPointer === 0n) return { claimed: false, label: `type=IN 但 bio 为空（pdu=${hex(pduAddress)}）` };
      const bioOpf = await u32Of(view, bioPointer + BigInt(layout.byteOffset('bio', 'bi_opf')));
      const cmdFlags = await u32Of(view, requestAddress + BigInt(layout.byteOffset('request', 'cmd_flags')));
      const onBio = decodeBioOpf(layout, bioOpf).flags.names.includes('REQ_RAHEAD');
      const onRequest = decodeBioOpf(layout, cmdFlags).flags.names.includes('REQ_RAHEAD');
      const hit = onBio || onRequest;
      return {
        claimed: hit,
        label: `type=IN pdu=${hex(pduAddress)} 预读：bio=${onBio} request=${onRequest}`,
        value: hit ? { pduAddress, vqAddress, requestAddress, bioPointer, onBio, onRequest } : null,
      };
    },
  });
  evidence.stop3 = {
    symbol: 'virtblk_add_req',
    failed: claim3.failed,
    attempts: claim3.attempts,
    stops: claim3.stops,
  };
  if (claim3.failed) {
    throw new Error(`没有等到 lab-read 在 virtblk_add_req 上出现预读请求（试了 ${claim3.attempts.length} 次）；`
      + `串口尾部=${await terminalTailOf(app, ctx.base)}`);
  }
  const frame3 = claim3.frame;
  const view3 = viewFor(frame3);
  const trace3 = await traceRequest(view3, layout, claim3.value.requestAddress, { readTags: true, readBios: true });
  const readahead3 = classifyReadahead(trace3);
  const task3 = await describeStoppedTask(captureFor(frame3), ctx.percpuHotLink, ctx.taskOffsets);
  const links3 = new Map();
  for (const bio of trace3.bioChain.bios) {
    links3.set(bio.address.toString(), await linkBioToFolios(view3, layout, bio, { vmemmap: ctx.vmemmap }));
  }
  const flatLinks3 = [...links3.values()].flat();
  const firstFolio3 = flatLinks3.find((link) => link.folio !== null) ?? null;
  const firstFolio = firstFolio3 === null ? null : firstFolio3.folio;
  evidence.stop3.frame = {
    frameId: frame3.frameId,
    task: task3,
    request: hexOrNull(claim3.value.requestAddress),
    pdu: hexOrNull(claim3.value.pduAddress),
    predicate: { onBio: claim3.value.onBio, onRequest: claim3.value.onRequest },
    readahead: {
      ours: readahead3,
      requestFlags: trace3.request.flags.names,
      bioFlags: trace3.bioChain.bios.map((bio) => bio.flags.names),
      bioCount: trace3.bioChain.bios.length,
      vectorCount: trace3.bioChain.bios.reduce((sum, bio) => sum + bio.vectors.length, 0),
      totalBytes: trace3.bioChain.bios.reduce((sum, bio) => sum + bio.totalBytes, 0),
      sectorStart: hexOrNull(trace3.bioChain.sectorStart),
      sectorEnd: hexOrNull(trace3.bioChain.sectorEnd),
      fileMappingOfWrite: hexOrNull(mappingAddress),
      readaheadPageMapping: hexOrNull(firstFolio === null ? null : firstFolio.mapping),
      readaheadPageIndex: firstFolio === null ? null : firstFolio.index.toString(),
      readaheadPage: hexOrNull(firstFolio === null ? null : firstFolio.address),
    },
  };
  check(
    'T07f-B3a 停点 3 是**内核替程序提前读**的那一段：块层把它记成读操作、设备请求头是 `VIRTIO_BLK_T_IN`，'
      + '而且 `REQ_RAHEAD` 真的立在请求或它的 bio 上（位号来自布局产物的 `req_flag_bits`，不是我抄的）',
    trace3.pdu !== null && trace3.pdu.outTypeSymbol === 'VIRTIO_BLK_T_IN'
      && trace3.request.op.symbol === 'REQ_OP_READ' && trace3.request.op.writesToDevice === false
      && readahead3.readahead === true && readahead3.flags.length > 0
      && trace3.lifecycle === 'not-submitted',
    `设备头=${trace3.pdu?.outTypeSymbol} 块层操作码=${trace3.request.op.symbol}（writesToDevice=${trace3.request.op.writesToDevice}）`
      + ` REQ_RAHEAD=${readahead3.readahead}（立在哪：${readahead3.flags.join('、') || '无'}）`
      + ` 生命周期=${trace3.lifecycle}；bin ps=${task3.comm ?? '（没读到）'}/${task3.label}；`
      + `reasons=${readahead3.reason}`,
  );
  check(
    'T07f-B3c 这一次预读搬的页与"我们刚写过的那一页"**不是**同一个文件：预读页的 `mapping` 是另一个 '
      + '`address_space`、`index` 从 0 起，说明它属于 `lab-read` 打开的那个文件（客体里 `probe.bin` 是 2 MiB，'
      + '程序只 read() 了 4096 字节，剩下的都是内核替它读的）。不把这类 I/O 标出来，'
      + '面板上就会出现"文件只读 4KB、盘上却读了几十 KB"这种看着像错的画面',
    trace3.bioChain.bios.length >= 1 && firstFolio !== null
      && firstFolio.index === 0n && firstFolio.mapping !== mappingAddress
      && trace3.bioChain.sectorStart === trace3.request.sector,
    `预读页=${hexOrNull(firstFolio?.address ?? null)} mapping=${hexOrNull(firstFolio?.mapping ?? null)}`
      + `（写文件那个 address_space 是 ${hex(mappingAddress)}）index=${firstFolio?.index ?? '?'}；`
      + `bio 共 ${evidence.stop3.frame.readahead.bioCount} 个 / ${evidence.stop3.frame.readahead.vectorCount} 段 / `
      + `${evidence.stop3.frame.readahead.totalBytes} 字节；扇区 ${trace3.request.sector}..${trace3.request.sectorEnd}`,
  );

  log('停点 3 的参照：GDB 用自己的 DWARF 把这次预读的 request/bio 重读一遍 ...');
  const ref3 = await runReference(ctx.live, 'stop3', {
    request: claim3.value.requestAddress,
    pdu: claim3.value.pduAddress,
    vq: trace3.vq === null ? 0n : trace3.vq.address,
  });
  if (!ref3.ok) throw new Error(`停点 3 的参照实现失败了：${ref3.error}`);
  const ref3Data = ref3.data;
  const requestCmp3 = comparePaths(trace3.request, ref3Data.request ?? {}, REQUEST_PATHS);
  const opfCmp3 = compareOpf(trace3.request, ref3Data.request ?? {});
  const pduCmp3 = comparePaths(trace3.pdu ?? {}, ref3Data.pdu ?? {}, PDU_PATHS);
  const vqCmp3 = comparePaths(trace3.vq ?? {}, ref3Data.vq ?? {}, VQ_PATHS);
  const bioCmp3 = trace3.bioChain.bios.map((bio, index) => ({
    index,
    fields: comparePaths(bio, (ref3Data.bios ?? [])[index] ?? {}, BIO_PATHS),
    opf: compareOpf(bio, (ref3Data.bios ?? [])[index] ?? {}),
    isReadahead: (ref3Data.bios ?? [])[index]?.isReadahead ?? null,
    flagNames: (ref3Data.bios ?? [])[index]?.flagNames ?? null,
  }));
  const comparisons3 = [requestCmp3, opfCmp3, pduCmp3, vqCmp3,
    ...bioCmp3.map((entry) => entry.fields), ...bioCmp3.map((entry) => entry.opf)];
  evidence.stop3.reference = {
    ok: ref3.ok,
    stop: ref3Data.stop,
    comparisons: { request: requestCmp3, requestOpf: opfCmp3, pdu: pduCmp3, vq: vqCmp3, bios: bioCmp3 },
    readahead: {
      ours: readahead3.readahead,
      requestIsReadahead: ref3Data.request?.isReadahead ?? null,
      requestFlagNames: ref3Data.request?.flagNames ?? null,
      biosIsReadahead: bioCmp3.map((entry) => entry.isReadahead),
      biosFlagNames: bioCmp3.map((entry) => entry.flagNames),
    },
    lifecycle: { ours: trace3.lifecycle, theirs: ref3Data.lifecycle?.phase ?? null },
    ambiguities: ref3Data.ambiguities,
    notes: ref3Data.notes,
  };
  check(
    'T07f-B3b 预读这件事两侧独立判读一致：我们的 `classifyReadahead` 与 GDB 脚本按 `req_flag_bits` 位号'
      + '自己算的 `__REQ_RAHEAD` 都立着，标志名字集合也一致；'
      + '同时 `request`/`pdu`/`virtqueue`/`bio` 的字段（含 `bi_opf` 三件套）逐项对上',
    comparisons3.every((entry) => entry.mismatches.length === 0 && entry.absent.length === 0)
      && ref3Data.request?.isReadahead === true
      && bioCmp3.some((entry) => entry.isReadahead === true)
      && ref3Data.lifecycle?.phase === trace3.lifecycle,
    `一致项数=${comparisons3.reduce((sum, entry) => sum + entry.compared.length, 0)}；`
      + `不一致=${comparisons3.flatMap((entry) => entry.mismatches).join('；') || '无'}；`
      + `两侧都没有的路径=${comparisons3.flatMap((entry) => entry.absent).join('、') || '无'}；`
      + `参照侧 REQ_RAHEAD：request=${ref3Data.request?.isReadahead} bio=${JSON.stringify(bioCmp3.map((entry) => entry.isReadahead))}；`
      + `lifecycle 我方=${trace3.lifecycle} 参照=${ref3Data.lifecycle?.phase}`,
  );

  await retire(claim3, evidence.stop3);

  /* ---------------- B4：设备已经把这一笔用完，驱动正要回收描述符 ---------------- */

  log('停点 4/4：lab-write 停下 detach_buf_split（$rdi=vq、$rsi=head），只认"设备已经把它写完、'
    + '驱动正要取走"的那一次 ...');
  const claim4 = await claimWithRetry({
    app,
    base: ctx.base,
    live: ctx.live,
    cmd,
    symbol: 'detach_buf_split',
    commandFor: (attempt) => `lab-write ${LAB_WRITE_FILE}; echo WR${attempt}""ITE4-DONE-$?\n`,
    markerFor: (attempt) => `WR${attempt}ITE4-DONE-`,
    inspect: async (frame) => {
      const view = viewFor(frame);
      const vqAddress = generalRegister(frame.cpu, 'rdi');
      const headRaw = generalRegister(frame.cpu, 'rsi');
      if (vqAddress === null || vqAddress === 0n || headRaw === null) {
        return { claimed: false, label: '$rdi/$rsi 为空' };
      }
      const head = Number(headRaw);
      let vq = null;
      try {
        vq = await readVirtqueue(view, layout, vqAddress);
      } catch (error) {
        return { claimed: false, label: `读 virtqueue 失败：${error.message}` };
      }
      if (vq.num === 0 || vq.usedAddress === 0n || vq.descStateAddress === 0n) {
        return { claimed: false, label: '环还没分配（num / used / desc_state 里有空的）' };
      }
      if (head >= vq.num) return { claimed: false, label: `head=${head} 超出环长 ${vq.num}` };
      const stateStride = layout.type('vring_desc_state_split').byteSize ?? 16;
      const token = littleEndian(await view.bytes(vq.descStateAddress + BigInt(head * stateStride), 8));
      if (token === 0n) {
        return { claimed: false, label: `desc_state[${head}] 的 token 是空的（这一笔已经回收完了）` };
      }
      const outstanding = (vq.availIdx - vq.usedIdx) & 0xffff;
      if (outstanding !== 0) {
        return { claimed: false, label: `设备侧还有 ${outstanding} 笔没回来（token=${hex(token)}）` };
      }
      const usedSlot = vq.lastUsedIdx & (vq.num - 1);
      const elemStride = layout.type('vring_used_elem').byteSize ?? 8;
      const elemBase = vq.usedAddress + BigInt(layout.byteOffset('vring_used', 'ring'))
        + BigInt(usedSlot * elemStride);
      const usedId = await u32Of(view, elemBase + BigInt(layout.byteOffset('vring_used_elem', 'id')));
      if (usedId !== head) {
        return { claimed: false, label: `used->ring[${usedSlot}].id=${usedId} 不是即将取走的 head=${head}` };
      }
      const requestAddress = token - BigInt(structRequestSizeOf(layout));
      let request = null;
      try {
        request = await readRequest(view, layout, requestAddress);
      } catch (error) {
        return { claimed: false, label: `token 减 sizeof(struct request) 不是可读的请求：${error.message}` };
      }
      if (request.address !== requestAddress || request.queue === null) {
        return {
          claimed: false,
          label: `token 减 sizeof(struct request) 处的请求不完整（tag=${request.tag} q=${hexOrNull(request.queue)}）`,
        };
      }
      return {
        claimed: true,
        label: `head=${head} token=${hex(token)} 已用环里还没取走=`
          + `${(vq.usedIdx - vq.lastUsedIdx) & 0xffff} 笔`,
        value: { vqAddress, head, token, requestAddress, usedSlot, usedId, outstanding },
      };
    },
  });
  evidence.stop4 = {
    symbol: 'detach_buf_split',
    failed: claim4.failed,
    attempts: claim4.attempts,
    stops: claim4.stops,
  };
  if (claim4.failed) {
    throw new Error(`没有等到 lab-write 在 detach_buf_split 上回收刚写完的那一笔（试了 ${claim4.attempts.length} 次）；`
      + `串口尾部=${await terminalTailOf(app, ctx.base)}`);
  }
  const frame4 = claim4.frame;
  const view4 = viewFor(frame4);
  const vq4 = await readVirtqueue(view4, layout, claim4.value.vqAddress);
  const owners4 = await readDescriptorOwners(view4, layout, vq4);
  const token4 = claim4.value.token;
  const tokenLookup4 = lookupToken(owners4, token4);
  const trace4 = await traceRequest(view4, layout, claim4.value.requestAddress, { readTags: true, readBios: true });
  const chain4 = await walkDescriptorChain(view4, layout, vq4, claim4.value.head);
  const task4 = await describeStoppedTask(captureFor(frame4), ctx.percpuHotLink, ctx.taskOffsets);
  const reg4 = {
    rdi: generalRegister(frame4.cpu, 'rdi'),
    rsi: generalRegister(frame4.cpu, 'rsi'),
    rip: generalRegister(frame4.cpu, 'rip'),
  };
  const segments4 = chain4.indirect ? chain4.indirectDescriptors : chain4.descriptors;
  const expectedSegments4 = trace4.pdu === null ? null : 1 + trace4.pdu.sgNents + 1;
  const tokenOnRing4 = (owners4.owners[claim4.value.head] ?? null)?.token ?? null;
  evidence.stop4.frame = {
    frameId: frame4.frameId,
    task: task4,
    registers: { rdi: hexOrNull(reg4.rdi), rsi: hexOrNull(reg4.rsi), rip: hexOrNull(reg4.rip) },
    window: {
      head: claim4.value.head,
      headFromRsi: reg4.rsi === null ? null : Number(reg4.rsi),
      token: hex(token4),
      request: hexOrNull(claim4.value.requestAddress),
      pdu: hexOrNull(trace4.pdu === null ? null : trace4.pdu.address),
      availIdx: vq4.availIdx,
      usedIdx: vq4.usedIdx,
      lastUsedIdx: vq4.lastUsedIdx,
      outstanding: (vq4.availIdx - vq4.usedIdx) & 0xffff,
      notYetConsumed: (vq4.usedIdx - vq4.lastUsedIdx) & 0xffff,
      usedSlot: claim4.value.usedSlot,
      usedRingId: claim4.value.usedId,
      tokenOnRing: tokenOnRing4 === null ? null : hex(tokenOnRing4),
      requestStateName: trace4.request.stateName,
      lifecycle: trace4.lifecycle,
      chainSegments: segments4.length,
      expectedSegments: expectedSegments4,
      indirect: chain4.indirect,
      vqAddressIsRdi: reg4.rdi === vq4.address,
    },
  };
  check(
    'T07f-B4a 停点 4 的窗口是真的"设备写完、驱动还没回收"：`detach_buf_split(vq, head, ctx)` 的 `$rdi` 就是 '
      + '`vring_virtqueue`（`struct virtqueue vq` 是它第一个成员，两者同址），`$rsi` = 描述符头下标；'
      + '此刻 `desc_state[head].data` 还挂着那个 token、两个公开计数器已经相等（设备侧没有未完成的），'
      + '而 `used->ring[last_used_idx & (num-1)].id` 正好就是这个 head —— 驱动正要取走的正是这一笔。'
      + '注意 `rq->state` 这时还是 `MQ_RQ_IN_FLIGHT`：`virtblk_done()` 是**先**取回描述符（内含 detach）、'
      + '**后**调 `blk_mq_complete_request()`，"设备干完了"与"块层标记完成"不是同一瞬间；'
      + '只看 `rq->state` 会把这一态判错，所以生命周期由 token + 两个计数器 + 已用环三方共同定',
    reg4.rdi === vq4.address && reg4.rsi === BigInt(claim4.value.head)
      && tokenLookup4.unique === true && tokenLookup4.heads.length === 1
      && tokenLookup4.heads[0] === claim4.value.head
      && ((vq4.availIdx - vq4.usedIdx) & 0xffff) === 0
      && claim4.value.usedId === claim4.value.head
      && ((vq4.usedIdx - vq4.lastUsedIdx) & 0xffff) >= 1
      && trace4.request.pduAddress === token4
      && trace4.request.stateName === 'MQ_RQ_IN_FLIGHT'
      && trace4.lifecycle === 'completed-on-device',
    `rdi=${hexOrNull(reg4.rdi)} vq=${hex(vq4.address)} rsi=${String(reg4.rsi)} head=${claim4.value.head}；`
      + `avail->idx=${vq4.availIdx} used->idx=${vq4.usedIdx} last_used_idx=${vq4.lastUsedIdx}`
      + `（已用环里还没取走 ${(vq4.usedIdx - vq4.lastUsedIdx) & 0xffff} 笔）`
      + ` used->ring[${claim4.value.usedSlot}].id=${claim4.value.usedId}；`
      + `token=${hex(token4)} 唯一=${tokenLookup4.unique} heads=[${tokenLookup4.heads.join(',')}]`
      + `（desc_state[${claim4.value.head}].data=${tokenOnRing4 === null ? '空' : hex(tokenOnRing4)}）；`
      + `rq->pdu=${hex(trace4.request.pduAddress)} rq->state=${trace4.request.stateName}；`
      + `lifecycle=${trace4.lifecycle}`,
  );
  check(
    'T07f-B4c 描述符链的段数与私有区算出来的一致：`virtblk_add_req()` 把 sg 表摊成 '
      + '`1（请求头）+ sg_table.nents（数据段）+ 1（状态）`段，不依赖任何地址换算 —— '
      + '这是"环上这条链就是这一笔 I/O"的第二条独立证据（第一条是 token）；'
      + '链上有环或越界都说明这条关联不可信，必须报错而不是挑一段用',
    expectedSegments4 !== null && segments4.length === expectedSegments4 && chain4.violations.length === 0,
    `链上 ${segments4.length} 段（间接=${chain4.indirect}），按私有区算 ${expectedSegments4} 段`
      + `（sg_table.nents=${trace4.pdu === null ? '（私有区没读到）' : trace4.pdu.sgNents}）；`
      + `链上总长=${chain4.totalLength} 字节，请求区间=扇区 ${trace4.request.sector}..${trace4.request.sectorEnd}；`
      + `链的异常=${chain4.violations.join('；') || '无'}`,
  );

  log('停点 4 的参照：GDB 用自己的 DWARF 把这一笔的请求 / 私有区 / 队列与两个公开计数器重读一遍 ...');
  const ref4 = await runReference(ctx.live, 'stop4', {
    request: claim4.value.requestAddress,
    pdu: token4,
    vq: vq4.address,
  });
  if (!ref4.ok) throw new Error(`停点 4 的参照实现失败了：${ref4.error}`);
  const ref4Data = ref4.data;
  const requestCmp4 = comparePaths(trace4.request, ref4Data.request ?? {}, REQUEST_PATHS);
  const opfCmp4 = compareOpf(trace4.request, ref4Data.request ?? {});
  const pduCmp4 = comparePaths(trace4.pdu ?? {}, ref4Data.pdu ?? {}, PDU_PATHS);
  const vqCmp4 = comparePaths(trace4.vq ?? {}, ref4Data.vq ?? {}, VQ_PATHS);
  const ownerCount4 = {
    ours: { slots: owners4.owners.length, occupied: owners4.occupied, distinctTokens: owners4.distinctTokens },
    theirs: {
      slots: ref4Data.owners?.amount ?? null,
      occupied: ref4Data.owners?.occupied ?? null,
      distinctTokens: ref4Data.owners?.distinctTokens ?? null,
    },
  };
  const ownerCountOk4 = ownerCount4.theirs.slots === ownerCount4.ours.slots
    && ownerCount4.theirs.occupied === ownerCount4.ours.occupied
    && ownerCount4.theirs.distinctTokens === ownerCount4.ours.distinctTokens;
  const refUsed4 = (ref4Data.usedRing?.elems ?? [])[0] ?? null;
  const refLookup4 = ref4Data.tokenLookup ?? null;
  const comparisons4 = [requestCmp4, opfCmp4, pduCmp4, vqCmp4];
  evidence.stop4.reference = {
    ok: ref4.ok,
    stop: ref4Data.stop,
    registers: ref4Data.registers,
    comparisons: { request: requestCmp4, requestOpf: opfCmp4, pdu: pduCmp4, vq: vqCmp4 },
    ownerCount: ownerCount4,
    ownerCountOk: ownerCountOk4,
    lifecycle: { ours: trace4.lifecycle, theirs: ref4Data.lifecycle?.phase ?? null },
    tokenLookup: { ours: tokenLookup4, theirs: refLookup4 },
    usedRing: {
      ours: { slot: claim4.value.usedSlot, id: claim4.value.usedId },
      oursUsedIdx: vq4.usedIdx,
      oursLastUsedIdx: vq4.lastUsedIdx,
      referenceIdx: ref4Data.usedRing?.idx ?? null,
      referenceFirst: refUsed4,
    },
    segmentReconciliation: ref4Data.segmentReconciliation ?? null,
    ambiguities: ref4Data.ambiguities,
    notes: ref4Data.notes,
  };
  check(
    'T07f-B4d 停点 4 两侧独立判读一致：`request`（23 项 + 操作码三件套）、请求私有区（13 项）、'
      + '`virtqueue`（29 项）逐字段对上；`desc_state` 的槽数 / 占用数 / 不同 token 数与 GDB 自己数的一致；'
      + '"设备写完、还没回收"这个阶段两边各自实现分别判出来的是同一个；'
      + 'GDB 从它自己读到的 `used->idx` 往回数第一个元素，就是我们 `$rsi` 那个 head —— '
      + '这是同一个窗口的第三条独立证据',
    comparisons4.every((entry) => entry.mismatches.length === 0 && entry.absent.length === 0)
      && ownerCountOk4
      && ref4Data.lifecycle?.phase === trace4.lifecycle
      && refLookup4 !== null && refLookup4.unique === true
      && (refLookup4.heads ?? [])[0] === claim4.value.head
      && refUsed4 !== null && Number(refUsed4.id) === claim4.value.head
      && String(ref4Data.stop?.symbolLine ?? '').includes('detach_buf_split'),
    `一致项数=${comparisons4.reduce((sum, entry) => sum + entry.compared.length, 0)}；`
      + `不一致=${comparisons4.flatMap((entry) => entry.mismatches).join('；') || '无'}；`
      + `两侧都没有的路径=${comparisons4.flatMap((entry) => entry.absent).join('、') || '无'}；`
      + `desc_state 槽数 我方=${ownerCount4.ours.slots} 参照=${ownerCount4.theirs.slots}`
      + `（占用 ${ownerCount4.ours.occupied}/${ownerCount4.theirs.occupied}）；`
      + `lifecycle 我方=${trace4.lifecycle} 参照=${ref4Data.lifecycle?.phase}；`
      + `参照 usedRing.idx=${ref4Data.usedRing?.idx} 第一个元素 id=${refUsed4?.id}`
      + ` vs 我方 head=${claim4.value.head}；参照停点=${ref4Data.stop?.symbolLine ?? '（没读到）'}`,
  );

  await retire(claim4, evidence.stop4);

  /* ---------------- B5：收尾、预算与"这台 observer 就是构建锁里那台" ---------------- */

  log('B5：暂停客体、留一份串口尾巴、核对整轮确实跑在构建锁里记着的那台 QEMU observer 上 ...');
  const paused4 = await cmd('pause');
  const tail4 = await termText();
  const lockPath = path.join(ROOT, 'instrumentation/qemu-observer/build.lock.json');
  let buildLock = null;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const binaryPath = typeof lock?.binary?.path === 'string' ? path.join(ROOT, lock.binary.path) : null;
    const actualSha = binaryPath !== null && fs.existsSync(binaryPath)
      ? crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex')
      : null;
    buildLock = {
      schema: lock?.schema ?? null,
      qemuVersion: lock?.qemuVersion ?? null,
      targets: lock?.targets ?? null,
      binaryPath,
      builtAt: lock?.binary?.builtAt ?? null,
      recordedSha256: lock?.binary?.sha256 ?? null,
      actualSha256: actualSha,
      matches: actualSha !== null && actualSha === (lock?.binary?.sha256 ?? null),
    };
  } catch (error) {
    buildLock = { error: error.message };
  }
  evidence.finish = {
    pauseStatus: paused4.status,
    terminalTail: tail4.slice(-400),
    stops: ctx.live.frames.length,
    maxStops: MAX_STOPS,
    claimBudgetMs: CLAIM_BUDGET_MS,
    buildLock,
  };
  check(
    'T07f-B5a 整轮跑的是构建锁里记着的那台 QEMU observer：`build.lock.json` 里的 sha256 与磁盘上那个'
      + '二进制现算的散列逐位相同。观测器版本错了，"设备侧看得到什么"这件事本身就不成立 —— '
      + '所以这条不是形式检查，而是前面所有设备侧判据的适用范围声明',
    buildLock !== null && buildLock.matches === true,
    buildLock === null
      ? '构建锁没读到'
      : `记录=${String(buildLock.recordedSha256).slice(0, 16)}… 实际=${String(buildLock.actualSha256).slice(0, 16)}…`
        + `（QEMU ${buildLock.qemuVersion ?? '?'}，${buildLock.binaryPath ?? '?'}，构建于 ${buildLock.builtAt ?? '?'}）`,
  );
  check(
    'T07f-B5b 整轮的停点数量在预算内，而且客体最后是被我们主动按住的：`MAX_STOPS` 是这次验收允许记下的'
      + '最多帧数，超了说明有断点没摘干净、把不相干的调用也停下来了（那会让后面所有"停点"失去意义）',
    paused4.status === 200 && ctx.live.frames.length > 0 && ctx.live.frames.length <= MAX_STOPS,
    `pause=${paused4.status}；帧数=${ctx.live.frames.length} 预算=${MAX_STOPS}；`
      + `串口尾巴=${JSON.stringify(tail4.slice(-120))}`,
  );
}

/* --------------------------------------------------------------------------
 * 入口
 * ------------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const startedAt = new Date();
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t07f-evidence/1', startedAt: startedAt.toISOString() };
  const ctx = {
    app,
    registry,
    evidence,
    layout: null,
    api: null,
    session: null,
    live: null,
    base: null,
    seq: 0,
    symbols: null,
    sizes: null,
    percpuHotLink: null,
    taskOffsets: null,
    vmemmap: null,
  };

  try {
    if (!fs.existsSync(LAYOUT_PATH)) throw new Error(`找不到布局产物 ${LAYOUT_PATH}`);
    if (!fs.existsSync(VMLINUX)) throw new Error(`找不到 vmlinux ${VMLINUX}`);
    ctx.layout = KernelLayout.load(LAYOUT_PATH, { vmlinux: VMLINUX });
    evidence.layoutArtifact = {
      file: path.basename(LAYOUT_PATH),
      linuxRelease: ctx.layout.linuxRelease,
      buildId: ctx.layout.buildId,
      sha256: ctx.layout.sha256,
    };
    const parsed = parseReadelfSymbols(execFileSync('readelf', ['-sW', VMLINUX], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    }));
    ctx.symbols = parsed.addresses;
    ctx.sizes = parsed.sizes;
    evidence.readelf = { symbols: ctx.symbols.size, duplicates: parsed.duplicates };

    // 解析器走"服务里的入口"，不是脚本自己另拷一份实现：A 段那批常量/契约检查要拿到的
    // 就是服务与前端实际会用的那几个导出。
    ctx.api = await import('../packages/linux-decoder/index.ts');

    await liveSection(ctx);
  } catch (error) {
    check('T07f 脚本异常', false, error.message);
    evidence.error = { message: error.message, stack: String(error.stack).slice(0, 2000) };
  } finally {
    if (ctx.session) {
      const closedByUs = await call(app, 'DELETE', `/api/sessions/${ctx.session.id}`);
      await sleep(1500);
      const leftover = countSessionProcesses(ctx.session.id);
      const afterClose = await call(app, 'GET', `${ctx.base}/memory?address=0x100000&length=16`);
      check(
        'T07f-B5c 会话关闭成功、没有残留 QEMU/GDB 进程，而且关闭后再读客体内存只会得到 '
          + '404 `session-not-found` —— 不把缓存或另一个进程里的旧现场当成结果继续给；'
          + '否则"这个停点上内核里就是这样"这句话就没有边界了',
        closedByUs.status === 200 && closedByUs.body?.closed === true && leftover === 0
          && afterClose.status === 404 && afterClose.body?.error?.code === 'session-not-found',
        `${describe(closedByUs.body)}；残留进程数=${leftover}；`
          + `关闭后再读内存：HTTP ${afterClose.status} ${describe(afterClose.body)}`,
      );
    } else {
      check(
        'T07f-B5c 会话关闭成功、没有残留 QEMU/GDB 进程，而且关闭后拒绝再读客体内存',
        false,
        '会话压根没建起来，无从关闭',
      );
    }
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
