/** x86 分段和分页字节解析：页表字节由 capture 绑定的 PhysicalReader 提供。
 * 模式取自 CR0/CR4/EFER，翻译失败以 fault 区分映射、权限、保留位与读取问题。
 */

import type { CaptureAttribution, EvidenceRef } from '../contracts/common.ts';
import { toHex } from '../contracts/common.ts';
import type {
  AddressTranslation,
  PageTableEntry,
  PagingState,
} from '../contracts/memory.ts';

export const PAGE_SIZE = 4096n;
export const HUGE_PAGE_2M = 2n * 1024n * 1024n;
export const HUGE_PAGE_4M = 4n * 1024n * 1024n;
export const HUGE_PAGE_1G = 1024n * 1024n * 1024n;

/** 物理读失败。code 用协议里的错误码语义（越界/有副作用/快照失效等）。 */
export class PhysicalReadError extends Error {
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PhysicalReadError';
    this.code = code;
    this.detail = detail;
  }

  code: string;
  detail: Record<string, unknown>;
}

/** 物理读接口。实现方必须把读绑定到一次 capture，并在越界/MMIO 时抛错。 */
export interface PhysicalReader {
  read(address: bigint, length: number): Promise<Uint8Array>;
}

export interface PageCacheStats {
  /** 真正打到 reader 的物理读次数 */
  reads: number;
  /** 页缓存命中次数 */
  hits: number;
}

/** 按 4 KiB 页缓存页表字节；整页读取失败时读取所需子范围。 */
export function createPageCache(
  reader: PhysicalReader,
  pageSize = PAGE_SIZE,
): PhysicalReader & { stats: PageCacheStats } {
  const pages = new Map<string, Uint8Array>();
  const stats: PageCacheStats = { reads: 0, hits: 0 };

  async function loadPage(pageStart: bigint): Promise<Uint8Array | null> {
    const key = pageStart.toString(16);
    const cached = pages.get(key);
    if (cached !== undefined) {
      stats.hits += 1;
      return cached;
    }
    let bytes: Uint8Array;
    try {
      bytes = await reader.read(pageStart, Number(pageSize));
    } catch {
      return null;
    }
    stats.reads += 1;
    pages.set(key, bytes);
    return bytes;
  }

  return {
    stats,
    async read(address: bigint, length: number): Promise<Uint8Array> {
      if (length <= 0) return new Uint8Array(0);
      const end = address + BigInt(length);
      const first = (address / pageSize) * pageSize;
      const out = Buffer.alloc(length);
      let cursor = address;
      let filled = 0;
      while (cursor < end) {
        const pageStart = (cursor / pageSize) * pageSize;
        const pageBytes = await loadPage(pageStart);
        if (pageBytes === null) {
          const chunk = await reader.read(cursor, Number(end - cursor));
          stats.reads += 1;
          out.set(chunk, filled);
          filled += chunk.length;
          break;
        }
        const inPage = Number(cursor - pageStart);
        const take = Math.min(pageBytes.length - inPage, Number(end - cursor));
        if (take <= 0) break;
        out.set(pageBytes.subarray(inPage, inPage + take), filled);
        filled += take;
        cursor += BigInt(take);
      }
      if (filled !== length) {
        throw new PhysicalReadError(
          'short-read',
          `只取到 ${filled} 字节，请求 ${length} 字节`,
          { address: toHex(address), length },
        );
      }
      return out;
    },
  };
}

/** 段信息：分段先于分页，线性地址 = 段基址 + 偏移。 */
export interface SegmentInfo {
  base: bigint;
}

/**
 * 翻译上下文。这些量必须来自同一个 capture 的 CPU 快照：
 * 用停止之后新读的 CR3 去解释停止之前的事件会得到另一套页表。
 */
export interface PagingContext {
  cr0: bigint;
  cr3: bigint;
  cr4: bigint;
  efer: bigint;
  /** 当前特权级；决定 U/S 权限判定 */
  cpl: 0 | 3;
  attribution: CaptureAttribution;
  /** 证据来源说明，写进每个页表项的 evidence.refs */
  readerSource?: string;
  /** 地址宽度；16 位段（实模式）用 20 位物理截断 */
  addressSize?: 16 | 32 | 64;
  /** 段基址：调用方给的是段内偏移时用它换算线性地址 */
  segment?: SegmentInfo;
  /** 保留位检查的物理地址宽度；高于它的位必须为 0 */
  maxPhysBits?: number;
}

const CR0_PE = 1n;
const CR0_PG = 1n << 31n;
const CR4_PSE = 1n << 4n;
const CR4_PAE = 1n << 5n;
const CR4_LA57 = 1n << 12n;
const EFER_LMA = 1n << 8n;
const EFER_NXE = 1n << 11n;

