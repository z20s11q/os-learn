/*
 * x-oslab-devices.h —— T05d 设备无副作用快照的私有状态访问接口。
 *
 * 为什么只需要这一个补丁
 * ---------------------------------------------------------------------------
 * 多数设备的状态结构体本身就在 include/ 下，观察层（monitor/x-oslab-observer.c）
 * 只要 include 对应头文件就能直接读字段，不需要任何新接口：
 *
 *   UART      include/hw/char/serial.h         SerialState（含 recv_fifo/xmit_fifo）
 *   i8042     include/hw/input/i8042.h         ISAKBDState.kbd（KBDState）；
 *                                              内嵌 PS2KbdState/PS2MouseState
 *   PIC       include/hw/isa/i8259_internal.h  PICCommonState
 *   PIT       include/hw/timer/i8254_internal.h PITCommonState
 *   APIC      include/hw/i386/apic_internal.h  APICCommonState
 *   virtio    include/hw/virtio/virtio.h       VirtIODevice 的 status/features 与
 *                                              队列地址（公开访问器）
 *
 * 另外 QEMU 自己已经提供了 virtqueue 状态的完整查询接口，观察层直接复用即可，
 * 不为形式重复改 QEMU：
 *
 *   x-query-virtio            VirtioStatus（device_id/features/num_vqs/status/isr…）
 *   x-query-virtio-status      单设备的 status/isr/queue_sel
 *   x-query-virtio-queue-status 单队列的 queue_index/inuse/vring_num/vring_align/
 *                              vring_desc/avail/used/last_avail_idx/
 *                              shadow_avail_idx/used_idx/signalled_used/
 *                              signalled_used_valid（实现见 hw/virtio/virtio-qmp.c，
 *                              与 monitor/ 编译进同一个二进制）
 *
 * 描述符表内容属 guest 内存，宿主用 x-oslab-read-physical 按 desc_addr 独立读取。
 *
 * 只有一类状态的结构体是设备自己的 .c 文件私有的，观察层拿不到：
 *
 *   VGA    VGACommonState 定义在 hw/display/vga_int.h（hw/display 私有头），
 *          而且它被内嵌在 PCIVGAState 等设备结构体里（hw/display/vga-pci.c），
 *          QOM 对象上没有任何公开属性可以反查。观察层却必须读到 CRTC 寄存器、
 *          start_addr、显存指针才能给出「VGA 字符/属性、光标」。
 *
 * 所以按总体方案 6.1「先验证已有钩子，缺什么补什么」，只给 VGA 补最小的只读
 * 访问接口，实现放在结构体所在的编译单元（hw/display/vga.c）里。
 *
 * 无副作用约束（总体方案 5、6.2）
 * ---------------------------------------------------------------------------
 * 本头文件里的接口一律只做「读结构体字段」，绝不：
 *   - 调用设备的 MMIO / 端口读写回调（那才是会消耗 FIFO、确认中断的路径）；
 *   - 通过 address_space_* 去访问设备寄存器（会派发到设备 ops）；
 *   - 推进虚拟时钟、重算定时器到期、调用会改写状态的 helper；
 *   - 消费或改写任何队列。
 * 具体地说：VGA 显存用 s->vram_ptr 直接读（backing store），不经过 vga_mem_ops；
 * 几何参数用 s->get_offsets()/s->get_resolution() 现算（QEMU 自己的刷新路径
 * vga_update_display -> vga_update_text -> update_basic_params 也这么做，它们只读
 * 寄存器并做算术，不改状态），因此不依赖上一次刷新是否刚好发生过。
 *
 * 线程/锁上下文
 * ---------------------------------------------------------------------------
 * 这些接口由 monitor/x-oslab-observer.c 的命令处理函数在 **main loop + BQL**
 * 下调用（qmp_dispatch 的 BH）。VGA 的所有状态改动（realize、寄存器写）都在这把
 * 锁的保护下发生，因此在 BQL 内读不会读到「改到一半」的状态。
 *
 * 本头文件不依赖任何 target 头文件：hw/display/vga.c 属于 libcommon（非 per-target
 * 编译单元），必须保持 target 无关。
 */

#ifndef HW_X_OSLAB_DEVICES_H
#define HW_X_OSLAB_DEVICES_H

#include <stdbool.h>
#include <stdint.h>

struct VGACommonState;

/* ---------------------------------------------------------------- VGA */

/** 控制寄存器快照的字节数：CR 取 0x00..0x1f（我们只解释低半段）。 */
#define X_OSLAB_VGA_CR_BYTES 32
#define X_OSLAB_VGA_SR_BYTES 8
#define X_OSLAB_VGA_GR_BYTES 16
#define X_OSLAB_VGA_AR_BYTES 21
/** 同时登记的 VGA 实例上限（本实验室只有一台 primary VGA）。 */
#define X_OSLAB_VGA_MAX_SLOTS 8
/** 文本单元在显存里的字节数：1 字节字符 + 1 字节属性 + 2 个平面字节。 */
#define X_OSLAB_VGA_CELL_STRIDE 4

typedef struct XOslabVgaInfo {
    bool valid;
    /* 文档化的显示模式：text / graph / blank，与 vga_update_text 的判据一致 */
    int32_t graphic_mode;
    bool text_mode;
    bool vbe_enabled;
    /* 文本模式的字符网格；非文本模式时为 0 */
    uint32_t text_cols;
    uint32_t text_rows;
    /* 起始单元（1 单元 = X_OSLAB_VGA_CELL_STRIDE 字节 = 1 个文本单元） */
    uint32_t start_addr;
    /* 每行字节数（CRTC R13 << 3）与行比较值 */
    uint32_t line_offset;
    uint32_t line_compare;
    /* 光标：相对 start_addr 的单元偏移（负数表示在屏外） */
    int32_t cursor_offset;
    uint8_t cursor_start;
    uint8_t cursor_end;
    bool cursor_visible;
    uint32_t cell_stride;
    uint32_t vram_size;
    /* 显存 backing store；只读，生命周期由设备持有 */
    const uint8_t *vram;
    /* 控制寄存器原样拷贝，不做语义解释（解释在宿主侧） */
    uint8_t cr[X_OSLAB_VGA_CR_BYTES];
    uint8_t sr[X_OSLAB_VGA_SR_BYTES];
    uint8_t gr[X_OSLAB_VGA_GR_BYTES];
    uint8_t ar[X_OSLAB_VGA_AR_BYTES];
    uint8_t ar_index;
    uint8_t msr;
    uint8_t st00;
    uint8_t st01;
    int32_t bank_offset;
} XOslabVgaInfo;

/** 已登记的 VGA 实例数。 */
uint32_t x_oslab_vga_count(void);
/**
 * 第 index 个 VGA 实例所属 QOM 对象的 canonical path（调用方 g_free）。
 * 越界、或设备已经没有路径时返回 NULL。
 */
char *x_oslab_vga_path(uint32_t index);
/** 读取第 index 个 VGA 实例的无副作用快照；越界返回 false。 */
bool x_oslab_vga_snapshot(uint32_t index, XOslabVgaInfo *out);

#endif /* HW_X_OSLAB_DEVICES_H */
