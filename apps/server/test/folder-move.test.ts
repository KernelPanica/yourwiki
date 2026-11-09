import {test} from 'node:test';import assert from 'node:assert/strict';import {historyFixture} from './support/history-fixture.ts';import {Administration} from '../src/administration/service.ts';import {FolderMoves} from '../src/administration/folder-move.ts';
test('folder move preserves subtree and explicit ACL while inherited access changes immediately',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),move=new FolderMoves(f.db),a=s.folder('admin',{name:'A',groupId:'g'}).id,b=s.folder('admin',{name:'B',groupId:'g'}).id,source=s.folder('admin',{name:'Source',parentId:a}).id,nested=s.folder('admin',{name:'Nested',parentId:source}).id;
 f.db.prepare('UPDATE resources SET parent_id=? WHERE id=?').run(nested,f.first.documentId);const policy=(id:string,read:boolean)=>{const acl=s.readAcl('admin',id);s.acl('admin',id,{...acl,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read,write:read}},userPolicies:{}});};policy(a,true);policy(b,false);assert(s.access.allows('reader',f.first.documentId,'read'));
 move.move('admin',source,{parentId:b,expectedParentId:a});assert.equal((f.db.prepare('SELECT parent_id AS p FROM resources WHERE id=?').get(source) as {p:string}).p,b);assert.equal((f.db.prepare('SELECT parent_id AS p FROM resources WHERE id=?').get(nested) as {p:string}).p,source);assert(!s.access.allows('reader',f.first.documentId,'read'));policy(nested,true);assert(s.access.allows('reader',f.first.documentId,'write'));move.move('admin',source,{parentId:a,expectedParentId:b});assert(s.access.allows('reader',f.first.documentId,'write'));assert.equal((f.db.prepare('SELECT inherit_permissions AS v FROM resources WHERE id=?').get(nested) as {v:number}).v,0);
 assert.throws(()=>move.move('admin',source,{parentId:source,expectedParentId:a}),/INVALID_MOVE/);assert.throws(()=>move.move('admin',source,{parentId:nested,expectedParentId:a}),/INVALID_MOVE/);assert.throws(()=>move.move('admin',source,{parentId:b,expectedParentId:null}),/CONFLICT/);
 move.move('admin',source,{parentId:null,expectedParentId:a});assert.equal((f.db.prepare('SELECT parent_id AS p FROM resources WHERE id=?').get(source) as {p:null}).p,null);
});
test('move API checks permissions on source, old parent and destination, CSRF and current parent',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),a=s.folder('admin',{name:'A',groupId:'g'}).id,b=s.folder('admin',{name:'B',groupId:'g'}).id,folder=s.folder('admin',{name:'Source',parentId:a}).id;
 const acl=(id:string,write:boolean)=>{const value=s.readAcl('admin',id);s.acl('admin',id,{...value,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read:true,write}},userPolicies:{}});};acl(a,true);acl(b,false);
 const request=(user:string,patch:Record<string,unknown>={},headers=f.headers(user))=>f.app.inject({method:'POST',url:'/api/folders/'+folder+'/move',headers,payload:{parentId:b,expectedParentId:a,...patch}});
 assert.equal((await request('writer')).statusCode,403);acl(b,true);acl(folder,false);assert.equal((await request('writer')).statusCode,403);acl(folder,true);acl(a,false);assert.equal((await request('writer')).statusCode,403);acl(a,true);
 assert.equal((await request('writer',{}, {...f.headers('writer'),'x-csrf-token':'wrong'})).statusCode,403);assert.equal((await request('writer',{parentId:null})).statusCode,403);assert.equal((await request('foreign')).statusCode,404);
 const moved=await request('writer');assert.equal(moved.statusCode,200,moved.body);assert.equal((await request('writer')).statusCode,409);
 assert.equal((await f.app.inject({method:'POST',url:'/api/folders/'+f.first.documentId+'/move',headers:f.headers('admin'),payload:{parentId:null,expectedParentId:null}})).statusCode,404);
});
test('moving an ancestor of a mounted root is rejected without changing parents',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),moves=new FolderMoves(f.db),outer=s.folder('admin',{name:'Outer',groupId:'g'}).id,mount=s.folder('admin',{name:'Mount',parentId:outer}).id,dest=s.folder('admin',{name:'Destination',groupId:'g'}).id;
 f.db.prepare("INSERT INTO provider_connections(id,provider,label,encrypted_config,created_at,updated_at) VALUES('local','local','Local','encrypted',1,1)").run();f.db.prepare("INSERT INTO provider_mounts VALUES('local','/Mount',?)").run(mount);assert.throws(()=>moves.move('admin',outer,{parentId:dest,expectedParentId:null}),/FOLDER_PROTECTED/);assert.equal((f.db.prepare('SELECT parent_id AS p FROM resources WHERE id=?').get(outer) as {p:null}).p,null);assert(!moves.canMove('admin',{id:mount,parent_id:outer}));
});
test('document move preserves content, revisions, preview and cloud identity while applying destination inheritance',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),moves=new FolderMoves(f.db),a=s.folder('admin',{name:'A',groupId:'g'}).id,b=s.folder('admin',{name:'B',groupId:'g'}).id,id=f.first.documentId;
 f.db.prepare('UPDATE resources SET parent_id=? WHERE id=?').run(a,id);
 f.db.prepare("INSERT INTO provider_connections(id,provider,label,encrypted_config,created_at,updated_at) VALUES('cloud','google','Cloud','encrypted',1,1)").run();f.db.prepare('INSERT INTO provider_source_bindings(document_id,connection_id,reference,fingerprint,confirmed_revision,created_at) VALUES(?,?,?,?,?,?)').run(id,'cloud','stable-cloud-id','baseline',2,1);
 const doc=f.db.prepare('SELECT * FROM documents WHERE id=?').get(id),versions=f.db.prepare('SELECT * FROM document_versions WHERE document_id=? ORDER BY revision').all(id),binding=f.db.prepare('SELECT * FROM provider_source_bindings WHERE document_id=?').get(id),previews=f.db.prepare('SELECT * FROM previews WHERE document_id=?').all(id);
 const acl=s.readAcl('admin',b);s.acl('admin',b,{...acl,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read:false,write:false}},userPolicies:{}});
 const response=await f.app.inject({method:'POST',url:'/api/documents/'+id+'/move',headers:f.headers('admin'),payload:{parentId:b,expectedParentId:a}});assert.equal(response.statusCode,200,response.body);assert.equal((f.db.prepare('SELECT parent_id AS p FROM resources WHERE id=?').get(id) as any).p,b);assert(!s.access.allows('reader',id,'read'));
 assert.deepEqual(f.db.prepare('SELECT * FROM documents WHERE id=?').get(id),doc);assert.deepEqual(f.db.prepare('SELECT * FROM document_versions WHERE document_id=? ORDER BY revision').all(id),versions);assert.deepEqual(f.db.prepare('SELECT * FROM provider_source_bindings WHERE document_id=?').get(id),binding);assert.deepEqual(f.db.prepare('SELECT * FROM previews WHERE document_id=?').all(id),previews);
 const own=s.readAcl('admin',id);s.acl('admin',id,{...own,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read:true,write:false}},userPolicies:{}});assert(s.access.allows('reader',id,'read'));moves.move('admin',id,{parentId:null,expectedParentId:b},'document');assert(s.access.allows('reader',id,'read'));assert(!s.access.allows('reader',id,'write'));assert(f.db.prepare("SELECT 1 FROM administration_audit WHERE action='document.move' AND target=?").get(id));
});
test('document move checks CSRF, source/destination permissions, stale parent and resource kind',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),a=s.folder('admin',{name:'A',groupId:'g'}).id,b=s.folder('admin',{name:'B',groupId:'g'}).id,id=f.first.documentId;f.db.prepare('UPDATE resources SET parent_id=? WHERE id=?').run(a,id);
 const call=(user:string,payload:any={parentId:b,expectedParentId:a},headers=f.headers(user))=>f.app.inject({method:'POST',url:'/api/documents/'+id+'/move',headers,payload});
 const acl=(target:string,write:boolean)=>{const v=s.readAcl('admin',target);s.acl('admin',target,{...v,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read:true,write}},userPolicies:{}});};
 assert.equal((await call('reader')).statusCode,403);assert.equal((await call('foreign')).statusCode,404);assert.equal((await call('admin',undefined,{...f.headers('admin'),'x-csrf-token':'bad'})).statusCode,403);
 acl(b,false);assert.equal((await call('writer')).statusCode,403);acl(b,true);acl(a,false);assert.equal((await call('writer')).statusCode,403);acl(a,true);
 assert.equal((await call('writer',{parentId:id,expectedParentId:a})).statusCode,400);assert.equal((await call('writer',{parentId:null,expectedParentId:a})).statusCode,403);
 const moved=await call('writer');assert.equal(moved.statusCode,200,moved.body);assert.equal((await call('writer')).statusCode,409);
 assert.equal((await f.app.inject({method:'POST',url:'/api/documents/'+a+'/move',headers:f.headers('admin'),payload:{parentId:b,expectedParentId:null}})).statusCode,404);
});
test('the local Dashboard document remains protected from moving',async t=>{
 const f=await historyFixture(t),{ensureDashboardFile}=await import('../src/text/dashboard.ts'),id=await ensureDashboardFile(f.db,f.store),s=new Administration(f.db),dest=s.folder('admin',{name:'Destination',groupId:'g'}).id;
 const response=await f.app.inject({method:'POST',url:'/api/documents/'+id+'/move',headers:f.headers('admin'),payload:{parentId:dest,expectedParentId:null}});assert.equal(response.statusCode,403,response.body);assert.equal((f.db.prepare('SELECT parent_id FROM resources WHERE id=?').get(id) as any).parent_id,null);
});
test('library exposes readable folder breadcrumbs and never exposes inaccessible ancestor names',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),root=s.folder('admin',{name:'Parent',groupId:'g'}).id,child=s.folder('admin',{name:'Child',parentId:root}).id;
 assert.deepEqual((s.library('admin',null) as any).breadcrumbs,[]);
 assert.deepEqual((s.library('admin',child) as any).breadcrumbs,[{id:root,title:'Parent'},{id:child,title:'Child'}]);
 const acl=s.readAcl('admin',root);s.acl('admin',root,{...acl,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read:false,write:false}},userPolicies:{}});
 const own=s.readAcl('admin',child);s.acl('admin',child,{...own,inheritPermissions:false,exportDisabled:false,groupOnly:true,groupPolicies:{g:{read:true,write:true}},userPolicies:{}});
 assert.deepEqual((s.library('reader',child) as any).breadcrumbs,[{id:child,title:'Child'}]);
});
