import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setupIngress} from './support/provider-ingress-fixture.ts';
import {bytes} from './support/history-fixture.ts';
import {openDatabase} from '../src/database.ts';
import {ProviderIngress} from '../src/providers/ingress-inbox.ts';
test('bounded observation reserves the upper bound before reading and records actual smaller bytes',async t=>{
 const f=await setupIngress(t),input={...f.claim(),declaredSize:10,sizingMode:'bounded' as const},snapshot=f.inbox.begin(input);let read=false;
 assert.equal(snapshot.reservedBytes,10);assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,10);
 const staged=await f.inbox.receive(snapshot.id,input.job,(async function*(){read=true;assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,10);yield Buffer.from('out');})());assert.equal(read,true);assert.equal(staged.blob?.size,3);assert.equal(staged.reservedBytes,10);assert.equal(f.inbox.prepared(snapshot.id,input.job).sizing_mode,'bounded');
 const receipt=await f.inbox.commit(snapshot.id,input.job);assert.equal(receipt.changed,true);assert.equal((f.db.prepare('SELECT size FROM document_versions WHERE document_id=? AND revision=3').get(input.documentId) as any).size,3);assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,10);await f.inbox.cleanupApplied(snapshot.id,input.job);assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,0);
});
test('exact observations stay exact and a bounded overflow never changes the document',async t=>{
 for(const mode of ['exact','bounded'] as const){const f=await setupIngress(t),input={...f.claim(),declaredSize:5,sizingMode:mode},snapshot=f.inbox.begin(input),before=f.db.prepare('SELECT * FROM documents').all();await assert.rejects(f.inbox.receive(snapshot.id,input.job,bytes(mode==='exact'?'out':'overflow')));assert.deepEqual(f.db.prepare('SELECT * FROM documents').all(),before);assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,5);await f.inbox.discard(snapshot.id,input.job);assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,0);}
});
test('bounded reservation is idempotent, survives reopen and cannot become a different sizing contract',async t=>{
 const f=await setupIngress(t),input={...f.claim(),declaredSize:10,sizingMode:'bounded' as const},snapshot=f.inbox.begin(input);await f.inbox.receive(snapshot.id,input.job,bytes('out'));const db=openDatabase(f.path);t.after(()=>db.close());const inbox=new ProviderIngress(db,f.store);assert.equal(inbox.begin(input).id,snapshot.id);assert.equal(inbox.prepared(snapshot.id,input.job).size,3);assert.equal(inbox.prepared(snapshot.id,input.job).reserved_bytes,10);assert.throws(()=>db.prepare("UPDATE provider_ingress_snapshots SET sizing_mode='exact'").run(),/immutable/);assert.throws(()=>db.prepare('UPDATE provider_ingress_snapshots SET size=11').run());assert.throws(()=>db.prepare('UPDATE provider_ingress_snapshots SET reserved_bytes=3').run(),/retained/);
 const exact=f.inbox.begin({...input,sizingMode:'exact'});assert.notEqual(exact.id,snapshot.id);
});
test('quota is checked against the reserved cap, not eventual short body, and sizing values are strict',async t=>{
 const f=await setupIngress(t,{maxPendingBytes:4}),input={...f.claim(),declaredSize:10,sizingMode:'bounded' as const};assert.throws(()=>f.inbox.begin(input),/INGRESS_QUOTA/);assert.deepEqual(f.db.prepare('SELECT * FROM provider_ingress_snapshots').all(),[]);for(const mode of ['other',null,0])assert.throws(()=>f.inbox.begin({...input,declaredSize:3,sizingMode:mode as any}),/INVALID_INGRESS/);
});
