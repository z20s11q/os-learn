/*
 * x-oslab-events.h —— x-oslab 事件序列接口（T05b）。
 *
 * 事件种类与 packages/contracts/event.ts 的 MachineEventKind 一一对应，都来自
 * 真实执行点，不用 trace 文本反推：
 *
 *   instruction.begin / instruction.retire
 *       accel/tcg/translator.c 的逐指令循环（翻译期发射，运行期记录）
 *   memory.read / memory.write
 *       tcg/tcg-op-ldst.c 的 4 个 tcg_gen_qemu_ld/st_*_int 发射函数
 *   io.read / io.write
 *       target/i386/tcg/sysemu/misc_helper.c 的 helper_inb/inw/inl 与
 *       helper_outb/outw/outl
 *       （客体 in/out 指令走这条路径；HMP 的 i/o 命令走 system/ioport.c，
 *        属于宿主探针，故意不记录，避免污染客体事件流）
 *   exception.raise / interrupt.accept
 *       target/i386/tcg/seg_helper.c:do_interrupt_all()
 *   dma.read / dma.write（T05c）
 *       hw/virtio/virtio.c:virtqueue_split_pop() / virtqueue_packed_pop() 里，
 *       描述符缓冲刚被 virtqueue_map_desc() 映射完、out_addr/in_addr 与映射
 *       长度都已确定的时刻
 *   block.submit / block.complete（T05c）
 *       hw/block/virtio-blk.c:virtio_blk_handle_request() 的 VIRTIO_BLK_T_IN
 *       分支（提交）与 virtio_blk_req_complete()（完成）
 *   capture.fence（T05e）
 *       monitor/x-oslab-observer.c:qmp_x_oslab_capture() 在统一串行化点
 *       （main loop + BQL，且全部 vCPU 已停止）记录。顺序是：先取一份 pending
 *       台账快照，再记录 capture.fence，然后用 fence 自己的 seq 作为这一帧的
 *       eventWatermark。于是「seq <= fence 的 seq」正好等价于「属于这一帧」，
 *       分界不靠调用方事后推断。
 *
 * pending I/O 台账（T05e，停止屏障的核心）：
 *   即便 vCPU 已停止，宿主块 I/O 仍可能在完成。capture 必须区分两种情况：
 *     - hostIoDone == false：宿主块层还在搬数据（后台工作没做完）；
 *     - hostIoDone == true ：宿主块层的完成回调已经进入（数据已落到客体内存
 *       或已失败），但状态字节还没回写客体，也就是「完成回调还没对设备可见」。
 *   两者都仍然是 pending：pending 的判据是「状态字节有没有回写客体」，也就是
 *   virtio_blk_req_complete() 有没有执行，而不是宿主还在不在忙。台账在
 *   block.submit 之后的落点登记、在宿主完成回调入口标 hostIoDone、在
 *   virtio_blk_req_complete() 里移除，因此在「main loop + BQL、全部 vCPU 停止」
 *   这个串行化点上读到的台账就是一份一致快照：没有任何完成回调能插进来。
 *   禁止为了让磁盘看起来稳定而在采集时主动把 pending 请求做完。
 *   同一 requestId 再次登记只有一种来路：宿主错误动作 stop（werror/rerror=stop）
 *   把请求挂到 s->rq 上且本次不完成，VM 恢复时 virtio_blk_dma_restart_bh() 重新
 *   提交同一个请求对象。这会把该条目标回 hostIoDone == false、hostDoneSeq == 0、
 *   submitSeq 更新为这一次提交的水位线，并累加 x_oslab_block_inflight_resubmits()：
 *   上一回合的「宿主已完成」不能说成这一回合的事实（block.submit 会出现两次、
 *   block.complete 只出现一次，是真实行为）。
 *
 * 停止屏障上的可观测性（T05e 源码复核结论；读不到不等于没有，所以写下来）：
 *   任何「全部 vCPU 已停止」的屏障都来自 system/runstate.c 的状态切换：
 *   vm_state_notify() 会调 hw/virtio/virtio.c:virtio_vmstate_change()，停机方向
 *   调 virtio_bus_stop_ioeventfd() → vdc->stop_ioeventfd；hw/block/virtio-blk.c
 *   把它接成 virtio_blk_data_plane_stop()（hw/block/dataplane/virtio-blk.c，函数
 *   体注释「Wait for virtio_blk_dma_restart_bh() and in flight I/O to complete」），
 *   里面调 block/block-backend.c:blk_drain()：先 bdrv_drained_begin()，再
 *   AIO_WAIT_WHILE(blk->in_flight > 0)。而 blk_root_drained_begin() 在
 *   qatomic_fetch_inc(&tgm->io_limits_disabled) == 0 时调
 *   block/throttle-groups.c:throttle_group_restart_tgm()，它 timer_del() +
 *   timer_cb() 取消并立即触发节流定时器、qemu_co_queue_next() 放行被挂起的请求；
 *   此后 throttle_group_schedule_timer() 因 io_limits_disabled 直接返回 false，
 *   限流整体让路。推论：
 *     - 对 virtio-blk，停机屏障处不会出现 hostIoDone == false 的条目 —— 停机
 *       动作自己会放行被限流的请求，并用 AIO_WAIT_WHILE 等它把宿主 I/O 做完；
 *     - 屏障处真正还能读到的 pending 是设备层已经挂起的请求
 *       （host-io-done-awaiting-visibility，例如 werror=stop 把请求挂到 s->rq）；
 *     - blk_drain() 的 AIO_WAIT_WHILE 只等宿主 in_flight，不等状态字节回写，
 *       所以「宿主已完成」与「还没对客体可见」在屏障处仍然可以并存。
 *
 * dma.* 的语义（T05c 明确写下来，避免被读成逐字节传输采样）：
 *   它记录的是「这次描述符映射给了设备多大的客体缓冲访问权」：方向、客体物理
 *   地址、映射长度。对 virtio-blk 而言这段缓冲就是设备随后真正读/写的那段客体
 *   内存（请求头 + 数据段 + 状态字节）。落点选在描述符映射处而不是逐字节传输
 *   处，是因为设备把映射得到的宿主指针直接解引用（例如 virtio-blk 的
 *   stb_p(&req->in->status)），这些访问不经过 address_space_*，在地址空间层
 *   没有可插桩的落点；只有按描述符上报才能覆盖设备的全部访问路径。
 *   载荷字节的核对交给 x-oslab-read-physical 独立读取，事件本身只保证
 *   「哪个客体物理区间、哪个方向、属于哪个请求」是真实的。
 *   requestId 由 (virtqueue 索引, 描述符头索引/id) 组成，同一个请求的 dma.*
 *   与 block.submit / block.complete 用同一个 requestId 关联。
 *
 * 已知缺口（都是有意保留的，不在 T05b 里假装覆盖）：
 *   - 128 位访存（INDEX_op_qemu_ld/st_*_i128 走 gen_helper_ld_i128/st_i128）
 *     不产生 memory 事件；
 *   - 并行 TCG 下的原子 cmpxchg/op helper（atomic_*）不产生 memory 事件；
 *     本实验室用 -accel tcg,thread=single，非并行路径仍会经过
 *     tcg_gen_qemu_ld/st_*_int，因此普通访存不受影响；
 *   - 只有「没有正常完成」的指令才不产生 retire：DISAS_NORETURN（异常、
 *     hlt 等）与分支 / DISAS_EOB_*（TB 退出已经在指令代码里发射，之后追加
 *     的 op 是死代码）。in/out/ins/outs 会被 translator_io_start 置成
 *     DISAS_TOO_MANY、单独占一个 TB，但它们确实正常完成，照常产生 retire。
 *     见 accel/tcg/translator.c 里 retire 发射点的注释。
 *
 * 本头文件同时被 host 通用的 tcg/tcg-op-ldst.c 包含，所以只允许依赖 tcg/tcg.h，
 * 不能引入任何 target 头文件；需要 gen_helper_* 的发射器在
 * accel/tcg/x-oslab-events.c（per-target）里实现。
 *
 * 采集是「翻译期 + 运行期」双重开关：
 *   - 关闭时发射器不产生任何 TCG op，非观测运行的代价为零；
 *   - 因此开关必须在 VM 未运行时切换，切换后由 x-oslab-events 清空 TB 缓存，
 *     否则已经翻译好的 TB 不会带上观察点（会静默少报）。
 */

