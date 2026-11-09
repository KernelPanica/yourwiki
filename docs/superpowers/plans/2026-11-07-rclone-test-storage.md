# Persistent rclone test storage

User-approved scope: separate test folder on Google Drive, connected to the existing YourWiki as a local provider. Existing sources stay on their current connections. Mount starts from saved central Google authorization and is ready before web startup; authorization changes are observed automatically. DB/CAS/cache remain local.

- [x] Add optional required-rclone-mount guard to local source open/read/write and storage listing/create; prove unmapped directories are refused while ordinary local storage remains valid.
- [x] Add daemon and startup check: private rclone credentials from encrypted Google connection, persistent bounded VFS cache, automatic remount on OAuth context changes, systemd readiness after FUSE mount, safe unmount/secret cleanup. No arbitrary user paths/commands in HTTP routes.
- [x] Create one marked remote test folder, local folder/resource/provider in production via existing APIs/services; existing data untouched. Seed one clearly named Markdown original and bind through local storage.
- [x] Install dedicated systemd service and web/provider ordering drop-ins. Verify unit syntax, start mount, check startup gate and normal services.
- [x] Verify real local adapter read/replace and full Drive bytes, stale baseline rejection, folder listing/import in the app; browser inspect source UI desktop/mobile. Document URL, settings location and prototype limits (source listing/import/edit support; no claim of full folder lifecycle/new-file export integration).

Execution notes: browser opened login without a session, so authenticated visual QA was unavailable; application acceptance used actual DocumentService/provider/Drive checksum. Added test-only initial-export bridge to make new files created inside the test folder reach the mount. Existing working sources were not switched. See docs/rclone/test-storage.md for precise scope, test evidence and operational limitations.
