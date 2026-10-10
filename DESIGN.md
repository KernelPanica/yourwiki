# Yourwiki interface

The workspace uses a restrained file-manager layout inspired by Google Drive and Notion. This direction was selected by the user. Existing Yourwiki routes, permissions, storage providers, and embedded editors remain the product foundation.

## Foundations

- System sans-serif typography. Body 16 px, controls 14 px, supporting text 12–13 px, page titles 24–28 px.
- White content surfaces, a quiet grey sidebar, blue primary actions. Dark mode uses the same component hierarchy.
- Primary `#2563eb`, primary text `#1d4ed8`, body `#1f2937`, secondary text `#596579`, surface `#f8fafc`, divider `#e3e8ef`.
- Spacing follows 4 / 8 / 12 / 16 / 20 / 24 / 32 px. Related controls use 8–12 px gaps; sections use 20–32 px.
- Borders identify controls and groups. Decorative offset shadows, rotated elements, and display fonts are removed.

## Navigation and actions

- After sign-in, show folders and files.
- Keep Files, All documents, Recent, and Starred visible in the sidebar. Global search stays in the top bar.
- Show frequent actions directly. Place secondary and destructive actions in the contextual More menu.
- Keep users and groups separate. Manage membership on the group detail page; user detail shows membership without editing it.
- Keep a consistent settings navigation across administration pages.

## Forms and access

- File creation starts with a keyboard-accessible type picker. Format and file-name preview update without navigation or clearing user input.
- Preserve independent read and write flags. Do not replace these with roles or silently change grants.
- At narrow widths, permission rows become labelled cards; every flag retains a visible name and its accessible checkbox label.
- Hidden group-picker results remain selected when filtered. Filtering never changes submitted membership.

## Editors

- Editors are embedded in Yourwiki. Their explorer starts collapsed and remains available through the navigation button.
- Fullscreen is optional and does not reload the editor. Escape or the exit button returns to the normal workspace.
- File operations and comments belong to the Yourwiki action bar. Editing commands remain inside the editor.
- Horizontal scrolling is allowed inside editor toolbars, spreadsheet surfaces, and large data tables, never on the document body.

## Verification

- Check 320, 768, 1024, and 1440 px widths; light/dark themes; Russian, English, and Spanish; long names and empty states.
- Check keyboard navigation, visible focus, menu dismissal, mobile sidebar focus, and labelled controls.
- Keep 44 px primary touch targets. Measure text contrast; avoid claims of complete accessibility compliance without a full audit.
- Verify file creation, permission preservation, group membership, search, editor saving/collaboration, and fullscreen with real browser interactions.
