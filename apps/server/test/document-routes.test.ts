import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { openDatabase } from '../src/database.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import { buildApp } from '../src/app.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { DocumentService } from '../src/documents.ts';
import { JobQueue } from '../src/jobs.ts';
import { createSession } from '../src/auth/sessions.ts';
async function* bytes(value: string) { yield Buffer.from(value); }
const origin = 'https://wiki.example.test';
async function setup(t: any, maxFileBytes = 100) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-http-'));
  const db = openDatabase(':memory:');
  db.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('reader','reader','Reader','!');
    INSERT INTO groups(id,name) VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('reader','team');`);
  const store = await BlobStore.open(root);
  const app = buildApp({ database: db, publicUrl: origin, storage: store, maxFileBytes });
  const service = new DocumentService(db, store);
  const sessions = Object.fromEntries(['owner','reader'].map(id => [id, createSession(db, id)]));
  const headers = (id = 'owner') => ({ cookie: 'yourwiki_v2_session=' + sessions[id].token, origin, 'x-csrf-token': sessions[id].csrf });
  const created = await service.create({ userId: 'owner', groupId: 'team', parentId: null, title: 'Guide', format: 'md' }, bytes('original'));
  const publish = async () => {
    const artifact = await store.put(bytes('<p>hello</p>'), { maxBytes: 100 });
    await service.publish(new JobQueue(db).claim(Date.now())!, {
      schemaVersion: 1, documentId: created.documentId, revision: 1, sourceDigest: created.blob.digest,
      converterVersion: 'preview-v2', kind: 'document', primary: 'content',
      artifacts: [{ ...artifact, name: 'content', mimeType: 'text/html' }],
    });
  };
  t.after(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, app, service, store, headers, created, publish };
}

test('document HTTP hides drafts and exposes published manifest and sandboxed assets only to authenticated readers', async t => {
  const { app, headers, created, publish } = await setup(t);
  const url = `/api/documents/${created.documentId}`;
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: headers('reader') })).statusCode, 404);
  assert.equal((await app.inject({ url: url + '/processing', headers: headers('reader') })).statusCode, 404);
  assert.equal((await app.inject({ url: url + '/processing', headers: headers() })).json().state, 'queued');
  await publish();
  const metadata = (await app.inject({ url, headers: headers('reader') })).json();
  assert.equal(metadata.revision, 1);
  const view = await app.inject({ url: url + '/view', headers: headers('reader') });
  assert.equal(view.statusCode, 200); assert.equal(view.json().manifest.primary, 'content');
  const manifestUrl = `${url}/previews/${metadata.manifestDigest}`;
  const manifest = await app.inject({ url: manifestUrl, headers: headers('reader') });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().primary, 'content');
  const asset = await app.inject({ url: manifestUrl + '/assets/content', headers: headers('reader') });
  assert.equal(asset.body, '<p>hello</p>');
  assert.match(asset.headers['content-security-policy'] as string, /sandbox allow-same-origin/);
  assert.match(asset.headers['content-security-policy'] as string, /script-src 'none'/);
  assert.equal((await app.inject({ url: manifestUrl + '/assets/unknown', headers: headers() })).statusCode, 404);
});

test('original ranges and export policy are enforced, including after a prior successful request', async t => {
  const { app, db, headers, created, publish } = await setup(t);
  await publish();
  const url = `/api/documents/${created.documentId}/content`;
  const result = await app.inject({ url, headers: { ...headers('reader'), range: 'bytes=1-3' } });
  assert.equal(result.statusCode, 206); assert.equal(result.body, 'rig');
  assert.equal(result.headers['content-range'], 'bytes 1-3/8');
  assert.match(result.headers['content-disposition'] as string, /attachment/);
  assert.equal((await app.inject({ url, headers: { ...headers('reader'), range: 'bytes=99-' } })).statusCode, 416);
  db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(created.documentId);
  assert.equal((await app.inject({ url, headers: headers('reader') })).statusCode, 403);
  db.prepare('UPDATE resources SET trashed=1 WHERE id=?').run(created.documentId);
  assert.equal((await app.inject({ url: `/api/documents/${created.documentId}`, headers: headers() })).statusCode, 404);
});

test('streaming mutations enforce session/CSRF, independent byte limit and stale revision conflicts', async t => {
  const { app, headers, created } = await setup(t);
  const url = '/api/documents?title=New&format=md&groupId=team';
  assert.equal((await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: 'new' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers(), origin: 'https://evil.test', 'content-type': 'application/octet-stream' }, payload: 'new' })).statusCode, 403);
  const upload = (value: string) => app.inject({ method: 'POST', url, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: value });
  assert.equal((await upload('new')).statusCode, 201);
  const oversized = await upload('x'.repeat(101));
  assert.equal(oversized.statusCode, 413); assert.equal(oversized.json().code, 'PAYLOAD_TOO_LARGE');
  const conflict = await app.inject({ method: 'PUT', url: `/api/documents/${created.documentId}/content?baseRevision=0`, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: 'stale' });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'CONFLICT');
  assert.ok(conflict.json().recoveryActions.includes('copy_changes'));
  const saved = await app.inject({ method: 'PUT', url: `/api/documents/${created.documentId}/content?baseRevision=1`, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: 'updated' });
  assert.equal(saved.statusCode, 202); assert.equal(saved.json().revision, 2);
  const { ['x-csrf-token']: _csrf, ...withoutCsrf } = headers();
  assert.equal((await app.inject({ method: 'POST', url, headers: { ...withoutCsrf, 'content-type': 'application/octet-stream' }, payload: 'new' })).statusCode, 403);
});

test('versioned preview assets cannot bypass current read permissions or cross document receipts', async t => {
  const { app, db, service, headers, created, publish } = await setup(t);
  await publish();
  const published = service.getPublished('reader', created.documentId)!;
  const url = `/api/documents/${created.documentId}/previews/${published.manifestDigest}/assets/content`;
  assert.equal((await app.inject({ url, headers: headers('reader') })).statusCode, 200);
  const other = await service.create({ userId: 'owner', groupId: 'team', parentId: null, title: 'Other', format: 'md' }, bytes('other'));
  assert.equal((await app.inject({ url: url.replace(created.documentId, other.documentId), headers: headers() })).statusCode, 404);
  db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?')
    .run(JSON.stringify({ reader: { read: false, write: false } }), created.documentId);
  assert.equal((await app.inject({ url, headers: headers('reader') })).statusCode, 404);
  db.exec("UPDATE users SET active=0 WHERE id='owner'");
  assert.equal((await app.inject({ url, headers: headers() })).statusCode, 401);
});

test('original range validation supports suffixes and rejects ambiguous or unsafe ranges', async t => {
  const { app, headers, created, publish } = await setup(t);
  await publish();
  const url = `/api/documents/${created.documentId}/content`;
  for (const [range, expected] of [['bytes=-3', 'nal'], ['bytes=4-', 'inal'], ['bytes=0-99', 'original']]) {
    const response = await app.inject({ url, headers: { ...headers(), range } });
    assert.equal(response.statusCode, 206); assert.equal(response.body, expected);
  }
  for (const range of ['bytes=-0', 'bytes=4-1', 'bytes=0-1,4-5', 'bytes=9007199254740992-']) {
    assert.equal((await app.inject({ url, headers: { ...headers(), range } })).statusCode, 416);
  }
});

test('real HTTP file streams can exceed the JSON cap without being parsed as JSON', async t => {
  const { app, db, headers } = await setup(t, 3 * 1024 ** 2);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  async function* payload() { for (let i = 0; i < 64; i++) yield Buffer.alloc(32768, 120); }
  const response = await fetch(address + '/api/documents?title=Large&format=md&groupId=team', {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream' },
    body: Readable.from(payload()), duplex: 'half',
  } as any);
  assert.equal(response.status, 201);
  const result = await response.json() as { documentId: string };
  assert.equal((db.prepare('SELECT size FROM document_versions WHERE document_id=?').get(result.documentId) as any).size, 2 * 1024 ** 2);
});

test('disconnecting a real HTTP upload removes staging without committing a revision', async t => {
  const { root, db, app, headers } = await setup(t, 1000);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const request = httpRequest(address + '/api/documents?title=Interrupted&format=md&groupId=team', {
    method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream' },
  });
  request.on('error', () => {});
  t.after(() => request.destroy());
  request.write(Buffer.alloc(32));
  async function waitForStaging(empty: boolean) {
    const deadline = Date.now() + 1500;
    while (((await readdir(join(root, 'staging'))).length === 0) !== empty) {
      if (Date.now() >= deadline) assert.fail('upload staging did not reach expected state');
      await delay(5);
    }
  }
  await waitForStaging(false);
  request.destroy();
  await waitForStaging(true);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n, 1);
});

test('document catalog paginates published files, hides drafts and reflects capabilities', async t => {
  const { app, db, headers, created, publish } = await setup(t);
  assert.equal((await app.inject({ url: '/api/documents' })).statusCode, 401);
  assert.deepEqual((await app.inject({ url: '/api/documents', headers: headers('reader') })).json().items, []);
  await publish();
  const result = await app.inject({ url: '/api/documents?limit=1', headers: headers('reader') });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().items[0].id, created.documentId);
  assert.equal(result.json().items[0].capabilities.write, false);
  assert.equal(result.json().items[0].capabilities.export, true);
  const end = await app.inject({ url: '/api/documents?after='+created.documentId, headers: headers('reader') });
  assert.deepEqual(end.json().items, []);
  db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(created.documentId);
  assert.equal((await app.inject({ url: '/api/documents', headers: headers('reader') })).json().items[0].capabilities.export, false);
  db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?').run(JSON.stringify({ reader: { read:false,write:false } }),created.documentId);
  assert.deepEqual((await app.inject({ url: '/api/documents', headers: headers('reader') })).json().items, []);
});

test('preview ranges support partial reads without export and recheck access on every request', async t => {
  const { app, db, service, store, headers, created } = await setup(t);
  const artifact = await store.put(bytes('%PDF-1.7\nfixture'), { maxBytes: 100 });
  await service.publish(new JobQueue(db).claim(Date.now())!, {
    schemaVersion: 1, documentId: created.documentId, revision: 1, sourceDigest: created.blob.digest,
    converterVersion: 'preview-v2', kind: 'pdf', primary: 'content',
    artifacts: [{ ...artifact, name: 'content', mimeType: 'application/pdf' }],
  });
  db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(created.documentId);
  const published = service.getPublished('reader', created.documentId)!;
  const url = `/api/documents/${created.documentId}/previews/${published.manifestDigest}/assets/content`;
  const read = (range: string) => app.inject({ url, headers: { ...headers('reader'), range } });
  const partial = await read('bytes=0-7');
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.body, '%PDF-1.7');
  assert.equal(partial.headers['content-range'], 'bytes 0-7/16');
  assert.equal(partial.headers['content-length'], '8');
  assert.equal(partial.headers['accept-ranges'], 'bytes');
  assert.equal(partial.headers['cache-control'], 'no-store');
  assert.equal((await read('bytes=-7')).body, 'fixture');
  assert.equal((await read('bytes=9-')).body, 'fixture');
  for (const range of ['bytes=99-', 'bytes=8-2', 'bytes=0-1,3-4', 'bytes=-0']) {
    const rejected = await read(range);
    assert.equal(rejected.statusCode, 416);
    assert.equal(rejected.headers['content-range'], 'bytes */16');
  }
  db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?').run(JSON.stringify({ reader: { read: false } }), created.documentId);
  assert.equal((await read('bytes=0-7')).statusCode, 404);
  assert.equal((await app.inject({ url, headers: { range: 'bytes=0-7' } })).statusCode, 401);
});


test('active office sessions fence source and resumable HTTP saves, including forged internal binding',async t=>{
 const f=await setup(t);await f.publish();const auth=f.headers();
 const browserToken=auth.cookie.split('=')[1]!;const opened=new OfficeSessions(f.db).open(browserToken,f.created.documentId);
 const source=await f.app.inject({method:'PUT',url:`/api/documents/${f.created.documentId}/content?baseRevision=1&officeSessionId=${opened.sessionId}`,headers:{...auth,'content-type':'application/octet-stream'},payload:'new'});
 assert.equal(source.statusCode,409);assert.equal(source.json().code,'OFFICE_ACTIVE');assert.deepEqual(source.json().recoveryActions,['open_office','copy_changes','download_changes']);
 const resume=await f.app.inject({method:'POST',url:'/api/uploads',headers:auth,payload:{mode:'save',size:3,documentId:f.created.documentId,baseRevision:1,officeSessionId:opened.sessionId}});
 assert.equal(resume.statusCode,409);assert.equal(resume.json().code,'OFFICE_ACTIVE');
 assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.created.documentId) as any).local_revision,1);
});
