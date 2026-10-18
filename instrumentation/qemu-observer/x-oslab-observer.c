/*
 * x-oslab-observer.c —— QEMU 观察扩展（T05a 停止快照 + T05b 事件序列）
 *
 * 对应总体方案 6.2 的最小合同：
 *   x-oslab-capabilities   协议版本、可观测 CPU/内存字段、事件能力、是否支持
 *                          停止屏障、当前丢失事件计数
 *   x-oslab-capture        确认全部 vCPU 停止后冻结一份快照，返回 captureId、
 *                          CPU 扩展状态、物理内存区域表、eventWatermark
 *   x-oslab-read-physical  仅在 captureId 有效且 VM 未推进时读取允许的 RAM/ROM；
 *                          超范围、MMIO、不可直读区域一律拒绝
 *   x-oslab-events         按 seq 分块读取事件序列，显式报告过滤、截断与丢失；
 *                          同时是事件采集的开关（enable / reset）
 *   x-oslab-release        释放冻结资源
 *
 * ---------------------------------------------------------------------------
 * 线程与锁上下文（T05 验收要求逐项说明）
 *
 * 五个命令都用 qmp_register_command(..., options = 0) 注册：既不是 OOB
 * （QCO_ALLOW_OOB）也不是协程（QCO_COROUTINE）。qmp_dispatch() 对这类命令走
 * aio_bh_schedule_oneshot(qemu_get_aio_context(), do_qmp_dispatch_bh, ...)
 * （qapi/qmp-dispatch.c do_qmp_dispatch_bh -> cmd->fn）。也就是说：
 *   - 执行线程：main loop 线程（不是 vCPU 线程、不是 I/O 线程）；
 *   - 持锁：BQL（main loop 主要在 BQL 下运行，BH 在 main loop 内被消费）。
 * BQL + main loop 正是 QEMU 串行化「设备状态」和「内存拓扑」的边界：
 *   - TCG 的 vCPU 线程在进入执行循环前必须拿 BQL；
 *   - 块层完成回调走主循环的 BH / AIO，同样在 BQL 内运行；
 *   - 内存区域变更（memory listener、MemoryRegion enable/disable）在 BQL 内发生。
 * 因此在 BQL 内读 CPU / 内存区域不会读到「改到一半」的状态。
 *
 * 入口额外断言 qemu_mutex_iothread_locked()，防止以后有人把它改成 OOB 命令
 * （OOB 在协程里跑、不持 BQL）而静默破坏快照一致性。
 *
 * `x-oslab-events` 的**读取**只是遍历事件环：环由 vCPU 线程（TCG 生成的代码，
 * 以及 target 里的 C 层记录入口）写入，用 x-oslab-events 自己的 QemuSpin 保护，
 * 与 BQL 无关，因此读事件不要求 vCPU 停止。但**开关**（enable / reset）改变的是
 * 「翻译期是否发射观测 op」：QEMU 不会重新翻译已经建好的 TB，所以把采集打开之后
 * 必须 tb_flush() 让旧 TB 失效，否则旧 TB 仍然不带观察点、会静默少报事件。
 * 因此 enable / reset 只在 VM 未运行时接受，运行中直接拒绝（reason=vm-running），
 * 不做「尽力而为」的假成功。
 *
 * ---------------------------------------------------------------------------
 * 观察点（源码位置，T05 要求给出）
 *
 *   CPU 扩展状态    target/i386/cpu.h:1613  CPUX86State.segs[6]（SegmentCache）
 *                   target/i386/cpu.h:1619  CPUX86State.cr[5]（CR0..CR4）
 *                   target/i386/cpu.h:1628  CPUX86State.efer
 *                   target/i386/cpu.h:1616/1617 CPUX86State.gdt / .idt
 *                   target/i386/cpu.h:1290  SegmentCache{selector,base,limit,flags}
 *   CR8 (TPR)       include/hw/i386/apic.h:15 cpu_get_apic_tpr()
 *   vCPU 停止标志   include/hw/core/cpu.h:477 CPUState.stopped
 *   VM 运行状态     include/sysemu/runstate.h runstate_get() / runstate_is_running()
 *   VM 推进检测     qemu_add_vm_change_state_handler()（system/runstate.c:320），
 *                   每次「VM 由停止变为运行」把代数 +1
 *   内存区域表      flatview_for_each_range()（FlatRange 由 system/memory.c 提供）
 *   物理可读判定    memory_access_is_direct(mr, false)（include/exec/memory.h:2956）：
 *                   RAM 且非 ram_device，或 romd 且 romd_mode。只有这一支
 *                   才是「memcpy 直读」，不会派发到设备 ops，因此没有副作用。
 *   事件序列        accel/tcg/translator.c:translator_loop() —— instruction.begin，
 *                   以及 db->is_jmp == DISAS_NEXT 时的 instruction.retire
 *                   tcg/tcg-op-ldst.c 的 4 个 tcg_gen_qemu_ld/st_i32/i64_int ——
 *                   memory.read / memory.write（翻译期为每个 ld/st op 发一个观测
 *                   op，运行期记下实际地址与读到的值）
 *                   target/i386/tcg/sysemu/misc_helper.c 的 helper_inb/inw/inl
 *                   与 helper_outb/outw/outl —— io.read / io.write
 *                   （客体 in/out 指令走这条路径；HMP 的 i/o 探针走
 *                    system/ioport.c，故意不记录，免得污染客体事件流）
 *                   target/i386/tcg/seg_helper.c:do_interrupt_all() ——
 *                   exception.raise / interrupt.accept（按 is_hw / is_int 分类）
 *   事件环          accel/tcg/x-oslab-events.c（固定容量 65536 条，QemuSpin 保护，
 *                   seq 从 1 起全局递增，环满时覆盖最旧并累加 dropped）
 *
 * 明确不做（留给后续子任务，capabilities 里如实标注）：
 *   T05e  采集串行化边界与已有 pending I/O 的分类
 *   T06   逻辑扇区版本存储（diskVersions 返回空对象）
 *   T05d 之后的设备级事件：irq.raise/lower、input.accept、serial.output
 *         （设备快照本身自 T05d 起可用，见 x-oslab-capture.devices）
 */

#include "qemu/osdep.h"

#include "qapi/error.h"
#include "qapi/qmp/dispatch.h"
#include "qapi/qmp/qdict.h"
#include "qapi/qmp/qlist.h"
#include "qapi/qmp/qnull.h"
#include "qapi/qmp/qobject.h"
#include "qapi/qmp/qstring.h"
#include "qemu/int128.h"
#include "qemu/main-loop.h"
#include "qemu/rcu.h"
#include "sysemu/runstate.h"
#include "hw/core/cpu.h"
#include "exec/address-spaces.h"
#include "exec/memory.h"
#include "exec/tb-flush.h"
#include "exec/x-oslab-events.h"

#include "monitor/x-oslab-observer.h"

/* T05d：VGA 私有只读快照接口（补丁 0004）。头文件本身 target 无关。 */
#include "hw/x-oslab-devices.h"

#ifdef TARGET_I386
#include "target/i386/cpu.h"
#include "hw/i386/apic.h"

/*
 * T05d 设备快照需要的设备结构体。这些结构体本身就定义在 include/ 下
 * （UART / i8042 / PIC / PIT / APIC / virtio），观察层只要 include 就能直接读
 * 字段，不需要为它们打补丁——只有 VGA 是例外（结构体在 hw/display/vga_int.h
 * 且被内嵌在 PCIVGAState 里，无法从 QOM 反查）。
 */
#include "hw/char/serial.h"
#include "hw/input/i8042.h"
#include "hw/input/ps2.h"
#include "hw/isa/i8259_internal.h"
#include "hw/intc/i8259.h"
#include "hw/timer/i8254_internal.h"
#include "hw/i386/apic_internal.h"
#include "hw/pci/pci_device.h"
#include "hw/virtio/virtio.h"
#include "standard-headers/linux/virtio_ids.h"
#include "qapi/qapi-commands-virtio.h"
#include "qapi/qapi-types-virtio.h"
#endif

#define X_OSLAB_PROTO_SCHEMA    "x-oslab/1"
#define X_OSLAB_PROTO_VERSION   1
/* 单次物理读上限：一个 4 KiB 页，避免一次请求跨越大量区域或撑爆 JSON。 */
#define X_OSLAB_MAX_READ_BYTES  4096
/* 区域表上限：PC 机器实际约 40~80 个 FlatRange。 */
#define X_OSLAB_MAX_REGIONS     512

typedef struct XOslabCaptureState {
    bool active;
    char *id;
    uint64_t serial;
    uint64_t vmGeneration;
    int64_t capturedAtNs;
    uint64_t eventWatermark;
    /*
     * T05e：这一帧的帧分界事件 seq。
     * 采集打开时它等于 eventWatermark（fence 就是最后一条属于本帧的事件）；
     * 未记录（采集关闭，或该 kind 被记录期掩码排除）时为 0，此时 eventWatermark
     * 退回「采集当时的水位线」，读取方据此知道本帧没有 fence 标记。
     */
    uint64_t fenceSeq;
    /* T05e：采集这一刻仍在飞行、尚未对客体可见的块请求数（fence 的 value）。 */
    uint32_t pendingCount;
    /* 其中「宿主完成回调已经进入、状态字节还没回写」的条数。 */
    uint32_t pendingHostDoneCount;
} XOslabCaptureState;

static XOslabCaptureState x_oslab_capture_state;

/*
 * VM 代数：每次观察到「VM 由停止变为运行」就 +1。
 * capture 记录当时的代数，x-oslab-read-physical 用它判断快照是否已经过期
 * （VM 中间跑过又停了，旧 captureId 也必须失效）。
 */
static uint64_t x_oslab_vm_generation;

/*
 * 事件序列依赖 TCG：观测 op 是在翻译期发射的。非 TCG 构建里 events.supported
 * 必须如实为 false，不能因为「字段都在」就冒充能力。
 */
#ifdef CONFIG_TCG
#define X_OSLAB_EVENTS_AVAILABLE 1
#else
#define X_OSLAB_EVENTS_AVAILABLE 0
#endif

/* ------------------------------------------------------------------ 小工具 */

static void qput_hex(QDict *dict, const char *key, uint64_t value)
{
    char buf[32];

    g_snprintf(buf, sizeof(buf), "0x%" PRIx64, value);
    qdict_put_str(dict, key, buf);
}

static void qput_u64(QDict *dict, const char *key, uint64_t value)
{
    char buf[32];

    g_snprintf(buf, sizeof(buf), "%" PRIu64, value);
    qdict_put_str(dict, key, buf);
}

/*
 * 接受 "0x..." / 十进制字符串 / JSON 整数三种写法。
 * 协议里地址与长度统一用字符串，但为了手工调试也允许整数。
 */
static bool x_oslab_arg_u64(QDict *args, const char *key, uint64_t *out)
{
    const char *text = qdict_get_try_str(args, key);

    if (text != NULL) {
        char *end = NULL;
        unsigned long long value;

        errno = 0;
        value = g_ascii_strtoull(text, &end, 0);
        if (errno != 0 || end == text) {
            return false;
        }
        while (*end == ' ') {
            end++;
        }
        if (*end != '\0') {
            return false;
        }
        *out = (uint64_t)value;
        return true;
    }
    if (qdict_haskey(args, key)) {
        int64_t value = qdict_get_try_int(args, key, -1);

        if (value < 0) {
            return false;
        }
        *out = (uint64_t)value;
        return true;
    }
    return false;
}

static const char *x_oslab_vm_state_name(void)
{
    return RunState_str(runstate_get());
}

/* ------------------------------------------------------------------ 内存区域 */

static const MemoryRegion *x_oslab_terminal_mr(const MemoryRegion *mr)
{
    const MemoryRegion *m = mr;

    while (m != NULL && m->alias != NULL) {
        m = m->alias;
    }
    return m;
}

static const char *x_oslab_mr_kind(const MemoryRegion *mr)
{
    const MemoryRegion *term = x_oslab_terminal_mr(mr);

    if (term == NULL) {
        return "unassigned";
    }
    if (term->is_iommu) {
        return "iommu";
    }
    if (term->ram_device) {
        return "ram-device";
    }
    if (term->ram) {
        return term->readonly ? "rom" : "ram";
    }
    if (term->rom_device) {
        return term->romd_mode ? "romd" : "rom-device";
    }
    return "mmio";
}

/*
 * 只有 memory_access_is_direct(mr, false) 为真的区域才是 memcpy 直读：
 *   RAM 且非 ram_device，或 romd 且 romd_mode。
 * 其余（MMIO 寄存器、未 ROMD 的 rom_device、IOMMU、未分配、ram_device）
 * 一旦读取就会派发到设备 ops，可能取走 FIFO 数据或确认一次中断，必须拒绝。
 */
static bool x_oslab_mr_readable(const MemoryRegion *mr)
{
    const MemoryRegion *term = x_oslab_terminal_mr(mr);

    return term != NULL && memory_access_is_direct((MemoryRegion *)term, false);
}

typedef struct XOslabRegionScan {
    QList *list;
    int count;
    int readable;
} XOslabRegionScan;

static bool x_oslab_region_cb(Int128 start, Int128 len, const MemoryRegion *mr,
                              hwaddr offset_in_region, void *opaque)
{
    XOslabRegionScan *scan = opaque;
    const MemoryRegion *term = x_oslab_terminal_mr(mr);
    QDict *entry;

    (void)offset_in_region;

    if (scan->count >= X_OSLAB_MAX_REGIONS) {
        return true;
    }
    entry = qdict_new();
    qdict_put_str(entry, "name", (term && term->name) ? term->name : "unnamed");
    qdict_put_str(entry, "kind", x_oslab_mr_kind(mr));
    qdict_put_bool(entry, "readable", x_oslab_mr_readable(mr));
    qput_hex(entry, "base", int128_get64(start));
    qput_hex(entry, "size", int128_get64(len));
    qlist_append(scan->list, entry);

    scan->count++;
    if (x_oslab_mr_readable(mr)) {
        scan->readable++;
    }
    return false;
}

static void x_oslab_collect_regions(QList *list, int *count, int *readable)
{
    XOslabRegionScan scan = { .list = list, .count = 0, .readable = 0 };
    FlatView *fv;

    RCU_READ_LOCK_GUARD();
    fv = address_space_to_flatview(&address_space_memory);
    flatview_for_each_range(fv, x_oslab_region_cb, &scan);
    *count = scan.count;
    *readable = scan.readable;
}

/* ------------------------------------------------------------------ CPU 快照 */

#ifdef TARGET_X86_64
#define X_OSLAB_GPR_COUNT 16
static const char *const x_oslab_gpr_names[X_OSLAB_GPR_COUNT] = {
    "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
    "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
};
#endif

#ifdef TARGET_I386

static void x_oslab_segment(QDict *dict, const char *key, const SegmentCache *sc)
{
    QDict *out = qdict_new();

    qput_hex(out, "selector", sc->selector);
    qput_hex(out, "base", (uint64_t)sc->base);
    qput_hex(out, "limit", sc->limit);
    qput_hex(out, "attributes", sc->flags);
    /* P 位就是 SegmentCache 里「已装载可用」的判据（cpu_x86_load_seg_cache）。 */
    qdict_put_bool(out, "usable", (sc->flags & DESC_P_MASK) != 0);
    qdict_put(dict, key, out);
}

static const char *x_oslab_cpu_mode(const CPUX86State *env, const char **detail)
{
    if (env->hflags & HF_LMA_MASK) {
        if (env->hflags & HF_CS64_MASK) {
            *detail = "long-64";
            return "long-64";
        }
        /* 长模式兼容子模式：协议枚举里没有独立取值，归入 protected-32。 */
        *detail = "long-compat";
        return "protected-32";
    }
    if (env->eflags & VM_MASK) {
        *detail = "vm86";
        return "protected-16";
    }
    if (env->cr[0] & CR0_PE_MASK) {
        if (env->segs[R_CS].flags & DESC_B_MASK) {
            *detail = "protected-32";
            return "protected-32";
        }
        *detail = "protected-16";
        return "protected-16";
    }
    *detail = "real-16";
    return "real-16";
}

static void x_oslab_cpu_snapshot(QList *cpus, CPUState *cs)
{
    X86CPU *xc = X86_CPU(cs);
    CPUX86State *env = &xc->env;
    const char *detail = "unknown";
    const char *mode = x_oslab_cpu_mode(env, &detail);
    QDict *dict = qdict_new();
    QDict *control = qdict_new();
    QDict *efer_bits = qdict_new();
    QDict *gdt = qdict_new();
    QDict *idt = qdict_new();
    QList *gpr = qlist_new();
    QList *gpr_names = qlist_new();
    int i;

    qdict_put_int(dict, "cpuId", cs->cpu_index);
    qdict_put_bool(dict, "stopped", cs->stopped);
    qdict_put_bool(dict, "halted", cs->halted != 0);
    qdict_put_str(dict, "mode", mode);
    qdict_put_str(dict, "modeDetail", detail);
    qdict_put_int(dict, "cpl", (int)(env->hflags & HF_CPL_MASK));
    qput_hex(dict, "rip", (uint64_t)env->eip);
    qput_hex(dict, "rsp", (uint64_t)env->regs[R_ESP]);
    qput_hex(dict, "rflags", (uint64_t)env->eflags);
    qput_hex(dict, "hflags", (uint64_t)env->hflags);
    qput_hex(dict, "hflags2", (uint64_t)env->hflags2);
    qput_hex(dict, "linearPc", (uint64_t)(env->segs[R_CS].base + env->eip));
    qput_hex(dict, "a20Mask", (uint32_t)env->a20_mask);

    for (i = 0; i < CPU_NB_REGS; i++) {
        char buf[32];

        g_snprintf(buf, sizeof(buf), "0x%" PRIx64, (uint64_t)env->regs[i]);
        qlist_append_str(gpr, buf);
#ifdef TARGET_X86_64
        qlist_append_str(gpr_names, x_oslab_gpr_names[i]);
#else
        qlist_append_str(gpr_names, "unimplemented-32bit-name");
#endif
    }
    qdict_put(dict, "gpr", gpr);
    qdict_put(dict, "gprNames", gpr_names);

    x_oslab_segment(dict, "cs", &env->segs[R_CS]);
    x_oslab_segment(dict, "ss", &env->segs[R_SS]);
    x_oslab_segment(dict, "ds", &env->segs[R_DS]);
    x_oslab_segment(dict, "es", &env->segs[R_ES]);
    x_oslab_segment(dict, "fs", &env->segs[R_FS]);
    x_oslab_segment(dict, "gs", &env->segs[R_GS]);
    x_oslab_segment(dict, "ldtr", &env->ldt);
    x_oslab_segment(dict, "tr", &env->tr);

    qput_hex(gdt, "base", (uint64_t)env->gdt.base);
    qput_hex(gdt, "limit", env->gdt.limit);
    qput_hex(idt, "base", (uint64_t)env->idt.base);
    qput_hex(idt, "limit", env->idt.limit);
    qdict_put(dict, "gdt", gdt);
    qdict_put(dict, "idt", idt);

    qput_hex(control, "cr0", (uint64_t)env->cr[0]);
    /* cr1 在硬件上保留未用，QEMU 也不维护，明确给 null 而不是编一个 0。 */
    qdict_put_null(control, "cr1");
    qput_hex(control, "cr2", (uint64_t)env->cr[2]);
    qput_hex(control, "cr3", (uint64_t)env->cr[3]);
    qput_hex(control, "cr4", (uint64_t)env->cr[4]);
    if (xc->apic_state != NULL) {
        qput_hex(control, "cr8", (uint8_t)cpu_get_apic_tpr(xc->apic_state));
    } else {
        qdict_put_null(control, "cr8");
    }
    qdict_put(dict, "control", control);

    qput_hex(dict, "efer", (uint64_t)env->efer);
    qdict_put_bool(efer_bits, "sce", (env->efer & MSR_EFER_SCE) != 0);
    qdict_put_bool(efer_bits, "lme", (env->efer & MSR_EFER_LME) != 0);
    qdict_put_bool(efer_bits, "lma", (env->efer & MSR_EFER_LMA) != 0);
    qdict_put_bool(efer_bits, "nxe", (env->efer & MSR_EFER_NXE) != 0);
    qdict_put_bool(efer_bits, "svme", (env->efer & MSR_EFER_SVME) != 0);
    qdict_put_bool(efer_bits, "ffxsr", (env->efer & MSR_EFER_FFXSR) != 0);
    qdict_put(dict, "eferBits", efer_bits);

    qlist_append(cpus, dict);
}

#else /* !TARGET_I386 */

