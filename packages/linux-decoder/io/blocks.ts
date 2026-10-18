/** 块层位名表：具名枚举取自 KernelLayout，virtio 协议常量取自 uapi，内部位取自内核头文件。
 * 操作码、请求标志、bio 标志和描述符标志分别解码，验收按来源逐项核对。
 */

import { LayoutError } from '../dwarf/types.ts';
import type { KernelLayout } from '../layout.ts';

/** 一个"名字 ↔ 数值"条目。 */
export interface NameValue {
  name: string;
  value: number;
}

/* --------------------------------------------------------------------------
 * 操作码：从布局产物读
 * ------------------------------------------------------------------------ */

/** REQ_OP_BITS=8 来自 blk_types.h 的宏定义，低 8 位用于操作码。 */
export const REQ_OP_BITS = 8;

/** 取 `bi_opf` / `cmd_flags` 的低 8 位就是操作码。 */
export const REQ_OP_MASK = (1 << REQ_OP_BITS) - 1;

/** `REQ_FLAG_BITS = 24`：高 24 位是标志。 */
export const REQ_FLAG_BITS = 24;

/** 从布局枚举构造名字表，枚举缺失时抛错。 */
export function enumeratorsOf(layout: KernelLayout, typeName: string): NameValue[] {
  const type = layout.type(typeName);
  const out: NameValue[] = [];
  for (const entry of type.enumerators) {
    if (entry.value === null) continue;
    out.push({ name: entry.name, value: entry.value });
  }
  return out;
}

/** 查找布局枚举，缺失时返回 null。 */
export function optionalEnumeratorsOf(layout: KernelLayout, typeName: string): NameValue[] | null {
  if (!layout.has(typeName)) return null;
  const type = layout.type(typeName);
  if (type.declaration) return null;
  return enumeratorsOf(layout, typeName);
}

/** `enum req_op`：读写等操作码。 */
export function requestOpNames(layout: KernelLayout): NameValue[] {
  return enumeratorsOf(layout, 'req_op');
}

/** 一次操作码判读的结果。 */
export interface OpDecode {
  /** 操作码本身（`opf & REQ_OP_MASK`） */
  op: number;
  /** 操作码符号名，查表缺失时为 null */
  symbol: string | null;
  /** 给人看的短名，例如 `write`；判不出来时为 null */
  short: string | null;
  /** 是否要写数据到设备（`REQ_OP_*` 的最低位：1 = 写往设备） */
  writesToDevice: boolean;
  /** 操作码之外的那 24 位（交给标志解码继续看） */
  flagBits: number;
}

/** 依据 req_op 解释操作码，枚举空洞返回 symbol=null。 */
export function decodeOp(layout: KernelLayout, opf: number): OpDecode {
  const op = (opf & REQ_OP_MASK) >>> 0;
  const hit = requestOpNames(layout).find((entry) => entry.value === op) ?? null;
  return {
    op,
    symbol: hit === null ? null : hit.name,
    short: hit === null ? null : hit.name.replace(/^REQ_OP_/, '').toLowerCase(),
    // `blk_types.h` 的注释写明：操作码最低位是数据传输方向，立着表示"写到设备"。
    writesToDevice: (op & 1) === 1,
    flagBits: (opf & ~REQ_OP_MASK) >>> 0,
  };
}

/* --------------------------------------------------------------------------
 * 请求/写回标志位（`REQ_*`）：从布局产物读
 * ------------------------------------------------------------------------ */

/** 一个标志位条目。`bit` 是"第几位"，`mask` 是把它取出来的掩码。 */
export interface BitFlag {
  /** 名字，已去掉内核里的 `__` 前缀（`__REQ_RAHEAD` → `REQ_RAHEAD`） */
  name: string;
  /** 第几位 */
  bit: number;
  /** `1 << bit` */
  mask: number;
  /** 原始枚举名（`__REQ_RAHEAD`），对账用 */
  raw: string;
}

/** 请求标志位来自 req_flag_bits，过滤 __REQ_NR_BITS 计数哨兵。 */
export function requestFlagBits(layout: KernelLayout): BitFlag[] {
  const out: BitFlag[] = [];
  for (const entry of enumeratorsOf(layout, 'req_flag_bits')) {
    if (!entry.name.startsWith('__REQ_')) continue;
    if (entry.name === '__REQ_NR_BITS') continue;
    out.push({
      name: entry.name.replace(/^__REQ_/, 'REQ_'),
      bit: entry.value,
      mask: 2 ** entry.value,
      raw: entry.name,
    });
  }
  return out;
}

