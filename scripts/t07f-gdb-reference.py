# T07f 的独立对照实现（GDB 侧）：file（页缓存里的 folio/page）→ bio（bio_vec 数据段）
# → request（blk-mq 请求，`tag` 就是请求 ID）→ 请求私有区 virtblk_req（设备看到的头）
# → request_queue / blk_mq_hw_ctx（`queue_num`）→ virtio_blk.vqs[] → virtqueue（vring）
# → vring_desc 描述符链 → 设备请求（out_hdr/in_hdr）。
#
# **本文件是从 `t07d-gdb-reference.py` 演化来的**：T07d 的那段说明（下面）与它的全部
# 辅助函数（常量、字节读取、XArray 遍历、fd 表、file/dentry/inode/super_block/
# address_space/page 读取、vmemmap 推导）在本文件里**逐字沿用**，理由与取舍不再重复。
# 只有三处不同：顶部的输入占位符换成了 T07f 的、新增了 I/O 这一层的读取函数、文件末尾
# 的入口换成了 `t07f_main()`（T07d 的 `main()` 留在文件里当历史参考，**不会被调用**，
# 真要重跑 T07d 的对照请用 `t07d-gdb-reference.py` 那一份）。
#
# 为什么 I/O 这一层也必须在 GDB 里独立再读一遍：这里的每一处"关联"都能给出一个
# **看起来完全正常的错答案**。`rq->tag` 是个小整数，偏移读错也能得到一个"像模像样"的
# 请求号；PDU 是 `blk_mq_rq_to_pdu(rq) = rq + sizeof(struct request)`，`sizeof` 少算
# 16 字节，读到的 `out_hdr.type` 仍然是 0/1/4 里的一个合法值；`struct virtqueue` 是
# `struct vring_virtqueue` 的**第一个成员**（两者同址），把 `vq->split.vring` 读成
# "vq 里的一个指针"还是"vq 偏移处内嵌的 `struct vring`"，两种都读得出来，只是
# desc/avail/used 三个地址会整体错开；而"这个描述符槽属于哪个请求"唯一权威的答案是
# `split.desc_state[head].data`（`virtqueue_add_split()` 写入、`detach_buf_split()` 清空），
# 靠描述符里的地址反推只是旁证。这些错都只有让**另一套独立实现**读同一份内存、
# 再逐字段比，才抓得住。
#
# 与前一份一样：类型/偏移/宽度全部现场问 GDB 的 DWARF；描述符链、bio 链、XArray 都由
# 本脚本自己走；`desc_state` 的 token 本脚本自己摘；`bio_vec.bv_page` 到页框号、页的
# `mapping`/`index` 也由本脚本自己从 vmemmap 现场解，不抄我方解析器的结论。
#
# 结果写成 JSON 文件（不靠解析控制台文本），路径与输入由 Node 侧生成后 source 进来。
#
# 用法：gdb 里 `source t07f-gdb-reference.py`；输出路径与输入写在下面的占位符里。
#
# ---------------------------------------------------------------------------
# 以下是 T07d 那份的原始说明（本文件沿用了它的全部辅助函数）
# ---------------------------------------------------------------------------
#
# T07d 的独立对照实现（GDB 侧）：files_struct → fdtable → file → path/dentry/inode
# → address_space/i_pages（XArray）→ struct page。
#
# 为什么要在 GDB 里再实现一遍：文件这一层最容易出的错，是**读出一个看起来完全正常的
# 错答案**。`files->fdtab`（内嵌那份）在扩容之后就是陈旧数据，读它能得到一张"合法但过时"
# 的 fd 表；XArray 的条目编码（值条目 `<<1`、内部条目 `<<2`、节点是"减 2"）只要错一处，
# 取出来的页指针仍然落在 vmemmap 里、仍然能解出一页；`file->f_pos` 与 `inode->i_size`
# 都是 loff_t，读成 4 字节会得到一个"像模像样"的小数字。唯一能抓住这类错的办法，
# 是让**另一套独立实现**读同一份内存再逐字段比。这里的"独立"体现在五处：
#
# 1. **类型、偏移、宽度全部来自 GDB 自己的 DWARF 解释**（`sizeof(struct file)`、
#    `&((struct dentry *)0)->d_name`、`sizeof(((struct qstr *)0)->len)`），而不是我方
#    生成的布局 JSON —— 特别是 `struct fdtable` 的 `rcu` 是内嵌结构（16 字节）而不是指针，
#    这类"名字看着像指针、其实是结构"的字段只有按 DWARF 的宽度读才不会踩。
# 2. **`current` 取自 CPU 寄存器 `%gs` + `pcpu_hot.current_task`**，而不是我方解析器
#    用的 `__per_cpu_offset[0]` 数组；`task->files` 也是从这里出发，而不是我方给的提示值。
# 3. **XArray 的遍历由本脚本自己重写**：从 `xa_head` 出发、按 `node->shift` 逐级下降、
#    判兄弟条目、判 retry/zero/错误条目，不调用我方任何代码。
# 4. **名字的内嵌/外部按"指针是否等于 `&dentry->d_iname`"判**（内核 `dname_external()`
#    的同一判据），而不是按长度猜。
# 5. **页的标志位名字取自 `gdb.parse_and_eval('PG_dirty')` 这类 DWARF 枚举常量**，
#    而不是我方 `PAGE_FLAG_NAMES` 那张写死的表。
#
# 直映射与 vmemmap 基址都不抄常量：直映射偏移由 `mm->pgd - CR3` 现场解（本内核
# `CONFIG_DYNAMIC_MEMORY_LAYOUT=n`，所以那是一个编译期常量），vmemmap 基址由 `mem_section`
# 的 `section_mem_map` 现场解（推导链见 `resolve_vmemmap()`）。解不出来就如实报告。
#
# 结果写成 JSON 文件（不靠解析控制台文本），脚本由 Node 侧生成路径后 source 进来。
#
# 用法：gdb 里 `source t07d-gdb-reference.py`；输出路径与输入参数写在文件顶部的占位符里。

import json
import traceback

import gdb

OUT_PATH = __OUT_PATH__
# 我方解析器读到的 `struct request` 地址（0 表示不给）。
REQUEST_HINT = __REQUEST__
# 我方解析器读到的请求私有区（`virtblk_req`）地址（0 表示按 `rq + sizeof(struct request)` 自己算）。
PDU_HINT = __PDU__
# 我方解析器用 `get_virtio_blk_vq()` 那条路径解出的 `virtqueue` 地址（0 表示不给，按队列自己找）。
VQ_HINT = __VQ__
# 我方解析器读到的 `struct file` 地址（0 表示不给）。
FILE_HINT = __FILE__
# 我方解析器读到的 address_space 地址（0 表示不给，按 file 自己找）。
MAPPING_HINT = __MAPPING__
# 停点关心的那个文件页在页缓存里的下标（-1 表示不专门取一页）。
PAGE_INDEX_HINT = __PAGE_INDEX__

MASK64 = (1 << 64) - 1
ULONG_MAX = (1 << 64) - 1
# `include/linux/xarray.h`：`XA_CHUNK_SHIFT = IS_ENABLED(CONFIG_BASE_SMALL) ? 4 : 6`。
# 本内核没开 CONFIG_BASE_SMALL，所以是 6；这个事实由 Node 侧重解析源码对账。
XA_CHUNK_SHIFT = 6
XA_CHUNK_SIZE = 1 << XA_CHUNK_SHIFT
XA_CHUNK_MASK = XA_CHUNK_SIZE - 1
XA_MAX_MARKS = 3
# `xa_is_node()` 的分界：内部条目里数值大于 4096 的才是节点指针。
XA_NODE_MIN = 4096
# 稀疏内存：一个 section 覆盖 2^27 字节，页框号右移 15 位就是 section 号。
PFN_SECTION_SHIFT_FALLBACK = 15
# `SECTION_MAP_MASK = ~(BIT(SECTION_MAP_LAST_BIT) - 1)`，ZONE_DEVICE 关闭时是 ~0xF。
SECTION_MAP_MASK = MASK64 & ~0xF
PAGE_MAPPING_ANON = 0x1
PAGE_MAPPING_FLAGS = 0x3
MAX_PATH_DEPTH = 64
MAX_XA_NODES = 4096
MAX_XA_ENTRIES = 512
# `dentry` 上"我是不是挂载点"的那一位（include/linux/dcache.h）。
DCACHE_MOUNTED = 1 << 16

# `enum pageflags` 的名字（include/linux/page-flags.h）；**位号交给 GDB 求值**，
# 于是"第几位叫什么"这个事实来自编译器产物，不是我抄的表。
PAGE_FLAG_NAMES = [
    'PG_locked', 'PG_writeback', 'PG_referenced', 'PG_uptodate', 'PG_dirty',
    'PG_lru', 'PG_head', 'PG_waiters', 'PG_active', 'PG_workingset',
    'PG_owner_priv_1', 'PG_owner_2', 'PG_arch_1', 'PG_reserved', 'PG_private',
    'PG_private_2', 'PG_reclaim', 'PG_swapbacked', 'PG_unevictable', 'PG_mlocked',
    'PG_arch_2',
]
# `enum pagetype`（page-flags.h）：`page_type` 的高 8 位。它不在 DWARF 里，只能写下来，
# 由 Node 侧与源码对账。`PGTY_table`/`PGTY_buddy` 是页缓存里最常出现的两个。
PAGE_TYPE_NAMES = {
    0xF0: 'PGTY_buddy', 0xF1: 'PGTY_offline', 0xF2: 'PGTY_table', 0xF3: 'PGTY_guard',
    0xF4: 'PGTY_hugetlb', 0xF5: 'PGTY_slab', 0xF6: 'PGTY_zsmalloc',
    0xF7: 'PGTY_unaccepted', 0xFF: 'PGTY_mapcount_underflow',
}
# `include/uapi/asm-generic/fcntl.h` 的 `O_*`（x86_64 没有自己的 arch 覆盖）。
# 访问模式不是位（`O_ACCMODE = 00000003`），所以它单独放。
O_FLAG_TABLE = [
    ('O_CREAT', 0o0000100), ('O_EXCL', 0o0000200), ('O_NOCTTY', 0o0000400),
    ('O_TRUNC', 0o0001000), ('O_APPEND', 0o0002000), ('O_NONBLOCK', 0o0004000),
    ('O_DSYNC', 0o0010000), ('FASYNC', 0o0020000), ('O_DIRECT', 0o0040000),
    ('O_LARGEFILE', 0o0100000), ('O_DIRECTORY', 0o0200000), ('O_NOFOLLOW', 0o0400000),
    ('O_NOATIME', 0o1000000), ('O_CLOEXEC', 0o2000000), ('__O_SYNC', 0o4000000),
    ('O_PATH', 0o10000000), ('__O_TMPFILE', 0o20000000),
]
O_COMPOSITE_TABLE = [
    ('O_SYNC', 0o4000000 | 0o0010000), ('O_TMPFILE', 0o20000000 | 0o0200000),
    ('O_NDELAY', 0o0004000),
]
O_ACCESS_MODES = {0o0: 'O_RDONLY', 0o1: 'O_WRONLY', 0o2: 'O_RDWR'}
O_ACCMODE = 0o3
# "哪些位已经在上面两张表里认领过"必须按**按位或**算，不能 `sum()`：
# 求和会让低位互相进位，反手把某个已经认领的位抹掉。实测 f_flags = O_LARGEFILE
# （0o0100000）时，这些值加起来恰好进位到第 16 位，于是 `flags & ~sum(...)`
# 把已经认领的 O_LARGEFILE 报成了"未知位"—— 一个纯粹的算术假象。
O_KNOWN_BITS = 0
for _o_name, _o_value in O_FLAG_TABLE:
    O_KNOWN_BITS |= _o_value
for _o_name, _o_value in O_COMPOSITE_TABLE:
    O_KNOWN_BITS |= _o_value
# `include/linux/fs.h` 的 `FMODE_*`（`(1 << n)`）；bit 8 与 13 在 6.12 里是空的。
FMODE_NAMES = [
    (0, 'FMODE_READ'), (1, 'FMODE_WRITE'), (2, 'FMODE_LSEEK'), (3, 'FMODE_PREAD'),
    (4, 'FMODE_PWRITE'), (5, 'FMODE_EXEC'), (6, 'FMODE_WRITE_RESTRICTED'),
    (7, 'FMODE_CAN_ATOMIC_WRITE'), (9, 'FMODE_32BITHASH'), (10, 'FMODE_64BITHASH'),
    (11, 'FMODE_NOCMTIME'), (12, 'FMODE_RANDOM'), (14, 'FMODE_PATH'),
    (15, 'FMODE_ATOMIC_POS'), (16, 'FMODE_WRITER'), (17, 'FMODE_CAN_READ'),
    (18, 'FMODE_CAN_WRITE'), (19, 'FMODE_OPENED'), (20, 'FMODE_CREATED'),
    (21, 'FMODE_STREAM'), (22, 'FMODE_CAN_ODIRECT'), (23, 'FMODE_NOREUSE'),
    (24, 'FMODE_BACKING'), (25, 'FMODE_NONOTIFY'), (26, 'FMODE_NONOTIFY_PERM'),
    (27, 'FMODE_NOWAIT'), (28, 'FMODE_NEED_UNMOUNT'), (29, 'FMODE_NOACCOUNT'),
]
FMODE_KNOWN_BITS = 0
for _fm_bit, _fm_name in FMODE_NAMES:
    FMODE_KNOWN_BITS |= 1 << _fm_bit
# `I_*` 的位号（include/linux/fs.h）。前三位是"等地址"用的，位号不能改。
INODE_STATE_NAMES = [
    (0, 'I_NEW'), (1, 'I_SYNC'), (2, 'I_LRU_ISOLATING'), (3, 'I_DIRTY_SYNC'),
    (4, 'I_DIRTY_DATASYNC'), (5, 'I_DIRTY_PAGES'), (6, 'I_WILL_FREE'), (7, 'I_FREEING'),
    (8, 'I_CLEAR'), (9, 'I_REFERENCED'), (10, 'I_LINKABLE'), (11, 'I_DIRTY_TIME'),
    (12, 'I_WB_SWITCH'), (13, 'I_OVL_INUSE'), (14, 'I_CREATING'), (15, 'I_DONTCACHE'),
    (16, 'I_SYNC_QUEUED'), (17, 'I_PINNING_NETFS_WB'),
]
# `d_flags` 的单位位表；bit 20..22 是 `DCACHE_ENTRY_TYPE` 这个三位字段，不在这里。
DENTRY_FLAG_NAMES = [
    (0, 'DCACHE_OP_HASH'), (1, 'DCACHE_OP_COMPARE'), (2, 'DCACHE_OP_REVALIDATE'),
    (3, 'DCACHE_OP_DELETE'), (4, 'DCACHE_OP_PRUNE'), (5, 'DCACHE_DISCONNECTED'),
    (6, 'DCACHE_REFERENCED'), (7, 'DCACHE_DONTCACHE'), (8, 'DCACHE_CANT_MOUNT'),
    (9, 'DCACHE_GENOCIDE'), (10, 'DCACHE_SHRINK_LIST'), (11, 'DCACHE_OP_WEAK_REVALIDATE'),
    (12, 'DCACHE_NFSFS_RENAMED'), (14, 'DCACHE_FSNOTIFY_PARENT_WATCHED'),
    (15, 'DCACHE_DENTRY_KILLED'), (16, 'DCACHE_MOUNTED'), (17, 'DCACHE_NEED_AUTOMOUNT'),
    (18, 'DCACHE_MANAGE_TRANSIT'), (19, 'DCACHE_LRU_LIST'), (25, 'DCACHE_NOKEY_NAME'),
    (26, 'DCACHE_OP_REAL'), (28, 'DCACHE_PAR_LOOKUP'), (29, 'DCACHE_DENTRY_CURSOR'),
    (30, 'DCACHE_NORCU'),
]
DENTRY_ENTRY_TYPES = {n: name for n, name in enumerate([
    'DCACHE_MISS_TYPE', 'DCACHE_WHITEOUT_TYPE', 'DCACHE_DIRECTORY_TYPE',
    'DCACHE_AUTODIR_TYPE', 'DCACHE_REGULAR_TYPE', 'DCACHE_SPECIAL_TYPE',
    'DCACHE_SYMLINK_TYPE',
])}
# `S_IFMT` 的四类高位（include/uapi/linux/stat.h，是 #define 不是枚举）。
S_IFMT = 0o170000
INODE_FILE_TYPES = {
    0o010000: 'S_IFIFO', 0o020000: 'S_IFCHR', 0o040000: 'S_IFDIR', 0o060000: 'S_IFBLK',
    0o100000: 'S_IFREG', 0o120000: 'S_IFLNK', 0o140000: 'S_IFSOCK',
}
# `MINORBITS = 20`（include/linux/kdev_t.h）。
MINORBITS = 20


