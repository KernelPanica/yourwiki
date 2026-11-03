import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {historyFixture,bytes} from './support/history-fixture.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {SaveJournal} from '../src/save-journal.ts';
import {ProviderIngress} from '../src/providers/ingress-inbox.ts';
import {JobQueue} from '../src/jobs.ts';
import {FernetCodec} from '../src/providers/fernet.ts';
import {SecretConfigs} from '../src/providers/secret-config.ts';
import {ProviderConnections} from '../src/providers/connections.ts';
import {bindExistingSource} from '../src/providers/source-bindings.ts';
import {buildApp} from '../src/app.ts';
async function fixture(t:any){
 const f=await historyFixture(t),id=f.first.documentId,codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=');t.after(()=>codec.close());new ProviderConnections(f.db,new SecretConfigs(codec)).create('admin',{id:'google',provider:'google',label:'Google',path:'/',folderId:null,config:{root:'ownedRoot',client_id:'owned',client_secret:'SYNTHETIC',refresh_token:'SYNTHETIC'}});
 bindExistingSource(f.db,{documentId:id,connectionId:'google',reference:'original',fingerprint:'baseline',confirmedRevision:2,confirmedDigest:f.next.blob.digest,confirmedSize:f.next.blob.size,now:Date.now()});
 const office=new OfficeSessions(f.db),one=office.open(f.sessions.writer.token,id),two=office.open(f.sessions.reader.token,id),queue=new JobQueue(f.db),inbox=new ProviderIngress(f.db,f.store);
 function begin(){const now=Date.now();queue.enqueue({kind:'provider.pull',key:randomUUID(),payload:{documentId:id}},now);const job=queue.claim(now,30000,'provider.pull')!;assert.ok(job);const slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slotToken,now+30000);const snapshot=inbox.begin({documentId:id,job,slotToken,connectionRevision:1,baseLocalRevision:2,baseProviderRevision:2,baseFingerprint:'baseline',observedFingerprint:'external',declaredSize:3,observedAt:now},now);return {snapshot,job};}
 return {...f,id,office,one,two,inbox,begin};
}
test('a verified Google incoming conflict stops both active office sessions before local revision changes',async t=>{
 const f=await fixture(t);f.office.lock(f.one.sessionId,f.one.token,'LOCK','lock');const incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));
 assert.equal((f.db.prepare('SELECT state FROM provider_ingress_snapshots WHERE id=?').get(incoming.snapshot.id) as any).state,'conflict');
 for(const [browser,opened] of [[f.sessions.writer,f.one],[f.sessions.reader,f.two]] as const){const status=f.office.status(browser.token,opened.sessionId,opened.token);assert.equal(status.changed,true);assert.equal(status.write,false);assert.equal(status.errorCode,'CONFLICT');}
 assert.throws(()=>f.office.lock(f.one.sessionId,f.one.token,'REFRESH_LOCK','lock'),/CONFLICT/);
 assert.throws(()=>f.office.open(f.sessions.writer.token,f.id),/CONFLICT/);
 assert.deepEqual(f.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(f.id),{local_revision:2,provider_revision:2});
});
test('an already prepared Office save cannot commit after a verified external change without a status poll',async t=>{
 const f=await fixture(t),journal=new SaveJournal(f.db,f.store),blob=await f.store.put(bytes('my retained edits'),{maxBytes:100});await journal.stagePrepared({operationId:'office-source-conflict',userId:'writer',documentId:f.id,baseRevision:2,baseDigest:f.next.blob.digest,officeSessionId:f.one.sessionId,blob});
 const incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));
 assert.throws(()=>journal.commit('writer','office-source-conflict'),/CONFLICT/);assert.equal(journal.status('writer','office-source-conflict').state,'conflict');assert.equal(await f.store.verify(blob),true);
 assert.deepEqual(f.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(f.id),{local_revision:2,provider_revision:2});
 f.office.release(f.sessions.writer.token,f.one.sessionId,f.one.token);assert.equal(journal.status('writer','office-source-conflict').state,'conflict');assert.equal(f.office.status(f.sessions.reader.token,f.two.sessionId,f.two.token).changed,true);
});
test('unverified or failed incoming reads do not falsely declare the original changed',async t=>{
 const f=await fixture(t),incoming=f.begin();assert.equal(f.office.status(f.sessions.writer.token,f.one.sessionId,f.one.token).changed,false);
 f.db.prepare("UPDATE provider_ingress_snapshots SET state='failed',error_code='PROVIDER_UNAVAILABLE' WHERE id=?").run(incoming.snapshot.id);assert.equal(f.office.status(f.sessions.writer.token,f.one.sessionId,f.one.token).changed,false);
});
test('HTTP status and WOPI preserve conflict recovery warnings and release never saves',async t=>{
 const f=await fixture(t),app=buildApp({database:f.db,storage:f.store,publicUrl:'https://wiki.test',office:{publicUrl:'https://wiki.test/collabora'}});t.after(()=>app.close());const incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));
 const response=await app.inject({method:'POST',url:`/api/office/${f.one.sessionId}/status`,headers:f.headers('writer'),payload:{accessToken:f.one.token}});assert.equal(response.statusCode,200);assert.equal(response.json().changed,true);assert.equal(response.json().errorCode,'CONFLICT');
 const lock=await app.inject({method:'POST',url:`/wopi/files/${f.one.sessionId}?access_token=${f.one.token}`,headers:{'x-wopi-override':'LOCK','x-wopi-lock':'lock'}});assert.equal(lock.statusCode,409);assert.equal(lock.json().COOLStatusCode,1010);assert.deepEqual(lock.json().recoveryActions,['copy_changes','download_changes','reload']);
 const intent=await app.inject({method:'POST',url:`/api/office/${f.one.sessionId}/save-intents`,headers:f.headers('writer'),payload:{accessToken:f.one.token}});assert.equal(intent.statusCode,409);assert.equal(intent.json().code,'CONFLICT');
 assert.equal((await app.inject({method:'POST',url:`/api/office/${f.one.sessionId}/release`,headers:f.headers('writer'),payload:{accessToken:f.one.token}})).statusCode,204);assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.id) as any).local_revision,2);
});

