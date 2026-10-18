#!/usr/bin/env node
/* Render docs/linux-kernel-animation.html frame by frame into WebM videos (one per story).
 * Frames come from window.__anim.render(T), so output is smooth regardless of machine speed.
 * Needs playwright (NODE_PATH) and an ffmpeg with mjpeg decode + libvpx encode
 * (FFMPEG, defaults to Playwright's bundled ffmpeg-linux).
 * Usage: node anim.record.cjs [story ...] [--fps=30] [--from=ms] [--to=ms] [--out=dir]
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '../../..')
const PAGE = 'file://' + path.join(ROOT, 'docs/linux-kernel-animation.html')
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')))
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const FPS = +(opt.fps || 30)
const OUT = path.resolve(opt.out || path.join(ROOT, 'docs/video'))
const FFMPEG = process.env.FFMPEG || fs.readdirSync(path.join(process.env.HOME, '.cache/ms-playwright')).filter((d) => d.startsWith('ffmpeg-')).map((d) => path.join(process.env.HOME, '.cache/ms-playwright', d, 'ffmpeg-linux')).find(fs.existsSync)

async function record(browser, id) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${PAGE}?record=1&story=${id}`)
  await page.waitForTimeout(300)
  const dur = await page.evaluate(() => window.__anim.dur)
  const from = +(opt.from || 0), to = Math.min(dur, +(opt.to || dur))
  const file = path.join(OUT, `linux-kernel-${id}${opt.from || opt.to ? `-${from}-${to}` : ''}.webm`)
  const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libvpx', '-b:v', '2500k', '-crf', '8', '-qmin', '2', '-qmax', '36', '-deadline', 'good', '-cpu-used', '3', '-auto-alt-ref', '0', '-pix_fmt', 'yuv420p', file],
  { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((res, rej) => ff.on('close', (c) => (c ? rej(new Error('ffmpeg exit ' + c)) : res())))
  const n = Math.ceil(((to - from) / 1000) * FPS)
  const t0 = Date.now()
  for (let k = 0; k <= n; k++) {
    await page.evaluate((T) => window.__anim.render(T), Math.min(to - 1, from + (k * 1000) / FPS))
    const buf = await page.screenshot({ type: 'jpeg', quality: 90 })
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    if (k % (FPS * 20) === 0) console.log(`${id}: ${Math.round((k / n) * 100)}% (${k}/${n} frames, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  ff.stdin.end()
  await done
  await page.close()
  if (errs.length) throw new Error(errs.join('\n'))
  console.log(`${id}: wrote ${path.relative(ROOT, file)} · ${(fs.statSync(file).size / 1e6).toFixed(1)} MB · ${((to - from) / 1000).toFixed(0)}s video`)
}

;(async () => {
  if (!FFMPEG) throw new Error('ffmpeg not found; set FFMPEG')
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const all = ids.length ? ids : await (async () => { const p = await browser.newPage(); await p.goto(PAGE + '?record=1'); const s = await p.evaluate(() => window.__anim.stories); await p.close(); return s })()
  await Promise.all(all.map((id) => record(browser, id)))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
