import type { ReactNode } from 'react';

export function Panel({
  title,
  sub,
  term,
  children,
  right,
  noPad,
}: {
  title: string;
  /** dim explainer text after the title (product voice) */
  sub?: string;
  /** terminal-voice header: mono, acid, uppercase — for tape/audit/config zones */
  term?: boolean;
  children: ReactNode;
  right?: ReactNode;
  noPad?: boolean;
}) {
  return (
    <div className="panel">
      <div className={`panel-title row${term ? ' term' : ''}`}>
        <span>
          {title}
          {sub && <span className="sub">{sub}</span>}
        </span>
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </div>
      {noPad ? children : <div className="panel-body">{children}</div>}
    </div>
  );
}
