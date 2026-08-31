import type { ReactNode } from 'react';

export function Panel({
  title,
  children,
  right,
  noPad,
}: {
  title: string;
  children: ReactNode;
  right?: ReactNode;
  noPad?: boolean;
}) {
  return (
    <div className="panel">
      <div className="panel-title row">
        <span>
          ┌─ {title} ─┐
        </span>
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </div>
      {noPad ? children : <div className="panel-body">{children}</div>}
    </div>
  );
}
