# 曼波配音

## FireRedTTS 3 与 IndexTTS 2.5 试听

本机保留了 FireRedTTS 3 Base 和 B 站 IndexTTS 2.5 的代码、官方权重及独立 Python 环境。两套试听使用相同的普通云希参考音频、中文代码讲解和英文短句，均为 1 倍语速；模型并不自带一个固定的“平台声线”。试听不修改教学页面现有配音。

```powershell
$env:PYTHONUTF8 = '1'
artifacts/fireredtts3/.venv312/Scripts/python.exe -u scripts/generate-tts-comparison.py --engine fire
artifacts/indextts25/.venv312/Scripts/python.exe -u scripts/generate-tts-comparison.py --engine index
```

两条命令依次运行，使用本机 CUDA。输出位于 `artifacts/narration-preview/tts-comparison/fire/` 和 `index/`，分别包含 MP3、WAV、分段音频及来源清单。可用 `--output-dir artifacts/narration-preview/tts-samples-20261019` 单独存放新试听，保留先前结果。清单记录代码提交、权重下载来源、读稿、GPU、时长和语速。

Windows 当前音频库保存 WAV 需要额外的 TorchCodec；Index 试听使用官方内存输出接口，由 SoundFile 写入 PCM16 WAV，不需要该编码依赖，也不改模型代码或权重。FireRed 使用 CUDA SDPA 与 BF16。

### FireRed 全量短段生成

```powershell
artifacts/fireredtts3/.venv312/Scripts/python.exe -u scripts/generate-local-narration.py --engine fire --bundle boot --generation-id boot-numeric-final-v5-20261019 --dry-run
artifacts/fireredtts3/.venv312/Scripts/python.exe -u scripts/generate-local-narration.py --engine fire --bundle boot --fire-cuda-graph --generation-id boot-numeric-final-v5-20261019
```

以上命令生成新版逐条启动演示的 174 个步骤（242 个短段），包含 BIOS 16/32 位切换补充；旧的歌词式全景页面已移除，其 56 步讲稿与历史音频仅作为资料保留。单次输入最多 80 个实际朗读字符（`--fire-max-chars` 可调整），先按句号、问号等切句，超长句优先在逗号、顿号等语义边界细分，再考虑空格或汉字边界，不切断 ASCII 代码标识符；十六进制与缩写展开后的长度也计入上限。每次仅合成一段，模型只加载一次，保持与试听相同的云希参考音色及 1 倍语速。

当前读稿版本为 5：普通数量与小数转为中文（`65535` 为“六万五千五百三十五”）；十六进制省略 `0x` 前缀，数字与 A-F 字母逐位读，保留全部前导零与重复零，不添加“零 x”“十六进制”或重复次数。`0x10000` 的读稿为“一，零，零，零，零”，`B8 00 20` 为“B，八，零，零，二，零”。已知代码标识符里的数字另行展开（如 `R15`、`A20`、`startup_32`），页面原文保持不变。`--raw-text` 仅用于原文对照试听，不用于当前全量配音。

短段缓存写入 `artifacts/narration-cache-fire/`，中断后重复同一命令可续跑。校验短段非静音、采样率和异常时长后才缓存，按步骤拼接、统一响度并写入 MP3。完整包生成后更新启动演示的 `docs/animation/boot/audio/manifest.json` 与 `docs/animation/boot/story-timing.js` 时间轴。原曼波、千问和 Edge 音频文件保留。新增音频文件后重启服务。

`--fire-cuda-graph` 将固定形状的 DiT 解码计算捕获为 CUDA Graph，减少每步 Python 与 GPU 启动开销；参考音频的编码和说话人特征在同一进程内缓存。没有降低 10 步推理或改变权重。`scripts/benchmark-fire-acceleration.py` 在本机对同一句比较普通模式与加速模式，结果写入 `artifacts/fire-acceleration-benchmark.json`，包括耗时和采样差异。2026-10-19 短句实测为 5.59 秒与 1.81 秒，输出逐点相同；具体速度会随文本和其他 GPU 程序变化。去掉此参数可使用普通模式，同一批短段缓存仍可复用。

