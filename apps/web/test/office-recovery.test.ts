import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfficeRecovery,parseRecoveryPage} from '../src/office-recovery.ts';
import {ApiError} from '../src/api.ts';
import {blockSession,resumeSession} from '../src/session-fence.ts';
const item={id:'copy-a',sessionId:'room',documentId:'doc',authorId:'user',state:'prepared',baseRevision:1,size:42,errorCode:'CONFLICT',download:true,discard:true};
const page={items:[item],nextCursor:null};
function deferred(){let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};}
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>){resumeSession();const model=new OfficeRecovery({documentId:'doc',csrf:'csrf',request});t.after(()=>model.dispose());return model;}
test('recovery pages validate bounded sorted document-bound metadata and copy their input',()=>{
 const value=parseRecoveryPage(page,'doc');value.items[0].download=false;assert.equal(item.download,true);
 for(const bad of [{...page,items:[{...item,documentId:'other'}]},{...page,items:[item,item]},{...page,items:[{...item,download:'true'}]},{...page,items:[{...item,state:'receiving',download:true}]},{...page,nextCursor:'wrong'},{...page,items:Array(51).fill(item)}])assert.throws(()=>parseRecoveryPage(bad,'doc'),/INVALID_OFFICE_RECOVERY/);
});
test('a page request is single-flight and next pages replace metadata instead of growing unbounded',async t=>{
 const calls:any[]=[];const model=setup(t,async(url,init)=>{calls.push({url,init});return calls.length===1?{...page,nextCursor:'copy-a'}:{items:[{...item,id:'copy-b'}],nextCursor:null};});await Promise.all([model.load(),model.load()]);assert.equal(calls.length,1);await model.next();assert.match(calls[1].url,/cursor=copy-a/);assert.equal(model.snapshot().items.length,1);assert.equal(model.snapshot().items[0].id,'copy-b');assert.equal(model.snapshot().nextCursor,null);
});
test('a stale page arriving after an account change cannot restore private recovery metadata',async t=>{
 const response=deferred(),model=setup(t,()=>response.promise),loading=model.load();blockSession();response.resolve(page);await loading;assert.deepEqual(model.snapshot().items,[]);assert.equal(model.snapshot().blocked,true);
});
test('download rechecks current export permission and uses a native URL without buffering file bytes',async t=>{
 let allowed=true;const calls:any[]=[];const model=setup(t,async(url,init)=>{calls.push({url,init});return url.includes('/office-recovery?')?page:{...item,download:allowed};});await model.load();const started:string[]=[];await model.download(item.id,url=>started.push(url));assert.deepEqual(started,['/api/office-recovery/copy-a/contents']);allowed=false;await model.download(item.id,url=>started.push(url));assert.equal(started.length,1);assert.equal(calls.some(call=>call.url.endsWith('/contents')),false);
});
test('late download permission after session invalidation cannot start a native download',async t=>{
 const response=deferred(),model=setup(t,async url=>url.includes('/office-recovery?')?page:response.promise);await model.load();let started=0;const downloading=model.download(item.id,()=>{started++;});blockSession();response.resolve(item);await downloading;assert.equal(started,0);
});
test('discard is explicit, rechecks metadata, sends CSRF and never saves a document',async t=>{
 const calls:any[]=[];const model=setup(t,async(url,init)=>{calls.push({url,init});return url.includes('/office-recovery?')?page:init?.method==='POST'?undefined:item;});await model.load();assert.equal(calls.some(c=>c.init?.method==='POST'),false);await model.discard(item.id);assert.equal(model.snapshot().items.length,0);const post=calls.find(c=>c.init?.method==='POST');assert.equal(post.url,'/api/office-recovery/copy-a/discard');assert.equal(post.init.headers['x-csrf-token'],'csrf');assert.equal(calls.some(c=>/save|\/content$/.test(c.url)),false);
});
test('a lost discard acknowledgement retains the copy and never automatically retries the mutation',async t=>{
 let posts=0;const model=setup(t,async(url,init)=>{if(url.includes('/office-recovery?'))return page;if(init?.method==='POST'){posts++;throw new Error('reply lost');}return item;});await model.load();await model.discard(item.id);await new Promise(r=>setTimeout(r,20));assert.equal(posts,1);assert.equal(model.snapshot().items.length,1);assert.equal(model.snapshot().errorCode,'RECOVERY_DISCARD_UNCERTAIN');
});
test('committed copies cannot be discarded and access denial clears stale links',async t=>{
 let denied=false,posts=0;const model=setup(t,async(url,init)=>{if(url.includes('/office-recovery?'))return page;if(denied)throw new ApiError('ACCESS_DENIED');if(init?.method==='POST')posts++;return {...item,state:'committed',download:false,discard:false};});await model.load();await model.discard(item.id);assert.equal(posts,0);await model.load();assert.equal(model.snapshot().items.length,1);denied=true;await model.download(item.id,()=>assert.fail('must not download'));assert.deepEqual(model.snapshot().items,[]);
});
test('recovery timestamps survive parsing and invalid dates are rejected without breaking older API metadata',()=>{
 assert.equal(parseRecoveryPage(page,'doc').items[0].createdAt,null);assert.equal(parseRecoveryPage({items:[{...item,createdAt:1700000000000}],nextCursor:null},'doc').items[0].createdAt,1700000000000);assert.throws(()=>parseRecoveryPage({items:[{...item,createdAt:9e15}],nextCursor:null},'doc'),/INVALID_OFFICE_RECOVERY/);
});
test('a missing discard route during an update retains the copy and reports uncertainty rather than confirming deletion',async t=>{
 const model=setup(t,async(url,init)=>{if(url.includes('/office-recovery?'))return page;if(init?.method==='POST')throw new ApiError('NOT_FOUND');return item;});await model.load();await model.discard(item.id);assert.equal(model.snapshot().items.length,1);assert.equal(model.snapshot().errorCode,'RECOVERY_DISCARD_UNCERTAIN');
});
test('discard is single-flight and a late acknowledgement cannot restore metadata after session invalidation',async t=>{
 const posted=deferred();let posts=0,reads=0;const model=setup(t,async(url,init)=>{if(url.includes('/office-recovery?'))return page;if(init?.method==='POST'){posts++;return posted.promise;}reads++;return item;});await model.load();const discarding=model.discard(item.id);await Promise.resolve();await Promise.resolve();await model.discard(item.id);assert.equal(posts,1);assert.equal(reads,1);blockSession();posted.resolve(undefined);await discarding;assert.equal(model.snapshot().blocked,true);assert.deepEqual(model.snapshot().items,[]);
});
