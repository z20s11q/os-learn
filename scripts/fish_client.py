"""Fish Audio REST client; credentials stay in the generation process."""
from io import BytesIO
import os
import re

import requests

REFERENCE_ID = '0f08cacd3e354471a4b94dd00b4cc4a3'
MODELS = ('s2.1-pro-free', 's2.1-pro', 's2-pro')


class FishClient:
    def __init__(self, reference_id=REFERENCE_ID, model='s2.1-pro-free', *, api_key=None, session=None):
        self.api_key = (api_key if api_key is not None else os.environ.get('FISH_API_KEY', '')).strip()
        if not self.api_key:
            raise ValueError('Set FISH_API_KEY in the generation environment before using --engine fish')
        if not re.fullmatch(r'[a-f0-9]{32}', reference_id):
            raise ValueError('Fish reference ID must be 32 lowercase hex characters')
        if model not in MODELS:
            raise ValueError('Unsupported Fish model; refusing an implicit model fallback')
        self.reference_id, self.model = reference_id, model
        self.session = session or requests.Session()

    def synthesize(self, text):
        # Request at native speed. The shared renderer applies --rate exactly once.
        try:
            response = self.session.post('https://api.fish.audio/v1/tts', headers={
                'Authorization': f'Bearer {self.api_key}', 'model': self.model,
                'Content-Type': 'application/json',
            }, json={
                'text': text, 'reference_id': self.reference_id,
                'format': 'wav', 'sample_rate': 24000, 'normalize': True,
                'latency': 'normal', 'temperature': .7, 'top_p': .7,
                'prosody': {'speed': 1.0, 'volume': 0, 'normalize_loudness': True},
            }, timeout=(15, 180), allow_redirects=False)
        except requests.RequestException:
            # Do not print request headers or retry a potentially billed request.
            raise RuntimeError('Fish Audio connection failed; completed sentences remain cached. Retry manually.') from None
        if response.status_code != 200:
            reason = {401: 'invalid API key', 402: 'insufficient API credit',
                      403: 'voice/model access denied', 429: 'rate limit reached',
                      503: 'service busy'}.get(response.status_code, 'request rejected')
            raise RuntimeError(f'Fish Audio HTTP {response.status_code}: {reason}; no model fallback was used')
        if response.content[:4] != b'RIFF' or response.content[8:12] != b'WAVE':
            raise RuntimeError('Fish Audio returned an invalid WAV response')
        import soundfile as sf
        wav, sr = sf.read(BytesIO(response.content), dtype='float32')
        if wav.ndim != 1 or sr != 24000:
            raise RuntimeError('Fish Audio returned an unexpected audio format (expected 24 kHz mono)')
        return wav, sr
