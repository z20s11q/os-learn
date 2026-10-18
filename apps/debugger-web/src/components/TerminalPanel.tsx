import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { store } from '../store';
import { Panel } from './Panel';

/**
 * 真实串口终端（T04a）。
 *
 * - 输出来自 WS terminal.output 与 /terminal 快照，是客体真实串口字节；
 * - 键盘输入经终端的 onData 收集后批量发送（60ms 合并），避免每个按键一次请求；
 * - 绑定 serial 通路；VGA/PS2 由独立面板展示和接收输入。
 */
export function TerminalPanel({
  pending,
  busyLabel,
  enabled,
}: {
  pending: boolean;
  busyLabel: string | null;
  enabled: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [line, setLine] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: {
        background: '#060d18',
        foreground: '#dbe6f5',
        cursor: '#4da3ff',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    // 先写入已有快照，之后只写增量，避免每帧重排整个缓冲区
    let written = 0;
    const initial = store.getTerminalText();
    if (initial) {
      terminal.write(initial);
      written = initial.length;
    }

    const buffer: { text: string } = { text: '' };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      const data = buffer.text;
      buffer.text = '';
      if (data.length > 0) store.sendTerminal(data).catch(() => {});
    };

    const dataDisposable = terminal.onData((data) => {
      buffer.text += data;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 60);
    });

    const unsubscribe = store.subscribeTerminal((text) => {
      if (text.length < written) {
        // 缓冲区被服务端/客户端截断：整体重放
        terminal.reset();
        terminal.write(text);
      } else {
        terminal.write(text.slice(written));
      }
      written = text.length;
    });

    const refit = () => {
      try {
        fit.fit();
      } catch {
        // 布局期间适配失败时保留尺寸，由下一次 resize 通知重试。
      }
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    window.addEventListener('resize', refit);
    terminal.focus();

    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      window.removeEventListener('resize', refit);
      observer.disconnect();
      dataDisposable.dispose();
      unsubscribe();
      terminal.dispose();
    };
  }, []);

  const sendLine = () => {
    if (line.length === 0) return;
    store.sendTerminal(`${line}\r`).catch(() => {});
    setLine('');
  };

  return (
    <Panel
      title="串口终端"
      testId="panel-terminal"
      pending={pending}
      busyLabel={busyLabel}
      grow
      actions={
        <>
          <span className="badge">serial0 · isa-serial</span>
          <button className="small" disabled={!enabled} onClick={() => store.sendTerminal('\u0003').catch(() => {})}>
            Ctrl-C
          </button>
          <button className="small" disabled={!enabled} onClick={() => store.sendTerminal('\r').catch(() => {})}>
            回车
          </button>
        </>
      }
      bodyStyle={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div className="terminal-host" ref={hostRef} />
      <div className="row" style={{ marginTop: 8 }}>
        <input
          className="mono"
          style={{ flex: 1, minWidth: 160 }}
          placeholder="输入一行并回车，直接写入客体串口"
          value={line}
          disabled={!enabled}
          onChange={(event) => setLine(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') sendLine();
          }}
        />
        <button disabled={!enabled} onClick={sendLine}>
          发送
        </button>
      </div>
      <p className="terminal-hint">
        终端输出来自客体串口字节；VGA 显存与 PS/2 键盘由独立面板展示。
      </p>
    </Panel>
  );
}
