#!/usr/bin/env node
/**
 * T05d 设备快照验收（真实 QEMU + 真实 Linux 客体 + 真实设备，不经过 lab-server）。
 *
 * 覆盖（对应 T05 验收 E04、E08–E10 里的设备面板部分）：
 *   A. 结构与契约：capabilities.devices / capture.devices 的形状、字段类型、Hex 规范、
 *      evidence 三元组、稳定排序、寄存器区间归属
 *   B. 只读性（E10 核心）：面板多次读取不消耗 UART 接收 FIFO、不确认 IRQ、
 *      不推进客体状态；恢复运行后字节仍在设备侧被客体读走
 *   C. VGA：文本模式几何 + 显存 backing store 解码出真实字符网格，且这份内容
 *      既不在串口日志里，也不能用「读一次 0xb8000」拿到（该地址属于有副作用的 MMIO）
 *   D. virtio：队列状态与 QEMU 自带 x-query-virtio-queue-status / x-query-virtio-status
 *      逐字段交叉一致，BAR 分配前后 registerRanges 随真实状态变化
 *   E. 观察点与锁/线程上下文说明（T05 验收要求逐项给出）
 *
 * 用法：
 *   node instrumentation/qemu-observer/verify-observer-devices.mjs
 *
 * 证据输出：artifacts/verify/t05d-observer-devices.json
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
const WORK = path.join(ROOT, 'var/tmp/t05d-verify');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05d-observer-devices.json');
const OBSERVER_C = path.join(HERE, 'x-oslab-observer.c');
const LOCK = path.join(HERE, 'build.lock.json');

/* 与 monitor/x-oslab-observer.c 里 XOslabDeviceRank 的次序一致。 */
const RANKS = ['vga', 'uart', 'i8042', 'pic', 'apic', 'timer',
  'virtio-blk', 'virtio-net', 'other'];
const KINDS = ['vga', 'i8042', 'uart', 'pic', 'apic', 'timer', 'virtio-blk',
  'virtio-net', 'pci', 'other'];
const POINT_KEYS = ['discovery', 'uart', 'i8042', 'pic', 'pit', 'apic', 'vga',
  'virtio', 'threading'];
const EXPECTED_DEVICES = 8;
const HEX_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const PROMPT = /linux-lab:[^\r\n]*# /;
const INJECTED = 'T05D!';
const MARKER = 'VGASNAP-MARKER';
const A0000 = 0xa0000n;
const VGA_LOWMEM_END = 0xc0000n;

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
}

function fail(message) {
  console.error(`\n致命错误: ${message}`);
  process.exit(2);
}

function fieldMap(device) {
  return Object.fromEntries((device?.fields ?? []).map((f) => [f.name, f.value]));
}

function pick(device, names) {
  const map = fieldMap(device);
  return Object.fromEntries(names.map((n) => [n, map[n]]));
}

function hex(value) {
  return value === undefined || value === null ? null : `0x${BigInt(value).toString(16)}`;
}

function byKind(capture, kind) {
  return (capture.devices ?? []).filter((d) => d.kind === kind);
}

/**
 * 去掉「每次采集都会变、但与设备状态无关」的溯源字段，用于逐字段比较。
 * captureId / supersededCaptureId / capturedAtNs 是这次采集的标签，不是被观察对象。
 */
function normalizeCapture(capture) {
  const clone = JSON.parse(JSON.stringify(capture));
  clone.captureId = null;
  clone.supersededCaptureId = null;
  clone.capturedAtNs = null;
  for (const device of clone.devices ?? []) {
    if (device.evidence) device.evidence.captureId = null;
    for (const queue of device.virtqueues ?? []) {
      if (queue.evidence) queue.evidence.captureId = null;
    }
  }
  return clone;
}

