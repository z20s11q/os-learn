/* Deep dive data for the animation page: real source excerpts (text is cut from src/ at build time,
 * so line numbers always match the tree), per-line explanations, virtual-memory facts and the
 * user<->kernel switch flows. Every note key is a line number inside its range; anim.build.mjs checks that. */
(() => {
  const K = 'arch/x86/kernel/'
  window.KDEEP = {
    boot: [
      {
        title: '一、压缩镜像入口：栈、GS 与远返回进入内核代码段',
        why: '刚进入 startup_64 时 CPU 还在引导器留下的段与栈上，必须先把栈、GS（每 CPU 数据与栈保护 canary 的基址）和代码段选择子都换成内核自己的，之后才能跑 C 代码。',
        ranges: [
          { file: K + 'head_64.S', from: 60, to: 77, notes: {
            62: '把栈指向 __top_init_kernel_stack，verify_cpu 与后续 C 调用都需要有效的栈。',
            65: 'MSR_GS_BASE 的编号放入 %ecx，下一步的 wrmsr 写的就是它。',
            69: 'wrmsr 把 %edx:%eax 写入 GS 基址：之后 %gs:xx 访问的是 fixed_percpu_data。',
            71: '建立内核 GDT 与 IDT，此时才有合法的段描述符可用。',
            74: '把 __KERNEL_CS（内核代码段选择子）压栈，作为远返回的新 CS。',
            75: '把 .Lon_kernel_cs 的地址压栈，作为远返回的新 RIP。',
            77: 'lretq 从栈上弹出 RIP 与 CS，真正切到内核代码段。这是长模式里的“远跳转”。',
          } },
        ],
      },
      {
        title: '二、切到内核页表 early_top_pgt',
        why: '引导阶段的页表只是临时的恒等映射。切换到 early_top_pgt 后，地址翻译来自内核自己维护的页表，但恒等映射仍保留，所以当前执行的指令在换表期间保持有效。',
        ranges: [
          { file: K + 'head_64.S', from: 122, to: 126, notes: {
            126: '把 early_top_pgt 的物理地址写入 CR3。CR3 变化后，之后所有访存都经过这套页表翻译。',
          } },
        ],
      },
      {
        title: '三、间接调用 x86_64_start_kernel，进入 C 世界',
        why: 'initial_code 是一个存放函数指针的数据项，汇编通过它间接调用 C 入口；C 函数里才能使用 boot_params 等结构。',
        ranges: [
          { file: K + 'head_64.S', from: 411, to: 413, notes: {
            413: '间接调用 initial_code 指向的函数，正常情况下它就是 x86_64_start_kernel。',
          } },
          { file: K + 'head_64.S', from: 474, to: 474, notes: {
            474: 'initial_code 的初值：指向 x86_64_start_kernel，这是汇编与 C 的交接点。',
          } },
          { file: K + 'head64.c', from: 484, to: 488, notes: {
            486: '把早期高半部映射拷进 init_top_pgt[511]：内核代码与数据的高半部映射由此进入最终页表。',
            488: '调用 x86_64_start_reservations，继续做 C 层面的早期初始化。',
          } },
        ],
      },
      {
        title: 'start_kernel 与 rest_init：通用初始化与 1 号、2 号进程',
        why: 'start_kernel 是与架构无关的总入口，先关中断再逐步初始化；rest_init 之后把 1 号、2 号进程拉起，当前上下文退化为 idle。',
        ranges: [
          { file: 'init/main.c', from: 874, to: 896, notes: {
            874: 'start_kernel：通用内核初始化的总入口，由 x86_64_start_reservations 之后的路径进入。',
            886: '先关本地中断：初始化期间屏蔽可屏蔽外部中断。',
            896: 'setup_arch 读取 e820 内存图、建立直接映射，这是内存管理的起点。',
          } },
          { file: 'init/main.c', from: 673, to: 684, notes: {
            673: 'rest_init：启动的后半段，负责创建 1 号与 2 号进程。',
            684: 'user_mode_thread(kernel_init) 创建 PID 1，之后它会 exec 成用户态的 init。',
          } },
          { file: 'init/main.c', from: 697, to: 697, notes: {
            697: 'kernel_thread(kthreadd) 创建 PID 2，所有内核线程都由它派生。',
          } },
          { file: 'init/main.c', from: 717, to: 719, notes: {
            719: '当前上下文进入 cpu_startup_entry，永久成为 idle 循环。',
          } },
        ],
      },
    ],
    memory: {
      note: '下面的数字取自 x86-64 四级页表的默认配置（4 KiB 页，47 位虚拟地址）。直接映射的基址可由 KASLR 随机化，这里用默认值演示。',
      ranges: [
        { file: 'arch/x86/include/asm/page_64_types.h', from: 42, to: 42, notes: { 42: '直接映射（direct map）的基址 page_offset_base 默认值：物理内存整体线性映射到这里。' } },
        { file: 'arch/x86/include/asm/page_64_types.h', from: 50, to: 50, notes: { 50: '内核镜像的虚拟基址 __START_KERNEL_map，内核代码所在的高 2 GiB。' } },
      ],
      regions: [
        { name: '用户空间', range: '0x0000000000000000 – 0x00007fffffffffff', who: '每个进程各自一份（由各自的 CR3 指向）', color: '#4cc597' },
        { name: '非规范地址空洞', range: '0x0000800000000000 – 0xffff7fffffffffff', who: 'CPU 拒绝此地址访问并产生 #GP', color: '#3a4542' },
        { name: '直接映射 page_offset_base', range: '0xffff888000000000 起', who: '所有进程共享的内核高半部；物理地址 pa 对应 va = base + pa', color: '#5aa7e0' },
        { name: 'vmalloc / vmemmap 区', range: '内核高半部中段', who: 'vmalloc 连续虚拟地址；vmemmap 是 struct page 数组', color: '#e3c26b' },
        { name: '内核镜像 __START_KERNEL_map', range: '0xffffffff80000000 起', who: '内核 .text/.data，物理加载到 16 MiB 时 va = 0xffffffff81000000', color: '#e07a5a' },
      ],
      physical: [
        { name: '实存 0 – 1 MiB', desc: '实模式向量、BIOS 与早期数据，按固件保留区和早期资源的生命周期管理' },
        { name: '实存 1 MiB – 16 MiB', desc: '内核的 bzImage 解压区与早期缓冲，之后交给 memblock / 伙伴系统' },
        { name: '实存 16 MiB 起', desc: '解压后的 vmlinux 镜像，之后是 struct page 与各类动态分配的页' },
      ],
      rules: [
        '直接映射：va = page_offset_base + pa，内核按此公式计算直接映射虚拟地址，CPU 再按页表翻译，内核的 kmalloc 和 alloc_pages 返回的就是这类地址。',
        '内核镜像映射：va = __START_KERNEL_map + pa，因此镜像的虚拟地址与物理加载地址相差一个固定偏移。',
        '用户地址：每个进程的低半部映射不同；内核高半部在所有进程页表中相同（见 head64.c:486 的拷贝），本演示的 PTI 关闭配置复用内核高半部映射。',
        '页表遍历：虚拟地址的第 47 到 12 位切成 4 段 9 位索引（PML4、PDPT、PD、PT），最后 12 位是页内偏移。',
      ],
    },
    regs: {
      intro: '这四个寄存器决定 CPU 的工作模式：CR0 控制保护模式与分页，CR4 打开扩展特性，EFER 管理长模式与 syscall，RFLAGS 保存运算结果与中断、方向等状态。下面每一项列出位含义，以及 boot 和内核初始化中真实的设置代码。',
      items: [
        {
          name: 'CR0', full: 'Control Register 0（控制寄存器 0）',
          role: '全局工作模式开关。PE 决定是否处于保护模式，PG 决定是否开启分页（地址翻译），WP 决定内核能否写只读页，NE、AM、MP、EM、TS 控制浮点与对齐相关异常。CR0 控制分页模式，页表根地址由 CR3 指定。',
          bits: [
            [0, 'PE', '保护模式使能，引导器跳入内核时已为 1'],
            [1, 'MP', '监控协处理器，与 TS 配合决定 wait 是否触发 #NM'],
            [2, 'EM', 'x87 仿真，有 FPU 的机器上为 0'],
            [3, 'TS', '任务已切换，置 1 时首次使用 FPU 触发 #NM，现代内核基本为 0'],
            [4, 'ET', '扩展类型，现代 CPU 恒为 1'],
            [5, 'NE', 'x87 错误以 #MF 异常原生报告'],
            [16, 'WP', '1 时内核写只读页也触发 #PF，写时复制依赖它'],
            [18, 'AM', '允许 RFLAGS.AC 生效的对齐检查'],
            [29, 'NW', '非写透，与 CD 配合控制缓存，正常为 0'],
            [30, 'CD', '禁用缓存，正常为 0'],
            [31, 'PG', '分页使能：置 1 后所有地址经 CR3 翻译'],
          ],
          boot: [
            { file: K + 'head_64.S', from: 399, to: 401, notes: {
              399: '把 CR0_STATE（PE、MP、ET、NE、WP、AM、PG 的组合）装入 %eax。',
              401: '写入 CR0。此时 PG 已由压缩阶段置位，写入后 WP、NE、AM 等位才在内核中生效。',
            } },
          ],
          effect: 'PE 与 PG：开启分页后，CPU 每次访存都经 CR3 指向的页表翻译（见虚存分区）。WP：写时复制（fork 后父子共享只读页）依赖它，关闭则内核可直接改只读页。syscall 与中断：入口和返回路径保持 CR0 原值。缺页：PG 与 WP 决定哪些访问会触发 #PF。',
        },
        {
          name: 'CR4', full: 'Control Register 4（控制寄存器 4）',
          role: '打开各种扩展特性的开关。PAE 是长模式的前提，PGE 控制全局页，PCIDE 让 TLB 按进程区分，SMEP、SMAP 限制内核访问用户内存，FSGSBASE、OSXSAVE 用于指令扩展。内核在 cr4_init 中统一写入它。',
          bits: [
            [4, 'PSE', '页大小扩展，长模式下大页由页表项的 PS 位决定'],
            [5, 'PAE', '物理地址扩展，页表项扩为 64 位，长模式必需'],
            [6, 'MCE', '机器检查异常使能'],
            [7, 'PGE', '全局页，内核映射写 CR3 时保留在 TLB 中'],
            [9, 'OSFXSR', '操作系统支持 FXSAVE 与 SSE'],
            [10, 'OSXMMEXCPT', 'SSE 浮点异常以 #XM 报告'],
            [11, 'UMIP', '用户态执行 sgdt、sidt 等触发 #GP'],
            [12, 'LA57', '5 级页表，本演示按 4 级走读，因此为 0'],
            [16, 'FSGSBASE', '允许直接读写 FS、GS 基址'],
            [17, 'PCIDE', 'CR3 低 12 位作为 PCID，切换进程时 TLB 可按 PCID 保留'],
            [18, 'OSXSAVE', '允许 XSAVE、XRSTOR，保存 AVX 等扩展状态'],
            [20, 'SMEP', '内核态取指落在用户页上即 #PF'],
            [21, 'SMAP', '内核态读写用户页即 #PF，除非 RFLAGS.AC=1'],
          ],
          boot: [
            { file: K + 'head_64.S', from: 201, to: 201, notes: {
              201: '把 PAE 与 LA57 装入掩码 %edx，之后 CR4 只保留这些位。PGE 故意不在掩码中，以便刷新全局页。',
            } },
            { file: K + 'head_64.S', from: 215, to: 217, notes: {
              216: 'btsl 置 PSE，长模式虽然忽略它，也要在所有 CPU 上保持一致。',
              217: '写入 CR4，此时 PAE 仍为 1。',
            } },
            { file: K + 'head_64.S', from: 221, to: 223, notes: {
              222: 'btsl 置 PGE，重新启用全局页。',
              223: '再次写入 CR4，全局映射生效。',
            } },
            { file: 'arch/x86/boot/compressed/head_64.S', from: 168, to: 171, notes: {
              170: 'orl 置 PAE：长模式要求页表项为 64 位。',
              171: '写回 CR4。这是 CR4 在引导过程中第一次被置位的地方（压缩阶段）。',
            } },
            { file: 'arch/x86/kernel/cpu/common.c', from: 366, to: 369, notes: {
              368: 'cr4_set_bits 置 SMEP，内核执行用户页即触发 #PF。',
            } },
            { file: 'arch/x86/kernel/cpu/common.c', from: 377, to: 380, notes: {
              379: 'cr4_set_bits 置 SMAP，内核读写用户页即触发 #PF（除非 AC 置位）。',
            } },
            { file: 'arch/x86/kernel/cpu/common.c', from: 474, to: 481, notes: {
              479: '若 CPU 支持 PCID，置位 CR4.PCIDE。',
            } },
          ],
          effect: 'PAE 与 PGE：决定页表格式与全局 TLB 的行为，是地址翻译的基础。PCIDE：写 CR3 切换进程时，TLB 表项按 PCID 区分并按有效性条件保留。SMEP、SMAP：系统调用与缺页路径中，内核访问用户指针若违规会触发 #PF。UMIP：限制用户态读取内核描述符表。LA57：本演示未启用，仍是 4 级页表（47 位虚拟地址）。',
        },
        {
          name: 'EFER', full: 'Extended Feature Enable Register（扩展功能使能寄存器，MSR 0xC0000080）',
          role: 'EFER 是模型专用寄存器（MSR），用 rdmsr、wrmsr 访问。LME 与 LMA 决定是否进入长模式，SCE 允许 syscall 与 sysret，NXE 允许页表项的 NX 位生效。',
          bits: [
            [0, 'SCE', '允许 syscall、sysret 指令，为 0 时执行 syscall 会 #UD'],
            [8, 'LME', '长模式使能：软件置 1，真正进入长模式还要求 CR0.PG=1'],
            [10, 'LMA', '长模式激活：只读，LME 与 PG 同时为 1 时由 CPU 置位'],
            [11, 'NXE', '页表项第 63 位 NX 生效，标记 NX 的页上取指触发 #PF'],
            [12, 'SVME', '允许 AMD SVM 虚拟化扩展'],
          ],
          boot: [
            { file: K + 'head_64.S', from: 379, to: 389, notes: {
              379: 'ecx 装入 MSR_EFER（0xC0000080），后面的 rdmsr、wrmsr 都用它。',
              386: 'btsl 置 SCE，允许 syscall 与 sysret。',
              389: 'btsl 置 NX，仅当 CPU 支持 NX（%edi 第 20 位）时执行。',
            } },
            { file: 'arch/x86/boot/compressed/head_64.S', from: 239, to: 242, notes: {
              241: 'btsl 置 LME，压缩阶段进入长模式前设置。',
              242: 'wrmsr 写回 EFER。此时 LME=1，但要等 PG 置位后 LMA 才会变为 1。',
            } },
          ],
          effect: 'syscall：入口由 MSR_LSTAR 指定，SCE=0 时 syscall 指令非法。长模式：LME 与 PG 共同决定 LMA，CPU 才以 64 位模式运行。NX：页表项的 NX 位只有 NXE=1 时生效，取指违规以 #PF 报告。',
        },
        {
          name: 'RFLAGS', full: 'Flags Register（标志寄存器，64 位）',
          role: '保存运算结果标志（CF、ZF、SF、OF 等），也保存控制 CPU 行为的系统标志（IF 中断允许、DF 串方向、AC 对齐检查、IOPL 等）。bit 1 恒为 1。中断与 syscall 会改变它：进入中断门时 CPU 清 IF，syscall 时按 MSR_SYSCALL_MASK 清掉一组位。',
          bits: [
            [0, 'CF', '无符号运算的进位或借位'],
            [2, 'PF', '结果低 8 位中 1 的个数为偶数时置 1'],
            [6, 'ZF', '运算结果为 0'],
            [7, 'SF', '运算结果的符号位'],
            [8, 'TF', '单步陷阱，每条指令后产生 #DB'],
            [9, 'IF', '允许响应可屏蔽中断，经中断门进入时 CPU 清 0'],
            [10, 'DF', '串指令方向，调用约定要求为 0'],
            [11, 'OF', '有符号运算溢出'],
            [12, 'IOPL', 'I/O 特权级（占 2 位）'],
            [14, 'NT', '嵌套任务标志，64 位模式下应保持 0'],
            [16, 'RF', '恢复标志，抑制断点重复触发'],
            [18, 'AC', '对齐检查；SMAP 下 stac 置 1 才允许内核访问用户页'],
            [21, 'ID', '是否允许使用 CPUID 指令的标志'],
          ],
          boot: [
            { file: K + 'head_64.S', from: 403, to: 405, notes: {
              404: 'pushq $0 把 0 压栈。',
              405: 'popfq 把 0 弹入 RFLAGS，清零所有标志（包括 IF、DF、AC），此时 rsp 已经设好。',
            } },
            { file: 'arch/x86/kernel/cpu/common.c', from: 2146, to: 2151, notes: {
              2146: 'wrmsrl 写 MSR_SYSCALL_MASK（0xC0000084），syscall 时 CPU 会按这里的掩码清掉对应位。',
              2151: 'AC 与 ID 在掩码中：syscall 进入内核时它们被清零。',
            } },
          ],
          effect: 'syscall：CPU 把旧 RFLAGS 存入 R11，再执行 RFLAGS 与 ~MSR_SYSCALL_MASK，因此内核入口处 IF、DF、AC 等被清掉，可屏蔽外部中断保持屏蔽状态；sysretq 从 R11 恢复 RFLAGS。中断：进入中断门时 CPU 清 IF，iretq 恢复原值。缺页：异常压栈时保存出错现场的 RFLAGS，AC 决定 SMAP 下能否访问用户页。',
        },
      ],
    },
    walkSamples: [
      { label: '内核代码', va: '0xffffffff81000000' },
      { label: '直接映射', va: '0xffff888000001234' },
      { label: '用户栈', va: '0x00007ffd12345678' },
    ],
    switching: [
      {
        name: '系统调用：用户态 → 内核态 → 用户态',
        steps: [
          { ring: 3, cr3: '进程 A 的 pgd', rsp: '用户栈', gs: '用户 GS', what: '用户程序执行 syscall 指令。CPU 从 MSR_LSTAR 取出入口地址，由硬件按 LSTAR 指定的入口转移控制。', src: 'arch/x86/entry/entry_64.S:entry_SYSCALL_64', lines: { file: 'arch/x86/entry/entry_64.S', from: 87, to: 91, notes: { 87: 'entry_SYSCALL_64：syscall 指令跳入的入口，由 MSR_LSTAR 指定。', 91: 'swapgs：把 GS 从用户值换成内核的 per-CPU 基址，之后才能访问内核数据。' } } },
          { ring: 0, cr3: '进程 A 的 pgd（PTI 开启时换成内核页表）', rsp: '用户栈，尚未切换', gs: '内核 per-CPU', what: 'SWITCH_TO_KERNEL_CR3 在开启页表隔离（PTI）时切换 CR3；随后把 RSP 换成内核栈顶。', src: 'arch/x86/entry/entry_64.S:entry_SYSCALL_64' },
          { ring: 0, cr3: '内核页表', rsp: '内核栈', gs: '内核 per-CPU', what: '在内核栈上手工压入 pt_regs：保存 SS、RSP、RFLAGS、CS、RIP 与通用寄存器，并清零寄存器防止信息泄露。', src: 'arch/x86/entry/calling.h:PUSH_AND_CLEAR_REGS', lines: { file: 'arch/x86/entry/entry_64.S', from: 105, to: 109, notes: { 109: '调用 PUSH_AND_CLEAR_REGS 宏（定义在 arch/x86/entry/calling.h:127）：把用户现场保存进内核栈上的 pt_regs，并清空寄存器。' } } },
          { ring: 0, cr3: '内核页表', rsp: '内核栈', gs: '内核 per-CPU', what: 'call do_syscall_64 进入 C 代码，按系统调用号查表执行具体实现。', src: 'arch/x86/entry/common.c:do_syscall_64' },
          { ring: 0, cr3: '内核页表', rsp: '内核栈', gs: '内核 per-CPU', what: '返回路径：若满足条件则用 sysretq 快速返回，否则走 iretq 慢路径。', src: 'arch/x86/entry/entry_64.S:sysretq', lines: { file: 'arch/x86/entry/entry_64.S', from: 158, to: 166, notes: { 158: 'SWITCH_TO_USER_CR3_STACK：返回前切回用户页表（PTI 时）。', 164: 'swapgs：GS 切回用户值。', 166: 'sysretq：恢复 RIP 与 RFLAGS，CPU 回到 ring 3。' } } },
          { ring: 3, cr3: '进程 A 的 pgd', rsp: '用户栈', gs: '用户 GS', what: '用户程序从 syscall 的下一条指令继续执行，返回值在 %rax 中。', src: '' },
        ],
      },
      {
        name: '缺页：用户访问未映射地址 → 内核补页 → 回到用户态重试',
        steps: [
          { ring: 3, cr3: '进程 A 的 pgd', rsp: '用户栈', gs: '用户 GS', what: '用户程序访问一个 PTE 不存在的地址。硬件查页表失败，触发 #PF（向量 14）。', src: '' },
          { ring: 0, cr3: '进程 A 的 pgd', rsp: '内核栈（由 TSS.RSP0 提供）', gs: '内核 per-CPU', what: 'CPU 把错误码和 RIP 压入内核栈，并把出错地址写入 CR2，然后经中断门进入 exc_page_fault。', src: 'arch/x86/mm/fault.c:exc_page_fault', lines: { file: 'arch/x86/mm/fault.c', from: 1486, to: 1493, notes: { 1488: 'exc_page_fault：#PF 的 IDT 入口。', 1493: 'read_cr2 读取出错的虚拟地址。' } } },
          { ring: 0, cr3: '进程 A 的 pgd', rsp: '内核栈', gs: '内核 per-CPU', what: 'do_user_addr_fault 判断是用户地址还是内核地址，并找到所属的 VMA。', src: 'arch/x86/mm/fault.c:do_user_addr_fault', lines: { file: 'arch/x86/mm/fault.c', from: 1479, to: 1479, notes: { 1479: 'exc_page_fault 按地址是否属于内核空间分派：用户地址在这里调用 do_user_addr_fault。' } } },
          { ring: 0, cr3: '进程 A 的 pgd', rsp: '内核栈', gs: '内核 per-CPU', what: 'handle_mm_fault 为该地址分配物理页、填写 PTE（匿名页清零，文件页从页缓存读取）。', src: 'mm/memory.c:handle_mm_fault', lines: { file: 'arch/x86/mm/fault.c', from: 1387, to: 1387, notes: { 1387: '在 fault.c 中调用 handle_mm_fault，真正建立映射的通用函数定义于 mm/memory.c:6070，由它完成分配与填表。' } } },
          { ring: 3, cr3: '进程 A 的 pgd（PTE 已填好）', rsp: '用户栈', gs: '用户 GS', what: '异常返回后，CPU 重新执行出错的那条指令，这次翻译成功。', src: '' },
        ],
      },
    ],
  }
})()
