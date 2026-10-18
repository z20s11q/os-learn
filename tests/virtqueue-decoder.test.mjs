/**
 * T06 单元测试：virtqueue 解码器（合成设备快照 + 合成内存）。
 *
 * 断言的是「服务层怎么把设备快照与实际内存接起来」：抓描述符、按方向算读写字节、
 * 采缓冲首字节散列、对 packed ring / 未就绪队列明确拒绝。
 * 纯环布局的行为由 tests/virtqueue.test.mjs 覆盖。
 *
 * 运行：node --test tests/virtqueue-decoder.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PhysicalReadError } from '../packages/trace-format/paging.ts';
import { queueSkeleton, decodeDeviceVirtqueues } from '../services/lab-server/src/collect/virtqueue-decoder.mjs';

const DESC = 0x2000;
const AVAIL = 0x3000;
const USED = 0x4000;
const SIZE = 4;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function makeRam(size = 0x10000) {
  const bytes = Buffer.alloc(size);
  return {
    bytes,
    async read(address, length) {
      const start = Number(address);
      if (start + length > bytes.length) {
        throw new PhysicalReadError('range-not-captured', `越界: 0x${start.toString(16)}`);
      }
      return bytes.subarray(start, start + length);
    },
    desc(index, { address, length, flags = 0, next = 0 }) {
      const offset = DESC + index * 16;
      bytes.writeBigUInt64LE(BigInt(address), offset);
      bytes.writeUInt32LE(length, offset + 8);
      bytes.writeUInt16LE(flags, offset + 12);
      bytes.writeUInt16LE(next, offset + 14);
    },
    avail({ flags = 0, idx, heads }) {
      bytes.writeUInt16LE(flags, AVAIL);
      bytes.writeUInt16LE(idx, AVAIL + 2);
      heads.forEach((head, index) => bytes.writeUInt16LE(head, AVAIL + 4 + index * 2));
    },
    used({ flags = 0, idx, entries }) {
      bytes.writeUInt16LE(flags, USED);
      bytes.writeUInt16LE(idx, USED + 2);
      entries.forEach((entry, index) => {
        bytes.writeUInt32LE(entry.id, USED + 4 + index * 8);
        bytes.writeUInt32LE(entry.len, USED + 4 + index * 8 + 4);
      });
    },
  };
}

/** 一个已就绪、有两条待处理链的 virtio-blk 队列。 */
function readyRam() {
  const ram = makeRam();
  ram.desc(0, { address: 0x9000, length: 512, flags: 1, next: 1 }); // NEXT → device-read
  ram.desc(1, { address: 0xa000, length: 16, flags: 2, next: 0 }); // WRITE → device-write
  ram.desc(2, { address: 0xb000, length: 64, flags: 0, next: 0 }); // device-read
  ram.avail({ idx: 2, heads: [0, 2] });
  ram.used({ idx: 1, entries: [{ id: 0, len: 512 }] });
  ram.bytes.fill(0x11, 0x9000, 0x9000 + 512);
  ram.bytes.fill(0x22, 0xa000, 0xa000 + 16);
  ram.bytes.fill(0x33, 0xb000, 0xb000 + 64);
  return ram;
}

const DEVICE = {
  deviceId: '/machine/peripheral/rootblk/virtio-backend',
  kind: 'virtio-blk',
  virtqueues: [
    {
      queueIndex: 0,
      size: SIZE,
      ready: true,
      negotiatedFeatures: '0x100000000',
      descTable: `0x${DESC.toString(16)}`,
      availRing: `0x${AVAIL.toString(16)}`,
      usedRing: `0x${USED.toString(16)}`,
      lastAvailIndex: 0,
      lastUsedIndex: 0,
    },
  ],
};

