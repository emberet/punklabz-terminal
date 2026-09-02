import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { budgetView } from '../../research/budget.js';
import { trackRecord } from '../../research/scoring.js';
import {
  INTERN_AGENT, INTERN_LAUNCH_REVIEW_WINDOW_MS, INTERN_LIVE_DAILY_POST_CAP,
  getInternConfig, internLaunchEvidence, publishInternThread, quotaState,
  reconcileInternPublishing, runInternCycle, setInternMode,
} from '../../intern/intern.js';
import { appendAudit } from '../../audit/auditLog.js';
import { xPostUrl } from '../../intern/xAdapter.js';

function requireFreshAdmin(app: AppContext, request: any, reply: any) {
  const user = requireUser(app, request, reply);
  if (!user) return null;
  if (!user.isAdmin) {
    reply.code(403).send({ error: 'CONTROL ROOM clearance required' });
    return null;
  }
  if (user.sessionAuthMethod !== 'wallet' || Date.now() - user.sessionCreatedAt > 5 * 60_000) {
    reply.code(401).send({ error: 'fresh operator wallet authentication required' });
    return null;
  }
  if (request.headers['x-requested-with'] !== 'punklabz') {
    reply.code(403).send({ error: 'CSRF protection header missing' });
    return null;
  }
  const origin = request.headers.origin as string | undefined;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) {
        reply.code(403).send({ error: 'request origin does not match host' });
        return null;
      }
    } catch {
      reply.code(403).send({ error: 'invalid request origin' });
      return null;
    }
  }
  return user;
}

