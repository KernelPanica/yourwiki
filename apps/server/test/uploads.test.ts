import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { openDatabase } from '../src/database.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { DocumentService } from '../src/documents.ts';
import { ResumableUploads } from '../src/uploads.ts';
async function* bytes(value: string) { yield Buffer.from(value); }
const metadata = { mode: 'create' as const, parentId: null, groupId: 'team', title: 'Guide', format: 'md', size: 6 };
async function setup(t: any, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-upload-'));
  const path = join(root, 'db.sqlite');
  const db = openDatabase(path);
  db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('other','other','Other','!'); INSERT INTO groups(id,name) VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('other','team');");
  const store = await BlobStore.open(join(root, 'storage'));
  let now = 1000;
  const config = { maxFileBytes: 100, maxPendingBytes: 100, chunkBytes: 3, ttlMs: 1000, clock: () => now, ...options };
  const uploads = new ResumableUploads(db, store, config);
  t.after(async () => { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, path, root, store, config, uploads, tick: (value: number) => { now = value; } };
}

test('durable chunks resume after database reopen and finish is exactly once', async t => {
  const { db, path, store, config, uploads } = await setup(t);
  const created = uploads.create('owner', metadata);
  assert.equal((await uploads.append('owner', created.id, 0, bytes('abc'))).offset, 3);
  db.close();
  const reopened = openDatabase(path); t.after(() => reopened.close());
  const resumed = new ResumableUploads(reopened, store, { ...config, chunkBytes: 4 });
  assert.equal(resumed.status('owner', created.id).offset, 3);
  assert.equal(resumed.status('owner', created.id).chunkBytes, 3);
  await resumed.append('owner', created.id, 3, bytes('def'));
  const finalizing = resumed.finish('owner', created.id);
  await assert.rejects(resumed.finish('owner', created.id), /UPLOAD_BUSY/);
  const first = await finalizing;
  assert.deepEqual(await resumed.finish('owner', created.id), first);
  assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM documents').get() as any).n, 1);
  assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n, 1);
  const blob = reopened.prepare('SELECT digest FROM document_versions').get() as { digest: string };
  assert.equal((await buffer(await store.read(blob.digest))).toString(), 'abcdef');
});

test('chunk retries are idempotent; wrong offsets and changed bytes cannot overwrite receipts', async t => {
  const { uploads } = await setup(t);
  const created = uploads.create('owner', metadata);
  await uploads.append('owner', created.id, 0, bytes('abc'));
  assert.equal((await uploads.append('owner', created.id, 0, bytes('abc'))).offset, 3);
  await assert.rejects(uploads.append('owner', created.id, 0, bytes('xyz')), /CHUNK_CONFLICT/);
  await assert.rejects(uploads.append('owner', created.id, 2, bytes('d')), /OFFSET_MISMATCH/);
  await assert.rejects(uploads.finish('owner', created.id), /UPLOAD_INCOMPLETE/);
  assert.equal(uploads.status('owner', created.id).offset, 3);
});

test('interrupted or oversized chunk leaves committed offset unchanged', async t => {
  const { uploads } = await setup(t);
  const created = uploads.create('owner', metadata);
  async function* broken() { yield Buffer.from('a'); throw new Error('disconnected'); }
  await assert.rejects(uploads.append('owner', created.id, 0, broken()), /disconnected/);
  await assert.rejects(uploads.append('owner', created.id, 0, bytes('12345')), /limit/i);
  assert.equal(uploads.status('owner', created.id).offset, 0);
  await uploads.append('owner', created.id, 0, bytes('abc'));
  await assert.rejects(uploads.append('owner', created.id, 3, bytes('wxyz')), /limit/i);
  assert.equal(uploads.status('owner', created.id).offset, 3);
});

test('owner isolation and permission revocation apply during chunk acceptance', async t => {
  const { db, uploads } = await setup(t);
  const created = uploads.create('owner', metadata);
  assert.throws(() => uploads.status('other', created.id), /NOT_FOUND/);
  await assert.rejects(uploads.append('other', created.id, 0, bytes('abc')), /NOT_FOUND/);
  async function* revoked() { yield Buffer.from('abc'); db.exec("DELETE FROM memberships WHERE user_id='owner'"); }
  await assert.rejects(uploads.append('owner', created.id, 0, revoked()), /ACCESS_DENIED/);
  assert.equal((db.prepare('SELECT offset FROM uploads WHERE id=?').get(created.id) as any).offset, 0);
});

