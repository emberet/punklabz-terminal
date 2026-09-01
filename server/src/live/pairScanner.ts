import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { activeUniverse, runtimeAssetGate, universeAssets, type UniverseAsset } from '../robinhood/universe.js';
import { formatUnits } from 'viem';

const ZEROX_PRICE_URL = 'https://api.0x.org/swap/allowance-holder/price';
const SWEEP_DEADLINE_MS = 14 * 60_000;
const TRADE_VALUE_MICRO = 500_000;

export interface IndicativePairQuote {
  sellAmount: bigint;
  buyAmount: bigint;
  liquidityAvailable: boolean;
  totalNetworkFeeWei: bigint | null;
  observedAt: number;
  raw: unknown;
}

export interface PairScannerOptions {
  apiKey?: string;
  sustainedRps?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  deadlineMs?: number;
  skipPacing?: boolean;
  ethUsd?: number;
}

export interface PairSweepResult {
  runId: number;
  state: 'complete' | 'failed' | 'stale' | 'rate_limited';
  expectedPairs: number;
  attemptedPairs: number;
  quotedPairs: number;
  eligiblePairs: number;
  error: string | null;
}

export function numberToRaw(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new Error('token amount must be positive');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('token decimals out of range');
  const [mantissa, expText] = value.toExponential(18).split('e');
  const digits = mantissa.replace('.', '').replace(/^0+/, '') || '0';
  const exponent = Number(expText) - 18 + decimals;
  if (exponent >= 0) return BigInt(digits) * (10n ** BigInt(exponent));
  return BigInt(digits) / (10n ** BigInt(-exponent));
}

