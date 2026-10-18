#!/usr/bin/env node
/**
 * T05e 停止屏障 / 屏障并发验收（真实 QEMU + 真实 Linux 客体 + 真实块设备）。
 *
 * 覆盖 T05 验收里的 E09「停止时仍有未完成块请求」，以及 T05 总验收要求的
 * 「每项事件与字段的源代码观察点和锁/线程上下文说明」：
 *
 *   A. E09a —— 停机动作自身会 drain 块层（负向对照，另加一条不停机的正对照）
 *      节流盘上被限流的读请求（host-io-pending 的候选）：发起后立刻 stop，于是停机
 *      链条 virtio_blk_data_plane_stop → blk_drain → blk_root_drained_begin →
 *      throttle_group_restart_tgm 会取消/立即触发节流定时器把它放行，随后
 *      AIO_WAIT_WHILE(blk->in_flight > 0) 等它把宿主 I/O 做完。所以停下来的那一刻
 *      屏障处读不到 hostIoDone = false 的 virtio-blk 条目：该请求已经完成、完成事件
 *      落在第一帧 fence 之内。A11 用同一条读做正对照 —— 不发送 stop 时它会被真实
 *      挂起数十秒，证明限流确实生效、A2/A3 的结论来自停机动作而不是采样假象。
 *      「屏障处仍有未完成请求」这一态由 B 组（设备层已挂起的请求）承担。
 *   B. E09b —— 完成回调已进入但还没对客体可见（host-io-done-awaiting-visibility）
 *      blkdebug 注入一次写错误 + werror=stop：virtio_blk_rw_complete() 已经进入并
 *      走了 STOP 分支（请求挂到 s->rq 上、本次不完成），状态字节还没写 → 仍然是
 *      pending，但是另一种状态。VM 恢复后 virtio_blk_dma_restart_bh() 重新提交
 *      同一个请求对象 → 同一 requestId 两条 block.submit、一条 block.complete，
 *      resubmitCount 变 1。
 *   C. 帧分界：capture.fence 的 seq 就是这一帧的 eventWatermark，
 *      「seq <= watermark」与「属于这一帧」严格等价；fence 的
 *      detail.pendingBlockRequests 等于同一瞬间 pendingIo.count。
 *   D. 契约：pendingIo / frameBoundary / fenceSeq 的形状与字段类型，
 *      capture.fence 在 kinds 里、不在 unavailableKinds 里，台账条目的
 *      deviceId / requestId 与 dma.* / block.* 事件是同一套写法。
 *   E. 观察点与锁/线程上下文（源码级，逐项给出文件与符号）。
 *
 * 用法：
 *   node instrumentation/qemu-observer/verify-observer-barrier.mjs
 *
 * 证据输出：artifacts/verify/t05e-observer-barrier.json
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const QEMU = path.join(ROOT, 'artifacts/build/qemu/qemu-system-x86_64');
const KERNEL = path.join(ROOT, 'artifacts/bzImage');
const INITRD = path.join(ROOT, 'artifacts/initramfs.cpio.gz');
const DISK_SRC = path.join(ROOT, 'artifacts/rootfs.img');
const WORK = path.join(ROOT, 'var/tmp/t05e-verify');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05e-observer-barrier.json');
const OBSERVER_C = path.join(HERE, 'x-oslab-observer.c');
const EVENTS_C = path.join(HERE, 'x-oslab-events.c');
const EVENTS_H = path.join(HERE, 'x-oslab-events.h');
const PATCH5 = path.join(HERE, 'patches/0005-t05e-stop-barrier.patch');
const LOCK = path.join(HERE, 'build.lock.json');

const KINDS = ['dma.read', 'dma.write', 'block.submit', 'block.complete',
  'capture.fence'];
const PROMPT = /linux-lab:[^\r\n]*# /;
/* 节流速率：桶要先用一次读填满，之后 128 KiB 的请求要等 (level - avg/10)/avg 秒。
 * 一次 64 KiB 的 dd 会被读前预读放大成 128 KiB 的真实请求，所以第一个请求免费、
 * 第二个请求的等待时间约 31 s —— 足够宽，采集窗口是有界的但远大于 2 s。 */
const THROTTLE_BPS = 4096;
const SLOW_SECTORS = 131072;              /* 64 MiB */
const BAD_SECTORS = 2048;                 /* 1 MiB */
const TARGET_OFFSET = 4 * 1024 * 1024;    /* 远离预读窗口，保证是真 I/O */
const FRAME_KEYS = ['rule', 'fenceRecorded', 'fenceSeq', 'pendingBlockRequests',
  'pendingHostIoDone', 'serializationPoint', 'captureDoesNot'];
const PENDING_KEYS = ['pendingCriterion', 'count', 'hostIoDoneCount',
  'ledgerCapacity', 'ledgerOverflow', 'resubmitCount', 'notes', 'blockRequests'];
const REQUEST_KEYS = ['deviceId', 'deviceIndex', 'requestId', 'requestIdRaw', 'lba',
  'byteOffset', 'length', 'reqType', 'op', 'outSeg', 'inSeg', 'hostIoDone', 'state',
  'submitSeq', 'hostDoneSeq'];
const HEX_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

const evidence = { schema: 'x-oslab/1', task: 'T05e', checks: [] };
const results = [];

function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
}