export function registerInternRoutes(server: FastifyInstance, app: AppContext) {
  /**
   * THE BLOCK LOG, PUBLIC BY DESIGN.
   *
   * A content filter nobody can inspect is a claim, not a control. Every
   * candidate the intern produced is here — the published ones, the blocked
   * ones, and what the model actually wrote before filtering.
   */
  server.get('/api/intern', async () => {
    const cfg = getInternConfig(app.db);
    const quota = quotaState(app.db);
    const readiness = await app.xAdapter.isReady();

    const posts = app.db
      .prepare(
        `SELECT id, ts, kind, draft, allowed_numbers_json, verdict, blocked_rules_json,
                published_id, ts_published, provider_kind, source_count,
                reviewed_at, reviewed_by, review_approved, publish_state, publish_attempted_at
         FROM intern_posts ORDER BY id DESC LIMIT 100`,
      )
      .all() as any[];

    const counts = app.db
      .prepare(`SELECT verdict, COUNT(*) n FROM intern_posts GROUP BY verdict`)
      .all() as { verdict: string; n: number }[];

    const ruleHits = app.db
      .prepare(`SELECT blocked_rules_json FROM intern_posts WHERE blocked_rules_json IS NOT NULL`)
      .all() as { blocked_rules_json: string }[];
    const byRule = new Map<string, number>();
    for (const r of ruleHits) {
      for (const rule of JSON.parse(r.blocked_rules_json) as string[]) {
        byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      }
    }

    const reads = app.db
      .prepare(`SELECT COUNT(*) n, MAX(fetched_at) last FROM intern_reads`)
      .get() as { n: number; last: number | null };

    return {
      mode: cfg.mode,
      shadowStartedAt: cfg.shadowStartedAt,
      shadowDays: cfg.shadowStartedAt ? (Date.now() - cfg.shadowStartedAt) / 86_400_000 : 0,
      provider: { kind: app.xAdapter.kind, ...readiness },
      sourceLabel: app.xAdapter.kind === 'api' && reads.n > 0 ? 'X-BACKED' : 'INTERNAL DATA ONLY',
      quota,
      maxPostsPerDay: cfg.maxPostsPerDay,
      readsIngested: reads.n,
      lastReadAt: reads.last,
      counts: Object.fromEntries(counts.map((c) => [c.verdict, c.n])),
      blockedByRule: [...byRule.entries()].map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n),
      trackRecord: trackRecord(app.db, INTERN_AGENT),
      budget: budgetView(app.db, 'intern'),
      posts: posts.map((p) => ({
        id: p.id, ts: p.ts, kind: p.kind, draft: p.draft,
        allowedNumbers: JSON.parse(p.allowed_numbers_json),
        verdict: p.verdict,
        blockedRules: p.blocked_rules_json ? JSON.parse(p.blocked_rules_json) : [],
        publishedId: p.published_id, publishedAt: p.ts_published,
        providerKind: p.provider_kind, sourceCount: p.source_count,
        reviewedAt: p.reviewed_at, reviewedBy: p.reviewed_by,
        reviewApproved: p.review_approved === 1,
        publishState: p.publish_state,
        publishAttemptedAt: p.publish_attempted_at,
        publishedUrl: p.published_id ? xPostUrl(p.published_id) : null,
      })),
    };
  });

  /** Switching the intern to live is an operator decision, and an audited one. */
  server.post('/api/intern/mode', { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;

    const parsed = z.object({ mode: z.enum(['off', 'shadow', 'live']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    if (parsed.data.mode === 'live') {
      const quota = quotaState(app.db);
      if (quota.halted) return reply.code(409).send({ error: `Intern halted: ${quota.haltReason}` });
      const reconciliation = reconcileInternPublishing(app.db);
      if (!reconciliation.clean) {
        return reply.code(409).send({ error: 'Intern publish state is not reconciled' });
      }
      const readiness = await app.xAdapter.isReady();
      if (!readiness.ready) return reply.code(409).send({ error: readiness.detail });
      if (app.xAdapter.kind !== 'api') {
        return reply.code(409).send({ error: `Live publishing requires X_PROVIDER=api, got ${app.xAdapter.kind}` });
      }
      const evidence = internLaunchEvidence(app.db);
      if (evidence.count < 1) {
        return reply.code(409).send({
          error: `${evidence.count}/1 fresh X-backed shadow draft explicitly approved by the operator`,
        });
      }
      app.db.transaction(() => {
        app.db.prepare(`UPDATE intern_config SET max_posts_per_day=? WHERE id=1`)
          .run(INTERN_LIVE_DAILY_POST_CAP);
        setInternMode(app.db, 'live', `user:${user.id}`);
      })();
      return {
        mode: 'live',
        candidatesReviewed: evidence.count,
        maxPostsPerDay: INTERN_LIVE_DAILY_POST_CAP,
      };
    }

    setInternMode(app.db, parsed.data.mode, `user:${user.id}`);
    return { mode: parsed.data.mode };
  });

  server.post('/api/admin/intern/cycle', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const result = await runInternCycle(app.db, app.hub, app.xAdapter);
    appendAudit(app.db, `user:${user.id}`, 'intern_manual_cycle', {
      ran: result.ran, verdict: result.verdict, read: result.read, reason: result.reason,
    });
    return result;
  });

  server.post('/api/admin/intern/thread', { config: { rateLimit: { max: 2, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({
      posts: z.array(z.string().trim().min(1).max(240)).min(2).max(3),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0].message });

    try {
      const result = await publishInternThread(app.db, app.hub, app.xAdapter, body.data.posts);
      appendAudit(app.db, `user:${user.id}`, 'intern_manual_thread', {
        postIds: result.posts.map((post) => post.publishedId),
      });
      return result;
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.post('/api/admin/intern/review', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const user = requireFreshAdmin(app, request, reply);
    if (!user) return;
    const body = z.object({ postId: z.number().int().positive(), approved: z.boolean() }).parse(request.body);
    const post = app.db.prepare(
      `SELECT verdict, provider_kind, source_count, ts, blocked_rules_json,
              published_id, publish_state
       FROM intern_posts WHERE id=?`,
    ).get(body.postId) as {
      verdict: string; provider_kind: string; source_count: number; ts: number;
      blocked_rules_json: string | null; published_id: string | null; publish_state: string;
    } | undefined;
    if (!post) return reply.code(404).send({ error: 'candidate not found' });
    if (post.verdict !== 'shadow') return reply.code(409).send({ error: 'only shadow candidates can be reviewed' });
    if (body.approved) {
      const cfg = getInternConfig(app.db);
      const freshAfter = Math.max(cfg.shadowStartedAt ?? 0, Date.now() - INTERN_LAUNCH_REVIEW_WINDOW_MS);
      if (post.provider_kind !== 'api' || post.source_count <= 0) {
        return reply.code(409).send({ error: 'INTERNAL DATA ONLY drafts cannot satisfy the X-backed launch gate' });
      }
      if (post.ts < freshAfter) return reply.code(409).send({ error: 'candidate is older than the 24-hour launch window' });
      if (post.blocked_rules_json || post.published_id || post.publish_state !== 'not_attempted') {
        return reply.code(409).send({ error: 'candidate is not clean unpublished launch evidence' });
      }
    }
    const now = Date.now();
    app.db.prepare(
      `UPDATE intern_posts SET reviewed_at=?, reviewed_by=?, review_approved=? WHERE id=?`,
    ).run(now, `user:${user.id}`, body.approved ? 1 : 0, body.postId);
    appendAudit(app.db, `user:${user.id}`, 'intern_candidate_review', {
      postId: body.postId, approved: body.approved,
    });
    return { ok: true, postId: body.postId, approved: body.approved, reviewedAt: now };
  });
}
