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

test('version-ten office identity and pending recovery survive ingress migration',t=>{
 const path=fixture(t),original=new Sqlite(path);original.pragma('foreign_keys = ON');original.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
 for(const [index,sql] of migrations.slice(0,10).entries()){original.exec(sql);original.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}
 original.pragma(`application_id = ${applicationId}`);
 original.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','owner','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Old office','md',1,1)");
 original.prepare("INSERT INTO save_operations(id,document_id,author_id,base_revision,base_digest,digest,size,state,created_at,updated_at) VALUES('pending','doc','owner',1,?,?,1,'staged',1,1)").run('a'.repeat(64),'b'.repeat(64));
 original.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,pending_operation_id,created_at) VALUES('office','doc',1,?,1000,'pending',1)").run('a'.repeat(64));
 original.prepare("UPDATE save_operations SET office_session_id='office' WHERE id='pending'").run();const before=original.prepare('SELECT * FROM office_sessions').get();original.close();
 const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM office_sessions').get(),{...(before as Record<string,unknown>),prepared_id:null});assert.equal((migrated.prepare("SELECT office_session_id FROM save_operations WHERE id='pending'").get() as any).office_session_id,'office');assert.deepEqual(migrated.prepare('SELECT * FROM office_ingress').all(),[]);
});

test('version-eleven prepared office data survives cleanup migration without being cancelled',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
 for(const [index,sql] of migrations.slice(0,11).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);
 old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");
 old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES('office','doc',1,?,1000,1)").run('a'.repeat(64));
 old.prepare("INSERT INTO save_operations(id,document_id,author_id,base_revision,base_digest,digest,size,state,created_at,updated_at,office_session_id) VALUES('write','doc','u',1,?,?,3,'staged',1,1,'office')").run('a'.repeat(64),'b'.repeat(64));
 old.prepare("INSERT INTO office_ingress(id,document_id,office_session_id,author_id,base_revision,base_digest,lock_value,declared_size,reserved_bytes,state,digest,size,lease_token,lease_until,created_at) VALUES('write','doc','office','u',1,?,'lock',3,3,'prepared',?,3,'lease',1000,1)").run('a'.repeat(64),'b'.repeat(64));
 const before=old.prepare('SELECT * FROM office_ingress').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();
 const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM office_ingress').get(),{...(before as Record<string,unknown>),client_tag:null,committed_revision:null});assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=11 ORDER BY version').all(),checksums);assert.equal((migrated.prepare("SELECT cancelled_at FROM save_operations WHERE id='write'").get() as any).cancelled_at,null);
});

test('version-twelve prepared recovery and checksums survive the recovery-list index migration',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
 for(const [index,sql] of migrations.slice(0,12).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);
 old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");
 old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES('office','doc',1,?,1000,1)").run('a'.repeat(64));
 old.prepare("INSERT INTO office_ingress(id,document_id,office_session_id,author_id,base_revision,base_digest,lock_value,declared_size,reserved_bytes,state,digest,size,lease_token,lease_until,created_at) VALUES('write','doc','office','u',1,?,'lock',3,3,'prepared',?,3,'lease',1000,1)").run('a'.repeat(64),'b'.repeat(64));
 const before=old.prepare('SELECT * FROM office_ingress').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();
 const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM office_ingress').get(),{...(before as Record<string,unknown>),client_tag:null,committed_revision:null});assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=12 ORDER BY version').all(),checksums);
 const plan=migrated.prepare("EXPLAIN QUERY PLAN SELECT * FROM office_ingress WHERE document_id=? AND id>? AND (state='receiving' OR (state IN ('prepared','failed') AND digest IS NOT NULL)) ORDER BY id LIMIT 51").all('doc','') as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('office_ingress_recovery')));
});

