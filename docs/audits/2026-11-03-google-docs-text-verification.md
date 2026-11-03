# Google Docs native text compilation — 2026-11-03

Base: 4c3094e. This is a native-text compiler checkpoint, not completion of Google editing or the whole roadmap.

`compileGoogleDocsText` captures bounded data-only edits before asynchronous authority validation and requires an original current branded GoogleNativeSnapshot. Each operation names an exact tab, UTF-16 start/end coordinate and expected original text. Only a uniquely represented ordinary body text run can be changed. Nested tabs and table-cell paragraphs retain their native coordinates. Edits execute from the end of each tab so preceding coordinates stay stable. Mandatory requiredRevisionId comes from the snapshot, never from caller edits.

Paragraph terminators, cross-run/structural operations, suggestions, overlapping ranges, duplicate locations, no-op packets, Google-stripped control/private-use characters, malformed UTF-16 and surrogate-splitting ranges refuse before dispatch. Existing structure and formatting are not rewritten. Inserted text follows Google's ordinary inherited-style behavior; this does not promise exact style preservation for a replacement at a run boundary. Explicit style changes, generated content, headers/footers/footnotes and broad structural edits need dedicated compilation, not guessed whole-document replacement.

Integration test supplies an actual edit to the compiler, reserves its output in GoogleNativeJournal, dispatches through GoogleNativeWrite and checks one accepted POST. All provider responses and state are owned synthetic fixtures; no Google account or credentials used. The fixture's deterministic DOCX represents the same manual text change, but this compiler does not establish correspondence between an arbitrary edited OOXML blob and native source. It is not a provider delivery receipt and does not activate Google in the outgoing resolver.

Verification: initial missing-module RED at /tmp/yourwiki-google-docs-text-red.log; actual native focused 5/5, no failures/cancellations/skips, at /tmp/yourwiki-google-docs-text-native.log; server TypeScript check passed. Full server regression result is recorded in the progress ledger after completion. Frontend unchanged; no new browser or hardware/SLO claim.

References checked: [Docs request definitions](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request) (native UTF-16 locations, tab-specific ranges, insert/delete and text inheritance) and [native document structure](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents) (tabs, paragraphs, text runs and suggestions).

Next: editor/session integration and canonical reconciliation remain required, as do Slides/Sheets compilation/conflict strategy and remaining Google operations. No full Google, parity, release, Docker or performance completion claim.
