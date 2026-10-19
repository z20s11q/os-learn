/**
 * Protected-mode teaching payload, not a sampled boot sequence.
 * Intel SDM Vol. 3A: §§2.4, 3.4, 3.5, 6.10–6.12 and 6.14.
 * https://cdrdv2-public.intel.com/819714/253668-sdm-vol-3a.pdf
 * Assumptions: 32-bit protected mode, paging off, CPL 0, no privilege change.
 */
import { ASSEMBLY } from './descriptor-assembly.js';

const table = (title, head, rows, hl = []) => ({ kind: 'table', title, head, rows, hl });
const diagram = (title, nodes, active, formula, note) => ({ title, nodes, active, formula, note });
const gdt = [
  ['GDTR · CPU', 'base = 0x50000，limit = 0x17'],
  ['选择子', '0x10 → index = 2，TI = 0，RPL = 0'],
  ['GDT[2] · RAM', '数据段：base = 0x20000，允许读写'],
  ['DS · CPU', '可见：0x10；隐藏缓存：基址、界限、权限'],
];
const idt = [
  ['IDTR · CPU', 'base = 0x60000，limit = 0x7FF'],
  ['向量号', 'INT 0x21 → 选第 0x21 号表项'],
  ['IDT[0x21]', '32 位中断门：CS = 0x08，EIP = 0x12340'],
  ['处理程序', '检查代码段后，装载 CS:EIP 开始执行'],
];

