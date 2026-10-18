<!-- DOC_LOCAL_BEGIN -->
## 文档说明

| 项 | 内容 |
|---|---|
| 代码范围 | Linux Observatory 实时实验平台与启动全景教学页 |
| 关联需求 | 从上电到终端等待输入的连续教学展示 |
| 目的 | 说明入口、操作、证据来源、构建和验证方法 |
| 读者 | 本项目的学习者与维护者 |
| 呈现 | 当前构建的真实采样、源码推导及其明确边界 |
| 不呈现 | 未经采样的即时数值、真实硬件电气上电过程 |
<!-- DOC_LOCAL_END -->

# Linux Observatory · 真实内核调试学习平台

在 QEMU 里运行真实的 **Linux 6.12.112 + BusyBox**，通过 GDB/MI、QMP 和自建
`x-oslab-*` 观察扩展，把同一个停止点的 CPU、内存、页表、进程、文件、磁盘、设备
和中断状态同步到浏览器。实时调试界面 `/lab/` 展示真实会话；独立教学页使用历史采样与明确标注的源码推导。

## 快速开始

```bash
cd /data/os-learn

# 首次安装依赖
npm install

# 幂等启动：已运行直接提示；前端缺失或源码更新时自动构建
./start.sh
# 强制重新构建：./start.sh --build
# 自定义端口：LAB_PORT=13030 ./start.sh

# 浏览器打开
#    http://127.0.0.1:13029/lab/

# 幂等停止：服务已停止时返回成功；先 SIGTERM 让服务关闭 QEMU/GDB
./stop.sh
```

`start.sh` / `stop.sh` 的 PID 在 `var/lab-server-<port>.pid`，日志在
`var/log/lab-server-<port>.log`；重复启动复用已有实例，停止操作按端口和工作目录识别目标服务。

如果需要先重建内核/镜像，使用已经锁定的脚本：

```bash
bash scripts/build-kernel.sh     # 生成 artifacts/bzImage、vmlinux、System.map
bash scripts/build-rootfs.sh     # 生成 rootfs.img、initramfs、lab.elf
```

`scripts/build-rootfs.sh` 会把 `lab-*` 实验程序安装到根盘 `/bin`，并把
`hello.txt`、`probe.bin` 写入 `/data`。

## 启动全景教学：从上电到终端

推荐先打开连续教学页。CPU、状态位、机器组件、全局内存、低位内存、指令字节、终端和代码讲解持续挂载，支持自动讲解与逐步观察：

- 在线视频（服务启动后）：<http://127.0.0.1:13029/media/player.html>
- **全景教学（推荐，逐步中文配音）**：<http://127.0.0.1:13029/animation/slides.html>
- 章节 PPT：<http://127.0.0.1:13029/animation/deck.html>
- MP4：[docs/video/linux-boot-story.mp4](docs/video/linux-boot-story.mp4)；WebM：[docs/video/linux-boot-story.webm](docs/video/linux-boot-story.webm)（2560×1440，约 8:10，中文配音）
- 浏览器时间轴：<http://127.0.0.1:13029/animation/>
- 字幕/逐章文字：[docs/video/linux-boot-story.md](docs/video/linux-boot-story.md)
- SRT：[docs/video/linux-boot-story.srt](docs/video/linux-boot-story.srt)

页面入口为「启动全景教学」。每个步骤拆成若干句解说（共 321 句），右侧以歌词式字幕逐句推进：←/→ 逐句前进后退，PageUp/PageDown 换步，点击任意一句可直接跳到该句；空格播放/暂停、Home/End、F 全屏、O 搜索目录；底部可拖动进度和调整速度。`#步骤ID@句号` 可直接定位到某一句（`@end` 为最后一句）。原有 `#s08` 等章节链接会映射到对应启动阶段。完整讲义文字、复位初值表和证据在右侧「完整讲义」弹窗中。

当前采样覆盖如下；全部实测数据来自同一次复位到终端提示符的启动。

| 项目 | 当前覆盖 |
|---|---|
| 教学路径 | 14 个阶段、56 个微步骤，其中 48 步绑定真实停点 |
| 原始证据 | 68 帧、901 条物理内存回读，合计 1,360,000 字节 |
| CPU 字段 | 80 项；每帧 75 项实测有值，包含调试寄存器、x87 80 位、XMM 128 位和相关控制状态 |
| 未取得的字段 | 完整 16 位 FTW、STAR、LSTAR、SFMASK、TSC；逐字段标注采集缺口与原因 |
| 标志位定义 | 58 项；主界面紧凑展示常用状态位和模式位，其余可点开查看 |
| 未单独校准的步骤 | 断电、SeaBIOS 内部 3 步、GRUB 内部 3 步及未来输入预览 |

CPU、标志位、机器部件、内存区域、代码行和终端随每一句同步变化：一步内的寄存器净变化在讲到它的那一句才翻转为新值（下方保留“原 …”），标志位随所属寄存器同时翻转；讲到的对象发光，右侧「这一句」卡片列出本句的变化。虚线闪烁标示稍后会变化的字段，实线高亮表示已发生的净变化。浮点、调试、MSR 等寄存器组默认折叠，讲到或发生变化时自动展开。支持减少动态效果的系统设置。入口与执行后采样分开标注；未采样步骤保留最近样本并明确显示来源。逐句拆分、关键词联动与变化编排在 `docs/animation/panorama-cues.js`。

