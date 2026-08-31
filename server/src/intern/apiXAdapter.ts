import { createHmac, randomBytes } from 'node:crypto';
import type { XAdapter, XPost, XPublishResult, XQuota } from './xAdapter.js';

// THE REAL X CLIENT.
//
// OAuth 1.0a user context, not OAuth 2.0. The reason is worth writing down:
// OAuth 2.0 user tokens expire and must be refreshed, which means a background
// bot needs somewhere durable to keep a rotating refresh token and a story for
// what happens when the rotation is missed at 4am. OAuth 1.0a access tokens do
// not expire. For a server posting to ONE account it owns, that is strictly
// less machinery and strictly fewer ways to be silently logged out.
//
// It also means the four credentials can come straight from the X developer
// console — "Generate access token and secret" under Keys and Tokens — with no
// browser redirect at all, provided the app lives in the developer account
// that owns the target handle.

const API = 'https://api.x.com';

export interface XApiConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
  /** the handle we expect to be posting as, verified on isReady() */
  expectedHandle?: string;
  /** search terms for the read pass */
  query?: string;
}

/** RFC 3986. encodeURIComponent leaves !*'() alone and OAuth does not. */
function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Sign a request the way OAuth 1.0a requires.
 *
 * The one detail that silently breaks everything: a JSON request body is NOT
 * part of the signature base string. Only the query parameters and the oauth_*
 * parameters are. Including the body produces a 401 with no explanation of
 * which half was wrong.
 */
export function oauthHeader(
  cfg: XApiConfig,
  method: string,
  url: string,
  queryParams: Record<string, string> = {},
  nonce = randomBytes(16).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: cfg.appKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: cfg.accessToken,
    oauth_version: '1.0',
  };

  const all = { ...queryParams, ...oauth };
  const paramString = Object.keys(all)
    .map((k) => [pct(k), pct(all[k])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramString)}`;
  const key = `${pct(cfg.appSecret)}&${pct(cfg.accessSecret)}`;
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64');

  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
    .join(', ')}`;
}

function quotaFrom(headers: Headers): XQuota {
  const num = (h: string) => {
    const v = headers.get(h);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const reset = num('x-rate-limit-reset');
  return {
    readsRemaining: num('x-rate-limit-remaining'),
    postsRemaining: num('x-app-limit-24hour-remaining'),
    resetAt: reset === null ? null : reset * 1000,
  };
}

export class ApiXAdapter implements XAdapter {
  readonly kind = 'api';
  private verified: { handle: string; id: string } | null = null;

  constructor(private cfg: XApiConfig) {}

  private missing(): string[] {
    return (['appKey', 'appSecret', 'accessToken', 'accessSecret'] as const)
      .filter((k) => !this.cfg[k])
      .map((k) => `X_${k.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ json: any; headers: Headers }> {
    const url = `${API}${path}`;
    const query = opts.query ?? {};
    const qs = Object.keys(query).length
      ? `?${Object.entries(query).map(([k, v]) => `${pct(k)}=${pct(v)}`).join('&')}`
      : '';
    const res = await fetch(url + qs, {
      method,
      headers: {
        Authorization: oauthHeader(this.cfg, method, url, query),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* X returns HTML on some gateway errors */
    }
    if (!res.ok) {
      // The credentials must never reach a log line, an audit row, or a WS
      // frame. Only the platform's own message travels.
      const detail = json?.detail ?? json?.title ?? json?.errors?.[0]?.message ?? text.slice(0, 160);
      const err = new Error(`X ${method} ${path} ${res.status}: ${detail}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return { json, headers: res.headers };
  }

  async isReady(): Promise<{ ready: boolean; detail: string }> {
    const missing = this.missing();
    if (missing.length) {
      return { ready: false, detail: `missing X credentials: ${missing.join(', ')}` };
    }
    try {
      const { json } = await this.call('GET', '/2/users/me');
      const handle = json?.data?.username;
      const id = json?.data?.id;
      if (!handle || !id) return { ready: false, detail: 'X accepted the credentials but returned no account' };
      this.verified = { handle, id };

      // A bot posting from the wrong handle is worse than one that cannot post
      // at all, and the tokens alone never say which account they belong to.
      const want = this.cfg.expectedHandle?.replace(/^@/, '').toLowerCase();
      if (want && handle.toLowerCase() !== want) {
        return {
          ready: false,
          detail: `these tokens post as @${handle}, not @${want} — the app was created under the wrong account`,
        };
      }
      return { ready: true, detail: `authenticated as @${handle} (id ${id}) via OAuth 1.0a` };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) {
        return { ready: false, detail: 'X rejected the credentials (401) — check the four keys and that the app has Read and write permission' };
      }
      return { ready: false, detail: String((e as Error).message).slice(0, 200) };
    }
  }

  async read(max: number): Promise<{ posts: XPost[]; quota: XQuota }> {
    const query = this.cfg.query ?? '(crypto OR bitcoin OR ethereum) lang:en -is:retweet -is:reply';
    try {
      const { json, headers } = await this.call('GET', '/2/tweets/search/recent', {
        query: {
          query,
          max_results: String(Math.max(10, Math.min(100, max))),
          'tweet.fields': 'created_at,public_metrics',
          expansions: 'author_id',
          'user.fields': 'username',
        },
      });
      const users = new Map<string, string>(
        (json?.includes?.users ?? []).map((u: any) => [u.id, u.username]),
      );
      const posts: XPost[] = (json?.data ?? []).slice(0, max).map((t: any) => ({
        externalId: String(t.id),
        authorHandle: users.get(t.author_id) ?? 'unknown',
        body: String(t.text ?? ''),
        metrics: {
          likes: t.public_metrics?.like_count ?? 0,
          reposts: t.public_metrics?.retweet_count ?? 0,
          replies: t.public_metrics?.reply_count ?? 0,
        },
        postedAt: t.created_at ? Date.parse(t.created_at) : Date.now(),
      }));
      return { posts, quota: quotaFrom(headers) };
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 403 here means the access tier does not include v2 search, and 429
      // means we have spent the window. NEITHER is a malfunction, and throwing
      // would halt the intern permanently over an entitlement it will never
      // have on this plan. It reads nothing and says so; the draft step then
      // works from PunkLabz's own measured state, which is the only material
      // it is allowed to state numbers from anyway.
      if (status === 403 || status === 429) {
        return { posts: [], quota: { readsRemaining: 0, postsRemaining: null, resetAt: null } };
      }
      throw e;
    }
  }

  async publish(text: string, inReplyTo?: string): Promise<XPublishResult> {
    if (this.missing().length) {
      throw new Error('ApiXAdapter: refusing to publish — credentials incomplete');
    }
    const body: Record<string, unknown> = { text };
    if (inReplyTo) body.reply = { in_reply_to_tweet_id: inReplyTo };

    const { json, headers } = await this.call('POST', '/2/tweets', { body });
    const publishedId = json?.data?.id;
    if (!publishedId) throw new Error('X accepted the post but returned no id');
    return { publishedId: String(publishedId), quota: quotaFrom(headers) };
  }
}
