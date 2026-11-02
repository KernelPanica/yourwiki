import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openDatabase } from '../src/database.ts';
import { buildApp } from '../src/app.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/django-passwords.json', import.meta.url), 'utf8'));
const origin = 'https://wiki.example.test';
async function setup(t: any) {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO users(id,username,display_name,password_hash) VALUES(?,?,?,?)').run('1', 'member', 'Member', fixture.hashes.pbkdf2_sha256);
  db.exec("INSERT INTO groups VALUES('team','Team'); INSERT INTO memberships VALUES('1','team');");
  const app = buildApp({ database: db, publicUrl: origin });
  t.after(async () => { await app.close(); db.close(); });
  const login = () => app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'member', password: fixture.password } });
  return { db, app, login };
}

test('login creates secure cookie; account returns groups and csrf without secrets', async t => {
  const { app, login } = await setup(t);
  const response = await login();
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie'] as string;
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\//);
  const cookie = setCookie.split(';')[0];
  const account = await app.inject({ url: '/api/account', headers: { cookie } });
  assert.equal(account.statusCode, 200);
  const value = account.json();
  assert.equal(value.user.username, 'member');
  assert.deepEqual(value.user.groups, [{ id: 'team', name: 'Team' }]);
  assert.equal(value.csrf, response.json().csrf);
  assert.ok(!account.body.includes(fixture.hashes.pbkdf2_sha256));
  assert.ok(!account.body.includes(cookie.split('=')[1]));
});

test('logout needs session-bound csrf and exact origin; revoked cookie cannot return account', async t => {
  const { app, login } = await setup(t);
  const response = await login();
  const cookie = (response.headers['set-cookie'] as string).split(';')[0];
  for (const headers of [{ cookie, origin }, { cookie, origin: 'https://evil.example', 'x-csrf-token': response.json().csrf }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode, 403);
  }
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin, 'x-csrf-token': response.json().csrf } });
  assert.equal(logout.statusCode, 204);
  assert.match(logout.headers['set-cookie'] as string, /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
});

test('wrong and missing accounts share errors; cross-origin login cannot create sessions', async t => {
  const { app, db } = await setup(t);
  for (const username of ['member', 'missing']) {
    const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password: 'wrong' } });
    assert.equal(result.statusCode, 401);
    assert.equal(result.json().code, 'INVALID_CREDENTIALS');
  }
  const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: 'member', password: fixture.password } });
  assert.equal(result.statusCode, 403);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n, 0);
});

test('disabled users and changed passwords invalidate account responses immediately', async t => {
  const { app, db, login } = await setup(t);
  const response = await login(), cookie = (response.headers['set-cookie'] as string).split(';')[0];
  db.prepare("UPDATE users SET active=0 WHERE id='1'").run();
  assert.equal((await app.inject({ url: '/api/account', headers: { cookie } })).statusCode, 401);
});

test('failed logins are rate limited persistently and do not trust forwarded IPs', async t => {
  const { app } = await setup(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin, 'x-forwarded-for': `10.0.0.${attempt}` },
      payload: { username: 'missing', password: 'wrong' } });
    assert.equal(result.statusCode, 401);
  }
  const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'missing', password: 'wrong' } });
  assert.equal(result.statusCode, 429);
  assert.ok(Number(result.headers['retry-after']) > 0);
});

test('site login limits and session lifetime are applied to new logins', async t => {
  const { app, db, login } = await setup(t);
  db.prepare('UPDATE app_state SET session_hours=2,login_attempts=2,login_window_minutes=1 WHERE id=1').run();
  const success = await login();
  assert.match(success.headers['set-cookie'] as string, /Max-Age=7200/);
  assert.ok(success.json().expiresAt <= Date.now() + 2 * 3600_000);
  for (let i = 0; i < 2; i++) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'missing', password: 'wrong' } })).statusCode, 401);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'missing', password: 'wrong' } });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) <= 60);
});

test('concurrent password attempts cannot bypass the reserved login quota', async t => {
  const { app } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 11 }, () => app.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'missing', password: 'wrong' },
  })));
  assert.equal(responses.filter(value => value.statusCode === 401).length, 10);
  assert.equal(responses.filter(value => value.statusCode === 429).length, 1);
});

test('password change during KDF verification cannot issue a session for old credentials', async t => {
  const { app, db, login } = await setup(t);
  db.prepare("UPDATE users SET password_hash=? WHERE id='1'").run(fixture.hashes.scrypt);
  const pending = login();
  // Observe the real request reservation, then mutate while native KDF is pending.
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    if ((db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as any).n > 0) break;
  }
  assert.ok((db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as any).n > 0);
  db.prepare("UPDATE users SET password_hash='!changed' WHERE id='1'").run();
  assert.equal((await pending).statusCode, 401);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n, 0);
});

test('having an authentication database does not claim complete workspace readiness', async t => {
  const { app } = await setup(t);
  assert.equal((await app.inject('/ready/')).statusCode, 503);
});
