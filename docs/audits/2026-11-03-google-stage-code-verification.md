# Google code pass and verification — 2026-11-03

User amendment: implement the Google code batch first, then verify. No live Google requests in this session; the human assigned real-provider acceptance to another agent on the server. This is not a completed Google-stage or whole-goal report.

Implemented code in this pass:

- Durable trash/API/worker/mobile UI and exact private UUID marker; external restoration watch, Giga-only explicit restore, batch alias visibility receipts and bounded watch-job reuse.
- Personal identity-only Google OAuth/PKCE with verified email/subject, session-bound one-shot callbacks, central credentials unchanged. Local profile UI and verified original links/session notices.
- Local-ACL desired-grant planner, worker delivery/revocation, download restriction preservation/delivery and settings statuses. A lost mutation response remains fenced; a known successful response followed by failed readback can reconcile. No blind permission/export replay or opposite mutation on merely matching flags.
- Durable native/folder creation and within-connection document move/rename; private markers, current actor/destination/baseline guards, immutable operation context/identity/forward phases and explicit metadata-only recovery. Creation joins verified discovery/import/preview instead of creating a directly visible placeholder. Moves fence local saves, incoming acceptance and new Office sessions.
- Schema 45–47. Historical migrations 1–44 compared to HEAD and unchanged. Populated upgrade tests use genuinely removed future test tables before running the real migration path.

Final native server suite: **1090/1090**, 0 failures/cancelled/skipped, 119132.754992 ms. Command: `YOURWIKI_TEST_OFFICE_ROOT=<bundled-office-root> npm test --prefix apps/server`. Log: `/tmp/yourwiki-google-stage-server-verified.log`. This run includes the final server code, schema47, real source HTTP, crashes/restarts, conflict/session behavior, migrations and new Docs creation through actual Office preview conversion.

Actual inline frontend tests: **192/192**, no failures/cancelled/skipped; `node --test --test-isolation=none apps/web/test/*.test.ts`. Log: `/tmp/yourwiki-google-stage-web-verified.log`. A plain sandbox `npm test` reported file wrappers; the count above comes from actual cases, not the wrappers.

Server and web `npm run typecheck --prefix ...` passed. Frontend build passed using a temporary sibling copy of `git show HEAD:apps/web/build.mjs`; the temporary source was removed. Deferred performance build edits remain untouched. Final frontend-only improvements preserve a typed draft and stable destination IDs when async operation status/options refresh; final browser tests below exercise that code.

Focused current access/lifecycle tests: 14/14 passed, including HTTP role/CSRF/no-provider-on-page checks, PKCE identity scope and replay, verified/unverified identities, grant/revoke/export controls, exact original links and session receipts, both kinds of lost ACK, create/move/reclaim, preservation of source bytes and preview gating. The final full native run also enables real Office conversion for new Google Docs.

Live acceptance, full binary/native writeback, cross-connection moves, full embedded native editing and later ordered goal stages remain open. See the server handoff for explicit boundaries; do not activate an unconditional Google writer to bypass these requirements.


Five final real Chromium scripts passed sequentially against the owned loopback provider: `google-account-lifecycle.py`, `google-connect.py`, `google-discovery.py`, `google-import.py`, `google-trash.py`. Final logs: `/tmp/yourwiki-google-stage-browser-google-<case>.log`. The mobile scenario verifies identity-only consent and unlinking, created folder destination refresh, absence of a bogus document link for a folder, preservation of the next-file draft during completion, actual document preview, trash/restore of the same ID, no horizontal overflow at393×852 and no page errors. The OAuth/discovery/import regressions retain their lost-response/privacy/current-role checks. These are browser integration tests, not real Google/Redmi/iOS/SLO acceptance.

The first whole-server run reported six failures: two actual implementation issues (newly scheduled grant job not visible to an earlier claim timestamp, explicit restore without a prior local trash receipt) and four obsolete fixture/expectation failures after schema/features/alias behavior expanded. Fixed and re-run. Later readback scrutiny added durable successful-response evidence to permissions/export changes: matching state alone cannot clear a lost mutation response. New tests cover both uncertainty cases. The first new browser account/folder run failed on the test selector (`get_by_label` including select option text); using the actual accessible combobox name fixed the selector. No application error was suppressed.

No source data migration, production activation, push, merge, deploy or final whole-rewrite review occurred. Docker remains Django; the final rewrite review and later release/performance stages remain required.
