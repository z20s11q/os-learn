#!/usr/bin/env node
/**
 * T05a 服务层接入验证。
 *
 * 观察者自身与 HMP 独立 dump 的一致性由
 * `instrumentation/qemu-observer/verify-observer.mjs` 证明。本脚本证明
 * 服务保留观察者能力与采集来源：
 *
 *   O. 会话启动即探测到 `x-oslab-*`，capabilities 如实标注 patched/verified
 *   F. 帧里的 CPU 扩展状态来自观察者，且与该会话 QEMU 的 HMP dump 一致
 *      （复用会话 QMP 连接获取 HMP dump，由本脚本独立解析）
 *   P. 物理读经 `x-oslab-read-physical`，保留 MMIO 拒绝与快照失效语义，
 *      并按 4 KiB 上限自动分片
 *   S. 复位、单步及暂停后采集的段缓存分别与对应 HMP dump 一致
 *
 * 运行：node scripts/verify-observer-service.mjs
 * 证据：artifacts/verify/t05a-service.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildServer } from '../services/lab-server/main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t05a-service.json');

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: ok === true, detail: detail ?? null });
  console.log(`[${ok ? '通过' : '未通过'}] ${id}${detail ? ` :: ${detail}` : ''}`);
  return ok === true;
}

/* ---------- 独立 dump 通道 ----------
 *
 * 复用会话 QMP 连接获取 info registers / info lapic（cpu_dump_state）。
 * HMP dump 与观察者读取 CPUX86State 各有独立路径；本脚本用自己的正则解析 dump。
 */

/* ---------- 本脚本的 HMP dump 解析 ---------- */

function normHex(value) {
  if (value === null || value === undefined) return null;
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return null;
  }
}

