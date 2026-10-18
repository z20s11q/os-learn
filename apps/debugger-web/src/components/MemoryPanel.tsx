import { useEffect, useRef, useState } from 'react';
import type { Frame, MemoryEntry, MemoryView } from '../types';
import { store } from '../store';
import { useLabSelector } from '../hooks';
import { hexDump, normalizeAddress } from '../format';
import { Panel } from './Panel';

const COVERAGE_TEXT: Record<string, string> = {
  recorded: '已采集',
  'not-recorded': '本次未记录',
  'read-failed': '读取失败',
  unmapped: '未映射',
};

function maybe(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return null;
  }
}

/**
 * 内存面板（T08 分屏版）：物理空间与虚拟空间并排显示。
 *
 * 两个空间分别管理地址、长度、已采集区间和按需读取结果；物理读取与页表翻译各走对应接口。
 * 历史/回看模式只展示帧内已记录区间。
 */
export function MemoryPanel({ frame, pending, busyLabel }: { frame: Frame; pending: boolean; busyLabel: string | null }) {
  const views = useLabSelector((snapshot) => snapshot.memoryViews);
  const replayMode = useLabSelector((snapshot) => snapshot.replay.mode);
  const sessionState = useLabSelector((snapshot) => snapshot.session?.state ?? null);
  const recordedMode = frame.executionMode === 'recorded' || replayMode === 'recorded';
  const canRead = !recordedMode && sessionState === 'stopped';

  return (
    <Panel
      title="内存：物理空间 / 虚拟空间"
      testId="panel-memory"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className="badge">{frame.executionMode === 'live' ? '实时帧' : '历史帧'}</span>
          <span className={'badge ' + (canRead ? 'ok' : 'unavailable')}>
            {canRead ? '可按需读取' : recordedMode ? '只读回放' : '实时读取需停止状态'}
          </span>
        </>
      }
      bodyStyle={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
      <div className="memory-map-strip" title="本实验的 4 级页表 / 512 MiB RAM 布局">
        <span className="map-label">物理</span>
        <span>0x0 低端 RAM</span>
        <span>0xa0000 VGA/ROM 洞</span>
        <span>0x100000 内核/initrd</span>
        <span>…0x1fffffff 可用 RAM</span>
        <span className="map-label">虚拟</span>
        <span>0xffff8880 direct map</span>
        <span>0xffffea00 vmemmap</span>
        <span>0xffffffff81000000 text</span>
      </div>
      <div className="memory-split">
        <MemorySpaceColumn
          space="physical"
          frame={frame}
          view={views.physical}
          recordedMode={recordedMode}
          canRead={canRead}
          pending={pending}
        />
        <MemorySpaceColumn
          space="linear"
          frame={frame}
          view={views.linear}
          recordedMode={recordedMode}
          canRead={canRead}
          pending={pending}
        />
      </div>
    </Panel>
  );
}

