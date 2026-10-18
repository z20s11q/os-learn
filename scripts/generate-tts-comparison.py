"""Compare the latest official FireRedTTS3 and IndexTTS2.5 locally on CUDA."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--engine', choices=['fire', 'index'], required=True)
parser.add_argument('--output-dir', type=Path, help='Separate preview directory; relative paths use the project root')
args = parser.parse_args()
preview_root = args.output_dir or Path('artifacts/narration-preview/tts-comparison')
if not preview_root.is_absolute():
    preview_root = ROOT / preview_root
engine = ROOT / ('artifacts/fireredtts3' if args.engine == 'fire' else 'artifacts/indextts25')
sys.path[:0] = [str(engine), str(ROOT / 'scripts')]
os.chdir(engine)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
import numpy as np
import soundfile as sf
import torch
import torchaudio
from narration_text import VERSION, spoken_text

if not torch.cuda.is_available():
    raise SystemExit('CUDA unavailable; refusing CPU synthesis')
torch.set_num_threads(4)
torch.manual_seed(20261018)
output = preview_root / args.engine
output.mkdir(parents=True, exist_ok=True)
reference_source = ROOT / 'docs/animation/audio/panorama-yunxi/power-off-5a4c129a87737867.mp3'
reference = output / 'reference-yunxi.wav'
subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-y', '-i', str(reference_source),
                '-t', '6.7', '-ar', '48000', '-ac', '1', str(reference)], check=True)
reference_text = '上电前：硬件处于断电状态。断电时寄存器和 RAM 失去可靠的逻辑值。'
segments = [
    ('ZH', '右上亮着的一行代码，就是当前正在执行的指令。'
           'CPU 读取地址 0xFFFFFFF0，接着调用 start_kernel，初始化 Linux 内核。'
           'CR3 保存页表地址，CR0.PG 控制分页。'),
    ('EN', 'The kernel starts a shell.'),
    ('ZH', '输入 read，然后等待键盘中断。'),
]
print(f'[gpu] {torch.cuda.get_device_name(0)}; torch={torch.__version__}', flush=True)
started = time.monotonic()
metadata = []
waves = []
if args.engine == 'index':
    from indextts.infer_v2_5 import IndexTTS2
    model_name = 'IndexTTS 2.5'
    print('[load] ' + model_name, flush=True)
    model = IndexTTS2(cfg_path='checkpoints/config.yaml', model_dir='checkpoints',
                      use_bf16=True, device='cuda:0', use_cuda_kernel=False,
                      use_deepspeed=False, use_accel=False, use_torch_compile=False,
                      use_qwen_emo=False)
    for i, (language, source) in enumerate(segments):
        text = spoken_text(source)
        destination = output / f'segment-{i}.wav'
        print(f'[generate] {i+1}/3 {language}: {text}', flush=True)
        result = model.infer(spk_audio_prompt=str(reference), text=text, lang=language,
                             output_path=None, duration_factor=1.0,
                             text_normalization=False, verbose=False,
                             max_text_tokens_per_segment=220)
        if not isinstance(result, tuple) or len(result) != 2:
            raise RuntimeError('IndexTTS did not return an audio waveform')
        # The official in-memory API returns PCM16-scale samples, not normalized audio.
        sr, pcm = result
        wav = np.clip(np.asarray(pcm, dtype='float32') / 32767.0, -1.0, 1.0)
        if wav.ndim == 2 and wav.shape[1] == 1:
            wav = wav[:, 0]
        sf.write(destination, wav, sr, subtype='PCM_16')
        waves.append(wav)
        metadata.append(dict(language=language, sourceText=source, spokenText=text, duration=len(wav)/sr))
else:
    import transformers
    # The official implementation requests FlashAttention. SDPA is the compatible
    # PyTorch CUDA backend on this Windows installation; model weights are intact.
    original_config_init = transformers.Qwen3Config.__init__
    def sdpa_config(self, *positional, **kwargs):
        kwargs['attn_implementation'] = 'sdpa'
        original_config_init(self, *positional, **kwargs)
    transformers.Qwen3Config.__init__ = sdpa_config
    from fireredtts3.llm import fireredtts3_base as backend
    backend.Qwen3_1_7B_ConfigDict['attn_implementation'] = 'sdpa'
    from fireredtts3.redae.redae import RedAE
    load_pretrained = transformers.PreTrainedModel.from_pretrained.__func__
    def load_bf16(cls, *positional, **kwargs):
        kwargs.update(dtype=torch.bfloat16, attn_implementation='sdpa')
        return load_pretrained(cls, *positional, **kwargs)
    for cls in (RedAE, backend.FireRedTTS3BaseCore):
        cls.from_pretrained = classmethod(load_bf16)
    from fireredtts3.core import FireRedTTS3
    model_name = 'FireRedTTS 3 Base'
    print('[load] ' + model_name, flush=True)
    model = FireRedTTS3('pretrained_models', use_fasttext=False, use_wetext=False, use_llm_tn=False)
    prompt, prompt_sr = sf.read(reference, dtype='float32')
    prompt = torch.from_numpy(prompt).unsqueeze(0)
    for i, (language, source) in enumerate(segments):
        text = spoken_text(source)
        print(f'[generate] {i+1}/3 {language}: {text}', flush=True)
        with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
            wav, sr = model.generate(text=text, language='Chinese' if language=='ZH' else 'English',
                                     prompt_text=reference_text, prompt_audio=prompt, prompt_audio_sr=prompt_sr,
                                     seed=20261018, do_tn=False, do_split=False)
        wav = wav.detach().float().cpu().numpy().reshape(-1)
        sf.write(output / f'segment-{i}.wav', wav, sr)
        waves.append(wav)
        metadata.append(dict(language=language, sourceText=source, spokenText=text, duration=len(wav)/sr))

for wav in waves:
    if wav.ndim > 1:
        raise RuntimeError('Unexpected multichannel audio')
    if not np.isfinite(wav).all() or len(wav)<sr*.25 or np.max(np.abs(wav))<.002:
        raise RuntimeError('Empty, silent or nonfinite generated audio')
audio = np.concatenate([part for i, wav in enumerate(waves)
                        for part in ([wav, np.zeros(int(sr*.18), dtype='float32')] if i<len(waves)-1 else [wav])])
wav_path = output / f'{args.engine}-latest-yunxi-example.wav'
mp3_path = wav_path.with_suffix('.mp3')
sf.write(wav_path, audio, sr, subtype='PCM_16')
subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-y', '-i', str(wav_path),
                '-af', 'loudnorm=I=-18:TP=-1.5:LRA=7', '-ar', str(sr),
                '-c:a', 'libmp3lame', '-b:a', '192k', str(mp3_path)], check=True)
manifest = dict(model=model_name, codeRepository='https://github.com/'+('FireRedTeam/FireRedTTS3' if args.engine=='fire' else 'index-tts/index-tts'),
                codeCommit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=engine,text=True).strip(),
                weights=json.loads((engine/('pretrained_models' if args.engine=='fire' else 'checkpoints')/'download-provenance.json').read_text(encoding='utf-8')),
                referenceSource=str(reference_source), referenceText=reference_text,
                referenceSha256=hashlib.sha256(reference.read_bytes()).hexdigest(),
                segments=metadata, pronunciationVersion=VERSION, speed=1.0, sampleRate=sr,
                gpu=torch.cuda.get_device_name(0), peakVramGiB=torch.cuda.max_memory_allocated()/2**30,
                attentionBackend='sdpa' if args.engine=='fire' else 'official-pytorch',
                dtype='bfloat16', duration=len(audio)/sr, elapsedSeconds=time.monotonic()-started, file=mp3_path.name)
(output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'[done] {model_name}: {len(audio)/sr:.2f} seconds -> {mp3_path}',flush=True)
