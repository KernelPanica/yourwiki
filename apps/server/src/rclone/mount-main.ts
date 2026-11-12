/** Dedicated test mount supervisor. No OAuth credentials in argv, logs or HTTP. */
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import Sqlite from 'better-sqlite3';
import {loadSecretCodec} from '../providers/secret-key.ts';
import {SecretConfigs} from '../providers/secret-config.ts';
import {redactRcloneFailure,rcloneFailureTail} from './failure-detail.ts';
import {assertRcloneMounted} from '../providers/rclone-mount-guard.ts';
const [workspace,settingsPath]=process.argv.slice(2);if(!workspace||!settingsPath)throw Error('Explicit workspace/settings required');
const settings=JSON.parse(await readFile(settingsPath,'utf8')) as {sourceConnectionId:string;remoteFolderId:string;mountDir:string;toolsDir:string;cacheDir:string;runtimeDir:string;remoteName?:string};
const codec=await loadSecretCodec(join(workspace,'encryption.key')),secrets=new SecretConfigs(codec),db=new Sqlite(join(workspace,'database.sqlite3'),{readonly:true}),run=promisify(execFile),controller=new AbortController(),signal=controller.signal;
let child:ReturnType<typeof spawn>|undefined,mounted=false,ready=false;
const notify=async(status:string)=>{if(process.env.NOTIFY_SOCKET)try{await run('systemd-notify',[...(ready?[]:['--ready']),'--status='+status]);}catch{}ready=true;};
const state=(name:string)=>console.info(JSON.stringify({rcloneTest:name}));
function context(){const row=db.prepare("SELECT revision,enabled,encrypted_config FROM provider_connections WHERE id=? AND provider='google'").get(settings.sourceConnectionId) as {revision:number;enabled:number;encrypted_config:string}|undefined;if(!row?.enabled)return null;const config=secrets.decrypt(row.encrypted_config);if(!config.refresh_token||!config.client_id||!config.client_secret)return null;return {config,key:createHash('sha256').update(JSON.stringify([row.revision,config.refresh_token,config.client_id,config.client_secret,config.google_account_id])).digest('hex')};}
async function stopMount(){await rm(join(settings.runtimeDir,'mounted'),{force:true});await rm(join(settings.runtimeDir,'authorization'),{force:true});if(mounted){try{await run(join(settings.toolsDir,'fuse/usr/bin/fusermount3'),['-u',settings.mountDir],{timeout:15000});mounted=false;}catch{try{assertRcloneMounted(settings.mountDir);throw Error('UNMOUNT_FAILED');}catch(error){if(error instanceof Error&&error.message==='UNMOUNT_FAILED')throw error;mounted=false;}}}if(child){const old=child;child=undefined;old.kill('SIGTERM');if(old.exitCode===null&&old.signalCode===null)await Promise.race([new Promise(resolve=>old.once('exit',resolve)),sleep(3000)]);if(old.exitCode===null&&old.signalCode===null)old.kill('SIGKILL');}await rm(join(settings.runtimeDir,'rclone.conf'),{force:true});await rm(join(settings.runtimeDir,'control.sock'),{force:true});}
for(const name of ['SIGTERM','SIGINT'] as const)process.once(name,()=>controller.abort());
try{
 // A killed container can leave its propagated FUSE mount disconnected.
 // Inspect mountinfo without touching the dead filesystem, then detach only rclone.
 let orphan=false;try{assertRcloneMounted(settings.mountDir);orphan=true;}catch{}
 if(orphan)await run(join(settings.toolsDir,'fuse/usr/bin/fusermount3'),['-uz',settings.mountDir],{timeout:15000});
 await mkdir(settings.mountDir,{recursive:true,mode:0o700});await mkdir(settings.cacheDir,{recursive:true,mode:0o700});await mkdir(settings.runtimeDir,{recursive:true,mode:0o700});await chmod(settings.runtimeDir,0o700);
 while(!signal.aborted){const current=context();if(!current){state('waiting_google_authorization');await notify('Waiting for Google authorization');try{await sleep(5000,undefined,{signal});}catch{}continue;}
  const c=current.config,token={access_token:'refresh-required',refresh_token:c.refresh_token,token_type:'Bearer',expiry:'2000-01-01T00:00:00Z'},conf='['+(settings.remoteName??'test')+']\ntype = drive\nroot_folder_id = '+settings.remoteFolderId+'\nclient_id = '+String(c.client_id)+'\nclient_secret = '+String(c.client_secret)+'\ntoken = '+JSON.stringify(token)+'\n';
  await writeFile(join(settings.runtimeDir,'rclone.conf'),conf,{mode:0o600});
  const childEnv:NodeJS.ProcessEnv={...process.env,PATH:join(settings.toolsDir,'fuse/usr/bin')+':'+process.env.PATH};delete childEnv.NOTIFY_SOCKET;
  let stderr='',spawnError:string|undefined;
  child=spawn(join(settings.toolsDir,'rclone'),['mount',(settings.remoteName??'test')+':',settings.mountDir,...settings.remoteName==='drive'?['--rc','--rc-no-auth','--rc-addr','unix://'+join(settings.runtimeDir,'control.sock')]:[],'--config',join(settings.runtimeDir,'rclone.conf'),'--cache-dir',settings.cacheDir,'--vfs-cache-mode','full','--vfs-cache-max-size','256M','--vfs-write-back','0s','--poll-interval','2s','--dir-cache-time','1m','--attr-timeout',settings.remoteName==='drive'?'0s':'1s','--buffer-size','4M','--transfers','2','--log-level','ERROR','--log-file',join(settings.runtimeDir,'rclone.log')],{stdio:['ignore','ignore','pipe'],env:childEnv});
  child.stderr?.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-8192);});child.once('error',(error:NodeJS.ErrnoException)=>{spawnError=/^[A-Z_]+$/.test(error.code??'')?error.code:'SPAWN_FAILED';});
  try{
   for(let i=0;i<600&&!signal.aborted;i++){if(spawnError||child.exitCode!==null||child.signalCode!==null)throw Error('MOUNT_FAILED');try{assertRcloneMounted(settings.mountDir);mounted=true;break;}catch{}await sleep(100,undefined,{signal});}
   if(!mounted)throw Error('MOUNT_TIMEOUT');const {readdir}=await import('node:fs/promises');await readdir(settings.mountDir);await writeFile(join(settings.runtimeDir,'authorization'),current.key,{mode:0o600});await writeFile(join(settings.runtimeDir,'mounted'),assertRcloneMounted(settings.mountDir),{mode:0o600});state('mounted');await notify('Google Drive test folder mounted');
   while(!signal.aborted){await sleep(2000,undefined,{signal});if(spawnError||child.exitCode!==null||child.signalCode!==null)throw Error('MOUNT_EXITED');assertRcloneMounted(settings.mountDir);if(context()?.key!==current.key){state('authorization_changed');break;}}
  }catch(error){if(!signal.aborted){state('retrying_mount');console.info(JSON.stringify({mountStageError:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'MOUNT_READ_FAILED',code:(error as NodeJS.ErrnoException)?.code??null,syscall:(error as NodeJS.ErrnoException)?.syscall??null,exitCode:child?.exitCode??null,signal:child?.signalCode??null,spawnError:spawnError??null,detail:redactRcloneFailure(stderr,Object.values(c)),logDetail:await rcloneFailureTail(join(settings.runtimeDir,'rclone.log'),Object.values(c))}));}}finally{await stopMount();}
  if(!signal.aborted)try{await sleep(3000,undefined,{signal});}catch{}
 }
}finally{await stopMount();db.close();codec.close();}
