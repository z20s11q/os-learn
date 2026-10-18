import { useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { Frame } from '../types';
import { store } from '../store';
import { Panel } from './Panel';

/** VGA 文本屏（T08）：内容来自帧内设备快照的 vramBacking 字段。 */
export function VgaPanel({
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const vga = frame.devices.find((device) => device.kind === 'vga');
  const fields = useMemo(() => {
    const map = new Map<string, string>();
    for (const field of vga?.fields ?? []) map.set(field.name, String(field.value ?? ''));
    return map;
  }, [vga]);

  const cols = Number(fields.get('textCols') ?? 80) || 80;
  const rows = Number(fields.get('textRows') ?? 25) || 25;
  const stride = Number(fields.get('cellStride') ?? 4) || 4;
  const cursor = Number(fields.get('cursorOffset') ?? -1);
  const backing = fields.get('vramBacking') ?? '';

  const screen = useMemo(() => {
    const bytes: number[] = [];
    for (let index = 0; index + 1 < backing.length; index += 2) {
      bytes.push(Number.parseInt(backing.slice(index, index + 2), 16));
    }
    const lines: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      let line = '';
      for (let col = 0; col < cols; col += 1) {
        const cell = (row * cols + col) * stride;
        const code = bytes[cell] ?? 32;
        line += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : code === 0 ? ' ' : '·';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }, [backing, cols, rows, stride]);

  const keyToQcode = (event: KeyboardEvent): string | null => {
    const key = event.key;
    if (key.length === 1) {
      if (key === ' ') return 'spc';
      if (key === '-') return 'minus';
      if (key === '=') return 'equal';
      if (key === ',') return 'comma';
      if (key === '.') return 'dot';
      if (key === '/') return 'slash';
      if (key === ';') return 'semicolon';
      if (key === "'") return 'apostrophe';
      if (key === '[') return 'bracket_left';
      if (key === ']') return 'bracket_right';
      if (key === '\\') return 'backslash';
      if (key === '`') return 'grave_accent';
      if (/^[a-z]$/i.test(key)) return key.toLowerCase();
      if (/^[0-9]$/.test(key)) return key;
    }
    const map: Record<string, string> = {
      Enter: 'ret',
      Backspace: 'backspace',
      Tab: 'tab',
      Escape: 'esc',
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Home: 'home',
      End: 'end',
      PageUp: 'pgup',
      PageDown: 'pgdn',
      Delete: 'delete',
    };
    return map[key] ?? null;
  };

  const onKeyDown = async (event: KeyboardEvent) => {
    if (!enabled) return;
    const qcode = keyToQcode(event);
    if (qcode === null) return;
    event.preventDefault();
    if (event.ctrlKey && /^[a-z]$/i.test(event.key)) {
      await store.keyboard('ctrl', 'down').catch(() => {});
      await store.keyboard(event.key.toLowerCase(), 'press').catch(() => {});
      await store.keyboard('ctrl', 'up').catch(() => {});
      return;
    }
    if (event.shiftKey && /^[A-Z]$/.test(event.key)) {
      await store.keyboard('shift', 'down').catch(() => {});
      await store.keyboard(qcode, 'press').catch(() => {});
      await store.keyboard('shift', 'up').catch(() => {});
      return;
    }
    await store.keyboard(qcode, 'press').catch(() => {});
  };

  return (
    <Panel
      title="VGA 文本屏 / PS2 键盘"
      testId="panel-vga"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className="badge">{cols}×{rows}</span>
          <span className="badge">{fields.get('graphicMode') ?? '—'}</span>
          <span className={'badge ' + (cursor >= 0 ? 'ok' : 'unavailable')}>cursor {cursor}</span>
        </>
      }
      bodyStyle={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div
        className="vga-screen"
        ref={hostRef}
        tabIndex={0}
        onKeyDown={(event) => { void onKeyDown(event); }}
        title={enabled ? '点击后键入；按键经 QMP input-send-event 注入真实 PS/2 键盘' : '回看模式禁用客体输入'}
      >
        {screen.map((line, index) => (
          <div key={index} className="vga-line">
            {line.length === 0 ? '\u00a0' : line}
          </div>
        ))}
      </div>
      <p className="terminal-hint">
        这是 VGA 文本模式的真实显存内容（设备快照，只读）。点击屏幕获取焦点后键入；按键经 QMP
        注入 PS/2 键盘；串口输入走独立通路。回看模式下禁用输入。
      </p>
    </Panel>
  );
}
