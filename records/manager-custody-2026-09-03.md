# Manager Custody Finding - 2026-09-03

Production has an active `MANAGER_OPERATING_01` execution-account address, but
the backend is not configured with a Manager provider wallet ID.

## Current State

- Manager account: `MANAGER_OPERATING_01`
- Manager address: `0xd5788b6694a05366faaeefeff35c7a5913d02ff9`
- Active Trader account: `ROBINHOOD_TRADER_01`
- Trader address: `0x480859381d1897734a445053693a8017e3c3bd4a`
- Production signer wallet ID is the Trader wallet ID, not a Manager wallet ID.
- No `MANAGER_WALLET_ID` is configured in production.
- Admin account wallet is separate from the Manager address.

## Consequence

PunkLabz can read the Manager address from the database, but cannot move funds
from it unless one of these is true:

1. The operator signs from the Manager wallet in the browser.
2. A Privy Manager wallet ID plus its required authorization owner/policy is
   configured for server-side, policy-bounded signing.

No raw private key should be pasted into chat, committed, stored in `.env`, or
placed in the frontend.

## Safe Experiment Path

For the immediate canary, the Trader can be funded directly from any wallet the
operator controls:

- Send exactly `5 USDG` to the Trader on Robinhood Chain `4663`.
- Send exactly `0.005 ETH` to the Trader on Robinhood Chain `4663`.
- Import both transaction hashes through the Control Room.
- Run reconciliation and preflight before any route proof or canary arm.

This funds the Trader directly. It does not prove Manager autonomy.

## Proper Manager Autonomy Path

Provision or recover a Manager wallet that is controlled by Privy/server-side
policy, configure its provider wallet ID and authorization credential outside
the repo, fund it manually, then let it issue only exact policy-bounded
Manager-to-Trader transfers.
