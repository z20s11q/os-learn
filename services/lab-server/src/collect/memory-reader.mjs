/**
 * memory-reader：完整 RAM 基线 / 脏页增量 / 可选局部采集（T06 第 2 条，E14）。
 *
 * 三条取数原则：
 * 1. **认证不认事件**：判断「哪一页变了」靠把物理内存按页重新读一遍并比散列，
 *    不靠事件推断。这样 CPU 写、DMA 写、设备写（例如 virtio-blk 的数据搬运）
 *    一律同等对待——事件只是**旁证**，用来发现「扫描漏了哪一页」，不是替代品。
 *    反过来也只做这一件事：事件派生的页集合与扫描出的变化页集合做差，
 *    差出来的就是漏采，显式列出来而不是当作没发生。
 * 2. **基线必须完整**：`complete=false` 的基线不能用来宣称「整份 RAM 可查」，
 *    也不能拿去和独立 dump 比散列。
 * 3. **进增量的页要留内容**：散列只用来判断变没变，能自证的产物必须带字节，
 *    所以变化页会按实际偏移再读一次并落盘。
 *
 * 局部采集（`readLocal`）同样按 captureId 落进增量，这样「选中的几页」在
 * 历史模式下也是可读的；不落盘的局部读只存在于响应里，不在历史里。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { diffSweep, missedByEvents, sweepRam } from '../../../../packages/trace-format/ram.ts';
import { RamStore, normalizeRegions } from './ram-store.mjs';

/** 只把 `kind=ram` 的区域当作「可变内存」：ROM/ROMD 的内容不随运行变化。 */
export const MUTABLE_RAM_KINDS = ['ram'];

/**
 * 「完整 RAM」= 机器的系统内存，按区域名判定。
 *
 * 为什么不能只看 `kind=ram`：QEMU 的显存（`vga.vram`，0xfd000000 起 16 MiB）也是
 * RAM 区域，`memory_region_is_ram()` 一样为真，所以观察者给它的 kind 就是 `ram`。
 * 但它不属于系统内存——它坐在 PCI 显存窗口里，HMP `pmemsave 0 <RAM 大小>` 那份
 * 独立全量 dump 里根本没有它。把它算进基线会有两个后果：基线散列永远对不上
 * 独立 dump（E14 的判据），而「完整 RAM 基线」这句话本身也不再成立。
 *
 * 显存内容并没有丢：按地址的物理直读那条路照样能读它（设备面板就是那么取的），
 * 只是不进 RAM 基线、不参与脏页增量。
 */
export const MACHINE_RAM_NAMES = ['pc.ram'];

export function ramRegionsOf(capture, { kinds = MUTABLE_RAM_KINDS, names = MACHINE_RAM_NAMES } = {}) {
  return normalizeRegions(capture?.regions ?? [], { kinds, names });
}

export function pageAligned(address, pageSize = 4096n) {
  return (BigInt(address) / pageSize) * pageSize;
}

export class MemoryCollector {
  constructor({ dir, pageSize = 4096 }) {
    this.pageSize = pageSize;
    this.store = new RamStore({ dir, pageSize });
  }

  get root() {
    return this.store.dir;
  }

  /** 全量 RAM 基线。返回落盘元数据 + 覆盖统计。 */
  async baseline({ captureId, regions, reader, onProgress = null }) {
    if (regions.length === 0) {
      throw new Error('本次采集没有可直读的 RAM 区域（区域表里 kind=ram 的可读区域为空），不能声称做过全量基线');
    }
    const meta = await this.store.writeBaseline({ captureId, regions, reader, onProgress });
    return {
      ...meta,
      coverage: {
        mode: 'full-ram-delta',
        pages: meta.pages,
        bytes: meta.bytes,
        // 基线本身就是「全量的当前内容」，相对基线脏页数为 0
        dirtyPages: 0,
        ramSha256: meta.rawSha256,
        note: meta.complete
          ? `完整 RAM 基线：${regions.map((region) => region.name).join('+')}，`
            + `${meta.pages} 页 / ${meta.bytes} 字节，内容散列即 rawSha256`
          : `基线不完整：${meta.regionPages - meta.pages} 页没有采到，不能据此宣称整份 RAM 可查`,
      },
    };
  }

