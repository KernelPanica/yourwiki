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

## Native office previews — 2026-10-30

- Added real LibreOffice Writer/Calc/Impress conversion routed by TS worker. Registry includes common Office/ODF/template formats; real integration currently proves DOCX/XLSX/ODS/PPTX only. Legacy/native Yourwiki formats and the broader fidelity corpus remain pending.
- Linux bubblewrap sandbox: selected readonly original only, engine/system libraries/fonts; no network or host HOME, fresh readonly macro security configuration, PID namespace/die-with-parent, bounded tmpfs, prlimit and timeout. No unsafe host fallback. Pinned JS dependencies sanitize-html2.18.1/tar-stream3.2.2; native production image/version pin still pending.
- Writer/Calc HTML preserves tested merged cells, emphasis, calculated values, multiple sheets and embedded raster image references. HTML sanitizer removes active/external resources. Impress emits ordered PNG slides+thumbnails with a presentation JSON index; main-slide/left-rail React GUI still pending.
- Real fixture generator is committed; no user content. PPTX raster output visually inspected. Playwright CLI browser QA exposed opaque-sandbox image failure (naturalWidth0); sandbox allow-same-origin with script/form restrictions fixed authenticated nested images (naturalWidth64), screenshot /tmp/yourwiki-office-browser.png. CLI evidence moved to /tmp; temporary QA browser/server stopped.
- Independent review found setup-abort race; fixed before-spawn and already-aborted checks, reproduced cancellation in2ms without launch. Malformed tar tests additionally caught an unhandled rejected entry-stream error; fixed and regression verified.
- Ruling: bundled LibreOfficeDev is an integration tool only. Calc needed higher virtual-address ceiling on this build; set8GiB virtual cap, MAX_CONCURRENCY2, MALLOC_ARENA_MAX2, OMP1. Observed one live RSS sample~85MiB is not peak/load acceptance. Hard cgroup/RSS constraints, distribution/font pin and target 2CPU/8GiB mixed load remain open. 4GiB office rendering/editing and page500ms remain unproven.
- Final real-engine verification: 101 server tests passed, zero skips with YOURWIKI_TEST_OFFICE_ROOT set; TypeScript typecheck and git diff --check passed. Repeated independent review accepted CSP and archive handling. Native production pin, React viewer, complete font/fidelity corpus, WOPI/editor, migration and target performance acceptance remain unfinished; production runtime unchanged.

## React authenticated viewing shell — 2026-10-30

- Added independent apps/web React19.3.1/TS/CSS client with esbuild splitting. Login/logout/account groups, ru/en/es browser language, catalog, HTML/table iframe and presentation main-right/scrolling-left thumbnails with keyboard controls. No animation by default. Account mutations/animation preferences/avatar remain pending.
- Added bounded paginated local catalog (published/current ACL/capabilities) and combined document view response to avoid sequential metadata requests. No cloud IO. Public hashed JS/CSS/local Inter get gzip/Brotli + one-year immutable cache; private API/assets and HTML remain no-store. CSP restricts code/frames/resources to own origin.
- Retained earlier hashed assets/manifests across builds; an older main bundle remained200 after a real code rebuild/server restart. Public font cache header and actual Inter availability verified. Dist includes third-party license notices, is ignored and is not installed into production.
- Browser Playwright QA: real login, native PPTX navigation and Home key, DOCX embedded image naturalWidth64, account group, logout removes private view. Same header DOM survived route/back; filter survived, catalog requested once. Desktop and393x852 screenshots inspected. A12px mobile overflow was reproduced and fixed with root flex sizing (final scrollHeight852/viewport852, no horizontal overflow).
- Contrast checked for actual text/surface pairs: minimum5.02:1 among sampled active text tokens. Buttons use44px targets and focus-visible outlines. No physical Android/iOS device acceptance yet.
- Ruling: retain first visited library in memory to preserve filter/scroll across route changes, while all document/asset API operations reauthorize. Live ACL/update subscription is not yet wired; this is not a claim that an already displayed title disappears immediately upon remote permission change.
- Ruling: npm12 initial peer resolution stalled despite registry success; verified compatible explicit React peers, generated lock with legacy-peer mode. Ordinary offline npm ci then passed; no shared/root dependency changes.
- Independent review found no substantial API/cache/auth/request-race issues. PDF.js parity, all editors/session warnings, folder/upload UI, Recent, dashboard/admin/preferences and migration remain separate approved work. Production unchanged; no500ms/4GiB/target mixed-load claim.
- Added cross-tab auth invalidation with BroadcastChannel and lifetime guards for catalog/document/account/login requests. Independent review found a late-login completion race; fixed both login requests and post-JSON abort checks. Regression test watched RED→GREEN. Browser held a successful account response, logged out in another tab, released stale response: oldIdentityRestored0/loginVisible1. Basic login/logout synchronization also passed in two real tabs.