#ifndef X_OSLAB_EVENTS_H
#define X_OSLAB_EVENTS_H

#include "tcg/tcg.h"

/* 环形缓冲容量（条）。满时覆盖最旧一条并累加 dropped。 */
#define X_OSLAB_EVENT_RING_CAPACITY 65536
/* 每个 vCPU 的「当前指令」槽位上限；超出范围的 cpu_index 不参与指令归属。 */
#define X_OSLAB_MAX_CPUS 64

#define X_OSLAB_CPU_NONE 0xffffffffu
#define X_OSLAB_MMU_NONE 0xffu
#define X_OSLAB_NO_PC    UINT64_MAX
#define X_OSLAB_NO_ADDR  UINT64_MAX

/** 事件种类编号；与契约里的 kind 字符串按同一顺序排列。 */
typedef enum XOslabEventKind {
    X_OSLAB_EVK_INSTRUCTION_BEGIN = 0,
    X_OSLAB_EVK_INSTRUCTION_RETIRE = 1,
    X_OSLAB_EVK_MEMORY_READ = 2,
    X_OSLAB_EVK_MEMORY_WRITE = 3,
    X_OSLAB_EVK_DMA_READ = 4,
    X_OSLAB_EVK_DMA_WRITE = 5,
    X_OSLAB_EVK_IO_READ = 6,
    X_OSLAB_EVK_IO_WRITE = 7,
    X_OSLAB_EVK_IRQ_RAISE = 8,
    X_OSLAB_EVK_IRQ_LOWER = 9,
    X_OSLAB_EVK_INTERRUPT_ACCEPT = 10,
    X_OSLAB_EVK_BLOCK_SUBMIT = 11,
    X_OSLAB_EVK_BLOCK_COMPLETE = 12,
    X_OSLAB_EVK_INPUT_ACCEPT = 13,
    X_OSLAB_EVK_SERIAL_OUTPUT = 14,
    X_OSLAB_EVK_CAPTURE_FENCE = 15,
    X_OSLAB_EVK_EXCEPTION_RAISE = 16,
    X_OSLAB_EVK_OBSERVER_DROP = 17,
    X_OSLAB_EVK_MAX = 18,
} XOslabEventKind;

