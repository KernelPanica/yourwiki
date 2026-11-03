import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService} from '../src/documents.ts';
import {createSession,revokeSession} from '../src/auth/sessions.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {ResumableUploads} from '../src/uploads.ts';
import {SaveJournal} from '../src/save-journal.ts';
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-office-sessions-'));let db=openDatabase(join(root,'db'));t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('one','one','First','!'),('two','two','Second','!');INSERT INTO groups(id,name) VALUES('g','Group');INSERT INTO memberships VALUES('one','g'),('two','g')");
 db.prepare('UPDATE app_state SET default_policy=?').run(JSON.stringify({owner:{read:true,write:true},group:{read:true,write:true}}));
 const store=await BlobStore.open(join(root,'store'));let now=1000;const docs=new DocumentService(db,store,{clock:()=>now});
 const doc=await docs.create({userId:'one',title:'Office.docx',format:'docx',parentId:null,groupId:'g'},bytes('office fixture'));
 // Core tests use a synthetic publication receipt; HTTP/engine tests validate actual formats separately.
 db.prepare('UPDATE documents SET published_revision=1 WHERE id=?').run(doc.documentId);
 const one=createSession(db,'one',now),two=createSession(db,'two',now);
 return {get db(){return db;},store,docs,doc,one,two,office:new OfficeSessions(db,{clock:()=>now}),tick:(value:number)=>{now=value;},reopen(){db.close();db=openDatabase(join(root,'db'));return new OfficeSessions(db,{clock:()=>now});}};
}
test('participants share one office identity with separate hashed user capabilities across restart',async t=>{
 const f=await fixture(t),a=f.office.open(f.one.token,f.doc.documentId),b=f.office.open(f.two.token,f.doc.documentId);
 assert.equal(a.sessionId,b.sessionId);assert.notEqual(a.token,b.token);assert.equal(f.office.authorize(a.sessionId,a.token).userId,'one');assert.equal(f.office.authorize(b.sessionId,b.token).userId,'two');
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM office_tokens').all()).includes(a.token),false);
 assert.equal(f.reopen().authorize(a.sessionId,a.token).session.id,a.sessionId);
});
test('read-only capability cannot upgrade and current write/export ACL is always applied',async t=>{
 const f=await fixture(t),reader=f.office.open(f.one.token,f.doc.documentId,false),writer=f.office.open(f.two.token,f.doc.documentId);
 assert.equal(f.office.authorize(reader.sessionId,reader.token).write,false);assert.throws(()=>f.office.lock(reader.sessionId,reader.token,'LOCK','x'),/ACCESS_DENIED/);
 f.db.prepare('UPDATE resources SET user_policies=?,export_disabled=1 WHERE id=?').run(JSON.stringify({two:{read:true,write:false}}),f.doc.documentId);
 const current=f.office.authorize(writer.sessionId,writer.token);assert.equal(current.write,false);assert.equal(current.export,false);
 assert.throws(()=>f.office.lock(writer.sessionId,writer.token,'LOCK','x'),/ACCESS_DENIED/);
});
test('logout, password change, read revocation and wrong session invalidate tokens',async t=>{
 const f=await fixture(t),a=f.office.open(f.one.token,f.doc.documentId),b=f.office.open(f.two.token,f.doc.documentId);
 assert.throws(()=>f.office.authorize('wrong',a.token),/INVALID_OFFICE_TOKEN/);revokeSession(f.db,f.one.token);assert.throws(()=>f.office.authorize(a.sessionId,a.token),/INVALID_OFFICE_TOKEN/);
 assert.equal(f.office.authorize(b.sessionId,b.token).userId,'two');f.db.prepare("UPDATE users SET password_hash='changed' WHERE id='two'").run();assert.throws(()=>f.office.authorize(b.sessionId,b.token),/INVALID_OFFICE_TOKEN/);
});
test('shared locks compare exactly, relock atomically and expire independently after thirty minutes',async t=>{
 const f=await fixture(t),a=f.office.open(f.one.token,f.doc.documentId),b=f.office.open(f.two.token,f.doc.documentId);
 assert.deepEqual(f.office.lock(a.sessionId,a.token,'GET_LOCK'),{status:200,lock:''});
 assert.equal(f.office.lock(a.sessionId,a.token,'LOCK','first').status,200);
 assert.deepEqual(f.office.lock(b.sessionId,b.token,'LOCK','second'),{status:409,lock:'first'});
 assert.equal(f.office.lock(b.sessionId,b.token,'LOCK','second','first').status,200);
 assert.deepEqual(f.office.lock(a.sessionId,a.token,'UNLOCK','first'),{status:409,lock:'second'});
 f.tick(1000+29*60_000);f.office.authorize(a.sessionId,a.token);f.tick(1000+30*60_000);
 assert.deepEqual(f.office.lock(a.sessionId,a.token,'GET_LOCK'),{status:200,lock:''});assert.deepEqual(f.office.lock(a.sessionId,a.token,'LOCK','new','second'),{status:409,lock:''});
 assert.throws(()=>f.office.lock(a.sessionId,a.token,'LOCK','x'.repeat(1025)),/INVALID_OFFICE_LOCK/);
});
test('external base changes retire old identity without upgrading old token into new baseline',async t=>{
 const f=await fixture(t),old=f.office.open(f.one.token,f.doc.documentId);
 f.db.prepare('UPDATE documents SET local_revision=2 WHERE id=?').run(f.doc.documentId);
 f.db.prepare('INSERT INTO document_versions SELECT document_id,2,digest,size,author_id,created_at FROM document_versions WHERE revision=1').run();
 assert.equal(f.office.authorize(old.sessionId,old.token).session.superseded,1);
 const fresh=f.office.open(f.one.token,f.doc.documentId);assert.notEqual(fresh.sessionId,old.sessionId);assert.equal(f.office.authorize(fresh.sessionId,fresh.token).session.base_revision,2);
 assert.throws(()=>f.office.lock(old.sessionId,old.token,'LOCK','old'),/CONFLICT/);
});
test('central source saves are fenced; journal office binding permits exactly the active office writer',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId);
 await assert.rejects(f.docs.save({userId:'one',documentId:f.doc.documentId,baseRevision:1},bytes('source editor')),/OFFICE_ACTIVE/);
 const blob=await f.store.put(bytes('office save'),{maxBytes:100});const journal=new SaveJournal(f.db,f.store,{clock:()=>1000});
 await journal.stagePrepared({userId:'one',operationId:'office-save-1',documentId:f.doc.documentId,baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:opened.sessionId});
 assert.equal(journal.commit('one','office-save-1').receipt?.revision,2);
 assert.equal(f.office.authorize(opened.sessionId,opened.token).session.base_revision,2);assert.equal(f.office.authorize(opened.sessionId,opened.token).session.superseded,0);
});
test('idle expiry creates a new identity and expired credentials cannot revive old one',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId);f.tick(1000+30*60_000);
 assert.throws(()=>f.office.authorize(opened.sessionId,opened.token),/OFFICE_EXPIRED/);
 assert.notEqual(f.office.open(f.one.token,f.doc.documentId).sessionId,opened.sessionId);
});
test('pending office bytes survive idle expiry while old capabilities remain retired',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId),blob=await f.store.put(bytes('pending'),{maxBytes:100});
 const journal=new SaveJournal(f.db,f.store,{clock:()=>1000});await journal.stagePrepared({userId:'one',documentId:f.doc.documentId,operationId:'pending-office-copy',baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:opened.sessionId});
 f.db.prepare('UPDATE office_sessions SET pending_operation_id=? WHERE id=?').run('pending-office-copy',opened.sessionId);
 f.tick(1000+31*60_000);const reopened=f.office.open(f.one.token,f.doc.documentId);assert.equal(reopened.sessionId,opened.sessionId);
 assert.throws(()=>f.office.authorize(opened.sessionId,opened.token),/INVALID_OFFICE_TOKEN/);assert.equal(f.office.authorize(reopened.sessionId,reopened.token).session.pending_operation_id,'pending-office-copy');
 assert.equal(journal.status('one','pending-office-copy').blob.digest,blob.digest);
});
test('resumable saves cannot supply internal office binding or bypass a session opened after upload began',async t=>{
 const f=await fixture(t),uploads=new ResumableUploads(f.db,f.store,{clock:()=>1000,chunkBytes:8});
 const pending=uploads.create('one',{mode:'save',size:3,documentId:f.doc.documentId,baseRevision:1});await uploads.append('one',pending.id,0,bytes('new'));
 const opened=f.office.open(f.one.token,f.doc.documentId);await assert.rejects(uploads.finish('one',pending.id),/OFFICE_ACTIVE/);
 assert.throws(()=>uploads.create('one',{mode:'save',size:3,documentId:f.doc.documentId,baseRevision:1,officeSessionId:opened.sessionId} as any),/OFFICE_ACTIVE/);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.doc.documentId) as any).local_revision,1);
});
test('read revocation fails immediately and a token has at most eight hours even with active office traffic',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId);
 f.db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({one:{read:false}}),f.doc.documentId);assert.throws(()=>f.office.authorize(opened.sessionId,opened.token),/ACCESS_DENIED/);
 f.db.prepare("UPDATE resources SET user_policies='{}' WHERE id=?").run(f.doc.documentId);
 for(let minute=20;minute<480;minute+=20){f.tick(1000+minute*60_000);f.office.authorize(opened.sessionId,opened.token);}
 f.tick(1000+8*3600_000);assert.throws(()=>f.office.authorize(opened.sessionId,opened.token),/INVALID_OFFICE_TOKEN/);
});
test('office baseline and receipt roll back together when the local commit cannot be acknowledged',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId),blob=await f.store.put(bytes('pending office'),{maxBytes:100});const journal=new SaveJournal(f.db,f.store,{clock:()=>1000});
 await journal.stagePrepared({userId:'one',documentId:f.doc.documentId,operationId:'office-atomic-save',baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:opened.sessionId});
 f.db.exec("CREATE TRIGGER fail_office_receipt BEFORE UPDATE OF state ON save_operations WHEN NEW.state='saved' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
 assert.throws(()=>journal.commit('one','office-atomic-save'),/receipt failure/);assert.equal(f.office.authorize(opened.sessionId,opened.token).session.base_revision,1);assert.equal(journal.status('one','office-atomic-save').state,'staged');
 f.db.exec('DROP TRIGGER fail_office_receipt');journal.commit('one','office-atomic-save');assert.equal(f.office.authorize(opened.sessionId,opened.token).session.base_revision,2);
});
test('browser status retains recovery discovery after token expiry with author/admin/export rules',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId),blob=await f.store.put(bytes('recovery'),{maxBytes:100}),journal=new SaveJournal(f.db,f.store,{clock:()=>1000});
 await journal.stagePrepared({userId:'one',documentId:f.doc.documentId,operationId:'office-recovery-status',baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:opened.sessionId});
 f.db.prepare('UPDATE office_sessions SET pending_operation_id=? WHERE id=?').run('office-recovery-status',opened.sessionId);
 f.tick(1000+31*60_000);const status=f.office.status(f.one.token,opened.sessionId);assert.equal(status.expired,true);assert.equal(status.write,false);assert.equal(status.recovery,true);
 assert.throws(()=>f.office.authorize(opened.sessionId,opened.token),/OFFICE_EXPIRED/);assert.equal(f.office.status(f.two.token,opened.sessionId).recovery,false);
 f.db.prepare("UPDATE users SET admin_role='giga' WHERE id='two'").run();assert.equal(f.office.status(f.two.token,opened.sessionId).recovery,true);
 f.db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(f.doc.documentId);assert.equal(f.office.status(f.one.token,opened.sessionId).recovery,false);
 assert.throws(()=>f.office.status('invalid',opened.sessionId),/SESSION_REQUIRED/);
});
test('capability revocation after browser invalidation is idempotent, scoped and preserves other participants',async t=>{
 const f=await fixture(t),a=f.office.open(f.one.token,f.doc.documentId),b=f.office.open(f.two.token,f.doc.documentId);f.office.lock(b.sessionId,b.token,'LOCK','shared');
 revokeSession(f.db,f.one.token);f.office.revokeCapability('wrong-room',b.token);assert.equal(f.office.authorize(b.sessionId,b.token).write,true);
 f.office.revokeCapability(a.sessionId,a.token);f.office.revokeCapability(a.sessionId,a.token);assert.equal(f.office.authorize(b.sessionId,b.token).write,true);assert.equal(f.office.lock(b.sessionId,b.token,'GET_LOCK').lock,'shared');
 f.office.revokeCapability(b.sessionId,'z'.repeat(43));assert.equal(f.office.authorize(b.sessionId,b.token).write,true);f.office.revokeCapability(b.sessionId,b.token);assert.throws(()=>f.office.authorize(b.sessionId,b.token),/INVALID_OFFICE_TOKEN/);assert.equal(f.office.status(f.two.token,b.sessionId).expired,true);
});
test('revoking a known capability cannot erase staged recovery or commit its bytes',async t=>{
 const f=await fixture(t),a=f.office.open(f.one.token,f.doc.documentId),blob=await f.store.put(bytes('retained recovery'),{maxBytes:100}),journal=new SaveJournal(f.db,f.store,{clock:()=>1000});await journal.stagePrepared({userId:'one',documentId:f.doc.documentId,operationId:'revoke-recovery',baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:a.sessionId});f.db.prepare('UPDATE office_sessions SET pending_operation_id=? WHERE id=?').run('revoke-recovery',a.sessionId);
 f.office.revokeCapability(a.sessionId,a.token);assert.equal(journal.status('one','revoke-recovery').state,'staged');assert.equal(f.office.status(f.one.token,a.sessionId).recovery,true);assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.doc.documentId) as any).local_revision,1);assert.equal(await f.store.verify(blob),true);
});
