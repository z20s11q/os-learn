/*
 * accel/tcg/x-oslab-events.c —— x-oslab 事件序列实现（T05b）。
 *
 * 由 instrumentation/qemu-observer/x-oslab-events.c 复制而来；接口见
 * include/exec/x-oslab-events.h 的说明。
 *
 * 结构：
 *   1) 固定容量环形缓冲 + 全局递增 seq + dropped 计数（QemuSpin 保护）；
 *   2) 一个树内 TCG helper helper_x_oslab_event，把「执行期才知道的值」
 *      （访存地址、读写值、实际执行的 PC）记进事件环；
 *   3) TCG 发射器 x_oslab_tcg_*，只在翻译期生成 op，不做实际记录；
 *   4) C 层入口 x_oslab_event_io / x_oslab_event_interrupt，供 target 代码
 *      在真实执行点直接调用。
 *   5) T05c：设备注册表（设备在 realize 时登记名字，事件里只存数字 id）与
 *      x_oslab_event_dma / x_oslab_event_block_submit / _complete 三个入口，
 *      供 hw/virtio/virtio.c 与 hw/block/virtio-blk.c 在真实执行点调用。
 *
 * T05c 的线程上下文（与 T05b 的区别）：
 *   - x_oslab_event_dma 由 virtqueue_pop 的调用者执行：virtio-blk 默认留在主
 *     循环（BQL），virtio-blk-dataplane 时在 iothread；
 *   - x_oslab_event_block_complete 由块层完成回调执行，同样可能是主循环或
 *     iothread；两者都只拿事件环自己的 QemuSpin，不依赖 BQL，也不睡眠。
 *   - 因此 dma.* / block.* 事件不带 CPU 归属，也不归因到某条指令：设备访问
 *     与「当前在跑哪条指令」没有可靠对应关系，硬套一个 pc 就是编造。
 */

#include "qemu/osdep.h"
#include "qemu/atomic.h"
#include "qemu/cutils.h"
#include "qemu/thread.h"
#include "hw/core/cpu.h"
#include "exec/x-oslab-events.h"

#ifdef CONFIG_TCG

/*
 * tcg/tcg-op.h 与 exec/helper-gen.h 只能在「目标环境」里使用：前者要求
 * TARGET_LONG_BITS / target_ulong（由目标的 cpu-param.h / cpu.h 提供），
 * 后者要求目标自己的 helper.h。本文件是 per-target 编译单元
 * （accel/tcg/meson.build 的 tcg_ss 经 specific_ss 逐目标编译），所以这里
 * 包含目标 cpu.h 是必要的，做法与 target/<arch>/tcg/translate.c 一致。
 */
#include "cpu.h"
#include "tcg/tcg.h"
#include "tcg/tcg-temp-internal.h"
#include "tcg/tcg-op.h"
#include "tcg/tcg-op-common.h"
#include "exec/helper-proto-common.h"
#include "exec/helper-gen.h"

/* meta 打包：低位起依次是 kind / size / space / mmuIndex / sign。
 * T05c 把 space 从 2 位扩到 3 位（新增 physical 与 disk-lba），mmuIndex 相应从
 * bit18 挪到 bit19；总宽仍是 32 位。 */
#define X_OSLAB_META_SIZE_SHIFT  8
#define X_OSLAB_META_SPACE_SHIFT 16
#define X_OSLAB_META_MMU_SHIFT   19
#define X_OSLAB_META_SIGN_SHIFT  27

typedef struct XOslabStamp {
    uint64_t seq; /* 当前指令的 instruction.begin seq；0 表示没有 */
    uint64_t pc;
} XOslabStamp;

typedef struct XOslabEventState {
    QemuSpin lock;
    bool enabled;
    uint64_t next_seq; /* 下一条事件的 seq */
    uint64_t dropped;
    uint64_t total;
    /* T05c 记录期 kind 掩码：只有置位的 kind 才入环。 */
    uint64_t record_mask;
    uint32_t head;
    uint32_t count;
    XOslabStamp current[X_OSLAB_MAX_CPUS];
    XOslabEventRec ring[X_OSLAB_EVENT_RING_CAPACITY];
} XOslabEventState;

/*
 * record_mask 显式初始化成全开：静态存储是零初始化的，若让掩码保持 0，就会
 * 变成「一条事件也不记」，而 X_OSLAB_RECORD_KIND_ALL 才是 T05b 的既有行为。
 * 掩码不在 x_oslab_event_reset() 里复位：它描述的是「记什么」而不是「已经记了
 * 什么」，清环不该顺手改掉调用方设好的记录范围。
 */
static XOslabEventState x_oslab_events = {
    .record_mask = X_OSLAB_RECORD_KIND_ALL,
};

