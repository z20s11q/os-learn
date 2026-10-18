# T07c 的独立对照实现（GDB 侧）。
#
# 类型、偏移与 sizeof 来自 GDB 的 DWARF，current/mm 由 %gs + pcpu_hot.current_task 求出。
# 本脚本逐级遍历页表并从 enum pageflags 求位号，供 Node 侧与解析器独立对照。
# 直映射偏移由 mm->pgd - CR3 求出，检查 512 GiB 对齐与内核半区归属。
# Node 侧生成路径和输入后将脚本 source 进 GDB，结果写入 JSON 文件。
#
# 用法：gdb 里 `source t07c-gdb-reference.py`；输出路径与输入参数写在文件顶部的占位符里。

import json
import traceback

import gdb

OUT_PATH = __OUT_PATH__
# 页表遍历目标线性地址；0 表示跳过该目标。
VA = __VA__
# 可选的第二个线性地址；0 表示跳过该目标。
VA2 = __VA2__
# struct page 的目标页框号；0 表示跳过指定页框读取。
PFN = __PFN__
# mm_struct 地址提示；0 表示使用 current->mm。
MM_HINT = __MM__
# 停点帧的 CR3 提示；0 表示由 GDB 读取寄存器。
CR3_HINT = __CR3__

MASK64 = (1 << 64) - 1
ULONG_MAX = (1 << 64) - 1
# `arch/x86/include/asm/pgtable_types.h`：长模式下物理地址是低 52 位，
# `PHYSICAL_PAGE_MASK` 再去掉页内偏移的 12 位。
PHYSICAL_ADDRESS_MASK = 0x000FFFFFFFFFF000
# 稀疏内存：一个 section 覆盖 2^27 字节，页框号右移 15 位就是 section 号。
PFN_SECTION_SHIFT_FALLBACK = 15
# `SECTION_MAP_MASK = ~(BIT(SECTION_MAP_LAST_BIT) - 1)`，ZONE_DEVICE 关闭时是 ~0xF。
SECTION_MAP_MASK = MASK64 & ~0xF
# maple_type 与节点掩码来自 include/linux/maple_tree.h，Node 侧对照源码取值。
MAPLE_DENSE = 0
MAPLE_LEAF_64 = 1
MAPLE_RANGE_64 = 2
MAPLE_ARANGE_64 = 3
MAPLE_TYPE_NAMES = ['maple_dense', 'maple_leaf_64', 'maple_range_64', 'maple_arange_64']
MAPLE_NODE_MASK = 255
MAPLE_RESERVED_RANGE = 4096
MT_FLAGS_ALLOC_RANGE = 0x01
MT_FLAGS_HEIGHT_MASK = 0x7C
MT_FLAGS_HEIGHT_OFFSET = 0x02
# 页表条目的位定义（arch/x86/include/asm/pgtable_types.h，都是 #define）。
PTE_PRESENT = 1 << 0
PTE_RW = 1 << 1
PTE_USER = 1 << 2
PTE_ACCESSED = 1 << 5
PTE_DIRTY = 1 << 6
PTE_PS = 1 << 7
PTE_GLOBAL = 1 << 8
PTE_NX = 1 << 63
# `enum pageflags` 的名字顺序（include/linux/page-flags.h）；位号交给 GDB 求值。
PAGE_FLAG_NAMES = [
    'PG_locked', 'PG_writeback', 'PG_referenced', 'PG_uptodate', 'PG_dirty',
    'PG_lru', 'PG_head', 'PG_waiters', 'PG_active', 'PG_workingset',
    'PG_owner_priv_1', 'PG_owner_2', 'PG_arch_1', 'PG_reserved', 'PG_private',
    'PG_private_2', 'PG_reclaim', 'PG_swapbacked', 'PG_unevictable', 'PG_mlocked',
    'PG_arch_2',
]
# page_type 高 8 位按 page-flags.h 的 enum pagetype 分类，Node 侧与源码对账。
PAGE_TYPE_NAMES = {
    0xF0: 'PGTY_buddy', 0xF1: 'PGTY_offline', 0xF2: 'PGTY_table', 0xF3: 'PGTY_guard',
    0xF4: 'PGTY_hugetlb', 0xF5: 'PGTY_slab', 0xF6: 'PGTY_zsmalloc',
    0xF7: 'PGTY_unaccepted', 0xFF: 'PGTY_mapcount_underflow',
}
PAGE_MAPPING_ANON = 0x1
PAGE_MAPPING_FLAGS = 0x3
MAX_NODES = 4096
MAX_DEPTH = 31


def u64(value):
    """将 GDB 的有符号寄存器值按掩码归一为无符号 64 位地址。"""
    return value & MASK64


def mem_bytes(address, length):
    return gdb.selected_inferior().read_memory(int(address), int(length)).tobytes()


def u64_at(address):
    return int.from_bytes(mem_bytes(address, 8), byteorder='little', signed=False)


def u32_at(address):
    return int.from_bytes(mem_bytes(address, 4), byteorder='little', signed=False)


