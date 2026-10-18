#!/usr/bin/env node
/**
 * T05b 事件序列验收（真实 QEMU + 真实 GDB RSP 单步，不经过 lab-server）。
 *
 * 覆盖：
 *   A. x-oslab-events 的命令面与 capabilities.events 的诚实标注（真正会产生
 *      的 kind、unavailableKinds、源码观察点、缺口、容量与配额）
 *   B. 开关语义与拒绝路径：enable/reset 只在 VM 停止时接受（vm-running），
 *      capture 活跃时拒绝 reset（capture-active），切换后立即生效
 *   C. 真实单步事件流：把手工汇编 blob 写进物理内存、用 GDB 设好段寄存器与
 *      EIP 后逐条单步，断言 instruction.begin/retire、访存的 kind/phase/
 *      size/addressSpace/address/bytes/value 与事件归属，并断言异常指令
 *      不会产生 instruction.retire（不把没完成的指令谎报成完成）
 *   D. 独立通道交叉验证：HMP `xp`/`i`、x-oslab-read-physical（T05a 快照）、
 *      串口 socket 上的原始字节；并确认宿主探针（HMP i/o）不进入客体事件流
 *   E. 分块读取、kind 过滤、未知 kind、越界 limit、环满后的 drop/水位线语义
 *
 * 说明：单步程序在实模式、CS=0x1000（基址 0x10000）、DS=0 下运行，因此
 * blob 里的 32 位偏移就是线性地址。GDB 的 M/P/m/s 是唯一的执行驱动，逐条
 * 单步保证事件与指令一一对应，不依赖任何带副作用的宿主探针。
 *
 * 用法：
 *   node instrumentation/qemu-observer/verify-observer-events.mjs
 *
 * 证据输出：artifacts/verify/t05b-observer-events.json
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const QEMU = path.join(ROOT, 'artifacts/build/qemu/qemu-system-x86_64');
const WORK = path.join(ROOT, 'var/tmp/t05b-verify');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05b-observer-events.json');

/* 单步程序：每条给出机器码与期望事件。偏移由机器码长度累加得到。 */
const BASE = 0x10000;      /* CS=0x1000 → 线性基址 */
const EIP0 = 0;
const PROGRAM = [
  { asm: 'mov eax,[0x20000]', bytes: '6667a100000200',
    events: [{ kind: 'memory.read', size: 4, address: '0x20000', value: '0xdeadbeef' }] },
  { asm: 'mov [0x30000],ax', bytes: '67a300000300',
    events: [{ kind: 'memory.write', size: 2, address: '0x30000', value: '0xbeef' }] },
  { asm: 'mov al,[0x40000]', bytes: '67a000000400',
    events: [{ kind: 'memory.read', size: 1, address: '0x40000', value: '0x5a' }] },
  { asm: 'mov dx,0x3fd', bytes: 'bafd03', events: [] },
  { asm: 'in al,dx', bytes: 'ec',
    events: [{ kind: 'io.read', size: 1, address: '0x3fd' }] },
  { asm: 'mov dx,0x2f8', bytes: 'baf802', events: [] },
  { asm: 'in ax,dx', bytes: 'ed',
    events: [{ kind: 'io.read', size: 2, address: '0x2f8', value: '0xffff' }] },
  { asm: 'mov eax,0x1337', bytes: '66b837130000', events: [] },
  { asm: 'mov dx,0x3f8', bytes: 'baf803', events: [] },
  { asm: 'out dx,al', bytes: 'ee',
    events: [{ kind: 'io.write', size: 1, address: '0x3f8', value: '0x37' }] },
  { asm: 'mov dx,0x2f8', bytes: 'baf802', events: [] },
  { asm: 'out dx,eax', bytes: '66ef',
    events: [{ kind: 'io.write', size: 4, address: '0x2f8', value: '0x1337' }] },
  { asm: 'ud2', bytes: '0f0b', retire: false,
    events: [{ kind: 'exception.raise', vector: 6, errorCode: 0 }] },
];

let offset = 0;
for (const item of PROGRAM) {
  item.at = offset;
  item.length = item.bytes.length / 2;
  item.linear = BASE + offset;
  item.eip = offset;
  if (item.retire === undefined) item.retire = true;
  offset += item.length;
}
const BLOB = Buffer.from(PROGRAM.map((item) => item.bytes).join(''), 'hex');
const LAST = PROGRAM[PROGRAM.length - 1];

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
}

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

