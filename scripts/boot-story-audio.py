#!/usr/bin/env python3
"""为 boot.html 的每一步合成中文配音。

输入 tmp/boot-story-tts.json（由 scripts/build-boot-story.mjs 生成），
输出 docs/animation/boot/audio/<key>.mp3 与 manifest.json（含时长）。
已存在且时长有效的文件不会重复合成。
"""
import asyncio
import json
import pathlib
import re
import subprocess
import sys

import edge_tts

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'tmp/boot-story-tts.json'
OUT = ROOT / 'docs/animation/boot/audio'
FFMPEG = '/usr/local/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2'
RATE = '+4%'


def duration(path: pathlib.Path) -> float:
    r = subprocess.run([FFMPEG, '-hide_banner', '-i', str(path)], capture_output=True, text=True)
    m = re.search(r'Duration: (\d+):(\d+):([\d.]+)', r.stderr)
    if not m:
        return 0.0
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


async def synth(voice: str, item: dict, sem: asyncio.Semaphore) -> dict:
    path = OUT / f"{item['key']}.mp3"
    async with sem:
        for attempt in range(4):
            if path.exists() and path.stat().st_size > 1000:
                d = duration(path)
                if d > 0.3:
                    return {'key': item['key'], 'file': path.name, 'duration': round(d, 3)}
            try:
                await edge_tts.Communicate(item['text'], voice, rate=RATE).save(str(path))
            except Exception as e:  # noqa: BLE001
                print(f"retry {item['key']} ({attempt + 1}): {e}", file=sys.stderr)
                await asyncio.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"合成失败：{item['key']} {item['text']}")


async def main() -> None:
    spec = json.loads(SRC.read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(6)
    entries = await asyncio.gather(*(synth(spec['voice'], it, sem) for it in spec['items']))
    keep = {e['file'] for e in entries}
    for f in OUT.glob('*.mp3'):
        if f.name not in keep:
            f.unlink()
    (OUT / 'manifest.json').write_text(json.dumps({'voice': spec['voice'], 'entries': entries}, ensure_ascii=False, indent=1))
    total = sum(e['duration'] for e in entries)
    print(f'{len(entries)} clips, {total:.1f}s speech')


asyncio.run(main())
