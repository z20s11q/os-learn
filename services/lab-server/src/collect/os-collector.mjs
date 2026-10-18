/**
 * Linux 对象采集（T07/T08 集成层）。
 *
 * 解析器本身在 `packages/linux-decoder/`，只吃 `ReadOnlyCapture`；这一层负责把
 * 「本帧的 CPU 状态 + 绑定 captureId 的物理读取器 + vmlinux 符号」接成那份接口。
 *
 * 三条边界：
 * 1. 只读。所有字节都从 `CaptureReader`（x-oslab-read-physical，绑定 captureId）来；
 *    不调用客体函数，不回退到「读当前 VM」的 GDB 通道。
 * 2. 虚拟地址走本帧自己的 CR3/CR0/CR4/EFER 翻译（`PageWalker`），并且以 CPL=0
 *    读取内核页——调试器读内存不受客体 U/S 位限制，但页表翻译仍必须用客体页表。
 * 3. 失败就是失败：任何一步读不到都进 `notes`/`unavailable`，不编造进程或文件。
 */

import fs from 'node:fs';
import path from 'node:path';

import { KernelLayout } from '../../../../packages/linux-decoder/layout.ts';
import { CaptureReadError, KernelMemoryView } from '../../../../packages/linux-decoder/capture.ts';
import { readCurrentTask, readTask, readTaskList, toProcessRef } from '../../../../packages/linux-decoder/objects/task.ts';
import { PerCpuIndex } from '../../../../packages/linux-decoder/objects/percpu.ts';
import {
  readMm,
  readVmas,
  toAddressSpaceRef,
} from '../../../../packages/linux-decoder/objects/mm.ts';
import {
  listOpenFds,
  pageCacheFolioRef,
  readFileChain,
  readFilesForTask,
  toFileRef,
} from '../../../../packages/linux-decoder/objects/files.ts';
import { PageWalker } from './page-walker.mjs';
import { toBigIntValue } from './capture-reader.mjs';

const PAGE_SIZE = 4096n;
const DECODER_VERSION = 'linux-decoder/1';
const MAX_TASKS = 80;
const MAX_FILES = 10;
const MAX_PAGE_CACHE = 12;
const MAX_VMAS = 128;

/**
 * 布局/符号缓存：同一份 vmlinux + layout 在多个会话之间只解析一次。
 *
 * `KernelLayout.load(..., {vmlinux})` 会重算 243 MiB vmlinux 的 SHA-256，并解析
 * 十几 MiB 的布局 JSON；System.map 也有 4 MiB。每次会话都做一遍会让“开始实验”
 * 有 1–2 秒的无谓停顿，而且结果完全相同。缓存键带上 mtime/size，重新构建后自动失效。
 */
const LAYOUT_CACHE = new Map();
const LAYOUT_CACHE_LIMIT = 3;

/** 解析 System.map：`地址 类型 名字`。重名只保留第一个（内核符号表里重复项不增加信息）。 */
export function parseSystemMap(text) {
  const symbols = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const name = match[3].trim();
    if (!symbols.has(name)) symbols.set(name, BigInt(`0x${match[1]}`));
  }
  return symbols;
}

/**
 * `ReadOnlyCapture` 的 captureId 绑定实现。
 *
 * `readVirtual` 按页翻译后只读物理 RAM，因此同一份数据集可以在 VM 停止点之后
 * 继续被解析，而不会读到「下一帧」的内存。
 */
export class CaptureBoundReader {
  constructor({ reader, frame, layout, symbols, walker = null }) {
    this.reader = reader;
    this.frame = frame;
    this.layout = layout;
    this.symbols = symbols;
    this.walker = walker;
    this.reads = 0;
    this.bytes = 0;
    this.attribution = {
      sessionId: frame.sessionId,
      epoch: frame.epoch,
      frameId: frame.frameId,
      captureId: frame.captureId,
    };
    this.kernelRelease = layout?.linuxRelease ?? null;
  }

