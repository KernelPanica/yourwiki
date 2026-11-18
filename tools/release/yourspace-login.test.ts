import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../../apps/server/src/database.ts';
import {buildApp} from '../../apps/server/src/app.ts';
import {FernetCodec} from '../../apps/server/src/providers/fernet.ts';
import {SecretConfigs} from '../../apps/server/src/providers/secret-config.ts';
import {createSession} from '../../apps/server/src/auth/sessions.ts';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const issuer='https://space.test',origin='https://wiki.test';
function jwt(payload:Record<string,unknown>,header:Record<string,unknown>={alg:'RS256',kid:'test-key'}){const encoded=[header,payload].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return encoded+'.'+sign('sha256',Buffer.from(encoded),privateKey).toString('base64url');}
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'wiki-sso-')),db=openDatabase(join(root,'database.sqlite3')),codec=new FernetCodec(randomBytes(32).toString('base64url')),secrets=new SecretConfigs(codec);
 db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('reader','reader','Reader','!','member'),('admin','admin','Admin','!','giga');INSERT INTO groups(id,name) VALUES('g','Group');INSERT INTO memberships VALUES('reader','g')");
 db.prepare('INSERT INTO yourspace_identities VALUES(?,?,?)').run(issuer,'space-reader','reader');db.prepare('INSERT INTO yourspace_identities VALUES(?,?,?)').run(issuer,'space-admin','admin');
 let nonce='',challenge='',calls=0,refreshCalls=0,subject='space-reader',status=200,overrides:Record<string,unknown>={},header:Record<string,unknown>|undefined;
 const fakeFetch=(async(url:any,init:any={})=>{
  const path=new URL(String(url)).pathname;
  assert.equal(init.redirect,'error');assert.ok(init.signal);
  if(path==='/.well-known/openid-configuration')return Response.json({issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:issuer+'/oauth/token',userinfo_endpoint:issuer+'/oauth/userinfo',jwks_uri:issuer+'/oauth/jwks',end_session_endpoint:issuer+'/oauth/logout'});
  if(path==='/oauth/jwks')return Response.json({keys:[jwk]});
  if(path==='/oauth/token'){
   const form=new URLSearchParams(init.body);if(form.get('grant_type')==='refresh_token'){refreshCalls++;assert.equal(form.get('refresh_token'),'r'.repeat(43));}else{calls++;assert.equal(form.get('redirect_uri'),origin+'/api/auth/yourspace/callback');assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),challenge);}
   return Response.json({access_token:'a'.repeat(43),refresh_token:'r'.repeat(43),token_type:'Bearer',expires_in:600,id_token:jwt({iss:issuer,aud:'yourwiki-local',sub:subject,nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,amr:['pwd'],...overrides},header)});
  }
  if(path==='/oauth/userinfo')return Response.json({sub:subject,email:'admin@example.test',yourspace_role:'superadmin',yourspace_status:'active'},{status});throw Error('Unexpected URL');
 }) as typeof fetch;
 const app=buildApp({database:db,publicUrl:origin,contentSecrets:secrets,yourspaceLogin:{issuer,clientId:'yourwiki-local',clientSecret:'private-test-client-secret',fetch:fakeFetch}} as any);
 t.after(async()=>{await app.close();db.close();codec.close();await rm(root,{recursive:true,force:true});});
 async function start(returnTo='/'){
  const r=await app.inject({url:'/api/auth/yourspace/start?return='+encodeURIComponent(returnTo)});assert.equal(r.statusCode,302,r.body);const auth=new URL(r.headers.location!),cookie=String(r.headers['set-cookie']).split(';')[0];nonce=auth.searchParams.get('nonce')!;challenge=auth.searchParams.get('code_challenge')!;
  assert.equal(auth.origin,issuer);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('response_type'),'code');
  return {cookie,url:'/api/auth/yourspace/callback?'+new URLSearchParams({code:'c'.repeat(43),state:auth.searchParams.get('state')!,iss:issuer})};
 }
 return {app,db,start,secrets,refreshCalls:()=>refreshCalls,calls:()=>calls,set:(value:{subject?:string;status?:number;claims?:Record<string,unknown>;header?:Record<string,unknown>})=>{subject=value.subject??subject;status=value.status??status;overrides=value.claims??{};header=value.header;}};
}
test('code + PKCE creates a bound session for the explicit identity and preserves local groups/role',async t=>{
 const f=await fixture(t),flow=await f.start('/documents/known'),r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}});assert.equal(r.statusCode,303,r.body);assert.equal(r.headers.location,'/documents/known');const cookie=String(r.headers['set-cookie']).split(',').find(x=>x.trim().startsWith('yourwiki_v2_session='))!.trim().split(';')[0];
 const account=await f.app.inject({url:'/api/account',headers:{cookie}});assert.equal(account.statusCode,200,account.body);assert.equal(account.json().user.id,'reader');assert.equal(account.json().user.adminRole,'member');assert.equal(account.json().user.groups[0].id,'g');assert.equal(account.json().features.yourspace,true);
 assert.equal((await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}})).headers.location,'/?sso=invalid');assert.equal(f.calls(),1);
});
test('wrong browser cannot redeem state, unsafe return URL cannot redirect outside Wiki',async t=>{
 const f=await fixture(t),flow=await f.start('//evil.example');const bad=await f.app.inject({url:flow.url,headers:{cookie:'yourwiki_yourspace_state='+'x'.repeat(43)}});assert.equal(bad.headers.location,'/?sso=invalid');assert.equal(f.calls(),0);
 const good=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}});assert.equal(good.headers.location,'/');
});
test('invalid issuer, audience, nonce, expiry or algorithm cannot create a Wiki session',async t=>{
 for(const claims of [{iss:'https://evil.test'},{aud:'other-client'},{nonce:'wrong'},{exp:1}]){const f=await fixture(t),flow=await f.start();f.set({claims});const r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}});assert.equal(r.headers.location,'/?sso=invalid');assert.equal((f.db.prepare('SELECT count(*) n FROM sessions').get() as any).n,0);}
 const f=await fixture(t),flow=await f.start();f.set({header:{alg:'HS256',kid:'test-key'}});assert.equal((await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}})).headers.location,'/?sso=invalid');
});
test('SSO-only blocks local login, registration, resets, Google login, legacy product tokens and old browser sessions',async t=>{
 const f=await fixture(t),old=createSession(f.db,'reader'),headers={origin,cookie:'yourwiki_v2_session='+old.token,'x-csrf-token':old.csrf};
 for(const url of ['/api/auth/login','/api/auth/reset-password','/api/auth/accept-invitation','/api/auth/forgot-password','/api/auth/second-factor','/api/auth/google/start','/api/account/password','/api/admin/users/reader/password-reset','/api/sso/token']){const r=await f.app.inject({method:'POST',url,headers,payload:{}});assert.equal(r.statusCode,403,url+': '+r.body);assert.equal(r.json().code,'YOURSPACE_ONLY');}
 assert.equal((await f.app.inject({url:'/api/account',headers})).statusCode,401);const options=await f.app.inject({url:'/api/auth/options'});assert.equal(options.json().mode,'yourspace');
});
test('unknown subjects never auto-link by email or elevate roles; inactive accounts stay blocked; admins need MFA',async t=>{
 const f=await fixture(t);f.set({subject:'unknown'});let flow=await f.start(),r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}});assert.equal(r.headers.location,'/?sso=unlinked');
 f.set({subject:'space-admin'});flow=await f.start();r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}});assert.equal(r.headers.location,'/?sso=mfa_required');
 f.set({subject:'space-reader'});f.db.prepare("UPDATE users SET active=0 WHERE id='reader'").run();flow=await f.start();r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}});assert.equal(r.headers.location,'/?sso=unlinked');
});

