// Linux 6.12.112 sources, not additional runtime samples.
const SEGMENT = 'https://github.com/gregkh/linux/blob/v6.12.112/arch/x86/include/asm/segment.h';
const COMMON = 'https://github.com/gregkh/linux/blob/v6.12.112/arch/x86/kernel/cpu/common.c';
const FSGS = 'https://docs.kernel.org/arch/x86/x86_64/fsgs.html';
const STACKS = 'https://docs.kernel.org/arch/x86/kernel-stacks.html';
const SDM = 'https://cdrdv2-public.intel.com/819714/253668-sdm-vol-3a.pdf';
const step = (title, say, scene, task, why, cards, extra = {}) => ({ say, lesson: {
  part: 4, real: true, title, scene, task, why, cards, bridge: '实际用途', direction: '↔', ...extra,
} });
export const LINUX_STEPS = [
  step('刚才只有 3 项，是为了教学；Linux 的 GDT 更完整',
    'GDT 并不规定只有 3 项。本项目内核的 64 位 GDT 预留 16 个槽，容纳内核、用户、兼容代码以及 TSS 等描述符。',
    'linux-gdt', '保留不同模式、不同权限和系统结构需要的描述符，而不只是一个代码段和一个数据段。',
    '前面的三项只用来解释查表；数据与栈也可以复用同一个数据段描述符。真实 Linux 通常每个 CPU 有自己的 GDT，并非每进程一张表。“16”是此版本的 64 位布局，不是硬件固定数量。',
    [['GDT 的位置', '由各 CPU 的 GDTR 保存'], ['槽与描述符', '普通段占 1 槽；64 位 TSS 描述符占 2 槽']],
    { source: SEGMENT, sourceName: 'Linux 6.12.112 · segment.h' }),
  step('32 位 Linux：把普通段铺平，再交给页表管理内存',
    '32 位 Linux 通常把普通代码段、数据段的基址设为 0，范围覆盖 4 GB。这叫平坦分段；段硬件仍在工作，但不再为每块普通内存另划一个段。',
    'linux-flat', '完成“0 + 偏移”的段地址计算，再通过分页机制翻译地址并检查权限。',
    '这是 Linux 对 32 位硬件的使用方式，不是用软件假装有段。进程的地址映射和内存隔离主要由页表承担，代码段仍保留类型和特权级等属性。',
    [['普通段基址', '0x00000000'], ['分页已开启', 'CR3 指向当前使用的页表']],
    { source: COMMON, sourceName: 'Linux 6.12.112 · GDT 初始化' }),
  step('64 位普通访存：硬件也弱化了传统分段',
    '进入 64 位子模式后，CPU 将 CS、DS、ES、SS 的寻址基址视为 0，也不按这些段的界限检查普通访问。地址仍然需要分页翻译和权限检查。',
    'linux-address64', '用指令算出的线性地址进行分页翻译；不再像前例那样加上一个非零 DS 段基址。',
    '这里要区分两件事：32 位 Linux 主动采用平坦段；64 位子模式下，普通段基址和界限的行为由硬件规则改变。FS、GS 的基址是例外，后面单独看。',
    [['CS / DS / ES / SS 基址', '寻址时视为 0；段界限不用于普通访问'], ['页表继续检查', '映射、用户/内核权限、读写和执行权限']],
    { source: SDM, sourceName: 'Intel SDM · §3.2.4、§3.4.4' }),
  step('GDT 还在用：代码段决定模式与特权级',
    '即使段基址不再分割普通地址，CPU 仍要区分内核代码和用户代码，也要知道按 64 位还是兼容方式执行。代码段描述符仍提供这些信息。',
    'linux-cs', '运行内核时使用 CS = 0x10；回到本项目的 64 位用户程序时，CS = 0x33。',
    'CS 的模式与权限属性仍然有意义。但用户程序不能访问内核内存，主要还要靠页表的用户/内核访问位等保护，不能只归因于“用户代码段范围小”。',
    [['内核代码', 'CS = 0x10 · Ring 0 · 64 位'], ['64 位用户代码', 'CS = 0x33 · Ring 3 · 64 位']],
    { source: SEGMENT, sourceName: 'Linux 6.12.112 · 代码段与选择子' }),
  step('TSS 仍有实际用途：让事件入口有合适的栈',
    '64 位 TSS 保存特权级栈指针和 IST 专用栈指针等信息。CPU 在需要的中断或异常入口使用它们，而不是靠 TSS 替 Linux 调度进程。',
    'linux-tss', '先通过 GDT 的 TSS 描述符装载 TR；之后按入口条件使用 TSS 中配置的栈信息。',
    'GDT 中的 TSS 描述符记录 TSS 结构在哪里。实际的栈指针放在 TSS 内。64 位硬件任务切换不再支持，Linux 的进程切换由内核软件完成；TSS 名字保留，用途已经改变。',
    [['TR · 任务寄存器', 'Linux TSS 选择子为 0x40'], ['TSS 中的重要字段', 'RSP0 等特权栈指针、IST 专用栈指针']],
    { source: STACKS, sourceName: 'Linux 文档 · 内核栈与 IST' }),
  step('FS 仍可有非零基址：定位当前线程的数据',
    '64 位 Linux 用户程序常用 FS 基址定位线程局部数据。两个线程可以执行相同的 FS 偏移访问，却访问各自不同的数据。',
    'linux-fs', '使用当前线程的 FS.base，加上指令里的偏移，再进行分页翻译。',
    '用户程序通常通过 arch_prctl 请求内核设置 FS 基址；CPU 支持且内核启用后，也可用 FSGSBASE 指令设置。完整 64 位基址不必来自普通 GDT 描述符的基址字段。',
    [['FS.base（线程 A，示意）', '0x0000000070000000'], ['同一条偏移访问', 'FS.base + 0x20 → 线程 A 的数据']],
    { source: FSGS, sourceName: 'Linux 文档 · FS/GS 与线程局部存储' }),
  step('GS 也在用：Linux 内核定位每个 CPU 自己的数据',
    'Linux 内核常用 GS 基址定位每 CPU 数据。不同 CPU 使用同样的偏移，就能读到各自那一份数据；主线后面设置 GS 基址就是为此。',
    'linux-gs', '把 GS.base 作为每 CPU 数据区的起点，加偏移后再通过页表访问。',
    '这不是“重新装载普通数据段就得到完整 64 位基址”。Linux 使用专用基址机制；用户态与内核态之间的 GS 基址管理还可能使用 SWAPGS。图中具体地址只是演示。',
    [['GS 的职责', '定位当前 CPU 的内核数据区'], ['实际主线中的位置', '64 位内核入口：装 GDT / IDT 并设置 GS_BASE']],
    { source: COMMON, sourceName: 'Linux 6.12.112 · CPU 初始化' }),
  step('32 位兼容程序：传统段规则仍可能出现',
    '长模式环境包含 64 位子模式和兼容子模式。如果内核启用了 32 位程序兼容支持，兼容代码仍按传统分段规则访问，TLS 等也可能使用段描述符。',
    'linux-compat', '根据代码段的模式属性决定执行方式；兼容模式和 64 位模式不能混为一谈。',
    '因此“进入长模式以后所有段机制都没了”不准确。兼容代码仍有传统段语义，而分页和事件入口沿用长模式环境的机制。这里说明架构与配置可能性，不代表本实验启用了兼容程序。',
    [['原生 64 位代码', 'CS.L = 1，CS.D = 0'], ['32 位兼容代码', 'CS.L = 0，CS.D = 1']],
    { source: SDM, sourceName: 'Intel SDM · 兼容模式与模式切换' }),
  step('IDT / IDTR 继续工作：64 位门改为 16 字节',
    '64 位内核仍通过 IDT 分派传统中断和异常。后面用户程序的缺页异常就是实际例子：页表发现缺映射，CPU 转到 IDT 中的缺页入口。',
    'linux-idt64', '按异常编号 14 找到 64 位入口，检查目标代码段，并按入口条件选择栈，运行内核缺页处理程序。',
    '这里采用教程的传统 IDT 事件路径。64 位门每项 16 字节，不再是前例的 8 字节。SYSCALL 则使用专用寄存器配置入口，不能把所有进入内核的方式都说成查 IDT。',
    [['IDTR', '仍定位 IDT；每个 64 位门占 16 字节'], ['缺页异常', '编号 14（0x0E）→ 内核缺页处理']],
    { source: SDM, sourceName: 'Intel SDM · §6.14' }),
  step('带着这些区别，继续看真实的 Linux 启动',
    '先看 Linux 如何建立平坦段、进入 64 位，再看它装内核 GDT、设置 GS、进入用户态并处理缺页。它们会把这里的实际职责逐一用起来。',
    'linux-route', '把“地址怎样翻译”和“代码模式、特权级、事件入口如何建立”分开理解。',
    '三项段表是认识硬件流程的最小例子。现代 Linux 普通内存主要依靠分页；GDT / GDTR、TSS、FS / GS 和 IDT / IDTR 仍各有职责。后面步骤展示的是本项目的 64 位启动路径。',
    [['普通内存访问', '主要看页表映射与权限'], ['仍然保留的基础设施', '代码段属性、TSS、FS/GS 基址、IDT']],
    { end: true, source: SEGMENT, sourceName: 'Linux 6.12.112 · 实际 GDT 布局' }),
];

