/**
 * 启动主线分镜：每个 op 是一条指令或一行 C 代码。
 * 数值来自 QEMU 8.2.10 + GDB 实测停点（panorama-data.js 的 recordedFrames）、
 * 实测串口 dmesg / /proc/iomem，以及构建产物的符号表；未实测的中间值按指令语义推出。
 */

const L = 'src/linux-6.12.112/';
const SB = 'artifacts/build/qemu-source/roms/seabios/src/';

/** 代码片段：from/to 按“压缩空白后的子串”匹配源文件中的行（含两端）。 */
export const CODE_REFS = {
  'sb-reset': { file: SB + 'romlayout.S', from: 'ORG 0xfff0 // Power-up Entry Point', to: 'ljmpw $SEG_BIOS, $entry_post', lang: '汇编' },
  'sb-entry': { file: SB + 'romlayout.S', from: 'entry_post:', to: 'ENTRY_INTO32 _cfunc32flat_handle_post', lang: '汇编' },
  'sb-trans32': { file: SB + 'romlayout.S', from: 'transition32:', to: 'jmpl *%edx', lang: '汇编' },
  'sb-trans16': { file: SB + 'romlayout.S', from: 'transition16:', to: 'jmpl *%edx', lang: '汇编' },
  'sb-dopost': { file: SB + 'post.c', from: 'dopost(void)', to: 'reloc_preinit(maininit, NULL);', lang: 'C' },
  'sb-iface': { file: SB + 'post.c', from: 'interface_init(void)', to: 'mouse_init();', lang: 'C' },
  'sb-ivt': { file: SB + 'post.c', from: 'ivt_init(void)', to: 'SET_IVT(0x40, FUNC16(entry_40));', lang: 'C' },
  'sb-main': { file: SB + 'post.c', from: 'maininit(void)', to: 'startBoot();', lang: 'C' },
  'sb-cdrom': { file: SB + 'boot.c', from: 'boot_cdrom(struct drive_s *drive)', to: 'call_boot_entry(SEGOFF(bootseg, bootip), bootdrv);', lang: 'C' },
  'sb-cdread': { file: SB + 'cdrom.c', from: '// Read the Boot Record Volume Descriptor', to: 'dop.buf_fl = MAKE_FLATPTR(boot_segment, 0);', lang: 'C' },
  'sb-callboot': { file: SB + 'boot.c', from: 'call_boot_entry(struct segoff_s bootsegip, u8 bootdrv)', to: 'farcall16(&br);', lang: 'C' },
  'grub-cfg': { file: 'labs/linux-x86_64/grub.cfg', from: 'set timeout=0', to: 'initrd16 /boot/initramfs.cpio.gz', lang: '配置' },
  'lx-header': { file: L + 'arch/x86/boot/header.S', from: 'start_of_setup:', to: 'calll	main', lang: '汇编' },
  'lx-main': { file: L + 'arch/x86/boot/main.c', from: 'void main(void)', to: 'go_to_protected_mode();', lang: 'C' },
  'lx-e820': { file: L + 'arch/x86/boot/memory.c', from: 'static void detect_memory_e820(void)', to: 'intcall(0x15, &ireg, &oreg);', lang: 'C' },
  'lx-gopm': { file: L + 'arch/x86/boot/pm.c', from: 'void go_to_protected_mode(void)', to: '(u32)&boot_params + (ds() << 4));', lang: 'C' },
  'lx-gdt': { file: L + 'arch/x86/boot/pm.c', from: 'static void setup_gdt(void)', to: 'asm volatile("lgdtl %0" : : "m" (gdt));', lang: 'C' },
  'lx-pmjump': { file: L + 'arch/x86/boot/pmjump.S', from: 'SYM_FUNC_START_NOALIGN(protected_mode_jump)', to: 'SYM_FUNC_END(.Lin_pm32)', lang: '汇编' },
  'lx-startup32': { file: L + 'arch/x86/boot/compressed/head_64.S', from: 'SYM_FUNC_START(startup_32)', to: 'SYM_FUNC_END(startup_32)', lang: '汇编' },
  'lx-startup64z': { file: L + 'arch/x86/boot/compressed/head_64.S', from: 'SYM_CODE_START(startup_64)', to: 'SYM_FUNC_END(.Lrelocated)', lang: '汇编' },
  'lx-extract': { file: L + 'arch/x86/boot/compressed/misc.c', from: 'debug_putstr("\\nDecompressing Linux... ");', to: 'return output + entry_offset;', lang: 'C' },
  'lx-head64': { file: L + 'arch/x86/kernel/head_64.S', from: 'SYM_CODE_START_NOALIGN(startup_64)', to: 'SYM_CODE_END(startup_64)', lang: '汇编' },
  'lx-common64': { file: L + 'arch/x86/kernel/head_64.S', from: 'SYM_INNER_LABEL(common_startup_64, SYM_L_LOCAL)', to: 'SYM_CODE_END(secondary_startup_64)', lang: '汇编' },
  'lx-head64c': { file: L + 'arch/x86/kernel/head64.c', from: 'cr4_init_shadow();', to: 'copy_bootdata(__va(real_mode_data));', lang: 'C' },
  'lx-startk': { file: L + 'init/main.c', from: 'void start_kernel(void)', to: 'rest_init();', lang: 'C' },
  'lx-rest': { file: L + 'init/main.c', from: 'static noinline void __ref __noreturn rest_init(void)', to: 'cpu_startup_entry(CPUHP_ONLINE);', lang: 'C' },
  'lx-kinitf': { file: L + 'init/main.c', from: 'static void __init do_basic_setup(void)', to: 'do_initcalls();', lang: 'C' },
  'lx-initramfs': { file: L + 'init/initramfs.c', from: 'static int __init populate_rootfs(void)', to: 'rootfs_initcall(populate_rootfs);', lang: 'C' },
  'lx-kinit': { file: L + 'init/main.c', from: 'static int __ref kernel_init(void *unused)', to: 'ramdisk_execute_command, ret);', lang: 'C' },
  'lx-syscall': { file: L + 'arch/x86/entry/entry_64.S', from: 'SYM_CODE_START(entry_SYSCALL_64)', to: 'call	do_syscall_64', lang: '汇编' },
  'ix-init': { file: 'artifacts/build/initramfs/init', from: '#!/bin/sh', to: 'exec /bin/switch_root /newroot /sbin/init', lang: '脚本' },
  'lx-ext2': { file: L + 'fs/ext2/super.c', from: 'if (!(bh = sb_bread(sb, logic_sb_block))) {', to: 'if (sb->s_magic != EXT2_SUPER_MAGIC)', lang: 'C' },
  'rf-inittab': { file: 'artifacts/build/rootfs/etc/inittab', from: '::sysinit:/etc/rcS', to: '::shutdown:/bin/sync', lang: '配置' },
  'rf-rcs': { file: 'artifacts/build/rootfs/etc/rcS', from: 'mount -t proc proc /proc 2>/dev/null', to: "printf 'Try: cat /data/hello.txt; lab-read; lab-memory; lab-cow\\n\\n'", lang: '脚本' },
  'lx-idle': { file: L + 'arch/x86/kernel/process.c', from: 'void __cpuidle default_idle(void)', to: 'raw_safe_halt();', lang: 'C' },
  'lx-8250': { file: L + 'drivers/tty/serial/8250/8250_port.c', from: 'void serial8250_read_char(struct uart_8250_port *up, u16 lsr)', to: 'ch = serial_in(up, UART_RX);', lang: 'C' },
  'lx-ntty': { file: L + 'drivers/tty/n_tty.c', from: 'static void n_tty_receive_char(struct tty_struct *tty, u8 c)', to: 'put_tty_queue(c, ldata);', toNth: 2, lang: 'C' },
  'pr-asm': { file: 'docs/animation/boot/primer.asm', from: '; 演示程序（不是开机代码）', to: 'ret                  ; C3', lang: '汇编' },
  'sb-irq08': { file: SB + 'clock.c', from: '// INT 08h System Timer ISR Entry Point', to: 'pic_eoi1();', lang: 'C' },
  'lx-ctxsw': { file: L + 'kernel/sched/core.c', from: 'context_switch(struct rq *rq, struct task_struct *prev,', to: 'return finish_task_switch(prev);', lang: 'C' },
  'lx-swasm': { file: L + 'arch/x86/entry/entry_64.S', from: 'SYM_FUNC_START(__switch_to_asm)', to: 'jmp	__switch_to', lang: '汇编' },
  'lx-loadcr3': { file: L + 'arch/x86/mm/tlb.c', from: 'static void load_new_mm_cr3(pgd_t *pgdir, u16 new_asid, unsigned long lam,', to: 'write_cr3(new_mm_cr3);', lang: 'C' },
  'lx-pgdctor': { file: L + 'arch/x86/mm/pgtable.c', from: 'static void pgd_ctor(struct mm_struct *mm, pgd_t *pgd)', to: 'KERNEL_PGD_PTRS);', lang: 'C' },
  'lx-execmmap': { file: L + 'fs/exec.c', from: 'static int exec_mmap(struct mm_struct *mm)', to: 'activate_mm(active_mm, mm);', lang: 'C' },
  'lx-pf': { file: L + 'arch/x86/mm/fault.c', from: 'DEFINE_IDTENTRY_RAW_ERRORCODE(exc_page_fault)', to: 'handle_page_fault(regs, error_code, address);', lang: 'C' },
  'lx-cow': { file: L + 'mm/memory.c', from: 'static __always_inline void __copy_present_ptes(struct vm_area_struct *dst_vma,', to: 'pte = pte_wrprotect(pte);', lang: 'C' },
  'lx-npoll': { file: L + 'drivers/tty/n_tty.c', from: 'static __poll_t n_tty_poll(struct tty_struct *tty, struct file *file,', to: 'mask |= EPOLLIN | EPOLLRDNORM;', lang: 'C' },
};

/** 物理内存区域：start/end 为物理地址。 */
const R = {
  romTop: { start: 0xfffc0000, end: 0x100000000, label: 'BIOS 芯片（ROM）', kind: 'rom' },
  ram: { start: 0x0, end: 0x20000000, label: 'RAM 512 MB（内容未初始化）', kind: 'blank', base: true },
  romLow: { start: 0xf0000, end: 0x100000, label: 'BIOS 程序（ROM 映射）', kind: 'rom' },
  vga: { start: 0xa0000, end: 0xc0000, label: '显存（屏幕文字）', kind: 'vga' },
  vrom: { start: 0xc0000, end: 0xc9a00, label: '显卡 BIOS', kind: 'rom' },
  ivt: { start: 0x0, end: 0x400, label: '中断向量表 IVT', kind: 'bios' },
  bda: { start: 0x400, end: 0x500, label: 'BIOS 数据区 BDA', kind: 'bios' },
  boot: { start: 0x7c00, end: 0x8400, label: '引导程序（来自光盘）', kind: 'boot' },
  grub: { start: 0x8400, end: 0x90000, label: 'GRUB 程序', kind: 'grub' },
  setup: { start: 0x90000, end: 0x9a000, label: 'Linux setup + 启动参数', kind: 'setup' },
  zkernel: { start: 0x100000, end: 0x72d400, label: '压缩的内核（6.2 MB）', kind: 'zkernel' },
  initrd: { start: 0x1fcba000, end: 0x1fe43000, label: 'initramfs（1.5 MB）', kind: 'initrd' },
  reloc: { start: 0x20aa000, end: 0x26d7400, label: '搬移后的压缩内核', kind: 'zkernel' },
  pt0: { start: 0x26f1000, end: 0x26f7000, label: '临时页表', kind: 'pt' },
  kcode: { start: 0x1000000, end: 0x1a00000, label: '内核代码', kind: 'kcode' },
  krodata: { start: 0x1a00000, end: 0x1d60000, label: '内核只读数据', kind: 'kdata' },
  kdata: { start: 0x1e00000, end: 0x2016000, label: '内核数据', kind: 'kdata' },
  kinit: { start: 0x2016000, end: 0x2290000, label: '启动专用（用完释放）', kind: 'kinit' },
  kbss: { start: 0x2290000, end: 0x2426000, label: '内核 BSS（全局变量）', kind: 'kbss' },
  kernel: { start: 0x1000000, end: 0x2426000, label: '解压出的内核', kind: 'kcode' },
  pcode: { start: 0x10000, end: 0x10019, label: '演示程序（25 字节）', kind: 'boot' },
  pdata: { start: 0x20000, end: 0x20020, label: '数据', kind: 'kdata' },
  pstack: { start: 0x30000, end: 0x30100, label: '栈（256 字节）', kind: 'user' },
  pivt: { start: 0x0, end: 0x400, label: '中断向量表 IVT（1 KB）', kind: 'bios' },
  pbios: { start: 0xf0000, end: 0x100000, label: 'BIOS 程序', kind: 'rom' },
  free: { start: 0x3000000, end: 0x1fcba000, label: '空闲内存页（伙伴分配器）', kind: 'free' },
  proc: { start: 0x3000000, end: 0x3400000, label: '进程的内存与页表', kind: 'user' },
  files: { start: 0x3400000, end: 0x3600000, label: '内存里的文件（rootfs）', kind: 'initrd' },
};
const MB = 0x100000;
const reg = (id, extra = {}) => ({ id, ...R[id], ...extra });

