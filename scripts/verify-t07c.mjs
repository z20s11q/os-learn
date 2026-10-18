#!/usr/bin/env node
/**
 * T07c 验收：地址空间解析器（选中 mm / VMA / 页表 / PFN / folio）。
 *
 *   node scripts/verify-t07c.mjs        （约 15–30 分钟，TCG 上要真启动一台 Linux）
 *
 * 这一节要验的是"地址空间"，而地址空间这一层的错误有一个共同特征：**错的结果照样
 * 是个合法值**。`mm_struct` 少读 8 字节，取出来的 `pgd` 会指向旁边一个真实存在的指针；
 * `struct page` 的步长写成 48 而不是 64，算出来的"页"落在另一个页的中间，`page_type`
 * 读出来仍是个像模像样的数；PTE 位表错一位，权限面板会安静地显示相反的权限。
 * 所以这里的每一条断言都要靠**另一套独立机制**读同一份事实，而不是自己和自己比。
 *
 * 本脚本用了六条互不相干的通道：
 *   1. 解析器（`packages/linux-decoder/objects/*`）：布局来自 T07a 的 DWARF 产物，
 *      字节来自服务的线性地址读。
 *   2. GDB 侧参照（`scripts/t07c-gdb-reference.py`）：类型/偏移/`sizeof` 由 **GDB 自己的
 *      DWARF 解释**给出，`current` 走 **`%gs` 基址**而不是 `__per_cpu_offset[0]`，
 *      页表遍历**自己重写**一遍，pageflags 的位号取自 GDB 里的 `enum pageflags`。
 *      特别是 `struct mem_section` 不在我们的布局清单里，GDB 却有完整定义 ——
 *      vmemmap 基址于是有一份"用真正的 `sizeof(struct mem_section)` 算出来"的对照值。
 *   3. 服务自己的地址翻译（`GET /memory?mode=translate`，按该采集代的 CR3 走页表）。
 *   4. QEMU 的 HMP `gva2gpa`（宿主机侧的第三种翻译实现）。
 *   5. 内核源码现场重解析：`include/linux/mm.h` 的 `VM_*`、`arch/x86/include/asm/
 *      pgtable_types.h` 的 `_PAGE_BIT_*`、`include/linux/pagemap.h` 的
 *      `linear_page_index()`、`include/linux/page-flags.h` 的 `enum pagetype` ——
 *      全部现读现比，不抄一份常量进脚本。
 *   6. 客体自报：`lab-memory`/`lab-cow` 自己 `printf` 出来的 pid 与 `mapping=%p` 地址、
 *      写进去的字节（`'A'`/`'B'`/`'C'`），以及内核对同一件事的记账（`mm_struct`
 *      里 total_vm/exec_vm/stack_vm/data_vm/map_count 五项）。
 *
 * 四个停点（都在真实 lab 程序上，全部用**软件断点**，理由同 T07b：内核在任务切换时
 * 会按任务调试状态重写 DR0/DR7，硬件断点会静默失效）：
 *   停点一 `ext2_file_read_iter` + current.comm == lab-read
 *         → mm、VMA 树、页表（含文件映射页）、PFN→folio、vmemmap、CR3 页类型
 *   停点二 `__x64_sys_munmap` + current.comm == lab-memory
 *         → 匿名页：mapping 藏在 anon_vma、index 等于虚拟页号、物理字节 'A'/'B'
 *   停点三 `do_exit` + current 是 lab-cow 的**子进程**
 *         → COW 之后子进程的页：字节 'C'、refcount 1、mapping 指向子进程自己的 anon_vma
 *   停点四 `__x64_sys_munmap` + current 是 lab-cow 的**父进程**
 *         → 同一个虚拟地址在父进程里仍是 'A'、PFN 与子进程不同、refcount 1
 *
 * 为什么停点四必须和停点三配成一对：COW 的全部证据就是"同一个虚拟地址、两个进程、
 * 两个不同的物理页、各写各的字节"。只看一边任何一条都能被"其实没有 COW"解释通过。
 *
 * 为什么 `do_exit` 是安全的停点（`kernel/exit.c` 逐行核对过）：`exit_mm()` 是 `do_exit()`
 * 函数体里的第 941 行，在它之前 current 的 `mm` 还挂在任务上。断点落在函数第一条指令，
 * 所以停下来的那一刻地址空间仍然可解析 —— 若停在 `exit_mm()` 之后就只能看到 `mm == NULL`。
 *
 * 检查项：
 *   V1  布局产物与现场 vmlinux 绑定（build ID + sha256 现场重算）；必需类型一个不缺；
 *       客体内核 release 与产物自述一致；readelf / 服务 / 布局三方的符号事实一致
 *   V2  `VM_*` 位表与 `include/linux/mm.h` 现场重解析一致（含依赖配置的位按 `.config` 判定）
 *   V3  `_PAGE_BIT_*` 与 `arch/x86/include/asm/pgtable_types.h` 现场一致；
 *       `__PHYSICAL_MASK_SHIFT` 与物理地址掩码一致；`enum pagetype` 与 page-flags.h 一致
 *   V4  current/mm 三源一致（`__per_cpu_offset[0]` vs GDB 的 `%gs`）；`mm_struct` 逐字段
 *       与 GDB 一致；直映射偏移过形状检查（512 GiB 对齐 / 内核半区 / 等于编译期常量）
 *   V5  VMA 树与 GDB 一致（根形态、节点数、槽区间集合、空槽数），槽区间不变量
 *       `[vm_start, vm_end-1]` 全部成立，逐条 VMA 的 12 个字段与 GDB 相同
 *   V6  记账五项对账：遍历重算的 total/exec/stack/data（页）与 mm_struct 里的数字、
 *       以及 GDB 用自己读到的 VMA 重算的数字，三方相同
 *   V7  VMA 权限串与 lab 程序 ELF 的 program header 对照（每个 PT_LOAD 都能找到覆盖
 *       它的 VMA，权限位一致，`vm_pgoff << 12` 等于该段的文件偏移）
 *   V8  同一个线性地址的页表遍历四方一致：我们 / GDB 参照 / 服务 translate / QEMU
 *       `gva2gpa`（逐级条目地址、原始值、目标物理地址、最终物理地址、页大小）
 *   V9  PFN→`struct page` 的 vmemmap 基址两路一致（我们按 16 字节推 vs GDB 用真
 *       `sizeof(struct mem_section)`），且与编译期常量相同；CR3 所在页框的类型是
 *       `PGTY_table`（页表页）
 *   V10 文件页 folio：`mapping == file->f_mapping`、`index == linear_page_index()`、
 *       不是匿名页
 *   V11 匿名页 folio：`mapping - 1 == vma->anon_vma`、`index` 等于虚拟页号、
 *       物理字节就是客体写进去的 'A' 与 'B'
 *   V12 COW：同一虚拟地址在子/父两个进程里 PFN 不同、字节分别是 'C' 与 'A'、
 *       各自 refcount 为 1、各自的 `mapping` 指向各自的 anon_vma
 *   V13 边界：空洞地址不缺页被说成缺页、越界 PFN 被拒、`mm == NULL`/`vma == 0`
 *       如实报错、遍历上限真的截断
 *   V14 KernelVma/KernelMm/KernelFolio → 契约字段（Hex 字符串、空值保留 null）
 *   V15 会话关闭且无残留 QEMU/GDB 进程
 *
 * 结果写入 `artifacts/verify/t07c.json` 与 `artifacts/verify/t07c.log`。
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
  KernelLayout,
  KernelMemoryView,
  PAGE_FLAG_NAMES,
  PAGE_OFFSET_BASE_L4,
  PAGE_SHIFT,
  PAGE_SIZE,
  PAGE_TYPE_NAMES,
  PHYSICAL_ADDRESS_MASK,
  PTE_BITS,
  ULONG_MAX,
  VMA_FLAG_BITS,
  VM_BITS,
  VMEMMAP_BASE_L4,
  accountVmas,
  derivePageOffsetBase,
  findVmaForAddress,
  pageAddressForPfn,
  readFolioForPfn,
  readMm,
  readPhysical,
  readVma,
  readVmas,
  resolveVmemmapBase,
  selectVmaByIndex,
  slotRangeOf,
  structPageSizeOf,
  toAddressSpaceRef,
  toFolioRef,
  toVmaRef,
  vmaPermissionString,
  walkMapleTree,
  walkPageTable,
} from '../packages/linux-decoder/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VMLINUX = path.join(ROOT, 'artifacts/build/linux/vmlinux');
const LAYOUT_PATH = path.join(ROOT, 'artifacts/layout/linux-6.12.112-observatory-f5e5edc1c572.json');
const REFERENCE_PY = path.join(ROOT, 'scripts/t07c-gdb-reference.py');
const KERNEL_CONFIG = path.join(ROOT, 'labs/linux-x86_64/kernel.config');
const MM_H = path.join(ROOT, 'src/linux-6.12.112/include/linux/mm.h');
const PGTABLE_TYPES_H = path.join(ROOT, 'src/linux-6.12.112/arch/x86/include/asm/pgtable_types.h');
const PAGE_64_TYPES_H = path.join(ROOT, 'src/linux-6.12.112/arch/x86/include/asm/page_64_types.h');
const PAGE_FLAGS_H = path.join(ROOT, 'src/linux-6.12.112/include/linux/page-flags.h');
const PAGEMAP_H = path.join(ROOT, 'src/linux-6.12.112/include/linux/pagemap.h');
/** x86_64 顶层 pgd 的分配代码：`_pgd_alloc()` 在这里，V9b 要现场确认它不走 `pagetable_pte_ctor()`。 */
const X86_PGTABLE_C = path.join(ROOT, 'src/linux-6.12.112/arch/x86/mm/pgtable.c');
/** `pagetable_pte_ctor()` 在这里，V9b 要现场确认它确实调 `__folio_set_pgtable()`。 */
const LINUX_MM_H = path.join(ROOT, 'src/linux-6.12.112/include/linux/mm.h');
/** 客体里真正跑的这个 ELF；V7 拿它的 program header 与 VMA 权限对账。 */
const LAB_READ_ELF = path.join(ROOT, 'artifacts/build/rootfs/bin/lab-read');
/**
 * 客体真正的根盘。initramfs 里的 `/init` 只做 `mount -t ext2 /dev/vda /newroot` 再
 * `switch_root`，所以客体执行的 `/bin/lab-read`（指向 `/bin/lab` 的符号链接）来自这个镜像，
 * 而不是构建目录 `artifacts/build/rootfs/` —— V7 要用 debugfs 从镜像里取出那一份当对照。
 */
const ROOTFS_IMG = path.join(ROOT, 'artifacts/rootfs.img');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t07c.json');
const EVIDENCE_LOG = path.join(ROOT, 'artifacts/verify/t07c.log');

const PROMPT = /linux-lab:[^\r\n]*# /;
/** 认领别人的停点时最多重新 continue 多少次、最多等多久。 */
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
 * 读取 JSON，但**不让大整数掉进双精度陷阱**（理由与实现同 T07b）。
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
 * 调用方传入的命令所以都写成 `echo READ""Y-DONE-$?` 这种**成对的空引号**形式：回显里是
 * `READ""Y-DONE-`，而真正的输出是 `READY-DONE-0`。引号必须成对，否则 shell 会停在 PS2
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
 *
 * 为什么每次尝试用带序号的不同标记：判断"这次尝试的命令是不是跑完了"要靠串口标记，
 * 共用标记的话第一次的残留会让后面每一次都被误判成"已经跑完"，于是永远逮不到。
 */
async function claimWithRetry(options) {
  const {
    app, base, live, cmd, symbol, module: stageId = 'linux-kernel',
    commandFor, markerFor, inspect,
    maxAttempts = 8, perFrameWaitMs = 10000, settleMs = 4000, attemptBudgetMs = 60000,
  } = options;
  const attempts = [];
  let breakpoint = null;
  /**
   * 每一次读数都带上四组数字：
   *   - `frames`：服务端会话里攒下的帧数（这才是 `waitForNextFrame` 看的东西）；
   *   - `signals`：**所有**停止信号的计数（GDB 与 QMP 两个来源，同一次停止只算一次），
   *     它涨而 `frames` 不涨，说明"机器确实停了，但帧没被采集"；
   *   - `qmpStops`：QMP 层看到的 STOP 事件数（第三种口径，用来判断是不是虚拟机根本没停）；
   *   - `pendingCapture`：服务端"上一帧的自动采集还没落地"。
   *     这一条很关键：`#signalStop()` 遇到 `pendingCapture` 非空时会**直接跳过**自动采集，
   *     于是断点命中了也永远不出帧。区分"断点没命中"与"命中了却被吞掉"就靠它。
   */
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
    let removeBody = null;
    await cmd('pause');
    if (breakpoint !== null && breakpoint.id !== null) {
      const removed = await cmd('breakpoint.remove', { breakpointId: breakpoint.id });
      removeStatus = removed.status;
      if (removed.status !== 200) removeBody = describe(removed.body);
    }
    const inserted = await cmd('breakpoint.insert', { location: { symbol, module: stageId }, kind: 'software' });
    if (inserted.status !== 200) throw new Error(`在 ${symbol} 下断点失败：${describe(inserted.body)}`);
    breakpoint = inserted.body?.breakpoint ?? null;
    if (breakpoint?.pending === true) {
      // `pending: true` 意味着 GDB 只是挂了个"还没解析出来"的断点：它永远不会触发。
      // 这是最阴的一种失败（HTTP 200、看起来一切正常），所以在当场就喊出来。
      log(`[认领] 警告：${symbol} 的断点 pending=true（地址=${breakpoint.address ?? '未解出'}），它不会触发`);
    }
    const cursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    const tallyBefore = stopTally();
    /**
     * 基线帧号必须在 `continue` **之前**取。为什么：`continue` 之后可能**立刻**停一次 ——
     * 上一次停点把某个进程中断在系统调用中间，它接着跑完、退出，正好撞上新装的断点。
     * 老写法在 `continue` 之后隔 300ms 才取基线，那次立刻发生的停止就被当成"基线帧"吞掉了，
     * 于是后面 `frameId > 基线` 永远不成立，认领循环表现成"一次都没停"，而且机器还留在
     * 那个停点上、串口上递进去的命令也不执行 —— 这正是停点三第一次跑失败时的形态。
     */
    const baselineFrameId = live.frames.at(-1)?.frameId ?? 0;
    // 递命令前先等"上一帧的自动采集"落地：`#signalStop()` 在 `pendingCapture` 非空时
    // 会直接跳过自动采集，断点命中了也不会出帧。正常情况这里几乎立刻返回。
    for (let waited = 0; waited < 50 && live.pendingCapture; waited += 1) await sleep(200);
    // `continue` 自己也可能因为帧号过期被判 409：一样刷新帧号重试，否则机器留在停止态，
    // 后面递进去的命令不会执行，表现成"命令没跑、也没有停点"。
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
    /**
     * 递命令必须**重试**，因为服务端要求 `expectedFrameId` 正好等于当前最新帧号
     * （`checkFreshness()` 里 `command.expectedFrameId !== latest` 就判 409 FRAME_MISMATCH）。
     * 而"刚 `continue` 就立刻停一次"恰好会让帧号变掉 —— 老写法一次不成就把命令**静默丢掉**
     * （响应没检查），于是客体根本收不到命令、串口上永远等不到标记，表现成"命令没跑、也没停点"。
     * 每次重试都用新的 requestId（失败的那次不会被幂等缓存），并在被拒时先放跑机器。
     */
    let inputStatus = null;
    let inputBody = null;
    for (let tries = 1; tries <= 5 && inputStatus !== 200; tries += 1) {
      const posted = await call(app, 'POST', `${base}/commands`, {
        requestId: `t07c-claim-${++claimSeq}-${attempt}-${symbol}`,
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
        trace.push(`${frame.frameId}@${Date.now() - startedAt}ms:${hit.label}`
          + `${frame.stop?.reason === 'breakpoint' ? '' : `[stop=${frame.stop?.reason ?? '未给'}]`}`);
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
      attempt,
      symbol,
      stopsSeen,
      claimed: claimed !== null,
      markerSeen,
      trace: trace.slice(-60),
      tally: { before: tallyBefore, after: stopTally() },
      breakpoint: breakpoint === null ? null : {
        id: breakpoint.id,
        spec: breakpoint.spec,
        hardware: breakpoint.hardware,
        address: breakpoint.address,
        pending: breakpoint.pending,
      },
      insertedStatus: inserted.status,
      continueStatus,
      continueBody,
      inputStatus,
      inputBody,
      baselineFrameId,
      removeStatus,
      removeBody,
      budgetMs: attemptBudgetMs,
    });
    if (claimed !== null) {
      return { frame: claimed.frame, value: claimed.value, attempts, breakpoint, stops: stopsSeen, failed: false };
    }
    log(`[认领] ${symbol} 第 ${attempt} 次尝试没逮到（停点 ${stopsSeen} 次：${trace.slice(-8).join(' ') || '一次都没停'}；`
      + `命令跑完=${markerSeen} continue=${continueStatus} 递命令=${inputStatus} `
      + `帧=${tallyBefore.frames}→${live.frames.length} `
      + `停止信号=${tallyBefore.signals}→${live.stopSignals?.count ?? null} `
      + `断点=${breakpoint === null ? '缺' : `#${breakpoint.id}@${breakpoint.address} pending=${breakpoint.pending}`} `
      + `卸旧断点=${removeStatus ?? '未做'} 采集卡住=${Boolean(live.pendingCapture)}），重装断点再试`);
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

/**
 * 从 `readelf -lW` 输出里取 PT_LOAD 段（V7 拿它与 VMA 权限对账）。
 *
 * 这里有两个必须踩准的地方：
 *
 * 1. **flags 列与其余列在同一行**（`LOAD  0x0  0x400000 ... R E 0x200000`）。早期写法从
 *    下一行读 flags，读到的其实是下一段的类型，于是"权限对账"整条断言都在比垃圾。
 * 2. **不能用空白切词**：权限列是三个字符宽（"R E" / "RW " / "R  "），切词会把 `R E`
 *    变成两个 token、把列号全部错位一格。所以用整行正则、把三字符的权限列当作一个字段。
 *    物理地址列在少数 readelf 版本下会省略，两种列宽都收。
 */
function parseElfLoadSegments(text) {
  const segments = [];
  const withPhys = /^\s*LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+([RWE ]{3})\s+(0x[0-9a-f]+)\s*$/;
  const withoutPhys = /^\s*LOAD\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+([RWE ]{3})\s+(0x[0-9a-f]+)\s*$/;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!/^\s*LOAD\s/.test(line)) continue;
    let offset;
    let vaddr;
    let filesz;
    let memsz;
    let flags;
    const match = withPhys.exec(line);
    if (match !== null) {
      [, offset, vaddr, , filesz, memsz, flags] = match;
    } else {
      const fallback = withoutPhys.exec(line);
      if (fallback === null) continue;
      [, offset, vaddr, filesz, memsz, flags] = fallback;
    }
    segments.push({
      offset: BigInt(offset),
      vaddr: BigInt(vaddr),
      filesz: BigInt(filesz),
      memsz: BigInt(memsz),
      flags: flags.trim(),
    });
  }
  return segments;
}

/** 从 `readelf -hW` 输出里取 Build ID（ELF 头部信息，与符号表无关）。 */
function parseBuildId(text) {
  const match = /Build ID:\s*([0-9a-f]+)/.exec(text);
  return match ? match[1] : null;
}

/* --------------------------------------------------------------------------
 * ReadOnlyCapture：把服务的线性地址读包装成解析器的唯一输入
 * ------------------------------------------------------------------------ */

/**
 * 三个刻意的取舍（同 T07b）：
 * - 走 `memory.read` 命令而不是 `GET /memory`：前者经过控制队列，与 continue/pause 串行，
 *   不会出现"VM 已经继续跑了、读到的却是新内存"这种静默错配。
 * - 读不到就抛 `CaptureReadError`，绝不返回填充字节。内核结构里 0 是合法内容
 *   （`mm == NULL` 是内核线程与僵尸的正常形态）。
 * - 证据绑定到本次停点的 `captureId`。
 */
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
      requestId: `t07c-capture-${this.attribution.frameId}-${++captureReadSeq}`,
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
 * 用最小的两次读取回答"现在是谁"（认领停点用；走 `KernelMemoryView` 会按页读 4 KiB）。
 */
async function quickTask(capture, percpuHotLink, commOffset) {
  const offsetTable = capture.symbolAddress('__per_cpu_offset');
  if (offsetTable === null || percpuHotLink === null) return null;
  const percpuBase = littleEndian(await capture.readVirtual(offsetTable, 8));
  const task = littleEndian(await capture.readVirtual(percpuBase + percpuHotLink, 8));
  if (task === 0n) return { taskAddress: 0n, comm: null };
  const commBytes = await capture.readVirtual(task + BigInt(commOffset), 16);
  const zero = commBytes.indexOf(0);
  return {
    taskAddress: task,
    comm: Buffer.from(zero < 0 ? commBytes : commBytes.subarray(0, zero)).toString('utf8'),
  };
}

/**
 * 认领失败时唯一要回答的问题是"现在停在谁身上"，只读 `comm` 不够：`fork` 出来的孩子在
 * `execve` 装载 ELF 期间 `comm` 还是父进程的名字，直到 `begin_new_exec()` 才改。
 * 把 `pid/tgid/mm/父进程` 一起读出来才分得清"父进程自己"和"还没换名字的孩子"。
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
    taskAddress: task,
    label: `${comm}#pid${pid}/tgid${tgid} mm=${mm === 0n ? '0' : hex(mm)} ${parentText}`,
  };
}

/* --------------------------------------------------------------------------
 * GDB 侧参照
 * ------------------------------------------------------------------------ */

/**
 * 在**当前停点**跑一遍 GDB 侧参照实现，把结果 JSON 读回来。
 *
 * 走 `source` 而不是让脚本自己读内存：参照实现必须用 GDB 自己的 DWARF 解释与 `%gs` 基址。
 * 时间上限给得很大 —— 逐节点读 maple 树 + 逐字段读 VMA，在 TCG + 远程 gdbstub 上要几十秒，
 * 而 MI 适配器默认只有 20 秒。读回来时必须走 `parseBigJson`。
 */
