/**
 * 单一 Frame store（T04d）。
 *
 * 所有面板都从同一个 activeFrame 派生，通过 store 订阅接收更新。
 * 唯一的数据来源是：
 *   1) 命令响应中携带的 frame；
 *   2) WS frame.committed 触发的按需拉取。
 * 两条路径都经过 applyFrame，按 (epoch, frameId) 去重与防倒退。
 */

import { api, ApiError } from './api';
import type {
  Breakpoint,
  Curriculum,
  EventsResult,
  FileSystemView,
  Frame,
  FrameList,
  FrameSummary,
  MemoryView,
  PageWalkResult,
  ReplayState,
  SessionInfo,
} from './types';

export interface Notice {
  at: string;
  text: string;
  level: 'info' | 'warn' | 'error';
}

export interface LabState {
  wsStatus: 'idle' | 'connecting' | 'open' | 'closed';
  booting: boolean;
  session: SessionInfo | null;
  activeFrame: Frame | null;
  /** 最近一次断点变更后的列表（来自会话方法返回值） */
  breakpoints: Breakpoint[];
  /** 有命令在途或正在采集；期间保留上一帧 */
  pending: boolean;
  busyLabel: string | null;
  lastError: { code?: string; message: string; detail?: unknown } | null;
  notices: Notice[];
  /** 物理/虚拟两个独立内存视图（T08 分屏要求） */
  memoryViews: { physical: MemoryView; linear: MemoryView };
  capturedAt: string | null;
  /** T08：帧列表（时间线）、课程目录、选中进程、盘面与页表查询结果 */
  frames: FrameSummary[];
  curriculum: Curriculum | null;
  selectedPid: number | null;
  fileSystem: {
    path: string;
    depth: number;
    status: 'idle' | 'loading' | 'ok' | 'error';
    result: FileSystemView | null;
    error: string | null;
  };
  pageWalk: {
    address: string;
    status: 'idle' | 'loading' | 'ok' | 'error';
    result: PageWalkResult | null;
    error: string | null;
  };
  events: EventsResult | null;
  eventsLoading: boolean;
  eventsEnabled: boolean | null;
  /** T09：live/recorded、viewFrameId 与播放状态 */
  replay: ReplayState;
  /** 导入的录制包，用于独立只读回放 */
  recordingId: string | null;
  recordingSha256: string | null;
}

type Listener = () => void;

function initialMemoryView(addressSpace: 'physical' | 'linear'): MemoryView {
  return {
    requestedAddress: '',
    addressSpace,
    length: 256,
    status: 'idle',
    result: null,
    error: null,
  };
}

function initialState(): LabState {
  return {
    wsStatus: 'idle',
    booting: false,
    session: null,
    activeFrame: null,
    breakpoints: [],
    pending: false,
    busyLabel: null,
    lastError: null,
    notices: [],
    memoryViews: {
      physical: initialMemoryView('physical'),
      linear: initialMemoryView('linear'),
    },
    capturedAt: null,
    frames: [],
    curriculum: null,
    selectedPid: null,
    fileSystem: { path: '/data', depth: 1, status: 'idle', result: null, error: null },
    pageWalk: { address: '', status: 'idle', result: null, error: null },
    events: null,
    eventsLoading: false,
    eventsEnabled: null,
    replay: { mode: 'live', viewFrameId: null, playing: false, speed: 1 },
    recordingId: null,
    recordingSha256: null,
  };
}

