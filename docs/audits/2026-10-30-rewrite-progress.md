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