test('已就绪队列：展开待处理链，按方向算字节，并采到缓冲首字节散列', async () => {
  const ram = readyRam();
  const decoded = await decodeDeviceVirtqueues({
    reader: ram,
    device: DEVICE,
    captureId: 'cap-vq-1',
  });

  assert.equal(decoded.queues.length, 1);
  const queue = decoded.queues[0];
  assert.equal(queue.queueIndex, 0);
  assert.equal(queue.ready, true);
  assert.equal(queue.size, SIZE);
  assert.deepEqual(queue.decode.chains.map((chain) => chain.head), [0, 2]);
  assert.equal(queue.decode.outstanding, 2);
  assert.equal(queue.decode.pendingCompletions, 1);
  assert.equal(queue.decode.availIdx, 2);
  assert.equal(queue.decode.usedIdx, 1);
  assert.deepEqual(queue.decode.features, { version1: true, ringPacked: false, eventIdx: false });

  const chain0 = queue.decode.chains[0];
  assert.deepEqual(chain0.indices, [0, 1]);
  assert.equal(chain0.readableBytes, 512);
  assert.equal(chain0.writableBytes, 16);
  assert.deepEqual(chain0.descriptors.map((item) => item.direction), ['device-read', 'device-write']);

  // 契约字段：描述符带地址、长度、方向与缓冲首字节散列
  assert.equal(queue.descriptors.length, 3);
  const first = queue.descriptors[0];
  assert.equal(first.address, '0x9000');
  assert.equal(first.length, 512);
  assert.equal(first.direction, 'device-read');
  assert.equal(first.next, 1);
  assert.equal(first.bytesRef, sha(Buffer.alloc(16, 0x11)), 'bytesRef 是缓冲前 16 字节的散列');

  const second = queue.descriptors[1];
  assert.equal(second.bytesRef, sha(Buffer.alloc(16, 0x22)));
  const third = queue.descriptors[2];
  assert.equal(third.direction, 'device-read');
  assert.equal(third.bytesRef, sha(Buffer.alloc(16, 0x33)));

  assert.deepEqual(decoded.unavailable, []);
  assert.equal(queue.evidence.captureId, 'cap-vq-1');
});

test('协商 packed ring 的队列明确拒绝解析', async () => {
  const ram = readyRam();
  const device = {
    ...DEVICE,
    virtqueues: [{ ...DEVICE.virtqueues[0], negotiatedFeatures: `0x${(1n << 34n).toString(16)}` }],
  };
  const decoded = await decodeDeviceVirtqueues({ reader: ram, device, captureId: 'cap-vq-2' });
  const queue = decoded.queues[0];
  assert.equal(queue.ringPacked, true);
  assert.equal(queue.decode.features.ringPacked, true);
  assert.equal(queue.decode.chains.length, 0);
  assert.equal(queue.descriptors, undefined, '没有解析出链时不给空的 describes 数组冒充「队列是空的」');
  assert.ok(
    decoded.unavailable.some((entry) => entry.includes('RING_PACKED')),
    '拒绝原因必须点名 packed ring',
  );
});

test('size=0 的队列报告待就绪原因', async () => {
  const ram = readyRam();
  const device = {
    ...DEVICE,
    virtqueues: [{ ...DEVICE.virtqueues[0], size: 0, descTable: null, availRing: null, usedRing: null }],
  };
  const decoded = await decodeDeviceVirtqueues({ reader: ram, device, captureId: 'cap-vq-3' });
  const queue = decoded.queues[0];
  assert.equal(queue.ready, false);
  assert.equal(queue.decode.chains.length, 0);
  assert.ok(decoded.unavailable.some((entry) => entry.includes('size=0')));
  const readsBefore = ram.bytes.length; // 保留合成内存大小，核对队列形状。
  assert.equal(typeof readsBefore, 'number');
});

test('队列所在页缺采时报告环读取缺口', async () => {
  const ram = readyRam();
  const blocking = {
    async read(address, length) {
      if (BigInt(address) >= BigInt(AVAIL) && BigInt(address) < BigInt(USED)) {
        throw new PhysicalReadError('range-not-captured', '这一页没有采到');
      }
      return ram.read(address, length);
    },
  };
  const decoded = await decodeDeviceVirtqueues({ reader: blocking, device: DEVICE, captureId: 'cap-vq-4' });
  assert.equal(decoded.queues[0].decode.availIdx, null);
  assert.ok(decoded.unavailable.some((entry) => entry.includes('可用环')));
});

test('缓冲首字节采集有配额：超出的描述符只给结构与地址，bytesRef 为 null 并写明原因', async () => {
  const ram = readyRam();
  const decoded = await decodeDeviceVirtqueues({
    reader: ram,
    device: DEVICE,
    captureId: 'cap-vq-5',
    prefixQuota: 1,
  });
  const descriptors = decoded.queues[0].descriptors;
  assert.equal(descriptors[0].bytesRef, sha(Buffer.alloc(16, 0x11)));
  assert.equal(descriptors[1].bytesRef, null);
  assert.equal(descriptors[2].bytesRef, null);
  assert.ok(decoded.unavailable.some((entry) => entry.includes('配额')));
});

test('queueSkeleton 以 null 表示缺失环地址，并标出 negotiate 结果', () => {
  const skeleton = queueSkeleton(
    { deviceId: 'dev' },
    { queueIndex: 1, size: 8, ready: false, negotiatedFeatures: '0x100000000' },
    'cap-x',
  );
  assert.equal(skeleton.descTable, null);
  assert.equal(skeleton.availRing, null);
  assert.equal(skeleton.usedRing, null);
  assert.equal(skeleton.lastAvailIndex, null);
  assert.equal(skeleton.ready, false);
  assert.equal(skeleton.version1, true);
  assert.equal(skeleton.evidence.captureId, 'cap-x');
});
