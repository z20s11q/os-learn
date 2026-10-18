import { useEffect, useRef } from 'react';
import type { CpuSnapshot, Frame } from '../types';
import { sameValue } from '../format';
import { Panel, Value } from './Panel';

/**
 * CPU 面板（T04b）：普通寄存器、执行模式、段缓存、控制寄存器。
 *
 * 变化高亮以「上一个已提交帧」为基准，缓存随 frameId/epoch 更新。
 */
export function CpuPanel({ frame, pending, busyLabel }: { frame: Frame; pending: boolean; busyLabel: string | null }) {
  const cpu: CpuSnapshot = frame.cpu;
  const previousRef = useRef<Map<string, string> | null>(null);
  const previous = previousRef.current;

  useEffect(() => {
    const map = new Map<string, string>();
    for (const register of cpu.general) map.set(register.name, register.value);
    map.set('rip', cpu.rip ?? '');
    map.set('rsp', cpu.rsp ?? '');
    for (const [name, value] of Object.entries(cpu.control)) map.set(name, value ?? '');
    map.set('efer', cpu.efer ?? '');
    previousRef.current = map;
  }, [frame.frameId, frame.epoch]);

  const changed = (name: string, value: string | null | undefined): boolean => {
    if (!previous) return false;
    const before = previous.get(name);
    return before !== undefined && !sameValue(before, value ?? '');
  };

  return (
    <Panel
      title={`CPU · 帧 #${frame.frameId}`}
      testId="panel-cpu"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className="badge" data-testid="cpu-mode">
            {cpu.mode}
          </span>
          <span className="badge">CPL {cpu.cpl}</span>
          {cpu.halted ? <span className="badge unavailable">HLT</span> : null}
        </>
      }
    >
      <table className="kv">
        <tbody>
          <tr>
            <td className="key">停止 PC（rip）</td>
            <td className="val" data-testid="cpu-rip">
              <span className="mono">
                <Value value={cpu.rip} fallback="GDB 返回的 rip 字段缺失" />
              </span>
            </td>
          </tr>
          <tr>
            <td className="key">线性 PC</td>
            <td className="val">
              <Value value={cpu.linearPc} fallback="需要段隐藏基址（T05a）" />
            </td>
          </tr>
          <tr>
            <td className="key">栈指针（rsp）</td>
            <td className="val">
              <Value value={cpu.rsp} />
            </td>
          </tr>
          <tr>
            <td className="key">efer</td>
            <td className="val">
              <Value value={cpu.efer} />
            </td>
          </tr>
          <tr>
            <td className="key">eflags</td>
            <td className="val">
              <Value value={cpu.eflags} />
            </td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 10, marginBottom: 4, color: 'var(--text-dim)', fontSize: 12 }}>通用寄存器</div>
      <div className="regs">
        {cpu.general.length === 0 ? (
          <span className="unavailable">未采集：GDB 通用寄存器结果为空</span>
        ) : (
          cpu.general.map((register) => (
            <div key={register.name} className={changed(register.name, register.value) ? 'reg changed' : 'reg'}>
              <span className="name">{register.name}</span>
              <span>{register.value}</span>
            </div>
          ))
        )}
      </div>

      <div style={{ marginTop: 10, marginBottom: 4, color: 'var(--text-dim)', fontSize: 12 }}>控制寄存器</div>
      <div className="regs">
        {(['cr0', 'cr2', 'cr3', 'cr4', 'cr8'] as const).map((name) => (
          <div key={name} className={changed(name, cpu.control[name]) ? 'reg changed' : 'reg'}>
            <span className="name">{name}</span>
            <span>{cpu.control[name] ?? '—'}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, marginBottom: 4, color: 'var(--text-dim)', fontSize: 12 }}>段寄存器</div>
      <table className="kv">
        <tbody>
          {Object.keys(cpu.segments).length === 0 ? (
            <tr>
              <td colSpan={2}>
                <span className="unavailable">未采集：本帧段寄存器结果为空</span>
              </td>
            </tr>
          ) : (
            Object.entries(cpu.segments).map(([name, segment]) => (
              <tr key={name}>
                <td className="key">{name}</td>
                <td className="val">
                  sel={segment.selector} base={segment.base} limit={segment.limit} attr={segment.attributes}
                  {segment.usable ? '' : ' （usable=false）'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <p className="muted" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
        {cpu.evidence}
      </p>
    </Panel>
  );
}