test('version-thirteen office identity survives prepared-source migration with prior checksums intact',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');
 for(const [index,sql] of migrations.slice(0,13).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);
 old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES('office','doc',1,?,1000,1)").run('a'.repeat(64));
 const before=old.prepare('SELECT * FROM office_sessions').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM office_sessions').get(),{...(before as Record<string,unknown>),prepared_id:null});assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=13 ORDER BY version').all(),checksums);assert.deepEqual(migrated.prepare('SELECT * FROM office_prepared').all(),[]);
});

test('version-fourteen prepared bindings survive an indexed active-room lookup migration',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,14).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);
 old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");
 old.prepare("INSERT INTO office_prepared(id,document_id,source_revision,source_digest,format,converter_version,state,digest,size,reserved_bytes,lease_token,lease_until,created_at,last_access_at) VALUES('p','doc',1,?,'md','office-transit-v1','ready',?,3,3,'lease',1000,1,1)").run('a'.repeat(64),'b'.repeat(64));old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at,prepared_id) VALUES('office','doc',1,?,1000,1,'p')").run('a'.repeat(64));
 const receipt=old.prepare('SELECT * FROM office_prepared').get(),room=old.prepare('SELECT * FROM office_sessions').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM office_prepared').get(),receipt);assert.deepEqual(migrated.prepare('SELECT * FROM office_sessions').get(),room);assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=14 ORDER BY version').all(),checksums);
 const plan=migrated.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM office_sessions WHERE prepared_id=? AND (expires_at>? OR pending_operation_id IS NOT NULL)').all('p',0) as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('office_sessions_prepared')));
});


test('version-fifteen pending office bytes survive save-correlation migration without a forged receipt',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,15).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);
 old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES('office','doc',1,?,1000,1)").run('a'.repeat(64));old.prepare("INSERT INTO office_ingress(id,document_id,office_session_id,author_id,base_revision,base_digest,lock_value,declared_size,reserved_bytes,state,digest,size,lease_token,lease_until,created_at) VALUES('write','doc','office','u',1,?,'lock',3,3,'prepared',?,3,'lease',1000,1)").run('a'.repeat(64),'b'.repeat(64));
 const before=old.prepare('SELECT * FROM office_ingress').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const migrated=openDatabase(path);t.after(()=>migrated.close());assert.deepEqual(migrated.prepare('SELECT * FROM office_ingress').get(),{...(before as Record<string,unknown>),client_tag:null,committed_revision:null});assert.deepEqual(migrated.prepare('SELECT * FROM schema_migrations WHERE version<=15 ORDER BY version').all(),checksums);assert.deepEqual(migrated.prepare('SELECT * FROM office_save_intents').all(),[]);
 const plan=migrated.prepare("EXPLAIN QUERY PLAN SELECT id FROM office_ingress WHERE office_session_id=? AND client_tag=? AND state='committed' AND committed_revision IS NOT NULL ORDER BY rowid ASC LIMIT 1").all('office','tag') as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('office_ingress_client_tag')));
});
test('version-sixteen rooms and capabilities survive the append-only opening cancellation migration',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,16).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);
 old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");old.prepare("INSERT INTO sessions(token_hash,csrf_hash,user_id,auth_version,expires_at) VALUES(?,?,'u',1,999999)").run('a'.repeat(64),'b'.repeat(64));old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES('room','doc',1,?,999999,1)").run('c'.repeat(64));old.prepare("INSERT INTO office_tokens(token_hash,office_session_id,user_id,browser_session_hash,writable,expires_at) VALUES(?,'room','u',?,1,999999)").run('d'.repeat(64),'a'.repeat(64));const room=old.prepare('SELECT * FROM office_sessions').get(),token=old.prepare('SELECT * FROM office_tokens').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();
 const db=openDatabase(path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM office_sessions').get(),room);assert.deepEqual(db.prepare('SELECT * FROM office_tokens').get(),token);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=16 ORDER BY version').all(),checksums);assert.deepEqual(db.prepare('SELECT * FROM office_openings').all(),[]);const plan=db.prepare('EXPLAIN QUERY PLAN SELECT token_hash FROM sessions WHERE csrf_hash=?').all('b'.repeat(64)) as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('sessions_csrf_lookup')));
});
