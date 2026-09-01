-- Reference prices for stock tokens come from Robinhood, while WETH uses the
-- independent ETH/USD market mark. Preserve that distinction in the ledger.
ALTER TABLE rh_reference_prices ADD COLUMN source TEXT NOT NULL DEFAULT 'robinhood';
