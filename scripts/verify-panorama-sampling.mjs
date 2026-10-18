#!/usr/bin/env node
/** Audit real full-boot capture evidence and its browser projection. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { steps, recordedFrames, getStepState, registerGroups } from '../docs/animation/panorama-data.js';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/verify/panorama-sampling.json');
const report = { schema: 'oslab.panorama-sampling-acceptance/1', testedAt: new Date().toISOString(), checks: [], coverage: {}, runtimeCodeDifferences: [] };
function check(id, ok, detail) {
  report.checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}
const sameWord = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return a === b; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attribution = read => read.attribution || read;
const bytes = read => read.hex || read.bytes;
const hexBytes = read => typeof bytes(read) === 'string' && /^[0-9a-f]*$/i.test(bytes(read)) && bytes(read).length === read.length * 2;
const digest = input => crypto.createHash('sha256').update(input).digest('hex');

try {
  const { default: index } = await import('../docs/animation/panorama-samples.js');
  const input = fs.readFileSync(path.join(root, index.source));
  const raw = JSON.parse(input);
  const byId = new Map(raw.frames.map(frame => [frame.frameId, frame]));
  const bound = Object.entries(raw.stepBindings);
  report.source = index.source;
  report.sourceSha256 = digest(input);
  report.coverage = {
    sessionIds: [...new Set(raw.frames.map(frame => frame.sessionId))],
    frames: raw.frames.length, sampledSteps: bound.length, totalSteps: steps.length,
    physicalReads: raw.physicalReads.length,
    bound: bound.map(([id, binding]) => ({ id, frameId: binding.frameId, position: binding.position, symbol: binding.symbol, address: binding.address })),
    unbound: raw.unboundSteps,
    nonzeroXmmValues: raw.frames.reduce((count, frame) => count + (frame.cpu.extended?.registers || [])
      .filter(register => /^xmm\d+$/.test(register.name) && register.value != null && BigInt(register.value) !== 0n).length, 0),
  };
  check('capture.complete', raw.status === 'complete' && /linux-lab:.*#\s*$/.test(raw.terminal),
    `status=${raw.status}; actual serial output ends in the terminal prompt; ${raw.error?.message || 'no capture error'}`);
  check('capture.cleanup', raw.cleanup?.closed === true && raw.cleanup?.onlyCreatedSession === true && raw.cleanup?.sessionId === raw.sessionId,
    'The capture closed only the QEMU session that it created');
  check('capture.same-boot', report.coverage.sessionIds.length === 1 && report.coverage.sessionIds[0] === raw.sessionId
    && new Set(raw.frames.map(frame => frame.captureId)).size === raw.frames.length
    && raw.frames.every((frame, i) => Number.isInteger(frame.frameId) && (i === 0 || frame.frameId > raw.frames[i - 1].frameId)),
    `${raw.frames.length} unique ordered captures from session ${raw.sessionId}`);
  if (raw.environment?.sessionDirectory && fs.existsSync(raw.environment.sessionDirectory)) {
    const mismatches = raw.frames.filter(frame => {
      const file = path.join(raw.environment.sessionDirectory, `frame-${frame.frameId}.json`);
      return !fs.existsSync(file) || !same(frame, JSON.parse(fs.readFileSync(file, 'utf8')));
    });
    check('capture.persisted-frames', mismatches.length === 0,
      `All raw frames also match the independently persisted session/frame-N.json files; mismatches: ${mismatches.map(frame => frame.frameId).join(', ') || 'none'}`);
  }
  check('projection.source-hash', index.sourceSha256 === digest(input), `${index.source} SHA-256 matches the generated browser module`);
  const badProjection = [];
  for (const [key, frame] of Object.entries(index.frames)) {
    const original = byId.get(frame.frameId);
    if (!original || !same(frame.cpu, original.cpu) || !same(frame.os, original.os || null)
      || frame.sessionId !== original.sessionId || frame.captureId !== original.captureId
      || !same(recordedFrames[key]?.cpu, original.cpu)) badProjection.push(key);
  }
  check('projection.raw-cpu-and-os', Object.keys(index.frames).length === raw.frames.length && badProjection.length === 0,
    `Every projected CPU/OS frame is identical to its raw captured object; mismatches: ${badProjection.join(', ') || 'none'}`);
  const allStepIds = new Set(steps.map(step => step.id));
  const unboundIds = raw.unboundSteps.map(step => step.id);
  check('coverage.explicit', bound.length > 14 && bound.length + unboundIds.length === steps.length
    && new Set([...bound.map(([id]) => id), ...unboundIds]).size === steps.length
    && [...bound.map(([id]) => id), ...unboundIds].every(id => allStepIds.has(id))
    && raw.unboundSteps.every(step => typeof step.reason === 'string' && step.reason.length > 10),
    `${bound.length}/${steps.length} measured microsteps; every remaining step has an explicit reason`);
  const badBindings = [];
  for (const [id, binding] of bound) {
    const state = getStepState(id), frame = byId.get(binding.frameId);
    const previous = binding.beforeFrameId == null ? null : byId.get(binding.beforeFrameId);
    if (!frame || state.frame?.captureId !== frame.captureId || state.frame?.sessionId !== frame.sessionId
      || !['entry', 'before', 'after', 'checkpoint', 'waiting'].includes(binding.position)
      || !binding.note || !sameWord(binding.address, frame.cpu.linearPc)
      || (binding.beforeFrameId != null && (!previous || previous.frameId >= frame.frameId || previous.sessionId !== frame.sessionId))
      || binding.memoryReads.some(i => !raw.physicalReads[i] || attribution(raw.physicalReads[i]).captureId !== frame.captureId)) badBindings.push(id);
  }
  check('bindings.actual-stop', badBindings.length === 0, `Bindings retain the actual PC, sampling position, note and memory owners: ${badBindings.join(', ') || 'none'}`);
  const orphanReads = raw.physicalReads.filter(read => {
    const owner = attribution(read), frame = byId.get(owner.frameId);
    return !frame || owner.sessionId !== frame.sessionId || owner.captureId !== frame.captureId
      || read.addressSpace !== 'physical' || read.withinCapture !== true || !hexBytes(read)
      || (read.evidence?.captureId != null && read.evidence.captureId !== frame.captureId);
  });
  check('memory.same-capture', orphanReads.length === 0, `${raw.physicalReads.length} physical windows have exact frame/session/capture ownership and valid bytes; invalid=${orphanReads.length}`);
  const missingLowWindows = raw.frames.flatMap(frame => [0n, 0x400n, 0x7c00n].filter(address => !raw.physicalReads.some(read =>
    attribution(read).captureId === frame.captureId && sameWord(read.address, address))).map(address => `${frame.frameId}:0x${address.toString(16)}`));
  check('memory.low-windows-every-stop', missingLowWindows.length === 0, `IVT, BDA and optical boot window are re-read at every real stop; missing: ${missingLowWindows.join(', ') || 'none'}`);
  const badDisplays = bound.flatMap(([id]) => {
    const state = getStepState(id);
    return [...state.lowMemory, ...state.memory.filter(read => read.addressSpace === 'physical')].filter(read =>
      (read.captureId || read.attribution?.captureId) !== state.frame.captureId
      || (read.sessionId || read.attribution?.sessionId) !== state.frame.sessionId).map(read => `${id}:${read.address}`);
  });
  check('memory.display-owner', badDisplays.length === 0, `Displayed physical bytes belong to the selected stop: ${badDisplays.join(', ') || 'none'}`);
  const badExtended = [], missingExtended = [], missingValues = [], badRawVectorBits = [];
  const required = ['dr0', 'dr1', 'dr2', 'dr3', 'dr6', 'dr7', ...Array.from({ length: 8 }, (_, i) => `st${i}`), ...Array.from({ length: 16 }, (_, i) => `xmm${i}`), 'mxcsr', 'fcw', 'fsw', 'ftwAbridged'];
  for (const frame of raw.frames) {
    const extended = frame.cpu.extended;
    if (!extended || extended.captureId !== frame.captureId || !extended.observerCaptureId
      || extended.cpuId !== frame.cpu.cpuId || extended.barrier !== 'vm-stopped-before-and-after-read'
      || !frame.cpu.evidence.includes(extended.observerCaptureId)) { missingExtended.push(frame.frameId); continue; }
    for (const name of required) if (!extended.registers.some(register => register.name === name && register.value != null)) missingValues.push(`${frame.frameId}:${name}`);
    for (const register of extended.registers) {
      if (register.captureId !== frame.captureId || register.value == null && !register.reason
        || register.value != null && (typeof register.value !== 'string' || !new RegExp(`^0x[0-9a-f]{${Math.ceil(register.width / 4)}}$`, 'i').test(register.value)
          || typeof register.raw !== 'string' || !register.source)) badExtended.push(`${frame.frameId}:${register.name}`);
    }
    const classic = extended.registers.find(register => register.name === 'ftw');
    const abridged = extended.registers.find(register => register.name === 'ftwAbridged');
    if (!classic || classic.value != null || !classic.reason || abridged?.width !== 8) badExtended.push(`${frame.frameId}:FTW-semantics`);
    // Reconstruct bit patterns from retained QEMU text independently of the parser.
  // Check raw x87 bits as well as width; MI "r" may format 2.0 as integer 2.
    const text = extended.rawQmpRegisters || '';
    const fsw = /\bFSW=([0-9a-f]+)\b/i.exec(text);
    const top = fsw ? Number((BigInt(`0x${fsw[1]}`) >> 11n) & 7n) : null;
    for (let logical = 0; logical < 8; logical++) {
      const physical = top == null ? null : (logical + top) % 8;
      const bits = physical == null ? null : new RegExp(`\\bFPR${physical}=([0-9a-f]{16})\\s+([0-9a-f]{4})\\b`, 'i').exec(text);
      const actual = extended.registers.find(register => register.name === `st${logical}`);
      if (!bits || actual?.value?.toLowerCase() !== `0x${bits[2]}${bits[1]}`.toLowerCase()
        || !actual.source.startsWith('qmp:')) badRawVectorBits.push(`${frame.frameId}:st${logical}`);
    }
    for (let i = 0; i < 16; i++) {
      const bits = new RegExp(`\\bXMM${String(i).padStart(2, '0')}=([0-9a-f]{16})\\s+([0-9a-f]{16})\\b`, 'i').exec(text);
      const actual = extended.registers.find(register => register.name === `xmm${i}`);
      const miBits = /\buint128\s*=\s*(0x[0-9a-f]+)\b/i.exec(actual?.raw || '');
      const expected = bits ? `0x${bits[1]}${bits[2]}` : miBits ? `0x${BigInt(miBits[1]).toString(16).padStart(32, '0')}` : null;
      if (!expected || actual?.value?.toLowerCase() !== expected.toLowerCase()) badRawVectorBits.push(`${frame.frameId}:xmm${i}`);
    }
  }
  check('cpu.extended-capture', missingExtended.length === 0, `Extended state carries the same captureId and QMP observer barrier; missing: ${missingExtended.join(', ') || 'none'}`);
  check('cpu.extended-core-values', missingValues.length === 0, `Debug, x87 binary80, SSE binary128 and controls are measured at every stop; missing: ${missingValues.join(', ') || 'none'}`);
  check('cpu.extended-lossless-provenance', badExtended.length === 0, `Full-width hex strings retain their raw source; 8-bit abridged FTW is separate from unavailable classic FTW: ${badExtended.join(', ') || 'none'}`);
  check('cpu.raw-x87-sse-bit-patterns', badRawVectorBits.length === 0,
    `Every ST value equals QEMU physical FPR binary80 mapped by FSW.TOP; XMM equals the retained QEMU words or MI uint128 bits: ${badRawVectorBits.join(', ') || 'none'}`);
  check('cpu.nonzero-vector-evidence', report.coverage.nonzeroXmmValues > 0,
    `${report.coverage.nonzeroXmmValues} nonzero real XMM values exercise high/low bit preservation instead of relying only on all-zero reset registers`);
  const widths = new Map(registerGroups.flatMap(group => group.items).map(register => [register.id, register.width]));
  const badExported = bound.flatMap(([id]) => {
    const state = getStepState(id);
    return state.frame.cpu.extended.registers.filter(register => register.value != null
      && (state.registers[register.name] !== register.value || widths.get(register.name) !== register.width)).map(register => `${id}:${register.name}`);
  });
  check('cpu.page-values-and-widths', badExported.length === 0, `Teaching state exposes every captured extension with matching value and bit width: ${badExported.join(', ') || 'none'}`);
  const badInstructions = raw.frames.filter(frame => {
    const instruction = frame.cpu.instruction;
    const window = frame.memory.find(read => read.addressSpace === 'linear' && sameWord(read.address, frame.cpu.linearPc));
    if (!instruction || !window || !sameWord(instruction.address, frame.cpu.linearPc)) return true;
    if (window.coverage === 'read-failed') return !window.reason || window.bytes != null || instruction.bytes != null || instruction.evidence !== 'unavailable';
    return !hexBytes(window) || typeof instruction.bytes !== 'string' || !bytes(window).startsWith(instruction.bytes);
  });
  report.coverage.unavailableInstructionFrames = raw.frames.filter(frame => frame.memory.some(window => window.label === 'pc' && window.coverage === 'read-failed'))
    .map(frame => ({ frameId: frame.frameId, address: frame.cpu.linearPc, reason: frame.memory.find(window => window.label === 'pc').reason,
      translationFault: raw.translations.find(translation => translation.attribution?.captureId === frame.captureId && translation.label === 'instruction')?.translation?.fault || null }));
  check('code.raw-instruction-window', badInstructions.length === 0,
    `Instruction bytes agree with their same-stop PC window, or remain explicitly unavailable (${report.coverage.unavailableInstructionFrames.length} windows); invalid frames: ${badInstructions.map(frame => frame.frameId).join(', ') || 'none'}`);

  // Validate each declared ELF address against instruction boundaries from symbol disassembly.
  const symbolTables = new Map(), disassembly = new Map(), badSites = [], badMappings = [];
  for (const site of raw.instructionSites) {
    if (!symbolTables.has(site.file)) {
      const symbols = execFileSync('nm', ['-n', path.join(root, site.file)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\n')
        .map(line => /^([0-9a-f]+)\s+([tTrR])\s+(.+)$/.exec(line)).filter(match => match && (/[tT]/.test(match[2])
          || site.module === 'setup' && match[3] === '_start' && BigInt(`0x${match[1]}`) === 0x200n))
        .map(match => ({ address: BigInt(`0x${match[1]}`), name: match[3] }));
      symbolTables.set(site.file, symbols);
    }
    const address = BigInt(site.linkAddress);
    const runtimeAddress = BigInt(site.address);
    let expectedLink = runtimeAddress;
    if (site.module === 'setup') expectedLink -= 0x90000n;
    if (site.module === 'decompressor') {
      const placement = byId.get(raw.stepBindings['decompress-placement'].frameId);
      const relocation = BigInt(placement.cpu.general.find(register => register.name === 'rbx').value);
      expectedLink -= site.label.startsWith('extract-kernel') ? relocation : 0x100000n;
    }
    if (site.module === 'kernel' && runtimeAddress < 0x20000000n) {
      const linkedStart = symbolTables.get(site.file).find(symbol => symbol.name === 'startup_64')?.address;
      expectedLink = runtimeAddress - BigInt(raw.stepBindings['jump-kernel'].address) + linkedStart;
    }
    if (expectedLink !== address) badMappings.push(`${site.label}:${site.linkAddress}!=0x${expectedLink.toString(16)}`);
    const preceding = symbolTables.get(site.file).filter(symbol => symbol.address <= address).at(-1);
    if (!preceding) { badSites.push(`${site.label}:no enclosing text symbol`); continue; }
    const key = `${site.file}:${preceding.address}:${address}:${site.module === 'setup' ? 'i8086' : site.module === 'decompressor' && address < 0x200n ? 'i386' : 'default'}`;
    if (!disassembly.has(key)) disassembly.set(key, execFileSync('objdump', [site.module === 'setup' && address === 0x200n ? '-D' : '-d', ...(site.module === 'setup' ? ['-m', 'i8086'] : site.module === 'decompressor' && address < 0x200n ? ['-m', 'i386'] : []), path.join(root, site.file), `--start-address=0x${preceding.address.toString(16)}`, `--stop-address=0x${(address + 32n).toString(16)}`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
    const line = disassembly.get(key).split('\n').find(line => { const match = /^\s*([0-9a-f]+):\s/.exec(line); return match && BigInt(`0x${match[1]}`) === address; });
    if (!line || !site.disassembly?.includes(site.linkAddress.slice(2))) badSites.push(`${site.label}:${site.linkAddress}`);
  }
  check('code.elf-instruction-boundaries', raw.instructionSites.length > 20 && badSites.length === 0,
    `${raw.instructionSites.length} declared ELF instruction sites are verified from enclosing text-symbol boundaries: ${badSites.join(', ') || 'none'}`);
  check('code.runtime-to-elf-mapping', badMappings.length === 0,
    `ELF link addresses agree with the actual runtime PC and measured load/relocation bases: ${badMappings.join(', ') || 'none'}`);
} catch (error) {
  check('verification.execution', false, error.stack || error.message);
} finally {
  report.passed = report.checks.filter(check => check.ok).length;
  report.failed = report.checks.filter(check => !check.ok).length;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed} passed, ${report.failed} failed -> ${output}`);
  process.exitCode = report.failed ? 1 : 0;
}
