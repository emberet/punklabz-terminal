# PunkLabz Crypto Autonomy Launch Record

Date: 2026-09-02

This folder records the implementation and launch evidence for the crypto-only
autonomy and user-bot release. It intentionally contains no wallet secrets,
provider credentials, private policy documents, or transaction calldata.

## Release boundary

- Home network: Robinhood Chain mainnet, chain ID 4663
- Executable assets: canonical WETH and USDG only
- House custody: human treasury -> Manager operating wallet -> isolated Trader
- User custody: one user-owned Privy wallet per live bot
- Billing: exact 20 USDG onchain payment for 30 days
- Public room: public read, paid-member write, isolated $100 monthly agent budget
- Deployment default: halted, autonomy off, capital stage $0

The old 196-asset registry remains reference data only. Stock Tokens, ETFs,
RWAs, arbitrary contracts, Stripe enforcement, creator cash payouts, and public
user live delegation remain disabled until their own gates are earned and
reviewed.

See [READINESS.md](./READINESS.md) for the remaining operator actions and
[TESTS.md](./TESTS.md) for executed verification.
