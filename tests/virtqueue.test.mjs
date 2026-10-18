/**
 * T06 单元测试：virtio split 队列解码（纯字节）。
 *
 * 环和描述符都是这里手工搭出来的合成内存；真实客体上的对照在
 * scripts/verify-t06.mjs（服务队列与设备快照字段对照）。
 *
 * 运行：node --test tests/virtqueue.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PhysicalReadError } from '../packages/trace-format/paging.ts';
import {
  DESCRIPTOR_SIZE,
  decodeVirtqueue,
  layoutFromSnapshot,
  reportVirtioFeatures,
  ringDistance,
} from '../packages/trace-format/virtqueue.ts';

const DESC = 0x2000n;
const AVAIL = 0x3000n;
const USED = 0x4000n;
const SIZE = 4;

function makeRam(bytes = 0x10000) {
  const ram = Buffer.alloc(bytes);
  const calls = [];
  return {
    ram,
    calls,
    async read(address, length) {
      calls.push({ address, length });
      const start = Number(address);
      if (start + length > ram.length) {
        throw new PhysicalReadError('range-not-captured', `不在范围内: 0x${start.toString(16)}`);
      }
      return ram.subarray(start, start + length);
    },
    descriptor(index, { address, length, flags, next = 0 }) {
      const offset = Number(DESC) + index * DESCRIPTOR_SIZE;
      ram.writeBigUInt64LE(BigInt(address), offset);
      ram.writeUInt32LE(length, offset + 8);
      ram.writeUInt16LE(flags, offset + 12);
      ram.writeUInt16LE(next, offset + 14);
    },
    avail({ flags = 0, idx, heads = [], usedEvent }) {
      ram.writeUInt16LE(flags, Number(AVAIL));
      ram.writeUInt16LE(idx, Number(AVAIL) + 2);
      heads.forEach((head, index) => ram.writeUInt16LE(head, Number(AVAIL) + 4 + index * 2));
      if (usedEvent !== undefined) {
        ram.writeUInt16LE(usedEvent, Number(AVAIL) + 4 + SIZE * 2);
      }
    },
    used({ flags = 0, idx, entries = [], availEvent }) {
      ram.writeUInt16LE(flags, Number(USED));
      ram.writeUInt16LE(idx, Number(USED) + 2);
      entries.forEach((entry, index) => {
        ram.writeUInt32LE(entry.id, Number(USED) + 4 + index * 8);
        ram.writeUInt32LE(entry.len, Number(USED) + 4 + index * 8 + 4);
      });
      if (availEvent !== undefined) {
        ram.writeUInt16LE(availEvent, Number(USED) + 4 + SIZE * 8);
      }
    },
  };
}

function layout(overrides = {}) {
  return {
    queueIndex: 0,
    size: SIZE,
    descTable: DESC,
    availRing: AVAIL,
    usedRing: USED,
    lastAvailIndex: 0,
    lastUsedIndex: 0,
    negotiatedFeatures: 1n << 32n,
    ...overrides,
  };
}

const ATTRIBUTION = { captureId: 'cap-vq-7' };

function fixture() {
  const ram = makeRam();
  ram.descriptor(0, { address: 0x8000, length: 512, flags: 1, next: 1 }); // NEXT，guest→device
  ram.descriptor(1, { address: 0x9000, length: 16, flags: 2 }); // WRITE，device→guest
  ram.descriptor(2, { address: 0xa000, length: 8, flags: 0 });
  ram.descriptor(3, { address: 0xb000, length: 4, flags: 2 });
  ram.avail({ idx: 2, heads: [0, 2, 0, 0] });
  ram.used({ idx: 3, entries: [{ id: 0, len: 16 }, { id: 2, len: 8 }, { id: 1, len: 32 }] });
  return ram;
}

test('ringDistance 按 16 位回绕做差', () => {
  assert.equal(ringDistance(0, 2), 2);
  assert.equal(ringDistance(0xfffe, 1), 3);
  assert.equal(ringDistance(3, 3), 0);
});

test('split 环：展开未消费的链，方向/长度与已用环完成项都按字节解释', async () => {
  const ram = fixture();
  const result = await decodeVirtqueue(ram, layout({ lastUsedIndex: 1 }), ATTRIBUTION);
  assert.equal(result.ready, true);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.outstanding, 2);
  assert.deepEqual(result.chains.map((chain) => chain.head), [0, 2]);
  assert.deepEqual(result.chains[0].indices, [0, 1]);
  assert.equal(result.chains[0].readableBytes, 512);
  assert.equal(result.chains[0].writableBytes, 16);
  assert.equal(result.chains[0].indirect, false);
  assert.equal(result.chains[0].descriptors[0].direction, 'device-read');
  assert.equal(result.chains[0].descriptors[1].direction, 'device-write');
  assert.equal(result.chains[0].descriptors[0].bytesRef, null);
  assert.equal(result.descriptors.length, 3);
  assert.equal(result.avail.idx, 2);
  assert.deepEqual(result.avail.heads, [0, 2, 0, 0]);
  assert.deepEqual(result.used.entries.slice(0, 3), [{ id: 0, len: 16 }, { id: 2, len: 8 }, { id: 1, len: 32 }]);
  assert.equal(result.pendingCompletions, 2);
  assert.equal(result.evidence.captureId, 'cap-vq-7');
  assert.equal(result.evidence.refs[0], 'virtqueue:0');
  assert.equal(result.layout.features.version1, true);
});

test('EVENT_IDX 决定环末尾事件字段的读取：关闭时为 null，开启时取值', async () => {
  const ram = fixture();
  ram.avail({ idx: 2, heads: [0, 2], usedEvent: 9 });
  ram.used({ idx: 1, entries: [{ id: 0, len: 16 }], availEvent: 7 });
  const without = await decodeVirtqueue(ram, layout({ lastUsedIndex: 1 }), ATTRIBUTION);
  assert.equal(without.avail.usedEvent, null);
  assert.equal(without.used.availEvent, null);
  assert.equal(without.layout.features.eventIdx, false);

  const withEventIdx = await decodeVirtqueue(
    ram,
    layout({ lastUsedIndex: 1, negotiatedFeatures: (1n << 32n) | (1n << 29n) }),
    ATTRIBUTION,
  );
  assert.equal(withEventIdx.avail.usedEvent, 9);
  assert.equal(withEventIdx.used.availEvent, 7);
  assert.equal(withEventIdx.layout.features.eventIdx, true);
});

test('协商 packed ring 时明确拒绝解析', async () => {
  const ram = fixture();
  const result = await decodeVirtqueue(
    ram,
    layout({ negotiatedFeatures: (1n << 32n) | (1n << 34n) }),
    ATTRIBUTION,
  );
  assert.equal(result.ready, false);
  assert.deepEqual(result.chains, []);
  assert.equal(result.avail, null);
  assert.equal(result.unavailable.length, 1);
  assert.match(result.unavailable[0], /VIRTIO_F_RING_PACKED/);
  assert.equal(ram.calls.length, 0, '拒绝时不应该去读环');
});

test('size=0、环地址为 0 或环长非法时报告队列原因', async () => {
  const ram = fixture();
  const zero = await decodeVirtqueue(ram, layout({ size: 0 }), ATTRIBUTION);
  assert.equal(zero.ready, false);
  assert.match(zero.unavailable[0], /size=0/);

  const noAddr = await decodeVirtqueue(ram, layout({ usedRing: 0n }), ATTRIBUTION);
  assert.match(noAddr.unavailable[0], /环地址不完整/);

  const notPowerOfTwo = await decodeVirtqueue(ram, layout({ size: 3 }), ATTRIBUTION);
  assert.match(notPowerOfTwo.unavailable[0], /不是 2 的幂/);
  assert.equal(notPowerOfTwo.ready, false);
});

test('描述符链成环时报告原因并终止展开', async () => {
  const ram = makeRam();
  ram.descriptor(0, { address: 0x8000, length: 8, flags: 1, next: 1 });
  ram.descriptor(1, { address: 0x8100, length: 8, flags: 1, next: 0 });
  ram.avail({ idx: 1, heads: [0] });
  ram.used({ idx: 0 });
  const result = await decodeVirtqueue(ram, layout(), ATTRIBUTION);
  assert.deepEqual(result.chains, []);
  assert.equal(result.outstanding, 1);
  assert.ok(result.unavailable.some((item) => item.includes('成环')));
});

test('next 与 head 越界时终止展开并报告非法索引', async () => {
  const ram = makeRam();
  ram.descriptor(0, { address: 0x8000, length: 8, flags: 1, next: 99 });
  ram.avail({ idx: 1, heads: [0] });
  ram.used({ idx: 0 });
  const outOfRange = await decodeVirtqueue(ram, layout(), ATTRIBUTION);
  assert.deepEqual(outOfRange.chains, []);
  assert.ok(outOfRange.unavailable.some((item) => item.includes('超出队列大小')));

  ram.avail({ idx: 1, heads: [99] });
  const badHead = await decodeVirtqueue(ram, layout(), ATTRIBUTION);
  assert.ok(badHead.unavailable.some((item) => item.includes('head=99')));

  const tooMany = await decodeVirtqueue(ram, layout({ lastAvailIndex: 3 }), ATTRIBUTION);
  // avail.idx=1、last_avail_idx=3 的回绕差为 65534，超过队列大小，终止展开。
  assert.deepEqual(tooMany.chains, []);
  assert.ok(tooMany.unavailable.some((item) => item.includes('超过队列大小')));
});

test('间接描述符表按实际结构展开；嵌套间接表被拒绝', async () => {
  const ram = makeRam();
  const table = 0x6000n;
  ram.descriptor(0, { address: Number(table), length: DESCRIPTOR_SIZE * 2, flags: 4 });
  // 间接表里的两项
  const write = (index, address, length, flags, next) => {
    const offset = Number(table) + index * DESCRIPTOR_SIZE;
    ram.ram.writeBigUInt64LE(BigInt(address), offset);
    ram.ram.writeUInt32LE(length, offset + 8);
    ram.ram.writeUInt16LE(flags, offset + 12);
    ram.ram.writeUInt16LE(next, offset + 14);
  };
  write(0, 0x8000, 100, 0, 0);
  write(1, 0x9000, 32, 2, 0);
  ram.avail({ idx: 1, heads: [0] });
  ram.used({ idx: 0 });
  const result = await decodeVirtqueue(ram, layout(), ATTRIBUTION);
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].indirect, true);
  assert.equal(result.chains[0].descriptors.length, 2);
  assert.deepEqual(result.chains[0].indices, [0], 'indices 只记主表下标，表内下标靠 tableAddress 区分');
  assert.equal(result.chains[0].descriptors[0].viaIndirect, true);
  assert.equal(result.chains[0].descriptors[0].tableAddress, '0x6000');
  assert.equal(result.chains[0].descriptors[1].index, 1);
  assert.equal(result.chains[0].readableBytes, 100);
  assert.equal(result.chains[0].writableBytes, 32);
  assert.equal(result.chains[0].descriptors[1].address, '0x9000');

  // 间接表里又出现 INDIRECT → 拒绝
  write(0, 0x8000, 100, 4, 0);
  const nested = await decodeVirtqueue(ram, layout(), ATTRIBUTION);
  assert.deepEqual(nested.chains, []);
  assert.ok(nested.unavailable.some((item) => item.includes('嵌套')));
});

test('环所在页超出采集范围时报告读取缺口', async () => {
  const ram = fixture();
  const result = await decodeVirtqueue(
    ram,
    layout({ availRing: 0xff000n, usedRing: 0xff100n }),
    ATTRIBUTION,
  );
  assert.equal(result.ready, false);
  assert.equal(result.avail, null);
  assert.ok(result.unavailable.some((item) => item.includes('可用环') && item.includes('读不到')));
  assert.ok(result.unavailable.some((item) => item.includes('已用环') && item.includes('读不到')));
});

test('layoutFromSnapshot 缺地址时以 0 表示队列待就绪', () => {
  const result = layoutFromSnapshot(
    { queueIndex: 1, size: 256, ready: true, negotiatedFeatures: '0x100000000', descTable: null, availRing: '0x1000', usedRing: '0x2000', lastAvailIndex: 5, lastUsedIndex: 5, evidence: { kind: 'observed', source: 'test', refs: [] } },
    1n << 32n,
  );
  assert.equal(result.descTable, 0n);
  assert.equal(result.availRing, 0x1000n);
  assert.equal(result.queueIndex, 1);
  assert.equal(reportVirtioFeatures(result.negotiatedFeatures).version1, true);
});
