import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { openTestDb, type DB } from '../src/db/db.js';
import { config } from '../src/config.js';
import {
  createSession, isAdminWallet, issueNonce, linkEmail, linkWallet, loginMessage,
  registerEmail, unlinkWallet, userFromSession, verifyWallet,
} from '../src/auth/auth.js';

// Two throwaway keys. The operator one is only "the admin" because config
// says so — the point of every test here is that nothing else can make it so.
const OPERATOR = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const STRANGER = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');

async function signIn(db: DB, account: typeof OPERATOR): Promise<number> {
  const nonce = issueNonce(db, account.address);
  const signature = await account.signMessage({ message: loginMessage(nonce) });
  return verifyWallet(db, account.address, signature);
}

async function connect(db: DB, userId: number, account: typeof OPERATOR): Promise<string> {
  const nonce = issueNonce(db, account.address);
  const signature = await account.signMessage({ message: loginMessage(nonce) });
  return linkWallet(db, userId, account.address, signature);
}

const meFor = (db: DB, userId: number) => userFromSession(db, createSession(db, userId));

describe('operator clearance', () => {
  let db: DB;
  let previousAdmin: string;

  beforeEach(() => {
    db = openTestDb();
    previousAdmin = config.adminWallet;
    config.adminWallet = OPERATOR.address.toLowerCase();
  });

  it('is granted only to the configured wallet', () => {
    expect(isAdminWallet(OPERATOR.address)).toBe(true);
    expect(isAdminWallet(STRANGER.address)).toBe(false);
    expect(isAdminWallet(null)).toBe(false);
    expect(isAdminWallet('')).toBe(false);
    expect(isAdminWallet('not-an-address')).toBe(false);
  });

  it('ignores checksum casing in both directions', () => {
    expect(isAdminWallet(OPERATOR.address.toLowerCase())).toBe(true);
    expect(isAdminWallet(OPERATOR.address.toUpperCase().replace('0X', '0x'))).toBe(true);
    config.adminWallet = OPERATOR.address.toLowerCase();
    expect(isAdminWallet(OPERATOR.address)).toBe(true);
  });

  it('the operator wallet signing in gets the Control Room', async () => {
    const userId = await signIn(db, OPERATOR);
    expect(meFor(db, userId)!.isAdmin).toBe(true);
  });

  it('any other wallet does not, however it signs in', async () => {
    const userId = await signIn(db, STRANGER);
    expect(meFor(db, userId)!.isAdmin).toBe(false);
  });

  it('an email account gets nothing until it connects the wallet', async () => {
    const userId = await registerEmail(db, 'op@punklabz.app', 'correct-horse', 'op');
    expect(meFor(db, userId)!.isAdmin).toBe(false);

    await connect(db, userId, OPERATOR);
    expect(meFor(db, userId)!.isAdmin).toBe(true);
  });

  it('THE COLUMN GRANTS NOTHING — clearance is derived, not stored', async () => {
    const userId = await registerEmail(db, 'sneaky@punklabz.app', 'correct-horse', 'sneaky');
    // exactly what a bad migration, a seed script or a restored backup would do
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
    expect(meFor(db, userId)!.isAdmin).toBe(false);
  });

  it('and neither does pointing a row at the operator address without proving it', async () => {
    const userId = await registerEmail(db, 'forger@punklabz.app', 'correct-horse', 'forger');
    // the row now claims the operator wallet, but no signature was ever checked...
    db.prepare('UPDATE users SET wallet_address = ? WHERE id = ?').run(OPERATOR.address.toLowerCase(), userId);
    // ...so the session does read as admin. This is the honest limit of a
    // derived check: it trusts the binding in the row, and the ONLY code path
    // that writes that binding is linkWallet/verifyWallet, both of which
    // consume a single-use nonce and verify a signature. Direct DB writes are
    // outside the threat model and mean the attacker already owns the host.
    expect(meFor(db, userId)!.isAdmin).toBe(true);
  });

  it('rotating the configured wallet moves clearance immediately', async () => {
    const userId = await signIn(db, OPERATOR);
    expect(meFor(db, userId)!.isAdmin).toBe(true);
    config.adminWallet = STRANGER.address.toLowerCase();
    expect(meFor(db, userId)!.isAdmin).toBe(false);
  });

  // restore the real configured wallet so other suites see production config
  afterEach(() => { config.adminWallet = previousAdmin; });
});

