/** RAM 镜像与脏页增量：按页记录散列和存储引用，按区域重建字节流并核对独立 dump。
 * 缺页和尾部填充使用 fillByte；物理读取、blob 存储及页大小由调用方提供。
 */

import { createHash } from 'node:crypto';

import { sha256Hex } from './hash.ts';
import type { PhysicalReader } from './paging.ts';
import { PhysicalReadError, PAGE_SIZE } from './paging.ts';

export interface RamRegion {
  base: bigint;
  size: bigint;
  /** 区域名（例如 pc.ram），只用于人读的说明 */
  name?: string;
  kind?: string;
}

export interface RamPageRecord {
  address: bigint;
  /** 已记录页的内容散列 */
  sha256: string;
  /** 实际采集到的字节数（区域尾部可能不足一页） */
  length: number;
  /** 存储引用；省略存储器时使用内容散列 */
  blobRef: string | null;
  /** 该页是从哪一次采集读到的 */
  captureId: string | null;
}

export interface RamImageStats {
  pages: number;
  bytes: number;
  /** 覆盖区域的总字节数（含还没采集的页） */
  regionBytes: string;
  regionPages: number;
  /** 还没采集的页数 */
  missingPages: number;
}

function pageOf(address: bigint, pageSize: bigint): bigint {
  return (address / pageSize) * pageSize;
}

/** 一个物理区间覆盖到的所有页起始地址（含首尾）。 */
export function pagesForRange(address: bigint, length: number, pageSize = PAGE_SIZE): bigint[] {
  if (length <= 0) return [];
  const first = pageOf(address, pageSize);
  const last = pageOf(address + BigInt(length) - 1n, pageSize);
  const pages: bigint[] = [];
  for (let page = first; page <= last; page += pageSize) pages.push(page);
  return pages;
}

export function overlap(left: RamRegion, right: RamRegion): boolean {
  const leftEnd = left.base + left.size;
  const rightEnd = right.base + right.size;
  return left.base < rightEnd && right.base < leftEnd;
}

/** RAM 镜像由区域表及页记录组成；每页保存内容散列、长度和存储引用。 */
export class RamImage {
  readonly pageSize: bigint;

  private readonly records = new Map<string, RamPageRecord>();

  private readonly regions: RamRegion[];

  private readonly store: ((bytes: Buffer) => Promise<string | null>) | null;

  private boundCaptureId: string | null = null;

  constructor(options: {
    regions: RamRegion[];
    pageSize?: number;
    /** 可选 blob 存储器；省略时 blobRef 使用内容散列 */
    store?: (bytes: Buffer) => Promise<string | null>;
  }) {
    this.pageSize = BigInt(options.pageSize ?? 4096);
    this.regions = [...options.regions].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    for (let index = 1; index < this.regions.length; index += 1) {
      if (overlap(this.regions[index - 1], this.regions[index])) {
        throw new Error(
          `RAM 区域重叠：${this.regions[index - 1].name ?? this.regions[index - 1].base} 与 `
          + `${this.regions[index].name ?? this.regions[index].base}；重叠区域无法给出唯一的页内容`,
        );
      }
    }
    this.store = options.store ?? null;
  }

  get regionList(): RamRegion[] {
    return this.regions;
  }

  get regionBytes(): bigint {
    return this.regions.reduce((sum, region) => sum + region.size, 0n);
  }

  get regionPageCount(): number {
    return this.regions.reduce(
      (sum, region) => sum + Number((region.size + this.pageSize - 1n) / this.pageSize),
      0,
    );
  }

  /** 绑定一次采集归属；采集 ID 冲突时拒绝混入另一代数据。 */
  bindCapture(captureId: string): void {
    if (this.boundCaptureId === null) {
      this.boundCaptureId = captureId;
      return;
    }
    if (this.boundCaptureId !== captureId) {
      throw new Error(`RAM 镜像已绑定 ${this.boundCaptureId}，不能再写入 ${captureId} 的页（避免混合帧）`);
    }
  }

