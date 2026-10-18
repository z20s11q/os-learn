/* Machine view: replays window.KMACHINE as CPU registers, flag/control bits, physical memory,
   the current virtual address space, devices and bus transfers. Snapshots are precomputed per
   call so rendering stays a pure function of (call index, transfer progress). */
window.KMV = (() => {
  const K = window.KMACHINE
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
  const clone = (o) => JSON.parse(JSON.stringify(o))
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)
  const wid = (s, cjk = 11, lat = 6.3) => [...String(s)].reduce((w, ch) => w + (/[\u2e80-\uffff]/.test(ch) ? cjk : lat), 0)
  const cut = (s, max, cjk, lat) => { s = String(s ?? ''); if (wid(s, cjk, lat) <= max) return s; let o = ''; for (const ch of s) { if (wid(o + ch + '…', cjk, lat) > max) break; o += ch } return o + '…' }

  const REGS = [['RIP', '现在跑到哪一行'], ['RSP', '栈顶在哪儿'], ['RAX', '返回值 / 要办的事的编号'], ['RDI', '第 1 个参数'], ['RSI', '第 2 个参数'], ['RDX', '第 3 个参数'], ['R10', '第 4 个参数'],
    ['RCX', '第 4 个参数 / 返回地址'], ['R11', '暂存旧的标志位'], ['CS', '内核还是用户程序在跑'], ['SS', '栈段'], ['FS', '我这个线程自己的数据在哪'], ['GS', '我这颗 CPU 自己的数据在哪'], ['RFLAGS', '标志位（运算记号 + 各种开关）']]
  const BITS = {
    fl: ['RFLAGS', [['AC', 18, '对齐检查；SMAP 下 stac 置 1 才允许内核访问用户页'], ['OF', 11, '溢出'], ['DF', 10, '串操作方向'], ['IF', 9, '允许可屏蔽中断'], ['TF', 8, '单步陷阱'], ['SF', 7, '符号'], ['ZF', 6, '零'], ['AF', 4, '辅助进位'], ['PF', 2, '奇偶'], ['CF', 0, '进位']]],
    cr0: ['CR0', [['PG', 31, '分页'], ['CD', 30, '禁用缓存'], ['NW', 29, '非写透'], ['AM', 18, '允许对齐检查'], ['WP', 16, '内核写只读页也触发 #PF'], ['NE', 5, 'x87 原生错误报告'], ['ET', 4, '扩展类型'], ['TS', 3, '任务已切换（延迟 FPU）'], ['EM', 2, 'x87 仿真'], ['MP', 1, '监控协处理器'], ['PE', 0, '保护模式']]],
    cr4: ['CR4', [['SMAP', 21, '禁止内核访问用户页'], ['SMEP', 20, '禁止内核执行用户页'], ['OSXSAVE', 18, 'XSAVE 指令'], ['PCIDE', 17, '进程上下文 ID'], ['FSGSBASE', 16, 'rd/wrfsbase 指令'], ['LA57', 12, '5 级页表'], ['UMIP', 11, '用户态禁止 sgdt/sidt'], ['OSXMMEXCPT', 10, 'SSE 浮点异常'], ['OSFXSR', 9, 'FXSAVE 与 SSE'], ['PGE', 7, '全局页'], ['PAE', 5, '物理地址扩展（长模式必需）'], ['PSE', 4, '大页']]],
    efer: ['EFER', [['NXE', 11, '页表 NX 位生效'], ['LMA', 10, '长模式已激活（CPU 置位）'], ['LME', 8, '允许长模式'], ['SCE', 0, 'syscall / sysret 可用']]],
  }
  const BSHORT = { OSXMMEXCPT: 'XMMEX', FSGSBASE: 'FSGS', OSXSAVE: 'XSAVE', OSFXSR: 'FXSR' }
  /* hover card: data-k → [English full name, 中文名, meaning] */
  const TIP = {
    'fl.AC': ['Alignment Check / Access Control', '对齐检查 / 访问控制', 'CR0.AM=1 时，用户态未对齐的内存访问触发 #AC。开了 SMAP 后它还是“临时放行”开关：内核在 copy_to_user / copy_from_user 前用 stac 置 1、用完 clac 清 0，期间才允许访问用户页。'],
    'fl.OF': ['Overflow Flag', '溢出标志', '有符号运算结果超出表示范围时置 1，供 jo/jno 等条件跳转使用。'],
    'fl.DF': ['Direction Flag', '方向标志', '串指令（movs、stos、cmps…）每次后地址递增（0）还是递减（1）。调用约定要求函数入口 DF=0，内核入口也会保证这一点。'],
    'fl.IF': ['Interrupt Enable Flag', '中断允许标志', '1 时 CPU 响应外部可屏蔽中断（来自 LAPIC 的 IRQ）。cli 清 0、sti 置 1；经中断门进入处理程序时 CPU 自动清 0，iretq 恢复原值。NMI 和异常不受它控制。'],
    'fl.TF': ['Trap Flag', '陷阱标志', '置 1 后每执行一条指令就产生一次调试异常 #DB，调试器靠它单步执行。'],
    'fl.SF': ['Sign Flag', '符号标志', '等于运算结果的最高位，即有符号数的正负。'],
    'fl.ZF': ['Zero Flag', '零标志', '运算结果为 0 时置 1，je/jne、cmp + 跳转都依赖它。'],
    'fl.AF': ['Auxiliary Carry Flag', '辅助进位标志', '低 4 位向高 4 位产生进位或借位时置 1，只在 BCD 运算中有用。'],
    'fl.PF': ['Parity Flag', '奇偶标志', '结果低 8 位中 1 的个数为偶数时置 1。'],
    'fl.CF': ['Carry Flag', '进位标志', '无符号运算最高位产生进位或借位时置 1；也被移位、bt 等指令借用来输出一位结果。'],
    'cr0.PG': ['Paging', '分页', '打开分页：之后所有线性地址都经 CR3 指向的页表翻译。若此时 EFER.LME=1，CPU 同时进入长模式并置 EFER.LMA。'],
    'cr0.CD': ['Cache Disable', '禁用缓存', '置 1 时关闭处理器缓存填充，正常运行时为 0。'],
    'cr0.NW': ['Not Write-through', '非写透', '与 CD 配合控制缓存写策略，正常运行时为 0。'],
    'cr0.AM': ['Alignment Mask', '对齐屏蔽', '允许 RFLAGS.AC 的对齐检查生效（只对 CPL 3 有效）。'],
    'cr0.WP': ['Write Protect', '写保护', '1 时内核（CPL 0）写只读页也会触发 #PF。写时复制（COW）依赖它：fork 后父子页面都标只读，任何一方写都会缺页并复制。'],
    'cr0.NE': ['Numeric Error', '数值错误', 'x87 浮点错误以 #MF 异常原生报告，由 CPU 原生异常机制处理。'],
    'cr0.ET': ['Extension Type', '扩展类型', '历史遗留位，表示支持 387 协处理器指令，现代 CPU 恒为 1。'],
    'cr0.TS': ['Task Switched', '任务已切换', '置 1 后第一条 x87/SSE 指令触发 #NM。本版本 Linux 在任务切换路径保存，基本保持 0。'],
    'cr0.EM': ['Emulation', '仿真', '1 时 x87 指令触发 #NM，交给软件仿真；有 FPU 的机器上为 0。'],
    'cr0.MP': ['Monitor Coprocessor', '监控协处理器', '与 TS 配合决定 wait/fwait 是否触发 #NM。'],
    'cr0.PE': ['Protection Enable', '保护模式使能', '1 表示处于保护模式（分段保护、特权级生效）。引导器跳进内核前已经置位。'],
    'cr4.SMAP': ['Supervisor Mode Access Prevention', '管理模式访问保护', '内核态读写用户页触发 #PF，除非 RFLAGS.AC=1。防止内核被诱导去解引用用户提供的指针。'],
    'cr4.SMEP': ['Supervisor Mode Execution Prevention', '管理模式执行保护', '内核态取指落在用户页上即触发 #PF，阻止“跳到用户态布置的代码”这类利用。'],
    'cr4.OSXSAVE': ['OS Support for XSAVE', 'XSAVE 支持', '允许 XSAVE/XRSTOR/XGETBV，内核用它保存和恢复 AVX 等扩展寄存器状态。'],
    'cr4.PCIDE': ['Process-Context Identifiers Enable', '进程上下文标识使能', 'CR3 低 12 位作为 PCID，TLB 表项按 PCID 区分。切换进程写 CR3 时可以不刷掉别的进程的 TLB（CR3 第 63 位 = 不刷新）。'],
    'cr4.FSGSBASE': ['FSGSBASE Enable', 'FS/GS 基址指令使能', '允许 rdfsbase/wrfsbase/rdgsbase/wrgsbase 直接读写 FS、GS 基址，省去 wrmsr。'],
    'cr4.LA57': ['57-bit Linear Addresses', '5 级页表', '启用 5 级页表、57 位虚拟地址。本演示按 4 级页表（48 位）走读，因此为 0。'],
    'cr4.UMIP': ['User-Mode Instruction Prevention', '用户态指令防护', '用户态执行 sgdt/sidt/sldt/smsw/str 触发 #GP，避免泄露内核表地址。'],
    'cr4.OSXMMEXCPT': ['OS Support for Unmasked SIMD FP Exceptions', 'SIMD 浮点异常支持', 'SSE 浮点异常以 #XM 报告给操作系统。'],
    'cr4.OSFXSR': ['OS Support for FXSAVE/FXRSTOR', 'FXSAVE 与 SSE 支持', '告诉 CPU 操作系统会保存 SSE 状态，从而允许执行 SSE 指令。'],
    'cr4.PGE': ['Page Global Enable', '全局页使能', '页表项带 G 位的映射（内核映射）在写 CR3 时保留在 TLB 中。'],
    'cr4.PAE': ['Physical Address Extension', '物理地址扩展', '页表项扩成 64 位，长模式必需。压缩阶段 arch/x86/boot/compressed/head_64.S:170 首次置位；内核 common_startup_64（arch/x86/kernel/head_64.S:201）在掩码中保留它，之后才依次置 EFER.LME 与 CR0.PG。'],
    'cr4.PSE': ['Page Size Extensions', '页大小扩展', '32 位非 PAE 分页下的 4 MiB 大页开关；长模式下大页由页表项的 PS 位决定，与此位无关。'],
    'efer.NXE': ['No-Execute Enable', '不可执行位使能', '页表项第 63 位 NX 生效：标了 NX 的页上取指触发 #PF（数据页、栈不可执行）。'],
    'efer.LMA': ['Long Mode Active', '长模式激活', '只读状态位：LME=1 且 CR0.PG=1 时由 CPU 置位，表示已进入 IA-32e 长模式。'],
    'efer.LME': ['Long Mode Enable', '长模式使能', '软件置 1 表示希望进入长模式，真正生效要等 CR0.PG 打开。'],
    'efer.SCE': ['System Call Extensions', '系统调用扩展', '允许 syscall/sysret 指令。syscall 时 CPU 从 LSTAR 取入口、从 STAR 取段选择子。'],
    'r.RIP': ['Instruction Pointer', '指令指针', '下一条要执行的指令地址。'],
    'r.RSP': ['Stack Pointer', '栈指针', '当前栈顶。用户态与内核态各有自己的栈：syscall 进入后内核从 per-CPU 区换栈，中断进入时 CPU 按 TSS.RSP0 换栈。'],
    'r.RAX': ['Accumulator', '累加寄存器', '函数返回值；syscall 时装系统调用号，返回时装结果（负数为 -errno）。'],
    'r.RDI': ['Destination Index', '目的变址寄存器', '函数和系统调用的第 1 个参数。'],
    'r.RSI': ['Source Index', '源变址寄存器', '第 2 个参数。'],
    'r.RDX': ['Data Register', '数据寄存器', '第 3 个参数。'],
    'r.R10': ['General Purpose Register 10', '通用寄存器 10', '系统调用第 4 个参数（因为 syscall 指令占用了 RCX）。'],
    'r.RCX': ['Counter Register', '计数寄存器', '普通函数的第 4 个参数；执行 syscall 时 CPU 把返回地址存进这里，sysret 再取回。'],
    'r.R11': ['General Purpose Register 11', '通用寄存器 11', '执行 syscall 时 CPU 把 RFLAGS 存进这里，sysret 再恢复。'],
    'r.CS': ['Code Segment', '代码段寄存器', '选择子低 2 位是当前特权级 CPL：0x10 内核、0x33 用户（RPL=3）。长模式下段基址为 0，只用来定特权级和 64 位模式。'],
    'r.SS': ['Stack Segment', '栈段寄存器', '0x18 内核数据段、0x2b 用户数据段；长模式下特权级变化时 CPU 可能装入空选择子。'],
    'r.FS': ['FS Segment (base)', 'FS 段基址', '用户态线程局部存储（TLS）的基址，musl/glibc 的线程指针。'],
    'r.GS': ['GS Segment (base)', 'GS 段基址', '内核用 GS 指向本 CPU 的 per-CPU 数据；swapgs 在用户值与内核值之间交换。'],
    'r.RFLAGS': ['Flags Register', '标志寄存器', '由下方各标志位拼成，位 1 恒为 1（所以最小值是 0x2）。'],
    'c.CR3': ['Control Register 3 (Page-Map Level-4 Base)', '页表根寄存器', '当前地址空间顶级页表（PML4/PGD）的物理地址；开了 PCIDE 后低 12 位是 PCID。切换进程就是换 CR3。'],
    'c.CR2': ['Control Register 2 (Page-Fault Linear Address)', '缺页地址寄存器', '发生 #PF 时 CPU 把出错的线性地址写到这里，do_page_fault 从中读取。'],
    'c.IDTR': ['Interrupt Descriptor Table Register', '中断描述符表寄存器', '指向 IDT（256 个门描述符）。中断或异常发生时，CPU 按向量号在这里找处理入口。'],
    'c.LSTAR': ['Long-mode System Call Target Address Register', '长模式系统调用入口 MSR', 'MSR 0xC0000082。syscall 指令把 RIP 设为这里的值，Linux 填的是 entry_SYSCALL_64。'],
    'c.TSC_DEADLINE': ['IA32_TSC_DEADLINE', 'TSC 截止时间 MSR', 'MSR 0x6E0。LAPIC 定时器的 TSC-deadline 模式：TSC 走到写入的值时触发一次本地定时器中断（Linux 用向量 0xec）。'],
  }
  const TIP_GROUP = { fl: 'RFLAGS', cr0: 'CR0', cr4: 'CR4', efer: 'EFER（MSR 0xC0000080）' }
  /* 点面板左侧的 RFLAGS / CR0 / CR4 / EFER 名字时弹出的整块说明 */
  const TIP_REG = {
    fl: ['FLAGS register', '标志寄存器 RFLAGS', 'CPU 每做完一次计算，会顺手记下几条"记号"：结果是不是 0、有没有进位、有没有溢出。这些记号集中放在这个小本子里，所以叫标志寄存器。它还装着几条开关：IF 决定 CPU 要不要理会外部设备发来的打断（中断），DF 决定批量复制内存时是从前往后还是从后往前，AC 是安全闸门（内核要读写你的程序的内存时得先把它打开）。第 1 位按 x86 架构规定固定为 1。'],
    cr0: ['Control Register 0', '控制寄存器 0（总模式开关台）', '这是控制 CPU "大模式"的开关台。最重要的两位：PG 打开后，程序里写的地址（虚拟地址）由页表翻译成物理地址；PE 表示 CPU 处在保护模式，能区分内核和用户程序的特权级。WP 决定内核能不能改动标记为只读的内存。另外几位管浮点运算出问题时怎么报告。'],
    cr4: ['Control Register 4', '控制寄存器 4（高级功能开关台）', '这是逐个打开 CPU 高级能力的面板。PAE 打开后才能使用 64 位的地址对照表，也才能进入 64 位长模式；PGE 让内核的翻译结果在切换进程时继续保留在缓存中，省时间；PCIDE 让这份缓存按进程分别保存；SMEP 和 SMAP 是两道安全门，禁止内核跑到用户程序的内存里执行代码或读写数据，防止内核被骗；UMIP 禁止用户程序偷看内核表格的地址。'],
    efer: ['Extended Feature Enable Register', '扩展功能设置项 EFER（编号 0xC0000080）', '它是 CPU 的模型专用寄存器（MSR），有固定编号，要用专门的读写指令去改。它管三件大事：SCE 允许程序使用 syscall 这条指令主动请内核帮忙（系统调用）；LME 表示"我要进入 64 位长模式"，但真正生效还要等 CR0 的分页开关打开；NXE 让"这块内存不许当代码执行"的标记生效，用来防溢出攻击。'],
  }
  /* 白话版悬停文案：同样以 data-k 为键，优先于上面的 TIP 使用 */
  const TIP_PLAIN = {
    'fl.AC': ['Alignment Check / Access Control', '对齐检查 / 放行开关', '两个用途。一是对齐检查：CPU 访问内存时地址没对齐，用户程序会收到一个异常（#AC）。二是"放行开关"：内核平时被禁止读写用户程序的内存（见 CR4 的 SMAP），内核要帮你拷贝数据时会先把这个位打开（指令 stac），拷完再关掉（指令 clac），这段时间才允许碰你的内存。'],
    'fl.OF': ['Overflow Flag', '溢出标志', '刚才那次运算的结果超出了能表示的范围（比如两个很大的正数相加变成负数），这一位就是 1。'],
    'fl.DF': ['Direction Flag', '方向标志', '决定批量操作内存（复制、比较一串字节）的方向：为 0 从低地址往高地址走，为 1 反向走。'],
    'fl.IF': ['Interrupt Enable Flag', '中断开关', '为 1 表示 CPU 愿意理会外部设备发来的打断信号（键盘、网卡、定时器、磁盘完成等），为 0 表示屏蔽外部可屏蔽中断。内核在需要保护的临界区先将 IF 清零。'],
    'fl.TF': ['Trap Flag', '单步开关', '置 1 后 CPU 每执行一条指令就停一次报告给调试器。调试器单步跟踪靠的就是它。'],
    'fl.SF': ['Sign Flag', '正负标志', '等于运算结果的最高位：结果为负时为 1。'],
    'fl.ZF': ['Zero Flag', '零标志', '运算结果恰好是 0 时置 1。程序里的"如果相等就跳转"就是看它。'],
    'fl.AF': ['Auxiliary Carry Flag', '半字节进位', '低 4 位向高 4 位进位或借位时置 1，只在老式的十进制（BCD）运算里有用。'],
    'fl.PF': ['Parity Flag', '奇偶标志', '结果最低 8 位里 1 的个数是偶数时置 1。'],
    'fl.CF': ['Carry Flag', '进位标志', '无符号数运算最高位发生进位或借位时置 1。移位等指令也借它来输出一位结果。'],
    'cr0.PG': ['Paging', '分页开关（地址翻译总闸）', '打开后，程序里写出的地址（虚拟地址）由页表翻译成物理地址。这张表的入口地址存在 CR3 里。内核启动过程中，最后一个合上的开关就是它：合上的一瞬间，CPU 进入 64 位长模式并开始按页表翻译。'],
    'cr0.CD': ['Cache Disable', '关缓存', '置 1 表示不使用 CPU 的缓存（CPU 和内存之间的小型快速存储）。正常运行时为 0。'],
    'cr0.NW': ['Not Write-through', '非写透', '与关缓存配合控制写缓存的策略，正常运行时为 0。'],
    'cr0.AM': ['Alignment Mask', '允许对齐检查', '它打开后，RFLAGS 里的 AC 位才有对齐检查的效果（只对用户程序有效）。'],
    'cr0.WP': ['Write Protect', '只读页保护', '置 1 后，连内核自己也不能写标记为只读的内存，否则会报缺页。父子进程共享内存（写时复制）就靠它：谁要写，谁先被拦下，内核再给它单独复制一份。'],
    'cr0.NE': ['Numeric Error', '浮点错误直接报', '浮点运算出错时用异常方式（#MF）直接报告，采用 CPU 原生异常机制。'],
    'cr0.ET': ['Extension Type', '扩展类型', '历史遗留位，表示 CPU 支持 387 的浮点指令，现代 CPU 恒为 1。'],
    'cr0.TS': ['Task Switched', '任务已切换', '置 1 后第一次执行浮点或 SIMD 指令会触发一个异常（#NM）。老内核用它来推迟保存浮点状态；现在内核改为切换时主动保存，所以它基本一直是 0。'],
    'cr0.EM': ['Emulation', '浮点用软件模拟', '置 1 表示没有浮点硬件、需要软件模拟浮点指令。真实 CPU 上为 0。'],
    'cr0.MP': ['Monitor Coprocessor', '监控协处理器', '与 TS 配合，决定 wait 指令要不要触发异常。'],
    'cr0.PE': ['Protection Enable', '保护模式开关', '为 1 表示 CPU 处于保护模式，能按特权级把内核和用户程序隔开。开机时引导程序早已把它打开。'],
    'cr4.SMAP': ['Supervisor Mode Access Prevention', '内核禁止碰用户内存', '打开后，内核（特权级 0）读写用户程序的内存会触发缺页，除非先把 RFLAGS 的 AC 位打开。目的是防止内核被用户程序递过来的坏地址骗去读写不该碰的地方。'],
    'cr4.SMEP': ['Supervisor Mode Execution Prevention', '内核禁止执行用户代码', '打开后，内核的指令指针一旦落到用户程序的内存页上取值就会触发缺页，避免攻击者把代码放在用户内存里引诱内核跳过去执行。'],
    'cr4.OSXSAVE': ['OS Support for XSAVE', '支持 XSAVE 指令', '允许使用 XSAVE / XRSTOR 指令，内核靠它一次保存和恢复一大组扩展寄存器（AVX 等）的内容。'],
    'cr4.PCIDE': ['Process-Context Identifiers Enable', '地址缓存按进程区分', '允许把 CR3 的低 12 位当作进程编号使用，CPU 的地址翻译缓存（TLB）会按编号分开保存。这样切换进程时，其他 PCID 的缓存条目可以继续保留，省下重建的开销。'],
    'cr4.FSGSBASE': ['FSGSBASE Enable', '允许直接改 FS/GS', '允许用户程序用 rdfsbase / wrfsbase 这类指令直接读写 FS、GS 的基址，由相应指令直接完成。'],
    'cr4.LA57': ['57-bit Linear Addresses', '5 级地址表', '打开后地址对照表从 4 层变成 5 层，虚拟地址从 47 位扩到 57 位。本演示按 4 层讲解，所以它是 0。'],
    'cr4.UMIP': ['User-Mode Instruction Prevention', '用户程序禁止偷看内核', '用户程序执行 sgdt / sidt / sldt / smsw / str 这几条指令会直接报错（#GP），防止它顺藤摸瓜找到内核表格的位置。'],
    'cr4.OSXMMEXCPT': ['OS Support for Unmasked SIMD FP Exceptions', 'SIMD 浮点异常支持', 'SSE 这类向量浮点指令出错时，以异常（#XM）方式报告给操作系统。'],
    'cr4.OSFXSR': ['OS Support for FXSAVE/FXRSTOR', '支持 FXSAVE 与 SSE', '告诉 CPU：操作系统会负责保存和恢复 SSE 寄存器的内容，因此可以放心执行 SSE 指令。'],
    'cr4.PGE': ['Page Global Enable', '全局页开关', '允许给某些翻译条目打上"全局"标记。打了标记的内核映射，在切换进程改写 CR3 时继续保留在缓存中，减少重建开销。'],
    'cr4.PAE': ['Physical Address Extension', '64 位地址表开关', '打开后页表项从 32 位扩成 64 位，是进入 64 位长模式的前提。压缩阶段 arch/x86/boot/compressed/head_64.S:170 第一次打开它；内核 common_startup_64（arch/x86/kernel/head_64.S:201）继续保留它，之后才依次打开长模式和分页。'],
    'cr4.PSE': ['Page Size Extensions', '大页开关', '在 32 位且不开 PAE 的分页方式下，它决定能否使用 4 MiB 的大页。到了 64 位长模式，用不用大页改由页表项里的一个位决定，与它无关，但内核仍把它统一打开以保持一致。'],
    'efer.NXE': ['No-Execute Enable', '不可执行标记生效', '让页表项里"这一页不许当代码执行"的标记真正生效。数据区、栈都打上这个标记，一旦有代码试图跳进去执行就会报缺页，能挡住很多通过覆盖返回地址来攻击的手法。'],
    'efer.LMA': ['Long Mode Active', '长模式已生效（只读）', '这个位由 CPU 自己写，软件按只读状态访问。当"想进长模式"的 LME 与"分页开关" CR0.PG 同时为 1 时，CPU 就把它置 1，表示已经真正跑在 64 位长模式里了。'],
    'efer.LME': ['Long Mode Enable', '请求进入长模式', '软件把它置 1，表示"我希望进入 64 位长模式"。还需开启 CR0 的分页开关，CPU 才会把 LMA 置 1 并开始按 64 位规则运行。'],
    'efer.SCE': ['System Call Extensions', '允许 syscall 指令', '打开后用户程序才能用 syscall / sysret 这两条指令来发起和返回系统调用。syscall 发生时，CPU 从 LSTAR 这个设置项里取内核入口地址。'],
    'r.RIP': ['Instruction Pointer', '指令指针', 'CPU 下一条要执行的指令在哪儿，也就是"现在跑到哪一行"了。'],
    'r.RSP': ['Stack Pointer', '栈顶指针', '当前临时数据（函数参数、局部变量、返回地址）存放位置在哪。用户程序和内核各有自己的栈：程序主动进内核时会换成内核的栈，被设备打断时 CPU 也会自动换栈。'],
    'r.RAX': ['Accumulator', '累加寄存器', '函数算完的结果放这里。发起系统调用时，这里放"要办什么事"的编号；办完后，结果也放回这里，负数表示出错码。'],
    'r.RDI': ['Destination Index', '第 1 个参数的寄存器', '函数和系统调用的第 1 个参数放在这里。'],
    'r.RSI': ['Source Index', '第 2 个参数的寄存器', '第 2 个参数放在这里。'],
    'r.RDX': ['Data Register', '第 3 个参数的寄存器', '第 3 个参数放在这里。'],
    'r.R10': ['General Purpose Register 10', '第 4 个参数的寄存器', '系统调用的第 4 个参数放在这里。执行 syscall 指令时 RCX 保存返回地址，因此第 4 个参数使用 R10。'],
    'r.RCX': ['Counter Register', '计数寄存器', '普通函数的第 4 个参数；执行 syscall 时，CPU 顺手把"返回后该继续执行哪条指令"的地址存在这里。'],
    'r.R11': ['General Purpose Register 11', '保存旧标志位的寄存器', '执行 syscall 时，CPU 把原来的标志位（RFLAGS）内容暂存在这里，返回用户程序时再恢复回去。'],
    'r.CS': ['Code Segment', '代码段寄存器（含运行级别）', '64 位代码模式下 CS 基址按 0 处理，主要作用是末尾 2 位表示当前运行级别：0 表示内核在运行，3 表示用户程序在运行。'],
    'r.SS': ['Stack Segment', '栈段寄存器', '配合 RSP 描述栈，长模式下同样主要用来表示运行级别。'],
    'r.FS': ['FS Segment (base)', 'FS 基址（线程自己的数据）', '用户程序用它定位"我这个线程私有的数据"（线程局部存储），比如 glibc 的线程控制块。'],
    'r.GS': ['GS Segment (base)', 'GS 基址（每个 CPU 自己的数据）', '内核用它定位"我这颗 CPU 私有的数据"（每颗 CPU 各有一份，比如当前任务指针）。用户程序和内核的这个基址不同，进出内核时会用 swapgs 指令互换。'],
    'r.RFLAGS': ['Flags Register', '标志寄存器', '由右边/下方那些一个个的标志位拼成，既装运算记号，也装中断开关等控制位。第 1 位永远是 1（所以最小值是 0x2）。'],
    'c.CR3': ['Control Register 3 (Page-Map Level-4 Base)', '地址对照表入口（页表根）', '指向当前进程的顶层地址对照表的物理地址。切换用户地址空间时按需要装载对应页表根；同一虚拟地址的映射由所属 mm 决定，内核线程可借用 active_mm。'],
    'c.CR2': ['Control Register 2 (Page-Fault Linear Address)', '出错地址记录本', '发生缺页（地址翻译失败）时，CPU 把那个惹事的地址写在这里。内核读它就知道：是哪个地址没准备好，该给谁补上内存。'],
    'c.IDTR': ['Interrupt Descriptor Table Register', '中断表地址', '指向中断描述符表（一张 256 项的表）。设备发来中断、或程序出错（除零、缺页等）时，CPU 用编号（向量号）到这张表里查出该跳去哪里处理。'],
    'c.LSTAR': ['Long-mode System Call Target Address Register', '系统调用入口设置项', '编号 0xC0000082 的设置项。用户程序执行 syscall 指令时，CPU 直接把指令指针设成这里写的地址（Linux 填的是 entry_SYSCALL_64）。'],
    'c.TSC_DEADLINE': ['IA32_TSC_DEADLINE', '定时器截止时间设置项', '编号 0x6E0 的设置项。写入一个时间点后，CPU 内部计数走到那一刻就会打断一次，内核用它来做定时（比如调度、超时）。'],
    'dev.apic.irr': ['Interrupt Request Register', '等待处理的中断排队', '这里记录"已经送到但还没开始处理"的中断请求，每位对应一个中断号。'],
    'dev.apic.isr': ['In-Service Register', '正在处理的中断', '这里记录"已经交给处理程序、还没处理完"的中断。同一个中断在处理期间通常不会再次打断。'],
    'dev.apic.timer': ['Local APIC Timer', '每颗 CPU 自己的定时器', 'CPU 内部自带的闹钟，内核用它定时打断当前代码去做调度、统计等工作。'],
    'dev.apic.icr': ['Interrupt Command Register', '给别的 CPU 发信号', '内核写这个寄存器，可以向另一颗 CPU 发出中断（比如"该重新调度了"）。'],
    'dev.ioapic.pin1': ['IO-APIC pin 1', '外部设备的接线脚', 'IO-APIC 负责把外部设备（键盘、磁盘等）的中断线汇总后送给 CPU，这里显示其中某个脚的接线与屏蔽状态。'],
    'dev.kbd.st': ['i8042 Status Register', '键盘控制器状态', '读这个端口（0x64）能知道键盘控制器那边有没有数据、忙不忙。'],
    'dev.kbd.data': ['i8042 Data Register', '键盘数据口', '按下一个键后，扫描码从这个端口（0x60）被读走。'],
    'dev.kbd.ctr': ['i8042 Command Byte', '键盘控制器配置', '一个配置字节，决定要不要产生中断、是否启用键盘等。'],
    'dev.kbd.key': ['Keyboard Scancode', '最近一次按键', '最近一次读到的按键扫描码，键盘驱动据此翻译成字符。'],
    'dev.vq.st': ['Virtqueue Status', '虚拟队列状态', '虚拟磁盘驱动和设备之间用一组约定好的字节（状态位）互相通报进度：初始化到哪一步、是否就绪、是否出错。'],
    'dev.vq.desc': ['Descriptor Ring', '搬运任务清单', '一份描述"请把哪个内存地址的数据、搬多少、搬到磁盘的哪个位置"的清单，设备照着它做。'],
    'dev.vq.avail': ['Available Ring Index', '已交办的序号', '驱动把任务写进清单后，推进这个序号，告诉设备"到第几号都可以做了"。'],
    'dev.vq.used': ['Used Ring Index', '已完成的序号', '设备做完一个任务就推进这个序号，驱动看它就知道哪些请求完成了。'],
    'dev.vq.notify': ['Notify', '敲一下门铃', '驱动写完任务后写一个寄存器通知设备"有新任务了"，这个动作叫敲门铃。'],
    'dev.disk.t': ['Disk Transfer', '磁盘上的读写动作', '虚拟磁盘当前这次操作的进度，比如已经写了多少块、从哪个扇区开始。'],
    'dev.disk.op': ['Disk Operation', '磁盘操作类型', '读还是写，以及指向磁盘上哪个位置。'],
  }
  const CTRL = [['CR3', '地址对照表的入口在哪（页表根的物理地址）；低 12 位存进程编号 PCID', 20, 484, 340], ['CR2', '最近一次地址翻译失败的地址（缺页时由 CPU 写进来）', 364, 484, 172], ['IDTR', '中断处理表在哪（一张 256 项的表格的地址）', 20, 528, 168], ['LSTAR', '用户执行 syscall 时跳去的内核入口（设置项编号 0xC0000082）', 192, 528, 168], ['TSC_DEADLINE', '定时器到点的时刻（设置项编号 0x6E0）', 364, 528, 172]]
  const MODE = { prot32: '32 位保护模式', long: '64 位长模式（长模式就是 64 位模式）' }

  /* [id, name, legend, colour]; 'rom' is reserved space with no state of its own */
  const PHYS = [
    ['p.mmio', '设备寄存器（MMIO：把设备当内存来读写）', '设备寄存器', '#f0a35e'], ['p.vq', '虚拟队列（驱动和磁盘互相传任务的环）', '虚拟队列', '#f48fb1'], ['p.pgt', '页表页（地址对照表自己占的内存）', '页表页', '#4dd0e1'],
    ['p.kstk', '内核栈（内核代码的临时数据）', '内核栈', '#c9a0ff'], ['p.slab', '小对象池（给内核结构体用的小块内存）', '小对象池', '#9ccc65'], ['p.pc', '页缓存（文件内容在内存里的副本）', '页缓存', '#6ea8ff'], ['p.anon', '匿名页（由匿名映射提供的程序内存）', '匿名页', '#e07a5f'],
    ['p.free', '空闲内存（伙伴系统管着，随时可分出去）', '空闲内存', '#56635f'], ['p.kern', '内核本体 vmlinux（压缩镜像解开后的样子）', '内核镜像', '#4cc597'], ['p.bz', '压缩的内核镜像 bzImage（开机先解压它）', '压缩镜像', '#2f8f6a'],
    ['p.vga', '显卡显存（屏幕上的文字就存在这里）', '显卡显存', '#d7dde0'], ['p.low', '低端内存 0–640 KiB：中断向量表、BIOS 数据区、引导数据（开机最先占用）', '低端内存', '#a1887f'], ['rom', '固件保留区（BIOS 程序本体、ACPI 表、显卡 BIOS，由固件保留）', '固件保留', '#3b3f3e'],
    ['p.ivt', '向量表与BDA（0x0–0x4FF：实模式中断向量表（256 项 × 4 字节 = 0x400）加 BIOS 数据区 BDA（0x400 起）。BIOS 上电后最先写，实模式程序靠它调用 BIOS 功能）', '中断向量表', '#ffb74d'],
    ['p.ebda', '扩展BIOS数据（0x9FC00–0x9FFFF：EBDA，固件放自己的私有数据。内核看到它被 e820 标成保留，按固件保留区管理）', '固件私有区', '#8d6e63'],
    ['p.bios', 'BIOS本体（0xF0000–0xFFFFF：只读 ROM 映射。复位后第一条指令 0xFFFFFFF0 经地址别名落在这里最后 16 字节，里面是一条 jmp）', 'BIOS程序', '#90a4ae'],
  ]
  const PNAME = Object.fromEntries(PHYS.map((p) => [p[0], p[1]]))
  /* illustrative physical map of a 2 GiB QEMU guest: [id, start, end) */
  const MiB = 0x100000
  const PMAP = [
    ['p.ivt', 0, 0x10000], ['p.low', 0x10000, 0x9fc00], ['p.ebda', 0x9fc00, 0xa0000], ['p.vga', 0xa0000, 0xc0000], ['rom', 0xc0000, 0xf0000], ['p.bios', 0xf0000, MiB], ['p.bz', MiB, 13 * MiB], ['p.free', 13 * MiB, 16 * MiB],
    ['p.kern', 16 * MiB, 56 * MiB], ['p.free', 56 * MiB, 0x7d800000], ['p.anon', 0x7d800000, 0x7e000000], ['p.pc', 0x7e000000, 0x7f000000],
    ['p.slab', 0x7f000000, 0x7f800000], ['p.kstk', 0x7f800000, 0x7fc00000], ['p.pgt', 0x7fc00000, 0x7fe00000], ['p.vq', 0x7fe00000, 0x80000000],
    ['p.mmio', 0xfe000000, 0xfe200000], ['p.mmio', 0xfec00000, 0xfee00000], ['p.mmio', 0xfee00000, 0xff000000], ['rom', 0xffe00000, 0x100000000],
  ]
  const regionAt = (a) => PMAP.find((r) => a >= r[1] && a < r[2])?.[0] || null
  const hx = (a) => '0x' + a.toString(16).toUpperCase().padStart(8, '0').replace(/(....)(....)/, '$1_$2')
  const KHALF = [['v.ktext', '0xffff_ffff_8100_0000', '内核镜像的代码与数据', 'p.kern'], ['v.cea', '0xffff_fe00_0000_0000', '内核入口备用区：专用栈、GDT、TSS', 'p.kern'],
    ['v.vmemmap', '0xffff_ea00_0000_0000', '每个物理页的账本结构体数组', 'p.free'], ['v.vmalloc', '0xffff_c900_0000_0000', '需要连续虚拟地址的内存（内核栈等）', 'p.kstk'], ['v.direct', '0xffff_8880_0000_0000', '直接映射：所有物理内存都在这儿现身', 'p.free']]
  const USER = (stack) => [['v.stack', stack, '用户栈（[stack]，程序临时数据）', 'p.anon'], ['v.heap', '0x0000_0000_004d_3000', '堆（[heap]，程序临时要的零散内存）', 'p.anon'], ['v.data', '0x0000_0000_004c_e000', '全局变量与已初始化数据（.data/.bss）', 'p.anon'], ['v.text', '0x0000_0000_0040_0000', '程序代码（.text，只读、可执行）', 'p.pc']]
  const SPACES = {
    none: { name: '还没开分页', note: '程序写的地址就是内存条上的真实地址', regions: [] },
    ident: { name: '早期临时对照表', note: '覆盖 0–4 GiB，2 MiB 一块的大页，写的地址就是真实地址', regions: [['v.ident', '0x0000_0000 – 0xFFFF_FFFF', '地址原样对应：虚拟地址等于物理地址', 'p.low']] },
    early: { name: 'early_top_pgt（内核自己造的第一张表）', note: '地址原样对应 + 内核镜像的高位映射', regions: [['v.ktext', '0xffff_ffff_8100_0000', '内核代码与数据（映射到 __START_KERNEL_map）', 'p.kern'], null, ['v.ident', '0x0000_0000 – …', '地址原样对应（先留着过渡，免得换表瞬间自己跑丢）', 'p.low']] },
    kernel: { name: 'init_mm（所有内核线程共用一份）', note: '低半部（用户程序那一半）是空的', regions: [...KHALF, null] },
    init: { name: 'init（1 号进程）的地址空间', note: '低半部是它自己的程序', regions: [...KHALF, null, ...USER('0x0000_7ffd_3a2a_2000')] },
    sh: { name: 'sh（命令行）的地址空间', note: '低半部是它自己的程序', regions: [...KHALF, null, ...USER('0x0000_7ffd_5c28_2000')] },
    cat: { name: 'cat（正在读文件那个程序）的地址空间', note: '低半部是它自己的程序', regions: [...KHALF, null, ...USER('0x0000_7ffc_8e1d_3000')] },
  }
  /* ---------- snapshots ---------- */
  function vgaWrite(S, text) {
    const L = S.vga.lines
    const row = Math.min(24, L.length - 1), col = L[L.length - 1].length
    const first = [...text.replace(/^\n+/, '')].slice(0, 3)
    const r0 = text.startsWith('\n') ? Math.min(24, row + 1) : row, c0 = text.startsWith('\n') ? 0 : col
    for (const ch of text) { if (ch === '\n') L.push(''); else L[L.length - 1] += ch }
    while (L.length > 25) L.shift()
    S.vgaA = 0xb8000 + (r0 * 80 + c0) * 2
    const addr = S.vgaA.toString(16).toUpperCase()
    return `写 0x${addr} ← ${first.map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0') + ' 07').join(' ')}${[...text].length > 3 ? ' …' : ''}`
  }
  function apply(S, op, chg, xs) {
    for (const k of ['cpu', 'sw']) if (op[k]) for (const [a, v] of Object.entries(op[k])) if (S[k][a] !== v) { S[k][a] = v; chg.add(`${k}.${a}`) }
    for (const k of ['r', 'c']) if (op[k]) for (const [a, v] of Object.entries(op[k])) {
      const nv = Array.isArray(v) ? v : [String(v), '']
      if (S[k][a]?.[0] !== nv[0] || S[k][a]?.[1] !== nv[1]) { S[k][a] = nv; chg.add(`${k}.${a}`) }
    }
    for (const k of ['fl', 'cr0', 'cr4', 'efer']) if (op[k]) for (const [a, v] of Object.entries(op[k])) if ((S[k][a] || 0) !== v) { S[k][a] = v; chg.add(`${k}.${a}`) }
    if (op.mem) for (const [id, t] of Object.entries(op.mem)) { S.mem[id] = t; chg.add('mem.' + id) }
    if (op.dev) for (const [d, o] of Object.entries(op.dev)) for (const [a, v] of Object.entries(o)) if (S.dev[d][a] !== v) { S.dev[d][a] = v; chg.add(`dev.${d}.${a}`) }
    if (op.stk) { S.stk = op.stk; chg.add('stk') }
    if (op.walk) { S.walk = op.walk; chg.add('walk') }
    if (op.vs && op.vs !== S.vs) { S.vs = op.vs; chg.add('vs') }
    if (op.vga?.log) { S.vgaA = 0xb8000 + Math.min(24, S.vga.lines.length - (S.vga.lines.at(-1) === '' ? 1 : 0)) * 160; if (S.vga.lines.at(-1) === '') S.vga.lines.splice(-1, 0, ...op.vga.log); else S.vga.lines.push(...op.vga.log, ''); while (S.vga.lines.length > 25) S.vga.lines.shift(); chg.add('vga'); xs.push(['cpu', 'vga', `printk → 显存（${op.vga.log.length} 行）`]) }
    if (op.vga?.out) { const lab = vgaWrite(S, op.vga.out); chg.add('vga'); if (!(op.x || []).some((x) => x[1] === 'vga')) xs.push(['cpu', 'vga', lab]) }
  }
  function prepare(st) {
    const init = K.init[st.id], ops = K.ops[st.id] || []
    const S = clone(init)
    S.walk = null
    const snaps = []
    st.steps.forEach((s, i) => {
      const list = ops[i] || []
      s.calls.forEach((c, j) => {
        const chg = new Set(), xs = []
        let say = '', va = [], rip = false
        S.vgaA = null
        for (const op of list.filter((o) => (o.at ?? 0) === j)) {
          apply(S, op, chg, xs)
          if (op.x) xs.unshift(...op.x)
          if (op.va) va = va.concat(op.va)
          if (op.say) say = op.say
          if (op.r?.RIP) rip = true
        }
        if (!rip && c.src && !['user', 'disk', 'kbd', 'screen'].includes(c.n) && S.cpu.cpl === 0) {
          const v = [c.f, '内核代码']
          if (S.r.RIP?.[0] !== v[0]) { S.r.RIP = v; chg.add('r.RIP') }
        }
        const acc = accesses(S, xs, chg, st.id)
        snaps.push({ S: clone(S), chg, xs, va, say, acc, step: i, ends: xs.map((x, k) => [endOf(acc, x[0], k, 'r'), endOf(acc, x[1], k, 'w')]) })
      })
    })
    return { st, init: clone({ ...init, walk: null }), snaps }
  }

  /* Memory accesses of one hop: a transfer leaving a region reads it, one arriving writes it (k = transfer
     index); state-only changes write when the hop lands (k = number of transfers). Each access is pinned to
     one cell: the real address when one is known (CR3, VGA cursor, a physical address in the label), else a
     stable pseudo-random cell of the region keyed by task and label. */
  const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7)
  const hexIn = (s) => { const m = /0x([0-9a-fA-F_]{5,})/.exec(s || ''); return m ? parseInt(m[1].replace(/_/g, ''), 16) : null }
  function pick(id, a, seed) {
    if (a != null && regionAt(a) === id) return { cell: cellAt(a), a, exact: true }
    const cs = REGION_CELLS[id]
    const cell = cs[hash(seed) % cs.length]
    return { cell, a: cell.a, exact: false }
  }
  function accesses(S, xs, chg, sid) {
    const acc = []
    const cr3 = hexIn(S.c.CR3?.[0])
    const hint = (id, label) => (id === 'p.vga' ? S.vgaA : id === 'p.pgt' && chg.has('c.CR3') ? cr3 : hexIn(label))
    const add = (id, rw, k, label) => acc.push({ id, rw, k, label, ...pick(id, hint(id, label), `${sid}|${S.cpu.task}|${id}|${label}`) })
    if (chg.has('walk') && cr3 != null) acc.push({ id: 'p.pgt', rw: 'r', k: 0, label: `页表遍历：从 CR3 读 PML4 表项（${S.walk.va}）`, ...pick('p.pgt', cr3, '') })
    xs.forEach((x, k) => {
      if (PNAME[x[0]]) add(x[0], 'r', k, x[2])
      if (PNAME[x[1]]) add(x[1], 'w', k, x[2])
      if (x[1] === 'vga' && S.vgaA != null) add('p.vga', 'w', k, x[2])
    })
    for (const c of chg) {
      const id = c.startsWith('mem.') ? c.slice(4) : c === 'vga' ? 'p.vga' : null
      if (id && !acc.some((a) => a.id === id && a.rw === 'w')) add(id, 'w', xs.length, S.mem[id] || '')
    }
    return acc
  }
  const endOf = (acc, id, k, rw) => (PNAME[id] && id !== 'rom' ? acc.find((a) => a.k === k && a.id === id && a.rw === rw)?.cell || null : null)

  /* ---------- static SVG ---------- */
  const VB = { w: 1600, h: 620, bus: 600, cpuRail: 560, physRail: 588, devRail: 1198 }
  /* physical map: one row = 64 MiB = 32 cells of 2 MiB, high addresses on top; plus a 0–2 MiB zoom strip of 64 KiB cells */
  const PH = { x: 600, cx: 666, cw: 7, ch: 9.6, rh: 11.6, y0: 52 }
  PH.r = PH.cx + 32 * PH.cw
  const ROWS = [{ a: 0xfc000000 }, { hole: true }, ...Array.from({ length: 32 }, (_, i) => ({ a: (31 - i) * 64 * MiB }))]
  ROWS.forEach((r, i) => { r.y = PH.y0 + i * PH.rh })
  const ZY = PH.y0 + ROWS.length * PH.rh + 20
  const CELLS = []
  for (const r of ROWS) if (!r.hole) for (let k = 0; k < 32; k++) { const a = r.a + k * 2 * MiB; CELLS.push({ id: regionAt(a), a, sz: 2 * MiB, x: PH.cx + k * PH.cw, y: r.y, h: PH.ch }) }
  for (let k = 0; k < 32; k++) { const a = k * 0x10000; CELLS.push({ id: regionAt(a), a, sz: 0x10000, x: PH.cx + k * PH.cw, y: ZY, h: 13, zoom: true }) }
  const cellAt = (a) => CELLS.find((c) => !!c.zoom === a < 2 * MiB && a >= c.a && a < c.a + c.sz)
  const ANCHOR = {}, REGION_CELLS = {}
  for (const [id] of PHYS) {
    const zoomOnly = id === 'p.low' || id === 'p.vga' || id === 'p.ivt' || id === 'p.ebda' || id === 'p.bios'
    const cs = REGION_CELLS[id] = CELLS.filter((c) => c.id === id && (!zoomOnly || c.zoom))
    if (cs.length) ANCHOR[id] = { x: cs.reduce((s, c) => s + c.x, 0) / cs.length + PH.cw / 2, y: cs.reduce((s, c) => s + c.y + c.h / 2, 0) / cs.length }
  }
  const VS = { x: 935, w: 245, y0: 52, h: 44, gap: 4, hole: 24 }
  const DEV = {
    apic: { y: 8, h: 118, port: 46 }, ioapic: { port: 104 }, kbd: { y: 132, h: 92, port: 178 }, virtio: { y: 230, h: 104, port: 270 }, disk: { y: 338, h: 52, port: 364 }, vga: { y: 396, h: 184, port: 488 },
  }
  /* 寄存器/标志位在左侧面板中的锚点：src 形如 r.RAX、fl.IF、c.CR3 */
  function srcPort(src) {
    const [grp, name] = String(src || '').split('.')
    const reg = REGS.findIndex((r) => r[0] === name)
    if (grp === 'r' && reg >= 0) return { x: 20 + (reg % 2) * 260 + 254, y: 84 + Math.floor(reg / 2) * 37 + 17, rail: VB.cpuRail }
    if (grp === 'fl' || grp === 'cr0' || grp === 'cr4' || grp === 'efer') {
      const s = ['fl', 'cr0', 'cr4', 'efer'].indexOf(grp), bits = BITS[grp][1]
      const i = bits.findIndex((b) => b[0] === name)
      if (i >= 0) return { x: 86 + i * 37.5 + 17, y: 350 + s * 33 + 14, rail: VB.cpuRail }
    }
    if (grp === 'c') {
      const c = CTRL.find((x) => x[0] === name)
      if (c) return { x: c[2] + c[4] - 10, y: c[3] + 20, rail: VB.cpuRail }
    }
    return null
  }
  function port(id, cell, src) {
    if (id === 'cpu') return srcPort(src) || { x: 548, y: 300, rail: VB.cpuRail }
    if (cell) return { x: cell.x + PH.cw / 2 - 0.5, y: cell.y + cell.h / 2, rail: VB.physRail }
    if (id.startsWith('p.')) return { x: ANCHOR[id].x, y: ANCHOR[id].y, rail: VB.physRail }
    return { x: 1210, y: DEV[id].port, rail: VB.devRail }
  }
  function xpath(a, b, ca, cb, src) {
    const A = port(a, ca, src), B = port(b, cb, src)
    if (a === b) return `M${A.x} ${A.y} h-14 v14 h14`
    if (A.rail === B.rail) return `M${A.x} ${A.y} H${A.rail} V${B.y} H${B.x}`
    return `M${A.x} ${A.y} H${A.rail} V${VB.bus} H${B.rail} V${B.y} H${B.x}`
  }

  function build(root) {
    const o = [`<svg viewBox="0 0 ${VB.w} ${VB.h}" preserveAspectRatio="xMidYMid meet" class="msvg">`,
      '<defs><filter id="mglow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>']
    /* bus and rails */
    o.push(`<path class="bus" d="M${VB.cpuRail} 300 V${VB.bus} H${VB.devRail} V20"/><path class="bus" d="M${VB.physRail} 26 V${VB.bus}"/>`,
      `<text class="buslab" x="${(VB.physRail + VB.devRail) / 2}" y="${VB.bus + 15}">系统总线 · 内存控制器 · PCIe（示意：读写内存、访问设备、设备自己搬数据，都要从这里过）</text>`)
    /* CPU */
    o.push(`<rect class="unit" x="8" y="8" width="540" height="572" rx="12"/><text class="utitle" x="22" y="28">CPU 0 · x86-64（64 位 x86 架构）</text><text class="usub" x="535" y="28" text-anchor="end" id="m-task"></text>`)
    o.push(`<g id="m-badges"></g>`)
    REGS.forEach(([n, hint], k) => {
      const col = k % 2, row = Math.floor(k / 2), x = 20 + col * 260, y = 84 + row * 37
      o.push(`<g class="reg tipk" data-k="r.${n}"><rect x="${x}" y="${y}" width="254" height="34" rx="6"/><text class="rn" x="${x + 8}" y="${y + 14}">${n}</text><text class="rv" x="${x + 58}" y="${y + 14}"></text><text class="rh" x="${x + 8}" y="${y + 28}"></text></g>`)
    })
    Object.entries(BITS).forEach(([k, [label, bits]], s) => {
      const y = 350 + s * 33
      o.push(`<text class="bl tipk" x="20" y="${y + 17}" data-k="g.${k}">${label}</text>`)
      bits.forEach(([b, no, hint], i) => {
        const x = 86 + i * 37.5
        o.push(`<g class="bit tipk" data-k="${k}.${b}" data-bit="${no}"><rect x="${x}" y="${y}" width="34.5" height="28" rx="4"/><text class="bn" x="${x + 17.25}" y="${y + 12}">${BSHORT[b] || b}</text><text class="bb" x="${x + 17.25}" y="${y + 23}">${no}</text></g>`)
      })
    })
    for (const [n, hint, x, y, w] of CTRL) o.push(`<g class="reg ctl tipk" data-k="c.${n}" data-hint="${esc(hint)}"><rect x="${x}" y="${y}" width="${w}" height="40" rx="6"/><text class="rn" x="${x + 8}" y="${y + 15}">${n.replace('_', '_')}</text><text class="rv" x="${x + 8}" y="${y + 32}"></text></g>`)
    /* physical memory */
    o.push(`<text class="ctitle" x="${PH.x}" y="18">物理内存（内存条上的真实位置）</text><text class="csub" x="${PH.x}" y="36">共 2 GiB · 每行 64 MiB · 每格 2 MiB</text><text class="csub" x="${PH.r}" y="36" text-anchor="end">上面是高地址</text>`)
    for (const r of ROWS) {
      if (r.hole) { o.push(`<rect class="phole" x="${PH.cx}" y="${r.y}" width="${32 * PH.cw - 1}" height="${PH.ch}"/><text class="pholet" x="${(PH.cx + PH.r) / 2}" y="${r.y + PH.ch - 2}">0x8000_0000 – 0xFBFF_FFFF：PCIe 地址保留区</text>`); continue }
      o.push(`<text class="prow" x="${PH.cx - 4}" y="${r.y + 8.2}">${hx(r.a)}</text>`)
    }
    o.push(`<text class="pzt" x="${PH.x}" y="${ZY - 5}">开头的 2 MiB 放大来看 · 每格 64 KiB</text>`,
      ...[[0, '0'], [10, 'A_0000'], [16, '10_0000'], [32, '20_0000']].map(([k, t]) => `<text class="ptick" x="${PH.cx + k * PH.cw}" y="${ZY + 24}" text-anchor="${k === 32 ? 'end' : k ? 'middle' : 'start'}">${t}</text>`),
      `<path class="pzlink" d="M${PH.cx} ${ROWS.at(-1).y + PH.ch} L${PH.cx} ${ZY} M${PH.cx + PH.cw} ${ROWS.at(-1).y + PH.ch} L${PH.r} ${ZY}"/>`)
    const ranges = (id) => PMAP.filter((r) => r[0] === id).map((r) => `${hx(r[1])}–${hx(r[2] - 1)}`).join('，')
    for (const [id, name, , col] of PHYS) {
      const d = CELLS.filter((c) => c.id === id).map((c) => `M${c.x} ${c.y}h${PH.cw - 1}v${c.h}h${1 - PH.cw}z`).join('')
      o.push(`<path class="pcell${id === 'p.free' ? ' free' : ''}${id === 'rom' ? ' rom' : ''}" data-p="${id}" data-r="${esc(ranges(id))}" d="${d}" fill="${col}"><title></title></path>`)
    }
    o.push(`<text class="plab" x="${PH.cx + 18 * PH.cw}" y="${ROWS.at(-1).y + 8.2}">vmlinux（内核本体）</text><text class="plab" x="${(PH.cx + PH.r) / 2}" y="${ROWS[18].y + 8.2}">空闲内存（还没被用）</text>`,
      `<rect class="b8k" x="${PH.cx + 11 * PH.cw - 0.5}" y="${ZY - 0.5}" width="${PH.cw}" height="14"><title>0xB8000：屏幕文字在内存里的存放位置（80 列 × 25 行 × 2 字节）</title></rect>`)
    PHYS.forEach(([id, , leg, col], i) => {
      const x = PH.x + (i % 4) * 73, y = ZY + 38 + Math.floor(i / 4) * 13
      o.push(`<g class="pleg" data-l="${id}"><rect x="${x}" y="${y - 7.5}" width="8" height="8" rx="1.5" fill="${col}"/><text x="${x + 11}" y="${y}">${leg}</text></g>`)
    })
    {
      const x = PH.x, y = ZY + 38 + Math.ceil(PHYS.length / 4) * 13
      o.push(`<g class="pleg rw"><circle class="core w" cx="${x + 4}" cy="${y - 3.5}" r="3.4"/><text x="${x + 11}" y="${y}">写</text><circle class="core r" cx="${x + 34}" cy="${y - 3.5}" r="3.4"/><text x="${x + 41}" y="${y}">读</text><text x="${x + 62}" y="${y}">（实心=写内存，空心=读内存）</text></g>`)
    }
    o.push(`<g id="m-pcall"></g><g id="m-dots"></g>`)
    /* virtual space */
    o.push(`<text class="ctitle" x="${VS.x}" y="18" id="m-vsname"></text><text class="csub" x="${VS.x}" y="36" id="m-vsnote"></text><g id="m-vs"></g><g id="m-maps"></g>`)
    /* devices */
    const box = (y, h, title) => `<rect class="unit dev" x="1210" y="${y}" width="382" height="${h}" rx="10"/><text class="dtitle" x="1222" y="${y + 18}">${title}</text>`
    o.push(box(DEV.apic.y, DEV.apic.h, '中断控制器：本地 APIC · IO-APIC（外部设备的中断汇总到这里）'))
    o.push(dl('apic', 'irr', '等待处理', 1222, 40), dl('apic', 'isr', '正在处理', 1410, 40), dl('apic', 'timer', '定时器', 1222, 60), dl('apic', 'icr', 'ICR 通知别的 CPU', 1222, 80), dl('ioapic', 'pin1', 'IO-APIC 脚 1', 1222, 104))
    o.push(box(DEV.kbd.y, DEV.kbd.h, '键盘：i8042 控制器 + PS/2 键盘（两个端口 0x60 / 0x64）'))
    o.push(dl('kbd', 'st', '状态 0x64', 1222, DEV.kbd.y + 40), dl('kbd', 'data', '数据 0x60', 1410, DEV.kbd.y + 40), dl('kbd', 'ctr', '命令字节', 1222, DEV.kbd.y + 60), dl('kbd', 'key', '最近按键', 1222, DEV.kbd.y + 80))
    o.push(box(DEV.virtio.y, DEV.virtio.h, '虚拟磁盘控制器 virtio-blk（用 virtqueue 队列交换任务）'))
    o.push(dl('vq', 'st', '设备状态', 1222, DEV.virtio.y + 40), dl('vq', 'desc', '任务清单', 1222, DEV.virtio.y + 60, 300), dl('vq', 'avail', '已交办序号', 1222, DEV.virtio.y + 80), dl('vq', 'used', '已完成序号', 1350, DEV.virtio.y + 80), dl('vq', 'notify', '门铃', 1460, DEV.virtio.y + 80))
    o.push(box(DEV.disk.y, DEV.disk.h, '磁盘：宿主机上的一个镜像文件 vda.img'))
    o.push(dl('disk', 't', '', 1222, DEV.disk.y + 38), dl('disk', 'op', '操作', 1410, DEV.disk.y + 38))
    o.push(box(DEV.vga.y, DEV.vga.h, '显卡文本模式（终端 tty1 · 只显示最后 8 行）'), `<rect class="screen" x="1220" y="${DEV.vga.y + 26}" width="362" height="150" rx="4"/><g id="m-screen"></g>`)
    o.push('<g id="m-xpaths"></g><g id="m-pk" filter="url(#mglow)"><circle r="11" class="pk0"/><circle r="5.5" class="pk1"/></g><g id="m-pklab"><rect rx="5" height="20"/><text y="14"></text></g></svg>')
    root.innerHTML = o.join('')
    const q = (s) => root.querySelector(s)
    const el = {
      root, task: q('#m-task'), badges: q('#m-badges'), regs: new Map([...root.querySelectorAll('[data-k]')].filter((e) => !e.dataset.k.startsWith('g.')).map((e) => [e.dataset.k, e])),
      phys: new Map([...root.querySelectorAll('[data-p]')].map((e) => [e.dataset.p, e])), legs: [...root.querySelectorAll('[data-l]')], pcall: q('#m-pcall'), dots: q('#m-dots'), vs: q('#m-vs'), vsname: q('#m-vsname'), vsnote: q('#m-vsnote'), maps: q('#m-maps'),
      screen: q('#m-screen'), xpaths: q('#m-xpaths'), pk: q('#m-pk'), pklab: q('#m-pklab'),
    }
    const tip = document.createElement('div')
    tip.className = 'mtip'
    root.appendChild(tip)
    let tipK = null
    root.addEventListener('pointermove', (e) => {
      const g = e.target.closest?.('.tipk')
      if (!g) { tip.style.display = 'none'; tipK = null; return }
      const sig = g.dataset.k + '|' + el._key
      if (tipK !== sig) { tipK = sig; tip.innerHTML = tipHtml(g, el.curS) }
      tip.style.display = 'block'
      const R = root.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight
      let x = e.clientX - R.left + 16, y = e.clientY - R.top + 16
      if (x + w > R.width - 6) x = e.clientX - R.left - w - 12
      if (y + h > R.height - 6) y = Math.max(4, e.clientY - R.top - h - 12)
      tip.style.left = x + 'px'; tip.style.top = y + 'px'
    })
    root.addEventListener('pointerleave', () => { tip.style.display = 'none'; tipK = null })
    return el
  }
  /* 整块寄存器的当前值：把为 1 的位按位号加起来，拼成一个十六进制数 */
  function regHex(grp, S) {
    if (grp === 'fl') return rflagsHex(S.fl)
    let v = 0n
    for (const [b, no] of BITS[grp][1]) if (S[grp][b]) v |= 1n << BigInt(no)
    return '0x' + v.toString(16).toUpperCase()
  }
  const regOnes = (grp, S) => BITS[grp][1].filter(([b]) => S[grp][b]).map(([b, no]) => `${b}（第 ${no} 位）`).join('、') || '各位均为 0'
  /* 设备区域里那些缩写的中文说明 */
  const DEVCN = { apic: '中断控制器：本地 APIC + IO-APIC', ioapic: 'IO-APIC：汇总外部设备的中断线', kbd: '键盘控制器 i8042（PS/2 键盘）', virtio: '虚拟磁盘控制器 virtio-blk', vq: '虚拟队列 virtqueue：驱动与磁盘之间传递任务的地方', disk: '虚拟磁盘 vda：宿主机上的一个镜像文件' }

  function tipHtml(g, S) {
    const k = g.dataset.k, key = k.split('.'), grp = key[0], name = key[1], sub = key[2]
    let t = TIP_PLAIN[k] || TIP[k]
    let head = name, where = '', val = ''
    if (grp === 'g') {
      const r = TIP_REG[name] || [name, name, '']
      const ones = S ? regOnes(name, S) : ''
      return `<div class="th"><b>${esc(r[1])}</b><span>${esc(r[0])}</span></div>` +
        (S ? `<div class="tv">当前值 = ${esc(regHex(name, S))}；其中为 1 的位：${esc(ones)}</div>` : '') +
        `<p>${esc(r[2])}</p>`
    }
    if (grp === 'dev') {
      t = t || [sub, '', '']
      head = sub
      where = `${DEVCN[name] || name} · 字段名 ${sub}`
      const v = S?.dev?.[name]?.[sub]
      val = v != null && v !== '' ? `当前 = ${v}` : ''
    } else if (TIP_GROUP[grp]) {
      t = t || [name, '', '']
      where = `${TIP_GROUP[grp]} 第 ${g.dataset.bit} 位（二进制位从最右边数起，最右一位算第 0 位）`
      val = S ? `当前 = ${S[grp][name] ? 1 : 0}` : ''
    } else {
      t = t || [name, '', '']
      const reg = REGS.find((r) => r[0] === name)
      where = grp === 'c' ? g.dataset.hint : reg?.[1] || ''
      const v = name === 'RFLAGS' ? (S ? [rflagsHex(S.fl), ''] : null) : S?.[grp][name]
      val = v ? `当前 = ${v[0]}${v[1] ? `（${v[1]}）` : ''}` : ''
    }
    return `<div class="th"><b>${esc(head)}</b><span>${esc(t[0])}</span></div><div class="tz">${esc(t[1])}<i>${esc(where)}</i></div>${val ? `<div class="tv">${esc(val)}</div>` : ''}<p>${esc(t[2])}</p>`
  }
  function dl(dev, key, label, x, y, w = 170) {
    return `<g class="dv" data-k="dev.${dev}.${key}" data-w="${w}">${label ? `<text class="dk" x="${x}" y="${y}">${esc(label)}</text>` : ''}<text class="dvv" x="${x + (label ? wid(label, 11, 6.2) + 8 : 0)}" y="${y}"></text></g>`
  }

  /* ---------- dynamic render ---------- */
  function badges(S, chg) {
    const b = [
      ['cpu.mode', '模式', MODE[S.cpu.mode] || S.cpu.mode, 112], ['cpu.cpl', '运行级别', S.cpu.cpl === 3 ? '3 用户程序' : '0 内核', 118],
      ['fl.IF', '中断开关', S.fl.IF ? '1 允许打断' : '0 屏蔽外部 IRQ', 122], ['cpu.hlt', '状态', S.cpu.hlt ? 'HLT 停着等' : '执行中', 110],
      ['sw.preempt', '禁止抢占计数', S.sw.preempt, 118], ['sw.resched', '该重新调度', S.sw.resched ? '1 是' : '0 否', 112], ['sw.softirq', '待办软中断', S.sw.softirq, 260],
    ]
    let x = 20, y = 38, out = ''
    b.forEach(([k, n, v, w], i) => {
      if (i === 4) { x = 20; y = 60 }
      const on = (k === 'cpu.cpl' && S.cpu.cpl === 3) || (k === 'fl.IF' && S.fl.IF) || (k === 'cpu.hlt' && S.cpu.hlt) || (k === 'sw.resched' && S.sw.resched) || (k === 'sw.preempt' && /IRQ/.test(v))
      out += `<g class="bdg${on ? ' on' : ''}${chg.has(k) ? ' chg' : ''}"><rect x="${x}" y="${y}" width="${w}" height="19" rx="9.5"/><text x="${x + 9}" y="${y + 13.5}"><tspan class="bk">${esc(n)}</tspan> ${esc(cut(v, w - wid(n, 10, 5.6) - 22, 10.5, 6))}</text></g>`
      x += w + 6
    })
    return out
  }
  const rflagsHex = (fl) => '0x' + (2 + Object.entries(fl).reduce((a, [b, v]) => a + (v ? 1 << BITS.fl[1].find((x) => x[0] === b)[1] : 0), 0)).toString(16)

  function spaceRegions(vs) {
    const sp = SPACES[vs] || SPACES.none
    let y = VS.y0
    const out = []
    for (const r of sp.regions) {
      if (!r) { out.push({ hole: true, y }); y += VS.hole; continue }
      out.push({ id: r[0], addr: r[1], name: r[2], to: r[3], y }); y += VS.h + VS.gap
    }
    return { sp, regs: out }
  }

  function render(el, M, g, landed, xp, T) {
    const sn = g >= 0 ? M.snaps[g] : null
    const S = landed ? (sn ? sn.S : M.init) : (g > 0 ? M.snaps[g - 1].S : M.init)
    const chg = landed && sn ? sn.chg : new Set()
    const key = `${g}|${landed}`
    if (el._key !== key) {
      el._key = key
      el.curS = S
    el.task.textContent = `当前任务：${cut(S.cpu.task, 190, 11, 6.6)}`
      el.badges.innerHTML = badges(S, chg)
      for (const [k, e] of el.regs) {
        const [grp, name, sub] = k.split('.')
        if (grp === 'r' || grp === 'c') {
          const v = name === 'RFLAGS' ? [rflagsHex(S.fl), ''] : S[grp][name] || ['—', '']
          const ctl = grp === 'c'
          e.querySelector('.rv').textContent = cut(v[0], ctl ? (name === 'CR3' ? 320 : 156) : 190, 12, 7.2)
          const h = e.querySelector('.rh'); if (h) h.textContent = cut(v[1], 238, 10.5, 6)
          e.classList.toggle('chg', chg.has(k) || (name === 'RFLAGS' && [...chg].some((x) => x.startsWith('fl.'))))
        } else if (grp === 'dev') {
          const v = S.dev[name]?.[sub] ?? '—', w = +e.dataset.w
          e.querySelector('.dvv').textContent = cut(v, w, 11, 6.4)
          e.classList.toggle('chg', chg.has(k))
        } else {
          e.classList.toggle('on', !!S[grp]?.[name])
          e.classList.toggle('chg', chg.has(k))
        }
      }
      const hot = new Set()
      if (sn && landed) { for (const c of chg) if (c.startsWith('mem.')) hot.add(c.slice(4)); for (const v of sn.va) hot.add(v[1]) }
      if (sn) for (const x of sn.xs) for (const p of [x[0], x[1]]) if (PNAME[p]) hot.add(p)
      for (const [id, e] of el.phys) {
        e.classList.toggle('hot', hot.has(id)); e.classList.toggle('chg', chg.has('mem.' + id)); e.classList.toggle('dim', hot.size > 0 && !hot.has(id))
        e.querySelector('title').textContent = `${PNAME[id]}\n${e.dataset.r}${S.mem[id] ? '\n' + S.mem[id] : ''}`
      }
      for (const e of el.legs) e.classList.toggle('hot', hot.has(e.dataset.l))
      const seen = new Set(), list = (sn ? sn.acc : []).filter((a) => { const k = a.id + a.rw; return !seen.has(k) && seen.add(k) }).slice(0, 3)
      const NS = sn ? sn.S : S
      el.pcall.innerHTML = list.length
        ? list.map((a, i) => {
          const head = `${a.rw === 'w' ? '写' : '读'} ${PNAME[a.id].split(/[（(]/)[0]} ${a.exact ? '@' : '≈'}${hx(a.a)}`
          return `<text class="pcl" x="${PH.x}" y="${ZY + 106 + i * 13}"><tspan class="pcn ${a.rw}">${a.rw === 'w' ? '●' : '○'} ${esc(head)}</tspan> ${esc(cut((a.rw === 'w' && sn.chg.has('mem.' + a.id) ? NS.mem[a.id] : a.label) || NS.mem[a.id] || '', 296 - wid(head, 11, 6.4) - 18, 11, 6.2))}</text>`
        }).join('')
        : `<text class="pcl muted" x="${PH.x}" y="${ZY + 106}">这一跳仅展示寄存器或控制状态变化</text>`
      /* virtual space and mappings */
      const { sp, regs } = spaceRegions(S.vs)
      el.vsname.textContent = `虚拟地址空间 · ${sp.name}`
      el.vsnote.textContent = sp.note || ''
      const vaHot = new Map((sn && landed ? sn.va : []).map((v) => [v[0], v[1]]))
      el.vs.innerHTML = regs.map((r) => r.hole ? `<text class="hole" x="${VS.x + VS.w / 2}" y="${r.y + 16}">· · · 空洞：此段为地址空洞，访问会触发地址异常 · · ·</text>`
        : `<g class="vreg${vaHot.has(r.id) ? ' hot' : ''}"><rect x="${VS.x}" y="${r.y}" width="${VS.w}" height="${VS.h}" rx="5"/><text class="pn" x="${VS.x + 8}" y="${r.y + 16}">${esc(cut(r.name, 236, 11.5, 6.6))}</text><text class="pa" x="${VS.x + 8}" y="${r.y + 34}">${esc(r.addr)}</text></g>`).join('') +
        (regs.length ? '' : `<text class="hole" x="${VS.x + VS.w / 2}" y="80">（还没开分页：CPU 直接按物理地址访问）</text>`)
      el.maps.innerHTML = regs.filter((r) => !r.hole).map((r) => {
        const to = vaHot.get(r.id) || r.to, y1 = r.y + VS.h / 2, y2 = ANCHOR[to].y
        return `<path class="vmap${vaHot.has(r.id) ? ' hot' : ''}" d="M${VS.x} ${y1} C${VS.x - 26} ${y1} ${PH.r + 26} ${y2} ${PH.r + 1} ${y2}"/>`
      }).join('')
      /* screen */
      const L = S.vga.lines.slice(-8)
      el.screen.innerHTML = L.map((l, i) => `<text class="scr" x="1228" y="${DEV.vga.y + 44 + i * 18}">${esc(l.slice(0, 54))}</text>`).join('') +
        `<rect class="cursor" x="${1228 + Math.min(54, L.at(-1).length) * 6.6}" y="${DEV.vga.y + 33 + (L.length - 1) * 18}" width="6.6" height="14"/>`
      el.screenChg = chg.has('vga')
      el.root.querySelector('.screen').classList.toggle('chg', chg.has('vga'))
      /* transfer paths for this hop */
      el.xs = sn ? sn.xs : []
      el.xpaths.innerHTML = el.xs.map((x, i) => `<path class="xp" data-i="${i}" d="${xpath(x[0], x[1], sn.ends[i][0], sn.ends[i][1], x[3] || 'r.RIP')}"/>`).join('')
      el.xpEls = [...el.xpaths.querySelectorAll('path')]
      el.xlen = el.xpEls.map((p) => p.getTotalLength())
    }
    const cur = el.root.querySelector('.cursor'); if (cur) cur.style.opacity = Math.floor(T / 500) % 2 ? 0.15 : 1
    /* packet */
    const n = el.xs.length
    if (n && !landed && g >= 0) {
      const k = Math.min(n - 1, Math.floor(xp * n)), p = ease(clamp(xp * n - k, 0, 1))
      el.xpEls.forEach((e, i) => e.setAttribute('class', `xp ${i < k ? 'done' : i === k ? 'cur' : ''}`))
      const pt = el.xpEls[k].getPointAtLength(el.xlen[k] * p)
      el.pk.setAttribute('transform', `translate(${pt.x},${pt.y})`); el.pk.style.opacity = 1
      const lab = el.xs[k][2], w = wid(lab, 12, 6.8) + 14
      const lx = clamp(pt.x - w / 2, 4, VB.w - w - 4), ly = pt.y > 40 ? pt.y - 30 : pt.y + 12
      el.pklab.setAttribute('transform', `translate(${lx},${ly})`); el.pklab.style.opacity = 1
      el.pklab.querySelector('rect').setAttribute('width', w); el.pklab.querySelector('text').setAttribute('x', 7); el.pklab.querySelector('text').textContent = lab
    } else {
      el.xpEls?.forEach((e) => e.setAttribute('class', 'xp done'))
      el.pk.style.opacity = 0; el.pklab.style.opacity = 0
    }
    dots(el, M, g, landed, xp, T)
  }

  /* read/write marks: this hop's accesses appear as their packet leaves (read) or arrives (write) and pulse;
     earlier hops of the same step stay as a faint trail */
  function dots(el, M, g, landed, xp, T) {
    if (g < 0) { el.dots.innerHTML = ''; return }
    const sn = M.snaps[g], n = sn.xs.length, k = landed ? n + 1 : xp * n
    const trail = []
    for (let h = g - 1, c = 0; h >= 0 && M.snaps[h].step === sn.step && c < 6; h--, c++) trail.push(...M.snaps[h].acc)
    const now = sn.acc.filter((a) => (a.rw === 'r' ? k >= a.k : k >= a.k + 1 || (landed && a.k >= n)))
    const ph = (T % 1000) / 1000
    const dot = (a, cls) => {
      const x = a.cell.x + PH.cw / 2 - 0.5, y = a.cell.y + a.cell.h / 2
      return `<g class="dot ${a.rw} ${cls}" transform="translate(${x},${y})"><title>${a.rw === 'w' ? '写' : '读'} ${esc(PNAME[a.id])} ${a.exact ? '' : '≈'}${hx(a.a)}：${esc(a.label)}</title>` +
        (cls === 'now' ? `<circle class="ring" r="${4 + ph * 7}" opacity="${(1 - ph) * 0.9}"/>` : '') + '<circle class="core" r="3.4"/></g>'
    }
    el.dots.innerHTML = trail.map((a) => dot(a, 'old')).join('') + now.map((a) => dot(a, 'now')).join('')
  }

  /* ---------- side card: stack frame + page walk ---------- */
  const LV = [['PML4', '47–39'], ['PDPT', '38–30'], ['PD', '29–21'], ['PT', '20–12']]
  function walkHtml(w) {
    if (!w) return '<p class="muted">本流程的缺页处理将在后续访问触发时展示。</p>'
    const v = BigInt(w.va.replace(/_/g, ''))
    const idx = [39n, 30n, 21n, 12n].map((s) => Number((v >> s) & 511n)), off = Number(v & 4095n)
    return `<div class="wva"><code>${esc(w.va)}</code> = ${idx.map((x, i) => `${LV[i][0]}[${x}]`).join(' → ')} + 偏移 0x${off.toString(16)}</div>
      <table class="walk">${LV.map(([n, bits], i) => `<tr class="${/#PF|R\/W=0/.test(w.res[i] || '') ? 'bad' : w.res[i] ? 'ok' : ''}"><td>${n}</td><td class="muted">位 ${bits} = ${idx[i]}</td><td>${esc(w.res[i] || '—')}</td></tr>`).join('')}</table>`
  }
  function sideCard(M, g, landed) {
    const S = landed ? (g >= 0 ? M.snaps[g].S : M.init) : (g > 0 ? M.snaps[g - 1].S : M.init)
    const chg = landed && g >= 0 ? M.snaps[g].chg : new Set()
    const stk = S.stk || { name: '—', items: [] }
    return `<h4 class="${chg.has('stk') ? 'chg' : ''}">栈 <small>${esc(stk.name)}（高地址在上）</small></h4>
      ${stk.items.length ? `<ol class="stk">${stk.items.map((x) => `<li>${md(x)}</li>`).join('')}</ol>` : '<p class="muted">当前栈帧展示列表为空。</p>'}
      <h4 class="${chg.has('walk') ? 'chg' : ''}">页表遍历 <small>最近一次：CR3 → 四级页表 → 物理页</small></h4>${walkHtml(S.walk)}`
  }

  const PORT_NAME = { cpu: 'CPU', apic: 'LAPIC', ioapic: 'IO-APIC', kbd: 'i8042', virtio: 'virtio-blk', disk: '磁盘', vga: 'VGA 显存', ...Object.fromEntries(PHYS.map((p) => [p[0], p[2]])) }
  const portName = (id) => PORT_NAME[id] || id
  return { prepare, build, render, sideCard, portName, caveat: K.caveat }
})()
