import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CEILING_TIERS, DELEGATION_CONSENT_TEXT } from '@punklabz/shared';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { toMicro } from '../../money.js';
import { appendAudit } from '../../audit/auditLog.js';
import {
  delegationCeiling, effectiveCaps, grantSpend,
} from '../../live/delegation/delegationPolicy.js';
import {
  activateGrant, createGrant, expireDueGrants, grantView, listGrants, revokeGrant, setGrantPaused,
} from '../../live/delegation/grants.js';
import { buildDelegationProvider } from '../../live/delegation/provider.js';
import { runDelegationPreflight, type PreflightResult } from '../../live/preflight.js';
import { config } from '../../config.js';
import { subscriptionAccess } from '../../billing/subscriptions.js';
import { screenWallet } from '../../compliance/chainalysis.js';
import { ROBINHOOD_MAINNET_CHAIN_ID, USDG, WETH_ROBINHOOD } from '@punklabz/shared';
import { custodyHoldings, recordFunding } from '../../live/accounts.js';
import { reconcileAccount } from '../../live/reconciler.js';
import { ROBINHOOD_VENUE } from '../../live/instruments.js';

const provider = buildDelegationProvider();

export function memberDelegationPreflight(result: PreflightResult): PreflightResult {
  const checks = result.checks.map((check) => {
    if (check.name === 'delegation_provider') {
      return {
        ...check,
        detail: check.pass
          ? 'external wallet provider configured with enforced crypto-only controls'
          : 'external wallet provider is unavailable; operator review required',
      };
    }
    if (check.name === 'delegation_signer') {
      return {
        ...check,
        detail: check.pass
          ? 'external signer and app-side policy controls are enforced'
          : 'external signer is unavailable; operator review required',
      };
    }
    return check;
  });
  const blockers = checks
    .filter((check) => check.blocking && !check.pass)
    .map((check) => `${check.name}: ${check.detail}`);
  return { ...result, checks, blockers };
}

function validSameOrigin(request: any): boolean {
  if (request.headers['x-requested-with'] !== 'punklabz') return false;
  const origin = request.headers.origin as string | undefined;
  if (!origin || !config.appOrigin) return false;
  try { return new URL(origin).origin === new URL(config.appOrigin).origin; } catch { return false; }
}

const capsSchema = z.object({
  perTradeUsd: z.number().min(0).max(1_000_000),
  dailyUsd: z.number().min(0).max(1_000_000),
  cumulativeUsd: z.number().min(0).max(1_000_000),
  maxOpenNotionalUsd: z.number().min(0).max(1_000_000),
  maxSlippageBps: z.number().int().min(1).max(1000),
});

const createSchema = z.object({
  botId: z.number().int().positive(),
  providerUserId: z.string().min(1).max(200),
  providerWalletId: z.string().min(1).max(200).optional(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'not an EVM address'),
  chainId: z.number().int().positive(),
  caps: capsSchema,
  allowedTokens: z
    .array(
      z.object({
        address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        symbol: z.string().min(1).max(20),
        decimals: z.number().int().min(0).max(36),
        role: z.enum(['base', 'quote']),
      }),
    )
    .length(2),
  durationDays: z.number().int().min(1).max(90),
  consentAccepted: z.literal(true),
  consentSignature: z.string().max(400).optional(),
});

/** the grant must belong to the caller — ownership is checked from the DB, never from the request */
function ownedGrant(app: AppContext, userId: number, grantId: number) {
  return app.db
    .prepare(`SELECT * FROM delegation_grants WHERE id = ? AND user_id = ?`)
    .get(grantId, userId) as any;
}

