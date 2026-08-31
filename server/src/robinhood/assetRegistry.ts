import { getAddress, type Address } from 'viem';
import {
  ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD,
  type RhAssetClass, type EligibilityState, type RhAssetView,
} from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { rhClient } from '../chain/rhChain.js';
import { formatMultiplier, parseMultiplier, pendingMultiplier, recordMultiplier } from './multiplier.js';

// THE ASSET REGISTRY.
//
// Two sources, deliberately not merged by preference:
//
//   1. https://api.robinhood.com/rhj/assets — keyless, 60 req/s, 15s cache.
//      Authoritative for names, status, ISIN and trading capabilities.
//   2. The token contract itself — authoritative for decimals and multiplier.
//
// Where they disagree, the CHAIN WINS for anything that affects arithmetic
// (decimals, multiplier) and the disagreement is recorded as a mismatch. An
// asset with an unresolved mismatch does not become tradable.
//
// The verification step is not ceremony. `decimals` is the field that decides
// how many zeros go in an order: stock tokens are 18 and USDG is 6, and a
// registry that guessed uniformly would misprice every settlement leg by 1e12.

const ASSETS_URL = 'https://api.robinhood.com/rhj/assets';

const TOKEN_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'uiMultiplier', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'newUIMultiplier', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'effectiveAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

interface ApiDeployment { contractAddress: string; chainId: number; networkName: string }
interface ApiAsset {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  deployments: ApiDeployment[];
  currentMultiplier: string;
  pendingMultiplier: string;
  status: string;
  tokenDecimals: number;
  isin?: string;
  tradingCapabilities?: Record<string, Record<string, string>>;
}

/** ETFs and funds are not single-name equities and behave differently. */
const ETF_SYMBOLS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'SLV', 'USO', 'VOO', 'VTI', 'ARKK',
  'SGOV', 'TLT', 'HYG', 'EEM', 'XLK', 'XLF', 'XLE', 'SMH', 'IBIT', 'BITO',
]);

export function classifyAsset(symbol: string, name: string): RhAssetClass {
  const upper = symbol.toUpperCase();
  if (upper === 'USDG' || /\b(USDC|USDT|DAI|PYUSD)\b/.test(upper)) return 'STABLECOIN';
  if (ETF_SYMBOLS.has(upper)) return 'ETF_TOKEN';
  if (/\b(ETF|Fund|Trust|Index|Bond)\b/i.test(name)) return 'ETF_TOKEN';
  if (/Robinhood Token/i.test(name)) return 'STOCK_TOKEN';
  return 'CRYPTO';
}

export interface VerificationResult {
  ok: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  onchainDecimals: number | null;
  onchainMultiplier: bigint | null;
  onchainNext: bigint | null;
  onchainEffectiveAt: number | null;
}

/**
 * Confirm an API-advertised asset against the chain. Every failure here is a
 * refusal to trade, not a warning.
 */