/** 地址空间：无地址 / 线性（虚拟）地址 / 端口 / 客体物理 / 磁盘 LBA。 */
typedef enum XOslabEventSpace {
    X_OSLAB_SPACE_NONE = 0,
    X_OSLAB_SPACE_LINEAR = 1,
    X_OSLAB_SPACE_IO_PORT = 2,
    /* T05c：设备 DMA 的地址是客体物理地址（vdev->dma_as 下的 GPA）。 */
    X_OSLAB_SPACE_PHYSICAL = 3,
    /* T05c：块请求的 address 是 512 字节单位的起始扇区号，不是内存地址。 */
    X_OSLAB_SPACE_DISK_LBA = 4,
} XOslabEventSpace;

/* 事件标志位。 */
#define X_OSLAB_EVF_SIGN      0x0001u /* 访问带符号扩展 */
#define X_OSLAB_EVF_IS_HW     0x0002u /* 硬件中断（异步） */
#define X_OSLAB_EVF_IS_INT    0x0004u /* 软中断指令 INT n */
#define X_OSLAB_EVF_NO_OWNER  0x0008u /* 记录时没有可归属的指令 */

/** 一条事件记录。字段都是已解码的数值，JSON 化由调用方完成。 */
typedef struct XOslabEventRec {
    uint64_t seq;      /* 全局递增序号，从 1 开始 */
    uint64_t pc;       /* 线性 PC；X_OSLAB_NO_PC 表示没有可靠 PC */
    uint64_t insnSeq;  /* 归属指令的 instruction.begin seq；0 表示无归属 */
    uint64_t address;  /* 访存线性地址 / 端口 / 异常向量；X_OSLAB_NO_ADDR 表示无 */
    uint64_t value;    /* 读取或写入的值 / 异常错误码 */
    uint64_t aux;      /* retire 的指令长度 / 异常的 nextEip */
    uint64_t dropped;  /* observer.drop 事件的累计丢失数 */
    uint32_t kind;     /* XOslabEventKind */
    uint32_t size;     /* 访问宽度（字节）或指令长度；0 表示不适用 */
    uint32_t space;    /* XOslabEventSpace */
    uint32_t flags;    /* X_OSLAB_EVF_* */
    uint32_t mmuIndex; /* 访存的 mmu 索引；X_OSLAB_MMU_NONE 表示不适用 */
    uint32_t cpuIndex; /* X_OSLAB_CPU_NONE 表示未知 */
    /* ---------------- T05c：设备归属与请求关联 ---------------- */
    uint32_t deviceId;  /* 注册过的设备 id；0 表示没有设备归属 */
    uint64_t requestId; /* X_OSLAB_REQUEST_ID() 打包值；0 表示没有请求归属 */
    uint32_t reqType;   /* block.*：VIRTIO_BLK_T_*（已去掉 OUT/BARRIER 标志） */
    uint32_t descHead;  /* block.*：描述符头索引（packed 队列是描述符 id） */
    uint32_t segOut;    /* block.*：设备可读段数（请求头 + 写数据） */
    uint32_t segIn;     /* block.*：设备可写段数（读数据 + 状态字节） */
} XOslabEventRec;

