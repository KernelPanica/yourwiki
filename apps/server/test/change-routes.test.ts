import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../src/database.ts';
import { createSession } from '../src/auth/sessions.ts';
import { buildApp } from '../src/app.ts';
async function waitFor(predicate:()=>boolean){for(let i=0;i<150;i++){if(predicate())return;await delay(10);}assert.fail('SSE condition not received');}
test('SSE authenticates, rejects foreign origins and URL tokens, and closes streams during shutdown',{timeout:5000},async t=>{
 const db=openDatabase(':memory:');db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!')");
 const session=createSession(db,'u'),cookie='yourwiki_v2_session='+session.token;
 const app=buildApp({database:db,publicUrl:'https://wiki.test',changesPollMs:20});
 t.after(async()=>{await app.close();db.close();});
 assert.equal((await app.inject({url:'/api/changes'})).statusCode,401);
 assert.equal((await app.inject({url:'/api/changes',headers:{cookie,origin:'https://foreign.test'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/changes?token=secret',headers:{cookie}})).statusCode,400);
 await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('No test listener');
 let data='',status=0,closed=false,cache='',buffering='';
 const req=get({hostname:'127.0.0.1',port:address.port,path:'/api/changes',headers:{cookie}},res=>{
  status=res.statusCode!;cache=String(res.headers['cache-control']);buffering=String(res.headers['x-accel-buffering']);
  res.on('data',chunk=>data+=chunk.toString());res.on('end',()=>{closed=true;});res.on('error',()=>{closed=true;});
 });t.after(()=>req.destroy());req.on('error',()=>{closed=true;});
 await waitFor(()=>data.includes('event: ready'));assert.equal(status,200);assert.equal(cache,'no-store');assert.equal(buffering,'no');
 db.exec("UPDATE users SET display_name='Renamed' WHERE id='u'");await waitFor(()=>data.includes('event: access'));
 assert.ok(!data.includes('Renamed'));
 await app.close();await waitFor(()=>closed);
});
