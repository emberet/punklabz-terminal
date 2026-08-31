import type { ActivityEventView } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import type { WsHub } from '../realtime/wsHub.js';

export interface ActivityInput {
  type: string;
  actorUserId?: number;
  botId?: number;
  payload?: Record<string, unknown>;
}

export function emitActivity(db: DB, hub: WsHub | null, evt: ActivityInput): void {
  const info = db
    .prepare(`INSERT INTO activity_events (type, actor_user_id, bot_id, payload_json, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(evt.type, evt.actorUserId ?? null, evt.botId ?? null, JSON.stringify(evt.payload ?? {}), Date.now());
  if (hub) {
    const row = readEvents(db, { limit: 1, before: Number(info.lastInsertRowid) + 1 })[0];
    if (row) hub.publish('feed', row);
  }
}

export function readEvents(
  db: DB,
  opts: { limit: number; before?: number; userId?: number },
): ActivityEventView[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.type, a.actor_user_id, a.bot_id, a.payload_json, a.ts,
              u.display_name AS actor_name, b.name AS bot_name
       FROM activity_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       LEFT JOIN bots b ON b.id = a.bot_id
       WHERE (? IS NULL OR a.id < ?)
         AND (? IS NULL OR a.actor_user_id = ?)
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(opts.before ?? null, opts.before ?? null, opts.userId ?? null, opts.userId ?? null, opts.limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    botId: r.bot_id,
    botName: r.bot_name,
    payload: JSON.parse(r.payload_json),
    ts: r.ts,
  }));
}
