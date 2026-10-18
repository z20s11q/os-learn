import { useEffect, useRef } from 'react';
import { store } from '../store';
import { shallowEqual, useLabSelector } from '../hooks';

/** 底部时间线（T08/T09）：停止帧、断点/异常、回看播放与覆盖范围。 */
export function Timeline({ pending }: { pending: boolean }) {
  const state = useLabSelector(
    (snapshot) => ({
      frames: snapshot.frames,
      activeFrame: snapshot.activeFrame,
      latestFrameId: snapshot.session?.latestFrameId ?? null,
      replay: snapshot.replay,
      recordingId: snapshot.recordingId,
    }),
    shallowEqual,
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const frames = state.frames;
  const activeId = state.activeFrame?.frameId ?? null;
  const liveId = state.latestFrameId;
  const replay = state.replay;

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    if (active instanceof HTMLElement) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeId]);

  const atFirst = frames.length === 0 || activeId === frames[0]?.frameId;
  const atLast = frames.length === 0 || activeId === frames[frames.length - 1]?.frameId;

  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline-controls">
        {replay.mode === 'recorded' ? (
          <>
            <button className="small" disabled={atFirst} onClick={() => store.stepView(-1)}>← 上一帧</button>
            <button className="small" disabled={atLast} onClick={() => store.stepView(1)}>下一帧 →</button>
            <button className="small" onClick={() => (replay.playing ? store.pauseReplay() : store.playReplay())} disabled={frames.length < 2}>
              {replay.playing ? '暂停播放' : '播放'}
            </button>
            <select
              className="mono"
              value={replay.speed}
              onChange={(event) => store.setReplaySpeed(Number(event.target.value))}
              style={{ width: 64 }}
            >
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
            </select>
            <button className="primary small" onClick={() => store.exitReplay().catch(() => {})}>返回最新位置</button>
            {state.recordingId ? <span className="badge warn">导入录制包 · 只读</span> : null}
          </>
        ) : (
          <>
            <button
              className="small"
              data-testid="enter-replay"
              disabled={frames.length === 0 || pending}
              onClick={() => store.enterReplay().catch(() => {})}
            >
              进入回看
            </button>
            <span className="muted" style={{ fontSize: 11 }}>回看会先暂停 VM；历史帧只读，返回最新后才可继续执行</span>
          </>
        )}
      </div>

      <div className="timeline-track" ref={listRef}>
        {frames.length === 0 ? (
          <span className="muted">当前已提交帧为 0 帧。</span>
        ) : (
          frames.map((frame) => (
            <button
              key={frame.frameId}
              data-active={frame.frameId === activeId}
              data-live={frame.frameId === liveId}
              className={[
                'frame-chip',
                frame.frameId === activeId ? 'active' : '',
                frame.frameId === liveId ? 'live' : '',
                frame.reason === 'breakpoint' ? 'breakpoint' : '',
                frame.reason === 'signal' || frame.reason === 'exited' ? 'error' : '',
              ].join(' ')}
              title={`${frame.reason} · ${frame.pc ?? 'PC 未采集'} · ${frame.lessonTitle ?? '教学点未绑定'}${frame.captureMs != null ? ` · 采集 ${frame.captureMs}ms` : ''}\n点击进入回看并显示该帧`}
              onClick={() => {
                if (replay.mode === 'live') store.enterReplay(frame.frameId).catch(() => {});
                else store.viewFrameById(frame.frameId).catch(() => {});
              }}
            >
              <span className="frame-id">#{frame.frameId}</span>
              <span className="frame-reason">{reasonText(frame.reason)}</span>
              <span className="frame-pc mono">{frame.pc ?? '—'}</span>
              {frame.lessonId ? <span className="frame-lesson">{frame.lessonId}</span> : null}
            </button>
          ))
        )}
      </div>

      <div className="timeline-meta">
        <span>帧 {activeId ?? '—'} / 最新 {liveId ?? '—'}</span>
        <span>覆盖 {state.activeFrame?.coverage.memory ?? '—'} · {state.activeFrame?.coverage.events ?? '—'}</span>
        {replay.mode === 'recorded' ? <span className="badge warn">回看模式（VM 保持停止）</span> : <span className="badge ok">实时模式</span>}
      </div>
    </div>
  );
}

function reasonText(reason: string): string {
  const map: Record<string, string> = {
    reset: '复位',
    step: '单步',
    breakpoint: '断点',
    pause: '暂停',
    signal: '信号',
    exited: '退出',
    unknown: '未知',
  };
  return map[reason] ?? reason;
}
