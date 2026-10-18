/**
 * disk-version-store：磁盘的逻辑版本表（T06 第 4 条，E09）。
 *
 * 表达的是一条**有基线**的版本链，而不是「当前磁盘镜像」：
 * - `baseSha256`：基线镜像（`artifacts/rootfs.img`）的内容散列。版本链必须与基线
 *   一起绑定，否则「第 3 版」离开基线无法解释。
 * - `visible`：已经**对客体可见**的写完成范围。可见的判据与 T05e 的 pending 判据
 *   同源——设备把状态字节回写客体（`virtio_blk_req_complete()`）那一刻才算数；
 *   宿主块层自己完成不改变可见性。
 * - `pending`：已提交、还没对客体可见的写，**独立保存**，不并进 `visible`。
 *   这是任务卡「磁盘以基线和已对客体可见的逻辑完成版本表达，pending 写入独立保存」
 *   的字面要求。
 *
 * 两个刻意的拒绝：
 * - 读一个「被可见写覆盖过、但那次的载荷没采到」的范围时**报错**，不返回基线内容；
 *   基线内容在那一刻已经不成立了，返回它等于用旧值冒充新值。
 * - 离线校验只接受**已经不在运行**的镜像文件；对活跃的 qcow2 做绕过锁的读取，
 *   拿到的是半写状态，那种「一致」没有意义。
 *
 * 离线校验的结论分两层，不要混着读：
 * - `ok`：凡是校验得了的范围，内容都和覆盖层对上了（没有 mismatch）；
 * - `complete`：所有可见写都被校验到了。载荷取不到的范围进 `unverified`，
 *   它既不算通过、也不让整份校验中断。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { sha256Hex } from '../../../../packages/trace-format/hash.ts';

export const SECTOR_SIZE = 512;

/** 合并相邻/重叠的 LBA 区间（按起始排序，相邻即合并）。 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].filter((range) => range.count > 0).sort((a, b) => a.lba - b.lba);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.lba <= last.lba + last.count) {
      last.count = Math.max(last.count, range.lba + range.count - last.lba);
    } else {
      merged.push({ lba: range.lba, count: range.count });
    }
  }
  return merged;
}

/** 一组区间里覆盖到的字节总量。 */
export function rangeBytes(ranges) {
  return ranges.reduce((sum, range) => sum + range.count * SECTOR_SIZE, 0);
}

