# Журнал исполнения — план: docs/superpowers/plans/2026-10-30-rewrite-baseline-migration.md

Дата: 2026-10-30. Ветка: codex/typescript-rewrite. База: e56a71e.

## Согласования

- Дорожная карта согласована пользователем.
- Архитектура утверждена: «делай пока что можешь, утверждаю».
- Продуктовый запуск/Docker/рабочие данные не переключены.

## Решения исполнения

- Ruling: использовать отдельную ветку текущего checkout; не переносить пользовательские/untracked документы в другой checkout. Документы и новая основа изолированы по файлам; существующий runtime не изменяется.
- Ruling: standalone auditor тестируется через stdlib unittest, чтобы инструмент можно было проверить без Django; дополнительная интеграция использует реальную migrated Django fixture.
- Ruling: baseline installation повторена с разрешённым сетевым доступом; exact requirements/lock не изменены. Установка успешна.
- Ruling: после sandbox-зависания WebSocket и отказа localhost GUI выполнить отдельный полный прогон с разрешёнными local sockets; не исправлять legacy-код ради особенностей sandbox.
- Ruling: минимальный Fastify package создан по отдельному подробному плану; production readiness по умолчанию false. Это не завершение всего этапа нового ядра.

## Выполнено

- Архитектура, матрица приёмки, реестр уведомлений, mapping контракта миграции.
- Read-only auditor: SQL counts/FK и pending capabilities, безопасный CLI, отсутствие утечек данных/sidecar writes. Отдельный тест на реальной схеме Django.
- Fastify factory, loopback entrypoint, liveness/readiness, error envelope, серверные request IDs, безопасная обработка parser/validation/body-limit errors.
- Независимый review двух компонентов. Найденный P2 (unsupported Content-Type превращался в 500) исправлен RED→GREEN; reviewer подтвердил снятие.

## Проверки

- Auditor stdlib: 14 passed, в том числе с ResourceWarning как ошибкой.
- Auditor + real Django backup: 15 passed.
- Fastify: 8 named checks passed; TypeScript typecheck passed.
- Исходные frontend test files: 4 passed. Production editor build: success.
- Sandbox backend excluding one hanging test: 588 passed, 11 skipped, 4 failed, 1 deselected. Failures: 3 presence transport timeouts и installer GUI socket; один read-only WebSocket тест зависает. Это не зелёный baseline.
- Полный прогон с разрешёнными local sockets: 593 passed, 11 skipped, 240 warnings. Legacy-код не менялся; sandbox-зависание и socket errors не воспроизвелись.

## Далее

Завершить baseline report и отдельно проверять live/browser окружение. Следующие вертикальные задачи: новая SQLite schema/migration ledger, совместимая аутентификация, ACL epoch и контрактные тесты. React и worker пока не реализованы; требование 4 ГБ не подтверждено.

## Browser и завершение текущего среза

- Chromium установлен в /tmp; исправлено только устаревшее 302-ожидание AJAX deletion test.
- Повтор browser: 6 passed/1 failed на старом locator `New file here`; остальные сценарии не объявлены пройденными.
- Полный backend baseline 593 passed/11 skipped остаётся действительным: production-код не менялся, browser correction отдельно.
- Следующий шаг — SQLite/auth/ACL и отдельная актуализация legacy UI acceptance. Общий rewrite не завершён.

## SQLite / authentication / ACL core — 2026-10-30

План: docs/superpowers/plans/2026-10-30-auth-access-core.md.

- Реализованы отдельная новая SQLite schema, migration checksum ledger, foreign DB отказ, WAL/FK, атомарные epoch triggers.
- Ruling: выбрать stable better-sqlite3 с packaged prebuilds; node:sqlite по актуальным официальным docs release candidate. Старый runtime остаётся на SQLite Django.
- Реализованы совместимые PBKDF2 SHA256/SHA1/scrypt и фикстуры настоящего Django с Unicode. Другие алгоритмы пока fail closed; будущий importer обязан явно блокировать неподдерживаемые credentials.
- Server-side opaque sessions: только hashes в БД, expiry, disable/password auth_version invalidation, session-bound CSRF.
- Opt-in login/account/logout с Origin/CSRF, cookie, account/IP rate quotas; forwarded IP не доверяется. Квота резервируется до async KDF, состояние credentials перепроверяется после него.
- ACL сохранены: root defaults, owner/group/everyone, персональные исключения, multi-group, inheritance, independent export restrictions и admin rules. Cache bounded, transactional reads не кешируются из-за rollback ABA.
- Независимое review: P2 foreign DB detection исправлено и снято; отдельные regression tests включены.
- Новая схема и API не подключены к production entrypoint. React/auth UI, importer, file APIs и admin operations ещё не реализованы. Readiness без workspace checker false.
- npm server suite/typecheck и исходные frontend tests пройдены. Повтор полного legacy pytest: 593 passed, 11 skipped, 240 warnings. Direct Node checks: 41 passed в 6 файлах.

## Streaming storage / durable jobs / publication — 2026-10-30

- Private immutable blobs: chunked SHA-256/write, enforced limits, fsync before acknowledgement, exclusive publication, range reads and corruption detection.
- Durable deduplicated jobs: retries/leases/restart, stale token fencing and reclaimed marker. Provider reconciliation remains mandatory before uncertain cloud writes.
- Local revisions and preview jobs are transactional; source/artifacts are verified before atomic publication/event/ack. Previous preview stays visible during preparation; stale source/converter requests cannot overwrite current publication.
- New unpublished files are limited to owner/admin; ACL and base revision are rechecked after streaming. A conflict/revocation retains accepted bytes as a recovery receipt.
- Published manifest receipts are retained across converter upgrades. No garbage collector currently removes immutable blobs.
- Independent review found a stalled iterator.return() resource leak; reproduced RED and fixed with nonblocking best-effort source close. Regression covers rejection without requiring an AbortSignal.
- Server: 61 named tests passed; TypeScript typecheck passed. HTTP file routes, resumable uploads, worker runner, converters and React remain pending. Office 4 GiB acceptance is unverified; production runtime unchanged.
- Повтор полного legacy backend: 593 passed, 11 skipped, 240 warnings (29.10s). Повторный независимый review: существенных замечаний нет. Browser/live-provider baseline остаётся незавершённым по ранее записанным ограничениям.