def u8_at(address):
    return mem_bytes(address, 1)[0]


def off(type_name, field_path):
    """由 GDB 的 DWARF 计算字段偏移这一编译期常量。"""
    return int(gdb.parse_and_eval('(unsigned long)&((struct %s *)0)->%s' % (type_name, field_path)))


def size_of(type_name):
    return int(gdb.parse_and_eval('sizeof(struct %s)' % type_name))


def member_bytes(type_name, member):
    """由 DWARF 求数组成员总宽度，除以元素宽度得到个数。"""
    return int(gdb.parse_and_eval('sizeof(((struct %s *)0)->%s)' % (type_name, member)))


def safe(read, default=None):
    try:
        return read()
    except Exception:
        return default


def dwarf_layout():
    """本脚本用到的全部偏移与宽度，一律现场问 GDB。"""
    return {
        'sizes': {
            'page': size_of('page'),
            'folio': size_of('folio'),
            'mm_struct': size_of('mm_struct'),
            'vm_area_struct': size_of('vm_area_struct'),
            'maple_node': size_of('maple_node'),
            'maple_tree': size_of('maple_tree'),
            'mem_section': safe(lambda: size_of('mem_section')),
        },
        'page': {
            'flags': off('page', 'flags'),
            'compound_head': off('page', 'compound_head'),
            'mapping': off('page', 'mapping'),
            'index': off('page', 'index'),
            'page_type': off('page', 'page_type'),
            'mapcount': off('page', '_mapcount'),
            'refcount': off('page', '_refcount'),
        },
        'folio': {
            'flags': off('folio', 'flags'),
            'mapping': off('folio', 'mapping'),
            'index': off('folio', 'index'),
            'page': off('folio', 'page'),
            'mapcount': off('folio', '_mapcount'),
            'refcount': off('folio', '_refcount'),
            'nr_pages': off('folio', '_folio_nr_pages'),
            'page_type_via_page': off('folio', 'page.page_type'),
        },
        'file': {
            'f_mapping': off('file', 'f_mapping'),
        },
        'tree': {
            'ma_flags': off('maple_tree', 'ma_flags'),
            'ma_root': off('maple_tree', 'ma_root'),
        },
        'nodes': {
            'leaf_pivot': off('maple_range_64', 'pivot'),
            'leaf_pivot_count': member_bytes('maple_range_64', 'pivot') // 8,
            'leaf_slot': off('maple_range_64', 'slot'),
            'leaf_slot_count': member_bytes('maple_range_64', 'slot') // 8,
            'leaf_meta': off('maple_range_64', 'meta'),
            'arange_pivot': off('maple_arange_64', 'pivot'),
            'arange_pivot_count': member_bytes('maple_arange_64', 'pivot') // 8,
            'arange_slot': off('maple_arange_64', 'slot'),
            'arange_slot_count': member_bytes('maple_arange_64', 'slot') // 8,
            'arange_gap': off('maple_arange_64', 'gap'),
            'arange_gap_count': member_bytes('maple_arange_64', 'gap') // 8,
            'arange_meta': off('maple_arange_64', 'meta'),
            'dense_slot': off('maple_node', 'slot'),
            'dense_slot_count': member_bytes('maple_node', 'slot') // 8,
            'meta_end': off('maple_metadata', 'end'),
            'meta_gap': off('maple_metadata', 'gap'),
        },
        'mem_section': {
            'section_mem_map': safe(lambda: off('mem_section', 'section_mem_map')),
        },
    }


def node_type_of(entry):
    return (entry >> 3) & 0x0F


def node_address_of(entry):
    return entry & ~MAPLE_NODE_MASK


def is_node(entry):
    return (entry & 3) == 2 and entry > MAPLE_RESERVED_RANGE


def is_leaf_type(node_type):
    """`ma_is_leaf()`：类型值小于 `maple_range_64` 的就是叶子（dense / leaf_64）。"""
    return node_type < MAPLE_RANGE_64


