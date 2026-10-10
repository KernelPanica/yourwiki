# Read/write implementation plan

**Goal:** Implement the approved read/write design with personal provider grants and revocation, per the user-approved task2.md override.
**Spec:** ../specs/2026-10-06-read-write-design.md
**Execution:** Inline implementation explicitly requested by the user.

- [x] ACL core and safe migration: canonical read/write rules, write implies read, hidden old rules remain denied. Test all old flag combinations and inheritance.
- [x] Access boundaries: lists and paths use read; unreadable/missing objects have identical responses; API metadata updates administrator-only; provider access happens after authorization.
- [x] Creation and settings: automatic inheritance and group choice; unified settings include RW access; old policy URLs redirect to settings; server validation and accessible responsive controls.
- [x] API: create in a specified folder/mount, folder access management, inheritance/group policies, read/write binary files with revision checks, consistent validation.
- [x] Verification: targeted server and browser tests, provider contract checks, regression suite, migration checks, README/API/acceptance updates. No production deployment or live external grants during tests.

- [x] ProviderIdentity/ProviderGrant migrations, OAuth linking with state/PKCE and same-origin completion, encrypted client configuration.
- [x] Durable reconciliation after ACL/group/account changes, revocation receipts and retry UI/command, GitHub repository aggregation.
- [x] Personal Google/OneDrive permissions and GitHub collaborators; preserve private-storage guards for unmanaged sharing.
- [x] Expanded adapter/security regressions, responsive provider-account UI, final migration/build checks and documentation.

Verification completed 2026-10-07: 238 server tests passed, 1 opt-in environment test skipped; browser checks for RW creation/settings, workspace UI, and provider-account settings passed (320–1440 px; provider settings in en/ru/es). npm build, Django checks, migration drift check and git diff --check passed. Independent code review findings were reproduced with failing tests and corrected; follow-up review found no remaining important issues. No production migration/deployment or live provider requests were performed.
