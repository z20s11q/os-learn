"""Verify complete FireRed bundles, bounded inputs, cues, and every MP3 decode."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import re
import subprocess
import sys

from narration_segments import bounded_sentences
from narration_text import VERSION, spoken_text

ROOT = Path(__file__).resolve().parents[1]


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', choices=['boot', 'panorama', 'all'], default='boot')
    args = parser.parse_args()
    report, files = {}, []
    for bundle, folder in [('boot', 'docs/animation/boot/audio'),
                           ('panorama', 'docs/animation/audio/panorama-fire')]:
        if args.bundle not in ('all', bundle):
            continue
        output = ROOT / folder
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        sources = json.loads((ROOT / f'tmp/{bundle}-narration.json').read_text(encoding='utf-8'))
        entries = manifest['entries']
        assert manifest['provider'] == 'fireredtts3-local'
        assert manifest['renderRate'] == 1.0
        assert manifest['maxSpokenChars'] == 80
        assert manifest['pronunciationVersion'] == VERSION
        assert [e['id'] for e in entries] == [e['id'] for e in sources]
        for entry, source in zip(entries, sources, strict=True):
            assert entry['sourceText'] == source['text'], entry['id']
            parts = list(bounded_sentences(source['text'], manifest['maxSpokenChars']))
            assert ''.join(raw for _, _, raw in parts) == source['text']
            assert entry['spokenText'] == [spoken_text(raw) for _, _, raw in parts]
            assert all(len(text) <= 80 for text in entry['spokenText'])
            assert all('零 x' not in text and '十六进制' not in text for text in entry['spokenText'])
            if bundle == 'boot':
                assert all(not re.search(r'\d', text) for text in entry['spokenText']), entry['id']
            assert [(p['start'], p['end']) for p in entry['sentences']] == [(s, e) for s, e, _ in parts]
            for part in entry['sentences']:
                assert 0 <= part['time'] < entry['duration']
                assert part['duration'] > 0
                assert part['time'] + part['duration'] <= entry['duration'] + .15
            if bundle == 'panorama':
                starts = entry['cueStarts']
                assert len(starts) == len(source['cues'])
                assert starts == sorted(starts)
                assert starts[0] == 0 and starts[-1] < entry['duration']
                assert manifest['audioMap'][entry['id']] == f"audio/panorama-fire/{entry['file']}"
            files.append((output / entry['file'], entry['duration']))
        if bundle == 'boot':
            script = (ROOT / 'docs/animation/boot/story-timing.js').read_text(encoding='utf-8')
            timing = json.loads(script.split('export const TIMING = ', 1)[1].rstrip().rstrip(';'))
            assert timing == [dict(file=e['file'], audio=e['duration']) for e in entries]
        report[bundle] = dict(clips=len(entries), duration=sum(e['duration'] for e in entries),
                              segments=sum(len(e['sentences']) for e in entries), voice=manifest['voice'])

    def check(pair):
        path, duration = pair
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                                 'format=duration:stream=codec_name,sample_rate,channels',
                                 '-of', 'json', str(path)], capture_output=True, text=True, check=True)
        info = json.loads(result.stdout)
        assert info['streams'][0]['codec_name'] == 'mp3'
        assert int(info['streams'][0]['sample_rate']) == 24000
        assert info['streams'][0]['channels'] == 1
        assert abs(float(info['format']['duration']) - duration) < .15
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-f', 'null', '-'],
                       capture_output=True, check=True)
        return dict(file=str(path.relative_to(ROOT)), bytes=path.stat().st_size, duration=duration)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        report['decoded'] = list(pool.map(check, files))
    report['passed'] = True
    (ROOT / 'artifacts/fire-narration-verification.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'decoded'}, ensure_ascii=False, indent=2))
    print(f'All {len(files)} MP3 files decoded successfully')


if __name__ == '__main__':
    main()