  /**
   * 脏页增量：把 RAM 重扫一遍，与基线比散列，把变化的页内容落盘。
   *
   * `captureId` 是**基线那一代**的标识（增量挂在基线的版本链上），
   * `observedAtCaptureId` 是这次扫描实际发生在哪一次采集——两者必须分开记，
   * 否则「重建一份 RAM」时会在错误的目录里找基线与增量。
   */
  async delta({ captureId, observedAtCaptureId = null, regions, reader, note = null, onPage = null }) {
    const baseline = await this.store.openBaseline(captureId);
    let sweep;
    try {
      sweep = await sweepRam(reader, {
        regions,
        pageSize: this.pageSize,
        onPage: onPage ?? undefined,
      });
      const diff = diffSweep(baseline.index, sweep);
      const pages = [];
      for (const address of diff.changed) {
        const bytes = await reader.read(address, Number(this.pageSize));
        pages.push({ address, bytes: Buffer.from(bytes) });
      }
      const record = await this.store.writeDelta({
        captureId,
        parentCaptureId: captureId,
        tag: 'full-ram-sweep',
        pages,
        note: note ?? (observedAtCaptureId === null
          ? null
          : `在采集 ${observedAtCaptureId} 的停止点上重扫，与基线 ${captureId} 比散列`),
      });
      return {
        delta: record,
        observedAtCaptureId,
        diff: {
          changed: diff.changed.map((address) => `0x${address.toString(16)}`),
          added: diff.added.map((address) => `0x${address.toString(16)}`),
          unreadable: diff.unreadable.map((address) => `0x${address.toString(16)}`),
          unchanged: diff.unchanged,
          absent: diff.absent,
        },
        sweep: {
          pages: sweep.pages.length,
          bytesRead: sweep.bytesRead.toString(),
          physicalReads: sweep.physicalReads,
          skipped: sweep.skipped.map((entry) => ({
            address: `0x${entry.address.toString(16)}`,
            code: entry.code,
            reason: entry.reason,
          })),
          elapsedMs: sweep.elapsedMs,
        },
      };
    } finally {
      await baseline.close();
    }
  }

  /**
   * 可选局部内存采集：读一段（可跨页）并落进增量。
   * 返回的字节同时用于响应，「落盘」保证它在历史里也读得到。
   */
  async readLocal({ captureId, parentCaptureId = null, address, length, reader }) {
    const start = pageAligned(address, BigInt(this.pageSize));
    const end = BigInt(address) + BigInt(length);
    const pages = [];
    for (let page = start; page < end; page += BigInt(this.pageSize)) {
      const within = end - page < BigInt(this.pageSize) ? end - page : BigInt(this.pageSize);
      const bytes = Buffer.from(await reader.read(page, Number(within)));
      pages.push({ address: page, bytes });
    }
    const record = await this.store.writeDelta({
      captureId,
      parentCaptureId,
      tag: 'selected-pages',
      pages,
      note: `局部采集 0x${BigInt(address).toString(16)} 起 ${length} 字节`,
    });
    return record;
  }

  async readRecorded({ captureId, address, length }) {
    return this.store.readRecorded({ captureId, address, length });
  }

  async reconstruct(captureId, options = {}) {
    return this.store.reconstructedHash({ captureId, ...options });
  }

  async deltas(captureId) {
    return this.store.listDeltas(captureId);
  }

