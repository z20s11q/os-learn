"""Transcribe cached FireRed segments for review, reusing prior ASR results."""
import argparse
import difflib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]


def normalize(text):
    return re.sub(r'[^a-z0-9\u3400-\u9fff]', '', text.lower())


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / 'artifacts/narration-cache-fire')
    parser.add_argument('--report', type=Path, default=ROOT / 'artifacts/fire-narration-asr.json')
    args = parser.parse_args()
    cache = args.cache_dir.resolve()
    plan = json.loads((cache / 'plan.json').read_text(encoding='utf-8'))
    report_path = args.report.resolve()
    previous = json.loads(report_path.read_text(encoding='utf-8')) if report_path.exists() else {}
    results = previous.get('segments', {})
    tasks = [task for task in plan['tasks'] if (cache / (task['key'] + '.wav')).is_file()]
    pending = [task for task in tasks if task['key'] not in results]
    if args.limit:
        pending = sorted(pending, key=lambda t: len(t['text']), reverse=True)[:args.limit]
    if pending:
        from faster_whisper import WhisperModel
        model = WhisperModel(str(ROOT / 'artifacts/models/faster-whisper-small'),
                             device='cpu', compute_type='int8', cpu_threads=4)
        for index, task in enumerate(pending):
            language = 'zh' if re.search(r'[\u3400-\u9fff]', task['text']) else 'en'
            segments, _ = model.transcribe(str(cache / (task['key'] + '.wav')),
                                           beam_size=5, language=language, vad_filter=False,
                                           condition_on_previous_text=False)
            transcript = ''.join(s.text for s in segments).strip()
            similarity = difflib.SequenceMatcher(None, normalize(task['text']), normalize(transcript)).ratio()
            results[task['key']] = dict(expected=task['text'], transcript=transcript,
                                         similarity=round(similarity, 3))
            report = dict(totalPlanned=len(plan['tasks']), checked=len(results), segments=results,
                          note='ASR is a review aid; spelling, numbers and technical terms can be misrecognized.')
            temporary = report_path.with_suffix('.json.part')
            temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(report_path)
            print(f'[asr] {index + 1}/{len(pending)}; similarity={similarity:.2f}; {transcript}', flush=True)
    flagged = [value for task in tasks if (value := results.get(task['key'])) and value['similarity'] < .6]
    print(json.dumps(dict(available=len(tasks), checked=len(results), flagged=len(flagged)), ensure_ascii=False))


if __name__ == '__main__':
    main()
