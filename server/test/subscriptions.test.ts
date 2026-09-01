import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { openTestDb, type DB } from '../src/db/db.js';
import { config } from '../src/config.js';
import {
  beginBillingEvent,
  failBillingEvent,
  finishBillingEvent,
  queueRenewalReminders,
  subscriptionAccess,
  upsertSubscription,
} from '../src/billing/subscriptions.js';
import { applyStripeEvent } from '../src/billing/stripeProvider.js';
import { processBillingReminders } from '../src/billing/reminders.js';
import { toMicro } from '../src/money.js';

function mkUser(db: DB, email: string | null = 'operator@example.com'): number {
  const info = db.prepare(
    `INSERT INTO users (email, wallet_address, display_name, created_at) VALUES (?, ?, 'operator', ?)`,
  ).run(email, email ? null : '0x0000000000000000000000000000000000000001', Date.now());
  return Number(info.lastInsertRowid);
}

function stripeSubscriptionEvent(input: {
  userId: number;
  status?: string;
  created?: number;
  eventId?: string;
}): Stripe.Event {
  const start = 1_788_220_800;
  return {
    id: input.eventId ?? 'evt_subscription',
    type: 'customer.subscription.updated',
    created: input.created ?? start,
    data: {
      object: {
        id: 'sub_lab_1',
        customer: 'cus_lab_1',
        status: input.status ?? 'active',
        cancel_at_period_end: false,
        metadata: { user_id: String(input.userId), product_code: 'lab_monthly' },
        items: {
          data: [{
            current_period_start: start,
            current_period_end: start + 30 * 86_400,
            price: {
              id: 'price_lab_test',
              active: true,
              currency: 'usd',
              unit_amount: 2_000,
              type: 'recurring',
              recurring: { interval: 'month', interval_count: 1 },
            },
          }],
        },
      },
    },
  } as unknown as Stripe.Event;
}

function stripeInvoiceEvent(): Stripe.Event {
  return {
    id: 'evt_invoice_paid',
    type: 'invoice.paid',
    created: 1_788_220_900,
    data: {
      object: {
        id: 'in_lab_1',
        currency: 'usd',
        amount_paid: 2_000,
        amount_due: 2_000,
        parent: { subscription_details: { subscription: 'sub_lab_1' } },
        lines: { data: [{ pricing: { price_details: { price: 'price_lab_test' } } }] },
      },
    },
  } as unknown as Stripe.Event;
}

function stripeRefundEvent(): Stripe.Event {
  return {
    id: 'evt_charge_refunded',
    type: 'charge.refunded',
    created: 1_788_221_000,
    data: {
      object: {
        id: 'ch_lab_1',
        invoice: 'in_lab_1',
        amount: 2_000,
        amount_refunded: 2_000,
        currency: 'usd',
        refunded: true,
      },
    },
  } as unknown as Stripe.Event;
}