export class DiskVersionStore {
  constructor({ diskId = 'virtio-blk-0', basePath = null, dir, captureId = null, blockSize = SECTOR_SIZE }) {
    this.diskId = diskId;
    this.basePath = basePath;
    this.dir = dir;
    this.captureId = captureId;
    this.blockSize = blockSize;
    /** requestId → 当前**还在飞行**的写记录（完成后立刻从这张表里移走） */
    this.writes = new Map();
    /**
     * 已完成的写记录，只增不改。
     *
     * 为什么不能只留「requestId → 记录」一张表：requestId 是「virtqueue 索引 +
     * 描述符头索引」，描述符会被复用，一次会话里 `vq0-1` 可以是许多笔不同的写。
     * 只按 requestId 覆盖的话，后一笔写会把前一笔**早已对客体可见**的写从版本表
     * 里抹掉，可见范围就丢了历史（实测：故障写和后一笔裸写共用 vq0-1，版本表里
     * 只剩后者，故障写既不在 visible 也不在 pending —— 凭空消失）。
     */
    this.finalized = [];
    this.reads = new Map();
    /** requestId → 载荷内容散列 */
    this.payloads = new Map();
    /**
     * 版本号 → 提交该版本时的可见写快照。
     *
     * 只保存版本号不够：要回看历史帧的盘面，必须知道“那一刻有哪些写已经可见”。
     * 这里保存写记录的浅拷贝（lba/count/payloadRef/completedSeq），读取时按快照
     * 过滤，而不是按当前 visible 覆盖；快照只增不改，容量有上限。
     */
    this.versionHistory = new Map();
    this.baseSha256 = null;
    this.baseBytes = null;
    this.notes = [];
    this.overflows = [];
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  /** 基线镜像的内容散列（按需算一次并缓存）。 */
  async baseHash() {
    if (this.baseSha256 !== null) return this.baseSha256;
    if (this.basePath === null) return null;
    const bytes = await fsp.readFile(this.basePath);
    this.baseBytes = bytes.length;
    this.baseSha256 = sha256Hex(bytes);
    return this.baseSha256;
  }

  /**
   * 记录一个 `block.submit`。
   * `lba` 按扇区号（512 字节单位），与事件里 `addressSpace='disk-lba'` 的语义一致。
   *
   * 同一个 requestId 再次提交有两种截然不同的含义，必须分开处理：
   * - 它**还没完成** → 是同一个逻辑写请求被重新提交（宿主错误动作 stop 之后，
   *   设备把挂在 `s->rq` 上的那个请求对象再处理一遍）；更新原记录，不新建，
   *   否则版本表里会留下一笔永远 pending 的幽灵写。
   * - 它**已经完成** → requestId 只是描述符索引，被复用了；这是**另一笔写**，
   *   新建记录，已完成的旧记录留在 `finalized` 里不动。
   */
  submit({ requestId, deviceId = null, lba, bytes, op, seq = null, queueIndex = null, descHead = null }) {
    if (typeof requestId !== 'string' || requestId.length === 0) return null;
    const entry = {
      requestId,
      deviceId: deviceId ?? this.diskId,
      lba: BigInt(lba),
      count: Math.ceil(Number(bytes) / this.blockSize),
      bytes: Number(bytes),
      op: op ?? 'unknown',
      submittedSeq: seq,
      queueIndex,
      descHead,
      status: 'pending',
      completedSeq: null,
      statusCode: null,
      /** 同一个逻辑请求被重新提交的次数（宿主错误动作 stop 后恢复时会 +1） */
      resubmits: 0,
      /**
       * 这条写记录自己绑定的载荷散列（`recordPayload` 写进来的）。
       *
       * 为什么载荷不能只按 requestId 索引：requestId 会被复用，两笔不同的写
       * 共用 `vq0-1` 时，后一笔会把前一笔的载荷指纹覆盖掉，回读前一笔范围就
       * 会拿到后一笔的字节（比「返回基线旧值」更糟：那是另一笔写的内容）。
       * 绑定在记录上，每条记录永远指向自己那份载荷。
       */
      payloadRef: null,
    };
    // 读请求不改磁盘内容，也不进版本链：同 id 直接覆盖即可，不需要历史。
    if (entry.op !== 'write') {
      this.reads.set(requestId, entry);
      return entry;
    }
    const existing = this.writes.get(requestId) ?? null;
    if (existing === null) {
      this.writes.set(requestId, entry);
      return entry;
    }
    /*
     * 重提交：同一个请求对象又走了一遍 virtio_blk_handle_request()，lba 与长度
     * 应当与上次完全一致（设备解析的是同一份描述符）。仍然按最新事件更新，
     * 并用 resubmits 留下「它被重提交过」的痕迹。
     */
    existing.lba = entry.lba;
    existing.count = entry.count;
    existing.bytes = entry.bytes;
    existing.deviceId = entry.deviceId;
    existing.submittedSeq = entry.submittedSeq;
    existing.queueIndex = entry.queueIndex;
    existing.descHead = entry.descHead;
    existing.resubmits += 1;
    return existing;
  }

  /**
   * 记录一个 `block.complete`。只有 write 请求会影响 `visible`；
   * 读请求的完成只是「读过了」，不改变磁盘内容。
   *
   * 完成后这条记录就从「当前」表里移到 `finalized`：它的身份已经用尽，
   * 同 requestId 的下一次提交必然是另一笔写。读记录不搬数据、也不进版本链，
   * 原地留着状态即可。
   */
  complete({ requestId, status = 'ok', statusCode = null, seq = null }) {
    const live = this.writes.get(requestId) ?? null;
    const entry = live ?? this.reads.get(requestId) ?? null;
    if (entry === undefined || entry === null) {
      this.notes.push(`${requestId} 的完成事件没有对应的提交记录（事件环有丢包或窗口从中间开始），不据此推进版本`);
      return null;
    }
    entry.status = status;
    entry.statusCode = statusCode;
    entry.completedSeq = seq;
    if (live !== null) {
      this.writes.delete(requestId);
      this.finalized.push(entry);
    }
    return entry;
  }

  /** 已对客体可见的写记录（状态 ok 的已完成记录），保持完成先后顺序。 */
  #visibleWrites() {
    return this.finalized.filter((entry) => entry.status === 'ok');
  }

