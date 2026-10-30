# Resumable uploads

Продолжение утверждённого rewrite; production не переключать.

- [x] Append-only migration for uploads/chunk receipts; private temporary chunk stores, durable offsets, owner isolation, expiry and quota reservation.
- [x] Refactor internal DocumentService prepared-blob commits so document revision/job and upload completion receipt commit atomically. No async DB transaction.
- [x] Upload service with streamed bounded chunks, offset checks, idempotent chunk replay, restart/resume, streamed assembly, conflict/ACL recheck and idempotent finish after lost ACK.
- [x] HTTP create/status/chunk/finish/cancel routes with session/CSRF, structured errors and limits.
- [x] RED→GREEN tests for interrupted chunk, resume/restart, duplicate finish/chunks, isolation/ACL/conflicts, quota/expiry/cleanup and HTTP workflow.
- [x] Full new-server tests/typecheck, review, ledger and commit.

Ruling: sequential offsets with immutable per-upload chunk receipts (default exactly 8 MiB except the final part). A failed chunk is resent; completed chunks survive restart. Temporary upload storage is separate from immutable published blobs so cancellation/expiry can safely remove it. Assembly streams once into the permanent store before an atomic metadata commit. Pending-upload quota reserves declared bytes, and must include operational free-disk monitoring before production rollout. This transport does not prove 4 GiB office viewing/editing.
