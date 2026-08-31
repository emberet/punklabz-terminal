export function fmtUsd(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPx(n: number): string {
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

export function fmtPct(n: number): string {
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB');
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function pnlClass(n: number): string {
  return n >= 0 ? 'pnl-pos' : 'pnl-neg';
}
