import { createHash } from 'node:crypto';
import type { DB } from '../db/db.js';

// Hash-chained append-only log. hash = sha256(prev_hash + canonical payload).
// verifyChain() recomputes every link; any tampering breaks the chain.

export function appendAudit(db: DB, actor: string, action: string, payload: unknown): string {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
    | { hash: string }
    | undefined;
  const prevHash = last?.hash ?? 'genesis';
  const payloadJson = JSON.stringify(payload);
  const hash = createHash('sha256').update(prevHash + payloadJson).digest('hex');
  db.prepare(
    'INSERT INTO audit_log (ts, actor, action, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(Date.now(), actor, action, payloadJson, prevHash, hash);
  return hash;
}

export function verifyChain(db: DB): { ok: boolean; brokenAtId: number | null } {
  const rows = db
    .prepare('SELECT id, payload_json, prev_hash, hash FROM audit_log ORDER BY id ASC')
    .all() as { id: number; payload_json: string; prev_hash: string; hash: string }[];
  let prev = 'genesis';
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, brokenAtId: r.id };
    const expect = createHash('sha256').update(prev + r.payload_json).digest('hex');
    if (expect !== r.hash) return { ok: false, brokenAtId: r.id };
    prev = r.hash;
  }
  return { ok: true, brokenAtId: null };
}
