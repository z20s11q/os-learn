import { ControlBar } from './components/ControlBar';
import { TerminalPanel } from './components/TerminalPanel';
import { VgaPanel } from './components/VgaPanel';
import { CpuPanel } from './components/CpuPanel';
import { CodePanel } from './components/CodePanel';
import { MemoryPanel } from './components/MemoryPanel';
import { PageTablePanel } from './components/PageTablePanel';
import { ProcessPanel } from './components/ProcessPanel';
import { FilePanel } from './components/FilePanel';
import { DevicePanel } from './components/DevicePanel';
import { BusPanel } from './components/BusPanel';
import { MachineOverview } from './components/MachineOverview';
import { ExplanationPanel } from './components/ExplanationPanel';
import { BreakpointPanel } from './components/BreakpointPanel';
import { CapabilitiesPanel } from './components/CapabilitiesPanel';
import { Timeline } from './components/Timeline';
import { StatusBar } from './components/StatusBar';
import { useLabSelector } from './hooks';

/**
 * 主布局（T08，分屏版）：
 * 左 24% 代码/CPU/断点，中 52% 全部视图，右 24% 讲解；底部帧时间线。
 *
 * 中间区域的所有面板同时挂载，各自从同一个 activeFrame 派生。
 * 纵向由中列滚动，面板内部再独立滚动，避免某个长表格把整页撑开。
 */
export function App() {
  const frame = useLabSelector((state) => state.activeFrame);
  const session = useLabSelector((state) => state.session);
  const booting = useLabSelector((state) => state.booting);
  const pending = useLabSelector((state) => state.pending);
  const busyLabel = useLabSelector((state) => state.busyLabel);
  const curriculum = useLabSelector((state) => state.curriculum);
  const replayMode = useLabSelector((state) => state.replay.mode);
  const recordingId = useLabSelector((state) => state.recordingId);
  const capabilities = session?.capabilities ?? null;
  const liveInput =
    session?.mode === 'live'
    && replayMode === 'live'
    && session?.state !== 'closed'
    && !recordingId;

  return (
    <div className="app">
      <ControlBar />

      {!frame ? (
        <div className="empty-state">
          <div>
            <p>
              {booting
                ? '正在启动真实 QEMU 会话并加载 vmlinux 符号，通常需要 1–2 分钟…'
                : '选择一个启动模式，然后点击「启动真实会话」；也可以点击「导入录制」回看已保存的录制包。'}
            </p>
            <p className="muted">
              会话启动真实的 QEMU，通过 GDB/MI 与 QMP 采集停止状态；字段按采集结果和证据来源展示，缺失项标记为未采集。
            </p>
            <p className="entry-links">
              <a className="button-link" href="/animation/slides.html" target="_blank" rel="noopener">
                ▶ 启动全景教学（CPU / 内存 / 中文旁白）
              </a>
              <a className="button-link" href="/media/player.html" target="_blank" rel="noopener">
                看视频版（约 8:10）
              </a>
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="main">
            <div className="column left">
              <CodePanel frame={frame} pending={pending} busyLabel={busyLabel} />
              <CpuPanel frame={frame} pending={pending} busyLabel={busyLabel} />
              <BreakpointPanel pending={pending} busyLabel={busyLabel} />
              <StatusBar />
            </div>

            <div className="column center">
              <div className="dashboard-head">
                <span>全部视图</span>
                <span className="muted">
                  同一帧 #{frame.frameId} · {frame.captureId} · 向下滚动查看全部 9 个面板
                </span>
              </div>

              <div className="dashboard">
                <div className="dash-cell dash-terminal">
                  <TerminalPanel pending={pending} busyLabel={busyLabel} enabled={liveInput} />
                </div>
                <div className="dash-cell dash-vga">
                  <VgaPanel frame={frame} pending={pending} busyLabel={busyLabel} enabled={liveInput} />
                </div>
                <div className="dash-cell span-2 dash-overview">
                  <MachineOverview frame={frame} pending={pending} busyLabel={busyLabel} />
                </div>
                <div className="dash-cell">
                  <ProcessPanel frame={frame} pending={pending} busyLabel={busyLabel} enabled={liveInput} />
                </div>
                <div className="dash-cell">
                  <PageTablePanel frame={frame} pending={pending} busyLabel={busyLabel} />
                </div>
                <div className="dash-cell span-2 dash-memory">
                  <MemoryPanel frame={frame} pending={pending} busyLabel={busyLabel} />
                </div>
                <div className="dash-cell">
                  <DevicePanel frame={frame} pending={pending} busyLabel={busyLabel} />
                </div>
                <div className="dash-cell">
                  <BusPanel pending={pending} busyLabel={busyLabel} />
                </div>
                <div className="dash-cell span-2">
                  <FilePanel frame={frame} pending={pending} busyLabel={busyLabel} />
                </div>
              </div>
            </div>

            <div className="column right">
              <ExplanationPanel frame={frame} curriculum={curriculum} pending={pending} busyLabel={busyLabel} />
              <CapabilitiesPanel capabilities={capabilities} pending={pending} busyLabel={busyLabel} />
            </div>
          </div>

          <Timeline pending={pending} />
        </>
      )}
    </div>
  );
}
