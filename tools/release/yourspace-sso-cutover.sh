set -euo pipefail
release=${YOURWIKI_SSO_RELEASE_DIR:-/opt/yourwiki-releases/yourspace-sso-20261118}
# Use the same Compose interpolation as the runtime, without sourcing .env as shell.
compose_env=$(cd /home/yourwiki && docker compose config --environment)
issuer=$(printf '%s\n' "$compose_env" | sed -n 's/^YOURWIKI_YOURSPACE_ISSUER=//p')
wiki_origin=$(printf '%s\n' "$compose_env" | sed -n 's/^YOURWIKI_PUBLIC_URL=//p')
unset compose_env
: "${issuer:?Set YOURWIKI_YOURSPACE_ISSUER in /home/yourwiki/.env}"
: "${wiki_origin:?Set YOURWIKI_PUBLIC_URL in /home/yourwiki/.env}"
chmod 755 "$release/apps/web/dist"
backup=/root/yourspace-sso-backup-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$backup"
space_image=$(docker inspect yourspace-yourspace-1 --format '{{.Config.Image}}')
issuer=$(docker run --rm --network none --entrypoint node -e YOURWIKI_YOURSPACE_ISSUER="$issuer" -e YOURWIKI_PUBLIC_URL="$wiki_origin" -v "$release":/app/wiki:ro "$space_image" --input-type=module -e '
import {issuerOrigin} from "/app/wiki/apps/server/src/auth/yourspace-oidc.ts";
issuerOrigin(process.env.YOURWIKI_PUBLIC_URL);
console.log(issuerOrigin(process.env.YOURWIKI_YOURSPACE_ISSUER));')
wiki_data=/var/lib/docker/volumes/yourwiki_workspace/_data/workspace
space_data=/var/lib/docker/volumes/yourspace_data/_data
cp -a /home/yourwiki/.env "$backup/wiki.env"
cp -a /opt/yourspace/.env "$backup/space.env"
cp -a /opt/yourspace/compose.yaml "$backup/space.compose.yaml"
cp -a "$wiki_data/encryption.key" "$backup/wiki.encryption.key"
cp -a /opt/yourspace/secrets/data.key "$backup/space.data.key"
cp -a /opt/yourspace/secrets/backup.key "$backup/space.backup.key"
# Every database writer stops before the final snapshots; Office's document service is retained.
docker stop -t 45 yourwiki-web-1 yourwiki-provider-1 yourwiki-conversion-1 yourwiki-rclone-1 yourspace-yourspace-1 yourspace-backup-1 >/dev/null
resume_old(){ docker start yourspace-yourspace-1 yourspace-backup-1 yourwiki-rclone-1 yourwiki-web-1 yourwiki-provider-1 yourwiki-conversion-1 >/dev/null; }
trap 'resume_old' ERR
cp -a "$wiki_data/database.sqlite3" "$backup/wiki.raw.sqlite3"
cp -a "$space_data/yourspace.sqlite3" "$backup/space.raw.sqlite3"
for suffix in -wal -shm; do
 if test -f "$wiki_data/database.sqlite3$suffix"; then cp -a "$wiki_data/database.sqlite3$suffix" "$backup/wiki.raw.sqlite3$suffix"; fi
 if test -f "$space_data/yourspace.sqlite3$suffix"; then cp -a "$space_data/yourspace.sqlite3$suffix" "$backup/space.raw.sqlite3$suffix"; fi
done
docker run --rm --network none --user 0:0 --entrypoint node -v yourwiki_workspace:/wiki:ro -v yourspace_data:/space:ro -v "$backup":/migration "$space_image" --input-type=module -e '
import D from "better-sqlite3";
for(const [from,to] of [["/migration/wiki.raw.sqlite3","wiki"],["/migration/space.raw.sqlite3","space"]]){const d=new D(from,{fileMustExist:true});await d.backup("/migration/"+to+".before.sqlite3");d.close();}
console.log("FINAL_SNAPSHOTS_CREATED");'
docker run --rm --network none --user 0:0 --entrypoint node -e YOURWIKI_YOURSPACE_ISSUER="$issuer" -e YOURWIKI_PUBLIC_URL="$wiki_origin" -e YOURSPACE_MIGRATION_DIR=/migration -e YOURSPACE_MIGRATION_SOURCE=/app/src -e YOURSPACE_DATA_KEY_FILE=/run/secrets/data_key -v "$backup":/migration -v "$release":/app/wiki:ro -v "$release/space-src":/app/src:ro -v /opt/yourspace/secrets/data.key:/run/secrets/data_key:ro "$space_image" /app/wiki/tools/release/yourspace-migrate-server.ts
cat > /home/yourwiki/compose.yourspace-sso.yaml <<YAML
services:
  web:
    environment:
      YOURWIKI_YOURSPACE_ISSUER: "\${YOURWIKI_YOURSPACE_ISSUER:?Set YOURWIKI_YOURSPACE_ISSUER in .env}"
      YOURWIKI_YOURSPACE_CLIENT_ID: yourwiki
      YOURWIKI_YOURSPACE_CLIENT_SECRET_FILE: /run/secrets/yourspace_client
    volumes:
      - $release/apps/server/src:/app/apps/server/src:ro
      - $release/apps/web/dist:/app/apps/web/dist:ro
      - /etc/yourwiki/yourspace-client.secret:/run/secrets/yourspace_client:ro
  provider:
    volumes:
      - $release/apps/server/src:/app/apps/server/src:ro
  conversion:
    volumes:
      - $release/apps/server/src:/app/apps/server/src:ro
  rclone:
    volumes:
      - $release/apps/server/src:/app/apps/server/src:ro
YAML
cat > /opt/yourspace/compose.yourwiki-sso.yaml <<YAML
services:
  yourspace:
    volumes:
      - $release/space-src:/app/src:ro
  backup:
    volumes:
      - $release/space-src:/app/src:ro
YAML
python3 - <<'PY'
from pathlib import Path
for path,base,extra in [('/home/yourwiki/.env',None,'/home/yourwiki/compose.yourspace-sso.yaml'),('/opt/yourspace/.env','/opt/yourspace/compose.yaml','/opt/yourspace/compose.yourwiki-sso.yaml')]:
 p=Path(path);lines=p.read_text().splitlines();found=False
 for i,line in enumerate(lines):
  if line.startswith('COMPOSE_FILE='):
   current=line.split('=',1)[1].strip('\"\'');parts=current.split(':')
   if extra not in parts:parts.append(extra)
   lines[i]='COMPOSE_FILE='+':'.join(parts);found=True
 if not found:
  if base is None:raise RuntimeError('Existing Wiki Compose path required')
  lines.append('COMPOSE_FILE='+base+':'+extra)
 p.write_text('\n'.join(lines)+'\n');p.chmod(0o600)
PY
install -d -m 755 /etc/yourwiki
install -m 400 -o 10001 -g 10001 "$backup/client.secret" /etc/yourwiki/yourspace-client.secret
# Checkpointed staged files are installed as a pair while all writers remain stopped.
# Keep old WAL/SHM alongside the paired backups instead of attaching them to new databases.
for suffix in -wal -shm; do
 if test -e "$wiki_data/database.sqlite3$suffix"; then mv "$wiki_data/database.sqlite3$suffix" "$backup/wiki.live$suffix"; fi
 if test -e "$space_data/yourspace.sqlite3$suffix"; then mv "$space_data/yourspace.sqlite3$suffix" "$backup/space.live$suffix"; fi
done
install -m 600 -o 10001 -g 10001 "$backup/wiki.staged.sqlite3" "$wiki_data/database.sqlite3"
install -m 600 -o 10002 -g 10002 "$backup/space.staged.sqlite3" "$space_data/yourspace.sqlite3"
trap - ERR
printf '%s\n' "$backup" > /root/yourspace-sso-latest-backup
cd /opt/yourspace
docker compose up -d --no-deps yourspace backup
cd /home/yourwiki
docker compose up -d --no-deps rclone web provider conversion
printf 'CUTOVER_INSTALLED backup=%s\n' "$backup"
