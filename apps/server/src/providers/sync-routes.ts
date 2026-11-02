import {SyncActions} from './sync-actions.ts';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {errorEnvelope} from '../errors.ts';
import {DocumentError} from '../document-errors.ts';
import {ProviderSync} from './sync-status.ts';
export function registerProviderSync(app:FastifyInstance,db:Database,store:BlobStore,publicUrl:string){
 const service=new ProviderSync(db,store),actions=new SyncActions(db,store),origin=new URL(publicUrl).origin;
 const id={type:'string',minLength:1,maxLength:128},requestId={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'};
 function actor(request:FastifyRequest,write=false){const user=authenticateSession(db,sessionCookie(request));if(!user)throw new DocumentError('SESSION_REQUIRED');if(write&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(user,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');if(Object.keys(request.query as object).length)throw new DocumentError('INVALID_REQUEST');return user;}
 function emptyGet(request:FastifyRequest){if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,CSRF_REJECTED:403,NOT_FOUND:404,ACCESS_DENIED:403,INVALID_REQUEST:400,CONFLICT:409,OPERATION_MISMATCH:409,SYNC_ACTION_PENDING:409,PROVIDER_CONFIG_CHANGED:409} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 app.get<{Params:{id:string}}>('/api/documents/:id/provider-sync/actions',{schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id}}}},(request,reply)=>{try{const user=actor(request);emptyGet(request);return {action:actions.active(user.userId,request.params.id)};}catch(error){return fail(error,request,reply);}});
 app.get<{Params:{id:string;requestId:string}}>('/api/documents/:id/provider-sync/actions/:requestId',{schema:{params:{type:'object',additionalProperties:false,required:['id','requestId'],properties:{id,requestId}}}},(request,reply)=>{try{const user=actor(request);emptyGet(request);return actions.status(user.userId,request.params.id,request.params.requestId);}catch(error){return fail(error,request,reply);}});
 for(const kind of ['check','apply','discard'] as const)app.post<{Params:{id:string}}>(`/api/documents/:id/provider-sync/${kind}`,{bodyLimit:2048,schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id}}}},(request,reply)=>{try{const user=actor(request,true);if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DocumentError('INVALID_REQUEST');const value=actions.request(user,request.params.id,kind,request.body);return reply.code(value.state==='queued'?202:200).send(value);}catch(error){return fail(error,request,reply);}});

 app.get<{Params:{id:string}}>('/api/documents/:id/provider-sync',{schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',minLength:1,maxLength:128}}}}},(request,reply)=>{
  const actor=authenticateSession(db,sessionCookie(request));if(!actor)return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));
  if(Object.keys(request.query as object).length||request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')return reply.code(400).send(errorEnvelope('INVALID_REQUEST',request.id));
  try{return service.status(actor.userId,request.params.id);}catch(error){if(error instanceof DocumentError&&error.code==='NOT_FOUND')return reply.code(404).send(errorEnvelope('NOT_FOUND',request.id));throw error;}
 });
}
