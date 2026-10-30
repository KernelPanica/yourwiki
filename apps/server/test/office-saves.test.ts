import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService} from '../src/documents.ts';
import {createSession} from '../src/auth/sessions.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {OfficeIngress} from '../src/office/ingress.ts';
import {OfficeSaves} from '../src/office/saves.ts';
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any,validator?:any,original='original'){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-office-saves-')),db=openDatabase(join(root,'db'));t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('u','g')");const store=await BlobStore.open(join(root,'store')),docs=new DocumentService(db,store),doc=await docs.create({userId:'u',title:'Text.md',format:'md',parentId:null,groupId:'g'},bytes(original));
 db.prepare('UPDATE documents SET published_revision=1 WHERE id=?').run(doc.documentId);const browser=createSession(db,'u'),office=new OfficeSessions(db),opened=office.open(browser.token,doc.documentId);office.lock(opened.sessionId,opened.token,'LOCK','lock');
 const ingress=new OfficeIngress(db,store,{maxFileBytes:100,maxPendingBytes:200}),saves=new OfficeSaves(db,store,ingress,{maxFileBytes:100,validator});return {db,store,docs,doc,office,opened,ingress,saves,input:{lastModifiedTime:new Date((db.prepare('SELECT created_at FROM document_versions WHERE document_id=? AND revision=1').get(doc.documentId) as any).created_at).toISOString(),sessionId:opened.sessionId,token:opened.token,lock:'lock',declaredSize:3}};
}
test('validated office save atomically advances original, shared baseline and journal before cleanup',async t=>{
 const f=await fixture(t),saved=await f.saves.save(f.input,bytes('new'));
 assert.equal(saved.state,'saved');assert.equal(saved.receipt!.revision,2);assert.equal(saved.providerDelivery,'not_attempted');
 const session=f.db.prepare('SELECT base_revision,base_digest,pending_operation_id FROM office_sessions').get() as any;assert.equal(session.base_revision,2);assert.equal(session.base_digest,saved.blob.digest);assert.equal(session.pending_operation_id,null);
 const intent=f.ingress.status('u',saved.operationId);assert.equal(intent.state,'committed');await f.ingress.cleanupExpired();assert.equal(await f.store.existingUploadStore(saved.operationId),null);assert.equal(await f.store.verify(saved.blob),true);
});
test('invalid format retains prepared recovery without journal or original mutation',async t=>{
 const f=await fixture(t);await assert.rejects(f.saves.save(f.input,bytes('\0xx')),/INVALID_OFFICE_FILE/);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);assert.equal(f.db.prepare('SELECT 1 FROM save_operations').get(),undefined);
 const row=f.db.prepare('SELECT id,state,error_code FROM office_ingress').get() as any;assert.equal(row.state,'prepared');assert.equal(row.error_code,'INVALID_OFFICE_FILE');assert.ok(await f.ingress.payloadStore('u',row.id));
});
test('permission change after validation cannot overwrite original and keeps complete recovery',async t=>{
 let f:any;f=await fixture(t,{validate:async()=>{f.db.prepare('DELETE FROM memberships WHERE user_id=?').run('u');f.db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('other','other','Other','!')");f.db.prepare("UPDATE resources SET owner_id='other' WHERE id=?").run(f.doc.documentId);}});
 await assert.rejects(f.saves.save(f.input,bytes('new')),/ACCESS_DENIED/);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);assert.equal((f.db.prepare('SELECT state FROM office_ingress').get() as any).state,'prepared');
});
test('discard cancels the validation worker and prevents late journal creation',async t=>{
 let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let aborted=false;
 const f=await fixture(t,{validate:async(_store:any,_blob:any,_format:any,signal:AbortSignal)=>{entered();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));signal.throwIfAborted();}});
 const pending=f.saves.save(f.input,bytes('new')).then(()=>null,error=>error);await ready;const row=f.db.prepare('SELECT id FROM office_ingress').get() as any;await f.ingress.discard('u',row.id);
 assert.match((await pending as Error).message,/OFFICE_WRITE_DISCARDED/);assert.equal(aborted,true);assert.equal(f.db.prepare('SELECT 1 FROM save_operations').get(),undefined);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});

test('lock loss after journal staging retains a pending recoverable operation without committing',async t=>{
 const f=await fixture(t),verify=f.store.verify.bind(f.store);f.store.verify=async(blob,signal)=>{const valid=await verify(blob,signal);f.office.lock(f.opened.sessionId,f.opened.token,'UNLOCK','lock');f.office.lock(f.opened.sessionId,f.opened.token,'LOCK','other');return valid;};
 let id='';await assert.rejects(f.saves.save(f.input,bytes('new')),(error:any)=>{id=error.writeId;return error.code==='OFFICE_LOCK_MISMATCH'&&typeof id==='string';});
 const operation=f.db.prepare('SELECT id,state FROM save_operations').get() as any;assert.equal(operation.id,id);assert.equal(operation.state,'staged');
 assert.equal((f.db.prepare('SELECT pending_operation_id FROM office_sessions').get() as any).pending_operation_id,id);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
test('receipt write failure rolls back office baseline and original but retains journal and namespace',async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER fail_office_receipt BEFORE UPDATE OF receipt ON save_operations WHEN NEW.state='saved' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
 await assert.rejects(f.saves.save(f.input,bytes('new')),/OFFICE_SAVE_INTERRUPTED/);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);assert.equal((f.db.prepare('SELECT base_revision FROM office_sessions').get() as any).base_revision,1);
 const row=f.db.prepare('SELECT id,state FROM office_ingress').get() as any;assert.equal(row.state,'prepared');assert.ok(await f.ingress.payloadStore('u',row.id));assert.equal((f.db.prepare('SELECT state FROM save_operations').get() as any).state,'staged');
});


