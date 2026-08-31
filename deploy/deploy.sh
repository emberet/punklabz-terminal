#!/usr/bin/env bash
# Deploy PunkLabz Terminal to a VPS.
# Usage: ./deploy/deploy.sh root@1.2.3.4 [--dry-run]
# Rsyncs code (never data/ or .env), builds remotely, restarts the unit.
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [--dry-run]}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/punklabz

RSYNC_FLAGS=(-az --delete
  --exclude node_modules --exclude dist --exclude data
  --exclude .env --exclude .git --exclude .claude)
[[ "$DRY" == "--dry-run" ]] && RSYNC_FLAGS+=(--dry-run -v)

echo ">> rsync -> $HOST:$DEST"
rsync "${RSYNC_FLAGS[@]}" "$ROOT/" "$HOST:$DEST/"

[[ "$DRY" == "--dry-run" ]] && { echo ">> dry run complete"; exit 0; }

echo ">> remote build + restart"
ssh "$HOST" "set -e
  cd $DEST
  npm install
  npm run build
  chown -R punklabz:punklabz $DEST
  systemctl restart punklabz
  sleep 2
  systemctl is-active punklabz
  curl -sf localhost:4700/api/healthz && echo ' healthz OK'"
echo ">> deployed"
