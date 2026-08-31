import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { budgetView } from '../../research/budget.js';
import { trackRecord } from '../../research/scoring.js';
import {
  INTERN_AGENT, getInternConfig, quotaState, setInternMode,
} from '../../intern/intern.js';
import { buildXAdapter } from '../../intern/xAdapter.js';

const x = buildXAdapter();

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
    const readiness = await x.isReady();

    const posts = app.db
      .prepare(
        `SELECT id, ts, kind, draft, allowed_numbers_json, verdict, blocked_rules_json,
                published_id, ts_published
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
      provider: { kind: x.kind, ...readiness },
      quota,
      maxPostsPerDay: cfg.maxPostsPerDay,
      readsIngested: reads.n,
      lastReadAt: reads.last,
      counts: Object.fromEntries(counts.map((c) => [c.verdict, c.n])),
      blockedByRule: [...byRule.entries()].map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n),
      trackRecord: trackRecord(app.db, INTERN_AGENT),
      budget: budgetView(app.db),
      posts: posts.map((p) => ({
        id: p.id, ts: p.ts, kind: p.kind, draft: p.draft,
        allowedNumbers: JSON.parse(p.allowed_numbers_json),
        verdict: p.verdict,
        blockedRules: p.blocked_rules_json ? JSON.parse(p.blocked_rules_json) : [],
        publishedId: p.published_id, publishedAt: p.ts_published,
      })),
    };
  });

  /** Switching the intern to live is an operator decision, and an audited one. */
  server.post('/api/intern/mode', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!user.isAdmin) return reply.code(403).send({ error: 'CONTROL ROOM clearance required' });

    const parsed = z.object({ mode: z.enum(['off', 'shadow', 'live']) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    if (parsed.data.mode === 'live') {
      const readiness = await x.isReady();
      if (!readiness.ready) return reply.code(409).send({ error: readiness.detail });

      const blocked = app.db
        .prepare(`SELECT COUNT(*) n FROM intern_posts WHERE verdict = 'blocked'`)
        .get() as { n: number };
      const total = app.db.prepare(`SELECT COUNT(*) n FROM intern_posts`).get() as { n: number };
      if (total.n < 20) {
        return reply.code(409).send({
          error: `${total.n} candidates on record. Publish nothing until the shadow log has ` +
            'enough in it to be worth reading — 20 minimum, and read the blocked ones.',
        });
      }
      app.db.prepare(`UPDATE intern_config SET shadow_started_at = shadow_started_at WHERE id = 1`).run();
      setInternMode(app.db, 'live', `user:${user.id}`);
      return { mode: 'live', blockedSoFar: blocked.n, candidatesReviewed: total.n };
    }

    setInternMode(app.db, parsed.data.mode, `user:${user.id}`);
    return { mode: parsed.data.mode };
  });
}
