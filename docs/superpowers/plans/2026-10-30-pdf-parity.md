# PDF.js parity in the TypeScript runtime

Approved scope: preserve the existing PDF.js workspace, annotations/forms, independent saved PDF layers, conflicts, recovery, permission changes and export controls. Production stays on the existing runtime until parity acceptance.

- [x] Stream published preview assets with HTTP byte ranges; authenticate and check current ACL before each request; reject malformed and unsatisfiable ranges. Do not require export permission for viewing.
- [x] Append an immutable migration for independent PDF layers and revision/conflict receipts. Keep the original immutable; preserve recovery data after failed or conflicting saves.
- [x] Add authenticated current PDF state, layer read/write and recovery routes with CSRF, byte limits and revision checks. Cover concurrent saves and base changes.
- [ ] Port the PDF.js workspace as a lazy module, including forms, annotations, autosave status, conflict/recovery dialogs and permission-loss handling. Serve pinned worker/fonts/CMaps/WASM locally under compatible CSP.
- [ ] Browser verification: forms and annotations survive reload, base never overwritten, two clients conflict safely, dirty navigation does not save automatically, export policy, mobile controls and range loading.

Ruling: range support is shared by receipt-authorized preview assets rather than a second arbitrary blob endpoint. Existing receipt and ACL checks remain the authorization boundary. Byte delivery for viewing cannot itself prevent a user from copying content already delivered to their browser; UI/export actions remain separately permission controlled.
