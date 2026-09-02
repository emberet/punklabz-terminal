# Launch Readiness

## Implemented

- Crypto-only WETH/USDG executable snapshot with Stock Tokens blocked
- Alchemy-backed token discovery that fails closed on malformed responses
- Manager rebalancing from reconciled NAV with a 30% USDG reserve
- 10% allocation-increase and 20% decrease limits per six-hour cycle
- Exact 20 USDG payment intents, finalized receipt verification, replay defense,
  renewal extension, and canonical-block audits
- Privy identity linking for email-first or wallet-first accounts
- One isolated Privy wallet and execution account per eligible live bot
- Provider read-back of wallet owner, signer quorum, and sole reviewed policy
- Funding import, reconciliation, activation, pause, contained failure, revoke,
  and in-kind withdrawal readiness checks
- Chainalysis screening that treats unknown responses as unavailable
- Public agent room with member write access, moderation, quotas, prompt-injection
  filtering, 30-day content deletion, and a separate measured model budget
- Migration 023 always halts execution and disables autonomy

## Manual blockers

These values or ceremonies cannot be inferred or performed safely from source:

1. Confirm the exact public `BILLING_TREASURY_ADDRESS`.
2. Install production Privy app secret and P-256 authorization key as root-owned
   credential files.
3. Review and attach the house Manager, house Trader, and user-bot Privy policies;
   install their exact IDs only after provider read-back succeeds.
4. Configure the primary Alchemy RPC, an independent secondary RPC, and 0x key.
5. Configure Chainalysis and verify a clear screening response.
6. Configure Resend and a verified sender for five-day reminders.
7. Back up and restore-test production before reclassifying custody.
8. Provision a fresh Trader wallet and manually authorize exactly 5 USDG and
   0.005 ETH from the Manager wallet.
9. Reconcile both accounts and complete the $0.50 WETH buy plus receipt-derived
   sell with zero residual WETH.
10. Perform fresh operator-wallet authentication and the explicit canary arm.
11. Resolve or formally accept the Privy/WalletConnect browser dependency audit
    findings before public launch; do not use the audit tool's forced Privy
    downgrade without a compatibility review.

Public user live bots remain tier 0 until the house records at least 25 clean
fills over 14 live days. Deployment alone must not bypass that evidence.

## Non-goals in this release

- No automatic replenishment of Trader losses
- No Stock Token or arbitrary-contract execution
- No automatic USDG membership renewal
- No server-initiated user withdrawal or liquidation
- No creator cash payout
- No private key in source, browser, ordinary production environment, or logs
