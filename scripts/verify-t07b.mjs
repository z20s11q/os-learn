#!/usr/bin/env node
/**
 * T07b 验收：任务解析器与 GDB 独立对照。
 *
 *   node scripts/verify-t07b.mjs        （约 10–20 分钟，TCG 上要真启动一台 Linux）
 *
 * 为什么必须找"另一套实现"来对照：
 *   偏移写错时读出来的东西**照样像个正常值**。`task_struct.tasks` 少加 8 字节，任务链表
 *   也能走出若干节点，只是每个"任务"其实是别的字段拼出来的。唯一能抓住这类错的办法，是让
 *   另一套机制读同一份内存再逐字段比。这里用了四条互不相干的通道：
 *     1. 解析器：布局来自 T07a 的 DWARF 产物，per-CPU 基址来自 `__per_cpu_offset[0]`，
 *        字节来自服务的**线性地址读**（GDB MI `-data-read-memory-bytes`）。
 *     2. GDB 侧参照（`scripts/t07b-gdb-reference.py`）：类型与偏移由 **GDB 自己的 DWARF**
 *        解释，per-CPU 基址来自 **CPU 的 `%gs` 基址**，而不是 `__per_cpu_offset[]` 数组。
 *     3. 帧里的段缓存：观察者在**同一个停止点**取到的 `%gs` 隐藏基址（QEMU 的 CPU 状态）。
 *     4. 内核源码：状态常量与字符表从 `.h`/`.c` 现场重解析，而不是抄一份常量进脚本。
 *   两条完全不同的机制（`%gs` 基址 vs `__per_cpu_offset[0]`）都必须算出同一个 `current`，
 *   才算把 per-CPU 公式验住 —— 这是这个子任务里最容易"看起来对"的一步。
 *
 * 为什么 GDB 侧写成 Python 而不是一串 GDB 命令：
 *   `-batch` 下第一个错误就会中断整串命令，而"某个字段 GDB 读不到"本身是要被报出来的结果。
 *   用 Python 逐字段 try/except，一项失败不影响其余，失败也能进证据。
 *
 * 四个停点（都在真实 lab 程序上）：
 *   停点一 `ext2_file_read_iter` + current.comm == lab-read → 选中任务/链表/父子/栈/队列/信号
 *   停点二 `__x64_sys_wait4` + current.comm == lab-cow   → 父任务与它的子任务（fork 之后）
 *   停点三 `do_notify_parent` + 已置 EXIT_ZOMBIE         → 僵尸态：只能靠 exit_state 认出来
 *   停点四 `release_task` + 入参 rdi 是被回收的任务      → 回收态：exit_state 已变 EXIT_DEAD
 *
 * 为什么四个停点全部用**软件断点**（`kind: 'software'`，即 GDB 下发不带 `-h` 的
 * `-break-insert`，往内核代码里写一个 `int3`）：
 *   硬件断点是往 x86 的调试寄存器（DR0/DR7）里写地址实现的，而内核在**任务切换**时会
 *   按当前任务的调试状态重写这些寄存器。于是同一个地址会出现「停在 shell 上能命中、
 *   切到 lab-read 就再也不停」的现象 —— 断点被内核悄悄抹掉了，而 GDB 与 QEMU 都不会
 *   报错，症状只是「等不到那个停点」。这个坑本脚本真的踩过（48 次认领里唯独漏掉
 *   最后那次 lab-read）。软件断点写在内核文本里，与 CPU 调试寄存器无关，不随任务切换失效。
 *
 * 为什么停点一选 `ext2_file_read_iter` 而不是 `__x64_sys_read`：
 *   `read` 是**所有进程共用**的系统调用入口，而 busybox 的行编辑是**一个字节一次 `read`** 的，
 *   所以敲进去一条 45 字符的命令会先产生四十多次 `sh` 停点，`lab-read` 自己的那次排在最后。
 *   更要命的是这四十多次停点会让「认领靠逐次 `continue`」变成一条很长的链，任何一次漏帧都
 *   直接表现为「等不到 lab-read」——本脚本真的连续两轮栽在这里（48 次停点全是 `sh`）。
 *   `ext2_file_read_iter` 是 ext2 普通文件的 `read_iter`，只有真的从 ext2 盘上读文件才会经过，
 *   终端读取永远走不到它。于是停点数量从四十几降到几次，而且停点本身就证明了
 *   「有个真实进程真的去读了盘上的文件」——这比停在共用系统调用入口更有信息量。
 *   认领仍然保留（`execve` 装载 lab-read 这个 ELF 时，内核也会经它读文件，那些停点的
 *   comm 还是 `sh`），但循环会逐次记下每次停点的 comm（`claimTrace`）并如实进证据。
 *
 * 检查项：
 *   V1  布局产物与现场 vmlinux 绑定（build ID + sha256 现场重算）；必需类型缺失为 0；
 *       客体内核 release 与产物自述一致；readelf / 服务 / 布局三方的符号事实一致
 *   V2  per-CPU 公式三源一致：__per_cpu_offset[0] == GDB 的 %gs 基址 == 帧里 %gs 隐藏基址
 *   V3  停在 ext2_file_read_iter（lab-read 的文件读路径）且 current 就是 lab-read
 *   V4  current 逐字段与 GDB 侧独立实现一致（约 30 个字段）
 *   V5  任务链表：init_task 起点、节点地址集合、pid/tgid 集合与 GDB 一致；无截断、不误报环
 *   V6  父子：real_parent/parent 一致，父任务的 children 链表含 current，且与 GDB 走出的
 *       子进程集合相同；lab-cow 停点上同样成立
 *   V7  线程组：signal_struct.thread_head 走出的线程与 GDB 一致
 *   V8  栈：THREAD_SIZE 由符号表算出（不写死 16384），rsp 落在 current 的内核栈区间内
 *   V9  runqueue：八项摘要与 GDB 一致；rq.curr == current；rq.cpu 自述为 0
 *   V10 状态解码与内核源码现场重解析一致（TASK_REPORT 折叠 + IDLE/RTLOCK/FROZEN 特例
 *       + fls + "RSDTtXZPI"），含"__state 无报告位但 exit_state 说僵尸"的输入
 *   V11 僵尸陷阱：脱离 __state 单看 exit_state 才认得出 Z，且 mm 已被摘掉；参照实现同读数
 *   V12 回收态：release_task 的 rdi 是被回收任务，它此刻仍在链表上，exit_state 已变 DEAD
 *   V13 遍历上限/环检测/越界 CPU/非 per-CPU 符号在真实数据上生效
 *   V14 KernelTask → ProcessRef 契约字段
 *   V15 会话关闭且无残留 QEMU/GDB 进程
 *
 * 结果写入 `artifacts/verify/t07b.json` 与 `artifacts/verify/t07b.log`。
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
  PerCpuIndex,
  STATE_CHARS,
  decodeTaskState,
  dedupedManifest,
  fls,
  readChildren,
  readCurrentTask,
  readRunqueue,
  readTask,
  readTaskList,
  readThreadGroup,
  threadSizeOf,
  toProcessRef,
  walkList,
} from '../packages/linux-decoder/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VMLINUX = path.join(ROOT, 'artifacts/build/linux/vmlinux');
const LAYOUT_PATH = path.join(ROOT, 'artifacts/layout/linux-6.12.112-observatory-f5e5edc1c572.json');
const REFERENCE_PY = path.join(ROOT, 'scripts/t07b-gdb-reference.py');
const SCHED_H = path.join(ROOT, 'src/linux-6.12.112/include/linux/sched.h');
const ARRAY_C = path.join(ROOT, 'src/linux-6.12.112/fs/proc/array.c');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t07b.json');
const EVIDENCE_LOG = path.join(ROOT, 'artifacts/verify/t07b.log');

/** 客体登录提示符（与其它验收脚本同一判据）。 */
const PROMPT = /linux-lab:[^\r\n]*# /;
const EXIT_DEAD = 0x10;
const EXIT_ZOMBIE = 0x20;
/** 认领别人的停点时最多重新 continue 多少次、最多等多久。 */
const MAX_STOPS = 600;
const CLAIM_BUDGET_MS = 240000;

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

