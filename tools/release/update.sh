#!/bin/sh
# Run from a clean checkout. Verification/build precede changing the checkout or restarting services.
set -eu
umask 077
ref=${1:-origin/main}
backup_name=${2:-pre-update}
case "$backup_name" in ''|*[!A-Za-z0-9_.-]*) echo 'Invalid backup name' >&2; exit 1;; esac
if [ -n "$(git status --porcelain)" ]; then echo 'Update refused: checkout has local changes.' >&2; exit 1; fi
old=$(git rev-parse HEAD)
git fetch --prune origin
target=$(git rev-parse --verify --end-of-options "$ref^{commit}")
git merge-base --is-ancestor "$old" "$target" || { echo 'Update refused: target is not a fast-forward.' >&2; exit 1; }
# Never execute an unverified remote checkout. Require an authenticated signed commit.
git -c gpg.minTrustLevel=fully verify-commit "$target"
work=$(mktemp -d "${TMPDIR:-/tmp}/yourwiki-update.XXXXXX")
cleanup() { git worktree remove --force "$work" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
git worktree add --detach "$work" "$target"
(cd "$work" && npm ci --ignore-scripts && npm --prefix apps/server ci && npm --prefix apps/web ci --ignore-scripts && npm --prefix apps/server test && npm --prefix apps/server run typecheck && npm --prefix apps/web test && npm --prefix apps/web run typecheck && npm --prefix apps/web run build)
docker build -t "yourwiki:verified-$target" "$work"
docker compose stop web provider conversion
# Exclusive release lock makes an accidental second runtime/backup fail closed.
docker compose run --rm maintenance backup "/backups/$backup_name"
git merge --ff-only "$target"
# Compose builds from exactly the tested commit. Keep the old backup and old image for explicit restore.
docker tag "yourwiki:verified-$target" yourwiki:npm-local
docker compose up -d --no-build web provider conversion
ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
 if docker compose exec -T web node -e "fetch('http://127.0.0.1:3100/ready/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then ready=1; break; fi
 attempt=$((attempt+1))
 sleep 2
done
if [ "$ready" -ne 1 ]; then
 echo 'Updated runtime failed readiness. Services must remain stopped for restore from the verified backup; see release guide.' >&2
 docker compose stop web provider conversion
 exit 1
fi
printf 'Updated to %s. Previous commit %s. Backup: %s\n' "$target" "$old" "$backup_name"
