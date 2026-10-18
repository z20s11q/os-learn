import { useState } from 'react';
import type { DeviceSnapshot, Frame } from '../types';
import { Panel } from './Panel';

/** 设备面板（T08）：直接展示帧内设备快照字段，读取来源见 evidence。 */
export function DevicePanel({ frame, pending, busyLabel }: { frame: Frame; pending: boolean; busyLabel: string | null }) {
  const [active, setActive] = useState(0);
  const devices = frame.devices;
  const device: DeviceSnapshot | undefined = devices[active];

  return (
    <Panel
      title="设备与外设"
      testId="panel-devices"
      pending={pending}
      busyLabel={busyLabel}
      actions={<span className="badge">{devices.length} 个快照</span>}
    >
      {devices.length === 0 ? (
        <p className="unavailable">本帧设备快照缺失；采集覆盖范围见机器概览。</p>
      ) : (
        <>
          <div className="tabs wrap">
            {devices.map((entry, index) => (
              <button
                key={`${entry.kind}-${index}`}
                className={index === active ? 'tab active' : 'tab'}
                onClick={() => setActive(index)}
              >
                {entry.kind}
                {entry.pciAddress ? ` · ${entry.pciAddress}` : ''}
              </button>
            ))}
          </div>

          {device ? (
            <>
              <div className="row" style={{ margin: '8px 0' }}>
                <span className="mono">{device.deviceId}</span>
                <span className="spacer" />
                <span className={'badge ' + (device.readOnly ? 'ok' : 'warn')}>
                  {device.readOnly ? '只读快照' : '未声明只读'}
                </span>
              </div>
              {device.registerRanges && device.registerRanges.length > 0 ? (
                <details style={{ marginBottom: 8 }}>
                  <summary>寄存器区间（{device.registerRanges.length}）</summary>
                  <table className="table">
                    <thead><tr><th>名称</th><th>基址</th><th>大小</th><th>owner</th></tr></thead>
                    <tbody>
                      {device.registerRanges.slice(0, 60).map((range, index) => (
                        <tr key={index}>
                          <td className="mono">{range.name ?? '—'}</td>
                          <td className="mono">{range.base ?? '—'}</td>
                          <td className="mono">{range.size ?? '—'}</td>
                          <td className="mono">{range.owner ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : null}
              <div className="scroll-table" style={{ maxHeight: 360 }}>
                <table className="table">
                  <thead><tr><th>字段</th><th>值</th><th>含义</th></tr></thead>
                  <tbody>
                    {device.fields.map((field) => (
                      <tr key={field.name}>
                        <td className="mono">{field.name}</td>
                        <td className="mono breakall">
                          {String(field.value ?? 'null').length > 160
                            ? `${String(field.value).slice(0, 160)}…`
                            : String(field.value ?? 'null')}
                        </td>
                        <td className="muted">{field.meaning ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {device.virtqueues ? (
                <details style={{ marginTop: 8 }}>
                  <summary>virtqueue 解码结果</summary>
                  <pre className="json-block">{JSON.stringify(device.virtqueues, null, 2).slice(0, 12000)}</pre>
                </details>
              ) : null}
              {device.evidence ? (
                <p className="muted evidence-line">
                  证据：{device.evidence.source} · capture {device.evidence.captureId ?? '—'} · {device.evidence.kind}
                </p>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}
