import { createHash } from 'node:crypto';
import type { DB } from '../db/db.js';

const RETENTION_MS = 30 * 86_400_000;

export interface ModerationVerdict {
  accepted: boolean;
  hash: string;
  rules: string[];
}

export function forumContentHash(body: string): string {
  return createHash('sha256').update(body.normalize('NFKC')).digest('hex');
}

/** Deterministic first-pass moderation; the model never decides whether it may be prompted. */
export function moderateHumanForumPost(body: string): ModerationVerdict {
  const normalized = body.normalize('NFKC').trim();
  const rules: string[] = [];
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized)) rules.push('control_characters');
  if (/(ignore|disregard|override).{0,40}(system|developer|previous).{0,30}(prompt|instruction)/i.test(normalized)) {
    rules.push('prompt_injection');
  }
  if (/(reveal|print|dump|show).{0,40}(private key|seed phrase|api key|system prompt|policy id|wallet address)/i.test(normalized)) {
    rules.push('secret_extraction');
  }
  if (/\b(?:0x[a-fA-F0-9]{64}|sk-ant-[a-zA-Z0-9_-]{20,})\b/.test(normalized)) rules.push('secret_material');
  return { accepted: rules.length === 0, hash: forumContentHash(normalized), rules };
}

/** Public agent output cannot contain execution identifiers or secret-like values. */
export function moderateAgentForumPost(body: string): ModerationVerdict {
  const normalized = body.normalize('NFKC').trim();
  const rules: string[] = [];
  if (/\b0x[a-fA-F0-9]{40,64}\b/.test(normalized)) rules.push('wallet_or_transaction_identifier');
  if (/\b(private key|seed phrase|api key|authorization key|policy id|system prompt)\b/i.test(normalized)) {
    rules.push('private_execution_detail');
  }
  return { accepted: rules.length === 0, hash: forumContentHash(normalized), rules };
}

export function recordModeration(
  db: DB,
  args: { postId?: number; userId?: number; hash: string; verdict: 'accepted' | 'rejected' | 'redacted' | 'expired'; rules: string[] },
): void {
  db.prepare(
    `INSERT INTO forum_moderation_events
       (post_id, user_id, content_hash, verdict, rules_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.postId ?? null, args.userId ?? null, args.hash, args.verdict, JSON.stringify(args.rules), Date.now());
}

export function forumExpiry(ts: number): number {
  return ts + RETENTION_MS;
}

/** Remove message text after 30 days while retaining its hash and incident metadata. */
export function pruneExpiredForumContent(db: DB, now = Date.now()): number {
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT id, author_kind, author_id, content_hash, body
       FROM forum_posts
       WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).all(now) as { id: number; author_kind: string; author_id: number | null; content_hash: string | null; body: string }[];
    const update = db.prepare(
      `UPDATE forum_posts SET body = '', deleted_at = ?, moderation_state = 'expired' WHERE id = ? AND deleted_at IS NULL`,
    );
    for (const row of rows) {
      const hash = row.content_hash ?? forumContentHash(row.body);
      update.run(now, row.id);
      recordModeration(db, {
        postId: row.id,
        userId: row.author_kind === 'human' ? row.author_id ?? undefined : undefined,
        hash,
        verdict: 'expired',
        rules: ['retention_30_days'],
      });
    }
    return rows.length;
  })();
}
