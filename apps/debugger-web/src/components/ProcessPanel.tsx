import type { Frame } from '../types';
import { store } from '../store';
import { useLabSelector } from '../hooks';
import { Panel } from './Panel';

/** 进程面板（T08）：current 来自内核快照，选中项仅指定详情读取对象。 */
export function ProcessPanel({
  frame,
  pending,
  busyLabel,
  enabled,
}: {
  frame: Frame;
  pending: boolean;
  busyLabel: string | null;
  enabled: boolean;
}) {
  const recordingId = useLabSelector((snapshot) => snapshot.recordingId);
  const os = frame.os;
  const current = os?.current ?? null;
  const selected = os?.selected ?? current;
  const mm = os?.addressSpace ?? null;

  return (
    <Panel
      title="进程与地址空间"
      testId="panel-process"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className="badge">current {current ? `${current.pid}` : '—'}</span>
          <span className="badge">选中 {selected ? `${selected.pid}` : '—'}</span>
        </>
      }
    >
      {os ? (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {os.processes.length} 个任务{os.processesTruncated ? '（达到遍历上限）' : ''} · init_task {os.initTaskAddress}
            </span>
            <span className="spacer" />
            <span className="badge decoded">{os.decoderVersion}</span>
          </div>
          <div className="scroll-table" style={{ maxHeight: 220 }}>
            <table className="table selectable">
              <thead>
                <tr><th>PID</th><th>comm</th><th>状态</th><th>父</th><th>mm</th><th>task</th></tr>
              </thead>
              <tbody>
                {os.processes.map((process) => (
                  <tr
                    key={process.taskAddress}
                    className={[
                      current?.pid === process.pid ? 'is-current' : '',
                      selected?.pid === process.pid ? 'is-selected' : '',
                    ].join(' ')}
                    onClick={() => {
                      if (!enabled || recordingId) return;
                      store.selectProcess(process.pid).catch(() => {});
                    }}
                    title={enabled ? '选中仅指定详情读取对象；current 来自内核快照' : '当前状态仅支持查看已解析进程'}
                  >
                    <td className="mono">{process.pid}</td>
                    <td className="mono">{process.comm}</td>
                    <td>{process.state}</td>
                    <td className="mono">{process.parentPid ?? '—'}</td>
                    <td className="mono">{process.mmAddress ?? '—'}</td>
                    <td className="mono" style={{ fontSize: 10 }}>{process.taskAddress}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>选中进程的 mm / VMA</h3>
          {mm ? (
            <>
              <table className="kv">
                <tbody>
                  <tr><td className="key">mm_struct</td><td className="val mono">{mm.mmAddress}</td></tr>
                  <tr><td className="key">pgd 物理</td><td className="val mono">{mm.pgdPhysical ?? '未翻译'}</td></tr>
                  <tr><td className="key">代码范围</td><td className="val mono">{mm.startCode ?? '—'} – {mm.endCode ?? '—'}</td></tr>
                  <tr><td className="key">栈顶</td><td className="val mono">{mm.startStack ?? '—'}</td></tr>
                  <tr><td className="key">VMA</td><td className="val mono">{mm.vmas.length}{mm.truncated ? '（截断）' : ''} · {mm.structure}</td></tr>
                </tbody>
              </table>
              <div className="scroll-table" style={{ maxHeight: 190 }}>
                <table className="table">
                  <thead><tr><th>起始</th><th>结束</th><th>权限</th><th>来源</th><th>文件偏移</th></tr></thead>
                  <tbody>
                    {mm.vmas.map((vma) => (
                      <tr key={`${vma.address}-${vma.end}`}>
                        <td className="mono">{vma.address}</td>
                        <td className="mono">{vma.end}</td>
                        <td className="mono">{vma.permissions}</td>
                        <td className="mono">{vma.source ?? '—'}</td>
                        <td className="mono">{vma.fileOffset ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="unavailable">
              {selected?.mmAddress === null
                ? '选中进程的 mm=null，用户地址空间缺失。'
                : '本帧地址空间解析结果缺失；原因见机器概览里的对象解析备注。'}
            </p>
          )}
        </>
      ) : (
        <p className="unavailable">本帧 OS 快照缺失；解析需要 64 位分页内核和观察者读取能力，具体原因见采集覆盖范围。</p>
      )}
    </Panel>
  );
}