def read_node(layout, address, node_type, node_max):
    """读一个 maple 节点，交给我们的只有"父槽里编码出来的类型"，不读节点自己的 type 字段。

    节点自己的 `type`（偏移 36）只在拆树/释放路径被写过，活节点上那一带是被 `pivot[3]`
    覆盖住的垃圾；用 `node->type` 判类型会读出别的数字。
    """
    nodes = layout['nodes']
    bytes_at = mem_bytes(address, layout['sizes']['maple_node'])
    if node_type in (MAPLE_LEAF_64, MAPLE_RANGE_64):
        pivot_off, pivot_count = nodes['leaf_pivot'], nodes['leaf_pivot_count']
        slot_off, slot_count = nodes['leaf_slot'], nodes['leaf_slot_count']
        meta_off = nodes['leaf_meta']
        gap_off, gap_count = None, 0
    elif node_type == MAPLE_ARANGE_64:
        pivot_off, pivot_count = nodes['arange_pivot'], nodes['arange_pivot_count']
        slot_off, slot_count = nodes['arange_slot'], nodes['arange_slot_count']
        meta_off = nodes['arange_meta']
        gap_off, gap_count = nodes['arange_gap'], nodes['arange_gap_count']
    else:
        pivot_off, pivot_count = 0, 0
        slot_off, slot_count = nodes['dense_slot'], nodes['dense_slot_count']
        meta_off = None
        gap_off, gap_count = None, 0

    pivots = []
    for index in range(pivot_count):
        start = pivot_off + index * 8
        pivots.append(int.from_bytes(bytes_at[start:start + 8], byteorder='little', signed=False))
    slots = []
    for index in range(slot_count):
        start = slot_off + index * 8
        slots.append(int.from_bytes(bytes_at[start:start + 8], byteorder='little', signed=False))
    gaps = None
    if gap_count > 0:
        gaps = []
        for index in range(gap_count):
            start = gap_off + index * 8
            gaps.append(int.from_bytes(bytes_at[start:start + 8], byteorder='little', signed=False))
    meta_end = None
    meta_gap = None
    if meta_off is not None:
        meta_end = bytes_at[meta_off + nodes['meta_end']]
        meta_gap = bytes_at[meta_off + nodes['meta_gap']]

    # ---- 第一条规则：mas_data_end()（lib/maple_tree.c:1438） ----
    if node_type == MAPLE_ARANGE_64:
        data_end = meta_end if meta_end is not None else 0
    elif node_type == MAPLE_DENSE:
        data_end = -1
        for index in range(slot_count):
            if slots[index] != 0:
                data_end = index
    else:
        last_pivot = pivots[pivot_count - 1] if pivot_count > 0 else 0
        if last_pivot == 0:
            data_end = meta_end if meta_end is not None else 0
        elif last_pivot == node_max:
            data_end = pivot_count - 1
        else:
            data_end = pivot_count

    # ---- 第二条规则：内核自带 dumper 的停机条件（mt_dump_range64/mt_dump_arange64） ----
    if node_type == MAPLE_DENSE:
        dump_end = data_end
    else:
        last = -1
        is_arange = node_type == MAPLE_ARANGE_64
        for index in range(slot_count):
            if index < pivot_count:
                upper = pivots[index]
            elif is_arange:
                if slots[index] == 0:
                    break
                upper = node_max
            else:
                # 最后一个槽为空且本节点不是根时停机（`max != mt_node_max()`，
                # 非 dense 节点的 mt_node_max 就是 ULONG_MAX）。
                if slots[index] == 0 and node_max != ULONG_MAX:
                    break
                upper = node_max
            if upper == 0 and index > 0:
                break
            last = index
            if upper == node_max:
                break
        dump_end = last

    return {
        'address': address,
        'type': node_type,
        'typeName': MAPLE_TYPE_NAMES[node_type] if node_type < len(MAPLE_TYPE_NAMES) else 'unknown',
        'isLeaf': is_leaf_type(node_type),
        'pivotCount': pivot_count,
        'slotCount': slot_count,
        'pivots': pivots,
        'slots': slots,
        'gaps': gaps,
        'metaEnd': meta_end,
        'metaGap': meta_gap,
        'dataEnd': data_end,
        'dumpEnd': dump_end,
        'dataEndAgrees': data_end == dump_end,
    }


