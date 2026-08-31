import { describe, expect, it } from 'vitest';
import { openTestDb } from '../src/db/db.js';
import { runEpoch, approveEpoch } from '../src/manager/managerAgent.js';
import { MockHolderSource } from '../src/manager/holderSource.js';
import { PayoutQueue } from '../src/manager/payoutQueue.js';
import { StubSigner } from '../src/manager/signer.js';
import { verifyChain } from '../src/audit/auditLog.js';
import { toMicro } from '../src/money.js';

function seedWorld(db: ReturnType<typeof openTestDb>) {
  const bot = db
    .prepare(`INSERT INTO bots (name, kind, strategy_type, config_json, created_at) VALUES ('H', 'house', 'momentum', '{}', 1)`)
    .run();
  const botId = Number(bot.lastInsertRowid);
  db.prepare(`INSERT INTO bot_accounts (bot_id, cash_micro, initial_balance_micro, updated_at) VALUES (?, ?, ?, 1)`)
    .run(botId, toMicro(10_000), toMicro(10_000));
  return botId;
}

function bookProfit(db: ReturnType<typeof openTestDb>, botId: number, usd: number) {
  db.prepare(
    `INSERT INTO trades (bot_id, symbol, side, qty, price, realized_pnl_micro, ts) VALUES (?, 'BTCUSDT', 'sell', 1, 100, ?, ?)`,
  ).run(botId, toMicro(usd), Date.now() - 1000);
}

describe('manager epoch (no api key -> canned narration path)', () => {
  it('computes exact pro-rata payouts, distributes via stub signer, chain verifies', async () => {
    const db = openTestDb();
    const botId = seedWorld(db);
    bookProfit(db, botId, 100);

    const queue = new PayoutQueue(db, new StubSigner());
    const result = await runEpoch(db, new MockHolderSource(), queue);
    // no ANTHROPIC_API_KEY in tests -> narration fails -> needs_review
    expect(result.status).toBe('needs_review');
    expect(result.profitUsd).toBe(100);
    expect(result.eligibleCount).toBe(10); // mock source has 10 holders >= 1M

    // hand-check the largest holder's share:
    // whale 48M of 109.85M eligible supply -> floor(100e6 * 48e6/109.85e6)
    const expected = Number((BigInt(toMicro(100)) * 48_000_000n) / 109_850_000n);
    const whale = db
      .prepare(`SELECT amount_micro FROM payout_items WHERE address LIKE 'PunkWhale111%'`)
      .get() as { amount_micro: number };
    expect(whale.amount_micro).toBe(expected);

    // sum(items) <= profit, dust = difference
    const sum = db.prepare(`SELECT SUM(amount_micro) AS s FROM payout_items`).get() as { s: number };
    expect(sum.s).toBeLessThanOrEqual(toMicro(100));
    expect(toMicro(100) - sum.s).toBeLessThan(20); // dust is micro-crumbs

    // approve re-verifies then distributes
    await approveEpoch(db, result.epochId, 1, queue);
    const items = db.prepare(`SELECT status, tx_sig FROM payout_items`).all() as any[];
    expect(items.every((i) => i.status === 'sent' && i.tx_sig?.startsWith('stub:'))).toBe(true);
    const epoch = db.prepare(`SELECT status FROM payout_epochs WHERE id = ?`).get(result.epochId) as any;
    expect(epoch.status).toBe('done');
    expect(verifyChain(db).ok).toBe(true);
  }, 30_000);

  it('approve refuses when stored items were tampered with', async () => {
    const db = openTestDb();
    const botId = seedWorld(db);
    bookProfit(db, botId, 50);
    const queue = new PayoutQueue(db, new StubSigner());
    const result = await runEpoch(db, new MockHolderSource(), queue);

    db.prepare(`UPDATE payout_items SET amount_micro = amount_micro + 1 WHERE id = (SELECT MIN(id) FROM payout_items)`).run();
    await expect(approveEpoch(db, result.epochId, 1, queue)).rejects.toThrow(/blocked/);
  });

  it('losses floor to zero profit and pay nobody', async () => {
    const db = openTestDb();
    const botId = seedWorld(db);
    bookProfit(db, botId, -500);
    const queue = new PayoutQueue(db, new StubSigner());
    const result = await runEpoch(db, new MockHolderSource(), queue);
    expect(result.profitUsd).toBe(0);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM payout_items`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});
