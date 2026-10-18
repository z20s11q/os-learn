#!/usr/bin/env python3
"""把 docs/animation/boot.html 逐帧导出为 MP4（含配音）。

用法：python3 scripts/boot-story-video.py [--url URL] [--out PATH] [--fps 25] [--workers 8] [--from S --to S]
页面以 ?video=1 打开，通过 window.__story.seek(t) 定位到每一帧，截图后交给 ffmpeg 编码。
"""
import argparse
import asyncio
import json
import pathlib
import subprocess
import sys
import time

import numpy as np
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FFMPEG = '/usr/local/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2'
CHROME = '/root/.cache/ms-playwright/chromium-1232/chrome-linux64/chrome'
AUDIO_DIR = ROOT / 'docs/animation'
SR = 24000
AUDIO_LEAD = 0.15


async def open_page(pw, url):
    browser = await pw.chromium.launch(executable_path=CHROME, args=['--force-device-scale-factor=1'])
    page = await browser.new_page(viewport={'width': 1920, 'height': 1080})
    page.on('pageerror', lambda e: print('PAGEERROR', e, file=sys.stderr))
    await page.goto(url, wait_until='networkidle')
    await page.wait_for_function('window.__story && window.__story.ready')
    return browser, page


async def render_segment(pw, url, fps, f0, f1, out, idx, progress):
    browser, page = await open_page(pw, url)
    enc = subprocess.Popen([FFMPEG, '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', str(fps), '-c:v', 'mjpeg', '-i', '-',
                            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', str(fps), str(out)],
                           stdin=subprocess.PIPE)
    for f in range(f0, f1):
        await page.evaluate('t => window.__story.seek(t)', f / fps)
        jpg = await page.screenshot(type='jpeg', quality=92)
        enc.stdin.write(jpg)
        progress[idx] = f - f0 + 1
    enc.stdin.close()
    enc.wait()
    await browser.close()
    if enc.returncode:
        raise RuntimeError(f'ffmpeg 编码失败：段 {idx}')


def build_audio(ops, total, start, end, out):
    buf = np.zeros(int((end - start) * SR) + SR, dtype=np.float32)
    for op in ops:
        if not op.get('audio'):
            continue
        t = op['start'] + AUDIO_LEAD - start
        if t + 30 < 0 or t > end - start:
            continue
        pcm = subprocess.run([FFMPEG, '-loglevel', 'error', '-i', str(AUDIO_DIR / op['audio']), '-f', 's16le', '-ac', '1', '-ar', str(SR), '-'],
                             capture_output=True, check=True).stdout
        clip = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        i = int(round(t * SR))
        a, b = max(0, i), min(len(buf), i + len(clip))
        if b > a:
            buf[a:b] += clip[a - i:b - i]
    pcm = (np.clip(buf[: int((end - start) * SR)], -1, 1) * 32767).astype(np.int16).tobytes()
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-f', 's16le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'aac', '-b:a', '128k', str(out)],
                   input=pcm, check=True)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:13029/animation/boot.html?video=1')
    ap.add_argument('--out', default=str(ROOT / 'docs/video/linux-boot-cpu-memory.mp4'))
    ap.add_argument('--fps', type=int, default=25)
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--from', dest='t0', type=float, default=0)
    ap.add_argument('--to', dest='t1', type=float, default=None)
    args = ap.parse_args()

    tmp = ROOT / 'tmp/boot-video'
    tmp.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser, page = await open_page(pw, args.url)
        info = await page.evaluate('({ total: __story.total, ops: __story.ops })')
        await browser.close()
        total = info['total']
        t1 = min(total, args.t1 or total)
        f0, f1 = int(args.t0 * args.fps), int(t1 * args.fps)
        n = f1 - f0
        w = max(1, min(args.workers, n // 50 or 1))
        bounds = [f0 + n * i // w for i in range(w + 1)]
        segs = [tmp / f'seg{i:02d}.mp4' for i in range(w)]
        progress = [0] * w
        print(f'{n} 帧（{n / args.fps:.1f}s），{w} 路并行')
        began = time.time()

        async def report():
            while True:
                await asyncio.sleep(15)
                done = sum(progress)
                el = time.time() - began
                print(f'  {done}/{n} 帧，{el:.0f}s，预计还需 {el / max(done, 1) * (n - done):.0f}s', flush=True)

        rep = asyncio.create_task(report())
        await asyncio.gather(*(render_segment(pw, args.url, args.fps, bounds[i], bounds[i + 1], segs[i], i, progress) for i in range(w)))
        rep.cancel()

    audio = tmp / 'narration.m4a'
    build_audio(info['ops'], total, f0 / args.fps, f1 / args.fps, audio)
    lst = tmp / 'segs.txt'
    lst.write_text(''.join(f"file '{s}'\n" for s in segs))
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-i', str(audio),
                    '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', str(out)], check=True)
    (out.with_suffix('.json')).write_text(json.dumps({'duration': n / args.fps, 'fps': args.fps,
                                                       'chapters': [{'start': o['start'], 'say': o['say']} for o in info['ops']]}, ensure_ascii=False, indent=1))
    print(f'完成：{out}（{time.time() - began:.0f}s）')


asyncio.run(main())
