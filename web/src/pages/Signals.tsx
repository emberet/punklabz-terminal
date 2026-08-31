import { useEffect, useState } from 'react';
import { Panel } from '../components/Panel';
import { usePageMeta } from '../lib/pageMeta';

interface SignalsData {
  machines: number;
  consensus: { long: number; flat: number };
  perSymbol: {
    symbol: string;
    watching: number;
    buys24h: number;
    sells24h: number;
    machinesLong: number;
  }[];
  topConditions: { name: string; machines: number }[];
  disclaimer: string;
}

function Bar({ frac, color = 'var(--phosphor)' }: { frac: number; color?: string }) {
  const width = Math.max(2, Math.round(frac * 100));
  return (
    <span style={{ display: 'inline-block', width: 140, height: 9, background: 'var(--bg-raised)', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', width: `${width}%`, height: '100%', background: color }} />
    </span>
  );
}

export function Signals() {
  usePageMeta('Signals', 'Network intelligence: regimes, opportunities and what the machines are reacting to.');
  const [data, setData] = useState<SignalsData | null>(null);

  useEffect(() => {
    const load = () => api_get();
    const api_get = () =>
      fetch('/api/signals').then((r) => r.json()).then(setData).catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!data) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">Signals</h1>
            <div className="page-sub">network intelligence</div>
          </div>
        </div>
        <div className="dim">interrogating the network…</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Signals</h1>
          <div className="page-sub">
            what {data.machines} machines are collectively doing · {data.disclaimer}
          </div>
        </div>
      </div>

      <Panel title="MACHINE CONSENSUS" sub="positioned vs waiting" noPad>
        <div className="panel-body">
          <div className="row" style={{ gap: 16, marginBottom: 8 }}>
            <span className="phos" style={{ width: 90 }}>IN POSITION</span>
            <Bar frac={data.consensus.long} />
            <span className="phos">{(data.consensus.long * 100).toFixed(0)}%</span>
          </div>
          <div className="row" style={{ gap: 16 }}>
            <span className="soft" style={{ width: 90 }}>FLAT / WAITING</span>
            <Bar frac={data.consensus.flat} color="var(--text-dim)" />
            <span className="soft">{(data.consensus.flat * 100).toFixed(0)}%</span>
          </div>
        </div>
      </Panel>

      <Panel title="NETWORK ACTIVITY BY PAIR" noPad>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>pair</th>
                <th className="num">watching</th>
                <th className="num">long now</th>
                <th className="num">buys 24h</th>
                <th className="num">sells 24h</th>
                <th>flow</th>
              </tr>
            </thead>
            <tbody>
              {data.perSymbol.map((s) => {
                const total = s.buys24h + s.sells24h;
                const buyFrac = total ? s.buys24h / total : 0.5;
                return (
                  <tr key={s.symbol}>
                    <td className="phos">{s.symbol.replace('USDT', '')}</td>
                    <td className="num">{s.watching}</td>
                    <td className="num">{s.machinesLong}</td>
                    <td className="num phos">{s.buys24h}</td>
                    <td className="num red">{s.sells24h}</td>
                    <td>
                      {total > 0 ? (
                        <>
                          <Bar frac={buyFrac} />
                          <span className="dim" style={{ marginLeft: 8, fontSize: 10 }}>
                            {(buyFrac * 100).toFixed(0)}% buy
                          </span>
                        </>
                      ) : (
                        <span className="dim">no flow</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="MOST WATCHED CONDITIONS" sub="what the machines are scanning for" noPad>
        <div className="panel-body">
          {data.topConditions.length === 0 && <span className="dim">nothing armed</span>}
          {data.topConditions.map((c) => (
            <div key={c.name} className="row" style={{ gap: 14, marginBottom: 5 }}>
              <span className="soft" style={{ width: 170, fontSize: 12 }}>{c.name}</span>
              <Bar frac={c.machines / Math.max(1, data.topConditions[0].machines)} />
              <span className="dim">{c.machines} machines</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
