/**
 * RAM 基线与脏页增量的落盘存储（T06 第 2、5 条，验收 E14）。
 *
 * 存储布局（会话目录下，每代采集一个子目录）：
 * ```
 * ram/<captureId>/baseline.raw   基线内容，按区域顺序、页内升序拼接
 * ram/<captureId>/baseline.idx   每页 32 字节的 sha256，按页号 O(1) 定位
 * ram/<captureId>/baseline.json  区域表、页数、字节数、原始文件散列、未采到的页
 * ram/<captureId>/delta-<n>.raw  增量内容（只含变化的页）
 * ram/<captureId>/delta-<n>.json 增量索引：页地址、散列、在 .raw 里的偏移
 * ```
 * captureId 本身带连字符（`cap-<8 位>-<序号>`），所以**不能**把它拼进文件名
 * 再用 `-` 切回来：那会把 `cap-9f8e7d6c-1` 切成 `cap` 与 `9f8e7d6c`，造成
 * 「A 代的读取命中 B 代文件」这种最难查的串代错误。用子目录就没有这个歧义。
 *
 * 为什么基线是「一个大文件 + 一个定长索引」而不是「每页一个 blob 文件」：
 * 512 MiB 是 131072 页，一页一个文件会把目录项吃光；而每页一个 sha256 正好
 * 32 字节定长，可以按页号直接寻址，不必把 13 万个散列读进内存做成 Map。
 *
 * 关键约束：
 * - 一律按 captureId 检索，历史读取只能命中它自己那一代；找不到就报
 *   「本次未记录」，绝不回退去读当前 VM。
 * - 基线不完整（有页读不到）时 `complete=false`：此时任何「全量 RAM 散列」
 *   的声明都不成立，不能含糊过去。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { sha256Hex } from '../../../../packages/trace-format/hash.ts';

export const DIGEST_BYTES = 32;

/**
 * 区域表的规范化：观察者给的是十六进制字符串，这里统一成 bigint、排序、只留可直读区域。
 *
 * 两层过滤都要：
 * - `kinds`：`kind` 是观察者按 QEMU 的 MemoryRegion 性质分的（ram/rom/romd/mmio/alias）；
 * - `names`：**`kind=ram` 不等于「系统内存」**。设备侧的 RAM 区域（典型是
 *   0xfd000000 的 `vga.vram`，16 MiB 显存）在 QEMU 里也是 RAM 区域，
 *   `memory_region_is_ram()` 同样为真，所以 kind 也是 `ram`。要「完整 RAM 基线」
 *   就只能按区域名再筛一层，见 memory-reader 的 `MACHINE_RAM_NAMES`。
 */
export function normalizeRegions(regions, { kinds = null, names = null } = {}) {
  const list = [];
  for (const region of regions ?? []) {
    let base;
    let size;
    try {
      base = BigInt(region.base);
      size = BigInt(region.size);
    } catch {
      continue;
    }
    if (size <= 0n) continue;
    if (region.readable !== true) continue;
    const kind = region.kind ?? 'unknown';
    if (kinds !== null && !kinds.includes(kind)) continue;
    const name = region.name ?? 'unnamed';
    if (names !== null && !names.includes(name)) continue;
    list.push({ base, size, name, kind });
  }
  list.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  return list;
}

/** 区域表里每段占多少页（尾部不足一页也算一页），与 RamImage 口径一致。 */
export function pageCounts(regions, pageSize) {
  return regions.map((region) => Number((region.size + pageSize - 1n) / pageSize));
}

/**
 * 稠密基线索引：实现 trace-format 的 `RamBaselineLookup`。
 * 只持有定长散列数组与区域页数，不构造「每页一个对象」。
 */
