# PunkLabz Immediate Mainnet Experiment

## Scope

This release replaces the scheduled 24-hour delay with a bounded, evidence-led
Robinhood Chain experiment. It does not declare the product generally live.

- Chain: Robinhood Chain mainnet (`4663`), ETH gas.
- Instrument: WETH/USDG spot through 0x only.
- Manager: the previously funded Privy wallet, isolated from runtime signing.
- Trader: a fresh Privy wallet with a separate management owner and restricted
  runtime additional signer.
- Capital: exactly `5 USDG`; `0.005 ETH` is gas reserve and never NAV.
- Probe: one `$0.50` buy followed by an exact receipt-derived WETH close.
- Autonomy: enabled only after the probe has 12-confirmation receipts, one-time
  ledger posting, zero residual WETH, clean reconciliation, and fresh preflight.

## Evidence Boundary

The database records intent and belief. Robinhood Chain receipts and balances
are authoritative. Every signed transaction is durable before broadcast and
identified by wallet, nonce, signed hash, order id, and idempotency key.

Operator tests are permanently marked and cannot count as promotion evidence.
Paper and shadow books cannot capitalize the Trader, affect live NAV, or fund a
payout. Production payout code remains disabled independently of configuration.

## Autonomy Boundary

The Manager may allocate `0.75 USDG` each to `MOMENTUM RUNNER`, `MEAN
REVERSION`, and `GRID TRADER` within the stage cap. It cannot alter the stage,
wallet, contracts, signer policy, leverage, or kill switch.

Trade huddles are advisory records linked to the measured signal, order, and
risk decision. Their output has no route back into order creation, sizing,
approval, rejection, signing, or broadcasting.

## Intern Boundary

The Intern may move from shadow to live only after three fresh, operator-
approved, X-backed drafts. Internal-only drafts are labelled and cannot satisfy
that gate. Live publishing is capped at three posts per day.

## Operator Records

Each production ceremony has a UTC run directory under
`~/Documents/PunkLabz Mainnet Records/`. That bundle contains sanitized status,
checksums, test/build results, migration evidence, transaction hashes, receipt
summaries, reconciliation proof, and smoke-test output. Private keys, app
secrets, RPC credentials, API tokens, and signed transaction payloads are never
copied into the record bundle.
