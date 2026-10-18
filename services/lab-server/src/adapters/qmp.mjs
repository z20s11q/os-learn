/**
 * QMP 适配器。
 *
 * 依据 T03c：处理 greeting/capabilities、命令 ID、异步事件；
 * 并且调用方（Session）必须把 QMP 的 STOP 事件与 GDB 的停止通知
 * 当成同一次停止，统一关联为同一个停止点。
 *
 * 本适配器只负责协议与事件转发，停止语义交给 Session 统一关联，
 * 由 Session 用同一个串行队列统一关联。
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';

export class QMPError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'QMPError';
    this.command = options.command ?? null;
    this.class = options.class ?? null;
    this.timedOut = options.timedOut === true;
  }
}

export class QMP extends EventEmitter {
  constructor(socket, { timeoutMs = 15000 } = {}) {
    super();
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.greeting = null;
    this.open = true;

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => {
      this.open = false;
      const error = new QMPError('QMP 连接已关闭');
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit('parseError', error);
        continue;
      }
      this.#receive(message);
    }
  }

  #receive(message) {
    if (message.QMP) {
      this.greeting = message.QMP;
      this.emit('greeting', message.QMP);
      return;
    }
    if (message.event) {
      this.emit('event', message.event);
      this.emit(`event:${message.event}`, message.data ?? {});
      return;
    }
    if (message.id === undefined) {
      this.emit('orphan', message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      this.emit('unmatched', message);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new QMPError(message.error.desc ?? 'QMP 错误', {
          command: entry.command,
          class: message.error.class,
        }),
      );
    } else {
      entry.resolve(message.return);
    }
  }

  /**
   * 连接并协商 capabilities。
   * greeting 中带 version，用于确认 QEMU 版本与能力。
   */
  static async connect(socketPath, { timeoutMs = 15000 } = {}) {
    const socket = net.createConnection(socketPath);
    const qmp = new QMP(socket, { timeoutMs });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new QMPError('等待 QMP greeting 超时')), timeoutMs);
      qmp.once('greeting', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await qmp.command('qmp_capabilities');
    return qmp;
  }

  command(execute, args = {}, { timeoutMs } = {}) {
    if (!this.open) return Promise.reject(new QMPError('QMP 连接已关闭', { command: execute }));
    const id = ++this.sequence;
    const limit = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new QMPError(`QMP 命令超时: ${execute}`, { command: execute, timedOut: true }));
      }, limit);
      this.pending.set(id, { resolve, reject, timer, command: execute });
      this.socket.write(`${JSON.stringify({ execute, arguments: args, id })}\n`);
    });
  }

  hmp(commandLine, options) {
    return this.command('human-monitor-command', { 'command-line': commandLine }, options);
  }

  /** 停止 vCPU。属于管理操作，由同一个控制器发起。 */
  stop(options) {
    return this.command('stop', {}, options);
  }

  /** 继续运行。注意不要与 GDB 的 continue 同时发送。 */
  cont(options) {
    return this.command('cont', {}, options);
  }

  queryStatus(options) {
    return this.command('query-status', {}, options);
  }

  queryCpus(options) {
    return this.command('query-cpus-fast', {}, options);
  }

  /** 注入键盘事件，供 VGA/PS2 终端使用。 */
  sendKey(qcode, down, options) {
    return this.command(
      'input-send-event',
      { events: [{ type: 'key', data: { down, key: { type: 'qcode', data: qcode } } }] },
      options,
    );
  }

  quit(options) {
    return this.command('quit', {}, options);
  }

  /* ---------- x-oslab 观察扩展（T05a） ---------- */

  /**
   * 观察扩展是本地 QEMU 补丁新增的命令，由本项目观察扩展提供。
   * 因此这些封装只做协议转发：拒绝路径（ok=false + reason）由调用方判断，
   * 命令本身不存在时才抛 QMPError（class=CommandNotFound）。
   */
  observerCapabilities(options) {
    return this.command('x-oslab-capabilities', {}, options);
  }

  observerCapture(options) {
    return this.command('x-oslab-capture', {}, options);
  }

  observerReadPhysical({ captureId, address, length }, options) {
    // address/length 在协议里是字符串，观察者同时接受十进制与 0x 前缀
    return this.command(
      'x-oslab-read-physical',
      { captureId, address: String(address), length: String(length) },
      options,
    );
  }

  observerRelease({ captureId }, options) {
    return this.command('x-oslab-release', { captureId }, options);
  }

  /**
   * 读取观察者事件环（T05b），或切换采集开与关。
   *
   * 读取允许在 VM 运行时读取；`enable`/`reset` 只能在 VM 停止时应用，运行中观察者会
   * 返回 ok=false + reason=vm-running（有活动快照时 reset 返回 capture-active），
   * 由调用方如实上报，适配器原样返回调用结果。
   */
  observerEvents({ captureId = null, from, to, limit, kinds, enable, reset, recordKinds } = {}, options) {
    const args = {};
    if (captureId !== null && captureId !== undefined) args.captureId = String(captureId);
    if (from !== undefined && from !== null) args.from = String(from);
    if (to !== undefined && to !== null) args.to = String(to);
    if (limit !== undefined && limit !== null) args.limit = Number(limit);
    if (Array.isArray(kinds) && kinds.length > 0) args.kinds = kinds;
    if (enable !== undefined) args.enable = enable === true;
    if (reset !== undefined) args.reset = reset === true;
    // T05c 的记录期掩码：它决定「哪些 kind 会入环」，与上面的读取期 kinds 是
    // 两件事。这个字段必须真传下去——早先这里靠形参白名单拼 args，没列到的键
    // 会被静默丢掉，于是 recordKinds 看起来设了、其实环里还是全量事件。
    if (Array.isArray(recordKinds)) args.recordKinds = recordKinds;
    return this.command('x-oslab-events', args, options);
  }

  /**
   * 探测观察扩展是否存在。
   * 返回结构而不是抛异常：调用方据此把能力标为 unavailable 并给出原因，
   * 探测失败时将相应 CPU 字段标记为 unavailable。
   */
  async probeObserver(options) {
    try {
      const capabilities = await this.observerCapabilities(options);
      if (capabilities?.patched !== true) {
        return { detected: false, capabilities, reason: 'x-oslab-capabilities 未报告 patched=true' };
      }
      return { detected: true, capabilities, reason: null };
    } catch (error) {
      return { detected: false, capabilities: null, reason: error.message };
    }
  }

  close() {
    this.open = false;
    this.socket.destroy();
  }
}