  async readVirtual(address, length) {
    if (!Number.isInteger(length) || length < 0) {
      throw new CaptureReadError('invalid-length', `读取长度必须是非负整数，收到 ${length}`, {
        address: `0x${BigInt(address).toString(16)}`,
      });
    }
    if (length === 0) return new Uint8Array(0);
    if (this.walker === null) {
      throw new CaptureReadError('no-paging-context', '本帧没有可用的分页上下文，读不了内核虚拟地址', {
        captureId: this.attribution.captureId,
      });
    }
    const out = Buffer.alloc(length);
    const end = address + BigInt(length);
    let cursor = address;
    let filled = 0;
    while (cursor < end) {
      const translation = await this.walker.translate(cursor);
      if (translation.physical === null) {
        throw new CaptureReadError(
          'translation-failed',
          `线性地址 0x${cursor.toString(16)} 翻译失败：${translation.fault?.detail ?? '未知原因'}`,
          { address: `0x${cursor.toString(16)}`, fault: translation.fault ?? null },
        );
      }
      const withinPage = cursor & (PAGE_SIZE - 1n);
      const take = Number(
        (end - cursor) < (PAGE_SIZE - withinPage) ? (end - cursor) : (PAGE_SIZE - withinPage),
      );
      const bytes = await this.reader.read(BigInt(translation.physical), take);
      if (bytes.length !== take) {
        throw new CaptureReadError('short-read', `物理读只返回 ${bytes.length}/${take} 字节`, {
          address: translation.physical,
          length: take,
        });
      }
      out.set(bytes, filled);
      filled += take;
      cursor += BigInt(take);
      this.reads += 1;
      this.bytes += take;
    }
    return new Uint8Array(out);
  }

  symbolAddress(name) {
    return this.symbols?.get(name) ?? null;
  }

  symbolSize() {
    // System.map 不带大小。需要大小的调用方（例如按符号范围匹配课程）会拿到 null，
    // 这不是错误，表示「这张表没有提供」。
    return null;
  }
}

export class OsCollector {
  constructor({ root }) {
    this.root = root;
    this.layout = null;
    this.symbols = null;
    this.ready = false;
    this.reason = '尚未加载布局产物';
    this.layoutFile = null;
    this.#load();
  }