/*
 * requestId 打包：高 32 位是 virtqueue 索引，低 32 位是该队列里这次请求的
 * 描述符标识（split 队列是描述符头索引，packed 队列是描述符 id）。
 * hw/virtio/virtio.c 与 hw/block/virtio-blk.c 都通过这个宏构造，两边算出的
 * 值相同才能把 dma.* 与 block.* 关联到同一个请求上。
 */
#define X_OSLAB_REQUEST_ID(vq_index, desc_id) \
    ((((uint64_t)(vq_index)) << 32) | ((uint64_t)(desc_id) & 0xffffffffu))

/*
 * 记录期 kind 掩码：只有掩码内的 kind 才允许进入事件环。
 *
 * 为什么需要它：指令事件（instruction.begin/retire、memory.*）数量级远大于
 * 设备事件，65536 条的事件环几十毫秒就被冲掉，稀疏的 dma.* 与 block.* 根本留不
 * 住。读取期的 kinds 过滤只影响返回给观察者的内容，救不回已经被覆盖的记录，
 * 所以必须有一个「哪些 kind 值得入环」的记录期开关。
 *
 * 掩码外的 kind 直接早退：不入环、不占 seq、不计入 dropped（dropped 只表示
 * 环满覆盖，不该被过滤掉的记录污染）。X_OSLAB_RECORD_KIND_ALL 等价于 T05b 的
 * 行为（全部入环）。
 */
#define X_OSLAB_RECORD_KIND_ALL ((1ull << X_OSLAB_EVK_MAX) - 1ull)

#ifdef CONFIG_TCG

/** kind 编号对应的契约字符串；越界返回 "unknown"。 */
const char *x_oslab_event_kind_name(uint32_t kind);

