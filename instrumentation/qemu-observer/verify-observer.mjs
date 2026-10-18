#!/usr/bin/env node
/**
 * T05a 观察扩展验收（真实 QEMU，不经过 lab-server）。
 *
 * 覆盖：
 *   A. x-oslab-capabilities 的协议字段与诚实标注
 *   B. x-oslab-capture 的 CPU 扩展状态（段缓存/EFER/控制寄存器/CR8）与
 *      HMP `info registers` + `info lapic` 这份**独立 dump** 逐字段一致
 *   C. x-oslab-capture 的物理区域表与 HMP `info mtree -f` 的 FlatView 一致
 *   D. x-oslab-read-physical 的允许范围与拒绝路径（MMIO / 越界 / 越区域 /
 *      非法 captureId / release 之后 / VM 推进之后）
 *   E. x-oslab-release 的语义
 *
 * 用法：
 *   node instrumentation/qemu-observer/verify-observer.mjs
 *
 * 证据输出：artifacts/verify/t05a-observer.json
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const QEMU = path.join(ROOT, 'artifacts/build/qemu/qemu-system-x86_64');
const WORK = path.join(ROOT, 'var/tmp/t05a-verify');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05a-observer.json');

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  const marker = ok ? '通过' : '未通过';
  console.log(`[${marker}] ${id}${detail ? ` :: ${detail}` : ''}`);
}

/* --------------------------------------------------------------- QMP 客户端 */

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
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ execute, arguments: args ?? {}, id })}\n`);
    });
  }

  /** 命令成功时返回 return 载荷，QMP 错误时抛出。 */
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

/* ------------------------------------------------------------------ 解析器 */

function toBig(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** 十六进制归一化（无前缀、无前导零），便于跨来源比较。 */
function normHex(value) {
  const big = toBig(value);
  return big === null ? null : `0x${big.toString(16)}`;
}

function parseInfoRegisters(text) {
  const out = { segments: {}, gpr: {}, control: {}, other: {} };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let match = line.match(
      /^(CS|SS|DS|ES|FS|GS|LDT|TR)\s*=([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s*$/,
    );
    if (match) {
      const key = match[1].toLowerCase();
      out.segments[key] = {
        selector: normHex(`0x${match[2]}`),
        base: normHex(`0x${match[3]}`),
        limit: normHex(`0x${match[4]}`),
        attributes: normHex(`0x${match[5]}`),
      };
      continue;
    }
    match = line.match(/^(GDT|IDT)=\s*([0-9a-f]+)\s+([0-9a-f]+)\s*$/);
    if (match) {
      out.other[match[1].toLowerCase()] = {
        base: normHex(`0x${match[2]}`),
        limit: normHex(`0x${match[3]}`),
      };
      continue;
    }
    match = line.match(
      /^CR0=([0-9a-f]+) CR2=([0-9a-f]+) CR3=([0-9a-f]+) CR4=([0-9a-f]+)/,
    );
    if (match) {
      out.control.cr0 = normHex(`0x${match[1]}`);
      out.control.cr2 = normHex(`0x${match[2]}`);
      out.control.cr3 = normHex(`0x${match[3]}`);
      out.control.cr4 = normHex(`0x${match[4]}`);
      continue;
    }
    match = line.match(/^EFER=([0-9a-f]+)/);
    if (match) {
      out.control.efer = normHex(`0x${match[1]}`);
      continue;
    }
    match = line.match(/^(RIP|EIP)=([0-9a-f]+)/);
    if (match) {
      out.other.pc = normHex(`0x${match[2]}`);
      continue;
    }
    match = line.match(/^(RFL|EFL)=([0-9a-f]+)/);
    if (match) {
      out.other.rflags = normHex(`0x${match[2]}`);
      continue;
    }
    match = line.match(/(?:^|\s)CPL=(\d)/);
    if (match) out.other.cpl = Number(match[1]);
    match = line.match(/(?:^|\s)HLT=(\d)/);
    if (match) out.other.hlt = match[1] === '1';
    match = line.match(/(?:^|\s)A20=(\d)/);
    if (match) out.other.a20 = match[1] === '1';
    const gpr = line.match(/\b([RE](?:AX|BX|CX|DX|SI|DI|BP|SP)|R(?:8|9|1[0-5]))=([0-9a-f]+)/g);
    if (gpr) {
      for (const item of gpr) {
        const [name, value] = item.split('=');
        out.gpr[name.toLowerCase()] = normHex(`0x${value}`);
      }
    }
  }
  return out;
}

function parseLapicTpr(text) {
  const match = text.match(/\bTPR\s+0x([0-9a-f]+)/i);
  return match ? normHex(`0x${match[1]}`) : null;
}

/**
 * 只取 AddressSpace "memory" 那一份 FlatView（观察者读的是 address_space_memory）。
 * HMP 会打印所有 AddressSpace，必须按块切分而不能全局匹配。
 */
function parseMtreeFlatview(text) {
  const lines = text.split('\n');
  const block = [];
  let collecting = false;
  for (const line of lines) {
    if (/^FlatView #/.test(line)) {
      collecting = false;
      continue;
    }
    if (/^\s+AS\s+"memory",\s+root:\s+system/.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/^\s+AS\s+"/.test(line)) {
      // 同一 FlatView 内的其他 AddressSpace，忽略
      continue;
    }
    const match = line.match(
      /^\s+([0-9a-f]{16})-([0-9a-f]{16}) \(prio \d+, ([^)]+)\): (\S+)/,
    );
    if (!match) continue;
    block.push({
      start: normHex(`0x${match[1]}`),
      end: normHex(`0x${match[2]}`),
      type: match[3].trim(),
      name: match[4],
    });
  }
  return block;
}

const readableTypes = new Set(['ram', 'rom']);

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
  const serialPath = path.join(WORK, 'serial.sock');
  const diskPath = path.join(WORK, 'rootfs.qcow2');
  const base = path.join(ROOT, 'artifacts/rootfs.img');
  if (fs.existsSync(base)) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('qemu-img', ['create', '-f', 'qcow2', '-F', 'raw', '-b', base, diskPath]);
  }

  const args = [
    '-machine', 'pc',
    '-cpu', 'qemu64',
    '-accel', 'tcg,thread=single',
    '-smp', '1',
    '-m', '512',
    '-display', 'none',
    '-nodefaults',
    '-device', 'VGA',
    '-device', 'isa-serial,chardev=serial0',
    '-chardev', `socket,id=serial0,path=${serialPath},server=on,wait=off`,
    '-qmp', `unix:${qmpPath},server=on,wait=off`,
    '-S',
    '-no-reboot',
  ];
  if (fs.existsSync(diskPath)) {
    args.push(
      '-drive', `file=${diskPath},format=qcow2,if=none,id=rootdisk`,
      '-device', 'virtio-blk-pci,drive=rootdisk,id=rootblk',
    );
  }

  const logFd = fs.openSync(path.join(WORK, 'qemu.log'), 'w');
  const proc = spawn(QEMU, args, { cwd: ROOT, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);

  let procExit = null;
  proc.on('exit', (code, signal) => {
    procExit = { code, signal };
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(qmpPath)) {
    if (procExit) fail(`QEMU 提前退出: ${JSON.stringify(procExit)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!fs.existsSync(qmpPath)) fail('等待 QMP socket 超时');

  const qmp = await QmpClient.connect(qmpPath);
  const evidence = { schema: 'oslab.t05a-evidence/1', qemu: QEMU, args, checks: results };

  try {
    /* ---------- A. capabilities ---------- */
    const caps = await qmp.command('x-oslab-capabilities');
    evidence.capabilities = caps;
    check('A1 capabilities.protocolVersion === 1', caps.protocolVersion === 1,
      `protocolVersion=${caps.protocolVersion}`);
    check('A2 capabilities.schema === x-oslab/1', caps.schema === 'x-oslab/1', caps.schema);
    check('A3 patched === true', caps.patched === true, `patched=${caps.patched}`);
    check('A4 段缓存/控制寄存器/EFER 声明为可观测',
      caps.cpu?.segmentCache === true && caps.cpu?.controlRegisters === true
      && caps.cpu?.efer === true && caps.cpu?.cr8FromApicTpr === true,
      JSON.stringify(caps.cpu));
    check('A5 停止屏障声明支持且要求全部 vCPU 停止',
      caps.stopBarrier?.supported === true
      && caps.stopBarrier?.requiresAllVcpusStopped === true,
      JSON.stringify(caps.stopBarrier));
    check('A6 事件序列已支持，且自述 kind 集合与已交付子任务逐项对齐（T05b 八类 + T05c 四类 + T05e capture.fence）',
      caps.events?.supported === true && caps.events?.enabled === false
      && caps.events?.watermark === '0' && caps.lostEvents === 0
      && Array.isArray(caps.events?.kinds)
      && [...caps.events.kinds].sort().join(',') === [
        'block.complete', 'block.submit', 'capture.fence', 'dma.read', 'dma.write',
        'exception.raise', 'instruction.begin', 'instruction.retire', 'interrupt.accept',
        'io.read', 'io.write', 'memory.read', 'memory.write',
      ].join(','),
      JSON.stringify({ supported: caps.events?.supported, enabled: caps.events?.enabled,
        watermark: caps.events?.watermark, lostEvents: caps.lostEvents,
        kinds: caps.events?.kinds }));
    check('A7 物理读只允许 ram/rom/romd 且声明拒绝 MMIO',
      caps.memory?.physicalRead === 'ram-rom-only' && caps.memory?.rejectsMmio === true,
      JSON.stringify(caps.memory));
    const gaps = Array.isArray(caps.unavailable) ? caps.unavailable : [];
    const missingKinds = Array.isArray(caps.events?.unavailableKinds) ? caps.events.unavailableKinds : [];
    // 观察者在清单里按「族」书写（irq / input / serial / observer.drop），
    // 逐字比对 kind 名会假失败，因此按族核对，并要求清单明确指向权威列表。
    const family = (kind) => (kind.startsWith('irq.') ? 'irq' : kind.split('.')[0]);
    const missingFamilies = [...new Set(missingKinds.map(family))];
    check('A8 未实现清单只列真未交付项（T06 起），并逐项说明 dma/block 自 T05c、capture.fence 自 T05e 可用',
      gaps.length > 0
      && !gaps.some((item) => /T05[abcde]/.test(item.replace(/自 T05[ace] 起可用/g, '')))
      && gaps.some((item) => item.includes('T06'))
      && gaps.some((item) => item.includes('自 T05c 起可用'))
      && gaps.some((item) => item.includes('capture.fence 自 T05e 起可用'))
      && missingFamilies.length === 4
      && gaps.some((item) => item.includes('events.unavailableKinds')
        && missingFamilies.every((name) => item.includes(name))),
      JSON.stringify({ unavailable: gaps, unavailableKinds: missingKinds, missingFamilies }));

    /* ---------- B/C. capture + 独立 dump 对照 ---------- */
    const capture = await qmp.command('x-oslab-capture');
    evidence.capture = capture;
    check('B1 capture.ok === true 且返回 captureId',
      capture.ok === true && typeof capture.captureId === 'string', capture.captureId);
    check('B2 记录全部 vCPU 停止与运行态',
      capture.allVcpusStopped === true && capture.vmRunning === false
      && capture.vcpuCount === 1,
      `runState=${capture.runState} vcpuCount=${capture.vcpuCount}`);
    check('B3 标注执行上下文（main-loop + BQL）',
      capture.executionContext?.bqlHeld === true
      && capture.executionContext?.thread === 'main-loop',
      JSON.stringify(capture.executionContext));
    check('B4 executionContext.thread 为 main loop 且非协程分发',
      /BH/.test(capture.executionContext?.dispatch ?? ''), capture.executionContext?.dispatch);

    const hmpRegisters = await qmp.hmp('info registers');
    const hmpLapic = await qmp.hmp('info lapic');
    const hmpMtree = await qmp.hmp('info mtree -f');
    evidence.hmp = { registers: hmpRegisters, lapic: hmpLapic, mtree: hmpMtree };
    const dump = parseInfoRegisters(hmpRegisters);
    evidence.parsedDump = dump;

    const cpu = capture.cpus[0];
    /*
     * HMP `info registers` 把 LDT 寄存器印成 `LDT=`，而 x-oslab/1 协议按架构
     * 寄存器名暴露为 `ldtr`（QEMU 内部字段是 CPUX86State.ldt）。两者是同一
     * 寄存器的不同拼写，显式给出别名，避免把命名差异误判成数值不一致。
     */
    const segmentAliases = { ldt: 'ldtr' };
    const segMismatch = [];
    const checkedSegments = new Set();
    for (const [name, expected] of Object.entries(dump.segments)) {
      const key = segmentAliases[name] ?? name;
      checkedSegments.add(key);
      const observed = cpu[key];
      if (!observed) {
        segMismatch.push(`${name}: 观察者缺失`);
        continue;
      }
      for (const field of ['selector', 'base', 'limit', 'attributes']) {
        if (normHex(observed[field]) !== expected[field]) {
          segMismatch.push(
            `${name}.${field}: observer=${normHex(observed[field])} hmp=${expected[field]}`,
          );
        }
      }
    }
    // 反向检查：协议里多出来的段字段必须是已知别名之外的意外项。
    const extraSegments = ['cs', 'ss', 'ds', 'es', 'fs', 'gs', 'ldtr', 'tr']
      .filter((key) => cpu[key] && !checkedSegments.has(key));
    check('B5 段缓存（含隐藏基址）与 HMP 独立 dump 完全一致',
      segMismatch.length === 0 && extraSegments.length === 0 && checkedSegments.size === 8,
      [...segMismatch, ...extraSegments.map((key) => `${key}: 未被独立 dump 覆盖`)]
        .join('; ') || `cs/ss/ds/es/fs/gs/ldtr/tr 共 ${checkedSegments.size} 个段全部一致`);

    const ctlMismatch = [];
    for (const [field, expected] of Object.entries(dump.control)) {
      const observed = field === 'efer' ? cpu.efer : cpu.control?.[field];
      if (normHex(observed) !== expected) {
        ctlMismatch.push(`${field}: observer=${normHex(observed)} hmp=${expected}`);
      }
    }
    check('B6 CR0/CR2/CR3/CR4/EFER 与 HMP 独立 dump 一致',
      ctlMismatch.length === 0, ctlMismatch.join('; ') || '全部一致');

    const tpr = parseLapicTpr(hmpLapic);
    check('B7 CR8 与 HMP `info lapic` 的 TPR 一致',
      tpr !== null && normHex(cpu.control?.cr8) === tpr,
      `observer cr8=${normHex(cpu.control?.cr8)} lapic TPR=${tpr}`);

    check('B8 RIP/线性地址与独立 dump 一致',
      normHex(cpu.rip) === dump.other.pc
      && cpu.linearPc === `0x${(BigInt(dump.segments.cs.base) + BigInt(dump.other.pc)).toString(16)}`,
      `rip=${cpu.rip} linearPc=${cpu.linearPc} cs.base=${dump.segments.cs.base}`);

    check('B9 GDT/IDT 与独立 dump 一致',
      normHex(cpu.gdt.base) === dump.other.gdt.base
      && normHex(cpu.gdt.limit) === dump.other.gdt.limit
      && normHex(cpu.idt.base) === dump.other.idt.base
      && normHex(cpu.idt.limit) === dump.other.idt.limit,
      `gdt=${cpu.gdt.base}/${cpu.gdt.limit} idt=${cpu.idt.base}/${cpu.idt.limit}`);

    check('B10 EFER 位展开与原始值自洽',
      cpu.eferBits?.lma === ((BigInt(cpu.efer) & 0x400n) !== 0n)
      && cpu.eferBits?.lme === ((BigInt(cpu.efer) & 0x100n) !== 0n),
      JSON.stringify(cpu.eferBits));

    /* ---------- C. 区域表 ---------- */
    const mtree = parseMtreeFlatview(hmpMtree);
    evidence.mtreeMemory = mtree;
    const observerRegions = capture.readableRegions;
    const regionMismatch = [];
    for (const region of observerRegions) {
      const start = BigInt(region.base);
      const end = start + BigInt(region.size) - 1n;
      const match = mtree.find(
        (entry) => BigInt(entry.start) === start && BigInt(entry.end) === end,
      );
      if (!match) {
        regionMismatch.push(`${region.name}@${region.base}+${region.size} 在 mtree 中缺失`);
        continue;
      }
      if (match.name !== region.name) {
        regionMismatch.push(`${region.base}: observer=${region.name} mtree=${match.name}`);
      }
      const mtreeReadable = readableTypes.has(match.type);
      if (mtreeReadable !== region.readable) {
        regionMismatch.push(
          `${region.name}@${region.base}: readable 观察者=${region.readable} mtree(${match.type})=${mtreeReadable}`,
        );
      }
    }
    check('C1 区域数与 HMP `info mtree -f`(AS memory) 一致',
      observerRegions.length === mtree.length,
      `observer=${observerRegions.length} mtree=${mtree.length}`);
    check('C2 每个区域的名称/范围/可读性与 mtree 一致',
      regionMismatch.length === 0, regionMismatch.join('; ') || `${observerRegions.length} 个区域一致`);
    check('C3 可读区域数与 capture 统计一致',
      capture.readableRegionCount
      === observerRegions.filter((region) => region.readable).length,
      `readableRegionCount=${capture.readableRegionCount}`);
    check('C4 存在被明确标为不可读的 MMIO 区域',
      observerRegions.some((region) => !region.readable && region.kind === 'mmio'),
      observerRegions.filter((region) => region.kind === 'mmio').map((r) => r.name).join(','));

    /* ---------- D. 物理读取 ---------- */
    const captureId = capture.captureId;
    const resetVector = await qmp.command('x-oslab-read-physical', {
      captureId, address: '0xfffffff0', length: 16,
    });
    evidence.resetVector = resetVector;
    const resetBytes = Buffer.from(resetVector.bytes, 'base64');
    check('D1 复位向量物理读成功且落在 pc.bios(rom)',
      resetVector.ok === true && resetVector.region?.kind === 'rom'
      && resetVector.region?.name === 'pc.bios',
      `region=${resetVector.region?.name}/${resetVector.region?.kind} offset=${resetVector.region?.offsetInRegion}`);
    check('D2 复位向量前 5 字节为 ljmp $0xf000:$0xe05b',
      resetBytes.subarray(0, 5).toString('hex') === 'ea5be000f0',
      `bytes=${resetBytes.toString('hex')}`);
    check('D3 返回值带所属快照与代数',
      resetVector.captureId === captureId && resetVector.vmGeneration === capture.vmGeneration
      && resetVector.addressSpace === 'physical' && resetVector.encoding === 'base64',
      `captureId=${resetVector.captureId} vmGeneration=${resetVector.vmGeneration}`);

    const ramRead = await qmp.command('x-oslab-read-physical', {
      captureId, address: '0x100000', length: 64,
    });
    check('D4 RAM 读取成功且标为 ram',
      ramRead.ok === true && ramRead.region?.kind === 'ram'
      && Buffer.from(ramRead.bytes, 'base64').length === 64,
      `region=${ramRead.region?.name} length=${ramRead.length}`);

    const mmioTests = [];
    for (const region of observerRegions.filter((item) => !item.readable && item.kind === 'mmio')) {
      const result = await qmp.command('x-oslab-read-physical', {
        captureId, address: region.base, length: Math.min(16, Number(BigInt(region.size))),
      });
      mmioTests.push({ region: region.name, base: region.base, result });
    }
    evidence.mmioTests = mmioTests;
    check('D5 所有 MMIO 区域读取都被拒绝（无副作用）',
      mmioTests.length > 0 && mmioTests.every((item) => item.result.ok === false
        && item.result.rejected === true && item.result.reason === 'side-effect-risk'),
      mmioTests.map((item) => `${item.region}=${item.result.reason}`).join('; '));

    const tooLong = await qmp.command('x-oslab-read-physical', {
      captureId, address: '0xfffffff0', length: 8192,
    });
    check('D6 超过单次上限被拒绝（invalid-length）',
      tooLong.ok === false && tooLong.reason === 'invalid-length', tooLong.reason);

    const zeroLength = await qmp.command('x-oslab-read-physical', {
      captureId, address: '0xfffffff0', length: 0,
    });
    check('D7 length=0 被拒绝（invalid-length）',
      zeroLength.ok === false && zeroLength.reason === 'invalid-length', zeroLength.reason);

    const crossRegion = await qmp.command('x-oslab-read-physical', {
      captureId, address: '0x9ffff', length: 16,
    });
    check('D8 跨越 pc.ram 边界被拒绝（cross-region）',
      crossRegion.ok === false && crossRegion.reason === 'cross-region', crossRegion.reason);

    const badCapture = await qmp.command('x-oslab-read-physical', {
      captureId: 'cap-does-not-exist', address: '0xfffffff0', length: 16,
    });
    check('D9 非法 captureId 被拒绝（capture-mismatch）',
      badCapture.ok === false && badCapture.reason === 'capture-mismatch', badCapture.reason);

    let malformedRejected = false;
    try {
      await qmp.command('x-oslab-read-physical', {
        captureId, address: 'not-a-number', length: 16,
      });
    } catch {
      malformedRejected = true;
    }
    check('D10 非法 address 参数返回 QMP 错误而不是硬崩溃', malformedRejected);

    /* ---------- E. release 语义 ---------- */
    const released = await qmp.command('x-oslab-release', { captureId });
    check('E1 release 返回 released=true', released.released === true, JSON.stringify(released));
    const releaseAgain = await qmp.command('x-oslab-release', { captureId });
    check('E2 重复 release 返回 no-active-capture',
      releaseAgain.released === false && releaseAgain.reason === 'no-active-capture',
      releaseAgain.reason);
    const afterRelease = await qmp.command('x-oslab-read-physical', {
      captureId, address: '0xfffffff0', length: 16,
    });
    check('E3 release 之后读取被拒绝（no-active-capture）',
      afterRelease.ok === false && afterRelease.reason === 'no-active-capture',
      afterRelease.reason);

    /* ---------- VM 推进与运行中采集 ---------- */
    const before = await qmp.command('x-oslab-capture');
    await qmp.command('cont');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runningCapture = await qmp.command('x-oslab-capture');
    check('F1 VM 运行中 capture 被拒绝（vcpu-running）',
      runningCapture.ok === false && runningCapture.refused === true
      && runningCapture.reason === 'vcpu-running',
      JSON.stringify({ reason: runningCapture.reason, state: runningCapture.runState }));
    const advancedRead = await qmp.command('x-oslab-read-physical', {
      captureId: before.captureId, address: '0xfffffff0', length: 16,
    });
    check('F2 VM 推进后旧 captureId 读取被拒绝（vm-advanced）',
      advancedRead.ok === false && advancedRead.reason === 'vm-advanced', advancedRead.reason);

    await qmp.command('stop');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await qmp.command('x-oslab-capture');
    evidence.afterAdvance = { before: before.captureId, after: after.captureId };
    check('F3 VM 停止后可重新采集且代数递增',
      after.ok === true && BigInt(after.vmGeneration) > BigInt(before.vmGeneration),
      `before=${before.vmGeneration} after=${after.vmGeneration}`);
    check('F4 重新采集会取代旧快照并显式报告', after.supersededCaptureId === before.captureId,
      String(after.supersededCaptureId));
    const newCaptureRead = await qmp.command('x-oslab-read-physical', {
      captureId: after.captureId, address: '0xfffffff0', length: 16,
    });
    check('F5 新快照可正常读取', newCaptureRead.ok === true, String(newCaptureRead.ok));
    await qmp.command('x-oslab-release', { captureId: after.captureId });
  } finally {
    try {
      await qmp.command('quit');
    } catch {
      /* quit 会关闭连接，属预期 */
    }
    qmp.close();
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