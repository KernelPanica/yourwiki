import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { buildApp } from '../src/app.ts';
import { createSession } from '../src/auth/sessions.ts';
async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-upload-http-'));
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('other','other','Other','!'); INSERT INTO groups VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('other','team');");
  const store = await BlobStore.open(root), origin = 'https://wiki.test';
  const app = buildApp({ database: db, storage: store, publicUrl: origin, maxFileBytes: 100, maxPendingUploadBytes: 100, uploadChunkBytes: 3 });
  const sessions = Object.fromEntries(['owner','other'].map(user => [user, createSession(db, user)]));
  const headers = (user = 'owner') => ({ cookie: 'yourwiki_v2_session=' + sessions[user].token, origin, 'x-csrf-token': sessions[user].csrf });
  t.after(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const create = (size = 6) => app.inject({ method: 'POST', url: '/api/uploads', headers: headers(), payload: { mode: 'create', title: 'Guide', format: 'md', groupId: 'team', size } });
  return { db, app, headers, create };
}

test('HTTP resume protocol returns durable offsets and stable completion receipt', async t => {
  const { db, app, headers, create } = await setup(t);
  const start = await create(); assert.equal(start.statusCode, 201, start.body);
  const url = '/api/uploads/' + start.json().id;
  const append = (offset: number, data: string) => app.inject({ method: 'PATCH', url: url + '?offset=' + offset, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: data });
  assert.equal((await append(0, 'abc')).json().offset, 3);
  assert.equal((await app.inject({ url, headers: headers() })).json().offset, 3);
  assert.equal((await append(0, 'abc')).json().offset, 3);
  assert.equal((await append(0, 'xyz')).statusCode, 409);
  assert.equal((await append(3, 'def')).json().offset, 6);
  const first = await app.inject({ method: 'POST', url: url + '/finish', headers: headers() });
  assert.equal(first.statusCode, 200, first.body);
  const repeated = await app.inject({ method: 'POST', url: url + '/finish', headers: headers() });
  assert.deepEqual(repeated.json(), first.json());
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as any).n, 1);
  const save = await app.inject({ method: 'POST', url: '/api/uploads', headers: headers(), payload: { mode: 'save', documentId: first.json().documentId, baseRevision: 1, size: 3 } });
  assert.equal(save.statusCode, 201, save.body);
});

test('resume routes enforce authentication, csrf, owner isolation and chunk limits', async t => {
  const { app, headers, create } = await setup(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/uploads', payload: {} })).statusCode, 401);
  const started = await create(); assert.equal(started.statusCode, 201, started.body);
  const url = '/api/uploads/' + started.json().id;
  assert.equal((await app.inject({ url, headers: headers('other') })).statusCode, 404);
  const payload = { method: 'PATCH' as const, url: url + '?offset=0', payload: 'abcde' };
  assert.equal((await app.inject({ ...payload, headers: { ...headers(), origin: 'https://evil.test', 'content-type': 'application/octet-stream' } })).statusCode, 403);
  const large = await app.inject({ ...payload, headers: { ...headers(), 'content-type': 'application/octet-stream' } });
  assert.equal(large.statusCode, 413); assert.equal(large.json().code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await app.inject({ method: 'DELETE', url, headers: headers() })).statusCode, 204);
  assert.equal((await app.inject({ url, headers: headers() })).json().state, 'cancelled');
  assert.equal((await create(101)).statusCode, 413);
});

test('a disconnected real HTTP chunk can be retried from its last committed offset', async t => {
  const { db, app, headers, create } = await setup(t);
  const started = await create(); const id = started.json().id;
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = httpRequest(`${address}/api/uploads/${id}?offset=0`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/octet-stream' } });
  request.on('error', () => {}); t.after(() => request.destroy());
  request.write('ab');
  async function waitLease(held: boolean) {
    const deadline = Date.now() + 1500;
    while (!!(db.prepare('SELECT lease_token FROM uploads WHERE id=?').get(id) as any).lease_token !== held) {
      if (Date.now() >= deadline) assert.fail('HTTP chunk lease did not reach expected state');
      await delay(5);
    }
  }
  await waitLease(true); request.destroy(); await waitLease(false);
  assert.equal((db.prepare('SELECT offset FROM uploads WHERE id=?').get(id) as any).offset, 0);
  const retried = await app.inject({ method: 'PATCH', url: `/api/uploads/${id}?offset=0`, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: 'abc' });
  assert.equal(retried.statusCode, 200, retried.body); assert.equal(retried.json().offset, 3);
});
