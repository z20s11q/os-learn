/** per-CPU 变量地址 = __per_cpu_offset[cpu] + 符号链接地址。
 * 构造时校验 __per_cpu_start=0，读取时校验 CPU 范围和符号段归属。
 */

import { CaptureReadError, KernelMemoryView } from '../capture.ts';
import type { ReadOnlyCapture } from '../capture.ts';
import { toHex } from '../../contracts/common.ts';

/** per-CPU 区间的符号名。 */
export const PER_CPU_START = '__per_cpu_start';
export const PER_CPU_END = '__per_cpu_end';
export const PER_CPU_OFFSET = '__per_cpu_offset';
export const NR_CPU_IDS = 'nr_cpu_ids';

export class PerCpuError extends CaptureReadError {}

export interface PerCpuFacts {
  /** `__per_cpu_offset[]` 的地址 */
  offsetTable: bigint;
  /** per-CPU 区间的链接地址边界（`__per_cpu_start` 必须是 0） */
  sectionStart: bigint;
  sectionEnd: bigint;
  /** 已读到的 `nr_cpu_ids`（可能大于实际在线 CPU 数） */
  cpuIds: number;
  /** 实际读过的 `__per_cpu_offset[]` 条目，避免每个 CPU 都重读一次数组 */
  bases: Map<number, bigint>;
}

/** 以 nr_cpu_ids 校验 CPU 下标，按对应数组条目获取 per-CPU 基址。 */
export class PerCpuIndex {
  private facts: PerCpuFacts | null = null;

  private readonly view: KernelMemoryView;

  private readonly capture: ReadOnlyCapture;

  constructor(view: KernelMemoryView, capture: ReadOnlyCapture) {
    this.view = view;
    this.capture = capture;
  }

  async #load(): Promise<PerCpuFacts> {
    if (this.facts !== null) return this.facts;
    const sectionStart = this.capture.symbolAddress(PER_CPU_START);
    const sectionEnd = this.capture.symbolAddress(PER_CPU_END);
    const offsetTable = this.capture.symbolAddress(PER_CPU_OFFSET);
    const missing = [
      [PER_CPU_START, sectionStart],
      [PER_CPU_END, sectionEnd],
      [PER_CPU_OFFSET, offsetTable],
    ].filter(([, value]) => value === null).map(([name]) => name as string);
    if (missing.length > 0) {
      throw new PerCpuError(
        'symbol-missing',
        `本次采集的符号表里缺少 ${missing.join('、')}，无法做每 CPU 地址换算`,
        { missing, captureId: this.capture.attribution.captureId },
      );
    }
    if (sectionStart !== 0n) {
      // 链接区起点违反零起点约定，抛出解析错误。
      throw new PerCpuError(
        'percpu-basis-changed',
        `${PER_CPU_START} 的符号值是 ${toHex(sectionStart!)} 而不是 0，`
        + '「链接地址即 per-CPU 偏移」这条约定在这个核上不成立，不能用 __per_cpu_offset 相加',
        { sectionStart: toHex(sectionStart!), offsetTable: toHex(offsetTable!) },
      );
    }
    const cpuIdsRaw = this.capture.symbolAddress(NR_CPU_IDS);
    let cpuIds = 0;
    if (cpuIdsRaw !== null) {
      cpuIds = Number(await this.view.uint(cpuIdsRaw, 4));
    }
    this.facts = {
      offsetTable: offsetTable!,
      sectionStart: sectionStart!,
      sectionEnd: sectionEnd!,
      cpuIds,
      bases: new Map(),
    };
    return this.facts;
  }

  /** `nr_cpu_ids`；符号拿不到时为 0（调用方据此报"不知道有多少 CPU"）。 */
  async cpuCount(): Promise<number> {
    return (await this.#load()).cpuIds;
  }

  /** 第 cpu 号 CPU 的 per-CPU 区基址。 */
  async base(cpu: number): Promise<bigint> {
    const facts = await this.#load();
    if (!Number.isInteger(cpu) || cpu < 0) {
      throw new PerCpuError('invalid-cpu', `CPU 编号必须是非负整数，收到 ${cpu}`, { cpu });
    }
    if (facts.cpuIds > 0 && cpu >= facts.cpuIds) {
      throw new PerCpuError(
        'cpu-out-of-range',
        `CPU 编号 ${cpu} 超出 nr_cpu_ids=${facts.cpuIds}；不是这台机器上存在的 CPU`,
        { cpu, cpuIds: facts.cpuIds },
      );
    }
    const cached = facts.bases.get(cpu);
    if (cached !== undefined) return cached;
    const address = facts.offsetTable + BigInt(cpu) * 8n;
    const value = await this.view.u64(address);
    facts.bases.set(cpu, value);
    return value;
  }

  /** 某个 per-CPU 符号在第 cpu 号 CPU 上的实际地址。 */
  async address(name: string, cpu: number): Promise<bigint> {
    const facts = await this.#load();
    const linkAddress = this.capture.symbolAddress(name);
    if (linkAddress === null) {
      throw new PerCpuError('symbol-missing', `符号 ${name} 不在本次采集的符号表里`, { symbol: name });
    }
    if (linkAddress < facts.sectionStart || linkAddress >= facts.sectionEnd) {
      // 符号位于 per-CPU 区间外，拒绝按 per-CPU 寻址。
      throw new PerCpuError(
        'not-a-percpu-symbol',
        `${name}（链接地址 ${toHex(linkAddress)}）不在 per-CPU 区间 `
        + `[${toHex(facts.sectionStart)}, ${toHex(facts.sectionEnd)}) 内，它不是 per-CPU 变量`,
        { symbol: name, linkAddress: toHex(linkAddress) },
      );
    }
    return (await this.base(cpu)) + linkAddress;
  }

  /** 这个符号是不是 per-CPU 变量。 */
  async isPerCpuSymbol(name: string): Promise<boolean> {
    const facts = await this.#load();
    const linkAddress = this.capture.symbolAddress(name);
    if (linkAddress === null) return false;
    return linkAddress >= facts.sectionStart && linkAddress < facts.sectionEnd;
  }

  /** per-CPU 区间与基址表的信息，写进证据供面板展示。 */
  async describe(): Promise<Record<string, unknown>> {
    const facts = await this.#load();
    const bases: Record<string, string> = {};
    for (let cpu = 0; cpu < facts.cpuIds; cpu += 1) bases[String(cpu)] = toHex(await this.base(cpu));
    return {
      cpuIds: facts.cpuIds,
      sectionStart: toHex(facts.sectionStart),
      sectionEnd: toHex(facts.sectionEnd),
      sectionBytes: (facts.sectionEnd - facts.sectionStart).toString(),
      offsetTable: toHex(facts.offsetTable),
      bases,
    };
  }
}
