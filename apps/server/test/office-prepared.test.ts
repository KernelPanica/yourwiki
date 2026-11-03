import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buffer} from 'node:stream/consumers';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService} from '../src/documents.ts';
import {createSession,revokeSession} from '../src/auth/sessions.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {OfficePrepared} from '../src/office/prepared.ts';
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any,worker?:any){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-prepared-')),db=openDatabase(join(root,'db'));db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups(id,name) VALUES('g','Group');INSERT INTO memberships VALUES('u','g')");
 const store=await BlobStore.open(join(root,'store')),source=JSON.stringify({format:'yourwiki',version:1,kind:'document',data:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Prepared'}]}]}}),doc=await new DocumentService(db,store).create({userId:'u',groupId:'g',parentId:null,title:'Old',format:'md'},bytes(source));db.prepare('UPDATE documents SET published_revision=1 WHERE id=?').run(doc.documentId);
 const browser=createSession(db,'u'),office=new OfficeSessions(db),opened=office.open(browser.token,doc.documentId),prepared=new OfficePrepared(db,store,{maxFileBytes:1000,maxPendingBytes:2000,worker});t.after(async()=>{await prepared.close();db.close();await rm(root,{recursive:true,force:true});});return {root,db,store,doc,browser,office,opened,prepared};
}
test('prepared source receipt pins revision/digest/size and serves transformed bytes after reopen',async t=>{
 const f=await fixture(t),value=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);assert.equal(value.sourceDigest,f.doc.blob.digest);assert.equal(value.sourceRevision,1);assert.equal(value.blob.size,10);assert.notEqual(value.blob.digest,f.doc.blob.digest);
 const opened=await f.prepared.payload(f.opened.sessionId,f.opened.token);assert.equal((await buffer(await opened.store.read(opened.receipt.blob.digest))).toString(),'Prepared\n\n');assert.equal(await f.store.verify(f.doc.blob),true);
 const another=openDatabase(join(f.root,'db'));try{const reopened=new OfficePrepared(another,f.store);assert.deepEqual(reopened.get(f.opened.sessionId,f.opened.token),value);await reopened.close();}finally{another.close();}
});
test('a ready receipt is reused across participants but never bypasses current browser authorization',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal),another=f.office.open(f.browser.token,f.doc.documentId);
 assert.deepEqual(await f.prepared.prepare(another.sessionId,another.token,new AbortController().signal),first);assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM office_prepared').get() as any).n,1);
 revokeSession(f.db,f.browser.token);assert.throws(()=>f.prepared.get(another.sessionId,another.token),/INVALID_OFFICE_TOKEN/);
});
test('a revision change during preparation cannot publish output against the new original',async t=>{
 let f:any;f=await fixture(t,{prepare:async(_source:any,_blob:any,_format:any,target:any)=>{f.db.prepare('UPDATE documents SET local_revision=2 WHERE id=?').run(f.doc.documentId);return target.put(bytes('late'),{maxBytes:100});}});
 await assert.rejects(f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal),/CONFLICT/);assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM office_prepared WHERE state='ready'").get() as any).n,0);
});
test('shutdown cancels preparation and its receipt cannot become ready afterwards',async t=>{
 let enter!:()=>void;const ready=new Promise<void>(resolve=>{enter=resolve;});const f=await fixture(t,{prepare:async(_source:any,_blob:any,_format:any,_target:any,signal:AbortSignal)=>{enter();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));signal.throwIfAborted();}});
 const work=f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal).then(()=>null,error=>error);await ready;await f.prepared.close();assert.match((await work as Error).message,/OFFICE_CLOSED/);assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM office_prepared WHERE state='ready'").get() as any).n,0);
});

test('warm prepared metadata does not scan storage or invoke the worker again',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.store.uploadNamespaces=async function*(){throw new Error('warm cache scanned storage');};assert.deepEqual(await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal),first);
});
test('worker result metadata is pinned before asynchronous durable verification',async t=>{
 let value:any;const f=await fixture(t,{prepare:async(_source:any,_blob:any,_format:any,target:any)=>{value=await target.put(bytes('pinned'),{maxBytes:100});const verify=target.verify.bind(target);target.verify=async (blob:any)=>{const result=await verify(blob);value.digest='0'.repeat(64);value.size=0;return result;};return value;}});
 const receipt=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);assert.equal(receipt.blob.size,6);assert.notEqual(receipt.blob.digest,'0'.repeat(64));
});

test('expired preparation namespaces are reclaimed and rebuilt without using a half-published result',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare("UPDATE office_prepared SET state='creating',digest=NULL,size=NULL,lease_until=1 WHERE id=?").run(first.id);
 await f.prepared.cleanup();assert.equal(await f.store.existingUploadStore(first.id),null);assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_prepared WHERE id=?').get(first.id) as any).reserved_bytes,0);
 const second=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);assert.notEqual(second.id,first.id);assert.equal(second.blob.digest,first.blob.digest);assert.equal(await f.store.verify(f.doc.blob),true);
});
test('failed physical cleanup keeps the derived-byte reservation until a successful retry',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare("UPDATE office_prepared SET state='failed' WHERE id=?").run(first.id);const remove=f.store.removeUpload.bind(f.store);f.store.removeUpload=async()=>{throw new Error('injected deletion failure');};
 assert.equal(await f.prepared.cleanup(),0);assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_prepared WHERE id=?').get(first.id) as any).reserved_bytes,10);f.store.removeUpload=remove;assert.equal(await f.prepared.cleanup(),1);assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_prepared WHERE id=?').get(first.id) as any).reserved_bytes,0);
});
test('a missing derived payload can be regenerated instead of leaving a permanently ready broken receipt',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);await f.store.removeUpload(first.id);
 await assert.rejects(f.prepared.payload(f.opened.sessionId,f.opened.token),/OFFICE_PREPARED_MISSING/);
 const second=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);assert.notEqual(second.id,first.id);assert.equal(second.blob.digest,first.blob.digest);
});

