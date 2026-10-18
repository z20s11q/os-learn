window.SCENES = [
  {
    "tag": "总览",
    "kicker": "BOOT / OVERVIEW",
    "title": "从按下电源，到终端提示符",
    "caption": "这条启动路径的采样来源：SeaBIOS → GRUB → Linux 6.12.112 → BusyBox，全部来自 QEMU 中的真实启动。",
    "bullets": [
      "<b>只讲一条线</b>：复位 → 固件 → 引导器 → 内核 → 根盘 → shell。",
      "每个阶段都给出<b>实际停点</b>或<b>真实结构</b>，按实际采样结果呈现教学流程。",
      "后续单独讲某个组件时，可以在这条时间线上选一个切面。"
    ],
    "facts": [
      [
        "内核",
        "6.12.112-observatory",
        true
      ],
      [
        "机器",
        "QEMU pc / qemu64 / TCG",
        false
      ],
      [
        "根盘",
        "virtio-blk ext2",
        false
      ],
      [
        "终点",
        "linux-lab:/root#",
        true
      ]
    ],
    "visual": "\n        <div class=\"intro\">\n          <div class=\"eyebrow anim fade\" style=\"--d:.15s\">REAL BOOT · SINGLE TRACE</div>\n          <div class=\"title anim left\" style=\"--d:.35s\">从按下电源，<br>到 <span>linux-lab:/root#</span></div>\n          <div class=\"sub anim fade\" style=\"--d:.7s\">这条路径的状态采样来自 QEMU 8.2.10 里真实运行的\n            SeaBIOS 1.16.3、GRUB 2.03、Linux 6.12.112 和 BusyBox 1.37.0。</div>\n          <div class=\"row anim fade\" style=\"--d:.9s;margin-top:26px;gap:8px\">\n            <span class=\"pill\">Linux 6.12.112</span><span class=\"pill\">QEMU 8.2.10</span>\n            <span class=\"pill\">x86_64 · TCG</span><span class=\"pill\">512 MiB RAM</span>\n            <span class=\"pill ok\">真实 QEMU 停点</span>\n          </div>\n          <div class=\"intro-line anim fade\" style=\"--d:1.1s\">\n            <div class=\"dot\"></div><div class=\"seg\"></div>\n            <div class=\"label\">RESET → BIOS → GRUB → SETUP → DECOMPRESS → KERNEL → PID 1 → EXT2 → SHELL</div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "CPU",
        "中央处理器"
      ],
      [
        "QEMU",
        "机器模拟器"
      ],
      [
        "TCG",
        "软件动态翻译"
      ],
      [
        "shell",
        "命令解释器"
      ]
    ],
    "newConcepts": [
      "一条主线"
    ],
    "duration": 10.9,
    "beats": [
      {
        "t": 0.35,
        "text": "先别急着看寄存器。"
      },
      {
        "t": 2.15,
        "text": "我们从一台处于断电状态的机器开始，先讲环境和组件，再沿着一条真实启动路径，一直走到终端。"
      }
    ]
  },
  {
    "tag": "环境",
    "kicker": "S01 / ENVIRONMENT",
    "title": "先交代环境：谁在模拟这台机器？",
    "caption": "宿主机 TencentOS 3.2 · QEMU 8.2.10（模拟器）· Linux 6.12.112 · SeaBIOS 1.16.3 · GRUB 2.03 · BusyBox 1.37.0。",
    "bullets": [
      "状态数据来自 <b>QEMU + GDB/MI + QMP</b> 驱动的真实实验。",
      "客户机只有 <b>1 个 vCPU</b>，所有地址和寄存器都来自当前构建。",
      "画面里的英文组件都带中文小括号；右侧术语提供中文解释。"
    ],
    "facts": [
      [
        "QEMU",
        "8.2.10",
        true
      ],
      [
        "内核",
        "6.12.112-observatory",
        true
      ],
      [
        "固件",
        "SeaBIOS 1.16.3",
        false
      ],
      [
        "根盘",
        "ext2 96 MiB",
        false
      ]
    ],
    "visual": "\n        <div class=\"env-grid\">\n          <div class=\"env-col\">\n            <div class=\"pill hi anim fade\" style=\"--d:.15s\">HOST / 宿主机</div>\n            <div class=\"env-row\"><span>操作系统</span><b class=\"\">TencentOS Server 3.2</b></div><div class=\"env-row\"><span>宿主内核</span><b class=\"\">Linux 4.18 x86_64</b></div><div class=\"env-row\"><span>模拟器 QEMU</span><b class=\"hi\">8.2.10（机器模拟器）</b></div><div class=\"env-row\"><span>加速方式</span><b class=\"hi\">TCG（软件动态翻译）</b></div><div class=\"env-row\"><span>调试器 GDB</span><b class=\"\">9.2 + GDB/MI</b></div><div class=\"env-row\"><span>控制通道</span><b class=\"\">QMP（QEMU 管理协议）</b></div>\n          </div>\n          <div class=\"env-col\">\n            <div class=\"pill hi anim fade\" style=\"--d:.3s\">GUEST / 客户机</div>\n            <div class=\"env-row\"><span>内核</span><b class=\"hi\">6.12.112-observatory</b></div><div class=\"env-row\"><span>架构</span><b class=\"\">x86_64 · 1 vCPU · qemu64</b></div><div class=\"env-row\"><span>内存</span><b class=\"hi\">512 MiB</b></div><div class=\"env-row\"><span>固件</span><b class=\"hi\">SeaBIOS 1.16.3</b></div><div class=\"env-row\"><span>引导器</span><b class=\"\">GRUB 2.03（BIOS 模式）</b></div><div class=\"env-row\"><span>用户空间</span><b class=\"\">BusyBox 1.37.0</b></div>\n          </div>\n          <div class=\"env-col\">\n            <div class=\"pill hi anim fade\" style=\"--d:.45s\">DEVICES / 设备</div>\n            <div class=\"env-row\"><span>根盘</span><b class=\"hi\">virtio-blk（虚拟块设备）</b></div><div class=\"env-row\"><span>文件系统</span><b class=\"\">ext2（无日志）</b></div><div class=\"env-row\"><span>显示</span><b class=\"\">VGA（文本模式 80×25）</b></div><div class=\"env-row\"><span>串口</span><b class=\"\">16550A UART（COM1）</b></div><div class=\"env-row\"><span>键盘</span><b class=\"\">PS/2（i8042 控制器）</b></div><div class=\"env-row\"><span>时钟/中断</span><b class=\"\">PIT · PIC · IOAPIC</b></div>\n          </div>\n        </div>\n        <div class=\"env-topo anim fade\" style=\"--d:.65s\">\n          <div class=\"env-topo-label\">MACHINE TOPOLOGY / 机器拓扑（本实验）</div>\n          <div class=\"topo-row\">\n            <div class=\"topo-box hot\">CPU<span>qemu64 · 1 vCPU</span></div>\n            <div class=\"topo-link\">系统总线</div>\n            <div class=\"topo-box\">RAM<span>512 MiB</span></div>\n            <div class=\"topo-link\">PCI</div>\n            <div class=\"topo-box\">virtio-blk<span>根盘 ext2</span></div>\n            <div class=\"topo-box\">VGA<span>文本 80×25</span></div>\n            <div class=\"topo-box\">UART<span>COM1 / ttyS0</span></div>\n            <div class=\"topo-box\">i8042<span>PS/2 键盘</span></div>\n          </div>\n        </div>\n        <div class=\"env-foot anim fade\" style=\"--d:.7s\">\n          <span class=\"pill\">bzImage sha256 1b04ab59d4e5…</span>\n          <span class=\"pill\">rootfs sha256 d70ffb6e9a74…</span>\n          <span class=\"pill\">initramfs sha256 16a5305c2d62…</span>\n          <span class=\"pill ok\">vmlinux Build ID f5e5edc1c572…</span>\n        </div>\n        ",
    "terms": [
      [
        "QEMU",
        "模拟器"
      ],
      [
        "TCG",
        "软件模拟加速"
      ],
      [
        "SeaBIOS",
        "固件"
      ],
      [
        "GRUB",
        "引导加载器"
      ]
    ],
    "newConcepts": [
      "QEMU/TCG",
      "客户机版本"
    ],
    "duration": 39.2,
    "beats": [
      {
        "t": 0.35,
        "text": "先交代环境。"
      },
      {
        "t": 1.391,
        "text": "宿主机是 TencentOS Server 3.2。"
      },
      {
        "t": 5.9,
        "text": "模拟器是 QEMU 8.2.10，单核 qemu64，使用 TCG 软件模拟。"
      },
      {
        "t": 12.663,
        "text": "客户机内核是 Linux 6.12.112，内存五百一十二兆。"
      },
      {
        "t": 18.039,
        "text": "固件是 SeaBIOS 1.16.3，引导器是 GRUB 2.03，用户空间是 BusyBox 1.37.0，根盘是 ext2。"
      },
      {
        "t": 29.138,
        "text": "调试器是 GDB 9.2，通过 GDB MI 和 QMP 读取真实状态。"
      },
      {
        "t": 35.382,
        "text": "画面里的英文组件，我都会用括号给出中文。"
      }
    ]
  },
  {
    "tag": "上电前",
    "kicker": "S02 / BEFORE POWER",
    "title": "上电前：所有组件与 CPU 初始状态",
    "caption": "复位状态：RIP=0xfff0，CS.base=0xffff0000，CR0=0x60000010，CR3=CR4=EFER=0；RAM、VGA、串口、键盘、磁盘都未初始化。",
    "bullets": [
      "复位后由 CS 隐藏基址和 IP 确定取指地址，第一条指令落在 ROM。",
      "RAM 工作内容等待初始化；中断向量表和 BIOS 数据区由固件后续建立。",
      "从下一幕起，每幕只讲<b>新增机制</b>，已讲过的只做引用。"
    ],
    "facts": [
      [
        "RIP",
        "0xfff0",
        true
      ],
      [
        "CS.base",
        "0xffff0000",
        true
      ],
      [
        "CR0",
        "0x60000010",
        true
      ],
      [
        "CR3 / CR4",
        "0x0 / 0x0",
        false
      ]
    ],
    "visual": "\n        <div class=\"init-grid\">\n          <div class=\"stack\">\n            <div class=\"pill warn anim fade\" style=\"--d:.1s\">POWER OFF / 复位状态 · 真实快照 frame 0</div>\n            <div class=\"component-list\">\n              <div class=\"comp-row anim left\" style=\"--d:.25s\"><span class=\"led off\"></span><b>CPU（中央处理器）</b><span>复位 · 16 位实模式</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.35s\"><span class=\"led off\"></span><b>RAM（随机存取存储器）</b><span>未初始化</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.45s\"><span class=\"led on\"></span><b>ROM（只读存储器）</b><span>复位向量可读</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.55s\"><span class=\"led off\"></span><b>SeaBIOS（固件）</b><span>尚未执行</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.65s\"><span class=\"led off\"></span><b>VGA（显卡文本模式）</b><span>未初始化</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.75s\"><span class=\"led off\"></span><b>UART（串口）</b><span>未配置</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.85s\"><span class=\"led off\"></span><b>i8042（键盘控制器）</b><span>未初始化</span></div>\n              <div class=\"comp-row anim left\" style=\"--d:.95s\"><span class=\"led off\"></span><b>virtio-blk（虚拟块设备）</b><span>未枚举</span></div>\n            </div>\n            <div class=\"term anim fade\" style=\"--d:1.05s\">物理低端：ROM 映射 / 无有效 IVT\n虚拟地址：分页关闭，等于物理地址\n中断：关闭（RFLAGS.IF=0）</div>\n          </div>\n          <div class=\"anim right\" style=\"--d:.35s\">\n            \n      <div class=\"cpu-pano \">\n        <div class=\"pano-head\"><span class=\"pill hi\">real-16 · CPL 0</span><span class=\"mono\">RIP 0xfff0 · RSP 0x0</span></div>\n        <div class=\"pano-title\">通用寄存器（general registers）</div>\n        <div class=\"reg-grid\" style=\"grid-template-columns:repeat(4,1fr)\"><div class=\"reg-cell\"><span>RAX</span><b>0x0</b></div><div class=\"reg-cell\"><span>RBX</span><b>0x0</b></div><div class=\"reg-cell\"><span>RCX</span><b>0x0</b></div><div class=\"reg-cell\"><span>RDX</span><b>0x60fb1</b></div><div class=\"reg-cell\"><span>RSI</span><b>0x0</b></div><div class=\"reg-cell\"><span>RDI</span><b>0x0</b></div><div class=\"reg-cell\"><span>RBP</span><b>0x0</b></div><div class=\"reg-cell\"><span>RSP</span><b>0x0</b></div><div class=\"reg-cell\"><span>R8</span><b>0x0</b></div><div class=\"reg-cell\"><span>R9</span><b>0x0</b></div><div class=\"reg-cell\"><span>R10</span><b>0x0</b></div><div class=\"reg-cell\"><span>R11</span><b>0x0</b></div><div class=\"reg-cell\"><span>R12</span><b>0x0</b></div><div class=\"reg-cell\"><span>R13</span><b>0x0</b></div><div class=\"reg-cell\"><span>R14</span><b>0x0</b></div><div class=\"reg-cell\"><span>R15</span><b>0x0</b></div></div>\n        <div class=\"pano-title\">控制寄存器（control registers）与标志</div>\n        <div class=\"ctl-grid\"><div class=\"ctl-cell\"><span>CR0</span><b>0x60000010</b></div><div class=\"ctl-cell\"><span>CR2</span><b>0x0</b></div><div class=\"ctl-cell\"><span>CR3</span><b>0x0</b></div><div class=\"ctl-cell\"><span>CR4</span><b>0x0</b></div><div class=\"ctl-cell\"><span>CR8</span><b>0x0</b></div><div class=\"ctl-cell\"><span>EFER</span><b>0x0</b></div><div class=\"ctl-cell\"><span>RFLAGS</span><b>0x2</b></div></div>\n        <div class=\"pano-title\">段寄存器（segment registers）</div>\n        <div class=\"seg-table\"><div class=\"seg-row head\"><b>段</b><span>selector</span><span>base</span><span>limit</span></div><div class=\"seg-row\"><b>CS</b><span>0xf000</span><span>0xffff0000</span><span>0xffff</span></div><div class=\"seg-row\"><b>SS</b><span>0x0</span><span>0x0</span><span>0xffff</span></div><div class=\"seg-row\"><b>DS</b><span>0x0</span><span>0x0</span><span>0xffff</span></div><div class=\"seg-row\"><b>ES</b><span>0x0</span><span>0x0</span><span>0xffff</span></div><div class=\"seg-row\"><b>FS</b><span>0x0</span><span>0x0</span><span>0xffff</span></div><div class=\"seg-row\"><b>GS</b><span>0x0</span><span>0x0</span><span>0xffff</span></div><div class=\"seg-row\"><b>TR</b><span>0x0</span><span>0x0</span><span>0xffff</span></div><div class=\"seg-row\"><b>LDTR</b><span>0x0</span><span>0x0</span><span>0xffff</span></div></div>\n      </div>\n    \n          </div>\n        </div>\n        ",
    "terms": [
      [
        "reset",
        "复位状态"
      ],
      [
        "CS",
        "代码段寄存器"
      ],
      [
        "CR0",
        "控制寄存器 0"
      ],
      [
        "RIP",
        "指令指针"
      ]
    ],
    "newConcepts": [
      "复位状态",
      "寄存器快照"
    ],
    "duration": 36.4,
    "beats": [
      {
        "t": 0.35,
        "text": "现在展示 QEMU 已完成 CPU 复位、固件等待执行的初始停点。"
      },
      {
        "t": 2.322,
        "text": "CPU 处于复位状态：通用寄存器几乎全是零，RIP 是 FFF0，CS 的选择子是 F000，隐藏基址是 FFFF0000。"
      },
      {
        "t": 14.551,
        "text": "CR0 是 0x60000010，CR3 和 CR4 都是零，EFER 也是零。"
      },
      {
        "t": 22.441,
        "text": "固件映像已由 QEMU 映射到 ROM 区域，RAM 工作数据和各设备等待固件初始化。"
      },
      {
        "t": 30.922,
        "text": "画面里是这一刻的真实寄存器快照。"
      },
      {
        "t": 34.078,
        "text": "后面只讲新增的变化。"
      }
    ]
  },
  {
    "tag": "复位",
    "kicker": "S03 / CPU RESET",
    "title": "第一条指令从哪里取？",
    "caption": "CS 隐藏基址是 0xffff0000，IP 是 0xfff0；线性地址 = 0xffff0000 + 0xfff0 = 0xfffffff0。",
    "bullets": [
      "<b>复位向量</b>由 CS 的隐藏基址加 IP 得到。",
      "第一条指令在 <span class='mono'>0xfffffff0</span>，物理取指在 <span class='mono'>0xffff0</span>。",
      "此时 CR0.PG=0、CR0.PE=0，执行环境是 16 位实模式。"
    ],
    "facts": [
      [
        "CS.base",
        "0xffff0000",
        true
      ],
      [
        "IP",
        "0xfff0",
        false
      ],
      [
        "linear",
        "0xfffffff0",
        true
      ],
      [
        "first bytes",
        "fa 5b e0 00 f0",
        false
      ]
    ],
    "visual": "\n        <div class=\"reset\">\n          <div class=\"cpu anim pop\" style=\"--d:.15s\">\n            <div class=\"pins\"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>\n            <div class=\"cpu-core\"><div class=\"name\">CPU</div><div class=\"sub\">reset · 16-bit real mode</div></div>\n          </div>\n          <div class=\"addr-bus\">\n            <div class=\"bus-label anim fade\" style=\"--d:.4s\">地址总线 / 取指</div>\n            <div class=\"bus-line anim fade\" style=\"--d:.55s\"></div>\n            <div class=\"node accent anim pop\" style=\"--d:.8s\">\n              <div class=\"n-title\">LINEAR ADDRESS</div>\n              <div class=\"n-value\">0xfffffff0</div>\n              <div class=\"n-sub\">CS.base + IP = 0xffff0000 + 0xfff0</div>\n            </div>\n            <div class=\"node warn anim pop\" style=\"--d:1.1s\">\n              <div class=\"n-title\">PHYSICAL FETCH</div>\n              <div class=\"n-value\">0xffff0</div>\n              <div class=\"n-sub\">无分页：线性地址直接落到物理地址</div>\n            </div>\n            <div class=\"bus-line anim fade\" style=\"--d:1.35s\"></div>\n          </div>\n          <div class=\"stack\">\n            <div class=\"reg anim right\" style=\"--d:.45s\"><span>CS.selector</span><b>0xf000</b></div>\n            <div class=\"reg anim right\" style=\"--d:.6s\"><span>CS.base</span><b>0xffff0000</b></div>\n            <div class=\"reg anim right\" style=\"--d:.75s\"><span>IP</span><b>0xfff0</b></div>\n            <div class=\"reg hot anim right\" style=\"--d:1s\"><span>linear PC</span><b>0xfffffff0</b></div>\n            <div class=\"rom-card anim fade\" style=\"--d:1.25s\">\n              <div class=\"pill warn\">ROM 映射</div>\n              <div class=\"bytes\">fa 5b e0 00 f0</div>\n              <div class=\"line\">第一条指令：cli；随后远跳转进入 SeaBIOS。<br>此时栈和 RAM 还不可依赖。</div>\n            </div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "CS",
        "代码段"
      ],
      [
        "IP",
        "指令指针"
      ],
      [
        "linear",
        "线性地址"
      ],
      [
        "real mode",
        "实模式"
      ]
    ],
    "newConcepts": [
      "复位向量",
      "CS 隐藏基址"
    ],
    "duration": 26.8,
    "beats": [
      {
        "t": 0.35,
        "text": "电源稳定，CPU 从复位状态开始。"
      },
      {
        "t": 3.957,
        "text": "CS 的选择子是 F000，隐藏基址是 FFFF0000，IP 是 FFF0。"
      },
      {
        "t": 12.233,
        "text": "两者相加，得到线性地址 FFFFFFF0。"
      },
      {
        "t": 16.689,
        "text": "此时CR0.PG=0，线性地址直接对应物理地址。"
      },
      {
        "t": 20.509,
        "text": "CPU 从这里取第一条指令：关中断，然后远跳转进入固件。"
      }
    ]
  },
  {
    "tag": "固件",
    "kicker": "S04 / SEABIOS",
    "title": "SeaBIOS：把机器点亮，再把启动盘读进来",
    "caption": "POST 检查 CPU/内存/PCI，随后 INT 19h 读取启动盘第一个 512 字节扇区到 0x7c00。",
    "bullets": [
      "POST 结束后，低内存已经有了 BIOS 数据区和中断向量。",
      "启动盘由 <b>IDE/ATAPI</b> 提供；本实验使用 <span class='mono'>boot.iso</span>。",
      "MBR 只有 512 字节：446 字节代码 + 分区表 + <span class='mono'>0x55aa</span>。"
    ],
    "facts": [
      [
        "MBR load",
        "0x7c00",
        true
      ],
      [
        "sector",
        "512 B",
        false
      ],
      [
        "magic",
        "0x55aa",
        true
      ],
      [
        "next",
        "GRUB stage1",
        false
      ]
    ],
    "visual": "\n        <div class=\"post-grid\">\n          <div class=\"stack\">\n            <div class=\"pill ok anim fade\" style=\"--d:.1s\">POST · POWER ON SELF TEST</div>\n            <div class=\"checklist\">\n              <div class=\"check anim left\" style=\"--d:.25s\"><span class=\"mark\">✓</span>CPU / 异常向量</div>\n              <div class=\"check anim left\" style=\"--d:.4s\"><span class=\"mark\">✓</span>内存探测 / DRAM 初始化</div>\n              <div class=\"check anim left\" style=\"--d:.55s\"><span class=\"mark\">✓</span>PCI 总线 / 设备枚举</div>\n              <div class=\"check anim left\" style=\"--d:.7s\"><span class=\"mark\">✓</span>键盘、串口、VGA、磁盘</div>\n              <div class=\"check anim left\" style=\"--d:.85s\"><span class=\"mark\">✓</span>INT 13h / INT 19h</div>\n            </div>\n            <div class=\"code anim fade\" style=\"--d:1.05s\"><span class=\"c\">; INT 19h：固件按启动顺序读盘</span>\n读 LBA 0 → 0x7c00（512 B）\n检查 0x7dfe == 55 aa\njmp 0x0000:0x7c00</div>\n          </div>\n          <div class=\"mbr\">\n            <div class=\"disk anim pop\" style=\"--d:.4s\"></div>\n            <div class=\"sector anim fade\" style=\"--d:.7s\">启动盘 LBA 0 → <b>0x7c00</b></div>\n            <div class=\"sector-bar anim fade\" style=\"--d:.9s\">\n              <div class=\"s1\">boot code</div><div class=\"s2\">table</div><div class=\"s3\">55 aa</div>\n            </div>\n            <div class=\"stack\" style=\"margin-top:18px\">\n              <div class=\"pill hi anim fade\" style=\"--d:1.1s\">CPU 跳到 0x7c00</div>\n              <div class=\"term anim fade\" style=\"--d:1.3s\">0x7c00: <span class=\"c\">MBR / GRUB stage1</span>\n0x7dfe: 55 aa</div>\n            </div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "POST",
        "加电自检"
      ],
      [
        "MBR",
        "主引导记录"
      ],
      [
        "IVT",
        "中断向量表"
      ],
      [
        "BDA",
        "BIOS 数据区"
      ]
    ],
    "newConcepts": [
      "POST",
      "MBR"
    ],
    "duration": 25.4,
    "beats": [
      {
        "t": 0.35,
        "text": "SeaBIOS 做 POST：检查 CPU，初始化内存和 PCI，枚举设备，建立中断向量和 BIOS 数据区。"
      },
      {
        "t": 10.413,
        "text": "然后按启动顺序读取启动盘的第一个扇区，五百一十二字节，装到 0x7C00，检查末尾的 55 AA，再跳过去。"
      },
      {
        "t": 20.293,
        "text": "这个扇区就是 MBR，里面是 GRUB 的第一阶段。"
      }
    ]
  },
  {
    "tag": "引导器",
    "kicker": "S05 / GRUB",
    "title": "GRUB：读文件系统，装载 bzImage 和 initramfs",
    "caption": "MBR 只有 446 字节，GRUB 用 stage1.5/stage2 找到 grub.cfg，再按 linux16 协议装载。",
    "bullets": [
      "MBR 装载后续引导阶段，stage1.5 提供 ext2/ISO9660 等文件系统驱动。",
      "<span class='mono'>linux16</span> 走传统 16 位引导协议；<span class='mono'>linux</span> 走 32 位协议。",
      "GRUB 负责准备 <b>boot_params</b>、命令行、initrd 地址，然后交接给 setup。"
    ],
    "facts": [
      [
        "stage1",
        "MBR 446 B",
        false
      ],
      [
        "config",
        "grub.cfg",
        false
      ],
      [
        "setup main",
        "0x11171",
        true
      ],
      [
        "handoff",
        "linux16",
        true
      ]
    ],
    "visual": "\n        <div class=\"stack\" style=\"height:100%; justify-content:center\">\n          <div class=\"grid3\">\n            <div class=\"node anim pop\" style=\"--d:.15s\"><div class=\"n-title\">STAGE 1</div><div class=\"n-value\">MBR</div><div class=\"n-sub\">446 B code · 0x7c00</div></div>\n            <div class=\"node anim pop\" style=\"--d:.35s\"><div class=\"n-title\">STAGE 1.5</div><div class=\"n-value\">FS driver</div><div class=\"n-sub\">读 ISO9660 / ext2</div></div>\n            <div class=\"node anim pop\" style=\"--d:.55s\"><div class=\"n-title\">STAGE 2</div><div class=\"n-value\">GRUB core</div><div class=\"n-sub\">命令、菜单、loader</div></div>\n          </div>\n          <div class=\"flow anim fade\" style=\"--d:.8s\">\n            <div class=\"node\"><div class=\"n-title\">grub.cfg</div><div class=\"n-value\">linux16</div><div class=\"n-sub\">/boot/bzImage</div></div>\n            <div class=\"arrow\"></div>\n            <div class=\"node accent\"><div class=\"n-title\">LOAD</div><div class=\"n-value\">setup + initrd</div><div class=\"n-sub\">低内存 / boot_params</div></div>\n            <div class=\"arrow\"></div>\n            <div class=\"node ok\"><div class=\"n-title\">JUMP</div><div class=\"n-value\">setup main</div><div class=\"n-sub\">实测 0x11171</div></div>\n          </div>\n          <div class=\"code anim fade\" style=\"--d:1.05s\"><span class=\"c\"># /boot/grub/grub.cfg</span>\nmenuentry 'Linux Observatory' {\n  <span class=\"k\">linux16</span> /boot/bzImage nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init\n  <span class=\"k\">initrd16</span> /boot/initramfs.cpio.gz\n}</div>\n        </div>\n        ",
    "terms": [
      [
        "GRUB",
        "引导器"
      ],
      [
        "bzImage",
        "压缩内核镜像"
      ],
      [
        "initramfs",
        "初始内存文件系统"
      ],
      [
        "boot_params",
        "启动参数"
      ]
    ],
    "newConcepts": [
      "GRUB stage1/2",
      "linux16"
    ],
    "duration": 24.0,
    "beats": [
      {
        "t": 0.35,
        "text": "GRUB 的 MBR 只有四百四十六字节代码。"
      },
      {
        "t": 3.638,
        "text": "它先加载 stage 一点五，再加载 stage 二，读取文件系统和 grub 配置。"
      },
      {
        "t": 9.784,
        "text": "配置里的 linux16 命令按十六位协议，把 bzImage 的 setup 放到低内存，把 initramfs 放到内存，并填写 boot_params。"
      },
      {
        "t": 21.077,
        "text": "然后跳到 setup 的 main。"
      }
    ]
  },
  {
    "tag": "setup",
    "kicker": "S06 / LINUX SETUP",
    "title": "16 位 setup：整理 boot_params，打开保护模式",
    "caption": "setup 仍在实模式：读内存图、命令行、initrd，建立 GDT，置 CR0.PE，再跳到 32 位入口。",
    "bullets": [
      "<b>boot_params</b> 是 GRUB 与内核之间的交接结构，里面是内存图和启动参数。",
      "<b>CR0.PE</b> 只打开保护模式；分页要等 CR0.PG。",
      "setup 使用 16 位入口，按对应的 setup 可执行体和实测装载地址解释符号。"
    ],
    "facts": [
      [
        "mode",
        "real-16",
        false
      ],
      [
        "CR0.PE",
        "0 → 1",
        true
      ],
      [
        "next",
        "startup_32",
        true
      ],
      [
        "paging",
        "off",
        false
      ]
    ],
    "visual": "\n        <div class=\"setup-grid\">\n          <div class=\"stack\">\n            <div class=\"node anim left\" style=\"--d:.15s\"><div class=\"n-title\">BOOT_PARAMS</div><div class=\"n-value\">low memory</div><div class=\"n-sub\">memory map · cmdline · initrd · e820</div></div>\n            <div class=\"stack anim fade\" style=\"--d:.4s\">\n              <div class=\"reg\"><span>code32_start</span><b>0x100000</b></div>\n              <div class=\"reg\"><span>initrd_addr_max</span><b>0x37ffffff</b></div>\n              <div class=\"reg\"><span>e820_entries</span><b>6</b></div>\n            </div>\n            <div class=\"pill warn anim fade\" style=\"--d:.65s\">实模式 · 段基址仍参与寻址</div>\n            <div class=\"term anim fade\" style=\"--d:.85s\">setup main @ <span class=\"ok\">0x11171</span>\n构建 GDT · 整理 boot_params</div>\n          </div>\n          <div class=\"stack\">\n            <div class=\"gdt anim right\" style=\"--d:.35s\">\n              <div class=\"g-row\"><span>#</span><span>描述符</span><span>用途</span></div>\n              <div class=\"g-row\"><b>0</b><span>null</span><span>空描述符</span></div>\n              <div class=\"g-row\"><b>1</b><span>code32</span><span>0x00000000 / 4G</span></div>\n              <div class=\"g-row\"><b>2</b><span>data32</span><span>0x00000000 / 4G</span></div>\n            </div>\n            <div class=\"pill anim fade\" style=\"--d:.7s\">CR0</div>\n            <div class=\"cr0 anim fade\" style=\"--d:.8s\">\n              <div class=\"bit hot\"><b>1</b><span>PE</span></div>\n              <div class=\"bit\"><b>0</b><span>PG</span></div>\n            </div>\n            <div class=\"vline anim fade\" style=\"--d:1.05s\"></div>\n            <div class=\"node ok anim pop\" style=\"--d:1.15s\"><div class=\"n-title\">JMP</div><div class=\"n-value\">startup_32</div><div class=\"n-sub\">进入 32 位保护模式</div></div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "GDT",
        "全局描述符表"
      ],
      [
        "CR0",
        "控制寄存器"
      ],
      [
        "PE",
        "保护模式使能"
      ],
      [
        "boot_params",
        "启动参数"
      ]
    ],
    "newConcepts": [
      "boot_params",
      "GDT",
      "保护模式"
    ],
    "duration": 21.2,
    "beats": [
      {
        "t": 0.35,
        "text": "setup 还在十六位实模式。"
      },
      {
        "t": 2.978,
        "text": "它读取 boot_params，整理内存图、命令行和 initrd 地址，建立 GDT，然后把 CR0 的 PE 位置一，进入保护模式，再跳到三十二位入口。"
      },
      {
        "t": 16.645,
        "text": "注意，这一步CR0.PG=0，段基址仍然参与地址计算。"
      }
    ]
  },
  {
    "tag": "解压器",
    "kicker": "S07 / DECOMPRESSOR",
    "title": "从 32 位到长模式，把内核解压到最终位置",
    "caption": "startup_32 建临时页表，置 CR4.PAE、EFER.LME、CR0.PG；startup_64 进入长模式并解压内核。",
    "bullets": [
      "32 位解压器和主内核里都有 <span class='mono'>startup_64</span>；必须按模块区分。",
      "PAE、LME、PG 是三个不同的位，必须按顺序打开。",
      "内核运行地址由解压结果、实测装载基址和重定位共同确定。"
    ],
    "facts": [
      [
        "startup_32",
        "0x100000",
        true
      ],
      [
        "startup_64",
        "0x100200",
        true
      ],
      [
        "mode",
        "long-64",
        false
      ],
      [
        "extract",
        "bzImage → RAM",
        false
      ]
    ],
    "visual": "\n        <div class=\"pipe\">\n          <div class=\"pipe-list\">\n            <div class=\"step anim left\" style=\"--d:.15s\"><span class=\"num\">01</span><div><b>startup_32</b><div class=\"sub\">0x100000 · verify_cpu</div></div></div>\n            <div class=\"step anim left\" style=\"--d:.3s\"><span class=\"num\">02</span><div><b>临时页表</b><div class=\"sub\">建立恒等映射 / 高地址映射</div></div></div>\n            <div class=\"step anim left\" style=\"--d:.45s\"><span class=\"num\">03</span><div><b>CR4.PAE</b><div class=\"sub\">开启物理地址扩展</div></div></div>\n            <div class=\"step anim left\" style=\"--d:.6s\"><span class=\"num\">04</span><div><b>EFER.LME</b><div class=\"sub\">允许长模式</div></div></div>\n            <div class=\"step anim left\" style=\"--d:.75s\"><span class=\"num\">05</span><div><b>CR0.PG</b><div class=\"sub\">分页真正生效，进入 long-64</div></div></div>\n          </div>\n          <div class=\"pages\">\n            <div class=\"pill hi anim fade\" style=\"--d:.4s\">PAGE WALK · 4 LEVELS</div>\n            <div class=\"level anim fade\" style=\"--d:.55s\"><div class=\"name\">PML4</div><div class=\"cells\"><i></i><i></i><i></i><i class=\"hit\"></i><i></i><i></i><i></i><i></i></div></div>\n            <div class=\"level anim fade\" style=\"--d:.65s\"><div class=\"name\">PDPT</div><div class=\"cells\"><i></i><i></i><i class=\"hit\"></i><i></i><i></i><i></i><i></i><i></i></div></div>\n            <div class=\"level anim fade\" style=\"--d:.75s\"><div class=\"name\">PD</div><div class=\"cells\"><i></i><i></i><i></i><i></i><i class=\"hit\"></i><i></i><i></i><i></i></div></div>\n            <div class=\"level anim fade\" style=\"--d:.85s\"><div class=\"name\">PT</div><div class=\"cells\"><i class=\"hit\"></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>\n            <div class=\"node accent anim pop\" style=\"--d:1.05s\"><div class=\"n-title\">EXTRACT</div><div class=\"n-value\">compressed → vmlinux</div><div class=\"n-sub\">解压到最终物理地址，跳到主内核</div></div>\n            <div class=\"row\" style=\"justify-content:center\"><span class=\"pill ok\">CR0.PG=1</span><span class=\"pill ok\">EFER.LMA=1</span><span class=\"pill ok\">CPL=0</span></div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "PAE",
        "物理地址扩展"
      ],
      [
        "LME",
        "长模式使能"
      ],
      [
        "PG",
        "分页使能"
      ],
      [
        "long mode",
        "64 位长模式"
      ]
    ],
    "newConcepts": [
      "PAE",
      "LME",
      "PG",
      "长模式"
    ],
    "duration": 31.2,
    "beats": [
      {
        "t": 0.35,
        "text": "接下来是解压器。"
      },
      {
        "t": 1.777,
        "text": "startup_32 在 0x100000，先检查 CPU，再建立临时页表。"
      },
      {
        "t": 8.555,
        "text": "它依次打开 CR4 的 PAE、EFER 的 LME，最后打开 CR0 的 PG，进入长模式。"
      },
      {
        "t": 16.938,
        "text": "startup_64 在 0x100200 继续执行，解析 bzImage 头，把内核解压到最终位置，再跳到主内核。"
      },
      {
        "t": 27.283,
        "text": "三个位必须按顺序打开，顺序错了就会崩溃。"
      }
    ]
  },
  {
    "tag": "内存布局",
    "kicker": "S08 / MEMORY PANORAMA",
    "title": "物理与虚拟：完整布局 + 真实低内存",
    "caption": "物理 0–512 MiB：IVT/BDA、MBR、setup、VGA/ROM 洞、内核/initramfs；高半区：direct map、vmemmap、vmalloc、kernel text。下方 32 字节一行。",
    "bullets": [
      "物理低端按用途分区：IVT、BDA、VGA 和 ROM 映射分别占用对应地址。",
      "direct map 通过虚拟地址映射同一批物理页。",
      "十六进制按 32 字节一行，右侧 ASCII 只用于辅助识别。"
    ],
    "facts": [
      [
        "RAM",
        "512 MiB",
        false
      ],
      [
        "hexdump",
        "32 B / row",
        true
      ],
      [
        "IVT / BDA",
        "0x0 / 0x400",
        true
      ],
      [
        "快照",
        "shell frame 5",
        false
      ]
    ],
    "visual": "\n        <div class=\"mem-pano\">\n          <div class=\"mem-top\">\n            <div class=\"map-col\">\n              <div class=\"pill warn anim fade\" style=\"--d:.1s\">PHYSICAL / 物理地址 · 0–512 MiB</div>\n              <div class=\"mem-stack\">\n                <div class=\"mem-seg low anim left\" style=\"--d:.2s\"><b>0x00000000 – 0x000003ff</b><span>IVT（中断向量表）· 256 个向量</span></div>\n                <div class=\"mem-seg low anim left\" style=\"--d:.3s\"><b>0x00000400 – 0x000004ff</b><span>BDA（BIOS 数据区）· 256 B</span></div>\n                <div class=\"mem-seg low anim left\" style=\"--d:.4s\"><b>0x00000500 – 0x00007bff</b><span>常规内存 / EBDA（扩展 BIOS 数据区）</span></div>\n                <div class=\"mem-seg kern anim left\" style=\"--d:.5s\"><b>0x00007c00 – 0x00007dff</b><span>MBR（主引导记录）/ GRUB stage1 · 512 B</span></div>\n                <div class=\"mem-seg kern anim left\" style=\"--d:.6s\"><b>0x00010000 – 0x0009ffff</b><span>setup（16 位引导代码）· 低内存</span></div>\n                <div class=\"mem-seg hole anim left\" style=\"--d:.7s\"><b>0x000a0000 – 0x000fffff</b><span>VGA 显存 / ROM 映射 · 不是普通 RAM</span></div>\n                <div class=\"mem-seg free anim left\" style=\"--d:.8s\"><b>0x00100000 – 0x1fffffff</b><span>解压器 · 内核 · initramfs · 页表 · DMA / 可用 RAM</span></div>\n              </div>\n            </div>\n            <div class=\"map-col\">\n              <div class=\"pill hi anim fade\" style=\"--d:.15s\">VIRTUAL / 虚拟地址 · 4-level · KASLR off</div>\n              <div class=\"mem-stack\">\n                <div class=\"mem-seg text anim right\" style=\"--d:.25s\"><b>0xffffffff81000000</b><span>kernel text（内核代码段）· start_kernel 等</span></div>\n                <div class=\"mem-seg direct anim right\" style=\"--d:.35s\"><b>0xffff888000000000</b><span>direct map（直接映射）· 全部 RAM</span></div>\n                <div class=\"mem-seg vmem anim right\" style=\"--d:.45s\"><b>0xffffea0000000000</b><span>vmemmap（页描述符数组）· struct page</span></div>\n                <div class=\"mem-seg vmalloc anim right\" style=\"--d:.55s\"><b>0xffffc90000000000</b><span>vmalloc（动态虚拟内存）· 模块 / 栈</span></div>\n                <div class=\"mem-seg anim right\" style=\"--d:.65s\"><b>0xffffffffa0000000</b><span>modules（内核模块）· 可选区域</span></div>\n                <div class=\"mem-seg anim right\" style=\"--d:.75s\"><b>0xfffffe0000000000</b><span>CPU entry area（异常/中断入口）</span></div>\n              </div>\n            </div>\n          </div>\n          <div class=\"mem-dump anim fade\" style=\"--d:.9s\">\n            <div class=\"dump-head\"><span class=\"pill ok\">真实低内存回读 · 32 B/row</span><span class=\"dim\">低端保留区在启动后仍可读；这里只抽样 64 B</span></div>\n            <div class=\"dump-grid\">\n              <div class=\"dump-block\"><div class=\"dump-label\"><b>IVT / BDA（中断向量表 / BIOS 数据区）</b><span>0x0 · 真实回读</span></div><div class=\"hexdump\"><div class=\"h-row\"><span class=\"h-addr\">0x00000000</span><span class=\"h-hex\">53 ff 00 f0 53 ff 00 f0 c3 e2 00 f0 53 ff 00 f0 53 ff 00 f0 54 ff 00 f0 53 ff 00 f0 53 ff 00 f0</span><span class=\"h-ascii\">S...S.......S...S...T...S...S...</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00000020</span><span class=\"h-hex\">a5 fe 00 f0 87 e9 00 f0 3d d4 00 f0 3d d4 00 f0 3d d4 00 f0 3d d4 00 f0 57 ef 00 f0 3d d4 00 f0</span><span class=\"h-ascii\">........=...=...=...=...W...=...</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00000040</span><span class=\"h-hex\">06 56 00 c0 4d f8 00 f0 41 f8 00 f0 fe e3 00 f0 39 e7 00 f0 59 f8 00 f0 2e e8 00 f0 d2 ef 00 f0</span><span class=\"h-ascii\">.V..M...A.......9...Y...........</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00000060</span><span class=\"h-hex\">62 d4 00 f0 f2 e6 00 f0 6e fe 00 f0 53 ff 00 f0 53 ff 00 f0 53 ff 00 f0 7c 60 00 f0 40 94 00 c0</span><span class=\"h-ascii\">b.......n...S...S...S...|`..@...</span></div></div></div>\n              <div class=\"dump-block\"><div class=\"dump-label\"><b>MBR / GRUB stage1（主引导记录）</b><span>0x7c00 · 真实回读</span></div><div class=\"hexdump\"><div class=\"h-row\"><span class=\"h-addr\">0x00007c00</span><span class=\"h-hex\">e8 00 00 eb 3b 00 00 00 10 00 00 00 8c 12 00 00 1b 8a 00 00 da 3a d1 e5 00 00 00 00 00 00 00 00</span><span class=\"h-ascii\">....;................:..........</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00007c20</span><span class=\"h-hex\">00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00</span><span class=\"h-ascii\">................................</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00007c40</span><span class=\"h-hex\">5b 31 c0 8e d0 bc 00 60 8e d8 8e c0 be dd 7c 2e 66 8b 8f 0d 00 66 09 c9 74 76 66 81 c1 ff 07 00</span><span class=\"h-ascii\">[1.....`......|.f....f..tvf.....</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00007c60</span><span class=\"h-hex\">00 66 c1 e9 0b 2e 66 8b b7 09 00 e8 05 00 ea 00 00 20 08 66 31 c0 6a 10 66 46 66 50 66 56 68 00</span><span class=\"h-ascii\">.f....f.......... .f1.j.fFfPfVh.</span></div></div></div>\n              <div class=\"dump-block\"><div class=\"dump-label\"><b>setup（16 位引导代码）</b><span>0x10000 · 真实回读</span></div><div class=\"hexdump\"><div class=\"h-row\"><span class=\"h-addr\">0x00010000</span><span class=\"h-hex\">08 e8 49 f1 ff ff eb 01 90 8b 45 f4 8b 40 04 83 c0 03 83 e0 fc 01 45 f4 83 7d f4 00 74 16 a1 e8</span><span class=\"h-ascii\">..I.......E..@........E..}..t...</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00010020</span><span class=\"h-hex\">7b 01 00 8b 50 08 a1 e8 7b 01 00 01 c2 8b 45 f4 39 c2 77 91 90 c9 c3 f3 0f 1e fb 55 89 e5 83 ec</span><span class=\"h-ascii\">{...P...{.....E.9.w........U....</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00010040</span><span class=\"h-hex\">18 a1 e8 7b 01 00 85 c0 74 1f a1 e8 7b 01 00 8b 00 3d 6d 69 6d 67 75 11 a1 e8 7b 01 00 8b 50 04</span><span class=\"h-ascii\">...{....t...{....=mimgu...{...P.</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00010060</span><span class=\"h-hex\">a1 e8 7b 01 00 01 d0 eb 05 b8 00 00 00 00 89 45 f4 eb 6d 8b 45 f4 8b 00 83 f8 02 74 11 8b 45 f4</span><span class=\"h-ascii\">..{............E..m.E......t..E.</span></div></div></div>\n              <div class=\"dump-block\"><div class=\"dump-label\"><b>decompressor（解压器）</b><span>0x100000 · 真实回读</span></div><div class=\"hexdump\"><div class=\"h-row\"><span class=\"h-addr\">0x00100000</span><span class=\"h-hex\">fc fa 8d a6 e8 01 00 00 e8 00 00 00 00 5d 83 ed 0d 8d 85 10 d0 62 00 89 40 02 0f 01 10 b8 18 00</span><span class=\"h-ascii\">.............].......b..@.......</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00100020</span><span class=\"h-hex\">00 00 8e d8 8e c0 8e e0 8e e8 8e d0 8d a5 00 14 63 00 6a 08 8d 85 3c 00 00 00 50 cb e8 df e3 61</span><span class=\"h-ascii\">................c.j...<...P....a</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00100040</span><span class=\"h-hex\">00 85 c0 0f 85 ce e3 61 00 89 eb 8b 86 30 02 00 00 48 01 c3 f7 d0 21 c3 81 fb 00 00 00 01 73 05</span><span class=\"h-ascii\">.......a.....0...H....!.......s.</span></div><div class=\"h-row\"><span class=\"h-addr\">0x00100060</span><span class=\"h-hex\">bb 00 00 00 01 03 9e 60 02 00 00 81 eb 00 80 66 00 0f 20 e0 83 c8 20 0f 22 e0 31 d2 8d bb 00 70</span><span class=\"h-ascii\">.......`.......f.. ... .\".1....p</span></div></div></div>\n              <div class=\"dump-block\"><div class=\"dump-label\"><b>kernel text（内核代码）</b><span>0x1000000 · 真实回读</span></div><div class=\"hexdump\"><div class=\"h-row\"><span class=\"h-addr\">0x01000000</span><span class=\"h-hex\">49 89 f7 48 8d 25 4e 3f e0 00 b9 01 01 00 c0 48 8d 15 ea 7f 02 01 89 d0 48 c1 ea 20 0f 30 e8 4d</span><span class=\"h-ascii\">I..H.%N?.......H........H.. .0.M</span></div><div class=\"h-row\"><span class=\"h-addr\">0x01000020</span><span class=\"h-hex\">02 00 00 6a 10 48 8d 05 03 00 00 00 50 48 cb e8 1c 20 03 00 48 8d 3d c5 ff ff ff 4c 89 fe e8 2d</span><span class=\"h-ascii\">...j.H......PH... ..H.=....L...-</span></div><div class=\"h-row\"><span class=\"h-addr\">0x01000040</span><span class=\"h-hex\">00 00 00 48 8d 0d b6 5f 0d 01 48 01 c8 0f 22 d8 ff 25 fa c5 17 01 66 2e 0f 1f 84 00 00 00 00 00</span><span class=\"h-ascii\">...H..._..H...\"..%....f.........</span></div><div class=\"h-row\"><span class=\"h-addr\">0x01000060</span><span class=\"h-hex\">90 90 90 90 90 90 90 90 90 90 90 90 90 90 90 90 66 0f 1f 00 55 48 89 f8 48 8d 15 81 7f 0d 01 48</span><span class=\"h-ascii\">................f...UH..H......H</span></div></div></div>\n              <div class=\"dump-block\"><div class=\"dump-label\"><b>kernel / page tables（内核/页表）</b><span>0x2000000 · 真实回读</span></div><div class=\"hexdump\"><div class=\"h-row\"><span class=\"h-addr\">0x02000000</span><span class=\"h-hex\">00 9b 1c 81 ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00</span><span class=\"h-ascii\">................................</span></div><div class=\"h-row\"><span class=\"h-addr\">0x02000020</span><span class=\"h-hex\">50 48 a8 81 ff ff ff ff e0 c1 64 81 ff ff ff ff 80 b2 64 81 ff ff ff ff 30 78 1c 81 ff ff ff ff</span><span class=\"h-ascii\">PH........d.......d.....0x......</span></div><div class=\"h-row\"><span class=\"h-addr\">0x02000040</span><span class=\"h-hex\">00 56 fd 81 ff ff ff ff 00 00 00 00 00 00 00 00 40 85 8f 02 80 88 ff ff 98 84 8f 02 80 88 ff ff</span><span class=\"h-ascii\">.V..............@...............</span></div><div class=\"h-row\"><span class=\"h-addr\">0x02000060</span><span class=\"h-hex\">00 9b 1c 81 ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00</span><span class=\"h-ascii\">................................</span></div></div></div>\n            </div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "IVT",
        "中断向量表"
      ],
      [
        "BDA",
        "BIOS 数据区"
      ],
      [
        "direct map",
        "直接映射"
      ],
      [
        "vmemmap",
        "页描述符数组"
      ]
    ],
    "newConcepts": [
      "E820",
      "物理/虚拟地图",
      "hexdump"
    ],
    "duration": 34.5,
    "beats": [
      {
        "t": 0.35,
        "text": "进入长模式后，地址分成物理和虚拟两套。"
      },
      {
        "t": 3.561,
        "text": "物理地址从零开始：最低端是中断向量表和 BIOS 数据区，然后是 MBR、setup，1 MiB 以上是内核、initramfs、页表和 DMA 缓冲。"
      },
      {
        "t": 16.405,
        "text": "虚拟地址在高半区：direct map 线性映射全部 RAM，vmemmap 描述每一页，内核 text 在 0xffffffff81000000 附近。"
      },
      {
        "t": 29.418,
        "text": "下面是从 shell 回读的真实低内存，三十二字节一行。"
      }
    ]
  },
  {
    "tag": "内核",
    "kicker": "S09 / START_KERNEL",
    "title": "主内核开始初始化：一棵调用树",
    "caption": "start_kernel 初始化内存、调度、中断、计时器、VFS 和驱动框架，最后 rest_init 创建 PID 1。",
    "bullets": [
      "内核链接在高半区；页表把线性地址翻译到物理内存。",
      "初始化顺序决定后面谁能用：内存 → 调度 → 中断/时钟 → VFS → 驱动。",
      "<b>rest_init</b> 之后，PID 1 和 idle 任务开始出现。"
    ],
    "facts": [
      [
        "start_kernel",
        "0xffffffff82056d20",
        true
      ],
      [
        "CPL",
        "0",
        false
      ],
      [
        "next",
        "rest_init → kernel_init",
        true
      ],
      [
        "scheduler",
        "initialized",
        false
      ]
    ],
    "visual": "\n        <div class=\"kernel\">\n          <svg class=\"wire-svg\" viewBox=\"0 0 1100 560\">\n            <path d=\"M550 250 L250 110\"/><path d=\"M550 250 L550 80\"/><path d=\"M550 250 L850 110\"/>\n            <path d=\"M550 250 L230 450\"/><path d=\"M550 250 L550 490\"/><path d=\"M550 250 L870 450\"/>\n          </svg>\n          <div class=\"kernel-core anim pop\" style=\"--d:.15s\">\n            <div class=\"k1\">x86_64_start_kernel</div>\n            <div class=\"k2\">start_kernel</div>\n            <div class=\"k3\">0xffffffff82056d20</div>\n            <div class=\"pill ok\" style=\"margin-top:10px\">CPL 0 · long-64</div>\n          </div>\n          <div class=\"subsystem anim pop\" style=\"left:40px;top:55px;--d:.4s\">内存管理<span class=\"s\">mm / page allocator</span></div>\n          <div class=\"subsystem anim pop\" style=\"left:460px;top:20px;--d:.55s\">调度器<span class=\"s\">sched / runqueue</span></div>\n          <div class=\"subsystem anim pop\" style=\"right:40px;top:55px;--d:.7s\">中断与时钟<span class=\"s\">IRQ / APIC / tick</span></div>\n          <div class=\"subsystem anim pop\" style=\"left:25px;bottom:45px;--d:.85s\">VFS<span class=\"s\">mount / dentry / inode</span></div>\n          <div class=\"subsystem anim pop\" style=\"left:460px;bottom:20px;--d:1s\">proc / sysfs<span class=\"s\">内核对象入口</span></div>\n          <div class=\"subsystem anim pop\" style=\"right:25px;bottom:45px;--d:1.15s\">驱动框架<span class=\"s\">PCI / virtio / ext2</span></div>\n          <div class=\"pill hi anim fade\" style=\"position:absolute;left:50%;bottom:120px;transform:translateX(-50%);--d:1.35s\">rest_init → kernel_init → PID 1</div>\n        </div>\n        ",
    "terms": [
      [
        "start_kernel",
        "内核初始化入口"
      ],
      [
        "VFS",
        "虚拟文件系统"
      ],
      [
        "IRQ",
        "中断请求"
      ],
      [
        "rest_init",
        "创建 PID 1"
      ]
    ],
    "newConcepts": [
      "start_kernel",
      "VFS"
    ],
    "duration": 34.1,
    "beats": [
      {
        "t": 0.35,
        "text": "主内核从 startup_64 进入 x86_64_start_kernel，再到 start_kernel。"
      },
      {
        "t": 10.499,
        "text": "这里初始化内存管理、调度器、中断控制器、计时器、VFS、proc 和驱动框架。"
      },
      {
        "t": 17.696,
        "text": "该阶段由一棵初始化调用树完成。"
      },
      {
        "t": 20.648,
        "text": "本实验停在 start_kernel 的 0xffffffff82056d20。"
      },
      {
        "t": 28.03,
        "text": "之后 rest_init 创建 kernel_init 线程。"
      }
    ]
  },
  {
    "tag": "PID 1",
    "kicker": "S10 / INITRAMFS",
    "title": "kernel_init 变成 PID 1，执行 initramfs 的 /init",
    "caption": "kernel_init 完成剩余初始化，打开 /dev/console，执行 initramfs 里的 /init；它成为 PID 1。",
    "bullets": [
      "PID 1 是真实 <span class='mono'>task_struct</span> 的进程标识。",
      "initramfs 是内存里的临时根，用来加载挂载真实根盘所需的驱动。",
      "<span class='mono'>/init</span> 是用户态脚本；它会在挂载根盘后退出舞台。"
    ],
    "facts": [
      [
        "PID 1",
        "kernel_init",
        true
      ],
      [
        "rootfs",
        "initramfs",
        false
      ],
      [
        "exec",
        "/init",
        true
      ],
      [
        "wait",
        "/dev/vda",
        false
      ]
    ],
    "visual": "\n        <div class=\"pid-grid\">\n          <div class=\"task-tree\">\n            <div class=\"task node anim pop\" style=\"--d:.15s\"><div class=\"task-comm\">init_task</div><div class=\"task-meta\">pid 0 · swapper</div></div>\n            <div class=\"task-link anim fade\" style=\"--d:.35s\"></div>\n            <div class=\"task node accent anim pop\" style=\"--d:.5s\"><div class=\"task-comm\">kernel_init</div><div class=\"task-meta\">pid 1 · PID 1</div></div>\n            <div class=\"task-link anim fade\" style=\"--d:.7s\"></div>\n            <div class=\"task node ok anim pop\" style=\"--d:.85s\"><div class=\"task-comm\">/init</div><div class=\"task-meta\">initramfs 用户态</div></div>\n          </div>\n          <div class=\"stack\">\n            <div class=\"initramfs anim right\" style=\"--d:.45s\">\n              <div class=\"tag\">INITRAMFS · tmpfs</div>\n              <div class=\"files\">\n                <span class=\"pill hi\">/init</span><span class=\"pill\">/bin/busybox</span>\n                <span class=\"pill\">/dev</span><span class=\"pill\">/proc</span><span class=\"pill\">/sys</span>\n              </div>\n              <div class=\"code\" style=\"margin-top:12px\"><span class=\"c\"># /init</span>\nmount -t devtmpfs devtmpfs /dev\nmount -t proc proc /proc\nmount -t sysfs sysfs /sys\nwhile [ ! -b /dev/vda ]; do sleep 0.1; done</div>\n            </div>\n            <div class=\"task node anim fade\" style=\"--d:.85s\"><div class=\"n-title\">CURRENT</div><div class=\"n-value\">pid=1 /init</div><div class=\"n-sub\">等待 /dev/vda 出现</div></div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "PID 1",
        "1 号进程"
      ],
      [
        "initramfs",
        "初始内存文件系统"
      ],
      [
        "task_struct",
        "进程描述符"
      ],
      [
        "/init",
        "初始化脚本"
      ]
    ],
    "newConcepts": [
      "initramfs",
      "PID 1"
    ],
    "duration": 24.7,
    "beats": [
      {
        "t": 0.35,
        "text": "kernel_init 变成 PID 一。"
      },
      {
        "t": 3.581,
        "text": "它把 initramfs 当作临时根文件系统，执行其中的 /init。"
      },
      {
        "t": 8.965,
        "text": "init 挂载 devtmpfs、proc、sysfs，然后等待 virtio 磁盘 /dev/vda 出现。"
      },
      {
        "t": 17.427,
        "text": "PID 一还是同一个 task_struct，但它的用户地址空间来自 initramfs。"
      }
    ]
  },
  {
    "tag": "virtio",
    "kicker": "S11 / VIRTIO-BLK",
    "title": "virtio-blk：描述符、DMA、中断",
    "caption": "驱动协商 feature、填充 virtqueue，kick 设备；设备 DMA 读写，完成后更新 used 环并拉中断。",
    "bullets": [
      "virtqueue 通过共享内存描述符、可用环、已用环和设备通知完成请求交接。",
      "描述符链、avail、used 三个环都要按实际协商格式解析。",
      "DMA 与中断是两条不同的证据：一个搬字节，一个通知完成。"
    ],
    "facts": [
      [
        "device",
        "virtio-blk-pci",
        false
      ],
      [
        "queue",
        "split ring",
        true
      ],
      [
        "DMA",
        "descriptor → RAM",
        true
      ],
      [
        "IRQ",
        "used ring",
        false
      ]
    ],
    "visual": "\n        <div class=\"virtio\">\n          <div class=\"stack\">\n            <div class=\"node accent anim left\" style=\"--d:.15s\"><div class=\"n-title\">PCI</div><div class=\"n-value\">virtio-blk</div><div class=\"n-sub\">BAR · feature negotiation</div></div>\n            <div class=\"node anim left\" style=\"--d:.35s\"><div class=\"n-title\">REQUEST</div><div class=\"n-value\">read LBA</div><div class=\"n-sub\">out_hdr + data + status</div></div>\n            <div class=\"dma-arrow anim fade\" style=\"--d:.55s\"><span>CPU</span><div class=\"line\"></div><span>DMA</span></div>\n            <div class=\"node ok anim left\" style=\"--d:.7s\"><div class=\"n-title\">COMPLETE</div><div class=\"n-value\">used.idx++</div><div class=\"n-sub\">raise IRQ</div></div>\n          </div>\n          <div class=\"ring\">\n            <div class=\"r-title anim fade\" style=\"--d:.3s\">descriptor ring</div>\n            <div class=\"ring-row anim fade\" style=\"--d:.4s\"><div class=\"ring-cell hot\">0</div><div class=\"ring-cell\">1</div><div class=\"ring-cell\">2</div><div class=\"ring-cell\">3</div><div class=\"ring-cell\">4</div><div class=\"ring-cell\">5</div><div class=\"ring-cell\">6</div><div class=\"ring-cell\">7</div></div>\n            <div class=\"r-title anim fade\" style=\"--d:.55s\">avail ring</div>\n            <div class=\"ring-row anim fade\" style=\"--d:.65s\"><div class=\"ring-cell ok\">idx</div><div class=\"ring-cell hot\">0</div><div class=\"ring-cell\">1</div><div class=\"ring-cell\">2</div><div class=\"ring-cell\">3</div></div>\n            <div class=\"r-title anim fade\" style=\"--d:.8s\">used ring</div>\n            <div class=\"ring-row anim fade\" style=\"--d:.9s\"><div class=\"ring-cell\">id</div><div class=\"ring-cell ok\">len</div><div class=\"ring-cell hot\">0</div><div class=\"ring-cell\"></div><div class=\"ring-cell\"></div></div>\n            <div class=\"pill hi anim fade\" style=\"--d:1.1s\">0x1000000 · split virtqueue</div>\n            <div class=\"term anim fade\" style=\"--d:1.25s\">kick → device DMA → used ring → IRQ\nLinux: virtqueue_get_buf() → 完成请求 → 唤醒进程</div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "virtio-blk",
        "虚拟块设备"
      ],
      [
        "virtqueue",
        "虚拟队列"
      ],
      [
        "DMA",
        "直接内存访问"
      ],
      [
        "IRQ",
        "中断请求"
      ]
    ],
    "newConcepts": [
      "virtqueue",
      "DMA",
      "IRQ"
    ],
    "duration": 26.0,
    "beats": [
      {
        "t": 0.35,
        "text": "virtio-blk 通过 PCI 暴露给内核。"
      },
      {
        "t": 4.145,
        "text": "驱动读 PCI 配置空间，协商 feature，设置 virtqueue。"
      },
      {
        "t": 9.996,
        "text": "提交读请求时，CPU 填好描述符链和 avail 环，然后 kick 设备。"
      },
      {
        "t": 16.004,
        "text": "设备用 DMA 读请求、写数据，完成后更新 used 环并拉中断。"
      },
      {
        "t": 21.223,
        "text": "Linux 在中断里扫描 used 环，唤醒等待的进程。"
      }
    ]
  },
  {
    "tag": "ext2",
    "kicker": "S12 / EXT2 ROOT",
    "title": "挂载 ext2：superblock、inode、dentry",
    "caption": "读 1024 字节处的超级块，校验 0xEF53；根 inode 是 2，之后解析目录项和 inode 表。",
    "bullets": [
      "本实验 ext2 路径直接处理文件元数据和块映射。",
      "路径查找：mount → dentry → inode → 数据块。",
      "页缓存命中时直接读取缓存，冷读通过 virtio 获取所需数据。"
    ],
    "facts": [
      [
        "superblock",
        "0x400 / 0xEF53",
        true
      ],
      [
        "root ino",
        "2",
        true
      ],
      [
        "hello.txt",
        "85 B",
        false
      ],
      [
        "mount",
        "VFS",
        false
      ]
    ],
    "visual": "\n        <div class=\"ext2\">\n          <div class=\"stack\">\n            <div class=\"pill hi anim fade\" style=\"--d:.2s\">DISK LAYOUT · ext2</div>\n            <div class=\"blocks\">\n              <div class=\"block anim fade\" style=\"--d:.3s\"></div>\n              <div class=\"block sb anim pop\" style=\"--d:.4s\"><b>SB</b>1024</div>\n              <div class=\"block anim fade\" style=\"--d:.5s\"><b>GD</b>group</div>\n              <div class=\"block inode anim pop\" style=\"--d:.6s\"><b>INODE</b>table</div>\n              <div class=\"block inode anim pop\" style=\"--d:.7s\"><b>INODE</b>2</div>\n              <div class=\"block data anim pop\" style=\"--d:.8s\"><b>DATA</b>dir</div>\n              <div class=\"block data anim pop\" style=\"--d:.9s\"><b>DATA</b>hello</div>\n              <div class=\"block anim fade\" style=\"--d:1s\"></div>\n            </div>\n            <div class=\"code anim fade\" style=\"--d:1.15s\">s_magic = 0xEF53\ns_log_block_size = 0 → 4096 B\ns_inodes_count = 24576\nroot inode = 2</div>\n          </div>\n          <div class=\"dentry\">\n            <div class=\"d-row anim right\" style=\"--d:.4s\"><span>mount</span><span class=\"mono\">/</span><span class=\"dim\">VFS root</span></div>\n            <div class=\"d-row anim right\" style=\"--d:.55s\"><span>dentry</span><span class=\"mono\">/data</span><span class=\"dim\">inode 118</span></div>\n            <div class=\"d-row anim right\" style=\"--d:.7s\"><span>dentry</span><span class=\"mono\">/data/hello.txt</span><span class=\"dim\">inode 119</span></div>\n            <div class=\"d-row anim right\" style=\"--d:.85s\"><span>inode</span><span class=\"mono\">size 85</span><span class=\"ok\">数据块已定位</span></div>\n            <div class=\"pill ok anim fade\" style=\"--d:1.05s\">VFS mount · dentry cache · inode cache</div>\n            <div class=\"term anim fade\" style=\"--d:1.2s\">cat /data/hello.txt\n→ VFS → ext2 → page cache → virtio-blk → DMA</div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "superblock",
        "超级块"
      ],
      [
        "inode",
        "索引节点"
      ],
      [
        "dentry",
        "目录项"
      ],
      [
        "VFS",
        "虚拟文件系统"
      ]
    ],
    "newConcepts": [
      "superblock",
      "inode",
      "dentry"
    ],
    "duration": 27.8,
    "beats": [
      {
        "t": 0.35,
        "text": "根盘 /dev/vda 上是 ext2。"
      },
      {
        "t": 3.596,
        "text": "内核读一千零二十四字节处的超级块，校验 magic 0xEF53，读块组描述符和 inode 表。"
      },
      {
        "t": 11.547,
        "text": "根目录是 inode 二。"
      },
      {
        "t": 13.657,
        "text": "ext2 驱动按目录项找到 /data/hello.txt，把 inode 读进内存，建立 dentry 和 inode 缓存，挂到 VFS 上。"
      },
      {
        "t": 25.503,
        "text": "页缓存和磁盘是两个层次。"
      }
    ]
  },
  {
    "tag": "switch",
    "kicker": "S13 / SWITCH_ROOT",
    "title": "switch_root：从 initramfs 换到真实 ext2 根",
    "caption": "initramfs 的 /init 挂载 /dev/vda，移动 /dev /proc /sys，switch_root，执行 /sbin/init。",
    "bullets": [
      "switch_root 改变根目录和当前工作目录，然后 exec 新根上的 init。",
      "保留 PID 1，并切换它看到的根文件系统和后续用户空间。",
      "这一步之后，/data 才真正来自 virtio ext2 盘。"
    ],
    "facts": [
      [
        "before",
        "initramfs",
        false
      ],
      [
        "after",
        "ext2 /dev/vda",
        true
      ],
      [
        "pid",
        "1 (same task)",
        true
      ],
      [
        "exec",
        "/sbin/init",
        false
      ]
    ],
    "visual": "\n        <div class=\"rootcmp\">\n          <div class=\"mount-tree anim left\" style=\"--d:.2s\">\n            <div class=\"root\">/  (initramfs)</div>\n            <div>├─ init</div><div>├─ bin/busybox</div><div>├─ proc</div><div>├─ sys</div><div>└─ dev</div>\n          </div>\n          <div class=\"switch-arrow anim fade\" style=\"--d:.55s\">\n            <div class=\"a\"></div>\n            <div>switch_root</div>\n          </div>\n          <div class=\"mount-tree anim right\" style=\"--d:.8s\">\n            <div class=\"root\">/  (ext2 /dev/vda)</div>\n            <div>├─ sbin/init</div><div>├─ bin / lib / etc</div><div>├─ data/hello.txt</div><div>├─ proc</div><div>└─ sys / dev</div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "switch_root",
        "切换根目录"
      ],
      [
        "initramfs",
        "临时根"
      ],
      [
        "rootfs",
        "根文件系统"
      ],
      [
        "PID 1",
        "1 号进程"
      ]
    ],
    "newConcepts": [
      "switch_root"
    ],
    "duration": 21.6,
    "beats": [
      {
        "t": 0.35,
        "text": "initramfs 的 /init 把 /dev、/proc、/sys 移动到新根，调用 switch_root 切换根目录，再执行新根上的 /sbin/init。"
      },
      {
        "t": 12.859,
        "text": "原来的 initramfs 根被替换，PID 一还是同一个进程，但根目录和用户空间已经换成真实 ext2 盘。"
      }
    ]
  },
  {
    "tag": "用户空间",
    "kicker": "S14 / BUSYBOX",
    "title": "BusyBox init：拉起 tty，得到 shell",
    "caption": "BusyBox init 读 /etc/inittab：tty1 askfirst，ttyS0 respawn；getty 打开终端，exec /bin/sh。",
    "bullets": [
      "VGA 上的 tty1 和串口 ttyS0 分别使用键盘和 UART 输入通路。",
      "getty 负责打开终端并 exec shell；shell 随后在 read 上睡眠。",
      "提示符确认 shell 已运行；各设备初始化状态以对应设备证据确认。"
    ],
    "facts": [
      [
        "inittab",
        "/etc/inittab",
        false
      ],
      [
        "tty1",
        "askfirst",
        true
      ],
      [
        "ttyS0",
        "respawn",
        true
      ],
      [
        "prompt",
        "linux-lab:/root#",
        true
      ]
    ],
    "visual": "\n        <div class=\"tty\">\n          <div class=\"stack\">\n            <div class=\"code anim left\" style=\"--d:.15s\"><span class=\"c\"># /etc/inittab</span>\n::sysinit:/etc/rcS\ntty1::askfirst:/bin/sh -l\nttyS0::respawn:/bin/cttyhack /bin/sh -l\n::ctrlaltdel:/sbin/reboot</div>\n            <div class=\"grid2\">\n              <div class=\"node anim pop\" style=\"--d:.5s\"><div class=\"n-title\">tty1</div><div class=\"n-value\">VGA</div><div class=\"n-sub\">askfirst · 需要按 Enter</div></div>\n              <div class=\"node anim pop\" style=\"--d:.65s\"><div class=\"n-title\">ttyS0</div><div class=\"n-value\">serial</div><div class=\"n-sub\">respawn · 115200</div></div>\n            </div>\n            <div class=\"pill ok anim fade\" style=\"--d:.85s\">PID 1 → getty → /bin/sh</div>\n          </div>\n          <div class=\"screen anim right\" style=\"--d:.55s\">\n<span class=\"c\">Linux Observatory / Linux 6.12.112</span>\nReal kernel, real processes, real virtio disk.\nTry: cat /data/hello.txt; lab-read; lab-memory; lab-cow\n\n<span class=\"prompt\">linux-lab:/root#</span> <span class=\"cursor\"></span>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "inittab",
        "初始化配置"
      ],
      [
        "getty",
        "登录终端程序"
      ],
      [
        "TTY",
        "终端"
      ],
      [
        "ttyS0",
        "串口终端"
      ]
    ],
    "newConcepts": [
      "inittab",
      "getty"
    ],
    "duration": 21.0,
    "beats": [
      {
        "t": 0.35,
        "text": "BusyBox init 读 /etc/inittab。"
      },
      {
        "t": 3.837,
        "text": "tty1 上 askfirst 启动登录 shell，ttyS0 上 respawn 一个串口 shell。"
      },
      {
        "t": 10.562,
        "text": "getty 打开终端，设置 termios，exec /bin/sh。"
      },
      {
        "t": 14.921,
        "text": "shell 打印提示符 linux-lab:/root#，然后阻塞在 read 上等待输入。"
      }
    ]
  },
  {
    "tag": "终端",
    "kicker": "S15 / TTY I/O",
    "title": "按键如何变成终端里的字符？",
    "caption": "i8042 → IRQ 1 → input → VT/TTY 行规程 → 回显；回车后 shell 被唤醒，fork/exec 执行命令。",
    "bullets": [
      "键盘中断、TTY 缓冲、行规程回显是不同阶段。",
      "串口输入经 UART，键盘输入经 i8042，分别进入终端输入处理。",
      "回车提交一行后，shell 才 fork/exec 执行命令。"
    ],
    "facts": [
      [
        "keyboard",
        "i8042 · IRQ 1",
        true
      ],
      [
        "line",
        "TTY / termios",
        true
      ],
      [
        "echo",
        "VGA / serial",
        false
      ],
      [
        "exec",
        "fork + exec",
        false
      ]
    ],
    "visual": "\n        <div class=\"tty\">\n          <div class=\"tty-flow\">\n            <div class=\"tty-step anim left\" style=\"--d:.15s\"><span class=\"idx\">01</span>按键按下 · 扫描码<span class=\"sub\">PS/2</span></div>\n            <div class=\"tty-step anim left\" style=\"--d:.3s\"><span class=\"idx\">02</span>i8042 · IRQ 1<span class=\"sub\">0x60</span></div>\n            <div class=\"tty-step anim left\" style=\"--d:.45s\"><span class=\"idx\">03</span>input / VT / TTY<span class=\"sub\">line discipline</span></div>\n            <div class=\"tty-step anim left\" style=\"--d:.6s\"><span class=\"idx\">04</span>回显到 VGA / 串口<span class=\"sub\">echo</span></div>\n            <div class=\"tty-step anim left\" style=\"--d:.75s\"><span class=\"idx\">05</span>回车 → 唤醒 shell<span class=\"sub\">read 返回</span></div>\n            <div class=\"tty-step anim left\" style=\"--d:.9s\"><span class=\"idx\">06</span>fork / exec 命令<span class=\"sub\">输出回 tty</span></div>\n          </div>\n          <div class=\"screen anim right\" style=\"--d:.6s\">\n<span class=\"c\">[按键] l s ⏎</span>\n<span class=\"prompt\">linux-lab:/root#</span> ls\nbin  data  dev  etc  proc  root  sys\n\n<span class=\"c\">[串口是另一条通路]</span>\nttyS0 · 115200 · IRQ\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "i8042",
        "键盘控制器"
      ],
      [
        "IRQ",
        "中断请求"
      ],
      [
        "TTY",
        "终端"
      ],
      [
        "termios",
        "终端参数"
      ]
    ],
    "newConcepts": [
      "i8042",
      "TTY 行规程"
    ],
    "duration": 25.7,
    "beats": [
      {
        "t": 0.35,
        "text": "按键经扫描码、输入事件和终端行规程转换为字符。"
      },
      {
        "t": 2.3,
        "text": "键盘控制器 i8042 产生扫描码和 IRQ 一。"
      },
      {
        "t": 6.733,
        "text": "CPU 进入中断，驱动读数据端口，把扫描码送进 input 层，再经过 VT 和 TTY 的行规程，回显到 VGA 或串口。"
      },
      {
        "t": 17.726,
        "text": "输入回车后，shell 被唤醒，fork 和 exec 执行命令，输出再写回 tty。"
      }
    ]
  },
  {
    "tag": "全景",
    "kicker": "S16 / FULL SNAPSHOT",
    "title": "到达 shell：CPU、进程与内存的全景",
    "caption": "同一台机器，长模式 + CPL 0；CR3=0x329c000，CR4=0x6f0，EFER=0xd01；PID 1 已存在，47 个进程。",
    "bullets": [
      "此处集中展示本次启动结束停点的 CPU 实测状态。",
      "CR3 指向页表；CR4/EFER 记录长模式和 PAE 已经打开。",
      "进程与内存是同一份快照：PID 1、47 个进程、7 个 VMA。"
    ],
    "facts": [
      [
        "模式",
        "long-64 · CPL 0",
        true
      ],
      [
        "CR3",
        "0x329c000",
        true
      ],
      [
        "PID 1",
        "init / sleeping",
        true
      ],
      [
        "进程 / VMA",
        "47 / 7",
        false
      ]
    ],
    "visual": "\n        <div class=\"pano-grid\">\n          <div class=\"anim left\" style=\"--d:.2s\">\n            \n      <div class=\"cpu-pano \">\n        <div class=\"pano-head\"><span class=\"pill hi\">long-64 · CPL 0</span><span class=\"mono\">RIP 0xffffffff81791d73 · RSP 0xffffffff81e03e28</span></div>\n        <div class=\"pano-title\">通用寄存器（general registers）</div>\n        <div class=\"reg-grid\" style=\"grid-template-columns:repeat(4,1fr)\"><div class=\"reg-cell\"><span>RAX</span><b>0xffff88801f200000</b></div><div class=\"reg-cell\"><span>RBX</span><b>0xffffffff81e0a940</b></div><div class=\"reg-cell\"><span>RCX</span><b>0x0</b></div><div class=\"reg-cell\"><span>RDX</span><b>0x4000000000000000</b></div><div class=\"reg-cell\"><span>RSI</span><b>0x83</b></div><div class=\"reg-cell\"><span>RDI</span><b>0x3cc</b></div><div class=\"reg-cell\"><span>RBP</span><b>0xffffffff81e03e28</b></div><div class=\"reg-cell\"><span>RSP</span><b>0xffffffff81e03e28</b></div><div class=\"reg-cell\"><span>R8</span><b>0x3cc</b></div><div class=\"reg-cell\"><span>R9</span><b>0x7</b></div><div class=\"reg-cell\"><span>R10</span><b>0x20780</b></div><div class=\"reg-cell\"><span>R11</span><b>0xa19693c0</b></div><div class=\"reg-cell\"><span>R12</span><b>0x0</b></div><div class=\"reg-cell\"><span>R13</span><b>0xffffffff82014c08</b></div><div class=\"reg-cell\"><span>R14</span><b>0xffffffff81e0a940</b></div><div class=\"reg-cell\"><span>R15</span><b>0x0</b></div></div>\n        <div class=\"pano-title\">控制寄存器（control registers）与标志</div>\n        <div class=\"ctl-grid\"><div class=\"ctl-cell\"><span>CR0</span><b>0x80050033</b></div><div class=\"ctl-cell\"><span>CR2</span><b>0x896af8</b></div><div class=\"ctl-cell\"><span>CR3</span><b>0x329c000</b></div><div class=\"ctl-cell\"><span>CR4</span><b>0x6f0</b></div><div class=\"ctl-cell\"><span>CR8</span><b>0x1</b></div><div class=\"ctl-cell\"><span>EFER</span><b>0xd01</b></div><div class=\"ctl-cell\"><span>RFLAGS</span><b>0x216</b></div></div>\n        <div class=\"pano-title\">段寄存器（segment registers）</div>\n        <div class=\"seg-table\"><div class=\"seg-row head\"><b>段</b><span>selector</span><span>base</span><span>limit</span></div><div class=\"seg-row\"><b>CS</b><span>0x10</span><span>0x0</span><span>0xffffffff</span></div><div class=\"seg-row\"><b>SS</b><span>0x18</span><span>0x0</span><span>0xffffffff</span></div><div class=\"seg-row\"><b>DS</b><span>0x0</span><span>0x0</span><span>0x0</span></div><div class=\"seg-row\"><b>ES</b><span>0x0</span><span>0x0</span><span>0x0</span></div><div class=\"seg-row\"><b>FS</b><span>0x0</span><span>0x0</span><span>0x0</span></div><div class=\"seg-row\"><b>GS</b><span>0x0</span><span>0xffff88801f200000</span><span>0x0</span></div><div class=\"seg-row\"><b>TR</b><span>0x40</span><span>0xfffffe0000003000</span><span>0x4087</span></div><div class=\"seg-row\"><b>LDTR</b><span>0x0</span><span>0x0</span><span>0x0</span></div></div>\n      </div>\n    \n          </div>\n          <div class=\"stack\">\n            <div class=\"delta-card anim right\" style=\"--d:.4s\">\n              <div class=\"pill hi\">RESET → SHELL · 关键变化</div>\n              <div class=\"delta-row\"><span>模式</span><b>real-16 → long-64</b></div>\n              <div class=\"delta-row\"><span>CR0</span><b>0x60000010 → 0x80050033</b></div>\n              <div class=\"delta-row\"><span>CR3</span><b>0x0 → 0x329c000</b></div>\n              <div class=\"delta-row\"><span>CR4</span><b>0x0 → 0x6f0（PAE 等）</b></div>\n              <div class=\"delta-row\"><span>EFER</span><b>0x0 → 0xd01（LME/LMA）</b></div>\n            </div>\n            <div class=\"node anim right\" style=\"--d:.65s\">\n              <div class=\"n-title\">CURRENT / 当前任务</div>\n              <div class=\"n-value\">swapper/0 · PID 0</div>\n              <div class=\"n-sub\">RIP 0xffffffff81791d73 · RSP 0xffffffff81e03e28</div>\n            </div>\n            <div class=\"node ok anim right\" style=\"--d:.8s\">\n              <div class=\"n-title\">PID 1</div>\n              <div class=\"n-value\">init · task 0xffff8880029b8000</div>\n              <div class=\"n-sub\">mm 0xffff88800284c500 · state sleeping</div>\n            </div>\n            <div class=\"node anim right\" style=\"--d:.95s\">\n              <div class=\"n-title\">MEMORY / 内存</div>\n              <div class=\"n-value\">低端 IVT·MBR·setup·解压器</div>\n              <div class=\"n-sub\">高半区 direct map · vmemmap · kernel text</div>\n            </div>\n            <div class=\"pill ok anim fade\" style=\"--d:1.1s\">真实 frame 5 · 不是示意图</div>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "CR3",
        "页表基址"
      ],
      [
        "EFER",
        "扩展功能寄存器"
      ],
      [
        "VMA",
        "虚拟内存区域"
      ],
      [
        "direct map",
        "直接映射"
      ]
    ],
    "newConcepts": [
      "终值快照"
    ],
    "duration": 34.2,
    "beats": [
      {
        "t": 0.35,
        "text": "到达 shell 后，再看一次全景。"
      },
      {
        "t": 3.411,
        "text": "CPU 已经在长模式，CPL 是零，RIP 在高半区，CR3 指向当前进程的页表，CR4 打开了 PAE，EFER 的 LME 和 LMA 都置位。"
      },
      {
        "t": 15.995,
        "text": "通用寄存器里是当前任务留下的真实值。"
      },
      {
        "t": 19.056,
        "text": "内存这边，低端保留着中断向量表、MBR、setup 和解压器；高半区是 direct map、vmemmap 和内核 text。"
      },
      {
        "t": 29.939,
        "text": "这些值持续保留在当前机器状态中。"
      }
    ]
  },
  {
    "tag": "回顾",
    "kicker": "S17 / RECAP",
    "title": "一条完整的时间线",
    "caption": "复位取指 → SeaBIOS → MBR/GRUB → setup → 解压 → start_kernel → PID 1 → ext2 → shell。",
    "bullets": [
      "这是主线；每个组件都可以在时间线上放大成独立切面。",
      "实验页面里对应的课程是 L00–L07：复位、MBR、setup、解压、内核、PID 1、根盘。",
      "地址、寄存器和结构来自对应构建的采样记录。"
    ],
    "facts": [
      [
        "课程",
        "L00–L07",
        true
      ],
      [
        "帧序列",
        "0…7",
        false
      ],
      [
        "终点",
        "shell",
        true
      ],
      [
        "录制",
        "boot video",
        false
      ]
    ],
    "visual": "\n        <div class=\"recap\">\n          <div class=\"pill hi anim fade\" style=\"--d:.2s\">ONE TRACE · FROM RESET TO SHELL</div>\n          <div class=\"recap-line anim fade\" style=\"--d:.35s\"></div>\n          <div class=\"recap-nodes\">\n            <div class=\"recap-node anim fade\" style=\"--d:.45s\"><div class=\"dot\"></div><div class=\"t\">复位</div><div class=\"s\">0xfffffff0</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:.55s\"><div class=\"dot\"></div><div class=\"t\">SeaBIOS</div><div class=\"s\">MBR → 0x7c00</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:.65s\"><div class=\"dot\"></div><div class=\"t\">GRUB</div><div class=\"s\">linux16</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:.75s\"><div class=\"dot\"></div><div class=\"t\">setup</div><div class=\"s\">0x11171</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:.85s\"><div class=\"dot\"></div><div class=\"t\">解压</div><div class=\"s\">0x100000</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:.95s\"><div class=\"dot\"></div><div class=\"t\">start_kernel</div><div class=\"s\">0xffffffff…</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:1.05s\"><div class=\"dot\"></div><div class=\"t\">PID 1</div><div class=\"s\">initramfs</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:1.15s\"><div class=\"dot\"></div><div class=\"t\">ext2</div><div class=\"s\">virtio-blk</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:1.25s\"><div class=\"dot\"></div><div class=\"t\">switch_root</div><div class=\"s\">/sbin/init</div></div>\n            <div class=\"recap-node anim fade\" style=\"--d:1.35s\"><div class=\"dot\"></div><div class=\"t\">shell</div><div class=\"s\">tty1 / ttyS0</div></div>\n          </div>\n          <div class=\"recap-bottom\">\n            <span class=\"pill ok\">真实 QEMU</span><span class=\"pill ok\">GDB/MI</span><span class=\"pill ok\">x-oslab observer</span>\n            <span class=\"pill\">L00–L07</span><span class=\"pill\">25 课</span>\n            <span class=\"pill\">QEMU 8.2.10</span><span class=\"pill\">Linux 6.12.112</span>\n            <span class=\"pill\">SeaBIOS 1.16.3</span><span class=\"pill\">BusyBox 1.37.0</span>\n          </div>\n        </div>\n        ",
    "terms": [
      [
        "L00–L07",
        "启动课程"
      ],
      [
        "frame",
        "停止帧"
      ],
      [
        "QEMU",
        "模拟器"
      ],
      [
        "shell",
        "命令解释器"
      ]
    ],
    "newConcepts": [
      "时间线"
    ],
    "duration": 26.2,
    "beats": [
      {
        "t": 0.35,
        "text": "回顾这条线：复位取指、SeaBIOS、MBR 和 GRUB、十六位 setup、三十二位和六十四位解压、内存布局、start kernel、PID 一和 initramfs、virtio 和 ext2、switch root、BusyBox shell、TTY 输入输出。"
      },
      {
        "t": 20.871,
        "text": "以后再单独讲某个组件，就在这条时间线上选一个执行时机，把它切开看。"
      }
    ]
  }
];
