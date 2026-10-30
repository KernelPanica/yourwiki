import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {migrations,applicationId} from '../src/schema.ts';
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


test('an existing version-eight workspace gains the save journal without rewriting prior migrations or records',t=>{
 const path=fixture(t),original=new Sqlite(path);
 original.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
 for(const [index,sql] of migrations.slice(0,8).entries()){
  original.exec(sql);original.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));
 }
 original.pragma(`application_id = ${applicationId}`);
 original.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('old-user','old-user','Existing user','!'); INSERT INTO groups VALUES('old-group','Existing group'); INSERT INTO memberships VALUES('old-user','old-group')");
 const checksums=original.prepare('SELECT * FROM schema_migrations ORDER BY version').all();original.close();
 const migrated=openDatabase(path);t.after(()=>migrated.close());
 assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=8 ORDER BY version').all(),checksums);
 assert.equal((migrated.prepare("SELECT display_name FROM users WHERE id='old-user'").get() as any).display_name,'Existing user');
 assert.equal((migrated.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id='old-user'").get() as any).n,1);
 assert.deepEqual(migrated.prepare('SELECT * FROM save_operations').all(),[]);
});


test('version-nine journal rows survive office-session migration with an empty internal binding',t=>{
 const path=fixture(t),original=new Sqlite(path);original.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
 for(const [index,sql] of migrations.slice(0,9).entries()){original.exec(sql);original.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}
 original.pragma(`application_id = ${applicationId}`);
 original.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'); INSERT INTO groups VALUES('g','Group'); INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','owner','g'); INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Old journal','md',1,1)");
 original.prepare('INSERT INTO save_operations(id,document_id,author_id,base_revision,base_digest,digest,size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,1,1)').run('old-operation','doc','owner',1,'a'.repeat(64),'b'.repeat(64),'staged');
 const checksums=original.prepare('SELECT * FROM schema_migrations ORDER BY version').all();original.close();
 const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=9 ORDER BY version').all(),checksums);
 const row=migrated.prepare("SELECT state,digest,office_session_id FROM save_operations WHERE id='old-operation'").get();assert.deepEqual(row,{state:'staged',digest:'b'.repeat(64),office_session_id:null});
});
