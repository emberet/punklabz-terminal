import type { DB } from '../db/db.js';
import type { ExecutionAdapter } from './adapters.js';
import type { NewsItem } from '../feeds/newsFeed.js';
import { FullPairScanner, prunePairSweepDetails } from './pairScanner.js';
import { pollUniverseReferences } from '../robinhood/referencePoller.js';
import { runTradingCouncil } from './tradingCouncil.js';
import { buildSwapIntentFromCouncil, persistSwapOrder } from './swapIntent.js';
import { haltNetwork } from './riskEngine.js';
import { accountForMode } from './accounts.js';
import type { TradingSigner } from './signing/signer.js';
import { verifyActiveUniversePolicy } from './signing/universePolicy.js';

export class FullMarketAutonomy {
  private running = false;

  constructor(
    private db: DB,
    private adapter: ExecutionAdapter,
    private signer: TradingSigner,
    private news: () => NewsItem[],
    private ethUsd: () => number | null,
  ) {}

  async cycle(): Promise<{ ran: boolean; reason: string; orderId?: number }> {
    if (this.running) return { ran: false, reason: 'prior full-market cycle is still running' };
    const cfg = this.db.prepare(
      `SELECT mode, halted, autonomy_enabled, full_market_autonomy, limits_json FROM live_config WHERE id=1`,
    ).get() as any;
    if (cfg.halted || !cfg.autonomy_enabled || !cfg.full_market_autonomy || cfg.mode !== 'canary') {
      return { ran: false, reason: 'full-market autonomy is not armed' };
    }
    if (!this.adapter.placeSwapIntent) return { ran: false, reason: 'execution adapter lacks directed-swap support' };
    this.running = true;
    let orderId: number | null = null;
    try {
      const signerPolicy = await verifyActiveUniversePolicy(this.db, this.signer);
      if (!signerPolicy.ok) {
        haltNetwork(this.db, signerPolicy.detail, 'full-market');
        return { ran: false, reason: 'signer policy content drifted or is unreadable; network halted' };
      }
      const account = accountForMode(this.db, 'canary', 'evm:robinhood');
      if (!account.walletAddress || !this.adapter.getConservativeNav) {
        haltNetwork(this.db, 'full-market NAV cannot be derived from executable exits', 'full-market');
        return { ran: false, reason: 'full-market NAV unavailable; network halted' };
      }
      const nav = await this.adapter.getConservativeNav(account.walletAddress);
      if (!nav.ok) {
        haltNetwork(this.db, `unpriced or unexitable holdings: ${nav.blockers.join('; ')}`, 'full-market');
        return { ran: false, reason: 'portfolio cannot be conservatively valued; network halted' };
      }
      const now = Date.now();
      this.db.prepare(
        `INSERT INTO full_market_nav_snapshots
         (execution_account_id,total_micro,settlement_micro,holdings_json,valuation_method,ts)
         VALUES (?,?,?,?, 'executable_min_to_usdg',?)`,
      ).run(account.id, Math.round(nav.totalUsd * 1_000_000), Math.round(nav.settlementUsd * 1_000_000),
        JSON.stringify(nav.holdings), now);
      const authorized = Number((this.db.prepare(`SELECT authorized_capital_usdg n FROM live_config WHERE id=1`).get() as any).n);
      const limits = JSON.parse(cfg.limits_json);
      const peak = (this.db.prepare(
        `SELECT MAX(total_micro) n FROM full_market_nav_snapshots WHERE execution_account_id=?`,
      ).get(account.id) as { n: number }).n / 1_000_000;
      const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
      const dayOpen = (this.db.prepare(
        `SELECT total_micro n FROM full_market_nav_snapshots
         WHERE execution_account_id=? AND ts>=? ORDER BY ts LIMIT 1`,
      ).get(account.id, dayStart) as { n: number }).n / 1_000_000;
      const drawdownPct = peak > 0 ? ((peak - nav.totalUsd) / peak) * 100 : 0;
      const dailyLossPct = dayOpen > 0 ? ((dayOpen - nav.totalUsd) / dayOpen) * 100 : 0;
      if (drawdownPct >= limits.maxTotalDrawdownPct || dailyLossPct >= limits.maxDailyLossPct) {
        haltNetwork(this.db, `portfolio loss gate: drawdown ${drawdownPct.toFixed(2)}%, daily ${dailyLossPct.toFixed(2)}%`, 'full-market');
        return { ran: false, reason: 'portfolio loss gate engaged; network halted' };
      }
      if (!Number.isFinite(authorized) || nav.settlementUsd < authorized * limits.minCashReservePct / 100) {
        haltNetwork(this.db, 'reconciled USDG reserve is below the configured floor', 'full-market');
        return { ran: false, reason: 'USDG reserve gate engaged; network halted' };
      }
      const references = await pollUniverseReferences(this.db, { ethUsd: this.ethUsd() ?? 0 });
      if (references.failed.length) return { ran: false, reason: `${references.failed.length} reference prices failed; no sweep trade` };
      let refreshInFlight: Promise<unknown> | null = null;
      const refreshTimer = setInterval(() => {
        if (!refreshInFlight) {
          refreshInFlight = pollUniverseReferences(this.db, { ethUsd: this.ethUsd() ?? 0 })
            .finally(() => { refreshInFlight = null; });
        }
      }, 45_000);
      let sweep;
      try {
        sweep = await new FullPairScanner(this.db, { ethUsd: this.ethUsd() ?? 0 }).run();
      } finally {
        clearInterval(refreshTimer);
        await refreshInFlight;
      }
      if (sweep.state !== 'complete') return { ran: false, reason: `sweep ${sweep.state}: ${sweep.error ?? 'incomplete'}` };
      const policyAfterSweep = await verifyActiveUniversePolicy(this.db, this.signer);
      if (!policyAfterSweep.ok) {
        haltNetwork(this.db, policyAfterSweep.detail, 'full-market');
        return { ran: false, reason: 'signer policy changed during the sweep; network halted' };
      }
      prunePairSweepDetails(this.db);
      const sources = this.news().map((item, index) => ({ id: `news:${item.source}:${item.ts}:${index}`,
        title: item.title, url: item.link, source: item.source, ts: item.ts }));
      const council = await runTradingCouncil(this.db, sweep.runId, sources);
      if (council.state !== 'approved' || !council.runId) return { ran: false, reason: council.reason };
      const allocation = this.db.prepare(
        `SELECT bot_id FROM manager_capital_allocations WHERE active=1 AND allocated_usdg>0 ORDER BY allocated_usdg DESC LIMIT 1`,
      ).get() as { bot_id: number } | undefined;
      if (!allocation) return { ran: false, reason: 'Manager has not allocated capital to a Trader Agent' };
      const built = buildSwapIntentFromCouncil(this.db, council.runId, allocation.bot_id);
      if (!built.intent) return { ran: false, reason: `intent blocked: ${built.blockers.join('; ')}` };
      orderId = persistSwapOrder(this.db, built.intent, 'canary');
      const ethUsd = this.ethUsd();
      if (!ethUsd) return { ran: false, reason: 'ETH/USD gas valuation is missing' };
      const result = await this.adapter.placeSwapIntent(built.intent, {
        orderId, maxSlippageBps: Math.min(35, limits.maxSlippageBps ?? 35), safetyBufferBps: 10, ethUsd,
      });
      if (!result.accepted) {
        this.db.prepare(`UPDATE live_orders SET state='risk_rejected', reject_reason=?, updated_at=? WHERE id=?`)
          .run(result.error ?? 'directed swap refused', Date.now(), orderId);
        const signedChild = this.db.prepare(`SELECT id FROM execution_transactions WHERE order_id=?`).get(orderId);
        if (signedChild) haltNetwork(this.db, `directed order ${orderId} stopped after a child transaction: ${result.error}`, 'full-market');
        return { ran: false, reason: result.error ?? 'directed swap refused', orderId };
      }
      return { ran: true, reason: `directed swap broadcast as ${result.txRef}`, orderId };
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error).slice(0, 500);
      if (orderId !== null) {
        const child = this.db.prepare(`SELECT id FROM execution_transactions WHERE order_id=?`).get(orderId);
        if (child) haltNetwork(this.db, `directed order ${orderId} raised after creating a child transaction: ${reason}`, 'full-market');
      }
      return { ran: false, reason, ...(orderId === null ? {} : { orderId }) };
    } finally {
      this.running = false;
    }
  }
}
