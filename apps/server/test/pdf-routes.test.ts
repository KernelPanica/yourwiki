import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import { DocumentService } from '../src/documents.ts';
import { buildApp } from '../src/app.ts';
import { createSession } from '../src/auth/sessions.ts';
async function* bytes(value: string) { yield Buffer.from(value); }
const origin = 'https://wiki.test';
async function setup(t: any) {
 const root = await mkdtemp(join(tmpdir(), 'yourwiki-pdf-api-')), db = openDatabase(':memory:');
 db.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('other','other','Other','!');
 INSERT INTO groups(id,name) VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('other','team');`);
 const store = await BlobStore.open(root), docs = new DocumentService(db,store);
 const doc = await docs.create({userId:'owner',parentId:null,groupId:'team',title:'PDF',format:'pdf'},bytes('%PDF-1.7 original'));
 const app = buildApp({database:db,storage:store,publicUrl:origin,maxFileBytes:100});
 t.after(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});
 const sessions = Object.fromEntries(['owner','other'].map(id=>[id,createSession(db,id)]));
 const headers = (id='owner')=>({cookie:'yourwiki_v2_session='+sessions[id].token,origin,'x-csrf-token':sessions[id].csrf});
 const url = `/api/documents/${doc.documentId}/pdf`;
 const save = (revision=0, extra={})=>app.inject({method:'PUT',url:url+`/layer?baseRevision=1&layerRevision=${revision}`,headers:{...headers(),'content-type':'application/octet-stream',...extra},payload:'%PDF-1.7 edited'});
 return {db,app,headers,url,save,doc,docs};
}
test('PDF API authenticates writes, streams immutable layers and reports conflicts with recovery',async t=>{
 const {app,headers,url,save}=await setup(t);
 assert.equal((await app.inject({url})).statusCode,401);
 assert.equal((await save(0,{origin:'https://evil.test'})).statusCode,403);
 assert.equal((await save(0,{'x-csrf-token':''})).statusCode,403);
 const saved=await save(); assert.equal(saved.statusCode,200);assert.equal(saved.json().layerRevision,1);
 const state=await app.inject({url,headers:headers()});assert.equal(state.json().layerRevision,1);
 const layer=await app.inject({url:url+'/layers/1',headers:{...headers(),range:'bytes=0-7'}});
 assert.equal(layer.statusCode,206);assert.equal(layer.body,'%PDF-1.7');assert.equal(layer.headers['cache-control'],'no-store');
 const conflict=await save();assert.equal(conflict.statusCode,409);assert.ok(conflict.json().operationId);
 const recovery=url+'/recovery/'+conflict.json().operationId;
 assert.equal((await app.inject({url:recovery,headers:headers()})).body,'%PDF-1.7 edited');
 assert.equal((await app.inject({url:recovery,headers:headers('other')})).statusCode,404);
 assert.equal((await app.inject({url:url+'/layers/999',headers:headers()})).statusCode,404);
});
test('PDF layer API enforces current access, export restrictions and streamed byte limits',async t=>{
 const {db,app,headers,url,save,doc}=await setup(t);
 await save();
 const conflict=await save();const recovery=url+'/recovery/'+conflict.json().operationId;
 db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(doc.documentId);
 assert.equal((await app.inject({url:url+'/layers/1',headers:headers()})).statusCode,200);
 assert.equal((await app.inject({url:recovery,headers:headers()})).statusCode,403);
 const tooLarge=await app.inject({method:'PUT',url:url+'/layer?baseRevision=1&layerRevision=1',headers:{...headers(),'content-type':'application/octet-stream'},payload:'x'.repeat(101)});
 assert.equal(tooLarge.statusCode,413);
 db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?').run(JSON.stringify({owner:{read:false}}),doc.documentId);
 assert.equal((await app.inject({url:url+'/layers/1',headers:headers()})).statusCode,404);
 assert.equal((await save(1)).statusCode,404);
});
test('PDF API requires explicit stale layer replacement and rejects invalid revision controls',async t=>{
 const {app,headers,url,save,docs,doc}=await setup(t);
 await save();
 await docs.save({userId:'owner',documentId:doc.documentId,baseRevision:1},bytes('%PDF-1.7 replaced'));
 assert.equal((await app.inject({url,headers:headers()})).json().state,'conflict');
 const put=(query:string)=>app.inject({method:'PUT',url:url+'/layer?'+query,headers:{...headers(),'content-type':'application/octet-stream'},payload:'%PDF-1.7 fresh'});
 assert.equal((await put('baseRevision=2&layerRevision=1')).statusCode,409);
 assert.equal((await put('baseRevision=1&layerRevision=1&replaceStaleLayer=true')).statusCode,409);
 assert.equal((await put('baseRevision=2&layerRevision=1&replaceStaleLayer=true')).statusCode,200);
 for(const query of ['baseRevision=2','baseRevision=2&layerRevision=-1','baseRevision=2&layerRevision=2&replaceStaleLayer=invalid']) assert.equal((await put(query)).statusCode,400);
 const stale=await app.inject({url:url+'/layers/1',headers:headers()});
 assert.equal(stale.statusCode,200);assert.equal(stale.body,'%PDF-1.7 edited');
 const invalidRange=await app.inject({url:url+'/layers/2',headers:{...headers(),range:'bytes=999-'}});
 assert.equal(invalidRange.statusCode,416);
});
