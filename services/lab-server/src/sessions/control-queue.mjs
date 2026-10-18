/**
 * 单会话串行控制队列（T03d）。
 *
 * 要求：命令串行、requestId 幂等（同 requestId 不执行两次）、
 * 超时后可控停止。队列本身不解释 GDB/QMP 语义，只保证顺序与去重。
 */

export class ControlQueue {
  /**
   * @param {object} options
   * @param {number} options.defaultTimeoutMs 单条命令默认超时
   * @param {(requestId: string, error: Error) => Promise<void>} options.onTimeout 超时回调，用于请求目标停止
   * @param {number} options.historyLimit 幂等结果保留条数
   */
  constructor({ defaultTimeoutMs = 20000, onTimeout = null, historyLimit = 200 } = {}) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.onTimeout = onTimeout;
    this.historyLimit = historyLimit;
    this.tail = Promise.resolve();
    this.results = new Map();
    this.inFlight = new Map();
    this.depth = 0;
  }

  get busy() {
    return this.inFlight.size > 0;
  }

  get queued() {
    return this.depth;
  }

  #remember(requestId, value) {
    this.results.set(requestId, value);
    while (this.results.size > this.historyLimit) {
      const oldest = this.results.keys().next().value;
      this.results.delete(oldest);
    }
  }

  /**
   * 执行一条命令。
   * @returns {Promise<{duplicate: boolean, value: unknown}>}
   */
  async execute(requestId, task, { timeoutMs } = {}) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('命令必须有非空 requestId');
    }
    if (this.results.has(requestId)) {
      return { duplicate: true, value: this.results.get(requestId) };
    }
    if (this.inFlight.has(requestId)) {
      const value = await this.inFlight.get(requestId);
      return { duplicate: true, value };
    }

    this.depth += 1;
    const run = this.tail.then(async () => {
      const limit = timeoutMs ?? this.defaultTimeoutMs;
      return this.#raceTimeout(requestId, task(), limit);
    });
    this.inFlight.set(requestId, run);
    // 队列继续前进，但把失败吞掉以免污染后续任务
    this.tail = run.then(
      () => {},
      () => {},
    );

    try {
      const value = await run;
      this.#remember(requestId, value);
      return { duplicate: false, value };
    } finally {
      this.inFlight.delete(requestId);
      this.depth = Math.max(0, this.depth - 1);
    }
  }

  async #raceTimeout(requestId, promise, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`命令超时 (${timeoutMs}ms)`);
        error.code = 'command-timeout';
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch (error) {
      if (error.code === 'command-timeout' && this.onTimeout) {
        // 超时后请求受控停止，避免目标永远运行在未知状态
        await this.onTimeout(requestId, error).catch(() => {});
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 清理排队与幂等状态。 */
  reset() {
    this.results.clear();
    this.inFlight.clear();
    this.tail = Promise.resolve();
    this.depth = 0;
  }
}

/**
 * 等待一次性事件，超时 reject。
 * 用于「等停止通知」这类场景，超时后调用方必须请求停止。
 */
export function waitForEvent(emitter, event, timeoutMs, { onTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      emitter.off(event, handler);
      const error = new Error(`等待 ${event} 超时 (${timeoutMs}ms)`);
      error.code = 'command-timeout';
      if (onTimeout) await onTimeout(error).catch(() => {});
      reject(error);
    }, timeoutMs);
    const handler = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    emitter.once(event, handler);
  });
}
