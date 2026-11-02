# Yourwiki baseline и контракт миграции — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Архитектура утверждена пользователем 2026-10-30. Не переключать production и не менять старые форматы.

**Goal:** Получить воспроизводимый baseline и проверяемый read-only manifest данных перед созданием нового runtime.

**Architecture:** Старый runtime остаётся источником baseline. Изолированный audit-инструмент читает backup SQLite и файловые manifests; он не выполняет migration writes и не обращается к облаку. Новый backend будет создан отдельным следующим планом.

**Tech Stack:** Существующий Python/Django/pytest и Node frontend tests; Python stdlib sqlite3/hashlib/json для read-only аудита backup.

**Spec:** `docs/superpowers/specs/2026-10-30-yourwiki-rewrite-design.md`.

## Global Constraints

- Не менять рабочую БД, оригиналы, encryption.key или pending/journal.
- Не снижать requirements pins ради зелёного baseline.
- Не писать секреты, password hashes, токены и содержимое документов в audit-отчёт.
- Проверки облака только в специально выделенных тестовых местах и отдельно от offline suite.
- Пользовательские миграции и deployment переключение вне этого плана.

## Review Focus

- Неверный путь к БД не должен создавать пустую БД.
- Повреждённая/неполная БД даёт явную ошибку, а не успешный пустой manifest.
- Повтор запуска не изменяет bytes исходного backup.
- Pending/journal и dangling references не теряются из отчёта.
- Диагностика не раскрывает secret fields.

## Файлы

- `tools/migration_audit.py`: read-only аудит backup SQLite, manifest schemaVersion=1, counts/table IDs и dangling FK; никаких ORM/network writes.
- `tests/test_migration_audit.py`: stdlib sqlite fixtures и assertions отсутствия побочных эффектов/секретов.
- `docs/audits/2026-10-30-baseline-results.md`: команды, результат, среда и ограничения.
- `docs/audits/2026-10-30-migration-contract.md`: mapping таблиц/артефактов, без схемы новой БД до следующего плана.

## Task 1: Воспроизводимый baseline

- [x] Создать изолированный venv, установить requirements-dev.txt без изменения pins.
- [x] `npm ci --ignore-scripts` с исходным package-lock.json.
- [x] Запустить `python -m pytest tests --ignore=tests/browser -q`, сохранить результат в /tmp, проверить skips/live markers и причины каждого failure.
- [x] Запустить `node --test tests/frontend/*.test.mjs` и `npm run build`.
- [x] Запустить доступные локальные browser tests по инструкции проекта без работающего production-сервера; явно перечислить непроверенные внешние сценарии.
- [x] Записать все результаты/limitations и HEAD. Если pins недоступны, пометить baseline incomplete, не объявлять регрессию кода.

**Приёмка:** воспроизводимый отчёт; отсутствие необъяснённых ошибок и скрытых skipped сценариев.

## Task 2: Read-only migration manifest

**Interfaces:** `audit_database(path: pathlib.Path) -> dict`; `main(argv: list[str] | None = None) -> int`. Manifest: schemaVersion, tables [{name,count}], foreignKeyViolations [{table,rowid,parent,fkid}], pendingCounts. Таблицы идентифицируются по sqlite_master, значения строк не экспортируются; SQL identifiers экранируются. CLI принимает путь backup и пишет JSON в stdout, диагностические ошибки в stderr с nonzero exit. URI mode=ro; missing path не создаётся.

- [x] Написать tests: missing input не создаёт файл; fixture с rows возвращает counts; секретные значения отсутствуют в JSON; dangling FK показан; SHA-256 backup до/после одинаков; invalid database nonzero.
- [x] Запустить `python -m pytest tests/test_migration_audit.py -q`, увидеть отсутствие реализации.
- [x] Реализовать минимальный audit_database/main в `tools/migration_audit.py` по контракту.
- [x] Повторить новые тесты и старую offline suite; не требовать рабочие credentials или инстанс.
- [x] Добавить отдельно именованные counts для SaveSession non-saved, OfficeSession pending, WriteAttempt non-acknowledged и ProviderTrashState, если соответствующие таблицы есть. Отсутствующую таблицу отметить как schema capability, а не нулевой success.
- [x] Проверить manifest на специально созданной Django backup fixture без production данных.

**Приёмка:** инструмент только читает; отчёт пригоден для сравнения количества переносимых сущностей и ожидающих операций.

## Task 3: Mapping контракта миграции

- [x] По models/migrations перечислить old tables, PK/FK и порядок импорта: users/groups → workspace/mounts → folders/documents → attachments/reviews/history/PDF → grants/trash → pending/journal.
- [x] Указать какие артефакты находятся вне SQLite и как проверять их наличие/идентичность.
- [x] Определить corpus старых embedded metadata и invalid/stale metadata; в новом reader не доверять embedded state, не соответствующему visible original.
- [x] Задать явные проверки password verification и Fernet decrypt/reencrypt в следующем плане; не включать secret values в fixtures.
- [x] Описать abort, повтор запуска и rollback только на копии.

**Приёмка:** каждый объект из feature inventory раздела 15 имеет способ переноса/проверки; ни одна активная операция не забыта.

## Task 4: Проверка перед каркасом нового runtime

- [x] Сопоставить результаты baseline и migration contract с acceptance matrix.
- [x] Проверить `git diff --check` и изменения dependency locks.
- [x] Подготовить следующий подробный план Fastify core: версии, DB contracts, error envelope, ACL epoch и sessions.
- [ ] Зафиксировать завершённый этап отдельным коммитом, только собственные файлы.

Не считать этот этап завершённым при недоступных обязательных зависимостях. До решения доступны документация, static mapping и инструмент на stdlib, но не утверждение о зелёном baseline.

Состояние 2026-10-30: auditor и mapping реализованы; backend baseline 593 passed/11 skipped. Browser acceptance запускается отдельно. Полный cutover/migration importer не реализован. Подробности — docs/audits/2026-10-30-rewrite-progress.md.

Browser baseline: выполнен с -x, 6 passed/1 failed (устаревший locator). Полный этап baseline остаётся открытым; это не блокирует независимо проверенную foundation, но блокирует утверждение полного UI parity.
