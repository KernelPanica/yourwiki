#!/bin/bash
set -euo pipefail
# Merge with the vendor configuration; the vendor entrypoint still owns JWT,
# WOPI and database settings. Persist neither tokens nor credentials in source.
if [ -n "${ONLYOFFICE_JWT_SECRET_FILE:-}" ]; then
  export JWT_SECRET="$(cat "$ONLYOFFICE_JWT_SECRET_FILE")"
  [ "${#JWT_SECRET}" -ge 32 ] || { echo "OnlyOffice JWT secret must contain at least 32 characters" >&2; exit 1; }
fi
install -d -o ds -g ds /var/www/onlyoffice/documentserver/.cache/pkg
# ONLYOFFICE 10 requires an explicit WOPI destination rule. Match the Compose
# hostname, not a dynamic container IP; retain the vendor egress checks.
JSON=/var/www/onlyoffice/documentserver/npm/json
"$JSON" -I -f /etc/onlyoffice/documentserver/local.json -e 'this.services=this.services||{};this.services.CoAuthoring=this.services.CoAuthoring||{};this.services.CoAuthoring.autoAssembly={enable:true,interval:"30s",step:"10s"};this.services.CoAuthoring.ipfilter=this.services.CoAuthoring.ipfilter||{};this.services.CoAuthoring.ipfilter.rules=[{address:"web",allowed:true}]'
exec /app/ds/run-document-server.sh