def walk_tree(layout, tree_address):
    """从 `maple_tree` 出发，把每个叶子槽连同它覆盖的下标区间交出来。

    槽区间的语义：`pivot[i]` 是第 i 槽的**闭区间上界**，下界是上一槽的上界 +1
    （第一个槽用父给的 min）。这是后面"槽区间必须等于 `[vm_start, vm_end-1]`"
    那条不变量的基础。
    """
    tree_flags = u32_at(tree_address + layout['tree']['ma_flags'])
    root_raw = u64_at(tree_address + layout['tree']['ma_root'])
    result = {
        'address': tree_address,
        'maFlags': tree_flags,
        'maRoot': root_raw,
        'heightField': (tree_flags & MT_FLAGS_HEIGHT_MASK) >> MT_FLAGS_HEIGHT_OFFSET,
        'allocRange': (tree_flags & MT_FLAGS_ALLOC_RANGE) != 0,
        'entries': [],
        'nodes': [],
        'nullSlots': 0,
        'nodesVisited': 0,
        'maxDepth': 0,
        'truncated': False,
        'cycle': False,
        'violations': [],
        'notes': [],
    }
    stack = []
    if root_raw == 0:
        result['rootKind'] = 'empty'
    elif is_node(root_raw):
        result['rootKind'] = 'node'
        stack.append({
            'nodeAddress': node_address_of(root_raw),
            'type': node_type_of(root_raw),
            'min': 0,
            'max': ULONG_MAX,
            'depth': 1,
        })
    else:
        result['rootKind'] = 'single-entry'
        result['notes'].append('ma_root 不是节点指针：单条目树，数据直接躺在根指针里，只覆盖下标 0')
        result['entries'].append({
            'min': 0, 'max': 0, 'value': root_raw, 'depth': 1,
            'nodeAddress': 0, 'nodeType': -1, 'slotIndex': 0, 'path': [],
        })

    seen = set()
    while stack:
        frame = stack.pop()
        if result['nodesVisited'] >= MAX_NODES:
            result['truncated'] = True
            result['notes'].append('访问节点数达到上限 %d' % MAX_NODES)
            break
        if frame['depth'] > MAX_DEPTH:
            result['truncated'] = True
            break
        key = frame['nodeAddress']
        if key in seen:
            result['cycle'] = True
            result['violations'].append('节点 0x%x 被访问了两次：树里有环' % key)
            continue
        seen.add(key)
        result['nodesVisited'] += 1
        result['maxDepth'] = max(result['maxDepth'], frame['depth'])
        if frame['type'] != MAPLE_DENSE and frame['nodeAddress'] % 256 != 0:
            result['violations'].append('节点 0x%x 不是 256 字节对齐' % frame['nodeAddress'])

        try:
            node = read_node(layout, frame['nodeAddress'], frame['type'], frame['max'])
        except Exception as exc:
            result['violations'].append('读节点 0x%x 失败：%s' % (frame['nodeAddress'], exc))
            continue
        result['nodes'].append({
            'address': node['address'], 'type': node['type'], 'typeName': node['typeName'],
            'dataEnd': node['dataEnd'], 'dumpEnd': node['dumpEnd'],
            'min': frame['min'], 'max': frame['max'], 'depth': frame['depth'],
        })
        if not node['dataEndAgrees']:
            result['violations'].append(
                '节点 0x%x 两条 data_end 规则不一致：%d vs %d'
                % (node['address'], node['dataEnd'], node['dumpEnd']))

        children = []
        first = frame['min']
        for index in range(node['slotCount']):
            if node['type'] == MAPLE_DENSE:
                upper = frame['min'] + index
                if upper > frame['max']:
                    result['violations'].append('dense 节点槽 %d 越界' % index)
                    break
            elif index < node['pivotCount']:
                upper = node['pivots'][index]
            elif node['type'] == MAPLE_ARANGE_64:
                if node['slots'][index] == 0:
                    break
                upper = frame['max']
            else:
                if node['slots'][index] == 0 and frame['max'] != ULONG_MAX:
                    break
                upper = frame['max']
            if upper == 0 and index > 0 and node['type'] != MAPLE_DENSE:
                break
            value = node['slots'][index]
            slot = {
                'min': first, 'max': upper, 'value': value, 'depth': frame['depth'] + 1,
                'nodeAddress': node['address'], 'nodeType': node['type'], 'slotIndex': index,
                'path': [],
            }
            if node['isLeaf']:
                if value == 0:
                    result['nullSlots'] += 1
                else:
                    result['entries'].append(slot)
            elif value == 0:
                result['notes'].append(
                    '内部节点 0x%x 的槽 %d 是空的（区间 [0x%x, 0x%x]）'
                    % (node['address'], index, first, upper))
            elif is_node(value):
                children.append({
                    'nodeAddress': node_address_of(value),
                    'type': node_type_of(value),
                    'min': slot['min'],
                    'max': slot['max'],
                    'depth': frame['depth'] + 1,
                })
            else:
                result['violations'].append(
                    '内部节点 0x%x 的槽 %d 既不是空也不是节点指针' % (node['address'], index))
            if upper == frame['max']:
                break
            first = upper + 1
        for child in reversed(children):
            stack.append(child)
    return result


def read_current_and_mm(layout):
    """用 `%gs` 基址 + `pcpu_hot.current_task` 找 current，再取它的 mm。

    这条路径与我方解析器不同：我方走 `__per_cpu_offset[0]` 数组。两条机制必须算出
    同一个 current、同一个 mm，才算把"看的是哪个地址空间"这件事钉住。
    """
    out = {'notes': []}
    gs_base = safe(lambda: u64(int(gdb.parse_and_eval('$gs_base'))))
    pcpu_hot_link = safe(lambda: u64(int(gdb.parse_and_eval('(unsigned long)&pcpu_hot'))))
    out['gsBase'] = gs_base
    out['pcpuHotLinkAddress'] = pcpu_hot_link
    if gs_base is None or pcpu_hot_link is None:
        out['notes'].append('取不到 %gs 基址或 pcpu_hot 的链接地址，current 无法确定')
        return out
    current = u64_at(u64(gs_base + pcpu_hot_link))
    out['current'] = current
    task_off = {
        'pid': off('task_struct', 'pid'),
        'tgid': off('task_struct', 'tgid'),
        'comm': off('task_struct', 'comm'),
        'mm': off('task_struct', 'mm'),
    }
    out['taskOffsets'] = task_off
    out['pid'] = u32_at(current + task_off['pid'])
    out['tgid'] = u32_at(current + task_off['tgid'])
    comm_bytes = mem_bytes(current + task_off['comm'], 16)
    zero = comm_bytes.find(b'\x00')
    out['comm'] = (comm_bytes if zero < 0 else comm_bytes[:zero]).decode('utf-8', 'replace')
    mm_address = u64_at(current + task_off['mm'])
    out['mmAddress'] = mm_address
    if mm_address == 0:
        out['notes'].append('current->mm 是 0：这是内核线程，没有用户地址空间')
        return out
    mm_off = layout['mm']
    # 各字段按 DWARF 给出的宽度读取；mm_users/mm_count 的 atomic_t 为 4 字节。
    widths = {}
    values = {}
    for name, offset in mm_off.items():
        width = safe(lambda name=name: int(gdb.parse_and_eval(
            'sizeof(((struct mm_struct *)0)->%s)' % name)))
        widths[name] = width
        if width is None or width <= 0 or width > 8:
            continue
        values[name] = safe(lambda offset=offset, width=width: int.from_bytes(
            mem_bytes(mm_address + offset, width), byteorder='little', signed=False))
    out['mm'] = values
    out['mmFieldWidths'] = widths
    out['mmMtAddress'] = mm_address + off('mm_struct', 'mm_mt')
    return out