static const char *const x_oslab_event_kind_names[X_OSLAB_EVK_MAX] = {
    [X_OSLAB_EVK_INSTRUCTION_BEGIN] = "instruction.begin",
    [X_OSLAB_EVK_INSTRUCTION_RETIRE] = "instruction.retire",
    [X_OSLAB_EVK_MEMORY_READ] = "memory.read",
    [X_OSLAB_EVK_MEMORY_WRITE] = "memory.write",
    [X_OSLAB_EVK_DMA_READ] = "dma.read",
    [X_OSLAB_EVK_DMA_WRITE] = "dma.write",
    [X_OSLAB_EVK_IO_READ] = "io.read",
    [X_OSLAB_EVK_IO_WRITE] = "io.write",
    [X_OSLAB_EVK_IRQ_RAISE] = "irq.raise",
    [X_OSLAB_EVK_IRQ_LOWER] = "irq.lower",
    [X_OSLAB_EVK_INTERRUPT_ACCEPT] = "interrupt.accept",
    [X_OSLAB_EVK_BLOCK_SUBMIT] = "block.submit",
    [X_OSLAB_EVK_BLOCK_COMPLETE] = "block.complete",
    [X_OSLAB_EVK_INPUT_ACCEPT] = "input.accept",
    [X_OSLAB_EVK_SERIAL_OUTPUT] = "serial.output",
    [X_OSLAB_EVK_CAPTURE_FENCE] = "capture.fence",
    [X_OSLAB_EVK_EXCEPTION_RAISE] = "exception.raise",
    [X_OSLAB_EVK_OBSERVER_DROP] = "observer.drop",
};

const char *x_oslab_event_kind_name(uint32_t kind)
{
    if (kind >= X_OSLAB_EVK_MAX) {
        return "unknown";
    }
    return x_oslab_event_kind_names[kind];
}

bool x_oslab_event_enabled(void)
{
    return qatomic_read(&x_oslab_events.enabled);
}

void x_oslab_event_set_enabled(bool enabled)
{
    qatomic_set(&x_oslab_events.enabled, enabled);
}

uint64_t x_oslab_event_kind_mask(void)
{
    return qatomic_read(&x_oslab_events.record_mask);
}

void x_oslab_event_set_kind_mask(uint64_t mask)
{
    qatomic_set(&x_oslab_events.record_mask, mask);
}

uint64_t x_oslab_event_watermark(void)
{
    uint64_t next = qatomic_read(&x_oslab_events.next_seq);

    return next == 0 ? 0 : next - 1;
}

uint64_t x_oslab_event_oldest(void)
{
    XOslabEventState *st = &x_oslab_events;
    uint64_t seq = 0;

    qemu_spin_lock(&st->lock);
    if (st->count > 0) {
        seq = st->ring[st->head].seq;
    }
    qemu_spin_unlock(&st->lock);
    return seq;
}

uint64_t x_oslab_event_dropped(void)
{
    return qatomic_read(&x_oslab_events.dropped);
}

uint64_t x_oslab_event_total(void)
{
    return qatomic_read(&x_oslab_events.total);
}

uint32_t x_oslab_event_capacity(void)
{
    return X_OSLAB_EVENT_RING_CAPACITY;
}

/* -------------------------------------------------- 设备注册表（T05c） */

/*
 * 写入发生在设备 realize/unrealize（BQL 下的主循环），读取发生在事件序列化
 * （BQL）与设备记录点（主循环或 iothread）。名字在注册期间不变，只有 unregister
 * 会清掉，所以按 id 取名字的读取方拿到的指针在设备注销前都有效。
 * id 从 1 开始，0 保留给「没有设备归属」。用独立自旋锁，不与事件环的锁嵌套。
 */
#define X_OSLAB_MAX_DEVICES 16
#define X_OSLAB_DEVICE_NAME_MAX 64

typedef struct XOslabDeviceEntry {
    bool used;
    char name[X_OSLAB_DEVICE_NAME_MAX];
} XOslabDeviceEntry;

static struct {
    QemuSpin lock;
    XOslabDeviceEntry entry[X_OSLAB_MAX_DEVICES];
} x_oslab_devices;

uint32_t x_oslab_device_register(const char *name)
{
    uint32_t index;
    uint32_t id = 0;

    if (name == NULL || name[0] == '\0') {
        return 0;
    }

    qemu_spin_lock(&x_oslab_devices.lock);
    for (index = 0; index < X_OSLAB_MAX_DEVICES; index++) {
        if (x_oslab_devices.entry[index].used
            && strcmp(x_oslab_devices.entry[index].name, name) == 0) {
            /* 同名重复注册（设备被重新 realize）复用原 id，不占新槽位 */
            id = index + 1;
            break;
        }
    }
    if (id == 0) {
        for (index = 0; index < X_OSLAB_MAX_DEVICES; index++) {
            if (!x_oslab_devices.entry[index].used) {
                x_oslab_devices.entry[index].used = true;
                pstrcpy(x_oslab_devices.entry[index].name,
                        sizeof(x_oslab_devices.entry[index].name), name);
                id = index + 1;
                break;
            }
        }
    }
    qemu_spin_unlock(&x_oslab_devices.lock);
    return id;
}

