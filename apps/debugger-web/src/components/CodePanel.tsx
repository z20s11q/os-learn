import type { Frame } from '../types';
import { bytesOf } from '../format';
import { Panel, Value } from './Panel';

const STOP_TEXT: Record<string, string> = {
  reset: '复位停点',
  step: '单步完成',
  breakpoint: '断点命中',
  pause: '用户暂停',
  exited: '客体退出',
  signal: '收到信号',
  unknown: '未知原因',
};

/**
 * 代码面板（T04b）：停止原因、原始指令字节、当前模块源码。
 *
 * 「本次停止 PC」定位停止位置，「执行前 PC」定位上次执行的起点。
 */
export function CodePanel({ frame, pending, busyLabel }: { frame: Frame; pending: boolean; busyLabel: string | null }) {
  const stop = frame.stop;
  const instruction = frame.cpu.instruction;
  const source = frame.source;
  const instructionBytes = instruction.bytes ? bytesOf(instruction.bytes).join(' ') : null;

  return (
    <Panel
      title="代码与停止位置"
      testId="panel-code"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className={'badge' + (stop.reason === 'unknown' ? ' unavailable' : '')}>
            {STOP_TEXT[stop.reason] ?? stop.reason}
          </span>
          <span className="badge">帧 #{frame.frameId}</span>
          {frame.parentFrameId !== null ? <span className="badge">父帧 #{frame.parentFrameId}</span> : null}
        </>
      }
    >
      <table className="kv">
        <tbody>
          <tr>
            <td className="key">停止原因（原文）</td>
            <td className="val mono">{stop.rawReason ?? '—'}</td>
          </tr>
          <tr>
            <td className="key">执行前 PC</td>
            <td className="val">
              <Value value={stop.previousPc ?? null} fallback="本帧执行前 PC 字段为空" />
            </td>
          </tr>
          <tr>
            <td className="key">本次停止 PC</td>
            <td className="val">
              <Value
                value={stop.pc}
                fallback="实模式下调试接口给的是 CS 相对偏移，线性地址需要段隐藏基址（T05a）"
              />
            </td>
          </tr>
          {stop.breakpointId !== undefined ? (
            <tr>
              <td className="key">命中断点</td>
              <td className="val mono">#{stop.breakpointId}</td>
            </tr>
          ) : null}
          <tr>
            <td className="key">指令地址</td>
            <td className="val">
              <Value value={instruction.address} fallback="需要段隐藏基址（T05a）" />
            </td>
          </tr>
          <tr>
            <td className="key">原始指令字节</td>
            <td className="val">
              {instructionBytes ? (
                <>
                  <span className="mono" data-testid="instruction-bytes">
                    {instructionBytes}
                  </span>
                  <span className="badge decoded" style={{ marginLeft: 8 }}>
                    {instruction.evidence}
                  </span>
                </>
              ) : (
                <span className="unavailable">未采集：指令字节需要 T05a/T05b 的物理读取与访存事件接口</span>
              )}
            </td>
          </tr>
          <tr>
            <td className="key">反汇编文本</td>
            <td className="val">
              {instruction.text ? (
                <span className="mono">{instruction.text}</span>
              ) : (
                <span className="unavailable">未采集：本帧反汇编文本为空</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 10, marginBottom: 4, color: 'var(--text-dim)', fontSize: 12 }}>源码位置</div>
      {source ? (
        <table className="kv">
          <tbody>
            <tr>
              <td className="key">模块</td>
              <td className="val mono">{source.module}</td>
            </tr>
            <tr>
              <td className="key">符号</td>
              <td className="val mono">{source.symbol}</td>
            </tr>
            <tr>
              <td className="key">行号</td>
              <td className="val mono">{source.line}</td>
            </tr>
            <tr>
              <td className="key">文件</td>
              <td className="val mono">{source.path || '—'}</td>
            </tr>
            <tr>
              <td className="key">文件散列</td>
              <td className="val mono">{source.fileHash ?? '—'}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <span className="unavailable">
          本帧源码符号缺失；源码定位依赖匹配的调试 ELF 与模块加载信息。
        </span>
      )}

      <div style={{ marginTop: 10, marginBottom: 4, color: 'var(--text-dim)', fontSize: 12 }}>
        录制覆盖（帧 #{frame.frameId}）
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <td className="key">事件覆盖</td>
            <td className="val mono">{frame.recording?.events ?? frame.coverage?.events ?? 'unknown'}</td>
          </tr>
          <tr>
            <td className="key">内存覆盖</td>
            <td className="val mono">{frame.coverage?.memory ?? 'unknown'}</td>
          </tr>
          <tr>
            <td className="key">可重建画面</td>
            <td className="val mono">{frame.recording?.reconstructible ? '是' : '否（见录制覆盖说明）'}</td>
          </tr>
          <tr>
            <td className="key">采集 ID</td>
            <td className="val mono">{frame.captureId}</td>
          </tr>
        </tbody>
      </table>

      {frame.recording?.note ? (
        <p className="unavailable" style={{ marginTop: 8, marginBottom: 0 }}>
          {frame.recording.note}
        </p>
      ) : null}
    </Panel>
  );
}
