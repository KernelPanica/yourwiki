#!/bin/sh
# Local-only test deployment with a dedicated project, image and volumes.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p .runtime/onlyoffice-local
secret_file=.runtime/onlyoffice-local/compose.env
if [ ! -f "$secret_file" ]; then
  (umask 077; printf 'ONLYOFFICE_LOCAL_JWT_SECRET='; openssl rand -hex 32) > "$secret_file"
  chmod 600 "$secret_file"
fi
compose() { docker compose -p yourwiki-onlyoffice --env-file "$secret_file" -f compose.onlyoffice-local.yaml "$@"; }
case "${1:-up}" in
 up)
  compose build web
  compose run --rm --no-deps -v "$PWD/tools/release:/app/tools/release:ro" --entrypoint node web /app/tools/release/onlyoffice-local-bootstrap.mjs
  compose up -d --wait --wait-timeout 300
  printf '\nYourWiki: http://127.0.0.1:3010\nOnlyOffice: http://127.0.0.1:8082\nCredentials: ./tools/release/onlyoffice-local.sh credentials\n';;
 credentials) compose exec -T web cat /data/onlyoffice-local-credentials.json;;
 reader) compose run --rm --no-deps -v "$PWD/tools/release:/app/tools/release:ro" --entrypoint node web /app/tools/release/onlyoffice-local-reader.mjs;;
 reader-credentials) compose exec -T web cat /data/onlyoffice-reader-credentials.json;;
 check-reader) compose run --rm --no-deps -v "$PWD/tools/release:/app/tools/release:ro" --entrypoint node web /app/tools/release/check-onlyoffice-reader.mjs;;
 down) compose down;;
 status) compose ps;;
 logs) compose logs --tail=80;;
 *) echo 'Usage: onlyoffice-local.sh [up|down|status|logs|credentials|reader|reader-credentials|check-reader]' >&2; exit 2;;
esac
