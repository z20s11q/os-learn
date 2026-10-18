import { useRef, useState } from 'react';
import { store } from '../store';
import { shallowEqual, useLabSelector } from '../hooks';
import { timeOf } from '../format';

const STATE_TEXT: Record<string, string> = {
  created: '已创建',
  starting: '启动中',
  stopped: '已暂停',
  running: '运行中',
  capturing: '采集中',
  closed: '已关闭',
  error: '错误',
};

/**
 * 顶栏（T04/T08/T09）：会话、执行控制、课程跳转、录制导入导出与状态。
 */
export function ControlBar() {
  const state = useLabSelector(
    (snapshot) => ({
      session: snapshot.session,
      activeFrame: snapshot.activeFrame,
      pending: snapshot.pending,
      booting: snapshot.booting,
      wsStatus: snapshot.wsStatus,
      capturedAt: snapshot.capturedAt,
      curriculum: snapshot.curriculum,
      replayMode: snapshot.replay.mode,
      recordingId: snapshot.recordingId,
    }),
    shallowEqual,
  );
  const [profile, setProfile] = useState<'kernel-fast' | 'full-boot'>('kernel-fast');
  const [breakSymbol, setBreakSymbol] = useState('start_kernel');
  const [breakModule, setBreakModule] = useState('linux-kernel');
  const [lessonId, setLessonId] = useState('');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const session = state.session;
  const frame = state.activeFrame;
  const running = session?.state === 'running';
  const paused = session?.state === 'stopped';
  const hasSession = session !== null;
  const replaying = state.replayMode === 'recorded';
  const recording = state.recordingId !== null;

  const guard = (task: () => Promise<unknown>) => {
    task().catch(() => {
      // 错误已进入 store.lastError，由状态栏统一展示
    });
  };

  const lesson = (state.curriculum?.lessons ?? []).find((entry) => entry.id === lessonId) ?? null;
  const trigger = (lesson?.trigger ?? {}) as {
    symbol?: string | string[];
    address?: string;
    module?: string;
  };
  const lessonSymbol = Array.isArray(trigger.symbol) ? trigger.symbol[0] : trigger.symbol;

  const importFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      await store.importRecording(text);
      setImportMessage(`已导入 ${file.name}（${file.size} 字节）`);
    } catch (error) {
      setImportMessage(`导入失败：${(error as Error).message}`);
    }
  };

  return (
    <div className="topbar">
      <h1>Linux Observatory</h1>
      <a className="top-link" href="/media/player.html" target="_blank" rel="noopener">▶ 启动动画</a>
      <a className="top-link" href="/animation/boot.html" target="_blank" rel="noopener">启动演示</a>

      {!hasSession ? (
        <label className="field">
          启动模式
          <select
            className="mono"
            value={profile}
            disabled={state.booting}
            onChange={(event) => setProfile(event.target.value as 'kernel-fast' | 'full-boot')}
          >
            <option value="kernel-fast">kernel-fast（-kernel 直启）</option>
            <option value="full-boot">full-boot（GRUB 光盘）</option>
          </select>
        </label>
      ) : null}

      {!hasSession ? (
        <button className="primary" disabled={state.booting} onClick={() => guard(() => store.openSession(profile))}>
          {state.booting ? '启动中…' : '启动真实会话'}
        </button>
      ) : recording ? null : (
        <>
          <button
            disabled={state.pending || running || replaying || recording}
            onClick={() => guard(() => store.step('instruction'))}
            title="GDB -exec-step-instruction"
          >
            单步
          </button>
          <button
            disabled={state.pending || running || replaying || recording}
            onClick={() => guard(() => store.step('source-over'))}
          >
            源码步过
          </button>
          <button
            className="primary"
            disabled={state.pending || running || replaying || recording}
            onClick={() => guard(() => store.continueRun())}
          >
            继续
          </button>
          <button disabled={state.pending || !running || recording} onClick={() => guard(() => store.pause())}>
            暂停
          </button>

          <label className="field">
            模块
            <input
              className="mono"
              style={{ width: 120 }}
              value={breakModule}
              onChange={(event) => setBreakModule(event.target.value)}
              disabled={replaying || recording}
            />
          </label>
          <label className="field">
            符号
            <input
              className="mono"
              style={{ width: 145 }}
              value={breakSymbol}
              onChange={(event) => setBreakSymbol(event.target.value)}
              disabled={replaying || recording}
            />
          </label>
          <button
            disabled={state.pending || replaying || recording}
            onClick={() =>
              guard(() =>
                store.runTo({
                  symbol: breakSymbol,
                  ...(breakModule.trim() ? { module: breakModule.trim() } : {}),
                }),
              )
            }
          >
            运行到符号
          </button>

          {session?.profile === 'full-boot' ? (
            <button
              className="small"
              disabled={state.pending || running || replaying || recording}
              title="装载 setup/解压器符号，停在 main / startup_32 / startup_64；只对 full-boot 有效"
              onClick={() => guard(() => store.calibrateBoot())}
            >
              校准启动 L02–L04
            </button>
          ) : null}

          <label className="field">
            课程
            <select
              className="mono"
              value={lessonId}
              disabled={replaying || recording}
              onChange={(event) => setLessonId(event.target.value)}
              style={{ maxWidth: 190 }}
            >
              <option value="">选择教学点…</option>
              {(state.curriculum?.lessons ?? []).map((entry) => (
                <option key={entry.id} value={entry.id} disabled={!entry.available}>
                  {entry.id} {entry.title}{entry.available ? '' : '（不可用）'}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={state.pending || replaying || recording || lesson === null || !lesson.available}
            title={lesson?.reason ?? '按课程声明的符号/地址运行，碰到用户断点或异常会先停止'}
            onClick={() => {
              if (!lesson) return;
              const location = trigger.address
                ? { address: trigger.address }
                : lessonSymbol
                  ? { symbol: lessonSymbol, ...(trigger.module ? { module: trigger.module } : {}) }
                  : null;
              if (location) guard(() => store.runTo(location));
            }}
          >
            运行到该课
          </button>

          <button className="small" disabled={recording} onClick={() => guard(() => store.exportRecording())}>
            导出录制
          </button>
          <button className="danger" disabled={state.pending} onClick={() => guard(() => store.closeSession())}>
            关闭会话
          </button>
        </>
      )}

      {/* 导入录制入口始终挂载，支持从首页独立回放已保存的录制包。 */}
      <button className="small" onClick={() => fileRef.current?.click()}>
        导入录制
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => { void importFile(event.target.files?.[0] ?? null); event.target.value = ''; }}
      />
      {recording ? (
        <button className="danger" disabled={state.pending} onClick={() => guard(() => store.closeSession())}>
          关闭回放
        </button>
      ) : null}

      <span className="spacer" />

      <span className={'pill ' + (state.wsStatus === 'open' ? 'ok' : state.wsStatus === 'closed' ? 'warn' : '')} title="WebSocket 实时通道状态">
        <span className="dot" />
        {recording ? '录制包只读' : state.wsStatus === 'open' ? '实时通道已连接' : state.wsStatus === 'connecting' ? '连接中' : state.wsStatus === 'closed' ? '通道断开，重连中' : '未连接'}
      </span>

      {session ? (
        <>
          <span className={'pill ' + (running ? 'ok' : paused ? '' : 'warn')}>
            会话 <b data-testid="session-state">{recording ? '回放' : STATE_TEXT[session.state] ?? session.state}</b>
          </span>
          <span className="pill">epoch <b>{session.epoch}</b></span>
          <span className="pill">
            帧 <b data-testid="frame-id">{frame ? frame.frameId : '—'}</b>
            <span className="muted">/ 最新 {session.latestFrameId ?? '—'}</span>
          </span>
          <span className={'pill ' + (replaying ? 'warn' : 'ok')}>{replaying ? '历史回看' : '实时'}</span>
        </>
      ) : null}

      <span className="pill" title="最后采集时间（Frame committedAt）">采集于 <b>{timeOf(state.capturedAt)}</b></span>
      {state.curriculum ? <span className="pill">课程 <b>{state.curriculum.lessons.length}</b></span> : null}
      {importMessage && recording ? <span className="pill warn" title={importMessage}>{importMessage.slice(0, 36)}</span> : null}
    </div>
  );
}
