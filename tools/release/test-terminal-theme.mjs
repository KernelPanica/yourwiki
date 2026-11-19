import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildApp} from '../../apps/server/src/app.ts';
import {createSession} from '../../apps/server/src/auth/sessions.ts';
import {openDatabase} from '../../apps/server/src/database.ts';

test('Terminal is an opt-in account preference and preserves the saved motion setting', async t=>{
 const db=openDatabase(':memory:');
 const origin='https://wiki.example.test';
 const app=buildApp({database:db,publicUrl:origin});
 t.after(async()=>{await app.close();db.close();});
 function headers(id){
  db.prepare('INSERT INTO users(id,username,display_name,password_hash) VALUES(?,?,?,?)').run(id,id,id,'!');
  const {token,csrf}=createSession(db,id);
  return {cookie:'yourwiki_v2_session='+token,'x-csrf-token':csrf,origin};
 }
 const member=headers('member'), other=headers('other');
 const url='/api/account/preferences';
 assert.equal((await app.inject({url,headers:member})).json().theme,'auto');
 const set=(theme,baseRevision)=>app.inject({method:'PUT',url,headers:member,payload:{theme,baseRevision,language:'ru',animations:true,avatar:null}});
 const enabled=await set('terminal',0);
 assert.equal(enabled.statusCode,200);
 assert.deepEqual(enabled.json(),{theme:'terminal',revision:1,language:'ru',animations:1,avatar:null});
 assert.equal((await app.inject({url,headers:other})).json().theme,'auto');
 assert.equal((await set('terminal',0)).statusCode,409);
 assert.equal((await set('unknown',1)).statusCode,400);
 const disabled=await set('dark',1);
 assert.equal(disabled.statusCode,200);
 assert.equal(disabled.json().animations,1);
});
