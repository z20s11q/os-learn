/**
 * T04 前端实时闭环验证（真实浏览器）。
 *
 * 用 Playwright 打开真实页面，点击真实的「启动真实会话」按钮，
 * 让 QEMU 冷启动到复位，然后单步、读物理 ROM、截图并关闭会话。
 *
 * 运行前需要 lab-server 已在 13029 端口运行：
 *   LAB_PORT=13029 node services/lab-server/main.mjs &
 *   node scripts/verify-web.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.LAB_URL ?? 'http://127.0.0.1:13029';
const results = [];
let failures = 0;

/**
 * 本机缓存的 Chromium 版本号可能落后于 playwright 期望的版本，
 * 这里直接找到可执行文件并显式传入，避免 `Executable doesn't exist`。
 */
function resolveChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache/ms-playwright');
  if (!fs.existsSync(cache)) return null;
  const candidates = fs
    .readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const name of candidates) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join(cache, name, sub);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

const root = path.resolve(import.meta.dirname, '..');

async function main() {
  const executablePath = resolveChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedResponses = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${BASE}/lab/`, { waitUntil: 'domcontentloaded' });
  record('page loads', await page.getByRole('heading', { name: 'Linux Observatory' }).isVisible(), BASE + '/lab/');

  const emptyState = await page.getByText('启动真实会话').count();
  record('empty state shows start control', emptyState > 0, `按钮数=${emptyState}`);

  console.log('点击「启动真实会话」，等待真实 QEMU 冷启动与符号加载（1–2 分钟）…');
  await page.getByRole('button', { name: '启动真实会话' }).click();

  // 复位帧是 frameId 0
  await page.waitForFunction(
    () => document.querySelector('[data-testid="frame-id"]')?.textContent?.trim() === '0',
    undefined,
    { timeout: 300000 },
  );
  await page.waitForSelector('[data-testid="cpu-rip"]', { timeout: 15000 });

  const mode = (await page.getByTestId('cpu-mode').textContent())?.trim();
  const rip = (await page.getByTestId('cpu-rip').textContent())?.trim();
  record('reset frame rendered in browser', mode === 'real-16' && rip === '0xfff0', `mode=${mode} rip=${rip}`);

  const sessionState = (await page.getByTestId('session-state').textContent())?.trim();
  record('session paused after capture', sessionState === '已暂停', `state=${sessionState}`);

  // 单步：帧号应推进且 rip 变化（0xfff0 -> 0xe05b，越过复位跳转）
  const bytesBefore = (await page.getByTestId('instruction-bytes').count()) > 0;
  await page.getByRole('button', { name: '单步', exact: true }).click();
  await page.waitForFunction(
    () => {
      const text = document.querySelector('[data-testid="frame-id"]')?.textContent?.trim();
      return text !== null && text !== undefined && text !== '0' && text !== '—';
    },
    undefined,
    { timeout: 60000 },
  );
  const ripAfterStep = (await page.getByTestId('cpu-rip').textContent())?.trim();
  const frameAfterStep = (await page.getByTestId('frame-id').textContent())?.trim();
  record(
    'step from browser updates registers',
    ripAfterStep !== rip && ripAfterStep === '0xe05b',
    `frame=${frameAfterStep} rip ${rip} -> ${ripAfterStep}`,
  );
  record(
    'instruction bytes availability honest',
    bytesBefore === false,
    bytesBefore ? '显示了指令字节（可能有新能力接入）' : '未接入时明确显示未采集，符合 T04 范围',
  );

  // 物理读取复位 ROM：0xfffffff0 应为 ea5be000f0
  const memoryPanel = page.getByTestId('panel-memory');
  await memoryPanel.getByLabel('地址').fill('0xfffffff0');
  await memoryPanel.getByLabel('空间').selectOption('physical');
  await memoryPanel.getByLabel('长度').fill('16');
  await memoryPanel.getByRole('button', { name: '读取', exact: true }).click();
  await page.waitForSelector('[data-testid="memory-dump"]', { timeout: 30000 });
  const dump = (await page.getByTestId('memory-dump').textContent()) ?? '';
  record(
    'physical ROM read from browser',
    /ea 5b e0 00 f0/.test(dump),
    dump.split('\n')[0]?.slice(0, 80),
  );

  const screenshotDir = path.join(root, 'artifacts/verify');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, 't04-web.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  record('screenshot captured', fs.existsSync(screenshotPath), screenshotPath);

  // 在故意制造一次 400 之前先做洁净性断言，避免把预期错误当成缺陷
  record('no page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300) || '无');
  const actionableFailures = failedResponses.filter((entry) => !/favicon/i.test(entry));
  record(
    'no failed requests',
    actionableFailures.length === 0,
    actionableFailures.join(' | ').slice(0, 300) || '无',
  );

  // 断点面板：歧义符号返回候选供选择。
  // 这一步会故意让服务端返回 400（ambiguous-symbol），所以放在洁净性断言之后。
  const breakpointPanel = page.getByTestId('panel-breakpoints');
  await breakpointPanel.getByLabel('符号').fill('startup_64');
  await breakpointPanel.getByLabel('模块').fill('');
  await breakpointPanel.getByRole('button', { name: '插入断点' }).click();
  let ambiguityText = 0;
  let ambiguityDetail = '';
  try {
    const ambiguityLocator = page.getByText(/在多个模块中存在/);
    await ambiguityLocator.first().waitFor({ timeout: 90000 });
    ambiguityText = await ambiguityLocator.count();
    ambiguityDetail = ((await ambiguityLocator.first().textContent()) ?? '').slice(0, 200);
  } catch {
    ambiguityText = 0;
  }
  record(
    'ambiguous symbol surfaced in UI',
    ambiguityText > 0 && !ambiguityDetail.includes('[object Object]') && /linux-(decompressor|kernel)/.test(ambiguityDetail),
    `提示条数=${ambiguityText} ${ambiguityDetail.replace(/\s+/g, ' ')}`,
  );

  // 限定模块后必须能真正插入断点，且歧义提示消失
  await breakpointPanel.getByLabel('模块').fill('linux-kernel');
  await breakpointPanel.getByRole('button', { name: '插入断点' }).click();
  let inserted = false;
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('startup_64') && /命中 \d+/.test(document.body.innerText),
      undefined,
      { timeout: 90000 },
    );
    const stillAmbiguous = await page.getByText(/在多个模块中存在/).count();
    inserted = stillAmbiguous === 0;
  } catch {
    inserted = false;
  }
  record('module-qualified breakpoint inserted', inserted, inserted ? '断点列表出现 linux-kernel 限定断点' : '未能插入');

  await page.getByRole('button', { name: '关闭会话' }).click();
  await page.waitForTimeout(1500);

  await browser.close();

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n汇总：${passed}/${results.length} 通过，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('浏览器验证异常:', error);
  process.exit(2);
});
