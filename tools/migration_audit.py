"""Inspect a standalone Yourwiki SQLite backup without loading Django or secrets.

Usage: python tools/migration_audit.py /path/to/backup.sqlite3
Exit codes: 0 valid, 1 unreadable/incompatible backup, 2 foreign-key violations.
Only use a backup created via SQLite's backup API, not an active database.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys


class AuditError(Exception):
    """A safe diagnostic that never contains database row values."""


# Missing operations in older schemas must remain unknown rather than zero.
_OPERATIONS = {
    'saveSessions': ('wiki_savesession', {'state'}, '"state" IS NULL OR "state" != \'saved\''),
    'officeRecoveryCopies': ('wiki_officesession', {'pending'}, 'length("pending") > 0'),
    'writeAttempts': ('wiki_writeattempt', {'state'}, '"state" IS NULL OR "state" != \'acknowledged\''),
    'providerTrashUnconfirmed': ('wiki_providertrashstate', {'confirmed'}, '"confirmed" IS NULL OR "confirmed" = 0'),
}
_REQUIRED = {'wiki_user', 'wiki_workspace', 'wiki_document'}


def _identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def audit_database(path: Path) -> dict:
    """Count entities and pending operations in a quiescent, standalone backup.

    immutable prevents SQLite from writing WAL/SHM sidecars. A nonempty WAL or
    rollback journal is rejected, because ignoring it could omit accepted data.
    The caller must prevent concurrent replacement or writes to the backup.
    """
    try:
        path = Path(path).resolve(strict=True)
        if not path.is_file() or path.stat().st_size == 0:
            raise AuditError('Expected a nonempty standalone SQLite backup.')
        for suffix in ('-wal', '-journal'):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists() and sidecar.stat().st_size:
                raise AuditError('Active SQLite sidecar detected. Create a standalone backup first.')
        uri = path.as_uri() + '?mode=ro&immutable=1'
        with closing(sqlite3.connect(uri, uri=True)) as db:
            db.execute('PRAGMA query_only = ON')
            if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise AuditError('SQLite integrity check failed.')
            tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
            )}
            if not _REQUIRED.issubset(tables):
                raise AuditError('Not a supported Yourwiki backup: required tables are missing.')
            counts = [
                {'name': name, 'count': db.execute(f'SELECT COUNT(*) FROM {_identifier(name)}').fetchone()[0]}
                for name in sorted(tables)
            ]
            violations = [dict(zip(('table', 'rowid', 'parent', 'fkid'), row))
                          for row in db.execute('PRAGMA foreign_key_check')]
            pending, capabilities = {}, {}
            for name, (table, required, predicate) in _OPERATIONS.items():
                pending[name] = None
                if table not in tables:
                    capabilities[name] = {'status': 'missingTable'}
                    continue
                columns = {row[1] for row in db.execute(f'PRAGMA table_info({_identifier(table)})')}
                if not required.issubset(columns):
                    capabilities[name] = {'status': 'missingColumns'}
                    continue
                pending[name] = db.execute(
                    f'SELECT COUNT(*) FROM {_identifier(table)} WHERE {predicate}'
                ).fetchone()[0]
                capabilities[name] = {'status': 'available'}
            return {'schemaVersion': 1, 'tables': counts,
                    'foreignKeyViolations': violations, 'pendingCounts': pending,
                    'capabilities': capabilities}
    except (OSError, sqlite3.Error, ValueError):
        # SQLite/OS diagnostics can include untrusted identifiers or paths.
        raise AuditError('Cannot read a valid standalone Yourwiki SQLite backup.') from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', type=Path)
    args = parser.parse_args(argv)
    try:
        result = audit_database(args.backup)
    except AuditError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result['foreignKeyViolations'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