def u64(value):
    """把 GDB 交回来的整数归一成**无符号 64 位**（理由见 T07b 的同一函数）。"""
    return value & MASK64


def mem_bytes(address, length):
    return gdb.selected_inferior().read_memory(int(address), int(length)).tobytes()


def u64_at(address):
    return int.from_bytes(mem_bytes(address, 8), byteorder='little', signed=False)


def u32_at(address):
    return int.from_bytes(mem_bytes(address, 4), byteorder='little', signed=False)


def u16_at(address):
    return int.from_bytes(mem_bytes(address, 2), byteorder='little', signed=False)


def u8_at(address):
    return mem_bytes(address, 1)[0]


def s64_at(address):
    return int.from_bytes(mem_bytes(address, 8), byteorder='little', signed=True)


def off(type_name, field_path):
    """字段偏移，由 GDB 按自己的 DWARF 算（编译期常量，不读内存）。"""
    return int(gdb.parse_and_eval('(unsigned long)&((struct %s *)0)->%s' % (type_name, field_path)))


def size_of(type_name):
    return int(gdb.parse_and_eval('sizeof(struct %s)' % type_name))


def member_bytes(type_name, member):
    """成员的字节宽度（数组则取整个数组的宽度，用来除以元素宽度得到个数）。"""
    return int(gdb.parse_and_eval('sizeof(((struct %s *)0)->%s)' % (type_name, member)))


def field_width(type_name, field_path):
    """字段自己的宽度。**不能一律当 8 字节读**：`i_blkbits` 是 1 字节、`i_mode` 是 2 字节、
    `s_dev` 是 4 字节，一律读 8 字节等于把自己和邻居拼成一个怪数。"""
    return int(gdb.parse_and_eval(
        'sizeof(((struct %s *)0)->%s)' % (type_name, field_path)))


def safe(read, default=None):
    try:
        return read()
    except Exception:
        return default


def sym(name):
    """符号地址（内核链接地址）；符号不存在时给 None，不拿 0 冒充。"""
    return safe(lambda: u64(int(gdb.parse_and_eval('(unsigned long)&%s' % name))))


def read_signed(address, width):
    return int.from_bytes(mem_bytes(address, width), byteorder='little', signed=True)


def read_unsigned(address, width):
    return int.from_bytes(mem_bytes(address, width), byteorder='little', signed=False)


def cstring(address, max_length):
    """读到结尾 0 或上限为止；上限是防止偏移错了之后变成一次无界扫描。"""
    data = mem_bytes(address, max_length)
    zero = data.find(b'\x00')
    raw = data if zero < 0 else data[:zero]
    return raw.decode('utf-8', 'replace'), (zero < 0)


def describe_device(dev):
    return '%d:%d' % (dev >> MINORBITS, dev & ((1 << MINORBITS) - 1))


def dwarf_layout():
    """本脚本用到的全部偏移与宽度，一律现场问 GDB。"""
    return {
        'sizes': {
            'files_struct': size_of('files_struct'),
            'fdtable': size_of('fdtable'),
            'file': size_of('file'),
            'path': size_of('path'),
            'vfsmount': size_of('vfsmount'),
            'dentry': size_of('dentry'),
            'qstr': size_of('qstr'),
            'inode': size_of('inode'),
            'super_block': size_of('super_block'),
            'xarray': size_of('xarray'),
            'xa_node': size_of('xa_node'),
            'address_space': size_of('address_space'),
            'page': size_of('page'),
            'folio': safe(lambda: size_of('folio')),
            'mem_section': safe(lambda: size_of('mem_section')),
        },
        'files': {
            'count': off('files_struct', 'count'),
            'fdt': off('files_struct', 'fdt'),
            'fdtab': off('files_struct', 'fdtab'),
            'next_fd': off('files_struct', 'next_fd'),
            'resize_in_progress': safe(lambda: off('files_struct', 'resize_in_progress')),
            'open_fds_init': off('files_struct', 'open_fds_init'),
            'close_on_exec_init': off('files_struct', 'close_on_exec_init'),
            'full_fds_bits_init': off('files_struct', 'full_fds_bits_init'),
            'fd_array': off('files_struct', 'fd_array'),
            # `NR_OPEN_DEFAULT` 与"位图一个字多少位"都由 DWARF 的宽度算出来，不写死 64。
            'nr_open_default': member_bytes('files_struct', 'fd_array') // 8,
            'word_bytes': member_bytes('files_struct', 'open_fds_init'),
        },
        'fdtable': {
            'max_fds': off('fdtable', 'max_fds'),
            'fd': off('fdtable', 'fd'),
            'close_on_exec': off('fdtable', 'close_on_exec'),
            'open_fds': off('fdtable', 'open_fds'),
            'full_fds_bits': off('fdtable', 'full_fds_bits'),
            'rcu': off('fdtable', 'rcu'),
        },
        'file': {
            'f_count': off('file', 'f_count'),
            'f_lock': off('file', 'f_lock'),
            'f_mode': off('file', 'f_mode'),
            'f_op': off('file', 'f_op'),
            'f_mapping': off('file', 'f_mapping'),
            'private_data': off('file', 'private_data'),
            'f_inode': off('file', 'f_inode'),
            'f_flags': off('file', 'f_flags'),
            'f_iocb_flags': off('file', 'f_iocb_flags'),
            'f_cred': off('file', 'f_cred'),
            'f_path': off('file', 'f_path'),
            'f_pos': off('file', 'f_pos'),
            'f_security': safe(lambda: off('file', 'f_security')),
            'f_wb_err': safe(lambda: off('file', 'f_wb_err')),
            'f_ra_start': safe(lambda: off('file', 'f_ra.start')),
            'f_ra_ra_pages': safe(lambda: off('file', 'f_ra.ra_pages')),
        },
        'path': {
            'mnt': off('path', 'mnt'),
            'dentry': off('path', 'dentry'),
        },
        'vfsmount': {
            'mnt_root': off('vfsmount', 'mnt_root'),
            'mnt_sb': off('vfsmount', 'mnt_sb'),
            'mnt_flags': off('vfsmount', 'mnt_flags'),
        },
        'dentry': {
            'd_flags': off('dentry', 'd_flags'),
            'd_parent': off('dentry', 'd_parent'),
            'd_name': off('dentry', 'd_name'),
            'd_inode': off('dentry', 'd_inode'),
            'd_iname': off('dentry', 'd_iname'),
            'd_op': off('dentry', 'd_op'),
            'd_sb': off('dentry', 'd_sb'),
            'd_iname_bytes': member_bytes('dentry', 'd_iname'),
        },
        'qstr': {
            'hash': off('qstr', 'hash'),
            'len': off('qstr', 'len'),
            'hash_len': safe(lambda: off('qstr', 'hash_len')),
            'name': off('qstr', 'name'),
            'len_width': field_width('qstr', 'len'),
        },
        'inode': {
            'i_mode': off('inode', 'i_mode'),
            'i_uid': off('inode', 'i_uid'),
            'i_gid': off('inode', 'i_gid'),
            'i_flags': off('inode', 'i_flags'),
            'i_ino': off('inode', 'i_ino'),
            'i_nlink': off('inode', 'i_nlink'),
            'i_rdev': off('inode', 'i_rdev'),
            'i_size': off('inode', 'i_size'),
            'i_atime_sec': safe(lambda: off('inode', 'i_atime_sec')),
            'i_mtime_sec': safe(lambda: off('inode', 'i_mtime_sec')),
            'i_ctime_sec': safe(lambda: off('inode', 'i_ctime_sec')),
            'i_bytes': off('inode', 'i_bytes'),
            'i_blkbits': off('inode', 'i_blkbits'),
            'i_write_hint': safe(lambda: off('inode', 'i_write_hint')),
            'i_blocks': off('inode', 'i_blocks'),
            'i_state': off('inode', 'i_state'),
            'i_count': off('inode', 'i_count'),
            'i_dio_count': safe(lambda: off('inode', 'i_dio_count')),
            'i_writecount': safe(lambda: off('inode', 'i_writecount')),
            'i_sb': off('inode', 'i_sb'),
            'i_mapping': off('inode', 'i_mapping'),
            'i_op': off('inode', 'i_op'),
            'i_fop': off('inode', 'i_fop'),
            'i_private': off('inode', 'i_private'),
            'i_mode_width': field_width('inode', 'i_mode'),
            'i_size_width': field_width('inode', 'i_size'),
            'i_blkbits_width': field_width('inode', 'i_blkbits'),
        },
        'super_block': {
            's_dev': off('super_block', 's_dev'),
            's_blocksize': off('super_block', 's_blocksize'),
            's_blocksize_bits': off('super_block', 's_blocksize_bits'),
            's_maxbytes': off('super_block', 's_maxbytes'),
            's_type': off('super_block', 's_type'),
            's_op': off('super_block', 's_op'),
            's_flags': off('super_block', 's_flags'),
            's_magic': off('super_block', 's_magic'),
            's_root': off('super_block', 's_root'),
            's_count': off('super_block', 's_count'),
            's_active': off('super_block', 's_active'),
            's_id': off('super_block', 's_id'),
            's_id_bytes': member_bytes('super_block', 's_id'),
            's_dev_width': field_width('super_block', 's_dev'),
        },
        'xarray': {
            'xa_flags': off('xarray', 'xa_flags'),
            'xa_head': off('xarray', 'xa_head'),
        },
        'xa_node': {
            'shift': off('xa_node', 'shift'),
            'offset': off('xa_node', 'offset'),
            'count': off('xa_node', 'count'),
            'nr_values': safe(lambda: off('xa_node', 'nr_values')),
            'parent': off('xa_node', 'parent'),
            'array': off('xa_node', 'array'),
            'slots': off('xa_node', 'slots'),
            'marks': safe(lambda: off('xa_node', 'marks')),
        },
        'address_space': {
            'host': off('address_space', 'host'),
            'i_pages': off('address_space', 'i_pages'),
            'nrpages': off('address_space', 'nrpages'),
            'writeback_index': off('address_space', 'writeback_index'),
            'a_ops': off('address_space', 'a_ops'),
            'flags': off('address_space', 'flags'),
            'gfp_mask': off('address_space', 'gfp_mask'),
            'i_mmap_writable': off('address_space', 'i_mmap_writable'),
            'i_private_data': safe(lambda: off('address_space', 'i_private_data')),
        },
        'folio': {
            'flags': safe(lambda: off('folio', 'flags')),
            'mapping': safe(lambda: off('folio', 'mapping')),
            'index': safe(lambda: off('folio', 'index')),
            'page': safe(lambda: off('folio', 'page')),
            'mapcount': safe(lambda: off('folio', '_mapcount')),
            'refcount': safe(lambda: off('folio', '_refcount')),
            'nr_pages': safe(lambda: off('folio', '_folio_nr_pages')),
            'page_type_via_page': safe(lambda: off('folio', 'page.page_type')),
        },
        'page': {
            'flags': off('page', 'flags'),
            'mapping': off('page', 'mapping'),
            'index': off('page', 'index'),
            'compound_head': off('page', 'compound_head'),
            'page_type': off('page', 'page_type'),
            'mapcount': off('page', '_mapcount'),
            'refcount': off('page', '_refcount'),
        },
        'mem_section': {
            'section_mem_map': safe(lambda: off('mem_section', 'section_mem_map')),
        },
    }

# ---------------------------------------------------------------------------
# XArray：本脚本自己重写一遍遍历（不调用我方任何代码）
# ---------------------------------------------------------------------------

def xa_is_internal(entry):
    return (entry & 3) == 2


def xa_is_value(entry):
    return (entry & 1) == 1


def xa_is_node(entry):
    """内部条目且数值大于 4096：小于它的都是兄弟/retry/zero 这些小值。"""
    return xa_is_internal(entry) and entry > XA_NODE_MIN


def xa_to_node(entry):
    """源码就是"减 2"，不是"按 ~3 抹掉低位"。"""
    return entry - 2


def xa_to_value(entry):
    """6.12 的 `xa_to_value` 是 `>> 1`（`xa_mk_value(v) = (v << 1) | 1`），**不是 `>> 2`**。"""
    return entry >> 1


def xa_to_internal(entry):
    return entry >> 2


def xa_mk_internal(value):
    return (((value & MASK64) << 2) | 2) & MASK64


XA_RETRY_ENTRY = xa_mk_internal(256)
XA_ZERO_ENTRY = xa_mk_internal(257)
XA_MAX_ERRNO_ENTRY = xa_mk_internal(u64(-4095))
XA_SIBLING_MAX = (XA_CHUNK_MASK << 2) | 2


def xa_is_sibling(entry):
    return xa_is_internal(entry) and entry < XA_SIBLING_MAX


def xa_is_retry(entry):
    return entry == XA_RETRY_ENTRY


def xa_is_zero(entry):
    return entry == XA_ZERO_ENTRY


def xa_is_err(entry):
    return xa_is_internal(entry) and entry >= XA_MAX_ERRNO_ENTRY


def xa_err(entry):
    """错误条目里的 errno（C 里是 `(long)entry >> 2`，带符号右移）。"""
    if not xa_is_err(entry):
        return 0
    signed = entry - (1 << 64) if entry >= (1 << 63) else entry
    return signed >> 2


def describe_xa_entry(entry):
    if entry == XA_ZERO_ENTRY:
        return 'zero'
    if entry == XA_RETRY_ENTRY:
        return 'retry'
    if xa_is_value(entry):
        return 'value'
    if xa_is_internal(entry):
        return 'error' if xa_err(entry) != 0 else 'internal-unknown'
    return 'pointer'


def read_xa_node(layout, address):
    node = layout['xa_node']
    slots = [u64_at(address + node['slots'] + slot * 8) for slot in range(XA_CHUNK_SIZE)]
    marks = []
    if node['marks'] is not None:
        marks = [u64_at(address + node['marks'] + mark * 8) for mark in range(XA_MAX_MARKS)]
    return {
        'address': address,
        'shift': u8_at(address + node['shift']),
        'offset': u8_at(address + node['offset']),
        'count': u8_at(address + node['count']),
        'nrValues': u8_at(address + node['nr_values']) if node['nr_values'] is not None else None,
        'parent': u64_at(address + node['parent']),
        'array': u64_at(address + node['array']),
        'slots': slots,
        'marks': marks,
    }


def walk_xarray(layout, array_address, max_entries=MAX_XA_ENTRIES):
    """把 `struct xarray` 的条目走一遍（限定遍历，见 T07c 里同一取舍）。

    三处与"直接读数组"不同的地方：`xa_head` 为 0 表示整个数组空；`xa_head` 不是节点时
    它**本身就是下标 0 的条目**；逐级下降用的是 `node->shift` 的台阶，而不是"第几层"的计数。
    """
    xa = layout['xarray']
    head = u64_at(array_address + xa['xa_head'])
    out = {
        'address': array_address,
        'xaFlags': u32_at(array_address + xa['xa_flags']),
        'head': head,
        'entries': [],
        'nodeAddresses': [],
        'violations': [],
        'notes': [],
    }

    def entry_record(index, raw, node, shift, slot, span, kind=None):
        kind = kind or describe_xa_entry(raw)
        return {
            'index': index,
            'raw': raw,
            'kind': kind,
            'value': xa_to_value(raw) if xa_is_value(raw) else None,
            'pointer': raw if kind == 'pointer' else None,
            'errno': xa_err(raw) if kind == 'error' else None,
            'node': node,
            'slot': slot,
            'shift': shift,
            'span': span,
        }

    if head == 0:
        out['headKind'] = 'empty'
        out['rootShift'] = None
        out['notes'].append('xa_head 为 0：整个数组是空的（不是"下标 0 是空"）')
        return out
    if not xa_is_node(head):
        out['headKind'] = 'single-entry'
        out['rootShift'] = 0
        out['notes'].append('xa_head 不是节点：它本身就是下标 0 的条目')
        out['entries'].append(entry_record(0, head, None, None, None, 1))
        return out

    root = read_xa_node(layout, xa_to_node(head))
    out['headKind'] = 'node'
    out['rootShift'] = root['shift']
    seen = set()

    def descend(node, base_index):
        key = node['address']
        if key in seen:
            out['violations'].append('节点 0x%x 被访问了两次：树的链接里有环' % key)
            return
        seen.add(key)
        out['nodeAddresses'].append(key)
        if len(out['nodeAddresses']) > MAX_XA_NODES:
            out['notes'].append('节点数超过上限 %d' % MAX_XA_NODES)
            return
        siblings = {}
        for slot in range(XA_CHUNK_SIZE):
            raw = node['slots'][slot]
            if raw == 0 or not xa_is_sibling(raw):
                continue
            owner = xa_to_internal(raw)
            siblings[owner] = siblings.get(owner, 0) + 1
        for slot in range(XA_CHUNK_SIZE):
            raw = node['slots'][slot]
            if raw == 0 or xa_is_sibling(raw):
                continue
            index = base_index | (slot << node['shift'])
            span = (1 + siblings.get(slot, 0)) << node['shift']
            if xa_is_node(raw):
                child = read_xa_node(layout, xa_to_node(raw))
                if child['shift'] != node['shift'] - XA_CHUNK_SHIFT:
                    out['violations'].append(
                        '节点 0x%x 的 shift=%d，按父节点（shift=%d）算应当是 %d'
                        % (child['address'], child['shift'], node['shift'], node['shift'] - XA_CHUNK_SHIFT))
                if child['array'] != array_address:
                    out['violations'].append(
                        '节点 0x%x 的 array 字段是 0x%x，不是被查的 XArray 0x%x'
                        % (child['address'], child['array'], array_address))
                descend(child, index)
                continue
            if len(out['entries']) >= max_entries:
                out['notes'].append('条目数达到上限 %d，停止遍历' % max_entries)
                return
            out['entries'].append(entry_record(index, raw, node['address'], node['shift'], slot, span))

    descend(root, 0)
    return out


