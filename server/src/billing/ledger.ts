import { FEES } from '@punklabz/shared';
import type { DB } from '../db/db.js';
import { toMicro } from '../money.js';
import { appendAudit } from '../audit/auditLog.js';

// Double-entry mock ledger. Accounts: `user:<id>` and `platform`.
// Every entry debits one account and credits another; balances are derived.
// No real money moves anywhere in this module.

export type LedgerType = 'seed' | 'fee_creation' | 'fee_reuse' | 'fee_trade_tax';

export class InsufficientFunds extends Error {
  constructor(account: string, neededMicro: number, haveMicro: number) {
    super(`insufficient funds in ${account}: need ${neededMicro}, have ${haveMicro}`);
  }
}

export function balanceMicro(db: DB, account: string): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_micro) FROM ledger_entries WHERE credit_account = ?), 0) -
         COALESCE((SELECT SUM(amount_micro) FROM ledger_entries WHERE debit_account = ?), 0) AS bal`,
    )
    .get(account, account) as { bal: number };
  return row.bal;
}

interface EntryOpts {
  refBotId?: number;
  refTradeId?: number;
  memo?: string;
  /** 'external' seeds don't require the debit account to have funds */
  allowOverdraft?: boolean;
}

/** Core write. Call inside a caller-owned transaction when composing with other writes. */
export function postEntry(
  db: DB,
  type: LedgerType,
  amountMicro: number,
  debitAccount: string,
  creditAccount: string,
  opts: EntryOpts = {},
): number {
  if (amountMicro <= 0) throw new Error('ledger amount must be positive');
  if (!opts.allowOverdraft && debitAccount !== 'external') {
    const have = balanceMicro(db, debitAccount);
    if (have < amountMicro) throw new InsufficientFunds(debitAccount, amountMicro, have);
  }
  const info = db
    .prepare(
      `INSERT INTO ledger_entries (ts, type, amount_micro, debit_account, credit_account, ref_bot_id, ref_trade_id, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      Date.now(),
      type,
      amountMicro,
      debitAccount,
      creditAccount,
      opts.refBotId ?? null,
      opts.refTradeId ?? null,
      opts.memo ?? '',
    );
  return Number(info.lastInsertRowid);
}

/** Signup demo credit: external -> user. */
export function seedUser(db: DB, userId: number): void {
  postEntry(db, 'seed', toMicro(FEES.signupSeedUsd), 'external', `user:${userId}`, {
    memo: 'signup demo credit',
    allowOverdraft: true,
  });
}

/** $20 bot creation: user -> platform. Throws InsufficientFunds. */
export function chargeCreation(db: DB, userId: number, botId: number): void {
  postEntry(db, 'fee_creation', toMicro(FEES.creationUsd), `user:${userId}`, 'platform', {
    refBotId: botId,
    memo: `bot #${botId} creation fee`,
  });
  appendAudit(db, `user:${userId}`, 'fee_creation', { userId, botId, usd: FEES.creationUsd });
}

/** $10 clone fee: cloner -> original creator (100%). */
export function chargeReuse(db: DB, clonerUserId: number, creatorUserId: number, botId: number): void {
  postEntry(db, 'fee_reuse', toMicro(FEES.reuseUsd), `user:${clonerUserId}`, `user:${creatorUserId}`, {
    refBotId: botId,
    memo: `clone of bot #${botId}`,
  });
  appendAudit(db, `user:${clonerUserId}`, 'fee_reuse', {
    clonerUserId,
    creatorUserId,
    botId,
    usd: FEES.reuseUsd,
  });
}

/**
 * $1 per quant-bot trade: owner -> platform. Idempotent on ref_trade_id.
 * Returns false (instead of throwing) when the owner can't pay — caller pauses the bot.
 */
export function chargeTradeTax(db: DB, ownerUserId: number, botId: number, tradeId: number): boolean {
  const exists = db
    .prepare('SELECT id FROM ledger_entries WHERE ref_trade_id = ?')
    .get(tradeId);
  if (exists) return true;
  try {
    postEntry(db, 'fee_trade_tax', toMicro(FEES.tradeTaxUsd), `user:${ownerUserId}`, 'platform', {
      refBotId: botId,
      refTradeId: tradeId,
      memo: `trade tax bot #${botId}`,
    });
    return true;
  } catch (e) {
    if (e instanceof InsufficientFunds) return false;
    throw e;
  }
}

export function ledgerFor(db: DB, account: string, limit = 100) {
  return db
    .prepare(
      `SELECT id, ts, type, amount_micro, debit_account, credit_account, memo
       FROM ledger_entries
       WHERE debit_account = ? OR credit_account = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(account, account, limit);
}

/** Invariant: sum(credits) - sum(debits) across all internal accounts equals seeds from external. */
export function ledgerZeroSum(db: DB): boolean {
  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN debit_account = 'external' THEN amount_micro ELSE 0 END), 0) AS ext_in,
        COALESCE(SUM(CASE WHEN credit_account = 'external' THEN amount_micro ELSE 0 END), 0) AS ext_out
       FROM ledger_entries`,
    )
    .get() as { ext_in: number; ext_out: number };
  const accounts = db
    .prepare(
      `SELECT DISTINCT acct FROM (
         SELECT debit_account AS acct FROM ledger_entries
         UNION SELECT credit_account FROM ledger_entries
       ) WHERE acct != 'external'`,
    )
    .all() as { acct: string }[];
  const total = accounts.reduce((s, a) => s + balanceMicro(db, a.acct), 0);
  return total === row.ext_in - row.ext_out;
}