export class LabStore {
  #state: LabState = initialState();
  #listeners = new Set<Listener>();
  #terminalListeners = new Set<(text: string) => void>();
  #terminalText = '';
  #socket: WebSocket | null = null;
  #requestCounter = 0;
  #frameCache = new Map<number, Frame>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #playTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  /* ---------- 订阅 ---------- */

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): LabState => this.#state;

  subscribeTerminal = (listener: (text: string) => void): (() => void) => {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  };

  getTerminalText = (): string => this.#terminalText;

  #patch(partial: Partial<LabState>): void {
    this.#state = { ...this.#state, ...partial };
    for (const listener of this.#listeners) listener();
  }

  #notice(text: string, level: Notice['level'] = 'info'): void {
    const notice: Notice = { at: new Date().toISOString(), text, level };
    this.#patch({ notices: [notice, ...this.#state.notices].slice(0, 60) });
  }

  #appendTerminal(text: string): void {
    this.#terminalText += text;
    // 终端缓冲区上限与服务端保持一致（256 KiB）
    const LIMIT = 256 * 1024;
    if (this.#terminalText.length > LIMIT) {
      this.#terminalText = this.#terminalText.slice(-LIMIT);
    }
    for (const listener of this.#terminalListeners) listener(this.#terminalText);
  }

  /* ---------- 会话生命周期 ---------- */

  async openSession(profile: string): Promise<void> {
    if (this.#state.session) await this.closeSession().catch(() => {});
    this.#patch({ booting: true, lastError: null, pending: true, busyLabel: '正在启动真实 QEMU 会话并加载符号' });
    try {
      const created = await api.createSession(profile);
      const { firstFrame, ...session } = created;
      this.#frameCache.clear();
      this.#terminalText = '';
      this.#patch({
        session,
        capturedAt: null,
        notices: [],
        frames: [],
        curriculum: null,
        selectedPid: null,
        recordingId: null,
        recordingSha256: null,
        memoryViews: {
          physical: initialMemoryView('physical'),
          linear: initialMemoryView('linear'),
        },
        replay: { mode: 'live', viewFrameId: null, playing: false, speed: 1 },
      });
      if (firstFrame) this.applyFrame(firstFrame);
      await this.#loadTerminal(session.id);
      this.#connectStream(session.id);
      await Promise.all([
        this.refreshFrames(),
        this.loadCurriculum(),
      ]).catch(() => {});
    } catch (error) {
      const apiError = error as ApiError;
      this.#patch({ lastError: { code: apiError.code, message: apiError.message } });
      throw error;
    } finally {
      this.#patch({ booting: false, pending: false, busyLabel: null });
    }
  }

  async closeSession(): Promise<void> {
    const session = this.#state.session;
    this.#teardownStream();
    if (!session) return;
    if (this.#state.recordingId === null) {
      await api.destroySession(session.id).catch(() => {});
    }
    this.#stopPlayback();
    this.#frameCache.clear();
    this.#patch({ ...initialState() });
  }

  async refreshSession(): Promise<SessionInfo | null> {
    const session = this.#state.session;
    if (!session) return null;
    const fresh = await api.getSession(session.id);
    const current = this.#state.session;
    // latestFrameId 取已应用帧与响应帧的最大值，保持实时水位单调递增。
    const latestFrameId = Math.max(current?.latestFrameId ?? 0, fresh.latestFrameId ?? 0);
    const merged: SessionInfo = { ...fresh, latestFrameId };
    this.#patch({ session: merged, capturedAt: current?.epoch === fresh.epoch ? this.#state.capturedAt : null });
    return merged;
  }

  async #loadTerminal(id: string): Promise<void> {
    try {
      const snapshot = await api.getTerminal(id);
      if (snapshot.text && this.#terminalText.length === 0) this.#appendTerminal(snapshot.text);
    } catch {
      // 终端快照失败时继续初始化会话，由实时通道接收后续输出。
    }
  }

  /* ---------- WS ---------- */

  #connectStream(id: string): void {
    this.#teardownStream();
    this.#patch({ wsStatus: 'connecting' });
    const url = new URL(`/api/sessions/${id}/stream`, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.onopen = () => {
      this.#patch({ wsStatus: 'open' });
      socket.send(
        JSON.stringify({ type: 'resync', lastConfirmedFrameId: this.#state.session?.latestFrameId ?? null }),
      );
    };

    socket.onmessage = (event) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.#handleStreamMessage(payload);
    };

    socket.onerror = () => this.#notice('实时通道发生错误，正在尝试恢复', 'warn');

    socket.onclose = () => {
      this.#patch({ wsStatus: 'closed' });
      if (this.#disposed || !this.#state.session) return;
      this.#reconnectTimer = setTimeout(() => {
        if (this.#state.session) this.#connectStream(this.#state.session.id);
      }, 1200);
    };
  }

  #teardownStream(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#socket) {
      this.#socket.onclose = null;
      this.#socket.onmessage = null;
      this.#socket.onerror = null;
      this.#socket.onopen = null;
      try {
        this.#socket.close();
      } catch {
        // 忽略重复关闭
      }
      this.#socket = null;
    }
    this.#patch({ wsStatus: 'idle' });
  }

  #handleStreamMessage(payload: Record<string, unknown>): void {
    const type = payload.type;
    if (type === 'terminal.output') {
      if (typeof payload.text === 'string') this.#appendTerminal(payload.text);
      return;
    }
    if (type === 'session.state') {
      const session = this.#state.session;
      if (!session) return;
      const state = typeof payload.state === 'string' ? payload.state : session.state;
      const epoch = typeof payload.epoch === 'number' ? payload.epoch : session.epoch;
      this.#patch({ session: { ...session, state, epoch } });
      return;
    }
    if (type === 'frame.committed') {
      const attribution = payload.attribution as { frameId?: number; epoch?: number } | undefined;
      const frameId = attribution?.frameId;
      if (typeof frameId !== 'number') return;
      this.#patchLiveFrameId(frameId);
      void this.#ensureFrame(frameId);
      return;
    }
    if (type === 'capture.failed') {
      const message = typeof payload.message === 'string' ? payload.message : '采集失败';
      this.#patch({ lastError: { message } });
      this.#notice(`采集失败：${message}（显示的是上一个完整帧）`, 'error');
      return;
    }
    if (type === 'error') {
      const error = payload.error as { code?: string; message?: string } | undefined;
      this.#notice(`通道错误：${error?.message ?? '未知'}`, 'warn');
    }
  }

  #patchLiveFrameId(frameId: number): void {
    const session = this.#state.session;
    if (!session) return;
    if (frameId <= (session.latestFrameId ?? 0)) return;
    this.#patch({
      session: {
        ...session,
        latestFrameId: frameId,
        frameCount: Math.max(session.frameCount, frameId + 1),
      },
    });
  }

  async #ensureFrame(frameId: number): Promise<void> {
    if (this.#frameCache.has(frameId)) {
      this.applyFrame(this.#frameCache.get(frameId) as Frame);
      return;
    }
    const session = this.#state.session;
    if (!session) return;
    try {
      const frame = await api.getFrame(session.id, frameId, session.epoch);
      this.applyFrame(frame);
    } catch (error) {
      this.#notice(`拉取帧 ${frameId} 失败：${(error as Error).message}`, 'warn');
    }
  }

  /* ---------- 帧应用（唯一入口） ---------- */

  applyFrame(frame: Frame): void {
    const session = this.#state.session;
    if (session && !this.#state.recordingId && frame.sessionId !== session.id) return;
    if (session && !this.#state.recordingId && frame.epoch !== session.epoch) return;

    this.#frameCache.set(frame.frameId, frame);
    this.#patchLiveFrameId(frame.frameId);

    // 回看模式保留选中帧，只更新实时水位与时间线。
    if (this.#state.replay.mode === 'recorded') {
      this.#mergeFrameSummary(frame);
      return;
    }

    const current = this.#state.activeFrame;
    if (current && current.epoch === frame.epoch && frame.frameId < current.frameId) return;

    this.#patch({ activeFrame: frame, capturedAt: frame.committedAt });
    this.#mergeFrameSummary(frame);
  }

  #summaryOf(frame: Frame): FrameSummary {
    return {
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
    };
  }

  #mergeFrameSummary(frame: Frame): void {
    const summary = this.#summaryOf(frame);
    const frames = this.#state.frames.filter((entry) => entry.frameId !== frame.frameId);
    frames.push(summary);
    frames.sort((a, b) => a.frameId - b.frameId);
    this.#patch({ frames });
  }

  /* ---------- T08/T09：帧列表、课程、回看、详情 ---------- */

  async refreshFrames(): Promise<FrameList | null> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return null;
    const list = await api.getFrames(session.id);
    this.#patch({
      frames: list.frames,
      session: {
        ...session,
        latestFrameId: list.liveFrameId,
        frameCount: list.frames.length,
        mode: list.mode,
        viewFrameId: list.viewFrameId,
      },
    });
    return list;
  }

  async loadCurriculum(): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    try {
      this.#patch({ curriculum: await api.getCurriculum(session.id) });
    } catch (error) {
      this.#notice(`课程目录加载失败：${(error as Error).message}`, 'warn');
    }
  }

  #frameSummaryIndex(frameId: number): number {
    return this.#state.frames.findIndex((entry) => entry.frameId === frameId);
  }

  async viewFrame(frameId: number): Promise<void> {
    await this.viewFrameById(frameId);
  }

  async viewFrameById(frameId: number): Promise<void> {
    const recordingId = this.#state.recordingId;
    const session = this.#state.session;
    try {
      const frame = recordingId
        ? await api.getRecordingFrame(recordingId, frameId)
        : session
          ? (this.#frameCache.get(frameId) ?? (await api.getFrame(session.id, frameId, session.epoch)))
          : null;
      if (!frame) return;
      this.#frameCache.set(frame.frameId, frame);
      this.#patch({
        activeFrame: frame,
        capturedAt: frame.committedAt,
        replay: { ...this.#state.replay, viewFrameId: frame.frameId, mode: 'recorded' },
      });
    } catch (error) {
      this.#notice(`读取帧 ${frameId} 失败：${(error as Error).message}`, 'warn');
    }
  }

  /** 进入回看：先在服务端暂停并切到 recorded，历史帧只读。 */
  async enterReplay(targetFrameId?: number): Promise<void> {
    const session = this.#state.session;
    if (!session) return;
    if (!this.#state.recordingId) {
      if (session.state === 'running') await this.pause().catch(() => {});
      const frameId = targetFrameId ?? this.#state.activeFrame?.frameId ?? session.latestFrameId ?? 0;
      await this.#sendCommand({ type: 'view', mode: 'recorded', targetFrameId: frameId }, '进入历史回看');
      this.#patch({ session: { ...this.#state.session!, mode: 'recorded', viewFrameId: frameId } });
      await this.refreshFrames().catch(() => {});
      await this.viewFrameById(frameId);
    } else {
      const frameId = targetFrameId ?? this.#state.frames[0]?.frameId ?? 0;
      await this.viewFrameById(frameId);
    }
    this.#patch({ replay: { ...this.#state.replay, mode: 'recorded', playing: false } });
  }

  /** 返回最新位置：服务端恢复 live，虚拟机保持当前停止点，等待执行命令。 */
  async exitReplay(): Promise<void> {
    this.#stopPlayback();
    if (!this.#state.recordingId) {
      await this.#sendCommand({ type: 'view', mode: 'live' }, '返回最新位置');
      const session = this.#state.session;
      const latest = session?.latestFrameId ?? 0;
      this.#patch({ session: { ...this.#state.session!, mode: 'live', viewFrameId: latest } });
      await this.refreshFrames().catch(() => {});
      const frame = this.#frameCache.get(latest) ?? (session ? await api.getFrame(session.id, latest, session.epoch).catch(() => null) : null);
      if (frame) this.#patch({ activeFrame: frame });
    }
    this.#patch({ replay: { ...this.#state.replay, mode: 'live', playing: false, viewFrameId: null } });
  }

  async stepView(delta: number): Promise<void> {
    const frames = this.#state.frames;
    if (frames.length === 0) return;
    const currentId = this.#state.activeFrame?.frameId ?? frames[0].frameId;
    const index = this.#frameSummaryIndex(currentId);
    const next = Math.min(Math.max((index < 0 ? 0 : index) + delta, 0), frames.length - 1);
    await this.viewFrameById(frames[next].frameId);
  }

  playReplay(): void {
    this.#stopPlayback();
    this.#patch({ replay: { ...this.#state.replay, playing: true } });
    const tick = () => {
      const frames = this.#state.frames;
      const currentId = this.#state.activeFrame?.frameId ?? -1;
      const index = this.#frameSummaryIndex(currentId);
      if (index < 0 || index >= frames.length - 1) {
        this.#stopPlayback();
        return;
      }
      void this.viewFrameById(frames[index + 1].frameId);
    };
    this.#playTimer = setInterval(tick, Math.max(120, 1200 / Math.max(0.25, this.#state.replay.speed)));
  }

  pauseReplay(): void {
    this.#stopPlayback();
  }

  setReplaySpeed(speed: number): void {
    this.#patch({ replay: { ...this.#state.replay, speed } });
    if (this.#state.replay.playing) this.playReplay();
  }

  #stopPlayback(): void {
    if (this.#playTimer !== null) {
      clearInterval(this.#playTimer);
      this.#playTimer = null;
    }
    if (this.#state.replay.playing) this.#patch({ replay: { ...this.#state.replay, playing: false } });
  }

  async selectProcess(pid: number): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    const result = await api.selectProcess(session.id, pid);
    this.#patch({ selectedPid: pid });
    const frame = this.#state.activeFrame;
    if (frame && result.os) {
      // 同一 captureId 下重新解析并替换 os 视图，保留帧号、采集 ID 和证据。
      const next = { ...frame, os: result.os as typeof frame.os };
      this.#frameCache.set(frame.frameId, next);
      this.#patch({ activeFrame: next });
      this.#notice(`pid=${pid} 的 mm/文件已按 capture ${frame.captureId} 重新解析`);
    } else {
      this.#notice(`已选中 pid=${pid}；下一次采集会解析它的 mm 与打开文件（仅切换详情读取对象）`);
    }
  }

  async loadFileSystem(path: string, depth = this.#state.fileSystem.depth): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    this.#patch({ fileSystem: { ...this.#state.fileSystem, path, depth, status: 'loading', error: null } });
    try {
      const result = await api.getFileSystem(
        session.id,
        path,
        depth,
        this.#state.activeFrame?.frameId ?? null,
      );
      this.#patch({ fileSystem: { ...this.#state.fileSystem, path, depth, status: 'ok', result, error: null } });
    } catch (error) {
      this.#patch({
        fileSystem: { ...this.#state.fileSystem, path, depth, status: 'error', result: null, error: (error as Error).message },
      });
    }
  }

  async translate(address: string): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    this.#patch({ pageWalk: { ...this.#state.pageWalk, address, status: 'loading', error: null } });
    try {
      const response = await api.translate(session.id, address, this.#state.activeFrame?.captureId ?? null);
      this.#patch({
        pageWalk: { ...this.#state.pageWalk, address, status: 'ok', result: response.translation, error: null },
      });
    } catch (error) {
      this.#patch({
        pageWalk: { ...this.#state.pageWalk, address, status: 'error', result: null, error: (error as Error).message },
      });
    }
  }

  /** VM 停止时切换观察者事件开关；成功后更新状态，失败时原样提示错误。 */
  async setEventsEnabled(enabled: boolean): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    try {
      const result = await api.switchEvents(session.id, { epoch: session.epoch, enable: enabled });
      this.#patch({ eventsEnabled: enabled });
      const note = typeof result?.note === 'string' ? result.note : null;
      this.#notice(`事件采集已${enabled ? '开启' : '关闭'}${note ? `：${note}` : ''}`, 'info');
      if (enabled) await this.loadEvents('observer');
    } catch (error) {
      this.#patch({ eventsEnabled: null });
      this.#notice(`切换事件采集失败：${(error as Error).message}`, 'warn');
    }
  }

  async loadEvents(source: 'observer' | 'service' = 'observer'): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    this.#patch({ eventsLoading: true });
    try {
      const result = (await api.getEvents(session.id, {
        epoch: session.epoch,
        limit: 400,
        source,
      })) as unknown as EventsResult;
      this.#patch({ events: result, eventsLoading: false });
    } catch (error) {
      this.#patch({ eventsLoading: false });
      this.#notice(`事件读取失败：${(error as Error).message}`, 'warn');
    }
  }

  /* ---------- T09：录制包导入/导出 ---------- */

  async exportRecording(): Promise<void> {
    const session = this.#state.session;
    if (!session || this.#state.recordingId) return;
    const exported = await api.exportRecording(session.id);
    const blob = new Blob([exported.text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `linux-lab-${session.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.#notice(`已导出 ${exported.text.length} 字节，SHA-256=${exported.sha256}`, 'info');
  }

  async importRecording(text: string, expectedSha256?: string): Promise<void> {
    const imported = await api.importRecording(text, expectedSha256);
    const meta = await fetch(`/api/recordings/${imported.id}`).then((response) => response.json());
    const frames: FrameSummary[] = (meta.frames ?? []).map((frame: Record<string, unknown>) => ({
      frameId: Number(frame.frameId),
      parentFrameId: null,
      reason: String(frame.reason ?? 'recorded'),
      pc: (frame.pc as string) ?? null,
      cpuId: 0,
      source: (frame.source as string) ?? null,
      module: (frame.module as string) ?? null,
      line: (frame.line as number) ?? null,
      lessonId: (frame.lessonId as string) ?? null,
      lessonTitle: (frame.lessonTitle as string) ?? null,
      memoryCoverage: 'recorded',
      eventsCoverage: 'filtered',
      committedAt: String(frame.committedAt ?? ''),
    }));
    const pseudo: SessionInfo = {
      id: imported.id,
      profile: 'recording',
      state: 'stopped',
      epoch: 1,
      frameCount: frames.length,
      latestFrameId: frames.at(-1)?.frameId ?? null,
      mode: 'recorded',
      viewFrameId: frames[0]?.frameId ?? 0,
      breakpoints: [],
      terminalBytes: 0,
      qmpVersion: null,
      capabilities: null,
      symbols: [],
      symbolPlan: null,
    };
    this.#teardownStream();
    this.#frameCache.clear();
    this.#patch({
      session: pseudo,
      recordingId: imported.id,
      recordingSha256: imported.sha256,
      frames,
      activeFrame: null,
      replay: { mode: 'recorded', viewFrameId: null, playing: false, speed: 1 },
      notices: [{ at: new Date().toISOString(), text: `已导入录制包 ${imported.id}（${imported.frameCount} 帧，SHA-256=${imported.sha256}）`, level: 'info' }],
    });
    if (frames.length > 0) await this.viewFrameById(frames[0].frameId);
  }

  /* ---------- 命令 ---------- */

  #nextRequestId(prefix: string): string {
    this.#requestCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.#requestCounter}`;
  }

  async #sendCommand(payload: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
    const session = this.#state.session;
    if (!session) throw new ApiError(400, 'invalid-request', '没有活动会话');
    if (this.#state.recordingId) {
      throw new ApiError(400, 'history-read-only', '导入的录制包是只读回放，不能执行控制命令');
    }
    const requestId = this.#nextRequestId(String(payload.type));
    this.#patch({ pending: true, busyLabel: label, lastError: null });

    try {
      let lastError: ApiError | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const target = this.#state.session ?? session;
        try {
          const result = await api.sendCommand(target.id, {
            ...payload,
            requestId,
            epoch: target.epoch,
            expectedFrameId: target.latestFrameId ?? 0,
          });
          const frame = result.frame as Frame | undefined;
          if (frame) this.applyFrame(frame);
          const breakpoints = result.breakpoints as Breakpoint[] | undefined;
          if (Array.isArray(breakpoints)) this.#patch({ breakpoints });
          this.#patch({ lastError: null });
          return result;
        } catch (error) {
          lastError = error as ApiError;
          // 视图过期通常由自动采集引起：同步最新水位后按同一 requestId 重试一次
          if (lastError.code === 'frame-mismatch' && attempt === 0) {
            await this.refreshSession().catch(() => {});
            continue;
          }
          break;
        }
      }

      const error = lastError as ApiError;
      this.#patch({
        lastError: { code: error.code, message: error.message, detail: error.detail },
      });
      if (error.code === 'stale-epoch') {
        await this.refreshSession().catch(() => {});
      }
      throw error;
    } finally {
      this.#patch({ pending: false, busyLabel: null });
    }
  }

  step(granularity: 'instruction' | 'source-into' | 'source-over' = 'instruction') {
    return this.#sendCommand({ type: 'step', granularity, count: 1 }, '单步');
  }

  continueRun() {
    return this.#sendCommand({ type: 'continue' }, '继续运行');
  }

  pause() {
    return this.#sendCommand({ type: 'pause' }, '暂停');
  }

  /** T10a：full-boot 下自动装载 setup/解压器符号并停在 L02–L04。 */
  calibrateBoot() {
    return this.#sendCommand({ type: 'boot.calibrate', timeoutMs: 120000 }, '校准启动阶段（L02–L04）');
  }

  runTo(location: Record<string, unknown>) {
    return this.#sendCommand({ type: 'run-to', location, timeoutMs: 240000 }, '运行到断点');
  }

  insertBreakpoint(location: Record<string, unknown>, kind = 'hardware') {
    return this.#sendCommand({ type: 'breakpoint.insert', kind, location }, '设置断点');
  }

  removeBreakpoint(breakpointId: number) {
    return this.#sendCommand({ type: 'breakpoint.remove', breakpointId }, '删除断点');
  }

  sendTerminal(text: string) {
    return this.#sendCommand({ type: 'terminal.input', device: 'serial', text }, '发送终端输入');
  }

  keyboard(key: string, action: 'down' | 'up' | 'press' = 'press') {
    return this.#sendCommand({ type: 'keyboard', key, action }, '注入键盘事件');
  }

  /* ---------- 内存面板 ---------- */

  async readMemory(address: string, length: number, addressSpace: 'physical' | 'linear'): Promise<void> {
    const session = this.#state.session;
    if (!session) return;
    const current = this.#state.memoryViews[addressSpace];
    this.#patch({
      memoryViews: {
        ...this.#state.memoryViews,
        [addressSpace]: { ...current, requestedAddress: address, length, status: 'loading', error: null },
      },
    });
    try {
      const result = await api.readMemory(session.id, addressSpace, address, length);
      this.#patch({
        memoryViews: {
          ...this.#state.memoryViews,
          [addressSpace]: { ...this.#state.memoryViews[addressSpace], status: 'ok', result, error: null },
        },
      });
    } catch (error) {
      const apiError = error as ApiError;
      this.#patch({
        memoryViews: {
          ...this.#state.memoryViews,
          [addressSpace]: {
            ...this.#state.memoryViews[addressSpace],
            status: 'error',
            result: null,
            error: { code: apiError.code, message: apiError.message },
          },
        },
      });
    }
  }

  setMemoryQuery(
    addressSpace: 'physical' | 'linear',
    patch: Partial<Pick<MemoryView, 'requestedAddress' | 'length'>>,
  ): void {
    const current = this.#state.memoryViews[addressSpace];
    this.#patch({
      memoryViews: {
        ...this.#state.memoryViews,
        [addressSpace]: { ...current, ...patch },
      },
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#teardownStream();
  }
}

export const store = new LabStore();
