import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {bootstrap,ensureFreshRoot} from '../../apps/server/src/release/workspace.ts';
const input={username:'admin',displayName:'Administrator',password:'ReleaseTestPassword123!',publicUrl:'http://127.0.0.1:3000'};
test('bootstrap preserves legacy rclone directory and still refuses existing workspace',async()=>{const root=await mkdtemp(join(tmpdir(),'wiki-legacy-rclone-'));try{await mkdir(join(root,'rclone'));await writeFile(join(root,'rclone','keep.txt'),'legacy data');await bootstrap(root,input);assert.equal(await readFile(join(root,'rclone','keep.txt'),'utf8'),'legacy data');await assert.rejects(bootstrap(root,input),/EXISTING_DATA/);}finally{await rm(root,{recursive:true,force:true});}});
test('reserved rclone entry must be a real directory; unrelated data still blocks setup',async()=>{for(const kind of ['file','symlink','other']){const root=await mkdtemp(join(tmpdir(),'wiki-legacy-rclone-'));try{if(kind==='file')await writeFile(join(root,'rclone'),'keep');else if(kind==='symlink')await symlink('/tmp',join(root,'rclone'));else {await mkdir(join(root,'rclone'));await writeFile(join(root,'database.sqlite3'),'keep');}await assert.rejects(ensureFreshRoot(root),/EXISTING_DATA/);}finally{await rm(root,{recursive:true,force:true});}}});

test('installer preflight agrees with setup for a preserved legacy directory and rejects its symlink',async()=>{const root=await mkdtemp(join(tmpdir(),'wiki-preflight-'));try{const script=await readFile(new URL('../../install.sh',import.meta.url),'utf8'),command=script.match(/-c '([^\n]+)' \|\| workspace_state=/)?.[1];assert.ok(command);const probe=()=>spawnSync('sh',['-c',command.replaceAll('/data',root)],{encoding:'utf8'});await mkdir(join(root,'rclone'));await writeFile(join(root,'rclone','keep'),'safe');assert.equal(probe().status,1);assert.equal(await readFile(join(root,'rclone','keep'),'utf8'),'safe');await rm(join(root,'rclone'),{recursive:true});await symlink('/tmp',join(root,'rclone'));assert.equal(probe().status,2);}finally{await rm(root,{recursive:true,force:true});}});