## Document HTTP transport — 2026-10-30

- Opt-in local routes for published metadata, preparation status, receipt-bound manifests/assets and export-controlled original downloads with bounded single byte ranges.
- Session and current ACL checks on reads; hidden drafts remain hidden. Preview assets carry sandbox CSP, no scripts/forms/external resources. Digests alone do not authorize access.
- Raw create/save streams use separate size limit; session/exact Origin/CSRF run before parsing. Structured 413 and 409 preserve recovery actions/operation IDs. Production entrypoint unchanged.
- Real localhost HTTP verified a streamed 2 MiB upload exceeding JSON cap and cleanup after connection abort without committing a partial revision. Route tests cover revoked ACL/session, cross-document receipt rejection, export bans and invalid ranges.
- Independent review: no substantial findings, including separate real HTTP verification of early 413. Resumable upload protocol, recovery downloads, worker/converters and frontend remain pending.
- Final server verification: 68 named tests passed; TypeScript typecheck and git diff --check passed. Legacy code unchanged since the preceding 593 passed/11 skipped baseline; browser/provider acceptance remains open.

## Preview worker / initial real converters — 2026-10-30

- Dedicated opt-in CLI worker consumes only preview.prepare jobs, renews fenced claims, and uses a durable shared preview slot. One conversion at a time across instances; expired slots recover on restart. Provider jobs untouched.
- Markdown/text subprocess uses pinned markdown-it 15.0.3 (MIT, built-in types), HTML escaping, no remote image embeds, bounded stdin/stdout/stderr, heap cap and timeout/abort. Parent credentials are not passed in environment. This is process separation, not an OS sandbox; forced process exit requires supervisor child cleanup.
- PDF passthrough references immutable original (preliminary header check only), without loading whole PDF into RAM. No PDF.js functionality is replaced by this step.
- Shutdown/lease loss kills converter and prevents stale publication. Unsupported/invalid/over-budget work produces visible terminal errors; transient conversion failures retry with backoff. Existing published preview remains available.
- End-to-end HTTP upload → real subprocess → verified publication → authenticated HTML asset tested. Standalone CLI on disk SQLite published work and exited cleanly on SIGTERM. Tests cover Markdown/table/escaping, text/PDF, ignored provider jobs, limits, timeout, shutdown, lease loss and shared serialization.
- Ruling: initial text input budget is 16 MiB, HTML output 64 MiB, subprocess heap 256 MiB and timeout 30s to bound memory on minimum hardware. This does not revise the outstanding 4 GiB office requirement; office and larger-corpus acceptance remain unfinished. Converter registry still needs office/native formats, fonts and attachment resolution.
- Independent review found no substantial issues. Minimal reproduction confirmed sandbox spawn may exit 0 without stdout; verification therefore uses the authorized nonsandbox local process environment. Empty successful subprocess output is additionally rejected defensively.
- Final verification: 78 server tests passed, TypeScript typecheck and git diff --check passed. Legacy runtime unchanged; prior backend baseline remains 593 passed/11 skipped. Full rewrite, browser/live provider and hardware performance acceptance remain open.

## Resumable upload transport — 2026-10-30

- Added append-only migration for upload reservations, fixed part size, leases, durable chunk receipts and stable completion receipt. Separate private per-upload/per-request stores permit safe temporary cleanup without deleting published blobs.
- Streaming chunks persist across restart; owner/session/ACL checks run before acceptance and again at commit. Same-boundary/same-content retry is idempotent. Failed chunks do not advance offset; real HTTP disconnect/retry verified.
- Final assembly hashes each chunk while streaming into permanent storage. Document/revision/preview job/upload completion receipt commit atomically via internal prepared-blob DocumentService APIs. No async transaction. Conflicting saves do not overwrite later edits; upload parts remain until expiry/cancel.
- Append and finish share a renewable lease, preventing parallel large staging copies. Limits: 8 MiB fixed parts by default, max4096 parts, max3 active uploads/user, max45 uncleaned reservations, 8 GiB pending-byte quota. Pending bytes remain reserved through physical cleanup. Overall workspace quota/free-space monitoring and orphan permanent-blob GC remain pending.
- Cleanup on app startup/each minute handles expired/cancelled/completed temporary data, preserving completion receipts. Cleanup failures remain retryable. Chunk size persists per upload to survive configuration updates.
- Independent review found and fixed P1 namespace fsync, parallel finish staging and tiny-part inode amplification; repeated review confirmed closure. New regression checks cover rejected replay cleanup, concurrent append/finish, corruption, expiry/quota, empty files and actual socket abort.
- HTTP routes create/status/PATCH/finish/cancel are opt-in, protected by session/Origin/CSRF and structured 413/409/423/408 errors. Production runtime remains unchanged; 4 GiB office acceptance still open.
- Final verification: 93 server tests passed, TypeScript typecheck and git diff --check passed. Temporary namespace removal is fsynced before cleanup acknowledgement. Legacy runtime remains unchanged since 593 passed/11 skipped baseline; browser/provider/hardware acceptance is still outstanding.
