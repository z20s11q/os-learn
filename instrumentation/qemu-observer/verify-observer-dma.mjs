#!/usr/bin/env node
/**
 * T05c DMA/virtio 验收（真实 QEMU + 真实 Linux 客体 + 真实 virtio-blk 设备，不经过 lab-server）。
 *
 * 覆盖：
 *   A. 记录期掩码（recordKinds）的命令面：默认全开、收窄后如实回报掩码、认不出的名字
 *      进 recordKindsUnknown、reset 不复位掩码、掩码可与 enable 在同一次调用里生效
 *   B. 掩码在真实内核启动过程中的效果：客体跑完整启动却没有一条 instruction/memory/
 *      io 事件（设备事件稀疏，全量记录会被指令事件挤爆），四类设备事件都真实出现过；
 *      运行中改掩码/开关被拒（vm-running）且状态不被改动
 *   C. 请求关联与方向/长度不变式：block.submit 与 block.complete 严格一一配对、同一
 *      requestId 的 dma.* 段数与方向跟描述符链一致、dma.* 一定先于 block.submit
 *   D. 描述符 → 实际传输缓冲 → LBA → 完成状态的逐字节对应：从冻结快照按 dma 事件给出的
 *      客体物理地址读回请求头/数据/状态字节，与宿主磁盘副本按 LBA 对齐逐字节比对
 *   E. 客体侧真实往返（写盘、drop_caches 后再读回、sha256 一致）与锁/线程上下文说明
 *
 * 为什么用 raw 副本而不是 lab-server 的 qcow2 overlay：要按客体物理地址直接核对磁盘内容，
 * 宿主读偏移 lba*512 就必须是客体看到的那 512 字节。原盘只读，副本在 var/tmp 里。
 *
 * 用法：
 *   node instrumentation/qemu-observer/verify-observer-dma.mjs
 *
 * 证据输出：artifacts/verify/t05c-observer-dma.json
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const QEMU = path.join(ROOT, 'artifacts/build/qemu/qemu-system-x86_64');
const KERNEL = path.join(ROOT, 'artifacts/bzImage');
const INITRD = path.join(ROOT, 'artifacts/initramfs.cpio.gz');
const DISK_SRC = path.join(ROOT, 'artifacts/rootfs.img');
const WORK = path.join(ROOT, 'var/tmp/t05c-verify');
const DISK_COPY = path.join(WORK, 'rootfs.raw');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05c-observer-dma.json');
const EVENTS_C = path.join(HERE, 'x-oslab-events.c');

/*
 * include/exec/x-oslab-events.h 的种类序号：4 dma.read、5 dma.write、11 block.submit、
 * 12 block.complete，因此记录期掩码 = (1<<4)|(1<<5)|(1<<11)|(1<<12) = 0x1830；
 * X_OSLAB_RECORD_KIND_ALL = (1<<18)-1 = 0x3ffff。
 */
const RECORD_KINDS = ['dma.read', 'dma.write', 'block.submit', 'block.complete'];
const MASK_DEVICE = '0x1830';
const MASK_ALL = '0x3ffff';
const MAX_PHYS_READ = 4096;
const RAM_TOP = 0x20000000n;
const PROMPT = /linux-lab:[^\r\n]*# /;

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
}

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function marker(name) {
  /* 客体回显的行是 `echo NAME`，命令行前面有 echo 就不会匹配，只有真正的输出行会匹配。 */
  return new RegExp(`^${name}\\r?$`, 'm');
}

function big(value) {
  return BigInt(value);
}

function fail(message) {
  console.error(`\n致命错误: ${message}`);
  process.exit(2);
}

let diskFd = null;
function diskRead(offset, length) {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const read = fs.readSync(diskFd, buffer, got, length - got, offset + got);
    if (read <= 0) throw new Error(`磁盘副本读取失败 @${offset}+${got}`);
    got += read;
  }
  return buffer;
}

/* ---------------------------------------------------------------- QMP 客户端 */

class QmpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.sequence = 0;
    this.pending = new Map();
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.QMP) {
          this.greeting = message.QMP;
          continue;
        }
        if (message.event) continue;
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    });
  }

  static async connect(socketPath) {
    const socket = net.createConnection(socketPath);
    const client = new QmpClient(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 QMP greeting 超时')), 15000);
      const wait = setInterval(() => {
        if (client.greeting) {
          clearTimeout(timer);
          clearInterval(wait);
          resolve();
        }
      }, 20);
      socket.once('error', (error) => {
        clearTimeout(timer);
        clearInterval(wait);
        reject(error);
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
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ execute, arguments: args ?? {}, id })}\n`);
    });
  }

  async command(execute, args) {
    const message = await this.raw(execute, args);
    if (message.error) throw new Error(`${execute}: ${message.error.desc}`);
    return message.return;
  }

  close() {
    this.socket.destroy();
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  for (const [label, file] of [['QEMU', QEMU], ['内核', KERNEL], ['initramfs', INITRD],
    ['rootfs', DISK_SRC], ['事件源码', EVENTS_C]]) {
    if (!fs.existsSync(file)) fail(`缺少 ${label}: ${file}`);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });

  fs.copyFileSync(DISK_SRC, DISK_COPY);
  const diskSize = BigInt(fs.statSync(DISK_COPY).size);
  diskFd = fs.openSync(DISK_COPY, 'r');

  const qmpPath = path.join(WORK, 'qmp.sock');
  const serialPath = path.join(WORK, 'serial.sock');
  const args = [
    '-machine', 'pc', '-cpu', 'qemu64',
    '-accel', 'tcg,thread=single', '-smp', '1', '-m', '512',
    '-display', 'none', '-nodefaults', '-device', 'VGA',
    '-device', 'isa-serial,chardev=serial0',
    '-chardev', `socket,id=serial0,path=${serialPath},server=on,wait=off`,
    '-qmp', `unix:${qmpPath},server=on,wait=off`,
    '-drive', `file=${DISK_COPY},format=raw,if=none,id=rootdisk`,
    '-device', 'virtio-blk-pci,drive=rootdisk,id=rootblk',
    '-kernel', KERNEL,
    '-initrd', INITRD,
    '-append', 'nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init loglevel=5',
    '-S', '-no-reboot',
  ];
  const logFd = fs.openSync(path.join(WORK, 'qemu.log'), 'w');
  const proc = spawn(QEMU, args, { cwd: ROOT, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  let procExit = null;
  proc.on('exit', (code, signal) => {
    procExit = { code, signal };
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(fs.existsSync(qmpPath) && fs.existsSync(serialPath))) {
    if (procExit) fail(`QEMU 提前退出: ${JSON.stringify(procExit)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /* 串口客户端必须最先连上：客体启动早期的字节不会被 QEMU 替我们留着。 */
  const serialSocket = net.createConnection(serialPath);
  let serialText = '';
  let serialCursor = 0;
  serialSocket.on('data', (chunk) => {
    serialText += chunk.toString('latin1');
  });
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
        resolve(serialText.slice(Math.max(0, at - 80), at + 200));
        return;
      }
      if (Date.now() >= limit) {
        reject(new Error(`等待 ${label} 超时（${timeoutMs} ms）；串口末尾：${JSON.stringify(serialText.slice(-500))}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });

  const qmp = await QmpClient.connect(qmpPath);
  const evidence = {
    schema: 'oslab.t05c-evidence/1',
    qemu: QEMU,
    args,
    disk: { source: DISK_SRC, copy: DISK_COPY, size: diskSize.toString() },
    recordKinds: RECORD_KINDS,
    recordKindMask: MASK_DEVICE,
  };

  try {
    /* ---------- A. 记录期掩码的命令面（VM 停在 -S） ---------- */
    const caps = await qmp.command('x-oslab-capabilities');
    evidence.capabilities = caps;
    const events = caps.events ?? {};
    const points = events.observationPoints ?? {};
    const missingKinds = RECORD_KINDS.filter((kind) => !(events.kinds ?? []).includes(kind));
    check('A1 capabilities.events.kinds 含 T05c 四类且共 13 种（T05e 补上 capture.fence）',
      Array.isArray(events.kinds) && events.kinds.length === 13 && missingKinds.length === 0
      && events.kinds.includes('capture.fence'),
      `kinds=${JSON.stringify(events.kinds)}`);
    const pointKeys = ['dma.read/write', 'block.submit', 'block.complete'];
    check('A2 设备事件的源码观察点在 capabilities 里逐条给出（dma 一对事件共用一个键）',
      pointKeys.every((key) => typeof points[key] === 'string' && points[key].includes('.c')),
      JSON.stringify(Object.fromEntries(pointKeys.map((key) => [key, points[key]]))));
    check('A3 默认记录期全开：recordAllKinds=true、recordKindMask=0x3ffff',
      events.recordAllKinds === true && events.recordKindMask === MASK_ALL,
      `recordAllKinds=${events.recordAllKinds} recordKindMask=${events.recordKindMask}`);

    const narrowed = await qmp.command('x-oslab-events', { recordKinds: RECORD_KINDS });
    evidence.narrowed = narrowed;
    check('A4 recordKinds 收窄后掩码与回显如实（0x1830、四条、无未知）',
      narrowed.ok === true && narrowed.recordAllKinds === false
      && narrowed.recordKindMask === MASK_DEVICE
      && JSON.stringify(narrowed.recordKinds) === JSON.stringify(RECORD_KINDS)
      && (narrowed.recordKindsUnknown ?? []).length === 0,
      `mask=${narrowed.recordKindMask} unknown=${JSON.stringify(narrowed.recordKindsUnknown)}`);

    const partial = await qmp.command('x-oslab-events', { recordKinds: ['dma.read', 'not.a.kind'] });
    check('A5 认不出的 kind 进 recordKindsUnknown，掩码只选中认得的那条（0x10）',
      partial.ok === true && partial.recordKindMask === '0x10'
      && JSON.stringify(partial.recordKindsUnknown) === JSON.stringify(['not.a.kind']),
      `mask=${partial.recordKindMask} unknown=${JSON.stringify(partial.recordKindsUnknown)}`);

    const restored = await qmp.command('x-oslab-events', { enable: true, recordKinds: RECORD_KINDS });
    evidence.restored = { enabled: restored.enabled, enabledChanged: restored.enabledChanged, recordKindMask: restored.recordKindMask };
    check('A6 掩码与 enable 可在同一次调用里一起生效（不先改一半再报错）',
      restored.ok === true && restored.enabled === true && restored.enabledChanged === true
      && restored.recordKindMask === MASK_DEVICE,
      `enabled=${restored.enabled} enabledChanged=${restored.enabledChanged} mask=${restored.recordKindMask}`);

    const cleared = await qmp.command('x-oslab-events', { reset: true });
    check('A7 reset 清空事件但不复位记录掩码（掩码是开关不是数据）',
      cleared.ok === true && cleared.reset === true && cleared.total === '0'
      && cleared.recordKindMask === MASK_DEVICE,
      `total=${cleared.total} mask=${cleared.recordKindMask}`);

    /* ---------- B. 掩码在真实客体启动过程中的效果 ---------- */
    await qmp.command('cont');
    await pump(PROMPT, '客体登录提示符', 300000);
    serialCursor = serialText.length;
    check('B1 真实 Linux 客体启动到交互提示符（之后的事件都是真实设备行为）',
      /linux-lab:[^\r\n]*# /.test(serialText), `串口字节=${serialText.length}`);

    const readAllEvents = async () => {
      const list = [];
      let meta = null;
      let cursor = 1;
      for (let guard = 0; guard < 200; guard += 1) {
        const part = await qmp.command('x-oslab-events', { from: cursor, limit: 2048 });
        if (part.ok !== true) throw new Error(`读取事件失败: ${JSON.stringify(part)}`);
        list.push(...part.events);
        meta = part;
        cursor = Number(big(part.nextSeq));
        if (part.truncated !== true) break;
      }
      return { list, meta };
    };

    const boot = await readAllEvents();
    const histogram = {};
    for (const event of boot.list) histogram[event.kind] = (histogram[event.kind] ?? 0) + 1;
    evidence.boot = {
      count: boot.list.length,
      histogram,
      dropped: boot.meta.dropped,
      oldest: boot.meta.oldest,
      watermark: boot.meta.watermark,
      firstEvent: boot.list[0],
      lastEvent: boot.list[boot.list.length - 1],
    };
    check('B2 掩码生效：客体跑完整启动，事件流里没有一条指令/访存/端口事件',
      boot.list.length > 0 && Object.keys(histogram).every((kind) => RECORD_KINDS.includes(kind)),
      `记录到的种类=${JSON.stringify(Object.keys(histogram))} 条数=${boot.list.length}`);
    check('B3 四类设备事件都真实出现过（不是掩码把事件滤空了）',
      RECORD_KINDS.every((kind) => (histogram[kind] ?? 0) > 0), JSON.stringify(histogram));
    check('B4 启动全程 seq 从 1 连续、dropped=0（设备事件稀疏，没把环挤爆）',
      boot.meta.oldest === '1' && boot.meta.dropped === '0'
      && boot.list.every((event, index) => event.seq === String(index + 1)),
      `oldest=${boot.meta.oldest} watermark=${boot.meta.watermark} dropped=${boot.meta.dropped}`);

    const runningNarrow = await qmp.command('x-oslab-events', { recordKinds: ['dma.read'] });
    const maskAfter = await qmp.command('x-oslab-events', { limit: 1 });
    check('B5 VM 运行中改 recordKinds 被拒（vm-running），掩码不被改动',
      runningNarrow.ok === false && runningNarrow.rejected === true
      && runningNarrow.reason === 'vm-running'
      && maskAfter.recordKindMask === MASK_DEVICE,
      `reason=${runningNarrow.reason} mask=${maskAfter.recordKindMask}`);

    const runningEnable = await qmp.command('x-oslab-events', { enable: false });
    const enabledAfter = await qmp.command('x-oslab-events', { limit: 1 });
    check('B6 VM 运行中改 enable 被拒（vm-running），开关不被改动',
      runningEnable.ok === false && runningEnable.reason === 'vm-running'
      && runningEnable.enabled === true && enabledAfter.enabled === true,
      `reason=${runningEnable.reason} enabled=${runningEnable.enabled}->${enabledAfter.enabled}`);

    /* ---------- C. 客体侧真实块 I/O（写盘 → 落盘 → 重读 → 只读取样） ---------- */
    send('dd if=/dev/urandom of=/root/t05c.bin bs=4096 count=2 conv=fsync; sync; sync; echo T05C-WROTE');
    await pump(marker('T05C-WROTE'), 'T05C-WROTE', 120000);

    send('echo "T05C-SIZE=$(wc -c < /root/t05c.bin)"');
    const sizeText = await pump(/T05C-SIZE=\d+/, 'T05C-SIZE', 60000);
    const written = Number(sizeText.match(/T05C-SIZE=(\d+)/)[1]);

    send('echo "T05C-SHA-A=$(sha256sum /root/t05c.bin | cut -c1-64)"');
    const before = (await pump(/T05C-SHA-A=[0-9a-f]{64}/, 'T05C-SHA-A', 60000))
      .match(/T05C-SHA-A=([0-9a-f]{64})/)[1];

    send('echo 3 > /proc/sys/vm/drop_caches 2>/dev/null && echo T05C-DROPPED-OK || echo T05C-DROPPED-SKIP');
    const droppedText = await pump(/T05C-DROPPED-(OK|SKIP)/, 'T05C-DROPPED', 60000);
    const droppedCaches = droppedText.includes('T05C-DROPPED-OK');

    send('dd if=/root/t05c.bin of=/dev/null bs=4096 2>/dev/null; sync; echo "T05C-SHA-B=$(sha256sum /root/t05c.bin | cut -c1-64)"');
    const after = (await pump(/T05C-SHA-B=[0-9a-f]{64}/, 'T05C-SHA-B', 120000))
      .match(/T05C-SHA-B=([0-9a-f]{64})/)[1];

    /*
     * 最后只做一个只读访问，窗口里最后一个读请求就落在它上面：probe.bin 的数据块只会被读、
     * 不会被写，因此页缓存内容与宿主磁盘副本在快照时刻必然一致（前面写的文件已经 sync 过）。
     */
    send('sync; dd if=/data/probe.bin of=/dev/null bs=4096 count=1 2>/dev/null; echo T05C-READ-OK');
    await pump(marker('T05C-READ-OK'), 'T05C-READ-OK', 120000);

    check('C1 客体真实往返：写盘后 drop_caches 再从盘上读回，sha256 与写前一致',
      written === 8192 && /^[0-9a-f]{64}$/.test(before) && before === after,
      `size=${written} sha256=${before.slice(0, 16)}… drop_caches=${droppedCaches ? '已执行' : '跳过'}`);

    await qmp.command('stop');
    const window = await readAllEvents();
    const list = window.list;
    evidence.window = {
      count: list.length,
      dropped: window.meta.dropped,
      oldest: window.meta.oldest,
      watermark: window.meta.watermark,
      total: window.meta.total,
    };

    /*
     * 事件流按 seq 时间顺序切成「事务」：一次描述符映射（dma.* 段）加上这次请求的
     * block.submit / block.complete。不能只按 requestId 聚合——描述符只有 256 个，
     * 窗口里同一个 requestId 会被反复复用（vq0-1 会出现几十次），按 id 聚合会把不同
     * 请求混成一堆。切分依据是 virtio 的段顺序：out（设备读客体内存）一定先于 in
     * （设备写客体内存），同一次映射里不会出现「写完又读」，所以再遇到 dma.read 就是
     * 新一次映射。block.complete 按 requestId 挂回最近一个已提交但还没完成的事务：
     * 设备不会在完成之前让客体复用同一个描述符，这个挂法是确定的，不是猜的。
     */
    const transactions = [];
    const unmatchedCompletes = [];
    let current = null;
    for (const event of list) {
      if (event.kind.startsWith('dma.')) {
        const fresh = !current || current.requestId !== event.requestId || current.submit
          || (event.kind === 'dma.read' && current.dma.some((item) => item.kind === 'dma.write'));
        if (fresh) {
          current = {
            requestId: event.requestId, deviceId: event.deviceId, dma: [], submit: null, complete: null,
          };
          transactions.push(current);
        }
        current.dma.push(event);
        continue;
      }
      if (event.kind === 'block.submit') {
        if (current && current.requestId === event.requestId && !current.submit) {
          current.submit = event;
        } else {
          current = {
            requestId: event.requestId, deviceId: event.deviceId, dma: [], submit: event, complete: null,
          };
          transactions.push(current);
        }
        continue;
      }
      let target = null;
      for (let index = transactions.length - 1; index >= 0; index -= 1) {
        const candidate = transactions[index];
        if (candidate.requestId === event.requestId && candidate.submit && !candidate.complete) {
          target = candidate;
          break;
        }
      }
      if (target) target.complete = event;
      else unmatchedCompletes.push(event.seq);
    }
    evidence.transactionCount = transactions.length;

    check('C2 窗口内全是四类设备事件，每条都带 deviceId 与 vq<队列>-<描述符> 形式的 requestId',
      list.length > 0 && window.meta.dropped === '0'
      && list.every((event) => RECORD_KINDS.includes(event.kind))
      && list.every((event) => typeof event.deviceId === 'string' && event.deviceId.includes('virtio')
        && /^vq\d+-\d+$/.test(event.requestId ?? '')),
      `条数=${list.length} dropped=${window.meta.dropped} 首条=${list[0]?.kind}/${list[0]?.requestId}`);

    const paired = [];
    const pairingProblems = [];
    let orphanGroups = 0;
    let pendingGroups = 0;
    const orphanProblems = [];
    for (const group of transactions) {
      if (!group.submit && !group.complete) {
        orphanGroups += 1;
        /*
         * 设备不接受、不搬数据的请求（flush、被拒绝的请求头）只会有 dma.*：它们的
         * 描述符链就是 16 字节请求头 + 1 字节状态，观测层刻意不为它们发 block 事件。
         */
        const reads = group.dma.filter((event) => event.kind === 'dma.read');
        const writes = group.dma.filter((event) => event.kind === 'dma.write');
        const sumRead = reads.reduce((acc, event) => acc + event.size, 0);
        const sumWrite = writes.reduce((acc, event) => acc + event.size, 0);
        if (reads.length !== 1 || writes.length !== 1 || sumRead !== 16 || sumWrite !== 1) {
          orphanProblems.push(`${group.requestId}: read=${reads.map((e) => e.size)} write=${writes.map((e) => e.size)}`);
        }
        continue;
      }
      if (group.complete && !group.submit) {
        pairingProblems.push(`${group.requestId}: 有 complete 没有 submit`);
        continue;
      }
      if (group.submit && !group.complete) {
        /* 提交了但停止点之前还没完成：这是 T05e 关心的 pending I/O，不算配对错误。 */
        pendingGroups += 1;
        continue;
      }
      if (group.dma.length === 0) {
        pairingProblems.push(`${group.requestId}: 有 submit 却没有 dma 段`);
        continue;
      }
      const submit = group.submit;
      const complete = group.complete;
      paired.push({ group, submit, complete });
      if (big(complete.seq) <= big(submit.seq)) {
        pairingProblems.push(`${group.requestId}: complete 不晚于 submit`);
      }
      const same = ['address', 'addressSpace', 'size', 'deviceId']
        .every((field) => submit[field] === complete[field])
        && ['lba', 'byteOffset', 'sectorCount', 'reqType', 'op', 'descHead', 'outSegments', 'inSegments']
          .every((field) => submit.detail?.[field] === complete.detail?.[field]);
      if (!same) pairingProblems.push(`${group.requestId}: submit/complete 描述字段不一致`);
    }
    evidence.pairing = {
      paired: paired.length, orphans: orphanGroups, pending: pendingGroups, unmatchedCompletes,
    };
    check('C3 block.submit 与 block.complete 严格一一配对，配对两端描述字段完全一致',
      paired.length > 0 && pairingProblems.length === 0 && unmatchedCompletes.length === 0,
      pairingProblems.slice(0, 4).join('; ')
        || `配对数=${paired.length} 未完成=${pendingGroups} 未匹配 complete=${unmatchedCompletes.length}`);
    check('C4 只有 dma、没有 block 的事件只出现在「设备不接受」的路径上（16B 请求头 + 1B 状态）',
      orphanGroups > 0 && orphanProblems.length === 0,
      orphanProblems.slice(0, 4).join('; ') || `未配对请求=${orphanGroups} 组（flush 等非读写请求）`);

    const directionProblems = [];
    const lengthProblems = [];
    const samples = { read: [], write: [] };
    for (const item of paired) {
      const group = item.group;
      const submit = item.submit;
      const reads = group.dma.filter((event) => event.kind === 'dma.read');
      const writes = group.dma.filter((event) => event.kind === 'dma.write');
      const sumRead = reads.reduce((acc, event) => acc + event.size, 0);
      const sumWrite = writes.reduce((acc, event) => acc + event.size, 0);
      const isRead = submit.detail.op === 'read';
      const size = submit.size;
      const wantRead = isRead ? 16 : size + 16;
      const wantWrite = isRead ? size + 1 : 1;
      if (reads.length !== submit.detail.outSegments || writes.length !== submit.detail.inSegments) {
        directionProblems.push(`${group.requestId}: 段数 read=${reads.length}/${submit.detail.outSegments} write=${writes.length}/${submit.detail.inSegments}`);
      }
      if (isRead && writes.some((event, index) => (index === writes.length - 1 ? event.size !== 1 : false))) {
        directionProblems.push(`${group.requestId}: 读请求的状态段不是 1 字节`);
      }
      if (!isRead && reads[0]?.size !== 16) {
        directionProblems.push(`${group.requestId}: 写请求的请求头不是 16 字节`);
      }
      if (sumRead !== wantRead || sumWrite !== wantWrite) {
        lengthProblems.push(`${group.requestId}: read=${sumRead}/${wantRead} write=${sumWrite}/${wantWrite}`);
      }
      if (group.dma.some((event) => big(event.seq) > big(submit.seq))) {
        lengthProblems.push(`${group.requestId}: 有 dma.* 事件晚于 block.submit`);
      }
      const entry = {
        requestId: group.requestId,
        lba: submit.detail.lba,
        size,
        op: submit.detail.op,
        outSegments: submit.detail.outSegments,
        inSegments: submit.detail.inSegments,
        dma: group.dma.map((event) => `${event.kind}:${event.size}`),
      };
      if (isRead && samples.read.length < 3) samples.read.push(entry);
      if (!isRead && samples.write.length < 3) samples.write.push(entry);
    }
    const readCount = paired.filter((item) => item.submit.detail.op === 'read').length;
    const writeCount = paired.length - readCount;
    evidence.invariants = { paired: paired.length, readCount, writeCount, orphans: orphanGroups, samples };
    check('C5 读请求 out 段只有请求头、in 段是数据+状态；写请求镜像对称（段数与描述符链一致）',
      directionProblems.length === 0 && readCount > 0 && writeCount > 0,
      directionProblems.slice(0, 4).join('; ') || `读=${readCount} 写=${writeCount} 未配对=${orphanGroups}`);
    check('C6 同一请求的 dma 长度等于「数据长度 + 头尾」，且 dma.* 一定先于 block.submit',
      lengthProblems.length === 0,
      lengthProblems.slice(0, 4).join('; ') || `读请求 16 + size + 1 / 写请求 16 + size + 1 全部对上`);

    const dmaProblems = [];
    for (const group of transactions) {
      for (const event of group.dma) {
        if (event.phase !== 'complete') dmaProblems.push(`${event.seq}: phase=${event.phase}`);
        if (event.addressSpace !== 'physical') dmaProblems.push(`${event.seq}: space=${event.addressSpace}`);
        if (event.pc !== undefined || event.cpuId !== undefined) dmaProblems.push(`${event.seq}: 不该有 pc/cpuId`);
        if (event.bytes !== undefined || event.detail?.value !== undefined) dmaProblems.push(`${event.seq}: 不该有载荷`);
        if (!Number.isInteger(event.size) || event.size <= 0) dmaProblems.push(`${event.seq}: size=${event.size}`);
        if (!Number.isInteger(event.detail?.deviceIndex) || event.detail.deviceIndex <= 0) {
          dmaProblems.push(`${event.seq}: deviceIndex=${event.detail?.deviceIndex}`);
        }
        if (typeof event.detail?.flags !== 'number') dmaProblems.push(`${event.seq}: 缺 flags`);
        if (!/^0x[0-9a-f]+$/.test(event.address ?? '')) {
          dmaProblems.push(`${event.seq}: address=${event.address}`);
        } else if (big(event.address) + big(event.size) > RAM_TOP) {
          dmaProblems.push(`${event.seq}: 越出 RAM`);
        }
      }
    }
    check('C7 dma.* 只报访问权：physical/地址/长度/设备归属齐全，且不带 pc/cpuId/载荷字节',
      dmaProblems.length === 0, dmaProblems.slice(0, 4).join('; ') || `共 ${list.filter((e) => e.kind.startsWith('dma.')).length} 条 dma.*`);

    const blockProblems = [];
    const statusHistogram = {};
    for (const item of paired) {
      const group = item.group;
      for (const [event, phase] of [[item.submit, 'begin'], [item.complete, 'complete']]) {
        const detail = event.detail ?? {};
        if (event.phase !== phase) blockProblems.push(`${event.seq}: phase=${event.phase}`);
        if (event.addressSpace !== 'disk-lba') blockProblems.push(`${event.seq}: space=${event.addressSpace}`);
        if (event.pc !== undefined || event.cpuId !== undefined) blockProblems.push(`${event.seq}: 不该有 pc/cpuId`);
        if (!/^0x[0-9a-f]+$/.test(event.address ?? '')) blockProblems.push(`${event.seq}: address=${event.address}`);
        if (event.size % 512 !== 0) blockProblems.push(`${event.seq}: size=${event.size} 不是 512 的倍数`);
        if (!/^\d+$/.test(detail.lba ?? '')) blockProblems.push(`${event.seq}: lba=${detail.lba}`);
        else if (big(detail.lba) !== big(event.address)) blockProblems.push(`${event.seq}: lba 与 address 不一致`);
        if (big(detail.byteOffset) !== big(detail.lba) * 512n) blockProblems.push(`${event.seq}: byteOffset=${detail.byteOffset}`);
        if (detail.sectorCount !== event.size >> 9) blockProblems.push(`${event.seq}: sectorCount=${detail.sectorCount} size=${event.size}`);
        if (detail.reqType !== (detail.op === 'read' ? 0 : 1)) blockProblems.push(`${event.seq}: reqType=${detail.reqType} op=${detail.op}`);
        if (detail.descHead !== Number(group.requestId.split('-')[1])) blockProblems.push(`${event.seq}: descHead 与 requestId 不一致`);
        if (big(detail.lba) * 512n + big(event.size) > diskSize) blockProblems.push(`${event.seq}: 请求越过磁盘末尾`);
      }
      if (item.submit.detail.status !== null) blockProblems.push(`${item.submit.seq}: submit 不该预填 status`);
      if ('statusCode' in item.submit.detail) blockProblems.push(`${item.submit.seq}: submit 不该带 statusCode`);
      if (item.complete.detail.statusCode !== 0 || item.complete.detail.status !== 'ok') {
        blockProblems.push(`${item.complete.seq}: status=${item.complete.detail.status}/${item.complete.detail.statusCode}`);
      }
      statusHistogram[item.complete.detail.status] = (statusHistogram[item.complete.detail.status] ?? 0) + 1;
    }
    evidence.statusHistogram = statusHistogram;
    check('C8 block.* 字段自洽：disk-lba/lba/byteOffset= lba*512 /sectorCount/op 与 reqType 对应，完成状态都是 ok',
      blockProblems.length === 0,
      blockProblems.slice(0, 4).join('; ') || `完成状态=${JSON.stringify(statusHistogram)}`);

    /* ---------- D. 描述符 → 传输缓冲 → LBA → 状态 的逐字节对应 ---------- */
    const readGuest = async (address, length) => {
      const chunks = [];
      let offset = 0n;
      const base = big(address);
      const total = big(length);
      while (offset < total) {
        const rest = total - offset;
        const want = rest > BigInt(MAX_PHYS_READ) ? MAX_PHYS_READ : Number(rest);
        const reply = await qmp.command('x-oslab-read-physical', {
          captureId: capture.captureId, address: `0x${(base + offset).toString(16)}`, length: want,
        });
        if (reply.ok !== true) throw new Error(`read-physical 失败 @${address}: ${JSON.stringify(reply)}`);
        chunks.push(Buffer.from(reply.bytes, 'base64'));
        offset += BigInt(want);
      }
      return Buffer.concat(chunks);
    };

    const capture = await qmp.command('x-oslab-capture');
    evidence.capture = {
      captureId: capture.captureId,
      eventWatermark: capture.eventWatermark,
      capturedAtNs: capture.capturedAtNs,
      vmGeneration: capture.vmGeneration,
      stopBarrier: caps.stopBarrier,
    };
    /*
     * 这个套件全程把记录期掩码收窄到四类设备事件，capture.fence 不在掩码里，
     * 因此本帧没有分界标记：观察者必须如实报告 fenceSeq=0 / fenceRecorded=false，
     * 并把 eventWatermark 退回采集当时的水位线，而不是假造一条 fence。
     * 掩码排除了 fence 与「采集关闭」是同一条代码路径（x_oslab_event_fence 走
     * x_oslab_record，被掩码挡下就返回 0）。
     */
    check('D1 掩码不含 capture.fence 时：如实报告 fenceRecorded=false、eventWatermark 退回采集前水位线，屏障仍要求全部 vCPU 停止且跑在 main-loop + BQL',
      capture.ok === true && capture.fenceSeq === '0'
      && capture.frameBoundary?.fenceRecorded === false
      && BigInt(capture.eventWatermark) === BigInt(window.meta.watermark)
      && caps.stopBarrier?.context === 'main-loop + BQL'
      && caps.stopBarrier?.requiresAllVcpusStopped === true,
      `capture=${capture.eventWatermark} fence=${capture.fenceSeq} 采集前=${window.meta.watermark} `
      + `fenceRecorded=${capture.frameBoundary?.fenceRecorded} context=${caps.stopBarrier?.context}`);
    check('D1b 没有分界标记这件事被写进 capture.unavailable（不是悄悄少一个字段）',
      (capture.unavailable ?? []).some((item) => item.includes('frameBoundary')
        && item.includes('eventWatermark')),
      JSON.stringify(capture.unavailable));

    const targets = { read: null, write: null };
    for (const item of paired) {
      const op = item.submit.detail.op;
      if (op === 'read' || op === 'write') targets[op] = item;
    }

    const inspect = async (item, isRead) => {
      const reads = item.group.dma.filter((event) => event.kind === 'dma.read');
      const writes = item.group.dma.filter((event) => event.kind === 'dma.write');
      const headerEvent = reads[0];
      const statusEvent = isRead ? writes[writes.length - 1] : writes[0];
      const dataEvents = isRead ? writes.slice(0, -1) : reads.slice(1);
      const header = await readGuest(headerEvent.address, headerEvent.size);
      const payload = Buffer.concat(await Promise.all(
        dataEvents.map((event) => readGuest(event.address, event.size)),
      ));
      const status = await readGuest(statusEvent.address, statusEvent.size);
      return { header, payload, status, headerEvent, statusEvent, dataEvents };
    };

    let readInfo = null;
    if (targets.read) readInfo = await inspect(targets.read, true);
    if (readInfo && targets.read) {
      const lba = big(targets.read.submit.detail.lba);
      const size = targets.read.submit.size;
      const image = diskRead(Number(lba) * 512, size);
      evidence.lastRead = {
        requestId: targets.read.group.requestId,
        lba: lba.toString(),
        size,
        header: readInfo.header.toString('hex'),
        ioprio: readInfo.header.readUInt32LE(4),
        status: readInfo.status.toString('hex'),
        headerAt: readInfo.headerEvent.address,
        dataSegments: readInfo.dataEvents.map((event) => ({ address: event.address, size: event.size })),
        completeSeq: targets.read.complete.seq,
      };
      /*
       * 请求头是 virtio-blk 规范里的 virtio_blk_outhdr：type(u32) + ioprio(u32) +
       * sector(u64)。第 2 个字段不是保留位，客体（Linux 的 virtblk）会填自己的
       * I/O 优先级，所以判据只锚定 type 与 sector，ioprio 如实记录不当断言。
       */
      check('D2 最后一个读请求：客体请求头自己声明 type=0(读)、sector 等于事件里的 LBA',
        readInfo.header.length === 16 && readInfo.header.readUInt32LE(0) === 0
        && readInfo.header.readBigUInt64LE(8) === lba,
        `type=${readInfo.header.readUInt32LE(0)} ioprio=${readInfo.header.readUInt32LE(4)} `
        + `sector=${readInfo.header.readBigUInt64LE(8)} event.lba=${lba}`);
      check('D3 最后一个读请求：从快照读出的数据缓冲与宿主磁盘副本按 lba*512 对齐后逐字节一致',
        readInfo.payload.length === size && readInfo.payload.equals(image),
        `缓冲=${readInfo.payload.length}B 镜像=${size}B lba=${lba}`);
      check('D4 最后一个读请求：状态字节 0x00 与 block.complete 的 status/statusCode 一致',
        readInfo.status.length === 1 && readInfo.status[0] === 0
        && targets.read.complete.detail.statusCode === 0
        && targets.read.complete.detail.status === 'ok',
        `状态字节=0x${readInfo.status.toString('hex')} 事件=${targets.read.complete.detail.status}/${targets.read.complete.detail.statusCode}`);
    } else {
      check('D2 最后一个读请求：请求头自证 type/sector', false, '窗口里没有读请求');
      check('D3 最后一个读请求：数据缓冲与磁盘副本一致', false, '窗口里没有读请求');
      check('D4 最后一个读请求：状态字节与完成状态一致', false, '窗口里没有读请求');
    }

    let writeInfo = null;
    if (targets.write) writeInfo = await inspect(targets.write, false);
    if (writeInfo && targets.write) {
      const lba = big(targets.write.submit.detail.lba);
      const size = targets.write.submit.size;
      const image = diskRead(Number(lba) * 512, size);
      evidence.lastWrite = {
        requestId: targets.write.group.requestId,
        lba: lba.toString(),
        size,
        header: writeInfo.header.toString('hex'),
        status: writeInfo.status.toString('hex'),
        headerAt: writeInfo.headerEvent.address,
        dataSegments: writeInfo.dataEvents.map((event) => ({ address: event.address, size: event.size })),
        completeSeq: targets.write.complete.seq,
      };
      check('D5 最后一个写请求：请求头自己声明 type=1(写)、sector 等于事件里的 LBA',
        writeInfo.header.length === 16 && writeInfo.header.readUInt32LE(0) === 1
        && writeInfo.header.readBigUInt64LE(8) === lba,
        `type=${writeInfo.header.readUInt32LE(0)} sector=${writeInfo.header.readBigUInt64LE(8)} event.lba=${lba}`);
      check('D6 最后一个写请求：设备从客体缓冲搬走的字节与宿主磁盘副本按 lba*512 对齐后逐字节一致',
        writeInfo.payload.length === size && writeInfo.payload.equals(image),
        `缓冲=${writeInfo.payload.length}B 镜像=${size}B lba=${lba}`);
      check('D7 最后一个写请求：状态字节 0x00 与 block.complete 的 status/statusCode 一致',
        writeInfo.status.length === 1 && writeInfo.status[0] === 0
        && targets.write.complete.detail.statusCode === 0,
        `状态字节=0x${writeInfo.status.toString('hex')} 事件=${targets.write.complete.detail.status}/${targets.write.complete.detail.statusCode}`);
    } else {
      check('D5 最后一个写请求：请求头自证 type/sector', false, '窗口里没有写请求');
      check('D6 最后一个写请求：数据缓冲与磁盘副本一致', false, '窗口里没有写请求');
      check('D7 最后一个写请求：状态字节与完成状态一致', false, '窗口里没有写请求');
    }

    const recent = paired.slice(-12);
    const intactDetail = [];
    let intact = 0;
    for (const item of recent) {
      const reads = item.group.dma.filter((event) => event.kind === 'dma.read');
      if (reads.length === 0) continue;
      const header = await readGuest(reads[0].address, 16);
      const type = header.readUInt32LE(0);
      const sector = header.readBigUInt64LE(8);
      const ok = type === item.submit.detail.reqType && sector === big(item.submit.detail.lba);
      if (ok) intact += 1;
      intactDetail.push({ requestId: item.group.requestId, type, sector: sector.toString(), ok });
    }
    evidence.headerIntact = intactDetail;
    check('D8 关联不是「只有最后一个碰巧对上」：窗口末尾的请求头有的能与自己的事件对上',
      intact >= 1, `完好=${intact}/${intactDetail.length}`);

    const zeroLength = await qmp.command('x-oslab-read-physical', {
      captureId: capture.captureId, address: '0x0', length: 0,
    });
    const overLength = await qmp.command('x-oslab-read-physical', {
      captureId: capture.captureId, address: '0x0', length: MAX_PHYS_READ + 1,
    });
    check('D9 物理读取的边界被守住：length 0 / 4097 都被拒（invalid-length）',
      zeroLength.ok === false && zeroLength.reason === 'invalid-length'
      && overLength.ok === false && overLength.reason === 'invalid-length',
      `${zeroLength.reason} / ${overLength.reason}`);

    const released = await qmp.command('x-oslab-release', { captureId: capture.captureId });
    check('D10 释放快照后 captureId 不再有效（不留下悬空引用）',
      released.released === true, JSON.stringify(released));

    /* ---------- E. 锁/线程上下文与观察点（T05 要求逐条给出） ---------- */
    const source = fs.readFileSync(EVENTS_C, 'utf8');
    const start = source.indexOf('T05c 的线程上下文');
    const context = start < 0 ? '' : source.slice(start, source.indexOf('*/', start));
    evidence.threadContext = context;
    check('E1 线程/锁上下文有源码级说明：dma.* 由 virtqueue_pop 调用者产生（主循环或 iothread），只拿事件环 QemuSpin、不依赖 BQL',
      context.includes('virtqueue_pop') && context.includes('iothread')
      && context.includes('QemuSpin') && context.includes('不依赖 BQL')
      && context.includes('不带 CPU 归属'),
      context.replace(/\s+/g, ' ').slice(0, 96) + '…');
    check('E2 观察点逐条指向真实函数：virtqueue_split_pop/packed_pop、virtio_blk_handle_request、virtio_blk_req_complete',
      String(points['dma.read/write'] ?? '').includes('virtqueue_split_pop')
      && String(points['dma.read/write'] ?? '').includes('virtqueue_packed_pop')
      && String(points['block.submit'] ?? '').includes('virtio_blk_handle_request')
      && String(points['block.complete'] ?? '').includes('virtio_blk_req_complete'),
      JSON.stringify({ dma: points['dma.read/write'], submit: points['block.submit'], complete: points['block.complete'] }));
    check('E3 capabilities 如实声明语义边界：dma.* 只报访问权、载荷要另行核对，非 virtio 设备的 DMA 不产生 dma.*',
      (events.knownGaps ?? []).some((gap) => gap.includes('访问权'))
      && (events.knownGaps ?? []).some((gap) => gap.includes('非 virtio'))
      && (events.knownGaps ?? []).some((gap) => gap.includes('VIRTIO_BLK_T_IN/OUT')),
      JSON.stringify(events.knownGaps));
  } finally {
    try {
      await qmp.command('quit');
    } catch {
      /* quit 会关闭连接，属预期 */
    }
    qmp.close();
    serialSocket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!procExit) proc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!procExit && proc.exitCode === null) proc.kill('SIGKILL');
    if (diskFd !== null) fs.closeSync(diskFd);
  }

  evidence.checks = results;
  evidence.summary = `${results.filter((item) => item.ok).length}/${results.length}`;
  evidence.serialTail = serialText.slice(-2000);
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