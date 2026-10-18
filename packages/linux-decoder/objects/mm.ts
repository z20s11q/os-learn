/** 地址空间、VMA 和 folio 解析；VMA 槽范围与 mm 计数核对，folio 由 PFN 经 vmemmap 寻址。
 * 空指针保留 null，读取失败独立报告覆盖缺口。
 */

import { CaptureReadError, memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef, Hex } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';
import type { AddressSpaceRef, FolioRef, VmaRef } from '../../contracts/os.ts';
import { MM_TYPE, StructBuffer, readStruct } from './task.ts';
import { walkMapleTree } from './maple.ts';
import type { MapleEntry } from './maple.ts';
import { PAGE_SHIFT, PAGE_SIZE, pageAddressForPfn, resolveVmemmapBase } from './page-table.ts';
import type { VmemmapFacts } from './page-table.ts';

export class AddressSpaceError extends CaptureReadError {}

export const VMA_TYPE = 'vm_area_struct';
export const FOLIO_TYPE = 'folio';
export const PAGE_TYPE = 'page';
export const MAPLE_TREE_TYPE = 'maple_tree';

/** `PAGE_MAPPING_ANON`：匿名页把 anon_vma 指针藏进 `page->mapping` 时置的第 0 位。 */
export const PAGE_MAPPING_ANON = 0x1n;
/** `PAGE_MAPPING_MOVABLE`：非 LRU 可移动页用它标记。 */
export const PAGE_MAPPING_MOVABLE = 0x2n;
export const PAGE_MAPPING_FLAGS = PAGE_MAPPING_ANON | PAGE_MAPPING_MOVABLE;

/* --------------------------------------------------------------------------
 * vm_flags
 * ------------------------------------------------------------------------ */

export interface VmaFlagBit {
  name: string;
  bit: number;
  /** 依赖的配置项；为 null 表示 mm.h 里是无条件定义的 */
  config: string | null;
  note?: string;
}

/** VM_* 掩码来自 include/linux/mm.h，验收时与该内核配置逐项核对。 */
export const VMA_FLAG_BITS: VmaFlagBit[] = [
  { name: 'VM_READ', bit: 0, config: null },
  { name: 'VM_WRITE', bit: 1, config: null },
  { name: 'VM_EXEC', bit: 2, config: null },
  { name: 'VM_SHARED', bit: 3, config: null },
  { name: 'VM_MAYREAD', bit: 4, config: null },
  { name: 'VM_MAYWRITE', bit: 5, config: null },
  { name: 'VM_MAYEXEC', bit: 6, config: null },
  { name: 'VM_MAYSHARE', bit: 7, config: null },
  { name: 'VM_GROWSDOWN', bit: 8, config: null },
  { name: 'VM_UFFD_MISSING', bit: 9, config: 'CONFIG_MMU', note: '未开 CONFIG_MMU 时这一位是 VM_MAYOVERLAY' },
  { name: 'VM_PFNMAP', bit: 10, config: null },
  { name: 'VM_UFFD_WP', bit: 12, config: null },
  { name: 'VM_LOCKED', bit: 13, config: null },
  { name: 'VM_IO', bit: 14, config: null },
  { name: 'VM_SEQ_READ', bit: 15, config: null },
  { name: 'VM_RAND_READ', bit: 16, config: null },
  { name: 'VM_DONTCOPY', bit: 17, config: null },
  { name: 'VM_DONTEXPAND', bit: 18, config: null },
  { name: 'VM_LOCKONFAULT', bit: 19, config: null },
  { name: 'VM_ACCOUNT', bit: 20, config: null },
  { name: 'VM_NORESERVE', bit: 21, config: null },
  { name: 'VM_HUGETLB', bit: 22, config: null },
  { name: 'VM_SYNC', bit: 23, config: null },
  { name: 'VM_ARCH_1', bit: 24, config: null },
  { name: 'VM_WIPEONFORK', bit: 25, config: null },
  { name: 'VM_DONTDUMP', bit: 26, config: null },
  { name: 'VM_SOFTDIRTY', bit: 27, config: 'CONFIG_MEM_SOFT_DIRTY', note: '没开这个配置时它的值是 0，也就是这一位不存在' },
  { name: 'VM_MIXEDMAP', bit: 28, config: null },
  { name: 'VM_HUGEPAGE', bit: 29, config: null },
  { name: 'VM_NOHUGEPAGE', bit: 30, config: null },
  { name: 'VM_MERGEABLE', bit: 31, config: null },
  { name: 'VM_HIGH_ARCH_0', bit: 32, config: 'CONFIG_ARCH_USES_HIGH_VMA_FLAGS', note: 'x86_64 上被 pkey 借用：VM_PKEY_BIT0' },
  { name: 'VM_HIGH_ARCH_1', bit: 33, config: 'CONFIG_ARCH_USES_HIGH_VMA_FLAGS', note: 'VM_PKEY_BIT1' },
  { name: 'VM_HIGH_ARCH_2', bit: 34, config: 'CONFIG_ARCH_USES_HIGH_VMA_FLAGS', note: 'VM_PKEY_BIT2' },
  { name: 'VM_HIGH_ARCH_3', bit: 35, config: 'CONFIG_ARCH_USES_HIGH_VMA_FLAGS', note: 'VM_PKEY_BIT3' },
  { name: 'VM_HIGH_ARCH_4', bit: 36, config: 'CONFIG_ARCH_USES_HIGH_VMA_FLAGS' },
  { name: 'VM_HIGH_ARCH_5', bit: 37, config: 'CONFIG_ARCH_USES_HIGH_VMA_FLAGS', note: '开了 shadow stack 时是 VM_SHADOW_STACK' },
  // 这些掩码在 mm.h 中直接定义。
  // 与其他 VM_* 位一起由源码重解析核对。
  // VM_SEALED 等位以名称展示内核映射状态。
  // 数值来源保留在各条目说明中。
  { name: 'VM_UFFD_MINOR', bit: 38, config: 'CONFIG_HAVE_ARCH_USERFAULTFD_MINOR', note: '源码里写成 `# define`（# 与 define 之间有空格），T07c 的宏表只收 `#define`，所以这一位不参与源码对账；本内核 CONFIG_USERFAULTFD 未开，位 38 不存在' },
  { name: 'VM_ALLOW_ANY_UNCACHED', bit: 39, config: 'CONFIG_64BIT', note: 'VFIO 与 KVM 之间约定"这段内存可以按非缓存内存用"' },
  { name: 'VM_DROPPABLE', bit: 40, config: 'CONFIG_64BIT', note: '非 64 位平台上是别的位（PPC32）或者根本不存在' },
  { name: 'VM_SEALED', bit: 63, config: 'CONFIG_64BIT', note: '被 `mseal()` 封住的 VMA；源码写作 `_BITUL(63)`' },
];

