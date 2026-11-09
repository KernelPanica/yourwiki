/** Opt-in real Google check. All file mutations occur in one new marked folder
 * outside the production mount. Production DB is read-only; test DB is disposable. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import Sqlite from 'better-sqlite3';
import {historyFixture,bytes} from '../support/history-fixture.ts';
import {loadSecretCodec} from '../../src/providers/secret-key.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {ProviderConnections} from '../../src/providers/connections.ts';
import {GoogleAuthPool} from '../../src/providers/google-auth-pool.ts';
import {GoogleControlHttp} from '../../src/providers/google-control-http.ts';
import {CredentialVault} from '../../src/providers/credential-vault.ts';
import {createProviderResolvers} from '../../src/providers/provider-resolvers.ts';
import {DeliveryWorker} from '../../src/providers/delivery-worker.ts';
import {IngressWorker} from '../../src/providers/ingress-worker.ts';
import {JobQueue} from '../../src/jobs.ts';
import {OfficeSessions} from '../../src/office/sessions.ts';
import {OfficeIngress} from '../../src/office/ingress.ts';
import {OfficeSaves} from '../../src/office/saves.ts';
import {blankOfficeSource} from '../../src/office/blank.ts';
const workspace=process.env.YOURWIKI_LIVE_CREDENTIAL_WORKSPACE;
if(!workspace||process.env.YOURWIKI_LIVE_CREATE_TEST_FOLDER!=='yes')throw new Error('Explicit isolated Google test opt-in required');
const cleanup:(()=>unknown|Promise<unknown>)[]=[],f=await historyFixture({after:(fn:()=>unknown)=>cleanup.push(fn)}),run=randomUUID(),scope={check(){}},writeScope={...scope,beforeDispatch:scope.check};
let phase='initialization';
let codec:Awaited<ReturnType<typeof loadSecretCodec>>|undefined,pool:GoogleAuthPool|undefined,http:GoogleControlHttp|undefined,vault:CredentialVault|undefined,folder:string|undefined;
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function zipComment(original:Buffer,text:string){const result=Buffer.from(original);assert.equal(result.readUInt32LE(result.length-22),0x06054b50);const comment=Buffer.from(text);result.writeUInt16LE(comment.length,result.length-2);return Buffer.concat([result,comment]);}
try{
 codec=await loadSecretCodec(join(workspace,'encryption.key'));const configs=new SecretConfigs(codec),input=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true,fileMustExist:true});let config:Record<string,unknown>;
 try{const row=input.prepare("SELECT encrypted_config FROM provider_connections WHERE provider='google' AND enabled=1 LIMIT 1").get() as {encrypted_config:string}|undefined;assert(row);config=configs.decrypt(row.encrypted_config);}finally{input.close();}
 new ProviderConnections(f.db,configs).create('admin',{id:'isolated',provider:'google',label:'Test bootstrap',path:'/',folderId:null,config});pool=new GoogleAuthPool(f.db,configs);
 const auth={access:(s:any)=>pool!.access('isolated',1,s),invalidate:(token:string)=>pool!.invalidate('isolated',1,token)};http=new GoogleControlHttp(auth);
 if(process.env.YOURWIKI_LIVE_CLEANUP_OWN_CHECKS==='yes'){
  const old=await http.call('GET','files',{q:"'me' in owners and trashed = false and name contains 'YourWiki isolated office verification '",fields:'files(id,name,mimeType,parents,createdTime,appProperties)',pageSize:'100'},undefined,scope);
  for(const file of (old.files??[]) as any[]){const marker=file.appProperties?.yourwikiAcceptanceRun;if(typeof marker==='string'&&/^[a-f0-9-]{36}$/.test(marker)&&file.name==='YourWiki isolated office verification '+marker&&file.mimeType==='application/vnd.google-apps.folder'&&Array.isArray(file.parents)&&!file.parents.includes(config.root)&&Date.parse(file.createdTime)>Date.now()-2*60*60*1000){await http.call('PATCH','files/'+file.id,{fields:'trashed'},{trashed:true},writeScope);console.log(JSON.stringify({olderOwnTestFolderTrashed:true}));}}
 }
 phase='create isolated folder';const created=await http.call('POST','files',{fields:'id'},{name:'YourWiki isolated office verification '+run,mimeType:'application/vnd.google-apps.folder',appProperties:{yourwikiAcceptanceRun:run}},writeScope);folder=String(created.id);assert.notEqual(folder,config.root);
 f.db.prepare('UPDATE provider_connections SET encrypted_config=? WHERE id=?').run(configs.encrypt({...config,root:folder}),'isolated');await pool.close();pool=new GoogleAuthPool(f.db,configs);
 await pool.access('isolated',1,scope);vault=new CredentialVault(f.db,configs,{authPool:pool});let puts=0;const observedFetch:typeof fetch=async(url,init)=>{const response=await fetch(url,init);if(init?.method==='PUT'){puts++;console.log(JSON.stringify({conditionalUploadStatus:response.status}));}return response;};const resolvers=createProviderResolvers(vault,{google:{fetch:observedFetch}}),worker=new DeliveryWorker(f.db,f.store,vault,resolvers.outgoing),incoming=new IngressWorker(f.db,f.store,vault,resolvers.incoming);
 for(const [format,mime] of [['docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],['xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],['pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation']]){
  phase=format+': create isolated file';const original=await blankOfficeSource(format),boundary='yw_'+randomUUID(),body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({name:'isolated.'+format,mimeType:mime,parents:[folder]})+'\r\n--'+boundary+'\r\nContent-Type: '+mime+'\r\n\r\n'),original,Buffer.from('\r\n--'+boundary+'--\r\n')]);
  const response=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+await auth.access(scope),'content-type':'multipart/related; boundary='+boundary},body});assert.equal(response.status,200);const reference=String((await response.json()).id);
  const doc=await f.docs.create({userId:'writer',groupId:'g',parentId:null,title:'Isolated '+format,format},bytes(original));await f.publish();
  f.db.prepare('INSERT INTO provider_source_bindings(document_id,connection_id,reference,fingerprint,confirmed_revision,created_at) VALUES(?,?,?,?,1,?)').run(doc.documentId,'isolated',reference,'initial',Date.now());f.db.prepare('UPDATE documents SET provider_revision=1 WHERE id=?').run(doc.documentId);
  phase=format+': read baseline';const connection=vault.forBinding({documentId:doc.documentId,connectionId:'isolated',connectionRevision:1,bindingGeneration:1}),reader=await resolvers.incoming(connection);let baseline:string;try{for(let attempt=0;;attempt++){try{const remote=await reader.read(reference,scope);for await(const _ of remote.bytes){}baseline=remote.fingerprint;break;}catch(error){if((error as any)?.code!=='PROVIDER_CONFLICT'||attempt>=4)throw error;await delay(250*(attempt+1));}}}finally{await reader.close();}f.db.prepare('UPDATE provider_source_bindings SET fingerprint=? WHERE document_id=?').run(baseline,doc.documentId);
  phase=format+': open Office';const office=new OfficeSessions(f.db),opened=office.open(f.sessions.writer.token,doc.documentId);office.lock(opened.sessionId,opened.token,'LOCK','isolated');
  const next=zipComment(original,'YourWiki verified local save '+run),saves=new OfficeSaves(f.db,f.store,new OfficeIngress(f.db,f.store)),version=f.db.prepare('SELECT created_at FROM document_versions WHERE document_id=? AND revision=1').get(doc.documentId) as {created_at:number};
  phase=format+': local save';const localAt=performance.now(),saved=await saves.save({sessionId:opened.sessionId,token:opened.token,lock:'isolated',declaredSize:next.length,lastModifiedTime:new Date(version.created_at).toISOString()},bytes(next)),localMs=performance.now()-localAt;assert.equal(saved.receipt?.revision,2);
  phase=format+': delivery';const deliveryAt=performance.now(),putsBefore=puts;let delivered=await worker.runOnce();for(let retry=0;delivered==='unknown'||delivered==='idle';retry++){if(retry>=5)break;await delay(1250);delivered=await worker.runOnce();}const googleMs=performance.now()-deliveryAt;assert.equal(puts-putsBefore,1,'An uncertain write is only read back, never replayed');assert.equal(delivered,'confirmed',JSON.stringify(f.db.prepare('SELECT state,error_code FROM provider_delivery_attempts').all()));
  console.log(JSON.stringify({format,localSaveMs:Math.round(localMs),googleDeliveryAndReadbackMs:Math.round(googleMs),googleConditionalWrite:true,byteConfirmed:true,uploadRequests:puts-putsBefore}));const external=zipComment(original,'External Drive update '+run);
  // Simulate an external editor on our disposable file, never a production ID.
  phase=format+': external update';const v2=await fetch('https://www.googleapis.com/drive/v2/files/'+reference+'?fields=etag',{headers:{authorization:'Bearer '+await auth.access(scope)}});assert.equal(v2.status,200);const etag=(await v2.json()).etag;
  const update=await fetch('https://www.googleapis.com/upload/drive/v2/files/'+reference+'?uploadType=media',{method:'PUT',headers:{authorization:'Bearer '+await auth.access(scope),'content-type':mime,'if-match':etag},body:external});assert.equal(update.status,200);await update.body?.cancel();
  phase=format+': incoming';let applied='idle';for(let attempt=0;attempt<8;attempt++){new JobQueue(f.db).enqueue({kind:'provider.pull',key:'isolated:'+doc.documentId+':'+attempt,payload:{documentId:doc.documentId}});applied=await incoming.runOnce();if(applied==='applied')break;await delay(750);}assert.equal(applied,'applied',JSON.stringify(f.db.prepare('SELECT state,error_code FROM provider_ingress_snapshots WHERE document_id=?').all(doc.documentId)));
  const current=f.db.prepare('SELECT v.digest,d.local_revision,d.provider_revision FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(doc.documentId) as any;assert.equal(current.digest,digest(external));assert.equal(current.local_revision,current.provider_revision);assert.equal((f.db.prepare('SELECT superseded FROM office_sessions WHERE id=?').get(opened.sessionId) as any).superseded,1);assert(f.db.prepare('SELECT 1 FROM document_versions WHERE document_id=? AND digest=?').get(doc.documentId,digest(next)));
  console.log(JSON.stringify({format,localSaveMs:Math.round(localMs),googleDeliveryAndReadbackMs:Math.round(googleMs),googleConditionalWrite:true,byteConfirmed:true,drivePriorityWhileOfficeOpen:true,localVersionRetained:true}));
 }
}catch(error){console.error(JSON.stringify({phase,failed:error instanceof Error?error.message:'failed'}));process.exitCode=1;}finally{
 await vault?.close();try{if(folder&&http){const own=await http.call('GET','files/'+folder,{fields:'appProperties'},undefined,scope);if((own.appProperties as any)?.yourwikiAcceptanceRun===run){await http.call('PATCH','files/'+folder,{fields:'trashed'},{trashed:true},writeScope);console.log(JSON.stringify({isolatedTestFolderTrashed:true,productionFilesUntouched:true}));}}}finally{await http?.close();await pool?.close();for(const fn of cleanup.reverse())await fn();codec?.close();}
}
