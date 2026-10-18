/**
 * HTTP 传输层（T04）。
 *
 * 负责请求与错误归一化；状态由 store.ts 管理，所有面板由同一个 Frame store 派生。
 */

import type {
  Curriculum,
  FileSystemView,
  Frame,
  FrameList,
  MemoryReadResult,
  PageWalkResult,
  RecordingSummary,
  SessionInfo,
} from './types';

export class ApiError extends Error {
  code: string;
  detail: unknown;
  status: number;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal',
      error?.message ?? `HTTP ${response.status}`,
      error?.detail,
    );
  }
  return payload as T;
}

export const api = {
  health: () => request<{ ok: boolean; service: string }>('GET', '/api/health'),

  createSession: (profile: string) =>
    request<SessionInfo & { firstFrame: Frame }>('POST', '/api/sessions', { profile }),

  getSession: (id: string) => request<SessionInfo>('GET', `/api/sessions/${id}`),

  destroySession: (id: string) =>
    request<{ closed: boolean }>('DELETE', `/api/sessions/${id}`),

  getCapabilities: (id: string) =>
    request<Record<string, unknown>>('GET', `/api/sessions/${id}/capabilities`),

  getSymbols: (id: string) =>
    request<{ stages: unknown[]; plan: unknown }>('GET', `/api/sessions/${id}/symbols`),

  getFrame: (id: string, frameId: number, epoch: number) =>
    request<Frame>('GET', `/api/sessions/${id}/frames/${frameId}?epoch=${epoch}`),

  getTerminal: (id: string) =>
    request<{ text: string; bytes: number; truncated: boolean }>('GET', `/api/sessions/${id}/terminal`),

  /**
   * 客体事件流（T05b）。source=observer 时返回 x-oslab-events 的原样结果
   * （seq/水位线/丢失由观察者判定），前端直接消费返回区间。
   */
  getEvents: (id: string, options: { epoch?: number; from?: string; to?: string; limit?: number; kinds?: string[]; source?: 'observer' | 'service' } = {}) => {
    const query = new URLSearchParams();
    if (options.epoch !== undefined) query.set('epoch', String(options.epoch));
    if (options.from !== undefined) query.set('from', options.from);
    if (options.to !== undefined) query.set('to', options.to);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.kinds && options.kinds.length > 0) query.set('kinds', options.kinds.join(','));
    if (options.source !== undefined) query.set('source', options.source);
    return request<{
      source: 'observer' | 'service';
      epoch: number;
      events: unknown[];
      truncated: boolean;
      dropped?: number;
      watermark?: string;
      oldest?: string;
      nextSeq?: string;
      unknownKinds?: string[];
      unavailable?: string[];
      note?: string;
    }>('GET', `/api/sessions/${id}/events?${query.toString()}`);
  },

  /** 事件采集开关：观察者只允许 VM 停止时切换，拒绝原因原样透出。 */
  switchEvents: (id: string, body: { epoch?: number; enable?: boolean; reset?: boolean }) =>
    request<Record<string, unknown>>('POST', `/api/sessions/${id}/events`, body),

  sendCommand: (id: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>('POST', `/api/sessions/${id}/commands`, body),

  readMemory: (id: string, addressSpace: 'physical' | 'linear', address: string, length: number) =>
    request<MemoryReadResult>(
      'GET',
      `/api/sessions/${id}/memory?addressSpace=${addressSpace}&address=${encodeURIComponent(address)}&length=${length}`,
    ),

  /* ---------- T08：课程、进程、盘面、页表 ---------- */

  getCurriculum: (id: string) => request<Curriculum>('GET', `/api/sessions/${id}/curriculum`),

  osStatus: (id: string) => request<Record<string, unknown>>('GET', `/api/sessions/${id}/os`),

  selectProcess: (id: string, pid: number) =>
    request<Record<string, unknown>>('POST', `/api/sessions/${id}/selection`, { pid }),

  getFileSystem: (id: string, path: string, depth = 1, frameId?: number | null) => {
    const query = new URLSearchParams({ path, depth: String(depth) });
    if (frameId !== undefined && frameId !== null) query.set('frameId', String(frameId));
    return request<FileSystemView>('GET', `/api/sessions/${id}/filesystem?${query.toString()}`);
  },

  getFrames: (id: string) => request<FrameList>('GET', `/api/sessions/${id}/frames`),

  translate: (id: string, address: string, captureId?: string | null) => {
    const query = new URLSearchParams({ mode: 'translate', address });
    if (captureId) query.set('captureId', captureId);
    return request<{
      schema: string;
      captureId: string;
      live: boolean;
      reader: string;
      paging: unknown;
      translation: PageWalkResult;
      stats: unknown;
    }>('GET', `/api/sessions/${id}/memory?${query.toString()}`);
  },

  /* ---------- T09：回放与录制 ---------- */

  exportRecording: async (id: string): Promise<{ text: string; sha256: string }> => {
    const response = await fetch(`/api/sessions/${id}/recording`);
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // 保留 HTTP 状态
      }
      throw new ApiError(response.status, 'recording-export', message);
    }
    return { text, sha256: response.headers.get('X-Content-SHA256') ?? '' };
  },

  importRecording: async (text: string, expectedSha256?: string): Promise<RecordingSummary> => {
    const response = await fetch('/api/recordings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(expectedSha256 ? { 'x-content-sha256': expectedSha256 } : {}),
      },
      body: text,
    });
    const payload = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(payload);
    } catch {
      parsed = payload;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; detail?: unknown } } | null)?.error;
      throw new ApiError(response.status, error?.code ?? 'recording-import', error?.message ?? `HTTP ${response.status}`, error?.detail);
    }
    return parsed as RecordingSummary;
  },

  listRecordings: () => request<RecordingSummary[]>('GET', '/api/recordings'),

  getRecordingFrame: (recordingId: string, frameId: number) =>
    request<Frame>('GET', `/api/recordings/${recordingId}/frames/${frameId}`),

  deleteRecording: (recordingId: string) =>
    request<{ deleted: boolean }>('DELETE', `/api/recordings/${recordingId}`),
};
