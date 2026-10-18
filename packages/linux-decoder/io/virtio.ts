/** virtio 队列与请求私有区的只读视图。
 * desc_state[head].data 提供 token 归属，描述符地址作为第二条证据核对。
 * use_dma_api 标明 IOVA 坐标系，布局提供 virtqueue、vring 和 virtblk_req 的位置。
 */

import { memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';
import { readStruct } from '../objects/task.ts';
import {
  VIRTIO_BLK_S_NAMES,
  VIRTIO_BLK_T,
  VRING_AVAIL_F_NO_INTERRUPT,
  VRING_DESC_F,
  VRING_USED_F_NO_NOTIFY,
  describeVirtioBlkType,
  describeVringDescFlags,
} from './blocks.ts';
import { IoParseError } from './objects.ts';

export const VIRTQUEUE_TYPE = 'virtqueue';
export const VRING_VIRTQUEUE_TYPE = 'vring_virtqueue';
export const VRING_VIRTQUEUE_SPLIT_TYPE = 'vring_virtqueue_split';
export const VRING_TYPE = 'vring';
export const VRING_DESC_TYPE = 'vring_desc';
export const VRING_DESC_STATE_SPLIT_TYPE = 'vring_desc_state_split';
export const VIRTIO_BLK_TYPE = 'virtio_blk';
export const VIRTIO_BLK_VQ_TYPE = 'virtio_blk_vq';
export const VIRTBLK_REQ_TYPE = 'virtblk_req';
export const VIRTIO_BLK_OUTHDR_TYPE = 'virtio_blk_outhdr';
export const SCATTERLIST_TYPE = 'scatterlist';

/** 描述符链的默认长度上限。virtio-blk 一次请求最多 out 头 + 数据段 + in 头。 */
export const DEFAULT_MAX_DESCRIPTORS = 256;

/** 一次最多读多少个 sg 表项。 */
export const DEFAULT_MAX_SG = 64;

/* --------------------------------------------------------------------------
 * virtqueue / vring_virtqueue
 * ------------------------------------------------------------------------ */

export interface KernelVirtqueue {
  /** `struct virtqueue *`（也就是 `struct vring_virtqueue *`，两者同址） */
  address: bigint;
  index: number;
  numFree: number;
  numMax: number;
  name: string | null;
  vdev: bigint | null;
  priv: bigint | null;
  /** packed_ring=true 时记录 split 解码能力缺口 */
  packedRing: boolean;
  /** `indirect`：设备是否支持间接描述符 */
  indirect: boolean;
  event: boolean;
  broken: boolean;
  /** use_dma_api=true 时描述符地址使用 IOVA 坐标系 */
  useDmaApi: boolean;
  premapped: boolean;
  doUnmap: boolean;
  freeHead: number;
  numAdded: number;
  lastUsedIdx: number;
  /** `vring.num`：描述符个数（一定是 2 的幂） */
  num: number;
  /** `&vring.desc[0]` */
  descAddress: bigint;
  /** `&vring.avail` */
  availAddress: bigint;
  /** `&vring.used` */
  usedAddress: bigint;
  /** `&split.desc_state[0]`：描述符头 → token 的状态表 */
  descStateAddress: bigint;
  /** `&split.desc_extra[0]` */
  descExtraAddress: bigint;
  availFlagsShadow: number;
  availIdxShadow: number;
  /** 环上现在公开的 `avail->idx`（设备看得到的那个） */
  availIdx: number;
  availFlags: number;
  /** 环上现在公开的 `used->idx`（设备写完的那个） */
  usedIdx: number;
  usedFlags: number;
  notes: string[];
  violations: string[];
  evidence: EvidenceRef;
}

/** 读取队列结构和公开环索引，num 违反 2 的幂校验时记录 violation。 */
export async function readVirtqueue(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelVirtqueue> {
  if (address === 0n) {
    throw new IoParseError('null-virtqueue', 'struct virtqueue 地址为 0', {});
  }
  const struct = await readStruct(view, layout, VRING_VIRTQUEUE_TYPE, address);
  const notes: string[] = [];
  const violations: string[] = [];

  const packedRing = struct.value('packed_ring', false) === 1;
  if (packedRing) {
    violations.push(
      'packed_ring 立着：这是 packed 环，`split` 那套字段（vring/desc_state）此时是另一组数据的重叠视图，'
      + '本实现不解 packed 环，不能用下面的描述符信息',
    );
  }

  const num = Number(struct.value('split.vring.num', false));
  if (num !== 0 && (num & (num - 1)) !== 0) {
    violations.push(
      `vring.num = ${num} 不是 2 的幂：内核用 (num - 1) 做下标掩码，环长不合法时算出来的描述符下标会指到别处`,
    );
  }

  const nameField = struct.has('vq.name') ? struct.field('vq.name') : null;
  let name: string | null = null;
  if (nameField !== null && struct.pointer('vq.name') !== null) {
    const raw = await view.cstring(struct.pointer('vq.name') as bigint, 64);
    name = raw.text;
    if (raw.truncated) notes.push('队列名字读到 64 字节还没有结尾 0，可能是不合法的字符串');
  }

  const descAddress = struct.pointer('split.vring.desc');
  const availAddress = struct.pointer('split.vring.avail');
  const usedAddress = struct.pointer('split.vring.used');
  const descStateAddress = struct.pointer('split.desc_state');
  const descExtraAddress = struct.pointer('split.desc_extra');
  for (const [label, value] of [
    ['split.vring.desc', descAddress],
    ['split.vring.avail', availAddress],
    ['split.vring.used', usedAddress],
    ['split.desc_state', descStateAddress],
  ] as const) {
    if (value === null) {
      violations.push(`${label} 是空指针：这个队列还没分配环（或 packed 环下这里没有意义）`);
    }
  }

  // avail/used 环头提供设备与驱动共享的公开计数器。
  // 队列结构中的 shadow 值保留为驱动缓存来源。
  // 分别读取后记录两侧实际状态。
  let availIdx = 0;
  let availFlags = 0;
  let usedIdx = 0;
  let usedFlags = 0;
  if (availAddress !== null) {
    const raw = await view.bytes(availAddress, 4);
    availFlags = raw[0] | (raw[1] << 8);
    availIdx = raw[2] | (raw[3] << 8);
  }
  if (usedAddress !== null) {
    const raw = await view.bytes(usedAddress, 4);
    usedFlags = raw[0] | (raw[1] << 8);
    usedIdx = raw[2] | (raw[3] << 8);
  }

  return {
    address,
    index: Number(struct.value('vq.index', false)),
    numFree: Number(struct.value('vq.num_free', false)),
    numMax: Number(struct.value('vq.num_max', false)),
    name,
    vdev: struct.pointer('vq.vdev'),
    priv: struct.pointer('vq.priv'),
    packedRing,
    indirect: struct.value('indirect', false) === 1,
    event: struct.value('event', false) === 1,
    broken: struct.value('broken', false) === 1,
    useDmaApi: struct.value('use_dma_api', false) === 1,
    premapped: struct.value('premapped', false) === 1,
    doUnmap: struct.value('do_unmap', false) === 1,
    freeHead: Number(struct.value('free_head', false)),
    numAdded: Number(struct.value('num_added', false)),
    lastUsedIdx: Number(struct.value('last_used_idx', false)),
    num,
    descAddress: descAddress ?? 0n,
    availAddress: availAddress ?? 0n,
    usedAddress: usedAddress ?? 0n,
    descStateAddress: descStateAddress ?? 0n,
    descExtraAddress: descExtraAddress ?? 0n,
    availFlagsShadow: Number(struct.value('split.avail_flags_shadow', false)),
    availIdxShadow: Number(struct.value('split.avail_idx_shadow', false)),
    availIdx,
    availFlags,
    usedIdx,
    usedFlags,
    notes,
    violations,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${VRING_VIRTQUEUE_TYPE}`,
      `num:${num}`,
      `num_free:${struct.value('vq.num_free', false)}`,
      `desc:${descAddress === null ? 'null' : toHex(descAddress)}`,
    ]),
  };
}

/** 队列在"描述符里的地址是什么坐标系"这件事上的结论。 */
export function addressSpaceOfDescriptors(vq: KernelVirtqueue): {
  kind: 'physical' | 'dma';
  reason: string;
} {
  if (vq.useDmaApi) {
    return {
      kind: 'dma',
      reason:
        'vq->use_dma_api 立着：`vring_map_one_sg()` 走 DMA API，描述符里的 addr 是 DMA 地址（IOVA），'
        + '与客户机物理地址之间没有固定换算，不能直接换成页框',
    };
  }
  return {
    kind: 'physical',
    reason:
      'vq->use_dma_api 没立着：`vring_map_one_sg()` 走 `virt_to_phys(sg_virt(sg))`，'
      + '描述符里的 addr 就是客户机物理地址',
  };
}

/* --------------------------------------------------------------------------
 * 描述符与描述符链
 * ------------------------------------------------------------------------ */

export interface KernelVringDescriptor {
  /** 在这个环里的下标 */
  index: number;
  address: bigint;
  /** `addr`：缓冲区地址（坐标系见 `addressSpaceOfDescriptors`） */
  addr: bigint;
  /** `len`：缓冲区长度 */
  len: number;
  /** `flags`：16 位标志 */
  flags: number;
  flagsDecode: { names: string[]; unknown: number; raw: number };
  /** `next`：链上的下一个描述符下标 */
  next: number;
  /** 是否还有下一个（`NEXT` 立着） */
  hasNext: boolean;
  /** 是否是间接表（`INDIRECT` 立着） */
  isIndirect: boolean;
}

export async function readVringDescriptor(
  view: KernelMemoryView,
  layout: KernelLayout,
  descBase: bigint,
  index: number,
): Promise<KernelVringDescriptor> {
  const stride = descriptorSize(layout);
  const address = descBase + BigInt(index * stride);
  const struct = await readStruct(view, layout, VRING_DESC_TYPE, address);
  const flags = struct.u16('flags');
  const flagsDecode = describeVringDescFlags(flags);
  const next = struct.u16('next');
  return {
    index,
    address,
    addr: struct.u64('addr'),
    len: struct.u32('len'),
    flags,
    flagsDecode,
    next,
    hasNext: (flags & VRING_DESC_F.NEXT) !== 0,
    isIndirect: (flags & VRING_DESC_F.INDIRECT) !== 0,
  };
}

function descriptorSize(layout: KernelLayout): number {
  const type = layout.type(VRING_DESC_TYPE);
  if (type.byteSize === null) {
    throw new IoParseError('desc-size-unknown', '布局清单里 struct vring_desc 的大小未知', { typeName: VRING_DESC_TYPE });
  }
  return type.byteSize;
}

/** 按小端读取固定 8 字节指针。 */
function littleEndianPointer(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

export interface KernelDescriptorChain {
  /** 链头描述符下标（avail 环里放的就是它） */
  head: number;
  /** 主环里的描述符链 */
  descriptors: KernelVringDescriptor[];
  /** 这条链是不是"间接描述符"（只有一个描述符，指向一张表） */
  indirect: boolean;
  /** 间接表地址（`head` 的 addr）；非间接时为 null */
  indirectTableAddress: bigint | null;
  /** 间接表里的描述符（非间接时为空数组） */
  indirectDescriptors: KernelVringDescriptor[];
  /** 所有描述符的 len 之和 */
  totalLength: number;
  /** 是否检测到环（next 指回已访问过的下标） */
  cycle: boolean;
  /** 是否因为达到上限而停止 */
  truncated: boolean;
  notes: string[];
  violations: string[];
}

/** 沿 NEXT 展开链，NEXT 清零时结束；间接表单独展开，环、上限和越界分别报告。 */
export async function walkDescriptorChain(
  view: KernelMemoryView,
  layout: KernelLayout,
  vq: KernelVirtqueue,
  head: number,
  options: { limit?: number; maxIndirect?: number } = {},
): Promise<KernelDescriptorChain> {
  const limit = options.limit ?? DEFAULT_MAX_DESCRIPTORS;
  const notes: string[] = [];
  const violations: string[] = [];
  const descriptors: KernelVringDescriptor[] = [];
  const indirectDescriptors: KernelVringDescriptor[] = [];
  const seen = new Set<number>();
  let cycle = false;
  let truncated = false;

  if (vq.descAddress === 0n) {
    throw new IoParseError('desc-base-missing', '这个 virtqueue 没有描述符表基址，走不了链', {
      virtqueue: toHex(vq.address),
    });
  }

  let index = head;
  let first = true;
  let indirect = false;
  let indirectTableAddress: bigint | null = null;

  while (true) {
    if (index >= vq.num && vq.num > 0) {
      violations.push(`描述符下标 ${index} 超出环长 ${vq.num}：链上的 next 指到了环外`);
      break;
    }
    if (seen.has(index)) {
      cycle = true;
      violations.push(`描述符链回到已经走过的下标 ${index}：环上的 next 形成了环`);
      break;
    }
    seen.add(index);
    if (descriptors.length >= limit) {
      truncated = true;
      notes.push(`达到描述符链上限 ${limit} 个，停止；链上可能还有更多`);
      break;
    }
    const descriptor = await readVringDescriptor(view, layout, vq.descAddress, index);
    descriptors.push(descriptor);
    if (first && descriptor.isIndirect) {
      indirect = true;
      indirectTableAddress = descriptor.addr;
      first = false;
      break;
    }
    first = false;
    if (!descriptor.hasNext) break;
    index = descriptor.next;
  }

  let totalLength = descriptors.reduce((sum, descriptor) => sum + descriptor.len, 0);
  if (indirect && indirectTableAddress !== null) {
    const maxIndirect = options.maxIndirect ?? limit;
    const tableAddress = indirectTableAddress;
    let cursor = 0;
    const indirectSeen = new Set<number>();
    while (true) {
      if (indirectDescriptors.length >= maxIndirect) {
        truncated = true;
        notes.push(`间接表达到上限 ${maxIndirect} 个描述符，停止`);
        break;
      }
      if (indirectSeen.has(cursor)) {
        cycle = true;
        violations.push(`间接描述符表里 next 形成环（回到下标 ${cursor}）`);
        break;
      }
      indirectSeen.add(cursor);
      const descriptor = await readVringDescriptor(view, layout, tableAddress, cursor);
      indirectDescriptors.push(descriptor);
      totalLength += descriptor.len;
      if (!descriptor.hasNext) break;
      cursor = descriptor.next;
    }
    if (indirectDescriptors.length === 0) {
      violations.push('这是间接描述符，但间接表里一个描述符都没读到');
    }
    notes.push(
      `描述符 ${head} 带 INDIRECT：主环里那一个描述符本身不指向数据，`
      + `它指向 ${toHex(tableAddress)} 的间接表，表里有 ${indirectDescriptors.length} 个描述符`,
    );
  }

  return {
    head,
    descriptors,
    indirect,
    indirectTableAddress,
    indirectDescriptors,
    totalLength,
    cycle,
    truncated,
    notes,
    violations,
  };
}

/* --------------------------------------------------------------------------
 * 描述符 ↔ 请求的权威关联：desc_state
 * ------------------------------------------------------------------------ */

export interface DescriptorOwner {
  /** 描述符头下标 */
  head: number;
  /** `desc_state[head].data`：内核加进队列时的 token（virtio-blk 传的是请求私有区地址） */
  token: bigint | null;
  /** `desc_state[head].indir_desc`：间接表地址（间接描述符才有） */
  indirectDescriptor: bigint | null;
  /** 状态表项的地址 */
  address: bigint;
}

export interface DescriptorOwnerTable {
  owners: DescriptorOwner[];
  /** 有多少个槽里挂着 token */
  occupied: number;
  /** 有多少个不同的 token 值 */
  distinctTokens: number;
  notes: string[];
  evidence: EvidenceRef;
}

/** 扫描 desc_state 的 token 与间接表指针，统计占用槽及重复 token。 */
export async function readDescriptorOwners(
  view: KernelMemoryView,
  layout: KernelLayout,
  vq: KernelVirtqueue,
  options: { limit?: number } = {},
): Promise<DescriptorOwnerTable> {
  const notes: string[] = [];
  if (vq.descStateAddress === 0n) {
    notes.push('desc_state 地址为空：拿不到"描述符头 → 请求"的关联，只能靠地址推算');
    return {
      owners: [],
      occupied: 0,
      distinctTokens: 0,
      notes,
      evidence: memoryEvidence(view.evidenceSource, vq.address, 8, [`virtqueue:${toHex(vq.address)}`]),
    };
  }
  const type = layout.type(VRING_DESC_STATE_SPLIT_TYPE);
  const stride = type.byteSize ?? 16;
  const count = Math.min(vq.num, options.limit ?? vq.num);
  if (vq.num > count) notes.push(`环长 ${vq.num} 超过本次读取上限 ${count}，只读了前 ${count} 个槽`);
  const raw = await view.bytes(vq.descStateAddress, stride * count);
  const owners: DescriptorOwner[] = [];
  const tokens = new Set<string>();
  let occupied = 0;
  for (let head = 0; head < count; head += 1) {
    const base = head * stride;
    const token = littleEndianPointer(raw, base);
    const indirectDescriptor = littleEndianPointer(raw, base + 8);
    const owner: DescriptorOwner = {
      head,
      token: token === 0n ? null : token,
      indirectDescriptor: indirectDescriptor === 0n ? null : indirectDescriptor,
      address: vq.descStateAddress + BigInt(base),
    };
    owners.push(owner);
    if (owner.token !== null) {
      occupied += 1;
      tokens.add(owner.token.toString(16));
    }
  }
  return {
    owners,
    occupied,
    distinctTokens: tokens.size,
    notes,
    evidence: memoryEvidence(view.evidenceSource, vq.descStateAddress, stride * count, [
      `desc_state:${toHex(vq.descStateAddress)}`,
      `slots:${count}`,
      `occupied:${occupied}`,
    ]),
  };
}

/** 一个 token 在环上前后的定位结论。 */
export interface TokenLookup {
  token: bigint;
  /** 挂了这个 token 的描述符头下标；找不到时为空数组 */
  heads: number[];
  /** 是否唯一（恰好一个描述符头挂着这个 token） */
  unique: boolean;
  /** 无法唯一关联时的说明 */
  ambiguity: string | null;
}

/** 按 token 查描述符头；恰好一个时标 unique，空集或多候选报告歧义。 */
export function lookupToken(table: DescriptorOwnerTable, token: bigint): TokenLookup {
  const heads: number[] = [];
  for (const owner of table.owners) {
    if (owner.token !== null && owner.token === token) heads.push(owner.head);
  }
  if (heads.length === 0) {
    return {
      token,
      heads,
      unique: false,
      ambiguity:
        `环上没有任何描述符头的 token 等于 ${toHex(token)}：`
        + '这个请求要么还没被加进队列（`add_sgs` 之前的停点），要么描述符已经被回收（完成之后的停点）',
    };
  }
  if (heads.length > 1) {
    return {
      token,
      heads,
      unique: false,
      ambiguity:
        `有 ${heads.length} 个描述符头（${heads.join('、')}）的 token 都等于 ${toHex(token)}：`
        + '同一个请求被加进队列两次，或者内存被改过；无法唯一关联到一条描述符链',
    };
  }
  return { token, heads, unique: true, ambiguity: null };
}

/* --------------------------------------------------------------------------
 * 驱动私有区：virtblk_req
 * ------------------------------------------------------------------------ */

export interface KernelScatterEntry {
  index: number;
  address: bigint;
  /** page_link 原始值，低两位用于链标记 */
  pageLink: bigint;
  /** 指向的 `struct page` 地址（去掉低两位标记） */
  pageAddress: bigint | null;
  /** 这一段在这个页里的偏移 */
  offset: number;
  /** 这一段多少字节 */
  length: number;
  /** DMA 地址（映射后才有意义；未映射时读出来是 0） */
  dmaAddress: bigint;
  dmaLength: number;
}

export interface KernelVirtblkReq {
  /** `blk_mq_rq_to_pdu(rq)` 得到的地址 */
  address: bigint;
  /** `out_hdr.type` 原始值 */
  outType: number;
  outTypeSymbol: string | null;
  outTypeBarrier: boolean;
  outHdrIoprio: number;
  /** `out_hdr.sector`：设备看到的目标扇区 */
  outSector: bigint;
  /** `&in_hdr.status` */
  inHdrAddress: bigint;
  inHdrLen: number;
  /** 状态字节原始值；初值为 0，完成结论需结合 used 环证据 */
  status: number;
  statusName: string | null;
  sgNents: number;
  sgOrigNents: number;
  sgTableAddress: bigint;
  sgEntries: KernelScatterEntry[];
  notes: string[];
  violations: string[];
  evidence: EvidenceRef;
}

/** 读取 virtblk_req，状态字节按 in_hdr+in_hdr_len-1 定位，notes 保留状态初值语义。 */
export async function readVirtblkReq(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
  options: { maxSg?: number } = {},
): Promise<KernelVirtblkReq> {
  if (address === 0n) {
    throw new IoParseError('null-virtblk-req', 'virtblk_req 地址为 0', {});
  }
  const struct = await readStruct(view, layout, VIRTBLK_REQ_TYPE, address);
  const notes: string[] = [];
  const violations: string[] = [];

  const outType = struct.u32('out_hdr.type');
  const typeInfo = describeVirtioBlkType(outType);
  if (typeInfo.symbol === null) {
    violations.push(
      `out_hdr.type = ${toHex(BigInt(typeInfo.value))} 不在 VIRTIO_BLK_T_* 里：`
      + '要么私有区偏移算错了（PDU 起点不是 rq + sizeof(struct request)），要么类型被改过',
    );
  }
  if (typeInfo.barrier) {
    notes.push('out_hdr.type 带着 VIRTIO_BLK_T_BARRIER（0x80000000）：这是一个兼容位的旧写法，已剥掉再查类型');
  }

  const inHdrLen = Number(struct.value('in_hdr_len', false));
  if (inHdrLen === 0) {
    violations.push('in_hdr_len 为 0：状态字节无从定位，`virtblk_vbr_status()` 会读到私有区之外');
  }
  const inHdrAddress = struct.addressOf('in_hdr');
  let status = -1;
  if (inHdrLen > 0 && inHdrLen <= 32) {
    // `virtblk_vbr_status()`：状态在 `(u8 *)&vbr->in_hdr + in_hdr_len - 1`。
    const raw = await view.bytes(inHdrAddress + BigInt(inHdrLen - 1), 1);
    status = raw[0];
  }
  const statusName = status < 0
    ? null
    : (VIRTIO_BLK_S_NAMES.find((entry) => entry.value === status)?.name ?? null);

  const sgNents = struct.u32('sg_table.nents');
  const sgOrigNents = struct.u32('sg_table.orig_nents');
  const sgTableAddress = struct.has('sg_table.sgl') ? (struct.pointer('sg_table.sgl') ?? 0n) : 0n;
  const sgEntries: KernelScatterEntry[] = [];
  if (sgNents > 0 && sgTableAddress !== 0n) {
    const limit = Math.min(sgNents, options.maxSg ?? DEFAULT_MAX_SG);
    if (sgNents > limit) notes.push(`sg_table.nents = ${sgNents} 超过上限 ${limit}，只读了前 ${limit} 项`);
    const stride = scatterlistSize(layout);
    const raw = await view.bytes(sgTableAddress, stride * limit);
    for (let index = 0; index < limit; index += 1) {
      const base = index * stride;
      const pageLink = littleEndianPointer(raw, base);
      const offset = readU32(raw, base + 8);
      const length = readU32(raw, base + 12);
      const dmaAddress = littleEndianPointer(raw, base + 16);
      const dmaLength = readU32(raw, base + 24);
      // `scatterlist.page_link` 的最低两位是标记：bit0 = 链上还有下一个，bit1 = 这是链式 sg 表。
      const pageAddress = pageLink & ~0x3n;
      sgEntries.push({
        index,
        address: sgTableAddress + BigInt(base),
        pageLink,
        pageAddress: pageAddress === 0n ? null : pageAddress,
        offset,
        length,
        dmaAddress,
        dmaLength,
      });
      if (length === 0) notes.push(`sg[${index}] 的 length 为 0：这一段没有数据`);
    }
  } else if (sgNents === 0) {
    notes.push('sg_table.nents 为 0：这个请求不带数据段（例如 FLUSH 命令），设备只看到头与状态');
  }

  return {
    address,
    outType,
    outTypeSymbol: typeInfo.symbol,
    outTypeBarrier: typeInfo.barrier,
    outHdrIoprio: struct.u32('out_hdr.ioprio'),
    outSector: struct.u64('out_hdr.sector'),
    inHdrAddress,
    inHdrLen,
    status,
    statusName,
    sgNents,
    sgOrigNents,
    sgTableAddress,
    sgEntries,
    notes,
    violations,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${VIRTBLK_REQ_TYPE}`,
      `out_type:${toHex(BigInt(outType >>> 0))}`,
      `sector:${toHex(struct.u64('out_hdr.sector'))}`,
      `sg_nents:${sgNents}`,
    ]),
  };
}

