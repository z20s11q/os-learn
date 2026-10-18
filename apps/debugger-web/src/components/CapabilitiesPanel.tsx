import type { Capabilities, CapabilityEntry } from '../types';
import { Panel } from './Panel';

const GROUP_TITLES: Record<string, string> = {
  standard: '标准接口能力',
  observer_: '观察扩展（x-oslab-*）',
  events: '事件覆盖',
  devices: '设备快照字段',
};

function EntryRow({ name, entry }: { name: string; entry: CapabilityEntry }) {
  const klass = entry.status === 'verified' ? 'observed' : entry.status === 'unavailable' ? 'unavailable' : '';
  return (
    <tr>
      <td className="key mono">{name}</td>
      <td className="val">
        <span className={'badge ' + klass}>{entry.status}</span>{' '}
        {entry.evidence ? <span className="muted">{entry.evidence}</span> : null}
        {entry.note ? <span className="unavailable"> · {entry.note}</span> : null}
      </td>
    </tr>
  );
}

/**
 * 能力面板。
 *
 * 按 capability 展示状态、证据与原因，保留 `unavailable` 的缺口说明。
 */
export function CapabilitiesPanel({
  capabilities,
  pending,
  busyLabel,
}: {
  capabilities: Capabilities | null;
  pending: boolean;
  busyLabel: string | null;
}) {
  if (!capabilities) {
    return (
      <Panel title="能力与缺口" testId="panel-capabilities" pending={pending} busyLabel={busyLabel}>
        <span className="muted">会话启动后显示。</span>
      </Panel>
    );
  }

  const groups: Array<[string, Record<string, CapabilityEntry>]> = [
    ['standard', capabilities.standard],
    ['observer_', capabilities.observer_],
    ['events', capabilities.events],
    ['devices', capabilities.devices],
  ];

  return (
    <Panel
      title="能力与缺口"
      testId="panel-capabilities"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className="badge">QEMU {capabilities.observer?.qemuVersion ?? '?'}</span>
          <span className="badge">{capabilities.observer?.patched ? '已打补丁' : '补丁标记未置位'}</span>
          <span className="badge">丢弃事件 {capabilities.droppedEvents}</span>
        </>
      }
    >
      {groups.map(([key, entries]) => (
        <div key={key} style={{ marginBottom: 10 }}>
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>{GROUP_TITLES[key] ?? key}</div>
          <table className="kv">
            <tbody>
              {Object.entries(entries).map(([name, entry]) => (
                <EntryRow key={name} name={name} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 4 }}>已知缺口</div>
      <ul style={{ margin: 0, paddingLeft: 18 }} className="unavailable">
        {capabilities.knownGaps.map((gap) => (
          <li key={gap}>{gap}</li>
        ))}
      </ul>
    </Panel>
  );
}
