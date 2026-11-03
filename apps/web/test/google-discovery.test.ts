import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleDiscoveryClient,parseGoogleDiscovery} from '../src/google-discovery.ts';
import {resumeSession,blockSession} from '../src/session-fence.ts';
import {ApiError} from '../src/api.ts';
const op='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',next='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const doc={id:'doc',name:'Заметки.xlsx',kind:'document',mimeType:'application/vnd.google-apps.document',version:'1',parents:['rootId'],size:null,md5:null,sha256:null,headRevision:null};
const result=(id=op)=>({operationId:id,state:'succeeded',hasMore:true,errorCode:null,page:{folderId:'rootId',items:[doc,{...doc,id:'folder',name:'Папка',kind:'folder',mimeType:'application/vnd.google-apps.folder'}]}});
const queued=(id=op)=>({operationId:id,state:'queued',hasMore:false,errorCode:null,page:null});
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>){resumeSession();const client=new GoogleDiscoveryClient({connectionId:'google',revision:2,csrf:'csrf',request,pollMs:60000});t.after(()=>client.dispose());return client;}
test('discovery starts only explicitly, polls cached metadata and follows private continuation receipts',async t=>{
 const calls:any[]=[],client=setup(t,async(url,init)=>{calls.push({url,init});return init?.method==='POST'?queued(calls.length>2?next:op):result(calls.length>2?next:op);});assert.equal(calls.length,0);await client.start();assert.equal(calls.length,1);assert.equal(calls[0].init.headers['x-csrf-token'],'csrf');const sent=JSON.parse(calls[0].init.body);assert.equal(sent.connectionId,'google');assert.equal(sent.baseRevision,2);assert.equal(sent.folderId,null);assert.equal(sent.previousOperationId,null);await client.check();assert.equal(client.snapshot().phase,'ready');assert.equal(client.snapshot().page?.items[0].kind,'document');assert.equal((client.snapshot().page?.items[0] as any).parents,undefined);await client.more();assert.equal(JSON.parse(calls[2].init.body).previousOperationId,op);assert.equal(client.snapshot().page?.items.length,2);await client.check();assert.equal(client.snapshot().operationId,next);
});
test('a lost admission acknowledgement is recovered with the exact original request, never a new operation',async t=>{
 const sent:string[]=[],client=setup(t,async(_url,init)=>{if(init?.method==='POST'){sent.push(String(init.body));if(sent.length===1)throw new Error('lost');return result();}throw new Error('unexpected');});await client.start();assert.equal(client.snapshot().phase,'unknown');await client.start();assert.equal(sent.length,1);await client.check();assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.equal(client.snapshot().phase,'ready');
});
test('folder navigation uses only an explicitly discovered folder and commits breadcrumbs after success',async t=>{
 let folder:string|null=null;const calls:any[]=[],client=setup(t,async(_url,init)=>{const v=JSON.parse(String(init?.body));calls.push(v);folder=v.folderId;return {...result(calls.length===1?op:next),hasMore:false,page:{folderId:folder??'rootId',items:folder?[]:result().page.items}};});await client.start();await client.enter('doc');assert.equal(calls.length,1);await client.enter('folder');assert.equal(client.snapshot().trail[0].name,'Папка');assert.equal(client.snapshot().page?.folderId,'folder');await client.root();assert.equal(client.snapshot().trail.length,0);assert.equal(folder,null);
});
test('revocation or disposal cannot reveal late private results and access denial clears cached names',async t=>{
 let release!:(value:unknown)=>void;const pending=new Promise<unknown>(r=>release=r),client=setup(t,()=>pending);const loading=client.start();blockSession();release(result());await loading;assert.equal(client.snapshot().phase,'blocked');assert.equal(client.snapshot().page,null);resumeSession();assert.equal(client.snapshot().page,null);
 let deny=false;const second=setup(t,async()=>{if(deny)throw new ApiError('ACCESS_DENIED');return result();});await second.start();deny=true;await second.start();assert.equal(second.snapshot().page,null);assert.equal(second.snapshot().phase,'blocked');
});
test('malformed or cross-operation receipts, unbounded pages and private cursor fields are refused',()=>{
 for(const bad of [{...result(),nextPageToken:'PRIVATE'},{...result(),operationId:next},{...result(),page:{folderId:'../outside',items:[]}},{...result(),page:{folderId:'rootId',items:[doc,doc]}},{...result(),page:{folderId:'rootId',items:Array.from({length:101},()=>doc)}},{...result(),state:'running'},{...result(),page:{folderId:'rootId',items:[{...doc,kind:'binary'}]}}])assert.throws(()=>parseGoogleDiscovery(bad,op));
});
test('concurrent clicks coalesce and snapshot edits cannot turn a document into a browsable folder',async t=>{
 let resolve!:(value:unknown)=>void,calls=0;const waiting=new Promise<unknown>(r=>resolve=r),client=setup(t,async()=>{calls++;return waiting;});const first=client.start();await client.start();assert.equal(calls,1);resolve(result());await first;const copy=client.snapshot();copy.page!.items[0].kind='folder';copy.page!.items[0].name='spoof';await client.enter('doc');assert.equal(calls,1);assert.equal(client.snapshot().page!.items[0].name,'Заметки.xlsx');
});
test('a mismatched folder result never replaces the last ready inventory and teardown fences late responses',async t=>{
 let release!:(value:unknown)=>void,calls=0;const waiting=new Promise<unknown>(r=>release=r),client=setup(t,async()=>++calls===1?result():waiting);await client.start();const entering=client.enter('folder');release({...result(next),page:{folderId:'outside',items:[{...doc,name:'PRIVATE OUTSIDE'}]}});await entering;assert.equal(client.snapshot().phase,'unknown');assert.equal(client.snapshot().page!.folderId,'rootId');assert.equal(JSON.stringify(client.snapshot()).includes('PRIVATE OUTSIDE'),false);client.dispose();assert.equal(client.snapshot().page,null);
});
test('private or malformed API error codes are never retained in discovery state',async t=>{const client=setup(t,async()=>{throw new ApiError('PRIVATE_PROVIDER_TOKEN');});await client.start();assert.equal(client.snapshot().errorCode,'REQUEST_FAILED');assert.equal(JSON.stringify(client.snapshot()).includes('PRIVATE_PROVIDER_TOKEN'),false);});
test('a failed worker receipt for changed connection clears the old inventory',async t=>{let count=0;const client=setup(t,async()=>++count===1?result():{...queued(next),state:'failed',errorCode:'PROVIDER_CONFIG_CHANGED'});await client.start();await client.start();assert.equal(client.snapshot().phase,'failed');assert.equal(client.snapshot().page,null);assert.equal(client.snapshot().hasMore,false);});
test('a known admission limit is shown as a refusal rather than an unknown acknowledgement',async t=>{const client=setup(t,async()=>{throw new ApiError('DISCOVERY_LIMIT');});await client.start();assert.equal(client.snapshot().phase,'failed');assert.equal(client.snapshot().errorCode,'DISCOVERY_LIMIT');});
