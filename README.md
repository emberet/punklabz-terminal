# PUNKLABZ TERMINAL

Autonomous market laboratory on Robinhood Chain. Five house bots and
user-built quant machines trade on live market data, a no-code builder powered
by Claude turns plain English into validated strategy JSON, and a leaderboard
ranks the results. Neon, no glow.

## What is real, and what is not

"Live" means four different things in a trading product, and conflating them is
how people lose money. Precisely:

| | Status |
|---|---|
| Market data | **REAL** — Binance, pump.fun, Robinhood Chain asset APIs |
| Robinhood Chain asset registry | **REAL** — immutable snapshots include only contracts verified onchain at capture time |
| 0x quotes on chain 4663 | **REAL** — priced, validated, not signed |
| Privy signer + policy | **RUNTIME STATE** — inspect the admin Control Room; the release requires an isolated Trader owner, signer and policy |
| Strategy P&L, balances, fees | **PARTITIONED** — paper books stay simulated; mainnet books come only from confirmed receipt deltas |
| Execution mode | **RUNTIME STATE** — public status is deliberately coarse; wallet and transaction proof are admin-only |
| Token holder payouts | **STUBBED** — no PunkLabz token exists |
| Lab membership | **GATED ROLLOUT** — Stripe-hosted $20/month access is implemented; runtime configuration decides whether Checkout and enforcement are active |

`GET /api/version` reports the exact commit, migration count and execution mode
of any running deployment. Do not reason about what production is doing from
this README; ask the server.

The first mainnet experiment uses a fresh Robinhood Chain Trader wallet seeded
with exactly `5 USDG` and `0.005 ETH`. It cannot become autonomous until an
operator arms stage 1, a receipt-derived `$0.50` buy/close round trip settles,
and a fresh reconciliation and preflight both pass for the exact wallet and
signer policy. Runtime status, not this README, is the source for whether that
ceremony has happened.

Full-market autonomy is a second, stricter ceremony. Deployment alone does not
enable it. The release must capture an immutable registry snapshot, generate
and manually attach its matching Privy policies, record a signed jurisdiction
attestation, finish an exact-cardinality 15-minute sweep, reconcile after that
sweep, and retain the receipt-backed WETH/USDG proof. Only a freshly
authenticated operator can then authorize the reconciled USDG balance by
entering the exact launch phrase. Later deposits never widen that cap.

## Stack

One Node process: Fastify + ws + better-sqlite3, serving a Vite/React build.
npm workspaces: `shared/` (zod DSL + types), `server/`, `web/`.

## Run locally

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY for the builder agent
npm run build
npm run dev:server          # api + engine on :4700 (serves web/dist if built)
npm run dev:web             # vite dev on :4710 (proxies /api + /ws)
```

## Test

```bash
npm test
```

Beyond the original paper-trading suite (payout math properties,
ledger invariants, indicators vs hand fixtures, DSL validator corpus,
deterministic engine replay) the execution boundary carries its own: wrong
chain, wrong token, wrong spender, unapproved transaction target, slippage
enforced before signing, duplicate intent, shadow P&L never touching live NAV,
reconciliation drift engaging the kill switch, and operator clearance derived
from a signature rather than a database column.

## Architecture notes

- **Execution boundary**: real money is NOT one line away, and any suggestion
  otherwise is a bug in the documentation. A signal becomes a transaction only
  through: instrument resolver (explicit chain + contract addresses + decimals)
  → risk engine → preflight → execution account → venue adapter (every quote
  field checked against the approved intent) → external signer → broadcast →
  receipt → reconciliation. Each stage can refuse, and refusals say why.
- **Money math**: integer micro-USD everywhere money moves; BigInt in payout
  pro-rata; floats only in candles/indicators.
- **Manager split**: `payoutMath.ts` is pure + deterministic; Claude narrates
  and can only push an epoch toward `needs_review`, never touch amounts. The
  approve endpoint recomputes from the stored snapshot and refuses mismatches.
  Everything money-adjacent lands in a hash-chained audit log.
- **DSL not codegen**: the builder agent emits JSON validated by zod + semantic
  lint (3 repair rounds); quant bots run the same engine as house bots.
- **Membership**: PunkLabz Lab is one Stripe-hosted USD 20/month product. Signed,
  idempotently journaled webhooks are the entitlement source; a successful
  browser redirect grants nothing. Verified invoice outcomes are stored in a
  dedicated billing table and never enter a trading or demo-credit account.
- **Demo economy** (NOT real revenue): 100 signup credits · 20-credit deploy
  fee while membership enforcement is off · 10-credit clone transfer to the
  creator · 1% paper trade tax. Once membership is enforced, deployments are
  included. Clone credits remain non-withdrawable until a separate creator
  payment rail is designed and reviewed.

## Deploy

See [deploy/README.md](deploy/README.md).

Engineering collaboration: OpenAI Codex.
