# npm release infrastructure, 2026-11-03

Implementation status: infrastructure and fixture verification, **not final release acceptance**. No production database, key, provider original or Docker volume was opened or modified during this work.

## Primary startup

`Dockerfile` now builds the React application with npm and runs Node 24/Fastify. `compose.yaml` starts HTTP (`web`), durable provider jobs (`provider`), and one conversion process (`conversion`). Services share the v2 SQLite database, immutable store, key and local provider originals in the new `yourwiki_workspace` volume. Existing Django `yourwiki_database`, `yourwiki_secrets`, and `yourwiki_documents` volumes are never mounted by the primary Compose file.

Fresh install:

```sh
docker compose build
docker compose --profile setup up setup
# Open the token URL printed by setup; complete the Russian GUI.
# Stop setup with Ctrl-C before starting the application.
docker compose up -d web provider conversion
```

The GUI creates a private key, hashed Gigaadmin account, Members group and membership, a new v2 database and private store in a staged directory. Only a complete directory is renamed to `/data/workspace`. A pre-existing workspace, migration directory, unknown file, legacy database or key in `/data` blocks initialization; no auto-discovery or reinitialization occurs. The random setup URL token is required for reading and submitting setup. Requests with an unrelated browser Origin are rejected. Bind defaults to localhost; Compose exposes localhost port 3000. Set `YOURWIKI_PUBLIC_URL` to the real HTTPS origin before deployment; reverse proxy configuration remains deployment-specific.

The HTTP process supports explicit `--host 0.0.0.0`; default standalone behavior remains loopback. Collabora options flow from `COLLABORA_URL`, `COLLABORA_INTERNAL_URL`, `COLLABORA_WOPI_URL` into the configured application. Public HTTP editor URLs are allowed only for loopback. The optional `compose.collabora.yaml` remains available. Wiring Collabora does not itself prove editing is ready: the runtime's Office readiness and its save-path acceptance remain authoritative.

Each npm runtime holds a shared `/data/release.lock`; installer, importer, backup and restore require an exclusive nonblocking lock. Stop **all three** services before maintenance. Directly starting a worker without the container entrypoint bypasses this operational lock; standalone operators must provide the same flock wrapper.

## Backup and restore

Create the administrator-controlled host backup directory writable by container uid/gid 10001, or override the backup mount for your deployment. Backups contain plaintext private keys and private data and require private storage.

```sh
mkdir -p backups
# Provision backups/ ownership for uid/gid 10001 using your host administration tools.
docker compose stop web provider conversion
docker compose run --rm maintenance backup /backups/pre-update
docker compose run --rm maintenance verify-backup /backups/pre-update
docker compose up -d web provider conversion
```

A backup includes the consistent SQLite backup-API snapshot, all storage namespaces (including incomplete/recovery payloads), provider original copies, installation metadata, encryption key and preserved legacy archive. The standalone backup database uses DELETE journaling, so repeat verification does not create WAL sidecars. Every file has size and SHA-256 in a private manifest; canonical blob names are checked against their bytes. Database integrity, foreign keys, application marker and decryption of existing provider configurations are verified. Symlinks and special files are rejected. Destination must not exist. A complete backup becomes visible by one rename; partial failure cleans only its own staging directory.

Restore **to a new empty volume/data root**, retaining the old volume for investigation:

```sh
# Example volume name chosen explicitly by the operator.
docker volume create yourwiki_restored
# Use the same built image and private backup mount; container uid 10001 needs volume ownership.
docker run --rm --user 0 --entrypoint chown -v yourwiki_restored:/data yourwiki:npm-local 10001:10001 /data
docker run --rm -v yourwiki_restored:/data -v "$PWD/backups:/backups:ro" yourwiki:npm-local restore /backups/pre-update
```

Restore refuses any existing workspace or unexpected root contents. It verifies all source checksums before copying, checks each copied file again, validates database/key compatibility, and only then promotes the new workspace. It never overwrites the current writer or changes external cloud originals. Configure the deployment's workspace volume to the restored volume before starting services. Rollback after new writes needs a reviewed data-delta strategy or restoration of a known snapshot; checking out old Git files alone is insufficient.

## Git updates

`tools/release/update.sh [signed-ref] [backup-name]` refuses a dirty checkout or non-fast-forward target, fetches and verifies the target commit signature, tests/builds a detached worktree, builds its image, stops all writers, makes a private backup, then fast-forwards and starts the verified image. It requires a configured Git signature trust policy. Unsigned commits are refused. A failed post-update readiness check stops the new services and retains the backup; automatic data rollback is deliberately not attempted. Verify deployment-specific settings and signed-release provenance before using it.

## Evidence and remaining acceptance

Verified locally against disposable data:

- Guarded GUI initialization, one active Gigaadmin with a real password verifier and group membership.
- Complete backup → repeat checksum verification → restore of database, immutable originals and exact key; changed backup refused.
- Cross-origin/missing-token installer requests refused; duplicate setup refused.
- Exclusive maintenance refused while a process holds the shared runtime flock.
- Real Fastify HTTP binding on `0.0.0.0`, `/ready/`, built React HTML, login cookie, graceful close, backup and restore (`node tools/release/smoke.ts`).
- `docker compose config --quiet` for the primary file and explicit legacy fallback.

**Actual Docker build/run could not be executed in this environment.** `docker info --format '{{.ServerVersion}}'` returns Docker socket permission denied both normally and with tool escalation. `sudo -n docker info` is unavailable because no-new-privileges prevents elevation. This is an operating-system access failure, not an automatic approval-review rejection. Node integration tests exercise runtime behavior, not the container image.

Docker acceptance still requires building the image, testing container setup/permissions/restart, provider worker lifecycle and real Collabora with WOPI callbacks. The conversion sandbox requires host user namespaces/bubblewrap support; actual office conversion inside this Docker configuration remains unverified. The Node image tag is a maintained major tag; pin a verified image digest when producing a distributable release. Fonts activation/serving, all migration blockers, full functional parity and the 2 CPU/4 GB/10–15 user device acceptance are separate release gates.

Legacy fallback is explicit: `docker compose -f compose.legacy.yaml up -d --build web`. It uses `docker/legacy.Dockerfile` and requires the existing legacy volumes via their names; missing volumes fail closed. Override `YOURWIKI_LEGACY_*_VOLUME` only to select known legacy volumes. Never run legacy and v2 writers against the same external provider originals during cutover.
