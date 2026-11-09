import {GoogleActivity} from '../src/providers/google-activity.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buffer} from 'node:stream/consumers';
import {historyFixture,bytes} from './support/history-fixture.ts';
import {ProviderConnections} from '../src/providers/connections.ts';
import {FernetCodec} from '../src/providers/fernet.ts';
import {SecretConfigs} from '../src/providers/secret-config.ts';
import {CredentialVault} from '../src/providers/credential-vault.ts';
import {bindExistingSource} from '../src/providers/source-bindings.ts';
import {IngressWorker} from '../src/providers/ingress-worker.ts';
import {IngressScheduler} from '../src/providers/ingress-scheduler.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {officeWriteAllowed} from '../src/office/fence.ts';
import {ProviderIngress} from '../src/providers/ingress-inbox.ts';
import {randomUUID} from 'node:crypto';
import {JobQueue} from '../src/jobs.ts';
import {assertSourceDeliveryWritable} from '../src/providers/delivery-requests.ts';
async function fixture(t:any){
 const f=await historyFixture(t),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),configs=new SecretConfigs(codec);t.after(()=>codec.close());
 new ProviderConnections(f.db,configs).create('admin',{id:'google',provider:'google',label:'Google',path:'/',folderId:null,config:{root:'rootId'}});
 bindExistingSource(f.db,{documentId:f.first.documentId,connectionId:'google',reference:'file',fingerprint:'baseline',confirmedRevision:2,confirmedDigest:f.next.blob.digest,confirmedSize:3,now:Date.now()});
 let now=Date.now(),reads=0;const vault=new CredentialVault(f.db,configs);t.after(()=>vault.close());
 const scheduler=new IngressScheduler(f.db),worker=new IngressWorker(f.db,f.store,vault,async()=>({changed:async()=>true,read:async()=>{reads++;return {fingerprint:'fresh-drive',size:5,bytes:bytes('drive')};},close:async()=>{}}),{clock:()=>now});
 function open(format='docx'){f.db.prepare("UPDATE documents SET format=? WHERE id=?").run(format,f.first.documentId);return new OfficeSessions(f.db,{clock:()=>now}).open(f.sessions.writer.token,f.first.documentId);}
 return {...f,queue:new JobQueue(f.db),scheduler,worker,open,clock:()=>now,tick:(ms:number)=>now+=ms,reads:()=>reads};
}
test('Drive update supersedes an active Office session while retaining local version bytes',async t=>{
 const f=await fixture(t),opened=f.open();f.scheduler.tick(f.clock());
 assert.equal(await f.worker.runOnce(),'applied');
 assert.equal(officeWriteAllowed(f.db,f.first.documentId,opened.sessionId,f.clock()),false);
 const status=new OfficeSessions(f.db,{clock:f.clock}).status(f.sessions.writer.token,opened.sessionId,opened.token);assert.equal(status.changed,true);assert.equal(status.write,false);
 const current=f.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(f.first.documentId) as any;assert.deepEqual(current,{local_revision:3,provider_revision:3});
 assert.equal((await buffer(await f.store.read(f.next.blob.digest))).toString(),'new');
 assert.equal((f.db.prepare('SELECT COUNT(*) n FROM history_entries WHERE document_id=? AND digest=?').get(f.first.documentId,f.next.blob.digest) as any).n,1);
});
test('Drive priority retains an unsynced local revision and prepared failed Office recovery',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('local draft')),opened=f.open(),id=randomUUID();
 f.db.prepare("INSERT INTO office_ingress(id,document_id,office_session_id,author_id,base_revision,base_digest,lock_value,reserved_bytes,state,digest,size,lease_token,lease_until,created_at,error_code) VALUES(?,?,?,'writer',3,?,'',5,'prepared',?,5,'old',0,?,'SOURCE_SAVE_UNSUPPORTED')").run(id,f.first.documentId,opened.sessionId,local.blob.digest,local.blob.digest,f.clock());
 f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');
 assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,4);
 assert.equal((await buffer(await f.store.read(local.blob.digest))).toString(),'local draft');
 assert.equal((f.db.prepare('SELECT state,digest FROM office_ingress WHERE id=?').get(id) as any).digest,local.blob.digest);
});
test('automatic polling replaces an old OFFICE_ACTIVE conflict with a freshly read Drive snapshot',async t=>{
 const f=await fixture(t),inbox=new ProviderIngress(f.db,f.store,{clock:f.clock});f.scheduler.tick(f.clock());const job=f.queue.claim(f.clock(),30000,'provider.pull')!,slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?)").run(slotToken,f.clock()+30000);
 const snapshot=inbox.begin({job,slotToken,documentId:f.first.documentId,connectionRevision:1,baseLocalRevision:2,baseProviderRevision:2,baseFingerprint:'baseline',observedFingerprint:'old-drive',declaredSize:3,observedAt:f.clock()});await inbox.receive(snapshot.id,job,bytes('old'));
 f.db.prepare("UPDATE provider_ingress_snapshots SET state='conflict',error_code='OFFICE_ACTIVE' WHERE id=?").run(snapshot.id);f.queue.complete(job,f.clock());f.db.prepare("DELETE FROM worker_slots WHERE name='provider-source'").run();f.tick(30001);f.scheduler.tick(f.clock());
 assert.equal(await f.worker.runOnce(),'applied');assert.equal(f.reads(),1);assert.equal(inbox.latest(f.first.documentId)?.observed_fingerprint,'fresh-drive');
});
test('active Google documents poll in two seconds and inactive documents keep the normal interval',async t=>{
 const f=await fixture(t);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');f.tick(2001);assert.equal(f.scheduler.tick(f.clock()).queued,0);
 f.open();assert.equal(f.scheduler.tick(f.clock()).queued,1);assert.equal(await f.worker.runOnce(),'applied');f.tick(1999);assert.equal(f.scheduler.tick(f.clock()).queued,0);f.tick(2);assert.equal(f.scheduler.tick(f.clock()).queued,1);
});
test('a same-content Drive acknowledgement advances provider revision without invalidating Office',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('drive')),opened=f.open();f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');
 assert.equal((f.db.prepare('SELECT provider_revision FROM documents WHERE id=?').get(f.first.documentId) as any).provider_revision,local.revision);
 assert.equal(officeWriteAllowed(f.db,f.first.documentId,opened.sessionId,f.clock()),true);
});
function attempt(f:any,state:'unknown'|'conflict'|'confirmed',version:any,fingerprint?:string,baseline='baseline'){
 const id=randomUUID(),job=f.queue.enqueue({kind:'provider.deliver',key:id,payload:{documentId:f.first.documentId,requestedRevision:version.revision}},f.clock());
 f.db.prepare("INSERT INTO provider_delivery_attempts(id,document_id,revision,author_id,digest,size,baseline,base_revision,binding_generation,connection_revision,state,lease_job_id,lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,'writer',?,?,?,2,1,1,'prepared',?,'old',0,?,?)").run(id,f.first.documentId,version.revision,version.blob.digest,version.blob.size,baseline,job,f.clock(),f.clock());
 f.db.prepare("UPDATE provider_delivery_attempts SET state='writing' WHERE id=?").run(id);f.db.prepare('UPDATE provider_delivery_attempts SET state=?,receipt_fingerprint=? WHERE id=?').run(state,fingerprint??null,id);return id;
}
test('unknown dispatched writes still block Drive adoption and preserve both observations',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('local'));attempt(f,'unknown',local);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'conflict');
 assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,3);assert.equal((f.db.prepare('SELECT state FROM provider_delivery_attempts').get() as any).state,'unknown');
 const a=f.db.prepare('SELECT id FROM provider_delivery_attempts').get() as any,snapshot=f.db.prepare('SELECT id FROM provider_ingress_snapshots').get() as any;assert.throws(()=>f.db.prepare('INSERT INTO provider_ingress_supersessions VALUES(?,?,?)').run(a.id,snapshot.id,f.clock()),/requires an applied Drive snapshot/);assert.throws(()=>f.db.prepare("UPDATE provider_delivery_attempts SET state='retired' WHERE id=?").run(a.id),/Invalid provider attempt transition/);
});
test('a definite failed write does not prevent an external Drive update',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('local'));attempt(f,'conflict',local);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');
 assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,4);assert.equal((await buffer(await f.store.read(local.blob.digest))).toString(),'local');assert.equal((f.db.prepare('SELECT state FROM provider_delivery_attempts').get() as any).state,'retired');assert.equal((f.db.prepare('SELECT COUNT(*) n FROM provider_ingress_supersessions').get() as any).n,1);assert.throws(()=>f.db.prepare('DELETE FROM provider_ingress_supersessions').run(),/retained/);
});
test('an acknowledged Office binary echo never replaces a newer local draft',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('drive')),fingerprint=JSON.stringify(['google-binary-v2','file','version','a'.repeat(64)]);attempt(f,'confirmed',local,fingerprint);
 f.db.prepare('UPDATE provider_source_bindings SET fingerprint=?,confirmed_revision=3 WHERE document_id=?').run(fingerprint,f.first.documentId);f.db.prepare('UPDATE documents SET provider_revision=3 WHERE id=?').run(f.first.documentId);
 const draft=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:3},bytes('newer local draft'));f.open();
 f.scheduler.tick(f.clock());const job=f.queue.claim(f.clock(),30000,'provider.pull')!,slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?)").run(slotToken,f.clock()+30000);const inbox=new ProviderIngress(f.db,f.store,{clock:f.clock});
 const snapshot=inbox.begin({job,slotToken,documentId:f.first.documentId,connectionRevision:1,baseLocalRevision:4,baseProviderRevision:3,baseFingerprint:fingerprint,observedFingerprint:JSON.stringify(['google-binary-v2','file','new-metadata','a'.repeat(64)]),declaredSize:5,observedAt:f.clock()});await inbox.receive(snapshot.id,job,bytes('drive'));await inbox.commit(snapshot.id,job);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,4);assert.equal((await buffer(await f.store.read(draft.blob.digest))).toString(),'newer local draft');assert.equal(new GoogleActivity(f.db).status('writer',f.first.documentId,f.clock()),null,'Own acknowledged echo is not external activity');
});
test('an accepted newer Drive observation clears stale incoming conflict fences even if Drive reverted',async t=>{
 const {hasIncomingSourceConflict}=await import('../src/providers/source-conflict.ts'),f=await fixture(t),inbox=new ProviderIngress(f.db,f.store,{clock:f.clock});f.scheduler.tick(f.clock());let job=f.queue.claim(f.clock(),30000,'provider.pull')!,slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?)").run(slotToken,f.clock()+30000);
 const old=inbox.begin({job,slotToken,documentId:f.first.documentId,connectionRevision:1,baseLocalRevision:2,baseProviderRevision:2,baseFingerprint:'baseline',observedFingerprint:'temporary',declaredSize:3,observedAt:f.clock()});await inbox.receive(old.id,job,bytes('old'));f.db.prepare("UPDATE provider_ingress_snapshots SET state='conflict',error_code='OFFICE_ACTIVE' WHERE id=?").run(old.id);await inbox.discard(old.id,job);f.queue.complete(job,f.clock());f.db.prepare("DELETE FROM worker_slots WHERE name='provider-source'").run();
 f.tick(30001);f.scheduler.tick(f.clock());job=f.queue.claim(f.clock(),30000,'provider.pull')!;slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?)").run(slotToken,f.clock()+30000);
 const accepted=inbox.begin({job,slotToken,documentId:f.first.documentId,connectionRevision:1,baseLocalRevision:2,baseProviderRevision:2,baseFingerprint:'baseline',observedFingerprint:'baseline',declaredSize:3,observedAt:f.clock()});await inbox.receive(accepted.id,job,bytes('new'));await inbox.commit(accepted.id,job);assert.equal(hasIncomingSourceConflict(f.db,f.first.documentId),false);
});
test('metadata-only Drive changes preserve pending Office and Canvas bytes and requeue their delivery',async t=>{
 for(const [format,metadataHash] of [['docx','a'],['pptx','a'],['canvas','b']]){
  const f=await fixture(t),before=JSON.stringify(['google-binary-v2','file','1','a'.repeat(64)]),after=JSON.stringify(['google-binary-v2','file','2',metadataHash.repeat(64)]);
  f.db.prepare('UPDATE provider_source_bindings SET fingerprint=? WHERE document_id=?').run(before,f.first.documentId);
  if(format!=='canvas')attempt(f,'confirmed',{revision:2,blob:f.next.blob},before,before);
  const local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('pending local'));
  const opened=format!=='canvas'?f.open(format):null;if(!opened)f.db.prepare('UPDATE documents SET format=? WHERE id=?').run(format,f.first.documentId);
  const recovery=format==='pptx'?await failedOfficeRecovery(f,opened!,local):null;
  const failed=attempt(f,'conflict',local,undefined,before);f.scheduler.tick(f.clock());const job=f.queue.claim(f.clock(),30000,'provider.pull')!,slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?)").run(slotToken,f.clock()+30000);
  const inbox=new ProviderIngress(f.db,f.store,{clock:f.clock}),snapshot=inbox.begin({job,slotToken,documentId:f.first.documentId,connectionRevision:1,baseLocalRevision:3,baseProviderRevision:2,baseFingerprint:before,observedFingerprint:after,declaredSize:3,observedAt:f.clock()});await inbox.receive(snapshot.id,job,bytes('new'));const receipt=await inbox.commit(snapshot.id,job);
  assert.deepEqual(f.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(f.first.documentId),{local_revision:3,provider_revision:2});assert.equal(receipt.changed,false);assert.equal(receipt.revision,2);
  assert.equal((await buffer(await f.store.read(local.blob.digest))).toString(),'pending local');if(opened)assert.equal(officeWriteAllowed(f.db,f.first.documentId,opened.sessionId,f.clock()),true);
  assert.equal((f.db.prepare('SELECT fingerprint FROM provider_source_bindings WHERE document_id=?').get(f.first.documentId) as any).fingerprint,after);assert.equal((f.db.prepare('SELECT state FROM provider_delivery_attempts WHERE id=?').get(failed) as any).state,'retired');
  const pending=f.db.prepare('SELECT r.requested_revision,j.state,j.payload,j.dedupe_key FROM provider_delivery_requests r JOIN jobs j ON j.id=r.delivery_job_id WHERE r.document_id=?').get(f.first.documentId) as any;assert.equal(pending.requested_revision,3);assert.equal(pending.state,'queued');assert.deepEqual(JSON.parse(pending.payload),{documentId:f.first.documentId,requestedRevision:3});assert.ok(pending.dedupe_key.includes(snapshot.id));
  assert.doesNotThrow(()=>assertSourceDeliveryWritable(f.db,f.first.documentId,f.clock()));if(recovery){assert.equal((f.db.prepare('SELECT state FROM save_operations WHERE id=?').get(recovery.id) as any).state,'staged');assert.equal((f.db.prepare('SELECT error_code FROM office_ingress WHERE id=?').get(recovery.id) as any).error_code,'CONFLICT');const source=await f.store.existingUploadStore(recovery.id);assert.ok(source);assert.equal((await buffer(await source.read(recovery.blob.digest))).toString(),'shape deletion recovery');}
 }
});

