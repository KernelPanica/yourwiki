import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import {GoogleLifecycle} from './google-lifecycle.ts';
export function registerGoogleLifecycle(app:FastifyInstance,db:Database,service:GoogleLifecycle,publicUrl:string){
 const origin=new URL(publicUrl).origin;
 function actor(request:FastifyRequest,write=false){const user=authenticateSession(db,sessionCookie(request));if(!user)throw new DocumentError('SESSION_REQUIRED');service.admin(user.userId);if(Object.keys(request.query as object).length)throw new DocumentError('INVALID_REQUEST');if(write&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(user,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');return user;}
 function empty(request:FastifyRequest){if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,ACCESS_DENIED:403,CSRF_REJECTED:403,INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,DOCUMENT_BUSY:409,OPERATION_MISMATCH:409,PROVIDER_CONFIG_CHANGED:409,CONFIG_UNAVAILABLE:503} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 app.get<{Params:{id:string}}>('/api/admin/google/destinations/:id',(request,reply)=>{try{const user=actor(request);empty(request);return service.destinations(user.userId,request.params.id);}catch(e){return fail(e,request,reply);}});
 app.get('/api/admin/google/operations',(request,reply)=>{try{const user=actor(request);empty(request);return service.list(user.userId);}catch(e){return fail(e,request,reply);}});
 app.get<{Params:{id:string}}>('/api/admin/google/operations/:id',(request,reply)=>{try{const user=actor(request);empty(request);return service.status(user.userId,request.params.id);}catch(e){return fail(e,request,reply);}});
 app.post<{Params:{id:string}}>('/api/admin/google/operations/:id/check',{bodyLimit:512},(request,reply)=>{try{const user=actor(request,true);empty(request);return service.check(user.userId,request.params.id);}catch(e){return fail(e,request,reply);}});
 app.post('/api/admin/google/operations',{bodyLimit:2048},(request,reply)=>{try{const user=actor(request,true);if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DocumentError('INVALID_REQUEST');return reply.code(202).send(service.request(user.userId,request.body));}catch(e){return fail(e,request,reply);}});
}
