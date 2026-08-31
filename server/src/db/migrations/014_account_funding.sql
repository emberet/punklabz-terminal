-- EXTERNAL FUNDING OF AN EXECUTION ACCOUNT.
--
-- The reconciler compares what the chain holds against what the ledger says we
-- should hold, and `ledgerHoldings()` derived that purely from TRADES. So the
-- moment the trading wallet was funded, the chain had $5 and the ledger had
-- nothing, and reconciliation correctly reported the entire balance as
-- unexplained drift and halted the network.
--
-- The reconciler was right. The ledger was incomplete: money entering an
-- account from outside is a real event, and nothing recorded it.
--
-- This table is that record. Two properties keep it honest:
--
--   1. The OPERATOR states the amount. We do not read the chain and write down
--      whatever we find — that would make reconciliation a tautology, and
--      reconciler.ts explicitly forbids "fixing" the database to match the
--      chain. If the stated amount is wrong, reconciliation still fails.
--
--   2. Every row carries who recorded it and, where known, the transaction it
--      corresponds to, so a balance can always be traced to a claim someone
--      made and a transfer that happened.
--
-- Additive only — safe on the live prod DB.

CREATE TABLE execution_account_funding (
  id INTEGER PRIMARY KEY,
  execution_account_id INTEGER NOT NULL REFERENCES execution_accounts(id),
  asset TEXT NOT NULL,
  -- positive = deposit into the account, negative = withdrawal out of it
  qty REAL NOT NULL,
  /** the onchain transfer this corresponds to, when known */
  tx_ref TEXT,
  actor TEXT NOT NULL,
  note TEXT,
  audit_hash TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_account_funding ON execution_account_funding(execution_account_id, asset);