export class DenseRamBaseline {
  constructor({ regions, pageSize, digests }) {
    this.regions = regions;
    this.pageSize = BigInt(pageSize);
    this.digests = digests;
    this.counts = pageCounts(regions, this.pageSize);
    this.total = this.counts.reduce((sum, count) => sum + count, 0);
    if (digests.length !== this.total * DIGEST_BYTES) {
      throw new Error(
        `基线索引长度 ${digests.length} 与区域页数 ${this.total} 不符（应为 ${this.total * DIGEST_BYTES} 字节）`,
      );
    }
    /*
     * 每段在基线内容文件里的起始字节偏移。
     * 区域尾部可以不足一页，所以「页号 × 页大小」不是内容偏移；
     * 内容偏移 = 前面各段字节数之和 + 段内页号 × 页大小。
     */
    this.byteBase = [];
    let sum = 0n;
    for (const region of regions) {
      this.byteBase.push(sum);
      sum += region.size;
    }
    this.regionBytes = sum;
  }

  get regionPageCount() {
    return this.total;
  }

  /** 页地址 → 全局页号；不在任何区域内返回 -1。 */
  ordinalOf(address) {
    const value = BigInt(address);
    let ordinal = 0;
    for (let index = 0; index < this.regions.length; index += 1) {
      const region = this.regions[index];
      if (value >= region.base && value < region.base + region.size) {
        return ordinal + Number((value - region.base) / this.pageSize);
      }
      if (value < region.base) return -1;
      ordinal += this.counts[index];
    }
    return -1;
  }

  /** 全局页号 → 段内位置与内容文件字节偏移。 */
  locationOf(ordinal) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.total) return null;
    let remaining = ordinal;
    for (let index = 0; index < this.regions.length; index += 1) {
      if (remaining < this.counts[index]) {
        return {
          regionIndex: index,
          localIndex: remaining,
          offset: this.byteBase[index] + BigInt(remaining) * this.pageSize,
        };
      }
      remaining -= this.counts[index];
    }
    return null;
  }

  /** 页地址在基线内容文件里的字节偏移；不在区域内返回 -1。 */
  offsetOf(address) {
    const ordinal = this.ordinalOf(address);
    if (ordinal < 0) return -1;
    const location = this.locationOf(ordinal);
    return location === null ? -1 : Number(location.offset);
  }

  addressOf(ordinal) {
    let remaining = ordinal;
    for (let index = 0; index < this.regions.length; index += 1) {
      if (remaining < this.counts[index]) {
        return this.regions[index].base + BigInt(remaining) * this.pageSize;
      }
      remaining -= this.counts[index];
    }
    return null;
  }

  get(address) {
    const ordinal = this.ordinalOf(address);
    if (ordinal < 0) return null;
    const start = ordinal * DIGEST_BYTES;
    return { sha256: this.digests.subarray(start, start + DIGEST_BYTES).toString('hex') };
  }

  get recordedPages() {
    const pages = [];
    for (let ordinal = 0; ordinal < this.total; ordinal += 1) {
      const address = this.addressOf(ordinal);
      if (address !== null) pages.push({ address });
    }
    return pages;
  }
}