void x_oslab_device_unregister(uint32_t id)
{
    if (id == 0 || id > X_OSLAB_MAX_DEVICES) {
        return;
    }
    qemu_spin_lock(&x_oslab_devices.lock);
    memset(&x_oslab_devices.entry[id - 1], 0,
           sizeof(x_oslab_devices.entry[id - 1]));
    qemu_spin_unlock(&x_oslab_devices.lock);
}

const char *x_oslab_device_name(uint32_t id)
{
    const char *name = NULL;

    if (id == 0 || id > X_OSLAB_MAX_DEVICES) {
        return NULL;
    }
    qemu_spin_lock(&x_oslab_devices.lock);
    if (x_oslab_devices.entry[id - 1].used) {
        name = x_oslab_devices.entry[id - 1].name;
    }
    qemu_spin_unlock(&x_oslab_devices.lock);
    return name;
}

uint32_t x_oslab_device_count(void)
{
    uint32_t index, count = 0;

    qemu_spin_lock(&x_oslab_devices.lock);
    for (index = 0; index < X_OSLAB_MAX_DEVICES; index++) {
        if (x_oslab_devices.entry[index].used) {
            count++;
        }
    }
    qemu_spin_unlock(&x_oslab_devices.lock);
    return count;
}

const char *x_oslab_device_name_at(uint32_t index)
{
    uint32_t slot, seen = 0;
    const char *name = NULL;

    qemu_spin_lock(&x_oslab_devices.lock);
    for (slot = 0; slot < X_OSLAB_MAX_DEVICES; slot++) {
        if (!x_oslab_devices.entry[slot].used) {
            continue;
        }
        if (seen == index) {
            name = x_oslab_devices.entry[slot].name;
            break;
        }
        seen++;
    }
    qemu_spin_unlock(&x_oslab_devices.lock);
    return name;
}

void x_oslab_event_reset(void)
{
    XOslabEventState *st = &x_oslab_events;

    qemu_spin_lock(&st->lock);
    st->head = 0;
    st->count = 0;
    st->next_seq = 1;
    st->dropped = 0;
    st->total = 0;
    memset(st->current, 0, sizeof(st->current));
    memset(st->ring, 0, sizeof(st->ring));
    qemu_spin_unlock(&st->lock);
}

uint32_t x_oslab_event_fetch(uint64_t from, uint64_t to, uint32_t limit,
                             XOslabEventRec *out)
{
    XOslabEventState *st = &x_oslab_events;
    uint32_t index;
    uint32_t written = 0;

    if (limit == 0 || out == NULL) {
        return 0;
    }

    qemu_spin_lock(&st->lock);
    for (index = 0; index < st->count && written < limit; index++) {
        const XOslabEventRec *rec =
            &st->ring[(st->head + index) % X_OSLAB_EVENT_RING_CAPACITY];

        if (rec->seq < from) {
            continue;
        }
        if (rec->seq > to) {
            break;
        }
        out[written++] = *rec;
    }
    qemu_spin_unlock(&st->lock);
    return written;
}

/*
 * cpu_index 取 current_cpu：TB 会在多个 vCPU 之间共享，因此 CPU 归属只能在
 * 运行期判定，不能在翻译期写成常量。
 */
static uint32_t x_oslab_current_cpu_index(void)
{
    CPUState *cpu = current_cpu;

    if (cpu == NULL || cpu->cpu_index < 0 ||
        cpu->cpu_index >= X_OSLAB_MAX_CPUS) {
        return X_OSLAB_CPU_NONE;
    }
    return (uint32_t)cpu->cpu_index;
}

/*
 * T05c：设备归属与请求关联字段。T05b 的事件没有设备/请求概念，一律传 NULL
 * （全部字段保持 0），不把「没有」写成别的值。
 */
typedef struct XOslabRecordScope {
    uint32_t deviceId;
    uint64_t requestId;
    uint32_t reqType;
    uint32_t descHead;
    uint32_t segOut;
    uint32_t segIn;
} XOslabRecordScope;

