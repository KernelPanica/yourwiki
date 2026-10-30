import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {OfficeValidationWorker} from '../src/office/validation-worker.ts';
async function fixture(t:any){const root=await mkdtemp(join(tmpdir(),'yourwiki-office-validator-')),db=openDatabase(join(root,'db'));t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});const store=await BlobStore.open(join(root,'store'));return {root,db,store};}
async function waitSlot(db:any){for(let i=0;i<200;i++){const row=db.prepare("SELECT * FROM worker_slots WHERE name='office-validation'").get();if(row)return row;await delay(5);}throw new Error('validator did not claim slot');}
test('isolated worker accepts real files and reports invalid format without changing source bytes',async t=>{
 const f=await fixture(t),worker=new OfficeValidationWorker(f.db);for(const [name,format] of [['document.docx','docx'],['table.xlsx','xlsx'],['table.ods','ods'],['slides.pptx','pptx']]){const blob=await f.store.put(createReadStream(new URL('./fixtures/office/'+name,import.meta.url)),{maxBytes:20*1024**2});const receipt=await worker.validate(f.store,blob,format!,new AbortController().signal);assert.equal(receipt.digest,blob.digest);assert.equal(await f.store.verify(blob),true);}
 const blob=await f.store.put((async function*(){yield Buffer.from('invalid');})(),{maxBytes:100});await assert.rejects(worker.validate(f.store,blob,'docx',new AbortController().signal),/INVALID_OFFICE_FILE/);
 assert.equal(f.db.prepare("SELECT 1 FROM worker_slots WHERE name='office-validation'").get(),undefined);
});
test('one shared slot bounds workers and cancellation tears down the owned process before reuse',async t=>{
 const f=await fixture(t),shim=join(f.root,'slow-bwrap');await writeFile(shim,'#!/bin/sh\nsleep 1\nexec /usr/bin/bwrap "$@"\n',{mode:0o700});const blob=await f.store.put((async function*(){yield Buffer.from('text');})(),{maxBytes:100});
 const controller=new AbortController(),first=new OfficeValidationWorker(f.db,{bwrap:shim}),second=new OfficeValidationWorker(f.db,{queueTimeoutMs:20});const pending=first.validate(f.store,blob,'md',controller.signal).then(()=>null,error=>error);await waitSlot(f.db);
 await assert.rejects(second.validate(f.store,blob,'md',new AbortController().signal),/OFFICE_VALIDATOR_BUSY/);controller.abort();assert.equal((await pending as Error).name,'AbortError');
 assert.equal(f.db.prepare("SELECT 1 FROM worker_slots WHERE name='office-validation'").get(),undefined);await second.validate(f.store,blob,'md',new AbortController().signal);
});
test('lost slot ownership cannot acknowledge results or delete the replacement lease',async t=>{
 const f=await fixture(t),shim=join(f.root,'slow-bwrap');await writeFile(shim,'#!/bin/sh\nsleep 1\nexec /usr/bin/bwrap "$@"\n',{mode:0o700});const blob=await f.store.put((async function*(){yield Buffer.from('text');})(),{maxBytes:100});
 const pending=new OfficeValidationWorker(f.db,{bwrap:shim}).validate(f.store,blob,'md',new AbortController().signal);await waitSlot(f.db);f.db.prepare("UPDATE worker_slots SET token='replacement' WHERE name='office-validation'").run();await assert.rejects(pending,/OFFICE_VALIDATOR_LEASE_LOST/);assert.equal((f.db.prepare("SELECT token FROM worker_slots WHERE name='office-validation'").get() as any).token,'replacement');
});
test('timeout kills the worker and releases the slot; no unsafe fallback when sandbox is unavailable',async t=>{
 const f=await fixture(t),blob=await f.store.put((async function*(){yield Buffer.from('text');})(),{maxBytes:100});await assert.rejects(new OfficeValidationWorker(f.db,{timeoutMs:1}).validate(f.store,blob,'md',new AbortController().signal),/OFFICE_VALIDATION_TIMEOUT/);assert.equal(f.db.prepare("SELECT 1 FROM worker_slots WHERE name='office-validation'").get(),undefined);
 await assert.rejects(new OfficeValidationWorker(f.db,{bwrap:'/nonexistent/bwrap'}).validate(f.store,blob,'md',new AbortController().signal),/OFFICE_VALIDATOR_UNAVAILABLE/);
});