const PTE_PRESENT = 1n;
const PTE_RW = 1n << 1n;
const PTE_USER = 1n << 2n;
const PTE_PWT = 1n << 3n;
const PTE_PCD = 1n << 4n;
const PTE_ACCESSED = 1n << 5n;
const PTE_DIRTY = 1n << 6n;
const PTE_PS = 1n << 7n;
const PTE_PAT = 1n << 7n;
const PTE_GLOBAL = 1n << 8n;
/**
 * 大页项里允许出现在页内偏移范围内的位：0-8 保持 P/RW/US/PWT/PCD/A/D/PS/G 的常规含义，
 * 9-11 是软件可用的 AVL，12 是 PAT。其余低位（2 MiB 页的 20:13、1 GiB 页的 29:13）必须为 0。
 */
const HUGE_ALLOWED_LOW_BITS = 0x1fffn;

export type PagingMode =
  | { kind: 'none'; note: string }
  | { kind: 'protected32'; note: string }
  | { kind: 'pae'; note: string }
  | { kind: 'long'; levels: 4 | 5; note: string };

/** 依据 CR0.PG/PE、CR4.PAE/LA57 和 EFER.LMA 判定分页模式。 */
export function resolvePagingMode(ctx: PagingContext): PagingMode {
  const paging = (ctx.cr0 & CR0_PG) !== 0n;
  const protectedMode = (ctx.cr0 & CR0_PE) !== 0n;
  const pae = (ctx.cr4 & CR4_PAE) !== 0n;
  if (!paging) {
    return {
      kind: 'none',
      note: protectedMode
        ? 'CR0.PG=0：保护模式但未启用分页，线性地址直接当物理地址用'
        : 'CR0.PG=0 且 CR0.PE=0：实模式，不启用分页（线性地址 = 段基址 + 偏移）',
    };
  }
  if (protectedMode && pae && (ctx.efer & EFER_LMA) !== 0n) {
    const la57 = (ctx.cr4 & CR4_LA57) !== 0n;
    return {
      kind: 'long',
      levels: la57 ? 5 : 4,
      note: `长模式 + ${la57 ? '五级' : '四级'}页表（CR0.PE=1, CR4.PAE=1, EFER.LMA=1, CR4.LA57=${la57 ? '1' : '0'}）`,
    };
  }
  if (pae) {
    return {
      kind: 'pae',
      note: '32 位保护模式 + PAE 三级页表（CR0.PG=1, CR4.PAE=1, EFER.LMA=0）；'
        + '契约 PagingState.levels 只枚举 4|5|2，PAE 的实际层级在 walk 里给出',
    };
  }
  return {
    kind: 'protected32',
    note: `32 位两级页表（CR0.PG=1, CR4.PAE=0），CR4.PSE=${(ctx.cr4 & CR4_PSE) !== 0n ? 1 : 0}`
      + `${(ctx.cr4 & CR4_PSE) !== 0n ? '（PDE.PS=1 时 4 MiB 大页生效）' : '（PDE.PS 被忽略）'}`,
  };
}

interface LevelSpec {
  name: string;
  index: number;
  /** 该项是大页时对应的页大小 */
  huge: bigint | null;
}

function levelSpecs(ctx: PagingContext, mode: PagingMode, linear: bigint): {
  specs: LevelSpec[];
  entrySize: number;
  cr3Mask: bigint;
} {
  if (mode.kind === 'long') {
    const entrySize = 8;
    const cr3Mask = 0x000ffffffffff000n;
    if (mode.levels === 5) {
      return {
        entrySize,
        cr3Mask,
        specs: [
          { name: 'PML5', index: Number((linear >> 48n) & 0x1ffn), huge: null },
          { name: 'PML4', index: Number((linear >> 39n) & 0x1ffn), huge: null },
          { name: 'PDPT', index: Number((linear >> 30n) & 0x1ffn), huge: HUGE_PAGE_1G },
          { name: 'PD', index: Number((linear >> 21n) & 0x1ffn), huge: HUGE_PAGE_2M },
          { name: 'PT', index: Number((linear >> 12n) & 0x1ffn), huge: null },
        ],
      };
    }
    return {
      entrySize,
      cr3Mask,
      specs: [
        { name: 'PML4', index: Number((linear >> 39n) & 0x1ffn), huge: null },
        { name: 'PDPT', index: Number((linear >> 30n) & 0x1ffn), huge: HUGE_PAGE_1G },
        { name: 'PD', index: Number((linear >> 21n) & 0x1ffn), huge: HUGE_PAGE_2M },
        { name: 'PT', index: Number((linear >> 12n) & 0x1ffn), huge: null },
      ],
    };
  }
  if (mode.kind === 'pae') {
    return {
      entrySize: 8,
      cr3Mask: 0x000ffffffffff000n,
      specs: [
        { name: 'PDPT', index: Number((linear >> 30n) & 0x3n), huge: null },
        { name: 'PD', index: Number((linear >> 21n) & 0x1ffn), huge: HUGE_PAGE_2M },
        { name: 'PT', index: Number((linear >> 12n) & 0x1ffn), huge: null },
      ],
    };
  }
  const pse = (ctx.cr4 & CR4_PSE) !== 0n;
  return {
    entrySize: 4,
    cr3Mask: 0xfffff000n,
    specs: [
      { name: 'PD', index: Number((linear >> 22n) & 0x3ffn), huge: pse ? HUGE_PAGE_4M : null },
      { name: 'PT', index: Number((linear >> 12n) & 0x3ffn), huge: null },
    ],
  };
}

