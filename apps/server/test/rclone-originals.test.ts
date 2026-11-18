import {verifyStoredReferences} from '../src/release/backup-references.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,mkdir,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {buffer} from 'node:stream/consumers';
import {BlobStore} from '../src/storage/blobs.ts';
import {RcloneOriginalStore,type OriginalSource} from '../src/storage/rclone-originals.ts';
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'wiki-originals-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=join(root,'storage');const local=await BlobStore.open(storage);
 const bytes=Buffer.from('cloud original'),digest=createHash('sha256').update(bytes).digest('hex'),md5=createHash('md5').update(bytes).digest('hex');
 const remote=join(root,'cloud');await writeFile(remote,bytes);let valid=true,known=true;
 const source:OriginalSource={digest,size:bytes.length,md5,path:remote,check:async()=>{if(!valid)throw Error('PROVIDER_SOURCE_CHANGED');}};
 const store=new RcloneOriginalStore(storage,local,async d=>known&&d===digest?source:null);
 return {store,local,storage,remote,bytes,digest,source,invalidate:()=>{valid=false;},forget:()=>{known=false;}};
}
test('confirmed originals are read from mounted Drive without a local blob',async t=>{
 const f=await fixture(t);assert.equal((await buffer(await f.store.read(f.digest))).toString(),'cloud original');
 assert.equal((await buffer(await f.store.read(f.digest,{start:1,end:4}))).toString(),'loud');
 assert.equal((await readFile(await f.store.localFile(f.digest))).toString(),'cloud original');
 await assert.rejects(access(join(f.storage,'blobs',f.digest.slice(0,2),f.digest.slice(2))));
});
test('a changed or unavailable original never falls back to an old local copy',async t=>{
 const f=await fixture(t);await f.local.put((async function*(){yield f.bytes;})(),{maxBytes:100});f.invalidate();
 await assert.rejects(f.store.read(f.digest),/SOURCE_CHANGED/);await assert.rejects(f.store.localFile(f.digest),/SOURCE_CHANGED/);
 assert.equal((await buffer(await f.local.read(f.digest))).toString(),'cloud original');
});
test('unconfirmed edits remain durable until their cloud receipt exists',async t=>{
 const f=await fixture(t);f.forget();const ref=await f.store.put((async function*(){yield Buffer.from('pending edit');})(),{maxBytes:100});
 assert.equal((await buffer(await f.store.read(ref.digest))).toString(),'pending edit');
 assert.equal(await f.store.evictConfirmed(ref.digest),0);
});
test('eviction verifies the local SHA and remote MD5 before deleting only the local copy',async t=>{
 const f=await fixture(t);await f.local.put((async function*(){yield f.bytes;})(),{maxBytes:100});
 assert.equal(await f.store.evictConfirmed(f.digest),f.bytes.length);
 await assert.rejects(f.local.stat(f.digest));assert.equal((await readFile(f.remote)).toString(),'cloud original');
 assert.equal((await buffer(await f.store.read(f.digest))).toString(),'cloud original');
});
test('failed revalidation, corrupt bytes and remote hash mismatches preserve local data',async t=>{
 for(const mode of ['offline','corrupt','md5']){
  const f=await fixture(t);await f.local.put((async function*(){yield f.bytes;})(),{maxBytes:100});
  if(mode==='offline')f.invalidate();
  if(mode==='corrupt')await writeFile(await f.local.localFile(f.digest),'damaged content');
  if(mode==='md5')f.source.md5='0'.repeat(32);
  await assert.rejects(f.store.evictConfirmed(f.digest));await f.local.stat(f.digest);
 }
});
test('invalid digests and ranges are rejected before accessing cloud paths',async t=>{
 const f=await fixture(t);await assert.rejects(f.store.read('../secret'),/digest/);
 await assert.rejects(f.store.read(f.digest,{start:-1,end:4}),/range/);
 await assert.rejects(f.store.read(f.digest,{start:0,end:999}),/range/);
});