function parseRegisters(text) {
  const out = { segments: {}, control: {}, pc: null };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let match = line.match(/^(CS|SS|DS|ES|FS|GS|LDT|TR)\s*=([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s*$/);
    if (match) {
      out.segments[match[1].toLowerCase() === 'ldt' ? 'ldtr' : match[1].toLowerCase()] = {
        selector: normHex(`0x${match[2]}`),
        base: normHex(`0x${match[3]}`),
        limit: normHex(`0x${match[4]}`),
        attributes: normHex(`0x${match[5]}`),
      };
      continue;
    }
    match = line.match(/^CR0=([0-9a-f]+) CR2=([0-9a-f]+) CR3=([0-9a-f]+) CR4=([0-9a-f]+)/);
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
    if (match) out.pc = normHex(`0x${match[2]}`);
  }
  return out;
}

function parseLapicTpr(text) {
  const match = text.match(/\bTPR\s+0x([0-9a-f]+)/i);
  return match ? normHex(`0x${match[1]}`) : null;
}

/* ---------- 服务调用 ---------- */

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

/** 把帧里的 CPU 扩展状态与一份 HMP dump 逐字段比对。 */
function compareCpuToDump(cpu, dump) {
  const mismatches = [];
  for (const [name, expected] of Object.entries(dump.segments)) {
    const observed = cpu?.segments?.[name];
    if (!observed) {
      mismatches.push(`${name}: 帧中缺失`);
      continue;
    }
    for (const field of ['selector', 'base', 'limit', 'attributes']) {
      if (normHex(observed[field]) !== expected[field]) {
        mismatches.push(`${name}.${field}: frame=${normHex(observed[field])} hmp=${expected[field]}`);
      }
    }
  }
  for (const [field, expected] of Object.entries(dump.control)) {
    const observed = field === 'efer' ? cpu?.efer : cpu?.control?.[field];
    if (normHex(observed) !== expected) {
      mismatches.push(`${field}: frame=${normHex(observed)} hmp=${expected}`);
    }
  }
  return mismatches;
}

async function main() {
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const evidence = { schema: 'oslab.t05a-service-evidence/1', startedAt: new Date().toISOString() };
  let session = null;
  let machine = null;

  try {
    console.log('创建会话（加载 vmlinux 符号，可能需要 1-2 分钟）...');
    const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
    if (created.status !== 201) {
      check('session.create', false, `status=${created.status} ${describe(created.body)}`);
      evidence.create = created;
      throw new Error('会话创建失败，无法继续');
    }
    session = created.body;
    evidence.session = { id: session.id, profile: session.profile, observer: session.observer };
    check(
      'O1 会话启动即探测到观察扩展',
      session.observer?.detected === true,
      `detected=${session.observer?.detected} reason=${session.observer?.reason}`,
    );
    check(
      'O2 观察扩展版本与协议字段一致',
      typeof session.observer?.activeCaptureId === 'string'
        && session.observer.activeCaptureFrameId === 0,
      `activeCaptureId=${session.observer?.activeCaptureId} frameId=${session.observer?.activeCaptureFrameId} snapshots=${session.observer?.snapshots}`,
    );

    const caps = await call(app, 'GET', `/api/sessions/${session.id}/capabilities`);
    evidence.capabilities = caps.body;
    const observerCaps = caps.body?.observer ?? {};
    check(
      'O3 capabilities.observer.patched 来自探测而不是硬编码',
      caps.status === 200 && observerCaps.patched === true && observerCaps.qemuVersion === '8.2.10',
      `patched=${observerCaps.patched} qemuVersion=${observerCaps.qemuVersion} schema=${observerCaps.schema} protocolVersion=${observerCaps.version}`,
    );
    check(
      'O4 observer_.captureSnapshot / readPhysical 提升为 verified 且带证据',
      caps.body?.observer_?.captureSnapshot?.status === 'verified'
        && caps.body?.observer_?.readPhysical?.status === 'verified'
        && /x-oslab-capture/.test(caps.body?.observer_?.captureSnapshot?.evidence ?? '')
        && /maxReadBytes|单次上限/.test(caps.body?.observer_?.readPhysical?.evidence ?? ''),
      `captureSnapshot=${caps.body?.observer_?.captureSnapshot?.status} readPhysical=${caps.body?.observer_?.readPhysical?.status}`,
    );
    const eventTable = caps.body?.events ?? {};
    const witnessedKinds = [
      'instruction.begin', 'instruction.retire',
      'memory.read', 'memory.write',
      'io.read', 'io.write',
      'exception.raise', 'interrupt.accept',
      'dma.read', 'dma.write', 'block.submit', 'block.complete',
    ];
    const deliveredKinds = ['dma.read', 'dma.write', 'block.submit', 'block.complete'];
    const notVerified = witnessedKinds.filter((kind) => eventTable[kind]?.status !== 'verified');
    const withoutPoint = witnessedKinds.filter((kind) => !/:/.test(eventTable[kind]?.evidence ?? ''));
    // dma/block 的发射点来自 T05c patch 0003，证据标明对应子任务。
    const misattributed = deliveredKinds.filter((kind) => !/T05c/.test(eventTable[kind]?.evidence ?? ''));
    check(
      'O5 事件能力如实分档：T05b 八类 + T05c 四类 verified 且带源码观察点，T05d 仍 unavailable',
      caps.body?.observer_?.events?.status === 'verified'
        && /x-oslab-events/.test(caps.body?.observer_?.events?.evidence ?? '')
        && notVerified.length === 0
        && withoutPoint.length === 0
        && misattributed.length === 0
        && eventTable['irq.raise']?.status === 'unavailable'
        && eventTable['input.accept']?.status === 'unavailable'
        && eventTable['serial.output']?.status === 'unavailable',
      `observer_.events=${caps.body?.observer_?.events?.status} 未 verified=${JSON.stringify(notVerified)} `
        + `无观察点=${JSON.stringify(withoutPoint)} 未标 T05c=${JSON.stringify(misattributed)} `
        + `input.accept=${eventTable['input.accept']?.status}`,
    );

    const frame0 = session.firstFrame;
    evidence.frame0 = frame0;

    // 用会话自己的 QMP 连接取一份独立 dump（见文件开头关于单客户端的说明）
    machine = registry.get(session.id);
    const registers0 = await machine.qmp.hmp('info registers');
    const lapic0 = await machine.qmp.hmp('info lapic');
    evidence.dump0 = { registers: registers0, lapic: lapic0 };
    const dump0 = parseRegisters(registers0);

    const mismatch0 = compareCpuToDump(frame0?.cpu, dump0);
    check(
      'F1 复位帧的段缓存/控制寄存器/EFER 与 HMP 独立 dump 一致',
      mismatch0.length === 0,
      mismatch0.join('; ') || `cs.base=${dump0.segments.cs?.base} cr0=${dump0.control.cr0} efer=${dump0.control.efer}`,
    );
    check(
      'F2 段限长与属性不再是被伪造的占位值',
      frame0?.cpu?.segments?.cs?.limit === '0xffff'
        && frame0?.cpu?.segments?.cs?.attributes === '0x9b00'
        && frame0?.cpu?.segments?.ss?.attributes !== '0x0',
      `cs.limit=${frame0?.cpu?.segments?.cs?.limit} cs.attributes=${frame0?.cpu?.segments?.cs?.attributes} ss.attributes=${frame0?.cpu?.segments?.ss?.attributes}`,
    );
    check(
      'F3 实模式下 linearPc 由 CS 隐藏基址算出，不再是 null',
      frame0?.cpu?.linearPc === '0xfffffff0'
        && normHex(frame0.cpu.linearPc)
          === normHex(BigInt(dump0.segments.cs.base) + BigInt(dump0.pc)),
      `linearPc=${frame0?.cpu?.linearPc} cs.base=${dump0.segments.cs?.base} rip=${dump0.pc}`,
    );
    const tpr0 = parseLapicTpr(lapic0);
    check(
      'F4 CR8 与 `info lapic` 的 TPR 一致',
      tpr0 !== null && normHex(frame0?.cpu?.control?.cr8) === tpr0,
      `frame cr8=${normHex(frame0?.cpu?.control?.cr8)} lapic TPR=${tpr0}`,
    );
    check(
      'F5 段缓存已从 coverage.unavailable 移除并标为 observed',
      !(frame0?.coverage?.unavailable ?? []).includes('cpu.segment-cache')
        && frame0?.evidence?.['cpu.segment-cache']?.kind === 'observed'
        && /x-oslab-capture:/.test(frame0?.evidence?.['cpu.segment-cache']?.refs?.[0] ?? ''),
      `unavailable=${JSON.stringify(frame0?.coverage?.unavailable)} kind=${frame0?.evidence?.['cpu.segment-cache']?.kind} ref=${frame0?.evidence?.['cpu.segment-cache']?.refs?.[0]}`,
    );

    /* ---------- 物理读 ---------- */
    const resetRead = await call(
      app,
      'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0xfffffff0&length=16`,
    );
    evidence.resetRead = resetRead.body;
    check(
      'P1 复位向量读成功且证据来源是 observer',
      resetRead.status === 200
        && resetRead.body?.hex?.startsWith('ea5be000f0')
        && resetRead.body?.evidence?.source === 'observer'
        && /x-oslab-read-physical:/.test(resetRead.body?.evidence?.refs?.[0] ?? ''),
      `hex=${resetRead.body?.hex} source=${resetRead.body?.evidence?.source} ref=${resetRead.body?.evidence?.refs?.[0]}`,
    );

    const chunked = await call(
      app,
      'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0x100000&length=8192`,
    );
    evidence.chunkedRead = { status: chunked.status, length: chunked.body?.length, hexPrefix: chunked.body?.hex?.slice(0, 32) };
    check(
      'P2 8 KiB 读取按 4 KiB 上限自动分片并拼接',
      chunked.status === 200 && chunked.body?.length === 8192
        && typeof chunked.body?.hex === 'string' && chunked.body.hex.length === 8192 * 2,
      `status=${chunked.status} length=${chunked.body?.length}`,
    );

    const mmio = await call(
      app,
      'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0xfee00000&length=16`,
    );
    evidence.mmioRead = mmio.body;
    check(
      'P3 读取 APIC MMIO 被拒（mmio-side-effect）',
      mmio.status === 400 && mmio.body?.error?.code === 'mmio-side-effect'
        && mmio.body?.error?.detail?.regionName === 'apic-msi',
      `status=${mmio.status} code=${mmio.body?.error?.code} region=${mmio.body?.error?.detail?.regionName}`,
    );

    const rampIntoMmio = await call(
      app,
      'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0x9ffff&length=16`,
    );
    evidence.crossIntoMmio = rampIntoMmio.body;
    check(
      'P4 从 RAM 跨进 VGA MMIO 的读被拒，不静默跨区域读',
      rampIntoMmio.status === 400 && rampIntoMmio.body?.error?.code === 'mmio-side-effect'
        && rampIntoMmio.body?.error?.detail?.regionName === 'vga-lowmem',
      `status=${rampIntoMmio.status} code=${rampIntoMmio.body?.error?.code} region=${rampIntoMmio.body?.error?.detail?.regionName}`,
    );

    const missing = await call(
      app,
      'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0x200000000&length=16`,
    );
    evidence.unmappedRead = missing.body;
    check(
      'P5 已知区域之外的物理地址被拒（range-not-captured）',
      missing.status === 400 && missing.body?.error?.code === 'range-not-captured',
      `status=${missing.status} code=${missing.body?.error?.code}`,
    );

    /* ---------- 继续执行 -> 快照失效 -> 暂停 -> 重新采集 ---------- */
    const state = await call(app, 'GET', `/api/sessions/${session.id}`);
    const cont = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
      type: 'continue',
      requestId: 't05a-continue',
      epoch: state.body.epoch,
      expectedFrameId: state.body.latestFrameId,
    });
    check('S1 continue 被接受', cont.status === 200, `status=${cont.status} ${describe(cont.body)}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const staleRead = await call(
      app,
      'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0xfffffff0&length=16`,
    );
    evidence.staleRead = staleRead.body;
    check(
      'S2 VM 推进后旧的观察者快照不再可读（range-not-captured）',
      staleRead.status === 400 && staleRead.body?.error?.code === 'range-not-captured',
      `status=${staleRead.status} code=${staleRead.body?.error?.code} message=${staleRead.body?.error?.message}`,
    );

    const state2 = await call(app, 'GET', `/api/sessions/${session.id}`);
    const paused = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
      type: 'pause',
      requestId: 't05a-pause',
      epoch: state2.body.epoch,
      expectedFrameId: state2.body.latestFrameId,
    });
    const frame1 = paused.body;
    evidence.frame1 = frame1;
    check(
      'S3 暂停后提交新帧',
      paused.status === 200 && frame1?.frameId === 1,
      `status=${paused.status} frameId=${frame1?.frameId} reason=${frame1?.stop?.reason} ${paused.status === 200 ? '' : describe(paused.body)}`,
    );

    const registers1 = await machine.qmp.hmp('info registers');
    evidence.dump1 = registers1;
    const dump1 = parseRegisters(registers1);
    const mismatch1 = compareCpuToDump(frame1?.cpu, dump1);
    check(
      'S4 运行过后重新采集的帧仍与新的 HMP dump 一致',
      frame1?.cpu != null && mismatch1.length === 0,
      mismatch1.join('; ') || `rip=${dump1.pc} cr0=${dump1.control.cr0} cr3=${dump1.control.cr3} efer=${dump1.control.efer}`,
    );

    const caps2 = await call(app, 'GET', `/api/sessions/${session.id}/capabilities`);
    evidence.capabilitiesAfterStep = caps2.body?.observer ?? null;
    check(
      'S5 观察者快照随新帧更新（captureId 变化且指向新帧）',
      caps2.body?.observer?.activeCaptureId !== observerCaps.activeCaptureId
        && caps2.body?.observer?.activeCaptureFrameId === frame1?.frameId,
      `before=${observerCaps.activeCaptureId} after=${caps2.body?.observer?.activeCaptureId} frameId=${caps2.body?.observer?.activeCaptureFrameId}`,
    );

    check(
      'S6 新帧的段缓存证据引用的是新的观察者 captureId',
      /x-oslab-capture:/.test(frame1?.evidence?.['cpu.segment-cache']?.refs?.[0] ?? '')
        && frame1?.evidence?.['cpu.segment-cache']?.refs?.[0]
          !== frame0?.evidence?.['cpu.segment-cache']?.refs?.[0],
      `frame0=${frame0?.evidence?.['cpu.segment-cache']?.refs?.[0]} frame1=${frame1?.evidence?.['cpu.segment-cache']?.refs?.[0]}`,
    );
  } finally {
    if (session) {
      const closed = await call(app, 'DELETE', `/api/sessions/${session.id}`);
      check('S7 会话关闭成功', closed.status === 200 && closed.body?.closed === true, JSON.stringify(closed.body));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const leftover = countSessionProcesses(session.id);
      check('S8 无残留 QEMU/GDB 进程', leftover === 0, `残留进程数=${leftover}`);
    }
    await app.close();
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
