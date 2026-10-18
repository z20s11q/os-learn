/**
 * 多阶段符号解析（T03e）。
 *
 * 启动过程跨多个可执行体：SeaBIOS 固件、GRUB、Linux setup、解压器、主内核模块。
 * 关键难点是同名符号：`startup_64` 在解压器 vmlinux 和主内核 vmlinux 中都存在，
 * 仅按名字解析会产生歧义，必须按模块限定或用实际装载地址判定。
 *
 * 本模块只做只读解析：读取 ELF 符号表，目标进程状态保持原值。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `nm` 结果跨会话缓存。符号表是只读的，且 92k 条目的解析/排序开销较大；
 * 以文件 mtime + size 为键，重新链接后自动重新读取。
 */
const NM_CACHE = new Map();

/** 阶段定义。symbolFile 为 null 表示当前带符号产物缺失。 */
export function symbolStages(root) {
  const relative = (target) => path.join(root, target);
  return [
    {
      id: 'seabios',
      label: 'SeaBIOS 固件',
      kind: 'firmware',
      symbolFile: null,
      symbolFileReason: '只有裸 ROM（/usr/share/seabios/bios-256k.bin），没有带调试符号的 ELF，无法按符号停点',
      loadRange: { start: 0xf0000n, end: 0x100000n, measured: false },
      note: '复位后运行的 16 位固件；可在给定物理地址读 ROM 字节，但无法按符号名解析',
    },
    {
      id: 'grub',
      label: 'GRUB 引导器',
      kind: 'bootloader',
      symbolFile: null,
      symbolFileReason: '/usr/lib/grub/i386-pc/*.mod 是可重定位模块且无调试符号',
      loadRange: null,
      note: '从 MBR/El Torito 进入；装载地址未实测，当前无法定位符号',
    },
    {
      id: 'linux-setup',
      label: 'Linux setup',
      kind: 'setup',
      symbolFile: relative('artifacts/build/linux/arch/x86/boot/setup.elf'),
      loadRange: null,
      note: 'setup 代码；装载地址未实测，加载符号前需要先确定 .text 物理地址',
    },
    {
      id: 'linux-decompressor',
      label: 'Linux 解压器',
      kind: 'decompressor',
      symbolFile: relative('artifacts/build/linux/arch/x86/boot/compressed/vmlinux'),
      loadRange: null,
      note: 'bzip/gzip 解压与重定位；与主内核存在同名 startup_64',
    },
    {
      id: 'linux-kernel',
      label: 'Linux 内核',
      kind: 'kernel',
      symbolFile: relative('artifacts/build/linux/vmlinux'),
      loadRange: { start: 0xffffffff80000000n, end: 0xffffffffc0000000n, measured: true },
      note: '主内核镜像，链接在 0xffffffff81000000 起的高半区',
    },
  ];
}

/** 解析 `nm -n` 输出。 */
export function parseNmOutput(text) {
  const symbols = [];
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, address, type, name] = match;
    symbols.push({
      name: name.trim(),
      address: BigInt(`0x${address}`),
      type,
      global: type === type.toUpperCase() && type !== '?',
    });
  }
  return symbols.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

export class SymbolRegistry {
  constructor({ root, stages = symbolStages(root) }) {
    this.root = root;
    this.stages = stages.map((stage) => ({ ...stage }));
    this.tables = new Map();
    /** 传给 GDB add-symbol-file 的 .text 装载地址 */
    this.loadAddresses = new Map();
    /** 符号表链接地址对应的运行时基址（ELF 的 .text 地址已被减掉） */
    this.loadBases = new Map();
  }

  stage(stageId) {
    return this.stages.find((entry) => entry.id === stageId) ?? null;
  }

  /** 该阶段是否具备可解析的符号表。 */
  available(stageId) {
    const stage = this.stage(stageId);
    if (!stage?.symbolFile) return false;
    try {
      return fs.statSync(stage.symbolFile).isFile();
    } catch {
      return false;
    }
  }

