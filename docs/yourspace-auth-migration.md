# YourWiki → YourSpace identity

YourSpace is the authoritative sign-in service (user decision, 18 November 2026). YourWiki keeps its user IDs, document ownership, permission groups and ACLs. This supersedes local YS-01 password/Google sign-in in YourWiki when the integration is enabled.

The OIDC client uses authorization code + S256 PKCE, browser-bound one-use state, nonce and RS256 verification. Exact callback: `https://wiki.ageofsilence.net/api/auth/yourspace/callback`. Sessions carry explicit `(issuer, subject) → Wiki user ID` bindings. Never match accounts by email or username. Existing users retain their Wiki permissions regardless of central role claims. Wiki administrators must authenticate with MFA in YourSpace. Unknown identities do not receive automatic access.

Configuration: `YOURWIKI_YOURSPACE_ISSUER`, `YOURWIKI_YOURSPACE_CLIENT_ID`, `YOURWIKI_YOURSPACE_CLIENT_SECRET_FILE`. Mount the client secret read-only, owner-only permissions. Enabling SSO revokes old Wiki browser sessions; local login, registration and password reset endpoints return `YOURSPACE_ONLY`. Storage OAuth remains separate and unchanged. Profile/security edits go to YourSpace; Wiki appearance and document permissions stay local.

The companion patch `tools/release/yourspace-provider-refresh.patch` adds standard rotating refresh tokens to the deployed YourSpace baseline. Access tokens last 10 minutes; the Wiki session lasts at most 12 hours or its shorter configured lifetime. Refresh tokens are hashed centrally, encrypted in Wiki, bound to the central browser session and auth version, rotated on use. Central logout/deactivation revokes access at the next Wiki check (up to 60 seconds); service outages fail closed without revoking a valid Wiki session. An interrupted rotation persists only the next refresh capability before additional validation; it grants no access until signature, nonce, subject and userinfo checks succeed.

## Server migration

Use `tools/release/yourspace-migrate-server.ts` against **offline staging copies**, never the active databases. Set `YOURSPACE_MIGRATION_DIR` to a private directory containing `wiki.before.sqlite3` and `space.before.sqlite3`; `YOURSPACE_MIGRATION_SOURCE` points to patched YourSpace source. Supply the existing central data-key file through its normal secret configuration. Optional `mapping.json` contains explicitly approved Wiki-user-ID → existing-Space-ID links. It must never be inferred from names/emails.

The importer preserves compatible PBKDF2 hashes and verified personal Google bindings for newly imported users. Existing central credentials and MFA are not overwritten. Purged users are skipped, disabled users remain disabled. No known registration timestamp exists in the legacy Wiki schema: imported `created_at` remains NULL instead of inventing tenure. Unexpected TOTP formats or identity collisions stop migration. Import receipts make repeat imports idempotent. Google Drive storage credentials are not account-login credentials and are not moved.

Before cutover stop database writers and scheduled backup writers, keep private snapshots of both databases (including WAL if present), encryption keys and deployment configurations. The tool creates `*.staged.sqlite3`, checks both databases and fingerprints Wiki users, groups, ACL-bearing resources, versions, connections and settings. Install both validated staged databases while writers remain stopped. Mount patched source for **all** Wiki runtimes and both YourSpace runtimes so workers/backups understand the new schemas. Start central service before Wiki. If checks fail, restore both database snapshots and previous deployment configurations before resuming writers. Never restore only one half after users start writing again.

## Verification / Проверка

Run Wiki `tools/release/yourspace-login.test.ts` and `yourspace-account-migration.test.ts` (the latter uses the adjacent YourSpace repository). Apply the companion patch to the matching YourSpace baseline and run its OIDC tests plus the refresh regression. Check old-password API returns 403, public options advertise YourSpace, start redirects to the correct issuer/callback, and a real migrated account can sign in and retain groups/permissions. Admins enroll/confirm their own MFA. Test revoked/disabled account, logout, refresh, replay and unavailable provider. Check the login screen at 1440×900 and 390×844. Do not treat seeing the central login page alone as a completed authenticated end-to-end check.

## Production configuration / Настройка продакшена

- Keep the existing installation's `.env`. Use [the example](../.env.example) as a reference. For a fresh install the empty issuer leaves YourSpace disabled.
- Set `YOURWIKI_YOURSPACE_ISSUER` to the canonical YourSpace HTTPS origin, such as `https://space.example.com`, and `YOURWIKI_PUBLIC_URL` to the actual public YourWiki HTTPS origin. Use origins without a path, query, or fragment. YourSpace discovery must advertise the same issuer. The registered callback is the YourWiki origin plus `/api/auth/yourspace/callback`.
- The cutover creates `compose.yourspace-sso.yaml` and adds it to `COMPOSE_FILE`. That override supplies the client ID and mounts the client secret read-only. Keep the override and its release paths when updating. `install.sh` preserves existing additional Compose files and validates them before starting services. If an older override still has a literal issuer, check its value in the resolved configuration. Updating `.env` alone affects overrides that reference the variable.
- Both migration and runtime use the same issuer. Changing it on an already migrated deployment requires coordinating the provider and the stored account bindings. The cutover scripts are for the initial SSO migration. Use the normal deployment workflow for subsequent application updates.

Before deploying, run these read-only commands from the existing YourWiki installation directory:

```sh
docker compose config --quiet
docker compose config --format json | python3 -c '
import json, sys
env = json.load(sys.stdin)["services"]["web"].get("environment", {})
for key in ("YOURWIKI_PUBLIC_URL", "YOURWIKI_YOURSPACE_ISSUER", "YOURWIKI_YOURSPACE_CLIENT_ID", "YOURWIKI_YOURSPACE_CLIENT_SECRET_FILE"):
    print(f"{key}={env.get(key, "")}")
'
```

For an SSO deployment, confirm both origins, client ID `yourwiki`, and the container path `/run/secrets/yourspace_client`. Ensure the host secret file exists with mode `0400` and is readable by the web container's UID (10001 in the standard Compose file). After deployment, verify a real authorized sign-in and the existing user's groups and document access.
