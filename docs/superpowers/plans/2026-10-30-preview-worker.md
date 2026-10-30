# Preview worker and initial converters

Продолжение утверждённого rewrite. Production entrypoint не переключать.

- [x] Queue claim ограничить известным kind; terminal rejection для неподдерживаемых/невалидных задач.
- [x] Изолированный Markdown/text converter subprocess: pinned markdown-it, raw HTML выключен, bounded input/output, heap cap, timeout/abort, без окружения с секретами. PDF passthrough потоково, без полного буфера.
- [x] Один preview job за раз; renew lease, abort on lost lease/shutdown, atomic DocumentService publication; ошибки видны uploader, старый preview сохраняется.
- [x] Отдельный opt-in CLI worker для новой БД/storage; не открывать legacy SQLite и не менять production.
- [x] RED→GREEN tests: Markdown formatting/escaping, PDF streaming, unsupported formats, lease loss, timeout/abort, HTTP upload→worker→published preview, ignored unrelated jobs.
- [x] Full new-server tests/typecheck, ledger/README и commit.

Ruling: первые реальные converters — Markdown, plain text и PDF; office conversion подключается следующим расширением реестра. Это не замена требования DOCX/PPTX/XLS/ODS и 4 ГБ: они остаются открытыми. Ограничение памяти парсера Markdown означает явную ошибку сложного preview, а не объявление полной поддержки больших офисных файлов. Рендеринг выполняется вне API-процесса.