def build_mm_offsets():
    return {
        'mm_users': off('mm_struct', 'mm_users'),
        'mm_count': off('mm_struct', 'mm_count'),
        'pgd': off('mm_struct', 'pgd'),
        'task_size': off('mm_struct', 'task_size'),
        'map_count': off('mm_struct', 'map_count'),
        'total_vm': off('mm_struct', 'total_vm'),
        'locked_vm': off('mm_struct', 'locked_vm'),
        'data_vm': off('mm_struct', 'data_vm'),
        'exec_vm': off('mm_struct', 'exec_vm'),
        'stack_vm': off('mm_struct', 'stack_vm'),
        'pgtables_bytes': off('mm_struct', 'pgtables_bytes'),
        'start_code': off('mm_struct', 'start_code'),
        'end_code': off('mm_struct', 'end_code'),
        'start_data': off('mm_struct', 'start_data'),
        'end_data': off('mm_struct', 'end_data'),
        'start_brk': off('mm_struct', 'start_brk'),
        'brk': off('mm_struct', 'brk'),
        'start_stack': off('mm_struct', 'start_stack'),
        'arg_start': off('mm_struct', 'arg_start'),
        'arg_end': off('mm_struct', 'arg_end'),
        'env_start': off('mm_struct', 'env_start'),
        'env_end': off('mm_struct', 'env_end'),
        'mmap_base': off('mm_struct', 'mmap_base'),
        'mmap_legacy_base': off('mm_struct', 'mmap_legacy_base'),
        'def_flags': off('mm_struct', 'def_flags'),
        'exe_file': off('mm_struct', 'exe_file'),
    }


def read_vmas(vma_type, entries):
    """按叶子槽给出的地址逐条读 vm_area_struct（GDB 自己的类型解释）。"""
    out = []
    for entry in entries:
        address = entry['value']
        record = {'address': address, 'slotMin': entry['min'], 'slotMax': entry['max'],
                  'depth': entry['depth'], 'slotIndex': entry['slotIndex']}
        try:
            vma = gdb.Value(address).cast(vma_type.pointer()).dereference()
            record['vm_start'] = safe(lambda: u64(int(vma['vm_start'])))
            record['vm_end'] = safe(lambda: u64(int(vma['vm_end'])))
            # `vm_flags` 在 DWARF 里带 const 限定，`__vm_flags` 与它同偏移但更省事；
            # 两个都试着读，读到的值应当一样。
            record['vm_flags_const'] = safe(lambda: u64(int(vma['vm_flags'])))
            record['vm_flags'] = safe(lambda: u64(int(vma['__vm_flags'])))
            record['vm_pgoff'] = safe(lambda: u64(int(vma['vm_pgoff'])))
            record['vm_mm'] = safe(lambda: u64(int(vma['vm_mm'])))
            record['vm_file'] = safe(lambda: u64(int(vma['vm_file'])))
            record['anon_vma'] = safe(lambda: u64(int(vma['anon_vma'])))
            record['vm_ops'] = safe(lambda: u64(int(vma['vm_ops'])))
            record['vm_private_data'] = safe(lambda: u64(int(vma['vm_private_data'])))
            record['vm_lock_seq'] = safe(lambda: int(vma['vm_lock_seq']))
            record['detached'] = safe(lambda: int(vma['detached']))
        except Exception as exc:
            record['error'] = '%s: %s' % (type(exc).__name__, exc)
        out.append(record)
    return out


