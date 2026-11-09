import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historyFixture} from './support/history-fixture.ts';
import {Administration} from '../src/administration/service.ts';

test('group matrix is enforced by read/save/create/export APIs, inheritance and revocation',async t=>{
 const f=await historyFixture(t),s=new Administration(f.db),id=f.first.documentId;
 f.db.exec("INSERT INTO groups(id,name) VALUES('a','A'),('b','B');INSERT INTO memberships VALUES('writer','a'),('reader','b')");
 const root=s.folder('admin',{name:'Docs',groupId:'g'}).id,sub=s.folder('admin',{name:'Nested',parentId:root}).id;
 f.db.prepare('UPDATE resources SET parent_id=?,owner_id=? WHERE id=?').run(sub,'admin',id);
 async function acl(target:string,patch:Record<string,unknown>){const before=s.readAcl('admin',target),r=await f.app.inject({method:'PUT',url:'/api/admin/resources/'+target+'/acl',headers:f.headers('admin'),payload:{...before,inheritPermissions:false,exportDisabled:false,groupOnly:true,policy:{owner:{read:true,write:true},group:{read:false,write:false},everyone:{read:false,write:false}},groupPolicies:{a:{read:true,write:true},b:{read:true,write:false}},userPolicies:{},...patch}});assert.equal(r.statusCode,200,r.body);return r.json();}
 const get=(user:string)=>f.app.inject({url:'/api/documents/'+id+'/text',headers:f.headers(user)});
 async function save(user:string){const r=await get('admin');return f.app.inject({method:'PUT',url:'/api/documents/'+id+'/text',headers:f.headers(user),payload:{baseRevision:r.json().revision,mode:'source',source:'# Saved by '+user}});}
 await acl(root,{});
 assert.equal((await get('writer')).statusCode,200);assert.equal((await save('writer')).statusCode,200);
 assert.equal((await get('reader')).statusCode,200);assert.equal((await save('reader')).statusCode,403);
 assert.equal((await get('foreign')).statusCode,404);assert.equal((await save('foreign')).statusCode,404);
 const create=(user:string)=>f.app.inject({method:'POST',url:'/api/text-documents',headers:f.headers(user),payload:{title:'Child.md',parentId:sub,source:'# Child'}});
 assert.equal((await create('writer')).statusCode,201);assert.equal((await create('reader')).statusCode,403);
 const folder=await f.app.inject({method:'POST',url:'/api/folders',headers:f.headers('reader'),payload:{name:'Forbidden',parentId:sub}});assert.equal(folder.statusCode,403);
 const tamper=await f.app.inject({method:'PUT',url:'/api/admin/resources/'+root+'/acl',headers:f.headers('reader'),payload:{}});assert.equal(tamper.statusCode,403);
 await acl(root,{groupPolicies:{a:{read:false,write:false},b:{read:true,write:false}}});assert.equal((await get('writer')).statusCode,404,'explicit group no-access blocks source');await acl(root,{});f.db.prepare("INSERT INTO memberships VALUES('reader','a')").run();assert.equal((await save('reader')).statusCode,200,'multiple group grants combine');f.db.prepare("DELETE FROM memberships WHERE user_id='reader' AND group_id='a'").run();assert.equal((await save('reader')).statusCode,403);
 await acl(root,{exportDisabled:true});assert.equal((await f.app.inject({url:'/api/documents/'+id+'/content',headers:f.headers('reader')})).statusCode,403);assert.equal((await get('reader')).statusCode,200);
 await acl(id,{groupPolicies:{b:{read:true,write:true}}});assert.equal((await save('reader')).statusCode,200);assert.equal((await get('writer')).statusCode,404);
 await acl(root,{groupPolicies:{}});assert.equal((await save('reader')).statusCode,200,'explicit child remains writable after parent revocation');
 await acl(id,{groupPolicies:{b:{read:true,write:true}},userPolicies:{reader:{read:false,write:false}}});assert.equal((await get('reader')).statusCode,404,'personal deny overrides group');
 await acl(id,{groupPolicies:{b:{read:true,write:true}}});assert.equal((await get('reader')).statusCode,200);
 f.db.prepare("DELETE FROM memberships WHERE user_id='reader' AND group_id='b'").run();assert.equal((await get('reader')).statusCode,404,'revokes cached reads');assert.equal((await save('reader')).statusCode,404,'revokes cached writes');
});
