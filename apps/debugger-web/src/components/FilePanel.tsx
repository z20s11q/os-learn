import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { FileSystemEntry, Frame } from '../types';
import { store } from '../store';
import { useLabSelector } from '../hooks';
import { Panel } from './Panel';

/** 文件面板（T08）：内存侧 fd/file/inode/页缓存 + 盘面 ext2 结构，两个来源分开。 */
export function FilePanel({ frame, pending, busyLabel }: { frame: Frame; pending: boolean; busyLabel: string | null }) {
  const [path, setPath] = useState('/data');
  const view = useLabSelector((snapshot) => snapshot.fileSystem);
  const recording = useLabSelector((snapshot) => snapshot.recordingId) !== null;
  const files = frame.os?.files ?? [];
  const folios = frame.os?.folios ?? [];

  useEffect(() => {
    if (view.status === 'idle') store.loadFileSystem('/data', 1).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.sessionId]);

  const open = () => {
    const wanted = path.trim().length > 0 ? path.trim() : '/';
    store.loadFileSystem(wanted, view.depth).catch(() => {});
  };

  return (
    <Panel
      title="文件与盘面"
      testId="panel-files"
      pending={pending}
      busyLabel={busyLabel}
      actions={
        <>
          <span className="badge">{frame.diskVersions?.['virtio-blk-0'] ?? '磁盘版本未采集'}</span>
          <button className="small" disabled={view.status === 'loading' || recording} onClick={open}>读取</button>
        </>
      }
    >
      <div className="row">
        <input
          className="mono"
          style={{ flex: 1 }}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') open(); }}
          placeholder="/data"
        />
        <select value={view.depth} disabled={recording} onChange={(event) => store.loadFileSystem(path, Number(event.target.value)).catch(() => {})}>
          <option value={1}>1 层</option>
          <option value={2}>2 层</option>
        </select>
      </div>

      <h3>本帧打开的文件（内存侧）</h3>
      {files.length === 0 ? (
        <p className="unavailable">本帧打开文件的解析结果为空；进程状态与解析覆盖见机器概览。</p>
      ) : (
        <table className="table">
          <thead><tr><th>fd</th><th>路径</th><th>offset</th><th>size</th><th>inode</th><th>file</th><th>ref</th></tr></thead>
          <tbody>
            {files.map((file) => (
              <tr key={file.fd}>
                <td>{file.fd}</td>
                <td className="mono">{file.path ?? '（路径未解析）'}</td>
                <td className="mono">{file.offset}</td>
                <td className="mono">{file.size ?? '—'}</td>
                <td className="mono">{file.inodeNumber ?? '—'}</td>
                <td className="mono" style={{ fontSize: 10 }}>{file.fileAddress}</td>
                <td>{file.refCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>页缓存 folio</h3>
      {folios.length === 0 ? (
        <p className="muted">本帧列出的页缓存条目为 0 条。</p>
      ) : (
        <table className="table">
          <thead><tr><th>folio</th><th>文件偏移</th><th>PFN</th><th>dirty</th><th>uptodate</th></tr></thead>
          <tbody>
            {folios.map((folio) => (
              <tr key={folio.address}>
                <td className="mono" style={{ fontSize: 10 }}>{folio.address}</td>
                <td className="mono">{folio.fileOffset ?? '—'}</td>
                <td className="mono">{folio.pfn ?? '—'}</td>
                <td>{folio.dirty ? '1' : '0'}</td>
                <td>{folio.uptodate ? '1' : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>盘面（ext2，基线 + 已对客体可见的写）</h3>
      {view.status === 'error' ? <p className="error-text">{view.error}</p> : null}
      {view.result ? (
        <>
          <table className="kv">
            <tbody>
              <tr><td className="key">路径</td><td className="val mono">{view.result.path} {view.result.resolved ? '' : `（缺 ${view.result.missing}）`}</td></tr>
              <tr><td className="key">inode</td><td className="val mono">{view.result.inode?.ino ?? '—'} · {view.result.inode?.modeText ?? '—'}</td></tr>
              <tr><td className="key">版本</td><td className="val mono">{view.result.versionId ?? '—'}</td></tr>
              <tr><td className="key">超级块</td><td className="val mono">block={view.result.superblock.blockSize} · inodes={view.result.superblock.inodesCount} · size={view.result.superblock.inodeSize}</td></tr>
              <tr><td className="key">盘面读取</td><td className="val mono">{view.result.diskReads} 个扇区</td></tr>
            </tbody>
          </table>
          {view.result.note ? <p className="warn-text">{view.result.note}</p> : null}
          <div className="fs-tree">
            {renderEntries(view.result.entries, 0)}
          </div>
          {view.result.notes.length > 0 ? (
            <details>
              <summary>盘面解析备注（{view.result.notes.length}）</summary>
              <ul className="tight">{view.result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="muted">ext2 盘面读取来源为基线镜像与已对客体可见的写。</p>
      )}
    </Panel>
  );
}

function renderEntries(entries: FileSystemEntry[], depth: number): ReactElement[] {
  const out: ReactElement[] = [];
  for (const entry of entries) {
    if (entry.childOf) {
      out.push(
        <div key={`child-${entry.childOf}`} className="fs-node" style={{ paddingLeft: depth * 14 }}>
          <span className="mono muted">↳ {entry.childOf}/</span>
        </div>,
        ...renderEntries(entry.entries ?? [], depth + 1),
      );
      continue;
    }
    const dir = entry.fileType === 'EXT2_FT_DIR' || entry.inode?.fileType === 'EXT2_FT_DIR';
    out.push(
      <div key={`${entry.name}-${entry.ino}`} className="fs-node" style={{ paddingLeft: depth * 14 }}>
        <span className="mono">{dir ? '📁' : '📄'} {entry.name}</span>
        <span className="muted mono"> ino={entry.ino} {entry.inode?.size ? `size=${entry.inode.size}` : ''}</span>
        {entry.inode?.blockMapError ? <span className="unavailable"> 块映射失败</span> : null}
        {entry.inode?.extents && entry.inode.extents.length > 0 ? (
          <div className="muted mono" style={{ fontSize: 10, marginLeft: 16 }}>
            {entry.inode.extents.slice(0, 4).map((extent) => (
              `${extent.hole ? 'hole' : `blk ${extent.physicalStart}`} +${extent.blockCount}`
            )).join(' · ')}
            {entry.inode.extents.length > 4 ? ' …' : ''}
          </div>
        ) : null}
      </div>,
    );
  }
  return out;
}