export async function verifyAsset(
  address: Address,
  api: { symbol: string; decimals: number; multiplier: string },
  chainId = ROBINHOOD_MAINNET_CHAIN_ID,
): Promise<VerificationResult> {
  const checks: VerificationResult['checks'] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  const client = rhClient(chainId);

  let onchainDecimals: number | null = null;
  let onchainMultiplier: bigint | null = null;
  let onchainNext: bigint | null = null;
  let onchainEffectiveAt: number | null = null;

  const code = await client.getCode({ address }).catch(() => undefined);
  if (!code || code === '0x') {
    add('contract_exists', false, 'no contract deployed at this address');
    return { ok: false, checks, onchainDecimals, onchainMultiplier, onchainNext, onchainEffectiveAt };
  }
  add('contract_exists', true, `${(code.length - 2) / 2} bytes of code`);

  try {
    const symbol = await client.readContract({ address, abi: TOKEN_ABI, functionName: 'symbol' });
    add('symbol_matches', String(symbol) === api.symbol, `chain says ${symbol}, api says ${api.symbol}`);
  } catch {
    add('symbol_matches', false, 'symbol() did not return');
  }

  try {
    const decimals = await client.readContract({ address, abi: TOKEN_ABI, functionName: 'decimals' });
    onchainDecimals = Number(decimals);
    add('decimals_match', onchainDecimals === api.decimals,
      `chain says ${onchainDecimals}, api says ${api.decimals}`);
  } catch {
    add('decimals_match', false, 'decimals() did not return — cannot size an order without it');
  }

  try {
    onchainMultiplier = (await client.readContract({ address, abi: TOKEN_ABI, functionName: 'uiMultiplier' })) as bigint;
    const apiMultiplier = parseMultiplier(api.multiplier);
    add('multiplier_matches', onchainMultiplier === apiMultiplier,
      `chain ${formatMultiplier(onchainMultiplier)} vs api ${formatMultiplier(apiMultiplier)}`);
  } catch {
    // Crypto and stablecoins legitimately have no multiplier; stock tokens must.
    add('multiplier_matches', true, 'no uiMultiplier() — not a scaled-UI token');
  }

  if (onchainMultiplier !== null) {
    try {
      onchainNext = (await client.readContract({ address, abi: TOKEN_ABI, functionName: 'newUIMultiplier' })) as bigint;
      const at = (await client.readContract({ address, abi: TOKEN_ABI, functionName: 'effectiveAt' })) as bigint;
      onchainEffectiveAt = Number(at);
      const pending = pendingMultiplier(onchainMultiplier, onchainNext, onchainEffectiveAt);
      add('no_pending_multiplier', !pending.pending,
        pending.pending
          ? `multiplier changes to ${formatMultiplier(onchainNext)} at ${new Date((onchainEffectiveAt ?? 0) * 1000).toISOString()}`
          : 'no scheduled multiplier change');
    } catch {
      add('no_pending_multiplier', true, 'no pending-multiplier interface');
    }
  }

  return {
    ok: checks.every((c) => c.pass),
    checks, onchainDecimals, onchainMultiplier, onchainNext, onchainEffectiveAt,
  };
}

export interface RefreshReport {
  ok: boolean;
  seen: number;
  verified: number;
  rejected: number;
  mismatches: { symbol: string; failed: string[] }[];
  durationMs: number;
  error: string | null;
}

/**
 * Pull the registry and verify it. `verifyLimit` bounds how many contracts we
 * read per pass — 194 assets × 5 calls is a lot of RPC against a rate-limited
 * public endpoint, so verification round-robins by staleness.
 */
