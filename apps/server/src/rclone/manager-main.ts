import {createHash} from 'node:crypto';
/** Starts each authorized Drive mount before application readiness. Watches OAuth changes. */
import {spawn,execFile} from 'node:child_process';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {openDatabase} from '../database.ts';
import {loadSecretCodec} from '../providers/secret-key.ts';
import {SecretConfigs} from '../providers/secret-config.ts';
import {assertRcloneMounted} from '../providers/rclone-mount-guard.ts';
const [workspace,settingsPath]=process.argv.slice(2);if(!workspace||!settingsPath||!isAbsolute(workspace))throw Error('Explicit workspace/settings required');
const settings=JSON.parse(await readFile(settingsPath,'utf8')) as {toolsDir:string;runtimeDir:string;dataDir:string};
if(!Object.values(settings).every(isAbsolute))throw Error('Absolute rclone paths required');
const db=openDatabase(join(workspace,'database.sqlite3')),codec=await loadSecretCodec(join(workspace,'encryption.key')),secrets=new SecretConfigs(codec),controller=new AbortController(),children=new Map<string,ReturnType<typeof spawn>>();
for(const name of ['SIGTERM','SIGINT'] as const)process.once(name,()=>controller.abort());
const notify=async()=>{await writeFile(join(settings.runtimeDir,'ready'),'ready\n',{mode:0o600});if(process.env.NOTIFY_SOCKET)await new Promise<void>((resolve,reject)=>execFile('systemd-notify',['--ready','--status=Authorized Google Drive mounts ready'],error=>error?reject(error):resolve()));};let ready=false;
try{while(!controller.signal.aborted){const rows=db.prepare("SELECT id,revision,encrypted_config FROM provider_connections WHERE provider='google' AND enabled=1").all() as {id:string;revision:number;encrypted_config:string}[],wanted=new Set<string>();let mounted=true;
 for(const row of rows){if(!/^[\w-]{1,128}$/.test(row.id))throw Error('Invalid connection ID');const c=secrets.decrypt(row.encrypted_config);if(!c.refresh_token||!c.client_id||!c.client_secret||typeof c.root!=='string')continue;wanted.add(row.id);const data=join(settings.dataDir,row.id),runtime=join(settings.runtimeDir,row.id),mount=join(data,'drive');await mkdir(data,{recursive:true,mode:0o700});await mkdir(runtime,{recursive:true,mode:0o700});
 db.prepare('INSERT INTO rclone_drive_mounts(connection_id,binary_path,config_path,mount_path,staging_path) VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET binary_path=excluded.binary_path,config_path=excluded.config_path,mount_path=excluded.mount_path,staging_path=excluded.staging_path WHERE rclone_drive_mounts.binary_path<>excluded.binary_path OR rclone_drive_mounts.config_path<>excluded.config_path OR rclone_drive_mounts.mount_path<>excluded.mount_path OR rclone_drive_mounts.staging_path<>excluded.staging_path').run(row.id,join(settings.toolsDir,'rclone'),join(runtime,'rclone.conf'),mount,join(data,'staging'));
 let child=children.get(row.id);if(!child||child.exitCode!==null||child.signalCode!==null){const path=join(runtime,'settings.json');await writeFile(path,JSON.stringify({sourceConnectionId:row.id,remoteFolderId:c.root,mountDir:mount,cacheDir:join(data,'cache'),runtimeDir:runtime,toolsDir:settings.toolsDir,remoteName:'drive'}),{mode:0o600});const env={...process.env};delete env.NOTIFY_SOCKET;child=spawn(process.execPath,[fileURLToPath(new URL('./mount-main.ts',import.meta.url)),workspace,path],{env,stdio:['ignore','inherit','inherit']});children.set(row.id,child);}
 try{if((await readFile(join(runtime,'mounted'),'utf8'))!==assertRcloneMounted(mount))mounted=false;}catch{mounted=false;}
 // A rotated rclone refresh token survives reboot, but cannot replace a newer OAuth authorization.
 try{const key=createHash('sha256').update(JSON.stringify([row.revision,c.refresh_token,c.client_id,c.client_secret,c.google_account_id])).digest('hex');if((await readFile(join(runtime,'authorization'),'utf8'))===key){const conf=await readFile(join(runtime,'rclone.conf'),'utf8'),raw=conf.split('\n').find(line=>line.startsWith('token = '));const token=raw?JSON.parse(raw.slice(8)):null;if(typeof token?.refresh_token==='string'&&token.refresh_token&&token.refresh_token!==c.refresh_token&&!/[\x00-\x20\x7f]/.test(token.refresh_token)&&token.refresh_token.length<=65536)db.prepare('UPDATE provider_connections SET encrypted_config=? WHERE id=? AND revision=? AND encrypted_config=?').run(secrets.encrypt({...c,refresh_token:token.refresh_token}),row.id,row.revision,row.encrypted_config);}}catch{/* Missing runtime proof or an authorization in transition never overwrites the account. */}

 }
 for(const [id,child] of children)if(!wanted.has(id)){child.kill('SIGTERM');children.delete(id);}
 if(!mounted){await rm(join(settings.runtimeDir,'ready'),{force:true});ready=false;}if(mounted&&!ready){await notify();ready=true;}try{await sleep(1000,undefined,{signal:controller.signal});}catch{}
 }}finally{for(const child of children.values())child.kill('SIGTERM');await Promise.all([...children.values()].map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve))));await rm(join(settings.runtimeDir,'ready'),{force:true});db.close();codec.close();}
