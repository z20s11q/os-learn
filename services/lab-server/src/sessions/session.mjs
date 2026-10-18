/**
 * 调试会话编排（T03a–T03e）。
 *
 * 关键约束（总体方案 7.2）：
 * - 命令进入单会话串行队列，requestId 幂等。
 * - 普通 continue 只发一条继续命令；QMP 只承担同一控制器发起的管理操作。
 * - QMP 的 STOP 与 GDB 的停止通知是同一次停止，关联为单个停止点。
 * - 停止后再采集，采集失败保持上一个完整帧。
 * - 缺失能力如实标注，以 unavailable 标注缺失能力。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';

import { MI } from '../adapters/mi.mjs';
import { QMP } from '../adapters/qmp.mjs';
import { stopReasonOf } from '../adapters/mi-parse.mjs';
import { SymbolRegistry } from '../adapters/symbols.mjs';
import { ErrorCode } from '../../../../packages/contracts/errors.ts';
import { CaptureReader, toBigIntValue } from '../collect/capture-reader.mjs';
import { collectExtendedCpu, decodeCpuExecutionMode } from '../collect/cpu-extended.mjs';
import { PageWalker, pagingContextFor } from '../collect/page-walker.mjs';
import { MUTABLE_RAM_KINDS, MemoryCollector, ramRegionsOf } from '../collect/memory-reader.mjs';
import { decodeChainHead, decodeDeviceVirtqueues, mergeQueuesIntoSnapshot } from '../collect/virtqueue-decoder.mjs';
import { DiskVersionStore, defaultBasePath } from '../collect/disk-version-store.mjs';
import { OsCollector } from '../collect/os-collector.mjs';
import { DiskViewer } from '../collect/disk-viewer.mjs';
import { loadCurriculum, matchLesson } from '../curriculum/engine.mjs';
import {
  buildFilesystem,
  buildLessonCatalog,
  buildOsStatus,
  exportSessionRecording,
} from './session-views.mjs';
import { LabProcess } from './process.mjs';
import { ControlQueue } from './control-queue.mjs';

const SCHEMA_VERSION = 1;
const CHECKPOINT_EVERY = 100;
const TERMINAL_BUFFER_LIMIT = 256 * 1024;
/**
 * 全量 RAM 基线 / 脏页增量的控制队列超时。
 *
 * 这两个命令要按 4 KiB 把 512 MiB 读一遍（131072 次「绑定 captureId 的物理读」），
 * 在 TCG 上是分钟级；默认 20 秒超时会把「已经成功的长任务」判成超时失败，
 * 于是基线看起来永远建不起来。只有采集类长命令用这个更宽的上限。
 */
const LONG_CAPTURE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * virtio-blk 请求头（`struct virtio_blk_outhdr`）的长度。
 *
 * 设备从客体内存读到的第一段永远是这 16 字节请求头（扇区号/类型/保留字段），
 * 之后才是这次请求真正要搬的数据。取写载荷时必须把这 16 字节去掉，
 * 否则「载荷」里会混进请求头，长度也对不上设备的 `qiov.size`。
 */
const VIRTIO_BLK_OUTHDR_BYTES = 16;

/**
 * 取写载荷时，事件窗口左端相对 `block.submit` 往前退多少条。
 *
 * 同一请求的 `dma.read` 段一定**早于**它的 `block.submit`（映射描述符在前、
 * 交给块层在后），但不一定紧邻：中间可能夹着别的请求甚至别的设备的事件。
 * 退多退少都不影响正确性——多扫到的事件按 requestId 归组时会被忽略，
 * 退得不够才会漏段（漏段会被长度校验挡住，记成 skipped 而不是记错载荷）。
 */
const DMA_LOOKBACK_EVENTS = 1024;