test('save finalization respects base revision and never overwrites concurrent edits', async t => {
  const { db, store, uploads } = await setup(t);
  const documents = new DocumentService(db, store);
  const created = await documents.create({ userId: 'owner', parentId: null, groupId: 'team', title: 'Guide', format: 'md' }, bytes('original'));
  const upload = uploads.create('owner', { mode: 'save', documentId: created.documentId, baseRevision: 1, size: 3 });
  await uploads.append('owner', upload.id, 0, bytes('old'));
  await documents.save({ userId: 'owner', documentId: created.documentId, baseRevision: 1 }, bytes('newer'));
  await assert.rejects(uploads.finish('owner', upload.id), /CONFLICT/);
  assert.equal((db.prepare('SELECT local_revision FROM documents WHERE id=?').get(created.documentId) as any).local_revision, 2);
  assert.equal((db.prepare('SELECT state FROM uploads WHERE id=?').get(upload.id) as any).state, 'active');
});

test('pending quota, cancellation and expiry release reservations and private chunk files', async t => {
  const { root, uploads, tick } = await setup(t, { maxPendingBytes: 6 });
  const created = uploads.create('owner', metadata);
  assert.throws(() => uploads.create('owner', { ...metadata, size: 1 }), /UPLOAD_QUOTA_EXCEEDED/);
  await uploads.append('owner', created.id, 0, bytes('abc'));
  await uploads.cancel('owner', created.id);
  assert.equal(uploads.status('owner', created.id).state, 'cancelled');
  const expired = uploads.create('owner', metadata);
  await uploads.append('owner', expired.id, 0, bytes('abc'));
  tick(2000);
  await assert.rejects(uploads.append('owner', expired.id, 3, bytes('def')), /UPLOAD_EXPIRED/);
  await uploads.cleanupExpired();
  assert.deepEqual(await readdir(join(root, 'storage', 'uploads')), []);
  assert.ok(uploads.create('owner', metadata));
});

test('a concurrent chunk cannot consume unbounded staging and rejected replay leaves no extra parts', async t => {
  const { root, uploads } = await setup(t);
  const upload = uploads.create('owner', metadata);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  async function* waiting() { entered(); await proceed; yield Buffer.from('abc'); }
  const first = uploads.append('owner', upload.id, 0, waiting());
  await ready;
  await assert.rejects(uploads.append('owner', upload.id, 0, bytes('xyz')), /UPLOAD_BUSY/);
  release(); await first;
  await assert.rejects(uploads.append('owner', upload.id, 0, bytes('xyz')), /CHUNK_CONFLICT/);
  const parts = await readdir(join(root, 'storage', 'uploads', upload.id, 'uploads'));
  assert.equal(parts.length, 1);
});

test('corrupt persisted chunks cannot be assembled into an accepted original', async t => {
  const { root, db, uploads } = await setup(t);
  const upload = uploads.create('owner', { ...metadata, size: 3 });
  await uploads.append('owner', upload.id, 0, bytes('abc'));
  const receipt = db.prepare('SELECT digest,storage_id FROM upload_chunks WHERE upload_id=?').get(upload.id) as any;
  await writeFile(join(root, 'storage', 'uploads', upload.id, 'uploads', receipt.storage_id, 'blobs', receipt.digest.slice(0,2), receipt.digest.slice(2)), 'xyz');
  await assert.rejects(uploads.finish('owner', upload.id), /UPLOAD_CORRUPT/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as any).n, 0);
});

test('empty files finish without chunks; completed receipts survive expiry and cleanup', async t => {
  const { uploads, tick, db } = await setup(t);
  const empty = uploads.create('owner', { ...metadata, size: 0 });
  const result = await uploads.finish('owner', empty.id);
  tick(3000); await uploads.cleanupExpired();
  assert.deepEqual(await uploads.finish('owner', empty.id), result);
  assert.equal((db.prepare('SELECT size FROM document_versions').get() as any).size, 0);
});

test('small nonfinal parts are rejected before growing receipts', async t => {
  const { db, uploads } = await setup(t);
  const upload = uploads.create('owner', metadata);
  await assert.rejects(uploads.append('owner', upload.id, 0, bytes('a')), /CHUNK_SIZE_MISMATCH/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM upload_chunks').get() as any).n, 0);
  assert.equal(uploads.status('owner', upload.id).offset, 0);
});

test('part count cap rejects configurations that would amplify filesystem overhead', async t => {
  const { uploads, db } = await setup(t, { maxFileBytes: 5000, maxPendingBytes: 10000, chunkBytes: 1 });
  assert.throws(() => uploads.create('owner', { ...metadata, size: 4097 }), /TOO_MANY_CHUNKS/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM uploads').get() as any).n, 0);
});
