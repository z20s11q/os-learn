/**
 * captureId 绑定的物理读取器（T06 任务卡第 5 条）。
 *
 * 为什么要有这一层：T05a 起的 `x-oslab-read-physical` 已经把读取**绑定到某一次
 * 采集**（captureId），观察者会用 vmGeneration 判断「这份快照是不是还在描述当前
 * 这台 VM」，过期就拒绝（vm-advanced / no-active-capture / capture-mismatch）。
 * 采集模块如果自己拼 QMP 调用，很容易在拒绝路径上顺手回退到 GDB 物理模式，
 * 那样读到的就是**当前的**内存，而请求说的是**历史某一帧**的内存——
 * 两者混在一份产物里，等于悄悄伪造了历史。所以这里只做一件事：
 * 把「按 captureId 读物理内存」做成一个不可回退的读取器。
 *
 * 分片规则来自观察者本身：`x-oslab-read-physical` 单次读取限定在一个区域内，
 * 单次上限是 `x-oslab-capabilities.memory.maxReadBytes`（当前 4096 字节），
 * 因此在这里按「区域表 + 上限」切分，而不是把观察者的 cross-region
 * 原样抛给上层。
 *
 * 可直读的判据也来自观察者（`readable` 字段）：只有 RAM/ROMD 这类 memcpy 直读
 * 区域才是安全的；MMIO 寄存器、未 ROMD 的 rom_device、ram_device 一旦读就会
 * 派发到设备 ops（可能取走 FIFO 数据或确认一次中断），一律拒绝。
 */

import { PhysicalReadError } from '../../../../packages/trace-format/paging.ts';

export const DEFAULT_MAX_READ_BYTES = 4096;

export function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

