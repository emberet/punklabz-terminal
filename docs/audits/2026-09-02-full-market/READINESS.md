# PunkLabz Full-Market Mainnet Readiness

Recorded: 2026-09-02 (Asia/Kolkata)

This folder records the engineering state of the full-market experiment. It
contains no secrets, wallet addresses, transaction payloads or signer policy
IDs. Production runtime and chain state remain the source of truth.

## Implemented in this release

- Immutable Robinhood Chain registry snapshots with exact contracts, decimals,
  multipliers, trading capabilities and a deterministic content hash.
- Dynamic asset blocking for stale verification, corporate actions, trading
  halts, closed sessions, stale prices and unusable routes.
- Exact directed-pair sweeps with non-overlap, deadline, 0x pacing and fail-closed
  handling for rate limits, stale data or incomplete cardinality.
- Permanent sweep summaries with detailed route evidence bounded to the latest
  two sweeps plus every council-linked candidate, avoiding unbounded SQLite growth.
- A five-role council with shared deliberation, mandatory Risk Core and Manager
  approval, source evidence, model-score wording and an isolated monthly budget.
- Snapshot-derived swap intents. Models cannot supply addresses, calldata,
  amounts, signer instructions, limits or policies.
- Arbitrary ERC-20 execution through 0x with exact token and calldata checks,
  bounded approvals, durable child transactions and receipt-derived deltas.
- BigInt raw-unit ledger and reconciliation, unknown-token detection, conservative
  executable sell-to-USDG NAV, and ETH excluded from trading capital.
- Snapshot-bound Privy policy manifests, application allowlist hash matching,
  live policy-body read-back and price-drift rejection for static raw-token caps.
- Signed jurisdiction attestation, readiness, sweep, policy, council and
  activation admin APIs protected by fresh operator-wallet authentication.
- One-time capture of reconciled USDG as the autonomy ceiling. Later deposits
  do not widen authorization.

## Activation blockers

The code release is not authority to trade. Full-market autonomy remains off
until every item below is proven against the deployed production state:

- Measured sustained 0x quota sufficient for a full sweep in 14 minutes. A
  196-asset snapshot requires 38,220 directed requests, roughly 47.2 requests
  per second before retry headroom and about 3.67 million requests per day.
- Fresh immutable universe snapshot and reference bars for every active asset.
- Manually reviewed and attached Privy policy bundle whose IDs, target allowlist
  and hashes exactly match the active snapshot.
- Signed operator jurisdiction attestation for stock-token execution.
- Completed and reconciled `$0.50` WETH/USDG buy-and-close proof.
- Complete exact-cardinality sweep, followed by a clean reconciliation.
- Zero unresolved execution transactions and a passing canary preflight.
- Fresh operator-wallet authentication and the exact phrase
  `ENABLE AUTONOMOUS CANARY $5` at activation time.

## Capital and risk envelope

- Settlement asset: USDG. ETH is gas only and excluded from NAV.
- Initial stage: `$5` canary, `$0.50` maximum per swap, four positions, 30% USDG
  reserve, 5% daily-loss halt, 10% drawdown halt and no leverage.
- Maximum slippage: 35 bps in validated calldata, plus a 10 bps safety margin.
- A trade executes only when deterministic final arithmetic remains positive
  after executable spread, gas, 0x effects, slippage, liquidity and margin.
- LLM output is advisory and can only lose a deterministic vote. It cannot
  widen capital, contracts, permissions, policies or risk controls.

## Operational sequence

1. Deploy the clean commit and verify that migration 021 leaves execution halted.
2. Back up and restore-test SQLite, then run health, version and admin status smoke tests.
3. Configure quota, references and the indexer; capture the registry snapshot.
4. Generate, review and manually attach the snapshot-bound Privy policy set.
5. Add the signed jurisdiction attestation and run the WETH/USDG route proof.
6. Enable scanning, obtain one clean sweep, then reconcile after it.
7. Review readiness blockers and explicitly arm the `$5` full-market canary.

Stripe remains disabled and independent from every trading control.

## Verification executed

- `npm test`: 34 files, 467 tests passed.
- `npm run build`: shared, server and web production builds passed.
- `npm audit --omit=dev`: zero vulnerabilities reported.
- Migration restore-copy test: migration 021 applied, SQLite integrity `ok`,
  required tables present, and execution ended in halted shadow at stage `$0`
  with both autonomy flags disabled.
- Browser review: desktop and 390px Control Room had no horizontal overflow or
  console errors. The admin-only controls were build-verified without creating
  a synthetic operator session or invoking a state-changing action.

The Vite build retains upstream WalletConnect/Rollup annotation warnings and a
bundle-size warning. These are performance/packaging follow-ups, not execution
authority or accounting failures.
