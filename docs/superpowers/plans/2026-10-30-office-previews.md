# Native office preview pipeline

- [x] Real generated DOCX/XLSX/ODS/PPTX fixtures: text/styles, merged cells/results, multiple slides.
- [x] Linux bubblewrap runner: no host HOME/secrets/network, readonly one original + office installation/system libraries/fonts, fresh macro-disabled profile; bounded tmpfs and prlimit, timeout/abort kills namespace processes. No unsafe host fallback.
- [x] Stream bounded tar artifacts to private blobs, reject paths/links/excess files/bytes. Sanitize Writer/Calc HTML preserving merged cells and styles; resolve only generated local images.
- [x] PPTX/ODP PDF export → bounded raster slides and thumbnails; ordered presentation manifest for future left-rail/main-slide React viewer.
- [x] Wire worker registry/CLI configuration, explicit missing-engine/invalid-format errors. Keep old published previews on failure.
- [x] Real integration tests, full server suite/typecheck, review/ledger/commit.

Ruling: use LibreOffice native engine for office fidelity rather than reimplementing OOXML/ODF layouts in TS. Backend remains TS. It is a separate sandboxed executable; production packaging/version pin and hardware/4GiB/performance acceptance remain open. Bundled LibreOfficeDev is only a development integration tool, not a production version choice. Office HTML is a prepared preview; editing remains Collabora/WOPI work.