export const DESCRIPTOR_ACT = {
  id: 'descriptors', title: 'GDTR / IDTR 怎样查表',
  ops: [
    {
      say: '先看右侧这段汇编：LGDT 告诉 CPU 段表在哪，MOV DS 选择一个段；LIDT 告诉 CPU 中断表在哪，INT 主动触发一次查表',
      reset: true, mode: 'prot', cpl: 0, view: [0, 0x70000],
      set: { cr0: '0x1', cr3: '0x0', rip: '0x10000', rsp: '0xff00', rbx: '0x0', if: 0 },
      seg: { cs: ['0x8', '0x0'], ds: ['0x0', '未装载'], ss: ['0x10', '0x20000'] },
      mem: [
        { id: 'dcode', start: 0x10000, end: 0x14000, label: '演示代码与处理程序', kind: 'boot' },
        { id: 'ddata', start: 0x20000, end: 0x30000, label: '演示数据段', kind: 'kdata' },
        { id: 'dstack', start: 0x2fe00, end: 0x2ff00, label: '演示栈', kind: 'user' },
      ],
      mechanism: diagram('先分清：表与寄存器', [
        ['GDT · RAM', '全局描述符表：记录段的基址、界限和权限'],
        ['GDTR · CPU', '全局描述符表寄存器：记住 GDT 在哪里'],
        ['IDT · RAM', '中断描述符表：记录事件的处理入口'],
        ['IDTR · CPU', '中断描述符表寄存器：记住 IDT 在哪里'],
      ], 1, '程序写下指令；CPU 按指令使用寄存器和表', '假设引导器已建立 32 位保护模式：CS 基址为 0，栈可用，EBX = 0。示例地址不代表开机采样。'),
      focus: table('两套表，各回答一个问题', ['查什么', '由谁定位'], [
        ['这个段从哪开始、能做什么？', 'GDTR → GDT'],
        ['这个中断或异常交给谁？', 'IDTR → IDT'],
      ]),
      hit: ['ctl.gdtr', 'ctl.idtr'],
    },
    {
      say: '先读懂数据定义：gdt_ptr 是一处内存的名字，DW 放 2 字节的 limit，DD 放 4 字节的 base。这 6 字节稍后由 LGDT 读入 GDTR',
      mechanism: diagram('base 与 limit', [
        ['base', '表的第 0 个字节的线性地址'],
        ['limit', '最后一个允许访问的字节偏移'],
        ['检查边界', '表项的最后一个字节不能超过 limit'],
      ], 2, '24 字节的表 → limit = 24 − 1 = 0x17', '分页关闭时，线性地址就是物理地址；打开分页以后，表地址也要经过页表翻译。'),
      focus: table('大小与地址是两件事', ['寄存器字段', '本例 GDT'], [['base', '0x50000'], ['limit（不是表项个数）', '0x17 = 23']]),
      hit: ['ctl.gdtr', 'ctl.idtr'],
    },
    {
      say: '这几行汇编定义 GDT 的字节：DQ 放 8 字节，DW 放 2 字节，DB 放 1 字节。汇编器生成这些数据，引导器把它们加载到内存',
      mem: [{ id: 'dgdt', start: 0x50000, end: 0x50018, label: 'GDT：3 × 8 字节', kind: 'setup' }],
      poke: [[0x50000, '00 00 00 00 00 00 00 00 FF FF 00 00 00 9A CF 00 FF FF 00 00 02 92 40 00']],
      view: [0x50000, 0x50020], hl: [0x50000, 24],
      mechanism: diagram('① 软件准备 GDT', [
        ['0x50000', 'GDT[0]：空描述符'],
        ['0x50008', 'GDT[1]：代码段，base = 0，允许执行'],
        ['0x50010', 'GDT[2]：数据段，base = 0x20000，读写'],
      ], 2, 'GDT 共 3 × 8 = 24 字节，limit = 0x17', '描述符还带段界限、特权级、存在位等属性；这里只突出查表需要的字段。'),
      focus: table('本例的段描述符', ['索引', '基址', '段界限'], [['0', '空项', '—'], ['1', '0x0', '0xFFFFFFFF'], ['2', '0x20000', '0xFFFF']]),
      hit: ['mem.dgdt'],
    },
    {
      say: 'LGDT 的方括号表示读内存：从 gdt_ptr 所在的 0x52000 读取 6 字节，再把其中的 0x17 和 0x50000 分别装进 GDTR 的 limit 与 base',
      insn: 'lgdt [cs:gdt_ptr]', mean: '读记录 → GDTR.base = 0x50000，limit = 0x17',
      set: { gdtr: '0x50000', gdtrLimit: '0x17', rip: '0x10009' },
      mem: [{ id: 'dptr', start: 0x52000, end: 0x52006, label: 'gdt_ptr：limit + base', kind: 'kdata' }],
      poke: [[0x52000, '17 00 00 00 05 00']], view: [0x50000, 0x53000], hl: [0x52000, 6],
      mechanism: diagram('② 把 GDT 的位置交给 CPU', [
        ['gdt_ptr · RAM', '6 字节记录：2 字节 limit + 4 字节 base'],
        ['LGDT', '读取记录，装入 CPU 的 GDTR'],
        ['GDTR · CPU', 'base = 0x50000；limit = 0x17'],
      ], 2, '0x52000 的记录 → { limit: 0x17, base: 0x50000 }', 'cs: 指定用基址为 0 的 CS 访问记录。LGDT 只换表位置，已有段缓存与工作模式保持原值。'),
      focus: table('内存里的两个位置', ['地址', '存什么'], [['0x52000 · gdt_ptr', '17 00 | 00 00 05 00'], ['0x50000 · GDT', '真正的 3 个段描述符']]),
      flow: [{ from: 'mem.dptr', to: 'ctl.gdtr', label: 'base + limit' }], hit: ['ctl.gdtr'],
    },
    {
      say: '保护模式里的 DS 存的是选择子，不再乘 16。选择子 0x10 的高 13 位给出索引 2，TI 为 0 表示查 GDT，低两位 RPL 为 0',
      insn: 'mov ax, 0x10', mean: 'AX ← 选择子 0x10；尚未装载 DS', set: { rax: '0x10', rip: '0x1000d' },
      mechanism: diagram('③ 选择子拆成三部分', gdt, 1, '0x10 = (index 2 << 3) | (TI 0 << 2) | RPL 0', 'TI = 1 时改查 LDT；RPL 用于权限检查。这里选择 GDT 中的 Ring 0 数据段。'),
      focus: table('16 位选择子的布局', ['位', '含义', '0x10 的值'], [['15…3', 'index：槽位编号', '2'], ['2', 'TI：0 为 GDT，1 为 LDT', '0'], ['1…0', 'RPL：请求特权级', '0']]),
      hit: ['reg.rax', 'seg.ds'],
    },
    {
      say: '执行 MOV DS, AX 时才按选择子查表：0x50000 加 2 乘 8，找到 0x50010 的数据段描述符，再检查边界、类型、存在位和权限',
      insn: 'mov ds, ax', mean: '查 GDT[2]；检查通过后装载 DS 和隐藏缓存',
      set: { rip: '0x1000f' },
      seg: { ds: ['0x10', '0x20000'] }, view: [0x50000, 0x50020], hl: [0x50010, 8],
      mechanism: diagram('④ 用选择子找到描述符', gdt, 2, '表项地址 = GDTR.base + index × 8 = 0x50010', '本项最后字节偏移 0x17，恰好不超过 GDTR.limit；检查失败会产生异常。'),
      focus: table('查表后，CPU 保存什么？', ['位置', '内容'], [['DS 可见部分', '选择子 0x10'], ['DS 隐藏缓存', 'base 0x20000、limit 0xFFFF、权限']]),
      flow: [{ from: 'ctl.gdtr', to: 'mem.dgdt', label: 'base + 2 × 8' }, { from: 'mem.dgdt', to: 'seg.ds', label: '描述符 → 缓存' }],
    },
    {
      say: '以后读 DS:0x10，CPU 使用 DS 缓存的段基址：0x20000 加 0x10 得到 0x20010。每次普通访存不需要重新读 GDT',
      insn: 'mov ax, [ds:0x10]', mean: '线性地址 ← DS 缓存的 base + 偏移',
      poke: [[0x20010, '07 00']], view: [0x20000, 0x20020], hl: [0x20010, 2], set: { rax: '0x7', rip: '0x10016' }, unit: 'agu',
      mechanism: diagram('⑤ 用缓存访问数据', [
        ['指令的偏移', 'DS:0x10 → 偏移 = 0x10'],
        ['DS 隐藏缓存', '基址 = 0x20000；检查访问界限与权限'],
        ['线性地址', '0x20000 + 0x10 = 0x20010'],
        ['读内存', '分页关闭 → 物理 0x20010 → AX = 7'],
      ], 1, '选段时查 GDT；普通访存使用已经装好的段缓存', '改 GDT 或重新 LGDT 不会自动更新 DS 缓存；需要重新装载段寄存器才能读入新描述符。'),
      focus: table('不要把两个基址混起来', ['谁的 base', '用途'], [['GDTR.base = 0x50000', '找到描述符表'], ['DS 缓存 base = 0x20000', '找到段内的数据']]),
      flow: [{ from: 'seg.ds', to: 'addr:0x20010', label: '段基址 + 偏移' }, { from: 'addr:0x20010', to: 'reg.rax', label: '7' }],
    },
    {
      say: '代码段也是类似的查表过程，但 CS 要通过远跳转等控制转移来装载。选择子 0x08 找 GDT[1]，本例代码段基址为 0',
      insn: 'jmp 0x08:after_cs', mean: '查 GDT[1]；CS ← 0x08；EIP ← 0x10100',
      seg: { cs: ['0x8', '0x0'] }, set: { rip: '0x10100' }, view: [0x10000, 0x14000],
      mechanism: diagram('⑥ 代码段用 CS', [
        ['远跳转', '选择子 0x08；after_cs = 0x10100'],
        ['GDT[1]', '0x50000 + 1 × 8 → 代码段描述符'],
        ['CS 与 EIP', 'CS = 0x08；缓存 base = 0；EIP = 0x10100'],
        ['取指', '代码段基址 + EIP → 线性地址 0x10100'],
      ], 2, 'LGDT 登记表；远跳转装载 CS；两者作用不同', '进入保护模式还需要 CR0.PE 等步骤。这里已在保护模式，只演示段的选择。'),
      focus: table('同一张 GDT 的两种用途', ['段寄存器', '选择哪个描述符'], [['CS = 0x08', 'GDT[1]：代码段'], ['DS = 0x10', 'GDT[2]：数据段']]), hit: ['seg.cs', 'reg.rip'],
    },
    {
      say: '接着准备 IDT：软件给每个事件号填写一个门描述符。本例填好 0x21 号入口：代码段选择子 0x08，处理程序偏移 0x12340',
      mem: [{ id: 'didt', start: 0x60000, end: 0x60800, label: 'IDT：256 × 8 字节', kind: 'bios' }],
      // 32-bit interrupt gate: offset low, selector, reserved, P/DPL/type, offset high.
      poke: [[0x60108, '40 23 08 00 00 8E 01 00']], view: [0x600f0, 0x60120], hl: [0x60108, 8],
      mechanism: diagram('⑦ 软件准备 IDT', idt, 2, '256 × 8 = 2048 字节 → limit = 0x7FF', '这个 0x21 号入口是教学配置；向量号并不天然等于某个硬件设备。这里只展示一个已填写的门。'),
      focus: table('IDT 门描述符里的关键字段', ['字段', '本例'], [['目标代码段选择子', '0x08 → GDT[1]'], ['目标偏移', '0x12340'], ['门属性', '存在、DPL 0、32 位中断门']]), hit: ['mem.didt'],
    },
    {
      say: '执行 LIDT，把 IDT 的 base 和 limit 装进 IDTR。登记入口表并不等于打开中断，IF 是否为 1 是另一件事',
      insn: 'lidt [cs:idt_ptr]', mean: 'IDTR.base ← 0x60000；IDTR.limit ← 0x7FF',
      set: { idtr: '0x60000', idtrLimit: '0x7ff', rip: '0x10108' },
      mem: [{ id: 'diptr', start: 0x52010, end: 0x52016, label: 'idt_ptr：limit + base', kind: 'kdata' }],
      poke: [[0x52010, 'FF 07 00 00 06 00']], view: [0x50000, 0x61000],
      mechanism: diagram('⑧ 把 IDT 的位置交给 CPU', [
        ['idt_ptr · RAM', '6 字节：limit = 0x7FF；base = 0x60000'],
        ['LIDT', '读取记录，装入 CPU 的 IDTR'],
        ['IDTR · CPU', '登记完成；IF 仍为 0'],
      ], 2, 'LIDT 管“去哪里处理”；IF 管可屏蔽硬件中断的接收', 'IF = 0 不会屏蔽 CPU 异常、NMI 或软件 INT。接下来用 INT 指令主动演示查 IDT。'),
      focus: table('不要把 IDTR 与 IF 混起来', ['操作', '作用'], [['LIDT', '登记表位置，不修改 IF'], ['STI / CLI', '设置 / 清除 IF，不填写 IDT']]),
      flow: [{ from: 'mem.diptr', to: 'ctl.idtr', label: 'base + limit' }], hit: ['ctl.idtr', 'ctl.if'],
    },
    {
      say: '在 0x10108 执行 INT 0x21：程序只提供向量号，查 IDT 是 CPU 自动做的。它用 IDTR.base 加 33 乘 8，找到 0x60108 的门描述符',
      insn: 'int 0x21', mean: '入口地址 ← IDTR.base + 向量号 × 8',
      view: [0x600f0, 0x60120], hl: [0x60108, 8], unit: 'irq',
      mechanism: diagram('⑨ 按事件号查 IDT', idt, 1, '0x60000 + 0x21 × 8 = 0x60108', 'CPU 检查 IDT 边界、门是否存在及类型；软件 INT 还检查门的 DPL。本例当前特权级与门 DPL 都是 0。'),
      focus: table('两种查表，索引来自哪里？', ['表', '索引来源'], [['GDT', '段选择子的 index 字段'], ['IDT', '异常 / 中断的向量号']]),
      flow: [{ from: 'ctl.idtr', to: 'mem.didt', label: 'base + 33 × 8' }],
    },
    {
      say: '这一刻仍然是同一条 INT 指令：CPU 自动压栈保存 EFLAGS、CS 和返回地址 0x1010A，再跳到 handler。程序不需要自己写这些 PUSH',
      insn: 'INT：保存现场 → 转入处理程序', mean: 'ESP 减 12；CS ← 0x08；EIP ← 0x12340',
      set: { rsp: '0xfef4', rip: '0x12340', if: 0 }, seg: { cs: ['0x8', '0x0'] },
      poke: [[0x2fef4, '0A 01 01 00 08 00 00 00 02 00 00 00']], view: [0x2fee0, 0x2ff00], hl: [0x2fef4, 12],
      mechanism: diagram('⑩ 两张表在入口处接起来', [
        ['IDT[0x21]', '门给出选择子 0x08 与偏移 0x12340'],
        ['GDT[1]', '验证这是允许进入的代码段，装载 CS'],
        ['当前栈', '保存 EFLAGS、CS、返回 EIP = 0x1010A'],
        ['处理程序', '从 0x12340 执行；中断门会清 IF'],
      ], 3, 'IDT 指定入口；GDT 定义入口所用的代码段', '本例同特权级、无错误码，所以只展示 3 个 32 位栈槽。特权级切换或某些异常会增加保存内容。'),
      focus: table('本例中断现场：当前栈顶在下方低地址', ['地址', '保存的值'], [['0x2FEFC', 'EFLAGS = 0x2（IF 原本为 0）'], ['0x2FEF8', 'CS = 0x08'], ['0x2FEF4 ← ESP', '返回 EIP = 0x1010A']]),
      flow: [{ from: 'mem.didt', to: 'seg.cs', label: '代码段选择子' }, { from: 'reg.rip', to: 'addr:0x2fef4', label: '返回 EIP' }],
    },
    {
      say: '现在 CPU 真正开始执行 handler 里的 INC EBX：把 EBX 从 0 加到 1。看左边寄存器的变化，就知道中断表确实把执行流带到了这里',
      insn: 'inc ebx', mean: 'EBX ← 0 + 1 = 1；下一条是 IRETD',
      set: { rbx: '0x1', rip: '0x12341' }, view: [0x12340, 0x12350],
      poke: [[0x12340, '43 CF']], hl: [0x12340, 1], unit: 'alu',
      mechanism: diagram('⑪ 处理程序做一件看得见的事', [
        ['INT 0x21', '程序发出向量号，CPU 找到入口'],
        ['handler', '执行 INC EBX，把计数加一'],
        ['EBX · CPU', '0 → 1；下一步从中断返回'],
      ], 2, 'handler 是普通汇编代码，IDT 负责把 CPU 带到这里', 'IRETD 只恢复中断返回现场，不会恢复 EBX。本例故意保留加一结果；实际处理程序通常会保存和恢复用到的通用寄存器。'),
      hit: ['reg.rbx', 'reg.rip'],
    },
    {
      say: 'IRETD 恢复 EIP、CS、EFLAGS，回到 INT 后面的 resume，也就是 0x1010A。EBX 仍然等于 1，因为它不属于 CPU 自动保存的返回现场',
      insn: 'iretd', mean: 'EIP、CS、EFLAGS ← 栈；ESP 加 12',
      set: { rip: '0x1010a', rsp: '0xff00', if: 0 }, view: [0x10000, 0x14000],
      mechanism: diagram('⑫ 返回原来的执行流', [
        ['保存的现场', '栈顶：EIP → CS → EFLAGS'],
        ['IRETD', '恢复返回地址、代码段和标志'],
        ['原来的程序', '从 resume = 0x1010A 继续，EBX = 1'],
      ], 2, '进入：保存现场 + 查表；返回：恢复现场', '中断门清 IF，陷阱门不清 IF；返回时会从保存的标志中恢复 IF。本例没有硬件 IRQ，因此不演示 EOI。'),
      focus: table('从进入到返回', ['动作', '作用'], [['INT / 事件分派', '通过 IDT 找入口，保存现场'], ['IRETD', '恢复现场，继续原来的程序']]),
      hit: ['seg.cs', 'reg.rip', 'reg.rsp', 'ctl.if'],
    },
    {
      say: '模式不同，查表规则也不同：实模式中断用 4 字节的 IVT 表项；本章保护模式的门是 8 字节；64 位模式的 IDT 门改为 16 字节',
      mechanism: diagram('别把三种模式混在一起', [
        ['实模式', '普通段地址 = 段 × 16 + 偏移；IVT 项 4 字节'],
        ['32 位保护', '选择子查描述符；本例 IDT 门每项 8 字节'],
        ['64 位模式', 'IDT 每项 16 字节；GDT 仍提供代码段属性'],
      ], 1, '先认清模式，再决定怎样选段、怎样查中断表', '64 位模式通常把 CS/DS/ES/SS 基址视为 0，仍需 GDT 的代码段属性与 TSS 等描述符；FS/GS 有专用基址机制。'),
      focus: table('表寄存器的字段', ['工作模式', 'base', 'limit'], [['本章 32 位保护模式', '32 位线性地址', '16 位'], ['IA-32e 模式', '64 位线性地址', '16 位']]),
    },
    {
      say: '现在再看开机过程：先建表，再用 LGDT、LIDT 登记表位置；选段时使用 GDT，分派异常或中断时使用 IDT。下面回到真正的 CPU 复位',
      mechanism: diagram('带着两条路线继续看启动', [
        ['软件准备', '在内存填写表和 base / limit 记录'],
        ['GDTR → GDT', '选择子 → 段描述符 → 段寄存器缓存'],
        ['IDTR → IDT', '向量号 → 门描述符 → 处理程序'],
      ], 0, '寄存器定位表；编号选择表项；表项决定 CPU 怎样继续', '后面 BIOS、Linux setup、内核会换用各自的表。每次更换都围绕这两条路线。'),
      focus: table('查阅依据 · Intel SDM Vol. 3A', ['章节', '机制'], [['§2.4 / §3.4–3.5', 'GDTR、选择子、描述符与段缓存'], ['§6.10–6.12 / §6.14', 'IDTR、中断门、处理与模式差异']]),
      hit: ['ctl.gdtr', 'ctl.idtr'],
    },
  ],
};

