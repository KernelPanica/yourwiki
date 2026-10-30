"""Standalone tests: python -m unittest discover -s tests -p test_migration_audit.py."""
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing, contextmanager, redirect_stderr, redirect_stdout

from tools.migration_audit import AuditError, audit_database, main


class MigrationAuditTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'backup #1?.sqlite3'
        with self.database() as db:
            db.executescript('''
                CREATE TABLE wiki_user(id INTEGER PRIMARY KEY, password TEXT);
                CREATE TABLE wiki_workspace(id INTEGER PRIMARY KEY, encrypted_config TEXT);
                CREATE TABLE wiki_document(id TEXT PRIMARY KEY, owner_id INTEGER REFERENCES wiki_user(id));
                INSERT INTO wiki_user VALUES(1, 'secret-password-hash');
                INSERT INTO wiki_workspace VALUES(1, 'secret-provider-token');
                INSERT INTO wiki_document VALUES('document-one', 1);
            ''')

    @contextmanager
    def database(self):
        with closing(sqlite3.connect(self.path)) as db:
            with db:
                yield db

    def test_missing_input_is_not_created(self):
        missing = self.path.parent / 'absent.sqlite3'
        with self.assertRaises(AuditError):
            audit_database(missing)
        self.assertFalse(missing.exists())

    def test_counts_do_not_export_row_values(self):
        result = audit_database(self.path)
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(result['tables'], [
            {'name': 'wiki_document', 'count': 1},
            {'name': 'wiki_user', 'count': 1},
            {'name': 'wiki_workspace', 'count': 1},
        ])
        encoded = json.dumps(result)
        for secret in ('secret-password-hash', 'secret-provider-token', 'document-one'):
            self.assertNotIn(secret, encoded)

    def test_audit_does_not_modify_backup_or_create_sidecars(self):
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        names = sorted(p.name for p in self.path.parent.iterdir())
        audit_database(self.path)
        audit_database(self.path)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)
        self.assertEqual(sorted(p.name for p in self.path.parent.iterdir()), names)

    def test_foreign_key_violation_is_reported(self):
        with self.database() as db:
            db.execute("INSERT INTO wiki_document VALUES('dangling', 999)")
        self.assertEqual(audit_database(self.path)['foreignKeyViolations'], [
            {'table': 'wiki_document', 'rowid': 2, 'parent': 'wiki_user', 'fkid': 0},
        ])

    def test_absent_pending_tables_are_unknown_not_zero(self):
        result = audit_database(self.path)
        self.assertIsNone(result['pendingCounts']['saveSessions'])
        self.assertEqual(result['capabilities']['saveSessions']['status'], 'missingTable')

    def test_pending_operations_are_counted_independently(self):
        with self.database() as db:
            db.executescript('''
                CREATE TABLE wiki_savesession(state TEXT);
                INSERT INTO wiki_savesession VALUES('saved'), ('pending'), ('conflict'), ('unknown');
                CREATE TABLE wiki_officesession(pending BLOB);
                INSERT INTO wiki_officesession VALUES(X''), (X'0102');
                CREATE TABLE wiki_writeattempt(state TEXT);
                INSERT INTO wiki_writeattempt VALUES('acknowledged'), ('unknown');
                CREATE TABLE wiki_providertrashstate(confirmed BOOL);
                INSERT INTO wiki_providertrashstate VALUES(0), (1);
            ''')
        result = audit_database(self.path)
        self.assertEqual(result['pendingCounts'], {
            'saveSessions': 3, 'officeRecoveryCopies': 1,
            'writeAttempts': 1, 'providerTrashUnconfirmed': 1,
        })
        self.assertTrue(all(v['status'] == 'available' for v in result['capabilities'].values()))

    def test_missing_column_is_unknown_not_an_sql_error(self):
        with self.database() as db:
            db.execute('CREATE TABLE wiki_savesession(old_state TEXT)')
        result = audit_database(self.path)
        self.assertIsNone(result['pendingCounts']['saveSessions'])
        self.assertEqual(result['capabilities']['saveSessions']['status'], 'missingColumns')

    def test_quoted_table_name_does_not_break_counting(self):
        with self.database() as db:
            db.execute('CREATE TABLE "unusual""table"(id INTEGER)')
            db.execute('INSERT INTO "unusual""table" VALUES (1)')
        self.assertIn({'name': 'unusual"table', 'count': 1}, audit_database(self.path)['tables'])

    def test_non_database_and_empty_database_fail_explicitly(self):
        for content in (b'not a database secret-provider-token', b''):
            self.path.write_bytes(content)
            with self.assertRaises(AuditError):
                audit_database(self.path)

    def test_unrelated_database_is_not_a_valid_workspace(self):
        self.path.unlink()
        with self.database() as db:
            db.execute('CREATE TABLE unrelated(id INTEGER)')
        with self.assertRaises(AuditError):
            audit_database(self.path)

    def test_uncheckpointed_sidecars_are_rejected_without_deletion(self):
        for suffix in ('-wal', '-journal'):
            sidecar = Path(str(self.path) + suffix)
            sidecar.write_bytes(b'pending data')
            with self.assertRaises(AuditError):
                audit_database(self.path)
            self.assertEqual(sidecar.read_bytes(), b'pending data')
            sidecar.unlink()

    def test_cli_valid_json_without_secrets(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main([str(self.path)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['foreignKeyViolations'], [])
        self.assertEqual(stderr.getvalue(), '')

    def test_cli_invalid_input_does_not_print_payload_or_traceback(self):
        self.path.write_bytes(b'confidential-provider-token')
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main([str(self.path)])
        self.assertNotEqual(code, 0)
        self.assertEqual(stdout.getvalue(), '')
        self.assertNotIn('confidential-provider-token', stderr.getvalue())
        self.assertNotIn('Traceback', stderr.getvalue())

    def test_cli_fk_violations_are_not_success(self):
        with self.database() as db:
            db.execute("INSERT INTO wiki_document VALUES('dangling', 999)")
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(main([str(self.path)]), 2)


if __name__ == '__main__':
    unittest.main()
