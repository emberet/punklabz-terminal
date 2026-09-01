import { createHash } from 'node:crypto';
import type { DB } from '../db/db.js';

export const LAB_PRODUCT_CODE = 'lab_monthly';
export const LAB_PRICE_USD = 20;
export const RENEWAL_REMINDER_LEAD_MS = 5 * 86_400_000;
const BILLING_EVENT_LEASE_MS = 5 * 60_000;

export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | 'granted';

export interface SubscriptionRecord {
  id: number;
  userId: number;
  provider: string;
  productCode: string;
  providerSubscriptionId: string;
  providerPriceId: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  providerEventCreatedAt: number;
  updatedAt: number;
}

interface SubscriptionRow {
  id: number;
  user_id: number;
  provider: string;
  product_code: string;
  provider_subscription_id: string;
  provider_price_id: string | null;
  status: SubscriptionStatus;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: number;
  provider_event_created_at: number;
  updated_at: number;
}

function view(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    productCode: row.product_code,
    providerSubscriptionId: row.provider_subscription_id,
    providerPriceId: row.provider_price_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    providerEventCreatedAt: row.provider_event_created_at,
    updatedAt: row.updated_at,
  };
}

export function latestSubscription(db: DB, userId: number): SubscriptionRecord | null {
  const row = db.prepare(
    `SELECT * FROM subscriptions
     WHERE user_id=? AND product_code=?
     ORDER BY CASE WHEN status IN ('active','trialing','granted') THEN 0 ELSE 1 END,
              current_period_end DESC, id DESC
     LIMIT 1`,
  ).get(userId, LAB_PRODUCT_CODE) as SubscriptionRow | undefined;
  return row ? view(row) : null;
}

export function subscriptionAccess(
  db: DB,
  userId: number,
  enforced: boolean,
  now = Date.now(),
): { allowed: boolean; reason: string; subscription: SubscriptionRecord | null } {
  const subscription = latestSubscription(db, userId);
  if (!enforced) return { allowed: true, reason: 'billing rollout is not enforced', subscription };
  if (!subscription) return { allowed: false, reason: 'Lab membership required', subscription: null };
  const statusAllows = ['active', 'trialing', 'granted'].includes(subscription.status);
  if (!statusAllows) return { allowed: false, reason: `membership is ${subscription.status}`, subscription };
  if (subscription.currentPeriodEnd <= now) return { allowed: false, reason: 'membership period has ended', subscription };
  return { allowed: true, reason: 'active Lab membership', subscription };
}

export function bindBillingCustomer(
  db: DB,
  userId: number,
  provider: string,
  providerCustomerId: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO billing_customers
       (user_id, provider, provider_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       provider=excluded.provider,
       provider_customer_id=excluded.provider_customer_id,
       updated_at=excluded.updated_at`,
  ).run(userId, provider, providerCustomerId, now, now);
}

export function billingCustomerId(db: DB, userId: number, provider: string): string | null {
  const row = db.prepare(
    `SELECT provider_customer_id id FROM billing_customers WHERE user_id=? AND provider=?`,
  ).get(userId, provider) as { id: string } | undefined;
  return row?.id ?? null;
}

export function userForBillingCustomer(db: DB, provider: string, providerCustomerId: string): number | null {
  const row = db.prepare(
    `SELECT user_id id FROM billing_customers WHERE provider=? AND provider_customer_id=?`,
  ).get(provider, providerCustomerId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function upsertSubscription(db: DB, input: {
  userId: number;
  provider: string;
  providerSubscriptionId: string;
  providerPriceId?: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  providerEventId?: string | null;
  providerEventCreatedAt?: number;
}): number {
  if (input.currentPeriodStart < 0 || input.currentPeriodEnd <= input.currentPeriodStart) {
    throw new Error('subscription period is invalid');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO subscriptions
       (user_id, provider, product_code, provider_subscription_id, provider_price_id,
        status, current_period_start, current_period_end, cancel_at_period_end,
        last_provider_event_id, provider_event_created_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_subscription_id) DO UPDATE SET
       user_id=excluded.user_id,
       provider_price_id=excluded.provider_price_id,
       status=excluded.status,
       current_period_start=excluded.current_period_start,
       current_period_end=excluded.current_period_end,
       cancel_at_period_end=excluded.cancel_at_period_end,
       last_provider_event_id=excluded.last_provider_event_id,
       provider_event_created_at=excluded.provider_event_created_at,
       updated_at=excluded.updated_at
     WHERE excluded.provider_event_created_at >= subscriptions.provider_event_created_at`,
  ).run(
    input.userId,
    input.provider,
    LAB_PRODUCT_CODE,
    input.providerSubscriptionId,
    input.providerPriceId ?? null,
    input.status,
    input.currentPeriodStart,
    input.currentPeriodEnd,
    input.cancelAtPeriodEnd ? 1 : 0,
    input.providerEventId ?? null,
    input.providerEventCreatedAt ?? 0,
    now,
    now,
  );
  const row = db.prepare(
    `SELECT id FROM subscriptions WHERE provider_subscription_id=?`,
  ).get(input.providerSubscriptionId) as { id: number };
  return row.id;
}

