import Stripe from 'stripe';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import {
  LAB_PRODUCT_CODE, bindBillingCustomer, billingCustomerId, upsertSubscription,
  userForBillingCustomer, type SubscriptionStatus,
} from './subscriptions.js';
import { toMicro } from '../money.js';

const STRIPE = 'stripe';
const ALLOWED_STATUSES = new Set<SubscriptionStatus>([
  'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
  'canceled', 'unpaid', 'paused',
]);

export function stripeClient(): Stripe | null {
  return config.billingProvider === 'stripe' && config.stripeSecretKey
    ? new Stripe(config.stripeSecretKey)
    : null;
}

export async function createLabCheckout(db: DB, user: { id: number; email: string | null }): Promise<string> {
  const stripe = stripeClient();
  if (!stripe || !config.stripeWebhookSecret || !config.stripeLabMonthlyPriceId || !config.appOrigin) {
    throw new Error('subscription checkout is not configured');
  }
  const price = await stripe.prices.retrieve(config.stripeLabMonthlyPriceId);
  if (
    !price.active || price.currency !== 'usd' || price.unit_amount !== 2_000 ||
    price.type !== 'recurring' || price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error('configured Lab price must be an active recurring USD 20 monthly price');
  }
  const customer = billingCustomerId(db, user.id, STRIPE);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.stripeLabMonthlyPriceId, quantity: 1 }],
    success_url: `${config.appOrigin}/billing?checkout=success`,
    cancel_url: `${config.appOrigin}/billing?checkout=cancelled`,
    client_reference_id: String(user.id),
    customer: customer ?? undefined,
    customer_email: customer ? undefined : user.email ?? undefined,
    metadata: { user_id: String(user.id), product_code: LAB_PRODUCT_CODE },
    subscription_data: { metadata: { user_id: String(user.id), product_code: LAB_PRODUCT_CODE } },
  });
  if (!session.url) throw new Error('Stripe did not return a Checkout URL');
  return session.url;
}

export async function createBillingPortal(db: DB, userId: number): Promise<string> {
  const stripe = stripeClient();
  if (!stripe || !config.appOrigin) throw new Error('billing portal is not configured');
  const customer = billingCustomerId(db, userId, STRIPE);
  if (!customer) throw new Error('no Stripe customer is linked to this account');
  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: `${config.appOrigin}/billing`,
  });
  return session.url;
}

