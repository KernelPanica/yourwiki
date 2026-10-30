import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {buffer} from 'node:stream/consumers';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService} from '../src/documents.ts';
import {createSession} from '../src/auth/sessions.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {SaveJournal} from '../src/save-journal.ts';
import {OfficeIngress} from '../src/office/ingress.ts';
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any,options={}){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-office-ingress-')),path=join(root,'db');let db=openDatabase(path);t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('u','g')");const store=await BlobStore.open(join(root,'store'));let now=1000;const docs=new DocumentService(db,store,{clock:()=>now}),doc=await docs.create({userId:'u',title:'Text.md',format:'md',parentId:null,groupId:'g'},bytes('original'));
 db.prepare('UPDATE documents SET published_revision=1 WHERE id=?').run(doc.documentId);const browser=createSession(db,'u',now),office=new OfficeSessions(db,{clock:()=>now}),opened=office.open(browser.token,doc.documentId);office.lock(opened.sessionId,opened.token,'LOCK','lock');
 const config={maxFileBytes:100,maxPendingBytes:200,clock:()=>now,...options},input={sessionId:opened.sessionId,token:opened.token,lock:'lock',declaredSize:3};
 return {root,browser,get db(){return db;},store,doc,opened,office,input,ingress:new OfficeIngress(db,store,config),tick:(value:number)=>{now=value;},reopen(){db.close();db=openDatabase(path);return new OfficeIngress(db,store,config);}};
}
test('fully received bytes and pinned baseline survive restart before format validation or commit',async t=>{
 const f=await fixture(t),receipt=await f.ingress.receive(f.input,bytes('new'));assert.equal(receipt.state,'prepared');assert.equal(receipt.baseRevision,1);
 const reopened=f.reopen();assert.equal(reopened.status('u',receipt.id).blob?.digest,receipt.blob?.digest);const retained=await reopened.payloadStore('u',receipt.id);assert.equal((await buffer(await retained.read(receipt.blob!.digest))).toString(),'new');assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
test('one in-flight write per document and unknown-length reservations bound total disk intake',async t=>{
 const f=await fixture(t);let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});async function* stalled(){await gate;yield Buffer.from('new');}
 const first=f.ingress.receive({...f.input,declaredSize:null},stalled());await new Promise(resolve=>setTimeout(resolve,10));await assert.rejects(f.ingress.receive(f.input,bytes('bad')),/OFFICE_WRITE_BUSY/);resume();await first;
 const constrained=new OfficeIngress(f.db,f.store,{maxFileBytes:100,maxPendingBytes:100,clock:()=>1000});await assert.rejects(constrained.receive({...f.input,declaredSize:null},bytes('next')),/OFFICE_WRITE_QUOTA/);
});
test('bad locks and readonly tokens are rejected before consuming or replacing recovery bytes',async t=>{
 const f=await fixture(t);let consumed=false;async function* source(){consumed=true;yield Buffer.from('bad');}
 await assert.rejects(f.ingress.receive({...f.input,lock:'wrong'},source()),/OFFICE_LOCK_MISMATCH/);assert.equal(consumed,false);
 const reader=f.office.open(f.browser.token,f.doc.documentId,false);await assert.rejects(f.ingress.receive({...f.input,token:reader.token},source()),/ACCESS_DENIED/);assert.equal(consumed,false);
});
test('abort and oversized streams release reservation without committing or retaining partial data',async t=>{
 const f=await fixture(t),controller=new AbortController();async function* stopped(){yield Buffer.from('n');controller.abort();yield Buffer.from('ew');}
 await assert.rejects(f.ingress.receive({...f.input,signal:controller.signal},stopped()));await assert.rejects(f.ingress.receive({...f.input,declaredSize:2},bytes('new')),/PAYLOAD_TOO_LARGE/);
 assert.equal((f.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM office_ingress WHERE state!='committed'").get() as any).n,0);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
test('an expired writer is fenced after another receiver takes its lease',async t=>{
 const f=await fixture(t);let resume!:()=>void;const gate=new Promise<void>(resolve=>{resume=resolve;});async function* old(){yield Buffer.from('o');await gate;yield Buffer.from('ld');}
 const pending=f.ingress.receive(f.input,old()).then(()=>null,error=>error);await new Promise(resolve=>setTimeout(resolve,10));f.tick(32000);await f.ingress.receive(f.input,bytes('new'));resume();assert.match((await pending as Error).message,/OFFICE_WRITE_LEASE_LOST/);
});
test('short declared bodies retain a bounded failure receipt without changing the original',async t=>{
 const f=await fixture(t);let id='';await assert.rejects(f.ingress.receive({...f.input,declaredSize:8},bytes('short')),(error:any)=>{id=error.writeId;return error.code==='OFFICE_SIZE_MISMATCH';});
 const state=f.ingress.status('u',id);assert.equal(state.state,'failed');assert.equal(state.blob?.size,5);const payload=await f.ingress.payloadStore('u',id);assert.equal((await buffer(await payload.read(state.blob!.digest))).toString(),'short');
 assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_ingress WHERE id=?').get(id) as any).reserved_bytes,5);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});


test('janitor reclaims partial expired namespaces but preserves complete pre-receipt snapshots and other uploads',async t=>{
 const f=await fixture(t);const complete=await f.ingress.receive(f.input,bytes('new'));
 f.db.prepare("UPDATE office_ingress SET state='receiving',digest=NULL,size=NULL,lease_until=1 WHERE id=?").run(complete.id);
 await f.ingress.cleanupExpired();assert.equal(f.ingress.status('u',complete.id).state,'prepared');assert.equal(f.ingress.status('u',complete.id).blob?.digest,complete.blob?.digest);
 const partial=await f.ingress.receive(f.input,bytes('two'));await f.store.removeUpload(partial.id);await f.store.uploadStore(partial.id);await writeFile(join(f.root,'store','uploads',partial.id,'staging','stranded.part'),'par');
 f.db.prepare("UPDATE office_ingress SET state='receiving',digest=NULL,size=NULL,lease_until=1 WHERE id=?").run(partial.id);
 const unrelated='33333333-3333-4333-8333-333333333333';await f.store.uploadStore(unrelated);
 await f.ingress.cleanupExpired();assert.equal(await f.store.existingUploadStore(partial.id),null);assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_ingress WHERE id=?').get(partial.id) as any).reserved_bytes,0);assert.notEqual(await f.store.existingUploadStore(unrelated),null);
});
test('explicit discard removes only the author snapshot and prevents later journal replay',async t=>{
 const f=await fixture(t),received=await f.ingress.receive(f.input,bytes('new'));
 const prepared=await f.ingress.payloadStore('u',received.id),blob=await f.store.adopt(prepared,received.blob!),journal=new SaveJournal(f.db,f.store,{clock:()=>1000});
 await journal.stagePrepared({userId:'u',documentId:f.doc.documentId,operationId:received.id,baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:f.opened.sessionId});
 await assert.rejects(f.ingress.discard('foreign',received.id),/NOT_FOUND/);await f.ingress.discard('u',received.id);assert.equal(f.ingress.status('u',received.id).state,'discarded');assert.throws(()=>journal.commit('u',received.id),/SAVE_DISCARDED/);assert.equal(await f.store.existingUploadStore(received.id),null);await assert.rejects(f.ingress.payloadStore('u',received.id),/NOT_FOUND/);
});
test('discard cancels a stalled local receiver without waiting for another body chunk',async t=>{
 const f=await fixture(t);let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});async function* stalled(){started();yield Buffer.from('n');await new Promise(()=>{});}
 const receiving=f.ingress.receive(f.input,stalled());const outcome=receiving.then(()=>null,error=>error);await ready;
 const row=f.db.prepare("SELECT id FROM office_ingress WHERE state='receiving'").get() as {id:string};await f.ingress.discard('u',row.id);
 const error=await Promise.race([outcome,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('discard did not abort receiver')),1000);timer.unref();})]);assert.equal((error as any).code,'OFFICE_WRITE_DISCARDED');assert.equal(await f.store.existingUploadStore(row.id),null);
});
test('failed physical cleanup keeps its reservation charged until deletion succeeds',async t=>{
 const f=await fixture(t),received=await f.ingress.receive(f.input,bytes('new'));await f.store.removeUpload(received.id);await f.store.uploadStore(received.id);await writeFile(join(f.root,'store','uploads',received.id,'staging','stranded.part'),'par');
 f.db.prepare("UPDATE office_ingress SET state='receiving',digest=NULL,size=NULL,reserved_bytes=100,lease_until=1 WHERE id=?").run(received.id);
 const remove=f.store.removeUpload.bind(f.store);f.store.removeUpload=async()=>{throw new Error('injected deletion failure');};
 try{assert.equal((await f.ingress.cleanupExpired()).failed,1);const limited=new OfficeIngress(f.db,f.store,{maxFileBytes:100,maxPendingBytes:100,clock:()=>1000});await assert.rejects(limited.receive(f.input,bytes('new')),/OFFICE_WRITE_QUOTA/);}
 finally{f.store.removeUpload=remove;}
 await f.ingress.cleanupExpired();assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_ingress WHERE id=?').get(received.id) as any).reserved_bytes,0);
});
test('discard tombstone rejects a journal operation created later by an already running handler',async t=>{
 const f=await fixture(t),received=await f.ingress.receive(f.input,bytes('new')),namespace=await f.ingress.payloadStore('u',received.id),blob=await f.store.adopt(namespace,received.blob!);await f.ingress.discard('u',received.id);
 const journal=new SaveJournal(f.db,f.store,{clock:()=>1000});await assert.rejects(journal.stagePrepared({userId:'u',operationId:received.id,documentId:f.doc.documentId,baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:f.opened.sessionId}),/SAVE_DISCARDED/);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});


