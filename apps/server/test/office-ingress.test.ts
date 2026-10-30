import {test} from 'node:test';
import {buffer} from 'node:stream/consumers';
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
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any,options={}){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-office-ingress-')),path=join(root,'db');let db=openDatabase(path);t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('u','g')");const store=await BlobStore.open(join(root,'store'));let now=1000;const docs=new DocumentService(db,store,{clock:()=>now}),doc=await docs.create({userId:'u',title:'Text.md',format:'md',parentId:null,groupId:'g'},bytes('original'));
 db.prepare('UPDATE documents SET published_revision=1 WHERE id=?').run(doc.documentId);const browser=createSession(db,'u',now),office=new OfficeSessions(db,{clock:()=>now}),opened=office.open(browser.token,doc.documentId);office.lock(opened.sessionId,opened.token,'LOCK','lock');
 const config={maxFileBytes:100,maxPendingBytes:200,clock:()=>now,...options},input={sessionId:opened.sessionId,token:opened.token,lock:'lock',declaredSize:3};
 return {browser,get db(){return db;},store,doc,opened,office,input,ingress:new OfficeIngress(db,store,config),tick:(value:number)=>{now=value;},reopen(){db.close();db=openDatabase(path);return new OfficeIngress(db,store,config);}};
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
 const pending=f.ingress.receive(f.input,old());await new Promise(resolve=>setTimeout(resolve,10));f.tick(32000);await f.ingress.receive(f.input,bytes('new'));resume();await assert.rejects(pending,/OFFICE_WRITE_LEASE_LOST/);
});
test('short declared bodies retain a bounded failure receipt without changing the original',async t=>{
 const f=await fixture(t);let id='';await assert.rejects(f.ingress.receive({...f.input,declaredSize:8},bytes('short')),(error:any)=>{id=error.writeId;return error.code==='OFFICE_SIZE_MISMATCH';});
 const state=f.ingress.status('u',id);assert.equal(state.state,'failed');assert.equal(state.blob?.size,5);const payload=await f.ingress.payloadStore('u',id);assert.equal((await buffer(await payload.read(state.blob!.digest))).toString(),'short');
 assert.equal((f.db.prepare('SELECT reserved_bytes FROM office_ingress WHERE id=?').get(id) as any).reserved_bytes,5);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