/*
 * 本扩展按锁定版本只为 x86_64-softmmu 构建。若被编到别的目标上，
 * 不静默返回空 CPU 数组，而是明确报告未实现，避免把「没有字段」当成「字段为 0」。
 */
static void x_oslab_cpu_snapshot(QList *cpus, CPUState *cs)
{
    QDict *dict = qdict_new();

    qdict_put_int(dict, "cpuId", cs->cpu_index);
    qdict_put_bool(dict, "stopped", cs->stopped);
    qdict_put_bool(dict, "halted", cs->halted != 0);
    qdict_put_str(dict, "mode", "unknown");
    qdict_put_str(dict, "modeDetail", "unimplemented-target");
    qdict_put_str(dict, "note", "x-oslab-observer 只实现了 x86 目标");
    qlist_append(cpus, dict);
}

#endif /* TARGET_I386 */

/* ------------------------------------------------------------ 事件序列（T05b） */

/* 单次返回条数的默认值。上限就是环形缓冲容量：协议要求按 seq 分块读，
 * 默认值取一个保守的数，避免一次响应就撑爆 JSON。 */
#define X_OSLAB_DEFAULT_EVENT_LIMIT 1024
/* 每次向事件环取出的批大小；只影响内部循环，不影响返回语义。 */
#define X_OSLAB_EVENT_FETCH_BATCH   1024

/*
 * T05b 真正会产生的 kind（T05c 补上 dma.* 与 block.*，T05e 补上 capture.fence）。
 * 契约里其余 kind 明确列进 unavailableKinds，不用「名字存在」冒充「会产生事件」。
 */
static const XOslabEventKind x_oslab_produced_kinds[] = {
    X_OSLAB_EVK_INSTRUCTION_BEGIN,
    X_OSLAB_EVK_INSTRUCTION_RETIRE,
    X_OSLAB_EVK_MEMORY_READ,
    X_OSLAB_EVK_MEMORY_WRITE,
    X_OSLAB_EVK_DMA_READ,
    X_OSLAB_EVK_DMA_WRITE,
    X_OSLAB_EVK_IO_READ,
    X_OSLAB_EVK_IO_WRITE,
    X_OSLAB_EVK_INTERRUPT_ACCEPT,
    X_OSLAB_EVK_EXCEPTION_RAISE,
    X_OSLAB_EVK_BLOCK_SUBMIT,
    X_OSLAB_EVK_BLOCK_COMPLETE,
    X_OSLAB_EVK_CAPTURE_FENCE,
};

static const XOslabEventKind x_oslab_unavailable_kinds[] = {
    X_OSLAB_EVK_IRQ_RAISE,
    X_OSLAB_EVK_IRQ_LOWER,
    X_OSLAB_EVK_INPUT_ACCEPT,
    X_OSLAB_EVK_SERIAL_OUTPUT,
    X_OSLAB_EVK_OBSERVER_DROP,
};

/* 事件种类的来源，逐条对照源码位置（T05 要求给出观察点）。 */
static const struct {
    const char *key;
    const char *point;
} x_oslab_event_points[] = {
    { "instruction.begin",
      "accel/tcg/translator.c:translator_loop()（plugin_gen_insn_start 之后）" },
    { "instruction.retire",
      "accel/tcg/translator.c:translator_loop()（translate_insn 之后，db->is_jmp 为 "
      "DISAS_NEXT 或 DISAS_TOO_MANY 时发射，即指令确实落到完成路径）" },
    { "memory.read/write",
      "tcg/tcg-op-ldst.c:tcg_gen_qemu_ld/st_i32/i64_int（每个 ld/st op 一发）" },
    { "io.read/write",
      "target/i386/tcg/sysemu/misc_helper.c:helper_inb/inw/inl, helper_outb/outw/outl" },
    { "exception.raise/interrupt.accept",
      "target/i386/tcg/seg_helper.c:do_interrupt_all()（按 is_hw / is_int 分类）" },
    { "dma.read/write",
      "hw/virtio/virtio.c:virtqueue_split_pop() / virtqueue_packed_pop()"
      "（virtqueue_map_desc 映射完成后，按 out/in 描述符逐段上报客体物理区间；"
      "设备把映射得到的宿主指针直接解引用，地址空间层没有可插桩的落点）" },
    { "block.submit",
      "hw/block/virtio-blk.c:virtio_blk_handle_request() 的 VIRTIO_BLK_T_IN 分支"
      "（block_acct_start 之后，此时 sector_num 与 qiov.size 都已确定）" },
    { "block.complete",
      "hw/block/virtio-blk.c:virtio_blk_req_complete()（在 stb_p(&req->in->status) "
      "与 virtqueue_push 之前，status 就是准备回写客体的那个字节）" },
    { "capture.fence",
      "monitor/x-oslab-observer.c:qmp_x_oslab_capture() 的统一串行化点"
      "（全部 vCPU 已停止、main loop + BQL）：先取一份 pending 块请求台账快照，"
      "再记录这条 fence（value = 此刻 pending 数），然后用它的 seq 当这一帧的 "
      "eventWatermark，因此「seq <= fence」与「属于这一帧」是同一件事" },
    { "pendingIo",
      "accel/tcg/x-oslab-events.c 的 pending 台账（QemuSpin 保护，容量 "
      "X_OSLAB_INFLIGHT_CAPACITY）：hw/block/virtio-blk.c 三处驱动它 —— "
      "virtio_blk_handle_request() 登记（紧跟 block.submit）、"
      "virtio_blk_rw_complete() 入口标 hostIoDone、virtio_blk_req_complete() 移除；"
      "virtio_blk_free_request() 与 virtio_cleanup() 是幂等的兜底清理" },
    { "devices",
      "hw/virtio/virtio.c:virtio_init() / virtio_cleanup() 调用"
      "x_oslab_device_register/unregister（名字取 QOM canonical path）" },
    { "ring",
      "accel/tcg/x-oslab-events.c（固定 65536 条环 + QemuSpin + 全局递增 seq）" },
    { "switch",
      "monitor/x-oslab-observer.c:x_oslab_events_switch()（只允许 VM 停止时切换，切换后 tb_flush）" },
};

/** 契约 EventPhase 的取值；按「这条事件代表指令生命周期的哪一段」映射。 */
static const char *x_oslab_event_phase(uint32_t kind)
{
    switch (kind) {
    case X_OSLAB_EVK_INSTRUCTION_BEGIN:
    case X_OSLAB_EVK_BLOCK_SUBMIT:
        /* block.submit 与 instruction.begin 都是「这件事开始了」 */
        return "begin";
    case X_OSLAB_EVK_IRQ_LOWER:
        return "lower";
    case X_OSLAB_EVK_CAPTURE_FENCE:
        return "fence";
    case X_OSLAB_EVK_IRQ_RAISE:
    case X_OSLAB_EVK_INTERRUPT_ACCEPT:
    case X_OSLAB_EVK_EXCEPTION_RAISE:
        return "raise";
    default:
        /* instruction.retire / memory.* / io.* / block.* / input.accept /
         * serial.output / observer.drop 描述的都是「这件事已经发生了」。 */
        return "complete";
    }
}

/** 契约 addressSpace 的取值；无地址的事件（指令、异常）返回 NULL，不硬凑。 */
static const char *x_oslab_event_space_name(uint32_t space)
{
    switch (space) {
    case X_OSLAB_SPACE_LINEAR:
        return "linear";
    case X_OSLAB_SPACE_IO_PORT:
        return "io-port";
    case X_OSLAB_SPACE_PHYSICAL:
        /* 设备 DMA 走 vdev->dma_as，报出来的就是客体物理地址。 */
        return "physical";
    case X_OSLAB_SPACE_DISK_LBA:
        /* 块请求的 address 是 512 字节单位的起始扇区号，不是内存地址。 */
        return "disk-lba";
    default:
        return NULL;
    }
}

/*
 * virtio-blk 的请求类型名与完成状态名。
 *
 * 这两个常量表来自 virtio 规范（VIRTIO_BLK_T_IN = 0、VIRTIO_BLK_T_OUT = 1、
 * VIRTIO_BLK_S_OK = 0、VIRTIO_BLK_S_IOERR = 1、VIRTIO_BLK_S_UNSUPP = 2），
 * 故意不包含 include/hw/virtio/virtio-blk.h：那个头文件会连带拉进目标相关的
 * 定义，而本文件的观察点必须保持与目标无关。认不出来的值如实报 "unknown"，
 * 不猜一个近似名。
 */
static const char *x_oslab_block_op_name(uint32_t req_type)
{
    switch (req_type) {
    case 0:
        return "read";
    case 1:
        return "write";
    default:
        return "unknown";
    }
}

static const char *x_oslab_block_status_name(uint64_t status)
{
    switch (status) {
    case 0:
        return "ok";
    case 1:
        return "ioerr";
    case 2:
        return "unsupp";
    default:
        return "unknown";
    }
}

/**
 * 把一条内部记录序列化成契约形状的 JSON。
 *
 * 顶层字段严格按 packages/contracts/event.ts 的 MachineEvent：
 * seq 是十进制字符串，pc/address 是 Hex 字符串，phase/addressSpace 用契约枚举。
 * 契约里没有落点的原始数值（mmuIndex、flags、vector、errorCode、nextEip、
 * 指令长度、访存数值）放在 detail 子对象里，既不改动契约语义，也不丢信息。
 *
 * 访存的数值用 bytes + byteOrder=little 表达（契约明确「不混用整数与字节序」）：
 * bytes 就是该地址上实际访问的 size 个字节，可直接与 HMP `xp /x1|/x2|/x4` 对照。
 */
static QDict *x_oslab_event_json(const XOslabEventRec *rec)
{
    QDict *event = qdict_new();
    QDict *detail = qdict_new();
    const char *space = x_oslab_event_space_name(rec->space);
    bool is_insn = rec->kind == X_OSLAB_EVK_INSTRUCTION_BEGIN
                   || rec->kind == X_OSLAB_EVK_INSTRUCTION_RETIRE;
    bool is_mem = rec->kind == X_OSLAB_EVK_MEMORY_READ
                  || rec->kind == X_OSLAB_EVK_MEMORY_WRITE;
    bool is_io = rec->kind == X_OSLAB_EVK_IO_READ
                 || rec->kind == X_OSLAB_EVK_IO_WRITE;
    bool is_dma = rec->kind == X_OSLAB_EVK_DMA_READ
                  || rec->kind == X_OSLAB_EVK_DMA_WRITE;
    bool is_block = rec->kind == X_OSLAB_EVK_BLOCK_SUBMIT
                    || rec->kind == X_OSLAB_EVK_BLOCK_COMPLETE;
    bool is_trap = rec->kind == X_OSLAB_EVK_EXCEPTION_RAISE
                   || rec->kind == X_OSLAB_EVK_INTERRUPT_ACCEPT;

    qput_u64(event, "seq", rec->seq);
    qdict_put_str(event, "kind", x_oslab_event_kind_name(rec->kind));
    qdict_put_str(event, "phase", x_oslab_event_phase(rec->kind));

    if (rec->cpuIndex != X_OSLAB_CPU_NONE) {
        qdict_put_int(event, "cpuId", rec->cpuIndex);
    }
    /*
     * T05c：设备归属与请求关联。deviceId 用注册时的设备名（QOM canonical
     * path），requestId 是 (virtqueue 索引, 描述符标识) 的稳定文本形式；
     * 同一个请求的 dma.* 与 block.submit/block.complete 用同一个字符串关联。
     *
     * 设备事件（dma.* / block.*）的归属是必填字段，不能拿 0 当「没有」的哨兵：
     * (virtqueue 0, 描述符 0) 的 requestId 恰好就是 0，而那正是每个队列从头开始
     * 时最常见的第一个请求。按 0 判空会让这个请求的 dma.* 在 JSON 里丢掉
     * requestId（同时丢掉 deviceIndex），留下「有事件、没归属」的洞——block.*
     * 那边的 submit/complete 会照常带上 requestId，关联就此断掉。
     */
    if (is_dma || is_block) {
        const char *name = x_oslab_device_name(rec->deviceId);
        char buf[48];

        qdict_put_str(event, "deviceId",
                      name != NULL ? name : "unregistered-device");
        qdict_put_int(detail, "deviceIndex", rec->deviceId);
        snprintf(buf, sizeof(buf), "vq%u-%u",
                 (unsigned)(rec->requestId >> 32),
                 (unsigned)(rec->requestId & 0xffffffffu));
        qdict_put_str(event, "requestId", buf);
    } else {
        if (rec->deviceId != 0) {
            const char *name = x_oslab_device_name(rec->deviceId);

            qdict_put_str(event, "deviceId",
                          name != NULL ? name : "unregistered-device");
            qdict_put_int(detail, "deviceIndex", rec->deviceId);
        }
        if (rec->requestId != 0) {
            char buf[48];

            snprintf(buf, sizeof(buf), "vq%u-%u",
                     (unsigned)(rec->requestId >> 32),
                     (unsigned)(rec->requestId & 0xffffffffu));
            qdict_put_str(event, "requestId", buf);
        }
    }
    if (rec->kind == X_OSLAB_EVK_INSTRUCTION_BEGIN) {
        /* begin 自身就是那条指令的标识，它的 seq 就是这条指令的 instructionId。 */
        char buf[32];

        g_snprintf(buf, sizeof(buf), "insn-%" PRIu64, rec->seq);
        qdict_put_str(event, "instructionId", buf);
    } else if (rec->insnSeq != 0) {
        char buf[32];

        g_snprintf(buf, sizeof(buf), "insn-%" PRIu64, rec->insnSeq);
        qdict_put_str(event, "instructionId", buf);
        qput_u64(detail, "insnSeq", rec->insnSeq);
    }
    if (rec->pc != X_OSLAB_NO_PC) {
        qput_hex(event, "pc", rec->pc);
    }
    if (space != NULL) {
        qdict_put_str(event, "addressSpace", space);
        if (rec->address != X_OSLAB_NO_ADDR) {
            qput_hex(event, "address", rec->address);
        }
    }
    if ((is_mem || is_io) && rec->size > 0) {
        /* 访问宽度在任何情况下都要报出来，不能因为解不出字节就把 size 一起吞掉。 */
        qdict_put_int(event, "size", rec->size);
        qput_hex(detail, "value", rec->value);
        if (rec->size <= sizeof(uint64_t)) {
            uint8_t raw[sizeof(uint64_t)];
            uint32_t i;

            for (i = 0; i < rec->size; i++) {
                raw[i] = (uint8_t)(rec->value >> (8 * i));
            }
            qdict_put_str(event, "byteOrder", "little");
            {
                char *encoded = g_base64_encode(raw, rec->size);

                qdict_put_str(event, "bytes", encoded);
                g_free(encoded);
            }
        }
        if (is_mem && rec->mmuIndex != X_OSLAB_MMU_NONE) {
            qdict_put_int(detail, "mmuIndex", rec->mmuIndex);
        }
        if (rec->flags & X_OSLAB_EVF_SIGN) {
            qdict_put_bool(detail, "sign", true);
        }
    }
    if (is_insn && rec->size > 0) {
        /* 指令长度不是「访问宽度」，因此只放在 detail，不占用契约的 size。 */
        qdict_put_int(detail, "length", rec->size);
    }
    if ((is_dma || is_block) && rec->size > 0) {
        /*
         * 设备事件的 size 是这次映射/传输的字节长度。dma.* 报的是描述符映射
         * 带来的访问权，观察者并没有读那段缓冲的内容，所以这里故意不产生
         * bytes 字段：给出 bytes 会让人以为采到了载荷。载荷由读取方用
         * x-oslab-read-physical 独立核对（T05c 的验收脚本就是这么做的）。
         */
        qdict_put_int(event, "size", rec->size);
    }
    if (is_block) {
        qdict_put_int(detail, "reqType", rec->reqType);
        qdict_put_str(detail, "op", x_oslab_block_op_name(rec->reqType));
        qdict_put_int(detail, "descHead", rec->descHead);
        qdict_put_int(detail, "outSegments", rec->segOut);
        qdict_put_int(detail, "inSegments", rec->segIn);
        if (rec->kind == X_OSLAB_EVK_BLOCK_SUBMIT) {
            /* 提交时还没有状态，不预填一个 0 来冒充「成功」 */
            qdict_put_null(detail, "status");
        } else {
            qdict_put_int(detail, "statusCode", (int64_t)rec->value);
            qdict_put_str(detail, "status",
                          x_oslab_block_status_name(rec->value));
        }
        if (rec->address != X_OSLAB_NO_ADDR) {
            char lba[32];

            snprintf(lba, sizeof(lba), "%" PRIu64, rec->address);
            qdict_put_str(detail, "lba", lba);
            qput_hex(detail, "byteOffset", rec->address << 9);
        }
        if (rec->size > 0) {
            qdict_put_int(detail, "sectorCount", (int64_t)(rec->size >> 9));
        }
    }
    if (is_trap) {
        qdict_put_int(detail, "vector", rec->address);
        qdict_put_int(detail, "errorCode", rec->value);
        qput_hex(detail, "nextEip", rec->aux);
        qdict_put_bool(detail, "isHw", (rec->flags & X_OSLAB_EVF_IS_HW) != 0);
        qdict_put_bool(detail, "isInt", (rec->flags & X_OSLAB_EVF_IS_INT) != 0);
    }
    if (rec->kind == X_OSLAB_EVK_CAPTURE_FENCE) {
        /*
         * T05e：capture.fence 是帧分界，不是访存，契约的 address / size /
         * addressSpace 对它都不适用（所以都不产生）；value 报「记录这条 fence
         * 的那一刻仍在飞行、尚未对客体可见的块请求数」，让分界自己带上
         * 「采集时还有多少请求没完成」这条事实，而不是让读取方事后猜。
         */
        qdict_put_int(detail, "pendingBlockRequests", (int64_t)rec->value);
    }
    qdict_put_int(detail, "flags", rec->flags);
    qdict_put(event, "detail", detail);

    return event;
}

typedef struct XOslabKindFilter {
    bool active;
    bool selected[X_OSLAB_EVK_MAX];
} XOslabKindFilter;

/** kind 名字 -> XOslabEventKind；认不出来返回 -1（不猜、也不默认全选）。 */
static int x_oslab_kind_from_name(const char *name)
{
    int kind;

    if (name == NULL) {
        return -1;
    }
    for (kind = 0; kind < X_OSLAB_EVK_MAX; kind++) {
        if (strcmp(name, x_oslab_event_kind_name(kind)) == 0) {
            return kind;
        }
    }
    return -1;
}

/**
 * 解析 kinds 过滤参数。list 为 NULL 表示不过滤；非 NULL（含空数组）表示
 * 「只返回这些 kind」。requested 回显客户端给的名字，unknown 收集认不出来的
 * 名字——认不出来就如实回报，不静默升级成「全都要」。
 */
static void x_oslab_kind_filter_parse(QList *list, XOslabKindFilter *filter,
                                      QList *requested, QList *unknown)
{
    const QListEntry *entry;

    memset(filter, 0, sizeof(*filter));
    if (list == NULL) {
        return;
    }
    filter->active = true;
    QLIST_FOREACH_ENTRY(list, entry) {
        QString *string = qobject_to(QString, qlist_entry_obj(entry));
        const char *name;
        bool matched = false;
        int kind;

        if (string == NULL) {
            qlist_append_str(unknown, "non-string-kind");
            continue;
        }
        name = qstring_get_str(string);
        qlist_append_str(requested, name);
        kind = x_oslab_kind_from_name(name);
        if (kind >= 0) {
            filter->selected[kind] = true;
            matched = true;
        }
        if (!matched) {
            qlist_append_str(unknown, name);
        }
    }
}

/*
 * 事件开关。返回 NULL 表示成功；否则返回拒绝原因，由调用方原样上报。
 * 全部校验通过之后才一起应用，因此失败的请求不会产生部分效果。
 */