async function runReference(live, label, args) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `t07c-ref-${label}-`));
  const outPath = path.join(dir, 'reference.json');
  const scriptPath = path.join(dir, 'reference.py');
  try {
    const source = fs.readFileSync(REFERENCE_PY, 'utf8')
      .replace('__OUT_PATH__', JSON.stringify(outPath))
      .replace('__VA__', String(args.va))
      .replace('__VA2__', String(args.va2 ?? 0n))
      .replace('__PFN__', String(args.pfn ?? 0n))
      .replace('__MM__', String(args.mm ?? 0n))
      .replace('__CR3__', String(args.cr3 ?? 0n));
    fs.writeFileSync(scriptPath, source);
    const record = await live.mi.console(`source ${scriptPath}`, { timeoutMs: 900000 });
    if (!fs.existsSync(outPath)) {
      const stream = String(record?.stream ?? '');
      fs.writeFileSync(path.join(path.dirname(EVIDENCE), `t07c-reference-${label}-failed.txt`), stream);
      return { ok: false, error: '参照脚本没有写出结果文件', stream: stream.slice(-800) };
    }
    const data = parseBigJson(fs.readFileSync(outPath, 'utf8'));
    fs.writeFileSync(
      path.join(path.dirname(EVIDENCE), `t07c-reference-${label}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------------------
 * 第二条/第三条翻译通道：服务的 translate 与 QEMU 的 gva2gpa
 * ------------------------------------------------------------------------ */

/** HMP `gva2gpa` 的参数是 `addr:l`（有符号 64 位），内核高半区地址要按有符号写。 */
function toSigned64(value) {
  const wide = BigInt.asUintN(64, BigInt(value));
  return wide >= 1n << 63n ? wide - (1n << 64n) : wide;
}

function parseGva2gpa(text) {
  const mapped = /gpa:\s*(0x[0-9a-f]+)/i.exec(String(text ?? ''));
  if (mapped) return BigInt(mapped[1]);
  if (/Unmapped/i.test(String(text ?? ''))) return null;
  return undefined;
}

async function serviceTranslate(app, base, address, captureId) {
  const url = `${base}/memory?mode=translate&address=${hex(address)}&captureId=${encodeURIComponent(captureId)}`;
  const response = await call(app, 'GET', url);
  if (response.status !== 200) return { ok: false, error: describe(response.body) };
  return { ok: true, translation: response.body?.translation ?? null, body: response.body };
}

/**
 * 一页匿名页此刻**应该**有几次引用（即 `page->_refcount`）。
 *
 * 这个数是照 Linux 6.12 的源码数出来的，不是猜的：
 * - 每一个把它映射进页表的地方占 1 次。`fork` 时 `copy_present_pte` 会给父子各
 *   加一次（`folio_ref_add`），取消映射时由调用方还回来 —— `__folio_remove_rmap()`
 *   自己只动 `_mapcount`，不动引用计数，所以 `folio_put` 都在调用方
 *   （`zap_pte_range`、`wp_page_copy`）。
 * - **刚建立映射的匿名页还会临时多 1 次**：`folio_add_lru()` 走的是每 CPU 的
 *   待入队批次（`folio_batch_add_and_move` → `__folio_batch_add_and_move()` 里
 *   先 `folio_get(folio)`），要等批次被刷进 LRU（`folio_batch_move_lru()` 末尾的
 *   `folios_put()`）才还掉，而 `PG_lru` 也是那时才置上的。
 *   于是「还没落到 LRU 上」的页比「已经落到 LRU 上」的页**多 1 次引用**。
 *
 * 这条规则正好解释了停点三看到的现象：子进程那页刚因写时复制建好映射、还在批次里
 * （所以没有 `PG_lru`）引用数是 2；父进程那页早就落到 LRU 上了引用数是 1。
 * 拿 `refcount === 1` 当"没被共享"的判据会在"批次还没刷"时误报 —— 那不是错，是时序。
 * 判断"有没有被共享"要看 `_mapcount`（0 表示正好被一个页表项映射）。
 */
function expectedAnonRefcount(folio, mappings) {
  return mappings + (folio.pageFlags.includes('PG_lru') ? 0 : 1);
}

/**
 * 把服务那条通道（`GET /memory?mode=translate`）的结论摘成一小块诊断信息。
 *
 * 为什么不整份存：body 里带着完整逐级 walk 与每条的证据引用，量很大；而"四通道是否一致"
 * 这件事一旦不一致，需要的其实就三样东西 —— 解出来的物理地址、页大小、以及 `fault`
 * （它带 kind/level/detail，会直接说清是哪一级哪一位把它判掉了）。
 */
function summarizeServiceTranslate(service) {
  if (service === null || service === undefined) return { ok: false, error: '未调用' };
  if (service.ok !== true) return { ok: false, error: service.error ?? '未知失败' };
  const translation = service.translation ?? null;
  return {
    ok: true,
    captureId: service.body?.captureId ?? null,
    live: service.body?.live ?? null,
    reader: service.body?.reader ?? null,
    physical: translation?.physical ?? null,
    pageSize: translation?.pageSize ?? null,
    huge: translation?.huge ?? null,
    fault: translation?.fault ?? null,
    walkLength: Array.isArray(translation?.walk) ? translation.walk.length : null,
  };
}

/* --------------------------------------------------------------------------
 * 内核源码现场重解析（第 5 条独立通道）
 * ------------------------------------------------------------------------ */

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
 * 把一个头文件里的数值与别名定义全收下来。
 *
 * 为什么不写成"正则找一次就完事"：`#define` 有数值、`BIT(x)`、以及别名三种形态
 * （`_PAGE_BIT_UFFD_WP _PAGE_BIT_SOFTW2`、`VM_STACK VM_GROWSDOWN`），
 * 而同名在不同配置分支下会出现两次（`_PAGE_BIT_SAVED_DIRTY` 在 x86_64 与 32 位分支里
 * 分别是 SOFTW5 与 SOFTW2）。所以每个名字收**全部**定义，逐个解出来比。
 */
function readDefineTable(text) {
  const values = new Map();
  const aliases = new Map();
  /** 每个名字的定义处上下文：行号、外层条件编译指令栈、是否落在结构体/枚举声明体内。 */
  const contexts = new Map();
  const conditions = [];
  let aggregate = null;
  const push = (map, name, rhs, line) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(rhs);
    if (!contexts.has(name)) contexts.set(name, []);
    contexts.get(name).push({ line, conditions: [...conditions], aggregate });
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.replace(/\/\*.*?\*\//g, '').trim();
    // 只认 `#define`（`#` 与 `define` 之间没有空格）这一种写法，这是**故意的**：
    // 内核里带空格的 `# define X 1` 常成对出现在条件编译的两个分支里
    // （`VM_PKEY_BIT3` 在 `#if CONFIG_ARCH_PKEY_BITS > 3` 的两个分支分别是
    // `VM_HIGH_ARCH_3` 与 `0`），而这张表不带预处理器，两边的取值会被混进一个集合，
    // 于是"配置没开时源码应当给 0"这条规则就会误报。收不到的名字一律当"源码不可见"、
    // 在证据里列出来，而不是猜一个值。
    if (/^#\s*(if|ifdef|ifndef)\b/.test(line)) { conditions.push(raw.trim()); continue; }
    if (/^#\s*(else|elif)\b/.test(line)) {
      // 把 `#else`/`#elif` 并进上一条 `#if*`，证据里就能看出这个定义属于哪个分支。
      if (conditions.length > 0) conditions[conditions.length - 1] = `${conditions[conditions.length - 1]} ${raw.trim()}`;
      continue;
    }
    if (/^#\s*endif\b/.test(line)) { conditions.pop(); continue; }
    const opened = /^(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/.exec(line);
    if (opened) { aggregate = opened[1]; continue; }
    if (/^\}\s*;/.test(line)) { aggregate = null; continue; }
    let match = /^#define\s+([A-Za-z_]\w*)\s+(0x[0-9a-fA-F]+|0|[0-9]+)$/.exec(line);
    if (match) { push(values, match[1], BigInt(match[2]), index + 1); continue; }
    match = /^#define\s+([A-Za-z_]\w*)\s+((?:_BITUL|_BITULL|BIT_ULL|_BIT|BIT|_AC|_AT)\([^)]*\)|[A-Za-z_]\w*)$/.exec(line);
    if (match) { push(aliases, match[1], match[2], index + 1); continue; }
    match = /^#define\s+([A-Za-z_]\w*)\s+\(\s*(?:_AC|_AT)\([^)]*\)\s*<<\s*([A-Za-z_]\w*)\s*\)$/.exec(line);
    if (match) { push(aliases, match[1], `SHIFT(${match[2]})`, index + 1); }
  }
  return { values, aliases, contexts };
}

/**
 * 把一个定义的全部可能取值解出来（处理 `BIT(x)`、`_BITUL(x)`、`SHIFT(x)` 与别名链）。
 *
 * `BIT(31)` 这种**字面量**入参必须特判：内核里 `VM_MERGEABLE` 就是 `BIT(31)`，
 * 而字号宏（`BIT(VM_HIGH_ARCH_BIT_0)`）要走别名链递归。两种都漏掉的话，
 * `VM_MERGEABLE` 会被判成"源码里找不到定义" —— 一个假警报，代价是整条对账失去信任。
 */
function resolveDefineAll(table, name, seen = new Set()) {
  const out = new Set();
  if (seen.has(name)) return out;
  seen.add(name);
  for (const value of table.values.get(name) ?? []) out.add(value);
  for (const rhs of table.aliases.get(name) ?? []) {
    let match = /^(?:_BITUL|_BITULL|BIT_ULL|_BIT|BIT)\(([^)]*)\)$/.exec(rhs);
    if (match) {
      const inner = /^[0-9]+$/.test(match[1]) ? new Set([BigInt(match[1])]) : resolveDefineAll(table, match[1], seen);
      for (const value of inner) out.add(1n << value);
      continue;
    }
    match = /^SHIFT\(([A-Za-z_0-9]+)\)$/.exec(rhs);
    if (match) {
      const inner = resolveDefineAll(table, match[1], seen);
      for (const value of inner) out.add(1n << value);
      continue;
    }
    if (/^[A-Za-z_]\w*$/.test(rhs)) {
      for (const value of resolveDefineAll(table, rhs, seen)) out.add(value);
    }
  }
  return out;
}

/** `enum X { ... }` 里的裸标识符表（跳过注释与条件编译指令行，保留顺序）。 */
function parseEnumMembers(text, enumName) {
  const at = text.indexOf(`enum ${enumName} {`);
  if (at < 0) return [];
  const body = text.slice(at, text.indexOf('\n};', at) + 3);
  const names = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    for (const piece of line.split(',')) {
      const token = piece.trim();
      if (token.length === 0) continue;
      const match = /^([A-Za-z_]\w*)\s*(?:=|$)/.exec(token);
      if (!match) continue;
      names.push(match[1]);
      if (match[1] === '__NR_PAGEFLAGS') return names;
    }
  }
  return names;
}

/** `enum pagetype { PGTY_x = 0xNN, ... }` 的代号表。 */
function parseEnumPagetype(text) {
  const at = text.indexOf('enum pagetype {');
  if (at < 0) return [];
  const body = text.slice(at, text.indexOf('\n};', at) + 3);
  const out = [];
  for (const raw of body.split('\n')) {
    const match = /^\s*(PGTY_\w+)\s*=\s*(0x[0-9a-fA-F]+)\s*,?\s*$/.exec(raw.replace(/\/\*.*?\*\//g, ''));
    if (match) out.push({ name: match[1], code: Number.parseInt(match[2], 16) });
  }
  return out;
}

/**
 * `include/linux/pagemap.h` 的 `linear_page_index()`：把"这个虚拟地址在文件里的第几页"
 * 重解析一遍。函数体必须真的是 `(address - vma->vm_start) >> PAGE_SHIFT` 再加 `vm_pgoff`
 * —— 这正是 V10 用来判"页缓存页的 index 对不对"的公式，抄错一个符号就会把
 * 每个文件页都算到错误的偏移上，而读出来的 `index` 仍是个正常的页号。
 */
function readLinearPageIndexSource(text) {
  const at = text.indexOf('static inline pgoff_t linear_page_index');
  if (at < 0) return null;
  const body = text.slice(at, at + 600);
  return {
    body: body.split('\n').slice(0, 12).join('\n'),
    subtractsVmStart: /address\s*-\s*vma->vm_start/.test(body),
    shiftsByPageShift: />>\s*PAGE_SHIFT/.test(body),
    // 6.12 的原文是两行：`pgoff = (address - vma->vm_start) >> PAGE_SHIFT;` 然后
    // `pgoff += vma->vm_pgoff;`。老写法只认 `+ vma->vm_pgoff`，于是被中间的 `=` 挡住，
    // 把一条完全正确的源码判成"没加 vm_pgoff" —— 这正是 T07c-V10 第一次跑失败的原因。
    addsVmPgoff: /\+\s*=?\s*vma->vm_pgoff/.test(body),
  };
}

/** 用于跨通道比较的小工具：把 `0x…` 或数字统一成 `bigint | null`。 */
function asBig(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'bigint' ? value : BigInt(value);
}

import { dedupedManifest } from '../packages/linux-decoder/index.ts';

/** 客体自己打印的映射地址：`pid=1234 mapping=0x7f...`。 */
function parseGuestMappings(text) {
  const out = new Map();
  for (const match of String(text).matchAll(/pid=(\d+)\s+mapping=(0x[0-9a-f]+)/g)) {
    out.set(Number(match[1]), BigInt(match[2]));
  }
  return out;
}

function parseGuestChildLine(text) {
  const match = /child=(\d+)\s+byte=(.)/.exec(String(text));
  return match ? { pid: Number(match[1]), byte: match[2] } : null;
}

function parseGuestParentLine(text) {
  const match = /parent=(\d+)\s+byte=(.)/.exec(String(text));
  return match ? { pid: Number(match[1]), byte: match[2] } : null;
}

/** `linear_page_index(vma, address)`：这个虚拟地址在文件里的第几页（公式见 pagemap.h）。 */
function linearPageIndex(vma, address) {
  return ((address - vma.vmStart) >> BigInt(PAGE_SHIFT)) + vma.vmPgoff;
}

/** 逐级比"我们走出来的页表"与参照实现走出来的（GDB 侧参照的键名自成一套，故单独一个函数）。 */
function compareWalkWithReference(ours, reference) {
  const mismatches = [];
  if (reference === null || reference === undefined) return { mismatches: ['对照侧没有这次翻译'], compared: 0 };
  let compared = 0;
  if (asBig(reference.physical) !== ours.physical) {
    mismatches.push(`物理地址：我们=${hexOrNull(ours.physical)} GDB=${reference.physical === null ? '未映射' : hex(reference.physical)}`);
  }
  compared += 1;
  const refPageSize = reference.pageSize === null || reference.pageSize === undefined ? null : BigInt(reference.pageSize);
  if (refPageSize !== ours.pageSizeBytes) {
    mismatches.push(`页大小：我们=${ours.pageSizeBytes === null ? 'null' : ours.pageSizeBytes} GDB=${refPageSize === null ? 'null' : refPageSize}`);
  }
  compared += 1;
  const refWalk = reference.walk ?? [];
  if (refWalk.length !== ours.walk.length) {
    mismatches.push(`遍历级数：我们=${ours.walk.length} GDB=${refWalk.length}`);
  }
  for (let index = 0; index < Math.min(refWalk.length, ours.walk.length); index += 1) {
    const mine = ours.walk[index];
    const ref = refWalk[index];
    compared += 1;
    if (mine.index !== ref.index) mismatches.push(`第 ${index} 级 index：我们=${mine.index} GDB=${ref.index}`);
    if (asBig(ref.raw) !== mine.raw) mismatches.push(`第 ${index} 级 raw：我们=${hex(mine.raw)} GDB=${hex(ref.raw)}`);
    if (asBig(ref.tableAddress) !== mine.entryPhysical) {
      mismatches.push(`第 ${index} 级条目物理地址：我们=${hexOrNull(mine.entryPhysical)} GDB=${hexOrNull(ref.tableAddress)}`);
    }
    if (asBig(ref.targetPhysical) !== mine.targetPhysical) {
      mismatches.push(`第 ${index} 级目标：我们=${hexOrNull(mine.targetPhysical)} GDB=${hexOrNull(ref.targetPhysical)}`);
    }
  }
  const refFault = reference.fault === null || reference.fault === undefined ? null : reference.fault.kind;
  const mineFault = ours.fault === null ? null : ours.fault.kind;
  compared += 1;
  if (refFault !== mineFault) mismatches.push(`缺页类别：我们=${mineFault ?? '无'} GDB=${refFault ?? '无'}`);
  return { mismatches, compared };
}

/** 逐级比"我们走出来的页表"与服务自己（`GET /memory?mode=translate`）走出来的。 */
function compareWalkWithService(ours, translation) {
  const mismatches = [];
  if (translation === null || translation === undefined) return { mismatches: ['服务没有返回 translation'], compared: 0 };
  let compared = 0;
  const servicePhysical = asBig(translation.physical);
  compared += 1;
  if (servicePhysical !== ours.physical) {
    mismatches.push(`物理地址：我们=${hexOrNull(ours.physical)} 服务=${translation.physical ?? '未映射'}`);
  }
  const servicePageSize = translation.pageSize === null || translation.pageSize === undefined
    ? null : BigInt(translation.pageSize);
  compared += 1;
  if (servicePageSize !== ours.pageSizeBytes) {
    mismatches.push(`页大小：我们=${ours.pageSizeBytes ?? 'null'} 服务=${servicePageSize ?? 'null'}`);
  }
  const serviceWalk = translation.walk ?? [];
  compared += 1;
  if (serviceWalk.length !== ours.walk.length) {
    mismatches.push(`遍历级数：我们=${ours.walk.length} 服务=${serviceWalk.length}`);
  }
  for (let index = 0; index < Math.min(serviceWalk.length, ours.walk.length); index += 1) {
    const mine = ours.walk[index];
    const ref = serviceWalk[index];
    compared += 1;
    if (ref.index !== mine.index) mismatches.push(`第 ${index} 级 index：我们=${mine.index} 服务=${ref.index}`);
    if (asBig(ref.raw) !== mine.raw) mismatches.push(`第 ${index} 级 raw：我们=${hex(mine.raw)} 服务=${ref.raw}`);
    if (asBig(ref.tableAddress) !== mine.entryPhysical) {
      mismatches.push(`第 ${index} 级条目物理地址：我们=${hexOrNull(mine.entryPhysical)} 服务=${ref.tableAddress}`);
    }
    if (ref.present !== mine.flags.present) mismatches.push(`第 ${index} 级 present：我们=${mine.flags.present} 服务=${ref.present}`);
    if (ref.writable !== mine.flags.writable) mismatches.push(`第 ${index} 级 writable：我们=${mine.flags.writable} 服务=${ref.writable}`);
    if (ref.user !== mine.flags.user) mismatches.push(`第 ${index} 级 user：我们=${mine.flags.user} 服务=${ref.user}`);
    if (ref.noExecute !== mine.flags.noExecute) mismatches.push(`第 ${index} 级 nx：我们=${mine.flags.noExecute} 服务=${ref.noExecute}`);
  }
  return { mismatches, compared };
}

/* --------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t07c-evidence/1', startedAt: new Date().toISOString() };
  let session = null;
  let live = null;
  let layout = null;
  let symbols = null;
  let sizes = null;
  let base = null;
  let seq = 0;
  /** 记录 lab-cow 的子进程号与父进程号（客体自己打印的），停点三/四靠它认领。 */
  let labCowChildPid = null;
  let labCowParentPid = null;

  const cmd = async (type, extra = {}) => call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    requestId: `t07c-${++seq}-${type}`,
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
    /* ---------- 建会话、启动到 shell ---------- */

    log('创建会话并采集复位帧（加载 vmlinux 符号，约 1–2 分钟）...');
    const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
    if (created.status !== 201) throw new Error(`会话创建失败：${describe(created.body)}`);
    session = created.body;
    live = registry.get(session.id);
    base = `/api/sessions/${session.id}`;
    evidence.session = {
      id: session.id, profile: session.profile, epoch: live.epoch, qemu: live.process.qemuPath,
    };
    evidence.resetFrame = {
      frameId: created.body.firstFrame?.frameId,
      captureId: created.body.firstFrame?.captureId,
    };

    const bootCont = await cmd('continue');
    if (bootCont.status !== 200) throw new Error(`continue（启动）失败：${describe(bootCont.body)}`);
    log('等待客体启动到交互提示符（最多 300 秒，TCG 上较慢）...');
    const bootText = await waitForTerminal(app, base, 300000);
    check('T07c-B0 客体真实启动到交互提示符', PROMPT.test(bootText), `串口字节=${bootText.length}`);

    /* ---------- V1 布局与符号事实 ---------- */

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

    const symbolFacts = {};
    for (const name of ['mem_section', 'pcpu_hot', 'init_task', '__per_cpu_offset']) {
      const resolved = live.symbols.resolve(name, { module: 'linux-kernel' });
      const serviceAddress = resolved.found && !resolved.ambiguous
        ? BigInt(resolved.candidates[0].address) : null;
      const readelfAddress = symbols.get(name) ?? null;
      symbolFacts[name] = {
        service: hexOrNull(serviceAddress), readelf: hexOrNull(readelfAddress),
        equal: serviceAddress !== null && readelfAddress !== null && serviceAddress === readelfAddress,
      };
    }
    const absentSymbols = ['page_offset_base', 'vmemmap_base'].filter((name) => symbols.has(name));

    const unameCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07c-${++seq}-uname`,
      epoch: live.epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
      type: 'terminal.input',
      text: 'echo KERNEL"RELEASE=$(uname -r)"\n',
    });
    const unameText = await waitForTerminalMarker(app, base, 'KERNELRELEASE=', 60000, unameCursor);
    const guestRelease = /KERNELRELEASE=([^\s\r\n]+)/.exec(unameText)?.[1] ?? null;

    /**
     * 客体自己的配置（`/proc/config.gz`，本内核 `CONFIG_IKCONFIG_PROC=y`）。
     *
     * 这是第 7 条独立来源：本地 `labs/linux-x86_64/kernel.config` 只是**构建输入**，
     * 而客体内核里编进去的那份才是**跑起来的那个**配置。V2/V3 的条件位判定依赖配置，
     * 所以这两者必须一致。
     */
    const configCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07c-${++seq}-config`,
      epoch: live.epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
      type: 'terminal.input',
      text: 'zcat /proc/config.gz | grep -E "^CONFIG_(MMU|SPARSEMEM_VMEMMAP|ARCH_USES_PG_ARCH_2|ARCH_USES_HIGH_VMA_FLAGS|X86_64|MEM_SOFT_DIRTY|MEMORY_FAILURE|PAGE_IDLE_FLAG|HAVE_ARCH_USERFAULTFD_WP)" | sed "s/$/|/" ; echo CONFIG""DONE\n',
    });
    const configText = await waitForTerminalMarker(app, base, 'CONFIGDONE', 60000, configCursor);
    const guestConfig = new Map();
    for (const raw of configText.split('\n')) {
      const match = /^(CONFIG_[A-Z0-9_]+)=(.*?)\|$/.exec(raw.trim());
      if (match) guestConfig.set(match[1], match[2]);
    }

    const localConfigs = readEnabledConfigs(fs.readFileSync(KERNEL_CONFIG, 'utf8'));
    const configProbed = ['CONFIG_MMU', 'CONFIG_SPARSEMEM_VMEMMAP', 'CONFIG_ARCH_USES_PG_ARCH_2',
      'CONFIG_ARCH_USES_HIGH_VMA_FLAGS', 'CONFIG_X86_64'];
    const configMismatches = configProbed
      .filter((name) => (guestConfig.get(name) ?? null) !== 'y' || !localConfigs.has(name))
      .map((name) => `${name}: 客体=${guestConfig.get(name) ?? '缺失'} 本地=${localConfigs.has(name) ? 'y' : '缺失'}`);

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
      absentSymbols,
      structSizes: {
        page: layout.type('page').byteSize,
        folio: layout.type('folio')?.byteSize ?? null,
        mm_struct: layout.type('mm_struct').byteSize,
        vm_area_struct: layout.type('vm_area_struct').byteSize,
        maple_node: layout.type('maple_node').byteSize,
        maple_range_64: layout.type('maple_range_64').byteSize,
        maple_arange_64: layout.type('maple_arange_64').byteSize,
        maple_tree: layout.type('maple_tree').byteSize,
        maple_metadata: layout.type('maple_metadata').byteSize,
        mem_section: layout.has('mem_section') ? layout.type('mem_section').byteSize : null,
      },
      guestConfig: Object.fromEntries(guestConfig),
      localConfigProbed: configProbed.map((name) => `${name}=${localConfigs.has(name) ? 'y' : 'n'}`),
      configMismatches,
    };
    check(
      'T07c-V1a 布局产物与现场 vmlinux 绑定：build ID 与 sha256 由 load() 现场重算并比对通过，客体内核 release 与产物一致',
      layout.sha256 === liveSha256
        && typeof layout.buildId === 'string' && layout.buildId.length === 40
        && (vmlinuxBuildId === null || vmlinuxBuildId === layout.buildId)
        && guestRelease !== null && guestRelease === layout.linuxRelease,
      `buildId=${String(layout.buildId).slice(0, 12)}（readelf=${String(vmlinuxBuildId).slice(0, 12)}）`
        + ` 产物 release=${layout.linuxRelease} 客体 uname -r=${guestRelease ?? '未知'}`,
    );
    check(
      'T07c-V1b 清单里必需类型一个都不缺；地址空间要用的结构宽度与内核一致（page=64、folio=256、maple_arange_64=248、maple_metadata=2）',
      required.length > 0 && missingRequired.length === 0
        && layout.type('page').byteSize === 64
        && (layout.type('folio')?.byteSize ?? null) === 256
        && layout.type('maple_node').byteSize === 256
        && layout.type('maple_arange_64').byteSize === 248
        && layout.type('maple_metadata').byteSize === 2,
      `必需 ${required.length} 个全部存在；可选缺失 ${layout.missing.length} 个（${layout.missing.map((e) => e.name).join(',') || '无'}）；`
        + `page=${layout.type('page').byteSize} folio=${layout.type('folio')?.byteSize} mm=${layout.type('mm_struct').byteSize} `
        + `vma=${layout.type('vm_area_struct').byteSize} arange=${layout.type('maple_arange_64').byteSize}`,
    );
    check(
      'T07c-V1c 符号事实三方一致（readelf vs 服务）：mem_section/pcpu_hot/init_task/__per_cpu_offset 地址相同；且 page_offset_base 与 vmemmap_base 两个符号都不存在（这正是必须现场推基址的原因）',
      Object.values(symbolFacts).every((entry) => entry.equal === true) && absentSymbols.length === 0,
      Object.entries(symbolFacts).map(([name, entry]) => `${name}=${entry.service}`).join(' ')
        + `；现场不存在的符号：${absentSymbols.join(',') || '无（符合预期：两个基址符号都没编出来）'}`,
    );
    check(
      'T07c-V1d 客体自己编进去的配置（/proc/config.gz）与本地构建配置一致，条件位判定才有依据',
      configMismatches.length === 0 && guestConfig.size >= 5,
      `客体读到 ${guestConfig.size} 项：${configProbed.map((name) => `${name}=${guestConfig.get(name) ?? '缺失'}`).join(' ')}`
        + (configMismatches.length === 0 ? '' : `；不一致：${configMismatches.join(' | ')}`),
    );

    /* ---------- V2 VM_* 位表 vs include/linux/mm.h 现场重解析 ---------- */

    const mmhTable = readDefineTable(fs.readFileSync(MM_H, 'utf8'));
    const vmMismatches = [];
    const vmSkipped = [];
    const vmResolved = {};
    for (const entry of VMA_FLAG_BITS) {
      const values = resolveDefineAll(mmhTable, entry.name);
      const expected = 1n << BigInt(entry.bit);
      const conditional = entry.config !== null;
      const enabled = !conditional || localConfigs.has(entry.config);
      vmResolved[entry.name] = {
        bit: entry.bit, config: entry.config, enabled,
        source: [...values].map((value) => hex(value)),
      };
      if (!enabled) {
        // 配置没开时这一位不该存在：源码应当给 0（或者根本不定义）。
        const nonzero = [...values].filter((value) => value !== 0n);
        if (nonzero.length > 0) {
          vmSkipped.push(`${entry.name}：配置 ${entry.config} 没开，但 mm.h 给了 ${nonzero.map(hex).join('/')}`);
        }
        continue;
      }
      if (values.size === 0) { vmMismatches.push(`${entry.name}：mm.h 里找不到定义`); continue; }
      if (!values.has(expected)) {
        vmMismatches.push(`${entry.name}：我们=bit${entry.bit}(${hex(expected)}) mm.h=${[...values].map(hex).join('/')}`);
      }
    }
    const vmStack = resolveDefineAll(mmhTable, 'VM_STACK');
    const vmAccount = resolveDefineAll(mmhTable, 'VM_ACCOUNT');
    const vmExtras = [];
    const vmExtrasUnexplained = [];
    const tableMasks = new Map(VMA_FLAG_BITS.map((entry) => [1n << BigInt(entry.bit), entry]));
    for (const name of mmhTable.values.keys()) {
      if (!/^VM_[A-Z0-9_]+$/.test(name)) continue;
      if (VMA_FLAG_BITS.some((entry) => entry.name === name)) continue;
      const values = resolveDefineAll(mmhTable, name);
      const nonzero = [...values].filter((value) => value !== 0n);
      if (nonzero.length === 0) continue;
      const contexts = mmhTable.contexts.get(name) ?? [];
      const lines = contexts.map((entry) => entry.line);
      const reasons = [];
      // 归因顺序有讲究，三条规则的判据一条比一条弱，必须从强到弱问：
      //
      // 1. 先看它是不是定义在某个结构体声明体内。`VM_UNMAPPED_AREA_TOPDOWN` 就藏在
      //    `struct vm_unmapped_area_info {` 里面、值是 1 —— 与 `VM_READ` 的掩码一模一样，
      //    先问"和表里谁同值"就会得出"它是 VM_READ 的别名"这种彻底错误的结论。
      // 2. 再看它是不是"字号"。字号与掩码的差别是**量级**：vm_flags 是 64 位的
      //    `unsigned long`，字号必然小于 64，而掩码必然是 2 的幂且通常远大于 64。
      //    把这条放在"同值"之前，才不会把字号 `32` 认成 `VM_MAYWRITE`（bit 5，掩码 0x20）
      //    的同值别名 —— 0x20 与 32 是同一个数，只看数值分不开。
      // 3. 最后才按"与表中某项同值"认别名，且只认 ≥64 的值（字号全在 64 以下，
      //    不会误入这条）。`VM_MAYOVERLAY`(0x200) 与 `VM_STACK_EARLY`(0x100) 走这一条。
      if (contexts.length > 0 && contexts.every((entry) => entry.aggregate !== null)) {
        reasons.push(`定义在 ${[...new Set(contexts.map((entry) => entry.aggregate))].join('/')} 声明体内（第 ${lines.join('/')} 行），是那个结构体自己的标志位，不是 vm_flags`);
      } else {
        const bitSuffix = /_BIT(_\d+)?$/.exec(name);
        const maskName = bitSuffix === null ? null : name.replace(/_BIT(_\d+)?$/, '$1');
        const maskValues = maskName === null ? new Set() : resolveDefineAll(mmhTable, maskName);
        if (maskName !== null && nonzero.every((value) => value < 64n && maskValues.has(1n << value))) {
          reasons.push(`是"字号"不是掩码：掩码写作 ${maskName} = BIT(${nonzero.map((value) => value.toString()).join('/')})`);
        } else if (nonzero.every((value) => value >= 64n && tableMasks.has(value))) {
          const owner = tableMasks.get(nonzero[0]);
          reasons.push(`与表里 ${owner.name}（bit ${owner.bit}）同值，是同一个位在别的配置下的名字`);
        }
      }
      if (reasons.length === 0) {
        vmExtrasUnexplained.push(`${name}=${nonzero.map(hex).join('/')}（第 ${lines.join('/')} 行`
          + `${contexts.length > 0 && contexts[0].conditions.length > 0 ? `，位于 ${contexts[0].conditions.join(' ')} 分支内` : ''}）`);
      }
      vmExtras.push({ name, values: nonzero.map(hex), lines, reasons });
    }
    // 这次**不参与**源码对账的那些配置位：配置没开，源码里那一行收不到（或本来就该给 0）。
    // 列出来是为了给"逐项一致"这句话标出边界 —— 否则读的人会以为表里每一项都验过。
    const vmNotReconciled = VMA_FLAG_BITS
      .filter((entry) => entry.config !== null && !localConfigs.has(entry.config))
      .map((entry) => entry.name);
    evidence.vmFlags = {
      mismatches: vmMismatches,
      skipped: vmSkipped,
      resolved: vmResolved,
      vmStack: [...vmStack].map(hex),
      vmAccount: [...vmAccount].map(hex),
      extras: vmExtras,
      extrasUnexplained: vmExtrasUnexplained,
      notReconciled: vmNotReconciled,
      moduleStack: hex(VM_BITS.stack),
      moduleAccount: hex(VM_BITS.account),
    };
    check(
      'T07c-V2 `VM_*` 位表与 include/linux/mm.h 现场重解析逐项一致（依赖配置的位按客体实际配置判定），VM_STACK/VM_ACCOUNT 两个记账位也对得上，且源码里出现过的其余 `VM_*` 都能说清身份',
      vmMismatches.length === 0
        && vmSkipped.length === 0
        && vmStack.has(VM_BITS.stack)
        && vmAccount.has(VM_BITS.account)
        && VMA_FLAG_BITS.length >= 30
        && vmExtrasUnexplained.length === 0,
      `位表 ${VMA_FLAG_BITS.length} 项逐项一致=${vmMismatches.length === 0}；配置位判定异常=${vmSkipped.length}；`
        + `本次不参与对账（配置未开）${vmNotReconciled.length} 项：${vmNotReconciled.join(',') || '无'}；`
        + `VM_STACK 源码=${[...vmStack].map(hex).join('/')} 我们=${hex(VM_BITS.stack)}；`
        + `VM_ACCOUNT 源码=${[...vmAccount].map(hex).join('/')} 我们=${hex(VM_BITS.account)}；`
        + `表外另有 ${vmExtras.length} 个非零 VM_* 定义，解释不了的有 ${vmExtrasUnexplained.length} 个`
        + `（举例：${vmExtras.slice(0, 3).map((entry) => `${entry.name}=${entry.values.join('/')}→${entry.reasons.join('；')}`).join(' ｜ ')}）`
        + (vmMismatches.length === 0 ? '' : `；明细：${vmMismatches.slice(0, 6).join(' | ')}`)
        + (vmExtrasUnexplained.length === 0 ? '' : `；解释不了：${vmExtrasUnexplained.slice(0, 4).join(' | ')}`),
    );

    /* ---------- V3 PTE 位定义 / 物理地址掩码 / 页旗 / 页类型 vs 内核源码 ---------- */

    const pgtableTable = readDefineTable(fs.readFileSync(PGTABLE_TYPES_H, 'utf8'));
    const ptePairs = [
      ['present', '_PAGE_BIT_PRESENT'],
      ['writable', '_PAGE_BIT_RW'],
      ['user', '_PAGE_BIT_USER'],
      ['writeThrough', '_PAGE_BIT_PWT'],
      ['cacheDisable', '_PAGE_BIT_PCD'],
      ['accessed', '_PAGE_BIT_ACCESSED'],
      ['dirty', '_PAGE_BIT_DIRTY'],
      ['pageSize', '_PAGE_BIT_PSE'],
      ['global', '_PAGE_BIT_GLOBAL'],
      ['userfaultWp', '_PAGE_BIT_UFFD_WP'],
      ['softDirty', '_PAGE_BIT_SOFT_DIRTY'],
      ['devmap', '_PAGE_BIT_DEVMAP'],
      ['savedDirty', '_PAGE_BIT_SAVED_DIRTY'],
      ['noExecute', '_PAGE_BIT_NX'],
    ];
    const pteMismatches = [];
    const pteResolved = {};
    for (const [key, defineName] of ptePairs) {
      const values = resolveDefineAll(pgtableTable, defineName);
      pteResolved[key] = { define: defineName, bits: [...values].map((value) => Number(value)) };
      if (!values.has(BigInt(PTE_BITS[key]))) {
        pteMismatches.push(`${key}：我们=bit${PTE_BITS[key]} 源码(${defineName})=${[...values].map((v) => v.toString()).join('/') || '未定义'}`);
      }
    }
    const pseBits = resolveDefineAll(pgtableTable, '_PAGE_BIT_PSE');
    const patBits = resolveDefineAll(pgtableTable, '_PAGE_BIT_PAT');
    const protNoneBits = resolveDefineAll(pgtableTable, '_PAGE_BIT_PROTNONE');
    const bit7TwoMeanings = pseBits.has(7n) && patBits.has(7n);
    const protNoneIsGlobal = protNoneBits.has(BigInt(PTE_BITS.global));
    let physicalMaskShift = null;
    try {
      const pageTypes = readDefineTable(fs.readFileSync(PAGE_64_TYPES_H, 'utf8'));
      const values = resolveDefineAll(pageTypes, '__PHYSICAL_MASK_SHIFT');
      physicalMaskShift = values.size === 1 ? Number([...values][0]) : null;
    } catch { /* 源码文件缺失时记 null，下面的断言会如实报出来 */ }
    const expectedPhysicalMask = ((1n << 52n) - 1n) & ~0xfffn;
    const physicalMaskOk = physicalMaskShift === 52 && PHYSICAL_ADDRESS_MASK === expectedPhysicalMask;

    const pageFlagsText = fs.readFileSync(PAGE_FLAGS_H, 'utf8');
    const pagetypeSource = parseEnumPagetype(pageFlagsText);
    const pagetypeMismatches = [];
    for (const entry of PAGE_TYPE_NAMES) {
      const found = pagetypeSource.find((candidate) => candidate.name === entry.name);
      if (!found) pagetypeMismatches.push(`${entry.name}：源码 enum pagetype 里没有`);
      else if (found.code !== entry.code) pagetypeMismatches.push(`${entry.name}：我们=0x${entry.code.toString(16)} 源码=0x${found.code.toString(16)}`);
    }
    const flagSourceNames = parseEnumMembers(pageFlagsText, 'pageflags');
    let flagCursor = 0;
    const flagMissingInSource = [];
    for (const name of PAGE_FLAG_NAMES) {
      const at = flagSourceNames.indexOf(name, flagCursor);
      if (at < 0) flagMissingInSource.push(name);
      else flagCursor = at + 1;
    }
    const flagBitMismatches = [];
    const flagBitsFromLayout = {};
    for (let index = 0; index < PAGE_FLAG_NAMES.length; index += 1) {
      const name = PAGE_FLAG_NAMES[index];
      try {
        const bit = layout.enumValue('pageflags', name);
        flagBitsFromLayout[name] = bit;
        if (bit !== index) flagBitMismatches.push(`${name}：DWARF 枚举=${bit} 表内序号=${index}`);
      } catch (error) {
        flagBitMismatches.push(`${name}：${error.message}`);
      }
    }
    const nrPageflags = layout.enumValue('pageflags', '__NR_PAGEFLAGS');
    const flagSourceExtras = flagSourceNames
      .filter((name) => name !== '__NR_PAGEFLAGS' && !PAGE_FLAG_NAMES.includes(name));
    evidence.pteBits = {
      mismatches: pteMismatches,
      resolved: pteResolved,
      bit7TwoMeanings,
      protNoneIsGlobal,
      physicalMaskShift,
      physicalAddressMask: hex(PHYSICAL_ADDRESS_MASK),
      expectedPhysicalMask: hex(expectedPhysicalMask),
    };
    evidence.pageFlags = {
      pagetypeSource,
      pagetypeMismatches,
      flagSourceNames,
      flagSourceExtras,
      flagMissingInSource,
      flagBitsFromLayout,
      flagBitMismatches,
      nrPageflags,
      ourCount: PAGE_FLAG_NAMES.length,
    };
    check(
      'T07c-V3a PTE 位定义与 arch/x86/include/asm/pgtable_types.h 现场重解析逐个一致；bit 7 的双重含义（PSE/PAT）与 PROT_NONE=GLOBAL 也被证到；物理地址掩码与 __PHYSICAL_MASK_SHIFT=52 相符',
      pteMismatches.length === 0 && bit7TwoMeanings && protNoneIsGlobal && physicalMaskOk,
      `14 个位逐项一致=${pteMismatches.length === 0}；bit7(PSE/PAT) 双含义=${bit7TwoMeanings}；`
        + `PROT_NONE=_PAGE_BIT_GLOBAL=${protNoneIsGlobal}；__PHYSICAL_MASK_SHIFT=${physicalMaskShift} `
        + `掩码=${hex(PHYSICAL_ADDRESS_MASK)}`
        + (pteMismatches.length === 0 ? '' : `；明细：${pteMismatches.join(' | ')}`),
    );
    check(
      'T07c-V3b 页旗名字表与页类型表都由内核源码与 DWARF 枚举双重钉住：enum pagetype 代号一致，enum pageflags 顺序一致，且我们的 21 个名字正好等于 __NR_PAGEFLAGS（说明本配置下没有别的旗子被漏掉）',
      pagetypeSource.length >= 5 && pagetypeMismatches.length === 0
        && flagSourceNames.length >= PAGE_FLAG_NAMES.length
        && flagMissingInSource.length === 0
        && flagBitMismatches.length === 0
        && nrPageflags === PAGE_FLAG_NAMES.length,
      `enum pagetype ${pagetypeSource.length} 项一致=${pagetypeMismatches.length === 0}；`
        + `enum pageflags 文本 ${flagSourceNames.length} 项（含条件分支），按 DWARF 编号逐位核对 ${PAGE_FLAG_NAMES.length} 项一致=${flagBitMismatches.length === 0}；`
        + `__NR_PAGEFLAGS=${nrPageflags}；源码里被本配置关掉的分支成员：${flagSourceExtras.join(',') || '无'}`
        + (pagetypeMismatches.length + flagBitMismatches.length === 0 ? '' : `；明细：${[...pagetypeMismatches, ...flagBitMismatches].slice(0, 5).join(' | ')}`),
    );

    /* ---------- 停点一：lab-read 读文件 ---------- */

    const percpuHotLink = symbols.get('pcpu_hot') ?? null;
    const commOffset = layout.byteOffset('task_struct', 'comm');
    const taskOffsets = {
      comm: commOffset,
      pid: layout.byteOffset('task_struct', 'pid'),
      tgid: layout.byteOffset('task_struct', 'tgid'),
      mm: layout.byteOffset('task_struct', 'mm'),
      realParent: layout.byteOffset('task_struct', 'real_parent'),
    };

    log('停点一：lab-read 停在 ext2_file_read_iter ...');
    const readClaim = await claimWithRetry({
      app,
      base,
      live,
      cmd,
      symbol: 'ext2_file_read_iter',
      commandFor: (n) => `lab-read /data/hello.txt; echo READ${n}""Y-DONE-$?\n`,
      markerFor: (n) => `READ${n}Y-DONE-`,
      inspect: async (frame) => {
        const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
        return { claimed: info.comm === 'lab-read', label: info.label, value: frame };
      },
    });
    if (readClaim.failed) {
      throw new Error(
        `没有等到 lab-read 停在 ext2_file_read_iter（尝试 ${readClaim.attempts.length} 次，帧总数 ${live.frames.length}）；`
        + `尝试记录=${JSON.stringify(readClaim.attempts.map((e) => `第${e.attempt}次停${e.stopsSeen}回[${e.trace.slice(-6).join(' ')}]`))}；`
        + `串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const frame1 = readClaim.frame;
    const capture1 = captureFor(frame1);
    const view1 = new KernelMemoryView(capture1);
    const current1 = await describeStoppedTask(capture1, percpuHotLink, taskOffsets);
    evidence.stop1 = {
      frameId: frame1.frameId,
      captureId: frame1.captureId,
      claimStops: readClaim.stops,
      attempts: readClaim.attempts,
      rip: frame1.cpu?.rip,
      cr3: frame1.cpu?.control?.cr3 ?? null,
      comm: current1.comm,
      pid: current1.pid,
      taskAddress: hex(current1.taskAddress),
      breakpoint: readClaim.breakpoint,
    };
    check(
      'T07c-V0 停点落在 lab-read 读文件的内核函数 ext2_file_read_iter 上（认领靠最小读取读出的 comm，不靠 pid 猜）',
      current1.comm === 'lab-read'
        && frame1.stop?.reason === 'breakpoint'
        && (String(frame1.source?.symbol ?? 'ext2_file_read_iter') === 'ext2_file_read_iter'),
      `comm=${current1.comm} pid=${current1.pid} rip=${frame1.cpu?.rip} 停点符号=${frame1.source?.symbol ?? '（帧里没给）'} stop=${frame1.stop?.reason}`,
    );

    /* ---------- V4 current/mm 三源一致 + 直映射偏移形状 ---------- */

    const mmAddress = await view1.u64(current1.taskAddress + BigInt(taskOffsets.mm));
    const mm = await readMm(view1, layout, mmAddress);
    const cr3Frame = frame1.cpu?.control?.cr3 === null || frame1.cpu?.control?.cr3 === undefined
      ? null : BigInt(frame1.cpu.control.cr3);
    const offsetDerivation = mm.pgd === null || cr3Frame === null
      ? null
      : derivePageOffsetBase({ pgdLinear: mm.pgd, cr3: cr3Frame });
    const pageOffsetBase = offsetDerivation?.base ?? null;
    const rootPhysical = cr3Frame === null ? null : (cr3Frame & PHYSICAL_ADDRESS_MASK);

    const tree1 = await readVmas(view1, layout, mmAddress, { enabledConfigs: localConfigs });
    const ref1 = await runReference(live, 'stop1', {
      va: mm.startCode,
      va2: 0n,
      pfn: 0n,
      mm: mmAddress,
      cr3: cr3Frame ?? 0n,
    });
    if (!ref1.ok) log(`GDB 侧参照（停点一）失败：${ref1.error}`);
    const refData1 = ref1.ok ? ref1.data : {};
    const refCurrent1 = refData1.current ?? {};
    const refMm1 = refCurrent1.mm ?? {};

    const mmFieldPairs = [
      ['mmUsers', 'mm_users'], ['mmCount', 'mm_count'], ['pgd', 'pgd'], ['taskSize', 'task_size'],
      ['totalVm', 'total_vm'], ['lockedVm', 'locked_vm'], ['dataVm', 'data_vm'], ['execVm', 'exec_vm'],
      ['stackVm', 'stack_vm'], ['pgtablesBytes', 'pgtables_bytes'], ['startCode', 'start_code'],
      ['endCode', 'end_code'], ['startData', 'start_data'], ['endData', 'end_data'],
      ['startBrk', 'start_brk'], ['brk', 'brk'], ['startStack', 'start_stack'],
      ['argStart', 'arg_start'], ['argEnd', 'arg_end'], ['envStart', 'env_start'],
      ['envEnd', 'env_end'], ['mmapBase', 'mmap_base'], ['mmapLegacyBase', 'mmap_legacy_base'],
      ['defFlags', 'def_flags'], ['exeFile', 'exe_file'],
    ];
    const mmMismatches = [];
    const mmMissing = [];
    let mmCompared = 0;
    for (const [mineKey, refKey] of mmFieldPairs) {
      const refValue = refMm1[refKey];
      if (refValue === null || refValue === undefined) { mmMissing.push(mineKey); continue; }
      const mine = mm[mineKey];
      mmCompared += 1;
      const mineText = mine === null || mine === undefined ? '0' : BigInt(mine).toString();
      if (mineText !== BigInt(refValue).toString()) {
        mmMismatches.push(`${mineKey}: 我们=${mine === null || mine === undefined ? 'NULL' : mineText} GDB=${refValue}`);
      }
    }
    const mapCountRef = refMm1.map_count === undefined ? null : refMm1.map_count;
    if (mapCountRef !== null) {
      mmCompared += 1;
      if (Number(mm.mapCount) !== Number(mapCountRef)) mmMismatches.push(`mapCount: 我们=${mm.mapCount} GDB=${mapCountRef}`);
    }
    const mmMtRef = refBig(refCurrent1.mmMtAddress);
    const gsBaseGdb = refBig(refCurrent1.gsBase);
    const gdbCurrentFromGs = refBig(refCurrent1.current);
    const offsetTable = symbols.get('__per_cpu_offset') ?? null;
    const percpuBase0 = offsetTable === null ? null : await view1.u64(offsetTable);
    const gsBaseFrame = frame1.cpu?.segments?.gs?.base ?? null;
    const gdbPageOffset = refData1.pageOffsetBase ?? null;

    evidence.stop1.mm = {
      address: hex(mmAddress),
      gdbMmAddress: hexOrNull(refBig(refCurrent1.mmAddress)),
      compared: mmCompared,
      mismatches: mmMismatches,
      missing: mmMissing,
      mmMtAddress: hex(mm.mmMtAddress),
      gdbMmMtAddress: hexOrNull(mmMtRef),
      gdbStructSizes: refData1.layout?.sizes ?? null,
      gdbMmOffsets: refData1.layout?.mm ?? null,
      pageOffsetBase: pageOffsetBase === null ? null : hex(pageOffsetBase),
      gdbPageOffsetBase: gdbPageOffset === null ? null : hex(gdbPageOffset.base),
      gdbPageOffset: gdbPageOffset,
      percpuBase0: hexOrNull(percpuBase0),
      gsBaseFrame: gsBaseFrame === null ? null : String(gsBaseFrame),
      gsBaseGdb: hexOrNull(gsBaseGdb),
      gdbCurrent: hexOrNull(gdbCurrentFromGs),
      cr3Frame: cr3Frame === null ? null : hex(cr3Frame),
      gdbCr3: refData1.cr3 ?? null,
    };
    const gdbSizes = refData1.layout?.sizes ?? null;
    check(
      'T07c-V1e 布局清单的结构宽度与 GDB 自己的 DWARF 逐项一致（page/folio/mm_struct/vm_area_struct/maple_node）；mem_section 我们没收进清单、GDB 有真定义（这正是 vmemmap 那条对照的独立性来源）',
      gdbSizes !== null
        && Number(gdbSizes.page) === Number(evidence.kernel.structSizes.page)
        && Number(gdbSizes.folio) === Number(evidence.kernel.structSizes.folio)
        && Number(gdbSizes.mm_struct) === Number(evidence.kernel.structSizes.mm_struct)
        && Number(gdbSizes.vm_area_struct) === Number(evidence.kernel.structSizes.vm_area_struct)
        && Number(gdbSizes.maple_node) === Number(evidence.kernel.structSizes.maple_node),
      `GDB：page=${gdbSizes?.page} folio=${gdbSizes?.folio} mm=${gdbSizes?.mm_struct} vma=${gdbSizes?.vm_area_struct} `
        + `maple_node=${gdbSizes?.maple_node} mem_section=${gdbSizes?.mem_section}；`
        + `我们：${JSON.stringify(evidence.kernel.structSizes)}`,
    );
    check(
      'T07c-V4a `current` 两条机制一致：`__per_cpu_offset[0] + pcpu_hot.current_task`（我们）与 GDB 的 `%gs` 基址路径算出同一个任务、同一个 mm',
      percpuBase0 !== null && gsBaseGdb !== null && gsBaseFrame !== null
        && percpuBase0 === BigInt(gsBaseFrame) && percpuBase0 === gsBaseGdb
        && gdbCurrentFromGs === current1.taskAddress
        && refBig(refCurrent1.mmAddress) === mmAddress,
      `__per_cpu_offset[0]=${hexOrNull(percpuBase0)} 帧里 %gs 基址=${gsBaseFrame} GDB $gs_base=${hexOrNull(gsBaseGdb)}；`
        + `current：我们=${hex(current1.taskAddress)} GDB($gs)=${hexOrNull(gdbCurrentFromGs)}；`
        + `mm：我们=${hex(mmAddress)} GDB=${hexOrNull(refBig(refCurrent1.mmAddress))}`,
    );
    check(
      'T07c-V4b mm_struct 逐字段与 GDB 一致（25 个字段 + map_count），且 &mm->mm_mt 也相同',
      mmCompared >= 24 && mmMismatches.length === 0 && mmMissing.length === 0
        && mmMtRef === mm.mmMtAddress,
      `比对 ${mmCompared} 个字段，不一致 ${mmMismatches.length} 个，GDB 读不到 ${mmMissing.length} 个`
        + (mmMismatches.length === 0 ? '' : `；明细：${mmMismatches.slice(0, 6).join(' | ')}`)
        + `；mm_mt：我们=${hex(mm.mmMtAddress)} GDB=${hexOrNull(mmMtRef)}`,
    );
    check(
      'T07c-V4c 直映射偏移由「pgd 线性地址 − CR3 物理地址」现场解出，并且形状全部对：512 GiB 对齐、落在内核半区、等于编译期常量 __PAGE_OFFSET_BASE_L4；GDB 用另一条路径解出的同一个值',
      offsetDerivation !== null
        && offsetDerivation.aligned === true
        && offsetDerivation.inKernelHalf === true
        && offsetDerivation.matchesCompiledDefault === true
        && pageOffsetBase === PAGE_OFFSET_BASE_L4
        && gdbPageOffset !== null && asBig(gdbPageOffset.base) === pageOffsetBase
        && rootPhysical !== null && asBig(gdbPageOffset.rootPhysical) === rootPhysical,
      `我们：base=${hexOrNull(pageOffsetBase)} 对齐=${offsetDerivation?.aligned} 内核半区=${offsetDerivation?.inKernelHalf} `
        + `等于 __PAGE_OFFSET_BASE_L4=${offsetDerivation?.matchesCompiledDefault}；`
        + `GDB：base=${gdbPageOffset === null ? '缺' : hex(gdbPageOffset.base)} rootPhysical=${hexOrNull(rootPhysical)} `
        + `对齐=${gdbPageOffset?.aligned} 内核半区=${gdbPageOffset?.inKernelHalf}；`
        + `CR3（帧）=${hexOrNull(cr3Frame)} GDB 用=${refData1.cr3?.used ?? '缺'}`,
    );

    /* ---------- V5：VMA 这棵树（maple tree）与 GDB 的独立遍历 ---------- */

    /**
     * 为什么不直接用 `tree1`（`readVmas` 的结果）去比：`readVmas` 把树遍历与"读 VMA
     * 字段"揉在一起，出了错就分不清是哪一层。这里**再单独走一遍树**，拿到的就是纯粹的
     * 结构事实（叶子槽区间、节点地址、节点类型、空槽数），可以和 GDB 自己重写的遍历逐项
     * 对。"差一个"是这一层最典型的错：区间闭合方式写成开区间，每个条目会多占一个下标，
     * 条目数不变、每个区间的上界都偏 1，靠肉眼看不出来。
     */
    const walk1 = await walkMapleTree(view1, layout, mm.mmMtAddress, { maxNodes: 4096, maxDepth: 31 });
    const refTree = refData1.tree ?? {};
    const refEntries = refTree.entries ?? [];
    const refNodes = refTree.nodes ?? [];
    const entryKey = (min, max) => `${min}:${max}`;
    const mineEntryKeys = new Set(walk1.entries.map((entry) => entryKey(entry.min, entry.max)));
    const refEntryKeys = new Set(refEntries.map((entry) => entryKey(asBig(entry.min), asBig(entry.max))));
    const entryOnlyMine = [...mineEntryKeys].filter((key) => !refEntryKeys.has(key));
    const entryOnlyRef = [...refEntryKeys].filter((key) => !mineEntryKeys.has(key));
    const mineValueByRange = new Map(walk1.entries.map((entry) => [entryKey(entry.min, entry.max), entry.value]));
    const entryValueMismatches = [];
    for (const entry of refEntries) {
      const key = entryKey(asBig(entry.min), asBig(entry.max));
      const mine = mineValueByRange.get(key);
      if (mine === undefined) continue;
      if (mine !== asBig(entry.value)) {
        entryValueMismatches.push(`${key}：我们=${hex(mine)} GDB=${hex(asBig(entry.value))}`);
      }
    }
    const mineNodeAddresses = new Set(walk1.nodes.map((node) => String(node.address)));
    const refNodeAddresses = new Set(refNodes.map((node) => String(asBig(node.address))));
    const mineNodeTypes = new Map(walk1.nodes.map((node) => [String(node.address), node.type]));
    const mineDataEnds = new Map(walk1.nodes.map((node) => [String(node.address), Number(node.dataEnd)]));
    const nodeTypeMismatches = [];
    const nodeDataEndMismatches = [];
    for (const node of refNodes) {
      const key = String(asBig(node.address));
      const mineType = mineNodeTypes.get(key);
      if (mineType !== undefined && Number(mineType) !== Number(node.type)) {
        nodeTypeMismatches.push(`${node.address}：我们=${mineType} GDB=${node.type}`);
      }
      const mineDataEnd = mineDataEnds.get(key);
      if (mineDataEnd !== undefined && mineDataEnd !== Number(node.dataEnd)) {
        nodeDataEndMismatches.push(`${node.address}：我们=${mineDataEnd} GDB=${node.dataEnd}`);
      }
    }
    const treeFieldOk = walk1.tree.address === mm.mmMtAddress
      && Number(walk1.tree.maFlags) === Number(refTree.maFlags)
      && walk1.tree.rootRaw === asBig(refTree.maRoot)
      && Number(walk1.tree.heightField) === Number(refTree.heightField)
      && walk1.tree.allocRange === refTree.allocRange
      && walk1.rootKind === refTree.rootKind
      && walk1.rootKind === tree1.rootKind
      && Number(tree1.treeHeightField) === Number(refTree.heightField);
    /** 槽区间不变量：每个叶子槽覆盖的下标区间必须恰好是 `[vm_start, vm_end-1]`。 */
    const slotInvariantViolations = [];
    for (const vma of tree1.vmas) {
      if (vma.slotRange === null) {
        slotInvariantViolations.push(`${hex(vma.vmStart)}：这条 VMA 没有槽区间`);
        continue;
      }
      if (vma.slotRange.min !== vma.vmStart || vma.slotRange.max !== vma.vmEnd - 1n) {
        slotInvariantViolations.push(
          `[${hex(vma.vmStart)},${hex(vma.vmEnd)}) 的槽区间是 `
          + `[${hex(vma.slotRange.min)},${hex(vma.slotRange.max)}]`,
        );
      }
    }
    evidence.stop1.vmaTree = {
      treeAddress: hex(mm.mmMtAddress),
      rootKind: walk1.rootKind,
      gdbRootKind: refTree.rootKind ?? null,
      maFlags: walk1.tree.maFlags,
      gdbMaFlags: refTree.maFlags ?? null,
      heightField: walk1.tree.heightField,
      gdbHeightField: refTree.heightField ?? null,
      allocRange: walk1.tree.allocRange,
      rootRaw: hex(walk1.tree.rootRaw),
      entryCount: walk1.entries.length,
      gdbEntryCount: refEntries.length,
      entries: walk1.entries.map((entry) => ({
        min: hex(entry.min), max: hex(entry.max), value: hex(entry.value), depth: entry.depth,
        nodeAddress: hexOrNull(entry.nodeAddress === 0n ? null : entry.nodeAddress),
        slotIndex: entry.slotIndex,
      })),
      entryOnlyMine,
      entryOnlyRef,
      entryValueMismatches,
      nodesVisited: walk1.nodesVisited,
      gdbNodesVisited: refTree.nodesVisited ?? null,
      maxDepth: walk1.maxDepth,
      gdbMaxDepth: refTree.maxDepth ?? null,
      nullSlots: walk1.nullSlots,
      gdbNullSlots: refTree.nullSlots ?? null,
      nodeAddresses: [...mineNodeAddresses],
      gdbNodeAddresses: [...refNodeAddresses],
      nodeTypeMismatches,
      nodeDataEndMismatches,
      violations: walk1.violations,
      gdbViolations: refTree.violations ?? [],
      cycle: walk1.cycle,
      truncated: walk1.truncated,
      notes: walk1.notes,
      slotInvariantViolations,
      parserRangeMismatches: tree1.rangeMismatches,
    };
    check(
      'T07c-V5 VMA 的 maple 树与 GDB 自己重写的遍历逐项一致：根形态、ma_flags/height/alloc_range、叶子槽区间集合（连每个区间的 value 都相同）、节点地址与类型、节点 data_end、空槽数、访问节点数与最大深度；树里没有环、没被上限截断、也没有任何结构违反',
      refEntries.length > 0 && treeFieldOk
        && walk1.entries.length === refEntries.length
        && entryOnlyMine.length === 0 && entryOnlyRef.length === 0 && entryValueMismatches.length === 0
        && walk1.nodesVisited === Number(refTree.nodesVisited)
        && walk1.maxDepth === Number(refTree.maxDepth)
        && walk1.nullSlots === Number(refTree.nullSlots)
        && mineNodeAddresses.size === refNodeAddresses.size
        && nodeTypeMismatches.length === 0 && nodeDataEndMismatches.length === 0
        && walk1.violations.length === 0 && walk1.cycle === false && walk1.truncated === false
        && (refTree.violations ?? []).length === 0 && refTree.cycle === false && refTree.truncated === false,
      `根形态 我们=${walk1.rootKind} GDB=${refTree.rootKind}；ma_flags=${walk1.tree.maFlags}/${refTree.maFlags} `
        + `height=${walk1.tree.heightField}/${refTree.heightField} alloc_range=${walk1.tree.allocRange}/${refTree.allocRange}；`
        + `叶子条目 ${walk1.entries.length}/${refEntries.length}（只我们有 ${entryOnlyMine.length}，只 GDB 有 ${entryOnlyRef.length}，`
        + `区间相同但 value 不同 ${entryValueMismatches.length}）；节点 ${walk1.nodesVisited}/${refTree.nodesVisited}`
        + `（地址集合 ${mineNodeAddresses.size}/${refNodeAddresses.size}，类型不一致 ${nodeTypeMismatches.length}，`
        + `data_end 不一致 ${nodeDataEndMismatches.length}）；最大深度 ${walk1.maxDepth}/${refTree.maxDepth}；`
        + `空槽 ${walk1.nullSlots}/${refTree.nullSlots}`
        + (entryValueMismatches.length + nodeTypeMismatches.length + nodeDataEndMismatches.length === 0
          ? '' : `；明细：${[...entryValueMismatches, ...nodeTypeMismatches, ...nodeDataEndMismatches].slice(0, 5).join(' | ')}`),
    );

    /* ---------- V5b：逐条 VMA 与 GDB 独立同读 ---------- */

    const refVmas = refData1.vmas ?? [];
    const vmaFieldPairs = [
      ['vmStart', 'vm_start'], ['vmEnd', 'vm_end'], ['vmFlags', 'vm_flags'],
      ['vmPgoff', 'vm_pgoff'], ['vmMm', 'vm_mm'], ['vmFile', 'vm_file'],
      ['anonVma', 'anon_vma'], ['vmOps', 'vm_ops'], ['vmPrivateData', 'vm_private_data'],
    ];
    const vmaByAddress = new Map(tree1.vmas.map((vma) => [String(vma.address), vma]));
    const vmaMismatches = [];
    let vmaFieldsCompared = 0;
    let vmaCompared = 0;
    for (const ref of refVmas) {
      const key = String(asBig(ref.address));
      const mine = vmaByAddress.get(key);
      if (mine === undefined) { vmaMismatches.push(`GDB 读到了 VMA ${hex(key)}，我们没读出来`); continue; }
      vmaCompared += 1;
      for (const [mineKey, refKey] of vmaFieldPairs) {
        const refValue = ref[refKey];
        if (refValue === null || refValue === undefined) continue;
        vmaFieldsCompared += 1;
        const mineValue = mine[mineKey];
        const mineText = mineValue === null || mineValue === undefined ? '0' : String(mineValue);
        if (mineText !== String(asBig(refValue))) {
          vmaMismatches.push(`${hex(key)}.${mineKey}：我们=${mineText} GDB=${refValue}`);
        }
      }
      vmaFieldsCompared += 1;
      const slotText = mine.slotRange === null
        ? 'null'
        : `${hex(mine.slotRange.min)}-${hex(mine.slotRange.max)}`;
      if (mine.slotRange === null
        || mine.slotRange.min !== asBig(ref.slotMin) || mine.slotRange.max !== asBig(ref.slotMax)) {
        vmaMismatches.push(
          `${hex(key)} 的槽区间：我们=${slotText} GDB=${hex(asBig(ref.slotMin))}-${hex(asBig(ref.slotMax))}`,
        );
      }
      if (ref.vm_lock_seq !== null && ref.vm_lock_seq !== undefined) {
        vmaFieldsCompared += 1;
        if (Number(mine.vmLockSeq) !== Number(ref.vm_lock_seq)) {
          vmaMismatches.push(`${hex(key)}.vmLockSeq：我们=${mine.vmLockSeq} GDB=${ref.vm_lock_seq}`);
        }
      }
      if (ref.detached !== null && ref.detached !== undefined) {
        vmaFieldsCompared += 1;
        if ((mine.detached ? 1 : 0) !== Number(ref.detached)) {
          vmaMismatches.push(`${hex(key)}.detached：我们=${mine.detached} GDB=${ref.detached}`);
        }
      }
      // `vm_flags` 在 DWARF 里带 const 限定，`__vm_flags` 是同偏移的内部别名：
      // GDB 两个都读，它们必须相同；不同就说明"以为在比 vm_flags，其实在读别处"。
      if (ref.vm_flags_const !== null && ref.vm_flags_const !== undefined
        && ref.vm_flags !== null && ref.vm_flags !== undefined
        && String(asBig(ref.vm_flags_const)) !== String(asBig(ref.vm_flags))) {
        vmaMismatches.push(
          `${hex(key)}：GDB 自己读的 vm_flags(${ref.vm_flags_const}) 与 __vm_flags(${ref.vm_flags}) 不同`,
        );
      }
    }
    evidence.stop1.vmaFields = {
      vmaCount: tree1.vmas.length,
      gdbVmaCount: refVmas.length,
      compared: vmaCompared,
      fieldsCompared: vmaFieldsCompared,
      mismatches: vmaMismatches,
      slotInvariantViolations,
      parserRangeMismatches: tree1.rangeMismatches,
      vmas: tree1.vmas.map((vma) => ({
        address: hex(vma.address),
        start: hex(vma.vmStart), end: hex(vma.vmEnd),
        flags: hex(vma.vmFlags), permissions: vma.permissions,
        pgoff: hex(vma.vmPgoff), file: hexOrNull(vma.vmFile), anonVma: hexOrNull(vma.anonVma),
        ops: hexOrNull(vma.vmOps), lockSeq: vma.vmLockSeq, detached: vma.detached,
        slotRange: vma.slotRange === null
          ? null : { min: hex(vma.slotRange.min), max: hex(vma.slotRange.max) },
      })),
    };
    check(
      'T07c-V5b 逐条 VMA 的 9 个字段（vm_start/vm_end/vm_flags/vm_pgoff/vm_mm/vm_file/anon_vma/vm_ops/vm_private_data）加 vm_lock_seq、detached，以及"这条 VMA 在树里占哪个槽区间"，全部与 GDB 独立读出的值相同；且每条的槽区间都恰好等于 [vm_start, vm_end-1]',
      refVmas.length > 0 && tree1.vmas.length === refVmas.length && vmaCompared === refVmas.length
        && vmaMismatches.length === 0
        && slotInvariantViolations.length === 0 && tree1.rangeMismatches.length === 0
        && tree1.violations.length === 0,
      `VMA ${vmaCompared}/${refVmas.length} 条全部对上，字段比对 ${vmaFieldsCompared} 次，不一致 ${vmaMismatches.length}；`
        + `槽区间不变量违反 ${slotInvariantViolations.length} 条（解析器自己记下 ${tree1.rangeMismatches.length} 条，`
        + `树结构违反 ${tree1.violations.length} 条）`
        + (vmaMismatches.length === 0 ? '' : `；明细：${vmaMismatches.slice(0, 6).join(' | ')}`),
    );

    /* ---------- V6：记账三方对账 ---------- */

    const refAccounting = refData1.accounting ?? {};
    const accountingPairs = [
      ['totalPages', 'totalVm', 'total_vm'], ['execPages', 'execVm', 'exec_vm'],
      ['stackPages', 'stackVm', 'stack_vm'], ['dataPages', 'dataVm', 'data_vm'],
    ];
    const accountingMismatches = [];
    for (const [pageKey, mineMmKey, refMmKey] of accountingPairs) {
      const minePages = tree1.accounting[pageKey];
      const mineMm = mm[mineMmKey];
      const refPages = refAccounting[pageKey];
      const refMm = refMm1[refMmKey];
      if (String(minePages) !== String(mineMm)) {
        accountingMismatches.push(`${pageKey}：我们按树重算=${minePages}，mm_struct.${mineMmKey}=${mineMm}`);
      }
      if (refMm !== undefined && refMm !== null && String(BigInt(mineMm)) !== String(asBig(refMm))) {
        accountingMismatches.push(`mm_struct.${mineMmKey}：我们=${mineMm} GDB=${refMm}`);
      }
      if (refPages !== null && refPages !== undefined && String(minePages) !== String(asBig(refPages))) {
        accountingMismatches.push(`${pageKey}：我们=${minePages} GDB 按自己读的 VMA 重算=${refPages}`);
      }
    }
    // `mm/vma.h` 里的分类判据用的是 VM_* 位本身，所以位值也要对一遍：
    // 位值错一位（尤其 VM_STACK 与 VM_GROWSDOWN 在没开 STACK_GROWSUP 时是同一个值），
    // 四类小计会一起偏，而 mm_struct 里的数字又"恰好"跟着偏 —— 只能靠位表独立钉住。
    const refBits = refAccounting.bitsUsed ?? {};
    const bitPairs = [
      ['read', 'VM_READ'], ['write', 'VM_WRITE'], ['exec', 'VM_EXEC'],
      ['shared', 'VM_SHARED'], ['stack', 'VM_STACK'],
    ];
    const bitMismatches = [];
    for (const [mineKey, refKey] of bitPairs) {
      const refValue = refBits[refKey];
      if (refValue === null || refValue === undefined) continue;
      if (String(VM_BITS[mineKey]) !== String(asBig(refValue))) {
        bitMismatches.push(`${mineKey}：我们=${VM_BITS[mineKey]} GDB=${refValue}`);
      }
    }
    const mapCountOk = Number(mm.mapCount) === tree1.vmas.length
      && Number(refAccounting.vmaCount) === tree1.vmas.length;
    evidence.stop1.accounting = {
      mine: {
        totalPages: jsonSafe(tree1.accounting.totalPages),
        execPages: jsonSafe(tree1.accounting.execPages),
        stackPages: jsonSafe(tree1.accounting.stackPages),
        dataPages: jsonSafe(tree1.accounting.dataPages),
        allMatch: tree1.accounting.allMatch,
        matches: tree1.accounting.matches,
        details: tree1.accounting.details,
      },
      mm: {
        totalVm: jsonSafe(mm.totalVm), execVm: jsonSafe(mm.execVm),
        stackVm: jsonSafe(mm.stackVm), dataVm: jsonSafe(mm.dataVm), mapCount: mm.mapCount,
      },
      gdb: refAccounting,
      mismatches: accountingMismatches,
      bitMismatches,
    };
    check(
      'T07c-V6 记账三方一致：我们按 maple 树读出的 VMA 重算的 total/exec/stack/data 页数与 mm_struct 里同名四项相同、也与 GDB 用自己读到的 VMA 重算的相同；VMA 条数等于 map_count；分类判据用的 VM_* 位值与 GDB 的位表相同',
      refAccounting.totalPages !== undefined && accountingMismatches.length === 0
        && bitMismatches.length === 0 && tree1.accounting.allMatch === true
        && tree1.accounting.matches.count === true && mapCountOk,
      `我们重算 total=${tree1.accounting.totalPages} exec=${tree1.accounting.execPages} `
        + `stack=${tree1.accounting.stackPages} data=${tree1.accounting.dataPages}（allMatch=${tree1.accounting.allMatch}）；`
        + `mm_struct total_vm=${mm.totalVm} exec_vm=${mm.execVm} stack_vm=${mm.stackVm} `
        + `data_vm=${mm.dataVm} map_count=${mm.mapCount}；`
        + `GDB 重算 total=${refAccounting.totalPages} exec=${refAccounting.execPages} `
        + `stack=${refAccounting.stackPages} data=${refAccounting.dataPages} vmaCount=${refAccounting.vmaCount}；`
        + `VMA 条数 我们=${tree1.vmas.length}`
        + (accountingMismatches.length + bitMismatches.length === 0
          ? '' : `；明细：${[...accountingMismatches, ...bitMismatches].slice(0, 6).join(' | ')}`),
    );

    /* ---------- V7：VMA 权限串 vs lab 程序自己的 ELF program header ---------- */

    /**
     * 对照用的 ELF 必须是**客体真正执行的那一份**：客体把根切到了 virtio-blk 上的 ext2
     * 镜像 `artifacts/rootfs.img`（initramfs 里的 `/init` 只是 mount 它再 switch_root），
     * `/bin/lab-read` 是镜像里指向 `/bin/lab` 的符号链接。构建目录里那份内容上也一样，
     * 但"一样"要**证明**，所以这里用 debugfs 以只读方式把镜像里那份 dump 出来当对照，
     * 记下两边 sha256；debugfs 不可用才退回构建目录那份，并在证据里写明用的哪一份。
     *
     * 判据按 `fs/binfmt_elf.c` 的 `elf_map()` / `elf_load()` 原文逐行推：
     *   size = ELF_PAGEALIGN(p_filesz + ELF_PAGEOFFSET(p_vaddr))
     *   off  = p_offset - ELF_PAGEOFFSET(p_vaddr)
     * 于是每个 PT_LOAD 在运行进程里通常是**两条** VMA：
     *   1. 文件段 `[ELF_PAGESTART(p_vaddr), ELF_PAGEALIGN(p_vaddr + p_filesz))`：挂 vm_file，
     *      `vm_pgoff == off >> PAGE_SHIFT`；
     *   2. 匿名段（仅当 `p_memsz > p_filesz`）`[ELF_PAGEALIGN(p_vaddr + p_filesz),
     *      ELF_PAGEALIGN(p_vaddr + p_memsz))`：`vm_file == NULL`，由 `elf_load()` 末尾那次
     *      `vm_brk_flags()` 建出来。BSS 段**不会**并进文件段，因为 `vma_merge` 要求两侧
     *      `vm_file` 相同。老判据要求"一条 VMA 覆盖整个 `[页首, vaddr + p_memsz)`"，
     *      于是把这种正确的两段式布局判成"没有覆盖它的 VMA" —— 这就是 V7 第一次跑失败的原因。
     * 段尾巴之外紧邻的匿名 VMA（静态 glibc 启动时 `sbrk` 出来的堆）不属于任何 PT_LOAD，
     * 单列进证据，不算错。
     */
    const PAGE_MASK_4K = ~0xfffn;
    const pageAlign = (value) => (value + 0xfffn) & PAGE_MASK_4K;
    const fileSha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const elfCompare = { buildCopy: LAB_READ_ELF, imageCopy: null, used: LAB_READ_ELF, notes: [] };
    try {
      const dir = fs.mkdtempSync(path.join(tmpdir(), 't07c-elf-'));
      const dumped = path.join(dir, 'lab');
      execFileSync('debugfs', ['-R', `dump /bin/lab ${dumped}`, ROOTFS_IMG], { stdio: 'ignore' });
      const buildCopySha256 = fileSha256(LAB_READ_ELF);
      elfCompare.buildCopySha256 = buildCopySha256;
      elfCompare.imageCopy = {
        source: `${ROOTFS_IMG}:/bin/lab`,
        command: `debugfs -R "dump /bin/lab ${dumped}" ${ROOTFS_IMG}`,
        bytes: fs.statSync(dumped).size,
        sha256: fileSha256(dumped),
      };
      elfCompare.used = dumped;
      elfCompare.notes.push(elfCompare.imageCopy.sha256 === buildCopySha256
        ? '镜像里那份与构建目录那份 sha256 相同；仍用镜像里那份做对照（那才是客体执行的）'
        : `镜像里那份 sha256=${elfCompare.imageCopy.sha256} 与构建目录那份 ${buildCopySha256} `
          + '不同，改用镜像里那份做对照（客体跑的是它）');
    } catch (error) {
      elfCompare.notes.push(`debugfs dump 失败（${error.message}），退回构建目录那份做对照`);
    }
    const loadSegments = parseElfLoadSegments(
      execFileSync('readelf', ['-lW', elfCompare.used], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    );
    const segmentChecks = [];
    const segmentProblems = [];
    const adjacentAnonVmas = [];
    for (const segment of loadSegments) {
      const pageStart = segment.vaddr & PAGE_MASK_4K;
      const fileEnd = segment.filesz === 0n ? pageStart : pageAlign(segment.vaddr + segment.filesz);
      const memEnd = pageAlign(segment.vaddr + segment.memsz);
      const wantRead = segment.flags.includes('R');
      const wantWrite = segment.flags.includes('W');
      const wantExec = segment.flags.includes('E');
      const permissionsMatch = (permissions) => permissions[0] === (wantRead ? 'r' : '-')
        && permissions[1] === (wantWrite ? 'w' : '-')
        && permissions[2] === (wantExec ? 'x' : '-');
      const expectedFileOffset = segment.offset - (segment.vaddr & 0xfffn);
      const wantedPgoff = expectedFileOffset >> BigInt(PAGE_SHIFT);
      const record = {
        offset: hex(segment.offset), vaddr: hex(segment.vaddr), filesz: hex(segment.filesz),
        memsz: hex(segment.memsz), flags: segment.flags,
        expectFileVma: `${hex(pageStart)}..${hex(fileEnd)}`,
        expectAnonVma: segment.memsz > segment.filesz ? `${hex(fileEnd)}..${hex(memEnd)}` : null,
        expectedFileOffset: hex(expectedFileOffset),
        expectedPgoff: hex(wantedPgoff),
      };
      const problems = [];
      const fileVma = tree1.vmas.find((vma) => vma.vmStart === pageStart);
      if (fileVma === undefined) {
        problems.push(`文件段页首 ${hex(pageStart)} 上没有 VMA`);
      } else {
        record.fileVma = `${hex(fileVma.vmStart)}..${hex(fileVma.vmEnd)}`;
        record.fileVmaPermissions = fileVma.permissions;
        record.fileVmaFile = hexOrNull(fileVma.vmFile);
        record.fileVmaPgoff = hex(fileVma.vmPgoff);
        if (fileVma.vmFile === null) {
          problems.push('文件段那条 VMA 没挂 vm_file（`elf_map` 必然挂文件）');
        }
        if (fileVma.vmEnd !== fileEnd) {
          problems.push(`文件段终点应为 ELF_PAGEALIGN(p_vaddr+p_filesz)=${hex(fileEnd)}，实为 ${hex(fileVma.vmEnd)}`);
        }
        if (!permissionsMatch(fileVma.permissions)) {
          problems.push(`文件段权限 ${fileVma.permissions} 与段 flags「${segment.flags}」不符`);
        }
        if (fileVma.vmFile !== null && fileVma.vmPgoff !== wantedPgoff) {
          problems.push(`vm_pgoff 应为 ${hex(wantedPgoff)}`
            + `（= (${hex(segment.offset)} − ${hex(segment.vaddr & 0xfffn)}) >> 12），实为 ${hex(fileVma.vmPgoff)}`);
        }
        // 再用 `linear_page_index()` 的公式反推：这个虚拟地址折算成文件里的第几个字节
        if (fileVma.vmFile !== null
          && linearPageIndex(fileVma, segment.vaddr) * PAGE_SIZE !== expectedFileOffset) {
          problems.push(`linear_page_index(${hex(segment.vaddr)}) × 4096 = `
            + `${hex(linearPageIndex(fileVma, segment.vaddr) * PAGE_SIZE)}，`
            + `应为文件偏移 ${hex(expectedFileOffset)}`);
        }
      }
      if (segment.memsz > segment.filesz) {
        const anonVma = tree1.vmas.find((vma) => vma.vmStart === fileEnd);
        if (anonVma === undefined) {
          problems.push(`BSS 段起点 ${hex(fileEnd)} 上没有 VMA`);
        } else {
          record.anonVma = `${hex(anonVma.vmStart)}..${hex(anonVma.vmEnd)}`;
          record.anonVmaPermissions = anonVma.permissions;
          if (anonVma.vmEnd !== memEnd) {
            problems.push(`BSS 段终点应为 ELF_PAGEALIGN(p_vaddr+p_memsz)=${hex(memEnd)}，实为 ${hex(anonVma.vmEnd)}`);
          }
          if (anonVma.vmFile !== null) problems.push('BSS 段那条 VMA 挂了 vm_file（`vm_brk_flags` 建的一定匿名）');
          if (!permissionsMatch(anonVma.permissions)) {
            problems.push(`BSS 段权限 ${anonVma.permissions} 与段 flags「${segment.flags}」不符`);
          }
        }
      } else if (fileEnd !== memEnd) {
        problems.push(`filesz == memsz 时页对齐后 ${hex(fileEnd)} ≠ ${hex(memEnd)}：判据自身有问题`);
      }
      // 整段每一页都要落在 VMA 里，且落在段内的每一页权限都与段 flags 一致
      const uncovered = [];
      const permissionMismatch = [];
      for (let page = pageStart; page < memEnd; page += PAGE_SIZE) {
        const vma = findVmaForAddress(tree1.vmas, page);
        if (vma === null) { uncovered.push(hex(page)); continue; }
        if (!permissionsMatch(vma.permissions)) permissionMismatch.push(`${hex(page)}:${vma.permissions}`);
      }
      record.uncoveredPages = uncovered;
      record.permissionMismatchPages = permissionMismatch;
      if (uncovered.length > 0) {
        problems.push(`段内有 ${uncovered.length} 页没有 VMA：${uncovered.slice(0, 4).join(' ')}`);
      }
      if (permissionMismatch.length > 0) {
        problems.push(`段内有 ${permissionMismatch.length} 页权限不符：${permissionMismatch.slice(0, 4).join(' ')}`);
      }
      const neighbor = tree1.vmas.find((vma) => vma.vmStart === memEnd && vma.vmFile === null);
      if (neighbor !== undefined) {
        record.adjacentAnonVma = `${hex(neighbor.vmStart)}..${hex(neighbor.vmEnd)}`;
        adjacentAnonVmas.push({
          after: `${hex(memEnd)}`, range: `${hex(neighbor.vmStart)}..${hex(neighbor.vmEnd)}`,
          permissions: neighbor.permissions,
        });
      }
      record.problems = problems;
      record.ok = problems.length === 0;
      segmentProblems.push(...problems.map((text) => `段 ${segment.flags}@${hex(segment.vaddr)}：${text}`));
      segmentChecks.push(record);
    }
    evidence.stop1.elfSegments = {
      elf: elfCompare.used,
      elfCompare,
      segments: segmentChecks,
      problems: segmentProblems,
      adjacentAnon: adjacentAnonVmas,
      notes: [
        '每个 PT_LOAD 在进程里是"文件段 + 匿名 BSS 段"两条 VMA：`elf_map()` 只映射文件那部分'
          + '（`ELF_PAGEALIGN(p_filesz + 页内偏移)`），剩下的由 `elf_load()` 末尾的 `vm_brk_flags()`'
          + '建匿名段；`vma_merge` 要求 `vm_file` 相同，所以两者不会合并',
        '段尾巴之外紧邻的匿名 VMA 是静态 glibc 启动时 `sbrk` 出来的堆，不属于任何 PT_LOAD',
      ],
    };
    check(
      'T07c-V7 我们的 VMA 与 lab-read 自己的 ELF program header 逐段对得上（对照用的 ELF 就是客体磁盘镜像里的那一份，sha256 与构建目录那份也比过）：每个 PT_LOAD 的文件段恰好是一条挂 `vm_file` 的 VMA —— 起点是段页首、终点按 elf_map 的 `ELF_PAGEALIGN(p_filesz + 页内偏移)` 算出、权限三位与段 flags 一致、`vm_pgoff` 等于 `(p_offset − 页内偏移) >> 12`、按 `linear_page_index()` 反推的文件偏移也对；`p_memsz > p_filesz` 时紧邻的匿名 BSS 段也是一条 VMA（不挂文件、终点按 `ELF_PAGEALIGN(p_memsz + 页内偏移)`）；整段每一页都有 VMA 且权限一致',
      loadSegments.length >= 2 && segmentChecks.length === loadSegments.length
        && segmentProblems.length === 0
        && segmentChecks.every((entry) => entry.ok === true),
      `PT_LOAD ${loadSegments.length} 段，对照 ${elfCompare.used}`
        + `（镜像那份 sha256=${(elfCompare.imageCopy?.sha256 ?? '未取到').slice(0, 16)}…，`
        + `构建目录那份 sha256=${(elfCompare.buildCopySha256 ?? '未取到').slice(0, 16)}…，`
        + `${elfCompare.notes.join('；')}）：`
        + `${segmentChecks.map((entry) => `${entry.flags}@${entry.vaddr} 文件段${entry.fileVma ?? '缺'}`
          + `(${entry.fileVmaPermissions ?? '—'} pgoff=${entry.fileVmaPgoff ?? '—'}/期望${entry.expectedPgoff})`
          + `${entry.expectAnonVma === null ? ' 无 BSS 段' : ` BSS段${entry.anonVma ?? '缺'}`}`
          + `${entry.ok === true ? ' 一致' : ` ✗${entry.problems.join('；')}`}`).join(' | ')}`
        + `；段外紧邻的匿名 VMA（堆）：${adjacentAnonVmas.map((entry) => entry.range).join(' ') || '无'}`,
    );

    /* ---------- 挑一个确实指向文件页的线性地址（V8/V9/V10 共用） ---------- */

    /**
     * 为什么要"挑"而不是直接用 `mm.start_code`：`start_code` 是 ELF 里第一个可执行
     * PT_LOAD 的 `p_vaddr`，它是**最可能**指向文件页的地址，但不是保证 —— 这段页有可能
     * 被写时复制过、也可能因为别的原因不再挂着 address_space。所以这里按候选顺序逐个
     * 用**我们自己的**代码探（走页表 + 读 struct page），第一个"页表可达、mapping 非 0
     * 且不是匿名页"的地址才采用，并把每一次试探的结果原样记进证据（失败原因也记）。
     */
    const candidates = [];
    const pushCandidate = (address, note) => {
      if (address === null || address === undefined || address === 0n) return;
      if (candidates.some((entry) => entry.address === address)) return;
      candidates.push({ address, note });
    };
    pushCandidate(mm.startCode, 'mm_struct.start_code');
    for (const segment of loadSegments.filter((entry) => entry.flags.includes('E'))) {
      pushCandidate(segment.vaddr & PAGE_MASK_4K, 'ELF 可执行 PT_LOAD 段的起始页');
    }
    for (const segment of loadSegments) {
      pushCandidate(segment.vaddr & PAGE_MASK_4K, 'ELF PT_LOAD 段的起始页');
    }
    pushCandidate(mm.startCode + PAGE_SIZE, 'start_code 之后一页');

    const candidateTries = [];
    let accepted = null;
    let filePageWalk = null;
    let filePageVma = null;
    let filePageFolio = null;
    let filePageVmemmap = null;
    for (const candidate of candidates) {
      const record = { address: hex(candidate.address), note: candidate.note };
      const vma = findVmaForAddress(tree1.vmas, candidate.address);
      if (vma === null) {
        record.result = '这个地址不落在任何 VMA 里（空洞）';
        candidateTries.push(record);
        continue;
      }
      record.vma = `[${hex(vma.vmStart)},${hex(vma.vmEnd)}) ${vma.permissions}`;
      if (vma.vmFile === null) {
        record.result = '这条 VMA 是匿名映射（vm_file 为 0），不是文件页';
        candidateTries.push(record);
        continue;
      }
      const walk = await walkPageTable(view1, {
        pgd: mm.pgd, linear: candidate.address, pageOffsetBase, levels: 4, rootPhysical,
      });
      record.physical = hexOrNull(walk.physical);
      record.fault = walk.fault === null ? null : walk.fault.kind;
      if (walk.physical === null) {
        record.result = `页表走不到物理地址（${walk.fault?.kind ?? '没给原因'}）`;
        candidateTries.push(record);
        continue;
      }
      const pfn = walk.physical >> BigInt(PAGE_SHIFT);
      const vmemmap = await resolveVmemmapBase(view1, layout, { pfn });
      const folio = await readFolioForPfn(view1, layout, { pfn, vmemmap });
      record.pfn = hex(pfn);
      record.mapping = hex(folio.mapping);
      record.mappingIsAnon = folio.mappingIsAnon;
      record.refcount = folio.refcount;
      record.index = folio.index.toString();
      if (folio.mapping !== 0n && folio.mappingIsAnon === false) {
        record.result = '采用：mapping 指向一个 address_space（文件页）';
        record.accepted = true;
        candidateTries.push(record);
        accepted = candidate;
        filePageWalk = walk;
        filePageVma = vma;
        filePageFolio = folio;
        filePageVmemmap = vmemmap;
        break;
      }
      record.result = `mapping=${hex(folio.mapping)}（anon=${folio.mappingIsAnon}），不是文件页`;
      candidateTries.push(record);
    }
    if (accepted === null) {
      throw new Error(`停点一上找不到一个指向文件页的线性地址：${JSON.stringify(candidateTries)}`);
    }
    /**
     * 第二次 GDB 参照。
     *
     * 第一次（`ref1`）在 Part-2 就跑完了，但它带着 `pfn = 0` —— GDB 那边看到 pfn 为 0
     * 就**不**解 vmemmap、也不读 `struct page`（那是刻意的：0 号页框在 x86 上不存在，
     * 拿它当"随便给个页框"会读出一段无意义的内存）。V8 要比的正是"同一个地址的页表遍历"
     * 与 V9/V10 要的 vmemmap/struct page，所以这里带着真实地址与真实 PFN 再跑一次，
     * 结果覆盖 `refDataA`。这样 GDB 侧的**类型、偏移、sizeof、%gs 基址路径**仍然全是它
     * 自己的解释，只是输入参数换成了真实值。
     */
    const ref1HasPfn = refData1.vmemmap !== null && refData1.vmemmap !== undefined;
    const refA = ref1HasPfn && accepted.address === mm.startCode
      ? { ok: true, data: refData1, reused: 'stop1' }
      : await runReference(live, 'stop1b', {
        va: accepted.address, va2: 0n, pfn: filePageFolio.pfn, mm: mmAddress, cr3: cr3Frame ?? 0n,
      });
    if (!refA.ok) {
      log(`GDB 侧参照（文件页地址 ${hex(accepted.address)} + PFN ${hex(filePageFolio.pfn)}）失败：${refA.error}`);
    }
    const refDataA = refA.ok ? refA.data : {};

    /* ---------- V8：同一个线性地址的页表遍历四方一致 ---------- */

    const gvaText = await live.qmp.hmp(`gva2gpa ${toSigned64(accepted.address)}`, { timeoutMs: 180000 });
    const gvaPhysical = parseGva2gpa(gvaText);
    const serviceA = await serviceTranslate(app, base, accepted.address, frame1.captureId);
    const refCompare = compareWalkWithReference(filePageWalk, refDataA.translation ?? null);
    const serviceCompare = serviceA.ok
      ? compareWalkWithService(filePageWalk, serviceA.translation)
      : { mismatches: [`服务 translate 调用失败：${serviceA.error}`], compared: 0 };
    const gvaOk = typeof gvaPhysical === 'bigint' && gvaPhysical === filePageWalk.physical;
    evidence.stop1.filePage = {
      chosen: hex(accepted.address),
      chosenNote: accepted.note,
      isStartCode: accepted.address === mm.startCode,
      tries: candidateTries,
      referenceRun: refA.reused === 'stop1' ? 'reused-stop1' : 'stop1b',
      referenceError: refA.ok ? null : refA.error,
      vma: {
        start: hex(filePageVma.vmStart), end: hex(filePageVma.vmEnd),
        permissions: filePageVma.permissions, file: hexOrNull(filePageVma.vmFile),
        pgoff: hex(filePageVma.vmPgoff),
      },
      walk: {
        physical: hexOrNull(filePageWalk.physical),
        pageSizeBytes: filePageWalk.pageSizeBytes === null ? null : filePageWalk.pageSizeBytes.toString(),
        huge: filePageWalk.huge,
        rootLinear: hexOrNull(filePageWalk.rootLinear),
        rootPhysical: hexOrNull(filePageWalk.rootPhysical),
        fault: filePageWalk.fault,
        levels: filePageWalk.walk.map((entry) => ({
          name: entry.name, index: entry.index, entryLinear: hex(entry.entryLinear),
          entryPhysical: hexOrNull(entry.entryPhysical), raw: hex(entry.raw),
          targetPhysical: hexOrNull(entry.targetPhysical), present: entry.flags.present,
          flagNames: entry.flagNames,
        })),
        notes: filePageWalk.notes,
      },
      reference: refA.ok ? (refDataA.translation ?? null) : { error: refA.error },
      service: serviceA.ok ? serviceA.translation : { error: serviceA.error },
      gva2gpa: {
        argument: toSigned64(accepted.address).toString(),
        raw: String(gvaText).trim(),
        physical: hexOrNull(gvaPhysical),
      },
      compare: { reference: refCompare, service: serviceCompare },
    };
    check(
      'T07c-V8 同一个线性地址的页表遍历四方一致（我们 / GDB 参照自己重写的遍历 / 服务的 translate / QEMU 的 gva2gpa）：逐级条目所在的物理地址、条目原始值、指向的物理地址、最终物理地址与页大小全部相同；这次走的是 4 级表、4 KiB 页，不是大页',
      refA.ok === true && refCompare.mismatches.length === 0 && serviceCompare.mismatches.length === 0
        && gvaOk && filePageWalk.walk.length === 4 && filePageWalk.huge === false
        && filePageWalk.pageSizeBytes === PAGE_SIZE
        && filePageWalk.rootPhysical === rootPhysical,
      `地址=${hex(accepted.address)}（${accepted.note}）物理=${hexOrNull(filePageWalk.physical)} `
        + `页大小=${filePageWalk.pageSizeBytes} 大页=${filePageWalk.huge} 级数=${filePageWalk.walk.length}；`
        + `我们 vs GDB 参照：比对 ${refCompare.compared} 项，不一致 ${refCompare.mismatches.length}；`
        + `我们 vs 服务 translate：比对 ${serviceCompare.compared} 项，不一致 ${serviceCompare.mismatches.length}；`
        + `gva2gpa：${String(gvaText).trim()}`
        + (refCompare.mismatches.length + serviceCompare.mismatches.length === 0
          ? '' : `；明细：${[...refCompare.mismatches, ...serviceCompare.mismatches].slice(0, 6).join(' | ')}`),
    );

    /* ---------- V9：PFN → struct page 的 vmemmap 基址 ---------- */

    const cr3Pfn = rootPhysical === null ? null : (rootPhysical >> BigInt(PAGE_SHIFT));
    const cr3Vmemmap = cr3Pfn === null ? null : await resolveVmemmapBase(view1, layout, { pfn: cr3Pfn });
    const cr3Folio = cr3Pfn === null
      ? null : await readFolioForPfn(view1, layout, { pfn: cr3Pfn, vmemmap: cr3Vmemmap });
    const refVmemmap = refDataA.vmemmap ?? null;
    const refCr3Folio = refDataA.cr3FramePage ?? null;
    const pageStructSize = structPageSizeOf(layout);
    const vmemmapFieldMismatches = [];
    if (refVmemmap !== null && refVmemmap !== undefined && refVmemmap.base !== undefined) {
      const fieldPairs = [
        ['pageStructSize', refVmemmap.pageStructSize, filePageVmemmap.pageStructSize],
        ['sectionNumber', refVmemmap.sectionNumber, filePageVmemmap.sectionNumber],
        ['sectionStartPfn', refVmemmap.sectionStartPfn, filePageVmemmap.sectionStartPfn],
        ['sectionArray', refVmemmap.sectionArray, filePageVmemmap.sectionArray],
        ['sectionAddress', refVmemmap.sectionAddress, filePageVmemmap.sectionAddress],
        ['sectionMemMapRaw', refVmemmap.sectionMemMapRaw, filePageVmemmap.sectionMemMapRaw],
      ];
      for (const [name, refValue, mineValue] of fieldPairs) {
        if (refValue === null || refValue === undefined
          || mineValue === null || mineValue === undefined) continue;
        if (String(asBig(refValue)) !== String(mineValue)) {
          vmemmapFieldMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      if (asBig(refVmemmap.base) !== filePageVmemmap.base) {
        vmemmapFieldMismatches.push(
          `base：我们=${hex(filePageVmemmap.base)} GDB=${hex(asBig(refVmemmap.base))}`,
        );
      }
      // 闭合式：`mem_map` 必须正好是"vmemmap 基址 + 本节起始页框 × 每页宽度"。
      if (refVmemmap.memMap === null || refVmemmap.memMap === undefined
        || asBig(refVmemmap.memMap) !== filePageVmemmap.base
          + filePageVmemmap.sectionStartPfn * pageStructSize) {
        vmemmapFieldMismatches.push(
          `mem_map 不闭合：我们推出=${hex(filePageVmemmap.base
            + filePageVmemmap.sectionStartPfn * pageStructSize)} GDB=${refVmemmap.memMap ?? '缺'}`,
        );
      }
      if (refVmemmap.markedPresent !== true || refVmemmap.hasMemMap !== true) {
        vmemmapFieldMismatches.push(
          `GDB 侧 present/has_mem_map 不是都立着：present=${refVmemmap.markedPresent} `
          + `has_mem_map=${refVmemmap.hasMemMap}`,
        );
      }
    } else {
      vmemmapFieldMismatches.push('GDB 侧没有给出 vmemmap 的解（带了真实 PFN 跑过之后不该缺）');
    }
    evidence.stop1.vmemmap = {
      filePage: {
        pfn: hex(filePageFolio.pfn), source: filePageVmemmap.source,
        base: hex(filePageVmemmap.base),
        matchesCompiledDefault: filePageVmemmap.matchesCompiledDefault,
        pageStructSize: filePageVmemmap.pageStructSize.toString(),
        sectionNumber: filePageVmemmap.sectionNumber.toString(),
        sectionStartPfn: filePageVmemmap.sectionStartPfn.toString(),
        sectionArray: hexOrNull(filePageVmemmap.sectionArray),
        sectionAddress: hexOrNull(filePageVmemmap.sectionAddress),
        sectionMemMapRaw: hexOrNull(filePageVmemmap.sectionMemMapRaw),
        sectionMarkedPresent: filePageVmemmap.sectionMarkedPresent,
        sectionHasMemMap: filePageVmemmap.sectionHasMemMap,
        notes: filePageVmemmap.notes,
      },
      cr3Page: cr3Vmemmap === null ? null : {
        pfn: hex(cr3Pfn), source: cr3Vmemmap.source, base: hex(cr3Vmemmap.base),
        sectionNumber: cr3Vmemmap.sectionNumber.toString(),
        matchesCompiledDefault: cr3Vmemmap.matchesCompiledDefault,
      },
      compiledDefault: hex(VMEMMAP_BASE_L4),
      gdb: refVmemmap,
      mismatches: vmemmapFieldMismatches,
    };
    check(
      'T07c-V9 PFN→struct page 的 vmemmap 基址三路一致：我们按 mem_section 现场解出的值（文件页 PFN 与 CR3 页 PFN 各解一次，两次基址相同、来源都是 mem-section）、GDB 用真正的 sizeof(struct mem_section) 解出的值、以及编译期常量 __VMEMMAP_BASE_L4；section 的 present/has_mem_map 两位都立着，mem_map 与"基址 + 本节起始页框 × 每页宽度"闭合',
      filePageVmemmap.source === 'mem-section'
        && filePageVmemmap.base === VMEMMAP_BASE_L4
        && filePageVmemmap.matchesCompiledDefault === true
        && filePageVmemmap.sectionMarkedPresent === true
        && filePageVmemmap.sectionHasMemMap === true
        && filePageVmemmap.pageStructSize === pageStructSize
        && cr3Vmemmap !== null && cr3Vmemmap.source === 'mem-section'
        && cr3Vmemmap.base === filePageVmemmap.base
        && vmemmapFieldMismatches.length === 0,
      `我们：文件页 PFN=${hex(filePageFolio.pfn)} 解出 base=${hex(filePageVmemmap.base)}`
        + `（来源=${filePageVmemmap.source}，section=${filePageVmemmap.sectionNumber}，起始页框=${filePageVmemmap.sectionStartPfn}，`
        + `present=${filePageVmemmap.sectionMarkedPresent} has_mem_map=${filePageVmemmap.sectionHasMemMap}）；`
        + `CR3 页 PFN=${cr3Pfn === null ? '缺' : hex(cr3Pfn)} 解出 base=${cr3Vmemmap === null ? '缺' : hex(cr3Vmemmap.base)}；`
        + `编译期常量 __VMEMMAP_BASE_L4=${hex(VMEMMAP_BASE_L4)}；`
        + `GDB 解出 base=${refVmemmap === null || refVmemmap.base === undefined ? '缺' : hex(asBig(refVmemmap.base))}`
        + `（它自己的 sizeof(struct mem_section)=${refVmemmap?.memSectionSize ?? '缺'}，`
        + `SECTIONS_PER_ROOT=${refVmemmap?.sectionsPerRoot ?? '缺'}）；`
        + `struct page 宽度 我们=${pageStructSize} GDB=${refVmemmap?.pageStructSize ?? '缺'}；`
        + `字段不一致 ${vmemmapFieldMismatches.length}`
        + (vmemmapFieldMismatches.length === 0
          ? '' : `；明细：${vmemmapFieldMismatches.slice(0, 6).join(' | ')}`),
    );

    /* ---------- V9b：页表页的身份就在页面自己身上（顶层是例外） ---------- */

    /**
     * 6.12 把"这一页是页表页"这个身份**存在页面自己身上**：`struct page.page_type` 的高 8 位
     * （`page-flags.h` 的 `PAGE_TYPE_OPS(Table, table, pgtable)` → `page->page_type =
     * (unsigned int)PGTY_table << 24`），分配页表时由 `pagetable_pte_ctor()` 打上
     * （`include/linux/mm.h`：`__folio_set_pgtable(folio)`），释放时被 `pagetable_dtor()`
     * 清回 `UINT_MAX`（"没有类型"，同文件 `FOLIO_TYPE_OPS` 的 clear 分支）。
     * 所以这件事可以**读**出来，不必从"我们在遍历页表"去推断。
     *
     * 更值一提的是**顶层那一页是例外**：x86_64 的 `_pgd_alloc()` 只是
     * `__get_free_pages(GFP_PGTABLE_USER, PGD_ALLOCATION_ORDER)`，**不经过**
     * `pagetable_pte_ctor`，于是 CR3 指的顶层 pgd 页 `page_type` 一直是"没有类型"。
     * 老判据把顶层页当成 `PGTY_table`，结果是"我们的读数和参照读数都正确，却双双被判成错" ——
     * V9b 第一次跑失败就是栽在这个过时假设上。现在两层都断言：顶层无类型、下三级是表页。
     */
    // `pageFlagsText` 上面 V3 已经读进来了（同一个作用域，不能重复声明），这里直接用。
    const mmText = fs.readFileSync(LINUX_MM_H, 'utf8');
    const x86PgtableText = fs.readFileSync(X86_PGTABLE_C, 'utf8');
    const pgdAllocAt = x86PgtableText.lastIndexOf('static inline pgd_t *_pgd_alloc(void)');
    const pgdAllocBody = pgdAllocAt < 0
      ? null : x86PgtableText.slice(pgdAllocAt, x86PgtableText.indexOf('\n}', pgdAllocAt) + 2);
    const ctorAt = mmText.indexOf('static inline bool pagetable_pte_ctor(');
    const ctorBody = ctorAt < 0 ? null : mmText.slice(ctorAt, mmText.indexOf('\n}', ctorAt) + 2);
    const pgdPageTypeFacts = {
      hasTypeExpression: (/return\s+page_type\s*<\s*\(\s*PGTY_mapcount_underflow\s*<<\s*24\s*\)/.exec(pageFlagsText) ?? [])[0] ?? null,
      setterExpression: (/page->page_type\s*=\s*\(unsigned int\)PGTY_##lname\s*<<\s*24/.exec(pageFlagsText) ?? [])[0] ?? null,
      clearExpression: (/\bpage->page_type\s*=\s*UINT_MAX/.exec(pageFlagsText) ?? [])[0] ?? null,
      tableOpsInstantiation: (/^PAGE_TYPE_OPS\(Table,\s*table,\s*pgtable\)/m.exec(pageFlagsText) ?? [])[0] ?? null,
      ctorBody,
      ctorCallsSetPgtable: ctorBody !== null && /__folio_set_pgtable\s*\(\s*folio\s*\)/.test(ctorBody),
      pgdAllocBody,
      pgdAllocUsesGetFreePages: pgdAllocBody !== null
        && /__get_free_pages\s*\(\s*GFP_PGTABLE_USER/.test(pgdAllocBody),
      pgdAllocMentionsPteCtor: pgdAllocBody !== null && /pagetable_pte_ctor/.test(pgdAllocBody),
    };
    const tableTypeCode = pgdPageTypeFacts.tableOpsInstantiation === null ? null
      : (parseEnumPagetype(pageFlagsText).find((entry) => entry.name === 'PGTY_table')?.code ?? null);
    const noTypeCode = parseEnumPagetype(pageFlagsText)
      .find((entry) => entry.name === 'PGTY_mapcount_underflow')?.code ?? null;
    const noTypeValue = noTypeCode === null ? null : 0xffffffff;

    /** 页表页：从我们这次遍历的每一级（非叶子）条目取出它指向的那张表，读页面自己身上的类型。 */
    const tablePageRecords = [];
    for (const entry of filePageWalk.walk) {
      if (entry.terminal === true || entry.targetPhysical === null || entry.targetPhysical === undefined) continue;
      const pfn = entry.targetPhysical >> BigInt(PAGE_SHIFT);
      const folio = filePageVmemmap === null ? null
        : await readFolioForPfn(view1, layout, { pfn, vmemmap: filePageVmemmap });
      const refRow = (refDataA.tablePages ?? []).find((row) => asBig(row.framePhysical) === entry.targetPhysical);
      tablePageRecords.push({
        level: entry.level, name: entry.name,
        framePhysical: hex(entry.targetPhysical), pfn: hex(pfn),
        pageAddress: folio === null ? null : hex(folio.address),
        pageType: folio?.pageType ?? null,
        pageTypeCode: folio?.pageTypeCode ?? null,
        pageTypeName: folio?.pageTypeName ?? null,
        pageTypeIsType: folio?.pageTypeIsType ?? null,
        refPageAddress: refRow?.page === undefined ? null : hexOrNull(asBig(refRow.page.address)),
        refPageType: refRow?.page?.pageType ?? null,
        refPageTypeCode: refRow?.page?.pageTypeCode ?? null,
        refPageTypeHasType: refRow?.page?.pageTypeHasType ?? null,
      });
    }
    const cr3NoType = cr3Folio !== null && noTypeValue !== null
      && cr3Folio.pageType === noTypeValue && cr3Folio.pageTypeIsType === false;
    const refCr3NoType = refCr3Folio !== null && refCr3Folio !== undefined && noTypeValue !== null
      && Number(refCr3Folio.pageType) === noTypeValue && refCr3Folio.pageTypeHasType === false;
    const tablePagesOk = tablePageRecords.length >= 3 && tableTypeCode !== null
      && tablePageRecords.every((row) => row.pageTypeCode === tableTypeCode
        && row.pageTypeIsType === true
        && row.refPageTypeCode === tableTypeCode
        && row.refPageType === row.pageType
        && row.refPageAddress === row.pageAddress);
    evidence.stop1.pageTypeChain = {
      source: pgdPageTypeFacts,
      tableTypeCodeFromSource: tableTypeCode,
      noTypeCodeFromSource: noTypeCode,
      noTypeValue,
      cr3: {
        pfn: cr3Pfn === null ? null : hex(cr3Pfn),
        pageAddress: cr3Folio === null ? null : hex(cr3Folio.address),
        pageType: cr3Folio?.pageType ?? null,
        pageTypeIsType: cr3Folio?.pageTypeIsType ?? null,
        refPageType: refCr3Folio?.pageType ?? null,
        refPageTypeHasType: refCr3Folio?.pageTypeHasType ?? null,
        refPageAddress: refCr3Folio?.address === undefined ? null : hexOrNull(asBig(refCr3Folio.address)),
      },
      tablePages: tablePageRecords,
    };
    check(
      'T07c-V9b 页表页的身份就在页面自己身上，而且顶层是例外：CR3 指的顶层 pgd 页 `page_type` 是"没有类型"的 0xffffffff（`page_type_has_type()` 为假），因为 x86_64 的 `_pgd_alloc()` 只调 `__get_free_pages(GFP_PGTABLE_USER, …)`、不走 `pagetable_pte_ctor()`（现场重解析 pgtable.c / mm.h / page-flags.h 得证）；而这次遍历用到的下三级表页每一页 `page_type >> 24` 都等于源码里的 `PGTY_table`（0xf2），也即"这一页是页表页"；以上每一项都与 GDB 用自己 DWARF 读出的同一页框逐字段相同',
      pgdPageTypeFacts.hasTypeExpression !== null
        && pgdPageTypeFacts.setterExpression !== null
        && pgdPageTypeFacts.clearExpression !== null
        && pgdPageTypeFacts.tableOpsInstantiation !== null
        && pgdPageTypeFacts.ctorCallsSetPgtable === true
        && pgdPageTypeFacts.pgdAllocUsesGetFreePages === true
        && pgdPageTypeFacts.pgdAllocMentionsPteCtor === false
        && tableTypeCode === 0xf2 && noTypeCode === 0xff
        && cr3NoType && refCr3NoType
        && asBig(refCr3Folio.flags) === cr3Folio.flags
        && Number(refCr3Folio.refcount) === cr3Folio.refcount
        && asBig(refCr3Folio.address) === cr3Folio.address
        && cr3Folio.address === pageAddressForPfn(cr3Vmemmap.base, cr3Folio.pfn, pageStructSize)
        && tablePagesOk
        && filePageWalk.huge === false,
      `源码：PGTY_table=0x${(tableTypeCode ?? 0).toString(16)} 无类型=0x${(noTypeValue ?? 0).toString(16)} `
        + `（page_type_has_type：${pgdPageTypeFacts.hasTypeExpression ?? '没找到'}；`
        + `设置：${pgdPageTypeFacts.setterExpression ?? '没找到'}；`
        + `清除：${pgdPageTypeFacts.clearExpression ?? '没找到'}；`
        + `pagetable_pte_ctor 调 __folio_set_pgtable=${pgdPageTypeFacts.ctorCallsSetPgtable}；`
        + `_pgd_alloc 用 __get_free_pages=${pgdPageTypeFacts.pgdAllocUsesGetFreePages} `
        + `提及 pagetable_pte_ctor=${pgdPageTypeFacts.pgdAllocMentionsPteCtor}）；`
        + `CR3=${hexOrNull(rootPhysical)} → 页框=${cr3Pfn === null ? '缺' : hex(cr3Pfn)}：`
        + `我们 page_type=0x${(cr3Folio?.pageType ?? 0).toString(16)}（hasType=${cr3Folio?.pageTypeIsType ?? '缺'}）`
        + ` GDB page_type=0x${(refCr3Folio?.pageType ?? 0).toString(16)}（hasType=${refCr3Folio?.pageTypeHasType ?? '缺'}）；`
        + `下三级表页 ${tablePageRecords.length} 张：`
        + `${tablePageRecords.map((row) => `${row.name}@${row.framePhysical}→`
          + `0x${(row.pageType ?? 0).toString(16)}/${row.pageTypeName ?? '缺'}`
          + `(GDB 0x${(row.refPageType ?? 0).toString(16)})`).join(' ')}`
        + `；页表页读数${tablePagesOk ? '逐字段一致' : '有不一致'}`,
    );

    /* ---------- V10：文件页 folio（mapping / index） ---------- */

    /**
     * 文件页的证据链有三段，缺一段都不成立：
     *
     * 1. `page->mapping` 必须等于 `file->f_mapping`（也就是 `inode->i_mapping`）。
     *    只断言"mapping 非 0 且不是匿名页"是不够的 —— 一个指向别处的指针同样满足。
     *    这里现读 `vm_area_struct.vm_file` 指的那个 `struct file` 的 `f_mapping` 字段。
     * 2. `page->index` 必须等于 `linear_page_index(vma, address)`。这个公式是
     *    `include/linux/pagemap.h` 里三行代码，现场重解析一遍（减 vm_start、右移
     *    PAGE_SHIFT、加 vm_pgoff），免得"抄错符号"把每个文件页都算到错误偏移上 ——
     *    抄错之后读出来的 index 仍是个正常的页号，肉眼看不出来。
     * 3. `struct file` 的 `f_mapping` 偏移、`struct page` 的 `mapping`/`index` 偏移，
     *    GDB 用它自己的 DWARF 再读一遍，逐字段对。
     */
    const linearPageIndexSource = readLinearPageIndexSource(fs.readFileSync(PAGEMAP_H, 'utf8'));
    const fileMappingOffset = layout.has('file') && layout.hasField('file', 'f_mapping')
      ? BigInt(layout.byteOffset('file', 'f_mapping'))
      : (refDataA.layout?.file?.f_mapping === undefined
        ? null : BigInt(refDataA.layout.file.f_mapping));
    const fileMapping = fileMappingOffset === null || filePageVma.vmFile === null
      ? null : await view1.u64(filePageVma.vmFile + fileMappingOffset);
    const refFolioFile = refDataA.folioAtVa ?? null;
    const expectedIndex = linearPageIndex(filePageVma, accepted.address);
    const folioFieldMismatches = [];
    if (refFolioFile !== null && refFolioFile !== undefined) {
      const pairs = [
        ['address', refFolioFile.address, filePageFolio.address],
        ['flags', refFolioFile.flags, filePageFolio.flags],
        ['mapping', refFolioFile.mapping, filePageFolio.mapping],
        ['index', refFolioFile.index, filePageFolio.index],
      ];
      for (const [name, refValue, mineValue] of pairs) {
        if (refValue === null || refValue === undefined) continue;
        if (String(asBig(refValue)) !== String(mineValue)) {
          folioFieldMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      for (const [name, refValue, mineValue] of [
        ['refcount', refFolioFile.refcount, filePageFolio.refcount],
        ['mapcount', refFolioFile.mapcount, filePageFolio.mapcount],
        ['pageType', refFolioFile.pageType, filePageFolio.pageType],
      ]) {
        if (refValue === null || refValue === undefined || mineValue === null) continue;
        if (Number(refValue) !== Number(mineValue)) {
          folioFieldMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      if (refFolioFile.mappingIsAnon !== filePageFolio.mappingIsAnon) {
        folioFieldMismatches.push(
          `mappingIsAnon：我们=${filePageFolio.mappingIsAnon} GDB=${refFolioFile.mappingIsAnon}`,
        );
      }
      if (refFolioFile.isTail !== filePageFolio.isTail) {
        folioFieldMismatches.push(`isTail：我们=${filePageFolio.isTail} GDB=${refFolioFile.isTail}`);
      }
    } else {
      folioFieldMismatches.push('GDB 侧没有给出这个地址对应的 struct page（folioAtVa 缺失）');
    }
    evidence.stop1.fileFolio = {
      address: hex(filePageFolio.address),
      pfn: hex(filePageFolio.pfn),
      pageStructSize: filePageFolio.pageStructSize.toString(),
      index: filePageFolio.index.toString(),
      expectedIndex: expectedIndex.toString(),
      mapping: hex(filePageFolio.mapping),
      mappingIsAnon: filePageFolio.mappingIsAnon,
      fileAddress: hexOrNull(filePageVma.vmFile),
      fileMappingOffset: fileMappingOffset === null ? null : fileMappingOffset.toString(),
      fileMapping: hexOrNull(fileMapping),
      pageType: filePageFolio.pageType,
      pageTypeCode: filePageFolio.pageTypeCode,
      pageTypeName: filePageFolio.pageTypeName,
      pageTypeIsType: filePageFolio.pageTypeIsType,
      refcount: filePageFolio.refcount,
      mapcount: filePageFolio.mapcount,
      pageFlags: filePageFolio.pageFlags,
      isTail: filePageFolio.isTail,
      compoundHeadAddress: hexOrNull(filePageFolio.compoundHeadAddress),
      linearPageIndexSource,
      gdb: refFolioFile,
      mismatches: folioFieldMismatches,
      notes: filePageFolio.notes,
    };
    check(
      'T07c-V10 文件页的 folio 三方对得上：`page->mapping` 正好等于 `vm_file->f_mapping`（同一把地址空间），`page->index` 正好等于按 `include/linux/pagemap.h` 的 `linear_page_index()` 现场重解析出的公式算出的值（减 vm_start、右移 PAGE_SHIFT、加 vm_pgoff），并且这一页不是匿名页；GDB 用自己 DWARF 读的同一页 flags/mapping/index/refcount/page_type 与我们的完全相同',
      linearPageIndexSource !== null
        && linearPageIndexSource.subtractsVmStart === true
        && linearPageIndexSource.shiftsByPageShift === true
        && linearPageIndexSource.addsVmPgoff === true
        && fileMapping !== null && filePageFolio.mapping === fileMapping
        && filePageFolio.mappingIsAnon === false
        && filePageFolio.index === expectedIndex
        && folioFieldMismatches.length === 0,
      `地址=${hex(accepted.address)} PFN=${hex(filePageFolio.pfn)} struct page=${hex(filePageFolio.address)}；`
        + `mapping 我们=${hex(filePageFolio.mapping)} file->f_mapping=${hexOrNull(fileMapping)}`
        + `（偏移来自${layout.has('file') ? '我们的布局' : 'GDB 的 DWARF'}=${fileMappingOffset}）；`
        + `index 我们=${filePageFolio.index} 公式算出=${expectedIndex}（源码三要素 `
        + `减 vm_start=${linearPageIndexSource?.subtractsVmStart} 右移=${linearPageIndexSource?.shiftsByPageShift} `
        + `加 vm_pgoff=${linearPageIndexSource?.addsVmPgoff}）；匿名=${filePageFolio.mappingIsAnon} `
        + `page_type=0x${(filePageFolio.pageType ?? 0).toString(16)}（code=${filePageFolio.pageTypeCode} `
        + `name=${filePageFolio.pageTypeName ?? 'null'}）refcount=${filePageFolio.refcount} `
        + `页旗=${filePageFolio.pageFlags.join(',') || '无'}`,
    );

    /* ---------- 停点二：lab-memory 的匿名页（同一 VMA 的两个相邻页） ---------- */

    log('停点二：lab-memory 停在 __x64_sys_munmap ...');
    const memCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    const memClaim = await claimWithRetry({
      app,
      base,
      live,
      cmd,
      symbol: '__x64_sys_munmap',
      commandFor: (n) => `lab-memory; echo MEM${n}""Y-DONE-$?\n`,
      markerFor: (n) => `MEM${n}Y-DONE-`,
      inspect: async (frame) => {
        const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
        return { claimed: info.comm === 'lab-memory', label: info.label, value: { info } };
      },
    });
    if (memClaim.failed) {
      throw new Error(
        `没有等到 lab-memory 停在 __x64_sys_munmap（尝试 ${memClaim.attempts.length} 次）；`
        + `尝试记录=${JSON.stringify(memClaim.attempts.map((e) => `第${e.attempt}次停${e.stopsSeen}回[${e.trace.slice(-6).join(' ')}]`))}；`
        + `串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const frame2 = memClaim.frame;
    const capture2 = captureFor(frame2);
    const view2 = new KernelMemoryView(capture2);
    const memInfo = memClaim.value.info;
    const memText = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
    const memMappings = parseGuestMappings(memText.slice(memCursor));
    const memMappingAddress = memMappings.get(memInfo.pid) ?? [...memMappings.values()][0] ?? null;
    if (memMappingAddress === null) {
      throw new Error(`停点二上没读到客体自己打印的 mapping 地址；串口尾部=${JSON.stringify(memText.slice(-400))}`);
    }
    const mmAddress2 = await view2.u64(memInfo.taskAddress + BigInt(taskOffsets.mm));
    const mm2 = await readMm(view2, layout, mmAddress2);
    const cr3Frame2 = frame2.cpu?.control?.cr3 === null || frame2.cpu?.control?.cr3 === undefined
      ? null : BigInt(frame2.cpu.control.cr3);
    const rootPhysical2 = cr3Frame2 === null ? null : (cr3Frame2 & PHYSICAL_ADDRESS_MASK);
    const offsetDerivation2 = mm2.pgd === null || cr3Frame2 === null
      ? null : derivePageOffsetBase({ pgdLinear: mm2.pgd, cr3: cr3Frame2 });
    const tree2 = await readVmas(view2, layout, mmAddress2, { enabledConfigs: localConfigs });
    const memVa1 = memMappingAddress;
    const memVa2 = memMappingAddress + PAGE_SIZE;
    const memVma1 = findVmaForAddress(tree2.vmas, memVa1);
    const memVma2 = findVmaForAddress(tree2.vmas, memVa2);
    if (memVma1 === null || memVma2 === null) {
      throw new Error(`停点二：客体自报的地址 ${hex(memVa1)} / ${hex(memVa2)} 不在任何 VMA 里（串口给的 mapping 与我们读的树对不上）`);
    }
    const memWalk1 = await walkPageTable(view2, {
      pgd: mm2.pgd, linear: memVa1, pageOffsetBase, levels: 4, rootPhysical: rootPhysical2,
    });
    const memWalk2 = await walkPageTable(view2, {
      pgd: mm2.pgd, linear: memVa2, pageOffsetBase, levels: 4, rootPhysical: rootPhysical2,
    });
    if (memWalk1.physical === null || memWalk2.physical === null) {
      throw new Error(`停点二的页表走不到物理地址：${hex(memVa1)} → ${memWalk1.fault?.kind ?? '无'}，${hex(memVa2)} → ${memWalk2.fault?.kind ?? '无'}`);
    }
    const memPfn1 = memWalk1.physical >> BigInt(PAGE_SHIFT);
    const memPfn2 = memWalk2.physical >> BigInt(PAGE_SHIFT);
    // 读字节刻意走**物理地址**（`readPhysical` 自己再加直映射偏移），不吃页表那条路：
    // 这样"页表说这个页在哪"与"那个地方真的有这个字节"是两件独立的事。
    const memByte1 = (await readPhysical(view2, { physical: memWalk1.physical, pageOffsetBase, length: 8 })).bytes;
    const memByte2 = (await readPhysical(view2, { physical: memWalk2.physical, pageOffsetBase, length: 8 })).bytes;
    const memVmemmap1 = await resolveVmemmapBase(view2, layout, { pfn: memPfn1 });
    const memFolio1 = await readFolioForPfn(view2, layout, { pfn: memPfn1, vmemmap: memVmemmap1 });
    const memFolio2 = await readFolioForPfn(view2, layout, { pfn: memPfn2, vmemmap: memVmemmap1 });
    evidence.stop2 = {
      frameId: frame2.frameId,
      captureId: frame2.captureId,
      claimStops: memClaim.stops,
      attempts: memClaim.attempts,
      rip: frame2.cpu?.rip,
      cr3: hexOrNull(cr3Frame2),
      comm: memInfo.comm,
      pid: memInfo.pid,
      taskAddress: hex(memInfo.taskAddress),
      guestMappings: [...memMappings.entries()].map(([pid, address]) => ({ pid, address: hex(address) })),
      pageOffsetBase: hexOrNull(pageOffsetBase),
      pageOffsetBaseAgain: offsetDerivation2 === null ? null : hex(offsetDerivation2.base),
      mm: { address: hex(mmAddress2), pgd: hexOrNull(mm2.pgd), mapCount: mm2.mapCount, totalVm: jsonSafe(mm2.totalVm) },
      vma: {
        count: tree2.vmas.length,
        address: hex(memVma1.address),
        start: hex(memVma1.vmStart), end: hex(memVma1.vmEnd),
        permissions: memVma1.permissions, flags: hex(memVma1.vmFlags),
        file: hexOrNull(memVma1.vmFile), anonVma: hexOrNull(memVma1.anonVma),
        pgoff: hex(memVma1.vmPgoff),
        secondVmaIsSame: memVma2.address === memVma1.address,
      },
      pages: [
        {
          va: hex(memVa1), physical: hex(memWalk1.physical), pfn: hex(memPfn1),
          bytes: Buffer.from(memByte1).toString('latin1'), hexBytes: Buffer.from(memByte1).toString('hex'),
          folio: {
            address: hex(memFolio1.address), mapping: hex(memFolio1.mapping),
            mappingIsAnon: memFolio1.mappingIsAnon, anonVma: hexOrNull(memFolio1.anonVmaAddress),
            index: memFolio1.index.toString(), refcount: memFolio1.refcount, mapcount: memFolio1.mapcount,
            pageType: memFolio1.pageType, pageTypeCode: memFolio1.pageTypeCode,
            pageFlags: memFolio1.pageFlags,
          },
        },
        {
          va: hex(memVa2), physical: hex(memWalk2.physical), pfn: hex(memPfn2),
          bytes: Buffer.from(memByte2).toString('latin1'), hexBytes: Buffer.from(memByte2).toString('hex'),
          folio: {
            address: hex(memFolio2.address), mapping: hex(memFolio2.mapping),
            mappingIsAnon: memFolio2.mappingIsAnon, anonVma: hexOrNull(memFolio2.anonVmaAddress),
            index: memFolio2.index.toString(), refcount: memFolio2.refcount, mapcount: memFolio2.mapcount,
            pageType: memFolio2.pageType, pageTypeCode: memFolio2.pageTypeCode,
            pageFlags: memFolio2.pageFlags,
          },
        },
      ],
    };

    const ref2 = await runReference(live, 'stop2', {
      va: memVa1, va2: memVa2, pfn: memPfn1, mm: mmAddress2, cr3: cr3Frame2 ?? 0n,
    });
    if (!ref2.ok) log(`GDB 侧参照（停点二）失败：${ref2.error}`);
    const refData2 = ref2.ok ? ref2.data : {};
    const refFolio2A = refData2.folioAtVa ?? null;
    const refFolio2B = refData2.folioAtVa2 ?? null;
    const memRefCompare1 = compareWalkWithReference(memWalk1, refData2.translation ?? null);
    const memRefCompare2 = compareWalkWithReference(memWalk2, refData2.translation2 ?? null);
    const memService1 = await serviceTranslate(app, base, memVa1, frame2.captureId);
    const memService2 = await serviceTranslate(app, base, memVa2, frame2.captureId);
    const memSvcCompare1 = memService1.ok
      ? compareWalkWithService(memWalk1, memService1.translation)
      : { mismatches: [`服务 translate 失败：${memService1.error}`], compared: 0 };
    const memSvcCompare2 = memService2.ok
      ? compareWalkWithService(memWalk2, memService2.translation)
      : { mismatches: [`服务 translate 失败：${memService2.error}`], compared: 0 };
    const memFolioMismatches = [];
    for (const [label, ref, mine] of [['第 1 页', refFolio2A, memFolio1], ['第 2 页', refFolio2B, memFolio2]]) {
      if (ref === null || ref === undefined) {
        memFolioMismatches.push(`${label}：GDB 没给出 struct page`);
        continue;
      }
      for (const [name, refValue, mineValue] of [
        ['address', ref.address, mine.address],
        ['flags', ref.flags, mine.flags],
        ['mapping', ref.mapping, mine.mapping],
        ['index', ref.index, mine.index],
      ]) {
        if (refValue === null || refValue === undefined) continue;
        if (String(asBig(refValue)) !== String(mineValue)) {
          memFolioMismatches.push(`${label} ${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      for (const [name, refValue, mineValue] of [
        ['refcount', ref.refcount, mine.refcount],
        ['mapcount', ref.mapcount, mine.mapcount],
        ['pageType', ref.pageType, mine.pageType],
      ]) {
        if (refValue === null || refValue === undefined || mineValue === null) continue;
        if (Number(refValue) !== Number(mineValue)) {
          memFolioMismatches.push(`${label} ${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      if (ref.mappingIsAnon !== mine.mappingIsAnon) {
        memFolioMismatches.push(`${label} mappingIsAnon：我们=${mine.mappingIsAnon} GDB=${ref.mappingIsAnon}`);
      }
    }
    const memByteText1 = Buffer.from(memByte1).toString('latin1');
    const memByteText2 = Buffer.from(memByte2).toString('latin1');
    const memIndexByVa1 = memVa1 >> BigInt(PAGE_SHIFT);
    const memIndexByVa2 = memVa2 >> BigInt(PAGE_SHIFT);
    evidence.stop2.referenceRun = ref2.ok ? 'stop2' : { error: ref2.error };
    evidence.stop2.compare = {
      gdbWalk1: memRefCompare1, gdbWalk2: memRefCompare2,
      serviceWalk1: memSvcCompare1, serviceWalk2: memSvcCompare2,
      folioMismatches: memFolioMismatches,
      gdbPageOffsetBase: refData2.pageOffsetBase ?? null,
      gdbVmemmapBase: refData2.vmemmap?.base ?? null,
      gdbTree: { rootKind: refData2.tree?.rootKind ?? null, entries: (refData2.tree?.entries ?? []).length },
      gdbFolioA: refFolio2A, gdbFolioB: refFolio2B,
      serviceFolioSource: memService1.ok ? 'ok' : memService1.error,
    };
    check(
      'T07c-V11 匿名页三方对得上：同一 VMA 里的两个相邻页（客体 mmap 后自己打印的地址与它 +4096）各翻译到一个物理页，物理字节正是客体写进去的 A 与 B；两页的 `page->mapping` 都指向这条 VMA 自己的 anon_vma（低位那 1 位表示"这是 anon_vma 而不是 address_space"），`index` 分别等于两个虚拟页号，两页是**不同的**页框；GDB 独立读的两页 flags/mapping/index/page_type 与我们相同，页表遍历也与 GDB、服务三方一致',
      ref2.ok === true
        && offsetDerivation2 !== null && offsetDerivation2.base === pageOffsetBase
        && memVma1.vmFile === null && memVma1.anonVma !== null
        && memVma2.address === memVma1.address
        && memByteText1[0] === 'A' && memByteText2[0] === 'B'
        && memPfn1 !== memPfn2
        && memFolio1.mappingIsAnon === true && memFolio1.anonVmaAddress === memVma1.anonVma
        && memFolio2.mappingIsAnon === true && memFolio2.anonVmaAddress === memVma2.anonVma
        && memFolio1.index === linearPageIndex(memVma1, memVa1) && memFolio1.index === memIndexByVa1
        && memFolio2.index === linearPageIndex(memVma2, memVa2) && memFolio2.index === memIndexByVa2
        && memFolioMismatches.length === 0
        && memRefCompare1.mismatches.length === 0 && memRefCompare2.mismatches.length === 0
        && memSvcCompare1.mismatches.length === 0 && memSvcCompare2.mismatches.length === 0
        && asBig(refData2.pageOffsetBase?.base) === pageOffsetBase,
      `pid=${memInfo.pid} 映射地址=${hex(memMappingAddress)} 这条 VMA=[${hex(memVma1.vmStart)},${hex(memVma1.vmEnd)}) `
        + `${memVma1.permissions} anon_vma=${hexOrNull(memVma1.anonVma)}；`
        + `第 1 页 ${hex(memVa1)} → 物理 ${hex(memWalk1.physical)}（页框 ${hex(memPfn1)}）字节=${JSON.stringify(memByteText1)} `
        + `folio.mapping=${hex(memFolio1.mapping)} index=${memFolio1.index}（=虚拟页号 ${memIndexByVa1}）refcount=${memFolio1.refcount}；`
        + `第 2 页 ${hex(memVa2)} → 物理 ${hex(memWalk2.physical)}（页框 ${hex(memPfn2)}）字节=${JSON.stringify(memByteText2)} `
        + `folio.mapping=${hex(memFolio2.mapping)} index=${memFolio2.index} refcount=${memFolio2.refcount}；`
        + `两页页框不同=${memPfn1 !== memPfn2}；页表：vs GDB 不一致 ${memRefCompare1.mismatches.length}+${memRefCompare2.mismatches.length}，`
        + `vs 服务不一致 ${memSvcCompare1.mismatches.length}+${memSvcCompare2.mismatches.length}；`
        + `struct page 字段不一致 ${memFolioMismatches.length}`
        + (memFolioMismatches.length === 0 ? '' : `；明细：${memFolioMismatches.slice(0, 6).join(' | ')}`),
    );

    /* ---------- 停点三：lab-cow 的子进程在 do_exit（COW 刚发生） ---------- */

    /**
     * 为什么整段要包一层 `try`：这一段的失败**不该**把整轮验收吹掉 —— 走到这里已经
     * 花掉十几分钟（真启动一台 Linux + 三个停点），后面还有 V13/V14 要跑；而且更要紧的是，
     * 一抛异常，`attempts` 里那些"为何没认领到"的证据就全丢了。包起来之后，失败也照样
     * 把每次尝试的帧数、停止信号数、QMP 停点次数、断点对象、会话状态落进证据，
     * 并把 V12a/V12b/V12c 如实标成未通过。
     *
     * 说明：块内代码**不重新缩进**，以免为了排版产生一份谁都读不动的 diff。
     */
    try {

    log('停点三：lab-cow 的子进程停在 do_exit ...');

    /**
     * 认领之前先问一次"这个符号到底解出来没有"。
     *
     * 为什么值得单独做这一步：认领失败有两种长得一模一样的表现 —— 一种是断点地址压根没解出来
     * （服务只看得到 pending，断点不会触发），另一种是地址解出来了但没停到该停的地方。
     * 两者的 `attempts` 里都只是"没命中"，光看那个分辨不出来，事后就得重新启动一台机器再赌一次。
     * 这里提前把解析结果（成功则带模块与地址，失败则带原因与候选）抄进证据，失败原因就一眼可见了。
     *
     * 注意：这一步**不改变**认领的成败，解析不出来也照样往下走（也许服务后面自己能解出来），
     * 所以单独包一层 try，任何意外都只记一笔，不往上抛。
     */
    let cowExitSymbolFact = null;
    try {
      const resolved = live.symbols.breakpointSpec('do_exit', { module: 'linux-kernel' });
      cowExitSymbolFact = resolved.ok
        ? {
            ok: true,
            module: resolved.module ?? null,
            address: resolved.address ?? null,
            /**
             * 同一个符号名在 vmlinux 里可能有多个定义（比如它可能只被内联展开、
             * 或者同时存在静态/全局两处），服务会返回若干候选；候选多于一个时
             * 说明"这个地址是不是我们要的那一处"本身就有歧义，也一并记下来。
             */
            candidateCount: Array.isArray(resolved.candidates) ? resolved.candidates.length : null,
          }
        : {
            ok: false,
            reason: resolved.reason ?? null,
            candidates: Array.isArray(resolved.candidates)
              ? resolved.candidates.map((entry) => entry?.name ?? entry?.address ?? String(entry)).slice(0, 8)
              : null,
          };
      log(resolved.ok
        ? `断点符号预检：do_exit 已解出（模块=${cowExitSymbolFact.module} 地址=${cowExitSymbolFact.address ?? '未给'} 候选数=${cowExitSymbolFact.candidateCount ?? '未给'}）`
        : `断点符号预检：do_exit 未解出（原因=${cowExitSymbolFact.reason ?? '未给'}），断点可能只会是 pending 状态`);
    } catch (error) {
      cowExitSymbolFact = { ok: false, reason: `解析符号时抛异常：${error.message}` };
      log(`断点符号预检失败（不中断）：${error.message}`);
    }

    const cowCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    const cowClaim = await claimWithRetry({
      app,
      base,
      live,
      cmd,
      symbol: 'do_exit',
      commandFor: (n) => `lab-cow; echo COW${n}""Y-DONE-$?\n`,
      markerFor: (n) => `COW${n}Y-DONE-`,
      /**
       * 认领谓词。`do_exit` 是**所有**进程都会走的函数，所以这里必须能分清三件事：
       * 不是 lab-cow 的进程一律跳过；lab-cow 的**父进程**此刻阻塞在 `waitpid`，
       * 不可能在 `do_exit`；只有那个刚写下 'C' 的子进程会到这里。子进程号由客体
       * 自己 `printf("child=%d ...")` 报出，一旦串口上有这一行就按 pid 严判，
       * 还没出现（printf 的输出可能比断点晚一拍到串口）时按"父进程不可能在此"认领。
       */
      inspect: async (frame, tail) => {
        const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
        if (info.comm !== 'lab-cow') return { claimed: false, label: info.label, value: null };
        const childLine = parseGuestChildLine(tail);
        const parentLine = parseGuestParentLine(tail);
        if (childLine !== null) labCowChildPid = childLine.pid;
        if (parentLine !== null) labCowParentPid = parentLine.pid;
        if (childLine === null && parentLine === null) {
          return {
            claimed: true,
            label: `${info.label}（串口还没有 child= 那一行；父进程此刻在 waitpid，故只能是被 fork 出来的子进程）`,
            value: { info },
          };
        }
        if (labCowChildPid !== null && info.pid !== null && info.pid === labCowChildPid) {
          return { claimed: true, label: `${info.label}（pid 与客体自报的 child=${labCowChildPid} 一致）`, value: { info } };
        }
        return { claimed: false, label: `${info.label}（不是那个子进程，继续等）`, value: null };
      },
    });
    if (cowClaim.failed) {
      const cowTail = await terminalTailOf(app, base, 800);
      // 先把诊断落进证据再抛：即使这一段落因此中断，attempts 里的
      // 「帧数/停止信号数/QMP 停点次数/断点对象/会话状态」也留得下来。
      evidence.stop3 = {
        claimFailed: true,
        childPid: labCowChildPid,
        parentPid: labCowParentPid,
        attempts: cowClaim.attempts,
        breakpoint: cowClaim.breakpoint,
        terminalTail: cowTail,
        sessionState: live.state ?? null,
        framesAfter: live.frames.length,
        // 认领前那次 do_exit 符号解析的原始结论（成功带模块/地址/候选数，失败带原因）：
        // 用来区分"断点压根没解出地址"和"解出来了但没停到"这两种外观相同的失败。
        exitSymbol: cowExitSymbolFact,
      };
      /**
       * 每次尝试的摘要单独构造再序列化：一是避免把一堆嵌套模板字符串塞进一行，
       * 二是 `trace` 可能很长，只留最后几条就够定位了。
       */
      const digest = cowClaim.attempts.map((entry) => ({
        attempt: entry.attempt,
        stopsSeen: entry.stopsSeen,
        claimed: entry.claimed,
        markerSeen: entry.markerSeen,
        breakpoint: entry.breakpoint,
        insertedStatus: entry.insertedStatus,
        removeStatus: entry.removeStatus,
        removeBody: entry.removeBody,
        continueStatus: entry.continueStatus,
        continueBody: entry.continueBody,
        inputStatus: entry.inputStatus,
        inputBody: entry.inputBody,
        baselineFrameId: entry.baselineFrameId,
        tally: entry.tally,
        trace: entry.trace.slice(-6),
      }));
      throw new Error(
        `没有等到 lab-cow 的子进程停在 do_exit（尝试 ${cowClaim.attempts.length} 次）；`
        + `childPid=${labCowChildPid} parentPid=${labCowParentPid}；`
        + `尝试记录=${JSON.stringify(digest)}；`
        + `串口尾部=${cowTail}`,
      );
    }
    const frame3 = cowClaim.frame;
    const capture3 = captureFor(frame3);
    const view3 = new KernelMemoryView(capture3);
    const childInfo = cowClaim.value.info;
    const cowText = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
    const cowTail = cowText.slice(cowCursor);
    const cowMappings = parseGuestMappings(cowTail);
    const cowChildLine = parseGuestChildLine(cowTail);
    const cowParentLine = parseGuestParentLine(cowTail);
    if (cowChildLine !== null) labCowChildPid = cowChildLine.pid;
    if (cowParentLine !== null) labCowParentPid = cowParentLine.pid;
    const cowMappingAddress = (labCowParentPid !== null ? cowMappings.get(labCowParentPid) : null)
      ?? [...cowMappings.values()][0] ?? null;
    if (cowMappingAddress === null) {
      throw new Error(`停点三上没读到 lab-cow 打印的 mapping 地址；串口尾部=${JSON.stringify(cowTail.slice(-400))}`);
    }
    const cowVa = cowMappingAddress;
    const cr3Frame3 = frame3.cpu?.control?.cr3 === null || frame3.cpu?.control?.cr3 === undefined
      ? null : BigInt(frame3.cpu.control.cr3);
    const childMmAddress = await view3.u64(childInfo.taskAddress + BigInt(taskOffsets.mm));
    const childMm = await readMm(view3, layout, childMmAddress);
    const childRootPhysical = cr3Frame3 === null ? null : (cr3Frame3 & PHYSICAL_ADDRESS_MASK);
    const tree3 = await readVmas(view3, layout, childMmAddress, { enabledConfigs: localConfigs });
    const childVma = findVmaForAddress(tree3.vmas, cowVa);
    if (childVma === null) throw new Error(`停点三：子进程里 ${hex(cowVa)} 不在任何 VMA 里`);
    const childWalk = await walkPageTable(view3, {
      pgd: childMm.pgd, linear: cowVa, pageOffsetBase, levels: 4, rootPhysical: childRootPhysical,
    });
    if (childWalk.physical === null) {
      throw new Error(`停点三：子进程 ${hex(cowVa)} 的页表走不到物理地址（${childWalk.fault?.kind ?? '无'}）`);
    }
    const childPfn = childWalk.physical >> BigInt(PAGE_SHIFT);
    const childByte = (await readPhysical(view3, {
      physical: childWalk.physical, pageOffsetBase, length: 8,
    })).bytes;
    const childVmemmap = await resolveVmemmapBase(view3, layout, { pfn: childPfn });
    const childFolio = await readFolioForPfn(view3, layout, { pfn: childPfn, vmemmap: childVmemmap });

    /**
     * 同一帧里的父进程一侧。
     *
     * `fork` 之后子进程的 `real_parent` 就是 lab-cow 的父进程，顺着这个指针就能在同一
     * 时刻把"同一个虚拟地址在另一个地址空间里是什么样"读出来 —— 这是 COW 唯一的直接证据：
     * 同一 VA、两个进程、两个不同的物理页、各写各的字节。分开两个停点读（父进程先跑过去
     * 再回来）也能凑出结论，但那样中间可以发生任何事，反而不是同一个瞬间的事实。
     */
    const parentTask = await view3.u64(childInfo.taskAddress + BigInt(taskOffsets.realParent));
    if (parentTask === 0n) throw new Error('停点三：子进程的 real_parent 是 0，读不到父进程');
    const parentPidRead = await view3.u32(parentTask + BigInt(taskOffsets.pid));
    const parentCommRead = (await view3.cstring(parentTask + BigInt(taskOffsets.comm), 16)).text;
    const parentMmAddress = await view3.u64(parentTask + BigInt(taskOffsets.mm));
    const parentMm = await readMm(view3, layout, parentMmAddress);
    const tree3Parent = await readVmas(view3, layout, parentMmAddress, { enabledConfigs: localConfigs });
    const parentVma = findVmaForAddress(tree3Parent.vmas, cowVa);
    if (parentVma === null) throw new Error(`停点三：父进程里 ${hex(cowVa)} 不在任何 VMA 里`);
    const parentRootPhysical = parentMm.pgd === null ? null : (parentMm.pgd - pageOffsetBase);
    const parentWalk = await walkPageTable(view3, {
      pgd: parentMm.pgd, linear: cowVa, pageOffsetBase, levels: 4, rootPhysical: parentRootPhysical,
    });
    if (parentWalk.physical === null) {
      throw new Error(`停点三：父进程 ${hex(cowVa)} 的页表走不到物理地址（${parentWalk.fault?.kind ?? '无'}）`);
    }
    const parentPfn = parentWalk.physical >> BigInt(PAGE_SHIFT);
    const parentByte = (await readPhysical(view3, {
      physical: parentWalk.physical, pageOffsetBase, length: 8,
    })).bytes;
    const parentVmemmap = await resolveVmemmapBase(view3, layout, { pfn: parentPfn });
    const parentFolio = await readFolioForPfn(view3, layout, { pfn: parentPfn, vmemmap: parentVmemmap });
    evidence.stop3 = {
      frameId: frame3.frameId,
      captureId: frame3.captureId,
      claimStops: cowClaim.stops,
      attempts: cowClaim.attempts,
      // 认领前那次 do_exit 符号解析的原始结论，与失败分支同名同形，便于两条路径对比。
      exitSymbol: cowExitSymbolFact,
      rip: frame3.cpu?.rip,
      childPidClaimed: labCowChildPid,
      parentPidClaimed: labCowParentPid,
      guestChildLine: cowChildLine,
      guestParentLine: cowParentLine,
      va: hex(cowVa),
      child: {
        comm: childInfo.comm, pid: childInfo.pid, taskAddress: hex(childInfo.taskAddress),
        mmAddress: hex(childMmAddress), mmUsers: childMm.mmUsers, mmCount: childMm.mmCount,
        pgd: hexOrNull(childMm.pgd), mapCount: childMm.mapCount,
        vma: {
          address: hex(childVma.address), start: hex(childVma.vmStart), end: hex(childVma.vmEnd),
          permissions: childVma.permissions, anonVma: hexOrNull(childVma.anonVma), file: hexOrNull(childVma.vmFile),
        },
        physical: hex(childWalk.physical), pfn: hex(childPfn),
        byte: Buffer.from(childByte).toString('latin1'),
        hexBytes: Buffer.from(childByte).toString('hex'),
        folio: {
          address: hex(childFolio.address), mapping: hex(childFolio.mapping),
          mappingIsAnon: childFolio.mappingIsAnon, anonVma: hexOrNull(childFolio.anonVmaAddress),
          index: childFolio.index.toString(), indexByVa: (cowVa >> BigInt(PAGE_SHIFT)).toString(),
          refcount: childFolio.refcount, mapcount: childFolio.mapcount,
          pageType: childFolio.pageType, pageFlags: childFolio.pageFlags,
        },
      },
      parent: {
        comm: parentCommRead, pid: parentPidRead, taskAddress: hex(parentTask),
        mmAddress: hex(parentMmAddress), mmUsers: parentMm.mmUsers, mmCount: parentMm.mmCount,
        pgd: hexOrNull(parentMm.pgd), mapCount: parentMm.mapCount,
        vma: {
          address: hex(parentVma.address), start: hex(parentVma.vmStart), end: hex(parentVma.vmEnd),
          permissions: parentVma.permissions, anonVma: hexOrNull(parentVma.anonVma), file: hexOrNull(parentVma.vmFile),
        },
        physical: hex(parentWalk.physical), pfn: hex(parentPfn),
        byte: Buffer.from(parentByte).toString('latin1'),
        hexBytes: Buffer.from(parentByte).toString('hex'),
        folio: {
          address: hex(parentFolio.address), mapping: hex(parentFolio.mapping),
          mappingIsAnon: parentFolio.mappingIsAnon, anonVma: hexOrNull(parentFolio.anonVmaAddress),
          index: parentFolio.index.toString(), indexByVa: (cowVa >> BigInt(PAGE_SHIFT)).toString(),
          refcount: parentFolio.refcount, mapcount: parentFolio.mapcount,
          pageType: parentFolio.pageType, pageFlags: parentFolio.pageFlags,
        },
      },
      sameMm: childMmAddress === parentMmAddress,
      samePfn: childPfn === parentPfn,
      sameAnonVma: childVma.anonVma === parentVma.anonVma,
    };

    const ref3 = await runReference(live, 'stop3', {
      va: cowVa, va2: 0n, pfn: childPfn, mm: childMmAddress, cr3: cr3Frame3 ?? 0n,
    });
    if (!ref3.ok) log(`GDB 侧参照（停点三）失败：${ref3.error}`);
    const refData3 = ref3.ok ? ref3.data : {};
    const refFolio3 = refData3.folioAtVa ?? null;
    const childRefCompare = compareWalkWithReference(childWalk, refData3.translation ?? null);
    const childService = await serviceTranslate(app, base, cowVa, frame3.captureId);
    const childSvcCompare = childService.ok
      ? compareWalkWithService(childWalk, childService.translation)
      : { mismatches: [`服务 translate 失败：${childService.error}`], compared: 0 };
    const childGvaText = await live.qmp.hmp(`gva2gpa ${toSigned64(cowVa)}`, { timeoutMs: 180000 });
    const childGvaPhysical = parseGva2gpa(childGvaText);
    const childFolioMismatches = [];
    if (refFolio3 !== null && refFolio3 !== undefined) {
      for (const [name, refValue, mineValue] of [
        ['address', refFolio3.address, childFolio.address],
        ['flags', refFolio3.flags, childFolio.flags],
        ['mapping', refFolio3.mapping, childFolio.mapping],
        ['index', refFolio3.index, childFolio.index],
      ]) {
        if (refValue === null || refValue === undefined) continue;
        if (String(asBig(refValue)) !== String(mineValue)) {
          childFolioMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      for (const [name, refValue, mineValue] of [
        ['refcount', refFolio3.refcount, childFolio.refcount],
        ['mapcount', refFolio3.mapcount, childFolio.mapcount],
        ['pageType', refFolio3.pageType, childFolio.pageType],
      ]) {
        if (refValue === null || refValue === undefined || mineValue === null) continue;
        if (Number(refValue) !== Number(mineValue)) {
          childFolioMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      if (refFolio3.mappingIsAnon !== childFolio.mappingIsAnon) {
        childFolioMismatches.push(
          `mappingIsAnon：我们=${childFolio.mappingIsAnon} GDB=${refFolio3.mappingIsAnon}`,
        );
      }
      if (refFolio3.anonVmaAddress !== null && refFolio3.anonVmaAddress !== undefined
        && asBig(refFolio3.anonVmaAddress) !== childFolio.anonVmaAddress) {
        childFolioMismatches.push(
          `anon_vma：我们=${hexOrNull(childFolio.anonVmaAddress)} GDB=${hex(asBig(refFolio3.anonVmaAddress))}`,
        );
      }
    } else {
      childFolioMismatches.push('GDB 侧没有给出子进程这一页的 struct page');
    }
    const childByteText = Buffer.from(childByte).toString('latin1');
    const parentByteText = Buffer.from(parentByte).toString('latin1');
    evidence.stop3.reference = {
      run: ref3.ok ? 'stop3' : { error: ref3.error },
      gdbMmAddress: hexOrNull(refBig(refData3.current?.mmAddress)),
      gdbCr3: refData3.cr3 ?? null,
      gdbFolio: refFolio3,
      folioMismatches: childFolioMismatches,
      walkCompare: childRefCompare,
      serviceCompare: childSvcCompare,
      service: summarizeServiceTranslate(childService),
      gva2gpa: { argument: toSigned64(cowVa).toString(), raw: String(childGvaText).trim(), physical: hexOrNull(childGvaPhysical) },
      note: 'GDB 的参照实现只读 `current`（此刻是子进程），所以它只能核对子进程这一侧；父进程那一侧由停点四用四条独立通道复核',
    };
    check(
      'T07c-V12a COW 的同一时刻证据（停在子进程 do_exit 的第一条指令，`exit_mm()` 还没跑，所以两侧地址空间都还活着）：同一个虚拟地址在子/父两个地址空间里各有一个物理页，页框不同；子进程那一页的物理字节是 C、父进程那一页是 A；两页的 `_mapcount` 都是 0（即 `page_mapcount()`=1，各自只被一个页表项映射 —— 写时复制真的把两边的映射分开了；若没分开，这里该是 1 表示映射两次），引用数也各自等于「映射数 1 + 这一页是不是还在每 CPU 的 LRU 待入队批次里」（`folio_add_lru()` 先 `folio_get` 一次、批次刷进 LRU 时才还，所以刚建好映射的页会临时多一次引用且还没置 PG_lru）；两页的 `page->mapping` 都带着匿名低位、分别指向各自 VMA 的 anon_vma；子父 mm_struct 地址不同（fork 之后子进程有自己的一份）；GDB 参照自己读的子进程那页 flags/mapping/index/page_type 与我们相同，子进程这一侧的页表遍历与 GDB、服务、QEMU 四方一致，且机器当前 CR3（子进程）翻译出的物理页正是子进程那一页、不是父进程那一页',
      ref3.ok === true
        && childInfo.comm === 'lab-cow'
        && (labCowChildPid === null || childInfo.pid === labCowChildPid)
        && childInfo.pid !== parentPidRead
        && parentCommRead === 'lab-cow'
        && (labCowParentPid === null || parentPidRead === labCowParentPid)
        && childMmAddress !== parentMmAddress
        && childPfn !== parentPfn
        && childByteText[0] === 'C' && parentByteText[0] === 'A'
        && childFolio.mapcount === 0 && parentFolio.mapcount === 0
        && childFolio.refcount === expectedAnonRefcount(childFolio, 1)
        && parentFolio.refcount === expectedAnonRefcount(parentFolio, 1)
        && childFolio.mappingIsAnon === true && childFolio.anonVmaAddress === childVma.anonVma
        && parentFolio.mappingIsAnon === true && parentFolio.anonVmaAddress === parentVma.anonVma
        && childFolio.index === (cowVa >> BigInt(PAGE_SHIFT))
        && parentFolio.index === (cowVa >> BigInt(PAGE_SHIFT))
        && childFolioMismatches.length === 0
        && childRefCompare.mismatches.length === 0 && childSvcCompare.mismatches.length === 0
        && childGvaPhysical === childWalk.physical
        && childGvaPhysical !== parentWalk.physical,
      `VA=${hex(cowVa)}；子进程 pid=${childInfo.pid}（客体自报 child=${labCowChildPid}）mm=${hex(childMmAddress)} `
        + `物理=${hex(childWalk.physical)} 页框=${hex(childPfn)} 字节=${JSON.stringify(childByteText)} `
        + `refcount=${childFolio.refcount}（该有 ${expectedAnonRefcount(childFolio, 1)}）_mapcount=${childFolio.mapcount} `
        + `mapping=${hex(childFolio.mapping)}（anon_vma=${hexOrNull(childFolio.anonVmaAddress)}，`
        + `VMA 的 anon_vma=${hexOrNull(childVma.anonVma)}）index=${childFolio.index}；`
        + `父进程 pid=${parentPidRead}（客体自报 parent=${labCowParentPid}）mm=${hex(parentMmAddress)} `
        + `物理=${hex(parentWalk.physical)} 页框=${hex(parentPfn)} 字节=${JSON.stringify(parentByteText)} `
        + `refcount=${parentFolio.refcount}（该有 ${expectedAnonRefcount(parentFolio, 1)}）_mapcount=${parentFolio.mapcount} `
        + `mapping=${hex(parentFolio.mapping)}（anon_vma=${hexOrNull(parentFolio.anonVmaAddress)}，`
        + `VMA 的 anon_vma=${hexOrNull(parentVma.anonVma)}）index=${parentFolio.index}；`
        + `两个 anon_vma 是否同一个对象=${childVma.anonVma === parentVma.anonVma}；`
        + `子侧页表 vs GDB 不一致 ${childRefCompare.mismatches.length}、vs 服务不一致 ${childSvcCompare.mismatches.length}；`
        + `gva2gpa=${String(childGvaText).trim()}；struct page 字段不一致 ${childFolioMismatches.length}`
        + (childFolioMismatches.length === 0 ? '' : `；明细：${childFolioMismatches.slice(0, 6).join(' | ')}`),
    );

    /* ---------- 停点四：lab-cow 的父进程在 munmap（COW 之后仍持有原来那一页） ---------- */

    log('停点四：lab-cow 的父进程停在 __x64_sys_munmap ...');
    const cowParentCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    const parentClaim = await claimWithRetry({
      app,
      base,
      live,
      cmd,
      symbol: '__x64_sys_munmap',
      commandFor: (n) => `lab-cow; echo PCOW${n}""Y-DONE-$?\n`,
      markerFor: (n) => `PCOW${n}Y-DONE-`,
      /**
       * 认领谓词。此刻子进程已经退出，`lab-cow` 这个名字只剩父进程一个；它自己
       * 一开始就打印过 `pid=<自己的号> mapping=0x…`，所以"comm 是 lab-cow 且 pid
       * 等于这轮里打印出来的那个 pid"就把父进程钉死了（不靠猜、不靠 pid 大小）。
       */
      inspect: async (frame, tail) => {
        const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
        if (info.comm !== 'lab-cow') return { claimed: false, label: info.label, value: null };
        const parentLine = parseGuestParentLine(tail);
        if (parentLine !== null) labCowParentPid = parentLine.pid;
        const mappings = parseGuestMappings(tail);
        if (mappings.has(info.pid)) {
          labCowParentPid = labCowParentPid ?? info.pid;
          return { claimed: true, label: `${info.label}（pid 与客体自己打印的 pid=… 一致）`, value: { info } };
        }
        if (labCowParentPid !== null && info.pid !== null && info.pid === labCowParentPid) {
          return { claimed: true, label: `${info.label}（pid 与客体自报的 parent=${labCowParentPid} 一致）`, value: { info } };
        }
        return { claimed: false, label: `${info.label}（不是 lab-cow 的父进程，继续等）`, value: null };
      },
    });
    if (parentClaim.failed) {
      throw new Error(
        `没有等到 lab-cow 的父进程停在 __x64_sys_munmap（尝试 ${parentClaim.attempts.length} 次）；`
        + `parentPid=${labCowParentPid}；`
        + `尝试记录=${JSON.stringify(parentClaim.attempts.map((e) => `第${e.attempt}次停${e.stopsSeen}回[${e.trace.slice(-6).join(' ')}]`))}；`
        + `串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const frame4 = parentClaim.frame;
    const capture4 = captureFor(frame4);
    const view4 = new KernelMemoryView(capture4);
    const parentInfo4 = parentClaim.value.info;
    const parentText4 = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
    const parentTail4 = parentText4.slice(cowParentCursor);
    const parentLine4 = parseGuestParentLine(parentTail4);
    if (parentLine4 !== null) labCowParentPid = parentLine4.pid;
    const cr3Frame4 = frame4.cpu?.control?.cr3 === null || frame4.cpu?.control?.cr3 === undefined
      ? null : BigInt(frame4.cpu.control.cr3);
    const mmAddress4 = await view4.u64(parentInfo4.taskAddress + BigInt(taskOffsets.mm));
    const mm4 = await readMm(view4, layout, mmAddress4);
    const offsetDerivation4 = mm4.pgd === null || cr3Frame4 === null
      ? null : derivePageOffsetBase({ pgdLinear: mm4.pgd, cr3: cr3Frame4 });
    const rootPhysical4 = cr3Frame4 === null ? null : (cr3Frame4 & PHYSICAL_ADDRESS_MASK);
    const tree4 = await readVmas(view4, layout, mmAddress4, { enabledConfigs: localConfigs });
    const vma4 = findVmaForAddress(tree4.vmas, cowVa);
    if (vma4 === null) throw new Error(`停点四：父进程里 ${hex(cowVa)} 不在任何 VMA 里`);
    const walk4 = await walkPageTable(view4, {
      pgd: mm4.pgd, linear: cowVa, pageOffsetBase, levels: 4, rootPhysical: rootPhysical4,
    });
    if (walk4.physical === null) {
      throw new Error(`停点四：父进程 ${hex(cowVa)} 的页表走不到物理地址（${walk4.fault?.kind ?? '无'}）`);
    }
    const pfn4 = walk4.physical >> BigInt(PAGE_SHIFT);
    const byte4 = (await readPhysical(view4, { physical: walk4.physical, pageOffsetBase, length: 8 })).bytes;
    const vmemmap4 = await resolveVmemmapBase(view4, layout, { pfn: pfn4 });
    const folio4 = await readFolioForPfn(view4, layout, { pfn: pfn4, vmemmap: vmemmap4 });

    // 四条独立通道复核父进程这一侧：我们自己的遍历、GDB 参照（`current` 就是父进程）、
    // 服务按这一帧 CR3 的 translate、以及 QEMU 的 `gva2gpa`。
    const ref4 = await runReference(live, 'stop4', {
      va: cowVa, va2: 0n, pfn: pfn4, mm: mmAddress4, cr3: cr3Frame4 ?? 0n,
    });
    if (!ref4.ok) log(`GDB 侧参照（停点四）失败：${ref4.error}`);
    const refData4 = ref4.ok ? ref4.data : {};
    const refFolio4 = refData4.folioAtVa ?? null;
    const parentRefCompare = compareWalkWithReference(walk4, refData4.translation ?? null);
    const parentService = await serviceTranslate(app, base, cowVa, frame4.captureId);
    const parentSvcCompare = parentService.ok
      ? compareWalkWithService(walk4, parentService.translation)
      : { mismatches: [`服务 translate 失败：${parentService.error}`], compared: 0 };
    const parentGvaText = await live.qmp.hmp(`gva2gpa ${toSigned64(cowVa)}`, { timeoutMs: 180000 });
    const parentGvaPhysical = parseGva2gpa(parentGvaText);
    const parentFolioMismatches = [];
    if (refFolio4 !== null && refFolio4 !== undefined) {
      for (const [name, refValue, mineValue] of [
        ['address', refFolio4.address, folio4.address],
        ['flags', refFolio4.flags, folio4.flags],
        ['mapping', refFolio4.mapping, folio4.mapping],
        ['index', refFolio4.index, folio4.index],
      ]) {
        if (refValue === null || refValue === undefined) continue;
        if (String(asBig(refValue)) !== String(mineValue)) {
          parentFolioMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      for (const [name, refValue, mineValue] of [
        ['refcount', refFolio4.refcount, folio4.refcount],
        ['mapcount', refFolio4.mapcount, folio4.mapcount],
        ['pageType', refFolio4.pageType, folio4.pageType],
      ]) {
        if (refValue === null || refValue === undefined || mineValue === null) continue;
        if (Number(refValue) !== Number(mineValue)) {
          parentFolioMismatches.push(`${name}：我们=${mineValue} GDB=${refValue}`);
        }
      }
      if (refFolio4.mappingIsAnon !== folio4.mappingIsAnon) {
        parentFolioMismatches.push(`mappingIsAnon：我们=${folio4.mappingIsAnon} GDB=${refFolio4.mappingIsAnon}`);
      }
      if (refFolio4.anonVmaAddress !== null && refFolio4.anonVmaAddress !== undefined
        && asBig(refFolio4.anonVmaAddress) !== folio4.anonVmaAddress) {
        parentFolioMismatches.push(
          `anon_vma：我们=${hexOrNull(folio4.anonVmaAddress)} GDB=${hex(asBig(refFolio4.anonVmaAddress))}`,
        );
      }
    } else {
      parentFolioMismatches.push('GDB 侧没有给出父进程这一页的 struct page');
    }
    const byte4Text = Buffer.from(byte4).toString('latin1');
    evidence.stop4 = {
      frameId: frame4.frameId,
      captureId: frame4.captureId,
      claimStops: parentClaim.stops,
      attempts: parentClaim.attempts,
      rip: frame4.cpu?.rip,
      comm: parentInfo4.comm,
      pid: parentInfo4.pid,
      taskAddress: hex(parentInfo4.taskAddress),
      mmAddress: hex(mmAddress4),
      mmUsers: mm4.mmUsers,
      mmCount: mm4.mmCount,
      pgd: hexOrNull(mm4.pgd),
      cr3: hexOrNull(cr3Frame4),
      pageOffsetBase: hexOrNull(pageOffsetBase),
      pageOffsetBaseAgain: offsetDerivation4 === null ? null : hex(offsetDerivation4.base),
      mapCount: mm4.mapCount,
      vma: {
        address: hex(vma4.address), start: hex(vma4.vmStart), end: hex(vma4.vmEnd),
        permissions: vma4.permissions, anonVma: hexOrNull(vma4.anonVma), file: hexOrNull(vma4.vmFile),
      },
      physical: hex(walk4.physical),
      pfn: hex(pfn4),
      byte: byte4Text,
      hexBytes: Buffer.from(byte4).toString('hex'),
      folio: {
        address: hex(folio4.address), mapping: hex(folio4.mapping),
        mappingIsAnon: folio4.mappingIsAnon, anonVma: hexOrNull(folio4.anonVmaAddress),
        index: folio4.index.toString(), refcount: folio4.refcount, mapcount: folio4.mapcount,
        pageType: folio4.pageType, pageFlags: folio4.pageFlags,
      },
      guestParentLine: parentLine4,
      reference: {
        run: ref4.ok ? 'stop4' : { error: ref4.error },
        gdbFolio: refFolio4,
        walkCompare: parentRefCompare,
        serviceCompare: parentSvcCompare,
        service: summarizeServiceTranslate(parentService),
        gva2gpa: {
          argument: toSigned64(cowVa).toString(), raw: String(parentGvaText).trim(),
          physical: hexOrNull(parentGvaPhysical),
        },
        folioMismatches: parentFolioMismatches,
      },
      samePfnAsStop3: pfn4 === parentPfn,
      samePfnAsChild: pfn4 === childPfn,
    };
    check(
      'T07c-V12b 停点四把父进程那一侧用四条互不相干的通道复核了一遍：我们自己的页表遍历、GDB 参照（此刻 `current` 就是父进程）、服务按这一帧 CR3 的 translate、QEMU 的 gva2gpa —— 四者给出同一个物理地址；GDB 读的同一页 flags/mapping/index/page_type 与我们相同；而且这个页框与停点三读到的父进程页框是**同一个**（说明父进程从 fork 到 munmap 一直握着原来那一页，中间没有被换掉）',
      ref4.ok === true
        && offsetDerivation4 !== null && offsetDerivation4.base === pageOffsetBase
        && parentInfo4.comm === 'lab-cow'
        && (labCowParentPid === null || parentInfo4.pid === labCowParentPid)
        && parentInfo4.pid !== childInfo.pid
        && parentRefCompare.mismatches.length === 0 && parentSvcCompare.mismatches.length === 0
        && parentGvaPhysical === walk4.physical
        && parentFolioMismatches.length === 0
        && pfn4 === parentPfn && pfn4 !== childPfn,
      `父进程 pid=${parentInfo4.pid}（客体自报 parent=${labCowParentPid}）mm=${hex(mmAddress4)}；`
        + `VA=${hex(cowVa)} → 物理=${hex(walk4.physical)} 页框=${hex(pfn4)}；`
        + `四条通道：我们=${hex(walk4.physical)}，GDB=${refData4.translation?.physical === null || refData4.translation?.physical === undefined ? '未映射' : hex(asBig(refData4.translation.physical))}`
        + `（逐级不一致 ${parentRefCompare.mismatches.length}），服务=${parentService.ok ? (parentService.translation?.physical ?? '未映射') : parentService.error}`
        + `（逐级不一致 ${parentSvcCompare.mismatches.length}），gva2gpa=${String(parentGvaText).trim()}；`
        + `与停点三的父进程页框相同=${pfn4 === parentPfn}（停点三 ${hex(parentPfn)}），与子进程页框不同=${pfn4 !== childPfn}（子进程 ${hex(childPfn)}）；`
        + `struct page 字段不一致 ${parentFolioMismatches.length}`
        + (parentFolioMismatches.length === 0 ? '' : `；明细：${parentFolioMismatches.slice(0, 6).join(' | ')}`),
    );
    check(
      'T07c-V12c COW 的分裂在两个方向上都闭合：子进程那一页的物理字节是 C、父进程那一页是 A（两个进程各写各的）；'
        + '两页的 refcount 都等于「映射数 1 + 这一页是不是还在每 CPU 的 LRU 待入队批次里」、_mapcount 都是 0（按内核约定 `page_mapcount()` 是 `_mapcount + 1`，'
        + '所以 0 就是"正好被一个页表项映射"，即写时复制之后这一页不再与任何其他地址空间共享；'
        + '若没发生 COW，这里该是 1 = 映射两次）；父进程的页框在停点三与停点四两次独立读数里完全相同，'
        + '说明它没有被顺手换走',
      childByteText[0] === 'C' && byte4Text[0] === 'A'
        && childFolio.refcount === expectedAnonRefcount(childFolio, 1)
        && folio4.refcount === expectedAnonRefcount(folio4, 1)
        && childFolio.mapcount === 0 && folio4.mapcount === 0
        && parentFolio.mapcount === 0
        && childPfn !== pfn4
        && pfn4 === parentPfn
        && childFolio.index === (cowVa >> BigInt(PAGE_SHIFT))
        && folio4.index === (cowVa >> BigInt(PAGE_SHIFT)),
      `子进程页：字节=${JSON.stringify(childByteText)} refcount=${childFolio.refcount}（该有 ${expectedAnonRefcount(childFolio, 1)}）`
        + ` PG_lru=${childFolio.pageFlags.includes('PG_lru')}`
        + ` _mapcount=${childFolio.mapcount}（=映射 ${childFolio.mapcount + 1} 次）index=${childFolio.index} 页框=${hex(childPfn)}；`
        + `父进程页：字节=${JSON.stringify(byte4Text)} refcount=${folio4.refcount}（该有 ${expectedAnonRefcount(folio4, 1)}）`
        + ` PG_lru=${folio4.pageFlags.includes('PG_lru')}`
        + `_mapcount=${folio4.mapcount}（=映射 ${folio4.mapcount + 1} 次）index=${folio4.index} 页框=${hex(pfn4)}；`
        + `停点三读到的父进程页框=${hex(parentPfn)}（refcount=${parentFolio.refcount} _mapcount=${parentFolio.mapcount}）；`
        + `两个页框不同=${childPfn !== pfn4}`,
    );

    } catch (error) {
      /**
       * COW 这一段失败了：如实记录，不中断整轮。用 `results` 里**已有的**检查项判断
       * 到底哪几条没来得及验证 —— 停点四失败时 V12a/V12b 可能已经写进去了，
       * 这时只该把 V12c 标成未通过，而不是把三条一起冤掉。
       */
      const recorded = (needle) => results.some((entry) => entry.id.includes(needle));
      const message = String(error?.message ?? error).slice(0, 2000);
      if (!recorded('T07c-V12a')) {
        check('T07c-V12a COW 的同一时刻证据（子进程 do_exit 那一刻，子/父两侧各一个物理页）', false,
          `停点三段落没能走完：${message}`);
      }
      if (!recorded('T07c-V12b')) {
        check('T07c-V12b 停点四把父进程那一侧用四条独立通道复核', false,
          `停点三/四段落没能走完：${message}`);
      }
      if (!recorded('T07c-V12c')) {
        check('T07c-V12c COW 的分裂在两个方向上都闭合', false,
          `停点三/四段落没能走完：${message}`);
      }
      if (evidence.stop3 === undefined) evidence.stop3 = { claimFailed: true };
      evidence.stop3.failure = message;
      if (evidence.stop4 === undefined) evidence.stop4 = { claimFailed: true };
      evidence.stop4.failure = message;
      log(`COW 段落失败（已写进证据，不中断整轮）：${message}`);
    }

    /* ---------- V13：边界 ---------- */

    /**
     * 边界这一节的要点不是"能报错"，而是**报出正确的类别**：`mm == NULL` 在内核里
     * 是内核线程与僵尸的正常形态，必须和"内存读不到"分开；越界页框号必须当场拒掉
     * 而不是绕回第 0 个 section 读出一页无关的内存；空洞地址必须是"没有映射"，
     * 而不是被 `mprotect(PROT_NONE)` 那种"页在但没权限"的形态混过去。
     */
    const expectThrow = async (label, action, code) => {
      try {
        const value = await action();
        const text = value === undefined || value === null
          ? String(value)
          : (typeof value === 'object' ? JSON.stringify(jsonSafe(value)).slice(0, 200) : String(value));
        return { label, expected: code, ok: false, got: `没有抛错，返回了 ${text}` };
      } catch (error) {
        return {
          label,
          expected: code,
          ok: error?.code === code,
          got: `code=${error?.code ?? '（没有 code）'} message=${String(error?.message ?? error).slice(0, 200)}`,
        };
      }
    };
    const sortedVmas = [...tree1.vmas].sort(
      (a, b) => (a.vmStart < b.vmStart ? -1 : (a.vmStart > b.vmStart ? 1 : 0)),
    );
    let holeAddress = null;
    for (let index = 1; index < sortedVmas.length; index += 1) {
      if (sortedVmas[index].vmStart > sortedVmas[index - 1].vmEnd) {
        holeAddress = sortedVmas[index - 1].vmEnd;
        break;
      }
    }
    const holeWalk = holeAddress === null ? null : await walkPageTable(view1, {
      pgd: mm.pgd, linear: holeAddress, pageOffsetBase, levels: 4, rootPhysical,
    });
    const holeInVma = holeAddress === null ? null : findVmaForAddress(tree1.vmas, holeAddress);
    const truncatedWalk = await walkMapleTree(view1, layout, mm.mmMtAddress, { maxDepth: 0 });
    const rangedVmas = sortedVmas.length > 1
      ? await readVmas(view1, layout, mmAddress, { indexMax: tree1.vmas[0].vmEnd - 1n })
      : null;
    const rangedOutOfRange = rangedVmas === null
      ? [] : rangedVmas.vmas.filter((vma) => vma.vmStart > tree1.vmas[0].vmEnd - 1n);
    const boundaryThrows = [];
    boundaryThrows.push(await expectThrow(
      'mm_struct 地址为 0（内核线程/僵尸的正常形态）',
      () => readMm(view1, layout, 0n),
      'null-mm',
    ));
    boundaryThrows.push(await expectThrow(
      'readVmas 的 mm 地址为 0',
      () => readVmas(view1, layout, 0n, {}),
      'null-mm',
    ));
    boundaryThrows.push(await expectThrow(
      'vm_area_struct 地址为 0',
      () => readVma(view1, layout, 0n),
      'null-vma',
    ));
    boundaryThrows.push(await expectThrow(
      `VMA 序号越界（共 ${tree1.vmas.length} 条，取第 ${tree1.vmas.length} 条）`,
      () => Promise.resolve(selectVmaByIndex(tree1.vmas, tree1.vmas.length)),
      'vma-index-out-of-range',
    ));
    boundaryThrows.push(await expectThrow(
      'VMA 序号为负数',
      () => Promise.resolve(selectVmaByIndex(tree1.vmas, -1)),
      'vma-index-out-of-range',
    ));
    boundaryThrows.push(await expectThrow(
      '页框号超出本内核的 section 总数（1 << 34，第 524288 个 section）',
      () => resolveVmemmapBase(view1, layout, { pfn: 1n << 34n }),
      'pfn-out-of-range',
    ));
    boundaryThrows.push(await expectThrow(
      '物理地址为负',
      () => readPhysical(view1, { physical: -1n, pageOffsetBase, length: 8 }),
      'negative-physical',
    ));
    boundaryThrows.push(await expectThrow(
      '直映射偏移被换成 0（物理地址加出来落在用户半区）',
      () => readPhysical(view1, { physical: 0x1000n, pageOffsetBase: 0n, length: 8 }),
      'physical-out-of-map',
    ));
    const okVma = tree1.vmas.length > 0 ? selectVmaByIndex(tree1.vmas, 0) : null;
    evidence.stop1.boundaries = {
      hole: holeAddress === null ? null : {
        address: hex(holeAddress),
        inAnyVma: holeInVma !== null,
        physical: hexOrNull(holeWalk?.physical),
        fault: holeWalk?.fault ?? null,
        levels: holeWalk?.walk.length ?? null,
      },
      noHole: holeAddress === null,
      truncation: {
        maxDepthZero: { truncated: truncatedWalk.truncated, entries: truncatedWalk.entries.length, nodesVisited: truncatedWalk.nodesVisited },
        note: truncatedWalk.notes,
      },
      indexRange: rangedVmas === null ? null : {
        indexMax: hex(tree1.vmas[0].vmEnd - 1n),
        returned: rangedVmas.vmas.length,
        total: tree1.vmas.length,
        outOfRange: rangedOutOfRange.length,
      },
      throws: boundaryThrows,
      selectFirst: okVma === null ? null : { address: hex(okVma.address), start: hex(okVma.vmStart), end: hex(okVma.vmEnd) },
    };
    check(
      'T07c-V13 边界行为逐条正确：空洞地址的页表遍历报"没有映射"（而不是被 PROT_NONE 那种"页在但没权限"的形态混过去）；`mm`/`vma` 地址为 0 时报 `null-mm`/`null-vma`（不是笼统的读取失败）；越界与负数 VMA 序号报 `vma-index-out-of-range` 而第 0 条正常返回；页框号超出 section 总数被拒；物理地址为负、直映射偏移不对导致落进用户半区，两条都被拒；`maxDepth: 0` 真的把遍历截断并置 `truncated`；index 上限过滤真的把范围外的条目挡在结果之外',
      holeAddress !== null && holeInVma === null
        && holeWalk.physical === null && holeWalk.fault?.kind === 'not-present'
        && !/PROTNONE|PROT_NONE/.test(String(holeWalk.fault?.detail ?? ''))
        && truncatedWalk.truncated === true && truncatedWalk.entries.length === 0
        && rangedVmas !== null && rangedOutOfRange.length === 0 && rangedVmas.vmas.length < tree1.vmas.length
        && okVma !== null && okVma.address === tree1.vmas[0].address
        && boundaryThrows.length === 8 && boundaryThrows.every((entry) => entry.ok === true),
      `空洞 ${holeAddress === null ? '没找到（所有 VMA 首尾相接，这条跳过）' : `${hex(holeAddress)} → 不在任何 VMA、`
        + `物理=${hexOrNull(holeWalk.physical)}、类别=${holeWalk.fault?.kind}（detail=${holeWalk.fault?.detail ?? '无'}）`}；`
        + `maxDepth=0 时 truncated=${truncatedWalk.truncated} 条目=${truncatedWalk.entries.length}；`
        + `index 上限过滤：返回 ${rangedVmas === null ? '未测' : `${rangedVmas.vmas.length}/${tree1.vmas.length}`} 条，`
        + `其中越界 ${rangedOutOfRange.length} 条；`
        + `8 条抛错断言：${boundaryThrows.map((entry) => `${entry.ok ? '对' : '错'}[${entry.label}→期望 ${entry.expected}，${entry.got}]`).join('；')}`,
    );

    /* ---------- V14：契约对象（面板真正消费的那一层） ---------- */

    // 前面十几条验的都是"解析器读出来的字段对不对"。这一条验的是**出口**：同一份内部
    // 结果转成契约类型之后，面板看到的东西是否还诚实。契约层最容易出的错不是"值错"，
    // 而是**把"没有"编码成了某个看起来正常的数字**：匿名 VMA 的 `fileOffset` 若写成
    // `0x0`，面板上就凭空多出一条"来自文件偏移 0 的映射"；`mm->start_code` 为 0（表示
    // 没有这项）若写成 `0x0`，面板会指着一个合法地址说"代码从这里开始"；反过来把真实
    // 的 `0x0` 写成 `null` 一样是丢信息。`0` 在地址空间里是合法值，所以"空"必须有
    // 独立的表达 —— 契约里这个表达就是 `null`。下面两个方向都查。
    const vmaRefs = tree1.vmas.map(toVmaRef);
    const spaceRef = toAddressSpaceRef(tree1, { pid: current1.pid, pgdPhysical: rootPhysical });
    const fileFolioRef = toFolioRef(filePageFolio);
    const anonFolioRef = toFolioRef(memFolio1);
    const firstVmaRef = toVmaRef(selectVmaByIndex(tree1.vmas, 0));
    const contractProblems = [];
    const HEX_TEXT = /^0x[0-9a-f]+$/;
    const isHexText = (value) => typeof value === 'string' && HEX_TEXT.test(value);
    const note = (text) => contractProblems.push(text);

    for (const [index, ref] of vmaRefs.entries()) {
      const vma = tree1.vmas[index];
      if (!isHexText(ref.address) || !isHexText(ref.end)) {
        note(`VMA[${index}] 的 address/end 不是 "0x…" 形式的十六进制串：${String(ref.address)} / ${String(ref.end)}`);
        continue;
      }
      if (BigInt(ref.address) !== vma.vmStart || BigInt(ref.end) !== vma.vmEnd) {
        note(`VMA[${index}] 契约地址与结构字段对不上：${ref.address}..${ref.end} vs ${hex(vma.vmStart)}..${hex(vma.vmEnd)}`);
      }
      // 权限串固定 4 位：3 个权限位 + 1 个 p/s 标记（`rwxp` 那样）。少一位的话面板会把
      // `rw-p` 与 `rwx` 的列读串行，多一位说明拼接逻辑被人改过。
      if (typeof ref.permissions !== 'string' || ref.permissions.length !== 4) {
        note(`VMA[${index}] 的 permissions 不是 4 位：${JSON.stringify(ref.permissions)}`);
      }
      if (typeof ref.source !== 'string' || ref.source.length === 0) {
        note(`VMA[${index}] 的 source 不是非空字符串：${JSON.stringify(ref.source)}`);
      }
      if (vma.vmFile === null) {
        if (ref.fileOffset !== null) {
          note(`VMA[${index}] 是匿名映射（vm_file 为空），fileOffset 却是 ${String(ref.fileOffset)}（应为 null）`);
        }
        // `VM_STACK` 就是 `VM_GROWSDOWN`（本内核 `CONFIG_STACK_GROWSUP` 关闭），
        // 所以栈的判据是这一位立着——和 `vmaSourceLabel()` 用的是同一个判据。
        if ((vma.vmFlags & VM_BITS.growdown) !== 0n) {
          if (ref.source !== '[stack]') note(`VMA[${index}] 带 VM_GROWSDOWN 的栈，source 却是 ${JSON.stringify(ref.source)}`);
        } else if (ref.source !== '[anon]') {
          note(`VMA[${index}] 匿名非栈映射，source 却是 ${JSON.stringify(ref.source)}`);
        }
      } else {
        if (!isHexText(ref.fileOffset)) {
          note(`VMA[${index}] 有文件映射，fileOffset 却不是十六进制串：${JSON.stringify(ref.fileOffset)}`);
        } else if (BigInt(ref.fileOffset) !== vma.vmPgoff * PAGE_SIZE) {
          note(`VMA[${index}] 的 fileOffset（字节口径）与 vm_pgoff×页大小 对不上：${ref.fileOffset} vs ${hex(vma.vmPgoff * PAGE_SIZE)}`);
        }
        if (ref.source !== `file:${hex(vma.vmFile)}`) {
          note(`VMA[${index}] 文件映射的 source 应为 file:<struct file 地址>，实际 ${JSON.stringify(ref.source)}`);
        }
      }
    }

    if (spaceRef.pid !== current1.pid) {
      note(`AddressSpaceRef.pid：契约=${spaceRef.pid} 停点里 current 的 pid=${current1.pid}`);
    }
    if (spaceRef.mmAddress !== hex(mmAddress)) {
      note(`AddressSpaceRef.mmAddress：契约=${String(spaceRef.mmAddress)} 我们读的=${hex(mmAddress)}`);
    }
    if (spaceRef.vmas.length !== tree1.vmas.length) {
      note(`AddressSpaceRef.vmas 条数：契约=${spaceRef.vmas.length} 树里=${tree1.vmas.length}`);
    }
    if (typeof spaceRef.truncated !== 'boolean' || spaceRef.truncated !== tree1.truncated) {
      note(`AddressSpaceRef.truncated 不是布尔或与遍历结果不一致：${JSON.stringify(spaceRef.truncated)} vs ${tree1.truncated}`);
    }
    if (spaceRef.structure !== 'maple-tree') {
      note(`AddressSpaceRef.structure 没写明用的是 maple-tree：${JSON.stringify(spaceRef.structure)}`);
    }
    if (rootPhysical === null) {
      if (spaceRef.pgdPhysical !== null) note(`CR3 这次没取到，pgdPhysical 应为 null，实际 ${String(spaceRef.pgdPhysical)}`);
    } else if (spaceRef.pgdPhysical !== hex(rootPhysical)) {
      note(`AddressSpaceRef.pgdPhysical：契约=${String(spaceRef.pgdPhysical)} 帧里 CR3 的物理地址=${hex(rootPhysical)}`);
    }
    // `mm->start_code` 为 0 表示"这项没有"（内核里它就是这样表达未设置的），契约用 null；
    // 两个方向都查：该给 null 时不能给 `0x0`，该给真地址时不能给 null。
    const expectStartCode = mm.startCode === 0n ? null : hex(mm.startCode);
    if (spaceRef.startCode !== expectStartCode) {
      note(`AddressSpaceRef.startCode：契约=${String(spaceRef.startCode)} 期望=${String(expectStartCode)}（mm->start_code=${hex(mm.startCode)}，0 表示未设置→null）`);
    }
    const expectEndCode = mm.endCode === 0n ? null : hex(mm.endCode);
    if (spaceRef.endCode !== expectEndCode) {
      note(`AddressSpaceRef.endCode：契约=${String(spaceRef.endCode)} 期望=${String(expectEndCode)}`);
    }
    const expectStartStack = mm.startStack === 0n ? null : hex(mm.startStack);
    if (spaceRef.startStack !== expectStartStack) {
      note(`AddressSpaceRef.startStack：契约=${String(spaceRef.startStack)} 期望=${String(expectStartStack)}`);
    }
    const vmaEvidence = spaceRef.evidence ?? {};
    if (typeof vmaEvidence.kind !== 'string' || typeof vmaEvidence.source !== 'string' || !Array.isArray(vmaEvidence.refs)) {
      note(`AddressSpaceRef.evidence 形状不对（需要 kind/source 字符串与 refs 数组）：${JSON.stringify(vmaEvidence).slice(0, 200)}`);
    }

    if (firstVmaRef.address !== hex(tree1.vmas[0].vmStart) || firstVmaRef.end !== hex(tree1.vmas[0].vmEnd)) {
      note(`selectVmaByIndex(…, 0) 转出来的契约地址与第 0 条 VMA 不一致：${firstVmaRef.address}..${firstVmaRef.end} vs ${hex(tree1.vmas[0].vmStart)}..${hex(tree1.vmas[0].vmEnd)}`);
    }

    // 文件页：`mappingIsAnon === false`，所以契约里 `fileOffset` 必须给出**字节**偏移。
    // 若实现偷懒给了页号，面板会在文件里指到早 4096 倍的位置，而那个位置通常也是合法
    // 的——只是内容不对，肉眼看不出来。
    if (filePageFolio.mappingIsAnon) {
      note('停点一挑的那个地址说是文件页，folio 却标成匿名页（这条检查的对象就错了）');
    }
    if (fileFolioRef.pfn !== hex(filePageFolio.pfn)) {
      note(`文件页 FolioRef.pfn：契约=${String(fileFolioRef.pfn)} 我们读的=${hex(filePageFolio.pfn)}`);
    }
    if (fileFolioRef.address !== hex(filePageFolio.address)) {
      note(`文件页 FolioRef.address：契约=${String(fileFolioRef.address)} 我们算的=${hex(filePageFolio.address)}`);
    }
    if (fileFolioRef.fileOffset !== hex(filePageFolio.index * PAGE_SIZE)) {
      note(`文件页 FolioRef.fileOffset 应为 index×页大小：契约=${String(fileFolioRef.fileOffset)} 期望=${hex(filePageFolio.index * PAGE_SIZE)}`);
    }
    if (fileFolioRef.inodeAddress !== null) {
      note(`我们没给 inode 地址，FolioRef.inodeAddress 就该是 null，实际 ${String(fileFolioRef.inodeAddress)}`);
    }
    if (typeof fileFolioRef.dirty !== 'boolean' || typeof fileFolioRef.uptodate !== 'boolean') {
      note(`FolioRef.dirty/uptodate 不是布尔：${JSON.stringify({ dirty: fileFolioRef.dirty, uptodate: fileFolioRef.uptodate })}`);
    } else {
      if (fileFolioRef.dirty !== filePageFolio.pageFlags.includes('PG_dirty')) {
        note(`FolioRef.dirty=${fileFolioRef.dirty} 与页标志 ${JSON.stringify(filePageFolio.pageFlags)} 不一致`);
      }
      if (fileFolioRef.uptodate !== filePageFolio.pageFlags.includes('PG_uptodate')) {
        note(`FolioRef.uptodate=${fileFolioRef.uptodate} 与页标志 ${JSON.stringify(filePageFolio.pageFlags)} 不一致`);
      }
    }

    // 匿名页：`mappingIsAnon === true`，契约里**必须**是 `null`。这条是整段里最值钱的
    // 一句：把匿名页的"页偏移"（其实是虚拟页号）当作文件偏移报出去，等于告诉面板
    // "这个进程的栈来自某个文件的第 N 页"，而 N 完全可以是任意合法数字。
    if (!memFolio1.mappingIsAnon) {
      note(`停点二那个页本该是匿名页，folio 的 mapping 却不像 anon_vma：${hex(memFolio1.mapping)}`);
    }
    if (anonFolioRef.fileOffset !== null) {
      note(`匿名页的 FolioRef.fileOffset 应为 null，实际 ${String(anonFolioRef.fileOffset)}（把虚拟页号当文件偏移是最典型的错法）`);
    }
    if (anonFolioRef.pfn !== hex(memPfn1)) {
      note(`匿名页 FolioRef.pfn：契约=${String(anonFolioRef.pfn)} 页表给出的=${hex(memPfn1)}`);
    }
    if (anonFolioRef.address !== hex(memFolio1.address)) {
      note(`匿名页 FolioRef.address：契约=${String(anonFolioRef.address)} 我们算的=${hex(memFolio1.address)}`);
    }

    evidence.stop1.contract = {
      vmaCount: vmaRefs.length,
      space: {
        pid: spaceRef.pid, mmAddress: spaceRef.mmAddress,
        startCode: spaceRef.startCode, endCode: spaceRef.endCode, startStack: spaceRef.startStack,
        expectedStartCode: expectStartCode, expectedEndCode: expectEndCode, expectedStartStack: expectStartStack,
        pgdPhysical: spaceRef.pgdPhysical, expectedPgdPhysical: hexOrNull(rootPhysical),
        truncated: spaceRef.truncated, structure: spaceRef.structure,
      },
      fileFolio: jsonSafe(fileFolioRef),
      anonFolio: jsonSafe(anonFolioRef),
      firstVma: jsonSafe(firstVmaRef),
      sampleVmas: jsonSafe(vmaRefs.slice(0, 6)),
      problems: contractProblems,
    };
    check(
      'T07c-V14 契约对象诚实：VMA 的地址/区间/4 位权限串/来源标签与结构字段一一对应，文件映射的 fileOffset 是字节口径（vm_pgoff×4096）而匿名映射是 null；AddressSpaceRef 的 pid/mm/条数/truncated/structure 与解析结果一致，pgdPhysical 等于 CR3 里的物理地址，`mm->start_code` 为 0 的"未设置"被翻成 null 而不是 `0x0`；文件页 FolioRef 给出字节偏移、匿名页 FolioRef 的 fileOffset 必须是 null',
      contractProblems.length === 0 && vmaRefs.length > 0,
      `契约问题 ${contractProblems.length} 条${contractProblems.length === 0 ? '' : `：${contractProblems.slice(0, 8).join('；')}`}；`
        + `VMA ${vmaRefs.length} 条、结构 ${spaceRef.structure}、truncated=${spaceRef.truncated}、`
        + `pgdPhysical=${String(spaceRef.pgdPhysical)}、startCode=${String(spaceRef.startCode)}（mm 里是 ${hex(mm.startCode)}）；`
        + `文件页 fileOffset=${String(fileFolioRef.fileOffset)}、匿名页 fileOffset=${String(anonFolioRef.fileOffset)}`,
    );

    /* ---------- 收尾：暂停会话、留档现场 ---------- */

    await cmd('pause');
    const finalTail = await call(app, 'GET', `${base}/terminal`);
    evidence.terminalTail = String(finalTail.body?.text ?? '').slice(-1500);
    // 把构建锁原样留一份：这条验收用的 vmlinux / QEMU / 内核源码树版本，日后回看
    // 证据时不必再去猜"当时是哪个构建"。
    evidence.buildLock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'instrumentation/qemu-observer/build.lock.json'), 'utf8'),
    );
  } catch (error) {
    check('T07c 脚本异常', false, error.message);
    evidence.error = { message: error.message, stack: String(error.stack).slice(0, 2000) };
  } finally {
    // 会话必须**真的关掉**：这里跑的是真实 QEMU + GDB，一个没关干净的会话会在后台
    // 持续吃 CPU，并且留下一个占着端口与磁盘文件的 TCG 进程。所以关掉之后按会话号
    // 数一遍进程（`ps` 里命令行含这个会话号的都算），必须是 0 —— 不看接口返回的
    // `closed: true` 就收工，等于自己给自己盖章。
    if (session) {
      const closed = await call(app, 'DELETE', `/api/sessions/${session.id}`);
      await sleep(1500);
      const leftover = countSessionProcesses(session.id);
      check(
        'T07c-V15 会话关闭成功且没有残留 QEMU/GDB 进程',
        closed.status === 200 && closed.body?.closed === true && leftover === 0,
        `${describe(closed.body)}；残留进程数=${leftover}`,
      );
    } else {
      check('T07c-V15 会话关闭成功且没有残留 QEMU/GDB 进程', false, '会话压根没建起来，无从关闭');
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