Final React slice verification: 103 server tests passed, including real native office conversions (0 skipped); 3 web tests passed; server and web TypeScript checks, web production build and git diff whitespace check passed. The dependency lock was also verified with npm ci. Main JavaScript: 228831 bytes raw / 70898 gzip / 66093 Brotli; these are transfer sizes, not proof of page latency. Browser QA covered two-tab logout/login synchronization and delayed login response after logout. Synthetic QA server and browser were stopped after verification. PDF.js/editor parity, physical-device performance acceptance and production migration remain pending.

PDF parity continuation: inspected legacy frontend/pdf.js, wiki/pdf_layers.py and PdfAnnotationLayer. The legacy persistence contract is a separate derived PDF, preserving annotations/forms without overwriting the original. Added streaming byte ranges to authenticated receipt-authorized preview assets as the transport foundation for PDF.js. Regression first failed with 200 instead of 206, then passed; covers prefix/suffix/open ranges, malformed ranges, no-store, viewing despite disabled export, access revocation and anonymous denial. All 104 server tests passed (0 skipped), including native office conversions; server TypeScript and whitespace checks passed. Remaining PDF parity work is tracked in docs/superpowers/plans/2026-10-30-pdf-parity.md; no production switch and no claim of completed PDF editing.

PDF layer persistence: appended migration 8 without changing existing migration SQL. New PdfLayerService stores immutable derived-PDF versions separately from original document_versions; optimistic base and layer revisions are rechecked with current ACL in an immediate transaction after streamed durable storage. Concurrent/stale saves retain author-associated recovery copies; replacing annotations after a base change requires explicit intent and exact current revisions. Events publish atomically with layer receipts. Tests cover original/old-layer preservation, simultaneous writers, changed original, permission revocation during upload, input snapshot and byte bounds. Initial tests failed before implementation; final full suite passed 108/108 (0 skipped), then expanded focused layer suite passed 6/6; TypeScript and whitespace checks passed. HTTP routes and PDF.js UI still pending, so this is persistence foundation rather than end-to-end PDF editing parity.

PDF HTTP APIs: registered state, immutable revision layer reads, streamed layer saves and author-bound conflict recovery downloads. Session/Origin/CSRF, current read/write/export policy, configured byte bounds and validated revision controls apply. Layer viewing remains available with export disabled; recovery download requires export and current read rights. Range responses, stale original replacement with explicit intent, preserved earlier layers and inaccessible foreign recovery copies are tested. Route tests first failed with missing endpoints, then passed. Final full server run: 113 passed, 0 failed/skipped; TypeScript and whitespace checks passed. React PDF.js integration, client recovery/permission-change UX and live browser parity remain pending.

React PDF.js workspace: added lazy pinned PDF.js and separate lazy stylesheet, local content-versioned worker/fonts/CMaps/WASM/images with whitelist static routes. Connected forms/text/highlight/ink, independent layer saves, conflict recovery link, navigation guard, autosave status and local ACL heartbeat; retain older prepared preview while a new original is pending. Fresh review found a real PDF.js modified-latch race; actual worker browser regression failed before the fix (saved UI with missing ink) and passed afterward with two saved paths plus subsequent ink-only autosave. Hash comparison and endCurrentEditing commit prevent false-clean acknowledgements. Full browser script verified form/native free-text persistence, two-tab conflict, recovery download, no save on departure and 393×852 layout without page errors/CSP violations. Final suite: 114 server tests and 10 web tests passed, both TypeScript checks, production web build and whitespace check passed. Ruling: pinned PDF.js serialized hash/UI manager API adds a serialization scan and requires race regression on engine updates. CSP extension was rejected by auto-review; policy unchanged and a user question remains pending. Full PDF parity, locale/pan/remaining controls, permission-loss/provider UX and physical performance acceptance remain outstanding. See docs/audits/2026-10-30-pdf-react-qa.md and committed synthetic browser scripts.