export function registerDelegationRoutes(server: FastifyInstance, app: AppContext) {
  /** What delegation is currently allowed to do, and why it is not more. */
  server.get('/api/delegation/ceiling', async () => {
    const ceiling = delegationCeiling(app.db);
    const readiness = await provider.isReady();
    return {
      ceiling,
      tiers: CEILING_TIERS,
      provider: {
        kind: provider.kind,
        ready: readiness.ready,
        detail: readiness.ready
          ? 'external wallet provider configured with enforced crypto-only controls'
          : provider.kind === 'none'
            ? 'no delegation provider configured'
            : 'external wallet provider is unavailable; operator review required',
      },
      consentText: DELEGATION_CONSENT_TEXT,
      open: ceiling.tier > 0 && readiness.ready,
    };
  });

  server.get('/api/delegation/preflight', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const result = await runDelegationPreflight({ db: app.db, signer: app.signer }, `user:${user.id}`);
    return memberDelegationPreflight(result);
  });

  server.get('/api/delegation/grants', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    expireDueGrants(app.db);
    return { grants: listGrants(app.db, user.id) };
  });

  server.get('/api/delegation/bot-wallets', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const rows = app.db.prepare(
      `SELECT bw.bot_id,b.name bot_name,bw.execution_account_id,bw.wallet_address,bw.chain_id,bw.state,bw.screening_status,
              bw.created_at,bw.updated_at
       FROM bot_live_wallets bw JOIN bots b ON b.id=bw.bot_id
       WHERE bw.user_id=? ORDER BY bw.id DESC`,
    ).all(user.id) as any[];
    return { wallets: rows.map((row) => {
      const account = row.execution_account_id ? app.db.prepare(
        `SELECT id FROM execution_accounts WHERE id=?`,
      ).get(row.execution_account_id) as { id: number } | undefined : undefined;
      const reconciliation = account ? app.db.prepare(
        `SELECT status,completed_at,detail FROM reconciliation_runs
         WHERE execution_account_id=? ORDER BY id DESC LIMIT 1`,
      ).get(account.id) as any : null;
      return {
      botId: row.bot_id, botName: row.bot_name, walletAddress: row.wallet_address,
      chainId: row.chain_id, state: row.state, screeningStatus: row.screening_status,
      createdAt: row.created_at, updatedAt: row.updated_at,
        reconciledHoldings: account ? Object.fromEntries(custodyHoldings(app.db, account.id)) : {},
        reconciliation: reconciliation ? {
          status: reconciliation.status, completedAt: reconciliation.completed_at, detail: reconciliation.detail,
        } : null,
      };
    }) };
  });

  server.post('/api/delegation/provisioning-config', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin validation failed' });
    const membership = subscriptionAccess(app.db, user.id, config.billingEnforced);
    if (!membership.allowed) return reply.code(402).send({ error: membership.reason, code: 'subscription_required' });
    const ceiling = delegationCeiling(app.db);
    if (ceiling.tier === 0) return reply.code(409).send({ error: 'live-bot wallet provisioning is locked at delegation tier 0' });
    const identity = app.db.prepare(`SELECT 1 FROM privy_identities WHERE user_id=?`).get(user.id);
    if (!identity) return reply.code(409).send({ error: 'link Privy before provisioning a live-bot wallet' });
    const signer = await provider.provisioningConfig();
    if (!signer) return reply.code(503).send({ error: 'reviewed Privy user-bot policy is unavailable' });
    return { signer };
  });

  /**
   * Preview: what the caps the user typed would actually become. The UI calls
   * this on every keystroke so the number that applies is never a surprise
   * discovered after signing.
   */
  server.post('/api/delegation/preview', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const parsed = capsSchema.safeParse((request.body as any)?.caps);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const ceiling = delegationCeiling(app.db);
    const { caps, clampedFields } = effectiveCaps(parsed.data, ceiling);
    return { requested: parsed.data, applied: caps, clampedFields, ceiling };
  });

  server.post('/api/delegation/grants', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const membership = subscriptionAccess(app.db, user.id, config.billingEnforced);
    if (!membership.allowed) return reply.code(402).send({ error: membership.reason, code: 'subscription_required' });

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const body = parsed.data;
    const privyIdentity = app.db.prepare(
      `SELECT provider_user_id FROM privy_identities WHERE user_id=?`,
    ).get(user.id) as { provider_user_id: string } | undefined;
    if (!privyIdentity) return reply.code(409).send({ error: 'link Privy before creating a live-bot wallet' });
    if (privyIdentity.provider_user_id !== body.providerUserId) {
      return reply.code(403).send({ error: 'Privy wallet owner does not match the linked PunkLabz identity' });
    }

    const bot = app.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(body.botId) as any;
    if (!bot) return reply.code(404).send({ error: 'machine not found' });
    if (bot.owner_user_id !== user.id) {
      return reply.code(403).send({ error: 'you can only delegate to a machine you own' });
    }
    if (!body.allowedTokens.some((t) => t.role === 'base') || !body.allowedTokens.some((t) => t.role === 'quote')) {
      return reply.code(400).send({ error: 'a grant needs at least one base and one quote token' });
    }
    if (body.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
      return reply.code(400).send({ error: 'user bots launch only on Robinhood Chain 4663' });
    }
    const canonical = new Map([
      [WETH_ROBINHOOD.address.toLowerCase(), `WETH:${WETH_ROBINHOOD.decimals}:base`],
      [USDG.address.toLowerCase(), `USDG:${USDG.decimals}:quote`],
    ]);
    const supplied = new Set(body.allowedTokens.map((token) => token.address.toLowerCase()));
    if (supplied.size !== 2 || [...canonical.keys()].some((address) => !supplied.has(address))
      || body.allowedTokens.some((token) => canonical.get(token.address.toLowerCase()) !== `${token.symbol}:${token.decimals}:${token.role}`)) {
      return reply.code(400).send({ error: 'launch grants allow only exact canonical WETH and USDG metadata' });
    }

    try {
      const { grantId, clampedFields } = createGrant(app.db, {
        userId: user.id,
        botId: body.botId,
        providerUserId: body.providerUserId,
        providerWalletId: body.providerWalletId,
        walletAddress: body.walletAddress,
        chainId: body.chainId,
        requested: body.caps,
        allowedTokens: body.allowedTokens,
        expiresAt: Date.now() + body.durationDays * 86_400_000,
        consentSignature: body.consentSignature,
      });
      const row = app.db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId);
      return { grant: grantView(app.db, row), clampedFields };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  server.post('/api/delegation/grants/:id/activate', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const membership = subscriptionAccess(app.db, user.id, config.billingEnforced);
    if (!membership.allowed) return reply.code(402).send({ error: membership.reason, code: 'subscription_required' });
    const grantId = Number((request.params as any).id);
    const grant = ownedGrant(app, user.id, grantId);
    if (!grant) return reply.code(404).send({ error: 'grant not found' });
    if (!grant.provider_wallet_id) return reply.code(409).send({ error: 'verify the Privy signer binding before activation' });

    const sessionSignerId = z.string().min(1).max(200).safeParse((request.body as any)?.sessionSignerId);
    if (!sessionSignerId.success) return reply.code(400).send({ error: 'sessionSignerId required' });

    try {
      const screening = await screenWallet(app.db, user.id, grant.wallet_address);
      app.db.prepare(`UPDATE bot_live_wallets SET screening_status=?,updated_at=? WHERE bot_id=?`)
        .run(screening.result, Date.now(), grant.bot_id);
      if (screening.result !== 'clear') {
        return reply.code(409).send({ error: `wallet screening is ${screening.result}: ${screening.detail}` });
      }
      await activateGrant(app.db, provider, grantId, sessionSignerId.data, `user:${user.id}`, app.signer);
      const row = app.db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId);
      return { grant: grantView(app.db, row) };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  server.post('/api/delegation/grants/:id/provider-wallet', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const grantId = Number((request.params as any).id);
    const grant = ownedGrant(app, user.id, grantId);
    if (!grant) return reply.code(404).send({ error: 'grant not found' });
    if (grant.status !== 'pending') return reply.code(409).send({ error: `grant is ${grant.status}, not pending` });
    const body = z.object({
      providerWalletId: z.string().min(1).max(200),
      sessionSignerId: z.string().min(1).max(200),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Privy wallet and signer IDs are required' });
    try {
      await provider.verifySessionSigner({
        providerUserId: grant.provider_user_id,
        providerWalletId: body.data.providerWalletId,
        walletAddress: grant.wallet_address,
        chainId: grant.chain_id,
        sessionSignerId: body.data.sessionSignerId,
      });
      const screening = await screenWallet(app.db, user.id, grant.wallet_address);
      if (screening.result !== 'clear') {
        app.db.prepare(`UPDATE bot_live_wallets SET screening_status=?,state='blocked',updated_at=? WHERE bot_id=?`)
          .run(screening.result, Date.now(), grant.bot_id);
        return reply.code(409).send({
          error: `wallet screening is ${screening.result}: ${screening.detail}; do not fund this wallet`,
        });
      }
      app.db.transaction(() => {
        app.db.prepare(
          `UPDATE delegation_grants SET provider_wallet_id=?,updated_at=? WHERE id=?`,
        ).run(body.data.providerWalletId, Date.now(), grantId);
        app.db.prepare(
          `UPDATE bot_live_wallets
           SET wallet_id=?,session_signer_id=?,screening_status='clear',state='awaiting_funds',updated_at=?
           WHERE bot_id=? AND user_id=?`,
        ).run(body.data.providerWalletId, body.data.sessionSignerId, Date.now(), grant.bot_id, user.id);
        appendAudit(app.db, `user:${user.id}`, 'delegation_provider_wallet_verified', {
          grantId, botId: grant.bot_id,
        });
      })();
      return { ok: true, grantId, state: 'awaiting_funds' };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.post('/api/delegation/grants/:id/funding/import', {
    config: { rateLimit: { max: 8, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const grantId = Number((request.params as any).id);
    const grant = ownedGrant(app, user.id, grantId);
    if (!grant) return reply.code(404).send({ error: 'grant not found' });
    if (!grant.provider_wallet_id) return reply.code(409).send({ error: 'verify the Privy signer binding before importing funds' });
    const body = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'a Robinhood Chain transaction hash is required' });
    const wallet = app.db.prepare(
      `SELECT execution_account_id,wallet_address FROM bot_live_wallets WHERE bot_id=? AND user_id=?`,
    ).get(grant.bot_id, user.id) as { execution_account_id: number | null; wallet_address: string } | undefined;
    if (!wallet?.execution_account_id) return reply.code(409).send({ error: 'isolated bot execution account is missing' });
    const adapter = app.adapters.get(ROBINHOOD_VENUE);
    if (!adapter?.getFundingTransfers) return reply.code(503).send({ error: 'Robinhood funding decoder is unavailable' });
    try {
      const transfers = (await adapter.getFundingTransfers(body.data.txHash, wallet.wallet_address))
        .filter((entry) => entry.asset === 'USDG' || entry.asset === 'ETH');
      if (!transfers.length) throw new Error('transaction contains no USDG or ETH funding into this bot wallet');
      const duplicate = transfers.every((entry) => app.db.prepare(
        `SELECT 1 FROM execution_account_funding
         WHERE execution_account_id=? AND lower(tx_ref)=lower(?) AND log_index=?`,
      ).get(wallet.execution_account_id, entry.txRef, entry.logIndex));
      const inserted = duplicate ? 0 : recordFunding(app.db, wallet.execution_account_id, transfers.map((entry) => ({
        asset: entry.asset, qty: entry.qty, txRef: entry.txRef, logIndex: entry.logIndex,
        contractAddress: entry.contractAddress, decimals: entry.decimals, rawQty: entry.rawQty,
        note: 'verified user bot funding import',
      })), `user:${user.id}`);
      const reconciliation = await reconcileAccount(app.db, app.hub, wallet.execution_account_id, adapter);
      if (!reconciliation.ok) return reply.code(409).send({ error: reconciliation.detail, inserted });
      return {
        ok: true, inserted, duplicate, reconciliation,
        holdings: Object.fromEntries(custodyHoldings(app.db, wallet.execution_account_id)),
      };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.post('/api/delegation/grants/:id/reconcile', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const grantId = Number((request.params as any).id);
    const grant = ownedGrant(app, user.id, grantId);
    if (!grant) return reply.code(404).send({ error: 'grant not found' });
    const wallet = app.db.prepare(
      `SELECT execution_account_id FROM bot_live_wallets WHERE bot_id=? AND user_id=?`,
    ).get(grant.bot_id, user.id) as { execution_account_id: number | null } | undefined;
    if (!wallet?.execution_account_id) return reply.code(409).send({ error: 'isolated bot execution account is missing' });
    const adapter = app.adapters.get(ROBINHOOD_VENUE);
    if (!adapter) return reply.code(503).send({ error: 'Robinhood adapter is unavailable' });
    const reconciliation = await reconcileAccount(app.db, app.hub, wallet.execution_account_id, adapter);
    return reply.code(reconciliation.ok ? 200 : 409).send({
      reconciliation,
      holdings: Object.fromEntries(custodyHoldings(app.db, wallet.execution_account_id)),
    });
  });

  server.post('/api/delegation/grants/:id/withdrawal-check', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const grantId = Number((request.params as any).id);
    const grant = ownedGrant(app, user.id, grantId);
    if (!grant) return reply.code(404).send({ error: 'grant not found' });
    if (!['paused', 'revoked', 'expired'].includes(grant.status)) {
      return reply.code(409).send({ error: 'pause or revoke the bot before checking withdrawal readiness' });
    }
    const wallet = app.db.prepare(
      `SELECT execution_account_id,wallet_address FROM bot_live_wallets WHERE bot_id=? AND user_id=?`,
    ).get(grant.bot_id, user.id) as { execution_account_id: number | null; wallet_address: string } | undefined;
    if (!wallet?.execution_account_id) return reply.code(409).send({ error: 'isolated bot execution account is missing' });
    const unresolved = (app.db.prepare(
      `SELECT COUNT(*) n FROM live_orders o
       WHERE o.execution_account_id=? AND o.state IN ('submitting','submitted','pending','open','partial','reconciling')`,
    ).get(wallet.execution_account_id) as { n: number }).n + (app.db.prepare(
      `SELECT COUNT(*) n FROM execution_transactions
       WHERE execution_account_id=? AND state IN ('prepared','signed','broadcast','unknown')`,
    ).get(wallet.execution_account_id) as { n: number }).n;
    if (unresolved) return reply.code(409).send({ error: `${unresolved} transaction or order record(s) remain unresolved` });
    const adapter = app.adapters.get(ROBINHOOD_VENUE);
    if (!adapter) return reply.code(503).send({ error: 'Robinhood adapter is unavailable' });
    const reconciliation = await reconcileAccount(app.db, app.hub, wallet.execution_account_id, adapter);
    if (!reconciliation.ok) return reply.code(409).send({ error: reconciliation.detail });
    return {
      ready: true,
      walletAddress: wallet.wallet_address,
      assetsInKind: Object.fromEntries(custodyHoldings(app.db, wallet.execution_account_id)),
      ownerActionRequired: true,
      liquidationAvailable: false,
      detail: 'remove the PunkLabz signer in Privy, then withdraw assets from your own wallet',
    };
  });

  /**
   * REVOCATION. No confirmation step, no cooldown, no admin review. The owner
   * withdraws authority over their own wallet and that is the end of it.
   */
  server.post('/api/delegation/grants/:id/revoke', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const grantId = Number((request.params as any).id);
    if (!ownedGrant(app, user.id, grantId)) return reply.code(404).send({ error: 'grant not found' });

    const reason = z.string().max(200).optional().safeParse((request.body as any)?.reason);
    const result = await revokeGrant(
      app.db, provider, app.adapters, grantId, `user:${user.id}`,
      (reason.success && reason.data) || 'revoked by owner',
    );
    app.hub.publish('live', { event: 'delegation_revoked', grantId, unstoppable: result.unstoppable.length });
    return result;
  });

  server.post('/api/delegation/grants/:id/pause', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    const grantId = Number((request.params as any).id);
    if (!ownedGrant(app, user.id, grantId)) return reply.code(404).send({ error: 'grant not found' });
    const paused = (request.body as any)?.paused !== false;
    try {
      setGrantPaused(app.db, grantId, paused, `user:${user.id}`);
      const row = app.db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId);
      return { grant: grantView(app.db, row) };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** Every decision made about this grant, in order. The owner's own audit trail. */
  server.get('/api/delegation/grants/:id/events', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const grantId = Number((request.params as any).id);
    if (!ownedGrant(app, user.id, grantId)) return reply.code(404).send({ error: 'grant not found' });
    const events = app.db
      .prepare(`SELECT ts, event, actor, detail_json, audit_hash FROM delegation_events WHERE grant_id = ? ORDER BY id DESC LIMIT 200`)
      .all(grantId) as any[];
    return {
      spend: grantSpend(app.db, grantId),
      events: events.map((e) => ({
        ts: e.ts, event: e.event, actor: e.actor,
        detail: JSON.parse(e.detail_json), auditHash: e.audit_hash,
      })),
    };
  });

  /**
   * ADMIN. The tier can only be held DOWN. There is no route that raises it —
   * that is decided by delegationCeiling() from measured evidence, and this
   * asymmetry is the whole point.
   */
  server.post('/api/delegation/ceiling', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!validSameOrigin(request)) return reply.code(403).send({ error: 'same-origin CSRF validation failed' });
    if (!user.isAdmin) return reply.code(403).send({ error: 'CONTROL ROOM clearance required' });

    const parsed = z
      .object({ tier: z.number().int().min(0).max(3), externallyAudited: z.boolean().optional() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    const current = delegationCeiling(app.db);
    if (parsed.data.tier > current.tier) {
      return reply.code(403).send({
        error:
          `tier ${parsed.data.tier} cannot be set: the ceiling is earned from evidence, not assigned. ` +
          `In force: tier ${current.tier}. Outstanding: ${current.blockers.join('; ') || 'none'}`,
      });
    }

    const spec = CEILING_TIERS[parsed.data.tier];
    app.db.prepare(
      `INSERT INTO delegation_ceiling
         (tier, per_trade_cap_micro, cumulative_cap_micro, daily_cap_micro,
          max_grants_per_user, max_total_delegated_micro, externally_audited,
          evidence_json, effective_at, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      spec.tier, toMicro(spec.perTradeUsd), toMicro(spec.cumulativeUsd), toMicro(spec.dailyUsd),
      spec.maxGrantsPerUser, toMicro(spec.maxTotalDelegatedUsd),
      parsed.data.externallyAudited ? 1 : 0,
      JSON.stringify(current.evidence), Date.now(), `user:${user.id}`,
    );
    appendAudit(app.db, `user:${user.id}`, 'delegation_ceiling_lowered', {
      from: current.tier, to: parsed.data.tier,
    });
    return { ceiling: delegationCeiling(app.db) };
  });
}
