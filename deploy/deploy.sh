#!/usr/bin/env bash
# Deploy PunkLabz Terminal to a VPS.
# Usage: ./deploy/deploy.sh root@1.2.3.4 [--dry-run]
# Rsyncs code (never data/ or .env), builds remotely, restarts the unit.
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [--dry-run]}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/punklabz

# --delete removes anything on the server that is not in this checkout, so
# every server-side directory MUST be excluded explicitly. `backups` is here
# because it was not, and a deploy deleted the database backup that had been
# taken minutes earlier to protect that very deploy. The migrations happened to
# succeed; had they not, the rollback had already been destroyed by the thing
# it was insuring against.
RSYNC_FLAGS=(-az --delete
  --exclude node_modules --exclude dist --exclude data
  --exclude .env --exclude .git --exclude .claude
  --exclude backups --exclude '*.bak' --exclude .DS_Store)
[[ "$DRY" == "--dry-run" ]] && RSYNC_FLAGS+=(--dry-run -v)

# Stamp the deployment with the exact revision being shipped, so
# GET /api/version can answer "which commit controls the money?" without
# anyone having to remember. A dirty tree is recorded as dirty rather than
# quietly presented as the commit it most resembles.
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
DIRTY=false
[[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]] && DIRTY=true
cat > "$ROOT/build-info.json" <<JSON
{
  "commit": "$COMMIT",
  "branch": "$BRANCH",
  "dirty": $DIRTY,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "builtBy": "$(whoami)@$(hostname -s)"
}
JSON
echo ">> shipping $BRANCH@$COMMIT (dirty=$DIRTY)"

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
