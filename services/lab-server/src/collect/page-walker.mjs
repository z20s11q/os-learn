/**
 * page-walker：把 T06 的纯字节分页解析器接到某一次 capture 的 CPU 状态上。
 *
 * 三条硬约束：
 * 1. 翻译用的 CR0/CR3/CR4/EFER/CPL/段缓存必须来自**同一个停止点**的 CPU 快照
 *    （帧里的 `cpu`），而不是翻译时现读的寄存器——用停止之后新读到的 CR3 去
 *    解释停止之前的事件，会得到另一套页表，翻译结果看着合理但是错的。
 * 2. 页表字节必须通过**绑定 captureId** 的读取器取；读取器拒绝（快照过期、
 *    区域外、MMIO 副作用）时如实报错，不回退到别的通道。
 * 3. 模式判定只用 CR0.PG/PE、CR4.PAE/LA57、EFER.LMA 的实际位，不按
 *    「看起来像长模式」推测。
 */

import { createPageCache, describePaging, translateLinear } from '../../../../packages/trace-format/paging.ts';
import { toBigIntValue } from './capture-reader.mjs';

/** 没有 CPUID 的 MAXPHYSADDR 时按 52 位（长模式标准实现宽度）做保留位检查。 */
const DEFAULT_MAX_PHYS_BITS = 52;

/**
 * 从帧的 CPU 快照组装翻译上下文。
 *
 * 缺 CR0/CR3/CR4 时返回 null：分页解析离开控制寄存器没有意义，宁可报
 * 「本帧拿不到控制寄存器」也不要用 0 假装「未分页」——那会把所有线性地址
 * 当作物理地址，把「不知道」说成「恒等映射」。
 */
export function pagingContextFor(cpu, attribution, options = {}) {
  const cr0 = toBigIntValue(cpu?.control?.cr0);
  const cr3 = toBigIntValue(cpu?.control?.cr3);
  const cr4 = toBigIntValue(cpu?.control?.cr4);
  if (cr0 === null || cr3 === null || cr4 === null) return null;

  const efer = toBigIntValue(cpu?.efer) ?? 0n;
  const cpl = cpu?.cpl === 3 ? 3 : 0;
  const addressSize = cpu?.mode === 'real-16' ? 16 : cpu?.mode === 'protected-32' ? 32 : 64;
  const csBase = toBigIntValue(cpu?.segments?.cs?.base);
  const segment = options.segmentBase !== undefined
    ? { base: BigInt(options.segmentBase) }
    : csBase !== null && options.withSegment === true
      ? { base: csBase }
      : undefined;

  return {
    cr0,
    cr3,
    cr4,
    efer,
    cpl,
    attribution,
    readerSource: options.readerSource ?? 'observer',
    addressSize: options.addressSize ?? addressSize,
    ...(segment ? { segment } : {}),
    maxPhysBits: options.maxPhysBits ?? DEFAULT_MAX_PHYS_BITS,
  };
}

/**
 * 一次翻译会话：共享页缓存、共享上下文。
 *
 * 缓存的意义在这里不是「省几次读」而是「同一份快照里的页表只解释一次」：
 * 512 MiB 的 RAM 上有几千张页表，逐地址翻译时同一张表会被反复命中。
 */
export class PageWalker {
  constructor({ cpu, attribution, reader, readerSource = 'observer', segmentBase, withSegment = false }) {
    this.cpu = cpu;
    this.attribution = attribution;
    this.baseReader = reader;
    this.cached = createPageCache(reader);
    this.context = pagingContextFor(cpu, attribution, {
      readerSource,
      ...(segmentBase !== undefined ? { segmentBase } : {}),
      withSegment,
    });
    if (this.context === null) {
      // eslint-disable-next-line no-throw-literal
      throw new Error(
        '本帧的 CPU 快照没有 CR0/CR3/CR4，无法解析分页：控制寄存器来自 GDB/MI 与观察者快照，'
        + '缺失时不能用「未分页」冒充',
      );
    }
    this.translations = 0;
  }

  /** 契约里的 PagingState（面板显示用）。 */
  describe() {
    return describePaging(this.context);
  }

  async translate(address) {
    const value = toBigIntValue(address);
    if (value === null) throw new Error(`线性地址无法解析: ${String(address)}`);
    this.translations += 1;
    return translateLinear(this.cached, this.context, value);
  }

  async translateMany(addresses) {
    const out = [];
    for (const address of addresses) out.push(await this.translate(address));
    return out;
  }

  /** 缓存统计：用来区分「页表真的读了这么多次」与「都是缓存命中」。 */
  get stats() {
    return { ...this.cached.stats, translations: this.translations };
  }
}

/**
 * 翻译一段线性地址并读出字节（addressSpace='linear' 的读）。
 *
 * 按页翻译：线性地址连续不代表物理地址连续，靠一次翻译去读整段会在
 * 跨页处读错。只要有一页翻译失败就整体失败并返回该处的 fault——
 * 返回「部分字节 + 一个洞」会让调用方以为读到了完整内容。
 */
export async function readLinear(walker, address, length) {
  const start = toBigIntValue(address);
  if (start === null) throw new Error(`线性地址无法解析: ${String(address)}`);
  if (!Number.isInteger(length) || length <= 0) throw new Error(`长度必须是正整数，收到 ${length}`);
  const PAGE = 4096n;
  const end = start + BigInt(length);
  const chunks = [];
  let first = null;
  let cursor = start;
  while (cursor < end) {
    const pageStart = (cursor / PAGE) * PAGE;
    const translation = await walker.translate(pageStart);
    if (first === null) first = translation;
    if (translation.fault !== null || translation.physical === null) {
      return { translation, bytes: null };
    }
    const inPage = Number(cursor - pageStart);
    const take = Math.min(Number(PAGE) - inPage, Number(end - cursor));
    const physical = BigInt(translation.physical) + BigInt(inPage);
    chunks.push(await walker.baseReader.read(physical, take));
    cursor += BigInt(take);
  }
  return { translation: first, bytes: Buffer.concat(chunks) };
}
