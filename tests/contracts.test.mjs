/**
 * T02 验收测试：协议类型与运行时校验器。
 *
 * 覆盖协议校验与录制包读写：
 * - 大地址往返无损
 * - 缺字段被拒绝
 * - 跨 epoch 数据被拒绝
 * - 错误字节长度被拒绝
 * - 真实样例可校验
 * - 录制包格式与散列校验
 *
 * 运行：node --test tests/contracts.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalHex, fromHex, isHex, toHex } from '../packages/contracts/common.ts';
import {
  base64ByteLength,
  findSequenceGaps,
  validateCapabilities,
  validateChunkedBlob,
  validateEvent,
  validateFrame,
  validateHexRoundTrip,
  validateReadLength,
} from '../packages/contracts/validate.ts';
import { ErrorCode } from '../packages/contracts/errors.ts';
import {
  appendFrame,
  hashObject,
  initRecording,
  readIndex,
  readManifest,
  resolveViewFrame,
  sha256Hex,
  verifyBlob,
  verifyRecording,
  writeManifest,
  writeBlob,
} from '../packages/trace-format/index.ts';

const SAMPLES = new URL('../packages/contracts/samples/', import.meta.url);

async function loadSample(name) {
  return JSON.parse(await readFile(new URL(name, SAMPLES), 'utf8'));
}

test('大地址往返无损', () => {
  const cases = ['0xffffffff82056d20', '0xfffffff0', '0x0', '0x20d6000', '0xffffffffffffffff'];
  for (const value of cases) {
    assert.equal(canonicalHex(value), value, `${value} 应保持规范形式`);
    assert.equal(toHex(fromHex(value)), value, `${value} 往返后应不变`);
    assert.equal(validateHexRoundTrip(value).length, 0, `${value} 应通过校验`);
  }
});

test('非规范地址表示被拒绝', () => {
  for (const bad of ['0x00ff', '0xFF', 'ff', '0x', '', 255]) {
    assert.ok(validateHexRoundTrip(bad).length > 0, `${String(bad)} 应被拒绝`);
  }
  assert.equal(isHex('0x0'), true);
  assert.equal(isHex('0x00ff'), false);
});

test('缺字段的帧被拒绝', () => {
  const result = validateFrame({ schemaVersion: 1, sessionId: 's' });
  assert.equal(result.ok, false);
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes('frame.epoch'));
  assert.ok(paths.includes('frame.captureId'));
  assert.ok(paths.includes('frame.recording'));
  assert.ok(paths.includes('frame.coverage'));
});

test('跨 epoch 数据被拒绝', async () => {
  const frame = await loadSample('reset-frame.json');
  assert.equal(validateFrame(frame).ok, true, '样例自身应合法');
  const stale = validateFrame(frame, { expectedEpoch: 2 });
  assert.equal(stale.ok, false);
  assert.ok(stale.issues.some((issue) => issue.code === ErrorCode.STALE_EPOCH));
  const wrongSession = validateFrame(frame, { expectedSessionId: 'other' });
  assert.equal(wrongSession.ok, false);
});

test('错误字节长度被拒绝', () => {
  const event = {
    seq: '1',
    kind: 'memory.read',
    phase: 'complete',
    addressSpace: 'physical',
    address: '0xfffffff0',
    size: 16,
    bytes: Buffer.from('abcd').toString('base64'),
    byteOrder: 'little',
  };
  const result = validateEvent(event);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'length'));
});

test('缺失字节序被拒绝', () => {
  const event = {
    seq: '1',
    kind: 'memory.read',
    phase: 'complete',
    bytes: Buffer.from('abcd').toString('base64'),
    size: 4,
  };
  const result = validateEvent(event);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'required'));
});

test('非法 base64 被拒绝', () => {
  assert.equal(base64ByteLength('not base64!!'), null);
  assert.equal(base64ByteLength('YWJj'), 3);
});

test('真实复位帧样例可校验', async () => {
  const frame = await loadSample('reset-frame.json');
  const result = validateFrame(frame);
  assert.deepEqual(result.issues, []);
  assert.equal(frame.cpu.rip, '0xfffffff0');
  assert.equal(frame.cpu.segments.cs.base, '0xffff0000');
  // 复位向量字节与实测一致：ea 5b e0 00 f0
  assert.equal(frame.cpu.instruction.bytes, '0xea5be000f0');
  assert.equal(frame.cpu.mode, 'real-16');
});

test('真实 start_kernel 帧样例可校验', async () => {
  const frame = await loadSample('start-kernel-frame.json');
  assert.deepEqual(validateFrame(frame).issues, []);
  assert.equal(frame.cpu.rip, '0xffffffff82056d20');
  assert.equal(frame.cpu.control.cr3, '0x20d6000');
  assert.equal(frame.cpu.efer, '0xd01');
  assert.equal(frame.source.line, 875);
  assert.equal(frame.cpu.instruction.text, 'endbr64');
});

test('真实用户态帧样例可校验且标注了未采集项', async () => {
  const frame = await loadSample('userland-read-frame.json');
  assert.deepEqual(validateFrame(frame).issues, []);
  // 样例的 CPU 字段以 null 表示调试器连接缺口。
  assert.equal(frame.cpu.rip, null);
  assert.equal(frame.cpu.instruction.evidence, 'unavailable');
  // 事件覆盖缺口以 lost 标记。
  assert.equal(frame.coverage.events, 'lost');
  assert.equal(frame.recording.events, 'lost');
});

test('事件分片样例可校验且字节长度自洽', async () => {
  const chunk = await loadSample('events-reset.json');
  assert.equal(chunk.events.length, 3);
  for (const event of chunk.events) {
    const result = validateEvent(event);
    assert.deepEqual(result.issues, [], `seq=${event.seq} 应合法`);
  }
  const first = chunk.events[0];
  assert.equal(base64ByteLength(first.bytes), first.size);
  assert.equal(first.address, '0xfffffff0');
});

test('能力样例可校验', async () => {
  const capabilities = await loadSample('capabilities.sample.json');
  const result = validateCapabilities(capabilities);
  assert.deepEqual(result.issues, []);
  assert.equal(capabilities.standard.singleStep.status, 'verified');
  // 观察扩展的接入缺口以 unavailable 标记。
  assert.equal(capabilities.observer_.captureSnapshot.status, 'unavailable');
  assert.equal(capabilities.events['block.submit'].status, 'unavailable');
});

test('序号缺口可检测', () => {
  const gaps = findSequenceGaps([{ seq: '1' }, { seq: '2' }, { seq: '5' }, { seq: '6' }]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].after, '2');
  assert.equal(gaps[0].before, '5');
  assert.equal(gaps[0].missingAtLeast, 2);
  assert.equal(findSequenceGaps([{ seq: '1' }, { seq: '2' }]).length, 0);
});

test('二进制分块校验拒绝不连续块与长度不符', () => {
  const payload = Buffer.from('0123456789abcdef');
  const half = payload.length / 2;
  const good = [
    { index: 0, bytes: payload.subarray(0, half).toString('base64') },
    { index: 1, bytes: payload.subarray(half).toString('base64') },
  ];
  assert.deepEqual(validateChunkedBlob(good, { length: payload.length }), []);
  const bad = [
    { index: 0, bytes: payload.subarray(0, half).toString('base64') },
    { index: 2, bytes: payload.subarray(half).toString('base64') },
  ];
  assert.ok(validateChunkedBlob(bad, { length: payload.length }).length > 0);
  assert.ok(validateChunkedBlob(good, { length: 999 }).length > 0);
});

test('内存读取长度受上限约束', () => {
  assert.deepEqual(validateReadLength(4096), []);
  assert.ok(validateReadLength(0).length > 0);
  assert.ok(validateReadLength(-1).length > 0);
  assert.ok(validateReadLength(1 << 21).length > 0);
});

test('内容寻址 blob 可写入、读取并校验', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oslab-blob-'));
  const bytes = Buffer.from('real-bytes-from-rom');
  const record = await writeBlob(root, bytes);
  assert.equal(record.sha256, sha256Hex(bytes));
  const verification = await verifyBlob(root, record);
  assert.equal(verification.ok, true);
  // 内容被篡改后校验必须失败
  const tampered = await writeBlob(root, Buffer.from('tampered'));
  assert.notEqual(tampered.sha256, record.sha256);
  const badVerification = await verifyBlob(root, { ...record, length: record.length + 1 });
  assert.equal(badVerification.ok, false);
});

test('录制包可写入、回放定位并通过完整性校验', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oslab-rec-'));
  const paths = await initRecording(root);
  const files = [];
  for (let frameId = 0; frameId < 5; frameId += 1) {
    const { files: written } = await appendFrame(paths, {
      frameId,
      parentFrameId: frameId === 0 ? null : frameId - 1,
      epoch: 1,
      frame: { frameId, schemaVersion: 1, note: 'test' },
      events: [{ seq: String(frameId + 1), kind: 'instruction.begin', phase: 'begin' }],
      committedAt: new Date(1700000000000 + frameId * 1000).toISOString(),
      checkpoint: frameId % 2 === 0,
    });
    files.push(...written);
  }
  const manifest = await writeManifest(paths, {
    schema: 1,
    recordingId: 'rec-test',
    sessionId: 'session-test',
    profileId: 'kernel-fast',
    epoch: 1,
    createdAt: new Date(1700000000000).toISOString(),
    closedAt: null,
    artifactManifest: { hash: sha256Hex('artifacts'), entries: [] },
    launchArgv: ['-kernel', 'bzImage'],
    qemuVersion: '8.2.10',
    observerProtocolVersion: 1,
    kernelRelease: '6.12.112-observatory',
    vmlinuxSha256: sha256Hex('vmlinux'),
    curriculumVersion: '1',
    files,
    frames: (await readIndex(paths)).map((entry) => ({ ...entry })),
    checkpointPolicy: { everyNFrames: 2, quotaBytes: 1 << 30, onQuotaExceeded: 'stop-recording' },
    bytesUsed: files.reduce((sum, file) => sum + file.length, 0),
    truncatedByQuota: false,
  });
  assert.equal(manifest.manifestSha256, hashObject({
    schema: manifest.schema,
    recordingId: manifest.recordingId,
    sessionId: manifest.sessionId,
    profileId: manifest.profileId,
    epoch: manifest.epoch,
    createdAt: manifest.createdAt,
    closedAt: manifest.closedAt,
    artifactManifest: manifest.artifactManifest,
    launchArgv: manifest.launchArgv,
    qemuVersion: manifest.qemuVersion,
    observerProtocolVersion: manifest.observerProtocolVersion,
    kernelRelease: manifest.kernelRelease,
    vmlinuxSha256: manifest.vmlinuxSha256,
    curriculumVersion: manifest.curriculumVersion,
    files: manifest.files,
    frames: manifest.frames,
    checkpointPolicy: manifest.checkpointPolicy,
    bytesUsed: manifest.bytesUsed,
    truncatedByQuota: manifest.truncatedByQuota,
  }));

  const verification = await verifyRecording(root);
  assert.equal(verification.manifestOk, true, JSON.stringify(verification.failures));
  assert.equal(verification.schemaCompatible, true);
  assert.deepEqual(verification.missingFrames, []);
  assert.equal(verification.scriptsExecuted, false);

  const located = await resolveViewFrame(paths, 3);
  assert.equal(located.checkpointFrameId, 2);
  assert.deepEqual(located.path.map((entry) => entry.frameId), [2, 3]);

  const reread = await readManifest(paths);
  assert.equal(reread.recordingId, 'rec-test');
});

test('录制包被篡改后完整性校验失败', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oslab-rec-tamper-'));
  const paths = await initRecording(root);
  const { files } = await appendFrame(paths, {
    frameId: 0,
    parentFrameId: null,
    epoch: 1,
    frame: { frameId: 0 },
    events: [],
    committedAt: new Date(1700000000000).toISOString(),
    checkpoint: true,
  });
  await writeManifest(paths, {
    schema: 1,
    recordingId: 'rec-tamper',
    sessionId: 's',
    profileId: 'kernel-fast',
    epoch: 1,
    createdAt: new Date(1700000000000).toISOString(),
    closedAt: null,
    artifactManifest: { hash: sha256Hex('a'), entries: [] },
    launchArgv: [],
    qemuVersion: '8.2.10',
    observerProtocolVersion: 1,
    kernelRelease: '6.12.112-observatory',
    vmlinuxSha256: sha256Hex('v'),
    curriculumVersion: '1',
    files,
    frames: [],
    checkpointPolicy: { everyNFrames: 100, quotaBytes: 1 << 30, onQuotaExceeded: 'stop-recording' },
    bytesUsed: 0,
    truncatedByQuota: false,
  });
  // 篡改帧文件
  await (await import('node:fs/promises')).writeFile(path.join(root, files[0].path), '{"tampered":true}');
  const verification = await verifyRecording(root);
  assert.equal(verification.manifestOk, false);
  assert.ok(verification.failures.some((failure) => failure.reason === 'checksum-mismatch'));
});
