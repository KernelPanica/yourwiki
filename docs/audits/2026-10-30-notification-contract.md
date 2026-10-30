# Контракт уведомлений Yourwiki

Дата: 2026-10-30. Автоматически извлечённые literal-строки ключевых UI-модулей; не исчерпывает server-side форм и переводов. Семантический реестр: feature-inventory.md, раздел 11.

## Правила переноса

- Сохранить trigger, severity, доступные действия, удержание ввода и scope уведомления.
- Не считать HTTP 500 прежнего middleware правильной заменой expired session/access denied.
- При unknown outcome сначала status/reconcile; никакого безусловного retry.
- При conflict выход не вызывает save; copy/download/reload подчиняются export ACL.
- Сообщения разделяют local durable save, provider delivery и preview publication.
- Пользовательский ввод и секреты не превращаются в текст технической ошибки.

## frontend/editor.js

- L15: Conflict · automatic saving paused
- L18: Write result unknown · automatic saving paused
- L32: Saved to storage
- L36: Reconnecting… Your edits are kept in this tab
- L36: Connecting…
- L38: Connected · saving…
- L44: The original changed. Download your edits before reloading.
- L56: Saved locally · storage unavailable
- L57: Saved locally · syncing to storage…
- L65: Saved locally · syncing to storage…
- L69: Changes were not saved: %(message)s Copy your changes before reloading.
- L69: Not saved
- L71: The server returned an invalid response. Check whether the action finished before retrying.
- L72: Connection lost. Your input has been kept. Check whether the action finished before retrying.
- L73: Conflict · automatic saving paused
- L73: Write result unknown · automatic saving paused
- L73: Disconnected · edits kept locally
- L73: Reconnecting…
- L79: Saving to storage…
- L88: a
- L89: Copied
- L89: Clipboard unavailable. A local snapshot was downloaded.
- L96: Discard local changes and reload the original? Other active editors must be closed.
- L104: ./rich.js
- L104: ./sheets.js
- L104: ./canvas.js
- L104: ./drawio.js
- L106: Editor could not start: %(message)s

## frontend/pdf.js

- L6: pdfjs-dist/web/pdf_viewer.mjs
- L144: Saving PDF…
- L148: file
- L149: revision
- L149: client_id
- L150: replace_stale_layer
- L153: The original changed. Download your edits before leaving or reloading.
- L154: Write access was revoked. Download your edits before leaving.
- L158: The server returned an invalid response. Check whether the action finished before retrying.
- L167: Start a new annotation layer for this original? Download the earlier annotations first if you need them.
- L175: Discard local changes and reload the saved PDF?
- L186: a
- L210: PDF ready

## wiki/static/wiki/office.js

- L7: Your changes will not be saved
- L15: Grab_Focus
- L29: Host_PostmessageReady
- L33: Host_PostmessageReady
- L39: a[href]
- L43: Action_Export
- L45: Discard current editor changes and open the remote original?
- L51: session
- L57: Export permission was removed. Save your work and reopen the editor to update its toolbar.
- L65: Editing permission was removed. Copy or download your changes before leaving.
- L67: The action could not be completed. Your input has been kept.
- L74: The office editor is still loading. Check the Collabora connection.

## wiki/static/wiki/ui-errors.js

- L6: The action could not be completed. Your input has been kept.
- L8: div
- L8: span
- L8: button
- L8: Dismiss error
- L12: Yourwiki action failed
- L20: Content-Type
- L22: The server returned an invalid response. Check whether the action finished before retrying.
- L38: X-Yourwiki-Error
- L42: Yourwiki UI error
- L42: The action could not be completed. Your input has been kept.
- L42: A preview or interface component could not be loaded. Reload the page or download the original file.
- L43: Yourwiki UI promise failed
- L43: The action could not be completed. Your input has been kept.
- L54: The action could not be completed. Your input has been kept.
- L59: p
- L64: yourwiki:form-success
- L70: The server returned an invalid response. Check whether the action finished before retrying.
- L76: p
- L81: a[href]
- L84: inline
- L89: Content-Type
- L89: Your session expired. Sign in again.
- L90: a
- L91: Content-Disposition

## wiki/static/wiki/provider-sync.js