export class RamStore {
  constructor({ dir, pageSize = 4096 }) {
    this.dir = dir;
    this.pageSize = BigInt(pageSize);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  dirFor(captureId) {
    return path.join(this.dir, captureId);
  }

  hasBaseline(captureId) {
    return fs.existsSync(path.join(this.dirFor(captureId), 'baseline.json'));
  }

  /**
   * 写基线。
   *
   * `reader.read` 必须绑定到 captureId。两点刻意的设计：
   * 1. 内容文件保持**稠密布局**：读不到的页也写等长的零字节占位，这样
   *    「区域字节前缀和 + 段内页号 × 页大小」始终就是内容偏移，不会因为
   *    中间缺了几页而整体错位（错位会把别页的内容当成这一页的）。
   * 2. 同时写一份缺席位图 `baseline.missing`：读取时先看位图，缺席的页
   *    返回「没有记录」，绝不返回那串占位零——零填在验收上等于伪造内容。
   *    `complete=false` 时任何「全量 RAM 散列一致」的声明都不成立。
   */
  async writeBaseline({ captureId, regions, reader, onProgress = null }) {
    const dir = this.dirFor(captureId);
    fs.mkdirSync(dir, { recursive: true });
    const counts = pageCounts(regions, this.pageSize);
    const totalPages = counts.reduce((sum, count) => sum + count, 0);
    const digests = Buffer.alloc(totalPages * DIGEST_BYTES);
    const missing = Buffer.alloc(Math.ceil(totalPages / 8));
    const skipped = [];
    const raw = fs.createWriteStream(path.join(dir, 'baseline.raw'));
    const fileHash = createHash('sha256');
    let ordinal = 0;
    let bytes = 0;
    let fileBytes = 0;
    const started = Date.now();

    const write = (chunk) => new Promise((resolve, reject) => {
      raw.write(chunk, (error) => (error ? reject(error) : resolve()));
    });

    try {
      for (const region of regions) {
        const end = region.base + region.size;
        let address = (region.base / this.pageSize) * this.pageSize;
        while (address < end) {
          const within = end - address < this.pageSize ? end - address : this.pageSize;
          const length = Number(within);
          let buffer = null;
          try {
            buffer = Buffer.from(await reader.read(address, length));
            if (buffer.length !== length) {
              throw new Error(`读到 ${buffer.length} 字节，期望 ${length}`);
            }
          } catch (error) {
            buffer = null;
            missing[ordinal >> 3] |= 1 << (ordinal & 7);
            if (skipped.length < 64) {
              skipped.push({
                address: `0x${address.toString(16)}`,
                length,
                code: error?.code ?? 'unexpected-error',
                reason: error instanceof Error ? error.message : String(error),
              });
            }
            buffer = Buffer.alloc(length);
          }
          if ((missing[ordinal >> 3] & (1 << (ordinal & 7))) === 0) {
            createHash('sha256').update(buffer).digest().copy(digests, ordinal * DIGEST_BYTES);
            bytes += buffer.length;
          }
          fileHash.update(buffer);
          await write(buffer);
          fileBytes += buffer.length;
          ordinal += 1;
          if (onProgress !== null && ordinal % 4096 === 0) onProgress({ ordinal, totalPages, bytes });
          address += this.pageSize;
        }
      }
    } finally {
      await new Promise((resolve, reject) => {
        raw.end((error) => (error ? reject(error) : resolve()));
      });
    }

    await fsp.writeFile(path.join(dir, 'baseline.idx'), digests);
    await fsp.writeFile(path.join(dir, 'baseline.missing'), missing);
    const missingCount = this.#countBits(missing, totalPages);
    const meta = {
      schema: 'oslab.ram-baseline/1',
      captureId,
      pageSize: Number(this.pageSize),
      regions: regions.map((region) => ({
        base: `0x${region.base.toString(16)}`,
        size: `0x${region.size.toString(16)}`,
        name: region.name,
        kind: region.kind,
      })),
      pages: totalPages - missingCount,
      regionPages: totalPages,
      bytes,
      fileBytes,
      rawSha256: fileHash.digest('hex'),
      complete: missingCount === 0,
      missingCount,
      skipped,
      elapsedMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dir, 'baseline.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  #countBits(bitmap, total) {
    let count = 0;
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      if ((bitmap[ordinal >> 3] & (1 << (ordinal & 7))) !== 0) count += 1;
    }
    return count;
  }

  async baselineInfo(captureId) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dirFor(captureId), 'baseline.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 打开基线用于读取。**不做整文件散列校验**（512 MiB 每次读一遍太贵）；
   * 需要校验时显式调用 `verifyBaseline`。
   */
  async openBaseline(captureId) {
    const info = await this.baselineInfo(captureId);
    if (info === null) throw new Error(`没有 ${captureId} 的 RAM 基线`);
    const dir = this.dirFor(captureId);
    const digests = await fsp.readFile(path.join(dir, 'baseline.idx'));
    const regions = info.regions.map((region) => ({
      base: BigInt(region.base),
      size: BigInt(region.size),
      name: region.name,
      kind: region.kind,
    }));
    const index = new DenseRamBaseline({ regions, pageSize: info.pageSize, digests });
    let missing = null;
    try {
      missing = await fsp.readFile(path.join(dir, 'baseline.missing'));
    } catch {
      missing = null;
    }
    const isMissing = (ordinal) => missing !== null
      && ordinal >= 0
      && (missing[ordinal >> 3] & (1 << (ordinal & 7))) !== 0;
    const handle = await fsp.open(path.join(dir, 'baseline.raw'), 'r');
    return {
      info,
      dir,
      regions,
      index,
      /**
       * 按页偏移读基线内容。
       * 页不在区域内、或那一页当初没采到（缺席位图里置位）时返回 null ——
       * 内容文件里对应的零字节只是为保持偏移一致而写的占位，不是采到的内容。
       */
      async page(address, length) {
        const ordinal = index.ordinalOf(address);
        if (ordinal < 0) return null;
        if (isMissing(ordinal)) return null;
        const offset = index.offsetOf(address);
        if (offset < 0) return null;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return bytesRead === length ? buffer : null;
      },
      async close() {
        await handle.close();
      },
    };
  }

  /** 校验基线内容文件与记录散列一致（独立验收用，不放在热路径上）。 */
  async verifyBaseline(captureId) {
    const info = await this.baselineInfo(captureId);
    if (info === null) throw new Error(`没有 ${captureId} 的 RAM 基线`);
    const bytes = await fsp.readFile(path.join(this.dirFor(captureId), 'baseline.raw'));
    const actual = sha256Hex(bytes);
    return { ok: actual === info.rawSha256, expected: info.rawSha256, actual, bytes: bytes.length };
  }

  /**
   * 写一次增量。`pages` 每项 `{ address, bytes }`，只含发生变化的页。
   * 增量文件带内容散列，读取时会校验偏移与长度。
   */
  async writeDelta({ captureId, parentCaptureId = null, tag = null, pages, note = null }) {
    const dir = this.dirFor(captureId);
    fs.mkdirSync(dir, { recursive: true });
    const existing = await this.listDeltas(captureId);
    const index = existing.length;
    const entries = [];
    const chunks = [];
    let offset = 0;
    for (const page of pages) {
      const buffer = Buffer.from(page.bytes);
      chunks.push(buffer);
      entries.push({
        address: `0x${BigInt(page.address).toString(16)}`,
        sha256: sha256Hex(buffer),
        offset,
        length: buffer.length,
      });
      offset += buffer.length;
    }
    const content = Buffer.concat(chunks);
    await fsp.writeFile(path.join(dir, `delta-${index}.raw`), content);
    const record = {
      schema: 'oslab.ram-delta/1',
      captureId,
      parentCaptureId,
      tag,
      index,
      pageSize: Number(this.pageSize),
      pages: entries.length,
      bytes: content.length,
      rawSha256: sha256Hex(content),
      entries,
      note,
      generatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dir, `delta-${index}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  async listDeltas(captureId) {
    const dir = this.dirFor(captureId);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const indexes = names
      .map((name) => /^delta-(\d+)\.json$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
    const out = [];
    for (const index of indexes) {
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(dir, `delta-${index}.json`), 'utf8')));
      } catch {
        out.push({ schema: 'oslab.ram-delta/1', captureId, index, broken: true, entries: [] });
      }
    }
    return out;
  }

  /**
   * 历史读取：只认这一代自己记录的字节。
   * 顺序是「最新增量 → 更早增量 → 基线」；都没有就抛
   * `ram-page-not-recorded`，由上层转成「本次未记录」。
   */
  async readRecorded({ captureId, address, length }) {
    const start = BigInt(address);
    const end = start + BigInt(length);
    const dir = this.dirFor(captureId);
    const deltas = await this.listDeltas(captureId);
    for (let index = deltas.length - 1; index >= 0; index -= 1) {
      const delta = deltas[index];
      const hit = (delta.entries ?? []).find((entry) => BigInt(entry.address) <= start
        && end <= BigInt(entry.address) + BigInt(entry.length));
      if (!hit) continue;
      const handle = await fsp.open(path.join(dir, `delta-${delta.index ?? index}.raw`), 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          length,
          hit.offset + Number(start - BigInt(hit.address)),
        );
        if (bytesRead === length) return { bytes: buffer, from: `delta-${delta.index ?? index}` };
      } finally {
        await handle.close();
      }
    }
    if (this.hasBaseline(captureId)) {
      const baseline = await this.openBaseline(captureId);
      try {
        const bytes = await baseline.page(start, length);
        if (bytes !== null) return { bytes, from: 'baseline' };
      } finally {
        await baseline.close();
      }
    }
    const error = new Error(
      `0x${start.toString(16)} 的 ${length} 字节在采集 ${captureId} 里没有记录（基线未覆盖该页，也没有增量）`,
    );
    error.code = 'ram-page-not-recorded';
    throw error;
  }

  /** 记录里出现的、覆盖了给定页地址的增量页（用于「历史读取命中了哪一代」的说明）。 */
  async deltaCoverage(captureId) {
    const deltas = await this.listDeltas(captureId);
    const pages = new Map();
    for (const delta of deltas) {
      for (const entry of delta.entries ?? []) {
        pages.set(entry.address, { sha256: entry.sha256, delta: delta.index ?? 0 });
      }
    }
    return pages;
  }

  /**
   * 重建并散列整份 RAM（基线 + 全部增量覆盖）。
   *
   * 与独立通道（QEMU 自己的 `pmemsave` 全量 dump）比较的就是这个值：按区域顺序、
   * 页内升序拼接。注意这里**不填零**：任何缺页都会让 `complete=false`，
   * 避免「靠零填让散列碰巧对上」。
   */
  async reconstructedHash({ captureId, fillByte = 0, strict = false }) {
    const baseline = await this.openBaseline(captureId);
    const deltas = await this.listDeltas(captureId);
    const latest = new Map();
    for (const delta of deltas) {
      for (const entry of delta.entries ?? []) {
        latest.set(BigInt(entry.address).toString(16), { delta, entry });
      }
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let fromDelta = 0;
    let fromBaseline = 0;
    const missing = [];
    try {
      for (const region of baseline.regions) {
        const end = region.base + region.size;
        let address = (region.base / this.pageSize) * this.pageSize;
        while (address < end) {
          const within = end - address < this.pageSize ? end - address : this.pageSize;
          const length = Number(within);
          const override = latest.get(address.toString(16));
          let buffer = null;
          if (override !== undefined) {
            const handle = await fsp.open(
              path.join(baseline.dir, `delta-${override.delta.index ?? 0}.raw`),
              'r',
            );
            try {
              const temp = Buffer.alloc(override.entry.length);
              const { bytesRead } = await handle.read(temp, 0, temp.length, override.entry.offset);
              if (bytesRead === temp.length) {
                buffer = temp.subarray(0, length);
                fromDelta += 1;
              }
            } finally {
              await handle.close();
            }
          }
          if (buffer === null) {
            const page = await baseline.page(address, length);
            if (page === null) {
              missing.push(`0x${address.toString(16)}`);
              buffer = Buffer.alloc(length, fillByte);
            } else {
              buffer = page;
              fromBaseline += 1;
            }
          }
          hash.update(buffer);
          bytes += length;
          address += this.pageSize;
        }
      }
    } finally {
      await baseline.close();
    }
    const result = {
      sha256: hash.digest('hex'),
      bytes,
      fromBaseline,
      fromDelta,
      missing: missing.length,
      missingPages: missing.slice(0, 16),
      complete: missing.length === 0,
      deltas: deltas.length,
    };
    if (strict && !result.complete) {
      const error = new Error(
        `重建不完整：${result.missing} 页没有记录（例如 ${result.missingPages.join(', ')}）；`
        + '此时任何「与独立 dump 散列一致」的结论都不成立，因为缺的页被按 '
        + `0x${fillByte.toString(16)} 填充过`,
      );
      error.code = 'ram-incomplete';
      error.detail = { missing: result.missing, missingPages: result.missingPages };
      throw error;
    }
    return result;
  }
}
