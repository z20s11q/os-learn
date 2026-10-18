/** 页表遍历与 PFN 寻址：条目物理地址通过直映射偏移换成内核线性地址读取。
 * 直映射偏移由同一顶层页表的 pgd 与 CR3 求差，vmemmap 基址由 mem_section 编码求得。
 * 位名称保留硬件和内核来源，具体含义按页表层级解释。
 */

import { CaptureReadError, memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';

export class AddressSpaceParseError extends CaptureReadError {}

/* --------------------------------------------------------------------------
 * 常量：一个 4 KiB 页、一个 8 字节条目、一片 52 位物理地址
 * ------------------------------------------------------------------------ */

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1n << 12n;
export const HUGE_PAGE_2M_SHIFT = 21;
export const HUGE_PAGE_1G_SHIFT = 30;
export const PTE_ENTRY_BYTES = 8;
export const ENTRIES_PER_TABLE = 512;
export const LEVEL_INDEX_MASK = 0x1ffn;

/** 页表物理地址字段掩码来自 __PHYSICAL_MASK_SHIFT=52，保留 51..12 位。 */
export const PHYSICAL_ADDRESS_BITS = 52;
export const PHYSICAL_ADDRESS_MASK = 0x000f_ffff_ffff_f000n;

/** 线性地址的高半区起点（x86_64 4 级页表：内核空间从这里往上）。 */
export const KERNEL_VIRTUAL_START = 0xffff_8000_0000_0000n;

/** `__PAGE_OFFSET_BASE_L4`：直映射（物理内存的直接线性映射）基址。 */
export const PAGE_OFFSET_BASE_L4 = 0xffff_8880_0000_0000n;

/** `__VMEMMAP_BASE_L4`：`struct page` 数组的基址。 */
export const VMEMMAP_BASE_L4 = 0xffff_ea00_0000_0000n;

/** 直映射基址采用 512 GiB 对齐，用于校验 pgd 与 CR3 的来源一致性。 */
export const PAGE_OFFSET_ALIGNMENT = 1n << 39n;

/* --------------------------------------------------------------------------
 * 页表条目位
 * ------------------------------------------------------------------------ */

/** PTE 位名来自架构与内核定义；bit 7 按层级解释为 PAT 或大页，软件位单独标识。 */
export const PTE_BITS = {
  present: 0,
  writable: 1,
  user: 2,
  writeThrough: 3,
  cacheDisable: 4,
  accessed: 5,
  dirty: 6,
  pageSize: 7,
  global: 8,
  userfaultWp: 10,
  softDirty: 11,
  devmap: 57,
  savedDirty: 58,
  noExecute: 63,
} as const;

export interface PteFlags {
  present: boolean;
  writable: boolean;
  user: boolean;
  writeThrough: boolean;
  cacheDisable: boolean;
  accessed: boolean;
  dirty: boolean;
  /** bit 7：PTE 上是 PAT，上级条目上是"大页"标志 */
  pageSize: boolean;
  global: boolean;
  userfaultWp: boolean;
  softDirty: boolean;
  devmap: boolean;
  savedDirty: boolean;
  noExecute: boolean;
  /** present=0 且写成了 PROT_NONE 的形态（`_PAGE_PROTNONE = _PAGE_GLOBAL`，present 清零） */
  protNone: boolean;
  /** unexpectedHighBits 保留 raw 的 52..62 位，用于本解析器的高位校验 */
  unexpectedHighBits: bigint;
}

const B = (raw: bigint, bit: number): boolean => ((raw >> BigInt(bit)) & 1n) === 1n;

export function decodePteFlags(raw: bigint): PteFlags {
  const present = B(raw, PTE_BITS.present);
  const global = B(raw, PTE_BITS.global);
  // 高位校验取 raw 的 52..62 位。
  // bit 63 的 NX 单独解码。
  const unexpected = raw & 0x7ff0_0000_0000_0000n;
  return {
    present,
    writable: B(raw, PTE_BITS.writable),
    user: B(raw, PTE_BITS.user),
    writeThrough: B(raw, PTE_BITS.writeThrough),
    cacheDisable: B(raw, PTE_BITS.cacheDisable),
    accessed: B(raw, PTE_BITS.accessed),
    dirty: B(raw, PTE_BITS.dirty),
    pageSize: B(raw, PTE_BITS.pageSize),
    global,
    userfaultWp: B(raw, PTE_BITS.userfaultWp),
    softDirty: B(raw, PTE_BITS.softDirty),
    devmap: B(raw, PTE_BITS.devmap),
    savedDirty: B(raw, PTE_BITS.savedDirty),
    noExecute: B(raw, PTE_BITS.noExecute),
    protNone: !present && global,
    unexpectedHighBits: unexpected,
  };
}

/** 立着的标志名，顺序固定，便于对照与落盘。 */
export function describePteFlags(flags: PteFlags): string[] {
  const names: string[] = [];
  if (flags.present) names.push('present');
  if (flags.writable) names.push('writable');
  if (flags.user) names.push('user');
  if (flags.writeThrough) names.push('pwt');
  if (flags.cacheDisable) names.push('pcd');
  if (flags.accessed) names.push('accessed');
  if (flags.dirty) names.push('dirty');
  if (flags.pageSize) names.push('pageSize');
  if (flags.global) names.push('global');
  if (flags.userfaultWp) names.push('uffd-wp');
  if (flags.softDirty) names.push('soft-dirty');
  if (flags.devmap) names.push('devmap');
  if (flags.savedDirty) names.push('saved-dirty');
  if (flags.noExecute) names.push('nx');
  return names;
}

/** 页表层级几何：shift 表示索引起点，entrySpan 表示覆盖范围，hugePageBytes 表示叶子页大小。 */
export interface PageTableLevel {
  /** 级数编号：4 = 顶层（PML4），1 = 最低级（PT） */
  level: number;
  name: 'PML5' | 'PML4' | 'PDPT' | 'PD' | 'PT';
  shift: number;
  entrySpan: bigint;
  hugePageBytes: bigint | null;
}

export function pageTableLevels(levels: 4 | 5): PageTableLevel[] {
  const top: PageTableLevel[] = levels === 5
    ? [{ level: 5, name: 'PML5', shift: 48, entrySpan: 1n << 48n, hugePageBytes: null }]
    : [];
  return [
    ...top,
    { level: 4, name: 'PML4', shift: 39, entrySpan: 1n << 39n, hugePageBytes: null },
    { level: 3, name: 'PDPT', shift: 30, entrySpan: 1n << 30n, hugePageBytes: 1n << 30n },
    { level: 2, name: 'PD', shift: 21, entrySpan: 1n << 21n, hugePageBytes: 1n << 21n },
    { level: 1, name: 'PT', shift: 12, entrySpan: 1n << 12n, hugePageBytes: null },
  ];
}

/* --------------------------------------------------------------------------
 * 直映射偏移
 * ------------------------------------------------------------------------ */

export interface PageOffsetBaseDerivation {
  base: bigint;
  /** CR3 里的物理地址部分（顶层表本身的物理地址） */
  rootPhysical: bigint;
  pgdLinear: bigint;
  /** 512 GiB 对齐（直映射基址的形状要求） */
  aligned: boolean;
  /** 落在内核半区 */
  inKernelHalf: boolean;
  /** 与编译期常量 `__PAGE_OFFSET_BASE_L4` 一致 */
  matchesCompiledDefault: boolean;
  notes: string[];
}

/** 同一顶层表的 pgd 线性地址减 CR3 物理地址得到直映射偏移，返回对齐与内核半区校验。 */
export function derivePageOffsetBase(options: { pgdLinear: bigint; cr3: bigint }): PageOffsetBaseDerivation {
  const rootPhysical = options.cr3 & PHYSICAL_ADDRESS_MASK;
  const base = options.pgdLinear - rootPhysical;
  const aligned = base % PAGE_OFFSET_ALIGNMENT === 0n;
  const inKernelHalf = base >= KERNEL_VIRTUAL_START;
  const matchesCompiledDefault = base === PAGE_OFFSET_BASE_L4;
  const notes: string[] = [];
  if (rootPhysical === 0n) {
    notes.push('CR3 的物理地址部分是 0：这一帧上还没有页表（或 CR3 还没被写入），推不出直映射偏移');
  }
  if (!inKernelHalf) {
    notes.push(
      `推导出的直映射偏移 ${toHex(base)} 不在内核半区（< ${toHex(KERNEL_VIRTUAL_START)}）：`
      + '多半是 pgd 不属于当前 CR3 指向的 mm',
    );
  }
  if (!aligned) {
    notes.push(
      `推导出的直映射偏移 ${toHex(base)} 不是 512 GiB 对齐：`
      + '只有 pgd 就是 CR3 指向的那个顶层表时，相减才是直映射偏移',
    );
  }
  if (aligned && inKernelHalf && !matchesCompiledDefault) {
    notes.push(
      `推导出的直映射偏移 ${toHex(base)} 与编译期常量 ${toHex(PAGE_OFFSET_BASE_L4)} 不同：`
      + '本内核没开 KASLR/DYNAMIC_MEMORY_LAYOUT，正常情况下两者应当相等',
    );
  }
  return { base, rootPhysical, pgdLinear: options.pgdLinear, aligned, inKernelHalf, matchesCompiledDefault, notes };
}

/* --------------------------------------------------------------------------
 * 遍历
 * ------------------------------------------------------------------------ */

export interface PageTableWalkEntry {
  level: number;
  name: string;
  index: number;
  /** 条目自身的线性地址（内核读它用的地址） */
  entryLinear: bigint;
  /** 条目自身的物理地址（可与服务端 translate 的 tableAddress 逐条比） */
  entryPhysical: bigint | null;
  raw: bigint;
  flags: PteFlags;
  flagNames: string[];
  /** 这一级就是最终映射（叶子：大页，或最低级的 present 条目） */
  terminal: boolean;
  /** 条目指向的物理地址（表基址或页框起始） */
  targetPhysical: bigint | null;
  /** 条目指向的下级表的线性地址 */
  targetLinear: bigint | null;
  /** terminal 时这一级映射的页大小 */
  pageSizeBytes: bigint | null;
}

export interface PageTableFault {
  kind: 'not-present' | 'reserved' | 'unsupported';
  level: number;
  detail: string;
}

export interface PageTableWalk {
  linear: bigint;
  levels: number;
  rootLinear: bigint;
  rootPhysical: bigint | null;
  pageOffsetBase: bigint;
  walk: PageTableWalkEntry[];
  /** 翻译成功时的物理地址（含页内偏移） */
  physical: bigint | null;
  pageSizeBytes: bigint | null;
  huge: boolean;
  fault: PageTableFault | null;
  notes: string[];
  evidence: EvidenceRef;
}

export interface PageTableWalkOptions {
  /** 顶层表的线性地址（`mm_struct.pgd`） */
  pgd: bigint;
  /** 要翻译的线性地址 */
  linear: bigint;
  /** 直映射偏移（见 `derivePageOffsetBase`） */
  pageOffsetBase: bigint;
  /** 页表级数；本内核是 4 */
  levels?: 4 | 5;
  /** 顶层表物理地址，省略时用 pgd-pageOffsetBase 推导 */
  rootPhysical?: bigint | null;
}

/** 逐级读取页表，记录条目双地址和原始值；PDPT/PD 大页及末级 PTE 作为叶子终止。 */
export async function walkPageTable(
  view: KernelMemoryView,
  options: PageTableWalkOptions,
): Promise<PageTableWalk> {
  const levels = options.levels ?? 4;
  const specs = pageTableLevels(levels);
  const notes: string[] = [];
  const walk: PageTableWalkEntry[] = [];
  const pageOffsetBase = options.pageOffsetBase;

  let tableLinear = options.pgd;
  let tablePhysical: bigint | null = options.rootPhysical ?? null;
  if (tablePhysical === null) {
    const candidate = options.pgd - pageOffsetBase;
    if (candidate >= 0n) tablePhysical = candidate;
    else notes.push('顶层表的物理地址推不出来（pgd 比直映射偏移还小），条目物理地址一栏留空');
  }

  let physical: bigint | null = null;
  let pageSizeBytes: bigint | null = null;
  let huge = false;
  let fault: PageTableFault | null = null;

  for (const spec of specs) {
    const index = Number((options.linear >> BigInt(spec.shift)) & LEVEL_INDEX_MASK);
    const entryLinear = tableLinear + BigInt(index) * BigInt(PTE_ENTRY_BYTES);
    const entryPhysical = tablePhysical === null ? null : tablePhysical + BigInt(index) * BigInt(PTE_ENTRY_BYTES);
    const raw = await view.u64(entryLinear);
    const flags = decodePteFlags(raw);
    const entry: PageTableWalkEntry = {
      level: spec.level,
      name: spec.name,
      index,
      entryLinear,
      entryPhysical,
      raw,
      flags,
      flagNames: describePteFlags(flags),
      terminal: false,
      targetPhysical: null,
      targetLinear: null,
      pageSizeBytes: null,
    };

    // 高位校验命中时记录 fault 并结束遍历。
    if (flags.unexpectedHighBits !== 0n) {
      notes.push(
        `${spec.name}[${index}] 的原始值 ${toHex(raw)} 在第 52–62 位立了位（${toHex(flags.unexpectedHighBits)}）：`
        + '本内核的页表条目这一带应当全是 0',
      );
    }

    if (!flags.present) {
      entry.terminal = true;
      walk.push(entry);
      fault = {
        kind: 'not-present',
        level: spec.level,
        detail: flags.protNone
          ? '条目 present=0 但 GLB 位立着：这是 mprotect(PROT_NONE) 之后的形态（_PAGE_PROTNONE），不是真的缺页'
          : `${spec.name}[${index}] present=0，这个地址没有映射`,
      };
      break;
    }

    if (spec.hugePageBytes !== null && flags.pageSize) {
      // 这一级自己就是叶子：PDPT → 1 GiB，PD → 2 MiB。
      const target = raw & PHYSICAL_ADDRESS_MASK;
      entry.terminal = true;
      entry.targetPhysical = target;
      entry.pageSizeBytes = spec.hugePageBytes;
      walk.push(entry);
      pageSizeBytes = spec.hugePageBytes;
      huge = true;
      const within = options.linear & (spec.hugePageBytes - 1n);
      physical = target + within;
      if (spec.level === 3) {
        notes.push(`${spec.name}[${index}] 是 1 GiB 大页：这一级的 PS 位立着，下面没有 PD/PT 两级`);
      }
      break;
    }

    if (spec.level === 4 && flags.pageSize) {
      // 顶层 bit 7 命中保留位时记录 fault。
      walk.push(entry);
      fault = {
        kind: 'reserved',
        level: spec.level,
        detail: `${spec.name}[${index}] 在顶层立了 bit 7（保留位），顶层条目没有大页含义`,
      };
      break;
    }

    if (spec.shift === PAGE_SHIFT) {
      // 最低级：PTE 本身就是叶子。
      const target = raw & PHYSICAL_ADDRESS_MASK;
      entry.terminal = true;
      entry.targetPhysical = target;
      entry.pageSizeBytes = PAGE_SIZE;
      walk.push(entry);
      pageSizeBytes = PAGE_SIZE;
      physical = target + (options.linear & (PAGE_SIZE - 1n));
      break;
    }

    // 非叶子、present：继续往下走一级表。
    const target = raw & PHYSICAL_ADDRESS_MASK;
    entry.targetPhysical = target;
    entry.targetLinear = pageOffsetBase + target;
    walk.push(entry);
    if (target === 0n) {
      notes.push(`${spec.name}[${index}] present=1 但指向物理地址 0：下级表落在 4 KiB 处，看起来不像内核分配的表`);
    }
    tableLinear = pageOffsetBase + target;
    tablePhysical = target;
  }

  const capture = view.evidenceSource;
  return {
    linear: options.linear,
    levels,
    rootLinear: options.pgd,
    rootPhysical: options.rootPhysical ?? (options.pgd - pageOffsetBase >= 0n ? options.pgd - pageOffsetBase : null),
    pageOffsetBase,
    walk,
    physical,
    pageSizeBytes,
    huge,
    fault,
    notes,
    evidence: memoryEvidence(capture, options.pgd, walk.length * PTE_ENTRY_BYTES, [
      `page-walk:${toHex(options.linear)}`,
      `levels:${levels}`,
      `steps:${walk.length}`,
    ]),
  };
}

/** 读取一个条目的原始值及标志。 */
export async function readPageTableEntry(
  view: KernelMemoryView,
  entryLinear: bigint,
): Promise<{ raw: bigint; flags: PteFlags; flagNames: string[] }> {
  const raw = await view.u64(entryLinear);
  const flags = decodePteFlags(raw);
  return { raw, flags, flagNames: describePteFlags(flags) };
}

/** 物理地址加直映射偏移后读取，负物理地址或用户半区结果被拒绝。 */
export async function readPhysical(
  view: KernelMemoryView,
  options: { physical: bigint; pageOffsetBase: bigint; length: number },
): Promise<{ linear: bigint; bytes: Uint8Array }> {
  if (options.physical < 0n) {
    throw new AddressSpaceParseError('negative-physical', `物理地址不能为负：${options.physical}`, {
      physical: options.physical.toString(),
    });
  }
  const linear = options.pageOffsetBase + options.physical;
  if (linear < KERNEL_VIRTUAL_START) {
    throw new AddressSpaceParseError(
      'physical-out-of-map',
      `物理地址 ${toHex(options.physical)} 加直映射偏移 ${toHex(options.pageOffsetBase)} 得到 ${toHex(linear)}，`
      + '落在用户半区：说明直映射偏移或物理地址有一处是错的',
      { physical: toHex(options.physical), pageOffsetBase: toHex(options.pageOffsetBase), linear: toHex(linear) },
    );
  }
  const bytes = await view.bytes(linear, options.length);
  return { linear, bytes };
}

/* --------------------------------------------------------------------------
 * PFN → struct page（稀疏内存模型）
 * ------------------------------------------------------------------------ */

/** `SECTION_SIZE_BITS`（x86_64 4 级页表 = 27，即一个 section 128 MiB）。 */
export const SECTION_SIZE_BITS = 27;
/** 一个 section 覆盖多少个页框（2^15 = 32768）。 */
export const PFN_SECTION_SHIFT = SECTION_SIZE_BITS - PAGE_SHIFT;
export const PAGES_PER_SECTION = 1n << BigInt(PFN_SECTION_SHIFT);
/** `MAX_PHYSMEM_BITS = 46`（5 级页表关闭时），用于算出 section 总数。 */
export const MAX_PHYSMEM_BITS = 46;
export const NR_MEM_SECTIONS = 1n << BigInt(MAX_PHYSMEM_BITS - SECTION_SIZE_BITS);

/** section_mem_map 低位按 SECTION_MAP_LAST_BIT 清除，保留 vmemmap 编码地址。 */
export const SECTION_MAP_LAST_BIT = 4;
export const SECTION_MAP_MASK = ~((1n << BigInt(SECTION_MAP_LAST_BIT)) - 1n);
export const SECTION_MARKED_PRESENT = 1n << 0n;
export const SECTION_HAS_MEM_MAP = 1n << 1n;

export interface VmemmapFacts {
  /** `struct page` 数组的基址 */
  base: bigint;
  source: 'mem-section' | 'compiled-default';
  pageStructSize: bigint;
  /** 查询用的页框号所属的 section 号 */
  sectionNumber: bigint;
  /** `mem_section[root]`：section 数组的地址 */
  sectionArray: bigint | null;
  /** `&mem_section[root][index]` */
  sectionAddress: bigint | null;
  /** `section_mem_map` 原始值（含状态位） */
  sectionMemMapRaw: bigint | null;
  sectionStartPfn: bigint;
  sectionMarkedPresent: boolean;
  sectionHasMemMap: boolean;
  /** 与编译期常量 `__VMEMMAP_BASE_L4` 是否一致 */
  matchesCompiledDefault: boolean | null;
  notes: string[];
  evidence: EvidenceRef;
}

/** VMEMMAP 下 struct page 地址 = vmemmap + pfn×sizeof(struct page)。 */
export function pageAddressForPfn(base: bigint, pfn: bigint, pageStructSize: bigint): bigint {
  return base + pfn * pageStructSize;
}

/** `struct page` 的字节宽度；取不到就抛错（这个宽度错了，后面每个字段都错）。 */
export function structPageSizeOf(layout: KernelLayout): bigint {
  const type = layout.type('page');
  if (type.byteSize === null) {
    throw new AddressSpaceParseError(
      'page-size-unknown',
      '布局清单里 struct page 的大小未知，算不出页框到 struct page 的步长',
      { typeName: 'page' },
    );
  }
  return BigInt(type.byteSize);
}

/** 从 mem_section 根数组定位 section，清除 section_mem_map 低位标记得到 vmemmap 基址。
 * 编码来自 sparse_init_one_section 的指针减法：mem_map 减 section 起始 PFN 的结构步长。
 * VMEMMAP 下编码值本身就是字节基址，返回时与编译期常量对账。
 */
export async function resolveVmemmapBase(
  view: KernelMemoryView,
  layout: KernelLayout,
  options: { pfn: bigint; symbol?: string; sectionsPerRoot?: number },
): Promise<VmemmapFacts> {
  const capture = view.evidenceSource;
  const pageStructSize = structPageSizeOf(layout);
  const sectionNumber = options.pfn >> BigInt(PFN_SECTION_SHIFT);
  const sectionStartPfn = options.pfn & ~(PAGES_PER_SECTION - 1n);
  const notes: string[] = [];

  const symbolName = options.symbol ?? 'mem_section';
  const symbolAddress = capture.symbolAddress(symbolName);
  const evidence = memoryEvidence(capture, symbolAddress ?? 0n, PTE_ENTRY_BYTES, [
    `symbol:${symbolName}`,
    `pfn:${toHex(options.pfn)}`,
  ]);

  if (symbolAddress === null) {
    return {
      base: VMEMMAP_BASE_L4,
      source: 'compiled-default',
      pageStructSize,
      sectionNumber,
      sectionArray: null,
      sectionAddress: null,
      sectionMemMapRaw: null,
      sectionStartPfn,
      sectionMarkedPresent: false,
      sectionHasMemMap: false,
      matchesCompiledDefault: null,
      notes: [
        `本次采集的符号表里没有 ${symbolName}，退回到编译期常量 __VMEMMAP_BASE_L4 = ${toHex(VMEMMAP_BASE_L4)}；`
        + '这个常量只在没开内存布局随机化时成立，所以它是一条"未经验证"的结论',
      ],
      evidence,
    };
  }

  if (sectionNumber >= NR_MEM_SECTIONS) {
    throw new AddressSpaceParseError(
      'pfn-out-of-range',
      `页框号 ${toHex(options.pfn)} 落在第 ${sectionNumber} 个 section，超出本内核的 section 总数 ${NR_MEM_SECTIONS}`,
      { pfn: toHex(options.pfn), sectionNumber: sectionNumber.toString(), nrMemSections: NR_MEM_SECTIONS.toString() },
    );
  }

  // SECTIONS_PER_ROOT = PAGE_SIZE / sizeof(struct mem_section)。
  // sectionStride 优先使用布局中的 mem_section 宽度。
  // 缺失时按两个机器字推导并记录该来源。
  const measured = layout.has('mem_section') ? layout.type('mem_section').byteSize : null;
  const sectionStride = measured !== null && measured > 0
    ? Number(measured)
    : 16;
  const sectionsPerRoot = options.sectionsPerRoot ?? Math.floor(4096 / sectionStride);
  if (measured === null) {
    notes.push(
      `布局清单里没有 mem_section，按每节 ${sectionStride} 字节（section_mem_map + usage 两个机器字）`
      + `推出 SECTIONS_PER_ROOT=${sectionsPerRoot}；这只影响内存大于`
      + `${PAGES_PER_SECTION * BigInt(sectionsPerRoot) * PAGE_SIZE / (1024n * 1024n * 1024n)} GiB 时选第几个根数组`,
    );
  }

  const rootArray = await view.u64(symbolAddress);
  if (rootArray === 0n) {
    throw new AddressSpaceParseError(
      'mem-section-not-allocated',
      `${symbolName} 符号的内容是 0：稀疏内存的根数组还没分配（或这一帧上内存还没初始化完）`,
      { symbol: symbolName, symbolAddress: toHex(symbolAddress) },
    );
  }
  const rootIndex = sectionNumber / BigInt(sectionsPerRoot);
  const sectionArray = await view.u64(rootArray + rootIndex * BigInt(PTE_ENTRY_BYTES));
  if (sectionArray === 0n) {
    throw new AddressSpaceParseError(
      'sparse-root-empty',
      `${symbolName} 根数组第 ${rootIndex} 项是 0：这个区间的物理内存不存在（页框 ${toHex(options.pfn)} 没有内存）`,
      { pfn: toHex(options.pfn), rootIndex: rootIndex.toString(), rootArray: toHex(rootArray) },
    );
  }
  const sectionAddress = sectionArray + (sectionNumber % BigInt(sectionsPerRoot)) * BigInt(sectionStride);
  const sectionMemMapRaw = await view.u64(sectionAddress);
  const markedPresent = (sectionMemMapRaw & SECTION_MARKED_PRESENT) !== 0n;
  const hasMemMap = (sectionMemMapRaw & SECTION_HAS_MEM_MAP) !== 0n;
  if (!markedPresent || !hasMemMap) {
    throw new AddressSpaceParseError(
      'section-not-present',
      `页框 ${toHex(options.pfn)} 所属的第 ${sectionNumber} 个 section 没被标记为存在`
      + `（section_mem_map = ${toHex(sectionMemMapRaw)}，present=${markedPresent}，has_mem_map=${hasMemMap}）：`
      + '这个页框没有对应的 struct page',
      {
        pfn: toHex(options.pfn),
        sectionNumber: sectionNumber.toString(),
        sectionMemMap: toHex(sectionMemMapRaw),
      },
    );
  }

  const base = sectionMemMapRaw & SECTION_MAP_MASK;
  const matchesCompiledDefault = base === VMEMMAP_BASE_L4;
  if (!matchesCompiledDefault) {
    notes.push(
      `从 mem_section 算出的 vmemmap 基址 ${toHex(base)} 与编译期常量 ${toHex(VMEMMAP_BASE_L4)} 不同：`
      + '本内核没开内存布局随机化，正常情况下应当相等（推理链见 resolveVmemmapBase 的注释）',
    );
  }

  return {
    base,
    source: 'mem-section',
    pageStructSize,
    sectionNumber,
    sectionArray,
    sectionAddress,
    sectionMemMapRaw,
    sectionStartPfn,
    sectionMarkedPresent: markedPresent,
    sectionHasMemMap: hasMemMap,
    matchesCompiledDefault,
    notes,
    evidence,
  };
}