static const char *x_oslab_events_switch(bool want_enable, bool enable_value,
                                         bool want_reset, bool reset_value,
                                         bool want_record_mask,
                                         uint64_t record_mask,
                                         bool *enabled_changed,
                                         bool *reset_done)
{
    bool recording_change =
        (want_enable && enable_value != x_oslab_event_enabled())
        || (want_record_mask && record_mask != x_oslab_event_kind_mask());

    /*
     * 记录期开关（enabled 与 recordKindMask）都只在 VM 停止时接受：运行中改会让
     * 同一段执行前后不一致，读的人在时间线上无法区分。tb_flush 只需要在 enabled
     * 变化时做（那才影响已翻译 TB 里的发射点），记录期掩码是在 x_oslab_record
     * 里判的，不改变翻译结果。
     */
    if (recording_change && runstate_is_running()) {
        return "vm-running";
    }
    if (want_reset && reset_value) {
        if (x_oslab_capture_state.active) {
            return "capture-active";
        }
        if (runstate_is_running()) {
            return "vm-running";
        }
    }

    if (want_record_mask && record_mask != x_oslab_event_kind_mask()) {
        x_oslab_event_set_kind_mask(record_mask);
    }
    if (want_enable && enable_value != x_oslab_event_enabled()) {
        CPUState *cs = first_cpu;

        x_oslab_event_set_enabled(enable_value);
        *enabled_changed = true;
        /*
         * 已翻译的 TB 是在旧开关下生成的：整体失效，否则「打开采集」之后旧 TB
         * 仍然不发射观测 op，会静默少报事件。VM 已停（上面校验过）且是串行
         * 上下文，tb_flush 会就地完成。
         */
        if (cs != NULL) {
            tb_flush(cs);
        }
    }
    if (want_reset && reset_value) {
        x_oslab_event_reset();
        *reset_done = true;
    }
    return NULL;
}

static const char *x_oslab_events_switch_message(const char *reason)
{
    if (strcmp(reason, "capture-active") == 0) {
        return "已有活动 capture 引用当前事件序号，拒绝清空事件环；"
               "请先调用 x-oslab-release";
    }
    return "VM 正在运行；事件开关改变的是翻译期发射点，必须在 VM 停止时切换"
           "（切换后会清空 TB 缓存）";
}

/**
 * 事件能力的运行期摘要。capabilities.events 与 capture.events 共用同一份字段，
 * 避免两处各写一套而悄悄分叉。
 */
static void x_oslab_events_runtime(QDict *out)
{
    qdict_put_bool(out, "supported", X_OSLAB_EVENTS_AVAILABLE);
    qdict_put_bool(out, "enabled", x_oslab_event_enabled());
    qdict_put_int(out, "capacity", (int64_t)x_oslab_event_capacity());
    qput_u64(out, "watermark", x_oslab_event_watermark());
    qput_u64(out, "oldest", x_oslab_event_oldest());
    qput_u64(out, "dropped", x_oslab_event_dropped());
    qput_u64(out, "total", x_oslab_event_total());
    /*
     * T05c：记录期 kind 掩码。recordAllKinds=true 时行为与 T05b 完全一致；
     * 客体高速运行时设备事件很稀疏，先用 recordKinds 把记录范围收窄，才不会被
     * 指令事件把环挤掉。
     */
    qdict_put_bool(out, "recordAllKinds",
                   x_oslab_event_kind_mask() == X_OSLAB_RECORD_KIND_ALL);
    qput_hex(out, "recordKindMask", x_oslab_event_kind_mask());
}

/* ================================================================= T05d 设备快照 */

/*
 * 设备面板的无副作用快照（T05d，对应验收 E10）。
 *
 * 目标：让宿主可以「看一眼」VGA / i8042 / UART / PIC / APIC / PIT / virtio 的
 * 内部状态，而不产生任何客体可见的副作用：
 *   - 不消耗 FIFO（串口收/发 FIFO、PS/2 输出队列都按 head/num/count 算下标读，
 *     绝不调用 fifo8_pop / ps2_read_data）；
 *   - 不确认（acknowledge）任何中断：不读 PIC 的 OCW3/poll 命令寄存器（那才
 *     会走 pic_ioport_read 里的确认路径），不读 APIC 的 IRR/ISR 窗口；所有中断
 *     状态都从 PICCommonState / APICCommonState 的结构体字段直接取；
 *   - 不推进客体状态：不调用会重算定时器的 helper，只读 PIT/APIC 的计数字段，
 *     时间值原样上报（count_load_time / next_transition_time，虚拟时钟纳秒）；
 *   - 不经过设备的 MMIO / 端口读写回调，也不通过 address_space_* 触达设备 ops。
 *
 * 为什么这是必要而不是洁癖：这些设备寄存器是有状态的「读即动作」接口。
 * hw/char/serial.c 的 serial_ioport_read() case 2 在读 IIR 时会清 thr_ipending，
 * case 0 读 RBR 时会 fifo8_pop()；hw/intc/i8259.c 的 pic_ioport_read() 会按
 * OCW3 的选择改写 read_reg_select 并把 IRR 的待处理位当作已确认处理。一旦宿主
 * 「读一次寄存器看看」，客体侧的时序就被改变了。所以快照必须只读结构体。
 *
 * 复用标准接口（T05 验收：「若标准接口已经提供某项能力则直接复用」）
 * ---------------------------------------------------------------------------
 *   - 设备发现：QEMU 自己的 object_child_foreach_recursive() + object_dynamic_cast()，
 *     与 hw/virtio/virtio-qmp.c:qmp_x_query_virtio() 同一套机制；
 *   - virtqueue 状态：直接调用 QEMU 自带的 QMP 处理函数
 *     qmp_x_query_virtio_queue_status()（qapi/qapi-commands-virtio.h），它读的是
 *     VirtQueue 的 inuse / used_idx / signalled_used / vring 地址与长度，
 *     我们不再为此新增 QEMU 补丁；
 *   - VGA：VGACommonState 是 hw/display 私有结构且被内嵌在 PCIVGAState 里，
 *     QOM 上没有可反查的属性，因此由补丁 0004 提供 x_oslab_vga_snapshot()
 *     （只读 CRTC/SEQ/GFX/AR 寄存器与显存 backing store 指针）。
 *
 * 观察点（源码位置）
 * ---------------------------------------------------------------------------
 *   uart     include/hw/char/serial.h SerialState（recv_fifo/xmit_fifo 是 Fifo8，
 *            定义在 include/qemu/fifo8.h）；私有位常量的来源是 hw/char/serial.c:41-101
 *   i8042    include/hw/input/i8042.h ISAKBDState.kbd（KBDState），
 *            include/hw/input/ps2.h PS2KbdState/PS2MouseState 与 PS2Queue
 *   pic      include/hw/isa/i8259_internal.h PICCommonState；
 *            include/hw/intc/i8259.h:17 pic_get_output()（纯查询 INTR 线电平）
 *   pit      include/hw/timer/i8254_internal.h PITCommonState / PITChannelState
 *   apic     include/hw/i386/apic_internal.h APICCommonState；
 *            apic_internal.h:210 apic_get_current_count()（只读寄存器 + 虚拟时钟）
 *   vga      hw/display/vga.c:x_oslab_vga_snapshot()（补丁 0004）
 *   virtio   include/hw/virtio/virtio.h VirtIODevice 的公开访问器 +
 *            qmp_x_query_virtio_queue_status()（hw/virtio/virtio.c）
 *
 * 锁 / 线程上下文
 * ---------------------------------------------------------------------------
 * 本函数只在 x-oslab-capture 的命令处理里被调用，而该命令是
 * qmp_register_command(..., 0, 0)（非 OOB、非协程），由 qmp_dispatch() 在
 * **main loop + BQL** 的 BH 中执行。设备状态的每一次改动（realize、寄存器写、
 * 描述符弹出、块层完成回调）都要拿 BQL，所以这里读到的都是「已提交」的状态，
 * 不会看到改到一半的中间态。VGA 快照函数自身不做锁（调用方已持 BQL）；
 * virtqueue 快照读的是 VirtQueue 结构体字段，不是在途 DMA 的 payload。
 *
 * 设备顺序
 * ---------------------------------------------------------------------------
 * 遍历 QOM 树的顺序是不确定的（取决于子对象链表），因此收集完成后按
 * 「类别 rank + deviceId 字典序」排序，保证同一次运行、同一状态下多次快照的
 * 输出逐字段可比（验收要求「查看面板前后对照」）。
 */

#ifdef TARGET_I386

/* 一次快照最多收集的设备数与每台设备上报的寄存器区间数。 */
#define X_OSLAB_MAX_DEVICES        96
#define X_OSLAB_MAX_DEVICE_RANGES  32
/* FIFO / PS2 队列最多导出多少字节（够看一行串口输出即可）。 */
#define X_OSLAB_FIFO_DUMP_MAX      256
/* VGA 文本网格最多导出多少字节（80x25x4 = 8000）。 */
#define X_OSLAB_VGA_BACKING_MAX    8192

/* 设备类别，同时决定输出顺序（rank 小的在前）。 */
typedef enum XOslabDeviceRank {
    X_OSLAB_DR_VGA = 0,
    X_OSLAB_DR_UART,
    X_OSLAB_DR_I8042,
    X_OSLAB_DR_PIC,
    X_OSLAB_DR_APIC,
    X_OSLAB_DR_TIMER,
    X_OSLAB_DR_VIRTIO_BLK,
    X_OSLAB_DR_VIRTIO_NET,
    X_OSLAB_DR_VIRTIO_OTHER,
} XOslabDeviceRank;

static const char *x_oslab_rank_kind(XOslabDeviceRank rank)
{
    switch (rank) {
    case X_OSLAB_DR_VGA:
        return "vga";
    case X_OSLAB_DR_UART:
        return "uart";
    case X_OSLAB_DR_I8042:
        return "i8042";
    case X_OSLAB_DR_PIC:
        return "pic";
    case X_OSLAB_DR_APIC:
        return "apic";
    case X_OSLAB_DR_TIMER:
        return "timer";
    case X_OSLAB_DR_VIRTIO_BLK:
        return "virtio-blk";
    case X_OSLAB_DR_VIRTIO_NET:
        return "virtio-net";
    default:
        return "other";
    }
}

/*
 * QEMU 8.2 没有 object_get_parent()：全树 grep 只有本文件在调用，
 * include/qom/object.h 也没有声明。qom/object.c 内部一律直接读
 * Object::parent 字段，这里按同一语义实现只读访问器 ——
 * object_property_add_child() 里执行 child->parent = obj，所以子对象的
 * parent 就是它的 QOM 宿主。只取指针、不加引用、无任何副作用。
 */
static Object *x_oslab_object_parent(Object *obj)
{
    return obj != NULL ? obj->parent : NULL;
}

/* ---------- 字段构造 ---------- */

static void x_oslab_dev_field(QList *fields, const char *name,
                              const char *value, const char *meaning, int width)
{
    QDict *f = qdict_new();

    qdict_put_str(f, "name", name);
    qdict_put_str(f, "value", value);
    if (meaning != NULL) {
        qdict_put_str(f, "meaning", meaning);
    }
    if (width > 0) {
        qdict_put_int(f, "width", width);
    }
    qlist_append(fields, f);
}

static void x_oslab_dev_hex(QList *fields, const char *name, uint64_t value,
                            const char *meaning, int width)
{
    char buf[32];

    g_snprintf(buf, sizeof(buf), "0x%" PRIx64, value);
    x_oslab_dev_field(fields, name, buf, meaning, width);
}

static void x_oslab_dev_dec(QList *fields, const char *name, int64_t value,
                            const char *meaning)
{
    char buf[32];

    g_snprintf(buf, sizeof(buf), "%" PRId64, value);
    x_oslab_dev_field(fields, name, buf, meaning, 0);
}

static void x_oslab_dev_bool(QList *fields, const char *name, bool value,
                             const char *meaning)
{
    x_oslab_dev_field(fields, name, value ? "true" : "false", meaning, 0);
}

/**
 * 把字节序列编成小写十六进制字符串（两字符一字节，按原顺序）。
 * 不用 %016 之类的前导零填充：契约要求 Hex 无前导零（见 common.ts 的 isHex）。
 */
static char *x_oslab_hex_bytes(const uint8_t *data, uint32_t len)
{
    static const char digits[] = "0123456789abcdef";
    char *out = g_malloc((size_t)len * 2 + 1);
    uint32_t i;

    for (i = 0; i < len; i++) {
        out[i * 2] = digits[(data[i] >> 4) & 0xf];
        out[i * 2 + 1] = digits[data[i] & 0xf];
    }
    out[(size_t)len * 2] = '\0';
    return out;
}

/*
 * Fifo8 的非破坏性读取（include/qemu/fifo8.h）。
 *
 * 这里刻意不使用 fifo8_peek() 与 fifo8_pop()：客体读串口 RBR 走的正是
 * hw/char/serial.c:serial_ioport_read() -> fifo8_pop(recv_fifo)，一旦调用就
 * 真的把字节取走了，设备面板也就变成了「客体动作」。Fifo8 的 data/head/num
 * 布局在 include/qemu/fifo8.h 里是公开的，直接按环形下标算即可。
 */
static uint8_t x_oslab_fifo8_at(const Fifo8 *fifo, uint32_t i)
{
    if (fifo->data == NULL || fifo->capacity == 0 || i >= fifo->num) {
        return 0;
    }
    return fifo->data[(fifo->head + i) % fifo->capacity];
}

static char *x_oslab_fifo8_hex(const Fifo8 *fifo)
{
    uint32_t len = fifo->num < X_OSLAB_FIFO_DUMP_MAX ? fifo->num
                                                     : X_OSLAB_FIFO_DUMP_MAX;
    uint8_t *tmp = g_malloc(len > 0 ? len : 1);
    char *out;
    uint32_t i;

    for (i = 0; i < len; i++) {
        tmp[i] = x_oslab_fifo8_at(fifo, i);
    }
    out = x_oslab_hex_bytes(tmp, len);
    g_free(tmp);
    return out;
}

/*
 * PS2Queue 的非破坏性读取（include/hw/input/ps2.h）。
 * ps2_read_data() 会推进 rptr 并可能改写 kbd->obdata/pending，那才是客体读
 * 0x60 端口的路径；这里只按 rptr/count 算环形下标。
 */
static uint8_t x_oslab_ps2_at(const PS2Queue *q, uint32_t i)
{
    if (q->count <= 0 || i >= (uint32_t)q->count) {
        return 0;
    }
    return q->data[((uint32_t)q->rptr + i) % PS2_BUFFER_SIZE];
}

static char *x_oslab_ps2_hex(const PS2Queue *q)
{
    uint32_t avail = q->count > 0 ? (uint32_t)q->count : 0;
    uint32_t len = avail < X_OSLAB_FIFO_DUMP_MAX ? avail : X_OSLAB_FIFO_DUMP_MAX;
    uint8_t *tmp = g_malloc(len > 0 ? len : 1);
    char *out;
    uint32_t i;

    for (i = 0; i < len; i++) {
        tmp[i] = x_oslab_ps2_at(q, i);
    }
    out = x_oslab_hex_bytes(tmp, len);
    g_free(tmp);
    return out;
}

/* ---------- 寄存器 / MMIO 区间 ---------- */

typedef struct XOslabRangeScan {
    AddressSpace *as;
    Object *owners[2];
    int nowners;
    QList *ranges;
    uint32_t count;
} XOslabRangeScan;

/*
 * 归属匹配只做「精确 owner 相等」。
 *
 * 为什么不做成「祖先/后代」双向匹配：ISA 总线和机器对象拥有一大片「容器空洞」
 * 区域（piix4-isa、machine 自身的内存别名），沿父链向上匹配会把那些大块区间
 * 错误地算到每个 ISA 设备头上。精确相等只会命中设备自己 memory_region_init_*
 * 时传进去的 owner，UART（父对象 ISASerialState）与 virtio（传输层 PCI 设备）
 * 各自多带一个 owner 就够了。
 */
static bool x_oslab_range_cb(Int128 start, Int128 len, const MemoryRegion *mr,
                             hwaddr offset_in_region, void *opaque)
{
    XOslabRangeScan *scan = opaque;
    Object *owner = memory_region_owner((MemoryRegion *)mr);
    int i;

    (void)offset_in_region;

    if (scan->count >= X_OSLAB_MAX_DEVICE_RANGES) {
        return true;
    }
    if (owner == NULL) {
        return false;
    }
    for (i = 0; i < scan->nowners; i++) {
        if (owner == scan->owners[i]) {
            QDict *entry = qdict_new();

            qput_hex(entry, "address", int128_get64(start));
            qdict_put_int(entry, "length", (int64_t)int128_get64(len));
            qlist_append(scan->ranges, entry);
            scan->count++;
            return false;
        }
    }
    return false;
}

static uint32_t x_oslab_collect_owner_ranges(AddressSpace *as, Object **owners,
                                            int nowners, QList *ranges)
{
    XOslabRangeScan scan = {
        .as = as,
        .nowners = nowners,
        .ranges = ranges,
        .count = 0,
    };
    FlatView *fv;

    if (nowners <= 0 || nowners > (int)ARRAY_SIZE(scan.owners)) {
        return 0;
    }
    memcpy(scan.owners, owners, sizeof(Object *) * nowners);

    RCU_READ_LOCK_GUARD();
    fv = address_space_to_flatview(as);
    flatview_for_each_range(fv, x_oslab_range_cb, &scan);
    return scan.count;
}

/* 把地址空间里的裸区间渲染成 "0x3f8+0x8,0x2f8+0x8"（只用于设备字段文本）。 */
static char *x_oslab_ranges_text(const QList *ranges)
{
    GString *s = g_string_new("");
    const QListEntry *e;

    QLIST_FOREACH_ENTRY(ranges, e) {
        QDict *d = qobject_to(QDict, qlist_entry_obj(e));
        const char *addr;
        int64_t len;

        if (d == NULL) {
            continue;
        }
        addr = qdict_get_try_str(d, "address");
        len = qdict_get_try_int(d, "length", 0);
        if (addr == NULL) {
            continue;
        }
        if (s->len > 0) {
            g_string_append_c(s, ',');
        }
        g_string_append_printf(s, "%s+0x%" PRIx64, addr, (uint64_t)len);
    }
    return g_string_free(s, false);
}

/**
 * 设备快照的证据引用。
 *
 * 契约 EvidenceRef 只有 {kind, source, captureId?, refs[], reason?}，所以源码
 * 观察点和锁上下文都放进 refs[]，不额外加 note 字段。
 */
static void x_oslab_dev_evidence(QDict *dev, const char *point)
{
    QDict *ev = qdict_new();
    QList *refs = qlist_new();

    qdict_put_str(ev, "kind", "observed");
    qdict_put_str(ev, "source", "qmp:x-oslab-capture/devices");
    if (x_oslab_capture_state.active && x_oslab_capture_state.id != NULL) {
        qdict_put_str(ev, "captureId", x_oslab_capture_state.id);
    }
    qlist_append_str(refs, point);
    qlist_append_str(refs, "锁上下文: main loop + BQL（qmp_dispatch 的 BH）");
    qlist_append_str(refs, "只读结构体字段；不调用 MMIO/端口回调、不消费 FIFO、"
                           "不确认 IRQ、不推进虚拟时钟");
    qdict_put(ev, "refs", refs);
    qdict_put(dev, "evidence", ev);
}

/* ---------- 寄存器区间终结 ---------- */

/**
 * 收集该设备拥有的 memory 空间区间（进 registerRanges）与 IO 端口区间
 * （契约没有数组形状的 IO 字段，所以渲染成一条 ioPortRanges 文本字段）。
 * extra_owner 用于「设备结构体不是 MemoryRegion owner」的两类情况：
 * UART 的 owner 是 SerialState 的父对象，virtio 的 owner 是传输层 PCI 设备。
 */
static void x_oslab_dev_add_ranges(QDict *dev, QList *fields, Object *obj,
                                   Object *extra_owner)
{
    Object *owners[2];
    QList *mem = qlist_new();
    QList *io = qlist_new();
    int nowners = 0;
    uint32_t nmem;
    uint32_t nio;

    if (obj != NULL) {
        owners[nowners++] = obj;
    }
    if (extra_owner != NULL) {
        owners[nowners++] = extra_owner;
    }
    if (nowners == 0) {
        qobject_unref(mem);
        qobject_unref(io);
        return;
    }
    nmem = x_oslab_collect_owner_ranges(&address_space_memory, owners, nowners,
                                        mem);
    nio = x_oslab_collect_owner_ranges(&address_space_io, owners, nowners, io);

    if (nmem > 0) {
        qdict_put(dev, "registerRanges", mem);
    } else {
        qobject_unref(mem);
    }
    if (nio > 0) {
        char *text = x_oslab_ranges_text(io);

        x_oslab_dev_field(fields, "ioPortRanges", text,
                          "该设备拥有的 IO 端口区间（address+length）", 0);
        g_free(text);
    }
    qobject_unref(io);
}

/* ---------- UART（include/hw/char/serial.h SerialState） ---------- */

/*
 * 串口私有位。宏定义在 hw/char/serial.c:41-101 里、不在任何头文件中，
 * 这里按源码原样复制并标注来源行号，避免「凭记忆写位掩码」。
 */
