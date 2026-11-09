# Isolated Google Drive mount benchmark

**Goal:** Build and measure an opt-in rclone/FUSE storage prototype without changing production storage.
**Architecture:** Disposable YourWiki fixture database reads encrypted connection configuration from the production database in read-only mode. A marked test folder outside the production mount is the only writable remote scope. Rclone receives a short-lived access token in a private temporary config, never the production refresh token. The current GoogleStoragePush and rclone mount use the same server/account, generated identical payload sizes and independent final Drive checksum verification.
**Tech:** TypeScript/Node24, rclone standalone binary, privately extracted fuse3 helper, Google Drive API.

- [x] Check FUSE and install verified standalone tools into a private test directory; no application service changes.
- [x] Implement opt-in test harness with bounded subprocess lifetime, safe result-only output, cleanup/unmount/private credential removal in finally.
- [x] Compare ordinary binary payloads (64KiB and 8MiB), 3 repetitions each, alternating methods. Measure local commit/close separately from remote checksum confirmation.
- [x] Measure cold/warm mount reads and external update detection using 2s Drive polling; record polling API overhead separately from mount upload.
- [x] Record rclone RSS/CPU and mount settings, preserve raw aggregate measurement JSON and a readable report.
- [x] Unmount, trash only the marked test folder, remove temporary credentials, verify production readiness. Document limitations: synthetic files, short test, no Google native document conversion/collaborative conflict parity claim.

Ruling: use ordinary random binary payloads at both sizes to keep MIME/entropy consistent; native Google document conversion remains outside this storage-path benchmark. No UI or production storage adapter was changed. See docs/benchmarks/2026-11-07-google-mount.md for results and limitations.
