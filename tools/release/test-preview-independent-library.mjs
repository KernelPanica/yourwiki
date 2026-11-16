import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../apps/server/src/database.ts';
import {BlobStore} from '../../apps/server/src/storage/blobs.ts';
import {DocumentService} from '../../apps/server/src/documents.ts';
import {buildApp} from '../../apps/server/src/app.ts';
import {createSession} from '../../apps/server/src/auth/sessions.ts';
import {bindExistingSource} from '../../apps/server/src/providers/source-bindings.ts';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'wiki-visible-upload-')),db=openDatabase(':memory:');
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('owner','owner','Owner','!'),('reader','reader','Reader','!'),('outsider','outsider','Outsider','!'); INSERT INTO groups(id,name) VALUES('team','Team'); INSERT INTO memberships VALUES('owner','team'),('reader','team'); INSERT INTO resources(id,kind,owner_id,group_id) VALUES('folder','folder','owner','team'); INSERT INTO folder_names VALUES('folder','Test');");
 const store=await BlobStore.open(root),service=new DocumentService(db,store),app=buildApp({database:db,storage:store,publicUrl:'https://wiki.example.test'});
 const sessions=Object.fromEntries(['owner','reader','outsider'].map(id=>[id,createSession(db,id)]));
 const headers=id=>({cookie:'yourwiki_v2_session='+sessions[id].token});
 const doc=await service.create({localOnly:true,userId:'owner',parentId:'folder',groupId:'team',title:'Roadmap.xlsx',format:'xlsx'},(async function*(){yield Buffer.from('stored source');})());
 t.after(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});
 return {db,store,service,app,headers,doc};
}
test('accepted upload is listed for its owner even when preview fails, and can open a metadata view',async t=>{
 const {db,app,headers,doc}=await fixture(t);
 db.prepare("UPDATE jobs SET state='failed',error_code='OFFICE_CONVERSION_FAILED' WHERE id=?").run(doc.jobId);
 const list=await app.inject({url:'/api/library?parent=folder',headers:headers('owner')});assert.equal(list.statusCode,200);assert.equal(list.json().items[0]?.id,doc.documentId);
 const view=await app.inject({url:`/api/documents/${doc.documentId}/view`,headers:headers('owner')});assert.equal(view.statusCode,200);assert.equal(view.json().document.previewState,'failed');assert.equal(view.json().manifest.kind,'pending');assert.deepEqual(view.json().manifest.artifacts,[]);
 const search=await app.inject({url:'/api/documents?q=Roadmap',headers:headers('owner')});assert.equal(search.json().items[0]?.id,doc.documentId);
 const events=db.prepare('SELECT kind FROM events WHERE document_id=?').all(doc.documentId);assert.ok(events.some(e=>e.kind==='document.accepted'));
});
test('private drafts remain hidden from other readers; confirmed sources obey local ACL even without a preview',async t=>{
 const {db,app,headers,doc}=await fixture(t),url=`/api/documents/${doc.documentId}`;
 assert.equal((await app.inject({url,headers:headers('reader')})).statusCode,404);
 assert.equal((await app.inject({url:'/api/library?parent=folder',headers:headers('reader')})).json().items.length,0);
 db.prepare("INSERT INTO provider_connections VALUES('local','local','Local','cipher',1,1,1,1)").run();
 bindExistingSource(db,{documentId:doc.documentId,connectionId:'local',reference:'Roadmap.xlsx',fingerprint:'verified',confirmedRevision:1,confirmedDigest:doc.blob.digest,confirmedSize:doc.blob.size,now:Date.now()});
 assert.equal((await app.inject({url,headers:headers('reader')})).statusCode,200);
 assert.equal((await app.inject({url:'/api/library?parent=folder',headers:headers('reader')})).json().items[0]?.id,doc.documentId);
 assert.equal((await app.inject({url,headers:headers('outsider')})).statusCode,404);
 assert.equal((await app.inject({url:url+'/previews/'+doc.blob.digest,headers:headers('reader')})).statusCode,404);
});

test('permission delivery exposes a rejected check while preserving unknown mutation fences',async t=>{
 const {db}=await fixture(t),{recordGoogleGrantFailure}=await import('../../apps/server/src/providers/google-grant-failure.ts'),{ProviderError}=await import('../../apps/server/src/providers/adapter.ts');
 db.prepare("INSERT INTO provider_connections VALUES('google','google','Drive','cipher',1,1,1,1)").run();
 for(const [recipient,state] of [['pending@example.test','pending'],['uncertain@example.test','unknown']])db.prepare('INSERT INTO provider_google_grants(reference,recipient,connection_id,connection_revision,state,pending_action) VALUES(?,?,?,?,?,?)').run('file',recipient,'google',1,state,state==='unknown'?'delete':null);
 db.prepare("INSERT INTO provider_google_export_rules(reference,connection_id,connection_revision,desired) VALUES('file','google',1,0)").run();
 assert.equal(recordGoogleGrantFailure(db,'file',new ProviderError('ACCESS_DENIED'),123),'ACCESS_DENIED');
 const rows=db.prepare('SELECT state,pending_action,error_code FROM provider_google_grants ORDER BY recipient').all();
 assert.equal(rows[0].state,'failed');assert.equal(rows[1].state,'unknown');assert.equal(rows[1].pending_action,'delete');assert.equal(rows[1].error_code,'ACCESS_DENIED');
 assert.equal(db.prepare('SELECT state FROM provider_google_export_rules').get().state,'failed');
});
test('Collabora opening and room allocation accept confirmed sources without previews, with ACL and private-draft fences intact',async t=>{
 const {db,headers,doc}=await fixture(t),{OfficeOpenings}=await import('../../apps/server/src/office/openings.ts'),{OfficeSessions}=await import('../../apps/server/src/office/sessions.ts');
 const openings=new OfficeOpenings(db),sessions=new OfficeSessions(db),token=user=>headers(user).cookie.split('=')[1];
 assert.throws(()=>openings.begin(token('reader'),'private-draft-open-1',doc.documentId),/NOT_FOUND/);
 assert.throws(()=>sessions.open(token('reader'),doc.documentId,false),/NOT_FOUND/);
 assert.ok(openings.begin(token('owner'),'owner-pending-open-1',doc.documentId));
 assert.ok(sessions.open(token('owner'),doc.documentId,false).sessionId);
 db.prepare("INSERT INTO provider_connections VALUES('local','local','Local','cipher',1,1,1,1)").run();
 bindExistingSource(db,{documentId:doc.documentId,connectionId:'local',reference:'Roadmap.xlsx',fingerprint:'verified',confirmedRevision:1,confirmedDigest:doc.blob.digest,confirmedSize:doc.blob.size,now:Date.now()});
 assert.ok(openings.begin(token('reader'),'reader-source-open-1',doc.documentId));
 assert.ok(sessions.open(token('reader'),doc.documentId,false).sessionId);
 assert.throws(()=>sessions.open(token('outsider'),doc.documentId,false),/NOT_FOUND/);
});