全量文件校验用 `artifacts/tts-venv/Scripts/python.exe scripts/verify-fire-narration.py --bundle boot`，只核对新版启动演示及当前读稿版本；转写辅助检查用 `scripts/verify-fire-narration-asr.py --cache-dir artifacts/narration-cache-fire/249c7ec3d2b788d1 --report artifacts/boot-numeric-v5-asr.json`，数字串和技术术语须另行听审。Windows 教学页预览可设置 `$env:NARRATION_PORT='18546'` 后运行 `node scripts/serve-narration.mjs`，访问 `http://127.0.0.1:18546/animation/boot.html`。播放验收用 `node scripts/verify-fire-narration-ui.mjs`。

## 官方 GSV V5 本机试听

本机额外准备了官方 `cuda_graph_accel_v5` 分支和 [V5 Turbo 官方权重](https://huggingface.co/lj1995/GPT-SoVITS/tree/main/gsv-v5-pretrained)，与原有曼波微调模型分别存放。运行一份代码术语与中英文混读示例：

```powershell
artifacts/gsv-v5/runtime/python.exe -u scripts/generate-gsv-v5-example.py
```

使用 RTX 5070 Ti、FP16、V5 Turbo 4 步推理，原生 48 kHz、1 倍语速，按句组处理，避免逢逗号就单独合成。GSV 官方底模需要参考音频确定音色；本示例从项目已有的普通云希音频取前 6.7 秒（两个完整句子）作为参考，不代表微软 HD 云希引擎。

结果保存在 `artifacts/narration-preview/gsv-v5/`，包含 WAV、192 kbps MP3 和记录权重 SHA-256、代码提交、实际 GPU、原文与读稿的 `manifest.json`。只生成试听，不更新教学页面的音频清单。

模型存放于 `artifacts/gsv-v5/GPT_SoVITS/pretrained_models/gsv-v5-pretrained/`，复用原整合包的 CUDA 运行环境、BERT、HuBERT 和官方 `s1v3.ckpt`。新版 Transformers、Tokenizers 和 Hugging Face Hub 单独安装到 `artifacts/gsv-v5-overrides/`，不会修改原整合包中的包版本。

## 指定的 Fish Audio 曼波

用户指定的 [Fish Audio 曼波](https://fish.audio/m/0f08cacd3e354471a4b94dd00b4cc4a3/) 声线 ID 为 `0f08cacd3e354471a4b94dd00b4cc4a3`。生成器使用官方 `POST https://api.fish.audio/v1/tts`，将 ID 传给 `reference_id`，密钥通过生成进程的 `FISH_API_KEY` 读取。它是云端合成；这个声线 ID 本身不是能在本机 GPU 加载的模型权重。网页只播放导出的本地 MP3，不接触 Key。

Fish 默认 **1 倍原速**（本机 GPT-SoVITS 仍为 0.9 倍）。默认显式使用官方免费开发模型 `s2.1-pro-free`，不会自动切换到付费模型。该档位受官方公平使用限制；具体见 [模型说明](https://docs.fish.audio/developer-guide/models-pricing/models-overview)。

先试听，命令会隐藏输入 Key，结束后恢复原有进程环境；不保存 Key：

```powershell
./scripts/generate-fish-narration.ps1
# 只检查完整包的待生成文字量，不调用合成 API：
./scripts/generate-fish-narration.ps1 -Publish -DryRun
# 试听确认后再完整生成：
./scripts/generate-fish-narration.ps1 -Publish
```

已经设置环境变量时也可以直接调用：

```powershell
artifacts/tts-venv/Scripts/python.exe scripts/generate-local-narration.py --engine fish --sample
artifacts/tts-venv/Scripts/python.exe scripts/generate-local-narration.py --engine fish --bundle boot --limit 3
artifacts/tts-venv/Scripts/python.exe scripts/generate-local-narration.py --engine fish
```

试听写入 `artifacts/narration-preview/fish-*.mp3`，不会修改现有语音包。原句 WAV 缓存在 `artifacts/narration-cache-fish/`，更改最终语速可直接复用。完整生成后，逐行演示写入 `docs/animation/boot/audio/` 并更新时长；全景写入 `docs/animation/audio/panorama-fish/`，全部完成后才启用 Fish 选项并设为默认。新增静态文件后重启项目服务。接口中断或限额错误会停止，保留已完成缓存，重新执行可继续。

接口与鉴权参照 [官方 TTS 文档](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) 和 [Key 创建页](https://fish.audio/app/api-keys)。API Key 不应放进版本库、前端或音频清单。

## 本机 GPU GPT-SoVITS 曼波

默认声线为 [MamboTTS v1.2.1](https://github.com/Tsukimisaka/MamboTTS/releases/tag/v1.2.1) 的曼波，使用 GPT-SoVITS 本地推理。页面播放预生成 MP3，不需要实时运行模型。

本机文件布局：

- `artifacts/mambo-release/MamboTTS-v1.2.1-full/models/`：`manbo_e8_s168.pth`、`manbo-e10.ckpt` 和配套 `refer.wav`。
- `artifacts/mambo-engine/GPT-SoVITS-v2pro-20250604-nvidia50/`：支持 RTX 50 系的引擎和独立 Python/CUDA 运行环境。
- `artifacts/tts-venv/`：项目音频导出客户端；使用 `scripts/tts-requirements.txt`。

模型来自发布包 `MamboTTS-v1.2.1-full.zip`。引擎来自 [GPT-SoVITS 整合包](https://modelscope.cn/models/FlowerCry/gpt-sovits-7z-pacakges/files)，文件名为 `GPT-SoVITS-v2pro-20250604-nvidia50.7z`，本机已核对 SHA-256：

```
97b4edcd451c42357db7e26e6c1c877ca5d85144fe97beaff6d7005d35bee008
```

参考音频必须使用同一发布包里的版本，对应文字为“大家好，欢迎来到我的频道，今天给大家分享一个有趣的内容”。主仓库另一个参考音频的内容不同，不能配用这一段文字。

先在一个终端启动本机引擎：

```powershell
./scripts/start-mambo-engine.ps1
```

服务监听 `127.0.0.1:18547`，使用 CUDA。再在另一个终端生成试听或完整语音包：

```powershell
artifacts/tts-venv/Scripts/python.exe scripts/generate-local-narration.py --sample
artifacts/tts-venv/Scripts/python.exe scripts/generate-local-narration.py
# 单独生成：--bundle boot 或 --bundle panorama
```

默认 `--engine mambo`。试听清单位于 `artifacts/narration-preview/mambo-sample-manifest.json`。完整输出：

最终语速默认 `--rate 0.9`，通过保持音调的时间拉伸放慢；已合成的原始句子可继续复用。
字幕与时间轴同步换算为最终音频时间。需要正常语速时显式使用 `--rate 1`。

这套曼波模型主要用于中文角色解说；实测纯英文长句仍有漏读，不能当作英文课文配音模型。

- 逐行启动演示：`docs/animation/boot/audio/manifest.json`，并更新 `boot/story-timing.js`。
- 全景教学：`docs/animation/audio/panorama-mambo/manifest.json`。

`scripts/export-narration.mjs` 读取教学数据，不需要 Linux 内核源码或构建产物。`scripts/narration_text.py` 只修改实际朗读稿，保留页面原文：寄存器按字母读、十六进制逐位读、函数名按单词读，并绕开“一行代码”的多音字歧义。合成保留逗号从句，按完整句子处理。

中间 WAV 按读稿、模型权重、参考音频及合成参数缓存，放在 `artifacts/narration-cache-mambo/`。中断后可复用。每套配音全部完成后才更新清单，文件名包含内容哈希，避免浏览器播放旧缓存。成品统一为 24 kHz 单声道 MP3，并统一响度。字幕句子边界使用实测时长，逗号从句内部仍按比例估算。

新增静态文件后需重启项目服务并刷新页面。语音设置保留原来的 Edge 声线；Serena 已从默认声线选项移除。旧千问生成器仍可用显式参数 `--engine qwen` 调用，不会用于默认生成。

读音回归检查：

```powershell
py -3.12 -m unittest discover -s tests -p narration_text_test.py
```