/** 把 vramBacking 的十六进制按 cellStride 行宽解成字符网格（非可打印字符显示为 '.'）。 */
function decodeTextGrid(vga) {
  const map = fieldMap(vga);
  const hexText = map.vramBacking ?? '';
  const stride = Number(map.cellStride);
  const cols = Number(map.textCols);
  const rows = Number(map.textRows);
  const lineOffset = Number(map.lineOffset);
  const rowBytes = lineOffset > 0 ? lineOffset : cols * stride;
  const lines = [];

  for (let y = 0; y < rows; y += 1) {
    let line = '';
    for (let x = 0; x < cols; x += 1) {
      const at = (y * rowBytes + x * stride) * 2;
      const code = Number.parseInt(hexText.slice(at, at + 2), 16);
      line += Number.isFinite(code) && code >= 32 && code < 127
        ? String.fromCharCode(code) : '.';
    }
    lines.push(line);
  }
  return { lines, hexLength: hexText.length, stride, cols, rows, rowBytes };
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
      }, 120000);
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
    ['rootfs', DISK_SRC], ['观察者源码', OBSERVER_C], ['构建记录', LOCK]]) {
    if (!fs.existsSync(file)) fail(`缺少 ${label}: ${file}`);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });

  const diskCopy = path.join(WORK, 'rootfs.raw');
  fs.copyFileSync(DISK_SRC, diskCopy);

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
    '-kernel', KERNEL, '-initrd', INITRD,
    '-append', 'nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init loglevel=5',
    '-S', '-no-reboot',
  ];
  const logFd = fs.openSync(path.join(WORK, 'qemu.log'), 'w');
  const proc = spawn(QEMU, args, { cwd: ROOT, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  let procExit = null;
  proc.on('exit', (code, signal) => { procExit = { code, signal }; });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(fs.existsSync(qmpPath) && fs.existsSync(serialPath))) {
    if (procExit) fail(`QEMU 提前退出: ${JSON.stringify(procExit)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /* 串口客户端必须最先连上：客体启动早期的字节不会被 QEMU 替我们留着。 */
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
  const evidence = { schema: 'oslab.t05d-evidence/1', qemu: QEMU, args, marker: MARKER };

  try {
    /* ---------- A. 结构与契约（VM 停在 -S） ---------- */
    const caps = await qmp.command('x-oslab-capabilities');
    const c0 = await qmp.command('x-oslab-capture');
    evidence.capabilities = caps;
    evidence.coldCapture = { deviceCount: c0.deviceCount, unavailable: c0.unavailable };

    const devCap = caps.devices ?? {};
    const points = devCap.observationPoints ?? {};
    check('A1 capabilities.devices 自描述：supported/readOnly/transport + 9 类 kind',
      devCap.supported === true && devCap.readOnly === true
      && devCap.transport === 'x-oslab-capture.devices'
      && Array.isArray(devCap.kinds) && devCap.kinds.length === RANKS.length
      && RANKS.every((kind) => devCap.kinds.includes(kind)),
      JSON.stringify({ supported: devCap.supported, kinds: devCap.kinds }));
    check('A2 capabilities.devices.observationPoints 逐类给出源码观察点',
      POINT_KEYS.every((key) => typeof points[key] === 'string'
        && /\.(c|h)\b/.test(points[key])),
      POINT_KEYS.map((key) => `${key}:${String(points[key] ?? '').slice(0, 24)}`).join(' | '));
    check('A3 设备快照不再是「未实现」：capabilities/capture 的 unavailable 里都没有 T05d 占位',
      !JSON.stringify(caps.unavailable ?? []).includes('deviceSnapshots')
      && !JSON.stringify(c0.unavailable ?? []).includes('deviceSnapshots'),
      JSON.stringify(c0.unavailable));

    check('A4 -S 下枚举到 8 个真实设备：vga/uart/i8042/2×pic/apic/timer/virtio-blk 各就位',
      Array.isArray(c0.devices) && c0.devices.length === EXPECTED_DEVICES
      && c0.deviceCount === c0.devices.length
      && JSON.stringify(c0.devices.map((d) => d.kind))
        === JSON.stringify(['vga', 'uart', 'i8042', 'pic', 'pic', 'apic', 'timer', 'virtio-blk']),
      JSON.stringify(c0.devices.map((d) => `${d.kind}@${d.deviceId}`)));

    const fieldProblems = [];
    for (const device of c0.devices) {
      if (typeof device.deviceId !== 'string' || device.deviceId.length === 0) fieldProblems.push('deviceId');
      if (!KINDS.includes(device.kind)) fieldProblems.push(`kind=${device.kind}`);
      if (device.readOnly !== true) fieldProblems.push(`readOnly=${device.readOnly}`);
      if (!Array.isArray(device.fields) || device.fields.length === 0) fieldProblems.push('fields');
      for (const field of device.fields ?? []) {
        if (typeof field.name !== 'string' || field.name.length === 0) fieldProblems.push('field.name');
        if (typeof field.value !== 'string') fieldProblems.push(`${device.kind}.${field.name}.value 非字符串`);
      }
    }
    check('A5 每个设备都有 deviceId/kind/readOnly=true/非空 fields，且每个 value 都是字符串',
      fieldProblems.length === 0, fieldProblems.slice(0, 6).join('; ') || '全部合规');

    const hexProblems = [];
    const RANGE_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)\+0x(?:0|[1-9a-f][0-9a-f]*)$/;
    for (const device of c0.devices) {
      for (const [name, value] of Object.entries(fieldMap(device))) {
        if (name === 'ioPortRanges') {
          if (value === '') continue;
          for (const part of value.split(',')) {
            if (!RANGE_RE.test(part)) hexProblems.push(`${device.kind}.ioPortRanges=${part}`);
          }
          continue;
        }
        if (value.startsWith('0x') && !HEX_RE.test(value)) hexProblems.push(`${device.kind}.${name}=${value}`);
      }
      for (const range of device.registerRanges ?? []) {
        if (!HEX_RE.test(range.address) || !Number.isInteger(range.length) || range.length <= 0) {
          hexProblems.push(`${device.kind}.registerRanges=${JSON.stringify(range)}`);
        }
      }
    }
    check('A6 Hex 无反导零（0x0/0x1000000 形式），ioPortRanges 是 address+length 列表，registerRanges 的 address/length 合法',
      hexProblems.length === 0, hexProblems.slice(0, 6).join('; ') || '全部合规');

    const evidenceProblems = [];
    for (const device of c0.devices) {
      const ev = device.evidence ?? {};
      if (ev.kind !== 'observed') evidenceProblems.push(`${device.kind}.kind`);
      if (ev.source !== 'qmp:x-oslab-capture/devices') evidenceProblems.push(`${device.kind}.source`);
      if (ev.captureId !== c0.captureId) evidenceProblems.push(`${device.kind}.captureId`);
      const refs = ev.refs ?? [];
      if (!Array.isArray(refs) || refs.length < 3
        || !refs.some((r) => /\.(c|h)\b/.test(r))
        || !refs.some((r) => r.includes('BQL'))) evidenceProblems.push(`${device.kind}.refs`);
    }
    check('A7 每个设备都带 evidence{kind=observed, source, captureId, refs=观察点+锁上下文+只读声明}',
      evidenceProblems.length === 0, evidenceProblems.slice(0, 6).join('; ') || '全部合规');

    const ranks = c0.devices.map((d) => RANKS.indexOf(d.kind));
    const ordered = ranks.every((rank, i) => rank >= 0 && (i === 0 || rank >= ranks[i - 1]));
    const c0b = await qmp.command('x-oslab-capture');
    check('A8 输出稳定排序（按 rank 且同级按 deviceId），两次采集的 deviceId 序列一致',
      ordered && c0.devices.length === c0b.devices.length
      && c0.devices.every((d, i) => d.deviceId === c0b.devices[i].deviceId),
      `rank=${JSON.stringify(ranks)}`);

    const vga0 = byKind(c0, 'vga')[0];
    const uart0 = byKind(c0, 'uart')[0];
    const pic0 = byKind(c0, 'pic');
    const timer0 = byKind(c0, 'timer')[0];
    const vgaLow = (vga0.registerRanges ?? []).find((r) => BigInt(r.address) === A0000);
    check('A9 寄存器区间来自真实 MemoryRegion owner：VGA 有 0xa0000 legacy 窗口、UART 有 0x3f8、PIC 有 0x20/0xa0、PIT 有 0x40',
      vgaLow !== undefined && vgaLow.length === 0x20000
      && String(fieldMap(uart0).ioPortRanges).includes('0x3f8+0x8')
      && pic0.every((p) => String(fieldMap(p).ioPortRanges).startsWith('0x20+') || String(fieldMap(p).ioPortRanges).startsWith('0xa0+'))
      && String(fieldMap(timer0).ioPortRanges).includes('0x40+'),
      JSON.stringify({ vgaLow, uart: fieldMap(uart0).ioPortRanges, pic: pic0.map((p) => fieldMap(p).ioPortRanges), pit: fieldMap(timer0).ioPortRanges }));

    const virtioCold = byKind(c0, 'virtio-blk')[0];
    check('A10 面板反映真实设备状态：-S（未跑 BIOS，BAR 未分配）时 virtio-blk 没有 registerRanges',
      (virtioCold.registerRanges ?? []).length === 0,
      `registerRanges=${JSON.stringify(virtioCold.registerRanges ?? [])}`);

    /* ---------- B/C. 真实客体启动后停止，做只读性与 VGA 面板检查 ---------- */
    await qmp.command('cont');
    await pump(PROMPT, '客体登录提示符', 300000);
    serialCursor = serialText.length;
    check('B1 真实 Linux 客体启动到交互提示符（console=tty0 + console=ttyS0 双控制台）',
      PROMPT.test(serialText), `串口字节=${serialText.length}`);

    /*
     * 标记串刻意拆成两段：命令行里永远不出现连续的 VGASNAP-MARKER，
     * 所以串口日志里出现它就说明有别的通道在泄漏，去掉它就说明 VGA 面板内容
     * 只可能来自设备/显存本身。
     */
    send(`printf '%s%s\\n' VGASNAP -MARKER > /dev/tty0; echo VGADONE`);
    await pump(/VGADONE/, 'VGADONE', 60000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    serialCursor = serialText.length;

    await qmp.command('stop');

    const c1 = await qmp.command('x-oslab-capture');
    const vga1 = byKind(c1, 'vga')[0];
    const grid = decodeTextGrid(vga1);
    evidence.vgaGrid = grid.lines.filter((line) => line.trim().length > 0);
    evidence.vgaFields = pick(vga1, ['graphicMode', 'textMode', 'textCols', 'textRows',
      'startAddr', 'lineOffset', 'cellStride', 'vramSize', 'cursorOffset', 'cursorVisible']);

    check('C1 VGA 处于文本模式，几何与 CRTC 一致（80×25、cellStride=4、行宽 320）',
      fieldMap(vga1).graphicMode === 'text' && fieldMap(vga1).textMode === 'true'
      && fieldMap(vga1).textCols === '80' && fieldMap(vga1).textRows === '25'
      && fieldMap(vga1).cellStride === '4' && fieldMap(vga1).lineOffset === '320',
      JSON.stringify(evidence.vgaFields));
    check('C2 vramBacking 恰好导出 cols×rows×cellStride 字节的字符网格（未被上限截断）',
      grid.hexLength === grid.cols * grid.rows * grid.stride * 2,
      `hex=${grid.hexLength} 期望=${grid.cols * grid.rows * grid.stride * 2}`);
    check('C3 解码 vramBacking 得到真实字符网格，含只写到 /dev/tty0 的标记',
      grid.lines.some((line) => line.includes(MARKER)),
      `命中行=${JSON.stringify(grid.lines.filter((l) => l.includes(MARKER)))}`);
    check('C4 该标记不出现在串口日志里（面板内容来自 VGA 设备/显存，不是串口回显）',
      !serialText.includes(MARKER),
      `串口含标记=${serialText.includes(MARKER)}`);

    const phys = await qmp.command('x-oslab-read-physical', {
      captureId: c1.captureId, address: '0xb8000', length: 16,
    });
    evidence.vgaPhysicalRead = phys;
    check('C5 文本显存地址 0xb8000 属于有副作用的 MMIO（vga-lowmem），物理读被拒：VGA 面板只能来自设备快照',
      phys.ok === false && phys.reason === 'side-effect-risk'
      && phys.regionKind === 'mmio' && phys.regionName === 'vga-lowmem'
      && phys.address === '0xb8000',
      JSON.stringify({ reason: phys.reason, regionName: phys.regionName, regionKind: phys.regionKind }));

    /* 串口注入：VM 已停止，字节应当只是躺进设备接收 FIFO，不会被任何人取走。 */
    serialSocket.write(Buffer.from(INJECTED, 'latin1'));
    await new Promise((resolve) => setTimeout(resolve, 600));

    const snapshots = [];
    for (let i = 0; i < 4; i += 1) snapshots.push(await qmp.command('x-oslab-capture'));
    const uarts = snapshots.map((s) => pick(byKind(s, 'uart')[0],
      ['fcr', 'fifoEnabled', 'lsr', 'lsrDataReady', 'rbr', 'recvFifoCount',
        'recvFifoHex', 'timeoutIpending']));
    evidence.uartAfterInject = uarts[0];

    check('B2 停机状态下注入 5 字节进串口接收 FIFO（面板如实报出，且 DR 置位）',
      uarts[0].fifoEnabled === 'true' && uarts[0].recvFifoCount === String(INJECTED.length)
      && uarts[0].recvFifoHex === Buffer.from(INJECTED, 'latin1').toString('hex')
      && uarts[0].lsrDataReady === 'true'
      && (Number.parseInt(uarts[0].lsr, 16) & 0x01) === 1,
      JSON.stringify(uarts[0]));
    check('B3 连续 4 次读取面板，接收 FIFO 一个字节都没被消费（recvFifoCount/Hex/lsr 逐次相同）',
      uarts.every((u) => JSON.stringify(u) === JSON.stringify(uarts[0])),
      JSON.stringify(uarts.map((u) => `${u.recvFifoCount}/${u.recvFifoHex}/${u.lsr}`)));

    const normalized = snapshots.map(normalizeCapture);
    const deviceStable = normalized.every((n) => JSON.stringify(n.devices) === JSON.stringify(normalized[0].devices));
    const worldStable = normalized.every((n) => JSON.stringify({
      cpus: n.cpus, vmGeneration: n.vmGeneration, eventWatermark: n.eventWatermark,
      regionCount: n.regionCount, readableRegionCount: n.readableRegionCount,
      events: n.events,
    }) === JSON.stringify({
      cpus: normalized[0].cpus, vmGeneration: normalized[0].vmGeneration,
      eventWatermark: normalized[0].eventWatermark, regionCount: normalized[0].regionCount,
      readableRegionCount: normalized[0].readableRegionCount, events: normalized[0].events,
    }));
    evidence.stability = {
      deviceStable, worldStable,
      vmGeneration: normalized.map((n) => n.vmGeneration),
      eventWatermark: normalized.map((n) => n.eventWatermark),
    };
    check('B4 反复读取设备面板不推进客体状态：devices 逐字段相同，且 cpus/vmGeneration/eventWatermark 不变',
      deviceStable && worldStable,
      `devices=${deviceStable} world=${worldStable} gen=${JSON.stringify(normalized.map((n) => n.vmGeneration))} wm=${JSON.stringify(normalized.map((n) => n.eventWatermark))}`);

    const picStates = snapshots.map((s) => byKind(s, 'pic')
      .map((p) => pick(p, ['irr', 'isr', 'imr', 'lastIrr', 'readRegSelect', 'poll', 'intOutput'])));
    const apicStates = snapshots.map((s) => {
      const apic = byKind(s, 'apic')[0];
      const map = fieldMap(apic);
      const keys = ['apicbase', 'tpr', 'spuriousVec', 'initialCount', 'currentCount', 'esr', 'icrLow', 'icrHigh', 'waitForSipi'];
      for (let i = 0; i < 8; i += 1) keys.push(`irr${i}`, `isr${i}`, `tmr${i}`);
      return pick(apic, keys);
    });
    const pitStates = snapshots.map((s) => {
      const pit = byKind(s, 'timer')[0];
      const map = fieldMap(pit);
      const keys = ['iobase'];
      for (let ch = 0; ch < 3; ch += 1) {
        for (const name of ['count', 'latchedCount', 'countLatched', 'statusLatched', 'status', 'readState', 'writeState', 'writeLatch', 'countLoadTime', 'nextTransitionTime']) {
          keys.push(`ch${ch}.${name}`);
        }
      }
      return pick(pit, keys);
    });
    evidence.picStates = picStates[0];
    evidence.apicState = apicStates[0];
    evidence.pitState = pitStates[0];
    check('B5 反复读取面板不确认 IRQ：PIC 的 irr/isr/lastIrr/readRegSelect/poll 与 APIC 的 irr/isr/tmr 全部不变',
      picStates.every((p) => JSON.stringify(p) === JSON.stringify(picStates[0]))
      && apicStates.every((a) => JSON.stringify(a) === JSON.stringify(apicStates[0])),
      JSON.stringify({ pic: picStates[0], apicIrr0: apicStates[0].irr0 }));
    check('B6 反复读取面板不推进虚拟时钟：PIT 三通道计数/锁存/到期时间逐次相同（APIC currentCount 同理）',
      pitStates.every((p) => JSON.stringify(p) === JSON.stringify(pitStates[0]))
      && apicStates.every((a) => a.currentCount === apicStates[0].currentCount),
      JSON.stringify({ pit: pick(byKind(snapshots[0], 'timer')[0], ['ch0.count', 'ch0.countLoadTime', 'ch0.nextTransitionTime']), apicCurrentCount: apicStates[0].currentCount }));

    /* 恢复运行后：先验证运行中拒绝冻结（需要全部 vCPU 停止的屏障），再让客体把注入字节读走。 */
    await qmp.command('cont');
    const runningCapture = await qmp.command('x-oslab-capture');
    evidence.runningCaptureRefused = runningCapture;
    check('B7 客体运行中拒绝冻结快照（vcpu-running）：面板只在停止屏障下产生',
      runningCapture.ok === false && runningCapture.refused === true
      && runningCapture.reason === 'vcpu-running',
      JSON.stringify({ reason: runningCapture.reason }));

    await new Promise((resolve) => setTimeout(resolve, 2500));
    await qmp.command('stop');
    const c2 = await qmp.command('x-oslab-capture');
    const uart2 = pick(byKind(c2, 'uart')[0], ['lsr', 'lsrDataReady', 'recvFifoCount', 'recvFifoHex']);
    evidence.uartAfterResume = uart2;
    check('B8 恢复运行后客体把注入字节读走（recvFifoCount 归 0、DR 清位）：面板确实没替客体消费数据',
      uart2.recvFifoCount === '0' && uart2.recvFifoHex === ''
      && uart2.lsrDataReady === 'false',
      JSON.stringify(uart2));

    /* ---------- D. virtio 与 QEMU 标准命令交叉核对 ---------- */
    const virtio = byKind(c2, 'virtio-blk')[0];
    const vMap = fieldMap(virtio);
    const stdStatus = await qmp.command('x-query-virtio-status', { path: virtio.deviceId });
    const stdQueue = await qmp.command('x-query-virtio-queue-status', { path: virtio.deviceId, queue: 0 });
    const stdList = await qmp.command('x-query-virtio');
    const queue = (virtio.virtqueues ?? [])[0];
    evidence.virtio = {
      deviceId: virtio.deviceId,
      fields: pick(virtio, ['virtioDeviceId', 'status', 'isr', 'queueSel', 'hostFeatures',
        'guestFeatures', 'numQueues', 'started', 'vhostStarted', 'virtqueue.0.notification',
        'virtqueue.0.vector', 'virtqueue.0.vringNumDefault', 'virtqueue.0.vringAlign',
        'virtqueue.0.signalledUsed', 'virtqueue.0.signalledUsedValid']),
      queue,
      registerRanges: virtio.registerRanges,
      ioPortRanges: vMap.ioPortRanges ?? null,
      standardStatus: stdStatus,
      standardQueueStatus: stdQueue,
      standardVirtioList: stdList,
    };

    check('D1 virtio-blk 面板与真实设备对应：PCI 00:03.0、队列数与标准命令 num-vqs 一致',
      virtio.pciAddress === '00:03.0' && vMap.virtioDeviceId === `0x${stdStatus['device-id'].toString(16)}`
      && Number(vMap.numQueues) === stdStatus['num-vqs']
      && Array.isArray(virtio.virtqueues) && virtio.virtqueues.length === stdStatus['num-vqs']
      && stdList.some((entry) => entry.path === virtio.deviceId),
      JSON.stringify({ pci: virtio.pciAddress, numQueues: vMap.numQueues, std: stdStatus['num-vqs'] }));

    check('D2 队列快照与 x-query-virtio-queue-status 逐字段一致（size/inuse/索引/vring 三个地址）',
      queue.size === stdQueue['vring-num']
      && queue.queueIndex === stdQueue['queue-index']
      && queue.ready === (stdQueue['vring-num'] > 0)
      && queue.lastAvailIndex === stdQueue['last-avail-idx']
      && queue.lastUsedIndex === stdQueue['used-idx']
      && queue.negotiatedFeatures === vMap.guestFeatures
      && queue.descTable === hex(stdQueue['vring-desc'])
      && queue.availRing === hex(stdQueue['vring-avail'])
      && queue.usedRing === hex(stdQueue['vring-used']),
      JSON.stringify({ ours: queue, std: stdQueue }));
    check('D3 设备级字段与 x-query-virtio-status 一致（status 位/isr/queueSel/started/vhost-started/notifier 掩码）',
      vMap.status === '0xf'
      && stdStatus.status.statuses.length === 4
      && stdStatus.status.statuses.every((item) => /VIRTIO_CONFIG_S_(ACKNOWLEDGE|DRIVER|FEATURES_OK|DRIVER_OK)/.test(item))
      && vMap.isr === hex(stdStatus.isr)
      && vMap.queueSel === hex(stdStatus['queue-sel'])
      && vMap.started === String(stdStatus.started)
      && vMap.vhostStarted === String(stdStatus['vhost-started'])
      && vMap.useGuestNotifierMask === String(stdStatus['use-guest-notifier-mask']),
      JSON.stringify({ status: vMap.status, isr: vMap.isr, started: vMap.started, queueSel: vMap.queueSel }));
    check('D4 feature 关系自洽：guestFeatures ⊆ hostFeatures，且队列协商位等于 guestFeatures',
      (BigInt(vMap.guestFeatures) & ~BigInt(vMap.hostFeatures)) === 0n
      && BigInt(queue.negotiatedFeatures) === BigInt(vMap.guestFeatures)
      && (BigInt(vMap.guestFeatures) & (1n << 32n)) !== 0n,
      `host=${vMap.hostFeatures} guest=${vMap.guestFeatures}`);
    check('D5 启动后 BAR 已分配：virtio-blk 有 6 段 registerRanges 与 legacy IO 端口区间',
      (virtio.registerRanges ?? []).length === 6
      && /^0x[0-9a-f]+\+0x[0-9a-f]+$/.test(String(vMap.ioPortRanges))
      && (virtio.registerRanges ?? []).some((r) => r.length === 4096),
      JSON.stringify({ ranges: virtio.registerRanges, io: vMap.ioPortRanges }));
    check('D6 队列 evidence 说明「复用 QEMU 自带标准命令、未改 QEMU」，且 vhost 未启用时该命令可用',
      (queue.evidence?.refs ?? []).some((r) => r.includes('qmp_x_query_virtio_queue_status'))
      && (queue.evidence?.refs ?? []).some((r) => r.includes('BQL'))
      && vMap.vhostStarted === 'false'
      && queue.evidence?.source.startsWith('qmp:x-query-virtio-queue-status'),
      JSON.stringify(queue.evidence));

    /* ---------- E. 观察点与锁/线程上下文说明 ---------- */
    const source = fs.readFileSync(OBSERVER_C, 'utf8');
    const start = source.indexOf('T05d 设备快照');
    const section = source.slice(start, start + 6000);
    evidence.observationSection = section.slice(0, 1200);
    check('E1 设备快照的读法与锁上下文有源码级说明：main loop + BQL、owner 精确匹配、不消费 FIFO、不确认 IRQ、不推进时钟',
      source.includes('main loop + BQL')
      && source.includes('object_child_foreach_recursive')
      && source.includes('memory_region_owner')
      && source.includes('不消费 FIFO') && source.includes('不确认 IRQ')
      && source.includes('不推进虚拟时钟'),
      'T05d 段落含 discovery / 归属 / 只读三条说明');
    check('E2 每类设备的源码观察点都指向真实文件与符号（.c/.h + 函数或结构体名）',
      POINT_KEYS.every((key) => /\.(c|h)\b/.test(points[key]) && /[A-Za-z_]{4,}/.test(points[key]))
      && points.virtio.includes('qmp_x_query_virtio_queue_status')
      && points.apic.includes('apic_get_current_count')
      && points.pic.includes('pic_get_output')
      && points.vga.includes('x_oslab_vga_snapshot'),
      JSON.stringify({ virtio: points.virtio, pic: points.pic }));
    check('E3 每类设备都声明了「结构体在 include/ 下直接读、只有 VGA 需要补丁」的取舍依据',
      (devCap.notes ?? []).some((note) => note.includes('x-query-virtio-queue-status'))
      && (devCap.notes ?? []).some((note) => note.includes('OCW3/poll'))
      && (devCap.notes ?? []).some((note) => note.includes('x86_64')),
      JSON.stringify(devCap.notes));

    const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    evidence.buildLock = { deviceSnapshots: lock.deviceSnapshots, ip: lock.commandsNotImplemented };
    check('E4 build.lock.json 与运行期一致：deviceSnapshots 已登记为已实现，kinds 与 capabilities 相同',
      lock.deviceSnapshots !== undefined
      && lock.commandsNotImplemented.deviceSnapshots === undefined
      && JSON.stringify(lock.deviceSnapshots.kinds) === JSON.stringify(RANKS)
      && (lock.deviceSnapshots.knownLimits ?? []).length >= 5,
      JSON.stringify({ kinds: lock.deviceSnapshots?.kinds, limits: (lock.deviceSnapshots?.knownLimits ?? []).length }));

    /* 释放快照，验证面板引用的 captureId 生命周期 */
    const released = await qmp.command('x-oslab-release', { captureId: c2.captureId });
    check('E5 快照释放后 captureId 失效，面板内容不再悬挂（本轮面板与 capture 同生命周期）',
      released.released === true, JSON.stringify(released));
  } finally {
    try { await qmp.command('quit'); } catch { /* quit 会关闭连接，属预期 */ }
    qmp.close();
    serialSocket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!procExit) proc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!procExit && proc.exitCode === null) proc.kill('SIGKILL');
  }

  evidence.checks = results;
  evidence.summary = `${results.filter((item) => item.ok).length}/${results.length}`;
  evidence.serialTail = serialText.slice(-1500);
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
