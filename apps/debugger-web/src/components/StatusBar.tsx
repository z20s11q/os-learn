import { useLab } from '../hooks';
import { timeOf } from '../format';
import { Panel } from './Panel';

/**
 * 状态栏（T04e）：当前是否暂停、最后采集时间、错误与通知。
 *
 * 展示值全部来自 store 的订阅。
 */
export function StatusBar() {
  const state = useLab();
  const session = state.session;
  const running = session?.state === 'running';
  const frame = state.activeFrame;

  return (
    <Panel
      title="运行状态与诊断"
      testId="panel-status"
      actions={
        <>
          <span className={'badge ' + (running ? 'observed' : '')}>{running ? '运行中' : '已暂停'}</span>
          <span className="badge">采集中：{state.pending ? '是' : '否'}</span>
          <span className="badge">最后采集 {timeOf(state.capturedAt)}</span>
          <span className="badge">帧 #{frame?.frameId ?? '—'}</span>
        </>
      }
      bodyStyle={{ maxHeight: 190 }}
    >
      {state.lastError ? (
        <p className="error-text" style={{ marginTop: 0 }}>
          最近错误（{state.lastError.code ?? 'error'}）：{state.lastError.message}
          {state.lastError.detail ? (
            <span className="mono"> {JSON.stringify(state.lastError.detail)}</span>
          ) : null}
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          当前错误记录为空。
        </p>
      )}

      <div className="notices">
        {state.notices.length === 0 ? (
          <span className="muted">当前通知列表为空。</span>
        ) : (
          state.notices.map((notice, index) => (
            <div key={`${notice.at}-${index}`} className={'notice ' + (notice.level === 'info' ? '' : notice.level)}>
              [{timeOf(notice.at)}] {notice.text}
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
