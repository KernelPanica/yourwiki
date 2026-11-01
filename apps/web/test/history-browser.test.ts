import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HistoryBrowser,parseHistoryPage,parseHistoricalView,historicalAssetUrl} from '../src/history-browser.ts';
import {ApiError} from '../src/api.ts';
import {blockSession,resumeSession} from '../src/session-fence.ts';
const entry={id:9,documentId:'doc',kind:'source' as const,sourceRevision:1,layerRevision:null,sha256:'a'.repeat(64),size:3,title:'Old',format:'md',author:{id:null,name:'Former'},capturedAt:1000};
const page={schemaVersion:2,enabled:false,settingsRevision:1,document:{id:'doc',localRevision:2,publishedRevision:2,write:true,export:true},items:[entry],nextCursor:null};
const preparedId='00000000-0000-4000-8000-000000000001';
const view={preparedId,assetBase:'/api/documents/doc/history/9/previews/'+preparedId+'/assets/',document:{id:'doc',title:'Old',format:'md',revision:1,capabilities:{write:false,office:false,export:true}},entry,manifest:{schemaVersion:1,documentId:'doc',entryId:9,preparedId,converterVersion:'history-preview-v1',sourceDigest:entry.sha256,sourceSize:3,format:'md',kind:'document',primary:'content',artifacts:[{name:'content',digest:'b'.repeat(64),size:12,mimeType:'text/html',storage:'prepared'}]},presentation:null};
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>){resumeSession();const client=new HistoryBrowser({documentId:'doc',csrf:'csrf',request,poll:false});t.after(()=>client.dispose());return client;}
test('history pages are document-bound, bounded and immutable copied metadata',()=>{
 const parsed=parseHistoryPage(page,'doc');parsed.items[0].author.name='Changed';assert.equal(entry.author.name,'Former');for(const value of [{...page,document:{...page.document,id:'other'}},{...page,items:Array(51).fill(entry)},{...page,items:[entry,entry]},{...page,nextCursor:'8'},{...page,items:[{...entry,size:-1}]}])assert.throws(()=>parseHistoryPage(value,'doc'),/INVALID_HISTORY/);
});
test('history page navigation replaces bounded metadata and never prepares a preview automatically',async t=>{
 const calls:any[]=[],client=setup(t,async(url,init)=>{calls.push({url,init});return url.includes('after=9')?{...page,items:[{...entry,id:8}],nextCursor:null}:{...page,nextCursor:'9'};});await client.load();assert.equal(calls.length,1);assert.equal(calls[0].init?.method,undefined);await client.next();assert.equal(client.snapshot().page!.items.length,1);assert.equal(client.snapshot().page!.items[0].id,8);assert.match(calls[1].url,/after=9/);
});
test('preview requires an explicit CSRF action, validates read-only scoped assets, and does not write the document',async t=>{
 const calls:any[]=[],client=setup(t,async(url,init)=>{calls.push({url,init});if(url.endsWith('/view'))return view;if(url.endsWith('/preview'))return {state:'ready',preparedId,errorCode:null,converterVersion:'history-preview-v1'};return page;});await client.load();await client.preview(9);assert.equal(client.snapshot().previewState,'ready');assert.equal(calls[1].init.headers['x-csrf-token'],'csrf');assert.deepEqual(JSON.parse(calls[1].init.body),{retry:false});assert.equal(historicalAssetUrl(client.snapshot().view!,'content'),view.assetBase+'content');assert.equal(calls.some(call=>/restore|layer|\/save/.test(call.url)),false);for(const bad of [{...view,assetBase:'https://evil.test/'},{...view,document:{...view.document,capabilities:{...view.document.capabilities,write:true}}},{...view,entry:{...entry,id:8}}])assert.throws(()=>parseHistoricalView(bad,'doc',entry),/INVALID_HISTORY/);
});
test('lost preparation reply is resolved through GET status without replaying POST',async t=>{
 let posts=0;const client=setup(t,async(url,init)=>{if(init?.method==='POST'){posts++;throw new Error('lost');}if(url.endsWith('/preview'))return {state:'ready',preparedId,errorCode:null,converterVersion:'history-preview-v1'};return url.endsWith('/view')?view:page;});await client.load();await client.preview(9);assert.equal(client.snapshot().previewState,'unknown');await client.checkPreview();assert.equal(posts,1);assert.equal(client.snapshot().previewState,'ready');
});
test('download checks current export permission and uses a native URL without buffering original bytes',async t=>{
 let allowed=true;const client=setup(t,async url=>url.endsWith('/history?limit=50')?page:{...page,document:{...page.document,export:allowed},item:entry});await client.load();const links:string[]=[];await client.download(9,url=>links.push(url));assert.deepEqual(links,['/api/documents/doc/history/9/content']);allowed=false;await client.download(9,url=>links.push(url));assert.equal(links.length,1);assert.equal(client.snapshot().page!.document.export,false);
});
test('late previews cannot restore private content after account change or explicit close',async t=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise<unknown>(r=>resolve=r),client=setup(t,async(url,init)=>init?.method==='POST'?pending:page);await client.load();const loading=client.preview(9);blockSession();resolve({state:'ready',preparedId,errorCode:null,converterVersion:'history-preview-v1'});await loading;assert.equal(client.snapshot().page,null);assert.equal(client.snapshot().view,null);resumeSession();assert.equal(client.snapshot().page,null);
});
test('denied history clears links and any selected private view',async t=>{
 let denied=false;const client=setup(t,async()=>{if(denied)throw new ApiError('NOT_FOUND');return page;});await client.load();denied=true;await client.load();assert.equal(client.snapshot().page,null);assert.equal(client.snapshot().view,null);assert.equal(client.snapshot().errorCode,'NOT_FOUND');
});
test('historical asset URLs stay local even if a consumer mutates the returned view DTO',()=>{
 const parsed=parseHistoricalView(view,'doc',{...entry,kind:'source'});parsed.assetBase='https://evil.test/';assert.equal(historicalAssetUrl(parsed,'content'),view.assetBase+'content');
});
test('a late old selection cannot overwrite a newer archived preview',async t=>{
 let resolve!:(value:unknown)=>void;const pending=new Promise<unknown>(r=>resolve=r),next={...entry,id:8,title:'Other archive',sha256:'c'.repeat(64)},nextView={...view,assetBase:view.assetBase.replace('/9/','/8/'),entry:next,document:{...view.document,title:next.title},manifest:{...view.manifest,entryId:8,sourceDigest:next.sha256}};const client=setup(t,async(url,init)=>{if(init?.method==='POST')return {state:'ready',preparedId,errorCode:null,converterVersion:'history-preview-v1'};if(url.includes('/9/previews/'))return pending;if(url.includes('/8/previews/'))return nextView;return {...page,items:[entry,next]};});await client.load();const first=client.preview(9);await new Promise(resolve=>setTimeout(resolve,0));await client.preview(8);resolve(view);await first;assert.equal(client.snapshot().view!.entry.id,8);assert.equal(client.snapshot().selectedId,8);
});
test('document update hints refresh authority without unmounting an immutable archived view',async t=>{
 let changed=false;const client=setup(t,async(url,init)=>{if(init?.method==='POST')return {state:'ready',preparedId,errorCode:null,converterVersion:'history-preview-v1'};if(url.endsWith('/view'))return view;return {...page,document:{...page.document,localRevision:changed?3:2,publishedRevision:changed?3:2}};});await client.load();await client.preview(9);changed=true;await client.refreshAccess();assert.equal(client.snapshot().view!.preparedId,preparedId);assert.equal(client.snapshot().selectedId,9);assert.equal(client.snapshot().page!.document.localRevision,3);assert.equal(client.snapshot().updated,true);
});
test('revoked access clears a pending selection before its late preparation reply',async t=>{
 let denied=false,resolve!:(value:unknown)=>void;const pending=new Promise<unknown>(r=>resolve=r),client=setup(t,async(_url,init)=>{if(init?.method==='POST')return pending;if(denied)throw new ApiError('ACCESS_DENIED');return page;});await client.load();const preparing=client.preview(9);denied=true;await client.refreshAccess();assert.equal(client.snapshot().pendingId,null);assert.equal(client.snapshot().selectedId,null);resolve({state:'ready',preparedId,errorCode:null,converterVersion:'history-preview-v1'});await preparing;assert.equal(client.snapshot().view,null);
});
