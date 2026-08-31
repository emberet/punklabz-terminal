// Dual-series equity chart (strategy vs benchmark). Flat SVG, no glow.
export function EquityChart({
  series,
  benchmark,
  height = 140,
}: {
  series: { ts: number; equityUsd: number }[];
  benchmark?: { ts: number; equityUsd: number }[];
  height?: number;
}) {
  const width = 600;
  if (series.length < 2) {
    return <div className="dim" style={{ padding: 8 }}>not enough data to chart</div>;
  }
  const all = [...series, ...(benchmark ?? [])].map((p) => p.equityUsd);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;

  const toPts = (pts: { ts: number; equityUsd: number }[]) =>
    pts
      .map((p, i) => {
        const x = (i / (pts.length - 1)) * width;
        const y = height - 4 - ((p.equityUsd - min) / range) * (height - 8);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const up = series[series.length - 1].equityUsd >= series[0].equityUsd;
  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="0" y1={height - 4 - ((series[0].equityUsd - min) / range) * (height - 8)} x2={width} y2={height - 4 - ((series[0].equityUsd - min) / range) * (height - 8)} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
        {benchmark && benchmark.length > 1 && (
          <polyline points={toPts(benchmark)} fill="none" stroke="var(--text-dim)" strokeWidth="1" />
        )}
        <polyline points={toPts(series)} fill="none" stroke={up ? 'var(--acid)' : 'var(--red)'} strokeWidth="1.5" />
      </svg>
      {benchmark && (
        <div className="row dim" style={{ fontSize: 11, gap: 18, marginTop: 4 }}>
          <span><span className="acid">━</span> strategy</span>
          <span>━ BTC buy &amp; hold</span>
        </div>
      )}
    </div>
  );
}
