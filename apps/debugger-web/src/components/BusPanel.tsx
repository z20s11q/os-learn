import { useEffect, useState } from 'react';
import { store } from '../store';
import { shallowEqual, useLabSelector } from '../hooks';
import { Panel } from './Panel';

/** 总线/事件面板（T08）：显示真实事件序号、地址、宽度和阶段。 */
export function BusPanel({ pending, busyLabel }: { pending: boolean; busyLabel: string | null }) {
  const [filter, setFilter] = useState('');
  const state = useLabSelector(
    (snapshot) => ({
      events: snapshot.events,
      eventsLoading: snapshot.eventsLoading,
      eventsEnabled: snapshot.eventsEnabled,
      pending: snapshot.pending,
      recordingId: snapshot.recordingId,
    }),
    shallowEqual,
  );
  const events = state.events;
  const recording = state.recordingId !== null;

  useEffect(() => {
    if (events === null && !state.eventsLoading) store.loadEvents('observer').catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = (events?.events ?? []).filter((event) =>
    filter.trim().length === 0 || event.kind.includes(filter.trim()),
  ).slice(-240);

  return (
    <Panel
      title="总线与事件"
      testId="panel-bus"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className={'badge ' + (events?.source === 'observer' ? 'ok' : 'unavailable')}>
            {events?.source === 'observer' ? 'x-oslab-events' : '服务事件'}
          </span>
          <button
            className="small"
            disabled={state.pending || recording}
            title="事件采集默认关闭；只有停止状态下观察者才允许切换"
            onClick={() => store.setEventsEnabled(state.eventsEnabled !== true).catch(() => {})}
          >
            {state.eventsEnabled === true ? '关闭事件' : '开启事件'}
          </button>
          <button className="small" disabled={state.eventsLoading || recording} onClick={() => store.loadEvents('observer').catch(() => {})}>
            刷新
          </button>
        </>
      }
    >
      <div className="row">
        <input
          className="mono"
          style={{ flex: 1 }}
          placeholder="按 kind 过滤，例如 dma / block / io / irq"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="badge">{shown.length}</span>
      </div>
      {events?.note ? <p className="muted" style={{ fontSize: 11 }}>{events.note}</p> : null}
      {events ? (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="muted">水位线 {events.watermark ?? '—'}</span>
            <span className="spacer" />
            {events.dropped ? <span className="badge warn">丢失 {events.dropped}</span> : null}
            {events.truncated ? <span className="badge warn">截断</span> : null}
          </div>
          <div className="scroll-table" style={{ maxHeight: 420 }}>
            <table className="table">
              <thead><tr><th>seq</th><th>kind</th><th>phase</th><th>cpu/dev</th><th>地址空间</th><th>地址</th><th>长度</th><th>request</th></tr></thead>
              <tbody>
                {shown.map((event) => (
                  <tr key={`${event.seq}-${event.kind}`}>
                    <td className="mono">{event.seq}</td>
                    <td className="mono">{event.kind}</td>
                    <td>{event.phase ?? '—'}</td>
                    <td className="mono">{event.cpuId ?? event.deviceId ?? '—'}</td>
                    <td className="mono">{event.addressSpace ?? '—'}</td>
                    <td className="mono">{event.address ?? '—'}</td>
                    <td>{event.size ?? '—'}</td>
                    <td className="mono">{event.requestId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 ? (
            <p className="muted">当前筛选结果为 0 条。事件采集默认关闭，在停止状态下开启；客体活动需结合采集覆盖范围和事件来源判断。</p>
          ) : null}
        </>
      ) : (
        <p className="muted">事件流待加载；客体事件与服务编排事件按返回的 source 标注来源。</p>
      )}
    </Panel>
  );
}
