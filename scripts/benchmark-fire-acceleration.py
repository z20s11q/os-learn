"""Compare identical FireRed output with and without DiT CUDA graph replay."""
from pathlib import Path
import json
import shutil
import time

import numpy as np
import torch

from firered_client import FireRedClient

ROOT = Path(__file__).resolve().parents[1]
torch.set_num_threads(4)
client = FireRedClient(ROOT / 'artifacts/fireredtts3',
                       ROOT / 'docs/animation/audio/panorama-yunxi/power-off-5a4c129a87737867.mp3',
                       ROOT / 'artifacts/narration-cache-fire', shutil.which('ffmpeg'), 80)
text = '内核初始化完成，系统开始等待用户输入。'
results = {}
for mode in ('eager', 'cuda-graph'):
    if mode == 'cuda-graph':
        client._enable_dit_graph()
    client.synthesize(text)
    torch.cuda.synchronize()
    started = time.monotonic()
    audio, sr = client.synthesize(text)
    torch.cuda.synchronize()
    results[mode] = dict(seconds=time.monotonic() - started, frames=len(audio), sampleRate=sr)
    if mode == 'eager':
        baseline = audio
    else:
        assert audio.shape == baseline.shape
        results['maxAbsoluteDifference'] = float(np.max(np.abs(audio - baseline)))
        results['meanAbsoluteDifference'] = float(np.mean(np.abs(audio - baseline)))
        assert np.allclose(audio, baseline, rtol=.002, atol=.002), 'CUDA graph output changed'
results['speedup'] = results['eager']['seconds'] / results['cuda-graph']['seconds']
(ROOT / 'artifacts/fire-acceleration-benchmark.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results, indent=2), flush=True)
