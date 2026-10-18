import sampling from './panorama-samples.js';
/**
 * Boot panorama curriculum. Values are either recorded snapshots or explicitly
 * source-inferred teaching states. Each snapshot retains its capture timestamp.
 * This module reads saved evidence for standalone teaching replay.
 */
export const machine = {
  title: 'Linux 启动全景实验室',
  subtitle: '从第一条取指，到终端等待输入',
  architecture: 'x86-64', cpu: 'qemu64', cores: 1, ramBytes: 512 * 1024 * 1024,
  qemu: '8.2.10 / TCG', firmware: 'SeaBIOS 1.16.3', loader: 'GRUB 2.03 / BIOS',
  kernel: 'Linux 6.12.112-observatory', userland: 'BusyBox 1.37.0',
  rootDevice: '/dev/vda', rootFilesystem: 'ext2', rootBytes: 96 * 1024 * 1024,
  bootMedium: 'boot.iso / El Torito',
  commandLine: 'nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init loglevel=5',
  buildId: 'f5e5edc1c57291e28322ccce9a9c2af2c4c76428',
  provenance: '环境来自 artifacts/manifest.json、labs/linux-x86_64/toolchain.lock.json 与 grub.cfg；数值帧为 2026-10-18 的同一真实启动会话捕获，原始证据保存在 data/detailed-captures.json。',
  boundaries: [
    '这是历史采样与源码讲解组成的教学回放；播放速度控制讲解节奏，客户机执行时点由采集记录标注。',
    '上电模拟从 QEMU 已完成硬件复位开始；供电电压、时钟稳定和实体 DRAM 训练属于物理硬件过程。',
    '微步骤按源码顺序拆解教学内容；实测步骤绑定具体采集停点，其余步骤标注源码推导或机制示意。',
    '内存颜色表示区间用途和本步关注位置；已读取的字节以采样窗口和 captureId 标注。',
    '全景列出本 qemu64 教学相关架构寄存器；未采集的调试、浮点、向量与 MSR 值保留未知。',
  ],
};

const reg = (id, en, zh, note, width = 64) => ({ id, en, zh, note, width });
export const registerGroups = [
  { id: 'general', en: 'General-purpose registers', zh: '通用寄存器', items: [
    reg('rax', 'RAX / EAX / AX / AL', '累加器', '运算结果；系统调用号与返回值。写 EAX 会清零 RAX 高 32 位。'),
    reg('rbx', 'RBX / EBX / BX / BL', '基址寄存器', '通用保存寄存器，可保存地址或普通数据。'),
    reg('rcx', 'RCX / ECX / CX / CL', '计数寄存器', '循环计数；REP 次数；SYSCALL 会保存返回 RIP 到 RCX。'),
    reg('rdx', 'RDX / EDX / DX / DL', '数据寄存器', '运算高半部、端口号或函数参数。'),
    reg('rsi', 'RSI / ESI / SI', '源索引', '字符串源地址；Linux 引导入口传递 boot_params。'),
    reg('rdi', 'RDI / EDI / DI', '目的索引', '字符串目的地址；x86-64 C 函数第一个整数参数。'),
    reg('rbp', 'RBP / EBP / BP', '栈帧基址', '启用 frame pointer 时定位当前函数栈帧。'),
    reg('rsp', 'RSP / ESP / SP', '栈指针', '当前栈顶；调用、返回和中断现场依赖它。'),
    ...Array.from({ length: 8 }, (_, i) => reg(`r${i + 8}`, `R${i + 8}`, `扩展通用寄存器 ${i + 8}`, '64 位代码通过扩展编码访问这些通用寄存器。')),
  ] },
  { id: 'execution', en: 'Execution state', zh: '执行状态', items: [
    reg('rip', 'RIP / EIP / IP', '指令指针', '当前指令偏移；实模式需结合 CS 隐藏基址解释。'),
    reg('linearPc', 'Linear instruction address', '线性取指地址', '由当前 CS 属性与 IP 解释得到；分页后还需页表转换。'),
    reg('rflags', 'RFLAGS / EFLAGS / FLAGS', '状态与控制标志', '运算标志与 IF/DF/TF 等控制位；保留位按架构定义标注。'),
    reg('cpl', 'Current privilege level', '当前特权级', '0 为内核级，3 为普通用户级；用户进程进入系统调用时 CPU 可以处于 CPL 0。', 2),
  ] },
  { id: 'control', en: 'Control registers', zh: '控制寄存器', items: [
    reg('cr0', 'CR0', '基本控制', 'PE 保护模式、PG 分页、WP 写保护、CD/NW 缓存控制。'),
    reg('cr2', 'CR2', '缺页线性地址', '保存最近一次 #PF 的线性地址，值保持到下一次缺页异常更新。'),
    reg('cr3', 'CR3', '页表根与控制', '分页根的物理地址，含模式相关低位控制字段。'),
    reg('cr4', 'CR4', '扩展控制', 'PAE、PGE、OSFXSR 等能力由独立位控制。'),
    reg('cr8', 'CR8 / TPR', '任务优先级', '64 位模式下的中断优先级阈值；全局可屏蔽中断由 RFLAGS.IF 控制。'),
    reg('efer', 'EFER', '扩展特性使能寄存器', 'MSR：LME 长模式允许、LMA 长模式激活、NXE 禁执行、SCE 系统调用。'),
  ] },
  { id: 'segments', en: 'Segment state', zh: '段寄存器与隐藏缓存', items:
    [['cs', 'Code segment', '代码段'], ['ss', 'Stack segment', '栈段'], ['ds', 'Data segment', '数据段'], ['es', 'Extra segment', '附加段'], ['fs', 'FS segment', 'FS 段'], ['gs', 'GS segment', 'GS 段'], ['tr', 'Task register', '任务寄存器'], ['ldtr', 'Local descriptor table', '局部描述符表寄存器']].map(([id, en, zh]) => reg(id, id.toUpperCase(), zh, `${en}；选择子之外还存在 base / limit / attributes 隐藏缓存。`, 16)),
  },
  { id: 'tables', en: 'Descriptor table registers', zh: '描述符表寄存器', items: [
    reg('gdtrBase', 'GDTR.base', '全局描述符表基址', 'GDT 在内存中的线性地址；LGDT 装载。'),
    reg('gdtrLimit', 'GDTR.limit', '全局描述符表界限', '按字节计量的表大小减 1。', 16),
    reg('idtrBase', 'IDTR.base', '中断描述符表基址', '实模式指向中断向量表；保护模式与长模式指向门描述符。'),
    reg('idtrLimit', 'IDTR.limit', '中断描述符表界限', 'LIDT 装载；64 位 IDT 每个门通常 16 字节。', 16),
  ] },
  { id: 'debug', en: 'Debug registers', zh: '调试寄存器', items: [
    ...[0, 1, 2, 3].map(n => reg(`dr${n}`, `DR${n}`, `硬件断点地址 ${n}`, '保存硬件断点地址；是否有值取决于本帧实际采集。')),
    reg('dr6', 'DR6', '调试状态', '记录命中断点等调试条件；来自当前停止屏障的只读状态。'),
    reg('dr7', 'DR7', '调试控制', '控制硬件断点使能、类型与长度。'),
  ] },
  { id: 'floating', en: 'x87 / SSE state', zh: '浮点与向量寄存器', items: [
    ...Array.from({ length: 8 }, (_, n) => reg(`st${n}`, `ST(${n}) / MM${n}`, `x87 栈寄存器 ${n} / MMX 别名`, 'x87 80 位原始存储；由 FSW.TOP 映射逻辑栈位置。标签为空时该槽处于空栈状态；MMX 与其存储重叠。', 80)),
    ...Array.from({ length: 16 }, (_, n) => reg(`xmm${n}`, `XMM${n}`, `SSE 向量 ${n}`, '128 位向量寄存器，保留完整十六进制位模式。AVX/AVX-512 支持由本模型 CPUID 特性确定。', 128)),
    reg('mxcsr', 'MXCSR', 'SSE 控制与状态', '舍入、异常屏蔽和异常标志。', 32),
    reg('fcw', 'x87 FCW', 'x87 控制字', '精度、舍入与异常屏蔽。', 16),
    reg('fsw', 'x87 FSW', 'x87 状态字', 'TOP、条件码和异常标志。', 16),
    reg('ftw', 'x87 FTW', '完整 x87 标记字', '16 位完整标签；QEMU 的 8 位 abridged 标签单列为压缩标签。', 16),
    reg('ftwAbridged', 'FTW abridged', '压缩 x87 标签', '8 位 abridged 标签；每位表示对应物理槽的空/非空状态，结合 FSW.TOP 解释逻辑栈位置。', 8),
  ] },
  { id: 'msr', en: 'Additional MSRs', zh: '模型专用寄存器', items: [
    reg('star', 'IA32_STAR', '系统调用段选择子', 'SYSCALL / SYSRET 的选择子配置；未采样。'),
    reg('lstar', 'IA32_LSTAR', '64 位系统调用入口', 'SYSCALL 的目标 RIP；未采样。'),
    reg('sfmask', 'IA32_FMASK', '系统调用标志屏蔽', 'SYSCALL 进入内核时屏蔽指定 RFLAGS 位；未采样。'),
    reg('fsBase', 'FS.base', 'FS 基址', '64 位线程局部存储相关基址；来源与原始格式见本帧字段证据。'),
    reg('gsBase', 'GS.base', 'GS 基址', '当前 GS 基址；与 KERNEL_GS_BASE 分开记录。'),
    reg('kernelGsBase', 'IA32_KERNEL_GS_BASE', '内核 GS 交换基址', 'SWAPGS 与 GS.base 交换；其值由独立 MSR 采样确定。'),
    reg('tsc', 'IA32_TSC', '时间戳计数器', '客户机时序状态；未采样，字段保留未知。'),
  ] },
];

const bit = (register, n, en, zh, note, width = 1) => ({ id: `${register}.${en}`, register, bit: n, width, en, zh, note });
export const flagDefinitions = [
  ...[
    [0, 'CF', '进位', '无符号运算进位或借位。'], [1, 'FIXED', '固定为 1', '架构保留固定值。'],
    [2, 'PF', '奇偶', '结果低字节中 1 的个数为偶数。'], [4, 'AF', '辅助进位', '低半字节的进位/借位。'],
    [6, 'ZF', '零', '运算结果等于 0。'], [7, 'SF', '符号', '结果的最高有效位。'],
    [8, 'TF', '单步陷阱', '控制客户机指令执行后的调试陷阱。'],
    [9, 'IF', '可屏蔽中断允许', 'STI/CLI 控制可屏蔽中断；NMI、异常和 SMI 各有独立触发机制。'],
    [10, 'DF', '字符串方向', '0 为递增，1 为递减；CLD/STD 改变。'], [11, 'OF', '溢出', '有符号结果超出表示范围。'],
    [12, 'IOPL', 'I/O 特权级', '2 位字段，与 CPL 一起影响 I/O 权限。', 2],
    [14, 'NT', '嵌套任务', '传统硬件任务切换状态。'], [16, 'RF', '恢复', '抑制部分调试异常。'],
    [17, 'VM', '虚拟 8086', '传统虚拟 8086 模式标志。'], [18, 'AC', '对齐检查 / 访问控制', '含义依当前模式与特性。'],
    [19, 'VIF', '虚拟中断', '虚拟中断标志。'], [20, 'VIP', '虚拟中断挂起', '虚拟中断待处理状态。'], [21, 'ID', 'CPUID 标志', '用于检测 CPUID 支持。'],
  ].map(([n, en, zh, note, width]) => bit('rflags', n, en, zh, note, width)),
  ...[
    [0, 'PE', '保护模式使能', '0 实模式；1 保护机制启用。'], [1, 'MP', '协处理器监视', '配合 TS 控制 WAIT/FWAIT。'],
    [2, 'EM', '浮点仿真', '软件仿真控制。'], [3, 'TS', '任务切换', '可使浮点指令触发 #NM。'], [4, 'ET', '扩展类型', '现代处理器固定语义。'],
    [5, 'NE', '数值异常', '使用原生浮点异常报告。'], [16, 'WP', '内核写保护', 'CPL 0 写只读页也受保护。'],
    [18, 'AM', '对齐检查屏蔽', '与 CPL、RFLAGS.AC 共同决定。'], [29, 'NW', '非直写', '缓存控制；需与 CD 一起解释。'],
    [30, 'CD', '缓存禁用', '复位时为 1；固件随后配置。'], [31, 'PG', '分页', '置 1 后地址通过页表转换。'],
  ].map(([n, en, zh, note]) => bit('cr0', n, en, zh, note)),
  ...[
    [0, 'VME', '虚拟 8086 扩展'], [1, 'PVI', '保护模式虚拟中断'], [2, 'TSD', '时间戳权限'], [3, 'DE', '调试扩展'],
    [4, 'PSE', '大页扩展'], [5, 'PAE', '物理地址扩展'], [6, 'MCE', '机器检查'], [7, 'PGE', '全局页'], [8, 'PCE', '性能计数权限'],
    [9, 'OSFXSR', '操作系统保存 SSE 状态'], [10, 'OSXMMEXCPT', 'SSE 异常支持'], [11, 'UMIP', '用户指令防护'],
    [12, 'LA57', '五级分页'], [13, 'VMXE', '虚拟机扩展'], [14, 'SMXE', '安全模式扩展'], [16, 'FSGSBASE', 'FS/GS 基址指令'],
    [17, 'PCIDE', '进程上下文标识'], [18, 'OSXSAVE', '扩展状态保存'], [20, 'SMEP', '内核禁止执行用户页'],
    [21, 'SMAP', '内核用户页访问保护'], [22, 'PKE', '用户页保护键'], [23, 'CET', '控制流执行技术'], [24, 'PKS', '内核页保护键'],
  ].map(([n, en, zh]) => bit('cr4', n, en, zh, '该位的可用性由 CPUID 确定，使能状态由采样值确定。')),
  ...[[0, 'SCE', 'SYSCALL 允许'], [8, 'LME', '长模式允许'], [10, 'LMA', '长模式已激活'], [11, 'NXE', '页禁止执行'], [12, 'SVME', 'AMD 虚拟化允许'], [14, 'FFXSR', '快速浮点状态保存']].map(([n, en, zh]) => bit('efer', n, en, zh, en === 'LMA' ? '硬件只读报告位，由满足长模式激活条件的状态切换更新。' : '模型专用寄存器 EFER 的独立字段。')),
];

export const memoryRegions = [
  { id: 'ivt', start: 0, end: 0x400, en: 'Interrupt Vector Table', zh: '中断向量表', color: '#42d6b4', note: '实模式 256 个 4 字节向量，由固件在复位后的执行过程中建立。' },
  { id: 'bda', start: 0x400, end: 0x500, en: 'BIOS Data Area', zh: 'BIOS 数据区', color: '#42d6b4', note: '固件维护设备、端口等低位内存数据。' },
  { id: 'low', start: 0x500, end: 0x7c00, en: 'Conventional RAM', zh: '常规低位内存', color: '#52738a', note: '固件栈和低位临时空间；EBDA 的实际位置由固件配置确定。' },
  { id: 'boot', start: 0x7c00, end: 0x7e00, en: 'Boot image window', zh: '引导镜像窗口', color: '#e8b75c', note: '本机从 ISO 引导；0x7c00 样本属于 El Torito 引导镜像窗口。' },
  { id: 'loader-low', start: 0x7e00, end: 0x10000, en: 'Low boot working area', zh: '低位引导工作区', color: '#52738a', note: '固件和引导器可使用的低位空间；具体内容未采样。' },
  { id: 'setup', start: 0x10000, end: 0xa0000, en: 'Setup / loader working area', zh: '引导器与 setup 工作区', color: '#a789ef', note: '用途会重叠和复用；setup 边界与 boot_params 的实际装载地址须按样本核对。' },
  { id: 'vga', start: 0xa0000, end: 0xc0000, en: 'VGA aperture', zh: 'VGA 显存窗口', color: '#cb7590', note: '设备显存映射；文本窗口通常在 0xb8000。' },
  { id: 'rom', start: 0xc0000, end: 0x100000, en: 'Option ROM / BIOS window', zh: '扩展 ROM 与 BIOS 窗口', color: '#ba826a', note: '固件、设备 ROM 和保留空间，具体以 e820 图为准。' },
  { id: 'decompressor', start: 0x100000, end: 0x1000000, en: 'Decompressor / early allocations', zh: '解压器与早期分配区', color: '#a789ef', note: '0x100000 / 0x100200 是本构建入口样本。色块聚合解压器与早期分配用途，精确边界由 ELF 与采集记录确定。' },
  { id: 'kernel', start: 0x1000000, end: 0x3000000, en: 'Kernel / boot allocations', zh: '内核及启动期分配', color: '#66a5fa', note: '聚合展示；实际段、页表和内核加载范围应查 ELF 与 capture。' },
  { id: 'ram', start: 0x3000000, end: 0x20000000, en: 'RAM / pages / tasks', zh: '可管理内存、页与进程', color: '#385f79', note: 'initramfs、页缓存、slab、用户页等使用这段 RAM，具体占用边界未知。' },
];

export const virtualRegions = [
  { address: '0xffffffff81000000', en: 'Kernel mapping', zh: '内核映射基址' },
  { address: '0xffff888000000000', en: 'Direct map', zh: '物理内存直接映射' },
  { address: '0xffffea0000000000', en: 'vmemmap', zh: '页描述符数组映射' },
  { address: '0xffffc90000000000', en: 'vmalloc', zh: '动态虚拟地址区' },
  { address: '0xfffffe0000000000', en: 'CPU entry area', zh: 'CPU 异常与中断入口区' },
].map(r => ({ ...r, kind: 'source-inferred', note: '本实验关闭 KASLR；此处按源码标注区域基址，实际映射范围由页表采样确定。' }));

