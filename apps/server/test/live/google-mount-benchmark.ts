/** Opt-in storage prototype benchmark. No production DB writes or mount changes. */
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import Sqlite from 'better-sqlite3';
import {historyFixture,bytes} from '../support/history-fixture.ts';
import {loadSecretCodec} from '../../src/providers/secret-key.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {ProviderConnections} from '../../src/providers/connections.ts';
import {GoogleAuthPool} from '../../src/providers/google-auth-pool.ts';
import {GoogleControlHttp} from '../../src/providers/google-control-http.ts';
import {GoogleStoragePush} from '../../src/providers/google-storage-push.ts';
const workspace=process.env.YOURWIKI_LIVE_CREDENTIAL_WORKSPACE,tools=process.env.YOURWIKI_RCLONE_TOOLS;
if(!workspace||!tools||process.env.YOURWIKI_LIVE_CREATE_TEST_FOLDER!=='yes')throw Error('Explicit isolated benchmark opt-in required');
const execute=promisify(execFile),cleanup:(()=>unknown)[]=[],f=await historyFixture({after:(fn:()=>unknown)=>cleanup.push(fn)}),codec=await loadSecretCodec(join(workspace,'encryption.key')),secrets=new SecretConfigs(codec),input=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true}),privateDir=await mkdtemp(join(tools,'run-'));
let config:Record<string,unknown>;try{const row=input.prepare("SELECT encrypted_config FROM provider_connections WHERE provider='google' AND enabled=1 LIMIT 1").get() as {encrypted_config:string};config=secrets.decrypt(row.encrypted_config);}finally{input.close();}
new ProviderConnections(f.db,secrets).create('admin',{id:'isolated',provider:'google',label:'Isolated mount benchmark',path:'/',folderId:null,config});
let pool=new GoogleAuthPool(f.db,secrets);const scope={check(){}},auth={access:(s:any)=>pool.access('isolated',1,s),invalidate:(token:string)=>pool.invalidate('isolated',1,token)},http=new GoogleControlHttp(auth),mount=join(privateDir,'mount'),rclone=join(tools,'rclone'),fuse=join(tools,'fuse/usr/bin/fusermount3'),results:Record<string,unknown>[]=[];
let folder:string|undefined,child:ReturnType<typeof spawn>|undefined,memoryTimer:ReturnType<typeof setInterval>|undefined,peakRssKiB=0,cpuTicks=0,mounted=false,requests=0;
const digest=(data:Uint8Array,algorithm='sha256')=>createHash(algorithm).update(data).digest('hex');
const safeLog=(value:Record<string,unknown>)=>console.log(JSON.stringify(value));
async function request(path:string,init:RequestInit={}){requests++;const res=await fetch('https://www.googleapis.com/'+path,{...init,signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+await auth.access(scope),...init.headers}});if(!res.ok){void res.body?.cancel();throw Error('BENCHMARK_HTTP_'+res.status);}return res;}
async function find(name:string){return (await http.call('GET','files',{q:"'"+folder+"' in parents and trashed=false and name='"+name+"'",fields:'files(id,size,md5Checksum)',pageSize:'10'},undefined,scope)).files as {id:string;size:string;md5Checksum:string}[];}
async function confirmed(name:string,data:Buffer,deadline=60000){const started=performance.now();let polls=0;while(performance.now()-started<deadline){polls++;const matches=await find(name);assert(matches.length<=1,'Duplicate benchmark file');const file=matches[0];if(file&&Number(file.size)===data.length&&file.md5Checksum===digest(data,'md5')){const res=await request('drive/v3/files/'+file.id+'?alt=media');assert.equal(digest(new Uint8Array(await res.arrayBuffer())),digest(data));return {id:file.id,polls};}await sleep(250);}throw Error('REMOTE_CONFIRM_TIMEOUT');}
async function createRemote(name:string,data:Buffer){const boundary='yw_'+randomUUID(),body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({name,mimeType:'application/octet-stream',parents:[folder]})+'\r\n--'+boundary+'\r\nContent-Type: application/octet-stream\r\n\r\n'),data,Buffer.from('\r\n--'+boundary+'--\r\n')]);return (await(await request('upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'content-type':'multipart/related; boundary='+boundary},body})).json() as {id:string}).id;}
async function sampleMemory(){if(!child?.pid)return;try{const status=await readFile('/proc/'+child.pid+'/status','utf8'),stat=await readFile('/proc/'+child.pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');peakRssKiB=Math.max(peakRssKiB,Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0));cpuTicks=Number(fields[11])+Number(fields[12]);}catch{}}
try{
 const version=(await execute(rclone,['version'])).stdout.split('\n')[0];
 const root=await http.call('POST','files',{fields:'id'},{name:'YourWiki isolated mount benchmark '+randomUUID(),mimeType:'application/vnd.google-apps.folder',appProperties:{yourwikiMountBenchmark:'true'}},{...scope,beforeDispatch:scope.check});folder=String(root.id);assert.notEqual(folder,config.root);
 f.db.prepare('UPDATE provider_connections SET encrypted_config=? WHERE id=?').run(secrets.encrypt({...config,root:folder,google_root_id:folder}),'isolated');await pool.close();pool=new GoogleAuthPool(f.db,secrets);f.db.prepare('INSERT INTO google_storage_mounts(connection_id,actor_id,group_id,connection_revision) VALUES(?,?,?,1)').run('isolated','admin','g');
 // Access token only: rclone cannot rotate or persist production refresh credentials.
 const token={access_token:await auth.access(scope),token_type:'Bearer',expiry:new Date(Date.now()+25*60000).toISOString()};await writeFile(join(privateDir,'rclone.conf'),'[bench]\ntype = drive\nroot_folder_id = '+folder+'\ntoken = '+JSON.stringify(token)+'\n',{mode:0o600});await mkdir(mount,{mode:0o700});
 const options=['mount','bench:',mount,'--config',join(privateDir,'rclone.conf'),'--cache-dir',join(privateDir,'cache'),'--vfs-cache-mode','full','--vfs-cache-max-size','128M','--buffer-size','4M','--vfs-write-back','0s','--poll-interval','2s','--dir-cache-time','1m','--attr-timeout','1s','--transfers','2','--log-level','ERROR','--log-file',join(privateDir,'rclone.log')];
 child=spawn(rclone,options,{stdio:'ignore',env:{...process.env,PATH:join(tools,'fuse/usr/bin')+':'+process.env.PATH}});for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error('MOUNT_START_FAILED');if((await readFile('/proc/self/mountinfo','utf8')).includes(' '+mount+' ')){mounted=true;break;}await sleep(100);}assert(mounted,'FUSE mount not ready');memoryTimer=setInterval(()=>void sampleMemory(),500);
 safeLog({phase:'started',version,vfsCache:'full',writeBackSeconds:0,pollSeconds:2,payloadsKiB:[64,8192],repetitions:3});
 const push=new GoogleStoragePush(f.db,f.store,secrets,pool);
 for(const size of [64*1024,8*1024*1024])for(let repeat=0;repeat<3;repeat++)for(const method of repeat%2?['mount','current']:['current','mount']){
  const data=randomBytes(size),name=method+'-'+size+'-'+repeat+'.bin',start=performance.now();let localMs:number;
  if(method==='current'){const doc=await f.docs.create({userId:'admin',groupId:'g',parentId:null,title:name,format:'bin'},bytes(data));localMs=performance.now()-start;let result=await push.runOnce();for(let retry=0;result!=='uploaded'&&retry<2;retry++){f.db.prepare('UPDATE google_storage_exports SET next_attempt_at=0 WHERE document_id=?').run(doc.documentId);result=await push.runOnce();}assert.equal(result,'uploaded');}
  else{const handle=await open(join(mount,name),'w');try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}localMs=performance.now()-start;}
  const receipt=await confirmed(name,data),row={phase:'write',method,bytes:size,repeat,localMs:Math.round(localMs),confirmedMs:Math.round(performance.now()-start),confirmationPolls:receipt.polls};results.push(row);safeLog(row);
 }
 // Cold file created through Drive API, never written into the VFS cache.
 const readData=randomBytes(8*1024*1024),readName='cold-read.bin';await createRemote(readName,readData);
 let visible=false;for(let n=0;n<150;n++){try{await readFile(join(mount,readName));visible=true;break;}catch{await sleep(200);}}assert(visible,'External new file not discovered');
 // The discovery read above warmed the file. Use a second fresh file for cold read,
 // waiting for directory discovery with readdir rather than reading its content.
 const coldName='cold-read-measured.bin';await createRemote(coldName,readData);const {readdir}=await import('node:fs/promises');for(let n=0;n<150;n++){if((await readdir(mount)).includes(coldName))break;await sleep(200);}
 for(const cache of ['cold','warm','warm']){const start=performance.now(),data=await readFile(join(mount,coldName));assert.equal(digest(data),digest(readData));const row={phase:'read',method:'mount',cache,bytes:data.length,ms:Math.round(performance.now()-start)};results.push(row);safeLog(row);}
 const externalName='external-change.bin',original=Buffer.from('before external update'),externalId=await createRemote(externalName,original);for(let n=0;n<150;n++){try{assert.equal((await readFile(join(mount,externalName))).toString(),original.toString());break;}catch{await sleep(200);}}
 for(let repeat=0;repeat<3;repeat++){const changed=Buffer.from('external version '+repeat+' '+randomUUID()),start=performance.now();await request('upload/drive/v3/files/'+externalId+'?uploadType=media&fields=id',{method:'PATCH',headers:{'content-type':'application/octet-stream'},body:changed});const remoteSavedMs=performance.now()-start;let detected=false;for(let n=0;n<150;n++){if((await readFile(join(mount,externalName))).equals(changed)){detected=true;break;}await sleep(200);}assert(detected,'External update not detected within30sec');const row={phase:'external',repeat,remoteSavedMs:Math.round(remoteSavedMs),detectedMs:Math.round(performance.now()-start),afterRemoteMs:Math.round(performance.now()-start-remoteSavedMs)};results.push(row);safeLog(row);}
 await sampleMemory();const ticks=Number((await execute('getconf',['CLK_TCK'])).stdout.trim());safeLog({phase:'summary',peakRssMiB:Math.round(peakRssKiB/1024*10)/10,cpuSeconds:Math.round(cpuTicks/ticks*100)/100,independentContentRequests:requests,results});
} catch(error){safeLog({phase:'failed',error:error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'BENCHMARK_FAILED'});process.exitCode=1;}
finally{
 clearInterval(memoryTimer);if(mounted){try{await execute(fuse,['-u',mount],{timeout:10000});mounted=false;}catch{safeLog({phase:'cleanup',unmountFailed:true});process.exitCode=1;}}
 if(child){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child!.once('exit',resolve)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 if(folder){try{await http.call('PATCH','files/'+folder,{fields:'trashed'},{trashed:true},{...scope,beforeDispatch:scope.check});safeLog({phase:'cleanup',isolatedFolderTrashed:true});}catch{safeLog({phase:'cleanup',remoteCleanupFailed:true});process.exitCode=1;}}
 await http.close();await pool.close();codec.close();for(const fn of cleanup.reverse())await fn();if(!mounted){await rm(privateDir,{recursive:true,force:true});safeLog({phase:'cleanup',privateCredentialsRemoved:true});}
}