/** 虚拟地址映射（分页开启后）：v0..v1 → p0。 */
const V = {
  ident: { v0: 0x0n, v1: 0x100000000n, p0: 0x0, label: '恒等映射：虚拟 = 物理', kind: 'ident' },
  ktext: { v0: 0xffffffff81000000n, v1: 0xffffffff82426000n, p0: 0x1000000, label: '内核映像 0xFFFFFFFF81000000', kind: 'kcode' },
  direct: { v0: 0xffff888000000000n, v1: 0xffff888020000000n, p0: 0x0, label: '直接映射：全部物理内存', kind: 'direct' },
  utext: { v0: 0x400000n, v1: 0x6a0000n, p0: 0x3000000, label: '用户程序代码（busybox）', kind: 'user', p1: 0x3200000 },
  ustack: { v0: 0x7ffffffde000n, v1: 0x7ffffffff000n, p0: 0x3200000, label: '用户栈', kind: 'user', p1: 0x3400000 },
};
const map = (id, extra = {}) => ({ id, ...V[id], ...extra });

const E820 = [
  ['0x00000000 – 0x0009FBFF', '可用 RAM（约 639 KB）'],
  ['0x0009FC00 – 0x0009FFFF', '保留'],
  ['0x000F0000 – 0x000FFFFF', '保留（BIOS）'],
  ['0x00100000 – 0x1FFDCFFF', '可用 RAM（约 511 MB）'],
  ['0x1FFDD000 – 0x1FFFFFFF', '保留（ACPI 表）'],
  ['0xFFFC0000 – 0xFFFFFFFF', '保留（BIOS 芯片）'],
];

const tasks = rows => ({ kind: 'table', title: '进程（任务）列表', head: ['PID', '名字', '状态'], rows });