import {openDatabase} from '../src/database.ts';
import {DocumentService} from '../src/documents.ts';
import {bindExistingSource} from '../src/providers/source-bindings.ts';
import {retiredOfficeDigests,discardOfficeCopy,enableOriginals,retireExternalCopy} from '../src/storage/originals-main.ts';
test('legacy Office cleanup preserves active files, unbound work and document permissions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-office-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=openDatabase(join(root,'database.sqlite3'));t.after(()=>db.close());
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','U','!'); INSERT INTO groups(id,name) VALUES('g','G'); INSERT INTO memberships VALUES('u','g'); INSERT INTO provider_connections(id,provider,label,encrypted_config,enabled,created_at,updated_at) VALUES('old','google','Old','a',1,1,1),('live','google','Live','a',1,1,1);");
 const storage=join(root,'storage'),store=await BlobStore.open(storage),docs=new DocumentService(db,store);
 async function create(text:string,connection?:string,format='docx'){
  const blob=await store.put((async function*(){yield Buffer.from(text);})(),{maxBytes:100});
  const made=docs.commitPreparedCreate({userId:'u',title:text,format,groupId:'g',parentId:null,localOnly:true},blob);
  if(connection)bindExistingSource(db,{documentId:made.documentId,connectionId:connection,reference:made.documentId,fingerprint:'test',confirmedRevision:1,confirmedDigest:blob.digest,confirmedSize:blob.size,now:1});
  return {...blob,...made};
 }
 const legacy=await create('obsolete','old'),active=await create('live','live'),unbound=await create('unsynced');
 const shared=await create('shared','old');await create('shared','live');
 const nonOffice=await create('pdf','old','pdf'),sharedPending=await create('same pending','old'),pendingTarget=await create('pending base','old');db.prepare("UPDATE provider_connections SET enabled=0 WHERE id='old'").run();
 const pending=await docs.save({userId:'u',documentId:legacy.documentId,baseRevision:1},(async function*(){yield Buffer.from('pending disabled connection');})());
 const samePending=await docs.save({userId:'u',documentId:pendingTarget.documentId,baseRevision:1},(async function*(){yield Buffer.from('same pending');})());
 assert(!retiredOfficeDigests(db).includes(samePending.blob.digest));
 assert(!retiredOfficeDigests(db).includes(pending.blob.digest));
 assert.deepEqual(retiredOfficeDigests(db).sort(),[legacy.digest,pendingTarget.digest].sort());
 assert.equal(await discardOfficeCopy(db,storage,active.digest,async()=>true),0);
 assert.equal(await discardOfficeCopy(db,storage,unbound.digest,async()=>true),0);
 await assert.rejects(discardOfficeCopy(db,storage,legacy.digest),/REMOTE_AVAILABILITY_REQUIRED/);
 assert.equal(await discardOfficeCopy(db,storage,legacy.digest,async()=>false),0);
 assert.equal(await discardOfficeCopy(db,storage,legacy.digest,async()=>true),legacy.size);
 assert.equal((db.prepare('SELECT count(*) n FROM documents').get() as any).n,8);
 assert.equal((db.prepare('SELECT count(*) n FROM memberships').get() as any).n,1);
 assert.equal((db.prepare('SELECT reason FROM rclone_discarded_payloads WHERE digest=?').get(legacy.digest) as any).reason,'local-office-history');
 assert.equal(await store.verify(pending.blob),true);assert.equal(await store.verify(samePending.blob),true);
 assert.equal(await store.verify(active),true);assert.equal(await store.verify(shared),true);assert.equal(await store.verify(nonOffice),true);
 await enableOriginals(storage);
 const time='2026-11-18T00:00:00Z',md5=createHash('md5').update('live').digest('hex'),entry={Path:'Live.docx',Name:'Live.docx',ID:active.documentId,Size:active.size,ModTime:time,IsDir:false,MimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',Hashes:{md5}};
 db.prepare('INSERT INTO rclone_drive_mounts(connection_id,binary_path,config_path,mount_path,staging_path) VALUES(?,?,?,?,?)').run('live','/tmp/rclone','/tmp/conf','/tmp/mount','/tmp/stage');
 db.prepare('INSERT INTO rclone_drive_entries VALUES(?,?,?,?,?)').run('live',active.documentId,entry.Path,JSON.stringify(entry),1);
 db.prepare('UPDATE provider_source_bindings SET fingerprint=? WHERE document_id=?').run(JSON.stringify(['rclone-drive-v1',entry.ID,String(entry.Size),md5,time]),active.documentId);
 await verifyStoredReferences(root);
 await rm(join(storage,'blobs',active.digest.slice(0,2),active.digest.slice(2)));
 // A current confirmed external reference does not need a backup payload.
 await verifyStoredReferences(root);
 await store.put((async function*(){yield Buffer.from('live');})(),{maxBytes:100});
 await create('live'); // Independent unbound document shares the same digest.
 await rm(join(storage,'blobs',active.digest.slice(0,2),active.digest.slice(2)));
 await assert.rejects(verifyStoredReferences(root));
 await store.put((async function*(){yield Buffer.from('live');})(),{maxBytes:100});
 db.prepare('UPDATE app_state SET direct_originals_enabled=1 WHERE id=1').run();
 assert.throws(()=>db.prepare('UPDATE app_state SET history_enabled=1 WHERE id=1').run(),/LOCAL_HISTORY_REQUIRES_LOCAL_STORAGE/);
 await verifyStoredReferences(root);
 db.prepare("INSERT INTO rclone_discarded_payloads VALUES(?,?,'local-office-history',1)").run(pending.blob.digest,pending.blob.size);
 await rm(join(storage,'blobs',pending.blob.digest.slice(0,2),pending.blob.digest.slice(2)));
 await assert.rejects(verifyStoredReferences(root));
});
test('mode marker applies to the main store but not temporary upload namespaces',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-original-mode-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=openDatabase(join(root,'database.sqlite3'));t.after(()=>db.close());
 const storage=join(root,'storage');await BlobStore.open(storage);await enableOriginals(storage);
 const store=await BlobStore.open(storage);assert.equal(store.backend,'rclone');
 const temporary=await store.uploadStore('11111111-1111-4111-8111-111111111111');
 assert.equal(temporary.backend,'local');
 const ref=await temporary.put((async function*(){yield Buffer.from('new edit');})(),{maxBytes:100});
 await store.adopt(temporary,ref);await store.removeUpload('11111111-1111-4111-8111-111111111111');
 assert.equal((await buffer(await store.read(ref.digest))).toString(),'new edit');
});