function scatterlistSize(layout: KernelLayout): number {
  const type = layout.type(SCATTERLIST_TYPE);
  return type.byteSize ?? 32;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/* --------------------------------------------------------------------------
 * 只读的小工具（面板与验收都要用）
 * ------------------------------------------------------------------------ */

/** 描述符缓冲区间为 addr..addr+len，地址坐标系由 addressSpaceOfDescriptors 标明。 */
export function descriptorRange(descriptor: KernelVringDescriptor): { start: bigint; end: bigint } {
  return { start: descriptor.addr, end: descriptor.addr + BigInt(descriptor.len) };
}

/** avail 环里第 `slot` 个槽放的是哪个描述符头。 */
export async function readAvailRingHead(
  view: KernelMemoryView,
  layout: KernelLayout,
  vq: KernelVirtqueue,
  slot: number,
): Promise<number | null> {
  if (vq.availAddress === 0n) return null;
  const ringOffset = availRingOffset(layout);
  const raw = await view.bytes(vq.availAddress + BigInt(ringOffset + slot * 2), 2);
  return raw[0] | (raw[1] << 8);
}

/** used 环里第 `slot` 项的 `{ id, len }`。`id` 是描述符链头。 */
export async function readUsedRingElem(
  view: KernelMemoryView,
  layout: KernelLayout,
  vq: KernelVirtqueue,
  slot: number,
): Promise<{ id: number; len: number } | null> {
  if (vq.usedAddress === 0n) return null;
  const ringOffset = usedRingOffset(layout);
  const elemSize = usedElemSize(layout);
  const raw = await view.bytes(vq.usedAddress + BigInt(ringOffset + slot * elemSize), elemSize);
  return { id: readU32(raw, 0), len: readU32(raw, 4) };
}

/** avail->ring 相对偏移取自 vring_avail 的布局。 */
export function availRingOffset(layout: KernelLayout): number {
  if (layout.has(VRING_TYPE) && layout.has('vring_avail')) {
    return layout.byteOffset('vring_avail', 'ring');
  }
  return 4;
}

export function usedRingOffset(layout: KernelLayout): number {
  if (layout.has('vring_used')) {
    return layout.byteOffset('vring_used', 'ring');
  }
  return 4;
}

export function usedElemSize(layout: KernelLayout): number {
  if (layout.has('vring_used_elem')) {
    return layout.type('vring_used_elem').byteSize ?? 8;
  }
  return 8;
}

/** avail flags 中免中断位的状态。 */
export function availSuppressesInterrupt(vq: KernelVirtqueue): boolean {
  return (vq.availFlags & VRING_AVAIL_F_NO_INTERRUPT) !== 0;
}

/** `used->flags` 里的免通知位是否立着。 */
export function usedSuppressesNotify(vq: KernelVirtqueue): boolean {
  return (vq.usedFlags & VRING_USED_F_NO_NOTIFY) !== 0;
}