/** 记账用的位组合（来自 `mm/vma.h` 与 `include/linux/mm.h`）。 */
export const VM_BITS = {
  read: 1n << 0n,
  write: 1n << 1n,
  exec: 1n << 2n,
  shared: 1n << 3n,
  growdown: 1n << 8n,
  /** `VM_STACK = VM_GROWSDOWN`（CONFIG_STACK_GROWSUP 关闭时） */
  stack: 1n << 8n,
  account: 1n << 20n,
} as const;

export interface VmaFlagName extends VmaFlagBit {
  /** 这一位是否来自"依赖配置"的那张表 */
  conditional: boolean;
}

/** 按 enabledConfigs 筛选配置位；省略配置时用 conditional 标明来源。 */
export function decodeVmaFlags(
  flags: bigint,
  enabledConfigs: Set<string> | null = null,
): { names: VmaFlagName[]; unknownBits: bigint } {
  const names: VmaFlagName[] = [];
  let matched = 0n;
  for (const entry of VMA_FLAG_BITS) {
    if ((flags & (1n << BigInt(entry.bit))) === 0n) continue;
    const conditional = entry.config !== null;
    if (conditional && enabledConfigs !== null && !enabledConfigs.has(entry.config as string)) continue;
    names.push({ ...entry, conditional });
    matched |= 1n << BigInt(entry.bit);
  }
  return { names, unknownBits: flags & ~matched };
}

/** 按 show_map_vma 拼 r/w/x 和 p/s 权限串，供客体 maps 对照。 */
export function vmaPermissionString(flags: bigint): string {
  const read = (flags & VM_BITS.read) !== 0n ? 'r' : '-';
  const write = (flags & VM_BITS.write) !== 0n ? 'w' : '-';
  const exec = (flags & VM_BITS.exec) !== 0n ? 'x' : '-';
  const shared = (flags & VM_BITS.shared) !== 0n ? 's' : 'p';
  return `${read}${write}${exec}${shared}`;
}

/* --------------------------------------------------------------------------
 * mm_struct
 * ------------------------------------------------------------------------ */