/** 解位掩码，同时报告表外有效位 unknown 和声明位宽之外的 beyond。 */
export interface FlagDecode {
  names: string[];
  bits: BitFlag[];
  /** 表外已置位掩码 */
  unknown: number;
  /** 这组位之外多出来的位（原始掩码） */
  beyond: number;
  /** 原始值 */
  raw: number;
}

export function decodeBitMask(raw: number, table: BitFlag[], width: number): FlagDecode {
  const value = raw >>> 0;
  const names: string[] = [];
  const bits: BitFlag[] = [];
  let covered = 0;
  for (const entry of table) {
    covered |= entry.mask;
    if ((value & entry.mask) !== 0) {
      names.push(entry.name);
      bits.push(entry);
    }
  }
  const all = width >= 32 ? 0xffffffff : (2 ** width) - 1;
  const inRange = value & all;
  return {
    names,
    bits,
    unknown: (inRange & ~covered) >>> 0,
    beyond: (value & ~all) >>> 0,
    raw: value,
  };
}

/** bi_opf 按 32 位整字解码，标志维持其实际位号并单独报告表外位。 */
export function decodeBioOpf(layout: KernelLayout, opf: number): { op: OpDecode; flags: FlagDecode } {
  const op = decodeOp(layout, opf);
  return { op, flags: decodeBitMask(op.flagBits, requestFlagBits(layout), 32) };
}

/** 是否是一次预读：`REQ_RAHEAD` 立着。 */
export function isReadahead(flags: FlagDecode): boolean {
  return flags.names.includes('REQ_RAHEAD');
}

/* --------------------------------------------------------------------------
 * bio 的标志位（`BIO_*`）：内部头文件的匿名枚举
 * ------------------------------------------------------------------------ */

/** BIO_* 位号来自 include/linux/blk_types.h 的匿名枚举，验收时逐项核对。 */
export const BIO_FLAG_BITS: BitFlag[] = [
  'BIO_PAGE_PINNED',
  'BIO_CLONED',
  'BIO_BOUNCED',
  'BIO_QUIET',
  'BIO_CHAIN',
  'BIO_REFFED',
  'BIO_BPS_THROTTLED',
  'BIO_TRACE_COMPLETION',
  'BIO_CGROUP_ACCT',
  'BIO_QOS_THROTTLED',
  'BIO_QOS_MERGED',
  'BIO_REMAPPED',
  'BIO_ZONE_WRITE_PLUGGING',
  'BIO_EMULATES_ZONE_APPEND',
].map((name, bit) => ({ name, bit, mask: 2 ** bit, raw: name }));

/** `BIO_FLAG_LAST`：这个匿名枚举的哨兵值，等于真实标志位的个数。 */
export const BIO_FLAG_COUNT = BIO_FLAG_BITS.length;

/* BLK_STS_* 完成状态：来自内核头文件宏定义。 */

/** BLK_STS_* 来自 include/linux/blk_types.h，blk_status_t 在 DWARF 中是 1 字节 typedef。 */
export const BLK_STATUS_NAMES: NameValue[] = [
  { name: 'BLK_STS_OK', value: 0 },
  { name: 'BLK_STS_NOTSUPP', value: 1 },
  { name: 'BLK_STS_TIMEOUT', value: 2 },
  { name: 'BLK_STS_NOSPC', value: 3 },
  { name: 'BLK_STS_TRANSPORT', value: 4 },
  { name: 'BLK_STS_TARGET', value: 5 },
  { name: 'BLK_STS_RESV_CONFLICT', value: 6 },
  { name: 'BLK_STS_MEDIUM', value: 7 },
  { name: 'BLK_STS_PROTECTION', value: 8 },
  { name: 'BLK_STS_RESOURCE', value: 9 },
  { name: 'BLK_STS_IOERR', value: 10 },
  { name: 'BLK_STS_DM_REQUEUE', value: 11 },
  { name: 'BLK_STS_AGAIN', value: 12 },
  { name: 'BLK_STS_DEV_RESOURCE', value: 13 },
  { name: 'BLK_STS_ZONE_OPEN_RESOURCE', value: 14 },
  { name: 'BLK_STS_ZONE_ACTIVE_RESOURCE', value: 15 },
  { name: 'BLK_STS_OFFLINE', value: 16 },
  { name: 'BLK_STS_DURATION_LIMIT', value: 17 },
  { name: 'BLK_STS_INVAL', value: 19 },
];

