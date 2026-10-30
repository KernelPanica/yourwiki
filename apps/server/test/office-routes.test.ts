import {Readable} from 'node:stream';
import {request as httpRequest} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService} from '../src/documents.ts';
import {JobQueue} from '../src/jobs.ts';
import {createSession,revokeSession} from '../src/auth/sessions.ts';
import {OfficeSessions} from '../src/office/sessions.ts';
import {OfficeIngress} from '../src/office/ingress.ts';
import {SaveJournal} from '../src/save-journal.ts';
import {buildApp} from '../src/app.ts';
async function* bytes(value:string){yield Buffer.from(value);}
const origin='https://wiki.example';
async function fixture(t:any,fetcher:typeof fetch=async()=>new Response('<wopi-discovery><net-zone><app><action ext="md" name="edit" urlsrc="https://ignored/collabora/browser/build/cool.html?"/></app></net-zone></wopi-discovery>')){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-office-http-')),db=openDatabase(':memory:');db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('one','one','First','!'),('two','two','Second','!'); INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('one','g'),('two','g')");
 const store=await BlobStore.open(root),docs=new DocumentService(db,store),doc=await docs.create({userId:'one',title:'Office',format:'md',parentId:null,groupId:'g'},bytes('office original'));
 const asset=await store.put(bytes('<p>Office</p>'),{maxBytes:100});await docs.publish(new JobQueue(db).claim(Date.now())!,{schemaVersion:1,documentId:doc.documentId,revision:1,sourceDigest:doc.blob.digest,converterVersion:'preview-v1',kind:'document',primary:'index.html',artifacts:[{...asset,name:'index.html',mimeType:'text/html'}]});
 const one=createSession(db,'one'),two=createSession(db,'two'),office=new OfficeSessions(db);
 const app=buildApp({database:db,storage:store,publicUrl:origin,office:{publicUrl:origin+'/collabora',fetch:fetcher}});
 t.after(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});
 const headers=(user=one)=>({cookie:'yourwiki_v2_session='+user.token,origin,'x-csrf-token':user.csrf});
 return {app,db,doc,office,one,two,headers,store};
}
test('readonly bootstrap uses configured action and WOPI base; cookies/CSRF protect browser mutations',async t=>{
 const f=await fixture(t),url=`/api/documents/${f.doc.documentId}/office`;
 assert.equal((await f.app.inject({method:'POST',url,payload:{readonly:true}})).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url,headers:{cookie:f.headers().cookie},payload:{readonly:true}})).statusCode,403);
 const opened=await f.app.inject({method:'POST',url,headers:f.headers(),payload:{readonly:true,language:'ru'}});assert.equal(opened.statusCode,200);const value=opened.json();
 const action=new URL(value.actionUrl);assert.equal(action.origin,origin);assert.equal(action.pathname,'/collabora/browser/build/cool.html');assert.equal(action.searchParams.get('lang'),'ru');assert.equal(action.searchParams.get('WOPISrc'),`${origin}/wopi/files/${value.sessionId}`);assert.equal(value.write,false);
 const info=await f.app.inject({url:`/wopi/files/${value.sessionId}?access_token=${value.accessToken}`});assert.equal(info.statusCode,200);assert.equal(info.json().BaseFileName,'Office.md');assert.equal(info.json().UserCanWrite,false);assert.equal(info.json().Size,15);assert.equal(info.headers['cache-control'],'no-store');
});
test('failed discovery never reserves an office session and unconfigured WOPI endpoints stay absent',async t=>{
 const f=await fixture(t,async()=>{throw new Error('private internal host detail');});const response=await f.app.inject({method:'POST',url:`/api/documents/${f.doc.documentId}/office`,headers:f.headers(),payload:{readonly:true}});
 assert.equal(response.statusCode,503);assert.equal(response.json().code,'OFFICE_UNAVAILABLE');assert.equal(response.body.includes('private'),false);assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM office_sessions').get() as any).n,0);
 const off=buildApp({database:f.db,storage:f.store});t.after(()=>off.close());assert.equal((await off.inject({url:'/wopi/files/unknown'})).statusCode,404);
});
test('WOPI reads stream exact local bytes and ranges without export; revoked scope/session fails',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId,false),url=`/wopi/files/${opened.sessionId}/contents?access_token=${opened.token}`;
 assert.equal((await f.app.inject({url})).body,'office original');const range=await f.app.inject({url,headers:{range:'bytes=2-5'}});assert.equal(range.statusCode,206);assert.equal(range.body,'fice');assert.equal(range.headers['content-range'],'bytes 2-5/15');
 assert.equal((await f.app.inject({url,headers:{range:'bytes=90-'}})).statusCode,416);
 f.db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(f.doc.documentId);assert.equal((await f.app.inject({url})).statusCode,200);
 const info=await f.app.inject({url:url.replace('/contents','')});assert.equal(info.json().DisableExport,true);assert.equal(info.json().DisableCopy,true);
 revokeSession(f.db,f.one.token);assert.equal((await f.app.inject({url})).statusCode,401);
});
test('WOPI HTTP locks share state and include current lock on conflicts',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId),url=`/wopi/files/${opened.sessionId}?access_token=${opened.token}`;
 const operation=(name:string,lock?:string,old?:string)=>f.app.inject({method:'POST',url,headers:{'x-wopi-override':name,...(lock?{'x-wopi-lock':lock}:{}),...(old?{'x-wopi-oldlock':old}:{})}});
 assert.equal((await operation('LOCK','first')).statusCode,200);const mismatch=await operation('LOCK','second');assert.equal(mismatch.statusCode,409);assert.equal(mismatch.headers['x-wopi-lock'],'first');
 assert.equal((await operation('LOCK','second','first')).statusCode,200);assert.equal((await operation('GET_LOCK')).headers['x-wopi-lock'],'second');assert.equal((await operation('UNLOCK','second')).statusCode,200);assert.equal((await operation('GET_LOCK')).headers['x-wopi-lock'],'');
});
test('browser recovery requires current author/admin and export rights even after office expiry',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId),blob=await f.store.put(bytes('retained office'),{maxBytes:100}),journal=new SaveJournal(f.db,f.store);
 await journal.stagePrepared({operationId:'http-office-recovery',userId:'one',documentId:f.doc.documentId,baseRevision:1,baseDigest:f.doc.blob.digest,blob,officeSessionId:opened.sessionId});f.db.prepare('UPDATE office_sessions SET pending_operation_id=?,expires_at=1 WHERE id=?').run('http-office-recovery',opened.sessionId);
 const url=`/api/office/${opened.sessionId}/recovery`;const recovered=await f.app.inject({url,headers:f.headers()});assert.equal(recovered.body,'retained office');assert.equal(recovered.headers['content-disposition'],'attachment; filename="office-recovery.md"');assert.equal((await f.app.inject({url,headers:f.headers(f.two)})).statusCode,403);
 f.db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(f.doc.documentId);assert.equal((await f.app.inject({url,headers:f.headers()})).statusCode,403);
});
test('release is bound to browser capability ownership and does not revoke another participant',async t=>{
 const f=await fixture(t),a=f.office.open(f.one.token,f.doc.documentId,false),b=f.office.open(f.two.token,f.doc.documentId,false),url=`/api/office/${a.sessionId}/release`;
 assert.equal((await f.app.inject({method:'POST',url,headers:f.headers(f.two),payload:{accessToken:a.token}})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url,headers:f.headers(),payload:{accessToken:a.token}})).statusCode,204);
 assert.equal((await f.app.inject({url:`/wopi/files/${a.sessionId}?access_token=${a.token}`})).statusCode,401);
 assert.equal((await f.app.inject({url:`/wopi/files/${b.sessionId}?access_token=${b.token}`})).statusCode,200);
 assert.equal((await f.app.inject({method:'POST',url,headers:f.headers(f.two),payload:{accessToken:b.token}})).statusCode,204);
 assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM office_tokens').get() as {n:number}).n,0);
});
test('editing bootstrap is explicitly unavailable until PutFile is installed and octet-stream lock requests work',async t=>{
 const f=await fixture(t);const response=await f.app.inject({method:'POST',url:`/api/documents/${f.doc.documentId}/office`,headers:f.headers(),payload:{}});
 assert.equal(response.statusCode,503);assert.equal(response.json().code,'OFFICE_NOT_READY');assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM office_sessions').get() as any).n,0);
 const opened=f.office.open(f.one.token,f.doc.documentId);const lock=await f.app.inject({method:'POST',url:`/wopi/files/${opened.sessionId}?access_token=${opened.token}`,headers:{'content-type':'application/octet-stream','x-wopi-override':'LOCK','x-wopi-lock':'octet-lock'},payload:''});assert.equal(lock.statusCode,200);
});
test('real HTTP WOPI metadata and partial file reads enforce token authentication',async t=>{
 const f=await fixture(t),opened=f.office.open(f.one.token,f.doc.documentId,false);const address=await f.app.listen({host:'127.0.0.1',port:0});
 const url=`${address}/wopi/files/${opened.sessionId}`;const unauth=await fetch(url);assert.equal(unauth.status,401);await unauth.arrayBuffer();
 const info=await fetch(url+'?access_token='+opened.token);assert.equal(info.status,200);assert.equal((await info.json() as {ReadOnly:boolean}).ReadOnly,true);
 const file=await fetch(url+'/contents?access_token='+opened.token,{headers:{range:'bytes=-8'}});assert.equal(file.status,206);assert.equal(await file.text(),'original');assert.equal(file.headers.get('cache-control'),'no-store');
});

