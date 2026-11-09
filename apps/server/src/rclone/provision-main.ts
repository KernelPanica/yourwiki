/** Operator-only idempotent provisioning. Uses existing central Google authorization. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {openDatabase} from '../database.ts';
import {loadSecretCodec} from '../providers/secret-key.ts';
import {SecretConfigs} from '../providers/secret-config.ts';
import {GoogleAuthPool} from '../providers/google-auth-pool.ts';
import {GoogleControlHttp} from '../providers/google-control-http.ts';
import {ProviderConnections} from '../providers/connections.ts';
import {Administration} from '../administration/service.ts';
import {openLocalStorage} from '../providers/local-storage.ts';
import {BlobStore} from '../storage/blobs.ts';
import {DocumentService} from '../documents.ts';
import {bindExistingSource} from '../providers/source-bindings.ts';
const [workspace,testRoot,mode]=process.argv.slice(2);if(!workspace||!testRoot||!['init','verify'].includes(mode))throw Error('Explicit provisioning mode required');
const db=openDatabase(join(workspace,'database.sqlite3')),codec=await loadSecretCodec(join(workspace,'encryption.key')),configs=new SecretConfigs(codec),pool=new GoogleAuthPool(db,configs),admin=(db.prepare("SELECT id FROM users WHERE active=1 AND admin_role='giga' AND purged_at IS NULL ORDER BY username='admin' DESC,id LIMIT 1").get() as {id:string}).id;
let settings:any;const path=join(testRoot,'settings.json');try{settings=JSON.parse(await readFile(path,'utf8'));}catch{}
const source=settings?.sourceConnectionId??(db.prepare("SELECT c.id FROM provider_connections c JOIN google_storage_mounts s ON s.connection_id=c.id WHERE c.provider='google' AND c.enabled=1 ORDER BY c.id LIMIT 1").get() as {id:string}).id,revision=(db.prepare('SELECT revision FROM provider_connections WHERE id=?').get(source) as {revision:number}).revision,scope={check(){}},http=new GoogleControlHttp({access:s=>pool.access(source,revision,s),invalidate:token=>pool.invalidate(source,revision,token)});
try{
 if(mode==='init'){
  if(!settings){const remote=await http.call('POST','files',{fields:'id'},{name:'YourWiki rclone TEST',mimeType:'application/vnd.google-apps.folder',appProperties:{yourwikiRcloneTest:'true'}},{...scope,beforeDispatch:scope.check});settings={sourceConnectionId:source,remoteFolderId:remote.id,mountDir:join(testRoot,'drive'),cacheDir:join(testRoot,'cache'),runtimeDir:'/run/yourwiki-rclone-test',toolsDir:join(testRoot,'../mount-benchmark-tools'),localConnectionId:'rclone-test',folderId:null};await mkdir(testRoot,{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(settings,null,2),{mode:0o600});}
  if(!settings.folderId){const group=(db.prepare('SELECT group_id FROM memberships WHERE user_id=? ORDER BY group_id LIMIT 1').get(admin) as {group_id:string}).group_id;settings.folderId=new Administration(db).folder(admin,{name:'Google Drive — rclone (тест)',parentId:null,groupId:group}).id;await writeFile(path,JSON.stringify(settings,null,2),{mode:0o600});}
  if(!db.prepare('SELECT 1 FROM provider_connections WHERE id=?').get(settings.localConnectionId))new ProviderConnections(db,configs).create(admin,{id:settings.localConnectionId,provider:'local',label:'Google Drive через rclone (тест)',path:'/rclone-test',folderId:settings.folderId,config:{root:settings.mountDir,requireMount:true}});
  console.log(JSON.stringify({status:'configured',folderId:settings.folderId,connectionId:settings.localConnectionId}));
 }else{
  const storage=await openLocalStorage(settings.mountDir,{requireMount:true}),store=await BlobStore.open(join(workspace,'storage')),docs=new DocumentService(db,store),name='Rclone-test.md',initial=Buffer.from('# Google Drive через rclone\n\nТестовое хранилище. Этот файл можно редактировать в YourWiki.\n');
  try{
   if(!(await storage.list('',scope)).some(f=>f.name===name))await storage.create({operationId:randomUUID(),reference:name,target:{digest:createHash('sha256').update(initial).digest('hex'),size:initial.length},source:(async function*(){yield initial;})(),...scope});
   const before=await storage.read(name,scope),parts:Buffer[]=[];for await(const p of before.bytes)parts.push(Buffer.from(p));const data=Buffer.concat(parts),next=Buffer.concat([data,Buffer.from('\nПроверка записи через rclone выполнена.\n')]);
   const receipt=await storage.replace({operationId:randomUUID(),reference:name,baseline:before.fingerprint,target:{digest:createHash('sha256').update(next).digest('hex'),size:next.length},source:(async function*(){yield next;})(),...scope});
   let verified=false;for(let n=0;n<60;n++){const files=(await http.call('GET','files',{q:"'"+settings.remoteFolderId+"' in parents and trashed=false and name='"+name+"'",fields:'files(id,md5Checksum)',pageSize:'10'},undefined,scope)).files as {id:string;md5Checksum:string}[];if(files.length===1&&files[0].md5Checksum===createHash('md5').update(next).digest('hex')){verified=true;break;}await sleep(500);}if(!verified)throw Error('Remote bytes unconfirmed');
   let staleRejected=false;try{await storage.replace({operationId:randomUUID(),reference:name,baseline:before.fingerprint,target:{digest:receipt.digest,size:receipt.size},source:(async function*(){yield next;})(),...scope});}catch(e){staleRejected=(e as any).code==='PROVIDER_CONFLICT';}if(!staleRejected)throw Error('Stale save accepted');
   let document=(db.prepare('SELECT document_id FROM provider_source_bindings WHERE connection_id=? AND reference=?').get(settings.localConnectionId,name) as {document_id:string}|undefined)?.document_id;
   if(!document){const remote=await storage.read(name,scope),blob=await store.put(remote.bytes,{maxBytes:1048576}),result=docs.commitPreparedCreate({userId:admin,title:name,format:'md',parentId:settings.folderId},blob);document=result.documentId;bindExistingSource(db,{documentId:document,connectionId:settings.localConnectionId,reference:name,fingerprint:remote.fingerprint,confirmedRevision:1,confirmedDigest:blob.digest,confirmedSize:blob.size,now:Date.now()});}
   console.log(JSON.stringify({status:'verified',mountReadWrite:true,remoteChecksumConfirmed:true,staleSaveRejected:true,documentId:document,folderId:settings.folderId}));
  }finally{await storage.close();}
 }
}finally{await http.close();await pool.close();db.close();codec.close();}