const source = (path, line, symbol) => ({ path, line, symbol });
const K = 'src/linux-6.12.112/';
const B = 'artifacts/build/busybox/';
const BIOS = 'artifacts/build/qemu-source/roms/seabios/src/';
const refs = {
  reset: source(`${BIOS}romlayout.S`, 688, 'reset_vector / entry_post'),
  bios: source(`${BIOS}post.c`, 197, 'maininit'),
  boot: source(`${BIOS}boot.c`, 918, 'boot_cdrom'),
  grub: source('labs/linux-x86_64/grub.cfg', 4, 'menuentry / linux16 / initrd16'),
  setup: source(`${K}arch/x86/boot/main.c`, 133, 'main'),
  pm: source(`${K}arch/x86/boot/pm.c`, 103, 'go_to_protected_mode'),
  jump: source(`${K}arch/x86/boot/pmjump.S`, 24, 'protected_mode_jump'),
  compressed: source(`${K}arch/x86/boot/compressed/head_64.S`, 83, 'startup_32'),
  long: source(`${K}arch/x86/boot/compressed/head_64.S`, 286, 'startup_64'),
  extract: source(`${K}arch/x86/boot/compressed/head_64.S`, 451, '.Lrelocated / extract_kernel'),
  head: source(`${K}arch/x86/kernel/head_64.S`, 38, 'startup_64'),
  headc: source(`${K}arch/x86/kernel/head64.c`, 425, 'x86_64_start_kernel'),
  main: source(`${K}init/main.c`, 874, 'start_kernel'),
  rest: source(`${K}init/main.c`, 673, 'rest_init'),
  pid1: source(`${K}init/main.c`, 1431, 'kernel_init'),
  basic: source(`${K}init/main.c`, 1521, 'kernel_init_freeable'),
  cpio: source(`${K}init/initramfs.c`, 706, 'do_populate_rootfs'),
  init: source('artifacts/build/initramfs/init', 1, '/init'),
  root: source(`${B}util-linux/switch_root.c`, 176, 'switch_root_main'),
  bbinit: source(`${B}init/init.c`, 1039, 'init_main'),
  inittab: source('artifacts/build/rootfs/etc/inittab', 1, 'inittab'),
  rcs: source('artifacts/build/rootfs/etc/rcS', 1, 'rcS'),
  tty: source(`${K}drivers/tty/n_tty.c`, 2158, 'n_tty_read'),
};

