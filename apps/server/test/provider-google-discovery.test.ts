import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleDiscoveryReader} from '../src/providers/google-discovery.ts';
import {ProviderError} from '../src/providers/adapter.ts';
const native='application/vnd.google-apps.',scope={check(){}};
function file(id:string,extra:Record<string,unknown>={}){return {id,name:id,mimeType:native+'folder',version:'1',parents:id==='rootId'?[]:['rootId'],ownedByMe:true,shared:false,trashed:false,capabilities:{canDownload:true},...extra};}
function fixture(t:any){
 const files=new Map<string,Record<string,unknown>>([['rootId',file('rootId')],['folder',file('folder')]]),calls:URL[]=[],items=[file('doc',{name:'Документ.xlsx',mimeType:native+'document'}),file('sheet',{mimeType:native+'spreadsheet'}),file('slides',{mimeType:native+'presentation'}),file('blob',{name:'data.pdf',mimeType:'application/pdf',size:'3',md5Checksum:'a'.repeat(32)}),file('folder')];let next:unknown='opaque+/=cursor',incomplete:unknown=false,afterList=()=>{};
 const request:typeof fetch=async(url,init)=>{const u=new URL(String(url));calls.push(u);assert.equal(u.origin,'https://www.googleapis.com');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');if(u.pathname==='/drive/v3/files'){assert.equal(u.searchParams.get('q'),"'rootId' in parents and trashed = false and 'me' in owners");afterList();return Response.json({files:items,nextPageToken:next,incompleteSearch:incomplete});}const id=u.pathname.split('/').at(-1)!;return Response.json(files.get(id)!);};
 const reader=new GoogleDiscoveryReader('rootId',{access:async()=> 'SYNTHETIC',invalidate(){}},async()=>[],{fetch:request});t.after(()=>reader.close());return {reader,calls,items,files,request,setNext:(value:unknown)=>next=value,incomplete:(value:unknown)=>incomplete=value,afterList:(callback:()=>void)=>afterList=callback};
}
test('discovery lists only bounded current-root children and preserves native kinds independently of filenames',async t=>{
 const f=fixture(t),page=await f.reader.page({},scope);assert.equal(page.folderId,'rootId');assert.deepEqual(page.items.map(x=>x.kind),['document','spreadsheet','presentation','binary','folder']);assert.equal(page.items[0].name,'Документ.xlsx');assert.equal(page.nextPageToken,'opaque+/=cursor');assert.ok(Object.isFrozen(page.items));assert.ok(Object.isFrozen(page.items[0]));
 const listing=f.calls.find(x=>x.pathname==='/drive/v3/files')!;assert.equal(listing.searchParams.get('pageSize'),'100');assert.equal(listing.searchParams.get('spaces'),'drive');assert.equal(listing.searchParams.get('corpora'),'user');assert.ok(listing.searchParams.get('fields')?.includes('incompleteSearch'));await f.reader.page({pageToken:page.nextPageToken!},scope);assert.equal(f.calls.filter(x=>x.pathname==='/drive/v3/files').at(-1)!.searchParams.get('pageToken'),page.nextPageToken);
});
test('discovery refuses outsiders, duplicate IDs, missing names and incomplete or malformed page receipts',async t=>{
 for(const mode of ['parent','duplicate','name','incomplete','cursor','count','shortcut','trashed','owner']){const f=fixture(t);if(mode==='parent')f.items[0].parents=['outside'];if(mode==='duplicate')f.items.push(f.items[0]);if(mode==='name')Reflect.deleteProperty(f.items[0],'name');if(mode==='incomplete')f.incomplete(true);if(mode==='cursor')f.setNext('private\nvalue');if(mode==='count')while(f.items.length<101)f.items.push(file('extra'+f.items.length));if(mode==='shortcut')f.items[0].mimeType=native+'shortcut';if(mode==='trashed')f.items[0].trashed=true;if(mode==='owner')f.items[0].ownedByMe=false;await assert.rejects(f.reader.page({},scope),ProviderError);}
});
test('a moved or changed folder never returns a page from an obsolete hierarchy',async t=>{
 const f=fixture(t);f.afterList(()=>f.files.set('rootId',file('rootId',{version:'2'})));await assert.rejects(f.reader.page({},scope),{code:'PROVIDER_CONFLICT'});
 const g=fixture(t);g.files.set('outside',file('outside',{parents:[]}));g.files.set('folder',file('folder',{parents:['outside']}));await assert.rejects(g.reader.page({folderId:'folder'},scope),ProviderError);assert.equal(g.calls.some(x=>x.pathname==='/drive/v3/files'),false);
});
test('discovery cancellation and one whole-page deadline fence stalled authority before any IO',async t=>{
 const f=fixture(t),controller=new AbortController();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);const pending=f.reader.page({},{signal:controller.signal,check:()=>{entered();return gate;}});const denied=assert.rejects(pending,{code:'PROVIDER_CANCELLED'});await ready;controller.abort();await denied;release();assert.equal(f.calls.length,0);
 const timed=new GoogleDiscoveryReader('rootId',{access:async()=> 'SYNTHETIC',invalidate(){}},async()=>[],{fetch:f.request,totalMs:10});t.after(()=>timed.close());await assert.rejects(timed.page({},{check:()=>new Promise(()=>{})}),{code:'PROVIDER_UNAVAILABLE'});assert.equal(f.calls.length,0);
});
