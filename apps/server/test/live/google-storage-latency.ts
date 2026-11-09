/** Isolated live diagnosis: production credentials read-only, disposable local DB,
 * one marked folder outside the mount; only that folder is trashed afterwards. */
import assert from 'node:assert/strict';
import Sqlite from 'better-sqlite3';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {historyFixture,bytes} from '../support/history-fixture.ts';
import {loadSecretCodec} from '../../src/providers/secret-key.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {ProviderConnections} from '../../src/providers/connections.ts';
import {GoogleAuthPool} from '../../src/providers/google-auth-pool.ts';
import {GoogleControlHttp} from '../../src/providers/google-control-http.ts';
import {GoogleStoragePush} from '../../src/providers/google-storage-push.ts';
const workspace=process.env.YOURWIKI_LIVE_CREDENTIAL_WORKSPACE;
if(!workspace||process.env.YOURWIKI_LIVE_CREATE_TEST_FOLDER!=='yes')throw Error('Isolated live test opt-in required');
const cleanup:(()=>unknown)[]=[],f=await historyFixture({after:(fn:()=>unknown)=>cleanup.push(fn)}),codec=await loadSecretCodec(join(workspace,'encryption.key')),secrets=new SecretConfigs(codec),input=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true});
let config:Record<string,unknown>;try{config=secrets.decrypt((input.prepare("SELECT encrypted_config FROM provider_connections WHERE provider='google' AND enabled=1 LIMIT 1").get() as any).encrypted_config);}finally{input.close();}
const observe:typeof fetch=async(url,init)=>{const start=performance.now(),res=await fetch(url,init),u=new URL(String(url));console.log(JSON.stringify({method:init?.method??'GET',operation:u.pathname.endsWith('generateIds')?'reserve':u.pathname.includes('upload')?'upload':u.pathname.includes('token')?'oauth':u.searchParams.get('alt')==='media'?'content':'metadata',status:res.status,ms:Math.round(performance.now()-start)}));return res;};
new ProviderConnections(f.db,secrets).create('admin',{id:'isolated',provider:'google',label:'Isolated latency',path:'/',folderId:null,config});
let pool=new GoogleAuthPool(f.db,secrets,{fetch:observe});const scope={check(){}},auth={access:(s:any)=>pool.access('isolated',1,s),invalidate:(token:string)=>pool.invalidate('isolated',1,token)},http=new GoogleControlHttp(auth,{fetch:observe});let folder:string|undefined;
try{
 const created=await http.call('POST','files',{fields:'id'},{name:'YourWiki isolated latency '+randomUUID(),mimeType:'application/vnd.google-apps.folder'}, {...scope,beforeDispatch:scope.check});folder=String(created.id);assert.notEqual(folder,config.root);
 f.db.prepare('UPDATE provider_connections SET encrypted_config=? WHERE id=?').run(secrets.encrypt({...config,root:folder,google_root_id:folder}),'isolated');await pool.close();pool=new GoogleAuthPool(f.db,secrets,{fetch:observe});
 f.db.prepare('INSERT INTO google_storage_mounts(connection_id,actor_id,group_id,connection_revision) VALUES(?,?,?,1)').run('isolated','admin','g');
 for(let sample=0;sample<6;sample++){
 const doc=await f.docs.create({userId:'admin',groupId:'g',parentId:null,title:'Latency.md',format:'md'},bytes('# Isolated latency test'));
 const push=new GoogleStoragePush(f.db,f.store,secrets,pool,{fetch:observe}),start=performance.now();
 for(let n=0;n<3;n++){const result=await push.runOnce();console.log(JSON.stringify({attempt:n+1,result,ms:Math.round(performance.now()-start),export:f.db.prepare('SELECT state,error_code FROM google_storage_exports WHERE document_id=?').get(doc.documentId)}));if(result==='uploaded')break;f.db.exec('UPDATE google_storage_exports SET next_attempt_at=0');}
 assert.equal((f.db.prepare('SELECT state FROM google_storage_exports WHERE document_id=?').get(doc.documentId) as any).state,'confirmed');
}
}finally{if(folder){await http.call('PATCH','files/'+folder,{fields:'trashed'},{trashed:true},{...scope,beforeDispatch:scope.check});console.log(JSON.stringify({isolatedFolderTrashed:true}));}await http.close();await pool.close();codec.close();for(const fn of cleanup.reverse())await fn();}