  /** 列出各阶段可用性，供界面显示与禁用不可解析的课程。 */
  availability() {
    return this.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      kind: stage.kind,
      hasSymbols: this.available(stage.id),
      symbolFile: stage.symbolFile,
      reason: stage.symbolFile ? null : stage.symbolFileReason ?? '没有符号文件',
      loadAddress: this.loadAddresses.get(stage.id) ?? null,
      loadRange: stage.loadRange
        ? {
            start: `0x${stage.loadRange.start.toString(16)}`,
            end: `0x${stage.loadRange.end.toString(16)}`,
            measured: stage.loadRange.measured,
          }
        : null,
      note: stage.note ?? null,
    }));
  }

  /** 懒加载某阶段的符号表。 */
  table(stageId) {
    if (this.tables.has(stageId)) return this.tables.get(stageId);
    const stage = this.stage(stageId);
    if (!stage?.symbolFile || !fs.existsSync(stage.symbolFile)) {
      this.tables.set(stageId, []);
      return [];
    }
    const stat = fs.statSync(stage.symbolFile);
    const cacheKey = `${stage.symbolFile}:${stat.mtimeMs}:${stat.size}`;
    const cached = NM_CACHE.get(cacheKey);
    if (cached !== undefined) {
      this.tables.set(stageId, cached);
      return cached;
    }
    let output = '';
    try {
      output = execFileSync('nm', ['-n', stage.symbolFile], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (error) {
      this.tables.set(stageId, []);
      throw new Error(`无法读取符号表 ${stage.symbolFile}: ${error.message}`);
    }
    const symbols = parseNmOutput(output);
    if (NM_CACHE.size >= 16) NM_CACHE.clear();
    NM_CACHE.set(cacheKey, symbols);
    this.tables.set(stageId, symbols);
    return symbols;
  }

  /**
   * 按名字解析符号。
   *
   * - 指定 module 时只在该阶段内解析。
   * - 省略 module 时汇总所有阶段的匹配，返回全部候选。
   * 调用方必须检查 ambiguous：同名符号（例如 startup_64）须以模块或实测地址限定后使用。
   */
  resolve(name, { module } = {}) {
    const stageIds = module ? [module] : this.stages.map((stage) => stage.id);
    const candidates = [];
    for (const stageId of stageIds) {
      const stage = this.stage(stageId);
      if (!stage) continue;
      for (const symbol of this.table(stageId)) {
        if (symbol.name === name) {
          candidates.push({
            module: stageId,
            moduleLabel: stage.label,
            symbol: symbol.name,
            address: `0x${symbol.address.toString(16)}`,
            type: symbol.type,
            global: symbol.global,
            loadAddress: this.loadAddresses.get(stageId) ?? null,
          });
        }
      }
    }
    const distinctModules = new Set(candidates.map((entry) => entry.module));
    return {
      name,
      module: module ?? null,
      found: candidates.length > 0,
      ambiguous: distinctModules.size > 1,
      candidates,
    };
  }

  /**
   * 记录实测的装载地址。解压器/setup 的物理装载位置只能由运行观察得到，
   * 符号装载以运行时测得的基址为前提。
   */
  setLoadAddress(stageId, address, { base = null } = {}) {
    const stage = this.stage(stageId);
    if (!stage) throw new Error(`未知阶段: ${stageId}`);
    const value = typeof address === 'bigint' ? address : BigInt(address);
    this.loadAddresses.set(stageId, `0x${value.toString(16)}`);
    // `base` 是符号表链接地址 0 对应的运行时地址；对解压器就等于 .text 装载地址，
    // 对 setup 则是 .text 地址减去 ELF 的 .text 段链接地址（0x402）。
    const origin = base === null ? value : (typeof base === 'bigint' ? base : BigInt(base));
    this.loadBases.set(stageId, origin);
    if (stage.symbolFile) {
      const table = this.table(stageId);
      const low = table[0]?.address ?? 0n;
      stage.loadRange = { start: origin + low, end: origin + (table.at(-1)?.address ?? low), measured: true };
    }
    return this.loadAddresses.get(stageId);
  }

  baseOf(stageId) {
    return this.loadBases.get(stageId) ?? null;
  }

  /**
   * 按运行时地址找最近的符号（T10a 的启动阶段源码映射）。
   *
   * GDB 在多个 objfile 共用低地址时会把 0x11171 报成别的符号；这里用本阶段的
   * 装载基址 + 自己的符号表独立算一次，结果仍要满足 address >= 符号地址，
   * 超出最后一个符号时不硬归因。
   */
  symbolAt(stageId, address) {
    const stage = this.stage(stageId);
    if (!stage?.symbolFile) return null;
    const base = this.loadBases.get(stageId);
    if (base === null || base === undefined) return null;
    const value = typeof address === 'bigint' ? address : BigInt(address);
    if (value < base) return null;
    const offset = value - base;
    const table = this.table(stageId);
    let low = 0;
    let high = table.length - 1;
    let found = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (table[mid].address <= offset) {
        found = table[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found === null) return null;
    return {
      symbol: found.name,
      offset: Number(offset - found.address),
      linkAddress: found.address,
      loadAddress: base,
      address: value,
      module: stageId,
    };
  }

  loadAddressOf(stageId) {
    return this.loadAddresses.get(stageId) ?? null;
  }

  /**
   * 判定某个线性地址落在哪个阶段。
   * 只使用已实测的装载范围；未实测的返回 null 并说明原因。
   */
  stageForAddress(address) {
    const value = typeof address === 'bigint' ? address : BigInt(address);
    const matches = [];
    for (const stage of this.stages) {
      const range = stage.loadRange;
      if (!range) continue;
      if (value >= range.start && value < range.end) {
        matches.push({ id: stage.id, label: stage.label, measured: range.measured });
      }
    }
    if (matches.length === 0) {
      return {
        address: `0x${value.toString(16)}`,
        stage: null,
        reason: '没有已实测的装载范围覆盖该地址；解压器/setup 的装载地址需要在运行中观察后登记',
      };
    }
    const unmeasured = matches.filter((entry) => !entry.measured);
    return {
      address: `0x${value.toString(16)}`,
      stage: matches[0].id,
      label: matches[0].label,
      measured: matches[0].measured,
      candidates: matches,
      reason: unmeasured.length > 0 ? '该地址落在未实测的范围上，结果可能不准确' : null,
    };
  }

  /**
   * 生成 add-symbol-file 命令列表。
   * 主内核已经通过 -file-exec-and-symbols 加载，不重复添加。
   */
  addSymbolFileCommands({ skip = ['linux-kernel'] } = {}) {
    const commands = [];
    const pending = [];
    for (const stage of this.stages) {
      if (skip.includes(stage.id)) continue;
      if (!this.available(stage.id)) {
        pending.push({ module: stage.id, reason: stage.symbolFileReason ?? '没有符号文件' });
        continue;
      }
      const loadAddress = this.loadAddresses.get(stage.id);
      if (!loadAddress) {
        pending.push({
          module: stage.id,
          reason: '装载地址未实测；先观察实际物理地址再加载符号，避免用错误地址停点',
        });
        continue;
      }
      commands.push({
        module: stage.id,
        file: stage.symbolFile,
        textAddress: loadAddress,
        command: `add-symbol-file ${stage.symbolFile} ${loadAddress}`,
      });
    }
    return { commands, pending };
  }

  /** 按符号名生成断点位置；歧义时返回错误及候选。 */
  breakpointSpec(name, { module } = {}) {
    const resolved = this.resolve(name, { module });
    if (!resolved.found) {
      return { ok: false, reason: `未找到符号 ${name}${module ? ` (模块 ${module})` : ''}` };
    }
    if (resolved.ambiguous) {
      return {
        ok: false,
        reason: `符号 ${name} 在多个模块中存在，必须用模块限定`,
        candidates: resolved.candidates,
      };
    }
    const [candidate] = resolved.candidates;
    return { ok: true, module: candidate.module, address: candidate.address, candidate };
  }
}