def read_xarray_entry(layout, array_address, index):
    """`xas_load()` 的等价物：逐级下降取一个下标，并把每一步记下来。"""
    xa = layout['xarray']
    head = u64_at(array_address + xa['xa_head'])
    out = {'address': array_address, 'index': index, 'steps': [], 'violations': []}
    if head == 0:
        out.update({'present': False, 'kind': 'absent', 'reason': 'xa_head 为 0：整个数组是空的'})
        return out
    if not xa_is_node(head):
        if index != 0:
            out.update({'present': False, 'kind': 'absent', 'reason': '只有下标 0 可能有条目'})
            return out
        kind = describe_xa_entry(head)
        out.update({'present': kind not in ('retry', 'zero'), 'kind': kind, 'raw': head,
                    'value': xa_to_value(head) if xa_is_value(head) else None,
                    'pointer': head if kind == 'pointer' else None, 'slot': None, 'node': None})
        return out
    root = read_xa_node(layout, xa_to_node(head))
    if (index >> root['shift']) > XA_CHUNK_MASK:
        out.update({'present': False, 'kind': 'absent', 'inRange': False,
                    'reason': '下标右移根节点的 %d 位后超出 %d 个槽' % (root['shift'], XA_CHUNK_SIZE)})
        return out
    node = root
    steps = 0
    while True:
        steps += 1
        if steps > 8:
            out['violations'].append('下降步数超过 8 步仍未到底：树可能成环')
            break
        slot = (index >> node['shift']) & XA_CHUNK_MASK
        raw = node['slots'][slot]
        hops = 0
        while xa_is_sibling(raw):
            hops += 1
            if hops > XA_CHUNK_SIZE:
                out['violations'].append('兄弟条目链走不出正主')
                break
            slot = xa_to_internal(raw)
            if slot < 0 or slot >= XA_CHUNK_SIZE:
                out['violations'].append('兄弟条目指向越界槽 %d' % slot)
                break
            raw = node['slots'][slot]
        out['steps'].append({'node': node['address'], 'shift': node['shift'], 'slot': slot, 'raw': raw})
        if not xa_is_node(raw) or node['shift'] == 0:
            break
        node = read_xa_node(layout, xa_to_node(raw))
    if raw == 0:
        out.update({'present': False, 'kind': 'absent', 'reason': '叶子槽是空指针'})
        return out
    kind = describe_xa_entry(raw)
    out.update({
        'present': kind not in ('retry', 'zero'),
        'kind': kind,
        'raw': raw,
        'value': xa_to_value(raw) if xa_is_value(raw) else None,
        'pointer': raw if kind == 'pointer' else None,
        'node': node['address'],
        'slot': out['steps'][-1]['slot'],
    })
    return out


# ---------------------------------------------------------------------------
# fd 表
# ---------------------------------------------------------------------------

def read_current(layout):
    """`%gs` 基址 + `pcpu_hot.current_task` 找 current，再取它的 files。"""
    out = {'notes': []}
    gs_base = safe(lambda: u64(int(gdb.parse_and_eval('$gs_base'))))
    pcpu_hot = sym('pcpu_hot')
    out['gsBase'] = gs_base
    out['pcpuHotLink'] = pcpu_hot
    if gs_base is None or pcpu_hot is None:
        out['notes'].append('取不到 %gs 基址或 pcpu_hot 的链接地址，current 无法确定')
        return out
    out['currentTaskOffset'] = off('pcpu_hot', 'current_task')
    current = u64_at(gs_base + pcpu_hot + out['currentTaskOffset'])
    out['current'] = current
    out['pid'] = u32_at(current + off('task_struct', 'pid'))
    text, truncated = cstring(current + off('task_struct', 'comm'), 16)
    out['comm'] = text
    out['commTruncated'] = truncated
    out['filesOffset'] = off('task_struct', 'files')
    out['filesAddress'] = u64_at(current + out['filesOffset'])
    return out


def read_files(layout, address):
    f = layout['files']
    record = {
        'address': address,
        'count': u32_at(address + f['count']),
        'nextFd': u32_at(address + f['next_fd']),
        'resizeInProgress': (u8_at(address + f['resize_in_progress'])
                             if f['resize_in_progress'] is not None else None),
        'fdt': u64_at(address + f['fdt']),
        'inlineFdtableAddress': address + f['fdtab'],
        'inlineArrays': {
            'fdArray': address + f['fd_array'],
            'openFds': address + f['open_fds_init'],
            'closeOnExec': address + f['close_on_exec_init'],
            'fullFdsBits': address + f['full_fds_bits_init'],
        },
        'fdArrayCount': f['nr_open_default'],
        'wordBytes': f['word_bytes'],
    }
    record['inlineFdtable'] = record['fdt'] == record['inlineFdtableAddress']
    return record


def read_fdtable(layout, address):
    t = layout['fdtable']
    return {
        'address': address,
        'maxFds': u32_at(address + t['max_fds']),
        'fd': u64_at(address + t['fd']),
        'closeOnExec': u64_at(address + t['close_on_exec']),
        'openFds': u64_at(address + t['open_fds']),
        'fullFdsBits': u64_at(address + t['full_fds_bits']),
        # `rcu` 是**内嵌的** `struct callback_head`，这里只报它在表内的偏移与宽度，
        # 绝不把它当指针读（那会读出相邻两个字段的字节拼成的"地址"）。
        'rcuOffset': t['rcu'],
    }


def read_bitmaps(layout, files, fdtable):
    word_bytes = files['wordBytes']
    word_bits = word_bytes * 8
    open_words = (fdtable['maxFds'] + word_bits - 1) // word_bits
    full_words = (max(open_words, 1) + word_bits - 1) // word_bits

    def words(base, count):
        return [read_unsigned(base + index * word_bytes, word_bytes) for index in range(count)]

    open_fds = words(fdtable['openFds'], open_words) if open_words > 0 else []
    close_on_exec = words(fdtable['closeOnExec'], open_words) if open_words > 0 else []
    full_fds_bits = words(fdtable['fullFdsBits'], full_words)
    open_bits = []
    for word_index, word in enumerate(open_fds):
        for bit in range(word_bits):
            if ((word >> bit) & 1) and (word_index * word_bits + bit) < fdtable['maxFds']:
                open_bits.append(word_index * word_bits + bit)
    close_bits = []
    for word_index, word in enumerate(close_on_exec):
        for bit in range(word_bits):
            if ((word >> bit) & 1) and (word_index * word_bits + bit) < fdtable['maxFds']:
                close_bits.append(word_index * word_bits + bit)
    full_words_set = [index for index, word in enumerate(full_fds_bits) if word != 0]
    return {
        'wordBytes': word_bytes,
        'openWords': open_fds,
        'closeOnExecWords': close_on_exec,
        'fullFdsBitsWords': full_fds_bits,
        'openBits': open_bits,
        'closeOnExecBits': close_bits,
        'fullFdsBitsSet': full_words_set,
        'openCount': len(open_bits),
    }


def read_fd_slot(layout, files, fdtable, fd):
    return {
        'fd': fd,
        'inRange': 0 <= fd < fdtable['maxFds'],
        'slotAddress': fdtable['fd'] + fd * 8 if fdtable['fd'] else None,
        'fileAddress': u64_at(fdtable['fd'] + fd * 8) if fdtable['fd'] else None,
    }


# ---------------------------------------------------------------------------
# file / dentry / path / inode / super_block / address_space / page
# ---------------------------------------------------------------------------

def decode_o_flags(flags):
    names = [name for name, value in O_FLAG_TABLE if flags & value]
    composites = [name for name, value in O_COMPOSITE_TABLE if (flags & value) == value]
    raw = flags & O_ACCMODE
    return {
        'names': names,
        'composites': composites,
        'accessMode': O_ACCESS_MODES.get(raw, 'O_ACCMODE(%d)' % raw),
        'accessModeRaw': raw,
        'unknownBits': flags & ~O_KNOWN_BITS,
    }


def decode_fmode(mode):
    return {
        'names': [name for bit, name in FMODE_NAMES if mode & (1 << bit)],
        'unknownBits': mode & ~FMODE_KNOWN_BITS,
    }


def decode_i_state(state):
    return {
        'names': [name for bit, name in INODE_STATE_NAMES if state & (1 << bit)],
        'dirty': (state & 0o70) != 0,
        'dirtyTime': (state & (1 << 11)) != 0,
    }


def decode_dentry_flags(d_flags):
    names = [name for bit, name in DENTRY_FLAG_NAMES if d_flags & (1 << bit)]
    entry_type = (d_flags >> 20) & 0x7
    return {
        'names': names,
        'entryTypeRaw': entry_type << 20,
        'entryTypeName': DENTRY_ENTRY_TYPES.get(entry_type),
        'entryTypeValue': entry_type,
    }


def decode_mode(mode):
    """`i_mode` 的类型 + 权限串（三组权限在 bit 8..6 / 5..3 / 2..0，特殊位在 11/10/9）。"""
    raw_type = mode & S_IFMT
    bits = mode & 0o7777
    special_lower = ['s', 's', 't']
    special_upper = ['S', 'S', 'T']
    chars = []
    for index in range(3):
        triplet = (bits >> (6 - index * 3)) & 0o7
        special = bool(bits & (0o4000 >> index))
        if triplet & 0o4:
            first = 'r'
        else:
            first = '-'
        second = 'w' if triplet & 0o2 else '-'
        if triplet & 0o1:
            third = special_lower[index] if special else 'x'
        else:
            third = special_upper[index] if special else '-'
        chars.append(first + second + third)
    return {
        'type': INODE_FILE_TYPES.get(raw_type, 'unknown(0x%x)' % raw_type),
        'typeRaw': raw_type,
        'specialBits': bits & 0o7000,
        'octal': '%o' % bits,
        'text': ''.join(chars),
    }


def read_file(layout, address):
    f = layout['file']
    path_address = address + f['f_path']
    f_flags = read_unsigned(address + f['f_flags'], field_width('file', 'f_flags'))
    f_mode = read_unsigned(address + f['f_mode'], field_width('file', 'f_mode'))
    record = {
        'address': address,
        'fCount': u64_at(address + f['f_count']),
        'fMode': f_mode,
        'fModeDecoded': decode_fmode(f_mode),
        'fFlags': f_flags,
        'fFlagsDecoded': decode_o_flags(f_flags),
        'fIocbFlags': read_unsigned(address + f['f_iocb_flags'], field_width('file', 'f_iocb_flags')),
        'fPos': s64_at(address + f['f_pos']),
        'fPosWidth': field_width('file', 'f_pos'),
        'fOp': u64_at(address + f['f_op']),
        'fMapping': u64_at(address + f['f_mapping']),
        'privateData': u64_at(address + f['private_data']),
        'fInode': u64_at(address + f['f_inode']),
        'fCred': u64_at(address + f['f_cred']),
        'path': {
            'address': path_address,
            'mnt': u64_at(path_address + layout['path']['mnt']),
            'dentry': u64_at(path_address + layout['path']['dentry']),
        },
        'fRaStart': None,
        'fRaRaPages': None,
    }
    if f['f_ra_start'] is not None:
        record['fRaStart'] = u64_at(address + f['f_ra_start'])
    if f['f_ra_ra_pages'] is not None:
        record['fRaRaPages'] = read_unsigned(address + f['f_ra_ra_pages'], 4)
    if f['f_wb_err'] is not None:
        record['fWbErr'] = read_unsigned(address + f['f_wb_err'], 4)
    return record


def read_dentry(layout, address):
    d = layout['dentry']
    q = layout['qstr']
    name_field = address + d['d_name']
    name_pointer = u64_at(name_field + q['name'])
    inline_address = address + d['d_iname']
    length = read_unsigned(name_field + q['len'], q['len_width'])
    hash_value = read_unsigned(name_field + q['hash'], 4)
    d_flags = read_unsigned(address + d['d_flags'], field_width('dentry', 'd_flags'))
    record = {
        'address': address,
        'dFlags': d_flags,
        'dFlagsDecoded': decode_dentry_flags(d_flags),
        'parent': u64_at(address + d['d_parent']),
        'inode': u64_at(address + d['d_inode']),
        'superBlock': u64_at(address + d['d_sb']),
        'dentryOps': u64_at(address + d['d_op']),
        'nameHash': hash_value,
        'nameLen': length,
        'namePointer': name_pointer,
        'dInameAddress': inline_address,
        'dInameBytes': d['d_iname_bytes'],
        # 内核 `dname_external()` 的同一判据：名字指针是否等于 `&d_iname`。
        'external': (name_pointer != inline_address) if name_pointer != 0 else None,
        'nameText': None,
        'nameUnavailable': None,
    }
    if name_pointer == 0:
        record['nameUnavailable'] = 'd_name.name 是空指针：这个名字这次读不到'
    elif length > 4096:
        record['nameUnavailable'] = 'd_name.len = %d 超过上限 4096 字节' % length
    else:
        try:
            bytes_value = mem_bytes(name_pointer, length)
            record['nameText'] = bytes_value.decode('utf-8', 'replace')
        except Exception as exc:
            record['nameUnavailable'] = '读名字失败: %s' % exc
    record['dNameHashLenBytes'] = mem_bytes(name_field, 8).hex() if q['hash_len'] is not None else None
    return record


def resolve_path(layout, dentry_address):
    components = []
    seen = set()
    cursor = dentry_address
    rooted = False
    cycle = False
    truncated = False
    while cursor not in (0, None):
        if cursor in seen:
            cycle = True
            break
        seen.add(cursor)
        if len(components) >= MAX_PATH_DEPTH:
            truncated = True
            break
        record = read_dentry(layout, cursor)
        components.append(record)
        if record['parent'] == cursor:
            rooted = True
            break
        cursor = record['parent']
    ordered = list(reversed(components))
    names = [record['nameText'] for record in ordered]
    if any(name is None for name in names):
        path = None
    else:
        # 从根数第一级**只有确认它是根时才丢掉名字**：Linux 的根 dentry（`s_root`）名字就是
        # `/`，不是空串；把它当成普通一段拼进去会得到 `///data/hello.txt` —— 看着像条路径，
        # 却和客体 `readlink` 报的对不上。没走到根时第一级是真实目录名，必须保留。
        segments = [
            name for index, name in enumerate(names)
            if not (index == 0 and rooted and name in ('', '/'))
        ]
        path = '/' + '/'.join(segments)
    return {
        'start': dentry_address,
        'path': path,
        'rooted': rooted,
        'cycle': cycle,
        'truncated': truncated,
        'components': ordered,
        'names': names,
    }


def read_inode(layout, address):
    i = layout['inode']
    mode = read_unsigned(address + i['i_mode'], i['i_mode_width'])
    state = read_unsigned(address + i['i_state'], field_width('inode', 'i_state'))
    record = {
        'address': address,
        'mode': mode,
        'modeDecoded': decode_mode(mode),
        'uid': read_unsigned(address + i['i_uid'], field_width('inode', 'i_uid')),
        'gid': read_unsigned(address + i['i_gid'], field_width('inode', 'i_gid')),
        'flags': read_unsigned(address + i['i_flags'], field_width('inode', 'i_flags')),
        'ino': u64_at(address + i['i_ino']),
        'nlink': read_unsigned(address + i['i_nlink'], field_width('inode', 'i_nlink')),
        'rdev': read_unsigned(address + i['i_rdev'], field_width('inode', 'i_rdev')),
        'size': s64_at(address + i['i_size']),
        'sizeWidth': i['i_size_width'],
        'bytes': read_unsigned(address + i['i_bytes'], field_width('inode', 'i_bytes')),
        'blkbits': read_unsigned(address + i['i_blkbits'], i['i_blkbits_width']),
        'blocks': s64_at(address + i['i_blocks']),
        'state': state,
        'stateDecoded': decode_i_state(state),
        'count': read_unsigned(address + i['i_count'], field_width('inode', 'i_count')),
        'dioCount': None,
        'writeCount': None,
        'superBlock': u64_at(address + i['i_sb']),
        'mapping': u64_at(address + i['i_mapping']),
        'inodeOps': u64_at(address + i['i_op']),
        'fops': u64_at(address + i['i_fop']),
        'isPrivate': u64_at(address + i['i_private']),
    }
    record['rdevDecoded'] = describe_device(record['rdev'])
    # 这里的键是我们对外的字段名，值是 DWARF 里的真实成员名 —— 两者不一样（`dioCount`
    # 在源码里叫 `i_dio_count`）。拿对外名去问 GDB，GDB 会说"没有这个成员"，整条 inode
    # 就少一大块，后面的字段比对全成空转。
    for field, member in (('dioCount', 'i_dio_count'), ('writeCount', 'i_writecount'),
                          ('writeHint', 'i_write_hint')):
        offset = i.get(member)
        if offset is None:
            continue
        record[field] = read_signed(address + offset, field_width('inode', member))
    return record


