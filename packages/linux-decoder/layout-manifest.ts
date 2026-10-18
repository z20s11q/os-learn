/** 内核结构、联合和枚举的布局生成清单，每项 why 说明解析用途。
 * required=true 的缺失导致生成失败，false 的缺失记录在 missing 中。
 */

export type ManifestKind = 'struct' | 'union' | 'enum' | 'any';

export interface ManifestEntry {
  name: string;
  kind: ManifestKind;
  required: boolean;
  why: string;
}

export const LAYOUT_MANIFEST: ManifestEntry[] = [
  /* ---------- 通用容器（几乎所有子任务都要） ---------- */
  { name: 'list_head', kind: 'struct', required: true, why: '内核里最常见的链表节点，任务/文件/页缓存都在用（T07b–T07e）' },
  { name: 'hlist_node', kind: 'struct', required: true, why: '哈希链表节点，dentry 哈希桶用它（T07d）' },
  { name: 'hlist_head', kind: 'struct', required: true, why: '哈希链表头（T07d）' },
  { name: 'rb_node', kind: 'struct', required: true, why: '红黑树节点，VMA 与调度用（T07b/T07c）' },
  { name: 'wait_queue_head', kind: 'struct', required: true, why: '等待队列头，进程睡眠/唤醒的落脚点（T07b/T10b）' },
  { name: 'wait_queue_entry', kind: 'struct', required: true, why: '等待队列项，指向被唤醒任务（T07b/T10b）' },
  { name: 'completion', kind: 'struct', required: true, why: '完成量，I/O 等待用它（T07b/T07f）' },

  /* ---------- T07b 任务 ---------- */
  { name: 'task_struct', kind: 'struct', required: true, why: '进程描述符，T07b 的主体' },
  { name: 'thread_info', kind: 'struct', required: true, why: 'task_struct 头部的架构相关状态（T07b）' },
  { name: 'thread_struct', kind: 'struct', required: true, why: '架构相关线程状态（T07b/T07g）' },
  { name: 'sched_entity', kind: 'struct', required: true, why: 'CFS 调度实体，runqueue 摘要用（T07b）' },
  { name: 'cfs_rq', kind: 'struct', required: true, why: 'CFS 运行队列（T07b）' },
  { name: 'rt_rq', kind: 'struct', required: true, why: '实时运行队列，runqueue 摘要要报 rt_nr_running（T07b）' },
  { name: 'dl_rq', kind: 'struct', required: true, why: '截止时间运行队列，runqueue 摘要要报 dl_nr_running（T07b）' },
  { name: 'sched_rt_entity', kind: 'struct', required: true, why: '任务的实时调度实体 task_struct.rt（T07b）' },
  { name: 'sched_dl_entity', kind: 'struct', required: true, why: '任务的截止时间调度实体 task_struct.dl（T07b）' },
  { name: 'load_weight', kind: 'struct', required: true, why: '调度权重（sched_entity.load 等）（T07b）' },
  { name: 'rq', kind: 'struct', required: true, why: '每 CPU 运行队列（T07b）' },
  { name: 'pcpu_hot', kind: 'struct', required: true, why: '每 CPU 热点数据：current_task/preempt_count/cpu_number，取 current 的落脚点（T07b）' },
  { name: 'rb_root_cached', kind: 'struct', required: false, why: '带最左缓存的红黑树根（VMA 树等）（T07c）' },
  { name: 'fs_struct', kind: 'struct', required: false, why: 'cwd/root 路径信息（T07d）' },
  { name: 'signal_struct', kind: 'struct', required: true, why: '线程组共享的信号与统计（T07b）' },
  { name: 'sighand_struct', kind: 'struct', required: true, why: '信号处理函数表（T07b）' },
  { name: 'nsproxy', kind: 'struct', required: true, why: '命名空间代理，任务归属（T07b）' },
  { name: 'cred', kind: 'struct', required: true, why: '凭据（uid/gid），任务面板要显示（T07b）' },
  { name: 'pid', kind: 'struct', required: true, why: 'pid 结构，任务的 pid/tgid 映射（T07b）' },
  { name: 'upid', kind: 'struct', required: false, why: '每命名空间的 pid 视图（T07b）' },
  { name: 'refcount_struct', kind: 'struct', required: true, why: '引用计数（task_struct.usage）（T07b）' },
  { name: 'atomic_t', kind: 'struct', required: false, why: '原子整数（T07b）' },
  { name: 'kernel_cap_struct', kind: 'struct', required: false, why: '能力位图（T07b）' },

  /* ---------- T07c 地址空间 ---------- */
  { name: 'mm_struct', kind: 'struct', required: true, why: '内存描述符，T07c 的主体' },
  { name: 'vm_area_struct', kind: 'struct', required: true, why: '虚拟内存区域（VMA），T07c 的核心对象' },
  { name: 'vm_operations_struct', kind: 'struct', required: true, why: 'VMA 操作表指针，判断映射类型（T07c）' },
  { name: 'maple_tree', kind: 'struct', required: true, why: 'VMA 容器：6.1 起用 Maple Tree 取代链表，禁止套用旧偏移（T07c）' },
  { name: 'maple_node', kind: 'struct', required: false, why: 'Maple Tree 节点（T07c）' },
  { name: 'maple_range_64', kind: 'struct', required: false, why: 'Maple Tree 16 槽区间节点（T07c）' },
  { name: 'maple_arange_64', kind: 'struct', required: true, why: 'Maple Tree 10 槽带间隙节点：分配树（VMA 树带 MT_FLAGS_ALLOC_RANGE）里只有它记间隙，内部节点就是它；少了它就没法把十槽节点与十六槽节点区分开（T07c）' },
  { name: 'maple_metadata', kind: 'struct', required: false, why: 'Maple Tree 节点的 meta（end/gap 两个字节）：节点里实际用到第几槽由它说了算，不看 meta 会读到空槽（T07c）' },
  { name: 'maple_enode', kind: 'struct', required: false, why: 'Maple Tree 紧凑节点（T07c）' },
  { name: 'ma_state', kind: 'struct', required: false, why: 'Maple Tree 迭代状态（T07c）' },
  { name: 'vma_iterator', kind: 'struct', required: false, why: 'VMA 遍历器（T07c）' },
  { name: 'folio', kind: 'struct', required: true, why: '页缓存/匿名页的现代表示，6.12 里 page 大多藏在 folio 匿名联合里（T07c/T07d）' },
  { name: 'page', kind: 'struct', required: false, why: '老式页表示，folio 内部就是它（T07c）' },
  { name: 'address_space', kind: 'struct', required: true, why: '页缓存宿主，文件↔页的桥（T07c/T07d/T07f）' },
  { name: 'anon_vma', kind: 'struct', required: false, why: '匿名页反向映射（T07c）' },
  { name: 'vm_fault', kind: 'struct', required: false, why: '缺页处理上下文（T07c）' },

  /* ---------- T07d 文件 ---------- */
  { name: 'files_struct', kind: 'struct', required: true, why: '进程打开文件表（T07d）' },
  { name: 'fdtable', kind: 'struct', required: true, why: 'fd → file 的位图与数组（T07d）' },
  { name: 'file', kind: 'struct', required: true, why: '打开的文件对象（T07d）' },
  { name: 'path', kind: 'struct', required: true, why: 'vfsmount + dentry 组成路径（T07d）' },
  { name: 'vfsmount', kind: 'struct', required: true, why: '挂载点（T07d）' },
  { name: 'mount', kind: 'struct', required: false, why: '挂载树节点（T07d）' },
  { name: 'dentry', kind: 'struct', required: true, why: '目录项（T07d）' },
  { name: 'qstr', kind: 'struct', required: true, why: 'dentries 的名字（T07d）' },
  { name: 'inode', kind: 'struct', required: true, why: 'inode（T07d/T07e）' },
  { name: 'super_block', kind: 'struct', required: true, why: '超级块（T07d/T07e）' },
  { name: 'xarray', kind: 'struct', required: true, why: '页缓存容器，必须解析 XArray 而不是老式 radix_tree（T07d）' },
  { name: 'xa_node', kind: 'struct', required: false, why: 'XArray 内部节点（T07d）' },
  { name: 'xa_state', kind: 'struct', required: false, why: 'XArray 游标（T07d）' },
  { name: 'file_ra_state', kind: 'struct', required: false, why: '预读状态（T07f）' },

  /* ---------- T07e ext2 盘面 ---------- */
  { name: 'ext2_super_block', kind: 'struct', required: true, why: 'ext2 超级块，盘面解析起点（T07e）' },
  { name: 'ext2_inode', kind: 'struct', required: true, why: 'ext2 inode（T07e）' },
  { name: 'ext2_group_desc', kind: 'struct', required: true, why: 'ext2 块组描述符（T07e）' },
  { name: 'ext2_dir_entry_2', kind: 'struct', required: true, why: 'ext2 目录项（T07e）' },
  { name: 'ext2_inode_info', kind: 'struct', required: false, why: 'ext2 内存 inode（T07e，用于与 ext2_inode 对照）' },
  { name: 'ext2_sb_info', kind: 'struct', required: false, why: 'ext2 内存超级块（T07e）' },
  { name: 'ext2_super_block', kind: 'struct', required: false, why: '（重复条目会被生成器合并）' },

  /* ---------- T07f I/O 关联 ---------- */
  { name: 'bio', kind: 'struct', required: true, why: '块层 I/O 描述符，文件↔块请求的中间层（T07f）' },
  { name: 'bio_vec', kind: 'struct', required: true, why: 'bio 里的页/偏移/长度三元组（T07f）' },
  { name: 'bio_list', kind: 'struct', required: false, why: 'bio 链表（T07f）' },
  { name: 'request', kind: 'struct', required: true, why: '块层请求（T07f）' },
  { name: 'request_queue', kind: 'struct', required: true, why: '块设备请求队列（T07f）' },
  { name: 'blk_plug', kind: 'struct', required: false, why: '请求合并的暂存区（T07f）' },
  { name: 'gendisk', kind: 'struct', required: true, why: '通用磁盘对象（T07f）' },
  { name: 'block_device', kind: 'struct', required: true, why: '块设备对象（T07f）' },
  { name: 'blk_mq_ctx', kind: 'struct', required: false, why: '多队列软件上下文（T07f）' },
  { name: 'blk_mq_hw_ctx', kind: 'struct', required: false, why: '多队列硬件上下文（T07f）' },
  { name: 'virtblk_req', kind: 'struct', required: false, why: 'virtio-blk 每请求状态（6.12 里叫 virtblk_req，不是 virtio_blk_req）（T07f）' },
  { name: 'virtio_blk_config', kind: 'struct', required: false, why: 'virtio-blk 协商出的配置（T07f）' },
  { name: 'virtio_blk_outhdr', kind: 'struct', required: false, why: 'virtio-blk 请求头（T06 用的 16 字节头）（T07f）' },
  { name: 'virtio_device', kind: 'struct', required: false, why: 'virtio 设备（T07f）' },
  { name: 'vring_desc', kind: 'struct', required: false, why: 'split virtqueue 描述符（T07f，纯协议结构）' },
  { name: 'vring_avail', kind: 'struct', required: false, why: 'split virtqueue avail 环（T07f）' },
  { name: 'vring_used_elem', kind: 'struct', required: false, why: 'used 环元素（T07f）' },
  // 文件到设备请求的关联使用 buffer_head、bio 游标及驱动私有区。
  // bio 向量按 bvec_iter 展开，virtio-blk 状态存于 blk-mq PDU。
  // PDU 地址为 rq + sizeof(struct request)，描述符链经 vring 读取。
  // 这些布局共同提供扇区区间和描述符关联。
  { name: 'buffer_head', kind: 'struct', required: false, why: 'ext2 写回走的缓冲区头，folio 与 bio 之间的那一层（T07f）' },
  { name: 'bvec_iter', kind: 'struct', required: false, why: 'bio 的遍历游标：扇区/剩余长度/当前 bvec 下标（T07f）' },
  { name: 'scatterlist', kind: 'struct', required: false, why: 'virtblk_req 里那串 sg 表项，指向每个数据页（T07f）' },
  { name: 'sg_table', kind: 'struct', required: false, why: 'virtblk_req 的 sg 表头（T07f）' },
  { name: 'blk_mq_tags', kind: 'struct', required: false, why: 'blk-mq 的 tag → request 数组，请求 ID 的落脚点（T07f）' },
  { name: 'blk_mq_queue_data', kind: 'struct', required: false, why: '驱动 queue_rq 的入参，包着 request（T07f）' },
  { name: 'mq_rq_state', kind: 'enum', required: false, why: '请求状态 MQ_RQ_IDLE/IN_FLIGHT/COMPLETE（T07f）' },
  { name: 'virtqueue', kind: 'struct', required: false, why: 'virtio 队列的公共部分（index/num_free/vdev）（T07f）' },
  { name: 'vring_virtqueue', kind: 'struct', required: false, why: '队列实现结构，ring 指针与 last_used_idx 在这里（T07f）' },
  { name: 'vring_virtqueue_split', kind: 'struct', required: false, why: 'split 队列的 vring 与影子索引（T07f）' },
  { name: 'vring', kind: 'struct', required: false, why: 'split ring 的 desc/avail/used 三个指针（T07f）' },
  { name: 'vring_used', kind: 'struct', required: false, why: 'used 环头（T07f）' },
  { name: 'virtio_blk', kind: 'struct', required: false, why: 'virtio-blk 驱动状态，从 gendisk 顺到 vqs（T07f）' },
  { name: 'virtio_blk_vq', kind: 'struct', required: false, why: '每个 virtio-blk 硬件队列的 virtqueue 指针（T07f）' },
  { name: 'vring_desc_state_split', kind: 'struct', required: false, why: 'split 环上"第几个描述符属于谁"的状态表：data 就是内核加进队列的那个 token（virtio-blk 传的是请求 PDU）。它是"描述符↔请求"唯一权威的关联，不靠地址猜（T07f）' },
  { name: 'vring_desc_extra', kind: 'struct', required: false, why: 'split 环每个描述符的额外记账（dma 地址/长度/下一跳），与 vring_desc 对照用（T07f）' },

  /* ---------- T07g 用户源码 ---------- */
  { name: 'pt_regs', kind: 'struct', required: true, why: '用户态寄存器现场（T07g）' },
  { name: 'elf64_hdr', kind: 'struct', required: true, why: '用户 ELF 头（T07g）' },
  { name: 'elf64_phdr', kind: 'struct', required: true, why: '用户 ELF 程序头（T07g）' },
  { name: 'elf64_shdr', kind: 'struct', required: false, why: '用户 ELF 节头（T07g）' },
  { name: 'linux_binprm', kind: 'struct', required: false, why: 'exec 装载上下文（T07g）' },
  { name: 'mm_struct', kind: 'struct', required: false, why: '过渡到地址空间面板（合并后只留一份）' },

  /* ---------- 枚举 ---------- */
  { name: 'pid_type', kind: 'enum', required: false, why: 'PIDTYPE_PID/TGID/…，pid 结构索引（T07b）' },
  { name: 'rw_hint', kind: 'enum', required: false, why: '读写提示（T07d）' },
  { name: 'req_op', kind: 'enum', required: false, why: '块请求操作类型（6.x 改名：以前是 req_op = REQ_OP_*）（T07f）' },
  { name: 'req_flag_bits', kind: 'enum', required: false, why: '块请求标志位（T07f）' },
  { name: 'blk_status_t', kind: 'any', required: false, why: '块请求完成状态的类型（`bio->bi_status` 的宽度靠它确认）。注意：6.12 里它是 `typedef u8 __bitwise blk_status_t`、取值是 `#define BLK_STS_*`，所以 DWARF 里**只有这个 typedef、没有枚举项**；名字表在 `io/blocks.ts` 里按头文件抄，并由验收脚本对账（T07f）' },
  { name: 'blk_default_limits', kind: 'enum', required: false, why: '队列默认限制（T07f）' },
  { name: 'zone_type', kind: 'enum', required: false, why: '内存区类型（T07c）' },
  { name: 'pageflags', kind: 'enum', required: false, why: '页标志位（T07c）' },
  { name: 'migrate_mode', kind: 'enum', required: false, why: '页迁移模式（T07c）' },
  { name: 'dentry_flags', kind: 'enum', required: false, why: 'dentry 状态位（T07d）' },
  { name: 'inode_state_flags', kind: 'enum', required: false, why: 'inode 状态位（T07d）' },
  { name: 'xas_state_flags', kind: 'enum', required: false, why: 'XArray 游标状态（T07d）' },
];

/** 去重后的清单（同名条目只留第一条，`kind` 以第一条为准）。 */
export function dedupedManifest(): ManifestEntry[] {
  const seen = new Set<string>();
  const out: ManifestEntry[] = [];
  for (const entry of LAYOUT_MANIFEST) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}
