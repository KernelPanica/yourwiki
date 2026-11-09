import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {SecretConfigs} from './secret-config.ts';
import {GoogleDiscoveryRequests} from './google-discovery-jobs.ts';
import {GoogleImportRequests} from './google-import-jobs.ts';
type Folder={reference:string|null;parentId:string|null;depth:number;previous:string|null};
type Mount={connection_id:string;actor_id:string;group_id:string;connection_revision:number;queue_json:string;discovery_id:string|null};
/** Catalogue scheduling only. Existing bounded workers perform all Drive IO,
 * verify ownership/source checksums and publish files only after preview. */
export class GoogleStorageWorker{
 private db:Database;private secrets:SecretConfigs;
 constructor(db:Database,secrets:SecretConfigs){this.db=db;this.secrets=secrets;}
 async runOnce(signal?:AbortSignal){if(signal?.aborted)return 'idle';return transaction(this.db,()=>{
  const now=Date.now(),mount=this.db.prepare("SELECT s.* FROM google_storage_mounts s JOIN provider_connections c ON c.id=s.connection_id JOIN users u ON u.id=s.actor_id JOIN groups g ON g.id=s.group_id WHERE c.enabled=1 AND u.active=1 AND u.admin_role='giga' AND g.trashed_at IS NULL AND g.purged_at IS NULL AND s.next_scan_at<=? ORDER BY s.next_scan_at,s.connection_id LIMIT 1").get(now) as Mount|undefined;if(!mount)return 'idle';
  const connection=this.db.prepare('SELECT revision,encrypted_config FROM provider_connections WHERE id=?').get(mount.connection_id) as {revision:number;encrypted_config:string},config=this.secrets.decrypt(connection.encrypted_config);
  const update=(queue:Folder[],discovery:string|null,next=now+1000,error:string|null=null)=>this.db.prepare('UPDATE google_storage_mounts SET queue_json=?,discovery_id=?,next_scan_at=?,error_code=?,connection_revision=? WHERE connection_id=?').run(JSON.stringify(queue),discovery,next,error,connection.revision,mount.connection_id);
  if(!config.refresh_token||!config.google_root_id){update([],null,now+30000);return 'idle';}
  let queue=JSON.parse(mount.queue_json) as Folder[];if(mount.connection_revision!==connection.revision){queue=[];mount.discovery_id=null;}if(!queue.length)queue=[{reference:null,parentId:(this.db.prepare('SELECT folder_id FROM provider_mounts WHERE connection_id=?').get(mount.connection_id) as {folder_id:string|null}).folder_id,depth:0,previous:null}];
  const head=queue[0]!,discovery=new GoogleDiscoveryRequests(this.db,this.secrets);
  // Background pages are private receipts. Once consumed, keep their audit job
  // but release the encrypted page so scans cannot exhaust interactive quotas.
  const releasePage=(id:string|null)=>{if(id)this.db.prepare('DELETE FROM provider_google_discovery_jobs WHERE job_id=? AND actor_id=?').run(id,mount.actor_id);};
  if(head.parentId&&this.db.prepare('SELECT 1 FROM resources WHERE id=? AND trashed=1').get(head.parentId)){releasePage(head.previous);releasePage(mount.discovery_id);update(queue.slice(1),null);return 'skipped';}
  try{
   if(!mount.discovery_id){const request=discovery.request(mount.actor_id,{requestId:randomUUID(),connectionId:mount.connection_id,baseRevision:connection.revision,folderId:head.reference,previousOperationId:head.previous});update(queue,request.operationId);return 'scheduled';}
   const result=discovery.status(mount.actor_id,mount.discovery_id);if(['queued','running'].includes(result.state)){update(queue,mount.discovery_id);return 'idle';}
   if(!result.page||result.state!=='succeeded'){update([],null,now+60000,result.errorCode??'PROVIDER_UNAVAILABLE');releasePage(head.previous);releasePage(mount.discovery_id);return 'blocked';}
   for(const file of result.page.items){
    if(file.kind==='folder'){
     if(head.depth>=30||queue.length>=2000)continue;
     if(this.db.prepare('SELECT 1 FROM google_storage_folder_exports e WHERE e.connection_id=? AND e.reference=? AND NOT EXISTS(SELECT 1 FROM provider_google_folders f WHERE f.resource_id=e.resource_id)').get(mount.connection_id,file.id))continue;
     let folder=this.db.prepare('SELECT f.resource_id,r.trashed FROM provider_google_folders f JOIN resources r ON r.id=f.resource_id WHERE f.connection_id=? AND f.reference=?').get(mount.connection_id,file.id) as {resource_id:string;trashed:number}|undefined;
     if(folder?.trashed)continue;
     if(!folder){const id=randomUUID();this.db.prepare("INSERT INTO resources(id,kind,parent_id,owner_id,group_id) VALUES(?,'folder',?,?,?)").run(id,head.parentId,mount.actor_id,mount.group_id);this.db.prepare('INSERT INTO provider_google_folders VALUES(?,?,?,?,?)').run(id,mount.connection_id,file.id,file.name.slice(0,200),now);folder={resource_id:id,trashed:0};}
     else this.db.prepare('UPDATE provider_google_folders SET title=? WHERE resource_id=?').run(file.name.slice(0,200),folder.resource_id);
     if(!queue.some(item=>item.reference===file.id))queue.push({reference:file.id,parentId:folder.resource_id,depth:head.depth+1,previous:null});
    }else{
     if(this.db.prepare('SELECT 1 FROM google_storage_exports WHERE connection_id=? AND reference=?').get(mount.connection_id,file.id))continue;
     if(this.db.prepare('SELECT 1 FROM provider_source_bindings WHERE connection_id=? AND reference=?').get(mount.connection_id,file.id))continue;
     if(this.db.prepare("SELECT 1 FROM provider_google_imports WHERE connection_id=? AND reference=? AND (state IN ('queued','receiving','staged') OR updated_at>?)").get(mount.connection_id,file.id,now-60000))continue;
     try{new GoogleImportRequests(this.db,this.secrets).request(mount.actor_id,{requestId:randomUUID(),discoveryOperationId:mount.discovery_id,reference:file.id,parentId:head.parentId,groupId:mount.group_id,title:file.name.slice(0,200)});}catch(error){if(!error||typeof error!=='object'||!('code' in error)||!['PREVIEW_UNSUPPORTED','SOURCE_ALREADY_BOUND','IMPORT_BUSY','IMPORT_QUOTA'].includes(String(error.code)))throw error;}
    }
   }
   const previousPage=head.previous;if(result.hasMore)head.previous=mount.discovery_id;else queue.shift();
   update(queue,null,queue.length?now+250:now+60000);this.db.prepare('UPDATE google_storage_mounts SET scanned_at=? WHERE connection_id=?').run(now,mount.connection_id);releasePage(previousPage);if(!result.hasMore)releasePage(mount.discovery_id);return 'scheduled';
  }catch(error){const raw=error&&typeof error==='object'&&'code' in error?String(error.code):'PROVIDER_UNAVAILABLE';update([],null,now+60000,['ACCESS_DENIED','PROVIDER_CONFIG_CHANGED','CONFIG_UNAVAILABLE','DISCOVERY_LIMIT','IMPORT_LIMIT'].includes(raw)?raw:'PROVIDER_UNAVAILABLE');return 'blocked';}
 });}
}
