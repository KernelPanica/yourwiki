import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'yourwiki-installer-')),work=join(root,'project'),bin=join(root,'bin'),calls=join(root,'docker-calls');
 await mkdir(work);await mkdir(bin);await writeFile(join(work,'compose.yaml'),'services: {}\n');await writeFile(join(work,'Dockerfile'),'');
 await copyFile(new URL('../../../install.sh',import.meta.url),join(work,'install.sh'));
 await writeFile(join(bin,'docker'),`#!/bin/sh
printf '%s\\n' "$*" >> "$YOURWIKI_TEST_DOCKER_CALLS"
if [ "$1" = info ] && [ "\${MOCK_DOCKER_INFO_FAIL:-}" = 1 ]; then exit 1; fi
case "$*" in
 "compose run --rm --no-deps --entrypoint sh setup -c"*) if [ "\${MOCK_WORKSPACE_MISSING:-}" = 1 ]; then exit 1; fi ;;
esac
exit 0
`,{mode:0o700});
 await writeFile(join(bin,'sudo'),`#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$YOURWIKI_TEST_DOCKER_CALLS"
if [ "$1" = docker ]; then
 shift
 unset MOCK_DOCKER_INFO_FAIL
 docker "$@"
fi
exit 0
`,{mode:0o700});
 const env={...process.env,PATH:bin+':/usr/bin:/bin',YOURWIKI_TEST_DOCKER_CALLS:calls,NO_COLOR:'1'};
 return {root,work,bin,calls,env};
}
async function stub(f:Awaited<ReturnType<typeof fixture>>,name:string,body:string){await writeFile(join(f.bin,name),`#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$YOURWIKI_TEST_DOCKER_CALLS"\n${body}\n`,{mode:0o700});}
function run(work:string,env:NodeJS.ProcessEnv,args:string[]=[]){return spawnSync('sh',['install.sh',...args,'--no-system-setup','--no-proxy','--no-swap','--no-collabora','--no-rclone'],{cwd:work,env,encoding:'utf8'});}
function runRaw(work:string,env:NodeJS.ProcessEnv,args:string[]){return spawnSync('sh',['install.sh',...args],{cwd:work,env,encoding:'utf8'});}

test('installer preserves provider settings, builds before setup, starts all services and checks readiness',async()=>{const f=await fixture();try{
 await writeFile(join(f.work,'.env'),'COLLABORA_URL=https://wiki.test/collabora\nYOURWIKI_PUBLIC_URL=https://old.test\n');
 const result=run(f.work,f.env,['--public-url','https://wiki.test','--port','3000','--yes']);assert.equal(result.status,0,result.stderr);
 const env=await readFile(join(f.work,'.env'),'utf8');assert.equal(env,'COLLABORA_URL=https://wiki.test/collabora\nYOURWIKI_PUBLIC_URL=https://wiki.test\nYOURWIKI_PORT=3000\nYOURWIKI_DRIVE_TRANSPORT=api\n');assert.equal((await lstat(join(f.work,'.env'))).mode&0o077,0);
 const calls=await readFile(f.calls,'utf8');assert.ok(calls.indexOf('compose build')<calls.indexOf('compose run --rm --service-ports setup'));assert.ok(calls.indexOf('compose run --rm --service-ports setup')<calls.indexOf('compose up -d web provider conversion'));assert.ok(calls.includes('compose exec -T web node -e'));
}finally{await rm(f.root,{recursive:true,force:true});}});

test('build-only packages the image without writing configuration or starting setup',async()=>{const f=await fixture();try{
 const result=run(f.work,f.env,['--build-only']);assert.equal(result.status,0,result.stderr);const calls=await readFile(f.calls,'utf8');assert.ok(calls.includes('compose build'));assert.ok(!calls.includes('compose run'));assert.ok(!calls.includes('compose up'));await assert.rejects(lstat(join(f.work,'.env')),{code:'ENOENT'});
}finally{await rm(f.root,{recursive:true,force:true});}});

test('incomplete browser setup cannot start runtime services',async()=>{const f=await fixture();try{
 const result=run(f.work,{...f.env,MOCK_WORKSPACE_MISSING:'1'},['--yes']);assert.notEqual(result.status,0);assert.match(result.stderr,/No complete workspace/);const calls=await readFile(f.calls,'utf8');assert.ok(!calls.includes('compose up -d'));
}finally{await rm(f.root,{recursive:true,force:true});}});

test('invalid public origins fail before Docker or project configuration changes',async()=>{const f=await fixture();try{
 const result=run(f.work,f.env,['--public-url','http://example.test','--yes']);assert.notEqual(result.status,0);assert.match(result.stderr,/Public URL/);await assert.rejects(lstat(join(f.work,'.env')),{code:'ENOENT'});await assert.rejects(lstat(f.calls),{code:'ENOENT'});
}finally{await rm(f.root,{recursive:true,force:true});}});