/** 查找 BLK_STS_* 名称，查表缺失时返回 null。 */
export function blkStatusName(value: number): string | null {
  return BLK_STATUS_NAMES.find((entry) => entry.value === value)?.name ?? null;
}

/* --------------------------------------------------------------------------
 * 请求的处理阶段（`MQ_RQ_*`）：从布局产物读
 * ------------------------------------------------------------------------ */

/**
 * `enum mq_rq_state`：请求在 blk-mq 里处于哪一步。
 *
 * 这个枚举在 DWARF 里有名字，所以从产物读。它是 T07f"请求 ID 与生命周期"里
 * "生命周期"那部分的主干：`IDLE` 是"这个槽位空闲"，`IN_FLIGHT` 是"已经交给驱动、
 * 等设备回话"，`COMPLETE` 是"设备已经回话、块层在收尾"。
 */
export function mqRqStates(layout: KernelLayout): NameValue[] {
  return enumeratorsOf(layout, 'mq_rq_state');
}

export function mqRqStateName(layout: KernelLayout, state: number): string | null {
  const hit = mqRqStates(layout).find((entry) => entry.value === state) ?? null;
  return hit === null ? null : hit.name;
}

/* --------------------------------------------------------------------------
 * 请求标志位（`RQF_*`）：内部头文件的匿名枚举
 * ------------------------------------------------------------------------ */

/** RQF_* 来自 include/linux/blk-mq.h 的匿名枚举，表达块层内部处理状态。 */
export const RQ_FLAG_BITS: BitFlag[] = [
  'RQF_STARTED',
  'RQF_FLUSH_SEQ',
  'RQF_MIXED_MERGE',
  'RQF_DONTPREP',
  'RQF_SCHED_TAGS',
  'RQF_USE_SCHED',
  'RQF_FAILED',
  'RQF_QUIET',
  'RQF_IO_STAT',
  'RQF_PM',
  'RQF_HASHED',
  'RQF_STATS',
  'RQF_SPECIAL_PAYLOAD',
  'RQF_ZONE_WRITE_PLUGGING',
  'RQF_TIMED_OUT',
  'RQF_RESV',
].map((name, bit) => ({ name, bit, mask: 2 ** bit, raw: name }));

/** `__RQF_BITS`：真实标志位的个数。 */
export const RQ_FLAG_COUNT = RQ_FLAG_BITS.length;

/* --------------------------------------------------------------------------
 * virtio-blk 请求类型与状态：uapi 协议常量
 * ------------------------------------------------------------------------ */

/** virtio-blk 请求类型取自 include/uapi/linux/virtio_blk.h：IN 对应读盘，OUT 对应写盘。 */
export const VIRTIO_BLK_T = {
  IN: 0,
  OUT: 1,
  SCSI_CMD: 2,
  FLUSH: 4,
  GET_ID: 8,
  DISCARD: 11,
  WRITE_ZEROES: 13,
  SECURE_ERASE: 14,
  ZONE_APPEND: 15,
  ZONE_REPORT: 16,
  ZONE_OPEN: 18,
  ZONE_CLOSE: 20,
  ZONE_FINISH: 22,
  ZONE_RESET: 24,
  ZONE_RESET_ALL: 26,
  /** VIRTIO_BLK_T_BARRIER=0x80000000，作为与请求类型按位或的兼容标志。 */
  BARRIER: 0x80000000,
} as const;

/** 请求类型名字表；BARRIER 标志单独解释。 */
export const VIRTIO_BLK_T_NAMES: NameValue[] = [
  { name: 'VIRTIO_BLK_T_IN', value: VIRTIO_BLK_T.IN },
  { name: 'VIRTIO_BLK_T_OUT', value: VIRTIO_BLK_T.OUT },
  { name: 'VIRTIO_BLK_T_SCSI_CMD', value: VIRTIO_BLK_T.SCSI_CMD },
  { name: 'VIRTIO_BLK_T_FLUSH', value: VIRTIO_BLK_T.FLUSH },
  { name: 'VIRTIO_BLK_T_GET_ID', value: VIRTIO_BLK_T.GET_ID },
  { name: 'VIRTIO_BLK_T_DISCARD', value: VIRTIO_BLK_T.DISCARD },
  { name: 'VIRTIO_BLK_T_WRITE_ZEROES', value: VIRTIO_BLK_T.WRITE_ZEROES },
  { name: 'VIRTIO_BLK_T_SECURE_ERASE', value: VIRTIO_BLK_T.SECURE_ERASE },
  { name: 'VIRTIO_BLK_T_ZONE_APPEND', value: VIRTIO_BLK_T.ZONE_APPEND },
  { name: 'VIRTIO_BLK_T_ZONE_REPORT', value: VIRTIO_BLK_T.ZONE_REPORT },
  { name: 'VIRTIO_BLK_T_ZONE_OPEN', value: VIRTIO_BLK_T.ZONE_OPEN },
  { name: 'VIRTIO_BLK_T_ZONE_CLOSE', value: VIRTIO_BLK_T.ZONE_CLOSE },
  { name: 'VIRTIO_BLK_T_ZONE_FINISH', value: VIRTIO_BLK_T.ZONE_FINISH },
  { name: 'VIRTIO_BLK_T_ZONE_RESET', value: VIRTIO_BLK_T.ZONE_RESET },
  { name: 'VIRTIO_BLK_T_ZONE_RESET_ALL', value: VIRTIO_BLK_T.ZONE_RESET_ALL },
];

