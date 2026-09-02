import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import {
  ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD, type RhAssetClass,
} from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { corporateActionState } from './corporateActions.js';
import { lastReferenceQuote, referencePriceGate } from './referencePrice.js';
import { parseMultiplier, pendingMultiplier } from './multiplier.js';
import { marketSessionState } from './marketSession.js';
import { registryStatus } from './assetRegistry.js';
import { getLiveConfig } from '../live/riskEngine.js';

export interface UniverseAsset {
  symbol: string;
  contractAddress: string;
  decimals: number;
  assetClass: RhAssetClass;
  multiplier: string;
  tradingCapabilities: Record<string, Record<string, string>>;
  registryVerifiedAt: number;
  policyReferencePriceUsd: string | null;
  policyRawCap: string | null;
}

export interface UniverseSnapshot {
  id: number;
  chainId: number;
  contentHash: string;
  assetCount: number;
  directedPairCount: number;
  state: 'draft' | 'active' | 'retired';
  policyHash: string | null;
  policyIds: string[];
  createdAt: number;
  activatedAt: number | null;
}

const canonical = (assets: UniverseAsset[]) => assets
  .slice()
  .sort((a, b) => a.contractAddress.localeCompare(b.contractAddress))
  .map((a) => ({
    symbol: a.symbol,
    contractAddress: a.contractAddress.toLowerCase(),
    decimals: a.decimals,
    assetClass: a.assetClass,
    multiplier: a.multiplier,
    tradingCapabilities: a.tradingCapabilities,
    registryVerifiedAt: a.registryVerifiedAt,
  }));

export function universeHash(assets: UniverseAsset[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(assets))).digest('hex')}`;
}

function snapshotRow(row: any): UniverseSnapshot {
  return {
    id: row.id, chainId: row.chain_id, contentHash: row.content_hash,
    assetCount: row.asset_count, directedPairCount: row.directed_pair_count,
    state: row.state, policyHash: row.policy_hash,
    policyIds: JSON.parse(row.policy_ids_json ?? '[]'), createdAt: row.created_at,
    activatedAt: row.activated_at ?? null,
  };
}

export function createUniverseSnapshot(db: DB, actor: string): UniverseSnapshot {
  const status = registryStatus(db);
  if (status.stale || !status.lastRunOk) throw new Error('registry must be fresh and clean before snapshot creation');
  const rows = db.prepare(
    `SELECT symbol, contract_address, decimals, asset_class,
            COALESCE(onchain_multiplier, multiplier) multiplier,
            COALESCE(trading_capabilities_json, '{}') capabilities,
            last_verified_at
     FROM rh_assets
     WHERE chain_id=? AND verified_onchain=1 AND tradable=1
       AND status='ASSET_STATUS_ACTIVE'
       AND asset_class IN ('CRYPTO','STABLECOIN')
       AND lower(contract_address) IN (lower(?), lower(?))
     ORDER BY lower(contract_address)`,
  ).all(ROBINHOOD_MAINNET_CHAIN_ID, WETH_ROBINHOOD.address, USDG.address) as any[];
  const assets: UniverseAsset[] = rows.map((r) => ({
    symbol: String(r.symbol).toUpperCase(), contractAddress: getAddress(r.contract_address).toLowerCase(),
    decimals: Number(r.decimals), assetClass: r.asset_class, multiplier: String(r.multiplier),
    tradingCapabilities: JSON.parse(r.capabilities), registryVerifiedAt: Number(r.last_verified_at),
    policyReferencePriceUsd: null, policyRawCap: null,
  }));
  const required = new Set([USDG.address.toLowerCase(), WETH_ROBINHOOD.address.toLowerCase()]);
  if (assets.length !== required.size || assets.some((asset) => !required.has(asset.contractAddress))) {
    throw new Error('crypto-core universe requires exactly the canonical WETH and USDG contracts');
  }
  const symbols = new Set<string>();
  for (const asset of assets) {
    if (symbols.has(asset.symbol)) throw new Error(`symbol collision in verified universe: ${asset.symbol}`);
    symbols.add(asset.symbol);
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
      throw new Error(`invalid decimals for ${asset.symbol}`);
    }
  }
  const hash = universeHash(assets);
  const existing = db.prepare(`SELECT * FROM rh_universe_snapshots WHERE content_hash=?`).get(hash);
  if (existing) return snapshotRow(existing);
  return db.transaction(() => {
    const now = Date.now();
    const run = db.prepare(`SELECT id FROM rh_registry_runs WHERE ok=1 ORDER BY ts DESC LIMIT 1`).get() as { id: number };
    const info = db.prepare(
      `INSERT INTO rh_universe_snapshots
       (chain_id, content_hash, asset_count, directed_pair_count, state, registry_run_id, created_by, created_at)
       VALUES (4663, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(hash, assets.length, assets.length * (assets.length - 1), run.id, actor, now);
    const id = Number(info.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO rh_universe_assets
       (snapshot_id, symbol, contract_address, decimals, asset_class, multiplier,
        trading_capabilities_json, registry_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of assets) insert.run(
      id, asset.symbol, asset.contractAddress, asset.decimals, asset.assetClass, asset.multiplier,
      JSON.stringify(asset.tradingCapabilities), asset.registryVerifiedAt,
    );
    return snapshotRow(db.prepare(`SELECT * FROM rh_universe_snapshots WHERE id=?`).get(id));
  })();
}

