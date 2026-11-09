import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleMetadata} from '../src/providers/google-metadata.ts';
import {ProviderError} from '../src/providers/adapter.ts';
const folder='application/vnd.google-apps.folder';
function info(id:string,extra:Record<string,unknown>={}){return {id,mimeType:id==='rootId'?folder:'application/pdf',version:'18446744073709551615',ownedByMe:true,shared:false,trashed:false,parents:id==='rootId'?[]:['rootId'],size:'12',capabilities:{canDownload:true},...extra};}
function fixture(values:Record<string,Record<string,unknown>|undefined>={}){
 const calls:string[]=[];let checks=0;
 const http={async file(id:string){calls.push(id);return structuredClone(values[id]??info(id));},async permissions():Promise<Record<string,unknown>>{return {permissions:[]};}};
 const options={check(){checks++;}};
 return {http,calls,options,checks:()=>checks};
}
test('pins central-owned file, canonical root, exact uint64 version and binary size',async()=>{
 const f=fixture();const m=new GoogleMetadata(f.http,async()=>[]);
 const result=await m.verify('file','rootId',f.options);
 assert.equal(result.id,'file');assert.equal(result.version,'18446744073709551615');assert.equal(result.size,12);assert.equal(result.kind,'binary');assert.deepEqual(result.parents,['rootId']);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.parents));assert.ok(f.checks()>4);
});
test('resolves root alias without accepting mismatched source identity',async()=>{
 const f=fixture({root:info('rootId')});const m=new GoogleMetadata(f.http,async()=>[]);
 assert.equal((await m.verify('file','root',f.options)).id,'file');
 const bad=fixture({file:info('other')});await assert.rejects(new GoogleMetadata(bad.http,async()=>[]).verify('file','rootId',bad.options),{code:'PROVIDER_SOURCE_CHANGED'});
});
test('refuses absent ownership, trash, shared drive, unknown sharing and malformed metadata',async()=>{
 for(const extra of [{ownedByMe:false},{ownedByMe:undefined},{trashed:true},{trashed:undefined},{driveId:'drive'},{shared:undefined},{version:'18446744073709551616'},{version:'1e2'},{version:1},{parents:['rootId','other']},{size:'4294967297'},{size:'-1'},{size:undefined},{capabilities:{canDownload:false}},{mimeType:'application/vnd.google-apps.shortcut'}]){
  const f=fixture({file:info('file',extra)});await assert.rejects(new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options),ProviderError);
 }
});
test('native kinds follow MIME only and do not mistake native size for exported byte length',async()=>{
 for(const [mimeType,kind] of [['DOCUMENT','document'],['document','document'],['spreadsheet','spreadsheet'],['presentation','presentation']]){
  const f=fixture({file:info('file',{mimeType:'application/vnd.google-apps.'+mimeType,size:'999999999999',name:'fake.pdf'})});
  const result=await new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options);assert.equal(result.kind,kind);assert.equal(result.size,null);
 }
});
test('checks intermediate folder ownership and refuses outside-root, cycles and nonfolders',async()=>{
 for(const values of [{file:info('file',{parents:[]})},{file:info('file',{parents:['file']})},{file:info('file',{parents:['middle']}),middle:info('middle')},{file:info('file',{parents:['middle']}),middle:info('middle',{mimeType:folder,ownedByMe:false})}]){
  const f=fixture(values);await assert.rejects(new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options),ProviderError);
 }
 const f=fixture({file:info('file',{parents:['middle']}),middle:info('middle',{mimeType:folder})});assert.equal((await new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options)).id,'file');
});
test('managed named sharing remains supported; public, unknown, malformed and incomplete lists refuse',async()=>{
 const permission={id:'p1',type:'user',role:'writer',emailAddress:'Editor@Example.org'};
 const f=fixture({file:info('file',{shared:true})});f.http.permissions=async()=>({permissions:[{id:'owner',type:'user',role:'owner'},permission]});
 const m=new GoogleMetadata(f.http,async()=>['editor@example.org']);assert.equal((await m.verify('file','rootId',f.options)).id,'file');
 for(const page of [{permissions:[{...permission,type:'anyone'}]},{permissions:[{...permission,emailAddress:'stranger@example.org'}]},{permissions:[null]},{permissions:[permission],nextPageToken:'next'},{permissions:'bad'},{permissions:[{...permission,role:'organizer'}]}]){
  f.http.permissions=async()=>page as any;await assert.rejects(m.verify('file','rootId',f.options),ProviderError);
 }
 f.http.permissions=async()=>({permissions:[permission]});await assert.rejects(new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options),{code:'ACCESS_DENIED'});
});
test('checks current authority after grant lookup and transport, preserving session errors',async()=>{
 const f=fixture({file:info('file',{shared:true})});let revoked=false;
 const m=new GoogleMetadata(f.http,async()=>{revoked=true;return ['editor@example.org'];});
 await assert.rejects(m.verify('file','rootId',{check(){if(revoked)throw new Error('SESSION_REQUIRED');}}),{message:'SESSION_REQUIRED'});
 const controller=new AbortController();controller.abort();await assert.rejects(m.verify('file','rootId',{signal:controller.signal,check(){}}),{code:'PROVIDER_CANCELLED'});
});
test('bounds ancestry traversal without returning a partially verified source',async()=>{
 const f=fixture();f.http.file=async(id:string)=>{f.calls.push(id);return info(id,{mimeType:id==='file'?'application/pdf':folder,parents:[id+'x']});};
 await assert.rejects(new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options),ProviderError);assert.ok(f.calls.length<=36);
});
test('actual HTTP composes transport and metadata gate without forwarding provider URLs or bodies',async t=>{
 const {createServer}=await import('node:http'),{once}=await import('node:events'),{GoogleReadHttp}=await import('../src/providers/google-read-http.ts');
 const paths:string[]=[];
 const server=createServer((req,res)=>{
  assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer SYNTHETIC');const url=new URL(req.url!,'http://owned.invalid');paths.push(url.pathname);
  res.setHeader('content-type','application/json');
  if(url.pathname.endsWith('/permissions')){assert.equal(url.searchParams.get('pageSize'),'100');res.end(JSON.stringify({permissions:[{id:'p1',type:'user',role:'reader',emailAddress:'reader@example.org'}]}));return;}
  assert.ok(url.searchParams.get('fields')?.includes('trashed'));assert.ok(url.searchParams.get('fields')?.includes('canDownload'));
  const id=url.pathname.split('/').at(-1)!;res.end(JSON.stringify(info(id,id==='file'?{shared:true}:{})));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const http=new GoogleReadHttp({access:async()=> 'SYNTHETIC',invalidate(){}},{fetch:async(url,init)=>{assert.equal(new URL(String(url)).origin,'https://www.googleapis.com');const original=new URL(String(url));return fetch('http://127.0.0.1:'+port+original.pathname+original.search,init);}});
 t.after(async()=>{await http.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const result=await new GoogleMetadata(http,async()=>['reader@example.org']).verify('file','rootId',{check(){}});
 assert.equal(result.kind,'binary');assert.deepEqual(paths,['/drive/v3/files/rootId','/drive/v3/files/file','/drive/v3/files/file/permissions']);assert.equal('shared' in result,false);
});
test('provider checksum/revision metadata is normalized, bounded and retained without inferring native content',async()=>{
 const f=fixture({file:info('file',{md5Checksum:'A'.repeat(32),sha256Checksum:'B'.repeat(64),headRevisionId:'head-1'})}),m=new GoogleMetadata(f.http,async()=>[]),result=await m.verify('file','rootId',f.options);assert.equal(result.md5,'a'.repeat(32));assert.equal(result.sha256,'b'.repeat(64));assert.equal(result.headRevision,'head-1');
 for(const extra of [{md5Checksum:'bad'},{sha256Checksum:null},{headRevisionId:'private\ninvalid'}]){const bad=fixture({file:info('file',extra)});await assert.rejects(new GoogleMetadata(bad.http,async()=>[]).verify('file','rootId',bad.options),{code:'PROVIDER_SOURCE_CHANGED'});}
});
test('lifecycle metadata verifies an explicitly trashed original without relaxing ordinary source admission',async()=>{const f=fixture({file:info('file',{trashed:true,explicitlyTrashed:true})}),m=new GoogleMetadata(f.http,async()=>[]);await assert.rejects(m.verify('file','rootId',f.options),{code:'ACCESS_DENIED'});const state=await m.trashState('file','rootId',f.options);assert.equal(state.trashed,true);assert.equal(state.explicitlyTrashed,true);assert.equal(state.file.id,'file');assert.ok(Object.isFrozen(state));assert.ok(Object.isFrozen(state.file));});
test('lifecycle trash evidence requires explicit boolean fields, current ownership, ancestry and managed sharing',async()=>{for(const values of [{file:info('file',{trashed:true})},{file:info('file',{trashed:false,explicitlyTrashed:true})},{file:info('file',{trashed:'true',explicitlyTrashed:true})},{file:info('file',{trashed:true,explicitlyTrashed:true,ownedByMe:false})},{file:info('file',{trashed:true,explicitlyTrashed:true,parents:['outside']})},{rootId:info('rootId',{trashed:true}),file:info('file',{trashed:true,explicitlyTrashed:true})},{file:info('file',{trashed:true,explicitlyTrashed:true,shared:true})}]){const f=fixture(values);await assert.rejects(new GoogleMetadata(f.http,async()=>[]).trashState('file','rootId',f.options),ProviderError);}const f=fixture({file:info('file',{trashed:true,explicitlyTrashed:false})});const state=await new GoogleMetadata(f.http,async()=>[]).trashState('file','rootId',f.options);assert.equal(state.trashed,true);assert.equal(state.explicitlyTrashed,false);});
test('trash lifecycle projects only its validated private operation marker',async()=>{const marker='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',f=fixture({file:info('file',{trashed:true,explicitlyTrashed:true,appProperties:{yourwikiTrashOperation:marker,PRIVATE:'not exposed'}})}),m=new GoogleMetadata(f.http,async()=>[]),state=await m.trashState('file','rootId',f.options);assert.equal(state.operationId,marker);assert.equal(JSON.stringify(state).includes('not exposed'),false);});
test('owner-authorized reading accepts existing external sharing without importing its ACL',async()=>{
 const f=fixture({file:info('file',{shared:true})});f.http.permissions=async()=>{throw new Error('Existing Google recipients do not determine YourWiki read access');};
 const m=new GoogleMetadata(f.http,async()=>[],{allowExistingShares:true});assert.equal((await m.verify('file','rootId',f.options)).id,'file');
 for(const extra of [{ownedByMe:false},{capabilities:{canDownload:false}},{parents:['outside']}]){const denied=fixture({file:info('file',{shared:true,...extra})});await assert.rejects(new GoogleMetadata(denied.http,async()=>[],{allowExistingShares:true}).verify('file','rootId',denied.options),ProviderError);}
});
test('independent root and file metadata checks overlap without skipping either ownership check',async()=>{
 let release!:()=>void,started!:()=>void,fileStarted=false;const gate=new Promise<void>(resolve=>release=resolve),rootStarted=new Promise<void>(resolve=>started=resolve);
 const http={async file(id:string){if(id==='rootId'){started();await gate;}else fileStarted=true;return info(id);},async permissions(){return {permissions:[]};}};
 const pending=new GoogleMetadata(http,async()=>[]).verify('file','rootId',{check(){}});await rootStarted;await new Promise<void>(resolve=>setImmediate(resolve));const overlaps=fileStarted;release();const result=await pending;assert.equal(overlaps,true,'A network RTT for the root must not delay the independent file GET');assert.equal(result.id,'file');
});
test('write admission checks canEdit in the verified file metadata, never inferring it from ownership',async()=>{
 for(const value of [false,undefined]){const f=fixture({file:info('file',{capabilities:{canDownload:true,canEdit:value}})});await assert.rejects(new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options,true),{code:'ACCESS_DENIED'});}
 const f=fixture({file:info('file',{capabilities:{canDownload:true,canEdit:true}})});assert.equal((await new GoogleMetadata(f.http,async()=>[]).verify('file','rootId',f.options,true)).id,'file');
});