test('SIGKILL between durable body and prepared receipt is reconciled without changing the original',{timeout:15000},async t=>{
 const f=await fixture(t);const code=`import {openDatabase} from ${JSON.stringify(new URL('../src/database.ts',import.meta.url).href)};
 import {BlobStore} from ${JSON.stringify(new URL('../src/storage/blobs.ts',import.meta.url).href)};
 import {OfficeIngress} from ${JSON.stringify(new URL('../src/office/ingress.ts',import.meta.url).href)};
 const db=openDatabase(process.argv[1]),store=await BlobStore.open(process.argv[2]),put=BlobStore.prototype.put;
 BlobStore.prototype.put=async function(source,options){const blob=await put.call(this,source,options);console.log('body durable');await new Promise(()=>{});return blob;};
 await new OfficeIngress(db,store,{clock:()=>1000,maxFileBytes:100,maxPendingBytes:200}).receive(JSON.parse(process.argv[3]),(async function*(){yield Buffer.from('new');})());`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,join(f.root,'db'),join(f.root,'store'),JSON.stringify(f.input)],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});const ended=once(child,'exit');let error='';child.stderr.on('data',data=>{error+=data;});
 await Promise.race([once(child.stdout,'data').then(([data])=>assert.match(String(data),/body durable/)),ended.then(()=>{throw new Error(error);})]);child.kill('SIGKILL');await ended;
 f.tick(32000);const result=await f.ingress.cleanupExpired();assert.equal(result.recovered,1);const row=f.db.prepare('SELECT id FROM office_ingress').get() as {id:string};assert.equal(f.ingress.status('u',row.id).errorCode,'OFFICE_RECOVERED_UNVALIDATED');
 const namespace=await f.ingress.payloadStore('u',row.id),blob=f.ingress.status('u',row.id).blob!;assert.equal((await buffer(await namespace.read(blob.digest))).toString(),'new');assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
