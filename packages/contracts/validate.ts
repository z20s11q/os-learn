/** 纯函数运行时校验器，校验地址表示、字段、epoch、字节长度及记录样例。 */

import type { CoverageReport, EvidenceRef, Hex } from './common.ts';
import { isDecimal, isHex, isSha256 } from './common.ts';
import type { MachineEvent, MachineEventKind } from './event.ts';
import type { Frame } from './frame.ts';
import type { Capabilities } from './capabilities.ts';
import { ErrorCode } from './errors.ts';

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 base64 字符串能被解码，并返回字节数；不合法返回 null。 */
export function base64ByteLength(value: string): number | null {
  if (typeof value !== 'string') return null;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return null;
  }
}

const EVENT_KINDS: readonly MachineEventKind[] = [
  'instruction.begin',
  'instruction.retire',
  'memory.read',
  'memory.write',
  'dma.read',
  'dma.write',
  'io.read',
  'io.write',
  'irq.raise',
  'irq.lower',
  'interrupt.accept',
  'block.submit',
  'block.complete',
  'input.accept',
  'serial.output',
  'capture.fence',
  'exception.raise',
  'observer.drop',
];

const PHASES = ['begin', 'complete', 'raise', 'lower', 'fence'] as const;

export function validateEvent(value: unknown, path = 'event'): ValidationResult<MachineEvent> {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue(path, 'type', '事件必须是对象')] };
  }
  if (!isDecimal(value.seq)) {
    issues.push(issue(`${path}.seq`, 'format', 'seq 必须是十进制字符串'));
  }
  if (typeof value.kind !== 'string' || !EVENT_KINDS.includes(value.kind as MachineEventKind)) {
    issues.push(issue(`${path}.kind`, 'enum', `未知事件类别: ${String(value.kind)}`));
  }
  if (typeof value.phase !== 'string' || !PHASES.includes(value.phase as never)) {
    issues.push(issue(`${path}.phase`, 'enum', `未知阶段: ${String(value.phase)}`));
  }
  if (value.pc !== undefined && !isHex(value.pc)) {
    issues.push(issue(`${path}.pc`, 'format', 'pc 必须是规范十六进制字符串'));
  }
  if (value.address !== undefined && !isHex(value.address)) {
    issues.push(issue(`${path}.address`, 'format', 'address 必须是规范十六进制字符串'));
  }
  if (value.size !== undefined) {
    if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0) {
      issues.push(issue(`${path}.size`, 'range', 'size 必须是非负整数'));
    }
  }
  if (value.bytes !== undefined) {
    const length = base64ByteLength(value.bytes as string);
    if (length === null) {
      issues.push(issue(`${path}.bytes`, 'base64', 'bytes 不是合法 base64'));
    } else if (typeof value.size === 'number' && value.size !== length) {
      // 错误字节长度必须被拒绝
      issues.push(
        issue(`${path}.bytes`, 'length', `bytes 解码后 ${length} 字节与 size=${value.size} 不一致`),
      );
    }
  }
  if (value.bytes !== undefined && value.byteOrder === undefined) {
    issues.push(issue(`${path}.byteOrder`, 'required', '提供 bytes 时必须声明字节序'));
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as MachineEvent, issues }
    : { ok: false, issues };
}

export function validateEvidence(value: unknown, path = 'evidence'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) return [issue(path, 'type', '证据必须是对象')];
  if (!['observed', 'decoded', 'explanation', 'unavailable'].includes(value.kind as string)) {
    issues.push(issue(`${path}.kind`, 'enum', '未知证据类型'));
  }
  if (typeof value.source !== 'string' || value.source.length === 0) {
    issues.push(issue(`${path}.source`, 'required', '证据必须注明来源'));
  }
  if (!Array.isArray(value.refs) || value.refs.some((r) => typeof r !== 'string')) {
    issues.push(issue(`${path}.refs`, 'type', 'refs 必须是字符串数组'));
  }
  return issues;
}

/**
 * 帧校验。
 *
 * `expectedEpoch` 用于拒绝跨 epoch 数据：传入时会与帧自身的 epoch 比较，
 * 不一致即判为 stale-epoch。
 */