static uint64_t x_oslab_record(uint32_t kind, uint32_t cpu_index, uint64_t pc,
                               uint64_t address, uint64_t value, uint64_t aux,
                               uint32_t size, uint32_t space, uint32_t flags,
                               uint32_t mmu_index, bool owner_by_insn,
                               const XOslabRecordScope *scope)
{
    XOslabEventState *st = &x_oslab_events;
    XOslabEventRec rec;

    if (!qatomic_read(&st->enabled)) {
        if (kind == X_OSLAB_EVK_OBSERVER_DROP) {
            qatomic_inc(&st->dropped);
        }
        return 0;
    }

    /*
     * T05c 记录期 kind 掩码。掩码外的 kind 到此为止：不占 seq、不入环、也不计入
     * dropped —— dropped 的语义是「环满被覆盖」，被记录范围主动排除的事件不是
     * 丢失，混进去会让「是不是跟不上了」这个判断失真。也正因为被过滤的 kind 不
     * 占 seq，事件环里的 seq 仍是连续区间，读取期的 droppedInRange（区间内被覆
     * 盖的条数）算法不需要改。
     *
     * 越界的 kind 一律不记（helper 解码出的 kind 只保证 8 位宽）。
     */
    if (kind >= X_OSLAB_EVK_MAX
        || !(qatomic_read(&st->record_mask) & (((uint64_t)1) << kind))) {
        return 0;
    }

    memset(&rec, 0, sizeof(rec));
    rec.kind = kind;
    rec.pc = pc;
    rec.address = address;
    rec.value = value;
    rec.aux = aux;
    rec.size = size;
    rec.space = space;
    rec.flags = flags;
    rec.mmuIndex = mmu_index;
    rec.cpuIndex = cpu_index;
    if (scope != NULL) {
        rec.deviceId = scope->deviceId;
        rec.requestId = scope->requestId;
        rec.reqType = scope->reqType;
        rec.descHead = scope->descHead;
        rec.segOut = scope->segOut;
        rec.segIn = scope->segIn;
    }

    qemu_spin_lock(&st->lock);
    /* seq 从 1 开始，0 专门留给「没有归属指令」的哨兵值。 */
    if (st->next_seq == 0) {
        st->next_seq = 1;
    }
    rec.seq = st->next_seq++;
    if (owner_by_insn) {
        if (cpu_index < X_OSLAB_MAX_CPUS) {
            rec.insnSeq = st->current[cpu_index].seq;
            if (rec.pc == X_OSLAB_NO_PC) {
                rec.pc = st->current[cpu_index].pc;
            }
        } else {
            /* 没有可归属的指令时明确标注，不用 0 冒充 */
            rec.flags |= X_OSLAB_EVF_NO_OWNER;
        }
    }
    if (st->count == X_OSLAB_EVENT_RING_CAPACITY) {
        st->head = (st->head + 1) % X_OSLAB_EVENT_RING_CAPACITY;
        st->count--;
        st->dropped++;
    }
    st->ring[(st->head + st->count) % X_OSLAB_EVENT_RING_CAPACITY] = rec;
    st->count++;
    st->total++;
    if (kind == X_OSLAB_EVK_INSTRUCTION_BEGIN && cpu_index < X_OSLAB_MAX_CPUS) {
        st->current[cpu_index].seq = rec.seq;
        st->current[cpu_index].pc = pc;
    }
    qemu_spin_unlock(&st->lock);
    return rec.seq;
}

/* ------------------------------------------------------- TCG helper（运行期） */

/*
 * 把寄存器里的值归一化成「该地址上实际访问的 size 个字节」。
 *
 * 访存指令把读到的字节做零扩展或符号扩展后写进目标寄存器，写入的值也可能
 * 比 size 宽（只会写低 size 字节）。事件里的 value 统一取低 size 个字节，
 * 按无符号小端解释，于是它可以直接跟 HMP `xp /x1|/x2|/x4 <addr>` 的输出
 * 对照，也不需要读者先还原扩展规则。符号扩展信息由 flags.SIGN 单独表达。
 */
static uint64_t x_oslab_mask_value(uint64_t value, uint32_t size)
{
    if (size == 0 || size >= 8) {
        return value;
    }
    return value & ((((uint64_t)1) << (size * 8)) - 1);
}

/*
 * 唯一的树内 helper。参数含义按 kind 区分：
 *   instruction.begin / retire : a = 线性 PC，b = 0，size = 指令长度（retire）
 *   memory.read / memory.write  : a = 线性地址，b = 读到的值/写入的值
 * meta 打包 kind/size/space/mmuIndex/sign，都是翻译期常量。
 *
 * TCG_CALL_NO_WG：不改 env，不改 TCG 全局；事件环是观察扩展自己的状态。
 */
void HELPER(x_oslab_event)(uint64_t a, uint64_t b, uint32_t meta)
{
    uint32_t kind = meta & 0xffu;
    uint32_t size = (meta >> X_OSLAB_META_SIZE_SHIFT) & 0xffu;
    uint32_t space = (meta >> X_OSLAB_META_SPACE_SHIFT) & 0x7u;
    uint32_t mmu_index = (meta >> X_OSLAB_META_MMU_SHIFT) & 0xffu;
    uint32_t flags = 0;
    uint32_t cpu_index = x_oslab_current_cpu_index();

    if ((meta >> X_OSLAB_META_SIGN_SHIFT) & 1u) {
        flags |= X_OSLAB_EVF_SIGN;
    }

    switch (kind) {
    case X_OSLAB_EVK_INSTRUCTION_BEGIN:
        x_oslab_record(kind, cpu_index, a, X_OSLAB_NO_ADDR, 0, 0, 0,
                       X_OSLAB_SPACE_NONE, 0, X_OSLAB_MMU_NONE, false, NULL);
        break;
    case X_OSLAB_EVK_INSTRUCTION_RETIRE:
        /* 归属指令就是刚发射 begin 的那条（retire 由同一条指令的翻译代码发出） */
        x_oslab_record(kind, cpu_index, a, X_OSLAB_NO_ADDR, 0, 0, size,
                       X_OSLAB_SPACE_NONE, 0, X_OSLAB_MMU_NONE, true, NULL);
        break;
    case X_OSLAB_EVK_MEMORY_READ:
    case X_OSLAB_EVK_MEMORY_WRITE:
        x_oslab_record(kind, cpu_index, X_OSLAB_NO_PC, a,
                       x_oslab_mask_value(b, size), 0, size, space, flags,
                       mmu_index, true, NULL);
        break;
    default:
        /* 未实现的事件类型不产生事件，也不谎报成别的事件 */
        break;
    }
}

