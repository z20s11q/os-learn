import type { CSSProperties, ReactNode } from 'react';

/**
 * 面板外壳。采集/命令在途时显示覆盖层并保留上一帧内容（T04d）。
 */
export function Panel({
  title,
  actions,
  pending,
  busyLabel,
  grow,
  bodyStyle,
  testId,
  children,
}: {
  title: string;
  actions?: ReactNode;
  pending?: boolean;
  busyLabel?: string | null;
  grow?: boolean;
  bodyStyle?: CSSProperties;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className={grow ? 'panel grow' : 'panel'} data-testid={testId}>
      <header>
        <span>{title}</span>
        <span className="spacer" />
        {actions}
      </header>
      <div className="body" style={bodyStyle}>
        {children}
      </div>
      {pending ? (
        <div className="pending-veil">
          <span className="box">
            <span className="spinner" />
            {busyLabel ?? '采集中'}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** 字段缺失时统一显示「未采集」及具体原因。 */
export function Missing({ reason }: { reason?: string }) {
  return <span className="unavailable">未采集{reason ? `：${reason}` : ''}</span>;
}

export function Value({ value, fallback }: { value: string | null | undefined; fallback?: string }) {
  if (value === null || value === undefined || value === '') return <Missing reason={fallback} />;
  return <span className="mono">{value}</span>;
}
