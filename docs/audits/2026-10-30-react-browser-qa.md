# React viewing QA — 2026-10-30

Environment: temporary loopback Fastify with memory SQLite, synthetic qa user,
fixture DOCX/PPTX plus Markdown, new dist build; Chromium1234 at1365x900 and
393x852. Playwright CLI via local skill wrapper. Native fixtures converted with
the bundled development LibreOffice. No production data/provider requests.

Verified:

- Browser ru-RU selects Russian. Real username/password login and logout work.
- Accessible catalog opens a native presentation; main slide right, thumbnails
  left, selected state and disabled previous/next boundaries correct.
- Next button changed status2of2, Home returned1of2. Back preserved the same
  header DOM node and search filter; catalog network requests remained1.
- Native DOCX iframe loads the embedded raster image (complete=true,
  naturalWidth64). Account shows group/role without filesystem/database fields.
- Logout removed private account heading. Two tabs synchronized both login and
  logout; no identity payload is trusted from the channel, only server refresh.
- Delayed-login regression: hold successful /api/account after login, logout
  in another tab, release old response. Result oldIdentityRestored0/loginVisible1.
- Mobile overflow reproduced before fix (scrollHeight864/viewport852), then
  fixed (852/852; width393/393; controls bottom840). Inspected screenshots:
  /tmp/yourwiki-react-slides.png and /tmp/yourwiki-react-mobile.png.
- Inter is loaded locally and has public,max-age31536000,immutable. An old
  main bundle still returned200 after a source rebuild/server restart.
- Sampled active text/surface contrast ratios5.02–17.74; focus outlines and
  button targets inspected. No animations are enabled.

Expected console responses: unauthenticated account401 and missing favicon404.
No application script errors/warnings were observed in these flows. Browser
logs/snapshots are moved to /tmp/yourwiki-react-cli-evidence after closing QA.

Limits: this does not prove performance on physical Redmi/iOS, internet RTT,
large corpus/15users or Collabora load. No PDF/editor/provider-session parity,
live ACL update subscription, folders/upload GUI or full account/admin settings
acceptance is claimed. Production remains the old runtime.
