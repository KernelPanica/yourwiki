#!/bin/sh
# Read-only Drive transport diagnostics; never print config, tokens or raw rclone logs.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
docker compose ps
docker compose exec -T web node --input-type=module <<'JS'
import {access,readFile,open,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,join} from 'node:path';
import Sqlite from '/app/apps/server/node_modules/better-sqlite3/lib/index.js';
import {assertRcloneMounted} from '/app/apps/server/src/providers/rclone-mount-guard.ts';
import {loadSecretCodec} from '/app/apps/server/src/providers/secret-key.ts';
import {SecretConfigs} from '/app/apps/server/src/providers/secret-config.ts';
const root=join(process.env.YOURWIKI_DATA??'/data','workspace'),db=new Sqlite(join(root,'database.sqlite3'),{readonly:true}),codec=await loadSecretCodec(join(root,'encryption.key')),secrets=new SecretConfigs(codec),run=promisify(execFile);
const safeCode=error=>typeof error?.code==='string'&&/^[A-Z_0-9]{1,48}$/.test(error.code)?error.code:'CHECK_FAILED';
const exists=async(path,mode)=>{try{await access(path,mode);return true;}catch{return false;}};
function redact(text,secrets){let result=String(text);for(const secret of secrets.filter(value=>typeof value==='string'&&value.length).sort((a,b)=>b.length-a.length))result=result.split(secret).join('[REDACTED]');return result.replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/((?:access_token|refresh_token|client_secret|client_id|code|token)"?\s*[:=]\s*"?)[^\s"&,}]+/gi,'$1[REDACTED]').slice(-4096);}
const reason=text=>['invalid_grant','invalid_client','accessNotConfigured','SERVICE_DISABLED','insufficientPermissions','permissionDenied','rateLimitExceeded','userRateLimitExceeded','permission denied','Permission denied','no such file','No such file','Transport endpoint is not connected','Operation not permitted','failed to read config','config file not found'].find(value=>text.includes(value))??'UNCLASSIFIED';
try{
 console.log(JSON.stringify({transport:process.env.YOURWIKI_DRIVE_TRANSPORT??'unset'}));
 const rows=db.prepare("SELECT c.id,c.enabled,c.encrypted_config,m.binary_path,m.config_path,m.mount_path,m.error_code FROM provider_connections c LEFT JOIN rclone_drive_mounts m ON m.connection_id=c.id WHERE c.provider='google'").all();
 for(let index=0;index<rows.length;index++){
  const row=rows[index],result={connection:index+1,enabled:!!row.enabled};let config={},privateDir;
  try{config=secrets.decrypt(row.encrypted_config);result.authorizationStored=!!config.refresh_token;result.oauthConfigured=!!config.client_id&&!!config.client_secret;}catch{result.configError='DECRYPT_FAILED';}
  result.runtimeRegistered=!!row.mount_path;
  if(row.mount_path){
   result.binaryExecutable=await exists(row.binary_path,constants.X_OK);result.configReadable=await exists(row.config_path,constants.R_OK);
   try{assertRcloneMounted(row.mount_path);result.mounted=true;}catch{result.mounted=false;}
   try{await readFile(join(dirname(row.config_path),'mounted'),'utf8');result.mountMarker=true;}catch{result.mountMarker=false;}
   // Only an authenticated read/list. Never print document names or returned metadata.
   let probeConfig=row.config_path;
   if(row.enabled&&result.binaryExecutable&&!result.configReadable&&config.refresh_token&&config.client_id&&config.client_secret){privateDir=await mkdtemp(join(tmpdir(),'wiki-rclone-check-'));probeConfig=join(privateDir,'rclone.conf');await writeFile(probeConfig,'[drive]\ntype = drive\nroot_folder_id = '+config.root+'\nclient_id = '+config.client_id+'\nclient_secret = '+config.client_secret+'\ntoken = '+JSON.stringify({access_token:'refresh-required',refresh_token:config.refresh_token,token_type:'Bearer',expiry:'2000-01-01T00:00:00Z'})+'\n',{mode:0o600});result.independentProbe=true;}
   if(row.enabled&&result.binaryExecutable&&(result.configReadable||privateDir)){try{const {stdout}=await run(row.binary_path,['lsjson','drive:','--config',probeConfig,'--max-depth','1','--drive-skip-gdocs','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','10s'],{timeout:15000,maxBuffer:1024*1024});result.list={ok:true,entries:JSON.parse(stdout).length};}catch(error){result.list={ok:false,code:typeof error.code==='number'?error.code:safeCode(error),reason:reason(String(error.stderr??'')),detail:redact(error.stderr??'',Object.values(config)),killed:!!error.killed};}}
   if(privateDir)await rm(privateDir,{recursive:true,force:true});
   try{const file=await open(join(dirname(row.config_path),'rclone.log'),'r');try{const size=(await file.stat()).size,buffer=Buffer.alloc(Math.min(size,16384));const {bytesRead}=await file.read(buffer,0,buffer.length,Math.max(0,size-buffer.length));const text=buffer.subarray(0,bytesRead).toString();result.mountLogReason=reason(text);result.mountLogDetail=redact(text,Object.values(config));}finally{await file.close();}}catch{result.mountLogReason='NO_LOG';}
  }
  console.log(JSON.stringify(result));
 }
 if(!rows.length)console.log(JSON.stringify({connections:0}));
}finally{db.close();codec.close();}
JS
