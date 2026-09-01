import { createHash } from 'node:crypto';
import type { SwapIntent } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { CAPITAL_STAGES } from '@punklabz/shared';
import { formatUnits } from 'viem';
import { accountBook, accountForMode } from './accounts.js';
import { rawHoldings } from './rawAssetLedger.js';
import { activeUniverse, currentJurisdictionAttestation, runtimeAssetGate, universeAssets } from '../robinhood/universe.js';
import { signerAmountPolicyGate } from './signing/universePolicy.js';

export interface SwapIntentResult {
  intent: SwapIntent | null;
  blockers: string[];
}

export function buildSwapIntentFromCouncil(db: DB, councilRunId: number, botId: number, now = Date.now()): SwapIntentResult {
  const blockers: string[] = [];
  const snapshot = activeUniverse(db);
  if (!snapshot) return { intent: null, blockers: ['no active universe snapshot'] };
  const council = db.prepare(
    `SELECT r.*, c.sell_symbol, c.buy_symbol, c.sell_contract, c.buy_contract,
            c.sell_amount_raw, c.source_value_micro
     FROM trading_council_runs r
     JOIN pair_sweep_candidates c ON c.id=r.candidate_id
     JOIN pair_sweep_runs s ON s.id=r.sweep_id
     WHERE r.id=? AND r.state='approved' AND s.state='complete' AND s.snapshot_id=?`,
  ).get(councilRunId, snapshot.id) as any;
  if (!council) return { intent: null, blockers: ['council approval is missing or belongs to another snapshot'] };
  if (council.approvals < 3 || council.risk_approved !== 1 || council.manager_approved !== 1 || council.model_score < 90) {
    blockers.push('council quorum, mandatory vetoes, or model score is insufficient');
  }
  const assets = universeAssets(db, snapshot.id);
  const sell = assets.find((a) => a.contractAddress === String(council.sell_contract).toLowerCase());
  const buy = assets.find((a) => a.contractAddress === String(council.buy_contract).toLowerCase());
  if (!sell || !buy) return { intent: null, blockers: ['candidate contracts are not pinned in the active snapshot'] };
  if (sell.symbol !== council.sell_symbol || buy.symbol !== council.buy_symbol) blockers.push('candidate symbols do not match pinned contracts');
  const sellGate = runtimeAssetGate(db, snapshot.id, sell, now);
  const buyGate = runtimeAssetGate(db, snapshot.id, buy, now);
  blockers.push(...sellGate.reasons.map((r) => `sell: ${r}`), ...buyGate.reasons.map((r) => `buy: ${r}`));
  if (!sellGate.referencePriceUsd || !buyGate.referencePriceUsd) blockers.push('fresh multiplier-adjusted reference prices are required');

  const account = accountForMode(db, 'canary', 'evm:robinhood');
  if (!account.walletAddress) blockers.push('Trader execution account is not bound to a wallet');
  if (['STOCK_TOKEN', 'ETF_TOKEN', 'RWA'].includes(sell.assetClass)
    || ['STOCK_TOKEN', 'ETF_TOKEN', 'RWA'].includes(buy.assetClass)) {
    if (!account.walletAddress || !currentJurisdictionAttestation(db, account.walletAddress)) {
      blockers.push('current non-U.S./non-restricted-jurisdiction operator attestation is required');
    }
  }
  let sellRaw = 0n;
  try { sellRaw = BigInt(council.sell_amount_raw); } catch { blockers.push('candidate sell amount is not an integer'); }
  const signerAmountGate = signerAmountPolicyGate(db, snapshot.id, sell, sellRaw);
  if (!signerAmountGate.eligible) blockers.push(signerAmountGate.reason);
  const holding = rawHoldings(db, account.id).get(sell.contractAddress) ?? 0n;
  if (holding < sellRaw) blockers.push(`source holding ${holding} is below requested ${sellRaw}`);

  const exit = buy.symbol === 'USDG' ? { ok: true } : db.prepare(
    `SELECT 1 ok FROM pair_sweep_candidates c
     JOIN pair_sweep_runs s ON s.id=c.sweep_id
     WHERE s.id=? AND c.sell_contract=? AND lower(c.buy_contract)=lower(?)
       AND c.rejection_code IS NULL LIMIT 1`,
  ).get(council.sweep_id, buy.contractAddress, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168') as any;
  if (!exit) blockers.push(`no viable ${buy.symbol}/USDG exit in the same complete sweep`);
  const sourceValueUsd = Number(council.source_value_micro) / 1_000_000;
  if (!(sourceValueUsd > 0) || sourceValueUsd > 0.5) blockers.push('source value exceeds the $0.50 hard ceiling');

  const cfg = db.prepare(
    `SELECT halted, autonomy_enabled, full_market_autonomy, authorized_capital_usdg,
            active_universe_hash, expected_signer_policy_hash, observed_signer_policy_hash
     FROM live_config WHERE id=1`,
  ).get() as any;
  if (cfg.halted === 1 || cfg.autonomy_enabled !== 1 || cfg.full_market_autonomy !== 1) blockers.push('full-market execution autonomy is not armed');
  if (cfg.active_universe_hash !== snapshot.contentHash) blockers.push('live config universe hash mismatch');
  if (!cfg.expected_signer_policy_hash || cfg.expected_signer_policy_hash !== cfg.observed_signer_policy_hash) {
    blockers.push('signer policy hash is absent or mismatched');
  }
  const authorized = Number(cfg.authorized_capital_usdg);
  if (!Number.isFinite(authorized) || authorized <= 0) blockers.push('activation-time authorized capital is not recorded');
  if (Number.isFinite(authorized) && authorized > 0) {
    const live = db.prepare(`SELECT capital_stage, limits_json FROM live_config WHERE id=1`).get() as any;
    const limits = JSON.parse(live.limits_json);
    const effectiveCapital = Math.min(authorized, CAPITAL_STAGES[live.capital_stage] ?? 0);
    const maxTrade = Math.min(0.5, effectiveCapital * limits.maxPerTradePct / 100);
    if (sourceValueUsd > maxTrade + 1e-9) blockers.push(`trade $${sourceValueUsd} exceeds effective cap $${maxTrade}`);
    const holdings = rawHoldings(db, account.id);
    const usdgContract = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const usdg = Number(formatUnits(holdings.get(usdgContract) ?? 0n, 6));
    const reserve = effectiveCapital * limits.minCashReservePct / 100;
    const commitments = (db.prepare(
      `SELECT COALESCE(SUM(approved_notional_micro),0) n FROM live_orders
       WHERE execution_account_id=? AND sell_symbol='USDG'
         AND state IN ('risk_approved','submitting','submitted','pending','open','partial')`,
    ).get(account.id) as { n: number }).n / 1_000_000;
    if (sell.symbol === 'USDG' && usdg - commitments - sourceValueUsd < reserve - 1e-9) {
      blockers.push(`USDG reserve would fall below ${limits.minCashReservePct}%`);
    }
    const positionContracts = new Set([...holdings.entries()]
      .filter(([contract, raw]) => raw > 0n && contract !== usdgContract
        && contract !== '0x0000000000000000000000000000000000000000')
      .map(([contract]) => contract));
    if (buy.symbol !== 'USDG' && !positionContracts.has(buy.contractAddress)
      && positionContracts.size >= limits.maxSimultaneousPositions) blockers.push('maximum simultaneous positions reached');
    const book = accountBook(db, account.id, effectiveCapital);
    if (-book.todayPnlUsd >= effectiveCapital * limits.maxDailyLossPct / 100) blockers.push('daily loss halt is active');
    if (book.drawdownPct >= limits.maxTotalDrawdownPct) blockers.push('total drawdown halt is active');
  }
  if (blockers.length) return { intent: null, blockers };

  const idempotencyKey = createHash('sha256').update(JSON.stringify({
    councilRunId, botId, accountId: account.id, snapshot: snapshot.contentHash,
    sell: sell.contractAddress, buy: buy.contractAddress, sellRaw: sellRaw.toString(),
  })).digest('hex');
  return {
    blockers: [],
    intent: {
      intentId: `swap:${idempotencyKey}`,
      idempotencyKey,
      botId,
      executionAccountId: account.id,
      chainId: 4663,
      registrySnapshotHash: snapshot.contentHash,
      councilRunId,
      sell: { symbol: sell.symbol, contractAddress: sell.contractAddress, decimals: sell.decimals,
        amountRaw: sellRaw.toString(), referencePriceUsd: sellGate.referencePriceUsd! },
      buy: { symbol: buy.symbol, contractAddress: buy.contractAddress, decimals: buy.decimals,
        referencePriceUsd: buyGate.referencePriceUsd! },
      sourceValueUsd,
      modelScore: council.model_score,
      signalEvidence: { sweepId: council.sweep_id, councilRunId, sources: JSON.parse(council.sources_json ?? '[]') },
      createdAt: now,
    },
  };
}

export function persistSwapOrder(db: DB, intent: SwapIntent, mode: 'canary' | 'live'): number {
  const existing = db.prepare(`SELECT id FROM live_orders WHERE intent_id=?`).get(intent.intentId) as { id: number } | undefined;
  if (existing) return existing.id;
  const side = intent.sell.symbol === 'USDG' ? 'buy' : 'sell';
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO live_orders
      (intent_id, execution_account_id, bot_id, instrument_id, venue, side, order_type,
       requested_notional_micro, approved_notional_micro, mode, state, confidence, risk_json,
       expected_price, capital_stage, signal_ts, created_at, updated_at,
       sell_symbol, buy_symbol, sell_contract, buy_contract, sell_decimals, buy_decimals,
       sell_amount_raw, registry_snapshot_hash, council_run_id, reconciliation_status)
     VALUES (?, ?, ?, ?, 'evm:robinhood', ?, 'market', ?, ?, ?, 'risk_approved', ?, ?, ?,
       (SELECT capital_stage FROM live_config WHERE id=1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(intent.intentId, intent.executionAccountId, intent.botId,
    `RH://${intent.chainId}/${intent.sell.symbol}-${intent.buy.symbol}`, side,
    Math.round(intent.sourceValueUsd * 1_000_000), Math.round(intent.sourceValueUsd * 1_000_000), mode,
    intent.modelScore, JSON.stringify({ councilRunId: intent.councilRunId, signalEvidence: intent.signalEvidence }),
    intent.sell.referencePriceUsd / intent.buy.referencePriceUsd, intent.createdAt, now, now,
    intent.sell.symbol, intent.buy.symbol, intent.sell.contractAddress, intent.buy.contractAddress,
    intent.sell.decimals, intent.buy.decimals, intent.sell.amountRaw, intent.registrySnapshotHash, intent.councilRunId);
  return Number(info.lastInsertRowid);
}
