import { createHash } from 'node:crypto';
import {
  DELEGATION_CONSENT_TEXT,
  type DelegationCaps, type GrantView, type RevocationResult,
} from '@punklabz/shared';
import type { DB } from '../../db/db.js';
import { fromMicro, toMicro } from '../../money.js';
import { appendAudit } from '../../audit/auditLog.js';
import type { ExecutionAdapter } from '../adapters.js';
import type { TradingSigner } from '../signing/signer.js';
import { runDelegationPreflight } from '../preflight.js';
import { delegationCeiling, effectiveCaps, grantHeadroomUsd, grantSpend } from './delegationPolicy.js';
import type { DelegationProvider } from './provider.js';
import { revocationCache } from './revocationCache.js';
import { ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD } from '@punklabz/shared';
import { custodyHoldings } from '../accounts.js';
import { ROBINHOOD_VENUE } from '../instruments.js';

const CONSENT_HASH = createHash('sha256').update(DELEGATION_CONSENT_TEXT).digest('hex');

/** the schema only accepts a provider it knows about */
function providerKind(): 'privy' | 'none' {
  return process.env.DELEGATION_PROVIDER === 'privy' ? 'privy' : 'none';
}

function event(db: DB, grantId: number, name: string, actor: string, detail: unknown) {
  const hash = appendAudit(db, actor, `delegation_${name}`, { grantId, ...(detail as object) });
  db.prepare(
    `INSERT INTO delegation_events (grant_id, ts, event, actor, detail_json, audit_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(grantId, Date.now(), name, actor, JSON.stringify(detail), hash);
}

export interface CreateGrantArgs {
  userId: number;
  botId: number;
  providerUserId: string;
  providerWalletId?: string;
  walletAddress: string;
  chainId: number;
  requested: DelegationCaps;
  allowedTokens: { address: string; symbol: string; decimals: number; role: 'base' | 'quote' }[];
  expiresAt: number;
  consentSignature?: string;
}

export function createGrant(db: DB, args: CreateGrantArgs): { grantId: number; clampedFields: string[] } {
  if (args.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error('delegation is crypto-only on Robinhood Chain 4663');
  }
  const expected = new Map([
    [WETH_ROBINHOOD.address.toLowerCase(), { symbol: 'WETH', decimals: WETH_ROBINHOOD.decimals, role: 'base' }],
    [USDG.address.toLowerCase(), { symbol: 'USDG', decimals: USDG.decimals, role: 'quote' }],
  ]);
  if (args.allowedTokens.length !== expected.size) throw new Error('launch grants require exactly canonical WETH and USDG');
  const seen = new Set<string>();
  for (const token of args.allowedTokens) {
    const address = token.address.toLowerCase();
    if (seen.has(address)) throw new Error('grant token list contains a duplicate contract');
    seen.add(address);
    const canonical = expected.get(address);
    if (!canonical || token.symbol !== canonical.symbol || token.decimals !== canonical.decimals || token.role !== canonical.role) {
      throw new Error('grant token metadata does not match the canonical crypto-only registry');
    }
  }
  const ceiling = delegationCeiling(db);

  const existing = db
    .prepare(`SELECT COUNT(*) n FROM delegation_grants WHERE user_id = ? AND status IN ('pending','active','paused')`)
    .get(args.userId) as { n: number };
  if (existing.n >= ceiling.maxGrantsPerUser) {
    throw new Error(
      `grant limit reached: tier ${ceiling.tier} allows ${ceiling.maxGrantsPerUser} concurrent grant(s)` +
        (ceiling.blockers.length ? ` — ${ceiling.blockers.join('; ')}` : ''),
    );
  }

  const { caps, clampedFields } = effectiveCaps(args.requested, ceiling);
  const now = Date.now();

  const grantId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO delegation_grants
           (user_id, bot_id, provider, provider_user_id, provider_wallet_id, wallet_address, chain_id,
            per_trade_cap_micro, daily_cap_micro, cumulative_cap_micro,
            max_open_notional_micro, max_slippage_bps,
            ceiling_tier, ceiling_per_trade_micro, ceiling_cumulative_micro, ceiling_evidence_json,
            expires_at, status, consent_text_hash, consent_signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        args.userId, args.botId, providerKind(),
        args.providerUserId, args.providerWalletId ?? null, args.walletAddress.toLowerCase(), args.chainId,
        toMicro(caps.perTradeUsd), toMicro(caps.dailyUsd), toMicro(caps.cumulativeUsd),
        toMicro(caps.maxOpenNotionalUsd), caps.maxSlippageBps,
        ceiling.tier, toMicro(ceiling.perTradeUsd), toMicro(ceiling.cumulativeUsd),
        JSON.stringify(ceiling.evidence),
        args.expiresAt, CONSENT_HASH, args.consentSignature ?? null, now, now,
      );
    const id = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      `INSERT INTO delegation_tokens (grant_id, chain_id, token_address, symbol, decimals, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const t of args.allowedTokens) {
      stmt.run(id, args.chainId, t.address.toLowerCase(), t.symbol, t.decimals, t.role);
    }
    if (providerKind() === 'privy') {
      const account = db.prepare(
        `INSERT INTO execution_accounts
           (name,mode,venue,wallet_address,currency,funded_usd,active,created_at,
            chain_id,settlement_asset,role,delegation_grant_id)
         VALUES (?, 'canary', ?, ?, 'USDG', 0, 0, ?, 4663, 'USDG', 'trader', ?)`,
      ).run(`USER_BOT_${args.botId}`, ROBINHOOD_VENUE, args.walletAddress.toLowerCase(), now, id);
      db.prepare(
        `INSERT INTO bot_live_wallets
           (bot_id,user_id,execution_account_id,provider,provider_user_id,wallet_id,wallet_address,
            chain_id,state,created_at,updated_at)
         VALUES (?,?,?,'privy',?,?,?,?, 'provisioning',?,?)`,
      ).run(args.botId, args.userId, Number(account.lastInsertRowid), args.providerUserId, args.providerWalletId ?? null,
        args.walletAddress.toLowerCase(), args.chainId, now, now);
    }
    return id;
  })();

  // pending grants cannot spend; the cache reflects that until activation
  revocationCache.revoke(grantId);
  event(db, grantId, 'created', `user:${args.userId}`, {
    requested: args.requested, applied: caps, clampedFields, ceilingTier: ceiling.tier,
  });
  return { grantId, clampedFields };
}

