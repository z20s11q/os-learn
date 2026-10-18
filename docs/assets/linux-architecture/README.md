# Linux 内核架构阅读页

页面是自包含静态 HTML，可在浏览器中直接离线打开。源码及逐行讲解均在页面内嵌；外部定义链接仅用于进一步查看上游原文。

## 重建

构建使用 Node.js 18 或更高版本的内置模块和工作区已有的 `src/linux-6.12.112` 源码树。

```bash
node /data/os-learn/docs/assets/linux-architecture/build.mjs
```

输出 `docs/linux-kernel-architecture.html`。构建前校验所有引用、教学项和逐行注释覆盖，输出前校验内嵌脚本语法。

## 动画演示页

`docs/linux-kernel-animation.html` 把三条流程做成逐跳动画，有两种视图，按 `V` 或顶栏按钮切换：

- 机器视图（默认）：模拟 CPU0 的寄存器堆、RFLAGS / CR0 / CR4 / EFER 各位、CR3 / CR2 / IDTR / LSTAR / TSC_DEADLINE，物理内存分区与当前进程的虚拟地址空间及映射线，LAPIC / IO-APIC、i8042、virtio-blk、磁盘、VGA 文本显存；每一跳的数据传输以数据包沿系统总线移动，落地后变化的寄存器、位和内存区高亮。下方卡片给出本步讲解、本跳的硬件层面解释与传输清单、当前栈帧和最近一次页表遍历。
- 物理内存按地址从高到低排成粗粒度布局图（每行 64 MiB、每格 2 MiB，另有 0–2 MiB 的 64 KiB 放大条）。每跳读写的位置用点标出：实心红点为写，空心蓝圈为读；当前跳的点闪烁，本步早先的点淡显。已知真实地址的访问（CR3 指向的页表页、VGA 光标处的显存）落在对应格子，其余落在所属区内固定的示意格子。
- 导航分大步（一个步骤，←/→）和小步（一次调用，Shift+←/→ 或 `,` `.`）。
- 时序图视图（`?view=seq`）：每列一个组件，信号沿调用链逐跳移动，配组件说明与组件地图。

流程数据复用 `data.js`、`story-*.js`、`lessons.js`；机器级状态在 `machine.js`，按「第几步第几跳」累积应用（键的含义见 `anim-machine.js`）。机器视图按 QEMU x86_64、关闭 KASLR / PTI / 5 级页表的单 CPU 视角走读，除段选择子、MSR 号、向量 0xec、错误码位等常量外，地址和寄存器值均为示意。

```bash
node /data/os-learn/docs/assets/linux-architecture/build.mjs        # 先建主页面，动画页从中读取源码行号
node /data/os-learn/docs/assets/linux-architecture/anim.build.mjs   # 输出 docs/linux-kernel-animation.html
```

源码为 `anim.template.html`、`anim.css`、`anim-machine.js`、`anim.js`，构建时校验 `machine.js` 的跳下标、端口和内存区名。画面是时间轴时刻 T 的纯函数，播放、拖动进度条和逐帧录制走同一套渲染；每跳时长按总线传输数和硬件讲解长度分配。页面支持 `#cmd/5` 这样的步骤深链，`?record=1&story=cmd` 为录制模式。

导出视频（每条流程一个 1920×1080、30fps 的 WebM，输出到 `docs/video/`）：

```bash
NODE_PATH=<playwright 所在 node_modules> node /data/os-learn/docs/assets/linux-architecture/anim.record.cjs [boot cmd tick] [--fps=30]
```

逐帧调用 `window.__anim.render(T)` 截图，再交给 ffmpeg 编码，播放时序由参数 T 决定。默认使用 Playwright 自带的 ffmpeg 编码 VP8 并输出 WebM；需要 MP4 时用完整版 ffmpeg 转码，或通过 `FFMPEG` 环境变量指定。

## 逐行讲解

`teaching-notes.js` 为全部 49 个步骤的 304 行伪代码提供人工编写的逐行机制解释，顺序及行数必须和 `lessons.js` 完全一致。

`annotations.mjs` 在构建期对 227 个真实定义、14,713 行原文生成分离的逐行讲解，保留源码原文和原行号。`annotation-terms.mjs` 和 `annotation-extra.mjs` 提供人工语义，`assembly-notes.mjs` 提供两个 x86 启动入口逐条指令的具体目的与原因。

`annotation-catalog.json` 保存从当前本地源码提取的函数、宏、类型、局部声明、配置项和生成接口定位。重新构建网页从该文件读取定位数据。源码版本变化时应刷新目录数据，使声明位置与源码匹配。

轻量声明解析按以下规则定位：同名成员通过宿主类型筛选，局部变量限定当前定义，参数定位当前函数签名。存在多个候选的符号明确标注，名称推断标为“命名阅读”。完整 C 语义、配置宏展开和运行时路径证明属于该解析器的范围外能力。

阅读器默认开启逐行讲解，可关闭、切换阅读模式、展开长定义。“复制原文”只复制源码；“复制含注释”生成教学阅读稿，汇编的 `//` 仅作阅读标记。需要编译时使用源码原文。

## 验证

工作区测试脚本 `tmp/test-line-annotations.cjs` 验证全部步骤和调用，比较完整展开后的源码、原行号、注释覆盖、复制、开关、明暗主题及讲解面板窄屏布局。剪贴板测试使用受控替身，浏览器实际权限拒绝时复制失败。

已记录的 390px 视口检查中，讲解面板宽度适配视口，页面全局仍有横向溢出；整页手机适配待完成。