export function rawToNumber(raw: bigint, decimals: number): number {
  const text = raw.toString().padStart(decimals + 1, '0');
  const whole = decimals ? text.slice(0, -decimals) : text;
  const fraction = decimals ? text.slice(-decimals).slice(0, 18) : '';
  return Number(fraction ? `${whole}.${fraction}` : whole);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function insertRejected(
  db: DB, sweepId: number, sell: UniverseAsset, buy: UniverseAsset,
  sellRaw: bigint, code: string, detail: string, now: number,
): void {
  db.prepare(
    `INSERT INTO pair_sweep_candidates
      (sweep_id, sell_symbol, buy_symbol, sell_contract, buy_contract, sell_amount_raw,
       source_value_micro, rejection_code, rejection_detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sweepId, sell.symbol, buy.symbol, sell.contractAddress, buy.contractAddress,
    sellRaw.toString(), TRADE_VALUE_MICRO, code, detail.slice(0, 500), now);
}

export class FullPairScanner {
  private readonly apiKey: string;
  private readonly sustainedRps: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly skipPacing: boolean;
  private readonly ethUsd: number;

  constructor(private db: DB, opts: PairScannerOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ZEROX_API_KEY ?? '';
    this.sustainedRps = opts.sustainedRps ?? config.zeroXSustainedRps;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.deadlineMs = opts.deadlineMs ?? SWEEP_DEADLINE_MS;
    this.skipPacing = opts.skipPacing ?? false;
    this.ethUsd = opts.ethUsd ?? 0;
  }

  async run(): Promise<PairSweepResult> {
    if (!this.apiKey) throw new Error('ZEROX_API_KEY is required for a full pair sweep');
    if (!Number.isFinite(this.ethUsd) || this.ethUsd <= 0) {
      throw new Error('a fresh ETH/USD price is required to evaluate indicative gas cost');
    }
    const snapshot = activeUniverse(this.db);
    if (!snapshot) throw new Error('no active immutable universe snapshot');
    const existing = this.db.prepare(`SELECT id FROM pair_sweep_runs WHERE state='running'`).get();
    if (existing) throw new Error('a pair sweep is already running');
    const assets = universeAssets(this.db, snapshot.id);
    const expectedPairs = assets.length * (assets.length - 1);
    if (expectedPairs !== snapshot.directedPairCount) throw new Error('snapshot pair count mismatch');
    const routingWindowMs = Math.max(1_000, this.deadlineMs - 30_000);
    const requiredRps = expectedPairs / (routingWindowMs / 1000);
    if (!this.skipPacing && this.sustainedRps < requiredRps) {
      throw new Error(`declared 0x quota ${this.sustainedRps.toFixed(2)} rps is below required ${requiredRps.toFixed(2)} rps`);
    }
    const startedAt = this.now();
    const deadlineAt = startedAt + this.deadlineMs;
    const info = this.db.prepare(
      `INSERT INTO pair_sweep_runs
       (snapshot_id, state, expected_pairs, started_at, deadline_at) VALUES (?, 'running', ?, ?, ?)`,
    ).run(snapshot.id, expectedPairs, startedAt, deadlineAt);
    const runId = Number(info.lastInsertRowid);
    let attempted = 0;
    let quoted = 0;
    let eligible = 0;
    let state: PairSweepResult['state'] = 'failed';
    let error: string | null = null;
    let rateLimited = false;
    const intervalMs = this.skipPacing ? 0 : 1000 / this.sustainedRps;

    try {
      const pairs: { sell: UniverseAsset; buy: UniverseAsset }[] = [];
      for (const sell of assets) for (const buy of assets) {
        if (sell.contractAddress !== buy.contractAddress) pairs.push({ sell, buy });
      }
      const concurrency = this.skipPacing ? 64 : Math.max(8, Math.min(128, Math.ceil(this.sustainedRps / 2)));
      const active = new Set<Promise<void>>();
      let nextLaunchAt = this.now();

      const processPair = async (sell: UniverseAsset, buy: UniverseAsset): Promise<void> => {
        if (rateLimited || error || this.now() >= deadlineAt) return;
        attempted++;
        // Re-evaluate at launch time. A 14-minute sweep must not keep using
        // the price/session state it saw in its first second.
        const sellGate = runtimeAssetGate(this.db, snapshot.id, sell, this.now());
        const buyGate = runtimeAssetGate(this.db, snapshot.id, buy, this.now());
        let sellRaw = 0n;
        if (sellGate.referencePriceUsd) sellRaw = numberToRaw(0.5 / sellGate.referencePriceUsd, sell.decimals);
        if (!sellGate.eligible || !buyGate.eligible || sellRaw <= 0n) {
          const reasons = [...sellGate.reasons.map((r) => `sell: ${r}`), ...buyGate.reasons.map((r) => `buy: ${r}`)];
          if (sellRaw <= 0n) reasons.push('source amount rounds to zero');
          insertRejected(this.db, runId, sell, buy, sellRaw, 'asset_gate', reasons.join('; '), this.now());
          return;
        }
        const url = new URL(ZEROX_PRICE_URL);
        url.searchParams.set('chainId', '4663');
        url.searchParams.set('sellToken', sell.contractAddress);
        url.searchParams.set('buyToken', buy.contractAddress);
        url.searchParams.set('sellAmount', sellRaw.toString());
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            headers: { '0x-api-key': this.apiKey, '0x-version': 'v2' }, signal: AbortSignal.timeout(12_000),
          });
        } catch (cause) {
          error = `0x indicative request failed: ${String(cause).slice(0, 180)}`;
          return;
        }
        if (response.status === 429) {
          rateLimited = true;
          error = '0x rate limited the complete sweep';
          return;
        }
        const body = await response.json().catch(() => null) as any;
        if (!response.ok) {
          insertRejected(this.db, runId, sell, buy, sellRaw, `http_${response.status}`,
            String(body?.reason ?? body?.name ?? 'indicative quote refused'), this.now());
          return;
        }
        if (Number(body?.chainId ?? 4663) !== 4663
          || (body?.sellToken && String(body.sellToken).toLowerCase() !== sell.contractAddress)
          || (body?.buyToken && String(body.buyToken).toLowerCase() !== buy.contractAddress)) {
          insertRejected(this.db, runId, sell, buy, sellRaw, 'invalid_quote', '0x returned a different chain or token pair', this.now());
          return;
        }
        if (body?.liquidityAvailable === false) {
          insertRejected(this.db, runId, sell, buy, sellRaw, 'no_liquidity', '0x reports no route liquidity', this.now());
          return;
        }
        let buyRaw: bigint;
        try { buyRaw = BigInt(body.buyAmount); } catch { buyRaw = 0n; }
        if (buyRaw <= 0n || String(body.sellAmount) !== sellRaw.toString()) {
          insertRejected(this.db, runId, sell, buy, sellRaw, 'invalid_quote', '0x amount response is missing or inconsistent', this.now());
          return;
        }
        quoted++;
        let networkFeeWei: bigint;
        try { networkFeeWei = BigInt(body.totalNetworkFee); } catch { networkFeeWei = -1n; }
        if (networkFeeWei < 0n) {
          insertRejected(this.db, runId, sell, buy, sellRaw, 'missing_gas_estimate',
            '0x indicative quote omitted totalNetworkFee', this.now());
          return;
        }
        const buyQty = rawToNumber(buyRaw, buy.decimals);
        const buyValue = buyQty * (buyGate.referencePriceUsd ?? 0);
        const networkFeeUsd = Number(formatUnits(networkFeeWei, 18)) * this.ethUsd;
        const edgeBps = ((buyValue - 0.5 - networkFeeUsd) / 0.5) * 10_000;
        const rejection = edgeBps > 10 ? null : 'non_positive_edge';
        if (!rejection) eligible++;
        this.db.prepare(
          `INSERT INTO pair_sweep_candidates
            (sweep_id, sell_symbol, buy_symbol, sell_contract, buy_contract, sell_amount_raw,
             buy_amount_raw, source_value_micro, reference_edge_bps, indicative_quote_json,
             rejection_code, rejection_detail, rank_score, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(runId, sell.symbol, buy.symbol, sell.contractAddress, buy.contractAddress,
          sellRaw.toString(), buyRaw.toString(), TRADE_VALUE_MICRO, edgeBps.toFixed(6),
          JSON.stringify({ chainId: Number(body.chainId ?? 4663), sellAmount: body.sellAmount,
            buyAmount: body.buyAmount, liquidityAvailable: body.liquidityAvailable !== false,
            totalNetworkFee: networkFeeWei.toString(), networkFeeUsd, observedAt: this.now() }),
          rejection, rejection ? `indicative reference edge ${edgeBps.toFixed(2)}bps is not above 10bps safety margin` : null,
          edgeBps.toFixed(6), this.now());
      };

      for (const pair of pairs) {
        if (rateLimited || error || this.now() >= deadlineAt) break;
        if (active.size >= concurrency) await Promise.race(active);
        if (!this.skipPacing) {
          await delay(Math.max(0, nextLaunchAt - this.now()));
          nextLaunchAt = Math.max(nextLaunchAt + intervalMs, this.now());
        }
        const task = processPair(pair.sell, pair.buy).catch((cause) => {
          error = String(cause instanceof Error ? cause.message : cause).slice(0, 500);
        });
        active.add(task);
        void task.then(() => active.delete(task), () => active.delete(task));
      }
      await Promise.all(active);
      if (!error && !rateLimited && this.now() >= deadlineAt && attempted !== expectedPairs) {
        error = 'sweep exceeded its 14-minute deadline';
      }
      if (rateLimited) state = 'rate_limited';
      else if (attempted !== expectedPairs) state = this.now() >= deadlineAt ? 'stale' : 'failed';
      else state = 'complete';
    } catch (cause) {
      error = String(cause instanceof Error ? cause.message : cause).slice(0, 500);
      state = 'failed';
    }
    const rejected = attempted - eligible;
    this.db.prepare(
      `UPDATE pair_sweep_runs SET state=?, attempted_pairs=?, quoted_pairs=?, eligible_pairs=?,
       rejected_pairs=?, completed_at=?, error=? WHERE id=?`,
    ).run(state, attempted, quoted, eligible, rejected, this.now(), error, runId);
    return { runId, state, expectedPairs, attemptedPairs: attempted, quotedPairs: quoted, eligiblePairs: eligible, error };
  }
}

export function topSweepCandidates(db: DB, sweepId: number, limit = 20): any[] {
  const sweep = db.prepare(`SELECT state, completed_at, deadline_at FROM pair_sweep_runs WHERE id=?`).get(sweepId) as any;
  if (!sweep || sweep.state !== 'complete' || !sweep.completed_at) return [];
  return db.prepare(
    `SELECT * FROM pair_sweep_candidates WHERE sweep_id=? AND rejection_code IS NULL
     ORDER BY CAST(rank_score AS REAL) DESC LIMIT ?`,
  ).all(sweepId, Math.min(20, Math.max(1, limit))) as any[];
}

/** Keep summaries forever, the latest detailed sweeps, and all council evidence. */
export function prunePairSweepDetails(db: DB, retainSweeps = 2): number {
  const keep = Math.max(1, Math.floor(retainSweeps));
  const result = db.prepare(
    `DELETE FROM pair_sweep_candidates
     WHERE sweep_id NOT IN (SELECT id FROM pair_sweep_runs ORDER BY started_at DESC LIMIT ?)
       AND id NOT IN (SELECT candidate_id FROM trading_council_runs WHERE candidate_id IS NOT NULL)`,
  ).run(keep);
  return result.changes;
}