/** 小端字节 → 无符号整数字符串，用于把契约 bytes 与 value 对照。 */
function valueOfBytes(base64) {
  const raw = Buffer.from(base64, 'base64');
  let value = 0n;
  for (let i = raw.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(raw[i]);
  return hex(value);
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
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ execute, arguments: args ?? {}, id })}\n`);
    });
  }

  async command(execute, args) {
    const message = await this.raw(execute, args);
    if (message.error) throw new Error(`${execute}: ${message.error.desc}`);
    return message.return;
  }

  hmp(line) {
    return this.command('human-monitor-command', { 'command-line': line });
  }

  close() {
    this.socket.destroy();
  }
}

/* ------------------------------------------------------------ GDB RSP 客户端 */

class RspClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('latin1');
      this.pump();
    });
  }

  static async connect(socketPath) {
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RspClient(socket);
  }

  pump() {
    for (;;) {
      const start = this.buffer.indexOf('$');
      if (start < 0) {
        const keep = this.buffer.slice(-4);
        this.buffer = /[+\-\x03]/.test(keep) ? keep : '';
        return;
      }
      const end = this.buffer.indexOf('#', start);
      if (end < 0 || this.buffer.length < end + 3) return;
      const payload = this.buffer.slice(start + 1, end);
      this.buffer = this.buffer.slice(end + 3);
      this.socket.write('+');
      const waiter = this.waiters.shift();
      if (waiter) waiter(payload);
    }
  }

  send(payload) {
    const sum = [...payload].reduce((acc, ch) => (acc + ch.charCodeAt(0)) & 0xff, 0);
    this.socket.write(`$${payload}#${sum.toString(16).padStart(2, '0')}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RSP 超时: ${payload}`)), 20000);
      this.waiters.push((reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.pump();
    });
  }

  /** 取回目标 XML（跟随 xi:include），返回寄存器名 → {num, bytes}。 */
  async readRegisters() {
    const xmls = new Map();
    const fetchXml = async (name) => {
      if (xmls.has(name)) return xmls.get(name);
      let cursor = 0;
      let text = '';
      for (;;) {
        const reply = await this.send(
          `qXfer:features:read:${name}:${cursor.toString(16)},7fff`,
        );
        if (reply.length === 0) break;
        if (reply[0] === 'E') throw new Error(`读取 ${name} 失败: ${reply}`);
        text += reply.slice(1);
        if (reply[0] === 'l') break;
        cursor += reply.length - 1;
      }
      xmls.set(name, text);
      for (const match of text.matchAll(/<xi:include href="([^"]+)"/g)) {
        await fetchXml(match[1]);
      }
      return text;
    };
    await fetchXml('target.xml');
    const all = [...xmls.values()].join('\n');
    const registers = new Map();
    let next = 0;
    for (const match of all.matchAll(/<reg name="([^"]+)" bitsize="(\d+)"(?:[^>]*?regnum="(\d+)")?/g)) {
      const number = match[3] === undefined ? next : Number(match[3]);
      next = number + 1;
      registers.set(match[1], { number, bytes: Number(match[2]) / 8 });
    }
    return registers;
  }

  async writeMemory(address, bytes) {
    const reply = await this.send(
      `M${address.toString(16)},${bytes.length.toString(16)}:${bytes.toString('hex')}`,
    );
    if (reply !== 'OK') throw new Error(`M ${hex(address)} -> ${reply}`);
  }

  async readMemory(address, length) {
    const reply = await this.send(`m${address.toString(16)},${length.toString(16)}`);
    if (reply.startsWith('E')) throw new Error(`m ${hex(address)} -> ${reply}`);
    return Buffer.from(reply, 'hex');
  }

  async writeRegister(registers, name, value) {
    const info = registers.get(name);
    if (!info) throw new Error(`目标没有寄存器 ${name}`);
    const buffer = Buffer.alloc(info.bytes);
    let rest = BigInt(value);
    for (let i = 0; i < info.bytes; i += 1) {
      buffer[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    const reply = await this.send(`P${info.number.toString(16)}=${buffer.toString('hex')}`);
    if (reply !== 'OK') throw new Error(`P ${name} -> ${reply}`);
  }
}

/* ------------------------------------------------------------------ 主流程 */

function fail(message) {
  console.error(`\n致命错误: ${message}`);
  process.exit(2);
}

async function main() {
  if (!fs.existsSync(QEMU)) fail(`缺少锁定 QEMU: ${QEMU}`);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });

  const qmpPath = path.join(WORK, 'qmp.sock');
  const gdbPath = path.join(WORK, 'gdb.sock');
  const serialPath = path.join(WORK, 'serial.sock');

  const args = [
    '-machine', 'pc', '-cpu', 'qemu64',
    '-accel', 'tcg,thread=single', '-smp', '1', '-m', '512',
    '-display', 'none', '-nodefaults', '-device', 'VGA',
    '-device', 'isa-serial,chardev=serial0',
    '-chardev', `socket,id=serial0,path=${serialPath},server=on,wait=off`,
    '-qmp', `unix:${qmpPath},server=on,wait=off`,
    '-gdb', `unix:${gdbPath},server=on,wait=off`,
    '-S', '-no-reboot',
  ];
  const logFd = fs.openSync(path.join(WORK, 'qemu.log'), 'w');
  const proc = spawn(QEMU, args, { cwd: ROOT, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  let procExit = null;
  proc.on('exit', (code, signal) => {
    procExit = { code, signal };
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline
    && !(fs.existsSync(qmpPath) && fs.existsSync(gdbPath) && fs.existsSync(serialPath))) {
    if (procExit) fail(`QEMU 提前退出: ${JSON.stringify(procExit)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /* 串口客户端必须最先连上，否则客体写出的字节会被丢弃。 */
  const serialSocket = net.createConnection(serialPath);
  const serialChunks = [];
  serialSocket.on('data', (chunk) => serialChunks.push(chunk));
  await new Promise((resolve, reject) => {
    serialSocket.once('connect', resolve);
    serialSocket.once('error', reject);
  });

  const qmp = await QmpClient.connect(qmpPath);
  const evidence = { schema: 'oslab.t05b-evidence/1', qemu: QEMU, args, program: PROGRAM };

  try {
    const rsp = await RspClient.connect(gdbPath);
    const supported = await rsp.send('qSupported:multiprocess+');
    evidence.rspSupported = supported;
    const registers = await rsp.readRegisters();
    evidence.registers = Object.fromEntries(
      [...registers].map(([name, info]) => [name, `${info.number}:${info.bytes}`]),
    );

    /* ---------- A. capabilities 的事件面 ---------- */
    const caps = await qmp.command('x-oslab-capabilities');
    evidence.capabilities = caps;
    const events = caps.events ?? {};
    const produced = [
      'instruction.begin', 'instruction.retire', 'memory.read', 'memory.write',
      'dma.read', 'dma.write', 'io.read', 'io.write',
      'interrupt.accept', 'exception.raise', 'block.submit', 'block.complete',
      'capture.fence',
    ];
    const gaps = ['irq.raise', 'irq.lower', 'input.accept', 'serial.output',
      'observer.drop'];
    check('A1 capabilities.events.supported === true', events.supported === true,
      `supported=${events.supported}`);
    check('A2 events.kinds 恰好是可产生事件的 13 种（T05b 八类 + T05c 四类 + T05e capture.fence）',
      Array.isArray(events.kinds) && JSON.stringify(events.kinds) === JSON.stringify(produced),
      JSON.stringify(events.kinds));
    check('A3 events.unavailableKinds 明确列出未实现的 5 种',
      Array.isArray(events.unavailableKinds)
      && JSON.stringify(events.unavailableKinds) === JSON.stringify(gaps),
      JSON.stringify(events.unavailableKinds));
    check('A4 observationPoints 覆盖全部落点且给出源码位置',
      events.observationPoints
      && ['instruction.begin', 'instruction.retire', 'memory.read/write',
        'io.read/write', 'exception.raise/interrupt.accept',
        'dma.read/write', 'block.submit', 'block.complete', 'devices',
        'ring', 'switch']
        .every((key) => typeof events.observationPoints[key] === 'string'
          && events.observationPoints[key].length > 0),
      JSON.stringify(Object.keys(events.observationPoints ?? {})));
    check('A5 knownGaps 非空且逐条说明缺口',
      Array.isArray(events.knownGaps) && events.knownGaps.length >= 3,
      JSON.stringify(events.knownGaps));
    check('A6 容量/配额自洽（capacity 65536、defaultLimit 1024、maxLimit=capacity）',
      events.capacity === 65536 && events.defaultLimit === 1024
      && events.maxLimit === events.capacity,
      `capacity=${events.capacity} defaultLimit=${events.defaultLimit} maxLimit=${events.maxLimit}`);
    check('A7 readGate 声明 enable/reset 需要 VM 停止',
      typeof events.readGate === 'string' && events.readGate.includes('enable/reset'),
      events.readGate);
    check('A8 capabilities.events 与 events 命令共用同一份真实状态',
      typeof events.watermark === 'string' && typeof events.dropped === 'string'
      && events.enabled === false,
      `enabled=${events.enabled} watermark=${events.watermark} dropped=${events.dropped}`);

    /* ---------- B. 开关语义（VM 静止时；运行中的拒绝路径在 E 段验证） ---------- */
    const initial = await qmp.command('x-oslab-events');
    check('B1 初始 disabled 且水位线为 0',
      initial.enabled === false && initial.watermark === '0' && initial.returned === 0,
      `enabled=${initial.enabled} watermark=${initial.watermark}`);

    const enabled = await qmp.command('x-oslab-events', { enable: true });
    evidence.enabled = enabled;
    check('B2 VM 停止后 enable 生效并报告状态变化',
      enabled.ok === true && enabled.enabled === true && enabled.enabledChanged === true,
      `enabled=${enabled.enabled} enabledChanged=${enabled.enabledChanged}`);
    const enabledAgain = await qmp.command('x-oslab-events', { enable: true });
    check('B3 重复 enable 不误报状态变化', enabledAgain.enabledChanged === false,
      `enabledChanged=${enabledAgain.enabledChanged}`);
    const reset = await qmp.command('x-oslab-events', { reset: true });
    check('B4 reset 生效且水位线归零',
      reset.ok === true && reset.reset === true && reset.watermark === '0'
      && reset.total === '0' && reset.dropped === '0',
      `watermark=${reset.watermark} total=${reset.total} dropped=${reset.dropped}`);

    /* ---------- C. 真实单步事件流 ---------- */
    const data = [
      { address: 0x20000, bytes: Buffer.from('efbeadde', 'hex') },
      { address: 0x30000, bytes: Buffer.from('0000', 'hex') },
      { address: 0x40000, bytes: Buffer.from('5a', 'hex') },
    ];
    await rsp.writeMemory(BASE, BLOB);
    for (const item of data) await rsp.writeMemory(item.address, item.bytes);
    for (const [name, value] of [['cs', 0x1000], ['ds', 0], ['es', 0], ['ss', 0],
      ['rip', EIP0], ['eflags', 0x2]]) {
      await rsp.writeRegister(registers, name, value);
    }
    const codeReadback = await rsp.readMemory(BASE, BLOB.length);
    check('C1 blob 已写入并由 m 读回一致（驱动通道可信）',
      codeReadback.equals(BLOB), codeReadback.toString('hex'));

    for (let i = 0; i < PROGRAM.length; i += 1) {
      const reply = await rsp.send('s');
      if (reply.startsWith('E')) fail(`单步第 ${i + 1} 条失败: ${reply}`);
    }

    const collected = await qmp.command('x-oslab-events', { limit: 256 });
    evidence.collected = collected;
    const list = collected.events;
    const byInsn = new Map();
    for (const event of list) {
      if (event.kind === 'instruction.begin') {
        byInsn.set(event.instructionId, { begin: event, body: [], retire: null });
        continue;
      }
      const group = byInsn.get(event.instructionId);
      if (!group) continue;
      if (event.kind === 'instruction.retire') group.retire = event;
      else group.body.push(event);
    }
    const expectedTotal = PROGRAM.length
      + PROGRAM.filter((item) => item.retire).length
      + PROGRAM.reduce((acc, item) => acc + item.events.length, 0);
    check('C2 事件总数 = 指令 x2 + 访存/端口 + 异常，且无丢事件',
      collected.returned === expectedTotal && collected.dropped === '0'
      && collected.truncated === false && collected.total === String(expectedTotal),
      `returned=${collected.returned} 期望=${expectedTotal} dropped=${collected.dropped}`);
    check('C3 seq 从 1 起连续无空洞',
      list.length > 0 && list.every((event, index) => event.seq === String(index + 1)),
      `first=${list[0]?.seq} last=${list[list.length - 1]?.seq}`);
    check('C4 每条指令都有一个 instruction.begin 且 phase=begin',
      byInsn.size === PROGRAM.length
      && [...byInsn.values()].every((group) => group.begin.phase === 'begin'),
      `begin=${byInsn.size} 期望=${PROGRAM.length}`);

    const pcMismatch = [];
    for (const item of PROGRAM) {
      const group = [...byInsn.values()].find((entry) => BigInt(entry.begin.pc) === BigInt(item.linear));
      if (!group) {
        pcMismatch.push(`${item.asm}@${hex(item.linear)} 没有 begin`);
        continue;
      }
      item.group = group;
      if (group.begin.instructionId !== `insn-${group.begin.seq}`) {
        pcMismatch.push(`${item.asm}: instructionId ${group.begin.instructionId} != insn-${group.begin.seq}`);
      }
      if (group.begin.detail?.length !== undefined) {
        pcMismatch.push(`${item.asm}: begin 不应带指令长度`);
      }
    }
    check('C5 每条 begin 的 pc/instructionId 与 blob 中该指令的线性地址一一对应',
      pcMismatch.length === 0, pcMismatch.join('; ') || `${PROGRAM.length} 条指令全部对上`);

    const retireMismatch = [];
    for (const item of PROGRAM) {
      const group = item.group;
      if (!group) continue;
      if (item.retire) {
        if (!group.retire) {
          retireMismatch.push(`${item.asm}@${hex(item.linear)} 缺少 instruction.retire`);
          continue;
        }
        if (group.retire.detail?.length !== item.length) {
          retireMismatch.push(`${item.asm}: retire length ${group.retire.detail?.length} != ${item.length}`);
        }
        if (group.retire.phase !== 'complete') {
          retireMismatch.push(`${item.asm}: retire phase=${group.retire.phase}`);
        }
      } else if (group.retire) {
        retireMismatch.push(`${item.asm}@${hex(item.linear)} 不该有 retire`);
      }
    }
    check('C6 12 条正常完成的指令都有 retire，长度等于真实指令长度（in/out 也在内）',
      retireMismatch.length === 0,
      retireMismatch.join('; ') || `retire=${list.filter((e) => e.kind === 'instruction.retire').length} 条`);

    const ud2 = LAST.group;
    const trap = ud2.body.find((event) => event.kind === 'exception.raise');
    check('C7 ud2 只产生 exception.raise(vector 6) 而不产生 retire',
      Boolean(trap) && ud2.retire === null && ud2.begin.pc === hex(LAST.linear),
      `retire=${ud2.retire} trap=${trap?.kind}/${trap?.detail?.vector}`);
    check('C8 异常事件字段完备且是同步 fault（isHw/isInt=false，nextEip 为出错指令自身的 EIP）',
      trap && trap.phase === 'raise' && trap.detail.vector === 6
      && trap.detail.errorCode === 0 && trap.detail.isHw === false && trap.detail.isInt === false
      && BigInt(trap.detail.nextEip) === BigInt(LAST.eip) && BigInt(trap.pc) === BigInt(LAST.linear),
      JSON.stringify(trap?.detail));

    const accessMismatch = [];
    const bytesMismatch = [];
    for (const item of PROGRAM) {
      const group = item.group;
      if (!group) continue;
      const observed = group.body.filter((event) => event.kind.startsWith('memory')
        || event.kind.startsWith('io'));
      const wanted = item.events.filter((event) => event.kind.startsWith('memory')
        || event.kind.startsWith('io'));
      if (observed.length !== wanted.length) {
        accessMismatch.push(`${item.asm}: 访存/端口事件 ${observed.length} != ${wanted.length}`);
        continue;
      }
      for (let i = 0; i < wanted.length; i += 1) {
        const want = wanted[i];
        const got = observed[i];
        const space = want.kind.startsWith('memory') ? 'linear' : 'io-port';
        if (got.kind !== want.kind || got.phase !== 'complete' || got.size !== want.size
          || got.addressSpace !== space
          || (want.address !== undefined && BigInt(got.address) !== BigInt(want.address))) {
          accessMismatch.push(`${item.asm}: ${got.kind}/${got.phase}/${got.size}/${got.addressSpace}/${got.address} != ${JSON.stringify(want)}`);
        }
        if (want.value !== undefined && got.detail.value !== want.value) {
          accessMismatch.push(`${item.asm}: value ${got.detail.value} != ${want.value}`);
        }
        if (got.byteOrder !== 'little') {
          bytesMismatch.push(`${item.asm}: byteOrder=${got.byteOrder}`);
        }
        if (got.bytes === undefined) {
          bytesMismatch.push(`${item.asm}: 缺少 bytes`);
        } else if (valueOfBytes(got.bytes) !== got.detail.value) {
          bytesMismatch.push(`${item.asm}: bytes=${got.bytes} 与 value=${got.detail.value} 不自洽`);
        } else if (Buffer.from(got.bytes, 'base64').length !== want.size) {
          bytesMismatch.push(`${item.asm}: bytes 长度 != size ${want.size}`);
        }
      }
    }
    check('C9 每次访存/端口访问的 kind/phase/size/addressSpace/address/value 全部精确匹配',
      accessMismatch.length === 0,
      accessMismatch.join('; ') || 'memory.read x2 / memory.write x1 / io.read x2 / io.write x2 全部匹配');
    check('C10 数值统一用 bytes + byteOrder=little 表达且与 value 自洽',
      bytesMismatch.length === 0, bytesMismatch.join('; ') || '7 条访存/端口事件的 bytes 全部自洽');
    check('C11 memory 事件带 mmuIndex，io 事件不带（记录里是 MMU_NONE）',
      PROGRAM.every((item) => item.group?.body.every((event) => (event.kind.startsWith('memory')
        ? typeof event.detail.mmuIndex === 'number'
        : event.detail.mmuIndex === undefined))),
      JSON.stringify(PROGRAM.flatMap((item) => item.group?.body ?? [])
        .map((event) => [event.kind, event.detail.mmuIndex])));
    check('C12 所有事件都带可信 pc（不靠 0 冒充）',
      list.every((event) => typeof event.pc === 'string' && BigInt(event.pc) > 0n),
      `pc 缺失=${list.filter((event) => !event.pc).length}`);

    /* ---------- D. 独立通道交叉验证 ---------- */
    /*
     * HMP 格式串是 /[count][size][format]：/1xw 读一个 4 字节十六进制值，
     * /1xh 2 字节，/1xb 1 字节。显式给出宽度，才能与事件的 size 一一对照。
     */
    const xpEax = await qmp.hmp('xp /1xw 0x20000');
    const xpAx = await qmp.hmp('xp /1xh 0x30000');
    const xpAl = await qmp.hmp('xp /1xb 0x40000');
    const hmpLsr = await qmp.hmp('i /1xb 0x3fd');
    const hmpRegisters = await qmp.hmp('info registers');
    evidence.hmp = { xpEax, xpAx, xpAl, lsr: hmpLsr, registers: hmpRegisters };

    /* 内存转储形如 `<addr>: 0x<hex>`，端口读形如 `portb[0x03fd] = 0x60`。 */
    const readValue = (text) => {
      const match = text.match(/:\s*0x([0-9a-f]+)/) ?? text.match(/=\s*0x([0-9a-f]+)/);
      return match ? hex(`0x${match[1]}`) : null;
    };
    const eventOf = (asm) => PROGRAM.find((item) => item.asm === asm).group.body[0];
    check('D1 HMP `xp /x4 0x20000` 与 memory.read 事件一致',
      readValue(xpEax) === eventOf('mov eax,[0x20000]').detail.value,
      `hmp=${readValue(xpEax)} event=${eventOf('mov eax,[0x20000]').detail.value}`);
    check('D2 HMP `xp /x2 0x30000` 与 memory.write 事件一致（含 bytes）',
      readValue(xpAx) === eventOf('mov [0x30000],ax').detail.value
      && Buffer.from(eventOf('mov [0x30000],ax').bytes, 'base64').toString('hex') === 'efbe',
      `hmp=${readValue(xpAx)} event=${eventOf('mov [0x30000],ax').detail.value}`);
    check('D3 HMP `xp /x1 0x40000` 与 memory.read 事件一致',
      readValue(xpAl) === eventOf('mov al,[0x40000]').detail.value,
      `hmp=${readValue(xpAl)} event=${eventOf('mov al,[0x40000]').detail.value}`);
    check('D4 宿主通道 HMP `i 0x3fd` 与客体 io.read 事件的值一致',
      readValue(hmpLsr) === eventOf('in al,dx').detail.value,
      `hmp=${readValue(hmpLsr)} event=${eventOf('in al,dx').detail.value}`);

    const serialDeadline = Date.now() + 3000;
    while (Buffer.concat(serialChunks).length === 0 && Date.now() < serialDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const serialBuffer = Buffer.concat(serialChunks);
    evidence.serial = serialBuffer.toString('hex');
    check('D5 串口 socket 真的收到 `out dx,al` 的 0x37（设备侧独立证据）',
      serialBuffer.includes(0x37), `serial=${serialBuffer.toString('hex')}`);

    const capture = await qmp.command('x-oslab-capture');
    evidence.capture = capture;
    /*
     * T05e 起 capture 会在台账快照之后自己记一条 capture.fence，它从同一个
     * seq 计数器取号，并被当作这一帧的 eventWatermark。collected 是在 capture
     * 之前读的，其后没再产生事件，因此水位线应当正好大 1。
     */
    check('D6 capture 的 eventWatermark 就是 capture.fence 的 seq（= 采集前水位线 + 1），且与 capture.events 自述一致',
      capture.ok === true && BigInt(capture.fenceSeq ?? '0') !== 0n
      && capture.eventWatermark === capture.fenceSeq
      && capture.events?.watermark === capture.eventWatermark
      && capture.events?.enabled === true
      && BigInt(capture.eventWatermark) === BigInt(collected.watermark) + 1n,
      `capture=${capture.eventWatermark} fence=${capture.fenceSeq} 采集前=${collected.watermark}`);
    const fenceRead = await qmp.command('x-oslab-events', { from: capture.fenceSeq, limit: 1 });
    check('D6b 事件环里确实存着这条 capture.fence（seq = eventWatermark，pendingBlockRequests = 采集时 pending 块请求数）',
      fenceRead.ok === true && fenceRead.events?.length === 1
      && fenceRead.events[0].kind === 'capture.fence'
      && fenceRead.events[0].seq === capture.fenceSeq
      && fenceRead.events[0].detail?.pendingBlockRequests === capture.pendingIo?.count,
      JSON.stringify({ read: fenceRead.events?.slice(0, 1), pendingIo: capture.pendingIo?.count }));

    const physical = await qmp.command('x-oslab-read-physical', {
      captureId: capture.captureId, address: '0x30000', length: 2,
    });
    check('D7 x-oslab-read-physical 读回的字节与 memory.write 事件一致（快照与事件同一真相）',
      physical.ok === true
      && Buffer.from(physical.bytes, 'base64').equals(Buffer.from(eventOf('mov [0x30000],ax').bytes, 'base64')),
      `physical=${Buffer.from(physical.bytes ?? '', 'base64').toString('hex')}`);

    const resetWhileCapture = await qmp.command('x-oslab-events', { reset: true });
    check('D8 capture 活跃时 reset 被拒绝（capture-active）',
      resetWhileCapture.ok === false && resetWhileCapture.reason === 'capture-active',
      `reason=${resetWhileCapture.reason}`);

    const beforeProbe = await qmp.command('x-oslab-events', { limit: 1 });
    await qmp.hmp('i /1xb 0x3fd');
    await qmp.hmp('o /1xb 0x3f8 0x41');
    const afterProbe = await qmp.command('x-oslab-events', { limit: 1 });
    const serialAfterProbe = Buffer.concat(serialChunks);
    evidence.hostProbe = {
      watermarkBefore: beforeProbe.watermark,
      watermarkAfter: afterProbe.watermark,
      serial: serialAfterProbe.toString('hex'),
    };
    check('D9 宿主探针（HMP i/o）不进入客体事件流，但确实到达设备',
      afterProbe.watermark === beforeProbe.watermark
      && serialAfterProbe.toString('hex') === '3741',
      `watermark ${beforeProbe.watermark} -> ${afterProbe.watermark}，串口=${serialAfterProbe.toString('hex')}`);

    const released = await qmp.command('x-oslab-release', { captureId: capture.captureId });
    check('D10 release 之后 captureId 不再有效',
      released.released === true, JSON.stringify(released));

    /* ---------- E. 分块、过滤与丢失计数 ---------- */
    const afterAll = await qmp.command('x-oslab-events', { limit: 256 });
    const nextSeq = afterAll.watermark;
    const beyond = await qmp.command('x-oslab-events', {
      from: Number(BigInt(nextSeq) + 1n), limit: 8,
    });
    check('E1 请求水位线之后的区间返回空并回报 nextSeq',
      beyond.returned === 0 && beyond.nextSeq === String(BigInt(nextSeq) + 1n),
      `returned=${beyond.returned} nextSeq=${beyond.nextSeq}`);
    const inverted = await qmp.command('x-oslab-events', { from: 5, to: 3, limit: 8 });
    check('E2 from > to 返回空而不是报错',
      inverted.ok === true && inverted.returned === 0, `returned=${inverted.returned}`);

    const singlePass = await qmp.command('x-oslab-events', { from: 1, limit: 256 });
    const chunks = [];
    let cursor = 1;
    for (let guard = 0; guard < 64; guard += 1) {
      const part = await qmp.command('x-oslab-events', { from: cursor, limit: 5 });
      chunks.push(...part.events.map((event) => event.seq));
      cursor = Number(BigInt(part.nextSeq));
      if (part.returned === 0 || cursor > Number(BigInt(singlePass.watermark))) break;
    }
    check('E3 按 nextSeq 分块读取拼出的序列与单次读取完全一致',
      JSON.stringify(chunks) === JSON.stringify(singlePass.events.map((event) => event.seq)),
      `分块=${chunks.length} 单次=${singlePass.events.length}`);

    const filtered = await qmp.command('x-oslab-events', {
      from: 1, limit: 256, kinds: ['memory.read', 'memory.write'],
    });
    check('E4 kinds 过滤只返回被选中的 kind，并报告被过滤条数',
      filtered.returned === 3 && filtered.filtered > 0
      && filtered.events.every((event) => event.kind.startsWith('memory.')),
      `returned=${filtered.returned} filtered=${filtered.filtered}`);
    const unknown = await qmp.command('x-oslab-events', {
      from: 1, limit: 8, kinds: ['memory.read', 'not.a.kind'],
    });
    check('E5 认不出的 kind 如实进 unknownKinds，不静默变成「全都要」',
      JSON.stringify(unknown.unknownKinds) === JSON.stringify(['not.a.kind'])
      && unknown.events.every((event) => event.kind === 'memory.read')
      && JSON.stringify(unknown.kinds) === JSON.stringify(['memory.read', 'not.a.kind']),
      `unknownKinds=${JSON.stringify(unknown.unknownKinds)} returned=${unknown.returned}`);

    const zeroLimit = await qmp.command('x-oslab-events', { limit: 0 });
    const overLimit = await qmp.command('x-oslab-events', { limit: 65537 });
    check('E6 limit 越界（0 / > capacity）被拒绝（invalid-limit）',
      zeroLimit.ok === false && zeroLimit.reason === 'invalid-limit'
      && overLimit.ok === false && overLimit.reason === 'invalid-limit',
      `${zeroLimit.reason} / ${overLimit.reason}`);
    const badCapture = await qmp.command('x-oslab-events', {
      captureId: 'cap-does-not-exist', limit: 8,
    });
    check('E7 非法 captureId 被拒绝（capture-mismatch）',
      badCapture.ok === false && badCapture.reason === 'capture-mismatch', badCapture.reason);

    /*
     * 最后才让客体真正跑起来：单步证据已经全部取完，BIOS 进入保护模式不再
     * 影响任何断言。这段既做压力（环满与 drop 计数），也验证「VM 运行中
     * 不允许改变采集开关」这条拒绝路径（开关值必须真的发生变化才会拦）。
     */
    await qmp.command('cont');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const runningEnable = await qmp.command('x-oslab-events', { enable: false });
    evidence.runningEnable = runningEnable;
    check('E12 VM 运行中改变 enable 被拒绝（vm-running）且开关不被改动',
      runningEnable.ok === false && runningEnable.rejected === true
      && runningEnable.reason === 'vm-running' && runningEnable.enabled === true,
      `reason=${runningEnable.reason} runState=${runningEnable.runState} enabled=${runningEnable.enabled}`);
    const runningReset = await qmp.command('x-oslab-events', { reset: true });
    check('E13 VM 运行中 reset 被拒绝（vm-running）',
      runningReset.ok === false && runningReset.rejected === true
      && runningReset.reason === 'vm-running',
      `reason=${runningReset.reason} runState=${runningReset.runState}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await qmp.command('stop');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const saturated = await qmp.command('x-oslab-events', { from: 1, limit: 4 });
    evidence.saturated = saturated;
    const watermark = BigInt(saturated.watermark);
    const oldest = BigInt(saturated.oldest);
    check('E8 环满后 watermark/oldest/dropped 满足精确关系',
      saturated.ok === true && saturated.dropped !== '0' && oldest > 1n
      && oldest === watermark - 65536n + 1n,
      `watermark=${saturated.watermark} oldest=${saturated.oldest} dropped=${saturated.dropped}`);
    check('E9 请求已丢失区间时给出精确 droppedInRange 与 truncated 语义',
      saturated.returned === 4 && saturated.truncated === true
      && BigInt(saturated.droppedInRange) === oldest - 1n
      && saturated.scanned === 65536,
      `droppedInRange=${saturated.droppedInRange} scanned=${saturated.scanned} truncated=${saturated.truncated}`);
    check('E10 truncated 时 nextSeq 仍可续读（等于最后返回的 seq+1）',
      BigInt(saturated.nextSeq) === BigInt(saturated.events[saturated.events.length - 1].seq) + 1n,
      `nextSeq=${saturated.nextSeq} last=${saturated.events[saturated.events.length - 1].seq}`);
    const afterSaturation = await qmp.command('x-oslab-events', {
      from: Number(saturated.nextSeq), limit: 8,
    });
    check('E11 从 nextSeq 续读能拿到更靠后的事件（不会卡住）',
      afterSaturation.returned === 8
      && BigInt(afterSaturation.events[0].seq) === BigInt(saturated.nextSeq),
      `returned=${afterSaturation.returned} first=${afterSaturation.events[0]?.seq}`);

    rsp.socket.destroy();
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
  }

  evidence.checks = results;
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