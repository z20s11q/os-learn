/** 文件与设备 I/O 关联：逐环节保留结构地址、区间、请求身份和生命周期。
 * 队列驱动入口双路径核对，bio 经页缓存关联文件；合并、拆分、预读和歧义分别返回。
 */

import { memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';
import { readStruct } from '../objects/task.ts';
import type { StructBuffer } from '../objects/task.ts';
import { pfnForPageAddress, readAddressSpace, readPageCache } from '../objects/files.ts';
import type { FileChain } from '../objects/files.ts';
import { PAGE_SHIFT, resolveVmemmapBase } from '../objects/page-table.ts';
import type { VmemmapFacts } from '../objects/page-table.ts';
import { readFolioForPfn } from '../objects/mm.ts';
import type { KernelFolio } from '../objects/mm.ts';
import { GENDISK_TYPE, readGendisk } from './gendisk.ts';
import {
  IoParseError,
  readBio,
  readHwCtx,
  readMqTags,
  readRequest,
  readRequestQueue,
  requestIdentity,
  walkBioChain,
  type KernelBio,
  type KernelBioVec,
  type KernelHwCtx,
  type KernelMqTags,
  type KernelRequest,
  type KernelRequestQueue,
  type RequestIdentity,
} from './objects.ts';
import {
  VIRTIO_BLK_TYPE,
  VIRTIO_BLK_VQ_TYPE,
  addressSpaceOfDescriptors,
  lookupToken,
  readDescriptorOwners,
  readVirtblkReq,
  readVirtqueue,
  walkDescriptorChain,
  type DescriptorOwnerTable,
  type KernelDescriptorChain,
  type KernelVirtblkReq,
  type KernelVirtqueue,
  type TokenLookup,
} from './virtio.ts';

export const VIRTIO_DEVICE_TYPE = 'virtio_device';

/* --------------------------------------------------------------------------
 * virtio_blk 驱动状态
 * ------------------------------------------------------------------------ */

export interface KernelVirtioBlk {
  /** `struct virtio_blk *`（就是 `request_queue.queuedata`） */
  address: bigint;
  vdev: bigint | null;
  /** `disk`：这块盘。用来与 `rq->q->disk` 对账 */
  disk: bigint | null;
  index: number;
  numVqs: number;
  /** `io_queues[3]`：read/write/other 三类各占一个硬件队列号 */
  ioQueues: number[];
  /** `&vblk->vqs[0]` */
  vqsAddress: bigint;
  zoneSectors: number;
  notes: string[];
  evidence: EvidenceRef;
}

/** 读 `struct virtio_blk`。 */
export async function readVirtioBlk(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelVirtioBlk> {
  if (address === 0n) {
    throw new IoParseError('null-virtio-blk', 'struct virtio_blk 地址为 0：这个队列不是 virtio-blk 的', {});
  }
  const struct = await readStruct(view, layout, VIRTIO_BLK_TYPE, address);
  const notes: string[] = [];
  const numVqs = struct.has('num_vqs') ? Number(struct.value('num_vqs', true)) : 0;
  if (numVqs <= 0 || numVqs > 4096) {
    notes.push(`num_vqs = ${numVqs} 不像一个正常的队列数：这块内存可能不是 virtio_blk`);
  }
  return {
    address,
    vdev: struct.has('vdev') ? struct.pointer('vdev') : null,
    disk: struct.has('disk') ? struct.pointer('disk') : null,
    index: struct.has('index') ? Number(struct.value('index', true)) : -1,
    numVqs,
    ioQueues: readIntArray(struct, 'io_queues', 3),
    vqsAddress: struct.addressOf('vqs'),
    zoneSectors: struct.has('zone_sectors') ? struct.u32('zone_sectors') : 0,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${VIRTIO_BLK_TYPE}`,
      `num_vqs:${numVqs}`,
      `disk:${struct.has('disk') && struct.pointer('disk') !== null ? toHex(struct.pointer('disk') as bigint) : 'null'}`,
    ]),
  };
}

/** 读一个 `int[N]` 数组字段（`readField` 对宽度 > 8 的字段会拒绝，所以单列一条路径）。 */
function readIntArray(struct: StructBuffer, path: string, count: number): number[] {
  if (!struct.has(path)) return [];
  const field = struct.field(path);
  const out: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = field.byteOffset + index * 4;
    const bytes = struct.bytes.subarray(base, base + 4);
    if (bytes.length < 4) break;
    out.push((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)));
  }
  return out;
}

/** `virtio_blk.vqs[queueNum].vq`：第 `queueNum` 个硬件队列的 virtqueue 指针。 */
export async function virtqueueAddressForQueue(
  view: KernelMemoryView,
  layout: KernelLayout,
  vblk: KernelVirtioBlk,
  queueNum: number,
): Promise<bigint | null> {
  if (queueNum < 0 || queueNum >= vblk.numVqs) return null;
  const struct = await readStruct(view, layout, VIRTIO_BLK_TYPE, vblk.address);
  const vqType = layout.type(VIRTIO_BLK_VQ_TYPE);
  const stride = vqType.byteSize ?? 64;
  const vqs = struct.pointer('vqs');
  if (vqs === null) return null;
  const slot = vqs + BigInt(queueNum * stride);
  const raw = await view.bytes(slot, 8);
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(raw[index]);
  return value === 0n ? null : value;
}

/* --------------------------------------------------------------------------
 * 从请求出发的整条设备侧链
 * ------------------------------------------------------------------------ */

/** 请求在 blk-mq 与 virtio 环上的生命周期阶段。 */
export type RequestLifecycle =
  /** MQ_RQ_IN_FLIGHT 的请求处于驱动提交准备阶段 */
  | 'not-submitted'
  /** token 在环中，等待设备完成 */
  | 'in-flight-on-device'
  /** 设备完成，描述符等待驱动回收 */
  | 'completed-on-device'
  /** 描述符已回收，请求槽回到空闲阶段 */
  | 'recycled'
  /** 判断不了：缺少环或状态表 */
  | 'unknown';

export interface IoRequestTrace {
  request: KernelRequest;
  identity: RequestIdentity;
  queue: KernelRequestQueue | null;
  hwCtx: KernelHwCtx | null;
  /** 队列私有的驱动状态（virtio-blk） */
  driverState: KernelVirtioBlk | null;
  /** `gendisk`（如果读了） */
  disk: bigint | null;
  vq: KernelVirtqueue | null;
  /** 请求私有区（设备看到的头就在这里） */
  pdu: KernelVirtblkReq | null;
  /** 描述符头 → token 的状态表 */
  owners: DescriptorOwnerTable | null;
  /** 在环上找这个请求的私有区地址 */
  tokenLookup: TokenLookup | null;
  /** 这条请求的描述符链 */
  descriptorChain: KernelDescriptorChain | null;
  /** 一块盘上的标签表（tag → 请求），用于验证"这个 tag 现在真的属于这个请求" */
  tags: KernelMqTags | null;
  /** 请求里所有 bio（`rq->bio` 链） */
  bioChain: Awaited<ReturnType<typeof walkBioChain>>;
  lifecycle: RequestLifecycle;
  /** 关联是否唯一 */
  unique: boolean;
  /** 缺失或多候选关联的原因 */
  ambiguities: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 从请求读取设备侧链，子环节失败写入 ambiguities/notes，请求读取失败向调用方抛出。 */
export async function traceRequest(
  view: KernelMemoryView,
  layout: KernelLayout,
  requestOrAddress: KernelRequest | bigint,
  options: { readTags?: boolean; readBios?: boolean; maxVectors?: number } = {},
): Promise<IoRequestTrace> {
  const request = typeof requestOrAddress === 'bigint'
    ? await readRequest(view, layout, requestOrAddress)
    : requestOrAddress;
  const notes: string[] = [...request.notes, ...request.violations.map((line) => `request：${line}`)];
  const ambiguities: string[] = [];

  // 一、队列与硬件上下文。`rq->q` 与 `rq->mq_hctx` 都要读：前者是队列本身，
  // 后者带 `queue_num`（virtio-blk 拿它选 vqs 里第几个队列）。
  let queue: KernelRequestQueue | null = null;
  let hwCtx: KernelHwCtx | null = null;
  if (request.queue !== null) {
    try {
      queue = await readRequestQueue(view, layout, request.queue);
      notes.push(...queue.notes);
    } catch (error) {
      ambiguities.push(`读 request_queue ${toHex(request.queue)} 失败：${describe(error)}`);
    }
  } else {
    ambiguities.push('request->q 为空：这个请求不属于任何队列，拿不到设备侧的信息');
  }
  if (request.mqHctx !== null) {
    try {
      hwCtx = await readHwCtx(view, layout, request.mqHctx);
      notes.push(...hwCtx.notes);
      if (queue !== null && hwCtx.queue !== null && hwCtx.queue !== queue.address) {
        ambiguities.push(
          `rq->mq_hctx->queue 是 ${toHex(hwCtx.queue)}，而 rq->q 是 ${toHex(queue.address)}：`
          + '两处给出的队列不是同一个，无法确定这个请求在哪条队列上',
        );
      }
    } catch (error) {
      ambiguities.push(`读 blk_mq_hw_ctx ${toHex(request.mqHctx)} 失败：${describe(error)}`);
    }
  } else {
    notes.push('request->mq_hctx 为空：这是单队列（非 mq）路径，或者请求还没被派到硬件上下文上');
  }

  // 队列与磁盘两条入口分别读取后核对。
  // `queue->queuedata` 是 virtio-blk 实际用的那一条（`get_virtio_blk_vq()` 里明写），
  // `disk->private_data` 是"按常理应该是"的那一条。两条给出同一个对象才算确认。
  let driverState: KernelVirtioBlk | null = null;
  let disk: bigint | null = queue?.disk ?? null;
  if (queue !== null && queue.queuedata !== null) {
    try {
      driverState = await readVirtioBlk(view, layout, queue.queuedata);
      notes.push(...driverState.notes.map((line) => `virtio_blk：${line}`));
    } catch (error) {
      ambiguities.push(`读 queue->queuedata（${toHex(queue.queuedata)}）失败：${describe(error)}`);
    }
  } else if (queue !== null) {
    ambiguities.push('request_queue.queuedata 为空：找不到驱动私有状态，无法从队列顺到 virtqueue');
  }

  if (disk !== null && driverState !== null && driverState.disk !== null && driverState.disk !== disk) {
    ambiguities.push(
      `queue->queuedata 指向的 virtio_blk 的 disk 是 ${toHex(driverState.disk)}，`
      + `而 rq->q->disk 是 ${toHex(disk)}：驱动状态与队列不是一套的`,
    );
  }
  if (disk !== null) {
    try {
      const gendisk = await readGendisk(view, layout, disk);
      notes.push(...gendisk.notes.map((line) => `gendisk：${line}`));
      if (gendisk.privateData !== null && driverState !== null && gendisk.privateData !== driverState.address) {
        notes.push(
          `gendisk.private_data = ${toHex(gendisk.privateData)} 与 queue->queuedata 给出的 `
          + `${toHex(driverState.address)} 不是同一个对象：本内核 virtio-blk 用 queuedata（`
          + '`get_virtio_blk_vq()`），private_data 这一条在这里只是旁证',
        );
      }
    } catch (error) {
      notes.push(`读 gendisk ${toHex(disk)} 失败：${describe(error)}`);
    }
  }

  // 三、virtqueue。`queue_num` 从硬件上下文来（`vqs[hctx->queue_num]`）。
  let vq: KernelVirtqueue | null = null;
  if (driverState !== null && hwCtx !== null) {
    try {
      const vqAddress = await virtqueueAddressForQueue(view, layout, driverState, hwCtx.queueNum);
      if (vqAddress === null) {
        ambiguities.push(
          `vblk->vqs[${hwCtx.queueNum}] 是空指针或下标越界（num_vqs = ${driverState.numVqs}）：`
          + '这个硬件上下文没有对应的 virtqueue',
        );
      } else {
        vq = await readVirtqueue(view, layout, vqAddress);
        notes.push(...vq.notes);
        ambiguities.push(...vq.violations);
      }
    } catch (error) {
      ambiguities.push(`读 virtqueue 失败：${describe(error)}`);
    }
  } else if (driverState !== null) {
    notes.push('没有硬件上下文（`rq->mq_hctx` 为空），取不到 `queue_num`，无法定位是哪个 virtqueue');
  }

  // 四、直接读取请求的 PDU 和设备头。
  let pdu: KernelVirtblkReq | null = null;
  try {
    pdu = await readVirtblkReq(view, layout, request.pduAddress, { maxSg: options.maxVectors });
    notes.push(...pdu.notes);
    ambiguities.push(...pdu.violations);
    if (pdu.status === 0 && pdu.outTypeBarrier) {
      notes.push('私有区的状态字节是 0 且带着 BARRIER 位：这是兼容写法，状态 0 在完成前是初值');
    }
  } catch (error) {
    ambiguities.push(`读请求私有区 ${toHex(request.pduAddress)} 失败：${describe(error)}`);
  }

  // 五、描述符链：先按 token 找头（权威），再用描述符里的地址反查（旁证）。
  let owners: DescriptorOwnerTable | null = null;
  let tokenLookup: TokenLookup | null = null;
  let descriptorChain: KernelDescriptorChain | null = null;
  if (vq !== null) {
    try {
      owners = await readDescriptorOwners(view, layout, vq);
      notes.push(...owners.notes);
      const token = request.pduAddress;
      tokenLookup = lookupToken(owners, token);
      if (!tokenLookup.unique && tokenLookup.ambiguity !== null) ambiguities.push(tokenLookup.ambiguity);
      if (tokenLookup.unique) {
        descriptorChain = await walkDescriptorChain(view, layout, vq, tokenLookup.heads[0]);
        notes.push(...descriptorChain.notes);
        ambiguities.push(...descriptorChain.violations);
      }
    } catch (error) {
      ambiguities.push(`读描述符状态表/链失败：${describe(error)}`);
    }
  }

  // 六、描述符链的第二条独立证据：**段的个数**。
  //
  // `virtblk_add_req()` 把 sg 表摊成描述符：先是 out 头（1 段），然后是数据段
  // （`sg_table.nents` 段），最后是 in 头（1 段）。所以"描述符个数"是可以**从私有区
  // 描述符段数由私有区独立计算，供链长度校验。
  // 因而在 `use_dma_api` 为真的队列上（描述符里是 IOVA）照样成立。
  if (descriptorChain !== null && pdu !== null) {
    const segments = descriptorChain.indirect
      ? descriptorChain.indirectDescriptors
      : descriptorChain.descriptors;
    const isDataRequest = pdu.outTypeSymbol === 'VIRTIO_BLK_T_IN' || pdu.outTypeSymbol === 'VIRTIO_BLK_T_OUT';
    if (isDataRequest) {
      // 数据段的 sg 在 `virtblk_add_req()` 里只会被放进 out 或 in 之一。
      const expected = 1 + pdu.sgNents + 1;
      if (segments.length !== expected) {
        ambiguities.push(
          `描述符链有 ${segments.length} 段，而按私有区算应当是 ${expected} 段`
          + `（1 个请求头 + ${pdu.sgNents} 个数据段 + 1 个状态）：`
          + '两侧对"这次请求由几段组成"的说法不一致',
        );
      }
    } else if (pdu.outTypeSymbol === 'VIRTIO_BLK_T_FLUSH' && segments.length !== 2) {
      notes.push(`FLUSH 请求有 ${segments.length} 段描述符，通常应当是 2 段（请求头 + 状态）`);
    }
    const coordinate = addressSpaceOfDescriptors(vq as KernelVirtqueue);
    notes.push(`描述符里的地址坐标系：${coordinate.kind} —— ${coordinate.reason}`);
    notes.push(
      `描述符链（${descriptorChain.indirect ? '间接表' : '主环'}）共 ${segments.length} 段，`
      + `合计 ${segments.reduce((sum, item) => sum + item.len, 0)} 字节：`
      + segments.map((item) => `[${toHex(item.addr)}+${item.len} ${item.flagsDecode.names.join('|') || 'RO'}]`).join(' '),
    );
  }

  // 七、标签表：`tag` 是请求 ID，但它会被复用，所以要么回到 `tags->rqs[tag]` 确认。
  let tags: KernelMqTags | null = null;
  if (options.readTags !== false && hwCtx !== null && hwCtx.tags !== null && request.tag >= 0) {
    try {
      tags = await readMqTags(view, layout, hwCtx.tags, { limit: request.tag + 8 });
      notes.push(...tags.notes);
      const slot = tags.tagged.find((entry) => entry.tag === request.tag) ?? null;
      if (slot === null) {
        notes.push(`标签表只读到 ${tags.tagged.length} 个槽，没覆盖 tag ${request.tag}，无法核对`);
      } else if (slot.request !== null && slot.request !== request.address) {
        ambiguities.push(
          `tags->rqs[${request.tag}] 是 ${toHex(slot.request)}，而这次解析的请求在 `
          + `${toHex(request.address)}：tag 已经被复用（或读错了请求），tag ${request.tag} 不能当唯一身份`,
        );
      }
    } catch (error) {
      notes.push(`读 blk_mq_tags 失败：${describe(error)}`);
    }
  }

  const bioChain = options.readBios === false
    ? { bios: [], truncated: false, cycle: false, sectorStart: null, sectorEnd: null, contiguous: false, seams: [], notes: [] }
    : await walkBioChain(view, layout, request.bio, {
      tail: request.bioTail,
      maxVectors: options.maxVectors,
    });
  notes.push(...bioChain.notes);

  // 八、扇区区间对账：请求的扇区区间、bio 链的区间、设备头里的扇区，三者必须自洽。
  if (bioChain.bios.length > 0) {
    if (bioChain.sectorStart !== request.sector) {
      ambiguities.push(
        `rq->__sector = ${request.sector}，而 rq->bio 链的起点是 ${bioChain.sectorStart}：`
        + '请求区间与它第一个 bio 的区间不一致',
      );
    }
    if (bioChain.sectorEnd !== request.sectorEnd && bioChain.sectorEnd !== null) {
      notes.push(
        `bio 链的终点是扇区 ${bioChain.sectorEnd}，而按 rq->__sector + __data_len/512 算是 `
        + `${request.sectorEnd}：两者不同（一个 bio 可能没有把 rq 的字节数全算进去）`,
      );
    }
  }
  if (pdu !== null && (pdu.outTypeSymbol === 'VIRTIO_BLK_T_IN' || pdu.outTypeSymbol === 'VIRTIO_BLK_T_OUT')) {
    if (pdu.outSector !== request.sector) {
      ambiguities.push(
        `设备头里的扇区是 ${pdu.outSector}，而请求的起点是 ${request.sector}：`
        + '设备要读/写的位置与块层请求不是同一处',
      );
    }
  }
  if (pdu !== null && request.op.short !== null) {
    const expected = request.op.writesToDevice ? 'VIRTIO_BLK_T_OUT' : 'VIRTIO_BLK_T_IN';
    if ((pdu.outTypeSymbol === 'VIRTIO_BLK_T_IN' || pdu.outTypeSymbol === 'VIRTIO_BLK_T_OUT')
      && pdu.outTypeSymbol !== expected) {
      ambiguities.push(
        `块层把它记成 ${request.op.symbol}（${request.op.writesToDevice ? '写往设备' : '从设备读'}），`
        + `而设备请求类型是 ${pdu.outTypeSymbol}（${expected} 才对）：两侧对这次 I/O 的方向说法不一致`,
      );
    }
  }

  const lifecycle = classifyLifecycle(vq, owners, tokenLookup, request);

  return {
    request,
    identity: requestIdentity(request),
    queue,
    hwCtx,
    driverState,
    disk,
    vq,
    pdu,
    owners,
    tokenLookup,
    descriptorChain,
    tags,
    bioChain,
    lifecycle,
    unique: ambiguities.length === 0,
    ambiguities,
    notes,
    evidence: memoryEvidence(
      view.evidenceSource,
      request.address,
      layout.type('request').byteSize ?? 0,
      [
        `request:${toHex(request.address)}`,
        `tag:${request.tag}`,
        `pdu:${toHex(request.pduAddress)}`,
        `lifecycle:${lifecycle}`,
      ],
    ),
  };
}

/** 结合 token 占用、avail/used 回绕差和 MQ_RQ_* 请求状态判定生命周期。 */
export function classifyLifecycle(
  vq: KernelVirtqueue | null,
  owners: DescriptorOwnerTable | null,
  tokenLookup: TokenLookup | null,
  request: KernelRequest,
): RequestLifecycle {
  if (vq === null || owners === null) return 'unknown';
  const token = request.pduAddress;
  const inRing = tokenLookup !== null && tokenLookup.unique;
  const outstanding = (vq.availIdx - vq.usedIdx) & 0xffff;
  if (inRing) {
    // token 保留且 outstanding=0，表示设备已用完，驱动等待回收。
    if (outstanding === 0) return 'completed-on-device';
    return 'in-flight-on-device';
  }
  // token 释放后按请求 MQ_RQ_* 区分提交准备和回收。
  // outstanding 保留队列计数来源。
  switch (request.stateName) {
    case 'MQ_RQ_IN_FLIGHT':
      return 'not-submitted';
    case 'MQ_RQ_COMPLETE':
      return 'completed-on-device';
    case 'MQ_RQ_IDLE':
      return 'recycled';
    default:
      // 状态名缺失时按 outstanding 降级判断。
      // 调用方同时展示 tokenLookup 的歧义说明。
      // 生命周期与关联可信度分别返回。
      return outstanding === 0 ? 'recycled' : 'not-submitted';
  }
}

/* --------------------------------------------------------------------------
 * bio → 页缓存
 * ------------------------------------------------------------------------ */

export interface BioFolioLink {
  /** 这一段的来源 */
  bioAddress: bigint;
  bioVecIndex: number;
  /** `bv_page` 指向的 `struct page` */
  pageAddress: bigint;
  /** 页框号（`bv_page` 减 vmemmap 基址除以 struct page 宽度） */
  pfn: bigint | null;
  /** 页框号算不出来时的余数（说明 `bv_page` 不是这套 vmemmap 里的页） */
  pfnRemainder: bigint;
  folio: KernelFolio | null;
  /** `bv_offset`：这一段的页内起点 */
  offset: number;
  /** `bv_len`：这一段多少字节 */
  length: number;
  /** 这一段覆盖的页内区间 `[offset, offset+length)` */
  end: number;
  error: string | null;
  notes: string[];
}

/** bio 数据段经 bv_page 求 PFN 并读取 folio，mapping/index 提供文件来源；对齐失败记 error。 */
export async function linkBioToFolios(
  view: KernelMemoryView,
  layout: KernelLayout,
  bio: KernelBio,
  options: { vmemmap?: VmemmapFacts; maxVectors?: number } = {},
): Promise<BioFolioLink[]> {
  const links: BioFolioLink[] = [];
  const limit = Math.min(bio.vectors.length, options.maxVectors ?? bio.vectors.length);
  let vmemmap = options.vmemmap ?? null;
  for (let index = 0; index < limit; index += 1) {
    const vector = bio.vectors[index];
    const link: BioFolioLink = {
      bioAddress: bio.address,
      bioVecIndex: index,
      pageAddress: vector.pageAddress ?? 0n,
      pfn: null,
      pfnRemainder: 0n,
      folio: null,
      offset: vector.offset,
      length: vector.length,
      end: vector.offset + vector.length,
      error: null,
      notes: [...vector.notes],
    };
    if (vector.pageAddress === null) {
      link.error = 'bv_page 是空指针：这一段没有页（FLUSH 这类不搬数据的 bio 会这样）';
      links.push(link);
      continue;
    }
    if (vmemmap === null) vmemmap = await resolveVmemmapBase(view, layout, { pfn: 0n });
    const derived = pfnForPageAddress(vmemmap, vector.pageAddress);
    link.pfn = derived.pfn;
    link.pfnRemainder = derived.remainder;
    if (derived.pfn === null) {
      link.error =
        `bv_page = ${toHex(vector.pageAddress)} 减掉 vmemmap 基址 ${toHex(vmemmap.base)} 之后`
        + `不是 sizeof(struct page) = ${vmemmap.pageStructSize} 的整数倍（余 ${derived.remainder}）：`
        + '这一页不属于这套 vmemmap 映射';
      links.push(link);
      continue;
    }
    try {
      link.folio = await readFolioForPfn(view, layout, { pfn: derived.pfn, vmemmap });
    } catch (error) {
      link.error = `解 folio 失败：${describe(error)}`;
    }
    if (link.folio !== null && link.folio.mapping === 0n) {
      link.notes.push(
        '这一页的 mapping 为 0：它不属于任何 address_space（可能是没有页缓存的元数据页，'
        + '例如 virtio-blk 自己的段表或 ext2 的间接块）',
      );
    }
    if (link.folio !== null && link.folio.mappingIsAnon) {
      link.notes.push(
        `mapping 最低位立着（PAGE_MAPPING_ANON）：这是匿名页，它没有文件偏移，`
        + '不能把它算成"文件的第几页"',
      );
    }
    links.push(link);
  }
  return links;
}

/* --------------------------------------------------------------------------
 * 合并 / 拆分 / 预读
 * ------------------------------------------------------------------------ */

export interface MergeSplitVerdict {
  /** 一次请求里挂了多少个 bio */
  bioCount: number;
  /** 所有 bio 的向量段数之和 */
  vectorCount: number;
  /** 涉及多少个不同的页 */
  distinctPages: number;
  /** 请求的字节数（`__data_len`） */
  requestBytes: number;
  /** bio 链上所有段的字节数之和 */
  segmentBytes: number;
  /** 是否发生了合并（一个请求里挂了多个 bio） */
  coalesced: boolean;
  /** 是否有单个 bio 跨了多个页（一次 I/O 被拆到多段） */
  multiVector: boolean;
  /** 链上相邻 bio 是否首尾相接 */
  contiguous: boolean;
  /** 一个数据段是否被拆进了多个 bio（同一页在链上出现多次） */
  repeatedPages: boolean;
  reasons: string[];
}

/** 依据 bio 数量、向量数、页分布和区间接续报告合并及拆分证据。 */
export function classifyMergeSplit(trace: IoRequestTrace): MergeSplitVerdict {
  const bios = trace.bioChain.bios;
  const reasons: string[] = [];
  const pages = new Set<string>();
  let vectorCount = 0;
  let segmentBytes = 0;
  let multiVector = false;
  const seenPages = new Set<string>();
  let repeatedPages = false;

  for (const bio of bios) {
    vectorCount += bio.vectors.length;
    segmentBytes += bio.totalBytes;
    if (bio.vectors.length > 1) multiVector = true;
    for (const vector of bio.vectors) {
      if (vector.pageAddress === null) continue;
      const key = vector.pageAddress.toString(16);
      pages.add(key);
      if (seenPages.has(key)) repeatedPages = true;
      seenPages.add(key);
    }
  }

  const coalesced = bios.length > 1;
  if (coalesced) {
    reasons.push(
      `一个请求里挂了 ${bios.length} 个 bio：块层把 ${bios.length} 次提交合成了一个请求`
      + (trace.bioChain.contiguous ? '（相邻 bio 的扇区区间首尾相接，是真正的合并）' : '（但它们之间有缝，只是被凑到一起处理）'),
    );
  }
  if (multiVector) reasons.push('有 bio 的向量表里不止一段：这一次 I/O 本身跨了多页，是被拆开描述的');
  if (repeatedPages) reasons.push('同一个页在链上出现了多次：一次逻辑写被拆成了多块，落在同一页的不同位置');
  if (trace.request.nrPhysSegments !== 0 && trace.request.nrPhysSegments !== vectorCount) {
    reasons.push(
      `rq->nr_phys_segments = ${trace.request.nrPhysSegments}，而 bio 段数合计 ${vectorCount}：`
      + '两者不同说明有段在块层被并掉了（或者任务在读的这一刻正好处于合并中途）',
    );
  }
  if (bios.length === 0) reasons.push('请求上没挂 bio：这一刻它不搬数据（或 bio 已经被回收）');

  return {
    bioCount: bios.length,
    vectorCount,
    distinctPages: pages.size,
    requestBytes: trace.request.dataLen,
    segmentBytes,
    coalesced,
    multiVector,
    contiguous: trace.bioChain.contiguous,
    repeatedPages,
    reasons,
  };
}

export interface ReadaheadVerdict {
  /** 这次 I/O 是不是预读（`REQ_RAHEAD`） */
  readahead: boolean;
  /** 请求或它挂的 bio 上立着 `REQ_RAHEAD` 的地址 */
  flags: string[];
  reason: string;
}

/** 根据请求或 bio 的 REQ_RAHEAD 标志识别内核预读。 */
export function classifyReadahead(trace: IoRequestTrace): ReadaheadVerdict {
  const flagged: string[] = [];
  if (trace.request.flags.names.includes('REQ_RAHEAD')) flagged.push(`request ${toHex(trace.request.address)}`);
  for (const bio of trace.bioChain.bios) {
    if (bio.flags.names.includes('REQ_RAHEAD')) flagged.push(`bio ${toHex(bio.address)}`);
  }
  const readahead = flagged.length > 0;
  return {
    readahead,
    flags: flagged,
    reason: readahead
      ? '请求或它的 bio 上立着 REQ_RAHEAD：这是内核替程序提前读的，不是程序自己要求的 I/O'
      : '没有 REQ_RAHEAD：这次 I/O 是程序（或回写）主动发起的',
  };
}

/* --------------------------------------------------------------------------
 * 文件偏移 → 页缓存 → 谁在搬它
 * ------------------------------------------------------------------------ */

/** 一个文件写的"现在处于什么状态"。 */
export type FileWritePhase =
  /** 缓存页全为干净页，carriedBy 为空 */
  | 'in-cache-clean'
  /** 缓存存在脏页，carriedBy 为空，等待后续写回 */
  | 'in-cache-dirty-no-io'
  /** 有脏页，并且有 bio/request 正在搬它们 */
  | 'in-cache-dirty-io-pending'
  /** 页上 dirty 已清除，存在 I/O 搬运关联 */
  | 'io-in-flight'
  /** 文件范围有页缓存覆盖缺口 */
  | 'partly-uncached';

export interface FileFolioState {
  /** 文件内偏移（字节） */
  fileOffset: bigint;
  /** 这一页在页缓存里的下标（页号） */
  index: bigint;
  folio: KernelFolio | null;
  /** 这一页是否被某个 I/O 正在搬 */
  carriedBy: Array<{ requestAddress: bigint; requestTag: number; bioAddress: bigint; vectorIndex: number }>;
  dirty: boolean;
  uptodate: boolean;
}

export interface FileWriteState {
  phase: FileWritePhase;
  /** 请求覆盖的文件偏移区间 `[start, end)` */
  fileOffsetStart: bigint;
  fileOffsetEnd: bigint;
  pages: FileFolioState[];
  dirtyPages: number;
  pagesInCache: number;
  pagesCarried: number;
  /** 结论的推导过程，面板上照抄即可 */
  reasons: string[];
  violations: string[];
}

/** 结合 folio 的 mapping/index、dirty 和 bio 的 bv_page 判定缓存及搬运状态。 */
export function classifyFileWriteState(
  options: {
    mappingAddress: bigint;
    fileOffsetStart: bigint;
    fileOffsetEnd: bigint;
    folios: KernelFolio[];
    traces: IoRequestTrace[];
    links: Map<string, BioFolioLink[]>;
  },
): FileWriteState {
  const reasons: string[] = [];
  const violations: string[] = [];
  const firstPage = options.fileOffsetStart >> BigInt(PAGE_SHIFT);
  const lastPage = (options.fileOffsetEnd - 1n) >> BigInt(PAGE_SHIFT);
  const byIndex = new Map<string, KernelFolio>();
  for (const folio of options.folios) byIndex.set(folio.index.toString(), folio);

  const pages: FileFolioState[] = [];
  let dirtyPages = 0;
  let pagesCarried = 0;

  for (let index = firstPage; index <= lastPage; index += 1n) {
    const folio = byIndex.get(index.toString()) ?? null;
    const carriedBy: FileFolioState['carriedBy'] = [];
    for (const trace of options.traces) {
      for (const bio of trace.bioChain.bios) {
        const links = options.links.get(bio.address.toString()) ?? [];
        for (const link of links) {
          if (link.pfn === null || link.folio === null) continue;
          if (folio !== null && link.folio.address !== folio.address) continue;
          if (folio === null && link.folio.index !== index) continue;
          carriedBy.push({
            requestAddress: trace.request.address,
            requestTag: trace.request.tag,
            bioAddress: bio.address,
            vectorIndex: link.bioVecIndex,
          });
        }
      }
    }
    if (folio !== null && folio.mapping !== options.mappingAddress && !folio.mappingIsAnon) {
      violations.push(
        `文件第 ${index} 页的页（${toHex(folio.address)}）mapping 是 ${toHex(folio.mapping)}，`
        + `不是目标文件的 address_space ${toHex(options.mappingAddress)}：这一页不是这个文件的数据`,
      );
    }
    const dirty = folio !== null && folio.pageFlags.includes('PG_dirty');
    const uptodate = folio !== null && folio.pageFlags.includes('PG_uptodate');
    if (folio === null) {
      violations.push(`文件第 ${index} 页不在页缓存里（下标 ${index} 没有对应的 folio）`);
    } else if (dirty) {
      dirtyPages += 1;
    }
    if (carriedBy.length > 0) pagesCarried += 1;
    pages.push({
      fileOffset: index << BigInt(PAGE_SHIFT),
      index,
      folio,
      carriedBy,
      dirty,
      uptodate,
    });
  }

  const totalPages = pages.length;
  const inCache = pages.filter((page) => page.folio !== null).length;
  let phase: FileWritePhase;
  if (inCache < totalPages) {
    phase = 'partly-uncached';
    reasons.push(
      `被写的 ${totalPages} 页里有 ${totalPages - inCache} 页不在页缓存里：`
      + '这通常说明程序还没写到那儿，或者页被回收了',
    );
  } else if (dirtyPages > 0 && pagesCarried === 0) {
    phase = 'in-cache-dirty-no-io';
    reasons.push(
      `${dirtyPages} 页是脏的，但没有任何 bio/请求正在搬它们：`
      + '**这就是缓存命中** —— 数据已经在内存里，盘上还没有',
    );
  } else if (dirtyPages > 0 && pagesCarried > 0) {
    phase = 'in-cache-dirty-io-pending';
    reasons.push(`${dirtyPages} 页是脏的，其中 ${pagesCarried} 页正被 I/O 搬运：回写正在进行`);
  } else if (dirtyPages === 0 && pagesCarried > 0) {
    phase = 'io-in-flight';
    reasons.push(
      `页都不脏了，但有 ${pagesCarried} 页正被 I/O 搬运：`
      + '这是"数据已经交给设备、页上的脏标记已经清掉"的形态（写回完成或正在完成）',
    );
  } else {
    phase = 'in-cache-clean';
    reasons.push('页都在缓存里、都是干净的、也没有 I/O 在搬：这一刻没有落盘活要干');
  }

  return {
    phase,
    fileOffsetStart: options.fileOffsetStart,
    fileOffsetEnd: options.fileOffsetEnd,
    pages,
    dirtyPages,
    pagesInCache: inCache,
    pagesCarried,
    reasons,
    violations,
  };
}

/* --------------------------------------------------------------------------
 * 组合入口
 * ------------------------------------------------------------------------ */

export interface FileIoAssociation {
  chain: FileChain;
  /** 目标文件的当前 f_pos 字节位置 */
  fileOffset: bigint;
  traces: IoRequestTrace[];
  writeState: FileWriteState | null;
  merge: MergeSplitVerdict[];
  readahead: ReadaheadVerdict[];
  /** 所有请求合起来是否唯一对应这一次文件写 */
  unique: boolean;
  ambiguities: string[];
  notes: string[];
  evidence: EvidenceRef;
}

/** 将文件 address_space/folio 与请求 bio 的页结构关联，返回写回、缓存和歧义证据。 */
export async function associateFileIo(
  view: KernelMemoryView,
  layout: KernelLayout,
  options: {
    chain: FileChain;
    requestAddresses: bigint[];
    /** 写入区间，省略时使用缓存中全部脏页的范围 */
    writeRange?: { start: bigint; end: bigint } | null;
    vmemmap?: VmemmapFacts;
    maxVectors?: number;
  },
): Promise<FileIoAssociation> {
  const notes: string[] = [];
  const ambiguities: string[] = [];
  const chain = options.chain;
  const mappingAddress = chain.addressSpace?.address ?? chain.file.fMapping ?? chain.inode?.mapping ?? null;
  if (mappingAddress === null) {
    throw new IoParseError('no-address-space', '这个文件没有 address_space：它没有页缓存，I/O 关联无从谈起', {
      file: toHex(chain.file.address),
    });
  }

  // 页缓存：用 T07d 的读法（限定遍历），失败时如实报出来。
  const folios: KernelFolio[] = [];
  const pageCache = await readPageCacheForMapping(view, layout, mappingAddress, {
    vmemmap: options.vmemmap,
    maxEntries: 256,
  });
  folios.push(...pageCache.folios);
  notes.push(...pageCache.notes);
  ambiguities.push(...pageCache.violations);

  const traces: IoRequestTrace[] = [];
  const links = new Map<string, BioFolioLink[]>();
  for (const address of options.requestAddresses) {
    let trace: IoRequestTrace;
    try {
      trace = await traceRequest(view, layout, address, { maxVectors: options.maxVectors });
    } catch (error) {
      ambiguities.push(`解析请求 ${toHex(address)} 失败：${describe(error)}`);
      continue;
    }
    traces.push(trace);
    ambiguities.push(...trace.ambiguities.map((line) => `请求 ${toHex(address)}：${line}`));
    for (const bio of trace.bioChain.bios) {
      // 以页结构对齐文件与 bio 的归属。
      // 扇区到文件块的对应由文件系统块映射提供。
      links.set(bio.address.toString(), await linkBioToFolios(view, layout, bio, { vmemmap: options.vmemmap }));
    }
  }

  const fileOffset = chain.file.fPos;
  let writeRange = options.writeRange ?? null;
  if (writeRange === null && folios.length > 0) {
    const dirty = folios.filter((folio) => folio.pageFlags.includes('PG_dirty'));
    if (dirty.length > 0) {
      writeRange = {
        start: dirty.reduce((min, folio) => (folio.index < min ? folio.index : min), dirty[0].index) << BigInt(PAGE_SHIFT),
        end: (dirty.reduce((max, folio) => (folio.index > max ? folio.index : max), dirty[0].index) + 1n) << BigInt(PAGE_SHIFT),
      };
      notes.push(
        `调用方没给写区间，按页缓存里的脏页推出 ${toHex(writeRange.start)}..${toHex(writeRange.end)}：`
        + '这是"现在脏着的部分"，不等于"程序这次调 write() 的那一段"',
      );
    }
  }

  const writeState = writeRange === null
    ? null
    : classifyFileWriteState({
      mappingAddress,
      fileOffsetStart: writeRange.start,
      fileOffsetEnd: writeRange.end,
      folios,
      traces,
      links,
    });

  const unique = ambiguities.length === 0 && (writeState === null || writeState.violations.length === 0);

  return {
    chain,
    fileOffset,
    traces,
    writeState,
    merge: traces.map(classifyMergeSplit),
    readahead: traces.map(classifyReadahead),
    unique,
    ambiguities,
    notes,
    evidence: memoryEvidence(view.evidenceSource, chain.file.address, 184, [
      `file:${toHex(chain.file.address)}`,
      `mapping:${toHex(mappingAddress)}`,
      `requests:${traces.length}`,
      `phase:${writeState?.phase ?? 'unknown'}`,
    ]),
  };
}

/** 读页缓存（把 T07d 的 `readPageCache` 包一层，避免这一层直接依赖 XArray 细节）。 */
async function readPageCacheForMapping(
  view: KernelMemoryView,
  layout: KernelLayout,
  mappingAddress: bigint,
  options: { vmemmap?: VmemmapFacts; maxEntries?: number },
): Promise<{ folios: KernelFolio[]; notes: string[]; violations: string[] }> {
  const mapping = await readAddressSpace(view, layout, mappingAddress);
  const result = await readPageCache(view, layout, mapping, {
    vmemmap: options.vmemmap,
    maxEntries: options.maxEntries,
  });
  const folios: KernelFolio[] = [];
  for (const entry of result.entries) {
    if (entry.folio !== null) folios.push(entry.folio);
  }
  return { folios, notes: result.notes, violations: result.violations };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
