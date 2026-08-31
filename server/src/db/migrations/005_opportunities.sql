-- Opportunity Engine: the scanning funnel. Counts are recorded per pass;
-- only signal-grade opportunities are persisted individually (candidates are
-- far too numerous and are summarized in scan_passes).

CREATE TABLE scan_passes (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  markets_observed INTEGER NOT NULL,
  scans_performed INTEGER NOT NULL,
  candidates INTEGER NOT NULL,
  signals INTEGER NOT NULL,
  high_confidence INTEGER NOT NULL
);
CREATE INDEX idx_scan_passes_ts ON scan_passes(ts);

CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  scanner TEXT NOT NULL,
  universe TEXT NOT NULL,              -- majors | pumpfun | multichain
  instrument_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy','sell')),
  confidence INTEGER NOT NULL,
  gross_edge_bps REAL NOT NULL,
  fee_bps REAL NOT NULL,
  slippage_bps REAL NOT NULL,
  buffer_bps REAL NOT NULL,
  net_edge_bps REAL NOT NULL,
  edge_model TEXT NOT NULL,            -- how gross edge was estimated (named, never invented)
  evidence_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('signal','high_confidence','risk_approved','rejected','executed')),
  reject_reason TEXT,
  advisory INTEGER NOT NULL DEFAULT 1, -- 1 = scanner-sourced, no capital committed
  bot_id INTEGER REFERENCES bots(id),
  order_id INTEGER REFERENCES live_orders(id)
);
CREATE INDEX idx_opportunities_ts ON opportunities(ts);
CREATE INDEX idx_opportunities_state ON opportunities(state, ts);
