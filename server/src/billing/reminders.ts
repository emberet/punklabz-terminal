import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { queueRenewalReminders } from './subscriptions.js';

interface NotificationRow {
  id: number;
  kind: 'renewal_5d' | 'payment_failed';
  period_end: number;
  recipient: string;
}

function emailCopy(row: NotificationRow): { subject: string; text: string } {
  if (row.kind === 'payment_failed') {
    return {
      subject: 'PunkLabz membership payment needs attention',
      text:
        'The latest payment for your PunkLabz Lab membership did not complete. ' +
        `${config.appOrigin}/billing has the current status and billing controls.`,
    };
  }
  const renewal = new Date(row.period_end).toISOString().slice(0, 10);
  return {
    subject: 'PunkLabz Lab renews in 5 days',
    text:
      `Your $20/month PunkLabz Lab membership is scheduled to renew on ${renewal}. ` +
      `Manage it at ${config.appOrigin}/billing.`,
  };
}

export async function processBillingReminders(db: DB): Promise<{
  queued: number;
  sent: number;
  blocked: number;
  failed: number;
}> {
  const queued = queueRenewalReminders(db);
  if (!config.resendApiKey || !config.billingEmailFrom || !config.appOrigin) {
    const waiting = db.prepare(`SELECT COUNT(*) n FROM billing_notifications WHERE state='pending'`)
      .get() as { n: number };
    return { queued, sent: 0, blocked: waiting.n, failed: 0 };
  }

  const now = Date.now();
  db.prepare(
    `UPDATE billing_notifications
     SET recipient=(SELECT email FROM users WHERE users.id=billing_notifications.user_id),
         state='pending', error=NULL, updated_at=?
     WHERE state='blocked' AND error='account has no email address'
       AND EXISTS (
         SELECT 1 FROM users
         WHERE users.id=billing_notifications.user_id AND users.email IS NOT NULL
       )`,
  ).run(now);
  db.prepare(
    `UPDATE billing_notifications SET state='pending', error='recovered stale send', updated_at=?
     WHERE state='sending' AND updated_at<?`,
  ).run(now, now - 15 * 60_000);
  db.prepare(
    `UPDATE billing_notifications
     SET state='pending', error='retrying delivery', updated_at=?
     WHERE state='failed' AND attempts<5 AND updated_at<=?`,
  ).run(now, now - 60 * 60_000);
  db.prepare(
    `UPDATE billing_notifications
     SET state='blocked', error='subscription state changed before delivery', updated_at=?
     WHERE state='pending' AND kind='renewal_5d' AND NOT EXISTS (
       SELECT 1 FROM subscriptions s
       WHERE s.id=billing_notifications.subscription_id
         AND s.status IN ('active','trialing')
         AND s.cancel_at_period_end=0
         AND s.current_period_end=billing_notifications.period_end
     )`,
  ).run(now);

  const rows = db.prepare(
    `SELECT n.id, n.kind, n.period_end, n.recipient
     FROM billing_notifications n
     WHERE n.state='pending' AND n.recipient IS NOT NULL
       AND (
         n.kind='payment_failed' OR EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.id=n.subscription_id
             AND s.status IN ('active','trialing')
             AND s.cancel_at_period_end=0
             AND s.current_period_end=n.period_end
         )
       )
     ORDER BY id LIMIT 25`,
  ).all() as NotificationRow[];
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const claimed = db.prepare(
      `UPDATE billing_notifications
       SET state='sending', attempts=attempts+1, updated_at=?
       WHERE id=? AND state='pending'`,
    ).run(Date.now(), row.id);
    if (claimed.changes !== 1) continue;
    const copy = emailCopy(row);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `punklabz-billing/${row.id}/${row.period_end}`,
        },
        body: JSON.stringify({
          from: config.billingEmailFrom,
          to: [row.recipient],
          subject: copy.subject,
          text: copy.text,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
      if (!response.ok || !payload.id) throw new Error(payload.message ?? `Resend HTTP ${response.status}`);
      db.prepare(
        `UPDATE billing_notifications
         SET state='sent', provider_ref=?, error=NULL, updated_at=? WHERE id=?`,
      ).run(payload.id, Date.now(), row.id);
      sent++;
    } catch (error) {
      db.prepare(
        `UPDATE billing_notifications SET state='failed', error=?, updated_at=? WHERE id=?`,
      ).run(String(error instanceof Error ? error.message : error).slice(0, 500), Date.now(), row.id);
      failed++;
    }
  }
  return { queued, sent, blocked: 0, failed };
}
