#!/usr/bin/env python3
"""
生成《从复位到终端》Linux 启动主线动画。

流程：
1. 为每个分镜生成中文配音（edge-tts）；
2. 按配音时长写 scenes.js；
3. 用 Chromium 打开 index.html，按真实时间录制 WebM；
4. 用 ffmpeg 拼接配音、转 H.264 MP4；
5. 输出 transcript.md 与 subtitles.srt。

依赖：edge-tts、playwright、imageio-ffmpeg、Chromium。
运行：
    python3 docs/animation/build_boot_video.py
    python3 docs/animation/build_boot_video.py --no-tts     # 无配音，按文本估时
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    import edge_tts
    import imageio_ffmpeg
    from playwright.sync_api import sync_playwright
except Exception as exc:  # pragma: no cover
    print("缺少依赖，请先执行：python3 -m pip install edge-tts playwright imageio-ffmpeg", file=sys.stderr)
    raise

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = HERE / "out"
AUDIO = HERE / "audio"
VIDEO_OUT = ROOT / "docs/video/linux-boot-story.mp4"
POSTER_OUT = ROOT / "docs/video/linux-boot-poster.png"
TRANSCRIPT_OUT = ROOT / "docs/video/linux-boot-story.md"
SRT_OUT = ROOT / "docs/video/linux-boot-story.srt"
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

VOICE = "zh-CN-XiaoyiNeural"
RATE = "+8%"
PITCH = "+10Hz"

SNAP_PATH = HERE / "data/snapshots.json"
SNAP = json.loads(SNAP_PATH.read_text(encoding="utf-8")) if SNAP_PATH.exists() else {}
RESET_CPU = (SNAP.get("reset") or {}).get("cpu") or {}
SHELL_CPU = (SNAP.get("shell") or {}).get("cpu") or {}
SHELL_OS = (SNAP.get("shell") or {}).get("os") or {}
MEM_SNAP = SNAP.get("memory") or {}


def zh(en: str, cn: str) -> str:
    return f'{en}<span class="zh">（{cn}）</span>'


def reg_grid(cpu: dict, columns: int = 4) -> str:
    cells = []
    for item in cpu.get("general", []):
        name = item.get("name", "?").upper()
        value = item.get("value", "0x0")
        cells.append(f'<div class="reg-cell"><span>{name}</span><b>{value}</b></div>')
    return f'<div class="reg-grid" style="grid-template-columns:repeat({columns},1fr)">' + "".join(cells) + "</div>"


def control_grid(cpu: dict) -> str:
    control = cpu.get("control") or {}
    rows = [
        ("CR0", control.get("cr0", "0x0")),
        ("CR2", control.get("cr2", "0x0")),
        ("CR3", control.get("cr3", "0x0")),
        ("CR4", control.get("cr4", "0x0")),
        ("CR8", control.get("cr8", "0x0")),
        ("EFER", cpu.get("efer", "0x0")),
        ("RFLAGS", cpu.get("eflags", "0x0")),
    ]
    return '<div class="ctl-grid">' + "".join(
        f'<div class="ctl-cell"><span>{name}</span><b>{value}</b></div>' for name, value in rows
    ) + "</div>"


def seg_table(cpu: dict) -> str:
    segs = cpu.get("segments") or {}
    order = ["cs", "ss", "ds", "es", "fs", "gs", "tr", "ldtr"]
    rows = []
    for name in order:
        seg = segs.get(name)
        if not seg:
            continue
        rows.append(
            f'<div class="seg-row"><b>{name.upper()}</b><span>{seg.get("selector", "0x0")}</span>'
            f'<span>{seg.get("base", "0x0")}</span><span>{seg.get("limit", "0x0")}</span></div>'
        )
    return ('<div class="seg-table"><div class="seg-row head"><b>段</b><span>selector</span>'
            '<span>base</span><span>limit</span></div>' + "".join(rows) + "</div>")


def cpu_panorama(cpu: dict, compact: bool = False) -> str:
    mode = cpu.get("mode", "?")
    cpl = cpu.get("cpl", "?")
    rip = cpu.get("rip", "0x0")
    rsp = cpu.get("rsp", "0x0")
    return f'''
      <div class="cpu-pano {'compact' if compact else ''}">
        <div class="pano-head"><span class="pill hi">{mode} · CPL {cpl}</span><span class="mono">RIP {rip} · RSP {rsp}</span></div>
        <div class="pano-title">通用寄存器（general registers）</div>
        {reg_grid(cpu)}
        <div class="pano-title">控制寄存器（control registers）与标志</div>
        {control_grid(cpu)}
        <div class="pano-title">段寄存器（segment registers）</div>
        {seg_table(cpu)}
      </div>
    '''


def hexdump_table(key: str, label: str, rows: int = 2, bpr: int = 32) -> str:
    entry = MEM_SNAP.get(key) or {}
    raw = entry.get("hex") or ""
    try:
        data = bytes.fromhex(raw)
    except Exception:
        data = b""
    if not data:
        return f'<div class="dump-block"><div class="dump-label">{label}</div><div class="muted">未捕获</div></div>'
    base = int(key, 16)
    out = [f'<div class="dump-block"><div class="dump-label"><b>{label}</b><span>{key} · 真实回读</span></div><div class="hexdump">']
    for row in range(rows):
        chunk = data[row * bpr:(row + 1) * bpr]
        if not chunk:
            break
        hx = " ".join(f"{b:02x}" for b in chunk)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        out.append(f'<div class="h-row"><span class="h-addr">0x{base + row * bpr:08x}</span><span class="h-hex">{hx}</span><span class="h-ascii">{asc}</span></div>')
    out.append("</div></div>")
    return "".join(out)


def version_rows(rows: list[tuple[str, str, bool]]) -> str:
    return "".join(
        f'<div class="env-row"><span>{k}</span><b class="{"hi" if hi else ""}">{v}</b></div>' for k, v, hi in rows
    )


SCENES = [
    dict(
        tag="总览",
        kicker="BOOT / OVERVIEW",
        title="从按下电源，到终端提示符",
        caption="这条线不是模拟：SeaBIOS → GRUB → Linux 6.12.112 → BusyBox，全部来自 QEMU 中的真实启动。",
        narration=(
            "从按下电源开始，到看见 linux-lab 的终端提示符，机器要经过固件、引导器、内核解压、"
            "初始化、根文件系统、设备驱动和用户空间。这个视频只沿一条主线，把每个阶段的执行位置、"
            "关键寄存器和组件交接讲清楚。所有地址和阶段都来自本项目的真实 QEMU 实验。"
        ),
        bullets=[
            "<b>只讲一条线</b>：复位 → 固件 → 引导器 → 内核 → 根盘 → shell。",
            "每个阶段都给出<b>实际停点</b>或<b>真实结构</b>，不画虚构的流水线。",
            "后续单独讲某个组件时，可以在这条时间线上选一个切面。",
        ],
        facts=[("内核", "6.12.112-observatory", True), ("机器", "QEMU pc / qemu64 / TCG", False),
               ("根盘", "virtio-blk ext2", False), ("终点", "linux-lab:/root#", True)],
        visual="""
        <div class="intro">
          <div class="eyebrow anim fade" style="--d:.15s">REAL BOOT · SINGLE TRACE</div>
          <div class="title anim left" style="--d:.35s">从按下电源，<br>到 <span>linux-lab:/root#</span></div>
          <div class="sub anim fade" style="--d:.7s">不是模拟动画：这条路径来自 QEMU 8.2.10 里真实运行的
            SeaBIOS 1.16.3、GRUB 2.03、Linux 6.12.112 和 BusyBox 1.37.0。</div>
          <div class="row anim fade" style="--d:.9s;margin-top:26px;gap:8px">
            <span class="pill">Linux 6.12.112</span><span class="pill">QEMU 8.2.10</span>
            <span class="pill">x86_64 · TCG</span><span class="pill">512 MiB RAM</span>
            <span class="pill ok">真实 QEMU 停点</span>
          </div>
          <div class="intro-line anim fade" style="--d:1.1s">
            <div class="dot"></div><div class="seg"></div>
            <div class="label">RESET → BIOS → GRUB → SETUP → DECOMPRESS → KERNEL → PID 1 → EXT2 → SHELL</div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="环境",
        kicker="S01 / ENVIRONMENT",
        title="先交代环境：谁在模拟这台机器？",
        caption="宿主机 TencentOS 3.2 · QEMU 8.2.10（模拟器）· Linux 6.12.112 · SeaBIOS 1.16.3 · GRUB 2.03 · BusyBox 1.37.0。",
        narration=(
            "先交代环境。宿主机是 TencentOS Server 3.2。模拟器是 QEMU 8.2.10，单核 qemu64，"
            "使用 TCG 软件模拟。客户机内核是 Linux 6.12.112，内存五百一十二兆。"
            "固件是 SeaBIOS 1.16.3，引导器是 GRUB 2.03，用户空间是 BusyBox 1.37.0，根盘是 ext2。"
            "调试器是 GDB 9.2，通过 GDB MI 和 QMP 读取真实状态。画面里的英文组件，我都会用括号给出中文。"
        ),
        bullets=[
            "这不是录屏演示，而是 **QEMU + GDB/MI + QMP** 驱动的真实实验。",
            "客户机只有 **1 个 vCPU**，所有地址和寄存器都来自当前构建。",
            "画面里的英文组件都带中文小括号；看不懂时先看右侧术语。",
        ],
        facts=[("QEMU", "8.2.10", True), ("内核", "6.12.112-observatory", True),
               ("固件", "SeaBIOS 1.16.3", False), ("根盘", "ext2 96 MiB", False)],
        visual=f"""
        <div class="env-grid">
          <div class="env-col">
            <div class="pill hi anim fade" style="--d:.15s">HOST / 宿主机</div>
            {version_rows([
                ("操作系统", "TencentOS Server 3.2", False),
                ("宿主内核", "Linux 4.18 x86_64", False),
                ("模拟器 QEMU", "8.2.10（机器模拟器）", True),
                ("加速方式", "TCG（软件动态翻译）", True),
                ("调试器 GDB", "9.2 + GDB/MI", False),
                ("控制通道", "QMP（QEMU 管理协议）", False),
            ])}
          </div>
          <div class="env-col">
            <div class="pill hi anim fade" style="--d:.3s">GUEST / 客户机</div>
            {version_rows([
                ("内核", "6.12.112-observatory", True),
                ("架构", "x86_64 · 1 vCPU · qemu64", False),
                ("内存", "512 MiB", True),
                ("固件", "SeaBIOS 1.16.3", True),
                ("引导器", "GRUB 2.03（BIOS 模式）", False),
                ("用户空间", "BusyBox 1.37.0", False),
            ])}
          </div>
          <div class="env-col">
            <div class="pill hi anim fade" style="--d:.45s">DEVICES / 设备</div>
            {version_rows([
                ("根盘", "virtio-blk（虚拟块设备）", True),
                ("文件系统", "ext2（无日志）", False),
                ("显示", "VGA（文本模式 80×25）", False),
                ("串口", "16550A UART（COM1）", False),
                ("键盘", "PS/2（i8042 控制器）", False),
                ("时钟/中断", "PIT · PIC · IOAPIC", False),
            ])}
          </div>
        </div>
        <div class="env-topo anim fade" style="--d:.65s">
          <div class="env-topo-label">MACHINE TOPOLOGY / 机器拓扑（本实验）</div>
          <div class="topo-row">
            <div class="topo-box hot">CPU<span>qemu64 · 1 vCPU</span></div>
            <div class="topo-link">系统总线</div>
            <div class="topo-box">RAM<span>512 MiB</span></div>
            <div class="topo-link">PCI</div>
            <div class="topo-box">virtio-blk<span>根盘 ext2</span></div>
            <div class="topo-box">VGA<span>文本 80×25</span></div>
            <div class="topo-box">UART<span>COM1 / ttyS0</span></div>
            <div class="topo-box">i8042<span>PS/2 键盘</span></div>
          </div>
        </div>
        <div class="env-foot anim fade" style="--d:.7s">
          <span class="pill">bzImage sha256 1b04ab59d4e5…</span>
          <span class="pill">rootfs sha256 d70ffb6e9a74…</span>
          <span class="pill">initramfs sha256 16a5305c2d62…</span>
          <span class="pill ok">vmlinux Build ID f5e5edc1c572…</span>
        </div>
        """,
    ),
    dict(
        tag="上电前",
        kicker="S02 / BEFORE POWER",
        title="上电前：所有组件与 CPU 初始状态",
        caption="复位状态：RIP=0xfff0，CS.base=0xffff0000，CR0=0x60000010，CR3=CR4=EFER=0；RAM、VGA、串口、键盘、磁盘都未初始化。",
        narration=(
            "现在还没有按下电源。CPU 处于复位状态：通用寄存器几乎全是零，RIP 是 FFF0，"
            "CS 的选择子是 F000，隐藏基址是 FFFF0000。CR0 是 0x60000010，CR3 和 CR4 都是零，"
            "EFER 也是零。内存还没有被固件使用，低地址是 ROM 映射；VGA、串口、键盘和磁盘都还没有初始化。"
            "画面里是这一刻的真实寄存器快照。后面只讲新增的变化。"
        ),
        bullets=[
            "复位不是“从零开始执行”：CS 隐藏基址让第一条指令落在 ROM。",
            "RAM 内容不可依赖；BIOS 还没有建立中断向量表和 BIOS 数据区。",
            "从下一幕起，每幕只讲**新增机制**，已讲过的只做引用。",
        ],
        facts=[("RIP", "0xfff0", True), ("CS.base", "0xffff0000", True),
               ("CR0", "0x60000010", True), ("CR3 / CR4", "0x0 / 0x0", False)],
        visual=f"""
        <div class="init-grid">
          <div class="stack">
            <div class="pill warn anim fade" style="--d:.1s">POWER OFF / 复位状态 · 真实快照 frame 0</div>
            <div class="component-list">
              <div class="comp-row anim left" style="--d:.25s"><span class="led off"></span><b>CPU（中央处理器）</b><span>复位 · 16 位实模式</span></div>
              <div class="comp-row anim left" style="--d:.35s"><span class="led off"></span><b>RAM（随机存取存储器）</b><span>未初始化</span></div>
              <div class="comp-row anim left" style="--d:.45s"><span class="led on"></span><b>ROM（只读存储器）</b><span>复位向量可读</span></div>
              <div class="comp-row anim left" style="--d:.55s"><span class="led off"></span><b>SeaBIOS（固件）</b><span>尚未执行</span></div>
              <div class="comp-row anim left" style="--d:.65s"><span class="led off"></span><b>VGA（显卡文本模式）</b><span>未初始化</span></div>
              <div class="comp-row anim left" style="--d:.75s"><span class="led off"></span><b>UART（串口）</b><span>未配置</span></div>
              <div class="comp-row anim left" style="--d:.85s"><span class="led off"></span><b>i8042（键盘控制器）</b><span>未初始化</span></div>
              <div class="comp-row anim left" style="--d:.95s"><span class="led off"></span><b>virtio-blk（虚拟块设备）</b><span>未枚举</span></div>
            </div>
            <div class="term anim fade" style="--d:1.05s">物理低端：ROM 映射 / 无有效 IVT
虚拟地址：分页关闭，等于物理地址
中断：关闭（RFLAGS.IF=0）</div>
          </div>
          <div class="anim right" style="--d:.35s">
            {cpu_panorama(RESET_CPU)}
          </div>
        </div>
        """,
    ),

    dict(
        tag="复位",
        kicker="S01 / CPU RESET",
        title="第一条指令从哪里取？",
        caption="CS 隐藏基址是 0xffff0000，IP 是 0xfff0；线性地址 = 0xffff0000 + 0xfff0 = 0xfffffff0。",
        narration=(
            "上电后，电源稳定，CPU 从复位状态开始。CS 的可见选择子是 F000，但隐藏基址是 FFFF0000，"
            "IP 是 FFF0。CPU 用 CS 基址加 IP 得到线性地址 FFFFFFF0，再去取第一条指令。"
            "此时还没有分页，线性地址就是物理地址 FFFF0。取到的字节是 FA 5B E0 00 F0，"
            "第一条指令关中断，随后远跳转进入固件。这个阶段 RAM 还没有初始化，代码来自 ROM 映射。"
        ),
        bullets=[
            "<b>复位向量</b>不是 CS 左移四位；要读 CS 的隐藏基址。",
            "第一条指令在 <span class='mono'>0xfffffff0</span>，物理取指在 <span class='mono'>0xffff0</span>。",
            "此时没有分页、没有 GDT 保护模式；执行环境是 16 位实模式。",
        ],
        facts=[("CS.base", "0xffff0000", True), ("IP", "0xfff0", False),
               ("linear", "0xfffffff0", True), ("first bytes", "fa 5b e0 00 f0", False)],
        visual="""
        <div class="reset">
          <div class="cpu anim pop" style="--d:.15s">
            <div class="pins"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="cpu-core"><div class="name">CPU</div><div class="sub">reset · 16-bit real mode</div></div>
          </div>
          <div class="addr-bus">
            <div class="bus-label anim fade" style="--d:.4s">地址总线 / 取指</div>
            <div class="bus-line anim fade" style="--d:.55s"></div>
            <div class="node accent anim pop" style="--d:.8s">
              <div class="n-title">LINEAR ADDRESS</div>
              <div class="n-value">0xfffffff0</div>
              <div class="n-sub">CS.base + IP = 0xffff0000 + 0xfff0</div>
            </div>
            <div class="node warn anim pop" style="--d:1.1s">
              <div class="n-title">PHYSICAL FETCH</div>
              <div class="n-value">0xffff0</div>
              <div class="n-sub">无分页：线性地址直接落到物理地址</div>
            </div>
            <div class="bus-line anim fade" style="--d:1.35s"></div>
          </div>
          <div class="stack">
            <div class="reg anim right" style="--d:.45s"><span>CS.selector</span><b>0xf000</b></div>
            <div class="reg anim right" style="--d:.6s"><span>CS.base</span><b>0xffff0000</b></div>
            <div class="reg anim right" style="--d:.75s"><span>IP</span><b>0xfff0</b></div>
            <div class="reg hot anim right" style="--d:1s"><span>linear PC</span><b>0xfffffff0</b></div>
            <div class="rom-card anim fade" style="--d:1.25s">
              <div class="pill warn">ROM 映射</div>
              <div class="bytes">fa 5b e0 00 f0</div>
              <div class="line">第一条指令：cli；随后远跳转进入 SeaBIOS。<br>此时栈和 RAM 还不可依赖。</div>
            </div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="固件",
        kicker="S02 / SEABIOS",
        title="SeaBIOS：把机器点亮，再把启动盘读进来",
        caption="POST 检查 CPU/内存/PCI，随后 INT 19h 读取启动盘第一个 512 字节扇区到 0x7c00。",
        narration=(
            "SeaBIOS 做 POST：检查 CPU、初始化内存和 PCI 总线，枚举设备，建立中断向量和 BIOS 数据区。"
            "然后按启动顺序读取启动盘第一个扇区，也就是五百一十二字节，装到 0x7C00，检查末尾的 55 AA，"
            "再跳到 0x7C00。这个扇区就是 MBR，里面是 GRUB 的第一阶段。"
        ),
        bullets=[
            "POST 结束后，低内存已经有了 BIOS 数据区和中断向量。",
            "启动盘由 <b>IDE/ATAPI</b> 提供；本实验使用 <span class='mono'>boot.iso</span>。",
            "MBR 只有 512 字节：446 字节代码 + 分区表 + <span class='mono'>0x55aa</span>。",
        ],
        facts=[("MBR load", "0x7c00", True), ("sector", "512 B", False),
               ("magic", "0x55aa", True), ("next", "GRUB stage1", False)],
        visual="""
        <div class="post-grid">
          <div class="stack">
            <div class="pill ok anim fade" style="--d:.1s">POST · POWER ON SELF TEST</div>
            <div class="checklist">
              <div class="check anim left" style="--d:.25s"><span class="mark">✓</span>CPU / 异常向量</div>
              <div class="check anim left" style="--d:.4s"><span class="mark">✓</span>内存探测 / DRAM 初始化</div>
              <div class="check anim left" style="--d:.55s"><span class="mark">✓</span>PCI 总线 / 设备枚举</div>
              <div class="check anim left" style="--d:.7s"><span class="mark">✓</span>键盘、串口、VGA、磁盘</div>
              <div class="check anim left" style="--d:.85s"><span class="mark">✓</span>INT 13h / INT 19h</div>
            </div>
            <div class="code anim fade" style="--d:1.05s"><span class="c">; INT 19h：固件按启动顺序读盘</span>
读 LBA 0 → 0x7c00（512 B）
检查 0x7dfe == 55 aa
jmp 0x0000:0x7c00</div>
          </div>
          <div class="mbr">
            <div class="disk anim pop" style="--d:.4s"></div>
            <div class="sector anim fade" style="--d:.7s">启动盘 LBA 0 → <b>0x7c00</b></div>
            <div class="sector-bar anim fade" style="--d:.9s">
              <div class="s1">boot code</div><div class="s2">table</div><div class="s3">55 aa</div>
            </div>
            <div class="stack" style="margin-top:18px">
              <div class="pill hi anim fade" style="--d:1.1s">CPU 跳到 0x7c00</div>
              <div class="term anim fade" style="--d:1.3s">0x7c00: <span class="c">MBR / GRUB stage1</span>
0x7dfe: 55 aa</div>
            </div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="引导器",
        kicker="S03 / GRUB",
        title="GRUB：读文件系统，装载 bzImage 和 initramfs",
        caption="MBR 只有 446 字节，GRUB 用 stage1.5/stage2 找到 grub.cfg，再按 linux16 协议装载。",
        narration=(
            "GRUB 的 MBR 只有四百四十六字节代码，它先加载 stage 一点五，再加载 stage 二，"
            "读取文件系统和 boot grub grub 点 cfg。配置里的 linux16 命令按传统十六位协议，"
            "把 bzImage 的 setup 部分放到低内存，把 initramfs 放到内存，并填写 boot_params。"
            "然后 GRUB 跳到 setup 的入口 main；本实验实测停在 0x11171。"
        ),
        bullets=[
            "MBR 不直接理解文件系统；stage1.5 才带 ext2/ISO9660 等驱动。",
            "<span class='mono'>linux16</span> 走传统 16 位引导协议；<span class='mono'>linux</span> 走 32 位协议。",
            "GRUB 负责准备 <b>boot_params</b>、命令行、initrd 地址，然后交接给 setup。",
        ],
        facts=[("stage1", "MBR 446 B", False), ("config", "grub.cfg", False),
               ("setup main", "0x11171", True), ("handoff", "linux16", True)],
        visual="""
        <div class="stack" style="height:100%; justify-content:center">
          <div class="grid3">
            <div class="node anim pop" style="--d:.15s"><div class="n-title">STAGE 1</div><div class="n-value">MBR</div><div class="n-sub">446 B code · 0x7c00</div></div>
            <div class="node anim pop" style="--d:.35s"><div class="n-title">STAGE 1.5</div><div class="n-value">FS driver</div><div class="n-sub">读 ISO9660 / ext2</div></div>
            <div class="node anim pop" style="--d:.55s"><div class="n-title">STAGE 2</div><div class="n-value">GRUB core</div><div class="n-sub">命令、菜单、loader</div></div>
          </div>
          <div class="flow anim fade" style="--d:.8s">
            <div class="node"><div class="n-title">grub.cfg</div><div class="n-value">linux16</div><div class="n-sub">/boot/bzImage</div></div>
            <div class="arrow"></div>
            <div class="node accent"><div class="n-title">LOAD</div><div class="n-value">setup + initrd</div><div class="n-sub">低内存 / boot_params</div></div>
            <div class="arrow"></div>
            <div class="node ok"><div class="n-title">JUMP</div><div class="n-value">setup main</div><div class="n-sub">实测 0x11171</div></div>
          </div>
          <div class="code anim fade" style="--d:1.05s"><span class="c"># /boot/grub/grub.cfg</span>
menuentry 'Linux Observatory' {
  <span class="k">linux16</span> /boot/bzImage nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init
  <span class="k">initrd16</span> /boot/initramfs.cpio.gz
}</div>
        </div>
        """,
    ),
    dict(
        tag="setup",
        kicker="S04 / LINUX SETUP",
        title="16 位 setup：整理 boot_params，打开保护模式",
        caption="setup 仍在实模式：读内存图、命令行、initrd，建立 GDT，置 CR0.PE，再跳到 32 位入口。",
        narration=(
            "setup 仍运行在十六位实模式。它读取 boot_params，整理内存图、命令行、initrd 地址，"
            "建立 GDT，然后置 CR0 的 PE 位进入保护模式，再远跳转到三十二位入口。"
            "注意这一步还没有分页，段基址仍然参与地址计算；真正的内核还没有解压。"
        ),
        bullets=[
            "<b>boot_params</b> 是 GRUB 与内核之间的交接结构，里面是内存图和启动参数。",
            "<b>CR0.PE</b> 只打开保护模式；分页要等 CR0.PG。",
            "setup 是 16 位代码，不能直接按 64 位内核符号解释。",
        ],
        facts=[("mode", "real-16", False), ("CR0.PE", "0 → 1", True),
               ("next", "startup_32", True), ("paging", "off", False)],
        visual="""
        <div class="setup-grid">
          <div class="stack">
            <div class="node anim left" style="--d:.15s"><div class="n-title">BOOT_PARAMS</div><div class="n-value">low memory</div><div class="n-sub">memory map · cmdline · initrd · e820</div></div>
            <div class="stack anim fade" style="--d:.4s">
              <div class="reg"><span>code32_start</span><b>0x100000</b></div>
              <div class="reg"><span>initrd_addr_max</span><b>0x37ffffff</b></div>
              <div class="reg"><span>e820_entries</span><b>6</b></div>
            </div>
            <div class="pill warn anim fade" style="--d:.65s">实模式 · 段基址仍参与寻址</div>
            <div class="term anim fade" style="--d:.85s">setup main @ <span class="ok">0x11171</span>
构建 GDT · 整理 boot_params</div>
          </div>
          <div class="stack">
            <div class="gdt anim right" style="--d:.35s">
              <div class="g-row"><span>#</span><span>描述符</span><span>用途</span></div>
              <div class="g-row"><b>0</b><span>null</span><span>空描述符</span></div>
              <div class="g-row"><b>1</b><span>code32</span><span>0x00000000 / 4G</span></div>
              <div class="g-row"><b>2</b><span>data32</span><span>0x00000000 / 4G</span></div>
            </div>
            <div class="pill anim fade" style="--d:.7s">CR0</div>
            <div class="cr0 anim fade" style="--d:.8s">
              <div class="bit hot"><b>1</b><span>PE</span></div>
              <div class="bit"><b>0</b><span>PG</span></div>
            </div>
            <div class="vline anim fade" style="--d:1.05s"></div>
            <div class="node ok anim pop" style="--d:1.15s"><div class="n-title">JMP</div><div class="n-value">startup_32</div><div class="n-sub">进入 32 位保护模式</div></div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="解压器",
        kicker="S05 / DECOMPRESSOR",
        title="从 32 位到长模式，把内核解压到最终位置",
        caption="startup_32 建临时页表，置 CR4.PAE、EFER.LME、CR0.PG；startup_64 进入长模式并解压内核。",
        narration=(
            "接下来是解压器。startup 三十二在 0x100000，先 verify cpu，再建立临时页表，"
            "置 CR4 的 PAE，写 EFER 的 LME，最后置 CR0 的 PG，进入长模式。"
            "startup 六十四在 0x100200 继续执行，extract kernel 解析 bzImage 头，"
            "把压缩的内核解压到最终位置，再跳到主内核入口。此时页表把高地址映射到物理内存，"
            "内核才能按链接地址运行。"
        ),
        bullets=[
            "32 位解压器和主内核里都有 <span class='mono'>startup_64</span>；必须按模块区分。",
            "PAE、LME、PG 是三个不同的位，必须按顺序打开。",
            "解压完成前，内核链接地址还不是可直接读取的运行地址。",
        ],
        facts=[("startup_32", "0x100000", True), ("startup_64", "0x100200", True),
               ("mode", "long-64", False), ("extract", "bzImage → RAM", False)],
        visual="""
        <div class="pipe">
          <div class="pipe-list">
            <div class="step anim left" style="--d:.15s"><span class="num">01</span><div><b>startup_32</b><div class="sub">0x100000 · verify_cpu</div></div></div>
            <div class="step anim left" style="--d:.3s"><span class="num">02</span><div><b>临时页表</b><div class="sub">建立恒等映射 / 高地址映射</div></div></div>
            <div class="step anim left" style="--d:.45s"><span class="num">03</span><div><b>CR4.PAE</b><div class="sub">开启物理地址扩展</div></div></div>
            <div class="step anim left" style="--d:.6s"><span class="num">04</span><div><b>EFER.LME</b><div class="sub">允许长模式</div></div></div>
            <div class="step anim left" style="--d:.75s"><span class="num">05</span><div><b>CR0.PG</b><div class="sub">分页真正生效，进入 long-64</div></div></div>
          </div>
          <div class="pages">
            <div class="pill hi anim fade" style="--d:.4s">PAGE WALK · 4 LEVELS</div>
            <div class="level anim fade" style="--d:.55s"><div class="name">PML4</div><div class="cells"><i></i><i></i><i></i><i class="hit"></i><i></i><i></i><i></i><i></i></div></div>
            <div class="level anim fade" style="--d:.65s"><div class="name">PDPT</div><div class="cells"><i></i><i></i><i class="hit"></i><i></i><i></i><i></i><i></i><i></i></div></div>
            <div class="level anim fade" style="--d:.75s"><div class="name">PD</div><div class="cells"><i></i><i></i><i></i><i></i><i class="hit"></i><i></i><i></i><i></i></div></div>
            <div class="level anim fade" style="--d:.85s"><div class="name">PT</div><div class="cells"><i class="hit"></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
            <div class="node accent anim pop" style="--d:1.05s"><div class="n-title">EXTRACT</div><div class="n-value">compressed → vmlinux</div><div class="n-sub">解压到最终物理地址，跳到主内核</div></div>
            <div class="row" style="justify-content:center"><span class="pill ok">CR0.PG=1</span><span class="pill ok">EFER.LMA=1</span><span class="pill ok">CPL=0</span></div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="内存布局",
        kicker="S08 / MEMORY PANORAMA",
        title="物理与虚拟：完整布局 + 真实低内存",
        caption="物理 0–512 MiB：IVT/BDA、MBR、setup、VGA/ROM 洞、内核/initramfs；高半区：direct map、vmemmap、vmalloc、kernel text。下方 32 字节一行。",
        narration=(
            "进入长模式后，地址分成物理和虚拟两套。物理地址从零开始：最低端是中断向量表和 BIOS 数据区，"
            "然后是 MBR、setup，1 MiB 以上是内核、initramfs、页表和 DMA 缓冲。虚拟地址在高半区："
            "direct map 线性映射全部 RAM，vmemmap 描述每一页，内核 text 在 0xffffffff81000000 附近。"
            "下面是从 shell 回读的真实低内存，三十二字节一行。"
        ),
        bullets=[
            "物理低端不是一整块 RAM：IVT、BDA、VGA/ROM 洞都有固定用途。",
            "虚拟地址不是另一块内存：direct map 把同一批物理页再映射一次。",
            "十六进制按 32 字节一行，右侧 ASCII 只用于辅助识别。",
        ],
        facts=[("RAM", "512 MiB", False), ("hexdump", "32 B / row", True),
               ("IVT / BDA", "0x0 / 0x400", True), ("快照", "shell frame 5", False)],
        visual=f"""
        <div class="mem-pano">
          <div class="mem-top">
            <div class="map-col">
              <div class="pill warn anim fade" style="--d:.1s">PHYSICAL / 物理地址 · 0–512 MiB</div>
              <div class="mem-stack">
                <div class="mem-seg low anim left" style="--d:.2s"><b>0x00000000 – 0x000003ff</b><span>IVT（中断向量表）· 256 个向量</span></div>
                <div class="mem-seg low anim left" style="--d:.3s"><b>0x00000400 – 0x000004ff</b><span>BDA（BIOS 数据区）· 256 B</span></div>
                <div class="mem-seg low anim left" style="--d:.4s"><b>0x00000500 – 0x00007bff</b><span>常规内存 / EBDA（扩展 BIOS 数据区）</span></div>
                <div class="mem-seg kern anim left" style="--d:.5s"><b>0x00007c00 – 0x00007dff</b><span>MBR（主引导记录）/ GRUB stage1 · 512 B</span></div>
                <div class="mem-seg kern anim left" style="--d:.6s"><b>0x00010000 – 0x0009ffff</b><span>setup（16 位引导代码）· 低内存</span></div>
                <div class="mem-seg hole anim left" style="--d:.7s"><b>0x000a0000 – 0x000fffff</b><span>VGA 显存 / ROM 映射 · 不是普通 RAM</span></div>
                <div class="mem-seg free anim left" style="--d:.8s"><b>0x00100000 – 0x1fffffff</b><span>解压器 · 内核 · initramfs · 页表 · DMA / 可用 RAM</span></div>
              </div>
            </div>
            <div class="map-col">
              <div class="pill hi anim fade" style="--d:.15s">VIRTUAL / 虚拟地址 · 4-level · KASLR off</div>
              <div class="mem-stack">
                <div class="mem-seg text anim right" style="--d:.25s"><b>0xffffffff81000000</b><span>kernel text（内核代码段）· start_kernel 等</span></div>
                <div class="mem-seg direct anim right" style="--d:.35s"><b>0xffff888000000000</b><span>direct map（直接映射）· 全部 RAM</span></div>
                <div class="mem-seg vmem anim right" style="--d:.45s"><b>0xffffea0000000000</b><span>vmemmap（页描述符数组）· struct page</span></div>
                <div class="mem-seg vmalloc anim right" style="--d:.55s"><b>0xffffc90000000000</b><span>vmalloc（动态虚拟内存）· 模块 / 栈</span></div>
                <div class="mem-seg anim right" style="--d:.65s"><b>0xffffffffa0000000</b><span>modules（内核模块）· 可选区域</span></div>
                <div class="mem-seg anim right" style="--d:.75s"><b>0xfffffe0000000000</b><span>CPU entry area（异常/中断入口）</span></div>
              </div>
            </div>
          </div>
          <div class="mem-dump anim fade" style="--d:.9s">
            <div class="dump-head"><span class="pill ok">真实低内存回读 · 32 B/row</span><span class="dim">低端保留区在启动后仍可读；这里只抽样 64 B</span></div>
            <div class="dump-grid">
              {hexdump_table("0x0", "IVT / BDA（中断向量表 / BIOS 数据区）", rows=4)}
              {hexdump_table("0x7c00", "MBR / GRUB stage1（主引导记录）", rows=4)}
              {hexdump_table("0x10000", "setup（16 位引导代码）", rows=4)}
              {hexdump_table("0x100000", "decompressor（解压器）", rows=4)}
              {hexdump_table("0x1000000", "kernel text（内核代码）", rows=4)}
              {hexdump_table("0x2000000", "kernel / page tables（内核/页表）", rows=4)}
            </div>
          </div>
        </div>
        """,
    ),

    dict(
        tag="内核",
        kicker="S06 / START_KERNEL",
        title="主内核开始初始化：一棵调用树",
        caption="start_kernel 初始化内存、调度、中断、计时器、VFS 和驱动框架，最后 rest_init 创建 PID 1。",
        narration=(
            "主内核从 startup 六十四进入 x86 六十四 start kernel，再到 start kernel。"
            "这里开始初始化内存管理、调度器、中断控制器、计时器、VFS、proc 和 sysfs、驱动框架等。"
            "这个阶段不是一条指令，而是一棵调用树；本实验停在 start kernel 的 "
            "0xffffffff82056d20，之后 rest init 创建 kernel init 线程。"
        ),
        bullets=[
            "内核链接在高半区；页表把线性地址翻译到物理内存。",
            "初始化顺序决定后面谁能用：内存 → 调度 → 中断/时钟 → VFS → 驱动。",
            "<b>rest_init</b> 之后，PID 1 和 idle 任务开始出现。",
        ],
        facts=[("start_kernel", "0xffffffff82056d20", True), ("CPL", "0", False),
               ("next", "rest_init → kernel_init", True), ("scheduler", "initialized", False)],
        visual="""
        <div class="kernel">
          <svg class="wire-svg" viewBox="0 0 1100 560">
            <path d="M550 250 L250 110"/><path d="M550 250 L550 80"/><path d="M550 250 L850 110"/>
            <path d="M550 250 L230 450"/><path d="M550 250 L550 490"/><path d="M550 250 L870 450"/>
          </svg>
          <div class="kernel-core anim pop" style="--d:.15s">
            <div class="k1">x86_64_start_kernel</div>
            <div class="k2">start_kernel</div>
            <div class="k3">0xffffffff82056d20</div>
            <div class="pill ok" style="margin-top:10px">CPL 0 · long-64</div>
          </div>
          <div class="subsystem anim pop" style="left:40px;top:55px;--d:.4s">内存管理<span class="s">mm / page allocator</span></div>
          <div class="subsystem anim pop" style="left:460px;top:20px;--d:.55s">调度器<span class="s">sched / runqueue</span></div>
          <div class="subsystem anim pop" style="right:40px;top:55px;--d:.7s">中断与时钟<span class="s">IRQ / APIC / tick</span></div>
          <div class="subsystem anim pop" style="left:25px;bottom:45px;--d:.85s">VFS<span class="s">mount / dentry / inode</span></div>
          <div class="subsystem anim pop" style="left:460px;bottom:20px;--d:1s">proc / sysfs<span class="s">内核对象入口</span></div>
          <div class="subsystem anim pop" style="right:25px;bottom:45px;--d:1.15s">驱动框架<span class="s">PCI / virtio / ext2</span></div>
          <div class="pill hi anim fade" style="position:absolute;left:50%;bottom:120px;transform:translateX(-50%);--d:1.35s">rest_init → kernel_init → PID 1</div>
        </div>
        """,
    ),
    dict(
        tag="PID 1",
        kicker="S07 / INITRAMFS",
        title="kernel_init 变成 PID 1，执行 initramfs 的 /init",
        caption="kernel_init 完成剩余初始化，打开 /dev/console，执行 initramfs 里的 /init；它成为 PID 1。",
        narration=(
            "kernel init 变成 PID 一。它先把 initramfs 当作临时根文件系统，执行其中的 /init。"
            "init 脚本挂载 devtmpfs、proc、sysfs，然后等待 virtio 磁盘 /dev/vda 出现；"
            "这就是我们根盘的设备节点。此时 PID 一仍是同一个 task struct，"
            "但它的用户地址空间来自 initramfs 里的 /init。"
        ),
        bullets=[
            "PID 1 不是特殊指令，而是一个真实的 <span class='mono'>task_struct</span>。",
            "initramfs 是内存里的临时根，用来加载挂载真实根盘所需的驱动。",
            "<span class='mono'>/init</span> 是用户态脚本；它会在挂载根盘后退出舞台。",
        ],
        facts=[("PID 1", "kernel_init", True), ("rootfs", "initramfs", False),
               ("exec", "/init", True), ("wait", "/dev/vda", False)],
        visual="""
        <div class="pid-grid">
          <div class="task-tree">
            <div class="task node anim pop" style="--d:.15s"><div class="task-comm">init_task</div><div class="task-meta">pid 0 · swapper</div></div>
            <div class="task-link anim fade" style="--d:.35s"></div>
            <div class="task node accent anim pop" style="--d:.5s"><div class="task-comm">kernel_init</div><div class="task-meta">pid 1 · PID 1</div></div>
            <div class="task-link anim fade" style="--d:.7s"></div>
            <div class="task node ok anim pop" style="--d:.85s"><div class="task-comm">/init</div><div class="task-meta">initramfs 用户态</div></div>
          </div>
          <div class="stack">
            <div class="initramfs anim right" style="--d:.45s">
              <div class="tag">INITRAMFS · tmpfs</div>
              <div class="files">
                <span class="pill hi">/init</span><span class="pill">/bin/busybox</span>
                <span class="pill">/dev</span><span class="pill">/proc</span><span class="pill">/sys</span>
              </div>
              <div class="code" style="margin-top:12px"><span class="c"># /init</span>
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc
mount -t sysfs sysfs /sys
while [ ! -b /dev/vda ]; do sleep 0.1; done</div>
            </div>
            <div class="task node anim fade" style="--d:.85s"><div class="n-title">CURRENT</div><div class="n-value">pid=1 /init</div><div class="n-sub">等待 /dev/vda 出现</div></div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="virtio",
        kicker="S08 / VIRTIO-BLK",
        title="virtio-blk：描述符、DMA、中断",
        caption="驱动协商 feature、填充 virtqueue，kick 设备；设备 DMA 读写，完成后更新 used 环并拉中断。",
        narration=(
            "virtio blk 通过 PCI 暴露给内核。驱动读取 PCI 配置空间，协商 feature，设置 virtqueue。"
            "提交读请求时，CPU 在内存里填好描述符链和 avail 环，然后 kick 设备。"
            "设备通过 DMA 读请求、写数据，完成后更新 used 环并拉中断。"
            "Linux 在中断里扫描 used 环，唤醒等待的进程。"
        ),
        bullets=[
            "virtqueue 是共享内存协议，不是一次 CPU 端口写就能完成。",
            "描述符链、avail、used 三个环都要按实际协商格式解析。",
            "DMA 与中断是两条不同的证据：一个搬字节，一个通知完成。",
        ],
        facts=[("device", "virtio-blk-pci", False), ("queue", "split ring", True),
               ("DMA", "descriptor → RAM", True), ("IRQ", "used ring", False)],
        visual="""
        <div class="virtio">
          <div class="stack">
            <div class="node accent anim left" style="--d:.15s"><div class="n-title">PCI</div><div class="n-value">virtio-blk</div><div class="n-sub">BAR · feature negotiation</div></div>
            <div class="node anim left" style="--d:.35s"><div class="n-title">REQUEST</div><div class="n-value">read LBA</div><div class="n-sub">out_hdr + data + status</div></div>
            <div class="dma-arrow anim fade" style="--d:.55s"><span>CPU</span><div class="line"></div><span>DMA</span></div>
            <div class="node ok anim left" style="--d:.7s"><div class="n-title">COMPLETE</div><div class="n-value">used.idx++</div><div class="n-sub">raise IRQ</div></div>
          </div>
          <div class="ring">
            <div class="r-title anim fade" style="--d:.3s">descriptor ring</div>
            <div class="ring-row anim fade" style="--d:.4s"><div class="ring-cell hot">0</div><div class="ring-cell">1</div><div class="ring-cell">2</div><div class="ring-cell">3</div><div class="ring-cell">4</div><div class="ring-cell">5</div><div class="ring-cell">6</div><div class="ring-cell">7</div></div>
            <div class="r-title anim fade" style="--d:.55s">avail ring</div>
            <div class="ring-row anim fade" style="--d:.65s"><div class="ring-cell ok">idx</div><div class="ring-cell hot">0</div><div class="ring-cell">1</div><div class="ring-cell">2</div><div class="ring-cell">3</div></div>
            <div class="r-title anim fade" style="--d:.8s">used ring</div>
            <div class="ring-row anim fade" style="--d:.9s"><div class="ring-cell">id</div><div class="ring-cell ok">len</div><div class="ring-cell hot">0</div><div class="ring-cell"></div><div class="ring-cell"></div></div>
            <div class="pill hi anim fade" style="--d:1.1s">0x1000000 · split virtqueue</div>
            <div class="term anim fade" style="--d:1.25s">kick → device DMA → used ring → IRQ
Linux: virtqueue_get_buf() → 完成请求 → 唤醒进程</div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="ext2",
        kicker="S09 / EXT2 ROOT",
        title="挂载 ext2：superblock、inode、dentry",
        caption="读 1024 字节处的超级块，校验 0xEF53；根 inode 是 2，之后解析目录项和 inode 表。",
        narration=(
            "根盘 /dev/vda 上是 ext2。内核读一千零二十四字节处的超级块，校验 magic 0xEF53，"
            "读块组描述符和 inode 表。根目录是 inode 二；ext2 驱动按目录项查找 /data/hello.txt，"
            "把 inode 读进内存，建立 dentry 和 inode 缓存，挂到 VFS 的挂载树上。"
            "此时页缓存和磁盘是两个层次。"
        ),
        bullets=[
            "ext2 没有日志；不要在讲解里画不存在的 journal 提交。",
            "路径查找：mount → dentry → inode → 数据块。",
            "页缓存命中时不一定有磁盘 I/O；冷读才走 virtio。",
        ],
        facts=[("superblock", "0x400 / 0xEF53", True), ("root ino", "2", True),
               ("hello.txt", "85 B", False), ("mount", "VFS", False)],
        visual="""
        <div class="ext2">
          <div class="stack">
            <div class="pill hi anim fade" style="--d:.2s">DISK LAYOUT · ext2</div>
            <div class="blocks">
              <div class="block anim fade" style="--d:.3s"></div>
              <div class="block sb anim pop" style="--d:.4s"><b>SB</b>1024</div>
              <div class="block anim fade" style="--d:.5s"><b>GD</b>group</div>
              <div class="block inode anim pop" style="--d:.6s"><b>INODE</b>table</div>
              <div class="block inode anim pop" style="--d:.7s"><b>INODE</b>2</div>
              <div class="block data anim pop" style="--d:.8s"><b>DATA</b>dir</div>
              <div class="block data anim pop" style="--d:.9s"><b>DATA</b>hello</div>
              <div class="block anim fade" style="--d:1s"></div>
            </div>
            <div class="code anim fade" style="--d:1.15s">s_magic = 0xEF53
s_log_block_size = 0 → 4096 B
s_inodes_count = 24576
root inode = 2</div>
          </div>
          <div class="dentry">
            <div class="d-row anim right" style="--d:.4s"><span>mount</span><span class="mono">/</span><span class="dim">VFS root</span></div>
            <div class="d-row anim right" style="--d:.55s"><span>dentry</span><span class="mono">/data</span><span class="dim">inode 118</span></div>
            <div class="d-row anim right" style="--d:.7s"><span>dentry</span><span class="mono">/data/hello.txt</span><span class="dim">inode 119</span></div>
            <div class="d-row anim right" style="--d:.85s"><span>inode</span><span class="mono">size 85</span><span class="ok">数据块已定位</span></div>
            <div class="pill ok anim fade" style="--d:1.05s">VFS mount · dentry cache · inode cache</div>
            <div class="term anim fade" style="--d:1.2s">cat /data/hello.txt
→ VFS → ext2 → page cache → virtio-blk → DMA</div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="switch",
        kicker="S10 / SWITCH_ROOT",
        title="switch_root：从 initramfs 换到真实 ext2 根",
        caption="initramfs 的 /init 挂载 /dev/vda，移动 /dev /proc /sys，switch_root，执行 /sbin/init。",
        narration=(
            "initramfs 的 /init 把 /dev、/proc、/sys 移动到新根，调用 switch root 切换根目录，"
            "再执行新根上的 /sbin/init。原来的 initramfs 根被替换，PID 一仍然是同一个进程，"
            "但根目录和用户空间已经换成了真实 ext2 盘。"
        ),
        bullets=[
            "switch_root 改变根目录和当前工作目录，然后 exec 新根上的 init。",
            "PID 1 不变，变化的是它看到的根文件系统和后续用户空间。",
            "这一步之后，/data 才真正来自 virtio ext2 盘。",
        ],
        facts=[("before", "initramfs", False), ("after", "ext2 /dev/vda", True),
               ("pid", "1 (same task)", True), ("exec", "/sbin/init", False)],
        visual="""
        <div class="rootcmp">
          <div class="mount-tree anim left" style="--d:.2s">
            <div class="root">/  (initramfs)</div>
            <div>├─ init</div><div>├─ bin/busybox</div><div>├─ proc</div><div>├─ sys</div><div>└─ dev</div>
          </div>
          <div class="switch-arrow anim fade" style="--d:.55s">
            <div class="a"></div>
            <div>switch_root</div>
          </div>
          <div class="mount-tree anim right" style="--d:.8s">
            <div class="root">/  (ext2 /dev/vda)</div>
            <div>├─ sbin/init</div><div>├─ bin / lib / etc</div><div>├─ data/hello.txt</div><div>├─ proc</div><div>└─ sys / dev</div>
          </div>
        </div>
        """,
    ),
    dict(
        tag="用户空间",
        kicker="S11 / BUSYBOX",
        title="BusyBox init：拉起 tty，得到 shell",
        caption="BusyBox init 读 /etc/inittab：tty1 askfirst，ttyS0 respawn；getty 打开终端，exec /bin/sh。",
        narration=(
            "BusyBox init 读取 /etc/inittab：tty 一上 askfirst 启动登录 shell，ttyS0 上 respawn 一个串口 shell。"
            "getty 打开终端，设置 termios，exec /bin/sh。shell 打印提示符 linux-lab:/root#，"
            "然后阻塞在 read 上等待输入。"
        ),
        bullets=[
            "VGA 上的 tty1 和串口 ttyS0 是两个独立终端，不是同一路输入。",
            "getty 负责打开终端并 exec shell；shell 随后在 read 上睡眠。",
            "看到提示符只说明用户空间起来了，不代表每个设备都已完成初始化。",
        ],
        facts=[("inittab", "/etc/inittab", False), ("tty1", "askfirst", True),
               ("ttyS0", "respawn", True), ("prompt", "linux-lab:/root#", True)],
        visual="""
        <div class="tty">
          <div class="stack">
            <div class="code anim left" style="--d:.15s"><span class="c"># /etc/inittab</span>
::sysinit:/etc/rcS
tty1::askfirst:/bin/sh -l
ttyS0::respawn:/bin/cttyhack /bin/sh -l
::ctrlaltdel:/sbin/reboot</div>
            <div class="grid2">
              <div class="node anim pop" style="--d:.5s"><div class="n-title">tty1</div><div class="n-value">VGA</div><div class="n-sub">askfirst · 需要按 Enter</div></div>
              <div class="node anim pop" style="--d:.65s"><div class="n-title">ttyS0</div><div class="n-value">serial</div><div class="n-sub">respawn · 115200</div></div>
            </div>
            <div class="pill ok anim fade" style="--d:.85s">PID 1 → getty → /bin/sh</div>
          </div>
          <div class="screen anim right" style="--d:.55s">
<span class="c">Linux Observatory / Linux 6.12.112</span>
Real kernel, real processes, real virtio disk.
Try: cat /data/hello.txt; lab-read; lab-memory; lab-cow

<span class="prompt">linux-lab:/root#</span> <span class="cursor"></span>
          </div>
        </div>
        """,
    ),
    dict(
        tag="终端",
        kicker="S12 / TTY I/O",
        title="按键如何变成终端里的字符？",
        caption="i8042 → IRQ 1 → input → VT/TTY 行规程 → 回显；回车后 shell 被唤醒，fork/exec 执行命令。",
        narration=(
            "按键不是直接变成字符。键盘控制器 i8042 产生扫描码和 IRQ 一；CPU 进入中断，"
            "驱动读数据端口，把扫描码送进 input 层，再经过 VT 和 TTY 的行规程，回显到 VGA 或串口。"
            "输入回车后，shell 被唤醒，fork 和 exec 执行命令，输出再沿 tty 写回屏幕。"
            "串口和 PS2 是两条独立通路。"
        ),
        bullets=[
            "键盘中断、TTY 缓冲、行规程回显是不同阶段。",
            "串口输入不经过 i8042；不要把两条通路混成一条。",
            "回车提交一行后，shell 才 fork/exec 执行命令。",
        ],
        facts=[("keyboard", "i8042 · IRQ 1", True), ("line", "TTY / termios", True),
               ("echo", "VGA / serial", False), ("exec", "fork + exec", False)],
        visual="""
        <div class="tty">
          <div class="tty-flow">
            <div class="tty-step anim left" style="--d:.15s"><span class="idx">01</span>按键按下 · 扫描码<span class="sub">PS/2</span></div>
            <div class="tty-step anim left" style="--d:.3s"><span class="idx">02</span>i8042 · IRQ 1<span class="sub">0x60</span></div>
            <div class="tty-step anim left" style="--d:.45s"><span class="idx">03</span>input / VT / TTY<span class="sub">line discipline</span></div>
            <div class="tty-step anim left" style="--d:.6s"><span class="idx">04</span>回显到 VGA / 串口<span class="sub">echo</span></div>
            <div class="tty-step anim left" style="--d:.75s"><span class="idx">05</span>回车 → 唤醒 shell<span class="sub">read 返回</span></div>
            <div class="tty-step anim left" style="--d:.9s"><span class="idx">06</span>fork / exec 命令<span class="sub">输出回 tty</span></div>
          </div>
          <div class="screen anim right" style="--d:.6s">
<span class="c">[按键] l s ⏎</span>
<span class="prompt">linux-lab:/root#</span> ls
bin  data  dev  etc  proc  root  sys

<span class="c">[串口是另一条通路]</span>
ttyS0 · 115200 · IRQ
          </div>
        </div>
        """,
    ),
    dict(
        tag="全景",
        kicker="S16 / FULL SNAPSHOT",
        title="到达 shell：CPU、进程与内存的全景",
        caption="同一台机器，长模式 + CPL 0；CR3=0x329c000，CR4=0x6f0，EFER=0xd01；PID 1 已存在，47 个进程。",
        narration=(
            "到达 shell 后，再看一次全景。CPU 已经在长模式，CPL 是零，RIP 在高半区，CR3 指向当前进程的页表，"
            "CR4 打开了 PAE，EFER 的 LME 和 LMA 都置位。通用寄存器里是当前任务留下的真实值。"
            "内存这边，低端保留着中断向量表、MBR、setup 和解压器；高半区是 direct map、vmemmap 和内核 text。"
            "很多值从开机到现在没有变，但它们仍然真实存在。"
        ),
        bullets=[
            "CPU 全景不需要每幕重复；这里一次性给出复位后的真实终值。",
            "CR3 指向页表；CR4/EFER 记录长模式和 PAE 已经打开。",
            "进程与内存是同一份快照：PID 1、47 个进程、7 个 VMA。",
        ],
        facts=[("模式", "long-64 · CPL 0", True), ("CR3", "0x329c000", True),
               ("PID 1", "init / sleeping", True), ("进程 / VMA", "47 / 7", False)],
        visual=f"""
        <div class="pano-grid">
          <div class="anim left" style="--d:.2s">
            {cpu_panorama(SHELL_CPU)}
          </div>
          <div class="stack">
            <div class="delta-card anim right" style="--d:.4s">
              <div class="pill hi">RESET → SHELL · 关键变化</div>
              <div class="delta-row"><span>模式</span><b>real-16 → long-64</b></div>
              <div class="delta-row"><span>CR0</span><b>0x60000010 → 0x80050033</b></div>
              <div class="delta-row"><span>CR3</span><b>0x0 → 0x329c000</b></div>
              <div class="delta-row"><span>CR4</span><b>0x0 → 0x6f0（PAE 等）</b></div>
              <div class="delta-row"><span>EFER</span><b>0x0 → 0xd01（LME/LMA）</b></div>
            </div>
            <div class="node anim right" style="--d:.65s">
              <div class="n-title">CURRENT / 当前任务</div>
              <div class="n-value">swapper/0 · PID 0</div>
              <div class="n-sub">RIP 0xffffffff81791d73 · RSP 0xffffffff81e03e28</div>
            </div>
            <div class="node ok anim right" style="--d:.8s">
              <div class="n-title">PID 1</div>
              <div class="n-value">init · task 0xffff8880029b8000</div>
              <div class="n-sub">mm 0xffff88800284c500 · state sleeping</div>
            </div>
            <div class="node anim right" style="--d:.95s">
              <div class="n-title">MEMORY / 内存</div>
              <div class="n-value">低端 IVT·MBR·setup·解压器</div>
              <div class="n-sub">高半区 direct map · vmemmap · kernel text</div>
            </div>
            <div class="pill ok anim fade" style="--d:1.1s">真实 frame 5 · 不是示意图</div>
          </div>
        </div>
        """,
    ),

    dict(
        tag="回顾",
        kicker="S13 / RECAP",
        title="一条完整的时间线",
        caption="复位取指 → SeaBIOS → MBR/GRUB → setup → 解压 → start_kernel → PID 1 → ext2 → shell。",
        narration=(
            "回顾这条线：复位取指、SeaBIOS、MBR 和 GRUB、十六位 setup、三十二位和六十四位解压、"
            "start kernel、PID 一和 initramfs、virtio 和 ext2、switch root、BusyBox shell。"
            "以后再单独讲某个组件，就在这条时间线上选一个执行时机，把它切开看。"
        ),
        bullets=[
            "这是主线；每个组件都可以在时间线上放大成独立切面。",
            "实验页面里对应的课程是 L00–L07：复位、MBR、setup、解压、内核、PID 1、根盘。",
            "真实地址、寄存器和结构都来自当前构建，不是固定教程值。",
        ],
        facts=[("课程", "L00–L07", True), ("帧序列", "0…7", False),
               ("终点", "shell", True), ("录制", "boot video", False)],
        visual="""
        <div class="recap">
          <div class="pill hi anim fade" style="--d:.2s">ONE TRACE · FROM RESET TO SHELL</div>
          <div class="recap-line anim fade" style="--d:.35s"></div>
          <div class="recap-nodes">
            <div class="recap-node anim fade" style="--d:.45s"><div class="dot"></div><div class="t">复位</div><div class="s">0xfffffff0</div></div>
            <div class="recap-node anim fade" style="--d:.55s"><div class="dot"></div><div class="t">SeaBIOS</div><div class="s">MBR → 0x7c00</div></div>
            <div class="recap-node anim fade" style="--d:.65s"><div class="dot"></div><div class="t">GRUB</div><div class="s">linux16</div></div>
            <div class="recap-node anim fade" style="--d:.75s"><div class="dot"></div><div class="t">setup</div><div class="s">0x11171</div></div>
            <div class="recap-node anim fade" style="--d:.85s"><div class="dot"></div><div class="t">解压</div><div class="s">0x100000</div></div>
            <div class="recap-node anim fade" style="--d:.95s"><div class="dot"></div><div class="t">start_kernel</div><div class="s">0xffffffff…</div></div>
            <div class="recap-node anim fade" style="--d:1.05s"><div class="dot"></div><div class="t">PID 1</div><div class="s">initramfs</div></div>
            <div class="recap-node anim fade" style="--d:1.15s"><div class="dot"></div><div class="t">ext2</div><div class="s">virtio-blk</div></div>
            <div class="recap-node anim fade" style="--d:1.25s"><div class="dot"></div><div class="t">switch_root</div><div class="s">/sbin/init</div></div>
            <div class="recap-node anim fade" style="--d:1.35s"><div class="dot"></div><div class="t">shell</div><div class="s">tty1 / ttyS0</div></div>
          </div>
          <div class="recap-bottom">
            <span class="pill ok">真实 QEMU</span><span class="pill ok">GDB/MI</span><span class="pill ok">x-oslab observer</span>
            <span class="pill">L00–L07</span><span class="pill">25 课</span>
            <span class="pill">QEMU 8.2.10</span><span class="pill">Linux 6.12.112</span>
            <span class="pill">SeaBIOS 1.16.3</span><span class="pill">BusyBox 1.37.0</span>
          </div>
        </div>
        """,
    ),
]


NARRATION = {
    "总览": "先别急着看寄存器。我们从一台没有通电的机器开始，先讲环境和组件，再沿着一条真实启动路径，一直走到终端。",
    "环境": "先交代环境。宿主机是 TencentOS Server 3.2。模拟器是 QEMU 8.2.10，单核 qemu64，使用 TCG 软件模拟。客户机内核是 Linux 6.12.112，内存五百一十二兆。固件是 SeaBIOS 1.16.3，引导器是 GRUB 2.03，用户空间是 BusyBox 1.37.0，根盘是 ext2。调试器是 GDB 9.2，通过 GDB MI 和 QMP 读取真实状态。画面里的英文组件，我都会用括号给出中文。",
    "上电前": "现在还没有按下电源。CPU 处于复位状态：通用寄存器几乎全是零，RIP 是 FFF0，CS 的选择子是 F000，隐藏基址是 FFFF0000。CR0 是 0x60000010，CR3 和 CR4 都是零，EFER 也是零。内存还没有被固件使用，低地址是 ROM 映射；VGA、串口、键盘和磁盘都还没有初始化。画面里是这一刻的真实寄存器快照。后面只讲新增的变化。",
    "复位": "电源稳定，CPU 从复位状态开始。CS 的选择子是 F000，隐藏基址是 FFFF0000，IP 是 FFF0。两者相加，得到线性地址 FFFFFFF0。此时没有分页，线性地址就是物理地址。CPU 从这里取第一条指令：关中断，然后远跳转进入固件。",
    "固件": "SeaBIOS 做 POST：检查 CPU，初始化内存和 PCI，枚举设备，建立中断向量和 BIOS 数据区。然后按启动顺序读取启动盘的第一个扇区，五百一十二字节，装到 0x7C00，检查末尾的 55 AA，再跳过去。这个扇区就是 MBR，里面是 GRUB 的第一阶段。",
    "引导器": "GRUB 的 MBR 只有四百四十六字节代码。它先加载 stage 一点五，再加载 stage 二，读取文件系统和 grub 配置。配置里的 linux16 命令按十六位协议，把 bzImage 的 setup 放到低内存，把 initramfs 放到内存，并填写 boot_params。然后跳到 setup 的 main。",
    "setup": "setup 还在十六位实模式。它读取 boot_params，整理内存图、命令行和 initrd 地址，建立 GDT，然后把 CR0 的 PE 位置一，进入保护模式，再跳到三十二位入口。注意，这一步还没有分页，段基址仍然参与地址计算。",
    "解压器": "接下来是解压器。startup_32 在 0x100000，先检查 CPU，再建立临时页表。它依次打开 CR4 的 PAE、EFER 的 LME，最后打开 CR0 的 PG，进入长模式。startup_64 在 0x100200 继续执行，解析 bzImage 头，把内核解压到最终位置，再跳到主内核。三个位必须按顺序打开，顺序错了就会崩溃。",
    "内存布局": "进入长模式后，地址分成物理和虚拟两套。物理地址从零开始：最低端是中断向量表和 BIOS 数据区，然后是 MBR、setup，1 MiB 以上是内核、initramfs、页表和 DMA 缓冲。虚拟地址在高半区：direct map 线性映射全部 RAM，vmemmap 描述每一页，内核 text 在 0xffffffff81000000 附近。下面是从 shell 回读的真实低内存，三十二字节一行。",
    "内核": "主内核从 startup_64 进入 x86_64_start_kernel，再到 start_kernel。这里初始化内存管理、调度器、中断控制器、计时器、VFS、proc 和驱动框架。它不是一条指令，而是一棵调用树。本实验停在 start_kernel 的 0xffffffff82056d20。之后 rest_init 创建 kernel_init 线程。",
    "PID 1": "kernel_init 变成 PID 一。它把 initramfs 当作临时根文件系统，执行其中的 /init。init 挂载 devtmpfs、proc、sysfs，然后等待 virtio 磁盘 /dev/vda 出现。PID 一还是同一个 task_struct，但它的用户地址空间来自 initramfs。",
    "virtio": "virtio-blk 通过 PCI 暴露给内核。驱动读 PCI 配置空间，协商 feature，设置 virtqueue。提交读请求时，CPU 填好描述符链和 avail 环，然后 kick 设备。设备用 DMA 读请求、写数据，完成后更新 used 环并拉中断。Linux 在中断里扫描 used 环，唤醒等待的进程。",
    "ext2": "根盘 /dev/vda 上是 ext2。内核读一千零二十四字节处的超级块，校验 magic 0xEF53，读块组描述符和 inode 表。根目录是 inode 二。ext2 驱动按目录项找到 /data/hello.txt，把 inode 读进内存，建立 dentry 和 inode 缓存，挂到 VFS 上。页缓存和磁盘是两个层次。",
    "switch": "initramfs 的 /init 把 /dev、/proc、/sys 移动到新根，调用 switch_root 切换根目录，再执行新根上的 /sbin/init。原来的 initramfs 根被替换，PID 一还是同一个进程，但根目录和用户空间已经换成真实 ext2 盘。",
    "用户空间": "BusyBox init 读 /etc/inittab。tty1 上 askfirst 启动登录 shell，ttyS0 上 respawn 一个串口 shell。getty 打开终端，设置 termios，exec /bin/sh。shell 打印提示符 linux-lab:/root#，然后阻塞在 read 上等待输入。",
    "终端": "按键不是直接变成字符。键盘控制器 i8042 产生扫描码和 IRQ 一。CPU 进入中断，驱动读数据端口，把扫描码送进 input 层，再经过 VT 和 TTY 的行规程，回显到 VGA 或串口。输入回车后，shell 被唤醒，fork 和 exec 执行命令，输出再写回 tty。",
    "全景": "到达 shell 后，再看一次全景。CPU 已经在长模式，CPL 是零，RIP 在高半区，CR3 指向当前进程的页表，CR4 打开了 PAE，EFER 的 LME 和 LMA 都置位。通用寄存器里是当前任务留下的真实值。内存这边，低端保留着中断向量表、MBR、setup 和解压器；高半区是 direct map、vmemmap 和内核 text。很多值从开机到现在没有变，但它们仍然真实存在。",
    "回顾": "回顾这条线：复位取指、SeaBIOS、MBR 和 GRUB、十六位 setup、三十二位和六十四位解压、内存布局、start kernel、PID 一和 initramfs、virtio 和 ext2、switch root、BusyBox shell、TTY 输入输出。以后再单独讲某个组件，就在这条时间线上选一个执行时机，把它切开看。",
}

TERMS = {
    "总览": [("CPU", "中央处理器"), ("QEMU", "机器模拟器"), ("TCG", "软件动态翻译"), ("shell", "命令解释器")],
    "环境": [("QEMU", "模拟器"), ("TCG", "软件模拟加速"), ("SeaBIOS", "固件"), ("GRUB", "引导加载器")],
    "上电前": [("reset", "复位状态"), ("CS", "代码段寄存器"), ("CR0", "控制寄存器 0"), ("RIP", "指令指针")],
    "复位": [("CS", "代码段"), ("IP", "指令指针"), ("linear", "线性地址"), ("real mode", "实模式")],
    "固件": [("POST", "加电自检"), ("MBR", "主引导记录"), ("IVT", "中断向量表"), ("BDA", "BIOS 数据区")],
    "引导器": [("GRUB", "引导器"), ("bzImage", "压缩内核镜像"), ("initramfs", "初始内存文件系统"), ("boot_params", "启动参数")],
    "setup": [("GDT", "全局描述符表"), ("CR0", "控制寄存器"), ("PE", "保护模式使能"), ("boot_params", "启动参数")],
    "解压器": [("PAE", "物理地址扩展"), ("LME", "长模式使能"), ("PG", "分页使能"), ("long mode", "64 位长模式")],
    "内存布局": [("IVT", "中断向量表"), ("BDA", "BIOS 数据区"), ("direct map", "直接映射"), ("vmemmap", "页描述符数组")],
    "内核": [("start_kernel", "内核初始化入口"), ("VFS", "虚拟文件系统"), ("IRQ", "中断请求"), ("rest_init", "创建 PID 1")],
    "PID 1": [("PID 1", "1 号进程"), ("initramfs", "初始内存文件系统"), ("task_struct", "进程描述符"), ("/init", "初始化脚本")],
    "virtio": [("virtio-blk", "虚拟块设备"), ("virtqueue", "虚拟队列"), ("DMA", "直接内存访问"), ("IRQ", "中断请求")],
    "ext2": [("superblock", "超级块"), ("inode", "索引节点"), ("dentry", "目录项"), ("VFS", "虚拟文件系统")],
    "switch": [("switch_root", "切换根目录"), ("initramfs", "临时根"), ("rootfs", "根文件系统"), ("PID 1", "1 号进程")],
    "用户空间": [("inittab", "初始化配置"), ("getty", "登录终端程序"), ("TTY", "终端"), ("ttyS0", "串口终端")],
    "终端": [("i8042", "键盘控制器"), ("IRQ", "中断请求"), ("TTY", "终端"), ("termios", "终端参数")],
    "全景": [("CR3", "页表基址"), ("EFER", "扩展功能寄存器"), ("VMA", "虚拟内存区域"), ("direct map", "直接映射")],
    "回顾": [("L00–L07", "启动课程"), ("frame", "停止帧"), ("QEMU", "模拟器"), ("shell", "命令解释器")],
}

NEW_CONCEPTS = {
    "总览": ["一条主线"],
    "环境": ["QEMU/TCG", "客户机版本"],
    "上电前": ["复位状态", "寄存器快照"],
    "复位": ["复位向量", "CS 隐藏基址"],
    "固件": ["POST", "MBR"],
    "引导器": ["GRUB stage1/2", "linux16"],
    "setup": ["boot_params", "GDT", "保护模式"],
    "解压器": ["PAE", "LME", "PG", "长模式"],
    "内存布局": ["E820", "物理/虚拟地图", "hexdump"],
    "内核": ["start_kernel", "VFS"],
    "PID 1": ["initramfs", "PID 1"],
    "virtio": ["virtqueue", "DMA", "IRQ"],
    "ext2": ["superblock", "inode", "dentry"],
    "switch": ["switch_root"],
    "用户空间": ["inittab", "getty"],
    "终端": ["i8042", "TTY 行规程"],
    "全景": ["终值快照"],
    "回顾": ["时间线"],
}

for _scene in SCENES:
    _tag = _scene["tag"]
    if _tag in NARRATION:
        _scene["narration"] = NARRATION[_tag]
    _scene["terms"] = TERMS.get(_tag, [])
    _scene["newConcepts"] = NEW_CONCEPTS.get(_tag, [])
    _scene["bullets"] = [re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", b) for b in _scene["bullets"]]


# 插入新章节后统一重排 Sxx 前缀，避免手工编号错位。
for _index, _scene in enumerate(SCENES):
    _scene["kicker"] = re.sub(r"^S\d{2}", f"S{_index:02d}", _scene["kicker"])


def ffprobe_duration(path: Path) -> float:
    proc = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", proc.stderr)
    if not m:
        raise RuntimeError(f"无法读取音频时长: {path}\n{proc.stderr[-500:]}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


async def synthesize(text: str, path: Path) -> None:
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
    await communicate.save(str(path))


def prepare_audio(no_tts: bool) -> list[float]:
    AUDIO.mkdir(parents=True, exist_ok=True)
    durations: list[float] = []
    for index, scene in enumerate(SCENES):
        mp3 = AUDIO / f"s{index:02d}.mp3"
        text = scene["narration"]
        if no_tts:
            durations.append(max(10.0, len(text) / 4.8 + 1.2))
            continue
        if not mp3.exists() or mp3.stat().st_size < 2000:
            print(f"[tts] {index:02d} {scene['title']}")
            asyncio.run(synthesize(text, mp3))
        audio_duration = ffprobe_duration(mp3)
        scene["audioDuration"] = audio_duration
        durations.append(round(audio_duration + 0.9, 1))
    return durations


def build_beats(text: str, duration: float) -> list[dict]:
    """把解说按句子切成字幕节拍，时间按字符数分配，与配音大致同步。"""
    pieces = [p for p in re.split(r"(?<=[。！？])", text) if p.strip()]
    if not pieces:
        pieces = [text]
    total_chars = sum(len(p) for p in pieces) or 1
    usable = max(1.0, duration - 0.7)
    cursor = 0.35
    beats = []
    for piece in pieces:
        share = (len(piece) / total_chars) * usable
        beats.append({"t": round(cursor, 3), "text": piece.strip()})
        cursor += share
    return beats


def write_scenes_js(durations: list[float]) -> None:
    payload = []
    for index, scene in enumerate(SCENES):
        item = {k: scene[k] for k in ("tag", "kicker", "title", "caption", "bullets", "facts", "visual", "terms", "newConcepts")}
        item["duration"] = durations[index]
        item["beats"] = build_beats(scene["narration"], durations[index])
        payload.append(item)
    text = "window.SCENES = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    (HERE / "scenes.js").write_text(text, encoding="utf-8")
    print(f"[scenes] {len(payload)} scenes, total {sum(durations):.1f}s")


def compact_audio(durations: list[float], out_path: Path) -> float:
    """每幕音频按固定 duration 放进 WAV，再拼接；片头留 0.25s。"""
    work = HERE / "audio/work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    concat_lines = []
    # 0.25s lead-in
    lead = work / "lead.wav"
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.25",
                    "-c:a", "pcm_s16le", str(lead)], check=True)
    concat_lines.append(f"file '{lead}'")
    for index, duration in enumerate(durations):
        mp3 = AUDIO / f"s{index:02d}.mp3"
        wav = work / f"s{index:02d}.wav"
        if mp3.exists():
            # 音频从 0.35s 开始，剩余时间补静音，确保每幕时长精确
            subprocess.run([
                FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(mp3),
                "-af", f"adelay=350|350,apad=whole_dur={duration}",
                "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(wav),
            ], check=True)
        else:
            subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", str(duration),
                            "-c:a", "pcm_s16le", str(wav)], check=True)
        concat_lines.append(f"file '{wav}'")
    list_file = work / "list.txt"
    list_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "concat", "-safe", "0", "-i", str(list_file),
                    "-c:a", "pcm_s16le", str(out_path)], check=True)
    return ffprobe_duration(out_path)


def record_video(total: float) -> Path:
    workdir = HERE / "out/record"
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium-browser"),
            args=["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
        )
        context = browser.new_context(
            viewport={"width": 2560, "height": 1440},
            record_video_dir=str(workdir),
            record_video_size={"width": 2560, "height": 1440},
        )
        page = context.new_page()
        page.goto((HERE / "index.html").as_uri(), wait_until="load")
        page.wait_for_function("window.__ready === true", timeout=30000)
        page.wait_for_timeout(int((total + 1.4) * 1000))
        context.close()
        browser.close()
    videos = list(workdir.glob("*.webm"))
    if not videos:
        raise RuntimeError("没有生成 WebM 录制文件")
    return videos[0]


def mux(video: Path, audio: Path, total: float) -> None:
    VIDEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    # 视频开头有浏览器页面的预录，裁掉约 0.15s；音频片头 0.25s，二者接近对齐。
    subprocess.run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-ss", "0.15", "-i", str(video),
        "-i", str(audio),
        "-t", f"{total:.2f}",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-r", "25",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        str(VIDEO_OUT),
    ], check=True)
    print(f"[video] {VIDEO_OUT} ({VIDEO_OUT.stat().st_size / 1024 / 1024:.1f} MiB)")


def write_transcript(durations: list[float]) -> None:
    lines = [
        "# 从复位到终端：Linux 6.12.112 启动主线",
        "",
        "> 本视频由项目源码、真实 QEMU 停点和实测符号生成。地址只代表本实验构建。",
        "",
        "| 时间 | 章节 | 标题 |",
        "|---|---|---|",
    ]
    t = 0.0
    for index, scene in enumerate(SCENES):
        start = f"{int(t // 60):02d}:{int(t % 60):02d}"
        lines.append(f"| {start} | S{index:02d} | {scene['title']} |")
        t += durations[index]
    lines += [
        "",
        "## 环境与版本",
        "",
        "- 宿主机：TencentOS Server 3.2，Linux 4.18 x86_64",
        "- 模拟器：QEMU 8.2.10，qemu64 单 vCPU，TCG 软件模拟",
        "- 客户机：Linux 6.12.112-observatory，x86_64，512 MiB RAM",
        "- 固件/引导/用户空间：SeaBIOS 1.16.3、GRUB 2.03、BusyBox 1.37.0",
        "- 根盘：virtio-blk + ext2 96 MiB；调试：GDB 9.2 + GDB/MI + QMP",
        "- 构建：bzImage sha256 1b04ab59d4e5…、rootfs d70ffb6e9a74…、initramfs 16a5305c2d62…、vmlinux Build ID f5e5edc1c572…",
        "",
        "## 逐章讲解",
        "",
    ]
    t = 0.0
    for index, scene in enumerate(SCENES):
        start = f"{int(t // 60):02d}:{int(t % 60):02d}"
        lines += [f"### {start} · S{index:02d} {scene['title']}", "", scene["narration"], ""]
        t += durations[index]
    TRANSCRIPT_OUT.write_text("\n".join(lines), encoding="utf-8")

    cues = []
    t = 0.0
    cue_index = 1
    for index, scene in enumerate(SCENES):
        pieces = [p for p in re.split(r"(?<=[。！？])", scene["narration"]) if p.strip()]
        if not pieces:
            pieces = [scene["narration"]]
        total_chars = sum(len(p) for p in pieces)
        cursor = t
        for piece in pieces:
            share = (len(piece) / total_chars) * (durations[index] - 0.35)
            end = cursor + max(1.2, share)
            def fmt(x: float) -> str:
                h = int(x // 3600); m = int((x % 3600) // 60); s = int(x % 60); ms = int((x % 1) * 1000)
                return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
            cues.append(f"{cue_index}\n{fmt(cursor + 0.35)} --> {fmt(end)}\n{piece.strip()}\n")
            cue_index += 1
            cursor = end
        t += durations[index]
    SRT_OUT.write_text("\n".join(cues), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-tts", action="store_true", help="不生成配音，按文本估时（仅调试画面）")
    parser.add_argument("--skip-record", action="store_true", help="只生成配音、scenes.js、字幕，不录制视频")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    durations = prepare_audio(args.no_tts)
    write_scenes_js(durations)
    total = sum(durations)
    print(f"[total] {total:.1f}s = {total/60:.2f} min")
    write_transcript(durations)

    if args.skip_record:
        return
    audio_path = OUT / "narration.wav"
    audio_total = compact_audio(durations, audio_path)
    print(f"[audio] {audio_total:.2f}s")
    video_path = record_video(total)
    print(f"[record] {video_path} ({video_path.stat().st_size/1024/1024:.1f} MiB)")
    mux(video_path, audio_path, min(total, audio_total))


if __name__ == "__main__":
    main()
