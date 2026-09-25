# Filesystem mountpoints

The installer connects the first provider at `/`. On upgrade, migration 0009
adopts the existing provider as the root mount without moving or deleting data.
Accounts, permissions, sessions, and mount configuration remain in SQLite.

Administrators can open **Menu → Mountpoints** to connect local directories,
Google Drive, OneDrive, GitHub, SMB, or SFTP. Choose a provider, enter a mount
path such as `/projects/archive`, and fill in its connection settings.
Connections are tested before they are saved, and credentials are encrypted.
Google Drive and OneDrive additional mounts require a folder ID and OAuth
client credentials plus a refresh token; root installation still provides
the existing browser authorization flow.

Mount paths are absolute paths within the wiki, not host filesystem paths.
Parent directories are created when missing. An existing mount destination
must be empty. Nested mounts are supported: `/projects/archive` takes
precedence over `/projects`, which takes precedence over `/`.
Matching respects directory boundaries, so `/projects-other` stays on root.

The explorer shows directories and wiki-managed files. Create, upload, or
import files to add them; pre-existing external files are not automatically
indexed, and external changes are not watched. Current revisions are written
under their directory paths with unique revision names to prevent collisions.

## Local directories in Docker

The default root uses the persistent `documents` volume at `/documents`.
For an additional host directory, add a bind mount to the `x-app.volumes`
list in `compose.yaml`, for example:

```yaml
- /srv/wiki-archive:/mnt/archive
```

Recreate the container, then connect `/mnt/archive` as the provider directory
at a wiki mount path such as `/archive`. The host directory must be writable
by the container user. A directory outside a persistent volume will not
persist across container replacement; the default container filesystem is
read-only.

## Moves and credentials

Drag files or ordinary directories onto destinations in the explorer, or use
their Move action with keyboard or touch. Cross-mount moves copy the current
document and attachments before updating their references. Failure keeps the
original catalog location. Older revisions remain on the source provider for
recovery; moving does not purge backups.

Mountpoints and directories containing mounts cannot be renamed or moved.
Move their files out and unmount before reorganizing those paths. The root
mount cannot be removed. Unmounting requires an empty directory and no active
file references or pending cleanup tasks. It retains the provider files and
the logical empty directory.

**Credentials** updates authentication without changing the provider identity
or root. To change providers, create a new mount and move files to it.
The legacy `/storage/` URL opens mount management.

Back up the SQLite database, encryption key, and every provider's content.
`python manage.py doctor --storage` probes all mounts.

## Interface verification

Perspective tokens come from `DESIGN.md`: white layered surfaces, blue
accents, Poppins body text, Oswald headings, and JetBrains Mono paths.
Fonts and licenses are served locally. Dark ink is used on the bright green
primary button; darker green is used for text on white to meet contrast.

- Check the explorer, library, mount form, login, admin forms, and editors.
- Verify keyboard focus, labeled icon buttons, and the non-drag Move action.
- Check 320px width, long names, empty directories, and expanded nested paths.
- Confirm reduced-motion settings suppress interaction transitions.
- Run backend mount tests and opt-in Chromium browser tests before release.
