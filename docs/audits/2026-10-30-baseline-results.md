# Baseline переписывания — текущий результат

Дата: 2026-10-30. Исходный HEAD: e56a71e. Статус: НЕ ЗАВЕРШЁН.

- Node v26.10.0, npm 12.2.0.
- Изолированный Python venv создан в /tmp/yourwiki-baseline-20261030.
- Установка requirements-dev.txt остановилась: источник пакетов не предоставил asgiref==3.12.1 (`No matching distribution found`). Это не доказательство ошибки приложения или отсутствия версии глобально. Pins не изменялись.
- До попытки установки Django и pycrdt отсутствовали в системном Python. Backend suite не запускалась.
- Ранее `node --test tests/frontend/*.test.mjs`: page-layout/sheet-axes прошли; graphics не загрузил yjs; sheets_gui_upgrade завершился ошибкой. Отдельный прямой запуск последнего: 7 passed, 1 failed из-за отсутствующего @univerjs/engine-formula.
- `npm ci --ignore-scripts` завершилась с exit 1: EAI_AGAIN при DNS-запросе registry.npmjs.org (архив yjs). Frontend build и полный прогон после установки не выполнялись.
- Live Google/Collabora, browser suite и новый performance profile не проверены.
- Структурный audit — 165 source files, 468 named Python tests; это не построчное ревью и не число пройденных тестов.
- Проверка архитектуры отдельным builder-reviewer: существенных вопросов перед планированием первого этапа нет. Уточнён статус roadmap как согласованной пользователем; design ожидает утверждения.

Продуктовый код, схемы БД, зависимости и production Compose не менялись.

## Повтор после разрешения установки зависимостей

- Exact Python requirements и npm lock установлены без изменения pins.
- Исходные frontend проверки: 4 test files passed; `npm run build` success.
- Полный backend в sandbox остановлен после 405 успешных сценариев на зависшем WebSocket-тесте. Повтор с одним deselect: 588 passed, 11 skipped, 4 failed, 1 deselected. Ошибки: 3 presence transport timeouts и локальный socket GUI installer.
- При разрешённых локальных сокетах полный offline backend: **593 passed, 11 skipped**, 29.29 s. Включает 15 новых migration audit проверок; прежняя база — 578 passed. 240 предупреждений, в основном отсутствие collectstatic каталога в тестовом окружении; не скрыты.
- Без изменения legacy-кода повтор подтвердил влияние sandbox на прежние WebSocket/GUI failures. Они не считаются регрессией продукта.
- Fastify: 8 named checks passed, TypeScript typecheck success.
- Исходные браузерные проверки: 89 collected. Chromium отсутствовал; установка в /tmp выполняется отдельно, результат ниже.
- Live providers, реальная Collabora и performance profile не проверены.

## Browser baseline

Chromium установлен в /tmp/yourwiki-playwright. `RUN_BROWSER=1 ... pytest tests/browser -x -q`: сначала 1 passed/1 failed — устаревшее ожидание 302 в test_recursive_deletion_confirmation_and_mobile_layout. Исправлен только тест: JSON 200, content-type, дальнейшая реальная навигация и состояние папок по-прежнему проверяются.

Повтор: **6 passed, 1 failed**, остановка по -x. Ошибка `tests/browser/test_browser.py::test_workspace_and_registration`: Locator.click timeout на отсутствующую ссылку `New file here` после успешного входа. Этот legacy-тест и оставшиеся сценарии требуют актуализации/проверки; полный browser baseline не зелёный. Реальная Collabora не запускалась.

Итог этапа: новый auditor и Fastify foundation проверены; offline backend зелёный; полный UI baseline не завершён.

После SQLite/auth/ACL core: полный offline legacy набор 593 passed/11 skipped (29.35 s); 41 именованных Node-проверок в новом сервере прошли, tsc --noEmit прошёл; исходные frontend test files 4 passed. Production и работающие данные не переключены.