/** 把观察者返回的十进制/0x 字符串统一成 bigint；无法解析时返回 null。 */
export function toBigIntValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export class CaptureReader {
  /**
   * @param {object} options
   * @param {object} options.qmp QMP 适配器
   * @param {object} options.capture 观察者快照（含 captureId / regions）
   * @param {number} [options.maxReadBytes] 单次读取上限，取自 capabilities
   * @param {number} [options.timeoutMs]
   * @param {string} [options.source] 证据里记的来源标记
   */
  constructor({ qmp, capture, maxReadBytes = DEFAULT_MAX_READ_BYTES, timeoutMs = 20000, source = 'observer' } = {}) {
    if (!qmp) throw new Error('CaptureReader 需要 QMP 适配器');
    if (!capture || typeof capture.captureId !== 'string' || capture.captureId.length === 0) {
      throw new Error('CaptureReader 必须绑定一个带 captureId 的观察者快照');
    }
    this.qmp = qmp;
    this.capture = capture;
    this.maxReadBytes = Math.max(1, Number(maxReadBytes) || DEFAULT_MAX_READ_BYTES);
    this.timeoutMs = timeoutMs;
    this.source = source;
    this.reads = 0;
    this.bytesRead = 0n;
  }

  get captureId() {
    return this.capture.captureId;
  }

  get regions() {
    return Array.isArray(this.capture.regions) ? this.capture.regions : [];
  }

  /**
   * 把区域表整理成带 bigint 边界的列表，只保留可直读区域。
   * 不可直读的区域照样返回，但 `readable=false`，读取时会被拒绝并说明原因。
   */
  regionTable() {
    return this.regions
      .map((region) => {
        const base = toBigIntValue(region.base);
        const size = toBigIntValue(region.size);
        if (base === null || size === null || size <= 0n) return null;
        return {
          base,
          size,
          end: base + size,
          name: region.name ?? 'unnamed',
          kind: region.kind ?? 'unknown',
          readable: region.readable === true,
        };
      })
      .filter((entry) => entry !== null);
  }

  findRegion(address) {
    return this.regionTable().find((region) => address >= region.base && address < region.end) ?? null;
  }

  /**
   * 切分成「同一区域内 + 不超过单次上限」的分片。
   * 切不出来就抛 PhysicalReadError，绝不返回一段「读了一半」的结果。
   */
  plan(address, length) {
    if (!Number.isInteger(length) || length <= 0) {
      throw new PhysicalReadError('invalid-length', `读取长度必须是正整数，收到 ${length}`, {
        address: hex(address),
        length,
        captureId: this.captureId,
      });
    }
    const table = this.regionTable();
    const segments = [];
    const end = address + BigInt(length);
    let cursor = address;
    while (cursor < end) {
      const hit = table.find((region) => cursor >= region.base && cursor < region.end);
      if (!hit) {
        throw new PhysicalReadError(
          'range-not-captured',
          `物理地址 ${hex(cursor)} 不在本次采集的区域表里`,
          { address: hex(cursor), captureId: this.captureId },
        );
      }
      if (!hit.readable) {
        throw new PhysicalReadError(
          'mmio-side-effect',
          `物理地址 ${hex(cursor)} 属于不可直读区域 ${hit.name}（${hit.kind}）：读取可能取走设备状态或确认中断`,
          {
            address: hex(cursor),
            regionName: hit.name,
            regionKind: hit.kind,
            captureId: this.captureId,
          },
        );
      }
      const segmentEnd = hit.end < end ? hit.end : end;
      let pieceStart = cursor;
      while (pieceStart < segmentEnd) {
        const remaining = segmentEnd - pieceStart;
        const limit = BigInt(this.maxReadBytes);
        const pieceEnd = remaining > limit ? pieceStart + limit : segmentEnd;
        segments.push({ start: pieceStart, length: Number(pieceEnd - pieceStart) });
        pieceStart = pieceEnd;
      }
      cursor = segmentEnd;
    }
    return segments;
  }

  /**
   * 读物理内存。观察者拒绝时**不回退**到别的通道：拒绝本身就是结论
   * （快照过期、地址属于有副作用的 MMIO），换一条通道读同一地址会把
   * 「按 capture 读」的保证换掉。
   */
  async read(address, length) {
    const start = toBigIntValue(address);
    if (start === null) {
      throw new PhysicalReadError('invalid-address', `地址无法解析: ${String(address)}`, {
        captureId: this.captureId,
      });
    }
    const segments = this.plan(start, length);
    const chunks = [];
    for (const segment of segments) {
      const result = await this.qmp.observerReadPhysical(
        {
          captureId: this.captureId,
          address: hex(segment.start),
          length: segment.length,
        },
        { timeoutMs: this.timeoutMs },
      );
      if (result?.ok !== true) throw this.#refusal(result, segment);
      const bytes = Buffer.from(result.bytes ?? '', 'base64');
      if (bytes.length !== segment.length) {
        throw new PhysicalReadError(
          'short-read',
          `观察者返回 ${bytes.length} 字节，期望 ${segment.length} 字节（不拼接不完整的分片）`,
          { address: hex(segment.start), captureId: this.captureId },
        );
      }
      chunks.push(bytes);
      this.reads += 1;
      this.bytesRead += BigInt(bytes.length);
    }
    return Buffer.concat(chunks);
  }

  #refusal(result, segment) {
    const reason = result?.reason ?? 'unknown';
    const detail = {
      observerReason: reason,
      address: hex(segment.start),
      length: segment.length,
      captureId: this.captureId,
      regionName: result?.regionName ?? null,
      regionKind: result?.regionKind ?? null,
    };
    const message = result?.message ?? `观察者拒绝读取（${reason}）`;
    if (reason === 'side-effect-risk') {
      return new PhysicalReadError('mmio-side-effect', message, detail);
    }
    if (
      reason === 'vm-advanced'
      || reason === 'vm-running'
      || reason === 'no-active-capture'
      || reason === 'capture-mismatch'
    ) {
      return new PhysicalReadError('capture-invalid', message, detail);
    }
    // cross-region / memtx-error / out-of-range 都归到「这个范围本次没采到」
    return new PhysicalReadError('range-not-captured', message, detail);
  }
}
