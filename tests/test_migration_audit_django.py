"""Exercise the standalone auditor against Django's actual migrated schema."""
from contextlib import closing
import sqlite3

from django.db import connection

from tools.migration_audit import audit_database


def test_real_django_backup_has_identity_counts_and_pending_capabilities(document, tmp_path):
    backup = tmp_path / 'backup.sqlite3'
    # Read the transaction-visible schema/data into a separate SQLite snapshot.
    with closing(sqlite3.connect(backup)) as target:
        target.executescript('\n'.join(connection.connection.iterdump()))
    result = audit_database(backup)
    counts = {row['name']: row['count'] for row in result['tables']}
    assert counts['wiki_user'] == 3
    assert counts['wiki_document'] == 1
    assert result['foreignKeyViolations'] == []
    assert all(value['status'] == 'available' for value in result['capabilities'].values())
    assert result['pendingCounts']['saveSessions'] == 0
    assert result['pendingCounts']['officeRecoveryCopies'] == 0