  /** 当前绑定的采集 ID，初值为 null。 */
  get captureId(): string | null {
    return this.boundCaptureId;
  }

  /** 写入（或覆盖）一页。bytes 必须正好是从该页起始地址读到的那一段。 */
  async setPage(address: bigint, bytes: Uint8Array): Promise<RamPageRecord> {
    const page = pageOf(address, this.pageSize);
    if (page !== address) {
      throw new Error(`页记录必须按 ${this.pageSize} 字节对齐：收到 0x${address.toString(16)}`);
    }
    if (!this.inRegions(address)) {
      throw new Error(`0x${address.toString(16)} 不在任何 RAM 区域内，不记录`);
    }
    const buffer = Buffer.from(bytes);
    const sha256 = sha256Hex(buffer);
    const blobRef = this.store === null ? sha256 : await this.store(buffer);
    const record: RamPageRecord = {
      address: page,
      sha256,
      length: buffer.length,
      blobRef,
      captureId: this.boundCaptureId,
    };
    this.records.set(page.toString(16), record);
    return record;
  }

  /** 只记散列（例如已经算过内容散列的扫描结果）。 */
  setPageHash(address: bigint, sha256: string, length: number, blobRef: string | null = sha256): RamPageRecord {
    const page = pageOf(address, this.pageSize);
    if (!this.inRegions(page)) {
      throw new Error(`0x${page.toString(16)} 不在任何 RAM 区域内，不记录`);
    }
    const record: RamPageRecord = { address: page, sha256, length, blobRef, captureId: this.boundCaptureId };
    this.records.set(page.toString(16), record);
    return record;
  }

  inRegions(address: bigint): boolean {
    return this.regions.some((region) => address >= region.base && address < region.base + region.size);
  }

  get(address: bigint): RamPageRecord | null {
    return this.records.get(pageOf(address, this.pageSize).toString(16)) ?? null;
  }

  get recordedPages(): RamPageRecord[] {
    return [...this.records.values()];
  }

  get stats(): RamImageStats {
    const regionPages = this.regionPageCount;
    return {
      pages: this.records.size,
      bytes: [...this.records.values()].reduce((sum, record) => sum + record.length, 0),
      regionBytes: this.regionBytes.toString(),
      regionPages,
      missingPages: regionPages - this.records.size,
    };
  }

  /**
   * 按区域顺序、页内升序拼出完整字节流并算散列。
   * 未记录的页按 fillByte 填充；已记录但不足一页的尾部也按 fillByte 补齐到页大小，
   * 这样两侧比较的是同一个字节数。
   */
  async hash(options: {
    fillByte?: number;
    /** 获取页内容；内容缺失时返回 null，由重建器按 fillByte 填充 */
    loadPage: (address: bigint, length: number) => Promise<Uint8Array | null>;
  }): Promise<{ sha256: string; bytes: string; recorded: number; filled: number }> {
    const fill = options.fillByte ?? 0;
    const hash = createHash('sha256');
    let recorded = 0;
    let filled = 0;
    let total = 0n;
    for (const region of this.regions) {
      const end = region.base + region.size;
      let address = pageOf(region.base, this.pageSize);
      while (address < end) {
        const within = end - address < this.pageSize ? end - address : this.pageSize;
        const length = Number(within);
        const bytes = await options.loadPage(address, length);
        if (bytes !== null && bytes.length === length) {
          hash.update(bytes);
          recorded += 1;
        } else {
          hash.update(Buffer.alloc(length, fill));
          filled += 1;
        }
        total += within;
        address += this.pageSize;
      }
    }
    return { sha256: hash.digest('hex'), bytes: total.toString(), recorded, filled };
  }
}

export interface RamSweepPage {
  address: bigint;
  sha256: string;
  length: number;
}

export interface RamSweepResult {
  pages: RamSweepPage[];
  bytesRead: bigint;
  physicalReads: number;
  /** 读取失败的页：记录地址与原因 */
  skipped: Array<{ address: bigint; reason: string; code: string }>;
  elapsedMs: number;
}

