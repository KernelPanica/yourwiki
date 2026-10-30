import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { openDatabase, transaction } from '../src/database.ts';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'yourwiki-db-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'v2.sqlite3');
}

test('migrations persist and are idempotent with private database permissions', t => {
  const path = fixture(t);
  let db = openDatabase(path);
  db.prepare("INSERT INTO groups(id,name) VALUES('team','Team')").run();
  const count = db.prepare('SELECT count(*) AS n FROM schema_migrations').get();
  db.close();
  db = openDatabase(path); t.after(() => db.close());
  assert.equal((db.prepare("SELECT name FROM groups WHERE id='team'").get() as any).name, 'Team');
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM schema_migrations').get(), count);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('foreign database is refused without adding schema or changing journal mode', t => {
  const path = fixture(t);
  const original = new Sqlite(path);
  original.exec('CREATE TABLE wiki_document(id TEXT PRIMARY KEY)'); original.close();
  assert.throws(() => openDatabase(path), /foreign|legacy/i);
  const check = new Sqlite(path); t.after(() => check.close());
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'wiki_document' }]);
  assert.equal(check.pragma('journal_mode', { simple: true }), 'delete');
});

test('tampered migration checksums and future schemas are refused', t => {
  const path = fixture(t);
  let db = openDatabase(path);
  db.prepare("UPDATE schema_migrations SET checksum='wrong'").run(); db.close();
  assert.throws(() => openDatabase(path), /checksum/i);
  // A future version must fail explicitly rather than downgrading.
  db = new Sqlite(path);
  db.prepare("INSERT INTO schema_migrations(version,checksum) VALUES(999,'future')").run(); db.close();
  assert.throws(() => openDatabase(path), /newer|future/i);
});

test('FK enforcement and failed transactions leave no partial writes or epoch change', t => {
  const db = openDatabase(fixture(t)); t.after(() => db.close());
  assert.throws(() => db.prepare("INSERT INTO memberships(user_id,group_id) VALUES('missing','missing')").run(), /FOREIGN KEY/);
  const epoch = (db.prepare('SELECT acl_epoch FROM app_state').get() as any).acl_epoch;
  assert.throws(() => transaction(db, () => {
    db.prepare("INSERT INTO groups(id,name) VALUES('rolled-back','Rollback')").run();
    throw new Error('stop');
  }), /stop/);
  assert.equal(db.prepare("SELECT id FROM groups WHERE id='rolled-back'").get(), undefined);
  assert.equal((db.prepare('SELECT acl_epoch FROM app_state').get() as any).acl_epoch, epoch);
});

test('async transaction callbacks are rejected to prevent premature commits', t => {
  const db = openDatabase(fixture(t)); t.after(() => db.close());
  assert.throws(() => transaction(db, () => Promise.resolve(true)), /synchronous/i);
});

test('legacy sqlite-like names and view-only databases are refused', t => {
  for (const statement of ['CREATE TABLE sqliteXforeign(secret TEXT)', 'CREATE VIEW legacy_view AS SELECT 1 AS value']) {
    const path = fixture(t);
    const foreign = new Sqlite(path); foreign.exec(statement); foreign.close();
    assert.throws(() => openDatabase(path), /foreign|legacy/i);
    const check = new Sqlite(path);
    assert.equal(check.pragma('application_id', { simple: true }), 0);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    check.close();
  }
});

test('foreign application markers on an otherwise empty database are respected', t => {
  const path = fixture(t);
  const foreign = new Sqlite(path); foreign.pragma('application_id = 12345'); foreign.close();
  assert.throws(() => openDatabase(path), /foreign|legacy/i);
});