function MemorySpaceColumn({
  space,
  frame,
  view,
  recordedMode,
  canRead,
  pending,
}: {
  space: 'physical' | 'linear';
  frame: Frame;
  view: MemoryView;
  recordedMode: boolean;
  canRead: boolean;
  pending: boolean;
}) {
  const pc = maybe(frame.cpu.linearPc ?? frame.cpu.rip) ?? '0x0';
  const defaultAddress = space === 'linear' ? pc : '0x0';
  const [address, setAddress] = useState(view.requestedAddress || defaultAddress);
  const [length, setLength] = useState(view.result?.length ?? 128);
  const [selected, setSelected] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  /** 用户提交读取/跳转后保持所选地址；自动跟随用于初始地址。 */
  const userEditedRef = useRef(false);

  const entries = frame.memory.filter((entry) => entry.addressSpace === space);
  const capturedEntry: MemoryEntry | null = selected !== null ? entries[selected] ?? null : null;
  const dump = capturedEntry?.bytes
    ? hexDump(capturedEntry.address, capturedEntry.bytes, 8)
    : view.result
      ? hexDump(view.result.address, view.result.hex, 8)
      : null;
  const dumpLabel = capturedEntry?.bytes
    ? `本帧区间 @ ${capturedEntry.address}（${capturedEntry.length} B）`
    : view.result
      ? `按需读取 @ ${view.result.address}（${view.result.length} B）`
      : null;

  const doRead = (targetAddress: string, targetLength: number, userAction = true) => {
    if (userAction) userEditedRef.current = true;
    const normalized = normalizeAddress(targetAddress);
    if (normalized === null) {
      setLocalError(`地址无法解析：${targetAddress}`);
      return;
    }
    if (!canRead) return;
    setLocalError(null);
    setSelected(null);
    store.setMemoryQuery(space, { requestedAddress: normalized, length: targetLength });
    store.readMemory(normalized, targetLength, space).catch(() => {});
  };

  // 每个实时停止帧的初始地址：虚拟侧跟随 PC，物理侧从 0x0 读取。
  // 两个空间各读一次；用户提交读取/跳转后保持其地址。
  useEffect(() => {
    if (!canRead) return;
    setSelected(null);
    if (userEditedRef.current) return;
    // 帧提交与 session.state 的 WS 通知有先后；等一拍再读，避免在 running
    // 的瞬间发请求。清理定时器也防止快速单步时堆积读取。
    const timer = setTimeout(() => {
      setAddress(defaultAddress);
      doRead(defaultAddress, length, false);
    }, 180);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead, frame.sessionId, frame.epoch, frame.frameId, space]);

  const jump = (target: string) => {
    if (!target) return;
    setAddress(target);
    doRead(target, length);
  };

  return (
    <section className="memory-col" data-testid={`memory-${space}`}>
      <header className="memory-col-head">
        <span className={'badge ' + (space === 'physical' ? 'decoded' : 'observed')}>
          {space === 'physical' ? '物理内存' : '虚拟内存（线性）'}
        </span>
        <span className="muted">
          {space === 'physical' ? '按物理地址读 RAM/ROM' : '经当前 CR3 页表翻译'}
        </span>
        <span className="spacer" />
        <span className="badge">{entries.length} 个本帧区间</span>
      </header>

      <div className="row memory-query">
        <input
          className="mono"
          style={{ flex: 1, minWidth: 70 }}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') doRead(address, length); }}
          placeholder={space === 'physical' ? '0x0' : '0xffffffff...'}
        />
        <input
          className="mono"
          type="number"
          min={1}
          max={4096}
          style={{ width: 68 }}
          value={length}
          onChange={(event) => setLength(Math.max(1, Math.min(4096, Number(event.target.value) || 1)))}
          title="读取长度（字节）"
        />
        <button className="small" disabled={pending || !canRead} onClick={() => doRead(address, length)}>读取</button>
      </div>

      <div className="row memory-jumps">
        {space === 'linear' ? (
          <>
            <button className="small" disabled={!frame.cpu.linearPc} onClick={() => jump(pc)}>跳到 PC</button>
            <button className="small" disabled={!frame.cpu.rsp} onClick={() => jump(frame.cpu.rsp ?? '')}>跳到 SP</button>
          </>
        ) : (
          <button className="small" disabled={!frame.cpu.control.cr3} onClick={() => jump(frame.cpu.control.cr3 ?? '')}>跳到 CR3</button>
        )}
        <span className="muted" style={{ fontSize: 11 }}>
          {space === 'physical' ? `CR3 ${frame.cpu.control.cr3 ?? '—'}` : `PC ${frame.cpu.linearPc ?? frame.cpu.rip ?? '—'}`}
        </span>
      </div>

      {entries.length > 0 ? (
        <div className="memory-entries">
          {entries.map((entry, index) => (
            <button
              key={`${entry.address}-${entry.label ?? index}`}
              className={'memory-entry' + (selected === index ? ' active' : '')}
              onClick={() => setSelected(index)}
              title={entry.reason ?? entry.coverage}
            >
              <span className="mono">{entry.label ?? '区间'} {entry.address}</span>
              <span className={entry.coverage === 'recorded' ? 'muted' : 'unavailable'}>
                {COVERAGE_TEXT[entry.coverage] ?? entry.coverage}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {recordedMode ? (
        <p className="unavailable memory-note">回看模式只展示本帧已记录区间。</p>
      ) : null}
      {localError ? <p className="error-text memory-note">{localError}</p> : null}
      {view.status === 'error' && view.error ? (
        <p className="error-text memory-note">读取失败（{view.error.code ?? 'error'}）：{view.error.message}</p>
      ) : null}

      <div className="memory-dump-label">{dumpLabel ?? '内容（16 进制 / ASCII）'}</div>
      {dump ? (
        <pre className="memory-dump" data-testid={`memory-dump-${space}`}>{dump}</pre>
      ) : (
        <span className="unavailable">
          {view.status === 'loading' ? '读取中…' : '内容待加载：选择本帧区间，或在实时停止状态读取地址'}
        </span>
      )}
      {view.result ? (
        <p className="muted memory-evidence">
          来源 {view.result.evidence?.source ?? '—'} · capture 内 {view.result.withinCapture ? '是' : '否'} · blob {(view.result.blobRef ?? '—').slice(0, 12)}
        </p>
      ) : null}
    </section>
  );
}
