<!-- DOC_LOCAL_BEGIN -->
## 文档说明

| 项 | 内容 |
|---|---|
| 代码范围 | Linux Observatory；证据位于 `artifacts/manifest.json`、`artifacts/verify/`，复现入口见第 7 节 |
| 关联需求 | 真实 Linux 调试、同帧观察与历史回放验收 |
| 目的 | 汇总已有验收证据、逐项状态和后续验证工作 |
| 读者 | 项目维护者与验收人员 |
| 呈现 | 已记录的通过项、部分支持、限制与复现方式 |
| 不呈现 | 以文档检查代替实时验收的完成声明 |
| 证据日期 | 2026-10-17；本次文档检查沿用已有结果 |
<!-- DOC_LOCAL_END -->

# Linux Observatory 验收报告

日期：2026-10-17  
产物：`artifacts/manifest.json`、`artifacts/verify/t13.json`、`artifacts/verify/t08-*.png`、`artifacts/verify/t09-recording.png`

## 1. 已记录的真实验收

```bash
cd /data/os-learn
npm test
npm run verify:lab
npm run verify:ui
./start.sh / ./stop.sh   # 幂等启停，已实测重复执行
```

`scripts/verify-lab.mjs` 通过同一套 HTTP API 启动真实 QEMU/GDB，运行状态来自该会话的实际采集。已有结果如下：

| 验证范围 | 已记录结果 | 证据 |
|---|---|---|
| 单元测试 | 272 通过 / 0 失败 | 下表及第 3 节引用的测试文件与专项证据 |
| 真实实验 | 30 通过 / 0 失败 | `artifacts/verify/t13.json` |
| 浏览器 | 10 通过 / 0 失败 | `artifacts/verify/t08-ui.json` |

| 检查 | 结果 | 证据 |
|---|---|---|
| 产物清单与 SHA-256 | 通过 | bzImage/initramfs/rootfs/lab/boot.iso 与 `artifacts/manifest.json` 一致 |
| kernel-fast 复位帧 | 通过 | frame 0，PC=`0xfffffff0`，课程 L00 |
| 单步 | 通过 | frame 1，`stop.reason=step` |
| 真实 shell | 通过 | 串口出现 `linux-lab:/root#` |
| 同帧 OS 快照 | 通过 | 46 个任务、7 个 VMA、3 个 fd |
| ext2 盘面 | 通过 | `/data` 下 hello.txt=85 B、probe.bin=2097152 B |
| 页表翻译 | 通过 | 3 级页表，物理地址可见，`fault=none` |
| 课程目录 | 通过 | 25 课均可用 |
| 录制导出/导入 | 通过 | SHA-256 一致，3 帧 |
| 历史模式只读 | 通过 | 读当前 VM 内存被 `history-read-only` 拒绝 |
| 历史盘面版本 | 通过（单测） | `tests/disk-version-store.test.mjs` 版本化读取 |
| full-boot L01–L04 | 通过 | `["L01","L02","L03","L04"]` |
| full-boot L05–L07 | 通过 | `start_kernel`、`kernel_init`、`ext2_fill_super` |
| full-boot 帧序列 | 通过 | `0:L00 1:L01 2:L02 3:L03 4:L04 5:L05 6:L06 7:L07` |
| 关闭后残留进程 | 通过 | kernel-fast / full-boot 均为 0 |

Playwright 检查视口为 1440×900，截图用于核对展示：

- `artifacts/verify/t08-reset.png`：复位帧，右栏 L00，三栏 + 时间线；脚本检查结果见浏览器证据。
- `artifacts/verify/t08-shell.png`：真实 shell 暂停，串口/VGA、进程、文件面板。
- `artifacts/verify/t08-files.png`：内存侧 fd 与 ext2 盘面分层显示。
- `artifacts/verify/t09-recording.png`：导入录制包后前后帧回放，VM 保持停止位置。

## 2. 任务完成情况

