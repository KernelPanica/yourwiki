# Проверка требований task.md

| Требование | Реализация и проверка |
| --- | --- |
| Открыть оригинал | Ссылка видна читателям, открывает исходный объект. `test_original_link_read_permissions_and_provider_move`, `test_native_sheet_id_url_history_and_external_conflict`. |
| Персональные provider grants (замена по task2.md) | Пользователь явно выбрал новое требование: OAuth ProviderIdentity, персональные Google/OneDrive grants и GitHub collaborators, отзыв и повтор после ошибок. Неуправляемое и публичное sharing по-прежнему блокируется. `test_provider_grants.py`, `test_provider_sharing.py`, `test_provider_identity.py`. |
| Большие загрузки | Production-фрагмент `docker/nginx-location.conf`: запросы допустимого размера проходят; превышение лимита приложения и прокси имеют отдельные понятные сообщения. `RUN_NGINX=1 pytest tests/test_nginx_upload.py`: настоящий Nginx, 5 MiB, 5 MiB + 1 байт и 61 MiB. |
| Опциональная история | По умолчанию выключена; настройки файла, папки, mount и пространства наследуются. История — один `имя.расширение.json`. `test_history_inheritance_stale_save_and_physical_rename`, тесты восстановления истории после ошибки записи. |
| Данные в файлах | Markdown front matter, DOCX customXml, ODS meta.xml; Google Sheets хранит таблицу в нативном объекте. Без истории отдельный JSON-снимок не создаётся. База хранит каталог, ACL, аккаунты и состояние активного редактирования. `test_portable_files_restore_editor_without_database_state`, `test_native_google_scan_and_restart_restore_without_snapshot`. |
| Синхронизация редактирования | Совместное редактирование и optimistic locking; устаревшая ревизия или изменённый внешний файл приводят к конфликту. `test_two_file_saves_cannot_overwrite_each_other`, `test_external_conflict_and_explicit_reload`, `test_concurrent_text_merges_and_retry_is_idempotent`. |
| Наследование ACL | Рекурсивное наследование, явные права владельца/основной группы/всех и дополнительные групповые права. После обновления RW права при создании наследуются автоматически, подробная настройка перенесена в настройки файла/папки. `test_recursive_acl_owner_and_group_overrides`, `test_creation_permissions.py`; Chromium-проверки создания документа, папки и загрузки файла на ширине 360 px. |
| Форматы и старые данные | Markdown и DOCX создаются отдельно, открываются одним редактором. Старые форматы читаются; команда `convert_file_formats` повторяемо переносит данные. Google создаёт нативные Sheets с прежним ID при последующих сохранениях; другие источники — ODS. `test_legacy_conversion_preserves_native_content_and_is_repeatable`, `test_ods_formula_styles_sheets_and_foreign_import`, `test_google_native_files.py`. |
| Настоящее перемещение | Используются rename/операции провайдера, включая совместимые mountpoints. Проверяется сохранение inode локального файла и ID Google Sheet. Между разными файловыми системами или несовместимыми источниками возвращается ошибка без копирования и удаления. `test_cross_mount_moves_relocate_attachments_and_empty_subdirectories`, `test_cross_filesystem_move_keeps_original_without_copy`, `test_google_native_cross_mount_move_keeps_identity`. |

Миграция схемы: `python manage.py migrate`; Docker выполняет её при запуске. Старые JSON-файлы можно преобразовать командой `python manage.py convert_file_formats`; существующие резервные копии и старые независимые ревизии автоматически не удаляются.

Тесты API провайдеров используют контролируемые ответы. Проверка на реальных Google/OneDrive/GitHub аккаунтах требует конфигурации тестового источника: см. `docs/storage.md`. Успешные автоматические проверки не означают проверку доступа на реальном внешнем аккаунте.

## Ревизия прав от 6 октября 2026

Новые требования заменяют независимые visible/read/write на read/write. Запись включает чтение; без чтения существование файла не раскрывается. Миграция 0015 сохраняет закрытыми прежние скрытые правила и не меняет файлы у провайдеров.

Проверки: `tests/test_rw_permissions.py` (нормализация, миграция, отсутствие утечки, API папок, запрет изменения ACL редактором, контракт бинарного API для шести адаптеров, запрет принудительного сохранения читателем по WebSocket); `tests/test_creation_permissions.py` (наследование, защита от подмены полей, группы и перемещение); `tests/browser/test_rw_settings.py` (создание и настройки на 320/390/1440 px).

Контрактные тесты провайдеров используют заглушки внешних операций; они не являются проверкой реальных облачных аккаунтов. WebDAV не входит в текущие шесть адаптеров. Внешние персональные grants согласуются после commit локальных ACL; неуправляемые публичные разрешения не создаются.


## Дополнение от 7 октября: персональные grants

Миграция 0016 добавляет ProviderIdentity, ProviderGrant и зашифрованную конфигурацию OAuth clients. SQL-миграция сама не вызывает внешние API. Пользователи вступают по приглашениям и связывают существующие аккаунты через OAuth с обязательным подтверждением имени. Полный новый релиз task2.md (этапы 3–10) этим изменением не объявляется завершённым.

Проверены выдача read/write, отзыв при удалении и изменении группы/identity, сохранение receipt при сбое отзыва, повтор, объединение GitHub по нескольким mountpoint, защита OAuth state от подмены/повтора и уникальность внешнего аккаунта. Команда `sync_provider_grants` восстанавливает согласование после прерывания процесса. Личный GitHub не поддерживает read-only collaborator: ошибка вместо повышения до write. Владельцы внешних оригиналов сохраняют свои права владельца.

Полный серверный прогон: 238 passed, 1 skipped (опциональная среда), 34 deselected (browser/live). Источники: `/tmp/rw-complete.log`, `/tmp/rw-complete.xml` в рабочей среде. Облачные вызовы проверены с контролируемыми ответами, реальные OAuth credentials и рабочие grants не использовались. Рабочая база не мигрировалась, production не перезапускался.

Браузерные проверки: настройки доступа и создание на 320/390/1440 px; страница аккаунтов провайдеров на 320/390/768/1440 px в en/ru/es. Секрет OAuth после сохранения не возвращается в HTML. Независимая ревизия обнаружила и помогла исправить повтор отзыва после удаления нескольких пользователей, объединение OneDrive по стабильному ID диска и восстановление после потерянного ответа на invite; регрессионные тесты включены в итоговый прогон. `npm run build`, `manage.py check`, `makemigrations --check --dry-run`, `node --check wiki/static/wiki/app.js`, `git diff --check` выполнены успешно.
