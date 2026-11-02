import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from './database.ts';
import {HistorySettings} from './history-settings.ts';
import {DocumentError} from './document-errors.ts';
import {sessionCookie} from './auth/routes.ts';
import {authenticateSession,validCsrf} from './auth/sessions.ts';
import {errorEnvelope} from './errors.ts';
export function registerHistorySettings(app:FastifyInstance,db:Database,publicUrl:string){
 const settings=new HistorySettings(db),origin=new URL(publicUrl).origin;
 function handle(request:FastifyRequest,reply:FastifyReply,mutation:boolean,action:(userId:string)=>unknown){
  const actor=authenticateSession(db,sessionCookie(request));if(!actor)return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));
  if(mutation&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(actor,request.headers['x-csrf-token'])))return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
  try{return action(actor.userId);}catch(error){if(!(error instanceof DocumentError))throw error;return reply.code(({ACCESS_DENIED:403,INVALID_REQUEST:400,CONFLICT:409} as Record<string,number>)[error.code]??500).send(errorEnvelope(error.code,request.id));}
 }
 app.get('/api/admin/history-settings',(request,reply)=>handle(request,reply,false,userId=>settings.read(userId)));
 app.put('/api/admin/history-settings',{bodyLimit:1024},(request,reply)=>handle(request,reply,true,userId=>{
  settings.read(userId);const value=request.body;
  if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'enabled')||!Object.hasOwn(value,'baseRevision')||typeof (value as any).enabled!=='boolean'||!Number.isSafeInteger((value as any).baseRevision)||(value as any).baseRevision<0)throw new DocumentError('INVALID_REQUEST');
  return settings.update(userId,value as {enabled:boolean;baseRevision:number});
 }));
}
