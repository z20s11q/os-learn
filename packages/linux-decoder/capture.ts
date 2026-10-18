/** ReadOnlyCapture 是解析器的字节与符号来源，读取绑定到同一次采集。
 * 实现方负责虚拟地址读取及副作用校验；读取失败抛 CaptureReadError，零值保留内核语义。
 */

import type { CaptureAttribution, EvidenceRef } from '../contracts/common.ts';
import { toHex } from '../contracts/common.ts';

export type { CaptureAttribution };

/** 读取失败的稳定分类与上下文，供解析器报告覆盖缺口。 */
export class CaptureReadError extends Error {
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CaptureReadError';
    this.code = code;
    this.detail = detail;
  }

  code: string;
  detail: Record<string, unknown>;
}

/**
 * 只读采集。实现方（服务层、验收脚本的桩、单测的合成内存）负责把
 * 「一次停止点的内存」和「一次停止点的符号表」凑齐。
 */
export interface ReadOnlyCapture {
  /** 这份数据属于哪一帧、哪一次采集。所有证据引用都从这里取。 */
  readonly attribution: CaptureAttribution;
  /** 内核 release 字符串；拿不到时为 null（不要编造）。 */
  readonly kernelRelease: string | null;
  /** 读内核虚拟地址（线性地址）。读不到必须抛 `CaptureReadError`。 */
  readVirtual(address: bigint, length: number): Promise<Uint8Array>;
  /** 内核链接符号地址；符号查找失败时返回 null。 */
  symbolAddress(name: string): bigint | null;
  /** 符号大小；符号表没给大小返回 null。 */
  symbolSize(name: string): bigint | null;
}

/** 采集层的符号缺口说明，包含缺失来源。 */
export const SYMBOL_UNAVAILABLE_REASON = '本次采集没有提供符号表（或该符号不在表里）';

export function isCaptureAttribution(value: unknown): value is CaptureAttribution {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CaptureAttribution>;
  return (
    typeof candidate.sessionId === 'string'
    && typeof candidate.epoch === 'number'
    && typeof candidate.frameId === 'number'
    && typeof candidate.captureId === 'string'
  );
}

/** 构造一条指向某次读的证据引用。 */
export function memoryEvidence(
  capture: ReadOnlyCapture,
  address: bigint,
  length: number,
  extra: string[] = [],
): EvidenceRef {
  return {
    kind: 'decoded',
    source: 'linux-decoder',
    captureId: capture.attribution.captureId,
    refs: [`memory:${toHex(address)}:${length}`, ...extra],
  };
}

export interface MemoryViewStats {
  /** 真正打到 capture 的读取次数 */
  reads: number;
  /** 页缓存命中次数 */
  hits: number;
  bytes: bigint;
}

/** 按页缓存采集字节，结构字段复用同一份缓存内容。 */
export class KernelMemoryView {
  private readonly pages = new Map<string, Uint8Array>();

  private readonly stats: MemoryViewStats = { reads: 0, hits: 0, bytes: 0n };

  private readonly capture: ReadOnlyCapture;

  private readonly pageSize: bigint;

  constructor(capture: ReadOnlyCapture, pageSize = 4096n) {
    this.capture = capture;
    this.pageSize = pageSize;
  }

  get evidenceSource(): ReadOnlyCapture {
    return this.capture;
  }

  get counters(): MemoryViewStats {
    return { ...this.stats, bytes: this.stats.bytes };
  }

  async bytes(address: bigint, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 0) {
      throw new CaptureReadError('invalid-length', `读取长度必须是非负整数，收到 ${length}`, {
        address: toHex(address),
        length,
      });
    }
    if (length === 0) return new Uint8Array(0);
    const out = Buffer.alloc(length);
    const end = address + BigInt(length);
    let cursor = address;
    let filled = 0;
    while (cursor < end) {
      const pageStart = (cursor / this.pageSize) * this.pageSize;
      const page = await this.#page(pageStart);
      const within = Number(cursor - pageStart);
      if (within >= page.length) {
        // 整页读取失败时按所需范围直接读取。
        const chunk = await this.#direct(cursor, Number(end - cursor));
        out.set(chunk, filled);
        filled += chunk.length;
        break;
      }
      const take = Math.min(page.length - within, Number(end - cursor));
      out.set(page.subarray(within, within + take), filled);
      filled += take;
      cursor += BigInt(take);
    }
    if (filled !== length) {
      throw new CaptureReadError('short-read', `只取到 ${filled} 字节，请求 ${length} 字节`, {
        address: toHex(address),
        length,
        captureId: this.capture.attribution.captureId,
      });
    }
    return out;
  }

  async #direct(address: bigint, length: number): Promise<Uint8Array> {
    const bytes = await this.capture.readVirtual(address, length);
    this.stats.reads += 1;
    this.stats.bytes += BigInt(bytes.length);
    return new Uint8Array(bytes);
  }

  async #page(pageStart: bigint): Promise<Uint8Array> {
    const key = pageStart.toString(16);
    const cached = this.pages.get(key);
    if (cached !== undefined) {
      this.stats.hits += 1;
      return cached;
    }
    const bytes = await this.#direct(pageStart, Number(this.pageSize));
    this.pages.set(key, bytes);
    return bytes;
  }

  /** 无符号小端整数；宽度 7–8 字节时返回 bigint（内核地址会超过 2^53）。 */
  async uint(address: bigint, byteSize: number): Promise<number | bigint> {
    const bytes = await this.bytes(address, byteSize);
    return littleEndianToBigInt(bytes);
  }

  async u32(address: bigint): Promise<number> {
    const value = await this.uint(address, 4);
    return Number(value);
  }

  async s32(address: bigint): Promise<number> {
    const raw = Number(await this.uint(address, 4));
    return raw >= 0x80000000 ? raw - 0x100000000 : raw;
  }

  async u16(address: bigint): Promise<number> {
    return Number(await this.uint(address, 2));
  }

  async u64(address: bigint): Promise<bigint> {
    return BigInt(await this.uint(address, 8));
  }

  async s64(address: bigint): Promise<bigint> {
    const raw = await this.u64(address);
    return raw >= 0x8000000000000000n ? raw - 0x10000000000000000n : raw;
  }

  /** 读指针；返回 0 表示采到空指针，读取失败由异常表达。 */
  async pointer(address: bigint): Promise<bigint | null> {
    const value = await this.u64(address);
    return value === 0n ? null : value;
  }

  /** 读取 C 字符串，最多 maxLength 字节；达到上限时返回前缀并标记截断。 */
  async cstring(address: bigint, maxLength: number): Promise<{ text: string; truncated: boolean }> {
    const bytes = await this.bytes(address, maxLength);
    const end = bytes.indexOf(0);
    if (end < 0) {
      return { text: Buffer.from(bytes).toString('utf8'), truncated: true };
    }
    return { text: Buffer.from(bytes.subarray(0, end)).toString('utf8'), truncated: false };
  }

  /** 查找符号地址；符号查找失败时抛 CaptureReadError。 */
  symbol(name: string): bigint {
    const address = this.capture.symbolAddress(name);
    if (address === null) {
      throw new CaptureReadError('symbol-missing', `符号 ${name} 不在本次采集的符号表里`, {
        symbol: name,
        captureId: this.capture.attribution.captureId,
      });
    }
    return address;
  }

  /** 符号大小；符号表没给大小时返回 null。 */
  symbolSize(name: string): bigint | null {
    return this.capture.symbolSize(name);
  }
}