#define X_OSLAB_UART_LCR_DLAB   0x80 /* serial.c:41 */
#define X_OSLAB_UART_IIR_NO_INT 0x01 /* serial.c:48 */
#define X_OSLAB_UART_IIR_ID     0x06 /* serial.c:49 */
#define X_OSLAB_UART_LSR_TEMT   0x40 /* serial.c:82 */
#define X_OSLAB_UART_LSR_THRE   0x20 /* serial.c:83 */
#define X_OSLAB_UART_LSR_DR     0x01 /* serial.c:88 */
#define X_OSLAB_UART_FCR_FE     0x01 /* serial.c:101 */

static void x_oslab_dev_build_uart(QDict *dev, Object *obj, QList *fields)
{
    SerialState *s = SERIAL(obj);
    char *hex;

    x_oslab_dev_hex(fields, "ier", s->ier, "中断使能寄存器", 8);
    x_oslab_dev_hex(fields, "iir", s->iir, "中断标识寄存器（结构体镜像）", 8);
    x_oslab_dev_bool(fields, "iirNoInterrupt",
                     (s->iir & X_OSLAB_UART_IIR_NO_INT) != 0,
                     "IIR bit0: 1 = 没有待处理中断");
    x_oslab_dev_hex(fields, "iirId", s->iir & X_OSLAB_UART_IIR_ID,
                    "IIR bit3:1: 中断 ID（0x2=THR 空，0x4=收到数据）", 8);
    x_oslab_dev_hex(fields, "lcr", s->lcr, "线路控制寄存器", 8);
    x_oslab_dev_bool(fields, "dlab", (s->lcr & X_OSLAB_UART_LCR_DLAB) != 0,
                     "LCR bit7: 1 = 0x3f8/0x3f9 访问除数锁存器");
    x_oslab_dev_hex(fields, "divider", s->divider, "波特率除数锁存器", 16);
    x_oslab_dev_hex(fields, "mcr", s->mcr, "调制解调器控制寄存器", 8);
    x_oslab_dev_hex(fields, "lsr", s->lsr, "线路状态寄存器（结构体镜像）", 8);
    x_oslab_dev_bool(fields, "lsrDataReady", (s->lsr & X_OSLAB_UART_LSR_DR) != 0,
                     "LSR bit0: 接收 FIFO 里有数据");
    x_oslab_dev_bool(fields, "lsrThre", (s->lsr & X_OSLAB_UART_LSR_THRE) != 0,
                     "LSR bit5: 发送保持寄存器空");
    x_oslab_dev_bool(fields, "lsrTemt", (s->lsr & X_OSLAB_UART_LSR_TEMT) != 0,
                     "LSR bit6: 发送器空");
    x_oslab_dev_hex(fields, "msr", s->msr, "调制解调器状态寄存器", 8);
    x_oslab_dev_hex(fields, "scr", s->scr, "暂存寄存器", 8);
    x_oslab_dev_hex(fields, "fcr", s->fcr, "FIFO 控制寄存器", 8);
    x_oslab_dev_bool(fields, "fifoEnabled", (s->fcr & X_OSLAB_UART_FCR_FE) != 0,
                     "FCR bit0: FIFO 使能");
    x_oslab_dev_hex(fields, "thr", s->thr, "发送保持寄存器", 8);
    x_oslab_dev_hex(fields, "tsr", s->tsr, "发送移位寄存器", 8);
    x_oslab_dev_hex(fields, "rbr", s->rbr, "接收缓冲寄存器（无 FIFO 时的镜像）", 8);
    x_oslab_dev_dec(fields, "thrIpending", s->thr_ipending,
                    "THR 空中断待处理标志（读 IIR 会清它，本快照不清）");

    /*
     * 接收/发送 FIFO：按 head/num 算下标读，绝不 fifo8_pop。这正是验收里
     * 「查看面板不消耗 FIFO」的落点。
     */
    x_oslab_dev_dec(fields, "recvFifoCount", (int64_t)s->recv_fifo.num,
                    "接收 FIFO 里等待客体读取的字节数");
    x_oslab_dev_dec(fields, "recvFifoCapacity", (int64_t)s->recv_fifo.capacity,
                    "接收 FIFO 容量");
    hex = x_oslab_fifo8_hex(&s->recv_fifo);
    x_oslab_dev_field(fields, "recvFifoHex", hex,
                      "接收 FIFO 内容，按客体将要读到的顺序（非破坏性）", 0);
    g_free(hex);
    x_oslab_dev_dec(fields, "xmitFifoCount", (int64_t)s->xmit_fifo.num,
                    "发送 FIFO 里尚未发出的字节数");
    x_oslab_dev_dec(fields, "xmitFifoCapacity", (int64_t)s->xmit_fifo.capacity,
                    "发送 FIFO 容量");
    hex = x_oslab_fifo8_hex(&s->xmit_fifo);
    x_oslab_dev_field(fields, "xmitFifoHex", hex,
                      "发送 FIFO 内容（非破坏性）", 0);
    g_free(hex);
    x_oslab_dev_dec(fields, "recvFifoItl", (int64_t)s->recv_fifo_itl,
                    "接收 FIFO 触发等级（1/4/8/14）");
    x_oslab_dev_dec(fields, "timeoutIpending", s->timeout_ipending,
                    "接收 FIFO 超时中断待处理");
    x_oslab_dev_dec(fields, "lastXmitTs", (int64_t)s->last_xmit_ts,
                    "最后一字节离开 TSR 的虚拟时钟纳秒");

    /*
     * 端口区间的 owner 是 SerialState 的 QOM 父对象（serial-isa.c:82 把
     * OBJECT(isa) 传给 memory_region_init_io），不是 SerialState 自己。
     */
    x_oslab_dev_add_ranges(dev, fields, obj, x_oslab_object_parent(obj));
}

/* ---------- i8042（include/hw/input/i8042.h ISAKBDState） ---------- */

static void x_oslab_dev_build_i8042(QDict *dev, Object *obj, QList *fields)
{
    ISAKBDState *isa = I8042(obj);
    KBDState *s = &isa->kbd;
    PS2Queue *kq = &s->ps2kbd.parent_obj.queue;
    PS2Queue *mq = &s->ps2mouse.parent_obj.queue;
    char *hex;

    x_oslab_dev_hex(fields, "status", s->status, "控制器状态寄存器（0x64 读）", 8);
    x_oslab_dev_hex(fields, "mode", s->mode, "模式字节", 8);
    x_oslab_dev_hex(fields, "outport", s->outport, "输出端口字节（含 A20）", 8);
    x_oslab_dev_hex(fields, "writeCmd", s->write_cmd,
                    "写入 0x60 数据端口预期的命令字节", 8);
    x_oslab_dev_hex(fields, "obsrc", s->obsrc, "输出缓冲来源", 32);
    x_oslab_dev_hex(fields, "pending", s->pending,
                    "有数据可读的设备位掩码（bit0=键盘, bit1=鼠标）", 8);
    x_oslab_dev_hex(fields, "obdata", s->obdata, "输出缓冲数据", 8);
    x_oslab_dev_hex(fields, "cbdata", s->cbdata, "命令缓冲数据", 8);
    x_oslab_dev_hex(fields, "pendingTmp", s->pending_tmp, "输出缓冲暂存掩码", 8);
    x_oslab_dev_dec(fields, "migrationFlags", (int64_t)s->migration_flags,
                    "迁移用标志");
    x_oslab_dev_bool(fields, "outportPresent", s->outport_present,
                     "是否存在输出端口寄存器");
    x_oslab_dev_bool(fields, "extendedState", s->extended_state,
                     "0x60/0x64 是 PS/2 还是 USB 兼容语义");
    x_oslab_dev_bool(fields, "extendedStateLoaded", s->extended_state_loaded,
                     "extended_state 是否已从属性装载");
    x_oslab_dev_hex(fields, "kbdIrq", isa->kbd_irq, "键盘 IRQ 线号", 8);
    x_oslab_dev_hex(fields, "mouseIrq", isa->mouse_irq, "鼠标 IRQ 线号", 8);

    x_oslab_dev_dec(fields, "kbdQueueCount", kq->count,
                    "PS/2 键盘输出队列待读数");
    hex = x_oslab_ps2_hex(kq);
    x_oslab_dev_field(fields, "kbdQueueHex", hex,
                      "PS/2 键盘输出队列内容（非破坏性）", 0);
    g_free(hex);
    x_oslab_dev_dec(fields, "mouseQueueCount", mq->count,
                    "PS/2 鼠标输出队列待读数");
    hex = x_oslab_ps2_hex(mq);
    x_oslab_dev_field(fields, "mouseQueueHex", hex,
                      "PS/2 鼠标输出队列内容（非破坏性）", 0);
    g_free(hex);

    x_oslab_dev_bool(fields, "kbdScanEnabled", s->ps2kbd.scan_enabled != 0,
                     "键盘扫描已使能");
    x_oslab_dev_bool(fields, "kbdTranslate", s->ps2kbd.translate != 0,
                     "键盘 scancode 翻译");
    x_oslab_dev_dec(fields, "kbdScancodeSet", s->ps2kbd.scancode_set,
                    "键盘 scancode 集（1=XT 2=AT 3=PS/2）");
    x_oslab_dev_hex(fields, "kbdLedState", s->ps2kbd.ledstate, "键盘 LED 状态", 8);
    x_oslab_dev_hex(fields, "kbdModifiers", s->ps2kbd.modifiers,
                    "键盘修饰键位掩码", 32);
    x_oslab_dev_hex(fields, "mouseStatus", s->ps2mouse.mouse_status,
                    "鼠标状态字节", 8);
    x_oslab_dev_hex(fields, "mouseResolution", s->ps2mouse.mouse_resolution,
                    "鼠标分辨率", 8);
    x_oslab_dev_hex(fields, "mouseSampleRate", s->ps2mouse.mouse_sample_rate,
                    "鼠标采样率", 8);
    x_oslab_dev_hex(fields, "mouseType", s->ps2mouse.mouse_type,
                    "鼠标类型（0=PS2, 3=IMPS/2, 4=IMEX）", 8);
    x_oslab_dev_hex(fields, "mouseButtons", s->ps2mouse.mouse_buttons,
                    "鼠标按键位掩码", 8);
    x_oslab_dev_dec(fields, "mouseDx", s->ps2mouse.mouse_dx, "鼠标 X 增量");
    x_oslab_dev_dec(fields, "mouseDy", s->ps2mouse.mouse_dy, "鼠标 Y 增量");
    x_oslab_dev_dec(fields, "mouseDz", s->ps2mouse.mouse_dz, "鼠标 Z（滚轮）增量");
    x_oslab_dev_dec(fields, "mouseDw", s->ps2mouse.mouse_dw, "鼠标 W 增量");

    x_oslab_dev_add_ranges(dev, fields, obj, NULL);
}

/* ---------- PIC（include/hw/isa/i8259_internal.h PICCommonState） ---------- */

static void x_oslab_dev_build_pic(QDict *dev, Object *obj, QList *fields)
{
    PICCommonState *s = PIC_COMMON(obj);

    x_oslab_dev_hex(fields, "irr", s->irr, "中断请求寄存器（待处理请求）", 8);
    x_oslab_dev_hex(fields, "isr", s->isr, "服务中寄存器（已确认未 EOI）", 8);
    x_oslab_dev_hex(fields, "imr", s->imr, "中断屏蔽寄存器", 8);
    x_oslab_dev_hex(fields, "lastIrr", s->last_irr,
                    "上一次采样的 IRR（边沿检测用）", 8);
    x_oslab_dev_hex(fields, "elcr", s->elcr, "边沿/电平触发选择寄存器", 8);
    x_oslab_dev_hex(fields, "elcrMask", s->elcr_mask, "ELCR 有效位掩码", 8);
    x_oslab_dev_hex(fields, "ltim", s->ltim, "电平触发模式位", 8);
    x_oslab_dev_hex(fields, "priorityAdd", s->priority_add, "最高优先级偏移", 8);
    x_oslab_dev_hex(fields, "irqBase", s->irq_base, "中断向量基址", 8);
    x_oslab_dev_hex(fields, "readRegSelect", s->read_reg_select,
                    "OCW3 当前选择的读寄存器（结构体镜像，未走读端口）", 8);
    x_oslab_dev_hex(fields, "poll", s->poll, "轮询模式标志", 8);
    x_oslab_dev_hex(fields, "specialMask", s->special_mask, "特殊屏蔽模式", 8);
    x_oslab_dev_hex(fields, "initState", s->init_state, "初始化状态机", 8);
    x_oslab_dev_hex(fields, "autoEoi", s->auto_eoi, "自动 EOI", 8);
    x_oslab_dev_hex(fields, "rotateOnAutoEoi", s->rotate_on_auto_eoi,
                    "自动 EOI 时轮转优先级", 8);
    x_oslab_dev_hex(fields, "specialFullyNestedMode",
                    s->special_fully_nested_mode, "特殊全嵌套模式", 8);
    x_oslab_dev_bool(fields, "init4", s->init4 != 0, "已收到 4 字节 ICW 序列");
    x_oslab_dev_bool(fields, "singleMode", s->single_mode != 0,
                     "单片 8259（无级联从片）");
    x_oslab_dev_hex(fields, "master", s->master,
                    "/SP 输入：1 = 主片（0x20），0 = 从片（0xa0）", 32);
    x_oslab_dev_hex(fields, "iobase", s->iobase, "命令端口基址", 32);
    x_oslab_dev_hex(fields, "elcrAddr", s->elcr_addr, "ELCR 端口地址", 32);
    /*
     * pic_get_output()（include/hw/intc/i8259.h:17）等价于 pic_get_irq() >= 0，
     * 只根据 irr/imr/isr/priority_add 做算术，不触发确认、不改任何字段。
     */
    x_oslab_dev_bool(fields, "intOutput", pic_get_output(s) != 0,
                     "INTR 输出线当前是否有效（pic_get_output，纯查询）");

    x_oslab_dev_add_ranges(dev, fields, obj, NULL);
}

/* ---------- PIT（include/hw/timer/i8254_internal.h PITCommonState） ---------- */

static void x_oslab_dev_build_pit(QDict *dev, Object *obj, QList *fields)
{
    PITCommonState *pit = PIT_COMMON(obj);
    int c;

    x_oslab_dev_hex(fields, "iobase", pit->iobase, "PIT 基址（通常 0x40）", 32);
    for (c = 0; c < 3; c++) {
        PITChannelState *ch = &pit->channels[c];
        char name[48];

#define X_OSLAB_PIT_FIELD(fmt, val, meaning, width)                            \
        do {                                                                   \
            g_snprintf(name, sizeof(name), fmt, c);                            \
            x_oslab_dev_hex(fields, name, (uint64_t)(val), meaning, width);    \
        } while (0)

        X_OSLAB_PIT_FIELD("ch%d.count", ch->count,
                          "计数初值（16 位分频，0 表示 65536）", 32);
        X_OSLAB_PIT_FIELD("ch%d.latchedCount", ch->latched_count,
                          "已锁存待读的计数值", 16);
        X_OSLAB_PIT_FIELD("ch%d.countLatched", ch->count_latched,
                          "计数已锁存标志", 8);
        X_OSLAB_PIT_FIELD("ch%d.statusLatched", ch->status_latched,
                          "状态已锁存标志", 8);
        X_OSLAB_PIT_FIELD("ch%d.status", ch->status, "读回状态字节", 8);
        X_OSLAB_PIT_FIELD("ch%d.readState", ch->read_state, "读状态机", 8);
        X_OSLAB_PIT_FIELD("ch%d.writeState", ch->write_state, "写状态机", 8);
        X_OSLAB_PIT_FIELD("ch%d.writeLatch", ch->write_latch, "写锁存器", 8);
        X_OSLAB_PIT_FIELD("ch%d.rwMode", ch->rw_mode,
                          "读写模式（1=低字节 2=高字节 3=低高）", 8);
        X_OSLAB_PIT_FIELD("ch%d.mode", ch->mode,
                          "工作模式 0..5（0=计数结束中断 2=分频 3=方波）", 8);
        X_OSLAB_PIT_FIELD("ch%d.bcd", ch->bcd, "BCD 计数（本实现不支持）", 8);
        X_OSLAB_PIT_FIELD("ch%d.gate", ch->gate, "GATE 输入电平", 8);
        X_OSLAB_PIT_FIELD("ch%d.irqDisabled", ch->irq_disabled,
                          "中断被屏蔽（bit0）", 32);
#undef X_OSLAB_PIT_FIELD
        g_snprintf(name, sizeof(name), "ch%d.countLoadTime", c);
        x_oslab_dev_dec(fields, name, ch->count_load_time,
                        "上次装载计数时的虚拟时钟纳秒（原样上报，不重算）");
        g_snprintf(name, sizeof(name), "ch%d.nextTransitionTime", c);
        x_oslab_dev_dec(fields, name, ch->next_transition_time,
                        "下一次输出跳变的虚拟时钟纳秒（原样上报，不重算）");
    }

    x_oslab_dev_add_ranges(dev, fields, obj, NULL);
}

/* ---------- APIC（include/hw/i386/apic_internal.h APICCommonState） ---------- */

static void x_oslab_dev_build_apic(QDict *dev, Object *obj, QList *fields)
{
    APICCommonState *s = APIC_COMMON(obj);
    char name[48];
    int i;

    x_oslab_dev_hex(fields, "apicbase", s->apicbase,
                    "APIC 基址寄存器（含使能位与 BSP 位）", 64);
    x_oslab_dev_hex(fields, "id", s->id, "APIC ID", 8);
    x_oslab_dev_hex(fields, "initialApicId", s->initial_apic_id,
                    "上电时的 APIC ID", 32);
    x_oslab_dev_hex(fields, "version", s->version, "版本寄存器", 8);
    x_oslab_dev_hex(fields, "arbId", s->arb_id, "仲裁 ID", 8);
    x_oslab_dev_hex(fields, "tpr", s->tpr, "任务优先级寄存器 TPR", 8);
    x_oslab_dev_hex(fields, "spuriousVec", s->spurious_vec,
                    "伪中断向量寄存器", 32);
    x_oslab_dev_hex(fields, "logDest", s->log_dest, "逻辑目标寄存器", 8);
    x_oslab_dev_hex(fields, "destMode", s->dest_mode, "目标模式寄存器", 8);
    x_oslab_dev_hex(fields, "esr", s->esr, "错误状态寄存器", 32);
    x_oslab_dev_hex(fields, "icrLow", s->icr[0], "ICR 低 32 位", 32);
    x_oslab_dev_hex(fields, "icrHigh", s->icr[1], "ICR 高 32 位", 32);
    x_oslab_dev_hex(fields, "divideConf", s->divide_conf,
                    "定时器分频配置（决定 count_shift）", 32);
    x_oslab_dev_dec(fields, "countShift", s->count_shift, "定时器计数右移位数");
    x_oslab_dev_dec(fields, "initialCount", s->initial_count, "定时器初值");
    x_oslab_dev_dec(fields, "initialCountLoadTime", s->initial_count_load_time,
                    "初值装载时刻（虚拟时钟纳秒）");
    x_oslab_dev_dec(fields, "timerExpiry", s->timer_expiry,
                    "定时器到期时刻（虚拟时钟纳秒）");
    x_oslab_dev_dec(fields, "sipiVector", s->sipi_vector, "最近一次 SIPI 向量");
    x_oslab_dev_dec(fields, "waitForSipi", s->wait_for_sipi, "等待 SIPI 标志");
    x_oslab_dev_bool(fields, "legacyInstanceId", s->legacy_instance_id,
                     "传统实例 ID（APIC ID 与 CPU 索引绑定）");
    x_oslab_dev_hex(fields, "vapicPaddr", s->vapic_paddr, "vAPIC 页物理地址", 64);
    /*
     * apic_get_current_count()（apic_internal.h:210）只读 lvt/initial_count 与
     * 虚拟时钟，不触发定时器、不写任何字段，因此可以直接用于面板。
     */
    x_oslab_dev_dec(fields, "currentCount", apic_get_current_count(s),
                    "当前定时器计数（按虚拟时钟现算，不推进时钟）");

    for (i = 0; i < (int)ARRAY_SIZE(s->irr); i++) {
        g_snprintf(name, sizeof(name), "irr%d", i);
        x_oslab_dev_hex(fields, name, s->irr[i],
                        "中断请求寄存器（256 位按 32 位分片）", 32);
    }
    for (i = 0; i < (int)ARRAY_SIZE(s->isr); i++) {
        g_snprintf(name, sizeof(name), "isr%d", i);
        x_oslab_dev_hex(fields, name, s->isr[i],
                        "服务中寄存器（256 位按 32 位分片）", 32);
    }
    for (i = 0; i < (int)ARRAY_SIZE(s->tmr); i++) {
        g_snprintf(name, sizeof(name), "tmr%d", i);
        x_oslab_dev_hex(fields, name, s->tmr[i],
                        "触发模式寄存器（256 位按 32 位分片）", 32);
    }
    for (i = 0; i < (int)ARRAY_SIZE(s->lvt); i++) {
        g_snprintf(name, sizeof(name), "lvt%d", i);
        x_oslab_dev_hex(fields, name, s->lvt[i], "LVT 表项", 32);
    }

    x_oslab_dev_add_ranges(dev, fields, obj, NULL);
}