/** 证据里可能混着 bigint（地址、jiffies），JSON 序列化前统一转十进制字符串。 */
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
 * 读取 JSON，但**不让大整数掉进双精度陷阱**。
 *
 * 为什么不能直接用 `JSON.parse`：JS 的整数字面量一律变成 IEEE-754 双精度数（`number`），
 * 只有 ≤ 2^53 的整数才精确。GDB 侧对照数据里的内核地址全是 `0xffffffff81e0a940` 这个量级
 * （约 1.8e19），一落进 `number` 就被就近取整成另一个地址：
 *
 *   精确值 0xffffffff81e0a940 → 读成 0xffffffff81e0a800
 *   精确值 0xffff88801f42cc80 → 读成 0xffff88801f42d000
 *   精确值 0xffff88800304ab80 → 读成 0xffff88800304a800
 *
 * 这个坑的症状极具误导性：地址"看起来仍是个正常地址"，只偏了几百字节；`pid` 这类小整数
 * 完好无损，现场于是表现为"pid 集合相同、地址集合不同"，很容易被误判成 GDB 符号解析错乱
 * 或读通道错位 —— 真凶其实在读取端，与内核、与 GDB 都无关。
 *
 * 做法：把文本里**字符串之外**的 16 位以上整数字面量加引号再交给 `JSON.parse`，
 * 它们就以十进制字符串的身份完整抵达，`BigInt()` 一取就是精确值。
 * 不能图省事用正则全文替换：字符串里出现的长数字会被一起加引号，直接毁掉 JSON。
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
      // 浮点/指数写法（1.5、1e+19）与小整数（≤ 2^53）原样留着，只有真正的 64 位整数才加引号。
      const touched = after === '.' || after === 'e' || after === 'E' || /[0-9A-Za-z_.]/.test(before ?? '');
      if (!touched && digits.length >= 16) {
        const negative = before === '-' && !/[0-9A-Za-z_.]/.test(text[index - 2] ?? '');
        if (negative) out = out.slice(0, -1); // 刚写出去的那个 '-' 要挪进引号里，`-"123"` 不是合法 JSON
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

/**
 * 把 GDB 侧对照值取成 `BigInt`。
 *
 * 经 `parseBigJson` 之后，64 位地址是十进制字符串而小整数仍是 `number`，`BigInt()` 两种都吃；
 * 只有"GDB 自己没读到这个字段"才是 `null`，这里必须原样返回 `null` —— `BigInt(null)` 会抛异常，
 * 一个字段读不到不该把整轮验收炸掉。
 */
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
 * `READ""Y-DONE-`，而真正的输出是 `READY-DONE-0`，两者不可能混淆。
 * 注意引号必须**成对**：写成 `echo READ"Y-DONE-$?` 会让 shell 停在 PS2 续行提示符上等输入，
 * 命令根本不会执行（这个坑已经踩过一次，串口上留下的是一个孤零零的 `> `）。
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
 * 反复"装断点 → 递命令 → 认领停点"，直到认领成功（或尝试次数用完）。
 *
 * 为什么必须重试（这是实测出来的事实，不是防御性编程）：
 *   断点是"先装、后由客体里的另一个进程去触发"的，而这两步之间隔着一次 `execve`
 *   （shell 要 fork+exec 才能把 lab 程序跑起来）。`execve` 会换掉地址空间、重置线程状态，
 *   GDB 把 `int3` 补回内核文本这一步有概率失败 —— 断点就这么静默消失了：GDB 不报错、
 *   QEMU 不报错，症状只是"命令明明跑完了、串口上输出都对，却一次都没停"。
 *   同一份脚本、同一条 `lab-read` 命令，实测出现过"第 3 次停点就是 lab-read"和
 *   "3 次停点全是 sh 且再无后续"两种结果。所以这里每次尝试都**重新装一遍**断点。
 *
 * 为什么每条尝试用带序号的不同标记（`READ1Y-DONE-`、`READ2Y-DONE-`…）：
 *   判断"这次尝试的命令是不是已经跑完了"要靠串口标记；如果多次尝试共用同一个标记，
 *   第一次的残留会让后面每一次都被误判成"已经跑完"，于是立刻重试、永远逮不到。
 *
 * `inspect(frame)` 由调用方给，返回 `{ claimed, label, value }`：
 *   `label` 是这次停点"是谁"的简短描述，逐次记进 `trace`，失败时能看出偏在哪。
 */

/**
 * 认领循环的**全局**请求序号。理由同 `captureReadSeq`：服务端按 `requestId` 幂等，
 * 重复的 `requestId` 会把首次结果原样返回、且跳过新鲜度检查 —— 那样
 * `terminal.input` 会被"缓存命中"短路掉，命令根本送不进客体，却看不出任何报错。
 */
let claimSeq = 0;

async function claimWithRetry(options) {
  const {
    app, base, live, cmd, symbol, module: stageId = 'linux-kernel',
    commandFor, markerFor, inspect,
    maxAttempts = 8, perFrameWaitMs = 10000, settleMs = 4000, attemptBudgetMs = 45000,
  } = options;
  const attempts = [];
  let breakpoint = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const text = commandFor(attempt);
    const marker = markerFor(attempt);
    const trace = [];
    await cmd('pause');
    if (breakpoint !== null && breakpoint.id !== null) {
      await cmd('breakpoint.remove', { breakpointId: breakpoint.id });
    }
    const inserted = await cmd('breakpoint.insert', { location: { symbol, module: stageId }, kind: 'software' });
    if (inserted.status !== 200) throw new Error(`在 ${symbol} 下断点失败：${describe(inserted.body)}`);
    breakpoint = inserted.body?.breakpoint ?? null;
    const cursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await cmd('continue');
    await sleep(300);
    /**
     * 必须在递命令**之前**记下"已经看到哪一帧"。
     *
     * 晚一步写（先递命令再读 `live.frames.at(-1)`）就会漏掉输入之后立刻发生的那次停点：
     * 命令一进串口，shell 马上 fork+execve，第一次停点在几十毫秒内就出现，
     * 而"递命令"这个 HTTP 请求返回时它可能已经躺在帧列表里了。漏掉的正好是最前面那次，
     * 于是后面每次停点都被当成"第一个"，`comm` 全部错位一格。
     */
    let lastFrameId = live.frames.at(-1)?.frameId ?? 0;
    /**
     * 会话自己记了两本账，认领失败时把两本都抄下来：
     *   - `stopSignals.count`：每来一次停止信号就 +1（GDB 与 QMP 各报一次，所以一次真停止通常 +2）
     *   - `qmp.STOP` 事件条数：QEMU 每停一次就发一条
     * 如果"真停了几次"大于"帧多了几帧"，说明停点被吞了 —— 源码里确实有两条吞停点的路径：
     * 有人在等停点时停点只交给等待者、以及上一帧还在采集（pendingCapture）时直接丢掉。
     */
    const stopTally = () => ({
      frames: live.frames.length,
      signals: live.stopSignals?.count ?? null,
      qmpStops: live.events.filter((event) => event.kind === 'qmp.STOP').length,
    });
    const tallyBefore = stopTally();
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07b-claim-${++claimSeq}-${attempt}-${symbol}`,
      epoch: live.epoch,
      expectedFrameId: lastFrameId,
      type: 'terminal.input',
      text,
    });

    const startedAt = Date.now();
    let claimed = null;
    let stopsSeen = 0;
    while (Date.now() - startedAt < attemptBudgetMs) {
      const frame = await waitForNextFrame(live, lastFrameId, perFrameWaitMs);
      if (frame !== null) {
        lastFrameId = frame.frameId;
        stopsSeen += 1;
        const hit = await inspect(frame);
        const tailNow = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
        const bpText = breakpoint?.address ?? null;
        const atBp = bpText !== null && frame.cpu?.rip !== undefined
          && String(frame.cpu.rip).toLowerCase() === String(bpText).toLowerCase();
        trace.push(`${frame.frameId}@${Date.now() - startedAt}ms:${hit.label}`
          + `${frame.stop?.reason === 'breakpoint' ? '' : `[stop=${frame.stop?.reason ?? '未给'}]`}`
          + `${atBp ? '' : '[rip≠断点地址]'}`
          + `${tailNow.slice(cursor).includes(marker) ? '|命令已跑完' : ''}`);
        if (hit.claimed) { claimed = { frame, value: hit.value }; break; }
        await cmd('continue');
        continue;
      }
      const tail = (await call(app, 'GET', `${base}/terminal`)).body?.text ?? '';
      if (Date.now() - startedAt > settleMs && tail.slice(cursor).includes(marker)) break;
    }
    attempts.push({
      attempt,
      symbol,
      stopsSeen,
      claimed: claimed !== null,
      trace: trace.slice(-60),
      tally: { before: tallyBefore, after: stopTally() },
    });
    if (claimed !== null) {
      return { frame: claimed.frame, value: claimed.value, attempts, breakpoint, stops: stopsSeen, failed: false };
    }
    log(`[认领] ${symbol} 第 ${attempt} 次尝试没逮到（停点 ${stopsSeen} 次：${trace.slice(-8).join(' ') || '一次都没停'}），重装断点再试`);
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

/* --------------------------------------------------------------------------
 * ReadOnlyCapture：把服务的线性地址读包装成解析器的唯一输入
 * ------------------------------------------------------------------------ */

/**
 * 三个刻意的取舍：
 * - 走 `memory.read` 命令而不是 `GET /memory`：前者经过控制队列，与 continue/pause 串行，
 *   不会出现"VM 已经继续跑了、读到的却是新内存"这种静默错配。
 * - 读不到就抛 `CaptureReadError`，绝不返回填充字节。内核结构里 0 是合法内容
 *   （`mm == NULL` 是内核线程与僵尸的正常形态），拿 0 冒充"读不到"会让面板看起来正常但全假。
 * - 证据绑定到本次停点的 `captureId`，所有解析结果都能追回"哪一刻的字节"。
 */

/**
 * 读内存用的**全局**请求序号。
 *
 * 服务端对命令是按 `requestId` 幂等的：命中既有 `requestId` 就把首次结果原样返回，
 * 而且**跳过新鲜度检查**（见 `controllers/api.mjs`：`lookupResult` 排在 `checkFreshness` 之前）。
 * 所以 `requestId` 必须整轮运行内唯一，不能只在一次采集内唯一。此前每个 `LiveCapture`
 * 各自从 1 开始编号（`t07b-capture-1`、`t07b-capture-2`…），于是第 N 个停点的读请求
 * 全部命中第 1 个停点的缓存：`describeStoppedTask` 每次都把第一个停点的字节抄回来，
 * 看起来"三次停点的 comm/pid/mm 一模一样"，实际是缓存造成的假象，`lab-read` 永远认领不到。
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
    this.seq = 0;
  }

  async readVirtual(address, length) {
    const text = hex(address);
    this.seq += 1;
    const response = await call(this.app, 'POST', `${this.base}/commands`, {
      requestId: `t07b-capture-${this.attribution.frameId}-${++captureReadSeq}`,
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
 * 用最小的两次读取回答"现在是谁"。
 *
 * 认领停点（这类内核函数是多个进程共用的入口）时每次都要问一遍"这是不是我要的进程"。
 * 走 `KernelMemoryView` 会按页读 4 KiB × 2，认领 40 次就白读 320 KiB；这里只读
 * `pcpu_hot.current_task`（8 字节）与 `comm`（16 字节）。
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
 * 认领失败时唯一要回答的问题是"现在停在谁身上"，只读 `comm` 不够。
 *
 * 实测过的一种情况：`sh` 用 `fork` + `execve` 起 lab 程序，孩子在 `execve` 装载 ELF
 * 期间 `comm` 还是 `sh`，直到内核 `begin_new_exec()` 里 `set_task_comm()` 才变成 `lab-read`。
 * 于是同一条命令里会连着出现好几次 `comm=sh` 的停点，光看 `comm` 分不清
 * "shell 自己"、"刚从 shell 分叉出来还没换名字的孩子"和"已经换好名字的 lab 程序"。
 * 把 `pid/tgid/mm/父进程` 一起读出来就分得清：同一个 `pid` 的两条记录 = 同一个进程的前后两态。
 */
async function describeStoppedTask(capture, percpuHotLink, offsets) {
  const offsetTable = capture.symbolAddress('__per_cpu_offset');
  if (offsetTable === null || percpuHotLink === null) return { comm: null, label: '读不到' };
  const percpuBase = littleEndian(await capture.readVirtual(offsetTable, 8));
  const task = littleEndian(await capture.readVirtual(percpuBase + percpuHotLink, 8));
  if (task === 0n) return { comm: null, label: 'current=0（空闲任务）' };
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
    label: `${comm}#pid${pid}/tgid${tgid} mm=${mm === 0n ? '0' : hex(mm)} ${parentText}`,
  };
}