test('a remote change found during Office validation retains both payloads and never commits',async t=>{
 const {OfficeIngress}=await import('../src/office/ingress.ts'),{OfficeSaves}=await import('../src/office/saves.ts');const f=await fixture(t);f.office.lock(f.one.sessionId,f.one.token,'LOCK','lock');const ingress=new OfficeIngress(f.db,f.store);t.after(()=>ingress.close());
 const saves=new OfficeSaves(f.db,f.store,ingress,{validator:{validate:async()=>{const incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));}}});
 const created=(f.db.prepare('SELECT created_at FROM document_versions WHERE document_id=? AND revision=2').get(f.id) as any).created_at;
 await assert.rejects(saves.save({sessionId:f.one.sessionId,token:f.one.token,lock:'lock',declaredSize:5,lastModifiedTime:new Date(created).toISOString()},bytes('edits')),/CONFLICT/);
 const recovery=f.db.prepare('SELECT id,state,error_code FROM office_ingress WHERE document_id=?').get(f.id) as any;assert.equal(recovery.state,'prepared');assert.equal(recovery.error_code,'CONFLICT');assert.ok(await ingress.payloadStore('writer',recovery.id));assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.id) as any).local_revision,2);
 assert.equal((f.db.prepare('SELECT state FROM provider_ingress_snapshots WHERE document_id=?').get(f.id) as any).state,'conflict');
});
test('save-intent polling sees external conflict without requiring a separate session status request',async t=>{
 const {OfficeSaveIntents}=await import('../src/office/save-intents.ts');const f=await fixture(t),intents=new OfficeSaveIntents(f.db),ticket=intents.issue(f.sessions.writer.token,f.one.sessionId,f.one.token),incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));
 const proof=intents.status(f.sessions.writer.token,f.one.sessionId,ticket.tag);assert.equal(proof.changed,true);assert.equal(proof.state,'pending');assert.equal(proof.revision,null);
});
test('changing the accepted baseline makes older incoming evidence irrelevant to a fresh session',async t=>{
 const f=await fixture(t),incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));assert.equal(f.office.status(f.sessions.writer.token,f.one.sessionId,f.one.token).changed,true);
 // Trusted source-acceptance transaction is tested separately; here isolate receipt scope.
 f.db.prepare("UPDATE provider_source_bindings SET fingerprint='accepted-new-baseline' WHERE document_id=?").run(f.id);
 const fresh=f.office.open(f.sessions.writer.token,f.id);assert.notEqual(fresh.sessionId,f.one.sessionId);assert.equal(f.office.status(f.sessions.writer.token,fresh.sessionId,fresh.token).changed,false);assert.equal(f.office.status(f.sessions.writer.token,f.one.sessionId,f.one.token).changed,true);
});
test('discarding incoming bytes does not erase verified evidence that the original changed',async t=>{
 const f=await fixture(t),incoming=f.begin();await f.inbox.receive(incoming.snapshot.id,incoming.job,bytes('out'));await f.inbox.discard(incoming.snapshot.id,incoming.job);
 assert.equal((f.db.prepare('SELECT state FROM provider_ingress_snapshots WHERE id=?').get(incoming.snapshot.id) as any).state,'discarded');
 assert.equal(f.office.status(f.sessions.writer.token,f.one.sessionId,f.one.token).changed,true);assert.throws(()=>f.office.open(f.sessions.writer.token,f.id),/CONFLICT/);
 assert.deepEqual(f.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(f.id),{local_revision:2,provider_revision:2});
});