/* ------------------------------------------------------------- C 层记录入口 */

void x_oslab_event_io(bool is_read, uint32_t port, uint64_t value, uint32_t size)
{
    uint32_t kind = is_read ? X_OSLAB_EVK_IO_READ : X_OSLAB_EVK_IO_WRITE;

    /*
     * 客体 in/out 指令的端口访问。io.read 在读取完成之后记录，因此 value
     * 就是设备实际返回的数据；即使设备侧有副作用，事件描述的情况与执行一致。
     *
     * 写入值要按访问宽度取低 size 字节：x86 的 out 在翻译期只做
     * gen_op_mov_v_reg(ot, T1, R_EAX) + trunc，传给 helper_outb 的 data
     * 仍然带着寄存器高位（实测 out dx,al 在 EAX=0x1337 时 data==0x1337），
     * 设备侧只写低字节。事件必须报「设备实际收到的那个字节」，才能与
     * HMP 'o' 以及串口原始字节逐字节对照，所以这里与内存路径同样掩码。
     */
    x_oslab_record(kind, x_oslab_current_cpu_index(), X_OSLAB_NO_PC, port,
                   x_oslab_mask_value(value, size), 0, size,
                   X_OSLAB_SPACE_IO_PORT, 0, X_OSLAB_MMU_NONE, true, NULL);
}

void x_oslab_event_interrupt(uint32_t intno, uint32_t error_code,
                             uint64_t next_eip, bool is_int, bool is_hw)
{
    uint32_t flags = 0;
    uint32_t kind;

    if (is_int) {
        flags |= X_OSLAB_EVF_IS_INT;
    }
    if (is_hw) {
        flags |= X_OSLAB_EVF_IS_HW;
    }

    /*
     * 分类依据「CPU 是怎么到达处理程序的」，不依据操作码：
     *   is_hw        : 接受了异步硬件中断（IRQ/NMI）→ interrupt.accept
     *   is_int       : 客体执行 INT n / INT3 / INTO 请求软件中断
     *                  → interrupt.accept，并用 flags.IS_INT 区分来源
     *   is_hw=is_int=0: 同步异常（#UD/#GP/#PF/#MC…）→ exception.raise
     * intno/error_code 原样上报，不做重编号。
     */
    kind = (is_hw || is_int) ? X_OSLAB_EVK_INTERRUPT_ACCEPT
                             : X_OSLAB_EVK_EXCEPTION_RAISE;

    /*
     * 硬件中断由 CPU 在指令边界接受，没有一个「正在执行的出错指令」，因此
     * 不归因到当前 instruction；异常与软件中断都是同步的，归因到触发它的
     * 那条指令，并把该指令的线性地址作为 pc。
     */
    x_oslab_record(kind, x_oslab_current_cpu_index(), X_OSLAB_NO_PC, intno,
                   error_code, next_eip, 0, X_OSLAB_SPACE_NONE, flags,
                   X_OSLAB_MMU_NONE, !is_hw, NULL);
}

/* ------------------------------------- T05c：virtio / 块请求记录入口 */

void x_oslab_event_dma(bool is_write, uint32_t device_id, uint64_t request_id,
                       uint64_t gpa, uint32_t len)
{
    XOslabRecordScope scope = { 0 };

    scope.deviceId = device_id;
    scope.requestId = request_id;

    /*
     * 设备访问发生在 vCPU 之外（主循环或 iothread），current_cpu 可能是 NULL
     * 或者恰好停着的另一个 vCPU。dma.* 既不归因到指令，也不带 CPU 归属。
     * size 报的是这次映射的长度；不在这里读内容，载荷由读取方独立核对。
     */
    x_oslab_record(is_write ? X_OSLAB_EVK_DMA_WRITE : X_OSLAB_EVK_DMA_READ,
                   X_OSLAB_CPU_NONE, X_OSLAB_NO_PC, gpa, 0, 0, len,
                   X_OSLAB_SPACE_PHYSICAL, 0, X_OSLAB_MMU_NONE, false, &scope);
}

static void x_oslab_fill_block_scope(XOslabRecordScope *scope, uint32_t device_id,
                                     uint64_t request_id,
                                     const XOslabBlockInfo *info)
{
    memset(scope, 0, sizeof(*scope));
    scope->deviceId = device_id;
    scope->requestId = request_id;
    scope->reqType = info->reqType;
    scope->descHead = (uint32_t)(request_id & 0xffffffffu);
    scope->segOut = info->outSeg;
    scope->segIn = info->inSeg;
}

