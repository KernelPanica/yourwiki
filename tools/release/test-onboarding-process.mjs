import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildApp} from '../../apps/server/src/app.ts';
import {sessionCookieHeader} from '../../apps/server/src/auth/routes.ts';
import {createSession} from '../../apps/server/src/auth/sessions.ts';
import {openDatabase} from '../../apps/server/src/database.ts';

test('team guidelines are shared with members and editable only by admins',async t=>{
 const db=openDatabase(':memory:');
 const origin='https://wiki.example';
 const app=buildApp({database:db,publicUrl:origin});
 t.after(async()=>{await app.close();db.close();});
 function session(id,role){
  db.prepare('INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES(?,?,?,?,?)').run(id,id,id,'unused',role);
  const {token,csrf,maxAge}=createSession(db,id);
  return {cookie:sessionCookieHeader(origin,token,maxAge).split(';')[0],origin,'x-csrf-token':csrf};
 }
 const member=session('member','member'),admin=session('admin','simple');
 const url='/api/admin/onboarding/process';
 const note={topic:'document',ru:'Регламент команды',en:'Team guidelines',link:'/documents/handbook'};
 const put=(headers,payload=note)=>app.inject({method:'PUT',url,headers,payload});
 const account=()=>app.inject({url:'/api/account',headers:member});
 assert.equal((await put(member)).statusCode,403);
 assert.equal((await put({...admin,'x-csrf-token':'invalid'})).statusCode,403);
 assert.equal((await put(admin,{...note,link:'https://other.example/documents/handbook'})).statusCode,400);
 assert.equal((await put(admin,{...note,link:'javascript:alert(1)'})).statusCode,400);
 assert.equal((await put(admin)).statusCode,200);
 assert.deepEqual((await account()).json().onboardingProcess,[note]);
 assert.equal((await put(admin,{...note,ru:'',en:'',link:''})).statusCode,200);
 assert.deepEqual((await account()).json().onboardingProcess,[]);
});
