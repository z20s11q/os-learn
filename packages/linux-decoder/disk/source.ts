/**
 * 盘面字节来源（T07e）。
 *
 * 与内存侧同一套思路：解析器只接受一个**只读的字节通道**，不自己打开镜像、不碰 QEMU/QMP、
 * 不调用客体函数。离线镜像文件、活体会话的逻辑扇区版本、单测里的合成镜像，
 * 都实现同一个接口 —— 于是"同一份 ext2 解析逻辑跑在三种来源上"这件事是类型系统保证的，
 * 而不是靠三份各自实现的解析代码。
 *
 * 为什么盘面不直接读宿主文件就完事：T06 的磁盘版本表表达的是"基线镜像 + 已对客体可见的写"，
 * 宿主文件在会话运行期间**不是**客体的逻辑盘面（可能只写了一半）。所以来源接口刻意带
 * `versionId`：读到的每个字节都归属某个明确的版本，历史帧不会悄悄拿到当前值。
 */

import type { EvidenceRef } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';

/** 一个扇区 512 字节；盘面地址换算与 LBA 都以此为单位（磁盘课要显示的也是这个 LBA）。 */
export const SECTOR_SIZE = 512;

export class DiskReadError extends Error {
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DiskReadError';
    this.code = code;
    this.detail = detail;
  }

  code: string;

  detail: Record<string, unknown>;
}

/**
 * 一块可读的盘面。
 *
 * `byteLength` 是**镜像字节数**，不是"文件系统占用的字节数"：ext2 的 `s_blocks_count`
 * 只算到文件系统末尾，两者可以不同（镜像可以比文件系统大）。所以取上界时要用这个值，
 * 而不是从超级块推出来的值 —— 超级块是盘上的数据，它是被校验的对象，不能拿来当护栏。
 */
export interface DiskByteSource {
  readonly diskId: string;
  readonly versionId: string | null;
  readonly byteLength: bigint;
  read(byteOffset: bigint, length: number): Promise<Uint8Array>;
}

/** 构造一条指向某段盘面字节的证据引用。 */
export function diskEvidence(
  source: DiskByteSource,
  byteOffset: bigint,
  length: number,
  extra: string[] = [],
): EvidenceRef {
  const refs = [`disk:${source.diskId}`, `offset:${toHex(byteOffset)}:${length}`, ...extra];
  return {
    kind: 'decoded',
    source: 'disk',
    ...(source.versionId === null ? {} : { captureId: source.versionId }),
    refs,
  };
}

/** 字节偏移 → LBA（512 字节扇区）。盘上一切都以 LBA 表达，换算只此一处。 */
export function lbaForByteOffset(byteOffset: bigint): bigint {
  if (byteOffset < 0n) throw new DiskReadError('negative-offset', `盘面偏移不能为负：${byteOffset}`);
  return byteOffset / BigInt(SECTOR_SIZE);
}

/** 块号 → LBA。`partitionStartLba` 留给"盘上有分区表、文件系统从第几个扇区开始"的情形。 */
export function lbaForBlock(blockNumber: bigint, blockSize: number, partitionStartLba = 0n): bigint {
  const sectorsPerBlock = BigInt(blockSize) / BigInt(SECTOR_SIZE);
  if (BigInt(blockSize) % BigInt(SECTOR_SIZE) !== 0n) {
    throw new DiskReadError('block-size-not-sector-multiple', `块大小 ${blockSize} 不是 512 的整数倍，算不出 LBA`);
  }
  return partitionStartLba + blockNumber * sectorsPerBlock;
}

/** 块号 → 盘面字节偏移。 */
export function byteOffsetForBlock(blockNumber: bigint, blockSize: number, partitionStartByte = 0n): bigint {
  return partitionStartByte + blockNumber * BigInt(blockSize);
}

/**
 * 带读取记录的内存镜像，供单测与离线小镜像使用。
 *
 * 记录每次读取的 `{ byteOffset, length }`（`reads`），这样单测可以断言
 * "只读了该读的那几个块"，而不是把整张镜像扫一遍 —— 大镜像上这一点很关键。
 */
export class BufferDiskSource implements DiskByteSource {
  private readonly buffer: Uint8Array;

  readonly diskId: string;

  readonly versionId: string | null;

  readonly reads: Array<{ byteOffset: bigint; length: number }> = [];

  /** 让某些范围读不到，用于测试"镜像被截断"这类降级路径。 */
  readonly forbidden: Array<{ byteOffset: bigint; length: number }> = [];

  constructor(options: { bytes?: Uint8Array; size?: number; diskId?: string; versionId?: string | null } = {}) {
    const size = options.size ?? options.bytes?.length ?? 0;
    this.buffer = options.bytes ?? new Uint8Array(size);
    this.diskId = options.diskId ?? 'unit-test-disk';
    this.versionId = options.versionId ?? null;
  }

  get byteLength(): bigint {
    return BigInt(this.buffer.length);
  }

  get bytes(): Uint8Array {
    return this.buffer;
  }

  async read(byteOffset: bigint, length: number): Promise<Uint8Array> {
    if (byteOffset < 0n) {
      throw new DiskReadError('negative-offset', `盘面偏移不能为负：${byteOffset}`, {
        byteOffset: byteOffset.toString(),
      });
    }
    const start = Number(byteOffset);
    if (start + length > this.buffer.length) {
      throw new DiskReadError(
        'range-not-captured',
        `盘面读取超出镜像范围：偏移 ${toHex(byteOffset)} 长度 ${length}，镜像只有 ${this.buffer.length} 字节`,
        { byteOffset: toHex(byteOffset), length, byteLength: this.buffer.length },
      );
    }
    this.reads.push({ byteOffset, length });
    for (const blocked of this.forbidden) {
      if (byteOffset < blocked.byteOffset + BigInt(blocked.length)
        && blocked.byteOffset < byteOffset + BigInt(length)) {
        throw new DiskReadError('forbidden', `测试桩禁止读取盘面 ${toHex(byteOffset)}`, {
          byteOffset: toHex(byteOffset),
        });
      }
    }
    return this.buffer.subarray(start, start + length);
  }
}

/** 读一个小端 u16 / u32（不依赖对齐，盘上字段不一定对齐）。 */
export function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readU32(bytes: Uint8Array, offset: number): bigint {
  return BigInt(bytes[offset])
    | (BigInt(bytes[offset + 1]) << 8n)
    | (BigInt(bytes[offset + 2]) << 16n)
    | (BigInt(bytes[offset + 3]) << 24n);
}

/** 读一个 C 字符串（以 0 结尾，或占满整个字段）。 */
export function readCString(bytes: Uint8Array, offset: number, width: number): string {
  const end = bytes.indexOf(0, offset);
  const stop = end === -1 || end > offset + width ? offset + width : end;
  return Buffer.from(bytes.subarray(offset, stop)).toString('utf8');
}

/** 把 16 字节 UUID 打成 ext2 惯用的 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`。 */
export function formatUuid(bytes: Uint8Array, offset: number): string {
  const hex = Buffer.from(bytes.subarray(offset, offset + 16)).toString('hex');
  if (hex.length !== 32) return hex;
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}