def read_super_block(layout, address):
    s = layout['super_block']
    dev = read_unsigned(address + s['s_dev'], s['s_dev_width'])
    record = {
        'address': address,
        'dev': dev,
        'devDecoded': describe_device(dev),
        'blocksize': u64_at(address + s['s_blocksize']),
        'blocksizeBits': read_unsigned(address + s['s_blocksize_bits'], field_width('super_block', 's_blocksize_bits')),
        'maxbytes': s64_at(address + s['s_maxbytes']),
        'fsType': u64_at(address + s['s_type']),
        'superOps': u64_at(address + s['s_op']),
        'flags': u64_at(address + s['s_flags']),
        'magic': u64_at(address + s['s_magic']),
        'rootDentry': u64_at(address + s['s_root']),
        'count': read_signed(address + s['s_count'], field_width('super_block', 's_count')),
        'active': read_unsigned(address + s['s_active'], field_width('super_block', 's_active')),
    }
    record['id'], record['idTruncated'] = cstring(address + s['s_id'], s['s_id_bytes'])
    return record


def read_address_space(layout, address):
    a = layout['address_space']
    return {
        'address': address,
        'host': u64_at(address + a['host']),
        'pagesAddress': address + a['i_pages'],
        'nrpages': u64_at(address + a['nrpages']),
        'writebackIndex': u64_at(address + a['writeback_index']),
        'aOps': u64_at(address + a['a_ops']),
        'flags': u64_at(address + a['flags']),
        'gfpMask': read_unsigned(address + a['gfp_mask'], 4),
        'mmapWritable': read_signed(address + a['i_mmap_writable'], 4),
        'privateData': u64_at(address + a['i_private_data']) if a['i_private_data'] is not None else None,
    }


def read_page_flags_bits():
    """`enum pageflags` 的位号一律问 GDB（"第几位叫什么"来自 DWARF，不是我抄的表）。"""
    bits = {}
    for name in PAGE_FLAG_NAMES:
        value = safe(lambda name=name: int(gdb.parse_and_eval(name)))
        if value is not None:
            bits[name] = value
    return bits


def read_page_struct(layout, address):
    """按 DWARF 的偏移直读一个 `struct page`（也是 `struct folio` 的前 256 字节）。"""
    page = layout['page']
    folio = layout['folio']
    flags = u64_at(address + page['flags'])
    mapping = u64_at(address + page['mapping'])
    compound_head = u64_at(address + page['compound_head'])
    flags_bits = read_page_flags_bits()
    set_flags = sorted(name for name, bit in flags_bits.items() if flags & (1 << bit))
    page_type = u32_at(address + page['page_type'])
    page_type_code = (page_type >> 24) & 0xFF
    record = {
        'address': address,
        'flags': flags,
        'pageFlags': set_flags,
        'pageFlagBits': flags_bits,
        'compoundHeadRaw': compound_head,
        'isTail': (compound_head & 1) == 1,
        'compoundHeadAddress': (compound_head - 1) if (compound_head & 1) == 1 else None,
        'mapping': mapping,
        'mappingIsAnon': (mapping & PAGE_MAPPING_FLAGS) == PAGE_MAPPING_ANON,
        'mappingIsMovable': (mapping & PAGE_MAPPING_FLAGS) == 2,
        'index': u64_at(address + page['index']),
        'refcount': read_signed(address + page['refcount'], 4),
        'mapcount': read_signed(address + page['mapcount'], 4),
        'pageType': page_type,
        'pageTypeCode': page_type_code,
        'pageTypeName': PAGE_TYPE_NAMES.get(page_type_code),
        'pageTypeHasType': page_type < 0xFF000000,
    }
    if folio['flags'] is not None:
        record['folioNrPages'] = read_unsigned(address + folio['nr_pages'], 4)
    if folio['page_type_via_page'] is not None and folio['page'] is not None:
        record['pageTypeViaFolioPage'] = u32_at(address + folio['page'] + folio['page_type_via_page'])
    return record


def resolve_vmemmap(layout, pfn):
    """用 `mem_section` 现场解出 vmemmap 基址（推导链见 T07c 的同名函数）。"""
    page_size = layout['sizes']['page']
    section_size = layout['sizes']['mem_section']
    out = {'pfn': pfn, 'pageStructSize': page_size, 'memSectionSize': section_size, 'notes': []}
    if not section_size or layout['mem_section']['section_mem_map'] is None:
        out['notes'].append('取不到 sizeof(struct mem_section) 或它的 section_mem_map，vmemmap 解不出来')
        return out
    section_number = pfn >> PFN_SECTION_SHIFT_FALLBACK
    section_start_pfn = section_number << PFN_SECTION_SHIFT_FALLBACK
    sections_per_root = 4096 // section_size
    symbol = sym('mem_section')
    out.update({
        'sectionNumber': section_number,
        'sectionStartPfn': section_start_pfn,
        'sectionsPerRoot': sections_per_root,
        'memSectionSymbol': symbol,
    })
    if symbol is None:
        out['notes'].append('符号表里没有 mem_section，vmemmap 解不出来（不拿常量冒充）')
        return out
    root_array = u64_at(symbol)
    out['rootArray'] = root_array
    if root_array == 0:
        out['notes'].append('mem_section 根数组指针是 0：稀疏内存还没分配')
        return out
    root_index = section_number // sections_per_root
    section_array = u64_at(root_array + root_index * 8)
    out.update({'rootIndex': root_index, 'sectionArray': section_array})
    if section_array == 0:
        out['notes'].append('根数组第 %d 项是 0：这一段物理内存不存在' % root_index)
        return out
    section_address = section_array + (section_number % sections_per_root) * section_size
    raw = u64_at(section_address + layout['mem_section']['section_mem_map'])
    # `mm/internal.h` 的 `sparse_init_one_section()` 往这里写的是
    # `coded_mem_map = (unsigned long)(mem_map - section_nr_to_pfn(pnum))` ——
    # 指针减法，减掉的是 `起始页框号 × sizeof(struct page)` 个字节，所以这串编码值
    # **本身**就等于 `mem_map - 起始页框号 × 步长`；VMEMMAP 形态下 `mem_map` 就是
    # `vmemmap + 起始页框号 × 步长`，两式相减剩下的正是 vmemmap 基址。
    # 不能再"加回起始页框号、再按字节减一次" —— 那等于把这一项算两遍，
    # section 0（起始页框号为 0）看不出问题，别的 section 就整段偏移。
    # 内核那侧的对照是 `mm/sparse.c` 的 `sparse_decode_mem_map()`：
    # `((struct page *)(编码值 & SECTION_MAP_MASK)) + section_nr_to_pfn(pnum)`。
    base = raw & SECTION_MAP_MASK
    mem_map = base + section_start_pfn * page_size
    out.update({
        'sectionAddress': section_address,
        'sectionMemMapRaw': raw,
        'memoryMap': mem_map,
        'base': base,
        'aligned': (base % (1 << 39)) == 0,
        'inKernelHalf': base >= 0xFFFF800000000000,
    })
    return out


def main():
    result = {'ok': True, 'notes': []}
    try:
        layout = dwarf_layout()
        result['layout'] = layout
        result['inputs'] = {
            'files': FILES_HINT, 'fd': FD_HINT, 'file': FILE_HINT, 'dentry': DENTRY_HINT,
            'inode': INODE_HINT, 'mapping': MAPPING_HINT, 'pfn': PFN_HINT,
        }

        current = read_current(layout)
        result['current'] = current
        result['notes'].extend(current.get('notes', []))
        files_address = FILES_HINT
        if files_address in (0, None):
            files_address = current.get('filesAddress')
        if files_address in (0, None):
            raise RuntimeError('拿不到 files_struct 地址（current->files 为 0？）')
        if FILES_HINT not in (0, None) and current.get('filesAddress') not in (0, None) \
                and FILES_HINT != current['filesAddress']:
            result['notes'].append('我方给的 files 地址与 current->files 不一致（提示值先用着）')

        files = read_files(layout, files_address)
        result['files'] = files
        fdtable = read_fdtable(layout, files['fdt'])
        result['fdtable'] = fdtable
        result['bitmaps'] = read_bitmaps(layout, files, fdtable)

        # ---------- 指定的那个 fd ----------
        file_address = FILE_HINT
        if FD_HINT is not None and FD_HINT >= 0:
            slot = read_fd_slot(layout, files, fdtable, FD_HINT)
            result['fdSlot'] = slot
            if slot['inRange'] and slot['fileAddress']:
                file_address = slot['fileAddress']
            elif not file_address:
                result['notes'].append('fd %d 的槽是空的，也没有我方给的 file 地址' % FD_HINT)
        if file_address in (0, None):
            result['notes'].append('没有可解析的 struct file：跳过 file 以下的解析')
        else:
            file_record = read_file(layout, file_address)
            result['file'] = file_record
            if FILE_HINT not in (0, None) and FILE_HINT != file_address:
                result['notes'].append('我方给的 file 地址与 fd 表里读到的不一致')

            # ---------- dentry 与路径 ----------
            dentry_address = file_record['path']['dentry'] or DENTRY_HINT
            if DENTRY_HINT not in (0, None) and dentry_address != DENTRY_HINT:
                result['notes'].append('我方给的 dentry 地址与 file->f_path.dentry 不一致')
            if dentry_address:
                result['dentry'] = read_dentry(layout, dentry_address)
                result['path'] = resolve_path(layout, dentry_address)
            if file_record['path']['mnt']:
                m = layout['vfsmount']
                mount = file_record['path']['mnt']
                result['vfsmount'] = {
                    'address': mount,
                    'rootDentry': u64_at(mount + m['mnt_root']),
                    'superBlock': u64_at(mount + m['mnt_sb']),
                    'flags': read_signed(mount + m['mnt_flags'], 4),
                }

            # ---------- inode 与 super_block ----------
            inode_address = file_record['fInode'] or INODE_HINT
            if INODE_HINT not in (0, None) and inode_address != INODE_HINT:
                result['notes'].append('我方给的 inode 地址与 file->f_inode 不一致')
            super_block_address = 0
            if inode_address:
                inode = read_inode(layout, inode_address)
                result['inode'] = inode
                super_block_address = inode['superBlock']
            if super_block_address == 0 and result.get('vfsmount'):
                super_block_address = result['vfsmount']['superBlock']
            if super_block_address:
                result['superBlock'] = read_super_block(layout, super_block_address)

            # ---------- address_space 与 i_pages 这棵 XArray ----------
            mapping_address = file_record['fMapping'] or MAPPING_HINT
            if not mapping_address and result.get('inode'):
                mapping_address = result['inode']['mapping']
            if MAPPING_HINT not in (0, None) and mapping_address != MAPPING_HINT:
                result['notes'].append('我方给的 address_space 地址与 file/inode 里读到的不一致')
            if mapping_address:
                mapping = read_address_space(layout, mapping_address)
                result['addressSpace'] = mapping
                xarray = walk_xarray(layout, mapping['pagesAddress'])
                result['ipages'] = xarray
                # 页缓存里每个条目应当是一个 `struct page *`：这里独立地把它们解出来，
                # 供 Node 侧与我方 folio 的 mapping/index 逐字段比。
                folios = []
                for entry in xarray['entries'][:4]:
                    if entry['kind'] != 'pointer':
                        folios.append({'index': entry['index'], 'error': '条目不是普通指针（%s）' % entry['kind']})
                        continue
                    folios.append({'index': entry['index'], 'page': read_page_struct(layout, entry['pointer'])})
                result['pageCachePages'] = folios

        # ---------- vmemmap 与"页框号 → struct page" ----------
        result['vmemmap'] = resolve_vmemmap(layout, PFN_HINT) if PFN_HINT else None
        if result['vmemmap'] and result['vmemmap'].get('base') is not None:
            address = result['vmemmap']['base'] + PFN_HINT * layout['sizes']['page']
            result['pageAtPfn'] = read_page_struct(layout, address)
    except Exception as exc:
        result['ok'] = False
        result['error'] = '%s: %s' % (type(exc).__name__, exc)
        result['traceback'] = traceback.format_exc().splitlines()[-8:]

# ---------------------------------------------------------------------------
# T07f：I/O 这一层（请求 → 队列 → 驱动 → virtqueue → 环 → 设备请求，以及 bio → 页）
# ---------------------------------------------------------------------------
#
# 上面的 `main()` 是 T07d 那份，留在文件里当历史参考，**本文件不会调用它**
# （它读的 `FILES_HINT`/`FD_HINT`/… 这些名字在本文件里已经换成了 T07f 的占位符；
# 真要重跑 T07d 的对照请用 `t07d-gdb-reference.py`）。本文件末尾只调 `t07f_main()`。

# 下面三张表是**宏**（DWARF 里没有，`gdb.parse_and_eval` 问不出来），值照抄
# `include/uapi/linux/virtio_blk.h` 与 `include/uapi/linux/virtio_ring.h` 的原文；
# Node 侧会重解析同一份头文件做第二次对账。数值必须"含文件名地"抄，不能凭记忆：
# 本内核里 `VIRTIO_BLK_T_ZONE_OPEN` 是 18、`VIRTIO_BLK_T_ZONE_CLOSE` 是 20。
VIRTIO_BLK_T = {
    'VIRTIO_BLK_T_IN': 0,
    'VIRTIO_BLK_T_OUT': 1,
    'VIRTIO_BLK_T_SCSI_CMD': 2,
    'VIRTIO_BLK_T_FLUSH': 4,
    'VIRTIO_BLK_T_GET_ID': 8,
    'VIRTIO_BLK_T_DISCARD': 11,
    'VIRTIO_BLK_T_WRITE_ZEROES': 13,
    'VIRTIO_BLK_T_SECURE_ERASE': 14,
    'VIRTIO_BLK_T_ZONE_APPEND': 15,
    'VIRTIO_BLK_T_ZONE_REPORT': 16,
    'VIRTIO_BLK_T_ZONE_OPEN': 18,
    'VIRTIO_BLK_T_ZONE_CLOSE': 20,
    'VIRTIO_BLK_T_ZONE_FINISH': 22,
    'VIRTIO_BLK_T_ZONE_RESET': 24,
    'VIRTIO_BLK_T_ZONE_RESET_ALL': 26,
}
VIRTIO_BLK_T_BARRIER = 0x80000000
VIRTIO_BLK_S = {
    'VIRTIO_BLK_S_OK': 0,
    'VIRTIO_BLK_S_IOERR': 1,
    'VIRTIO_BLK_S_UNSUPP': 2,
    'VIRTIO_BLK_S_ZONE_INVALID_CMD': 3,
    'VIRTIO_BLK_S_ZONE_UNALIGNED_WP': 4,
    'VIRTIO_BLK_S_ZONE_OPEN_RESOURCE': 5,
    'VIRTIO_BLK_S_ZONE_ACTIVE_RESOURCE': 6,
}
VRING_DESC_F = {'VRING_DESC_F_NEXT': 1, 'VRING_DESC_F_WRITE': 2, 'VRING_DESC_F_INDIRECT': 4}
# `block/blk-mq.h` 的 `enum mq_rq_state` **在 DWARF 里**，所以先问 GDB；这张表只是兜底。
MQ_RQ_STATE_FALLBACK = {'MQ_RQ_IDLE': 0, 'MQ_RQ_IN_FLIGHT': 1, 'MQ_RQ_COMPLETE': 2}
# `include/linux/blk_types.h` 的 `REQ_OP_BITS`（宏）：低 8 位是操作码，高 24 位是标志。
REQ_OP_BITS = 8
MAX_VRING_DESC = 256
MAX_SG_ENTRIES = 64
MAX_BIO_VECTORS = 64
MAX_BIOS = 512

# 现场问出来的字段宽度缓存（同一「类型.字段」只问一次）；最后会塞进结果里当证据。
WIDTH_CACHE = {}


def width_of(type_name, field, fallback):
    """字段自己的字节宽度：优先 DWARF，取不到才用清单里的兜底值。

    一律按 8 字节读会把相邻字段拼进来：`nr_hw_queues` 是 4 字节、`nr_ctx` 是 2 字节、
    `bi_flags` 是 2 字节，读宽了会得到一个"看着像模像样"的数。
    """
    key = '%s.%s' % (type_name, field)
    if key not in WIDTH_CACHE:
        WIDTH_CACHE[key] = safe(lambda: field_width(type_name, field))
    value = WIDTH_CACHE[key]
    return value if value else fallback


