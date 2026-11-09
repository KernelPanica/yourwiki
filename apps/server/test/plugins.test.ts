import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {historyFixture} from './support/history-fixture.ts';
import {FernetCodec} from '../src/providers/fernet.ts';
import {SecretConfigs} from '../src/providers/secret-config.ts';
import {PluginRunner,manifest} from '../src/plugins/runner.ts';
import {Plugins} from '../src/plugins/service.ts';
const source=`type C={config:Record<string,string>;input:Record<string,string>;fetch:typeof globalThis.fetch};export default {id:'custom-api',name:'Custom API',version:'1.0.0',fields:[{key:'endpoint',label:'URL',type:'url',required:true},{key:'token',label:'Key',type:'secret',required:true}],actions:[{id:'check',label:'Check',fields:[{key:'query',label:'Query',type:'text'}]}],async execute({config,input,fetch}:C){const r=await fetch(config.endpoint,{method:'POST',headers:{authorization:'Custom '+config.token,'content-type':'application/json'},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};}}`;
async function fixture(t:any){const codec=new FernetCodec(randomBytes(32).toString('base64url')),secrets=new SecretConfigs(codec),f=await historyFixture(t,{appOptions:()=>({contentSecrets:secrets})});t.after(()=>codec.close());return {...f,secrets};}
test('plugins: giga-only API, CSRF, TypeScript validation and disabled-by-default install',async t=>{
 const f=await fixture(t),call=(user:string,payload:any,headers=f.headers(user))=>f.app.inject({method:'POST',url:'/api/admin/plugins',headers,payload});
 assert.equal((await f.app.inject({url:'/api/admin/plugins'})).statusCode,401);
 assert.equal((await call('writer',{source,filename:'service.ts'})).statusCode,403);
 f.db.prepare("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('simple','simple','Simple','!','simple')").run();
 const {createSession}=await import('../src/auth/sessions.ts'),simple=createSession(f.db,'simple');assert.equal((await f.app.inject({url:'/api/admin/plugins',headers:{cookie:'yourwiki_v2_session='+simple.token}})).statusCode,403);
 assert.equal((await call('admin',{source,filename:'service.ts'},{...f.headers('admin'),'x-csrf-token':'bad'})).statusCode,403);
 assert.equal((await call('admin',{source,filename:'service.js'})).statusCode,400);
 assert.equal((await call('admin',{source:'export default {',filename:'bad.ts'})).statusCode,400);
 const installed=await call('admin',{source,filename:'service.ts'});assert.equal(installed.statusCode,200,installed.body);assert.equal(installed.json().enabled,false);
 assert.equal((await call('admin',{source,filename:'service.ts'})).statusCode,409);
 assert.equal((await f.app.inject({method:'POST',url:'/api/admin/plugins/custom-api/execute',headers:f.headers('admin'),payload:{action:'check'}})).statusCode,409);
 assert.equal((await f.app.inject({method:'PUT',url:'/api/admin/plugins/custom-api',headers:f.headers('admin'),payload:{revision:0,enabled:true}})).statusCode,400);
});
test('plugins: arbitrary HTTP API auth, encrypted secrets, masked list/results, CAS and removal',async t=>{
 const f=await fixture(t);let received:any;
 const remote=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received={authorization:req.headers.authorization,body:JSON.parse(body)};res.setHeader('content-type','application/json');res.end(JSON.stringify({received:true,echo:req.headers.authorization}));});await new Promise<void>(resolve=>remote.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>remote.close(()=>resolve())));const port=(remote.address() as {port:number}).port;
 const request=(method:'POST'|'PUT'|'DELETE'|'GET',suffix:string,payload?:any)=>f.app.inject({method,url:'/api/admin/plugins'+suffix,headers:f.headers('admin'),payload});
 assert.equal((await request('POST','',{source,filename:'custom.ts'})).statusCode,200);
 let updated=await request('PUT','/custom-api',{revision:0,enabled:true,config:{endpoint:'http://127.0.0.1:'+port,token:'private-test-key'}});assert.equal(updated.statusCode,200,updated.body);assert(!updated.body.includes('private-test-key'));assert.deepEqual(updated.json().configuredSecrets,['token']);
 assert(!String((f.db.prepare('SELECT encrypted_config FROM service_plugins').get() as any).encrypted_config).includes('private-test-key'));
 assert.equal((await request('PUT','/custom-api',{revision:0,enabled:false})).statusCode,409);
 const run=await request('POST','/custom-api/execute',{action:'check',input:{query:'hello'}});assert.equal(run.statusCode,200,run.body);assert.equal(received.authorization,'Custom private-test-key');assert.equal(received.body.query,'hello');assert(!run.body.includes('private-test-key'));assert.match(run.body,/REDACTED/);
 const list=await request('GET','');assert.equal(list.json().items[0].lastError,null);assert.equal(list.json().items[0].lastRunAt!==null,true);
 assert.equal((await request('DELETE','/custom-api',{revision:1})).statusCode,409);
 updated=await request('PUT','/custom-api',{revision:1,enabled:false});assert.equal(updated.statusCode,200);assert.deepEqual(updated.json().configuredSecrets,['token']);
 assert.equal((await request('DELETE','/custom-api',{revision:2})).statusCode,200);assert.equal((await request('GET','')).json().items.length,0);
 assert((f.db.prepare("SELECT 1 FROM administration_audit WHERE action='plugin.execute'").get()));
});
test('plugins: timeouts, malformed manifests, thrown secrets and result size are bounded',async t=>{
 const runner=new PluginRunner(500);t.after(()=>runner.close());
 await assert.rejects(runner.run('while(true){}'),/PLUGIN_TIMEOUT/);
 assert.throws(()=>manifest({id:'x',name:'X',version:'1',actions:[]}),/PLUGIN_INVALID/);
 assert.throws(()=>manifest({id:'x',name:'X',version:'1',actions:[{id:'x',label:'X'}],fields:[{key:'token',label:'T',type:'secret'},{key:'token',label:'T',type:'text'}]}),/PLUGIN_INVALID/);
 await assert.rejects(runner.run(`export default {execute(){throw Error('private-key')}}`,{}),/PLUGIN_EXECUTION_FAILED/);
 await assert.rejects(runner.run(`export default {execute(){return 'x'.repeat(140000)}}`,{}),/PLUGIN_EXECUTION_FAILED/);
});
test('plugins: disabling during execution discards the response and configuration persists across service instances',async t=>{
 const f=await fixture(t),s=new Plugins(f.db,f.secrets),slow=source.replace("async execute({config,input,fetch}:C){", "async execute({config,input,fetch}:C){await new Promise(r=>setTimeout(r,200));return 'done';");t.after(()=>s.runner.close());await s.install('admin',{source:slow,filename:'slow.ts'},()=>{});s.update('admin','custom-api',{revision:0,enabled:true,config:{endpoint:'https://example.test',token:'saved-key'}});const fresh=new Plugins(f.db,f.secrets);t.after(()=>fresh.runner.close());assert.equal(fresh.list('admin').items[0].enabled,true);const run=s.execute('admin','custom-api',{action:'check'},()=>{});s.update('admin','custom-api',{revision:1,enabled:false});await assert.rejects(run,/CONFLICT/);
});
test('plugins: append-only migration upgrades an existing workspace without altering users',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{openDatabase}=await import('../src/database.ts'),{migrations}=await import('../src/schema.ts');const root=await mkdtemp(join(tmpdir(),'yourwiki-plugin-migration-')),path=join(root,'database.sqlite3');let db=openDatabase(path);try{db.prepare("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('existing','existing','Existing','!','giga')").run();db.exec('DROP TRIGGER rclone_export_document_cleanup;DROP TABLE rclone_drive_folder_exports;DROP TABLE rclone_drive_exports;DROP TABLE rclone_drive_entries;DROP TABLE rclone_drive_mounts;DROP TABLE user_google_purge_cleanup;DROP TABLE service_plugins');db.prepare('DELETE FROM schema_migrations WHERE version>=?').run(migrations.findIndex(sql=>sql.includes('CREATE TABLE service_plugins'))+1);db.close();db=openDatabase(path);assert.equal((db.prepare("SELECT display_name FROM users WHERE id='existing'").get() as any).display_name,'Existing');assert.equal((db.prepare('SELECT count(*) AS n FROM service_plugins').get() as any).n,0);assert.deepEqual(db.pragma('foreign_key_check'),[]);}finally{if(db.open)db.close();await rm(root,{recursive:true,force:true});}
});