export interface KernelMm {
  address: bigint;
  /** `mm_users`：真正在用这个地址空间的用户数（线程数） */
  mmUsers: number;
  /** `mm_count`：结构本身被引用的次数（active_mm 会让它多一份） */
  mmCount: number;
  /** 顶层页表的内核线性地址（`mm_struct.pgd`） */
  pgd: bigint | null;
  /** 用户地址空间上界（x86_64 上是 TASK_SIZE_MAX） */
  taskSize: bigint;
  /** VMA 个数（内核自己维护的账） */
  mapCount: number;
  totalVm: bigint;
  lockedVm: bigint;
  dataVm: bigint;
  execVm: bigint;
  stackVm: bigint;
  pgtablesBytes: bigint | null;
  startCode: bigint;
  endCode: bigint;
  startData: bigint;
  endData: bigint;
  startBrk: bigint;
  brk: bigint;
  startStack: bigint;
  argStart: bigint;
  argEnd: bigint;
  envStart: bigint;
  envEnd: bigint;
  mmapBase: bigint;
  mmapLegacyBase: bigint;
  defFlags: bigint;
  exeFile: bigint | null;
  /** `&mm->mm_mt`：VMA 这棵 Maple Tree 的地址 */
  mmMtAddress: bigint;
  evidence: EvidenceRef;
}

