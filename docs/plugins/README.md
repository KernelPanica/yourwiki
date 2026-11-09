# YourWiki TypeScript service plugins (API v1)

Settings → Plugins is available to Giga admins. Upload a single UTF-8 `.ts` file (up to 256 KiB). Install leaves it disabled. Enter connection settings, save, enable, select an action and run it. Actions are invoked explicitly from this screen; this version does not register storage providers, background jobs or document-save hooks.

Plugins are **trusted server code**, not an untrusted-code sandbox. A worker has the server process's OS/network privileges. Install only reviewed code. Workers have a 15-second invocation timeout, a 64 MiB old-generation JavaScript heap limit and a global limit of two simultaneous invocations. These are execution bounds, not a total process-memory or network security boundary. No additional npm dependencies are installed automatically.

A file must export a default object with:

- `id`: stable ID, beginning with a letter, containing letters/digits/underscore/hyphen, up to 64 characters.
- `name`, `version`, optional `description`.
- `fields`: connection fields `{key,label,type,required?}`. Types: `text`, `url`, `textarea`, `secret`.
- `actions`: at least one `{id,label,description?,fields?}`. Action input supports text, URL and textarea fields.
- `async execute({action,config,input,user,fetch})`: return JSON-compatible data up to 128 KiB. `config` contains decrypted connection settings; `input` contains the selected action's input. `user.id` is the authorizing Giga admin. `fetch` is native Node.js fetch. Return a clear result with response status; do not return tokens or sensitive remote data unnecessarily.

The source is transformed using Node.js TypeScript type stripping. Use erasable types/interfaces and standard JavaScript syntax; enums, parameter properties and runtime namespaces are not supported. The module is imported from a data URL: relative imports and undeclared npm dependencies are not available. Native `node:` modules are available to trusted plugins. No API-provider whitelist is imposed. REST, GraphQL, SOAP/XML and custom HTTP authentication can be implemented in the module. Use AbortSignal timeouts and bound remote responses. Each invocation loads a fresh worker: persist connection settings through the provided configuration UI, not module globals.

Connection values are encrypted with the existing workspace encryption key. Secret fields never return through configuration-list responses; omitting a secret retains it, explicitly saving an empty string clears it. Known secret strings are redacted in results. Plugin exceptions are returned as stable error codes, without raw messages or traces. Source code is visible/downloadable only to Giga admins. Do not hard-code keys in the source.

Enable/disable/configuration changes use revisions to reject stale writes. Disable prevents new actions; already-running external requests cannot be undone. Their results are discarded if the plugin was changed, disabled or removed during execution. Deletion requires disabling first and removes its source/configuration. Lifecycle and execution events appear in the administration audit without configuration or response bodies.

Start with [http-service.ts](http-service.ts), or the matching Download example button. For custom schemes replace its `execute` implementation and fields. Existing built-in Drive/storage integrations remain independent.