async function failedOfficeRecovery(f:any,opened:any,local:any,errorCode:string|null='CONFLICT'){
 const id=randomUUID(),source=await f.store.uploadStore(id),blob=await source.put(bytes('shape deletion recovery'),{maxBytes:100});await f.store.adopt(source,blob);
 f.db.prepare("INSERT INTO office_ingress(id,document_id,office_session_id,author_id,base_revision,base_digest,lock_value,reserved_bytes,state,digest,size,lease_token,lease_until,created_at,error_code) VALUES(?,?,?,'writer',3,?,'',?,'prepared',?,?,'finished',?,?,?)").run(id,f.first.documentId,opened.sessionId,local.blob.digest,blob.size,blob.digest,blob.size,f.clock()+30000,f.clock(),errorCode);
 f.db.prepare("INSERT INTO save_operations(id,document_id,author_id,base_revision,base_digest,digest,size,state,created_at,updated_at,office_session_id) VALUES(?,?,'writer',3,?,?,?,'staged',?,?,?)").run(id,f.first.documentId,local.blob.digest,blob.digest,blob.size,f.clock(),f.clock(),opened.sessionId);
 f.db.prepare('UPDATE office_sessions SET pending_operation_id=? WHERE id=?').run(id,opened.sessionId);return {id,blob};
}
test('active staged Office saves fence Drive until rejected recovery is recorded, then real Drive changes win',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('pending local')),opened=f.open('pptx'),recovery=await failedOfficeRecovery(f,opened,local,null);
 f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'conflict');assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,3);
 f.db.prepare("UPDATE office_ingress SET error_code='CONFLICT' WHERE id=?").run(recovery.id);f.tick(30001);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,4);assert.equal(officeWriteAllowed(f.db,f.first.documentId,opened.sessionId,f.clock()),false);
 assert.equal((f.db.prepare('SELECT state FROM save_operations WHERE id=?').get(recovery.id) as any).state,'staged');const source=await f.store.existingUploadStore(recovery.id);assert.ok(source);assert.equal((await buffer(await source.read(recovery.blob.digest))).toString(),'shape deletion recovery');
});
test('a non-Office staged save cannot borrow a rejected Office recovery to bypass the save fence',async t=>{
 const f=await fixture(t),local=await f.docs.save({userId:'writer',documentId:f.first.documentId,baseRevision:2},bytes('pending local')),opened=f.open('pptx'),recovery=await failedOfficeRecovery(f,opened,local);
 f.db.prepare('UPDATE save_operations SET office_session_id=NULL WHERE id=?').run(recovery.id);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'conflict');assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,3);
});

test('Google activity uses verified inbound content only, expires locally, and respects ACL and disabled connections',async t=>{const f=await fixture(t),activity=new GoogleActivity(f.db);assert.equal(activity.status('writer',f.first.documentId,f.clock()),null);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');let value=activity.status('writer',f.first.documentId,f.clock())!;assert.equal(value.revision,3);assert.equal(value.activeForMs,60000);f.tick(61000);assert.equal(activity.status('writer',f.first.documentId,f.clock())!.activeForMs,0);f.scheduler.tick(f.clock());assert.equal(await f.worker.runOnce(),'applied');assert.equal(activity.status('writer',f.first.documentId,f.clock())!.activeForMs,0);f.db.prepare("UPDATE provider_connections SET enabled=0 WHERE id='google'").run();assert.equal(activity.status('writer',f.first.documentId,f.clock()),null);assert.throws(()=>activity.status('foreign',f.first.documentId,f.clock()),/NOT_FOUND/);});
