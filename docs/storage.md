# Storage provider setup

All connections are direct Python adapters. Set up one dedicated location per workspace and do not edit its managed files outside Yourwiki. The administrator's storage credentials authorize the server; every member still passes the wiki's own permission checks. A provider account's sharing permissions do not replace wiki permissions.

## Local

The installer uses `/documents` in Docker, backed by the persistent `documents` volume. The local SQLite database remains separately in `/data/wiki.sqlite3`.

## Google Drive

Create a Google Cloud project, enable the Drive API, configure its OAuth consent screen, and create a Web application OAuth client. Add this exact authorized redirect URI:

`https://YOUR-WIKI-HOST/setup/oauth/callback`

Enter the client ID and secret when prompted. Open the installer-generated URL, authorize your Google account, and return to the terminal. Yourwiki requests `https://www.googleapis.com/auth/drive.file` with offline access and creates a new `Yourwiki` folder. It does not request access to arbitrary existing Drive files. Refresh tokens are encrypted at rest.

Your OAuth application's publishing/test-user configuration determines who can authorize and how long its credentials remain valid. Configure the consent screen for your intended deployment. See [Google's web-server OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server).

## OneDrive

Register a Web application in Microsoft Entra. Select account types appropriate for your Microsoft account/organization, add the same callback path on your public origin, and create a client secret. Enter its client ID, secret, and tenant (`common` by default). Authorize in the browser using the URL printed by setup.

The adapter requests delegated `Files.ReadWrite` and `offline_access`, uses the signed-in account's default drive through Microsoft Graph, and creates a dedicated folder. It supports personal and organizational accounts with an accessible OneDrive. SharePoint site/library selection is not implemented. See [Microsoft's authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

## GitHub

Provide `owner/repository`, an existing writable branch, a dedicated relative path prefix, and a fine-grained personal access token with repository Contents read/write permission. Each revision is committed through the Contents API. Branch protection must permit this token to write to the selected branch. Only files within the prefix are managed; there is no repository checkout or pull-request workflow.

## SMB

Provide server hostname, port (445 by default), existing share and directory, username/password, and optional domain. The server must support SMB2/SMB3 and signing. The adapter connects directly using Python `smbprotocol`; the Docker container needs network access to the share. The installer does not mount it on the host or create a share.

## SFTP

Provide hostname, port (22 by default), existing absolute directory, username, and a password or private key. For key authentication, mount a key file into the setup container and enter its container path; its contents are encrypted into the connection configuration. An encrypted key's passphrase can be supplied interactively.

Also supply a verified server host key in `ssh-ed25519 BASE64...` (or other supported key type) format, obtained from your server administrator. Unknown or changed keys are rejected. Do not rely on an unverified key scan as proof of identity.

## Live provider tests

Set `YOURWIKI_STORAGE_TEST_CONFIG` to a private JSON file containing selected provider configurations. Tests create/update/delete only unique `.yourwiki-probe-*` files; use dedicated test locations. Do not commit this file.

```json
{
  "local": {"provider": "local", "root": "/tmp/wiki-test-docs"},
  "github": {
    "provider": "github", "repository": "owner/test-repo",
    "branch": "main", "root": "wiki-tests", "token": "YOUR_TOKEN"
  },
  "sftp": {
    "provider": "sftp", "host": "sftp.example.com", "port": 22,
    "root": "/srv/wiki-tests", "username": "wiki", "password": "YOUR_PASSWORD",
    "host_key": "ssh-ed25519 VERIFIED_BASE64_KEY"
  },
  "smb": {
    "provider": "smb", "host": "fileserver", "port": 445,
    "share": "docs", "root": "wiki-tests", "username": "wiki",
    "password": "YOUR_PASSWORD", "domain": ""
  }
}
```

Google and OneDrive test configs use `provider`, `client_id`, `client_secret`, `refresh_token`, and `root` (the provider folder ID); OneDrive optionally adds `tenant`. Live tests do not persist rotated refresh tokens, so use disposable test authorization and reauthorize if needed.

```sh
YOURWIKI_STORAGE_TEST_CONFIG=/private/storage-test.json \
  .venv/bin/python -m pytest tests/test_live_storage.py -q
```
