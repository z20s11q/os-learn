/* Machine-level track for the animation: what CPU0, memory and devices do at each call of each story.
   ops[story][step] is a list of { at: callIndex, ... } applied cumulatively; see anim-machine.js for keys.
   Values are a walk-through model of QEMU x86_64 without KASLR, PTI or 5-level paging; addresses,
   vectors and PIDs not marked otherwise are illustrative. */
(() => {
  const CS0 = ['0x10', '__KERNEL_CS：内核自己的代码段（64 位），RPL=0 表示跑在内核态']
  const SS0 = ['0x18', '__KERNEL_DS：内核自己的数据段']
  const CS3 = ['0x33', '__USER_CS：用户程序的代码段（64 位），RPL=3 表示跑在用户态']
  const SS3 = ['0x2b', '__USER_DS：用户程序的数据段，RPL=3']
  const SSNULL = ['0x0', '64 位模式下只要特权级一变，CPU 就会把 SS 清成 0；这个模式下段寄存器基本不参与地址计算，只是个空壳']
  const GSK = ['本 CPU 的专属数据区', 'swapgs 之后，GS 这个段寄存器的基址被指向本 CPU 自己的一份数据（每颗 CPU 都有独立一份）']
  const GSU = ['0', '用户态下 GS 的基址为 0（本例的用户程序用不到 GS）']
  const T = {
    init: { name: 'init(1)', ksp: ['init(1) 的内核栈', '内核虚拟地址里的 vmalloc 区（内核动态申请虚拟地址的地带），从 0xffffc90000010000 开始，共 16 KiB'], usp: '0x7ffd3a2c1f30', buf: '0x4d1a40' },
    sh: { name: 'sh', ksp: ['sh 的内核栈', 'vmalloc 区，从 0xffffc90000a48000 开始，共 16 KiB'], usp: '0x7ffd5c2a1e90', buf: '0x4d1a40' },
    cat: { name: 'cat(231)', ksp: ['cat(231) 的内核栈', 'vmalloc 区，从 0xffffc90000a60000 开始，共 16 KiB'], usp: '0x7ffc8e1f2e40', buf: '0x4d2c00' },
  }
  const IDLE_SP = ['swapper/0 的栈', 'init_task 自带的那块静态栈（直接嵌在内核镜像的数据段里，随内核镜像静态分配）']

  /* syscall instruction: ring 3 → ring 0 */
  const SYS = (t, nr, name, args = {}, say) => ({
    cpu: { cpl: 0, task: t.name, hlt: false },
    r: { RAX: [String(nr), `系统调用编号：这次要办的是「${name}」`], RDI: ['—', ''], RSI: ['—', ''], RDX: ['—', ''], R10: ['—', ''],
      RCX: ['回用户态后从哪继续', 'syscall 指令会顺手把「下一条用户指令的地址」存进 RCX，将来靠它回去'],
      R11: ['用户态标志位的副本', 'syscall 把当时 RFLAGS 里的标志位存进 R11，返回时再装回去'],
      CS: CS0, SS: SS0, GS: GSK, RSP: t.ksp, ...args },
    fl: { IF: 1, AC: 0 },
    stk: { name: `${t.name} 的内核栈：刚压好的 pt_regs`, items: ['ss = 0x2b（进内核前的用户数据段）', `sp = ${t.usp}（进内核前的用户栈顶）`, 'flags（从 R11 借来的用户标志位）', 'cs = 0x33（进内核前在用户态）', 'ip（从 RCX 借来的返回地址）', `orig_ax = ${nr}（原始的系统调用编号，留作记录）`, 'di si dx r10 r8 r9 …（刚才那几个参数寄存器）', '其余各通用寄存器（rbx、rbp、r12–r15 之类）'] },
    x: [['cpu', 'p.kstk', '压入 pt_regs（把用户寄存器原样存一份）', 'r.RSP']],
    say: say || `要进内核办事了：RAX=${nr}（这次是 ${name}），参数按顺序放在 RDI、RSI、RDX、R10 这 4 个寄存器里。CPU 的特权级从 3（用户态）降到 0（内核态）；入口处先用 swapgs 把 GS 换回内核自己的数据指针，再把栈换成该任务的内核栈、把用户寄存器原样存成一份 pt_regs 结构，最后拿 RAX 里的编号去 sys_call_table 这张表里查出该调用哪个内核函数。`,
  })
  /* sysretq / iretq back to ring 3 */
  const RET = (t, rax, note, rip = ['用户态：系统调用的下一条指令', 'sysretq 返回用户态：把 RCX 的值装回 RIP（从系统调用的下一条继续执行），R11 的值装回 RFLAGS（把标志位恢复原样）']) => ({
    cpu: { cpl: 3, task: t.name, hlt: false },
    r: { RAX: [rax, note], RIP: rip, CS: CS3, SS: SS3, GS: GSU, RSP: [t.usp, '用户栈（切回用户态后用的栈顶）'] },
    fl: { IF: 1, AC: 0 },
    stk: { name: `${t.name} 的用户态`, items: [] },
  })
  /* external interrupt delivered by the LAPIC */
  const IRQ = (vec, rip, sp = '被打断任务的栈') => ({
    cpu: { hlt: false },
    fl: { IF: 0 },
    sw: { preempt: 'HARDIRQ' },
    dev: { apic: { irr: '—', isr: vec } },
    r: { RSP: ['硬中断专用的栈', '每颗 CPU 都另有一块专门处理硬中断的栈（hardirq_stack_ptr）；不过 CPU 一开始会先把中断帧压到「被打断那个任务」的栈上，入口代码随后再搬过去'] },
    stk: { name: '中断帧（CPU 收到中断时自动压进去的一小叠寄存器，将来靠它原样弹回去接着跑）', items: ['SS = 0x18（被打断时的数据段，说明当时在内核里）', `RSP = ${sp}（被打断那一刻的栈顶）`, 'RFLAGS = 0x202（IF=1，说明当时允许被打断）', 'CS = 0x10（被打断时的代码段，内核）', `RIP = ${rip}（被打断的那条指令地址，将来从这里接着跑）`, `~向量号 ${vec}（由入口桩代码补压进去，处理函数靠它找到是哪个设备）`] },
    x: [['apic', 'cpu', `递交中断向量 ${vec}（相当于在门口报出号牌）`, 'fl.IF'], ['cpu', 'p.kstk', '压入中断帧（保存现场）', 'r.RSP']],
  })
  /* #PF from user mode */
  const PF = (t, va, ec, ecnote) => ({
    cpu: { cpl: 0, task: t.name },
    c: { CR2: [va, 'CPU 自动把「哪个地址出错了」记在这个寄存器里'] },
    r: { CS: CS0, SS: SSNULL, GS: GSK, RSP: t.ksp },
    fl: { IF: 0 },
    stk: { name: `${t.name} 的内核栈：异常帧（CPU 压进去的出错现场）`, items: ['SS = 0x2b（出错前的用户数据段）', `RSP = ${t.usp}（出错前的用户栈顶）`, 'RFLAGS = 0x246（出错前的标志位）', 'CS = 0x33（出错前在用户态）', `RIP = ${va.startsWith('0x40') ? va : '出错的那条写指令'}（出错的那条指令地址）`, `error_code = ${ec}（${ecnote}）`] },
    x: [['cpu', 'p.kstk', '压入异常帧 + 错误码', 'r.RSP']],
  })

  const BOOT_LOG = [
    'SeaBIOS (version 1.16.3)',
    'Booting from ROM..',
    'Probing EDD (edd=off to disable)... ok',
  ]
  const KLOG = [
    '[    0.000000] Linux version 6.12.112 #1 SMP PREEMPT_DYNAMIC',
    '[    0.000000] Command line: root=/dev/vda rootfstype=ext4 console=tty1 init=/sbin/init',
    '[    0.041210] Console: colour VGA+ 80x25',
    '[    0.612004] virtio_blk virtio1: [vda] 2097152 512-byte logical blocks (1.07 GB/1.00 GiB)',
    '[    0.705331] input: AT Translated Set 2 keyboard as /devices/platform/i8042/serio0/input/input0',
    '[    0.823719] EXT4-fs (vda): mounted filesystem r/w with ordered data mode.',
    '[    0.824102] VFS: Mounted root (ext4 filesystem) on device 253:0.',
    '[    0.851377] Run /sbin/init as init process',
  ]

  const LONG = {
    cpu: { mode: 'long', cpl: 0, task: 'swapper/0', hlt: true },
    r: {
      RIP: ['pv_native_safe_halt', 'CPU 停在这里等中断（hlt 之后的下一行）'], RSP: IDLE_SP, RAX: ['0', ''], RDI: ['—', ''], RSI: ['—', ''], RDX: ['—', ''], R10: ['—', ''],
      RCX: ['—', ''], R11: ['—', ''], CS: CS0, SS: SS0, FS: ['sh 的线程私有数据', '懒切换：idle 是内核线程，不主动改 FS，就沿用上一个进程留下的值（TLS 指线程自己的一小块私有数据）'], GS: GSK,
    },
    fl: { IF: 1 },
    cr0: { PE: 1, MP: 1, ET: 1, NE: 1, WP: 1, AM: 1, PG: 1 },
    cr4: { PAE: 1, PGE: 1, OSFXSR: 1, OSXMMEXCPT: 1, UMIP: 1, FSGSBASE: 1, PCIDE: 1, OSXSAVE: 1, SMEP: 1, SMAP: 1 },
    efer: { SCE: 1, LME: 1, LMA: 1, NXE: 1 },
    c: {
      CR3: ['0x7fd23000 | PCID 3', '仍是 sh 的页表根（PGD）：idle 是内核线程，自己不带页表，就顺手沿用上一个进程的，省得来回改 CR3'], CR2: ['—', ''], IDTR: ['idt_table', '中断描述符表：一张 256 行的「异常/中断入口地址表」，每行长 16 字节'],
      LSTAR: ['entry_SYSCALL_64', 'syscall 指令一执行就跳到这个函数'], TSC_DEADLINE: ['已编程', '已经写好「下一次闹钟定在哪个时刻」（用 CPU 自带的时间戳计数器 TSC 来计时）'],
    },
    sw: { preempt: '0', resched: 0, softirq: '无' },
    stk: { name: 'swapper/0 的栈', items: [] },
    vs: 'sh',
    mem: {
      'p.low': '低端 1 MiB 的早期启动资源，已经交还给伙伴系统（只留下第一页）', 'p.vga': '文本模式显存：80 列 × 25 行，每格 2 字节（一个字符 + 一个颜色）', 'p.bz': '压缩内核文件已经用完，还给了伙伴系统', 'p.kern': '内核镜像本体：代码段 .text / 只读数据 .rodata / 可读写数据 .data / 未初始化数据 .bss',
      'p.vq': '虚拟磁盘的队列区（驱动和设备共用的一块内存）：描述符表 desc[128]、驱动交办环 avail、设备完成环 used', 'p.pgt': '各级页表：内核总页表 init_top_pgt，以及各进程自己的 PGD/PUD/PMD/PTE（一层套一层往下指的「地址对照表」）', 'p.slab': 'SLUB 小块内存池里的各种内核对象：进程结构 task_struct、目录项 dentry、文件元数据 inode、打开的文件 file、终端 tty…',
      'p.kstk': '每个任务一块 16 KiB 的内核栈（任务在内核里干活时用的栈）', 'p.pc': '页缓存：busybox 的代码页约 200 页，以及磁盘 vda 上的元数据块', 'p.anon': '匿名映射提供的程序内存：init、sh 的栈和它们的 .data/.bss', 'p.free': '伙伴系统手里的空闲页：约 49 万页（伙伴系统是内核按「整页」分配内存的地方）',
      'p.mmio': '设备寄存器区（把设备当内存来读写）：IO-APIC 在 0xFEC00000、LAPIC 在 0xFEE00000、virtio 设备在自己的 BAR 窗口',
    },
    dev: {
      kbd: { data: '—', st: '0x1c（无数据待读）', ctr: '0x47（中断、键盘已开）', key: '—' }, apic: { irr: '—', isr: '—', timer: 'TSC-deadline 模式（用时间戳计数器当闹钟）', icr: '—' },
      ioapic: { pin1: '→ 送 CPU0，中断号 0x31，边沿触发' }, vq: { st: 'DRIVER_OK（驱动已就绪）', desc: '空闲（还没派任务）', avail: 3, used: 3, notify: '—' }, disk: { t: '宿主机上的镜像文件 vda.img：ext4 格式，1 GiB', op: '空闲（读写队列空闲）' },
    },
    vga: { lines: [...BOOT_LOG, ...KLOG, '# '] },
  }

  /* 上电之前到 startup_32 建好恒等映射（第 0 至 5 步）的快照：第 0 步把「原点」说清楚——固件 ROM 出厂烧录、内存条上电全是随机值；第 1 步固件自检写 IVT 与 BDA；第 2 步复位向量；第 3 步固件交权引导器；第 4 步保护模式；第 5 步恒等映射 */
  const BOOT_NEW = [
    [{ at: 0, mem: { 'p.bios': '0xF0000–0xFFFFF 是固件 ROM（BIOS 程序与复位向量）：出厂时烧录，采用非易失存储，上电即可执行——它是主板上唯一一开始就有内容的东西', 'p.ivt': '（等待固件写入）实模式中断向量表（物理地址 0，1 KiB，256 项）要等固件自检时才写', 'p.ebda': '（等待固件写入）0x9FC00 起是固件私有数据区，自检时才会用', 'p.low': '（随机值）上电后的 DRAM 内容由硬件初始化过程确定', 'p.free': '（随机值）固件稍后才会探测内存条、整理出 e820 地图' },
      x: [['p.bios', 'cpu', '上电后 CPU 将从这里取第一条指令', 'r.RIP']],
      say: '按下电源之前，主板上唯一「天生就有内容」的是固件芯片（ROM）：里面的 BIOS/UEFI 程序是出厂时烧录好的，采用非易失存储，上电即可执行。内存条则相反：DRAM 依靠供电和刷新保持内容，断电后逐渐失去可靠数据；上电后的内容由初始化过程确定。后面内存里的每一样东西——中断向量表、BDA、e820 内存地图、交接单 boot_params、内核镜像——都有各自的写入时刻：固件自检时写、引导器装载时写、内核自己写。固件 ROM/Flash 持久保存程序，上电后由地址映射提供给 CPU。' }],
    [{ at: 0, vga: { log: BOOT_LOG }, mem: { 'p.ivt': '已写入：1 KiB、256 项，记录每个中断该跳到哪段代码；实模式程序之后靠它调用 BIOS', 'p.ebda': '0x9FC00 起是固件私有数据区（自检中正在用）', 'p.bios': 'BIOS 程序本体，此刻正在执行自检代码' },
      x: [['cpu', 'p.ivt', '自检：写 256 项中断向量 + BDA', 'r.RIP']],
      say: '固件第一件事是自检（POST）：先初始化内存控制器，内存条从这一刻起才真正可用（e820 内存地图也是这时探测整理的）；然后往最低端内存写两样东西——中断向量表 IVT（物理地址 0，1 KiB，256 项）和 BIOS 数据区 BDA（0x400 附近，约 256 字节，记着串口、键盘缓冲等设备信息）。屏幕上那几行 SeaBIOS 字就是它这段时间打出来的。这是内存里第一批可信的数据。' }],
    [{ at: 0, mem: { 'p.bios': '0xF0000–0xFFFFF 是 BIOS 程序：CPU 复位后第一条指令从 0xFFFFFFF0 取，这个地址被主板映射到 BIOS 末尾，那里只有一条 jmp 跳到 BIOS 真正的入口', 'p.ivt': '固件自检时写好的 256 项实模式中断向量（0x0–0x3FF），紧接着 0x400 起是 BIOS 数据区 BDA', 'p.ebda': '0x9FC00 起是固件私有数据区（自检时写入并使用）' },
      x: [['p.bios', 'cpu', '复位：从 0xFFFFFFF0 取第一条指令（一条 jmp）', 'r.RIP']],
      say: '（把镜头拉近到上电那一瞬间）复位其实发生在整个时间线的最开头，上一步的自检就是 CPU 从这里跑起来的：按下电源后，CPU 由硬件建立架构规定的复位状态——CS 基址是 0xFFFF0000、IP 是 0xFFF0——合起来第一条指令就在 0xFFFFFFF0。这个地址在内存条之外，被主板接到 BIOS 芯片上；那里只放了一条 jmp，把 CPU 带到 BIOS 的真正入口。此时 CPU 处于 16 位实模式，CR0.PG=0、CR0.PE=0。' }],
    [{ at: 0, mem: { 'p.bz': 'bzImage 已经被引导程序装进内存（还是压缩状态，内核本体还没解开）', 'p.low': '引导程序把交接单 boot_params 和内核命令行写在低端内存里', 'p.ivt': '固件自检时写好的 256 项中断向量（0x0–0x3FF），紧接着 0x400 起是 BDA', 'p.bios': 'BIOS 程序本体，完成自检后把硬盘第一个扇区读到 0x7C00 并跳过去' },
      x: [['p.bios', 'cpu', 'BIOS 自检后读引导扇区', 'r.RIP'], ['cpu', 'p.low', '引导器写 boot_params 交接单', 'r.RSI']],
      say: '固件完成自检（屏幕上就是 SeaBIOS 那几行字），然后把硬盘最前面的引导程序读进内存，再把控制权交出去；引导器接着把压缩的内核文件 bzImage 装进内存，并把命令行、e820 内存地图等信息整理成交接单 boot_params 写在低端内存里。这时内核本体还没有运行，内存里只是摆好了东西。' }],
    [{ at: 0, cpu: { mode: 'prot32', cpl: 0, task: '（引导阶段的 CPU，还谈不上「任务」）', hlt: false },
      r: { RIP: ['0x100000 startup_32', '引导程序把控制权交给内核的保护模式入口（在物理地址 1 MiB 处）'], CS: ['0x10', '__BOOT_CS：临时用的 32 位代码段，整个地址空间平铺（不分段）'], SS: ['0x18', '__BOOT_DS：临时用的 32 位数据段'], RSI: ['&boot_params', '引导协议规定：ESI 必须指向 boot_params 这张「交接单」'] },
      cr0: { PE: 1, ET: 1 },
      say: '在 CR0 里把 PE 位（保护模式使能）置 1，CPU 从实模式切到 32 位保护模式，然后跳到 startup_32。此时 CR0.PG=0，线性地址直接对应物理地址。' }],
    [{ at: 0, c: { CR3: ['pgtable（压缩镜像内）', '临时「恒等映射」页表的地址：每一格都把虚拟地址原样映射到相同的物理地址'] }, vs: 'ident',
      mem: { 'p.pgt': '压缩内核自带的页表：一张总表 PML4 + 一张 PDPT + 4 张 PD（一共 2048 个「2 MiB 大页」的表项，正好盖住 4 GiB）' },
      x: [['cpu', 'p.pgt', 'rep stosl 清零并填入页表项（恒等映射）', 'c.CR3']],
      say: 'startup_32 先在压缩镜像自带的一块空间里搭一张临时页表：用 rep stosl 把它清零，再一条条填上页表项——每个 2 MiB 的「大页」都把虚拟地址原样映射到相同的物理地址（恒等映射）。为什么要先干这个：下一步就要切 64 位长模式，而长模式强制要求打开分页；有了这张恒等映射表，分页一打开虚拟地址仍然等于物理地址，当前指令、栈和启动数据继续由恒等映射覆盖。写进 CR3 之后，分页就有了「大本营」。' }],
  ]
  /* BOOT_MAP 将阶段快照映射到 36 个教学小步：[小步号, 在该步第几个调用处生效]。 */
  const BOOT_MAP = [
    [[6, 0], [7, 0], [8, 0], [9, 0], [10, 0]],
    [[12, 0], [11, 0], [11, 1], [13, 1], [14, 1], [15, 0]],
    [[16, 0], [17, 0], [18, 2], [18, 4]],
    [[19, 0], [20, 0]],
    [[21, 0], [22, 0]],
    [[23, 1], [24, 0]],
    [[24, 1], [24, 2], [25, 1]],
    [[26, 0], [26, 1], [26, 1], [27, 0]],
    [[28, 0], [28, 1], [28, 2], [28, 2]],
    [[29, 0], [29, 0]],
    [[30, 1], [30, 1], [31, 0], [31, 1], [31, 1], [31, 1]],
    [[32, 0], [32, 1], [32, 1], [32, 1]],
    [[33, 0], [33, 0], [33, 1], [33, 1], [33, 1], [33, 1], [33, 1]],
    [[34, 0], [34, 1], [34, 1], [34, 1], [34, 1]],
    [[35, 0], [35, 0], [35, 0], [35, 0], [35, 0], [35, 0], [35, 1], [35, 1]],
  ]
  function alignBoot(groups) {
    const out = Array.from({ length: 36 }, () => [])
    BOOT_NEW.forEach((list, i) => out[i].push(...list))
    groups.forEach((snaps, g) => {
      snaps.forEach((snap, k) => {
        const m = BOOT_MAP[g] && BOOT_MAP[g][k]
        if (!m) throw new Error('boot map mismatch: group ' + g + ' snapshot ' + k)
        out[m[0]].push({ ...snap, at: m[1] })
      })
    })
    out.forEach(list => list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)))
    return out
  }

  window.KMACHINE = {
    caveat: '这个「机器视图」是照着一台最朴素的 QEMU x86_64 机器来演示的：单颗 CPU、没开 KASLR（地址随机化）、没开 PTI（进程页表隔离）、也没用 5 级页表。下面出现的寄存器数值，除了段选择子、MSR 编号、0xec 向量号、错误码的位含义这些固定常量之外，其余都是为了讲故事编的示意值。',
    init: {
      boot: {
        cpu: { mode: 'real', cpl: 0, task: '（引导阶段的 CPU，还谈不上「任务」）', hlt: false },
        r: {
          RIP: ['0xFFF0', '复位后第一条指令所在的位置（CS:IP = 0xF000:0xFFF0，物理地址 0xFFFFFFF0）'], RSP: ['—', '复位后栈还没有设置'], RAX: ['0', '复位后通用寄存器基本是固定初值'], RDI: ['—', ''],
          RSI: ['—', '复位后还没有交接单，要等固件把它交出来'], RDX: ['—', ''], R10: ['—', ''], RCX: ['—', ''], R11: ['—', ''],
          CS: ['0xF000', '复位时 CS 的段值为 0xF000，基址为 0xFFFF0000'], SS: ['0x0', '实模式下段寄存器只是段值乘 16 得到基址，复位后还没有设置栈段'], FS: ['0', ''], GS: ['0', ''],
        },
        fl: { IF: 0 },
        cr0: { ET: 1 },
        cr4: {},
        efer: {},
        c: { CR3: ['0', '分页还没打开：CPU 直接按物理地址访问内存'], CR2: ['—', ''], IDTR: ['—', '中断是关着的，这张表还没装'], LSTAR: ['0', '还没设置（这时还用不到 syscall 指令）'], TSC_DEADLINE: ['0', '还没编程（定时器还没起来）'] },
        sw: { preempt: '—', resched: 0, softirq: '—' },
        stk: { name: '（栈等待固件/引导器建立）', items: [] },
        vs: 'none',
        mem: {
          'p.low': '（随机值）上电一瞬间内存条里全是无意义的随机位，什么都还没写进来', 'p.vga': '（空白）显存此时也没被写过，屏幕是黑的', 'p.bz': '（还在硬盘上）bzImage 此刻还在磁盘镜像里，没有进内存', 'p.kern': '（内核等待装载）',
          'p.ivt': '（等待固件写入）实模式中断向量表要等固件自检时才写（物理地址 0，1 KiB，256 项）', 'p.ebda': '（等待固件写入）0x9FC00 起的固件私有数据区，自检时才会用', 'p.bios': '0xF0000–0xFFFFF：BIOS 程序与复位向量所在的固件 ROM，出厂时烧录，采用非易失存储，上电即可执行',
          'p.vq': '—', 'p.pgt': '—', 'p.slab': '—', 'p.kstk': '—', 'p.pc': '—', 'p.anon': '—', 'p.free': '（随机值）内存条上电瞬间是随机的；固件稍后会探测它、整理出 e820 地图',
          'p.mmio': '设备寄存器区：IO-APIC 0xFEC00000、LAPIC 0xFEE00000、PCI 设备的 BAR 窗口（主板接线决定的，不在内存条里）',
        },
        dev: {
          kbd: { data: '—', st: '0x1c（无数据待读）', ctr: '（还没编程）上电默认值', key: '—' }, apic: { irr: '—', isr: '—', timer: '还没用上', icr: '—' },
          ioapic: { pin1: '还没编程' }, vq: { st: '还没初始化', desc: '—', avail: 0, used: 0, notify: '—' }, disk: { t: '宿主机上的镜像文件 vda.img：ext4 格式，1 GiB', op: '空闲（读写队列空闲）' },
        },
        vga: { lines: [''] },
      },
      cmd: LONG,
      tick: { ...LONG, cpu: { ...LONG.cpu, hlt: false }, r: { ...LONG.r, RIP: ['do_idle', ''] }, vga: { lines: [...BOOT_LOG, ...KLOG, '# cat /etc/hostname', 'linux', '# '] }, dev: { ...LONG.dev, vq: { ...LONG.dev.vq, avail: 4, used: 4 } } },
    },

    ops: {
      boot: alignBoot([
        /* 1 解压镜像，跳进 64 位内核 */
        [
          { at: 0, cr4: { PAE: 1 }, c: { CR3: ['pgtable（压缩镜像内）', '四层页表：用 2 MiB 的「大页」把 0–4 GiB 原样映射成同样的地址'] }, efer: { LME: 1, LMA: 1 }, cr0: { MP: 1, NE: 1, WP: 1, AM: 1, PG: 1 },
            cpu: { mode: 'long' }, r: { CS: ['0x10', '__KERNEL_CS：L=1 表示这是 64 位代码段'], RIP: ['startup_64（压缩部分）', '用 lret 远跳进来之后，就在这里跑 64 位代码'] }, vs: 'ident',
            mem: { 'p.pgt': '压缩内核里自带的页表：一张总表 PML4 + 一张 PDPT + 4 张 PD（一共 2048 个「2 MiB 大页」的表项，正好盖住 4 GiB）' }, x: [['cpu', 'p.pgt', 'rep stosl 把这些页清零，再填上页表项 0x183', 'c.CR3']],
            say: '要从 32 位模式升到 64 位，硬件规定必须一步一步来：第一步，打开 CR4 里的 PAE（让页表从两级变成更多级）；第二步，先把 0 到 4 GiB 的物理地址「原样」映射成同样的虚拟地址（这叫做恒等映射，用 2 MiB 一格的「大页」，页表项值 0x183 的意思是：这一页有效、可写、是个 2 MiB 大页、而且切换页表时不用刷新），再把这张表的地址写进 CR3，让 CPU 开始用它；第三步，打开 EFER 里的 LME（等于宣布「我准备进长模式了」）；第四步，写 CR0 并打开其中的 PG 位（真正把分页启动起来）。分页一开，CPU 会自动把 EFER 的 LMA 位置 1，但这会儿还在「32 位兼容」这个子模式里跑；必须再用 lret 指令远跳到「L=1」的 __KERNEL_CS 代码段，CPU 才真正开始执行 64 位指令。' },
          { at: 1, mem: { 'p.kern': '解压后的内核本体 vmlinux：代码段 .text、只读数据 .rodata、可读写数据 .data、未初始化数据 .bss（已经解压、也已经重定位好）' }, x: [['p.bz', 'cpu', '读压缩数据流', 'r.RIP'], ['cpu', 'p.kern', '写解压后的 vmlinux', 'r.RIP']],
            say: '解压完全是 CPU 自己在算：从 bzImage 里读压缩数据、解码，再把结果写到物理地址 16 MiB 处（这是不开 KASLR 时的固定落点）。如果开了 KASLR（地址随机化），就会在这一步随机挑一个物理基址和虚拟基址，免得攻击者猜到内核在哪；解压完之后还要照着 vmlinux.relocs 这张表，把镜像里那些写死的绝对地址逐个改对（这叫重定位）。' },
          { at: 2, c: { CR3: ['early_top_pgt', '放在内核数据段里的临时页表（还没换成最终的）'] }, vs: 'early', efer: { SCE: 1, NXE: 1 }, cr4: { PGE: 1 }, cr0: { ET: 1 },
            r: { RIP: ['startup_64', '已经跳到内核的虚拟地址空间（0xffffffff81000000 附近）'], RSP: ['init_task 栈顶', 'init_thread_union 这块 16 KiB 静态内存的顶部，先拿它当栈'], GS: ['本 CPU 的专属数据区', '用 wrmsr 写 MSR_GS_BASE，把 GS 指向本 CPU 的私有数据；后面取「栈保护金丝雀」（防栈被写穿的哨兵值）就是从这儿拿'] },
            stk: { name: 'init_task 的栈（内核自带的静态栈）', items: [] },
            say: '这里才是真正意义上的内核入口。此刻用的页表 early_top_pgt 里同时有两套映射：一套是「原样映射」（虚拟地址等于物理地址），另一套是高端映射 __START_KERNEL_map（虚拟地址 0xffffffff80000000 对应物理地址从 16 MiB 开始）。正因为两套都在，代码从低地址跳到高地址时还能继续取指。这里还顺手写了两项设置：EFER 的 SCE 位让 syscall 指令能用，NXE 位让页表项里的「不许执行」标记生效；CR4 的 PGE 位打开「全局页」，好处是以后换 CR3（换进程）时，内核自己的那批地址对照缓存不会被清掉，省一次重建。' },
          { at: 3, x: [['p.low', 'cpu', '读 boot_params（4 KiB 的「零页」）', 'r.RSI'], ['cpu', 'p.kern', '复制进内核自己的 boot_params 变量', 'r.RSI']],
            say: '先把 .bss 这段「未初始化数据」整体清零；再把引导程序留在内存低处的 boot_params（那张交接单）和内核命令行，原样复制进内核自己的变量里。复制完，低端 1 MiB 里那些内容就没用了，可以回收。' },
          { at: 4, say: '从这里进入「与硬件架构无关」的总初始化函数 start_kernel。此刻的状态是：RFLAGS 里的 IF 位是 0（中断关着）、机器上只有这一颗 CPU 在跑、current（当前任务）还是那个静态的 init_task，真正的调度器还没开始工作。' },
        ],
        /* 2 先把物理内存管起来 */
        [
          { at: 0, c: { CR3: ['init_top_pgt', 'swapper_pg_dir：最终要长期使用的内核页表'] }, vs: 'kernel', mem: { 'p.pgt': 'init_top_pgt：把内存条上的全部 RAM 直接映射一遍，另外还映射了内核镜像自己' }, x: [['p.kern', 'cpu', '读出 boot_params 里的 e820 内存清单', 'r.RSI'], ['cpu', 'p.pgt', '建直接映射页表', 'c.CR3']],
            say: 'setup_arch 里会调 init_mem_mapping 建「直接映射」：把整条物理内存按固定偏移，一段按可用物理区间映射到虚拟地址 0xffff888000000000 开始的地方（这个起点叫 page_offset_base）。有了它，内核只要拿物理地址加个偏移（__va 宏）就能访问任意物理页。建完再用 load_cr3(swapper_pg_dir) 换到最终那套内核页表。' },
          { at: 1, mem: { 'p.free': 'e820 报上来 6 段，其中可用的约 2 GiB' }, say: '把 BIOS 通过 E820 报上来的内存分布图整理一遍（这张图在引导阶段已经存进 boot_params）：排好顺序、去掉互相重叠的部分。图里每一段都标了类型：类型 1 表示这段是能用的内存条 RAM；类型 2 表示别动它，是保留区（BIOS 自己用的、ACPI 表格，以及留给设备的空洞）。' },
          { at: 2, mem: { 'p.free': 'memblock 的两张清单：memory 记「哪些 RAM 可用」，reserved 记「哪些已经被占」（内核镜像、页表等）' } },
          { at: 3, mem: { 'p.free': 'struct page 数组已经建好：每 4 KiB 物理内存对应 64 字节的一本「户口本」' }, va: [['v.vmemmap', 'p.free']],
            say: '给每一个 4 KiB 的物理页都配一个 64 字节的「户口本」，叫 struct page，集中放在 vmemmap 区（从虚拟地址 0xffffea0000000000 开始）。2 GiB 内存大约有 52 万个页，这些户口本加起来约 32 MiB。' },
          { at: 4, mem: { 'p.free': '伙伴系统的空闲链表 free_area[0..10]：约 50 万页空闲' }, x: [['cpu', 'p.free', '用 __free_pages 一段段放进去', 'r.RSP']],
            say: '把 memblock 清单里「可用而且没被占」的内存，一段一段交给伙伴系统。伙伴系统会把相邻的空闲块按 2 的幂合并成更大的块（最大到 order 10，也就是 4 MiB 一块）。从这一刻起，alloc_pages 这类按整页申请内存的函数就能用了。' },
          { at: 5, mem: { 'p.slab': 'SLUB 的一堆内存池：kmem_cache，以及从 kmalloc-8 到 kmalloc-8k 各种大小' }, x: [['p.free', 'p.slab', '从伙伴系统整页取来，切成一个个小对象']],
            say: '轮到 SLUB（负责小块内存的分配器）自己起来：先用一块静态预留的 boot_kmem_cache 切出对象，专门用来管 kmem_cache（各种「内存池」的描述结构）自身；再建好从 kmalloc-8 到 kmalloc-8k 这些不同大小的池子。从此 kmalloc 就能用了。' },
        ],
        /* 3 装中断门、时钟和 RCU */
        [
          { at: 0, c: { IDTR: ['idt_table', '用 lidt 告诉 CPU 它在哪里：一共 256 个格子，每格 16 字节'], LSTAR: ['entry_SYSCALL_64', '由 cpu_init → syscall_init 写进去'] }, x: [['cpu', 'p.kern', '填 IDT 里的各个入口', 'c.IDTR']],
            say: 'trap_init 把各种「出错处理入口」填进 IDT 表——比如 #DE（除数为零）和 14 号 #PF（访问内存出错），然后用 lidt 指令把这张表的地址告诉 CPU。接着 cpu_init → syscall_init 去写几个 MSR（CPU 内部的特殊寄存器）：LSTAR 写 entry_SYSCALL_64，也就是 syscall 指令一执行该跳去哪；STAR 写清楚用哪个段选择子当内核段、哪个当用户段；SYSCALL_MASK 指定「进内核时自动清掉 RFLAGS 的哪几位」（IF 关中断、TF 关单步、DF 关方向标志、AC 关 SMAP 等）。TSS 也在这里装好，因为从用户态（ring 3）掉进内核时，CPU 需要从 TSS 里查「该用哪个栈」。' },
          { at: 1, say: '设备中断用的那些编号（大致 0x20 到 0xeb）在 IDT 里都指向同一个入口桩 common_interrupt，由它再分发到具体设备；内核还给每个中断号准备了一份记录（irq_desc），记着这个号是谁在用、要调哪个处理函数。' },
          { at: 6, sw: { softirq: '无' } },
          { at: 7, fl: { IF: 1 }, dev: { apic: { timer: 'TSC-deadline 模式（用时间戳计数器当闹钟）' } }, sw: { preempt: '0' },
            say: 'time_init 负责把「时间」搞起来：校准 TSC（CPU 内部那个一直在数的计时器），并把本地 APIC 的定时器准备好。只要 CPU 支持，就用 TSC-deadline 模式：往 MSR 0x6E0 里写一个绝对时间点（TSC 值），时间到了就产生 0xec 号中断。接着 start_kernel 调用 local_irq_enable，实际就是一条 sti 指令：把 RFLAGS 的 IF 位置 1，从此中断才真正允许进来。' },
        ],
        /* 4 调度器就位 */
        [
          { at: 0, say: '每颗 CPU 都有自己的一份运行队列（struct rq），放在各自的「私有数据区」里——这正是 GS 寄存器基址所指向的地方。所以每颗 CPU 都能立刻找到自己那份，不用加锁。' },
          { at: 1, cpu: { task: 'swapper/0' }, r: { RSP: IDLE_SP }, stk: { name: 'swapper/0 的栈', items: [] },
            say: 'init_idle(current) 做的事，就是把此刻正在跑 start_kernel 的 init_task 登记成这颗 CPU 的「空闲任务」（idle），编号 PID 0，名叫 swapper/0。要点是：CPU 上那套寄存器状态，任何时候都归属于某个任务，不存在「不属任何人」的空档，连 CPU 闲着发呆时也挂在 idle 任务名下。' },
        ],
        /* 5 建 VFS 缓存和临时根 */
        [
          { at: 0, cr4: { OSFXSR: 1, OSXMMEXCPT: 1, UMIP: 1, FSGSBASE: 1, PCIDE: 1, OSXSAVE: 1, SMEP: 1, SMAP: 1 }, vga: { log: KLOG.slice(0, 3) },
            mem: { 'p.slab': '又多了几种内存池：dentry（目录项）、inode_cache（文件元数据）、filp（打开的文件）、names_cache（路径名），以及 dentry/inode 的哈希表' }, x: [['cpu', 'p.slab', '分配哈希表和内存池', 'r.RDI']],
            say: '在这之前，start_kernel 已经调过 console_init（从此 printk 打印的信息会写到 VGA 屏幕上），也走过 arch_cpu_finalize_init → identify_boot_cpu：它先去问 CPU 支持哪些功能（读 CPUID），然后打开 CR4 里对应的一堆开关，比如 SMEP（禁止内核去执行用户程序的代码页）、SMAP（内核默认不许随便读写用户内存，要先用 stac/clac 临时申请）、UMIP、FSGSBASE、PCIDE 等——具体能开哪些，取决于 QEMU 模拟出来的 CPU 型号。这里接着做的事是 vfs_caches_init：为「文件目录项」（dentry）和「文件元数据」（inode）建好哈希表和内存池。' },
          { at: 3, say: '此刻的根文件系统 rootfs 是内存里的 tmpfs（纯内存文件系统）：它的文件元数据（inode）和目录项（dentry）都是内存池里的小对象，文件内容就是普通的页缓存页；元数据和内容均由内存中的对象和页提供。' },
        ],
        /* 6 拉起 1 号与 2 号 */
        [
          { at: 2, mem: { 'p.slab': '又多了两块 task_struct：kernel_init(1) 和 kthreadd(2)', 'p.kstk': 'kernel_init(1)、kthreadd(2) 各自 16 KiB 的内核栈' }, va: [['v.vmalloc', 'p.kstk']],
x: [['p.free', 'p.slab', '分配 task_struct ×2', 'r.RSP'], ['p.free', 'p.kstk', '分配内核栈 ×2（共 4 页）', 'r.RSP']],
            say: 'copy_process 负责造这个新任务：从 SLUB 拿一块 task_struct（进程的「身份证」），再从 vmalloc 区申请 16 KiB 当它的内核栈（这模式叫 VMAP_STACK：栈的两头各留一块没映射的地址当围墙，万一栈写溢出，会立刻触发 #PF 报错，而不是悄悄把别人内存踩坏）。最后在新栈顶伪造出一帧「假现场」，这样它第一次被调度上来时，会像是从一个函数返回一样，从 ret_from_fork 开始执行。' },
          { at: 5, cpu: { task: 'kernel_init(1)' }, r: { RSP: T.init.ksp, RIP: ['ret_from_fork → kernel_init', '回到这儿之后就一路走到 kernel_init'] }, stk: { name: 'kernel_init(1) 的内核栈', items: ['ret_from_fork 的返回帧（copy_process 提前摆好的）'] },
            say: '这是内核第一次真正「切换任务」：__switch_to_asm 把当前栈指针 RSP 换成 1 号任务的内核栈，从新栈上把刚才预备好的那几个「被调用者负责保存」的寄存器弹出来，再 ret 一下，就落到了 ret_from_fork。注意 CR3 没变：这些早期内核线程的 mm=NULL，借用 init_mm 页表，CR3 保持原值。' },
        ],
        /* 7 initcall */
        [
          { at: 2, dev: { apic: { icr: '依次发 INIT、SIPI、SIPI（把其它 CPU 叫醒）' } }, x: [['cpu', 'apic', '往 ICR 写 INIT / SIPI', 'r.RAX']],
            say: '主 CPU（BSP）通过本地 APIC 的 ICR 寄存器，依次给其它 CPU 发 INIT、SIPI、SIPI 三种信号把它们叫醒；被叫醒的 CPU（AP）从实模式的一小段「蹦床」代码起步，一路爬到 start_secondary 函数，然后各自进入 idle 待命。本页只画 CPU0。' },
          { at: 3, mem: { 'p.kstk': '又多了不少内核线程的栈：kworker/*（打杂工）、ksoftirqd/*（干软中断的）、rcu_*（管 RCU 的）等' } },
          { at: 6, say: 'initcall 机制：内核把「开机时要跑的各路初始化函数」按用途分级，把它们的地址排进 .initcall*.init 这些段里，然后从头到尾一个个调用。这些函数的代码都放在标了 __init 的段里，用完（在启动 1 号用户程序之前）就整段释放，把内存还回去。' },
        ],
        /* 8 virtio-blk 与 ext4 登记 */
        [
          { at: 1, dev: { vq: { st: 'ACKNOWLEDGE → DRIVER → FEATURES_OK（一步步摸底）' } }, x: [['cpu', 'virtio', '读 PCI 配置空间，协商用哪些特性', 'r.RAX']],
            say: 'PCI 总线扫描时，内核读到一块设备的厂商标识是 0x1af4、设备标识是 0x1042，认出这是 virtio 1.0 标准的虚拟磁盘。驱动接着通过这个设备 BAR 窗口里的「通用配置区」去读它支持哪些特性，再把自己愿意接受的那部分写回去，同时按规矩把设备状态一步步推进：ACKNOWLEDGE（我认领你了）→ DRIVER（我知道驱动是谁了）→ FEATURES_OK（特性协商谈好了）。' },
          { at: 2, mem: { 'p.vq': '虚拟磁盘的队列区：描述符表 desc[128] / 驱动交办环 avail / 设备完成环 used' }, dev: { vq: { st: 'DRIVER_OK（驱动已就绪）', desc: '空闲（还没派任务）', avail: 0, used: 0 } }, x: [['p.free', 'p.vq', '分配这三块环内存（设备也能直接访问）'], ['cpu', 'virtio', '把队列物理地址和 MSI-X 表项写给设备', 'r.RAX']],
            say: 'split virtqueue（「拆开的」虚拟队列）是驱动和设备共用的一块约定内存，分三部分：描述符表（一条条任务，写明数据在哪个地址、多长、什么标志）、avail 环（驱动写好任务后，在这里告诉设备「该做第几条了」）、used 环（设备做完后在另半边告诉驱动「哪几条干完了」）。驱动要把这三块内存的物理地址告诉设备，设备才能找到它们。MSI-X 那张表项里写的其实是一个地址加一个号码：「完事之后，往 0xFEE00000 写这个号码」——设备照做，对 CPU 来说就是一次中断。' },
          { at: 3, vga: { log: KLOG.slice(3, 4) }, dev: { vq: { avail: 1, used: 1 }, disk: { op: '正在读 LBA 0（盘上的第 0 个扇区）' } }, mem: { 'p.pc': 'vda 这块盘的页缓存：LBA 0–7 那一块（4 KiB）' }, x: [['cpu', 'p.vq', '填描述符链', 'r.RAX'], ['disk', 'p.pc', '设备直接把 4 KiB 写进内存']],
            say: '要扫描有没有分区表，就得先读磁盘的第 0 个扇区（LBA 0）——这是本次开机第一次真正去动磁盘（本例的盘本体就是 ext4，没有分区表，所以这次读到的就是文件系统的开头）。' },
          { at: 4, mem: { 'p.slab': '又多了 ext4 专用的几个内存池（比如 ext4_inode_cache）' }, say: 'ext4_init_fs 只做两件事：给 ext4 用到的几种数据结构建好内存池，然后向内核登记「我这种文件系统叫 ext4，以后碰到 ext4 的盘就归我管」。盘面读取由后续挂载和文件访问触发。' },
        ],
        /* 9 终端：VT、键盘、i8042 */
        [
          { at: 0, va: [['v.direct', 'p.vga']], say: 'vgacon（VGA 屏幕的驱动）把虚拟终端的屏幕缓冲直接对准显存 0xB8000——内核通过「直接映射」就能读写它。这块屏幕是 80 列 × 25 行，每个格子占 2 字节：一个字节是显示什么字符，另一个字节是颜色属性。' },
          { at: 3, dev: { kbd: { ctr: '0x47：中断开、键盘开、扫描码翻译开', st: '0x1c（无数据待读）' }, ioapic: { pin1: '→ 送 CPU0，中断号 0x31，边沿触发' } }, x: [['cpu', 'kbd', '往 0x64 发命令 0x20（要读命令字节）', 'r.RAX'], ['kbd', 'cpu', '从 0x60 读回命令字节', 'r.RAX'], ['cpu', 'ioapic', '设置第 1 脚的重定向表项', 'r.RAX']],
            say: 'i8042（键盘控制器芯片）是通过 I/O 端口访问的，和内存是两套地址：端口 0x64 用来发命令、读状态；端口 0x60 用来读写数据。驱动先读控制器的「命令字节」（CTR）检查两位：XLATE 有没有打开（把键盘的 set 2 扫描码翻译成老的 set 1 码）、KBDINT 有没有打开（一有数据就拉 IRQ 1 这条中断线）。等到 request_irq(1) 申请中断时，IO-APIC 第 1 脚那张「重定向表项」会被写成：「边沿触发、送到 CPU0、中断号 0x31」（号码是示意值）。' },
          { at: 4, x: [['cpu', 'kbd', '发 0xF2 读键盘 ID，回 0xAB 0x83', 'r.RAX'], ['cpu', 'kbd', '发 0xF4 让键盘开始扫描', 'r.RAX']], say: '键盘驱动 atkbd 先往键盘发命令 0xF2 问「你是谁」（AT 键盘回 0xAB 0x83），再设置指示灯和长按重复率，最后发 0xF4 让键盘正式开始扫描按键。' },
          { at: 5, vga: { log: KLOG.slice(4, 5) } },
        ],
        /* 10 /dev/console → fd 0/1/2 */
        [
          { at: 0, mem: { 'p.slab': '多了一个 file 对象（/dev/console），被 fd 0/1/2 三个描述符共用' }, say: 'filp_open 在 rootfs 里找到 /dev/console 这个设备节点（主次设备号 5:1，属于「字符设备」），拿到一个 struct file（代表「一个打开的文件」），再用 dup 复制两份，分别放进文件描述符 0、1、2 里——以后程序的「标准输入/标准输出/标准错误」都指向它。' },
          { at: 4, mem: { 'p.slab': '又多了 tty_struct(tty1)，以及 n_tty_data（内含 4 KiB 的 read_buf 和 echo_buf）' }, say: 'n_tty_data 这块结构里有两样东西：一个 4 KiB 的「环形读缓冲」read_buf（所谓环形，就是写到末尾就绕回开头），以及一个回显缓冲（用来记住该回显什么）。read_head、canon_head、read_tail 都是在这个环里的下标位置：分别表示「写到哪了」「已经凑够一行的位置」「读到哪了」。' },
        ],
        /* 11 挂 ext4 根 */
        [
          { at: 4, say: 'ext4 的「超级块」（记录整个文件系统概况的那块数据）固定在设备开头的第 1024 字节处。ext4 先用 sb_bread 把包含它的那一个块读进「块缓冲缓存」（其实也就是磁盘 vda 自己的页缓存）。' },
          { at: 5, mem: { 'p.pc': 'vda 的页缓存里多了块 0：超级块，此刻被锁住、正在从磁盘读' } },
          { at: 6, dev: { vq: { desc: '[0] 只读的请求头（读、扇区 0）· [1] 4 KiB 数据页（留给设备写）· [2] 1 字节状态', avail: 2, notify: '已敲门铃' } }, x: [['cpu', 'p.vq', '填好 3 个描述符，交办序号 +1', 'r.RAX'], ['cpu', 'virtio', '写 notify 寄存器 → 虚拟机退出', 'r.RAX']],
            cpu: { task: 'swapper/0', hlt: true }, r: { RSP: IDLE_SP, RIP: ['default_idle → hlt', '1 号睡下了，CPU 也停住'] }, stk: { name: 'swapper/0 的栈', items: [] },
            say: '一次读操作被拆成 3 个描述符，串成一条链：第一个是只读的「请求头」（写明这次是读、从哪个扇区开始），第二个是留给设备写数据的那一页，第三个是留给设备写 1 个字节状态的位置。把链头放进 avail 环、序号加一之后，驱动再去写 notify 寄存器「敲一下门铃」：在这台虚拟机里，这次写设备寄存器的动作会让虚拟机退出（VM exit），把控制权交给外面的 QEMU。此刻 1 号任务因为等 I/O 进入 TASK_UNINTERRUPTIBLE（不可打断睡眠），运行队列空了，CPU 只好执行 hlt 停下来省电。' },
          { at: 7, dev: { vq: { used: 2, desc: '设备已经写好状态字节 0（成功）' }, apic: { irr: '0x24（待处理）' }, disk: { op: '正在读 LBA 0–7' } }, mem: { 'p.pc': 'vda 页缓存块 0：超级块，里面的魔数 s_magic = 0xEF53，认出这是 ext4' },
            x: [['virtio', 'p.vq', '读出描述符链'], ['disk', 'p.pc', '把 4 KiB 写进内存（DMA）'], ['virtio', 'p.vq', '写状态 0，完成序号 +1'], ['virtio', 'apic', '按 MSI-X 表项往 0xFEE00000 写中断号']],
            say: 'QEMU 在外头读 avail 环，取到那条描述符链，然后从宿主机的镜像文件里 pread 出 4 KiB，直接写进描述符所指的那块客户机物理内存（这就相当于 DMA：数据是设备搬的，CPU 没参与）。搬完再写上状态字节 0、把 used 环序号加一，最后按 MSI-X 表项，往地址 0xFEE00000 写一个中断号——对 LAPIC 来说，这就是一次中断请求（号码是示意值）。' },
          { at: 8, ...IRQ('0x24', 'default_idle（hlt 之后）', 'swapper/0 的栈'), x: [['apic', 'cpu', '递交中断号 0x24', 'fl.IF'], ['cpu', 'apic', '写 EOI（表示已收下）', 'r.RAX']], dev: { apic: { irr: '—', isr: '—（已经应答过了）' } },
            say: 'LAPIC 把这个中断号交给 CPU：CPU 正停在 hlt 上，于是立刻响应，把 SS、RSP、RFLAGS、CS、RIP 这一叠现场压到栈上（因为本来就在内核态，所以特权级不变），因为走的是「中断门」，CPU 会自动把 IF 清 0（先不让新中断插队），然后按 IDT 第 0x24 项跳进入口桩。MSI 属于「边沿」式中断，所以一进来就写 LAPIC 的 EOI 寄存器表示「这个中断我收下了」。最后 vring_interrupt 看到 used 环里多了一条，于是收尾这次请求、给缓冲解锁、把 1 号任务叫醒。' },
          { at: 9, cpu: { task: 'kernel_init(1)' }, sw: { preempt: '0' }, fl: { IF: 1 }, r: { RSP: T.init.ksp }, stk: { name: 'kernel_init(1) 的内核栈', items: [] }, vga: { log: KLOG.slice(5, 7) },
            mem: { 'p.pc': 'vda 页缓存里陆续有了：超级块、组描述符、日志超级块…' }, say: '1 号任务被重新调度回来继续干活：先核对超级块里的魔数确实是 0xEF53（确认是 ext4），再读「组描述符」，把日志模块 jbd2 加载起来并启动 kjournald2 线程专门负责写日志。最后把这块 ext4 文件系统挂到根目录 / 上，并 chroot（把根目录改到它下面）。' },
        ],
        /* 12 exec /sbin/init */
        [
          { at: 0, vga: { log: KLOG.slice(7, 8) }, mem: { 'p.kern': '内核镜像 vmlinux：标了 __init 的那些「用完即弃」代码已经释放' } },
          { at: 3, mem: { 'p.pc': '页缓存里多了 busybox 的第 0 页（装着 ELF 头和程序头表）' }, x: [['p.pc', 'cpu', '读 ELF 头和程序头表', 'r.RAX']], say: '读文件开头的「ELF 头」和「程序头表」——这是可执行文件自我介绍的部分：里面写着有两段要装进内存（两个 PT_LOAD），一段是代码（权限为读取和执行），一段是数据（可读写）；本例使用静态链接 ELF，内核直接进入其入口地址。' },
          { at: 4, c: { CR3: ['0x7fd14000 | PCID 1', 'init(1) 新地址空间的页表根'] }, vs: 'init', mem: { 'p.pgt': '多了 init(1) 的页表根 PGD：高半部直接沿用 init_top_pgt 的内核映射' }, x: [['cpu', 'p.pgt', '分配一张 PGD，把内核那半抄过来', 'c.CR3']],
            say: 'exec_mmap 给这个进程换来一套全新的地址空间（mm），并把新页表根的地址写进 CR3。新页表根的高半部（也就是内核地址那一片）指向的下级表，和内核总表 init_top_pgt 用的是同一份，所以「内核部分的映射在每个进程里都一样」；低半部（用户地址那一片）现在还是空的：程序各段只是登记成 VMA（记录「这片地址该对应哪个文件、什么权限」），页表项一个都还没建。' },
          { at: 5, ...RET(T.init, '0', '新程序从 0 开始', ['0x401000 _start', 'iretq 会把 pt_regs 里设好的入口地址弹回 RIP']), mem: { 'p.anon': 'init(1) 的用户栈页：上面摆好了 argc/argv/envp/auxv' }, va: [['v.stack', 'p.anon']],
            stk: { name: 'init(1) 的用户栈（新）', items: ['argc = 1', 'argv[0] → "/sbin/init"', 'NULL', 'envp → HOME=/  TERM=linux', 'NULL', 'auxv：AT_ENTRY=0x401000、AT_PAGESZ=4096 …'] }, x: [['cpu', 'p.anon', '把参数、环境变量等摆到用户栈上', 'r.RAX']],
            say: 'start_thread 做的只是改一改内核栈上那份 pt_regs（刚才存下来的用户寄存器快照）：把返回地址改成 ELF 的入口地址、把栈指针改成新用户栈、把段寄存器改成用户段。真正回到用户态靠的是 iretq 指令：CPU 会依次把 RIP、CS（0x33，RPL=3 表示用户态）、RFLAGS、RSP、SS 弹回去，特权级 CPL 就从 0 变成 3；返回之前还要 swapgs，把 GS 换回用户那套。' },
        ],
        /* 13 第一条指令缺页 */
        [
          { at: 0, walk: { va: '0x401000', res: ['空 → #PF', '', '', ''] }, say: 'MMU（CPU 里管地址转换的部件）先按 CR3 找到最顶层的页表 PML4，然后从虚拟地址 0x401000 里取出第 47–39 位当下标（这里算出来是 0），去查那一项：是空的——因为这个新地址空间的用户半部连一张下级页表都还没建。地址翻译不下去，取指令失败，于是产生一次 #PF（缺页异常）。' },
          { at: 1, ...PF(T.init, '0x401000', '0x14', 'U=1 用户态、I=1 取指、P=0 页不存在'),
            say: '#PF 是 14 号异常。CPU 会自动做几件事：把出错的地址记进 CR2；因为要从用户态（ring 3）掉进内核态（ring 0），得换个栈，于是从 TSS 里取出 RSP0 指向的栈（Linux 让它指向 cpu_entry_area 里的「入口栈」，入口代码随后再把现场搬到该任务自己的内核栈上）；接着压入 SS、RSP、RFLAGS、CS、RIP 和错误码 0x14；最后按 IDT 第 14 项跳到 asm_exc_page_fault。入口代码再 swapgs 换回内核数据指针、把全部通用寄存器存成 pt_regs，然后调用 exc_page_fault。' },
          { at: 2, fl: { IF: 1 }, walk: { va: '0x401000', res: ['新建 PDPT', '新建 PD', '新建 PT', '空：等着填写'] }, mem: { 'p.pgt': '多了 init(1) 的 PDPT、PD、PT 各一页' }, x: [['p.free', 'p.pgt', '分配 3 张页表页']],
            say: 'do_user_addr_fault 先把手中断打开（因为接下来可能要睡等磁盘），然后在 mm 里的 maple tree（一棵记录所有 VMA 的树）中找到覆盖地址 0x401000 的那一段 VMA：是 busybox 的代码段，权限是「可读可执行」，和这次取指的需求对得上。接着 handle_mm_fault 一级一级把缺的页表页补出来：给 PML4[0] 挂一张新 PDPT，再挂新 PD、新 PT。' },
          { at: 4, mem: { 'p.pc': '页缓存里插入 busybox 的一页（索引 1，已上锁，正在等磁盘读回）' }, x: [['p.free', 'p.pc', '分配一页并插入页缓存表']],
            say: '按 VMA 里记的 vm_pgoff（这段映射从文件的第几页开始）算出要的是文件的第 1 页，然后去 busybox 这个 inode 的 address_space（一堆按索引排列的页缓存，用 xarray 实现）里查：该页缓存查询返回缺失，于是走「同步预读」流程：分配一个 folio（页缓存里的一页），给它加锁，插进页缓存，然后交给 ext4 去把内容从磁盘读上来。' },
          { at: 5, say: 'ext4_map_blocks 去查 ext4 的 extent 树，把「文件的第几个逻辑块」翻译成「磁盘上的第几个物理块」；如果翻译出来发现磁盘上是连续的一串，就合并进同一个 bio（一次批量 I/O 请求）里，少跑几趟。' },
          { at: 6, dev: { vq: { avail: 3, used: 3, desc: '[0] 只读请求头（读）· [1] 代码页（留给设备写）· [2] 状态字节' }, disk: { op: '正在读 busybox 的代码' } }, mem: { 'p.pc': 'busybox 代码页（uptodate：内容已就绪）' },
            x: [['cpu', 'p.vq', '填描述符链', 'r.RAX'], ['cpu', 'virtio', '写门铃寄存器', 'r.RAX'], ['disk', 'p.pc', '把代码页搬进内存（DMA）'], ['virtio', 'apic', '按 MSI-X 报完成']],
            say: '这一轮 I/O 和当初挂根文件系统时走的是同一套流程，这里压缩成一步：把描述符排进队列、敲门铃通知设备；init 因为要等这页数据（锁在 folio 上）而进入 D 状态（不可打断睡眠）睡下，CPU 就去跑 idle；另一边 QEMU 把代码页搬进页缓存，等完成中断到来时，把这一页标成 uptodate（内容已就绪）、解锁、再把 init 叫醒。' },
          { at: 7, walk: { va: '0x401000', res: ['存在', '存在', '存在', 'PTE → 页缓存里的那一页（有效、用户可访问、只读、可执行）'] }, va: [['v.text', 'p.pc']], ...RET(T.init, '—', '', ['0x401000（重新执行）', '#PF 属于「故障」类：返回后会重新执行出错的那条指令']),
            x: [['cpu', 'p.pgt', '填上最后一级页表项', 'c.CR3']],
            say: 'finish_fault 把最后一级页表项（PTE）填上：指向页缓存里的那一页，权限写成「有效、用户态可访问、只读、允许执行」。然后 iretq 回到用户态，RIP 依然停在 0x401000：#PF 属于「故障」类异常，处理完是重新执行出错的那条指令，这次 MMU 沿着四级页表一路走通，拿到了物理地址，取指令成功。' },
        ],
        /* 14 init 拉起 sh */
        [
          { at: 0, ...SYS(T.init, 57, 'fork', {}, '一条 syscall 指令就能进内核：CPU 把 RIP 跳到 MSR_LSTAR 里存的地址（也就是 entry_SYSCALL_64），CS/SS 换成 MSR_STAR 里指定的内核段，特权级从 3 降到 0；同时把返回地址存进 RCX、把 RFLAGS 存进 R11，并按 SYSCALL_MASK 的设定把 RFLAGS 里的 IF（中断开关）等位清掉。入口代码接着 swapgs、把栈换成内核栈、压好 pt_regs，再按 RAX 里的编号去 sys_call_table 查表。补充一句：x86_64 上 musl 的 fork() 发的就是 57 号 fork 调用，而在内核里它其实等价于 clone(SIGCHLD)。'),
            mem: { 'p.slab': '多了一块 task_struct（子进程）', 'p.kstk': '多了一块子进程的内核栈', 'p.pgt': '多了子进程的一套页表：从 init 复制来的，可写的页被改成只读' } },
          { at: 1, cpu: { task: 'sh（fork 出来的子进程）' }, c: { CR3: ['0x7fd0c000 | PCID 2', '子进程自己的页表根'] }, r: { RAX: ['112', '系统调用编号：setsid'], RSP: T.sh.ksp },
            say: '这个子进程第一次被调度上来：switch_mm 把 CR3 换成它自己的页表根（内容是刚才 fork 时复制出来的），然后从 ret_from_fork 返回用户态，于是 fork() 在子进程这边的返回值是 0（父进程那边拿到的是子进程的编号）。紧接着它发出 112 号系统调用 setsid。' },
          { at: 2, r: { RAX: ['257', '系统调用编号：openat'], RDI: ['-100', 'AT_FDCWD：以「当前目录」为起点'], RSI: ['"/dev/tty1"', '用户态里那个字符串的地址'], RDX: ['O_RDWR', 'O_RDWR：要读写'], R10: ['0', 'mode（新建文件时的权限，这里用不上）'] } },
          { at: 5, mem: { 'p.slab': 'tty1 的记录里多了归属：会话和前台进程组都记成 sh' } },
          { at: 6, r: { RAX: ['59', '系统调用编号：execve'], RDI: ['"/bin/sh"', ''], RSI: ['argv', ''], RDX: ['envp', ''] }, c: { CR3: ['0x7fd23000 | PCID 3', 'sh 新地址空间的页表根'] }, vs: 'sh', cpu: { task: 'sh' },
            say: 'execve 又换了一回地址空间：保留进程号并装载新地址空间的页表根。因为 sh 和 init 其实是同一个 busybox 文件，所以两边要用的代码页，就直接共用页缓存里的同一批物理页，省了内存也省了磁盘。' },
        ],
        /* 15 sh 打提示符，睡在 read 上 */
        [
          { at: 0, ...SYS(T.sh, 1, 'write', { RDI: ['1', 'fd 1，就是 /dev/tty1'], RSI: [T.sh.buf, '→ "# "'], RDX: ['2', '要写 2 个字节'] }) },
          { at: 1, fl: { AC: 1 }, va: [['v.data', 'p.anon']], x: [['p.anon', 'cpu', '把用户内存里的 "# " 拷进内核', 'fl.AC']],
            say: '内核这次要从用户的内存里取数据。可前面把 SMAP 打开了，内核默认是不许碰用户页的。规矩是这样：copy_from_user 在动手之前先执行 stac 指令把 RFLAGS 里的 AC 位置 1（等于临时打个招呼「我现在要访问用户内存」），拷完之后再用 clac 把它清 0。数据就这样搬进了 tty 的 write_buf。' },
          { at: 2, fl: { AC: 0 } },
          { at: 4, vga: { out: '# ' }, va: [['v.direct', 'p.vga']],
            say: 'VGA 文本模式下每个字符占 2 个字节：低字节是它的 ASCII 编码（"#" 就是 0x23），高字节是颜色属性（0x07 表示黑底、浅灰字）。CPU 只用一条普通的 mov 指令把这两个字节写进显存，显卡下一次扫描屏幕时，就把它显示出来了。' },
          { at: 5, r: { RAX: ['0', '系统调用编号：read'], RDI: ['0', 'fd 0，就是 /dev/tty1'], RSI: [T.sh.buf, '要装进哪个用户内存位置'], RDX: ['1023', '最多读 1023 字节'] } },
          { at: 6, say: 'set_current_state(TASK_INTERRUPTIBLE) 把 sh 的状态从「可运行 R」改成「可打断的睡眠 S」，并把它挂到 tty 的 read_wait 等待队列上——意思就是「键盘那边有数据了再叫我」。' },
          { at: 7, cpu: { task: 'swapper/0' }, r: { RSP: IDLE_SP }, stk: { name: 'swapper/0 的栈', items: [] },
            say: '切换到 idle 任务：这一步只换了两样东西——内核栈，以及几个「被调用者负责保存」的寄存器。idle 是内核线程，没必要写 CR3，所以 CR3 还是 sh 的那套页表（这叫懒切换：等真来了别的用户进程再换）。' },
          { at: 8, cpu: { hlt: true }, r: { RIP: ['pv_native_safe_halt', '先 sti 开中断，再 hlt 停下'] }, c: { TSC_DEADLINE: ['TSC + 约 12 ms', '用 wrmsr 写 MSR 0x6E0'] }, dev: { apic: { timer: '闹钟已设好' } }, x: [['cpu', 'apic', '写 TSC_DEADLINE 设闹钟', 'c.TSC_DEADLINE']],
            say: 'tick_nohz_idle_stop_tick 先算出「下一个定时事件大概什么时候到」，然后把这个时刻的 TSC 值写进 MSR 0x6E0（也就是 TSC_DEADLINE 寄存器）。接着执行 sti; hlt：为什么把这两条写在一起？因为 CPU 规定 sti 的效果要延后一条指令才生效，这样「开中断」和「停机等待」之间就不会留个缝，把刚好那一刻到来的中断漏掉。CPU 就停在 hlt 上，直到有中断把它叫醒。' },
        ],
      ]),

      cmd: [
        /* 1 按下 C：IRQ 1 */
        [
          { at: 0, dev: { kbd: { data: '0x2e', st: '0x1d（有数据等人读）', key: 'C 被按下' }, apic: { irr: '0x31（待处理）' } }, x: [['kbd', 'ioapic', 'IRQ 1 线上出现上升沿'], ['ioapic', 'apic', '送出中断号 0x31 给 CPU0']],
            say: '键盘把 0x21（这是它自己用的 set 2 编码）发给 i8042 控制器，i8042 把它翻译成 set 1 编码的 0x2e，放进输出缓冲，同时把状态寄存器里的 OBF 位置 1（表示「有数据等人来读」），并拉起 IRQ 1 这条中断线。IO-APIC 按第 1 脚上事先设好的重定向表项，产生中断号 0x31 送给 CPU0 的本地 APIC，LAPIC 就先把它记在 IRR（待办清单）里。' },
          { at: 1, ...IRQ('0x31', 'pv_native_safe_halt+…', 'swapper/0 的栈'),
            say: 'CPU 被从 hlt 叫醒：LAPIC 把 IRR 里优先级最高的那个中断号搬进 ISR（表示「正在处理」），然后交给 CPU。CPU 把 SS、RSP、RFLAGS、CS、RIP 压栈（注意打断的是内核态的 idle，所以特权级不变），因为走中断门，IF 自动被清 0；接着按 IDT 第 0x31 项跳进入口桩。入口桩压上中断号之后进 common_interrupt，把栈切到这颗 CPU 专用的硬中断栈，并把 preempt_count 加上一个 HARDIRQ 计数（让内核知道「我现在正在处理硬中断」）。' },
          { at: 2, dev: { apic: { isr: '—（已应答）' } }, x: [['cpu', 'apic', '写 EOI 应答', 'r.RAX']],
            say: '这是「边沿」式中断，处理方式和其他中断不同：handle_edge_irq 一上来就先应答（ack）——具体动作就是写 LAPIC 的 EOI 寄存器，告诉它「这一条我收到了，可以继续收下一条」；然后再把这个中断标成「正在处理」，去调用登记在它名下的处理函数链。' },
          { at: 4, r: { RAX: ['0x2e', 'AL 里就是扫描码 0x2e（C 键按下）'] }, dev: { kbd: { data: '（已被读走）', st: '0x1c（数据已被取走）' } }, x: [['kbd', 'cpu', '从 0x64 读状态，AL = 0x1d', 'r.RAX'], ['kbd', 'cpu', '从 0x60 读数据，AL = 0x2e', 'r.RAX']],
            say: '「端口 I/O」是单独于内存的另一套地址空间，访问它要用专门的 in / out 指令。in 指令把 0x64 端口的状态读进 AL，看到 OBF=1，说明确实有数据；于是再从 0x60 端口把 0x2e 读出来。数据一被读走，8042 会自动把 OBF 清 0，并把 IRQ 1 线放下来（这样下次有键按下还能再拉高一次，形成新的边沿）。' },
        ],
        /* 2 扫描码 → KEY_C */
        [
          { at: 2, r: { RAX: ['46', '查表得到 KEY_C（编号 46）'] }, x: [['p.slab', 'cpu', '查键盘驱动的对照表', 'r.RAX']], say: '键盘驱动 atkbd 拿这个扫描码去查自己结构里的 keycode[] 对照表（这个结构本身也是内存池里的一个小对象），查到它代表 KEY_C，编号 46。' },
          { at: 3, r: { RDI: ['input0', 'dev：哪台输入设备（input0）'], RSI: ['1', 'type：事件类型 EV_KEY（按键）'], RDX: ['46', 'code：按键编号 KEY_C（46）'], RCX: ['1', 'value：1 = 按下（0 表示松开）'] },
            say: '内核里的函数调用遵循一套约定（SysV ABI）：像 input_event(dev, type, code, value) 这样带 4 个整数参数，参数就按顺序放进 RDI、RSI、RDX、RCX 这 4 个寄存器。这里依次是：哪个设备、事件类型是「按键」、按键编号 KEY_C、值是「按下」。' },
        ],
        /* 3 VT → flip buffer */
        [
          { at: 3, mem: { 'p.slab': 'tty1 的临时缓冲里：一个 c（0x63）' }, x: [['cpu', 'p.slab', "往临时缓冲里放一个 c（0x63）"]],
            say: "内核按键盘映射表把 KEY_C 翻译成字符 c（0x63），再用 tty_insert_flip_char 把它写进 tty1 这个端口的 flip buffer（一块临时缓冲，就是 kmalloc 出来的一小块内存）。" },
          { at: 5, say: '把 flush_to_ldisc 这个「待办小活」挂到系统的通用工作队列 system_unbound_wq 上，并叫醒一个 kworker 线程来干它（状态从睡眠 S 变成可运行 R）。' },
        ],
        /* 4 退出中断 */
        [
          { at: 0, sw: { preempt: '0', softirq: '无' }, say: 'irq_exit 收尾：把 preempt_count 里的 HARDIRQ 计数减回去（表示硬中断处理完了）；检查一圈发现没有等着处理的软中断。' },
          { at: 2, sw: { resched: 1 }, say: 'TIF_NEED_RESCHED 是任务结构里 thread_info.flags 的一个标志位，由任务结构保存。idle 任务随时可以被抢占，所以只要在本地把这位置 1 就行，本地置位即可请求重调度。' },
          { at: 3, fl: { IF: 1 }, r: { RSP: IDLE_SP, RIP: ['do_idle', '回到 hlt 后面的那条指令'] }, stk: { name: 'swapper/0 的栈', items: [] }, x: [['p.kstk', 'cpu', 'iretq 把中断帧弹回来', 'r.RSP']],
            say: 'iretq 把之前压栈的 RIP、CS、RFLAGS（IF 恢复成 1）、RSP、SS 依次弹回去，于是执行又回到了 hlt 后面的那条指令。idle 循环顺手检查 need_resched 标志：发现已经被置上了，于是退出「待命」循环，去跑调度。' },
          { at: 4, cpu: { task: 'kworker/u8:1' }, sw: { resched: 0 }, r: { RSP: ['kworker/u8:1 的内核栈', ''] }, stk: { name: 'kworker/u8:1 的内核栈', items: [] },
            say: '切换到 kworker 线程：只换了内核栈和那几个「被调用者负责保存」的寄存器（RBX、RBP、R12 到 R15）。CR3 不动：kworker 是内核线程，继续借着 sh 的页表用（懒切换），反正它只访问内核里的地址，用户那部分用不着。' },
        ],
        /* 5 n_tty 收字符并回显 */
        [
          { at: 4, mem: { 'p.slab': 'n_tty 读缓冲里有 c；写指针 read_head = 1' }, x: [['p.slab', 'cpu', '从临时缓冲取出 c', 'r.RAX'], ['cpu', 'p.slab', '读缓冲第 0 格放 c', 'r.RAX']],
            say: "n_tty_receive_char 处理这个字符：put_tty_queue 把 c 放进那个 4 KiB 的环形读缓冲，写指针 read_head 加 1；因为终端打开了 ECHO（回显）开关，echo_char 还会把它另外记进回显缓冲，好等下显示到屏幕上。" },
          { at: 7, vga: { out: 'c' }, va: [['v.direct', 'p.vga']], say: "回显的过程：con_write → do_con_write 把字符 c 连同颜色属性（0x63 0x07 两个字节）写进显存 0xB8000，于是屏幕上提示符后面就多出了一个 c。" },
        ],
        /* 6 其余字符，直到回车 */
        [
          { at: 0, vga: { out: 'at /etc/hostname' }, dev: { kbd: { key: '回车键（0x1c）', data: '—' } }, mem: { 'p.slab': 'n_tty read_buf："cat /etc/hostname\\n" · read_head = 18' },
            say: "剩下的 17 个键都重复走同一套流程——按下产生中断 → IRQ 1 信号 → i8042 读数据 → atkbd 翻译成按键 → VT 翻成字符 → 放进临时缓冲 → kworker 干活 → n_tty 收进读缓冲并回显；这里把它们合并成一步。另外要留意：每按一个键其实会产生两次中断（按下一次、松开一次，松开那次送的是 break 码，比如 0x9e、0xae），只不过松开不产生字符。最后是回车：它的 set 1 代码是 0x1c，VT 先把它翻成 '\\r'，n_tty 又依据终端设置里的一条转换规则（叫 ICRNL）把它变成 '\\n'（换行）。" },
          { at: 1, say: 'canon_head 和 read_head 都走到了 18：说明读缓冲里已经攒够完整的一行，可以交给等着的程序了。' },
          { at: 3, say: 'sh 之前在 tty 的 read_wait 等待队列上睡着，现在被叫醒：状态从 S（睡眠）变成 R（可运行）。' },
        ],
        /* 7 唤醒 sh */
        [
          { at: 2, mem: { 'p.slab': 'CPU0 运行队列的「红黑树」里多了 sh' } },
          { at: 4, sw: { resched: 1 }, say: '调度器用的算法叫 EEVDF，它比较后认为 sh 的「该轮到我的截止时间」更早，于是给正在跑的 kworker 置上 TIF_NEED_RESCHED 标志；等 kworker 把手头的活干完准备回去睡时，就会顺手切到 sh。' },
        ],
        /* 8 切到 sh */
        [
          { at: 0, sw: { resched: 0 } },
          { at: 3, say: '要切过去的目标（sh）恰好就是 CPU 当前还挂着的那个地址空间——因为刚才 idle 和 kworker 都在懒借用 sh 的页表，没换过。switch_mm_irqs_off 一看前后指的是同一个，就只对一下「TLB 代号」是否有效，满足地址空间和 TLB 代数条件时保留 CR3。如果切的是别的进程，这里就会写 CR3 = 新页表根 | PCID（给每个进程打个编号），并把这个值的第 63 位置 1，表示「保留了该编号的地址缓存，别刷掉」。' },
          { at: 4, cpu: { task: 'sh' }, r: { RSP: T.sh.ksp, FS: ['sh 的线程私有数据', 'musl 库拿它当「当前线程」的指针（TLS：线程自己的一小块私有数据）'] }, stk: { name: 'sh 的内核栈', items: ['wait_woken 的返回帧', '…', 'pt_regs（是 read 系统调用进来的那份现场）'] },
            say: '__switch_to_asm 把栈指针 RSP 换到 sh 的内核栈，并把那几个「被调用者负责保存」的寄存器恢复回来；__switch_to 负责写 FS 的基址（musl 这个库拿它当「当前线程的指针」用）。至于浮点/SSE 那些寄存器的状态，为了省事，推迟到真要返回用户态之前再恢复。' },
        ],
        /* 9 read 返回整行 */
        [
          { at: 2, fl: { AC: 1 }, va: [['v.data', 'p.anon']], mem: { 'p.anon': `sh 的缓冲 ${T.sh.buf} = "cat /etc/hostname\\n"` }, x: [['p.slab', 'cpu', '从读缓冲读出 18 字节', 'r.RAX'], ['cpu', 'p.anon', '把 18 字节拷进用户缓冲', 'fl.AC']],
            say: 'copy_to_user 干活：先 stac（把 AC 置 1，允许访问用户内存）→ 用 rep movsb 把 18 个字节搬进 sh 的缓冲 → 再 clac 关掉。如果目标页根本不存在或者不允许写，拷贝到一半就会触发 #PF；内核事先在「异常表」里登记了这种情况下该怎么补救，补救完返回 -EFAULT 告诉调用者「这地址不通」。' },
          { at: 3, ...RET(T.sh, '18', '这是 read 的返回值：一共读了 18 个字节'), say: '用 sysretq 返回用户态：把 RCX 里的值（进内核时保存的返回地址）装回 RIP，把 R11 里的值装回 RFLAGS，CS/SS 换成 MSR_STAR 指定的用户段，特权级从 0 回到 3。RAX 里留着 18，就是 read 的返回值。' },
          { at: 4, r: { RIP: ['busybox ash 解析命令', '在用户态里跑'] }, say: 'sh 回到用户态，开始解析刚才那一行命令，照着 PATH（命令搜索路径）逐一看，最后找到 /bin/cat 这个程序。' },
        ],
        /* 10 fork */
        [
          { at: 0, ...SYS(T.sh, 57, 'fork') },
          { at: 1, mem: { 'p.slab': '多了一块 task_struct（子进程，PID 231）', 'p.kstk': '多了一块 231 的内核栈' }, x: [['p.free', 'p.slab', '分配 task_struct'], ['p.free', 'p.kstk', '分配 16 KiB 内核栈']] },
          { at: 3, mem: { 'p.pgt': '多了 231 的页表根 PGD：内核那半是照抄来的' } },
          { at: 5, mem: { 'p.anon': 'sh 的栈和 .data 页：父子暂时共用，两边页表项都改成只读（这就是写时复制 COW）', 'p.pgt': '多了 231 的各层页表：页表项暂时都指向 sh 原来的那些页' }, x: [['cpu', 'p.pgt', '复制页表项，并把「可写」位清掉', 'c.CR3']],
            say: 'copy_page_range 一项一项复制页表：复制完，父子两边的页表项指向的是同一块物理页。对「本来是私有可写的页」，父子两边都要把页表项里的「可写」位（R/W）清掉——这样谁想写谁就先触发缺页，再由内核去复制；同时这一页的「被映射次数」加 1。注意父进程的页表项也被改成只读了，所以 fork 结束之前，必须把父进程那边的地址缓存（TLB）刷一下，不然它可能还拿着旧的「可写」印象。' },
          { at: 7, say: '子进程被放进运行队列，等着被调度。父进程 sh 这边，fork 返回的值是子进程的编号 231；它接着调用 wait4（等子进程结束）然后睡下。' },
        ],
        /* 11 COW 缺页 */
        [
          { at: 0, ...PF({ ...T.sh, name: '子进程(231)' }, '0x7ffd5c2a1ee8', '0x7', 'P=1 页在、W=1 写、U=1 用户态'), c: { CR2: ['0x7ffd5c2a1ee8', '出错的那个地址，正好在栈上'], CR3: ['0x7fd47000 | PCID 4', '子进程 231 的页表根'] },
            walk: { va: '0x7ffd5c2a1ee8', res: ['存在', '存在', '存在', '页在，但「可写」位是 0 → 触发 #PF'] },
            say: '父进程睡下之后，CPU 切到子进程（顺便把 CR3 换成子进程的页表根）。子进程要往自己的栈上写数据：MMU 一路查到最末级页表项，发现这一页确实在，但标着「只读」，于是产生 #PF。错误码是 0x7，拆开看是三个标记：页存在（P）、这是一次写（W）、发生在用户态（U）。' },
          { at: 2, fl: { IF: 1 } },
          { at: 5, mem: { 'p.anon': '多了子进程自己私有的栈页副本' }, walk: { va: '0x7ffd5c2a1ee8', res: ['存在', '存在', '存在', '页表项 → 指向新页，可写'] }, va: [['v.stack', 'p.anon']],
            x: [['p.free', 'cpu', '向伙伴系统要一页', 'r.RAX'], ['p.anon', 'cpu', '把原页 4 KiB 读出来', 'r.RAX'], ['cpu', 'p.anon', '把 4 KiB 写进副本', 'r.RAX']],
            say: '向伙伴系统要一页（order 0 就是单独一张 4 KiB 页），用 copy_user_highpage 把原来那 4 KiB 内容复制过来，然后把子进程这一条页表项改成指向新页、并标上可写，再用 invlpg 指令把这一项的地址缓存刷掉（否则 CPU 还记着旧的）。父进程那边的页表项这时仍是只读、仍指向原来那页；等父进程也要写时，内核一查发现它已经是这页唯一的使用者了，就直接把它改回可写，直接复用该页。' },
        ],
        /* 12 execve 路径查找 */
        [
          { at: 0, ...SYS({ ...T.sh, name: '子进程(231)' }, 59, 'execve', { RDI: ['"/bin/cat"', ''], RSI: ['argv', '["cat", "/etc/hostname"]'], RDX: ['envp', ''] }) },
          { at: 2, x: [['p.slab', 'cpu', '到目录项哈希表里查「bin」', 'r.RAX']], say: '路径查找过程中读到的，全都是内存池里的 dentry（目录项）：查的方式是拿「父目录的 dentry + 名字算出的哈希值」去 dentry_hashtable 里找。这种走法叫 RCU-walk，好处是全程不加锁、也不动引用计数，所以很快；代价是最后要用一个序列号核对一下，确认走的这一路期间没被人改过，改过就重来。' },
          { at: 4, say: '查到 cat 其实是一个指向 busybox 的「快捷方式」（符号链接），于是 step_into 顺着它跳进去，继续找真正的文件。' },
        ],
        /* 13 装载 ELF */
        [
          { at: 3, c: { CR3: ['0x7fd58000 | PCID 5', 'cat(231) 新地址空间的页表根'] }, vs: 'cat', cpu: { task: 'cat(231)' }, mem: { 'p.pgt': '多了 cat 的页表根；fork 时复制来的那套页表随旧地址空间一起释放' },
            say: 'exec_mmap 做的是：把当前任务的 mm（地址空间）换成新的，并把新页表根的地址写进 CR3；刚才 fork 复制来的那套旧地址空间，引用计数减一后释放掉（不过父进程 sh 还握着自己那一份，不受影响）。这个任务的 comm（也就是进程名）变成了 cat。' },
          { at: 4, say: 'vm_mmap 现在只登记 VMA（地址区间）：代码段从 0x400000 到 0x4cd000，权限可读可执行；数据段从 0x4ce000 到 0x4d3000，权限可读写；两段都指向 busybox 这个文件。此时页表项一条都还没建——真正的映射要等访问到才补。' },
          { at: 5, ...RET(T.cat, '0', '', ['0x401000 _start', 'iretq 之后就从这里开始执行新程序']), mem: { 'p.anon': '多了 cat 的新用户栈页（里面摆好了参数 "cat" 和 "/etc/hostname"）' }, x: [['cpu', 'p.anon', '把参数、环境变量等摆到用户栈上', 'r.RAX']],
            stk: { name: 'cat(231) 的用户栈（新）', items: ['argc = 2', 'argv[0] → "cat"', 'argv[1] → "/etc/hostname"', 'NULL', 'envp …', 'auxv …'] } },
        ],
        /* 14 代码页命中缓存 */
        [
          { at: 0, ...PF(T.cat, '0x401000', '0x14', 'U=1、I=1、P=0'), walk: { va: '0x401000', res: ['空 → #PF', '', '', ''] } },
          { at: 2, walk: { va: '0x401000', res: ['新建', '新建', '新建', '页表项 → 指向页缓存里的页（一次填 16 项）'] }, va: [['v.text', 'p.pc']], x: [['cpu', 'p.pgt', '一次填 16 条页表项', 'c.CR3']], fl: { IF: 1 },
            say: 'busybox 的代码页其实早就在页缓存里了（sh 此刻用的就是同一批物理页）。内核有个叫 fault-around 的优化：以 64 KiB 为窗口对齐，把窗口内「已经在缓存里、内容也完整」的页，一次性填进页表项（一次填 16 项）；这样后面执行到这些页就不会再缺页，整个过程直接复用缓存页完成映射。' },
        ],
        /* 15 openat */
        [
          { at: 0, ...RET(T.cat, '—', ''), ...SYS(T.cat, 257, 'openat', { RDI: ['-100', 'AT_FDCWD：以「当前目录」为起点'], RSI: ['"/etc/hostname"', '用户态那个字符串的地址'], RDX: ['O_RDONLY | O_LARGEFILE', 'O_RDONLY：只读打开'], R10: ['0', 'mode（这里用不上）'] }) },
          { at: 4, x: [['p.pc', 'cpu', '读 /etc 的目录内容块', 'r.RAX']], say: '/etc 这个目录的内容块早就在 vda 的页缓存里了（开机时读过一次）。内核在块里一条条往下扫那些目录条目（ext4_dir_entry_2），每条记着：文件的 inode 号、这条记录有多长、名字有多长、是什么类型、以及名字本身。' },
          { at: 5, mem: { 'p.slab': '多了一个目录项 dentry「hostname」，指向 inode 1534' }, x: [['cpu', 'p.slab', '把新目录项放进缓存', 'r.RDI']] },
          { at: 7, mem: { 'p.slab': '多了一个 file 对象（/etc/hostname），放进文件描述符 3' }, ...RET(T.cat, '3', 'openat 的返回值：打开后拿到的文件描述符 3') },
        ],
        /* 16 read：页缓存未命中 */
        [
          { at: 0, ...SYS(T.cat, 0, 'read', { RDI: ['3', 'fd 3，刚才打开的那个文件'], RSI: [T.cat.buf, '要装到哪个用户内存位置'], RDX: ['4096', '最多读 4096 字节'] }) },
          { at: 2, say: '去 hostname 这个 inode 的 address_space（也就是它那堆页缓存，用 xarray 组织）里查第 0 页：结果为缓存缺失。' },
          { at: 4, mem: { 'p.pc': '多了 hostname 的第 0 页（已上锁，内容还没就绪）' }, x: [['p.free', 'p.pc', '分配一页、上锁、插进页缓存表']] },
          { at: 6, say: 'ext4 的 extent 树（记录「文件的第几块在磁盘的哪里」）查出来：文件的逻辑块 0 对应磁盘的物理块 33410，长度 1 块。换算成扇区号（一个块 8 个扇区）：33410 × 8 = 267280。' },
          { at: 7, say: '拼出一个 bio（一次批量 I/O 请求）：起始扇区 bi_sector = 267280，长度 bi_size = 4096 字节，里面只有一个 bio_vec，指向刚才那一页所在的物理地址；等这次 I/O 完成，会回调 mpage_end_io 收尾。' },
        ],
        /* 17 virtio-blk 踢设备，cat 睡下 */
        [
          { at: 2, dev: { vq: { desc: '[0] 只读请求头（读，扇区 267280，16 字节）· [1] 4096 字节数据页（留给设备写）· [2] 1 字节状态', avail: 4 } }, x: [['cpu', 'p.vq', '填 3 个描述符，交办序号变成 4', 'r.RAX']],
            say: 'virtblk_add_req 用 3 段「分散聚集表」填出 3 个描述符：第一段是只读的请求头，第二段是留给设备写数据的那一页（也就是页缓存里那一页的物理地址），第三段是留给设备写状态的 1 个字节；填好后把链头放进 avail 环，等于告诉设备「有活了」。' },
          { at: 3, dev: { vq: { notify: '已敲门铃' } }, x: [['cpu', 'virtio', '写通知寄存器 → 虚拟机退出', 'r.RAX']], say: '驱动去写通知寄存器，「踢」设备一下表示有新任务；在这台虚拟机里，这次「把设备寄存器当内存写」的动作会让虚拟机退出（VM exit），控制权交给外面的 QEMU。' },
          { at: 4, dev: { disk: { op: '正在读物理块 33410' } }, mem: { 'p.pc': 'hostname 第 0 页：数据已经到了（还锁着等收尾）' }, x: [['virtio', 'p.vq', '取出描述符链'], ['disk', 'p.pc', '把块 33410 搬进内存（DMA）']],
            say: 'QEMU 从镜像文件里偏移 267280 × 512 字节处读出 4 KiB，直接写进客户机的这块物理内存（文件内容 "linux\\n" 后面没有的部分补成 0）。整趟搬运不经过 CPU0，它一点没出力。' },
          { at: 6, cpu: { task: 'swapper/0', hlt: true }, r: { RSP: IDLE_SP, RIP: ['pv_native_safe_halt', '先 sti 开中断，再 hlt 停下'] }, stk: { name: 'swapper/0 的栈', items: [] },
            say: 'cat 以 TASK_KILLABLE 状态（可以被打断的睡眠，但只响应致命信号）睡在这一页的等待队列上；运行队列空了，于是切到 idle，执行 hlt 停下。CR3 仍然懒挂着 cat 的页表，没去动它。' },
        ],
        /* 18 完成中断 */
        [
          { at: 0, dev: { vq: { used: 4, desc: '设备已经写好状态 0（成功）' }, apic: { irr: '0x24（待处理）' } }, x: [['virtio', 'p.vq', '写状态 0，完成序号变成 4'], ['virtio', 'apic', '按 MSI-X 往 0xFEE00000 写中断号']],
            say: 'MSI-X 这种中断方式很特别：不经过 IO-APIC，也不占用专门的中断线，而是设备直接往地址 0xFEE00000 做一次内存写，写进去的数据就是中断号。LAPIC 会截住这次写，把它记到 IRR（待办清单）里（中断号是示意值）。' },
          { at: 1, ...IRQ('0x24', 'pv_native_safe_halt+…', 'swapper/0 的栈'), say: 'CPU 从 hlt 里醒来，把中断帧压栈、把 IF 清 0，然后按 IDT 第 0x24 项进入 common_interrupt，把栈切到这颗 CPU 专用的硬中断栈。' },
          { at: 2, dev: { apic: { isr: '—（已应答）' } }, x: [['cpu', 'apic', '写 EOI 应答', 'r.RAX']], say: 'MSI 属于边沿式中断，所以一进来就应答，也就是写 LAPIC 的 EOI 寄存器。' },
          { at: 3, x: [['p.vq', 'cpu', '读 used 环，拿到链头 0、状态 0', 'r.RAX']], say: 'virtqueue_get_buf 从 used 环里取出那条完成记录：链头是描述符 0、还有这次实际写了多少字节；再看状态字节是 0，表示 VIRTIO_BLK_S_OK（一切顺利）。' },
          { at: 7, mem: { 'p.pc': 'hostname 第 0 页：内容是 "linux\\n"（已就绪、已解锁）' }, say: 'folio_end_read 用一个「要么一起成功、要么一起不算」的原子操作，同时做两件事：给这页打上「内容已就绪」标记、把「已上锁」标记清掉，然后叫醒所有在等这一页的任务。' },
          { at: 8, sw: { resched: 1 }, say: 'cat 的状态从 D（不可打断睡眠）变成 R（可运行），同时给 idle 置上 need_resched。中断返回之后，idle 一看该重新调度，就切给了 cat；因为 cat 的地址空间一直挂在 CPU 上没被换掉，所以这一步保留原 CR3。' },
        ],
        /* 19 拷到用户态，write 到终端 */
        [
          { at: 0, cpu: { task: 'cat(231)', hlt: false }, fl: { IF: 1, AC: 1 }, sw: { preempt: '0', resched: 0 }, r: { RSP: T.cat.ksp }, stk: { name: 'cat(231) 的内核栈', items: ['folio_wait_bit_common 的返回帧', '…', 'pt_regs（read 系统调用进来的现场）'] },
            va: [['v.direct', 'p.pc'], ['v.data', 'p.anon']], mem: { 'p.anon': `+ cat 的缓冲 ${T.cat.buf} = "linux\\n"` }, x: [['p.pc', 'cpu', '从页缓存读出 6 字节', 'r.RAX'], ['cpu', 'p.anon', '把 6 字节拷进用户缓冲', 'fl.AC']],
            say: 'copy_folio_to_iter 干活：源头是页缓存里的那一页（内核通过「直接映射」访问它），目标是 cat 的用户缓冲；先 stac 把 AC 打开（允许碰用户内存），再用 rep movsb 拷 6 个字节。' },
          { at: 1, ...RET(T.cat, '6', 'read 的返回值：读了 6 个字节'), ...SYS(T.cat, 1, 'write', { RDI: ['1', 'fd 1，也就是 tty1'], RSI: [T.cat.buf, '→ "linux\\n"'], RDX: ['6', '要写 6 个字节'] }), say: 'read 返回 6（用 sysretq 回到用户态），cat 拿到内容后立刻发出 write(1, buf, 6)：把 6 个字节写到文件描述符 1（也就是屏幕上）。' },
          { at: 2, fl: { AC: 1 }, x: [['p.anon', 'cpu', '从用户缓冲拷 6 字节进内核', 'fl.AC']] },
          { at: 3, fl: { AC: 0 } },
          { at: 4, say: "终端设置了 OPOST（输出后处理）搭配 ONLCR：输出时把换行 '\\n' 变成回车加换行 '\\r\\n'，这样光标才会先回到行首再换行。" },
          { at: 6, vga: { out: '\nlinux\n' }, va: [['v.direct', 'p.vga']] },
        ],
        /* 20 cat 退出 */
        [
          { at: 0, ...RET(T.cat, '6', 'write 的返回值：写了 6 个字节'), ...SYS(T.cat, 231, 'exit_group', { RDI: ['0', '退出码 0（表示正常结束）'] }) },
          { at: 1, mem: { 'p.anon': 'cat 的栈和数据页已经还给伙伴系统', 'p.pgt': 'cat 的 PT/PD/PDPT 这几层页表已经释放' }, x: [['cpu', 'p.pgt', '清掉页表项，拆掉页表', 'c.CR3'], ['p.anon', 'p.free', '把匿名页还回去']],
            say: 'unmap_vmas 把相关的页表项一条条清掉。匿名页（不对应文件的那些）一旦「被映射次数」归零，就还给伙伴系统；而文件页（busybox 的代码、hostname 的内容）只是把映射计数减一，本身仍留在页缓存里，下次还有人用。free_pgtables 负责把中间的 PT/PD/PDPT 那几层页表页释放掉。至于最顶层的 PGD，得等到最后一个引用也放掉才能释放——因为此刻 CPU 还挂着它呢。' },
          { at: 3, say: '给父进程 sh 发一个 SIGCHLD 信号（告诉它「有子进程结束了」）：在 sh 的待处理信号位图里把这一位置 1，并把它从 wait4 的睡眠里叫醒。' },
          { at: 4, cpu: { task: 'sh' }, c: { CR3: ['0x7fd23000 | PCID 3', 'sh 的页表根'] }, vs: 'sh', r: { RSP: T.sh.ksp }, stk: { name: 'sh 的内核栈', items: ['pt_regs（wait4 系统调用进来的现场）'] },
            say: '最后一次调度：切到 sh。这次必须写 CR3 了（换成 sh 的页表根）；因为 sh 的 PCID 3 那批地址缓存还在，就把 CR3 值的第 63 位置 1，表示「这批缓存还能用，先别刷」。cat 自己那份页表根，则在 finish_task_switch → mmdrop 的时候释放掉。' },
        ],
        /* 21 收尸，睡回 read */
        [
          { at: 2, x: [['cpu', 'p.anon', 'put_user：把退出状态写回用户内存（*wstatus = 0）', 'fl.AC']] },
          { at: 3, ...RET(T.sh, '231', 'wait4 的返回值：结束的那个子进程编号'), mem: { 'p.slab': 'task_struct(231) 要等一个 RCU 宽限期过去才会被释放' } },
          { at: 5, vga: { out: '# ' }, ...SYS(T.sh, 0, 'read', { RDI: ['0', 'fd 0，就是 tty1'], RSI: [T.sh.buf, '要装进哪个用户内存位置'], RDX: ['1023', '最多读 1023 字节'] }), say: 'sh 先把提示符 "# " 写出去（又走了一遍 tty → VT → 显存那条路，最后显示在屏幕上），然后调用 read(0) 等键盘输入：当前规范行仍在等待行结束符，shell 进入输入等待。' },
          { at: 6, cpu: { task: 'swapper/0', hlt: true }, r: { RSP: IDLE_SP, RIP: ['pv_native_safe_halt', '先 sti 开中断，再 hlt 停下'] }, stk: { name: 'swapper/0 的栈', items: [] }, x: [['cpu', 'apic', '写 TSC_DEADLINE 设闹钟', 'c.TSC_DEADLINE']] },
        ],
      ],

      tick: [
        /* 1 idle：停 tick，hlt */
        [
          { at: 1, say: '算了一下，下一个定时事件大概在 12 毫秒之后到（数值是示意），也就是说这期间不用麻烦 CPU 每个节拍都醒来，那只「周期心跳」可以停掉。' },
          { at: 2, r: { RCX: ['0x6e0', 'wrmsr 要求：ECX 里放 MSR 编号 IA32_TSC_DEADLINE'], RAX: ['截止时刻的低 32 位', ''], RDX: ['截止时刻的高 32 位', ''] }, c: { TSC_DEADLINE: ['TSC₀ + 12 ms', '一个绝对时间点（TSC 值）'] }, dev: { apic: { timer: 'TSC_DEADLINE = TSC₀ + 12 ms' } },
            x: [['cpu', 'apic', '把 EDX:EAX 写进 MSR 0x6E0', 'c.TSC_DEADLINE']], say: '这里用 wrmsr 指令写寄存器：ECX 里放要写哪个 MSR（编号 0x6E0），EDX:EAX 这两个拼起来放那个 64 位的「截止时刻」TSC 值。LAPIC 会一直拿当前的 TSC 和它比较，到了就触发一次本地定时中断。' },
          { at: 4, cpu: { hlt: true }, r: { RIP: ['pv_native_safe_halt', '先 sti 开中断，再 hlt 停下'] }, say: '执行 sti 再 hlt：先把 IF 置 1（允许中断），然后让 CPU 停下来省电，一直停到有中断来把它唤醒。' },
        ],
        /* 2 APIC 定时器到点 */
        [
          { at: 0, dev: { apic: { irr: '0xec（待处理）', timer: '时间到了' } }, say: 'TSC 一路数到了刚才设的那个截止值，本地 APIC 就自己产生了一个本地定时中断（编号 0xec）。这种中断不经过 IO-APIC，也不占用任何总线信号——纯粹是 CPU 内部自己的闹钟。' },
          { at: 1, ...IRQ('0xec', 'pv_native_safe_halt+…', 'swapper/0 的栈'), x: [['apic', 'cpu', '递交中断号 0xec', 'fl.IF'], ['cpu', 'p.kstk', '压入中断帧', 'r.RSP'], ['cpu', 'apic', '写 EOI 应答', 'r.RAX']], dev: { apic: { irr: '—', isr: '—（已应答）' } },
            say: '这是个「系统向量」：IDT 第 0xec 项直接指向 asm_sysvec_apic_timer_interrupt，不经过 irq_desc、也不走那套流控逻辑，图的就是快。CPU 把中断帧压栈、把 IF 清 0；处理函数一开头就调 apic_eoi() 写 EOI 表示「收下了」。' },
          { at: 3, c: { TSC_DEADLINE: ['下一个 hrtimer 的到期点', '处理完之后要重新设下一次闹钟'] }, x: [['cpu', 'apic', '写 TSC_DEADLINE 设下一次闹钟', 'c.TSC_DEADLINE']],
            say: 'hrtimer_interrupt 先读一下当前时间，然后把「高精度定时器」那棵红黑树里所有已经到点该执行的任务都跑一遍（这里到点的就是 tick 用的 sched_timer），最后算出下一个最近的到期时间，再写回 TSC_DEADLINE，等于重新上好下一次闹钟。' },
        ],
        /* 3 tick：jiffies 与记账 */
        [
          { at: 1, mem: { 'p.kern': 'jiffies_64 加到 4295012357（一次补了 12）· 时间管理模块也更新了' }, x: [['cpu', 'p.kern', '把 jiffies_64 加上 12', 'r.RAX']],
            say: 'jiffies 是内核数据段里的一个全局计数变量。刚才停掉周期心跳的那段时间里少了 12 个节拍，这里一次性补回去。不过要注意：内核眼里真正的时间是以 TSC 读数为准的（用 rdtsc 指令读），jiffies 只是个粗粒度的计数，用来做记账、超时判断之类。' },
          { at: 4, say: '从栈上保存的现场看，被打断的是 idle 任务（CS = 0x10 表示内核段，当前任务是 swapper/0），所以这 12 毫秒就记进「idle 时间」里，归入该 CPU 的空闲时间统计。' },
          { at: 5, sw: { softirq: 'TIMER（定时器）' }, say: '「定时器轮盘」上发现有到期的项，就在本 CPU 的待办软中断位图 __softirq_pending 里把 TIMER_SOFTIRQ 这一位置 1，先记下来，等硬中断退出时再统一处理。' },
        ],
        /* 4 RCU */
        [{ at: 2, sw: { softirq: 'TIMER | RCU（RCU 也到点了）' } }],
        /* 5 sched_tick */
        [
          { at: 0, say: '这一步是按「此刻正在跑一个吃 CPU 的任务」来讲的；不过本例里被打断的是 idle，而 sched_tick 一看是 idle 就走 idle 分支直接返回。' },
          { at: 5, sw: { softirq: 'TIMER | RCU | SCHED（调度也要记账）' } },
        ],
        /* 6 软中断 */
        [
          { at: 0, sw: { preempt: 'SOFTIRQ' }, say: 'irq_exit 收尾：先把 preempt_count 里的 HARDIRQ 计数减回去；一看待办位图含有待处理位，且处于允许执行软中断的上下文，于是把 SOFTIRQ 计数加上，转身进入软中断处理。' },
          { at: 1, fl: { IF: 1 }, sw: { softirq: '处理中：TIMER RCU SCHED' }, say: '先把待办位图整个读出来、顺手清零，然后调用 local_irq_enable 打开中断——也就是说，软中断执行期间是允许新的硬中断插进来的（毕竟这时人还在中断栈上）。接着按位号从小到大，依次调用 softirq_vec[] 里对应的处理函数。' },
        ],
        /* 7 RCU 回调 */
        [{ at: 2, mem: { 'p.slab': '释放掉：task_struct(cat)、file(/etc/hostname)、pid 结构' }, x: [['cpu', 'p.slab', '调用 kmem_cache_free 释放这三样', 'r.RAX']] }],
        /* 8 到期的延迟工作 */
        [{ at: 3, sw: { resched: 1 }, say: '把负责写回的 kworker 和日志线程 kjournald2 叫醒（状态从 S 变 R），同时给 idle 置上 need_resched，提醒它「待会儿该重新调度了」。' }],
        /* 9 返回：安全点上切换 */
        [
          { at: 0, sw: { preempt: '0', softirq: '无' }, fl: { IF: 1 }, r: { RSP: IDLE_SP }, stk: { name: 'swapper/0 的栈', items: [] }, x: [['p.kstk', 'cpu', 'iretq 把中断帧弹回来', 'r.RSP']],
            say: '这一步是按「被打断的是用户态任务」来讲的。不过本例打断的是 idle：iretq 回到 hlt 之后，是 do_idle 自己发现 need_resched 被置上了，才去跑调度。' },
          { at: 3, cpu: { task: 'kworker/u8:2（写回）' }, sw: { resched: 0 }, r: { RSP: ['kworker 的内核栈', ''] }, stk: { name: 'kworker/u8:2 的内核栈', items: [] }, say: '切换到负责写回的 kworker：它是内核线程，所以 继续借用当前 active_mm 的页表。' },
        ],
        /* 10 写回脏页 */
        [
          { at: 4, mem: { 'p.pc': '12 个「脏页」（内容改过还没写盘的页）进入回写状态' } },
          { at: 6, dev: { vq: { desc: '[0] 只读请求头（写，扇区 …）· [1..] 若干数据页（留给设备读）· [n] 状态字节', avail: 5, notify: '已敲门铃' } }, x: [['cpu', 'p.vq', '填描述符链', 'r.RAX'], ['cpu', 'virtio', '写门铃寄存器', 'r.RAX']] },
          { at: 7, dev: { vq: { used: 5 }, disk: { op: '正在写 12 页' } }, mem: { 'p.pc': '12 页已经写回磁盘（「回写中」标记等完成中断来处理）' }, x: [['p.pc', 'disk', '设备从内存读走 12 页（DMA）'], ['virtio', 'p.vq', '完成序号变成 5'], ['virtio', 'apic', '按 MSI-X 报完成']],
            say: '写盘方向的 DMA 正好反过来：设备从客户机内存里把数据读走，写进宿主机上的镜像文件。等完成中断到来时，end_page_writeback 会把这些页的「回写中」标记清掉，并唤醒在等它们的人。' },
        ],
        /* 11 jbd2 提交 */
        [
          { at: 0, cpu: { task: 'jbd2/vda-8' }, r: { RSP: ['jbd2/vda-8 的内核栈', ''] }, stk: { name: 'jbd2/vda-8 的内核栈', items: [] } },
          { at: 2, dev: { vq: { avail: 6, used: 6 }, disk: { op: '刷缓存 + 写日志块 + 写提交块（要求落盘）' } }, x: [['p.pc', 'disk', '把日志块和提交块写下去']],
            say: '这里用了两个标志：REQ_PREFLUSH 要求设备先把易失的写缓存刷到真正的介质上（virtio-blk 会因此发一条 VIRTIO_BLK_T_FLUSH 命令）；REQ_FUA 要求这一块必须确实落盘了才算完成。靠这两条，才能保证磁盘上的顺序一定是「先日志、后提交块」，万一中途断电，日志也不会自相矛盾。' },
        ],
        /* 12 kswapd（旁路） */
        [{ at: 3, mem: { 'p.free': '回收之后，空闲量回到了 high 水位以上' }, x: [['p.pc', 'p.free', '回收那些干净页']], say: '内存不太够时，内核会挑「最久没被用过」的那些页回收——具体是从 LRU 链表的末尾开始找。如果找到的是「干净的」页缓存页（内容没被改过），就从它所属的 address_space 里摘掉、把页表映射（如果有）清掉，这一页就直接还给伙伴系统，按干净页回收条件直接归还物理页。' }],
        /* 13 回到 idle */
        [
          { at: 0, cpu: { task: 'swapper/0' }, r: { RSP: IDLE_SP }, stk: { name: 'swapper/0 的栈', items: [] } },
          { at: 3, cpu: { hlt: true }, c: { TSC_DEADLINE: ['TSC + 约 4 s', '下一次写回定时器要醒的时刻'] }, dev: { apic: { timer: '闹钟设在约 4 秒后' } }, r: { RIP: ['pv_native_safe_halt', '先 sti 开中断，再 hlt 停下'] }, x: [['cpu', 'apic', '写 TSC_DEADLINE 设闹钟', 'c.TSC_DEADLINE']] },
        ],
      ],
    },
  }
  /* normalize: boot ops must have one entry per lesson step, and each `at` must index a real call of that step */
  const _stories = (window.KDATA && window.KDATA.stories) || []
  for (const st of _stories) {
    const ops = window.KMACHINE.ops[st.id]
    if (!ops) continue
    while (ops.length < st.steps.length) ops.push([])
    ops.length = st.steps.length
    st.steps.forEach((s, i) => {
      const max = Math.max(1, s.calls ? s.calls.length : 1)
      for (const op of ops[i] || []) if ((op.at ?? 0) >= max) op.at = max - 1
    })
  }
})()