/** Bind the provider's session signer. Without this a grant can never trade. */
export async function activateGrant(
  db: DB,
  provider: DelegationProvider,
  grantId: number,
  sessionSignerId: string,
  actor: string,
  signer?: TradingSigner,
): Promise<void> {
  const grant = db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId) as any;
  if (!grant) throw new Error('grant not found');
  if (grant.status !== 'pending') throw new Error(`grant is ${grant.status}, not pending`);

  // Binding a signer is the moment a stranger's wallet becomes reachable. It
  // gets its own strictly-blocking preflight, not the advisory one the operator
  // sees when changing their own execution mode.
  if (signer) {
    const pre = await runDelegationPreflight({ db, signer }, actor);
    if (!pre.passed) {
      event(db, grantId, 'activation_refused', actor, { blockers: pre.blockers });
      throw new Error(`delegation preflight failed:\n  ${pre.blockers.join('\n  ')}`);
    }
  }

  const binding = await provider.verifySessionSigner({
    providerUserId: grant.provider_user_id,
    providerWalletId: grant.provider_wallet_id,
    walletAddress: grant.wallet_address,
    chainId: grant.chain_id,
    sessionSignerId,
  });
  if (binding.walletAddress.toLowerCase() !== String(grant.wallet_address).toLowerCase()) {
    throw new Error('session signer does not bind the wallet named in this grant');
  }

  const botWallet = db.prepare(
    `SELECT execution_account_id FROM bot_live_wallets WHERE bot_id=? AND user_id=?`,
  ).get(grant.bot_id, grant.user_id) as { execution_account_id: number | null } | undefined;
  if (!botWallet?.execution_account_id) throw new Error('isolated bot execution account is missing');
  const holdings = custodyHoldings(db, botWallet.execution_account_id);
  if ((holdings.get('USDG') ?? 0) <= 0) throw new Error('fund the isolated bot wallet with USDG before activation');
  if ((holdings.get('ETH') ?? 0) < 0.005) throw new Error('bot wallet needs at least 0.005 ETH reserved for gas');
  const reconciliation = db.prepare(
    `SELECT status,completed_at FROM reconciliation_runs
     WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`,
  ).get(botWallet.execution_account_id) as { status: string; completed_at: number | null } | undefined;
  if (reconciliation?.status !== 'clean' || !reconciliation.completed_at
    || Date.now() - reconciliation.completed_at > 10 * 60_000) {
    throw new Error('a clean bot-wallet reconciliation from the last 10 minutes is required');
  }

  const tokens = db
    .prepare(`SELECT token_address FROM delegation_tokens WHERE grant_id = ?`)
    .all(grantId) as { token_address: string }[];
  const { policyId } = await provider.applyPolicy({
    sessionSignerId: binding.sessionSignerId,
    perTradeUsd: fromMicro(grant.per_trade_cap_micro),
    dailyUsd: fromMicro(grant.daily_cap_micro),
    cumulativeUsd: fromMicro(grant.cumulative_cap_micro),
    allowedTokens: tokens.map((t) => t.token_address),
    expiresAt: grant.expires_at,
  });

  db.transaction(() => {
    const now = Date.now();
    db.prepare(
      `UPDATE delegation_grants SET status = 'active', session_signer_id = ?, policy_id = ?, updated_at = ? WHERE id = ?`,
    ).run(binding.sessionSignerId, policyId, now, grantId);
    const account = db.prepare(`SELECT id FROM execution_accounts WHERE delegation_grant_id=?`)
      .get(grantId) as { id: number } | undefined;
    if (!account) throw new Error('isolated bot execution account disappeared during activation');
    db.prepare(`UPDATE execution_accounts SET active=1 WHERE id=?`).run(account.id);
    db.prepare(
      `UPDATE bot_live_wallets SET execution_account_id=?,session_signer_id=?,policy_id=?,state='active',
         screening_status='clear',updated_at=? WHERE bot_id=?`,
    ).run(account.id, binding.sessionSignerId, policyId, now, grant.bot_id);
  })();
  revocationCache.restore(grantId);
  event(db, grantId, 'activated', actor, { sessionSignerId: binding.sessionSignerId, policyId });
}