def read_fields(layout, type_name, address, spec, notes=None):
    """按 `(对外键名, DWARF 字段名, 兜底宽度, 是否指针)` 的清单读一组字段。

    字段在 DWARF 里没有时给 None 并记一笔，**不拿 0 冒充**：内核升级改名/删字段时，
    Node 侧看到的是"这一项读不出来"，而不是一个和真值长得一样的 0。
    """
    missing = []
    out = {}
    for key, field, fallback, is_pointer in spec:
        offset = layout[type_name].get(field)
        if offset is None:
            out[key] = None
            missing.append(field)
            continue
        if is_pointer:
            out[key] = u64_at(address + offset)
            continue
        out[key] = read_unsigned(address + offset, width_of(type_name, field, fallback))
    if missing and notes is not None:
        notes.append('%s：这些字段在本内核的 DWARF 里没有 → %s' % (type_name, ', '.join(missing)))
    return out


def enum_probe(names):
    """一组名字 → 值，**只报能问出来的**：宏问不出来就进 `unresolved`，不拿 0 冒充。"""
    values = {}
    unresolved = []
    for name in names:
        value = safe(lambda name=name: int(gdb.parse_and_eval(name)))
        if value is None:
            unresolved.append(name)
        else:
            values[name] = value
    return {'values': values, 'unresolved': unresolved}


def io_layout():
    """T07f 用到的全部偏移/宽度/枚举，一次问齐（仍然全部现场问 GDB 的 DWARF）。"""
    layout = dwarf_layout()
    layout['sizes'].update({
        'request': safe(lambda: size_of('request')),
        'bio': safe(lambda: size_of('bio')),
        'bio_vec': safe(lambda: size_of('bio_vec')),
        'virtblk_req': safe(lambda: size_of('virtblk_req')),
        'scatterlist': safe(lambda: size_of('scatterlist')),
        'vring_desc': safe(lambda: size_of('vring_desc')),
        'vring_desc_state_split': safe(lambda: size_of('vring_desc_state_split')),
        'vring': safe(lambda: size_of('vring')),
        'vring_avail': safe(lambda: size_of('vring_avail')),
        'vring_used': safe(lambda: size_of('vring_used')),
        'vring_used_elem': safe(lambda: size_of('vring_used_elem')),
        'vring_virtqueue': safe(lambda: size_of('vring_virtqueue')),
        'virtio_blk': safe(lambda: size_of('virtio_blk')),
        'virtio_blk_vq': safe(lambda: size_of('virtio_blk_vq')),
        'virtio_blk_outhdr': safe(lambda: size_of('virtio_blk_outhdr')),
        'blk_mq_hw_ctx': safe(lambda: size_of('blk_mq_hw_ctx')),
        'blk_mq_ctx': safe(lambda: size_of('blk_mq_ctx')),
        'blk_mq_tags': safe(lambda: size_of('blk_mq_tags')),
        'request_queue': safe(lambda: size_of('request_queue')),
    })
    layout['request'] = {
        'q': safe(lambda: off('request', 'q')),
        'mq_ctx': safe(lambda: off('request', 'mq_ctx')),
        'mq_hctx': safe(lambda: off('request', 'mq_hctx')),
        'cmd_flags': safe(lambda: off('request', 'cmd_flags')),
        'rq_flags': safe(lambda: off('request', 'rq_flags')),
        'tag': safe(lambda: off('request', 'tag')),
        'internal_tag': safe(lambda: off('request', 'internal_tag')),
        'timeout': safe(lambda: off('request', 'timeout')),
        'data_len': safe(lambda: off('request', '__data_len')),
        'sector': safe(lambda: off('request', '__sector')),
        'bio': safe(lambda: off('request', 'bio')),
        'biotail': safe(lambda: off('request', 'biotail')),
        'part': safe(lambda: off('request', 'part')),
        'nr_phys_segments': safe(lambda: off('request', 'nr_phys_segments')),
        'state': safe(lambda: off('request', 'state')),
        'ref': safe(lambda: off('request', 'ref')),
        'end_io': safe(lambda: off('request', 'end_io')),
        'start_time_ns': safe(lambda: off('request', 'start_time_ns')),
        'io_start_time_ns': safe(lambda: off('request', 'io_start_time_ns')),
    }
    layout['bio'] = {
        'next': safe(lambda: off('bio', 'bi_next')),
        'bdev': safe(lambda: off('bio', 'bi_bdev')),
        'opf': safe(lambda: off('bio', 'bi_opf')),
        'flags': safe(lambda: off('bio', 'bi_flags')),
        'ioprio': safe(lambda: off('bio', 'bi_ioprio')),
        'write_hint': safe(lambda: off('bio', 'bi_write_hint')),
        'status': safe(lambda: off('bio', 'bi_status')),
        'iter_sector': safe(lambda: off('bio', 'bi_iter.bi_sector')),
        'iter_size': safe(lambda: off('bio', 'bi_iter.bi_size')),
        'iter_idx': safe(lambda: off('bio', 'bi_iter.bi_idx')),
        'iter_bvec_done': safe(lambda: off('bio', 'bi_iter.bi_bvec_done')),
        'vcnt': safe(lambda: off('bio', 'bi_vcnt')),
        'max_vecs': safe(lambda: off('bio', 'bi_max_vecs')),
        'end_io': safe(lambda: off('bio', 'bi_end_io')),
        'private': safe(lambda: off('bio', 'bi_private')),
        'io_vec': safe(lambda: off('bio', 'bi_io_vec')),
    }
    layout['bio_vec'] = {
        'page': safe(lambda: off('bio_vec', 'bv_page')),
        'len': safe(lambda: off('bio_vec', 'bv_len')),
        'offset': safe(lambda: off('bio_vec', 'bv_offset')),
    }
    layout['scatterlist'] = {
        'page_link': safe(lambda: off('scatterlist', 'page_link')),
        'offset': safe(lambda: off('scatterlist', 'offset')),
        'length': safe(lambda: off('scatterlist', 'length')),
        'dma_address': safe(lambda: off('scatterlist', 'dma_address')),
        'dma_length': safe(lambda: off('scatterlist', 'dma_length')),
    }
    layout['virtblk_req'] = {
        'out_hdr_type': safe(lambda: off('virtblk_req', 'out_hdr.type')),
        'out_hdr_ioprio': safe(lambda: off('virtblk_req', 'out_hdr.ioprio')),
        'out_hdr_sector': safe(lambda: off('virtblk_req', 'out_hdr.sector')),
        'in_hdr': safe(lambda: off('virtblk_req', 'in_hdr')),
        'in_hdr_len': safe(lambda: off('virtblk_req', 'in_hdr_len')),
        'sg_nents': safe(lambda: off('virtblk_req', 'sg_table.nents')),
        'sg_orig_nents': safe(lambda: off('virtblk_req', 'sg_table.orig_nents')),
        'sg_sgl': safe(lambda: off('virtblk_req', 'sg_table.sgl')),
        'sg': safe(lambda: off('virtblk_req', 'sg')),
    }
    layout['request_queue'] = {
        'queuedata': safe(lambda: off('request_queue', 'queuedata')),
        'elevator': safe(lambda: off('request_queue', 'elevator')),
        'mq_ops': safe(lambda: off('request_queue', 'mq_ops')),
        'queue_ctx': safe(lambda: off('request_queue', 'queue_ctx')),
        'queue_flags': safe(lambda: off('request_queue', 'queue_flags')),
        'rq_timeout': safe(lambda: off('request_queue', 'rq_timeout')),
        'queue_depth': safe(lambda: off('request_queue', 'queue_depth')),
        'refs': safe(lambda: off('request_queue', 'refs')),
        'nr_hw_queues': safe(lambda: off('request_queue', 'nr_hw_queues')),
        'hctx_table': safe(lambda: off('request_queue', 'hctx_table')),
        'last_merge': safe(lambda: off('request_queue', 'last_merge')),
        'disk': safe(lambda: off('request_queue', 'disk')),
        'nr_requests': safe(lambda: off('request_queue', 'nr_requests')),
        'tag_set': safe(lambda: off('request_queue', 'tag_set')),
        'mq_freeze_depth': safe(lambda: off('request_queue', 'mq_freeze_depth')),
    }
    layout['blk_mq_hw_ctx'] = {
        'queue': safe(lambda: off('blk_mq_hw_ctx', 'queue')),
        'driver_data': safe(lambda: off('blk_mq_hw_ctx', 'driver_data')),
        'ctxs': safe(lambda: off('blk_mq_hw_ctx', 'ctxs')),
        'nr_ctx': safe(lambda: off('blk_mq_hw_ctx', 'nr_ctx')),
        'tags': safe(lambda: off('blk_mq_hw_ctx', 'tags')),
        'sched_tags': safe(lambda: off('blk_mq_hw_ctx', 'sched_tags')),
        'queue_num': safe(lambda: off('blk_mq_hw_ctx', 'queue_num')),
        'nr_active': safe(lambda: off('blk_mq_hw_ctx', 'nr_active')),
        'type': safe(lambda: off('blk_mq_hw_ctx', 'type')),
        'flags': safe(lambda: off('blk_mq_hw_ctx', 'flags')),
        'state': safe(lambda: off('blk_mq_hw_ctx', 'state')),
    }
    layout['blk_mq_ctx'] = {
        'cpu': safe(lambda: off('blk_mq_ctx', 'cpu')),
        'index_hw': safe(lambda: off('blk_mq_ctx', 'index_hw')),
        'queue': safe(lambda: off('blk_mq_ctx', 'queue')),
        'hctxs': safe(lambda: off('blk_mq_ctx', 'hctxs')),
        'rq_lists': safe(lambda: off('blk_mq_ctx', 'rq_lists')),
    }
    layout['blk_mq_tags'] = {
        'nr_tags': safe(lambda: off('blk_mq_tags', 'nr_tags')),
        'nr_reserved_tags': safe(lambda: off('blk_mq_tags', 'nr_reserved_tags')),
        'active_queues': safe(lambda: off('blk_mq_tags', 'active_queues')),
        'rqs': safe(lambda: off('blk_mq_tags', 'rqs')),
        'static_rqs': safe(lambda: off('blk_mq_tags', 'static_rqs')),
    }
    layout['virtio_blk'] = {
        'vdev': safe(lambda: off('virtio_blk', 'vdev')),
        'disk': safe(lambda: off('virtio_blk', 'disk')),
        'index': safe(lambda: off('virtio_blk', 'index')),
        'num_vqs': safe(lambda: off('virtio_blk', 'num_vqs')),
        'io_queues': safe(lambda: off('virtio_blk', 'io_queues')),
        'vqs': safe(lambda: off('virtio_blk', 'vqs')),
        'zone_sectors': safe(lambda: off('virtio_blk', 'zone_sectors')),
    }
    layout['virtio_blk_vq'] = {
        'vq': safe(lambda: off('virtio_blk_vq', 'vq')),
        'name': safe(lambda: off('virtio_blk_vq', 'name')),
    }
    layout['vring_virtqueue'] = {
        # `struct virtqueue vq` 是它的**第一个成员**，所以两者的地址相同（这一条要报出来）。
        'vq': safe(lambda: off('vring_virtqueue', 'vq')),
        'vq_index': safe(lambda: off('vring_virtqueue', 'vq.index')),
        'vq_num_free': safe(lambda: off('vring_virtqueue', 'vq.num_free')),
        'vq_num_max': safe(lambda: off('vring_virtqueue', 'vq.num_max')),
        'vq_name': safe(lambda: off('vring_virtqueue', 'vq.name')),
        'vq_vdev': safe(lambda: off('vring_virtqueue', 'vq.vdev')),
        'vq_priv': safe(lambda: off('vring_virtqueue', 'vq.priv')),
        'packed_ring': safe(lambda: off('vring_virtqueue', 'packed_ring')),
        'indirect': safe(lambda: off('vring_virtqueue', 'indirect')),
        'event': safe(lambda: off('vring_virtqueue', 'event')),
        'broken': safe(lambda: off('vring_virtqueue', 'broken')),
        'use_dma_api': safe(lambda: off('vring_virtqueue', 'use_dma_api')),
        'premapped': safe(lambda: off('vring_virtqueue', 'premapped')),
        'do_unmap': safe(lambda: off('vring_virtqueue', 'do_unmap')),
        'free_head': safe(lambda: off('vring_virtqueue', 'free_head')),
        'num_added': safe(lambda: off('vring_virtqueue', 'num_added')),
        'last_used_idx': safe(lambda: off('vring_virtqueue', 'last_used_idx')),
        'num': safe(lambda: off('vring_virtqueue', 'split.vring.num')),
        'desc': safe(lambda: off('vring_virtqueue', 'split.vring.desc')),
        'avail': safe(lambda: off('vring_virtqueue', 'split.vring.avail')),
        'used': safe(lambda: off('vring_virtqueue', 'split.vring.used')),
        'desc_state': safe(lambda: off('vring_virtqueue', 'split.desc_state')),
        'desc_extra': safe(lambda: off('vring_virtqueue', 'split.desc_extra')),
        'avail_flags_shadow': safe(lambda: off('vring_virtqueue', 'split.avail_flags_shadow')),
        'avail_idx_shadow': safe(lambda: off('vring_virtqueue', 'split.avail_idx_shadow')),
    }
    layout['vring_desc'] = {
        'addr': safe(lambda: off('vring_desc', 'addr')),
        'len': safe(lambda: off('vring_desc', 'len')),
        'flags': safe(lambda: off('vring_desc', 'flags')),
        'next': safe(lambda: off('vring_desc', 'next')),
    }
    layout['vring_desc_state_split'] = {
        'data': safe(lambda: off('vring_desc_state_split', 'data')),
        'indir_desc': safe(lambda: off('vring_desc_state_split', 'indir_desc')),
    }
    layout['vring_avail'] = {
        'flags': safe(lambda: off('vring_avail', 'flags')),
        'idx': safe(lambda: off('vring_avail', 'idx')),
        'ring': safe(lambda: off('vring_avail', 'ring')),
    }
    layout['vring_used'] = {
        'flags': safe(lambda: off('vring_used', 'flags')),
        'idx': safe(lambda: off('vring_used', 'idx')),
        'ring': safe(lambda: off('vring_used', 'ring')),
    }
    layout['vring_used_elem'] = {
        'id': safe(lambda: off('vring_used_elem', 'id')),
        'len': safe(lambda: off('vring_used_elem', 'len')),
    }
    mq_state = enum_probe(['MQ_RQ_IDLE', 'MQ_RQ_IN_FLIGHT', 'MQ_RQ_COMPLETE'])
    layout['enums'] = {
        # 问得到就用 DWARF 的，问不到才用兜底表（并如实标出来用的是哪一份）。
        'mq_rq_state': mq_state['values'] if mq_state['values'] else dict(MQ_RQ_STATE_FALLBACK),
        'mq_rq_stateFromDwarf': bool(mq_state['values']),
        'mq_rq_stateUnresolved': mq_state['unresolved'],
        'req_op': enum_probe([
            'REQ_OP_READ', 'REQ_OP_WRITE', 'REQ_OP_FLUSH', 'REQ_OP_DISCARD', 'REQ_OP_SECURE_ERASE',
            'REQ_OP_WRITE_ZEROES', 'REQ_OP_ZONE_OPEN', 'REQ_OP_ZONE_CLOSE', 'REQ_OP_ZONE_FINISH',
            'REQ_OP_ZONE_APPEND', 'REQ_OP_ZONE_RESET', 'REQ_OP_ZONE_RESET_ALL',
            'REQ_OP_DRV_IN', 'REQ_OP_DRV_OUT', 'REQ_OP_LAST',
        ]),
        'req_flag_bits': enum_probe([
            '__REQ_FAILFAST_DEV', '__REQ_FAILFAST_TRANSPORT', '__REQ_FAILFAST_DRIVER', '__REQ_SYNC',
            '__REQ_META', '__REQ_PRIO', '__REQ_NOMERGE', '__REQ_IDLE', '__REQ_INTEGRITY',
            '__REQ_FUA', '__REQ_PREFLUSH', '__REQ_RAHEAD', '__REQ_BACKGROUND', '__REQ_NOWAIT',
            '__REQ_POLLED', '__REQ_ALLOC_CACHE', '__REQ_SWAP', '__REQ_DRV', '__REQ_FS_PRIVATE',
            '__REQ_ATOMIC', '__REQ_NOUNMAP', '__REQ_NR_BITS',
        ]),
        'blk_status': enum_probe([
            'BLK_STS_OK', 'BLK_STS_NOTSUPP', 'BLK_STS_TIMEOUT', 'BLK_STS_NOSPC',
            'BLK_STS_TRANSPORT', 'BLK_STS_TARGET', 'BLK_STS_NEXUS', 'BLK_STS_MEDIUM',
            'BLK_STS_PROTECTION', 'BLK_STS_RESOURCE', 'BLK_STS_IOERR', 'BLK_STS_OFFLINE',
            'BLK_STS_DURATION_LIMIT', 'BLK_STS_ZONE_RESOURCE', 'BLK_STS_ZONE_OPEN_RESOURCE',
            'BLK_STS_ZONE_ACTIVE_RESOURCE',
        ]),
        # 页标志位的位号（`enum pageflags`）在 T07d 那份里已经问过一次，这里复用。
        'pageflags': read_page_flags_bits(),
    }
    return layout


