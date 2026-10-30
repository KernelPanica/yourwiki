import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { openDatabase } from '../src/database.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { DocumentService } from '../src/documents.ts';
import { JobQueue } from '../src/jobs.ts';
import { PreviewWorker } from '../src/worker/preview-worker.ts';
import { buildApp } from '../src/app.ts';
import { createSession } from '../src/auth/sessions.ts';
async function* bytes(value: string) { yield Buffer.from(value); }
async function setup(t: any, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-worker-'));
  const db = openDatabase(':memory:');
  db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'); INSERT INTO groups VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team');");
  const store = await BlobStore.open(root), service = new DocumentService(db, store), queue = new JobQueue(db);
  const worker = new PreviewWorker(db, store, options);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const create = (format: string, content: string) => service.create({ userId: 'owner', groupId: 'team', parentId: null, title: 'Guide', format }, bytes(content));
  async function html(id: string) {
    const published = service.getPublished('owner', id)!;
    const manifest = JSON.parse((await buffer(await store.read(published.manifestDigest))).toString());
    return (await buffer(await store.read(manifest.artifacts[0].digest))).toString();
  }
  return { db, root, store, service, queue, worker, create, html };
}

test('isolated Markdown conversion preserves formatting and escapes executable HTML', async t => {
  const { worker, service, create, html } = await setup(t);
  const created = await create('md', '# Guide\n\n**bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))');
  assert.equal(await worker.runOnce(), 'published');
  const content = await html(created.documentId);
  assert.match(content, /<h1>Guide<\/h1>/); assert.match(content, /<strong>bold<\/strong>/); assert.match(content, /<table>/);
  assert.ok(!content.includes('<script>')); assert.ok(!content.includes('href="javascript:'));
  assert.equal(service.processingStatus('owner', created.documentId)!.state, 'ready');
  assert.equal(await worker.runOnce(), 'idle');
});

test('text is escaped; PDF references immutable original without text conversion', async t => {
  const { worker, service, store, create, html } = await setup(t);
  const text = await create('txt', '<img src=x onerror=alert(1)>');
  assert.equal(await worker.runOnce(), 'published');
  assert.match(await html(text.documentId), /&lt;img/);
  const pdf = await create('pdf', '%PDF-1.7\nminimal test fixture\n%%EOF');
  assert.equal(await worker.runOnce(), 'published');
  const published = service.getPublished('owner', pdf.documentId)!;
  const manifest = JSON.parse((await buffer(await store.read(published.manifestDigest))).toString());
  assert.equal(manifest.kind, 'pdf'); assert.equal(manifest.artifacts[0].digest, pdf.blob.digest);
});

test('unsupported formats fail explicitly without consuming unrelated background jobs', async t => {
  const { worker, service, queue, create } = await setup(t);
  const other = queue.enqueue({ kind: 'provider.deliver', key: 'pending', payload: {} });
  const created = await create('unsupported', 'not yet converted');
  assert.equal(await worker.runOnce(), 'failed');
  assert.equal(service.processingStatus('owner', created.documentId)!.errorCode, 'PREVIEW_UNSUPPORTED');
  assert.equal(service.processingStatus('owner', created.documentId)!.state, 'failed');
  assert.equal(queue.status(other)!.state, 'queued');
  assert.equal(await worker.runOnce(), 'idle');
});

test('converter input budget gives a visible terminal failure and retains previous preview', async t => {
  const context = await setup(t), { db, store, service, worker, create } = context;
  const created = await create('md', 'first');
  await worker.runOnce();
  await service.save({ userId: 'owner', documentId: created.documentId, baseRevision: 1 }, bytes('larger replacement'));
  const bounded = new PreviewWorker(db, store, { textLimit: 5 });
  assert.equal(await bounded.runOnce(), 'failed');
  assert.equal(service.getPublished('owner', created.documentId)!.revision, 1);
  assert.equal(service.processingStatus('owner', created.documentId)!.errorCode, 'PREVIEW_TOO_COMPLEX');
});

test('HTTP uploaded Markdown becomes readable after worker publication', async t => {
  const { db, store, worker } = await setup(t);
  const origin = 'https://wiki.test';
  const app = buildApp({ database: db, storage: store, publicUrl: origin });
  t.after(() => app.close());
  const session = createSession(db, 'owner');
  const headers = { cookie: 'yourwiki_v2_session=' + session.token, origin, 'x-csrf-token': session.csrf };
  const uploaded = await app.inject({ method: 'POST', url: '/api/documents?title=Guide&format=md&groupId=team', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: '# Uploaded' });
  assert.equal(uploaded.statusCode, 201);
  const url = '/api/documents/' + uploaded.json().documentId;
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.equal(await worker.runOnce(), 'published');
  const published = (await app.inject({ url, headers })).json();
  const asset = await app.inject({ url: `${url}/previews/${published.manifestDigest}/assets/content`, headers });
  assert.equal(asset.statusCode, 200); assert.match(asset.body, /<h1>Uploaded<\/h1>/);
});

test('timeout is retriable, output budget is terminal, and neither publishes partial output', async t => {
  const { db, store, service, create } = await setup(t);
  const first = await create('md', '# Timeout');
  assert.equal(await new PreviewWorker(db, store, { timeoutMs: 1 }).runOnce(), 'failed');
  assert.equal(service.processingStatus('owner', first.documentId)!.errorCode, 'CONVERSION_TIMEOUT');
  assert.equal(service.getPublished('owner', first.documentId), null);
  const second = await create('md', '# Too much output');
  assert.equal(await new PreviewWorker(db, store, { outputLimit: 1 }).runOnce(), 'failed');
  assert.equal(service.processingStatus('owner', second.documentId)!.state, 'failed');
  assert.equal(service.processingStatus('owner', second.documentId)!.errorCode, 'PREVIEW_TOO_COMPLEX');
});

