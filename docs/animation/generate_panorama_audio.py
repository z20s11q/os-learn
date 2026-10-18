#!/usr/bin/env python3
"""Generate reusable MP3 narration without rebuilding the animation or video.

Input JSON: [{"id": "reset", "text": "CPU 从复位向量开始执行。"}, ...]
Also accepts {"steps": [...]} and each entry's "narration" field.

    python3 docs/animation/generate_panorama_audio.py --input /tmp/narration.json
    python3 docs/animation/generate_panorama_audio.py --voices

Existing project dependency: edge-tts. This uses its online service; it is not an
offline model. The voice name remains the provider's actual voice name. A custom
voice can instead be recorded/generated elsewhere and supplied as an audio map.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path


async def main(args: argparse.Namespace) -> None:
    try:
        import edge_tts
    except ImportError as exc:
        raise SystemExit("缺少 edge-tts；请在项目 Python 环境安装此依赖。") from exc

    if args.voices:
        voices = await edge_tts.list_voices()
        for voice in voices:
            if voice["Locale"].startswith("zh-"):
                print(f'{voice["ShortName"]}\t{voice["Gender"]}\t{voice["Locale"]}')
        return
    if not args.input:
        raise SystemExit("请提供 --input JSON 文件，或使用 --voices 列出中文语音。")
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    entries = payload.get("steps") if isinstance(payload, dict) else payload
    if not isinstance(entries, list) or not entries:
        raise SystemExit("旁白 JSON 应为非空数组，或包含 steps 数组。")

    prepared = []
    identifiers = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise SystemExit(f"第 {index + 1} 项不是对象。")
        identifier = str(entry.get("id", ""))
        text = entry.get("text") or entry.get("narration")
        if not identifier or not isinstance(text, str) or not text.strip():
            raise SystemExit(f"第 {index + 1} 项需要非空 id 和 text/narration 字符串。")
        if identifier in identifiers:
            raise SystemExit(f"id 重复：{identifier}")
        identifiers.add(identifier)
        text = text.strip()
        digest = hashlib.sha256(json.dumps({
            "text": text, "voice": args.voice, "rate": args.rate, "pitch": args.pitch,
        }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        slug = re.sub(r"[^a-zA-Z0-9_-]", "-", identifier).strip("-")[:64] or f"step-{index:03d}"
        prepared.append({"id": identifier, "text": text, "file": f"{slug}-{digest[:16]}.mp3", "sha256": digest})

    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(args.concurrency)
    completed = 0
    previous = {}
    manifest_path = output / "manifest.json"
    if manifest_path.exists():
        try:
            previous = {e["id"]: e for e in json.loads(manifest_path.read_text(encoding="utf-8")).get("entries", [])}
        except (ValueError, KeyError):
            previous = {}

    async def synthesize(text: str, destination: Path) -> list:
        """Write MP3 and return word timings as [seconds, text] for subtitle sync."""
        words = []
        with destination.open("wb") as handle:
            communicate = edge_tts.Communicate(text, args.voice, rate=args.rate, pitch=args.pitch, boundary="WordBoundary")
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    handle.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    words.append([round(chunk["offset"] / 1e7, 3), chunk["text"]])
        return words

    async def generate(entry: dict) -> dict:
        nonlocal completed
        destination = output / entry["file"]
        old = previous.get(entry["id"], {})
        words = old.get("words") if old.get("sha256") == entry["sha256"] else None
        async with semaphore:
            if not destination.exists() or destination.stat().st_size < 100 or not words:
                temporary = destination.with_suffix(".part")
                try:
                    for attempt in range(3):
                        try:
                            print(f'[tts] {entry["id"]} · {args.voice}', flush=True)
                            words = await synthesize(entry["text"], temporary)
                            if temporary.stat().st_size < 100:
                                raise RuntimeError("TTS 未返回有效音频")
                            temporary.replace(destination)
                            break
                        except Exception:
                            if attempt == 2:
                                raise
                            await asyncio.sleep(2 ** attempt)
                finally:
                    temporary.unlink(missing_ok=True)
            completed += 1
            print(f'[ready] {completed}/{len(prepared)} · {entry["id"]} · {destination.stat().st_size} bytes', flush=True)
            return {**entry, "bytes": destination.stat().st_size, "words": words}

    results = await asyncio.gather(*(generate(entry) for entry in prepared))
    prefix = args.url_prefix.rstrip("/")
    manifest = {
        "provider": "edge-tts",
        "voice": args.voice,
        "rate": args.rate,
        "pitch": args.pitch,
        "audioMap": {entry["id"]: f'{prefix}/{entry["file"]}' if prefix else entry["file"] for entry in results},
        "entries": results,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f'[done] {len(results)} 段旁白 → {manifest_path}', flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", help="带有 id 与 text/narration 的 JSON 数组")
    parser.add_argument("--output", default=str(Path(__file__).resolve().parent / "audio/panorama"))
    parser.add_argument("--url-prefix", default="audio/panorama", help="相对动画页面的音频 URL 前缀；与输出目录一起修改")
    parser.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--concurrency", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--voices", action="store_true")
    try:
        asyncio.run(main(parser.parse_args()))
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"旁白生成失败：{exc}", file=sys.stderr)
        sys.exit(1)