export function beginBillingEvent(
  db: DB,
  provider: string,
  providerEventId: string,
  eventType: string,
  rawBody: Buffer,
): { claimed: boolean; eventId: number } {
  const hash = createHash('sha256').update(rawBody).digest('hex');
  const now = Date.now();
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO billing_events
       (provider, provider_event_id, event_type, payload_sha256, state, received_at)
     VALUES (?, ?, ?, ?, 'processing', ?)`,
  ).run(provider, providerEventId, eventType, hash, now);
  const row = db.prepare(
    `SELECT id, payload_sha256, state, received_at FROM billing_events
     WHERE provider=? AND provider_event_id=?`,
  ).get(provider, providerEventId) as {
    id: number;
    payload_sha256: string;
    state: string;
    received_at: number;
  };
  if (row.payload_sha256 !== hash) throw new Error('provider event id was reused with a different payload');
  if (inserted.changes === 1) return { claimed: true, eventId: row.id };
  if (row.state === 'failed') {
    db.prepare(
      `UPDATE billing_events
       SET state='processing', error=NULL, received_at=?, processed_at=NULL WHERE id=?`,
    ).run(now, row.id);
    return { claimed: true, eventId: row.id };
  }
  if (row.state === 'processing') {
    if (row.received_at <= now - BILLING_EVENT_LEASE_MS) {
      db.prepare(
        `UPDATE billing_events SET error=NULL, received_at=?, processed_at=NULL WHERE id=?`,
      ).run(now, row.id);
      return { claimed: true, eventId: row.id };
    }
    throw new Error('provider event is already processing');
  }
  return { claimed: false, eventId: row.id };
}

export function finishBillingEvent(db: DB, eventId: number): void {
  db.prepare(
    `UPDATE billing_events SET state='processed', error=NULL, processed_at=? WHERE id=?`,
  ).run(Date.now(), eventId);
}

export function failBillingEvent(db: DB, eventId: number, error: unknown): void {
  db.prepare(
    `UPDATE billing_events SET state='failed', error=?, processed_at=? WHERE id=?`,
  ).run(String(error instanceof Error ? error.message : error).slice(0, 500), Date.now(), eventId);
}

export function queueRenewalReminders(db: DB, now = Date.now()): number {
  const rows = db.prepare(
    `SELECT s.id subscription_id, s.user_id, s.current_period_end, u.email
     FROM subscriptions s JOIN users u ON u.id=s.user_id
     WHERE s.product_code=?
       AND s.status IN ('active','trialing')
       AND s.cancel_at_period_end=0
       AND s.current_period_end>? AND s.current_period_end<=?`,
  ).all(LAB_PRODUCT_CODE, now, now + RENEWAL_REMINDER_LEAD_MS) as {
    subscription_id: number;
    user_id: number;
    current_period_end: number;
    email: string | null;
  }[];
  const insert = db.prepare(
    `INSERT INTO billing_notifications
       (user_id, subscription_id, kind, period_end, recipient, state, error, created_at, updated_at)
     VALUES (?, ?, 'renewal_5d', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id, kind, period_end) DO UPDATE SET
       recipient=excluded.recipient,
       state='pending',
       error=NULL,
       updated_at=excluded.updated_at
     WHERE billing_notifications.state='blocked' AND excluded.recipient IS NOT NULL`,
  );
  let queued = 0;
  db.transaction(() => {
    for (const row of rows) {
      const state = row.email ? 'pending' : 'blocked';
      const error = row.email ? null : 'account has no email address';
      const result = insert.run(
        row.user_id,
        row.subscription_id,
        row.current_period_end,
        row.email,
        state,
        error,
        now,
        now,
      );
      queued += result.changes;
    }
  })();
  return queued;
}
