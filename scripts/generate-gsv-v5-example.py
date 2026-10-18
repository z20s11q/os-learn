"""Generate one local GPU example with official GSV V5 Turbo weights."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'artifacts/gsv-v5'
sys.path[:0] = [str(ROOT / 'artifacts/gsv-v5-overrides'), str(ENGINE), str(ENGINE / 'GPT_SoVITS'), str(ROOT / 'scripts')]
os.environ['PYTHONUTF8'] = '1'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.chdir(ENGINE)
from tools.portable_runtime import activate
activate(change_cwd=True)

import numpy as np
import soundfile as sf
import torch
from narration_text import VERSION, spoken_text
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

if not torch.cuda.is_available():
    raise SystemExit('CUDA unavailable; this example requires the local GPU')
torch.set_num_threads(4)
output = ROOT / 'artifacts/narration-preview/gsv-v5'
output.mkdir(parents=True, exist_ok=True)

# Use two complete sentences from the project's existing Yunxi audio as reference.
reference_source = ROOT / 'docs/animation/audio/panorama-yunxi/power-off-5a4c129a87737867.mp3'
reference = output / 'reference-yunxi.wav'
subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-y', '-i', str(reference_source),
                '-t', '6.7', '-ar', '48000', '-ac', '1', str(reference)], check=True)
reference_text = '上电前：硬件处于断电状态。断电时寄存器和 RAM 失去可靠的逻辑值。'
source = ('右上亮着的一行代码，就是当前正在执行的指令。'
          'CPU 读取地址 0xFFFFFFF0，接着调用 start_kernel，初始化 Linux 内核。'
          'CR3 保存页表地址，CR0.PG 控制分页。'
          'The kernel starts a shell. 输入 read，然后等待键盘中断。')
spoken = spoken_text(source)
models = ENGINE / 'GPT_SoVITS/pretrained_models'
weights = {name: models / name for name in ['s1v3.ckpt', 'gsv-v5-pretrained/s2Gv5turbo.pth', 'gsv-v5-pretrained/vocoder.pth']}
fingerprints = {}
for name, path in weights.items():
    with path.open('rb') as handle:
        fingerprints[name] = hashlib.sha256(handle.read()).hexdigest()
config = TTS_Config({'custom': {
    'device': 'cuda', 'is_half': True, 'version': 'v5turbo',
    't2s_weights_path': str(weights['s1v3.ckpt']),
    'vits_weights_path': str(weights['gsv-v5-pretrained/s2Gv5turbo.pth']),
    'bert_base_path': str(models / 'chinese-roberta-wwm-ext-large'),
    'cnhuhbert_base_path': str(models / 'chinese-hubert-base'),
}})
print(f'[gpu] {torch.cuda.get_device_name(0)}; torch={torch.__version__}', flush=True)
print('[load] official GSV V5 Turbo, native speed 1.0', flush=True)
started = time.monotonic()
model = TTS(config)
assert model.configs.version == 'v5turbo', model.configs.version
print('[generate] ' + spoken, flush=True)
request = {
    'text': spoken, 'text_lang': 'auto', 'ref_audio_path': str(reference),
    'prompt_text': reference_text, 'prompt_lang': 'zh',
    'top_k': 15, 'top_p': 1.0, 'temperature': 1.0, 'seed': 20261018,
    'speed_factor': 1.0, 'fragment_interval': .25,
    'text_split_method': 'cut1', 'batch_size': 1, 'split_bucket': False,
    'parallel_infer': True, 'sample_steps': 4, 'cfg_rate': 0.0,
    'use_cuda_graph': False, 'use_flash_attention': False,
    'streaming_mode': False, 'return_fragment': False,
    'repetition_penalty': 1.35,
}
with torch.inference_mode():
    pieces = list(model.run(request))
assert pieces and all(sr == 48000 for sr, _ in pieces)
audio = np.concatenate([wav for _, wav in pieces])
assert np.isfinite(audio).all() and len(audio) > 48000 and np.max(np.abs(audio)) > 0
wav_path = output / 'gsv-v5-official-yunxi-example.wav'
sf.write(wav_path, audio, 48000, subtype='PCM_16')
mp3_path = wav_path.with_suffix('.mp3')
subprocess.run([shutil.which('ffmpeg'), '-v', 'error', '-y', '-i', str(wav_path),
                '-af', 'loudnorm=I=-18:TP=-1.5:LRA=7', '-ar', '48000',
                '-c:a', 'libmp3lame', '-b:a', '192k', str(mp3_path)], check=True)
manifest = {
    'provider': 'gpt-sovits-local', 'model': 'official GPT-SoVITS V5 Turbo',
    'codeCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ENGINE, text=True).strip(),
    'modelSource': 'https://huggingface.co/lj1995/GPT-SoVITS/tree/main/gsv-v5-pretrained',
    'voice': 'Yunxi reference; synthesized by official V5 Turbo',
    'referenceSource': str(reference_source), 'referenceText': reference_text,
    'sourceText': source, 'spokenText': spoken, 'pronunciationVersion': VERSION,
    'speed': 1.0, 'sampleRate': 48000, 'sampleSteps': 4, 'textSplitMethod': 'cut1', 'weightsSha256': fingerprints,
    'gpu': torch.cuda.get_device_name(0), 'peakVramGiB': torch.cuda.max_memory_allocated()/2**30,
    'duration': len(audio)/48000, 'elapsedSeconds': time.monotonic()-started,
    'file': mp3_path.name,
}
(output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print('[done] ' + json.dumps(manifest, ensure_ascii=False), flush=True)
