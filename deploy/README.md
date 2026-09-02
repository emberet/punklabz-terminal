# Deploying PunkLabz Terminal

One VPS, one systemd unit, Cloudflare tunnel in front. Mirrors the cashcow.exe setup.

## 1. Provision (once)

Hetzner CPX22 (~€8/mo) or similar, Ubuntu 24.04:

```bash
apt update && apt install -y nodejs npm rsync curl
useradd -r -m -s /usr/sbin/nologin punklabz
mkdir -p /opt/punklabz && chown punklabz:punklabz /opt/punklabz
ufw allow OpenSSH && ufw enable
```

Node must be >= 22 (better-sqlite3 v13). Use nodesource if the distro node is older.

## 2. Secrets (once, on the server)

```bash
cat > /opt/punklabz/.env <<'EOF'
PORT=4700
NODE_ENV=production
SESSION_SECRET=<openssl rand -base64 32>
FEED_MODE=binance
PUMP_FEED_ENABLED=true
ADMIN_WALLET=<human operator wallet; never the trading wallet>
DB_PATH=./data/punklabz.db
AUTO_APPROVE_CAP_USD=500
EPOCH_CRON=0 0 * * *
PAYOUTS_ENABLED=false
LLM_BUDGET_USD=40
INTERN_LLM_BUDGET_USD=50
TRADING_COUNCIL_LLM_BUDGET_USD=50
AGENT_CHAT_LLM_BUDGET_USD=100
SIGNER_PROVIDER=privy
PRIVY_APP_ID=<privy app id>
PRIVY_WALLET_ID=<dedicated trader wallet id>
PRIVY_SIGNER_ID=<runtime additional-signer quorum id>
PRIVY_POLICY_IDS=<reviewed policy ids, comma-separated>
TRADING_WALLET_ADDRESS=<dedicated trader wallet public address>
SIGNER_ALLOWED_TARGETS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,0x0000000000001fF3684f28c67538d4D072C22734
SIGNER_MAX_NATIVE_ETH=0
ZEROX_SUSTAINED_RPS=0
FULL_MARKET_SCANNER_ENABLED=false
RPC_ROBINHOOD_PRIMARY=<chain 4663 private RPC>
RPC_ROBINHOOD_SECONDARY=<independent chain 4663 RPC>
OPERATOR_ALERT_WEBHOOK_URL=<private incident webhook>
ROBINHOOD_TRACE_API_URL=https://robinscan.io/api
# Keep billing disabled for the first deploy. See "USDG membership activation".
BILLING_PROVIDER=none
BILLING_ENFORCED=false
APP_ORIGIN=https://punklabz.app
VITE_PRIVY_APP_ID=<public Privy app id; embedded into the web build>
DELEGATION_PROVIDER=none
# BILLING_TREASURY_ADDRESS=<explicit public treasury address>
# PRIVY_USER_BOT_SIGNER_ID=<reviewed user-bot signer quorum id>
# PRIVY_USER_BOT_POLICY_ID=<reviewed crypto-only user-bot policy id>
# CHAINALYSIS_API_URL=<Chainalysis KYT API base URL>
EOF
chown punklabz:punklabz /opt/punklabz/.env && chmod 600 /opt/punklabz/.env
```

Install the Privy P-256 authorization key as a root-owned systemd credential,
not in `.env`. The Privy app secret is a separate credential:

```bash
install -d -m 700 /etc/punklabz
install -m 600 /path/to/privy-authorization-key /etc/punklabz/privy-authorization-key
install -m 600 /path/to/privy-app-secret /etc/punklabz/privy-app-secret
install -m 600 /path/to/anthropic-api-key /etc/punklabz/anthropic-api-key
install -m 600 /path/to/zerox-api-key /etc/punklabz/zerox-api-key
```

Production rejects inline `ANTHROPIC_API_KEY` and `ZEROX_API_KEY` values. The
service loads both from the root-owned systemd credentials above.

Before public live-bot provisioning, install the Chainalysis key as a third
root-owned credential and add a systemd drop-in. Do this only after the file
exists; a missing `LoadCredential` source correctly prevents startup:

```bash
install -m 600 /path/to/chainalysis-api-key /etc/punklabz/chainalysis-api-key
systemctl edit punklabz
# [Service]
# LoadCredential=chainalysis_api_key:/etc/punklabz/chainalysis-api-key
# Environment=CHAINALYSIS_API_KEY_FILE=%d/chainalysis_api_key
```

For the Intern, install `x-app-key`, `x-app-secret`, `x-access-token`, and
`x-access-secret` in the same directory and set `X_PROVIDER=api` plus the exact
`X_HANDLE` in `.env`. Keep zero-length credential placeholders while the
provider is disabled so the unit remains installable without X access.