/**
 * 把 RAM 区域逐页读一遍并算每页散列。
 *
 * 这是「完整 RAM 基线」和「散列扫描型脏页发现」共用的动作：两者读的是同一份
 * 物理内存，区别只在于基线要把内容存下来，扫描只需要散列。
 */
export async function sweepRam(
  reader: PhysicalReader,
  options: {
    regions: RamRegion[];
    pageSize?: number;
    /** 每页读完的回调：返回 false 可以提前停止（例如配额用尽） */
    onPage?: (page: RamSweepPage, index: number) => Promise<void> | void;
  },
): Promise<RamSweepResult> {
  const pageSize = BigInt(options.pageSize ?? 4096);
  const started = Date.now();
  const pages: RamSweepPage[] = [];
  const skipped: RamSweepResult['skipped'] = [];
  let bytesRead = 0n;
  let physicalReads = 0;
  let index = 0;
  for (const region of options.regions) {
    const end = region.base + region.size;
    let address = (region.base / pageSize) * pageSize;
    while (address < end) {
      const within = end - address < pageSize ? end - address : pageSize;
      const length = Number(within);
      try {
        const bytes = await reader.read(address, length);
        physicalReads += 1;
        bytesRead += BigInt(bytes.length);
        const page: RamSweepPage = { address, sha256: sha256Hex(Buffer.from(bytes)), length: bytes.length };
        pages.push(page);
        if (options.onPage) await options.onPage(page, index);
      } catch (error) {
        const code = error instanceof PhysicalReadError ? error.code : 'unexpected-error';
        skipped.push({
          address,
          code,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      index += 1;
      address += pageSize;
    }
  }
  return { pages, bytesRead, physicalReads, skipped, elapsedMs: Date.now() - started };
}

/**
 * 基线只需支持「按页取散列」与「区域总页数」两件事。
 *
 * 这样基线可以有两种实现：会话内的 `RamImage`（记录散列与存储引用），
 * 或落在磁盘上的稠密索引（只存 32 字节散列数组，按页号直接定位）——
 * 512 MiB 的基线有 131072 页，用 Map 存会白占几十 MB。
 */
export interface RamBaselineLookup {
  get(address: bigint): { sha256: string } | null;
  get recordedPages(): Array<{ address: bigint }>;
  get regionPageCount(): number;
}

export interface RamDiff {
  /** 内容变了或被新记录的页（需要进入增量） */
  changed: bigint[];
  /** 两侧都有且散列相同 */
  unchanged: number;
  /** 本次扫描新增的页 */
  added: bigint[];
  /** 扫描没读到、只有基线的页 */
  unreadable: bigint[];
  /** 扫描结果里缺、基线里也缺的页数（按区域算） */
  absent: number;
}

/** 比较扫描与基线的页散列；changed 和 added 进入增量，读取失败单列 unreadable。 */
export function diffSweep(baseline: RamBaselineLookup, sweep: RamSweepResult): RamDiff {
  const changed: bigint[] = [];
  const added: bigint[] = [];
  const unreadable: bigint[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  for (const page of sweep.pages) {
    const key = page.address.toString(16);
    seen.add(key);
    const previous = baseline.get(page.address);
    if (previous === null) added.push(page.address);
    else if (previous.sha256 !== page.sha256) changed.push(page.address);
    else unchanged += 1;
  }
  for (const record of baseline.recordedPages) {
    if (!seen.has(record.address.toString(16))) unreadable.push(record.address);
  }
  const absent = baseline.regionPageCount - baseline.recordedPages.length;
  return { changed: [...changed, ...added], unchanged, added, unreadable, absent };
}

/** 事件派生页集合减去扫描变化页集合，返回设备事件与散列扫描之间的差异。
 * derived 使用设备 DMA 访问权事件，swept 使用逐页重读散列，两者分别保留来源。
 */
export function missedByEvents(derived: bigint[], swept: bigint[]): bigint[] {
  const seen = new Set(swept.map((address) => address.toString(16)));
  return derived.filter((address) => !seen.has(address.toString(16)));
}
