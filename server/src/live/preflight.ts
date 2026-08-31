import type { ExecutionMode } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import type { ExecutionAdapter } from './adapters.js';
import type { TradingSigner } from './signing/signer.js';
import { mappedSymbols, validateMappings } from './instrumentResolver.js';
import { accountForMode } from './accounts.js';
import { appendAudit } from '../audit/auditLog.js';
import { ROBINHOOD_MAINNET_CHAIN_ID } from '@punklabz/shared';
import { probeEndpoints } from '../chain/rhChain.js';
import { ROBINHOOD_VENUE, SETTLEMENT } from './instruments.js';
import { delegationCeiling } from './delegation/delegationPolicy.js';
import { buildDelegationProvider } from './delegation/provider.js';
import { revocationCache } from './delegation/revocationCache.js';
import { getLiveConfig } from './riskEngine.js';

// LIVE PREFLIGHT.
//
// Modes above shadow are no longer blocked by an assertion — they are blocked
// by evidence, or not blocked at all. Every prerequisite is a real check with a
// real answer, and the gate opens only when all of them pass. Today several
// fail (no signer, no adapter, no instrument mapping), so canary and live stay
// closed — but they stay closed for reasons you can read and fix, rather than
// because a line of code says no.
//
// Preflight is deliberately conservative: an unknown answer is a failure.

export interface PreflightCheck {
  name: string;
  pass: boolean;
  detail: string;
  /** false = advisory only; a failure here does not block */
  blocking: boolean;
}

export interface PreflightResult {
  targetMode: ExecutionMode;
  passed: boolean;
  checks: PreflightCheck[];
  blockers: string[];
}

export interface PreflightDeps {
  db: DB;
  signer: TradingSigner;
  adapters: Map<string, ExecutionAdapter>;
  feedStatus: Record<string, { connected: boolean; stale: boolean }>;
  /** used to price the ETH gas reserve; null means the check reports honestly that it cannot */
  ethUsd?: number | null;
}

