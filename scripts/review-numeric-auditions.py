"""Check matched auditions and provide an ASR review without declaring speech quality."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, default=ROOT / 'artifacts/narration-preview/numeric-comparison-20261019')
parser.add_argument('--raw-text', action='store_true')
parser.add_argument('--pronunciation-version', type=int, default=2)
args = parser.parse_args()
OUTPUT = args.output_dir.resolve()
sys.stdout.reconfigure(encoding='utf-8')
model = WhisperModel(str(ROOT / 'artifacts/models/faster-whisper-small'),
                     device='cpu', compute_type='int8', cpu_threads=4)
sources = json.loads((OUTPUT / 'input.json').read_text(encoding='utf-8'))
report = {'note': 'ASR is an aid, not a listening verdict. Review numbers and omissions manually.', 'cases': []}
manifests = {engine: json.loads((OUTPUT / engine / 'boot/manifest.json').read_text(encoding='utf-8'))
             for engine in ('fire', 'index')}
for source in sources:
    case = {**source, 'audio': {}}
    spoken = None
    for engine, manifest in manifests.items():
        entry = next(e for e in manifest['entries'] if e['id'] == source['id'])
        assert entry['sourceText'] == source['text']
        assert manifest['renderRate'] == 1.0
        if args.raw_text:
            assert manifest['pronunciationVersion'] == 0 and manifest['textMode'] == 'raw'
            assert ''.join(entry['spokenText']) == source['text']
        else:
            assert manifest['pronunciationVersion'] == args.pronunciation_version
        if spoken is None:
            spoken = entry['spokenText']
        assert entry['spokenText'] == spoken
        path = OUTPUT / engine / 'boot' / entry['file']
        audio, sr = sf.read(path, dtype='float32')
        assert sr == 24000 and audio.ndim == 1
        assert np.isfinite(audio).all() and np.max(np.abs(audio)) > .002
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'null', '-'], check=True)
        segments, _ = model.transcribe(str(path), beam_size=5, language='zh',
                                        vad_filter=False, condition_on_previous_text=False)
        transcript = [{'start': s.start, 'end': s.end, 'text': s.text} for s in segments]
        case['audio'][engine] = {'path': str(path), 'seconds': entry['duration'], 'transcript': transcript}
        print(engine, source['id'], json.dumps(transcript, ensure_ascii=False), flush=True)
    case['spokenText'] = spoken
    report['cases'].append(case)
(OUTPUT / 'review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print('Checked all eight audition files; identical source text and spoken scripts.', flush=True)
