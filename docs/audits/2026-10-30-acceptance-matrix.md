# Матрица приёмки переписывания Yourwiki

Статус: инвентаризация, не результаты выполнения. Дата: 2026-10-30.
Каждый пункт переносится с отрицательными проверками прав, перезапуска и ошибок там, где применимо. Наличие старого теста не подтверждает новый runtime.

| ID | Контракт | Источники | Решение |
|---|---|---|---|
| F01 | Загрузка до настроенного лимита, понятная ошибка превышения | tests/test_upload_configuration.py; tests/test_nginx_upload.py | Потоковый путь и 4 ГБ требуют переработки |
| F02 | Конфликты; выход без записи; copy/download/reload | tests/test_external_sync.py; tests/test_write_recovery.py; wiki/static/wiki/office.js | Сохранить |
| F03 | Внешние изменения оригиналов и синхронизация | tests/test_external_sync.py; tests/test_storage_discovery.py | Локальная копия + фоновые jobs |
| F04 | Документы: стили, шрифты, таблицы, объединённые ячейки | tests/test_previews.py; tests/test_documents.py | Объединения в табличном HTML исправить |
| F05 | Совместная работа, курсоры и reconnect | tests/test_presence.py; tests/test_collaboration.py | Collabora и встроенные редакторы проверять отдельно |
| F06 | Глобальная история on/off, просмотр и восстановление | tests/test_global_history.py; tests/test_version_restore.py | Старый JSON импортировать |
| F07 | Открыть оригинал и read/write у провайдера | tests/test_provider_grants.py; tests/test_provider_identity.py | Сохранить direct access без общей browser session |
| F08 | Metadata MD/DOCX/ODS, восстановление после перезапуска | tests/test_portable_files.py; tests/test_ods_styles.py | Сохранить |
| F09 | Наследование, группы и персональные исключения | tests/test_personal_access.py; tests/test_rw_permissions.py | Добавить ACL epoch invalidation |
| F10 | Существующие файлы, UUID, содержимое после миграции | tests/test_portable_files.py; tests/test_storage.py | Новые migration fixtures обязательны |
| F11 | Google trash и внешнее восстановление | tests/test_cloud_trash.py | Добавить live acceptance |
| F12 | Полноэкранный Collabora, autosave, WOPI locks/recovery | tests/test_collabora.py; tests/browser/test_collabora_editor.py | Бесшовная замена preview новая |
| F13 | Times New Roman/Impact и локальные шрифты | tests/test_editor_fonts.py; tests/browser/test_personal_access_fonts_ui.py | Сохранить; лицензии и private asset ACL |
| F14 | Просмотр презентаций с лентой миниатюр | tests/test_admin_roles_export.py | Новый собственный viewer |
| F15 | Canvas/draw.io, touch, неизвестные поля | tests/test_graphics_roundtrip.py; tests/frontend/graphics.test.mjs | Сохранить |
| F16 | Редактируемый Dashboard | нет существующего сценария | Новое |
| F17 | Personal Recent, avatar, animation preference, account cleanup | wiki/templates/wiki/account.html | Новое/изменение |
| F18 | Язык браузера ru/en, существующий es; темы | tests/test_language.py; tests/browser/test_editor_themes.py | Сохранить es |
| F19 | Android/iOS, keyboard, desktop viewport | tests/browser/test_workspace_ui.py; tests/browser/test_layout_spacing.py | Расширить матрицу |
| F20 | Запрет экспорта Yourwiki/Collabora/Google | tests/test_admin_roles_export.py | Проверять assets/recovery/print |
| F21 | Гигаадмин/Простой админ и защита последнего | tests/test_admin_roles_export.py | Restore только Гигаадмину |
| F22 | Корзина файлов/папок/users/groups/invitations | tests/test_trash.py; tests/test_admin_roles_export.py | Сохранить IDs/memberships |
| F23 | GUI/CLI/unattended установка и upgrade | tests/test_install_gui.py; tests/test_install.py | Новый runtime, прежние persistent data |
| F24 | Task Tracker links, модули, плагины | нет | Только foundation; tracker отдельно |
| F25 | Центральные connections и личные original grants | tests/test_provider_onboarding.py; tests/test_provider_sharing.py | Onboarding только при потребности original |
| F26 | Desktop protected files in RAM | нет | Исследование; не реализовывать |
| F27 | PDF.js annotation layers/forms/recovery | tests/test_pdf_layers.py; tests/browser/test_pdf.py | Сохранить по решению пользователя |
| F28 | AI providers/text limits/ошибки | tests/test_pdf_ai.py; tests/test_requested_ui_features.py | Сохранить |
| F29 | Review comments/suggestions и вложения | tests/test_documents.py; wiki/editor_views.py | Не терять anchors при Collabora |
| F30 | wiki.zip и recovery import | tests/test_bundles_source.py; tests/test_write_recovery.py | Совместимые importers |
| F31 | Все провайдеры и несколько mounts | tests/test_storage.py; tests/test_mounts.py; tests/test_live_storage.py | Live отдельно |
| F32 | Полная готовая страница <=1 с, идеал 0.5 с | docs/performance-results.md — только исторический отчёт | Новые замеры Redmi/RTT/15 users |
| F33 | 4 ГБ просмотр/редактирование, 2 CPU/8 ГБ | нет подтверждения | Обязательное требование с открытым риском; не объявлять успешным |