const phase = (id, title, en, color, items) => ({ id, title, en, color, steps: items });
// cpu.bits express source-derived bit constraints; full words come from captures.
const micro = (id, title, summary, detail, code, refNames, options = {}) => ({
  id, title, summary, detail, narration: `${title}。${summary}${detail}`,
  code, codeKind: 'teaching-pseudocode', codeNote: '教学简码：根据引用的源码和配置删节、合并或改写；完整原文见源码引用。',
  sourceRefs: refNames.map(name => refs[name]),
  duration: 12, kind: 'source-inferred', cpu: {}, memoryChanges: [], components: [], terminal: [], ...options,
});
export const stages = [
  phase('power', '上电与复位', 'POWER / RESET', '#e8b75c', [
    micro('power-off', '上电前：硬件处于断电状态', '断电时寄存器和 RAM 失去可靠的逻辑值。', 'CPU、RAM、ROM、总线和设备是同时存在的硬件。寄存器与 DRAM 在无电时没有可供 CPU 可靠读取的逻辑值；DRAM 数据随供电中断失去保持。上电后的 DRAM 内容由硬件初始化过程确定。ROM/Flash 和磁盘则能断电保存。\n本实验从 QEMU 已完成复位的状态开始：新建客户机的 RAM 通常由宿主零填充内存提供，固件映像由 QEMU 映射进物理地址空间。客户机 CPU 随后从映射的 ROM 取指。', 'Real hardware: power off ≠ readable zeros\nQEMU: allocate guest RAM; map firmware ROM\nCPU reset: establish initial state, before guest instructions', ['reset'], { kind: 'schematic', cpu: { mode: '未上电', bits: {} }, components: ['cpu', 'rom', 'ram', 'disk'], startupFacts: [
      { label: '复位前', text: '断电 CPU/RAM 失去可靠的逻辑值；CPU 复位建立寄存器初值，热复位可能保留已有 RAM 内容。' },
      { label: '此刻已有', text: '固件在 ROM/Flash 中；本实验由 QEMU 映射 SeaBIOS。boot.iso、bzImage、initramfs 和 ext2 文件保存在存储介质中，随后由固件和引导器按阶段装载。' },
      { label: '固件随后写', text: 'CPU 从复位向量启动后，SeaBIOS 建立栈、IVT（0x0 起）、BDA（0x400 起），探测设备并运行 VGA ROM。' },
      { label: '固件随后读', text: '本机从 boot.iso 读取 El Torito 引导镜像到 RAM，入口停在 0x7c00；/dev/vda 是后续挂载的 ext2 根盘。' },
      { label: 'GRUB 随后读', text: '加载核心与模块；linux16 读 bzImage，initrd16 读压缩 initramfs。建立命令行与引导参数；setup 继续补充 e820 等查询结果。解压出的主内核还要更晚才出现。' },
    ], duration: 24 }),
    micro('reset-vector', '复位：CPU 从哪里取第一条指令', '复位机制在第一条指令执行前建立寄存器初值。', '寄存器是 CPU 内的存储电路，复位信号能把指定状态强制为初值。QEMU 用 CPU 模型的复位函数模拟这一过程；下表展示第一条客户机指令执行前的初始状态。\nCS 选择子为 0xf000，隐藏基址为 0xffff0000，IP=0xfff0，按隐藏基址加偏移得到取指地址 0xfffffff0。下表列出本次真实复位帧的初值；架构规定与 CPU 模型初始化分别注明，未采样字段保留未知。\n复位让 CPU 准备好取指，引导器、Linux 和 initramfs 随后由固件与 GRUB 装入 RAM。此刻 ROM 的指令字节已经存在；表中 RAM 窗口的 00 来自本次 QEMU 初始样本，窗口外未采样。', 'CPU reset (no guest instruction executed):\nCS.selector = 0xf000; CS.base = 0xffff0000\nIP = 0xfff0; CR0 = 0x60000010; FLAGS = 0x2\nfetch = ROM[CS.base + IP] = ROM[0xfffffff0]\nRAM loading by firmware / GRUB happens later', ['reset'], { evidenceKey: 'reset', components: ['cpu', 'rom'], memoryChanges: [{ region: 'rom', action: 'read', text: '从已映射高端 ROM 别名取指；Linux 装载发生在后续引导阶段。' }], duration: 30 }),
    micro('far-jump', '远跳转刷新 CS 缓存', '复位向量中的 FAR JMP 进入 SeaBIOS 入口。', '捕获的前 5 字节为 ea 5b e0 00 f0，按 16 位远跳转解释为 F000:E05B。这个跳转改变 CS 隐藏基址和指令偏移，下一次取指落到低于 1 MiB 的固件窗口。', 'ea 5b e0 00 f0    ; jmp far 0xf000:0xe05b\nCS.base ← 0x000f0000\nIP      ← 0xe05b\nfetch   ← 0x000fe05b', ['reset'], { cpu: { mode: 'real-16', bits: { 'cr0.PE': 0, 'cr0.PG': 0 } }, components: ['cpu', 'rom'], memoryChanges: [{ region: 'rom', action: 'read', text: '执行 SeaBIOS 的 entry_post。' }] }),
  ]),
  phase('bios', 'SeaBIOS 初始化', 'FIRMWARE / BIOS', '#d6a465', [
    micro('bios-stack', '固件建立工作环境', '先有栈与临时数据，固件才能调用更复杂的初始化。', '这是 CPU 复位之后执行的固件代码。实体机器的固件还需初始化内存控制器和 DRAM；QEMU 的客户机 RAM 在机器创建时由宿主内存提供。固件设置工作栈，把初始化代码搬到 RAM，并写临时结构。SeaBIOS 也会进入 32 位模式完成部分初始化，再回到 16 位 BIOS 服务；栈、段和 CR0 的具体中间值未逐条捕获。Linux 由后续 GRUB 阶段装载。', 'entry_post:\n  ENTRY_INTO32 handle_post\n  relocate initialization code\n  maininit()', ['reset', 'bios'], { cpu: { mode: '固件在 16 / 32 位间切换' }, components: ['cpu', 'rom', 'ram'], memoryChanges: [{ region: 'low', action: 'write', text: '固件执行指令，建立工作栈、搬移初始化代码并分配低位临时结构。' }] }),
    micro('bios-tables', '建立 IVT 与 BIOS 数据区', '低地址 0x0000 与 0x0400 开始获得具体用途。', 'IVT 的每个入口保存实模式中断服务的段:偏移；BDA 记录固件使用的设备参数。后来的 64 位 IDT 使用门描述符。内存总览持续标注这些区域的用途。', 'IVT[vector] = { offset16, segment16 }\nBDA         = BIOS device / console state\ninitialize timer, keyboard and firmware services', ['bios'], { components: ['cpu', 'ram', 'keyboard', 'timer'], memoryChanges: [{ region: 'ivt', action: 'write', text: '写入 BIOS 中断向量。' }, { region: 'bda', action: 'write', text: '建立 BIOS 设备数据。' }] }),
    micro('bios-devices', '固件探测设备并运行 VGA ROM', 'CPU 在执行固件代码，设备经总线被初始化。', 'maininit 顺序建立接口、平台与设备，运行 VGA option ROM，启用控制台并准备启动顺序。此刻显示的是固件输出；后续 GRUB 装载 Linux，早期用户空间再挂载根文件系统。', 'interface_init();\nplatform_hardware_setup();\ndevice_hardware_setup();\nvgarom_setup(); enable_vga_console();\nprepareboot(); startBoot();', ['bios'], { components: ['cpu', 'rom', 'vga', 'disk', 'uart'], memoryChanges: [{ region: 'vga', action: 'write', text: '显示固件文字与光标。' }] }),
    micro('boot-image', '把引导镜像送到 0x7c00', '本实验从光盘 ISO 启动；这是实际的第一段引导代码停点。', 'SeaBIOS 的 boot_cdrom 读取 El Torito 启动镜像并调用其入口。真实帧在 0x7c00 停住，IF=1、CR0.PE=0；读取来源是 boot.iso，/dev/vda 留作后续 ext2 根盘。', 'boot_cdrom(drive);\ncdrom_boot(drive);\ncall_boot_entry(load_segment : bootip);\nnext instruction at 0x7c00', ['boot'], { evidenceKey: 'boot', components: ['cpu', 'disk', 'ram'], memoryChanges: [{ region: 'boot', action: 'write', text: '装入并执行引导镜像窗口。' }] }),
  ]),
  phase('grub', 'GRUB 装载', 'BOOT LOADER', '#e8b75c', [
    micro('grub-core', '引导代码继续装入 GRUB', '分阶段加载的目的是突破最初引导窗口的大小限制。', 'GRUB 在 RAM 中执行、通过固件与设备访问 ISO 文件。它会使用保护模式完成工作。此阶段的 GRUB 核心寄存器值未独立采样，数值栏按来源保留最近停点。', 'boot image → GRUB core\nload modules and filesystem support\nread /boot/grub/grub.cfg', ['grub'], { kind: 'schematic', cpu: { mode: 'GRUB 引导器' }, components: ['cpu', 'disk', 'ram'], memoryChanges: [{ region: 'setup', action: 'write', text: '引导器代码、模块与工作区；精确区间未采样。' }] }),
    micro('grub-kernel', 'linux16 装载 bzImage', '磁盘中的内核文件被读入物理内存。', 'grub.cfg 使用 linux16。bzImage 同时包含启动协议头、低位 setup 和高位压缩内核。传给内核的命令行关闭随机布局，启用 VGA 与串口控制台。', 'linux16 /boot/bzImage \\\n  nokaslr norandmaps pti=off \\\n  console=tty0 console=ttyS0,115200 \\\n  rdinit=/init loglevel=5', ['grub'], { components: ['cpu', 'disk', 'ram'], memoryChanges: [{ region: 'setup', action: 'write', text: '装入 setup 与引导参数。' }, { region: 'decompressor', action: 'write', text: '压缩内核进入 RAM，后续解压生成最终运行映像。' }] }),
    micro('grub-initrd', 'initrd16 装载早期用户空间', 'initramfs 以压缩归档形式保存在 RAM 中。', 'GRUB 将 initramfs.cpio.gz 放到可用 RAM，并在引导参数中记录起点和长度。归档里有 /init、BusyBox、挂载点等。装载文件与内核解包归档是两个不同动作。', 'initrd16 /boot/initramfs.cpio.gz\nboot_params.hdr.ramdisk_image ← physical start\nboot_params.hdr.ramdisk_size  ← byte length', ['grub'], { components: ['disk', 'ram'], memoryChanges: [{ region: 'ram', action: 'write', text: '存放压缩 cpio 归档；本步骤的精确起点未采样。' }] }),
    micro('boot-params', '交接清单：boot_params', '内存地图、命令行和 initrd 位置必须一起交给内核。', 'boot_params 是 4096 字节引导参数结构。引导器按 Linux 启动协议准备 CPU 模式、段、栈和交接数据，再跳到入口。源码中 setup 还会补充 BIOS 查询结果。', 'boot_params = {\n  hdr: { code32_start, cmd_line_ptr, ramdisk_image, ramdisk_size },\n  e820_table: memory ranges,\n  screen_info: console information\n}', ['setup', 'grub'], { components: ['cpu', 'ram'], memoryChanges: [{ region: 'setup', action: 'write', text: '保存跨引导器/内核的交接数据。' }] }),
  ]),
  phase('setup', '16 位 setup', 'REAL MODE SETUP', '#a789ef', [
    micro('setup-main', 'setup.main 收集硬件信息', '最后利用 BIOS 服务获得内核需要的启动信息。', 'main 负责复制参数、检查 CPU、检测内存并配置视频。本机实际停点位于 0x91171，CS 隐藏基址为 0x90000，CR0.PE=0；地址和指令字节已与当前构建的 setup ELF 核对。这里采到的是函数入口，后续步骤再观察初始化结果。', 'copy_boot_params(); console_init(); init_heap();\nvalidate_cpu(); set_bios_mode();\ndetect_memory(); keyboard_init();\nquery_ist(); set_video();', ['setup'], { cpu: { mode: 'real-16 / 源码阶段', bits: { 'cr0.PE': 0, 'cr0.PG': 0 } }, components: ['cpu', 'ram', 'rom'], memoryChanges: [{ region: 'setup', action: 'write', text: '整理 boot_params，记录 BIOS 查询结果。' }] }),
    micro('setup-e820', '探测 e820：哪些地址是真 RAM', 'e820 区分可分配 RAM 与固件、设备保留区。', '内存地图把可用 RAM、固件保留区、ACPI 等区间区分开。低位 VGA/ROM 窗口属于设备和固件映射。网格按源码标注物理范围与用途，实测字节另见采样窗口。', 'detect_memory();\nfor each BIOS e820 entry:\n  boot_params.e820_table += { start, size, type };', ['setup'], { components: ['cpu', 'ram', 'rom'], memoryChanges: [{ region: 'setup', action: 'write', text: 'e820 表存放在引导参数中。' }] }),
    micro('setup-a20', '关闭中断，确保 A20 可用', '离开 BIOS 环境前，先屏蔽实模式中断入口。', 'go_to_protected_mode 调用实模式切换钩子、使能 A20、复位协处理器并屏蔽 PIC。A20 使地址线第 20 位参与寻址，允许访问超过 1 MiB 的地址；保护模式由 CR0.PE 控制。', 'realmode_switch_hook();  // normally CLI, disable NMI\nenable_a20();\nreset_coprocessor();\nmask_all_interrupts();', ['pm'], { cpu: { mode: 'real-16', bits: { 'rflags.IF': 0, 'cr0.PE': 0, 'cr0.PG': 0 } }, components: ['cpu', 'interrupt', 'ram'] }),
    micro('setup-gdt', '装入 GDT，准备新的代码段', '保护模式的 CS/DS 是描述符选择子。', 'GDT 内有 32 位代码段、数据段与用于兼容性的 TSS 描述符。LGDT 装入表地址与界限；后续段装载和远跳转刷新对应段缓存。setup 还临时装入空 IDT。', 'setup_idt();   // LIDT: base=0, limit=0\nsetup_gdt();   // LGDT: boot GDT\nprotected_mode_jump(code32_start, boot_params);', ['pm'], { cpu: { mode: 'real-16 → protected-32', bits: { 'rflags.IF': 0, 'cr0.PG': 0 } }, components: ['cpu', 'ram'], memoryChanges: [{ region: 'setup', action: 'write', text: '启动 GDT 与相关指针。' }] }),
  ]),
  phase('protected', '32 位保护模式', 'PROTECTED MODE', '#a789ef', [
    micro('set-pe', 'CR0.PE 置 1', '模式切换由具体控制位和远跳转共同完成。', 'protected_mode_jump 置 CR0.PE，再通过远跳转装入 32 位代码段，随后装载数据段与栈。此时 CR0.PG=0，线性地址直接用于物理寻址。', 'mov %cr0, %edx\nor  $X86_CR0_PE, %dl\nmov %edx, %cr0\nfar jump → 32-bit code segment', ['jump', 'pm'], { cpu: { mode: 'protected-32', bits: { 'cr0.PE': 1, 'cr0.PG': 0, 'rflags.IF': 0 } }, components: ['cpu', 'ram'] }),
    micro('startup32', '到达压缩内核 startup_32', '真实停点：物理地址 0x100000，PE=1、PG=0。', 'CPU 此时运行解压器，后续跳入主内核。抓到的 CS=0x10、DS/SS=0x18，CR3=0，EFER=0。ESI 传递 boot_params，栈供解压器使用。所有一般寄存器可在全景中逐个检查。', 'startup_32:\n  cld\n  cli\n  establish position-independent working base\n  verify_cpu()', ['compressed'], { evidenceKey: 'startup32', components: ['cpu', 'ram'], memoryChanges: [{ region: 'decompressor', action: 'execute', text: '取指落在压缩镜像入口。' }] }),
    micro('decompress-placement', '计算搬移与解压的目标位置', '输入压缩包、解压器与输出内核分别占用安全的工作区。', '代码依据内核对齐值、加载物理地址与 init_size 计算解压器搬移位置。寄存器承担地址与长度计算，具体地址由本次构建和装载结果确定。', 'target = aligned physical load address\nrelocation = target + boot_params.hdr.init_size - image_end\nreserve working stack and temporary page tables', ['compressed'], { cpu: { mode: 'protected-32', bits: { 'cr0.PE': 1, 'cr0.PG': 0 } }, components: ['cpu', 'ram'], memoryChanges: [{ region: 'decompressor', action: 'write', text: '确定工作区、搬移区和输出区域；精确边界以构建和捕获为准。' }] }),
  ]),
  phase('long', '进入 64 位', 'LONG MODE TRANSITION', '#9f8af2', [
    micro('enable-pae', '第一步：CR4.PAE = 1', '先允许长模式需要的分页结构。', 'startup_32 从 CR4 读出原值，仅 OR 上 PAE 位再写回。此刻 CR0.PG=0，CPU 继续执行 32 位保护模式代码。', 'movl %cr4, %eax\norl  $X86_CR4_PAE, %eax\nmovl %eax, %cr4', ['compressed'], { cpu: { mode: 'protected-32', bits: { 'cr0.PE': 1, 'cr0.PG': 0, 'cr4.PAE': 1, 'efer.LME': 0 } }, components: ['cpu'] }),
    micro('identity-pages', '第二步：在 RAM 建临时页表', '最初的映射让地址切换后仍能找到同一段代码。', '源码清空启动页表并建立覆盖早期 4 GiB 的恒等映射。本路径使用 2 MiB 大页，地址沿 PML4 → PDPT → PD 翻译，PD 大页表项直接给出物理页基址。映射覆盖范围与实际 RAM 容量分别由页表和机器配置确定。', 'zero boot page tables\nPML4[0] → PDPT\nPDPT[0..3] → page directories\nPD[0..2047] = physical 2 MiB pages | flags', ['compressed'], { cpu: { mode: 'protected-32', bits: { 'cr4.PAE': 1, 'cr0.PG': 0 } }, components: ['cpu', 'mmu', 'ram'], memoryChanges: [{ region: 'decompressor', action: 'write', text: '源码描述在 RAM 建立页表；图中表项展示机制，实测窗口另列来源。' }] }),
    micro('load-cr3', '第三步：CR3 指向页表根', '页表放在 RAM；CR3 保存根的物理地址。', '写入 CR3 后，PG 仍然为 0，当前线性地址直接用于物理寻址。页表根、页表项和最终数据页面分别记录与观察。', 'lea boot_page_table, %eax\nmov %eax, %cr3\n// CR3 is prepared; paging is still disabled', ['compressed'], { cpu: { mode: 'protected-32', bits: { 'cr4.PAE': 1, 'cr0.PG': 0 } }, components: ['cpu', 'mmu', 'ram'] }),
    micro('enable-lme', '第四步：EFER.LME = 1', '设置长模式允许位，等待分页激活。', 'ECX 选择 EFER MSR，RDMSR 读出后设置 LME，再 WRMSR 写回。此刻 LME=1、LMA=0、PG=0；LMA 由后续硬件激活过程更新，CS.L 由代码段装载更新。', 'mov $MSR_EFER, %ecx\nrdmsr\nbts $_EFER_LME, %eax\nwrmsr', ['compressed'], { cpu: { mode: 'protected-32', bits: { 'cr4.PAE': 1, 'efer.LME': 1, 'efer.LMA': 0, 'cr0.PG': 0 } }, components: ['cpu'] }),
    micro('enable-paging', '第五步：CR0.PG = 1', '分页生效，硬件激活长模式环境。', '满足 PE、PAE、LME 条件后写 CR0_STATE。此时硬件报告 EFER.LMA=1，当前 CS 属性仍可以选择 32 位兼容子模式；后续装载 L=1 的代码段进入 64 位执行。', 'pushl $__KERNEL_CS\npushl $startup_64\nmovl  $CR0_STATE, %eax\nmovl  %eax, %cr0  // PG=1, PE=1\n// LMA=1, current CS may still select compatibility mode', ['compressed'], { cpu: { mode: 'long mode / 32 位兼容子模式', bits: { 'cr0.PE': 1, 'cr0.PG': 1, 'cr4.PAE': 1, 'efer.LME': 1, 'efer.LMA': 1 } }, components: ['cpu', 'mmu', 'ram'] }),
    micro('startup64', '第六步：远返回进入 64 位代码', '真实停点：startup_64 = 0x100200。', 'LRET 装入 CS.L=1 的代码段。这个帧证明 PE=1、PG=1、PAE=1、LME=1、LMA=1，同时给出本次真实页表根地址。名称 startup_64 既存在于解压器也存在于主内核；此处仍是解压器。', 'lret\n.code64\nstartup_64:       // compressed image, +0x200\n  cld\n  cli', ['long'], { evidenceKey: 'startup64', components: ['cpu', 'mmu', 'ram'], memoryChanges: [{ region: 'decompressor', action: 'execute', text: '64 位解压器入口；尚未进入主内核。' }] }),
  ]),
  phase('extract', '解压内核', 'EXTRACT KERNEL', '#a789ef', [
    micro('relocate', '搬移解压器，保留输出空间', '从高地址向低地址复制，保持待搬移数据完整。', '解压器建立自己的栈、校正 GDT 指针并搬移代码。源码中 STD 和 REP MOVSQ 让复制地址递减，随后 CLD 恢复递增方向。DF 的改变由指令语义推导；这一瞬间的完整寄存器值未采样。', 'std\nrep movsq   // copy backwards\ncld         // restore DF=0\nlgdt relocated_gdt\njmp relocated_code', ['long', 'extract'], { cpu: { mode: 'long-64', bits: { 'rflags.DF': 0, 'cr0.PG': 1, 'efer.LMA': 1 } }, components: ['cpu', 'ram'], memoryChanges: [{ region: 'decompressor', action: 'write', text: '搬移解压器自身，更新栈和 GDT。' }] }),
    micro('extract-kernel', '清 BSS，解压到最终物理地址', '压缩文件变成 CPU 可直接执行的内核段。', '先清空解压器 BSS，建立身份映射和异常处理，再调用 extract_kernel。输出包含代码、只读数据、可写数据等，并为 BSS 建立零初始化。内存占用按 ELF 装载段及运行期分配确定。', 'clear decompressor BSS\nload_stage2_idt();\ninitialize_identity_maps(boot_params);\nentry = extract_kernel(boot_params, output_address);', ['extract'], { cpu: { mode: 'long-64', bits: { 'cr0.PG': 1, 'efer.LMA': 1, 'rflags.DF': 0 } }, components: ['cpu', 'ram', 'mmu'], memoryChanges: [{ region: 'kernel', action: 'write', text: '写入解压后的内核运行映像。' }] }),
    micro('jump-kernel', '跳入主内核 startup_64', '控制权离开解压器；RSI 继续交接 boot_params。', 'extract_kernel 返回入口地址放在 RAX，汇编恢复 RSI 并间接跳转。两个 startup_64 同名但位于不同可执行体，分别引用解压器与主内核的源码位置。', 'RAX ← decompressed kernel entry\nRSI ← boot_params\njmp *%rax  // kernel/head_64.S:startup_64', ['extract', 'head'], { cpu: { mode: 'long-64', bits: { 'cr0.PG': 1, 'efer.LMA': 1 } }, components: ['cpu', 'ram'], memoryChanges: [{ region: 'kernel', action: 'execute', text: '开始执行主内核汇编代码。' }] }),
  ]),
  phase('entry', '主内核入口', 'KERNEL ENTRY', '#66a5fa', [
    micro('kernel-tables', '主内核建立自己的页表与栈', '临时身份映射逐步让位于内核地址布局。', 'head_64.S 设置 GDT/IDT、校正早期页表并写 CR3；代码随后转入高地址映射。CPU 的虚拟 RIP 通过页表指向内核物理页，RSP 指向内核栈。', 'startup_64_setup_gdt_idt();\nroot = __startup_64(physical_load, boot_params);\nmov root, %cr3\ncontinue through kernel virtual mapping', ['head'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'cr0.PE': 1, 'cr0.PG': 1, 'cr4.PAE': 1, 'efer.LMA': 1 } }, components: ['cpu', 'mmu', 'ram'], memoryChanges: [{ region: 'kernel', action: 'write', text: '内核页表、启动栈和描述符表。' }] }),
    micro('kernel-gs', 'GS、系统调用与异常环境准备', 'GS.base 为每 CPU 数据提供快速入口。', '主内核入口设置段寄存器与 GS 基址，随后初始化 EFER 的 SYSCALL 与 NX 等能力。GS 选择子可以为 0，而隐藏基址有有效地址；全景分别展示选择子和隐藏基址。具体打开的位依 CPU 与内核配置。', 'load kernel segment selectors\nwrite GS.base → per-CPU data\nconfigure EFER and early exception support\nRSP → initial kernel stack', ['head'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'cr0.PG': 1, 'efer.LMA': 1 } }, components: ['cpu', 'ram', 'interrupt'] }),
    micro('copy-bootdata', '进入 C 代码，复制引导数据', '早期临时位置的数据需要保存到内核拥有的结构里。', 'x86_64_start_kernel 清 BSS、建立早期映射和异常处理，把 boot_params 与命令行复制到内核结构，之后进入 x86_64_start_reservations。C 执行环境已建立，进程、内存分配器和设备体系由后续初始化建设。', 'x86_64_start_kernel(real_mode_data);\ncopy_bootdata(__va(real_mode_data));\nx86_64_start_reservations(real_mode_data);\nstart_kernel();', ['headc'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'cr0.PG': 1, 'efer.LMA': 1 } }, components: ['cpu', 'ram'], memoryChanges: [{ region: 'kernel', action: 'write', text: '内核自己的 boot_params、命令行和 BSS。' }] }),
    micro('start-kernel', '真实停点：start_kernel', '通用初始化总入口；当前任务仍为 PID 0。', '这里采集到的 RIP 与源码 init/main.c 对应。CR3、CR4、EFER 记录此停点的页表与功能配置，任务信息按当前帧展示；后续 rest_init 创建 PID 1 和 PID 2。', 'asmlinkage void start_kernel(void)\n{\n  set_task_stack_end_magic(&init_task);\n  ...\n}', ['main'], { evidenceKey: 'startKernel', components: ['cpu', 'ram', 'mmu'], memoryChanges: [{ region: 'kernel', action: 'execute', text: '架构无关内核启动总入口。' }] }),
  ]),
  phase('core', '建设内核基础设施', 'KERNEL INITIALIZATION', '#66a5fa', [
    micro('irq-disable', '保持 IF=0，先建设再接收中断', '先建立中断处理设施，再开放可屏蔽中断。', 'start_kernel 显式 local_irq_disable 并记录 early_boot_irqs_disabled。IF=0 屏蔽外部可屏蔽中断；同步异常独立触发，早期缺页处理仍参与启动。', 'local_irq_disable();   // RFLAGS.IF = 0\nearly_boot_irqs_disabled = true;\nboot_cpu_init();\nsetup_arch(&command_line);', ['main'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'rflags.IF': 0, 'cr0.PG': 1, 'efer.LMA': 1 } }, components: ['cpu', 'interrupt', 'ram'] }),
    micro('memblock', 'setup_arch：登记可用与保留内存', '从固件清单，变成 Linux 的内存账本。', 'setup_arch 解析引导参数与 e820，把可用区间交给 memblock，并保留内核、initrd、页表和固件等占用。memblock 维护早期可用与保留区间，后续伙伴系统管理页面分配。', 'setup_arch(&command_line);\nread BIOS e820 memory map\nreserve kernel / initrd / firmware / page tables\nbuild direct physical-memory mapping', ['main'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'rflags.IF': 0 } }, components: ['cpu', 'ram', 'mmu'], memoryChanges: [{ region: 'kernel', action: 'write', text: 'memblock 区间与映射元数据。' }, { region: 'ram', action: 'reserve', text: '按源码区分可用页和保留页；精确逐页占用未采样。' }] }),
    micro('memory-allocators', 'mm_core_init：从区间走向页分配', 'struct page、伙伴系统和 slab 支持后续对象分配。', '内核逐步建立页描述符、页分配与对象缓存体系。随后创建进程、文件对象或页表都会申请内存。全局网格按源码标注这些 RAM 用途，具体页面变化由采样窗口另列。', 'trap_init();\nmm_core_init();\n// physical pages + page metadata + object allocation\n// boot-reserved regions remain protected', ['main'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'rflags.IF': 0 } }, components: ['cpu', 'ram', 'mmu'], memoryChanges: [{ region: 'ram', action: 'allocate', text: '页元数据、分配器与内核对象。' }] }),
    micro('scheduler', 'sched_init：有了可调度任务的基础', '调度器先建立，定时中断稍后才能安全驱动它。', '初始任务 PID 0 来自静态 init_task。sched_init 建立运行队列等结构；本实验单 vCPU，任意瞬间只执行一个任务。', 'sched_init();\nradix_tree_init(); maple_tree_init();\nworkqueue_init_early();\nrcu_init();', ['main'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'rflags.IF': 0 } }, components: ['cpu', 'scheduler', 'ram'], memoryChanges: [{ region: 'kernel', action: 'write', text: '运行队列与调度基础结构。' }] }),
    micro('irq-timers', '建立 IRQ、时钟与定时器', '中断门、控制器与计时设施需要协同就绪。', 'init_IRQ、tick_init、init_timers、hrtimers_init 与 time_init 建立中断和时钟基础。IDT 保存处理入口，PIC/APIC 交付外部中断；客户机时钟由计时硬件和内核维护，网页计时器控制教学节奏。', 'early_irq_init(); init_IRQ();\ntick_init(); init_timers();\nhrtimers_init(); softirq_init();\ntimekeeping_init(); time_init();', ['main'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'rflags.IF': 0 } }, components: ['cpu', 'interrupt', 'timer', 'ram'], memoryChanges: [{ region: 'kernel', action: 'write', text: '中断描述符、IRQ 与定时器对象。' }] }),
    micro('irq-enable', '开中断：RFLAGS.IF 变为 1', '具备必要设施后，才允许外部可屏蔽中断进入。', 'start_kernel 在 time_init 等工作之后 local_irq_enable。IF=1 允许响应可屏蔽中断；实际交付取决于中断控制器、优先级、屏蔽和待处理事件。', 'early_boot_irqs_disabled = false;\nlocal_irq_enable();   // STI, RFLAGS.IF = 1\nkmem_cache_init_late();\nconsole_init();', ['main'], { cpu: { mode: 'long-64 / CPL 0', bits: { 'rflags.IF': 1 } }, components: ['cpu', 'interrupt', 'timer', 'vga', 'uart'] }),
    micro('vfs-process-core', '进程、VFS 与缓存准备完成', '为创建 PID 1 和访问文件做准备。', 'fork_init、proc_caches_init、vfs_caches_init、pagecache_init、signals_init 等建立进程、文件与信号的基础。文件系统模块、设备探测和根盘挂载还有后续 initcall 与早期用户空间工作。', 'fork_init(); proc_caches_init();\nvfs_caches_init(); pagecache_init();\nsignals_init(); proc_root_init();\nrest_init();', ['main'], { cpu: { mode: 'long-64 / CPL 0' }, components: ['cpu', 'scheduler', 'ram', 'filesystem'], memoryChanges: [{ region: 'ram', action: 'allocate', text: '进程、VFS、页缓存和信号相关对象。' }] }),
  ]),
  phase('pid1', '创建 PID 1', 'FIRST TASKS', '#42d6b4', [
    micro('spawn-init', 'rest_init 创建第一个可运行的 init 任务', 'PID 1 先在内核态执行 kernel_init。', 'rest_init 先用 user_mode_thread(kernel_init) 创建 PID 1，再用 kernel_thread(kthreadd) 创建 PID 2。PID 1 先执行内核初始化，后续 exec 装入用户程序并返回 CPL 3。', 'pid = user_mode_thread(kernel_init, NULL, CLONE_FS);\npid = kernel_thread(kthreadd, ...);\ncomplete(&kthreadd_done);', ['rest'], { cpu: { mode: 'long-64 / CPL 0' }, components: ['cpu', 'scheduler', 'ram'], memoryChanges: [{ region: 'ram', action: 'allocate', text: '新 task_struct、内核栈与任务管理结构。' }] }),
    micro('first-schedule', 'PID 0 让出 CPU，进入 idle 路径', '一颗 CPU 通过切换任务推进多个启动活动。', 'schedule_preempt_disabled 调用调度器，PID 0 随后进入 cpu_startup_entry。任务切换保存与恢复上下文，页表切换由 mm/active_mm 和目标地址空间决定。', 'schedule_preempt_disabled();\ncpu_startup_entry(CPUHP_ONLINE);\n// context switch restores next task stack / saved registers', ['rest'], { cpu: { mode: 'long-64 / CPL 0' }, components: ['cpu', 'scheduler', 'ram'] }),
    micro('kernel-init', '真实停点：PID 1 的 kernel_init', '任务号为 1，mm 为空，当前执行内核初始化。', '该真实帧的解码器识别 PID 1、内核栈与 task_struct；comm 此时显示 swapper/0，任务身份由 pid 字段确定。随后它等待 kthreadd 准备好，执行 kernel_init_freeable。', 'kernel_init(void *unused)\n{\n  wait_for_completion(&kthreadd_done);\n  kernel_init_freeable();\n  ...\n}', ['pid1'], { evidenceKey: 'kernelInit', components: ['cpu', 'scheduler', 'ram'] }),
  ]),
  phase('userspace', '驱动与 initramfs', 'DRIVERS / EARLY USERSPACE', '#42d6b4', [
    micro('initcalls', '执行 initcalls，驱动开始探测', '注册驱动、发现 virtio 设备并创建内核对象。', 'kernel_init_freeable → do_basic_setup → do_initcalls。initcall 按等级运行，驱动的注册与设备绑定可能涉及异步工作。virtio-blk 根盘需要内核驱动就绪；这里只讲启动依赖，队列细节留给设备专题。', 'kernel_init_freeable();\n  do_basic_setup();\n    driver_init();\n    do_initcalls();\n// virtio-blk driver binds the root disk', ['basic'], { cpu: { mode: 'long-64 / CPL 0' }, components: ['cpu', 'disk', 'ram', 'interrupt'], memoryChanges: [{ region: 'ram', action: 'allocate', text: '驱动、设备、virtqueue 等对象；地址未逐项采样。' }] }),
    micro('unpack-initramfs', '把压缩 cpio 解成内存文件树', 'GRUB 装进来的字节，此时变成可打开的文件。', 'populate_rootfs 通过异步域调用 do_populate_rootfs；unpack_to_rootfs 创建目录、文件和链接，PID 1 的后续代码 wait_for_initramfs 等待完成。initramfs 内容占用 RAM，作为挂载 ext2 根盘之前的临时 rootfs。', 'populate_rootfs();\n  async_schedule_domain(do_populate_rootfs, ...);\n  unpack_to_rootfs(initrd_start, initrd_size);\nwait_for_initramfs();', ['cpio', 'basic'], { cpu: { mode: 'long-64 / CPL 0' }, components: ['cpu', 'ram', 'filesystem'], memoryChanges: [{ region: 'ram', action: 'write', text: 'rootfs 中的 /init、BusyBox、目录与链接。' }] }),
    micro('console-and-initmem', '打开控制台并回收启动专用内存', '标准输入输出就绪后，准备首次执行用户空间。', 'console_on_rootfs 打开 /dev/console 并建立 0、1、2 三个文件描述符。kernel_init 等待异步初始化结束，释放可回收的启动专用 initmem，并为常驻内核页面设置只读权限。', 'console_on_rootfs();\nasync_synchronize_full();\nfree_initmem(); mark_readonly();\nsystem_state = SYSTEM_RUNNING;', ['basic', 'pid1'], { cpu: { mode: 'long-64 / CPL 0' }, components: ['cpu', 'ram', 'vga', 'uart', 'filesystem'], memoryChanges: [{ region: 'kernel', action: 'free', text: '释放可回收的 __init 段，收紧内核映射权限。' }] }),
    micro('exec-init', 'PID 1 首次 exec：/init', '任务身份保留，地址空间装入用户态的 BusyBox shell。', 'rdinit=/init 指定早期用户空间入口。run_init_process 最终调用 kernel_execve；脚本解释器为 /bin/sh。内核装入可执行段、用户栈和参数，返回用户态时 CPL=3；在 exec 的内核函数内部仍是 CPL=0。', 'run_init_process("/init");\n  kernel_execve("/init", argv_init, envp_init);\n// shebang: #!/bin/sh\n// map executable + user stack; return to user mode', ['pid1', 'init'], { cpu: { mode: 'long-64 / 用户态与系统调用交替' }, components: ['cpu', 'mmu', 'ram', 'filesystem'], memoryChanges: [{ region: 'ram', action: 'allocate', text: 'PID 1 的用户代码映射、栈与页表。' }] }),
  ]),
  phase('root', '挂载根盘并切根', 'ROOT FILESYSTEM', '#69cbb7', [
    micro('init-mounts', '/init 挂载 /dev、/proc 与 /sys', '进程执行脚本，通过系统调用让内核提供三种视图。', 'devtmpfs 暴露设备节点，proc 暴露进程与内核运行信息，sysfs 暴露设备模型。这些虚拟文件系统由内核动态提供内容。/init 等待 /dev/vda 出现后再挂载根盘。', '/bin/mount -t devtmpfs devtmpfs /dev\n/bin/mount -t proc proc /proc\n/bin/mount -t sysfs sysfs /sys\nwhile [ ! -b /dev/vda ]; do /bin/sleep 0.1; done', ['init'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'filesystem', 'disk', 'ram'], memoryChanges: [{ region: 'ram', action: 'allocate', text: '挂载对象、dentry 与设备视图。' }] }),
    micro('mount-ext2', '真实停点：ext2_fill_super', '用户 mount 已进入内核；当前任务是 mount，CPL=0。', '这个帧记录用户 mount 任务通过系统调用执行 ext2_fill_super，任务身份保持，CPU 处于 CPL 0。virtio 读盘产生的数据进入 RAM，文件系统验证元数据并建立 VFS 对象。/dev/vda 是持久化根盘。', '/bin/mount -t ext2 /dev/vda /newroot\n// syscall → VFS → ext2_fill_super\n// virtio-blk supplies disk blocks', ['init'], { evidenceKey: 'ext2', components: ['cpu', 'disk', 'filesystem', 'ram'], memoryChanges: [{ region: 'ram', action: 'write', text: '块缓存、superblock、inode 与 dentry。' }] }),
    micro('move-mounts', '把系统视图移动到新根', '切换 / 之前先保留已经挂好的设备与系统信息。', 'mount --move 调整 /dev、/proc、/sys 在挂载树中的位置，保留各挂载的内容与对象。随后 exec switch_root，PID 1 保持，脚本解释器的用户映像将被替换。', '/bin/mount --move /dev /newroot/dev\n/bin/mount --move /proc /newroot/proc\n/bin/mount --move /sys /newroot/sys\nexec /bin/switch_root /newroot /sbin/init', ['init'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'filesystem', 'ram'], memoryChanges: [{ region: 'ram', action: 'write', text: '移动挂载对象，更新挂载树关系。' }] }),
    micro('switch-root', 'switch_root：/ 变成 ext2 根', 'PID 1 保持，根目录和可执行程序发生变化。', 'BusyBox switch_root 要求当前进程为 PID 1、目标新根是挂载点、当前根为 ramfs/tmpfs。它删除当前 rootfs 内容，移动新根挂载，chroot 后 exec /sbin/init。可回收的 initramfs 内容随删除释放。', 'delete_contents("/", old_rootdev);\nmount(".", "/", NULL, MS_MOVE, NULL);\nchroot(".");\nexecv("/sbin/init", argv);  // PID still 1', ['root'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'filesystem', 'ram', 'disk'], memoryChanges: [{ region: 'ram', action: 'free', text: '释放切根前 rootfs 的可回收内容；装入 ext2 根上的 init 映像。' }] }),
  ]),
  phase('init', 'BusyBox init 拉起程序', 'SYSTEM INIT', '#42d6b4', [
    micro('busybox-init', '/sbin/init 读取 inittab', '根盘上的 PID 1 开始管理系统服务与终端。', '本实验使用 BusyBox init。它解析 /etc/inittab，按动作类型先执行 sysinit，再执行 wait、once，最后维护 respawn 与 askfirst。', 'parse_inittab();\nrun_actions(SYSINIT);\nrun_actions(WAIT); run_actions(ONCE);\nrun_actions(RESPAWN | ASKFIRST);', ['bbinit', 'inittab'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'scheduler', 'filesystem', 'ram'] }),
    micro('rcs', '/etc/rcS 建立实验环境', '挂载调试视图、设置主机名，再输出欢迎信息。', 'rcS 创建 /dev/pts、debugfs 和 tracefs 挂载点，设置 hostname 为 linux-lab。脚本中的 mount、mkdir、hostname 等命令通过内核接口完成挂载、目录创建与主机名设置。', 'mount -t devpts devpts /dev/pts\nmount -t debugfs debugfs /sys/kernel/debug\nmount -t tracefs tracefs /sys/kernel/tracing\nhostname linux-lab\nprintf "Linux Observatory / Linux 6.12.112"', ['rcs'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'filesystem', 'vga', 'uart', 'ram'], terminal: ['Linux Observatory / Linux 6.12.112', 'Real kernel, real processes, real virtio disk.', 'Try: cat /data/hello.txt; lab-read; lab-memory; lab-cow'] }),
    micro('spawn-terminals', '两个终端入口采用不同策略', 'tty1 等回车；ttyS0 直接运行 shell 并支持重启。', '实际配置是 tty1::askfirst:/bin/sh -l 与 ttyS0::respawn:/bin/cttyhack /bin/sh -l。cttyhack 为串口 shell 建立控制终端环境，init 通过 fork/exec 创建子进程，并等待或回收它们。', 'tty1::askfirst:/bin/sh -l\nttyS0::respawn:/bin/cttyhack /bin/sh -l\n// tty1: press Enter before shell\n// ttyS0: start shell, restart on exit', ['inittab', 'bbinit'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'scheduler', 'vga', 'uart', 'keyboard', 'ram'], memoryChanges: [{ region: 'ram', action: 'allocate', text: '终端 shell 子进程、用户栈、文件描述符。' }] }),
    micro('login-shell', '登录 shell 读取环境并打印提示符', '可输入命令的界面终于建立。', '/bin/sh -l 运行 BusyBox shell。用户代码通过 write 输出提示符，通过终端读取路径等待输入。系统运行配置中的 init、必要内核线程与终端程序，进程采样列出实际任务。', '/bin/sh -l\nread login shell configuration\nwrite(1, "linux-lab:/root# ", ...);\nread(0, input_buffer, ...);', ['inittab'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'uart', 'keyboard', 'filesystem', 'ram'], terminal: ['linux-lab:/root# '], duration: 15 }),
  ]),
  phase('shell', '终端等待输入', 'READY / IDLE', '#42d6b4', [
    micro('tty-read', 'shell 先 poll 等待终端可读', '先等待输入就绪，再读取字符。', '本构建的 BusyBox 行编辑器先调用 poll 检查标准输入，输入就绪后才调用 read。真实停点位于 n_tty_poll，当前任务为串口 shell、CPL=0。它是检查可读状态的入口；随后等待队列和调度器让 shell 休眠，CPU 可以运行其他任务或进入 idle。', 'shell: poll(fd=0, POLLIN, timeout);\nkernel: n_tty_poll → register wait queue\nno input → scheduler → another task or idle\ninput ready → read(0, buffer, ...)', ['tty'], { cpu: { mode: 'long-64 / CPL 3 ↔ 0' }, components: ['cpu', 'scheduler', 'uart', 'keyboard', 'interrupt'], duration: 14 }),
    micro('shell-ready', '真实终点：提示符已出现，CPU 正在 idle', '当前 CPU 任务可以是 PID 0，而 shell 已在等待输入。', '本样本串口出现 linux-lab:/root#。暂停时 CPU 位于内核 idle 路径、CPL=0，PID 1 为睡眠中的 init。串口记录证明系统到达可输入终端，寄存器帧记录暂停瞬间的 idle 任务。', 'serial output: linux-lab:/root#\ncurrent CPU task: swapper/0 (PID 0)\nPID 1: init, sleeping\nCPU: idle path, CPL 0', ['rest', 'inittab'], { evidenceKey: 'shell', components: ['cpu', 'scheduler', 'uart', 'keyboard', 'ram'], terminal: ['linux-lab:/root# '], duration: 18 }),
    micro('next-key', '下一次输入将如何穿过全景', '终端输入 → 设备 → 中断 → TTY → shell。', '串口或键盘把输入送入设备，内核读取并交给 TTY，达到读取条件后唤醒 shell。shell 解析命令，内建命令可直接执行，外部程序通常通过 fork/exec。本步骤以机制示意预览后续输入路径，实际输入在真实调试会话中进行。', 'input → UART / i8042\nIRQ → driver → TTY buffer\nwake_up(reader) → scheduler → shell\nparse command → builtin or fork / exec', ['tty', 'inittab'], { kind: 'schematic', cpu: { mode: '等待输入后的下一条路径' }, components: ['uart', 'keyboard', 'interrupt', 'scheduler', 'cpu'], duration: 16 }),
  ]),
];