/* --------------------------------------------------------------------------
 * GDB 侧参照
 * ------------------------------------------------------------------------ */
/**
 * 在**当前停点**跑一遍 GDB 侧参照实现，把结果 JSON 读回来。
 *
 * 走 `source` 而不是让脚本自己读内存：参照实现必须用 GDB 自己的 DWARF 解释与 `%gs` 基址，
 * 这才和解析器是两套机制。时间上限给得很大 —— 逐字段读几十个任务在 TCG + 远程 gdbstub 上
 * 要几十秒，而 MI 适配器默认只有 20 秒。
 */
async function runReference(live, label) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `t07b-ref-${label}-`));
  const outPath = path.join(dir, 'reference.json');
  const scriptPath = path.join(dir, 'reference.py');
  try {
    const source = fs.readFileSync(REFERENCE_PY, 'utf8').replace('__OUT_PATH__', JSON.stringify(outPath));
    fs.writeFileSync(scriptPath, source);
    const record = await live.mi.console(`source ${scriptPath}`, { timeoutMs: 900000 });
    if (!fs.existsSync(outPath)) {
      const stream = String(record?.stream ?? '');
      fs.writeFileSync(path.join(path.dirname(EVIDENCE), `t07b-reference-${label}-failed.txt`), stream);
      return { ok: false, error: '参照脚本没有写出结果文件', stream: stream.slice(-800) };
    }
    /**
     * 把 GDB 侧对照数据原样落盘。
     *
     * 这份数据以前只落在临时目录里、跑完就删：一旦对照脚本**自己**出错，留在证据里的
     * 只有"GDB 侧 0 个任务"这种二手症状，看不到 Python 的异常与回溯，只能再烧一次
     * 完整验收去找原因。落盘后失败原因与对照数据一起留档。
     *
     * 读回来时必须走 `parseBigJson`：GDB 侧给的 64 位地址超过 2^53，
     * 直接 `JSON.parse` 会被就近取整成几百字节外的另一个地址（细节见 `parseBigJson`）。
     */
    const data = parseBigJson(fs.readFileSync(outPath, 'utf8'));
    fs.writeFileSync(
      path.join(path.dirname(EVIDENCE), `t07b-reference-${label}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 逐字段比对。
 *
 * 两处必须归一的差别，否则会天天误报：
 * - 解析器把空指针归一成 `null`，而参照实现（`int(task["mm"])`）给出的是 `0`；
 *   两者说的是同一件事，比之前先归一。
 * - 参照实现读不到的字段进 `missing` 而不是"算对上"：既读不到又"一致"，断言就等于没比。
 */
const FIELD_PAIRS = [
  ['pid', 'pid'], ['tgid', 'tgid'], ['rawState', 'rawState'], ['rawExitState', 'rawExitState'],
  ['flags', 'flags'], ['mm', 'mm'], ['activeMm', 'activeMm'], ['stack', 'stack'],
  ['realParent', 'realParent'], ['parent', 'parent'], ['groupLeader', 'groupLeader'],
  ['threadPid', 'threadPid'], ['signal', 'signal'], ['files', 'files'], ['cred', 'cred'],
  ['nsproxy', 'nsproxy'], ['onCpu', 'onCpu'], ['prio', 'prio'], ['staticPrio', 'staticPrio'],
  ['normalPrio', 'normalPrio'], ['rtPriority', 'rtPriority'], ['policy', 'policy'],
  ['utime', 'utime'], ['stime', 'stime'], ['startTime', 'startTime'], ['nvcsw', 'nvcsw'],
  ['nivcsw', 'nivcsw'], ['exitCode', 'exitCode'], ['exitState', 'rawExitState'],
  ['cfs.vruntime', 'vruntime'],
];

function compareTask(mine, reference) {
  const mismatches = [];
  const missing = [];
  let compared = 0;
  if (mine.address !== undefined
    && (reference?.address === null || reference?.address === undefined
      || BigInt(mine.address) !== BigInt(reference.address))) {
    mismatches.push(`address: 我们=${hex(mine.address)} GDB=${reference?.address ?? 'null'}`);
  }
  if (String(mine.comm) !== String(reference?.comm)) {
    mismatches.push(`comm: 我们=${JSON.stringify(mine.comm)} GDB=${JSON.stringify(reference?.comm)}`);
  }
  for (const [mineKey, refKey] of FIELD_PAIRS) {
    const refValue = reference?.[refKey];
    if (refValue === null || refValue === undefined) { missing.push(mineKey); continue; }
    const raw = mineKey.includes('.')
      ? mineKey.split('.').reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), mine)
      : mine[mineKey];
    compared += 1;
    const mineText = raw === null || raw === undefined ? '0' : BigInt(raw).toString();
    const refText = BigInt(refValue).toString();
    if (mineText !== refText) {
      mismatches.push(`${mineKey}: 我们=${raw === null || raw === undefined ? 'NULL' : mineText} GDB=${refText}`);
    }
  }
  return { compared, mismatches, missing };
}

/* --------------------------------------------------------------------------
 * 状态解码：从内核源码现场重解析
 * ------------------------------------------------------------------------ */

function readStateConstants(text) {
  const values = new Map();
  for (const raw of text.split('\n')) {
    const match = /^#define\s+([A-Za-z_]\w*)\s+0x([0-9a-fA-F]+)\s*$/.exec(raw.trim());
    if (match) values.set(match[1], Number.parseInt(match[2], 16));
  }
  return values;
}

function readStateCharArray(text) {
  const at = text.indexOf('task_state_array[]');
  if (at < 0) return [];
  const out = [];
  for (const line of text.slice(at, at + 1500).split('\n')) {
    const match = /^\s*"([A-Za-z])\s*\(([a-z ]+)\)",\s*\/\*\s*0x([0-9a-f]+)\s*\*\//.exec(line);
    if (match) out.push({ char: match[1], label: match[2].trim(), value: Number.parseInt(match[3], 16) });
  }
  return out;
}

function readStateCharLiteral(text) {
  const match = /state_char\[\]\s*=\s*"([A-Za-z]+)"/.exec(text);
  return match ? match[1] : null;
}

/** 独立重写一遍 `__task_state_index`：照抄控制流，但用自己的"最高有效位"实现。 */
function referenceStateIndex(rawState, rawExitState, constants) {
  let state = (rawState | rawExitState) & constants.get('TASK_REPORT');
  if ((rawState & constants.get('TASK_IDLE')) === constants.get('TASK_IDLE')) {
    state = constants.get('TASK_REPORT') + 1;
  }
  if ((rawState & constants.get('TASK_RTLOCK_WAIT')) !== 0 || (rawState & constants.get('TASK_FROZEN')) !== 0) {
    state = constants.get('TASK_UNINTERRUPTIBLE');
  }
  let index = 0;
  let rest = state;
  while (rest > 0) { index += 1; rest >>>= 1; }
  return index;
}

/* --------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------ */

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t07b-evidence/1', startedAt: new Date().toISOString() };
  let session = null;
  let live = null;
  let layout = null;
  let symbols = null;
  let sizes = null;
  let seq = 0;
  /** 停点三/四的认领循环用它记住"已经看到哪一帧"。 */
  let lastFrameId = 0;

  const cmd = async (type, extra = {}) => call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    requestId: `t07b-${++seq}-${type}`,
    epoch: live.epoch,
    expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
    type,
    ...extra,
  });

  const captureFor = (frame) => new LiveCapture({
    app,
    base: `/api/sessions/${session.id}`,
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
    const base = `/api/sessions/${session.id}`;
    evidence.session = { id: session.id, profile: session.profile, epoch: live.epoch, qemu: live.process.qemuPath };
    evidence.resetFrame = {
      frameId: created.body.firstFrame?.frameId,
      captureId: created.body.firstFrame?.captureId,
      linearPc: created.body.firstFrame?.cpu?.linearPc,
    };

    const bootCont = await cmd('continue');
    if (bootCont.status !== 200) throw new Error(`continue（启动）失败：${describe(bootCont.body)}`);
    log('等待客体启动到交互提示符（最多 300 秒，TCG 上较慢）...');
    const bootText = await waitForTerminal(app, base, 300000);
    check('T07b-B0 客体真实启动到交互提示符', PROMPT.test(bootText), `串口字节=${bootText.length}`);

    /* ---------- V1 布局与符号 ---------- */

    if (!fs.existsSync(LAYOUT_PATH)) throw new Error(`找不到布局产物 ${LAYOUT_PATH}，先跑 gen-layout.mjs`);
    layout = KernelLayout.load(LAYOUT_PATH, { vmlinux: VMLINUX });
    const liveSha256 = crypto.createHash('sha256').update(fs.readFileSync(VMLINUX)).digest('hex');
    const required = dedupedManifest().filter((entry) => entry.required).map((entry) => entry.name);
    const missingRequired = required.filter((name) => layout.missing.some((entry) => entry.name === name));

    const parsed = parseReadelfSymbols(
      execFileSync('readelf', ['-sW', VMLINUX], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }),
    );
    symbols = parsed.addresses;
    sizes = parsed.sizes;

    const serviceSymbol = live.symbols.resolve('init_task', { module: 'linux-kernel' });
    const serviceInit = serviceSymbol.found && !serviceSymbol.ambiguous
      ? BigInt(serviceSymbol.candidates[0].address) : null;
    const readelfInit = symbols.get('init_task') ?? null;
    const threadSizeFromSymbols = (symbols.get('__end_init_stack') ?? 0n) - (symbols.get('__start_init_stack') ?? 0n);

    const unameCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t07b-${++seq}-uname`,
      epoch: live.epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
      type: 'terminal.input',
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
      guestRelease,
      requiredTypes: required.length,
      missingRequired,
      optionalMissing: layout.missing.map((entry) => entry.name),
      readelfSymbolCount: symbols.size,
      readelfDuplicates: parsed.duplicates,
      initTaskService: serviceInit === null ? null : hex(serviceInit),
      initTaskReadelf: readelfInit === null ? null : hex(readelfInit),
      initTaskSymbolSize: (sizes.get('init_task') ?? 0n).toString(),
      layoutTaskStructBytes: layout.type('task_struct').byteSize,
      threadSizeFromSymbols: threadSizeFromSymbols.toString(),
      offsetFields: {
        tasks: layout.byteOffset('task_struct', 'tasks'),
        sibling: layout.byteOffset('task_struct', 'sibling'),
        children: layout.byteOffset('task_struct', 'children'),
        threadNode: layout.byteOffset('task_struct', 'thread_node'),
        signalThreadHead: layout.byteOffset('signal_struct', 'thread_head'),
        pcpuHotCurrentTask: layout.byteOffset('pcpu_hot', 'current_task'),
      },
    };
    check(
      'T07b-V1a 布局产物与现场 vmlinux 绑定：build ID 与 sha256 由 load() 现场重算并比对通过，客体内核 release 与产物一致',
      layout.sha256 === liveSha256
        && typeof layout.buildId === 'string' && layout.buildId.length === 40
        && guestRelease !== null && guestRelease === layout.linuxRelease,
      `buildId=${String(layout.buildId).slice(0, 12)} 产物 release=${layout.linuxRelease} 客体 uname -r=${guestRelease ?? '未知'}`,
    );
    check(
      'T07b-V1b 清单里必需类型一个都不缺（缺失只允许出现在可选条目上）',
      required.length > 0 && missingRequired.length === 0,
      `必需 ${required.length} 个全部存在；可选缺失 ${layout.missing.length} 个（${layout.missing.map((entry) => entry.name).join(',') || '无'}）`,
    );
    check(
      'T07b-V1c 符号事实三方一致：readelf 与服务的 init_task 地址相同，符号大小等于布局里 task_struct 的大小，且 init_stack 起止之差 == 0x4000',
      readelfInit !== null && serviceInit !== null && readelfInit === serviceInit
        && sizes.get('init_task') === BigInt(layout.type('task_struct').byteSize)
        && threadSizeFromSymbols === 0x4000n,
      `readelf=${readelfInit === null ? '缺' : hex(readelfInit)} 服务=${serviceInit === null ? '缺' : hex(serviceInit)}；`
        + `符号大小=${sizes.get('init_task')} 布局 task_struct=${layout.type('task_struct').byteSize}；`
        + `init_stack 差=${threadSizeFromSymbols}`,
    );

    /* ---------- 停点一：lab-read 的 read ---------- */

    const percpuHotLink = symbols.get('pcpu_hot') ?? null;
    const commOffset = layout.byteOffset('task_struct', 'comm');
    const readBpAddress = symbols.get('ext2_file_read_iter') ?? null;
    /** 认领失败时用的诊断字段：光看 comm 分不清"还没换名字的孩子"和"shell 自己"。 */
    const taskOffsets = {
      comm: commOffset,
      pid: layout.byteOffset('task_struct', 'pid'),
      tgid: layout.byteOffset('task_struct', 'tgid'),
      mm: layout.byteOffset('task_struct', 'mm'),
      realParent: layout.byteOffset('task_struct', 'real_parent'),
    };

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
      const tallyText = readClaim.attempts.map((entry) => {
        const { before, after } = entry.tally;
        return `第${entry.attempt}次：帧+${after.frames - before.frames}`
          + ` 停止信号+${after.signals !== null && before.signals !== null ? after.signals - before.signals : '?'}`
          + ` QMP停止+${after.qmpStops - before.qmpStops} 我们看到${entry.stopsSeen}次`
          + `[${entry.trace.slice(-6).join(' ')}]`;
      });
      throw new Error(
        `没有等到 lab-read 停在 ext2_file_read_iter（尝试 ${readClaim.attempts.length} 次，帧总数 ${live.frames.length}）；`
        + `尝试记录=${JSON.stringify(tallyText)}；`
        + `串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const firstFrame = readClaim.frame;
    const claimStops = readClaim.stops;
    evidence.stop1 = {
      claimStops,
      attempts: readClaim.attempts,
      frameId: firstFrame.frameId,
      captureId: firstFrame.captureId,
      rip: firstFrame.cpu?.rip,
      breakpoint: readClaim.breakpoint,
      frameCount: live.frames.length,
    };

    const capture1 = captureFor(firstFrame);
    const view1 = new KernelMemoryView(capture1);
    const percpu1 = new PerCpuIndex(view1, capture1);
    const current1 = await readCurrentTask(view1, layout, percpu1, 0);

    check(
      'T07b-V3 停点落在 lab-read 读文件的内核函数 ext2_file_read_iter 上，且 current 就是 lab-read（认领用最小读取，不靠 pid 猜）',
      current1.task.comm === 'lab-read'
        && readBpAddress !== null
        && (String(firstFrame.cpu?.rip ?? '').toLowerCase() === hex(readBpAddress).toLowerCase()
          || String(firstFrame.source?.symbol ?? '') === 'ext2_file_read_iter')
        && String(firstFrame.source?.symbol ?? 'ext2_file_read_iter') === 'ext2_file_read_iter'
        && firstFrame.stop?.reason === 'breakpoint',
      `comm=${current1.task.comm} pid=${current1.task.pid} rip=${firstFrame.cpu?.rip} `
        + `停点符号=${firstFrame.source?.symbol ?? '（帧里没给）'} 断点=${readBpAddress === null ? '缺' : hex(readBpAddress)} `
        + `stop=${firstFrame.stop?.reason} 认领次数=${claimStops}`,
    );

    /* ---------- V2 per-CPU 公式三源一致 ---------- */

    const gsBaseFrame = firstFrame.cpu?.segments?.gs?.base ?? null;
    const base0 = await percpu1.base(0);
    const cpuIds = await percpu1.cpuCount();
    const ref1 = await runReference(live, 'stop1');
    if (!ref1.ok) log(`GDB 侧参照（停点一）失败：${ref1.error}`);
    const refData1 = ref1.ok ? ref1.data : {};
    const gsBaseGdb = refBig(refData1.gsBase);
    const gdbCurrentFromGs = refBig(refData1.currentFromGsBase);
    const gdbCurrentFromPercpu = refBig(refData1.currentFromPercpuOffset);
    const gsSources = [gsBaseFrame === null ? null : BigInt(gsBaseFrame), gsBaseGdb].filter((value) => value !== null);

    evidence.percpu = {
      cpuIds,
      nrCpuIdsSymbol: sizes.get('nr_cpu_ids') === undefined ? null : 'present',
      base0: hex(base0),
      gsBaseFrame: gsBaseFrame === null ? null : String(gsBaseFrame),
      gsBaseGdb: gsBaseGdb === null ? null : hex(gsBaseGdb),
      gsBasePercpuOffset0Raw: hex(await view1.u64(symbols.get('__per_cpu_offset'))),
      currentFromGsBase: hexOrNull(gdbCurrentFromGs),
      currentFromPercpuOffset: hexOrNull(gdbCurrentFromPercpu),
      currentOurs: hex(current1.taskAddress),
      hotAddress: hex(current1.hotAddress),
      pcpuHotLinkAddress: percpuHotLink === null ? null : hex(percpuHotLink),
      offsetFieldsUsedByGdb: refData1.offsets ?? null,
      referenceOk: ref1.ok,
      referenceError: ref1.ok ? null : ref1.error,
    };
    check(
      'T07b-V2 per-CPU 公式三源一致：__per_cpu_offset[0] == GDB 的 %gs 基址 == 帧里 %gs 隐藏基址；两条机制算出的 current 是同一个地址',
      base0 !== 0n
        && gsSources.length > 0
        && gsSources.every((value) => value === base0)
        && gdbCurrentFromPercpu === current1.taskAddress
        && gdbCurrentFromGs === current1.taskAddress,
      `__per_cpu_offset[0]=${hex(base0)} 帧里 %gs 基址=${gsBaseFrame} GDB $gs_base=${gsBaseGdb === null ? '缺' : hex(gsBaseGdb)}；`
        + `current：我们=${hex(current1.taskAddress)} GDB(__per_cpu_offset)=${gdbCurrentFromPercpu === null ? '缺' : hex(gdbCurrentFromPercpu)} `
        + `GDB(%gs)=${gdbCurrentFromGs === null ? '缺' : hex(gdbCurrentFromGs)}`,
    );

    /* ---------- V4 current 逐字段 ---------- */

    const refTask1 = (refData1.tasks ?? []).find((entry) => BigInt(entry.address) === current1.taskAddress) ?? null;
    const fieldCompare1 = refTask1 === null
      ? { compared: 0, mismatches: ['GDB 侧没有这个地址的任务记录'], missing: [] }
      : compareTask(current1.task, refTask1);
    evidence.currentStop1 = {
      address: hex(current1.task.address),
      pid: current1.task.pid,
      tgid: current1.task.tgid,
      comm: current1.task.comm,
      state: current1.task.state,
      stateChar: current1.task.stateChar,
      stateBits: current1.task.stateBits,
      rawState: current1.task.rawState,
      rawExitState: current1.task.rawExitState,
      mm: current1.task.mm === null ? null : hex(current1.task.mm),
      stack: hex(current1.task.stack),
      stackTop: hex(current1.task.stackTop),
      threadSize: current1.task.threadSize.toString(),
      compared: fieldCompare1.compared,
      mismatches: fieldCompare1.mismatches,
      missing: fieldCompare1.missing,
      gdbRecord: refTask1,
    };
    check(
      'T07b-V4 选中任务逐字段与 GDB 侧独立实现一致（mm/父子/调度/时间统计等约 30 个字段）',
      refTask1 !== null
        && fieldCompare1.compared >= 25
        && fieldCompare1.mismatches.length === 0
        && fieldCompare1.missing.length === 0,
      `地址=${hex(current1.task.address)} 比对 ${fieldCompare1.compared} 个字段，不一致 ${fieldCompare1.mismatches.length} 个，`
        + `GDB 读不到 ${fieldCompare1.missing.length} 个`
        + (fieldCompare1.mismatches.length === 0 ? '' : `；明细：${fieldCompare1.mismatches.slice(0, 6).join(' | ')}`)
        + (fieldCompare1.missing.length === 0 ? '' : `；读不到：${fieldCompare1.missing.slice(0, 6).join(',')}`),
    );

    /* ---------- V5 任务链表 ---------- */

    const list1 = await readTaskList(view1, layout);
    const gdbList1 = refData1.list ?? {};
    const oursAddresses = list1.tasks.map((task) => task.address).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const gdbAddresses = [BigInt(gdbList1.initTask ?? 0), ...(gdbList1.addresses ?? []).map((value) => BigInt(value))]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const addressSetEqual = oursAddresses.length === gdbAddresses.length
      && oursAddresses.every((value, index) => value === gdbAddresses[index]);
    const oursPids = list1.tasks.map((task) => `${task.pid}/${task.tgid}`).sort();
    const gdbPids = (refData1.tasks ?? []).map((task) => `${task.pid}/${task.tgid}`).sort();
    const pidsEqual = JSON.stringify(oursPids) === JSON.stringify(gdbPids);
    evidence.taskList = {
      initTask: hex(list1.initTask),
      gdbInitTask: hexOrNull(gdbList1.initTask),
      count: list1.tasks.length,
      gdbCount: (refData1.tasks ?? []).length,
      truncated: list1.truncated,
      cycle: list1.cycle,
      notes: list1.notes.slice(0, 6),
      addressSetEqual,
      pidsEqual,
      oursPids: oursPids.slice(0, 20),
      gdbPids: gdbPids.slice(0, 20),
      gdbListTruncated: gdbList1.truncated ?? null,
      gdbListCycle: gdbList1.cycle ?? null,
      viewStats: { reads: view1.counters.reads, hits: view1.counters.hits, bytes: view1.counters.bytes.toString() },
      states: list1.tasks.map((task) => `${task.pid}:${task.comm}:${task.stateChar}`).slice(0, 20),
    };
    check(
      'T07b-V5 任务链表与 GDB 一致：init_task 起点、节点地址集合、pid/tgid 集合都相同，且没有截断也没有误报环',
      addressSetEqual
        && pidsEqual
        && list1.truncated === false
        && list1.cycle === false
        && list1.tasks.length >= 5
        && list1.tasks[0].address === list1.initTask
        && list1.truncated === (gdbList1.truncated ?? false)
        && list1.cycle === (gdbList1.cycle ?? false),
      `我们 ${list1.tasks.length} 个任务，GDB ${(refData1.tasks ?? []).length} 个；地址集合相同=${addressSetEqual} `
        + `pid 集合相同=${pidsEqual} 截断=${list1.truncated} 环=${list1.cycle} init_task=${hex(list1.initTask)}；`
        + `状态快照：${evidence.taskList.states.slice(0, 8).join(' ')}`,
    );

    /* ---------- V6 父子 ---------- */

    const parentAddress = current1.task.realParent;
    const parentTask = parentAddress === null ? null : await readTask(view1, layout, parentAddress);
    const parentChildren = parentTask === null ? null : await readChildren(view1, layout, parentTask);
    const refParent = parentAddress === null ? null
      : (refData1.tasks ?? []).find((entry) => BigInt(entry.address) === parentAddress) ?? null;
    const childrenMatch = parentChildren !== null
      && refParent !== null
      && JSON.stringify(parentChildren.children.map(String).sort())
        === JSON.stringify((refParent.children ?? []).map(String).sort());
    evidence.parents = {
      realParent: parentAddress === null ? null : hex(parentAddress),
      gdbRealParent: hexOrNull(refTask1?.realParent),
      parentPid: parentTask?.pid ?? null,
      parentComm: parentTask?.comm ?? null,
      children: parentChildren === null ? null : parentChildren.children.map(hex),
      gdbChildren: refParent === null ? null : (refParent.children ?? []).map((value) => hex(value)),
      gdbParentComm: refParent?.comm ?? null,
      childrenMatch,
      currentInChildren: parentChildren === null
        ? false : parentChildren.children.some((value) => value === current1.taskAddress),
    };
    check(
      'T07b-V6 父子一致：current.real_parent 指向的任务就是 GDB 报的那个，父任务的 children 链表（实测）里确实含 current，且与 GDB 走出的子进程集合相同',
      parentTask !== null
        && refBig(refTask1?.realParent) === parentAddress
        && refParent !== null
        && childrenMatch
        && evidence.parents.currentInChildren === true,
      `real_parent=${parentAddress === null ? 'null' : hex(parentAddress)}（${parentTask?.comm ?? '未读'} pid=${parentTask?.pid ?? '?'}）`
        + ` children=${JSON.stringify(evidence.parents.children)} GDB=${JSON.stringify(evidence.parents.gdbChildren)} 含 current=${evidence.parents.currentInChildren}`,
    );

    /* ---------- V7 线程组 ---------- */

    const threadsOurs = await readThreadGroup(view1, layout, current1.task);
    const threadsMatch = refTask1 !== null
      && JSON.stringify(threadsOurs.threads.map(String).sort())
        === JSON.stringify((refTask1.threads ?? []).map(String).sort());
    evidence.threads = {
      ours: threadsOurs.threads.map(hex),
      gdb: refTask1 === null ? null : (refTask1.threads ?? []).map((value) => hex(value)),
      notes: threadsOurs.notes,
      cycle: threadsOurs.cycle,
      match: threadsMatch,
    };
    check(
      'T07b-V7 线程组与 GDB 一致：signal_struct.thread_head 走出的线程集合两边相同（单线程进程里就是它自己）',
      refTask1 !== null && threadsMatch && threadsOurs.cycle === false,
      `我们=${JSON.stringify(evidence.threads.ours)} GDB=${JSON.stringify(evidence.threads.gdb)} 环=${threadsOurs.cycle}`,
    );

    /* ---------- V8 栈 ---------- */

    const rsp = BigInt(firstFrame.cpu?.rsp ?? '0x0');
    const threadSize = await threadSizeOf(view1);
    evidence.stack = {
      threadSize: threadSize.toString(),
      initStackBytesFromSymbols: threadSizeFromSymbols.toString(),
      stack: hex(current1.task.stack),
      stackTop: hex(current1.task.stackTop),
      rsp: hex(rsp),
      gdbStack: hexOrNull(refTask1?.stack),
      rspInsideStack: rsp >= current1.task.stack && rsp < current1.task.stackTop,
      stackAligned: current1.task.stack % 0x4000n === 0n,
    };
    check(
      'T07b-V8 内核栈：THREAD_SIZE 由符号表算出（等于 __end_init_stack − __start_init_stack，不是写死的 16384），且停点的 rsp 落在 current 的内核栈区间内',
      threadSize === threadSizeFromSymbols
        && threadSize === 0x4000n
        && refBig(refTask1?.stack) === current1.task.stack
        && evidence.stack.rspInsideStack === true,
      `THREAD_SIZE=${threadSize}（符号表 ${threadSizeFromSymbols}）stack=${hex(current1.task.stack)} 栈顶=${hex(current1.task.stackTop)} rsp=${hex(rsp)}`,
    );

    /* ---------- V9 runqueue ---------- */

    const rq = await readRunqueue(view1, layout, percpu1, 0);
    const gdbRq = refData1.runqueue ?? {};
    const rqPairs = [
      ['nrRunning', 'nrRunning'], ['cfsNrRunning', 'cfsNrRunning'], ['rtNrRunning', 'rtNrRunning'],
      ['dlNrRunning', 'dlNrRunning'], ['nrSwitches', 'nrSwitches'], ['curr', 'curr'],
      ['idle', 'idle'], ['cpuField', 'cpuField'],
    ];
    const rqCompared = rqPairs.filter(([, refKey]) => gdbRq[refKey] !== null && gdbRq[refKey] !== undefined);
    const rqMismatches = rqCompared
      .filter(([mineKey, refKey]) => (rq[mineKey] === null ? '0' : BigInt(rq[mineKey]).toString()) !== BigInt(gdbRq[refKey]).toString())
      .map(([mineKey, refKey]) => `${mineKey}: 我们=${rq[mineKey] === null ? 'NULL' : rq[mineKey]} GDB=${gdbRq[refKey]}`);
    evidence.runqueue = {
      address: hex(rq.address),
      gdbAddress: hexOrNull(gdbRq.address),
      ours: {
        nrRunning: rq.nrRunning, cfsNrRunning: rq.cfsNrRunning, rtNrRunning: rq.rtNrRunning,
        dlNrRunning: rq.dlNrRunning,
        nrSwitches: rq.nrSwitches === null ? null : rq.nrSwitches.toString(),
        curr: rq.curr === null ? null : hex(rq.curr),
        idle: rq.idle === null ? null : hex(rq.idle),
        cpuField: rq.cpuField,
        structBytes: rq.evidence?.refs?.find((ref) => String(ref).startsWith('memory:')) ?? null,
      },
      gdb: gdbRq,
      compared: rqCompared.length,
      mismatches: rqMismatches,
    };
    check(
      'T07b-V9 runqueue 摘要与 GDB 一致：rq 地址（per-CPU 基址相加，不乘 sizeof(struct rq)）与 nr_running/cfs/rt/dl/nr_switches/curr/idle/cpu 逐项相同，且 rq.curr 就是 current',
      rqCompared.length >= 6
        && rqMismatches.length === 0
        && refBig(gdbRq.address) === rq.address
        && rq.curr === current1.taskAddress
        && rq.cpuField === 0,
      `rq=${hex(rq.address)}（GDB ${hexOrNull(gdbRq.address) ?? '缺'}）比对 ${rqCompared.length} 项，`
        + `不一致 ${rqMismatches.length} 项；rq.curr=${rq.curr === null ? 'null' : hex(rq.curr)} current=${hex(current1.taskAddress)} cpu=${rq.cpuField}`
        + (rqMismatches.length === 0 ? '' : `；明细：${rqMismatches.join(' | ')}`),
    );

    /* ---------- V10 状态解码 vs 源码 ---------- */

    const constants = readStateConstants(fs.readFileSync(SCHED_H, 'utf8'));
    const arrayChars = readStateCharArray(fs.readFileSync(ARRAY_C, 'utf8'));
    const charLiteral = readStateCharLiteral(fs.readFileSync(SCHED_H, 'utf8'));
    // TASK_REPORT 在 sched.h 里是多行宏，按它的成员自己位或出来（并断言结果是 0x7f）。
    constants.set('TASK_REPORT', ['TASK_RUNNING', 'TASK_INTERRUPTIBLE', 'TASK_UNINTERRUPTIBLE',
      '__TASK_STOPPED', '__TASK_TRACED', 'EXIT_DEAD', 'EXIT_ZOMBIE', 'TASK_PARKED']
      .reduce((acc, name) => acc | (constants.get(name) ?? 0), 0));
    constants.set('TASK_IDLE', (constants.get('TASK_UNINTERRUPTIBLE') ?? 0) | (constants.get('TASK_NOLOAD') ?? 0));

    const probeStates = [
      [0, 0], [1, 0], [2, 0], [4, 0], [8, 0], [0x10, 0], [0x20, 0], [0x40, 0],
      [3, 0], [0x41, 0], [0x402, 0], [0x100, 0], [0x1000, 0], [0x8000, 0], [0x102, 0],
      [0, 0x10], [0, 0x20], [0x80, 0x10], [0x80, 0x20], [0x80, 0], [1, 0x20], [0x402, 0x20],
    ];
    const stateMismatches = [];
    for (const [raw, exit] of probeStates) {
      const fromSource = charLiteral?.[referenceStateIndex(raw, exit, constants)] ?? null;
      const mine = decodeTaskState(raw, exit).char;
      if (mine !== fromSource) stateMismatches.push(`(${hex(raw)},${hex(exit)}) 源码=${fromSource} 我们=${mine}`);
    }
    const flsMismatches = [];
    for (let value = 0; value < 8192; value += 1) {
      let expected = 0;
      let rest = value;
      while (rest > 0) { expected += 1; rest >>>= 1; }
      if (fls(value) !== expected) flsMismatches.push(`${value}: 我们=${fls(value)} 期望=${expected}`);
    }
    const arrayMismatches = [];
    for (const entry of arrayChars) {
      const index = entry.value === 0x80 ? 8 : (entry.value === 0 ? 0 : Math.log2(entry.value) + 1);
      if (STATE_CHARS[index] !== entry.char) {
        arrayMismatches.push(`0x${entry.value.toString(16)}(${entry.label}) 源码=${entry.char} 我们=${STATE_CHARS[index]}`);
      }
    }
    evidence.stateDecode = {
      constants: Object.fromEntries([...constants].filter(([name]) => /^(TASK|__TASK|EXIT)_/.test(name))),
      taskReportComputed: constants.get('TASK_REPORT'),
      stateCharLiteral: charLiteral,
      stateCharsOurs: STATE_CHARS,
      arrayChars,
      probes: probeStates.length,
      stateMismatches,
      arrayMismatches,
      flsCheckedUpTo: 8192,
      flsMismatches: flsMismatches.slice(0, 4),
    };
    check(
      'T07b-V10 状态解码与内核源码现场重解析一致：TASK_REPORT 折叠 + TASK_IDLE/RTLOCK_WAIT/FROZEN 特例 + fls → state_char，字符表与 fs/proc/array.c 一致，fls 逐值一致',
      charLiteral === STATE_CHARS
        && arrayChars.length >= 9
        && stateMismatches.length === 0
        && arrayMismatches.length === 0
        && flsMismatches.length === 0
        && constants.get('TASK_REPORT') === 0x7f,
      `源码 state_char="${charLiteral}" 我们="${STATE_CHARS}"；array.c 抓到 ${arrayChars.length} 项；`
        + `${probeStates.length} 组 (__state,exit_state) 全一致=${stateMismatches.length === 0}，`
        + `字符表一致=${arrayMismatches.length === 0}，fls 0..8191 全一致=${flsMismatches.length === 0}`
        + (stateMismatches.length === 0 ? '' : `；明细：${stateMismatches.slice(0, 5).join(' | ')}`),
    );

    /* ---------- V13 遍历上限 / 环检测 / 越界 ---------- */

    const limited = await readTaskList(view1, layout, { limit: 3 });
    const tasksOffset = layout.byteOffset('task_struct', 'tasks');
    const walkLimited = await walkList(view1, layout,
      await view1.u64(list1.initTask + BigInt(tasksOffset)), tasksOffset, { limit: 1 });
    let cpuOverflow = null;
    try {
      await percpu1.base(cpuIds);
      cpuOverflow = '没有报错';
    } catch (error) {
      cpuOverflow = error.code ?? error.name;
    }
    let notPerCpu = null;
    try {
      await percpu1.address('init_task', 0);
      notPerCpu = '没有报错';
    } catch (error) {
      notPerCpu = error.code ?? error.name;
    }
    evidence.bounds = {
      limitedTaskCount: limited.tasks.length,
      limitedTruncated: limited.truncated,
      limitedNotes: limited.notes.slice(0, 2),
      walkLimitedEntries: walkLimited.entries.length,
      walkLimitedTruncated: walkLimited.truncated,
      cpuIds,
      cpuOverflow,
      notPerCpuCode: notPerCpu,
    };
    check(
      'T07b-V13 遍历上限与越界防护在真实数据上生效：limit 真的截断并如实标记，越界 CPU 与非 per-CPU 符号都被明确拒绝',
      limited.truncated === true
        && limited.tasks.length === 4
        && walkLimited.truncated === true
        && walkLimited.entries.length === 1
      && cpuOverflow === 'cpu-out-of-range'
      && notPerCpu === 'not-a-percpu-symbol',
      `limit=3 → 任务 ${limited.tasks.length} 个/截断=${limited.truncated}；limit=1 → 节点 ${walkLimited.entries.length} 个/截断=${walkLimited.truncated}；`
        + `nr_cpu_ids=${cpuIds}，访问 CPU ${cpuIds} → ${cpuOverflow}；把 init_task 当 per-CPU 变量 → ${notPerCpu}`,
    );

    /* ---------- V14 ProcessRef ---------- */

    const processRef = toProcessRef(current1.task, { parentPid: parentTask?.pid ?? null, threadPids: [] });
    const contractOk = typeof processRef.pid === 'number'
      && typeof processRef.tgid === 'number'
      && /^0x[0-9a-f]+$/.test(processRef.taskAddress)
      && /^0x[0-9a-f]+$/.test(processRef.stackAddress)
      && typeof processRef.comm === 'string'
      && typeof processRef.state === 'string'
      && typeof processRef.stateRaw === 'number'
      && Array.isArray(processRef.threads)
      && processRef.threads.length === 0
      && (processRef.mmAddress === null || /^0x[0-9a-f]+$/.test(processRef.mmAddress))
      && processRef.evidence?.source === 'linux-decoder'
      && processRef.evidence?.captureId === firstFrame.captureId;
    evidence.processRef = processRef;
    check(
      'T07b-V14 KernelTask → ProcessRef 契约：地址是 Hex、mm 为空时保留 null 而不是 0x0、证据绑定到本次采集',
      contractOk,
      `pid=${processRef.pid} comm=${processRef.comm} state=${processRef.state} mm=${processRef.mmAddress} `
        + `证据 captureId=${processRef.evidence?.captureId}（停点 captureId=${firstFrame.captureId}）`,
    );

    /* ---------- 收尾停点一，进入停点二 ---------- */

    log(`停点一完成（页读 ${view1.counters.reads} 次，命中缓存 ${view1.counters.hits} 次）；放 lab-read 跑完...`);
    if (readClaim.breakpoint !== null && readClaim.breakpoint.id !== null) {
      await cmd('breakpoint.remove', { breakpointId: readClaim.breakpoint.id });
    }
    const readDoneCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    await cmd('continue');
    await waitForTerminalMarker(app, base, `READ${readClaim.attempts.length}Y-DONE-`, 120000, readDoneCursor);

    /* ---------- 停点二：lab-cow 的 wait4 ---------- */

    const cowClaim = await claimWithRetry({
      app,
      base,
      live,
      cmd,
      symbol: '__x64_sys_wait4',
      commandFor: (n) => `lab-cow; echo COW${n}""Y-DONE-$?\n`,
      markerFor: (n) => `COW${n}Y-DONE-`,
      inspect: async (frame) => {
        const info = await describeStoppedTask(captureFor(frame), percpuHotLink, taskOffsets);
        return { claimed: info.comm === 'lab-cow', label: info.label, value: frame };
      },
    });
    if (cowClaim.failed) {
      throw new Error(
        `没有等到 lab-cow 停在 __x64_sys_wait4（尝试 ${cowClaim.attempts.length} 次，帧总数 ${live.frames.length}）；`
        + `尝试记录=${JSON.stringify(cowClaim.attempts.map((entry) => `第${entry.attempt}次停${entry.stopsSeen}回[${entry.trace.slice(-6).join(' ')}]`))}；`
        + `串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const cowFrame = cowClaim.frame;
    const cowStops = cowClaim.stops;

    const capture2 = captureFor(cowFrame);
    const view2 = new KernelMemoryView(capture2);
    const current2 = await readCurrentTask(view2, layout, new PerCpuIndex(view2, capture2), 0);
    const cowChildren = await readChildren(view2, layout, current2.task);
    const childAddress = cowChildren.children[0] ?? null;
    const childTask = childAddress === null ? null : await readTask(view2, layout, childAddress);
    const ref2 = await runReference(live, 'stop2');
    const refData2 = ref2.ok ? ref2.data : {};
    const refParent2 = (refData2.tasks ?? []).find((entry) => BigInt(entry.address) === current2.taskAddress) ?? null;
    const refChild2 = childAddress === null ? null
      : (refData2.tasks ?? []).find((entry) => BigInt(entry.address) === childAddress) ?? null;
    const childListMatches = refParent2 !== null
      && JSON.stringify((refParent2.children ?? []).map(String).sort())
        === JSON.stringify(cowChildren.children.map(String).sort());
    evidence.stop2 = {
      frameId: cowFrame.frameId,
      claimStops: cowStops,
      comm: current2.task.comm,
      parentAddress: hex(current2.taskAddress),
      parentPid: current2.task.pid,
      children: cowChildren.children.map(hex),
      childPid: childTask?.pid ?? null,
      childComm: childTask?.comm ?? null,
      childRealParentPointsBack: childTask?.realParent === current2.taskAddress,
      childParentPointsBack: childTask?.parent === current2.taskAddress,
      childStateChar: childTask?.stateChar ?? null,
      gdbChildren: refParent2 === null ? null : (refParent2.children ?? []).map((value) => hex(value)),
      gdbChildComm: refChild2?.comm ?? null,
      childListMatches,
      referenceOk: ref2.ok,
      referenceError: ref2.ok ? null : ref2.error,
    };
    check(
      'T07b-V6b lab-cow 停点上的父子关系：只 fork 出一个子任务，它的 real_parent/parent 都指回 lab-cow，两边各自走出的 children 链表一致',
      current2.task.comm === 'lab-cow'
        && cowChildren.children.length === 1
        && childTask !== null
        && childTask.realParent === current2.taskAddress
        && childTask.parent === current2.taskAddress
        && childListMatches
        && refBig(refChild2?.realParent) === current2.taskAddress,
      `lab-cow pid=${current2.task.pid} 子进程=${childAddress === null ? '无' : hex(childAddress)} pid=${childTask?.pid ?? '?'} `
        + `real_parent 回指=${childTask?.realParent === current2.taskAddress} 两边 children 一致=${childListMatches} `
        + `GDB children=${JSON.stringify(evidence.stop2.gdbChildren)}`,
    );

    /* ---------- 停点三：do_notify_parent（僵尸态窗口） ---------- */

    /*
     * 为什么停在 `do_notify_parent` 而不是 `release_task`：
     * `exit_notify()` 先置 `tsk->exit_state = EXIT_ZOMBIE` 再调 `do_notify_parent`，所以
     * **函数入口那一刻**正是"僵尸已经成立、还没被认领"的窗口。而到了 `release_task` 入口，
     * `wait_task_zombie()` 已经用 cmpxchg 把 exit_state 从 ZOMBIE 改成 DEAD 了 ——
     * 那里看到的是回收态（停点四专门用它），不是僵尸态。
     */
    await cmd('breakpoint.remove', { breakpointId: cowClaim.breakpoint?.id ?? null });
    const notifyBp = await cmd('breakpoint.insert', { location: { symbol: 'do_notify_parent', module: 'linux-kernel' }, kind: 'software' });
    if (notifyBp.status !== 200) throw new Error(`在 do_notify_parent 下断点失败：${describe(notifyBp.body)}`);

    let zombieFrame = null;
    let zombieStopCount = 0;
    lastFrameId = live.frames.at(-1)?.frameId ?? 0;
    await cmd('continue');
    const zombieDeadline = Date.now() + CLAIM_BUDGET_MS;
    while (zombieFrame === null && zombieStopCount < MAX_STOPS && Date.now() < zombieDeadline) {
      const frame = await waitForNextFrame(live, lastFrameId, CLAIM_BUDGET_MS);
      if (frame === null) break;
      lastFrameId = frame.frameId;
      zombieStopCount += 1;
      const capture = captureFor(frame);
      const quick = await quickTask(capture, percpuHotLink, commOffset);
      if (quick !== null && quick.taskAddress !== 0n) {
        const task = await readTask(new KernelMemoryView(capture), layout, quick.taskAddress);
        if ((task.rawExitState & EXIT_ZOMBIE) !== 0) { zombieFrame = frame; break; }
      }
      await cmd('continue');
    }
    if (zombieFrame === null) {
      throw new Error(
        `没有等到退出路径上的 do_notify_parent（僵尸态窗口），认领 ${zombieStopCount} 次；`
        + `断点=${JSON.stringify(notifyBp.body?.breakpoint ?? null)}；串口尾部=${await terminalTailOf(app, base)}`,
      );
    }

    const zombieCapture = captureFor(zombieFrame);
    const view3 = new KernelMemoryView(zombieCapture);
    const zombie = await readCurrentTask(view3, layout, new PerCpuIndex(view3, zombieCapture), 0);
    const zombieRdi = (zombieFrame.cpu?.general ?? []).find((entry) => entry.name === 'rdi')?.value ?? null;
    const ref3 = await runReference(live, 'stop3');
    const refData3 = ref3.ok ? ref3.data : {};
    const refZombie = (refData3.tasks ?? []).find((entry) => BigInt(entry.address) === zombie.taskAddress) ?? null;
    // 僵尸的 mm 已被 exit_mm 摘掉；参考实现给 0，解析器给 null，先归一再比。
    const zombieCompare = refZombie === null
      ? { compared: 0, mismatches: ['GDB 侧没有这个地址的任务记录'], missing: [] }
      : compareTask(zombie.task, refZombie);
    evidence.stop3 = {
      frameId: zombieFrame.frameId,
      claimStops: zombieStopCount,
      address: hex(zombie.task.address),
      pid: zombie.task.pid,
      comm: zombie.task.comm,
      rawState: zombie.task.rawState,
      rawExitState: zombie.task.rawExitState,
      stateChar: zombie.task.stateChar,
      stateLabel: zombie.task.stateLabel,
      stateBits: zombie.task.stateBits,
      mm: zombie.task.mm === null ? null : hex(zombie.task.mm),
      activeMm: zombie.task.activeMm === null ? null : hex(zombie.task.activeMm),
      rdi: zombieRdi,
      gdbRawState: refZombie?.rawState ?? null,
      gdbRawExitState: refZombie?.rawExitState ?? null,
      gdbMm: refZombie?.mm ?? null,
      gdbStateChar: refZombie === null ? null : decodeTaskState(refZombie.rawState, refZombie.rawExitState).char,
      compared: zombieCompare.compared,
      mismatches: zombieCompare.mismatches,
      missing: zombieCompare.missing,
      referenceOk: ref3.ok,
      referenceError: ref3.ok ? null : ref3.error,
      gdbOffsets: refData3.offsets ?? null,
    };
    check(
      'T07b-V11 僵尸陷阱：刚退出的任务 __state 没有任何"可报告"的位，只有 exit_state=EXIT_ZOMBIE(0x20) 说明它是僵尸；mm 已在内核里被摘掉；解码结果是 Z，GDB 独立读到的原始值也一样',
      (zombie.task.rawState & 0x7f) === 0
        && (zombie.task.rawExitState & EXIT_ZOMBIE) !== 0
        && zombie.task.stateChar === 'Z'
        && zombie.task.mm === null
        && refZombie !== null
        && refZombie.rawState === zombie.task.rawState
        && refZombie.rawExitState === zombie.task.rawExitState
        && refZombie.mm === 0
        && zombieCompare.mismatches.length === 0
        && zombieCompare.missing.length === 0
        && zombieRdi !== null
        && BigInt(zombieRdi) === zombie.task.address,
      `任务 ${hex(zombie.task.address)} pid=${zombie.task.pid} comm=${zombie.task.comm} `
        + `__state=${hex(zombie.task.rawState)} exit_state=${hex(zombie.task.rawExitState)} → ${zombie.task.stateChar}(${zombie.task.stateLabel}) `
        + `mm=${zombie.task.mm === null ? 'null' : hex(zombie.task.mm)} active_mm=${zombie.task.activeMm === null ? 'null' : hex(zombie.task.activeMm)}；`
        + `GDB 独立读到 __state=${refZombie?.rawState} exit_state=${refZombie?.rawExitState} mm=${refZombie?.mm}；`
        + `do_notify_parent 入参 rdi=${zombieRdi === null ? '未取到' : hex(zombieRdi)} 与 current 相同=${zombieRdi !== null && BigInt(zombieRdi) === zombie.task.address}；`
        + `比对 ${zombieCompare.compared} 个字段，不一致 ${zombieCompare.mismatches.length} 个`,
    );

    /* ---------- 停点四：release_task（回收态） ---------- */

    await cmd('breakpoint.remove', { breakpointId: notifyBp.body?.breakpoint?.id ?? null });
    const reapBp = await cmd('breakpoint.insert', { location: { symbol: 'release_task', module: 'linux-kernel' }, kind: 'software' });
    if (reapBp.status !== 200) throw new Error(`在 release_task 下断点失败：${describe(reapBp.body)}`);

    let reapFrame = null;
    let reapTask = null;
    let reapView = null;
    let reapRdi = null;
    let reapStops = 0;
    lastFrameId = live.frames.at(-1)?.frameId ?? 0;
    await cmd('continue');
    const reapDeadline = Date.now() + CLAIM_BUDGET_MS;
    while (reapFrame === null && reapStops < MAX_STOPS && Date.now() < reapDeadline) {
      const frame = await waitForNextFrame(live, lastFrameId, CLAIM_BUDGET_MS);
      if (frame === null) break;
      lastFrameId = frame.frameId;
      reapStops += 1;
      const rdi = (frame.cpu?.general ?? []).find((entry) => entry.name === 'rdi')?.value ?? null;
      if (rdi !== null) {
        const view = new KernelMemoryView(captureFor(frame));
        try {
          const candidate = await readTask(view, layout, BigInt(rdi));
          if (candidate.comm === 'lab-cow' && candidate.pid !== current2.task.pid
            && candidate.rawExitState !== 0 && (candidate.rawExitState & EXIT_ZOMBIE) === 0) {
            reapFrame = frame; reapTask = candidate; reapView = view; reapRdi = rdi;
            break;
          }
        } catch { /* rdi 不是任务指针时跳过这次认领 */ }
      }
      await cmd('continue');
    }
    if (reapFrame === null) {
      throw new Error(
        `没有等到 release_task 回收 lab-cow 的子进程，认领 ${reapStops} 次；`
        + `断点=${JSON.stringify(reapBp.body?.breakpoint ?? null)}；串口尾部=${await terminalTailOf(app, base)}`,
      );
    }
    const reapList = await readTaskList(reapView, layout);
    const stillOnList = reapList.tasks.some((entry) => entry.address === reapTask.address);
    const reaperCurrent = await readCurrentTask(reapView, layout, new PerCpuIndex(reapView, captureFor(reapFrame)), 0);
    evidence.stop4 = {
      frameId: reapFrame.frameId,
      claimStops: reapStops,
      releaseTaskArg: reapRdi === null ? null : hex(reapRdi),
      reapedAddress: hex(reapTask.address),
      reapedPid: reapTask.pid,
      reapedComm: reapTask.comm,
      reapedRawState: reapTask.rawState,
      reapedRawExitState: reapTask.rawExitState,
      reapedStateChar: reapTask.stateChar,
      reapedMm: reapTask.mm === null ? null : hex(reapTask.mm),
      stillOnTaskList: stillOnList,
      reaperAddress: hex(reaperCurrent.taskAddress),
      reaperComm: reaperCurrent.task.comm,
      reaperPid: reaperCurrent.task.pid,
    };
    check(
      'T07b-V12 回收态：release_task 的入参 rdi 就是被回收的那个任务，它此刻仍在任务链表上，exit_state 已从 EXIT_ZOMBIE 变成 EXIT_DEAD(0x10)，而发起回收的 current 是父进程',
      reapTask.rawExitState === EXIT_DEAD
        && reapTask.stateChar === 'X'
        && reapTask.mm === null
        && stillOnList === true
        && reaperCurrent.taskAddress !== reapTask.address,
      `被回收任务 ${reapRdi === null ? '?' : hex(reapRdi)} pid=${reapTask.pid} comm=${reapTask.comm} `
        + `exit_state=${hex(reapTask.rawExitState)} → ${reapTask.stateChar} mm=${reapTask.mm === null ? 'null' : hex(reapTask.mm)}；`
        + `此刻仍在任务链表上=${stillOnList}；发起回收的 current=${hex(reaperCurrent.taskAddress)}（${reaperCurrent.task.comm} pid=${reaperCurrent.task.pid}）`,
    );

    await cmd('pause');
    const cowDone = await call(app, 'GET', `${base}/terminal`);
    evidence.cowTerminal = String(cowDone.body?.text ?? '').slice(-600);
    evidence.buildLock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'instrumentation/qemu-observer/build.lock.json'), 'utf8'),
    );
  } catch (error) {
    check('T07b 脚本异常', false, error.message);
    evidence.error = { message: error.message, stack: String(error.stack).slice(0, 2000) };
  } finally {
    if (session) {
      const closed = await call(app, 'DELETE', `/api/sessions/${session.id}`);
      await sleep(1500);
      const leftover = countSessionProcesses(session.id);
      check('T07b-V15 会话关闭成功且没有残留 QEMU/GDB 进程',
        closed.status === 200 && closed.body?.closed === true && leftover === 0,
        `${describe(closed.body)}；残留进程数=${leftover}`);
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
  log(`证据：${path.relative(ROOT, EVIDENCE)}`);
  return failed.length;
}

main()
  .then((failed) => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });