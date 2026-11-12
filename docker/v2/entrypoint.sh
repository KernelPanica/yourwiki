#!/bin/sh
set -eu
umask 077
root=${YOURWIKI_DATA:-/data}
case "${1:-web}" in
 web)
  : "${YOURWIKI_PUBLIC_URL:?Set YOURWIKI_PUBLIC_URL to the public origin}"
  exec flock --shared --no-fork "$root/release.lock" npm --prefix /app/apps/server run start -- "$root/workspace/database.sqlite3" "$root/workspace/storage" "$root/workspace/encryption.key" "$YOURWIKI_PUBLIC_URL" /app/apps/web/dist --port 3100 --host 0.0.0.0;;
 rclone)
  exec node /app/apps/server/src/rclone/manager-main.ts "$root/workspace" /opt/yourwiki-rclone-settings.json;;
 provider)
  exec flock --shared --no-fork "$root/release.lock" npm --prefix /app/apps/server run provider-worker -- "$root/workspace/database.sqlite3" "$root/workspace/storage" "$root/workspace/encryption.key";;
 conversion)
  exec flock --shared --no-fork "$root/release.lock" npm --prefix /app/apps/server run worker -- "$root/workspace/database.sqlite3" "$root/workspace/storage" --office-root /usr/lib/libreoffice;;
 setup|backup|restore|migrate)
  command=$1; shift
  exec node /app/apps/server/src/release/cli.ts "$command" "$root" "$@";;
 verify-backup)
  shift; exec node /app/apps/server/src/release/cli.ts verify-backup "$@";;
 *) echo 'Unknown release command' >&2; exit 1;;
esac