export function activateUniverseSnapshot(db: DB, snapshotId: number, actor: string): UniverseSnapshot {
  getLiveConfig(db);
  const selected = db.prepare(`SELECT * FROM rh_universe_snapshots WHERE id=?`).get(snapshotId) as any;
  if (!selected) throw new Error('universe snapshot not found');
  const count = (db.prepare(`SELECT COUNT(*) n FROM rh_universe_assets WHERE snapshot_id=?`).get(snapshotId) as { n: number }).n;
  if (count !== selected.asset_count || count * (count - 1) !== selected.directed_pair_count) {
    throw new Error('universe snapshot cardinality does not match its manifest');
  }
  return db.transaction(() => {
    const now = Date.now();
    db.prepare(`UPDATE rh_universe_snapshots SET state='retired' WHERE state='active' AND id<>?`).run(snapshotId);
    db.prepare(`UPDATE rh_universe_snapshots SET state='active', activated_at=? WHERE id=?`).run(now, snapshotId);
    db.prepare(
      `UPDATE live_config SET active_universe_hash=?, full_market_autonomy=0,
       autonomy_enabled=0, halted=1, halt_reason=?, updated_at=? WHERE id=1`,
    ).run(selected.content_hash,
      `universe ${selected.content_hash} activated by ${actor}; matching signer policy and preflight required`, now);
    return snapshotRow(db.prepare(`SELECT * FROM rh_universe_snapshots WHERE id=?`).get(snapshotId));
  })();
}

export function activeUniverse(db: DB): UniverseSnapshot | null {
  const row = db.prepare(`SELECT * FROM rh_universe_snapshots WHERE state='active'`).get();
  return row ? snapshotRow(row) : null;
}

export function isCryptoCoreUniverse(db: DB, snapshot: UniverseSnapshot): boolean {
  const contracts = universeAssets(db, snapshot.id).map((asset) => asset.contractAddress.toLowerCase()).sort();
  const expected = [USDG.address.toLowerCase(), WETH_ROBINHOOD.address.toLowerCase()].sort();
  return contracts.length === expected.length && contracts.every((contract, index) => contract === expected[index]);
}

/** A crypto-only release must never inherit an older stock-token universe. */
export function ensureCryptoCoreUniverse(db: DB, actor: string): UniverseSnapshot {
  const current = activeUniverse(db);
  if (current && isCryptoCoreUniverse(db, current)) return current;

  db.transaction(() => {
    db.prepare(`UPDATE rh_universe_snapshots SET state='retired' WHERE state='active'`).run();
    db.prepare(
      `UPDATE live_config SET active_universe_hash=NULL, full_market_autonomy=0,
       autonomy_enabled=0, halted=1, halt_reason=?, updated_at=? WHERE id=1`,
    ).run('non-crypto execution universe retired; canonical WETH/USDG activation required', Date.now());
  })();

  const snapshot = createUniverseSnapshot(db, actor);
  return activateUniverseSnapshot(db, snapshot.id, actor);
}

