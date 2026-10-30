import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService} from '../src/documents.ts';
import {SaveJournal} from '../src/save-journal.ts';
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-save-journal-'));const path=join(root,'db.sqlite');let db=openDatabase(path);
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('other','other','Other','!'); INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('owner','g'),('other','g')");
 const store=await BlobStore.open(join(root,'store')),docs=new DocumentService(db,store);const first=await docs.create({userId:'owner',title:'Draft',format:'md',parentId:null,groupId:'g'},bytes('original'));
 const blob=await store.put(bytes('edited'),{maxBytes:100});const input={operationId:'save-operation-1',userId:'owner',documentId:first.documentId,baseRevision:1,baseDigest:first.blob.digest,blob};
 return {path,root,get db(){return db;},store,docs,input,journal:new SaveJournal(db,store),reopen(){db.close();db=openDatabase(path);return new SaveJournal(db,store);}};
}
test('staged bytes survive reopen; lost acknowledgement replays one local commit and preview job',async t=>{
 const f=await fixture(t);const staged=await f.journal.stagePrepared(f.input);assert.equal(staged.state,'staged');
 const journal=f.reopen();const receipt=journal.commit('owner',f.input.operationId);assert.equal(receipt.state,'saved');assert.equal(receipt.receipt?.revision,2);assert.equal(receipt.delivery,'local');
 const reopened=f.reopen();assert.deepEqual(reopened.commit('owner',f.input.operationId),receipt);assert.deepEqual(await reopened.stagePrepared(f.input),receipt);
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n,2);assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n,2);
});
test('operation identity and exact input are immutable; foreign author cannot inspect or commit',async t=>{
 const f=await fixture(t);await f.journal.stagePrepared(f.input);
 assert.throws(()=>f.journal.status('other',f.input.operationId),/NOT_FOUND/);assert.throws(()=>f.journal.commit('other',f.input.operationId),/NOT_FOUND/);
 const changed=await f.store.put(bytes('different'),{maxBytes:100});await assert.rejects(f.journal.stagePrepared({...f.input,blob:changed}),/OPERATION_MISMATCH/);
 assert.equal(f.journal.status('owner',f.input.operationId).blob.digest,f.input.blob.digest);
});
test('two staged writers cannot overwrite; conflict retains its own durable snapshot',async t=>{
 const f=await fixture(t);await f.journal.stagePrepared(f.input);
 await f.journal.stagePrepared({...f.input,operationId:'save-operation-2'});f.journal.commit('owner',f.input.operationId);
 assert.throws(()=>f.journal.commit('owner','save-operation-2'),/CONFLICT/);const pending=f.journal.status('owner','save-operation-2');assert.equal(pending.state,'conflict');assert.equal(pending.blob.digest,f.input.blob.digest);
 assert.throws(()=>f.journal.commit('owner','save-operation-2'),/CONFLICT/);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,2);
});
test('fingerprint mismatch and revoked write access pause staged saves without losing bytes',async t=>{
 const f=await fixture(t);await f.journal.stagePrepared({...f.input,baseDigest:'0'.repeat(64)});assert.equal(f.journal.status('owner',f.input.operationId).state,'conflict');
 await f.journal.stagePrepared({...f.input,operationId:'allowed-before-revoke'});
 f.db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:true,write:false}}),f.input.documentId);
 assert.throws(()=>f.journal.commit('owner','allowed-before-revoke'),/ACCESS_DENIED/);assert.equal(f.journal.status('owner','allowed-before-revoke').state,'denied');
 f.db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:false}}),f.input.documentId);assert.throws(()=>f.journal.status('owner','allowed-before-revoke'),/NOT_FOUND/);
});
test('stage pins metadata during asynchronous verification and rejects nonexistent bytes',async t=>{
 const f=await fixture(t);const input={...f.input,blob:{...f.input.blob}};const pending=f.journal.stagePrepared(input);input.userId='other';input.baseRevision=20;input.blob.digest='a'.repeat(64);await pending;
 assert.equal(f.journal.status('owner',f.input.operationId).blob.digest,f.input.blob.digest);
 await assert.rejects(f.journal.stagePrepared({...f.input,operationId:'missing-payload',blob:{digest:'b'.repeat(64),size:10}}),/INVALID_PAYLOAD/);
});
test('retained snapshot quota is reserved atomically and saved operations release pending budget',async t=>{
 const f=await fixture(t),journal=new SaveJournal(f.db,f.store,{maxPendingBytes:6,maxAuthorPendingBytes:6});await journal.stagePrepared(f.input);
 await assert.rejects(journal.stagePrepared({...f.input,operationId:'second-operation'}),/PENDING_LIMIT/);
 journal.commit('owner',f.input.operationId);await journal.stagePrepared({...f.input,operationId:'third-operation',baseRevision:2,baseDigest:f.input.blob.digest});
});
test('receipt failure rolls back version and preview job; staged operation remains retryable',async t=>{
 const f=await fixture(t);await f.journal.stagePrepared(f.input);
 f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON save_operations WHEN NEW.state='saved' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
 assert.throws(()=>f.journal.commit('owner',f.input.operationId),/injected receipt failure/);assert.equal(f.journal.status('owner',f.input.operationId).state,'staged');assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
 f.db.exec('DROP TRIGGER fail_receipt');assert.equal(f.journal.commit('owner',f.input.operationId).receipt?.revision,2);
});
test('permission loss during verification retains denied bytes; restoring rights does not silently replay',async t=>{
 const f=await fixture(t);const verify=f.store.verify.bind(f.store);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.store.verify=async ref=>{await gate;return verify(ref);};const pending=f.journal.stagePrepared(f.input);
 f.db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:true,write:false}}),f.input.documentId);release();
 assert.equal((await pending).state,'denied');assert.equal(f.journal.status('owner',f.input.operationId).blob.digest,f.input.blob.digest);
 f.db.prepare("UPDATE resources SET user_policies='{}' WHERE id=?").run(f.input.documentId);assert.throws(()=>f.journal.commit('owner',f.input.operationId),/ACCESS_DENIED/);
});
test('original changes during verification yield a retained conflict and never a rebased commit',async t=>{
 const f=await fixture(t);const verify=f.store.verify.bind(f.store);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 f.store.verify=async ref=>{await gate;return verify(ref);};const pending=f.journal.stagePrepared(f.input);
 await f.docs.save({userId:'owner',documentId:f.input.documentId,baseRevision:1},bytes('external'));release();assert.equal((await pending).state,'conflict');
 assert.throws(()=>f.journal.commit('owner',f.input.operationId),/CONFLICT/);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,2);
});
test('current fingerprint is checked at commit even when the revision number is unchanged',async t=>{
 const f=await fixture(t);await f.journal.stagePrepared(f.input);f.db.prepare('UPDATE document_versions SET digest=? WHERE document_id=? AND revision=1').run('c'.repeat(64),f.input.documentId);
 assert.throws(()=>f.journal.commit('owner',f.input.operationId),/CONFLICT/);assert.equal(f.journal.status('owner',f.input.operationId).state,'conflict');
});
test('saved receipt is readable after write revocation but never after read revocation',async t=>{
 const f=await fixture(t);await f.journal.stagePrepared(f.input);const receipt=f.journal.commit('owner',f.input.operationId);
 f.db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:true,write:false}}),f.input.documentId);assert.deepEqual(f.journal.commit('owner',f.input.operationId),receipt);
 f.db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:false}}),f.input.documentId);assert.throws(()=>f.journal.commit('owner',f.input.operationId),/NOT_FOUND/);
});
for(const phase of ['staged','saved'] as const)test(`abrupt process death after ${phase} preserves the operation and prevents duplicate commits`,{timeout:15000},async t=>{
 const f=await fixture(t);
 const code=`import {openDatabase} from ${JSON.stringify(new URL('../src/database.ts',import.meta.url).href)};
 import {BlobStore} from ${JSON.stringify(new URL('../src/storage/blobs.ts',import.meta.url).href)};
 import {SaveJournal} from ${JSON.stringify(new URL('../src/save-journal.ts',import.meta.url).href)};
 const db=openDatabase(process.argv[1]);const store=await BlobStore.open(process.argv[2]);const journal=new SaveJournal(db,store);const input=JSON.parse(process.argv[3]);
 await journal.stagePrepared(input);if(process.argv[4]==='saved')journal.commit(input.userId,input.operationId);console.log('durable');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,f.path,join(f.root,'store'),JSON.stringify(f.input),phase],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const ended=once(child,'exit');let errors='';child.stderr.on('data',data=>{errors+=data;});
 await Promise.race([once(child.stdout,'data').then(([data])=>assert.match(String(data),/durable/)),ended.then(()=>{throw new Error('Fixture exited before durable stage: '+errors);})]);
 child.kill('SIGKILL');await ended;
 assert.equal(f.journal.status('owner',f.input.operationId).state,phase);
 assert.equal(f.journal.commit('owner',f.input.operationId).receipt?.revision,2);assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n,2);
});
