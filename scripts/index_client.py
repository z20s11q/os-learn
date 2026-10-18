"""IndexTTS 2.5 local CUDA adapter with normalized PCM output."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def model_identity(engine, reference, max_chars):
    return dict(model='IndexTTS 2.5', codeRepository='https://github.com/index-tts/index-tts',
                codeCommit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=engine, text=True).strip(),
                weights=json.loads((engine / 'checkpoints/download-provenance.json').read_text(encoding='utf-8')),
                referenceSource=str(reference), referenceSourceSha256=hashlib.sha256(reference.read_bytes()).hexdigest(),
                referenceSeconds=6.7, dtype='bfloat16', seed=20261019,
                speed=1.0, sampleRate=24000, maxSpokenChars=max_chars, normalize=False)


class IndexClient:
    def __init__(self, engine, reference, cache, ffmpeg, max_chars):
        import numpy as np
        import soundfile as sf
        import torch
        engine = Path(engine)
        sys.path.insert(0, str(engine))
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        from indextts.infer_v2_5 import IndexTTS2
        self.model = IndexTTS2(cfg_path=str(engine / 'checkpoints/config.yaml'),
                               model_dir=str(engine / 'checkpoints'), use_bf16=True,
                               device='cuda:0', use_cuda_kernel=False, use_deepspeed=False,
                               use_accel=False, use_torch_compile=False, use_qwen_emo=False)
        self.reference = Path(cache) / 'reference-yunxi.wav'
        subprocess.run([ffmpeg, '-v', 'error', '-y', '-i', str(reference), '-t', '6.7',
                        '-ar', '48000', '-ac', '1', str(self.reference)], check=True)
        self.max_chars, self.np, self.torch = max_chars, np, torch

    def synthesize(self, text):
        if len(text) > self.max_chars:
            raise ValueError('Index input exceeds the short-segment limit')
        self.torch.manual_seed(20261019)
        import random
        random.seed(20261019)
        self.np.random.seed(20261019)
        result = self.model.infer(spk_audio_prompt=str(self.reference), text=text,
                                  lang='ZH' if re.search(r'[\u3400-\u9fff]', text) else 'EN',
                                  output_path=None, duration_factor=1.0, text_normalization=False,
                                  verbose=False, max_text_tokens_per_segment=220)
        if not isinstance(result, tuple):
            raise RuntimeError('Index returned no waveform')
        sr, pcm = result
        audio = self.np.clip(self.np.asarray(pcm, dtype='float32') / 32767.0, -1, 1).reshape(-1)
        if sr != 24000:
            import torchaudio
            audio = torchaudio.functional.resample(self.torch.from_numpy(audio), sr, 24000).numpy()
        return audio, 24000
