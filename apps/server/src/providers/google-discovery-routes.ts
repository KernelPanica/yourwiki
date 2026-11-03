import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import type {GoogleDiscoveryRequests} from './google-discovery-jobs.ts';
export function registerGoogleDiscovery(app:FastifyInstance,db:Database,service:GoogleDiscoveryRequests,publicUrl:string){
 const origin=new URL(publicUrl).origin;
 function actor(request:FastifyRequest,write=false){const user=authenticateSession(db,sessionCookie(request));if(!user)throw new DocumentError('SESSION_REQUIRED');if(user.adminRole!=='giga')throw new DocumentError('ACCESS_DENIED');if(Object.keys(request.query as object).length)throw new DocumentError('INVALID_REQUEST');if(write&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(user,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');return user;}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,ACCESS_DENIED:403,CSRF_REJECTED:403,INVALID_REQUEST:400,NOT_FOUND:404,OPERATION_MISMATCH:409,CONFLICT:409,PROVIDER_CONFIG_CHANGED:409,CONFIG_UNAVAILABLE:503,DISCOVERY_LIMIT:429} as Record<string,number>)[error.code]??500;if(status===429||status===503)reply.header('retry-after','5');return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id));}
 app.post('/api/admin/google/discovery',{bodyLimit:2048},(request,reply)=>{try{const user=actor(request,true);if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new DocumentError('INVALID_REQUEST');const result=service.request(user.userId,request.body);return reply.code(['queued','running'].includes(result.state)?202:200).send(result);}catch(error){return fail(error,request,reply);}});
 app.get<{Params:{id:string}}>('/api/admin/google/discovery/:id',(request,reply)=>{try{const user=actor(request);if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');return service.status(user.userId,request.params.id);}catch(error){return fail(error,request,reply);}});
}
