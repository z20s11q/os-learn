/**
 * `struct gendisk` 的读取（T07f）。
 *
 * 单独一个文件，是因为它在这条链上的位置有点特殊：它是"**块设备**"这一侧的代表，
 * 而 virtio-blk 的队列是从 `request_queue.queuedata` 找过去的。两者都会指向同一个
 * `struct virtio_blk`，但那是**这个内核的实现选择**，不是通用规律：
 * `gendisk.private_data` 的类型完全由驱动决定（SCSI 放的是 `scsi_disk`、
 * loop 放的是 `loop_device` 之类）。所以这里只负责把字段如实读出来，
 * "它到底是不是 virtio_blk"留给 `associate.ts` 去对账，并在对不上时说清楚。
 *
 * `disk_name` 是这一层最有用的一个字段：面板上要多显示一句"这次 I/O 打到哪块盘"，
 * 只有它能给出人看得懂的名字（`vda`）。
 */

import { memoryEvidence } from '../capture.ts';
import type { KernelMemoryView } from '../capture.ts';
import type { KernelLayout } from '../layout.ts';
import type { EvidenceRef } from '../../contracts/common.ts';
import { toHex } from '../../contracts/common.ts';
import { readStruct } from '../objects/task.ts';
import { IoParseError } from './objects.ts';

export const GENDISK_TYPE = 'gendisk';

export interface KernelGendisk {
  address: bigint;
  major: number;
  firstMinor: number;
  minors: number;
  /** `disk_name`：例如 `vda`。设备节点名字的唯一来源 */
  diskName: string;
  /** `disk_name` 读满 32 字节还没有结尾 0（数组是 `char[32]`） */
  diskNameTruncated: boolean;
  /** `part0`：整盘对应的 `struct block_device` */
  part0: bigint | null;
  fops: bigint | null;
  /** `queue`：这块盘的请求队列 */
  queue: bigint | null;
  /** `private_data`：驱动私有数据（virtio-blk 下指向 `struct virtio_blk`） */
  privateData: bigint | null;
  flags: number;
  state: bigint;
  openPartitions: number;
  /** diskseq：设备分配序号，用于核对盘实例身份 */
  diskseq: bigint;
  nodeId: number;
  openMode: number;
  notes: string[];
  evidence: EvidenceRef;
}

/** 读一个 `struct gendisk`。 */
export async function readGendisk(
  view: KernelMemoryView,
  layout: KernelLayout,
  address: bigint,
): Promise<KernelGendisk> {
  if (address === 0n) {
    throw new IoParseError('null-gendisk', 'struct gendisk 地址为 0', {});
  }
  const struct = await readStruct(view, layout, GENDISK_TYPE, address);
  const notes: string[] = [];
  const name = struct.cstring('disk_name');
  if (name.truncated) {
    notes.push('disk_name 读满 32 字节还没有结尾 0：名字数组被写坏了，截断显示');
  }
  if (name.text.length === 0) {
    notes.push('disk_name 是空串：这块盘还没被登记名字（`add_disk()` 之前的停点会这样）');
  }
  const minors = struct.u32('minors');
  if (minors !== 0 && (minors & (minors - 1)) !== 0) {
    notes.push(`minors = ${minors} 不是 2 的幂：分区号到次设备号的换算依赖它是 2 的幂`);
  }
  const queue = struct.has('queue') ? struct.pointer('queue') : null;
  if (queue === null) {
    notes.push('disk->queue 为空：这块盘没有请求队列（`del_gendisk()` 之后会这样）');
  }
  return {
    address,
    major: struct.u32('major'),
    firstMinor: struct.u32('first_minor'),
    minors,
    diskName: name.text,
    diskNameTruncated: name.truncated,
    part0: struct.has('part0') ? struct.pointer('part0') : null,
    fops: struct.has('fops') ? struct.pointer('fops') : null,
    queue,
    privateData: struct.has('private_data') ? struct.pointer('private_data') : null,
    flags: struct.has('flags') ? Number(struct.value('flags', true)) : 0,
    state: struct.has('state') ? struct.u64('state') : 0n,
    openPartitions: struct.has('open_partitions') ? struct.u32('open_partitions') : 0,
    diskseq: struct.has('diskseq') ? struct.u64('diskseq') : 0n,
    nodeId: struct.has('node_id') ? Number(struct.value('node_id', true)) : -1,
    openMode: struct.has('open_mode') ? struct.u32('open_mode') : 0,
    notes,
    evidence: memoryEvidence(view.evidenceSource, address, struct.bytes.length, [
      `type:${GENDISK_TYPE}`,
      `disk_name:${name.text}`,
      `major:${struct.u32('major')}`,
      `queue:${queue === null ? 'null' : toHex(queue)}`,
    ]),
  };
}