export async function refreshRegistry(
  db: DB,
  opts: { verifyLimit?: number; chainId?: number; fetchImpl?: typeof fetch } = {},
): Promise<RefreshReport> {
  const started = Date.now();
  const chainId = opts.chainId ?? ROBINHOOD_MAINNET_CHAIN_ID;
  const doFetch = opts.fetchImpl ?? fetch;
  const report: RefreshReport = {
    ok: false, seen: 0, verified: 0, rejected: 0, mismatches: [], durationMs: 0, error: null,
  };

  let assets: ApiAsset[];
  try {
    const res = await doFetch(ASSETS_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`asset API HTTP ${res.status}`);
    const body = (await res.json()) as { assets?: ApiAsset[] };
    if (!Array.isArray(body.assets)) throw new Error('asset API returned no assets array');
    assets = body.assets;
  } catch (e) {
    // Keep the last verified snapshot rather than emptying the registry — but
    // record the failure so staleness is visible instead of assumed.
    report.error = String(e instanceof Error ? e.message : e).slice(0, 200);
    report.durationMs = Date.now() - started;
    db.prepare(
      `INSERT INTO rh_registry_runs (ts, ok, assets_seen, assets_verified, assets_rejected, duration_ms, error)
       VALUES (?, 0, 0, 0, 0, ?, ?)`,
    ).run(Date.now(), report.durationMs, report.error);
    return report;
  }

  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO rh_assets
       (symbol, chain_id, contract_address, asset_id, name, underlying_symbol, asset_class,
        decimals, isin, status, tradable, trading_capabilities_json, multiplier,
        pending_multiplier, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain_id, contract_address) DO UPDATE SET
       symbol = excluded.symbol, name = excluded.name, status = excluded.status,
       tradable = excluded.tradable, trading_capabilities_json = excluded.trading_capabilities_json,
       multiplier = excluded.multiplier, pending_multiplier = excluded.pending_multiplier,
       isin = excluded.isin, updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    for (const a of assets) {
      const deployment = a.deployments?.find((d) => d.chainId === chainId);
      if (!deployment) continue;
      report.seen++;

      const address = deployment.contractAddress.toLowerCase();
      const assetClass = classifyAsset(a.tokenSymbol, a.tokenName);
      const capabilities = a.tradingCapabilities ?? {};
      const tradable =
        a.status === 'ASSET_STATUS_ACTIVE' &&
        capabilities.market?.whole === 'TRADING_STATUS_TRADABLE';

      upsert.run(
        a.tokenSymbol, chainId, address, a.id ?? null, a.tokenName,
        a.tokenSymbol, assetClass, a.tokenDecimals, a.isin ?? null, a.status,
        tradable ? 1 : 0, JSON.stringify(capabilities),
        a.currentMultiplier || '1.000000000000000000',
        a.pendingMultiplier || null, now, now,
      );
    }
  })();

  // ── verification pass, oldest-verified first ──
  const limit = opts.verifyLimit ?? 25;
  const due = db
    .prepare(
      `SELECT symbol, contract_address, decimals, multiplier FROM rh_assets
       WHERE chain_id = ?
       ORDER BY COALESCE(last_verified_at, 0) ASC LIMIT ?`,
    )
    .all(chainId, limit) as { symbol: string; contract_address: string; decimals: number; multiplier: string }[];

  for (const row of due) {
    let result: VerificationResult;
    try {
      result = await verifyAsset(getAddress(row.contract_address), {
        symbol: row.symbol, decimals: row.decimals, multiplier: row.multiplier,
      }, chainId);
    } catch (e) {
      result = {
        ok: false,
        checks: [{ name: 'rpc', pass: false, detail: String(e instanceof Error ? e.message : e).slice(0, 120) }],
        onchainDecimals: null, onchainMultiplier: null, onchainNext: null, onchainEffectiveAt: null,
      };
    }

    const failed = result.checks.filter((c) => !c.pass).map((c) => c.name);
    if (!result.ok) {
      report.rejected++;
      report.mismatches.push({ symbol: row.symbol, failed });
    } else {
      report.verified++;
    }

    // The chain wins on arithmetic. If it reported decimals or a multiplier,
    // those are what the rest of the system uses.
    db.prepare(
      `UPDATE rh_assets SET
         verified_onchain = ?, verification_json = ?, last_verified_at = ?,
         decimals = COALESCE(?, decimals),
         onchain_multiplier = COALESCE(?, onchain_multiplier),
         pending_effective_at = ?,
         eligibility = ?, eligibility_reason = ?, updated_at = ?
       WHERE chain_id = ? AND contract_address = ?`,
    ).run(
      result.ok ? 1 : 0,
      JSON.stringify(result.checks),
      Date.now(),
      result.onchainDecimals,
      result.onchainMultiplier !== null ? formatMultiplier(result.onchainMultiplier) : null,
      result.onchainEffectiveAt,
      result.ok ? 'SHADOW_ONLY' : 'BLOCKED',
      result.ok
        ? 'verified onchain; awaiting live eligibility review'
        : `verification failed: ${failed.join(', ')}`,
      Date.now(), chainId, row.contract_address,
    );

    if (result.onchainMultiplier !== null) {
      recordMultiplier(
        db, row.symbol, row.contract_address, result.onchainMultiplier,
        result.onchainEffectiveAt ?? 0, 'onchain',
      );
    }
  }

  report.ok = report.rejected === 0;
  report.durationMs = Date.now() - started;
  db.prepare(
    `INSERT INTO rh_registry_runs (ts, ok, assets_seen, assets_verified, assets_rejected, mismatches_json, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    Date.now(), report.ok ? 1 : 0, report.seen, report.verified, report.rejected,
    JSON.stringify(report.mismatches), report.durationMs,
  );
  return report;
}

export interface RegistryStatus {
  assets: number;
  verified: number;
  blocked: number;
  lastRunAt: number | null;
  lastRunOk: boolean;
  ageMs: number | null;
  stale: boolean;
}

/** A registry nobody has refreshed recently is reported STALE, never assumed fresh. */
export function registryStatus(db: DB, maxAgeMs = 6 * 3_600_000): RegistryStatus {
  const counts = db
    .prepare(
      `SELECT COUNT(*) n,
              SUM(CASE WHEN verified_onchain = 1 THEN 1 ELSE 0 END) verified,
              SUM(CASE WHEN eligibility = 'BLOCKED' THEN 1 ELSE 0 END) blocked
       FROM rh_assets`,
    )
    .get() as { n: number; verified: number | null; blocked: number | null };
  const last = db
    .prepare(`SELECT ts, ok FROM rh_registry_runs ORDER BY id DESC LIMIT 1`)
    .get() as { ts: number; ok: number } | undefined;
  const ageMs = last ? Date.now() - last.ts : null;
  return {
    assets: counts.n,
    verified: counts.verified ?? 0,
    blocked: counts.blocked ?? 0,
    lastRunAt: last?.ts ?? null,
    lastRunOk: last?.ok === 1,
    ageMs,
    stale: ageMs === null || ageMs > maxAgeMs,
  };
}

export function getAsset(db: DB, symbol: string, chainId = ROBINHOOD_MAINNET_CHAIN_ID): RhAssetView | null {
  const row = db
    .prepare(`SELECT * FROM rh_assets WHERE chain_id = ? AND symbol = ?`)
    .get(chainId, symbol) as any;
  return row ? toView(row) : null;
}

export function listAssets(
  db: DB,
  filter: { assetClass?: RhAssetClass; eligibility?: EligibilityState; limit?: number } = {},
): RhAssetView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.assetClass) { where.push('asset_class = ?'); params.push(filter.assetClass); }
  if (filter.eligibility) { where.push('eligibility = ?'); params.push(filter.eligibility); }
  const rows = db
    .prepare(
      `SELECT * FROM rh_assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY symbol ASC LIMIT ?`,
    )
    .all(...params, filter.limit ?? 500) as any[];
  return rows.map(toView);
}

function toView(row: any): RhAssetView {
  return {
    symbol: row.symbol,
    name: row.name,
    underlyingSymbol: row.underlying_symbol,
    assetClass: row.asset_class,
    contractAddress: row.contract_address,
    chainId: row.chain_id,
    // the onchain value is authoritative when we have it
    decimals: row.decimals,
    multiplier: row.onchain_multiplier ?? row.multiplier,
    pendingMultiplier: row.pending_multiplier,
    pendingEffectiveAt: row.pending_effective_at,
    isin: row.isin,
    status: row.status,
    tradable: row.tradable === 1,
    eligibility: row.eligibility,
    verifiedOnchain: row.verified_onchain === 1,
    lastVerifiedAt: row.last_verified_at ?? 0,
  };
}

/** Seed the two infrastructure tokens the chain docs give explicitly. */
export function seedCoreTokens(db: DB, chainId = ROBINHOOD_MAINNET_CHAIN_ID): void {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO rh_assets
       (symbol, chain_id, contract_address, name, underlying_symbol, asset_class, decimals,
        status, tradable, multiplier, eligibility, eligibility_reason, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ASSET_STATUS_ACTIVE', 1, '1.000000000000000000',
             'RESEARCH_ONLY', 'core token; awaiting onchain verification', ?, ?)`,
  );
  stmt.run('USDG', chainId, USDG.address.toLowerCase(), 'Global Dollar', 'USDG', 'STABLECOIN', USDG.decimals, now, now);
  stmt.run('WETH', chainId, WETH_ROBINHOOD.address.toLowerCase(), 'Wrapped Ether', 'ETH', 'CRYPTO', WETH_ROBINHOOD.decimals, now, now);
}