export async function readMm(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelMm> {
  if (address === 0n) {
    throw new AddressSpaceError(
      'null-mm',
      'mm_struct 地址为 0：内核线程和已经退出的任务本来就没有 mm，这不是读取失败',
      { address: '0x0' },
    );
  }
  const mm: StructBuffer = await readStruct(view, layout, MM_TYPE, address);
  return {
    address,
    mmUsers: mm.u32('mm_users'),
    mmCount: mm.u32('mm_count'),
    pgd: mm.pointer('pgd'),
    taskSize: mm.u64('task_size'),
    mapCount: mm.s32('map_count'),
    totalVm: mm.u64('total_vm'),
    lockedVm: mm.u64('locked_vm'),
    dataVm: mm.u64('data_vm'),
    execVm: mm.u64('exec_vm'),
    stackVm: mm.u64('stack_vm'),
    pgtablesBytes: mm.u64('pgtables_bytes'),
    startCode: mm.u64('start_code'),
    endCode: mm.u64('end_code'),
    startData: mm.u64('start_data'),
    endData: mm.u64('end_data'),
    startBrk: mm.u64('start_brk'),
    brk: mm.u64('brk'),
    startStack: mm.u64('start_stack'),
    argStart: mm.u64('arg_start'),
    argEnd: mm.u64('arg_end'),
    envStart: mm.u64('env_start'),
    envEnd: mm.u64('env_end'),
    mmapBase: mm.u64('mmap_base'),
    mmapLegacyBase: mm.u64('mmap_legacy_base'),
    defFlags: mm.u64('def_flags'),
    exeFile: mm.pointer('exe_file'),
    mmMtAddress: mm.addressOf('mm_mt'),
    evidence: memoryEvidence(view.evidenceSource, address, mm.bytes.length, [
      `type:${MM_TYPE}`,
      `structBytes:${mm.bytes.length}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * vm_area_struct
 * ------------------------------------------------------------------------ */

export interface KernelVma {
  address: bigint;
  /** Maple Tree 上这个条目覆盖的下标区间（应当恰好是 `[vm_start, vm_end-1]`） */
  slotRange: { min: bigint; max: bigint } | null;
  vmStart: bigint;
  vmEnd: bigint;
  vmFlags: bigint;
  flagNames: VmaFlagName[];
  unknownFlagBits: bigint;
  permissions: string;
  vmPgoff: bigint;
  vmFile: bigint | null;
  vmMm: bigint | null;
  anonVma: bigint | null;
  vmOps: bigint | null;
  vmPrivateData: bigint | null;
  vmLock: bigint | null;
  vmLockSeq: number;
  detached: boolean;
  /** `vm_start - vm_pgoff` 与 `pgoff` 的关系（git 风格）：下界有间隙时的标记 */
  startGap: boolean;
  evidence: EvidenceRef;
}

/** vm_flags 取 __vm_flags 字段，使用其 DWARF 位置和宽度。 */
export async function readVma(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: { slotRange?: { min: bigint; max: bigint } | null; enabledConfigs?: Set<string> | null } = {},
): Promise<KernelVma> {
  if (address === 0n) {
    throw new AddressSpaceError('null-vma', 'vm_area_struct 地址为 0', { address: '0x0' });
  }
  const vma = await readStruct(view, layout, VMA_TYPE, address);
  const flagsPath = vma.has('__vm_flags') ? '__vm_flags' : 'vm_flags';
  const vmFlags = vma.u64(flagsPath);
  const decoded = decodeVmaFlags(vmFlags, options.enabledConfigs ?? null);
  return {
    address,
    slotRange: options.slotRange ?? null,
    vmStart: vma.u64('vm_start'),
    vmEnd: vma.u64('vm_end'),
    vmFlags,
    flagNames: decoded.names,
    unknownFlagBits: decoded.unknownBits,
    permissions: vmaPermissionString(vmFlags),
    vmPgoff: vma.u64('vm_pgoff'),
    vmFile: vma.pointer('vm_file'),
    vmMm: vma.pointer('vm_mm'),
    anonVma: vma.pointer('anon_vma'),
    vmOps: vma.pointer('vm_ops'),
    vmPrivateData: vma.pointer('vm_private_data'),
    vmLock: vma.pointer('vm_lock'),
    vmLockSeq: vma.s32('vm_lock_seq'),
    // `detached` 在 DWARF 里是 1 字节的 `bool`（`mm_types.h` 里写成 `unsigned char`）。
    // detached 用 value 读字节并判零，字段缺失时默认 false。
    detached: vma.has('detached') ? Number(vma.value('detached', false)) !== 0 : false,
    startGap: (vmFlags & VM_BITS.growdown) !== 0n,
    evidence: memoryEvidence(view.evidenceSource, address, vma.bytes.length, [
      `type:${VMA_TYPE}`,
      `vm_start:${toHex(vma.u64('vm_start'))}`,
      `vm_end:${toHex(vma.u64('vm_end'))}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * VMA 列表：走 Maple Tree + 与内核记账对账
 * ------------------------------------------------------------------------ */

export interface VmaAccounting {
  /** 从 VMA 列表重算出来的四类小计（单位：页） */
  totalPages: bigint;
  execPages: bigint;
  stackPages: bigint;
  dataPages: bigint;
  /** 内核 `mm_struct` 里的同一组数字 */
  kernel: { totalVm: bigint; execVm: bigint; stackVm: bigint; dataVm: bigint; mapCount: number };
  /** 每一项是否一致 */
  matches: { total: boolean; exec: boolean; stack: boolean; data: boolean; count: boolean };
  allMatch: boolean;
  details: string[];
}

/** 按 mm/vma.h 中 EXEC、STACK 和 DATA 的位组合规则重算 VMA 页数小计。 */
export function accountVmas(vmas: KernelVma[], mm: KernelMm): VmaAccounting {
  let totalPages = 0n;
  let execPages = 0n;
  let stackPages = 0n;
  let dataPages = 0n;
  const stackMask = VM_BITS.stack;
  for (const vma of vmas) {
    const pages = (vma.vmEnd - vma.vmStart) >> BigInt(PAGE_SHIFT);
    totalPages += pages;
    const flags = vma.vmFlags;
    const isExec = (flags & (VM_BITS.exec | VM_BITS.write | stackMask)) === VM_BITS.exec;
    const isStack = (flags & stackMask) === stackMask;
    const isData = (flags & (VM_BITS.write | VM_BITS.shared | stackMask)) === VM_BITS.write;
    if (isExec) execPages += pages;
    else if (isStack) stackPages += pages;
    else if (isData) dataPages += pages;
  }
  const matches = {
    total: totalPages === mm.totalVm,
    exec: execPages === mm.execVm,
    stack: stackPages === mm.stackVm,
    data: dataPages === mm.dataVm,
    count: vmas.length === mm.mapCount,
  };
  const details: string[] = [];
  if (!matches.count) {
    details.push(`VMA 个数：遍历到 ${vmas.length} 个，内核 map_count = ${mm.mapCount}`);
  }
  if (!matches.total) details.push(`total_vm：重算 ${totalPages} 页，内核 ${mm.totalVm} 页`);
  if (!matches.exec) details.push(`exec_vm：重算 ${execPages} 页，内核 ${mm.execVm} 页`);
  if (!matches.stack) details.push(`stack_vm：重算 ${stackPages} 页，内核 ${mm.stackVm} 页`);
  if (!matches.data) details.push(`data_vm：重算 ${dataPages} 页，内核 ${mm.dataVm} 页`);
  return {
    totalPages,
    execPages,
    stackPages,
    dataPages,
    kernel: {
      totalVm: mm.totalVm,
      execVm: mm.execVm,
      stackVm: mm.stackVm,
      dataVm: mm.dataVm,
      mapCount: mm.mapCount,
    },
    matches,
    allMatch: matches.total && matches.exec && matches.stack && matches.data && matches.count,
    details,
  };
}

export interface VmaListResult {
  mm: KernelMm;
  vmas: KernelVma[];
  accounting: VmaAccounting;
  /** Maple 树自身的结构矛盾（pivot 不单调、内部槽不是节点指针……） */
  violations: string[];
  /** 每一处"槽区间 ≠ [vm_start, vm_end-1]" */
  rangeMismatches: string[];
  truncated: boolean;
  cycle: boolean;
  nullSlots: number;
  nodesVisited: number;
  maxDepth: number;
  rootKind: string;
  treeHeightField: number;
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 读出选中进程的全部 VMA。
 *
 * 遍历本身在 `maple.ts`（限定遍历 + 上限 + 环检测），这里负责三件校验：
 * 1. 每个条目的槽区间必须恰好等于 `[vm_start, vm_end-1]`；
 * 2. 每个 VMA 的 `vm_mm` 必须指回这个 mm（VMA 从别的进程漏进来时能立刻发现）；
 * 3. 汇总页数与 `map_count` 必须和内核记账一致（见 `accountVmas`）。
 */
export async function readVmas(
  view: KernelMemoryView,
  layout: KernelLayout,
  mmAddress: bigint,
  options: { maxNodes?: number; indexMin?: bigint; indexMax?: bigint; enabledConfigs?: Set<string> | null } = {},
): Promise<VmaListResult> {
  const mm = await readMm(view, layout, mmAddress);
  const walk = await walkMapleTree(view, layout, mm.mmMtAddress, {
    maxNodes: options.maxNodes,
    indexMin: options.indexMin,
    indexMax: options.indexMax,
    verifyEntry: (entry) => {
      if (entry.value % 8n !== 0n) {
        return `VMA 槽里的值 ${toHex(entry.value)} 不是 8 字节对齐：不可能是 vm_area_struct 指针`;
      }
      return null;
    },
  });

  const vmas: KernelVma[] = [];
  const rangeMismatches: string[] = [];
  const violations = [...walk.violations];
  const notes = [...walk.notes];

  for (const entry of walk.entries) {
    let vma: KernelVma;
    try {
      vma = await readVma(view, layout, entry.value, {
        slotRange: { min: entry.min, max: entry.max },
        enabledConfigs: options.enabledConfigs ?? null,
      });
    } catch (error) {
      violations.push(
        `读 VMA ${toHex(entry.value)}（槽区间 [${entry.min}, ${entry.max}]）失败：`
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    vmas.push(vma);
    if (vma.vmStart !== entry.min || vma.vmEnd - 1n !== entry.max) {
      rangeMismatches.push(
        `VMA ${toHex(vma.address)}：槽区间是 [${entry.min}, ${entry.max}]，`
        + `结构里的 [vm_start, vm_end-1] 是 [${vma.vmStart}, ${vma.vmEnd - 1n}]`,
      );
    }
    if (vma.vmMm !== null && vma.vmMm !== mmAddress) {
      violations.push(
        `VMA ${toHex(vma.address)} 的 vm_mm = ${toHex(vma.vmMm)}，不是被查询的 mm ${toHex(mmAddress)}：`
        + '这棵树上出现了属于别的地址空间的节点',
      );
    }
  }

  const accounting = accountVmas(vmas, mm);
  if (!accounting.allMatch) {
    notes.push(`VMA 与内核记账不一致：${accounting.details.join('；')}`);
  }
  return {
    mm,
    vmas,
    accounting,
    violations,
    rangeMismatches,
    truncated: walk.truncated,
    cycle: walk.cycle,
    nullSlots: walk.nullSlots,
    nodesVisited: walk.nodesVisited,
    maxDepth: walk.maxDepth,
    rootKind: walk.rootKind,
    treeHeightField: walk.tree.heightField,
    notes,
    evidence: memoryEvidence(view.evidenceSource, mm.mmMtAddress, 16, [
      `mm:${toHex(mmAddress)}`,
      `vmas:${vmas.length}`,
      `nodes:${walk.nodesVisited}`,
      // VMA 的结构读取证据集中在返回对象中。
      // 引用最多保留前 32 条并记录总数。
      ...vmas.slice(0, 32).map((vma) => `vma:${toHex(vma.address)}`),
      ...(vmas.length > 32 ? [`vma-refs-truncated:${vmas.length}`] : []),
    ]),
  };
}

/** 找出覆盖某个线性地址的 VMA；缺失时返回 null（那是一个空洞）。 */
export function findVmaForAddress(vmas: KernelVma[], linear: bigint): KernelVma | null {
  for (const vma of vmas) {
    if (linear >= vma.vmStart && linear < vma.vmEnd) return vma;
  }
  return null;
}

/** 按序号选 VMA（面板上"选中第 N 个"用的）。越界时抛错而不是返回 undefined。 */
export function selectVmaByIndex(vmas: KernelVma[], index: number): KernelVma {
  if (!Number.isInteger(index) || index < 0 || index >= vmas.length) {
    throw new AddressSpaceError(
      'vma-index-out-of-range',
      `VMA 序号 ${index} 超出范围（共 ${vmas.length} 个）`,
      { index, count: vmas.length },
    );
  }
  return vmas[index];
}

/* --------------------------------------------------------------------------
 * 选中 folio：PFN → struct page
 * ------------------------------------------------------------------------ */

/** pageflags 位号取自布局枚举，按 __NR_PAGEFLAGS 边界筛选名称。 */
export const PAGE_FLAG_NAMES = [
  'PG_locked',
  'PG_writeback',
  'PG_referenced',
  'PG_uptodate',
  'PG_dirty',
  'PG_lru',
  'PG_head',
  'PG_waiters',
  'PG_active',
  'PG_workingset',
  'PG_owner_priv_1',
  'PG_owner_2',
  'PG_arch_1',
  'PG_reserved',
  'PG_private',
  'PG_private_2',
  'PG_reclaim',
  'PG_swapbacked',
  'PG_unevictable',
  'PG_mlocked',
  'PG_arch_2',
];

export interface PageFlagDecode {
  names: string[];
  /** `__NR_PAGEFLAGS`：这面旗子一共占多少位 */
  bitCount: number;
  /** `page->flags` 里没被解码的部分（zone / node / last_cpupid 的编码，以及软件借用位） */
  undecodedBits: bigint;
  unknownNames: string[];
}

export function decodePageFlags(layout: KernelLayout, flags: bigint): PageFlagDecode {
  const bitCount = layout.enumValue('pageflags', '__NR_PAGEFLAGS');
  const names: string[] = [];
  const unknownNames: string[] = [];
  for (const name of PAGE_FLAG_NAMES) {
    let bit: number;
    try {
      bit = layout.enumValue('pageflags', name);
    } catch {
      unknownNames.push(name);
      continue;
    }
    if (bit >= bitCount) continue;
    if ((flags & (1n << BigInt(bit))) !== 0n) names.push(name);
  }
  const mask = (1n << BigInt(bitCount)) - 1n;
  return { names, bitCount, undecodedBits: flags & ~mask, unknownNames };
}

/** page_type 高 8 位按 include/linux/page-flags.h 的 enum pagetype 解码，低 24 位保留使用者语义。 */
export const PAGE_TYPE_NAMES: Array<{ name: string; code: number }> = [
  { name: 'PGTY_buddy', code: 0xf0 },
  { name: 'PGTY_offline', code: 0xf1 },
  { name: 'PGTY_table', code: 0xf2 },
  { name: 'PGTY_guard', code: 0xf3 },
  { name: 'PGTY_hugetlb', code: 0xf4 },
  { name: 'PGTY_slab', code: 0xf5 },
  { name: 'PGTY_zsmalloc', code: 0xf6 },
  { name: 'PGTY_unaccepted', code: 0xf7 },
  { name: 'PGTY_mapcount_underflow', code: 0xff },
];

export interface PageTypeDecode {
  raw: number | null;
  /** 高 8 位的代号 */
  code: number | null;
  /** 类型代号对应的名字，查表缺失时为 null */
  name: string | null;
  /** page_type_has_type=true 时联合存储按类型解释 */
  hasType: boolean;
}

/** page_type 低于 PGTY_mapcount_underflow<<24 时使用类型语义，其余按 _mapcount 解释。 */
export function decodePageType(raw: number | null): PageTypeDecode {
  if (raw === null) return { raw: null, code: null, name: null, hasType: false };
  const code = (raw >>> 24) & 0xff;
  const entry = PAGE_TYPE_NAMES.find((candidate) => candidate.code === code);
  return {
    raw,
    code,
    name: entry === undefined ? null : entry.name,
    hasType: (raw >>> 0) < 0xff00_0000,
  };
}

/** page_type 依次查顶层字段和 page.page_type，字段缺失时返回 null。 */
function readPageType(struct: StructBuffer): number | null {
  if (struct.has('page_type')) return struct.u32('page_type');
  if (struct.has('page.page_type')) return struct.u32('page.page_type');
  return null;
}

export interface KernelFolio {
  /** `struct page` / `struct folio` 的地址（VMEMMAP 基址 + pfn × 64） */
  address: bigint;
  pfn: bigint;
  pageStructSize: bigint;
  vmemmap: VmemmapFacts;
  flags: bigint;
  pageFlags: string[];
  pageFlagBitCount: number;
  undecodedFlagBits: bigint;
  /** page_type 原始值，布局字段缺失时为 null */
  pageType: number | null;
  /** `page_type` 高 8 位的代号（`enum pagetype`） */
  pageTypeCode: number | null;
  /** 代号的名字，例如 `PGTY_table` */
  pageTypeName: string | null;
  /** 类型语义标志，为真时该存储按 page_type 解释 */
  pageTypeIsType: boolean;
  /** 引用计数（`_refcount`） */
  refcount: number;
  /** order-0 页映射计数，-1 对应映射数 0 */
  mapcount: number;
  mapping: bigint;
  mappingIsAnon: boolean;
  mappingIsMovable: boolean;
  /** 匿名页：`mapping - 1` 就是 `anon_vma` */
  anonVmaAddress: bigint | null;
  /** 文件页/匿名页的页偏移：文件内偏移或虚拟页号 */
  index: bigint;
  isTail: boolean;
  /** `compound_head` 的原始值：头页写 0，尾页写 `head 地址 + 1`（最低位当标记） */
  compoundHeadRaw: bigint;
  /** 尾页所属的 head 页地址；非尾页为 null */
  compoundHeadAddress: bigint | null;
  /** 大页 folio 的页数（`_folio_nr_pages`）；order-0 时为 null */
  folioNrPages: number | null;
  notes: string[];
  evidence: EvidenceRef;
}

/**
 * 由页框号取 `struct page` 并解码。
 *
 * vmemmap 基址默认现场从 `mem_section` 推（见 `page-table.ts`），也可以由调用方传入
 * 已经算好的一份，避免同一个停点反复读同一个 section。
 */
export async function readFolioForPfn(
  view: KernelMemoryView,
  layout: KernelLayout,
  options: { pfn: bigint; vmemmap?: VmemmapFacts },
): Promise<KernelFolio> {
  const vmemmap = options.vmemmap ?? (await resolveVmemmapBase(view, layout, { pfn: options.pfn }));
  const pageStructSize = vmemmap.pageStructSize;
  const address = pageAddressForPfn(vmemmap.base, options.pfn, pageStructSize);

  const hasFolio = layout.has(FOLIO_TYPE) && !layout.type(FOLIO_TYPE).declaration;
  const typeName = hasFolio ? FOLIO_TYPE : PAGE_TYPE;
  const struct = await readStruct(view, layout, typeName, address);

  const flags = struct.u64('flags');
  const decodedFlags = decodePageFlags(layout, flags);
  const mapping = struct.u64('mapping');
  const mappingIsAnon = (mapping & PAGE_MAPPING_FLAGS) === PAGE_MAPPING_ANON;
  const mappingIsMovable = (mapping & PAGE_MAPPING_FLAGS) === PAGE_MAPPING_MOVABLE;
  // compound_head 低位标记尾页，head 地址由原始值减 1 得到。
  // 头页的原始值为 0。
  // PG_head 单独表达复合页头身份。
  //
  // folio 与 page 共用开头的结构字节。
  // folio 字段查找失败时走 page.compound_head。
  // 两条布局路径对应同一存储位置。
  // 原始值按实际读到的字段保留。
  const compoundHeadPath = struct.has('compound_head')
    ? 'compound_head'
    : (struct.has('page.compound_head') ? 'page.compound_head' : null);
  const compoundHeadRaw = compoundHeadPath === null ? 0n : struct.u64(compoundHeadPath);
  const isTail = (compoundHeadRaw & 1n) === 1n;
  const compoundHeadAddress = isTail ? compoundHeadRaw - 1n : null;
  const pageType = readPageType(struct);
  const pageTypeDecoded = decodePageType(pageType);
  const notes: string[] = [...vmemmap.notes];
  if (compoundHeadPath === null) {
    notes.push(
      `布局清单里 ${typeName} 既没有 compound_head 也没有 page.compound_head：`
      + '这一项读不出来，按 0 处理，不假装它是头页',
    );
  }

  if (decodedFlags.undecodedBits !== 0n) {
    notes.push(
      `page->flags 的高位 ${toHex(decodedFlags.undecodedBits)} 没有解码：`
      + '那几位里编着 zone / node / last_cpupid，本实现不猜它们的位宽（改了这几项配置位宽就变）',
    );
  }
  if (decodedFlags.unknownNames.length > 0) {
    notes.push(`布局清单的 pageflags 枚举里没有 ${decodedFlags.unknownNames.join('、')}，这几位没法命名`);
  }
  if (pageTypeDecoded.hasType) {
    notes.push(
      'page_type 是"类型"语义（高 8 位 = '
      + `${toHex(BigInt(pageTypeDecoded.code ?? 0))}`
      + `${pageTypeDecoded.name === null ? '' : ` = ${pageTypeDecoded.name}`}）：`
      + '这一页不用 _mapcount，而两者在 struct page 里是同一个联合体，'
      + '所以同一地址读出来的 _mapcount 不能当映射计数看',
    );
  } else if (pageType === null) {
    notes.push('布局清单里 page_type / page.page_type 两条路径都没有，page_type 记为未知（不是 0）');
  } else {
    notes.push(
      `page_type = ${toHex(BigInt(pageType >>> 0))}：小于 0xff000000 的才叫"类型"，`
      + '这个值属于 mapcount 语义（越界的负数，例如 0xffffffff 表示没被页表映射）',
    );
  }
  if (!hasFolio) {
    notes.push('布局清单里没有可用的 struct folio，改用 struct page 的前 64 字节（两者在偏移 0 处重合）');
  }

  let folioNrPages: number | null = null;
  if (hasFolio && struct.has('_folio_nr_pages')) {
    // folio_test_large 为真时才读取 _folio_nr_pages。
    // order-0 的 folioNrPages 返回 null。
    // 该联合区域按实际页类型解释。
    // 页数与普通页标志分别保留。
    if (decodedFlags.names.includes('PG_head')) {
      folioNrPages = struct.u32('_folio_nr_pages');
    } else {
      notes.push(
        '不是大页 folio（PG_head 没立）：`folio_nr_pages()` 此时恒为 1 且不读 `_folio_nr_pages`，'
        + '所以这一项留空而不是把那段字节当页数',
      );
    }
  }

  if (mapping !== 0n && !mappingIsAnon && !mappingIsMovable) {
    // 文件页：mapping 指向 address_space（T07d 才解 inode/文件）。
  } else if (mapping === 0n) {
    notes.push('page->mapping 为 0：这个页不属于任何 address_space（可能是刚分配的零页或内核页）');
  }

  return {
    address,
    pfn: options.pfn,
    pageStructSize,
    vmemmap,
    flags,
    pageFlags: decodedFlags.names,
    pageFlagBitCount: decodedFlags.bitCount,
    undecodedFlagBits: decodedFlags.undecodedBits,
    pageType,
    pageTypeCode: pageTypeDecoded.code,
    pageTypeName: pageTypeDecoded.name,
    pageTypeIsType: pageTypeDecoded.hasType,
    refcount: struct.s32('_refcount'),
    mapcount: struct.s32('_mapcount'),
    mapping,
    mappingIsAnon,
    mappingIsMovable,
    anonVmaAddress: mappingIsAnon ? mapping - PAGE_MAPPING_ANON : null,
    index: struct.u64('index'),
    isTail,
    compoundHeadRaw,
    compoundHeadAddress,
    folioNrPages,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, Number(pageStructSize), [
      `pfn:${toHex(options.pfn)}`,
      `vmemmap:${toHex(vmemmap.base)}`,
      `vmemmap-source:${vmemmap.source}`,
    ]),
  };
}

/* --------------------------------------------------------------------------
 * 与契约对接
 * ------------------------------------------------------------------------ */

/** VMA 转 VmaRef，fileOffset 使用 vm_pgoff<<PAGE_SHIFT 的字节偏移。 */
export function toVmaRef(vma: KernelVma): VmaRef {
  const source = vmaSourceLabel(vma);
  return {
    address: toHex(vma.vmStart) as Hex,
    end: toHex(vma.vmEnd) as Hex,
    permissions: vma.permissions,
    source,
    fileOffset: vma.vmFile === null ? null : (toHex(vma.vmPgoff * PAGE_SIZE) as Hex),
  };
}

/** 文件映射来源使用 file 地址标签，路径由 dentry/inode 解析提供。 */
export function vmaSourceLabel(vma: KernelVma): string | null {
  if (vma.vmFile !== null) return `file:${toHex(vma.vmFile)}`;
  if ((vma.vmFlags & VM_BITS.growdown) !== 0n) return '[stack]';
  return '[anon]';
}

export function toAddressSpaceRef(
  result: VmaListResult,
  options: { pid: number; pgdPhysical: bigint | null; structure?: string },
): AddressSpaceRef {
  const mm = result.mm;
  return {
    pid: options.pid,
    mmAddress: toHex(mm.address) as Hex,
    startCode: mm.startCode === 0n ? null : (toHex(mm.startCode) as Hex),
    endCode: mm.endCode === 0n ? null : (toHex(mm.endCode) as Hex),
    startStack: mm.startStack === 0n ? null : (toHex(mm.startStack) as Hex),
    pgdPhysical: options.pgdPhysical === null ? null : (toHex(options.pgdPhysical) as Hex),
    vmas: result.vmas.map(toVmaRef),
    truncated: result.truncated,
    structure: options.structure ?? 'maple-tree',
    evidence: result.evidence,
  };
}

export function toFolioRef(folio: KernelFolio, options: { inodeAddress?: bigint | null } = {}): FolioRef {
  return {
    address: toHex(folio.address) as Hex,
    fileOffset: folio.mappingIsAnon ? null : (toHex(folio.index * PAGE_SIZE) as Hex),
    pfn: toHex(folio.pfn) as Hex,
    dirty: folio.pageFlags.includes('PG_dirty'),
    uptodate: folio.pageFlags.includes('PG_uptodate'),
    inodeAddress: options.inodeAddress === undefined || options.inodeAddress === null
      ? null
      : (toHex(options.inodeAddress) as Hex),
    evidence: folio.evidence,
  };
}

/** 把 `MapleEntry` 里"这个 VMA 覆盖的下标区间"原样拿出来（调试与证据用）。 */
export function slotRangeOf(entry: MapleEntry): { min: string; max: string } {
  return { min: toHex(entry.min), max: toHex(entry.max) };
}
