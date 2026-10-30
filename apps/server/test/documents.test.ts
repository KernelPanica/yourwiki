import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { JobQueue } from '../src/jobs.ts';
import { DocumentService } from '../src/documents.ts';
async function* bytes(value: string) { yield Buffer.from(value); }
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-documents-'));
  const db = openDatabase(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  db.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('reader','reader','Reader','!');
    INSERT INTO groups VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('reader','team');`);
  const store = await BlobStore.open(root);
  let now = 1000;
  const service = new DocumentService(db, store, { clock: () => now, maxBytes: 1000, converterVersion: 'markdown-1' });
  return { db, store, service, queue: new JobQueue(db), tick: (value: number) => { now = value; } };
}
const metadata = { userId: 'owner', parentId: null, groupId: 'team', title: 'Guide', format: 'md' };
async function preview(context: any, documentId: string, revision: number, sourceDigest: string) {
  const asset = await context.store.put(bytes('<p>Guide</p>'), { maxBytes: 1000 });
  return { schemaVersion: 1 as const, documentId, revision, sourceDigest,
    converterVersion: 'markdown-1', kind: 'document' as const,
    primary: 'content', artifacts: [{ name: 'content', ...asset, mimeType: 'text/html' }] };
}

test('new files remain unpublished until a complete manifest and its artifacts exist', async t => {
  const context = await fixture(t), { service, queue, db } = context;
  const created = await service.create(metadata, bytes('# Guide'));
  assert.equal(service.getPublished('reader', created.documentId), null);
  assert.equal(service.processingStatus('reader', created.documentId), null);
  assert.equal(service.processingStatus('owner', created.documentId)!.state, 'queued');
  const claim = queue.claim(1000)!;
  assert.equal(await service.publish(claim, await preview(context, created.documentId, 1, created.blob.digest)), 'published');
  assert.equal(service.getPublished('reader', created.documentId)!.revision, 1);
  assert.equal(queue.status(claim.id)!.state, 'succeeded');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n, 1);
});

test('updates retain the prior published revision; stale conversion cannot replace it', async t => {
  const context = await fixture(t), { service, queue } = context;
  const first = await service.create(metadata, bytes('first'));
  await service.publish(queue.claim(1000)!, await preview(context, first.documentId, 1, first.blob.digest));
  const second = await service.save({ userId: 'owner', documentId: first.documentId, baseRevision: 1 }, bytes('second'));
  const oldClaim = queue.claim(1000)!;
  const third = await service.save({ userId: 'owner', documentId: first.documentId, baseRevision: 2 }, bytes('third'));
  assert.equal(service.getPublished('reader', first.documentId)!.revision, 1);
  assert.equal(await service.publish(oldClaim, await preview(context, first.documentId, 2, second.blob.digest)), 'superseded');
  assert.equal(service.getPublished('reader', first.documentId)!.revision, 1);
  await service.publish(queue.claim(1000)!, await preview(context, first.documentId, 3, third.blob.digest));
  assert.equal(service.getPublished('reader', first.documentId)!.revision, 3);
});

test('stale saves are rejected before reading their source', async t => {
  const { service } = await fixture(t);
  const created = await service.create(metadata, bytes('first'));
  let consumed = false;
  async function* source() { consumed = true; yield Buffer.from('stale'); }
  await assert.rejects(service.save({ userId: 'owner', documentId: created.documentId, baseRevision: 0 }, source()), /CONFLICT/);
  assert.equal(consumed, false);
});

test('a revision race during streaming retains recovery without overwriting newer edits', async t => {
  const { service, db } = await fixture(t);
  const created = await service.create(metadata, bytes('first'));
  async function* racing() {
    yield Buffer.from('pending');
    await service.save({ userId: 'owner', documentId: created.documentId, baseRevision: 1 }, bytes('newer'));
    yield Buffer.from(' edits');
  }
  await assert.rejects(service.save({ userId: 'owner', documentId: created.documentId, baseRevision: 1 }, racing()), /CONFLICT/);
  assert.equal(service.processingStatus('owner', created.documentId)!.localRevision, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recovery_copies').get() as any).n, 1);
});

test('revoked write permission during streaming prevents commit and retains recovery', async t => {
  const { service, db } = await fixture(t);
  const created = await service.create(metadata, bytes('first'));
  async function* racing() {
    yield Buffer.from('pending');
    db.prepare("UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?")
      .run(JSON.stringify({ owner: { read: true, write: false } }), created.documentId);
    yield Buffer.from(' edits');
  }
  await assert.rejects(service.save({ userId: 'owner', documentId: created.documentId, baseRevision: 1 }, racing()), /ACCESS_DENIED/);
  assert.equal(service.processingStatus('owner', created.documentId)!.localRevision, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recovery_copies').get() as any).n, 1);
});

test('source mismatch, missing artifacts and expired leases cannot publish', async t => {
  const context = await fixture(t), { service, queue, tick } = context;
  const created = await service.create(metadata, bytes('first'));
  const claim = queue.claim(1000, 100)!;
  const manifest = await preview(context, created.documentId, 1, created.blob.digest);
  await assert.rejects(service.publish(claim, { ...manifest, sourceDigest: '0'.repeat(64) }), /INVALID_PREVIEW/);
  await assert.rejects(service.publish(claim, { ...manifest, artifacts: [{ ...manifest.artifacts[0], digest: '0'.repeat(64) }] }), /INVALID_PREVIEW/);
  tick(1100);
  await assert.rejects(service.publish(claim, manifest), /LEASE_LOST/);
  assert.equal(service.getPublished('reader', created.documentId), null);
});

test('changing converter versions rebuilds the same source without stale worker overwrite', async t => {
  const context = await fixture(t), { service, queue, db, store } = context;
  const created = await service.create(metadata, bytes('first'));
  await service.publish(queue.claim(1000)!, await preview(context, created.documentId, 1, created.blob.digest));
  const originalManifest = service.getPublished('reader', created.documentId)!.manifestDigest;
  const old = service.requestPreview('owner', created.documentId);
  const oldClaim = queue.claim(1000)!;
  const updated = new DocumentService(db, store, { clock: () => 1000, converterVersion: 'markdown-2' });
  const next = updated.requestPreview('owner', created.documentId);
  assert.notEqual(old.jobId, next.jobId);
  assert.equal(await service.publish(oldClaim, await preview(context, created.documentId, 1, created.blob.digest)), 'superseded');
  const nextClaim = queue.claim(1000)!;
  const manifest = { ...await preview(context, created.documentId, 1, created.blob.digest), converterVersion: 'markdown-2' };
  await updated.publish(nextClaim, manifest);
  assert.equal(updated.getPublished('reader', created.documentId)!.revision, 1);
  assert.equal(updated.getPublished('reader', created.documentId)!.converterVersion, 'markdown-2');
  assert.ok(db.prepare('SELECT 1 FROM preview_manifests WHERE manifest_digest=?').get(originalManifest));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM preview_manifests').get() as any).n, 2);
});

test('unpublished documents cannot be modified by another group writer', async t => {
  const { service, db } = await fixture(t);
  const created = await service.create(metadata, bytes('first'));
  db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?')
    .run(JSON.stringify({ reader: { read: true, write: true } }), created.documentId);
  await assert.rejects(service.save({ userId: 'reader', documentId: created.documentId, baseRevision: 1 }, bytes('replacement')), /NOT_FOUND/);
  assert.throws(() => service.requestPreview('reader', created.documentId), /NOT_FOUND/);
});


test('version timestamps distinguish rapid saves and survive a backward server clock', async t => {
  const {service,db,tick}=await fixture(t);
  const first=await service.create(metadata,bytes('first'));
  await service.save({userId:'owner',documentId:first.documentId,baseRevision:1},bytes('second'));
  tick(900);
  await service.save({userId:'owner',documentId:first.documentId,baseRevision:2},bytes('third'));
  tick(5000);
  await service.save({userId:'owner',documentId:first.documentId,baseRevision:3},bytes('fourth'));
  assert.deepEqual(db.prepare('SELECT created_at FROM document_versions WHERE document_id=? ORDER BY revision').all(first.documentId).map(row=>(row as {created_at:number}).created_at),[1000,1001,1002,5000]);
});
