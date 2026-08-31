import { useState } from 'react';
import { Panel } from '../components/Panel';

export function Learn() {
  const [advanced, setAdvanced] = useState(false);

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <div className="page-title">Learn</div>
          <div className="page-sub">How Punklabz works — no jargon required.</div>
        </div>
        <button onClick={() => setAdvanced(!advanced)}>{advanced ? 'Back to basics' : 'Advanced docs'}</button>
      </div>

      {!advanced ? (
        <>
          <Panel title="What is this?">
            <p>
              Punklabz is an AI trading arena. Five house bots trade live crypto market data with
              simulated money, and anyone can build their own bot — in plain English, no code — and
              compete on the leaderboard. <span className="amber">Everything here is paper trading.
              No real funds are ever traded.</span>
            </p>
          </Panel>

          <Panel title="The house bots">
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr><td className="acid">MOMENTUM RUNNER</td><td className="soft">Rides trends on BTC/ETH/SOL — buys breakouts confirmed by volume, exits when the trend turns.</td></tr>
                  <tr><td className="acid">MEAN REVERSION</td><td className="soft">Buys panic dips and sells the bounce.</td></tr>
                  <tr><td className="acid">GRID TRADER</td><td className="soft">Buys as price steps down from the daily open, sells rung by rung as it recovers.</td></tr>
                  <tr><td className="acid">PUMP SNIPER</td><td className="soft">Tiny, fast bets on brand-new pump.fun launches. Ruthless exits.</td></tr>
                  <tr><td className="acid">HERD SENTIMENT</td><td className="soft">Waits for a crowd forming around a new token and rides it with a trailing stop.</td></tr>
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Building a bot">
            <p>
              Go to <b>Build</b>, describe your idea ("buy ETH when it drops hard, sell on a 4% bounce"),
              and the AI turns it into a strategy you can read — entry rules, exit rules, risk limits.
              Backtest it on real historical data, then deploy it for $20 in demo credits. Your bot
              trades live in the arena from that moment.
            </p>
          </Panel>

          <Panel title="Credits">
            <div className="table-scroll">
              <table>
                <tbody>
                  <tr><td className="acid">$100</td><td className="soft">free demo credits when you sign up</td></tr>
                  <tr><td className="soft">$20</td><td className="soft">deploy a bot you built</td></tr>
                  <tr><td className="soft">$10</td><td className="soft">clone someone else's bot — the full $10 goes to its creator</td></tr>
                  <tr><td className="soft">$1</td><td className="soft">per trade your bot makes</td></tr>
                </tbody>
              </table>
            </div>
            <p className="dim" style={{ marginTop: 8 }}>
              Run out of credits and your bots pause (they'll still close open positions). Credits
              are demo currency — no real payments exist on this platform.
            </p>
          </Panel>

          <Panel title="Scoring & payouts">
            <p className="soft">
              The leaderboard ranks every bot by profit percentage, win rate and drawdown. Each day
              the house bots' profits are split among PunkLabz token holders with 1M+ tokens —
              computed by audited deterministic code, narrated by the manager agent. (Holder data is
              simulated until the token launches.)
            </p>
          </Panel>
        </>
      ) : (
        <>
          <Panel title="STRATEGY DSL" term>
            <p className="soft">
              Bots run a validated JSON config, never generated code: entry/exit condition trees
              (all/any/not, depth ≤ 3, ≤ 10 leaves) over whitelisted indicators — sma, ema, rsi,
              bollinger bands, atr, volume SMA, price change % — with ops lt/lte/gt/gte/crossAbove/crossBelow.
              A risk block is mandatory: stopLossPct, cooldownMinutes ≥ 1, maxTradesPerDay ≤ 100,
              positionSizePct ≤ 25. Long-only spot on BTCUSDT/ETHUSDT/SOLUSDT.
            </p>
          </Panel>
          <Panel title="EXECUTION ENGINE" term>
            <p className="soft">
              Event-driven engine on closed candles (Binance WS, Coinbase fallback) + pump.fun events
              (PumpPortal WS). Strategies emit intents; a paper executor fills at mark ± slippage
              (5bps majors, 1.5% pump tokens) + 10bps fee. Every fill is one SQLite transaction:
              order, trade, position, cash, trade tax. All state survives restarts.
            </p>
          </Panel>
          <Panel title="BACKTESTER" term>
            <p className="soft">
              Backtests replay stored candles through the exact same strategy interpreter with a
              virtualized clock and an in-memory broker mirroring live slippage/fees. 24h/7d run on
              your bot's interval; 30d/90d require the 1h interval (older 1m data is pruned).
              Results are indicative — live fills use tick data, backtests use bar closes.
            </p>
          </Panel>
          <Panel title="PAYOUT PIPELINE" term>
            <p className="soft">
              Daily epoch: deterministic pro-rata math over a holder snapshot (≥1M threshold),
              BigInt precision, hash-chained audit log. The Claude narration layer can flag an epoch
              for review but can never change an amount; approval recomputes everything and refuses
              mismatches. Signer is a stub until the PunkLabz token exists.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
