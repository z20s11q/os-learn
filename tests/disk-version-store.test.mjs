/**
 * T06 单元测试：磁盘逻辑版本存储（合成事件与载荷）。
 *
 * 可见性由完成状态决定，pending 写入独立保存；读取可见写的载荷缺口时抛错。
 *
 * 运行：node --test tests/disk-version-store.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  DiskVersionStore,
  mergeRanges,
  rangeBytes,
} from '../services/lab-server/src/collect/disk-version-store.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oslab-disk-'));
}

/** 4 KiB 的基线镜像（8 个 512 字节扇区，每个扇区填自己的扇区号）。 */
function makeBase(dir) {
  const bytes = Buffer.alloc(4096);
  for (let sector = 0; sector < 8; sector += 1) {
    bytes.fill(sector, sector * 512, (sector + 1) * 512);
  }
  const basePath = path.join(dir, 'rootfs.img');
  fs.writeFileSync(basePath, bytes);
  return { basePath, bytes };
}

/* ---------- 区间合并 ---------- */

test('mergeRanges 合并相邻与重叠区间，rangeBytes 按扇区算字节', () => {
  assert.deepEqual(mergeRanges([{ lba: 4, count: 2 }, { lba: 0, count: 2 }, { lba: 2, count: 2 }]), [
    { lba: 0, count: 6 },
  ]);
  assert.deepEqual(mergeRanges([{ lba: 0, count: 4 }, { lba: 1, count: 1 }]), [{ lba: 0, count: 4 }]);
  assert.deepEqual(mergeRanges([]), []);
  assert.equal(rangeBytes([{ lba: 0, count: 6 }]), 6 * 512);
});

/* ---------- 可见性与 pending ---------- */

test('只有完成成功的写才进 visible；未完成或失败的写留在 pending', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-1' });
  await store.baseHash();

  store.submit({ requestId: 'vq0-1', lba: 1, bytes: 1024, op: 'write', seq: 10 });
  store.submit({ requestId: 'vq0-2', lba: 3, bytes: 512, op: 'write', seq: 11 });
  store.submit({ requestId: 'vq0-3', lba: 6, bytes: 512, op: 'write', seq: 12 });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 20 });
  store.complete({ requestId: 'vq0-3', status: 'error', statusCode: 1, seq: 21 });

  assert.deepEqual(store.visibleRanges, [{ lba: 1, count: 2 }]);
  assert.deepEqual(store.pendingWrites.map((entry) => entry.requestId).sort(), ['vq0-2', 'vq0-3']);

  const version = store.version();
  assert.equal(version.diskId, 'virtio-blk-0');
  assert.deepEqual(version.visible, [{ lba: '0x1', count: 2 }]);
  assert.deepEqual(version.pending.map((entry) => entry.requestId).sort(), ['vq0-2', 'vq0-3']);
  assert.equal(version.pending[0].dataRef, null, '没采到载荷时 dataRef 是 null，不编一个散列');
  assert.equal(version.baseSha256, sha(fs.readFileSync(basePath)));
});

test('读请求进入 reads；孤立完成事件记录说明，visible 保持原值', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-2' });
  await store.baseHash();

  store.submit({ requestId: 'vq0-1', lba: 0, bytes: 512, op: 'read', seq: 5 });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 6 });
  assert.deepEqual(store.visibleRanges, []);
  assert.equal(store.reads.size, 1);

  store.complete({ requestId: 'vq0-9', status: 'ok', seq: 7 });
  assert.equal(store.notes.length, 1);
  assert.match(store.notes[0], /没有对应的提交记录/);
});

/* ---------- 读取：基线 + 载荷覆盖 ---------- */

test('读取优先用已记录载荷覆盖基线，未覆盖的范围标记 fromBase', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-3' });
  await store.baseHash();

  store.submit({ requestId: 'vq0-1', lba: 2, bytes: 1024, op: 'write', seq: 10 });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 11 });
  await store.recordPayload({ requestId: 'vq0-1', bytes: Buffer.alloc(1024, 0xbb) });

  const fromBase = await store.read({ lba: 0, count: 2 });
  assert.equal(fromBase.fromBase, true);
  assert.deepEqual(
    Buffer.from(fromBase.bytes, 'base64'),
    Buffer.concat([Buffer.alloc(512, 0), Buffer.alloc(512, 1)]),
    '第 0/1 扇区来自基线，内容就是基线里逐扇区填充的扇区号',
  );

  const covered = await store.read({ lba: 2, count: 2 });
  assert.equal(covered.fromBase, false);
  assert.deepEqual(Buffer.from(covered.bytes, 'base64'), Buffer.alloc(1024, 0xbb));
  assert.ok(covered.evidence.refs.some((ref) => ref.startsWith('baseSha256:')));

  // 跨边界：前半来自基线、后半来自载荷
  const mixed = await store.read({ lba: 1, count: 2 });
  const bytes = Buffer.from(mixed.bytes, 'base64');
  assert.deepEqual(bytes.subarray(0, 512), Buffer.alloc(512, 1), '第 1 扇区应来自基线');
  assert.deepEqual(bytes.subarray(512), Buffer.alloc(512, 0xbb), '第 2 扇区应来自载荷');
});

