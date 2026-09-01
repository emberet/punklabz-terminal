-- Immediate mainnet experiment controls.
--
-- Additive schema only. The currently funded wallet is reclassified by the
-- operator ceremony after the new Trader wallet exists; doing that in a boot
-- migration would bind the old signer to the new account before production
-- credentials can be switched atomically.

ALTER TABLE execution_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'trader';
UPDATE execution_accounts SET role = 'book' WHERE venue IN ('paper', 'shadow');

ALTER TABLE live_config ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'shadow';
ALTER TABLE live_config ADD COLUMN autonomy_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE live_orders ADD COLUMN operator_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE live_orders ADD COLUMN experiment_run_id INTEGER;
ALTER TABLE live_orders ADD COLUMN discussion_session_id INTEGER;

CREATE TABLE canary_experiment_runs (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  sponsor_bot_id INTEGER NOT NULL REFERENCES bots(id),
  wallet_address TEXT NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'created','buy_pending','buy_confirmed','sell_pending','reconciling','completed','failed'
  )),
  buy_order_id INTEGER REFERENCES live_orders(id),
  sell_order_id INTEGER REFERENCES live_orders(id),
  reconciliation_run_id INTEGER REFERENCES reconciliation_runs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  failure_reason TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_canary_experiment_state ON canary_experiment_runs(state, updated_at);

CREATE TABLE custody_transfers (
  id INTEGER PRIMARY KEY,
  from_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  to_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  asset TEXT NOT NULL,
  qty TEXT NOT NULL,
  tx_ref TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  gas_eth TEXT NOT NULL DEFAULT '0',
  confirmations INTEGER NOT NULL,
  actor TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tx_ref, asset, log_index)
);

ALTER TABLE research_sessions ADD COLUMN related_order_id INTEGER REFERENCES live_orders(id);
ALTER TABLE research_sessions ADD COLUMN advisory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_sessions ADD COLUMN related_signal_id TEXT;
ALTER TABLE research_sessions ADD COLUMN measured_inputs_json TEXT;
ALTER TABLE research_sessions ADD COLUMN transcript_json TEXT;

ALTER TABLE intern_posts ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE intern_posts ADD COLUMN source_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE intern_posts ADD COLUMN reviewed_at INTEGER;
ALTER TABLE intern_posts ADD COLUMN reviewed_by TEXT;
ALTER TABLE intern_posts ADD COLUMN review_approved INTEGER NOT NULL DEFAULT 0;

UPDATE live_config
SET halted = 1,
    halt_reason = 'mainnet experiment migration installed; isolated Trader funding and probe required',
    capital_stage = 0,
    mode = 'shadow'
WHERE id = 1 AND mode IN ('canary','live');

UPDATE live_config
SET execution_phase = mode,
    autonomy_enabled = 0
WHERE id = 1;