test('shutdown aborts conversion and leaves the job recoverable', async t => {
  const { worker, queue, service, create } = await setup(t);
  const created = await create('md', '# Cancel');
  const controller = new AbortController();
  const running = worker.runOnce(controller.signal);
  controller.abort();
  assert.equal(await running, 'interrupted');
  assert.equal(queue.status(created.jobId)!.state, 'queued');
  assert.equal(service.getPublished('owner', created.documentId), null);
  assert.equal(await worker.runOnce(), 'published');
});

test('a lost lease aborts the converter without publishing or acknowledging another owner', async t => {
  const { db, store, service, create, queue } = await setup(t);
  const created = await create('md', '# Lease');
  const worker = new PreviewWorker(db, store, { leaseMs: 30 });
  const running = worker.runOnce();
  db.prepare("UPDATE jobs SET lease_token='different-owner' WHERE id=?").run(created.jobId);
  assert.equal(await running, 'interrupted');
  assert.equal(service.getPublished('owner', created.documentId), null);
  assert.equal(queue.status(created.jobId)!.lease_token, 'different-owner');
});

test('separate worker instances share one conversion slot', async t => {
  const { db, store, worker, create } = await setup(t);
  await create('md', '# First'); await create('md', '# Second');
  const first = worker.runOnce();
  const second = new PreviewWorker(db, store);
  assert.equal(await second.runOnce(), 'idle');
  assert.equal(await first, 'published');
  assert.equal(await second.runOnce(), 'published');
});

test('standalone CLI publishes durable work and exits cleanly on SIGTERM', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-worker-cli-'));
  const path = join(root, 'workspace.sqlite3');
  const db = openDatabase(path);
  db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'); INSERT INTO groups VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team');");
  const store = await BlobStore.open(join(root, 'storage'));
  const created = await new DocumentService(db, store).create({ userId: 'owner', groupId: 'team', parentId: null, title: 'CLI', format: 'md' }, bytes('# CLI'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/worker/main.ts', import.meta.url)), path, join(root, 'storage')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(async () => { child.kill('SIGKILL'); await exited; db.close(); await rm(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 5000;
  while (!(db.prepare('SELECT published_revision FROM documents WHERE id=?').get(created.documentId) as any).published_revision) {
    if (child.exitCode !== null || Date.now() > deadline) assert.fail('CLI failed to publish: ' + output);
    await delay(10);
  }
  child.kill('SIGTERM');
  assert.equal(await exited, 0, output);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM worker_slots').get() as any).n, 0);
});

const officeIntegration = process.env.YOURWIKI_TEST_OFFICE_ROOT ? test : test.skip;
officeIntegration('native DOCX worker publishes an authenticated office HTML preview', async t => {
  const { db, store, service, worker } = await setup(t, { office: { officeRoot: process.env.YOURWIKI_TEST_OFFICE_ROOT } });
  const created = await service.create({ userId: 'owner', parentId: null, groupId: 'team', title: 'Office', format: 'docx' }, createReadStream(new URL('./fixtures/office/document.docx', import.meta.url)));
  assert.equal(await worker.runOnce(), 'published');
  const app = buildApp({ database: db, storage: store, publicUrl: 'https://wiki.test' });
  t.after(() => app.close());
  const session = createSession(db, 'owner'), headers = { cookie: 'yourwiki_v2_session='+session.token };
  const url = '/api/documents/'+created.documentId;
  const published = (await app.inject({ url, headers })).json();
  const preview = await app.inject({ url: `${url}/previews/${published.manifestDigest}/assets/content`, headers });
  assert.equal(preview.statusCode, 200); assert.match(preview.body, /Merged document title/);
});


test('legacy native Markdown snapshots preview their document instead of embedded JSON',async t=>{
 const {worker,create,html}=await setup(t);
 const source=JSON.stringify({format:'yourwiki',version:1,kind:'document',data:{type:'doc',content:[{type:'heading',attrs:{level:1},content:[{type:'text',text:'Migrated guide'}]},{type:'paragraph',content:[{type:'text',text:'Preserved',marks:[{type:'bold'}]}]}]}});
 const created=await create('md',source);assert.equal(await worker.runOnce(),'published');const content=await html(created.documentId);assert.match(content,/<h1>Migrated guide<\/h1>/);assert.match(content,/<strong>Preserved<\/strong>/);assert.equal(content.includes('"format"'),false);
});

test('legacy preview jobs retain their converter identity and explicit rebuild upgrades the same revision',async t=>{
 const f=await setup(t),old=new DocumentService(f.db,f.store,{converterVersion:'preview-v1'}),source=JSON.stringify({format:'yourwiki',version:1,kind:'document',data:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Upgraded'}]}]}});
 const created=await old.create({userId:'owner',groupId:'team',parentId:null,title:'Old',format:'md'},bytes(source));assert.equal(await f.worker.runOnce(),'published');assert.match(await f.html(created.documentId),/&quot;format&quot;/);
 f.service.requestPreview('owner',created.documentId);assert.equal(await f.worker.runOnce(),'published');assert.match(await f.html(created.documentId),/<p>Upgraded<\/p>/);assert.equal(f.service.getPublished('owner',created.documentId)!.converterVersion,'preview-v2');assert.equal(f.service.getPublished('owner',created.documentId)!.revision,1);
});