export function constructStripeEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const stripe = stripeClient();
  if (!stripe || !config.stripeWebhookSecret) throw new Error('Stripe webhooks are not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

function objectId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function numericUserId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function userForSubscription(db: DB, sub: Stripe.Subscription): number | null {
  const customerId = objectId(sub.customer);
  const metadataId = numericUserId(sub.metadata?.user_id);
  const mappedId = customerId ? userForBillingCustomer(db, STRIPE, customerId) : null;
  if (metadataId && mappedId && metadataId !== mappedId) {
    throw new Error('Stripe subscription metadata conflicts with the bound billing customer');
  }
  return mappedId ?? metadataId;
}

function syncSubscription(db: DB, sub: Stripe.Subscription, eventId: string, eventCreatedAt: number): void {
  const item = sub.items.data.find((candidate) => candidate.price.id === config.stripeLabMonthlyPriceId);
  if (!item) return;
  if (
    item.price.currency !== 'usd' || item.price.unit_amount !== 2_000 ||
    item.price.type !== 'recurring' || item.price.recurring?.interval !== 'month' ||
    item.price.recurring.interval_count !== 1
  ) {
    throw new Error('Stripe subscription price does not match the USD 20 monthly product contract');
  }
  const userId = userForSubscription(db, sub);
  if (!userId) throw new Error('Stripe subscription cannot be tied to a PunkLabz user');
  const customerId = objectId(sub.customer);
  if (!customerId) throw new Error('Stripe subscription has no customer');
  if (!ALLOWED_STATUSES.has(sub.status as SubscriptionStatus)) {
    throw new Error(`unsupported Stripe subscription status: ${sub.status}`);
  }
  bindBillingCustomer(db, userId, STRIPE, customerId);
  upsertSubscription(db, {
    userId,
    provider: STRIPE,
    providerSubscriptionId: sub.id,
    providerPriceId: item.price.id,
    status: sub.status as SubscriptionStatus,
    currentPeriodStart: item.current_period_start * 1000,
    currentPeriodEnd: item.current_period_end * 1000,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    providerEventId: eventId,
    providerEventCreatedAt: eventCreatedAt,
  });
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as any;
  return objectId(raw.parent?.subscription_details?.subscription ?? raw.subscription);
}

function invoiceHasLabPrice(invoice: Stripe.Invoice): boolean {
  const raw = invoice as any;
  return raw.lines?.data?.some((line: any) =>
    line.pricing?.price_details?.price === config.stripeLabMonthlyPriceId ||
    line.price?.id === config.stripeLabMonthlyPriceId,
  ) ?? false;
}

function localSubscription(db: DB, providerSubscriptionId: string): {
  id: number;
  user_id: number;
  current_period_end: number;
  email: string | null;
} {
  const row = db.prepare(
    `SELECT s.id, s.user_id, s.current_period_end, u.email
     FROM subscriptions s JOIN users u ON u.id=s.user_id
     WHERE s.provider='stripe' AND s.provider_subscription_id=?`,
  ).get(providerSubscriptionId) as {
    id: number;
    user_id: number;
    current_period_end: number;
    email: string | null;
  } | undefined;
  if (!row) throw new Error('Stripe invoice arrived before its Lab subscription was recorded');
  return row;
}

function recordInvoice(db: DB, invoice: Stripe.Invoice, event: Stripe.Event, status: 'paid' | 'failed' | 'void'): void {
  if (!invoiceHasLabPrice(invoice)) return;
  const providerSubscriptionId = invoiceSubscriptionId(invoice);
  if (!providerSubscriptionId) throw new Error('Lab invoice has no subscription identity');
  const subscription = localSubscription(db, providerSubscriptionId);
  const cents = status === 'paid' ? invoice.amount_paid : invoice.amount_due;
  const now = Date.now();
  db.prepare(
    `INSERT INTO billing_payments
       (user_id, subscription_id, provider, provider_payment_id, status, currency,
        amount_micro, refunded_micro, provider_event_id, provider_event_created_at,
        occurred_at, created_at, updated_at)
     VALUES (?, ?, 'stripe', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_payment_id) DO UPDATE SET
       status=excluded.status,
       currency=excluded.currency,
       amount_micro=excluded.amount_micro,
       provider_event_id=excluded.provider_event_id,
       provider_event_created_at=excluded.provider_event_created_at,
       occurred_at=excluded.occurred_at,
       updated_at=excluded.updated_at
     WHERE excluded.provider_event_created_at >= billing_payments.provider_event_created_at`,
  ).run(
    subscription.user_id,
    subscription.id,
    invoice.id,
    status,
    invoice.currency.toLowerCase(),
    toMicro(cents / 100),
    event.id,
    event.created * 1000,
    event.created * 1000,
    now,
    now,
  );
}

function recordChargeRefund(
  db: DB,
  charge: Stripe.Charge,
  event: Stripe.Event,
  invoiceId: string,
): void {
  const payment = db.prepare(
    `SELECT id, amount_micro, provider_event_created_at
     FROM billing_payments WHERE provider='stripe' AND provider_payment_id=?`,
  ).get(invoiceId) as {
    id: number;
    amount_micro: number;
    provider_event_created_at: number;
  } | undefined;
  if (!payment) throw new Error('Stripe refund arrived before its invoice was recorded');
  const refundedMicro = toMicro(charge.amount_refunded / 100);
  const eventCreatedAt = event.created * 1000;
  if (eventCreatedAt < payment.provider_event_created_at) return;
  const status = refundedMicro >= payment.amount_micro ? 'refunded' : 'partially_refunded';
  db.prepare(
    `UPDATE billing_payments SET
       status=?, refunded_micro=?, provider_event_id=?, provider_event_created_at=?, updated_at=?
     WHERE id=?`,
  ).run(status, refundedMicro, event.id, eventCreatedAt, Date.now(), payment.id);
}

async function invoiceForRefundedCharge(charge: Stripe.Charge): Promise<string | null> {
  // Older Stripe API versions included invoice directly on Charge. On the
  // current API, Invoice Payments is the authoritative mapping from the
  // charge's PaymentIntent back to an invoice.
  const legacyInvoice = objectId((charge as any).invoice);
  if (legacyInvoice) return legacyInvoice;
  const paymentIntentId = objectId(charge.payment_intent);
  if (!paymentIntentId) return null;
  const stripe = stripeClient();
  if (!stripe) throw new Error('cannot resolve a refunded charge without Stripe');
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    limit: 2,
  });
  if (payments.data.length === 0) return null;
  if (payments.data.length !== 1) throw new Error('refunded payment maps to multiple invoices');
  return objectId(payments.data[0].invoice);
}