/** 采集开关（默认关闭）。切换后必须清空 TB 缓存，见文件头说明。 */
bool x_oslab_event_enabled(void);
void x_oslab_event_set_enabled(bool enabled);

/** 当前记录期 kind 掩码（默认 X_OSLAB_RECORD_KIND_ALL）。 */
uint64_t x_oslab_event_kind_mask(void);
/** 设置记录期 kind 掩码；只应在 VM 停止时调用。 */
void x_oslab_event_set_kind_mask(uint64_t mask);

/** 当前水位线：已记录的最大 seq（没有事件时为 0）。 */
uint64_t x_oslab_event_watermark(void);
/** 环内最早一条的 seq（没有事件时为 0）。 */
uint64_t x_oslab_event_oldest(void);
/** 因环满被覆盖的事件数。 */
uint64_t x_oslab_event_dropped(void);
/** 已记录的事件总数（含已被覆盖的）。 */
uint64_t x_oslab_event_total(void);
/** 环形缓冲容量。 */
uint32_t x_oslab_event_capacity(void);

/**
 * 取出 [from, to] 区间内最多 limit 条事件，按 seq 升序写入 out。
 * out 由调用方按 limit 条分配。返回实际写入条数。
 */
uint32_t x_oslab_event_fetch(uint64_t from, uint64_t to, uint32_t limit,
                             XOslabEventRec *out);

/* ---------- C 层记录入口（由 target 代码在真实执行点调用） ---------- */

/** 客体 in/out 指令的端口访问；size 为 1/2/4，value 为实际读出或写入的字节。 */
void x_oslab_event_io(bool is_read, uint32_t port, uint64_t value, uint32_t size);

/**
 * do_interrupt_all() 的统一入口。分类依据「CPU 是怎么到达处理程序的」：
 *   is_hw        → interrupt.accept（异步硬件中断，不归因到指令）
 *   is_int       → interrupt.accept（INT n 软件中断，用 flags.IS_INT 区分，
 *                  归因到执行 INT 的那条指令）
 *   两者都为假   → exception.raise（同步异常，归因到出错指令）
 * intno/error_code 原样上报，不做重编号。
 */
void x_oslab_event_interrupt(uint32_t intno, uint32_t error_code,
                             uint64_t next_eip, bool is_int, bool is_hw);

/* ---------- T05c：设备注册与 virtio / 块请求事件 ---------- */

/**
 * 注册一个可观测设备，返回 >= 1 的稳定 id；返回 0 表示注册失败（表满）。
 * 设备在 realize 时注册、unrealize 时注销，事件环里只存数字 id，避免在
 * vCPU 线程里搬字符串。
 */
uint32_t x_oslab_device_register(const char *name);
void x_oslab_device_unregister(uint32_t id);
/** id 对应的设备名；id 为 0 或未注册时返回 NULL。 */
const char *x_oslab_device_name(uint32_t id);
/** 当前已注册的设备数。 */
uint32_t x_oslab_device_count(void);
/** 按序号取设备名（0 <= index < x_oslab_device_count()），越界返回 NULL。 */
const char *x_oslab_device_name_at(uint32_t index);

/**
 * 设备在一次描述符映射中获得的客体缓冲访问权。
 *   is_write == false : 设备要读这段客体内存（virtio 的 out / TO_DEVICE 描述符）
 *   is_write == true  : 设备要写这段客体内存（virtio 的 in / FROM_DEVICE 描述符）
 * gpa 是客体物理地址；len 是这一次映射的长度（跨内存区时描述符会被拆成多段，
 * 每段各报一条）。这里不读内存内容：映射只是访问权，逐字节的载荷由读取方用
 * x-oslab-read-physical 独立核对。
 */
void x_oslab_event_dma(bool is_write, uint32_t device_id, uint64_t request_id,
                       uint64_t gpa, uint32_t len);