async function pending(f:any,value='recovery bytes',user=f.one){
 const opened=f.office.open(user.token,f.doc.documentId);f.office.lock(opened.sessionId,opened.token,'LOCK','recover-lock');
 const ingress=new OfficeIngress(f.db,f.store);const receipt=await ingress.receive({sessionId:opened.sessionId,token:opened.token,lock:'recover-lock',declaredSize:Buffer.byteLength(value)},bytes(value));return {ingress,receipt};
}
test('prepared office recovery is listed and streamed by cookie after the editor expires, without exposing storage capabilities',async t=>{
 const f=await fixture(t),{receipt}=await pending(f);f.db.prepare('UPDATE office_sessions SET expires_at=1 WHERE id=?').run(receipt.sessionId);
 const listing=await f.app.inject({url:`/api/documents/${f.doc.documentId}/office-recovery`,headers:f.headers()});assert.equal(listing.statusCode,200);const item=listing.json().items[0];assert.equal(item.id,receipt.id);assert.equal(item.state,'prepared');assert.equal(item.download,true);assert.equal(JSON.stringify(item).includes('digest'),false);assert.equal(JSON.stringify(item).includes('lease'),false);
 const url=`/api/office-recovery/${receipt.id}/contents`,file=await f.app.inject({url,headers:{...f.headers(),range:'bytes=0-7'}});assert.equal(file.statusCode,206);assert.equal(file.body,'recovery');assert.equal(file.headers['cache-control'],'no-store');assert.match(file.headers['content-disposition']!,/attachment/);
 assert.equal((await f.app.inject({url})).statusCode,401);assert.equal((await f.app.inject({url,headers:f.headers(f.two)})).statusCode,404);
});
test('recovery metadata respects ownership and download checks current export permission',async t=>{
 const f=await fixture(t),{receipt}=await pending(f),url=`/api/office-recovery/${receipt.id}`;
 assert.equal((await f.app.inject({url,headers:f.headers(f.two)})).statusCode,404);
 f.db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(f.doc.documentId);
 assert.equal((await f.app.inject({url,headers:f.headers()})).json().download,false);assert.equal((await f.app.inject({url:url+'/contents',headers:f.headers()})).statusCode,403);
 const list=await f.app.inject({url:`/api/documents/${f.doc.documentId}/office-recovery`,headers:f.headers(f.two)});assert.deepEqual(list.json().items,[]);
});
test('discard is CSRF protected, author scoped and tombstones recovery without changing the original',async t=>{
 const f=await fixture(t),{receipt}=await pending(f),url=`/api/office-recovery/${receipt.id}/discard`;
 assert.equal((await f.app.inject({method:'POST',url,headers:{cookie:f.headers().cookie}})).statusCode,403);
 assert.equal((await f.app.inject({method:'POST',url,headers:f.headers(f.two)})).statusCode,404);
 assert.equal((await f.app.inject({method:'POST',url,headers:f.headers()})).statusCode,204);
 assert.equal((await f.app.inject({url:`/api/office-recovery/${receipt.id}/contents`,headers:f.headers()})).statusCode,404);
 assert.equal(await f.store.existingUploadStore(receipt.id),null);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
test('only giga admins can inspect and discard another author recovery; list uses bounded keyset pages',async t=>{
 const f=await fixture(t),first=await pending(f,'first'),second=await pending(f,'second');const url=`/api/office-recovery/${first.receipt.id}`;
 f.db.prepare("UPDATE users SET admin_role='simple' WHERE id='two'").run();assert.equal((await f.app.inject({url,headers:f.headers(f.two)})).statusCode,404);
 f.db.prepare("UPDATE users SET admin_role='giga' WHERE id='two'").run();assert.equal((await f.app.inject({url,headers:f.headers(f.two)})).statusCode,200);
 const base=`/api/documents/${f.doc.documentId}/office-recovery`,one=(await f.app.inject({url:base+'?limit=1',headers:f.headers(f.two)})).json();assert.equal(one.items.length,1);assert.ok(one.nextCursor);
 const two=(await f.app.inject({url:base+'?limit=1&cursor='+one.nextCursor,headers:f.headers(f.two)})).json();assert.equal(two.items.length,1);assert.notEqual(two.items[0].id,one.items[0].id);assert.equal(two.nextCursor,null);
 assert.equal((await f.app.inject({method:'POST',url:url+'/discard',headers:f.headers(f.two)})).statusCode,204);assert.notEqual(await f.store.existingUploadStore(second.receipt.id),null);
});

test('export revocation while recovery bytes open closes the stream instead of sending the snapshot',async t=>{
 const f=await fixture(t),{receipt}=await pending(f),existing=f.store.existingUploadStore.bind(f.store);let opened=false;
 f.store.existingUploadStore=async id=>{const namespace=await existing(id);if(namespace){const read=namespace.read.bind(namespace);namespace.read=async(...args)=>{const stream=await read(...args);opened=true;f.db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(f.doc.documentId);return stream;};}return namespace;};
 const response=await f.app.inject({url:`/api/office-recovery/${receipt.id}/contents`,headers:f.headers()});assert.equal(opened,true);assert.equal(response.statusCode,403);assert.equal(response.body.includes('recovery bytes'),false);
});

test('giga discard cancels the original author journal even after that author loses access',async t=>{
 const f=await fixture(t),{receipt,ingress}=await pending(f),namespace=await ingress.payloadStore('one',receipt.id),blob=await f.store.adopt(namespace,receipt.blob!),journal=new SaveJournal(f.db,f.store);
 await journal.stagePrepared({operationId:receipt.id,userId:'one',documentId:f.doc.documentId,officeSessionId:receipt.sessionId,baseRevision:receipt.baseRevision,baseDigest:receipt.baseDigest,blob});
 f.db.prepare('UPDATE office_sessions SET pending_operation_id=? WHERE id=?').run(receipt.id,receipt.sessionId);f.db.prepare("UPDATE users SET active=0 WHERE id='one'").run();f.db.prepare("UPDATE users SET admin_role='giga' WHERE id='two'").run();
 assert.equal((await f.app.inject({method:'POST',url:`/api/office-recovery/${receipt.id}/discard`,headers:f.headers(f.two)})).statusCode,204);
 assert.notEqual((f.db.prepare('SELECT cancelled_at FROM save_operations WHERE id=?').get(receipt.id) as any).cancelled_at,null);assert.equal((f.db.prepare('SELECT pending_operation_id FROM office_sessions WHERE id=?').get(receipt.sessionId) as any).pending_operation_id,null);assert.equal(await f.store.existingUploadStore(receipt.id),null);
});

async function writer(f:any){const opened=f.office.open(f.one.token,f.doc.documentId);f.office.lock(opened.sessionId,opened.token,'LOCK','save-lock');const base=`/wopi/files/${opened.sessionId}?access_token=${opened.token}`,info=(await f.app.inject({url:base})).json();return {opened,url:`/wopi/files/${opened.sessionId}/contents?access_token=${opened.token}`,headers:{'content-type':'application/octet-stream','x-wopi-override':'PUT','x-wopi-lock':'save-lock','x-cool-wopi-timestamp':info.LastModifiedTime}};}
test('HTTP PutFile saves local bytes, returns WOPI version/time and acknowledges a lost-response retry once',async t=>{
 const f=await fixture(t),w=await writer(f);const first=await f.app.inject({method:'POST',url:w.url,headers:w.headers,payload:'changed'});assert.equal(first.statusCode,200);assert.match(String(first.headers['x-wopi-itemversion']),/^2:/);assert.ok(first.json().LastModifiedTime);
 const retry=await f.app.inject({method:'POST',url:w.url,headers:w.headers,payload:'changed'});assert.equal(retry.statusCode,200);assert.equal(retry.headers['x-wopi-itemversion'],first.headers['x-wopi-itemversion']);assert.equal(retry.json().LastModifiedTime,first.json().LastModifiedTime);assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,2);
});
test('HTTP PutFile differentiates lock mismatch from document change and exposes recoverable operation identity',async t=>{
 const f=await fixture(t),w=await writer(f);
 const locked=await f.app.inject({method:'POST',url:w.url,headers:{...w.headers,'x-wopi-lock':'wrong'},payload:'changed'});assert.equal(locked.statusCode,409);assert.equal(locked.headers['x-wopi-lock'],'save-lock');assert.equal(locked.json().COOLStatusCode,undefined);
 const first=await f.app.inject({method:'POST',url:w.url,headers:w.headers,payload:'first'});assert.equal(first.statusCode,200);
 const conflict=await f.app.inject({method:'POST',url:w.url,headers:w.headers,payload:'second'});assert.equal(conflict.statusCode,409);assert.equal(conflict.json().COOLStatusCode,1010);assert.equal(conflict.headers['x-wopi-lock'],'save-lock');assert.ok(conflict.json().operationId);
 const recovery=await f.app.inject({url:`/api/office-recovery/${conflict.json().operationId}/contents`,headers:f.headers()});assert.equal(recovery.body,'second');
 const undo=await f.app.inject({method:'POST',url:w.url,headers:{...w.headers,'x-cool-wopi-timestamp':first.json().LastModifiedTime},payload:'office original'});assert.equal(undo.statusCode,200);assert.match(String(undo.headers['x-wopi-itemversion']),/^3:/);
});
test('HTTP PutFile accepts legacy timestamp, refuses readonly and invalid content/override before mutation',async t=>{
 const f=await fixture(t),w=await writer(f),{'x-cool-wopi-timestamp':timestamp,...headers}=w.headers;
 const saved=await f.app.inject({method:'POST',url:w.url,headers:{...headers,'x-lool-wopi-timestamp':timestamp},payload:'legacy'});assert.equal(saved.statusCode,200);
 const readonly=f.office.open(f.two.token,f.doc.documentId,false),url=`/wopi/files/${readonly.sessionId}/contents?access_token=${readonly.token}`;assert.equal((await f.app.inject({method:'POST',url,headers:w.headers,payload:'bad'})).statusCode,403);
 assert.equal((await f.app.inject({method:'POST',url:w.url,headers:{...w.headers,'x-wopi-override':'RENAME_FILE'},payload:'bad'})).statusCode,501);
 assert.equal((await f.app.inject({method:'POST',url:w.url,headers:{...w.headers,'content-type':'application/json'},payload:'{}'})).statusCode,415);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,2);
});