export function validateFrame(
  value: unknown,
  options: { expectedEpoch?: number; expectedSessionId?: string } = {},
): ValidationResult<Frame> {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('frame', 'type', '帧必须是对象')] };
  }
  if (value.schemaVersion !== 1) {
    issues.push(issue('frame.schemaVersion', 'version', '仅支持 schemaVersion=1'));
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    issues.push(issue('frame.sessionId', 'required', '缺少 sessionId'));
  } else if (options.expectedSessionId && value.sessionId !== options.expectedSessionId) {
    issues.push(issue('frame.sessionId', 'mismatch', '帧不属于该会话'));
  }
  if (typeof value.epoch !== 'number' || !Number.isInteger(value.epoch)) {
    issues.push(issue('frame.epoch', 'type', 'epoch 必须是整数'));
  } else if (options.expectedEpoch !== undefined && value.epoch !== options.expectedEpoch) {
    // 跨 epoch 数据被拒绝
    issues.push(
      issue('frame.epoch', ErrorCode.STALE_EPOCH, `帧 epoch=${value.epoch} 期望 ${options.expectedEpoch}`),
    );
  }
  if (typeof value.frameId !== 'number' || !Number.isInteger(value.frameId) || value.frameId < 0) {
    issues.push(issue('frame.frameId', 'range', 'frameId 必须是非负整数'));
  }
  if (typeof value.captureId !== 'string' || value.captureId.length === 0) {
    issues.push(issue('frame.captureId', 'required', '缺少 captureId'));
  }
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) {
    issues.push(issue('frame.requestId', 'required', '缺少 requestId'));
  }
  if (!['live', 'recorded'].includes(value.executionMode as string)) {
    issues.push(issue('frame.executionMode', 'enum', 'executionMode 只能是 live/recorded'));
  }
  if (!isObject(value.stop)) {
    issues.push(issue('frame.stop', 'required', '缺少 stop'));
  } else {
    if (!isObject(value.stop)) {
      issues.push(issue('frame.stop', 'type', 'stop 必须是对象'));
    }
  }
  if (!isObject(value.coverage)) {
    issues.push(issue('frame.coverage', 'required', '缺少 coverage'));
  } else {
    issues.push(...validateCoverage(value.coverage, 'frame.coverage'));
  }
  if (!isObject(value.cpu)) {
    issues.push(issue('frame.cpu', 'required', '缺少 cpu 快照'));
  }
  if (!Array.isArray(value.memory)) {
    issues.push(issue('frame.memory', 'type', 'memory 必须是数组'));
  }
  if (!Array.isArray(value.devices)) {
    issues.push(issue('frame.devices', 'type', 'devices 必须是数组'));
  }
  if (!isObject(value.diskVersions)) {
    issues.push(issue('frame.diskVersions', 'type', 'diskVersions 必须是对象'));
  }
  if (value.os !== null && !isObject(value.os)) {
    issues.push(issue('frame.os', 'type', 'os 必须是对象或 null'));
  }
  if (!isObject(value.recording)) {
    // 录制覆盖信息为必填项
    issues.push(issue('frame.recording', 'required', '缺少录制覆盖信息 recording'));
  }
  if (isObject(value.evidence)) {
    for (const [key, ref] of Object.entries(value.evidence)) {
      issues.push(...validateEvidence(ref, `frame.evidence.${key}`));
    }
  } else {
    issues.push(issue('frame.evidence', 'type', 'evidence 必须是对象'));
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as Frame, issues }
    : { ok: false, issues };
}

export function validateCoverage(value: unknown, path = 'coverage'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) return [issue(path, 'type', 'coverage 必须是对象')];
  if (!['selected-pages', 'full-ram-delta'].includes(value.memory as string)) {
    issues.push(issue(`${path}.memory`, 'enum', 'memory 只能是 selected-pages/full-ram-delta'));
  }
  if (!['complete', 'filtered', 'lost'].includes(value.events as string)) {
    issues.push(issue(`${path}.events`, 'enum', 'events 只能是 complete/filtered/lost'));
  }
  if (!Array.isArray(value.unavailable)) {
    issues.push(issue(`${path}.unavailable`, 'type', 'unavailable 必须是字符串数组'));
  }
  return issues;
}