/** 块请求提交/完成时要上报的字段。 */
typedef struct XOslabBlockInfo {
    uint64_t lba;     /* 起始扇区号（512 字节单位），与 guest 给的 sector 一致 */
    uint32_t length;  /* 数据长度（字节，不含请求头与状态字节） */
    uint32_t reqType; /* VIRTIO_BLK_T_IN（读盘）/ VIRTIO_BLK_T_OUT（写盘） */
    uint32_t outSeg;  /* 设备可读段数 */
    uint32_t inSeg;   /* 设备可写段数 */
} XOslabBlockInfo;

/** 块请求提交：请求已经进设备，还没有完成。 */
void x_oslab_event_block_submit(uint32_t device_id, uint64_t request_id,
                                const XOslabBlockInfo *info);
/** 块请求完成：status 取自实际准备回写到客体的那个状态字节。 */
void x_oslab_event_block_complete(uint32_t device_id, uint64_t request_id,
                                  uint32_t status, const XOslabBlockInfo *info);

/* ---------- T05e：停止屏障的 pending I/O 台账 ---------- */

/**
 * 一个「已被设备接受、状态字节还没回写客体」的块请求。
 *
 * pending 的判据是对客体是否可见（virtio_blk_req_complete() 有没有执行），
 * 不是宿主块层还在不在忙；hostIoDone 只是并列的一层更细的信息。
 */
typedef struct XOslabBlockInflight {
    uint64_t requestId;    /* 与 dma.* / block.* 事件同一个关联 id */
    uint64_t lba;          /* 起始扇区号（512 字节单位） */
    uint64_t submitSeq;    /* 登记这一刻的事件水位线（block.submit 被记录时正好是它的 seq，否则是当时的水位线；0 表示没有事件） */
    uint64_t hostDoneSeq;  /* 宿主完成回调进入这一刻的事件水位线；0 表示宿主回调还没进入 */
    uint32_t length;       /* 数据长度（字节，不含请求头与状态字节） */
    uint32_t reqType;      /* VIRTIO_BLK_T_IN（读盘）/ VIRTIO_BLK_T_OUT（写盘） */
    uint32_t deviceId;     /* 注册表里的设备 id */
    uint32_t outSeg;       /* 设备可读段数 */
    uint32_t inSeg;        /* 设备可写段数 */
    /* 宿主块层的完成回调已经进入：数据已落到客体内存（或这次 I/O 已失败），
     * 但状态字节还没回写客体，也就是「后台工作已完成、完成回调还没对设备可见」。
     * 注意本实验室把 virtio-blk 留在默认主循环（没有 iothread），完成回调也要
     * 拿 BQL，因此在采集点上这个窗口通常极窄；它是并列事实，不是 pending 判据。 */
    bool hostIoDone;
} XOslabBlockInflight;

/**
 * 块请求进入设备：登记为 pending（对客体尚不可见）。
 * 必须在 block.submit 事件的落点之后就调用（同一段代码、不yield），
 * 否则采集可能看到一个已经提交、却不在台账里的请求。
 */
void x_oslab_block_inflight_submit(uint32_t device_id, uint64_t request_id,
                                   const XOslabBlockInfo *info);
/** 宿主块层完成回调已进入（数据已搬到客体内存或已失败），状态字节还没写。 */
void x_oslab_block_inflight_host_done(uint32_t device_id, uint64_t request_id);
/** 状态字节已回写客体：请求不再 pending，从台账移除。 */
void x_oslab_block_inflight_visible(uint32_t device_id, uint64_t request_id);
/** 设备注销/复位时清掉它名下的全部台账，避免留下永不消失的幽灵请求。 */
void x_oslab_block_inflight_clear_device(uint32_t device_id);

