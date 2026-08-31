import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  createSession, destroySession, issueNonce, loginEmail, loginMessage,
  registerEmail, userFromSession, verifyWallet,
} from '../../auth/auth.js';
import { awardDailyLogin, xpProfile } from '../../social/xp.js';

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
    const userId = verifyWallet(app.db, body.address, body.signature);
    const token = createSession(app.db, userId);
    reply.setCookie(COOKIE, token, cookieOpts);
    return { ok: true };
  });

  server.get('/api/me', async (request) => {
    const user = currentUser(app, request);
    if (!user) return { user: null };
    awardDailyLogin(app.db, user.id); // idempotent per UTC day
    return { user: { ...user, ...xpProfile(app.db, user.id) } };
  });
}