def read_request_gdb(layout, address):
    """读一个 `struct request`。PDU 地址按 `rq + sizeof(struct request)` 自己算。"""
    notes = []
    out = read_fields(layout, 'request', address, [
        ('cmdFlags', 'cmd_flags', 4, False),
        ('rqFlags', 'rq_flags', 4, False),
        ('tag', 'tag', 4, False),
        ('internalTag', 'internal_tag', 4, False),
        ('timeout', 'timeout', 4, False),
        ('dataLen', 'data_len', 4, False),
        ('sector', 'sector', 8, False),
        ('nrPhysSegments', 'nr_phys_segments', 4, False),
        ('state', 'state', 4, False),
        ('ref', 'ref', 4, False),
        ('startTimeNs', 'start_time_ns', 8, False),
        ('ioStartTimeNs', 'io_start_time_ns', 8, False),
    ], notes)
    for key, field in (('queue', 'q'), ('mqCtx', 'mq_ctx'), ('mqHctx', 'mq_hctx'),
                       ('bio', 'bio'), ('bioTail', 'biotail'), ('part', 'part'),
                       ('endIo', 'end_io')):
        offset = layout['request'].get(field)
        out[key] = u64_at(address + offset) if offset is not None else None
    out['address'] = address
    out['sizeOfRequest'] = layout['sizes']['request']
    out['pduAddress'] = address + (layout['sizes']['request'] or 0)
    out['stateName'] = None
    table = layout['enums']['mq_rq_state']
    for name in sorted(table, key=lambda item: table[item]):
        if table[name] == out['state']:
            out['stateName'] = name
            break
    if out['state'] is not None and out['stateName'] is None:
        notes.append('rq->state = %s 不在 enum mq_rq_state 里' % out['state'])
    out['sectorEnd'] = None
    if out['sector'] is not None and out['dataLen'] is not None:
        out['sectorEnd'] = out['sector'] + (out['dataLen'] + 511) // 512
    if out['cmdFlags'] is not None:
        # `blk_types.h` 的宏：低 `REQ_OP_BITS` 位是操作码，其余是标志位。
        out['opRaw'] = out['cmdFlags'] & ((1 << REQ_OP_BITS) - 1)
        out['flagBits'] = out['cmdFlags'] >> REQ_OP_BITS
        out['opSymbol'] = None
        for name, value in sorted(layout['enums']['req_op']['values'].items(), key=lambda item: item[1]):
            if value == out['opRaw']:
                out['opSymbol'] = name
                break
    out['notes'] = notes
    return out


def read_scatterlist_gdb(layout, table_address, index):
    """读一个 `struct scatterlist`。宽度与偏移全部来自 DWARF，不写死 0/8/12/16/24。"""
    stride = layout['sizes']['scatterlist'] or 32
    address = table_address + index * stride
    s = layout['scatterlist']
    record = {'index': index, 'address': address}
    for key, field, fallback, is_pointer in (
        ('pageLink', 'page_link', 8, True),
        ('offset', 'offset', 4, False),
        ('length', 'length', 4, False),
        ('dmaAddress', 'dma_address', 8, True),
        ('dmaLength', 'dma_length', 4, False),
    ):
        offset = s.get(field)
        if offset is None:
            record[key] = None
        elif is_pointer:
            record[key] = u64_at(address + offset)
        else:
            record[key] = read_unsigned(address + offset, width_of('scatterlist', field, fallback))
    # `scatterlist.page_link` 的最低两位是标记：bit0 = 链上还有下一个，bit1 = 链式 sg 表。
    if record['pageLink'] is None:
        record['pageLinkFlags'] = None
        record['pageAddress'] = None
    else:
        record['pageLinkFlags'] = record['pageLink'] & 0x3
        masked = record['pageLink'] & ~0x3
        record['pageAddress'] = masked if masked else None
    return record


def read_virtblk_req_gdb(layout, address, max_sg=MAX_SG_ENTRIES):
    """读请求私有区 `struct virtblk_req`（设备看到的那份头就在这里）。"""
    notes = []
    violations = []
    v = layout['virtblk_req']
    out = {'address': address, 'notes': notes, 'violations': violations}
    offset = v.get('out_hdr_type')
    out_type = read_unsigned(address + offset, 4) if offset is not None else None
    out['outType'] = out_type
    out['outTypeSymbol'] = None
    out['outTypeBarrier'] = None
    if out_type is not None:
        barrier = (out_type & VIRTIO_BLK_T_BARRIER) != 0
        out['outTypeBarrier'] = barrier
        base = out_type & ~VIRTIO_BLK_T_BARRIER
        for name in sorted(VIRTIO_BLK_T, key=lambda item: VIRTIO_BLK_T[item]):
            if VIRTIO_BLK_T[name] == base:
                out['outTypeSymbol'] = name
                break
        if out['outTypeSymbol'] is None:
            violations.append(
                'out_hdr.type = 0x%x 不在 VIRTIO_BLK_T_* 里：要么 PDU 起点不是'
                ' rq + sizeof(struct request)，要么类型被改过' % out_type)
        if barrier:
            notes.append('out_hdr.type 带着 VIRTIO_BLK_T_BARRIER（0x80000000）：这是兼容位的旧写法，已剥掉再查类型')
    offset = v.get('out_hdr_ioprio')
    out['outHdrIoprio'] = read_unsigned(address + offset, 4) if offset is not None else None
    offset = v.get('out_hdr_sector')
    out['outSector'] = u64_at(address + offset) if offset is not None else None

    in_hdr = v.get('in_hdr')
    in_hdr_len_offset = v.get('in_hdr_len')
    in_hdr_len = read_unsigned(address + in_hdr_len_offset, 8) if in_hdr_len_offset is not None else None
    out['inHdrAddress'] = (address + in_hdr) if in_hdr is not None else None
    out['inHdrLen'] = in_hdr_len
    out['status'] = None
    out['statusName'] = None
    # `virtblk_vbr_status()`：状态字节在 `(u8 *)&vbr->in_hdr + in_hdr_len - 1`。
    if in_hdr_len is None or in_hdr_len == 0:
        violations.append('in_hdr_len 读不到或为 0：状态字节无从定位（virtblk_vbr_status() 会读到私有区之外）')
    elif in_hdr_len > 32:
        violations.append('in_hdr_len = %s 大得不像真的：不按它定位状态字节' % in_hdr_len)
    elif in_hdr is not None:
        out['status'] = u8_at(address + in_hdr + in_hdr_len - 1)
        for name in sorted(VIRTIO_BLK_S, key=lambda item: VIRTIO_BLK_S[item]):
            if VIRTIO_BLK_S[name] == out['status']:
                out['statusName'] = name
                break
        if out['status'] == 0:
            notes.append('status 是 0：请求还没完成时这就是初值，不是"设备说了 OK"的结论')

    nents_offset = v.get('sg_nents')
    sgl_offset = v.get('sg_sgl')
    nents = read_unsigned(address + nents_offset, 4) if nents_offset is not None else None
    out['sgNents'] = nents
    offset = v.get('sg_orig_nents')
    out['sgOrigNents'] = read_unsigned(address + offset, 4) if offset is not None else None
    out['sgTableAddress'] = u64_at(address + sgl_offset) if sgl_offset is not None else None
    out['sgEntries'] = []
    if nents:
        limit = min(nents, max_sg)
        if nents > limit:
            notes.append('sg_table.nents = %d 超过上限 %d，只读了前 %d 项' % (nents, limit, limit))
        if out['sgTableAddress']:
            for index in range(limit):
                out['sgEntries'].append(read_scatterlist_gdb(layout, out['sgTableAddress'], index))
        else:
            violations.append('sg_table.nents = %d 但 sg_table.sgl 是空指针：段表读不出来' % nents)
    elif nents == 0:
        notes.append('sg_table.nents 为 0：这个请求不带数据段（例如 FLUSH），设备只看到头与状态')
    return out


def read_request_queue_gdb(layout, address):
    notes = []
    out = read_fields(layout, 'request_queue', address, [
        ('queuedata', 'queuedata', 8, True),
        ('elevator', 'elevator', 8, True),
        ('mqOps', 'mq_ops', 8, True),
        ('queueCtx', 'queue_ctx', 8, True),
        ('queueFlags', 'queue_flags', 8, False),
        ('rqTimeout', 'rq_timeout', 4, False),
        ('queueDepth', 'queue_depth', 4, False),
        ('refs', 'refs', 4, False),
        ('nrHwQueues', 'nr_hw_queues', 4, False),
        ('lastMerge', 'last_merge', 8, True),
        ('disk', 'disk', 8, True),
        ('nrRequests', 'nr_requests', 8, False),
        ('tagSet', 'tag_set', 8, True),
        ('mqFreezeDepth', 'mq_freeze_depth', 4, False),
    ], notes)
    out['address'] = address
    offset = layout['request_queue'].get('hctx_table')
    out['hctxTableAddress'] = (address + offset) if offset is not None else None
    out['notes'] = notes
    return out


def read_hw_ctx_gdb(layout, address):
    notes = []
    out = read_fields(layout, 'blk_mq_hw_ctx', address, [
        ('queue', 'queue', 8, True),
        ('driverData', 'driver_data', 8, True),
        ('nrCtx', 'nr_ctx', 2, False),
        ('tags', 'tags', 8, True),
        ('schedTags', 'sched_tags', 8, True),
        ('queueNum', 'queue_num', 4, False),
        ('nrActive', 'nr_active', 4, False),
        ('type', 'type', 2, False),
        ('flags', 'flags', 8, False),
        ('state', 'state', 8, False),
    ], notes)
    out['address'] = address
    offset = layout['blk_mq_hw_ctx'].get('ctxs')
    out['ctxsAddress'] = (address + offset) if offset is not None else None
    out['notes'] = notes
    return out


def read_tags_gdb(layout, address, limit=256):
    """读 `struct blk_mq_tags`：`tag → request` 的落脚点。

    `rq->tag` 只是"占了第几个槽"，要确认"这个槽里现在真的是这个请求"得回 `tags->rqs[tag]`。
    对不上就是复用正在进行中（旧请求刚归还、新请求还没写完），这是"无法唯一关联"的一种具体形态。
    """
    notes = []
    out = read_fields(layout, 'blk_mq_tags', address, [
        ('nrTags', 'nr_tags', 4, False),
        ('nrReservedTags', 'nr_reserved_tags', 4, False),
        ('activeQueues', 'active_queues', 4, False),
    ], notes)
    out['address'] = address
    offset = layout['blk_mq_tags'].get('rqs')
    static_offset = layout['blk_mq_tags'].get('static_rqs')
    out['rqsAddress'] = (address + offset) if offset is not None else None
    out['staticRqsAddress'] = (address + static_offset) if static_offset is not None else None
    out['tagged'] = []
    rqs = u64_at(address + offset) if offset is not None else None
    count = min(out['nrTags'] or 0, limit)
    if (out['nrTags'] or 0) > limit:
        notes.append('nr_tags = %d 超过本次上限 %d，只读了前 %d 个槽' % (out['nrTags'], limit, limit))
    if rqs:
        for tag in range(count):
            value = u64_at(rqs + tag * 8)
            out['tagged'].append({'tag': tag, 'request': value if value else None})
    elif offset is not None:
        notes.append('tags->rqs 是空指针：拿不到 tag → 请求的映射')
    out['notes'] = notes
    return out


def read_virtio_blk_gdb(layout, address):
    notes = []
    out = read_fields(layout, 'virtio_blk', address, [
        ('vdev', 'vdev', 8, True),
        ('disk', 'disk', 8, True),
        ('index', 'index', 4, False),
        ('numVqs', 'num_vqs', 4, False),
        ('vqs', 'vqs', 8, True),
        ('zoneSectors', 'zone_sectors', 4, False),
    ], notes)
    out['address'] = address
    out['ioQueues'] = []
    offset = layout['virtio_blk'].get('io_queues')
    if offset is not None:
        # `int io_queues[HCTX_MAX_TYPES]`，本内核 HCTX_MAX_TYPES = 3。
        out['ioQueues'] = [read_signed(address + offset + index * 4, 4) for index in range(3)]
    vqs_offset = layout['virtio_blk'].get('vqs')
    out['vqsAddress'] = (address + vqs_offset) if vqs_offset is not None else None
    out['notes'] = notes
    return out


def read_vq_gdb(layout, address):
    """读一个 virtqueue（`struct virtqueue *` 与 `struct vring_virtqueue *` 同址）。"""
    notes = []
    violations = []
    out = read_fields(layout, 'vring_virtqueue', address, [
        ('index', 'vq_index', 4, False),
        ('numFree', 'vq_num_free', 4, False),
        ('numMax', 'vq_num_max', 4, False),
        ('packedRing', 'packed_ring', 1, False),
        ('indirect', 'indirect', 1, False),
        ('event', 'event', 1, False),
        ('broken', 'broken', 1, False),
        ('useDmaApi', 'use_dma_api', 1, False),
        ('premapped', 'premapped', 1, False),
        ('doUnmap', 'do_unmap', 1, False),
        ('freeHead', 'free_head', 4, False),
        ('numAdded', 'num_added', 4, False),
        ('lastUsedIdx', 'last_used_idx', 2, False),
        ('num', 'num', 4, False),
        ('availFlagsShadow', 'avail_flags_shadow', 2, False),
        ('availIdxShadow', 'avail_idx_shadow', 2, False),
    ], notes)
    for key, field in (('vdev', 'vq_vdev'), ('priv', 'vq_priv'), ('descAddress', 'desc'),
                       ('availAddress', 'avail'), ('usedAddress', 'used'),
                       ('descStateAddress', 'desc_state'), ('descExtraAddress', 'desc_extra')):
        offset = layout['vring_virtqueue'].get(field)
        out[key] = u64_at(address + offset) if offset is not None else None
    out['address'] = address
    out['sizeOfVringVirtqueue'] = layout['sizes']['vring_virtqueue']
    # `struct virtqueue vq` 是第一个成员：偏移必须是 0，两者同址。这是地址算式没搞错的
    # 第一份证据，所以单独报出来。
    out['vqOffsetInVringVirtqueue'] = layout['vring_virtqueue'].get('vq')
    name_offset = layout['vring_virtqueue'].get('vq_name')
    name_pointer = u64_at(address + name_offset) if name_offset is not None else None
    out['name'] = None
    if name_pointer:
        text, truncated = cstring(name_pointer, 64)
        out['name'] = text
        if truncated:
            notes.append('队列名字读到 64 字节还没有结尾 0，可能不是合法字符串')

    if out['packedRing'] == 1:
        violations.append(
            'packed_ring 立着：这是 packed 环，`split` 那套字段（vring/desc_state）此时是'
            '另一组数据的重叠视图，本实现不解 packed 环，不能用下面的描述符信息')
    num = out['num'] or 0
    if num and (num & (num - 1)) != 0:
        violations.append(
            'vring.num = %d 不是 2 的幂：内核用 (num - 1) 做下标掩码，环长不合法时算出来的'
            '描述符下标会指到别处' % num)
    for label, value in (('split.vring.desc', out['descAddress']), ('split.vring.avail', out['availAddress']),
                         ('split.vring.used', out['usedAddress']), ('split.desc_state', out['descStateAddress'])):
        if not value:
            violations.append('%s 是空指针：这个队列还没分配环（或 packed 环下这里没有意义）' % label)

    # 环头：avail/used 的 flags/idx 是设备与驱动之间"公开"的两个 16 位计数器，
    # 与驱动自己的影子值（*_shadow）不是一回事。这里用**两种读法**读同一处并互相对账。
    out['availFlags'] = None
    out['availIdx'] = None
    out['availFlagsByOffset'] = None
    out['availIdxByOffset'] = None
    if out['availAddress']:
        raw = mem_bytes(out['availAddress'], 4)
        out['availFlags'] = raw[0] | (raw[1] << 8)
        out['availIdx'] = raw[2] | (raw[3] << 8)
        a = layout['vring_avail']
        if a.get('flags') is not None:
            out['availFlagsByOffset'] = u16_at(out['availAddress'] + a['flags'])
        if a.get('idx') is not None:
            out['availIdxByOffset'] = u16_at(out['availAddress'] + a['idx'])
        if out['availFlagsByOffset'] is not None and out['availFlagsByOffset'] != out['availFlags']:
            violations.append('avail->flags 按字节读是 %d，按 DWARF 偏移读是 %d：vring_avail 的布局假设错了'
                              % (out['availFlags'], out['availFlagsByOffset']))
    out['usedFlags'] = None
    out['usedIdx'] = None
    out['usedFlagsByOffset'] = None
    out['usedIdxByOffset'] = None
    if out['usedAddress']:
        raw = mem_bytes(out['usedAddress'], 4)
        out['usedFlags'] = raw[0] | (raw[1] << 8)
        out['usedIdx'] = raw[2] | (raw[3] << 8)
        u = layout['vring_used']
        if u.get('flags') is not None:
            out['usedFlagsByOffset'] = u16_at(out['usedAddress'] + u['flags'])
        if u.get('idx') is not None:
            out['usedIdxByOffset'] = u16_at(out['usedAddress'] + u['idx'])
        if out['usedFlagsByOffset'] is not None and out['usedFlagsByOffset'] != out['usedFlags']:
            violations.append('used->flags 按字节读是 %d，按 DWARF 偏移读是 %d：vring_used 的布局假设错了'
                              % (out['usedFlags'], out['usedFlagsByOffset']))
    out['outstanding'] = None
    if out['availIdx'] is not None and out['usedIdx'] is not None:
        out['outstanding'] = (out['availIdx'] - out['usedIdx']) & 0xffff
    out['notes'] = notes
    out['violations'] = violations
    return out


