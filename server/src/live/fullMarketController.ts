import type { TradingSigner } from './signing/signer.js';
import type { DB } from '../db/db.js';
import { accountForMode } from './accounts.js';
import { activeUniverse, currentJurisdictionAttestation, universeAssets } from '../robinhood/universe.js';
import { rawHoldings } from './rawAssetLedger.js';
import { ZEROX_ALLOWANCE_HOLDER } from './instrumentResolver.js';
import { signerAmountPolicyGate, verifyActiveUniversePolicy } from './signing/universePolicy.js';
import { config } from '../config.js';

export interface FullMarketReadiness {
  ready: boolean;
  blockers: string[];
  snapshotHash: string | null;
  pairCount: number;
  authorizedCapitalUsdg: number | null;
}

export async function fullMarketReadiness(db: DB, signer: TradingSigner): Promise<FullMarketReadiness> {
  const blockers: string[] = [];
  const snapshot = activeUniverse(db);
  const cfg = db.prepare(`SELECT * FROM live_config WHERE id=1`).get() as any;
  const account = accountForMode(db, 'canary', 'evm:robinhood');
  const signerReady = await signer.isReady();
  if (!signerReady.ready || !signerReady.address) blockers.push(`signer not ready: ${signerReady.detail}`);
  if (!account.walletAddress || signerReady.address?.toLowerCase() !== account.walletAddress?.toLowerCase()) {
    blockers.push('exact Trader wallet isolation is not verified');
  }
  if (!snapshot) blockers.push('no active universe snapshot');
  else {
    const requiredRps = snapshot.directedPairCount / (13.5 * 60);
    if (!config.fullMarketScannerEnabled) blockers.push('FULL_MARKET_SCANNER_ENABLED is false');
    if (!Number.isFinite(config.zeroXSustainedRps) || config.zeroXSustainedRps < requiredRps) {
      blockers.push(`declared 0x quota ${config.zeroXSustainedRps.toFixed(2)} rps is below required ${requiredRps.toFixed(2)} rps`);
    }
    if (cfg.active_universe_hash !== snapshot.contentHash) blockers.push('live config does not bind the active universe hash');
    if (!snapshot.policyHash || cfg.expected_signer_policy_hash !== snapshot.policyHash
      || cfg.observed_signer_policy_hash !== snapshot.policyHash) blockers.push('snapshot policy hash is absent or mismatched');
    const ids = snapshot.policyIds.slice().sort();
    const observed = (signer.guards?.().policyIds ?? []).slice().sort();
    if (!ids.length || JSON.stringify(ids) !== JSON.stringify(observed)) blockers.push('Privy policy IDs do not exactly match the active snapshot');
    const policyContent = await verifyActiveUniversePolicy(db, signer);
    if (!policyContent.ok) blockers.push(policyContent.detail);
    const staleCaps = universeAssets(db, snapshot.id)
      .map((asset) => signerAmountPolicyGate(db, snapshot.id, asset))
      .filter((gate) => !gate.eligible);
    if (staleCaps.length) blockers.push(`${staleCaps.length} signer amount cap(s) are unsafe: ${staleCaps.slice(0, 3)
      .map((gate) => gate.reason).join('; ')}`);
  }
  if (!account.walletAddress || !currentJurisdictionAttestation(db, account.walletAddress)) {
    blockers.push('signed jurisdiction attestation is absent');
  }
  const unresolved = (db.prepare(
    `SELECT COUNT(*) n FROM execution_transactions WHERE state IN ('prepared','signed','broadcast','unknown')`,
  ).get() as { n: number }).n;
  if (unresolved) blockers.push(`${unresolved} unresolved execution transaction(s)`);
  const recon = db.prepare(
    `SELECT status, completed_at FROM reconciliation_runs WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`,
  ).get(account.id) as { status: string; completed_at: number } | undefined;
  const sweep = snapshot ? db.prepare(
    `SELECT * FROM pair_sweep_runs WHERE snapshot_id=? ORDER BY id DESC LIMIT 1`,
  ).get(snapshot.id) as any : null;
  if (!sweep || sweep.state !== 'complete' || sweep.attempted_pairs !== snapshot?.directedPairCount
    || !sweep.completed_at || Date.now() - sweep.completed_at > 15 * 60_000) {
    blockers.push('no fresh, complete, exact-cardinality 15-minute sweep');
  }
  if (snapshot) {
    const staleReferences = (db.prepare(
      `SELECT COUNT(*) n FROM rh_universe_assets a
       WHERE a.snapshot_id=? AND a.symbol<>'USDG' AND NOT EXISTS (
         SELECT 1 FROM rh_reference_prices p WHERE p.symbol=a.symbol
           AND p.generated_at>=? AND p.is_trading_halt=0
       )`,
    ).get(snapshot.id, Date.now() - 60_000) as { n: number }).n;
    if (staleReferences) blockers.push(`${staleReferences} snapshot asset(s) lack a fresh non-halted reference price`);
  }
  if (recon?.status !== 'clean' || (sweep?.completed_at && (recon.completed_at ?? 0) < sweep.completed_at)) {
    blockers.push('latest Trader reconciliation is not clean and subsequent to the sweep');
  }
  const probe = db.prepare(
    `SELECT reconciliation_run_id FROM canary_experiment_runs WHERE state='completed' ORDER BY id DESC LIMIT 1`,
  ).get() as { reconciliation_run_id: number | null } | undefined;
  if (!probe?.reconciliation_run_id) blockers.push('reconciled $0.50 WETH/USDG proof round trip is incomplete');
  if (cfg.mode !== 'canary' || cfg.capital_stage !== 1) blockers.push('full-market launch starts only from $5 canary stage');
  const allowed = (process.env.SIGNER_ALLOWED_TARGETS ?? '').toLowerCase();
  const targetsFile = process.env.SIGNER_ALLOWED_TARGETS_FILE;
  if (!targetsFile && !allowed.includes(ZEROX_ALLOWANCE_HOLDER.toLowerCase())) blockers.push('application signer target allowlist is incomplete');
  return { ready: blockers.length === 0, blockers, snapshotHash: snapshot?.contentHash ?? null,
    pairCount: snapshot?.directedPairCount ?? 0,
    authorizedCapitalUsdg: cfg.authorized_capital_usdg === null ? null : Number(cfg.authorized_capital_usdg) };
}

export async function enableFullMarketAutonomy(
  db: DB, signer: TradingSigner, confirmation: string, actor: string,
): Promise<FullMarketReadiness> {
  if (confirmation !== 'ENABLE AUTONOMOUS CANARY $5') throw new Error('exact full-market confirmation phrase is required');
  const readiness = await fullMarketReadiness(db, signer);
  if (!readiness.ready) throw new Error(`full-market autonomy blocked: ${readiness.blockers.join('; ')}`);
  const account = accountForMode(db, 'canary', 'evm:robinhood');
  const usdgContract = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const rawUsdg = rawHoldings(db, account.id).get(usdgContract) ?? 0n;
  const reconciledUsdg = Number(rawUsdg) / 1_000_000;
  if (!Number.isFinite(reconciledUsdg) || reconciledUsdg < 5) throw new Error('at least 5 reconciled USDG is required');
  db.prepare(
    `UPDATE live_config SET authorized_capital_usdg=?, authorized_capital_set_at=?,
     full_market_autonomy=1, autonomy_enabled=1, execution_phase='autonomous_canary',
     halted=0, halt_reason=NULL, updated_at=? WHERE id=1`,
  ).run(String(reconciledUsdg), Date.now(), Date.now());
  return fullMarketReadiness(db, signer);
}