内存矩阵为 8×16，每格聚合 4 MiB；颜色说明用途，亮框指出该格内已采样窗口有字节变化，窗口外内容标注采集缺口。字节窗高亮相同地址窗口在两个停点间的净变化，并保留读取失败原因。代码区为教学简码，引用可打开原文。本构建的 BusyBox shell 先 poll 等待输入，再 read 读取字符。

全景教学提供晓晓、晓伊、云希三套神经网络配音，每套覆盖全部微步骤，均按当前步骤独立生成；默认晓晓，正常语速全程约 26 分钟。可暂停、重播、切换声线，并支持浏览器朗读与自定义音频清单。哈吉米等特色模型生成的音频可按步骤 ID 导入。

采样脚本为 `scripts/capture-panorama.mjs`；运行后用 `node scripts/build-panorama-samples.mjs` 从 `data/expanded-captures.json` 生成浏览器索引 `panorama-samples.js`。教学文字与状态投影在 `docs/animation/panorama-data.js`，音频清单在 `docs/animation/audio/panorama/manifest.json`。修改旁白后可将 `steps` 的 `id`、`narration` 导出为 JSON，再运行 `python3 docs/animation/generate_panorama_audio.py --input <JSON文件>`；脚本按文字和声线参数缓存，并把 edge-tts 的词级时间写入清单 `entries[].words`，字幕据此逐字对齐。静态文件在服务启动时登记，新增或重新生成音频后需执行 `./stop.sh && ./start.sh`。采样证据验收为 `node scripts/verify-panorama-sampling.mjs`，浏览器验收为 `node scripts/verify-panorama.mjs`；结果分别保存到 `artifacts/verify/panorama-sampling.json` 与 `artifacts/verify/panorama.json`。

视频与章节页的目录如下：

| 时间 | 章节 |
|---|---|
| 00:00 | 总览：复位到 shell |
| 00:10 | 环境与组件：QEMU 8.2.10 / Linux 6.12.112 / SeaBIOS 1.16.3 |
| 00:50 | 上电前：所有组件与 CPU 真实初始状态 |
| 01:26 | CPU 复位：第一条指令 |
| 01:53 | SeaBIOS：POST 与 MBR |
| 02:18 | GRUB：stage1/2、linux16 |
| 02:42 | 16 位 setup：boot_params / GDT / PE |
| 03:03 | 解压器：PAE / LME / PG / 长模式 |
| 03:35 | 内存全景：物理 + 虚拟 + 真实 hexdump |
| 04:09 | start_kernel：初始化调用树 |
| 04:43 | PID 1 与 initramfs /init |
| 05:08 | virtio-blk：描述符 / DMA / IRQ |
| 05:34 | ext2：superblock / inode / dentry |
| 06:02 | switch_root：切换到真实根 |
| 06:23 | BusyBox init：tty1 / ttyS0 / shell |
| 06:44 | 键盘到 TTY 的输入输出链 |
| 07:10 | 到达 shell：全部寄存器真实值 |
| 07:44 | 回顾：完整时间线 |

后续要单独讲某个组件时，在这条时间线上选一个执行时机做切面即可。

重新生成：

```bash
python3 docs/animation/build_boot_video.py
```

脚本会重新生成中文配音、`scenes.js`、字幕、录制 WebM 并用 ffmpeg 合成 MP4。

## 页面怎么用

- **启动模式**
  - `kernel-fast`：QEMU `-kernel/-initrd` 直启，最快进入 shell，适合系统调用、
    进程、文件、内存课程。
  - `full-boot`：从 `boot.iso` 经 SeaBIOS → GRUB → `linux16` → setup →
    解压器 → 主内核启动，适合 L00–L07 启动课程。
- **启动课程**：`full-boot` 下点击「校准启动 L02–L04」。服务会装载 setup/解压器
  符号，并在 `0x7c00`、setup `main`、解压器 `startup_32`、`startup_64` 上真实
  停点，生成 L01–L04 帧。之后用课程下拉框选择 L05/L06/L07，点「运行到该课」。
- **课程下拉框**：25 课来自 `curriculum/linux-x86_64/lessons.json`；按当前帧的
  模块/符号/行号/进程/停止原因匹配，匹配失败时右栏明确显示“本停点没有绑定教学点”。
- **单步 / 源码步过 / 继续 / 暂停**：分别对应 GDB 指令步、源码步、继续和中断；
  每次停止生成一个只读 `Frame`。
- **终端**：串口终端和 VGA/PS2 终端分开。VGA 内容来自设备快照的 `vramBacking`；
  点击 VGA 屏幕获取焦点后键入，按键经 QMP `input-send-event` 注入。
- **中间分屏仪表盘**：终端、VGA、机器概览、进程、内存、
  页表、设备、总线、文件/磁盘 9 个面板同时挂载。中列整体滚动，各面板内部独立滚动。