export async function runPreflight(
  deps: PreflightDeps,
  targetMode: ExecutionMode,
  actor = 'system',
): Promise<PreflightResult> {
  const { db, signer, adapters, feedStatus } = deps;
  const checks: PreflightCheck[] = [];
  const add = (name: string, pass: boolean, detail: string, blocking = true) =>
    checks.push({ name, pass, detail, blocking });

  // simulation and shadow need no venue infrastructure — they touch nothing
  const needsVenue = targetMode === 'canary' || targetMode === 'live';

  // ── always checked ──
  const feeds = Object.entries(feedStatus);
  const feedsOk = feeds.length > 0 && feeds.every(([, f]) => f.connected && !f.stale);
  add('market_data', feedsOk,
    feeds.length === 0 ? 'no feeds reporting yet' : feeds.map(([n, f]) => `${n}:${f.connected ? (f.stale ? 'stale' : 'ok') : 'down'}`).join(' '),
    needsVenue);

  const ledgerOk = (db.prepare(`SELECT COUNT(*) n FROM live_ledger WHERE execution_account_id IS NULL`).get() as any).n === 0;
  add('ledger_partitioned', ledgerOk,
    ledgerOk ? 'every ledger row belongs to an execution account' : 'unpartitioned ledger rows found');

  const stuck = db
    .prepare(
      `SELECT COUNT(*) n FROM live_orders
       WHERE state IN ('submitting','submitted','pending','open','partial','reconciling')`,
    )
    .get() as { n: number };
  add('no_unresolved_orders', stuck.n === 0,
    stuck.n === 0 ? 'no orders awaiting an outcome' : `${stuck.n} order(s) still unresolved — recover them first`,
    needsVenue);

  if (!needsVenue) {
    const passed = checks.filter((c) => c.blocking).every((c) => c.pass);
    return record(db, targetMode, passed, checks, actor);
  }

  // ── only for modes that can move real funds ──
  const readiness = await signer.isReady();
  add('signer', readiness.ready, readiness.detail);

  const address = await signer.getAddress();
  add('wallet_address', !!address, address ? `trading wallet ${address}` : 'no trading wallet address available');

  const mappings = validateMappings();
  const symbols = mappedSymbols();
  add('instrument_mapping', symbols.length > 0 && mappings.ok,
    symbols.length === 0
      ? 'no paper→live instrument mappings configured'
      : mappings.ok ? `${symbols.length} mapping(s) validated` : mappings.problems.join('; '));

  const realAdapters = [...adapters.entries()].filter(([venue]) => venue !== 'shadow' && venue !== 'paper');
  const online: string[] = [];
  for (const [venue, adapter] of realAdapters) {
    try {
      const h = await adapter.health();
      if (h.status === 'online') online.push(venue);
    } catch { /* an adapter that throws is not online */ }
  }
  add('execution_adapter', online.length > 0,
    online.length ? `online: ${online.join(', ')}` : 'no real execution adapter reports online');

  // ── settlement + gas, from the chain ──
  //
  // Settlement is NOT assumed to be USDC. On Robinhood Chain it is USDG at six
  // decimals, and it is configurable, because a hardcoded settlement symbol is
  // how a balance check silently passes against the wrong asset.
  let funded = false;
  let fundedDetail = 'no adapter able to report balances';
  let gasEth = 0;
  let gasDetail = 'no adapter able to report a gas balance';

  // Ask the venue we would actually trade on. Iterating every adapter and
  // letting the last one win the message is how "no USDG balance" ends up
  // attributed to Polymarket — technically true, and useless.
  const settlementVenue = online.includes(ROBINHOOD_VENUE) ? ROBINHOOD_VENUE : online[0];
  const balanceAdapter = settlementVenue ? adapters.get(settlementVenue) : undefined;
  if (balanceAdapter && typeof balanceAdapter.getBalances === 'function') {
    try {
      const balances = (await balanceAdapter.getBalances()) ?? [];
      const settle = balances.find((b) => b.asset.toUpperCase() === SETTLEMENT.symbol.toUpperCase());
      const eth = balances.find((b) => b.asset.toUpperCase() === 'ETH');
      funded = !!settle && settle.qty > 0;
      fundedDetail = funded
        ? `${settlementVenue}: ${settle!.qty} ${SETTLEMENT.symbol}`
        : `${settlementVenue}: no ${SETTLEMENT.symbol} balance — fund the trading wallet`;
      if (eth) {
        gasEth = eth.qty;
        gasDetail = `${settlementVenue}: ${eth.qty} ETH`;
      }
    } catch (e) {
      fundedDetail = `${settlementVenue}: balance query failed (${String(e).slice(0, 60)})`;
    }
  } else {
    fundedDetail = settlementVenue
      ? `${settlementVenue} cannot report balances`
      : 'no online venue to read a balance from';
  }
  add('funded_balance', funded, fundedDetail);

  // Gas is ETH on this chain and it is a hard trading precondition: a wallet
  // that cannot pay for a transaction cannot exit a position either.
  const cfg = getLiveConfig(db);
  const gasFloorUsd = (db.prepare(`SELECT gas_reserve_critical_usd g FROM live_config WHERE id = 1`)
    .get() as { g: number } | undefined)?.g ?? 3;
  const ethUsd = deps.ethUsd ?? null;
  const gasUsd = ethUsd !== null ? gasEth * ethUsd : null;
  add('gas_reserve',
    gasUsd !== null ? gasUsd >= gasFloorUsd : gasEth > 0,
    gasUsd !== null
      ? `${gasEth.toFixed(6)} ETH ≈ $${gasUsd.toFixed(2)} against a $${gasFloorUsd} floor`
      : `${gasDetail} (no ETH/USD mark to price it against)`);

  // ── RPC: Robinhood Chain, and BOTH endpoints must report 4663 ──
  const chainId = cfg.mode === 'live' || cfg.mode === 'canary'
    ? ((db.prepare(`SELECT primary_chain_id c FROM live_config WHERE id = 1`).get() as { c: number } | undefined)?.c
        ?? ROBINHOOD_MAINNET_CHAIN_ID)
    : ROBINHOOD_MAINNET_CHAIN_ID;

  const endpoints = await probeEndpoints(chainId).catch(() => []);
  const named = endpoints.filter((e) => e.label !== 'public');
  const primary = named.find((e) => e.label === 'primary');
  const secondary = named.find((e) => e.label === 'secondary');

  add('rpc_primary', !!primary?.ok,
    primary
      ? primary.ok
        ? `${primary.url} reports chain ${primary.chainIdReported} (${primary.latencyMs}ms)`
        : `primary RPC unusable: ${primary.error}`
      : 'RPC_ROBINHOOD_PRIMARY not set — the public endpoint is rate-limited and not for production');

  add('rpc_redundancy', !!secondary?.ok,
    secondary
      ? secondary.ok ? `secondary healthy at chain ${secondary.chainIdReported}` : `secondary unusable: ${secondary.error}`
      : 'RPC_ROBINHOOD_SECONDARY not set — single point of failure',
    false);

  // An endpoint that answers on the WRONG chain is worse than one that is
  // down: it looks healthy and it would sign against a different network.
  const wrongChain = endpoints.filter((e) => e.chainIdReported !== null && e.chainIdReported !== chainId);
  add('chain_id', wrongChain.length === 0,
    wrongChain.length === 0
      ? `every reachable endpoint reports chain ${chainId}`
      : wrongChain.map((e) => `${e.label} reports ${e.chainIdReported}, expected ${chainId}`).join('; '));

  const account = accountForMode(db, targetMode, online[0] ?? 'unconfigured');
  add('execution_account', !!account, `books to ${account.name}`);

  // live additionally requires canary evidence: real fills that settled cleanly
  if (targetMode === 'live') {
    const canaryFills = db
      .prepare(
        `SELECT COUNT(*) n FROM live_orders o
         JOIN execution_accounts a ON a.id = o.execution_account_id
         WHERE a.mode = 'canary' AND o.state = 'filled'`,
      )
      .get() as { n: number };
    add('canary_evidence', canaryFills.n >= 10,
      `${canaryFills.n} clean canary fill(s) — 10 required before live`);
  }

  // Delegation status is reported here but never blocks the operator's own
  // mode change. Blocking would be a deadlock: tier 1 requires a live track
  // record, and a live track record requires live mode. Delegation has its own
  // strict gate below, applied where it matters — at grant activation.
  const ceiling = delegationCeiling(db);
  add('delegation_ceiling', ceiling.tier > 0,
    ceiling.tier > 0
      ? `tier ${ceiling.tier}: $${ceiling.perTradeUsd}/trade, $${ceiling.cumulativeUsd} lifetime`
      : `tier 0 — user delegation is closed (${ceiling.blockers.join('; ') || 'no evidence yet'})`,
    false);

  const delegationProvider = await buildDelegationProvider().isReady();
  add('delegation_provider', delegationProvider.ready, delegationProvider.detail, false);

  const passed = checks.filter((c) => c.blocking).every((c) => c.pass);
  return record(db, targetMode, passed, checks, actor);
}

