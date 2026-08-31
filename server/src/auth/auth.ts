import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { getAddress, isAddress, verifyMessage } from 'viem';
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
  sessionCreatedAt: number;
  sessionAuthMethod: string;
}

/**
 * ADMIN IS COMPUTED, NEVER STORED.
 *
 * The `users.is_admin` column still exists for display, but nothing reads it
 * for authorization. Clearance is derived on every request from the wallet
 * bound to the session, compared against the one configured operator address.
 *
 * That matters because a stored flag has a dozen ways to become wrong — a
 * migration, a seed script, a bad UPDATE, a restored backup — and every one of
 * them silently grants the Control Room. A derived check has exactly one way
 * to be true: the session's user proved control of that address by signing a
 * single-use nonce.
 */
export function isAdminWallet(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  return walletAddress.toLowerCase() === config.adminWallet;
}

/** lowercase for storage and comparison; checksummed only for display */
function normalizeAddress(address: string): string {
  if (!isAddress(address)) throw new Error('not a valid EVM address');
  return getAddress(address).toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DB, userId: number, authMethod: 'email' | 'wallet' = 'email'): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, auth_method) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS, authMethod);
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
      `SELECT u.id, u.email, u.wallet_address, u.display_name, u.is_admin, s.created_at,
              s.expires_at, s.token_hash, s.auth_method
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now) as
    | { id: number; email: string | null; wallet_address: string | null; display_name: string; is_admin: number; created_at: number; expires_at: number; token_hash: string; auth_method: string }
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
    // derived from the bound wallet, not from row.is_admin
    isAdmin: isAdminWallet(row.wallet_address),
    sessionCreatedAt: row.created_at,
    sessionAuthMethod: row.auth_method,
  };
}

// ── email/password ───────────────────────────────────────────────────────────

export async function registerEmail(db: DB, email: string, password: string, displayName: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('invalid email');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (exists) throw new Error('email already registered');
  // display names are cosmetic (users are id-addressed) but keep new ones unique
  const requestedName = displayName.slice(0, 40) || normalized.split('@')[0];
  const nameTaken = db.prepare('SELECT id FROM users WHERE display_name = ?').get(requestedName);
  if (nameTaken) throw new Error('display name already taken');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  // An email address grants nothing. Clearance comes from connecting the
  // operator wallet and signing for it.
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (email, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(normalized, hash, requestedName, Date.now());
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

// ── wallet (EVM personal_sign) ───────────────────────────────────────────────
//
// Robinhood Chain is EVM, so wallet identity is an EVM address proved with an
// EIP-191 personal_sign over a server-issued single-use nonce. The nonce is
// deleted the moment it is consumed, so a captured signature cannot be
// replayed, and it carries the address it was issued for so a signature for
// one wallet cannot be presented as another's.

export function issueNonce(db: DB, walletAddress: string): string {
  const address = normalizeAddress(walletAddress);
  const nonce = randomBytes(16).toString('hex');
  db.prepare('INSERT OR REPLACE INTO wallet_nonces (wallet_address, nonce, expires_at) VALUES (?, ?, ?)')
    .run(address, nonce, Date.now() + NONCE_TTL_MS);
  return nonce;
}

export function loginMessage(nonce: string): string {
  return [
    'PunkLabz Terminal',
    '',
    'Sign this message to prove you control this wallet.',
    'This is a signature, not a transaction: it costs nothing and moves nothing.',
    '',
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Consume the nonce and verify the signature came from `walletAddress`.
 * Returns the proven address. Every path that binds a wallet goes through it.
 */
async function proveWallet(db: DB, walletAddress: string, signature: string): Promise<string> {
  const address = normalizeAddress(walletAddress);
  const row = db
    .prepare('SELECT nonce, expires_at FROM wallet_nonces WHERE wallet_address = ?')
    .get(address) as { nonce: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) throw new Error('nonce expired, request a new one');
  // single-use, deleted before verification so a failed attempt burns it too
  db.prepare('DELETE FROM wallet_nonces WHERE wallet_address = ?').run(address);

  const ok = await verifyMessage({
    address: getAddress(address),
    message: loginMessage(row.nonce),
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!ok) throw new Error('signature verification failed');
  return address;
}

/** Sign in with a wallet, creating the account on first sight. */
export async function verifyWallet(db: DB, walletAddress: string, signature: string): Promise<number> {
  const address = await proveWallet(db, walletAddress, signature);

  const existing = db.prepare('SELECT id FROM users WHERE wallet_address = ?').get(address) as
    | { id: number }
    | undefined;
  if (existing) {
    syncAdminMirror(db, existing.id, address);
    return existing.id;
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO users (wallet_address, display_name, is_admin, created_at) VALUES (?, ?, ?, ?)')
      .run(address, `${address.slice(0, 6)}…${address.slice(-4)}`, isAdminWallet(address) ? 1 : 0, Date.now());
    const userId = Number(info.lastInsertRowid);
    seedUser(db, userId);
    return userId;
  });
  return tx();
}

/**
 * Bind a wallet to an account that already signed in some other way. This is
 * how an email operator reaches the Control Room: prove the wallet, and
 * clearance follows from the address itself.
 */
export async function linkWallet(db: DB, userId: number, walletAddress: string, signature: string): Promise<string> {
  const address = await proveWallet(db, walletAddress, signature);

  const owner = db.prepare('SELECT id FROM users WHERE wallet_address = ?').get(address) as
    | { id: number }
    | undefined;
  if (owner && owner.id !== userId) {
    throw new Error('that wallet is already connected to another operator account');
  }
  const current = db.prepare('SELECT wallet_address FROM users WHERE id = ?').get(userId) as
    | { wallet_address: string | null }
    | undefined;
  if (current?.wallet_address && current.wallet_address !== address) {
    throw new Error('this account already has a wallet connected — disconnect it first');
  }

  db.prepare('UPDATE users SET wallet_address = ? WHERE id = ?').run(address, userId);
  syncAdminMirror(db, userId, address);
  return address;
}

/** Unbind. Losing the operator wallet loses Control Room access, by design. */
export function unlinkWallet(db: DB, userId: number): void {
  const row = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(userId) as
    | { email: string | null; password_hash: string | null }
    | undefined;
  if (!row?.email || !row.password_hash) {
    throw new Error('add an email and password first — otherwise this would lock you out of the account');
  }
  db.prepare('UPDATE users SET wallet_address = NULL, is_admin = 0 WHERE id = ?').run(userId);
}

/** Add email/password to a wallet-first account, so it has a second way in. */
export async function linkEmail(db: DB, userId: number, email: string, password: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('invalid email');
  if (password.length < 8) throw new Error('password must be at least 8 characters');

  const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized) as { id: number } | undefined;
  if (taken && taken.id !== userId) throw new Error('email already registered to another account');

  const current = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as
    | { email: string | null }
    | undefined;
  if (current?.email && current.email !== normalized) {
    throw new Error('this account already has an email');
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  db.prepare('UPDATE users SET email = ?, password_hash = ? WHERE id = ?').run(normalized, hash, userId);
  return normalized;
}

/**
 * Keep users.is_admin as a readable mirror of the derived truth. Nothing
 * authorizes off this column — see isAdminWallet — but leaving it stale would
 * make the database lie to anyone reading it.
 */
function syncAdminMirror(db: DB, userId: number, walletAddress: string | null): void {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdminWallet(walletAddress) ? 1 : 0, userId);
}
