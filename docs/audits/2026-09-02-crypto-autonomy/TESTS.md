# Verification Record

This file is updated only with commands actually executed against the release
checkout.

## Completed

- `npm ci`: passed
- Targeted custody/delegation suite: 59 tests passed at its final targeted run
- Complete server suite: 35 files, 487 tests passed
- Production Alchemy token-balance probe: HTTP 400 with the legacy hexadecimal
  `maxCount`, HTTP 200 with the corrected integer `maxCount: 100`
- Shared, server, and web production build: passed
- Server production dependency audit: 0 vulnerabilities
- Combined production dependency audit: failed with 25 transitive browser
  findings (24 moderate, 1 high) under Privy/WalletConnect; npm's suggested
  forced fix is a breaking Privy downgrade and was not applied
- Migration 023 applied to a SQLite backup of the existing local database:
  integrity `ok`, mode `shadow`, halted `1`, capital stage `0`, autonomy `0`,
  executable scope `CRYPTO_CORE`
- Desktop 1280x720 and mobile 390x844 browser smoke checks: passed
- Membership and Delegation unauthenticated states: passed
- Fresh browser console check: no warnings or errors
- Source secret-pattern scan: no credentials found
- `git diff --check`: passed

## Build debt

- Privy's distributed bundles produce removable `/*#__PURE__*/` annotation
  warnings in Rollup.
- The largest Privy client chunk is about 605 kB minified; route-level code
  splitting should be handled before optimizing launch performance.
