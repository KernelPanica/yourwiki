# Local live invalidation

Approved requirement: local permissions and prepared document updates become visible promptly without silently discarding dirty edits or waiting for providers. Existing session/conflict warnings remain part of acceptance. Production stays on the existing runtime until complete migration acceptance.

- [x] Bounded shared database change feed: global ACL epoch plus durable event cursor, current read checks before per-document invalidation, session revalidation, no titles/digests/provider payload in notifications.
- [x] Authenticated SSE endpoint with connection limits, backpressure cleanup, heartbeat, reconnect refresh and graceful shutdown; no tokens in URLs and no provider calls.
- [x] Shared browser EventSource coordinator; invalidate library/ordinary previews and notify the PDF controller to recheck without unmounting dirty edits.
- [x] Tests: invisible document events, permission/session revocation, stream teardown/limits, reconnect, rapid changes and dirty PDF conflict preservation. Record verification and commit.

Ruling: events are invalidation hints, never authority to read or write. Every subsequent API and asset request still checks current local ACL. ACL changes use a coarse signal without object identifiers; current document events are filtered by read permission. Bounded polling is shared by all open connections in one server process and only runs while clients are connected.

Client integration constraints discovered from current code:

- Root sessionLost() and the auth BroadcastChannel currently unmount authenticated children. Do not attach SSE session-expired to those paths without dirty-editor protection; extend navigation-guard with a non-interactive dirty query and preserve the editor while showing session warnings. A cookie/account switch must synchronously stop old editor writes rather than revalidate into a different user.
- Refresh ordinary previews/catalog in place; avoid replacing the PDF view object solely on an access hint. The PDF controller must recheck and pause/conflict through its existing state machine, retaining its in-memory pending copy.
- Coalesce revalidation and fence stale responses (especially catalog pagination/access loss). Ready/reconnect must refresh current state because this stream intentionally does not replay historical events.

Session prerequisite implemented and verified: synchronous generation fence cancels old private API/PDF range IO; dirty PDF survives account invalidation with writes/exports disabled, explicit discard is required before authenticated-account reload. Large delayed-range and two-tab browser tests pass. Current recovery requires discard even for the same owner; no automatic draft resumption claimed. SSE client integration subsequently completed below.


Client integration verified: one authenticated stream with identity verification, bounded hint coalescing, superseded response cancellation, reconnect revalidation and session fence cleanup. Real browser/SQLite tests cover catalog races, offline missed events, ordinary preview replacement, dirty PDF conflict preservation, ACL and server-side session revocation. Server 122/122 (0 skipped), web 24/24, both typechecks, build and PDF worker serialization regression pass. See rewrite progress ledger for the bounded first-page catalog refresh ruling and remaining full-rewrite work.
