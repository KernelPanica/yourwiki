#!/bin/sh
# Read-only production checks. Never print .env, OAuth credentials or raw logs.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
docker compose config --quiet
docker compose ps
docker compose exec -T web node --input-type=module <<'JS'
import {access,statfs,readdir,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
let failures=0;
const report=(check,ok,details)=>{console.log(JSON.stringify({check,ok,...details}));if(!ok)failures++;};
for(const path of ['/data/workspace','/tmp']){
 const fs=await statfs(path),available=Number(fs.bavail)*Number(fs.bsize),total=Number(fs.blocks)*Number(fs.bsize);
 report('disk',available>=2*1024**3&&available/total>.06||path==='/tmp'&&available>=64*1024**2,{path,available,total});
}
for(const path of ['/usr/bin/bwrap','/usr/bin/rclone','/usr/lib/libreoffice/program/soffice.bin']){
 report('runtime-tool',await access(path,constants.X_OK).then(()=>true,()=>false),{path});
}
const fontRoot='/opt/yourwiki-fonts',fonts=await readdir(fontRoot).catch(()=>[]);
console.log(JSON.stringify({check:'private-fonts',impact:fonts.some(x=>/^impact\.ttf$/i.test(x)),timesNewRoman:fonts.some(x=>/^times\.ttf$/i.test(x)),optional:true}));
for(const [check,url,expected] of [['web','http://127.0.0.1:3100/ready/',200],...(process.env.COLLABORA_WOPI_URL?[['public-wopi',new URL('/wopi/files/diagnostic',process.env.COLLABORA_WOPI_URL).href,401]]:[])]){
 try{const r=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'manual'});report(check,r.status===expected,{status:r.status,expected});await r.body?.cancel();}
 catch{report(check,false,{reason:'NETWORK_OR_TLS'});}
}
const status=await readFile('/proc/self/status','utf8');
console.log(JSON.stringify({check:'sandbox',noNewPrivileges:/^NoNewPrivs:\s+1$/m.test(status),seccompFilter:/^Seccomp:\s+2$/m.test(status)}));
process.exitCode=failures?1:0;
JS
for service in web provider conversion rclone collabora; do
 container=$(docker compose ps -q "$service" 2>/dev/null || true)
 if [ -n "$container" ]; then
  docker inspect --format '{{.Name}} logging={{json .HostConfig.LogConfig}}' "$container"
 fi
done