test('real HTTP PutFile streams beyond the ordinary JSON body limit and reports saved size',async t=>{
 const f=await fixture(t),w=await writer(f),address=await f.app.listen({host:'127.0.0.1',port:0});
 async function* payload(){for(let i=0;i<32;i++)yield Buffer.alloc(65536,'x');}
 const response=await fetch(address+w.url,{method:'POST',headers:w.headers,body:Readable.from(payload()),duplex:'half'} as any);assert.equal(response.status,200);assert.ok((await response.json() as any).LastModifiedTime);
 assert.equal((f.db.prepare('SELECT size FROM document_versions WHERE revision=2').get() as any).size,2097152);
});
test('configured office upload limits return a clear error and invalid complete bytes remain recoverable',async t=>{
 const f=await fixture(t),w=await writer(f),limited=buildApp({database:f.db,storage:f.store,publicUrl:origin,maxFileBytes:8,office:{publicUrl:origin+'/collabora'}});t.after(()=>limited.close());
 const oversized=await limited.inject({method:'POST',url:w.url,headers:w.headers,payload:'123456789'});assert.equal(oversized.statusCode,413);assert.equal(oversized.json().code,'PAYLOAD_TOO_LARGE');assert.equal(f.db.prepare('SELECT 1 FROM office_ingress').get(),undefined);
 const malformed=await limited.inject({method:'POST',url:w.url,headers:w.headers,payload:Buffer.from([0,1,2])});assert.equal(malformed.statusCode,422);assert.equal(malformed.json().code,'INVALID_OFFICE_FILE');assert.ok(malformed.json().operationId);
 assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
test('real HTTP disconnect cancels a partial office upload and releases its reservation',async t=>{
 const f=await fixture(t),w=await writer(f),address=await f.app.listen({host:'127.0.0.1',port:0});
 const request=httpRequest(address+w.url,{method:'POST',headers:{...w.headers,'content-length':'100'}});request.on('error',()=>{});request.write('partial');
 const wait=async(predicate:()=>boolean)=>{const until=Date.now()+2000;while(!predicate()){if(Date.now()>until)throw new Error('upload state did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};
 await wait(()=>!!f.db.prepare("SELECT 1 FROM office_ingress WHERE state='receiving'").get());request.destroy();
 await wait(()=>!!f.db.prepare("SELECT 1 FROM office_ingress WHERE state='failed' AND reserved_bytes=0").get());assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});


test('chunked PutFile enforces the configured bound without Content-Length and rejects conflicting timestamp headers',async t=>{
 const f=await fixture(t),w=await writer(f),limited=buildApp({database:f.db,storage:f.store,publicUrl:origin,maxFileBytes:8,office:{publicUrl:origin+'/collabora'}});t.after(()=>limited.close());
 const address=await limited.listen({host:'127.0.0.1',port:0});async function* chunks(){yield Buffer.from('1234');yield Buffer.from('56789');}
 const response=await fetch(address+w.url,{method:'POST',headers:w.headers,body:Readable.from(chunks()),duplex:'half'} as any);assert.equal(response.status,413);assert.equal((await response.json() as any).code,'PAYLOAD_TOO_LARGE');
 assert.equal((f.db.prepare('SELECT SUM(reserved_bytes) AS n FROM office_ingress').get() as any).n,0);
 const invalid=await limited.inject({method:'POST',url:w.url,headers:{...w.headers,'x-lool-wopi-timestamp':'different'},payload:'abc'});assert.equal(invalid.statusCode,400);assert.equal(invalid.json().code,'INVALID_REQUEST');assert.equal((f.db.prepare('SELECT local_revision FROM documents').get() as any).local_revision,1);
});