export function universeAssets(db: DB, snapshotId: number): UniverseAsset[] {
  return (db.prepare(`SELECT * FROM rh_universe_assets WHERE snapshot_id=? ORDER BY symbol`).all(snapshotId) as any[])
    .map((r) => ({
      symbol: r.symbol, contractAddress: r.contract_address, decimals: r.decimals,
      assetClass: r.asset_class, multiplier: r.multiplier,
      tradingCapabilities: JSON.parse(r.trading_capabilities_json), registryVerifiedAt: r.registry_verified_at,
      policyReferencePriceUsd: r.policy_reference_price_usd ?? null,
      policyRawCap: r.policy_raw_cap ?? null,
    }));
}

export interface RuntimeAssetGate {
  eligible: boolean;
  reasons: string[];
  session: string;
  referencePriceUsd: number | null;
}

/** Re-check mutable conditions; snapshot membership alone never grants a trade. */
export function runtimeAssetGate(db: DB, snapshotId: number, asset: UniverseAsset, now = Date.now()): RuntimeAssetGate {
  const reasons: string[] = [];
  const current = db.prepare(
    `SELECT * FROM rh_assets WHERE chain_id=4663 AND lower(contract_address)=lower(?)`,
  ).get(asset.contractAddress) as any;
  if (!current || current.verified_onchain !== 1 || current.tradable !== 1) reasons.push('current registry no longer verifies asset as tradable');
  if (current && (current.symbol !== asset.symbol || current.decimals !== asset.decimals)) reasons.push('current symbol or decimals differ from pinned snapshot');
  if (current && String(current.onchain_multiplier ?? current.multiplier) !== asset.multiplier) reasons.push('multiplier differs from pinned snapshot');
  if (current) {
    const multiplier = parseMultiplier(current.onchain_multiplier ?? current.multiplier);
    const pending = pendingMultiplier(
      multiplier, current.pending_multiplier ? parseMultiplier(current.pending_multiplier) : multiplier,
      current.pending_effective_at, now,
    );
    if (pending.pending || pending.overdue) reasons.push('multiplier change is pending or overdue');
  }
  const corp = corporateActionState(db, asset.symbol);
  if (corp.blocked) reasons.push(corp.reason ?? 'unresolved corporate action');
  const session = marketSessionState(asset.assetClass, asset.tradingCapabilities, new Date(now));
  if (!session.open) reasons.push(session.reason);
  const quote = asset.symbol === 'USDG'
    ? { mid: 1, stale: false, isTradingHalt: false, ageMs: 0, symbol: 'USDG', bid: 1, ask: 1, currency: 'USD', generatedAt: now }
    : lastReferenceQuote(db, asset.symbol, { now });
  const priceGate = referencePriceGate(quote);
  if (!priceGate.usable) reasons.push(priceGate.reason);
  const multiplier = parseMultiplier(asset.multiplier);
  const referencePriceUsd = quote ? quote.mid * (Number(multiplier) / 1e18) : null;
  return { eligible: reasons.length === 0, reasons, session: session.session, referencePriceUsd };
}

export function currentJurisdictionAttestation(db: DB, walletAddress: string): boolean {
  const row = db.prepare(
    `SELECT not_us_person, not_restricted_jurisdiction
     FROM operator_jurisdiction_attestations
     WHERE lower(wallet_address)=lower(?) AND revoked_at IS NULL ORDER BY attested_at DESC LIMIT 1`,
  ).get(walletAddress) as { not_us_person: number; not_restricted_jurisdiction: number } | undefined;
  return row?.not_us_person === 1 && row?.not_restricted_jurisdiction === 1;
}
