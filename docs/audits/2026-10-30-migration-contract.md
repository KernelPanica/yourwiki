# Контракт переноса Yourwiki

Статус: mapping исходной реализации, 2026-10-30. Применять только к согласованной backup-копии. Аудит: `python tools/migration_audit.py /path/to/backup.sqlite3`. Это проверка структуры/количеств/FK, не полноценная миграция и не проверка файлового журнала.

## Порядок и identity

| Порядок | Источник | Что сохраняем / проверяем |
|---|---|---|
| 1 | wiki_user, auth_group, wiki_user_groups, admin-role/invite-group M2M | PK, username/display_name, password algorithm+encoded hash, active/role/can_invite, членства. Проверка пароля реальным verifier, не сравнением строк |
| 2 | wiki_workspace, wiki_siteconfiguration | Singleton IDs, initialized, все настройки и encrypted configs. Совместимость Fernet проверяется фиктивным шифротекстом; настоящий plaintext не логируется |
| 3 | wiki_trashentry | UUID, root_id, kind, details, deleted_by/at и original_path; импорт до FK документов/папок |
| 4 | wiki_folder, wiki_mountpoint | PK, parent/folder FK, policy/group/user rules, inheritance, export flags, mount path/provider/config. Folder tree восстанавливается в два прохода, cycles/dangling parent блокируют cutover |
| 5 | wiki_document | UUID, owner/group/folder, reference без изменения original object, revision/storage_digest/history_reference, file_format/format_version, trash и metadata flags |
| 6 | wiki_attachment, wiki_review | UUID/reference/MIME; Review IDs/body/anchor/status/author_label и resolved_by; старые авторы не удаляются каскадно |
| 7 | wiki_collaboration, wiki_savesession, wiki_sourcelease | CRDT state/snapshot/generation/sequence/synced_sequence/saved_structure; все payload/base_revision/etag/hash/client sequence/state; leases/tokens не превращаются в новые публичные tokens |
| 8 | wiki_officesession, wiki_pdfannotationlayer | UUID/document/base_digest/lock/expiry/superseded, pending bytes/author/error; PDF original digest/reference/content digest/revision |
| 9 | wiki_writeattempt | attempt UUID, document, expected/intended/confirmed digests, reference/state. Сверить с дисковым journal: записи есть вне успешной SQL-транзакции |
| 10 | wiki_provideridentity, wiki_providergrant | PK/user/provider/external_id/email/login/active; desired/applied roles, permission IDs, attempted state/errors. Не создавать повторные grants автоматически до reconcile |
| 11 | wiki_providertrashstate, wiki_providerexportrestriction, wiki_providersyncstate, wiki_pendingdeletion | mount/reference/confirmed/errors; original export restriction; requested/completed/force revision; pending directory/file удаление. Новый worker не повторяет unknown deletion слепо |
| 12 | wiki_invitation, wiki_invitation_groups, wiki_loginattempt, django_session, wiki_officefontactivation | token hash/uses/expiry/revocation/group links; anti-bruteforce state; sessions compatibility; font activation. Истёкшие presence не обязательны для переноса, но это не разрешает удалять CRDT или recovery |

Названия M2M сверять с sqlite_master и Django _meta реальной migrated fixture; не угадывать schema по одному имени таблицы. SQLite foreign_key_check проверяет ссылки, но не все смысловые ограничения.

## Вне базы

- `/secrets/runtime.json`, `/secrets/encryption.key`: отдельная закрытая backup, не commit. Django secret может требоваться для старых session signatures.
- Все оригиналы в mounts: location/provider/reference, байтовый SHA-256 и provider fingerprint (это разные понятия для Google Sheets). Чтение originals не должно их изменять.
- `history_reference`: старый JSON со снимками base64/digests; потоковый importer старого архива, лимит памяти и перенос авторства/дат.
- `Attachment.reference`, `PdfAnnotationLayer.reference`: проверить наличие, MIME и digest; не путать производный PDF с оригиналом.
- `DATA_DIR/write-journal/<document UUID>/intent.json` и payload*: приватные, сверять document/digest/payload; malformed journal блокирует автоматический replay. Rename intents тоже сохраняются.
- Локальный каталог шрифтов и лицензии/activation; частные TTF не публиковать вместе с открытым каталогом.
- Старые .wiki.zip/.recovery.json, загруженные пользователем: совместимые importers, не исполнение чужих metadata.

## Corpus metadata

MD front matter, DOCX customXml/yourwiki.xml, ODS embedded metadata: проверить valid, отсутствующий, повреждённый, несоответствующий visible content digest и неизвестную версию. При stale metadata использовать видимое содержимое, а не восстанавливать устаревшее editor state. Поддержка неизвестных форматов не означает молчаливое удаление полей.

## Dry-run, restart, abort

Только отдельная новая БД/каталог. Manifest с schema version, old/new identity mapping и digests, но без секретов. Незавершённый этап не публикуется; повтор продолжает по подтверждённым receipts и сверяет source digest. Любые несовпадения IDs/ACL/digests/pending показываются и блокируют cutover. Отсутствующий optional table отражается capability unknown, не выдуманным нулём.

Целостность SQLite и количества не доказывают наличие originals. Отдельный asset scan обязателен перед переходом. Cutover — один writer, последняя delta, backup, smoke разных ролей. После новых записей `git checkout` не является откатом: нужен согласованный перенос delta или восстановление snapshot. Никогда автоматически не удалять внешние оригиналы для отката локальной миграции.
