#!/bin/bash
set -euo pipefail
# Merge with the vendor configuration; the vendor entrypoint still owns JWT,
# WOPI and database settings. Persist neither tokens nor credentials in source.
install -d -o ds -g ds /var/www/onlyoffice/documentserver/.cache/pkg
JSON=/var/www/onlyoffice/documentserver/npm/json
"$JSON" -I -f /etc/onlyoffice/documentserver/local.json -e 'this.services=this.services||{};this.services.CoAuthoring=this.services.CoAuthoring||{};this.services.CoAuthoring.autoAssembly={enable:true,interval:"30s",step:"10s"}'
exec /app/ds/run-document-server.sh