test('retained derived bytes reserve the quota until failed deletion actually succeeds',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare("UPDATE office_prepared SET state='failed' WHERE id=?").run(first.id);const remove=f.store.removeUpload.bind(f.store);f.store.removeUpload=async()=>{throw new Error('injected');};const limited=new OfficePrepared(f.db,f.store,{maxFileBytes:1000,maxPendingBytes:1000});t.after(()=>limited.close());
 await assert.rejects(limited.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal),/OFFICE_PREPARED_QUOTA/);assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_prepared WHERE id=?').get(first.id) as any).reserved_bytes,10);f.store.removeUpload=remove;await limited.cleanup();assert.equal((await limited.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal)).blob.size,10);
});
test('cleanup aborts an expired local preparation so its worker cannot acknowledge a stale lease',async t=>{
 let enter!:()=>void;const ready=new Promise<void>(resolve=>{enter=resolve;});const f=await fixture(t,{prepare:async(_source:any,_blob:any,_format:any,_target:any,signal:AbortSignal)=>{enter();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));signal.throwIfAborted();}});
 const work=f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal).then(()=>null,error=>error);await ready;f.db.prepare('UPDATE office_prepared SET lease_until=1').run();await f.prepared.cleanup();assert.match((await work as Error).message,/OFFICE_PREPARED_LEASE_LOST/);assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM office_prepared WHERE state='ready'").get() as any).n,0);
});

test('an active session keeps its pinned converter across an engine update while a new session uses the current version',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare("UPDATE office_prepared SET converter_version='prior-transit' WHERE id=?").run(first.id);
 assert.equal(f.prepared.get(f.opened.sessionId,f.opened.token).id,first.id);assert.equal((await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal)).converterVersion,'prior-transit');
 f.office.release(f.browser.token,f.opened.sessionId,f.opened.token);const fresh=f.office.open(f.browser.token,f.doc.documentId),newer=await f.prepared.prepare(fresh.sessionId,fresh.token,new AbortController().signal);assert.notEqual(fresh.sessionId,f.opened.sessionId);assert.notEqual(newer.id,first.id);assert.equal(newer.converterVersion,'office-transit-v2');
});

test('missing bytes from an older converter require a new session instead of silently switching an active editor',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare("UPDATE office_prepared SET converter_version='prior-transit' WHERE id=?").run(first.id);await f.store.removeUpload(first.id);
 await assert.rejects(f.prepared.payload(f.opened.sessionId,f.opened.token),/OFFICE_PREPARED_MISSING/);await assert.rejects(f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal),/CONFLICT/);
 f.office.release(f.browser.token,f.opened.sessionId,f.opened.token);const fresh=f.office.open(f.browser.token,f.doc.documentId);assert.equal((await f.prepared.prepare(fresh.sessionId,fresh.token,new AbortController().signal)).converterVersion,'office-transit-v2');
});

test('an unrecoverable older prepared copy retires the broken room so another participant can open a fresh one',async t=>{
 const f=await fixture(t),first=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal),participant=f.office.open(f.browser.token,f.doc.documentId);f.db.prepare("UPDATE office_prepared SET converter_version='prior-transit' WHERE id=?").run(first.id);await f.store.removeUpload(first.id);
 await assert.rejects(f.prepared.payload(f.opened.sessionId,f.opened.token),/OFFICE_PREPARED_MISSING/);const room=f.db.prepare('SELECT superseded,error_code FROM office_sessions WHERE id=?').get(f.opened.sessionId) as any;assert.equal(room.superseded,1);assert.equal(room.error_code,'OFFICE_PREPARED_MISSING');
 const next=f.office.open(f.browser.token,f.doc.documentId);assert.notEqual(next.sessionId,participant.sessionId);assert.equal((await f.prepared.prepare(next.sessionId,next.token,new AbortController().signal)).converterVersion,'office-transit-v2');assert.equal(await f.store.verify(f.doc.blob),true);
});

test('an active new converter room does not indefinitely retain an unused older converter copy',async t=>{
 const f=await fixture(t),old=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare("UPDATE office_prepared SET converter_version='older-converter',last_access_at=0 WHERE id=?").run(old.id);f.office.release(f.browser.token,f.opened.sessionId,f.opened.token);
 const fresh=f.office.open(f.browser.token,f.doc.documentId),current=await f.prepared.prepare(fresh.sessionId,fresh.token,new AbortController().signal);await f.prepared.cleanup();assert.equal(await f.store.existingUploadStore(old.id),null);assert.notEqual(await f.store.existingUploadStore(current.id),null);assert.equal(f.prepared.get(fresh.sessionId,fresh.token).id,current.id);
});


test('an old but actively pinned prepared copy is retained by cleanup',async t=>{
 const f=await fixture(t),active=await f.prepared.prepare(f.opened.sessionId,f.opened.token,new AbortController().signal);f.db.prepare('UPDATE office_prepared SET last_access_at=0 WHERE id=?').run(active.id);await f.prepared.cleanup();assert.notEqual(await f.store.existingUploadStore(active.id),null);assert.equal(f.prepared.get(f.opened.sessionId,f.opened.token).id,active.id);
});