def account_vmas(vmas):
    """按 mm/vma.h 的 `vm_stat_account()` 重算四类小计（单位：页）。

    `is_stack_mapping()` 里还有一项 `flags & VM_SHADOW_STACK`，本内核
    `CONFIG_X86_USER_SHADOW_STACK=n` 时 `VM_SHADOW_STACK` 是 0，该项恒假，故省去。
    """
    VM_READ = 1 << 0
    VM_WRITE = 1 << 1
    VM_EXEC = 1 << 2
    VM_SHARED = 1 << 3
    VM_STACK = 1 << 8
    total = exec_pages = stack_pages = data_pages = 0
    for vma in vmas:
        start, end, flags = vma.get('vm_start'), vma.get('vm_end'), vma.get('vm_flags')
        if start is None or end is None or flags is None:
            continue
        pages = (end - start) >> 12
        total += pages
        is_exec = (flags & (VM_EXEC | VM_WRITE | VM_STACK)) == VM_EXEC
        is_stack = (flags & VM_STACK) == VM_STACK
        is_data = (flags & (VM_WRITE | VM_SHARED | VM_STACK)) == VM_WRITE
        if is_exec:
            exec_pages += pages
        elif is_stack:
            stack_pages += pages
        elif is_data:
            data_pages += pages
    return {
        'totalPages': total, 'execPages': exec_pages,
        'stackPages': stack_pages, 'dataPages': data_pages,
        'vmaCount': len(vmas),
        'bitsUsed': {'VM_READ': VM_READ, 'VM_WRITE': VM_WRITE, 'VM_EXEC': VM_EXEC,
                     'VM_SHARED': VM_SHARED, 'VM_STACK': VM_STACK},
    }


def pte_flags(raw):
    return {
        'present': (raw & PTE_PRESENT) != 0,
        'writable': (raw & PTE_RW) != 0,
        'user': (raw & PTE_USER) != 0,
        'accessed': (raw & PTE_ACCESSED) != 0,
        'dirty': (raw & PTE_DIRTY) != 0,
        'pageSize': (raw & PTE_PS) != 0,
        'global': (raw & PTE_GLOBAL) != 0,
        'noExecute': (raw & PTE_NX) != 0,
    }


def walk_page_table(page_offset_base, root_linear, root_physical, linear):
    """从原始条目独立遍历四级页表。

    PDPT 的 PS 位表示 1 GiB 大页，PD 的 PS 位表示 2 MiB 大页，命中后结束遍历。
    条目所在页一律用直映射线性地址读（页表页本身在内核直映射里）。
    """
    levels = [(39, 'PML4'), (30, 'PDPT'), (21, 'PD'), (12, 'PT')]
    walk = []
    table_linear = root_linear
    table_physical = root_physical
    physical = None
    page_size = None
    huge = False
    fault = None
    for position, (shift, name) in enumerate(levels):
        index = (linear >> shift) & 0x1FF
        entry_linear = table_linear + index * 8
        entry_physical = None if table_physical is None else table_physical + index * 8
        raw = u64_at(entry_linear)
        flags = pte_flags(raw)
        target = raw & PHYSICAL_ADDRESS_MASK
        record = {
            'level': 4 - position, 'name': name, 'index': index,
            'tableAddress': entry_physical, 'entryLinear': entry_linear,
            'raw': raw, 'targetPhysical': target, 'flags': flags,
        }
        walk.append(record)
        if not flags['present']:
            fault = {'kind': 'not-present', 'level': 4 - position,
                     'detail': '%s[%d] present=0' % (name, index)}
            break
        if shift == 30 and flags['pageSize']:
            huge = True
            page_size = 1 << 30
            physical = target + (linear & ((1 << 30) - 1))
            record['pageSizeBytes'] = page_size
            record['terminal'] = True
            break
        if shift == 21 and flags['pageSize']:
            huge = True
            page_size = 1 << 21
            physical = target + (linear & ((1 << 21) - 1))
            record['pageSizeBytes'] = page_size
            record['terminal'] = True
            break
        if shift == 12:
            page_size = 4096
            physical = target + (linear & 4095)
            record['pageSizeBytes'] = page_size
            record['terminal'] = True
            break
        record['terminal'] = False
        table_linear = page_offset_base + target
        table_physical = target
    return {
        'linear': linear, 'walk': walk, 'physical': physical,
        'pageSize': page_size, 'huge': huge, 'fault': fault,
    }


