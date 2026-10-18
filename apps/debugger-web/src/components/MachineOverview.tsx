import type { Frame } from '../types';
import { Panel } from './Panel';

/** 机器概览（T08）：所有值来自同一个 frameId。 */
export function MachineOverview({
  frame,
  pending,
  busyLabel,
}: {
  frame: Frame;
  pending: boolean;
  busyLabel: string | null;
}) {
  const os = frame.os;
  const current = os?.current ?? null;
  const selected = os?.selected ?? null;
  const vga = frame.devices.find((device) => device.kind === 'vga');
  const virtio = frame.devices.find((device) => device.kind === 'virtio-blk');
  const diskVersion = Object.entries(frame.diskVersions ?? {})[0] ?? null;

  return (
    <Panel
      title={`机器概览 · frame #${frame.frameId}`}
      testId="panel-overview"
      pending={pending}
      busyLabel={busyLabel}
      actions={<span className="badge">{frame.cpu.mode}</span>}
    >
      <div className="overview-grid">
        <div className="overview-card">
          <div className="label">CPU</div>
          <div className="value mono">{frame.cpu.rip ?? '—'}</div>
          <div className="muted">CPL {frame.cpu.cpl} · {frame.cpu.halted ? 'HLT' : '运行/停止'}</div>
        </div>
        <div className="overview-card">
          <div className="label">current</div>
          <div className="value mono">{current ? `${current.pid} ${current.comm}` : '未采集'}</div>
          <div className="muted">{current ? current.state : '需要 64 位分页内核'}</div>
        </div>
        <div className="overview-card">
          <div className="label">选中进程</div>
          <div className="value mono">{selected ? `${selected.pid} ${selected.comm}` : '未采集'}</div>
          <div className="muted">mm {selected?.mmAddress ?? '—'}</div>
        </div>
        <div className="overview-card">
          <div className="label">进程 / VMA</div>
          <div className="value mono">
            {os ? `${os.processes.length}${os.processesTruncated ? '+' : ''} / ${os.addressSpace?.vmas.length ?? 0}` : '—'}
          </div>
          <div className="muted">{os?.processesTruncated ? '遍历达到上限' : '链表中全部任务'}</div>
        </div>
        <div className="overview-card">
          <div className="label">设备</div>
          <div className="value mono">{frame.devices.length}</div>
          <div className="muted">{vga ? 'VGA text' : 'VGA 快照缺失'} · {virtio ? 'virtio-blk' : 'virtio 快照缺失'}</div>
        </div>
        <div className="overview-card">
          <div className="label">磁盘版本</div>
          <div className="value mono" style={{ fontSize: 12 }}>{diskVersion?.[1] ?? '未采集'}</div>
          <div className="muted">{diskVersion?.[0] ?? '—'}</div>
        </div>
        <div className="overview-card">
          <div className="label">内存覆盖</div>
          <div className="value mono">{frame.coverage.memory}</div>
          <div className="muted">事件：{frame.coverage.events}</div>
        </div>
        <div className="overview-card">
          <div className="label">采集</div>
          <div className="value mono" style={{ fontSize: 11 }}>{frame.captureId}</div>
          <div className="muted">{new Date(frame.committedAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>
        </div>
      </div>

      <h3>当前进程（内核对象）</h3>
      {current ? (
        <table className="kv">
          <tbody>
            <tr><td className="key">task_struct</td><td className="val mono">{current.taskAddress}</td></tr>
            <tr><td className="key">pid / tgid</td><td className="val mono">{current.pid} / {current.tgid}</td></tr>
            <tr><td className="key">state</td><td className="val mono">{current.state} ({current.stateRaw})</td></tr>
            <tr><td className="key">mm</td><td className="val mono">{current.mmAddress ?? 'mm 地址为空'}</td></tr>
            <tr><td className="key">内核栈</td><td className="val mono">{current.stackAddress}</td></tr>
          </tbody>
        </table>
      ) : (
        <p className="unavailable">本帧 current 对象缺失；解析需处于受支持的 Linux 内核阶段并具备对象读取能力，具体原因见采集覆盖和解析备注。</p>
      )}

      <h3>不可用项</h3>
      {frame.coverage.unavailable.length === 0 ? (
        <p className="muted">本帧登记的缺失能力为 0 项。</p>
      ) : (
        <ul className="tight unavailable-list">
          {frame.coverage.unavailable.map((entry, index) => <li key={index}>{entry}</li>)}
        </ul>
      )}
      {os?.notes && os.notes.length > 0 ? (
        <details>
          <summary>对象解析备注（{os.notes.length}）</summary>
          <ul className="tight">
            {os.notes.map((entry, index) => <li key={index}>{entry}</li>)}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
