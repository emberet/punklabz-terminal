-- Robinhood mainnet safety release.
--
-- This migration intentionally disarms any previously configured real mode.
-- The operator must import funding, reconcile, pass preflight, and explicitly
-- arm the $5 canary again after the new accounting model is installed.

-- Do not reshape custody while an actual Robinhood transaction is unresolved.
-- The migration runner wraps this file in a transaction, so aborting here
-- leaves the old schema untouched until an operator reconciles the order.
CREATE TABLE _mainnet_migration_guard (id INTEGER);
CREATE TRIGGER _mainnet_migration_guard_unresolved
BEFORE INSERT ON _mainnet_migration_guard
WHEN EXISTS (
  SELECT 1
  FROM live_orders o
  JOIN execution_accounts a ON a.id = o.execution_account_id
  WHERE a.venue = 'evm:robinhood'
    AND o.state IN ('submitting','submitted','pending','open','partial','reconciling')
)
BEGIN
  SELECT RAISE(ABORT, 'unresolved Robinhood orders must be reconciled before mainnet safety migration');
END;
INSERT INTO _mainnet_migration_guard VALUES (1);
DROP TRIGGER _mainnet_migration_guard_unresolved;
DROP TABLE _mainnet_migration_guard;

ALTER TABLE execution_accounts ADD COLUMN chain_id INTEGER;
ALTER TABLE execution_accounts ADD COLUMN settlement_asset TEXT;
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE live_orders ADD COLUMN capital_stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_orders ADD COLUMN forced_by TEXT;
ALTER TABLE live_orders ADD COLUMN signal_ts INTEGER;
ALTER TABLE live_orders ADD COLUMN confirmed_at INTEGER;
ALTER TABLE live_orders ADD COLUMN reconciliation_run_id INTEGER;
ALTER TABLE live_orders ADD COLUMN clean_fill INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_config ADD COLUMN shadow_armed_at INTEGER;

ALTER TABLE execution_account_funding ADD COLUMN log_index INTEGER;
CREATE UNIQUE INDEX idx_funding_tx_log
  ON execution_account_funding(execution_account_id, tx_ref, log_index)
  WHERE tx_ref IS NOT NULL AND log_index IS NOT NULL;

CREATE TABLE execution_transactions (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES live_orders(id),
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('allowance','swap')),
  idempotency_key TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  data TEXT NOT NULL,
  value_wei TEXT NOT NULL,
  gas_limit TEXT NOT NULL,
  max_fee_per_gas TEXT NOT NULL,
  max_priority_fee_per_gas TEXT NOT NULL,
  expires_at INTEGER,
  signed_tx_hash TEXT,
  signed_payload TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('prepared','signed','broadcast','confirmed','reverted','unknown')),
  broadcast_attempts INTEGER NOT NULL DEFAULT 0,
  block_number INTEGER,
  block_hash TEXT,
  confirmations INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chain_id, wallet_address, nonce)
);
CREATE INDEX idx_execution_transactions_order ON execution_transactions(order_id, purpose);
CREATE INDEX idx_execution_transactions_state ON execution_transactions(state);
CREATE UNIQUE INDEX idx_live_ledger_order_once ON live_ledger(order_id) WHERE order_id IS NOT NULL;

CREATE TABLE execution_asset_ledger (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  order_id INTEGER REFERENCES live_orders(id),
  transaction_id INTEGER REFERENCES execution_transactions(id),
  asset TEXT NOT NULL,
  qty_delta TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('funding','fill','gas','fee','adjustment')),
  tx_ref TEXT,
  log_index INTEGER,
  ts INTEGER NOT NULL,
  UNIQUE(transaction_id, asset, event_type, log_index)
);
CREATE INDEX idx_asset_ledger_account ON execution_asset_ledger(execution_account_id, asset, ts);
CREATE UNIQUE INDEX idx_asset_ledger_funding_ref
  ON execution_asset_ledger(execution_account_id, tx_ref, log_index)
  WHERE event_type = 'funding' AND tx_ref IS NOT NULL AND log_index IS NOT NULL;

