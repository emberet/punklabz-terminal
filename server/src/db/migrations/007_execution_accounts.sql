-- Partition execution state by ACCOUNT + MODE.
--
-- Shadow P&L must never contribute to live NAV. Before this migration
-- restoreLots() and the NAV/drawdown math summed live_ledger with no mode
-- filter — harmless while everything was shadow, wrong the instant it isn't.
-- Every order, ledger row and balance snapshot now belongs to exactly one
-- execution account, and accounts never mix.

CREATE TABLE execution_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('simulation','shadow','canary','live')),
  venue TEXT NOT NULL,
  wallet_address TEXT,              -- public address only; never a key
  currency TEXT NOT NULL DEFAULT 'USDC',
  funded_usd REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

INSERT INTO execution_accounts (name, mode, venue, currency, funded_usd, created_at)
VALUES ('SHADOW_BOOK', 'shadow', 'shadow', 'USDC', 0, strftime('%s','now') * 1000);

-- ── rebuild live_orders: account scoping + the full async lifecycle ──
-- SQLite can't widen a CHECK constraint in place, so rebuild and copy.
CREATE TABLE live_orders_new (
  id INTEGER PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  bot_id INTEGER REFERENCES bots(id),
  instrument_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  order_type TEXT NOT NULL DEFAULT 'market',
  requested_notional_micro INTEGER NOT NULL,
  approved_notional_micro INTEGER,
  mode TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'proposed','risk_approved','risk_rejected','submitting','submitted',
    'pending','open','partial','filled','cancelled','failed','reconciling'
  )),
  confidence INTEGER,
  risk_json TEXT,
  expected_price REAL,
  executed_price REAL,
  min_receive REAL,                 -- slippage protection encoded pre-signature
  slippage_bps REAL,
  fee_micro INTEGER NOT NULL DEFAULT 0,
  gas_micro INTEGER NOT NULL DEFAULT 0,
  filled_qty REAL NOT NULL DEFAULT 0,
  reject_reason TEXT,
  venue_order_id TEXT,              -- deterministic client order id at the venue
  tx_ref TEXT,
  submitted_at INTEGER,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO live_orders_new (
  id, intent_id, execution_account_id, bot_id, instrument_id, venue, side, order_type,
  requested_notional_micro, approved_notional_micro, mode, state, confidence, risk_json,
  expected_price, executed_price, slippage_bps, fee_micro, reject_reason, tx_ref,
  created_at, updated_at
)
SELECT
  id, intent_id, 1, bot_id, instrument_id, venue, side, order_type,
  requested_notional_micro, approved_notional_micro, mode, state, confidence, risk_json,
  expected_price, executed_price, slippage_bps, fee_micro, reject_reason, tx_ref,
  created_at, updated_at
FROM live_orders;

DROP TABLE live_orders;
ALTER TABLE live_orders_new RENAME TO live_orders;
CREATE INDEX idx_live_orders_bot ON live_orders(bot_id, created_at);
CREATE INDEX idx_live_orders_state ON live_orders(state);
CREATE INDEX idx_live_orders_account ON live_orders(execution_account_id, created_at);
-- orders needing an outcome check on boot or by the reconciler
CREATE INDEX idx_live_orders_open ON live_orders(state)
  WHERE state IN ('submitting','submitted','pending','open','partial','reconciling');

ALTER TABLE live_ledger ADD COLUMN execution_account_id INTEGER REFERENCES execution_accounts(id);
UPDATE live_ledger SET execution_account_id = 1 WHERE execution_account_id IS NULL;
CREATE INDEX idx_live_ledger_account ON live_ledger(execution_account_id, ts);

-- what the venue said it holds, recorded every reconciliation pass
CREATE TABLE balance_snapshots (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  ts INTEGER NOT NULL,
  asset TEXT NOT NULL,
  venue_qty REAL NOT NULL,
  ledger_qty REAL NOT NULL,
  drift REAL NOT NULL,
  within_tolerance INTEGER NOT NULL
);
CREATE INDEX idx_balance_snapshots ON balance_snapshots(execution_account_id, ts);

-- every preflight and reconciliation run, pass or fail, kept for audit
CREATE TABLE preflight_runs (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  target_mode TEXT NOT NULL,
  passed INTEGER NOT NULL,
  checks_json TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX idx_preflight_ts ON preflight_runs(ts);