test('读取范围与可见写的载荷缺口相交时抛错', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-4' });
  await store.baseHash();

  store.submit({ requestId: 'vq0-1', lba: 4, bytes: 512, op: 'write', seq: 10 });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 11 });

  await assert.rejects(
    () => store.read({ lba: 3, count: 3 }),
    (error) => error.code === 'disk-version-incomplete' && error.detail.requestIds.includes('vq0-1'),
  );
  // 相交范围之外的读取使用基线。
  const ok = await store.read({ lba: 0, count: 2 });
  assert.equal(ok.fromBase, true);
});

test('基线镜像路径缺失时版本号为空，读取抛错', async () => {
  const store = new DiskVersionStore({ basePath: null, dir: tempDir(), captureId: 'cap-disk-5' });
  assert.equal(store.version(), null, '拿不到基线散列时版本为 null，由上层标注缺口');
  await assert.rejects(() => store.read({ lba: 0, count: 1 }), /没有基线镜像路径/);
});

test('多个写覆盖同一范围时后完成的覆盖先完成的', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-6' });
  await store.baseHash();

  store.submit({ requestId: 'vq0-1', lba: 0, bytes: 512, op: 'write', seq: 1 });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 2 });
  await store.recordPayload({ requestId: 'vq0-1', bytes: Buffer.alloc(512, 0x11) });

  store.submit({ requestId: 'vq0-2', lba: 0, bytes: 512, op: 'write', seq: 3 });
  store.complete({ requestId: 'vq0-2', status: 'ok', seq: 4 });
  await store.recordPayload({ requestId: 'vq0-2', bytes: Buffer.alloc(512, 0x22) });

  const result = await store.read({ lba: 0, count: 1 });
  assert.deepEqual(Buffer.from(result.bytes, 'base64'), Buffer.alloc(512, 0x22));

  const serialized = store.serialize();
  assert.equal(serialized.payloads['vq0-1'].length, 64);
  assert.equal(serialized.visible.length, 1);
  assert.equal(serialized.visible[0].count, 1);
});

/* ---------- requestId 复用（描述符索引复用） ---------- */

test('requestId 复用时保留已可见写，两笔写分别读取各自载荷', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-7' });
  await store.baseHash();

  // 第一笔：写扇区 4。正常完成 → 对客体可见；载荷趁它还在飞行时就采到了。
  store.submit({ requestId: 'vq0-1', lba: 4, bytes: 512, op: 'write', seq: 10 });
  await store.recordPayload({ requestId: 'vq0-1', bytes: Buffer.alloc(512, 0x33) });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 11 });

  // 描述符索引被复用：同一个 requestId 又提交了一笔完全不同的写。
  store.submit({ requestId: 'vq0-1', lba: 6, bytes: 512, op: 'write', seq: 20 });
  await store.recordPayload({ requestId: 'vq0-1', bytes: Buffer.alloc(512, 0x44) });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 21 });

  assert.deepEqual(
    store.visibleRanges,
    [{ lba: 4, count: 1 }, { lba: 6, count: 1 }],
    '两笔写都要在可见范围里：只按 requestId 覆盖会把第一笔从版本表里抹掉（既不在 visible 也不在 pending）',
  );
  assert.deepEqual(store.pendingWrites, []);
  assert.equal(store.finalized.length, 2);
  assert.notEqual(store.finalized[0].payloadRef, store.finalized[1].payloadRef, '两份载荷各绑各的记录');

  // 第一笔写读取自己的载荷字节。
  const first = await store.read({ lba: 4, count: 1 });
  assert.deepEqual(Buffer.from(first.bytes, 'base64'), Buffer.alloc(512, 0x33));
  const second = await store.read({ lba: 6, count: 1 });
  assert.deepEqual(Buffer.from(second.bytes, 'base64'), Buffer.alloc(512, 0x44));
});

