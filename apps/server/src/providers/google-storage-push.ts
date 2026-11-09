import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID,createHash} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {AccessService} from '../access.ts';
import {SecretConfigs} from './secret-config.ts';
import {GoogleAuthPool} from './google-auth-pool.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleControlHttp} from './google-control-http.ts';
import {GoogleMetadata} from './google-metadata.ts';
import {googleBinaryMime} from './google-source.ts';
import {GoogleSourceReader} from './google-reader.ts';
import {googleManagedRecipients} from './google-grants.ts';
import {bindExistingSource} from './source-bindings.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import {googleJson} from './google-json.ts';
type Row={document_id:string;connection_id:string;actor_id:string;revision:number;reference:string|null;destination:string|null;state:string};
/** New objects only: a pre-generated file ID makes retries recoverable without
 * duplicating files or overwriting any existing original. No replacement PATCH. */
export class GoogleStoragePush{
 private db:Database;private store:BlobStore;private secrets:SecretConfigs;private auth:GoogleAuthPool;private request:typeof fetch;
 constructor(db:Database,store:BlobStore,secrets:SecretConfigs,auth:GoogleAuthPool,options:{fetch?:typeof fetch}={}){this.db=db;this.store=store;this.secrets=secrets;this.auth=auth;this.request=options.fetch??fetch;}
 async runOnce(parent?:AbortSignal){if(parent?.aborted)return 'idle';const now=Date.now(),slot=randomUUID(),row=transaction(this.db,()=>{
  if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND lease_until>?").get(now))return null;
  const row=this.db.prepare("SELECT e.* FROM google_storage_exports e JOIN provider_connections c ON c.id=e.connection_id JOIN resources r ON r.id=e.document_id WHERE e.state!='confirmed' AND e.next_attempt_at<=? AND c.enabled=1 AND r.trashed=0 ORDER BY e.next_attempt_at,e.document_id LIMIT 1").get(now) as Row|undefined;
  if(row)this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slot,now+30000);return row;
 });if(!row)return 'idle';
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...parent?[parent]:[]]),deadline=setTimeout(()=>controller.abort(),1800000);let drive:GoogleReadHttp|undefined,control:GoogleControlHttp|undefined,reader:GoogleSourceReader|undefined;
 const connection=this.db.prepare('SELECT encrypted_config,revision FROM provider_connections WHERE id=?').get(row.connection_id) as {encrypted_config:string;revision:number},config=this.secrets.decrypt(connection.encrypted_config),access=new AccessService(this.db);
 const check=()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');if(!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='provider-source' AND token=? AND lease_until>?").get(slot,Date.now()))throw new ProviderError('LEASE_LOST');if(!this.db.prepare('SELECT 1 FROM provider_connections WHERE id=? AND revision=? AND enabled=1').get(row.connection_id,connection.revision))throw new ProviderError('PROVIDER_CONFIG_CHANGED');if(!access.allows(row.actor_id,row.document_id,'read')||!access.allows(row.actor_id,row.document_id,'write'))throw new ProviderError('ACCESS_DENIED');const doc=this.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(row.document_id) as {local_revision:number};if(doc.local_revision!==row.revision)throw new ProviderError('PROVIDER_CONFLICT');};
 const heartbeat=setInterval(()=>{try{check();this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='provider-source' AND token=?").run(Date.now()+30000,slot);}catch{controller.abort();}},10000);
 try{
  check();if(!config.refresh_token||!config.google_root_id)throw new ProviderError('PROVIDER_CONFIG_CHANGED');
  if(this.db.prepare('SELECT 1 FROM provider_source_bindings WHERE document_id=?').get(row.document_id)){this.db.prepare("UPDATE google_storage_exports SET state='confirmed',error_code=NULL WHERE document_id=?").run(row.document_id);return 'confirmed';}
  const auth={access:(scope:ProviderCheck)=>this.auth.access(row.connection_id,connection.revision,scope),invalidate:(token:string)=>this.auth.invalidate(row.connection_id,connection.revision,token)},scope={signal,check};
  drive=new GoogleReadHttp(auth,{fetch:this.request});control=new GoogleControlHttp(auth,{fetch:this.request});const metadata=new GoogleMetadata(drive,async id=>googleManagedRecipients(this.db,row.connection_id,connection.revision,id));await metadata.root(String(config.root),scope);
  const mount=(this.db.prepare('SELECT folder_id FROM provider_mounts WHERE connection_id=?').get(row.connection_id) as {folder_id:string|null}).folder_id;
  const generate=async()=>{const ids=await control!.call('GET','files/generateIds',{count:'1',space:'drive',type:'files'},undefined,scope);if(!Array.isArray(ids.ids)||ids.ids.length!==1)throw new ProviderError('PROVIDER_UNAVAILABLE');return googleFileId(ids.ids[0]);};
  const exists=async(id:string)=>{try{return await drive!.file(id,'id,mimeType,parents,appProperties,trashed,ownedByMe',scope);}catch(error){if(error instanceof ProviderError&&error.code==='PROVIDER_SOURCE_CHANGED')return null;throw error;}};
  const folder=async(id:string|null,depth=0):Promise<string>=>{
   check();if(id===mount)return String(config.root);if(id===null||depth>=31||!access.allows(row.actor_id,id,'write')||!access.allows(row.actor_id,id,'read'))throw new ProviderError('ACCESS_DENIED');
   const local=this.db.prepare("SELECT r.parent_id,COALESCE(n.name,f.title,'Folder') AS title FROM resources r LEFT JOIN folder_names n ON n.resource_id=r.id LEFT JOIN provider_google_folders f ON f.resource_id=r.id WHERE r.id=? AND r.kind='folder' AND r.trashed=0").get(id) as {parent_id:string|null;title:string}|undefined;if(!local)throw new ProviderError('ACCESS_DENIED');
   const binding=this.db.prepare('SELECT reference FROM provider_google_folders WHERE resource_id=? AND connection_id=?').get(id,row.connection_id) as {reference:string}|undefined;if(binding){await metadata.folder(binding.reference,String(config.root),scope);return binding.reference;}
   const destination=await folder(local.parent_id,depth+1);let reserved=this.db.prepare('SELECT reference,destination FROM google_storage_folder_exports WHERE resource_id=? AND connection_id=?').get(id,row.connection_id) as {reference:string;destination:string}|undefined;
   if(!reserved){const reference=await generate();check();this.db.prepare('INSERT INTO google_storage_folder_exports VALUES(?,?,?,?)').run(id,row.connection_id,reference,destination);reserved={reference,destination};}if(reserved.destination!==destination)throw new ProviderError('PROVIDER_CONFLICT');
   let remote=await exists(reserved.reference);if(!remote){await control!.call('POST','files',{fields:'id'},{id:reserved.reference,name:local.title,mimeType:'application/vnd.google-apps.folder',parents:[destination],appProperties:{yourwikiStorageFolder:id},writersCanShare:false},{...scope,beforeDispatch:check});remote=await exists(reserved.reference);}
   if(!remote||remote.ownedByMe!==true||remote.trashed!==false||(remote.appProperties as Record<string,unknown>|undefined)?.yourwikiStorageFolder!==id||!Array.isArray(remote.parents)||remote.parents[0]!==destination)throw new ProviderError('PROVIDER_CONFLICT');await metadata.folder(reserved.reference,String(config.root),scope);check();this.db.prepare('INSERT INTO provider_google_folders VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO NOTHING').run(id,row.connection_id,reserved.reference,local.title,Date.now());return reserved.reference;
  };
  const doc=this.db.prepare('SELECT d.title,d.format,r.parent_id,v.digest,v.size FROM documents d JOIN resources r ON r.id=d.id JOIN document_versions v ON v.document_id=d.id AND v.revision=? WHERE d.id=?').get(row.revision,row.document_id) as {title:string;format:string;parent_id:string|null;digest:string;size:number};
  const destination=await folder(doc.parent_id);if(row.destination&&row.destination!==destination)throw new ProviderError('PROVIDER_CONFLICT');if(!row.reference){row.reference=await generate();check();row.destination=destination;this.db.prepare('UPDATE google_storage_exports SET reference=?,destination=? WHERE document_id=?').run(row.reference,destination,row.document_id);}
  const reference=row.reference;let remote=await exists(reference);
  if(!remote){
   const token=await auth.access(scope);check();const boundary='yourwiki'+randomUUID().replaceAll('-',''),body=JSON.stringify({id:reference,name:doc.title,mimeType:googleBinaryMime(doc.format),parents:[destination],appProperties:{yourwikiStorageDocument:row.document_id},writersCanShare:false}),start=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+body+'\r\n--'+boundary+'\r\nContent-Type: '+googleBinaryMime(doc.format)+'\r\n\r\n'),end=Buffer.from('\r\n--'+boundary+'--\r\n'),store=this.store;
   async function* content(){check();yield start;let size=0;const hash=createHash('sha256');for await(const chunk of await store.read(doc.digest)){check();size+=chunk.byteLength;if(size>doc.size)throw new ProviderError('PROVIDER_SOURCE_CHANGED');hash.update(chunk);yield chunk;}if(size!==doc.size||hash.digest('hex')!==doc.digest)throw new ProviderError('PROVIDER_SOURCE_CHANGED');check();yield end;}
   this.db.prepare("UPDATE google_storage_exports SET state='dispatched' WHERE document_id=?").run(row.document_id);
   const stream=content(),response=await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal,headers:{authorization:'Bearer '+token,'content-type':'multipart/related; boundary='+boundary,'content-length':String(start.length+doc.size+end.length)},body:stream,duplex:'half'} as unknown as RequestInit);
   try{check();if(response.status===401){auth.invalidate(token);throw new ProviderError('PROVIDER_CONFIG_CHANGED');}if(response.status===403)throw new ProviderError('ACCESS_DENIED');if(response.status===409)throw new ProviderError('PROVIDER_UNAVAILABLE');if(response.status<200||response.status>=300)throw new ProviderError('PROVIDER_UNAVAILABLE');const receipt=await googleJson(response,{signal,maxBytes:65536,check});if(receipt.id!==reference)throw new ProviderError('PROVIDER_SOURCE_CHANGED');}finally{await stream.return(undefined);void response.body?.cancel().catch(()=>{});}
   remote=await exists(reference);
  }
  if(!remote||remote.ownedByMe!==true||remote.trashed!==false||(remote.appProperties as Record<string,unknown>|undefined)?.yourwikiStorageDocument!==row.document_id||!Array.isArray(remote.parents)||remote.parents.length!==1||remote.parents[0]!==destination)throw new ProviderError('PROVIDER_CONFLICT');
  // Verify actual bytes, not a successful HTTP status, before binding the original.
  reader=new GoogleSourceReader(String(config.root),auth,async id=>googleManagedRecipients(this.db,row.connection_id,connection.revision,id),{fetch:this.request,format:doc.format});
  // Drive may advance metadata immediately after creation while the uploaded
  // bytes are already stable. Retry verification only, never the upload. Every
  // pass still proves ancestry, permissions, version stability and SHA-256.
  let accepted:Awaited<ReturnType<GoogleSourceReader['read']>>|undefined;
  for(let attempt=0;attempt<3;attempt++){
   try{const candidate=await reader.read(reference,scope);if(candidate.size!==doc.size)throw new ProviderError('PROVIDER_CONFLICT');let size=0;const hash=createHash('sha256');for await(const chunk of candidate.bytes){check();size+=chunk.byteLength;hash.update(chunk);}if(size!==doc.size||hash.digest('hex')!==doc.digest)throw new ProviderError('PROVIDER_CONFLICT');accepted=candidate;break;}
   catch(error){if(!(error instanceof ProviderError)||error.code!=='PROVIDER_CONFLICT'||attempt===2)throw error;await delay(250*(attempt+1),undefined,{signal});check();}
  }
  if(!accepted)throw new ProviderError('PROVIDER_CONFLICT');
  transaction(this.db,()=>{check();bindExistingSource(this.db,{documentId:row.document_id,connectionId:row.connection_id,reference,fingerprint:accepted.fingerprint,confirmedRevision:row.revision,confirmedDigest:doc.digest,confirmedSize:doc.size,now:Date.now()});this.db.prepare("UPDATE google_storage_exports SET state='confirmed',error_code=NULL WHERE document_id=?").run(row.document_id);});return 'uploaded';
 }catch(error){const code=error instanceof ProviderError?error.code:'PROVIDER_UNAVAILABLE';this.db.prepare('UPDATE google_storage_exports SET error_code=?,next_attempt_at=? WHERE document_id=?').run(code,Date.now()+60000,row.document_id);return 'deferred';}
 finally{clearInterval(heartbeat);clearTimeout(deadline);controller.abort();await Promise.all([drive?.close(),control?.close(),reader?.close()]);this.db.prepare("DELETE FROM worker_slots WHERE name='provider-source' AND token=?").run(slot);}
 }
}
