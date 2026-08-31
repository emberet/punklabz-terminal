# PUNKLABZ TERMINAL

Paper-trading arena with five house bots on live market data, a no-code bot
builder powered by Claude, a leaderboard, and a Claude-narrated profit
distributor for PunkLabz token holders. Neon, no glow.

**No real funds are traded.** Balances are simulated; billing is a mock ledger;
payout signatures are stubs until the PunkLabz token exists.

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

35 tests: payout math property tests, ledger invariants, indicators vs hand
fixtures, DSL validator corpus, paper-executor fills, and a deterministic
engine replay (V-shaped tape → dip buy → recovery sell → tax collected).

## Architecture notes

- **Executor boundary** (`server/src/execution/executor.ts`): engine and
  strategies never know paper from live. Real-money later = implement
  `LiveExecutor`, swap one line in `index.ts`.
- **Money math**: integer micro-USD everywhere money moves; BigInt in payout
  pro-rata; floats only in candles/indicators.
- **Manager split**: `payoutMath.ts` is pure + deterministic; Claude narrates
  and can only push an epoch toward `needs_review`, never touch amounts. The
  approve endpoint recomputes from the stored snapshot and refuses mismatches.
  Everything money-adjacent lands in a hash-chained audit log.
- **DSL not codegen**: the builder agent emits JSON validated by zod + semantic
  lint (3 repair rounds); quant bots run the same engine as house bots.
- **Fees** (mock ledger): $100 signup credit · $20 deploy → platform ·
  $10 clone → 100% to creator · $1/trade tax → platform. Broke bots pause
  (exits still run).

## Deploy

See [deploy/README.md](deploy/README.md).
