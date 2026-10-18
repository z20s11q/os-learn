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
# 我方解析器读到的 `files_struct` 地址（0 表示不给，用 current->files）。
FILES_HINT = __FILES__
# 要展开的 fd（-1 表示不展开）。
FD_HINT = __FD__
# 我方解析器读到的 `struct file` 地址（0 表示不给）。
FILE_HINT = __FILE__
# 我方解析器读到的 dentry 地址（0 表示不给）。
DENTRY_HINT = __DENTRY__
# 我方解析器读到的 inode 地址（0 表示不给）。
INODE_HINT = __INODE__
# 我方解析器读到的 address_space 地址（0 表示不给）。
MAPPING_HINT = __MAPPING__
# 页缓存里那个页的页框号（0 表示不额外取）。
PFN_HINT = __PFN__

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

    with open(OUT_PATH, 'w') as handle:
        json.dump(result, handle)
    gdb.write('[t07d] 对照数据已写入 %s\n' % OUT_PATH)


main()