function fail(message) {
  console.error(`\n致命错误: ${message}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const u64 = (value) => BigInt(String(value ?? 0));
const sortedKeys = (object) => Object.keys(object ?? {}).sort().join(',');

/** 台账条目的摘要（用于逐字段比较与打印）。 */
function ledger(capture) {
  return capture?.pendingIo?.blockRequests ?? [];
}

function findRequest(capture, predicate) {
  return ledger(capture).find(predicate) ?? null;
}

function parseRequestId(text) {
  const m = /^vq(\d+)-(\d+)$/.exec(String(text ?? ''));
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

/* ---------------------------------------------------------------- QMP 客户端 */

class QmpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.sequence = 0;
    this.pending = new Map();
    this.greeting = null;
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.QMP) { this.greeting = message.QMP; continue; }
        if (message.event) continue;
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        entry.resolve(message);
      }
    });
    /*
     * QEMU 退出（quit）或崩溃会直接断开 unix socket。若不在这里把在途命令全部
     * 拒绝掉，收尾阶段的 quit 会一直挂到 180 s 超时，脚本看起来像卡死。
     */
    socket.on('close', () => this.failAll(new Error('QMP 连接已关闭')));
    socket.on('error', (error) => this.failAll(error));
  }

  failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  static async connect(socketPath) {
    const socket = net.createConnection(socketPath);
    const client = new QmpClient(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 QMP greeting 超时')), 15000);
      const wait = setInterval(() => {
        if (client.greeting) { clearTimeout(timer); clearInterval(wait); resolve(); }
      }, 20);
      socket.once('error', (error) => {
        clearTimeout(timer); clearInterval(wait); reject(error);
      });
    });
    await client.raw('qmp_capabilities');
    return client;
  }

  raw(execute, args) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QMP 命令超时: ${execute}`));
      }, 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ execute, arguments: args ?? {}, id })}\n`);
    });
  }

  async command(execute, args) {
    const message = await this.raw(execute, args);
    if (message.error) throw new Error(`${execute}: ${message.error.desc}`);
    return message.return;
  }

  close() { this.socket.destroy(); }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  for (const [label, file] of [['QEMU', QEMU], ['内核', KERNEL], ['initramfs', INITRD],
    ['rootfs', DISK_SRC], ['观察者源码', OBSERVER_C], ['事件实现', EVENTS_C],
    ['事件头文件', EVENTS_H], ['T05e 补丁', PATCH5], ['构建记录', LOCK]]) {
    if (!fs.existsSync(file)) fail(`缺少 ${label}: ${file}`);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });

  const diskCopy = path.join(WORK, 'rootfs.raw');
  const slowImg = path.join(WORK, 'slow.img');
  const badImg = path.join(WORK, 'bad.img');
  const conf = path.join(WORK, 'blkdebug.conf');
  fs.copyFileSync(DISK_SRC, diskCopy);
  fs.writeFileSync(slowImg, '');
  fs.truncateSync(slowImg, SLOW_SECTORS * 512);
  fs.writeFileSync(badImg, Buffer.alloc(BAD_SECTORS * 512));
  /*
   * blkdebug：在节点创建时激活一条「只触发一次」的写错误规则。event="none" 的
   * 规则由 blkdebug_open() 末尾的 bdrv_debug_event(bs, BLKDBG_NONE) 激活；
   * 命中一次后 rule_check() 会把它从 active_rules 里移除并销毁，所以恢复运行后
   * 的重提交会照常成功 —— 这正好把「重提交」和「再次失败」区分开。
   */
  fs.writeFileSync(conf, ['[inject-error]', 'event = "none"', 'iotype = "write"',
    'errno = "5"', 'once = "on"', ''].join('\n'));
  evidence.setup = {
    throttleBpsTotal: THROTTLE_BPS, slowSectors: SLOW_SECTORS, badSectors: BAD_SECTORS,
    targetOffset: TARGET_OFFSET, blkdebugConf: fs.readFileSync(conf, 'utf8'),
    needFullSequence: 'drive_new 的 werror 走 bs_opts（if=none 也允许），'
      + 'blk_set_on_error 落在 BlockBackend 上；blkdebug 的 event="none" 规则在'
      + '节点创建时进 active_rules，第一次写注入 EIO 后自毁',
  };

  const qmpPath = path.join(WORK, 'qmp.sock');
  const serialPath = path.join(WORK, 'serial.sock');
  const args = [
    '-machine', 'pc', '-cpu', 'qemu64',
    '-accel', 'tcg,thread=single', '-smp', '1', '-m', '512',
    '-display', 'none', '-nodefaults', '-device', 'VGA',
    '-device', 'isa-serial,chardev=serial0',
    '-chardev', `socket,id=serial0,path=${serialPath},server=on,wait=off`,
    '-qmp', `unix:${qmpPath},server=on,wait=off`,
    '-drive', `file=${diskCopy},format=raw,if=none,id=rootdisk`,
    '-device', 'virtio-blk-pci,drive=rootdisk,id=rootblk',
    '-drive', `file=${slowImg},format=raw,if=none,id=slowdisk,`
      + `throttling.bps-total=${THROTTLE_BPS}`,
    '-device', 'virtio-blk-pci,drive=slowdisk,id=slowblk',
    '-drive', `file=blkdebug:${conf}:${badImg},format=raw,if=none,id=badblk,`
      + 'werror=stop',
    '-device', 'virtio-blk-pci,drive=badblk,id=badblkdev',
    '-kernel', KERNEL, '-initrd', INITRD,
    '-append', 'nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init loglevel=5',
    '-S', '-no-reboot',
  ];
  const logFd = fs.openSync(path.join(WORK, 'qemu.log'), 'w');
  const proc = spawn(QEMU, args, { cwd: ROOT, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  let procExit = null;
  proc.on('exit', (code, signal) => { procExit = { code, signal }; });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(fs.existsSync(qmpPath) && fs.existsSync(serialPath))) {
    if (procExit) fail(`QEMU 提前退出: ${JSON.stringify(procExit)}`);
    await sleep(50);
  }

  const serialSocket = net.createConnection(serialPath);
  let serialText = '';
  let serialCursor = 0;
  serialSocket.on('data', (chunk) => { serialText += chunk.toString('latin1'); });
  await new Promise((resolve, reject) => {
    serialSocket.once('connect', resolve);
    serialSocket.once('error', reject);
  });
  const send = (line) => serialSocket.write(`${line}\n`);
  const pump = (regex, label, timeoutMs) => new Promise((resolve, reject) => {
    const limit = Date.now() + timeoutMs;
    const tick = () => {
      const index = serialText.slice(serialCursor).search(regex);
      if (index >= 0) {
        const at = serialCursor + index;
        serialCursor = at + 1;
        resolve(serialText.slice(Math.max(0, at - 80), at + 260));
        return;
      }
      if (Date.now() >= limit) {
        reject(new Error(`等待 ${label} 超时；串口末尾：${JSON.stringify(serialText.slice(-600))}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });

  const qmp = await QmpClient.connect(qmpPath);
  const readAll = async (from = 1) => {
    const list = [];
    let meta = null;
    let cursor = from;
    for (let guard = 0; guard < 400; guard += 1) {
      const part = await qmp.command('x-oslab-events', { from: cursor, limit: 4096 });
      list.push(...part.events);
      meta = part;
      cursor = Number(part.nextSeq);
      if (part.truncated !== true) break;
    }
    return { list, meta };
  };
  const capture = async () => {
    const out = await qmp.command('x-oslab-capture');
    if (out.ok !== true) fail(`采集被拒: ${JSON.stringify(out)}`);
    return out;
  };

  try {
    await qmp.command('cont');
    await pump(PROMPT, '提示符', 300000);
    serialCursor = serialText.length;

    /*
     * 客体侧把块设备映射到 PCI 地址（不依赖枚举顺序）。这一步在客体运行时做，
     * 而且此时事件开关还没打开，不会污染后面的事件流。
     */
    send('for d in /sys/block/vd[a-z]; do echo "DEVMAP $(basename $d) $(cat $d/size) $(readlink -f $d/device)"; done; echo DEVMAPDONE-$(date +%s)');
    await pump(/DEVMAPDONE-\d{6,}/, 'DEVMAPDONE', 60000);
    const map = {};
    for (const line of serialText.split('\n')) {
      const m = /DEVMAP (\S+) (\d+) (\S+)/.exec(line.replace(/\r/g, ''));
      if (m === null) continue;
      const pci = /([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])/.exec(m[3]);
      map[`/dev/${m[1]}`] = { sectors: Number(m[2]),
        pci: pci === null ? null : pci[1].replace(/^0000:/, ''), sysfs: m[3] };
    }
    evidence.guestDevices = map;

    /* ---------- 0. 基础：停机切换事件开关、找设备 ---------- */
    await qmp.command('stop');
    const enabled = await qmp.command('x-oslab-events',
      { enable: true, recordKinds: KINDS });
    await qmp.command('x-oslab-events', { reset: true });
    const cold = await capture();
    evidence.qemuVersion = cold.qemuVersion;
    evidence.binary = {
      path: path.relative(ROOT, QEMU),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(QEMU)).digest('hex'),
    };
    evidence.eventSwitch = { enabled: enabled.enabled, recordKinds: enabled.recordKinds,
      recordKindMask: enabled.recordKindMask, runState: enabled.runState };
    check('0.1 记录期掩码只放行本次要用的 5 类事件（指令/访存事件不入环，避免冲掉稀疏的设备事件）',
      enabled.enabled === true && enabled.runState === 'paused'
      && JSON.stringify(enabled.recordKinds) === JSON.stringify(KINDS)
      && enabled.recordKindMask === '0x9830',
      JSON.stringify({ mask: enabled.recordKindMask, kinds: enabled.recordKinds }));

    const vblks = (cold.devices ?? []).filter((d) => d.kind === 'virtio-blk');
    const byId = (fragment) => vblks.find((d) => String(d.deviceId).includes(fragment));
    const slowDev = byId('slowblk');
    const badDev = byId('badblkdev');
    if (slowDev === undefined || badDev === undefined) {
      fail(`找不到两块 virtio-blk 设备: ${JSON.stringify(vblks.map((d) => d.deviceId))}`);
    }
    evidence.devices = { slow: { id: slowDev.deviceId, pci: slowDev.pciAddress },
      bad: { id: badDev.deviceId, pci: badDev.pciAddress } };

    /* 客体侧映射与本侧交叉核对：按 PCI 地址与扇区数双向确认。 */
    const guestSlow = Object.entries(map).find(([, v]) => v.pci === slowDev.pciAddress && v.sectors === SLOW_SECTORS);
    const guestBad = Object.entries(map).find(([, v]) => v.pci === badDev.pciAddress && v.sectors === BAD_SECTORS);
    check('0.2 客体设备节点与本侧设备按 PCI 地址一一对应（不依赖枚举顺序）',
      guestSlow !== undefined && guestBad !== undefined
      && slowDev.pciAddress !== badDev.pciAddress,
      JSON.stringify({ slow: guestSlow?.[0], bad: guestBad?.[0], map }));
    if (guestSlow === undefined || guestBad === undefined) fail('客体设备映射无法确定');
    const slowNode = guestSlow[0];
    const badNode = guestBad[0];

    /* ---------- 1. 契约与能力自述 ---------- */
    const caps = await qmp.command('x-oslab-capabilities');
    const barrier = caps.stopBarrier ?? {};
    const pendingCap = caps.pendingIo ?? {};
    const evCap = caps.events ?? {};
    check('1.1 stopBarrier 能力自述完整：串行化点、水位线即 fence、pending 已分类',
      barrier.supported === true && barrier.requiresAllVcpusStopped === true
      && barrier.context === 'main-loop + BQL' && barrier.eventWatermarkIsFence === true
      && barrier.pendingIoClassified === true
      && String(barrier.note).includes('状态字节'),
      JSON.stringify(barrier));
    check('1.2 pendingIo 能力自述完整：字段、判据、读取门、覆盖范围、重提交语义、禁止项',
      pendingCap.supported === true
      && pendingCap.field === 'x-oslab-capture.pendingIo'
      && String(pendingCap.pendingCriterion).includes('状态字节')
      && String(pendingCap.readGate).includes('BQL')
      && String(pendingCap.coverage).includes('virtio-blk')
      && String(pendingCap.resubmitSemantics).includes('block.submit')
      && String(pendingCap.forbidden).includes('不得')
      && Array.isArray(pendingCap.fields) && pendingCap.fields.length === 8
      && String(pendingCap.ledgerAnchor).includes('XOslabInflightState'),
      JSON.stringify({ fields: pendingCap.fields?.length, gate: pendingCap.readGate }));
    check('1.3 capture.fence 在 kinds 里、不在 unavailableKinds 里（不用「名字存在」冒充会产生）',
      Array.isArray(evCap.kinds) && evCap.kinds.includes('capture.fence')
      && Array.isArray(evCap.unavailableKinds)
      && !evCap.unavailableKinds.includes('capture.fence')
      && evCap.unavailableKinds.includes('irq.raise')
      && String(evCap.granularity).includes('capture.fence'),
      JSON.stringify({ unavailable: evCap.unavailableKinds }));
    check('1.4 冷启动快照的帧分界形状正确（停机采集：fence 已记录、pending 为 0）',
      cold.fenceSeq !== undefined && cold.eventWatermark !== undefined
      && u64(cold.fenceSeq) !== 0n && cold.fenceSeq === cold.eventWatermark
      && cold.frameBoundary?.fenceRecorded === true
      && cold.frameBoundary?.fenceSeq === cold.fenceSeq
      && sortedKeys(cold.frameBoundary) === [...FRAME_KEYS].sort().join(',')
      && sortedKeys(cold.pendingIo) === [...PENDING_KEYS].sort().join(',')
      && cold.pendingIo.count === cold.pendingIo.blockRequests.length
      && cold.pendingIo.ledgerCapacity === 512
      && cold.frameBoundary.pendingBlockRequests === cold.pendingIo.count,
      JSON.stringify({ fenceSeq: cold.fenceSeq, watermark: cold.eventWatermark,
        pending: cold.pendingIo.count }));

    /* ---------- A. E09a：宿主还在搬数据 ---------- */
    console.log('\n== E09a：节流盘上被限流的读请求 ==');
    await qmp.command('cont');
    serialCursor = serialText.length;
    let t0 = Date.now();
    /*
     * 标记必须由客体端算出来。串口控制台会回显我们写进去的整行命令，如果标记是
     * 字面量（echo PRIME-DONE），pump() 会在回显那一行上命中，把「命令还没执行完」
     * 当成「已经执行完」——实测这会把 31 s 的限流等待量成 100 ms。
     * 用 $(date +%s) 让回显里只剩字面量，只有客体真正执行后才会打出数字。
     */
    send(`dd if=${slowNode} of=/dev/null bs=64k count=1 skip=0 2>&1 | tail -1; echo PRIMEDONE-$(date +%s)`);
    const primeText = await pump(/PRIMEDONE-\d{6,}/, 'PRIMEDONE', 180000);
    const primeMs = Date.now() - t0;
    serialCursor = serialText.length;
    t0 = Date.now();
    send(`dd if=${slowNode} of=/dev/null bs=64k count=1 skip=${TARGET_OFFSET / 65536} 2>&1 | tail -1; echo SLOWDONE-$(date +%s)`);

    let target = null;
    let targetEvent = null;
    for (let i = 0; i < 80 && targetEvent === null; i += 1) {
      await sleep(60);
      const { list } = await readAll();
      targetEvent = list.find((e) => e.kind === 'block.submit'
        && String(e.deviceId).includes('slowblk')
        && BigInt(String(e.detail?.byteOffset ?? 0)) >= BigInt(TARGET_OFFSET)) ?? null;
    }
    await qmp.command('stop');
    const stoppedMs = Date.now() - t0;
    /*
     * 若限流没有被停机动作放行，这个 64 KiB 的 dd 会被读前预读放大成 128 KiB 的
     * 请求，等待时间就是 (level - avg/10)/avg ≈ (131072 - 409)/4096 ≈ 31.9 s。
     * A11 的「不停机对照」会实测这个量级，这里先用它当上界。
     */
    const theoreticalWaitMs = Math.round((128 * 1024 - THROTTLE_BPS / 10) / THROTTLE_BPS * 1000);
    evidence.scenarioA = { primeMs, stoppedMs, theoreticalWaitMs, targetSubmit: targetEvent };
    check('A1 被限流的读请求确实进入了设备（block.submit 出现在目标偏移之后）',
      targetEvent !== null && String(targetEvent.detail?.op) === 'read'
      && BigInt(String(targetEvent.detail?.byteOffset)) >= BigInt(TARGET_OFFSET)
      && Number(targetEvent.size) >= 65536,
      targetEvent === null ? '未出现' : JSON.stringify({ lba: targetEvent.detail.lba, size: targetEvent.size }));
    if (targetEvent === null) fail('E09a 没有观测到被限流的请求，无法继续');

    const frames = [];
    for (let i = 0; i < 5; i += 1) {
      frames.push(await capture());
      if (i < 4) await sleep(500);
    }
    await sleep(200);
    const a1 = frames[0];
    /*
     * requestId（vq<队列>-<描述符>）只在**同一设备内**唯一：每块 virtio-blk 的顺序
     * 请求都会复用描述符 0，撞出同一个 vq0-0。所以归属一个请求必须同时比对
     * deviceId + requestId，并用它的 block.submit 的 seq 切出「这一次请求」的区间。
     */
    const sameRequest = (e) => e.deviceId === targetEvent.deviceId
      && e.requestId === targetEvent.requestId;
    target = findRequest(a1, (r) => r.deviceId === targetEvent.deviceId
      && r.requestId === targetEvent.requestId);
    const fences = frames.map((c) => u64(c.fenceSeq));
    const firstFence = fences[0];
    const allWindowEvents = (await readAll()).list;
    const targetWindowEvents = allWindowEvents.filter(
      (e) => sameRequest(e) && u64(e.seq) > u64(targetEvent.seq));
    const aCompletes = targetWindowEvents.filter((e) => e.kind === 'block.complete');
    const completesBeforeFrame = aCompletes.filter((e) => u64(e.seq) <= firstFence);
    const eventsInCaptureWindow = allWindowEvents.filter(
      (e) => sameRequest(e) && u64(e.seq) > firstFence);
    evidence.scenarioA.completes = aCompletes;
    evidence.scenarioA.eventsInCaptureWindow = eventsInCaptureWindow;
    evidence.scenarioA.captures = frames.map((c) => ({
      fenceSeq: c.fenceSeq, eventWatermark: c.eventWatermark,
      pendingCount: c.pendingIo.count, hostIoDoneCount: c.pendingIo.hostIoDoneCount,
      resubmitCount: c.pendingIo.resubmitCount, blockRequests: c.pendingIo.blockRequests,
      frameBoundary: c.frameBoundary,
    }));
    evidence.scenarioA.fences = fences.map(String);
    /*
     * 负向对照：停机动作本身就是一次 drain。qmp_stop → vm_state_notify →
     * virtio_vmstate_change → virtio_bus_stop_ioeventfd → virtio_blk_data_plane_stop
     * → blk_drain → bdrv_drained_begin → blk_root_drained_begin 会置
     * io_limits_disabled 并调 throttle_group_restart_tgm() 取消/立即触发节流定时器，
     * 被限流的请求当场被放行；紧接着 AIO_WAIT_WHILE(blk->in_flight > 0) 等它把宿主
     * I/O 做完。所以屏障处读不到 hostIoDone=false 的 virtio-blk 条目 ——
     * 「停机时仍有未完成块请求」这一态由 B 组（设备层已挂起）承担，见 C7。
     */
    check('A2 负向对照：停机屏障处不存在 host-io-pending 条目（停机动作自身 drain 块层并放行被限流请求）',
      a1.pendingIo.blockRequests.every((r) => r.state !== 'host-io-pending')
      && a1.pendingIo.hostIoDoneCount === 0
      && a1.pendingIo.count === a1.pendingIo.blockRequests.length
      && String(a1.pendingIo.ledgerOverflow) === '0'
      && (target === null || target.hostIoDone === true),
      JSON.stringify({ pendingAtBarrier: a1.pendingIo.count,
        states: a1.pendingIo.blockRequests.map((r) => r.state), target }));
    check('A3 该请求在停机动作里就完成了：block.complete 落在第一帧 fence 之内（seq <= fenceSeq）、'
      + 'status=ok，且台账里已经没有它',
      completesBeforeFrame.length === 1
      && completesBeforeFrame[0].detail?.status === 'ok'
      && target === null,
      JSON.stringify({ completesBeforeFrame: completesBeforeFrame.map((e) => `${e.seq}:${e.detail?.status}`),
        firstFence: firstFence.toString(), stillInLedger: target !== null }));
    check('A4 事件不跨帧误归属：完成事件不落在采集窗口内，采集窗口里没有该 requestId 的任何事件',
      eventsInCaptureWindow.length === 0 && aCompletes.length === 1,
      JSON.stringify({ inWindow: eventsInCaptureWindow.map((e) => `${e.kind}@${e.seq}`),
        completes: aCompletes.map((e) => `${e.seq}:${e.detail?.status}`) }));

    check('A5 采集不替客体完成工作：连续 5 次采集的 pending 台账逐字段完全相同，'
      + '采集窗口内也没有该请求的任何 block.complete',
      frames.every((c) => JSON.stringify(c.pendingIo) === JSON.stringify(a1.pendingIo))
      && eventsInCaptureWindow.length === 0,
      JSON.stringify({ pendingCounts: frames.map((c) => c.pendingIo.count),
        inWindow: eventsInCaptureWindow.map((e) => `${e.kind}@${e.seq}`) }));
    check('A6 fence 与台账是同一瞬间：detail.pendingBlockRequests = pendingIo.count、'
      + 'pendingHostIoDone = hostIoDoneCount、eventWatermark = fenceSeq，且五帧 fence 连续递增',
      frames.every((c) => c.frameBoundary.pendingBlockRequests === c.pendingIo.count
        && c.frameBoundary.pendingHostIoDone === c.pendingIo.hostIoDoneCount
        && c.fenceSeq === c.eventWatermark)
      && fences.every((seq, i) => i === 0 || seq === fences[i - 1] + 1n),
      JSON.stringify({ fences: fences.map(String) }));
    const fenceEvents = (await readAll()).list.filter((e) => e.kind === 'capture.fence');
    evidence.scenarioA.fenceEvents = fenceEvents;
    check('A7 每条成功采集都在事件流里留下一条 capture.fence，seq 与 frameBoundary.fenceSeq 一致',
      fenceEvents.length === frames.length + 1
      && frames.every((c) => fenceEvents.some((e) => u64(e.seq) === u64(c.fenceSeq)
        && e.detail?.pendingBlockRequests === c.pendingIo.count)),
      JSON.stringify({ fenceEvents: fenceEvents.length, captures: frames.length }));
    check('A8 待完成块请求台账的形状契约：pendingIo 的 8 个键齐全、count 与 blockRequests 自洽、'
      + '容量 512 且无溢出，条目字段就是那 15 个',
      sortedKeys(a1.pendingIo) === [...PENDING_KEYS].sort().join(',')
      && a1.pendingIo.count === a1.pendingIo.blockRequests.length
      && a1.pendingIo.hostIoDoneCount
        === a1.pendingIo.blockRequests.filter((r) => r.hostIoDone).length
      && Number(a1.pendingIo.ledgerCapacity) === 512
      && String(a1.pendingIo.ledgerOverflow) === '0'
      && a1.pendingIo.blockRequests.every(
        (r) => sortedKeys(r) === [...REQUEST_KEYS].sort().join(',')),
      JSON.stringify({ keys: sortedKeys(a1.pendingIo), count: a1.pendingIo.count,
        capacity: a1.pendingIo.ledgerCapacity }));

    const resumeFrom = fences[fences.length - 1];
    await qmp.command('cont');
    const slowTail = await pump(/SLOWDONE-\d{6,}/, 'SLOWDONE', 240000);
    const totalMs = Date.now() - t0;
    await qmp.command('stop');
    const a3 = await capture();
    evidence.scenarioA.resume = { totalMs, slowTail: slowTail.replace(/\r/g, '').trim(),
      prime: primeText.replace(/\r/g, '').trim() };
    const after = (await readAll()).list.filter((e) => e.kind === 'block.complete'
      && e.deviceId === targetEvent.deviceId && e.requestId === targetEvent.requestId
      && u64(e.seq) > resumeFrom);
    evidence.scenarioA.completeAfterResume = after;
    check('A9 恢复运行后 dd 立刻结束、台账里仍然没有它（说明请求是被停机动作放行的，'
      + '不是恢复运行之后才做完）',
      after.length === 0
      && target === null
      && a3.pendingIo.blockRequests.every((r) => r.state !== 'host-io-pending'),
      JSON.stringify({ afterResume: after.length, stillInLedger: target !== null }));
    check('A10 量化对照：限流读的总耗时远小于理论等待，放行来自停机动作而限流本身真实生效',
      totalMs < Math.min(theoreticalWaitMs, 15000) && stoppedMs < theoreticalWaitMs / 4,
      `理论等待 ≈ ${theoreticalWaitMs} ms（128 KiB / ${THROTTLE_BPS} Bps）；实际 dd 总耗时 `
      + `${totalMs} ms，stop 距发起 ${stoppedMs} ms，prime ${primeMs} ms`);

    /*
     * A11 是「不停机」的正对照：同样的限流读，这次不发送 stop，让它自己把桶漏完。
     * 如果限流根本没生效，这里也会立刻结束，A2/A3 的负向结论就站不住。
     */
    await qmp.command('cont');
    serialCursor = serialText.length;
    const positiveStart = Date.now();
    send(`dd if=${slowNode} of=/dev/null bs=64k count=1 skip=${TARGET_OFFSET / 65536 + 128} 2>&1 | tail -1; echo SLOWDONE2-$(date +%s)`);
    const positiveTail = await pump(/SLOWDONE2-\d{6,}/, 'SLOWDONE2', 240000);
    const positiveMs = Date.now() - positiveStart;
    await qmp.command('stop');
    await capture();
    evidence.scenarioA.positiveControl = { positiveMs,
      output: positiveTail.replace(/\r/g, '').trim() };
    check('A11 正对照：同样的限流读在不停机时会被真实挂起数秒以上（限流确实生效，'
      + '所以 A2/A3 的「屏障处已完成」只能来自停机动作自身的 drain）',
      positiveMs >= 5000,
      `不停机的限流读耗时 ${positiveMs} ms，停机那次 ${totalMs} ms`);

    /* ---------- B. E09b：完成回调已进入、还没对客体可见 ---------- */
    console.log('\n== E09b：blkdebug 注入写错误 + werror=stop ==');
    await qmp.command('x-oslab-events', { reset: true });
    const b0 = await capture();
    await qmp.command('cont');
    await sleep(200);
    serialCursor = serialText.length;
    send(`dd if=/dev/zero of=${badNode} bs=512 count=1 2>&1 | tail -1; echo BADDONE-$(date +%s)`);
    let runState = 'running';
    for (let i = 0; i < 120; i += 1) {
      await sleep(150);
      runState = (await qmp.command('query-status')).status;
      if (runState !== 'running') break;
    }
    const e1 = await capture();
    await sleep(500);
    const e2 = await capture();
    const bad = findRequest(e1, (r) => r.deviceId === badDev.deviceId && r.op === 'write');
    evidence.scenarioB = {
      runState, baseWatermark: b0.eventWatermark, baseFence: b0.fenceSeq,
      captures: [e1, e2].map((c) => ({ fenceSeq: c.fenceSeq, eventWatermark: c.eventWatermark,
        pendingIo: c.pendingIo, frameBoundary: c.frameBoundary })),
    };
    check('B1 宿主错误动作 stop 让 VM 自行停下（io-error）：请求挂在设备里，本次不完成',
      runState === 'io-error' && e1.runState === 'io-error' && e1.allVcpusStopped === true,
      `query-status=${runState}, capture.runState=${e1.runState}`);
    check('B2 该请求是另一种 pending：hostIoDone=true、state=host-io-done-awaiting-visibility、op=write',
      bad !== null && bad.op === 'write' && bad.hostIoDone === true
      && bad.state === 'host-io-done-awaiting-visibility' && bad.length >= 512
      && e1.pendingIo.hostIoDoneCount >= 1
      && e1.pendingIo.count === e1.pendingIo.blockRequests.length
      && e1.pendingIo.hostIoDoneCount
        === e1.pendingIo.blockRequests.filter((r) => r.hostIoDone).length
      && u64(bad.hostDoneSeq) !== 0n && u64(bad.hostDoneSeq) >= u64(bad.submitSeq),
      JSON.stringify(bad));
    check('B3 pending 判据与 hostIoDone 解耦：屏障处能读到的 pending 是设备层已挂起的那一种'
      + '（hostIoDone=true、state=host-io-done-awaiting-visibility）；host-io-pending 那一态'
      + '会被停机动作自己 drain 掉（A 组），两种取值在台账里是分开的',
      bad?.hostIoDone === true
      && bad?.state === 'host-io-done-awaiting-visibility'
      && a1.pendingIo.blockRequests.every((r) => r.state !== 'host-io-pending'),
      JSON.stringify({ barrier: bad?.state,
        aGroupStates: a1.pendingIo.blockRequests.map((r) => r.state) }));
    check('B4 采集前后分类稳定：两次采集的 pending 台账逐字段相同，且此刻 resubmitCount 仍是 0',
      JSON.stringify(e1.pendingIo) === JSON.stringify(e2.pendingIo)
      && String(e1.pendingIo.resubmitCount) === '0',
      JSON.stringify({ resubmit: e1.pendingIo.resubmitCount, fence: e1.fenceSeq }));
    const bDrain = (await readAll()).list.filter((e) => e.kind === 'block.complete'
      && e.deviceId === bad?.deviceId && e.requestId === bad?.requestId
      && u64(e.seq) > u64(bad?.submitSeq ?? 0) && u64(e.seq) <= u64(e2.fenceSeq));
    check('B5 采集不替客体完成请求：该请求在帧内没有 block.complete（STOP 分支本次不完成）',
      bDrain.length === 0,
      JSON.stringify({ completesInFrame: bDrain }));

    await qmp.command('cont');
    const badTail = await pump(/BADDONE-\d{6,}/, 'BADDONE', 90000);
    await sleep(1200);
    await qmp.command('stop');
    const e3 = await capture();
    const bEvents = (await readAll(Number(u64(b0.eventWatermark) + 1n))).list;
    const samePendingRequest = (e) => e.deviceId === bad?.deviceId
      && e.requestId === bad?.requestId;
    const inRequestWindow = (e) => samePendingRequest(e)
      && u64(e.seq) >= u64(bad?.submitSeq ?? 0);
    const submits = bEvents.filter((e) => e.kind === 'block.submit' && inRequestWindow(e));
    const completes = bEvents.filter((e) => e.kind === 'block.complete' && inRequestWindow(e));
    evidence.scenarioB.resume = { badTail: badTail.replace(/\r/g, '').trim(), submits,
      completes, finalPendingIo: e3.pendingIo, finalFence: e3.fenceSeq };
    check('B6 恢复后设备重新提交同一个请求对象：同一个 requestId 两条 block.submit、一条 '
      + 'block.complete，resubmitCount 累加为 1',
      submits.length === 2 && completes.length === 1
      && u64(submits[0].seq) === u64(bad?.submitSeq ?? 0)
      && submits[1].detail?.op === 'write' && completes[0].detail?.status === 'ok'
      && u64(completes[0].seq) > u64(submits[1].seq)
      && u64(submits[0].seq) <= u64(e2.fenceSeq)
      && u64(submits[1].seq) > u64(e2.fenceSeq)
      && String(e3.pendingIo.resubmitCount) === '1'
      && findRequest(e3, samePendingRequest) === null,
      JSON.stringify({ submits: submits.map((e) => e.seq), completes: completes.map((e) => e.seq),
        resubmit: e3.pendingIo.resubmitCount }));
    check('B7 台账条目与 dma.*/block.* 事件用同一套标识：deviceId 是设备名、deviceIndex 是注册表 id、'
      + 'requestId 是 vq<队列>-<描述符>、requestIdRaw 是它的打包值（可由 requestId 还原），'
      + '且条目字段就是那 15 个',
      bad !== null && submits.length >= 1
      && bad.deviceId === submits[0].deviceId
      && bad.requestId === submits[0].requestId
      && bad.deviceIndex === submits[0].detail?.deviceIndex
      && parseRequestId(bad.requestId) !== null
      && BigInt(bad.requestIdRaw)
        === (BigInt(parseRequestId(bad.requestId)[0]) << 32n)
          + BigInt(parseRequestId(bad.requestId)[1])
      && sortedKeys(bad) === [...REQUEST_KEYS].sort().join(','),
      JSON.stringify({ ledger: { deviceId: bad?.deviceId, deviceIndex: bad?.deviceIndex,
        requestId: bad?.requestId, requestIdRaw: bad?.requestIdRaw },
        event: { deviceId: submits[0]?.deviceId, deviceIndex: submits[0]?.detail?.deviceIndex,
          requestId: submits[0]?.requestId },
        keys: sortedKeys(bad ?? {}) }));

    /* ---------- C. 观察点与锁/线程上下文 ---------- */
    console.log('\n== C. 源码观察点与锁/线程上下文 ==');
    const src = fs.readFileSync(OBSERVER_C, 'utf8');
    const evc = fs.readFileSync(EVENTS_C, 'utf8');
    const evh = fs.readFileSync(EVENTS_H, 'utf8');
    const patch = fs.readFileSync(PATCH5, 'utf8');
    const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    const points = evCap.observationPoints ?? {};
    check('C1 capture.fence 与 pendingIo 的观察点在 capabilities 里指向真实文件与符号',
      /x-oslab-observer\.c/.test(points['capture.fence'] ?? '')
      && /qmp_x_oslab_capture/.test(points['capture.fence'] ?? '')
      && /x-oslab-events\.c/.test(points.pendingIo ?? '')
      && /virtio_blk_handle_request/.test(points.pendingIo ?? '')
      && /virtio_blk_req_complete/.test(points.pendingIo ?? ''),
      JSON.stringify({ fence: points['capture.fence']?.slice(0, 60), pendingIo: points.pendingIo?.slice(0, 60) }));
    check('C2 台账三处真实落点都在 virtio-blk 补丁里：登记 / hostIoDone / 移除，另有幂等兜底',
      patch.includes('x_oslab_block_inflight_submit(')
      && patch.includes('x_oslab_block_inflight_host_done(')
      && patch.includes('x_oslab_block_inflight_visible(')
      && patch.includes('x_oslab_block_inflight_clear_device(')
      && patch.includes('static void virtio_blk_free_request')
      && patch.includes('virtio_blk_req_complete')
      && patch.includes('virtio_blk_rw_complete'),
      'T05e 补丁落在 virtio_blk_handle_request / virtio_blk_rw_complete / virtio_blk_req_complete / virtio_blk_free_request');
    check('C3 串行化边界有源码级依据：capture 断言持 BQL、台账快照先于 fence、水位线取 fence 的 seq',
      src.includes('qemu_mutex_iothread_locked()')
      && src.includes('统一串行化点')
      && src.indexOf('x_oslab_pending_io_json(&pending_io') < src.indexOf('x_oslab_event_fence(pending_count)')
      && src.includes('fence_seq != 0 ? fence_seq : x_oslab_event_watermark()')
      && src.includes('不 drain 块层'),
      'capture：断言 BQL → 台账快照 → capture.fence → eventWatermark = fence.seq');
    check('C4 pending 判据写进了头文件：可见性判据 + hostIoDone 只是并列事实 + 重提交语义',
      evh.includes('状态字节有没有回写客体')
      && evh.includes('hostIoDone 只是并列的一层')
      && evh.includes('宿主块层还在搬数据') && evh.includes('还没对设备可见')
      && evh.includes('resubmits') && evh.includes('block.submit 会出现两次')
      && evc.includes('resubmits'),
      'x-oslab-events.h/.c 里有判据、两层状态与重提交计数');
    check('C5 build.lock.json 已登记 stopBarrier / pendingIo，且未把 capture.fence 列为未实现',
      lock.stopBarrier !== undefined && lock.pendingIo !== undefined
      && lock.commandsNotImplemented?.['capture.fence'] === undefined
      && lock.commandsNotImplemented?.pendingIo === undefined
      && String(lock.pendingIo.pendingCriterion).includes('状态字节')
      && Array.isArray(lock.pendingIo.fields) && lock.pendingIo.fields.length >= 14,
      JSON.stringify({ stopBarrier: Object.keys(lock.stopBarrier ?? {}),
        notImplemented: Object.keys(lock.commandsNotImplemented ?? {}) }));
    check('C6 台账字段含 512 条容量与溢出计数，且本次两个场景的溢出都是 0（分类完整）',
      Number(a1.pendingIo.ledgerCapacity) === 512
      && String(a1.pendingIo.ledgerOverflow) === '0'
      && String(e1.pendingIo.ledgerOverflow) === '0'
      && Array.isArray(a1.pendingIo.notes) && a1.pendingIo.notes.length >= 4,
      JSON.stringify({ capacity: a1.pendingIo.ledgerCapacity, overflow: a1.pendingIo.ledgerOverflow }));
    check('C7 停机屏障的可观测性有源码级记录：停机动作自身会 drain 块层并放行被限流请求，'
      + '因此 virtio-blk 的屏障处 host-io-pending 不可观测（台账文档 + 运行时自述 + 构建记录三处一致）',
      evh.includes('throttle_group_restart_tgm')
      && evh.includes('virtio_blk_data_plane_stop')
      && evh.includes('AIO_WAIT_WHILE(blk->in_flight > 0)')
      && evh.includes('停机屏障处不会出现 hostIoDone == false 的条目')
      && src.includes('barrierObservability')
      && src.includes('host-io-pending 不可观测')
      && String(pendingCap.barrierObservability).includes('throttle_group_restart_tgm')
      && String(pendingCap.barrierObservability).includes('blk_drain')
      && String(lock.pendingIo.barrierObservability).includes('throttle_group_restart_tgm')
      && String(lock.pendingIo.barrierObservability).includes('virtio_blk_data_plane_stop'),
      JSON.stringify({ runtime: String(pendingCap.barrierObservability).slice(0, 90) }));

    evidence.contract = { frameKeys: sortedKeys(cold.frameBoundary), pendingKeys: sortedKeys(cold.pendingIo),
      requestKeys: sortedKeys(a1.pendingIo.blockRequests[0] ?? {}), frameBoundary: a1.frameBoundary,
      pendingCapability: pendingCap, stopBarrier: barrier };
  } finally {
    try { await qmp.command('quit'); } catch { /* quit 会关闭连接，属预期 */ }
    qmp.close();
    serialSocket.destroy();
    await sleep(300);
    if (!procExit) proc.kill('SIGTERM');
    await sleep(300);
    if (!procExit && proc.exitCode === null) proc.kill('SIGKILL');
  }

  evidence.checks = results;
  evidence.summary = `${results.filter((item) => item.ok).length}/${results.length}`;
  evidence.serialTail = serialText.slice(-1200);
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过，失败 ${failed.length} 项`);
  console.log(`证据：${path.relative(ROOT, EVIDENCE)}`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  - ${item.id}: ${item.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
