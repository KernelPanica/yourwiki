import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { openDatabase } from '../src/database.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { DocumentService, DocumentError } from '../src/documents.ts';
import { PdfLayerService } from '../src/pdf-layers.ts';
async function* bytes(value: string) { yield Buffer.from(value); }
async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-pdf-layer-'));
  const db = openDatabase(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  db.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('reader','reader','Reader','!');
    INSERT INTO groups(id,name) VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('reader','team');`);
  const store = await BlobStore.open(root), docs = new DocumentService(db, store);
  const created = await docs.create({ userId: 'owner', parentId: null, groupId: 'team', title: 'PDF', format: 'pdf' }, bytes('%PDF-1.7 original'));
  const layers = new PdfLayerService(db, store, { maxBytes: 1000 });
  const input = { userId: 'owner', documentId: created.documentId, baseRevision: 1, layerRevision: 0 };
  return { db, store, docs, created, layers, input };
}
test('PDF layers preserve original and old artifacts while advancing independent revisions', async t => {
  const { db, store, layers, created, input } = await setup(t);
  const first = await layers.save(input, bytes('%PDF-1.7 annotated'));
  assert.equal(first.layerRevision, 1);
  const second = await layers.save({ ...input, layerRevision: 1 }, bytes('%PDF-1.7 form filled'));
  assert.equal(second.layerRevision, 2);
  assert.equal((db.prepare('SELECT local_revision FROM documents WHERE id=?').get(created.documentId) as any).local_revision, 1);
  assert.equal((await buffer(await store.read(created.blob.digest))).toString(), '%PDF-1.7 original');
  assert.equal((await buffer(await store.read(first.digest))).toString(), '%PDF-1.7 annotated');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pdf_layer_versions').get() as any).n, 2);
  assert.equal(layers.state('owner', created.documentId)!.layerRevision, 2);
});
test('two PDF writers cannot overwrite each other; conflicting bytes are retained', async t => {
  const { db, store, layers, input } = await setup(t);
  const results = await Promise.allSettled([layers.save(input, bytes('%PDF-1.7 first')), layers.save(input, bytes('%PDF-1.7 second'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failed.reason instanceof DocumentError);
  assert.equal(failed.reason.code, 'CONFLICT');
  assert.ok(failed.reason.recoveryId);
  const copy = db.prepare('SELECT digest,author_id FROM recovery_copies WHERE id=?').get(failed.reason.recoveryId) as any;
  assert.equal(copy.author_id, 'owner');
  assert.match((await buffer(await store.read(copy.digest))).toString(), /^%PDF-1.7 (first|second)$/);
});
test('changed PDF base requires explicit layer replacement and exact current revisions', async t => {
  const { layers, docs, input } = await setup(t);
  await layers.save(input, bytes('%PDF-1.7 old annotations'));
  await docs.save({ userId: 'owner', documentId: input.documentId, baseRevision: 1 }, bytes('%PDF-1.7 new original'));
  assert.equal(layers.state('owner', input.documentId)!.state, 'conflict');
  await assert.rejects(layers.save({ ...input, baseRevision: 2, layerRevision: 1 }, bytes('%PDF-1.7 new edits')), /CONFLICT/);
  const saved = await layers.save({ ...input, baseRevision: 2, layerRevision: 1, replaceStaleLayer: true }, bytes('%PDF-1.7 new edits'));
  assert.equal(saved.layerRevision, 2);
  assert.equal(layers.state('owner', input.documentId)!.state, 'saved');
});
test('PDF layer writes recheck permission after streaming and retain interrupted authorization copies', async t => {
  const { db, layers, input } = await setup(t);
  async function* revoke() {
    yield Buffer.from('%PDF-1.7 edits');
    db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?').run(JSON.stringify({ owner: { read: true, write: false } }), input.documentId);
  }
  await assert.rejects(layers.save(input, revoke()), (error: any) => error.code === 'ACCESS_DENIED' && !!error.recoveryId);
  let consumed = false;
  async function* denied() { consumed = true; yield Buffer.from('%PDF-1.7'); }
  await assert.rejects(layers.save(input, denied()), /ACCESS_DENIED/);
  assert.equal(consumed, false);
});
test('PDF save pins caller identity and revision inputs across asynchronous source reads', async t => {
  const { layers, input } = await setup(t);
  async function* mutate() {
    input.userId = 'reader'; input.baseRevision = 99; input.layerRevision = 99;
    yield Buffer.from('%PDF-1.7 annotation');
  }
  const saved = await layers.save(input, mutate());
  assert.equal(saved.baseRevision, 1); assert.equal(saved.layerRevision, 1);
});
test('PDF size bounds do not publish a partial annotation layer', async t => {
  const { layers, input, db } = await setup(t);
  await assert.rejects(layers.save(input, bytes('x'.repeat(1001))), /size limit/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pdf_layer_versions').get() as any).n, 0);
});
test('prepared PDF commit reuses verified immutable bytes and joins its caller transaction', async t => {
  const {db,store,layers,input}=await setup(t);
  const blob=await store.put(bytes('%PDF-1.7 archived'),{maxBytes:1000});
  db.exec('BEGIN IMMEDIATE');
  const saved=layers.commitPreparedSave(input,blob);
  assert.equal(saved.layerRevision,1);assert.equal(saved.digest,blob.digest);
  db.exec('ROLLBACK');
  assert.equal(layers.state(input.userId,input.documentId)!.layerRevision,0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind=?').get('pdf.layer.saved') as any).n,0);
  assert.equal(layers.commitPreparedSave(input,blob).layerRevision,1);
  assert.throws(()=>layers.commitPreparedSave(input,blob),/CONFLICT/);
});
test('prepared PDF commit rejects malformed references and revoked or aborted commits', async t=>{
  const {db,store,layers,input}=await setup(t),blob=await store.put(bytes('%PDF-1.7 archived'),{maxBytes:1000});
  for(const invalid of [{...blob,digest:'bad'},{...blob,size:1001},{...blob,size:-1},{...blob,size:1.5}])assert.throws(()=>layers.commitPreparedSave(input,invalid),/INVALID_REQUEST/);
  assert.throws(()=>layers.commitPreparedSave({...input,layerRevision:-1},blob),/INVALID_REQUEST/);
  const controller=new AbortController();controller.abort();
  assert.throws(()=>layers.commitPreparedSave({...input,signal:controller.signal},blob),/abort/i);
  db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:true,write:false}}),input.documentId);
  assert.throws(()=>layers.commitPreparedSave(input,blob),/ACCESS_DENIED/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pdf_layer_versions').get() as any).n,0);
});
