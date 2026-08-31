-- Live-execution network: safety spine. Additive; safe on the live prod DB.
-- Real trading stays OFF — this build tops out at SHADOW mode (no signer).
-- Money is integer micro-USD, consistent with the rest of the schema.

CREATE TABLE live_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'simulation' CHECK (mode IN ('simulation','shadow','canary','live')),
  halted INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  capital_stage INTEGER NOT NULL DEFAULT 0,     -- 0=$0 shadow .. 4=$100
  limits_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- one order per intent; intent_id makes retries idempotent
CREATE TABLE live_orders (
  id INTEGER PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  bot_id INTEGER REFERENCES bots(id),
  instrument_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  order_type TEXT NOT NULL DEFAULT 'market',
  requested_notional_micro INTEGER NOT NULL,
  approved_notional_micro INTEGER,
  mode TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('proposed','risk_approved','risk_rejected','submitting','open','partial','filled','cancelled','failed','reconciling')),
  confidence INTEGER,
  risk_json TEXT,
  expected_price REAL,
  executed_price REAL,
  slippage_bps REAL,
  fee_micro INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT,
  tx_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_live_orders_bot ON live_orders(bot_id, created_at);
CREATE INDEX idx_live_orders_state ON live_orders(state);

-- every executed live/shadow order books here; LIVE stats derive only from this
CREATE TABLE live_ledger (
  id INTEGER PRIMARY KEY,
  order_id INTEGER REFERENCES live_orders(id),
  bot_id INTEGER REFERENCES bots(id),
  instrument_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  expected_price REAL NOT NULL,
  executed_price REAL NOT NULL,
  fee_micro INTEGER NOT NULL DEFAULT 0,
  gas_micro INTEGER NOT NULL DEFAULT 0,
  slippage_bps REAL NOT NULL DEFAULT 0,
  realized_pnl_micro INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  tx_ref TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_live_ledger_bot ON live_ledger(bot_id, ts);
CREATE INDEX idx_live_ledger_ts ON live_ledger(ts);

CREATE TABLE venue_health (
  venue TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('online','degraded','offline')),
  latency_ms INTEGER,
  error_rate REAL NOT NULL DEFAULT 0,
  last_ok_at INTEGER,
  note TEXT,
  updated_at INTEGER NOT NULL
);
