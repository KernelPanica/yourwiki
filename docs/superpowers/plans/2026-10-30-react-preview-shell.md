# React preview shell

- [x] Local paginated document-list API with current ACL, hidden drafts and read/write/export capabilities; no cloud requests.
- [x] Independent apps/web React+TS+CSS build, exact dependencies, hashed code/font assets with compression and immutable cache. Explicit opt-in static serving; old runtime untouched.
- [x] Session-aware login/account shell and persistent client navigation; browser language ru/en/es. No animation by default; semantic buttons/focus/44px touch targets.
- [x] HTML preview iframe, presentation main image right / scrolling thumbnails left, keyboard controls and lazy thumbnails. Load presentation code on demand; abort stale requests/navigation.
- [x] API/build/controller checks and browser QA: authorized list/open, DOCX image, presentation controls, back navigation, mobile layout, no page reload, cache headers. Bundle size evidence; no 500ms claim before hardware/network acceptance.
- [x] Review/fixes, full server/web typecheck/build, progress ledger and commit.

Ruling: first React slice is the authenticated viewing path. PDF.js parity, all editing providers/session warnings, dashboard/admin/account mutations and migration are still separate approved tasks, not dropped. The shell must clearly handle unsupported viewing without replacing legacy functionality; production remains Django until parity acceptance. No private-document browser cache is introduced here; only public hashed code/fonts have long-lived caching.
