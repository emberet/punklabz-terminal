import { useState } from 'react';
import { Panel } from '../components/Panel';
import { usePageMeta } from '../lib/pageMeta';

interface Doc {
  name: string;
  size: string;
  classified?: boolean;
  body: JSX.Element;
}

const DOCS: Doc[] = [
  {
    name: 'START_HERE.txt',
    size: '1.2K',
    body: (
      <>
        <h3>What is this</h3>
        <p>
          Punklabz is an autonomous market research network. Arena and user machines use paper
          credits. A separate, operator-controlled Robinhood Chain execution account may run a
          staged WETH/USDG mainnet canary after reconciliation and preflight. Paper performance
          never becomes real wallet money.
        </p>
        <h3>The loop</h3>
        <p>DISCOVER → BUILD → BACKTEST → DEPLOY → WATCH → COMPETE → GET CLONED → IMPROVE.</p>
        <p>
          Go to LAB. Describe an idea. Backtest it. Deploy it for 20 credits. Watch it fight.
          When another operator clones it, the 10-credit fee is yours.
        </p>
      </>
    ),
  },
  {
    name: 'HOW_MACHINES_WORK.txt',
    size: '2.4K',
    body: (
      <>
        <h3>House machines</h3>
        <p>MOMENTUM RUNNER — hunts momentum while everyone sleeps. EMA 9/21 crossover + volume confirmation, 15m.</p>
        <p>MEAN REVERSION — everything returns eventually. Buys RSI&lt;30 panic + lower Bollinger touches, 5m.</p>
        <p>GRID TRADER — does not predict, only reacts. Ladders buys below the daily open, unwinds rung by rung.</p>
        <p>PUMP SNIPER — rare entries, violent exits. Tiny early shots at hot pump.fun launches; +50% / −30% / 10min.</p>
        <p>HERD SENTIMENT — the crowd is a signal, not a friend. Rides sustained buy pressure with a trailing stop.</p>
        <h3>Execution</h3>
        <p>
          Event-driven engine on closed candles (Binance, Coinbase fallback) and pump.fun launch
          events. Arena machines use a paper executor. Mainnet-eligible ETH signals pass through a
          separate resolver, risk engine, 0x quote validator, Privy signer, receipt decoder, and
          onchain reconciliation path.
        </p>
      </>
    ),
  },
  {
    name: 'STRATEGY_LANGUAGE.txt',
    size: '1.8K',
    body: (
      <>
        <h3>The DSL</h3>
        <p>
          Machines run a validated JSON config, never generated code: entry/exit condition trees
          (all/any/not, depth ≤ 3, ≤ 10 leaves) over whitelisted indicators — SMA, EMA, RSI,
          Bollinger bands, ATR, volume SMA, price change % — with ops lt/lte/gt/gte/crossAbove/crossBelow.
        </p>
        <p>
          A risk block is mandatory: stop loss, cooldown ≥ 1min, ≤ 100 trades/day, position ≤ 25%.
          Long-only spot on BTC/ETH/SOL. The LAB writes this language for you.
        </p>
        <h3>Personality</h3>
        <p>
          An operator can give a machine a written personality. It is distilled into bounded traits
          (aggression, patience, risk tolerance) that tilt position size, cooldown, trade caps and
          stops — within hard limits. The machine chats and trades in character.
        </p>
      </>
    ),
  },
  {
    name: 'RISK_PROTOCOL.txt',
    size: '1.1K',
    body: (
      <>
        <h3>Backtests</h3>
        <p>
          Backtests replay stored candles through the exact live strategy interpreter with a
          virtualized clock and identical fill math. Results are indicative — history, not prophecy.
          Coverage warnings tell you when data is thin.
        </p>
        <h3>The RR tool</h3>
        <p>
          The Playground computes the empirical probability that a target is hit before a stop,
          from the last 7 days of 1m candles, plus what leverage does to the math. At Nx leverage a
          100/N% adverse move is liquidation.
        </p>
        <p className="amber">Nothing in this system is financial advice. Paper and backtest results do not predict mainnet performance.</p>
      </>
    ),
  },
  {
    name: 'ECONOMY.txt',
    size: '0.9K',
    body: (
      <>
        <h3>Credits</h3>
        <p>100 credits on signup · 20 to deploy a machine · 10 to clone (all 10 go to the creator) · <b>1% of traded notional</b> on every trade your machine makes, collected by the manager account.</p>
        <p>
          Run dry and your machines pause (they still close open positions). Credits are demo
          currency. No payment rails exist here.
        </p>
        <h3>Payouts</h3>
        <p>
          Historical payout epochs are demo-credit accounting only. Real payouts are disabled and
          cannot access the USDG execution wallet. Holder data remains simulated until a separate
          payment system is reviewed and launched.
        </p>
      </>
    ),
  },
  {
    name: 'SEASONS.txt',
    size: '0.7K',
    body: (
      <>
        <h3>Seasons</h3>
        <p>
          Fourteen-day competitive windows. Season P&L is measured from your machine's equity at
          season start — no resets, no wipes. Top 10 at close earn badges and XP. Past seasons are
          archived permanently in RANKS.
        </p>
        <h3>Progression</h3>
        <p>XP from deploys, trades, backtests, clones received, season finishes and daily logins. LURKER → PAPERHAND → TRADER → STRATEGIST → QUANT → SHARK → WHALE → LEGEND.</p>
      </>
    ),
  },
  {
    name: 'CLASSIFIED/NODE_00.txt',
    size: '0.1K',
    classified: true,
    body: (
      <>
        <h3 className="uv">recovered fragment · undated</h3>
        <p className="uv">"there were six house machines."</p>
        <p className="dim">the public system lists five.</p>
        <p className="dim">— file recovered from /var/punklabz/unknown/. provenance disputed. the terminal knows more.</p>
      </>
    ),
  },
];

export function Learn() {
  usePageMeta('Archive', 'How PunkLabz works: strategies, risk limits, scoring and the execution path.');
  const [open, setOpen] = useState<Doc | null>(null);

  return (
    <div style={{ maxWidth: 780 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Archive</h1>
          <div className="page-sub">/var/punklabz/archive — documentation and recovered files</div>
        </div>
        {open && <button onClick={() => setOpen(null)}>← index</button>}
      </div>

      {!open ? (
        <Panel title="/ARCHIVE" term noPad>
          <div className="filelist">
            {DOCS.map((d) => (
              <div key={d.name} className={`frow ${d.classified ? 'classified' : ''}`} onClick={() => setOpen(d)}>
                <span>{d.classified ? '▩' : '▤'}</span>
                <span>{d.name}</span>
                <span className="fsize">{d.size}</span>
              </div>
            ))}
          </div>
        </Panel>
      ) : (
        <Panel title={open.name} term noPad>
          <div className="docview">{open.body}</div>
        </Panel>
      )}
    </div>
  );
}
