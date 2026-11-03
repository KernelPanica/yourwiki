import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../src/database.ts';
import { AccessService } from '../src/access.ts';

function fixture(t: any, path = ':memory:') {
  const db = openDatabase(path); t.after(() => db.close());
  db.exec(`INSERT INTO groups(id,name) VALUES('team','Team'),('other','Other');
    INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES
    ('owner','owner','Owner','!', 'member'),('reader','reader','Reader','!','member'),
    ('simple','simple','Simple','!','simple'),('giga','giga','Giga','!','giga');
    INSERT INTO memberships VALUES('reader','team');
    INSERT INTO resources(id,kind,owner_id,group_id) VALUES('root','folder','owner','team');
    INSERT INTO resources(id,kind,parent_id,owner_id,group_id) VALUES('child','document','root','owner','team');`);
  return { db, access: new AccessService(db) };
}
const policy = (groupRead: boolean, groupWrite = false) => JSON.stringify({
  owner: { read: true, write: true }, group: { read: groupRead, write: groupWrite }, everyone: { read: false, write: false },
});

test('root defaults, write implies read, explicit child policy overrides ancestors', t => {
  const { db, access } = fixture(t);
  assert.equal(access.allows('reader', 'child', 'read'), true);
  assert.equal(access.allows('reader', 'child', 'write'), false);
  db.prepare('UPDATE resources SET inherit_permissions=0,policy=? WHERE id=?').run(policy(false), 'root');
  assert.equal(access.allows('reader', 'child', 'read'), false);
  db.prepare('UPDATE resources SET inherit_permissions=0,policy=? WHERE id=?').run(policy(false, true), 'child');
  assert.equal(access.allows('reader', 'child', 'read'), true);
  assert.equal(access.allows('reader', 'child', 'write'), true);
});

test('personal deny overrides groups and inherited personal rules stop at explicit boundary', t => {
  const { db, access } = fixture(t);
  db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({ reader: { read: false, write: false } }), 'root');
  assert.equal(access.allows('reader', 'child', 'read'), false);
  db.prepare('UPDATE resources SET inherit_permissions=0,policy=? WHERE id=?').run(policy(true), 'child');
  assert.equal(access.allows('reader', 'child', 'read'), true);
  db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({ reader: { read: false, write: true } }), 'child');
  assert.equal(access.allows('reader', 'child', 'write'), true);
});

test('matched additional groups override scope fallback with any matching allow', t => {
  const { db, access } = fixture(t);
  db.prepare('UPDATE resources SET inherit_permissions=0,policy=?,group_policies=? WHERE id=?')
    .run(policy(true), JSON.stringify({ team: { read: false, write: false }, other: { read: true, write: true } }), 'root');
  assert.equal(access.allows('reader', 'child', 'read'), false);
  db.prepare("INSERT INTO memberships VALUES('reader','other')").run();
  assert.equal(access.allows('reader', 'child', 'write'), true);
});

test('export restrictions inherit independently; only giga bypasses export bans', t => {
  const { db, access } = fixture(t);
  db.prepare('UPDATE resources SET inherit_permissions=0,policy=? WHERE id=?').run(policy(true), 'child');
  db.prepare("UPDATE resources SET export_disabled=1 WHERE id='root'").run();
  assert.equal(access.allows('reader', 'child', 'export'), false);
  assert.equal(access.allows('simple', 'child', 'read'), true);
  assert.equal(access.allows('simple', 'child', 'export'), false);
  assert.equal(access.allows('giga', 'child', 'export'), true);
  db.prepare("UPDATE resources SET trashed=1 WHERE id='root'").run();
  assert.equal(access.allows('giga', 'child', 'read'), false);
});

test('changes from another connection immediately invalidate cached permissions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yourwiki-acl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'v2.sqlite3');
  const { access } = fixture(t, path);
  const writer = openDatabase(path); t.after(() => writer.close());
  assert.equal(access.allows('reader', 'child', 'read'), true);
  writer.prepare("DELETE FROM memberships WHERE user_id='reader'").run();
  assert.equal(access.allows('reader', 'child', 'read'), false);
  writer.prepare("INSERT INTO memberships VALUES('reader','team')").run();
  assert.equal(access.allows('reader', 'child', 'read'), true);
  writer.prepare("UPDATE users SET active=0 WHERE id='reader'").run();
  assert.equal(access.allows('reader', 'child', 'read'), false);
});

test('rollback, malformed policy, missing parent and cycles never grant access', t => {
  const { db, access } = fixture(t);
  assert.throws(() => transaction(db, () => {
    db.prepare("DELETE FROM memberships WHERE user_id='reader'").run();
    assert.equal(access.allows('reader', 'child', 'read'), false);
    throw new Error('rollback');
  }));
  assert.equal(access.allows('reader', 'child', 'read'), true);
  db.prepare("UPDATE resources SET inherit_permissions=0,policy='broken' WHERE id='child'").run();
  assert.equal(access.allows('reader', 'child', 'read'), false);
  db.prepare("UPDATE resources SET parent_id='child' WHERE id='root'").run();
  assert.equal(access.allows('giga', 'child', 'read'), false);
  db.prepare("UPDATE resources SET parent_id=NULL WHERE id='root'").run();
  db.pragma('foreign_keys = OFF');
  db.prepare("UPDATE resources SET parent_id='missing' WHERE id='child'").run();
  assert.equal(access.allows('giga', 'child', 'read'), false);
});

test('global policy and export changes invalidate cached results', t => {
  const { db, access } = fixture(t);
  assert.equal(access.allows('reader', 'child', 'export'), true);
  db.prepare('UPDATE app_state SET export_disabled=1 WHERE id=1').run();
  assert.equal(access.allows('reader', 'child', 'export'), false);
  db.prepare('UPDATE app_state SET default_policy=? WHERE id=1').run(policy(false));
  assert.equal(access.allows('reader', 'child', 'read'), false);
});

test('rolled-back cache entries cannot be reused when epoch numbers repeat', t => {
  const { db, access } = fixture(t);
  assert.equal(access.allows('reader', 'child', 'read'), true);
  assert.throws(() => transaction(db, () => {
    db.prepare("DELETE FROM memberships WHERE user_id='reader'").run();
    assert.equal(access.allows('reader', 'child', 'read'), false);
    throw new Error('rollback');
  }));
  // This reuses the rolled-back epoch with a completely different mutation.
  db.prepare("UPDATE groups SET name='Renamed' WHERE id='other'").run();
  assert.equal(access.allows('reader', 'child', 'read'), true);
});
