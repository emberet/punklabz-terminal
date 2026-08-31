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
import { runDelegationPreflight } from '../../live/preflight.js';

const provider = buildDelegationProvider();

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
    .min(2)
    .max(20),
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
      provider: { kind: provider.kind, ...readiness },
      consentText: DELEGATION_CONSENT_TEXT,
      open: ceiling.tier > 0 && readiness.ready,
    };
  });

  server.get('/api/delegation/preflight', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const result = await runDelegationPreflight({ db: app.db, signer: app.signer }, `user:${user.id}`);
    return result;
  });

  server.get('/api/delegation/grants', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    expireDueGrants(app.db);
    return { grants: listGrants(app.db, user.id) };
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

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const body = parsed.data;

    const bot = app.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(body.botId) as any;
    if (!bot) return reply.code(404).send({ error: 'machine not found' });
    if (bot.owner_user_id !== user.id) {
      return reply.code(403).send({ error: 'you can only delegate to a machine you own' });
    }
    if (!body.allowedTokens.some((t) => t.role === 'base') || !body.allowedTokens.some((t) => t.role === 'quote')) {
      return reply.code(400).send({ error: 'a grant needs at least one base and one quote token' });
    }

    try {
      const { grantId, clampedFields } = createGrant(app.db, {
        userId: user.id,
        botId: body.botId,
        providerUserId: body.providerUserId,
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
    const grantId = Number((request.params as any).id);
    const grant = ownedGrant(app, user.id, grantId);
    if (!grant) return reply.code(404).send({ error: 'grant not found' });

    const sessionSignerId = z.string().min(1).max(200).safeParse((request.body as any)?.sessionSignerId);
    if (!sessionSignerId.success) return reply.code(400).send({ error: 'sessionSignerId required' });

    try {
      await activateGrant(app.db, provider, grantId, sessionSignerId.data, `user:${user.id}`, app.signer);
      const row = app.db.prepare(`SELECT * FROM delegation_grants WHERE id = ?`).get(grantId);
      return { grant: grantView(app.db, row) };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /**
   * REVOCATION. No confirmation step, no cooldown, no admin review. The owner
   * withdraws authority over their own wallet and that is the end of it.
   */
  server.post('/api/delegation/grants/:id/revoke', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
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
