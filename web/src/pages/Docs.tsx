import { Panel } from '../components/Panel';

export function Docs() {
  return (
    <div style={{ maxWidth: 820 }}>
      <Panel title="DOCS // HOW IT WORKS">
        <p>
          PUNKLABZ TERMINAL is a paper-trading arena. Five house bots trade live market data
          (Binance majors + pump.fun launches) with simulated balances. Anyone can build their own
          bot with the Toolkit and compete on the Leaderboard. <span className="amber">No real
          funds are traded anywhere on this platform.</span>
        </p>
      </Panel>

      <Panel title="THE HOUSE BOTS">
        <table>
          <tbody>
            <tr><td className="cyan">MOMENTUM RUNNER</td><td className="dim">EMA 9/21 crossover + volume confirmation on 15m majors. Rides trends, exits on cross-down or −3% stop.</td></tr>
            <tr><td className="cyan">MEAN REVERSION</td><td className="dim">Buys RSI&lt;30 + lower Bollinger touches on 5m majors, exits at RSI 50.</td></tr>
            <tr><td className="cyan">GRID TRADER</td><td className="dim">Ladder rebalance around the daily open — buys rungs down, unwinds rungs up, farming range volatility.</td></tr>
            <tr><td className="cyan">PUMP SNIPER</td><td className="dim">Tiny early entries into hot pump.fun launches (≥8 unique buyers in 60s). +50% / −30% / 10min exits.</td></tr>
            <tr><td className="cyan">HERD SENTIMENT</td><td className="dim">Waits for sustained buy pressure on 2–20min-old tokens, rides with a 20% trailing stop.</td></tr>
          </tbody>
        </table>
      </Panel>

      <Panel title="FEES (DEMO CREDITS)">
        <table>
          <tbody>
            <tr><td className="green">$100</td><td className="dim">demo credit on signup</td></tr>
            <tr><td className="magenta">$20</td><td className="dim">deploy your own bot → platform</td></tr>
            <tr><td className="magenta">$10</td><td className="dim">clone another quant's bot → 100% to its creator</td></tr>
            <tr><td className="magenta">$1</td><td className="dim">per trade your bot executes → platform</td></tr>
          </tbody>
        </table>
        <p className="dim" style={{ marginTop: 8 }}>
          If your balance hits zero your bots pause (exits still run). All billing is a mock ledger
          for now — no real payments are collected.
        </p>
      </Panel>

      <Panel title="PROFIT DISTRIBUTION">
        <p className="dim">
          Each epoch (daily), house-bot realized profits are split pro-rata among PunkLabz holders
          with ≥ 1,000,000 tokens. Payout math is deterministic, hash-chained, and re-verified at
          approval time. The manager agent (Claude) narrates each epoch and flags anomalies for
          human review — it cannot alter amounts. Holder data is currently a mock snapshot; it
          swaps to live Solana holder data when the PunkLabz token launches. Payout signatures are
          stubs until then.
        </p>
      </Panel>

      <Panel title="THE STRATEGY DSL">
        <p className="dim">
          The builder agent turns plain English into a constrained JSON config: entry/exit condition
          trees over whitelisted indicators (SMA, EMA, RSI, Bollinger, ATR, volume, price change)
          with a mandatory risk block (stop loss, cooldown, max trades/day). It never generates
          code — every config is validated before it can trade. Long-only spot on BTC/ETH/SOL.
        </p>
      </Panel>
    </div>
  );
}
