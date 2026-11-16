# Gates: завершение восстановления YourWiki rclone

OWNS: GATES.md, apps/server/src/worker/office.ts, compose.yaml

Scope: восстановить YourWiki на wiki с исправленным rclone, подтвердить полную синхронизацию Drive, регрессионные проверки и непрерывную работу Taiga.

- [x] G0: критерии завершения имеют исполняемые и проверяемые oracle
  CHECK: node /home/kernelpanica/.kimi-code/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=cc6682e78a1ec68ee1a3c31a5096132c26da3f5c895a76ac6d925bf618b37b09; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G1: локальные исправления rclone и установщика проходят регрессионные проверки
  CHECK: bash -n install.sh && node --test tools/release/test-rclone-drive-names.mjs tools/release/test-rclone-container-permissions.mjs tools/release/test-installer.mjs && printf 'RCLONE_REGRESSIONS_OK\n'
  EXPECT: RCLONE_REGRESSIONS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=07d87b17c6167782616b895f7d12ad33b0093be52250e146f3a72e0501f682d2; exit=0; EXPECT=matched; output-sha256=bdfecd86071c30c98fc6fb1c8ef765ce97356fcf3a91f1875a83d3d8c0d2736c; output-bytes=2461; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G2: YourWiki запущен, isolated shared mount активен и число mount-записей ограничено
  CHECK: ssh wiki 'set -eu; cd /home/yourwiki; test "$(findmnt -rn -o PROPAGATION -T /var/lib/yourwiki/rclone)" = shared; systemctl is-enabled --quiet yourwiki-rclone-shared.service; for service in rclone web provider conversion collabora; do docker compose ps --status running --services | grep -qx "$service"; done; test "$(docker inspect -f "{{.State.Health.Status}}" yourwiki-rclone-1)" = healthy; test "$(docker inspect -f "{{.State.Health.Status}}" yourwiki-web-1)" = healthy; docker compose exec -T web node -e "fetch(\"http://127.0.0.1:3100/ready/\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; test "$(findmnt -rn -o TARGET | grep -c "^/var/lib/yourwiki/rclone")" -lt 100; printf "YOURWIKI_RUNTIME_OK\n"'
  EXPECT: YOURWIKI_RUNTIME_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=a7db035dd9c303640f7419d4296e83a6eebe9db97a6bd5e6bd96a2d757ddcb6c; exit=0; EXPECT=matched; output-sha256=f816d1daa79d59df3a46b9521d4b06dcc9dd618e3dec1b68d0a80ebb1c891f28; output-bytes=20; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G3: актуальный полный каталог Drive совпадает с индексом и активный worker импортирует документы
  CHECK: ssh wiki 'cd /home/yourwiki && docker compose exec -T provider node --input-type=module -e "import Sqlite from \"/app/apps/server/node_modules/better-sqlite3/lib/index.js\";import {RcloneClient} from \"/app/apps/server/src/rclone/client.ts\";const db=new Sqlite(\"/data/workspace/database.sqlite3\",{readonly:true});try{const m=db.prepare(\"SELECT m.connection_id,m.binary_path,m.config_path,m.mount_path,m.staging_path FROM rclone_drive_mounts m JOIN provider_connections c ON c.id=m.connection_id WHERE c.enabled=1 ORDER BY m.rowid LIMIT 1\").get();if(!m)throw Error(\"no active mount\");const client=new RcloneClient({binary:m.binary_path,config:m.config_path,mount:m.mount_path,staging:m.staging_path});const entries=await client.list({check(){}});const stored=db.prepare(\"SELECT COUNT(*) AS n FROM rclone_drive_entries WHERE connection_id=?\").get(m.connection_id).n,bindings=db.prepare(\"SELECT COUNT(*) AS n FROM provider_source_bindings WHERE connection_id=?\").get(m.connection_id).n,worker=db.prepare(\"SELECT 1 FROM worker_slots WHERE name=? AND lease_until>?\").get(\"provider-source\",Date.now());if(!entries.length||stored!==entries.length)throw Error(\"catalogue mismatch\");if(!worker||!bindings)throw Error(\"import is not progressing\");console.log(\"DRIVE_SYNC_OK entries=\"+entries.length+\" bindings=\"+bindings);}finally{db.close();}"'
  EXPECT: DRIVE_SYNC_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=38039bd162caa3bfcc3c9b7f64c5d597f4ccd6c2691c96e012925badbe8c6124; exit=0; EXPECT=matched; output-sha256=ea339a38177d3b72e642511ce2fef93518e737b7b2654d9d9085c57a10df054f; output-bytes=107; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G4: контейнеры Taiga продолжают работать, база данных healthy
  CHECK: ssh wiki 'set -eu; for name in taiga-docker-taiga-gateway-1 taiga-docker-taiga-async-1 taiga-docker-taiga-back-1 taiga-docker-taiga-events-1 taiga-docker-taiga-front-1 taiga-docker-taiga-events-rabbitmq-1 taiga-docker-taiga-async-rabbitmq-1 taiga-docker-taiga-protected-1; do test "$(docker inspect -f "{{.State.Running}}" "$name")" = true; done; test "$(docker inspect -f "{{.State.Health.Status}}" taiga-docker-taiga-db-1)" = healthy; printf "TAIGA_UNAFFECTED_OK\n"'
  EXPECT: TAIGA_UNAFFECTED_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=a409d22fa8a780e57c70049804fff4cca8e59be0b8bd3c948b6403e11e7a8b1a; exit=0; EXPECT=matched; output-sha256=325903e9b31989081b7781ba7439f32ca67d69e434dc948db831aa2b2ba285e4; output-bytes=20; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G5: реальный DOCX конвертируется в изолированном контейнере на wiki
  CHECK: ssh wiki 'cd /home/yourwiki && docker run --rm --network none --read-only --tmpfs /tmp:mode=1777 --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --security-opt seccomp=/home/yourwiki/docker/v2/seccomp-sandbox.json --security-opt apparmor=unconfined -e YOURWIKI_TEST_OFFICE_ROOT=/usr/lib/libreoffice -v /tmp/yourwiki-office-test/apps/server/test:/app/apps/server/test:ro --entrypoint node yourwiki:npm-local --test --test-name-pattern="real DOCX" /app/apps/server/test/office-preview.test.ts && printf "OFFICE_CONTAINER_OK\n"'
  EXPECT: OFFICE_CONTAINER_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=723f284ed63b300075ed26d59047147260099a1b8925d4314297f84f9e3f78fa; exit=0; EXPECT=matched; output-sha256=0220c4e5eb625a10cefb8cd57db541b1aa9c5d309a5d66519fc2102790ea40db; output-bytes=208; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G6: все десять Google Docs из папки «Инструкции» опубликованы и возвращаются библиотекой
  CHECK: ssh wiki 'cd /home/yourwiki && docker compose exec -T provider node --input-type=module -e "import Sqlite from \"/app/apps/server/node_modules/better-sqlite3/lib/index.js\";import {Administration} from \"/app/apps/server/src/administration/service.ts\";const db=new Sqlite(\"/data/workspace/database.sqlite3\",{readonly:true});try{const folder=\"61129ebc-75f5-4889-a0a0-7732566b0d90\",owner=db.prepare(\"SELECT owner_id FROM resources WHERE id=?\").get(folder).owner_id,docs=db.prepare(\"SELECT d.id,d.published_revision FROM documents d WHERE d.id IN (SELECT b.document_id FROM provider_source_bindings b JOIN rclone_drive_entries e ON e.connection_id=b.connection_id AND e.reference=b.reference WHERE e.path LIKE \x271. General/Инструкции/%\x27)\").all(),page=new Administration(db).library(owner,folder),visible=new Set(page.items.map(item=>item.id));if(docs.length!==10||docs.some(doc=>!doc.published_revision||!visible.has(doc.id)))throw Error(\"Google Docs are not visible\");console.log(\"GOOGLE_DOCS_VISIBLE_OK count=\"+docs.length);}finally{db.close();}"'
  EXPECT: GOOGLE_DOCS_VISIBLE_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b73a373a4e4fabc11c124d282fee98c6a8988647bd89d8aedf7f1bb7292aa04e; exit=0; EXPECT=matched; output-sha256=4293550524be263a03b3954f59317187d3be5926e912edb157e282966f6365c4; output-bytes=32; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries

- [x] G7: серверные тесты, TypeScript и сборка проходят после исправления sandbox
  CHECK: npm --prefix apps/server test && npm --prefix apps/server run typecheck && npm run build && printf 'SANDBOX_REGRESSIONS_OK\n'
  EXPECT: SANDBOX_REGRESSIONS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=73a4b823ba5af62848cdebb5964f9422414cc26b65268c01bcf26a6956c15d1a; exit=0; EXPECT=matched; output-sha256=165907bc287e89d5be9ee195ca2a31d46cdfe95f3b4c0b5787effc8f1d322b37; output-bytes=194519; shell=/bin/sh; cwd=/home/kernelpanica/Projects/yourwiki; path=228633e1ec56/18 entries
