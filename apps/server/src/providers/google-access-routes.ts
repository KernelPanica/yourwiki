import {GoogleOriginalSessions} from './google-original-sessions.ts';
import {randomBytes} from 'node:crypto';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {DocumentError} from '../document-errors.ts';
import {ProviderError} from './adapter.ts';
import {errorEnvelope} from '../errors.ts';
import {googleCallbackHtml,googleCallbackScript} from './google-connect-callback.ts';
import {GoogleIdentities} from './google-identities.ts';
import {GoogleOriginals,GoogleGrantPlanner} from './google-grant-sync.ts';

/** Identity belongs to the signed-in person; Drive ownership belongs to the configured central account. */
export function registerGoogleAccess(app:FastifyInstance,db:Database,identities:GoogleIdentities,publicUrl:string){
 const origin=new URL(publicUrl).origin,originals=new GoogleOriginals(db),planner=new GoogleGrantPlanner(db),sessions=new GoogleOriginalSessions(db);
 function actor(request:FastifyRequest,write=false,admin=false){
  const token=sessionCookie(request),user=authenticateSession(db,token);if(!user)throw new DocumentError('SESSION_REQUIRED');
  if(admin&&user.adminRole!=='giga')throw new DocumentError('ACCESS_DENIED');
  if(Object.keys(request.query as object).length)throw new DocumentError('INVALID_REQUEST');
  const csrf=request.headers['x-csrf-token'];
  if(write&&(request.headers.origin!==origin||typeof csrf!=='string'||!validCsrf(user,csrf)))throw new DocumentError('CSRF_REJECTED');
  return {token,user,csrf:typeof csrf==='string'?csrf:''};
 }
 function body(request:FastifyRequest,fields:string[]){const value=request.body;if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k)||typeof (value as Record<string,unknown>)[k]!=='string'))throw new DocumentError('INVALID_REQUEST');return value as Record<string,string>;}
 function empty(request:FastifyRequest){if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError)&&!(error instanceof ProviderError))throw error;const status=({SESSION_REQUIRED:401,CSRF_REJECTED:403,ACCESS_DENIED:403,INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,PROVIDER_CONFIG_CHANGED:409,CONFIG_UNAVAILABLE:503,PROVIDER_UNAVAILABLE:503} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 app.get('/api/google/identity',(request,reply)=>{try{const {token}=actor(request);empty(request);return identities.current(token);}catch(e){return fail(e,request,reply);}});
 app.post('/api/google/identity/start',{bodyLimit:512},(request,reply)=>{try{const {token,csrf}=actor(request,true),value=body(request,['connectionId']);return identities.begin(token,csrf,value.connectionId);}catch(e){return fail(e,request,reply);}});
 app.post('/api/google/identity/result',{bodyLimit:512},(request,reply)=>{try{const {token,csrf}=actor(request,true),value=body(request,['state']);return identities.result(token,csrf,value.state);}catch(e){return fail(e,request,reply);}});
 app.post('/api/google/identity/complete',{bodyLimit:12288},async(request,reply)=>{try{const {token,csrf}=actor(request,true),value=body(request,['state','code']);return await identities.complete(token,csrf,value.state,value.code);}catch(e){return fail(e,request,reply);}});
 app.post('/api/google/identity/disconnect',{bodyLimit:512},(request,reply)=>{try{const {token,csrf}=actor(request,true);empty(request);return identities.disconnect(token,csrf);}catch(e){return fail(e,request,reply);}});
 app.get('/api/google/identity/callback',(_request,reply)=>{const nonce=randomBytes(18).toString('base64url');return reply.type('text/html').header('referrer-policy','no-referrer').header('content-security-policy',`default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`).send(googleCallbackHtml(nonce).replaceAll('/api/admin/google/oauth/callback.js','/api/google/identity/callback.js').replaceAll('/settings','/account'));});
 app.get('/api/google/identity/callback.js',(_request,reply)=>reply.type('text/javascript').header('referrer-policy','no-referrer').header('cross-origin-resource-policy','same-origin').send(googleCallbackScript.replaceAll('/api/admin/google/connect/','/api/google/identity/').replaceAll('yourwiki:google-connect','yourwiki:google-identity').replaceAll('administrator session','session').replaceAll('сессии администратора','сессии').replaceAll('настройки','аккаунт').replaceAll('настройках','аккаунте').replaceAll('settings','account')));
 app.get<{Params:{id:string}}>('/api/documents/:id/google-original',(request,reply)=>{try{const {user}=actor(request);empty(request);return originals.describe(user.userId,request.params.id);}catch(e){return fail(e,request,reply);}});
 app.get<{Params:{id:string}}>('/api/documents/:id/google-original/open',(request,reply)=>{try{const {user}=actor(request);empty(request);const value=originals.describe(user.userId,request.params.id);if(!value.available||!value.url)throw new DocumentError('CONFLICT');return reply.header('referrer-policy','no-referrer').redirect(value.url,303);}catch(e){return fail(e,request,reply);}});
 app.get<{Params:{id:string}}>('/api/documents/:id/google-original/sessions',(request,reply)=>{try{const {user}=actor(request);empty(request);return sessions.status(user,request.params.id);}catch(e){return fail(e,request,reply);}});
 app.post<{Params:{id:string}}>('/api/documents/:id/google-original/sessions',{bodyLimit:512},(request,reply)=>{try{const {user}=actor(request,true),value=body(request,['requestId']);return sessions.open(user,request.params.id,value.requestId);}catch(e){return fail(e,request,reply);}});
 app.post<{Params:{id:string;operation:string}}>('/api/documents/:id/google-original/sessions/:operation/close',{bodyLimit:512},(request,reply)=>{try{const {user}=actor(request,true);empty(request);return sessions.close(user,request.params.id,request.params.operation);}catch(e){return fail(e,request,reply);}});
 // Bounded metadata only. No provider IO in a settings request and no ACL imported from Google.
 app.get('/api/admin/google/sharing',(request,reply)=>{try{actor(request,false,true);empty(request);return {items:db.prepare("SELECT b.document_id AS documentId,d.title,COALESCE(g.state,'pending') AS state,g.error_code AS errorCode,COUNT(g.recipient) AS recipients,COALESCE(MIN(g.checked_at),0) AS checkedAt,COALESCE(e.state,'pending') AS exportState,e.error_code AS exportErrorCode FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN documents d ON d.id=b.document_id LEFT JOIN provider_google_grants g ON g.reference=b.reference LEFT JOIN provider_google_export_rules e ON e.reference=b.reference WHERE c.provider='google' AND c.enabled=1 GROUP BY b.document_id,g.state,g.error_code,e.state,e.error_code ORDER BY COALESCE(MIN(g.checked_at),0),b.document_id LIMIT 100").all()};}catch(e){return fail(e,request,reply);}});
 app.post('/api/admin/google/sharing/check',{bodyLimit:512},(request,reply)=>{try{actor(request,true,true);empty(request);return {scheduled:planner.schedule()};}catch(e){return fail(e,request,reply);}});
 app.addHook('onClose',()=>identities.close());
}