void x_oslab_event_block_submit(uint32_t device_id, uint64_t request_id,
                                const XOslabBlockInfo *info)
{
    XOslabRecordScope scope;

    if (info == NULL) {
        return;
    }
    x_oslab_fill_block_scope(&scope, device_id, request_id, info);
    /*
     * address 用 guest 给的起始扇区号（512 字节单位），size 用数据长度。
     * 提交事件不带 payload：此刻设备只拿到了访问权，数据还没有搬。
     */
    x_oslab_record(X_OSLAB_EVK_BLOCK_SUBMIT, X_OSLAB_CPU_NONE, X_OSLAB_NO_PC,
                   info->lba, 0, 0, info->length, X_OSLAB_SPACE_DISK_LBA, 0,
                   X_OSLAB_MMU_NONE, false, &scope);
}

void x_oslab_event_block_complete(uint32_t device_id, uint64_t request_id,
                                  uint32_t status, const XOslabBlockInfo *info)
{
    XOslabRecordScope scope;

    if (info == NULL) {
        return;
    }
    x_oslab_fill_block_scope(&scope, device_id, request_id, info);
    /* value 是设备实际准备回写到客体的状态字节（VIRTIO_BLK_S_OK 等）。 */
    x_oslab_record(X_OSLAB_EVK_BLOCK_COMPLETE, X_OSLAB_CPU_NONE, X_OSLAB_NO_PC,
                   info->lba, status, 0, info->length, X_OSLAB_SPACE_DISK_LBA, 0,
                   X_OSLAB_MMU_NONE, false, &scope);
}

/* ------------------------------------- T05e：pending I/O 台账与帧分界 */

/*
 * 台账容量。
 *
 * virtio-blk 的 virtqueue 深度实测 256（T05d 的队列快照 size），一个队列最多
 * 同时挂 256 个描述符链；给两倍余量，避免「设备还没完成、台账已经满」。
 * 静态数组，不做动态分配：登记与移除都在设备生命周期内发生。
 */
#define X_OSLAB_INFLIGHT_CAPACITY 512

typedef struct XOslabInflightState {
    /*
     * 用 QemuSpin 而不是「反正有 BQL」：登记发生在设备处理请求的路径上
     * （virtqueue 通知后的 virtio-blk BH / vCPU 线程），移除发生在块层完成
     * 回调里，两者当前都拿 BQL，但本模块刻意不依赖这个前提 —— 与事件环同一
     * 策略，只用一把不睡眠的自旋锁。这样即便将来把设备挪到 iothread，也不会
     * 静默退化成数据竞争。
     */
    QemuSpin lock;
    uint32_t count;
    uint64_t overflow;
    uint64_t resubmits;
    XOslabBlockInflight entries[X_OSLAB_INFLIGHT_CAPACITY];
} XOslabInflightState;

static XOslabInflightState x_oslab_inflight;

static int x_oslab_inflight_find(uint32_t device_id, uint64_t request_id)
{
    uint32_t i;

    for (i = 0; i < x_oslab_inflight.count; i++) {
        if (x_oslab_inflight.entries[i].deviceId == device_id
            && x_oslab_inflight.entries[i].requestId == request_id) {
            return (int)i;
        }
    }
    return -1;
}

/*
 * 移除 idx：把后面的元素整体前移，保持数组紧凑。
 *
 * 这样快照天然按登记顺序（即 submit 顺序）返回，不需要额外的序号字段或排序，
 * 也保证「台账里的条数」直接就是 pending 条数。代价是一次有界 memmove
 * （上限 512 条 × 48 字节 ≈ 24 KiB；实测同时挂着的请求数是个位数）。持有自旋
 * 锁的时间因此有上界，且全程不睡眠。
 */
static void x_oslab_inflight_remove_at(uint32_t idx)
{
    uint32_t tail = x_oslab_inflight.count - idx - 1;

    if (tail > 0) {
        memmove(&x_oslab_inflight.entries[idx],
                &x_oslab_inflight.entries[idx + 1],
                (size_t)tail * sizeof(x_oslab_inflight.entries[0]));
    }
    x_oslab_inflight.count--;
    memset(&x_oslab_inflight.entries[x_oslab_inflight.count], 0,
           sizeof(x_oslab_inflight.entries[0]));
}