test('宿主 io-error stop 恢复后重提交同一请求时更新原记录', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-8' });
  await store.baseHash();

  store.submit({ requestId: 'vq0-1', lba: 2, bytes: 512, op: 'write', seq: 10 });
  const first = store.writes.get('vq0-1');
  store.submit({ requestId: 'vq0-1', lba: 2, bytes: 512, op: 'write', seq: 20 });

  assert.equal(store.writes.size, 1, '重提交不该在版本表里留下第二条记录（那会是一笔永远 pending 的幽灵写）');
  assert.equal(store.writes.get('vq0-1'), first, '重提交更新的是同一个记录对象');
  assert.equal(first.resubmits, 1);
  assert.equal(first.submittedSeq, 20);

  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 21 });
  assert.deepEqual(store.visibleRanges, [{ lba: 2, count: 1 }]);
  assert.deepEqual(store.pendingWrites, []);
});

/* ---------- T09：按历史版本读取 ---------- */

test('按历史版本读取只应用该版本已可见的写，未知版本明确拒绝', async () => {
  const dir = tempDir();
  const { basePath } = makeBase(dir);
  const store = new DiskVersionStore({ basePath, dir, captureId: 'cap-disk-version' });
  await store.baseHash();

  // 第一笔写：扇区 0 变成 0xaa
  store.submit({ requestId: 'vq0-1', lba: 0, bytes: 512, op: 'write', seq: 10 });
  store.complete({ requestId: 'vq0-1', status: 'ok', seq: 11 });
  await store.recordPayload({ requestId: 'vq0-1', bytes: Buffer.alloc(512, 0xaa) });
  const v1 = store.version().versionId;

  // 第二笔写：扇区 1 变成 0xbb
  store.submit({ requestId: 'vq0-2', lba: 1, bytes: 512, op: 'write', seq: 12 });
  store.complete({ requestId: 'vq0-2', status: 'ok', seq: 13 });
  await store.recordPayload({ requestId: 'vq0-2', bytes: Buffer.alloc(512, 0xbb) });
  const v2 = store.version().versionId;
  assert.notEqual(v1, v2, '两笔写产生不同版本号');

  const atV1 = await store.read({ lba: 0, count: 2, versionId: v1 });
  assert.equal(atV1.versionId, v1);
  assert.equal(atV1.historical, true);
  assert.deepEqual(
    Buffer.from(atV1.bytes, 'base64'),
    Buffer.concat([Buffer.alloc(512, 0xaa), Buffer.alloc(512, 1)]),
    'v1 只有第一笔写可见，扇区 1 仍是基线内容',
  );

  const atV2 = await store.read({ lba: 0, count: 2, versionId: v2 });
  assert.deepEqual(
    Buffer.from(atV2.bytes, 'base64'),
    Buffer.concat([Buffer.alloc(512, 0xaa), Buffer.alloc(512, 0xbb)]),
    'v2 两笔写都可见',
  );

  const baseOnly = await store.read({ lba: 2, count: 1, versionId: v1 });
  assert.equal(baseOnly.fromBase, true, '历史版本没覆盖的扇区读基线');

  // 同一个 LBA 再写一次：可见范围没变，但内容/完成序变了，版本号必须变化。
  store.submit({ requestId: 'vq0-3', lba: 0, bytes: 512, op: 'write', seq: 14 });
  store.complete({ requestId: 'vq0-3', status: 'ok', seq: 15 });
  await store.recordPayload({ requestId: 'vq0-3', bytes: Buffer.alloc(512, 0xcc) });
  const v3 = store.version().versionId;
  assert.notEqual(v3, v1, '同范围重写必须产生新版本号');
  const v3read = await store.read({ lba: 0, count: 1, versionId: v3 });
  assert.deepEqual(Buffer.from(v3read.bytes, 'base64'), Buffer.alloc(512, 0xcc));
  const v1again = await store.read({ lba: 0, count: 1, versionId: v1 });
  assert.deepEqual(Buffer.from(v1again.bytes, 'base64'), Buffer.alloc(512, 0xaa), '旧版本仍读旧载荷');

  await assert.rejects(
    () => store.read({ lba: 0, count: 1, versionId: 'v-0000000000000000' }),
    (error) => error.code === 'unknown-disk-version',
    '未知版本必须拒绝，不能用当前内容替代',
  );
});