describe('the signature handshake', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('rejects a signature from a different key', async () => {
    const nonce = issueNonce(db, OPERATOR.address);
    const wrong = await STRANGER.signMessage({ message: loginMessage(nonce) });
    await expect(verifyWallet(db, OPERATOR.address, wrong)).rejects.toThrow(/signature verification failed/);
  });

  it('rejects a signature over a different nonce', async () => {
    issueNonce(db, OPERATOR.address);
    const stale = await OPERATOR.signMessage({ message: loginMessage('deadbeef'.repeat(4)) });
    await expect(verifyWallet(db, OPERATOR.address, stale)).rejects.toThrow(/signature verification failed/);
  });

  it('a nonce is single-use — a captured signature cannot be replayed', async () => {
    const nonce = issueNonce(db, OPERATOR.address);
    const signature = await OPERATOR.signMessage({ message: loginMessage(nonce) });
    await verifyWallet(db, OPERATOR.address, signature);
    await expect(verifyWallet(db, OPERATOR.address, signature)).rejects.toThrow(/nonce expired/);
  });

  it('a failed attempt burns the nonce too', async () => {
    const nonce = issueNonce(db, OPERATOR.address);
    const wrong = await STRANGER.signMessage({ message: loginMessage(nonce) });
    await expect(verifyWallet(db, OPERATOR.address, wrong)).rejects.toThrow(/verification failed/);
    const right = await OPERATOR.signMessage({ message: loginMessage(nonce) });
    await expect(verifyWallet(db, OPERATOR.address, right)).rejects.toThrow(/nonce expired/);
  });

  it('an expired nonce is refused', async () => {
    const nonce = issueNonce(db, OPERATOR.address);
    db.prepare('UPDATE wallet_nonces SET expires_at = ?').run(Date.now() - 1000);
    const signature = await OPERATOR.signMessage({ message: loginMessage(nonce) });
    await expect(verifyWallet(db, OPERATOR.address, signature)).rejects.toThrow(/nonce expired/);
  });

  it('refuses a non-EVM address outright', () => {
    expect(() => issueNonce(db, 'PunkWhale111111111111111111111111111111111')).toThrow(/valid EVM address/);
  });

  it('the message says a signature is not a transaction', () => {
    expect(loginMessage('abc')).toMatch(/costs nothing and moves nothing/);
    expect(loginMessage('abc')).toContain('abc');
  });
});

describe('linking accounts both ways', () => {
  let db: DB;
  beforeEach(() => { db = openTestDb(); });

  it('signing in twice with the same wallet reuses the account', async () => {
    const first = await signIn(db, STRANGER);
    const second = await signIn(db, STRANGER);
    expect(second).toBe(first);
  });

  it('a wallet already on another account cannot be taken', async () => {
    await signIn(db, STRANGER);
    const other = await registerEmail(db, 'other@punklabz.app', 'correct-horse', 'other');
    await expect(connect(db, other, STRANGER)).rejects.toThrow(/already connected to another/);
  });

  it('an account with a wallet must disconnect before connecting a different one', async () => {
    const userId = await registerEmail(db, 'a@punklabz.app', 'correct-horse', 'a');
    await connect(db, userId, STRANGER);
    await expect(connect(db, userId, OPERATOR)).rejects.toThrow(/disconnect it first/);
  });

  it('a wallet-only account cannot disconnect itself into a locked-out state', async () => {
    const userId = await signIn(db, STRANGER);
    expect(() => unlinkWallet(db, userId)).toThrow(/lock you out/);

    await linkEmail(db, userId, 'rescue@punklabz.app', 'correct-horse');
    expect(() => unlinkWallet(db, userId)).not.toThrow();
    expect(userFromSession(db, createSession(db, userId))!.walletAddress).toBeNull();
  });

  it('adding an email gives a wallet account a second way in', async () => {
    const userId = await signIn(db, STRANGER);
    expect(meFor(db, userId)!.email).toBeNull();
    await linkEmail(db, userId, 'wallet-user@punklabz.app', 'correct-horse');
    expect(meFor(db, userId)!.email).toBe('wallet-user@punklabz.app');
  });

  it('an email already registered elsewhere cannot be claimed', async () => {
    await registerEmail(db, 'taken@punklabz.app', 'correct-horse', 'taken');
    const walletUser = await signIn(db, STRANGER);
    await expect(linkEmail(db, walletUser, 'taken@punklabz.app', 'correct-horse'))
      .rejects.toThrow(/already registered/);
  });

  it('rejects a weak password on the linked email', async () => {
    const userId = await signIn(db, STRANGER);
    await expect(linkEmail(db, userId, 'x@punklabz.app', 'short')).rejects.toThrow(/at least 8/);
  });

  it('stores wallet addresses lowercased so comparison never depends on casing', async () => {
    const userId = await signIn(db, STRANGER);
    const stored = (db.prepare('SELECT wallet_address FROM users WHERE id = ?').get(userId) as any).wallet_address;
    expect(stored).toBe(STRANGER.address.toLowerCase());
    expect(stored).not.toBe(STRANGER.address); // checksummed form differs
  });
});