/** 当前 pending 条数（对客体尚不可见的块请求）。 */
uint32_t x_oslab_block_inflight_count(void);
/** 当前 pending 中「宿主已完成、只是还没对客体可见」的条数。 */
uint32_t x_oslab_block_inflight_host_done_count(void);
/**
 * 取一份一致快照，按登记顺序（即 submit 顺序）写入 out，最多 max 条。
 * 返回实际写入条数；台账容量与溢出数见 x_oslab_block_inflight_capacity/overflow。
 */
uint32_t x_oslab_block_inflight_snapshot(XOslabBlockInflight *out, uint32_t max);
/** 台账容量（条）。 */
uint32_t x_oslab_block_inflight_capacity(void);
/** 因台账满而未能登记的请求数；非 0 表示 pending 分类不完整。 */
uint64_t x_oslab_block_inflight_overflow(void);
/**
 * 对已在台账里的 requestId 再次 submit 的次数（宿主错误动作 stop 之后的重提交）。
 * 非 0 说明出现过「同一请求被设备提交两次」，读取方不该把它当成漏报。
 */
uint64_t x_oslab_block_inflight_resubmits(void);

/**
 * 在统一串行化点记录一条 capture.fence，它是这一帧事件的分界。
 * value 字段报「此刻仍在飞行、尚未对客体可见的块请求数」。
 * 返回 fence 自己的 seq；采集关闭（或该 kind 被记录掩码排除）时返回 0，
 * 调用方此时应退回 x_oslab_event_watermark() 并如实标注没有 fence。
 */
uint64_t x_oslab_event_fence(uint32_t pending_requests);

/** 清空事件环与序号（只在 VM 停止、且调用方确认无观测者依赖旧序号时使用）。 */
void x_oslab_event_reset(void);

/* ---------- TCG 发射器（translation time） ---------- */

/** 指令即将执行；发射在 translate_insn 之前，代表「尝试执行」。 */
void x_oslab_tcg_insn_begin(uint64_t pc);

/** 指令翻译代码落到下一条指令；异常/分支路径不会发射。 */
void x_oslab_tcg_insn_retire(uint64_t pc, uint32_t length);

/**
 * 在真正的 ld/st op 之前保存地址副本（load 结果可能与地址临时寄存器混叠）。
 * 关闭采集时返回 NULL，不产生任何 op；返回值由 x_oslab_tcg_mem 负责释放。
 */
TCGv_i64 x_oslab_tcg_preserve_addr(TCGTemp *addr);

/** 在 ld/st op 之后记录访存事件；preserved_addr 可为 NULL。 */
void x_oslab_tcg_mem(TCGv_i64 preserved_addr, TCGTemp *value, bool value_is_64,
                     bool is_write, uint32_t size, uint32_t mmu_index, bool sign);

#else /* !CONFIG_TCG */

static inline const char *x_oslab_event_kind_name(uint32_t kind)
{
    (void)kind;
    return "unknown";
}

