# TypeScript service plugins implementation

The user wants uploaded TypeScript files to integrate external services regardless of API popularity. Use trusted, giga-admin-only server modules with a stable manifest/configuration/action contract. Plugins implement their own HTTP requests using native fetch, including non-standard authentication. No service whitelist or new dependency installation. This is a trusted-code extension boundary, not an untrusted-code sandbox.

- [x] Append a migration for persisted source, encrypted configuration, enabled state, revision and sanitized execution status.
- [x] Add SDK types and a bounded worker runner; validate manifest, timeout, concurrency and output sizes; terminate on disconnect/shutdown.
- [x] Add giga-only authenticated routes with origin/CSRF checks, CAS updates, masked secrets, audit records and enable/disable/remove operations.
- [x] Add compact settings section with source upload, plugin list, configuration, action input, results, errors and downloadable example.
- [x] Test HTTP permissions/CSRF, persistence, encryption, lifecycle, arbitrary HTTP integration, errors and limits. Build/typecheck, inspect desktop/mobile screenshots, deploy with backup and readiness verification.
