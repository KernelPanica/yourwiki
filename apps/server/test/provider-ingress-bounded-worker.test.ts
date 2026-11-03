import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setupIngress} from './support/provider-ingress-fixture.ts';
import {bytes} from './support/history-fixture.ts';
import {IngressWorker} from '../src/providers/ingress-worker.ts';
import {IngressScheduler} from '../src/providers/ingress-scheduler.ts';
import type {ProviderAdapter} from '../src/providers/adapter.ts';
function remote(source:()=>AsyncIterable<Uint8Array>,maxSize=10):ProviderAdapter{return {read:async()=>({fingerprint:'native-export',size:null,maxSize,bytes:source()}),replace:async()=>{throw new Error('must not write');},retire:async()=>{},close:async()=>{}};}
test('worker reserves unknown body cap before consuming and commits its actual byte size',async t=>{
 const f=await setupIngress(t);let read=false;new IngressScheduler(f.db).tick(f.clock());const worker=new IngressWorker(f.db,f.store,f.vault,async()=>remote(()=> (async function*(){read=true;assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,10);yield Buffer.from('out');})()),{clock:f.clock});assert.equal(await worker.runOnce(),'applied');assert.equal(read,true);const snapshot=f.db.prepare('SELECT sizing_mode,declared_size,size,reserved_bytes FROM provider_ingress_snapshots').get();assert.deepEqual(snapshot,{sizing_mode:'bounded',declared_size:10,size:3,reserved_bytes:0});assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,3);
});
test('staged bounded source survives restart-style verification with actual bytes, not its maximum',async t=>{
 const f=await setupIngress(t),input={...f.claim(),declaredSize:10,sizingMode:'bounded' as const,observedFingerprint:'native-export'},snapshot=f.inbox.begin(input);await f.inbox.receive(snapshot.id,input.job,bytes('out'));f.queue.complete(input.job,f.clock());f.db.prepare("DELETE FROM worker_slots WHERE name='provider-source'").run();f.queue.enqueue({kind:'provider.pull',key:randomUUID(),payload:{documentId:f.first.documentId}},f.clock());assert.equal(await new IngressWorker(f.db,f.store,f.vault,async()=>remote(()=>bytes('out')),{clock:f.clock}).runOnce(),'applied');assert.equal((f.db.prepare('SELECT count(*) AS n FROM provider_ingress_snapshots').get() as any).n,1);assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,0);
});
test('unknown size requires a finite bounded cap and invalid metadata consumes no body',async t=>{
 for(const cap of [NaN,-1,4294967297]){const f=await setupIngress(t);let consumed=false;new IngressScheduler(f.db).tick(f.clock());assert.equal(await new IngressWorker(f.db,f.store,f.vault,async()=>remote(()=> (async function*(){consumed=true;yield Buffer.from('out');})(),cap),{clock:f.clock}).runOnce(),'blocked');assert.equal(consumed,false);assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,2);}
});
