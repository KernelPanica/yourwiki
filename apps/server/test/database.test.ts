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
test('version-seventeen active openings are grandfathered without changing tokens, rooms or earlier checksums',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,17).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Office','md',1,1)");old.prepare("INSERT INTO sessions(token_hash,csrf_hash,user_id,auth_version,expires_at) VALUES(?,?,'u',1,999999)").run('a'.repeat(64),'b'.repeat(64));old.prepare("INSERT INTO office_sessions(id,document_id,base_revision,base_digest,expires_at,created_at) VALUES('room','doc',1,?,999999,1)").run('c'.repeat(64));old.prepare("INSERT INTO office_tokens(token_hash,office_session_id,user_id,browser_session_hash,writable,expires_at) VALUES(?,'room','u',?,1,999999)").run('d'.repeat(64),'a'.repeat(64));old.prepare("INSERT INTO office_openings(browser_session_hash,open_id,document_id,state,office_session_id,capability_hash,created_at) VALUES(?,'old-ready-opening','doc','ready','room',?,1)").run('a'.repeat(64),'d'.repeat(64));old.prepare("INSERT INTO office_openings(browser_session_hash,open_id,document_id,state,created_at) VALUES(?,'old-pending-opening','doc','pending',2)").run('a'.repeat(64));const before=old.prepare('SELECT * FROM office_openings ORDER BY open_id').all() as any[],room=old.prepare('SELECT * FROM office_sessions').get(),token=old.prepare('SELECT * FROM office_tokens').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const db=openDatabase(path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM office_openings ORDER BY open_id').all(),before.map(row=>({...row,handoff_deadline:null,claimed_at:row.state==='ready'?row.created_at:null})));assert.deepEqual(db.prepare('SELECT * FROM office_sessions').get(),room);assert.deepEqual(db.prepare('SELECT * FROM office_tokens').get(),token);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=17 ORDER BY version').all(),checksums);const plan=db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM office_openings WHERE capability_hash=? AND office_session_id=? AND browser_session_hash=?').all('d'.repeat(64),'room','a'.repeat(64)) as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('office_openings_capability')));
});
test('version-eighteen upgrade adds empty personal visits without rewriting published state or prior checksums',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,18).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Preserved','md',1,1)");const document=old.prepare('SELECT * FROM documents').get(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const db=openDatabase(path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM documents').get(),document);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=18 ORDER BY version').all(),checksums);assert.deepEqual(db.prepare('SELECT * FROM document_visits').all(),[]);const plan=db.prepare('EXPLAIN QUERY PLAN SELECT document_id,opened_at FROM document_visits WHERE user_id=? AND (opened_at,document_id)<(?,?) ORDER BY opened_at DESC,document_id DESC LIMIT 201').all('u',1000,'doc') as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('document_visits_recent')));
});
test('version-nineteen history migration starts disabled and preserves existing technical versions and all checksums',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,19).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Preserved','md',1,1)");old.prepare("INSERT INTO document_versions(document_id,revision,digest,size,author_id,created_at) VALUES('doc',1,?,5,'u',1)").run('a'.repeat(64));old.prepare("INSERT INTO document_visits VALUES('u','doc',1)").run();const version=old.prepare('SELECT * FROM document_versions').get(),visits=old.prepare('SELECT * FROM document_visits').all(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const db=openDatabase(path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM document_versions').get(),version);assert.deepEqual(db.prepare('SELECT * FROM document_visits').all(),visits);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version').all(),checksums);assert.equal((db.prepare('SELECT history_enabled FROM app_state').get() as any).history_enabled,0);assert.deepEqual(db.prepare('SELECT * FROM history_entries').all(),[]);const plan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM history_entries WHERE document_id=? AND id<? ORDER BY id DESC LIMIT 201').all('doc',100) as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('history_entries_document')));
});
test('version-twenty preview migration preserves history and all earlier migration checksums',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,20).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,created_at) VALUES('doc','Old','md',1)");old.prepare("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by,captured_by_name,created_at) VALUES('doc','source',1,?,5,'Old','md','u','User',1)").run('a'.repeat(64));const entries=old.prepare('SELECT * FROM history_entries').all(),usage=old.prepare('SELECT * FROM history_usage').all(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const db=openDatabase(path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM history_entries').all(),entries);assert.deepEqual(db.prepare('SELECT * FROM history_usage').all(),usage);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=20 ORDER BY version').all(),checksums);assert.deepEqual(db.prepare('SELECT * FROM history_previews').all(),[]);const plan=db.prepare('EXPLAIN QUERY PLAN SELECT id FROM history_previews WHERE entry_id=? AND converter_version=? ORDER BY generation DESC LIMIT 1').all(1,'history-preview-v1') as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes('history_previews_latest')));
});
test('version-twenty-one restore migration preserves archive and published data with checksums intact',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,21).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,created_at) VALUES('doc','Old','md',1)");old.prepare("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES('doc','source',1,?,5,'Old','md','Deleted user',1)").run('a'.repeat(64));const entries=old.prepare('SELECT * FROM history_entries').all(),docs=old.prepare('SELECT * FROM documents').all(),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const db=openDatabase(path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM history_entries').all(),entries);assert.deepEqual(db.prepare('SELECT * FROM documents').all(),docs);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=21 ORDER BY version').all(),checksums);assert.deepEqual(db.prepare('SELECT * FROM history_restores').all(),[]);for(const [sql,args,index] of [["SELECT 1 FROM save_operations WHERE document_id=? AND state!='saved' AND cancelled_at IS NULL LIMIT 1",['doc'],'save_operations_document_pending'],["SELECT 1 FROM uploads WHERE state='active' AND json_extract(metadata,'$.documentId')=? AND expires_at>? LIMIT 1",['doc',0],'uploads_document_pending']] as const){const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args) as {detail:string}[];assert.ok(plan.some(row=>row.detail.includes(index)));}
});
test('version-twenty-two history rebuild preserves dependent receipts, generation counters, usage and sequence',t=>{
 const path=fixture(t),old=new Sqlite(path);old.pragma('foreign_keys = ON');old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,22).entries()){old.exec(sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}old.pragma(`application_id = ${applicationId}`);old.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,created_at) VALUES('doc','Old','md',1)");const insert=old.prepare("INSERT INTO history_entries(id,document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES(?,'doc','source',1,?,5,'Old','md','User',1)");insert.run(1,'a'.repeat(64));insert.run(500,'b'.repeat(64));old.prepare('DELETE FROM history_entries WHERE id=500').run();old.exec("INSERT INTO history_preview_generations VALUES(1,'history-preview-v1',7)");old.prepare("INSERT INTO history_previews(id,entry_id,document_id,converter_version,generation,source_digest,source_size,format,requested_by,state,reserved_bytes,created_at,last_access_at) VALUES('p',1,'doc','history-preview-v1',7,?,5,'md','u','failed',0,1,1)").run('a'.repeat(64));old.prepare("INSERT INTO history_restores(id,author_id,document_id,entry_id,base_revision,base_digest,layer_revision,target_digest,target_size,format,kind,state,created_at,updated_at) VALUES('restore','u','doc',1,1,?,0,?,5,'md','source','staged',1,1)").run('a'.repeat(64),'a'.repeat(64));const names=['history_entries','history_usage','history_preview_generations','history_previews','history_restores'],before=Object.fromEntries(names.map(name=>[name,old.prepare('SELECT * FROM '+name).all()])),checksums=old.prepare('SELECT * FROM schema_migrations ORDER BY version').all();old.close();const db=openDatabase(path);t.after(()=>db.close());for(const name of names)assert.deepEqual(db.prepare('SELECT * FROM '+name).all(),before[name]);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=22 ORDER BY version').all(),checksums);assert.equal(db.pragma('foreign_keys',{simple:true}),1);assert.deepEqual(db.pragma('foreign_key_check'),[]);const next=db.prepare("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES('doc','source',0,?,0,'Legacy','','Former',1)").run('c'.repeat(64));assert.equal(Number(next.lastInsertRowid),501);assert.equal((db.prepare("SELECT entry_count FROM history_usage WHERE document_id='doc'").get() as any).entry_count,2);assert.throws(()=>db.prepare('UPDATE history_entries SET source_revision=2 WHERE id=1').run(),/immutable/i);assert.throws(()=>db.prepare("DELETE FROM history_entries WHERE id=1").run(),/FOREIGN KEY/);
});
function version22Fixture(t:any){const path=fixture(t),db=new Sqlite(path);db.pragma('foreign_keys = ON');db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL)');for(const [index,sql] of migrations.slice(0,22).entries()){db.exec(sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,createHash('sha256').update(sql).digest('hex'));}db.pragma(`application_id = ${applicationId}`);db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','u','g');INSERT INTO documents(id,title,format,created_at) VALUES('doc','Old','md',1)");return {path,db};}
test('empty history rebuild never reuses a deleted public receipt identity',t=>{
 const f=version22Fixture(t);f.db.prepare("INSERT INTO history_entries(id,document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES(700,'doc','source',1,?,0,'Old','md','User',1)").run('a'.repeat(64));f.db.exec('DELETE FROM history_entries');f.db.close();const db=openDatabase(f.path);t.after(()=>db.close());const next=db.prepare("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES('doc','source',1,?,0,'New','md','User',1)").run('b'.repeat(64));assert.equal(Number(next.lastInsertRowid),701);
});
test('history rebuild refuses preexisting FK corruption and rolls back the entire schema migration',t=>{
 const f=version22Fixture(t),oldSql=f.db.prepare("SELECT sql FROM sqlite_master WHERE name='history_entries'").get(),checksums=f.db.prepare('SELECT * FROM schema_migrations').all();f.db.pragma('foreign_keys = OFF');f.db.prepare("INSERT INTO resources(id,kind,owner_id,group_id) VALUES('broken','folder','missing','g')").run();f.db.close();assert.throws(()=>openDatabase(f.path),/foreign key validation/i);const db=new Sqlite(f.path);t.after(()=>db.close());assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='history_entries'").get(),oldSql);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),checksums);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='history_legacy_metadata'").get(),undefined);assert.equal((db.prepare("SELECT COUNT(*) AS n FROM resources WHERE id='broken'").get() as any).n,1);
});
test('SIGKILL during parent-table rebuild rolls back before restart applies the complete migration',async t=>{
 const f=version22Fixture(t);f.db.prepare("INSERT INTO history_entries(id,document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES(1,'doc','source',1,?,7,'Old','md','User',1)").run('a'.repeat(64));f.db.exec("INSERT INTO history_preview_generations VALUES(1,'history-preview-v1',9)");const before=f.db.prepare('SELECT * FROM history_entries').all(),usage=f.db.prepare('SELECT * FROM history_usage').all();f.db.close();const {spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url'),{once}=await import('node:events'),{createInterface}=await import('node:readline');const child=spawn(process.execPath,[fileURLToPath(new URL('./support/history-migration-crash-child.ts',import.meta.url)),f.path],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk).slice(0,1000);});const lines=createInterface({input:child.stdout});const reached=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Migration child timeout '+errors)),10000);lines.once('line',line=>{clearTimeout(timer);resolve(line);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Migration child exited '+errors));});});assert.equal(reached,'parent-dropped-uncommitted');const exit=once(child,'exit');child.kill('SIGKILL');assert.equal((await exit)[1],'SIGKILL');lines.close();const db=openDatabase(f.path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM history_entries').all(),before);assert.deepEqual(db.prepare('SELECT * FROM history_usage').all(),usage);assert.equal((db.prepare('SELECT generation FROM history_preview_generations WHERE entry_id=1').get() as any).generation,9);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('foreign_keys',{simple:true}),1);
});
test('version-twenty-three import staging preserves old history metadata and all checksums',t=>{
 const f=version22Fixture(t);f.db.pragma('foreign_keys=OFF');f.db.exec(migrations[22]!);f.db.prepare('INSERT INTO schema_migrations VALUES(23,?)').run(createHash('sha256').update(migrations[22]!).digest('hex'));f.db.pragma('foreign_keys=ON');f.db.prepare("INSERT INTO history_entries(id,document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES(1,'doc','source',0,?,0,'Legacy','','Former',1)").run('a'.repeat(64));f.db.exec("INSERT INTO history_legacy_metadata VALUES(1,'{}')");const entries=f.db.prepare('SELECT * FROM history_entries').all(),metadata=f.db.prepare('SELECT * FROM history_legacy_metadata').all(),checksums=f.db.prepare('SELECT * FROM schema_migrations').all();f.db.close();const db=openDatabase(f.path);t.after(()=>db.close());assert.deepEqual(db.prepare('SELECT * FROM history_entries').all(),entries);assert.deepEqual(db.prepare('SELECT * FROM history_legacy_metadata').all(),metadata);assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=23').all(),checksums);assert.deepEqual(db.prepare('SELECT * FROM history_imports').all(),[]);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('foreign_keys',{simple:true}),1);
});
