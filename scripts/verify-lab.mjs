#!/usr/bin/env node
/**
 * T13 真实端到端验收。
 *
 * 通过 HTTP API 启动真实 QEMU/GDB，检查：
 * - 产物清单与散列（E15 的基础）
 * - 复位帧/单步/暂停与 OS 对象（E01–E05 的基础）
 * - 盘面 ext2 与页表翻译（T08）
 * - 课程匹配 L00–L07（完整启动课程）
 * - 录制导出/导入与历史只读（E13/E22 的服务层）
 * - 关闭后 QEMU/GDB 进程计数为 0
 *
 * 运行：node scripts/verify-lab.mjs
 * 结果：artifacts/verify/t13.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildServer } from '../services/lab-server/main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t13.json');
const report = {
  schema: 'oslab.t13-acceptance/1',
  startedAt: new Date().toISOString(),
  checks: [],
  sessions: [],
  unavailable: [],
};

function check(id, ok, detail) {
  report.checks.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
  return ok;
}

async function call(base, method, url, body, headers = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload, headers: response.headers, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitTerminal(base, id, pattern, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const result = await call(base, 'GET', `/api/sessions/${id}/terminal`);
    if (result.status === 200 && typeof result.body?.text === 'string' && pattern.test(result.body.text)) {
      return result.body.text;
    }
  }
  return null;
}

async function waitFrameAfter(base, id, afterFrameId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const result = await call(base, 'GET', `/api/sessions/${id}/frames`);
    const hit = result.body?.frames?.find((entry) => entry.frameId > afterFrameId);
    if (hit) return hit;
  }
  return null;
}

async function command(base, id, payload) {
  const session = (await call(base, 'GET', `/api/sessions/${id}`)).body;
  return call(base, 'POST', `/api/sessions/${id}/commands`, {
    ...payload,
    epoch: session.epoch,
    expectedFrameId: session.latestFrameId,
  });
}

function sessionProcessCount(id) {
  try {
    const output = execFileSync('bash', ['-c', `ps -eo args | grep -F '${id}' | grep -v grep | wc -l`], { encoding: 'utf8' });
    return Number(output.trim());
  } catch {
    return -1;
  }
}

async function main() {
  /* ---------- 静态产物 ---------- */
  const manifestPath = path.join(ROOT, 'artifacts/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('A1 产物清单存在', manifest.schema === 'oslab.artifact-manifest/1', manifestPath);
  for (const [name, entry] of Object.entries({
    bzImage: manifest.kernel.bzImage,
    initramfs: manifest.images.initramfs,
    rootfs: manifest.images.rootfs,
    lab: manifest.userland.lab,
    bootIso: manifest.images.bootIso,
  })) {
    const file = path.join(ROOT, entry.path);
    if (!fs.existsSync(file)) {
      check(`A2 产物 ${name}`, false, `缺失 ${entry.path}`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    check(`A2 产物散列 ${name}`, actual === entry.sha256, `${entry.sha256.slice(0, 16)}… / ${actual.slice(0, 16)}…`);
  }
  const curriculum = JSON.parse(fs.readFileSync(path.join(ROOT, 'curriculum/linux-x86_64/lessons.json'), 'utf8'));
  check('A3 课程文件', curriculum.schema === 'oslab.curriculum/1' && curriculum.lessons.length >= 24,
    `${curriculum.lessons.length} 课`);
  const ids = curriculum.lessons.map((lesson) => lesson.id);
  for (const required of ['L00', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'U01', 'U02', 'U03',
    'P01', 'P02', 'P03', 'P04', 'M01', 'M02', 'M03', 'M04', 'M05', 'F01', 'F02', 'F03', 'F04', 'H01']) {
    if (!ids.includes(required)) check(`A4 必需课程 ${required}`, false, '缺失');
  }

  const { app, registry } = await buildServer({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  try {
    /* ---------- kernel-fast：复位、单步、shell、OS、盘面、回放 ---------- */
    const created = await call(base, 'POST', '/api/sessions', { profile: 'kernel-fast' });
    const session = created.body;
    report.sessions.push({ id: session.id, profile: 'kernel-fast' });
    check('B1 会话启动', created.status === 201 && session.id, `${session.id} / frame ${session.firstFrame?.frameId}`);
    check('B2 复位首帧', session.firstFrame?.frameId === 0 && session.firstFrame?.stop?.pc === '0xfffffff0'
      && session.firstFrame?.lesson?.lessonId === 'L00',
      `pc=${session.firstFrame?.stop?.pc} lesson=${session.firstFrame?.lesson?.lessonId}`);

    const stepped = await command(base, session.id, {
      type: 'step', requestId: 't13-step', granularity: 'instruction', count: 1,
    });
    check('B3 单步真实执行', stepped.status === 200 && stepped.body?.frame?.frameId === 1,
      `frame=${stepped.body?.frame?.frameId} stop=${stepped.body?.frame?.stop?.reason}`);

    // 复位/单步阶段的 OS 对象标记为 unavailable。
    check('B4 早期阶段 OS 不可用如实标注',
      Array.isArray(session.firstFrame?.coverage?.unavailable)
      && session.firstFrame.coverage.unavailable.some((entry) => entry.startsWith('os.objects')),
      session.firstFrame?.coverage?.unavailable?.slice(0, 2).join('；'));

    await call(base, 'POST', `/api/sessions/${session.id}/commands`, {
      type: 'continue', requestId: 't13-boot', epoch: 1, expectedFrameId: 1,
    });
    const terminal = await waitTerminal(base, session.id, /linux-lab:.*# /);
    check('B5 真实 shell', terminal !== null, terminal === null ? '120s 内未出现提示符' : JSON.stringify(terminal.slice(-80)));

    const paused = await command(base, session.id, { type: 'pause', requestId: 't13-pause' });
    const frame = paused.body?.frame;
    check('B6 暂停生成同帧 OS 快照', paused.status === 200 && frame?.os !== null,
      `frame=${frame?.frameId} current=${frame?.os?.current?.comm} processes=${frame?.os?.processes?.length}`);
    check('B7 进程/VMA/fd 解析', Array.isArray(frame?.os?.processes) && frame.os.processes.length > 5
      && (frame.os.addressSpace?.vmas?.length ?? 0) > 0 && (frame.os.files?.length ?? 0) > 0,
      `processes=${frame?.os?.processes?.length} vmas=${frame?.os?.addressSpace?.vmas?.length} files=${frame?.os?.files?.length}`);

    const fsView = await call(base, 'GET', `/api/sessions/${session.id}/filesystem?path=/data&depth=1`);
    const hello = fsView.body?.entries?.find((entry) => entry.name === 'hello.txt');
    const probe = fsView.body?.entries?.find((entry) => entry.name === 'probe.bin');
    check('B8 ext2 盘面视图', fsView.status === 200 && fsView.body?.resolved === true
      && hello?.inode?.size === '85' && probe?.inode?.size === '2097152',
      `hello=${hello?.inode?.size} probe=${probe?.inode?.size} reads=${fsView.body?.diskReads}`);

    const translated = await call(base, 'GET',
      `/api/sessions/${session.id}/memory?mode=translate&address=${encodeURIComponent(frame?.cpu?.rip ?? '0x0')}`);
    const translation = translated.body?.translation ?? translated.body;
    check('B9 该帧页表翻译', translated.status === 200 && Array.isArray(translation?.walk)
      && translation.walk.length > 0,
      `physical=${translation?.physical} levels=${translation?.walk?.length} fault=${translation?.fault?.kind ?? 'none'}`);

    const catalog = await call(base, 'GET', `/api/sessions/${session.id}/curriculum`);
    check('B10 课程可用性', catalog.status === 200 && catalog.body?.lessons?.length === curriculum.lessons.length
      && catalog.body.unavailable.length === 0,
      `${catalog.body?.lessons?.length} 课，不可用 ${catalog.body?.unavailable?.length}`);

    const recording = await call(base, 'GET', `/api/sessions/${session.id}/recording`);
    check('B11 录制导出散列', recording.status === 200 && recording.headers.get('x-content-sha256')?.length === 64,
      `${recording.text.length} 字节 / ${recording.headers.get('x-content-sha256')?.slice(0, 16)}…`);
    const imported = await call(base, 'POST', '/api/recordings', recording.text,
      { 'x-content-sha256': recording.headers.get('x-content-sha256') });
    check('B12 录制导入与校验', imported.status === 201 && imported.body?.frameCount >= 2,
      `${imported.body?.id} frames=${imported.body?.frameCount} sha=${imported.body?.sha256?.slice(0, 16)}…`);

    const recorded = await command(base, session.id, {
      type: 'view', requestId: 't13-view-recorded', mode: 'recorded', targetFrameId: 0,
    });
    check('B13 进入历史回看', recorded.status === 200 && recorded.body?.mode === 'recorded',
      `viewFrameId=${recorded.body?.viewFrameId}`);
    const historyMemory = await call(base, 'GET',
      `/api/sessions/${session.id}/memory?addressSpace=physical&address=0x0&length=16`);
    check('B14 历史模式拒绝读当前 VM', historyMemory.status === 400
      && historyMemory.body?.error?.code === 'history-read-only', historyMemory.body?.error?.message);
    await command(base, session.id, { type: 'view', requestId: 't13-view-live', mode: 'live' });

    await call(base, 'DELETE', `/api/sessions/${session.id}`);
    await sleep(800);
    check('B15 关闭后无残留进程', sessionProcessCount(session.id) === 0, `残留 ${sessionProcessCount(session.id)}`);

    /* ---------- full-boot：L01–L07 ---------- */
    const full = await call(base, 'POST', '/api/sessions', { profile: 'full-boot' });
    const fullId = full.body?.id;
    report.sessions.push({ id: fullId, profile: 'full-boot' });
    check('C1 full-boot 启动', full.status === 201 && full.body?.firstFrame?.stop?.pc === '0xfffffff0',
      `${fullId} / ${full.body?.firstFrame?.stop?.pc}`);

    const calibrated = await command(base, fullId, {
      type: 'boot.calibrate', requestId: 't13-calibrate', timeoutMs: 120000,
    });
    check('C2 L01–L04 启动课程', calibrated.status === 200
      && JSON.stringify(calibrated.body?.lessons) === JSON.stringify(['L01', 'L02', 'L03', 'L04']),
      JSON.stringify(calibrated.body?.lessons));

    const stops = [];
    for (const [id, symbol] of [['L05', 'start_kernel'], ['L06', 'kernel_init'], ['L07', 'ext2_fill_super']]) {
      const result = await command(base, fullId, {
        type: 'run-to', requestId: `t13-${id}`, location: { symbol, module: 'linux-kernel' }, timeoutMs: 240000,
      });
      stops.push({ id, lesson: result.body?.frame?.lesson?.lessonId, symbol: result.body?.frame?.source?.symbol });
      check(`C3 ${id} 课程`, result.status === 200 && result.body?.frame?.lesson?.lessonId === id,
        `symbol=${result.body?.frame?.source?.symbol} lesson=${result.body?.frame?.lesson?.lessonId}`);
    }
    report.bootStops = stops;

    // L07 停在 ext2_fill_super；继续运行，让 initramfs 完成挂载和 switch_root。
    const latest = (await call(base, 'GET', `/api/sessions/${fullId}`)).body.latestFrameId;
    await command(base, fullId, { type: 'continue', requestId: 't13-after-l07' });
    const fullTerminal = await waitTerminal(base, fullId, /linux-lab:.*# /, 180000);
    check('C4 full-boot 到 shell', fullTerminal !== null,
      fullTerminal === null ? '未出现提示符' : JSON.stringify(fullTerminal.slice(-80)));
    const frameList = await call(base, 'GET', `/api/sessions/${fullId}/frames`);
    check('C5 启动帧序列', frameList.body?.frames?.length >= 8
      && ['L00', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07'].every((id) =>
        frameList.body.frames.some((entry) => entry.lessonId === id)),
      frameList.body?.frames?.map((entry) => `${entry.frameId}:${entry.lessonId ?? '-'}`).join(' '));

    await call(base, 'DELETE', `/api/sessions/${fullId}`);
    await sleep(800);
    check('C6 full-boot 关闭后无残留进程', sessionProcessCount(fullId) === 0, `残留 ${sessionProcessCount(fullId)}`);
  } finally {
    for (const [id] of registry.sessions) {
      await call(base, 'DELETE', `/api/sessions/${id}`).catch(() => {});
    }
    await app.close();
  }

  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter((entry) => entry.ok).length;
  report.failed = report.checks.filter((entry) => !entry.ok).length;
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${report.failed} failed -> ${EVIDENCE}`);
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  report.finishedAt = new Date().toISOString();
  report.failed = (report.failed ?? 0) + 1;
  report.checks.push({ id: 'fatal', ok: false, detail: error.message });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
  process.exit(1);
});
