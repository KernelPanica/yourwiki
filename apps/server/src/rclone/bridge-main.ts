/** Test-only initial exports. Later edits use the existing local provider worker.
 * Journal and original CAS stay on local disk, never inside the FUSE mount. */
import {readFile,mkdir,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import Sqlite from 'better-sqlite3';
import {openDatabase,transaction} from '../database.ts';
import {BlobStore} from '../storage/blobs.ts';
import {openLocalStorage} from '../providers/local-storage.ts';
import {assertRcloneMounted} from '../providers/rclone-mount-guard.ts';
import {bindExistingSource} from '../providers/source-bindings.ts';
const [workspace,settingsPath]=process.argv.slice(2),s=JSON.parse(await readFile(settingsPath,'utf8')),db=openDatabase(join(workspace,'database.sqlite3')),store=await BlobStore.open(join(workspace,'storage')),journal=new Sqlite(join(dirname(settingsPath),'exports.sqlite3'));
journal.exec("CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,reference TEXT UNIQUE NOT NULL,digest TEXT,state TEXT NOT NULL,kind TEXT NOT NULL)");
const controller=new AbortController(),signal=controller.signal;for(const name of ['SIGINT','SIGTERM'] as const)process.once(name,()=>controller.abort());
const name=(v:string)=>v.replace(/[\x00-\x1f\\/]/g,'_').slice(0,180)||'Untitled';
async function reference(row:any):Promise<string>{const existing=journal.prepare('SELECT reference FROM exports WHERE id=?').get(row.id) as {reference:string}|undefined;if(existing)return existing.reference;let parent='';if(row.parent_id!==s.folderId){const ancestor=db.prepare("SELECT r.*,COALESCE(f.name,'Folder') AS title FROM resources r LEFT JOIN folder_names f ON f.resource_id=r.id WHERE r.id=? AND r.kind='folder' AND r.trashed=0").get(row.parent_id);if(!ancestor)throw Error('INVALID_PARENT');parent=await folder(ancestor);}
 let ref=(parent?parent+'/':'')+name(row.title),suffix=0;while(journal.prepare('SELECT 1 FROM exports WHERE reference=?').get(ref)||await lstat(join(s.mountDir,ref)).then(()=>true,()=>false)){if(++suffix>100)throw Error('NAME_CONFLICT');ref=(parent?parent+'/':'')+name(row.title)+'-'+row.id.slice(0,8)+(suffix>1?'-'+suffix:'');}journal.prepare('INSERT INTO exports VALUES(?,?,NULL,?,?)').run(row.id,ref,'reserved',row.kind);return ref;}
async function folder(row:any):Promise<string>{const ref=await reference(row);assertRcloneMounted(s.mountDir);await mkdir(join(s.mountDir,ref),{recursive:true});journal.prepare("UPDATE exports SET state='created' WHERE id=?").run(row.id);return ref;}
try{while(!signal.aborted){let storage:Awaited<ReturnType<typeof openLocalStorage>>|undefined;try{
 assertRcloneMounted(s.mountDir);storage=await openLocalStorage(s.mountDir,{requireMount:true});const rows=db.prepare("WITH RECURSIVE t(id,depth) AS(SELECT ?,0 UNION ALL SELECT r.id,t.depth+1 FROM resources r JOIN t ON r.parent_id=t.id WHERE r.trashed=0 AND t.depth<31) SELECT r.*,COALESCE(d.title,f.name,'Folder') AS title,d.local_revision FROM t JOIN resources r ON r.id=t.id LEFT JOIN documents d ON d.id=r.id LEFT JOIN folder_names f ON f.resource_id=r.id WHERE t.depth>0 AND r.trashed=0 AND (r.kind='folder' OR NOT EXISTS(SELECT 1 FROM provider_source_bindings b WHERE b.document_id=r.id)) ORDER BY t.depth,r.id LIMIT 100").all(s.folderId) as any[];
 for(const row of rows){if(signal.aborted)break;try{if(row.kind==='folder'){await folder(row);continue;}const ref=await reference(row),version=db.prepare('SELECT digest,size FROM document_versions WHERE document_id=? AND revision=?').get(row.id,row.local_revision) as {digest:string;size:number};if(!version)continue;
 const scope={signal,check(){assertRcloneMounted(s.mountDir);if(!db.prepare('SELECT 1 FROM resources WHERE id=? AND trashed=0').get(row.id))throw Error('SOURCE_CHANGED');}},prior=journal.prepare('SELECT digest,state FROM exports WHERE id=?').get(row.id) as {digest:string|null;state:string};let fingerprint:string;
 if(prior.state==='reserved'){journal.prepare("UPDATE exports SET state='writing',digest=? WHERE id=?").run(version.digest,row.id);const receipt=await storage.create({operationId:randomUUID(),reference:ref,target:version,source:await store.read(version.digest),...scope});fingerprint=receipt.fingerprint;}
 else{const remote=await storage.read(ref,scope),blob=await store.put(remote.bytes,{maxBytes:4*1024**3,signal});if(blob.digest===version.digest)fingerprint=remote.fingerprint;else{if(blob.digest!==prior.digest)throw Error('EXTERNAL_CONFLICT');fingerprint=(await storage.replace({operationId:randomUUID(),reference:ref,baseline:remote.fingerprint,target:version,source:await store.read(version.digest),...scope})).fingerprint;}}
 journal.prepare("UPDATE exports SET digest=?,state='created' WHERE id=?").run(version.digest,row.id);transaction(db,()=>{scope.check();const current=db.prepare('SELECT local_revision FROM documents WHERE id=?').get(row.id) as {local_revision:number};if(current.local_revision!==row.local_revision)return;bindExistingSource(db,{documentId:row.id,connectionId:s.localConnectionId,reference:ref,fingerprint,confirmedRevision:row.local_revision,confirmedDigest:version.digest,confirmedSize:version.size,now:Date.now()});});
 }catch{console.info(JSON.stringify({rcloneTestExport:'deferred',resourceId:row.id}));}}
 }catch{console.info(JSON.stringify({rcloneTestExport:'mount_unavailable'}));}finally{await storage?.close();}try{await sleep(1000,undefined,{signal});}catch{}}
}finally{journal.close();db.close();}