**Day-one check:** `curl -s https://api.binance.com/api/v3/ping` from the box.
If it returns HTTP 451 (geoblocked range), set `FEED_MODE=coinbase`.

## USDG membership activation

Set `BILLING_PROVIDER=usdg`, the exact public `BILLING_TREASURY_ADDRESS`, and
leave `BILLING_ENFORCED=false`. A membership intent accepts exactly 20,000,000
raw units of canonical USDG from a cryptographically linked wallet to that
treasury on chain 4663. Access begins only after 12 confirmations and is
extended 30 days from the later of confirmation or the current paid expiry.

Run a real operator smoke test before enforcing access:

1. Create an intent, transfer exactly 20 USDG, and submit the transaction hash.
2. Verify sender, recipient, contract, amount, block hash, log index, 12
   confirmations, unique receipt, subscription, and payment journal.
3. Renew early and confirm the new period extends the existing expiry.
4. Exercise the canonical-block audit against a disposable database copy.
5. Configure `RESEND_API_KEY` and a verified `BILLING_EMAIL_FROM`, then confirm
   the five-day reminder is sent once.
6. Only then set `BILLING_ENFORCED=true` and test paid, expired, and 48-hour
   read/chat grace behavior.

There is no automatic renewal or treasury signer. Paper credits, simulated
returns, creator credits, and Stripe return URLs cannot create membership.

## 3. systemd (once)

```bash
cp /opt/punklabz/deploy/punklabz.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable punklabz
```

## 4. Cloudflare tunnel (once)

```bash
cloudflared tunnel create punklabz
cloudflared tunnel route dns punklabz terminal.yourdomain.xyz
# config.yml: service: http://localhost:4700
cloudflared service install
```

## 5. Deploy (every time)

```bash
./deploy/deploy.sh root@<server-ip>            # real
./deploy/deploy.sh root@<server-ip> --dry-run  # preview
```

Never rsyncs `data/` or `.env`. The remote build compiles shared+server+web and restarts the unit.
Deploys refuse a dirty checkout, use `npm ci`, stamp the full git SHA and artifact checksum,
back up SQLite, and apply migrations to a disposable backup copy before restarting production.

## Crypto-only mainnet arming

Migrations `016_mainnet_safety.sql` and `017_mainnet_experiment.sql` return any
old real-money state to halted shadow at stage `$0`. The immediate experiment
then uses the wallet-authenticated Control Room to:

1. Reclassify the funded wallet as `MANAGER_OPERATING_01`.
2. Provision a fresh externally owned `ROBINHOOD_TRADER_01` wallet with a separate runtime signer policy.
3. Transfer exactly `5 USDG` and `0.005 ETH`, wait for 12 confirmations, and post both custody sides idempotently.
4. Reconcile Manager and Trader balances, then arm `canary` stage 1 by typing `ARM ROBINHOOD 4663 $5`.
5. Run the durable `$0.50` round-trip probe. Its sell quantity comes from the confirmed buy receipt and it must leave zero WETH after reconciliation.
6. Enable autonomous canary only after a fresh safety gate. The deterministic
   Manager retains 30% USDG and may increase any bot by at most 10% of
   authorized capital per six-hour cycle.
7. Wait for 10 reconciled autonomous fills at each later stage before promotion.

Do not switch to `live` until stage 4 is fully funded and has 10 clean, non-forced fills.

## User live-bot activation

User bots stay at tier 0 until house evidence reaches 25 clean fills across 14
live days. Before the first tier-1 wallet:

1. Enable Privy email/wallet login, additional embedded wallets, required signed
   requests, session signers, and policy enforcement.
2. Manually review the user-bot policy. It must allow only canonical WETH,
   canonical USDG, the approved 0x target/selectors, chain 4663, bounded amounts,
   and zero native value. Install only its exact signer and policy IDs.
3. Set `DELEGATION_PROVIDER=privy`, install Chainalysis, and verify provider
   read-back before displaying wallet provisioning.
4. Each bot receives a new Privy wallet. Its owner funds USDG and at least
   0.005 ETH gas, imports finalized funding evidence, reconciles, and explicitly
   activates it. Drift blocks only that bot and cannot halt house custody.

Do not set `FULL_MARKET_SCANNER_ENABLED=true`. The executable registry contains
only WETH and USDG; Stock Tokens and arbitrary contracts are intentionally
blocked.

## Smoke test after deploy

- `/api/healthz` returns ok
- ticker shows FEED LIVE, prices moving
- `systemctl status punklabz` clean; `journalctl -u punklabz -f` shows backfill lines
- kill -9 the process once; systemd recovers pending signed bytes, reconciles chain
  state, and reruns preflight before resuming; any failed or ambiguous check stays halted
