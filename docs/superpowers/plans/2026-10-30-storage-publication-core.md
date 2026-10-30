# Streaming storage, jobs and publication core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Продолжение утверждённой архитектуры; production не переключать.

**Goal:** Хранить большие оригиналы потоком, восстанавливать фоновые задания и публиковать только согласованную готовую ревизию.
**Architecture:** Immutable content-addressed private blobs на диске; короткие SQLite-транзакции для revisions/jobs/manifests/events. Claims имеют lease token; старый worker не может подтвердить или опубликовать результат после потери lease.
**Tech Stack:** TypeScript, node:fs/crypto/streams, SQLite/better-sqlite3, node:test.
**Spec:** ../specs/2026-10-30-yourwiki-rewrite-design.md.

## Global Constraints

- Нет Buffer целого исходника в API хранения; лимит байтов применяется до записи очередного chunk.
- Fsync blob и каталогов до подтверждения local revision. Сбой оставляет максимум непривязанный immutable blob, не ложное подтверждение.
- Никакого cloud IO или конвертации внутри DB transaction.
- Права и base revision проверяются до потока и после его приёма.
- Предыдущий published pointer остаётся при update/failed conversion. Новый документ не виден читателям до publication.
- Queue redelivery не означает разрешение слепо повторять provider write. Expired lease помечается reclaimed; будущие provider handlers обязаны сначала reconcile.

## Review Focus

- Обрыв/abort/лимит не оставляют завершённый blob или pending DB revision.
- Дедупликация не принимает повреждённый старый blob за валидный.
- Expired/stale worker не завершает или публикует чужой claim.
- ACL/revision, изменившиеся во время загрузки, не приводят к перезаписи; принятые байты сохраняются как recovery.
- Несовпадение source/manifest/artifacts и устаревший converter не сдвигают published pointer.

## Task 1: BlobStore

Files: src/storage/blobs.ts; test/blobs.test.ts.
Interface: BlobStore.open(root); put(async iterable,{maxBytes,signal})->{digest,size}; read(digest,{start,end}?)->Readable; stat(digest); verify({digest,size}).
- [x] Tests streaming SHA/read range, лимит, source error/abort cleanup, path traversal, dedupe corruption, private permissions.
- [x] RED→GREEN; временный файл wx/0600, hash/write по chunk, fsync, exclusive link в immutable final, fsync directories, cleanup staging.

## Task 2: Durable jobs

Files: schema migration append; src/jobs.ts; test/jobs.test.ts.
Interface: JobQueue.enqueue({kind,key,payload,maxAttempts?},now); claim(now,leaseMs); renew/complete/fail(claim,now).
- [x] Idempotent key/payload, restart, retry availability, expiry fencing, terminal max attempts, unknown outcome/reclaimed marker.
- [x] RED→GREEN; claims и acknowledgements в short transactions.

## Task 3: Local revisions and publication

Files: src/documents.ts; test/documents.test.ts; schema append document_versions/previews/recovery/events.
Interface: DocumentService.create/save(stream,...), publish(claim,manifest), getPublished(user,id), processingStatus(user,id).
- [x] Tests unpublished invisibility, inherited ACL, retained previous preview, stale base, ACL/revision race during stream, recovery receipts, source/artifact mismatch, expired lease, superseded publication. Restart coverage is currently queue/DB core; document-service restart acceptance follows with HTTP/worker integration.
- [x] RED→GREEN; локальная версия и preview job в одной транзакции, publication/event/job ack в одной транзакции; все blobs verified вне транзакции.

## Task 4: Verification

- [x] npm test/typecheck и исходный backend baseline.
- [x] Независимый review, исправление существенных замечаний, журнал/README и отдельный commit.

Потоковый blob API сам по себе не является подтверждением 4 ГБ офисного редактирования. HTTP resumable upload/download, конвертеры, worker runner и облачные адаптеры будут подключены следующими вертикальными срезами.