def read_page_struct(layout, page_address):
    """按 DWARF 的偏移直读一个 `struct page` / `struct folio`。

    用原始偏移而不是 GDB 的类型转换，是为了让"页与页之间的步长"这件事完全落在
    `sizeof(struct page)` 上：步长错了，这里读到的每个字段都会是别处的字节。
    """
    page = layout['page']
    folio = layout['folio']
    flags = u64_at(page_address + page['flags'])
    mapping = u64_at(page_address + page['mapping'])
    compound_head = u64_at(page_address + page['compound_head'])
    page_type = u32_at(page_address + page['page_type'])
    flags_bits = {}
    for name in PAGE_FLAG_NAMES:
        bit = safe(lambda name=name: int(gdb.parse_and_eval(name)))
        flags_bits[name] = bit
    set_flags = []
    for name, bit in flags_bits.items():
        if bit is None:
            continue
        if (flags & (1 << bit)) != 0:
            set_flags.append(name)
    nr_pages = None
    page_type_via_page = None
    if folio['page_type_via_page'] is not None and folio['page'] is not None:
        page_type_via_page = u32_at(page_address + folio['page'] + folio['page_type_via_page'])
    nr_pages = u32_at(page_address + folio['nr_pages'])
    page_type_code = (page_type >> 24) & 0xFF
    return {
        'address': page_address,
        'flags': flags,
        'pageFlags': sorted(set_flags),
        'flagBits': flags_bits,
        'compoundHeadRaw': compound_head,
        'isTail': (compound_head & 1) == 1,
        'compoundHeadAddress': (compound_head - 1) if (compound_head & 1) == 1 else None,
        'mapping': mapping,
        'mappingIsAnon': (mapping & PAGE_MAPPING_FLAGS) == PAGE_MAPPING_ANON,
        'anonVmaAddress': (mapping - PAGE_MAPPING_ANON) if (mapping & PAGE_MAPPING_FLAGS) == PAGE_MAPPING_ANON else None,
        'index': u64_at(page_address + page['index']),
        'pageType': page_type,
        'pageTypeCode': page_type_code,
        'pageTypeName': PAGE_TYPE_NAMES.get(page_type_code),
        'pageTypeHasType': page_type < 0xFF000000,
        'mapcount': int.from_bytes(mem_bytes(page_address + page['mapcount'], 4), 'little', signed=True),
        'refcount': int.from_bytes(mem_bytes(page_address + page['refcount'], 4), 'little', signed=True),
        'folioNrPages': nr_pages,
        'pageTypeViaFolioPage': page_type_via_page,
    }


def resolve_vmemmap(layout, pfn):
    """用 `mem_section` 现场解出 vmemmap 基址（`__pfn_to_page` 的加数）。

    推导链（mm/sparse.c 与 mm/internal.h 的 `sparse_init_one_section()`）：
    `section_mem_map` 里存的是 `mem_map - sectionStartPfn`，`sparse_decode_mem_map()`
    读的时候再加回 `section_nr_to_pfn()`，所以
        mem_map = (section_mem_map & SECTION_MAP_MASK) + sectionStartPfn
    VMEMMAP 形态下 `mem_map = vmemmap + startPfn * sizeof(struct page)`，于是
        vmemmap = mem_map - startPfn * sizeof(struct page)
    与"直接把掩码后的值当基址"的直觉写法相比，差着 `startPfn * sizeof(page) - startPfn`。
    """
    page_size = layout['sizes']['page']
    section_size = safe(lambda: size_of('mem_section'))
    out = {'pfn': pfn, 'pageStructSize': page_size, 'memSectionSize': section_size, 'notes': []}
    if section_size is None or section_size == 0:
        out['notes'].append('GDB 里取不到 sizeof(struct mem_section)，vmemmap 基址解不出来')
        return out
    section_number = pfn >> PFN_SECTION_SHIFT_FALLBACK
    section_start_pfn = section_number << PFN_SECTION_SHIFT_FALLBACK
    sections_per_root = 4096 // section_size
    symbol = safe(lambda: u64(int(gdb.parse_and_eval('(unsigned long)&mem_section'))))
    out.update({
        'sectionNumber': section_number,
        'sectionStartPfn': section_start_pfn,
        'sectionsPerRoot': sections_per_root,
        'memSectionSymbol': symbol,
        'sectionMemoryMapOffset': layout['mem_section']['section_mem_map'],
    })
    if symbol is None:
        out['notes'].append('符号表里没有 mem_section，vmemmap 基址解不出来（不能拿常量冒充）')
        return out
    root_array = u64_at(symbol)
    out['rootArray'] = root_array
    if root_array == 0:
        out['notes'].append('mem_section 根数组指针是 0：稀疏内存还没分配')
        return out
    root_index = section_number // sections_per_root
    section_array = u64_at(root_array + root_index * 8)
    out['rootIndex'] = root_index
    out['sectionArray'] = section_array
    if section_array == 0:
        out['notes'].append('根数组第 %d 项是 0：这一段物理内存不存在' % root_index)
        return out
    section_address = section_array + (section_number % sections_per_root) * section_size
    raw = u64_at(section_address + layout['mem_section']['section_mem_map'])
    mem_map = (raw & SECTION_MAP_MASK) + section_start_pfn
    base = mem_map - section_start_pfn * page_size
    out.update({
        'sectionAddress': section_address,
        'sectionMemMapRaw': raw,
        'markedPresent': (raw & 1) != 0,
        'hasMemMap': (raw & 2) != 0,
        'memMap': mem_map,
        'base': base,
        'aligned': (base % (1 << 39)) == 0,
        'inKernelHalf': base >= 0xFFFF800000000000,
    })
    return out


