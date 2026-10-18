"""Client for the locally hosted MamboTTS GPT-SoVITS engine."""
from io import BytesIO
from math import gcd

import numpy as np
import requests
import soundfile as sf
from scipy.signal import resample_poly


class MamboClient:
    def __init__(self, url, models, reference_text):
        self.url = url.rstrip('/')
        self.models = models
        self.reference_text = reference_text
        self.session = requests.Session()
        self.session.trust_env = False

    def synthesize(self, text):
        response = self.session.post(self.url + '/', json={
            'text': text, 'text_language': 'zh', 'speed': 1.0,
            'refer_wav_path': str(self.models / 'refer.wav'),
            'prompt_text': self.reference_text, 'prompt_language': 'zh',
            # Complete sentences, preserving comma clauses and English names.
            'cut_punc': '。！？；', 'top_k': 15, 'top_p': 1.0, 'temperature': 1.0,
        }, timeout=(10, 180))
        response.raise_for_status()
        if response.content[:4] != b'RIFF':
            raise RuntimeError(f'Mambo engine did not return WAV: {response.content[:300]!r}')
        wav, sr = sf.read(BytesIO(response.content), dtype='float32')
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        if sr != 24000:
            divisor = gcd(sr, 24000)
            wav = resample_poly(wav, 24000 // divisor, sr // divisor).astype(np.float32)
        peak = float(np.max(np.abs(wav))) if len(wav) else 0
        if peak > .98:
            wav *= .98 / peak
        return wav, 24000
