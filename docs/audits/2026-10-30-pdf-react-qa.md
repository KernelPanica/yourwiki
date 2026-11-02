# React PDF.js workspace verification

Implemented against pinned PDF.js 6.3.289 in the separate opt-in runtime; production Django remains unchanged.

## Real browser evidence

Synthetic loopback fixture: two-page PDF with one AcroForm text field; generated using ReportLab and committed under apps/server/test/fixtures/pdf/form.pdf. Chromium from the existing local Playwright runtime; Russian browser locale.

- Form value survives autosave and a full reload.
- Free-text annotation survives save and is present in the derived PDF's native `/Annots`; the form value remains in `/V` (parsed with pypdf).
- Two tabs opened at the same layer revision cannot silently overwrite one another. The losing tab shows a conflict, retains local edits and provides an author-bound recovery download returning HTTP 200.
- Cancelled navigation preserves the PDF editor. Confirmed departure discards local unsaved changes without an extra PUT; reopening shows the earlier saved value.
- Mobile viewport 393×852: document scrollWidth 393, scrollHeight 852. Screenshot /tmp/yourwiki-pdf-mobile.png inspected.
- No page script errors or CSP violations in these form/text/ink scenarios.

Reproducible scripts and synthetic server are committed; see apps/web/README.md. Browser scripts require Python Playwright and pypdf and an installed Chromium.

## Independent review and serialization race

A fresh reviewer found P1: PDF.js `annotationStorage.onSetModified` emits only the first modified transition, so later ink changes during `saveDocument()` could be acknowledged as saved even though absent from the worker snapshot. Its ordinary dirty-state unit tests did not prove real PDF.js behavior.

The browser regression holds a real worker SaveDocument message, adds another stroke and resumes the worker. Before the fix, the saved artifact had 0 ink paths while the UI said saved. After the fix, a subsequent save retained both paths (layer revision 2). An additional ink-only gesture also autosaved and remained in the saved PDF.

The fix compares PDF.js serialized-storage hashes across the worker save and marks later changes dirty; pointer/input/undo tracking covers mutations beyond the first modified callback. `endCurrentEditing()` commits active drawing sessions before serialization. Unit tests additionally cover uncertain save outcomes, overlapping saves and navigation-guard cleanup.

Ruling: this uses the pinned PDF.js serialized-storage hash and UI manager drawing commit API. It costs another serialization scan per save, and PDF.js upgrades must pass the real-worker race regression before acceptance.

## Local resources and remaining gates

Worker, CMaps/fonts, WASM and image resources have content-versioned whitelisted paths; prior asset versions are retained for already-open tabs. PDF JavaScript and its 175678-byte stylesheet are lazy; the main stylesheet remains 7046 bytes. Main JS 229149 bytes raw / 70995 gzip / 66189 Brotli. These are artifact sizes, not timing acceptance.

Automatic approval review rejected adding `wasm-unsafe-eval` to the application CSP. No CSP change was made; a separate user question is pending. WASM-dependent fonts/codecs, the wider PDF corpus and real Redmi hardware performance have not been accepted. Full locale strings, pan/remaining controls and all permission-loss/source-notification workflows remain pending. PDF parity is not declared complete.

## Controls, language and permission follow-up

- PDF strings, including conflict/recovery/exit warnings, now have RU/EN/ES dictionaries. Browser checks ran en-US, ru-RU and es-ES.
- Mouse pan moves both axes (test scrollLeft 100→160, scrollTop 150→230); touch scrolling remains native and scrollbar clicks are not captured. Changing tools exits pan mode.
- Explicit zoom remains selected after resizing; page-width/page-fit continue to fit on resize. Added zoom increment/decrement and original/saved PDF download actions.
- All three locales retain a 393×852 document viewport without outer page overflow. PDF stylesheet remains lazy before opening a PDF.
- UI permission regression initially failed because undo remained enabled. After the fix, edit controls and existing/new form layers lock after write loss, export actions hide after export loss, and the unsaved form value remains in memory. The test observed no PUT after refreshed permissions. This is a UI test with intercepted metadata, not a replacement for actual server ACL tests.
- Existing form/text round trips, two-client conflict, recovery, discard without saving, delayed worker ink and subsequent ink-only autosave were rerun successfully.
- Independent reviewer reported no new substantial findings; 13 web tests and TypeScript passed, production build passed. No server code changed in this follow-up; the prior 114-test server baseline remains unchanged. CSP remains unchanged while the separate WebAssembly question is pending.

Final control check also verified native keyboard scrolling of the focusable PDF region. The repeated workspace browser test was made independent of existing annotations: wait for actual free-text mode, choose blank hit-tested space, and assert a unique newly saved annotation string. This eliminated a reproduced stale-coordinate test failure; the strengthened round-trip/conflict/discard scenario passed again.
