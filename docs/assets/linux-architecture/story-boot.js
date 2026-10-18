/* Story: power-on to the first shell prompt. */
(window.KDATA.stories ||= []).push({
  id: 'boot',
  title: '开机：从解压内核到 shell 睡在 read 上',
  short: '开机到提示符',
  intro: '开机时只有一颗 CPU 在工作。它先把压缩的内核解压出来，然后一层一层把基础设施立起来：内存怎么用、被打断了去哪儿处理、多个任务怎么轮流跑、文件和目录怎么表示。接着造出 1 号和 2 号任务，按重要程度把内核里各个子系统的初始化函数挨个调用一遍，让硬盘驱动和文件系统报到；然后挂上真正的磁盘根目录，把 1 号换成用户态的第一个程序（BusyBox 的 init，BusyBox 是嵌入式系统常用的一套小工具合集）。init 打开 tty1 作为控制终端，再启动一个 shell（命令行程序）；shell 打出提示符后就睡在"读取按键"这个动作上，CPU 也随之闲下来。到这里系统进入稳定待命状态。',
  steps: [
    {
      t: '第 0 小步：上电之前，内存里原本就有什么', ctx: 'boot', kind: 'boot',
      text: '主板固件芯片保存出厂写入的 BIOS 或 UEFI 程序，断电后仍保留内容。内存条依靠供电保存数据；上电瞬间的内容按随机初值表示，后续由固件和引导器逐步写入启动数据。',
      calls: [
        { f: 'firmware_rom', n: 'boot', note: '数据源：主板固件 ROM 中的 BIOS/UEFI 程序' },
      ],
      data: {
        '固件 ROM（BIOS/UEFI）': '出厂时写入，采用非易失存储，上电即可执行',
        '内存条': '上电瞬间内容随机，尚无可用数据',
        '中断向量表 IVT 与 BDA': '由固件在自检过程中写入，不是内核写的',
        'e820 内存地图': '由固件在初始化内存控制器后整理出来，之后交给内核',
      },
      dataNote: '数据来源按写入者区分：固件生成 IVT、BDA 和 e820，引导器装入 bzImage 并整理 boot_params，内核在第 11 小步读取内存地图',
      why: '画面按阶段展示数据的写入：这一帧的 RAM 是随机初值；固件自检和引导器交接分别在后续步骤展开。',
    },
    {
      t: '第 1 小步：固件自检，把中断向量表与 BDA 写进内存', ctx: 'boot', kind: 'boot',
      text: '固件先初始化内存控制器，让内存条能用起来，然后在最低端的内存地址（0 到 1 MiB 之间）写入两样东西：中断向量表 IVT（记录每个中断该跳到哪段代码，位于物理地址 0），以及 BIOS 数据区 BDA（记录串口、键盘缓冲等设备信息，位于 0x400 附近）。这些数据是固件写的，它们存在的时间比内核早得多。',
      calls: [
        { f: 'bios_init_memory', n: 'boot', note: '执行者：固件的内存初始化与自检程序' },
      ],
      data: {
        'IVT（物理地址 0x0）': '1 KiB，256 项，每项记录一个中断的跳转地址',
        'BDA（物理地址 0x400）': '约 256 字节，记录设备与内存等基础信息',
        '固件私有区': '固件把自己的代码与表格留在高位内存，内核不能覆盖',
      },
      dataNote: '本步展示固件写入的数据；第 2 小步单独展开 CPU 复位时的取指现场',
    },
    {
      t: '第 2 小步：CPU 上电复位，从固定地址 0xFFFFFFF0 取第一条指令', ctx: 'boot', kind: 'boot',
      text: 'CPU 上电后进入复位状态，寄存器取固定初值：CS 段基址为 0xFFFF0000，IP 为 0xFFF0，第一条指令取自物理地址 0xFFFFFFF0。该地址映射到主板固件 ROM，CPU 从这里执行固件入口；RAM 的使用要等固件完成内存控制器初始化。',
      calls: [
        { f: 'reset_vector', n: 'boot', note: '固件实现，复位向量位于固件 ROM 中' },
      ],
      data: { 'CS': '0xF000（基址 0xFFFF0000）', 'IP': '0xFFF0', '第一条指令地址': '0xFFFFFFF0', '此时的内存': '尚未初始化，不可用' },
      dataNote: '复位向量处的跳转把 CPU 带到固件自检入口；取指地址由复位时的 CS 段基址与 IP 相加得到',
    },
    {
      t: '第 3 小步：固件从 ROM 取指执行，并把控制权交给引导器', ctx: 'boot', kind: 'boot',
      text: '第 2 小步的复位向量只是一条跳转指令，它把 CPU 带到固件自检代码。固件随后完成内存控制器初始化，并从磁盘（或网络、U 盘）找到引导器（GRUB 或 UEFI 引导程序），把它读进内存，最后把控制权交给引导器。引导器读取 bzImage（压缩后的内核文件），并把命令行、内存地图等信息整理成 boot_params（一份交接单）放在内存里，然后跳到内核的压缩镜像入口。',
      calls: [
        { f: 'bios_post_and_load_bootloader', n: 'boot', note: '固件实现：自检、找引导器、交接控制权' },
      ],
      data: { '引导器': 'GRUB 或 UEFI 引导程序（从磁盘读入内存）', 'bzImage': '压缩后的内核文件', 'boot_params': '引导器写入的交接单（命令行、内存地图等）' },
      dataNote: 'boot_params 与 e820 都是后面内核需要读取的交接信息，它们是在内核运行之前就已经写进内存的',
    },
    {
      t: '第 4 小步：CPU 仍在 16 位实模式下运行，准备进入保护模式', ctx: 'boot', kind: 'boot',
      text: '在真正进入 32 位之前，CPU 仍处于复位后的 16 位实模式。固件与引导器需要先在内存里放好 GDT（全局描述符表，描述各段的范围与权限）和临时的段描述符，然后把 CR0 的保护模式开关位（PE）置位，CPU 才真正切换到 32 位保护模式。这一步是后面所有 32 位、64 位切换的前提。',
      calls: [
        { f: 'enter_protected_mode', n: 'boot', note: '设置 GDT，并置位 CR0 的 PE 位' },
      ],
      data: { CR0: 'PE 位 = 1（进入保护模式）', GDT: '全局描述符表（段的范围与权限）' },
      dataNote: 'CR0 是 CPU 的控制寄存器，PE 位是“保护模式使能”开关，置位后 CPU 才认识 32 位段与页表',
    },
    {
      t: '第 5 小步：CPU 先切到 32 位保护模式，准备一张临时地址表', ctx: 'boot', kind: 'boot',
      text: '压缩镜像的入口 `startup_32` 先由 CPU 以 32 位模式跑起来。它临时搭一张"地址对照表"（页表），让虚拟地址和物理地址一模一样（这叫恒等映射）。这样即使马上要换成 64 位模式，手边的指令和数据依然找得到。',
      calls: [
        { f: 'startup_32', n: 'boot', src: 'arch/x86/boot/compressed/head_64.S:startup_32', note: '压缩镜像入口：建恒等映射，进长模式' },
      ],
      data: { 'CR3': '指向临时页表（PML4）', '映射关系': '虚拟地址 = 物理地址' },
      dataNote: 'CR3 是 CPU 的一个控制寄存器，专门记录"页表放在内存哪儿"。补充：上电复位后 CPU 一直处于 16 位实模式，固件自检结束后交给压缩镜像，CPU 才通过这一步逐步切换到 32 位保护模式，之后才能切换到 64 位',
    },
    {
      t: '第 6 小步：把 CPU 切进 64 位长模式', ctx: 'boot', kind: 'boot',
      text: '64 位模式需要好几个条件同时满足：打开 PAE（一种让页表能覆盖更大地址的机制）、设置 EFER 寄存器里的 LME 位（告诉 CPU"我要用长模式"）、打开分页、再加载一个 64 位的代码段描述符。这些准备好之后，CPU 才真正切换到 64 位工作状态。',
      calls: [
        { f: 'startup_32（设置 CR4/EFER/CR0）', n: 'boot', src: 'arch/x86/boot/compressed/head_64.S:startup_32', note: '依次打开 PAE、LME、分页' },
      ],
      data: { CR4: 'PAE 位 = 1', EFER: 'LME 位 = 1（长模式使能）', CR0: 'PG 位 = 1（分页打开）' },
      dataNote: 'CR0、CR4、EFER 都是 CPU 的控制寄存器，每一位控制一项功能，它们的详细解释可以在页面里悬停查看',
    },
    {
      t: '第 7 小步：解压镜像，得到真正的内核本体', ctx: 'boot', kind: 'call',
      text: '现在 CPU 在 64 位模式下，`extract_kernel` 把压缩的内核解开，放到内存的一个新位置。解压完后，内核的本体 `vmlinux`（ELF 格式内核）就摊开在内存里了。如果内核需要挪位置，这里还会做一次"重定位"，把里面写死的地址修正过来。',
      calls: [
        { f: 'extract_kernel', n: 'boot', src: 'arch/x86/boot/compressed/misc.c:extract_kernel', note: '解压 vmlinux，处理重定位' },
      ],
      data: { 'vmlinux': { 格式: 'ELF64', 解压后大小: '约 30 MiB', 入口: 'startup_64' } },
      dataNote: '示意值，实际大小随内核配置变化',
    },
    {
      t: '第 8 小步：跳进真正的内核入口 startup_64', ctx: 'boot', kind: 'boot',
      text: '解压器把控制权交给 `startup_64`，这是真正的内核汇编入口。它先把栈指针设好，让 CPU 有地方存放函数返回地址和局部变量；然后换成内核自己长期使用的地址表，把临时那张表丢掉。',
      calls: [
        { f: 'startup_64', n: 'boot', src: 'arch/x86/kernel/head_64.S:startup_64', note: '真正内核的入口，切到内核页表' },
      ],
      data: { 'RSP（栈指针）': '指向启动期预留的栈', 'CR3': '切换到内核页表' },
      dataNote: 'RSP 是 CPU 的栈指针寄存器；CR3 前面已经介绍过',
    },
    {
      t: '第 9 小步：把 boot_params 拷贝到内核自己的地方', ctx: 'boot', kind: 'call',
      text: '进入 C 语言之前，`x86_64_start_kernel` 必须先把 `boot_params` 从引导器的临时位置复制到内核自己保存的变量里。否则后面的代码用到命令行和内存地图时，原来那块地方可能已经被覆盖。',
      calls: [
        { f: 'x86_64_start_kernel', n: 'boot', src: 'arch/x86/kernel/head64.c:x86_64_start_kernel', note: '复制 boot_params，进入 C 世界' },
      ],
      data: { '内核内部变量 boot_params': '保存了一份完整拷贝' },
    },
    {
      t: '第 10 小步：进入 start_kernel，内核的总入口', ctx: 'boot', kind: 'call',
      text: '`start_kernel` 是通用内核初始化入口，按依赖顺序调用架构初始化、内存管理、中断、时间与调度等子系统的初始化函数。',
      calls: [
        { f: 'start_kernel', n: 'boot', src: 'init/main.c:start_kernel', note: '通用内核初始化总入口' },
      ],
      data: { '阶段': '还没有调度器，还没有中断' },
    },
    {
      t: '第 11 小步：setup_arch 读取内存地图并登记可用内存', ctx: 'boot', kind: 'call',
      text: '`setup_arch` 是架构相关初始化的总入口。它读取固件生成、经引导器交接的 e820 内存地图，交给早期区间管理器 `memblock`。可用 RAM 登记到 memory，内核占用和固件保留的区间登记到 reserved，早期分配按这些区间记录筛选。',
      calls: [
        { f: 'setup_arch', n: 'boot', src: 'arch/x86/kernel/setup.c:setup_arch', note: '架构相关初始化，读 e820、ACPI' },
        { f: 'memblock_add', n: 'alloc', src: 'mm/memblock.c:memblock_add', note: '早期分配器登记可用区间' },
      ],
      data: { memblock: { memory: '可用区间', reserved: '内核映像、启动页表等' } },
    },
    {
      t: '第 12 小步：建立"直接映射"，让内核能访问全部物理内存', ctx: 'boot', kind: 'call',
      text: '内核需要随时访问任意一块物理内存。`setup_arch` 给全部物理内存建一段固定的"直接映射"区：虚拟地址减去一个固定偏移，就得到对应的物理地址。以后只要知道物理地址，套公式就能算出内核该用哪个虚拟地址去读写它。',
      calls: [
        { f: 'init_memory_mapping', n: 'alloc', src: 'arch/x86/mm/init.c:init_memory_mapping', note: '建立物理内存的直接映射' },
      ],
      data: { '直接映射基址': 'PAGE_OFFSET（物理地址 0 对应的虚拟地址）', '换算': '虚拟地址 = 物理地址 + PAGE_OFFSET' },
      dataNote: 'PAGE_OFFSET 是内核里的一个常量，表示直接映射区从哪个虚拟地址开始',
    },
    {
      t: '第 13 小步：mm_core_init 为每一个物理页建账本', ctx: 'boot', kind: 'call',
      text: '每个物理页（4 KiB 一块，是内存分配的最小单位）都需要一本"账本"，即 `struct page`，记录这一页归谁用、被引用几次、属于哪个内存域。`mm_core_init` 负责把这些账本全部建立起来，并把内存划分成若干"内存域"（zone），每个内存域按用途分开管理。',
      calls: [
        { f: 'mm_core_init', n: 'alloc', src: 'mm/mm_init.c:mm_core_init', note: '内存核心初始化' },
        { f: 'free_area_init', n: 'alloc', src: 'mm/mm_init.c:free_area_init', note: '划分内存域（zone）并建立 struct page' },
      ],
      data: { struct_page: { 大小: '约 64 字节 / 页', 作用: '记录这页的用途与引用计数' }, zone: ['DMA', 'DMA32', 'Normal'] },
      dataNote: '示意：每个物理页都有一份 struct page，内存越大，账本占的空间越多',
    },
    {
      t: '第 14 小步：伙伴系统接管剩下的空闲页', ctx: 'boot', kind: 'call',
      text: '`memblock_free_all` 把 memblock 中可移交的空闲页交给伙伴系统，保留区间继续由各自的用途持有。伙伴系统按 1、2、4、8…个连续页组成一块来分配和合并，尽量减少内存碎片。',
      calls: [
        { f: 'memblock_free_all', n: 'alloc', src: 'mm/memblock.c:memblock_free_all', note: '空闲页移交伙伴系统' },
        { f: 'buddy_init', n: 'alloc', src: 'mm/page_alloc.c:__free_pages_core', note: '按阶把空闲页挂进伙伴链表' },
      ],
      data: { 'zone_Normal.free_area[10]': '按阶（连续页数量）挂着空闲块', nr_free: '≈ 500000 页（示意）' },
      dataNote: '示意值：实际数字随内存大小变化',
      why: '分配器自己也要用内存，所以只能分两段走：先用 memblock 这个极简的区间登记本占住需要的地方；等账本都建好后，才把剩下的内存交给伙伴系统。',
    },
    {
      t: '第 15 小步：kmem_cache_init 搭起"小对象分配器"', ctx: 'boot', kind: 'call',
      text: '内核里大量的数据结构都很小（几十到几百字节），按整页分配太浪费。SLUB 是专门切小块的分配器：它先申请整页，再按对象大小切成很多小格子，用来快速分配 inode、进程结构体这类小对象。`kmem_cache_init` 负责搭好 SLUB 自己的地基。',
      calls: [
        { f: 'kmem_cache_init', n: 'alloc', src: 'mm/slub.c:kmem_cache_init', note: 'SLUB 自举：先造出管理自己的 cache' },
      ],
      data: { 'kmalloc-64': '专门切 64 字节的小对象池（示意）' },
      dataNote: 'kmalloc 是内核申请小块内存的函数，就是靠 SLUB 切出来的',
    },
    {
      t: '第 16 小步：trap_init 装好 CPU 异常的处理入口', ctx: 'boot', kind: 'call',
      text: 'CPU 遇到页表 present 位为 0 或权限冲突、除以零、非法指令等条件时触发对应异常。`trap_init` 往中断描述符表（IDT）填入异常入口，让 CPU 按向量转入处理代码。',
      calls: [
        { f: 'trap_init', n: 'exc', src: 'arch/x86/kernel/traps.c:trap_init', note: '异常门：#PF、#GP、#DE…' },
      ],
      data: { IDT: { '0x0e': '#PF（缺页）→ exc_page_fault', '0x00': '#DE（除零）', '0x0d': '#GP（一般保护错误）' } },
      dataNote: 'IDT 是 CPU 的"中断/异常跳转表"，每一项记录处理函数的地址',
    },
    {
      t: '第 17 小步：init_IRQ 准备外设中断的编号', ctx: 'boot', kind: 'call',
      text: '外设（键盘、磁盘、网卡）发来的打断叫中断，每个来源都有一个编号（IRQ）。`init_IRQ` 为这些编号准备好描述结构 `irq_desc`，记录每个中断由谁处理、现在处于什么状态。等设备真正使用时，就能找到对应的处理函数。',
      calls: [
        { f: 'init_IRQ', n: 'irq', src: 'arch/x86/kernel/irqinit.c:init_IRQ', note: '外设中断向量与 irq_desc' },
      ],
      data: { irq_desc: { 'irq 1': '键盘（i8042）', 'irq 14/15': 'IDE 磁盘（示意）' } },
      dataNote: '示意：实际编号由硬件和总线决定',
    },
    {
      t: '第 18 小步：RCU 与时钟框架登场', ctx: 'boot', kind: 'call',
      text: '`rcu_init` 建立每 CPU 的 RCU 数据，用读侧临界区和宽限期协调并发访问。`tick_init` 搭建周期 tick 框架；`init_timers` 建立普通定时器轮盘；`hrtimers_init` 建立高精度定时器；`softirq_init` 登记延后处理工作的软中断入口。',
      calls: [
        { f: 'rcu_init', n: 'rcu', src: 'kernel/rcu/tree.c:rcu_init', note: '每 CPU 的 RCU 数据' },
        { f: 'tick_init', n: 'time', src: 'kernel/time/tick-common.c:tick_init', note: 'tick 设备框架' },
        { f: 'init_timers', n: 'time', src: 'kernel/time/timer.c:init_timers', note: 'timer wheel，注册 TIMER_SOFTIRQ' },
        { f: 'hrtimers_init', n: 'time', src: 'kernel/time/hrtimer.c:hrtimers_init', note: '高精度定时器' },
        { f: 'softirq_init', n: 'softirq', src: 'kernel/softirq.c:softirq_init', note: '注册 TASKLET / HI 软中断' },
      ],
      data: { tick: '周期性心跳，默认每秒若干次', 'timer wheel': '按到期时间分桶的定时器' },
    },
    {
      t: '第 19 小步：sched_init 为每颗 CPU 准备"任务排队箱"', ctx: 'boot', kind: 'call',
      text: '调度器要决定"下一刻让谁跑"，每颗 CPU 都需要一个属于自己的排队箱，叫运行队列（runqueue）。`sched_init` 为所有可能的 CPU 建好这些队列，并把锁、计时字段都初始化好。',
      calls: [
        { f: 'sched_init', n: 'sched', src: 'kernel/sched/core.c:sched_init', note: '为每颗 CPU 建运行队列' },
      ],
      data: { 'rq[cpu0]': { 锁: '已初始化', 队列: '空' } },
      dataNote: '本帧展示刚初始化的空队列，后续由 init_idle 登记空闲任务',
    },
    {
      t: '第 20 小步：给 0 号 CPU 指定"没活干时的兜底任务"', ctx: 'boot', kind: 'call',
      text: '每颗 CPU 都需要一个"没人可跑时"的兜底任务，叫 idle（空闲任务）。`init_idle` 把当前正在启动的这个任务，登记为 0 号 CPU 的 idle，并让它成为这颗 CPU 当前正在跑的任务。之后 CPU 空闲时就会落到它身上。',
      calls: [
        { f: 'init_idle', n: 'sched', src: 'kernel/sched/core.c:init_idle', note: '把引导任务登记为 idle' },
      ],
      data: { 'rq[0].idle': '引导任务', 'rq[0].curr': '引导任务' },
      dataNote: '启动阶段 idle 和 curr 暂时是同一个任务，后面会分开',
    },
    {
      t: '第 21 小步：建好文件相关的两种缓存', ctx: 'boot', kind: 'call',
      text: '文件系统里有两样东西要频繁查找：一是"名字对应哪个对象"（目录项，dentry）；二是"文件本体的元数据"（inode）。内核专门建了缓存来存放它们，避免每次都去磁盘翻目录。',
      calls: [
        { f: 'vfs_caches_init', n: 'vfs', src: 'fs/dcache.c:vfs_caches_init', note: '创建 dentry、inode 等缓存' },
      ],
      data: { '缓存': ['dentry_cache', 'inode_cache'] },
    },
    {
      t: '第 22 小步：注册 rootfs，并挂上最简单的根', ctx: 'boot', kind: 'call',
      text: 'rootfs 是一个只存在于内存里的、最简单的文件系统，专门用来在真正的磁盘还没就绪时撑住"根目录"。`mnt_init` 把它挂上去，让内核先有一个可以放东西的根。之后真正的磁盘根会替换掉它。',
      calls: [
        { f: 'mnt_init', n: 'vfs', src: 'fs/namespace.c:mnt_init', note: '建立挂载树，挂上 rootfs' },
      ],
      data: { 挂载点: '/（rootfs，内存文件系统）' },
      dataNote: '这个 rootfs 与后面挂上的 ext4 根是两个不同的文件系统',
    },
    {
      t: '第 23 小步：rest_init 拆出 1 号和 2 号任务', ctx: 'boot', kind: 'call',
      text: '`rest_init` 是启动的"分岔口"。它创建 1 号任务（以后会变成用户态的 init，负责启动整个系统），并创建 2 号任务 kthreadd（内核线程的"管家"，以后要起内核后台线程都找它）。然后当前这个启动任务就转为 idle，永久待命。',
      calls: [
        { f: 'rest_init', n: 'sched', src: 'init/main.c:rest_init', note: '创建 PID1 与 kthreadd，之后自己转为 idle' },
        { f: 'kernel_init', n: 'sched', src: 'init/main.c:kernel_init', note: 'PID1 的入口函数' },
        { f: 'kthreadd', n: 'sched', src: 'kernel/kthread.c:kthreadd', note: 'PID2：内核线程管家' },
      ],
      data: { 'PID 1': 'kernel_init（之后变成用户 init）', 'PID 2': 'kthreadd' },
    },
    {
      t: '第 24 小步：1 号任务等 kthreadd 就绪，并启动其它 CPU', ctx: 'boot', kind: 'call',
      text: '1 号任务先等待 kthreadd 就绪，建立后续内核线程创建的依赖条件。然后唤醒其它 CPU 上线，并建立工人线程池供异步工作使用。',
      calls: [
        { f: 'kernel_init_freeable', n: 'sched', src: 'init/main.c:kernel_init_freeable', note: '1 号任务的初始化主体' },
        { f: 'smp_init', n: 'sched', src: 'kernel/smp.c:smp_init', note: '唤醒其它 CPU' },
        { f: 'workqueue_init', n: 'wq', src: 'kernel/workqueue.c:workqueue_init', note: '建立工人线程池' },
      ],
      data: { 'online CPU': '逐个上线（示意）' },
    },
    {
      t: '第 25 小步：do_initcalls 按级别调用各子系统的初始化函数', ctx: 'boot', kind: 'call',
      text: '驱动和子系统把初始化函数登记到 initcall 级别清单。内核按级别从早到晚调用，各子系统在自己的初始化函数中完成准备。',
      calls: [
        { f: 'do_initcalls', n: 'boot', src: 'init/main.c:do_initcalls', note: '按级别调用初始化函数' },
        { f: 'do_one_initcall', n: 'boot', src: 'init/main.c:do_one_initcall', note: '真正调用一个初始化函数并检查状态' },
      ],
      data: { 'initcall 级别': ['core', 'postcore', 'arch', 'subsys', 'fs', 'device', 'late'] },
      dataNote: '级别确定大体调用顺序；具体设备依赖由驱动和总线的探测机制处理',
    },
    {
      t: '第 26 小步：virtio 磁盘驱动登场，发现虚拟硬盘 vda', ctx: 'boot', kind: 'call',
      text: '虚拟磁盘驱动 `virtio_blk` 被登记到 virtio 总线上。总线一旦找到匹配的虚拟设备，就调用它的探测函数：双方协商能力，建好数据队列，然后向系统宣布"有一块叫 vda 的磁盘"。',
      calls: [
        { f: 'virtblk_probe', n: 'blk', src: 'drivers/block/virtio_blk.c:virtblk_probe', note: '探测虚拟磁盘并创建 gendisk' },
        { f: 'device_add_disk', n: 'blk', src: 'block/genhd.c:device_add_disk', note: '把磁盘对象发布给块层' },
      ],
      data: { 设备: '/dev/vda（示意）', 队列: 'virtqueue（驱动与设备共用）' },
      dataNote: 'virtqueue 是两边共享的一块描述符环，用来交换读写请求',
    },
    {
      t: '第 27 小步：登记 ext4，让内核认识这种文件系统', ctx: 'boot', kind: 'call',
      text: '内核把 ext4 的类型和操作入口登记到文件系统类型表，供后续挂载时选用。磁盘元数据读取在挂载流程中执行。',
      calls: [
        { f: 'register_filesystem', n: 'vfs', src: 'fs/filesystems.c:register_filesystem', note: '登记文件系统类型 ext4' },
      ],
      data: { 已登记类型: ['rootfs', 'ext4'] },
    },
    {
      t: '第 28 小步：键盘与终端的"接线"全部就位', ctx: 'boot', kind: 'call',
      text: '键盘要能把按键送到屏幕上，中间要经过好几层：i8042 是 PS/2 控制器，负责收字节；atkbd 是键盘协议，负责把字节变成按键；VT 是虚拟终端，负责把按键变成字符显示出来。这些接线在这一步一起建立。',
      calls: [
        { f: 'i8042_probe', n: 'input', src: 'drivers/input/serio/i8042.c:i8042_probe', note: '探测 PS/2 控制器，注册中断' },
        { f: 'atkbd_connect', n: 'input', src: 'drivers/input/keyboard/atkbd.c:atkbd_connect', note: '键盘协议绑定到串行端口' },
        { f: 'kbd_connect', n: 'input', src: 'drivers/tty/vt/keyboard.c:kbd_connect', note: '输入事件与虚拟终端连接' },
      ],
      data: { '数据路径': 'i8042 → atkbd → input → VT → tty' },
      dataNote: '这条路径就是后面按键故事的起点',
    },
    {
      t: '第 29 小步：把 /dev/console 装到 0、1、2 号文件描述符', ctx: 'boot', kind: 'call',
      text: '终端设备 /dev/console 被打开，然后它同时挂到进程的标准输入、标准输出、标准错误上（0、1、2 号描述符）。这样之后任何程序只要读写 0、1、2，就是在和这个终端说话。',
      calls: [
        { f: 'console_on_rootfs', n: 'tty', src: 'init/main.c:console_on_rootfs', note: '打开 /dev/console 并装到 fd 0/1/2' },
      ],
      data: { 'fd 0/1/2': '都指向同一个 /dev/console 的打开实例' },
      dataNote: '三个 fd 共同引用这一次打开的 /dev/console 实例',
    },
    {
      t: '第 30 小步：挂载真正的 ext4 根文件系统', ctx: 'boot', kind: 'call',
      text: '现在内核要把磁盘上的 ext4 挂成真正的根。它先读磁盘的"超级块"（文件系统的总说明书），检查格式对不对，并加载日志。这一步要等磁盘读完，所以 CPU 会先去跑别的任务。',
      calls: [
        { f: 'prepare_namespace', n: 'vfs', src: 'init/do_mounts.c:prepare_namespace', note: '准备并挂载根文件系统' },
        { f: 'ext4_fill_super', n: 'ext4', src: 'fs/ext4/super.c:ext4_fill_super', note: '读超级块，建立 ext4 实例' },
      ],
      data: { 'ext4 超级块': { 块大小: '4 KiB（示意）', 日志: '已加载' } },
      dataNote: '读盘期间 CPU 会去做别的事，读完后才继续挂载',
    },
    {
      t: '第 31 小步：磁盘读请求经过队列，最终落到虚拟设备', ctx: 'boot', kind: 'call',
      text: '读超级块这件事，要被包装成一个"读请求"，经过块层的队列，交给 virtio 驱动。驱动把请求写进共享队列，并"敲门铃"通知虚拟硬盘干活。请求完成后，设备再通过中断告诉 CPU。',
      calls: [
        { f: 'submit_bio', n: 'blk', src: 'block/blk-core.c:submit_bio', note: '把读请求交给块层' },
        { f: 'virtio_queue_rq', n: 'blk', src: 'drivers/block/virtio_blk.c:virtio_queue_rq', note: '请求写入 virtqueue' },
      ],
      data: { 请求: '读扇区（超级块所在位置）', 状态: '已提交，等待完成中断' },
    },
    {
      t: '第 32 小步：init 的可执行文件被装载进内存', ctx: 'boot', kind: 'call',
      text: '根文件系统挂好后，内核找到 `/sbin/init`，按 ELF 程序头建立文件段的 VMA。首次访问时，缺页路径从页缓存或磁盘取得数据，再补齐页表映射。',
      calls: [
        { f: 'kernel_execve', n: 'proc', src: 'fs/exec.c:kernel_execve', note: '在内核里发起"换成 init 程序"' },
        { f: 'load_elf_binary', n: 'proc', src: 'fs/binfmt_elf.c:load_elf_binary', note: '按 ELF 程序头建立映射' },
      ],
      data: { '/sbin/init': { 格式: 'ELF', 段: 'PT_LOAD（要装入内存的段）' } },
      dataNote: 'ELF 是可执行文件的标准格式，程序头告诉装载器各段放哪儿',
      why: 'exec 在现有 1 号任务中安装 init 的执行环境，保留 PID 1。',
    },
    {
      t: '第 33 小步：init 第一次访问代码，触发缺页补数据', ctx: 'boot', kind: 'call',
      text: 'init 首次取指时，代码页按需加载。CPU 页表遍历遇到 present 位为 0 就触发缺页；内核找到所属 VMA，从页缓存或磁盘取得代码页、安装映射，再返回重试同一条指令。',
      calls: [
        { f: 'exc_page_fault', n: 'exc', src: 'arch/x86/mm/fault.c:exc_page_fault', note: '缺页入口，读取出错地址' },
        { f: 'filemap_fault', n: 'mm', src: 'mm/filemap.c:filemap_fault', note: '从页缓存或磁盘取文件页' },
      ],
      data: { CR2: '保存出错的地址', 结果: '补好地址关系后重试' },
      dataNote: 'CR2 是 CPU 专门记录"哪个地址出错"的寄存器，前面已经介绍过',
    },
    {
      t: '第 34 小步：init 创建子进程，子进程准备好终端后换成 shell', ctx: 'boot', kind: 'call',
      text: 'init 先 fork 出一个子进程。子进程先"自立门户"（setsid），再打开 /dev/tty1 作为控制终端，然后把它装到 0、1、2 号描述符，最后执行 /bin/sh，变成命令行程序。父进程 init 则继续管理整个系统。',
      calls: [
        { f: 'copy_process', n: 'sched', src: 'kernel/fork.c:copy_process', note: 'fork：复制出子任务' },
        { f: 'tty_open_proc_set_tty', n: 'tty', src: 'drivers/tty/tty_jobctrl.c:tty_open_proc_set_tty', note: '子进程把 tty1 设为控制终端' },
      ],
      data: { 子进程: '换成 /bin/sh', 控制终端: '/dev/tty1' },
      dataNote: '控制终端决定键盘输入发给谁，所以子进程必须先把它设好',
    },
    {
      t: '第 35 小步：shell 打出提示符，然后睡在"等待按键"上', ctx: 'boot', kind: 'call',
      text: 'shell 输出提示符 `#` 后调用 read。规范行边界仍停在已消费位置，shell 登记读等待并睡眠，让出 CPU；运行队列随后选中 idle，CPU 等待键盘等中断。',
      calls: [
        { f: 'wait_woken', n: 'tty', src: 'drivers/tty/n_tty.c:n_tty_read', note: '读等待：睡下，等被叫醒' },
        { f: 'do_idle', n: 'sched', src: 'kernel/sched/idle.c:do_idle', note: '运行队列选中空闲任务，CPU 等待事件' },
      ],
      data: { 提示符: '#', 'shell 状态': '睡在 read 上', CPU: 'idle（hlt 等中断）' },
      dataNote: '至此开机完成：系统稳定待命，等待你敲下第一个键',
    },
  ],
})
