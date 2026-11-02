import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HistoryImportClient} from '../src/history-import-client.ts';
import {ApiError} from '../src/api.ts';
import {resumeSession,blockSession} from '../src/session-fence.ts';
const sha='a'.repeat(64),file=new Blob(['archive']),sourceKey='manual:sha256:'+sha;
function operation(state='pending',id='import-client-one'){return {operationId:id,documentId:'doc',sourceKey,archiveSha256:sha,archiveSize:file.size,state,errorCode:null,entries:state==='prepared'||state==='committed'?2:0,totalBytes:state==='prepared'||state==='committed'?3:0,receipt:state==='committed'?{entries:2,totalBytes:3,firstEntryId:10,lastEntryId:11,archiveSha256:sha,archiveSize:file.size}:null};}
function memory(){const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>,extra:Record<string,unknown>={}){resumeSession();const storage=memory(),committed:unknown[]=[],client=new HistoryImportClient({accountId:'admin',documentId:'doc',csrf:'csrf',storage,request,hash:async(_file:Blob,_signal:AbortSignal,progress:(n:number)=>void)=>{progress(file.size);return sha;},operationId:()=> 'import-client-one',committed:value=>committed.push(value),...extra});t.after(()=>client.dispose());return {client,storage,committed};}
test('file selection hashes locally; explicit upload stages a raw Blob and separate explicit publication commits once',async t=>{
 let state='pending';const calls:any[]=[],{client,committed,storage}=setup(t,async(url,init)=>{calls.push({url,init});return operation(state=url.endsWith('/content')?'prepared':url.endsWith('/commit')?'committed':state);});await client.select(file,'archive.json');assert.equal(calls.length,0);assert.equal(client.snapshot().phase,'ready');await client.upload();assert.equal(client.snapshot().phase,'prepared');assert.equal(calls.length,2);assert.equal(calls[1].init.body,file);assert.equal(calls[1].init.headers['content-type'],'application/octet-stream');assert.equal(calls[1].init.headers['x-csrf-token'],'csrf');assert.equal(committed.length,0);await client.publish();assert.equal(client.snapshot().phase,'committed');assert.equal(calls.filter(x=>x.url.endsWith('/commit')).length,1);assert.equal(storage.values.size,0);assert.equal(committed.length,1);
});
test('a lost upload reply checks status with GET and never repeats the content write',async t=>{
 let writes=0;const {client}=setup(t,async(url,init)=>{if(init?.method){writes++;if(init.method==='PUT')throw new Error('lost');return operation();}return operation('prepared');});await client.select(file);await client.upload();assert.equal(client.snapshot().phase,'prepared');assert.equal(writes,2);
});
test('a lost publication ACK is read back as committed, without duplicate POST',async t=>{
 let state='pending',posts=0;const {client,committed}=setup(t,async(url,init)=>{if(init?.method==='PUT')return operation(state='prepared');if(init?.method==='POST'){posts++;if(url.endsWith('/commit')){state='committed';throw new Error('lost');}}return operation(state);});await client.select(file);await client.upload();await client.publish();assert.equal(client.snapshot().phase,'committed');assert.equal(posts,2);assert.equal(committed.length,1);await client.check();assert.equal(committed.length,1);
});
test('reload journal checks only; prepared imports publish without reselecting or reuploading the file',async t=>{
 const storage=memory();storage.setItem('yourwiki:history-import:admin:doc',JSON.stringify({schemaVersion:1,operationId:'import-client-one',archiveSha256:sha,archiveSize:file.size}));let writes=0;const {client}=setup(t,async(_url,init)=>{if(init?.method){writes++;return operation('committed');}return operation('prepared');},{storage});assert.equal(client.snapshot().phase,'recovery');await client.check();assert.equal(writes,0);await client.publish();assert.equal(writes,1);assert.equal(client.snapshot().phase,'committed');
});
test('unreadable or unwritable journals refuse mutations and mismatched server scope cannot be adopted',async t=>{
 for(const storage of [{getItem:()=>'{bad',setItem:()=>{},removeItem:()=>{}},{getItem:()=>null,setItem:()=>{throw Error('quota');},removeItem:()=>{}}]){let posts=0;const {client}=setup(t,async()=>{posts++;return operation();},{storage});await client.select(file);await client.upload();assert.equal(posts,0);assert.equal(client.snapshot().errorCode,'HISTORY_JOURNAL_UNAVAILABLE');}
 const {client}=setup(t,async()=>({...operation(),documentId:'other'}));await client.select(file);await client.upload();assert.equal(client.snapshot().phase,'unknown');assert.equal(client.snapshot().operation,null);
});
test('deduplication adopts only the fingerprint-bound server operation and persists its actual ID before any upload',async t=>{
 const calls:any[]=[],{client,storage}=setup(t,async(url,init)=>{calls.push({url,init});return operation(url.endsWith('/content')?'prepared':'pending','import-earlier-one');});await client.select(file);await client.upload();assert.equal(client.snapshot().phase,'prepared');assert.ok(calls[1].url.endsWith('/import-earlier-one/content'));assert.equal(JSON.parse([...storage.values.values()][0]).operationId,'import-earlier-one');
});
test('unknown intent is checked before explicit retry; missing intent reuses its durable ID',async t=>{
 let exists=false,begins=0,puts=0;const {client}=setup(t,async(url,init)=>{if(init?.method==='POST'){begins++;if(begins===1)throw Error('not sent');exists=true;return operation();}if(init?.method==='PUT'){puts++;return operation('prepared');}if(!exists)throw new ApiError('NOT_FOUND');return operation();});await client.select(file);await client.upload();assert.equal(client.snapshot().phase,'missing');assert.equal(begins,1);assert.equal(puts,0);await client.upload();assert.equal(begins,2);assert.equal(puts,1);assert.equal(client.snapshot().operation?.operationId,'import-client-one');
});
test('reselected file must match a recovered fingerprint; late hash replies after session loss are ignored',async t=>{
 const storage=memory();storage.setItem('yourwiki:history-import:admin:doc',JSON.stringify({schemaVersion:1,operationId:'import-client-one',archiveSha256:sha,archiveSize:file.size}));const {client}=setup(t,async()=>operation(),{storage,hash:async()=> 'b'.repeat(64)});await client.select(file);assert.equal(client.snapshot().fileSelected,false);assert.equal(client.snapshot().errorCode,'HISTORY_ARCHIVE_MISMATCH');
 let done!:(value:string)=>void;const delayed=setup(t,async()=>operation(),{hash:()=>new Promise<string>(resolve=>done=resolve)}).client;const selecting=delayed.select(file,'private-name.json');blockSession();done(sha);await selecting;assert.equal(delayed.snapshot().phase,'blocked');assert.equal(delayed.snapshot().fileName,null);assert.equal(delayed.snapshot().operation,null);
});
test('only a confirmed failed import may be forgotten locally to select a corrected archive',async t=>{
 let failed=false,writes=0;const {client}=setup(t,async(_url,init)=>{if(init?.method){writes++;if(init.method==='PUT'){failed=true;throw new ApiError('HISTORY_ARCHIVE_INVALID');}}return {...operation(failed?'failed':'pending'),errorCode:failed?'HISTORY_ARCHIVE_INVALID':null};});await client.select(file);await client.upload();assert.equal(client.snapshot().phase,'failed');client.forgetFailed();assert.equal(client.snapshot().phase,'idle');assert.equal(writes,2);await client.select(file);assert.equal(client.snapshot().phase,'ready');
});
test('quota refusal before intent creation keeps the useful error after a missing-status check',async t=>{
 let writes=0;const {client}=setup(t,async(_url,init)=>{if(init?.method){writes++;throw new ApiError('HISTORY_IMPORT_QUOTA');}throw new ApiError('NOT_FOUND');});await client.select(file);await client.upload();assert.equal(writes,1);assert.equal(client.snapshot().phase,'missing');assert.equal(client.snapshot().errorCode,'HISTORY_IMPORT_QUOTA');
});
test('an invalid new selection cannot leave the previous file armed for upload',async t=>{
 let writes=0;const {client}=setup(t,async()=>{writes++;return operation();});await client.select(file,'good.json');await client.select(new Blob([]),'empty.json');await client.upload();assert.equal(writes,0);assert.equal(client.snapshot().fileSelected,false);assert.equal(client.snapshot().errorCode,'HISTORY_ARCHIVE_LIMIT');
});
test('a busy publication preserves its actionable error when read-back still reports prepared',async t=>{
 let writes=0;const {client}=setup(t,async(url,init)=>{if(init?.method){writes++;if(url.endsWith('/commit'))throw new ApiError('HISTORY_IMPORT_BUSY');}return operation(init?.method==='POST'&&!url.endsWith('/commit')?'pending':'prepared');});await client.select(file);await client.upload();await client.publish();assert.equal(writes,3);assert.equal(client.snapshot().phase,'prepared');assert.equal(client.snapshot().errorCode,'HISTORY_IMPORT_BUSY');
});
