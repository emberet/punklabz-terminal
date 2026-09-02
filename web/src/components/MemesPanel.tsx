import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { fmtPct, pillClass, arrow } from '../lib/format';

interface MemeToken {
  id: string;
  chain: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  change5m: number | null;
  change1h: number | null;
  change24h: number | null;
  volume24hUsd: number | null;
  mcapUsd: number | null;
  source: 'trending' | 'pump_launch';
  ts: number;
}

const CHAIN_COLORS: Record<string, string> = {
  solana: 'var(--acid)',
  eth: '#8a92b2',
  base: '#5b8def',
  bsc: '#e8b930',
  arbitrum: '#5b8def',
};

function fmtBig(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtTinyPx(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

export function MemesPanel() {
  const [tokens, setTokens] = useState<MemeToken[]>([]);

  useEffect(() => {
    void api.get<{ tokens: MemeToken[] }>('/api/memes').then((r) => setTokens(r.tokens)).catch(() => {});
    const un = wsClient.sub('memes', (d) => setTokens(d as MemeToken[]));
    return un;
  }, []);

  return (
    <Panel title="MEMES ▸ ALL CHAINS" term noPad right={<span className="chip chip-running">LIVE DATA</span>}>
      <div className="table-scroll">
        <table style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th>token</th>
              <th>chain</th>
              <th className="num">price</th>
              <th className="num">5m</th>
              <th className="num">1h</th>
              <th className="num">24h</th>
              <th className="num">vol 24h</th>
              <th className="num">mcap</th>
            </tr>
          </thead>
          <tbody>
            {tokens.length === 0 && (
              <tr><td colSpan={8} className="dim">scanning chains…</td></tr>
            )}
            {tokens.slice(0, 15).map((t) => (
              <tr key={t.id} className={t.source === 'pump_launch' ? 'meme-launch' : ''}>
                <td>
                  <b>{t.symbol}</b>{' '}
                  {t.source === 'pump_launch' && <span className="chip chip-running">NEW LAUNCH</span>}
                  <span className="dim" style={{ marginLeft: 6, fontSize: 10 }}>{t.name.slice(0, 22)}</span>
                </td>
                <td>
                  <span style={{ color: CHAIN_COLORS[t.chain] ?? 'var(--text-soft)', fontFamily: 'var(--font)', fontSize: 10, textTransform: 'uppercase' }}>
                    ● {t.chain}
                  </span>
                </td>
                <td className="num">{fmtTinyPx(t.priceUsd)}</td>
                {[t.change5m, t.change1h, t.change24h].map((c, i) => (
                  <td key={i} className="num">
                    {c === null ? <span className="dim">—</span> : (
                      <span className={`pill ${pillClass(c)}`} style={{ fontSize: 10, padding: '0 5px' }}>
                        {fmtPct(c)} {arrow(c)}
                      </span>
                    )}
                  </td>
                ))}
                <td className="num dim">{fmtBig(t.volume24hUsd)}</td>
                <td className="num dim">{fmtBig(t.mcapUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