/** 小端字节 → 非负整数；8 字节返回 bigint。 */
export function littleEndianToBigInt(bytes: Uint8Array): number | bigint {
  if (bytes.length === 0) return 0;
  if (bytes.length > 8) {
    throw new CaptureReadError('unsupported-width', `只支持 1–8 字节的整数读取，收到 ${bytes.length} 字节`);
  }
  if (bytes.length >= 7) {
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
    return value;
  }
  let value = 0;
  for (let index = bytes.length - 1; index >= 0; index -= 1) value = value * 256 + bytes[index];
  return value;
}

/** 固定字节内存的采集实现，供单元测试和离线重放使用。 */
export class BufferCapture implements ReadOnlyCapture {
  private readonly buffer: Uint8Array;

  private readonly symbols = new Map<string, bigint>();

  private readonly sizes = new Map<string, bigint>();

  readonly attribution: CaptureAttribution;

  readonly kernelRelease: string | null;

  /** 逐次读取记录，供测试核对页缓存命中。 */
  readonly reads: Array<{ address: bigint; length: number }> = [];

  /** 设置读取拒绝区间，供降级分支测试。 */
  readonly forbidden: Array<{ address: bigint; length: number }> = [];

  constructor(options: {
    size?: number;
    attribution?: Partial<CaptureAttribution>;
    kernelRelease?: string | null;
  } = {}) {
    this.buffer = new Uint8Array(options.size ?? 0x20000);
    this.attribution = {
      sessionId: options.attribution?.sessionId ?? 'unit-test',
      epoch: options.attribution?.epoch ?? 1,
      frameId: options.attribution?.frameId ?? 1,
      captureId: options.attribution?.captureId ?? 'unit-test-capture',
    };
    this.kernelRelease = options.kernelRelease ?? null;
  }

  get bytes(): Uint8Array {
    return this.buffer;
  }

  defineSymbol(name: string, address: bigint, size: bigint | null = null): void {
    this.symbols.set(name, address);
    if (size !== null) this.sizes.set(name, size);
  }

  write(address: bigint, length: number): Uint8Array {
    this.#check(address, length);
    return this.buffer.subarray(Number(address), Number(address) + length);
  }

  async readVirtual(address: bigint, length: number): Promise<Uint8Array> {
    this.#check(address, length);
    this.reads.push({ address, length });
    for (const blocked of this.forbidden) {
      if (address < blocked.address + BigInt(blocked.length) && blocked.address < address + BigInt(length)) {
        throw new CaptureReadError('forbidden', `测试桩禁止读取 0x${address.toString(16)}`, {
          address: `0x${address.toString(16)}`,
        });
      }
    }
    return new Uint8Array(this.buffer.subarray(Number(address), Number(address) + length));
  }

  symbolAddress(name: string): bigint | null {
    return this.symbols.get(name) ?? null;
  }

  symbolSize(name: string): bigint | null {
    return this.sizes.get(name) ?? null;
  }

  #check(address: bigint, length: number): void {
    if (address < 0n || address + BigInt(length) > BigInt(this.buffer.length)) {
      throw new CaptureReadError('range-not-captured', `测试内存越界：0x${address.toString(16)}+${length}`, {
        address: `0x${address.toString(16)}`,
        length,
        size: this.buffer.length,
      });
    }
  }
}

/** 往一段字节里按小端写整数（单测造数据用）。 */
export function writeLittleEndian(target: Uint8Array, offset: number, value: bigint, width: number): void {
  let rest = value;
  for (let index = 0; index < width; index += 1) {
    target[offset + index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}
