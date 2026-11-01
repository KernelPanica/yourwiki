import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {SourceDelivery} from './delivery-status.ts';
import {DocumentError} from '../document-errors.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {errorEnvelope} from '../errors.ts';
export function registerProviderDelivery(app:FastifyInstance,db:Database,store:BlobStore,publicUrl:string){
 const service=new SourceDelivery(db,store),origin=new URL(publicUrl).origin;
 function actor(request:FastifyRequest,mutation=false){const session=authenticateSession(db,sessionCookie(request));if(!session)throw new DocumentError('SESSION_REQUIRED');if(mutation&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(session,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');if(Object.keys(request.query as object).length)throw new DocumentError('INVALID_REQUEST');return session;}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,CSRF_REJECTED:403,NOT_FOUND:404,ACCESS_DENIED:403,CONFLICT:409,INVALID_REQUEST:400} as Record<string,number>)[error.code]??500;return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 const params={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',minLength:1,maxLength:128}}};
 app.get<{Params:{id:string}}>('/api/documents/:id/provider-delivery',{schema:{params}},(request,reply)=>{try{const user=actor(request);if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');return service.status(user.userId,request.params.id);}catch(error){return fail(error,request,reply);}});
 for(const action of ['retry','check'] as const)app.post<{Params:{id:string}}>(`/api/documents/:id/provider-delivery/${action}`,{schema:{params},bodyLimit:4096},(request,reply)=>{try{const user=actor(request,true);return service[action](user.userId,request.params.id,request.body);}catch(error){return fail(error,request,reply);}});
}
