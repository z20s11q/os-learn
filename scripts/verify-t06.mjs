#!/usr/bin/env node
/**
 * T06 服务层验收（内存 / 页表 / 设备队列 / 磁盘数据服务）。
 *
 * 分工说明：页表/队列/磁盘版本这些**纯字节解析**的正确性由单测证明
 * （`node --test tests/*.test.mjs`，覆盖 paging / ram / ram-store /
 * virtqueue-decoder / disk-version-store）。本脚本要证明的是**服务**把它们
 * 接对了，并且接的是真实 QEMU 上的真实字节：
 *
 *   S0   复位帧：分页未启用时线性地址就是物理地址，不硬套页表
 *   E03  到 start_kernel：分页状态（级别/CR3 掩码/真实页目录）与
 *        独立通道（HMP `info mem`、`gva2gpa`）逐项一致
 *   E04  同一物理地址的**两条独立通道**（观察者 read-physical 与 GDB 物理读）
 *        字节完全一致；存档读取（mode=recorded）与现场读取一致
 *   E14  全量 RAM 基线 + 脏页增量重建的散列，与停止后**独立全量 dump**
 *        （HMP `pmemsave`）逐字节一致；并用 dma.write 事件核对没有漏页
 *   E09  磁盘逻辑版本：已对客体可见的写进 visible、未可见的进 pending，
 *        pending 载荷独立保存且可按 dataRef 取回
 *   S5   「不许绕过锁读活跃镜像」：VM 还活着时离线校验被拒（control-busy），
 *        关掉 VM 之后同一接口成功，且与记录载荷一致
 *
 * 运行：node scripts/verify-t06.mjs        （约 8–12 分钟，TCG 上跑真实 Linux）
 * 证据：artifacts/verify/t06.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../services/lab-server/main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t06.json');

/** 客体登录提示符（与 instrumentation/qemu-observer 下的验收脚本同一判据）。 */
const PROMPT = /linux-lab:[^\r\n]*# /;
/** 写盘命令的完成标记。 */
const WRITE_MARKER = 'T06-WROTE';
/*
 * 一次性写故障的目标扇区（512 字节单位，即 64 MiB 偏移处）。
 *
 * 为什么是这里：根盘是 96 MiB 的 ext2，实际内容不到 3 MiB，64 MiB 处落在空闲块
 * 区，不会被文件系统元数据碰到。把故障注入到「写坏了也不影响客体继续跑」的区域，
 * 才能在真实硬件路径上制造一个未完成写请求，而不破坏实验环境。
 */
const FAULT_SECTOR = 131072;
/** 故障写请求的数据长度（扇区数）：8 扇区 = 4096 字节。 */
const FAULT_SECTORS = 8;
/*
 * 「可见但没采到载荷」的目标扇区（512 字节单位，约 78 MiB 处）。
 *
 * 为什么不能挨着故障扇区：可见区间经过 `mergeRanges` 合并，相邻或重叠的写会被
 * 并成一段，两段挨在一起时就再也分不清「哪一段专属于无载荷写」了。
 *
 * 它验的是第 4 条里那句「不拿旧值冒充新值」：第二笔裸写正常完成、对客体可见，
 * 但它的载荷不会进本代采集（取载荷只认停止屏障那一刻仍在飞行的请求），所以读
 * 这一段必须被明确拒绝。
 */
const NO_PAYLOAD_SECTOR = 160000;
/** 故障写载荷的独立对照源：根盘里那份确定性数据（同一个文件进了 ext2 镜像）。 */
const PROBE_SOURCE = 'artifacts/build/rootfs/data/probe.bin';
/** 全量 RAM：`pc.ram` 0x0–0x1fffffff，与 `-m 512` 一致。 */
const RAM_BYTES = 0x20000000n;
const PAGE = 4096n;
/*
 * PC 机器内存里 0xa0000–0xc0000 的 128 KiB 空洞不属于 `pc.ram`（那是 VGA 窗口），
 * 所以「系统内存」比 `-m 512` 少 32 页。期望值直接写成这条**硬约束**，而不是拿
 * 返回的区域表反过来推自己 —— 那样断言就退化成同义反复，量不出任何东西。
 */
const RAM_HOLE_BYTES = 0x20000n;
const MACHINE_RAM_BYTES = RAM_BYTES - RAM_HOLE_BYTES;
const MACHINE_RAM_PAGES = Number(MACHINE_RAM_BYTES / PAGE);
/** HMP `pmemsave` 的输出文件（QEMU 的 cwd 是仓库根）。 */
const DUMP_NAME = 't06-pmemsave.raw';
const DUMP_PATH = path.join(ROOT, DUMP_NAME);

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: ok === true, detail: detail ?? null });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
  return ok === true;
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

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * HMP `gva2gpa` 的参数是 `addr:l`（有符号 64 位）。内核高半区地址 ≥ 2^63，
 * 按有符号写会溢出成负数——这正是我们要的：QEMU 内部把它按 target_ulong
 * 解释，于是同一个地址又能被正确寻址。这里显式做这个换算。
 */
function toSigned64(value) {
  const wide = BigInt.asUintN(64, BigInt(value));
  return wide >= 1n << 63n ? wide - (1n << 64n) : wide;
}

async function hmp(session, line, timeoutMs = 180000) {
  return session.qmp.hmp(line, { timeoutMs });
}

/** 解析 `info mem` 的输出行：`<start>-<end> <size> <u|->r<w|->`。 */
function parseInfoMem(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const match = /^([0-9a-f]+)-([0-9a-f]+)\s+([0-9a-f]+)\s+([-u])r([-w])$/.exec(line);
    if (!match) continue;
    out.push({
      start: BigInt(`0x${match[1]}`),
      end: BigInt(`0x${match[2]}`),
      size: BigInt(`0x${match[3]}`),
      user: match[4] === 'u',
      writable: match[5] === 'w',
    });
  }
  return out;
}

function parseGva2gpa(text) {
  const mapped = /gpa:\s*(0x[0-9a-f]+)/i.exec(String(text ?? ''));
  if (mapped) return BigInt(mapped[1]);
  if (/Unmapped/i.test(String(text ?? ''))) return null;
  return undefined;
}

