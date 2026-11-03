import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import type {GoogleTrashRequests} from './google-trash-jobs.ts';
export function registerGoogleTrash(app:FastifyInstance,db:Database,service:GoogleTrashRequests,publicUrl:string){
 const origin=new URL(publicUrl).origin;
 function actor(request:FastifyRequest,write=false,list=false){const user=authenticateSession(db,sessionCookie(request));if(!user)throw new DocumentError('SESSION_REQUIRED');if(!['giga','simple'].includes(user.adminRole))throw new DocumentError('ACCESS_DENIED');if(Object.keys(request.query as object).some(k=>!list||k!=='after'))throw new DocumentError('INVALID_REQUEST');if(write&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(user,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');return user;}
 function empty(request:FastifyRequest){if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,ACCESS_DENIED:403,CSRF_REJECTED:403,INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,TRASH_PENDING:409,SOURCE_AMBIGUOUS:409,DOCUMENT_BUSY:409,OPERATION_MISMATCH:409,PROVIDER_CONFIG_CHANGED:409,TRASH_LIMIT:429} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 app.post<{Params:{id:string}}>('/api/documents/:id/google-trash',{bodyLimit:1024},(request,reply)=>{try{const user=actor(request,true);if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DocumentError('INVALID_REQUEST');const result=service.request(user.userId,request.params.id,request.body);return reply.code(['confirmed','failed'].includes(result.state)?200:202).send(result);}catch(error){return fail(error,request,reply);}});
 app.post<{Params:{id:string}}>('/api/admin/google/trash/:id/check',{bodyLimit:1024},(request,reply)=>{try{const user=actor(request,true);empty(request);return service.check(user.userId,request.params.id);}catch(error){return fail(error,request,reply);}});
 app.get('/api/admin/google/trash',(request,reply)=>{try{const user=actor(request,false,true);empty(request);const after=(request.query as {after?:unknown}).after;if(after!==undefined&&typeof after!=='string')throw new DocumentError('INVALID_REQUEST');return service.list(user.userId,after as string|undefined);}catch(error){return fail(error,request,reply);}});
 app.get<{Params:{id:string}}>('/api/admin/google/trash/:id',(request,reply)=>{try{const user=actor(request);empty(request);return service.status(user.userId,request.params.id);}catch(error){return fail(error,request,reply);}});
}