  /**
   * 某个 requestId 的写记录：优先「还在飞行的」，否则最近一次已完成的。
   * 列表类查询（载荷清单）用得到它，因为载荷是按 requestId 存的，而写完成后
   * 记录已经离开 `writes`。
   */
  writeFor(requestId) {
    const live = this.writes.get(requestId) ?? null;
    if (live !== null) return live;
    for (let index = this.finalized.length - 1; index >= 0; index -= 1) {
      if (this.finalized[index].requestId === requestId) return this.finalized[index];
    }
    return null;
  }

  /** 已对客体可见的写范围。 */
  get visibleRanges() {
    return mergeRanges(
      this.#visibleWrites().map((entry) => ({ lba: Number(entry.lba), count: entry.count })),
    );
  }

  /**
   * 已提交、还没对客体可见的写。
   *
   * 两种情形都算「还没可见」：正在飞行的（在 `writes` 里），以及以错误结束的
   * 已完成记录 —— 客体拿到的是错误状态，磁盘内容没有变成它的样子，永远也不会
   * 变成它的样子，所以它进不了 `visible`；如实留在 pending 里比悄悄丢掉强。
   */
  get pendingWrites() {
    return [
      ...this.writes.values(),
      ...this.finalized.filter((entry) => entry.status !== 'ok'),
    ];
  }

  /** 一条写记录绑定的载荷散列；没采到载荷时为 null。 */
  payloadRefFor(entry) {
    return entry?.payloadRef ?? null;
  }

  /**
   * 契约 DiskVersion。拿不到基线散列时返回 null：版本链离开基线无法解释，
   * 与其塞一个空字符串当散列，不如让上层如实标注缺口。
   */
  version({ createdAt = null } = {}) {
    if (this.baseSha256 === null) return null;
    const versionId = this.#versionId();
    if (!this.versionHistory.has(versionId)) {
      // 只保留必要字段，并把数组/对象复制出来；后续 finalized 的 push 不会
      // 改到已提交版本。
      this.versionHistory.set(versionId, {
        versionId,
        createdAt: createdAt ?? new Date().toISOString(),
        visibleWrites: this.#visibleWrites().map((entry) => ({ ...entry })),
      });
      if (this.versionHistory.size > 5000) {
        const oldest = this.versionHistory.keys().next().value;
        this.versionHistory.delete(oldest);
      }
    }
    return {
      diskId: this.diskId,
      versionId,
      baseSha256: this.baseSha256,
      visible: this.visibleRanges.map((range) => ({
        lba: `0x${range.lba.toString(16)}`,
        count: range.count,
      })),
      pending: this.pendingWrites.map((entry) => ({
        requestId: entry.requestId,
        lba: `0x${entry.lba.toString(16)}`,
        count: entry.count,
        dataRef: this.payloadRefFor(entry),
        bytes: entry.bytes,
      })),
      createdAt: createdAt ?? new Date().toISOString(),
    };
  }