function waitForTerminal(app, base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const terminal = await call(app, 'GET', `${base}/terminal`);
      const text = terminal.body?.text ?? '';
      if (PROMPT.test(text)) {
        resolve(text);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`等待客体提示符超时（${timeoutMs} ms）；串口末尾：${JSON.stringify(text.slice(-400))}`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function waitForTerminalMarker(app, base, marker, timeoutMs, cursor = 0) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const terminal = await call(app, 'GET', `${base}/terminal`);
      const text = (terminal.body?.text ?? '').slice(cursor);
      if (text.includes(marker)) {
        resolve(text);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`等待串口标记 ${marker} 超时（${timeoutMs} ms）；串口末尾：${JSON.stringify(text.slice(-400))}`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

/**
 * 等 VM 自己停下来（注入的写错误 + werror=stop 会触发 io-error 停止）。
 *
 * 不能等串口标记：VM 在错误路径上直接停下，dd 那条命令根本走不到 echo，
 * 所以「停下」本身就是这个场景的判据。
 */
function waitForSessionStopped(app, base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const status = await call(app, 'GET', base);
      const state = status.body?.state ?? null;
      if (state === 'stopped') {
        resolve(status.body);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`等待 VM 因写错误自行停止超时（${timeoutMs} ms）；当前状态=${state}`));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function terminateQemu(session) {
  if (session?.process?.alive !== true) return false;
  try {
    session.process.proc.kill('SIGKILL');
  } catch {
    return false;
  }
  return true;
}

function countSessionProcesses(sessionId) {
  try {
    const output = execFileSync('bash', [
      '-c',
      `ps -eo args | grep -F '${sessionId}' | grep -v grep | wc -l`,
    ], { encoding: 'utf8' });
    return Number(output.trim());
  } catch {
    return -1;
  }
}

/** 与 RamStore.reconstructedHash 同样口径：按区域顺序、区域内按地址升序拼接。 */
function hashDumpRegions(dumpPath, regions) {
  const fd = fs.openSync(dumpPath, 'r');
  const buffer = Buffer.alloc(1 << 20);
  const hash = crypto.createHash('sha256');
  let total = 0n;
  try {
    for (const region of regions) {
      let offset = BigInt(region.base);
      let remaining = BigInt(region.size);
      while (remaining > 0n) {
        const take = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
        const read = fs.readSync(fd, buffer, 0, take, Number(offset));
        if (read !== take) {
          throw new Error(`dump 在 ${hex(offset)} 只读到 ${read} 字节，期望 ${take}（全量 dump 不完整就不能比散列）`);
        }
        hash.update(buffer.subarray(0, take));
        offset += BigInt(take);
        remaining -= BigInt(take);
        total += BigInt(take);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes: total.toString() };
}

function pagesOf(regions) {
  return regions.map((region) => ({ base: BigInt(region.base), end: BigInt(region.base) + BigInt(region.size) }));
}

function inAnyRegion(address, ranges) {
  return ranges.some((range) => address >= range.base && address < range.end);
}

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t06-evidence/1', startedAt: new Date().toISOString() };
  let session = null;
  let live = null;
  let seq = 0;

  const cmd = async (type, extra = {}) => call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    requestId: `t06-${++seq}-${type}`,
    epoch: live.epoch,
    expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
    type,
    ...extra,
  });

  try {
    /* ---------- 创建会话：复位帧（frame 0） ---------- */

    console.log('创建会话（加载 vmlinux 符号并采集复位帧，约 1–2 分钟）...');
    /*
     * diskFault 是这次验收的关键：任何一次 capture 都建立在 VM 停止之上，而停止
     * 动作会 drain 块层把在途请求做完，屏障处几乎读不到未完成的块请求。唯一能在
     * 屏障处留下「已提交、还没对客体可见」的写请求的真实路径是宿主 I/O 出错 +
     * werror=stop（请求挂到设备队列 s->rq 上，本次不完成，客体缓冲区因此仍然有效）。
     * 规则一次性、且被限定在 64 MiB 处的空闲块，不影响客体启动与文件系统。
     */
    const created = await call(app, 'POST', '/api/sessions', {
      profile: 'kernel-fast',
      diskFault: { sector: FAULT_SECTOR, errno: 5, iotype: 'write', once: true },
    });
    if (created.status !== 201) {
      check('T06-S0 会话创建', false, `status=${created.status} ${describe(created.body)}`);
      evidence.create = created;
      throw new Error('会话创建失败，无法继续');
    }
    session = created.body;
    live = registry.get(session.id);
    const base = `/api/sessions/${session.id}`;
    const epoch = session.epoch;
    const resetFrame = created.body.firstFrame;
    evidence.session = { id: session.id, profile: session.profile, epoch, qemu: live.process.qemuPath };
    evidence.resetFrame = {
      frameId: resetFrame?.frameId,
      captureId: resetFrame?.captureId,
      linearPc: resetFrame?.cpu?.linearPc,
      cr0: resetFrame?.cpu?.control?.cr0,
      cr3: resetFrame?.cpu?.control?.cr3,
      cr4: resetFrame?.cpu?.control?.cr4,
      mode: resetFrame?.cpu?.mode,
      memoryCoverage: resetFrame?.coverage?.memory,
      diskVersions: resetFrame?.diskVersions,
      pagingEvidence: resetFrame?.evidence?.['cpu.paging'],
    };
    console.log(`会话 ${session.id} 复位帧 linearPc=${resetFrame?.cpu?.linearPc}`
      + ` mode=${resetFrame?.cpu?.mode} cr0=${resetFrame?.cpu?.control?.cr0} cr3=${resetFrame?.cpu?.control?.cr3}`);

    /* ---------- S0b：一次性写故障真的装上了 ---------- */

    const launchArgs = (live.process.launch?.args ?? []).join(' ');
    const faultConfText = fs.existsSync(live.process.paths.blkdebug)
      ? fs.readFileSync(live.process.paths.blkdebug, 'utf8')
      : '';
    /*
     * 分层是判据的一部分，不是实现细节：只有 blkdebug 挂在 qcow2 **之上**，
     * 它的 `sector` 才是「客体设备扇区」；挂在下面时看到的是宿主覆盖层文件的
     * 偏移，故障会静默不触发（这一条是被真实跑出来的失败教会的）。
     */
    const launchHasBlkdebug = launchArgs.includes('file.driver=blkdebug')
      && launchArgs.includes(`file.config=${live.process.paths.blkdebug}`);
    const launchHasQcow2Below = launchArgs.includes('file.image.driver=qcow2')
      && launchArgs.includes(`file.image.file.filename=${live.process.paths.disk}`);
    const launchHasWerrorStop = launchArgs.includes('werror=stop');
    evidence.diskFault = {
      spec: session.diskFault ?? null,
      conf: faultConfText,
      launchHasBlkdebug,
      launchHasQcow2Below,
      launchHasWerrorStop,
      driveArg: (live.process.launch?.args ?? []).find((arg) => arg.includes('file.driver=blkdebug')) ?? null,
    };
    check(
      'T06-S0b 一次性写故障装进启动参数：blkdebug 位于 qcow2 之上（sector 因此是客体设备偏移）+ werror=stop，规则只作用于目标扇区',
      session.diskFault?.sector === FAULT_SECTOR
        && launchHasBlkdebug === true
        && launchHasQcow2Below === true
        && launchHasWerrorStop === true
        && faultConfText.includes(`sector = "${FAULT_SECTOR}"`)
        && faultConfText.includes('once = "on"'),
      `blkdebug=${launchHasBlkdebug} qcow2在下层=${launchHasQcow2Below} werror=stop=${launchHasWerrorStop} `
        + `conf=${JSON.stringify(faultConfText.replace(/\n/g, ' | '))}`,
    );

    /* ---------- S0：未启用分页时不硬套页表 ---------- */

    const resetTranslate = await call(
      app,
      'GET',
      `${base}/memory?mode=translate&address=${resetFrame?.cpu?.linearPc ?? '0xfff0'}`
        + `&captureId=${encodeURIComponent(resetFrame?.captureId ?? '')}`,
    );
    evidence.resetTranslate = resetTranslate.body;
    const resetPaging = resetTranslate.body?.paging;
    const resetLinear = BigInt(resetFrame?.cpu?.linearPc ?? '0xfff0');
    const resetPhysicalText = resetTranslate.body?.translation?.physical ?? null;
    const resetPhysical = resetPhysicalText === null ? null : BigInt(resetPhysicalText);
    /*
     * 未启用分页时，CPU 的寻址宽度决定线性地址怎么落到物理地址：
     * 实模式是 20 位（0xfffff），32 位保护模式是 32 位。两者都保留页内偏移，
     * 所以这里断言「不套页表（walk 为空、pageSize 为空）且页内偏移不变」，
     * 并把是原样还是被 20 位截断如实记进证据里，不硬编码一种。
     */
    const identityForm = resetPhysical === null
      ? null
      : resetPhysical === resetLinear
        ? 'identity'
        : resetPhysical === (resetLinear & 0xfffffn)
          ? 'truncated-20bit'
          : null;
    evidence.resetTranslateForm = { linear: hex(resetLinear), physical: resetPhysicalText, form: identityForm };
    check(
      'T06-S0 复位点分页未启用：不套页表、不推断映射，线性地址按寻址宽度直接落到物理地址',
      resetTranslate.status === 200
        && resetPaging?.enabled === false
        && resetPaging?.levels === null
        && resetPaging?.rootTable === null
        && resetTranslate.body?.translation?.fault === null
        && resetTranslate.body?.translation?.pageSize === null
        && (resetTranslate.body?.translation?.walk ?? []).length === 0
        && identityForm !== null
        && resetPhysical !== null
        && (resetPhysical & 0xfffn) === (resetLinear & 0xfffn),
      `physical=${resetPhysicalText} enabled=${resetPaging?.enabled} form=${identityForm}`,
    );

    /* ---------- E03：跑到 start_kernel，核对页表 ---------- */

    const bp = await cmd('breakpoint.insert', { location: { symbol: 'start_kernel' }, kind: 'hardware' });
    if (bp.status !== 200) {
      check('T06-E03 在 start_kernel 下硬件断点', false, describe(bp.body));
    }
    const cont = await cmd('continue');
    if (cont.status !== 200) throw new Error(`continue 失败: ${describe(cont.body)}`);

    const kernelDeadline = Date.now() + 120000;
    while (Date.now() < kernelDeadline && live.frames.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const kernelFrame = live.frames.at(-1);
    const kernelStop = {
      frameId: kernelFrame?.frameId,
      captureId: kernelFrame?.captureId,
      stopReason: kernelFrame?.stop?.reason,
      linearPc: kernelFrame?.cpu?.linearPc,
      cr3: kernelFrame?.cpu?.control?.cr3,
      mode: kernelFrame?.cpu?.mode,
      pagingEvidence: kernelFrame?.evidence?.['cpu.paging'],
      pagingUnavailable: (kernelFrame?.coverage?.unavailable ?? []).filter((name) => name.includes('paging')),
    };
    evidence.kernelStop = kernelStop;
    console.log(`start_kernel 帧 ${kernelStop.frameId} pc=${kernelStop.linearPc} cr3=${kernelStop.cr3}`);

    /*
     * 「停在哪里」用两条判据之一确认，不假设 GDB 一定回报符号名：
     * (1) 帧的源码符号解析出 start_kernel；(2) 停止 PC 等于断点解析出的地址。
     */
    const bpAddress = bp.body?.breakpoint?.address ?? null;
    const atStartKernel = String(kernelFrame?.source?.symbol ?? '') === 'start_kernel'
      || (bpAddress !== null && String(kernelFrame?.cpu?.rip ?? '').toLowerCase() === String(bpAddress).toLowerCase());
    evidence.startKernel = {
      breakpoint: bp.body?.breakpoint ?? null,
      frameSymbol: kernelFrame?.source?.symbol ?? null,
      frameRip: kernelFrame?.cpu?.rip ?? null,
      atStartKernel,
    };
    check(
      'T06-E03a 断在 start_kernel：分页已启用、CR3 为真实页目录且分页状态被解析成 decoded',
      kernelFrame !== undefined
        && kernelFrame.stop?.reason === 'breakpoint'
        && atStartKernel
        && kernelStop.linearPc !== null
        && kernelStop.pagingEvidence?.kind === 'decoded'
        && /→ 物理 0x/.test(String(kernelStop.pagingEvidence?.reason ?? '')),
      `reason=${kernelFrame?.stop?.reason} symbol=${kernelFrame?.source?.symbol} `
        + `rip=${kernelFrame?.cpu?.rip} bpAddr=${bpAddress} paging=${kernelStop.pagingEvidence?.kind}`,
    );

    const rootTableExpected = kernelFrame?.cpu?.control?.cr3 === null || kernelFrame?.cpu?.control?.cr3 === undefined
      ? null
      : hex(BigInt(kernelFrame.cpu.control.cr3) & 0x000ffffffffff000n);

    const kernelTranslate = await call(
      app,
      'GET',
      `${base}/memory?mode=translate&address=${kernelStop.linearPc}&captureId=${encodeURIComponent(kernelStop.captureId)}`,
    );
    const translation = kernelTranslate.body?.translation;
    const walk = translation?.walk ?? [];
    evidence.kernelTranslate = {
      status: kernelTranslate.status,
      paging: kernelTranslate.body?.paging,
      translation,
      stats: kernelTranslate.body?.stats,
    };

    check(
      'T06-E03b 翻译 start_kernel：rootTable 掩码正确、页表层数与页大小成立、物理地址落进 RAM',
      kernelTranslate.status === 200
        && kernelTranslate.body?.paging?.enabled === true
        && kernelTranslate.body?.paging?.rootTable === rootTableExpected
        && translation?.physical !== null
        && [4, 5].includes(Number(kernelTranslate.body?.paging?.levels))
        // 命中大页时遍历在中间一级就结束（例如 2 MiB 页在四级表上只走 3 级），
        // 所以「级数」关系是：普通页走满 levels，大页少走一级。
        && (translation?.huge === true
          ? walk.length === Number(kernelTranslate.body?.paging?.levels) - 1
          : walk.length === Number(kernelTranslate.body?.paging?.levels))
        && BigInt(translation.physical) < RAM_BYTES
        && (translation.pageSize === 4096 || translation.huge === true),
      `rootTable=${kernelTranslate.body?.paging?.rootTable} 期望=${rootTableExpected} `
        + `levels=${kernelTranslate.body?.paging?.levels} walk=${walk.length} huge=${translation?.huge} `
        + `pageSize=${translation?.pageSize} physical=${translation?.physical}`,
    );

    /*
     * 页表链自洽：每一级条目的地址 = 上一级给出的表基址 + 索引×8 必须等于子项的 tableAddress。
     * 注意第一级：`paging.rootTable` 是页表的**基址**（CR3 掩码后的值），
     * 而条目的 `tableAddress` 是「基址 + 索引×8」（条目自身的地址），
     * 所以第一级要按同一个公式比，不能拿基址直接和条目地址相等比较。
     */
    const rootTableText = kernelTranslate.body?.paging?.rootTable ?? null;
    const chainOk = walk.length > 0 && rootTableText !== null && walk.every((entry, index) => {
      const expected = index === 0
        ? BigInt(rootTableText) + BigInt(entry.index * 8)
        : (walk[index - 1].physicalAddress === null
          ? null
          : BigInt(walk[index - 1].physicalAddress) + BigInt(entry.index * 8));
      return expected !== null && BigInt(entry.tableAddress) === expected;
    });
    check(
      'T06-E03c 页表链自洽：每一级条目的物理地址 = 上一级给出的表基址 + 索引×8，且都标记为 present',
      chainOk && walk.every((entry) => entry.present === true),
      walk.map((entry) => `${entry.tableAddress}+${entry.index * 8}`).join(' -> '),
    );

    /* 独立通道一：HMP `info mem`（QEMU 自己的页表遍历）。 */
    const infoMemText = await hmp(live, 'info mem');
    const mappings = parseInfoMem(infoMemText);
    const linear = BigInt(kernelStop.linearPc);
    const mapped = mappings.find((entry) => linear >= entry.start && linear < entry.end) ?? null;
    const leaf = walk.at(-1) ?? null;
    evidence.infoMem = {
      textHead: String(infoMemText).slice(0, 800),
      mappings: mappings.slice(0, 12).map((entry) => ({
        start: hex(entry.start),
        end: hex(entry.end),
        size: hex(entry.size),
        writable: entry.writable,
        user: entry.user,
      })),
      hit: mapped === null ? null : { start: hex(mapped.start), end: hex(mapped.end), writable: mapped.writable },
    };
    /*
     * 这里不能拿 `info mem` 的区间长度和我们的页大小做相等比较：QEMU 报的是
     * 线性地址**区间**（例：ffffffff81000000-ffffffff82600000 是 22 页的直映射区间），
     * 区间长度等于页大小只在「单页区间」时巧合成立。真正要验的是：
     * (1) 我们的叶子项恰好覆盖 PC 所在的那一页，且那一页整个落在 QEMU 报出的区间内；
     * (2) 可写性两边一致；
     * (3) 由叶子项基址 + 页内偏移算出的物理地址，等于我们报出的物理地址。
     */
    const leafPageSize = BigInt(translation?.pageSize ?? 4096);
    const leafPageStart = (linear / leafPageSize) * leafPageSize;
    const leafOffsetOk = leaf !== null
      && leaf.physicalAddress !== null
      && translation?.physical !== null
      && BigInt(translation.physical) === BigInt(leaf.physicalAddress) + (linear - leafPageStart);
    const hugeAgrees = translation?.huge === true ? leafPageSize > 4096n : leafPageSize === 4096n;
    check(
      'T06-E03d 与 QEMU 自己的 `info mem` 一致：PC 所在页落在被映射区间内，权限与页内偏移换算都一致',
      mapped !== null
        && leaf !== null
        && leaf.present === true
        && (mapped.writable === (leaf.writable === true))
        && leafPageStart >= BigInt(mapped.start)
        && leafPageStart < BigInt(mapped.end)
        && leafOffsetOk
        && hugeAgrees,
      `info mem: ${mapped === null ? '未映射' : `${hex(mapped.start)}-${hex(mapped.end)} w=${mapped.writable}`}；`
        + `我们的叶子页 ${hex(leafPageStart)} size=${leafPageSize} w=${leaf?.writable} `
        + `phys=${translation?.physical} leafBase=${leaf?.physicalAddress} huge=${translation?.huge}`,
    );

    /* 独立通道二：HMP `gva2gpa`（另一条翻译实现），逐位比较物理地址。 */
    const gvaText = await hmp(live, `gva2gpa ${toSigned64(linear)}`);
    const gvaPhysical = parseGva2gpa(gvaText);
    evidence.gva2gpa = { linear: hex(linear), argument: toSigned64(linear).toString(), raw: String(gvaText).trim(), physical: gvaPhysical === undefined || gvaPhysical === null ? null : hex(gvaPhysical) };
    check(
      'T06-E03e 与 QEMU 的 `gva2gpa` 逐位一致：同一条 PC 地址翻译出同一个物理地址',
      gvaPhysical !== undefined
        && gvaPhysical !== null
        && translation?.physical !== null
        && BigInt(gvaPhysical) === BigInt(translation.physical),
      `gva2gpa=${gvaPhysical === null || gvaPhysical === undefined ? '未映射' : hex(gvaPhysical)} `
        + `ours=${translation?.physical}`,
    );

    /* 内核高半区：线性地址 = 物理地址 + 固定偏移（不猜偏移，只验证它是常数）。 */
    const second = linear + 0x1000n;
    const secondTranslate = await call(
      app,
      'GET',
      `${base}/memory?mode=translate&address=${hex(second)}&captureId=${encodeURIComponent(kernelStop.captureId)}`,
    );
    const secondPhysical = secondTranslate.body?.translation?.physical ?? null;
    const basePhysical = translation?.physical ?? null;
    const deltaPhysical = secondPhysical === null || basePhysical === null
      ? null
      : BigInt(secondPhysical) - BigInt(basePhysical);
    check(
      'T06-E03f 内核高半区是固定偏移的直映射：相邻两页的「线性地址 − 物理地址」为同一个常数',
      deltaPhysical !== null && deltaPhysical === 0x1000n,
      `Δ物理=${deltaPhysical === null ? '不可用' : hex(deltaPhysical)}（相邻两页应差 0x1000）`,
    );

    /* ---------- E04：两条独立通道的字节一致 ---------- */

    const physicalE04 = translation?.physical ?? null;
    // 上一步没翻出物理地址时，这里不能直接 BigInt(null)——那会抛异常把整个
    // 验收脚本打断，后面所有检查都看不到结果。如实记成「未完成」并继续。
    const observerRead = physicalE04 === null
      ? { status: 0, body: null }
      : await call(app, 'GET', `${base}/memory?addressSpace=physical&address=${physicalE04}&length=64`);
    const gdbPhysical = physicalE04 === null ? null : await live.mi.readPhysicalBytes(BigInt(physicalE04), 64);
    evidence.e04 = {
      physical: physicalE04,
      skipped: physicalE04 === null ? 'E03 没有得到物理地址，无法做通道比对' : null,
      observer: { status: observerRead.status, hex: observerRead.body?.hex, source: observerRead.body?.evidence?.source },
      gdb: gdbPhysical === null ? null : { hex: gdbPhysical.toString('hex') },
    };
    check(
      'T06-E04a 同一物理地址两条通道字节一致：观察者 read-physical（绑定 captureId）与 GDB 物理读',
      physicalE04 !== null
        && observerRead.status === 200
        && observerRead.body?.evidence?.source === 'observer'
        && gdbPhysical !== null
        && observerRead.body?.hex === gdbPhysical.toString('hex'),
      `physical=${physicalE04} observer=${String(observerRead.body?.hex).slice(0, 32)}… `
        + `gdb=${gdbPhysical === null ? '未读' : `${gdbPhysical.toString('hex').slice(0, 32)}…`}`,
    );

    const linearRead = await call(app, 'GET', `${base}/memory?addressSpace=linear&address=${kernelStop.linearPc}&length=64`);
    check(
      'T06-E04b 「线性地址读」与「先翻译再读物理」得到同一段字节（分段/分页解析没有把地址搬错）',
      linearRead.status === 200
        && observerRead.body?.hex !== undefined
        && linearRead.body?.hex === observerRead.body?.hex,
      `linear=${String(linearRead.body?.hex).slice(0, 32)}… physical=${String(observerRead.body?.hex).slice(0, 32)}…`,
    );

    /* ---------- 让客体跑到 shell ---------- */

    await cmd('breakpoint.remove', { breakpointId: bp.body?.breakpoint?.id ?? null });
    const bootCont = await cmd('continue');
    if (bootCont.status !== 200) throw new Error(`continue（启动）失败: ${describe(bootCont.body)}`);
    console.log('等待客体启动到交互提示符（最多 300 秒，TCG 上较慢）...');
    const bootText = await waitForTerminal(app, base, 300000);
    evidence.boot = { promptSeen: true, terminalBytes: bootText.length };
    check('T06-S1 客体真实启动到交互提示符', PROMPT.test(bootText), `串口字节=${bootText.length}`);

    const pause1 = await cmd('pause');
    if (pause1.status !== 200) throw new Error(`pause 失败: ${describe(pause1.body)}`);
    const shellFrame = live.frames.at(-1);
    const shellCaptureId = shellFrame.captureId;
    evidence.shellFrame = {
      frameId: shellFrame.frameId,
      captureId: shellCaptureId,
      eventWatermark: shellFrame.eventWatermark,
      coverage: shellFrame.coverage,
      diskVersions: shellFrame.diskVersions,
      virtqueueEvidence: shellFrame.evidence?.['device.virtio-queues'],
      deviceCount: shellFrame.devices?.length ?? 0,
    };

    const virtioDevices = (shellFrame.devices ?? []).filter((device) => String(device?.kind ?? '').startsWith('virtio'));
    const virtioQueues = (shellFrame.devices ?? []).flatMap((device) => device?.virtqueues ?? []);
    const queueView = await call(app, 'GET', `${base}/virtqueues`);
    evidence.virtqueues = {
      devices: virtioDevices.length,
      queues: virtioQueues.map((queue) => ({
        queueIndex: queue.queueIndex,
        size: queue.size,
        ready: queue.ready,
        negotiatedFeatures: queue.negotiatedFeatures,
        descTable: queue.descTable,
        availRing: queue.availRing,
        usedRing: queue.usedRing,
        descriptors: (queue.descriptors ?? []).length,
        bytesRef: (queue.descriptors ?? []).map((item) => item.bytesRef).slice(0, 4),
      })),
      viewStatus: queueView.status,
    };
    check(
      'T06-S2 virtio 队列按同一 captureId 解出：协商结果与三类环地址都来自快照，不编造',
      virtioQueues.length > 0
        && virtioQueues.every((queue) => queue.negotiatedFeatures !== null || queue.size === 0)
        && virtioQueues.some((queue) => queue.descTable !== null && queue.availRing !== null && queue.usedRing !== null),
      `队列数=${virtioQueues.length} 设备数=${virtioDevices.length}`,
    );
    check(
      'T06-S3 未支持/未采集的队列内容明确拒绝或标 unavailable，不静默丢弃',
      (queueView.body?.unavailable ?? []).length === 0
        || (shellFrame.coverage?.unavailable ?? []).includes('device.virtio-queues'),
      `unavailable=${JSON.stringify((queueView.body?.unavailable ?? []).slice(0, 3))}`,
    );

    /* ---------- E14 前半：全量 RAM 基线 ---------- */

    console.log('采集全量 RAM 基线（512 MiB = 131072 次 4 KiB 读，约 1–3 分钟）...');
    const baseline = await cmd('memory.read', { mode: 'baseline' });
    evidence.baseline = { status: baseline.status, body: baseline.body };
    const baselineRegions = baseline.body?.regions ?? [];
    const tablePages = baselineRegions
      .reduce((sum, region) => sum + Number(BigInt(region.size) / PAGE), 0);
    const tableBytes = baselineRegions
      .reduce((sum, region) => sum + Number(region.size), 0);
    check(
      'T06-E14a 全量 RAM 基线：只覆盖 pc.ram 全段（512 MiB 减去 0xa0000–0xc0000 的 128 KiB 空洞）、内容散列给出、complete=true',
      baseline.status === 200
        && baseline.body?.complete === true
        && baseline.body?.missingCount === 0
        && baselineRegions.length > 0
        // 设备侧 RAM（vga.vram 位于 0xfd000000）不属于系统内存，必须不在基线里；
        // 显存的 kind 也是 ram；系统 RAM 基线按区域名筛选，显存单独观测。
        && baselineRegions.every((region) => String(region.name) === 'pc.ram')
        && baselineRegions.every((region) => BigInt(region.base) + BigInt(region.size) <= RAM_BYTES)
        && tablePages === MACHINE_RAM_PAGES
        && tableBytes === Number(MACHINE_RAM_BYTES)
        && baseline.body?.regionPages === MACHINE_RAM_PAGES
        && baseline.body?.pages === MACHINE_RAM_PAGES
        && baseline.body?.bytes === Number(MACHINE_RAM_BYTES)
        && /^[0-9a-f]{64}$/.test(String(baseline.body?.ramSha256 ?? '')),
      `区域=${baselineRegions.length} 段 pages=${baseline.body?.pages}/${baseline.body?.regionPages}`
        + `（期望 ${MACHINE_RAM_PAGES}）bytes=${baseline.body?.bytes}（期望 ${MACHINE_RAM_BYTES}）`
        + ` complete=${baseline.body?.complete} sha=${String(baseline.body?.ramSha256).slice(0, 16)}…`,
    );

    const coverage = await call(app, 'GET', `${base}/memory?mode=coverage&captureId=${encodeURIComponent(shellCaptureId)}`);
    evidence.coverage = coverage.body;
    check(
      'T06-E14b 覆盖统计升级为 full-ram-delta，并给出可对照的 RAM 散列',
      coverage.status === 200
        && coverage.body?.mode === 'full-ram-delta'
        && coverage.body?.pages === MACHINE_RAM_PAGES
        && coverage.body?.bytes === Number(MACHINE_RAM_BYTES)
        && coverage.body?.ramSha256 === baseline.body?.ramSha256,
      `mode=${coverage.body?.mode} pages=${coverage.body?.pages}（期望 ${MACHINE_RAM_PAGES}）`
        + ` bytes=${coverage.body?.bytes}`,
    );

    /* 存档读取 = 现场读取（证明「历史只读存档」这条路真的能读到自己记的东西）。 */
    const recorded = await call(
      app,
      'GET',
      `${base}/memory?mode=recorded&address=0x1000&length=64&captureId=${encodeURIComponent(shellCaptureId)}`,
    );
    const liveRead1000 = await call(app, 'GET', `${base}/memory?addressSpace=physical&address=0x1000&length=64`);
    evidence.recordedRead = {
      status: recorded.status,
      from: recorded.body?.from,
      hex: recorded.body?.hex,
      liveHex: liveRead1000.body?.hex,
    };
    check(
      'T06-E14c 存档读取（mode=recorded，只认该代记录）与现场读取字节一致',
      recorded.status === 200
        && ['baseline', 'delta'].some((prefix) => String(recorded.body?.from ?? '').startsWith(prefix))
        && recorded.body?.hex === liveRead1000.body?.hex,
      `from=${recorded.body?.from} hex=${String(recorded.body?.hex).slice(0, 32)}…`,
    );

    /* ---------- 事件窗口收窄 + 让客体真实写盘 ---------- */

    /*
     * 只收窄记录期掩码，不在这里 reset：观察者对 `reset` 的契约是
     * 「有活动 capture 时拒绝」（reason=capture-active，必须先 release），
     * 而暂停之后我们**正好**持有一个活动快照。硬发 reset 只会得到一个
     * 合法拒绝，所以改成「记下水印线，后续按 from=水印线+1 读」——
     * 效果相同（窗口里只有收窄之后的事件），而且不违反观察者契约。
     */
    const narrow = await call(app, 'POST', `${base}/events`, {
      epoch,
      enable: true,
      // capture.fence 必须留在掩码里：它不入环时观察者给的 fenceSeq 会退化成 0，
      // 「本帧到哪条事件为止」失效，块事件窗口也会塌成空区间。
      recordKinds: ['dma.read', 'dma.write', 'block.submit', 'block.complete', 'capture.fence'],
    });
    const maskText = String(narrow.body?.recordKindMask ?? '');
    const maskBits = /^0x[0-9a-f]+$/.test(maskText)
      ? maskText.slice(2).split('').reduce((sum, digit) => {
        const value = Number.parseInt(digit, 16);
        return sum + ((value & 1) ? 1 : 0) + ((value & 2) ? 1 : 0) + ((value & 4) ? 1 : 0) + ((value & 8) ? 1 : 0);
      }, 0)
      : -1;
    const windowFrom = narrow.body?.watermark === undefined || narrow.body?.watermark === null
      ? null
      : String(Number(narrow.body.watermark) + 1);
    evidence.eventWindow = {
      narrowStatus: narrow.status,
      narrow: {
        enabled: narrow.body?.enabled,
        recordAllKinds: narrow.body?.recordAllKinds,
        recordKindMask: narrow.body?.recordKindMask,
        recordKinds: narrow.body?.recordKinds,
        recordKindsUnknown: narrow.body?.recordKindsUnknown,
        recordKindsRequested: narrow.body?.recordKindsRequested,
        recordKindsAugmented: narrow.body?.recordKindsAugmented,
        watermark: narrow.body?.watermark,
      },
      windowFrom,
    };
    check(
      'T06-S4 记录期掩码收窄到设备事件 + capture.fence：环里只留 dma/block/fence，不被访存事件挤空',
      narrow.status === 200
        && narrow.body?.enabled === true
        && narrow.body?.recordAllKinds === false
        && (narrow.body?.recordKinds ?? []).length === 5
        && (narrow.body?.recordKinds ?? []).includes('capture.fence')
        && (narrow.body?.recordKindsUnknown ?? []).length === 0
        // 掩码里已经有 fence，服务不该再「补」任何东西；回报为空是这一点的证据。
        && (narrow.body?.recordKindsAugmented ?? null) === null
        && maskBits === 5,
      `mask=${maskText} 置位数=${maskBits} kinds=${JSON.stringify(narrow.body?.recordKinds)} `
        + `unknown=${JSON.stringify(narrow.body?.recordKindsUnknown)} `
        + `augmented=${JSON.stringify(narrow.body?.recordKindsAugmented ?? null)} watermark=${narrow.body?.watermark}`,
    );

    const writeCont = await cmd('continue');
    if (writeCont.status !== 200) throw new Error(`continue（写盘）失败: ${describe(writeCont.body)}`);

    /* VM 正在运行：历史查询必须拒绝读「当前内存」，但存档仍然可读。 */
    const runningLive = await call(app, 'GET', `${base}/memory?addressSpace=physical&address=0x1000&length=64`);
    const runningArchived = await call(
      app,
      'GET',
      `${base}/memory?mode=recorded&address=0x1000&length=64&captureId=${encodeURIComponent(shellCaptureId)}`,
    );
    evidence.runningReads = { live: runningLive.status, archived: runningArchived.status };
    check(
      'T06-S5 VM 运行中：读「当前内存」被拒，读存档照常（历史查询不会偷偷变成读当前 VM）',
      runningLive.status !== 200 && runningArchived.status === 200,
      `live=${runningLive.status} ${describe(runningLive.body)}；archived=${runningArchived.status}`,
    );

    /*
     * 故障写：把根盘里那份确定性数据的前 4096 字节写到 64 MiB 偏移处。
     * 宿主侧一次性注入写错误 + werror=stop，于是 VM 会自己停下，而请求挂在设备
     * 队列 s->rq 上、对客体不可见 —— 这就是「pending 写入」的真实形态。
     *
     * 用 probe.bin 当数据源而不是 /dev/urandom：那 4096 字节在宿主文件系统上有
     * 一份一模一样的来源（同一个文件进了 ext2 镜像），验载荷时可以直接逐字节对照，
     * 不需要相信客体自述。
     */
    const terminalCursor = (await call(app, 'GET', `${base}/terminal`)).body?.text?.length ?? 0;
    /*
     * 两条裸设备写：
     * 1. 目标扇区 —— 命中一次性写故障，制造 pending 写请求（它的载荷会在飞行中被取到）；
     * 2. 另一段空闲区 —— 正常完成，永远取不到载荷：用它验证「可见但没载荷时明确拒绝，
     *    不返回基线旧值」这条路径。两段刻意不相邻，避免被合并成一个可见区间。
     */
    const faultCmd = `dd if=/data/probe.bin of=/dev/vda bs=512 count=${FAULT_SECTORS}`
      + ` seek=${FAULT_SECTOR} conv=fsync 2>&1 | tail -1; `
      + `dd if=/data/probe.bin of=/dev/vda bs=512 count=${FAULT_SECTORS}`
      + ` seek=${NO_PAYLOAD_SECTOR} conv=fsync 2>&1 | tail -1; echo T06-FAULT-"DONE"-$(date +%s)`;
    await call(app, 'POST', `${base}/commands`, {
      requestId: `t06-${++seq}-terminal.input`,
      epoch,
      expectedFrameId: live.frames.at(-1)?.frameId ?? 0,
      type: 'terminal.input',
      text: `${faultCmd}\n`,
    });
    console.log('等待注入的写错误按 werror=stop 把 VM 停下...');
    let stoppedView = null;
    let stoppedError = null;
    try {
      stoppedView = await waitForSessionStopped(app, base, 180000);
    } catch (error) {
      stoppedError = error.message;
    }
    /*
     * 这个场景不能等串口标记：VM 在错误路径上直接停下，dd 走不到 echo。
     * 「停下」本身就是判据，pause 随后只负责把这一刻采成一帧。
     */
    const faultPause = await cmd('pause');
    if (faultPause.status !== 200) throw new Error(`pause（故障写后）失败: ${describe(faultPause.body)}`);
    const faultFrame = live.frames.at(-1);
    const faultLedger = faultFrame.pendingIo?.blockRequests ?? [];
    const faultEntry = faultLedger.find((entry) => entry.op === 'write') ?? null;
    evidence.faultPending = {
      stoppedState: stoppedView?.state ?? null,
      stoppedError,
      stopReason: live.lastStop?.info?.reason ?? live.lastStop?.reason ?? null,
      frameId: faultFrame.frameId,
      captureId: faultFrame.captureId,
      fenceSeq: faultFrame.fenceSeq,
      eventWatermark: faultFrame.eventWatermark,
      pendingIo: {
        count: faultFrame.pendingIo?.count ?? null,
        hostIoDoneCount: faultFrame.pendingIo?.hostIoDoneCount ?? null,
        blockRequests: faultLedger,
      },
      diskVersions: faultFrame.diskVersions,
      diskEvidence: faultFrame.evidence?.['disk.versions'],
      payloadEvidence: faultFrame.evidence?.['disk.payloads'] ?? null,
    };
    check(
      'T06-E09a 注入的写错误留下真实的未完成写请求：VM 因 io-error 停下，台账里它是 op=write、宿主已完成但尚未对客体可见',
      stoppedView !== null
        && faultEntry !== null
        && faultEntry.hostIoDone === true
        && String(faultEntry.state) === 'host-io-done-awaiting-visibility'
        && String(faultEntry.lba) === String(FAULT_SECTOR)
        && Number(faultEntry.length) === FAULT_SECTORS * 512,
      `state=${stoppedView?.state ?? stoppedError} 台账=${faultLedger.length} 条 `
        + `entry=${JSON.stringify(faultEntry)}`,
    );

    /* 载荷必须趁请求还在飞行中取：取回的内容要能对上客体写入的那 4096 字节。 */
    const faultRequestId = faultEntry?.requestId ?? null;
    const faultPayloadEvidence = faultFrame.evidence?.['disk.payloads'] ?? null;
    const faultPayloadRefs = (faultPayloadEvidence?.refs ?? [])
      .filter((ref) => String(ref).startsWith('payload:'));
    const payloadFetch = faultRequestId === null
      ? null
      : await call(app, 'GET', `${base}/disk?payloads=1&requestId=${encodeURIComponent(faultRequestId)}`);
    const fetched = (payloadFetch?.body?.payloads ?? [])[0] ?? null;
    const probeBytes = fs.readFileSync(path.join(ROOT, PROBE_SOURCE)).subarray(0, FAULT_SECTORS * 512);
    const probeSha = sha256(probeBytes);
    evidence.faultPayload = {
      requestId: faultRequestId,
      payloadEvidence: faultPayloadEvidence,
      payloadRefs: faultPayloadRefs,
      fetchStatus: payloadFetch?.status ?? null,
      fetched,
      probeSource: PROBE_SOURCE,
      probeBytes: probeBytes.length,
      probeSha,
    };
    check(
      'T06-E09b pending 写入独立保存：本帧从旅客内存取到该写请求的载荷，其散列等于客体写入的 4096 字节（宿主侧独立来源对照）',
      faultPayloadEvidence?.kind === 'observed'
        && faultPayloadRefs.length > 0
        && fetched !== null
        && fetched.dataRef === probeSha
        && fetched.blobRef === probeSha
        && fetched.length === FAULT_SECTORS * 512,
      `refs=${JSON.stringify(faultPayloadRefs)} dataRef=${fetched?.dataRef ?? 'null'} `
        + `期望=${probeSha} length=${fetched?.length ?? 'null'}（来源 ${PROBE_SOURCE} 前 ${probeBytes.length} 字节）`,
    );

    const resumeCont = await cmd('continue');
    if (resumeCont.status !== 200) {
      throw new Error(`continue（故障写重提交）失败: ${describe(resumeCont.body)}`);
    }
    console.log('等待故障写被重提交并完成（客体打印标记）...');
    await waitForTerminalMarker(app, base, 'T06-FAULT-DONE-', 300000, terminalCursor);
    const pause2 = await cmd('pause');
    if (pause2.status !== 200) throw new Error(`pause（写盘后）失败: ${describe(pause2.body)}`);
    const writeFrame = live.frames.at(-1);
    evidence.writeFrame = {
      frameId: writeFrame.frameId,
      captureId: writeFrame.captureId,
      fenceSeq: writeFrame.fenceSeq,
      eventWatermark: writeFrame.eventWatermark,
      diskVersions: writeFrame.diskVersions,
      diskEvidence: writeFrame.evidence?.['disk.versions'],
      payloadEvidence: writeFrame.evidence?.['disk.payloads'] ?? null,
      pendingIo: {
        count: writeFrame.pendingIo?.count ?? null,
        hostIoDoneCount: writeFrame.pendingIo?.hostIoDoneCount ?? null,
        requests: (writeFrame.pendingIo?.blockRequests ?? []).map((entry) => entry.requestId),
      },
    };

    /* ---------- E14 后半：脏页增量 + 独立全量 dump 对照 ---------- */

    console.log('重扫 RAM 取脏页增量（再有 131072 次 4 KiB 读）...');
    const delta = await cmd('memory.read', { mode: 'delta', baseCaptureId: shellCaptureId });
    evidence.delta = { status: delta.status, body: delta.body };
    const changedPages = (delta.body?.diff?.changed ?? []).map((text) => BigInt(text));
    check(
      'T06-E14d 脏页增量按「按页重读比散列」判定，窗口内真实产生变化页',
      delta.status === 200
        && delta.body?.baseCaptureId === shellCaptureId
        && delta.body?.observedAtCaptureId === writeFrame.captureId
        && changedPages.length > 0
        && (delta.body?.sweep?.skipped ?? []).length === 0,
      `changed=${changedPages.length} unreadable=${(delta.body?.diff?.unreadable ?? []).length} `
        + `unchanged=${delta.body?.diff?.unchanged}`,
    );

    // 重建要基线；没有基线时如实记为未完成，不能抛异常把后面的检查全砍掉。
    let reconstruct = null;
    try {
      reconstruct = await live.memory.reconstruct(shellCaptureId, { strict: true });
      console.log(`重建 RAM（基线 + 增量）散列=${reconstruct.sha256.slice(0, 16)}…`);
    } catch (error) {
      reconstruct = null;
      console.log(`重建 RAM 失败：${error.message}`);
    }

    console.log('取独立通道全量 dump（HMP pmemsave，512 MiB）...');
    fs.rmSync(DUMP_PATH, { force: true });
    const dumpText = await hmp(live, `pmemsave 0 0x${RAM_BYTES.toString(16)} ${DUMP_NAME}`);
    const regionList = baseline.body?.regions ?? [];
    /*
     * 基线只应覆盖机器内存。独立 dump 的范围就是 `-m` 那 512 MiB，任何越界的
     * 区域（历史上出现过把 0xfd000000 的 16 MiB 显存也算成 RAM 的 bug）都读不到，
     * 必须先在断言里把它作为一项失败报出来，而不是让读取抛异常把后面所有检查砍掉。
     */
    const outsideDump = regionList
      .filter((region) => BigInt(region.base) + BigInt(region.size) > RAM_BYTES)
      .map((region) => `${region.name}@${region.base}+${region.size}`);
    let dump = null;
    let dumpError = null;
    try {
      dump = hashDumpRegions(DUMP_PATH, regionList);
    } catch (error) {
      dumpError = error.message;
    }
    evidence.e14 = {
      reconstruct: reconstruct === null ? null : {
        sha256: reconstruct.sha256,
        bytes: reconstruct.bytes,
        missing: reconstruct.missing,
        missingPages: reconstruct.missingPages,
        fromDelta: reconstruct.fromDelta,
        fromBaseline: reconstruct.fromBaseline,
        deltas: reconstruct.deltas,
        complete: reconstruct.complete,
      },
      dump: dump === null
        ? { error: dumpError, path: DUMP_NAME, hmp: String(dumpText).trim() || '（无输出）' }
        : { sha256: dump.sha256, bytes: dump.bytes, path: DUMP_NAME, hmp: String(dumpText).trim() || '（无输出）' },
      regions: regionList,
      regionsOutsideDump: outsideDump,
    };
    check(
      'T06-E14e 停止后的独立全量 dump 与「基线 + 增量」重建逐字节一致（CPU 写与设备 DMA 写都算进去了）',
      reconstruct !== null
        && reconstruct.complete === true
        && outsideDump.length === 0
        && dump !== null
        && reconstruct.sha256 === dump.sha256
        && dump.bytes === MACHINE_RAM_BYTES.toString(),
      reconstruct === null
        ? '重建设有得到结果（多半是基线缺失）'
        : `重建=${reconstruct.sha256.slice(0, 16)}… dump=${dump === null ? `读取失败(${dumpError})` : `${dump.sha256.slice(0, 16)}…`} `
          + `dump 字节=${dump?.bytes ?? 'null'} complete=${reconstruct.complete} `
          + `越界区域=${outsideDump.length === 0 ? '无' : JSON.stringify(outsideDump)}`,
    );

    /* 事件旁证：dma.write 说变过的物理页，扫描必须也都算成变化页。 */
    const windowEvents = await live.observerEvents({
      from: windowFrom ?? '1',
      to: String(writeFrame.fenceSeq ?? 0),
      limit: 8192,
      kinds: ['dma.write'],
    });
    const ramRanges = pagesOf(regionList);
    const derivedPages = [...new Set((windowEvents.events ?? [])
      .filter((event) => event.addressSpace === 'physical')
      .map((event) => BigInt(event.address) & ~(PAGE - 1n))
      .filter((address) => inAnyRegion(address, ramRanges)))];
    const crossCheck = live.memory.crossCheckEvents({ derivedPhysicalPages: derivedPages, changedPages });
    evidence.crossCheck = {
      dmaWriteEvents: (windowEvents.events ?? []).length,
      derivedPages: derivedPages.map((address) => hex(address)),
      crossCheck,
      writeFramePendingLedger: writeFrame.pendingIo,
    };
    check(
      'T06-E14f 事件旁证：dma.write 指到的 RAM 页全部出现在变化页集合里（没有漏采）',
      crossCheck.missed.length === 0,
      `dma.write=${evidence.crossCheck.dmaWriteEvents} 派生页=${derivedPages.length} 漏页=${crossCheck.missed.length} `
        + `${JSON.stringify(crossCheck.missed.slice(0, 4))}`,
    );

    /* ---------- E09：磁盘逻辑版本 ---------- */

    /*
     * 可见区间是 `mergeRanges` 合并后的结果（相邻/重叠的写会被并成一段），所以
     * 「某个扇区是否落在可见写里」要用包含关系判断，不能拿 lba 去比相等 ——
     * 那样会在合法的合并情形上误报。
     */
    const coversSector = (ranges, lba, count) => ranges.some((range) => {
      const start = Number.parseInt(String(range.lba), 16);
      return Number.isFinite(start) && start <= lba && lba + count <= start + Number(range.count);
    });

    const diskView = await call(app, 'GET', `${base}/disk`);
    evidence.diskView = diskView.body;
    const visible = diskView.body?.visible ?? [];
    const pending = diskView.body?.pending ?? [];
    const faultRangeVisible = coversSector(visible, FAULT_SECTOR, FAULT_SECTORS);
    const noPayloadRangeVisible = coversSector(visible, NO_PAYLOAD_SECTOR, FAULT_SECTORS);
    evidence.diskVersionTable = {
      versionId: diskView.body?.versionId ?? null,
      baseline: diskView.body?.baseline ?? null,
      visible,
      pending,
      faultRangeVisible,
      noPayloadRangeVisible,
    };
    check(
      'T06-E09c 磁盘版本表：可见写与未可见写分开表达，版本号由「基线散列 + 可见写范围」决定，故障写恢复后成为可见写',
      diskView.status === 200
        && typeof diskView.body?.versionId === 'string' && diskView.body.versionId.startsWith('v-')
        && /^[0-9a-f]{64}$/.test(String(diskView.body?.baseline?.sha256 ?? ''))
        && Array.isArray(visible) && Array.isArray(pending)
        && visible.length > 0
        && faultRangeVisible === true,
      `version=${diskView.body?.versionId} visible=${visible.length} 段 pending=${pending.length} 笔 `
        + `故障范围可见=${faultRangeVisible} 无载荷范围可见=${noPayloadRangeVisible}`,
    );

    /*
     * 故障写给恢复后重提交、成功、对客体可见，而它的载荷在屏障处已经被取到 ——
     * 所以这一段要能用「记录载荷」读出来，且三方必须一致：
     * 帧里记录的载荷散列 = 服务读出的字节散列 = 宿主侧 probe.bin 的前 4096 字节。
     */
    const faultLbaHex = `0x${FAULT_SECTOR.toString(16)}`;
    const faultRead = await call(app, 'GET', `${base}/disk?lba=${encodeURIComponent(faultLbaHex)}&count=${FAULT_SECTORS}`);
    const faultReadBytes = faultRead.status === 200 && typeof faultRead.body?.bytes === 'string'
      ? Buffer.from(faultRead.body.bytes, 'base64')
      : null;
    const faultReadSha = faultReadBytes === null ? null : sha256(faultReadBytes);
    evidence.faultRead = {
      lba: faultLbaHex,
      count: FAULT_SECTORS,
      status: faultRead.status,
      fromBase: faultRead.body?.fromBase ?? null,
      blobRef: faultRead.body?.blobRef ?? null,
      length: faultRead.body?.length ?? null,
      sha256: faultReadSha,
      evidence: faultRead.body?.evidence ?? null,
      error: faultRead.body?.error ?? null,
      probeSource: PROBE_SOURCE,
      probeSha,
    };
    check(
      'T06-E09d 故障范围读回三方一致：帧记录的载荷散列 = 读出的字节散列 = 宿主侧 probe.bin 前 4096 字节，且标记为「来自写载荷」',
      faultRead.status === 200
        && faultRead.body?.fromBase === false
        && faultRead.body?.length === FAULT_SECTORS * 512
        && faultRead.body?.blobRef === probeSha
        && faultReadSha === probeSha,
      `status=${faultRead.status} fromBase=${faultRead.body?.fromBase} `
        + `读出=${faultReadSha ?? 'null'} blobRef=${faultRead.body?.blobRef ?? 'null'} 期望=${probeSha}`,
    );

    /*
     * 第二笔裸写正常完成、对客体可见，但它的载荷不在本代采集里：取载荷只认停止屏障
     * 那一刻仍在飞行的请求，它早就跑完了。读这一段必须被**明确拒绝** —— 那时基线
     * 内容在这个范围上已经不成立，返回基线字节就是用旧值冒充新值。
     */
    const noPayloadLbaHex = `0x${NO_PAYLOAD_SECTOR.toString(16)}`;
    const noPayloadRead = await call(app, 'GET', `${base}/disk?lba=${encodeURIComponent(noPayloadLbaHex)}&count=${FAULT_SECTORS}`);
    evidence.noPayloadRead = {
      lba: noPayloadLbaHex,
      count: FAULT_SECTORS,
      visible: noPayloadRangeVisible,
      status: noPayloadRead.status,
      error: noPayloadRead.body?.error ?? null,
      body: noPayloadRead.body,
    };
    check(
      'T06-E09e 可见但没采到载荷的范围必须明确拒绝：返回 range-not-captured，而不是基线旧值',
      noPayloadRangeVisible === true
        && noPayloadRead.status === 400
        && noPayloadRead.body?.error?.code === 'range-not-captured',
      `可见=${noPayloadRangeVisible} status=${noPayloadRead.status} ${describe(noPayloadRead.body)}`,
    );

    /* ---------- S6：不许绕过锁读活跃 qcow2 ---------- */

    const offlineWhileRunning = await call(app, 'GET', `${base}/disk?mode=offline`);
    evidence.offlineWhileRunning = { status: offlineWhileRunning.status, error: offlineWhileRunning.body?.error ?? null };
    check(
      'T06-S6 VM 还活着时离线校验被拒（control-busy）：不解锁、不绕过锁读活跃 qcow2',
      offlineWhileRunning.status === 400
        && offlineWhileRunning.body?.error?.code === 'control-busy',
      `status=${offlineWhileRunning.status} ${describe(offlineWhileRunning.body)}`,
    );

    /*
     * 真正关掉 VM（不是销毁会话）后再做离线校验。
     * 注意 `LabProcess.alive` 在调过 kill 之后立刻为 false，但那不代表进程
     * 已经退出——`qemu-img convert` 必须在退出之后才做，所以这里等的是
     * `exitInfo`（子进程真的结束）。
     */
    const killed = terminateQemu(live);
    const killDeadline = Date.now() + 20000;
    while (Date.now() < killDeadline && live.process.exitInfo === null) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const exited = live.process.exitInfo !== null;
    const offlineAfterStop = await call(app, 'GET', `${base}/disk?mode=offline`);
    const offlineBody = offlineAfterStop.body ?? {};
    /*
     * 离线校验的结论分两层，别混着读：
     * - `ok`：凡是校验得了的范围，都和覆盖层对上了；
     * - `complete`：所有可见写都被校验到了。载荷没采到的范围进 `unverified`，
     *   它既不算通过、也不该把整份校验打断。
     * 这里额外要求：故障写那一段必须**真的被比过且一致**，否则「一致」只是没比。
     */
    const faultOfflineEntry = (offlineBody.verified ?? []).find((entry) => {
      const start = Number.parseInt(String(entry.lba), 16);
      return Number.isFinite(start) && start <= FAULT_SECTOR && FAULT_SECTOR < start + Number(entry.count);
    }) ?? null;
    evidence.offlineAfterStop = {
      killed,
      exited,
      exitInfo: live.process.exitInfo,
      status: offlineAfterStop.status,
      ok: offlineBody.ok ?? null,
      complete: offlineBody.complete ?? null,
      checked: offlineBody.checked ?? null,
      mismatches: offlineBody.mismatches ?? [],
      unverified: offlineBody.unverified ?? [],
      verifiedCount: (offlineBody.verified ?? []).length,
      faultOfflineEntry,
      baseSha256: offlineBody.baseSha256 ?? null,
      overlaySha256: offlineBody.overlaySha256 ?? null,
    };
    check(
      'T06-S7 VM 关闭后离线校验成功：按记录载荷重算的可见范围内容与会话覆盖层一致，且故障写那一段被逐字节比过',
      exited === true
        && offlineAfterStop.status === 200
        && offlineBody.ok === true
        && offlineBody.checked > 0
        && (offlineBody.mismatches ?? []).length === 0
        && faultOfflineEntry !== null
        && faultOfflineEntry.match === true,
      `exited=${exited} checked=${offlineBody.checked} complete=${offlineBody.complete} `
        + `unverified=${(offlineBody.unverified ?? []).length} `
        + `故障范围比对=${faultOfflineEntry === null ? 'null' : faultOfflineEntry.match} `
        + `mismatches=${(offlineBody.mismatches ?? []).length}`,
    );

    /* ---------- S8：帧里的 T06 字段形状 ---------- */

    const frameShape = {
      coverageMemory: writeFrame.coverage?.memory,
      diskVersions: writeFrame.diskVersions,
      coverageUnavailable: writeFrame.coverage?.unavailable,
      evidenceKeys: Object.keys(writeFrame.evidence ?? {}),
      memoryCoverageEvidence: writeFrame.evidence?.['memory.coverage'],
      pagingEvidence: writeFrame.evidence?.['cpu.paging'],
      virtqueueEvidence: writeFrame.evidence?.['device.virtio-queues'],
      diskEvidence: writeFrame.evidence?.['disk.versions'],
    };
    evidence.frameShape = frameShape;
    check(
      'T06-S8 帧里带上 T06 产物与缺口：memory 覆盖、diskVersions、四条证据齐全且都写明来源',
      ['memory.coverage', 'cpu.paging', 'device.virtio-queues', 'disk.versions']
        .every((key) => frameShape.evidenceKeys.includes(key))
        && frameShape.evidenceKeys.every((key) => typeof writeFrame.evidence[key]?.source === 'string')
        && (writeFrame.coverage?.unavailable ?? []).every((name) => typeof name === 'string'),
      `unavailable=${JSON.stringify(writeFrame.coverage?.unavailable ?? [])}`,
    );

    evidence.buildLock = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'instrumentation/qemu-observer/build.lock.json'), 'utf8'),
    );
  } catch (error) {
    check('T06 脚本异常', false, error.message);
    evidence.error = { message: error.message, stack: String(error.stack).slice(0, 2000) };
  } finally {
    if (session) {
      const closed = await call(app, 'DELETE', `/api/sessions/${session.id}`);
      check('T06-S9 会话关闭成功', closed.status === 200 && closed.body?.closed === true, describe(closed.body));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const leftover = countSessionProcesses(session.id);
      check('T06-S10 无残留 QEMU/GDB 进程', leftover === 0, `残留进程数=${leftover}`);
    }
    await app.close();
    fs.rmSync(DUMP_PATH, { force: true });
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.checks = results;
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过，失败 ${failed.length} 项`);
  console.log(`证据：${path.relative(ROOT, EVIDENCE)}`);
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  - ${entry.id}: ${entry.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('验证脚本异常:', error);
  process.exit(2);
});
