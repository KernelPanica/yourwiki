import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {DocumentService,DocumentError} from '../src/documents.ts';
import {createSession} from '../src/auth/sessions.ts';
import {buildApp} from '../src/app.ts';
import {RecentDocuments} from '../src/recent.ts';
const origin='https://wiki.example.test';
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'yourwiki-recent-')),db=openDatabase(join(root,'recent.sqlite')),store=await BlobStore.open(root),documents=new DocumentService(db,store);let now=1000;
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('a','a','A','!'),('b','b','B','!');INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('giga','giga','Giga','!','giga');INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('a','g'),('b','g')");
 function seed(id:string,published=true){db.prepare("INSERT INTO resources(id,kind,owner_id,group_id) VALUES(?,'document','a','g')").run(id);db.prepare("INSERT INTO documents(id,title,format,local_revision,published_revision,created_at) VALUES(?,?,'md',1,?,1)").run(id,'Title '+id,published?1:null);db.prepare("INSERT INTO document_versions(document_id,revision,digest,size,author_id,created_at) VALUES(?,1,?,1,'a',1)").run(id,'a'.repeat(64));if(published)db.prepare("INSERT INTO previews(document_id,revision,manifest_digest,converter_version,created_at) VALUES(?,1,?,'preview-v2',1)").run(id,'b'.repeat(64));}
 for(const id of ['one','two','three'])seed(id);seed('draft',false);
 const recent=new RecentDocuments(db,documents,{clock:()=>now});const sessions=Object.fromEntries(['a','b','giga'].map(id=>[id,createSession(db,id)]));const headers=(id='a')=>({cookie:'yourwiki_v2_session='+sessions[id].token,origin,'x-csrf-token':sessions[id].csrf});const app=buildApp({database:db,storage:store,publicUrl:origin});
 t.after(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});return {root,db,recent,documents,app,headers,seed,time:(value:number)=>{now=value;}};
}
test('recent isolates each user including admins and reopens move one current document to the top',async t=>{
 const {recent,db,time}=await fixture(t);recent.record('a','one');time(2000);recent.record('b','two');time(3000);recent.record('a','three');assert.deepEqual(recent.list('a').items.map(x=>[x.id,x.openedAt]),[['three',3000],['one',1000]]);assert.deepEqual(recent.list('b').items.map(x=>x.id),['two']);assert.deepEqual(recent.list('giga').items,[]);time(4000);recent.record('a','one');db.prepare('UPDATE documents SET title=? WHERE id=?').run('Renamed','one');assert.deepEqual(recent.list('a').items.map(x=>[x.id,x.title,x.openedAt]),[['one','Renamed',4000],['three','Title three',3000]]);assert.equal((db.prepare('SELECT count(*) AS n FROM document_visits WHERE user_id=?').get('a') as any).n,2);
});
test('recent rechecks access, trash and publication without leaking hidden entries or accepting denied visits',async t=>{
 const {recent,db}=await fixture(t);for(const id of ['one','two','three'])recent.record('b',id);db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run('{"b":{"read":false}}','one');db.prepare('UPDATE resources SET trashed=1 WHERE id=?').run('two');db.prepare('UPDATE documents SET published_revision=NULL WHERE id=?').run('three');assert.deepEqual(recent.list('b').items,[]);for(const id of ['one','two','three','draft','missing'])assert.throws(()=>recent.record('b',id),(e:unknown)=>e instanceof DocumentError&&e.code==='NOT_FOUND');db.prepare("UPDATE users SET active=0 WHERE id='b'").run();assert.deepEqual(recent.list('b').items,[]);
});
test('recent bounds distinct retention, paginates timestamp ties and rejects malformed cursors',async t=>{
 const {recent,seed,time,db}=await fixture(t);for(let i=0;i<205;i++){const id='item-'+String(i).padStart(3,'0');seed(id);time(i<10?1000:1000+i);recent.record('a',id);}const first=recent.list('a',{limit:200});assert.equal(first.items.length,200);assert.equal(first.items[0].id,'item-204');assert.equal(first.items.at(-1)!.id,'item-005');assert.equal(first.nextCursor,null);assert.equal((db.prepare('SELECT count(*) AS n FROM document_visits').get() as any).n,200);
 const seen:string[]=[];let after:string|undefined;do{const page=recent.list('a',{limit:7,after});seen.push(...page.items.map(x=>x.id));after=page.nextCursor??undefined;}while(after);assert.equal(new Set(seen).size,200);assert.deepEqual(seen,first.items.map(x=>x.id));for(const value of ['bad','a'.repeat(1000),Buffer.from('[1,"one","extra"]').toString('base64url'),Buffer.from('[-1,"one"]').toString('base64url')])assert.throws(()=>recent.list('a',{after:value}),(e:unknown)=>e instanceof DocumentError&&e.code==='INVALID_REQUEST');
});
test('hidden candidates are scanned within a bounded recent page and do not hide readable older entries',async t=>{
 const {recent,seed,time,db}=await fixture(t);for(let i=0;i<100;i++){const id='hidden-'+i;seed(id);time(1000+i);recent.record('b',id);if(i>=10)db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run('{"b":{"read":false}}',id);}const page=recent.list('b',{limit:7});assert.deepEqual(page.items.map(x=>x.id),['hidden-9','hidden-8','hidden-7','hidden-6','hidden-5','hidden-4','hidden-3']);assert.ok(page.nextCursor);assert.deepEqual(recent.list('b',{limit:7,after:page.nextCursor!}).items.map(x=>x.id),['hidden-2','hidden-1','hidden-0']);
});
test('recent visit routes require current cookie, same origin and CSRF and never mark metadata reads',async t=>{
 const {app,headers,db}=await fixture(t);assert.equal((await app.inject({url:'/api/recent'})).statusCode,401);for(const url of ['/api/documents','/api/documents/one','/api/documents/one/processing'])assert.equal((await app.inject({url,headers:headers()})).statusCode,200);assert.deepEqual((await app.inject({url:'/api/recent',headers:headers()})).json().items,[]);
 for(const h of [{}, {...headers(),origin:'https://foreign.example'}, {...headers(),'x-csrf-token':'wrong'}])assert.ok([401,403].includes((await app.inject({method:'POST',url:'/api/documents/one/visit',headers:h})).statusCode));assert.equal((await app.inject({method:'POST',url:'/api/documents/draft/visit',headers:headers()})).statusCode,404);assert.equal((db.prepare('SELECT count(*) AS n FROM document_visits').get() as any).n,0);
 const recorded=await app.inject({method:'POST',url:'/api/documents/one/visit',headers:headers()});assert.equal(recorded.statusCode,204);assert.equal(recorded.body,'');const list=await app.inject({url:'/api/recent',headers:headers()});assert.equal(list.statusCode,200);assert.equal(list.headers['cache-control'],'no-store');assert.equal(list.json().items[0].id,'one');assert.equal(list.json().items[0].capabilities.write,true);assert.equal(list.json().items[0].capabilities.export,true);assert.deepEqual((await app.inject({url:'/api/recent',headers:headers('b')})).json().items,[]);assert.deepEqual((await app.inject({url:'/api/recent',headers:headers('giga')})).json().items,[]);db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run('{"a":{"read":false}}','one');assert.deepEqual((await app.inject({url:'/api/recent',headers:headers()})).json().items,[]);
});
test('recent HTTP rejects foreign selection and invalid cursors instead of silently accepting them',async t=>{
 const {app,headers}=await fixture(t);for(const query of ['userId=b','limit=0','limit=201','after=bad']){const response=await app.inject({url:'/api/recent?'+query,headers:headers()});assert.equal(response.statusCode,400);assert.equal(response.json().code,'INVALID_REQUEST');}
});
test('recent visits survive reopening SQLite and follow user/document deletion without retaining metadata',async t=>{
 const {root,recent,db,documents}=await fixture(t);recent.record('b','one');const reopened=openDatabase(join(root,'recent.sqlite'));try{assert.deepEqual(new RecentDocuments(reopened,documents).list('b').items.map(x=>x.id),['one']);}finally{reopened.close();}db.prepare("DELETE FROM users WHERE id='b'").run();assert.deepEqual(db.prepare('SELECT * FROM document_visits').all(),[]);recent.record('a','two');db.prepare("DELETE FROM previews WHERE document_id='two'").run();db.prepare("DELETE FROM document_versions WHERE document_id='two'").run();db.prepare("DELETE FROM documents WHERE id='two'").run();assert.deepEqual(db.prepare('SELECT * FROM document_visits').all(),[]);
});
test('same-millisecond and backward-clock reopen remains newest, while imported ties paginate deterministically',async t=>{
 const {recent,time,db}=await fixture(t);recent.record('a','one');recent.record('a','two');time(1);recent.record('a','one');assert.deepEqual(recent.list('a').items.map(x=>x.id),['one','two']);db.prepare('UPDATE document_visits SET opened_at=1000').run();const first=recent.list('a',{limit:1});assert.equal(first.items[0].id,'two');assert.equal(recent.list('a',{limit:1,after:first.nextCursor!}).items[0].id,'one');
});