test('refresh renews central token without replacing browser/Office session; revocation closes access',async t=>{
 const f=await fixture(t),flow=await f.start(),r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}}),cookie=String(r.headers['set-cookie']).split(',').find(x=>x.trim().startsWith('yourwiki_v2_session='))!.trim().split(';')[0];
 const row=f.db.prepare('SELECT token_hash,encrypted_token FROM yourspace_sessions').get() as any,stored=f.secrets.decrypt(row.encrypted_token);stored.expires=Date.now()-1;
 f.db.prepare('UPDATE yourspace_sessions SET encrypted_token=?,checked_at=0').run(f.secrets.encrypt(stored));
 assert.equal((await f.app.inject({url:'/api/account',headers:{cookie}})).statusCode,200);assert.equal(f.refreshCalls(),1);assert.ok((f.db.prepare('SELECT expires_at FROM sessions').get() as any).expires_at>Date.now()+3600000);
 f.set({status:401});f.db.prepare('UPDATE yourspace_sessions SET checked_at=0').run();assert.equal((await f.app.inject({url:'/api/account',headers:{cookie}})).statusCode,401);assert.equal((f.db.prepare('SELECT count(*) n FROM sessions').get() as any).n,0);
});
test('temporary userinfo failure after refresh rotation retains session and supports retry',async t=>{
 const f=await fixture(t),flow=await f.start(),r=await f.app.inject({url:flow.url,headers:{cookie:flow.cookie}}),cookie=String(r.headers['set-cookie']).split(',').find(x=>x.trim().startsWith('yourwiki_v2_session='))!.trim().split(';')[0];
 const row=f.db.prepare('SELECT encrypted_token FROM yourspace_sessions').get() as any,stored=f.secrets.decrypt(row.encrypted_token);stored.expires=1;f.db.prepare('UPDATE yourspace_sessions SET encrypted_token=?,checked_at=0').run(f.secrets.encrypt(stored));
 f.set({status:503});assert.equal((await f.app.inject({url:'/api/account',headers:{cookie}})).statusCode,503);assert.equal((f.db.prepare('SELECT count(*) n FROM sessions').get() as any).n,1);
 f.set({status:200});assert.equal((await f.app.inject({url:'/api/account',headers:{cookie}})).statusCode,200);assert.equal(f.refreshCalls(),2);
});
