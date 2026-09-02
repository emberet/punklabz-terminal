// THE X BOUNDARY.
//
// Shaped exactly like buildSigner(): an interface, a null implementation that
// refuses, a recording implementation for tests, and a factory that throws for
// anything it has not been given credentials for. The real API client is the
// last thing written, and it is written behind X_PROVIDER=api.
//
// Everything read through this interface is UNTRUSTED. A tweet is data. It is
// never interpolated into a system prompt, never treated as instruction, and
// always delimited and labelled when shown to a model.

import { ApiXAdapter } from './apiXAdapter.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface XPost {
  externalId: string;
  authorHandle: string;
  body: string;
  metrics: { likes: number; reposts: number; replies: number };
  postedAt: number;
}

export interface XQuota {
  readsRemaining: number | null;
  postsRemaining: number | null;
  resetAt: number | null;
}

export interface XPublishResult {
  publishedId: string;
  quota: XQuota;
}

export interface XMediaUploadResult {
  mediaId: string;
}

export type XReadAvailability = 'ok' | 'credits_depleted' | 'entitlement_missing' | 'rate_limited' | 'unavailable';

export interface XReadResult {
  posts: XPost[];
  quota: XQuota;
  availability: XReadAvailability;
}

export interface XAdapter {
  readonly kind: string;
  isReady(): Promise<{ ready: boolean; detail: string }>;
  /** read the timeline. `max` is a budget, not a target. */
  read(max: number): Promise<XReadResult>;
  /** Upload one validated image for attachment to the next public post. */
  uploadImage(bytes: Uint8Array, mimeType: string): Promise<XMediaUploadResult>;
  /**
   * Publish. The ONLY method that reaches the public account, and the only
   * caller permitted to invoke it is intern.ts, downstream of screen().
   */
  publish(text: string, inReplyTo?: string, mediaIds?: string[]): Promise<XPublishResult>;
}

const EMPTY_QUOTA: XQuota = { readsRemaining: null, postsRemaining: null, resetAt: null };
export const DEFAULT_X_HANDLE = 'PunkLabZRH';

export function configuredXHandle(): string {
  const handle = (process.env.X_HANDLE ?? DEFAULT_X_HANDLE).replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : DEFAULT_X_HANDLE;
}

export function xPostUrl(publishedId: string): string {
  return `https://x.com/${configuredXHandle()}/status/${encodeURIComponent(publishedId)}`;
}

export class NullXAdapter implements XAdapter {
  readonly kind = 'none';

  async isReady() {
    return {
      ready: false,
      detail:
        'no X credentials configured — set X_PROVIDER=api and supply the account tokens. ' +
        'The intern runs in shadow mode until then: it drafts, filters and logs, and publishes nothing.',
    };
  }

  async read(): Promise<XReadResult> {
    return { posts: [], quota: EMPTY_QUOTA, availability: 'unavailable' };
  }

  async uploadImage(): Promise<XMediaUploadResult> {
    throw new Error('NullXAdapter: refusing to upload — no X provider is configured');
  }

  async publish(): Promise<XPublishResult> {
    throw new Error('NullXAdapter: refusing to publish — no X provider is configured');
  }
}

/**
 * Records what would have been published without sending it. This is what the
 * shadow period runs against, and what the tests drive.
 */
export class RecordingXAdapter implements XAdapter {
  readonly kind = 'recording';
  readonly uploaded: { bytes: number; mimeType: string; mediaId: string }[] = [];
  readonly published: { text: string; inReplyTo?: string; mediaIds?: string[]; at: number }[] = [];
  private feed: XPost[];
  private readsRemaining: number;
  private postsRemaining: number;

  constructor(feed: XPost[] = [], readsRemaining = 8000, postsRemaining = 3000) {
    this.feed = feed;
    this.readsRemaining = readsRemaining;
    this.postsRemaining = postsRemaining;
  }

  async isReady() {
    return { ready: true, detail: 'recording adapter — nothing leaves this process' };
  }

  async read(max: number): Promise<XReadResult> {
    const posts = this.feed.slice(0, max);
    this.readsRemaining -= posts.length;
    return {
      posts,
      quota: { readsRemaining: this.readsRemaining, postsRemaining: this.postsRemaining, resetAt: null },
      availability: 'ok',
    };
  }

  async uploadImage(bytes: Uint8Array, mimeType: string): Promise<XMediaUploadResult> {
    const mediaId = `rec_media_${this.uploaded.length + 1}`;
    this.uploaded.push({ bytes: bytes.byteLength, mimeType, mediaId });
    return { mediaId };
  }

  async publish(text: string, inReplyTo?: string, mediaIds?: string[]): Promise<XPublishResult> {
    this.published.push({ text, inReplyTo, mediaIds, at: Date.now() });
    this.postsRemaining -= 1;
    return {
      publishedId: `rec_${this.published.length}`,
      quota: { readsRemaining: this.readsRemaining, postsRemaining: this.postsRemaining, resetAt: null },
    };
  }
}

export function buildXAdapter(): XAdapter {
  const provider = process.env.X_PROVIDER ?? 'none';
  if (provider === 'none') return new NullXAdapter();
  if (provider === 'recording') return new RecordingXAdapter();
  if (provider === 'api') {
    // Constructed even with blank credentials: a missing key must surface as a
    // readiness failure the operator can read, never as a crash on boot that
    // takes the whole server down with it.
    return new ApiXAdapter({
      appKey: credential('X_APP_KEY'),
      appSecret: credential('X_APP_SECRET'),
      accessToken: credential('X_ACCESS_TOKEN'),
      accessSecret: credential('X_ACCESS_SECRET'),
      expectedHandle: configuredXHandle(),
      query: process.env.X_SEARCH_QUERY,
    });
  }
  throw new Error(
    `X_PROVIDER=${provider} is not implemented in this build. Supported: none, recording, api.`,
  );
}

/** Read X secrets from root-owned systemd credentials, with env only for local development. */
function credential(name: string): string {
  const explicit = process.env[`${name}_FILE`];
  const systemd = process.env.CREDENTIALS_DIRECTORY
    ? path.join(process.env.CREDENTIALS_DIRECTORY, name.toLowerCase())
    : null;
  const file = explicit ?? systemd;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return process.env[name] ?? '';
}