// Precise statement locations for the source drawer. Narration remains fixed.
const exactSourceLines = {
  'enable-pae': [['compressed', 169]], 'identity-pages': [['compressed', 199]],
  'load-cr3': [['compressed', 236]], 'enable-lme': [['compressed', 239]],
  'enable-paging': [['compressed', 273]], 'startup64': [['compressed', 281], ['long', 286]],
  'relocate': [['long', 430]], 'extract-kernel': [['extract', 465]],
  'jump-kernel': [['extract', 477], ['head', 38]],
  'kernel-tables': [['head', 104]], 'kernel-gs': [['head', 348]],
  'copy-bootdata': [['headc', 478]], 'start-kernel': [['main', 874]],
  'irq-disable': [['main', 886]], 'memblock': [['main', 896]],
  'memory-allocators': [['main', 934]], 'scheduler': [['main', 947]],
  'irq-timers': [['main', 978]], 'irq-enable': [['main', 1001]],
  'vfs-process-core': [['main', 1052]], 'spawn-init': [['rest', 684]],
  'first-schedule': [['rest', 717]], 'kernel-init': [['pid1', 1438]],
  'initcalls': [['basic', 1551], ['basic', 1331]],
  'unpack-initramfs': [['cpio', 721], ['basic', 1555]],
  'console-and-initmem': [['basic', 1555], ['pid1', 1442]],
  'exec-init': [['pid1', 1465], ['pid1', 1349], ['init', 1]],
  'tty-read': [['tty', 2458]],
  'mount-ext2': [['init', 6]], 'move-mounts': [['init', 7]],
  'switch-root': [['root', 251]], 'busybox-init': [['bbinit', 1182]],
};
function preciseReferences(step) {
  return exactSourceLines[step.id]?.map(([key, line]) => ({ ...refs[key], line })) || step.sourceRefs;
}

const sampledStepKeys = { 'decompress-placement': 'paeBefore', 'enable-pae': 'paeAfter', 'identity-pages': 'pagesBuilt', 'load-cr3': 'cr3After', 'enable-lme': 'lmeAfter', 'enable-paging': 'pgAfter' };
const sampledBeforeKeys = { 'enable-pae': 'paeBefore', 'load-cr3': 'pagesBuilt', 'enable-lme': 'lmeBefore', 'enable-paging': 'pgBefore', 'startup64': 'pgAfter' };

export const steps = stages.flatMap((stage, stageIndex) => stage.steps.map((step, localIndex) => ({
  ...step, evidenceKey: sampledStepKeys[step.id] || step.evidenceKey, evidenceBeforeKey: sampledBeforeKeys[step.id] || null, sourceRefs: preciseReferences(step), stageId: stage.id, stageIndex, localIndex, index: 0,
}))).map((step, index) => ({ ...step, index, number: index + 1 }));

steps.find(step=>step.id==='tty-read').sourceRefs.push({path:'artifacts/build/busybox/libbb/read_key.c',line:129,symbol:'read_key / poll before read'});