function hex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function toBigInt(text) {
  if (typeof text === 'bigint') return text;
  if (typeof text === 'number') return BigInt(text);
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

export class Session extends EventEmitter {
  constructor({ root, profile = 'full-boot', qemuPath, diskFault = null } = {}) {
    super();
    this.root = root;
    // 可选的一次性写故障（见 process.mjs 的说明）：打开后根盘上会有一个
    // 「已提交、还没对客体可见」的块请求真实存在，才能验证 pending 写入与载荷。
    this.diskFault = diskFault;
    this.id = crypto.randomUUID();
    this.dir = path.join(root, 'var/sessions', this.id);
    fs.mkdirSync(this.dir, { recursive: true });

    this.profile = profile;
    this.epoch = 1;
    this.state = 'created';
    this.frames = [];
    this.captureCounter = 0;
    this.breakpoints = [];
    this.terminal = '';
    this.terminalBytes = 0;
    this.events = [];
    this.lastEventSeq = 0;
    // 启动阶段必须关闭自动采集：GDB 在 -target-select 后会先发一次停止通知，
    // 若此时允许自动采集，它会和显式的复位帧采集竞态，导致复位帧不是 frame 0。
    this.autoCapture = false;
    this.pendingCapture = null;
    this.stopWaiters = [];
    this.mode = 'live';
    this.viewFrameId = 0;
    this.droppedMessages = [];
    this.capabilityGaps = [];
    this.commandResults = new Map();

    // 观察扩展（T05a/T05b）。缺省为「未探测」，不允许用推测值补齐 CPU 扩展状态；
    // capture 只保存当前有效的那一份（观察者本身是单槽快照）。
    // events 是事件环的记账：开关状态与水位线全部取自观察者的返回，不自行推算。
    this.observer = {
      detected: false,
      capabilities: null,
      reason: '尚未探测 x-oslab-capabilities',
      probeAt: null,
      capture: null,
      snapshots: 0,
      lastRefusal: null,
      events: {
        reads: 0,
        enabled: null,
        watermark: null,
        oldest: null,
        total: null,
        dropped: null,
        capacity: null,
        lastReadAt: null,
        lastSwitchAt: null,
        lastRefusal: null,
      },
    };

    this.process = new LabProcess({
      root,
      sessionDir: this.dir,
      profile,
      qemuPath,
      diskFault: this.diskFault,
    });
    this.queue = new ControlQueue({
      defaultTimeoutMs: 20000,
      onTimeout: async () => {
        // 超时后请求受控停止，避免目标留在未知运行状态
        await this.requestPause('timeout').catch(() => {});
      },
    });
    this.symbols = new SymbolRegistry({ root });

    // T07/T08：Linux 对象解析。布局产物与现场 vmlinux 的 build ID 在构造时校验；
    // 解析器只使用本帧 captureId 绑定的物理读取器，历史帧不会被当前内存污染。
    this.osCollector = new OsCollector({ root });
    // 界面选中的进程（查看选中进程不等于改变内核 current）；null 表示跟随 current。
    this.selectedPid = null;
    this.t08 = { last: null };
    // 暂停时收到的 PS/2 按键先排队：QMP 的 input-send-event 在 VM 停止时会
    // 返回 "VM not running"。恢复运行后由 #flushPendingKeyboard 发送，顺序不变。
    this.pendingKeyboard = [];
    this.keyboardFlushing = false;
    // T10–T12：课程是静态说明，运行状态由当前帧决定；加载失败时保留原因，
    // 界面显示「课程不可用」而不是悄悄少几课。
    this.curriculum = loadCurriculum(root);
    this.lessonCatalogCache = null;

    // T06：内存/页表/设备/磁盘数据服务。
    // - memory：按 captureId 落的 RAM 基线与增量；
    // - disk：virtio-blk 的逻辑版本链（基线与可见写范围）；
    // - t06：最近一次采集的产物摘要，便于面板与验收脚本对照。
    this.memory = new MemoryCollector({ dir: path.join(this.dir, 'ram') });
    this.disk = new DiskVersionStore({
      diskId: 'virtio-blk-0',
      basePath: defaultBasePath(root),
      dir: path.join(this.dir, 'disk'),
      captureId: null,
    });
    this.diskBaseReady = false;
    this.diskViewer = new DiskViewer({ store: this.disk });
    this.t06 = {
      lastPaging: null,
      lastVirtqueues: null,
      lastCoverage: null,
      lastDiskEvents: null,
      baselines: [],
    };
  }

  /* ---------- 命令幂等 ---------- */

  /**
   * 查找同一 requestId 的既有结果。
   *
   * 幂等必须在新鲜度检查之前生效：网络重试会带着与首次完全相同的
   * expectedFrameId 回来，如果先检查 expectedFrameId，合法的重试会被
   * 误判成 frame-mismatch 而不是返回既有结果。
   */
  lookupResult(requestId) {
    if (!this.commandResults.has(requestId)) return null;
    return this.commandResults.get(requestId);
  }

  rememberResult(requestId, value) {
    this.commandResults.set(requestId, value);
    while (this.commandResults.size > 200) {
      const oldest = this.commandResults.keys().next().value;
      this.commandResults.delete(oldest);
    }
  }

  /* ---------- 生命周期 ---------- */

  async start() {
    this.state = 'starting';
    this.emitState();

    const launch = await this.process.start();
    if (this.diskFault !== null) {
      this.#record('session.disk-fault', {
        ...this.diskFault,
        conf: this.process.paths.blkdebug,
        note: '根盘写入故障：一次写错误 + werror=stop，用于制造真实的未完成块请求',
      });
    }
    this.qmp = await QMP.connect(this.process.paths.qmp, { timeoutMs: 15000 });
    this.qmpVersion = this.qmp.greeting?.version ?? null;
    this.qmp.on('event', (event) => this.#onQmpEvent(event));
    this.qmp.on('error', (error) => this.emit('notice', { level: 'warn', message: `QMP: ${error.message}` }));

    await this.#probeObserver();

    this.#connectSerial();

    this.mi = new MI({
      cwd: this.root,
      logPath: path.join(this.dir, 'gdb.log'),
      requestTimeoutMs: 20000,
    });
    this.mi.on('stopped', (record) => this.#onGdbStopped(record));
    this.mi.on('running', () => {
      this.state = 'running';
      this.emitState();
      void this.#flushPendingKeyboard();
    });
    this.mi.on('notify', (record) => this.#record('gdb.notify', { class: record.cls }));
    this.mi.on('error', (error) => this.emit('notice', { level: 'error', message: `GDB: ${error.message}` }));
    this.mi.on('exit', () => {
      if (this.state !== 'closed') {
        this.state = 'error';
        this.emitState();
      }
    });

    await this.mi.initialize();

    const vmlinux = path.join(this.root, 'artifacts/build/linux/vmlinux');
    if (!fs.existsSync(vmlinux)) throw new Error('缺少 artifacts/build/linux/vmlinux，请先构建内核');
    await this.mi.fileExecAndSymbols(vmlinux, { timeoutMs: 180000 });

    // 主内核之外的阶段按实测装载地址加载；未实测的明确登记为 pending
    const plan = this.symbols.addSymbolFileCommands();
    this.symbolPlan = plan;

    await this.mi.targetSelect(this.process.paths.gdb, { timeoutMs: 60000 });
    await this.mi.discoverRegisters();
    this.registers = (await this.mi.readRegisters('x')).map((entry) => ({
      name: entry.name,
      value: entry.value,
    }));

    this.state = 'stopped';
    this.emitState();
    const frame = await this.capture({ reason: 'reset', requestId: 'start', previousPc: null });
    // 复位帧已提交，此后断点命中等自发停止才需要自动采集
    this.autoCapture = true;
    return { launch, frame };
  }

  #connectSerial() {
    this.serial = net.createConnection(this.process.paths.serial);
    this.serialSocketReady = false;
    this.serial.on('connect', () => {
      this.serialSocketReady = true;
    });
    this.serial.on('error', (error) => {
      this.emit('notice', { level: 'warn', message: `串口连接: ${error.message}` });
    });
    this.serial.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.terminal += text;
      this.terminalBytes += chunk.length;
      if (this.terminal.length > TERMINAL_BUFFER_LIMIT) {
        this.terminal = this.terminal.slice(-TERMINAL_BUFFER_LIMIT);
      }
      fs.appendFile(path.join(this.dir, 'serial.log'), chunk, () => {});
      // 终端输出是独立实时流，提交帧后才归入快照
      this.emit('message', { type: 'terminal.output', text, at: new Date().toISOString() });
    });
  }

  #onQmpEvent(event) {
    this.#record(`qmp.${event.event}`, event.data ?? {});
    if (event.event === 'STOP') {
      // QMP 的 STOP 与 GDB 的 *stopped 是同一次停止，交给同一个信号入口去重
      this.#signalStop({ source: 'qmp', reason: event.data?.reason ?? 'qmp-stop' });
    }
  }

  #onGdbStopped(record) {
    const info = stopReasonOf(record);
    this.#signalStop({ source: 'gdb', info, record });
  }

  /**
   * 统一的停止信号入口。
   * 同一次停止可能同时来自 GDB 与 QMP，这里只让第一个生效。
   */
  #signalStop(payload) {
    this.stopSignals = this.stopSignals ?? { count: 0, lastAt: 0 };
    const now = Date.now();
    this.stopSignals.count += 1;
    this.stopSignals.lastAt = now;

    // 只有从运行状态停下来才算一次「自发停止」。attach 后的首次停止
    // （state=starting）与重复通知（state 已是 stopped）都不产生新帧。
    const wasRunning = this.state === 'running';

    // 状态必须先切回 stopped：等待停止的命令在收到信号后会立刻采集，
    // 此时若状态还是 running，采集会被自身的前置检查拒绝。
    if (wasRunning) {
      this.state = 'stopped';
      this.emitState();
    }

    const waiter = this.stopWaiters.shift();
    if (waiter) {
      waiter.resolve(payload);
      return;
    }

    this.lastStop = payload;
    // 没有被等待的停止：断点命中这类自发停止才需要自动采集一帧
    if (
      !wasRunning ||
      !this.autoCapture ||
      this.frames.length === 0 ||
      this.state === 'closed' ||
      this.pendingCapture
    ) {
      return;
    }
    this.pendingCapture = this.queue
      .execute(`auto-${payload.info?.pc ?? 'stop'}-${this.frames.length}`, () =>
        this.capture({
          reason: payload.info?.reason ?? 'unknown',
          requestId: `auto-${this.frames.length}`,
          stopPayload: payload,
        }),
      )
      .catch((error) => this.emit('notice', { level: 'error', message: `自动采集失败: ${error.message}` }))
      .finally(() => {
        this.pendingCapture = null;
      });
  }

  #waitForStop(timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const timer = setTimeout(() => {
        const index = this.stopWaiters.indexOf(entry);
        if (index >= 0) this.stopWaiters.splice(index, 1);
        const error = new Error(`等待停止通知超时 (${timeoutMs}ms)`);
        error.code = 'command-timeout';
        reject(error);
      }, timeoutMs);
      entry.resolve = (payload) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.stopWaiters.push(entry);
    });
  }

  #record(kind, data) {
    const event = { seq: ++this.lastEventSeq, kind, at: new Date().toISOString(), ...data };
    this.events.push(event);
    if (this.events.length > 5000) this.events.splice(0, this.events.length - 5000);
    this.emit('message', { type: 'event', event });
    return event;
  }

  /* ---------- 观察扩展（T05a） ---------- */

  /**
   * 探测 x-oslab-* 命令是否存在。
   * 缺失时记录原因并把能力保持为 unavailable；不做任何推测性补齐。
   */
  async #probeObserver() {
    const probe = await this.qmp.probeObserver({ timeoutMs: 10000 });
    this.observer.detected = probe.detected;
    this.observer.capabilities = probe.capabilities;
    this.observer.reason = probe.reason;
    this.observer.probeAt = new Date().toISOString();
    this.#record('observer.probe', {
      detected: probe.detected,
      reason: probe.reason,
      qemuVersion: probe.capabilities?.qemuVersion ?? null,
      protocolVersion: probe.capabilities?.protocolVersion ?? null,
    });
    return this.observer;
  }

  /**
   * 在同一个停止点上取一份观察者快照。
   *
   * 只有在全部 vCPU 停止时才会成功；被拒绝（例如 GDB 已继续但状态还没同步）
   * 时返回 null 并由调用方如实降级，不能回退到「按模式推测段基址」。
   */
  async #observerSnapshot() {
    if (!this.observer.detected) return null;
    let snapshot;
    try {
      snapshot = await this.qmp.observerCapture({ timeoutMs: 10000 });
    } catch (error) {
      this.observer.lastRefusal = error.message;
      this.#record('observer.capture.error', { message: error.message });
      return null;
    }
    if (snapshot?.ok !== true) {
      this.observer.lastRefusal = snapshot?.reason ?? 'unknown';
      this.#record('observer.capture.refused', {
        reason: snapshot?.reason ?? 'unknown',
        runState: snapshot?.runState ?? null,
      });
      return null;
    }
    const superseded = snapshot.supersededCaptureId ?? null;
    if (superseded !== null && superseded !== this.observer.capture?.captureId) {
      // 观察者单槽：出现未知的取代者说明有别的采集者，如实记录而不是忽略
      this.#record('observer.capture.foreign-supersede', { superseded });
    }
    this.observer.snapshots += 1;
    this.observer.lastRefusal = null;
    const pending = snapshot.pendingIo ?? null;
    this.observer.capture = {
      captureId: snapshot.captureId,
      vmGeneration: snapshot.vmGeneration,
      capturedAtNs: snapshot.capturedAtNs ?? null,
      regions: snapshot.readableRegions ?? [],
      // T05d：设备面板的只读快照随 capture 一起冻结，帧里直接引用同一份数据。
      devices: Array.isArray(snapshot.devices) ? snapshot.devices : [],
      deviceCount: Number.isFinite(snapshot.deviceCount) ? snapshot.deviceCount : null,
      // T05e：帧分界与待完成块请求台账。fenceSeq 是这一帧的右端标记、也等于
      // eventWatermark；pendingIo 是在同一个串行化点上取的台账快照，
      // frameBoundary 说明这一刻的边界规则与同一瞬间的 pending 计数。
      fenceSeq: snapshot.fenceSeq ?? null,
      eventWatermark: snapshot.eventWatermark ?? null,
      frameBoundary: snapshot.frameBoundary ?? null,
      pendingIo: pending,
      frameId: null, // 由 capture() 在提交帧时回填
      // 观察者的 captureId 是 QEMU 侧命名空间（形如 cap-2-8.2.10），服务自己的
      // 采集代编号是 cap-<会话前八位>-<序号>（形如 cap-4a448800-2）。两者永不相等，
      // 所以「这一份快照属于哪一帧」必须用服务侧编号表达，由 capture() 回填。
      // 公共接口与落盘一律用服务侧编号，观察者编号只作为证据里的引用出现。
      serviceCaptureId: null,
    };
    this.#record('observer.capture', {
      captureId: snapshot.captureId,
      vmGeneration: snapshot.vmGeneration,
      regionCount: snapshot.regionCount ?? null,
      readableRegionCount: snapshot.readableRegionCount ?? null,
      deviceCount: snapshot.deviceCount ?? null,
      supersededCaptureId: superseded,
      fenceSeq: snapshot.fenceSeq ?? null,
      pendingBlockRequests: pending?.count ?? null,
      pendingHostIoDone: pending?.hostIoDoneCount ?? null,
    });
    return snapshot;
  }

  /** 清掉本地记录的 capture（观察者已推进代数时不再可信）。 */
  #forgetObserverCapture(reason) {
    if (this.observer.capture === null) return;
    const { captureId } = this.observer.capture;
    this.observer.capture = null;
    this.#record('observer.capture.dropped', { captureId, reason });
  }

  /** 释放观察者侧冻结资源；关闭会话时调用。 */
  async #releaseObserverCapture() {
    const capture = this.observer.capture;
    if (!capture) return null;
    this.observer.capture = null;
    try {
      const released = await this.qmp.observerRelease({ captureId: capture.captureId });
      return released;
    } catch (error) {
      this.emit('notice', { level: 'warn', message: `释放观察快照失败: ${error.message}` });
      return null;
    }
  }

  /* ---------- 观察扩展：事件序列（T05b） ---------- */

  /**
   * 读取观察者事件环。
   *
   * 语义边界（与 capture 的区别，刻意如此）：
   * - 读取**允许在 VM 运行时读取**：事件环由 vCPU 线程写入、自旋锁保护，读到的是一份
   *   「截至读取时刻已经发生的事件」。因此这里不发停止屏障，也不宣称事件属于
   *   某一帧；与帧的绑定由帧的 `eventWatermark` 与 `frameBoundary` 表达（T05e 起成为
   *   正式契约：`seq <= eventWatermark` 与「属于本帧」严格等价，fence 自己也属于该帧）。
   * - 有活动快照时**绑定 captureId**：观察者会拒绝为别的快照读事件，这样
   *   「这批事件属于哪次采集」是观察者判定的，不是服务端推断的。
   *
   * 观察扩展不存在时直接拒绝，不用服务自己的事件日志（那是服务侧记录，不是客体
   * 事件）冒充客体事件流。序号区间、limit 与 kinds 的拒绝原因原样透出。
   */
  async observerEvents({ from = null, to = null, limit = null, kinds = null } = {}) {
    if (!this.observer.detected) {
      throw this.#protocolError(
        ErrorCode.CAPABILITY_MISSING,
        `x-oslab-events 不可用: ${this.observer.reason}`,
        { observerReason: this.observer.reason },
      );
    }
    const result = await this.qmp.observerEvents({
      captureId: this.observer.capture?.captureId ?? null,
      from,
      to,
      limit,
      kinds,
    }, { timeoutMs: 20000 });
    if (result?.ok !== true) {
      throw this.#eventRefusal(result);
    }
    this.observer.events.reads += 1;
    this.observer.events.lastReadAt = new Date().toISOString();
    this.#adoptEventRuntime(result);
    return result;
  }

  /**
   * 切换事件采集开与关，或清空事件环。
   *
   * 与读取的边界刻意不同：读事件是**带外**的（VM 跑着也能读，不能被长命令堵住），
   * 而切换是控制面操作，必须和 step/continue 排在同一条串行队列里——否则可能在
   * 某条 step 已经停住 vCPU、正要恢复的窗口里把已翻译的 TB 整片失效。
   *
   * 两种情况观察者会拒绝，这里都原样上报、不自行绕过：
   * - `vm-running`：开关改变的是翻译期发射点，切换后必须整片失效已翻译的 TB；
   * - `capture-active`：重置序号会让活动快照的事件区间断掉，必须先 release
   *   （观察者的 release 契约属 T05e，服务当前只在关闭会话与重新采集时释放）。
   * 拒绝时请求不产生任何部分效果（观察者先校验再一起应用）。
   */
  async switchObserverEvents({ enable, reset, recordKinds = undefined, requestId = null } = {}) {
    if (!this.observer.detected) {
      throw this.#protocolError(
        ErrorCode.CAPABILITY_MISSING,
        `x-oslab-events 不可用: ${this.observer.reason}`,
        { observerReason: this.observer.reason },
      );
    }
    if (enable === undefined && reset === undefined && recordKinds === undefined) {
      throw this.#protocolError(
        ErrorCode.INVALID_REQUEST,
        '必须给出 enable、reset 或 recordKinds 之一；只读事件请用 GET',
      );
    }
    if (recordKinds !== undefined && !Array.isArray(recordKinds)) {
      throw this.#protocolError(ErrorCode.INVALID_REQUEST, 'recordKinds 必须是字符串数组');
    }
    // 帧分界靠 `capture.fence`：它不被记录进事件环时，观察者给的 fenceSeq 会退化成 0，
    // 「本帧到哪条事件为止」这个语义随之消失，块事件窗口也从「上一帧水位线→fence」
    // 塌成空区间。任何收窄掩码的调用方都可能踩到这一点，所以这里**自动补上**，
    // 并把补了什么如实回报（在 memory-only 掩码下这是唯一不破坏分界的做法）。
    const effectiveRecordKinds = Array.isArray(recordKinds) ? recordKinds.slice() : undefined;
    const recordKindsAugmented = [];
    if (effectiveRecordKinds !== undefined && !effectiveRecordKinds.includes('capture.fence')) {
      effectiveRecordKinds.push('capture.fence');
      recordKindsAugmented.push('capture.fence');
    }
    const { value } = await this.#executeControl(
      'events.switch',
      requestId ?? `events.switch-${crypto.randomUUID()}`,
      async () => {
        const result = await this.qmp.observerEvents({
          captureId: null,
          ...(enable !== undefined ? { enable: enable === true } : {}),
          ...(reset !== undefined ? { reset: reset === true } : {}),
          ...(effectiveRecordKinds !== undefined ? { recordKinds: effectiveRecordKinds } : {}),
        }, { timeoutMs: 20000 });
        if (result?.ok !== true) {
          this.observer.events.lastRefusal = result?.reason ?? 'unknown';
          this.#record('observer.events.switch-refused', {
            reason: result?.reason ?? 'unknown',
            runState: result?.runState ?? null,
          });
          throw this.#eventRefusal(result);
        }
        this.observer.events.lastSwitchAt = new Date().toISOString();
        this.observer.events.lastRefusal = null;
        this.#adoptEventRuntime(result);
        this.#record('observer.events.switch', {
          enabled: result.enabled === true,
          enabledChanged: result.enabledChanged === true,
          reset: result.reset === true,
          recordAllKinds: result.recordAllKinds ?? null,
          recordKindMask: result.recordKindMask ?? null,
          recordKinds: result.recordKinds ?? effectiveRecordKinds ?? null,
          recordKindsRequested: recordKinds ?? null,
          recordKindsAugmented: recordKindsAugmented.length > 0 ? recordKindsAugmented : null,
        });
        return result;
      },
    );
    // 为了让帧分界仍然成立而自动补上的 kind 如实回报：静默改写调用方给的掩码
    // 是另一种不诚实，面板与验收脚本都要能看出「我要求的」和「实际生效的」差在哪。
    return {
      ...value,
      recordKindsRequested: recordKinds ?? null,
      recordKindsAugmented: recordKindsAugmented.length > 0 ? recordKindsAugmented : null,
    };
  }

  /** 把观察者返回的事件环水位线原样记账（u64 用十进制字符串，保留 bigint 或十进制字符串精度）。 */
  #adoptEventRuntime(result) {
    const events = this.observer.events;
    if (typeof result?.enabled === 'boolean') events.enabled = result.enabled;
    for (const field of ['watermark', 'oldest', 'total']) {
      if (result?.[field] !== undefined && result[field] !== null) events[field] = String(result[field]);
    }
    if (result?.dropped !== undefined && result.dropped !== null) events.dropped = Number(result.dropped);
    if (result?.capacity !== undefined && result.capacity !== null) events.capacity = Number(result.capacity);
    // 记录期掩码决定「环里会留下哪几类事件」，与读的过滤是两件事：
    // 掩码太宽时设备事件会被海量访存事件挤出环，读时再按 kinds 过滤也救不回来。
    if (result?.recordAllKinds !== undefined) events.recordAllKinds = result.recordAllKinds !== false;
    for (const field of ['recordKindMask']) {
      if (result?.[field] !== undefined && result[field] !== null) events[field] = String(result[field]);
    }
    if (Array.isArray(result?.recordKinds)) events.recordKinds = result.recordKinds.slice();
    if (Array.isArray(result?.recordKindsUnknown)) events.recordKindsUnknown = result.recordKindsUnknown.slice();
  }

  /** 把 x-oslab-events 的拒绝原因映射成协议错误码；快照失效时清掉本地记录。 */
  #eventRefusal(result) {
    const reason = result?.reason ?? 'unknown';
    const detail = {
      observerReason: reason,
      runState: result?.runState ?? null,
      enabled: result?.enabled ?? null,
      captureId: result?.captureId ?? this.observer.capture?.captureId ?? null,
      limit: result?.limit ?? null,
    };
    if (reason === 'invalid-limit') {
      return this.#protocolError(ErrorCode.INVALID_REQUEST, result?.message ?? 'limit 越界', detail);
    }
    if (reason === 'capture-mismatch' || reason === 'no-active-capture' || reason === 'vm-advanced') {
      this.#forgetObserverCapture(reason);
      return this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        result?.message ?? '观察者快照已失效，请重新停止并采集',
        detail,
      );
    }
    if (reason === 'vm-running' || reason === 'capture-active') {
      return this.#protocolError(
        ErrorCode.CONTROL_BUSY,
        result?.message ?? `观察者拒绝了这次事件操作（${reason}）`,
        detail,
      );
    }
    return this.#protocolError(
      ErrorCode.INTERNAL,
      result?.message ?? `观察者拒绝了这次事件操作（${reason}）`,
      detail,
    );
  }

  /* ---------- 采集 ---------- */

  async capture({ reason, requestId, stopPayload = null, previousPc = null }) {
    if (this.state === 'running') throw new Error('运行中不能采集；请先暂停');
    const captureStartedAt = Date.now();
    const previousState = this.state;
    this.state = 'capturing';
    this.emitState();

    try {
      const payload = stopPayload ?? this.lastStop ?? null;
      const info = payload?.info ?? { reason: 'unknown', rawReason: null, pc: null, cpuId: 0 };
      // 调用方显式给出的 reason 优先：例如首次连接停在复位状态时，
      // GDB 的 *stopped 不带 reason 字段，但服务确知目标是复位后暂停。
      const stopReason = reason && reason !== 'unknown' ? reason : info.reason ?? 'unknown';
      const rawReason =
        info.rawReason ?? (payload ? '（GDB 未提供 reason 字段）' : '（没有停止通知，由服务判定）');
      const registers = await this.mi.readRegisters('x');
      const byName = new Map(registers.map((entry) => [entry.name, entry.value]));

      // 观察者在同一停止点上冻结 CPU 扩展状态与物理区域表：它和上面的
      // GDB 寄存器读取共享同一个停止点（VM 没有再推进），两者可比对。
      const observer = await this.#observerSnapshot();
      const cpu = this.#buildCpu(byName, info, observer);
      const segmentCacheObserved = observer !== null && Object.keys(cpu.segments ?? {}).length > 0;
      const memory = await this.#readMemoryAround(cpu, byName);

      // T08：PC 处的原始指令字节来自本帧同一停止点的 GDB 内存读。
      // 只给字节，不假装已经反汇编；反汇编文本缺失时界面显示 unavailable。
      const pcMemory = memory.find((entry) => entry.label === 'pc' && typeof entry.bytes === 'string' && entry.bytes.length > 0);
      if (pcMemory) {
        cpu.instruction = {
          address: pcMemory.address,
          bytes: pcMemory.bytes,
          text: null,
          length: pcMemory.length,
          evidence: 'observed: gdb -data-read-memory-bytes（同一停止点）',
        };
      }

      // T06：采集标识先于一切「按 captureId 取数」的动作确定。队列内存、页表
      // 与 RAM 页的每一条证据都要带它，所以不能等帧组装完才编号。
      const captureId = `cap-${this.id.slice(0, 8)}-${++this.captureCounter}`;
      cpu.extended = await collectExtendedCpu({
        qmp: this.qmp, byName, observer, cpuId: cpu.cpuId, captureId,
      });
      const frameId = this.frames.length;
      const parent = this.frames.at(-1) ?? null;
      if (this.observer.capture) {
        // 观察者单槽快照同时记住「这是第几帧」与「这是服务侧哪一代」：
        // 前者用于面板展示，后者用于一切按 captureId 的取数（翻译、内存、队列）。
        // 这两件事不能靠比较 captureId 来对齐——两边是两套编号。
        this.observer.capture.frameId = frameId;
        this.observer.capture.serviceCaptureId = captureId;
      }

      // T06 第 5 条：一次采集一个读取器。队列内存、页表、RAM 页全部走它。
      // 观察者拒绝时绝不回退到 GDB 物理模式——那读的是「当前」内存，
      // 会把历史帧悄悄变成现在，这比读不到更糟。
      const reader = this.#captureReaderOrNull();

      // T05d：设备面板的无副作用快照随 capture 一起进帧；真拿到了就不再列成缺口，
      // 没拿到（观察扩展缺失/未支持该目标）时如实保留 device.* 缺口。
      // T06 第 3 条：virtio 队列内容按同一 captureId 解出描述符与缓冲首字节并合回快照。
      const virtqueues = await this.#collectVirtqueues(observer, captureId, reader);
      const deviceSnapshots = virtqueues.devices;
      // 记下「这一代解出了哪些队列、哪些没解出来」，队列面板按 captureId 取它，
      // 只消费指定帧或采集代的数据。
      this.t06.lastVirtqueues = {
        captureId,
        queues: virtqueues.queues,
        unavailable: virtqueues.unavailable,
        decodedDevices: virtqueues.decodedDevices,
      };
      if (virtqueues.queues.length > 0 || virtqueues.unavailable.length > 0) {
        this.#record('device.virtqueues', {
          captureId,
          queues: virtqueues.queues.length,
          devices: virtqueues.decodedDevices,
          unavailable: virtqueues.unavailable,
        });
      }

      // T06 第 1 条：按当前运行阶段解析分段与分页，并翻译本帧 PC。
      const paging = await this.#collectPaging(cpu, captureId, reader);

      // T07/T08：把同一份 capture 交给 Linux 对象解析器。只有拿到观察者读取器
      // （captureId 绑定）时才做；否则明确记 unavailable，不用 GDB 的「当前内存」顶替。
      let osResult = {
        os: null,
        unavailable: reader === null
          ? `Linux 对象解析不可用：${this.observer.detected ? '观察者快照被拒绝' : '观察者扩展未探测到'}`
          : null,
        stats: {},
      };
      if (reader !== null) {
        try {
          osResult = await this.osCollector.collect({
            frame: {
              sessionId: this.id,
              epoch: this.epoch,
              frameId,
              captureId,
              cpu,
              stop: { cpuId: info.cpuId ?? 0, reason: stopReason },
            },
            reader,
            selectedPid: this.selectedPid,
          });
        } catch (error) {
          osResult = { os: null, unavailable: `Linux 对象解析失败：${error.message}`, stats: {} };
        }
      }
      this.t08.last = {
        captureId,
        frameId,
        os: osResult.os === null ? null : {
          current: osResult.os.current?.pid ?? null,
          selected: osResult.os.selected?.pid ?? null,
          processes: osResult.os.processes.length,
          files: osResult.os.files.length,
          vmas: osResult.os.addressSpace?.vmas.length ?? 0,
        },
        unavailable: osResult.unavailable ?? null,
        stats: osResult.stats ?? {},
      };

      // T06 第 4 条：把上一帧之后发生的块请求事件喂进磁盘版本台账。
      const blockEvents = await this.#consumeBlockEvents({ captureId, parent });
      // T06 第 4 条：「pending 写入独立保存」——载荷只对**仍在飞行中**的写请求取，
      // 因为那是唯一能证明这块缓冲里的内容确实属于这个请求的时刻。
      const payloads = await this.#captureWritePayloads({ captureId, reader });
      const diskEvents = { ...blockEvents, payloads };
      // T05e：服务自己的 capture.fence 也带上同一瞬间的 pending 计数，只读事件流
      // 就能看出「这一帧是在多少块请求还没对客体可见的时候提交的」。
      const observerFrame = this.observer.capture;
      const fence = this.#record('capture.fence', {
        captureId,
        frameId,
        observerFenceSeq: observerFrame?.fenceSeq ?? null,
        pendingBlockRequests: observerFrame?.pendingIo?.count ?? null,
        pendingHostIoDone: observerFrame?.pendingIo?.hostIoDoneCount ?? null,
      });
      const firstEventSeq = (parent?.eventRange.last ?? null) !== null
        ? String(Number(parent.eventRange.last) + 1)
        : String(fence.seq);

      const source = await this.#resolveSource(info, cpu);

      // T10–T12：用本帧的真实状态匹配教学点。匹配不到就是 null，
      // 不把上一课的说明套到当前停点上。
      const lessonFrame = {
        profileId: this.profile,
        stop: { reason: stopReason, pc: cpu.linearPc, cpuId: info.cpuId ?? 0 },
        cpu,
        source,
        os: osResult.os,
      };
      const lesson = matchLesson(lessonFrame, this.curriculum);

      // T06 第 4 条：磁盘版本号由「基线散列 + 已对客体可见的写范围」决定。
      // 基线散列只算一次（缓存）；算不出来就保持 null，以 null 表示版本缺省状态。
      await this.#ensureDiskBase();
      const diskVersion = this.disk.version({ createdAt: null });

      // T06：内存覆盖统计。全量 RAM 基线是显式操作（mode=baseline），
      // 所以本帧的 memory 覆盖如实标 selected-pages；只有本代真做过基线
      // 才升级成 full-ram-delta，绝不因为「会话里存在过基线」就冒充。
      const memoryCoverage = await this.#memoryCoverageFor(captureId, memory);

      const frame = {
        schemaVersion: SCHEMA_VERSION,
        sessionId: this.id,
        epoch: this.epoch,
        frameId,
        parentFrameId: parent?.frameId ?? null,
        requestId: requestId ?? `capture-${frameId}`,
        captureId,
        executionMode: this.mode === 'live' ? 'live' : 'recorded',
        stop: {
          reason: stopReason,
          rawReason,
          pc: cpu.linearPc,
          cpuId: info.cpuId ?? 0,
          breakpointId: info.breakpointId,
          previousPc,
        },
        eventRange: { first: firstEventSeq, last: String(fence.seq) },
        // T05e：帧分界与待完成块请求台账（x-oslab-capture 的对应字段透传）。
        // fenceSeq 是这一帧的右端标记，eventWatermark 有 fence 时就等于它；
        // pendingIo 是同一瞬间的台账快照，frameBoundary 说明边界规则。
        fenceSeq: observerFrame?.fenceSeq ?? null,
        eventWatermark: observerFrame?.eventWatermark ?? null,
        frameBoundary: observerFrame?.frameBoundary ?? null,
        pendingIo: observerFrame?.pendingIo ?? null,
        coverage: {
          // T06：只有本代真做过全量 RAM 基线才敢写 full-ram-delta；
          // 默认仍是 selected-pages（基线是显式操作，不随采集自动发生）。
          memory: memoryCoverage.mode,
          events: 'filtered',
          unavailable: [
            // 观察者提供段缓存后这一项就真的不再是缺口；没有探测到时如实保留
            ...(segmentCacheObserved ? [] : ['cpu.segment-cache']),
            'cpu.memory-access-events',
            // T05e：观察者提供 pendingIo 后这一项不再是缺口
            ...(observerFrame?.pendingIo ? [] : ['device.pending-block-io']),
            ...(deviceSnapshots.length > 0
              ? []
              : ['device.vga', 'device.i8042', 'device.uart', 'device.pic',
                'device.apic', 'device.timer', 'device.virtio-blk']),
            // T06 第 1 条：分页解析要求帧里有 CR0/CR3/CR4；拿不到就如实列缺口，
            // 不用「未分页」冒充（那会把所有线性地址当物理地址）。
            ...(paging.state === null ? ['cpu.paging', `cpu.paging: ${paging.reason ?? '未知原因'}`] : []),
            // T06 第 3 条：队列内容没解出来时把原因列出来，明确记录原因。
            ...(virtqueues.unavailable.length > 0 ? ['device.virtio-queues'] : []),
            // T06 第 4 条：磁盘版本链离开基线无法解释。
            ...(diskVersion === null ? ['disk.versions'] : []),
            // T07/T08：解析器不可用/当前阶段不是 64 位分页内核时如实列缺口。
            ...(osResult.os === null
              ? ['os.objects', `os.objects: ${osResult.unavailable ?? '未知原因'}`]
              : []),
          ],
        },
        cpu,
        memory,
        devices: deviceSnapshots,
        // 键为 diskId，值为逻辑版本 ID（契约 Frame.diskVersions）。
        diskVersions: diskVersion === null ? {} : { [diskVersion.diskId]: diskVersion.versionId },
        os: osResult.os,
        source,
        lesson,
        evidence: this.#buildEvidence(cpu, captureId, info, observer, {
          paging,
          virtqueues,
          memoryCoverage,
          diskVersion,
          diskEvents,
          os: osResult.os,
          osUnavailable: osResult.unavailable,
        }),
        recording: {
          reconstructible: frameId % CHECKPOINT_EVERY === 0,
          checkpointFrameId: Math.floor(frameId / CHECKPOINT_EVERY) * CHECKPOINT_EVERY,
          instructionGaps:
            parent === null
              ? []
              : [
                  {
                    fromFrameId: parent.frameId,
                    toFrameId: frameId,
                    note: '两个停止点之间的指令流未逐条记录（需要显式开启 instruction.* 采集并按 seq 区间重建，帧与事件区间的绑定属 T05e）',
                  },
                ],
          memoryGaps: ['只采集了当前 PC 与栈附近的内存，任意地址历史查询需要 T06 的全量采集'],
          events: 'filtered',
          note: '事件覆盖为 filtered：观察扩展已能提供访存/io/dma/block 事件，但采集默认关闭且必须显式开启；帧与事件区间的绑定属 T05e',
        },
        committedAt: new Date().toISOString(),
        captureMs: Date.now() - captureStartedAt,
      };

      this.frames.push(frame);
      // 帧文件只用于历史回看/重启恢复；异步写避免在采集关键路径上同步阻塞
      // 事件循环（帧通常 100–300 KiB，全量 RAM 时更大）。
      await fsp.writeFile(path.join(this.dir, `frame-${frameId}.json`), JSON.stringify(frame, null, 2));
      this.lastStop = payload;
      this.state = 'stopped';
      this.emit('message', {
        type: 'frame.committed',
        attribution: { sessionId: this.id, epoch: this.epoch, frameId, captureId },
        liveFrameId: frameId,
        viewFrameId: this.viewFrameId,
        eventsFiltered: true,
      });
      return frame;
    } catch (error) {
      // 采集出错保持最后一个完整帧，并显示过期状态
      this.state = previousState === 'capturing' ? 'stopped' : previousState;
      this.emit('message', {
        type: 'capture.failed',
        message: error.message,
        lastCommittedFrameId: this.frames.at(-1)?.frameId ?? null,
        stale: true,
      });
      throw error;
    } finally {
      if (this.state === 'capturing') {
        this.state = 'stopped';
      }
      this.emitState();
    }
  }

  /**
   * 组装 CPU 快照。
   *
   * 寄存器基线来自 GDB/MI（T03 已验证）。观察者快照可用时，需要硬件隐藏
   * 状态才能得到的字段改由 `x-oslab-capture` **覆盖**：段缓存（含隐藏基址、
   * 限长、属性）、控制寄存器、EFER、执行模式、CPL、线性 PC、HLT。
   * GDB 的 x86 目标只给选择子，给不出这些值。
   *
   * 观察者不可用时保持 T03 的行为，并在证据里说明缺的是哪个接口，
   * 不用「按当前模式推测段基址」补齐。
   */
  #buildCpu(byName, info, observer = null) {
    const observed = observer?.cpus?.find((cpu) => cpu.cpuId === (info.cpuId ?? 0)) ?? null;
    const cr0Gdb = toBigInt(byName.get('cr0'));
    const eferGdb = toBigInt(byName.get('efer'));
    const ripRaw = observed?.rip ?? byName.get('rip') ?? byName.get('eip') ?? info.pc ?? null;
    const ripValue = toBigInt(ripRaw);

    // LMA alone does not imply 64-bit instructions: the transition executes
    // compatibility code until the far transfer loads CS.L=1.
    const { mode, modeDetail } = decodeCpuExecutionMode({
      cr0: observed?.control?.cr0 ?? cr0Gdb,
      efer: observed?.efer ?? eferGdb,
      csAttributes: observed?.cs?.attributes ?? null,
      eflags: observed?.rflags ?? byName.get('eflags') ?? null,
    });

    const generalNames = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
    const general = [];
    for (const name of generalNames) {
      const value = byName.get(name) ?? byName.get(name.replace(/^r/, 'e'));
      if (value !== undefined) general.push({ name, width: 64, value });
    }

    /*
     * 段缓存。观察者给的是 CPUX86State.segs[] 的真实缓存（含隐藏基址、
     * 限长与原始属性字），这才是 6.2 要求的「CPU 扩展状态」。
     * 没有观察者时只能拿到选择子，限长/属性保留占位值并在证据里标 unavailable。
     */
    const segments = {};
    if (observed) {
      for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs', 'ldtr', 'tr']) {
        const entry = observed[name];
        if (!entry || typeof entry !== 'object') continue;
        segments[name] = {
          selector: entry.selector,
          base: entry.base,
          limit: entry.limit,
          attributes: entry.attributes,
          usable: entry.usable === true,
        };
      }
    } else {
      for (const name of ['cs', 'ss', 'ds', 'es', 'fs', 'gs']) {
        const selector = byName.get(name);
        if (selector === undefined) continue;
        const baseRegister = byName.get(`${name}_base`);
        segments[name] = {
          selector,
          base: baseRegister ?? '0x0',
          limit: '0xffffffff',
          attributes: '0x0',
          usable: true,
        };
      }
    }

    const csBase = toBigInt(segments.cs?.base ?? '0x0');
    // 复位时 CS.base=0xffff0000、IP=0xfff0，线性地址是两者相加；不能用 CS<<4。
    const linearPc = observed
      ? observed.linearPc ?? null
      : mode === 'real-16' && csBase === 0n && segments.cs
        ? null
        : ripValue === null
          ? null
          : hex(ripValue);

    const cplFromGdb = byName.get('cs');
    const cpl = observed
      ? Number(observed.cpl ?? 0)
      : cplFromGdb !== undefined
        ? Number(BigInt(cplFromGdb) & 3n)
        : 0;

    const observerControl = observed?.control ?? null;

    return {
      cpuId: info.cpuId ?? 0,
      mode,
      modeDetail,
      cpl,
      rip: ripRaw,
      rsp: byName.get('rsp') ?? byName.get('esp') ?? observed?.rsp ?? null,
      general,
      segments,
      control: {
        cr0: observerControl?.cr0 ?? byName.get('cr0') ?? null,
        cr2: observerControl?.cr2 ?? byName.get('cr2') ?? null,
        cr3: observerControl?.cr3 ?? byName.get('cr3') ?? null,
        cr4: observerControl?.cr4 ?? byName.get('cr4') ?? null,
        cr8: observerControl?.cr8 ?? byName.get('cr8') ?? null,
      },
      efer: observed?.efer ?? byName.get('efer') ?? null,
      eferBits: observed?.eferBits ?? null,
      eflags: observed?.rflags ?? byName.get('eflags') ?? null,
      halted: observed ? observed.halted === true : false,
      gdt: observed?.gdt ? { base: observed.gdt.base, limit: observed.gdt.limit } : null,
      idt: observed?.idt ? { base: observed.idt.base, limit: observed.idt.limit } : null,
      hflags: observed?.hflags ?? null,
      hflags2: observed?.hflags2 ?? null,
      a20Mask: observed?.a20Mask ?? null,
      instruction: {
        address: linearPc,
        bytes: null,
        text: null,
        length: null,
        evidence: 'unavailable',
      },
      linearPc,
      evidence: observed
        ? `寄存器来自 GDB/MI -data-list-register-values（按目标描述对齐）；段缓存、控制寄存器、EFER、执行模式与线性地址来自 x-oslab-capture 观察者快照 captureId=${observer.captureId}，与本次停止同一时刻`
        : mode === 'real-16'
          ? '实模式：调试接口报告的 rip 是 CS 相对偏移，段隐藏基址不可得，因此本帧不给出线性地址（观察扩展未探测到）'
          : '寄存器来自 GDB/MI -data-list-register-values，按 -data-list-register-names 的目标描述对齐；段缓存与指令字节需要 T05a/T05b，观察扩展未探测到',
    };
  }

  async #readMemoryAround(cpu, byName) {
    const entries = [];
    const targets = [];
    const pc = toBigInt(cpu.linearPc);
    if (pc !== null) targets.push({ space: 'linear', address: pc, length: 16, label: 'pc' });
    const stack = toBigInt(cpu.rsp);
    if (stack !== null && stack > 0n) targets.push({ space: 'linear', address: stack, length: 256, label: 'stack' });

    for (const target of targets) {
      try {
        const bytes = await this.mi.readMemoryBytes(target.address, target.length);
        entries.push({
          addressSpace: target.space,
          address: hex(target.address),
          length: bytes.length,
          coverage: 'recorded',
          blobRef: crypto.createHash('sha256').update(bytes).digest('hex'),
          label: target.label,
          bytes: bytes.toString('hex'),
        });
      } catch (error) {
        entries.push({
          addressSpace: target.space,
          address: hex(target.address),
          length: target.length,
          coverage: 'read-failed',
          blobRef: null,
          reason: error.message,
          label: target.label,
        });
      }
    }
    return entries;
  }

  async #resolveSource(info, cpu) {
    const pc = toBigInt(cpu.linearPc);
    const stage = pc === null ? null : this.symbols.stageForAddress(pc).stage ?? null;
    /*
     * 没有已实测装载范围覆盖的地址（复位向量、BIOS/GRUB、part of real mode）
     * 不能借用当前 GDB 里挂着的任何符号：实测在 0x7c00 会被报成 cpu_tss_rw，
     * 在复位向量会被报成 exception_stacks。宁可不给符号，也不给错符号。
     */
    if (stage === null) return null;
    let symbol = info.function ?? null;
    let module = stage;

    /*
     * 多阶段启动时 GDB 同时挂着 setup/解压器/主内核三份符号，低地址会互相遮蔽：
     * 实测在 setup main 的 0x11171 上 GDB 报的是另一个符号。
     * 只要该地址落在已实测的启动阶段里，就用「本阶段符号表 + 装载基址」独立算一次；
     * 源码行号仍只在 GDB 给出非零行号时采用，不凭空生成。
     */
    if (stage !== null) {
      const ours = this.symbols.symbolAt(stage, pc);
      if (ours !== null && (symbol === null || info.line === undefined || info.line === 0 || symbol !== ours.symbol)) {
        symbol = ours.symbol;
        module = stage;
      }
    }
    if (symbol === null) return null;

    let fileHash = null;
    let relativePath = null;
    const fullname = info.fullname;
    if (typeof fullname === 'string' && fullname.startsWith(this.root)) {
      relativePath = path.relative(this.root, fullname);
      try {
        const bytes = fs.readFileSync(fullname);
        fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
      } catch {
        fileHash = null;
      }
    }
    return {
      path: relativePath ?? fullname ?? '',
      fileHash,
      symbol,
      line: info.line ?? 0,
      module,
    };
  }

  /**
   * 组装本帧的证据表。
   *
   * 约定：任何进入 Frame 的值都要能追溯到一个 EvidenceRef；**没采到**也必须
   * 有一条 `unavailable` 并写明原因，不能靠「字段不存在」暗示。T06 的产物
   * （分页状态、队列内容、内存覆盖、磁盘版本）同样按这个规则登记。
   */
  #buildEvidence(cpu, captureId, info, observer = null, t06 = null) {
    const paging = t06?.paging ?? null;
    const virtqueues = t06?.virtqueues ?? null;
    const memoryCoverage = t06?.memoryCoverage ?? null;
    const diskVersion = t06?.diskVersion ?? null;
    const diskEvents = t06?.diskEvents ?? null;
    const os = t06?.os ?? null;
    const osUnavailable = t06?.osUnavailable ?? null;
    return {
      'cpu.registers': {
        kind: 'observed',
        source: 'gdb',
        captureId,
        refs: ['-data-list-register-values x'],
      },
      'cpu.stop': {
        kind: 'observed',
        source: 'gdb',
        captureId,
        refs: [info.raw ?? '-'],
        reason: `停止原因原文: ${info.rawReason}`,
      },
      'cpu.instruction': cpu.instruction?.bytes
        ? {
            kind: 'observed',
            source: 'gdb',
            captureId,
            refs: ['-data-read-memory-bytes'],
            reason: 'PC 处原始指令字节；反汇编文本尚未生成',
          }
        : {
            kind: 'unavailable',
            source: 'gdb',
            captureId,
            refs: [],
            reason: '本帧没有读到 PC 处指令字节（内存读取失败或线性地址不可得）',
          },
      'cpu.segment-cache': observer
        ? {
            kind: 'observed',
            source: 'observer',
            captureId,
            refs: [`x-oslab-capture:${observer.captureId}`],
            reason: `段缓存/控制寄存器/EFER 来自同一停止点的观察者快照（vmGeneration=${observer.vmGeneration}）`,
          }
        : {
            kind: 'unavailable',
            source: 'observer',
            captureId,
            refs: [],
            reason: this.observer.detected
              ? `观察者快照被拒绝: ${this.observer.lastRefusal ?? '未知原因'}`
              : `x-oslab-capture 不可用: ${this.observer.reason}`,
          },
      'os.objects': os === null
        ? {
            kind: 'unavailable',
            source: 'linux-decoder',
            captureId,
            refs: [],
            reason: osUnavailable ?? '本帧没有可用的 Linux 对象解析结果',
          }
        : {
            kind: 'decoded',
            source: 'linux-decoder',
            captureId,
            refs: os.evidence?.refs ?? [],
            reason: os.evidence?.reason,
          },
      // T06 第 1 条：分页与分段解析。它是 `decoded`（页表条目由原始字节按
      // 已知结构解出），不是 `observed`。分页上下文会落进
      // ram/<captureId>/paging.json，历史帧的翻译只认它，不现读寄存器。
      'cpu.paging': paging === null
        ? {
            kind: 'unavailable',
            source: 'page-walker',
            captureId,
            refs: [],
            reason: '本帧缺少 CR0/CR3/CR4，无法判定分页：不用「未分页」冒充恒等映射',
          }
        : paging.state === null
          ? {
              kind: 'unavailable',
              source: 'page-walker',
              captureId,
              refs: [],
              reason: `本帧没有可用的物理读取通道（${paging.reason ?? '未知'}），页表条目读不到`,
            }
          : {
              kind: 'decoded',
              source: 'page-walker',
              captureId,
              refs: [
                `x-oslab-capture:${observer?.captureId ?? '-'}`,
                `ram/${captureId}/paging.json`,
              ],
              reason: paging.pc === null
                ? `分页状态：${paging.state.note ?? '已解析'}；本帧没有可翻译的 PC`
                : paging.pc.fault === null
                  ? `PC ${paging.pc.linear} → 物理 ${paging.pc.physical}`
                    + `（${paging.pc.huge === true ? '大页' : '普通页'}，走过 ${paging.pc.walk.length} 级页表）`
                  : `PC ${paging.pc.linear} 翻译失败：${paging.pc.fault.kind}（${paging.pc.fault.detail}）`,
            },
      // T06 第 2 条：内存覆盖。它只说「本帧采了多少」，不说「整份 RAM 可查」。
      'memory.coverage': memoryCoverage === null
        ? {
            kind: 'unavailable',
            source: 'memory-reader',
            captureId,
            refs: [],
            reason: '内存覆盖统计不可用',
          }
        : {
            kind: 'observed',
            source: 'memory-reader',
            captureId,
            refs: [`ram/${captureId}/`, 'gdb:-data-read-memory-bytes'],
            reason: `${memoryCoverage.mode}：${memoryCoverage.pages} 页 / ${memoryCoverage.bytes} 字节；`
              + `脏页 ${memoryCoverage.dirtyPages === null ? '未建立基线' : memoryCoverage.dirtyPages}；`
              + `${memoryCoverage.note ?? ''}`,
          },
      // T06 第 3 条：virtio 的实际协商格式与队列内存。
      'device.virtio-queues': virtqueues === null || virtqueues.queues.length === 0
        ? {
            kind: 'unavailable',
            source: 'virtqueue-decoder',
            captureId,
            refs: [],
            reason: virtqueues === null
              ? '本帧没有可用的捕获读取器，队列内存读不到'
              : `本帧没有解出任何 virtio 队列（${virtqueues.unavailable[0] ?? '快照里没有 virtqueue 字段'}）`,
          }
        : {
            kind: 'decoded',
            source: 'virtqueue-decoder',
            captureId,
            refs: virtqueues.queues.map((queue) => (
              `virtqueue:${queue.deviceId}#${queue.queueIndex}`
              + `@desc=${queue.descTable ?? 'null'}`
              + `,avail=${queue.availRing ?? 'null'}`
              + `,used=${queue.usedRing ?? 'null'}`
              + `,features=${queue.negotiatedFeatures ?? 'null'}`
            )),
            reason: `按同一 captureId 解出 ${virtqueues.queues.length} 个队列；`
              + '缓冲首字节每设备有配额，bytesRef=null 表示「本次没采」而不是「内容为空」',
          },
      // T06 第 4 条：磁盘逻辑版本。
      'disk.versions': diskVersion === null
        ? {
            kind: 'unavailable',
            source: 'disk-version-store',
            captureId,
            refs: [],
            reason: '基线镜像读不到或基线散列未算出，版本链离开基线无法解释',
          }
        : {
            kind: 'decoded',
            source: 'disk-version-store',
            captureId,
            refs: [
              `disk:${diskVersion.diskId}`,
              `version:${diskVersion.versionId}`,
              `baseline:sha256:${diskVersion.baseSha256}`,
              ...(diskEvents === null ? [] : [`block-events:${diskEvents.consumed}`]),
            ],
            reason: `可见写范围 ${diskVersion.visible.length} 段、未可见写 ${diskVersion.pending.length} 笔；`
              + '版本号由「基线散列 + 已对客体可见的写范围」决定',
          },
      // T06 第 4 条：「pending 写入独立保存」的落地证据。载荷只对**仍在飞行中**
      // 的写请求取（请求一旦对客体可见，驱动就可以立刻复用那块缓冲，再读到的
      // 是别人的内容），所以这一帧取到多少就是多少，取不到时把原因写清楚。
      'disk.payloads': (() => {
        const captured = diskEvents?.payloads ?? null;
        if (captured === null || captured.captured === 0) {
          return {
            kind: 'unavailable',
            source: 'disk-version-store',
            captureId,
            refs: (captured?.skipped ?? []).map((item) => `skip:${item.requestId}:${item.reason}`),
            reason: `本帧没有可保存的写载荷（${captured?.reason ?? '未采集'}）；`
              + '停机动作会 drain 块层，因此只有设备层已挂起的请求才取得到',
          };
        }
        return {
          kind: 'observed',
          source: 'disk-version-store',
          captureId,
          refs: [
            ...captured.requests.map((item) => `payload:${item.requestId}:${item.sha256}`),
            ...captured.skipped.map((item) => `skip:${item.requestId}:${item.reason}`),
          ],
          reason: `从仍在飞行中的写请求取到 ${captured.captured} 笔载荷 / ${captured.bytes} 字节，`
            + '已按内容寻址独立保存（不与基线镜像混在一起）',
        };
      })(),
    };
  }

  /* ---------- T06：取数通道 ---------- */

  /** 历史模式只读存档：需要驱动当前 VM 的采集类操作一律拒绝。 */
  #requireLive(what) {
    if (this.mode !== 'live') {
      const error = new Error(`历史模式不能${what}：历史只读存档，不能驱动当前 VM`);
      error.code = 'history-read-only';
      throw error;
    }
  }

  /**
   * 建一个绑定当前观察者快照的物理读取器；活动快照缺失时返回 null。
   *
   * 返回 null 而不是抛错，是因为调用方对「没有快照」的处理不同：
   * 采集时如实降级（帧里标缺口，别把整帧采丢），按 captureId 读取时直接拒绝。
   */
  #captureReaderOrNull() {
    const capture = this.observer.capture;
    if (capture === null || !this.observer.detected) return null;
    return new CaptureReader({
      qmp: this.qmp,
      capture,
      maxReadBytes: Number(this.observer.capabilities?.memory?.maxReadBytes ?? 4096),
    });
  }

  /**
   * 按 captureId 读取必须有一个有效快照；没有就**拒绝**。
   *
   * 这里刻意不退回 GDB 物理模式：那读的是「当前 VM」的内存，而请求说的是
   * 某一次历史采集的内容，把两者混进同一份产物等于伪造历史。
   */
  #captureReaderOrFail() {
    const reader = this.#captureReaderOrNull();
    if (reader === null) {
      throw this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        this.observer.snapshots === 0
          ? '本会话还没有成功的观察者快照，无法按 captureId 读取物理内存'
          : '上一次观察者快照在 VM 推进后失效，请先停止并发起一次采集',
        { detected: this.observer.detected, lastRefusal: this.observer.lastRefusal },
      );
    }
    return reader;
  }

  /**
   * 「存档读取器」：只读某一次采集**已记录**的字节。
   *
   * 历史帧的页表翻译走它：页表页没被记下来就报 `ram-page-not-recorded`，
   * 不会去读当前 VM 的页表来「补全」——那是把现在冒充成过去。
   */
  #recordedReader(captureId) {
    // 注意 this 的绑定：这里返回的是**对象字面量**，它上面的 `read` 是方法简写，
    // 调用时 this 指向这个字面量而不是 Session。所以必须先在闭包里取出 memory，
    // 不能在 read() 里写 this.memory（那会是 undefined，页表第一项就报
    // 「Cannot read properties of undefined」）。
    const memory = this.memory;
    return {
      source: 'recorded',
      captureId,
      async read(address, length) {
        const result = await memory.readRecorded({
          captureId,
          address,
          length,
        });
        return result.bytes;
      },
    };
  }

  /**
   * 活动采集代在**服务侧**的编号；没有活动快照（VM 已推进）时返回 null。
   *
   * 这是「按 captureId 取数」唯一可用的活动标识来源：观察者快照的 captureId
   * 属于 QEMU 命名空间，与服务侧编号不可比。
   */
  #liveCaptureId() {
    return this.observer.capture?.serviceCaptureId ?? null;
  }

  /** 按 captureId 找帧：先看内存里的，再看落盘的（进程重启后仍可回看）。 */
  #frameByCaptureId(captureId) {
    const inMemory = this.frames.find((frame) => frame.captureId === captureId);
    if (inMemory !== undefined) return inMemory;
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => /^frame-\d+\.json$/.test(name));
    } catch {
      return null;
    }
    for (const name of names) {
      try {
        const frame = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (frame.captureId === captureId) return frame;
      } catch {
        // 半截文件（写崩了）跳过，继续找
      }
    }
    return null;
  }

  /**
   * T06 第 3 条：把设备快照里的 virtqueue 解成契约的 VirtqueueSnapshot。
   *
   * 一个设备解不出来不影响别的设备（失败原因进 unavailable），
   * 因为「面板整体不可用」和「这台设备的队列读不到」是两件事。
   */
  async #collectVirtqueues(observer, captureId, reader) {
    const devices = Array.isArray(observer?.devices) ? observer.devices : [];
    if (reader === null || devices.length === 0) {
      return { devices, queues: [], unavailable: [], decodedDevices: 0 };
    }
    const unavailable = [];
    const queues = [];
    const out = [];
    let decodedDevices = 0;
    for (const device of devices) {
      const isVirtio = typeof device?.kind === 'string' && device.kind.startsWith('virtio');
      const hasQueues = Array.isArray(device?.virtqueues) && device.virtqueues.length > 0;
      if (!isVirtio && !hasQueues) {
        out.push(device);
        continue;
      }
      try {
        const decoded = await decodeDeviceVirtqueues({ reader, device, captureId });
        for (const problem of decoded.unavailable) {
          unavailable.push(`${decoded.deviceId}: ${problem}`);
        }
        for (const queue of decoded.queues) {
          queues.push({
            deviceId: decoded.deviceId,
            queueIndex: queue.queueIndex,
            descTable: queue.descTable ?? null,
            availRing: queue.availRing ?? null,
            usedRing: queue.usedRing ?? null,
            negotiatedFeatures: queue.negotiatedFeatures ?? null,
            size: queue.size ?? null,
            ready: queue.ready === true,
          });
        }
        if (decoded.queues.length > 0) decodedDevices += 1;
        out.push(mergeQueuesIntoSnapshot(device, decoded.queues));
      } catch (error) {
        unavailable.push(`设备 ${device?.deviceId ?? 'unknown'} 的队列解码失败: ${error.message}`);
        out.push(device);
      }
    }
    return { devices: out, queues, unavailable, decodedDevices };
  }

  /**
   * T06 第 1 条：解析本帧的分段/分页并翻译 PC。
   *
   * 失败一律如实降级（state=null + reason）而不是抛错：一次分页解析失败
   * 不该把同一次停止的寄存器、设备状态也一起丢掉。
   */
  async #collectPaging(cpu, captureId, reader) {
    const attribution = {
      sessionId: this.id,
      epoch: this.epoch,
      frameId: this.frames.length,
      captureId,
    };
    if (reader === null) {
      return { state: null, pc: null, reason: '没有可用的捕获读取器', saved: null, stats: null };
    }
    if (
      toBigIntValue(cpu?.control?.cr0) === null
      || toBigIntValue(cpu?.control?.cr3) === null
      || toBigIntValue(cpu?.control?.cr4) === null
    ) {
      // 缺 CR3 时不能用「未分页」冒充：那会把所有线性地址当物理地址。
      return {
        state: null,
        pc: null,
        reason: '本帧的 CPU 快照缺少 CR0/CR3/CR4，无法判定分页',
        saved: null,
        stats: null,
      };
    }
    let walker;
    try {
      walker = new PageWalker({ cpu, attribution, reader });
    } catch (error) {
      return { state: null, pc: null, reason: error.message, saved: null, stats: null };
    }
    const state = walker.describe();
    const pcAddress = toBigIntValue(cpu.linearPc);
    let pc = null;
    if (pcAddress !== null) {
      try {
        pc = await walker.translate(pcAddress);
      } catch (error) {
        this.#record('memory.paging.translate-failed', { captureId, message: error.message });
      }
    }
    // 分页上下文落盘：历史帧的翻译必须用当时的 CR3，不能现读寄存器。
    let saved = null;
    try {
      saved = await this.memory.writePaging({
        captureId,
        paging: {
          schema: 'oslab.paging/1',
          captureId,
          attribution,
          state,
          pc,
          cpu: {
            mode: cpu.mode,
            cpl: cpu.cpl,
            cr0: cpu.control.cr0,
            cr3: cpu.control.cr3,
            cr4: cpu.control.cr4,
            efer: cpu.efer,
            segments: {
              cs: cpu.segments?.cs ?? null,
              ss: cpu.segments?.ss ?? null,
              ds: cpu.segments?.ds ?? null,
            },
          },
          stats: walker.stats,
          recordedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      this.#record('memory.paging.write-failed', { captureId, message: error.message });
    }
    this.#record('memory.paging', {
      captureId,
      enabled: state.enabled,
      levels: state.levels,
      rootTable: state.rootTable,
      pc: cpu.linearPc,
      physical: pc?.physical ?? null,
      fault: pc?.fault?.kind ?? null,
      pageTableReads: walker.stats.reads,
      pageTableHits: walker.stats.hits,
    });
    const summary = { state, pc, reason: null, saved, stats: walker.stats };
    this.t06.lastPaging = summary;
    return summary;
  }

  /**
   * T06 第 4 条：把本帧区间内的块请求事件喂进磁盘版本台账。
   *
   * 窗口是「上一帧的水位线之后 → 本帧的 fence」，两个端点都取自**客体事件环**
   * （`x-oslab-events`），不是服务自己的序号。事件缺失时 `complete()` 会记 note
   * 而不推进版本：宁可显示「这笔写入没有对应的提交记录」，也不能凭猜。
   */
  async #consumeBlockEvents({ captureId, parent }) {
    const from = parent === null
      ? null
      : String(Number(parent.eventWatermark ?? parent.eventRange?.last ?? 0) + 1);
    const to = this.observer.capture?.fenceSeq ?? this.observer.capture?.eventWatermark ?? null;
    const base = {
      consumed: 0,
      submits: 0,
      completes: 0,
      orphanCompletes: 0,
      from,
      to,
      refused: null,
      // 环容量有限：扫描到但因为环形覆盖丢掉的事件必须如实带出来，
      // 否则「没看到 block.complete」会被误读成「这笔写还没完成」。
      dropped: null,
      truncated: null,
      scanned: null,
      filtered: null,
    };
    if (!this.observer.detected || this.observer.capture === null || to === null) return base;
    const observerCaptureId = this.observer.capture.captureId;
    base.observerCaptureId = observerCaptureId;
    let result;
    try {
      result = await this.qmp.observerEvents(
        {
          // 观察者侧的编号：x-oslab-events 的 captureId 绑定比的是 QEMU 自己的快照
          // id，服务侧编号（cap-<会话>-<序号>）传进去只会被判 capture-mismatch，
          // 于是「窗口里明明有块事件」被读成 0 条。
          captureId: observerCaptureId,
          from,
          to,
          kinds: ['block.submit', 'block.complete'],
          limit: 8192,
        },
        { timeoutMs: 20000 },
      );
    } catch (error) {
      this.#record('disk.events.failed', { captureId, message: error.message });
      return { ...base, refused: error.message };
    }
    if (result?.ok !== true) {
      const reason = result?.reason ?? 'unknown';
      this.#record('disk.events.refused', { captureId, reason });
      return { ...base, refused: reason };
    }
    this.disk.captureId = captureId;
    base.dropped = result.dropped === undefined || result.dropped === null ? null : Number(result.dropped);
    base.truncated = result.truncated === true;
    base.scanned = result.scanned ?? null;
    base.filtered = result.filtered ?? null;
    const events = Array.isArray(result.events) ? result.events : [];
    for (const event of events) {
      const detail = event?.detail ?? {};
      // requestId 的写法与观察者台账一致：vq<队列索引>-<描述符>，只在同一设备内唯一。
      // 观察者自 v1 起无条件序列化这个字段（哪怕是零值 vq0-0），所以直接用它；
      // 只有字段缺失时才按 detail 里的分量重建，保证与 pending 台账的键一致。
      const requestId = typeof event?.requestId === 'string' && event.requestId.length > 0
        ? event.requestId
        : `vq${detail.queueIndex ?? 0}-${detail.descHead ?? 0}`;
      if (event?.kind === 'block.submit') {
        this.disk.submit({
          requestId,
          deviceId: event.deviceId ?? this.disk.diskId,
          lba: event.address,
          bytes: event.size,
          op: detail.op ?? 'unknown',
          seq: event.seq,
          queueIndex: detail.queueIndex ?? null,
          descHead: detail.descHead ?? null,
        });
        base.submits += 1;
      } else if (event?.kind === 'block.complete') {
        const entry = this.disk.complete({
          requestId,
          status: detail.status ?? (Number(detail.statusCode ?? 0) === 0 ? 'ok' : 'error'),
          statusCode: detail.statusCode ?? null,
          seq: event.seq,
        });
        base.completes += 1;
        if (entry === null) base.orphanCompletes += 1;
      }
    }
    base.consumed = events.length;
    this.t06.lastDiskEvents = base;
    if (events.length > 0) this.#record('disk.events', { captureId, ...base });
    return base;
  }

  /**
   * T06 第 4 条：「pending 写入独立保存」。
   *
   * 为什么必须趁请求**还在飞行中**取载荷：virtio 规定驱动要保证缓冲区在设备
   * 写回 used ring（也就是对客体可见）之前一直有效；一旦请求对客体可见，驱动
   * 可以立刻复用同一块缓冲（`dd` 就是这样，4 次写共用一个缓冲）。那时候再去读，
   * 读到的是**下一个**请求的内容，把它记成本次写入的载荷就是伪造历史。
   * 所以只有「此刻仍 pending」的写请求的载荷是可证的：取到就存成独立文件，
   * 取不到就如实记成 skipped，绝不用别的时刻的字节顶上。
   *
   * 段的来源是同一 requestId 的 `dma.read` 事件（设备从客体读）。写请求的描述
   * 符链是 [16 字节请求头][数据][1 字节状态]，设备读到的部分去掉前 16 字节正是
   * 这次要写到盘上的数据，长度必须等于设备的 `qiov.size`。
   */
  async #captureWritePayloads({ captureId, reader }) {
    const base = { captured: 0, bytes: 0, requests: [], skipped: [], adoptedPending: 0, reason: null };
    const capture = this.observer.capture;
    if (capture === null) return { ...base, reason: 'no-active-capture' };
    const ledger = capture.pendingIo ?? null;
    const entries = Array.isArray(ledger?.blockRequests) ? ledger.blockRequests : [];
    // 只取写：读请求不改磁盘内容，它的载荷不进版本链。
    const flying = entries.filter(
      (entry) => entry?.op === 'write' && typeof entry.requestId === 'string' && entry.requestId.length > 0,
    );
    if (flying.length === 0) return { ...base, reason: 'no-pending-write' };

    // 台账是「此刻仍在飞行」的权威来源：即使它的 block.submit 落在本帧窗口之外，
    // 也应当出现在版本的 pending 列表里（否则「飞行中的写」会被显示成「不存在」）。
    //
    // 「同 requestId 是重提交还是另一笔写」这条判断交给版本表自己做（见
    // disk-version-store.submit 的两个分支）：它知道那条记录完成过没有，而这里
    // 只看得到台账，判错就会把一笔已经对客体可见的写凭空抹掉或凭空造出来。
    for (const entry of flying) {
      this.disk.submit({
        requestId: entry.requestId,
        deviceId: entry.deviceId ?? this.disk.diskId,
        // 台账的 lba 是起始扇区号（512 字节单位，十进制字符串），与 block.submit
        // 事件里 address 的语义一致；byteOffset 是字节偏移，用它会差 512 倍。
        lba: entry.lba ?? 0,
        bytes: entry.length ?? entry.bytes ?? 0,
        op: 'write',
        seq: entry.submitSeq ?? null,
        queueIndex: entry.queueIndex ?? null,
        descHead: entry.descHead ?? null,
      });
      base.adoptedPending += 1;
    }

    if (reader === null || reader === undefined) return { ...base, reason: 'no-reader' };
    const submits = flying
      .map((entry) => Number(entry.submitSeq))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (submits.length === 0) return { ...base, reason: 'no-submit-seq' };
    /*
     * 窗口上界取**最大的一次 submit**，不是 fence。
     *
     * dma.* 由 virtqueue_pop() 在「描述符链已映射好、请求还没交给设备」时上报
     * （见 instrumentation/qemu-observer/patches/0003-t05c-dma-virtio.patch），
     * 所以同一 requestId 的段一定早于它这一次的 block.submit。requestId 是描述符
     * 索引、会被反复复用，把上界拉到 fence 就会把同一 id 的**历史**请求的段也算进
     * 本次载荷（实测：期望 4096 字节，凑出 12448 字节）。
     */
    const to = String(Math.max(...submits));
    const from = String(Math.max(1, Math.min(...submits) - DMA_LOOKBACK_EVENTS));

    let result;
    try {
      // captureId 用**观察者**那一侧的编号：x-oslab-events 的绑定比的是 QEMU
      // 自己的快照 id，把服务侧编号传进去只会被判 capture-mismatch。
      result = await this.qmp.observerEvents(
        { captureId: capture.captureId, from, to, kinds: ['dma.read'], limit: 65536 },
        { timeoutMs: 20000 },
      );
    } catch (error) {
      this.#record('disk.payloads.failed', { captureId, message: error.message });
      return { ...base, reason: `query-failed:${error.message}` };
    }
    if (result?.ok !== true) {
      return { ...base, reason: `query-refused:${result?.reason ?? 'unknown'}` };
    }

    const events = Array.isArray(result.events) ? result.events : [];
    const byRequest = new Map();
    for (const event of events) {
      const requestId = typeof event?.requestId === 'string' ? event.requestId : null;
      if (requestId === null) continue;
      const address = toBigInt(event.address);
      const size = Number(event.size);
      if (address === null || !Number.isInteger(size) || size <= 0) continue;
      if (!byRequest.has(requestId)) byRequest.set(requestId, []);
      byRequest.get(requestId).push({ address, size, seq: Number(event.seq ?? 0) });
    }

    const skipped = [];
    for (const entry of flying) {
      const expected = Number(entry.length ?? entry.bytes ?? 0);
      if (!(expected > 0)) {
        // 不知道这次写要搬多少字节，就无从判断「哪几段属于本次」，宁可不采。
        skipped.push({ requestId: entry.requestId, reason: 'no-expected-length' });
        continue;
      }
      const submitSeq = Number(entry.submitSeq);
      const segments = (Number.isFinite(submitSeq) && submitSeq > 0
        ? (byRequest.get(entry.requestId) ?? []).filter((segment) => segment.seq < submitSeq)
        : (byRequest.get(entry.requestId) ?? []))
        .slice()
        .sort((left, right) => left.seq - right.seq);
      if (segments.length === 0) {
        skipped.push({ requestId: entry.requestId, reason: 'no-dma-segments-in-window' });
        continue;
      }
      /*
       * 只取「紧贴着这次 submit 之前、字节数恰好凑够描述符链」的那一串段。
       *
       * 为什么不能把窗口里同 id 的段全用上：requestId 是描述符索引，会被复用，
       * 窗口里往往还留着这个 id 上一次、上上次请求的段。描述符链的总长是确定的
       * ——16 字节请求头 + 载荷长度——所以从最新的一段往回累加，第一次凑够就是
       * 本次请求的那串；凑不够/超了都如实记 skipped，绝不用更早的同 id 请求的
       * 字节顶上（那就是伪造历史）。
       */
      const wanted = VIRTIO_BLK_OUTHDR_BYTES + expected;
      const chosen = [];
      let total = 0;
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        chosen.unshift(segments[index]);
        total += segments[index].size;
        if (total >= wanted) break;
      }
      if (total !== wanted) {
        skipped.push({
          requestId: entry.requestId,
          reason: `segment-sum-mismatch:got=${total},want=${wanted}`,
        });
        continue;
      }
      const chunks = [];
      let readError = null;
      for (const segment of chosen) {
        try {
          chunks.push(Buffer.from(await reader.read(segment.address, segment.size)));
        } catch (error) {
          readError = error.message;
          break;
        }
      }
      if (readError !== null) {
        skipped.push({ requestId: entry.requestId, reason: `read-failed:${readError}` });
        continue;
      }
      const payload = Buffer.concat(chunks).subarray(VIRTIO_BLK_OUTHDR_BYTES);
      if (payload.length !== expected) {
        skipped.push({
          requestId: entry.requestId,
          reason: `length-mismatch:got=${payload.length},want=${expected}`,
        });
        continue;
      }
      const digest = await this.disk.recordPayload({ requestId: entry.requestId, bytes: payload });
      base.captured += 1;
      base.bytes += payload.length;
      base.requests.push({ requestId: entry.requestId, length: payload.length, sha256: digest });
    }
    base.skipped = skipped;
    this.#record('disk.payloads', {
      captureId,
      captured: base.captured,
      bytes: base.bytes,
      pending: flying.length,
      adoptedPending: base.adoptedPending,
      skipped: skipped.length,
      segments: events.length,
    });
    return base;
  }

  /** 基线镜像的内容散列只算一次；算不出来时 `version()` 会返回 null。 */
  async #ensureDiskBase() {
    try {
      const digest = await this.disk.baseHash();
      this.diskBaseReady = digest !== null;
      return digest;
    } catch (error) {
      this.diskBaseReady = false;
      this.#record('disk.baseline.failed', { message: error.message });
      return null;
    }
  }

  /** 本帧的内存覆盖统计（契约 MemoryCoverageStats）。 */
  async #memoryCoverageFor(captureId, memory) {
    const recorded = (memory ?? []).filter((entry) => entry.coverage === 'recorded');
    return this.memory.coverage({
      captureId,
      selectedPages: recorded.length,
      selectedBytes: recorded.reduce((sum, entry) => sum + (entry.length ?? 0), 0),
    });
  }

  /* ---------- T06：内存 / 分页 / 队列 / 磁盘数据服务 ---------- */

  /**
   * 全量 RAM 基线。
   *
   * 显式操作，通过独立命令显式触发：512 MiB 是 131072 次 4 KiB 读，
   * 每次采集都做会把「暂停看一帧」变成几十秒的等待。
   */
  async memoryBaseline({ requestId = null, onProgress = null } = {}) {
    // 全量基线要按 4 KiB 读 512 MiB（131072 次「绑定 captureId 的物理读」），
    // 在 TCG 上就是分钟级；用默认的 20 秒控制超时会把成功的长任务判成失败，
    // 所以这里只给长耗时采集类命令放宽超时。
    const { value } = await this.#executeControl('memory.baseline', requestId, async () => {
      this.#requireLive('采集全量 RAM 基线');
      const capture = this.observer.capture;
      if (capture === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '没有活动的观察者快照：基线必须挂在某一次采集上，请先停止并采集一次',
          { lastRefusal: this.observer.lastRefusal },
        );
      }
      const reader = this.#captureReaderOrFail();
      const regions = ramRegionsOf(capture);
      // 落盘键与公共标识一律用服务侧采集代编号：基线要挂在「哪一帧」上，
      // 这样帧里的 coverage.memory 与历史回读才能找到它。
      const captureId = this.#liveCaptureId();
      if (captureId === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '当前观察者快照还没有绑定任何服务侧采集代：基线必须挂在一次已提交的采集上',
          { observerCaptureId: capture.captureId },
        );
      }
      const started = Date.now();
      const meta = await this.memory.baseline({
        captureId,
        regions,
        reader,
        onProgress,
      });
      const elapsedMs = Date.now() - started;
      this.#record('memory.baseline', {
        captureId,
        observerCaptureId: capture.captureId,
        pages: meta.pages,
        regionPages: meta.regionPages,
        bytes: meta.bytes,
        complete: meta.complete,
        missingCount: meta.missingCount,
        rawSha256: meta.rawSha256,
        elapsedMs,
        physicalReads: reader.reads,
      });
      this.t06.lastCoverage = meta.coverage;
      return {
        schema: 'oslab.memory.baseline/1',
        captureId,
        observerCaptureId: capture.captureId,
        regions: regions.map((region) => ({
          name: region.name,
          kind: region.kind,
          base: hex(region.base),
          size: hex(region.size),
        })),
        pages: meta.pages,
        regionPages: meta.regionPages,
        bytes: meta.bytes,
        fileBytes: meta.fileBytes,
        complete: meta.complete,
        missingCount: meta.missingCount,
        skipped: meta.skipped,
        ramSha256: meta.rawSha256,
        generatedAt: meta.generatedAt,
        elapsedMs,
        physicalReads: reader.reads,
        coverage: meta.coverage,
        attribution: {
          sessionId: this.id,
          epoch: this.epoch,
          frameId: this.frames.at(-1)?.frameId ?? 0,
          captureId,
        },
      };
    }, { timeoutMs: LONG_CAPTURE_TIMEOUT_MS });
    return value;
  }

  /**
   * 脏页增量：把 RAM 重扫一遍与基线比散列，变化的页内容落盘。
   *
   * 判据是「按页重读并比散列」，通过重读字节与散列比较确定——CPU 写、DMA 写、
   * 设备写一视同仁，事件只用于事后核对有没有漏采（`crossCheckEvents`）。
   */
  async memoryDelta({ requestId = null, baseCaptureId = null, onPage = null } = {}) {
    // 与基线同理：重扫一遍 512 MiB 是分钟级任务，要放宽控制超时。
    const { value } = await this.#executeControl('memory.delta', requestId, async () => {
      this.#requireLive('重扫 RAM 产生脏页增量');
      const capture = this.observer.capture;
      if (capture === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '没有活动的观察者快照：增量必须在一次成功的采集上做',
          { lastRefusal: this.observer.lastRefusal },
        );
      }
      const reader = this.#captureReaderOrFail();
      const base = baseCaptureId ?? (await this.memory.latestBaselineCapture());
      if (base === null) {
        throw this.#protocolError(
          ErrorCode.INVALID_REQUEST,
          '还没有任何 RAM 基线：增量挂在基线的版本链上，请先做一次 memoryBaseline',
          { hint: 'POST /api/sessions/:id/commands {type:"memory.baseline"}' },
        );
      }
      const info = await this.memory.baselineInfo(base);
      if (info === null) {
        throw this.#protocolError(
          ErrorCode.INVALID_REQUEST,
          `采集 ${base} 没有基线记录，不能作为增量的父代`,
          { baseCaptureId: base },
        );
      }
      const observerCaptureId = capture.captureId;
      const observedAt = this.#liveCaptureId();
      if (observedAt === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '当前观察者快照还没有绑定任何服务侧采集代：无法记录这次重扫发生在哪一代',
          { observerCaptureId },
        );
      }
      const result = await this.memory.delta({
        captureId: base,
        observedAtCaptureId: observedAt,
        regions: ramRegionsOf(capture),
        reader,
        onPage,
      });
      this.#record('memory.delta', {
        baseCaptureId: base,
        observedAtCaptureId: observedAt,
        observerCaptureId,
        changed: result.diff.changed.length,
        added: result.diff.added.length,
        unreadable: result.diff.unreadable.length,
        unchanged: result.diff.unchanged,
        sweepPages: result.sweep.pages,
        elapsedMs: result.sweep.elapsedMs,
      });
      this.t06.lastCoverage = await this.memory.coverage({ captureId: base });
      return {
        schema: 'oslab.memory.delta/1',
        baseCaptureId: base,
        observedAtCaptureId: observedAt,
        observerCaptureId,
        delta: result.delta,
        diff: result.diff,
        sweep: result.sweep,
        coverage: this.t06.lastCoverage,
        attribution: {
          sessionId: this.id,
          epoch: this.epoch,
          frameId: this.frames.at(-1)?.frameId ?? 0,
          captureId: observedAt,
        },
      };
    }, { timeoutMs: LONG_CAPTURE_TIMEOUT_MS });
    return value;
  }

  /**
   * 可选局部内存采集：读一段（可跨页）并落进增量，于是它在历史里也读得到。
   */
  async memorySelected({ requestId = null, address, length = 64 } = {}) {
    const { value } = await this.#executeControl('memory.selected', requestId, async () => {
      this.#requireLive('做局部内存采集');
      const start = toBigIntValue(address);
      if (start === null) {
        throw this.#protocolError(ErrorCode.INVALID_REQUEST, `地址无法解析: ${String(address)}`);
      }
      if (!Number.isInteger(length) || length <= 0 || length > 1024 * 1024) {
        throw this.#protocolError(ErrorCode.INVALID_REQUEST, 'length 必须是 1..1048576 的整数');
      }
      const capture = this.observer.capture;
      if (capture === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '没有活动的观察者快照：局部采集必须绑定一次采集，才能进历史',
          { lastRefusal: this.observer.lastRefusal },
        );
      }
      const reader = this.#captureReaderOrFail();
      const observedAt = this.#liveCaptureId();
      if (observedAt === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '当前观察者快照还没有绑定任何服务侧采集代：局部采集必须挂在一次已提交的采集上',
          { observerCaptureId: capture.captureId },
        );
      }
      // 父代取最近一次基线（若有），这样局部页挂在同一条版本链上。
      const parentCaptureId = await this.memory.latestBaselineCapture();
      const record = await this.memory.readLocal({
        captureId: parentCaptureId ?? observedAt,
        parentCaptureId,
        address: start,
        length,
        reader,
      });
      // 响应里的字节直接回读存档，保证「看到的」就是「存下来的」。
      const stored = await this.memory.readRecorded({
        captureId: parentCaptureId ?? observedAt,
        address: start,
        length,
      });
      const blobRef = crypto.createHash('sha256').update(stored.bytes).digest('hex');
      this.#record('memory.selected', {
        captureId: parentCaptureId ?? observedAt,
        observedAtCaptureId: observedAt,
        observerCaptureId: capture.captureId,
        address: hex(start),
        length,
        blobRef,
        delta: record,
      });
      return {
        schema: 'oslab.memory.selected/1',
        addressSpace: 'physical',
        address: hex(start),
        length: stored.bytes.length,
        bytes: stored.bytes.toString('base64'),
        hex: stored.bytes.toString('hex'),
        blobRef,
        from: stored.from,
        delta: record,
        attribution: {
          sessionId: this.id,
          epoch: this.epoch,
          frameId: this.frames.at(-1)?.frameId ?? 0,
          captureId: parentCaptureId ?? observedAt,
        },
      };
    });
    return value;
  }

  /**
   * 历史读取：只认某一次采集自己记录的字节。
   * 找不到就报 `ram-page-not-recorded`，绝只消费指定帧或采集代的数据 补上。
   */
  async memoryReadRecorded({ captureId = null, address, length = 64 }) {
    const start = toBigIntValue(address);
    if (start === null) throw new Error(`地址无法解析: ${String(address)}`);
    if (!Number.isInteger(length) || length <= 0 || length > 1024 * 1024) {
      throw new Error('length 必须是 1..1048576 的整数');
    }
    const target = captureId
      ?? this.frames.at(-1)?.captureId
      ?? null;
    if (target === null) throw new Error('还没有任何采集代可以作为读取对象');
    try {
      const result = await this.memory.readRecorded({ captureId: target, address: start, length });
      return {
        schema: 'oslab.memory.recorded/1',
        addressSpace: 'physical',
        address: hex(start),
        length: result.bytes.length,
        bytes: result.bytes.toString('base64'),
        hex: result.bytes.toString('hex'),
        blobRef: crypto.createHash('sha256').update(result.bytes).digest('hex'),
        from: result.from,
        attribution: {
          sessionId: this.id,
          epoch: this.epoch,
          frameId: this.frames.at(-1)?.frameId ?? 0,
          captureId: target,
        },
        evidence: {
          kind: 'observed',
          source: 'memory-reader',
          captureId: target,
          refs: [`ram/${target}/`, result.from],
          reason: '来自该采集代的存档（基线或增量），不是当前 VM 的内存',
        },
      };
    } catch (error) {
      if (error?.code === 'ram-page-not-recorded') {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          error.message,
          { captureId: target, address: hex(start), length },
        );
      }
      throw error;
    }
  }

  /** 覆盖统计（契约 MemoryCoverageStats）。 */
  async memoryCoverage({ captureId = null } = {}) {
    const target = captureId ?? this.frames.at(-1)?.captureId ?? null;
    if (target === null) {
      return {
        mode: 'selected-pages',
        pages: 0,
        bytes: 0,
        dirtyPages: null,
        ramSha256: null,
        note: '还没有任何采集代；任意地址的历史回读需要先采集并建立基线',
      };
    }
    const stats = await this.memory.coverage({ captureId: target });
    this.t06.lastCoverage = stats;
    return { captureId: target, ...stats, deltas: await this.memory.deltas(target) };
  }

  /**
   * 地址翻译（T06 第 1 条）。
   *
   * 分页上下文来自**该次采集的 CPU 快照 + 落盘的 paging.json**：
   * - 目标就是当前活动快照时，用活动读取器读页表；
   * - 目标是历史采集时，用「存档读取器」读页表页，页表页没记下来就如实报错。
   *
   * 两条路径都不会去现读寄存器，所以「历史帧的翻译」不会偷偷变成「现在的翻译」。
   */
  async translate({ requestId = null, address, segmentBase = undefined, withSegment = false, captureId = null } = {}) {
    const { value } = await this.#executeControl('memory.translate', requestId, async () => {
      const linear = toBigIntValue(address);
      if (linear === null) {
        throw this.#protocolError(ErrorCode.INVALID_REQUEST, `地址无法解析: ${String(address)}`);
      }
      const activeCaptureId = this.#liveCaptureId();
      const target = captureId ?? activeCaptureId ?? this.frames.at(-1)?.captureId ?? null;
      if (target === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          '还没有任何采集代：分页上下文必须来自某一帧的 CPU 快照',
        );
      }
      const frame = this.#frameByCaptureId(target);
      const paging = await this.memory.readPaging(target);
      if (frame === null && paging === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          `采集 ${target} 没有留下 CPU 快照或分页上下文，无法翻译地址`,
          { captureId: target },
        );
      }
      const cpu = frame?.cpu ?? (paging?.cpu
        ? {
            mode: paging.cpu.mode,
            cpl: paging.cpu.cpl,
            control: {
              cr0: paging.cpu.cr0,
              cr2: null,
              cr3: paging.cpu.cr3,
              cr4: paging.cpu.cr4,
              cr8: null,
            },
            efer: paging.cpu.efer,
            segments: paging.cpu.segments ?? {},
            linearPc: null,
          }
        : null);
      if (cpu === null) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          `采集 ${target} 没有分页上下文（paging.json 缺失），不能用当前寄存器代替`,
          { captureId: target },
        );
      }
      // 目标就是**当前活动的那一代采集**时，用绑定该快照的读取器直接读页表；
      // 否则只能读那一代已经记录下来的字节（页表页没记下来就如实报错）。
      // 判据是服务侧编号相等，不是两边 captureId 字符串相等——见 #liveCaptureId。
      const useActive = activeCaptureId !== null && activeCaptureId === target;
      const reader = useActive ? this.#captureReaderOrFail() : this.#recordedReader(target);
      const attribution = {
        sessionId: this.id,
        epoch: this.epoch,
        frameId: frame?.frameId ?? this.frames.at(-1)?.frameId ?? 0,
        captureId: target,
      };
      let walker;
      try {
        walker = new PageWalker({
          cpu,
          attribution,
          reader,
          readerSource: useActive ? 'observer' : 'recorded',
          ...(segmentBase !== undefined ? { segmentBase } : {}),
          withSegment,
        });
      } catch (error) {
        throw this.#protocolError(ErrorCode.RANGE_NOT_CAPTURED, error.message, { captureId: target });
      }
      const translation = await walker.translate(linear);
      return {
        schema: 'oslab.memory.translate/1',
        captureId: target,
        live: useActive,
        reader: useActive ? 'observer' : 'recorded',
        // 观察者那一侧的快照编号（QEMU 命名空间）；历史翻译时为 null，
        // 此时字节来自 ram/<captureId>/ 的存档。
        observerCaptureId: useActive ? this.observer.capture?.captureId ?? null : null,
        paging: walker.describe(),
        translation,
        stats: walker.stats,
      };
    });
    return value;
  }

  /**
   * 队列面板：返回按 captureId 解码后的 virtio 队列（契约 VirtqueueSnapshot）。
   * 没有活动快照时只用帧里已解出的内容，只消费指定帧或采集代的数据。
   */
  async virtqueues({ captureId = null, queueIndexes = null } = {}) {
    const target = captureId ?? this.#liveCaptureId() ?? this.frames.at(-1)?.captureId ?? null;
    if (target === null) {
      return { schema: 'oslab.virtqueues/1', captureId: null, devices: [], unavailable: ['还没有任何采集代'] };
    }
    const frame = this.#frameByCaptureId(target);
    const devices = Array.isArray(frame?.devices) ? frame.devices : [];
    const filtered = devices.map((device) => {
      if (queueIndexes === null || !Array.isArray(device?.virtqueues)) return device;
      return {
        ...device,
        virtqueues: device.virtqueues.filter((queue) => queueIndexes.includes(queue.queueIndex ?? 0)),
      };
    });
    const unavailable = [];
    if (this.t06.lastVirtqueues !== null && this.t06.lastVirtqueues.captureId === target) {
      unavailable.push(...this.t06.lastVirtqueues.unavailable);
    }
    if (devices.length === 0) unavailable.push('该采集代没有设备快照');
    return {
      schema: 'oslab.virtqueues/1',
      captureId: target,
      frameId: frame?.frameId ?? null,
      devices: filtered,
      unavailable,
    };
  }

  /** 磁盘逻辑版本表（契约 DiskVersion）。基线散列缺失时版本为 null。 */
  async diskView() {
    await this.#ensureDiskBase();
    const version = this.disk.version({ createdAt: null });
    const baselines = await this.memory.baselineCaptures();
    return {
      schema: 'oslab.disk/1',
      diskId: this.disk.diskId,
      version,
      versionId: version?.versionId ?? null,
      visible: version?.visible ?? [],
      pending: version?.pending ?? [],
      notes: this.disk.notes,
      baseline: {
        path: this.disk.basePath,
        sha256: this.disk.baseSha256,
        bytes: this.disk.baseBytes,
        ready: this.diskBaseReady,
      },
      ramBaselines: baselines.map((entry) => entry.captureId),
      attribution: {
        sessionId: this.id,
        epoch: this.epoch,
        frameId: this.frames.at(-1)?.frameId ?? 0,
        captureId: this.frames.at(-1)?.captureId ?? null,
      },
    };
  }

  /** 按 LBA 读帧绑定的逻辑版本内容（可见写载荷优先，否则基线）。 */
  async diskRead({ lba, count = 1 }) {
    const sector = toBigIntValue(lba);
    if (sector === null) throw new Error(`lba 无法解析: ${String(lba)}`);
    await this.#ensureDiskBase();
    let result;
    try {
      result = await this.disk.read({ lba: sector, count });
    } catch (error) {
      // 可见但没有载荷的写：基线内容在该范围上已经不成立，
      // 这里如实说「本代没采到载荷」，不返回基线旧值冒充新值。
      throw this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        error.message,
        { ...(error.detail ?? {}), lba: hex(sector), count },
      );
    }
    const buffer = Buffer.from(result.bytes, 'base64');
    this.#record('disk.read', { lba: hex(sector), count, fromBase: result.fromBase });
    return {
      schema: 'oslab.disk.read/1',
      diskId: this.disk.diskId,
      versionId: result.versionId,
      lba: hex(sector),
      count: result.count,
      length: buffer.length,
      bytes: result.bytes,
      hex: buffer.toString('hex'),
      blobRef: crypto.createHash('sha256').update(buffer).digest('hex'),
      fromBase: result.fromBase,
      evidence: result.evidence ?? null,
    };
  }

  /** 独立保存的 pending 写载荷（内容寻址）。 */
  async diskPayloads({ requestId = null } = {}) {
    const targets = requestId === null
      ? [...this.disk.payloads.keys()]
      : [requestId];
    const out = [];
    for (const id of targets) {
      const entry = this.disk.writeFor(id) ?? this.disk.reads.get(id) ?? null;
      // 载荷的权威绑定在写记录上：requestId 会被复用，按 id 的索引只是「最后一次
      // 写入者胜出」。记录不认识这个 id 时才退回索引（例如只落了文件没留记录）。
      const digest = this.disk.payloadRefFor(entry) ?? this.disk.payloads.get(id) ?? null;
      const bytes = digest === null ? null : await this.disk.payloadBytes(digest);
      out.push({
        requestId: id,
        dataRef: digest,
        path: digest === null ? null : this.disk.payloadPath(digest),
        length: bytes?.length ?? null,
        blobRef: bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes === null ? null : bytes.toString('base64'),
        state: entry?.status ?? null,
        lba: entry === null ? null : hex(entry.lba),
        count: entry?.count ?? null,
        op: entry?.op ?? null,
      });
    }
    return {
      schema: 'oslab.disk.payloads/1',
      diskId: this.disk.diskId,
      payloads: out,
      note: 'pending 写的内容在这里独立保存（内容寻址），不与基线镜像混在一起',
    };
  }

  /**
   * 离线校验根盘（T06 验收第四条）。
   *
   * 前提是 VM 已经停止：活跃的 qcow2 边写边读会得到不一致的内容，
   * 校验也就没有意义。这里显式检查进程状态，不「顺手试一下」。
   */
  async offlineDiskCheck({ sectors = null, overlayPath = null } = {}) {
    if (this.process?.alive === true) {
      throw this.#protocolError(
        ErrorCode.CONTROL_BUSY,
        'VM 仍在运行：活跃 qcow2 边写边读会得到不一致的内容，先关闭会话再做离线校验',
        { pid: this.process?.proc?.pid ?? null },
      );
    }
    await this.#ensureDiskBase();
    const overlay = overlayPath ?? this.process?.paths?.disk ?? path.join(this.dir, 'rootfs.qcow2');
    if (!fs.existsSync(overlay)) {
      throw this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        `覆盖层镜像不存在: ${overlay}`,
        { sessionDir: this.dir },
      );
    }
    const result = await this.disk.offlineVerify({ overlayPath: overlay, sectors });
    this.#record('disk.offline-verify', {
      overlay,
      ok: result.ok,
      checked: result.checked,
      mismatches: result.mismatches?.length ?? 0,
    });
    return {
      schema: 'oslab.disk.offline/1',
      overlayPath: overlay,
      processAlive: this.process?.alive === true,
      ...result,
    };
  }

  /* ---------- 命令 ---------- */

  async #executeControl(type, requestId, task, queueOptions = undefined) {
    if (this.state === 'closed') throw new Error('会话已关闭');
    const result = await this.queue.execute(requestId, task, queueOptions);
    return result;
  }

  async step({ requestId, granularity = 'instruction', count = 1, previousPc = null }) {
    const entries = [];
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const { value } = await this.#executeControl('step', `${requestId}:${index}`, async () => {
        const before = this.frames.at(-1)?.cpu?.rip ?? null;
        const stopped = this.#waitForStop(20000);
        await this.#issueStep(granularity);
        const payload = await stopped;
        return this.capture({
          reason: payload.info?.reason ?? 'step',
          requestId,
          stopPayload: payload,
          previousPc: before,
        });
      });
      entries.push(value);
    }
    return { frames: entries.map((frame) => frame.frameId), frame: entries.at(-1) };
  }

  async #issueStep(granularity) {
    this.state = 'running';
    this.emitState();
    // VM 一旦继续，观察者的代数就会推进，本地记录的快照立即作废
    this.#forgetObserverCapture('vm-resumed');
    if (granularity === 'source-over') await this.mi.nextSource();
    else if (granularity === 'source-into') await this.mi.stepSource();
    else await this.mi.stepInstruction();
  }

  async continue({ requestId }) {
    const { value } = await this.#executeControl('continue', requestId, async () => {
      this.state = 'running';
      this.emitState();
      this.#forgetObserverCapture('vm-resumed');
      await this.mi.continue();
      return { running: true };
    });
    return value;
  }

  /** 统一暂停入口：只发一次停止请求，QMP 与 GDB 的停止通知只算一次。 */
  async requestPause(reason = 'pause') {
    if (this.state !== 'running') return { running: false, alreadyStopped: true };
    const stopped = this.#waitForStop(10000).catch(() => null);
    await this.mi.interrupt().catch(async () => {
      await this.qmp.stop().catch(() => {});
    });
    await stopped;
    return { running: false, reason };
  }

  async pause({ requestId, previousPc = null }) {
    const { value } = await this.#executeControl('pause', requestId, async () => {
      await this.requestPause('pause');
      return this.capture({ reason: 'pause', requestId, previousPc });
    });
    // 所有执行控制命令统一返回 `{ frame }` 形状；pause 以前直接返回 frame，
    // 前端按 `result.frame` 处理时会静默丢掉这一帧。历史调用方如需裸帧，
    // 读 `result.frame` 即可。
    return { frame: value };
  }

  /** 内部实现：不进队列，供 runTo 等已在队列中的任务复用，避免自锁。 */
  async #insertBreakpoint({ location, hardware = true }) {
    // GDB 把裸地址当函数名；按地址停点必须写成 `*0x...`，否则会报
    // “Function \"0x10000\" not defined.”。
    let spec = location.address
      ? `*${BigInt(location.address).toString(16).startsWith('0x') ? location.address : `0x${BigInt(location.address).toString(16)}`}`
      : location.symbol;
    if (!location.address && location.symbol) {
      const resolution = this.symbols.breakpointSpec(location.symbol, { module: location.module });
      if (!resolution.ok) {
        const error = new Error(resolution.reason);
        error.code = resolution.candidates ? 'ambiguous-symbol' : 'target-unavailable';
        error.detail = { candidates: resolution.candidates ?? [] };
        throw error;
      }
      spec = location.symbol;
    }
    if (typeof spec !== 'string' || spec.length === 0) throw new Error('断点位置必须给出 symbol 或 address');
    const record = await this.mi.breakInsert(spec, { hardware });
    const number = record.results?.bkpt?.number ?? null;
    const entry = {
      id: number !== null ? Number(number) : null,
      spec,
      hardware,
      hitCount: Number(record.results?.bkpt?.times ?? 0),
      address: record.results?.bkpt?.addr ?? location.address ?? null,
      pending: record.results?.bkpt?.pending === '1',
    };
    this.breakpoints.push(entry);
    return { breakpoint: entry, breakpoints: this.breakpoints };
  }

  /** 内部实现：不进队列。 */
  async #removeBreakpoint(breakpointId) {
    await this.mi.breakDelete(breakpointId);
    this.breakpoints = this.breakpoints.filter((entry) => entry.id !== breakpointId);
    return { breakpoints: this.breakpoints };
  }

  /**
   * 自动校准并运行启动阶段（T10a）。
   *
   * 只对 full-boot 有意义：setup 和解压器在 kernel-fast 里不会执行。每一步都
   * 先装载实测基址的符号，再在**由符号表算出的绝对地址**上停点；不用符号名，
   * 因为主内核和解压器存在同名 startup_64，GDB 会报 `<MULTIPLE>`。
   */
  async calibrateBoot({ requestId = null, timeoutMs = 120000 } = {}) {
    const { value } = await this.#executeControl(
      'boot.calibrate',
      requestId ?? `boot-calibrate-${Date.now()}`,
      () => this.#calibrateBootInner(timeoutMs),
      { timeoutMs: timeoutMs * 3 + 60000 },
    );
    return value;
  }

  async #calibrateBootInner(timeoutMs) {
    if (this.profile !== 'full-boot') {
      throw new Error('boot.calibrate 只适用于 full-boot：kernel-fast 不经过 setup/解压器');
    }
    if (this.state === 'running' || this.state === 'capturing') {
      throw new Error(`boot.calibrate 需要 VM 已停止，当前状态 ${this.state}`);
    }
    const plan = [
      // 0x7c00 是 BIOS 装载 MBR 后的入口；这里没有可用符号，但地址是真实的，
      // 停下后由 L01 的 addressRange 触发课程。
      { address: '0x7c00', title: 'MBR / 引导扇区' },
      { module: 'linux-setup', base: '0x10000', symbol: 'main', title: 'Linux 16 位 setup' },
      { module: 'linux-decompressor', base: '0x100000', symbol: 'startup_32', title: '32 位解压入口' },
      { module: 'linux-decompressor', base: '0x100000', symbol: 'startup_64', title: '长模式 startup_64' },
    ];
    const frames = [];
    for (const step of plan) {
      if (step.address !== undefined) {
        const frame = await this.#runToAddressInternal(step.address, timeoutMs, `calibrate-${step.address}`);
        frames.push(frame);
        this.#record('boot.calibrate.step', {
          module: null,
          symbol: null,
          address: step.address,
          frameId: frame.frameId,
          lessonId: frame.lesson?.lessonId ?? null,
        });
        continue;
      }
      const loaded = await this.loadStageSymbols({ module: step.module, address: step.base });
      const resolved = this.symbols.resolve(step.symbol, { module: step.module });
      if (!resolved.found) throw new Error(`装载符号后仍找不到 ${step.module}:${step.symbol}`);
      const link = BigInt(resolved.candidates[0].address);
      const base = BigInt(loaded.base);
      const address = `0x${(base + link).toString(16)}`;
      const frame = await this.#runToAddressInternal(address, timeoutMs, `calibrate-${step.symbol}`);
      frames.push(frame);
      this.#record('boot.calibrate.step', {
        module: step.module,
        symbol: step.symbol,
        address,
        frameId: frame.frameId,
        lessonId: frame.lesson?.lessonId ?? null,
      });
    }
    return {
      frames,
      frame: frames.at(-1),
      lessons: frames.map((frame) => frame.lesson?.lessonId ?? null),
      note: '已装载 setup/解压器符号并停在 L02–L04；继续用「运行到该课」进入主内核课程',
    };
  }

  /** 内部：在绝对地址上设置硬件断点、继续、等待停止并采集；不进命令队列。 */
  async #runToAddressInternal(address, timeoutMs, requestId) {
    const inserted = await this.#insertBreakpoint({ location: { address }, hardware: true });
    const id = inserted.breakpoint.id;
    const stopped = this.#waitForStop(timeoutMs);
    this.state = 'running';
    this.emitState();
    this.#forgetObserverCapture('vm-resumed');
    await this.mi.continue();
    try {
      const payload = await stopped;
      this.state = 'stopped';
      const frame = await this.capture({
        reason: 'breakpoint',
        requestId,
        stopPayload: payload,
      });
      if (id !== null) await this.#removeBreakpoint(id).catch(() => {});
      return frame;
    } catch (error) {
      if (id !== null) await this.#removeBreakpoint(id).catch(() => {});
      await this.requestPause('calibrate-timeout').catch(() => {});
      throw error;
    }
  }

  /**
   * 装载启动阶段符号（T03e/T10a）。
   *
   * 地址不是猜的：调用方必须先用实际停机/字节核对得到装载地址（例如 setup
   * 在 0x10000、解压器在 0x100000 的实测候选），这里只负责把符号文件按该地址
   * 加进 GDB，并记录到符号计划里。后续断点/源码位置都使用这个映射。
   */
  async loadStageSymbols({ module, address }) {
    const stage = this.symbols.stage(module);
    if (!stage) throw new Error(`未知启动阶段: ${module}`);
    if (!stage.symbolFile) throw new Error(`阶段 ${module} 没有带符号的 ELF：${stage.symbolFileReason ?? '未知原因'}`);
    if (!fs.existsSync(stage.symbolFile)) throw new Error(`符号文件不存在: ${stage.symbolFile}`);
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]+$/.test(address)) {
      throw new Error(`装载地址必须是 0x 前缀十六进制字符串，收到 ${String(address)}`);
    }
    const base = BigInt(address);
    // add-symbol-file 的第一参数是 .text 的运行时地址；解压器的 startup_32 在
    // .head.text，不在 .text，所以还必须把每个 alloc 段按 base + 段链接地址
    // 显式映射过去。否则 startup_32 会留在链接地址 0，断点落在错误位置。
    const sections = readElfSections(stage.symbolFile);
    const textSection = sections.find((entry) => entry.name === '.text')
      ?? sections.find((entry) => entry.executable)
      ?? sections[0];
    if (!textSection) throw new Error(`${stage.symbolFile} 没有可装载的段`);
    const textAddress = base + textSection.address;
    const sectionMap = {};
    for (const section of sections) {
      sectionMap[section.name] = `0x${(base + section.address).toString(16)}`;
    }
    // .text 已经作为 add-symbol-file 的第二参数，不再重复 -s
    delete sectionMap[textSection.name];
    const measured = this.symbols.setLoadAddress(module, textAddress, { base });
    this.lessonCatalogCache = null;
    const output = await this.mi.addSymbolFile(stage.symbolFile, `0x${textAddress.toString(16)}`, sectionMap);
    this.symbolPlan = this.symbols.addSymbolFileCommands();
    this.#record('stage.symbols-loaded', {
      module,
      textAddress: address,
      base: `0x${base.toString(16)}`,
      textSection: `0x${textSection.address.toString(16)}`,
      sections: Object.keys(sectionMap),
      symbolFile: stage.symbolFile,
      output: typeof output === 'string' ? output.slice(0, 500) : null,
    });
    return {
      module,
      address,
      textAddress: address,
      base: `0x${base.toString(16)}`,
      textSection: `0x${textSection.address.toString(16)}`,
      sections: Object.keys(sectionMap),
      measured,
      symbolFile: stage.symbolFile,
      output: typeof output === 'string' ? output.slice(0, 2000) : output ?? null,
      plan: this.symbolPlan,
    };
  }

  async breakpointInsert({ requestId, location, hardware = true }) {
    const { value } = await this.#executeControl('breakpoint.insert', requestId, () =>
      this.#insertBreakpoint({ location, hardware }),
    );
    return value;
  }

  async breakpointRemove({ requestId, breakpointId }) {
    const { value } = await this.#executeControl('breakpoint.remove', requestId, () =>
      this.#removeBreakpoint(breakpointId),
    );
    return value;
  }

  async runTo({ requestId, location, timeoutMs = 30000 }) {
    const { value } = await this.#executeControl(
      'run-to',
      requestId,
      async () => {
        // 直接使用内部方法：本任务已在队列中，再入队会自锁
        const inserted = await this.#insertBreakpoint({ location, hardware: true });
        const id = inserted.breakpoint.id;
        const stopped = this.#waitForStop(timeoutMs);
        this.state = 'running';
        this.emitState();
        await this.mi.continue();
        try {
          const payload = await stopped;
          const frame = await this.capture({ reason: 'breakpoint', requestId, stopPayload: payload });
          if (id !== null) await this.#removeBreakpoint(id).catch(() => {});
          return { frame, breakpointId: id };
        } catch (error) {
          if (id !== null) await this.#removeBreakpoint(id).catch(() => {});
          await this.requestPause('run-to-timeout').catch(() => {});
          throw error;
        }
      },
      { timeoutMs: timeoutMs + 10000 },
    );
    return value;
  }

  async readMemory({ requestId, addressSpace = 'linear', address, length }) {
    if (this.state === 'running') {
      throw this.#protocolError(
        ErrorCode.CONTROL_BUSY,
        'VM 正在运行，内存读取需要先暂停（面板会保留上一帧，不会用运行中的值冒充停止帧）',
      );
    }
    const value = toBigInt(address);
    if (value === null) throw new Error('地址必须是十六进制字符串');
    if (!Number.isInteger(length) || length <= 0 || length > 1024 * 1024) {
      throw new Error('length 必须是 1..1048576 的整数');
    }
    const { value: result } = await this.#executeControl('memory.read', requestId, async () => {
      if (addressSpace === 'physical') {
        const read = await this.#readPhysical(value, length);
        return this.#memoryResult(addressSpace, value, read.bytes, read.source);
      }
      const bytes = await this.mi.readMemoryBytes(value, length);
      return this.#memoryResult(addressSpace, value, bytes, 'gdb');
    });
    return result;
  }

  /**
   * 物理读。
   *
   * 优先走观察者：它把读取绑定到某个 captureId，并明确拒绝会触发设备
   * 副作用的 MMIO（E10 要求“看面板本身不产生副作用”）。观察扩展不存在
   * 时退回 GDB 物理模式，并在证据里标注来源是 gdb-physical。
   *
   * 观察者可用但拒绝时**不回退**：拒绝本身就是结论（MMIO 可能取走输入、
   * 快照已过期），换一条通道读同一地址会把无副作用保证换掉。
   */
  async #readPhysical(address, length) {
    if (!this.observer.detected) {
      return { bytes: await this.mi.readPhysicalBytes(address, length), source: 'gdb-physical' };
    }
    return { bytes: await this.#readPhysicalViaObserver(address, length), source: 'observer' };
  }

  #observerCaptureOrFail() {
    const capture = this.observer.capture;
    if (capture === null) {
      throw this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        this.observer.snapshots === 0
          ? '本会话还没有成功的观察者快照，无法按 capture 读取物理内存'
          : '上一次观察者快照在 VM 推进后失效，请先停止并发起一次采集',
        { lastRefusal: this.observer.lastRefusal },
      );
    }
    return capture;
  }

  #protocolError(code, message, detail) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = code === ErrorCode.INTERNAL ? 500 : 400;
    if (detail) error.detail = detail;
    return error;
  }

  /**
   * 用观察者快照的区域表把请求切成「同一区域内 + 不超过单次上限」的分片。
   * 观察者的 read-physical 单次读取限定在一个区域内，所以必须先在服务端切分，
   * 而不是把失败原样透出。
   */
  #planObserverRead(capture, address, length) {
    const limit = Number(this.observer.capabilities?.memory?.maxReadBytes ?? 4096);
    const regions = capture.regions ?? [];
    const segments = [];
    const end = address + BigInt(length);
    let cursor = address;
    while (cursor < end) {
      const hit = regions.find((region) => {
        const start = BigInt(region.base);
        return cursor >= start && cursor < start + BigInt(region.size);
      });
      if (!hit) {
        throw this.#protocolError(
          ErrorCode.RANGE_NOT_CAPTURED,
          `物理地址 ${hex(cursor)} 不在本次快照已知区域内`,
          { address: hex(cursor), captureId: capture.captureId },
        );
      }
      if (hit.readable !== true) {
        throw this.#protocolError(
          ErrorCode.MMIO_SIDE_EFFECT,
          `物理地址 ${hex(cursor)} 属于不可直读区域 ${hit.name}（${hit.kind}），读取可能产生副作用`,
          {
            address: hex(cursor),
            regionName: hit.name,
            regionKind: hit.kind,
            captureId: capture.captureId,
          },
        );
      }
      const regionEnd = BigInt(hit.base) + BigInt(hit.size);
      const segmentEnd = regionEnd < end ? regionEnd : end;
      let pieceStart = cursor;
      while (pieceStart < segmentEnd) {
        const remaining = segmentEnd - pieceStart;
        const pieceEnd = remaining > BigInt(limit) ? pieceStart + BigInt(limit) : segmentEnd;
        segments.push({ start: pieceStart, length: Number(pieceEnd - pieceStart) });
        pieceStart = pieceEnd;
      }
      cursor = segmentEnd;
    }
    return segments;
  }

  async #readPhysicalViaObserver(address, length) {
    const capture = this.#observerCaptureOrFail();
    const segments = this.#planObserverRead(capture, address, length);
    const chunks = [];
    for (const segment of segments) {
      const result = await this.qmp.observerReadPhysical({
        captureId: capture.captureId,
        address: hex(segment.start),
        length: segment.length,
      });
      if (result?.ok !== true) throw this.#observerRefusal(result, segment);
      chunks.push(Buffer.from(result.bytes ?? '', 'base64'));
    }
    return Buffer.concat(chunks);
  }

  /** 把观察者的拒绝原因映射成协议错误码；快照失效时同时清掉本地记录。 */
  #observerRefusal(result, segment) {
    const reason = result?.reason ?? 'unknown';
    const detail = {
      observerReason: reason,
      address: hex(segment.start),
      length: segment.length,
      captureId: result?.captureId ?? this.observer.capture?.captureId ?? null,
      regionName: result?.regionName ?? null,
      regionKind: result?.regionKind ?? null,
    };
    if (reason === 'side-effect-risk') {
      return this.#protocolError(
        ErrorCode.MMIO_SIDE_EFFECT,
        result?.message ?? '该物理地址读取可能产生副作用，已拒绝',
        detail,
      );
    }
    if (
      reason === 'vm-advanced'
      || reason === 'vm-running'
      || reason === 'no-active-capture'
      || reason === 'capture-mismatch'
    ) {
      this.#forgetObserverCapture(reason);
      return this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        result?.message ?? '观察者快照已失效，请重新停止并采集',
        detail,
      );
    }
    if (reason === 'cross-region' || reason === 'memtx-error' || reason === 'out-of-range') {
      return this.#protocolError(
        ErrorCode.RANGE_NOT_CAPTURED,
        result?.message ?? '本次读取范围不可用',
        detail,
      );
    }
    return this.#protocolError(
      ErrorCode.INVALID_REQUEST,
      result?.message ?? `观察者拒绝读取: ${reason}`,
      detail,
    );
  }

  #memoryResult(addressSpace, address, bytes, source = null) {
    const resolved = source ?? (addressSpace === 'physical' ? 'gdb-physical' : 'gdb');
    return {
      attribution: {
        sessionId: this.id,
        epoch: this.epoch,
        frameId: this.frames.at(-1)?.frameId ?? 0,
        captureId: this.frames.at(-1)?.captureId ?? null,
      },
      addressSpace,
      address: hex(address),
      length: bytes.length,
      bytes: bytes.toString('base64'),
      hex: bytes.toString('hex'),
      blobRef: crypto.createHash('sha256').update(bytes).digest('hex'),
      withinCapture: true,
      evidence: {
        kind: 'observed',
        source: resolved,
        captureId: this.frames.at(-1)?.captureId ?? null,
        refs: resolved === 'observer'
          ? [`x-oslab-read-physical:${this.observer.capture?.captureId ?? '-'}`]
          : ['-data-read-memory-bytes'],
      },
    };
  }

  async terminalInput({ requestId, text }) {
    const { value } = await this.#executeControl('terminal.input', requestId, async () => {
      if (this.mode !== 'live') {
        const error = new Error('历史模式禁用客体输入');
        error.code = 'history-read-only';
        throw error;
      }
      if (typeof text !== 'string' || text.length === 0) throw new Error('输入不能为空');
      if (text.length > 8192) throw new Error('输入过长');
      this.#record('input.serial', { bytes: Buffer.from(text).toString('hex') });
      this.serial.write(text);
      return { written: Buffer.byteLength(text) };
    });
    return value;
  }

  async keyboard({ requestId, action, key }) {
    const { value } = await this.#executeControl('keyboard', requestId, async () => {
      if (this.mode !== 'live') {
        const error = new Error('历史模式禁用客体输入');
        error.code = 'history-read-only';
        throw error;
      }
      if (typeof key !== 'string' || !/^[a-z0-9_]+$/i.test(key)) {
        throw new Error(`非法的 QMP key qcode: ${String(key)}`);
      }
      if (this.state !== 'running') {
        // 不在运行态时不直接发 QMP：QEMU 会返回 "VM not running"。
        // 排队到下一次恢复运行，并把这件事作为可观察状态返回给界面。
        this.pendingKeyboard.push({ key, action, at: new Date().toISOString() });
        this.#record('input.keyboard.queued', { key, action, queue: this.pendingKeyboard.length });
        return {
          key,
          action,
          queued: true,
          pending: this.pendingKeyboard.length,
          note: 'VM 已停止，按键已排队；继续运行后按原顺序注入 PS/2',
        };
      }
      const events = action === 'press' ? ['down', 'up'] : [action];
      for (const direction of events) {
        await this.qmp.sendKey(key, direction === 'down');
      }
      this.#record('input.keyboard', { key, action });
      return { key, action, queued: false };
    });
    return value;
  }

  /** 恢复运行后把暂停期间排队的按键按原顺序注入。失败时留在队首，不丢输入。 */
  async #flushPendingKeyboard() {
    if (this.keyboardFlushing || this.state !== 'running' || this.pendingKeyboard.length === 0) return;
    this.keyboardFlushing = true;
    try {
      while (this.pendingKeyboard.length > 0 && this.state === 'running') {
        const entry = this.pendingKeyboard[0];
        const events = entry.action === 'press' ? ['down', 'up'] : [entry.action];
        try {
          for (const direction of events) {
            await this.qmp.sendKey(entry.key, direction === 'down');
          }
          this.pendingKeyboard.shift();
          this.#record('input.keyboard', { key: entry.key, action: entry.action, flushedAfterResume: true });
        } catch (error) {
          this.emit('notice', {
            level: 'warn',
            message: `排队按键 ${entry.key} 注入失败，保留在队首：${error.message}`,
          });
          break;
        }
      }
    } finally {
      this.keyboardFlushing = false;
    }
  }

  /**
   * 选中一个进程用于详情面板（T08）。
   *
   * 只改「后续采集时解析谁」，内核 current 保持原值，也客体执行状态保持原值。
   * 返回的进程摘要来自最近一帧；如果该 pid 已不存在则明确拒绝。
   */
  async selectProcess({ pid }) {
    const frame = this.frames.at(-1) ?? null;
    const processes = frame?.os?.processes ?? [];
    const wanted = Number(pid);
    const match = processes.find((entry) => entry.pid === wanted) ?? null;
    if (frame?.os === null || frame?.os === undefined) {
      throw new Error('当前帧没有 OS 快照（尚未进入 64 位内核），无法按 pid 选择进程');
    }
    if (match === null) throw new Error(`当前帧的进程列表里没有 pid=${pid}`);
    this.selectedPid = wanted;

    /*
     * 立即读取选中进程的详情：复用**同一帧的 captureId** 和当前观察者快照，
     * 因此 mm/fd/页缓存仍属于这个停止点，不是「选择时现读当前 VM」。
     * 快照已失效（例如 VM 已被继续）时只记录选中，下一次采集再解析。
     */
    const reader = this.mode === 'live' ? this.#captureReaderOrNull() : null;
    if (reader !== null && this.state !== 'running' && frame.captureId === this.#liveCaptureId()) {
      try {
        // 只读目标 task 的 mm/fd/页缓存；复用既有任务列表和 current。
        const result = await this.osCollector.collectForPid({
          frame,
          reader,
          pid: wanted,
          baseOs: frame.os,
        });
        if (result.os !== null) {
          frame.os = result.os;
          this.t08.last = {
            ...this.t08.last,
            captureId: frame.captureId,
            frameId: frame.frameId,
            os: {
              current: result.os.current?.pid ?? null,
              selected: result.os.selected?.pid ?? null,
              processes: result.os.processes.length,
              files: result.os.files.length,
              vmas: result.os.addressSpace?.vmas.length ?? 0,
            },
            unavailable: null,
            stats: result.stats ?? {},
          };
          return {
            selectedPid: wanted,
            frameId: frame.frameId,
            captureId: frame.captureId,
            os: result.os,
            note: '从同一 captureId 重新解析选中进程；没有改变内核 current',
          };
        }
      } catch (error) {
        this.#record('selection.inspect-failed', { pid: wanted, message: error.message });
      }
    }

    return {
      selectedPid: wanted,
      process: match,
      frameId: frame.frameId,
      note: reader === null || this.state === 'running'
        ? '已记录选中进程；VM 已推进或没有有效快照，下一次采集会按该任务读取 mm/文件'
        : '已记录选中进程；本次详情解析未成功，下一次采集再解析',
    };
  }

  /** 课程目录与可用性。符号解析不到的课程明确标记，不在运行中假装命中。 */
  lessonCatalog() {
    return buildLessonCatalog(this);
  }

  /** 盘面视图：基线 + 已对客体可见的写；来源为帧绑定的逻辑版本。 */
  async filesystem(options = {}) {
    return buildFilesystem(this, options);
  }

  /** 导出录制包（T09）；实现见 session-views.mjs。 */
  exportRecording() {
    return exportSessionRecording(this);
  }

  osStatus() {
    return buildOsStatus(this);
  }

  async setView({ requestId, mode, targetFrameId }) {
    const { value } = await this.#executeControl('view', requestId, async () => {
      if (mode === 'recorded') {
        const target = targetFrameId ?? this.frames.at(-1)?.frameId ?? 0;
        if (!this.frames.some((frame) => frame.frameId === target)) {
          throw new Error(`帧 ${target} 不在本会话已保存的历史中`);
        }
        this.mode = 'recorded';
        this.viewFrameId = target;
      } else {
        this.mode = 'live';
        this.viewFrameId = this.frames.at(-1)?.frameId ?? 0;
      }
      this.emitState();
      return { mode: this.mode, viewFrameId: this.viewFrameId, liveFrameId: this.frames.at(-1)?.frameId ?? 0 };
    });
    return value;
  }

  /* ---------- 状态与清理 ---------- */

  capabilities() {
    return {
      schema: 'oslab.capabilities/1',
      observer: {
        version: this.observer.capabilities?.protocolVersion ?? 1,
        schema: this.observer.capabilities?.schema ?? null,
        // 观察者报告的是编译期 QEMU_VERSION；没有探测到时退回 QMP greeting
        qemuVersion: this.observer.capabilities?.qemuVersion
          ?? (this.qmpVersion?.qemu
            ? `${this.qmpVersion.qemu.major}.${this.qmpVersion.qemu.minor}.${this.qmpVersion.qemu.micro}`
            : 'unknown'),
        patched: this.observer.detected,
        probedAt: this.observer.probeAt,
        activeCaptureId: this.observer.capture?.captureId ?? null,
        // 服务侧采集代编号：帧的 captureId、ram/<captureId>/ 的目录名都用它
        activeServiceCaptureId: this.#liveCaptureId(),
        activeCaptureFrameId: this.observer.capture?.frameId ?? null,
        activeCaptureVmGeneration: this.observer.capture?.vmGeneration ?? null,
        snapshots: this.observer.snapshots,
        note: this.observer.detected ? null : this.observer.reason,
      },
      standard: {
        singleStep: { status: 'verified', evidence: 'GDB -exec-step-instruction' },
        breakpoint: { status: 'verified', evidence: 'GDB -break-insert -h' },
        registerRead: { status: 'verified', evidence: '-data-list-register-values 按目标描述对齐' },
        memoryRead: { status: 'verified', evidence: '-data-read-memory-bytes' },
        physicalMemoryRead: { status: 'verified', evidence: 'QEMU gdbstub Qqemu.PhyMemMode 切换后读取' },
        qmpBlockQuery: { status: 'unknown', note: 'T01 未验证；且 query-block 不能当作扇区内容接口' },
        terminalSerial: { status: 'verified', evidence: 'QEMU 串口 Unix socket' },
        terminalVgaInput: { status: 'unknown', note: '通过 QMP input-send-event 注入，需在 T08 验证' },
      },
      observer_: this.#observerCapabilityEntries(),
      events: this.#eventCapabilityEntries(),
      devices: this.#deviceCapabilityEntries(),
      // 累计丢失数只在真的读到过事件环时才是实数；没观测到时保持 0 并靠
      // observer_.events 的 note 说明「尚未读取」，不用 0 假装「没有丢失」。
      droppedEvents: Number.isFinite(this.observer.events.dropped) ? this.observer.events.dropped : 0,
      knownGaps: [
        ...(this.observer.detected ? [] : ['段隐藏基址与指令字节需要 x-oslab-capture（T05a）']),
        'irq.raise/lower、input.accept、serial.output 需要设备侧发射点：设备无副作用快照已由 T05d 提供（见 devices 表），'
          + '但这三种事件要在 PIC/APIC、i8042、UART 的发射路径上补观察点，尚未实现',
        '设备面板的寄存器区间归属只做 owner 精确相等匹配（不做祖先/后代摊派），'
          + '避免 piix4/ISA 总线容器下的设备互相冒领区间',
        'virtio 队列状态复用 QEMU 自带 x-query-virtio-queue-status；vhost 已启动（vhost_started）时该标准命令会走 vhost_get_vring_base，'
          + '观察层此时不调用它，队列快照如实标为不可用而不是给猜测值',
        'VGA 的 vramBacking 只在文本模式下从显示起始单元导出且上限 8 KiB；0xb8000 属有副作用的 MMIO（vga-lowmem），'
          + '直读会被拒 mmio-side-effect，因此面板内容只能来自设备快照',
        'dma.* 只报描述符映射出的访问权（客体物理地址与长度），不含载荷字节；缓冲内容要用 x-oslab-read-physical 按地址独立核对',
        '非 virtio 设备的 DMA 不产生 dma.* 事件（观察点挂在 virtqueue 上）',
        '停机屏障（stop/pause 等任何让全部 vCPU 停止的动作）自身会 drain 块层：它走 virtio_blk_data_plane_stop → blk_drain，'
          + 'blk_root_drained_begin 顺带取消节流定时器并放行挂起请求，所以对 virtio-blk，屏障处读不到 host-io-pending——'
          + '这不是采集漏了，而是那一刻真的没有；原话见 capabilities.pendingIo.barrierObservability。'
          + '屏障处仍能读到的是设备层已挂起的请求（host-io-done-awaiting-visibility，例如 werror=stop 挂到 s->rq）',
        'pendingIo 台账里的 requestId 只在同一块设备内唯一（形如 vq0-0，多块盘会撞名），'
          + '归属请求必须同时比对 deviceId + requestId，再用 submitSeq 与帧的 fenceSeq 切窗口',
      ],
    };
  }

  /**
   * observer_* 能力条目。
   *
   * `verified` 只声明「接口存在并且本会话已用过」，不声明「每一次读取都会成功」：
   * 某次物理读是否可读仍由调用结果与错误码（mmio-side-effect / range-not-captured）
   * 决定，不能用能力位掩盖单次拒绝。
   */
  #observerCapabilityEntries() {
    if (!this.observer.detected) {
      const note = `x-oslab-* 不可用: ${this.observer.reason}`;
      return {
        capabilities: { status: 'unavailable', note },
        captureSnapshot: { status: 'unavailable', note },
        pendingIo: { status: 'unavailable', note: '观察扩展不可用，没有待完成块请求台账' },
        readPhysical: {
          status: 'unavailable',
          note: '观察扩展不可用，物理读退回 GDB 物理模式（无 MMIO 副作用审查，证据标注 gdb-physical）',
        },
        events: { status: 'unavailable', note: 'T05b' },
        release: { status: 'unavailable', note },
      };
    }
    const caps = this.observer.capabilities;
    const barrier = caps?.stopBarrier?.supported === true
      && caps?.stopBarrier?.requiresAllVcpusStopped === true;
    // pendingIo 是 T05e 才进入 capabilities 的对象；老构建没有它，此时如实标 unavailable，
    // 不用「空台账」冒充「没有未完成请求」。
    const pendingIo = caps?.pendingIo?.supported === true ? caps.pendingIo : null;
    // 观察者用一句话说明「停机屏障上哪些 pending 可观测」；这句话本身是可核对的证据，
    // 面板要能看到它，而不是只看到我们这边的转述。
    const barrierNote = typeof caps?.pendingIo?.barrierObservability === 'string'
      ? caps.pendingIo.barrierObservability
      : null;
    const kinds = Array.isArray(caps?.memory?.readableKinds) ? caps.memory.readableKinds.join('/') : 'ram/rom/romd';
    return {
      capabilities: {
        status: 'verified',
        evidence: `x-oslab-capabilities schema=${caps?.schema ?? '-'} protocolVersion=${caps?.protocolVersion ?? '-'} `
          + `qemu=${caps?.qemuVersion ?? '-'} target=${caps?.target ?? '-'}`,
      },
      captureSnapshot: {
        status: 'verified',
        evidence: `x-oslab-capture 冻结段缓存/控制寄存器/EFER/区域表；本会话成功 ${this.observer.snapshots} 次；`
          + `停止屏障${barrier ? '要求全部 vCPU 停止' : '未按预期声明'}`,
      },
      pendingIo: pendingIo === null
        ? {
            status: 'unavailable',
            note: '本次 x-oslab-capabilities 没有 pendingIo 能力对象（T05e 之前的构建）',
          }
        : {
            status: 'verified',
            evidence: `x-oslab-capture.pendingIo 待完成块请求台账：判据「${pendingIo.pendingCriterion ?? '-'}」，`
              + `容量 ${pendingIo.ledgerCapacity ?? '-'}，覆盖 ${pendingIo.coverage ?? '-'}；`
              + `串行化点 ${pendingIo.readGate ?? '-'}`
              + (barrierNote === null ? '' : `；停机屏障上的可观测性：${barrierNote}`),
          },
      readPhysical: {
        status: 'verified',
        evidence: `x-oslab-read-physical 只允许 ${kinds}，单次上限 ${caps?.memory?.maxReadBytes ?? '-'} 字节，`
          + `拒绝 MMIO=${caps?.memory?.rejectsMmio === true}`,
      },
      events: {
        status: 'verified',
        evidence: `x-oslab-events 读事件环：capacity=${caps?.events?.capacity ?? '-'} `
          + `defaultLimit=${caps?.events?.defaultLimit ?? '-'} maxLimit=${caps?.events?.maxLimit ?? '-'} `
          + `kinds=${(caps?.events?.kinds ?? []).length} 种，unavailableKinds=${(caps?.events?.unavailableKinds ?? []).length} 种；`
          + `本会话读取 ${this.observer.events.reads} 次`
          + (this.observer.events.watermark === null
            ? '（尚未读取，水位线未知）'
            : `，水位线 ${this.observer.events.watermark}、最旧 ${this.observer.events.oldest}、`
              + `累计丢失 ${this.observer.events.dropped}、采集${this.observer.events.enabled ? '已开启' : '未开启'}`),
      },
      release: {
        status: 'verified',
        evidence: 'x-oslab-release 释放冻结快照；'
          + (this.observer.capture ? `当前持有 ${this.observer.capture.captureId}` : '当前无活动快照'),
      },
    };
  }

  /**
   * 事件覆盖表。
   *
   * 判定只看观察者的运行时自述（`capabilities.events.kinds` 是「真正会产生」的
   * kind 列表，`unavailableKinds` 是契约里有、当前构建不会产生的），因此不会出现
   * 「名字在表里就叫支持」这种谎报。verified 的证据直接引用 `observationPoints`
   * 里的源码观察点，面板点开就能核对到落点。
   *
   * 键集与 `packages/contracts/event.ts` 的 MachineEventKind 一一对应。
   */
  #eventCapabilityEntries() {
    const runtime = this.observer.capabilities?.events ?? {};
    const points = runtime.observationPoints ?? {};
    const produced = new Set(Array.isArray(runtime.kinds) ? runtime.kinds : []);
    // 观察点是用一条声明覆盖一个族的（如 memory.read/write 共用一个落点）
    const pointKey = {
      'instruction.begin': 'instruction.begin',
      'instruction.retire': 'instruction.retire',
      'memory.read': 'memory.read/write',
      'memory.write': 'memory.read/write',
      'io.read': 'io.read/write',
      'io.write': 'io.read/write',
      'exception.raise': 'exception.raise/interrupt.accept',
      'interrupt.accept': 'exception.raise/interrupt.accept',
      'dma.read': 'dma.read/write',
      'dma.write': 'dma.read/write',
      'block.submit': 'block.submit',
      'block.complete': 'block.complete',
    };
    // 该 kind 由哪个子任务落实：证据里带上子任务编号，不把 T05c 的落点记成 T05b
    const delivered = {
      'dma.read': 'T05c',
      'dma.write': 'T05c',
      'block.submit': 'T05c',
      'block.complete': 'T05c',
    };
    const planned = {
      'irq.raise': '设备级事件待补设备侧发射点：设备无副作用快照已由 T05d 提供（见 devices 表），'
        + '但 PIC/APIC 的电平变化还没在发射路径上采样（CPU 接受中断已由 interrupt.accept 覆盖）',
      'irq.lower': '设备级事件待补设备侧发射点（T05d 起设备快照已可用，事件仍待接）',
      'input.accept': '设备级事件待补 i8042 发射点（T05d 起设备快照已可用，事件仍待接）',
      'serial.output': '设备级事件待补 UART 发射点：当前只观察到串口文本，字节级事件仍待接',
      'observer.drop': '观察者不产生独立 drop 事件：丢失由 watermark/oldest/dropped/droppedInRange 精确表达；'
        + '帧级绑定已由 T05e 给出——帧自带 fenceSeq/eventWatermark，capture.fence 事件与 frameBoundary 说明这条边界怎么读',
    };
    const every = [
      'instruction.begin', 'instruction.retire',
      'memory.read', 'memory.write',
      'dma.read', 'dma.write',
      'io.read', 'io.write',
      'irq.raise', 'irq.lower',
      'interrupt.accept', 'block.submit', 'block.complete',
      'input.accept', 'serial.output', 'capture.fence', 'exception.raise', 'observer.drop',
    ];
    const table = {};
    for (const kind of every) {
      if (!this.observer.detected) {
        table[kind] = { status: 'unavailable', note: `x-oslab-events 不可用: ${this.observer.reason}` };
        continue;
      }
      if (kind === 'capture.fence') {
        // 该 kind 由服务自己在提交帧时发射，不是观察者的事件环里的一条。
        table[kind] = {
          status: 'verified',
          evidence: '服务在提交帧时记录屏障事件，作为事件区间右端（观察者不产生该 kind）',
        };
        continue;
      }
      if (produced.has(kind)) {
        const point = points[pointKey[kind] ?? kind] ?? null;
        const subtask = delivered[kind] ?? 'T05b';
        table[kind] = {
          status: 'verified',
          evidence: point
            ? `x-oslab-events（${subtask}）: ${point}`
            : `x-oslab-events（${subtask}）`,
        };
        continue;
      }
      table[kind] = { status: 'unavailable', note: planned[kind] ?? '当前观察者不产生该 kind' };
    }
    return table;
  }

  /**
   * 设备面板能力表（T05d）。
   *
   * 与 events 表同一判据：只看观察者的运行期自述。`capabilities.devices.kinds`
   * 是这次构建真正会快照的设备类别，`observationPoints` 是每类的源码落点；
   * 观察者没报出来的类别一律保留 unavailable，不靠「名字在表里」充数。
   * evidence 里同时给出本会话实际快照到的该类设备个数，避免把「声明支持」
   * 读成「这台机器上真的有」。
   *
   * 键集与 `packages/contracts/device.ts` 的 DeviceKind 对齐（pci/other 是兜底
   * 类别，不单独声明能力）。
   */
  #deviceCapabilityEntries() {
    const runtime = this.observer.capabilities?.devices ?? {};
    const points = runtime.observationPoints ?? {};
    const supported = new Set(Array.isArray(runtime.kinds) ? runtime.kinds : []);
    const every = ['vga', 'i8042', 'uart', 'pic', 'apic', 'timer', 'virtio-blk', 'virtio-net'];
    // 观察点是用一条声明覆盖一族的（pit 覆盖 timer，virtio 覆盖 blk/net）
    const pointKey = {
      vga: 'vga',
      i8042: 'i8042',
      uart: 'uart',
      pic: 'pic',
      apic: 'apic',
      timer: 'pit',
      'virtio-blk': 'virtio',
      'virtio-net': 'virtio',
    };
    const delivered = {
      'virtio-blk': 'T05d；队列状态复用 QEMU 自带 x-query-virtio-queue-status，DMA/块请求事件另见 T05c 的 events 表',
      'virtio-net': 'T05d；本实验室机器没有 virtio-net 设备，只保留接口形状',
    };
    const table = {};
    const observed = this.observer.capture?.devices ?? [];
    for (const kind of every) {
      if (!this.observer.detected) {
        table[kind] = { status: 'unavailable', note: `x-oslab-capture.devices 不可用: ${this.observer.reason}` };
        continue;
      }
      if (!supported.has(kind)) {
        table[kind] = {
          status: 'unavailable',
          note: '当前观察者不上报该类设备（或该目标不支持设备快照）',
        };
        continue;
      }
      const seen = observed.filter((device) => device.kind === kind).length;
      table[kind] = {
        status: 'verified',
        evidence: `x-oslab-capture.devices（${delivered[kind] ?? 'T05d'}，只读字段）: `
          + `${points[pointKey[kind]] ?? '观察点未声明'}；本会话快照到 ${seen} 个`,
      };
    }
    return table;
  }

  serialize() {
    return {
      id: this.id,
      profile: this.profile,
      state: this.state,
      epoch: this.epoch,
      // 一次性写故障的参数（没有时为 null）：它决定本次运行是否存在真实的
      // 「已提交、未对客体可见」块请求，凡是引用 pending 写入的证据都要带上它。
      diskFault: this.diskFault === null ? null : { ...this.diskFault },
      frameCount: this.frames.length,
      latestFrameId: this.frames.at(-1)?.frameId ?? null,
      mode: this.mode,
      viewFrameId: this.viewFrameId,
      breakpoints: this.breakpoints,
      terminalBytes: this.terminalBytes,
      selectedPid: this.selectedPid,
      os: {
        collector: this.osCollector.status(),
        last: this.t08.last,
        curriculum: {
          version: this.curriculum.version ?? null,
          lessons: this.curriculum.lessons.length,
          unavailable: this.curriculum.unavailable.length,
          reason: this.curriculum.reason ?? null,
        },
      },
      qmpVersion: this.qmpVersion,
      observer: {
        detected: this.observer.detected,
        probeAt: this.observer.probeAt,
        reason: this.observer.reason,
        // activeCaptureId 是**观察者（QEMU）侧**的快照编号，只能用来与观察者交互；
        // activeServiceCaptureId 才是服务侧采集代编号（等于帧的 captureId），
        // 一切按 captureId 的取数都用后者。
        activeCaptureId: this.observer.capture?.captureId ?? null,
        activeServiceCaptureId: this.#liveCaptureId(),
        activeCaptureFrameId: this.observer.capture?.frameId ?? null,
        activeCaptureVmGeneration: this.observer.capture?.vmGeneration ?? null,
        snapshots: this.observer.snapshots,
        lastRefusal: this.observer.lastRefusal,
        events: {
          enabled: this.observer.events.enabled,
          watermark: this.observer.events.watermark,
          oldest: this.observer.events.oldest,
          total: this.observer.events.total,
          dropped: this.observer.events.dropped,
          capacity: this.observer.events.capacity,
          reads: this.observer.events.reads,
          lastReadAt: this.observer.events.lastReadAt,
          lastSwitchAt: this.observer.events.lastSwitchAt,
        },
      },
      capabilities: this.capabilities(),
      symbols: this.symbols.availability(),
      symbolPlan: this.symbolPlan ?? null,
      droppdMessages: this.droppedMessages,
    };
  }

  emitState() {
    this.emit('message', { type: 'session.state', sessionId: this.id, state: this.state, epoch: this.epoch });
  }

  async close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.autoCapture = false;
    this.emitState();
    this.serial?.destroy();
    this.mi?.dispose();
    if (this.qmp) {
      // 先释放冻结快照再退出 QEMU：观察者侧是单槽资源，留着会让下一次
      // 采集带上一个莫名其妙的 supersededCaptureId（T05e 会把释放做成正式契约）。
      await this.#releaseObserverCapture();
      await this.qmp.quit().catch(() => {});
      this.qmp.close();
    }
    await this.process.stop();
    this.queue.reset();
  }
}


/**
 * 从一个 ELF 文件里读可装载段（SHF_ALLOC）的链接地址。
 *
 * `readelf -SW` 的宽格式把 name/type/address/off/size/flags 放在一行；
 * 这里只接受带 A 标志的段，因为 add-symbol-file 只应映射会被装载的段。
 */
function readElfSections(file) {
  const output = execFileSync('readelf', ['-SW', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const sections = [];
  for (const line of output.split('\n')) {
    const match = /^\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+([0-9a-fA-F]+)\s+[0-9a-fA-F]+\s+([0-9a-fA-F]+)\s+\S+\s+([A-Za-z]+)/.exec(line);
    if (!match) continue;
    const [, name, type, address, size, flags] = match;
    if (!flags.includes('A') || name.startsWith('.debug')) continue;
    sections.push({
      name,
      type,
      address: BigInt(`0x${address}`),
      size: BigInt(`0x${size}`),
      executable: flags.includes('X'),
    });
  }
  return sections;
}
