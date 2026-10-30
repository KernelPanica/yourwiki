# Durable local save journal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve staged editor bytes across restart, and commit a local original exactly once even if the acknowledgement is lost. This is the local prerequisite for WOPI/provider sessions, not a replacement for their conflict checks or a claim of remote delivery.

**Architecture:** Immutable disk blobs contain payloads; append-only migration adds author-bound operation rows. Staging accepts an internal verified BlobRef, pins metadata across asynchronous verification, checks the exact base revision and fingerprint and retains conflicts/denials. Commit and durable receipt occur in the same SQLite transaction as document version/preview job creation. No provider IO inside a transaction. The existing resumable upload protocol remains intact.

**Files:** apps/server/src/save-journal.ts (staging, commit, status), schema.ts (append migration), test/save-journal.test.ts. No HTTP exposure until upload/WOPI adapters bind identity and reserve ingress quotas; do not expose a caller-supplied digest as authority to arbitrary stored bytes.

- [x] Write tests for stage/reopen/commit/replay, conflicting operation reuse, two writers, changed original fingerprint, ACL revoked after staging, changed metadata during verify and transaction rollback.
- [x] Run failing tests, then implement migration and SaveJournal with bounded per-author and global retained-payload reservations, exact base checks, author binding and no overwrite of an existing operation's recovery bytes.
- [x] Saved status distinguishes durable local commit from preview/provider delivery. Read status requires current read ACL and ownership; commit rechecks current write ACL unless it only returns a saved receipt. Staged payload is immutable; retry must reuse exact metadata or choose a new operation ID.
- [x] Verify targeted and full server suites, typecheck, whitespace; record evidence and commit. Follow-up HTTP/WOPI integration must retain existing warnings, shared editor locks and external-change protection.

Ruling: technical immutable document_versions remain independent of user-visible history. This journal does not implement the global history toggle, provider unknown-write reconciliation, rename/create or legacy journal import; those remain required roadmap work.


Verification: 13 journal tests pass, including real child-process SIGKILL after stage and after commit. Full server suite passed 135 tests with 0 skips, including native office conversion. A subsequent version-eight migration regression passed alongside all journal/database tests (21 total); server typecheck and whitespace checks pass. Old migration SQL is unchanged; new version is 9. No HTTP/WOPI consumer is enabled by this slice. Staging is internal and must not become a public arbitrary-blob lookup. Journal quotas cover retained operations, not future WOPI ingress staging; ingress must reserve its own bounded bytes before receiving network content.