/** Compact CPU words projected from saved frames by the build. */
export const recordedFrames = {
  "reset": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 0,
    "captureId": "cap-f9c50335-1",
    "cpu": {
      "cpuId": 1,
      "mode": "real-16",
      "cpl": 0,
      "rip": "0xfff0",
      "rsp": "0x0",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x60fb1"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0xf000",
          "base": "0xffff0000",
          "limit": "0xffff",
          "attributes": "0x9b00",
          "usable": true
        },
        "ss": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "ds": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "es": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "fs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "gs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x8b00",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x60000010",
        "cr2": "0x0",
        "cr3": "0x0",
        "cr4": "0x0",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x2",
      "halted": false,
      "gdt": {
        "base": "0x0",
        "limit": "0xffff"
      },
      "idt": {
        "base": "0x0",
        "limit": "0xffff"
      },
      "hflags": "0x40",
      "hflags2": "0x101",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0xfffffff0",
        "bytes": "ea5be000f030362f32332f393900fc00",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0xfffffff0",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-1-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0xfffffff0",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "ca1df7fbcacd35e4e7e8385ae6307cfbad957560fa832f021486543169930015",
        "label": "pc",
        "bytes": "ea5be000f030362f32332f393900fc00"
      }
    ],
    "capturedAt": "2026-10-17T20:33:02.847Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/0",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-0.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "boot": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 1,
    "captureId": "cap-f9c50335-2",
    "cpu": {
      "cpuId": 1,
      "mode": "real-16",
      "cpl": 0,
      "rip": "0x7c00",
      "rsp": "0x6f40",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0xaa55"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0xe0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x6f40"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9b0f",
          "usable": true
        },
        "ss": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "ds": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "es": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "fs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "gs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x8b00",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x10",
        "cr2": "0x0",
        "cr3": "0x0",
        "cr4": "0x0",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x202",
      "halted": false,
      "gdt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x3ff"
      },
      "hflags": "0x40",
      "hflags2": "0x101",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x7c00",
        "bytes": "e80000eb3b000000100000008c120000",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x7c00",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-2-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x7c00",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "25236c86c557312beefe6b27f5e9318f0bf8232088e0120c045640265f47eaca",
        "label": "pc",
        "bytes": "e80000eb3b000000100000008c120000"
      },
      {
        "addressSpace": "linear",
        "address": "0x6f40",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "4be08ef6df63dfad1dd2098d3b1a50ba9d0ed1f39e79b68abe5a05559de1f495",
        "label": "stack",
        "bytes": "0fd000f0000000009e6f000031820000728200000000000000000000318200009e6f0000a97d000000000000000000009e6f00000000000070620000007c0000e00000000000000000000000e6dd0e00a9150f0000000000007c000000000000000000000000000000000000000000000000e00000000000000055aa0000007c00000002e0520f0000000000a5f00e00084a0f00084a0f003ff50e200000000000000000000000000000000071bc0e0084f50e008e420f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:19.646Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/1",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-1.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "startup32": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 2,
    "captureId": "cap-f9c50335-3",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x100000",
      "rsp": "0x7fff4",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x82c6"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x113278"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x82d2"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0xe0ffffff"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x8327"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x7fff0"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x7fff4"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffff",
          "attributes": "0x8b00",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x0",
        "cr4": "0x0",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x8280",
        "limit": "0x27"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x101",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x100000",
        "bytes": "898e4100000089be4500000089866401",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x100000",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-3-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x100000",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "301a161bfb46a4546225c27c44a09340df8a9286e9e23c4948e9700f78665af3",
        "label": "pc",
        "bytes": "898e4100000089be4500000089866401"
      },
      {
        "addressSpace": "linear",
        "address": "0x7fff4",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:19.957Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/2",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-2.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "paeBefore": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 3,
    "captureId": "cap-f9c50335-4",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x100077",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x20"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x80002001"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x6000000"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x1"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x1000",
          "limit": "0x67",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x0",
        "cr4": "0x0",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x2",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x100077",
        "bytes": "0f22e031d28dbb0070640031c0b90018",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x100077",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-4-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x100077",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "92d53c0c4dba5baef618ca0174288d3c70752b8cf26f83b107e61907552e58ff",
        "label": "pc",
        "bytes": "0f22e031d28dbb0070640031c0b90018"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:21.491Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/3",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-3.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "paeAfter": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 4,
    "captureId": "cap-f9c50335-5",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x10007a",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x20"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x80002001"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x6000000"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x1"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x1000",
          "limit": "0x67",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x0",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x2",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x10007a",
        "bytes": "31d28dbb0070640031c0b900180000f3",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x10007a",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-5-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x10007a",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "0a7b6e49e982e6e4a000d2720482ab38a4f864461dc0c1dd52a58621555c38b6",
        "label": "pc",
        "bytes": "31d28dbb0070640031c0b900180000f3"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:22.649Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/4",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-4.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "pagesBuilt": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 5,
    "captureId": "cap-f9c50335-6",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x1000e3",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x26f1000"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x1000",
          "limit": "0x67",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x0",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x1000e3",
        "bytes": "0f22d8b9800000c00f320fbae8080f30",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x1000e3",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-6-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x1000e3",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "816ed37dd101b358d32296c8e64b332ae5b48ac5f89064dae538560e2d65621c",
        "label": "pc",
        "bytes": "0f22d8b9800000c00f320fbae8080f30"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:22.901Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/5",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-5.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "cr3After": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 6,
    "captureId": "cap-f9c50335-7",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x1000e6",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x26f1000"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x1000",
          "limit": "0x67",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x26f1000",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x1000e6",
        "bytes": "b9800000c00f320fbae8080f3031c00f",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x1000e6",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-7-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x1000e6",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "d8889671775a01061dbe8809d5eae851d7c471bba2ac23452c5cdc26072d08e5",
        "label": "pc",
        "bytes": "b9800000c00f320fbae8080f3031c00f"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      },
      {
        "addressSpace": "physical",
        "address": "0x26f1000",
        "length": 64,
        "coverage": "recorded",
        "bytes": "07206f02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "hex": "07206f02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "label": "PML4 / 临时页表根",
        "captureId": "cap-f9c50335-7",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 6,
          "captureId": "cap-f9c50335-7"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-7",
          "refs": [
            "x-oslab-read-physical:cap-7-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x26f2000",
        "length": 64,
        "coverage": "recorded",
        "bytes": "07306f020000000007406f020000000007506f020000000007606f02000000000000000000000000000000000000000000000000000000000000000000000000",
        "hex": "07306f020000000007406f020000000007506f020000000007606f02000000000000000000000000000000000000000000000000000000000000000000000000",
        "label": "PDPT / 临时三级表",
        "captureId": "cap-f9c50335-7",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 6,
          "captureId": "cap-f9c50335-7"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-7",
          "refs": [
            "x-oslab-read-physical:cap-7-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x26f3000",
        "length": 64,
        "coverage": "recorded",
        "bytes": "830100000000000083012000000000008301400000000000830160000000000083018000000000008301a000000000008301c000000000008301e00000000000",
        "hex": "830100000000000083012000000000008301400000000000830160000000000083018000000000008301a000000000008301c000000000008301e00000000000",
        "label": "PD / 2 MiB大页表",
        "captureId": "cap-f9c50335-7",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 6,
          "captureId": "cap-f9c50335-7"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-7",
          "refs": [
            "x-oslab-read-physical:cap-7-8.2.10"
          ]
        }
      }
    ],
    "capturedAt": "2026-10-17T20:33:23.164Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/6",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-6.json",
    "memoryCoverage": "selected-pages: PC and stack plus explicitly capture-bound physical page-table or low-memory reads; not full RAM"
  },
  "lmeBefore": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 7,
    "captureId": "cap-f9c50335-8",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x1000f1",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x100"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0xc0000080"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x1000",
          "limit": "0x67",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x26f1000",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x0",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": false,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x1000f1",
        "bytes": "0f3031c00f00d0b8200000000f00d88d",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x1000f1",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-8-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x1000f1",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "475dedbedf875455cf48ca394d4e410b6d45fdc38301a583b715d2f6ae5e5b33",
        "label": "pc",
        "bytes": "0f3031c00f00d0b8200000000f00d88d"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:23.624Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/7",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-7.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "lmeAfter": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 8,
    "captureId": "cap-f9c50335-9",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x1000f3",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x100"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0xc0000080"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x1000",
          "limit": "0x67",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x26f1000",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x100",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x1000f3",
        "bytes": "31c00f00d0b8200000000f00d88d8500",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x1000f3",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-9-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x1000f3",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "e85db3219fadbb4f1d5f5feb791c0ded7888eeeb6fb0f52aac6a77e1941bfaef",
        "label": "pc",
        "bytes": "31c00f00d0b8200000000f00d88d8500"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:23.867Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/8",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-8.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "pgBefore": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 9,
    "captureId": "cap-f9c50335-10",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x10011d",
      "rsp": "0x7313f8",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x80050033"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0xc0000080"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x7313f8"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x0",
          "limit": "0xfff",
          "attributes": "0x808900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x11",
        "cr2": "0x0",
        "cr3": "0x26f1000",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x100",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": false,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xb0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x10011d",
        "bytes": "0f22c0cb000000000000000000000000",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x10011d",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-10-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x10011d",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "ff8eed26f11390cad688ab530f35a1bf6f5ab166a8e525d53de9df2072b739b0",
        "label": "pc",
        "bytes": "0f22c0cb000000000000000000000000"
      },
      {
        "addressSpace": "linear",
        "address": "0x7313f8",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "1fe5acb9066b70ec97e3b54c9c9b2d740aaedb5e076362104f618bfab6000255",
        "label": "stack",
        "bytes": "00021000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:24.120Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/9",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-9.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound"
  },
  "pgAfter": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 10,
    "captureId": "cap-f9c50335-11",
    "cpu": {
      "cpuId": 1,
      "mode": "protected-32",
      "cpl": 0,
      "rip": "0x100120",
      "rsp": "0x7313f8",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x80050033"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0xc0000080"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x7313f8"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x8",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x0",
          "limit": "0xfff",
          "attributes": "0x808900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x80050033",
        "cr2": "0x0",
        "cr3": "0x26f1000",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x500",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": true,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0x42b0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x100120",
        "bytes": "cb000000000000000000000000000000",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x100120",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-11-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x100120",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "5608c53fd851d9e6f9aef704ead968ef1bb9532d7cae397ccf630625dcea71a1",
        "label": "pc",
        "bytes": "cb000000000000000000000000000000"
      },
      {
        "addressSpace": "linear",
        "address": "0x7313f8",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "1fe5acb9066b70ec97e3b54c9c9b2d740aaedb5e076362104f618bfab6000255",
        "label": "stack",
        "bytes": "00021000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:24.385Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/10",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-10.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound",
    "note": "PG=1、LMA=1，但CS.L=0：采集器mode字段仍为protected-32；此时是长模式的32位兼容子模式。下一条LRET进入64位代码。"
  },
  "startup64": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 11,
    "captureId": "cap-f9c50335-12",
    "cpu": {
      "cpuId": 1,
      "mode": "long-64",
      "cpl": 0,
      "rip": "0x100200",
      "rsp": "0x731400",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x80050033"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x20aa000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0xc0000080"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x26f7000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0x100000"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0x731400"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xaf9a00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "es": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "fs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "gs": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x0",
          "limit": "0xfff",
          "attributes": "0x808900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x80050033",
        "cr2": "0x0",
        "cr3": "0x26f1000",
        "cr4": "0x20",
        "cr8": "0x0"
      },
      "efer": "0x500",
      "eferBits": {
        "sce": false,
        "svme": false,
        "nxe": false,
        "lma": true,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0x72d010",
        "limit": "0x2f"
      },
      "idt": {
        "base": "0x0",
        "limit": "0x0"
      },
      "hflags": "0xc2b0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0x100200",
        "bytes": "fcfa31c08ed88ec08ed08ee08ee8488d",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0x100200",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-12-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0x100200",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "ee6b26c43c4f2f33ec6446cc7067435f14372633171f83158d978b37cb7773c9",
        "label": "pc",
        "bytes": "fcfa31c08ed88ec08ed08ee08ee8488d"
      },
      {
        "addressSpace": "linear",
        "address": "0x731400",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1",
        "label": "stack",
        "bytes": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      }
    ],
    "capturedAt": "2026-10-17T20:33:24.650Z",
    "source": null,
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/11",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-11.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound",
    "note": "解压器 startup_64；通过上一帧0x100120处LRET单步后取得。"
  },
  "startKernel": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 12,
    "captureId": "cap-f9c50335-13",
    "cpu": {
      "cpuId": 1,
      "mode": "long-64",
      "cpl": 0,
      "rip": "0xffffffff82056d20",
      "rsp": "0xffffffff81e03f20",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x80002001"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x78bfbfd"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x94910"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0xffffffff81e03f28"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0xffffffff81e03f20"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0xffffffff81c95209"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x800"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x64"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0xffffffff81e03f00"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0xb0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x94910"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xaf9b00",
          "usable": true
        },
        "ss": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xc09300",
          "usable": true
        },
        "ds": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "es": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "fs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "gs": {
          "selector": "0x0",
          "base": "0xffffffff82028000",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x20",
          "base": "0x0",
          "limit": "0xfff",
          "attributes": "0x808900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x80050033",
        "cr2": "0xffff888000094910",
        "cr3": "0x20d6000",
        "cr4": "0xb0",
        "cr8": "0x0"
      },
      "efer": "0xd01",
      "eferBits": {
        "sce": true,
        "svme": false,
        "nxe": true,
        "lma": true,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x46",
      "halted": false,
      "gdt": {
        "base": "0xffffffff82033000",
        "limit": "0x7f"
      },
      "idt": {
        "base": "0xffffffff82291000",
        "limit": "0xfff"
      },
      "hflags": "0xc2b0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0xffffffff82056d20",
        "bytes": "f30f1efae8279301ff5548c7c740a9e0",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0xffffffff82056d20",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-13-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0xffffffff82056d20",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "fd96b234164eab61598d4b708903d53f3a404aa254d370fec9a8f20cfe5fab60",
        "label": "pc",
        "bytes": "f30f1efae8279301ff5548c7c740a9e0"
      },
      {
        "addressSpace": "linear",
        "address": "0xffffffff81e03f20",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "8cbaebac814fed1be391a193c6b5caa2a9ba6cb9057122ea375e98dad7bb5336",
        "label": "stack",
        "bytes": "6c210682ffffffff483fe081ffffffffa0220682ffffffff00000000000000000000000000000000000000000000000034200381ffffffff00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000048c7c0600000000f05c3cccccccccccccccccccccccccccccccccccccccccccc"
      }
    ],
    "capturedAt": "2026-10-17T20:33:25.302Z",
    "source": {
      "path": "src/linux-6.12.112/init/main.c",
      "fileHash": "3c40fe882bf9d1a69b0c9972986b73b78a90c4a601c9ac0b08c9551ac505d1c5",
      "symbol": "start_kernel",
      "line": 875,
      "module": "linux-kernel"
    },
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/12",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-12.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound",
    "os": {
      "kernelRelease": "6.12.112-observatory",
      "current": {
        "pid": 0,
        "tgid": 0,
        "taskAddress": "0xffffffff81e0a940",
        "comm": "swapper",
        "state": "running",
        "stateRaw": 0,
        "parentPid": 0,
        "mmAddress": null,
        "stackAddress": "0xffffffff81e00000",
        "threads": [],
        "evidence": {
          "kind": "decoded",
          "source": "linux-decoder",
          "captureId": "cap-f9c50335-13",
          "refs": [
            "memory:0xffffffff81e0a940:7296",
            "type:task_struct",
            "structBytes:7296"
          ]
        }
      },
      "processesTruncated": false,
      "processes": [
        {
          "pid": 0,
          "parentPid": 0,
          "comm": "swapper",
          "state": "running",
          "taskAddress": "0xffffffff81e0a940",
          "mmAddress": null,
          "stackAddress": "0xffffffff81e00000"
        }
      ]
    }
  },
  "kernelInit": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 13,
    "captureId": "cap-f9c50335-14",
    "cpu": {
      "cpuId": 1,
      "mode": "long-64",
      "cpl": 0,
      "rip": "0xffffffff81792800",
      "rsp": "0xffffc90000013f28",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0xffffc90000013f58"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x2"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0xffff8880029c8000"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0xffffc90000013f58"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0xffffc90000013f48"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0xffffc90000013f28"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x11d"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x11d"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x5cb08d3"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0xfa83b2da"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0xffffffff81792800"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xaf9b00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "es": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "fs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "gs": {
          "selector": "0x0",
          "base": "0xffff88801f200000",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x40",
          "base": "0xfffffe0000003000",
          "limit": "0x4087",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x80050033",
        "cr2": "0xffff888002401000",
        "cr3": "0x1e2c000",
        "cr4": "0x6f0",
        "cr8": "0x1"
      },
      "efer": "0xd01",
      "eferBits": {
        "sce": true,
        "svme": false,
        "nxe": true,
        "lma": true,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x286",
      "halted": false,
      "gdt": {
        "base": "0xfffffe0000001000",
        "limit": "0x7f"
      },
      "idt": {
        "base": "0xfffffe0000000000",
        "limit": "0xfff"
      },
      "hflags": "0x40c2b0",
      "hflags2": "0x181",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0xffffffff81792800",
        "bytes": "f30f1efa0f1f4400005548c7c7c0c80c",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0xffffffff81792800",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-14-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0xffffffff81792800",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "f4e651103a7c5e5ea623660c7bf8f41bd9cdba44fac6f727cf093f04ec4cd573",
        "label": "pc",
        "bytes": "f30f1efa0f1f4400005548c7c7c0c80c"
      },
      {
        "addressSpace": "linear",
        "address": "0xffffc90000013f28",
        "length": 217,
        "coverage": "recorded",
        "blobRef": "0784a79a8457e827682480fd3be8e9c8c96b757950fe16d2886093b7573098d7",
        "label": "stack",
        "bytes": "e1320481ffffffff00287981ffffffff00000000000000000000000000000000593f010000c9ffffea220081ffffffff000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a9"
      }
    ],
    "capturedAt": "2026-10-17T20:33:26.284Z",
    "source": {
      "path": "src/linux-6.12.112/init/main.c",
      "fileHash": "3c40fe882bf9d1a69b0c9972986b73b78a90c4a601c9ac0b08c9551ac505d1c5",
      "symbol": "kernel_init",
      "line": 1432,
      "module": "linux-kernel"
    },
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/13",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-13.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound",
    "os": {
      "kernelRelease": "6.12.112-observatory",
      "current": {
        "pid": 1,
        "tgid": 1,
        "taskAddress": "0xffff8880029b8000",
        "comm": "swapper/0",
        "state": "running",
        "stateRaw": 0,
        "parentPid": 0,
        "mmAddress": null,
        "stackAddress": "0xffffc90000010000",
        "threads": [],
        "evidence": {
          "kind": "decoded",
          "source": "linux-decoder",
          "captureId": "cap-f9c50335-14",
          "refs": [
            "memory:0xffff8880029b8000:7296",
            "type:task_struct",
            "structBytes:7296"
          ]
        }
      },
      "processesTruncated": false,
      "processes": [
        {
          "pid": 0,
          "parentPid": 0,
          "comm": "swapper/0",
          "state": "running",
          "taskAddress": "0xffffffff81e0a940",
          "mmAddress": null,
          "stackAddress": "0xffffffff81e00000"
        },
        {
          "pid": 1,
          "parentPid": 0,
          "comm": "swapper/0",
          "state": "running",
          "taskAddress": "0xffff8880029b8000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000010000"
        },
        {
          "pid": 2,
          "parentPid": 0,
          "comm": "swapper/0",
          "state": "running",
          "taskAddress": "0xffff8880029b8e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000018000"
        }
      ]
    }
  },
  "ext2": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 14,
    "captureId": "cap-f9c50335-15",
    "cpu": {
      "cpuId": 1,
      "mode": "long-64",
      "cpl": 0,
      "rip": "0xffffffff813eee70",
      "rsp": "0xffffc90000137d98",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0xffff888002855000"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0xc"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x1"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0xffff888002855000"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0xffffc90000137de0"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0xffffc90000137d98"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x4"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0xffff8880028553b8"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0x4d549db2"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0xffffffff813eee70"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x10008000"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xaf9b00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "es": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "fs": {
          "selector": "0x0",
          "base": "0x8923c0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "gs": {
          "selector": "0x0",
          "base": "0xffff88801f200000",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x40",
          "base": "0xfffffe0000003000",
          "limit": "0x4087",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x80050033",
        "cr2": "0x46a370",
        "cr3": "0x3116000",
        "cr4": "0x6f0",
        "cr8": "0x1"
      },
      "efer": "0xd01",
      "eferBits": {
        "sce": true,
        "svme": false,
        "nxe": true,
        "lma": true,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x202",
      "halted": false,
      "gdt": {
        "base": "0xfffffe0000001000",
        "limit": "0x7f"
      },
      "idt": {
        "base": "0xfffffe0000000000",
        "limit": "0xfff"
      },
      "hflags": "0x40c2b0",
      "hflags2": "0x101",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0xffffffff813eee70",
        "bytes": "f30f1efa0f1f440000554889e5415741",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0xffffffff813eee70",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-15-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0xffffffff813eee70",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "a2dcaa0977d31fecb7a63ae126902501e7ae2f38abb3ac5840d5764ae8d1921b",
        "label": "pc",
        "bytes": "f30f1efa0f1f440000554889e5415741"
      },
      {
        "addressSpace": "linear",
        "address": "0xffffc90000137d98",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "dfe86a58ac7353201e8f56f7825f900b28343121086b8a70e197fd5aeb634553",
        "label": "stack",
        "bytes": "6af92b81ffffffff9a6bca81fffffffff87d13000000d00f001e3be2c9de8181408526038088ffffa87e130000c9ffffe0db1e038088ffff408526038088ffffffffffff00000000f07d130000c9ffff79d83e81ffffffff087e130000c9ffff2f9c3081ffffffff408526038088ffff307e130000c9ffffced62b81ffffffff4de20981ffffffff0000000000000000a87e130000c9ffff987e130000c9ffffcbd42e81ffffffff2000000000c9ffffe0db1e0300800000200000008088ffff1b9e2c81ffffffff006004038088ffff001e3be2c9de8181e0db1e038088ffffe0eeb9028088ffff00800000000000000000000000000000e0db1e038088ffff"
      }
    ],
    "capturedAt": "2026-10-17T20:33:28.257Z",
    "source": {
      "path": "src/linux-6.12.112/fs/ext2/super.c",
      "fileHash": "8ce7faf420a400f4a05db2f7c25465dfc6511b68d28fbaba6a83da6909f5f338",
      "symbol": "ext2_fill_super",
      "line": 805,
      "module": "linux-kernel"
    },
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/14",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-14.json",
    "memoryCoverage": "selected-pages: PC and stack only; physical reads are separately capture-bound",
    "os": {
      "kernelRelease": "6.12.112-observatory",
      "current": {
        "pid": 48,
        "tgid": 48,
        "taskAddress": "0xffff88800304ba00",
        "comm": "mount",
        "state": "running",
        "stateRaw": 0,
        "parentPid": 1,
        "mmAddress": "0xffff88800284ca00",
        "stackAddress": "0xffffc90000134000",
        "threads": [],
        "evidence": {
          "kind": "decoded",
          "source": "linux-decoder",
          "captureId": "cap-f9c50335-15",
          "refs": [
            "memory:0xffff88800304ba00:7296",
            "type:task_struct",
            "structBytes:7296"
          ]
        }
      },
      "processesTruncated": false,
      "processes": [
        {
          "pid": 0,
          "parentPid": 0,
          "comm": "swapper/0",
          "state": "running",
          "taskAddress": "0xffffffff81e0a940",
          "mmAddress": null,
          "stackAddress": "0xffffffff81e00000"
        },
        {
          "pid": 1,
          "parentPid": 0,
          "comm": "init",
          "state": "sleeping",
          "taskAddress": "0xffff8880029b8000",
          "mmAddress": "0xffff88800284c500",
          "stackAddress": "0xffffc90000010000"
        },
        {
          "pid": 2,
          "parentPid": 0,
          "comm": "kthreadd",
          "state": "sleeping",
          "taskAddress": "0xffff8880029b8e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000018000"
        },
        {
          "pid": 3,
          "parentPid": 2,
          "comm": "pool_workqueue_",
          "state": "sleeping",
          "taskAddress": "0xffff8880029b9d00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000020000"
        },
        {
          "pid": 4,
          "parentPid": 2,
          "comm": "kworker/R-kvfre",
          "state": "idle",
          "taskAddress": "0xffff8880029bab80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000028000"
        },
        {
          "pid": 5,
          "parentPid": 2,
          "comm": "kworker/R-rcu_g",
          "state": "idle",
          "taskAddress": "0xffff8880029bba00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000030000"
        },
        {
          "pid": 6,
          "parentPid": 2,
          "comm": "kworker/R-sync_",
          "state": "idle",
          "taskAddress": "0xffff8880029bc880",
          "mmAddress": null,
          "stackAddress": "0xffffc90000038000"
        },
        {
          "pid": 7,
          "parentPid": 2,
          "comm": "kworker/R-slub_",
          "state": "idle",
          "taskAddress": "0xffff8880029bd700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000040000"
        },
        {
          "pid": 8,
          "parentPid": 2,
          "comm": "kworker/0:0",
          "state": "idle",
          "taskAddress": "0xffff8880029be580",
          "mmAddress": null,
          "stackAddress": "0xffffc90000048000"
        },
        {
          "pid": 9,
          "parentPid": 2,
          "comm": "kworker/0:1",
          "state": "idle",
          "taskAddress": "0xffff888002a08000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000050000"
        },
        {
          "pid": 10,
          "parentPid": 2,
          "comm": "kworker/0:0H",
          "state": "idle",
          "taskAddress": "0xffff888002a08e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000058000"
        },
        {
          "pid": 11,
          "parentPid": 2,
          "comm": "kworker/u4:0",
          "state": "idle",
          "taskAddress": "0xffff888002a09d00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000060000"
        },
        {
          "pid": 12,
          "parentPid": 2,
          "comm": "kworker/R-mm_pe",
          "state": "idle",
          "taskAddress": "0xffff888002a0ab80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000068000"
        },
        {
          "pid": 13,
          "parentPid": 2,
          "comm": "rcu_tasks_kthre",
          "state": "idle",
          "taskAddress": "0xffff888002a0ba00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000070000"
        },
        {
          "pid": 14,
          "parentPid": 2,
          "comm": "rcu_tasks_rude_",
          "state": "idle",
          "taskAddress": "0xffff888002a0c880",
          "mmAddress": null,
          "stackAddress": "0xffffc90000078000"
        },
        {
          "pid": 15,
          "parentPid": 2,
          "comm": "rcu_tasks_trace",
          "state": "idle",
          "taskAddress": "0xffff888002a0d700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000080000"
        },
        {
          "pid": 16,
          "parentPid": 2,
          "comm": "ksoftirqd/0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a0e580",
          "mmAddress": null,
          "stackAddress": "0xffffc90000088000"
        },
        {
          "pid": 17,
          "parentPid": 2,
          "comm": "rcu_preempt",
          "state": "idle",
          "taskAddress": "0xffff888002a50000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000090000"
        },
        {
          "pid": 18,
          "parentPid": 2,
          "comm": "rcu_exp_par_gp_",
          "state": "sleeping",
          "taskAddress": "0xffff888002a50e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000098000"
        },
        {
          "pid": 19,
          "parentPid": 2,
          "comm": "rcu_exp_gp_kthr",
          "state": "sleeping",
          "taskAddress": "0xffff888002a51d00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000a0000"
        },
        {
          "pid": 20,
          "parentPid": 2,
          "comm": "migration/0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a52b80",
          "mmAddress": null,
          "stackAddress": "0xffffc900000a8000"
        },
        {
          "pid": 21,
          "parentPid": 2,
          "comm": "cpuhp/0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a53a00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000b0000"
        },
        {
          "pid": 22,
          "parentPid": 2,
          "comm": "kdevtmpfs",
          "state": "sleeping",
          "taskAddress": "0xffff888002a54880",
          "mmAddress": null,
          "stackAddress": "0xffffc900000b8000"
        },
        {
          "pid": 23,
          "parentPid": 2,
          "comm": "kworker/u4:1",
          "state": "idle",
          "taskAddress": "0xffff888002a55700",
          "mmAddress": null,
          "stackAddress": "0xffffc900000c0000"
        },
        {
          "pid": 24,
          "parentPid": 2,
          "comm": "oom_reaper",
          "state": "sleeping",
          "taskAddress": "0xffff888002a56580",
          "mmAddress": null,
          "stackAddress": "0xffffc900000c8000"
        },
        {
          "pid": 25,
          "parentPid": 2,
          "comm": "kworker/u4:2",
          "state": "idle",
          "taskAddress": "0xffff888002a58000",
          "mmAddress": null,
          "stackAddress": "0xffffc900000d0000"
        },
        {
          "pid": 26,
          "parentPid": 2,
          "comm": "kworker/R-write",
          "state": "idle",
          "taskAddress": "0xffff888002a58e80",
          "mmAddress": null,
          "stackAddress": "0xffffc900000d8000"
        },
        {
          "pid": 27,
          "parentPid": 2,
          "comm": "kcompactd0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a59d00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000e0000"
        },
        {
          "pid": 28,
          "parentPid": 2,
          "comm": "kworker/R-kbloc",
          "state": "idle",
          "taskAddress": "0xffff888002a5ab80",
          "mmAddress": null,
          "stackAddress": "0xffffc900000e8000"
        },
        {
          "pid": 29,
          "parentPid": 2,
          "comm": "irq/9-acpi",
          "state": "sleeping",
          "taskAddress": "0xffff888002a5ba00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000f0000"
        },
        {
          "pid": 30,
          "parentPid": 2,
          "comm": "kworker/R-ata_s",
          "state": "idle",
          "taskAddress": "0xffff888002a5c880",
          "mmAddress": null,
          "stackAddress": "0xffffc900000f8000"
        },
        {
          "pid": 31,
          "parentPid": 2,
          "comm": "kworker/R-md",
          "state": "idle",
          "taskAddress": "0xffff888002a5d700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000100000"
        },
        {
          "pid": 32,
          "parentPid": 2,
          "comm": "kworker/R-md_bi",
          "state": "idle",
          "taskAddress": "0xffff888002a5e580",
          "mmAddress": null,
          "stackAddress": "0xffffc90000108000"
        },
        {
          "pid": 33,
          "parentPid": 2,
          "comm": "kworker/R-quota",
          "state": "idle",
          "taskAddress": "0xffff888002be8000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000110000"
        },
        {
          "pid": 34,
          "parentPid": 2,
          "comm": "kswapd0",
          "state": "sleeping",
          "taskAddress": "0xffff888002be8e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000118000"
        },
        {
          "pid": 35,
          "parentPid": 2,
          "comm": "kworker/R-acpi_",
          "state": "idle",
          "taskAddress": "0xffff888002be9d00",
          "mmAddress": null,
          "stackAddress": "0xffffc9000012c000"
        },
        {
          "pid": 36,
          "parentPid": 2,
          "comm": "scsi_eh_0",
          "state": "sleeping",
          "taskAddress": "0xffff888002beab80",
          "mmAddress": null,
          "stackAddress": "0xffffc9000013c000"
        },
        {
          "pid": 37,
          "parentPid": 2,
          "comm": "kworker/R-scsi_",
          "state": "idle",
          "taskAddress": "0xffff888002beba00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000144000"
        },
        {
          "pid": 38,
          "parentPid": 2,
          "comm": "scsi_eh_1",
          "state": "sleeping",
          "taskAddress": "0xffff888002bec880",
          "mmAddress": null,
          "stackAddress": "0xffffc9000014c000"
        },
        {
          "pid": 39,
          "parentPid": 2,
          "comm": "kworker/R-scsi_",
          "state": "idle",
          "taskAddress": "0xffff888002bed700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000154000"
        },
        {
          "pid": 40,
          "parentPid": 2,
          "comm": "kworker/u4:3",
          "state": "idle",
          "taskAddress": "0xffff888002bee580",
          "mmAddress": null,
          "stackAddress": "0xffffc9000015c000"
        },
        {
          "pid": 41,
          "parentPid": 2,
          "comm": "kworker/0:2",
          "state": "idle",
          "taskAddress": "0xffff888003048000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000164000"
        },
        {
          "pid": 42,
          "parentPid": 2,
          "comm": "kworker/u5:0",
          "state": "idle",
          "taskAddress": "0xffff888003048e80",
          "mmAddress": null,
          "stackAddress": "0xffffc9000016c000"
        },
        {
          "pid": 43,
          "parentPid": 2,
          "comm": "kworker/0:1H",
          "state": "idle",
          "taskAddress": "0xffff888003049d00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000174000"
        },
        {
          "pid": 44,
          "parentPid": 2,
          "comm": "kworker/0:3",
          "state": "idle",
          "taskAddress": "0xffff88800304ab80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000180000"
        },
        {
          "pid": 48,
          "parentPid": 1,
          "comm": "mount",
          "state": "running",
          "taskAddress": "0xffff88800304ba00",
          "mmAddress": "0xffff88800284ca00",
          "stackAddress": "0xffffc90000134000"
        }
      ]
    }
  },
  "shell": {
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "cpu": {
      "cpuId": 1,
      "mode": "long-64",
      "cpl": 0,
      "rip": "0xffffffff81791d73",
      "rsp": "0xffffffff81e03e28",
      "general": [
        {
          "name": "rax",
          "width": 64,
          "value": "0xffff88801f200000"
        },
        {
          "name": "rbx",
          "width": 64,
          "value": "0xffffffff81e0a940"
        },
        {
          "name": "rcx",
          "width": 64,
          "value": "0x20"
        },
        {
          "name": "rdx",
          "width": 64,
          "value": "0x4000000000000000"
        },
        {
          "name": "rsi",
          "width": 64,
          "value": "0x83"
        },
        {
          "name": "rdi",
          "width": 64,
          "value": "0x37c"
        },
        {
          "name": "rbp",
          "width": 64,
          "value": "0xffffffff81e03e28"
        },
        {
          "name": "rsp",
          "width": 64,
          "value": "0xffffffff81e03e28"
        },
        {
          "name": "r8",
          "width": 64,
          "value": "0x37c"
        },
        {
          "name": "r9",
          "width": 64,
          "value": "0xffffffff81e03d68"
        },
        {
          "name": "r10",
          "width": 64,
          "value": "0x20780"
        },
        {
          "name": "r11",
          "width": 64,
          "value": "0xac41e680"
        },
        {
          "name": "r12",
          "width": 64,
          "value": "0x0"
        },
        {
          "name": "r13",
          "width": 64,
          "value": "0xffffffff82014c08"
        },
        {
          "name": "r14",
          "width": 64,
          "value": "0xffffffff81e0a940"
        },
        {
          "name": "r15",
          "width": 64,
          "value": "0x0"
        }
      ],
      "segments": {
        "cs": {
          "selector": "0x10",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xaf9b00",
          "usable": true
        },
        "ss": {
          "selector": "0x18",
          "base": "0x0",
          "limit": "0xffffffff",
          "attributes": "0xcf9300",
          "usable": true
        },
        "ds": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "es": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "fs": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "gs": {
          "selector": "0x0",
          "base": "0xffff88801f200000",
          "limit": "0x0",
          "attributes": "0x0",
          "usable": false
        },
        "ldtr": {
          "selector": "0x0",
          "base": "0x0",
          "limit": "0x0",
          "attributes": "0x8200",
          "usable": true
        },
        "tr": {
          "selector": "0x40",
          "base": "0xfffffe0000003000",
          "limit": "0x4087",
          "attributes": "0x8900",
          "usable": true
        }
      },
      "control": {
        "cr0": "0x80050033",
        "cr2": "0x896af8",
        "cr3": "0x329c000",
        "cr4": "0x6f0",
        "cr8": "0x1"
      },
      "efer": "0xd01",
      "eferBits": {
        "sce": true,
        "svme": false,
        "nxe": true,
        "lma": true,
        "lme": true,
        "ffxsr": false
      },
      "eflags": "0x216",
      "halted": true,
      "gdt": {
        "base": "0xfffffe0000001000",
        "limit": "0x7f"
      },
      "idt": {
        "base": "0xfffffe0000000000",
        "limit": "0xfff"
      },
      "hflags": "0x40c2b0",
      "hflags2": "0x101",
      "a20Mask": "0xffffffff",
      "instruction": {
        "address": "0xffffffff81791d73",
        "bytes": "fa5dc3cccccccc660f1f440000909090",
        "text": null,
        "length": 16,
        "evidence": "observed: gdb -data-read-memory-bytes（同一停止点）"
      },
      "linearPc": "0xffffffff81791d73",
      "evidence": "寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=cap-17-8.2.10，与本次停止同一时刻"
    },
    "memory": [
      {
        "addressSpace": "linear",
        "address": "0xffffffff81791d73",
        "length": 16,
        "coverage": "recorded",
        "blobRef": "6346fc165291d054c9f779445d0d1136f6c2947b393919dc66e90918489405b9",
        "label": "pc",
        "bytes": "fa5dc3cccccccc660f1f440000909090"
      },
      {
        "addressSpace": "linear",
        "address": "0xffffffff81e03e28",
        "length": 256,
        "coverage": "recorded",
        "blobRef": "fc37c63af55a3ede2e1d68a69c77e12cf37efa0e23cad6a96dda69f99f75f727",
        "label": "stack",
        "bytes": "383ee081ffffffff1d1e7981ffffffff483ee081ffffffff47207981ffffffffa03ee081ffffffff39b60e81ffffffff08be02000000000042a9e081ffffffff40a9e081ffffff0100c66585991f36eaec000000000000000100000000000000000000000000000048a1e081ffffffff1049090000000000b83ee081ffffffffadb80e81ffffffff0200000000000000d03ee081ffffffffe5277981ffffffff0000000000000000183fe081ffffffff9f720582ffffffff20801182ffffffff00000000000000001049090000000000b000000000000000000000000000000000000000000000001049090000000000283fe081ffffffff6c210682ffffffff"
      },
      {
        "addressSpace": "physical",
        "address": "0x0",
        "length": 256,
        "coverage": "recorded",
        "bytes": "53ff00f053ff00f0c3e200f053ff00f053ff00f054ff00f053ff00f053ff00f0a5fe00f087e900f03dd400f03dd400f03dd400f03dd400f057ef00f03dd400f0065600c04df800f041f800f0fee300f039e700f059f800f02ee800f0d2ef00f062d400f0f2e600f06efe00f053ff00f053ff00f053ff00f07c6000f0409400c053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f0",
        "hex": "53ff00f053ff00f0c3e200f053ff00f053ff00f054ff00f053ff00f053ff00f0a5fe00f087e900f03dd400f03dd400f03dd400f03dd400f057ef00f03dd400f0065600c04df800f041f800f0fee300f039e700f059f800f02ee800f0d2ef00f062d400f0f2e600f06efe00f053ff00f053ff00f053ff00f07c6000f0409400c053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f0",
        "label": "完成停点物理内存 0x0",
        "captureId": "cap-f9c50335-17",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 16,
          "captureId": "cap-f9c50335-17"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "x-oslab-read-physical:cap-17-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x10000",
        "length": 256,
        "coverage": "recorded",
        "bytes": "08e849f1ffffeb01908b45f48b400483c00383e0fc0145f4837df4007416a1e87b01008b5008a1e87b010001c28b45f439c2779190c9c3f30f1efb5589e583ec18a1e87b010085c0741fa1e87b01008b003d6d696d677511a1e87b01008b5004a1e87b010001d0eb05b8000000008945f4eb6d8b45f48b0083f80274118b45f48b400483c00383e0fc0145f4eb528b45f48b400483e807e8b0adffffa3bc790100a1bc79010085c07507e8a0f0ffffeb518b45f48b40048d48f88b45f48d5008a1bc790100e80ffeffff8b15bc7901008b45f48b400483e80801d0c60000eb22837df400741ca1e87b01008b5008a1e87b010001c28b45f439c20f8773ffffff",
        "hex": "08e849f1ffffeb01908b45f48b400483c00383e0fc0145f4837df4007416a1e87b01008b5008a1e87b010001c28b45f439c2779190c9c3f30f1efb5589e583ec18a1e87b010085c0741fa1e87b01008b003d6d696d677511a1e87b01008b5004a1e87b010001d0eb05b8000000008945f4eb6d8b45f48b0083f80274118b45f48b400483c00383e0fc0145f4eb528b45f48b400483e807e8b0adffffa3bc790100a1bc79010085c07507e8a0f0ffffeb518b45f48b40048d48f88b45f48d5008a1bc790100e80ffeffff8b15bc7901008b45f48b400483e80801d0c60000eb22837df400741ca1e87b01008b5008a1e87b010001c28b45f439c20f8773ffffff",
        "label": "完成停点物理内存 0x10000",
        "captureId": "cap-f9c50335-17",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 16,
          "captureId": "cap-f9c50335-17"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "x-oslab-read-physical:cap-17-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x100000",
        "length": 256,
        "coverage": "recorded",
        "bytes": "fcfa8da6e8010000e8000000005d83ed0d8d8510d062008940020f0110b8180000008ed88ec08ee08ee88ed08da5001463006a088d853c00000050cbe8dfe3610085c00f85cee3610089eb8b86300200004801c3f7d021c381fb000000017305bb00000001039e6002000081eb008066000f20e083c8200f22e031d28dbb0070640031c0b900180000f3ab8dbb007064008d870710000089070157048dbb008064008d8707100000b9040000008907015704050010000083c7084975f08dbb00906400b883010000b9000800008907015704050000200083c7084975f08d83007064000f22d8b9800000c00f320fbae8080f3031c00f00d0b8200000000f00d8",
        "hex": "fcfa8da6e8010000e8000000005d83ed0d8d8510d062008940020f0110b8180000008ed88ec08ee08ee88ed08da5001463006a088d853c00000050cbe8dfe3610085c00f85cee3610089eb8b86300200004801c3f7d021c381fb000000017305bb00000001039e6002000081eb008066000f20e083c8200f22e031d28dbb0070640031c0b900180000f3ab8dbb007064008d870710000089070157048dbb008064008d8707100000b9040000008907015704050010000083c7084975f08dbb00906400b883010000b9000800008907015704050000200083c7084975f08d83007064000f22d8b9800000c00f320fbae8080f3031c00f00d0b8200000000f00d8",
        "label": "完成停点物理内存 0x100000",
        "captureId": "cap-f9c50335-17",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 16,
          "captureId": "cap-f9c50335-17"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "x-oslab-read-physical:cap-17-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x1000000",
        "length": 256,
        "coverage": "recorded",
        "bytes": "4989f7488d254e3fe000b9010100c0488d15ea7f020189d048c1ea200f30e84d0200006a10488d05030000005048cbe81c200300488d3dc5ffffff4c89fee82d000000488d0db65f0d014801c80f22d8ff25fac51701662e0f1f84000000000090909090909090909090909090909090660f1f00554889f8488d15817f0d0148c1e82e4889e541554154530f85b801000049c7c0000000814889f84c29c0488db0000000804889f1488d05612fe30048893081e1ffff1f000f858d010000488d053b5f0d014c8d0d34dfe2004801b0f80f00004c8d52634c8da2001000004901b1f00f00004901b1f80f00004c8d0d0dffe2004901b1d80f00004901b1d00f00",
        "hex": "4989f7488d254e3fe000b9010100c0488d15ea7f020189d048c1ea200f30e84d0200006a10488d05030000005048cbe81c200300488d3dc5ffffff4c89fee82d000000488d0db65f0d014801c80f22d8ff25fac51701662e0f1f84000000000090909090909090909090909090909090660f1f00554889f8488d15817f0d0148c1e82e4889e541554154530f85b801000049c7c0000000814889f84c29c0488db0000000804889f1488d05612fe30048893081e1ffff1f000f858d010000488d053b5f0d014c8d0d34dfe2004801b0f80f00004c8d52634c8da2001000004901b1f00f00004901b1f80f00004c8d0d0dffe2004901b1d80f00004901b1d00f00",
        "label": "完成停点物理内存 0x1000000",
        "captureId": "cap-f9c50335-17",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 16,
          "captureId": "cap-f9c50335-17"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "x-oslab-read-physical:cap-17-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x400",
        "length": 256,
        "coverage": "recorded",
        "bytes": "f803000000000000000000000000c09f2602007f0200000000001e001e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000350000010000000000000000000000000000000000000070600d40300000000000000d88e1400000000000001c000000000000a0000001e003e0018100060f951080000000000000000000000100000000000000000000000000000000000a06600c0000000000000000000000000004003004667000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "hex": "f803000000000000000000000000c09f2602007f0200000000001e001e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000350000010000000000000000000000000000000000000070600d40300000000000000d88e1400000000000001c000000000000a0000001e003e0018100060f951080000000000000000000000100000000000000000000000000000000000a06600c0000000000000000000000000004003004667000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "label": "完成停点物理内存 0x400",
        "captureId": "cap-f9c50335-17",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 16,
          "captureId": "cap-f9c50335-17"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "x-oslab-read-physical:cap-17-8.2.10"
          ]
        }
      },
      {
        "addressSpace": "physical",
        "address": "0x7c00",
        "length": 256,
        "coverage": "recorded",
        "bytes": "e80000eb3b000000100000008c1200001b8a0000da3ad1e5000000000000000000000000000000000000000000000000000000000000000000000000000000005b31c08ed0bc00608ed88ec0bedd7c2e668b8f0d006609c974766681c1ff07000066c1e90b2e668bb70900e80500ea000020086631c06a1066466650665668000866506a106631ff89e68b7c106639cf76036689cf897c026651b442cd137316b442cd137310d1ef7423897c10897c02b442cd1372f089f8c1e00701440666017c0866596629f975c183c412c3beea7cb40e31dbaccd103c0075f9ebfe6e6f20626f6f7420696e666f006364726f6d2072656164206661696c73000000000000",
        "hex": "e80000eb3b000000100000008c1200001b8a0000da3ad1e5000000000000000000000000000000000000000000000000000000000000000000000000000000005b31c08ed0bc00608ed88ec0bedd7c2e668b8f0d006609c974766681c1ff07000066c1e90b2e668bb70900e80500ea000020086631c06a1066466650665668000866506a106631ff89e68b7c106639cf76036689cf897c026651b442cd137316b442cd137310d1ef7423897c10897c02b442cd1372f089f8c1e00701440666017c0866596629f975c183c412c3beea7cb40e31dbaccd103c0075f9ebfe6e6f20626f6f7420696e666f006364726f6d2072656164206661696c73000000000000",
        "label": "完成停点物理内存 0x7c00",
        "captureId": "cap-f9c50335-17",
        "attribution": {
          "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
          "epoch": 1,
          "frameId": 16,
          "captureId": "cap-f9c50335-17"
        },
        "evidence": {
          "kind": "observed",
          "source": "observer",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "x-oslab-read-physical:cap-17-8.2.10"
          ]
        }
      }
    ],
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "source": {
      "path": "src/linux-6.12.112/fs/ext2/super.c",
      "fileHash": "8ce7faf420a400f4a05db2f7c25465dfc6511b68d28fbaba6a83da6909f5f338",
      "symbol": "ext2_fill_super",
      "line": 805,
      "module": "linux-kernel"
    },
    "originalPath": "docs/animation/data/detailed-captures.json#/frames/16",
    "originalFramePath": "var/sessions/f9c50335-5722-4fc9-8072-5da032b5c848/frame-16.json",
    "memoryCoverage": "selected-pages: PC and stack plus explicitly capture-bound physical page-table or low-memory reads; not full RAM",
    "os": {
      "kernelRelease": "6.12.112-observatory",
      "current": {
        "pid": 0,
        "tgid": 0,
        "taskAddress": "0xffffffff81e0a940",
        "comm": "swapper/0",
        "state": "running",
        "stateRaw": 0,
        "parentPid": 0,
        "mmAddress": null,
        "stackAddress": "0xffffffff81e00000",
        "threads": [],
        "evidence": {
          "kind": "decoded",
          "source": "linux-decoder",
          "captureId": "cap-f9c50335-17",
          "refs": [
            "memory:0xffffffff81e0a940:7296",
            "type:task_struct",
            "structBytes:7296"
          ]
        }
      },
      "processesTruncated": false,
      "processes": [
        {
          "pid": 0,
          "parentPid": 0,
          "comm": "swapper/0",
          "state": "running",
          "taskAddress": "0xffffffff81e0a940",
          "mmAddress": null,
          "stackAddress": "0xffffffff81e00000"
        },
        {
          "pid": 1,
          "parentPid": 0,
          "comm": "init",
          "state": "sleeping",
          "taskAddress": "0xffff8880029b8000",
          "mmAddress": "0xffff88800284c500",
          "stackAddress": "0xffffc90000010000"
        },
        {
          "pid": 2,
          "parentPid": 0,
          "comm": "kthreadd",
          "state": "sleeping",
          "taskAddress": "0xffff8880029b8e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000018000"
        },
        {
          "pid": 3,
          "parentPid": 2,
          "comm": "pool_workqueue_",
          "state": "sleeping",
          "taskAddress": "0xffff8880029b9d00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000020000"
        },
        {
          "pid": 4,
          "parentPid": 2,
          "comm": "kworker/R-kvfre",
          "state": "idle",
          "taskAddress": "0xffff8880029bab80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000028000"
        },
        {
          "pid": 5,
          "parentPid": 2,
          "comm": "kworker/R-rcu_g",
          "state": "idle",
          "taskAddress": "0xffff8880029bba00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000030000"
        },
        {
          "pid": 6,
          "parentPid": 2,
          "comm": "kworker/R-sync_",
          "state": "idle",
          "taskAddress": "0xffff8880029bc880",
          "mmAddress": null,
          "stackAddress": "0xffffc90000038000"
        },
        {
          "pid": 7,
          "parentPid": 2,
          "comm": "kworker/R-slub_",
          "state": "idle",
          "taskAddress": "0xffff8880029bd700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000040000"
        },
        {
          "pid": 8,
          "parentPid": 2,
          "comm": "kworker/0:0",
          "state": "idle",
          "taskAddress": "0xffff8880029be580",
          "mmAddress": null,
          "stackAddress": "0xffffc90000048000"
        },
        {
          "pid": 9,
          "parentPid": 2,
          "comm": "kworker/0:1",
          "state": "idle",
          "taskAddress": "0xffff888002a08000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000050000"
        },
        {
          "pid": 10,
          "parentPid": 2,
          "comm": "kworker/0:0H",
          "state": "idle",
          "taskAddress": "0xffff888002a08e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000058000"
        },
        {
          "pid": 11,
          "parentPid": 2,
          "comm": "kworker/u4:0",
          "state": "idle",
          "taskAddress": "0xffff888002a09d00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000060000"
        },
        {
          "pid": 12,
          "parentPid": 2,
          "comm": "kworker/R-mm_pe",
          "state": "idle",
          "taskAddress": "0xffff888002a0ab80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000068000"
        },
        {
          "pid": 13,
          "parentPid": 2,
          "comm": "rcu_tasks_kthre",
          "state": "idle",
          "taskAddress": "0xffff888002a0ba00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000070000"
        },
        {
          "pid": 14,
          "parentPid": 2,
          "comm": "rcu_tasks_rude_",
          "state": "idle",
          "taskAddress": "0xffff888002a0c880",
          "mmAddress": null,
          "stackAddress": "0xffffc90000078000"
        },
        {
          "pid": 15,
          "parentPid": 2,
          "comm": "rcu_tasks_trace",
          "state": "idle",
          "taskAddress": "0xffff888002a0d700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000080000"
        },
        {
          "pid": 16,
          "parentPid": 2,
          "comm": "ksoftirqd/0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a0e580",
          "mmAddress": null,
          "stackAddress": "0xffffc90000088000"
        },
        {
          "pid": 17,
          "parentPid": 2,
          "comm": "rcu_preempt",
          "state": "idle",
          "taskAddress": "0xffff888002a50000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000090000"
        },
        {
          "pid": 18,
          "parentPid": 2,
          "comm": "rcu_exp_par_gp_",
          "state": "sleeping",
          "taskAddress": "0xffff888002a50e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000098000"
        },
        {
          "pid": 19,
          "parentPid": 2,
          "comm": "rcu_exp_gp_kthr",
          "state": "sleeping",
          "taskAddress": "0xffff888002a51d00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000a0000"
        },
        {
          "pid": 20,
          "parentPid": 2,
          "comm": "migration/0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a52b80",
          "mmAddress": null,
          "stackAddress": "0xffffc900000a8000"
        },
        {
          "pid": 21,
          "parentPid": 2,
          "comm": "cpuhp/0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a53a00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000b0000"
        },
        {
          "pid": 22,
          "parentPid": 2,
          "comm": "kdevtmpfs",
          "state": "sleeping",
          "taskAddress": "0xffff888002a54880",
          "mmAddress": null,
          "stackAddress": "0xffffc900000b8000"
        },
        {
          "pid": 23,
          "parentPid": 2,
          "comm": "kworker/u4:1",
          "state": "idle",
          "taskAddress": "0xffff888002a55700",
          "mmAddress": null,
          "stackAddress": "0xffffc900000c0000"
        },
        {
          "pid": 24,
          "parentPid": 2,
          "comm": "oom_reaper",
          "state": "sleeping",
          "taskAddress": "0xffff888002a56580",
          "mmAddress": null,
          "stackAddress": "0xffffc900000c8000"
        },
        {
          "pid": 25,
          "parentPid": 2,
          "comm": "kworker/u4:2",
          "state": "idle",
          "taskAddress": "0xffff888002a58000",
          "mmAddress": null,
          "stackAddress": "0xffffc900000d0000"
        },
        {
          "pid": 26,
          "parentPid": 2,
          "comm": "kworker/R-write",
          "state": "idle",
          "taskAddress": "0xffff888002a58e80",
          "mmAddress": null,
          "stackAddress": "0xffffc900000d8000"
        },
        {
          "pid": 27,
          "parentPid": 2,
          "comm": "kcompactd0",
          "state": "sleeping",
          "taskAddress": "0xffff888002a59d00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000e0000"
        },
        {
          "pid": 28,
          "parentPid": 2,
          "comm": "kworker/R-kbloc",
          "state": "idle",
          "taskAddress": "0xffff888002a5ab80",
          "mmAddress": null,
          "stackAddress": "0xffffc900000e8000"
        },
        {
          "pid": 29,
          "parentPid": 2,
          "comm": "irq/9-acpi",
          "state": "sleeping",
          "taskAddress": "0xffff888002a5ba00",
          "mmAddress": null,
          "stackAddress": "0xffffc900000f0000"
        },
        {
          "pid": 30,
          "parentPid": 2,
          "comm": "kworker/R-ata_s",
          "state": "idle",
          "taskAddress": "0xffff888002a5c880",
          "mmAddress": null,
          "stackAddress": "0xffffc900000f8000"
        },
        {
          "pid": 31,
          "parentPid": 2,
          "comm": "kworker/R-md",
          "state": "idle",
          "taskAddress": "0xffff888002a5d700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000100000"
        },
        {
          "pid": 32,
          "parentPid": 2,
          "comm": "kworker/R-md_bi",
          "state": "idle",
          "taskAddress": "0xffff888002a5e580",
          "mmAddress": null,
          "stackAddress": "0xffffc90000108000"
        },
        {
          "pid": 33,
          "parentPid": 2,
          "comm": "kworker/R-quota",
          "state": "idle",
          "taskAddress": "0xffff888002be8000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000110000"
        },
        {
          "pid": 34,
          "parentPid": 2,
          "comm": "kswapd0",
          "state": "sleeping",
          "taskAddress": "0xffff888002be8e80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000118000"
        },
        {
          "pid": 35,
          "parentPid": 2,
          "comm": "kworker/R-acpi_",
          "state": "idle",
          "taskAddress": "0xffff888002be9d00",
          "mmAddress": null,
          "stackAddress": "0xffffc9000012c000"
        },
        {
          "pid": 36,
          "parentPid": 2,
          "comm": "scsi_eh_0",
          "state": "sleeping",
          "taskAddress": "0xffff888002beab80",
          "mmAddress": null,
          "stackAddress": "0xffffc9000013c000"
        },
        {
          "pid": 37,
          "parentPid": 2,
          "comm": "kworker/R-scsi_",
          "state": "idle",
          "taskAddress": "0xffff888002beba00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000144000"
        },
        {
          "pid": 38,
          "parentPid": 2,
          "comm": "scsi_eh_1",
          "state": "sleeping",
          "taskAddress": "0xffff888002bec880",
          "mmAddress": null,
          "stackAddress": "0xffffc9000014c000"
        },
        {
          "pid": 39,
          "parentPid": 2,
          "comm": "kworker/R-scsi_",
          "state": "idle",
          "taskAddress": "0xffff888002bed700",
          "mmAddress": null,
          "stackAddress": "0xffffc90000154000"
        },
        {
          "pid": 40,
          "parentPid": 2,
          "comm": "kworker/u4:3",
          "state": "idle",
          "taskAddress": "0xffff888002bee580",
          "mmAddress": null,
          "stackAddress": "0xffffc9000015c000"
        },
        {
          "pid": 41,
          "parentPid": 2,
          "comm": "kworker/0:2",
          "state": "idle",
          "taskAddress": "0xffff888003048000",
          "mmAddress": null,
          "stackAddress": "0xffffc90000164000"
        },
        {
          "pid": 42,
          "parentPid": 2,
          "comm": "kworker/u5:0",
          "state": "idle",
          "taskAddress": "0xffff888003048e80",
          "mmAddress": null,
          "stackAddress": "0xffffc9000016c000"
        },
        {
          "pid": 43,
          "parentPid": 2,
          "comm": "kworker/0:1H",
          "state": "idle",
          "taskAddress": "0xffff888003049d00",
          "mmAddress": null,
          "stackAddress": "0xffffc90000174000"
        },
        {
          "pid": 44,
          "parentPid": 2,
          "comm": "kworker/0:3",
          "state": "idle",
          "taskAddress": "0xffff88800304ab80",
          "mmAddress": null,
          "stackAddress": "0xffffc90000180000"
        },
        {
          "pid": 61,
          "parentPid": 1,
          "comm": "init",
          "state": "sleeping",
          "taskAddress": "0xffff88800304d700",
          "mmAddress": "0xffff88800284cf00",
          "stackAddress": "0xffffc90000188000"
        },
        {
          "pid": 62,
          "parentPid": 1,
          "comm": "sh",
          "state": "sleeping",
          "taskAddress": "0xffff88800304c880",
          "mmAddress": "0xffff88800284d400",
          "stackAddress": "0xffffc90000134000"
        }
      ]
    },
    "note": "与复位、引导、控制位切换、start_kernel、PID1及ext2均为同一2026-10-18真实会话；串口提示符已核对。"
  }
};

