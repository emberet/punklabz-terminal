import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityEventView } from '@punklabz/shared';
import { BADGES } from '@punklabz/shared';
import { api } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Panel } from '../components/Panel';
import { fmtUsd, fmtTime, fmtDate, fmtPct } from '../lib/format';

function eventText(e: ActivityEventView): { icon: string; text: JSX.Element } {
  const actor = e.actorUserId ? (
    <Link to={`/u/${e.actorUserId}`}>{e.actorName ?? `user #${e.actorUserId}`}</Link>
  ) : (
    <span>punklabz</span>
  );
  const bot = e.botId ? <Link to={`/bots/${e.botId}`}>{e.botName ?? `bot #${e.botId}`}</Link> : null;
  switch (e.type) {
    case 'deploy':
      return { icon: '⚡', text: <>{actor} deployed {bot}</> };
    case 'clone':
      return { icon: '⧉', text: <>{actor} cloned {bot}</> };
    case 'badge': {
      const b = BADGES[String(e.payload.badge)] ?? { label: String(e.payload.badge) };
      return { icon: '◈', text: <>{actor} earned <span className="amber">{b.label}</span></> };
    }
    case 'big_win':
      return {
        icon: '▲',
        text: <>{bot} banked <span className="acid">+${fmtUsd(Number(e.payload.pnlUsd ?? 0))}</span></>,
      };
    case 'rank_change':
      return {
        icon: '↑',
        text: <>{bot} entered the top 3 ({fmtPct(Number(e.payload.pnlPct ?? 0))} 24h)</>,
      };
    case 'season_start':
      return { icon: '▶', text: <><span className="acid">{String(e.payload.name)}</span> has begun</> };
    case 'season_end':
      return { icon: '⏹', text: <><span className="acid">{String(e.payload.name)}</span> is over</> };
    default:
      return { icon: '·', text: <>{e.type}</> };
  }
}

export function Feed() {
  const [events, setEvents] = useState<ActivityEventView[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);

  const load = (before?: number) =>
    api
      .get<{ events: ActivityEventView[]; nextBefore: number | null }>(
        `/api/feed?limit=50${before ? `&before=${before}` : ''}`,
      )
      .then((r) => {
        setEvents((prev) => (before ? [...prev, ...r.events] : r.events));
        setNextBefore(r.nextBefore);
      });

  useEffect(() => {
    void load();
    const un = wsClient.sub('feed', (d) => {
      setEvents((prev) => [d as ActivityEventView, ...prev].slice(0, 200));
    });
    return un;
  }, []);

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <div className="page-title">Feed</div>
          <div className="page-sub">Everything happening in the arena, live.</div>
        </div>
      </div>
      <Panel title="ACTIVITY ▸ LIVE" term noPad right={<span className="chip chip-running">LIVE</span>}>
        <div className="tape" style={{ maxHeight: 560 }}>
          {events.length === 0 && <div className="tape-row dim">quiet in here — deploy something</div>}
          {events.map((e) => {
            const { icon, text } = eventText(e);
            return (
              <div className="tape-row" key={e.id} style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>
                <span className="t">{Date.now() - e.ts < 86_400_000 ? fmtTime(e.ts) : fmtDate(e.ts)}</span>
                <span className="acid">{icon}</span>
                <span>{text}</span>
              </div>
            );
          })}
        </div>
        {nextBefore && (
          <div className="chat-input">
            <button onClick={() => load(nextBefore)}>Load more</button>
          </div>
        )}
      </Panel>
    </div>
  );
}