- **内存双视图**：物理内存和虚拟内存（线性地址）并排显示，各有独立地址、长度、
  已采集区间和 Hex/ASCII；实时停止帧会自动跟随 PC/0x0 读取，手动改地址后使用所选地址。
- **终端滚动**：终端面板由 xterm 管理历史内容滚动。
- **进程 / 文件 / 页表 / 设备 / 总线**：全部从同一个 `activeFrame` 派生。
  进程列表可以选中一个任务查看 mm/VMA/fd；点选只更新观察对象，内核 `current` 保持原值。
- **时间线 / 回看**：点击帧或「进入回看」会先暂停 VM，再切到只读历史帧；
  可前后帧、播放、调速度。「返回最新位置」恢复实时模式后才允许继续执行和输入。
- **导出/导入录制**：导出当前会话的 JSON 录制包（带 SHA-256）；首页可直接
  「导入录制」以录制包为数据源做离线回放。

## 实验程序

根盘 `/bin/lab` 提供：

| 程序 | 用途 | 主要课程 |
|---|---|---|
| `lab-read <path>` | `openat → read → write → close` | U03/F02 |
| `lab-write <path>` | 写固定内容 + `fsync` + 回读 | F03 |
| `lab-memory` | 匿名 mmap、首次写入缺页 | M01 |
| `lab-cow` | 父子进程写时复制 | M02 |
| `lab-alloc` | malloc/free/calloc/brk | M03 |
| `lab-mmap-file <path>` | MAP_SHARED 文件映射 | M04 |
| `lab-fault` | 访问 PROT_NONE 页触发 SIGSEGV | M05 |
| `lab-fork-exec` | fork/exec/wait | P01 |
| `lab-schedule` | 多进程 sleep/调度 | P02 |
| `lab-signal` | fork/pause/SIGTERM/wait | P04 |
| `lab-tty` | 规范模式终端输入 | U02 |

## 验证

```bash
npm test                       # 单元测试；历史验收计数见下文链接
npm run verify:lab             # T13 真实端到端（会启动 QEMU），输出 artifacts/verify/t13.json
npm run verify:ui              # Chromium 真实页面验收，输出 artifacts/verify/t08-ui.json
node scripts/verify-t07a.mjs   # DWARF 布局
node scripts/verify-t07b.mjs   # task 解析
# … t07c/t07d/t07e/t07f 各自有独立脚本和 artifacts/verify/t07*.json
```

已记录的真实实验和浏览器验收结果见 [验收报告第 1 节](docs/os-debug-lab-acceptance.md#1-已记录的真实验收)。本次文档检查沿用已有证据。

## 目录

```text
apps/debugger-web/                 React 前端（/lab）
services/lab-server/               会话、GDB/MI、QMP、采集、课程、录制 API
packages/contracts/                协议类型与校验
packages/linux-decoder/            DWARF/任务/mm/文件/ext2/I/O 解析
packages/trace-format/             内存/分页/virtqueue/录制格式
instrumentation/qemu-observer/     QEMU x-oslab-* 观察扩展
labs/linux-x86_64/                 内核配置、lab.c、构建锁
curriculum/linux-x86_64/           25 课教学点
artifacts/                         内核、镜像、布局、验证证据
var/sessions/                      每会话 QEMU 覆盖层、帧、串口与日志（临时运行数据）
docs/                              方案、任务卡、验收报告
```

## 性能与维护优化

- 布局/System.map 跨会话缓存：第二次会话加载从约 209 ms 降到约 1 ms。
- 课程可用性缓存：25 课符号检查首次约 379 ms，后续请求 0 ms。
- 选中进程定向解析：只读目标 task 的 mm/fd/页缓存；
  实测一次选择约 14 ms。
- 帧文件异步落盘，并在帧里记录 `captureMs`（时间线悬停可见）。
- 前端用 `useLabSelector` 做字段级订阅，通知/事件更新只触发相关订阅者。
- Vite vendor 拆包：React 与 xterm 独立缓存。
- 会话清理：`npm run clean:sessions [-- --keep N --force]`。

## 主要限制

- 代码面板显示真实指令字节和源码符号；反汇编文本待接入，`instruction.text=null`。
- 事件采集默认关闭；停止状态下需要显式开启，事件列表按采集开关和覆盖范围解读。
- 历史帧的任意地址内存读取要求该帧有全量 RAM 基线/增量；只有“选页”采集时，
  未记录页明确显示“本次未记录”。
- 历史帧盘面按当前服务进程内记录的逻辑版本快照重建；版本快照驻留在服务进程内，
  服务重启后，前次会话的版本读取会明确报 `unknown-disk-version`。
- 设备面板基于 QEMU 观察扩展；扩展探测失败时显示能力缺口，设备值只通过观察快照读取。
- 用户 ELF 的 DWARF 行级映射仍以 GDB 当前源码位置为准；多个进程同 VA 的完整
  用户模块切换属于 T07g 的后续增强，当前以 `os.selected` + `exec` 世代标注为准。

更完整的逐项状态见 [验收报告](docs/os-debug-lab-acceptance.md)。