test('same-size stale mounted bytes cannot pass digest validation or reach converters',async t=>{
 const f=await fixture(t);await writeFile(f.remote,'wrong original');
 await assert.rejects(buffer(await f.store.read(f.digest)),/SOURCE_CHANGED/);
 await assert.rejects(f.store.localFile(f.digest),/SOURCE_CHANGED/);
});

test('legacy binary eviction requires exact remote bytes and preserves shared pending data',async t=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-legacy-reference-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const db=openDatabase(join(root,'database.sqlite3'));t.after(()=>db.close());
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','U','!'); INSERT INTO groups(id,name) VALUES('g','G'); INSERT INTO memberships VALUES('u','g'); INSERT INTO provider_connections(id,provider,label,encrypted_config,enabled,created_at,updated_at) VALUES('old','google','Old','a',1,1,1),('live','google','Live','a',1,1,1);");
 const storage=join(root,'storage'),store=await BlobStore.open(storage),docs=new DocumentService(db,store);
 const blob=await store.put((async function*(){yield Buffer.from('legacy PDF bytes');})(),{maxBytes:100});
 const doc=docs.commitPreparedCreate({userId:'u',title:'legacy',format:'pdf',groupId:'g',parentId:null,localOnly:true},blob);
 bindExistingSource(db,{documentId:doc.documentId,connectionId:'old',reference:'legacy-file',fingerprint:JSON.stringify(['rclone-drive-v1']),confirmedRevision:1,confirmedDigest:blob.digest,confirmedSize:blob.size,now:1});
 db.prepare("UPDATE provider_connections SET enabled=0 WHERE id='old'").run();
 const ref={...blob,md5:createHash('md5').update('legacy PDF bytes').digest('hex'),source_connection_id:'old',access_connection_id:'live',reference:'legacy-file',parent_id:null,binary_path:'/tmp/bin',config_path:'/tmp/conf',mount_path:'/tmp/mount',staging_path:'/tmp/stage'};
 const remote=join(root,'remote');await writeFile(remote,'wrong PDF bytes!');
 const resolve=async()=>({...blob,path:remote,md5:ref.md5,check:async()=>{}});
 await assert.rejects(retireExternalCopy(db,storage,ref,resolve),/PROVIDER_SOURCE_CHANGED/);
 assert.equal(await store.verify(blob),true);assert.equal((db.prepare('SELECT count(*) n FROM rclone_external_payloads').get() as any).n,0);
 await writeFile(remote,'legacy PDF bytes');
 const alias=docs.commitPreparedCreate({userId:'u',title:'unsynced alias',format:'pdf',groupId:'g',parentId:null,localOnly:true},blob);
 assert.equal(await retireExternalCopy(db,storage,ref,resolve),0);assert.equal(await store.verify(blob),true);
 db.prepare("UPDATE rclone_external_payloads SET reference='old-missing-ref',md5='00000000000000000000000000000000' WHERE digest=?").run(blob.digest);
 // Move the independent alias to a new digest; its original payload remains pinned until then.
 await docs.save({userId:'u',documentId:alias.documentId,baseRevision:1},(async function*(){yield Buffer.from('unsynced new content');})());
 assert.equal(await retireExternalCopy(db,storage,ref,resolve),blob.size);
 assert.equal((db.prepare('SELECT reference FROM rclone_external_payloads WHERE digest=?').get(blob.digest) as any).reference,ref.reference);
 await enableOriginals(storage);await verifyStoredReferences(root);
 // Even a durable external receipt cannot mask a missing new staged/unbound current file.
 const row=db.prepare('SELECT digest FROM document_versions WHERE document_id=? AND revision=2').get(alias.documentId) as {digest:string};
 await rm(join(storage,'blobs',row.digest.slice(0,2),row.digest.slice(2)));await assert.rejects(verifyStoredReferences(root));
});
