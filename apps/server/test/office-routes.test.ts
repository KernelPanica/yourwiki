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
