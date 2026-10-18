/**
 * 最小 HTTP/WS API（T03）。
 *
 * 合同见总体方案 7.3。要点：
 * - 命令携带 requestId/epoch/expectedFrameId，幂等。
 * - 参数白名单；前端不能提交任意 shell/GDB 命令。
 * - 历史模式禁用执行控制与客体输入。
 * - 源文件与镜像路径限定在会话产物清单内。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import websocket from '@fastify/websocket';
import { ErrorCode } from '../../../../packages/contracts/errors.ts';
import { isCommandType } from '../../../../packages/contracts/command.ts';

const MAX_SESSIONS = 2;

function fail(code, message, detail) {
  const error = new Error(message);
  error.statusCode = code === ErrorCode.SESSION_NOT_FOUND ? 404 : 400;
  error.code = code;
  error.detail = detail;
  return error;
}

/**
 * 序号参数：契约里 seq 是十进制字符串（u64，不能过 Number）。
 * 空值表示「不限制」，非法值必须是明确的 invalid-request，不能静默变成 0。
 */
function parseSeq(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) {
    throw fail(ErrorCode.INVALID_REQUEST, `${name} 必须是十进制或 0x 前缀的序号，收到 ${JSON.stringify(value)}`);
  }
  return BigInt(text).toString();
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw fail(ErrorCode.INVALID_REQUEST, `limit 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
  // 上限由观察者按环形缓冲容量判定（invalid-limit）；这里只挡住 NaN 与非整数，
  // 不替观察者把越界值夹到合法区间，否则调用方会拿到一个被悄悄改过的 limit。
  return limit;
}

function parseKinds(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const kinds = raw.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  return kinds.length > 0 ? kinds : null;
}

/** 服务自身的事件日志（属于服务编排记录），按服务记录的序号区间读取。 */
function serviceEvents(session, query) {
  const from = BigInt(parseSeq(query?.from, 'from') ?? 0);
  const to = parseSeq(query?.to, 'to');
  const limit = Math.min(Number(parseLimit(query?.limit) ?? 500), 5000);
  const events = session.events
    .filter((event) => BigInt(event.seq) >= from && (to === null || BigInt(event.seq) <= BigInt(to)))
    .slice(0, limit);
  return {
    events,
    truncated: session.events.length > events.length,
    dropped: 0,
    note: '服务自身的编排记录（capture.fence、QMP 事件、GDB 通知），属于服务编排记录；'
      + '客体事件请用 source=observer（需要 x-oslab-events）',
  };
}

export class SessionRegistry {
  constructor({ root, qemuPath } = {}) {
    this.root = root;
    this.qemuPath = qemuPath;
    this.sessions = new Map();
    this.streams = new Map();
    // 导入的录制包（T09）：没有 QEMU，只读回放。键是 rec-<hash前缀>。
    this.recordings = new Map();
  }

  /**
   * 导入录制包（T09 第 5 条）。
   *
   * 只接受本项目 schema 的 JSON 数据；校验帧归属与 epoch 单调，按 JSON 数据结构解析。
   * 导入后以已提交存档帧作为数据源，历史帧就是唯一的运行数据源。
   */
  importRecording(payload, { expectedSha256 = null } = {}) {
    if (!payload || typeof payload !== 'object') throw fail(ErrorCode.INVALID_REQUEST, '录制包必须是 JSON 对象');
    if (payload.kind !== 'oslab-recording' || payload.schemaVersion !== 1) {
      throw fail(ErrorCode.INVALID_REQUEST, '录制包 kind 必须是 oslab-recording、schemaVersion 必须是 1');
    }
    if (!Array.isArray(payload.frames) || payload.frames.length === 0) {
      throw fail(ErrorCode.INVALID_REQUEST, '录制包必须包含至少一个帧');
    }
    const first = payload.frames[0];
    const sessionId = payload.manifest?.session?.id ?? first.sessionId;
    let lastFrameId = -1;
    for (const frame of payload.frames) {
      if (frame.sessionId !== sessionId) {
        throw fail(ErrorCode.INVALID_REQUEST, '录制包内的帧属于不同会话，拒绝导入');
      }
      if (!Number.isInteger(frame.frameId) || frame.frameId <= lastFrameId) {
        throw fail(ErrorCode.INVALID_REQUEST, '录制包的 frameId 必须严格递增');
      }
      if (!Number.isInteger(frame.epoch) || frame.epoch < 1) {
        throw fail(ErrorCode.INVALID_REQUEST, `帧 ${frame.frameId} 的 epoch 非法`);
      }
      lastFrameId = frame.frameId;
    }
    const canonical = JSON.stringify(payload);
    const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');
    if (expectedSha256 !== null && expectedSha256 !== sha256) {
      throw fail(ErrorCode.INVALID_REQUEST, '录制包内容散列与声明不一致', {
        expected: expectedSha256,
        actual: sha256,
      });
    }
    const id = `rec-${sha256.slice(0, 12)}`;
    const record = {
      id,
      sha256,
      importedAt: new Date().toISOString(),
      manifest: payload.manifest ?? null,
      frames: payload.frames,
      source: payload.source ?? null,
    };
    this.recordings.set(id, record);
    return {
      id,
      sha256,
      frameCount: record.frames.length,
      firstFrameId: record.frames[0].frameId,
      lastFrameId: record.frames.at(-1).frameId,
      manifest: record.manifest,
    };
  }

  getRecording(id) {
    const record = this.recordings.get(id);
    if (!record) throw fail(ErrorCode.SESSION_NOT_FOUND, `录制包不存在: ${id}`);
    return record;
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw fail(ErrorCode.SESSION_NOT_FOUND, `会话不存在: ${id}`);
    return session;
  }

  async create({ profile = 'full-boot', diskFault = null } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw fail(ErrorCode.INTERNAL, `同时最多运行 ${MAX_SESSIONS} 个会话，请先关闭一个`);
    }
    const { Session } = await import('../sessions/session.mjs');
    const session = new Session({ root: this.root, profile, qemuPath: this.qemuPath, diskFault });
    this.sessions.set(session.id, session);
    session.on('message', (message) => this.broadcast(session.id, message));
    try {
      const started = await session.start();
      return { session, started };
    } catch (error) {
      this.sessions.delete(session.id);
      await session.close().catch(() => {});
      throw error;
    }
  }

  async destroy(id) {
    const session = this.get(id);
    await session.close();
    this.sessions.delete(id);
    this.streams.delete(id);
    return { closed: true };
  }

  broadcast(id, message) {
    const sockets = this.streams.get(id) ?? new Set();
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  attach(id, socket) {
    if (!this.streams.has(id)) this.streams.set(id, new Set());
    this.streams.get(id).add(socket);
    socket.on('close', () => this.streams.get(id)?.delete(socket));
  }

  async closeAll() {
    for (const [id] of this.sessions) {
      await this.destroy(id).catch(() => {});
    }
  }
}

/** 校验命令信封，返回规范化后的命令。 */
export function validateCommand(raw) {
  if (!raw || typeof raw !== 'object') throw fail(ErrorCode.INVALID_REQUEST, '命令必须是 JSON 对象');
  const { type, requestId, epoch, expectedFrameId } = raw;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw fail(ErrorCode.INVALID_REQUEST, '必须有 requestId');
  }
  if (typeof epoch !== 'number' || !Number.isInteger(epoch)) {
    throw fail(ErrorCode.INVALID_REQUEST, 'epoch 必须是整数');
  }
  if (typeof expectedFrameId !== 'number' || !Number.isInteger(expectedFrameId)) {
    throw fail(ErrorCode.INVALID_REQUEST, 'expectedFrameId 必须是整数');
  }
  if (!isCommandType(type)) {
    throw fail(ErrorCode.INVALID_REQUEST, `命令类型不在白名单内: ${String(type)}`);
  }
  return { ...raw, type, requestId, epoch, expectedFrameId };
}

/**
 * 幂等与迟到检查。
 * 迟到（stale epoch）与视图过期（frame mismatch）都要明确区分，
 * 前者可被丢弃，后者要求前端先返回最新帧。
 */
export function checkFreshness(session, command) {
  if (command.epoch !== session.epoch) {
    throw fail(ErrorCode.STALE_EPOCH, `命令 epoch=${command.epoch}，当前 epoch=${session.epoch}`, {
      currentEpoch: session.epoch,
    });
  }
  const latest = session.frames.at(-1)?.frameId ?? 0;
  if (command.expectedFrameId !== latest) {
    throw fail(
      ErrorCode.FRAME_MISMATCH,
      `命令基于 frame ${command.expectedFrameId}，最新为 ${latest}`,
      { latestFrameId: latest },
    );
  }
}

/** 历史模式下禁止执行控制与客体输入。 */
export function assertLive(session, type) {
  const executionTypes = new Set([
    'step', 'continue', 'pause', 'stop', 'breakpoint.insert', 'breakpoint.remove',
    'run-to', 'terminal.input', 'keyboard', 'stage.load', 'boot.calibrate',
  ]);
  if (executionTypes.has(type) && session.mode !== 'live') {
    throw fail(ErrorCode.HISTORY_READ_ONLY, '历史模式只允许查看记录，禁止执行控制或客体输入');
  }
}

/**
 * 把白名单命令分派到会话方法。
 *
 * 只做参数转译，语义判断交给 Session：所有真正的语义（断点歧义、物理内存模式、
 * 幂等、串行）都在 Session 内实现，这里不重复判断。
 */
async function dispatchCommand(session, command, registry) {
  switch (command.type) {
    case 'view':
      return session.setView({
        requestId: command.requestId,
        mode: command.mode,
        targetFrameId: command.targetFrameId,
      });

    case 'step':
      return session.step({
        requestId: command.requestId,
        granularity: command.granularity ?? 'instruction',
        count: command.count ?? 1,
      });

    case 'continue':
      return session.continue({ requestId: command.requestId });

    case 'pause':
      return session.pause({ requestId: command.requestId });

    case 'stop': {
      const sessionId = session.id;
      const teardown = command.teardown !== false;
      if (teardown) {
        await registry.destroy(sessionId);
        return { stopped: true, terminated: true, sessionId };
      }
      await session.requestPause('stop');
      return { stopped: true, terminated: false, sessionId };
    }

    case 'breakpoint.insert':
      return session.breakpointInsert({
        requestId: command.requestId,
        location: command.location ?? {},
        // kind 为 software 时用软件断点，其余（hardware/监视）都用硬件断点
        hardware: command.kind !== 'software',
      });

    case 'breakpoint.remove':
      return session.breakpointRemove({
        requestId: command.requestId,
        breakpointId: command.breakpointId,
      });

    case 'run-to':
      return session.runTo({
        requestId: command.requestId,
        location: command.location ?? {},
        timeoutMs: command.timeoutMs ?? 30000,
      });

    // T06：memory.read 按 mode 分出四种动作。走命令队列而不是 GET，是为了
    // 拿到 requestId 幂等与「与控制命令串行」——全量基线要读十几万次，
    // 绝不能和一次 step/continue 交错执行。
    case 'memory.read': {
      const mode = command.mode ?? 'read';
      if (mode === 'baseline') {
        return session.memoryBaseline({ requestId: command.requestId });
      }
      if (mode === 'delta') {
        return session.memoryDelta({
          requestId: command.requestId,
          baseCaptureId: command.baseCaptureId ?? null,
        });
      }
      if (mode === 'selected') {
        return session.memorySelected({
          requestId: command.requestId,
          address: command.address,
          length: command.length ?? 64,
        });
      }
      if (mode === 'read') {
        return session.readMemory({
          requestId: command.requestId,
          addressSpace: command.addressSpace ?? 'linear',
          address: command.address,
          length: command.length,
        });
      }
      throw fail(
        ErrorCode.INVALID_REQUEST,
        `memory.read 的 mode 只能是 read/baseline/delta/selected，收到 ${JSON.stringify(command.mode)}`,
      );
    }

    case 'boot.calibrate':
      return session.calibrateBoot({ requestId: command.requestId, timeoutMs: command.timeoutMs ?? 120000 });

    case 'stage.load':
      return session.loadStageSymbols({
        requestId: command.requestId,
        module: command.module,
        address: command.address,
      });

    case 'terminal.input': {
      // 串口输入以文本为主；仅给 bytes 时按 base64 还原为原始字节串
      const text =
        typeof command.text === 'string' && command.text.length > 0
          ? command.text
          : command.bytes
            ? Buffer.from(command.bytes, 'base64').toString('latin1')
            : '';
      return session.terminalInput({ requestId: command.requestId, text });
    }

    case 'keyboard':
      return session.keyboard({
        requestId: command.requestId,
        action: command.action,
        key: command.key,
      });

    default:
      throw fail(ErrorCode.INVALID_REQUEST, `未实现的命令类型: ${String(command.type)}`);
  }
}

export async function registerApi(app, registry) {
  await app.register(websocket, { options: { maxPayload: 16384 } });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return reply.code(403).send({ error: { code: ErrorCode.INVALID_REQUEST, message: 'Origin 非法' } });
    }
    if (host !== request.headers.host) {
      return reply
        .code(403)
        .send({ error: { code: ErrorCode.INVALID_REQUEST, message: '禁止跨源控制' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const code = error.code ?? ErrorCode.INTERNAL;
    const status = error.statusCode ?? (code === ErrorCode.INTERNAL ? 500 : 400);
    reply.code(status).send({
      error: {
        code,
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      },
    });
  });

  app.get('/api/health', async () => ({
    ok: true,
    service: 'linux-observatory',
    qemu: fs.existsSync(path.join(registry.root, 'artifacts/build/qemu/qemu-system-x86_64')),
    kernel: fs.existsSync(path.join(registry.root, 'artifacts/bzImage')),
    rootfs: fs.existsSync(path.join(registry.root, 'artifacts/rootfs.img')),
    activeSessions: registry.sessions.size,
  }));

  app.get('/api/sessions', async () => [...registry.sessions.values()].map((session) => session.serialize()));

  app.post('/api/sessions', async (request, reply) => {
    const profile = request.body?.profile === 'kernel-fast' ? 'kernel-fast' : 'full-boot';
    /*
     * 可选的一次性写故障：只接受「扇区号 + 可选 errno/iotype/once」这种最小形状，
     * 并且扇区号必须是正整数（0 会让规则落在超级块上，那不是我们要观察的场景）。
     * 不在这里给默认扇区——用哪个扇区是调用方的选择，混进猜测就不可复现了。
     */
    let diskFault = null;
    if (request.body?.diskFault !== undefined && request.body.diskFault !== null) {
      const raw = request.body.diskFault;
      const sector = Number(raw?.sector);
      if (!Number.isInteger(sector) || sector <= 0) {
        return reply.code(400).send({
          error: { code: 'invalid-request', message: 'diskFault.sector 必须是正整数（512 字节单位）' },
        });
      }
      const errno = raw.errno === undefined ? 5 : Number(raw.errno);
      if (!Number.isInteger(errno) || errno <= 0) {
        return reply.code(400).send({
          error: { code: 'invalid-request', message: 'diskFault.errno 必须是正整数' },
        });
      }
      diskFault = {
        sector,
        errno,
        iotype: typeof raw.iotype === 'string' && raw.iotype.length > 0 ? raw.iotype : 'write',
        once: raw.once === undefined ? true : raw.once === true,
      };
    }
    const { session, started } = await registry.create({ profile, diskFault });
    return reply.code(201).send({
      ...session.serialize(),
      firstFrame: started.frame,
    });
  });

  app.get('/api/sessions/:id', async (request) => registry.get(request.params.id).serialize());

  app.delete('/api/sessions/:id', async (request) => registry.destroy(request.params.id));

  app.get('/api/sessions/:id/capabilities', async (request) =>
    registry.get(request.params.id).capabilities(),
  );

  app.get('/api/sessions/:id/terminal', async (request) => {
    const session = registry.get(request.params.id);
    const limit = Math.min(Number(request.query?.limit ?? 262144), 262144);
    const truncated = session.terminal.length > limit;
    return {
      text: truncated ? session.terminal.slice(-limit) : session.terminal,
      bytes: session.terminalBytes,
      truncated,
      note: '返回当前串口累积输出快照；增量由 WS terminal.output 推送',
    };
  });

  app.get('/api/sessions/:id/symbols', async (request) => {
    const session = registry.get(request.params.id);
    return { stages: session.symbols.availability(), plan: session.symbolPlan ?? null };
  });

  /**
   * 课程目录（T10–T12）。`available=false` 的课带原因，界面不把它当成可命中。
   */
  app.get('/api/sessions/:id/curriculum', async (request) => registry.get(request.params.id).lessonCatalog());

  app.get('/api/lessons', async () => {
    const first = registry.sessions.values().next().value ?? null;
    if (first === null) {
      return {
        schema: 'oslab.curriculum/1',
        lessons: [],
        unavailable: [],
        note: '课程目录按会话产物判定符号可用性；先启动一个会话，或直接阅读 curriculum/linux-x86_64/lessons.json',
      };
    }
    return first.lessonCatalog();
  });

  /** 选中进程只影响详情面板，内核 current 保持原值（T08）。 */
  app.post('/api/sessions/:id/selection', async (request) => {
    const session = registry.get(request.params.id);
    if (session.mode === 'recorded') {
      throw fail(ErrorCode.HISTORY_READ_ONLY, '历史模式不能改变选中进程');
    }
    return session.selectProcess({ pid: request.body?.pid });
  });

  /** OS 解析器状态：布局绑定、最近一帧解析统计与课程可用性。 */
  app.get('/api/sessions/:id/os', async (request) => registry.get(request.params.id).osStatus());

  /**
   * 盘面视图（T08）。
   *
   * 读的是基线镜像 + 已对客体可见的写，不是宿主 qcow2；历史帧版本不一致时
   * 响应里会写 `frameDiskVersion` 与 `versionId`，由界面标注。
   */
  app.get('/api/sessions/:id/filesystem', async (request) => {
    const session = registry.get(request.params.id);
    const pathQuery = typeof request.query?.path === 'string' ? request.query.path : '/';
    const depth = Math.min(Math.max(Number(request.query?.depth ?? 1), 0), 3);
    const maxEntries = Math.min(Math.max(Number(request.query?.maxEntries ?? 64), 1), 256);
    return session.filesystem({
      path: pathQuery,
      depth,
      maxEntries,
      frameId: request.query?.frameId ?? null,
      versionId: typeof request.query?.versionId === 'string' ? request.query.versionId : null,
    });
  });

  app.get('/api/sessions/:id/frames', async (request) => {
    const session = registry.get(request.params.id);
    return {
      sessionId: session.id,
      epoch: session.epoch,
      liveFrameId: session.frames.at(-1)?.frameId ?? null,
      viewFrameId: session.viewFrameId,
      mode: session.mode,
      frames: session.frames.map((frame) => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        reason: frame.stop.reason,
        pc: frame.stop.pc,
        cpuId: frame.stop.cpuId,
        source: frame.source?.symbol ?? null,
        module: frame.source?.module ?? null,
        line: frame.source?.line ?? null,
        lessonId: frame.lesson?.lessonId ?? null,
        lessonTitle: frame.lesson?.title ?? null,
        memoryCoverage: frame.coverage.memory,
        eventsCoverage: frame.coverage.events,
        committedAt: frame.committedAt,
        captureMs: frame.captureMs ?? null,
      })),
    };
  });

  app.get('/api/sessions/:id/frames/:frameId', async (request) => {
    const session = registry.get(request.params.id);
    const frameId = Number(request.params.frameId);
    const epoch = Number(request.query?.epoch ?? session.epoch);
    if (epoch !== session.epoch) {
      throw fail(ErrorCode.STALE_EPOCH, `请求 epoch=${epoch}，当前 epoch=${session.epoch}`);
    }
    const frame = session.frames.find((entry) => entry.frameId === frameId);
    if (!frame) throw fail(ErrorCode.FRAME_MISMATCH, `帧 ${frameId} 不在本会话历史中`);
    return frame;
  });

  /**
   * 事件流（T05a/T05b）。
   *
   * 两条互不冒充的通道，用 `source` 显式区分：
   * - `observer`（默认，观察扩展可用时）：客体真实事件环，`x-oslab-events` 原样
   *   返回；seq、水位线、丢失与截断全部由观察者判定，服务不重算；
   * - `service`（`source=service`，或观察扩展不可用时的回退）：服务自身的编排
   *   记录（capture.fence、QMP 事件、GDB 通知），不是客体事件，靠 note 标明。
   *
   * epoch 必须与当前会话一致：混用不同会话/不同代数的事件区间会让面板把上一代
   * 的序号当成这一代的，因此按迟到消息处理（stale-epoch）而不是静默截取。
   */
  app.get('/api/sessions/:id/events', async (request) => {
    const session = registry.get(request.params.id);
    const epoch = Number(request.query?.epoch ?? session.epoch);
    if (epoch !== session.epoch) {
      throw fail(ErrorCode.STALE_EPOCH, `请求 epoch=${epoch}，当前 epoch=${session.epoch}`);
    }
    const source = request.query?.source ?? null;
    if (source !== null && source !== 'observer' && source !== 'service') {
      throw fail(ErrorCode.INVALID_REQUEST, `source 只能是 observer 或 service，收到 ${source}`);
    }
    if (source === 'service' || (source === null && !session.observer.detected)) {
      return {
        ...serviceEvents(session, request.query),
        schema: 'oslab.events/1',
        epoch,
        source: 'service',
      };
    }
    const result = await session.observerEvents({
      from: parseSeq(request.query?.from, 'from'),
      to: parseSeq(request.query?.to, 'to'),
      limit: parseLimit(request.query?.limit),
      kinds: parseKinds(request.query?.kinds),
    });
    return {
      ...result,
      schema: 'oslab.events/1',
      epoch,
      source: 'observer',
      serviceEventCount: session.events.length,
      note: '来自 x-oslab-events：序号、水位线、丢失与截断由观察者判定；'
        + '事件属于「读取时刻之前」的时间轴，与帧的绑定由 capture 的 eventWatermark 表达',
    };
  });

  /**
   * 事件采集开关（T05b）。
   *
   * 归到控制面而不是 GET：它改变翻译期发射点，且切换后观察者会整片失效已翻译的
   * TB，属于会话状态变更。观察者只允许 VM 停止时切换（运行中 vm-running）、有活动
   * 快照时拒绝 reset（capture-active），两种情况都原样透出错误码，不自行绕过。
   */
  app.post('/api/sessions/:id/events', async (request) => {
    const session = registry.get(request.params.id);
    const body = request.body ?? {};
    const epoch = Number(body.epoch ?? session.epoch);
    if (epoch !== session.epoch) {
      throw fail(ErrorCode.STALE_EPOCH, `请求 epoch=${epoch}，当前 epoch=${session.epoch}`);
    }
    if (session.mode === 'recorded') {
      throw fail(ErrorCode.HISTORY_READ_ONLY, '历史模式不能改变事件采集开关');
    }
    if (body.enable === undefined && body.reset === undefined && body.recordKinds === undefined) {
      throw fail(ErrorCode.INVALID_REQUEST, '必须给出 enable、reset 或 recordKinds 之一；只读事件用 GET');
    }
    if (body.recordKinds !== undefined && !Array.isArray(body.recordKinds)) {
      throw fail(ErrorCode.INVALID_REQUEST, 'recordKinds 必须是字符串数组');
    }
    const result = await session.switchObserverEvents({
      enable: body.enable,
      reset: body.reset,
      recordKinds: body.recordKinds,
      requestId: typeof body.requestId === 'string' && body.requestId.length > 0 ? body.requestId : null,
    });
    return { ...result, schema: 'oslab.events.switch/1', epoch };
  });

  /**
   * 内存查询。
   *
   * `mode` 决定走哪条路：
   * - `read`（默认）：当前帧的内存，物理读走绑定 captureId 的观察者通道；
   * - `recorded`：**只读存档**，找不到就报「本次未记录」，历史模式也能用；
   * - `translate`：地址翻译，用该采集代的 CR3 + 当时的（或存档的）页表字节；
   * - `coverage`：覆盖统计（契约 MemoryCoverageStats）。
   *
   * 刻意不提供「任意地址读当前 VM」的历史模式后门：历史模式只允许
   * `recorded` / `translate` / `coverage`，其余一律拒绝。
   */
  app.get('/api/sessions/:id/memory', async (request) => {
    const session = registry.get(request.params.id);
    const {
      address,
      length,
      addressSpace = 'linear',
      frameId,
      mode = 'read',
      captureId = null,
      segmentBase = undefined,
      withSegment = '0',
    } = request.query ?? {};

    if (mode === 'coverage') {
      return {
        schema: 'oslab.memory.coverage/1',
        ...(await session.memoryCoverage({ captureId })),
      };
    }
    if (!address) throw fail(ErrorCode.INVALID_REQUEST, '必须给出 address');

    if (mode === 'recorded') {
      return session.memoryReadRecorded({
        captureId,
        address,
        length: Number(length ?? 64),
      });
    }
    if (mode === 'translate') {
      return session.translate({
        requestId: `api-translate-${crypto.randomUUID()}`,
        address,
        captureId,
        segmentBase: segmentBase === undefined ? undefined : segmentBase,
        withSegment: withSegment === '1' || withSegment === 'true',
      });
    }
    if (mode !== 'read') {
      throw fail(
        ErrorCode.INVALID_REQUEST,
        `memory 的 mode 只能是 read/recorded/translate/coverage，收到 ${JSON.stringify(mode)}`,
      );
    }
    if (session.mode === 'recorded') {
      throw fail(
        ErrorCode.HISTORY_READ_ONLY,
        '历史模式不能读「当前 VM 的内存」；请用 mode=recorded 读该帧已记录的字节，'
          + '或用 mode=translate 按该帧的页表翻译地址',
        { frameId: frameId ?? null },
      );
    }
    return session.readMemory({
      // 读内存是纯查询，没有客户端可见的 requestId 可以复用；如果拿毫秒
      // 时间戳充当它，同一毫秒内的两次读会被控制队列按 requestId 判成
      // 「同一次请求」，第二次直接回放第一次的字节（T05b 验收时实测到）。
      requestId: `api-memory-${crypto.randomUUID()}`,
      addressSpace,
      address,
      length: Number(length ?? 64),
    });
  });

  /**
   * 队列面板（T06 第 3 条）。
   *
   * 返回的队列内容是在**采集时**按当时的 captureId 解出来的（存在帧里），
   * 只返回该帧已解码的队列内容——后者会在 VM 已经跑过之后给出另一套内容。
   * `queueIndexes` 可选，用来只看某几个队列。
   */
  app.get('/api/sessions/:id/virtqueues', async (request) => {
    const session = registry.get(request.params.id);
    const { captureId = null, queueIndexes = null } = request.query ?? {};
    const indexes = typeof queueIndexes === 'string' && queueIndexes.length > 0
      ? queueIndexes.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value))
      : null;
    return session.virtqueues({ captureId, queueIndexes: indexes });
  });

  /**
   * 磁盘逻辑版本表（T06 第 4 条）。
   *
   * 三种用法：
   * - 不带 `lba`：返回版本表（可见写范围 + 未可见写 + 基线散列）；
   * - `lba` + `count`：读该 LBA 范围在**帧绑定的逻辑版本**下的内容；
   * - `payloads=1`（可带 `requestId`）：返回独立保存的 pending 写载荷。
   *
   * 注释里特别说明：这里读不到活跃 qcow2 的「当前内容」——那是宿主的文件，
   * 不是客体的逻辑版本；离线校验是另一个接口（`mode=offline`）。
   */
  app.get('/api/sessions/:id/disk', async (request) => {
    const session = registry.get(request.params.id);
    const { lba = null, count = '1', payloads = '0', requestId = null, mode = 'view' } = request.query ?? {};

    if (mode === 'offline') {
      return session.offlineDiskCheck({});
    }
    if (mode !== 'view') {
      throw fail(
        ErrorCode.INVALID_REQUEST,
        `disk 的 mode 只能是 view/offline，收到 ${JSON.stringify(mode)}`,
      );
    }
    if (payloads === '1' || payloads === 'true') {
      return session.diskPayloads({ requestId });
    }
    if (lba !== null && lba !== '') {
      return session.diskRead({ lba, count: Number(count) });
    }
    return session.diskView();
  });

  /** 导出当前会话的录制包（T09）。 */
  app.get('/api/sessions/:id/recording', async (request, reply) => {
    const session = registry.get(request.params.id);
    const exported = session.exportRecording();
    return reply
      .header('Content-Disposition', `attachment; filename="linux-lab-${session.id}.json"`)
      .header('X-Content-SHA256', exported.sha256)
      .type('application/json')
      .send(exported.data);
  });

  /** 录制包导入列表。 */
  app.get('/api/recordings', async () => [...registry.recordings.values()].map((record) => ({
    id: record.id,
    sha256: record.sha256,
    importedAt: record.importedAt,
    frameCount: record.frames.length,
    manifest: record.manifest,
  })));

  /**
   * 导入录制包（T09 第 5 条）。
   *
   * 导入的是数据，不是可执行脚本：只校验 schema、帧归属和可选的 SHA-256，
   * 以已提交存档帧作为数据源、不恢复虚拟机。
   */
  app.post('/api/recordings', { bodyLimit: 128 * 1024 * 1024 }, async (request, reply) => {
    const result = registry.importRecording(request.body, {
      expectedSha256: request.headers['x-content-sha256'] ?? request.body?.expectedSha256 ?? null,
    });
    return reply.code(201).send(result);
  });

  app.get('/api/recordings/:recordingId', async (request) => {
    const record = registry.getRecording(request.params.recordingId);
    return {
      id: record.id,
      sha256: record.sha256,
      importedAt: record.importedAt,
      manifest: record.manifest,
      frameCount: record.frames.length,
      frames: record.frames.map((frame) => ({
        frameId: frame.frameId,
        reason: frame.stop?.reason ?? null,
        pc: frame.stop?.pc ?? null,
        source: frame.source?.symbol ?? null,
        module: frame.source?.module ?? null,
        line: frame.source?.line ?? null,
        lessonId: frame.lesson?.lessonId ?? null,
        lessonTitle: frame.lesson?.title ?? null,
        committedAt: frame.committedAt,
      })),
    };
  });

  app.get('/api/recordings/:recordingId/frames/:frameId', async (request) => {
    const record = registry.getRecording(request.params.recordingId);
    const frame = record.frames.find((entry) => entry.frameId === Number(request.params.frameId));
    if (!frame) throw fail(ErrorCode.FRAME_MISMATCH, `录制包里没有帧 ${request.params.frameId}`);
    return frame;
  });

  app.delete('/api/recordings/:recordingId', async (request) => {
    const record = registry.getRecording(request.params.recordingId);
    registry.recordings.delete(record.id);
    return { deleted: true, id: record.id };
  });

  app.post('/api/sessions/:id/commands', async (request) => {
    const session = registry.get(request.params.id);
    const command = validateCommand(request.body);

    // 幂等优先于新鲜度检查：重试请求带着与首次相同的 expectedFrameId 回来，
    // 必须先返回既有结果，否则合法重试会被误判为视图过期。
    const cached = session.lookupResult(command.requestId);
    if (cached !== null) {
      return { ...cached, idempotent: true, duplicate: true };
    }

    checkFreshness(session, command);
    assertLive(session, command.type);

    const result = await dispatchCommand(session, command, registry);
    session.rememberResult(command.requestId, result);
    return result;
  });

  app.register(async (instance) => {
    instance.get('/api/sessions/:id/stream', { websocket: true }, (connection, request) => {
      const socket = connection.socket ?? connection;
      let session;
      try {
        session = registry.get(request.params.id);
      } catch (error) {
        socket.send(JSON.stringify({ error: { code: error.code, message: error.message } }));
        socket.close();
        return;
      }
      registry.attach(session.id, socket);
      socket.send(
        JSON.stringify({
          type: 'session.state',
          sessionId: session.id,
          state: session.state,
          epoch: session.epoch,
        }),
      );
      socket.on('message', (raw) => {
        // 重连携带最后确认帧：只回送状态，不接受控制命令
        try {
          const payload = JSON.parse(raw.toString());
          if (payload.type === 'resync') {
            socket.send(
              JSON.stringify({
                type: 'session.state',
                sessionId: session.id,
                state: session.state,
                epoch: session.epoch,
                lastConfirmedFrameId: payload.lastConfirmedFrameId ?? null,
                latestFrameId: session.frames.at(-1)?.frameId ?? null,
              }),
            );
          }
        } catch {
          // 忽略无法解析的客户端消息
        }
      });
    });
  });
}