static inline bool x_oslab_event_enabled(void) { return false; }
static inline void x_oslab_event_set_enabled(bool enabled) { (void)enabled; }
static inline uint64_t x_oslab_event_kind_mask(void)
{
    return X_OSLAB_RECORD_KIND_ALL;
}
static inline void x_oslab_event_set_kind_mask(uint64_t mask) { (void)mask; }
static inline uint64_t x_oslab_event_watermark(void) { return 0; }
static inline uint64_t x_oslab_event_oldest(void) { return 0; }
static inline uint64_t x_oslab_event_dropped(void) { return 0; }
static inline uint64_t x_oslab_event_total(void) { return 0; }
static inline uint32_t x_oslab_event_capacity(void) { return 0; }
static inline uint32_t x_oslab_event_fetch(uint64_t from, uint64_t to,
                                           uint32_t limit, XOslabEventRec *out)
{
    (void)from;
    (void)to;
    (void)limit;
    (void)out;
    return 0;
}
static inline void x_oslab_event_io(bool is_read, uint32_t port, uint64_t value,
                                    uint32_t size)
{
    (void)is_read;
    (void)port;
    (void)value;
    (void)size;
}
static inline void x_oslab_event_interrupt(uint32_t intno, uint32_t error_code,
                                           uint64_t next_eip, bool is_int,
                                           bool is_hw)
{
    (void)intno;
    (void)error_code;
    (void)next_eip;
    (void)is_int;
    (void)is_hw;
}
static inline void x_oslab_event_reset(void) { }
static inline uint32_t x_oslab_device_register(const char *name)
{
    (void)name;
    return 0;
}
static inline void x_oslab_device_unregister(uint32_t id) { (void)id; }
static inline const char *x_oslab_device_name(uint32_t id) { (void)id; return NULL; }
static inline uint32_t x_oslab_device_count(void) { return 0; }
static inline const char *x_oslab_device_name_at(uint32_t index)
{
    (void)index;
    return NULL;
}
static inline void x_oslab_event_dma(bool is_write, uint32_t device_id,
                                     uint64_t request_id, uint64_t gpa,
                                     uint32_t len)
{
    (void)is_write;
    (void)device_id;
    (void)request_id;
    (void)gpa;
    (void)len;
}
static inline void x_oslab_event_block_submit(uint32_t device_id,
                                              uint64_t request_id,
                                              const XOslabBlockInfo *info)
{
    (void)device_id;
    (void)request_id;
    (void)info;
}
static inline void x_oslab_event_block_complete(uint32_t device_id,
                                                uint64_t request_id,
                                                uint32_t status,
                                                const XOslabBlockInfo *info)
{
    (void)device_id;
    (void)request_id;
    (void)status;
    (void)info;
}
static inline void x_oslab_block_inflight_submit(uint32_t device_id,
                                                 uint64_t request_id,
                                                 const XOslabBlockInfo *info)
{
    (void)device_id;
    (void)request_id;
    (void)info;
}
static inline void x_oslab_block_inflight_host_done(uint32_t device_id,
                                                    uint64_t request_id)
{
    (void)device_id;
    (void)request_id;
}
static inline void x_oslab_block_inflight_visible(uint32_t device_id,
                                                  uint64_t request_id)
{
    (void)device_id;
    (void)request_id;
}
static inline void x_oslab_block_inflight_clear_device(uint32_t device_id)
{
    (void)device_id;
}
static inline uint32_t x_oslab_block_inflight_count(void) { return 0; }
static inline uint32_t x_oslab_block_inflight_host_done_count(void) { return 0; }
static inline uint32_t x_oslab_block_inflight_snapshot(XOslabBlockInflight *out,
                                                       uint32_t max)
{
    (void)out;
    (void)max;
    return 0;
}
static inline uint32_t x_oslab_block_inflight_capacity(void) { return 0; }
static inline uint64_t x_oslab_block_inflight_overflow(void) { return 0; }
static inline uint64_t x_oslab_block_inflight_resubmits(void) { return 0; }
static inline uint64_t x_oslab_event_fence(uint32_t pending_requests)
{
    (void)pending_requests;
    return 0;
}
static inline void x_oslab_tcg_insn_begin(uint64_t pc) { (void)pc; }
static inline void x_oslab_tcg_insn_retire(uint64_t pc, uint32_t length)
{
    (void)pc;
    (void)length;
}
static inline TCGv_i64 x_oslab_tcg_preserve_addr(TCGTemp *addr)
{
    (void)addr;
    return NULL;
}
static inline void x_oslab_tcg_mem(TCGv_i64 preserved_addr, TCGTemp *value,
                                   bool value_is_64, bool is_write, uint32_t size,
                                   uint32_t mmu_index, bool sign)
{
    (void)preserved_addr;
    (void)value;
    (void)value_is_64;
    (void)is_write;
    (void)size;
    (void)mmu_index;
    (void)sign;
}

#endif /* CONFIG_TCG */

#endif /* X_OSLAB_EVENTS_H */