describe('Lab subscriptions', () => {
  let db: DB;
  const originalConfig = {
    price: config.stripeLabMonthlyPriceId,
    resend: config.resendApiKey,
    from: config.billingEmailFrom,
    origin: config.appOrigin,
  };

  beforeEach(() => {
    db = openTestDb();
    config.stripeLabMonthlyPriceId = 'price_lab_test';
  });

  afterEach(() => {
    config.stripeLabMonthlyPriceId = originalConfig.price;
    config.resendApiKey = originalConfig.resend;
    config.billingEmailFrom = originalConfig.from;
    config.appOrigin = originalConfig.origin;
    vi.unstubAllGlobals();
    db.close();
  });

  it('keeps rollout access open but fails closed when enforcement has no active membership', () => {
    const userId = mkUser(db);
    expect(subscriptionAccess(db, userId, false).allowed).toBe(true);
    expect(subscriptionAccess(db, userId, true)).toMatchObject({
      allowed: false,
      reason: 'Lab membership required',
    });
  });

  it('allows only a live entitlement period', () => {
    const userId = mkUser(db);
    const now = 1_800_000_000_000;
    upsertSubscription(db, {
      userId,
      provider: 'stripe',
      providerSubscriptionId: 'sub_access',
      providerPriceId: 'price_lab_test',
      status: 'active',
      currentPeriodStart: now - 1_000,
      currentPeriodEnd: now + 1_000,
      cancelAtPeriodEnd: false,
    });
    expect(subscriptionAccess(db, userId, true, now).allowed).toBe(true);
    expect(subscriptionAccess(db, userId, true, now + 1_001).allowed).toBe(false);
    upsertSubscription(db, {
      userId,
      provider: 'stripe',
      providerSubscriptionId: 'sub_access',
      providerPriceId: 'price_lab_test',
      status: 'past_due',
      currentPeriodStart: now - 1_000,
      currentPeriodEnd: now + 10_000,
      cancelAtPeriodEnd: false,
    });
    expect(subscriptionAccess(db, userId, true, now).allowed).toBe(false);
  });

  it('does not let an older Stripe event overwrite newer membership state', async () => {
    const userId = mkUser(db);
    await applyStripeEvent(db, stripeSubscriptionEvent({ userId, status: 'active', created: 200, eventId: 'evt_new' }));
    await applyStripeEvent(db, stripeSubscriptionEvent({ userId, status: 'canceled', created: 100, eventId: 'evt_old' }));
    const row = db.prepare(`SELECT status, provider_event_created_at FROM subscriptions`).get() as {
      status: string;
      provider_event_created_at: number;
    };
    expect(row).toEqual({ status: 'active', provider_event_created_at: 200_000 });
  });

  it('records verified invoice evidence without minting demo credits', async () => {
    const userId = mkUser(db);
    await applyStripeEvent(db, stripeSubscriptionEvent({ userId }));
    const failedInvoice = stripeInvoiceEvent() as any;
    failedInvoice.id = 'evt_invoice_failed';
    failedInvoice.type = 'invoice.payment_failed';
    failedInvoice.created -= 1;
    await applyStripeEvent(db, failedInvoice);
    expect(db.prepare(`SELECT state FROM billing_notifications`).get()).toEqual({ state: 'pending' });
    await applyStripeEvent(db, stripeInvoiceEvent());
    await applyStripeEvent(db, stripeInvoiceEvent());
    const payment = db.prepare(
      `SELECT status, currency, amount_micro FROM billing_payments`,
    ).get() as { status: string; currency: string; amount_micro: number };
    expect(payment).toEqual({ status: 'paid', currency: 'usd', amount_micro: toMicro(20) });
    expect((db.prepare(`SELECT COUNT(*) n FROM billing_payments`).get() as { n: number }).n).toBe(1);
    expect(db.prepare(`SELECT state FROM billing_notifications`).get()).toEqual({ state: 'blocked' });
    expect((db.prepare(`SELECT COUNT(*) n FROM ledger_entries`).get() as { n: number }).n).toBe(0);
    await applyStripeEvent(db, stripeRefundEvent());
    expect(db.prepare(
      `SELECT status, refunded_micro FROM billing_payments`,
    ).get()).toEqual({ status: 'refunded', refunded_micro: toMicro(20) });
    expect((db.prepare(`SELECT COUNT(*) n FROM ledger_entries`).get() as { n: number }).n).toBe(0);
  });

  it('journals webhook retries idempotently and detects event-id payload conflicts', () => {
    const first = beginBillingEvent(db, 'stripe', 'evt_1', 'invoice.paid', Buffer.from('one'));
    expect(first.claimed).toBe(true);
    finishBillingEvent(db, first.eventId);
    expect(beginBillingEvent(db, 'stripe', 'evt_1', 'invoice.paid', Buffer.from('one')).claimed).toBe(false);
    expect(() => beginBillingEvent(db, 'stripe', 'evt_1', 'invoice.paid', Buffer.from('two'))).toThrow(
      'provider event id was reused with a different payload',
    );

    const retry = beginBillingEvent(db, 'stripe', 'evt_2', 'invoice.paid', Buffer.from('retry'));
    failBillingEvent(db, retry.eventId, new Error('temporary'));
    expect(beginBillingEvent(db, 'stripe', 'evt_2', 'invoice.paid', Buffer.from('retry')).claimed).toBe(true);

    const inFlight = beginBillingEvent(db, 'stripe', 'evt_3', 'invoice.paid', Buffer.from('lease'));
    expect(() => beginBillingEvent(db, 'stripe', 'evt_3', 'invoice.paid', Buffer.from('lease'))).toThrow(
      'provider event is already processing',
    );
    db.prepare(`UPDATE billing_events SET received_at=0 WHERE id=?`).run(inFlight.eventId);
    expect(beginBillingEvent(db, 'stripe', 'evt_3', 'invoice.paid', Buffer.from('lease')).claimed).toBe(true);
  });

  it('queues one five-day reminder per period and blocks wallet-only accounts', () => {
    const now = 1_800_000_000_000;
    const emailUser = mkUser(db, 'renew@example.com');
    const walletUser = mkUser(db, null);
    for (const [userId, providerId] of [[emailUser, 'sub_email'], [walletUser, 'sub_wallet']] as const) {
      upsertSubscription(db, {
        userId,
        provider: 'stripe',
        providerSubscriptionId: providerId,
        status: 'active',
        currentPeriodStart: now - 20 * 86_400_000,
        currentPeriodEnd: now + 4 * 86_400_000,
        cancelAtPeriodEnd: false,
      });
    }
    expect(queueRenewalReminders(db, now)).toBe(2);
    expect(queueRenewalReminders(db, now)).toBe(0);
    const states = db.prepare(
      `SELECT state, COUNT(*) n FROM billing_notifications GROUP BY state ORDER BY state`,
    ).all() as { state: string; n: number }[];
    expect(states).toEqual([{ state: 'blocked', n: 1 }, { state: 'pending', n: 1 }]);
    db.prepare(`UPDATE users SET email='wallet@example.com' WHERE id=?`).run(walletUser);
    expect(queueRenewalReminders(db, now)).toBe(1);
    expect(db.prepare(
      `SELECT state, recipient FROM billing_notifications WHERE user_id=?`,
    ).get(walletUser)).toEqual({ state: 'pending', recipient: 'wallet@example.com' });
  });

  it('rechecks cancellation and retries email delivery with one idempotency key', async () => {
    const now = Date.now();
    const userId = mkUser(db, 'renew@example.com');
    const subscriptionId = upsertSubscription(db, {
      userId,
      provider: 'stripe',
      providerSubscriptionId: 'sub_reminder',
      status: 'active',
      currentPeriodStart: now - 20 * 86_400_000,
      currentPeriodEnd: now + 4 * 86_400_000,
      cancelAtPeriodEnd: false,
    });
    queueRenewalReminders(db, now);
    config.resendApiKey = 're_test';
    config.billingEmailFrom = 'PunkLabz <billing@example.com>';
    config.appOrigin = 'https://punklabz.app';

    db.prepare(`UPDATE subscriptions SET cancel_at_period_end=1 WHERE id=?`).run(subscriptionId);
    const noSend = vi.fn();
    vi.stubGlobal('fetch', noSend);
    expect(await processBillingReminders(db)).toMatchObject({ sent: 0, failed: 0 });
    expect(noSend).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT state FROM billing_notifications`).get()).toEqual({ state: 'blocked' });

    db.prepare(`DELETE FROM billing_notifications`).run();
    db.prepare(`UPDATE subscriptions SET cancel_at_period_end=0 WHERE id=?`).run(subscriptionId);
    queueRenewalReminders(db, now);
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ message: 'temporary' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'email_1' }) });
    vi.stubGlobal('fetch', send);
    expect((await processBillingReminders(db)).failed).toBe(1);
    db.prepare(`UPDATE billing_notifications SET updated_at=0`).run();
    expect((await processBillingReminders(db)).sent).toBe(1);
    const firstHeaders = send.mock.calls[0][1].headers as Record<string, string>;
    const secondHeaders = send.mock.calls[1][1].headers as Record<string, string>;
    expect(firstHeaders['Idempotency-Key']).toBe(secondHeaders['Idempotency-Key']);
  });
});
