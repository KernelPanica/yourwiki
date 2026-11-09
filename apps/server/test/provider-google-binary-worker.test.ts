import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {historyFixture} from './support/history-fixture.ts';
import {FernetCodec} from '../src/providers/fernet.ts';
import {SecretConfigs} from '../src/providers/secret-config.ts';
import {CredentialVault} from '../src/providers/credential-vault.ts';
import {importLegacyConnection} from '../src/providers/connection-import.ts';
import {importLegacyGoogleGrant} from '../src/providers/google-grants.ts';
import {bindExistingSource} from '../src/providers/source-bindings.ts';
import {createGoogleBinarySource} from '../src/providers/google-source.ts';
import {IngressWorker} from '../src/providers/ingress-worker.ts';
import {IngressScheduler} from '../src/providers/ingress-scheduler.ts';
import {ProviderSync} from '../src/providers/sync-status.ts';
for(const mode of ['stable','changed','managed','unmanaged','bad-hash','same'] as const)test('actual OAuth/metadata/content/inbox composition '+mode,async t=>{
 const f=await historyFixture(t),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),configs=new SecretConfigs(codec);t.after(()=>codec.close());let version='2',tokens=0,media=0,writes=0,requests=0;
 const server=createServer((req,res)=>{requests++;res.setHeader('content-type','application/json');if(req.url==='/token'){tokens++;assert.equal(req.method,'POST');req.resume();res.end(JSON.stringify({access_token:'SYNTHETIC',token_type:'Bearer',expires_in:3600}));return;}
  assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer SYNTHETIC');const url=new URL(req.url!,'http://owned.invalid');
  if(url.searchParams.get('alt')==='media'){media++;res.setHeader('content-type','application/octet-stream');res.end(mode==='same'?'new':'out');if(mode==='changed')version='3';return;}
  if(url.pathname.endsWith('/permissions')){res.end(JSON.stringify({permissions:[{id:'p1',type:'user',role:'reader',emailAddress:'editor@example.org'}]}));return;}
  const id=url.pathname.split('/').at(-1)!;res.end(JSON.stringify({id,mimeType:id==='rootId'?'application/vnd.google-apps.folder':'text/markdown',version,parents:id==='rootId'?[]:['rootId'],size:'3',sha256Checksum:mode==='bad-hash'?'a'.repeat(64):createHash('sha256').update(mode==='same'?'new':'out').digest('hex'),headRevisionId:'head2',capabilities:{canDownload:true},ownedByMe:true,trashed:false,shared:id==='file'&&['managed','unmanaged'].includes(mode)}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const request:typeof fetch=async(url,init)=>{const parsed=new URL(String(url));if(parsed.origin==='https://oauth2.googleapis.com'){assert.equal(parsed.pathname,'/token');return fetch('http://127.0.0.1:'+port+'/token',init);}assert.equal(parsed.origin,'https://www.googleapis.com');return fetch('http://127.0.0.1:'+port+parsed.pathname+parsed.search,init);};
 importLegacyConnection(f.db,configs,{legacyKey:'backup:mount:1',id:'google',provider:'google',label:'Owned Google fixture',path:'/',folderId:null,encryptedConfig:configs.encrypt({root:'rootId',client_id:'synthetic',client_secret:'SYNTHETIC',refresh_token:'SYNTHETIC'}),now:1});
 if(mode==='managed')importLegacyGoogleGrant(f.db,{legacyKey:'backup:grant:1',connectionLegacyKey:'backup:mount:1',connectionId:'google',reference:'file',objectKey:createHash('sha256').update(':file').digest('hex'),legacyUserKey:null,recipient:'editor@example.org',desiredRole:'read',appliedRole:'read',permissionId:'p1',status:'synced',attemptedAt:1,now:1});
 // The test owns the exact original baseline (local revision2 is "new"); no discovery/user reference authority.
 bindExistingSource(f.db,{documentId:f.first.documentId,connectionId:'google',reference:'file',fingerprint:JSON.stringify(['google-binary-v1','file','1','text/markdown',3,['rootId']]),confirmedRevision:2,confirmedDigest:f.next.blob.digest,confirmedSize:3,now:1});
 const before=f.db.prepare('SELECT * FROM documents').all(),vault=new CredentialVault(f.db,configs,{google:{fetch:request}});t.after(()=>vault.close());
 const worker=new IngressWorker(f.db,f.store,vault,async connection=>{assert.equal(connection.provider,'google');assert.equal(connection.config.root,'rootId');const reader=createGoogleBinarySource(vault,connection,{fetch:request});return {read:(ref,options)=>reader.read(ref,options),replace:async()=>{writes++;throw new Error('Incoming must never replace');},retire:async()=>{throw new Error('Incoming must never retire');},close:()=>reader.close()};});
 new IngressScheduler(f.db).tick();const result=await worker.runOnce();assert.equal(tokens,1);assert.equal(writes,0);assert.equal((f.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='provider.deliver'").get() as any).n,0);
 if(mode==='same'){assert.equal(result,'applied');const row=f.db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(f.first.documentId) as any;assert.deepEqual(row,{local_revision:2,provider_revision:2});assert.equal((f.db.prepare('SELECT count(*) AS n FROM document_versions WHERE document_id=?').get(f.first.documentId) as any).n,2);assert.ok((f.db.prepare('SELECT fingerprint FROM provider_source_bindings WHERE document_id=?').get(f.first.documentId) as any).fingerprint.includes('google-binary-v2'));}
 else if(mode==='stable'||mode==='managed'||mode==='unmanaged'){
  assert.equal(result,'applied');const row=f.db.prepare('SELECT local_revision,provider_revision,published_revision FROM documents WHERE id=?').get(f.first.documentId) as any;assert.deepEqual(row,{local_revision:3,provider_revision:3,published_revision:2});const accepted=f.db.prepare('SELECT digest,author_id FROM document_versions WHERE document_id=? AND revision=3').get(f.first.documentId) as any;assert.equal(accepted.author_id,null);assert.equal(await readFile(await f.store.localFile(accepted.digest),'utf8'),'out');assert.equal((f.db.prepare('SELECT pending_bytes FROM provider_ingress_usage').get() as any).pending_bytes,0);assert.equal(media,1);
 }else{assert.equal(result,'blocked');assert.deepEqual(f.db.prepare('SELECT * FROM documents').all(),before);assert.equal(media,1);if(mode==='changed'||mode==='bad-hash')assert.equal(new ProviderSync(f.db,f.store).status('reader',f.first.documentId).errorCode,'PROVIDER_CONFLICT');}
 const count=requests;assert.equal((await f.app.inject({url:'/api/documents/'+f.first.documentId+'/view',headers:f.headers()})).statusCode,200);assert.equal(requests,count);
});