| 任务 | 状态 | 说明 |
|---|---|---|
| T01 环境与真实 Linux | 完成 | 内核 6.12.112、静态 BusyBox、ext2 根盘、initramfs、boot.iso、lab 程序；散列见 manifest |
| T02 协议与持久化 | 完成 | contracts/trace-format；测试包含大地址、epoch、字节长度、录制 schema |
| T03 会话/GDB/QMP | 完成 | 单会话队列、requestId 幂等、停止通知去重、多阶段符号装载 |
| T04 实时终端/CPU/内存 | 完成 | 已并入 T08 布局；串口 xterm、寄存器、原始指令字节、源码 |
| T05 QEMU 观察扩展 | 完成 | `x-oslab-*`；t05a–e 证据在 `artifacts/verify/t05*.json` |
| T06 内存/页表/设备/磁盘 | 完成 | RAM 基线/增量、页表翻译、virtqueue、逻辑磁盘版本；t06.json |
| T07 Linux 对象解析 | 完成（T07g 部分） | DWARF 布局、task/mm/文件/ext2/I/O 关联；t07a–f 证据 |
| T08 完整组件与联动 | 完成 | 三栏、进程/文件/磁盘/页表/设备/总线、VGA+PS2、解释卡、事件开关 |
| T09 历史回放 | 完成 | 时间线、前后帧、播放、返回最新、录制导入导出、历史只读 |
| T10 启动/终端/用户课程 | 完成 | L00–L07 全部命中；U01–U03 内容；`full-boot` 校准按钮 |
| T11 进程/内存课程 | 内容与程序完成，E2E 部分 | P01/M01/M02/F02/F03 等在真实停点命中；复杂实验仍建议逐个跑 |
| T12 文件/磁盘课程 | 内容与程序完成，E2E 部分 | F02 lab-read、F03 lab-write 已实测；F01/F04 主要依赖 T07d/e 证据 |
| T13 集成与验收 | 已列入 t13 的检查完成 | 结果见第 1 节；完整 E01–E23 状态见第 3 节 |

## 3. E01–E23 对照

| 编号 | 状态 | 依据或缺口 |
|---|---|---|
| E01 复位首指令 | 通过 | t13 B2；t08-reset.png |
| E02 MBR/GRUB/setup 模式切换 | 通过 | full-boot L01/L02 帧；GDT 内容未单独截图 |
| E03 分页/解压/start_kernel | 通过 | L03/L04/L05；t13 B9 三级页表翻译 |
| E04 store/load/in/out 单步 | 部分 | 指令字节/寄存器通过；逐条访存事件需在总线面板开启采集 |
| E05 真实输入 + lab-read/cat | 通过 | F02 在 comm=lab-read 上命中，fd 含 `/data/probe.bin` |
| E06 冷读/热读 | 部分 | T07f 证据覆盖真实块 I/O；UI 冷/热对照尚未写成自动脚本 |
| E07 写入/fsync/重启读回 | 部分 | F03 在 comm=lab-write 上命中；重启读回由 T07e 离线镜像证据覆盖 |
| E08 时钟/磁盘中断 | 部分 | T05b/T05d 事件与设备快照；自动中断课程未跑 |
| E09 停止时未完成块请求 | 通过 | T06/T05e；`diskFault` + pending 载荷 |
| E10 设备面板无副作用 | 通过 | T05d 只读快照与 knownGaps |
| E11 真实异常 | 部分 | `lab-fault` 与 M05 课程存在；自动断言未加入 t13 |
| E12 连点/重连/旧 epoch | 通过 | T02/T03 单测与 API 幂等；历史只读 |
| E13 保存/离线回看 | 通过 | t13 B11/B12；t09-recording.png |
| E14 全量 RAM 覆盖 | 通过（T06 证据） | `tests/ram*.test.mjs`、t06.json；t13 未重复跑 512 MiB 全量 |
| E15 换内容/重链接 | 通过（基础） | manifest SHA-256；录制包绑定对应构建 |
| E16 终端等待/真实键盘 | 通过 | t08-shell；实测 QMP 注入 `ret/l/s/ret` 后 VGA 出现命令 |
| E17 fork/exec/wait | 部分 | P01 在真实 `copy_process` 命中；完整父子回收断言未写成自动化 |
| E18 管道/信号 | 部分 | 课程与 `lab-signal` 已提供；自动断言未跑 |
| E19 匿名缺页/COW | 部分 | M01 命中；`lab-cow` 的 do_wp_page 停点噪声较大，需过滤 comm 后继续 |
| E20 malloc/free/mmap | 部分 | `lab-alloc`、`lab-mmap-file` 已安装；自动断言未跑 |
| E21 文件生命周期 | 部分 | T07d 的 dup/unlink 结构证据；自动断言未跑 |
| E22 后退/前进回放 | 通过 | t09-recording.png；服务端 recorded/live 切换 |
| E23 运行区间覆盖 | 部分 | 每帧 `coverage`/`recording` 明确标注；长时间运行未做压力测试 |

