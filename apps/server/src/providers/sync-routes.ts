import type {FastifyInstance} from 'fastify';
import type {Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession} from '../auth/sessions.ts';
import {errorEnvelope} from '../errors.ts';
import {DocumentError} from '../document-errors.ts';
import {ProviderSync} from './sync-status.ts';
export function registerProviderSync(app:FastifyInstance,db:Database,store:BlobStore){
 const service=new ProviderSync(db,store);
 app.get<{Params:{id:string}}>('/api/documents/:id/provider-sync',{schema:{params:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',minLength:1,maxLength:128}}}}},(request,reply)=>{
  const actor=authenticateSession(db,sessionCookie(request));if(!actor)return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));
  if(Object.keys(request.query as object).length||request.body!==undefined||request.headers['transfer-encoding']!==undefined||request.headers['content-length']!==undefined&&request.headers['content-length']!=='0')return reply.code(400).send(errorEnvelope('INVALID_REQUEST',request.id));
  try{return service.status(actor.userId,request.params.id);}catch(error){if(error instanceof DocumentError&&error.code==='NOT_FOUND')return reply.code(404).send(errorEnvelope('NOT_FOUND',request.id));throw error;}
 });
}
