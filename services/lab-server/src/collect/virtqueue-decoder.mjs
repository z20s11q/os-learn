/**
 * virtqueue-decoder：把纯字节的 split 环解码器接到设备快照上（T06 第 3 条）。
 *
 * 数据来源分为设备快照和绑定采集的物理字节读取：
 * - **队列结构与索引**（三个环的物理地址、size、last_avail_idx、used_idx、协商
 *   feature）来自 T05d 的设备快照。这些值是 QEMU 自己从 `VirtQueue` 结构体里读
 *   出来的，服务端不重新推算。
 * - **环与描述符的内容**必须由本模块用**绑定 captureId** 的读取器去客体内存里
 *   读。快照里的地址只是地址，字节不在里面。
 *
 * 「不支持的 feature 明确拒绝」落在两处：
 * - 协商了 `VIRTIO_F_RING_PACKED`（bit 34）→ split 布局不适用，直接拒绝，
 *   不拿 split 去套 packed 环；
 * - 队列未就绪（size=0 / 三地址不全 / size 非 2 的幂）→ 报原因，不按 0 地址读。
 *
 * 描述符指向的缓冲首字节（`bytesRef`）只读一小段前缀并算散列：契约要的是
 * 「这块缓冲的首字节已经采到了」这个事实，不是把整段载荷复制一遍。
 * 这一项有配额（默认每队列 32 个），超出就留 null 并写明原因——
 * 一个 256 项的队列全读前缀会把一次采集拖成几千次物理读。
 */

import {
  DESCRIPTOR_SIZE,
  decodeChainAt,
  decodeVirtqueue,
  layoutFromSnapshot,
  reportVirtioFeatures,
} from '../../../../packages/trace-format/virtqueue.ts';
import { sha256Hex } from '../../../../packages/trace-format/hash.ts';
import { PhysicalReadError } from '../../../../packages/trace-format/paging.ts';

export const DEFAULT_PREFIX_BYTES = 16;
export const DEFAULT_PREFIX_QUOTA = 32;

function hexOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  return String(value);
}

/** 设备快照里的队列条目 → 契约的 VirtqueueSnapshot 骨架（仅含队列结构字段）。 */
export function queueSkeleton(device, queue, captureId = null) {
  const negotiated = queue.negotiatedFeatures ? BigInt(queue.negotiatedFeatures) : null;
  return {
    queueIndex: queue.queueIndex ?? 0,
    size: queue.size ?? 0,
    ready: queue.ready === true,
    negotiatedFeatures: hexOrNull(negotiated) ?? '0x0',
    descTable: hexOrNull(queue.descTable),
    availRing: hexOrNull(queue.availRing),
    usedRing: hexOrNull(queue.usedRing),
    lastAvailIndex: queue.lastAvailIndex ?? null,
    lastUsedIndex: queue.lastUsedIndex ?? null,
    evidence: {
      kind: 'observed',
      source: 'observer',
      captureId,
      refs: [
        `x-oslab-capture:devices.${device.deviceId}.virtqueues[${queue.queueIndex ?? 0}]`,
        '设备快照只给结构与索引；环与描述符字节由本模块用 x-oslab-read-physical 独立采集',
      ],
    },
    ...reportVirtioFeatures(negotiated),
  };
}

/**
 * 只读描述符指向的缓冲首字节前缀并算内容散列。
 * 读取失败时返回 null 和原因（不把「没采到」说成「内容为空」）。
 */
