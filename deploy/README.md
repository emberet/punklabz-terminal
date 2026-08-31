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
ANTHROPIC_API_KEY=<real key — builder agent + manager narration>
FEED_MODE=binance
PUMP_FEED_ENABLED=true
ADMIN_WALLET=<human operator wallet; never the trading wallet>
DB_PATH=./data/punklabz.db
AUTO_APPROVE_CAP_USD=500
EPOCH_CRON=0 0 * * *
PAYOUTS_ENABLED=false
SIGNER_PROVIDER=privy
PRIVY_APP_ID=<privy app id>
PRIVY_APP_SECRET=<secret>
PRIVY_WALLET_ID=<dedicated trader wallet id>
PRIVY_POLICY_IDS=<reviewed policy ids, comma-separated>
TRADING_WALLET_ADDRESS=<dedicated trader wallet public address>
SIGNER_ALLOWED_TARGETS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,0x0000000000001fF3684f28c67538d4D072C22734
SIGNER_MAX_NATIVE_ETH=0
ZEROX_API_KEY=<0x key>
RPC_ROBINHOOD_PRIMARY=<chain 4663 private RPC>
RPC_ROBINHOOD_SECONDARY=<independent chain 4663 RPC>
OPERATOR_ALERT_WEBHOOK_URL=<private incident webhook>
ROBINHOOD_TRACE_API_URL=https://robinscan.io/api
EOF
chown punklabz:punklabz /opt/punklabz/.env && chmod 600 /opt/punklabz/.env
```

Install the Privy P-256 authorization key as a root-owned systemd credential,
not in `.env`:

```bash
install -d -m 700 /etc/punklabz
install -m 600 /path/to/privy-authorization-key /etc/punklabz/privy-authorization-key
```

**Day-one check:** `curl -s https://api.binance.com/api/v3/ping` from the box.
If it returns HTTP 451 (geoblocked range), set `FEED_MODE=coinbase`.

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

## Mainnet arming

Migration `016_mainnet_safety.sql` always returns execution to halted shadow at stage `$0`.
After deployment, use the wallet-authenticated Control Room to:

1. Import each historical USDG and ETH funding transaction by hash.
2. Run reconciliation and persisted preflight.
3. Observe at least 24 hours of clean shadow operation.
4. Arm `canary` stage 1 by typing `ARM ROBINHOOD 4663 $5`.
5. Run one idempotent `$0.50` operator buy and sell; these never count toward promotion.
6. Assign each autonomous bot a USDG allocation no larger than authorized capital.
7. Wait for 10 reconciled autonomous fills at each stage before promotion.

Do not switch to `live` until stage 4 is fully funded and has 10 clean, non-forced fills.

## Smoke test after deploy

- `/api/healthz` returns ok
- ticker shows FEED LIVE, prices moving
- `systemctl status punklabz` clean; `journalctl -u punklabz -f` shows backfill lines
- kill -9 the process once; systemd recovers pending signed bytes, reconciles chain
  state, and reruns preflight before resuming; any failed or ambiguous check stays halted
