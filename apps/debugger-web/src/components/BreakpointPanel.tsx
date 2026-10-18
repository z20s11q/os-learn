import { useState } from 'react';
import { store } from '../store';
import { shallowEqual, useLabSelector } from '../hooks';
import type { SymbolCandidate } from '../types';
import { Panel } from './Panel';

/**
 * 断点面板（T04b）。
 *
 * 符号断点必须能限定模块：`startup_64` 在解压器与主内核中同名，
 * 服务端返回 ambiguous-symbol 时，前端列出候选供用户选择模块。
 */
export function BreakpointPanel({ pending, busyLabel }: { pending: boolean; busyLabel: string | null }) {
  const state = useLabSelector(
    (snapshot) => ({
      session: snapshot.session,
      breakpoints: snapshot.breakpoints,
      lastError: snapshot.lastError,
    }),
    shallowEqual,
  );
  const session = state.session;
  const [symbol, setSymbol] = useState('start_kernel');
  const [module, setModule] = useState('linux-kernel');
  const [kind, setKind] = useState<'hardware' | 'software'>('hardware');
  const breakpoints = state.breakpoints.length > 0 ? state.breakpoints : (session?.breakpoints ?? []);
  const candidates =
    state.lastError?.code === 'ambiguous-symbol'
      ? ((state.lastError.detail as { candidates?: SymbolCandidate[] } | undefined)?.candidates ?? [])
      : [];
  const breakpointError =
    state.lastError && (state.lastError.code === 'ambiguous-symbol' || state.lastError.code === 'target-unavailable')
      ? state.lastError
      : null;

  return (
    <Panel title="断点" testId="panel-breakpoints" pending={pending} busyLabel={busyLabel}>
      <div className="stack">
        <div className="row">
          <label className="field">
            符号
            <input
              className="mono"
              style={{ width: 150 }}
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            />
          </label>
          <label className="field">
            模块
            <input
              className="mono"
              style={{ width: 130 }}
              value={module}
              onChange={(event) => setModule(event.target.value)}
            />
          </label>
          <label className="field">
            类型
            <select className="mono" value={kind} onChange={(event) => setKind(event.target.value as 'hardware' | 'software')}>
              <option value="hardware">hardware</option>
              <option value="software">software</option>
            </select>
          </label>
          <button
            disabled={pending || !session}
            onClick={() =>
              store
                .insertBreakpoint(
                  { symbol, ...(module.trim() ? { module: module.trim() } : {}) },
                  kind,
                )
                .catch(() => {})
            }
          >
            插入断点
          </button>
        </div>

        {breakpointError ? (
          <div className="unavailable">
            {breakpointError.message}
            {candidates.length > 0 ? (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {candidates.map((candidate, index) => (
                  <li key={`${candidate.module}-${candidate.address}-${index}`}>
                    <button
                      className="small"
                      style={{ marginRight: 6 }}
                      onClick={() => setModule(candidate.module ?? '')}
                    >
                      选用
                    </button>
                    <span className="mono">{candidate.module ?? 'unknown'}</span>
                    {candidate.moduleLabel ? <span className="muted">（{candidate.moduleLabel}）</span> : null}
                    {candidate.address ? (
                      <>
                        {' '}
                        · 链接地址 <span className="mono">{candidate.address}</span>
                      </>
                    ) : null}
                    {candidate.loadAddress ? (
                      <>
                        {' '}
                        · 实测装载 <span className="mono">{candidate.loadAddress}</span>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <table className="kv">
          <tbody>
            {breakpoints.length === 0 ? (
              <tr>
                <td colSpan={2}>
                  <span className="muted">当前断点列表为空</span>
                </td>
              </tr>
            ) : (
              breakpoints.map((breakpoint) => (
                <tr key={`${breakpoint.id}-${breakpoint.spec}`}>
                  <td className="key">
                    #{breakpoint.id ?? '?'} · <span className="mono">{breakpoint.spec}</span>
                  </td>
                  <td className="val">
                    <span className="mono">{breakpoint.address ?? '地址待定'}</span> ·{' '}
                    {breakpoint.hardware ? '硬件' : '软件'} · 命中 {breakpoint.hitCount}
                    {breakpoint.pending ? ' · 未解析' : ''}
                    {breakpoint.id !== null ? (
                      <button
                        className="small"
                        style={{ marginLeft: 8 }}
                        disabled={pending}
                        onClick={() => store.removeBreakpoint(breakpoint.id as number).catch(() => {})}
                      >
                        删除
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
