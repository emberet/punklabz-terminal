import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireUser } from './auth.js';
import { config } from '../../config.js';
import {
  LAB_PRICE_USD, beginBillingEvent, failBillingEvent, finishBillingEvent,
  subscriptionAccess,
} from '../../billing/subscriptions.js';
import {
  applyStripeEvent, constructStripeEvent, createBillingPortal, createLabCheckout,
} from '../../billing/stripeProvider.js';
import { appendAudit } from '../../audit/auditLog.js';
import {
  confirmUsdgPayment, createUsdgPaymentIntent, getUsdgPaymentIntent, linkedWalletAddresses,
} from '../../billing/usdgMembership.js';

function requireBillingUser(app: AppContext, request: any, reply: any) {
  const user = requireUser(app, request, reply);
  if (!user) return null;
  if (request.headers['x-requested-with'] !== 'punklabz') {
    reply.code(403).send({ error: 'CSRF protection header missing' });
    return null;
  }
  const origin = request.headers.origin as string | undefined;
  if (!origin) {
    reply.code(403).send({ error: 'request origin missing' });
    return null;
  }
  try {
    if (!config.appOrigin || new URL(origin).origin !== new URL(config.appOrigin).origin) {
      reply.code(403).send({ error: 'request origin does not match the configured app' });
      return null;
    }
  } catch {
    reply.code(403).send({ error: 'invalid request origin' });
    return null;
  }
  return user;
}

export function registerBillingRoutes(server: FastifyInstance, app: AppContext) {
  server.get('/api/billing/subscription', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const access = subscriptionAccess(app.db, user.id, config.billingEnforced);
    return {
      product: 'PunkLabz Lab',
      productCode: 'lab_monthly',
      priceUsd: LAB_PRICE_USD,
      interval: 'month',
      enforced: config.billingEnforced,
      provider: config.billingProvider,
      checkoutAvailable: config.billingProvider === 'stripe' && !!(
        config.stripeSecretKey && config.stripeWebhookSecret &&
        config.stripeLabMonthlyPriceId && config.appOrigin
      ),
      usdgPaymentAvailable: config.billingProvider === 'usdg' && !!config.billingTreasuryAddress,
      linkedPayerWallets: linkedWalletAddresses(app.db, user.id),
      access: { allowed: access.allowed, reason: access.reason },
      subscription: access.subscription ? {
        status: access.subscription.status,
        currentPeriodStart: access.subscription.currentPeriodStart,
        currentPeriodEnd: access.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: access.subscription.cancelAtPeriodEnd,
      } : null,
      needsEmail: !user.email,
      demoCreditsSeparate: true,
      creatorPaymentsLive: false,
    };
  });

  server.post('/api/billing/usdg/intents', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const user = requireBillingUser(app, request, reply);
    if (!user) return;
    const body = z.object({ payerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'a linked EVM payer wallet is required' });
    try {
      return { intent: createUsdgPaymentIntent(app.db, user.id, body.data.payerAddress) };
    } catch (error) {
      return reply.code(409).send({ error: String(error instanceof Error ? error.message : error) });
    }
  });

  server.get('/api/billing/usdg/intents/:id', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const id = z.string().uuid().safeParse((request.params as any)?.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid payment intent' });
    const intent = getUsdgPaymentIntent(app.db, user.id, id.data);
    if (!intent) return reply.code(404).send({ error: 'payment intent not found' });
    return { intent };
  });

  server.post('/api/billing/usdg/confirm', {
    config: { rateLimit: { max: 12, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const user = requireBillingUser(app, request, reply);
    if (!user) return;
    const body = z.object({
      intentId: z.string().uuid(),
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'valid intentId and transaction hash are required' });
    try {
      return await confirmUsdgPayment(app.db, user.id, body.data.intentId, body.data.txHash);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      return reply.code(/not found/.test(message) ? 404 : 409).send({ error: message });
    }
  });

  server.post('/api/billing/checkout', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const user = requireBillingUser(app, request, reply);
    if (!user) return;
    const access = subscriptionAccess(app.db, user.id, true);
    if (access.allowed) {
      return reply.code(409).send({ error: 'membership is already active; use Manage billing' });
    }
    if (access.subscription) {
      return reply.code(409).send({ error: 'a membership record already exists; use Manage billing' });
    }
    try {
      const url = await createLabCheckout(app.db, user);
      appendAudit(app.db, `user:${user.id}`, 'billing_checkout_created', { product: 'lab_monthly' });
      return { url };
    } catch (error) {
      request.log.error(`billing checkout failed: ${String(error)}`);
      return reply.code(503).send({ error: 'hosted billing checkout is unavailable' });
    }
  });

  server.post('/api/billing/portal', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const user = requireBillingUser(app, request, reply);
    if (!user) return;
    try {
      return { url: await createBillingPortal(app.db, user.id) };
    } catch (error) {
      request.log.error(`billing portal failed: ${String(error)}`);
      return reply.code(503).send({ error: 'hosted billing management is unavailable' });
    }
  });

  server.post('/api/billing/webhooks/stripe', {
    config: { rawBody: true, rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const signature = request.headers['stripe-signature'];
    const rawBody = request.rawBody;
    if (typeof signature !== 'string' || !rawBody) {
      return reply.code(400).send({ error: 'missing Stripe signature or raw body' });
    }
    const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    let event;
    try {
      event = constructStripeEvent(buffer, signature);
    } catch (error) {
      return reply.code(400).send({ error: `invalid Stripe webhook: ${String(error instanceof Error ? error.message : error)}` });
    }
    let journal;
    try {
      journal = beginBillingEvent(app.db, 'stripe', event.id, event.type, buffer);
      if (!journal.claimed) return { received: true, duplicate: true };
      await applyStripeEvent(app.db, event);
      finishBillingEvent(app.db, journal.eventId);
      return { received: true };
    } catch (error) {
      if (journal) failBillingEvent(app.db, journal.eventId, error);
      request.log.error(`Stripe billing event ${event.id} failed: ${String(error)}`);
      return reply.code(500).send({ error: 'billing event could not be applied' });
    }
  });
}
