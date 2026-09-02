# PunkLabz Maintenance Check

Checked: 2026-09-02T21:23:14Z
Scope: local checkout, production service, public APIs, production database health, and dependency/build checks.

## Executive Status

- Web and API are reachable. `GET /api/healthz` returned HTTP 200.
- Production is on Robinhood Chain mainnet, chain ID 4663, in canary mode, but execution is halted in `canary_exit_recovery`.
- Autonomy is disabled. No new live trade should be able to pass while the halt remains active.
- The production service and Cloudflare tunnel are running. Cloudflare logged brief origin connection errors during the latest service restart; public requests recovered and currently return HTTP 200.
- The Intern is live as `@PunkLabZRH`; its X provider is ready, two posts have been used against the daily quota, and September model spend is $0.032583 against the $50 cap.

## Verification Results

- Before this maintenance record was added, the Git checkout was clean and `main` matched `origin/main` at `62fc0ce29c0b6c08884c0346beaddf0edaaafbfb`.
- Server tests: passed, 38 test files and 505 tests.
- Production build: passed for shared, server, and web packages.
- Build warnings: Vite reported upstream `/*#__PURE__*/` annotation warnings from Privy packages and large minified chunks. These did not fail the build.
- Lint: no lint script is defined in the root package scripts.
- Frontend tests: no separate web test script is defined.
- Dependency audit: failed the high-level threshold with 25 vulnerabilities: 1 high and 24 moderate. The suggested forced fix upgrades Privy to a breaking version, so it was not applied during maintenance.
- Production identity: `/api/version` reports the full commit, `dirty=false`, an artifact checksum, and 25 applied migrations with latest migration `025_retire_operator_persona.sql`.
- Current production database: SQLite integrity check passed; foreign-key check returned no violations.
- Latest production backup: SQLite integrity check passed; foreign-key check returned no violations.
- Host capacity: root filesystem is 8% used; about 2.9 GiB memory is available; no swap is configured.

## Mainnet Findings

The current halt is legitimate and must remain in place. The latest Trader reconciliation failed because the wallet contains one unknown nonzero ERC-20:

`0x366efff7918807c144700cfc4b69bd21e42537f8`

The latest reconciliation run is failed while the Manager reconciliation is clean. The account therefore cannot be treated as reconciled or safe to resume.

The recorded live route consists of:

1. A confirmed allowance transaction on chain 4663.
2. A confirmed WETH/USDG swap transaction with 181 confirmations at the time of the check.
3. Receipt-derived ledger entries for `-0.5 USDG`, `+0.000207949868288714 WETH`, and `-0.0001037713524 ETH` gas.

This is evidence of one real mainnet swap, not evidence of verified autonomous trading. WETH remains in the Trader ledger and the subsequent reconciliation is not clean. The system is correctly rejecting subsequent attempts because of the kill switch, exit-recovery phase, missing allocation in some attempts, low model scores, and negative modeled net edge.

The live universe is correctly limited to two configured routes/assets for the current crypto scope. BTC/SOL paper signals are rejected as having no live instrument mapping; they are not silently routed to mainnet.

## Product And UX Findings

- The Arena and bot detail UI explicitly labels simulated balances as paper/simulated and displays separate live capital panels, which is the correct direction.
- The public `/api/bots` response still contains the $10,000 paper equity/cash fields alongside live-capital fields. Any surface that gives the paper values visual priority can still confuse users; keep the paper/live distinction prominent.
- The public execution status exposes the correct chain and halted state. It does not expose admin-only wallet, signer, or policy details.
- All tested public routes returned HTTP 200: `/`, `/arena`, `/build`, `/control-room`, `/intern`, `/feed`, `/learn`, `/api/healthz`, and `/api/live/status`.
- A final repeated `/api/live/status` poll returned HTTP 429 with a seven-second retry hint. This is expected rate limiting after repeated checks, not an origin outage.

## Priority Actions

### P0

- Identify the unknown token using read-only chain metadata and determine whether it is an unsolicited asset or an expected transfer. Do not whitelist it merely to clear the halt.
- Use an approved operator recovery path for the unknown asset, if one exists, and record the decision in the audit log.
- Complete and reconcile the exact WETH exit. Require zero residual WETH, clean Trader reconciliation, and a clean follow-up reconciliation before any arm attempt.
- Run fresh signer, RPC, token, gas, quote, ledger, and restart-recovery preflight after reconciliation. Keep autonomy disabled until every gate passes.

### P1

- Resolve the production dependency audit findings, starting with the high-severity `ws` advisory, in a dedicated compatibility-tested dependency release.
- Add a lint command and a frontend smoke-test job to the release pipeline.
- Add a deterministic frontend artifact/version stamp or deploy-time checksum check. The backend is tied to the exact commit, but the local build used a different Vite environment and produced a different frontend bundle, so frontend identity is not independently proven by this check.
- Add monitoring for repeated 404-handler warnings and Cloudflare origin errors during restarts.

## Conclusion

The application is operationally reachable and the safety controls are active. The mainnet canary is halted and not ready for autonomy because the Trader wallet is not reconciled and retains an unresolved WETH position plus an unknown nonzero token. No runtime changes, trades, resume, arm, or deployment were performed by this maintenance check.

## Autonomy Readiness Follow-up

The unknown token was queried through the configured Robinhood RPC and identified as `SPCSEX` (`SPCSEX`), 18 decimals, with exactly 9 tokens in the Trader wallet. An indexed transfer record shows the token contract sent those 9 tokens directly to the Trader as an unsolicited self-airdrop; it is not one of the recorded USDG/ETH funding transfers and is not in the approved executable registry.

The latest persisted preflight confirms these checks pass: Privy signer and policy binding, chain 4663, primary and secondary RPCs, RPC freshness, Robinhood adapter, core USDG/WETH contract verification, operator alerts, funding provenance, wallet isolation, and zero unresolved durable transactions/orders. Blocking checks remain funded balance, stage collateralization, gas reserve pricing, and Trader reconciliation because the unknown token makes the balance read fail. The canary proof also remains incomplete after a prior sell was rejected at the minimum-size gate.

Required operator decision: either complete a separately reviewed, policy-approved disposition of the 9 `SPCSEX` tokens or provision a fresh isolated Trader wallet and fund it through the approved Manager ceremony. The token must not be silently ignored or added to the executable universe. After that, complete the exact WETH exit, run a clean reconciliation and fresh preflight, and only then perform the explicit autonomy arm ceremony.

## Unknown-Token Burn Check

Read-only transaction simulations were performed against the exact `SPCSEX` contract and Trader balance. `burn(uint256)`, `burnFrom(address,uint256)`, `transfer(0x0,uint256)`, and `transfer(0x000000000000000000000000000000000000dEaD,uint256)` all reverted, including gas estimation. No transaction was signed or broadcast. The token cannot be safely burned through a standard ERC-20 method; the reconciliation halt remains correct.

## Replacement Trader Ceremony

A fresh Privy-controlled Trader wallet was provisioned on September 3, 2026:

- Wallet: `0x480859381d1897734A445053693A8017E3C3BD4a`
- Chain: Robinhood Chain `4663`
- Dedicated policy and runtime signer: created and read back by Privy
- Existing Trader: preserved as an inactive recovery account; no asset was deleted or silently reclassified

The release adds an explicit Trader rotation path and a USDG-only funding command. The funding command is constrained to exactly `5 USDG` and does not include ETH. The Manager wallet has no server-side runtime signer, so the actual Manager-to-Trader transfer still requires the operator's wallet authorization. No USDG transfer has been broadcast as part of this check.