INSERT INTO execution_asset_ledger
  (execution_account_id, asset, qty_delta, event_type, tx_ref, log_index, ts)
SELECT execution_account_id, UPPER(asset), CAST(qty AS TEXT), 'funding', tx_ref, log_index, ts
FROM execution_account_funding;

CREATE TABLE reconciliation_runs (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','clean','failed')),
  detail TEXT,
  actor TEXT NOT NULL
);
ALTER TABLE balance_snapshots ADD COLUMN reconciliation_run_id INTEGER REFERENCES reconciliation_runs(id);

CREATE TABLE manager_capital_allocations (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  allocated_usdg REAL NOT NULL CHECK (allocated_usdg >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(execution_account_id, bot_id)
);

CREATE TABLE execution_leases (
  wallet_address TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One custody account represents one physical wallet. Canary/live are order
-- labels and rollout gates, not separate copies of the wallet balance.
INSERT OR IGNORE INTO execution_accounts
  (name, mode, venue, currency, funded_usd, active, created_at, chain_id, settlement_asset)
VALUES
  ('ROBINHOOD_TRADER_01', 'canary', 'evm:robinhood', 'USDG', 0, 1,
   strftime('%s','now') * 1000, 4663, 'USDG');

INSERT OR IGNORE INTO execution_accounts
  (name, mode, venue, currency, funded_usd, active, created_at, chain_id, settlement_asset)
VALUES
  ('SIMULATION_BOOK', 'simulation', 'paper', 'USDC', 0, 1,
   strftime('%s','now') * 1000, NULL, NULL);

UPDATE live_orders
SET execution_account_id = (SELECT id FROM execution_accounts WHERE name = 'ROBINHOOD_TRADER_01')
WHERE execution_account_id IN (
  SELECT id FROM execution_accounts WHERE venue = 'evm:robinhood'
);

UPDATE live_ledger
SET execution_account_id = (SELECT id FROM execution_accounts WHERE name = 'ROBINHOOD_TRADER_01')
WHERE execution_account_id IN (
  SELECT id FROM execution_accounts WHERE venue = 'evm:robinhood'
);

UPDATE execution_account_funding
SET execution_account_id = (SELECT id FROM execution_accounts WHERE name = 'ROBINHOOD_TRADER_01')
WHERE execution_account_id IN (
  SELECT id FROM execution_accounts
  WHERE venue = 'evm:robinhood' AND name <> 'ROBINHOOD_TRADER_01'
);

UPDATE execution_asset_ledger
SET execution_account_id = (SELECT id FROM execution_accounts WHERE name = 'ROBINHOOD_TRADER_01')
WHERE execution_account_id IN (
  SELECT id FROM execution_accounts
  WHERE venue = 'evm:robinhood' AND name <> 'ROBINHOOD_TRADER_01'
);

UPDATE execution_accounts
SET active = CASE WHEN name = 'ROBINHOOD_TRADER_01' THEN 1 ELSE 0 END,
    currency = CASE WHEN name = 'ROBINHOOD_TRADER_01' THEN 'USDG' ELSE currency END,
    chain_id = CASE WHEN name = 'ROBINHOOD_TRADER_01' THEN 4663 ELSE chain_id END,
    settlement_asset = CASE WHEN name = 'ROBINHOOD_TRADER_01' THEN 'USDG' ELSE settlement_asset END
WHERE mode IN ('canary','live');

UPDATE live_config
SET mode = 'shadow', halted = 1, capital_stage = 0,
    limits_json = '{"totalCapitalUsd":100,"maxPerTradePct":10,"maxPerMachinePct":15,"maxSimultaneousPositions":4,"maxCorrelatedExposurePct":25,"maxDailyLossPct":5,"maxTotalDrawdownPct":10,"minCashReservePct":30,"leverageMax":1,"confidenceThreshold":90,"maxSlippageBps":35}',
    halt_reason = 'mainnet safety migration installed; funding import, reconciliation, preflight, and manual arm required',
    updated_at = strftime('%s','now') * 1000
WHERE id = 1;
