import { getAddress } from 'viem';
import type { DB } from '../db/db.js';
import { config } from '../config.js';

const SCREEN_TTL_MS = 24 * 3_600_000;

export interface WalletScreening {
  result: 'clear' | 'review' | 'blocked' | 'unavailable';
  provider: 'chainalysis';
  providerRef: string | null;
  detail: string;
  checkedAt: number;
  expiresAt: number;
}

function recent(db: DB, address: string, now: number): WalletScreening | null {
  const row = db.prepare(
    `SELECT * FROM wallet_screening_results
     WHERE wallet_address=? AND provider='chainalysis' AND expires_at>?
     ORDER BY checked_at DESC LIMIT 1`,
  ).get(address, now) as any;
  return row ? {
    result: row.result, provider: 'chainalysis', providerRef: row.provider_ref,
    detail: JSON.parse(row.detail_json).detail, checkedAt: row.checked_at, expiresAt: row.expires_at,
  } : null;
}

function persist(db: DB, userId: number, address: string, screening: WalletScreening): WalletScreening {
  db.prepare(
    `INSERT INTO wallet_screening_results
       (user_id,wallet_address,provider,result,provider_ref,detail_json,checked_at,expires_at)
     VALUES (?,?,'chainalysis',?,?,?,?,?)`,
  ).run(userId, address, screening.result, screening.providerRef,
    JSON.stringify({ detail: screening.detail }), screening.checkedAt, screening.expiresAt);
  return screening;
}

/** Chainalysis sanctions-screen read. Any unknown response is unavailable, never clear. */
export async function screenWallet(db: DB, userId: number, rawAddress: string): Promise<WalletScreening> {
  const address = getAddress(rawAddress).toLowerCase();
  const now = Date.now();
  const cached = recent(db, address, now);
  if (cached) return cached;
  const unavailable = (detail: string) => persist(db, userId, address, {
    result: 'unavailable', provider: 'chainalysis', providerRef: null,
    detail, checkedAt: now, expiresAt: now + 5 * 60_000,
  });
  if (!config.chainalysisApiUrl || !config.chainalysisApiKey) {
    return unavailable('Chainalysis address screening is not configured');
  }
  const base = config.chainalysisApiUrl.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/address/${address}`, {
      headers: { 'X-API-Key': config.chainalysisApiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return unavailable('Chainalysis address screening request failed');
  }
  if (!response.ok) return unavailable(`Chainalysis address screening returned HTTP ${response.status}`);
  let body: any;
  try { body = await response.json(); } catch { return unavailable('Chainalysis response was not JSON'); }
  if (!Array.isArray(body?.identifications)) return unavailable('Chainalysis response omitted identifications');
  const identifications = body.identifications as any[];
  const blocked = identifications.length > 0;
  const providerRef = identifications.map((item) => String(item?.category ?? item?.name ?? 'match')).slice(0, 5).join(', ') || null;
  return persist(db, userId, address, {
    result: blocked ? 'blocked' : 'clear', provider: 'chainalysis', providerRef,
    detail: blocked ? `${identifications.length} sanctions identification(s) require review` : 'no sanctions identifications returned',
    checkedAt: now, expiresAt: now + SCREEN_TTL_MS,
  });
}
