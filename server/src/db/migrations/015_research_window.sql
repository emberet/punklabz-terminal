-- THE RESEARCH WINDOW.
--
-- A time-boxed period in which the network deliberately trades more freely
-- than its steady-state settings allow, to generate the outcome data the
-- confidence-weight loop needs. Everything it produces is recorded so that
-- after the window closes the network trades from measured history rather than
-- from the same priors it started with.
--
-- WHAT A WINDOW MAY RELAX: the confidence threshold, how many positions may be
-- open at once, and per-trade size within the existing clamps.
--
-- WHAT IT MAY NEVER TOUCH, and the reason each one is not negotiable:
--   leverage        — a losing position that can exceed the account is a
--                     different category of risk, not a larger one
--   drawdown killer — the circuit breaker is what ends a bad window early
--   daily loss stop — same
--   kill switch     — an operator must always be able to stop it
--   the Privy cap   — it lives at the enclave and this table cannot reach it
--
-- The window's start is PERSISTED. Held in memory, a restart would reset the
-- clock and a "72 hour" experiment would run until someone noticed — the same
-- mistake the forum demo window already had to be built around.
--
-- Additive only — safe on the live prod DB.

CREATE TABLE research_window (
  id INTEGER PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  hours REAL NOT NULL,
  closes_at INTEGER NOT NULL,
  closed_at INTEGER,
  actor TEXT NOT NULL,

  -- the settings in force during the window
  confidence_threshold INTEGER NOT NULL,
  max_positions INTEGER NOT NULL,
  max_per_trade_pct REAL NOT NULL,

  -- what to restore when it closes, captured at open so a restart cannot lose it
  restore_json TEXT NOT NULL,

  -- outcome, written when the window closes
  orders_placed INTEGER NOT NULL DEFAULT 0,
  fills INTEGER NOT NULL DEFAULT 0,
  realized_pnl_micro INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX idx_research_window_open ON research_window(closed_at, closes_at);