/* ---------- VGA（补丁 0004 提供的 x_oslab_vga_snapshot） ---------- */

static void x_oslab_dev_build_vga(QDict *dev, uint32_t slot, QList *fields)
{
    XOslabVgaInfo info;
    char *hex;

    if (!x_oslab_vga_snapshot(slot, &info) || !info.valid) {
        x_oslab_dev_field(fields, "snapshot", "unavailable",
                          "VGA 私有状态快照不可用（补丁 0004 未生效或设备未 realize）",
                          0);
        return;
    }

    /*
     * graphic_mode 取自 XOslabVgaInfo，取值沿用 hw/display/vga.c:1774-1776 的
     * GMODE_TEXT=0 / GMODE_GRAPH=1 / GMODE_BLANK=2（判据与 vga_update_text 一致：
     * 先看 AR 的显示使能位，再看 GR06 的 graphics mode 位）。
     */
    x_oslab_dev_field(fields, "graphicMode",
                      info.graphic_mode == 0 ? "text"
                      : (info.graphic_mode == 1 ? "graph" : "blank"),
                      "显示模式（vga_update_text 的判据）", 0);
    x_oslab_dev_bool(fields, "textMode", info.text_mode, "当前是文本模式");
    x_oslab_dev_bool(fields, "vbeEnabled", info.vbe_enabled, "VBE 已启用");
    x_oslab_dev_dec(fields, "textCols", info.text_cols, "文本列数 (CRTC R01 + 1)");
    x_oslab_dev_dec(fields, "textRows", info.text_rows, "文本行数");
    x_oslab_dev_hex(fields, "startAddr", info.start_addr,
                    "显示起始单元（dword 下标，选中 cr/start）", 32);
    x_oslab_dev_dec(fields, "lineOffset", info.line_offset, "每行字节数 (R13 << 3)");
    x_oslab_dev_dec(fields, "lineCompare", info.line_compare, "行比较值 (R18)");
    x_oslab_dev_dec(fields, "cursorOffset", info.cursor_offset,
                    "光标相对 start_addr 的单元偏移（负数表示在屏外）");
    x_oslab_dev_hex(fields, "cursorStart", info.cursor_start, "光标起始扫描线", 8);
    x_oslab_dev_hex(fields, "cursorEnd", info.cursor_end, "光标结束扫描线", 8);
    x_oslab_dev_bool(fields, "cursorVisible", info.cursor_visible,
                     "光标可见（R0A bit5 为 0）");
    x_oslab_dev_dec(fields, "cellStride", info.cell_stride,
                    "文本单元在显存里的字节数 (char|attr|plane2|plane3)");
    x_oslab_dev_hex(fields, "vramSize", info.vram_size, "显存大小（字节）", 64);
    x_oslab_dev_hex(fields, "arIndex", info.ar_index, "AR 地址/状态寄存器", 8);
    x_oslab_dev_hex(fields, "msr", info.msr, "杂项输出寄存器", 8);
    x_oslab_dev_hex(fields, "st00", info.st00, "输入状态寄存器 0（VGA 镜像）", 8);
    x_oslab_dev_hex(fields, "st01", info.st01, "输入状态寄存器 1（VGA 镜像）", 8);
    x_oslab_dev_dec(fields, "bankOffset", info.bank_offset,
                    "链 4 模式下当前显存 bank 偏移");

    /*
     * 显存 backing store。文本模式下只导出「可见字符网格」所需的字节：
     * cols * rows 个 dword（每个 dword 是 [char, attr, plane2, plane3]），
     * 宿主按 cellStride 解释即可还原整屏。这份内容与串口日志相互独立，
     * 是验收里「VGA 内容 != 串口日志」的决定性证据来源。
     */
    if (info.vram != NULL && info.vram_size > 0) {
        uint32_t len = info.vram_size;
        uint32_t begin = 0;

        if (info.text_mode && info.text_cols > 0 && info.text_rows > 0) {
            uint64_t grid = (uint64_t)info.text_cols * info.text_rows
                            * info.cell_stride;

            if (grid > 0 && grid < len) {
                len = (uint32_t)grid;
            }
            /*
             * 文本模式下从显示起始单元开始导出：vga_update_text() 里就是
             * src = (uint32_t *)s->vram_ptr + start_addr，字节偏移等于
             * start_addr * cell_stride。这样 vramBacking 的第一格就是屏幕
             * 左上角，宿主按 line_offset 分行即可还原整屏（滚动过的屏也对）。
             */
            begin = (uint32_t)((uint64_t)info.start_addr * info.cell_stride);
            if (begin >= info.vram_size) {
                begin = 0;
            }
            if ((uint64_t)begin + (uint64_t)len > (uint64_t)info.vram_size) {
                len = info.vram_size - begin;
            }
        }
        if (len > X_OSLAB_VGA_BACKING_MAX) {
            len = X_OSLAB_VGA_BACKING_MAX;
        }
        hex = x_oslab_hex_bytes(info.vram + begin, len);
        x_oslab_dev_field(fields, "vramBacking", hex,
                          "显存 backing store（文本模式下起点是 startAddr*cellStride，"
                          "第一格即屏幕左上角；只读，不经 vga_mem_ops）",
                          0);
        g_free(hex);
    } else {
        x_oslab_dev_field(fields, "vramBacking", "unavailable",
                          "显存指针不可用（设备未 realize 或 vram_ptr 为空）", 0);
    }

    {
        int i;
        char name[16];

        for (i = 0; i < X_OSLAB_VGA_CR_BYTES; i++) {
            g_snprintf(name, sizeof(name), "cr%d", i);
            x_oslab_dev_hex(fields, name, info.cr[i], "CRTC 寄存器", 8);
        }
        for (i = 0; i < X_OSLAB_VGA_SR_BYTES; i++) {
            g_snprintf(name, sizeof(name), "sr%d", i);
            x_oslab_dev_hex(fields, name, info.sr[i], "序列器寄存器", 8);
        }
        for (i = 0; i < X_OSLAB_VGA_GR_BYTES; i++) {
            g_snprintf(name, sizeof(name), "gr%d", i);
            x_oslab_dev_hex(fields, name, info.gr[i], "图形控制器寄存器", 8);
        }
        for (i = 0; i < X_OSLAB_VGA_AR_BYTES; i++) {
            g_snprintf(name, sizeof(name), "ar%d", i);
            x_oslab_dev_hex(fields, name, info.ar[i], "属性控制器寄存器", 8);
        }
    }
}

/* ---------- virtio（QEMU 自带 x-query-virtio-queue-status + 公开访问器） ---------- */

#define X_OSLAB_VIRTIO_MAX_QUEUES 64

static void x_oslab_dev_hex_or_null(QDict *d, const char *key, bool present,
                                    uint64_t value)
{
    if (present) {
        char buf[32];

        g_snprintf(buf, sizeof(buf), "0x%" PRIx64, value);
        qdict_put_str(d, key, buf);
    } else {
        qdict_put_null(d, key);
    }
}

static void x_oslab_dev_build_virtio(QDict *dev, Object *obj, QList *fields)
{
    VirtIODevice *vdev = VIRTIO_DEVICE(obj);
    Object *transport = x_oslab_object_parent(obj);
    QList *queues = qlist_new();
    char *path = object_get_canonical_path(obj);
    int nvqs = virtio_get_num_queues(vdev);
    int i;

    x_oslab_dev_hex(fields, "virtioDeviceId", vdev->device_id,
                    "virtio 设备号（1=net 2=blk 3=console ...）", 16);
    x_oslab_dev_hex(fields, "status", vdev->status, "设备状态字节", 8);
    x_oslab_dev_hex(fields, "isr", vdev->isr, "ISR 状态字节", 8);
    x_oslab_dev_hex(fields, "queueSel", vdev->queue_sel, "队列选择寄存器", 16);
    x_oslab_dev_hex(fields, "hostFeatures", vdev->host_features,
                    "host 提供的特性位", 64);
    x_oslab_dev_hex(fields, "guestFeatures", vdev->guest_features,
                    "客机驱动已协商的特性位", 64);
    x_oslab_dev_hex(fields, "backendFeatures", vdev->backend_features,
                    "后端支持的特性位", 64);
    x_oslab_dev_hex(fields, "configGeneration", vdev->generation, "配置代数", 32);
    x_oslab_dev_hex(fields, "configLen", (uint64_t)vdev->config_len,
                    "设备配置空间长度", 32);
    x_oslab_dev_hex(fields, "nvectors", (uint64_t)vdev->nvectors,
                    "已分配的中断向量数", 32);
    x_oslab_dev_dec(fields, "numQueues", nvqs, "已创建的 virtqueue 数");
    x_oslab_dev_hex(fields, "deviceEndian", vdev->device_endian,
                    "设备端序", 8);
    if (vdev->bus_name != NULL) {
        x_oslab_dev_field(fields, "busName", vdev->bus_name, "virtio 总线名", 0);
    }
    x_oslab_dev_bool(fields, "vmRunning", vdev->vm_running, "设备认为 VM 在运行");
    x_oslab_dev_bool(fields, "broken", vdev->broken, "设备处于不可用状态");
    x_oslab_dev_bool(fields, "disabled", vdev->disabled, "设备被临时禁用");
    x_oslab_dev_bool(fields, "started", vdev->started, "设备已启动");
    x_oslab_dev_bool(fields, "vhostStarted", vdev->vhost_started,
                     "vhost 后端已启动");
    x_oslab_dev_bool(fields, "startOnKick", vdev->start_on_kick,
                     "未协商 VIRTIO_F_VERSION_1 时的延迟启动语义");
    x_oslab_dev_bool(fields, "disableLegacyCheck", vdev->disable_legacy_check,
                     "已跳过传统接口检查");
    x_oslab_dev_bool(fields, "useGuestNotifierMask",
                     vdev->use_guest_notifier_mask, "屏蔽 guest notifier");

    /*
     * 每个队列：调用 QEMU 自带的 x-query-virtio-queue-status 实现
     * (qmp_x_query_virtio_queue_status)，它读 inuse / used_idx / signalled_used /
     * vring 地址与长度，正是公开访问器取不到的字段。
     *
     * 唯一需要当心的是 vhost：该函数在 vhost_started 时会去后端查询 vring base
     * （vhost_get_vring_base）。本实验室不使用 vhost，但为了不把「可能触达后端」
     * 说成「完全只读」，这里显式分档：vhost 已启动时不调用标准命令，队列状态
     * 标注 unavailable。
     */
    for (i = 0; i < nvqs && i < X_OSLAB_VIRTIO_MAX_QUEUES; i++) {
        QDict *q = qdict_new();
        VirtQueueStatus *qs = NULL;
        Error *err = NULL;
        {
            char fbuf[32];

            qdict_put_int(q, "queueIndex", i);
            g_snprintf(fbuf, sizeof(fbuf), "0x%" PRIx64, vdev->guest_features);
            qdict_put_str(q, "negotiatedFeatures", fbuf);
            qdict_put_bool(q, "ready", virtio_queue_enabled(vdev, i));
        }

        if (!vdev->vhost_started && path != NULL) {
            qs = qmp_x_query_virtio_queue_status(path, (uint16_t)i, &err);
        }
        if (qs != NULL) {
            qdict_put_int(q, "size", qs->vring_num);
            qdict_put_int(q, "lastUsedIndex", qs->used_idx);
            if (qs->has_last_avail_idx) {
                qdict_put_int(q, "lastAvailIndex", qs->last_avail_idx);
            } else {
                qdict_put_null(q, "lastAvailIndex");
            }
            x_oslab_dev_hex_or_null(q, "descTable", true, qs->vring_desc);
            x_oslab_dev_hex_or_null(q, "availRing", true, qs->vring_avail);
            x_oslab_dev_hex_or_null(q, "usedRing", true, qs->vring_used);
        } else {
            qdict_put_int(q, "size", virtio_queue_get_num(vdev, i));
            qdict_put_null(q, "lastUsedIndex");
            qdict_put_null(q, "lastAvailIndex");
            qdict_put_null(q, "descTable");
            qdict_put_null(q, "availRing");
            qdict_put_null(q, "usedRing");
        }

        {
            QDict *ev = qdict_new();
            QList *refs = qlist_new();

            if (qs != NULL) {
                qdict_put_str(ev, "kind", "observed");
                qdict_put_str(ev, "source",
                              "qmp:x-query-virtio-queue-status");
                if (x_oslab_capture_state.id != NULL) {
                    qdict_put_str(ev, "captureId", x_oslab_capture_state.id);
                }
                qlist_append_str(refs,
                                 "hw/virtio/virtio.c:qmp_x_query_virtio_queue_status"
                                 "（QEMU 自带标准命令，观察层直接复用，未改 QEMU）");
                qlist_append_str(refs,
                                 "只读 VirtQueue 结构体字段；描述符表内容属客体内存，"
                                 "由宿主按 descTable 用 x-oslab-read-physical 独立采集");
                qlist_append_str(refs,
                                 "锁上下文: main loop + BQL（qmp_dispatch 的 BH）");
            } else {
                qdict_put_str(ev, "kind", "unavailable");
                qdict_put_str(ev, "source", "qmp:x-oslab-capture/devices");
                qdict_put_str(ev, "reason",
                              vdev->vhost_started
                              ? "vhost 后端已启动，标准查询会触达后端 vring base，"
                                "观察层不代为发起后端调用"
                              : "无法解析设备的 QOM canonical path");
                qlist_append_str(refs,
                                 "hw/virtio/virtio-qmp.c:qmp_find_virtio_device()"
                                 "（object_resolve_path + realized 检查）");
            }
            qdict_put(ev, "refs", refs);
            qdict_put(q, "evidence", ev);
        }

        if (qs != NULL) {
            char fbuf[64];

            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.inuse", i);
            x_oslab_dev_dec(fields, fbuf, qs->inuse,
                            "设备正在处理中的描述符链数（标准查询）");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.vringNumDefault", i);
            x_oslab_dev_dec(fields, fbuf, qs->vring_num_default,
                            "QEMU 默认队列长度（与协商后的 size 对照）");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.vringAlign", i);
            x_oslab_dev_dec(fields, fbuf, qs->vring_align,
                            "vring 对齐要求（字节）");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.signalledUsed", i);
            x_oslab_dev_dec(fields, fbuf, qs->signalled_used,
                            "上一次向客体发通知时的 used 索引");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.signalledUsedValid", i);
            x_oslab_dev_bool(fields, fbuf, qs->signalled_used_valid,
                             "signalledUsed 是否有效");
            if (qs->has_shadow_avail_idx) {
                g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.shadowAvailIdx", i);
                x_oslab_dev_dec(fields, fbuf, qs->shadow_avail_idx,
                                "影子 avail 索引（非 vhost 时与 lastAvailIndex 配对）");
            }
        }
        {
            char fbuf[64];

            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.vector", i);
            x_oslab_dev_dec(fields, fbuf, virtio_queue_vector(vdev, i),
                            "该队列使用的 MSI-X 向量");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.descSize", i);
            x_oslab_dev_dec(fields, fbuf,
                            (int64_t)virtio_queue_get_desc_size(vdev, i),
                            "描述符表字节数");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.availSize", i);
            x_oslab_dev_dec(fields, fbuf,
                            (int64_t)virtio_queue_get_avail_size(vdev, i),
                            "avail 环字节数");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.usedSize", i);
            x_oslab_dev_dec(fields, fbuf,
                            (int64_t)virtio_queue_get_used_size(vdev, i),
                            "used 环字节数");
            g_snprintf(fbuf, sizeof(fbuf), "virtqueue.%d.notification", i);
            x_oslab_dev_bool(fields, fbuf,
                             virtio_queue_get_notification(
                                 virtio_get_queue(vdev, i)),
                             "该队列是否启用完成通知");
        }

        qlist_append(queues, q);
        if (qs != NULL) {
            qapi_free_VirtQueueStatus(qs);
        }
        error_free(err);
    }

    if (nvqs > 0) {
        qdict_put(dev, "virtqueues", queues);
    } else {
        qobject_unref(queues);
    }
    if (nvqs > X_OSLAB_VIRTIO_MAX_QUEUES) {
        x_oslab_dev_field(fields, "virtqueuesTruncated",
                          "true", "队列数超过上报上限，已截断", 0);
    }

    g_free(path);
    /*
     * BAR 由传输层（PCI 设备）代理拥有，VirtIODevice 自己不是 MemoryRegion 的
     * owner；virtio_init_hw()/virtio_pci 的 BAR 都挂在传输层对象上。
     */
    x_oslab_dev_add_ranges(dev, fields, obj, transport);
}

/* ---------- 收集、排序与汇总 ---------- */

typedef struct XOslabDeviceEntry {
    XOslabDeviceRank rank;
    char *deviceId;
    QDict *snapshot;
} XOslabDeviceEntry;

static void x_oslab_device_entry_free(gpointer opaque)
{
    XOslabDeviceEntry *e = opaque;

    if (e == NULL) {
        return;
    }
    g_free(e->deviceId);
    qobject_unref(e->snapshot);
    g_free(e);
}

static XOslabDeviceEntry *x_oslab_device_entry_new(XOslabDeviceRank rank,
                                                   const char *device_id,
                                                   Object *pci_candidate,
                                                   const char *point,
                                                   QDict *dev, QList *fields)
{
    XOslabDeviceEntry *e = g_new0(XOslabDeviceEntry, 1);
    PCIDevice *pdev;

    e->rank = rank;
    e->deviceId = g_strdup(device_id != NULL ? device_id : "(anonymous)");
    qdict_put_str(dev, "deviceId", e->deviceId);
    qdict_put_str(dev, "kind", x_oslab_rank_kind(rank));
    qdict_put_bool(dev, "readOnly", true);

    pdev = pci_candidate != NULL
           ? PCI_DEVICE(object_dynamic_cast(pci_candidate, TYPE_PCI_DEVICE))
           : NULL;
    if (pdev != NULL) {
        char buf[32];

        g_snprintf(buf, sizeof(buf), "%02x:%02x.%x",
                   pci_dev_bus_num(pdev), PCI_SLOT(pdev->devfn),
                   PCI_FUNC(pdev->devfn));
        qdict_put_str(dev, "pciAddress", buf);
    }

    qdict_put(dev, "fields", fields);
    x_oslab_dev_evidence(dev, point);
    e->snapshot = dev;
    return e;
}

