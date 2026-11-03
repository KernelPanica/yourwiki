import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import type {GoogleImportRequests} from './google-import-jobs.ts';
export function registerGoogleImports(app:FastifyInstance,db:Database,service:GoogleImportRequests,publicUrl:string){
 const origin=new URL(publicUrl).origin;
 function actor(request:FastifyRequest,write=false){const user=authenticateSession(db,sessionCookie(request));if(!user)throw new DocumentError('SESSION_REQUIRED');if(user.adminRole!=='giga')throw new DocumentError('ACCESS_DENIED');if(Object.keys(request.query as object).length)throw new DocumentError('INVALID_REQUEST');if(write&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(user,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');return user;}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,ACCESS_DENIED:403,CSRF_REJECTED:403,INVALID_REQUEST:400,NOT_FOUND:404,CONFLICT:409,PROVIDER_CONFIG_CHANGED:409,OPERATION_MISMATCH:409,SOURCE_ALREADY_BOUND:409,IMPORT_BUSY:409,PREVIEW_UNSUPPORTED:422,IMPORT_LIMIT:429,CONFIG_UNAVAILABLE:503} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 app.post('/api/admin/google/imports',{bodyLimit:2048},(request,reply)=>{try{const user=actor(request,true);if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DocumentError('INVALID_REQUEST');const value=service.request(user.userId,request.body);return reply.code(['queued','receiving','staged'].includes(value.state)?202:200).send(value);}catch(error){return fail(error,request,reply);}});
 app.get<{Params:{id:string}}>('/api/admin/google/imports/:id',(request,reply)=>{try{const user=actor(request);if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');return service.status(user.userId,request.params.id);}catch(error){return fail(error,request,reply);}});
}
