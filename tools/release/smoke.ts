/** Disposable real HTTP smoke test; never takes production paths or credentials. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {bootstrap,workspacePaths} from '../../apps/server/src/release/workspace.ts';
import {openConfiguredApp} from '../../apps/server/src/configured-app.ts';
import {createBackup,verifyBackup,restoreBackup} from '../../apps/server/src/release/backup.ts';
const root=await mkdtemp(join(tmpdir(),'yourwiki-release-http-'));
try{
 const data=join(root,'data'),username='release-smoke',password='TemporaryReleaseSmoke123!';await bootstrap(data,{username,displayName:'Smoke',password,publicUrl:'http://127.0.0.1:3100'});const paths=workspacePaths(join(data,'workspace'));
 const app=await openConfiguredApp({...paths,publicUrl:'http://127.0.0.1:3100',webRoot:resolve('apps/web/dist')});
 try{const address=await app.listen({host:'0.0.0.0',port:0}),url=address.replace('0.0.0.0','127.0.0.1');assert.equal((await fetch(url+'/ready/')).status,200);const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(await page.text(),/Yourwiki|YourWiki/);const login=await fetch(url+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:3100'},body:JSON.stringify({username,password})});assert.equal(login.status,200);assert.ok(login.headers.get('set-cookie'));}finally{await app.close();}
 const backup=join(root,'backup');await createBackup(paths.root,backup);await verifyBackup(backup);await restoreBackup(backup,join(root,'restored'));console.info('PASS: fresh bootstrap → configured HTTP on 0.0.0.0 → built React HTML → login → shutdown → verified backup → restore');
}finally{await rm(root,{recursive:true,force:true});}