static int x_oslab_device_scan_cb(Object *obj, void *opaque)
{
    GPtrArray *entries = opaque;
    XOslabDeviceEntry *e = NULL;
    QDict *dev;
    QList *fields;
    char *path;

    if (entries->len >= X_OSLAB_MAX_DEVICES) {
        return 0;
    }
    if (object_dynamic_cast(obj, TYPE_SERIAL) == NULL
        && object_dynamic_cast(obj, TYPE_I8042) == NULL
        && object_dynamic_cast(obj, TYPE_PIC_COMMON) == NULL
        && object_dynamic_cast(obj, TYPE_PIT_COMMON) == NULL
        && object_dynamic_cast(obj, TYPE_APIC_COMMON) == NULL
        && object_dynamic_cast(obj, TYPE_VIRTIO_DEVICE) == NULL) {
        /* VGA 不是 QOM 类型，由登记表单独收集（见 x_oslab_devices_collect）。 */
        return 0;
    }

    dev = qdict_new();
    fields = qlist_new();
    path = object_get_canonical_path(obj);

    if (object_dynamic_cast(obj, TYPE_SERIAL) != NULL) {
        x_oslab_dev_build_uart(dev, obj, fields);
        e = x_oslab_device_entry_new(
            X_OSLAB_DR_UART, path, obj,
            "include/hw/char/serial.h SerialState（recv_fifo/xmit_fifo 为 Fifo8，"
            "定义在 include/qemu/fifo8.h）；私有位常量取自 hw/char/serial.c:41-101；"
            "快照不走 serial_ioport_read（那里的读 IIR 会清 thr_ipending、读 RBR "
            "会 fifo8_pop）",
            dev, fields);
    } else if (object_dynamic_cast(obj, TYPE_I8042) != NULL) {
        x_oslab_dev_build_i8042(dev, obj, fields);
        e = x_oslab_device_entry_new(
            X_OSLAB_DR_I8042, path, obj,
            "include/hw/input/i8042.h ISAKBDState.kbd（KBDState）；"
            "include/hw/input/ps2.h PS2KbdState/PS2MouseState 与 PS2Queue；"
            "队列按 rptr/count 算下标读，不走 ps2_read_data",
            dev, fields);
    } else if (object_dynamic_cast(obj, TYPE_PIC_COMMON) != NULL) {
        x_oslab_dev_build_pic(dev, obj, fields);
        e = x_oslab_device_entry_new(
            X_OSLAB_DR_PIC, path, obj,
            "include/hw/isa/i8259_internal.h PICCommonState；"
            "include/hw/intc/i8259.h:17 pic_get_output()（pic_get_irq 只读 "
            "irr/imr/isr/priority_add）；快照不走 pic_ioport_read（OCW3/poll 会改变"
            "确认语义）",
            dev, fields);
    } else if (object_dynamic_cast(obj, TYPE_PIT_COMMON) != NULL) {
        x_oslab_dev_build_pit(dev, obj, fields);
        e = x_oslab_device_entry_new(
            X_OSLAB_DR_TIMER, path, obj,
            "include/hw/timer/i8254_internal.h PITCommonState / PITChannelState；"
            "时间字段（countLoadTime/nextTransitionTime）原样上报虚拟时钟纳秒，"
            "不调用会重算到期时间的 helper",
            dev, fields);
    } else if (object_dynamic_cast(obj, TYPE_APIC_COMMON) != NULL) {
        x_oslab_dev_build_apic(dev, obj, fields);
        e = x_oslab_device_entry_new(
            X_OSLAB_DR_APIC, path, obj,
            "include/hw/i386/apic_internal.h APICCommonState；"
            "apic_internal.h:210 apic_get_current_count()（读寄存器 + 虚拟时钟，"
            "不改状态）；IRR/ISR/TMR 直接从结构体数组取，不走 MMIO 窗口",
            dev, fields);
    } else {
        VirtIODevice *vdev = VIRTIO_DEVICE(obj);
        XOslabDeviceRank rank;

        if (vdev->device_id == VIRTIO_ID_BLOCK) {
            rank = X_OSLAB_DR_VIRTIO_BLK;
        } else if (vdev->device_id == VIRTIO_ID_NET) {
            rank = X_OSLAB_DR_VIRTIO_NET;
        } else {
            rank = X_OSLAB_DR_VIRTIO_OTHER;
        }
        x_oslab_dev_build_virtio(dev, obj, fields);
        e = x_oslab_device_entry_new(
            rank, path, x_oslab_object_parent(obj),
            "include/hw/virtio/virtio.h VirtIODevice 公开访问器 + QEMU 自带 "
            "qmp_x_query_virtio_queue_status()（hw/virtio/virtio.c，"
            "qapi/qapi-commands-virtio.h）；队列元数据只读结构体字段",
            dev, fields);
    }

    if (e != NULL) {
        g_ptr_array_add(entries, e);
    } else {
        qobject_unref(dev);
        qobject_unref(fields);
    }
    g_free(path);
    return 0;
}

static void x_oslab_devices_collect(GPtrArray *entries)
{
    uint32_t nvga = x_oslab_vga_count();
    uint32_t i;

    /*
     * 遍历 QOM 组合树找设备，与 hw/virtio/virtio-qmp.c:qmp_x_query_virtio() 用
     * 的是同一个机制（object_child_foreach_recursive + object_dynamic_cast），
     * 不自造设备枚举。
     */
    object_child_foreach_recursive(object_get_root(), x_oslab_device_scan_cb,
                                   entries);

    /*
     * VGACommonState 不是 QOM 类型（被内嵌在 PCIVGAState 里），只能通过补丁
     * 0004 的登记表找到。这里用 canonical path 反查 QOM 对象，好把 PCI 位置与
     * BAR 区间一起报出来。
     */
    for (i = 0; i < nvga && entries->len < X_OSLAB_MAX_DEVICES; i++) {
        char *vpath = x_oslab_vga_path(i);
        Object *obj = vpath != NULL ? object_resolve_path(vpath, NULL) : NULL;
        QDict *dev = qdict_new();
        QList *fields = qlist_new();

        x_oslab_dev_build_vga(dev, i, fields);
        if (obj != NULL) {
            x_oslab_dev_add_ranges(dev, fields, obj, NULL);
        }
        g_ptr_array_add(entries, x_oslab_device_entry_new(
            X_OSLAB_DR_VGA, vpath, obj,
            "hw/display/vga.c:x_oslab_vga_snapshot()（补丁 0004 的只读登记表）；"
            "几何参数取 get_offsets()/get_resolution() 现算（与 vga_update_text() "
            "同一算法）；显存走 s->vram_ptr backing store，不经 vga_mem_ops",
            dev, fields));
        g_free(vpath);
    }
}

/* 排序键：类别 rank 升序，同 rank 内按 deviceId 字典序，保证输出稳定。 */
static gint x_oslab_device_cmp(gconstpointer a, gconstpointer b)
{
    const XOslabDeviceEntry *ea = *(const XOslabDeviceEntry * const *)a;
    const XOslabDeviceEntry *eb = *(const XOslabDeviceEntry * const *)b;

    if (ea->rank != eb->rank) {
        return (gint)ea->rank - (gint)eb->rank;
    }
    return g_strcmp0(ea->deviceId, eb->deviceId);
}

/**
 * 把设备快照数组放进 capture 响应，并补一个计数。
 * 若一台设备都没发现（例如机器尚未 realize），显式记进 unavailable 而不是
 * 返回一个看起来「正常」的空数组。
 */
static void x_oslab_devices_json(QDict *out, QList *unavailable)
{
    GPtrArray *entries = g_ptr_array_new_with_free_func(x_oslab_device_entry_free);
    QList *list = qlist_new();
    uint32_t i;

    x_oslab_devices_collect(entries);
    g_ptr_array_sort(entries, x_oslab_device_cmp);

    for (i = 0; i < entries->len; i++) {
        XOslabDeviceEntry *e = g_ptr_array_index(entries, i);

        qlist_append(list, qobject_ref(e->snapshot));
    }

    qdict_put(out, "devices", list);
    qdict_put_int(out, "deviceCount", (int64_t)entries->len);
    if (entries->len == 0 && unavailable != NULL) {
        qlist_append_str(unavailable,
                         "devices: 当前没有发现可快照的设备（机器未 realize？）");
    }
    g_ptr_array_unref(entries);
}

/* ---------- capabilities 里的设备能力表 ---------- */

static const struct {
    const char *key;
    const char *point;
} x_oslab_device_points[] = {
    { "discovery",
      "QEMU 自带 object_child_foreach_recursive() + object_dynamic_cast()"
      "（hw/virtio/virtio-qmp.c:qmp_x_query_virtio 同机制）" },
    { "uart",
      "include/hw/char/serial.h SerialState；私有位见 hw/char/serial.c:41-101；"
      "非破坏性读 FIFO（不走 serial_ioport_read）" },
    { "i8042",
      "include/hw/input/i8042.h ISAKBDState.kbd；include/hw/input/ps2.h "
      "PS2KbdState/PS2MouseState/PS2Queue（不走 ps2_read_data）" },
    { "pic",
      "include/hw/isa/i8259_internal.h PICCommonState；"
      "include/hw/intc/i8259.h:17 pic_get_output()" },
    { "pit",
      "include/hw/timer/i8254_internal.h PITCommonState / PITChannelState" },
    { "apic",
      "include/hw/i386/apic_internal.h APICCommonState；"
      "apic_internal.h:210 apic_get_current_count()" },
    { "vga",
      "hw/display/vga.c:x_oslab_vga_snapshot()（补丁 0004）；几何参数取 "
      "get_offsets()/get_resolution()，与 vga_update_text() 同一算法" },
    { "virtio",
      "QEMU 自带 qmp_x_query_virtio_queue_status()（hw/virtio/virtio.c）"
      "读 VirtQueue 的 inuse/used_idx/signalled_used/vring 地址，未改 QEMU" },
    { "threading",
      "monitor/x-oslab-observer.c 命令处理（main loop + BQL 的 BH）；"
      "设备状态改动同样在 BQL 下，读到的是已提交状态" },
};

static void x_oslab_devices_capability(QDict *parent, QList *unavailable)
{
    QDict *cap = qdict_new();
    QDict *points = qdict_new();
    QList *kinds = qlist_new();
    QList *notes = qlist_new();
    unsigned int i;

    qdict_put_bool(cap, "supported", true);
    qdict_put_str(cap, "transport", "x-oslab-capture.devices");
    qdict_put_bool(cap, "readOnly", true);
    qdict_put_str(cap, "readGate",
                  "captureId 有效；快照只读，不消耗 FIFO、不确认 IRQ、"
                  "不推进客体状态");
    qlist_append_str(kinds, "vga");
    qlist_append_str(kinds, "uart");
    qlist_append_str(kinds, "i8042");
    qlist_append_str(kinds, "pic");
    qlist_append_str(kinds, "apic");
    qlist_append_str(kinds, "timer");
    qlist_append_str(kinds, "virtio-blk");
    qlist_append_str(kinds, "virtio-net");
    qlist_append_str(kinds, "other");
    qdict_put(cap, "kinds", kinds);
    for (i = 0; i < ARRAY_SIZE(x_oslab_device_points); i++) {
        qdict_put_str(points, x_oslab_device_points[i].key,
                      x_oslab_device_points[i].point);
    }
    qdict_put(cap, "observationPoints", points);
    qlist_append_str(notes,
                     "virtqueue 状态复用 QEMU 自带 x-query-virtio-queue-status，"
                     "不为形式重复改 QEMU；描述符表内容属客体内存，由宿主按 "
                     "descTable 用 x-oslab-read-physical 独立采集");
    qlist_append_str(notes,
                     "中断状态从 PIC/APIC 结构体字段读取，不读会触发确认语义的 "
                     "OCW3/poll 与 APIC IRR/ISR MMIO 窗口");
    qlist_append_str(notes,
                     "只有 x86_64 目标提供设备快照（补丁 0004 与 APIC/PIC 头文件"
                     "都依赖 TARGET_I386）");
    qdict_put(cap, "notes", notes);
    qdict_put(parent, "devices", cap);

    (void)unavailable;
}

#else /* !TARGET_I386 */

/*
 * 设备快照只在 x86_64 目标上实现：APIC/PIC/PIT 的设备结构体头文件都属于
 * i386 目标。非 i386 目标保留接口形状（空数组 + 明确原因），不用假数据凑数。
 */
static void x_oslab_devices_json(QDict *out, QList *unavailable)
{
    qdict_put(out, "devices", qlist_new());
    qdict_put_int(out, "deviceCount", 0);
    if (unavailable != NULL) {
        qlist_append_str(unavailable,
                         "devices: 设备快照只在 x86_64 目标上实现（T05d）");
    }
}

static void x_oslab_devices_capability(QDict *parent, QList *unavailable)
{
    QDict *cap = qdict_new();

    qdict_put_bool(cap, "supported", false);
    qdict_put_str(cap, "reason", "设备快照只在 x86_64 目标上实现（T05d）");
    qdict_put(parent, "devices", cap);
    if (unavailable != NULL) {
        qlist_append_str(unavailable,
                         "devices: 设备快照只在 x86_64 目标上实现（T05d）");
    }
}

#endif /* TARGET_I386 */

/* ------------------------------------------------------------------ 命令实现 */

static void qmp_x_oslab_capabilities(QDict *args, QObject **ret, Error **errp)
{
    QDict *out = qdict_new();
    QDict *cpu = qdict_new();
    QDict *memory = qdict_new();
    QDict *events = qdict_new();
    QDict *barrier = qdict_new();
    QDict *points = qdict_new();
    QDict *event_points = qdict_new();
    QList *fields = qlist_new();
    QList *gpr_names = qlist_new();
    QList *kinds = qlist_new();
    QList *unavailable = qlist_new();
    QList *event_kinds = qlist_new();
    QList *event_unavailable = qlist_new();
    QList *event_gaps = qlist_new();
    unsigned int k;
#ifdef TARGET_X86_64
    int i;
#endif

    (void)args;
    (void)errp;

    qdict_put_str(out, "schema", X_OSLAB_PROTO_SCHEMA);
    qdict_put_int(out, "protocolVersion", X_OSLAB_PROTO_VERSION);
    qdict_put_bool(out, "patched", true);
    qdict_put_str(out, "qemuVersion", QEMU_VERSION);
    qdict_put_str(out, "target", "x86_64-softmmu");

    qlist_append_str(fields, "mode");
    qlist_append_str(fields, "cpl");
    qlist_append_str(fields, "rip");
    qlist_append_str(fields, "rsp");
    qlist_append_str(fields, "rflags");
    qlist_append_str(fields, "gpr");
    qlist_append_str(fields, "segmentCache");
    qlist_append_str(fields, "gdt");
    qlist_append_str(fields, "idt");
    qlist_append_str(fields, "cr0");
    qlist_append_str(fields, "cr2");
    qlist_append_str(fields, "cr3");
    qlist_append_str(fields, "cr4");
    qlist_append_str(fields, "cr8");
    qlist_append_str(fields, "efer");
    qlist_append_str(fields, "hflags");
    qlist_append_str(fields, "halted");
    qdict_put(cpu, "fields", fields);
    qdict_put_bool(cpu, "segmentCache", true);
    qdict_put_bool(cpu, "controlRegisters", true);
    qdict_put_bool(cpu, "cr8FromApicTpr", true);
    qdict_put_bool(cpu, "efer", true);
    qdict_put_bool(cpu, "gdtIdt", true);
    qdict_put_bool(cpu, "generalRegisters", true);
#ifdef TARGET_X86_64
    for (i = 0; i < X_OSLAB_GPR_COUNT; i++) {
        qlist_append_str(gpr_names, x_oslab_gpr_names[i]);
    }
#else
    qlist_append_str(gpr_names, "unimplemented");
#endif
    qdict_put(cpu, "gprNames", gpr_names);
    qdict_put(out, "cpu", cpu);

    qdict_put_str(memory, "physicalRead", "ram-rom-only");
    qdict_put_bool(memory, "regionTable", true);
    qdict_put_int(memory, "maxReadBytes", X_OSLAB_MAX_READ_BYTES);
    qlist_append_str(kinds, "ram");
    qlist_append_str(kinds, "rom");
    qlist_append_str(kinds, "romd");
    qdict_put(memory, "readableKinds", kinds);
    qdict_put_bool(memory, "rejectsMmio", true);
    qdict_put_str(memory, "readGate",
                  "captureId 有效 && VM 未推进 && 区域可直读");
    qdict_put(out, "memory", memory);

    x_oslab_events_runtime(events);
    for (k = 0; k < ARRAY_SIZE(x_oslab_produced_kinds); k++) {
        qlist_append_str(event_kinds,
                         x_oslab_event_kind_name(x_oslab_produced_kinds[k]));
    }
    for (k = 0; k < ARRAY_SIZE(x_oslab_unavailable_kinds); k++) {
        qlist_append_str(event_unavailable,
                         x_oslab_event_kind_name(x_oslab_unavailable_kinds[k]));
    }
    for (k = 0; k < ARRAY_SIZE(x_oslab_event_points); k++) {
        qdict_put_str(event_points, x_oslab_event_points[k].key,
                      x_oslab_event_points[k].point);
    }
    qlist_append_str(event_gaps,
                     "128 位访存（INDEX_op_qemu_ld/st_i128 走 gen_helper_ld_i128/"
                     "st_i128）不产生 memory 事件");
    qlist_append_str(event_gaps,
                     "并行 TCG 下的原子 cmpxchg/op helper 不产生 memory 事件"
                     "（本实验室用 -accel tcg,thread=single，普通访存不受影响）");
    qlist_append_str(event_gaps,
                     "没有正常完成的指令不产生 instruction.retire：DISAS_NORETURN"
                     "（异常、hlt 等）与分支 / DISAS_EOB_*（TB 退出已在指令代码里"
                     "发射，之后的 op 是死代码）。反过来，in/out/ins/outs 虽然由 "
                     "translator_io_start 单独占一个 TB，也照常产生 retire");
    qlist_append_str(event_gaps,
                     "dma.* 上报的是描述符映射出的访问权，不是逐字节传输采样：设备把 "
                     "dma_memory_map() 的宿主指针直接解引用（virtio-blk 的 "
                     "stb_p(&req->in->status)），这类访问不经过 address_space_*，没有"
                     "地址空间层的插桩点；事件只保证「哪个客体物理区间、哪个方向、属于"
                     "哪个请求」真实，载荷字节必须由 x-oslab-read-physical 独立核对");
    qlist_append_str(event_gaps,
                     "block.submit/block.complete 只覆盖 virtio-blk 的读写请求"
                     "（VIRTIO_BLK_T_IN/OUT）：请求头不合法、越界、类型不支持的拒绝路径"
                     "与 flush/discard/zone/GET_ID 不产生 block 事件（因此 submit/"
                     "complete 严格配对）；dma.* 则覆盖全部 virtio 设备的描述符映射"
                     "（含非块设备）");
    qlist_append_str(event_gaps,
                     "非 virtio 的设备 DMA（IDE、NVMe、vhost-user/vhost 后端）不产生 "
                     "dma.* 事件：这些设备要么不走 virtqueue_pop，要么 DMA 由宿主进程"
                     "完成，观察扩展看不到");
    qlist_append_str(event_gaps,
                     "capture.fence 由观察者自己记录（不是 QEMU 产生的事件）：它是"
                     "帧分界的书签，value 报那一刻 pending 的块请求数；采集关闭或该 "
                     "kind 被记录期掩码排除时它不入环，此时这一帧没有 fence 标记，"
                     "读取方必须退回 eventWatermark 并按「无 fence」解释");
    qlist_append_str(event_gaps,
                     "pending I/O 台账只覆盖 virtio-blk 的读写请求（与 block.* 事件的"
                     "覆盖面一致）；hostIoDone 表示宿主块层的完成回调已经进入，但本"
                     "实验室把 virtio-blk 留在默认主循环（无 iothread），该回调也要拿 "
                     "BQL，所以「hostIoDone 为真、状态字节还没写」这个窗口极窄 —— "
                     "pending 的判据始终是「有没有对客体可见」，不是 hostIoDone");
    qlist_append_str(event_gaps,
                     "宿主错误动作 stop（werror/rerror=stop，或 blkdebug 注入错误）"
                     "会让 virtio-blk 把请求挂到 s->rq 上且本次不完成：这类请求会"
                     "长期停在 pending 里，直到 VM 恢复（virtio_blk_dma_restart_cb）"
                     "把它重新提交、或设备复位时被 detach 释放（后者不发 "
                     "block.complete，只有 block.submit 出现两次而 complete 只出现"
                     "一次，是真实行为而不是漏报）");
    qdict_put_str(events, "granularity",
                  "每条指令的 instruction.begin（尝试执行）与 instruction.retire"
                  "（仅成功落到下一条指令的路径）、每个 TCG 访存 op 的 "
                  "memory.read/write、每次客体 in/out 的 io.read/write、每次进入"
                  "中断/异常处理程序的 interrupt.accept / exception.raise；T05c 起"
                  "另有每个 virtqueue 描述符段的 dma.read/dma.write（设备拿到的访问"
                  "权）与被 virtio-blk 接受的读写请求的 block.submit/block.complete；"
                  "T05e 起每次 x-oslab-capture 记录一条 capture.fence（帧分界，"
                  "detail.pendingBlockRequests 报采集那一刻仍在飞行的块请求数）");
    qdict_put_str(events, "readGate",
                  "读取不要求 VM 停止（事件环自带 QemuSpin）；enable/reset 只在 VM "
                  "停止时接受，运行中拒绝 reason=vm-running");
    qdict_put_int(events, "defaultLimit", X_OSLAB_DEFAULT_EVENT_LIMIT);
    qdict_put_int(events, "maxLimit", X_OSLAB_EVENT_RING_CAPACITY);
    qdict_put(events, "kinds", event_kinds);
    qdict_put(events, "unavailableKinds", event_unavailable);
    qdict_put(events, "knownGaps", event_gaps);
    qdict_put(events, "observationPoints", event_points);
    qdict_put(out, "events", events);

    qdict_put_bool(barrier, "supported", true);
    qdict_put_bool(barrier, "requiresAllVcpusStopped", true);
    qdict_put_str(barrier, "context", "main-loop + BQL");
    qdict_put_bool(barrier, "eventWatermarkIsFence", true);
    qdict_put_bool(barrier, "pendingIoClassified", true);
    qdict_put_str(barrier, "note",
                  "eventWatermark 自 T05b 起是真实水位线，自 T05e 起等于该帧 "
                  "capture.fence 的 seq，因此「seq <= watermark」与「属于这一帧」是"
                  "同一件事；pending I/O 分类自 T05e 起可用（见 capture.pendingIo），"
                  "判据是「状态字节有没有回写客体」，不是宿主块层还在不在忙");
    qdict_put(out, "stopBarrier", barrier);

    {
        /*
         * T05e：pending I/O 分类能力自述。
         * 这份声明描述的是「台账里能报什么」，与 capture.pendingIo 的实际内容
         * 一一对应；readGate 说明它在什么条件下才可信。
         */
        QDict *pending = qdict_new();
        QList *pendingFields = qlist_new();

        qdict_put_bool(pending, "supported", true);
        qdict_put_str(pending, "field", "x-oslab-capture.pendingIo");
        qdict_put_str(pending, "ledgerAnchor",
                      "accel/tcg/x-oslab-events.c 的 XOslabInflightState"
                      "（QemuSpin 保护，容量 X_OSLAB_INFLIGHT_CAPACITY）");
        qdict_put_str(pending, "pendingCriterion",
                      "状态字节有没有回写客体（virtio_blk_req_complete() 有没有"
                      "执行）；宿主块层是否还在忙不改变 pending 判定，只体现在 "
                      "hostIoDone 上");
        qdict_put_str(pending, "barrierObservability",
                      "停机屏障（stop/pause 等任何让全部 vCPU 停止的动作）走 "
                      "vm_state_notify → virtio_vmstate_change → "
                      "virtio_bus_stop_ioeventfd → virtio_blk_data_plane_stop → "
                      "blk_drain；blk_root_drained_begin 会置 io_limits_disabled "
                      "并调 throttle_group_restart_tgm() 取消/立即触发节流定时器，"
                      "随后 AIO_WAIT_WHILE(blk->in_flight > 0) 等在飞 I/O 做完。"
                      "因此对 virtio-blk，停机屏障处 host-io-pending 不可观测；"
                      "屏障处真正能读到的 pending 是设备层已挂起的请求"
                      "（host-io-done-awaiting-visibility，例如 werror=stop 把"
                      "请求挂到 s->rq 上）");
        qdict_put_str(pending, "readGate",
                      "只有「全部 vCPU 已停止 + main loop + BQL」这个统一串行化点"
                      "上的快照才是一致快照：块层完成回调也要拿 BQL，不可能插进"
                      "采集过程");
        qdict_put_str(pending, "coverage", "virtio-blk 的读写请求"
                      "（VIRTIO_BLK_T_IN/OUT，即发过 block.submit 的那些请求）");
        qdict_put_str(pending, "resubmitSemantics",
                      "宿主错误动作 stop（werror/rerror=stop）会让请求挂在 "
                      "s->rq 上且本次不完成；VM 恢复时 virtio_blk_dma_restart_bh() "
                      "重新提交同一个请求对象，于是同一 requestId 有两条 "
                      "block.submit、一条 block.complete（真实行为）。重提交会把"
                      "台账条目按新提交刷新：hostIoDone 归 false、hostDoneSeq 归 0、"
                      "submitSeq 更新，并累加 resubmitCount");
        qlist_append_str(pendingFields, "deviceId（设备名，与 dma.*/block.* 同一写法）");
        qlist_append_str(pendingFields, "deviceIndex / requestIdRaw（注册表 id 与打包值原样）");
        qlist_append_str(pendingFields, "requestId（vq<队列索引>-<描述符>，与 dma.*/block.* 同一个关联 id）");
        qlist_append_str(pendingFields, "lba / byteOffset / length（字节）");
        qlist_append_str(pendingFields, "reqType / op（read|write）");
        qlist_append_str(pendingFields, "outSeg / inSeg（描述符段数）");
        qlist_append_str(pendingFields, "hostIoDone / state"
                        "（host-io-pending | host-io-done-awaiting-visibility）");
        qlist_append_str(pendingFields, "submitSeq / hostDoneSeq（事件水位线；0 表示"
                        "对应事件没有被记录）");
        qdict_put(pending, "fields", pendingFields);
        qdict_put_str(pending, "forbidden",
                      "采集过程不得为「让磁盘看起来稳定」而主动完成 pending 请求、"
                      "推进虚拟时钟或清空中断；capture 只读台账与设备状态");
        qdict_put(out, "pendingIo", pending);
    }

    qdict_put_int(out, "lostEvents", (int64_t)x_oslab_event_dropped());
    qdict_put_int(out, "captureSerial", (int64_t)x_oslab_capture_state.serial);
    qput_u64(out, "vmGeneration", x_oslab_vm_generation);

    qdict_put_str(points, "segmentCache",
                  "target/i386/cpu.h:1613 CPUX86State.segs[6]");
    qdict_put_str(points, "controlRegisters",
                  "target/i386/cpu.h:1619 CPUX86State.cr[5]");
    qdict_put_str(points, "cr8", "include/hw/i386/apic.h:15 cpu_get_apic_tpr()");
    qdict_put_str(points, "efer", "target/i386/cpu.h:1628 CPUX86State.efer");
    qdict_put_str(points, "gdtIdt",
                  "target/i386/cpu.h:1616-1617 CPUX86State.gdt/.idt");
    qdict_put_str(points, "vcpuStopped",
                  "include/hw/core/cpu.h:477 CPUState.stopped");
    qdict_put_str(points, "vmState",
                  "include/sysemu/runstate.h runstate_get()");
    qdict_put_str(points, "vmGeneration",
                  "system/runstate.c:320 qemu_add_vm_change_state_handler()");
    qdict_put_str(points, "regions",
                  "flatview_for_each_range() over address_space_memory");
    qdict_put_str(points, "readable",
                  "include/exec/memory.h:2956 memory_access_is_direct(mr, false)");
    qdict_put_str(points, "threading",
                  "qapi/qmp-dispatch.c do_qmp_dispatch_bh (main loop, BQL held)");
    qdict_put(out, "observationPoints", points);

    qlist_append_str(unavailable,
                     "eventKinds: 见 events.unavailableKinds（irq / input / serial / "
                     "observer.drop 仍未实现）");
    qlist_append_str(unavailable, "diskVersions: T06");
    qlist_append_str(unavailable,
                     "events: irq / input / serial 仍未实现；dma.* 与 block.* 自 T05c "
                     "起可用，capture.fence 自 T05e 起可用");
    qlist_append_str(unavailable,
                     "pendingIo: 只覆盖 virtio-blk 的读写请求；其它块设备（IDE、"
                     "NVMe、vhost）与非 virtio 设备既没有 block.* 事件，也不进 "
                     "pending 台账，采集时它们名下没有可报告的未完成请求");
#if !X_OSLAB_EVENTS_AVAILABLE
    qlist_append_str(unavailable, "events: 该构建未启用 CONFIG_TCG");
#endif

    /* T05d：设备面板的无副作用快照能力表。 */
    x_oslab_devices_capability(out, unavailable);

    qdict_put(out, "unavailable", unavailable);

    *ret = QOBJECT(out);
}