export const lowMemorySamples = [
  {
    "attribution": {
      "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
      "epoch": 1,
      "frameId": 16,
      "captureId": "cap-f9c50335-17"
    },
    "addressSpace": "physical",
    "address": "0x0",
    "length": 256,
    "bytes": "U/8A8FP/APDD4gDwU/8A8FP/APBU/wDwU/8A8FP/APCl/gDwh+kA8D3UAPA91ADwPdQA8D3UAPBX7wDwPdQA8AZWAMBN+ADwQfgA8P7jAPA55wDwWfgA8C7oAPDS7wDwYtQA8PLmAPBu/gDwU/8A8FP/APBT/wDwfGAA8ECUAMBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8FP/APBT/wDwU/8A8A==",
    "hex": "53ff00f053ff00f0c3e200f053ff00f053ff00f054ff00f053ff00f053ff00f0a5fe00f087e900f03dd400f03dd400f03dd400f03dd400f057ef00f03dd400f0065600c04df800f041f800f0fee300f039e700f059f800f02ee800f0d2ef00f062d400f0f2e600f06efe00f053ff00f053ff00f053ff00f07c6000f0409400c053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f053ff00f0",
    "blobRef": "f9dbc3ade1e49c4471b30c470bc32858bc85329133733f7f2d088886fc8722ca",
    "withinCapture": true,
    "evidence": {
      "kind": "observed",
      "source": "observer",
      "captureId": "cap-f9c50335-17",
      "refs": [
        "x-oslab-read-physical:cap-17-8.2.10"
      ]
    },
    "region": "ivt",
    "label": "中断向量表前256字节",
    "kind": "recorded",
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "note": "同一完成停点的只读物理回读，绑定captureId；仅代表该完成停点的内存内容。"
  },
  {
    "attribution": {
      "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
      "epoch": 1,
      "frameId": 16,
      "captureId": "cap-f9c50335-17"
    },
    "addressSpace": "physical",
    "address": "0x10000",
    "length": 256,
    "bytes": "COhJ8f//6wGQi0X0i0AEg8ADg+D8AUX0g330AHQWoeh7AQCLUAih6HsBAAHCi0X0OcJ3kZDJw/MPHvtVieWD7Bih6HsBAIXAdB+h6HsBAIsAPW1pbWd1EaHoewEAi1AEoeh7AQAB0OsFuAAAAACJRfTrbYtF9IsAg/gCdBGLRfSLQASDwAOD4PwBRfTrUotF9ItABIPoB+iwrf//o7x5AQChvHkBAIXAdQfooPD//+tRi0X0i0AEjUj4i0X0jVAIobx5AQDoD/7//4sVvHkBAItF9ItABIPoCAHQxgAA6yKDffQAdByh6HsBAItQCKHoewEAAcKLRfQ5wg+Hc////w==",
    "hex": "08e849f1ffffeb01908b45f48b400483c00383e0fc0145f4837df4007416a1e87b01008b5008a1e87b010001c28b45f439c2779190c9c3f30f1efb5589e583ec18a1e87b010085c0741fa1e87b01008b003d6d696d677511a1e87b01008b5004a1e87b010001d0eb05b8000000008945f4eb6d8b45f48b0083f80274118b45f48b400483c00383e0fc0145f4eb528b45f48b400483e807e8b0adffffa3bc790100a1bc79010085c07507e8a0f0ffffeb518b45f48b40048d48f88b45f48d5008a1bc790100e80ffeffff8b15bc7901008b45f48b400483e80801d0c60000eb22837df400741ca1e87b01008b5008a1e87b010001c28b45f439c20f8773ffffff",
    "blobRef": "952adb83c0dd0a60d73be1627dc44e6cc80f6c58dfdd36b16990c68a27481367",
    "withinCapture": true,
    "evidence": {
      "kind": "observed",
      "source": "observer",
      "captureId": "cap-f9c50335-17",
      "refs": [
        "x-oslab-read-physical:cap-17-8.2.10"
      ]
    },
    "region": "setup",
    "label": "低位引导工作区样本，未宣称属于Linux setup",
    "kind": "recorded",
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "note": "同一完成停点的只读物理回读，绑定captureId；仅代表该完成停点的内存内容。"
  },
  {
    "attribution": {
      "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
      "epoch": 1,
      "frameId": 16,
      "captureId": "cap-f9c50335-17"
    },
    "addressSpace": "physical",
    "address": "0x100000",
    "length": 256,
    "bytes": "/PqNpugBAADoAAAAAF2D7Q2NhRDQYgCJQAIPARC4GAAAAI7YjsCO4I7ojtCNpQAUYwBqCI2FPAAAAFDL6N/jYQCFwA+FzuNhAInri4YwAgAASAHD99Ahw4H7AAAAAXMFuwAAAAEDnmACAACB6wCAZgAPIOCDyCAPIuAx0o27AHBkADHAuQAYAADzq427AHBkAI2HBxAAAIkHAVcEjbsAgGQAjYcHEAAAuQQAAACJBwFXBAUAEAAAg8cISXXwjbsAkGQAuIMBAAC5AAgAAIkHAVcEBQAAIACDxwhJdfCNgwBwZAAPIti5gAAAwA8yD7roCA8wMcAPANC4IAAAAA8A2A==",
    "hex": "fcfa8da6e8010000e8000000005d83ed0d8d8510d062008940020f0110b8180000008ed88ec08ee08ee88ed08da5001463006a088d853c00000050cbe8dfe3610085c00f85cee3610089eb8b86300200004801c3f7d021c381fb000000017305bb00000001039e6002000081eb008066000f20e083c8200f22e031d28dbb0070640031c0b900180000f3ab8dbb007064008d870710000089070157048dbb008064008d8707100000b9040000008907015704050010000083c7084975f08dbb00906400b883010000b9000800008907015704050000200083c7084975f08d83007064000f22d8b9800000c00f320fbae8080f3031c00f00d0b8200000000f00d8",
    "blobRef": "14e1c7d22c8c128def76f6bc662e2819531ce71f474af92334b04915b4480f84",
    "withinCapture": true,
    "evidence": {
      "kind": "observed",
      "source": "observer",
      "captureId": "cap-f9c50335-17",
      "refs": [
        "x-oslab-read-physical:cap-17-8.2.10"
      ]
    },
    "region": "decompressor",
    "label": "压缩内核入口字节样本",
    "kind": "recorded",
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "note": "同一完成停点的只读物理回读，绑定captureId；仅代表该完成停点的内存内容。"
  },
  {
    "attribution": {
      "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
      "epoch": 1,
      "frameId": 16,
      "captureId": "cap-f9c50335-17"
    },
    "addressSpace": "physical",
    "address": "0x1000000",
    "length": 256,
    "bytes": "SYn3SI0lTj/gALkBAQDASI0V6n8CAYnQSMHqIA8w6E0CAABqEEiNBQMAAABQSMvoHCADAEiNPcX///9Mif7oLQAAAEiNDbZfDQFIAcgPItj/JfrFFwFmLg8fhAAAAAAAkJCQkJCQkJCQkJCQkJCQkGYPHwBVSIn4SI0VgX8NAUjB6C5IieVBVUFUUw+FuAEAAEnHwAAAAIFIifhMKcBIjbAAAACASInxSI0FYS/jAEiJMIHh//8fAA+FjQEAAEiNBTtfDQFMjQ003+IASAGw+A8AAEyNUmNMjaIAEAAASQGx8A8AAEkBsfgPAABMjQ0N/+IASQGx2A8AAEkBsdAPAA==",
    "hex": "4989f7488d254e3fe000b9010100c0488d15ea7f020189d048c1ea200f30e84d0200006a10488d05030000005048cbe81c200300488d3dc5ffffff4c89fee82d000000488d0db65f0d014801c80f22d8ff25fac51701662e0f1f84000000000090909090909090909090909090909090660f1f00554889f8488d15817f0d0148c1e82e4889e541554154530f85b801000049c7c0000000814889f84c29c0488db0000000804889f1488d05612fe30048893081e1ffff1f000f858d010000488d053b5f0d014c8d0d34dfe2004801b0f80f00004c8d52634c8da2001000004901b1f00f00004901b1f80f00004c8d0d0dffe2004901b1d80f00004901b1d00f00",
    "blobRef": "8013ec8c464987651caa7856a526443222593f539c944125e79e7184827cb992",
    "withinCapture": true,
    "evidence": {
      "kind": "observed",
      "source": "observer",
      "captureId": "cap-f9c50335-17",
      "refs": [
        "x-oslab-read-physical:cap-17-8.2.10"
      ]
    },
    "region": "kernel",
    "label": "主内核物理入口附近样本",
    "kind": "recorded",
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "note": "同一完成停点的只读物理回读，绑定captureId；仅代表该完成停点的内存内容。"
  },
  {
    "attribution": {
      "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
      "epoch": 1,
      "frameId": 16,
      "captureId": "cap-f9c50335-17"
    },
    "addressSpace": "physical",
    "address": "0x400",
    "length": 256,
    "bytes": "+AMAAAAAAAAAAAAAAADAnyYCAH8CAAAAAAAeAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANQAAAQAAAAAAAAAAAAAAAAAAAAAAAABwYA1AMAAAAAAAAA2I4UAAAAAAAAAcAAAAAAAAoAAAAeAD4AGBAAYPlRCAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAoGYAwAAAAAAAAAAAAAAAAABAAwBGZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    "hex": "f803000000000000000000000000c09f2602007f0200000000001e001e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000350000010000000000000000000000000000000000000070600d40300000000000000d88e1400000000000001c000000000000a0000001e003e0018100060f951080000000000000000000000100000000000000000000000000000000000a06600c0000000000000000000000000004003004667000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "blobRef": "0a4e4e02051068dc15f11ceb36691bdf02553aa037f8aa995020dbec5fe40037",
    "withinCapture": true,
    "evidence": {
      "kind": "observed",
      "source": "observer",
      "captureId": "cap-f9c50335-17",
      "refs": [
        "x-oslab-read-physical:cap-17-8.2.10"
      ]
    },
    "region": "bda",
    "label": "BIOS数据区前256字节",
    "kind": "recorded",
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "note": "同一完成停点的只读物理回读，绑定captureId；仅代表该完成停点的内存内容。"
  },
  {
    "attribution": {
      "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
      "epoch": 1,
      "frameId": 16,
      "captureId": "cap-f9c50335-17"
    },
    "addressSpace": "physical",
    "address": "0x7c00",
    "length": 256,
    "bytes": "6AAA6zsAAAAQAAAAjBIAABuKAADaOtHlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFsxwI7QvABgjtiOwL7dfC5mi48NAGYJyXR2ZoHB/wcAAGbB6QsuZou3CQDoBQDqAAAgCGYxwGoQZkZmUGZWaAAIZlBqEGYx/4nmi3wQZjnPdgNmic+JfAJmUbRCzRNzFrRCzRNzENHvdCOJfBCJfAK0Qs0TcvCJ+MHgBwFEBmYBfAhmWWYp+XXBg8QSw77qfLQOMduszRA8AHX56/5ubyBib290IGluZm8AY2Ryb20gcmVhZCBmYWlscwAAAAAAAA==",
    "hex": "e80000eb3b000000100000008c1200001b8a0000da3ad1e5000000000000000000000000000000000000000000000000000000000000000000000000000000005b31c08ed0bc00608ed88ec0bedd7c2e668b8f0d006609c974766681c1ff07000066c1e90b2e668bb70900e80500ea000020086631c06a1066466650665668000866506a106631ff89e68b7c106639cf76036689cf897c026651b442cd137316b442cd137310d1ef7423897c10897c02b442cd1372f089f8c1e00701440666017c0866596629f975c183c412c3beea7cb40e31dbaccd103c0075f9ebfe6e6f20626f6f7420696e666f006364726f6d2072656164206661696c73000000000000",
    "blobRef": "7a40669766df958371d38e1da292739bfbb0702c69cf1a9a2a07bf99544682ea",
    "withinCapture": true,
    "evidence": {
      "kind": "observed",
      "source": "observer",
      "captureId": "cap-f9c50335-17",
      "refs": [
        "x-oslab-read-physical:cap-17-8.2.10"
      ]
    },
    "region": "boot",
    "label": "光盘引导镜像窗口前256字节",
    "kind": "recorded",
    "sessionId": "f9c50335-5722-4fc9-8072-5da032b5c848",
    "frameId": 16,
    "captureId": "cap-f9c50335-17",
    "capturedAt": "2026-10-17T20:33:51.771Z",
    "note": "同一完成停点的只读物理回读，绑定captureId；仅代表该完成停点的内存内容。"
  }
];

