import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { BotSummary } from '@punklabz/shared';
import { api } from '../lib/api';
import { Panel } from '../components/Panel';
import { arrow, fmtUsd, fmtPct, pillClass } from '../lib/format';
import { useAuth } from '../lib/auth';

export function Explore() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void api.get<{ bots: BotSummary[] }>('/api/bots').then((r) => setBots(r.bots));
  }, []);

  const clone = async (botId: number) => {
    setNotice('');
    try {
      const res = await api.post<{ botId: number }>(`/api/bots/${botId}/clone`);
      navigate(`/bots/${res.botId}`);
    } catch (e: any) {
      setNotice(e.message);
    }
  };

  const quantBots = bots
    .filter((b) => b.kind === 'quant')
    .sort((a, b) => b.pnlPct24h - a.pnlPct24h);
  const cloneCount = (id: number) => bots.filter((b) => b.clonedFromBotId === id).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Explore</div>
          <div className="page-sub">
            Clone another quant's bot for $10 — every dollar goes to its creator.
          </div>
        </div>
      </div>
      {notice && <div className="banner bad" style={{ marginBottom: 12, border: '1px solid var(--border)' }}>{notice}</div>}

      <Panel title="Bot market" sub="community strategies, ranked by 24h performance" noPad>
        <div className="table-scroll">
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>bot</th>
                <th>creator</th>
                <th className="num">equity</th>
                <th className="num">24h</th>
                <th className="num">trades</th>
                <th className="num">clones</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {quantBots.length === 0 && (
                <tr>
                  <td colSpan={7} className="dim">
                    No community bots yet. <Link to="/build">Build the first one →</Link>
                  </td>
                </tr>
              )}
              {quantBots.map((b) => (
                <tr key={b.id}>
                  <td><Link to={`/bots/${b.id}`}>{b.name}</Link></td>
                  <td className="soft">{b.ownerName}</td>
                  <td className="num">${fmtUsd(b.equityUsd, 0)}</td>
                  <td className="num">
                    <span className={`pill ${pillClass(b.pnlPct24h)}`}>
                      {fmtPct(b.pnlPct24h)} {arrow(b.pnlPct24h)}
                    </span>
                  </td>
                  <td className="num">{b.tradeCount}</td>
                  <td className="num">{cloneCount(b.id)}</td>
                  <td className="num">
                    {user && b.ownerName !== user.displayName ? (
                      <button onClick={() => clone(b.id)}>Clone · $10</button>
                    ) : !user ? (
                      <Link to="/login" className="dim">log in to clone</Link>
                    ) : (
                      <span className="dim">yours</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
