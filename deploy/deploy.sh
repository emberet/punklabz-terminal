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
if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then
  echo "refusing deployment: working tree is dirty; commit and review the exact release first" >&2
  exit 1
fi

COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
DIRTY=false
ARTIFACT_CHECKSUM="$(git -C "$ROOT" archive HEAD | shasum -a 256 | awk '{print $1}')"
cat > "$ROOT/build-info.json" <<JSON
{
  "commit": "$COMMIT",
  "branch": "$BRANCH",
  "dirty": $DIRTY,
  "artifactChecksum": "$ARTIFACT_CHECKSUM",
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
  npm ci
  npm run build
  mkdir -p backups data
  if [ -f data/punklabz.db ]; then
    BACKUP=backups/punklabz-\$(date -u +%Y%m%dT%H%M%SZ).db
    node -e \"const D=require('better-sqlite3'); const d=new D('data/punklabz.db'); d.backup(process.argv[1]).then(()=>d.close())\" \"\$BACKUP\"
    cp \"\$BACKUP\" /tmp/punklabz-migration-check.db
    DB_PATH=/tmp/punklabz-migration-check.db node --input-type=module -e \"import {openDb} from './server/dist/db/db.js'; const d=openDb(process.env.DB_PATH); const r=d.pragma('integrity_check',{simple:true}); if(r!=='ok') throw new Error(String(r)); d.close()\"
    rm -f /tmp/punklabz-migration-check.db
  fi
  install -m 644 deploy/punklabz.service /etc/systemd/system/punklabz.service
  systemctl daemon-reload
  chown -R punklabz:punklabz $DEST
  systemctl restart punklabz
  sleep 2
  systemctl is-active punklabz
  curl -sf localhost:4700/api/healthz && echo ' healthz OK'"
echo ">> deployed"