  /** 列出已经做过基线的采集代（按目录 mtime 从新到旧）。 */
  async baselineCaptures() {
    let names = [];
    try {
      const { readdir } = await import('node:fs/promises');
      names = await readdir(this.store.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const info = await this.store.baselineInfo(name);
      if (info === null) continue;
      out.push({ captureId: name, info });
    }
    out.sort((a, b) => String(b.info.generatedAt).localeCompare(String(a.info.generatedAt)));
    return out;
  }

  /** 最近一次完成的基线；缺失时返回 null（调用方据此报「还没有基线」）。 */
  async latestBaselineCapture() {
    const captures = await this.baselineCaptures();
    return captures.length === 0 ? null : captures[0].captureId;
  }

  async baselineInfo(captureId) {
    return this.store.baselineInfo(captureId);
  }

  async verifyBaseline(captureId) {
    return this.store.verifyBaseline(captureId);
  }

  /* ---------- 分页上下文的落盘 ---------- */

  /**
   * 分页上下文随采集代落盘。
   *
   * 为什么必须写盘而不是留在内存里：历史帧的地址翻译要用**那一帧的 CR3**。
   * 如果翻译时现读寄存器，用的是「现在的」页表——地址看着翻译得通，
   * 但描述的是另一个时刻的地址空间，等于悄悄把历史换成了现在。
   * 所以 `describe()` 的结果连同 CR0/CR3/CR4/EFER/CPL/模式一起落进
   * `ram/<captureId>/paging.json`，历史翻译只认它。
   */
  pagingPath(captureId) {
    return path.join(this.store.dir, captureId, 'paging.json');
  }

  async writePaging({ captureId, paging }) {
    if (typeof captureId !== 'string' || captureId.length === 0) {
      throw new Error('writePaging 需要 captureId');
    }
    const file = this.pagingPath(captureId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(paging, null, 2)}\n`);
    return file;
  }

  /** 读回某一次采集的分页上下文；没记录过就返回 null（不猜、不用当前值替代）。 */
  async readPaging(captureId) {
    if (typeof captureId !== 'string' || captureId.length === 0) return null;
    try {
      return JSON.parse(await fsp.readFile(this.pagingPath(captureId), 'utf8'));
    } catch {
      return null;
    }
  }

  hasPaging(captureId) {
    try {
      return fs.statSync(this.pagingPath(captureId)).isFile();
    } catch {
      return false;
    }
  }

  /** 覆盖统计（契约 MemoryCoverageStats）。 */
  async coverage({ captureId, selectedPages = 0, selectedBytes = 0 } = {}) {
    const info = await this.store.baselineInfo(captureId);
    if (info === null) {
      return {
        mode: 'selected-pages',
        pages: selectedPages,
        bytes: selectedBytes,
        dirtyPages: null,
        ramSha256: null,
        note: '本代采集只有按需读取的页，没有全量 RAM 基线；任意地址的历史回读需要先做基线',
      };
    }
    const deltas = await this.store.listDeltas(captureId);
    const dirty = deltas.reduce((sum, delta) => sum + (delta.pages ?? 0), 0);
    return {
      mode: 'full-ram-delta',
      pages: info.pages,
      bytes: info.bytes,
      dirtyPages: dirty,
      ramSha256: info.rawSha256,
      note: info.complete
        ? `完整 RAM 基线 + ${deltas.length} 份增量（共 ${dirty} 页变化）`
        : `基线不完整（缺 ${info.regionPages - info.pages} 页）；不要把「无基线」当成「内容为零」`,
    };
  }

  /**
   * 事件旁证：把窗口内的事件派生出的物理页与扫描出的变化页做差。
   *
   * `derived` 只接受**物理地址**的页（`dma.*` 事件报的是物理地址；
   * `memory.*` 报的是线性地址，没有 CR3 就换不出物理页，不能混进来）；
   * 差集非空说明「扫描没看到事件说变过的那一页」，这才是漏采。
   */
  crossCheckEvents({ derivedPhysicalPages = [], changedPages = [] }) {
    const missed = missedByEvents(derivedPhysicalPages, changedPages);
    return {
      derived: derivedPhysicalPages.length,
      changed: changedPages.length,
      missed: missed.map((address) => `0x${address.toString(16)}`),
      complete: missed.length === 0,
    };
  }
}