/**
 * Revoke. Instant, idempotent, and it never waits on the network — a provider
 * outage must not stop an owner withdrawing authority over their own wallet.
 */
export async function revokeGrant(
  db: DB,
  provider: DelegationProvider,
  adapters: Map<string, ExecutionAdapter>,
  grantId: number,
  actor: string,
  reason = 'revoked by owner',
): Promise<RevocationResult> {
  const grant = db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId) as any;
  if (!grant) throw new Error('grant not found');

  // 1. in-process first — closes the approval→submission window immediately
  revocationCache.revoke(grantId);

  // 2 + 3. flip status and kill anything not yet at a venue, atomically
  const unstoppable: number[] = [];
  const cancelled = db.transaction(() => {
    if (grant.status !== 'revoked') {
      db.prepare(
        `UPDATE delegation_grants SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ?, updated_at = ? WHERE id = ?`,
      ).run(Date.now(), actor, reason, Date.now(), grantId);
      db.prepare(`UPDATE bot_live_wallets SET state='revoked',updated_at=? WHERE bot_id=?`)
        .run(Date.now(), grant.bot_id);
      db.prepare(`UPDATE execution_accounts SET active=0 WHERE delegation_grant_id=?`).run(grantId);
    }
    const info = db
      .prepare(
        `UPDATE live_orders SET state = 'cancelled', reject_reason = 'delegation revoked by owner', updated_at = ?
         WHERE delegation_grant_id = ? AND state IN ('proposed','risk_approved')`,
      )
      .run(Date.now(), grantId);
    const inFlight = db
      .prepare(
        `SELECT id FROM live_orders WHERE delegation_grant_id = ?
         AND state IN ('submitting','submitted','pending','open','partial')`,
      )
      .all(grantId) as { id: number }[];
    for (const o of inFlight) unstoppable.push(o.id);
    return info.changes;
  })();

  // best-effort venue cancels for anything already submitted
  for (const orderId of [...unstoppable]) {
    const row = db.prepare(`SELECT venue, venue_order_id FROM live_orders WHERE id = ?`).get(orderId) as any;
    const adapter = row?.venue ? adapters.get(row.venue) : undefined;
    if (adapter && typeof adapter.cancelOrder === 'function' && row.venue_order_id) {
      try {
        await adapter.cancelOrder(row.venue_order_id);
        db.prepare(`UPDATE live_orders SET state = 'cancelled', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
        unstoppable.splice(unstoppable.indexOf(orderId), 1);
      } catch {
        db.prepare(`UPDATE live_orders SET state = 'reconciling', updated_at = ? WHERE id = ?`).run(Date.now(), orderId);
      }
    }
  }

  // 4. provider revoke — never blocks the above
  let providerRevoked = false;
  try {
    if (grant.session_signer_id) {
      await provider.revokeSessionSigner(grant.session_signer_id);
      db.prepare(`UPDATE delegation_grants SET provider_revoked_at = ? WHERE id = ?`).run(Date.now(), grantId);
    }
    providerRevoked = true;
  } catch {
    providerRevoked = false; // reconciler surfaces grants the provider never confirmed
  }

  event(db, grantId, 'revoked', actor, { reason, cancelled, unstoppable, providerRevoked });
  return {
    revoked: true,
    inFlightCancelled: cancelled,
    unstoppable,
    providerRevoked,
    detail: unstoppable.length
      ? `${unstoppable.length} order(s) already submitted to a venue cannot be recalled`
      : 'all authority withdrawn; nothing was in flight',
  };
}

export function setGrantPaused(db: DB, grantId: number, paused: boolean, actor: string): void {
  const grant = db.prepare(
    `SELECT status,bot_id,provider,session_signer_id,expires_at
     FROM delegation_grants WHERE id = ?`,
  ).get(grantId) as any;
  if (!grant) throw new Error('grant not found');
  if (grant.status === 'revoked' || grant.status === 'expired') {
    throw new Error(`grant is ${grant.status} and cannot be resumed`);
  }
  if (!paused) {
    if (grant.status !== 'paused') throw new Error(`grant is ${grant.status}, not paused`);
    if (grant.expires_at <= Date.now()) throw new Error('grant has expired and cannot be resumed');
    if (grant.provider === 'privy') {
      if (!grant.session_signer_id) throw new Error('session signer is not bound');
      const account = db.prepare(
        `SELECT id FROM execution_accounts WHERE delegation_grant_id=?`,
      ).get(grantId) as { id: number } | undefined;
      if (!account) throw new Error('isolated bot execution account is missing');
      const reconciliation = db.prepare(
        `SELECT status,completed_at FROM reconciliation_runs
         WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`,
      ).get(account.id) as { status: string; completed_at: number | null } | undefined;
      if (reconciliation?.status !== 'clean' || !reconciliation.completed_at
        || Date.now() - reconciliation.completed_at > 10 * 60_000) {
        throw new Error('a clean bot-wallet reconciliation from the last 10 minutes is required to resume');
      }
    }
  }
  db.transaction(() => {
    const now = Date.now();
    db.prepare(`UPDATE delegation_grants SET status = ?, updated_at = ? WHERE id = ?`)
      .run(paused ? 'paused' : 'active', now, grantId);
    db.prepare(`UPDATE bot_live_wallets SET state=?,updated_at=? WHERE bot_id=?`)
      .run(paused ? 'paused' : 'active', now, grant.bot_id);
    if (!paused && grant.provider === 'privy') {
      db.prepare(`UPDATE execution_accounts SET active=1 WHERE delegation_grant_id=?`).run(grantId);
    }
  })();
  if (paused) revocationCache.revoke(grantId);
  else revocationCache.restore(grantId);
  event(db, grantId, paused ? 'paused' : 'resumed', actor, {});
}

/** hourly cron — a grant past its expiry stops spending without anyone acting */
export function expireDueGrants(db: DB): number {
  const due = db
    .prepare(`SELECT id FROM delegation_grants WHERE status IN ('pending','active','paused') AND expires_at <= ?`)
    .all(Date.now()) as { id: number }[];
  for (const g of due) {
    db.transaction(() => {
      db.prepare(`UPDATE delegation_grants SET status = 'expired', updated_at = ? WHERE id = ?`)
        .run(Date.now(), g.id);
      db.prepare(`UPDATE bot_live_wallets SET state='paused',updated_at=?
                  WHERE execution_account_id=(SELECT id FROM execution_accounts WHERE delegation_grant_id=?)`)
        .run(Date.now(), g.id);
    })();
    revocationCache.revoke(g.id);
    event(db, g.id, 'expired', 'system', {});
  }
  return due.length;
}

export function grantView(db: DB, row: any): GrantView {
  const spend = grantSpend(db, row.id);
  const bot = db.prepare(`SELECT name FROM bots WHERE id = ?`).get(row.bot_id) as any;
  return {
    id: row.id,
    userId: row.user_id,
    botId: row.bot_id,
    botName: bot?.name ?? null,
    walletAddress: row.wallet_address,
    chainId: row.chain_id,
    status: row.status,
    caps: {
      perTradeUsd: fromMicro(row.per_trade_cap_micro),
      dailyUsd: fromMicro(row.daily_cap_micro),
      cumulativeUsd: fromMicro(row.cumulative_cap_micro),
      maxOpenNotionalUsd: fromMicro(row.max_open_notional_micro),
      maxSlippageBps: row.max_slippage_bps,
    },
    requestedCaps: null,
    clampedFields: [],
    ceilingTier: row.ceiling_tier,
    spentUsd: spend.settledUsd,
    spentTodayUsd: spend.todayUsd,
    reservedUsd: spend.reservedUsd,
    headroomUsd: grantHeadroomUsd(db, row.id),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    providerBound: !!row.session_signer_id,
    revokeReason: row.revoke_reason,
  };
}

export function listGrants(db: DB, userId: number): GrantView[] {
  const rows = db
    .prepare(`SELECT * FROM delegation_grants WHERE user_id = ? ORDER BY id DESC`)
    .all(userId) as any[];
  return rows.map((r) => grantView(db, r));
}