/** 每章：id、标题、ops。 */
export const ACTS = [
  {
    id: 'intro', title: '认识零件',
    ops: [
      { say: '这是一台刚接上电源、还没开机的电脑。我们一步一步看 Linux 是怎么跑起来的', spot: ['cpu', 'mem', 'code', 'dev'] },
      { say: '左边是 CPU（中央处理器）：它只会做一件事，按顺序一条一条执行指令', spot: ['cpu'] },
      { say: 'CPU 里有一排“寄存器”：每个格子存一个数，CPU 只能直接计算格子里的数', spot: ['regs'] },
      { say: '中间是内存：一长排格子，每格 1 字节，每格都有编号，这个编号叫“地址”', spot: ['mem'] },
      { say: '内存图从下往上地址越来越大；开分页以后，左边还会出现“虚拟地址”', spot: ['mem'] },
      { say: '右上是 CPU 此刻正在执行的源代码：汇编或 C 语言，亮着的一行就是当前这一步', spot: ['code'] },
      { say: '右下是光盘、磁盘和屏幕。操作系统的文件都在盘里，执行结果显示在屏幕上', spot: ['dev'] },
    ],
  },
  {
    id: 'primer', title: 'CPU 怎么执行程序（演示）',
    ops: [
      {
        say: '开机之前，先用一个 25 字节的小程序，看懂 CPU 是怎么干活的。这只是演示，不是开机代码',
        tts: '开机之前，先用一个 25 字节的小程序，看懂 CPU 是怎么干活的。这只是演示，不是开机代码',
        reset: true, mode: 'real', view: [0x0, 0x40000],
        set: { rax: '0x0', rbx: '0x0', rcx: '0x0', rdx: '0x0', rsi: '0x0', rdi: '0x0', rbp: '0x0', rsp: '0x100', rip: '0x0', if: 1 },
        seg: { cs: ['0x1000', '0x10000'], ds: ['0x0', '0x0'], ss: ['0x3000', '0x30000'], es: ['0x0', '0x0'] },
        mem: [reg('pivt'), reg('pcode'), reg('pdata'), reg('pstack'), reg('pbios')],
        poke: [[0x10000, 'B8 00 20 8E D8 A1 10 00 05 05 00 A3 12 00 50 E8 04 00 5B F4 EB EA 01 C0 C3'], [0x20010, '07 00'], [0x20, 'A5 FE 00 F0']],
        code: 'pr-asm', line: '; 演示程序（不是开机代码）', spot: ['cpu', 'mem', 'code'],
      },
      {
        say: '内存里放了三样东西：程序（0x10000）、数据（0x20000）、栈（0x30000）。最底下是中断向量表',
        hit: ['mem.pcode', 'mem.pdata', 'mem.pstack', 'mem.pivt'],
      },
      {
        say: '为什么要有段寄存器？16 位寄存器最大只能数到 65535，也就是 64 KB，可内存有 1 MB',
        focus: {
          kind: 'table', title: '为什么要有段寄存器', head: ['问题', '答案'], rows: [
            ['寄存器只有 16 位', '最多表示 0 – 0xFFFF（64 KB）'],
            ['地址线有 20 根', '能访问 0 – 0xFFFFF（1 MB）'],
            ['怎么凑出 20 位？', '地址 = 段 × 16 + 偏移'],
            ['例子', '0x1000 × 16 + 0x0005 = 0x10005'],
          ],
        },
        hit: ['seg.cs', 'seg.ds', 'seg.ss'],
      },
      {
        say: '所以 CPU 有专门的段寄存器：CS 管代码在哪，DS 管数据在哪，SS 管栈在哪。每个都乘 16 当作起点',
        hit: ['seg.cs', 'seg.ds', 'seg.ss'], focus: {
          kind: 'table', title: '三个段寄存器', head: ['寄存器', '值', '× 16 = 起点', '管什么'], rows: [
            ['CS', '0x1000', '0x10000', '代码：配合 IP 找指令'],
            ['DS', '0x0000', '0x00000', '数据：马上会改'],
            ['SS', '0x3000', '0x30000', '栈：配合 SP 找栈顶'],
          ],
        },
      },
      {
        say: '取指令第 1 步：算地址。CS × 16 + IP = 0x10000 + 0 = 0x10000',
        tts: '取指令第 1 步：算地址。CS 乘 16，再加 IP',
        view: [0x10000, 0x10020], unit: 'agu', hit: ['seg.cs', 'reg.rip', 'fetch'],
        focus: { kind: 'cycle', title: 'CPU 的工作循环（一直重复）', at: 0 },
      },
      {
        say: '第 2 步：从 0x10000 读出指令的字节 B8 00 20',
        code: 'pr-asm', line: 'mov  ax, 0x2000', hl: [0x10000, 3],
        flow: [{ from: 'addr:0x10000', to: 'insn', label: 'B8 00 20' }],
        focus: { kind: 'cycle', title: 'CPU 的工作循环（一直重复）', at: 1 },
      },
      {
        say: '第 3 步：看懂它。B8 的意思是“把后面两个字节放进 AX”，00 20 表示 0x2000（低字节在前）',
        code: 'pr-asm', line: 'mov  ax, 0x2000', insn: 'mov ax, 0x2000', mean: 'AX ← 0x2000', hl: [0x10000, 3],
        focus: { kind: 'cycle', title: 'CPU 的工作循环（一直重复）', at: 2 },
      },
      {
        say: '第 4 步：执行，AX = 0x2000。同时 IP 加上这条指令的长度 3，指向下一条',
        code: 'pr-asm', line: 'mov  ax, 0x2000', insn: 'mov ax, 0x2000', mean: 'AX ← 0x2000，IP ← 0 + 3',
        set: { rax: '0x2000', rip: '0x3' }, flow: [{ from: 'insn', to: 'reg.rax', label: '0x2000' }], hl: [0x10003, 2],
        focus: { kind: 'cycle', title: 'CPU 的工作循环（一直重复）', at: 3 },
      },
      {
        say: '然后又从第 1 步开始：取 0x10003 处的 8E D8，把 AX 复制进 DS。段寄存器不能直接写数字',
        code: 'pr-asm', line: 'mov  ds, ax', insn: 'mov ds, ax', mean: 'DS ← AX = 0x2000，数据段起点变成 0x20000',
        set: { rip: '0x5' }, seg: { ds: ['0x2000', '0x20000'] }, hl: [0x10003, 2],
        flow: [{ from: 'addr:0x10003', to: 'insn', label: '8E D8' }, { from: 'reg.rax', to: 'seg.ds', label: '0x2000' }],
      },
      {
        say: '读内存：数据地址 = DS × 16 + 0x10 = 0x20010。代码用 CS，数据用 DS，互不干扰',
        tts: '读内存：数据地址等于 DS 乘 16，再加 0x10。代码用 CS，数据用 DS，互不干扰',
        code: 'pr-asm', line: 'mov  ax, [0x0010]', insn: 'mov ax, [0x0010]', mean: 'AX ← 内存 DS:0010 处的 2 个字节',
        view: [0x20000, 0x20020], unit: 'agu', hl: [0x20010, 2], hit: ['seg.ds'],
      },
      {
        say: '从 0x20010 读出 07 00，也就是 7，放进 AX',
        code: 'pr-asm', line: 'mov  ax, [0x0010]', insn: 'mov ax, [0x0010]', mean: 'AX ← 7',
        set: { rax: '0x7', rip: '0x8' }, hl: [0x20010, 2], flow: [{ from: 'addr:0x20010', to: 'reg.rax', label: '07 00' }],
      },
      {
        say: '加法：AX 送进运算器 ALU，加上 5，结果 12（0xC）写回 AX',
        tts: '加法：AX 送进运算器，加上 5，结果 12 写回 AX',
        code: 'pr-asm', line: 'add  ax, 5', insn: 'add ax, 5', mean: 'AX ← AX + 5 = 0xC',
        set: { rax: '0xc', rip: '0xb' }, unit: 'alu', flow: [{ from: 'reg.rax', to: 'alu', label: '7' }, { from: 'alu', to: 'reg.rax', label: '12' }],
      },
      {
        say: '写内存：把 AX 的值写到 DS:0012，也就是物理地址 0x20012',
        code: 'pr-asm', line: 'mov  [0x0012], ax', insn: 'mov [0x0012], ax', mean: '内存 0x20012 ← 0x000C',
        set: { rip: '0xe' }, unit: 'agu', poke: [[0x20012, '0C 00']], hl: [0x20012, 2], flow: [{ from: 'reg.rax', to: 'addr:0x20012', label: '0C 00' }],
      },
      {
        say: '栈：一块“后放进去的先拿出来”的草稿区。栈顶地址 = SS × 16 + SP = 0x30100',
        tts: '栈：一块后放进去的先拿出来的草稿区。栈顶地址等于 SS 乘 16，再加 SP',
        view: [0x300e0, 0x30100], hit: ['seg.ss', 'reg.rsp'], unit: 'agu',
      },
      {
        say: 'push：SP 先减 2，变成 0xFE，再把 AX 写到新的栈顶 0x300FE',
        code: 'pr-asm', line: 'push ax', insn: 'push ax', mean: 'SP ← SP − 2；内存 SS:SP ← AX',
        set: { rsp: '0xfe', rip: '0xf' }, poke: [[0x300fe, '0C 00']], hl: [0x300fe, 2], flow: [{ from: 'reg.rax', to: 'addr:0x300fe', label: '0C 00' }],
      },
      {
        say: 'call：先把下一条指令的地址 0x0012 压进栈，记住回来的路，再跳到 0x0016 的子程序',
        code: 'pr-asm', line: 'call double', insn: 'call double', mean: '压栈 IP = 0x0012；IP ← 0x0016',
        set: { rsp: '0xfc', rip: '0x16' }, poke: [[0x300fc, '12 00']], hl: [0x300fc, 2], flow: [{ from: 'reg.rip', to: 'addr:0x300fc', label: '0012' }],
      },
      {
        say: '子程序里：AX + AX = 24（0x18）',
        code: 'pr-asm', line: 'add  ax, ax', insn: 'add ax, ax', mean: 'AX ← 0xC + 0xC = 0x18',
        view: [0x10000, 0x10020], hl: [0x10016, 2], set: { rax: '0x18', rip: '0x18' }, unit: 'alu',
        flow: [{ from: 'reg.rax', to: 'alu', label: '12 + 12' }, { from: 'alu', to: 'reg.rax', label: '24' }],
      },
      {
        say: 'ret：从栈顶弹出 0x0012 放回 IP，SP 加 2。程序回到 call 的下一条',
        code: 'pr-asm', line: 'ret ', insn: 'ret', mean: 'IP ← 内存 SS:SP；SP ← SP + 2',
        view: [0x300e0, 0x30100], hl: [0x300fc, 2], set: { rip: '0x12', rsp: '0xfe' }, flow: [{ from: 'addr:0x300fc', to: 'reg.rip', label: '0012' }],
      },
      {
        say: 'pop：把栈顶的 0x000C 取进 BX，SP 回到 0x100。数据还留在内存里，只是不再算栈的一部分',
        code: 'pr-asm', line: 'pop  bx', insn: 'pop bx', mean: 'BX ← 内存 SS:SP；SP ← SP + 2',
        hl: [0x300fe, 2], set: { rbx: '0xc', rsp: '0x100', rip: '0x13' }, flow: [{ from: 'addr:0x300fe', to: 'reg.rbx', label: '000C' }],
      },
      {
        say: 'hlt：CPU 停下来休息，什么都不做，直到有“中断”来叫醒它',
        code: 'pr-asm', line: 'hlt ', insn: 'hlt', mean: '停机，IP 已指向下一条 0x0014',
        set: { rip: '0x14' }, unit: 'idle',
      },
      {
        say: '中断：设备有事就给 CPU 发一个信号。时钟芯片每 55 毫秒发一次，这是 8 号中断。IF = 1 时 CPU 才接',
        tts: '中断：设备有事就给 CPU 发一个信号。时钟芯片每 55 毫秒发一次，这是 8 号中断。中断标志为 1 时，CPU 才接',
        unit: 'irq', hit: ['ctl.if'],
        focus: {
          kind: 'table', title: '中断向量表 IVT：每项 4 字节 = 偏移 + 段', head: ['中断号', '表项地址', '处理程序', '谁会触发'], rows: [
            ['0', '0x0000', 'F000:FF53', '除以 0'],
            ['8', '0x0020', 'F000:FEA5', '时钟（每 55 毫秒）'],
            ['9', '0x0024', 'F000:E987', '键盘按键'],
            ['0x13', '0x004C', 'BIOS 里', '程序请求读磁盘'],
          ], hl: [1],
        },
      },
      {
        say: 'CPU 先保存“现场”：把 FLAGS（标志）、CS、IP 依次压栈，然后 IF 清 0，防止再被打断',
        tts: 'CPU 先保存现场：把标志寄存器、CS、IP 依次压栈，然后把中断标志清 0，防止再被打断',
        view: [0x300e0, 0x30100], unit: 'irq', set: { rsp: '0xfa', if: 0 }, poke: [[0x300fa, '14 00 00 10 02 02']], hl: [0x300fa, 6],
        flow: [{ from: 'cpu', to: 'addr:0x300fe', label: 'FLAGS' }, { from: 'seg.cs', to: 'addr:0x300fc', label: 'CS' }, { from: 'reg.rip', to: 'addr:0x300fa', label: 'IP' }],
      },
      {
        say: '再查中断向量表：8 号在地址 8 × 4 = 0x20，读出 A5 FE 00 F0，也就是 F000:FEA5',
        tts: '再查中断向量表：8 号表项在地址 8 乘 4，读出处理程序的地址',
        view: [0x10, 0x30], hl: [0x20, 4], unit: 'irq', set: { rip: '0xfea5' }, seg: { cs: ['0xf000', '0xf0000'] },
        flow: [{ from: 'addr:0x20', to: 'seg.cs', label: 'F000:FEA5' }],
      },
      {
        say: '跳到 BIOS 的时钟处理程序：把时钟计数加 1，再告诉中断控制器“处理完了”',
        code: 'sb-irq08', line: 'clock_update();', insn: 'handle_08()', mean: '时钟计数 + 1；发送 EOI',
        view: [0x0, 0x100000], hit: ['mem.pbios'],
      },
      {
        say: 'iret：依次弹出 IP、CS、FLAGS，回到 1000:0014 继续执行。程序完全感觉不到自己被打断过',
        tts: 'iret：依次弹出 IP、CS、标志寄存器，回到原来的地方继续执行。程序完全感觉不到自己被打断过',
        insn: 'iret', mean: 'IP、CS、FLAGS ← 栈；SP ← SP + 6',
        view: [0x300e0, 0x30100], hl: [0x300fa, 6], set: { rip: '0x14', rsp: '0x100', if: 1 }, seg: { cs: ['0x1000', '0x10000'] },
        flow: [{ from: 'addr:0x300fa', to: 'reg.rip', label: 'IP' }, { from: 'addr:0x300fc', to: 'seg.cs', label: 'CS' }, { from: 'addr:0x300fe', to: 'ctl.if', label: 'FLAGS' }],
      },
      {
        say: '这就是 CPU 的基本功：算地址、取指令、执行、IP 前进；用栈记住返回地址；中断来了就保存现场、查表、处理、返回',
        focus: { kind: 'cycle', title: 'CPU 的工作循环（一直重复）', at: 4 }, spot: ['cpu', 'mem', 'focus'],
      },
      {
        say: '后面的保护模式、64 位模式只是把“段”和“地址翻译”换成了更强的机制。下面看真实的开机过程',
        tts: '后面的保护模式、64 位模式，只是把段和地址翻译换成了更强的机制。下面看真实的开机过程',
      },
    ],
  },
  {
    id: 'reset', title: '通电：第一条指令',
    ops: [
      {
        say: '按下电源。CPU 被复位：所有寄存器都被设成固定的初始值', mode: 'real', reset: true, view: 0x100000000,
        set: { rax: '0x0', rbx: '0x0', rcx: '0x0', rdx: '0x60fb1', rsi: '0x0', rdi: '0x0', rbp: '0x0', rsp: '0x0', rip: '0xfff0', cr0: '0x60000010', cr3: '0x0', cr4: '0x0', efer: '0x0', if: 0, gdtr: '0x0', idtr: '0x0' },
        seg: { cs: ['0xf000', '0xffff0000'], ds: ['0x0', '0x0'], ss: ['0x0', '0x0'], es: ['0x0', '0x0'] },
        mem: [reg('romTop'), reg('ram')], hit: ['regs', 'ctl'],
      },
      {
        say: 'CPU 要去取第一条指令。指令地址 = CS（代码段寄存器）基址 FFFF0000 + IP（指令指针）FFF0', tts: 'CPU 要去取第一条指令。指令地址等于 CS 的基址，加上 IP',
        hit: ['seg.cs', 'reg.rip', 'fetch'], unit: 'agu',
      },
      {
        say: '算出来是 FFFFFFF0：4 GB 地址空间的最顶端，那里接的是主板上的 BIOS 芯片', tts: '算出来的地址在 4 GB 地址空间的最顶端，那里接的是主板上的 BIOS 芯片',
        code: 'sb-reset', line: 'ljmpw $SEG_BIOS, $entry_post', flow: [{ from: 'mem.romTop', to: 'insn', label: 'EA 5B E0 00 F0' }], hit: ['mem.romTop'],
      },
      {
        say: '取回来的第一条指令是“远跳转”：把 CS 改成 F000、IP 改成 E05B', tts: '取回来的第一条指令是远跳转：同时改掉 CS 和 IP',
        code: 'sb-reset', line: 'ljmpw $SEG_BIOS, $entry_post', insn: 'ljmpw $0xf000, $0xe05b', mean: '远跳转：CS ← 0xF000，IP ← 0xE05B',
        set: { rip: '0xe05b' }, seg: { cs: ['0xf000', '0xf0000'] }, hit: ['seg.cs', 'reg.rip'],
      },
      {
        view: 1 * MB, say: '新地址 = F0000 + E05B = FE05B：在 1 MB 以下的 BIOS 区域，从这里开始执行 BIOS 程序', tts: '新地址落在 1 MB 以下的 BIOS 区域，从这里开始执行 BIOS 程序',
        code: 'sb-entry', line: 'entry_post:', insn: 'cmpl $0, %cs:HaveRunPost', mean: '检查：是不是第一次开机',
        mem: [reg('romLow')], flow: [{ from: 'mem.romLow', to: 'insn' }], hit: ['fetch'],
      },
    ],
  },
  {
    id: 'bios', title: 'BIOS 自检',
    ops: [
      {
        say: 'SeaBIOS 用 32 位 C 代码做初始化，方便用平坦地址访问内存和设备；C 语言本身不要求 32 位模式',
        code: 'sb-entry', line: 'ENTRY_INTO32 _cfunc32flat_handle_post', mean: '入口先准备工作栈，再转入 transition32；这里仍是 BIOS，不是 Linux',
        set: { rsp: '0x7000' }, seg: { ss: ['0x0', '0x0'] }, hit: ['cpu', 'code', 'reg.rsp'],
        focus: {
          kind: 'table', title: '为什么暂时切到 32 位', head: ['用途', '边界'], rows: [
            ['32 位 C 初始化代码', '平坦地址便于访问内存、PCI 和设备'],
            ['不是 C 语言的硬性要求', '也能编译 16 位 C 代码'],
            ['这是 BIOS 自己的切换', '不是 Linux，也没开启分页或 64 位'],
            ['传统引导接口仍用 16 位', '之后还会切回实模式'],
          ],
        },
      },
      {
        say: '先关闭可屏蔽中断并屏蔽 NMI，再开启 A20，避免切换被打断，也避免高地址回绕',
        code: 'sb-trans32', line: 'cli', insn: 'cli; cld', mean: 'IF ← 0；后续屏蔽 NMI 并开启 A20，尚未切换模式',
        set: { if: 0 }, hit: ['ctl.if'],
      },
      {
        say: '装入 BIOS 自带的 GDT 和临时 IDT。GDT 定义起点为 0 的 32 位代码段与数据段，范围是 4 GB',
        code: 'sb-trans32', line: 'lgdtw %cs:rombios32_gdt_48', insn: 'lgdtw %cs:rombios32_gdt_48', mean: 'GDTR 指向 BIOS 段表；IDTR 已指向临时表，具体地址未采样',
        set: { gdtr: '未采样', idtr: '未采样' }, hit: ['ctl.gdtr', 'ctl.idtr'],
        focus: {
          kind: 'table', title: 'SeaBIOS 的平坦段（源码定义）', head: ['选择子', '用途', '起点', '范围'], rows: [
            ['0x08', '32 位代码段 CS', '0', '4 GB'],
            ['0x10', '32 位数据段 DS / SS', '0', '4 GB'],
            ['LGDT 只装表指针', '还没加载新 CS', '—', '—'],
            ['保护模式不等于分页', '此处 PG 仍为 0', '—', '—'],
          ],
        },
      },
      {
        say: '写 CR0，把 PE 置 1，进入保护模式；同时清掉 PG、CD 和 NW。仅写 PE，还没装入新的 32 位代码段',
        code: 'sb-trans32', line: 'movl %ecx, %cr0', insn: 'movl %ecx, %cr0', mean: 'CR0.PE ← 1，PG / CD / NW ← 0；32 位代码段尚待远跳转加载',
        set: { cr0: '0x11', rcx: '0x11' }, mode: 'prot16', hit: ['ctl.cr0', 'mode'],
      },
      {
        say: '远跳转装入选择子 0x08 对应的 CS。段描述符指定默认 32 位操作数和地址，CPU 从此按 32 位代码段执行',
        code: 'sb-trans32', line: 'ljmpl $SEG32_MODE32_CS', insn: 'ljmpl $SEG32_MODE32_CS, $(BUILD_BIOS_ADDR + 1f)', mean: 'CS ← 0x08，隐藏基址 ← 0，D 位 ← 1；不是开启 64 位模式',
        set: { rip: 'in:romLow' }, mode: 'prot', seg: { cs: ['0x8', '0x0'] }, hit: ['seg.cs', 'reg.rip', 'mode'],
      },
      {
        say: '再把数据段和栈段换成选择子 0x10，起点都是 0，然后跳进 BIOS 的 C 初始化代码。PG 为 0，不用页表',
        code: 'sb-trans32', line: 'movw %cx, %ss', insn: 'movw %cx, %ss', mean: 'DS / ES / SS / FS / GS ← 0x10；随后 jmpl *%edx 进入 C 代码',
        set: { rcx: '0x10' }, seg: { ds: ['0x10', '0x0'], es: ['0x10', '0x0'], ss: ['0x10', '0x0'] },
        hit: ['seg.ds', 'seg.es', 'seg.ss'],
      },
      {
        view: 512 * MB, say: '第一件事：弄清有多少内存。答案是 512 MB，内存从此可以读写',
        code: 'sb-dopost', line: 'qemu_preinit();', insn: 'qemu_preinit();', mean: '向 QEMU 询问内存大小',
        mem: [reg('ram', { label: 'RAM 512 MB' })], hit: ['mem.ram'],
      },
      {
        view: 0x1000, say: '在内存最底部写一张“中断向量表”：256 个入口，记录每种中断该去哪里处理',
        code: 'sb-ivt', line: 'for (i=0; i<256; i++)', insn: 'SET_IVT(i, FUNC16(entry_iret_official));', mean: '256 个入口先都填默认处理程序',
        mem: [reg('ivt')], flow: [{ from: 'cpu', to: 'mem.ivt', label: '写 1 KB' }],
      },
      {
        view: 0x1000, say: '紧挨着写“BIOS 数据区”：记录键盘、屏幕、磁盘这些设备的状态',
        code: 'sb-iface', line: 'bda_init();', insn: 'bda_init();', mean: '建立 BIOS 数据区',
        mem: [reg('bda')], flow: [{ from: 'cpu', to: 'mem.bda', label: '写 256 B' }],
      },
      {
        view: 1 * MB, say: '运行显卡自带的小程序，屏幕亮了，显示 BIOS 的版本',
        code: 'sb-main', line: 'vgarom_setup();', insn: 'vgarom_setup(); enable_vga_console();', mean: '初始化显卡，打开屏幕',
        mem: [reg('vrom'), reg('vga')], screen: { title: '显示器', add: ['SeaBIOS (version rel-1.16.3-0-ga6ed6b701f0a-prebuilt.qemu.org)'] },
        flow: [{ from: 'cpu', to: 'mem.vga', label: '写字符' }, { from: 'mem.vga', to: 'screen' }],
      },
      {
        say: '检查其他硬件：键盘、光驱、磁盘……然后开始找可以启动的盘',
        code: 'sb-main', line: 'device_hardware_setup();', insn: 'device_hardware_setup();', mean: '初始化键盘、磁盘控制器等',
        hit: ['disk', 'cdrom'],
      },
      {
        say: '从光盘启动。屏幕显示 Booting from DVD/CD',
        code: 'sb-cdrom', line: 'printf("Booting from DVD/CD...\\n");', insn: 'printf("Booting from DVD/CD...\\n");', mean: '往屏幕打印一行字',
        screen: { add: ['Booting from DVD/CD...'] }, hit: ['cdrom'],
      },
      {
        say: '先读光盘第 17 号扇区：这是“启动记录”，告诉 BIOS 引导程序放在盘上哪里',
        code: 'sb-cdread', line: 'dop.lba = 0x11;', insn: 'dop.lba = 0x11; process_op(&dop);', mean: '读光盘第 0x11 号扇区（2 KB）',
        flow: [{ from: 'cdrom', to: 'cpu', label: '启动记录' }],
      },
      {
        view: 0x10000, say: '把光盘里的引导程序（2 KB）复制到内存地址 0x7C00',
        code: 'sb-cdread', line: 'dop.buf_fl = MAKE_FLATPTR(boot_segment, 0);', insn: 'dop.buf_fl = 0x07C0:0000', mean: '目的地：0x7C00',
        mem: [reg('boot')], flow: [{ from: 'cdrom', to: 'mem.boot', label: '2 KB' }],
      },
      {
        say: '交给传统引导器前，先收回数据段范围，再远跳转到 16 位保护模式代码段，随后清掉 CR0.PE。还要再远跳转，才能恢复实模式 CS',
        code: 'sb-trans16', line: 'ljmpw $SEG32_MODE16_CS, $1f', insn: 'ljmpw $SEG32_MODE16_CS, $1f', mean: '先收回数据段范围并加载 16 位 CS；随后清 PE、远跳转并恢复实模式 IDT',
        mode: 'prot16', seg: { cs: ['0x18', '0xf0000'], ds: ['0x20', '0x0'], es: ['0x20', '0x0'], ss: ['0x20', '0x0'] },
        hit: ['seg.cs', 'mode'],
        focus: {
          kind: 'table', title: '为什么还要切回 16 位', head: ['切回顺序', '原因'], rows: [
            ['收回数据段范围，加载 16 位 CS', '进入过渡代码'],
            ['再清 CR0.PE', '退出保护模式'],
            ['远跳转并恢复段 / IDT', '重新建立实模式执行环境'],
            ['进入 0000:7C00', '传统引导器使用实模式接口'],
          ],
        },
      },
      {
        say: 'BIOS 退回 16 位实模式，AX 填上“暗号”AA55，然后跳到 0x7C00，把 CPU 交给引导程序',
        tts: 'BIOS 退回 16 位实模式，AX 填上暗号 AA55，然后跳到 7C00，把 CPU 交给引导程序',
        code: 'sb-callboot', line: 'br.ax = 0xaa55;', insn: 'farcall16(&br)', mean: '跳到 0000:7C00',
        mode: 'real', set: { rax: '0xaa55', rip: '0x7c00', rsp: '0x6f40', cr0: '0x10', rcx: '0x0', idtr: '0x0', if: 1 },
        seg: { cs: ['0x0', '0x0'], ds: ['0x0', '0x0'], es: ['0x0', '0x0'], ss: ['0x0', '0x0'] },
        hit: ['reg.rax', 'reg.rip', 'ctl.cr0'], flow: [{ from: 'mem.boot', to: 'insn' }],
      },
    ],
  },
  {
    id: 'grub', title: 'GRUB：把内核搬进内存',
    ops: [
      {
        view: 1 * MB, say: '引导程序只有 2 KB，它的任务是把 GRUB 的其余部分从光盘读进内存',
        code: 'grub-cfg', line: 'set timeout=0', set: { gdtr: '0x8160' },
        mem: [reg('grub')], flow: [{ from: 'cdrom', to: 'mem.grub', label: 'GRUB' }],
      },
      {
        say: 'GRUB 读配置文件 grub.cfg：要启动的内核文件是 /boot/bzImage',
        code: 'grub-cfg', line: "menuentry 'Linux 6.12.112 Observatory' {", flow: [{ from: 'cdrom', to: 'mem.grub', label: 'grub.cfg' }],
      },
      {
        say: '先把内核文件开头的 setup 部分（16 位程序）放到 0x90000',
        code: 'grub-cfg', line: 'linux16 /boot/bzImage',
        mem: [reg('setup')], flow: [{ from: 'cdrom', to: 'mem.setup', label: 'setup 18 KB' }],
      },
      {
        view: 8 * MB, say: '再把内核的主体放到 1 MB 处，也就是 0x100000。它是压缩过的，6.2 MB',
        code: 'grub-cfg', line: 'linux16 /boot/bzImage',
        mem: [reg('zkernel')], flow: [{ from: 'cdrom', to: 'mem.zkernel', label: '6.2 MB' }], grow: 1,
      },
      {
        view: 512 * MB, say: '再把 initramfs 放到内存顶部：它是一个打包好的小文件系统，里面有第一个用户程序',
        code: 'grub-cfg', line: 'initrd16 /boot/initramfs.cpio.gz',
        mem: [reg('initrd')], flow: [{ from: 'cdrom', to: 'mem.initrd', label: '1.5 MB' }],
      },
      {
        view: 1 * MB, say: '把这些位置和命令行写进“启动参数表” boot_params，留给内核看',
        code: 'grub-cfg', line: 'linux16 /boot/bzImage',
        flow: [{ from: 'cpu', to: 'mem.setup', label: 'boot_params' }],
        focus: {
          kind: 'table', title: '启动参数表 boot_params（GRUB 填写）', head: ['字段', '值', '含义'], rows: [
            ['code32_start', '0x100000', '内核主体在哪'],
            ['ramdisk_image', '0x1FCBA000', 'initramfs 在哪'],
            ['ramdisk_size', '1.5 MB', 'initramfs 多大'],
            ['cmd_line', 'console=ttyS0 rdinit=/init …', '命令行参数'],
          ],
        },
      },
      {
        say: 'GRUB 跳到 setup 的入口：CS = 9020，IP = 0。Linux 的代码开始执行了',
        tts: 'GRUB 跳到 setup 的入口。Linux 的代码开始执行了',
        code: 'lx-header', line: 'start_of_setup:',
        set: { rip: '0x0', rsp: '0x9000', rax: '0x72d400', rsi: '0x72d400' }, seg: { cs: ['0x9020', '0x90200'], ds: ['0x9000', '0x90000'], ss: ['0x9000', '0x90000'] },
        flow: [{ from: 'mem.setup', to: 'insn' }], hit: ['seg.cs', 'reg.rip'],
      },
    ],
  },
  {
    id: 'setup', title: '内核 setup（16 位实模式）',
    ops: [
      {
        say: 'Linux 的第一行代码：把 DS 的值复制到 ES，让几个段寄存器指向同一块内存',
        code: 'lx-header', line: 'movw	%ax, %es', insn: 'movw %ds, %ax ; movw %ax, %es', mean: 'ES ← DS',
        set: { rax: '0x9000' }, seg: { es: ['0x9000', '0x90000'] }, flow: [{ from: 'seg.ds', to: 'reg.rax' }, { from: 'reg.rax', to: 'seg.es' }],
      },
      {
        say: '设置“栈”：一块临时草稿区，函数调用时要用。栈顶在 0x98FFC',
        code: 'lx-header', line: 'movzwl	%dx, %esp', insn: 'movw %ax, %ss ; movzwl %dx, %esp', mean: 'SS:SP = 9000:8FFC',
        set: { rsp: '0x8ffc' }, hit: ['reg.rsp', 'seg.ss'],
      },
      {
        say: '把 CS 统一成 9000，再把 setup 的全局变量区清零',
        code: 'lx-header', line: 'rep; stosl', insn: 'rep; stosl', mean: '重复写 0，清空一段内存',
        seg: { cs: ['0x9000', '0x90000'] }, set: { rax: '0x0' }, flow: [{ from: 'cpu', to: 'mem.setup', label: '写 0' }],
      },
      {
        say: '跳进 C 语言写的 main 函数',
        code: 'lx-main', line: 'void main(void)', insn: 'calll main', mean: '调用 main()',
        set: { rip: '0x1171', rsp: '0x8ffc' }, hit: ['reg.rip'],
      },
      {
        say: '把 GRUB 填好的启动参数复制一份，存进 setup 自己的 boot_params',
        code: 'lx-main', line: 'copy_boot_params();', insn: 'copy_boot_params();', mean: '复制启动参数',
        set: { rsi: '0x26c' }, flow: [{ from: 'mem.setup', to: 'mem.setup', label: '复制' }],
      },
      {
        say: '问 BIOS：哪些地址是真内存？用的是 BIOS 的 e820 功能，INT 0x15 中断',
        tts: '问 BIOS：哪些地址是真内存？用的是 BIOS 的 e820 功能',
        code: 'lx-e820', line: 'ireg.ax  = 0xe820;', insn: 'int $0x15   ; AX = 0xE820', mean: '调用 BIOS 的“内存地图”服务',
        set: { rip: '0x12a0', rsp: '0x8f9c', rax: '0xe820' }, flow: [{ from: 'cpu', to: 'mem.romLow', label: 'INT 15h' }, { from: 'mem.romLow', to: 'cpu', label: '一行结果' }],
        focus: { kind: 'table', title: 'e820 内存地图（BIOS 返回，实测）', head: ['地址范围', '类型'], rows: E820 },
      },
      {
        say: '准备离开实模式。第一步，关中断（cli）：切换过程中不能被打断',
        code: 'lx-gopm', line: 'realmode_switch_hook();', insn: 'cli', mean: 'IF ← 0，暂时不接中断',
        set: { if: 0, rip: '0x153e', rsp: '0x8f94', rax: '0x0' }, hit: ['ctl.if'],
      },
      {
        say: '打开 A20 地址线：不开它，1 MB 以上的地址会“绕回”0',
        code: 'lx-gopm', line: 'if (enable_a20()) {', insn: 'enable_a20();', mean: '打开第 21 根地址线',
      },
      {
        say: '屏蔽中断控制器上的所有硬件中断',
        code: 'lx-gopm', line: 'mask_all_interrupts();', insn: 'outb $0xff, $0xa1 ; outb $0xfb, $0x21', mean: '屏蔽所有硬件中断',
      },
      {
        say: '装一张空的中断描述符表 IDT：模式切换期间不处理中断',
        code: 'lx-gopm', line: 'setup_idt();', insn: 'lidtl null_idt', mean: 'IDTR ← 0',
        set: { idtr: '0x0' }, hit: ['ctl.idtr'],
      },
      {
        say: '装入“全局描述符表” GDT：定义代码段和数据段，都从 0 开始、覆盖 4 GB',
        code: 'lx-gdt', line: 'asm volatile("lgdtl %0" : : "m" (gdt));', insn: 'lgdtl gdt', mean: 'GDTR ← GDT 的地址',
        set: { gdtr: '0x94310', rip: '0x1566', rax: '0x94310' }, hit: ['ctl.gdtr'], flow: [{ from: 'mem.setup', to: 'ctl.gdtr', label: 'GDT' }],
        focus: {
          kind: 'table', title: '全局描述符表 GDT（setup 建的）', head: ['编号', '段', '起点', '大小'], rows: [
            ['0x10', '代码段 CS', '0', '4 GB'],
            ['0x18', '数据段 DS', '0', '4 GB'],
            ['0x20', '任务段 TSS', '4096', '104 B'],
          ],
        },
      },
      {
        say: '调用 protected_mode_jump：带上两个参数，内核入口 0x100000 和 boot_params 的地址',
        tts: '调用 protected_mode_jump，带上两个参数：内核入口地址，和 boot_params 的地址',
        code: 'lx-gopm', line: 'protected_mode_jump(boot_params.hdr.code32_start,', insn: 'protected_mode_jump(0x100000, 0x94910)', mean: 'EAX = 内核入口，EDX = 参数表',
        set: { rax: '0x100000', rdx: '0x94910' }, hit: ['reg.rax', 'reg.rdx'],
      },
    ],
  },
  {
    id: 'pm', title: '进入 32 位保护模式',
    ops: [
      {
        say: 'ESI 记下启动参数表的地址，之后一路传给内核',
        code: 'lx-pmjump', line: 'movl	%edx, %esi', insn: 'movl %edx, %esi', mean: 'ESI ← EDX',
        set: { rsi: '0x94910' }, flow: [{ from: 'reg.rdx', to: 'reg.rsi' }],
      },
      {
        say: '读出 CR0（控制寄存器）到 EDX',
        code: 'lx-pmjump', line: 'movl	%cr0, %edx', insn: 'movl %cr0, %edx', mean: 'EDX ← CR0',
        set: { rdx: '0x10' }, flow: [{ from: 'ctl.cr0', to: 'reg.rdx', label: '0x10' }],
      },
      {
        say: '把最低位 PE 置 1：PE 就是“保护模式”的开关',
        code: 'lx-pmjump', line: 'orb	$X86_CR0_PE, %dl', insn: 'orb $1, %dl', mean: 'EDX ← EDX | 1',
        set: { rdx: '0x11' }, unit: 'alu', flow: [{ from: 'reg.rdx', to: 'alu' }, { from: 'alu', to: 'reg.rdx', label: '0x11' }],
      },
      {
        say: '写回 CR0：PE = 1，CPU 进入保护模式！',
        code: 'lx-pmjump', line: 'movl	%edx, %cr0', insn: 'movl %edx, %cr0', mean: 'CR0 ← 0x11',
        set: { cr0: '0x11', rip: '0x1599', rsp: '0x8f90' }, mode: 'prot16', flow: [{ from: 'reg.rdx', to: 'ctl.cr0', label: '0x11' }], hit: ['mode'],
      },
      {
        say: '远跳转：CS 换成 GDT 里的代码段 0x10。从这一刻起，CPU 按 32 位执行指令',
        code: 'lx-pmjump', line: '.byte	0x66, 0xea		# ljmpl opcode', insn: 'ljmpl $0x10, $in_pm32', mean: 'CS ← 0x10（段起点 0，大小 4 GB）',
        mode: 'prot', seg: { cs: ['0x10', '0x0'] }, set: { rip: '0x93338' }, hit: ['seg.cs', 'mode'], flow: [{ from: 'ctl.gdtr', to: 'seg.cs', label: '查 GDT' }],
      },
      {
        say: 'DS、ES、SS 也换成 GDT 里的数据段 0x18',
        code: 'lx-pmjump', line: 'movl	%ecx, %ds', insn: 'movl %ecx, %ds  ; ECX = 0x18', mean: 'DS = ES = SS ← 0x18',
        seg: { ds: ['0x18', '0x0'], es: ['0x18', '0x0'], ss: ['0x18', '0x0'] }, set: { rsp: '0x98f90' }, hit: ['seg.ds', 'seg.es', 'seg.ss'],
      },
      {
        view: 8 * MB, say: '跳到 EAX 里的地址 0x100000：压缩内核的入口 startup_32',
        code: 'lx-pmjump', line: 'jmpl	*%eax			# Jump to the 32-bit entrypoint', insn: 'jmpl *%eax', mean: 'EIP ← 0x100000',
        set: { rip: '0x100000', rcx: '0x0', rdx: '0x0', rbx: '0x0', rbp: '0x0', rdi: '0x0' }, flow: [{ from: 'reg.rax', to: 'reg.rip' }, { from: 'mem.zkernel', to: 'insn' }],
      },
    ],
  },
  {
    id: 'paging', title: '开分页，进入 64 位',
    ops: [
      {
        say: '先算出自己被放在哪：用 call 再 pop 的小技巧，EBP = 0x100000',
        code: 'lx-startup32', line: '1:	popl	%ebp', insn: 'call 1f ; popl %ebp', mean: 'EBP ← 当前所在地址',
        set: { rbp: '0x100000' }, hit: ['reg.rbp'],
      },
      {
        say: '换上自己的 GDT 和栈，CS 换成 0x08，栈顶在 0x731400',
        code: 'lx-startup32', line: 'lretl', insn: 'lgdt ; lretl', mean: '新 GDT，CS ← 0x08',
        seg: { cs: ['0x8', '0x0'] }, set: { rsp: '0x731400', rip: '0x100071', gdtr: '0x72d010' }, hit: ['seg.cs', 'reg.rsp', 'ctl.gdtr'],
      },
      {
        say: '检查这颗 CPU 支不支持 64 位：支持',
        code: 'lx-startup32', line: 'call	verify_cpu', insn: 'call verify_cpu', mean: '用 CPUID 指令查询 CPU 功能',
      },
      {
        say: '算出解压时的安全位置：EBX = 0x20AA000。先把自己挪到后面，前面留给解压结果',
        tts: '算出解压时的安全位置，放进 EBX。先把自己挪到后面，前面留给解压结果',
        code: 'lx-startup32', line: 'subl	$ rva(_end), %ebx', insn: 'addl init_size, %ebx ; subl _end, %ebx', mean: 'EBX ← 搬移目的地',
        set: { rbx: '0x20aa000', rax: '0xffe00000' }, unit: 'alu', hit: ['reg.rbx'],
      },
      {
        say: '64 位第 1 步：打开 CR4 的 PAE 位（物理地址扩展），这是 64 位分页的前提',
        code: 'lx-startup32', line: 'orl	$X86_CR4_PAE, %eax', insn: 'movl %cr4,%eax ; orl $0x20,%eax ; movl %eax,%cr4', mean: 'CR4 ← CR4 | 0x20',
        set: { rax: '0x20', cr4: '0x20', rip: '0x10007a' }, unit: 'alu', flow: [{ from: 'ctl.cr4', to: 'alu' }, { from: 'alu', to: 'ctl.cr4', label: '0x20' }],
      },
      {
        say: '64 位第 2 步：建“页表”。先在 0x26F1000 清出 6 页（24 KB）',
        code: 'lx-startup32', line: 'rep	stosl', insn: 'rep stosl', mean: '把 24 KB 写成 0',
        mem: [reg('pt0')], flow: [{ from: 'cpu', to: 'mem.pt0', label: '写 0' }],
        focus: { kind: 'pt', title: '页表：虚拟地址 → 物理地址的“查找表”', level: 0 },
      },
      {
        say: '第 4 级页表（PML4）只填 1 项：指向下一级',
        code: 'lx-startup32', line: 'leal	0x1007 (%edi), %eax', insn: 'movl %eax, 0(%edi)', mean: 'PML4[0] ← PDPT 的地址',
        flow: [{ from: 'cpu', to: 'mem.pt0', label: 'PML4[0]' }], focus: { kind: 'pt', title: '页表：虚拟地址 → 物理地址的“查找表”', level: 1 },
      },
      {
        say: '第 3 级（PDPT）填 4 项：指向 4 张页目录',
        code: 'lx-startup32', line: 'movl	$4, %ecx', insn: 'movl %eax, 0x00(%edi)  × 4', mean: 'PDPT[0..3] ← 4 张页目录',
        set: { rcx: '0x4' }, flow: [{ from: 'cpu', to: 'mem.pt0', label: 'PDPT' }], focus: { kind: 'pt', title: '页表：虚拟地址 → 物理地址的“查找表”', level: 2 },
      },
      {
        say: '第 2 级（页目录）填 2048 项，每项管 2 MB，一共覆盖 4 GB：虚拟地址 = 物理地址',
        code: 'lx-startup32', line: 'movl	$0x00000183, %eax', insn: 'movl $0x183,%eax ; movl $2048,%ecx', mean: '每项 = 物理地址 | 0x183（存在、可写、2 MB 大页）',
        set: { rax: '0x183', rcx: '0x800', rip: '0x1000dd' }, flow: [{ from: 'cpu', to: 'mem.pt0', label: '2048 项' }], focus: { kind: 'pt', title: '页表：虚拟地址 → 物理地址的“查找表”', level: 3 },
      },
      {
        say: '64 位第 3 步：把页表的起点写进 CR3：0x26F1000。CPU 以后从这里查页表',
        tts: '64 位第 3 步：把页表的起点写进 CR3。CPU 以后从这里查页表',
        code: 'lx-startup32', line: 'movl	%eax, %cr3', insn: 'movl %eax, %cr3', mean: 'CR3 ← 0x26F1000',
        set: { rax: '0x26f1000', cr3: '0x26f1000', rip: '0x1000e6' }, flow: [{ from: 'reg.rax', to: 'ctl.cr3', label: '0x26F1000' }], hit: ['ctl.cr3', 'mem.pt0'],
      },
      {
        say: '64 位第 4 步：打开 EFER 寄存器的 LME 位：允许长模式（64 位）',
        code: 'lx-startup32', line: 'btsl	$_EFER_LME, %eax', insn: 'movl $0xC0000080,%ecx ; rdmsr ; btsl $8,%eax ; wrmsr', mean: 'EFER ← EFER | 0x100',
        set: { rcx: '0xc0000080', rax: '0x100', efer: '0x100', rip: '0x1000f3' }, flow: [{ from: 'reg.rax', to: 'ctl.efer', label: 'LME' }],
      },
      {
        say: '把 64 位代码的入口 0x100200 压进栈，准备“返回”过去',
        code: 'lx-startup32', line: 'pushl	$__KERNEL_CS', insn: 'pushl $0x10 ; pushl %eax', mean: '栈里放好：CS = 0x10，入口 = 0x100200',
        set: { rsp: '0x7313f8', rax: '0x100200' }, flow: [{ from: 'cpu', to: 'mem.zkernel', label: '压栈' }],
      },
      {
        say: '64 位第 5 步：写 CR0，PG = 1，分页正式开启！CPU 自动把 EFER 的 LMA 置 1',
        code: 'lx-startup32', line: 'movl	%eax, %cr0', insn: 'movl $0x80050033,%eax ; movl %eax,%cr0', mean: 'CR0 ← 0x80050033（PG = 1）',
        set: { rax: '0x80050033', cr0: '0x80050033', efer: '0x500', rip: '0x100120' }, mode: 'compat', paging: true,
        vm: [map('ident')], unit: 'mmu', flow: [{ from: 'reg.rax', to: 'ctl.cr0', label: 'PG' }], hit: ['ctl.efer', 'mode', 'vm'],
      },
      {
        say: '从现在起，CPU 用的每个地址都要先经过 MMU（地址翻译单元）查页表，再去访问内存',
        unit: 'mmu', hit: ['vm', 'fetch'], flow: [{ from: 'ctl.cr3', to: 'mem.pt0', label: '查表' }],
      },
      {
        say: 'lret：从栈里弹出 CS 和入口地址。CPU 进入 64 位长模式！',
        code: 'lx-startup32', line: 'lret', insn: 'lret', mean: 'CS ← 0x10，RIP ← 0x100200',
        set: { rip: '0x100200', rsp: '0x731400' }, mode: 'long', seg: { cs: ['0x10', '0x0'] }, flow: [{ from: 'mem.zkernel', to: 'reg.rip', label: '出栈' }], hit: ['mode'],
      },
    ],
  },
  {
    id: 'decomp', title: '解压内核',
    ops: [
      {
        say: '64 位下段寄存器基本不再参与寻址，DS、ES、SS 清零',
        code: 'lx-startup64z', line: 'movl	%eax, %ds', insn: 'xorl %eax,%eax ; movl %eax,%ds …', mean: 'DS = ES = SS ← 0',
        set: { rax: '0x0' }, seg: { ds: ['0x0', '0x0'], es: ['0x0', '0x0'], ss: ['0x0', '0x0'] },
      },
      {
        say: '把压缩内核整个复制到 0x20AA000：从后往前，一次 8 字节',
        tts: '把压缩内核整个复制到后面的安全位置：从后往前，一次 8 字节',
        code: 'lx-startup64z', line: 'rep	movsq', insn: 'std ; rep movsq ; cld', mean: '从 RSI 复制到 RDI，重复 RCX 次',
        mem: [reg('reloc')], flow: [{ from: 'mem.zkernel', to: 'mem.reloc', label: '6.5 MB' }], grow: 1, set: { rsi: '0xffff8', rdi: '0x20a9ff8', rcx: '0x0' },
      },
      {
        say: '跳到复制后的新位置继续执行',
        code: 'lx-startup64z', line: 'jmp	*%rax', insn: 'jmp *%rax', mean: 'RIP ← 0x26C83E0',
        set: { rax: '0x26c83e0', rip: '0x26c83e0', rsp: '0x26db400', gdtr: '0x26d7010' }, flow: [{ from: 'mem.reloc', to: 'insn' }],
      },
      {
        say: '调用 C 函数 extract_kernel：参数是 boot_params 和输出地址 0x1000000（16 MB）',
        tts: '调用 C 函数 extract_kernel，开始解压。输出地址是 16 MB 处',
        code: 'lx-startup64z', line: 'call	extract_kernel', insn: 'call extract_kernel', mean: 'RDI = boot_params，RSI = 0x1000000',
        set: { rdi: '0x94910', rsi: '0x1000000', rip: '0x26c8412' }, hit: ['reg.rdi', 'reg.rsi'],
      },
      {
        say: '解压：6 MB 压缩数据变成 22 MB 的内核，从 0x1000000 开始往后写',
        tts: '解压：6 MB 的压缩数据变成 22 MB 的内核，从 16 MB 处开始往后写',
        code: 'lx-extract', line: 'entry_offset = decompress_kernel(output, virt_addr, error);', insn: 'decompress_kernel(output, …)', mean: 'gzip 解压',
        mem: [reg('kernel')], unit: 'alu', flow: [{ from: 'mem.reloc', to: 'alu', label: '压缩数据' }, { from: 'alu', to: 'mem.kernel', label: '内核' }], grow: 1.6,
      },
      {
        say: '按内核文件里的说明，分出代码、只读数据、数据和全局变量区',
        code: 'lx-extract', line: 'entry_offset = decompress_kernel(output, virt_addr, error);',
        memOff: ['kernel'], mem: [reg('kcode'), reg('krodata'), reg('kdata'), reg('kinit'), reg('kbss')], hit: ['mem.kcode', 'mem.kdata', 'mem.kbss'],
      },
      {
        say: '返回内核的入口地址：RAX = 0x1000000',
        code: 'lx-extract', line: 'return output + entry_offset;', insn: 'return output + entry_offset;', mean: 'RAX ← 0x1000000',
        set: { rax: '0x1000000' }, hit: ['reg.rax'],
      },
      {
        say: 'RSI 带上启动参数表，跳进真正的 Linux 内核！',
        code: 'lx-startup64z', line: 'movq	%r15, %rsi', insn: 'movq %r15,%rsi ; jmp *%rax', mean: 'RIP ← 0x1000000',
        set: { rsi: '0x94910', rip: '0x1000000' }, flow: [{ from: 'reg.rax', to: 'reg.rip' }, { from: 'mem.kcode', to: 'insn' }],
      },
    ],
  },
  {
    id: 'khead', title: '内核入口：换上内核自己的页表',
    ops: [
      {
        say: '内核的第一条指令：把启动参数表的地址存进 R15，防止被覆盖',
        code: 'lx-head64', line: 'mov	%rsi, %r15', insn: 'mov %rsi, %r15', mean: 'R15 ← RSI',
      },
      {
        say: '设置内核栈',
        code: 'lx-head64', line: 'leaq	__top_init_kernel_stack(%rip), %rsp', insn: 'leaq __top_init_kernel_stack(%rip), %rsp', mean: 'RSP ← 内核初始栈',
        set: { rsp: '0x1e03f58' }, hit: ['reg.rsp'],
      },
      {
        say: '装上内核的 GDT 和 IDT，再修正内核页表：让虚拟地址 FFFFFFFF81000000 对应到物理地址 0x1000000',
        tts: '装上内核的段表和中断表，再修正内核页表：让内核的虚拟地址，对应到它在物理内存里的真实位置',
        code: 'lx-head64', line: 'call	__startup_64', insn: 'call __startup_64', mean: '填写内核页表',
        set: { gdtr: '0x2033000', idtr: '0x1e05000' }, vm: [map('ktext')], hit: ['vm', 'ctl.gdtr', 'ctl.idtr'],
      },
      {
        say: 'CR3 换成内核自己的页表：0x20D6000',
        tts: 'CR3 换成内核自己的页表',
        code: 'lx-head64', line: 'movq	%rax, %cr3', insn: 'movq %rax, %cr3', mean: 'CR3 ← 0x20D6000',
        set: { rax: '0x20d6000', cr3: '0x20d6000', rip: '0x1000050' }, flow: [{ from: 'reg.rax', to: 'ctl.cr3' }], hit: ['ctl.cr3'],
      },
      {
        say: '跳到高地址：从此 RIP 是虚拟地址 FFFFFFFF8……，MMU 把它翻译成物理地址',
        tts: '跳到高地址。从此 RIP 是一个很大的虚拟地址，MMU 把它翻译成物理地址',
        code: 'lx-head64', line: 'jmp	*0f(%rip)', insn: 'jmp *0f(%rip)', mean: 'RIP ← common_startup_64',
        set: { rip: '0xffffffff81031f08' }, unit: 'mmu', hit: ['fetch', 'vm'],
        focus: { kind: 'walk', title: '一次地址翻译（MMU 查 4 级页表）', va: '0xffffffff81031f08', idx: [511, 510, 8], off: '0x031f08', pa: '0x1031f08' },
      },
      {
        say: '用高地址重新装入 GDT 和 IDT，设置 GS 寄存器的基址：以后用它找“每个 CPU 自己的数据”',
        code: 'lx-common64', line: 'lgdt	(%rsp)', insn: 'lgdt ; wrmsr(GS_BASE)', mean: 'GDTR ← 内核 GDT（虚拟地址）',
        set: { cr4: '0xb0', gdtr: '0xffffffff82033000', idtr: '0xffffffff81e05000' }, hit: ['ctl.gdtr', 'ctl.idtr', 'ctl.cr4'],
      },
      {
        say: '在 EFER 里再打开两个开关：SCE 允许 syscall 指令，NXE 允许把内存页标成“禁止执行”',
        code: 'lx-common64', line: 'btsl	$_EFER_SCE, %eax', insn: 'rdmsr ; btsl $0,%eax ; btsl $11,%eax ; wrmsr', mean: 'EFER ← 0xD01',
        set: { efer: '0xd01', rcx: '0xc0000080' }, unit: 'alu', flow: [{ from: 'ctl.efer', to: 'alu' }, { from: 'alu', to: 'ctl.efer', label: 'SCE + NXE' }],
      },
      {
        say: '调用第一个 C 函数：x86_64_start_kernel',
        code: 'lx-common64', line: 'callq	*initial_code(%rip)', insn: 'callq *initial_code(%rip)', mean: '调用 x86_64_start_kernel()',
        set: { rip: '0xffffffff820621f0', rsp: '0xffffffff81e03f50', rax: '0x80050033' }, hit: ['reg.rip', 'reg.rsp'],
      },
      {
        say: '删掉低地址的恒等映射，清空内核的全局变量区（BSS），把启动参数复制进内核',
        code: 'lx-head64c', line: 'copy_bootdata(__va(real_mode_data));', insn: 'reset_early_page_tables(); clear_bss(); copy_bootdata(…);', mean: '只留内核映射，BSS 清零，复制参数',
        set: { rip: '0xffffffff82062285', rsp: '0xffffffff81e03f38', rax: '0x0', rsi: '0xffff888000099800', idtr: '0xffffffff82291000' }, vmOff: ['ident'],
        flow: [{ from: 'cpu', to: 'mem.kbss', label: '清零' }, { from: 'mem.setup', to: 'mem.kdata', label: '参数' }],
      },
    ],
  },
  {
    id: 'startk', title: 'start_kernel：内核初始化',
    ops: [
      {
        view: 64 * MB, say: '进入 start_kernel：内核初始化的总入口，下面每一行都是一个子系统',
        code: 'lx-startk', line: 'void start_kernel(void)', insn: 'start_kernel()', mean: '内核初始化总入口',
        set: { rip: '0xffffffff82056d20', rsp: '0xffffffff81e03f20' }, hit: ['reg.rip'],
      },
      {
        say: '先关中断：东西还没准备好，暂时不接任何“电话”',
        code: 'lx-startk', line: 'local_irq_disable();', insn: 'cli', mean: 'IF ← 0',
        set: { if: 0, rip: '0xffffffff82056d65', rsp: '0xffffffff81e03ee0' }, hit: ['ctl.if'],
      },
      {
        view: 512 * MB, say: 'setup_arch：按 e820 内存地图登记可用内存，并把全部物理内存映射到 FFFF888000000000',
        tts: 'setup_arch：按 e820 内存地图登记可用内存，并把全部物理内存，再映射一份到高处的虚拟地址',
        code: 'lx-startk', line: 'setup_arch(&command_line);', insn: 'setup_arch(&command_line);', mean: '体系结构相关的初始化',
        set: { cr3: '0x1e2c000', rip: '0xffffffff82056d8d' }, vm: [map('direct')], hit: ['ctl.cr3', 'vm'],
        focus: { kind: 'table', title: 'e820 内存地图 → 内核登记的可用内存', head: ['地址范围', '类型'], rows: E820, hl: [0, 3] },
      },
      {
        say: '填写中断描述符表 IDT：除零、缺页这些异常发生时，CPU 去哪里处理；GDT 也搬到每个 CPU 专用的区域',
        code: 'lx-startk', line: 'trap_init();', insn: 'trap_init();', mean: '填写 IDT，GDTR ← CPU 专用区',
        set: { gdtr: '0xfffffe0000001000', rip: '0xffffffff8205707a' }, hit: ['ctl.idtr', 'ctl.gdtr'],
      },
      {
        say: '把空闲内存交给“伙伴分配器”：从此可以按页（4 KB）申请内存。一共约 13 万页',
        code: 'lx-startk', line: 'mm_core_init();', insn: 'mm_core_init();', mean: '内存管理初始化',
        set: { rip: '0xffffffff8205707f' }, mem: [reg('free')], hit: ['mem.free'],
      },
      {
        say: '初始化调度器：它负责决定哪个任务使用 CPU。现在只有 0 号任务',
        code: 'lx-startk', line: 'sched_init();', insn: 'sched_init();', mean: '调度器初始化',
        set: { rip: '0xffffffff82057093' }, focus: tasks([['0', 'swapper（启动任务）', '运行中']]),
      },
      {
        say: '设置中断控制器和时钟：时钟会定时“敲门”，让内核有机会切换任务。IDT 换到一个只读的固定地址',
        code: 'lx-startk', line: 'init_IRQ();', insn: 'init_IRQ(); time_init();', mean: '中断与时钟',
        set: { rip: '0xffffffff820570f6', idtr: '0xfffffe0000000000' }, unit: 'irq', hit: ['ctl.idtr'],
      },
      {
        say: '开中断！从现在起，时钟、磁盘、键盘都可以打断 CPU',
        code: 'lx-startk', line: 'local_irq_enable();', insn: 'sti', mean: 'IF ← 1',
        set: { if: 1, rip: '0xffffffff8205713b' }, hit: ['ctl.if'], unit: 'irq',
      },
      {
        say: '控制台准备好了，之前攒下的内核日志一起打印到屏幕',
        code: 'lx-startk', line: 'console_init();', insn: 'console_init();', mean: '注册控制台',
        screen: {
          title: '屏幕（串口终端）', set: [
            '[0.000000] Linux version 6.12.112-observatory',
            '[0.000000] Command line: nokaslr … console=ttyS0 rdinit=/init',
            '[0.000000] BIOS-e820: [mem 0x0000000000100000-0x000000001ffdcfff] usable',
            '[0.060454] RAMDISK: [mem 0x1fcba000-0x1fe42fff]',
            '[0.211765] Console: colour VGA+ 80x25',
          ],
        },
        flow: [{ from: 'cpu', to: 'screen', label: '日志' }],
      },
      {
        say: '准备文件系统要用的缓存、进程管理、/proc 等等',
        code: 'lx-startk', line: 'vfs_caches_init();', insn: 'fork_init(); vfs_caches_init(); proc_root_init();', mean: '更多子系统',
        set: { rip: '0xffffffff8205729a', cr4: '0x6f0' },
      },
    ],
  },
  {
    id: 'kpt', title: '页表：一共换了几套',
    ops: [
      {
        say: '先停下来回顾页表。从开机到现在，CPU 一共用过 3 套页表，现在这套是第 4 套',
        hit: ['ctl.cr3'],
        focus: {
          kind: 'table', title: '开机以来的页表（CR3 的值）', head: ['阶段', 'CR3', '能翻译哪些地址'], rows: [
            ['BIOS / GRUB / setup', '没开分页', '地址就是物理地址'],
            ['解压器', '0x26F1000', '0 – 4 GB：虚拟 = 物理'],
            ['内核入口 early_top_pgt', '0x20D6000', '同上 + 内核映像（高地址）'],
            ['内核正式 init_top_pgt', '0x1E2C000', '内核映像 + 全部物理内存'],
          ], hl: [3],
        },
      },
      {
        say: '每换一次，就是把新页表的物理地址写进 CR3。现在的 0x1E2C000 就在内核数据区里',
        hit: ['ctl.cr3', 'mem.kdata'],
      },
      {
        say: '页表最顶层叫 PML4，有 512 项，每项管 512 GB 虚拟地址。内核把它分成两半',
        hit: ['vm'],
        focus: {
          kind: 'table', title: '内核页表 init_top_pgt 的顶层（PML4）', head: ['PML4 项', '虚拟地址', '现在填了什么'], rows: [
            ['第 0 – 255 项', '0x0000… – 0x00007FFF…', '空着：留给用户程序'],
            ['第 273 项', '0xFFFF888000000000 起', '直接映射 → 全部物理内存'],
            ['第 511 项', '0xFFFFFFFF80000000 起', '内核映像 → 0x1000000'],
            ['其他几项', 'vmalloc、每 CPU 区…', '内核自己用'],
          ], hl: [0],
        },
      },
      {
        say: '直接映射：内核想访问任何物理地址 P，就访问虚拟地址 0xFFFF888000000000 + P',
        tts: '直接映射：内核想访问任何一个物理地址，只要在它前面加上一个固定的大数',
        flow: [{ from: 'vaddr:0xffff888000099800', to: 'mem.setup', label: '0x99800' }],
        focus: {
          kind: 'table', title: '例子：内核读 setup 留下的启动参数', head: ['', '地址'], rows: [
            ['虚拟地址', '0xFFFF888000099800'],
            ['减去直接映射起点', '− 0xFFFF888000000000'],
            ['= 物理地址', '0x99800（boot_params 所在）'],
          ], hl: [2],
        },
      },
      {
        say: '低半部分现在是空的：用户程序还没出现。等第一个用户程序启动，它会有一张自己的页表',
        hit: ['vm'],
      },
    ],
  },
  {
    id: 'sched', title: '进程与调度',
    ops: [
      {
        say: 'rest_init：创建 1 号进程 kernel_init 和 2 号进程 kthreadd',
        code: 'lx-rest', line: 'pid = user_mode_thread(kernel_init, NULL, CLONE_FS);', insn: 'user_mode_thread(kernel_init, …)', mean: '创建 1 号进程',
        set: { rip: '0xffffffff817927bb', rsp: '0xffffffff81e03ec8', rax: '0xffff8880029b8e80' },
        focus: tasks([['0', 'swapper（启动任务）', '运行中'], ['1', 'kernel_init', '就绪'], ['2', 'kthreadd', '就绪']]),
      },
      {
        say: '每个任务在内核里有一份“档案” task_struct：编号、状态、用哪套页表、内核栈在哪、被换下时 RSP 存在哪',
        focus: {
          kind: 'table', title: '任务档案 task_struct（重要字段）', head: ['字段', '0 号 swapper', '1 号 kernel_init'], rows: [
            ['pid 编号', '0', '1'],
            ['__state 状态', '运行中', '就绪（等 CPU）'],
            ['mm 用户页表', '无（内核线程）', '无（还在内核里）'],
            ['stack 内核栈', '0xFFFFFFFF81E00000 起', '0xFFFFC90000010000 起，16 KB'],
            ['thread.sp 保存的 RSP', '换下时才写', '新栈顶附近'],
          ],
        },
      },
      {
        say: '调度器维护一个“就绪队列”：所有等着用 CPU 的任务排在里面，它负责挑下一个',
        focus: tasks([['0', 'swapper（启动任务）', '运行中'], ['1', 'kernel_init', '就绪'], ['2', 'kthreadd', '就绪']]),
      },
      {
        say: '0 号任务调用 schedule()：调度器从就绪队列里挑出 1 号 kernel_init',
        code: 'lx-rest', line: 'schedule_preempt_disabled();', insn: 'schedule()', mean: '挑选下一个任务',
      },
      {
        say: '切换第 1 步：新任务有自己的用户页表吗？kernel_init 是内核线程，没有，所以 CR3 不用换',
        code: 'lx-ctxsw', line: 'if (!next->mm) {', insn: 'if (!next->mm)', mean: '内核线程：借用当前页表',
        hit: ['ctl.cr3'],
      },
      {
        say: '切换第 2 步：把旧任务的 RBP、RBX 等寄存器压到它自己的内核栈上保存',
        code: 'lx-swasm', line: 'pushq	%rbp', insn: 'pushq %rbp ; pushq %rbx ; …', mean: '保存旧任务的寄存器',
        hit: ['reg.rbp', 'reg.rbx', 'reg.rsp'],
      },
      {
        say: '切换第 3 步：把 RSP 存进旧任务的档案，再从新任务的档案里取出它的 RSP。栈换了，任务就换了',
        tts: '切换第 3 步：把 RSP 存进旧任务的档案，再从新任务的档案里取出它的 RSP。栈换了，任务就换了',
        code: 'lx-swasm', line: 'movq	TASK_threadsp(%rsi), %rsp', insn: 'movq %rsp, prev->thread.sp ; movq next->thread.sp, %rsp', mean: 'RSP ← 新任务的内核栈',
        set: { rsp: '0xffffc90000013f28' }, hit: ['reg.rsp'],
      },
      {
        say: '切换第 4 步：从新栈里弹出新任务的寄存器，ret 返回：RIP 变成新任务的代码，kernel_init 开始运行',
        tts: '切换第 4 步：从新栈里弹出新任务的寄存器，然后返回。RIP 变成新任务的代码，kernel_init 开始运行',
        code: 'lx-swasm', line: 'jmp	__switch_to', insn: 'popq … ; ret', mean: 'RIP ← 新任务继续的位置',
        set: { rip: '0xffffffff81792800', rax: '0x0' }, hit: ['reg.rip'],
        focus: tasks([['0', 'swapper → 以后做 idle', '就绪'], ['1', 'kernel_init', '运行中'], ['2', 'kthreadd', '就绪']]),
      },
      {
        say: '总结：切换任务 = 换 RSP（栈）、换 RIP（从哪继续）；如果是不同的用户进程，还要换 CR3（页表）',
        hit: ['reg.rsp', 'reg.rip', 'ctl.cr3'],
      },
    ],
  },
  {
    id: 'init', title: '1 号进程：从内核走到用户程序',
    ops: [
      {
        say: '1 号进程执行几百个初始化函数：驱动在这里找到硬件，比如 virtio 磁盘、串口',
        code: 'lx-kinitf', line: 'do_initcalls();', insn: 'do_initcalls();', mean: '依次调用所有驱动的初始化函数',
        set: { rip: '0xffffffff82057995', rsp: '0xffffc90000013ee0' }, hit: ['disk'],
      },
      {
        view: 512 * MB, say: '把 initramfs 包解开，变成内存里的文件：/init、/bin/busybox ……',
        code: 'lx-initramfs', line: 'initramfs_cookie = async_schedule_domain(do_populate_rootfs, NULL,', insn: 'do_populate_rootfs()', mean: '解包 cpio 格式的文件',
        set: { rip: '0xffffffff820579b7' }, mem: [reg('files')], flow: [{ from: 'mem.initrd', to: 'mem.files', label: '解包' }],
        focus: { kind: 'table', title: 'initramfs 里的文件', head: ['路径', '作用'], rows: [['/init', '第一个用户程序（脚本）'], ['/bin/busybox', '各种命令合在一个程序里'], ['/dev  /proc  /sys', '挂载点'], ['/newroot', '稍后挂真正的根磁盘']] },
      },
      {
        view: 512 * MB, say: '释放只在启动时用过的内存',
        code: 'lx-kinit', line: 'free_initmem();', insn: 'free_initmem();', mean: '回收启动专用内存',
        set: { rip: '0xffffffff81792876', rsp: '0xffffc90000013f20' }, memOff: ['kinit', 'zkernel', 'reloc', 'pt0', 'initrd'], hit: ['mem.free'],
      },
      {
        view: 64 * MB, say: '执行 /init：1 号进程从内核线程变成第一个用户程序',
        code: 'lx-kinit', line: 'ret = run_init_process(ramdisk_execute_command);', insn: 'run_init_process("/init")', mean: '内核里的 execve',
        set: { rip: '0xffffffff812c5630', rsp: '0xffffc90000013ef0' },
      },
      {
        say: 'execve 先给 /init 分配一张新的、空的顶层页表 PML4（4 KB），放在空闲内存里',
        code: 'lx-pgdctor', line: 'static void pgd_ctor(struct mm_struct *mm, pgd_t *pgd)', insn: 'pgd_alloc()', mean: '分配一页做新页表',
        mem: [reg('proc')], hit: ['mem.proc'],
      },
      {
        say: '把内核页表的高半部分（第 256–511 项）原样抄进来：所以每个进程都能看到同一个内核',
        tts: '把内核页表的高半部分原样抄进来：所以每个进程都能看到同一个内核',
        code: 'lx-pgdctor', line: 'clone_pgd_range(pgd + KERNEL_PGD_BOUNDARY,', insn: 'clone_pgd_range(pgd + 256, swapper_pg_dir + 256, 256)', mean: '抄 256 项内核映射',
        flow: [{ from: 'mem.kdata', to: 'mem.proc', label: '256 项' }],
        focus: {
          kind: 'table', title: '/init 的页表（PML4）', head: ['PML4 项', '虚拟地址', '内容'], rows: [
            ['第 0 – 255 项', '0x0000… – 0x00007FFF…', '/init 自己的（马上填）'],
            ['第 256 – 511 项', '0xFFFF8000… 以上', '抄自内核页表，所有进程都一样'],
          ], hl: [1],
        },
      },
      {
        say: 'exec_mmap：扔掉旧的地址空间，换上新的，并把 CR3 写成新页表 0x3118000',
        tts: 'exec_mmap：扔掉旧的地址空间，换上新的，并把新页表的地址写进 CR3',
        code: 'lx-execmmap', line: 'activate_mm(active_mm, mm);', insn: 'activate_mm() → mov %rax, %cr3', mean: 'CR3 ← 0x3118000',
        set: { cr3: '0x3118000' }, hit: ['ctl.cr3'],
        focus: tasks([['0', 'idle', '就绪'], ['1', '/init（用户程序）', '运行中'], ['2', 'kthreadd', '睡眠']]),
      },
      {
        say: '读 /init 的文件头，登记：虚拟 0x400000 起放代码，0x7FFFFFFDE000 起放栈。物理页这时还没分配',
        tts: '读 /init 的文件头，登记哪段虚拟地址放代码、哪段放栈。物理页这时还没真正分配',
        code: 'lx-kinit', line: 'ret = run_init_process(ramdisk_execute_command);',
        vm: [map('utext'), map('ustack')], hit: ['vm'],
      },
      {
        say: 'CPU 切到用户态（Ring 3）：CS = 0x33，权限变低，不能再碰内核的东西',
        code: 'ix-init', line: '#!/bin/sh', insn: 'sysretq / iretq', mean: '返回用户态：CS ← 0x33',
        cpl: 3, seg: { cs: ['0x33', '0x0'] }, set: { rip: '0x57c509', rsp: '0x7fffffffebc8', rax: '0x5' }, hit: ['mode', 'seg.cs'],
      },
      {
        say: '第一次取 0x57C509 处的指令：页表里这一页还是空的，CPU 触发“缺页异常”（14 号），出错地址记在 CR2',
        tts: '第一次取这条指令时，页表里这一页还是空的。CPU 触发缺页异常，把出错的地址记下来，跳进内核',
        code: 'lx-pf', line: 'address = cpu_feature_enabled(X86_FEATURE_FRED) ? fred_event_data(regs) : read_cr2();', insn: '#PF → IDT[14] → exc_page_fault', mean: 'CR2 = 0x57C509，跳进内核处理',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { rip: '0xffffffff81801330' }, unit: 'mmu', flow: [{ from: 'ctl.idtr', to: 'insn', label: 'IDT[14]' }],
      },
      {
        say: '内核分配一个 4 KB 物理页，把 /init 文件对应的内容读进去，填进页表，再回到用户态重新执行这条指令',
        tts: '内核分配一个 4 KB 的物理页，把文件对应的内容读进去，填进页表，再回到用户态重新执行这条指令',
        code: 'lx-pf', line: 'handle_page_fault(regs, error_code, address);', insn: 'handle_mm_fault() ; iretq', mean: '补上页表项，重新执行',
        cpl: 3, seg: { cs: ['0x33', '0x0'] }, set: { rip: '0x57c509' }, flow: [{ from: 'mem.files', to: 'mem.proc', label: '4 KB' }], hit: ['mem.proc'],
      },
      {
        say: '这叫“按需分页”：用到哪一页才真正分配哪一页。程序刚启动时会连续发生很多次缺页',
        hit: ['vm', 'mem.proc'],
      },
    ],
  },
  {
    id: 'root', title: '挂载真正的根磁盘',
    ops: [
      {
        say: '/init 是个脚本：先挂载 /dev、/proc、/sys',
        code: 'ix-init', line: '/bin/mount -t devtmpfs devtmpfs /dev',
      },
      {
        say: '每次 mount 都是一次“系统调用”：用户程序执行 syscall 指令，CPU 跳进内核',
        code: 'lx-syscall', line: 'SYM_CODE_START(entry_SYSCALL_64)', insn: 'syscall', mean: 'CPL 3 → 0，RIP ← 内核入口',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { rip: '0xffffffff81800080' }, hit: ['mode', 'seg.cs'],
      },
      {
        say: '内核替它干完活，再用 sysretq 回到用户态',
        code: 'lx-syscall', line: 'call	do_syscall_64', insn: 'call do_syscall_64 … sysretq', mean: '处理系统调用，返回用户态',
        cpl: 3, seg: { cs: ['0x33', '0x0'] }, set: { rip: '0x57c509' }, hit: ['mode'],
      },
      {
        say: '/init 要运行 mount 命令：先 fork 出一个子进程。子进程拿到父进程页表的副本',
        code: 'lx-cow', line: 'if (is_cow_mapping(src_vma->vm_flags) && pte_write(pte)) {', insn: 'fork() → copy_page_range()', mean: '复制页表，不复制内存页',
        flow: [{ from: 'mem.proc', to: 'mem.proc', label: '页表副本' }],
      },
      {
        say: '“写时复制”：父子两边的页都先标成只读、共享同一份物理页。谁先写，才给谁复制一份',
        code: 'lx-cow', line: 'wrprotect_ptes(src_mm, addr, src_pte, nr);', insn: 'wrprotect_ptes()', mean: '页表项去掉“可写”位',
        hit: ['mem.proc'],
      },
      {
        say: '调度器切到子进程：它是另一个用户进程，所以 CR3 换成它的页表 0x3116000',
        tts: '调度器切到子进程：它是另一个用户进程，所以 CR3 换成它自己的页表',
        code: 'lx-loadcr3', line: 'write_cr3(new_mm_cr3);', insn: 'mov %rax, %cr3', mean: 'CR3 ← 0x3116000',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { cr3: '0x3116000' }, hit: ['ctl.cr3'],
        focus: tasks([['0', 'idle', '就绪'], ['1', '/init', '睡眠（等子进程）'], ['2', 'kthreadd', '睡眠'], ['…', 'mount（子进程）', '运行中']]),
      },
      {
        say: '子进程再 exec 成 mount 程序，等磁盘 /dev/vda 出现，然后挂载它：磁盘上是 ext2 文件系统',
        code: 'ix-init', line: '/bin/mount -t ext2 /dev/vda /newroot || exec /bin/sh',
      },
      {
        say: '内核读磁盘的“超级块”：磁盘把数据直接写进内存，再检查“魔数” EF53',
        code: 'lx-ext2', line: 'if (!(bh = sb_bread(sb, logic_sb_block))) {', insn: 'sb_bread(sb, 1)', mean: '读 1 KB 超级块',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { rip: '0xffffffff813eee70', rsp: '0xffffc90000137d98', cr3: '0x3116000' },
        flow: [{ from: 'disk', to: 'mem.files', label: '超级块' }], hit: ['disk'],
        screen: { add: ['[2.086726] ext2 filesystem being mounted at /newroot'] },
      },
      {
        say: 'mount 进程做完就退出，它的页表被释放。调度器切回 /init，CR3 换回 0x3118000',
        tts: 'mount 进程做完就退出，它的页表被释放。调度器切回 /init，CR3 换回 /init 的页表',
        code: 'lx-loadcr3', line: 'write_cr3(new_mm_cr3);', insn: 'mov %rax, %cr3', mean: 'CR3 ← 0x3118000',
        set: { cr3: '0x3118000' }, hit: ['ctl.cr3'],
        focus: tasks([['0', 'idle', '就绪'], ['1', '/init', '运行中'], ['2', 'kthreadd', '睡眠']]),
      },
      {
        say: '把 /dev、/proc、/sys 搬到新根下面',
        code: 'ix-init', line: '/bin/mount --move /dev /newroot/dev',
        set: { rip: '0xffffffff812ec4a0' },
      },
      {
        say: 'switch_root：把根目录换成磁盘上的系统，然后执行磁盘上的 /sbin/init',
        code: 'ix-init', line: 'exec /bin/switch_root /newroot /sbin/init',
        cpl: 3, seg: { cs: ['0x33', '0x0'] }, set: { rip: '0x57ecd9', rsp: '0x7fffffffea90', cr3: '0x3118000' }, flow: [{ from: 'disk', to: 'mem.proc', label: '/sbin/init' }],
        focus: tasks([['0', 'idle', '就绪'], ['1', '/sbin/init（磁盘上的）', '运行中'], ['2', 'kthreadd', '睡眠']]),
      },
    ],
  },
  {
    id: 'shell', title: '启动 shell，等你输入',
    ops: [
      {
        say: 'switch_root 最后 exec 磁盘上的 /sbin/init：还是 1 号进程，但用户页表整个换新，CR3 = 0x3114000',
        tts: 'switch_root 最后执行磁盘上的 /sbin/init：还是 1 号进程，但用户页表整个换新',
        code: 'lx-execmmap', line: 'activate_mm(active_mm, mm);', insn: 'execve("/sbin/init") → activate_mm()', mean: 'CR3 ← 0x3114000',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { cr3: '0x3114000' }, hit: ['ctl.cr3'],
      },
      {
        say: '/sbin/init 读配置文件 /etc/inittab：先运行 /etc/rcS，再在终端上启动 shell',
        code: 'rf-inittab', line: '::sysinit:/etc/rcS', cpl: 3, seg: { cs: ['0x33', '0x0'] },
        set: { rip: '0x5b2504', rsp: '0x7fffffffeb48', cr3: '0x3114000' }, flow: [{ from: 'disk', to: 'mem.proc', label: 'inittab' }],
      },
      {
        say: 'init fork 出一个子进程来运行 rcS 脚本。它的页表正好用上了 mount 释放的那一页：CR3 = 0x3116000',
        tts: 'init fork 出一个子进程来运行 rcS 脚本。它的页表正好用上了 mount 刚释放的那一页',
        code: 'lx-loadcr3', line: 'write_cr3(new_mm_cr3);', insn: 'fork() ; 切换 → mov %rax, %cr3', mean: 'CR3 ← 0x3116000',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { cr3: '0x3116000' }, hit: ['ctl.cr3'],
        focus: tasks([['0', 'idle', '就绪'], ['1', '/sbin/init', '睡眠（等子进程）'], ['2', 'kthreadd', '睡眠'], ['…', 'rcS（子进程）', '运行中']]),
      },
      {
        say: 'rcS 设置主机名，打印欢迎语',
        code: 'rf-rcs', line: 'hostname linux-lab', cpl: 3, seg: { cs: ['0x33', '0x0'] },
        set: { rip: '0x4b25b0', cr3: '0x3116000' },
        screen: { add: ['', 'Linux Observatory / Linux 6.12.112', 'Real kernel, real processes, real virtio disk.'] }, flow: [{ from: 'cpu', to: 'screen', label: '文字' }],
      },
      {
        say: 'rcS 结束后，init 再 fork + exec 出 shell（/bin/sh）：又一个进程，又一张页表，CR3 = 0x329C000',
        tts: 'rcS 结束后，init 再创建出 shell 进程：又一个进程，又一张页表',
        code: 'rf-inittab', line: 'ttyS0::respawn:/bin/cttyhack /bin/sh -l',
        set: { rip: '0x564697', rsp: '0x7fffffffeba8', cr3: '0x329c000' },
        focus: tasks([['0', 'idle', '就绪'], ['1', '/sbin/init', '睡眠'], ['2', 'kthreadd', '睡眠'], ['63', '/bin/sh', '运行中']]),
      },
      {
        say: 'shell 打印提示符 linux-lab:/root#',
        screen: { add: ['', 'linux-lab:/root# '] }, flow: [{ from: 'cpu', to: 'screen' }],
      },
      {
        say: 'shell 去读键盘输入。还没人打字，于是内核让它睡觉，挂在终端上等待',
        code: 'lx-npoll', line: 'poll_wait(file, &tty->read_wait, wait);', insn: 'poll() → n_tty_poll()', mean: '登记到终端的等待队列，然后睡眠',
        cpl: 0, seg: { cs: ['0x10', '0x0'] }, set: { rip: '0xffffffff815c28e0', rsp: '0xffffc90000137ab0' },
        focus: tasks([['0', 'idle', '就绪'], ['1', '/sbin/init', '睡眠'], ['2', 'kthreadd', '睡眠'], ['63', '/bin/sh', '睡眠（等输入）']]),
      },
      {
        say: '所有进程都在等，CPU 换上 0 号任务 idle 执行 hlt 休息。idle 是内核线程，CR3 不用换，继续借用 shell 的',
        tts: '所有进程都在等，CPU 换上 0 号任务 idle，执行 hlt 休息。idle 是内核线程，页表不用换，继续借用 shell 的',
        code: 'lx-idle', line: 'raw_safe_halt();', insn: 'sti ; hlt', mean: '停机，直到中断到来',
        set: { rip: '0xffffffff81791d73', rsp: '0xffffffff81e03e28', cr3: '0x329c000', if: 1 }, unit: 'idle',
        focus: tasks([['0', 'idle', '运行中（hlt）'], ['1', '/sbin/init', '睡眠'], ['2', 'kthreadd', '睡眠'], ['63', '/bin/sh', '睡眠（等输入）']]),
      },
    ],
  },
  {
    id: 'key', title: '你按下一个键',
    ops: [
      {
        say: '你在终端里敲了一个 l。串口芯片收到这个字符，向 CPU 发出中断信号 IRQ 4',
        tts: '你在终端里敲了一个字母 L。串口芯片收到这个字符，向 CPU 发出中断信号',
        flow: [{ from: 'kbd', to: 'cpu', label: 'IRQ 4' }], unit: 'irq', hit: ['kbd'],
      },
      {
        say: 'CPU 醒来，停下手头的事，查中断描述符表 IDT，跳到串口的中断处理程序',
        code: 'lx-8250', line: 'void serial8250_read_char(struct uart_8250_port *up, u16 lsr)', insn: 'int → IDT[vector]', mean: '保存现场，跳进中断处理',
        flow: [{ from: 'ctl.idtr', to: 'insn', label: '查 IDT' }], unit: 'irq', hit: ['ctl.idtr'],
      },
      {
        say: '处理程序从串口芯片的数据端口读出这个字符：0x6C，就是字母 l',
        code: 'lx-8250', line: 'ch = serial_in(up, UART_RX);', insn: 'inb $0x3f8, %al', mean: '读端口 0x3F8 → AL = 0x6C',
        set: { rax: '0x6c' }, flow: [{ from: 'kbd', to: 'reg.rax', label: "'l'" }],
      },
      {
        say: '字符放进终端的输入缓冲，同时“回显”到屏幕上',
        code: 'lx-ntty', line: 'echo_char(c, tty);', insn: 'echo_char(c); put_tty_queue(c);', mean: '回显，并放进输入缓冲区',
        screen: { type: 'l' }, flow: [{ from: 'cpu', to: 'screen', label: 'l' }],
      },
      {
        say: '唤醒等待输入的 shell：调度器把它重新放上 CPU，它读到了字母 l',
        focus: tasks([['0', 'idle', '就绪'], ['1', '/sbin/init', '睡眠'], ['2', 'kthreadd', '睡眠'], ['63', '/bin/sh', '运行中']]),
        cpl: 3, seg: { cs: ['0x33', '0x0'] }, set: { rip: '0x564bdc', rsp: '0x7fffffffeb98', rax: '0x1' }, hit: ['mode'],
      },
      {
        view: 512 * MB, say: '这就是一台电脑从通电到能敲命令的全过程：BIOS、GRUB、内核、1 号进程、shell',
        spot: ['cpu', 'mem', 'code', 'dev'],
      },
    ],
  },
];