export function validateCapabilities(value: unknown): ValidationResult<Capabilities> {
  const issues: ValidationIssue[] = [];
  if (!isObject(value)) return { ok: false, issues: [issue('capabilities', 'type', '必须是对象')] };
  if (value.schema !== 'oslab.capabilities/1') {
    issues.push(issue('capabilities.schema', 'version', 'schema 不匹配'));
  }
  if (!isObject(value.observer)) {
    issues.push(issue('capabilities.observer', 'required', '缺少 observer 协议信息'));
  }
  if (!isObject(value.standard)) {
    issues.push(issue('capabilities.standard', 'required', '缺少 standard 能力'));
  }
  if (!isObject(value.observer_)) {
    issues.push(issue('capabilities.observer_', 'required', '缺少观察扩展能力'));
  }
  if (!isObject(value.events)) {
    issues.push(issue('capabilities.events', 'required', '缺少事件覆盖表'));
  }
  if (!isObject(value.devices)) {
    issues.push(issue('capabilities.devices', 'required', '缺少设备支持表'));
  }
  for (const [key, entry] of Object.entries((value.standard as Record<string, unknown>) ?? {})) {
    if (!isObject(entry) || !['verified', 'unavailable', 'unknown'].includes(entry.status as string)) {
      issues.push(issue(`capabilities.standard.${key}`, 'enum', 'status 非法'));
    }
  }
  return issues.length === 0
    ? { ok: true, value: value as unknown as Capabilities, issues }
    : { ok: false, issues };
}

/**
 * 校验事件序号连续性，返回缺口列表。
 * 用于 `sequence-gap` 错误与带 `lost` 标志的诊断帧。
 */
export function findSequenceGaps(
  events: Array<{ seq: string }>,
): Array<{ after: string; before: string; missingAtLeast: number }> {
  const gaps: Array<{ after: string; before: string; missingAtLeast: number }> = [];
  for (let i = 1; i < events.length; i += 1) {
    const previous = BigInt(events[i - 1]!.seq);
    const current = BigInt(events[i]!.seq);
    if (current - previous > 1n) {
      gaps.push({
        after: events[i - 1]!.seq,
        before: events[i]!.seq,
        missingAtLeast: Number(current - previous - 1n),
      });
    }
  }
  return gaps;
}

/** 校验二进制分块：块序号连续、总长度与声明一致、散列可验证。 */
export function validateChunkedBlob(
  chunks: Array<{ index: number; bytes: string }>,
  expected: { length: number; sha256?: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (chunks.length === 0) return [issue('chunks', 'empty', '没有任何分块')];
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  sorted.forEach((chunk, position) => {
    if (chunk.index !== position) {
      issues.push(issue(`chunks[${position}]`, ErrorCode.CHUNK_INVALID, `块序号断裂，期望 ${position} 实得 ${chunk.index}`));
    }
  });
  const buffers = sorted.map((chunk) => {
    if (base64ByteLength(chunk.bytes) === null) {
      issues.push(issue(`chunks[${chunk.index}].bytes`, 'base64', '分块不是合法 base64'));
      return Buffer.alloc(0);
    }
    return Buffer.from(chunk.bytes, 'base64');
  });
  const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  if (total !== expected.length) {
    issues.push(
      issue('chunks', 'length', `分块总长 ${total} 与声明的 ${expected.length} 不一致`),
    );
  }
  if (expected.sha256) {
    if (!isSha256(expected.sha256)) {
      issues.push(issue('chunks.sha256', 'format', 'sha256 格式不合法'));
    } else {
      // 实际散列校验由调用方在拿到完整字节后执行；此处只做格式检查
    }
  }
  return issues;
}

/** 校验内存读取请求的长度合法（必须为正整数且有上限）。 */
export function validateReadLength(length: unknown, max = 1 << 20): ValidationIssue[] {
  if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) {
    return [issue('length', 'range', 'length 必须是正整数')];
  }
  if (length > max) {
    return [issue('length', 'range', `length 超过单次上限 ${max}`)];
  }
  return [];
}

/** 地址往返无损校验。 */
export function validateHexRoundTrip(value: unknown, path = 'address'): ValidationIssue[] {
  if (typeof value !== 'string') return [issue(path, 'type', '地址必须是字符串')];
  if (!isHex(value)) return [issue(path, 'format', '地址必须是 0x 前缀的规范小写十六进制')];
  try {
    const back = `0x${BigInt(value).toString(16)}`;
    if (back !== value) return [issue(path, 'canonical', '地址不是规范表示')];
  } catch {
    return [issue(path, 'parse', '地址不可解析')];
  }
  return [];
}
