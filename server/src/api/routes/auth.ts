import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  createSession, destroySession, isAdminWallet, issueNonce, linkEmail, linkWallet,
  loginEmail, loginMessage, registerEmail, unlinkWallet, userFromSession, verifyWallet,
} from '../../auth/auth.js';
import { awardDailyLogin, xpProfile } from '../../social/xp.js';
import { readPortfolio } from '../../chain/balances.js';
import { config } from '../../config.js';

const COOKIE = 'plz_session';

export function currentUser(app: AppContext, request: any) {
  return userFromSession(app.db, request.cookies?.[COOKIE]);
}

export function requireUser(app: AppContext, request: any, reply: any) {
  const user = currentUser(app, request);
  if (!user) {
    reply.code(401).send({ error: 'not logged in' });
    return null;
  }
  return user;
}

export function registerAuthRoutes(server: FastifyInstance, app: AppContext) {
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 3600,
  };

  server.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = z.object({
      email: z.string(),
      password: z.string(),
      displayName: z.string().max(40).optional(),
    }).parse(request.body);
    const userId = await registerEmail(app.db, body.email, body.password, body.displayName ?? '');
    const token = createSession(app.db, userId);
    reply.setCookie(COOKIE, token, cookieOpts);
    return { ok: true };
  });

  server.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(request.body);
    const userId = await loginEmail(app.db, body.email, body.password);
    const token = createSession(app.db, userId);
    reply.setCookie(COOKIE, token, cookieOpts);
    return { ok: true };
  });

  server.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies?.[COOKIE];
    if (token) destroySession(app.db, token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  server.get('/api/auth/wallet/nonce', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const { address } = z.object({ address: z.string() }).parse(request.query);
    const nonce = issueNonce(app.db, address);
    return { nonce, message: loginMessage(nonce) };
  });

  server.post('/api/auth/wallet/verify', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = z.object({ address: z.string(), signature: z.string() }).parse(request.body);
    try {
      const userId = await verifyWallet(app.db, body.address, body.signature);
      const token = createSession(app.db, userId, 'wallet');
      reply.setCookie(COOKIE, token, cookieOpts);
      return { ok: true };
    } catch (e) {
      return reply.code(401).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /**
   * Connect a wallet to the account you are already signed into. This is how
   * an email operator reaches the Control Room — and the only way, since
   * clearance is derived from the address itself.
   */
  server.post('/api/auth/wallet/link', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({ address: z.string(), signature: z.string() }).parse(request.body);
    try {
      const linked = await linkWallet(app.db, user.id, body.address, body.signature);
      const previousToken = request.cookies?.[COOKIE];
      if (previousToken) destroySession(app.db, previousToken);
      const token = createSession(app.db, linked.userId, 'wallet');
      reply.setCookie(COOKIE, token, cookieOpts);
      return {
        ok: true,
        walletAddress: linked.address,
        isAdmin: isAdminWallet(linked.address),
        merged: linked.merged,
      };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  server.post('/api/auth/wallet/unlink', async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    try {
      unlinkWallet(app.db, user.id);
      return { ok: true };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  /** The other direction: a wallet-first account adds email + password. */
  server.post('/api/auth/email/link', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    const body = z.object({ email: z.string(), password: z.string() }).parse(request.body);
    try {
      const linked = await linkEmail(app.db, user.id, body.email, body.password);
      return { ok: true, email: linked.email, merged: linked.merged };
    } catch (e) {
      return reply.code(409).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  server.get('/api/me', async (request) => {
    const user = currentUser(app, request);
    if (!user) return { user: null };
    awardDailyLogin(app.db, user.id); // idempotent per UTC day
    return {
      user: {
        ...user,
        ...xpProfile(app.db, user.id),
        hasEmail: !!user.email,
        hasWallet: !!user.walletAddress,
      },
      // shown so an operator can see WHICH wallet grants clearance without
      // guessing why the Control Room is missing
      operatorWallet: user.isAdmin ? config.adminWallet : undefined,
    };
  });

  /**
   * Live wallet contents, read from Robinhood Chain. Balances are facts from
   * the chain; USD values are estimates and are labelled with their source.
   */
  server.get('/api/wallet/portfolio', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = requireUser(app, request, reply);
    if (!user) return;
    if (!user.walletAddress) {
      return reply.code(409).send({ error: 'no wallet connected to this account' });
    }
    const ethUsd = app.executor.getMark('ETHUSDT') ?? null;
    return readPortfolio(app.db, user.walletAddress, { ethUsd });
  });
}
