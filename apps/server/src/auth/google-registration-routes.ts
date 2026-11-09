import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import {tokenHash} from './sessions.ts';
import {sessionCookie} from './routes.ts';
import type {GoogleRegistration} from './google-registration.ts';
const cookieName='yourwiki_registration';
function browserToken(request:FastifyRequest){const values=(request.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='));return values.length===1?values[0]!.slice(cookieName.length+1):'';}
function registrationCookie(token:string,origin:string,age=600){return `${cookieName}=${token}; Path=/api/google/identity/callback; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:')?'; Secure':''}`;}
export function registerGoogleRegistration(app:FastifyInstance,db:Database,origin:string,registration?:GoogleRegistration){
 app.post('/api/auth/accept-invitation',{bodyLimit:16384},async(request,reply)=>{
  reply.header('cache-control','no-store');if(request.headers.origin!==origin)return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
  try{transaction(db,()=>{const key='invite:'+tokenHash(request.ip),now=Date.now(),old=db.prepare('SELECT attempts,window_start FROM login_attempts WHERE key=?').get(key) as {attempts:number;window_start:number}|undefined;if(old&&old.window_start>now-900000&&old.attempts>=10)throw new DocumentError('RATE_LIMITED');db.prepare('INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start>? THEN attempts+1 ELSE 1 END,window_start=CASE WHEN window_start>? THEN window_start ELSE excluded.window_start END').run(key,now,now-900000,now-900000);});if(!registration)throw new DocumentError('GOOGLE_REGISTRATION_UNAVAILABLE');const value=await registration.begin(request.body,sessionCookie(request));return reply.header('set-cookie',registrationCookie(value.browserToken,origin)).send({authorizationUrl:value.authorizationUrl});}
  catch(error){if(!(error instanceof DocumentError))throw error;const status=({PASSWORD_MISMATCH:400,INVALID_REQUEST:400,INVITATION_INVALID:400,CONFLICT:409,RATE_LIMITED:429,GOOGLE_REGISTRATION_UNAVAILABLE:503} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 });
 if(registration){const timer=setInterval(()=>registration.cleanup(),60000);timer.unref();app.addHook('onClose',async()=>{clearInterval(timer);await registration.close();});}
}
export async function registrationCallback(request:FastifyRequest,reply:FastifyReply,origin:string,registration:GoogleRegistration){
 const query=request.query as Record<string,unknown>,state=query.state,token=browserToken(request);reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
 try{if(typeof state!=='string'||Object.keys(query).some(key=>!['state','code','scope','authuser','prompt','iss','error','error_description','hd'].includes(key)))throw new DocumentError('REGISTRATION_EXPIRED');if(query.iss!==undefined&&query.iss!=='https://accounts.google.com'&&query.iss!=='accounts.google.com')throw new DocumentError('REGISTRATION_EXPIRED');if(typeof query.error==='string'){const target=registration.cancel(state,token).replace('?google=retry','?google=cancelled');return reply.header('set-cookie',registrationCookie('',origin,0)).redirect(target,303);}if(typeof query.code!=='string')throw new DocumentError('REGISTRATION_EXPIRED');const session=await registration.complete(state,token,query.code),cookie=`yourwiki_v2_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${session.maxAge}${origin.startsWith('https:')?'; Secure':''}`;return reply.header('set-cookie',[cookie,registrationCookie('',origin,0)]).redirect('/dashboard',303);}
 catch(error){if(typeof state==='string'){try{const code=error instanceof DocumentError&&['GOOGLE_ACCOUNT_IN_USE','INVITATION_INVALID','CONFLICT','PROVIDER_UNAVAILABLE','PROVIDER_CONFIG_CHANGED'].includes(error.code)?error.code:'retry',target=registration.cancel(state,token).replace('?google=retry','?google='+code);return reply.header('set-cookie',registrationCookie('',origin,0)).redirect(target,303);}catch{/* Unknown/expired state never reveals invitation data. */}}return reply.redirect('/invite?google=expired',303);}
}
