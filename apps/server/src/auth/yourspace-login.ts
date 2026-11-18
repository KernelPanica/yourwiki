import {randomBytes,createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {transaction,type Database} from '../database.ts';
import type {SecretConfigs} from '../providers/secret-config.ts';
import {authenticateSession,createSession,revokeSession,tokenHash,validCsrf} from './sessions.ts';
import {sessionCookie,sessionCookieHeader} from './routes.ts';
import {errorEnvelope} from '../errors.ts';
import {YourspaceOidc,YourspaceError,type YourspaceLoginOptions} from './yourspace-oidc.ts';
const cap=()=>randomBytes(32).toString('base64url'),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const stateCookie='yourwiki_yourspace_state';
const localPath=(value:unknown)=>typeof value==='string'&&value.length<=2048&&/^\/(?![\/\\])/.test(value)&&!/[\x00-\x20\x7f\\]/.test(value)&&!value.startsWith('/api/')?value:'/';
function cookie(request:FastifyRequest,name:string){const all=(request.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));return all.length===1?all[0].slice(name.length+1):'';}
export function registerYourspaceLogin(app:FastifyInstance,db:Database,secrets:SecretConfigs,origin:string,config:YourspaceLoginOptions){
 const oidc=new YourspaceOidc(config),callback=origin+'/api/auth/yourspace/callback',secure=origin.startsWith('https:');
 const stateHeader=(value:string,age:number)=>`${stateCookie}=${value}; Path=/api/auth/yourspace; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
 const inFlight=new Map<string,Promise<void>>();
 // Old local/browser and legacy product sessions may otherwise keep Office capabilities alive after cutover.
 transaction(db,()=>{db.prepare('DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM yourspace_sessions WHERE issuer=?)').run(oidc.issuer);for(const table of ['sso_tokens','sso_codes','login_challenges','password_email_links','google_login_attempts','google_registration_attempts'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare('DELETE FROM '+table).run();});
 const blocked=(path:string,method:string)=>/^\/api\/auth\/(?:login|reset-password|accept-invitation|forgot-password|second-factor|google)(?:\/|$)/.test(path)||/^\/api\/account\/(?:password|contact-email|second-factor)(?:\/|$)/.test(path)||/^\/api\/sso(?:\/|$)/.test(path)||/^\/api\/admin\/users\/[^/]+\/password-reset$/.test(path)||path==='/api/admin/users'&&method==='POST'||path==='/api/admin/accounts/unlinked'||['/api/invitations','/api/admin/invitations'].includes(path)&&requestMethodIsWrite(method)||/^\/api\/people\/[^/]+$/.test(path)&&method==='PATCH';
 async function checkCentral(hash:string,row:{subject:string;encrypted_token:string}){
  let task=inFlight.get(hash);if(!task){task=(async()=>{const stored=secrets.decrypt(row.encrypted_token);if(typeof stored.token!=='string')throw new YourspaceError('invalid');let token:string=stored.token;
   if(typeof stored.refresh==='string'&&typeof stored.nonce==='string'&&typeof stored.expires==='number'&&stored.expires<Date.now()+120000){
    const fresh=await oidc.refresh(stored.refresh,stored.nonce,refresh=>{db.prepare('UPDATE yourspace_sessions SET encrypted_token=? WHERE token_hash=?').run(secrets.encrypt({...stored,refresh}),hash);});if(fresh.subject!==row.subject||stored.mfa===true&&!fresh.mfa)throw new YourspaceError('invalid');
    token=fresh.accessToken;db.prepare('UPDATE yourspace_sessions SET encrypted_token=? WHERE token_hash=?').run(secrets.encrypt({token,refresh:fresh.refreshToken??'',nonce:stored.nonce,expires:fresh.expiresAt,mfa:fresh.mfa}),hash);
   }
   const info=await oidc.userinfo(token);if(info.sub!==row.subject)throw new YourspaceError('invalid');db.prepare('UPDATE yourspace_sessions SET checked_at=? WHERE token_hash=?').run(Date.now(),hash);})();inFlight.set(hash,task);}
  try{await task;}finally{if(inFlight.get(hash)===task)inFlight.delete(hash);}
 }
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('cache-control','no-store');
  const path=request.url.split('?')[0];
  if(path==='/api/auth/options')return reply.send({mode:'yourspace',issuer:oidc.issuer,authorizationUrl:'/api/auth/yourspace/start',emailRecovery:false,googleLogin:false,sso:false});
  if(blocked(path,request.method))return reply.code(403).send(errorEnvelope('YOURSPACE_ONLY',request.id));
  if(path.startsWith('/api/auth/yourspace/')||path==='/api/auth/logout'||!path.startsWith('/api/'))return;
  const token=sessionCookie(request);if(!token)return;const session=authenticateSession(db,token);
  const row=db.prepare('SELECT subject,encrypted_token,checked_at FROM yourspace_sessions WHERE token_hash=? AND issuer=?').get(tokenHash(token),oidc.issuer) as {subject:string;encrypted_token:string;checked_at:number}|undefined;
  if(!session||!row){revokeSession(db,token);return reply.header('set-cookie',sessionCookieHeader(origin,'',0)).code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));}
  if(row.checked_at>Date.now()-60000)return;
  try{await checkCentral(session.tokenHash,row);if(!authenticateSession(db,token))throw new YourspaceError('invalid');}
  catch(error){if(error instanceof YourspaceError&&error.kind==='unavailable')return reply.code(503).send(errorEnvelope('IDENTITY_UNAVAILABLE',request.id));revokeSession(db,token);return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));}
 });
 app.get('/api/auth/yourspace/start',async(request,reply)=>{
  try{const query=request.query as Record<string,unknown>,now=Date.now(),attempt='yourspace:'+hash(cookie(request,stateCookie)||cap());
   transaction(db,()=>{db.prepare('DELETE FROM yourspace_login_states WHERE expires_at<=?').run(now);const rate=db.prepare('SELECT attempts,window_start FROM login_attempts WHERE key=?').get(attempt) as {attempts:number;window_start:number}|undefined;if(rate&&rate.window_start>now-900000&&rate.attempts>=30)throw new YourspaceError('unavailable');db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start>? THEN attempts+1 ELSE 1 END,window_start=CASE WHEN window_start>? THEN window_start ELSE excluded.window_start END').run(attempt,now,now-900000,now-900000);if((db.prepare('SELECT count(*) n FROM yourspace_login_states').get() as {n:number}).n>=256)throw new YourspaceError('unavailable');});
   const metadata=await oidc.discovery(),state=cap(),browser=cap(),verifier=cap(),nonce=cap(),next=localPath(query.return);
   db.prepare('INSERT INTO yourspace_login_states VALUES(?,?,?,?)').run(hash(state),hash(browser),secrets.encrypt({verifier,nonce,next}),now+600000);
   const target=new URL(metadata.authorization_endpoint);target.search=new URLSearchParams({client_id:oidc.clientId,response_type:'code',scope:'openid profile email groups',redirect_uri:callback,state,nonce,code_challenge:hashChallenge(verifier),code_challenge_method:'S256',...(query.mfa==='1'?{acr_values:'mfa'}:{})}).toString();
   return reply.header('set-cookie',stateHeader(browser,600)).redirect(target.href,302);
  }catch{return reply.redirect('/?sso=unavailable',303);}
 });
 app.get('/api/auth/yourspace/callback',async(request,reply)=>{
  reply.header('referrer-policy','no-referrer');
  try{const query=request.query as Record<string,unknown>,browser=cookie(request,stateCookie);if(query.iss!==oidc.issuer||typeof query.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(query.state)||typeof query.code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(query.code)||!/^[A-Za-z0-9_-]{43}$/.test(browser))throw new YourspaceError('invalid');
   const context=transaction(db,()=>{const row=db.prepare('SELECT encrypted_context,browser_hash FROM yourspace_login_states WHERE state_hash=? AND expires_at>?').get(hash(query.state as string),Date.now()) as {encrypted_context:string;browser_hash:string}|undefined;if(!row||row.browser_hash!==hash(browser))throw new YourspaceError('invalid');db.prepare('DELETE FROM yourspace_login_states WHERE state_hash=?').run(hash(query.state as string));return secrets.decrypt(row.encrypted_context);});
   if(typeof context.verifier!=='string'||typeof context.nonce!=='string')throw new YourspaceError('invalid');
   const identity=await oidc.exchange(query.code,context.verifier,context.nonce,callback);
   const session=transaction(db,()=>{const user=db.prepare('SELECT u.id,u.admin_role FROM yourspace_identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=? AND i.subject=? AND u.active=1 AND u.trashed_at IS NULL AND u.purged_at IS NULL').get(oidc.issuer,identity.subject) as {id:string;admin_role:string}|undefined;
    if(!user)throw new YourspaceError('unlinked');if(user.admin_role!=='member'&&!identity.mfa)throw new YourspaceError('mfa_required');
    const hours=(db.prepare('SELECT session_hours FROM app_state WHERE id=1').get() as {session_hours:number}).session_hours;const lifetime=identity.refreshToken?Math.min(hours,12)*3600000:Math.floor(identity.expiresAt-Date.now());if(lifetime<1000)throw new YourspaceError('invalid');const value=createSession(db,user.id,Date.now(),lifetime);
    db.prepare('INSERT INTO yourspace_sessions VALUES(?,?,?,?,?)').run(tokenHash(value.token),oidc.issuer,identity.subject,secrets.encrypt({token:identity.accessToken,refresh:identity.refreshToken??'',nonce:context.nonce,expires:identity.expiresAt,mfa:identity.mfa}),Date.now());
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='administration_audit'").get())db.prepare('INSERT INTO administration_audit(actor_id,action,target,created_at) VALUES(?,?,?,?)').run(user.id,'login.yourspace',user.id,Date.now());
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='security_log'").get())db.prepare('INSERT INTO security_log(created_at,action,actor_id,subject_id,details) VALUES(?,?,?,?,?)').run(Date.now(),'login.yourspace',user.id,user.id,'{}');return value;
   });
   revokeSession(db,sessionCookie(request));return reply.header('set-cookie',[sessionCookieHeader(origin,session.token,session.maxAge),stateHeader('',0)]).redirect(localPath(context.next),303);
  }catch(error){const code=error instanceof YourspaceError?error.kind:'invalid';return reply.header('set-cookie',stateHeader('',0)).redirect('/?sso='+code,303);}
 });
 app.post('/api/auth/yourspace/logout',async(request,reply)=>{
  const token=sessionCookie(request),session=authenticateSession(db,token);
  if(session&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(session,request.headers['x-csrf-token'])))return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
  if(!session&&request.headers.origin!==origin)return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
  revokeSession(db,token);return reply.header('set-cookie',sessionCookieHeader(origin,'',0)).send({logoutUrl:oidc.logoutUrl(origin+'/')});
 });
}
const hashChallenge=(verifier:string)=>createHash('sha256').update(verifier).digest('base64url');

const requestMethodIsWrite=(method:string)=>!['GET','HEAD','OPTIONS'].includes(method);
