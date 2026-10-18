/**
 * T03 服务层端到端验证（对应 E01–E03、E12 的服务层检查）。
 *
 * 通过同一 HTTP 接口操作真实 QEMU：创建会话、单步、断点、继续到真实断点、
 * 物理内存读取、幂等与迟到消息检查，最后确认子进程计数为 0。
 *
 * 运行：node scripts/verify-live.mjs
 */

import { execFileSync } from 'node:child_process';
import { buildServer } from '../services/lab-server/main.mjs';

const results = [];
let failures = 0;

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark} ${id}: ${detail}`);
}

async function call(app, method, url, payload) {
  const response = await app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = response.body;
  }
  return { status: response.statusCode, body };
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

function describeBody(body) {
  if (body === null || body === undefined) return '（空响应）';
  if (typeof body === 'string') return body.slice(0, 300);
  const error = body.error;
  if (error) return `code=${error.code} message=${error.message}`;
  return JSON.stringify(body).slice(0, 300);
}

async function latestFrameId(app, sessionId) {
  const state = await call(app, 'GET', `/api/sessions/${sessionId}`);
  return { frameId: state.body?.latestFrameId ?? 0, epoch: state.body?.epoch ?? 1 };
}

async function main() {
  const { app, registry } = await buildServer({ logger: false });
  await app.ready();

  const health = await call(app, 'GET', '/api/health');
  record('health', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

  console.log('创建会话（加载 vmlinux 符号，可能需要 1-2 分钟）...');
  const created = await call(app, 'POST', '/api/sessions', { profile: 'kernel-fast' });
  if (created.status !== 201) {
    record('session.create', false, `status=${created.status} body=${JSON.stringify(created.body).slice(0, 500)}`);
    await app.close();
    process.exit(1);
  }
  const session = created.body;
  record('session.create', true, `id=${session.id} qemu=${session.qmpVersion?.qemu?.version?.major}.${session.qmpVersion?.qemu?.version?.minor}`);

  const first = session.firstFrame;
  record(
    'E01 reset frame',
    first?.stop?.reason === 'reset' && first?.cpu?.mode === 'real-16',
    `reason=${first?.stop?.reason} mode=${first?.cpu?.mode} rip=${first?.cpu?.rip} cr0=${first?.cpu?.control?.cr0}`,
  );

  // 复位点指令字节：物理读 ROM
  const rom = await call(app, 'GET', `/api/sessions/${session.id}/memory?addressSpace=physical&address=0xfffffff0&length=16`);
  const romHex = typeof rom.body === 'object' ? rom.body.hex : null;
  record(
    'E01 ROM bytes',
    rom.status === 200 && typeof romHex === 'string' && romHex.startsWith('ea5be000f0'),
    `hex=${romHex} status=${rom.status}`,
  );

  // 单步两次，确认帧递增且 PC 变化
  const before1 = await latestFrameId(app, session.id);
  const stepOne = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    type: 'step',
    granularity: 'instruction',
    requestId: 'verify-step-1',
    epoch: before1.epoch,
    expectedFrameId: before1.frameId,
  });
  const frameOne = stepOne.body?.frame;
  record(
    'E04 step instruction',
    stepOne.status === 200 && frameOne?.stop?.reason === 'step',
    `status=${stepOne.status} frame=${frameOne?.frameId} rip=${frameOne?.cpu?.rip} cr0=${frameOne?.cpu?.control?.cr0} mode=${frameOne?.cpu?.mode} ${stepOne.status === 200 ? '' : describeBody(stepOne.body)}`,
  );

  // 幂等：重复 requestId 返回首次执行的缓存帧。
  const duplicate = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    type: 'step',
    granularity: 'instruction',
    requestId: 'verify-step-1',
    epoch: before1.epoch,
    expectedFrameId: before1.frameId,
  });
  const duplicateFrame = duplicate.body?.frame;
  record(
    'idempotency',
    duplicate.status === 200 && duplicateFrame?.frameId === frameOne?.frameId,
    `第一次 frame=${frameOne?.frameId} 重复后 frame=${duplicateFrame?.frameId} ${duplicate.status === 200 ? '' : describeBody(duplicate.body)}`,
  );

  const latest = await latestFrameId(app, session.id);

  // 迟到 epoch 必须被拒绝
  const stale = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    type: 'step',
    requestId: 'verify-stale',
    epoch: 99,
    expectedFrameId: latest.frameId,
  });
  record(
    'stale epoch rejected',
    stale.status === 400 && stale.body?.error?.code === 'stale-epoch',
    `code=${stale.body?.error?.code}`,
  );

  // 视图过期必须被拒绝
  const mismatch = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    type: 'step',
    requestId: 'verify-mismatch',
    epoch: latest.epoch,
    expectedFrameId: 9999,
  });
  record(
    'frame mismatch rejected',
    mismatch.status === 400 && mismatch.body?.error?.code === 'frame-mismatch',
    `code=${mismatch.body?.error?.code}`,
  );

  // startup_64 的同名歧义返回错误与候选。
  const ambiguous = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    type: 'breakpoint.insert',
    requestId: 'verify-ambiguous',
    epoch: latest.epoch,
    expectedFrameId: latest.frameId,
    location: { symbol: 'startup_64' },
  });
  record(
    'ambiguous symbol rejected',
    ambiguous.status === 400 && Array.isArray(ambiguous.body?.error?.detail?.candidates),
    `code=${ambiguous.body?.error?.code} candidates=${ambiguous.body?.error?.detail?.candidates?.length} ${ambiguous.status === 400 ? '' : describeBody(ambiguous.body)}`,
  );

  // 运行到 start_kernel 真实断点
  console.log('运行到 start_kernel（TCG 启动内核，可能需要 1-3 分钟）...');
  const beforeRun = await latestFrameId(app, session.id);
  const runTo = await call(app, 'POST', `/api/sessions/${session.id}/commands`, {
    type: 'run-to',
    requestId: 'verify-run-to',
    epoch: beforeRun.epoch,
    expectedFrameId: beforeRun.frameId,
    location: { symbol: 'start_kernel', module: 'linux-kernel' },
    timeoutMs: 240000,
  });
  const kernelFrame = runTo.body?.frame;
  const cr3 = kernelFrame?.cpu?.control?.cr3;
  const efer = kernelFrame?.cpu?.efer;
  record(
    'E03 start_kernel breakpoint',
    runTo.status === 200 &&
      kernelFrame?.stop?.reason === 'breakpoint' &&
      kernelFrame?.source?.symbol === 'start_kernel' &&
      kernelFrame?.cpu?.mode === 'long-64',
    `status=${runTo.status} frame=${kernelFrame?.frameId} rip=${kernelFrame?.cpu?.rip} cr3=${cr3} efer=${efer} line=${kernelFrame?.source?.line} ${runTo.status === 200 ? '' : describeBody(runTo.body)}`,
  );

  if (kernelFrame?.cpu?.rip) {
    record(
      'E03 kernel high half',
      kernelFrame.cpu.rip.startsWith('0xffffffff8'),
      `rip=${kernelFrame.cpu.rip}`,
    );
  }

  // 内核态物理内存读取
  const kernelBytes = await call(
    app,
    'GET',
    `/api/sessions/${session.id}/memory?addressSpace=physical&address=0x0&length=16`,
  );
  record(
    'physical memory read',
    kernelBytes.status === 200 && typeof kernelBytes.body?.hex === 'string',
    `hex=${kernelBytes.body?.hex}`,
  );

  // 能力与符号清单必须如实标注缺口。
  //
  // 事件覆盖表按观察者运行期 report 分档：report 中的 kind 为 verified，
  // 设备级发射点的接入缺口为 unavailable。
  const capabilities = await call(app, 'GET', `/api/sessions/${session.id}/capabilities`);
  const observerPatched = capabilities.body?.observer?.patched === true;
  const eventsTable = capabilities.body?.events ?? {};
  const producedKinds = [
    'instruction.begin', 'instruction.retire',
    'memory.read', 'memory.write',
    'io.read', 'io.write',
    'interrupt.accept', 'exception.raise',
    'dma.read', 'dma.write', 'block.submit', 'block.complete',
    'capture.fence',
  ];
  const notYetKinds = ['irq.raise', 'irq.lower', 'input.accept', 'serial.output'];
  const producedStatus = producedKinds
    .map((kind) => eventsTable[kind]?.status);
  const notYetStatus = notYetKinds.map((kind) => eventsTable[kind]?.status);
  record(
    'capabilities honest',
    capabilities.body?.observer_?.captureSnapshot?.status
      === (observerPatched ? 'verified' : 'unavailable') &&
      capabilities.body?.observer_?.events?.status
      === (observerPatched ? 'verified' : 'unavailable') &&
    // 观察者 report 中的 kind 应标为 verified。
      producedStatus.every((status) => status === (observerPatched ? 'verified' : 'unavailable')) &&
    // report 之外的接入缺口应标为 unavailable。
      notYetStatus.every((status) => status === 'unavailable'),
    `patched=${observerPatched} captureSnapshot=${capabilities.body?.observer_?.captureSnapshot?.status} events=${capabilities.body?.observer_?.events?.status}`
      + ` 已发射=${producedStatus.join(',')} 未接=${notYetStatus.join(',')}`,
  );

  const symbols = await call(app, 'GET', `/api/sessions/${session.id}/symbols`);
  const seabios = symbols.body?.stages?.find((entry) => entry.id === 'seabios');
  record(
    'symbol stages honest',
    seabios?.hasSymbols === false && typeof seabios?.reason === 'string',
    `seabios.hasSymbols=${seabios?.hasSymbols} reason=${seabios?.reason}`,
  );

  // 帧历史可读
  const finalState = await latestFrameId(app, session.id);
  const frameRead = await call(
    app,
    'GET',
    `/api/sessions/${session.id}/frames/${kernelFrame?.frameId}?epoch=${finalState.epoch}`,
  );
  record(
    'frame history',
    frameRead.status === 200 && frameRead.body?.frameId === kernelFrame?.frameId,
    `status=${frameRead.status} ${frameRead.status === 200 ? '' : describeBody(frameRead.body)}`,
  );

  // 关闭会话并确认关联进程计数为 0。
  const closed = await call(app, 'DELETE', `/api/sessions/${session.id}`);
  record('session.close', closed.status === 200 && closed.body?.closed === true, JSON.stringify(closed.body));

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const leftover = countSessionProcesses(session.id);
  record('no orphan processes', leftover === 0, `本会话残留进程数=${leftover}`);

  await app.close();

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n汇总：${passed}/${results.length} 通过，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('验证脚本异常:', error);
  process.exit(2);
});