/** Flatten register fields while preserving full 80/128-bit string values. */
export function flattenCpu(cpu = {}) {
  const registers = Object.fromEntries(registerGroups.flatMap(group => group.items.map(r => [r.id, null])));
  const metadata = {};
  for (const item of cpu.general || []) registers[item.name.toLowerCase()] = item.value;
  Object.assign(registers, cpu.control || {}, { rip: cpu.rip ?? null, linearPc: cpu.linearPc ?? null, rflags: cpu.eflags ?? null, efer: cpu.efer ?? null, cpl: cpu.cpl ?? null });
  for (const [id, segment] of Object.entries(cpu.segments || {})) registers[id] = segment.selector;
  Object.assign(registers, { gdtrBase: cpu.gdt?.base ?? null, gdtrLimit: cpu.gdt?.limit ?? null, idtrBase: cpu.idt?.base ?? null, idtrLimit: cpu.idt?.limit ?? null });
  for (const item of cpu.extended?.registers || []) {
    if (!(item.name in registers)) continue;
    registers[item.name] = item.value ?? null;
    metadata[item.name] = item;
  }
  return { registers, metadata };
}
function sameWord(a, b) {
  if (a === b) return true;
  try { return BigInt(a) === BigInt(b); } catch { return false; }
}

export function decodeFlags(registers, evidence = {}) {
  return flagDefinitions.map(flag => {
    const raw = registers[flag.register];
    let value = null;
    if (raw !== null && raw !== undefined) {
      try { value = Number((BigInt(raw) >> BigInt(flag.bit)) & ((1n << BigInt(flag.width)) - 1n)); } catch { /* unknown stays unknown */ }
    }
    return { ...flag, value, kind: value === null ? 'unknown' : evidence[flag.register] || 'recorded' };
  });
}