const card = (title, content) => `<div class="linux-box"><b>${title}</b><p>${content}</p></div>`;
const source = l => `<a class="linux-source" href="${l.source}" target="_blank" rel="noreferrer">依据：${l.sourceName}</a>`;
export function linuxMemory(l) {
  let body = '';
  if (l.scene === 'linux-gdt') {
    const rows = [['0', '空描述符'], ['1 / 2 / 3', '32 位内核代码 / 64 位内核代码 / 内核数据'], ['4 / 5 / 6', '32 位用户代码 / 用户数据 / 64 位用户代码'], ['8–9', '一个 16 字节 TSS 描述符，占两个槽'], ['10–11', 'LDT（局部描述符表）位置，按需使用'], ['12–14', 'TLS（线程局部存储）描述符位置'], ['15', 'CPU / 内存节点信息']];
    body = `<div class="basic-table linux-table"><h3>Linux 6.12.112 · 64 位每 CPU GDT</h3><table><thead><tr><th>8 字节槽编号</th><th>用途（省略保留槽 7）</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table><p class="linux-footnote">共 16 个槽、128 字节；部分槽按需使用。“槽数”不等于“有效描述符数”。32 位内核的布局不同。</p></div>`;
  } else if (l.scene === 'linux-flat') {
    body = card('教学例子：非零段基址，分页关闭', '段基址 0x3000 + 偏移 0x05 → 线性地址 0x3005 → 物理内存')
      + card('32 位 Linux 普通段：平坦分段', '段基址 0x00000000 + 偏移 0x00403005 → 线性地址 0x00403005')
      + card('分页：决定映射和访问权限', '线性地址 → 当前进程的页表 / TLB → 允许访问的物理内存');
  } else if (l.scene === 'linux-address64') {
    body = card('指令算出普通访问地址（示意）', '例如 0x0000000000403005；不再附加一个非零 DS 段基址')
      + card('CPU 做分页翻译和保护检查', '通过当前页表与 TLB 获得映射；检查用户/内核、读写、执行等权限')
      + card('通过检查才访问物理内存', '页未映射或权限不允许 → 缺页异常；不是去检查一个“小数据段”的边界');
  } else if (l.scene === 'linux-cs') {
    body = `<div class="basic-table linux-table"><h3>同样基址为 0，代码属性仍不同</h3><table><thead><tr><th>选择子</th><th>用途</th><th>代码属性</th></tr></thead><tbody><tr><td>0x10</td><td>内核 64 位代码</td><td>L=1，DPL=0</td></tr><tr><td>0x33</td><td>用户 64 位代码</td><td>L=1，DPL=3</td></tr><tr><td>0x23</td><td>用户兼容代码</td><td>L=0，DPL=3</td></tr></tbody></table></div>`
      + card('主线中的一次实际使用', '用户 CS=0x33 → 缺页异常 → 内核 CS=0x10 → 处理后返回用户程序')
      + '<p class="linux-footnote">不是每条指令都读 GDT；装载段属性或相关控制转移时，CPU 才按相应规则使用它们。</p>';
  } else if (l.scene === 'linux-tss') {
    body = card('GDT 中的 TSS 描述符', '槽 8–9 描述 TSS 的位置；LTR 装载 TR，建立 CPU 对当前 TSS 的引用')
      + card('TSS 结构体（内核内存中）', 'RSP0 等记录特权栈指针；IST 记录特定事件所需的专用栈指针')
      + card('事件入口需要合适的栈', '按特权级变化或 IDT 的 IST 配置选用栈；SYSCALL 不会自动按这条中断路径切栈');
  } else if (l.scene === 'linux-fs') {
    body = card('线程 A（地址示意）', 'FS.base = 0x0000000070000000；访问 FS:0x20 → 线性地址 0x0000000070000020')
      + card('线程 B 执行相同偏移访问', 'FS.base = 0x0000000071000000；访问 FS:0x20 → 线性地址 0x0000000071000020')
      + card('两个地址仍需分页翻译', '各线程使用自己的线程局部数据；这不取消页表，也不恢复普通 DS 的传统分段用途');
  } else if (l.scene === 'linux-gs') {
    body = card('CPU 0（地址示意）', 'GS.base = 0xFFFF888000100000；GS:0x40 → 0xFFFF888000100040')
      + card('CPU 1 使用同样的偏移', 'GS.base = 0xFFFF888000200000；GS:0x40 → 0xFFFF888000200040')
      + card('后面会遇到这一步', '64 位内核入口重新装载 GDT / IDT，并设置 GS_BASE，建立每 CPU 数据访问环境');
  } else if (l.scene === 'linux-compat') {
    body = card('长模式环境中的两条执行路径', '64 位代码段 → 64 位子模式；32 位兼容代码段 → 兼容子模式')
      + card('兼容子模式仍有传统段语义', '代码段、数据段及部分 TLS / LDT 用法可以继续存在，是否启用取决于内核配置')
      + card('不是回到整台机器的旧式 32 位环境', '分页和事件入口仍使用长模式环境的机制；兼容程序的 IDT 门同样是 16 字节');
  } else if (l.scene === 'linux-idt64') {
    body = card('本主线：用户程序取指发生缺页', '用户访问 0x57C509 → 页表缺映射 → 异常编号 14（0x0E）')
      + card('CPU 使用 64 位入口', '表项位置 = IDTR.base + 0x0E × 0x10 = IDTR.base + 0xE0；目标是 64 位内核代码段')
      + card('建立入口环境，处理后返回', '按需使用 TSS 栈信息 → 保存现场 → 内核补充映射 → 返回，重试用户指令');
  } else {
    body = card('启动过渡：段属性仍有用途', 'Linux setup 建立平坦段 → 打开分页 → 装载 64 位 CS，开始执行 64 位指令')
      + card('64 位内核：保留的实际职责', '装内核 GDT / IDT → 设置 GS 每 CPU 基址 → 建立 TSS / 事件栈环境')
      + card('用户程序：页表与代码权限共同工作', '用户 CS=0x33 → 缺页经 IDT 进入内核 → 建立页映射 → 返回用户程序');
  }
  return body + source(l);
}
export function linuxCpu(l) {
  return l.cards.map(([name,text]) => `<div class="basic-register"><b>${name}</b><span>${text}</span></div>`).join('');
}
