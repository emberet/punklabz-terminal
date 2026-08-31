import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { DB } from '../db/db.js';
import { config } from '../config.js';
import { seedUser } from '../billing/ledger.js';

const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const NONCE_TTL_MS = 5 * 60_000;

export interface AuthUser {
  id: number;
  email: string | null;
  walletAddress: string | null;
  displayName: string;
  isAdmin: boolean;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DB, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS);
  return token;
}

export function destroySession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function userFromSession(db: DB, token: string | undefined): AuthUser | null {
  if (!token) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.wallet_address, u.display_name, u.is_admin, s.expires_at, s.token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now) as
    | { id: number; email: string | null; wallet_address: string | null; display_name: string; is_admin: number; expires_at: number; token_hash: string }
    | undefined;
  if (!row) return null;
  // sliding expiry: extend when past halfway
  if (row.expires_at - now < SESSION_TTL_MS / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + SESSION_TTL_MS, row.token_hash);
  }
  return {
    id: row.id,
    email: row.email,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
  };
}

// ── email/password ───────────────────────────────────────────────────────────

export async function registerEmail(db: DB, email: string, password: string, displayName: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('invalid email');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (exists) throw new Error('email already registered');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const isAdmin = config.adminEmails.includes(normalized) ? 1 : 0;
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(normalized, hash, displayName.slice(0, 40) || normalized.split('@')[0], isAdmin, Date.now());
    const userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    return userId;
  });
  return tx();
}

export async function loginEmail(db: DB, email: string, password: string): Promise<number> {
  const row = db
    .prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()) as { id: number; password_hash: string | null } | undefined;
  if (!row?.password_hash) throw new Error('invalid credentials');
  const ok = await argon2.verify(row.password_hash, password);
  if (!ok) throw new Error('invalid credentials');
  return row.id;
}

// ── wallet (Solana signMessage) ──────────────────────────────────────────────

export function issueNonce(db: DB, walletAddress: string): string {
  try {
    const decoded = bs58.decode(walletAddress);
    if (decoded.length !== 32) throw new Error();
  } catch {
    throw new Error('invalid solana address');
  }
  const nonce = randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO wallet_nonces (wallet_address, nonce, expires_at) VALUES (?, ?, ?)')
    .run(walletAddress, nonce, Date.now() + NONCE_TTL_MS);
  return nonce;
}

export function loginMessage(nonce: string): string {
  return `PunkLabz Terminal :: login :: ${nonce}`;
}

export function verifyWallet(db: DB, walletAddress: string, signatureB58: string): number {
  const row = db
    .prepare('SELECT nonce, expires_at FROM wallet_nonces WHERE wallet_address = ?')
    .get(walletAddress) as { nonce: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) throw new Error('nonce expired, request a new one');
  db.prepare('DELETE FROM wallet_nonces WHERE wallet_address = ?').run(walletAddress); // single-use

  const message = new TextEncoder().encode(loginMessage(row.nonce));
  const ok = nacl.sign.detached.verify(message, bs58.decode(signatureB58), bs58.decode(walletAddress));
  if (!ok) throw new Error('signature verification failed');

  const existing = db.prepare('SELECT id FROM users WHERE wallet_address = ?').get(walletAddress) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (wallet_address, display_name, created_at) VALUES (?, ?, ?)')
      .run(walletAddress, walletAddress.slice(0, 4) + '…' + walletAddress.slice(-4), Date.now());
    const userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    return userId;
  });
  return tx();
}