void x_oslab_block_inflight_submit(uint32_t device_id, uint64_t request_id,
                                   const XOslabBlockInfo *info)
{
    XOslabBlockInflight *e;

    if (device_id == 0 || info == NULL) {
        return;
    }

    qemu_spin_lock(&x_oslab_inflight.lock);

    if (x_oslab_inflight_find(device_id, request_id) >= 0) {
        /*
         * 同一 requestId 再次登记：宿主错误动作 stop（werror/rerror=stop）把请求
         * 挂到 s->rq 上且本次不完成，VM 恢复时 virtio_blk_dma_restart_bh() 会重新
         * 提交同一个请求对象，于是这里被调用第二次。
         *
         * 不能只返回：上一回合的 hostIoDone 是那个回合的事实，这一回合的宿主 I/O
         * 才刚提交、还没完成。把条目按新提交刷新一遍（含 submitSeq），并把这次
         * 重复登记计入 resubmits —— 「block.submit 出现两次」因此有据可查，读取方
         * 不会把它当成漏报。台账条数不增加，仍然等于真实 pending 数。
         */
        e = &x_oslab_inflight.entries[x_oslab_inflight_find(device_id,
                                                            request_id)];
        e->lba = info->lba;
        e->length = info->length;
        e->reqType = info->reqType;
        e->outSeg = info->outSeg;
        e->inSeg = info->inSeg;
        e->hostIoDone = false;
        e->hostDoneSeq = 0;
        e->submitSeq = x_oslab_event_watermark();
        x_oslab_inflight.resubmits++;
        qemu_spin_unlock(&x_oslab_inflight.lock);
        return;
    }
    if (x_oslab_inflight.count == X_OSLAB_INFLIGHT_CAPACITY) {
        /* 台账满：如实累加溢出数，让读取方知道 pending 分类不完整。 */
        x_oslab_inflight.overflow++;
        qemu_spin_unlock(&x_oslab_inflight.lock);
        return;
    }

    e = &x_oslab_inflight.entries[x_oslab_inflight.count++];
    memset(e, 0, sizeof(*e));
    e->requestId = request_id;
    e->lba = info->lba;
    e->length = info->length;
    e->reqType = info->reqType;
    e->deviceId = device_id;
    e->outSeg = info->outSeg;
    e->inSeg = info->inSeg;
    e->hostIoDone = false;
    e->hostDoneSeq = 0;
    /*
     * 登记时的水位线。调用点紧跟在 block.submit 记录之后，因此当 block.submit
     * 确实入了环时，它就是那条事件的 seq；采集关闭或该 kind 被记录掩码排除时，
     * 它是当时的水位线，读取方据此判断这条 pending 有没有对应的事件。
     * hostDoneSeq 保持 0 直到宿主完成回调真的进入。
     */
    e->submitSeq = x_oslab_event_watermark();
    e->hostDoneSeq = 0;

    qemu_spin_unlock(&x_oslab_inflight.lock);
}

void x_oslab_block_inflight_host_done(uint32_t device_id, uint64_t request_id)
{
    int idx;

    qemu_spin_lock(&x_oslab_inflight.lock);
    idx = x_oslab_inflight_find(device_id, request_id);
    if (idx >= 0) {
        x_oslab_inflight.entries[idx].hostIoDone = true;
        x_oslab_inflight.entries[idx].hostDoneSeq = x_oslab_event_watermark();
    }
    /* 找不到就什么都不做：说明请求已经被移除（状态字节早已回写），
     * 这正是 hostI/O 完成回调晚于可见性撤除的结果，不是错误。 */
    qemu_spin_unlock(&x_oslab_inflight.lock);
}

void x_oslab_block_inflight_visible(uint32_t device_id, uint64_t request_id)
{
    int idx;

    qemu_spin_lock(&x_oslab_inflight.lock);
    idx = x_oslab_inflight_find(device_id, request_id);
    if (idx >= 0) {
        x_oslab_inflight_remove_at((uint32_t)idx);
    }
    qemu_spin_unlock(&x_oslab_inflight.lock);
}

void x_oslab_block_inflight_clear_device(uint32_t device_id)
{
    uint32_t i = 0;

    if (device_id == 0) {
        return;
    }

    qemu_spin_lock(&x_oslab_inflight.lock);
    while (i < x_oslab_inflight.count) {
        if (x_oslab_inflight.entries[i].deviceId == device_id) {
            x_oslab_inflight_remove_at(i);
        } else {
            i++;
        }
    }
    qemu_spin_unlock(&x_oslab_inflight.lock);
}

uint32_t x_oslab_block_inflight_count(void)
{
    return qatomic_read(&x_oslab_inflight.count);
}

uint32_t x_oslab_block_inflight_host_done_count(void)
{
    uint32_t i;
    uint32_t n = 0;

    qemu_spin_lock(&x_oslab_inflight.lock);
    for (i = 0; i < x_oslab_inflight.count; i++) {
        if (x_oslab_inflight.entries[i].hostIoDone) {
            n++;
        }
    }
    qemu_spin_unlock(&x_oslab_inflight.lock);
    return n;
}

uint32_t x_oslab_block_inflight_snapshot(XOslabBlockInflight *out, uint32_t max)
{
    uint32_t n;

    if (out == NULL || max == 0) {
        return 0;
    }

    qemu_spin_lock(&x_oslab_inflight.lock);
    n = x_oslab_inflight.count < max ? x_oslab_inflight.count : max;
    if (n > 0) {
        memcpy(out, x_oslab_inflight.entries, (size_t)n * sizeof(out[0]));
    }
    qemu_spin_unlock(&x_oslab_inflight.lock);
    return n;
}

uint32_t x_oslab_block_inflight_capacity(void)
{
    return X_OSLAB_INFLIGHT_CAPACITY;
}