/*
 * T05e：把 pending 块请求台账的快照序列化成 capture.pendingIo。
 *
 * 只读：不碰任何设备 MMIO、不推进虚拟时钟、不确认中断，也绝不让请求「先做完」。
 * 台账本身在采集点已被排空到本地快照里，之后即便设备侧有并发也不影响这一份结果
 * （何况此刻全部 vCPU 已停止、BQL 在手上）。
 *
 * 返回快照条数（等于 pending 数）；hostDoneCount 回传「宿主完成回调已进入、状态
 * 字节还没回写」的条数。
 */
static uint32_t x_oslab_pending_io_json(QDict **out_pending,
                                        uint32_t *host_done_count)
{
    uint32_t capacity = x_oslab_block_inflight_capacity();
    XOslabBlockInflight *snap;
    QDict *pending = qdict_new();
    QList *requests = qlist_new();
    QList *notes = qlist_new();
    uint64_t overflow = x_oslab_block_inflight_overflow();
    uint32_t done = 0;
    uint32_t count;
    uint32_t i;

    snap = g_new0(XOslabBlockInflight, capacity);
    count = x_oslab_block_inflight_snapshot(snap, capacity);

    for (i = 0; i < count; i++) {
        const XOslabBlockInflight *e = &snap[i];
        QDict *item = qdict_new();
        const char *name = x_oslab_device_name(e->deviceId);

        /*
         * 标识字段刻意与 dma.* / block.* 事件用同一套写法：deviceId 是设备名
         * （QOM canonical path）、requestId 是「vq<队列索引>-<描述符>」。台账
         * 内部存的是数字 id 与打包值，这里只是翻译成事件里同一件东西的同一个
         * 字符串，读取方不必自己拼就能把台账条目和事件关联到同一个请求上。
         * 数字 id 另放在 deviceIndex / requestIdRaw，供需要精确比较的读取方使用。
         */
        qdict_put_str(item, "deviceId",
                      name != NULL ? name : "unregistered-device");
        qdict_put_int(item, "deviceIndex", (int64_t)e->deviceId);
        {
            char id[48];

            g_snprintf(id, sizeof(id), "vq%u-%u",
                       (unsigned)(e->requestId >> 32),
                       (unsigned)(e->requestId & 0xffffffffu));
            qdict_put_str(item, "requestId", id);
        }
        qput_u64(item, "requestIdRaw", e->requestId);
        {
            char lba[32];

            g_snprintf(lba, sizeof(lba), "%" PRIu64, e->lba);
            qdict_put_str(item, "lba", lba);
        }
        /* 扇区号换算成字节偏移，方便与 read-physical / 宿主镜像直接对照。 */
        qput_hex(item, "byteOffset", e->lba << 9);
        qdict_put_int(item, "length", (int64_t)e->length);
        qdict_put_int(item, "reqType", (int64_t)e->reqType);
        qdict_put_str(item, "op", x_oslab_block_op_name(e->reqType));
        qdict_put_int(item, "outSeg", (int64_t)e->outSeg);
        qdict_put_int(item, "inSeg", (int64_t)e->inSeg);
        qdict_put_bool(item, "hostIoDone", e->hostIoDone);
        /*
         * 两态分类：pending 的判据是「对客体是否可见」，hostIoDone 只是并列事实。
         * 状态名直译这两层含义，避免读取方把 hostIoDone 当成 pending 判据。
         */
        qdict_put_str(item, "state",
                      e->hostIoDone ? "host-io-done-awaiting-visibility"
                                    : "host-io-pending");
        if (e->hostIoDone) {
            done++;
        }
        qput_u64(item, "submitSeq", e->submitSeq);
        qput_u64(item, "hostDoneSeq", e->hostDoneSeq);
        qlist_append(requests, item);
    }
    g_free(snap);

    qdict_put_str(pending, "pendingCriterion",
                  "guest-visibility：状态字节有没有回写客体"
                  "（virtio_blk_req_complete() 有没有执行）；hostIoDone 不改变"
                  "pending 判定");
    qdict_put_int(pending, "count", (int64_t)count);
    qdict_put_int(pending, "hostIoDoneCount", (int64_t)done);
    qdict_put_int(pending, "ledgerCapacity", (int64_t)capacity);
    qput_u64(pending, "ledgerOverflow", overflow);
    /*
     * T05e：对已在台账里的 requestId 再次 submit 的次数。宿主错误动作 stop 会让
     * 请求挂在 s->rq 上且本次不完成，VM 恢复时设备重新提交同一个请求对象，于是
     * 同一个 requestId 会出现两条 block.submit、却只有一条 block.complete —— 这是
     * 真实行为而不是漏报，所以单独给一个计数；重提交时该条目会按新提交刷新
     * （hostIoDone 归 false、submitSeq 更新），上一回合的「宿主已完成」不会被读成
     * 这一回合的事实。
     */
    qput_u64(pending, "resubmitCount", x_oslab_block_inflight_resubmits());
    qlist_append_str(notes,
                     "台账由 hw/block/virtio-blk.c 的三处真实落点驱动："
                     "virtio_blk_handle_request()（登记）、virtio_blk_rw_complete()"
                     "入口（标 hostIoDone）、virtio_blk_req_complete()（移除）");
    qlist_append_str(notes,
                     "submitSeq/hostDoneSeq 是事件水位线：当对应事件（block.submit）"
                     "确实入了环时 submitSeq 就是它的 seq；采集关闭或该 kind 被记录期"
                     "掩码排除时它们是当时的水位线，0 表示那一刻还没有任何事件");
    qlist_append_str(notes,
                     "溢出数为 0 表示台账完整；非 0 表示有请求没能登记，"
                     "pending 分类不完整");
    qlist_append_str(notes,
                     "resubmitCount 是对已在台账里的请求再次 submit 的次数："
                     "宿主错误动作 stop 之后 VM 恢复时设备会重新提交同一个请求"
                     "对象，同一个 requestId 因此有两条 block.submit、一条 "
                     "block.complete，这是真实行为；重提交会把该条目标回 "
                     "hostIoDone=false 并更新 submitSeq");
    qdict_put(pending, "notes", notes);
    qdict_put(pending, "blockRequests", requests);

    *out_pending = pending;
    *host_done_count = done;
    return count;
}

static void qmp_x_oslab_capture(QDict *args, QObject **ret, Error **errp)
{
    QDict *out;
    QDict *events;
    QDict *pending_io = NULL;
    QList *cpus;
    QList *regions;
    QList *unavailable;
    CPUState *cs;
    char *superseded = NULL;
    uint64_t generation;
    uint64_t fence_seq = 0;
    uint32_t pending_count = 0;
    uint32_t pending_done = 0;
    int vcpus = 0;
    int region_count = 0;
    int readable_count = 0;
    bool all_stopped = true;

    (void)args;
    (void)errp;

    if (!qemu_mutex_iothread_locked()) {
        error_setg(errp,
                   "x-oslab-capture 必须在持有 BQL 的主循环上下文中执行");
        return;
    }

    generation = x_oslab_vm_generation;
    CPU_FOREACH(cs) {
        vcpus++;
        if (!cs->stopped) {
            all_stopped = false;
        }
    }

    if (vcpus == 0 || !all_stopped) {
        QList *running = qlist_new();

        CPU_FOREACH(cs) {
            if (!cs->stopped) {
                qlist_append_int(running, cs->cpu_index);
            }
        }
        out = qdict_new();
        qdict_put_bool(out, "ok", false);
        qdict_put_bool(out, "refused", true);
        qdict_put_str(out, "reason", "vcpu-running");
        qdict_put_str(out, "message",
                      "存在未停止的 vCPU，拒绝冻结快照（停止屏障要求全部 vCPU 停止）");
        qdict_put_int(out, "vcpuCount", vcpus);
        qdict_put(out, "runningCpus", running);
        qdict_put_str(out, "runState", x_oslab_vm_state_name());
        *ret = QOBJECT(out);
        return;
    }

    if (x_oslab_capture_state.active && x_oslab_capture_state.id != NULL) {
        superseded = g_strdup(x_oslab_capture_state.id);
    }

    /*
     * ---------------- 统一串行化点（T05e） ----------------
     *
     * 执行到这里时有两个已经成立的事实：全部 vCPU 已停止（上面的 all_stopped
     * 检查），并且本函数在 main loop 的 QMP BH 里持有 BQL。合起来给出停止屏障
     * 成立的理由：
     *   - 客体不可能再发起新请求（vCPU 都停着，设备寄存器不会被动到）；
     *   - 宿主块层的完成回调不可能插进来（它也要拿 BQL，而 BQL 在采集手里）。
     * 因此「取 pending 台账快照、记录帧分界、读设备状态」这三步之间不存在任何
     * 会改变 pending 集合的事件。
     *
     * 这不是「把未完成的请求做完」：采集全程只读，不做 drain、不推进虚拟时钟、
     * 不清中断，也绝不让某个请求提前完成。
     */
    pending_count = x_oslab_pending_io_json(&pending_io, &pending_done);

    /*
     * 帧分界的顺序是「先记录 fence，再把它的 seq 当水位线」，这样 fence 自己
     * 属于这一帧（seq <= watermark），「seq <= watermark」与「属于这一帧」严格
     * 等价，不需要读取方事后推断。采集关闭或该 kind 被记录期掩码排除时返回 0，
     * 水位线退回当时的真实值。
     */
    fence_seq = x_oslab_event_fence(pending_count);

    cpus = qlist_new();
    CPU_FOREACH(cs) {
        x_oslab_cpu_snapshot(cpus, cs);
    }

    regions = qlist_new();
    x_oslab_collect_regions(regions, &region_count, &readable_count);

    x_oslab_capture_state.serial++;
    g_free(x_oslab_capture_state.id);
    x_oslab_capture_state.id = g_strdup_printf("cap-%" PRIu64 "-%s",
                                              x_oslab_capture_state.serial,
                                              QEMU_VERSION);
    x_oslab_capture_state.active = true;
    x_oslab_capture_state.vmGeneration = generation;
    x_oslab_capture_state.capturedAtNs = g_get_real_time() * 1000;
    x_oslab_capture_state.fenceSeq = fence_seq;
    x_oslab_capture_state.pendingCount = pending_count;
    x_oslab_capture_state.pendingHostDoneCount = pending_done;
    /*
     * 水位线取「采集这一刻」的真实值；此后的事件不属于这份快照。
     * 有 fence 时它恰好是 fence 自己的 seq。
     */
    x_oslab_capture_state.eventWatermark =
        fence_seq != 0 ? fence_seq : x_oslab_event_watermark();

    unavailable = qlist_new();
    qlist_append_str(unavailable, "diskVersions: T06");
    qlist_append_str(unavailable,
                     "pendingIo: 只覆盖 virtio-blk 的读写请求（发过 block.submit "
                     "的那些请求）；非 virtio 块设备与其它设备不进 pending 台账");
#if !X_OSLAB_EVENTS_AVAILABLE
    qlist_append_str(unavailable, "events: 该构建未启用 CONFIG_TCG");
#endif
    if (fence_seq == 0) {
        qlist_append_str(unavailable,
                         "frameBoundary: 本帧没有 capture.fence 标记"
                         "（采集关闭，或该 kind 被记录期掩码排除），"
                         "eventWatermark 退回采集当时的水位线");
    }

    out = qdict_new();
    qdict_put_bool(out, "ok", true);
    qdict_put_str(out, "schema", X_OSLAB_PROTO_SCHEMA);
    qdict_put_str(out, "captureId", x_oslab_capture_state.id);
    qdict_put_str(out, "qemuVersion", QEMU_VERSION);
    qdict_put_str(out, "runState", x_oslab_vm_state_name());
    qdict_put_bool(out, "vmRunning", runstate_is_running());
    qdict_put_bool(out, "allVcpusStopped", true);
    qdict_put_int(out, "vcpuCount", vcpus);

    {
        QDict *ctx = qdict_new();

        qdict_put_str(ctx, "thread", "main-loop");
        qdict_put_bool(ctx, "bqlHeld", true);
        qdict_put_str(ctx, "dispatch",
                      "qmp_dispatch BH (non-OOB, non-coroutine)");
        qdict_put_str(ctx, "note",
                      "vCPU 线程与块层完成回调都要拿 BQL，BQL 内读设备/内存拓扑是"
                      "统一串行化点");
        qdict_put(out, "executionContext", ctx);
    }

    qput_u64(out, "eventWatermark", x_oslab_capture_state.eventWatermark);
    /*
     * T05e：帧分界。fenceSeq 为 0 表示这一帧没有标记（采集关闭或该 kind 被记录期
     * 掩码排除），此时 eventWatermark 是采集当时的水位线，不属于「fence 语义」。
     */
    qput_u64(out, "fenceSeq", fence_seq);
    {
        QDict *frame = qdict_new();

        qdict_put_str(frame, "rule",
                      "seq <= eventWatermark 的事件属于本帧（含这条 capture.fence "
                      "自己），之后的事件属于下一帧");
        qdict_put_bool(frame, "fenceRecorded", fence_seq != 0);
        qput_u64(frame, "fenceSeq", fence_seq);
        qdict_put_int(frame, "pendingBlockRequests", (int64_t)pending_count);
        qdict_put_int(frame, "pendingHostIoDone", (int64_t)pending_done);
        qdict_put_str(frame, "serializationPoint",
                      "全部 vCPU 已停止 + main loop（QMP BH）+ 持有 BQL；"
                      "块层完成回调同样需要 BQL，因此不可能插进采集过程");
        qdict_put_str(frame, "captureDoesNot",
                      "采集不 drain 块层、不推进虚拟时钟、不清中断，也不让任何"
                      "pending 请求提前完成");
        qdict_put(out, "frameBoundary", frame);
    }
    /*
     * T05e：pending I/O 台账快照。它是在同一个串行化点上取的，与 fenceSeq 对应
     * 同一瞬间；count 就是 capture.fence 的 detail.pendingBlockRequests。
     */
    qdict_put(out, "pendingIo", pending_io);
    events = qdict_new();
    x_oslab_events_runtime(events);
    qdict_put(out, "events", events);
    qput_u64(out, "vmGeneration", generation);
    qput_u64(out, "capturedAtNs", (uint64_t)x_oslab_capture_state.capturedAtNs);
    qdict_put(out, "cpus", cpus);
    qdict_put(out, "readableRegions", regions);
    qdict_put_int(out, "regionCount", region_count);
    qdict_put_int(out, "readableRegionCount", readable_count);
    /* T05d：设备面板的无副作用快照，随 capture 一起冻结（验收 E10）。 */
    x_oslab_devices_json(out, unavailable);
    qdict_put(out, "diskVersions", qdict_new());
    if (superseded != NULL) {
        qdict_put_str(out, "supersededCaptureId", superseded);
    } else {
        qdict_put_null(out, "supersededCaptureId");
    }
    qdict_put(out, "unavailable", unavailable);

    g_free(superseded);
    *ret = QOBJECT(out);
}