// Each excerpt comes from the downloadable NASM source. Ranges are zero-based,
// end-exclusive within a named source section; highlight matches instruction text.
const lessonCode = [
  { parts: [['start'], ['interrupt', 1, 3]], active: ['lgdt', 'lidt'], phase: '先看完整路线',
    before: '引导器已准备 32 位环境、可用的 CS 与栈。', after: '接下来逐行读代码；先认识表，再执行装载和查表。',
    hint: '带冒号的名字是标签；方括号表示读写内存。黄色行是本步重点。' },
  { parts: [['gdt_ptr'], ['idt_ptr']], active: ['dw ', 'dd '], phase: '汇编时生成数据',
    before: 'gdt 和 idt 是两张表的起始地址。', after: 'DW + DD → 6 字节记录：先 limit，后 base。',
    hint: 'DW = 2 字节，DD = 4 字节；“表尾 − 表头 − 1”就是 limit。' },
  { parts: [['gdt']], active: ['dq ', 'dw ', 'db '], phase: '汇编时生成数据',
    before: '需要三项描述符，分别描述空项、代码段、数据段。', after: '3 × 8 = 24 字节；GDT[2] 基址拼成 0x00020000。',
    hint: 'DW、DB、DB 三行合计 8 字节；先看字段注释，不必先记住描述符编码。' },
  { parts: [['gdt_ptr'], ['start', 1, 3]], active: ['lgdt'], phase: 'CPU 执行 LGDT',
    before: 'gdt_ptr = 0x52000，那里放着 17 00 00 00 05 00。', after: 'GDTR.limit = 0x17；GDTR.base = 0x50000。',
    hint: '[cs:gdt_ptr] 从 CS 基址 0 + 0x52000 读记录；读到的 base 才指向 GDT。' },
  { parts: [['start', 2, 6]], active: ['mov ax, 0x10'], phase: 'CPU 执行 MOV AX',
    before: 'DS 是空选择子；还没有装载数据段。', after: 'AX = 0x10；DS 仍未装载。下一条才会查 GDT。',
    hint: '0x10 是选择子，不是数据地址。0x10 >> 3 = 2，所以选择第 2 号描述符。' },
  { parts: [['start', 3, 6], ['gdt', 3, 7]], active: ['mov ds, ax'], phase: 'CPU 执行 MOV DS，并自动查表',
    before: 'AX = 0x10；GDTR.base = 0x50000。', after: 'DS = 0x10；隐藏缓存的段基址 = 0x20000。',
    hint: '程序只写 MOV DS, AX；“加 index × 8、读描述符、检查权限”由 CPU 自动完成。' },
  { parts: [['data'], ['start', 4, 6]], active: ['mov ax, [ds:0x10]'], phase: 'CPU 执行内存读取',
    before: 'DS 缓存基址 0x20000；偏移 0x10；内存里的值为 7。', after: '从物理 0x20010 读出 07 00，AX = 7。',
    hint: '这里的 0x10 是段内偏移；MOV AX, 0x10 中的 0x10 则是选择子。含义由指令位置决定。' },
  { parts: [['start', 6], ['interrupt', 0, 2]], active: ['jmp 0x08:after_cs'], phase: 'CPU 执行远跳转',
    before: 'after_cs 标签位于 0x10100；代码段选择子为 0x08。', after: '查 GDT[1] → CS = 0x08；EIP = 0x10100。',
    hint: '标签只是地址的名字；远跳转同时给出代码段选择子和段内目标偏移。' },
  { parts: [['idt']], active: ['dw HANDLER', 'dw 0x08', 'db 0,'], phase: '汇编时生成中断门数据',
    before: 'handler 位于 0x12340；代码段选择子为 0x08。', after: 'IDT[0x21] 写入入口 0x08:0x12340 和中断门属性。',
    hint: '入口偏移拆成低 16 位 0x2340 和高 16 位 0x0001，CPU 使用时再拼回。' },
  { parts: [['idt_ptr'], ['interrupt', 0, 3]], active: ['lidt'], phase: 'CPU 执行 LIDT',
    before: 'idt_ptr = 0x52010，那里放着 FF 07 00 00 06 00。', after: 'IDTR.limit = 0x7FF；IDTR.base = 0x60000；IF 仍为 0。',
    hint: '此时 DS 基址已经是 0x20000，故继续用 cs: 读取绝对地址记录，避免多加 DS 基址。' },
  { parts: [['interrupt'], ['handler', 0, 1]], active: ['int 0x21'], phase: 'CPU 执行 INT：自动查入口',
    before: 'EIP = 0x10108；EBX = 0；IDTR 已登记。', after: '按 0x60000 + 0x21 × 8 找到门；目标是 handler。',
    hint: 'INT 不是 CALL handler：代码没有直接给出 handler 地址，而是交给 IDT 决定。' },
  { parts: [['interrupt', 1, 5], ['handler']], active: ['int 0x21'], phase: '同一条 INT：CPU 自动保存现场并跳转',
    before: 'INT 后的 resume = 0x1010A；ESP = 0xFF00。', after: '返回现场压栈；ESP = 0xFEF4；EIP = 0x12340。',
    hint: '栈里的 EIP、CS、EFLAGS 是 CPU 自动保存的；此时还没有执行 INC EBX。' },
  { parts: [['handler'], ['interrupt', 2, 5]], active: ['inc ebx'], phase: 'CPU 执行处理程序',
    before: 'EIP = handler = 0x12340；EBX = 0。', after: 'EBX = 1；EIP = 0x12341，指向 IRETD。',
    hint: '本例只计数一次。左边 EBX 亮起，表示执行流确实到达了处理程序。' },
  { parts: [['handler'], ['interrupt', 2, 5]], active: ['iretd', 'resume:'], phase: 'CPU 执行 IRETD',
    before: '栈顶依次保存返回 EIP、CS、EFLAGS。', after: 'EIP = resume = 0x1010A；ESP = 0xFF00；EBX 仍为 1。',
    hint: 'IRETD 恢复中断返回现场；EBX 不在这份现场里，所以计数结果留了下来。' },
  { parts: [['format'], ['gdt_ptr'], ['idt_ptr']], active: ['BITS 32'], phase: '认清例子的适用模式',
    before: '本例源代码用 BITS 32 告诉汇编器如何编码。', after: 'CPU 的保护模式由引导器设置；BITS 32 本身不切换 CPU 模式。',
    hint: '本例 LGDT/LIDT 的记录为 6 字节；64 位模式使用 10 字节记录和 16 字节 IDT 门。' },
  { parts: [['start'], ['interrupt', 1, 3]], active: ['lgdt', 'mov ds, ax', 'lidt', 'int 0x21'], phase: '把两条路线连起来',
    before: '软件先准备 GDT、IDT 以及两份小记录。', after: '装载表寄存器 → 用选择子或向量号查表 → CPU 改变执行状态。',
    hint: '可以打开完整汇编，沿着 start → after_cs → handler → resume 再读一遍。' },
];
if (lessonCode.length !== DESCRIPTOR_ACT.ops.length) throw Error('Descriptor lesson/code count mismatch');
DESCRIPTOR_ACT.ops.forEach((op, i) => {
  const lesson = lessonCode[i];
  const lines = lesson.parts.flatMap(([section, from = 0, to], index) => {
    const source = ASSEMBLY[section];
    if (!source) throw Error(`Unknown assembly section: ${section}`);
    return [...(index ? [{ gap: true }] : []), ...source.slice(from, to)];
  });
  op.mechanism.assembly = { ...lesson, lines };
});