function modified(f:any){return new Date((f.db.prepare('SELECT v.created_at FROM document_versions v JOIN documents d ON d.id=v.document_id AND d.local_revision=v.revision WHERE d.id=?').get(f.doc.documentId) as any).created_at).toISOString();}
test('a lost save acknowledgement can be retried without another version or preview job',async t=>{
 const f=await fixture(t),first=await f.saves.save(f.input,bytes('new')),time=modified(f);
 const retry=await f.saves.save(f.input,bytes('new'));
 assert.equal(retry.receipt!.revision,first.receipt!.revision);assert.equal(retry.blob.digest,first.blob.digest);assert.equal(modified(f),time);
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n,2);
 assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='preview.prepare'").get() as any).n,2);
});
test('a late retry cannot overwrite a later save but intentional Undo with the current timestamp succeeds',async t=>{
 const f=await fixture(t);await f.saves.save(f.input,bytes('aaa'));const afterA=modified(f);
 await f.saves.save({...f.input,lastModifiedTime:afterA},bytes('bbb'));const afterB=modified(f);
 let retained='';await assert.rejects(f.saves.save(f.input,bytes('aaa')),(error:any)=>{retained=error.writeId;return error.code==='CONFLICT';});
 assert.equal(modified(f),afterB);assert.equal(f.ingress.status('u',retained).state,'prepared');
 const undo=await f.saves.save({...f.input,lastModifiedTime:afterB},bytes('aaa'));assert.equal(undo.receipt!.revision,4);assert.notEqual(modified(f),afterB);
});
test('missing or malformed timestamps preserve changed bytes rather than forcing an overwrite',async t=>{
 const f=await fixture(t);
 for(const lastModifiedTime of [null,'invalid','2000-01-01T00:00:00.000Z'])await assert.rejects(f.saves.save({...f.input,lastModifiedTime},bytes('new')),/CONFLICT/);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
 assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM office_ingress WHERE state='prepared'").get() as any).n,3);
});

test('retry acknowledgement survives an independent database connection and leaves the original version unchanged',async t=>{
 const f=await fixture(t),first=await f.saves.save(f.input,bytes('new'));
 const row=f.db.prepare('PRAGMA database_list').all() as {name:string;file:string}[];const reopened=openDatabase(row.find(row=>row.name==='main')!.file);t.after(()=>reopened.close());
 const retry=await new OfficeSaves(reopened,f.store,new OfficeIngress(reopened,f.store)).save(f.input,bytes('new'));
 assert.equal(retry.receipt!.revision,2);assert.equal(retry.blob.digest,first.blob.digest);assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n,2);
});
test('a newer save during validation fences the older prepared operation without losing its bytes',async t=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});let calls=0;
 const f=await fixture(t,{validate:async()=>{if(++calls===1){entered();await gate;}}});
 const earlier=f.saves.save(f.input,bytes('aaa')).then(()=>null,error=>error);await ready;
 const newer=await f.saves.save(f.input,bytes('bbb'));release();const error=await earlier as any;assert.equal(error.code,'CONFLICT');
 assert.equal(newer.receipt!.revision,2);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,2);assert.equal(f.ingress.status('u',error.writeId).state,'prepared');
});

test('equivalent UTC timestamp precision is accepted without truncating nonzero submillisecond differences',async t=>{
 const f=await fixture(t),equivalent=f.input.lastModifiedTime.replace('Z','000Z');
 await f.saves.save({...f.input,lastModifiedTime:equivalent},bytes('new'));
 const time=modified(f);await assert.rejects(f.saves.save({...f.input,lastModifiedTime:time.replace('Z','001Z')},bytes('aaa')),/CONFLICT/);
 const saved=await f.saves.save({...f.input,lastModifiedTime:time.replace('Z','+00:00')},bytes('bbb'));assert.equal(saved.receipt!.revision,3);
});

test('initial zero-byte WOPI creation works unlocked without a timestamp',async t=>{
 const f=await fixture(t,undefined,'');f.office.lock(f.opened.sessionId,f.opened.token,'UNLOCK','lock');
 const saved=await f.saves.save({...f.input,lock:'',lastModifiedTime:null},bytes('new'));assert.equal(saved.receipt!.revision,2);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,2);
});
test('capability revocation during validation fences the late write and retains complete recovery',async t=>{
 let f:any;f=await fixture(t,{validate:async()=>{f.office.revokeCapability(f.opened.sessionId,f.opened.token);}});await assert.rejects(f.saves.save(f.input,bytes('new')),/INVALID_OFFICE_TOKEN/);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);const row=f.db.prepare('SELECT id,state FROM office_ingress').get() as any;assert.equal(row.state,'prepared');assert.ok(await f.ingress.payloadStore('u',row.id));
});