def main():
    result = {'ok': True, 'notes': []}
    try:
        layout = dwarf_layout()
        layout['mm'] = build_mm_offsets()
        result['layout'] = layout
        result['inputs'] = {'va': VA, 'pfn': PFN, 'mmHint': MM_HINT, 'cr3Hint': CR3_HINT}

        state = read_current_and_mm(layout)
        result['current'] = state
        result['notes'].extend(state.get('notes', []))
        mm_address = state.get('mmAddress', 0)
        if mm_address == 0:
            raise RuntimeError('current->mm 是 0，没有地址空间可解析')
        if MM_HINT not in (0, mm_address):
            result['notes'].append('我方给的 mm 地址与我方 GDB 侧读到的不一致（提示值先用着）')

        mm = state['mm']
        pgd = mm.get('pgd')
        cr3_register = safe(lambda: u64(int(gdb.parse_and_eval('$cr3'))))
        cr3 = CR3_HINT if CR3_HINT != 0 else cr3_register
        result['cr3'] = {'fromFrame': CR3_HINT, 'fromRegister': cr3_register, 'used': cr3}
        root_physical = None if cr3 is None else (cr3 & PHYSICAL_ADDRESS_MASK)
        page_offset_base = None
        if pgd is not None and root_physical not in (None, 0):
            page_offset_base = u64(pgd - root_physical)
            result['pageOffsetBase'] = {
                'base': page_offset_base,
                'rootPhysical': root_physical,
                'aligned': (page_offset_base % (1 << 39)) == 0,
                'inKernelHalf': page_offset_base >= 0xFFFF800000000000,
            }
        else:
            result['notes'].append('没有 CR3 或 pgd：直映射偏移解不出来，页表遍历只能给出线性地址与原始条目')

        # ---------- VMA 这棵树 ----------
        tree_address = state.get('mmMtAddress')
        tree = walk_tree(layout, tree_address)
        result['tree'] = tree
        vma_type = gdb.lookup_type('struct vm_area_struct')
        vmas = read_vmas(vma_type, tree['entries'])
        result['vmas'] = vmas
        result['accounting'] = account_vmas(vmas)

        # ---------- 页表遍历（同一套代码跑两个地址） ----------
        def translate(linear, label):
            if linear == 0 or page_offset_base is None:
                return None
            walk = walk_page_table(page_offset_base, pgd, root_physical, linear)
            walk['label'] = label
            if walk['physical'] is not None:
                walk['physicalBytes'] = mem_bytes(page_offset_base + walk['physical'], 8).hex()
            else:
                walk['physicalBytes'] = None
            return walk

        result['translation'] = translate(VA, 'va')
        result['translation2'] = translate(VA2, 'va2')

        # ---------- PFN -> struct page ----------
        result['vmemmap'] = resolve_vmemmap(layout, PFN) if PFN != 0 else None
        vmemmap = result['vmemmap']
        if vmemmap is not None and vmemmap.get('base') is not None:
            page_struct_size = layout['sizes']['page']
            address = vmemmap['base'] + PFN * page_struct_size
            result['folio'] = read_page_struct(layout, address)
        # 顶层 pgd 经 __get_free_pages() 分配，page_type 保持 UINT_MAX。
        # 下三级表页经 pagetable_pte_ctor() 标记为 PGTY_table << 24；两类分别与源码对账。
        if vmemmap is not None and vmemmap.get('base') is not None and root_physical not in (None, 0):
            cr3_page = read_page_struct(layout, vmemmap['base'] + (root_physical >> 12) * layout['sizes']['page'])
            result['cr3FramePage'] = cr3_page
        if vmemmap is not None and vmemmap.get('base') is not None:
            def table_pages(walk):
                """对遍历各级表页分别读取 struct page。"""
                if walk is None:
                    return None
                out = []
                for record in walk['walk']:
                    if record.get('terminal'):
                        continue
                    frame = record.get('targetPhysical')
                    if frame in (None, 0):
                        continue
                    pfn = frame >> 12
                    out.append({
                        'level': record['level'], 'name': record['name'],
                        'framePhysical': frame, 'pfn': pfn,
                        'page': read_page_struct(layout, vmemmap['base'] + pfn * layout['sizes']['page']),
                    })
                return out

            result['tablePages'] = table_pages(result.get('translation'))
            result['tablePages2'] = table_pages(result.get('translation2'))
        # 翻译出来的那个页框（VA 对应的物理页）也取一次 struct page：用来比 mapping/index。
        for key, name in (('translation', 'folioAtVa'), ('translation2', 'folioAtVa2')):
            walk = result.get(key)
            if walk is None or walk.get('physical') is None or vmemmap is None or vmemmap.get('base') is None:
                continue
            translated_pfn = ((walk['physical'] - (walk['physical'] & 0xFFF)) >> 12)
            walk['translatedPfn'] = translated_pfn
            result[name] = read_page_struct(layout, vmemmap['base'] + translated_pfn * layout['sizes']['page'])
    except Exception as exc:
        result['ok'] = False
        result['error'] = '%s: %s' % (type(exc).__name__, exc)
        result['traceback'] = traceback.format_exc().splitlines()[-8:]

    with open(OUT_PATH, 'w') as handle:
        json.dump(result, handle)
    gdb.write('[t07c] 对照数据已写入 %s\n' % OUT_PATH)


main()