/**
 * The gate a GRANT must pass before it is allowed to bind a signer. Unlike the
 * mode preflight this is strictly blocking: the money at stake is not the
 * operator's, so an unknown answer is a refusal.
 */
export async function runDelegationPreflight(
  deps: Pick<PreflightDeps, 'db' | 'signer'>,
  actor = 'system',
): Promise<PreflightResult> {
  const { db, signer } = deps;
  const checks: PreflightCheck[] = [];
  const add = (name: string, pass: boolean, detail: string, blocking = true) =>
    checks.push({ name, pass, detail, blocking });

  const provider = await buildDelegationProvider().isReady();
  add('delegation_provider', provider.ready, provider.detail);

  const ceiling = delegationCeiling(db);
  add('delegation_ceiling', ceiling.tier > 0,
    ceiling.tier > 0
      ? `tier ${ceiling.tier} in force`
      : `tier 0 — $0 authorised (${ceiling.blockers.join('; ') || 'no evidence yet'})`);

  // a grant cannot outrun the network's own readiness to execute
  const readiness = await signer.isReady();
  add('delegation_signer', readiness.ready, readiness.detail);

  const symbols = mappedSymbols();
  const mappings = validateMappings();
  add('delegation_instruments', symbols.length > 0 && mappings.ok,
    symbols.length === 0
      ? 'no paper→live instrument mappings — a grant could name no tradable pair'
      : mappings.ok ? `${symbols.length} mapping(s) validated` : mappings.problems.join('; '));

  add('delegation_revocation_cache', revocationCache.isHydrated(),
    revocationCache.isHydrated()
      ? `${revocationCache.size()} non-spendable grant(s) cached`
      : 'revocation cache not hydrated — every grant would fail closed');

  const cfg = getLiveConfig(db);
  add('network_active', !cfg.halted, cfg.halted ? `network halted: ${cfg.haltReason}` : 'network active');

  const passed = checks.filter((c) => c.blocking).every((c) => c.pass);
  return record(db, cfg.mode, passed, checks, actor);
}

function record(
  db: DB,
  targetMode: ExecutionMode,
  passed: boolean,
  checks: PreflightCheck[],
  actor: string,
): PreflightResult {
  const blockers = checks.filter((c) => c.blocking && !c.pass).map((c) => `${c.name}: ${c.detail}`);
  db.prepare(
    `INSERT INTO preflight_runs (ts, target_mode, passed, checks_json, actor) VALUES (?, ?, ?, ?, ?)`,
  ).run(Date.now(), targetMode, passed ? 1 : 0, JSON.stringify(checks), actor);
  appendAudit(db, actor, 'preflight', { targetMode, passed, blockers });
  return { targetMode, passed, checks, blockers };
}

/** render as the terminal shows it */
export function preflightLines(r: PreflightResult): string[] {
  return r.checks.map((c) => {
    const dots = '.'.repeat(Math.max(2, 24 - c.name.length));
    return `${c.name.toUpperCase()} ${dots} ${c.pass ? 'PASS' : c.blocking ? 'FAIL' : 'WARN'}  ${c.detail}`;
  });
}