function diffMemory(before, after) {
  if (!before || !after || before.sessionId !== after.sessionId || before.frameId >= after.frameId) return null;
  const key = m => `${m.addressSpace}:${BigInt(m.address)}:${m.length}`;
  const old = new Map((before.memory || []).filter(m => m.bytes).map(m => [key(m),m]));
  const windows = [];
  for (const current of after.memory || []) {
    if (!current.bytes) continue;
    const prior = old.get(key(current));
    if (!prior || prior.bytes.length !== current.bytes.length) continue;
    const changedOffsets = [];
    for (let offset=0; offset<current.length; offset++) if (prior.bytes.slice(offset*2,offset*2+2).toLowerCase() !== current.bytes.slice(offset*2,offset*2+2).toLowerCase()) changedOffsets.push(offset);
    windows.push({addressSpace:current.addressSpace,address:current.address,length:current.length,changedBytes:changedOffsets.length,changedOffsets,beforeBytes:prior.bytes,beforeCaptureId:before.captureId,afterCaptureId:after.captureId});
  }
  return {fromFrameId:before.frameId,toFrameId:after.frameId,windows,changedBytes:windows.reduce((n,w)=>n+w.changedBytes,0),note:'只比较两个停点都记录到的同地址窗口；变化是采样间净变化，窗口外的内容未知。'};
}

export function getStepState(indexOrId) {
  const index = typeof indexOrId === 'string' ? steps.findIndex(s => s.id === indexOrId) : indexOrId;
  const selected = steps[Math.max(0, Math.min(steps.length - 1, Number.isFinite(index) ? Math.floor(index) : 0))];
  const frame = selected.evidenceKey ? recordedFrames[selected.evidenceKey] || null : null;
  const { registers, metadata: registerMetadata } = flattenCpu(frame?.cpu);
  const registerEvidence = Object.fromEntries(Object.entries(registers).map(([id,value]) => [id,value == null ? 'unknown' : 'recorded']));
  const sourceFlags = selected.cpu.bits || {};
  const flags = decodeFlags(registers, registerEvidence).map(flag => !frame && flag.id in sourceFlags
    ? { ...flag, value: sourceFlags[flag.id], kind: 'source-inferred' } : flag);
  const previousStep = steps.slice(0, selected.index).reverse().find(step => step.evidenceKey);
  const previous = selected.evidenceBeforeKey ? recordedFrames[selected.evidenceBeforeKey] : previousStep ? recordedFrames[previousStep.evidenceKey] : null;
  // Deltas report net changes between captured endpoints in the same session.
  const changedRegisters = [];
  const registerChanges = [];
  let sampleDelta = null;
  if (frame && previous && frame.sessionId === previous.sessionId) {
    const old = flattenCpu(previous.cpu).registers;
    const segmentChanges = [];
    for (const [id, segment] of Object.entries(frame.cpu.segments || {})) {
      const before = previous.cpu.segments?.[id];
      if (!before) continue;
      const fields = Object.keys(segment).filter(field => before[field] !== segment[field]).map(field => ({ field, before: before[field], after: segment[field] }));
      if (fields.length) segmentChanges.push({ id, before, after: segment, fields, kind: 'recorded' });
    }
    for (const [key, value] of Object.entries(registers)) if (old[key] != null && value != null && !sameWord(old[key], value)) {
      changedRegisters.push(key);
      registerChanges.push({ id: key, before: old[key], after: value, kind: 'recorded' });
    }
    const beforeFlags = decodeFlags(old);
    sampleDelta = {
      fromStepId: selected.evidenceBeforeKey ? null : previousStep.id,
      fromEvidenceKey: selected.evidenceBeforeKey || previousStep.evidenceKey,
      fromFrameId: previous.frameId, toFrameId: frame.frameId,
      scope: 'between-recorded-checkpoints', registers: registerChanges, segments: segmentChanges,
      flags: flags.filter((flag, i) => flag.value !== null && beforeFlags[i].value !== null && flag.value !== beforeFlags[i].value)
        .map(flag => ({ ...flag, before: beforeFlags.find(oldFlag => oldFlag.id === flag.id).value, after: flag.value })),
      note: '两个真实历史停点之间的净变化；归因范围是整个采样间隔，具体指令归因需要指令级证据。',
    };
  }
  const changes = new Map();
  for (const step of steps.slice(0, selected.index + 1)) for (const change of step.memoryChanges) changes.set(change.region, { ...change, stepId: step.id });
  let displayMode = frame?.cpu.mode || selected.cpu.mode || '未逐指令采样';
  if (frame) {
    const longActive = (BigInt(frame.cpu.efer || 0) & (1n << 10n)) !== 0n;
    const csLong = (BigInt(frame.cpu.segments?.cs?.attributes || 0) & (1n << 21n)) !== 0n;
    const csDefault32 = (BigInt(frame.cpu.segments?.cs?.attributes || 0) & (1n << 22n)) !== 0n;
    if (longActive && !csLong) displayMode = csDefault32 ? 'compatibility-32 / 长模式兼容子模式' : 'compatibility-16 / 长模式兼容子模式';
  }
  return {
    step: selected, stage: stages[selected.stageIndex], registers, registerEvidence, registerMetadata, flags,
    mode: displayMode, frame,
    segments: frame?.cpu.segments || null, currentTask: frame?.os?.current || null,
    memory: frame?.memory || [], lowMemory: (frame?.memory || []).filter(m => m.addressSpace === 'physical' && BigInt(m.address) < 0x100000n),
    provenance: frame ? { kind: 'recorded', label: '历史真实采样', sessionId: frame.sessionId, frameId: frame.frameId, captureId: frame.captureId, capturedAt: frame.capturedAt, note: [frame.note, selected.sampleBinding?.note].filter(Boolean).join(' '), position: selected.sampleBinding?.position || 'checkpoint' }
      : { kind: selected.kind, label: selected.kind === 'schematic' ? '机制示意' : '源码推导 · 数值未采样', note: selected.samplingGap || '通用寄存器保留未知；标志位只展示本段源码能够确定的条件。' },
    memoryRegions: memoryRegions.map(region => ({ ...region, lastChange: changes.get(region.id) || null, active: selected.memoryChanges.some(c => c.region === region.id), kind: 'schematic' })),
    activeComponents: selected.components, changedRegisters, sampleDelta, memoryDelta: diffMemory(previous,frame),
  };
}

/** Install the generated projection; immutable raw evidence stays in its JSON artifact. */
export function applySamplingEvidence(bundle) {
  if (!bundle?.frames || !bundle.bindings) throw new Error('Invalid sampling index');
  const ids = new Set(steps.map(step=>step.id));
  for (const [id,binding] of Object.entries(bundle.bindings)) {
    if (!ids.has(id) || !bundle.frames[binding.evidenceKey]) throw new Error(`Unknown sample binding: ${id}`);
  }
  for (const key of Object.keys(recordedFrames)) delete recordedFrames[key];
  Object.assign(recordedFrames,bundle.frames);
  const gaps = {
    'power-off':'断电时 CPU 停止执行；实测从硬件复位开始。',
    'bios-stack':'本机固件缺少匹配的调试符号；尚未校准固件建立栈的精确指令。',
    'bios-tables':'各停点已读取 IVT 和 BIOS 数据区；固件写入它们的精确指令尚未校准。',
    'bios-devices':'尚未校准本机 SeaBIOS 设备初始化的内部执行边界。',
    'grub-core':'本机 GRUB 缺少匹配的符号 ELF；尚未校准核心装入边界。',
    'grub-kernel':'setup 交接时已读取内核和参数；GRUB linux16 内部装载操作尚未单独校准。',
    'grub-initrd':'setup 交接时已读取 initrd 地址；GRUB initrd16 内部操作尚未单独校准。',
    'next-key':'这是后续输入路径的机制预览；实际输入在真实调试会话中进行。',
  };
  for (const step of steps) {
    const binding=bundle.bindings[step.id];
    step.evidenceKey=binding?.evidenceKey || null;
    step.evidenceBeforeKey=binding?.evidenceBeforeKey || null;
    step.sampleBinding=binding || null;
    step.samplingGap=binding?null:(gaps[step.id] || bundle.unboundSteps.find(g=>g.id===step.id)?.reason || '此操作尚未单独采样。');
  }
  lowMemorySamples.splice(0,lowMemorySamples.length,...bundle.lowMemorySamples);
  machine.provenance=`同一次真实启动：${bundle.capturedAt}；${Object.keys(bundle.bindings).length}/${steps.length} 教学步骤绑定真实停点，原始证据 ${bundle.source}。`;
  machine.boundaries=machine.boundaries.map(note=>note.includes('调试、浮点、向量与 MSR')?'调试、x87 与 XMM 原始值已采集；完整 FTW 和部分 MSR 仍以字段原因标记为未知。':note);
}
applySamplingEvidence(sampling);

export async function loadEvidence() {
  return { machine, recordedFrames, lowMemorySamples, capturedAt: Object.values(recordedFrames).at(-1)?.capturedAt, live: false };
}

export default { machine, registerGroups, flagDefinitions, memoryRegions, virtualRegions, stages, steps, recordedFrames, lowMemorySamples, getStepState, decodeFlags, loadEvidence };
