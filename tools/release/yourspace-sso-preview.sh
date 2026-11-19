set -eu
release=${YOURWIKI_SSO_RELEASE_DIR:-/opt/yourwiki-releases/yourspace-sso-20261118}
# Use the same Compose interpolation as the runtime, without sourcing .env as shell.
compose_env=$(cd /home/yourwiki && docker compose config --environment)
issuer=$(printf '%s\n' "$compose_env" | sed -n 's/^YOURWIKI_YOURSPACE_ISSUER=//p')
wiki_origin=$(printf '%s\n' "$compose_env" | sed -n 's/^YOURWIKI_PUBLIC_URL=//p')
unset compose_env
: "${issuer:?Set YOURWIKI_YOURSPACE_ISSUER in /home/yourwiki/.env}"
: "${wiki_origin:?Set YOURWIKI_PUBLIC_URL in /home/yourwiki/.env}"
preview=/root/yourspace-sso-preview-20261118
install -d -m 700 "$preview"
space_image=$(docker inspect yourspace-yourspace-1 --format '{{.Config.Image}}')
docker run --rm --network none --user 0:0 --entrypoint node -v yourwiki_workspace:/wiki:ro -v yourspace_data:/space:ro -v "$preview":/migration "$space_image" --input-type=module -e '
import D from "better-sqlite3";
for(const [from,to] of [["/wiki/workspace/database.sqlite3","wiki"],["/space/yourspace.sqlite3","space"]]){const db=new D(from,{readonly:true,fileMustExist:true});await db.backup("/migration/"+to+".before.sqlite3");db.close();}
console.log("CONSISTENT_PREVIEW_SNAPSHOTS_CREATED");'
docker run --rm --network none --user 0:0 --entrypoint node -e YOURWIKI_YOURSPACE_ISSUER="$issuer" -e YOURWIKI_PUBLIC_URL="$wiki_origin" -e YOURSPACE_MIGRATION_DIR=/migration -e YOURSPACE_MIGRATION_SOURCE=/app/src -e YOURSPACE_DATA_KEY_FILE=/run/secrets/data_key -v "$preview":/migration -v "$release":/app/wiki:ro -v "$release/space-src":/app/src:ro -v /opt/yourspace/secrets/data.key:/run/secrets/data_key:ro "$space_image" /app/wiki/tools/release/yourspace-migrate-server.ts
