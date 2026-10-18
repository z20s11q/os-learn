#!/usr/bin/env python3
"""Generate narration using local CUDA models or a hosted Fish Audio voice.

Requires scripts/tts-requirements.txt and CUDA PyTorch; see docs/local-narration.md.
Only publishes a bundle after every clip is complete. Interrupted runs reuse
content-addressed sentence WAVs and do not switch the player to a partial pack.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from narration_text import VERSION, spoken_text

ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'
INSTRUCTION = ('用清晰自然的普通话讲解计算机课程，语气平稳亲切，语速适中。'
               '中英文衔接流畅，英文单词发音准确，字母缩写逐个字母读。'
               '根据语义自然停顿，不要在词语中间停顿，不要唱歌，不要添加内容。')


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.json.part')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def sentences(text):
    # Keep comma clauses and English identifiers together for natural prosody.
    return [(m.start(), m.end(), m.group()) for m in re.finditer(r'[^。！？；\n]+[。！？；\n]*', text) if m.group().strip()]


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=['mambo', 'qwen', 'fish', 'fire', 'index'], default='mambo')
    parser.add_argument('--index-model-dir', type=Path, default=ROOT / 'artifacts/indextts25')
    parser.add_argument('--generation-id', default='', help='Use fresh synthesis caches for a named revision')
    parser.add_argument('--input-json', type=Path, help='Selected source entries for matched auditions')
    parser.add_argument('--raw-text', action='store_true', help='Pass original text, digits, and identifiers unchanged (FireRed/Index)')
    parser.add_argument('--output-root', type=Path, help='Write complete bundles separately without replacing page audio')
    parser.add_argument('--rate', type=float, help='Final rate; default 1.0 for FireRed/Fish, 0.9 for Mambo/Qwen')
    parser.add_argument('--fire-model-dir', type=Path, default=ROOT / 'artifacts/fireredtts3')
    parser.add_argument('--fire-max-chars', type=int, default=80, help='Maximum spoken characters per FireRed request')
    parser.add_argument('--fire-cuda-graph', action='store_true', help='Replay the fixed-shape FireRed DiT on CUDA')
    parser.add_argument('--fish-reference-id', default='0f08cacd3e354471a4b94dd00b4cc4a3')
    parser.add_argument('--fish-model', choices=['s2.1-pro-free', 's2.1-pro', 's2-pro'], default='s2.1-pro-free')
    parser.add_argument('--dry-run', action='store_true', help='Show uncached text volume; no synthesis or publication')
    parser.add_argument('--api-url', default='http://127.0.0.1:18547', help='Local Mambo GPT-SoVITS API')
    parser.add_argument('--models-dir', default=str(ROOT / 'artifacts/mambo-release/MamboTTS-v1.2.1-full/models'))
    parser.add_argument('--reference-text', default='大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容')
    parser.add_argument('--bundle', choices=['boot', 'panorama', 'all'], default='all')
    parser.add_argument('--model', default=str(ROOT / 'artifacts/models/Qwen3-TTS-12Hz-1.7B-CustomVoice'), help='Qwen engine only: model directory')
    parser.add_argument('--speaker', default='Serena', help='Qwen engine only: speaker')
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--sample', action='store_true', help='Only generate a pronunciation audition')
    parser.add_argument('--limit', type=int, help='Generate a subset in artifacts, without publishing')
    args = parser.parse_args()
    if args.raw_text and args.engine not in ('fire', 'index'):
        parser.error('--raw-text is supported for FireRed and Index only')
    if args.rate is None:
        args.rate = 1.0 if args.engine in ('fish', 'fire', 'index') else .9
    if args.output_root:
        args.output_root = args.output_root.resolve()
    if args.input_json:
        args.input_json = args.input_json.resolve()
    if args.fire_max_chars < 16:
        parser.error('--fire-max-chars must be at least 16')
    if args.batch_size < 1:
        parser.error('--batch-size must be positive')
    if not .5 <= args.rate <= 2:
        parser.error('--rate must be between .5 and 2')
    if args.limit is not None and args.limit < 1:
        parser.error('--limit must be positive')
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('ffmpeg is required on PATH')

    import numpy as np
    import soundfile as sf
    if args.engine == 'fish':
        from fish_client import FishClient
        if not args.dry_run:
            try:
                client = FishClient(args.fish_reference_id, args.fish_model)
            except ValueError as exc:
                raise SystemExit(str(exc)) from None
        device = 'Fish Audio cloud'
        print(f'[cloud] Fish Audio {args.fish_model}; reference={args.fish_reference_id}; rate={args.rate}', flush=True)
    elif not args.dry_run:
        import torch
        if not torch.cuda.is_available():
            raise SystemExit('CUDA GPU unavailable; refusing to silently use CPU')
        torch.set_num_threads(4)
        device = torch.cuda.get_device_name(0)
        print(f'[gpu] {device}; torch={torch.__version__}; CUDA={torch.version.cuda}', flush=True)
    subprocess.run(['node', 'scripts/export-narration.mjs', args.bundle], cwd=ROOT, check=True)
    if args.engine == 'mambo':
        models = Path(args.models_dir).resolve()
        fingerprints = {}
        for filename in ['manbo_e8_s168.pth', 'manbo-e10.ckpt', 'refer.wav']:
            with (models / filename).open('rb') as handle:
                fingerprints[filename] = hashlib.file_digest(handle, 'sha256').hexdigest()
        identity = {'model': 'GPT-SoVITS v2 · MamboTTS v1.2.1', 'speaker': '曼波',
                    'checkpoints': fingerprints, 'referenceText': args.reference_text,
                    'pronunciationVersion': VERSION, 'speed': 1.0,
                    'top_k': 15, 'top_p': 1.0, 'temperature': 1.0, 'cut_punc': '。！？；'}
        provider, voice = 'gpt-sovits-local', '曼波 · GPT-SoVITS'
    elif args.engine == 'fish':
        identity = {'model': args.fish_model, 'referenceId': args.fish_reference_id,
                    'pronunciationVersion': VERSION, 'temperature': .7, 'top_p': .7,
                    'speed': 1.0, 'normalize': True, 'sampleRate': 24000,
                    'latency': 'normal', 'normalizeLoudness': True}
        provider, voice = 'fish-audio', f'曼波 · Fish Audio · {args.fish_reference_id}'
    elif args.engine == 'fire':
        from firered_client import model_identity
        from narration_segments import VERSION as SEGMENTATION_VERSION
        args.fire_model_dir = args.fire_model_dir.resolve()
        reference = ROOT / 'docs/animation/audio/panorama-yunxi/power-off-5a4c129a87737867.mp3'
        identity = {**model_identity(args.fire_model_dir, reference, args.fire_max_chars),
                    'pronunciationVersion': VERSION, 'segmentationVersion': SEGMENTATION_VERSION}
        provider, voice = 'fireredtts3-local', 'FireRedTTS 3 · 云希参考音色'
    elif args.engine == 'index':
        from index_client import model_identity
        from narration_segments import VERSION as SEGMENTATION_VERSION
        args.index_model_dir = args.index_model_dir.resolve()
        reference = ROOT / 'docs/animation/audio/panorama-yunxi/power-off-5a4c129a87737867.mp3'
        identity = {**model_identity(args.index_model_dir, reference, args.fire_max_chars),
                    'pronunciationVersion': VERSION, 'segmentationVersion': SEGMENTATION_VERSION}
        provider, voice = 'indextts25-local', 'IndexTTS 2.5 · 云希参考音色'
    else:
        config = Path(args.model) / 'config.json'
        if not config.is_file():
            raise SystemExit(f'Model not downloaded: {args.model}; see docs/local-narration.md')
        identity = {'model': MODEL_ID, 'modelConfigSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
                    'speaker': args.speaker, 'instruct': INSTRUCTION,
                    'pronunciationVersion': VERSION, 'temperature': 0.7, 'seed': 20261018}
        provider, voice = 'qwen3-tts-local', f'Qwen3-TTS 1.7B · {args.speaker}'
    if args.generation_id:
        identity['generationId'] = args.generation_id
    if args.raw_text:
        identity['textMode'] = 'raw'
        identity['pronunciationVersion'] = 0
    cache = ROOT / ('artifacts/narration-cache' if args.engine == 'qwen' else f'artifacts/narration-cache-{args.engine}')
    if args.generation_id:
        cache = cache / digest(args.generation_id)[:16]
    cache.mkdir(parents=True, exist_ok=True)
    bundles = {}
    if args.input_json:
        bundles['boot'] = json.loads(args.input_json.read_text(encoding='utf-8'))
    elif args.sample:
        bundles['sample'] = [dict(id='pronunciation', text=(
            '右上是 CPU 此刻正在执行的源代码，亮着的一行代码就是当前这一步。'
            'CPU 读取地址 0xFFFFFFF0，执行一条指令。'
            '接着调用 start_kernel，初始化 Linux 内核。'
            'CR3 保存页表地址，CR0.PG 控制分页。'
            'The kernel starts a shell. 输入 read，然后等待键盘中断。'))]
    else:
        for name in ['boot', 'panorama']:
            if args.bundle not in ['all', name]:
                continue
            bundles[name] = json.loads((ROOT / f'tmp/{name}-narration.json').read_text(encoding='utf-8'))
            if args.limit:
                bundles[name] = bundles[name][:args.limit]
    tasks = {}
    for entries in bundles.values():
        for entry in entries:
            entry['parts'] = []
            if args.engine in ('fire', 'index'):
                from narration_segments import bounded_sentences
                segments = bounded_sentences(entry['text'], args.fire_max_chars,
                                             transform=(lambda text: text) if args.raw_text else spoken_text)
            else:
                segments = sentences(entry['text'])
            for start, end, raw in segments:
                spoken = raw if args.raw_text else spoken_text(raw)
                key = digest({**identity, 'text': spoken})
                tasks[key] = spoken
                entry['parts'].append({'start': start, 'end': end, 'key': key, 'spoken': spoken})

    def valid_cache(key):
        wav = cache / f'{key}.wav'
        try:
            info = sf.info(wav)
            return info.duration > 0.25 and info.samplerate == 24000
        except (OSError, RuntimeError):
            return False

    pending = sorted([(k, t) for k, t in tasks.items() if not valid_cache(k)], key=lambda p: len(p[1]))
    if args.engine in ('fire', 'index'):
        atomic_json(cache / 'plan.json', {
            'identity': identity,
            'bundles': {name: [{'id': e['id'], 'text': e['text'], 'parts': e['parts']} for e in entries]
                        for name, entries in bundles.items()},
            'tasks': [{'key': key, 'text': text} for key, text in tasks.items()],
        })
    print(f'[plan] {sum(map(len, bundles.values()))} clips, {len(tasks)} sentences, {len(pending)} uncached', flush=True)
    print(f'[plan] {sum(len(t) for _, t in pending)} uncached characters; render rate {args.rate}', flush=True)
    if args.dry_run:
        return
    if pending and args.engine in ('mambo', 'fish', 'fire', 'index'):
        if args.engine == 'mambo':
            from mambo_client import MamboClient
            client = MamboClient(args.api_url, models, args.reference_text)
        elif args.engine == 'fire':
            from firered_client import FireRedClient
            client = FireRedClient(args.fire_model_dir, reference, cache, ffmpeg, args.fire_max_chars,
                                   cuda_graph=args.fire_cuda_graph)
        elif args.engine == 'index':
            from index_client import IndexClient
            client = IndexClient(args.index_model_dir, reference, cache, ffmpeg, args.fire_max_chars)
        for index, (key, text) in enumerate(pending):
            started = time.monotonic()
            print(f'[{args.engine}] {index + 1}/{len(pending)}; {text}', flush=True)
            wav, sr = client.synthesize(text)
            if sr != 24000 or wav.ndim != 1 or not np.isfinite(wav).all() or len(wav) < sr * .25 or np.max(np.abs(wav)) < .002:
                raise RuntimeError(f'Invalid {args.engine} audio: {text}')
            if len(wav) / sr > max(30, len(text)):
                raise RuntimeError(f'{args.engine} generation may be repeating: {text}')
            active = np.flatnonzero(np.abs(wav) > max(.002, float(np.max(np.abs(wav))) * .008))
            wav = wav[max(0, active[0] - int(sr * .10)):min(len(wav), active[-1] + int(sr * .16))]
            temporary = cache / f'{key}.part.wav'
            sf.write(temporary, wav, sr, subtype='PCM_16')
            temporary.replace(cache / f'{key}.wav')
            print(f'[ready] {time.monotonic() - started:.1f}s, {len(wav)/sr:.1f}s audio', flush=True)
        if args.engine in ('fire', 'index'):
            print(f'[gpu] peak VRAM {torch.cuda.max_memory_allocated()/2**30:.2f} GiB', flush=True)
            del client
            torch.cuda.empty_cache()
    if pending and args.engine == 'qwen':
        from qwen_tts import Qwen3TTSModel
        # SDPA is available on Windows and Blackwell without compiling flash-attn.
        model = Qwen3TTSModel.from_pretrained(args.model, device_map='cuda:0',
                                             dtype=torch.bfloat16, attn_implementation='sdpa')
        # The waveform decoder has a larger temporary memory footprint than
        # the token generator. Bound its batch separately on 16 GB GPUs.
        speech_tokenizer = model.model.speech_tokenizer
        decode = speech_tokenizer.decode

        def decode_bounded(codes, **kwargs):
            if not isinstance(codes, list) or len(codes) <= 4:
                return decode(codes, **kwargs)
            decoded = []
            for start in range(0, len(codes), 4):
                wavs, sample_rate = decode(codes[start:start + 4], **kwargs)
                decoded.extend(wavs)
            return decoded, sample_rate

        speech_tokenizer.decode = decode_bounded
        for offset in range(0, len(pending), args.batch_size):
            batch = pending[offset:offset + args.batch_size]
            torch.manual_seed(identity['seed'])
            started = time.monotonic()
            print(f'[generate] {offset + 1}-{min(offset + len(batch), len(pending))}/{len(pending)}; {batch[0][1]}', flush=True)
            with torch.inference_mode():
                wavs, sr = model.generate_custom_voice(
                    text=[t for _, t in batch], language='Chinese', speaker=args.speaker,
                    instruct=INSTRUCTION, non_streaming_mode=True,
                    temperature=0.7, top_p=0.9, repetition_penalty=1.05,
                    max_new_tokens=2048)
            for (key, text), wav in zip(batch, wavs, strict=True):
                wav = np.asarray(wav, dtype=np.float32)
                if not np.isfinite(wav).all() or len(wav) < sr * 0.25 or np.max(np.abs(wav)) < 0.002:
                    raise RuntimeError(f'Invalid audio for {text}')
                if len(wav) / sr >= 165:
                    raise RuntimeError(f'Generation may have hit token limit: {text}')
                # Only trim outer silence, never the internal pauses or consonants.
                active = np.flatnonzero(np.abs(wav) > max(0.002, float(np.max(np.abs(wav))) * 0.008))
                wav = wav[max(0, active[0] - int(sr * .10)):min(len(wav), active[-1] + int(sr * .16))]
                temporary = cache / f'{key}.part.wav'
                sf.write(temporary, wav, sr, subtype='PCM_16')
                temporary.replace(cache / f'{key}.wav')
            print(f'[batch] {time.monotonic() - started:.1f}s; peak VRAM {torch.cuda.max_memory_allocated()/2**30:.2f} GiB', flush=True)
        del model
        torch.cuda.empty_cache()

    for name, entries in bundles.items():
        preview = args.sample or args.limit or args.input_json
        output = args.output_root / name if args.output_root else ROOT / ('artifacts/narration-preview' if preview else
                         'docs/animation/boot/audio' if name == 'boot' else f'docs/animation/audio/panorama-{args.engine}')
        output.mkdir(parents=True, exist_ok=True)
        results = []
        for entry in entries:
            arrays, spans = [], []
            frames = 0
            for part in entry['parts']:
                wav, sr = sf.read(cache / f"{part['key']}.wav", dtype='float32')
                spans.append({**part, 'time': frames / sr / args.rate, 'duration': len(wav) / sr / args.rate})
                arrays.extend([wav, np.zeros(int(sr * .12), dtype='float32')])
                frames += len(wav) + int(sr * .12)
            audio = np.concatenate(arrays)
            audio_hash = digest({**identity, 'text': entry['text'], 'parts': [p['key'] for p in spans], 'renderRate': args.rate})
            file = f"{args.engine}-{entry['id']}-{audio_hash[:16]}.mp3"
            destination = output / file
            assembled = cache / f'assembled-{audio_hash}.wav'
            sf.write(assembled, audio, sr)
            temporary = destination.with_suffix('.part.mp3')
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(assembled),
                            '-af', f'atempo={args.rate},loudnorm=I=-18:TP=-1.5:LRA=7', '-ar', str(sr),
                            '-c:a', 'libmp3lame', '-b:a', '96k', str(temporary)], check=True)
            temporary.replace(destination)
            assembled.unlink(missing_ok=True)
            duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                             'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(destination)], text=True))
            cue_starts = []
            for cue in entry.get('cues', []):
                span = next((s for s in spans if s['start'] <= cue['start'] < s['end']), spans[-1])
                # Sentence boundaries are measured; comma-clause positions are estimated.
                ratio = max(0, cue['start'] - span['start']) / max(1, span['end'] - span['start'])
                cue_starts.append(round(span['time'] + ratio * span['duration'], 3))
            results.append({'id': entry['id'], 'sourceText': entry['text'], 'file': file,
                            'duration': round(duration, 4), 'sha256': audio_hash,
                            'spokenText': [s['spoken'] for s in spans], 'cueStarts': cue_starts,
                            'timing': 'measured-sentences-estimated-clauses',
                            'sentences': [{k: s[k] for k in ['start', 'end', 'time', 'duration']} for s in spans]})
        manifest = {'provider': provider, 'voice': voice,
                    **identity, 'renderRate': args.rate, 'device': device, 'entries': results}
        if name == 'panorama':
            manifest['audioMap'] = {e['id']: f"audio/panorama-{args.engine}/{e['file']}" for e in results}
        atomic_json(output / ('manifest.json' if not preview or args.output_root else f'{args.engine}-{name}-manifest.json'), manifest)
        if name == 'panorama' and not preview and not args.output_root and args.engine in ('mambo', 'fish', 'fire'):
            config = ROOT / 'docs/animation/narration-config.js'
            available = [key for key in ('mambo', 'fish', 'fire')
                         if (ROOT / f'docs/animation/audio/panorama-{key}/manifest.json').is_file()]
            temporary = config.with_suffix('.js.part')
            temporary.write_text('// Updated only after a complete narration bundle is generated.\n'
                                 + f'export const DEFAULT_NARRATOR = {json.dumps(args.engine)};\n'
                                 + f'export const AVAILABLE_NARRATORS = {json.dumps(available)};\n', encoding='utf-8')
            temporary.replace(config)
        if name == 'boot' and not preview and not args.output_root:
            timing = [{'file': e['file'], 'audio': e['duration']} for e in results]
            target = ROOT / 'docs/animation/boot/story-timing.js'
            temporary = target.with_suffix('.js.part')
            temporary.write_text('// Generated by scripts/generate-local-narration.py\nexport const TIMING = '
                                 + json.dumps(timing, ensure_ascii=False) + ';\n', encoding='utf-8')
            temporary.replace(target)
        print(f'[done] {name}: {len(results)} clips, {sum(e["duration"] for e in results)/60:.1f} minutes → {output}', flush=True)


if __name__ == '__main__':
    main()
