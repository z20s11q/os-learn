/** split ring 字节解码：布局取自设备快照，字节由本次 capture 的 PhysicalReader 提供。
 * packed ring、非法环布局及描述符链校验失败时返回明确原因；索引按 16 位回绕做差。
 */

import type { EvidenceRef } from '../contracts/common.ts';
import { toHex } from '../contracts/common.ts';
import type { VirtqueueDescriptor, VirtqueueSnapshot } from '../contracts/device.ts';
import type { PhysicalReader } from './paging.ts';
import { PhysicalReadError } from './paging.ts';

/** 描述符 16 字节：addr(8) len(4) flags(2) next(2)。 */
export const DESCRIPTOR_SIZE = 16;

const VIRTQ_DESC_F_NEXT = 1n;
const VIRTQ_DESC_F_WRITE = 2n;
const VIRTQ_DESC_F_INDIRECT = 4n;

/** 协商 feature 位（只列这里要判断的）。 */
const VIRTIO_F_EVENT_IDX = 1n << 29n;
const VIRTIO_F_VERSION_1 = 1n << 32n;
const VIRTIO_F_RING_PACKED = 1n << 34n;

export interface VirtioFeatureReport {
  /** 协商了 VIRTIO_F_VERSION_1（现代设备） */
  version1: boolean;
  /** 协商了 VIRTIO_F_RING_PACKED，解码器拒绝按 split 布局解析 */
  ringPacked: boolean;
  /** 协商了 VIRTIO_F_EVENT_IDX：环末尾有 used_event / avail_event 字段 */
  eventIdx: boolean;
}

export function reportVirtioFeatures(negotiated: bigint | null | undefined): VirtioFeatureReport {
  const features = negotiated ?? 0n;
  return {
    version1: (features & VIRTIO_F_VERSION_1) !== 0n,
    ringPacked: (features & VIRTIO_F_RING_PACKED) !== 0n,
    eventIdx: (features & VIRTIO_F_EVENT_IDX) !== 0n,
  };
}

export interface VirtqueueLayout {
  queueIndex: number;
  /** 协商的队列项数；有效值为 2 的幂，size=0 表示队列准备阶段 */
  size: number;
  descTable: bigint;
  availRing: bigint;
  usedRing: bigint;
  /** 设备侧已消费到的可用环索引（device 的 last_avail_idx） */
  lastAvailIndex: number | null;
  /** 客体侧已消费到的已用环索引 */
  lastUsedIndex: number | null;
  negotiatedFeatures?: bigint | null;
}

/**
 * 解析出来的描述符。相对契约的 `VirtqueueDescriptor` 多两个来源字段：
 * 表内下标与主表下标会撞号，所以间接表展开出来的项要标出它来自哪张表。
 */
export type DecodedDescriptor = VirtqueueDescriptor & {
  viaIndirect?: boolean;
  tableAddress?: string;
};

export interface DescriptorChain {
  head: number;
  descriptors: DecodedDescriptor[];
  /** 描述符链里的索引，便于按 head 找环 */
  indices: number[];
  /** 设备会读走的字节数（guest → device） */
  readableBytes: number;
  /** 设备会写回的字节数（device → guest） */
  writableBytes: number;
  /** 该链是通过间接描述符表展开的 */
  indirect: boolean;
}