#define X_OSLAB_REFUSE(out, reason, message)                                   \
    do {                                                                       \
        (out) = qdict_new();                                                   \
        qdict_put_bool((out), "ok", false);                                    \
        qdict_put_bool((out), "rejected", true);                               \
        qdict_put_str((out), "reason", (reason));                              \
        qdict_put_str((out), "message", (message));                            \
    } while (0)

static void qmp_x_oslab_read_physical(QDict *args, QObject **ret, Error **errp)
{
    const char *capture_id = qdict_get_try_str(args, "captureId");
    const MemoryRegion *term;
    const char *kind;
    MemoryRegion *mr;
    MemTxResult result;
    FlatView *fv;
    uint64_t address;
    uint64_t length;
    hwaddr xlat = 0;
    hwaddr plen;
    uint8_t *buf;
    char *encoded;
    QDict *out = NULL;
    QDict *region;

    if (!qemu_mutex_iothread_locked()) {
        error_setg(errp,
                   "x-oslab-read-physical 必须在持有 BQL 的主循环上下文中执行");
        return;
    }
    if (capture_id == NULL || *capture_id == '\0') {
        error_setg(errp, "x-oslab-read-physical 缺少 captureId");
        return;
    }
    if (!x_oslab_arg_u64(args, "address", &address)) {
        error_setg(errp, "x-oslab-read-physical 缺少或非法 address");
        return;
    }
    if (!x_oslab_arg_u64(args, "length", &length)) {
        error_setg(errp, "x-oslab-read-physical 缺少或非法 length");
        return;
    }

#define REFUSE(reason, message)                                                \
    do {                                                                       \
        X_OSLAB_REFUSE(out, reason, message);                                  \
        qdict_put_str(out, "captureId", capture_id);                           \
        qput_hex(out, "address", address);                                     \
        qdict_put_int(out, "length", (int64_t)length);                         \
        goto done;                                                             \
    } while (0)

    if (length == 0 || length > X_OSLAB_MAX_READ_BYTES) {
        REFUSE("invalid-length",
               "length 必须在 1..4096 之间（一次最多一个 4 KiB 页）");
    }
    if (length - 1 > UINT64_MAX - address) {
        REFUSE("out-of-range", "address + length 溢出 64 位物理地址空间");
    }
    if (!x_oslab_capture_state.active || x_oslab_capture_state.id == NULL) {
        REFUSE("no-active-capture",
               "当前没有有效 capture，请先调用 x-oslab-capture");
    }
    if (strcmp(x_oslab_capture_state.id, capture_id) != 0) {
        REFUSE("capture-mismatch",
               "captureId 不是当前有效快照（可能已 release 或被新 capture 取代）");
    }
    if (x_oslab_vm_generation != x_oslab_capture_state.vmGeneration) {
        REFUSE("vm-advanced",
               "VM 在采集之后又推进过（代数已变化），旧快照拒绝读取");
    }
    if (runstate_is_running()) {
        REFUSE("vm-running", "VM 正在运行，物理读取只允许在全部 vCPU 停止后进行");
    }

    /*
     * RCU 守卫必须限制在独立块内。上面的参数与快照校验用 `goto done` 退出，
     * 而 GCC 的 cleanup 属性是按「作用域退出」而不是「是否初始化」触发：
     * 若守卫声明与 done 标签同处一个作用域，被 goto 跳过的声明也会执行
     * rcu_read_unlock()，直接命中 `depth != 0` 断言。放进子块后，只有真正
     * 进入子块的路径才解锁，从子块 `goto done` 退出则正常配对。
     */
    {
        RCU_READ_LOCK_GUARD();

        fv = address_space_to_flatview(&address_space_memory);
        plen = length;
        mr = flatview_translate(fv, (hwaddr)address, &xlat, &plen, false,
                                MEMTXATTRS_UNSPECIFIED);
        term = x_oslab_terminal_mr(mr);
        kind = x_oslab_mr_kind(mr);

        if (!x_oslab_mr_readable(mr)) {
            X_OSLAB_REFUSE(out, "side-effect-risk",
                           "该物理地址属于不可直读区域（MMIO 寄存器 / 未 ROMD 的 "
                           "rom_device / IOMMU / 未分配 / ram_device），读取可能产生"
                           "副作用，已拒绝");
            qdict_put_str(out, "captureId", capture_id);
            qput_hex(out, "address", address);
            qdict_put_int(out, "length", (int64_t)length);
            qdict_put_str(out, "regionKind", kind);
            qdict_put_str(out, "regionName",
                          (term && term->name) ? term->name : "unnamed");
            goto done;
        }
        if (plen < length) {
            REFUSE("cross-region",
                   "读取范围跨越了区域边界（RAM 区域剩余长度不足）；请缩小 length");
        }
        {
            /* 末字节必须落在同一个区域，避免跨进紧邻的 MMIO。 */
            hwaddr plen2 = 1;
            hwaddr xlat2 = 0;
            MemoryRegion *last =
                flatview_translate(fv, (hwaddr)(address + length - 1),
                                   &xlat2, &plen2, false, MEMTXATTRS_UNSPECIFIED);

            if (x_oslab_terminal_mr(last) != term) {
                REFUSE("cross-region", "读取范围的末字节落在另一个区域，已拒绝");
            }
        }

        buf = g_malloc(length);
        result = address_space_read(&address_space_memory, (hwaddr)address,
                                    MEMTXATTRS_UNSPECIFIED, buf, length);
        if (result != MEMTX_OK) {
            g_free(buf);
            REFUSE("memtx-error", "address_space_read 未能完成该物理读取");
        }

        encoded = g_base64_encode(buf, length);
        region = qdict_new();
        qdict_put_str(region, "name",
                      (term && term->name) ? term->name : "unnamed");
        qdict_put_str(region, "kind", kind);
        qput_hex(region, "offsetInRegion", xlat);
        qput_hex(region, "regionSize", (uint64_t)int128_get64(term->size));
        qput_hex(region, "regionBase", (uint64_t)(address - xlat));

        out = qdict_new();
        qdict_put_bool(out, "ok", true);
        qdict_put_str(out, "captureId", capture_id);
        qdict_put_str(out, "addressSpace", "physical");
        qput_hex(out, "address", address);
        qdict_put_int(out, "length", (int64_t)length);
        qdict_put_str(out, "encoding", "base64");
        qdict_put_str(out, "bytes", encoded);
        qdict_put(out, "region", region);
        qput_u64(out, "vmGeneration", x_oslab_capture_state.vmGeneration);

        g_free(encoded);
        g_free(buf);
    }

done:
    *ret = QOBJECT(out);
#undef REFUSE
}

/*
 * x-oslab-events：按 seq 分块读取事件序列，并承担采集开关。
 *
 * 语义要点（都是刻意选择，不是实现偷懒）：
 *   - 读取不要求 VM 停止：事件环由 vCPU 线程写入、自旋锁保护，读到的是一份
 *     「某一时刻已经发生的事件」，不需要停止屏障；
 *   - enable / reset 只允许在 VM 停止时执行：它们改变翻译期发射点，且切换后
 *     必须 tb_flush()，运行中做会静默丢事件或者漏掉已翻译的 TB；
 *   - 默认 from = 当前还能取到的最旧序号（不再谎报「从 1 开始」）；显式给一个
 *     比 oldest 更小的 from 时，用 droppedInRange 显式报告这段区间里已经丢掉的
 *     事件数；dropped 是这份事件流累计丢失数（环满覆盖）；
 *   - truncated 只在「区间内确实还有未返回的匹配事件」时为 true，不是保守猜测；
 *   - 认不出来的 kind 名字进 unknownKinds，不静默当成「全都要」。
 *   - recordKinds（T05c）是**记录期**过滤，与上面读取期的 kinds 分开：不给这个
 *     参数就记录全部 kind（T05b 行为不变），给了就只把列出的 kind 写进事件环，
 *     未列出的 kind 既不入环也不计 dropped。客体高速运行时设备事件很稀疏，
 *     全量记录会被指令事件把环挤爆，所以采集设备事件必须先收窄记录范围。
 */
static void qmp_x_oslab_events(QDict *args, QObject **ret, Error **errp)
{
    const char *capture_id = qdict_get_try_str(args, "captureId");
    XOslabKindFilter filter;
    XOslabKindFilter record_filter;
    XOslabEventRec *buf = NULL;
    QList *events;
    QList *requested = qlist_new();
    QList *unknown = qlist_new();
    QList *record_requested = qlist_new();
    QList *record_unknown = qlist_new();
    QList *record_kinds = qdict_get_qlist(args, "recordKinds");
    QList *unavailable;
    QDict *out;
    bool want_record_mask = record_kinds != NULL;
    uint64_t record_mask = X_OSLAB_RECORD_KIND_ALL;
    bool want_enable = qdict_haskey(args, "enable");
    bool enable_value = qdict_get_try_bool(args, "enable", false);
    bool want_reset = qdict_haskey(args, "reset");
    bool reset_value = qdict_get_try_bool(args, "reset", false);
    bool enabled_changed = false;
    bool reset_done = false;
    const char *refusal;
    uint64_t watermark;
    uint64_t oldest;
    uint64_t from;
    uint64_t to;
    uint64_t limit = X_OSLAB_DEFAULT_EVENT_LIMIT;
    uint64_t dropped_in_range = 0;
    uint64_t cursor;
    uint64_t last_returned = 0;
    uint64_t next_seq;
    uint32_t returned = 0;
    uint32_t scanned = 0;
    uint32_t filtered = 0;
    bool truncated = false;

    if (!qemu_mutex_iothread_locked()) {
        error_setg(errp, "x-oslab-events 必须在持有 BQL 的主循环上下文中执行");
        return;
    }
    if (capture_id != NULL && *capture_id == '\0') {
        capture_id = NULL;
    }

    /*
     * recordKinds 必须在调 x_oslab_events_switch() 之前解析：开关要一次性校验
     * 并应用（enabled 与记录掩码都要求 VM 停止），不能先改一半再报错。
     */
    x_oslab_kind_filter_parse(record_kinds, &record_filter, record_requested,
                              record_unknown);
    if (record_filter.active) {
        int rk;

        record_mask = 0;
        for (rk = 0; rk < X_OSLAB_EVK_MAX; rk++) {
            if (record_filter.selected[rk]) {
                record_mask |= ((uint64_t)1) << rk;
            }
        }
    }

    /* ---------- 1. 采集开关 ---------- */
    refusal = x_oslab_events_switch(want_enable, enable_value, want_reset,
                                    reset_value, want_record_mask, record_mask,
                                    &enabled_changed, &reset_done);
    if (refusal != NULL) {
        out = qdict_new();
        qdict_put_bool(out, "ok", false);
        qdict_put_bool(out, "rejected", true);
        qdict_put_str(out, "reason", refusal);
        qdict_put_str(out, "message", x_oslab_events_switch_message(refusal));
        qdict_put_bool(out, "enabled", x_oslab_event_enabled());
        qdict_put_str(out, "runState", x_oslab_vm_state_name());
        *ret = QOBJECT(out);
        return;
    }

    /* ---------- 2. 可选的 captureId 绑定 ---------- */
    if (capture_id != NULL
        && (!x_oslab_capture_state.active || x_oslab_capture_state.id == NULL
            || strcmp(x_oslab_capture_state.id, capture_id) != 0)) {
        X_OSLAB_REFUSE(out, "capture-mismatch",
                       "captureId 不是当前有效快照；事件无法归因到该 capture，"
                       "请先 x-oslab-capture 或去掉 captureId");
        qdict_put_str(out, "captureId", capture_id);
        *ret = QOBJECT(out);
        return;
    }

    /* ---------- 3. 参数 ---------- */
    watermark = x_oslab_event_watermark();
    oldest = x_oslab_event_oldest();

    if (qdict_haskey(args, "from")) {
        if (!x_oslab_arg_u64(args, "from", &from)) {
            error_setg(errp, "x-oslab-events 的 from 不是合法序号");
            return;
        }
    } else {
        from = oldest != 0 ? oldest : 1;
    }
    if (qdict_haskey(args, "to")) {
        if (!x_oslab_arg_u64(args, "to", &to)) {
            error_setg(errp, "x-oslab-events 的 to 不是合法序号");
            return;
        }
    } else {
        to = watermark;
    }
    if (qdict_haskey(args, "limit")) {
        if (!x_oslab_arg_u64(args, "limit", &limit)) {
            error_setg(errp, "x-oslab-events 的 limit 不是合法整数");
            return;
        }
    }
    if (limit < 1 || limit > X_OSLAB_EVENT_RING_CAPACITY) {
        X_OSLAB_REFUSE(out, "invalid-limit",
                       "limit 必须在 1..65536（环形缓冲容量）之间；"
                       "超出上限时请按返回的 nextSeq 继续分块读");
        qdict_put_int(out, "limit", (int64_t)limit);
        *ret = QOBJECT(out);
        return;
    }

    x_oslab_kind_filter_parse(qdict_get_qlist(args, "kinds"), &filter, requested,
                              unknown);

    /* ---------- 4. 扫描 ---------- */
    events = qlist_new();
    if (to >= from) {
        buf = g_new(XOslabEventRec, X_OSLAB_EVENT_FETCH_BATCH);
        cursor = from;
        while (cursor <= to) {
            uint32_t fetched =
                x_oslab_event_fetch(cursor, to, X_OSLAB_EVENT_FETCH_BATCH, buf);
            uint32_t i;

            if (fetched == 0) {
                break;
            }
            scanned += fetched;
            for (i = 0; i < fetched; i++) {
                const XOslabEventRec *rec = &buf[i];

                if (filter.active
                    && (rec->kind >= X_OSLAB_EVK_MAX
                        || !filter.selected[rec->kind])) {
                    filtered++;
                    continue;
                }
                if (returned >= limit) {
                    /*
                     * 超限的这条不返回，但仍继续扫完区间：这样 truncated 是
                     * 「区间里确实还有未返回的匹配事件」，而不是保守猜测。
                     */
                    truncated = true;
                    continue;
                }
                qlist_append(events, x_oslab_event_json(rec));
                returned++;
                last_returned = rec->seq;
            }
            cursor = buf[fetched - 1].seq + 1;
        }
        g_free(buf);
    }
    /* returned == 0 时 nextSeq 就是 from：调用方可以据此判断「跟不上了」。 */
    next_seq = returned > 0 ? last_returned + 1 : from;

    /*
     * 被环覆盖掉的序号都小于 oldest。只有客户端显式要了这段区间，才说明这批
     * 数据真的丢了，此时给出确切的丢失条数。
     */
    if (oldest > 0 && from < oldest) {
        uint64_t hi = to == UINT64_MAX ? UINT64_MAX : to + 1;

        if (hi > oldest) {
            hi = oldest;
        }
        if (hi > from) {
            dropped_in_range = hi - from;
        }
    }

    out = qdict_new();
    qdict_put_bool(out, "ok", true);
    qdict_put_str(out, "schema", X_OSLAB_PROTO_SCHEMA);
    qdict_put_bool(out, "enabled", x_oslab_event_enabled());
    qdict_put_bool(out, "enabledChanged", enabled_changed);
    qdict_put_bool(out, "reset", reset_done);
    qdict_put_bool(out, "recordAllKinds",
                   x_oslab_event_kind_mask() == X_OSLAB_RECORD_KIND_ALL);
    qput_hex(out, "recordKindMask", x_oslab_event_kind_mask());
    qdict_put(out, "recordKinds", record_requested);
    qdict_put(out, "recordKindsUnknown", record_unknown);
    if (capture_id != NULL) {
        qdict_put_str(out, "captureId", capture_id);
    } else {
        qdict_put_null(out, "captureId");
    }
    qdict_put_int(out, "capacity", (int64_t)x_oslab_event_capacity());
    qput_u64(out, "watermark", watermark);
    qput_u64(out, "oldest", oldest);
    qput_u64(out, "total", x_oslab_event_total());
    qput_u64(out, "dropped", x_oslab_event_dropped());
    qput_u64(out, "droppedInRange", dropped_in_range);
    qput_u64(out, "requestedFrom", from);
    qput_u64(out, "requestedTo", to);
    qdict_put_int(out, "limit", (int64_t)limit);
    qdict_put_int(out, "scanned", scanned);
    qdict_put_int(out, "filtered", filtered);
    qdict_put_int(out, "returned", returned);
    qdict_put_bool(out, "truncated", truncated);
    qput_u64(out, "nextSeq", next_seq);
    qdict_put(out, "kinds", requested);
    qdict_put(out, "unknownKinds", unknown);
    qdict_put(out, "events", events);
    qdict_put_str(out, "runState", x_oslab_vm_state_name());

    unavailable = qlist_new();
    qlist_append_str(unavailable,
                     "devices: 设备快照在 x-oslab-capture 的 devices 字段里，"
                     "本响应不重复携带");
    qlist_append_str(unavailable, "diskVersions: T06");
    qdict_put(out, "unavailable", unavailable);

    *ret = QOBJECT(out);
}

static void qmp_x_oslab_release(QDict *args, QObject **ret, Error **errp)
{
    const char *capture_id = qdict_get_try_str(args, "captureId");
    QDict *out;
    const char *reason = NULL;
    bool released = false;

    if (!qemu_mutex_iothread_locked()) {
        error_setg(errp,
                   "x-oslab-release 必须在持有 BQL 的主循环上下文中执行");
        return;
    }

    if (!x_oslab_capture_state.active || x_oslab_capture_state.id == NULL) {
        reason = "no-active-capture";
    } else if (capture_id != NULL &&
               strcmp(x_oslab_capture_state.id, capture_id) != 0) {
        reason = "capture-mismatch";
    } else {
        released = true;
        g_free(x_oslab_capture_state.id);
        x_oslab_capture_state.id = NULL;
        x_oslab_capture_state.active = false;
    }

    out = qdict_new();
    qdict_put_bool(out, "released", released);
    if (capture_id != NULL) {
        qdict_put_str(out, "captureId", capture_id);
    } else {
        qdict_put_null(out, "captureId");
    }
    if (reason != NULL) {
        qdict_put_str(out, "reason", reason);
    } else {
        qdict_put_null(out, "reason");
    }
    qput_u64(out, "vmGeneration", x_oslab_vm_generation);
    *ret = QOBJECT(out);
}

/* ------------------------------------------------------------------ 注册 */

static void x_oslab_vm_state_change(void *opaque, bool running, RunState state)
{
    (void)opaque;
    (void)state;
    if (running) {
        x_oslab_vm_generation++;
    }
}

void x_oslab_init_commands(QmpCommandList *cmds)
{
    qmp_register_command(cmds, "x-oslab-capabilities",
                         qmp_x_oslab_capabilities, 0, 0);
    qmp_register_command(cmds, "x-oslab-capture",
                         qmp_x_oslab_capture, 0, 0);
    qmp_register_command(cmds, "x-oslab-read-physical",
                         qmp_x_oslab_read_physical, 0, 0);
    qmp_register_command(cmds, "x-oslab-events",
                         qmp_x_oslab_events, 0, 0);
    qmp_register_command(cmds, "x-oslab-release",
                         qmp_x_oslab_release, 0, 0);
    qemu_add_vm_change_state_handler(x_oslab_vm_state_change, NULL);
}