function physicalBase(raw: bigint, entrySize: number, pageSize: bigint | null): bigint {
  const mask = entrySize === 8 ? 0x000ffffffffff000n : 0xfffff000n;
  const base = raw & mask;
  return pageSize === null ? base : base & ~(pageSize - 1n);
}

function readLittleEndian(bytes: Uint8Array): bigint {
  let raw = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    raw = (raw << 8n) | BigInt(bytes[index]);
  }
  return raw;
}

/**
 * 把线性地址翻译成物理地址。
 *
 * 失败时 `physical` 为 null，`fault.kind` 区分未映射 / 权限 / 保留位违规 /
 * 本层不支持（非规范地址、页表项所在页不在采集范围内）。
 * `walk` 保留已经读到的每一级条目（含失败那一级）。
 */
export async function translateLinear(
  reader: PhysicalReader,
  ctx: PagingContext,
  offset: bigint,
): Promise<AddressTranslation> {
  const mode = resolvePagingMode(ctx);
  const linear = ctx.segment ? ctx.segment.base + offset : offset;
  const base = { linear: toHex(linear), attribution: ctx.attribution };

  if (mode.kind === 'none') {
    const mask = (ctx.addressSize ?? 32) === 16 ? 0xfffffn : 0xffffffffn;
    return { ...base, physical: toHex(linear & mask), pageSize: null, huge: false, fault: null, walk: [] };
  }

  if (mode.kind === 'long') {
    const signBit = mode.levels === 5 ? 56n : 47n;
    const highBits = mode.levels === 5 ? 7n : 16n;
    const upper = (linear >> (signBit + 1n)) & ((1n << highBits) - 1n);
    const sign = (linear >> signBit) & 1n;
    const expected = sign === 1n ? (1n << highBits) - 1n : 0n;
    if (upper !== expected) {
      return {
        ...base,
        physical: null,
        pageSize: null,
        huge: false,
        fault: {
          kind: 'unsupported',
          level: null,
          detail: `非规范线性地址 ${toHex(linear)}：第 ${signBit} 位是 ${sign}，高 ${highBits} 位不是符号扩展`
            + '（架构上是 #GP 而不是缺页，这里不折算成缺页，也不猜一个物理地址）',
        },
        walk: [],
      };
    }
  } else if (linear > 0xffffffffn) {
    return {
      ...base,
      physical: null,
      pageSize: null,
      huge: false,
      fault: {
        kind: 'unsupported',
        level: null,
        detail: `32 位分页模式收到超出 32 位的线性地址 ${toHex(linear)}；先检查段基址与偏移的位数`,
      },
      walk: [],
    };
  }

  const { specs, entrySize, cr3Mask } = levelSpecs(ctx, mode, linear);
  const walk: PageTableEntry[] = [];
  /** 契约的 pageSize 是 number（4096 / 2 MiB / 1 GiB 都在安全整数范围内）。 */
  const asSize = (value: bigint | null): number | null => (value === null ? null : Number(value));
  const maxPhysBits = BigInt(ctx.maxPhysBits ?? 52);
  /** 长模式保留位检查：物理地址字段中 [maxPhysBits, 52) 的位，以及 NXE=0 时的 bit 63。
   * maxPhysBits 默认取 52；52..62 属于忽略位或保护键，Linux 可在其中保存软件状态。
   */
  const reservedMask = (((1n << 52n) - 1n) & ~((1n << maxPhysBits) - 1n))
    | ((ctx.efer & EFER_NXE) !== 0n ? 0n : (1n << 63n));
  let tableBase = ctx.cr3 & cr3Mask;

  for (let level = 0; level < specs.length; level += 1) {
    const spec = specs[level];
    const entryAddress = tableBase + BigInt(spec.index * entrySize);
    let bytes: Uint8Array;
    try {
      bytes = await reader.read(entryAddress, entrySize);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        physical: null,
        pageSize: null,
        huge: false,
        fault: {
          kind: 'unsupported',
          level,
          detail: `${spec.name} 第 ${spec.index} 项（${toHex(entryAddress)}）读不到：${detail}`,
        },
        walk,
      };
    }
    const raw = readLittleEndian(bytes);
    const present = (raw & PTE_PRESENT) !== 0n;
    const writable = (raw & PTE_RW) !== 0n;
    const user = (raw & PTE_USER) !== 0n;
    const noExecute = (ctx.efer & EFER_NXE) !== 0n && (raw >> 63n) === 1n;
    const psSet = (raw & PTE_PS) !== 0n;
    const pageSizeBytes = psSet && spec.huge !== null ? spec.huge : level === specs.length - 1 ? PAGE_SIZE : null;
    const evidence: EvidenceRef = {
      kind: 'decoded',
      source: ctx.readerSource ?? 'observer',
      captureId: ctx.attribution.captureId,
      refs: [`physical:${toHex(entryAddress)}:${entrySize}`],
    };

    const entry: PageTableEntry = {
      tableAddress: toHex(entryAddress),
      index: spec.index,
      raw: toHex(raw),
      present,
      writable,
      user,
      huge: pageSizeBytes !== null && level !== specs.length - 1 && psSet,
      physicalAddress: null,
      noExecute,
      evidence,
    };
    walk.push(entry);

    if (!present) {
      return {
        ...base,
        physical: null,
        pageSize: asSize(pageSizeBytes),
        huge: false,
        fault: {
          kind: 'not-present',
          level,
          detail: `${spec.name} 第 ${spec.index} 项 present=0（条目地址 ${toHex(entryAddress)}，raw=${toHex(raw)}）`,
        },
        walk,
      };
    }

    if (ctx.cpl === 3 && !user) {
      return {
        ...base,
        physical: null,
        pageSize: asSize(pageSizeBytes),
        huge: false,
        fault: {
          kind: 'permission',
          level,
          detail: `${spec.name} 第 ${spec.index} 项 U/S=0，而当前 CPL=3（用户态不可访问）`,
        },
        walk,
      };
    }

    if ((raw & reservedMask) !== 0n) {
      return {
        ...base,
        physical: null,
        pageSize: asSize(pageSizeBytes),
        huge: false,
        fault: {
          kind: 'reserved',
          level,
          detail: `${spec.name} 第 ${spec.index} 项保留位非 0：raw=${toHex(raw)}（物理地址宽度按 ${maxPhysBits} 位解释，`
            + `只有 [${maxPhysBits},52) 与 NXE 关闭时的 bit 63 算保留位，掩码=${toHex(reservedMask)}）`,
        },
        walk,
      };
    }

    if (entry.huge && spec.huge !== null) {
      const low = raw & (spec.huge - 1n);
      if ((low & ~HUGE_ALLOWED_LOW_BITS) !== 0n) {
        return {
          ...base,
          physical: null,
          pageSize: asSize(spec.huge),
          huge: true,
          fault: {
            kind: 'reserved',
            level,
            detail: `${spec.name} 第 ${spec.index} 项声明为大页（${spec.huge} 字节），但页内偏移范围里的低位不为 0：`
              + `raw=${toHex(raw)}，low=${toHex(low)}`,
          },
          walk,
        };
      }
      const aligned = physicalBase(raw, entrySize, spec.huge);
      entry.physicalAddress = toHex(aligned);
      return {
        ...base,
        physical: toHex(aligned + (linear & (spec.huge - 1n))),
        pageSize: asSize(spec.huge),
        huge: true,
        fault: null,
        walk,
      };
    }

    if (level === specs.length - 1) {
      const aligned = physicalBase(raw, entrySize, PAGE_SIZE);
      entry.physicalAddress = toHex(aligned);
      return {
        ...base,
        physical: toHex(aligned + (linear & 0xfffn)),
        pageSize: asSize(PAGE_SIZE),
        huge: false,
        fault: null,
        walk,
      };
    }

    const next = physicalBase(raw, entrySize, null);
    entry.physicalAddress = toHex(next);
    tableBase = next;
  }

  return {
    ...base,
    physical: null,
    pageSize: null,
    huge: false,
    fault: { kind: 'unsupported', level: null, detail: '遍历结束但没有得到物理地址' },
    walk,
  };
}

/** 面板分页状态：levels 使用 4/5/2；PAE 三级及 CR0.PG=0 时返回 null 并说明模式。 */
export function describePaging(ctx: PagingContext): PagingState {
  const mode = resolvePagingMode(ctx);
  if (mode.kind === 'none') {
    return { enabled: false, levels: null, rootTable: null, note: mode.note };
  }
  return {
    enabled: true,
    levels: mode.kind === 'long' ? mode.levels : mode.kind === 'protected32' ? 2 : null,
    rootTable: toHex(ctx.cr3 & (mode.kind === 'protected32' ? 0xfffff000n : 0x000ffffffffff000n)),
    note: mode.note,
  };
}
