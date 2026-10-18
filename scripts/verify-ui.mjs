#!/usr/bin/env node
/**
 * T08/T09 浏览器验收（真实 QEMU + 真实录制包 + Chromium）。
 *
 * 前置：`npm run build` 已生成 apps/debugger-web/dist；本机有 Chromium。
 * 运行：node scripts/verify-ui.mjs
 * 证据：artifacts/verify/t08-reset.png、t09-recording.png、t08-ui.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildServer } from '../services/lab-server/main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EVIDENCE = path.join(ROOT, 'artifacts/verify/t08-ui.json');
const BROWSER = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser';
const report = { schema: 'oslab.ui-acceptance/1', checks: [], errors: [] };

function check(id, ok, detail) {
  report.checks.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
}

const { app, registry } = await buildServer({ logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser = null;
try {
  // 先造一个真实录制包：kernel-fast 启动 + 单步两次。
  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'kernel-fast' }),
  }).then((response) => response.json());
  const sessionId = created.id;
  await fetch(`${base}/api/sessions/${sessionId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'step', requestId: 'ui-record', epoch: 1, expectedFrameId: 0, granularity: 'instruction', count: 2 }),
  });
  const recording = await fetch(`${base}/api/sessions/${sessionId}/recording`);
  const recordingPath = path.join(os.tmpdir(), `oslab-ui-recording-${Date.now()}.json`);
  fs.writeFileSync(recordingPath, await recording.text());
  await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE' });

  browser = await chromium.launch({ headless: true, executablePath: BROWSER, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push(message.text());
  });
  page.on('pageerror', (error) => report.errors.push(error.message));

  await page.goto(`${base}/lab/`, { waitUntil: 'networkidle' });
  check('U1 页面加载', (await page.title()).includes('Linux Observatory'), await page.title());

  await page.locator('input[type=file]').setInputFiles(recordingPath);
  await page.waitForFunction(() => document.querySelector('[data-testid="frame-id"]')?.textContent === '0', { timeout: 30000 });
  check('U2 导入录制包', true, 'frame 0');
  check('U3 教学点匹配', (await page.locator('.lesson-title').textContent()) === 'CPU 复位后的第一条指令',
    await page.locator('.lesson-title').textContent());
  const chips = await page.locator('.frame-chip').count();
  check('U4 时间线帧', chips === 3, `${chips} 个帧`);
  await page.click('button:text-is("下一帧 →")');
  await page.waitForTimeout(400);
  check('U5 前进一帧', (await page.textContent('[data-testid="frame-id"]')) === '1', 'frame 1');
  await page.click('button:text-is("← 上一帧")');
  await page.waitForTimeout(400);
  check('U6 后退一帧', (await page.textContent('[data-testid="frame-id"]')) === '0', 'frame 0');
  await page.screenshot({ path: path.join(ROOT, 'artifacts/verify/t09-recording.png') });

  await page.click('button:text-is("关闭回放")');
  await page.waitForTimeout(300);
  await page.click('text=启动真实会话');
  await page.waitForFunction(() => document.querySelector('[data-testid="frame-id"]')?.textContent === '0', { timeout: 180000 });
  check('U7 启动真实会话', true, 'frame 0');
  check('U8 三栏与时间线', (await page.locator('.column').count()) >= 3 && (await page.locator('[data-testid="timeline"]').count()) === 1,
    `columns=${await page.locator('.column').count()}`);
  const panelCount = await page.locator('.dashboard .panel').count();
  check('U9 分屏仪表盘全部面板', panelCount === 9, `${panelCount} 个面板同时挂载`);
  await page.screenshot({ path: path.join(ROOT, 'artifacts/verify/t08-reset.png') });
  await page.click('button:text-is("关闭会话")');
  await page.waitForTimeout(800);

  check('U10 无浏览器脚本错误', report.errors.length === 0, report.errors.join(' | ') || 'none');
} catch (error) {
  report.errors.push(error.message);
  check('U0 浏览器验收执行', false, error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const [id] of registry.sessions) await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  await app.close();
}

report.passed = report.checks.filter((entry) => entry.ok).length;
report.failed = report.checks.filter((entry) => !entry.ok).length;
fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
fs.writeFileSync(EVIDENCE, JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed -> ${EVIDENCE}`);
process.exit(report.failed === 0 ? 0 : 1);
