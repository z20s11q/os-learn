"""Local FireRedTTS 3 Base adapter for bounded, cached narration generation."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys

REFERENCE_TEXT = '上电前：硬件处于断电状态。断电时寄存器和 RAM 失去可靠的逻辑值。'
SEED = 20261018


def model_identity(engine, reference, max_chars):
    engine, reference = Path(engine), Path(reference)
    return {
        'model': 'FireRedTTS 3 Base',
        'codeRepository': 'https://github.com/FireRedTeam/FireRedTTS3',
        'codeCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=engine, text=True).strip(),
        'weights': json.loads((engine / 'pretrained_models/download-provenance.json').read_text(encoding='utf-8')),
        'referenceSource': str(reference),
        'referenceSourceSha256': hashlib.sha256(reference.read_bytes()).hexdigest(),
        'referenceText': REFERENCE_TEXT, 'referenceSeconds': 6.7,
        'attentionBackend': 'sdpa', 'dtype': 'bfloat16',
        'seed': SEED, 'nTimesteps': 10, 'inferenceCfg': 2.0,
        'stopThreshold': .5, 'speed': 1.0, 'sampleRate': 24000,
        'maxSpokenChars': max_chars, 'normalize': False,
    }


class FireRedClient:
    def __init__(self, engine, reference, cache, ffmpeg, max_chars, cuda_graph=False):
        import soundfile as sf
        import torch
        import transformers

        engine = Path(engine)
        sys.path.insert(0, str(engine))
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        os.environ['TOKENIZERS_PARALLELISM'] = 'false'
        self.max_chars = max_chars
        self.torch = torch
        original_config_init = transformers.Qwen3Config.__init__

        def sdpa_config(config, *args, **kwargs):
            kwargs['attn_implementation'] = 'sdpa'
            original_config_init(config, *args, **kwargs)

        transformers.Qwen3Config.__init__ = sdpa_config
        from fireredtts3.llm import fireredtts3_base as backend
        from fireredtts3.redae.redae import RedAE
        backend.Qwen3_1_7B_ConfigDict['attn_implementation'] = 'sdpa'
        load_pretrained = transformers.PreTrainedModel.from_pretrained.__func__

        def load_bf16(cls, *args, **kwargs):
            kwargs.update(dtype=torch.bfloat16, attn_implementation='sdpa')
            return load_pretrained(cls, *args, **kwargs)

        for cls in (RedAE, backend.FireRedTTS3BaseCore):
            cls.from_pretrained = classmethod(load_bf16)
        from fireredtts3.core import FireRedTTS3
        self.model = FireRedTTS3(str(engine / 'pretrained_models'), use_fasttext=False,
                                 use_wetext=False, use_llm_tn=False)
        reference_wav = Path(cache) / 'reference-yunxi.wav'
        subprocess.run([ffmpeg, '-v', 'error', '-y', '-i', str(reference), '-t', '6.7',
                        '-ar', '48000', '-ac', '1', str(reference_wav)], check=True)
        prompt, self.prompt_sr = sf.read(reference_wav, dtype='float32')
        self.prompt = torch.from_numpy(prompt).unsqueeze(0)
        # The reference is fixed for this client; reuse its deterministic features.
        for module, method_name in ((self.model.redae, 'encode'), (self.model.spk_extractor, 'forward')):
            original = getattr(module, method_name)

            def cached_reference(*args, _method=original, _cache={}, **kwargs):
                if 'value' not in _cache:
                    _cache['value'] = _method(*args, **kwargs)
                return _cache['value']

            setattr(module, method_name, cached_reference)
        self.cuda_graph_enabled = cuda_graph
        if cuda_graph:
            self._enable_dit_graph()

    def _enable_dit_graph(self):
        torch = self.torch
        dit = self.model.tts_core.dit
        forward = dit.forward
        graphs = {}

        def graph_forward(x, t):
            key = (tuple(x.shape), x.dtype, tuple(t.shape), t.dtype)
            if key not in graphs:
                static_x, static_t = x.clone(), t.clone()
                stream = torch.cuda.Stream()
                stream.wait_stream(torch.cuda.current_stream())
                with torch.cuda.stream(stream):
                    for _ in range(3):
                        forward(static_x, static_t)
                torch.cuda.current_stream().wait_stream(stream)
                graph = torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph):
                    output = forward(static_x, static_t)
                graphs[key] = graph, static_x, static_t, output
                print(f'[accelerate] captured DiT CUDA graph {key}', flush=True)
            graph, static_x, static_t, output = graphs[key]
            static_x.copy_(x)
            static_t.copy_(t)
            graph.replay()
            return output

        dit.forward = graph_forward

    def synthesize(self, text):
        if len(text) > self.max_chars:
            raise ValueError(f'Input exceeds {self.max_chars} spoken characters')
        language = 'Chinese' if re.search(r'[\u3400-\u9fff]', text) else 'English'
        with self.torch.inference_mode(), self.torch.autocast('cuda', dtype=self.torch.bfloat16):
            wav, sr = self.model.generate(
                text=text, language=language, prompt_text=REFERENCE_TEXT,
                prompt_audio=self.prompt, prompt_audio_sr=self.prompt_sr,
                seed=SEED, n_timesteps=10, inference_cfg=2.0,
                stop_threshold=.5, do_tn=False, do_split=False,
            )
        return wav.detach().float().cpu().numpy().reshape(-1), sr