function queuePaymentFailure(db: DB, invoice: Stripe.Invoice): void {
  if (!invoiceHasLabPrice(invoice)) return;
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) throw new Error('failed Lab invoice has no subscription identity');
  const subscription = localSubscription(db, subscriptionId);
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO billing_notifications
       (user_id, subscription_id, kind, period_end, recipient, state, error, created_at, updated_at)
     VALUES (?, ?, 'payment_failed', ?, ?, ?, ?, ?, ?)`,
  ).run(
    subscription.user_id,
    subscription.id,
    subscription.current_period_end,
    subscription.email,
    subscription.email ? 'pending' : 'blocked',
    subscription.email ? null : 'account has no email address',
    now,
    now,
  );
}

function clearRecoveredPaymentFailure(db: DB, invoice: Stripe.Invoice): void {
  if (!invoiceHasLabPrice(invoice)) return;
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) throw new Error('paid Lab invoice has no subscription identity');
  const subscription = localSubscription(db, subscriptionId);
  db.prepare(
    `UPDATE billing_notifications
     SET state='blocked', error='payment recovered before notification', updated_at=?
     WHERE subscription_id=? AND kind='payment_failed' AND period_end=?
       AND state IN ('pending','failed')`,
  ).run(Date.now(), subscription.id, subscription.current_period_end);
}

/** Process only provider-verified objects. The caller owns event idempotency. */
export async function applyStripeEvent(db: DB, event: Stripe.Event): Promise<void> {
  const refundInvoiceId = event.type === 'charge.refunded'
    ? await invoiceForRefundedCharge(event.data.object as Stripe.Charge)
    : null;
  db.transaction(() => {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.product_code !== LAB_PRODUCT_CODE) return;
      const userId = numericUserId(session.client_reference_id ?? session.metadata?.user_id);
      const customerId = objectId(session.customer);
      if (!userId || !customerId) throw new Error('completed Checkout session lacks user/customer identity');
      bindBillingCustomer(db, userId, STRIPE, customerId);
      return;
    }
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted' ||
      event.type === 'customer.subscription.paused' ||
      event.type === 'customer.subscription.resumed'
    ) {
      syncSubscription(db, event.data.object as Stripe.Subscription, event.id, event.created * 1000);
      return;
    }
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object as Stripe.Invoice;
      recordInvoice(db, invoice, event, 'paid');
      clearRecoveredPaymentFailure(db, invoice);
      return;
    }
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice;
      recordInvoice(db, invoice, event, 'failed');
      queuePaymentFailure(db, invoice);
      return;
    }
    if (event.type === 'invoice.voided') {
      recordInvoice(db, event.data.object as Stripe.Invoice, event, 'void');
      return;
    }
    if (event.type === 'charge.refunded') {
      if (!refundInvoiceId) return;
      recordChargeRefund(db, event.data.object as Stripe.Charge, event, refundInvoiceId);
    }
  })();
}