  #load() {
    try {
      const layoutDir = path.join(this.root, 'artifacts/layout');
      const files = fs.existsSync(layoutDir)
        ? fs.readdirSync(layoutDir).filter((name) => name.endsWith('.json')).sort()
        : [];
      if (files.length === 0) {
        this.reason = '没有 artifacts/layout/*.json：先运行 T07a 的布局生成器';
        return;
      }
      const layoutFile = path.join(layoutDir, files.at(-1));
      const vmlinux = path.join(this.root, 'artifacts/build/linux/vmlinux');
      const systemMap = path.join(this.root, 'artifacts/build/linux/System.map');
      if (!fs.existsSync(systemMap)) {
        this.reason = '缺少 artifacts/build/linux/System.map：无法做 per-CPU/对象遍历';
        return;
      }
      const layoutStat = fs.statSync(layoutFile);
      const vmlinuxStat = fs.existsSync(vmlinux) ? fs.statSync(vmlinux) : null;
      const mapStat = fs.statSync(systemMap);
      const cacheKey = [
        layoutFile, layoutStat.mtimeMs, layoutStat.size,
        vmlinuxStat?.mtimeMs ?? 0, vmlinuxStat?.size ?? 0,
        mapStat.mtimeMs, mapStat.size,
      ].join(':');
      const cached = LAYOUT_CACHE.get(cacheKey);
      if (cached !== undefined) {
        this.layout = cached.layout;
        this.symbols = cached.symbols;
        this.layoutFile = layoutFile;
        this.ready = true;
        this.reason = null;
        return;
      }
      this.layout = KernelLayout.load(layoutFile, vmlinuxStat === null ? {} : { vmlinux });
      this.layoutFile = layoutFile;
      this.symbols = parseSystemMap(fs.readFileSync(systemMap, 'utf8'));
      if (LAYOUT_CACHE.size >= LAYOUT_CACHE_LIMIT) LAYOUT_CACHE.clear();
      LAYOUT_CACHE.set(cacheKey, { layout: this.layout, symbols: this.symbols });
      this.ready = true;
      this.reason = null;
    } catch (error) {
      this.ready = false;
      this.reason = `加载 Linux 布局失败：${error.message}`;
    }
  }

  status() {
    return {
      ready: this.ready,
      reason: this.reason,
      layoutFile: this.layoutFile === null ? null : path.relative(this.root, this.layoutFile),
      linuxRelease: this.layout?.linuxRelease ?? null,
      buildId: this.layout?.buildId ?? null,
      symbolCount: this.symbols?.size ?? 0,
      decoderVersion: DECODER_VERSION,
    };
  }

  /**
   * 为一个停止点建立 capture 绑定读取器。collect 与 collectForPid 共用，
   * 保证「选中进程详情」也走同一套页表翻译和只读物理读。
   */
  #createCapture(frame, reader) {
    const walker = new PageWalker({
      // 调试器读内核内存不受客体 CPL 限制，但页表翻译必须用客体页表；
      // 用 CPL=0 是为了让 U/S 位按「内核访问」判定，而不是伪造一个用户态读。
      cpu: { ...frame.cpu, cpl: 0 },
      attribution: {
        sessionId: frame.sessionId,
        epoch: frame.epoch,
        frameId: frame.frameId,
        captureId: frame.captureId,
      },
      reader: { read: (address, length) => reader.read(address, length) },
      readerSource: 'observer',
    });
    const capture = new CaptureBoundReader({
      reader,
      frame,
      layout: this.layout,
      symbols: this.symbols,
      walker,
    });
    return { walker, capture, view: new KernelMemoryView(capture) };
  }

  /** 读取选中任务的 mm/VMA、fd 链与页缓存；collect 和按 pid 详情共用。 */
  async #readSelectedDetails({ view, walker, selectedTask, notes }) {
    let addressSpace = null;
    const files = [];
    const folios = [];
    if (selectedTask !== null && selectedTask.mm !== null) {
      try {
        const mm = await readMm(view, this.layout, selectedTask.mm);
        let pgdPhysical = null;
        try {
          const translation = await walker.translate(mm.pgd);
          pgdPhysical = translation.physical === null ? null : BigInt(translation.physical);
        } catch {
          pgdPhysical = null;
        }
        const vmaResult = await readVmas(view, this.layout, selectedTask.mm, {
          maxNodes: MAX_VMAS * 2,
        });
        addressSpace = toAddressSpaceRef(vmaResult, {
          pid: selectedTask.pid,
          pgdPhysical,
          structure: 'maple-tree',
        });
        if (vmaResult.violations.length > 0) notes.push(...vmaResult.violations.slice(0, 6));
        if (vmaResult.notes.length > 0) notes.push(...vmaResult.notes.slice(0, 6));
      } catch (error) {
        notes.push(`地址空间读取失败：${error.message}`);
      }
    }

    if (selectedTask !== null) {
      try {
        const filesStruct = await readFilesForTask(view, this.layout, selectedTask);
        if (filesStruct !== null) {
          const open = await listOpenFds(view, this.layout, filesStruct, { limit: MAX_FILES });
          if (open.notes.length > 0) notes.push(...open.notes);
          for (const entry of open.entries) {
            if (entry.inconsistent) {
              notes.push(`fd ${entry.fd} 的位图说打开，但槽是空指针`);
              continue;
            }
            try {
              const chain = await readFileChain(view, this.layout, {
                files: filesStruct,
                fd: entry.fd,
                resolvePath: true,
                readSuperBlock: false,
                readAddressSpace: true,
                readPageCache: true,
                pageCacheLimit: MAX_PAGE_CACHE,
              });
              files.push(toFileRef(chain));
              if (chain.notes.length > 0) notes.push(...chain.notes.slice(0, 3));
              if (chain.addressSpace !== null && chain.pageCache !== null) {
                for (const item of chain.pageCache.entries ?? []) {
                  const ref = pageCacheFolioRef(item, { inodeAddress: chain.inode?.address ?? null });
                  if (ref !== null) folios.push(ref);
                }
              }
            } catch (error) {
              notes.push(`fd ${entry.fd} 文件链读取失败：${error.message}`);
            }
          }
        }
      } catch (error) {
        notes.push(`fd 表读取失败：${error.message}`);
      }
    }
    return { addressSpace, files, folios };
  }

  /**
   * 按 pid 重新解析选中进程（T08 的“点谁看谁”）。
   *
   * 与 collect 的区别：不重新遍历进程链表、不重读 current，只读取目标 task 的
   * mm/fd/页缓存。调用方必须给出该帧已有的 os 快照，保证 current/processes
   * 仍是同一停止点的数据。
   */
  async collectForPid({ frame, reader, pid, baseOs }) {
    if (!this.ready) return { os: null, unavailable: `Linux 对象解析不可用：${this.reason}`, notes: [], stats: {} };
    if (!baseOs || !Array.isArray(baseOs.processes)) {
      return { os: null, unavailable: '没有可复用的帧内进程表，无法按 pid 做定向解析', notes: [], stats: {} };
    }
    const process = baseOs.processes.find((entry) => entry.pid === pid) ?? null;
    if (process === null) {
      return { os: null, unavailable: `本帧进程表里没有 pid=${pid}`, notes: [], stats: {} };
    }
    const { walker, capture, view } = this.#createCapture(frame, reader);
    const notes = [];
    let selectedTask;
    try {
      selectedTask = await readTask(view, this.layout, BigInt(process.taskAddress));
    } catch (error) {
      return {
        os: null,
        unavailable: `读取 task ${process.taskAddress} 失败：${error.message}`,
        notes,
        stats: { reads: capture.reads, bytes: capture.bytes },
      };
    }
    const selected = toProcessRef(selectedTask, { parentPid: process.parentPid ?? null });
    const { addressSpace, files, folios } = await this.#readSelectedDetails({
      view,
      walker,
      selectedTask,
      notes,
    });
    const os = {
      ...baseOs,
      selected,
      addressSpace,
      files,
      folios,
      evidence: {
        kind: 'decoded',
        source: 'linux-decoder',
        captureId: frame.captureId,
        refs: [
          `layout:${path.basename(this.layoutFile)}`,
          `tasks:${baseOs.processes.length}(reused)`,
          `selected:${selected.pid}`,
          `files:${files.length}`,
          `vmas:${addressSpace?.vmas.length ?? 0}`,
          'detail:targeted',
        ],
        reason: notes.length === 0 ? undefined : notes.slice(0, 8).join('；'),
      },
      notes: [...new Set([...(baseOs.notes ?? []), ...notes])].slice(0, 24),
    };
    return {
      os,
      unavailable: null,
      notes,
      stats: {
        reads: capture.reads,
        bytes: capture.bytes,
        pageWalk: walker.translations,
        tasks: 0,
        targetedTask: selected.pid,
        files: files.length,
        vmas: addressSpace?.vmas.length ?? 0,
      },
    };
  }

  /**
   * 采集一帧的 OS 对象。
   *
   * @returns {Promise<{os: object|null, unavailable: string|null, notes: string[], stats: object}>}
   */
  async collect({ frame, reader, selectedPid = null }) {
    if (!this.ready) {
      return { os: null, unavailable: `Linux 对象解析不可用：${this.reason}`, notes: [], stats: {} };
    }
    const cr0 = toBigIntValue(frame.cpu?.control?.cr0);
    const cr3 = toBigIntValue(frame.cpu?.control?.cr3);
    const cr4 = toBigIntValue(frame.cpu?.control?.cr4);
    if (frame.cpu?.mode !== 'long-64' || cr0 === null || cr3 === null || cr4 === null || (cr0 & 0x80000001n) !== 0x80000001n) {
      return {
        os: null,
        unavailable:
          '当前停止点还没有进入 64 位分页内核（需要 CR0.PG/PE 与 x86-64 模式）；'
          + '此时 Linux 对象/页表/进程视图不可用，不按「未分页」硬套',
        notes: [],
        stats: {},
      };
    }

    const notes = [];
    const { walker, capture, view } = this.#createCapture(frame, reader);

    let taskList = null;
    try {
      taskList = await readTaskList(view, this.layout, { limit: MAX_TASKS });
      if (taskList.notes.length > 0) notes.push(...taskList.notes);
    } catch (error) {
      return {
        os: null,
        unavailable: `进程链表读取失败：${error.message}`,
        notes,
        stats: { reads: capture.reads, bytes: capture.bytes },
      };
    }

    const taskByAddress = new Map(taskList.tasks.map((task) => [task.address.toString(), task]));
    const processRefs = taskList.tasks.map((task) => {
      const parent = task.realParent === null ? null : taskByAddress.get(task.realParent.toString()) ?? null;
      return toProcessRef(task, { parentPid: parent?.pid ?? null });
    });

    let current = null;
    const percpu = new PerCpuIndex(view, capture);
    // GDB 的 thread-id 从 1 开始，而 QEMU 的 CPU 号从 0 开始；同一个字段在不同
    // 适配层里的含义不能混。先按帧里的 cpuId 试，越界时回退 0，并如实记一条 note。
    let cpuId = Number.isInteger(frame.stop?.cpuId) ? frame.stop.cpuId : 0;
    try {
      const cpuCount = await percpu.cpuCount();
      if (cpuCount > 0 && (cpuId < 0 || cpuId >= cpuCount)) {
        notes.push(`帧内 cpuId=${cpuId} 超出 nr_cpu_ids=${cpuCount}（GDB thread-id 与 CPU 号不是同一编号）；current 改从 CPU 0 读取`);
        cpuId = 0;
      }
    } catch {
      cpuId = 0;
    }
    try {
      const currentTask = await readCurrentTask(view, this.layout, percpu, cpuId);
      current = toProcessRef(currentTask.task, {
        parentPid: taskByAddress.get(currentTask.task.realParent?.toString() ?? '')?.pid ?? null,
      });
    } catch (error) {
      notes.push(`current 读取失败：${error.message}`);
    }

    // 默认选中：current 有用户 mm 就选它；否则选 shell（idle 时 current 是 swapper/0，
    // 它的 mm 为空，把 fd/页缓存面板默认指向它只会得到一片“没有对象”）。
    const preferredPid = current?.mmAddress !== null && current?.mmAddress !== undefined
      ? current.pid
      : taskList.tasks.find((task) => task.mm !== null && ['sh', 'init', 'ash', 'busybox'].includes(task.comm))?.pid
        ?? current?.pid
        ?? null;
    const wantedPid = Number.isInteger(selectedPid) ? selectedPid : preferredPid;
    let selectedTask =
      (wantedPid === null ? null : taskList.tasks.find((task) => task.pid === wantedPid)) ??
      (current === null ? null : taskList.tasks.find((task) => task.pid === current.pid)) ??
      null;
    // current 读不到时不要给一个空选中：优先选有用户地址空间的服务进程，
    // 这样 shell/实验进程的 mm、fd、页缓存仍然可查；选择依据写进 note。
    if (selectedTask === null) {
      selectedTask = taskList.tasks.find((task) => task.mm !== null && ['sh', 'init', 'ash', 'busybox'].includes(task.comm))
        ?? taskList.tasks.find((task) => task.mm !== null)
        ?? null;
      if (selectedTask !== null) {
        notes.push(`current 不可用，选中进程回退到 pid=${selectedTask.pid} ${selectedTask.comm}（有用户地址空间）`);
      }
    }
    const selected = selectedTask === null
      ? null
      : toProcessRef(selectedTask, {
          parentPid: taskByAddress.get(selectedTask.realParent?.toString() ?? '')?.pid ?? null,
        });

    const { addressSpace, files, folios } = await this.#readSelectedDetails({
      view,
      walker,
      selectedTask,
      notes,
    });

    const os = {
      kernelRelease: this.layout.linuxRelease ?? 'unknown',
      initTaskAddress: `0x${taskList.initTask.toString(16)}`,
      current,
      selected,
      processes: processRefs,
      processesTruncated: taskList.truncated,
      addressSpace,
      files,
      folios,
      decoderVersion: DECODER_VERSION,
      evidence: {
        kind: 'decoded',
        source: 'linux-decoder',
        captureId: frame.captureId,
        refs: [
          `layout:${path.basename(this.layoutFile)}`,
          `tasks:${taskList.tasks.length}`,
          `selected:${selected?.pid ?? 'none'}`,
          `files:${files.length}`,
          `vmas:${addressSpace?.vmas.length ?? 0}`,
        ],
        reason: notes.length === 0 ? undefined : notes.slice(0, 8).join('；'),
      },
      notes: notes.slice(0, 20),
    };
    return {
      os,
      unavailable: null,
      notes,
      stats: {
        reads: capture.reads,
        bytes: capture.bytes,
        pageWalk: walker.translations,
        tasks: taskList.tasks.length,
        files: files.length,
        vmas: addressSpace?.vmas.length ?? 0,
      },
    };
  }
}
