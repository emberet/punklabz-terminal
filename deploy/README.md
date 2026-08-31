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
ADMIN_EMAILS=emberetme@gmail.com
DB_PATH=./data/punklabz.db
AUTO_APPROVE_CAP_USD=500
EPOCH_CRON=0 0 * * *
EOF
chown punklabz:punklabz /opt/punklabz/.env && chmod 600 /opt/punklabz/.env
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

## Smoke test after deploy

- `/api/healthz` returns ok
- ticker shows FEED LIVE, prices moving
- `systemctl status punklabz` clean; `journalctl -u punklabz -f` shows backfill lines
- kill -9 the process once; systemd restarts it; bots/positions unchanged (all state in SQLite)