test('a corrupt crash snapshot is retained and charged, never silently deleted or accepted',async t=>{
 const f=await fixture(t),received=await f.ingress.receive(f.input,bytes('new')),namespace=await f.ingress.payloadStore('u',received.id);await writeFile(await namespace.localFile(received.blob!.digest),'bad');
 f.db.prepare("UPDATE office_ingress SET state='receiving',digest=NULL,size=NULL,lease_until=1 WHERE id=?").run(received.id);assert.equal((await f.ingress.cleanupExpired()).failed,1);
 assert.equal(f.ingress.status('u',received.id).errorCode,'OFFICE_RECOVERY_CORRUPT');assert.notEqual(await f.store.existingUploadStore(received.id),null);assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_ingress WHERE id=?').get(received.id) as any).reserved_bytes,3);
 await f.ingress.discard('u',received.id);assert.equal(await f.store.existingUploadStore(received.id),null);
});
test('office intent pins payload and original baseline before the first journal stage',async t=>{
 const f=await fixture(t),received=await f.ingress.receive(f.input,bytes('new')),namespace=await f.ingress.payloadStore('u',received.id),blob=await f.store.adopt(namespace,received.blob!),journal=new SaveJournal(f.db,f.store,{clock:()=>1000});
 const input={userId:'u',operationId:received.id,documentId:f.doc.documentId,baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:f.opened.sessionId};
 await assert.rejects(journal.stagePrepared({...input,baseRevision:2}),/OPERATION_MISMATCH/);
 const other=await f.store.put((async function*(){yield Buffer.from('wrong');})(),{maxBytes:100});await assert.rejects(journal.stagePrepared({...input,blob:other}),/OPERATION_MISMATCH/);
 assert.equal((await journal.stagePrepared(input)).state,'staged');
});
test('discard releases the pending journal budget for a subsequent valid office save',async t=>{
 const f=await fixture(t),journal=new SaveJournal(f.db,f.store,{clock:()=>1000,maxPendingBytes:3,maxAuthorPendingBytes:3});
 for(const [text,discard] of [['one',true],['two',false]] as const){const received=await f.ingress.receive(f.input,bytes(text)),namespace=await f.ingress.payloadStore('u',received.id),blob=await f.store.adopt(namespace,received.blob!);await journal.stagePrepared({userId:'u',operationId:received.id,documentId:f.doc.documentId,baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:f.opened.sessionId});if(discard)await f.ingress.discard('u',received.id);}
});
test('taking an expired local lease aborts the old stalled body immediately',async t=>{
 const f=await fixture(t);let started!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});async function* stalled(){started();yield Buffer.from('n');await gate;yield Buffer.from('ew');}
 const old=f.ingress.receive(f.input,stalled()).then(()=>null,error=>error);await ready;f.tick(32000);
 try{await f.ingress.receive(f.input,bytes('new'));const result=await Promise.race([old,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('expired receiver still holds its body')),200);timer.unref();})]);assert.equal((result as any).code,'OFFICE_WRITE_LEASE_LOST');}
 finally{release();await old;}
});
