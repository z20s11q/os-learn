import { useState } from 'react';
import type { Frame } from '../types';
import { store } from '../store';
import { useLabSelector } from '../hooks';
import { Panel } from './Panel';

/** 页表/地址翻译面板（T08）：用该帧 CR3 和绑定的页表字节翻译。 */
export function PageTablePanel({ frame, pending, busyLabel }: { frame: Frame; pending: boolean; busyLabel: string | null }) {
  const [address, setAddress] = useState(frame.stop.pc ?? frame.cpu.control.cr3 ?? '');
  const walk = useLabSelector((snapshot) => snapshot.pageWalk);
  const recording = useLabSelector((snapshot) => snapshot.recordingId) !== null;

  const run = () => {
    if (address.trim().length === 0) return;
    store.translate(address.trim()).catch(() => {});
  };

  return (
    <Panel
      title="虚拟地址与页表"
      testId="panel-pagetable"
      pending={pending}
      busyLabel={busyLabel}
      actions={<span className="badge">CR3 {frame.cpu.control.cr3 ?? '—'}</span>}
    >
      <div className="row">
        <input
          className="mono"
          style={{ flex: 1 }}
          placeholder="线性地址，例如 0xffffffff82056d20"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') run(); }}
        />
        <button disabled={walk.status === 'loading' || recording} onClick={run}>翻译</button>
        <button
          className="small"
          onClick={() => { setAddress(frame.cpu.rip ?? ''); store.translate(frame.cpu.rip ?? '').catch(() => {}); }}
          disabled={!frame.cpu.rip || recording}
        >
          当前 PC
        </button>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        使用帧内 CR0/CR3/CR4/EFER 与绑定该次采集的页表页。
        分页模式：{frame.cpu.mode}。
        {recording ? ' 导入录制包时只展示帧内已有的寄存器与内存区间，页表翻译按钮禁用。' : ''}
      </p>

      {walk.status === 'error' ? (
        <p className="error-text">{walk.error}</p>
      ) : null}

      {walk.result ? (
        <>
          <table className="kv">
            <tbody>
              <tr><td className="key">线性地址</td><td className="val mono">{walk.result.linear ?? walk.address}</td></tr>
              <tr><td className="key">物理地址</td><td className="val mono">{walk.result.physical ?? '翻译失败'}</td></tr>
              <tr><td className="key">页大小</td><td className="val mono">{walk.result.pageSize ?? '—'}{walk.result.huge ? '（大页）' : ''}</td></tr>
              <tr><td className="key">模式</td><td className="val mono">{frame.cpu.mode}</td></tr>
              <tr><td className="key">fault</td><td className="val mono">{walk.result.fault ? `${walk.result.fault.kind} @level ${walk.result.fault.level}` : 'fault 为空'}</td></tr>
            </tbody>
          </table>
          {walk.result.fault ? <p className="error-text">{walk.result.fault.detail}</p> : null}
          <table className="table">
            <thead>
              <tr><th>级</th><th>页表项地址</th><th>索引</th><th>raw</th><th>P</th><th>RW</th><th>US</th><th>PS</th><th>NX</th><th>物理基址</th></tr>
            </thead>
            <tbody>
              {walk.result.walk.map((entry, index) => (
                <tr key={index}>
                  <td>{index}</td>
                  <td className="mono">{entry.tableAddress}</td>
                  <td>{entry.index}</td>
                  <td className="mono">{entry.raw}</td>
                  <td>{entry.present ? '1' : '0'}</td>
                  <td>{entry.writable ? '1' : '0'}</td>
                  <td>{entry.user ? '1' : '0'}</td>
                  <td>{entry.huge ? '1' : '0'}</td>
                  <td>{entry.noExecute ? '1' : '0'}</td>
                  <td className="mono">{entry.physicalAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : walk.status === 'loading' ? (
        <p className="muted">正在按该帧页表翻译…</p>
      ) : (
        <p className="muted">地址翻译结果展示实际页表各级条目；失败时保留 fault 类型、层级与原因。</p>
      )}
    </Panel>
  );
}