def read_avail_ring_gdb(layout, avail_address, num, count=4):
    """读 `avail->ring[]` 尾部几个槽：这是"驱动按顺序放下过哪些描述符头"的公开记录。"""
    a = layout['vring_avail']
    out = {'heads': [], 'notes': []}
    if not avail_address or a.get('ring') is None or not num:
        out['notes'].append('avail 环地址、ring 偏移或环长不可用，读不出 avail->ring')
        return out
    idx = None
    if a.get('idx') is not None:
        idx = u16_at(avail_address + a['idx'])
        out['idx'] = idx
    if idx is None:
        out['notes'].append('avail->idx 读不到')
        return out
    for back in range(min(count, num)):
        slot = (idx - 1 - back) & 0xffff
        if slot >= num:
            break
        out['heads'].append({'slot': slot,
                             'head': u16_at(avail_address + a['ring'] + slot * 2)})
    return out


def read_used_ring_gdb(layout, used_address, num, count=4):
    """读 `used->ring[]` 尾部几个元素：设备用完一个请求就把它的描述符头下标写在这里。"""
    u = layout['vring_used']
    elem = layout['vring_used_elem']
    out = {'elems': [], 'notes': []}
    if not used_address or u.get('ring') is None or not num:
        out['notes'].append('used 环地址、ring 偏移或环长不可用，读不出 used->ring')
        return out
    idx = None
    if u.get('idx') is not None:
        idx = u16_at(used_address + u['idx'])
        out['idx'] = idx
    if idx is None:
        out['notes'].append('used->idx 读不到')
        return out
    stride = layout['sizes']['vring_used_elem'] or 8
    for back in range(min(count, num)):
        slot = (idx - 1 - back) & 0xffff
        if slot >= num:
            break
        base = used_address + u['ring'] + slot * stride
        out['elems'].append({
            'slot': slot,
            'id': u32_at(base + elem['id']) if elem.get('id') is not None else u32_at(base),
            'len': u32_at(base + elem['len']) if elem.get('len') is not None else u32_at(base + 4),
        })
    return out


def read_desc_gdb(layout, desc_base, index):
    d = layout['vring_desc']
    stride = layout['sizes']['vring_desc'] or 16
    address = desc_base + index * stride
    flags = u16_at(address + d['flags']) if d.get('flags') is not None else 0
    names = [name for name in sorted(VRING_DESC_F, key=lambda item: VRING_DESC_F[item])
             if flags & VRING_DESC_F[name]]
    return {
        'index': index,
        'address': address,
        'addr': u64_at(address + d['addr']) if d.get('addr') is not None else None,
        'len': read_unsigned(address + d['len'], width_of('vring_desc', 'len', 4)) if d.get('len') is not None else None,
        'flags': flags,
        'flagNames': names,
        'unknownFlagBits': flags & ~(VRING_DESC_F['VRING_DESC_F_NEXT']
                                     | VRING_DESC_F['VRING_DESC_F_WRITE']
                                     | VRING_DESC_F['VRING_DESC_F_INDIRECT']),
        'next': u16_at(address + d['next']) if d.get('next') is not None else None,
        'hasNext': (flags & VRING_DESC_F['VRING_DESC_F_NEXT']) != 0,
        'isIndirect': (flags & VRING_DESC_F['VRING_DESC_F_INDIRECT']) != 0,
    }


def walk_desc_chain_gdb(layout, vq, head, limit=MAX_VRING_DESC):
    """顺一条描述符链往下走（本脚本自己走，不借我方任何代码）。

    终止条件按 `virtqueue_add_split()` 实际写环的方式定：**最后一个描述符不带 NEXT**。
    间接描述符（`INDIRECT` 立着）时，主环里那一个描述符不指向数据，真正的链在它 `addr`
    指的那张表里；`head` 自己的 NEXT 是**没立**的（源码把最后一个的 NEXT 清掉，而间接时
    "最后一个"就是 head 自己）。
    """
    out = {'head': head, 'descriptors': [], 'indirect': False, 'indirectTableAddress': None,
           'indirectDescriptors': [], 'totalLength': 0, 'cycle': False, 'truncated': False,
           'notes': [], 'violations': []}
    desc_base = vq.get('descAddress')
    num = vq.get('num') or 0
    if not desc_base:
        out['violations'].append('这个 virtqueue 没有描述符表基址，走不了链')
        return out
    seen = set()
    index = head
    first = True
    while True:
        if num and index >= num:
            out['violations'].append('描述符下标 %d 超出环长 %d：链上的 next 指到了环外' % (index, num))
            break
        if index in seen:
            out['cycle'] = True
            out['violations'].append('描述符链回到已经走过的下标 %d：环上的 next 形成了环' % index)
            break
        seen.add(index)
        if len(out['descriptors']) >= limit:
            out['truncated'] = True
            out['notes'].append('达到描述符链上限 %d 个，停止；链上可能还有更多' % limit)
            break
        descriptor = read_desc_gdb(layout, desc_base, index)
        out['descriptors'].append(descriptor)
        if first and descriptor['isIndirect']:
            out['indirect'] = True
            out['indirectTableAddress'] = descriptor['addr']
            first = False
            break
        first = False
        if not descriptor['hasNext']:
            break
        index = descriptor['next']
    out['totalLength'] = sum(item['len'] or 0 for item in out['descriptors'])

    if out['indirect'] and out['indirectTableAddress']:
        table = out['indirectTableAddress']
        cursor = 0
        indirect_seen = set()
        while True:
            if len(out['indirectDescriptors']) >= limit:
                out['truncated'] = True
                out['notes'].append('间接表达到上限 %d 个描述符，停止' % limit)
                break
            if cursor in indirect_seen:
                out['cycle'] = True
                out['violations'].append('间接描述符表里 next 形成环（回到下标 %d）' % cursor)
                break
            indirect_seen.add(cursor)
            descriptor = read_desc_gdb(layout, table, cursor)
            out['indirectDescriptors'].append(descriptor)
            out['totalLength'] += descriptor['len'] or 0
            if not descriptor['hasNext']:
                break
            cursor = descriptor['next']
        if not out['indirectDescriptors']:
            out['violations'].append('这是间接描述符，但间接表里一个描述符都没读到')
        out['notes'].append(
            '描述符 %d 带 INDIRECT：主环里那一个描述符本身不指向数据，它指向 0x%x 的间接表，'
            '表里有 %d 个描述符' % (head, table, len(out['indirectDescriptors'])))
    return out


def read_desc_state_gdb(layout, vq, limit=None):
    """读 `vq->split.desc_state[]`：**唯一权威**的"第几个描述符头属于哪个请求"。"""
    notes = []
    out = {'owners': [], 'occupied': 0, 'distinctTokens': 0, 'tokenHeads': {}, 'notes': notes,
           'address': vq.get('descStateAddress')}
    desc_state = vq.get('descStateAddress')
    out['amount'] = 0
    if not desc_state:
        notes.append('desc_state 地址为空：拿不到"描述符头 → 请求"的关联，只能靠地址推算')
        return out
    stride = layout['sizes']['vring_desc_state_split'] or 16
    data_offset = layout['vring_desc_state_split'].get('data')
    indir_offset = layout['vring_desc_state_split'].get('indir_desc')
    total = vq.get('num') or 0
    count = total if limit is None else min(total, limit)
    if total > count:
        notes.append('环长 %d 超过本次上限 %d，只读了前 %d 个槽' % (total, count, count))
    out['amount'] = count
    tokens = set()
    for head in range(count):
        base = desc_state + head * stride
        token = u64_at(base + (data_offset or 0))
        indirect = u64_at(base + indir_offset) if indir_offset is not None else None
        owner = {'head': head, 'token': token if token else None,
                 'indirectDescriptor': indirect if indirect else None, 'address': base}
        out['owners'].append(owner)
        if owner['token'] is not None:
            out['occupied'] += 1
            tokens.add(owner['token'])
            out['tokenHeads'].setdefault(format(owner['token'], 'x'), []).append(head)
    out['distinctTokens'] = len(tokens)
    return out


def read_bio_gdb(layout, address, max_vectors=MAX_BIO_VECTORS):
    """读一个 `struct bio`。`totalBytes`/`doneBytes`/区间一律按向量表与游标反算。"""
    notes = []
    violations = []
    out = read_fields(layout, 'bio', address, [
        ('opf', 'opf', 4, False),
        ('biFlags', 'flags', 2, False),
        ('ioprio', 'ioprio', 2, False),
        ('writeHint', 'write_hint', 2, False),
        ('status', 'status', 1, False),
        ('sector', 'iter_sector', 8, False),
        ('bytesRemaining', 'iter_size', 4, False),
        ('idx', 'iter_idx', 4, False),
        ('bvecDone', 'iter_bvec_done', 4, False),
        ('vcnt', 'vcnt', 2, False),
        ('maxVecs', 'max_vecs', 2, False),
    ], notes)
    for key, field in (('next', 'next'), ('bdev', 'bdev'), ('endIo', 'end_io'),
                       ('private', 'private'), ('ioVecAddress', 'io_vec')):
        offset = layout['bio'].get(field)
        out[key] = u64_at(address + offset) if offset is not None else None
    out['address'] = address
    if out['opf'] is not None:
        out['opRaw'] = out['opf'] & ((1 << REQ_OP_BITS) - 1)
        out['flagBits'] = out['opf'] >> REQ_OP_BITS
        out['opSymbol'] = None
        for name, value in sorted(layout['enums']['req_op']['values'].items(), key=lambda item: item[1]):
            if value == out['opRaw']:
                out['opSymbol'] = name
                break
        table = layout['enums']['req_flag_bits']['values']
        names = [name.lstrip('_') for name, bit in sorted(table.items(), key=lambda item: item[1])
                 if (out['flagBits'] >> bit) & 1]
        out['flagNames'] = names
        out['isReadahead'] = '__REQ_RAHEAD' in table and bool((out['flagBits'] >> table['__REQ_RAHEAD']) & 1)
    vectors = []
    vcnt = out['vcnt'] or 0
    limit = min(vcnt, max_vectors)
    if vcnt > limit:
        notes.append('bi_vcnt = %d 超过本次读取上限 %d，只读前 %d 个向量' % (vcnt, limit, limit))
    if out['ioVecAddress'] and limit > 0:
        stride = layout['sizes']['bio_vec'] or 16
        v = layout['bio_vec']
        for index in range(limit):
            base = out['ioVecAddress'] + index * stride
            page = u64_at(base + v['page']) if v.get('page') is not None else None
            length = read_unsigned(base + v['len'], width_of('bio_vec', 'len', 4)) if v.get('len') is not None else None
            offset = read_unsigned(base + v['offset'], width_of('bio_vec', 'offset', 4)) if v.get('offset') is not None else None
            vectors.append({'index': index, 'address': base, 'pageAddress': page if page else None,
                            'length': length, 'offset': offset})
    elif vcnt > 0:
        violations.append('bi_vcnt 大于 0 但 bi_io_vec 是空指针：拿不到向量表，这次 I/O 说不清搬的是哪些页')
    out['vectors'] = vectors
    total_bytes = sum((item['length'] or 0) for item in vectors)
    out['totalBytes'] = total_bytes
    out['doneBytes'] = None
    out['extentStart'] = None
    out['extentEnd'] = None
    if len(vectors) == vcnt:
        # `bio_advance()` 会同时推进 bi_sector 与游标：原始起点 = 当前起点 − 走过的扇区数。
        done = sum((item['length'] or 0) for item in vectors[:min(out['idx'] or 0, len(vectors))]) + (out['bvecDone'] or 0)
        out['doneBytes'] = done
        if out['bytesRemaining'] is not None and done + out['bytesRemaining'] != total_bytes:
            violations.append(
                '向量表一共 %d 字节，游标走过 %d 字节，而 bi_iter.bi_size（还没搬完）= %s：'
                '三者对不上（%d + %s ≠ %d）' % (total_bytes, done, out['bytesRemaining'],
                                                done, out['bytesRemaining'], total_bytes))
        if out['sector'] is not None:
            out['extentStart'] = out['sector'] - done // 512
            out['extentEnd'] = out['extentStart'] + (total_bytes + 511) // 512
    else:
        notes.append('向量表读不全（%d/%d），区间只能按游标给下限，真正的起点还要往前减掉已经搬完的字节'
                     % (len(vectors), vcnt))
        if out['sector'] is not None:
            out['extentStart'] = out['sector']
            out['extentEnd'] = out['sector'] + ((out['bytesRemaining'] or 0) + 511) // 512
    out['notes'] = notes
    out['violations'] = violations
    return out


def walk_bio_chain_gdb(layout, head, tail=None, limit=MAX_BIOS, max_vectors=MAX_BIO_VECTORS):
    """走一条 bio 链（`rq->bio` → `bi_next` → … → `rq->biotail`），并报出"缝"。"""
    out = {'bios': [], 'truncated': False, 'cycle': False, 'sectorStart': None,
           'sectorEnd': None, 'contiguous': False, 'seams': [], 'notes': []}
    seen = set()
    cursor = head
    while cursor:
        if cursor in seen:
            out['cycle'] = True
            out['notes'].append('bio 链在 0x%x 处回到已经访问过的节点：要么是环，要么遍历中途被改过' % cursor)
            break
        seen.add(cursor)
        if len(out['bios']) >= limit:
            out['truncated'] = True
            out['notes'].append('达到遍历上限 %d 个 bio，停止；链上可能还有更多' % limit)
            break
        bio = read_bio_gdb(layout, cursor, max_vectors)
        out['bios'].append(bio)
        out['notes'].extend('bio 0x%x：%s' % (cursor, line) for line in bio['violations'])
        if not bio['next']:
            break
        cursor = bio['next']
    if tail and out['bios'] and not out['truncated'] and not out['cycle']:
        last = out['bios'][-1]['address']
        if last != tail:
            out['notes'].append(
                '走到链尾时停在 0x%x，但 request->biotail 是 0x%x：两者不一致说明链被改过，'
                '或 bi_next 的偏移不对' % (last, tail))
    starts = [bio['extentStart'] for bio in out['bios'] if bio['extentStart'] is not None]
    ends = [bio['extentEnd'] for bio in out['bios'] if bio['extentEnd'] is not None]
    if starts:
        out['sectorStart'] = starts[0]
        out['sectorEnd'] = max(ends) if ends else None
    for index in range(1, len(out['bios'])):
        previous = out['bios'][index - 1]
        current = out['bios'][index]
        if previous['extentEnd'] is None or current['extentStart'] is None:
            continue
        if current['extentStart'] != previous['extentEnd']:
            out['seams'].append(
                '第 %d 与第 %d 个 bio 之间有缝：前一个结束于扇区 %s，后一个从扇区 %s 开始（差 %s 个扇区）'
                % (index, index + 1, previous['extentEnd'], current['extentStart'],
                   current['extentStart'] - previous['extentEnd']))
    out['contiguous'] = len(out['bios']) > 1 and not out['seams']
    return out


def pfn_for_page_address(layout, page_address, vmemmap_base):
    """页结构地址 → 页框号。推不出来就给 None，**不猜一个"最接近的"**。"""
    size = layout['sizes']['page']
    if not vmemmap_base or not size or page_address is None or page_address < vmemmap_base:
        return None, None
    delta = page_address - vmemmap_base
    return delta // size, delta % size


