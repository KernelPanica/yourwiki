import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import {authenticateSession} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import type {ProviderConnections} from './connections.ts';
/** Private administrative metadata only. Config/connect writes require separate provider-specific flows. */
export function registerProviderConnections(app:FastifyInstance,db:Database,connections:ProviderConnections){
 function actor(request:FastifyRequest){const session=authenticateSession(db,sessionCookie(request));if(!session)throw new DocumentError('SESSION_REQUIRED');if(session.adminRole!=='giga')throw new DocumentError('ACCESS_DENIED');if(request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')throw new DocumentError('INVALID_REQUEST');return session;}
 function query(request:FastifyRequest,allowed:string[]){const value=request.query as Record<string,unknown>;if(Object.keys(value).some(key=>!allowed.includes(key)))throw new DocumentError('INVALID_REQUEST');return value;}
 function fail(cause:unknown,request:FastifyRequest,reply:FastifyReply){if(!(cause instanceof DocumentError))throw cause;const status=({SESSION_REQUIRED:401,ACCESS_DENIED:403,NOT_FOUND:404,INVALID_REQUEST:400,CONFLICT:409,CONNECTION_EXISTS:409,CONNECTION_IDENTITY_IMMUTABLE:409,MIGRATION_MISMATCH:409,CONFIG_UNAVAILABLE:503} as Record<string,number>)[cause.code]??500;if(status===503)reply.header('retry-after','1');return reply.code(status).send(errorEnvelope(status===500?'INTERNAL_ERROR':cause.code,request.id));}
 app.get('/api/admin/provider-connections',(request,reply)=>{try{const user=actor(request),q=query(request,['after','limit']);if(q.after!==undefined&&typeof q.after!=='string'||q.limit!==undefined&&(typeof q.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(q.limit)))throw new DocumentError('INVALID_REQUEST');return connections.list(user.userId,{after:q.after as string|undefined,limit:q.limit===undefined?undefined:Number(q.limit)});}catch(cause){return fail(cause,request,reply);}});
 app.get<{Params:{id:string}}>('/api/admin/provider-connections/:id',{schema:{params:{type:'object',required:['id'],additionalProperties:false,properties:{id:{type:'string',pattern:'^[A-Za-z0-9_.:-]{1,128}$'}}}}},(request,reply)=>{try{const user=actor(request);query(request,[]);return connections.get(user.userId,request.params.id);}catch(cause){return fail(cause,request,reply);}});
}
