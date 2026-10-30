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
