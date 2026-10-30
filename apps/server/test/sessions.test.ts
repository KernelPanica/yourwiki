import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/database.ts';
import { createSession, authenticateSession, revokeSession, validCsrf } from '../src/auth/sessions.ts';
function fixture(t: any) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.prepare("INSERT INTO users(id,username,display_name,password_hash) VALUES('1','member','Member','unusable')").run();
  return db;
}

test('sessions store only hashes and require their own CSRF capability', t => {
  const db = fixture(t);
  const a = createSession(db, '1', 1000), b = createSession(db, '1', 1000);
  assert.notEqual(a.token, b.token);
  const session = authenticateSession(db, a.token, 1001)!;
  assert.equal(session.userId, '1');
  assert.equal(validCsrf(session, a.csrf), true);
  assert.equal(validCsrf(session, b.csrf), false);
  const stored = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  assert.ok(!stored.includes(a.token)); assert.ok(!stored.includes(a.csrf));
});

test('expired, revoked and disabled sessions fail closed', t => {
  const db = fixture(t);
  const session = createSession(db, '1', 1000, 1000);
  assert.equal(authenticateSession(db, session.token, 2000), null);
  revokeSession(db, session.token);
  assert.equal(authenticateSession(db, session.token, 1001), null);
  const second = createSession(db, '1', 1000);
  db.prepare("UPDATE users SET active=0 WHERE id='1'").run();
  assert.equal(authenticateSession(db, second.token, 1001), null);
  db.prepare("UPDATE users SET active=1 WHERE id='1'").run();
  assert.equal(authenticateSession(db, second.token, 1001), null);
});

test('password change invalidates existing sessions; role is read fresh', t => {
  const db = fixture(t);
  const session = createSession(db, '1', 1000);
  db.prepare("UPDATE users SET admin_role='simple' WHERE id='1'").run();
  assert.equal(authenticateSession(db, session.token, 1001)!.adminRole, 'simple');
  db.prepare("UPDATE users SET password_hash='changed' WHERE id='1'").run();
  assert.equal(authenticateSession(db, session.token, 1001), null);
});

test('malformed tokens and inactive accounts cannot create valid sessions', t => {
  const db = fixture(t);
  for (const token of ['', 'garbage', 'x'.repeat(10000)]) assert.equal(authenticateSession(db, token), null);
  db.prepare("UPDATE users SET active=0 WHERE id='1'").run();
  assert.throws(() => createSession(db, '1'), /active/i);
});