test('Docker permission failure uses an interactive sudo fallback without changing the system configuration',async()=>{const f=await fixture();try{
 const result=run(f.work,{...f.env,MOCK_DOCKER_INFO_FAIL:'1'},['--build-only']);assert.equal(result.status,0,result.stderr);const calls=await readFile(f.calls,'utf8');assert.ok(calls.includes('compose build'));
}finally{await rm(f.root,{recursive:true,force:true});}});

test('server mode installs missing Ubuntu packages and enables Docker and Nginx',async()=>{const f=await fixture();try{
 await stub(f,'apt-get','exit 0');
 const result=runRaw(f.work,f.env,['--start-only','--yes','--no-swap','--public-url','http://127.0.0.1:3000']);assert.equal(result.status,0,result.stderr);const calls=await readFile(f.calls,'utf8');assert.ok(calls.includes('sudo apt-get update'),calls+result.stdout+result.stderr);assert.ok(calls.includes('apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx rsync curl'));assert.ok(calls.includes('sudo systemctl enable --now docker nginx'));
}finally{await rm(f.root,{recursive:true,force:true});}});

test('public server mode configures Nginx, obtains TLS and checks the public readiness URL',async()=>{const f=await fixture();try{
 await stub(f,'nginx','exit 0');await stub(f,'certbot','exit 0');await stub(f,'curl','exit 0');await stub(f,'getent','printf "192.0.2.10 STREAM wiki.test\\n"');await stub(f,'hostname','printf "192.0.2.10\\n"');
 const result=runRaw(f.work,f.env,['--start-only','--yes','--no-swap','--public-url','https://wiki.test']);assert.equal(result.status,0,result.stderr);const calls=await readFile(f.calls,'utf8'),env=await readFile(join(f.work,'.env'),'utf8');assert.ok(env.includes('COLLABORA_URL=https://wiki.test/collabora'));assert.ok(env.includes('COLLABORA_WOPI_URL=https://wiki.test'));assert.ok(env.includes('YOURWIKI_DRIVE_TRANSPORT=rclone'));assert.ok(calls.includes('sudo systemctl enable --now yourwiki-rclone-drive'));assert.ok(calls.includes('sudo install -D -m 644 docker/nginx-location.conf /etc/nginx/snippets/yourwiki.conf'));assert.ok(calls.includes('sudo install -D -m 644 docker/nginx-collabora.conf /etc/nginx/snippets/yourwiki-collabora.conf'));assert.ok(calls.includes('sudo certbot --nginx -d wiki.test'));assert.ok(calls.includes('compose -f compose.yaml -f compose.collabora.yaml up -d web provider conversion collabora'));assert.ok(calls.includes('curl -fsS --max-time 20 https://wiki.test/ready/'));assert.ok(calls.includes('curl -fsS --max-time 30 https://wiki.test/collabora/hosting/discovery'));
}finally{await rm(f.root,{recursive:true,force:true});}});

test('DNS mismatch skips certificate issuance and public verification without blocking installation',async()=>{const f=await fixture();try{
 await stub(f,'nginx','exit 0');await stub(f,'certbot','exit 0');await stub(f,'curl','exit 0');await stub(f,'getent','printf "192.0.2.20 STREAM wiki.test\\n"');await stub(f,'hostname','printf "192.0.2.10\\n"');
 const result=runRaw(f.work,f.env,['--start-only','--yes','--no-swap','--public-url','https://wiki.test']);assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/DNS for wiki.test does not match/);const calls=await readFile(f.calls,'utf8');assert.ok(!calls.includes('sudo certbot --nginx'));assert.ok(!calls.includes('curl -fsS --max-time 20'));
}finally{await rm(f.root,{recursive:true,force:true});}});


test('rclone is the Docker default and --no-rclone explicitly selects the API adapter',async()=>{const f=await fixture();try{
 const compose=await readFile(new URL('../../../compose.yaml',import.meta.url),'utf8');assert.ok(compose.includes('${YOURWIKI_DRIVE_TRANSPORT:-rclone}'));assert.ok(compose.includes('${YOURWIKI_RCLONE_DATA:-/data/rclone}:/data/rclone:shared'));
 const result=runRaw(f.work,f.env,['--start-only','--yes','--no-system-setup','--no-proxy','--no-swap','--no-collabora','--no-rclone','--public-url','http://127.0.0.1:3000']);assert.equal(result.status,0,result.stderr);const env=await readFile(join(f.work,'.env'),'utf8'),calls=await readFile(f.calls,'utf8');assert.ok(env.includes('YOURWIKI_DRIVE_TRANSPORT=api'));assert.ok(!calls.includes('yourwiki-rclone-drive'));
}finally{await rm(f.root,{recursive:true,force:true});}});