export async function readDescriptorPrefix(reader, descriptor, prefixBytes = DEFAULT_PREFIX_BYTES) {
  if (descriptor.length === 0) return { bytesRef: null, reason: '描述符长度为 0，没有首字节可采' };
  if (descriptor.address === '0x0') return { bytesRef: null, reason: '描述符缓冲地址为 0，不按 0 地址读' };
  const length = Math.min(descriptor.length, prefixBytes);
  try {
    const bytes = Buffer.from(await reader.read(BigInt(descriptor.address), length));
    return { bytesRef: sha256Hex(bytes), reason: null, length: bytes.length };
  } catch (error) {
    return {
      bytesRef: null,
      reason: error instanceof PhysicalReadError
        ? `缓冲首字节未采到（${error.code}）：${error.message}`
        : `缓冲首字节未采到：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解码一个设备的全部队列。
 *
 * @returns `{ deviceId, kind, queues, unavailable, evidence }`，
 * 其中 `queues[i]` 是契约 `VirtqueueSnapshot` 加上解码详情。
 */
export async function decodeDeviceVirtqueues({
  reader,
  device,
  captureId,
  prefixBytes = DEFAULT_PREFIX_BYTES,
  prefixQuota = DEFAULT_PREFIX_QUOTA,
  queueIndexes = null,
} = {}) {
  const unavailable = [];
  const rawQueues = Array.isArray(device?.virtqueues) ? device.virtqueues : [];
  if (rawQueues.length === 0 && device?.kind?.startsWith('virtio')) {
    unavailable.push(
      `${device.deviceId} 是 virtio 设备但快照里没有 virtqueues 字段：`
      + '队列状态来自 qmp:x-query-virtio-queue-status，vhost 后端启动或 QOM 路径解析失败时会缺',
    );
  }
  const queues = [];
  let prefixBudget = prefixQuota;

  for (const queue of rawQueues) {
    const queueIndex = queue.queueIndex ?? 0;
    if (queueIndexes !== null && !queueIndexes.includes(queueIndex)) continue;
    const skeleton = queueSkeleton(device, queue, captureId);
    const negotiated = skeleton.negotiatedFeatures === null ? null : BigInt(skeleton.negotiatedFeatures);
    const layout = layoutFromSnapshot(
      {
        queueIndex,
        size: queue.size ?? 0,
        ready: queue.ready === true,
        negotiatedFeatures: skeleton.negotiatedFeatures,
        descTable: skeleton.descTable,
        availRing: skeleton.availRing,
        usedRing: skeleton.usedRing,
        lastAvailIndex: skeleton.lastAvailIndex,
        lastUsedIndex: skeleton.lastUsedIndex,
        evidence: skeleton.evidence,
      },
      negotiated,
    );
    const decoded = await decodeVirtqueue(reader, layout, {
      captureId,
      refs: [`device:${device.deviceId}`, `queue:${queueIndex}`],
    });

    const descriptors = [];
    const reasons = [];
    for (const descriptor of decoded.descriptors) {
      if (prefixBudget <= 0) {
        descriptors.push({ ...descriptor, bytesRef: null });
        continue;
      }
      const prefix = await readDescriptorPrefix(reader, descriptor, prefixBytes);
      prefixBudget -= 1;
      if (prefix.reason !== null) reasons.push(`描述符 #${descriptor.index}: ${prefix.reason}`);
      descriptors.push({ ...descriptor, bytesRef: prefix.bytesRef });
    }
    if (prefixBudget <= 0 && decoded.descriptors.length > prefixQuota) {
      reasons.push(
        `缓冲首字节采集有配额（每设备 ${prefixQuota} 个），剩下的描述符只给结构与地址，`
        + 'bytesRef 为 null 表示「本次没采」而不是「内容为空」',
      );
    }

    queues.push({
      ...skeleton,
      size: decoded.size,
      ready: decoded.ready,
      descriptors: descriptors.length > 0 ? descriptors : undefined,
      evidence: {
        ...decoded.evidence,
        refs: [...(decoded.evidence?.refs ?? []), `descriptor-size:${DESCRIPTOR_SIZE}`],
      },
      decode: {
        chains: decoded.chains.map((chain) => ({
          head: chain.head,
          indices: chain.indices,
          indirect: chain.indirect,
          readableBytes: chain.readableBytes,
          writableBytes: chain.writableBytes,
          descriptors: chain.descriptors.map((item) => ({
            index: item.index,
            address: item.address,
            length: item.length,
            direction: item.direction,
            viaIndirect: item.viaIndirect === true,
            tableAddress: item.tableAddress ?? null,
          })),
        })),
        outstanding: decoded.outstanding,
        pendingCompletions: decoded.pendingCompletions ?? null,
        availIdx: decoded.avail?.idx ?? null,
        usedIdx: decoded.used?.idx ?? null,
        features: decoded.layout.features,
      },
    });
    for (const problem of decoded.unavailable) unavailable.push(`队列 ${queueIndex}: ${problem}`);
    for (const reason of reasons) unavailable.push(`队列 ${queueIndex}: ${reason}`);
  }

  return {
    deviceId: device?.deviceId ?? 'unknown-device',
    kind: device?.kind ?? 'other',
    queues,
    unavailable,
  };
}

/**
 * 按 head 直接走一条描述符链（直接以 head 为入口）。
 *
 * 用途是块请求的载荷诊断：设备弹出描述符后 last_avail_idx 立刻前进，那条链
 * 就从「设备还没取走的可用项」里消失了，但请求可能还挂着（例如宿主块层已完成、
 * 状态字节还没回写客体，或卷入了停机屏障的 drain）。这时只能拿 `block.submit`
 * 事件里的 descHead 直接走链，才能把「待完成写入的载荷」独立保存下来。
 */
export async function decodeChainHead({ reader, device, queueIndex, head, captureId }) {
  const raw = (device?.virtqueues ?? []).find((queue) => (queue.queueIndex ?? 0) === queueIndex);
  if (raw === undefined) {
    return {
      chain: null,
      problems: [`设备 ${device?.deviceId ?? 'unknown'} 的快照里没有队列 ${queueIndex}`],
    };
  }
  const skeleton = queueSkeleton(device, raw, captureId);
  const layout = layoutFromSnapshot(
    {
      queueIndex,
      size: raw.size ?? 0,
      ready: raw.ready === true,
      negotiatedFeatures: skeleton.negotiatedFeatures,
      descTable: skeleton.descTable,
      availRing: skeleton.availRing,
      usedRing: skeleton.usedRing,
      lastAvailIndex: skeleton.lastAvailIndex,
      lastUsedIndex: skeleton.lastUsedIndex,
      evidence: skeleton.evidence,
    },
    skeleton.negotiatedFeatures === null ? null : BigInt(skeleton.negotiatedFeatures),
  );
  const { chain, problems } = await decodeChainAt(reader, layout, head);
  return { chain, problems, layout };
}

/**
 * 把解码结果合回设备快照（契约 `DeviceSnapshot.virtqueues`）：
 * 同 queueIndex 的队列用解码后的版本替换（带描述符与 bytesRef），
 * 其余的照原样保留。
 */
export function mergeQueuesIntoSnapshot(device, decodedQueues) {
  if (!Array.isArray(decodedQueues) || decodedQueues.length === 0) return device;
  const byIndex = new Map(decodedQueues.map((queue) => [queue.queueIndex, queue]));
  const raw = Array.isArray(device.virtqueues) ? device.virtqueues : [];
  const merged = raw.map((queue) => {
    const replacement = byIndex.get(queue.queueIndex ?? 0);
    if (replacement === undefined) return queue;
    byIndex.delete(queue.queueIndex ?? 0);
    const { decode, ...contractQueue } = replacement;
    return contractQueue;
  });
  for (const leftover of byIndex.values()) {
    const { decode, ...contractQueue } = leftover;
    merged.push(contractQueue);
  }
  return { ...device, virtqueues: merged };
}