  /**
   * 版本号由「基线散列 + 已可见写的范围/载荷/完成序」决定。
   *
   * 不能只哈希最终范围：同一个 LBA 被覆盖写两次时范围相同、内容不同；
   * 只按范围算会得到同一个版本号，历史读取就会把第一笔写当成当前内容。
   */
  #versionId() {
    const material = JSON.stringify({
      disk: this.diskId,
      base: this.baseSha256,
      visible: this.#visibleWrites()
        .map((entry) => ({
          lba: entry.lba.toString(),
          count: entry.count,
          payloadRef: entry.payloadRef ?? null,
          completedSeq: entry.completedSeq ?? null,
        }))
        .sort((a, b) => Number(a.completedSeq ?? 0) - Number(b.completedSeq ?? 0)),
    });
    return `v-${sha256Hex(material).slice(0, 16)}`;
  }

  /**
   * 保存一次写的载荷（内容寻址去重）。
   * 这是「pending 写入独立保存」里「独立」的实际含义：载荷有自己的文件，
   * 不与基线镜像混在一起，也不会被后续写入覆盖。
   */
  async recordPayload({ requestId, bytes }) {
    const buffer = Buffer.from(bytes);
    const digest = sha256Hex(buffer);
    if (this.dir) {
      await fsp.writeFile(path.join(this.dir, `payload-${digest}`), buffer);
    }
    // 按 requestId 的索引只为列表类查询（`?payloads=1`）服务，它是「最后一次
    // 写入者胜出」的；权威绑定在写记录上，见 payloadRefFor()。
    this.payloads.set(requestId, digest);
    const record = this.writeFor(requestId);
    if (record !== null) record.payloadRef = digest;
    return digest;
  }

  payloadPath(digest) {
    return path.join(this.dir, `payload-${digest}`);
  }

  async payloadBytes(digest) {
    try {
      return await fsp.readFile(this.payloadPath(digest));
    } catch {
      return null;
    }
  }

  /**
   * 读一段逻辑扇区。
   *
   * 取值优先级：**已记录载荷的可见写**（取最后一次写该范围的载荷）→ 基线。
   * 若请求范围与某个「可见但没有载荷」的写相交，直接报错：那时基线内容已经
   * 不成立，返回它就是用旧值冒充新值。
   */
  async read({ lba, count, versionId = null }) {
    const start = BigInt(lba);
    const sectors = Number(count);
    if (!Number.isInteger(sectors) || sectors <= 0) throw new Error(`扇区数必须是正整数，收到 ${count}`);
    if (this.basePath === null) throw new Error('没有基线镜像路径，无法读取基线内容');
    const end = start + BigInt(sectors);

    /*
     * 指定版本时只使用该版本快照里已经可见的写。版本不存在就明确拒绝：
     * 用当前可见范围替代会让历史帧看到“未来”的磁盘内容。
     */
    let sourceWrites;
    let resolvedVersionId;
    let historical = false;
    if (versionId === null || versionId === undefined || versionId === this.#versionId()) {
      sourceWrites = this.#visibleWrites();
      resolvedVersionId = this.#versionId();
    } else {
      const snapshot = this.versionHistory.get(String(versionId));
      if (snapshot === undefined) {
        const error = new Error(
          `磁盘版本 ${versionId} 不在本代版本历史里：无法用当前可见范围替代历史版本`,
        );
        error.code = 'unknown-disk-version';
        error.detail = { versionId: String(versionId), knownVersions: this.versionHistory.size };
        throw error;
      }
      sourceWrites = snapshot.visibleWrites;
      resolvedVersionId = snapshot.versionId;
      historical = true;
    }

    const covers = sourceWrites
      .filter((entry) => entry.lba < end && start < entry.lba + BigInt(entry.count))
      .sort((a, b) => Number(a.completedSeq ?? 0) - Number(b.completedSeq ?? 0));

    const uncovered = covers.filter((entry) => this.payloadRefFor(entry) === null);
    if (uncovered.length > 0) {
      const error = new Error(
        `范围 lba=0x${start.toString(16)} count=${sectors} 与 ${uncovered.length} 个已对客体可见的写相交，`
        + '但这些写的载荷在本代采集里没有记录：基线内容在这个范围上已经不成立，'
        + '这里不返回基线字节（那会是用旧值冒充新值）',
      );
      error.code = 'disk-version-incomplete';
      error.detail = { requestIds: uncovered.map((entry) => entry.requestId) };
      throw error;
    }

    // 先拿基线，再用载荷按写顺序覆盖（后者覆盖前者，与磁盘语义一致）
    const handle = await fsp.open(this.basePath, 'r');
    let buffer;
    try {
      buffer = Buffer.alloc(sectors * this.blockSize);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Number(start) * this.blockSize);
      if (bytesRead !== buffer.length) {
        throw new Error(
          `基线镜像只读到 ${bytesRead} 字节（期望 ${buffer.length}）：`
          + '这个范围超出基线镜像，不能拿零补齐',
        );
      }
    } finally {
      await handle.close();
    }

    let patched = 0;
    for (const entry of covers) {
      const digest = this.payloadRefFor(entry);
      if (digest === null) continue;
      const payload = await this.payloadBytes(digest);
      if (payload === null) continue;
      // 写范围与请求范围求交，逐字节覆盖
      const writeEnd = entry.lba + BigInt(entry.count);
      const from = entry.lba > start ? entry.lba : start;
      const to = writeEnd < end ? writeEnd : end;
      const offsetInPayload = Number(from - entry.lba) * this.blockSize;
      const offsetInRequest = Number(from - start) * this.blockSize;
      const length = Number(to - from) * this.blockSize;
      payload.copy(buffer, offsetInRequest, offsetInPayload, offsetInPayload + length);
      patched += 1;
    }

    return {
      diskId: this.diskId,
      versionId: resolvedVersionId,
      historical,
      lba: `0x${start.toString(16)}`,
      count: sectors,
      bytes: buffer.toString('base64'),
      fromBase: patched === 0,
      evidence: {
        kind: patched === 0 ? 'decoded' : 'observed',
        source: patched === 0 ? 'baseline-image' : 'virtio-write-payload',
        captureId: this.captureId,
        refs: [
          `baseline:${this.basePath}`,
          `baseSha256:${this.baseSha256 ?? 'unavailable'}`,
          `version:${resolvedVersionId}`,
          historical ? 'source:version-history' : 'source:current-visible',
          `patchedWrites:${patched}`,
        ],
      },
    };
  }

  /**
   * 离线校验：QEMU 已退出后，用基线镜像 + 记录下来的载荷重算可见范围的内容，
   * 并与（此时已不活跃的）会话覆盖层比较。
   *
   * `overlayPath` 指向会话的 qcow2 覆盖层。调用方必须保证会话已关闭；
   * 这个函数自己也会检查覆盖层没有被别的进程打开，避免「对活跃镜像的
   * 绕过锁读取」被当成一次校验。
   */
  async offlineVerify({ overlayPath, sectors = null }) {
    if (this.basePath === null) throw new Error('没有基线镜像路径，无法做离线校验');
    const wanted = sectors ?? this.visibleRanges.map((range) => ({ lba: range.lba, count: range.count }));
    if (wanted.length === 0) {
      return {
        ok: true,
        complete: true,
        checked: 0,
        mismatches: [],
        unverified: [],
        verified: [],
        note: '本代没有已对客体可见的写，离线校验只确认基线本身的散列',
        baseSha256: this.baseSha256,
      };
    }
    const overlay = await this.#readOverlaySectors(overlayPath, wanted);
    const mismatches = [];
    /*
     * 可见但载荷没采到的写：这一段**校验不了**。它既不算通过，也不该让整份
     * 校验中断——如实列进 `unverified`，让「校验了多少、剩下多少」是可知的。
     * 出现它的原因是停机动作会 drain 块层，只有设备层已挂起的写请求才可能
     * 在采集点上被取到载荷（见 session.mjs 的 #captureWritePayloads）。
     */
    const unverified = [];
    const verified = [];
    let checked = 0;
    for (const range of wanted) {
      const lbaText = `0x${BigInt(range.lba).toString(16)}`;
      let actual;
      try {
        actual = await this.read({ lba: BigInt(range.lba), count: range.count });
      } catch (error) {
        unverified.push({
          lba: lbaText,
          count: range.count,
          reason: error.message,
          code: error.code ?? null,
        });
        continue;
      }
      const offset = range.lba * this.blockSize;
      const expected = Buffer.from(actual.bytes, 'base64');
      const fromImage = overlay.bytes.subarray(offset, offset + expected.length);
      const expectedSha = sha256Hex(expected);
      const imageSha = sha256Hex(fromImage);
      checked += 1;
      verified.push({
        lba: lbaText,
        count: range.count,
        expected: expectedSha,
        image: imageSha,
        match: expectedSha === imageSha,
      });
      if (expectedSha !== imageSha) {
        mismatches.push({
          lba: lbaText,
          count: range.count,
          expected: expectedSha,
          image: imageSha,
        });
      }
    }
    return {
      // ok 只说「凡是校验得了的，都对上了」；能不能覆盖全部可见写另由 complete 表达。
      ok: mismatches.length === 0,
      complete: unverified.length === 0,
      checked,
      mismatches,
      unverified,
      verified,
      baseSha256: this.baseSha256,
      overlaySha256: overlay.sha256,
      note: '离线校验：可见写的记录载荷 vs 已关闭会话的覆盖层内容',
    };
  }

  /**
   * 从覆盖层里读指定扇区。用 `qemu-img convert` 把覆盖层落成临时 raw 再读：
   * 这样不依赖 qcow2 的解析实现，也不需要绕过镜像锁——QEMU 已经退出了。
   * 注意 convert 默认会穿透 backing 文件，输出的是**整盘**内容，
   * 因此字节偏移就是 `lba × 512`，不需要再加基座偏移。
   */
  async #readOverlaySectors(overlayPath, ranges) {
    const { execFileSync } = await import('node:child_process');
    const rawPath = `${overlayPath}.verify.raw`;
    execFileSync('qemu-img', ['convert', '-f', 'qcow2', '-O', 'raw', overlayPath, rawPath], {
      stdio: 'ignore',
    });
    try {
      const bytes = await fsp.readFile(rawPath);
      return { bytes, sha256: sha256Hex(bytes) };
    } finally {
      await fsp.rm(rawPath, { force: true });
    }
  }

  /** 可持久化的状态快照（会话在提交帧时写进 frame-*.json 旁）。 */
  serialize() {
    return {
      schema: 'oslab.disk-version/1',
      diskId: this.diskId,
      captureId: this.captureId,
      basePath: this.basePath,
      baseSha256: this.baseSha256,
      blockSize: this.blockSize,
      writes: [...this.writes.values()].map((entry) => ({
        ...entry,
        lba: `0x${entry.lba.toString(16)}`,
      })),
      finalized: this.finalized.map((entry) => ({
        ...entry,
        lba: `0x${entry.lba.toString(16)}`,
      })),
      reads: [...this.reads.values()].map((entry) => ({ ...entry, lba: `0x${entry.lba.toString(16)}` })),
      payloads: Object.fromEntries(this.payloads),
      visible: this.visibleRanges,
      pending: this.pendingWrites.map((entry) => entry.requestId),
      notes: this.notes,
    };
  }
}

/** 基线镜像路径的默认位置（与 process.mjs 的覆盖层基座一致）。 */
export function defaultBasePath(root) {
  return path.join(root, 'artifacts/rootfs.img');
}

/** 内容散列工具，供会话侧计算帧内扇区散列时复用。 */
export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
