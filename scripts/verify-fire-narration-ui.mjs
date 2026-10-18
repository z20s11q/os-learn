import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = process.env.NARRATION_BASE_URL || 'http://127.0.0.1:18546/animation';
const manifest = JSON.parse(fs.readFileSync('docs/animation/boot/audio/manifest.json', 'utf8'));
const browser = await chromium.launch();
const errors = [], failed = [], report = {};
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.__audios = [];
      window.Audio = function (...args) {
        const audio = new NativeAudio(...args);
        window.__audios.push(audio);
        return audio;
      };
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) failed.push([r.status(), r.url()]); });
    const size = viewport.width === 390 ? 'mobile' : 'desktop';
    report[size] = {};
    await page.goto(`${base}/boot.html`);
    await page.waitForFunction(() => window.__story?.ready);
    report[size].boot = await page.evaluate(() => ({
      clips: window.__story.ops.length,
      allFire: window.__story.ops.every(o => o.audio?.includes('/fire-')),
    }));
    assert.equal(report[size].boot.clips, manifest.entries.length);
    assert.ok(report[size].boot.allFire);
    const pageFiles = await page.evaluate(() => window.__story.ops.map(o => o.audio));
    assert.deepEqual(pageFiles, manifest.entries.map(e => `boot/audio/${e.file}`));
    report[size].boot.pronunciationVersion = manifest.pronunciationVersion;
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.readyState >= 2));
    report[size].boot.playing = await page.evaluate(() => window.__audios.find(a => !a.paused).src);
    assert.match(report[size].boot.playing, /fire-/);
    await page.locator('#play').click();
    await page.locator('#nextOp').click();
    await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.readyState >= 2 && a.src.includes('fire-intro-1-')));
    report[size].boot.nextStep = true;
    await page.locator('#prevOp').click();
    await page.waitForFunction(() => window.__audios.some(a => !a.paused && a.readyState >= 2 && a.src.includes('fire-intro-0-')));
    await page.locator('#speed').selectOption('1.25');
    assert.equal(await page.evaluate(() => window.__audios.find(a => !a.paused)?.playbackRate), 1.25);
    await page.locator('#mute').click();
    await page.waitForFunction(() => window.__audios.every(a => a.paused));
    report[size].boot.speedAndMute = true;
    await page.locator('#speed').selectOption('1');
    await page.locator('#mute').click();
    const numberIndex = manifest.entries.findIndex(e => e.id === 'primer-5');
    await page.evaluate(index => {
      document.getElementById('seek').dispatchEvent(new Event('input', { bubbles: true }));
      window.__story.seek(window.__story.ops[index].start);
    }, numberIndex);
    await page.locator('#play').click();
    const numberFile = manifest.entries[numberIndex].file;
    await page.waitForFunction(file => window.__audios.some(a => !a.paused && a.readyState >= 2 && a.src.endsWith(file)), numberFile);
    report[size].boot.numericClip = numberFile;
    await page.locator('#play').click();
    await page.evaluate(() => {
      document.getElementById('seek').dispatchEvent(new Event('input', { bubbles: true }));
      window.__story.seek(window.__story.ops.at(-1).start);
    });
    await page.locator('#play').click();
    const lastFile = manifest.entries.at(-1).file;
    await page.waitForFunction(file => window.__audios.some(a => !a.paused && a.readyState >= 2 && a.src.endsWith(file)), lastFile);
    report[size].boot.lastClip = lastFile;
    await page.locator('#play').click();
    await page.screenshot({ path: `artifacts/fire-boot-${size}.png`, fullPage: true });
    const removedPage = await context.request.get(`${base}/slides.html`);
    assert.equal(removedPage.status(), 404);
    report[size].oldPageRemoved = true;
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failed, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.writeFileSync('artifacts/fire-narration-ui-verification.json', JSON.stringify({ ...report, errors, failed }, null, 2));
  await browser.close();
}
