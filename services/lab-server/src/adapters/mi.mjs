/**
 * GDB/MI 进程适配器。
 *
 * 依据总体方案 6.1 与 T03b：
 * - 解析 token、结果记录、异步 stopped/running、流输出、转义字符串和错误。
 * - 按目标描述发现寄存器布局，寄存器编号取自目标描述。
 * - 物理内存访问通过 QEMU gdbstub 的 PhyMemMode 切换，切换范围受控并恢复。
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import {
  errorMessageOf,
  isRunningRecord,
  isStopRecord,
  memoryBlocksOf,
  parseRecord,
  registerNamesOf,
  registerValuesOf,
} from './mi-parse.mjs';

export class MIError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'MIError';
    this.command = options.command ?? null;
    this.raw = options.raw ?? null;
    this.timedOut = options.timedOut === true;
  }
}

export class MI extends EventEmitter {
  constructor({ cwd, logPath, gdbPath = 'gdb', requestTimeoutMs = 20000 }) {
    super();
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.token = 0;
    this.pending = new Map();
    this.buffer = '';
    this.streamBuffer = [];
    this.registerNames = [];
    this.exitCode = null;
    this.disposed = false;

    this.log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
    this.logClosed = false;
    if (this.log) {
      // 日志流错误不能变成未捕获异常；记录后继续工作
      this.log.on('error', (error) => {
        this.logError = error;
        this.logClosed = true;
      });
    }
    this.proc = spawn(gdbPath, ['-q', '--nx', '--interpreter=mi2'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      this.#writeLog(`[stderr] ${chunk}`);
      this.emit('stderr', chunk.toString());
    });
    this.proc.on('exit', (code, signal) => {
      this.exitCode = code;
      const error = new MIError(`GDB 已退出 (${signal || code})`);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.emit('exit', { code, signal });
    });
    this.proc.on('error', (error) => {
      this.emit('error', error);
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.#handleLine(line);
    }
  }

  #writeLog(line) {
    if (this.logClosed || !this.log) return;
    try {
      this.log.write(line);
    } catch {
      this.logClosed = true;
    }
  }

  #handleLine(line) {
    if (line.length === 0) return;
    this.#writeLog(`${line}\n`);
    const record = parseRecord(line);
    if (!record) {
      this.emit('raw', line);
      return;
    }

    if (record.type === 'stream') {
      this.streamBuffer.push(record.text ?? '');
      this.emit('stream', { stream: record.stream, text: record.text ?? '' });
      return;
    }

    if (record.type === '*') {
      if (isRunningRecord(record)) this.emit('running', record);
      else if (isStopRecord(record)) this.emit('stopped', record);
      else this.emit('exec-async', record);
      return;
    }

    if (record.type === '=') {
      this.emit('notify', record);
      return;
    }

    if (record.type === '+') {
      this.emit('status', record);
      return;
    }

    if (record.type === '^') {
      this.emit('result', record);
      if (record.token === null) {
        // 未经请求的结果：只广播，不解析 promise
        return;
      }
      // token 在发送时以字符串为键，这里必须同样转换，否则永远匹配不到
      const entry = this.pending.get(String(record.token));
      if (!entry) {
        this.emit('unmatched-result', record);
        return;
      }
      this.pending.delete(String(record.token));
      clearTimeout(entry.timer);
      const stream = this.streamBuffer.join('');
      this.streamBuffer = [];
      if (record.cls === 'error') {
        entry.reject(
          new MIError(errorMessageOf(record), { command: entry.command, raw: record.raw }),
        );
      } else {
        entry.resolve({ ...record, stream });
      }
    }
  }

  /**
   * 发送一条 MI 命令。timeoutMs 到期后 reject，调用方负责请求停止。
   * 注意：超时只表示没等到结果，不代表目标停止，必须显式处理。
   */
  send(command, { timeoutMs } = {}) {
    if (this.disposed) return Promise.reject(new MIError('MI 已关闭', { command }));
    const token = String(++this.token);
    const limit = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(
          new MIError(`MI 命令超时: ${command.slice(0, 120)}`, {
            command,
            timedOut: true,
          }),
        );
      }, limit);
      this.pending.set(token, { resolve, reject, timer, command });
      this.proc.stdin.write(`${token}${command}\n`);
    });
  }

  /** 通过 GDB console 执行一条命令（例如 source、add-symbol-file）。 */
  console(command, options) {
    return this.send(`-interpreter-exec console ${JSON.stringify(command)}`, options);
  }

  async initialize() {
    await this.send('-gdb-set pagination off');
    await this.send('-gdb-set confirm off');
    await this.send('-gdb-set print elements unlimited');
    await this.send('-gdb-set height 0');
    await this.send('-gdb-set width 0');
    await this.send('-gdb-set breakpoint pending on');
    await this.send('-enable-timings no');
    // 让 GDB 在异步模式下能收到 Ctrl-C 中断
    await this.send('-gdb-set target-async on').catch(() => {});
  }

  async fileExecAndSymbols(filePath, { timeoutMs = 120000 } = {}) {
    return this.send(`-file-exec-and-symbols ${JSON.stringify(filePath)}`, { timeoutMs });
  }

  async targetSelect(remote, { timeoutMs = 60000 } = {}) {
    // 注意：-target-select remote 的 device 参数不做 C 字符串解析，
    // 加了引号会被当成文件名的一部分（表现为 No such file or directory）。
    if (/\s/.test(remote)) {
      throw new MIError(`socket 路径不能包含空白字符: ${remote}`);
    }
    return this.send(`-target-select remote ${remote}`, { timeoutMs });
  }

  /** 按目标描述发现寄存器布局。 */
  async discoverRegisters() {
    const record = await this.send('-data-list-register-names');
    this.registerNames = registerNamesOf(record);
    return this.registerNames;
  }

  /** 读取全部寄存器。format 默认 'x'（十六进制）。 */
  async readRegisters(format = 'x') {
    if (this.registerNames.length === 0) await this.discoverRegisters();
    const record = await this.send(`-data-list-register-values ${format}`);
    return registerValuesOf(record, this.registerNames);
  }

  /** 切换 QEMU gdbstub 的物理内存模式。返回是否成功。 */
  async setPhysicalMode(enabled) {
    const command = `maintenance packet Qqemu.PhyMemMode:${enabled ? 1 : 0}`;
    const record = await this.console(command);
    const text = record.stream ?? '';
    if (/not supported|unknown|Undefined/i.test(text)) {
      throw new MIError(`gdbstub 不支持 PhyMemMode: ${text.trim()}`, { command });
    }
    return true;
  }

  /**
   * 在物理内存模式下执行读取，并在 finally 中恢复模式，
   * 保证地址空间切换后续命令使用恢复后的原模式。
   */
  async withPhysicalMode(fn) {
    await this.setPhysicalMode(true);
    try {
      return await fn();
    } finally {
      await this.setPhysicalMode(false).catch(() => {});
    }
  }

  /** 读取内存，返回 Buffer。失败抛出 MIError。 */
  async readMemoryBytes(address, count) {
    const hex = `0x${BigInt(address).toString(16)}`;
    const record = await this.send(`-data-read-memory-bytes ${hex} ${count}`);
    const blocks = memoryBlocksOf(record);
    if (blocks.length === 0) {
      throw new MIError(`内存读取没有返回内容: ${hex} +${count}`, { command: 'data-read-memory-bytes' });
    }
    return Buffer.concat(blocks.map((block) => Buffer.from(block.contents, 'hex')));
  }

  /** 读取物理内存（RAM/ROM）。 */
  async readPhysicalBytes(address, count) {
    return this.withPhysicalMode(() => this.readMemoryBytes(address, count));
  }

  async breakInsert(location, { hardware = true } = {}) {
    return this.send(`-break-insert ${hardware ? '-h ' : ''}${JSON.stringify(location)}`);
  }

  async breakDelete(identifier) {
    return this.send(`-break-delete ${identifier}`);
  }

  async breakList() {
    return this.send('-break-list');
  }

  async continue() {
    return this.send('-exec-continue');
  }

  async stepInstruction() {
    return this.send('-exec-step-instruction');
  }

  async stepSource() {
    return this.send('-exec-step');
  }

  async nextSource() {
    return this.send('-exec-next');
  }

  async interrupt() {
    return this.send('-exec-interrupt', { timeoutMs: 10000 });
  }

  /** 加载额外符号：add-symbol-file <file> <textaddr> [-s sec addr ...] */
  async addSymbolFile(filePath, textAddress, sections = {}) {
    const parts = [JSON.stringify(filePath), textAddress];
    for (const [name, address] of Object.entries(sections)) {
      parts.push('-s', name, address);
    }
    return this.console(`add-symbol-file ${parts.join(' ')}`, { timeoutMs: 120000 });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new MIError('MI 已关闭'));
    }
    this.pending.clear();
    if (!this.proc.killed) this.proc.kill('SIGTERM');
    // 先禁止写入再 end，GDB 退出期间仍可能有输出
    this.logClosed = true;
    try {
      this.log?.end();
    } catch {
      // 日志关闭失败不影响会话清理
    }
  }
}