export interface VirtqueueDecodeResult {
  queueIndex: number;
  size: number;
  /** 队列是否已就绪（三个地址齐全且 size > 0） */
  ready: boolean;
  layout: {
    descTable: string;
    availRing: string;
    usedRing: string;
    lastAvailIndex: number | null;
    lastUsedIndex: number | null;
    negotiatedFeatures: string;
    features: VirtioFeatureReport;
  };
  descriptors: VirtqueueDescriptor[];
  /** 等待设备消费的链，head 按可用环顺序排列 */
  chains: DescriptorChain[];
  avail: { flags: number; idx: number; heads: number[]; usedEvent: number | null } | null;
  used: { flags: number; idx: number; entries: Array<{ id: number; len: number }>; availEvent: number | null } | null;
  /** avail.idx - lastAvailIndex：等待设备取走的可用项数 */
  outstanding: number;
  /** used.idx - used_idx：等待客体消费的完成项数；缺客体消费索引时为 null */
  pendingCompletions?: number | null;
  /** 本次解析失败或覆盖缺口的原因 */
  unavailable: string[];
  evidence: EvidenceRef;
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function u64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

/** 16 位回绕索引之差，按 0xffff 掩码归一化。 */
export function ringDistance(from: number, to: number): number {
  return (to - from) & 0xffff;
}

async function readOrNull(
  reader: PhysicalReader,
  address: bigint,
  length: number,
): Promise<Uint8Array | null> {
  try {
    return await reader.read(address, length);
  } catch (error) {
    if (error instanceof PhysicalReadError) return null;
    throw error;
  }
}

/**
 * 解析一个描述符条目。`tableBase` 是描述符表基址，`index` 是表内下标。
 */
async function readDescriptor(
  reader: PhysicalReader,
  tableBase: bigint,
  index: number,
  failure: { unreadable: number[] },
): Promise<VirtqueueDescriptor | null> {
  const address = tableBase + BigInt(index * DESCRIPTOR_SIZE);
  const bytes = await readOrNull(reader, address, DESCRIPTOR_SIZE);
  if (bytes === null) {
    failure.unreadable.push(index);
    return null;
  }
  const rawAddress = u64(bytes, 0);
  const length = u32(bytes, 8);
  const flags = u16(bytes, 12);
  const next = u16(bytes, 14);
  const hasNext = (BigInt(flags) & VIRTQ_DESC_F_NEXT) !== 0n;
  return {
    index,
    address: toHex(rawAddress),
    length,
    flags,
    direction: (BigInt(flags) & VIRTQ_DESC_F_WRITE) !== 0n ? 'device-write' : 'device-read',
    next: hasNext ? next : null,
    bytesRef: null,
  };
}

/** 从 head 展开描述符链；成环、next 越界或嵌套间接表时记录原因并返回 null。 */
async function walkChain(
  reader: PhysicalReader,
  layout: VirtqueueLayout,
  head: number,
  problems: string[],
): Promise<DescriptorChain | null> {
  if (head >= layout.size) {
    problems.push(`可用环指的 head=${head} 超出队列大小 ${layout.size}`);
    return null;
  }
  const visited = new Set<number>();
  const descriptors: VirtqueueDescriptor[] = [];
  const indices: number[] = [];
  let cursor: number | null = head;
  let indirect = false;

  while (cursor !== null) {
    if (visited.has(cursor)) {
      problems.push(`描述符链 head=${head} 在第 ${cursor} 项上成环，已停止展开`);
      return null;
    }
    if (cursor >= layout.size) {
      problems.push(`描述符链 head=${head} 的 next=${cursor} 超出队列大小 ${layout.size}`);
      return null;
    }
    visited.add(cursor);
    const descriptor = await readDescriptor(reader, layout.descTable, cursor, { unreadable: [] });
    if (descriptor === null) {
      problems.push(`描述符表 ${toHex(layout.descTable)} 第 ${cursor} 项读不到（本轮未采到该页）`);
      return null;
    }
    indices.push(cursor);

    if ((BigInt(descriptor.flags) & VIRTQ_DESC_F_INDIRECT) !== 0n) {
      if (indirect) {
        problems.push(`head=${head} 的间接描述符又指向间接表：规范不允许嵌套，已拒绝`);
        return null;
      }
      if (descriptor.length % DESCRIPTOR_SIZE !== 0) {
        problems.push(`head=${head} 的间接表长度 ${descriptor.length} 不是 ${DESCRIPTOR_SIZE} 的整数倍`);
        return null;
      }
      const count = descriptor.length / DESCRIPTOR_SIZE;
      if (count === 0 || count > layout.size) {
        problems.push(`head=${head} 的间接表项数 ${count} 与队列大小 ${layout.size} 不符`);
        return null;
      }
      indirect = true;
      const table = BigInt(descriptor.address);
      const expanded: DecodedDescriptor[] = [];
      for (let index = 0; index < count; index += 1) {
        const inner = await readDescriptor(reader, table, index, { unreadable: [] });
        if (inner === null) {
          problems.push(`间接描述符表 ${toHex(table)} 第 ${index} 项读不到`);
          return null;
        }
        if ((BigInt(inner.flags) & VIRTQ_DESC_F_INDIRECT) !== 0n) {
          problems.push(
            `head=${head} 的间接表 ${toHex(table)} 第 ${index} 项又声明 INDIRECT：规范不允许嵌套间接表，已拒绝`,
          );
          return null;
        }
        // 表内下标与主表下标会撞号，所以用 tableAddress 说明这一项来自哪张表。
        expanded.push({ ...inner, index, viaIndirect: true, tableAddress: toHex(table) });
      }
      descriptors.push(...expanded);
      // 间接描述符占主表一项，展开后结束主链遍历。
      cursor = null;
      continue;
    }

    descriptors.push(descriptor);
    cursor = descriptor.next;
  }

  const readableBytes = descriptors
    .filter((item) => item.direction === 'device-read')
    .reduce((sum, item) => sum + item.length, 0);
  const writableBytes = descriptors
    .filter((item) => item.direction === 'device-write')
    .reduce((sum, item) => sum + item.length, 0);
  return { head, descriptors, indices, readableBytes, writableBytes, indirect };
}

/**
 * 解码一个已就绪的 split virtqueue。
 *
 * `availRing` 布局：flags(2) idx(2) ring[size](2×size) [used_event(2)]
 * `usedRing` 布局：flags(2) idx(2) ring[size](4+4) [avail_event(2)]
 * 末尾的事件字段只在协商了 VIRTIO_F_EVENT_IDX 时才存在，因此这里按协商结果读。
 */
export async function decodeVirtqueue(
  reader: PhysicalReader,
  layout: VirtqueueLayout,
  attribution: { captureId: string; refs?: string[] },
): Promise<VirtqueueDecodeResult> {
  const features = reportVirtioFeatures(layout.negotiatedFeatures);
  const unavailable: string[] = [];
  const evidence: EvidenceRef = {
    kind: 'decoded',
    source: 'observer',
    captureId: attribution.captureId,
    refs: [
      `virtqueue:${layout.queueIndex}`,
      `physical:${toHex(layout.descTable)}:${DESCRIPTOR_SIZE * Math.max(layout.size, 1)}`,
      `physical:${toHex(layout.availRing)}:${layout.size * 2 + 6}`,
      `physical:${toHex(layout.usedRing)}:${layout.size * 8 + 6}`,
      ...(attribution.refs ?? []),
    ],
  };
  const result: VirtqueueDecodeResult = {
    queueIndex: layout.queueIndex,
    size: layout.size,
    ready: false,
    layout: {
      descTable: toHex(layout.descTable),
      availRing: toHex(layout.availRing),
      usedRing: toHex(layout.usedRing),
      lastAvailIndex: layout.lastAvailIndex,
      lastUsedIndex: layout.lastUsedIndex,
      negotiatedFeatures: toHex(layout.negotiatedFeatures ?? 0n),
      features,
    },
    descriptors: [],
    chains: [],
    avail: null,
    used: null,
    outstanding: 0,
    unavailable,
    evidence,
  };

  if (features.ringPacked) {
    unavailable.push(
      '队列协商了 VIRTIO_F_RING_PACKED（bit 34）：这是 packed ring 布局，split 环的三个地址与索引都不适用，'
      + '本次不做近似解析',
    );
    return result;
  }
  if (layout.size === 0) {
    unavailable.push('队列大小 size=0：设备还没就绪（vring-num=0），没有环可读');
    return result;
  }
  if (layout.descTable === 0n || layout.availRing === 0n || layout.usedRing === 0n) {
    unavailable.push(
      `环地址不完整（desc=${toHex(layout.descTable)} avail=${toHex(layout.availRing)} used=${toHex(layout.usedRing)}）：`
      + '设备还没把 vring 三个地址都设好，不按 0 地址去读',
    );
    return result;
  }
  if ((layout.size & (layout.size - 1)) !== 0) {
    unavailable.push(`队列大小 ${layout.size} 不是 2 的幂：协商结果本身可疑，不做解析`);
    return result;
  }

  const availBytes = await readOrNull(reader, layout.availRing, layout.size * 2 + 6);
  const usedBytes = await readOrNull(reader, layout.usedRing, layout.size * 8 + 6);
  if (availBytes === null) unavailable.push(`可用环 ${toHex(layout.availRing)} 读不到（本轮未采到该页）`);
  if (usedBytes === null) unavailable.push(`已用环 ${toHex(layout.usedRing)} 读不到（本轮未采到该页）`);
  if (availBytes !== null) {
    const flags = u16(availBytes, 0);
    const idx = u16(availBytes, 2);
    const heads: number[] = [];
    for (let index = 0; index < layout.size; index += 1) {
      heads.push(u16(availBytes, 4 + index * 2));
    }
    const usedEvent = features.eventIdx ? u16(availBytes, 4 + layout.size * 2) : null;
    result.avail = { flags, idx, heads, usedEvent };
    result.ready = true;
  }
  if (usedBytes !== null) {
    const flags = u16(usedBytes, 0);
    const idx = u16(usedBytes, 2);
    const entries: Array<{ id: number; len: number }> = [];
    for (let index = 0; index < layout.size; index += 1) {
      const id = u32(usedBytes, 4 + index * 8);
      const len = u32(usedBytes, 4 + index * 8 + 4);
      entries.push({ id, len });
    }
    const availEvent = features.eventIdx ? u16(usedBytes, 4 + layout.size * 8) : null;
    result.used = { flags, idx, entries, availEvent };
  }

  // 等待设备消费的可用项：last_avail_idx 到 avail.idx，按 16 位回绕计算。
  const problems: string[] = [];
  if (result.avail !== null && layout.lastAvailIndex !== null) {
    const outstanding = ringDistance(layout.lastAvailIndex, result.avail.idx);
    result.outstanding = outstanding;
    if (outstanding > layout.size) {
      problems.push(
        `avail.idx=${result.avail.idx} 与 last_avail_idx=${layout.lastAvailIndex} 相差 ${outstanding}，`
        + `超过队列大小 ${layout.size}：这两个数不同源，本次不展开链`,
      );
    } else {
      for (let step = 0; step < outstanding; step += 1) {
        const ringIndex = (layout.lastAvailIndex + step) % layout.size;
        const head = result.avail.heads[ringIndex];
        const chain = await walkChain(reader, layout, head, problems);
        if (chain !== null) {
          result.chains.push(chain);
          result.descriptors.push(...chain.descriptors);
        }
      }
    }
  } else if (result.avail !== null && layout.lastAvailIndex === null) {
    problems.push('设备快照没有给出 last_avail_idx：无法判断哪些可用项还没被取走，本次不展开链');
  }

  // 等待客体消费的完成项数，按 16 位回绕计算。
  if (result.used !== null && layout.lastUsedIndex !== null) {
    result.pendingCompletions = ringDistance(layout.lastUsedIndex, result.used.idx);
    if (result.pendingCompletions > layout.size) {
      problems.push(
        `used.idx=${result.used.idx} 与 used_idx=${layout.lastUsedIndex} 相差 ${result.pendingCompletions}，`
        + `超过队列大小 ${layout.size}：这两个数不同源，完成项计数不可信`,
      );
      result.pendingCompletions = null;
    }
  } else if (result.used !== null) {
    problems.push('设备快照没有给出 used_idx：无法判断客体还有多少完成项没消费');
  }

  unavailable.push(...problems);
  return result;
}

/** 从设备快照构造 layout；地址缺失时返回 null。 */
export function layoutFromSnapshot(
  snapshot: VirtqueueSnapshot & { descTable?: string | null; availRing?: string | null; usedRing?: string | null },
  negotiatedFeatures: bigint | null,
): VirtqueueLayout {
  return {
    queueIndex: snapshot.queueIndex,
    size: snapshot.size ?? 0,
    descTable: snapshot.descTable ? BigInt(snapshot.descTable) : 0n,
    availRing: snapshot.availRing ? BigInt(snapshot.availRing) : 0n,
    usedRing: snapshot.usedRing ? BigInt(snapshot.usedRing) : 0n,
    lastAvailIndex: snapshot.lastAvailIndex ?? null,
    lastUsedIndex: snapshot.lastUsedIndex ?? null,
    negotiatedFeatures,
  };
}

/** 从 block.submit 的 descHead 直接展开描述符链，用于 pending 请求载荷诊断。
 * virtqueue_pop 推进 last_avail_idx 后，请求仍可等待状态字节回写；直接按 head 读取。
 * 成环、越界及嵌套间接表均返回校验失败。
 */
export async function decodeChainAt(
  reader: PhysicalReader,
  layout: VirtqueueLayout,
  head: number,
): Promise<{ chain: DescriptorChain | null; problems: string[] }> {
  const problems: string[] = [];
  if (layout.descTable === 0n) {
    return { chain: null, problems: ['描述符表地址为 0：队列未就绪，无法按 head 走链'] };
  }
  if (layout.size === 0) {
    return { chain: null, problems: ['队列大小 size=0：没有描述符表可走'] };
  }
  const chain = await walkChain(reader, layout, head, problems);
  return { chain, problems };
}