/** 剥离 BARRIER 标志后查请求类型。 */
export function describeVirtioBlkType(type: number): { raw: number; value: number; symbol: string | null; barrier: boolean } {
  const raw = type >>> 0;
  const barrier = (raw & VIRTIO_BLK_T.BARRIER) !== 0;
  const value = (raw & ~VIRTIO_BLK_T.BARRIER) >>> 0;
  const hit = VIRTIO_BLK_T_NAMES.find((entry) => entry.value === value) ?? null;
  return { raw, value, symbol: hit === null ? null : hit.name, barrier };
}

/** `struct virtblk_req.in_hdr.status` 的取值。 */
export const VIRTIO_BLK_S = {
  OK: 0,
  IOERR: 1,
  UNSUPP: 2,
} as const;

export const VIRTIO_BLK_S_NAMES: NameValue[] = [
  { name: 'VIRTIO_BLK_S_OK', value: VIRTIO_BLK_S.OK },
  { name: 'VIRTIO_BLK_S_IOERR', value: VIRTIO_BLK_S.IOERR },
  { name: 'VIRTIO_BLK_S_UNSUPP', value: VIRTIO_BLK_S.UNSUPP },
];

/* --------------------------------------------------------------------------
 * split ring 的描述符标志：uapi 协议常量
 * ------------------------------------------------------------------------ */

/** 描述符标志取自 virtio_ring.h；INDIRECT 表示 addr 指向描述符表。 */
export const VRING_DESC_F = {
  NEXT: 1,
  WRITE: 2,
  INDIRECT: 4,
} as const;

export const VRING_DESC_F_NAMES: NameValue[] = [
  { name: 'VRING_DESC_F_NEXT', value: VRING_DESC_F.NEXT },
  { name: 'VRING_DESC_F_WRITE', value: VRING_DESC_F.WRITE },
  { name: 'VRING_DESC_F_INDIRECT', value: VRING_DESC_F.INDIRECT },
];

export const VRING_AVAIL_F_NO_INTERRUPT = 1;
export const VRING_USED_F_NO_NOTIFY = 1;

/** 解释 `vring_desc.flags` 那 16 位（只用了低 3 位，其余必须报出来）。 */
export function describeVringDescFlags(flags: number): { names: string[]; unknown: number; raw: number } {
  const raw = flags & 0xffff;
  const names: string[] = [];
  let covered = 0;
  for (const entry of VRING_DESC_F_NAMES) {
    covered |= entry.value;
    if ((raw & entry.value) !== 0) names.push(entry.name);
  }
  return { names, unknown: raw & ~covered, raw };
}

/* --------------------------------------------------------------------------
 * 结构性常量
 * ------------------------------------------------------------------------ */

/** `virtio_blk` 的硬件队列个数上限：`struct virtio_blk.io_queues[3]`（read/write/other 三类）。 */
export const VIRTIO_BLK_MAX_IO_QUEUES = 3;

/** 从布局读取 struct request 宽度，用于 rq+sizeof(struct request) 的 PDU 寻址。 */
export function structRequestSizeOf(layout: KernelLayout): number {
  const type = layout.type('request');
  if (type.byteSize === null) {
    throw new LayoutError('布局清单里 struct request 的大小未知，算不出 PDU 相对请求的偏移', {
      typeName: 'request',
    });
  }
  return type.byteSize;
}

/** 累加字节数（sector 用 512 字节为单位，`bio`/`request` 里的都是）。 */
export const SECTOR_SHIFT = 9;
export const SECTOR_SIZE = 512;
