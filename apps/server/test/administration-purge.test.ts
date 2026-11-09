import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {Administration} from '../src/administration/service.ts';
import {purgeOfflineWorkspace} from '../src/administration/offline-purge.ts';
const bytes=(value:string)=>(async function*(){yield Buffer.from(value);})();
test('offline purge deletes exclusive current/history/attachment/preview bytes and preserves shared references',async t=>{
 const workspace=await mkdtemp(join(tmpdir(),'wiki-purge-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const db=openDatabase(join(workspace,'database.sqlite3')),store=await BlobStore.open(join(workspace,'storage'));
 db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('g','g','G','!','giga');INSERT INTO groups(id,name) VALUES('team','Team')");
 const s=new Administration(db),exclusive=await store.put(bytes('exclusive source'),{maxBytes:1000}),shared=await store.put(bytes('shared history'),{maxBytes:1000}),attachment=await store.put(bytes('attachment'),{maxBytes:1000}),artifact=await store.put(bytes('preview'),{maxBytes:1000}),manifest=await store.put(bytes(JSON.stringify({artifacts:[artifact]})),{maxBytes:1000});
 for(const id of ['purged','kept']){db.prepare("INSERT INTO resources(id,kind,owner_id,group_id) VALUES(?,'document','g','team')").run(id);db.prepare("INSERT INTO documents(id,title,format,local_revision,created_at) VALUES(?,?,'md',1,1)").run(id,id);const blob=id==='purged'?exclusive:shared;db.prepare("INSERT INTO document_versions(document_id,revision,digest,size,author_id,created_at) VALUES(?,1,?,?,'g',1)").run(id,blob.digest,blob.size);}
 db.prepare("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by_name,created_at) VALUES('purged','source',1,?,?,'Before','md','G',1)").run(shared.digest,shared.size);
 db.prepare("INSERT INTO content_attachments(id,document_id,name,content_type,digest,size,created_at) VALUES('a','purged','a','text/plain',?,?,1)").run(attachment.digest,attachment.size);
 db.prepare("INSERT INTO preview_manifests(manifest_digest,document_id,revision,converter_version,created_at) VALUES(?,'purged',1,'v',1)").run(manifest.digest);
 const keptManifest=await store.put(bytes(JSON.stringify({artifacts:[artifact],shared:true})),{maxBytes:1000});db.prepare("INSERT INTO preview_manifests(manifest_digest,document_id,revision,converter_version,created_at) VALUES(?,'kept',1,'v',1)").run(keptManifest.digest);
 const entry=s.trash('g','resource','purged',s.confirmation('g','resource','purged'));assert.equal(s.purge('g',entry.id,{confirmName:'purged'}).storageCleanup,'pending');db.close();
 assert.deepEqual(await purgeOfflineWorkspace(workspace),{completed:1,blocked:0,deletedBlobs:3,preservedBlobs:2});
 for(const blob of [exclusive,attachment,manifest])assert.equal(await store.verify(blob),false);assert.equal(await store.verify(shared),true);assert.equal(await store.verify(artifact),true);assert.equal(await store.verify(keptManifest),true);
 const reopened=openDatabase(join(workspace,'database.sqlite3'));try{assert.equal((reopened.prepare('SELECT COUNT(*) n FROM history_entries').get() as any).n,0);assert.equal((reopened.prepare('SELECT COUNT(*) n FROM history_usage').get() as any).n,0);assert.equal((reopened.prepare('SELECT COUNT(*) n FROM document_versions').get() as any).n,1);assert.equal((reopened.prepare("SELECT state FROM resource_purge_cleanup WHERE resource_id='purged'").get() as any).state,'complete');assert.throws(()=>new Administration(reopened).restore('g',entry.id),/NOT_FOUND/);assert.deepEqual(reopened.pragma('foreign_key_check'),[]);}finally{reopened.close();}
 assert.deepEqual(await purgeOfflineWorkspace(workspace),{completed:0,blocked:0,deletedBlobs:0,preservedBlobs:2});
});

async function pendingFixture(t:any){
 const workspace=await mkdtemp(join(tmpdir(),'wiki-purge-block-'));t.after(()=>rm(workspace,{recursive:true,force:true}));const db=openDatabase(join(workspace,'database.sqlite3')),store=await BlobStore.open(join(workspace,'storage')),blob=await store.put(bytes('retained'),{maxBytes:100});
 db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('g','g','G','!','giga');INSERT INTO groups(id,name) VALUES('team','Team');INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','g','team');INSERT INTO documents(id,title,format,local_revision,created_at) VALUES('doc','Doc','md',1,1)");db.prepare("INSERT INTO document_versions VALUES('doc',1,?,?,'g',1)").run(blob.digest,blob.size);const service=new Administration(db),entry=service.trash('g','resource','doc',service.confirmation('g','resource','doc'));service.purge('g',entry.id,{confirmName:'Doc'});return {workspace,db,store,blob};
}
test('offline purge blocks retained Office receipts and denies active workers without deleting bytes',async t=>{
 const f=await pendingFixture(t);f.db.prepare("INSERT INTO office_prepared(id,document_id,source_revision,source_digest,format,converter_version,state,reserved_bytes,lease_token,lease_until,created_at,last_access_at) VALUES('p','doc',1,?,'md','v','failed',0,'expired',0,1,1)").run(f.blob.digest);f.db.close();
 assert.deepEqual(await purgeOfflineWorkspace(f.workspace),{completed:0,blocked:1,deletedBlobs:0,preservedBlobs:0});assert.equal(await f.store.verify(f.blob),true);
 const db=openDatabase(join(f.workspace,'database.sqlite3'));assert.equal((db.prepare("SELECT error_code FROM resource_purge_cleanup WHERE resource_id='doc'").get() as any).error_code,'PURGE_RETAINED_RECEIPTS');db.prepare("INSERT INTO worker_slots VALUES('test','active',?)").run(Date.now()+60000);db.close();await assert.rejects(purgeOfflineWorkspace(f.workspace),/PURGE_WORKERS_ACTIVE/);assert.equal(await f.store.verify(f.blob),true);
});
test('crash after metadata cleanup leaves durable candidates for the next offline run',async t=>{
 const f=await pendingFixture(t);f.db.prepare('INSERT INTO resource_purge_blobs(digest) VALUES(?)').run(f.blob.digest);f.db.prepare("DELETE FROM document_versions WHERE document_id='doc'").run();f.db.close();
 assert.deepEqual(await purgeOfflineWorkspace(f.workspace),{completed:1,blocked:0,deletedBlobs:1,preservedBlobs:0});assert.equal(await f.store.verify(f.blob),false);
});

test('offline purge blocks local provider originals and never reports their cleanup complete',async t=>{
 const f=await pendingFixture(t),originalRoot=join(f.workspace,'provider-originals','local');await mkdir(originalRoot,{recursive:true});const original=join(originalRoot,'original.md');await writeFile(original,'retained original');
 f.db.exec("INSERT INTO provider_connections(id,provider,label,encrypted_config,created_at,updated_at) VALUES('local','local','Local','encrypted',1,1)");f.db.prepare("INSERT INTO provider_source_bindings(document_id,connection_id,reference,fingerprint,confirmed_revision,created_at) VALUES('doc','local','original.md','verified',1,1)").run();f.db.close();
 assert.deepEqual(await purgeOfflineWorkspace(f.workspace),{completed:0,blocked:1,deletedBlobs:0,preservedBlobs:0});assert.equal(await f.store.verify(f.blob),true);assert.equal(await readFile(original,'utf8'),'retained original');
 const db=openDatabase(join(f.workspace,'database.sqlite3'));try{assert.deepEqual({...db.prepare("SELECT state,error_code,completed_at FROM resource_purge_cleanup WHERE resource_id='doc'").get() as any},{state:'blocked',error_code:'PURGE_RETAINED_RECEIPTS',completed_at:null});assert.ok(db.prepare("SELECT 1 FROM provider_source_bindings WHERE document_id='doc'").get());assert.ok(db.prepare("SELECT 1 FROM document_versions WHERE document_id='doc'").get());}finally{db.close();}
});