## 4. 已知限制与下一步

1. 反汇编文本：当前只显示真实字节 + 符号；`instruction.text=null`。后续接入 TCG 或
   独立反汇编器，以实际字节生成文本。
2. 事件采集默认关闭，且停止状态下才能切换；总线面板已有开关，开启后事件量可能
   很大，需要按 kind 过滤。
3. 历史帧任意地址内存读取依赖全量 RAM 基线/增量；当前默认只采选页。
4. 历史帧盘面按当前服务进程内记录的逻辑版本快照重建；版本快照驻留在服务进程内，
   服务重启后，前次会话的版本读取会明确报 `unknown-disk-version`。
5. 用户 ELF 的多进程同 VA 行级映射仍只做到 `os.selected` + GDB 源码位置；完整
   exec 世代缓存属于 T07g 的后续增强。
6. `lab-cow` 等实验在 shell 自身缺页频繁时，首个断点可能命中 shell；课程匹配仍然
   正确，但要观察 `lab-cow` 本身需要继续并在进程面板确认 comm。

## 5. 启动主线动画

- 视频：`docs/video/linux-boot-story.mp4` / `.webm`（2560×1440，约 8:10，中文配音 + 字幕）
- 在线播放器：`/media/player.html`（MP4 + WebM 回退）
- 全景教学：`/animation/slides.html`（逐步配音、播放与章节导航）
- 章节 PPT：`/animation/deck.html`
- 自动播放时间轴：`/animation/`
- 逐章文字：`docs/video/linux-boot-story.md`
- 字幕：`docs/video/linux-boot-story.srt`
- 可重放的 HTML 时间轴：`docs/animation/index.html`
- 生成脚本：`docs/animation/build_boot_video.py`

视频章节及时间码见逐章文字；后续单组件讲解可在同一条时间线上选择观察时机。

## 6. 幂等启停与性能优化

```bash
./start.sh          # 已运行直接返回；PID 在 var/lab-server-<port>.pid
./start.sh          # 重复执行复用已有实例，返回 0
./stop.sh           # 服务已停止时返回 0
./stop.sh           # 重复执行仍为 0
LAB_PORT=13030 ./start.sh   # 不同端口各自独立，停止操作只匹配目标端口
```

已实测：默认端口重复启动/停止、活动 QEMU 会话下停止（服务收到 SIGTERM 后关闭
QEMU/GDB，子进程残留为 0）、自定义端口隔离。

已有性能测量与维护机制：

- 布局/符号跨会话缓存：第二次加载约 209 ms → 1 ms。
- 课程可用性缓存：首次约 379 ms → 后续 0 ms。
- 选中进程定向解析：只解析目标 task 的 mm/fd/页缓存，约 14 ms。
- 前端字段级订阅、vendor 拆包、帧异步落盘、`captureMs`。
- 分屏仪表盘及内存/终端操作见 README「页面怎么用」；历史盘面机制见第 4 节。

## 7. 复现实验

```bash
cd /data/os-learn
npm run build
node scripts/verify-lab.mjs
python3 -m json.tool artifacts/verify/t13.json | head -60
```

单独打开 UI：

```bash
npm start
# http://127.0.0.1:13029/lab/
```

重建产物：

```bash
bash scripts/build-kernel.sh
bash scripts/build-rootfs.sh
node packages/linux-decoder/tools/gen-layout.mjs   # 如需重新生成 DWARF 布局
```