uint64_t x_oslab_block_inflight_overflow(void)
{
    return qatomic_read(&x_oslab_inflight.overflow);
}

uint64_t x_oslab_block_inflight_resubmits(void)
{
    return qatomic_read(&x_oslab_inflight.resubmits);
}

uint64_t x_oslab_event_fence(uint32_t pending_requests)
{
    /*
     * capture.fence 是帧分界，不是访存：address 留 X_OSLAB_NO_ADDR，
     * size/space/mmu 都不适用；value 报「记录这一刻 pending 的块请求数」，
     * 让分界自己带上「采集时还有多少请求没对客体可见」这条事实。
     * 返回 fence 的 seq，调用方用它当这一帧的 eventWatermark，于是
     * 「seq <= fence」与「属于这一帧」是同一件事。
     */
    return x_oslab_record(X_OSLAB_EVK_CAPTURE_FENCE, X_OSLAB_CPU_NONE,
                          X_OSLAB_NO_PC, X_OSLAB_NO_ADDR, pending_requests, 0, 0,
                          X_OSLAB_SPACE_NONE, 0, X_OSLAB_MMU_NONE, false, NULL);
}

/* --------------------------------------------------------- TCG 发射器（翻译期） */

static inline uint32_t x_oslab_meta(uint32_t kind, uint32_t size, uint32_t space,
                                    uint32_t mmu_index, bool sign)
{
    return (kind & 0xffu) | ((size & 0xffu) << X_OSLAB_META_SIZE_SHIFT) |
           ((space & 0x7u) << X_OSLAB_META_SPACE_SHIFT) |
           ((mmu_index & 0xffu) << X_OSLAB_META_MMU_SHIFT) |
           (sign ? (1u << X_OSLAB_META_SIGN_SHIFT) : 0u);
}

void x_oslab_tcg_insn_begin(uint64_t pc)
{
    if (!x_oslab_events.enabled) {
        return;
    }
    gen_helper_x_oslab_event(
        tcg_constant_i64((int64_t)pc), tcg_constant_i64(0),
        tcg_constant_i32(x_oslab_meta(X_OSLAB_EVK_INSTRUCTION_BEGIN, 0,
                                      X_OSLAB_SPACE_NONE, X_OSLAB_MMU_NONE,
                                      false)));
}

void x_oslab_tcg_insn_retire(uint64_t pc, uint32_t length)
{
    if (!x_oslab_events.enabled) {
        return;
    }
    gen_helper_x_oslab_event(
        tcg_constant_i64((int64_t)pc), tcg_constant_i64(0),
        tcg_constant_i32(x_oslab_meta(X_OSLAB_EVK_INSTRUCTION_RETIRE,
                                      length > 0xff ? 0xff : length,
                                      X_OSLAB_SPACE_NONE, X_OSLAB_MMU_NONE,
                                      false)));
}

TCGv_i64 x_oslab_tcg_preserve_addr(TCGTemp *addr)
{
    TCGv_i64 copy;

    if (!x_oslab_events.enabled) {
        return NULL;
    }

    copy = tcg_temp_ebb_new_i64();
    if (tcg_ctx->addr_type == TCG_TYPE_I32) {
        tcg_gen_extu_i32_i64(copy, temp_tcgv_i32(addr));
    } else {
        tcg_gen_mov_i64(copy, temp_tcgv_i64(addr));
    }
    return copy;
}

void x_oslab_tcg_mem(TCGv_i64 preserved_addr, TCGTemp *value, bool value_is_64,
                     bool is_write, uint32_t size, uint32_t mmu_index, bool sign)
{
    TCGv_i64 v64;
    uint32_t meta;

    if (!x_oslab_events.enabled) {
        return;
    }

    meta = x_oslab_meta(is_write ? X_OSLAB_EVK_MEMORY_WRITE
                                 : X_OSLAB_EVK_MEMORY_READ,
                        size, X_OSLAB_SPACE_LINEAR, mmu_index, sign);

    /*
     * 值统一零扩展到 64 位：事件里给的是「实际访问的那 size 个字节」，
     * 带符号扩展的寄存器值会误导读者，符号信息放在 flags 里。
     */
    v64 = tcg_temp_ebb_new_i64();
    if (value_is_64) {
        tcg_gen_mov_i64(v64, temp_tcgv_i64(value));
    } else {
        tcg_gen_extu_i32_i64(v64, temp_tcgv_i32(value));
    }

    /*
     * 地址副本由调用方在真正的 ld/st op 之前创建（见 x-oslab-events.h）。
     * 没有副本时（例如地址类型判断异常）用 0 占位并在事件里由调用方解释，
     * 不静默丢掉整条事件。
     */
    gen_helper_x_oslab_event(preserved_addr != NULL ? preserved_addr
                                                   : tcg_constant_i64(0),
                             v64, tcg_constant_i32(meta));

    tcg_temp_free_i64(v64);
    if (preserved_addr != NULL) {
        tcg_temp_free_i64(preserved_addr);
    }
}

#endif /* CONFIG_TCG */