def link_bio_to_pages_gdb(layout, bio, vmemmap_base):
    """把一条 bio 的每个数据段落到 `struct page`/folio 上（本脚本自己换算页框号）。

    `bv_page` 只是页结构地址；"这一页属于哪个文件、在文件里的第几页"写在页自己的
    `mapping` 与 `index` 里。所以每一条都顺手把页读出来，Node 侧再与我方 folio 比。
    """
    links = []
    for vector in bio['vectors']:
        link = {
            'bioAddress': bio['address'],
            'bioVecIndex': vector['index'],
            'pageAddress': vector['pageAddress'],
            'pfn': None,
            'pfnRemainder': None,
            'offset': vector['offset'],
            'length': vector['length'],
            'end': (vector['offset'] or 0) + (vector['length'] or 0),
            'pageIndex': None,
            'pageMapping': None,
            'pageFlags': None,
            'error': None,
        }
        if not vector['pageAddress']:
            link['error'] = 'bv_page 是空指针：这一段没有页（FLUSH 这类不搬数据的 bio 会这样）'
            links.append(link)
            continue
        pfn, remainder = pfn_for_page_address(layout, vector['pageAddress'], vmemmap_base)
        link['pfn'] = pfn
        link['pfnRemainder'] = remainder
        if pfn is None:
            link['error'] = ('bv_page = 0x%x 减掉 vmemmap 基址之后不是 sizeof(struct page) 的整数倍'
                             '（或 vmemmap 基址解不出来）：这一页不属于这套 vmemmap 映射'
                             % vector['pageAddress'])
            links.append(link)
            continue
        page = read_page_struct(layout, vector['pageAddress'])
        link['pageIndex'] = page['index']
        link['pageMapping'] = page['mapping']
        link['pageFlags'] = page['pageFlags']
        links.append(link)
    return links


def lifecycle_gdb(vq, token_lookup, request):
    """在 GDB 侧**独立**再判一次请求的生命周期（判据同源，代码另写）。

    三个信号互相独立，缺一个就会把某一态说错：
    - `avail->idx` 与 `used->idx` 是设备与驱动之间公开的两个计数器，两者之差 = 环上没回来的个数；
    - `desc_state[head].data` 非空表示这个描述符还**被占着**（`detach_buf_split()` 会清空）；
    - `rq->state`（`enum mq_rq_state`）是请求自己在 blk-mq 里的状态。
    第三个是**必须**的：`virtblk_prep_rq()` 先 `blk_mq_start_request()`（置 IN_FLIGHT）
    再 `virtblk_add_req()`（进环），所以在"已经算在飞、还没进环"的那一瞬，环上没有 token、
    两个计数器也相等 —— 只看前两个信号会把"还没提交"说成"已经回收"，而回收之后
    tag 马上会被别的请求拿走，报错态会让面板把别人的 I/O 画到这一次写上。
    """
    out = {'phase': 'unknown', 'signals': {}, 'reasons': []}
    if vq is None or request is None:
        out['reasons'].append('缺少 virtqueue 或请求：判不了')
        return out
    token = request['pduAddress']
    heads = (token_lookup or {}).get('heads') or []
    in_ring = bool(token_lookup) and token_lookup.get('unique') is True
    outstanding = vq.get('outstanding')
    out['signals'] = {
        'token': token,
        'tokenHeads': heads,
        'availIdx': vq.get('availIdx'),
        'usedIdx': vq.get('usedIdx'),
        'outstanding': outstanding,
        'rqState': request.get('state'),
        'rqStateName': request.get('stateName'),
    }
    out['reasons'].append('avail->idx = %s、used->idx = %s → 环上没回来的有 %s 个'
                          % (vq.get('availIdx'), vq.get('usedIdx'), outstanding))
    out['reasons'].append('desc_state 里挂着这个 token 的槽：%s（描述符头下标）' % (heads if heads else '一个都没有'))
    out['reasons'].append('rq->state = %s（%s）' % (request.get('state'), request.get('stateName')))
    if in_ring:
        out['phase'] = 'completed-on-device' if outstanding == 0 else 'in-flight-on-device'
        out['reasons'].append(
            '环上还挂着这个 token：设备%s' % ('已经用完（两个计数器相等）、驱动还没回收'
                                              if outstanding == 0 else '还在处理（还有没回来的）'))
    else:
        name = request.get('stateName')
        if name == 'MQ_RQ_IN_FLIGHT':
            out['phase'] = 'not-submitted'
        elif name == 'MQ_RQ_COMPLETE':
            out['phase'] = 'completed-on-device'
        elif name == 'MQ_RQ_IDLE':
            out['phase'] = 'recycled'
        else:
            out['phase'] = 'recycled' if outstanding == 0 else 'not-submitted'
            out['reasons'].append('拿不到 rq->state 的名字，只能退回计数器口径（这两态本来就分不开，'
                                  '调用方必须把"关联不唯一"的理由一起显示）')
    return out


def describe_stop():
    """停点在哪：符号名 + 栈顶几帧 + `$pc`。停点决定了"此刻哪些字段已经写好"。"""
    out = {'frames': [], 'pc': None, 'symbolLine': None, 'notes': []}
    frame = safe(lambda: gdb.newest_frame())
    if frame is None:
        out['notes'].append('取当前栈帧失败：可能没停在任何地方')
        return out
    cursor = frame
    while cursor is not None and len(out['frames']) < 4:
        out['frames'].append(safe(lambda cursor=cursor: cursor.name()))
        cursor = safe(lambda cursor=cursor: cursor.older())
    out['pc'] = safe(lambda: u64(int(gdb.parse_and_eval('$pc'))))
    text = safe(lambda: gdb.execute('info symbol $pc', to_string=True))
    if text is not None:
        out['symbolLine'] = text.strip()
    return out


def read_registers():
    """停点处的通用寄存器（`$rdi`/`$rsi` 就是静态函数的第一、二个参数）。"""
    out = {}
    for name in ('rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9', 'rip', 'rsp'):
        value = safe(lambda name=name: u64(int(gdb.parse_and_eval('$' + name))))
        if value is not None:
            out[name] = value
    return out


def t07f_main():
    result = {
        'ok': True,
        'notes': [],
        'ambiguities': [],
        'inputs': {
            'request': REQUEST_HINT,
            'pdu': PDU_HINT,
            'vq': VQ_HINT,
            'file': FILE_HINT,
            'mapping': MAPPING_HINT,
            'pageIndex': PAGE_INDEX_HINT,
        },
    }
    try:
        layout = io_layout()
        result['layout'] = layout
        result['stop'] = describe_stop()
        result['registers'] = read_registers()

        # 一、请求本身。这一步读不出来，下面就全空。
        request = None
        if REQUEST_HINT in (0, None):
            result['notes'].append('没有给我方解析器的请求地址：请求及以下全部读不出来')
        else:
            request = read_request_gdb(layout, REQUEST_HINT)
            result['request'] = request
            if PDU_HINT not in (0, None) and PDU_HINT != request['pduAddress']:
                result['ambiguities'].append(
                    '我方给的 PDU 地址 0x%x 与 rq + sizeof(struct request) = 0x%x 不一致'
                    % (PDU_HINT, request['pduAddress']))

        # 二、请求私有区（设备看到的头）。
        pdu_address = None
        if PDU_HINT not in (0, None):
            pdu_address = PDU_HINT
        elif request is not None:
            pdu_address = request['pduAddress']
        if pdu_address:
            result['pdu'] = read_virtblk_req_gdb(layout, pdu_address)

        # 三、队列与硬件上下文（`rq->q` 与 `rq->mq_hctx` 都读，两条路互相对账）。
        if request is not None and request['queue']:
            result['queue'] = read_request_queue_gdb(layout, request['queue'])
        elif request is not None:
            result['ambiguities'].append('request->q 为空：这个请求不属于任何队列，拿不到设备侧的信息')
        if request is not None and request['mqHctx']:
            result['hwCtx'] = read_hw_ctx_gdb(layout, request['mqHctx'])
        elif request is not None:
            result['notes'].append('request->mq_hctx 为空：这是单队列（非 mq）路径，或者请求还没被派到硬件上下文上')
        queue = result.get('queue')
        hw = result.get('hwCtx')
        if queue and hw and hw['queue'] and queue['address'] != hw['queue']:
            result['ambiguities'].append(
                'rq->mq_hctx->queue = 0x%x，而 rq->q = 0x%x：两处给出的队列不是同一个'
                % (hw['queue'], queue['address']))

        # 四、驱动状态 virtio_blk（`queue->queuedata`，正是 `get_virtio_blk_vq()` 走的那一条）。
        vblk = None
        if queue and queue['queuedata']:
            vblk = read_virtio_blk_gdb(layout, queue['queuedata'])
            result['virtioBlk'] = vblk
            if queue['disk'] and vblk['disk'] and queue['disk'] != vblk['disk']:
                result['ambiguities'].append(
                    'queue->queuedata 指向的 virtio_blk 的 disk = 0x%x，而 rq->q->disk = 0x%x：'
                    '驱动状态与队列不是一套的' % (vblk['disk'], queue['disk']))
        elif queue:
            result['ambiguities'].append('request_queue.queuedata 为空：找不到驱动私有状态，无法从队列顺到 virtqueue')

        # 五、virtqueue：下标来自 `hctx->queue_num`（`vblk->vqs[queue_num].vq`）。
        vq = None
        source = None
        if VQ_HINT not in (0, None):
            vq = read_vq_gdb(layout, VQ_HINT)
            source = 'hint'
        elif vblk is not None and hw is not None and hw['queueNum'] is not None:
            stride = layout['sizes']['virtio_blk_vq'] or 64
            slot = vblk['vqs'] + hw['queueNum'] * stride if vblk['vqs'] else None
            if slot and layout['virtio_blk_vq'].get('vq') is not None:
                pointer = u64_at(slot + (layout['virtio_blk_vq']['vq'] or 0))
                if pointer:
                    vq = read_vq_gdb(layout, pointer)
                    source = 'vblk->vqs[%d]' % hw['queueNum']
                else:
                    result['ambiguities'].append(
                        'vblk->vqs[%d] 是空指针：这个硬件上下文没有对应的 virtqueue' % hw['queueNum'])
        elif vblk is not None:
            result['notes'].append('没有硬件上下文（rq->mq_hctx 为空），取不到 queue_num，无法定位是哪个 virtqueue')
        if vq is not None:
            vq['resolvedFrom'] = source
            result['vq'] = vq

        # 六、环上"哪个描述符头属于这个请求" + 两个公开计数器。
        token = pdu_address
        if vq is not None:
            owners = read_desc_state_gdb(layout, vq)
            result['owners'] = owners
            result['availRing'] = read_avail_ring_gdb(layout, vq['availAddress'], vq['num'] or 0)
            result['usedRing'] = read_used_ring_gdb(layout, vq['usedAddress'], vq['num'] or 0)
            heads = owners['tokenHeads'].get(format(token, 'x'), []) if token else []
            lookup = {'token': token, 'heads': heads, 'unique': len(heads) == 1, 'ambiguity': None}
            if token is None:
                lookup['ambiguity'] = '没有请求私有区地址，无法在环上按 token 找这个请求'
            elif not heads:
                lookup['ambiguity'] = 'desc_state 里没有任何槽挂着这个 token：请求还不在环上，或者已经被回收'
            elif len(heads) > 1:
                lookup['ambiguity'] = ('desc_state 里有 %d 个槽挂着同一个 token（%s）：'
                                       '同一个请求被加进队列两次，或者内存被改过' % (len(heads), heads))
            result['tokenLookup'] = lookup
            if heads:
                chain = walk_desc_chain_gdb(layout, vq, heads[0])
                result['descriptorChain'] = chain
                # 段的个数的第二条独立证据：`virtblk_add_req()` 把 sg 表摊成
                # `1 + nents + 1` 段（请求头 + 数据段 + 状态），不依赖地址换算。
                pdu = result.get('pdu')
                if pdu and pdu['outTypeSymbol'] in ('VIRTIO_BLK_T_IN', 'VIRTIO_BLK_T_OUT') and pdu['sgNents'] is not None:
                    segments = chain['indirectDescriptors'] if chain['indirect'] else chain['descriptors']
                    expected = 1 + pdu['sgNents'] + 1
                    result['segmentReconciliation'] = {
                        'descriptors': len(segments), 'expected': expected,
                        'sgNents': pdu['sgNents'], 'indirect': chain['indirect'],
                    }
                    if len(segments) != expected:
                        result['ambiguities'].append(
                            '描述符链有 %d 段，而按私有区算应当是 %d 段（1 个请求头 + %d 个数据段 + 1 个状态）'
                            % (len(segments), expected, pdu['sgNents']))

        # 七、bio 链与"每一段落在哪个页上"。
        if request is not None:
            chain = walk_bio_chain_gdb(layout, request['bio'], request['bioTail'])
            result['bioChain'] = {key: value for key, value in chain.items() if key != 'bios'}
            result['bios'] = chain['bios']
            vmemmap = safe(lambda: resolve_vmemmap(layout, 0))
            base = (vmemmap or {}).get('base')
            result['vmemmap'] = {
                'base': base,
                'pageStructSize': layout['sizes']['page'],
                'notes': (vmemmap or {}).get('notes'),
            }
            links = []
            for bio in chain['bios']:
                links.extend(link_bio_to_pages_gdb(layout, bio, base))
            result['bioFolioLinks'] = links
            if chain['bios'] and chain['sectorStart'] is not None and request['sector'] is not None:
                if chain['sectorStart'] != request['sector']:
                    result['ambiguities'].append(
                        'rq->__sector = %s，而 rq->bio 链的起点是 %s：请求区间与第一个 bio 的区间不一致'
                        % (request['sector'], chain['sectorStart']))
            carried = [link for link in links if link['pageIndex'] == PAGE_INDEX_HINT]
            result['carriedPages'] = carried

        # 八、标签表：`tag` 会被复用，要回 `tags->rqs[tag]` 确认这个请求 ID 现在真的属于它。
        if hw is not None and hw['tags'] and request is not None and (request['tag'] or 0) >= 0:
            tags = read_tags_gdb(layout, hw['tags'], limit=(request['tag'] or 0) + 8)
            result['tags'] = tags
            slot = next((item for item in tags['tagged'] if item['tag'] == request['tag']), None)
            if slot is None:
                result['notes'].append('标签表只读到 %d 个槽，没覆盖 tag %s，无法核对'
                                       % (len(tags['tagged']), request['tag']))
            elif slot['request'] and slot['request'] != request['address']:
                result['ambiguities'].append(
                    'tags->rqs[%s] = 0x%x，而这次解析的请求在 0x%x：tag 已经被复用（或读错了请求），'
                    'tag 不能当唯一身份' % (request['tag'], slot['request'], request['address']))

        # 九、文件一侧：file → address_space → 页缓存（XArray）→ 那一个页。
        file_record = None
        if FILE_HINT not in (0, None):
            file_record = read_file(layout, FILE_HINT)
            result['file'] = file_record
        mapping_address = None
        if MAPPING_HINT not in (0, None):
            mapping_address = MAPPING_HINT
        elif file_record is not None:
            mapping_address = file_record['fMapping']
        if mapping_address:
            mapping = read_address_space(layout, mapping_address)
            result['addressSpace'] = mapping
            if file_record is not None and file_record['fMapping'] and file_record['fMapping'] != mapping_address:
                result['notes'].append('我方给的 address_space 与 file->f_mapping 不是同一个')
            xarray = walk_xarray(layout, mapping['pagesAddress'])
            result['ipages'] = {
                'head': xarray['head'],
                'headKind': xarray.get('headKind'),
                'rootShift': xarray.get('rootShift'),
                'nodeAddresses': xarray['nodeAddresses'],
                'entries': [{'index': entry['index'], 'kind': entry['kind'], 'pointer': entry['pointer']}
                            for entry in xarray['entries'][:8]],
                'violations': xarray['violations'],
                'notes': xarray['notes'],
            }
            if PAGE_INDEX_HINT is not None and PAGE_INDEX_HINT >= 0:
                entry = read_xarray_entry(layout, mapping['pagesAddress'], PAGE_INDEX_HINT)
                record = {'index': PAGE_INDEX_HINT, 'present': entry.get('present'),
                          'kind': entry.get('kind'), 'pointer': entry.get('pointer'),
                          'reason': entry.get('reason'), 'steps': entry.get('steps')}
                if entry.get('pointer'):
                    record['page'] = read_page_struct(layout, entry['pointer'])
                result['pageCacheEntry'] = record

        # 十、生命周期结论（GDB 侧独立判一次）。
        result['lifecycle'] = lifecycle_gdb(result.get('vq'), result.get('tokenLookup'), request)
        result['widths'] = dict(WIDTH_CACHE)
    except Exception as exc:
        result['ok'] = False
        result['error'] = '%s: %s' % (type(exc).__name__, exc)
        result['traceback'] = traceback.format_exc().splitlines()[-8:]

    with open(OUT_PATH, 'w') as handle:
        json.dump(result, handle)
    gdb.write('[t07f] 对照数据已写入 %s\n' % OUT_PATH)


t07f_main()
