import {Readable} from 'node:stream';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from './database.ts';
import type {BlobStore} from './storage/blobs.ts';
import {HistoryRead,type HistoryEntry} from './history-read.ts';
import {DocumentError} from './document-errors.ts';
import {sessionCookie} from './auth/routes.ts';
import {authenticateSession} from './auth/sessions.ts';
import {byteRange} from './http/byte-range.ts';
import {errorEnvelope} from './errors.ts';
const docParams={type:'object',required:['id'],properties:{id:{type:'string',minLength:1,maxLength:128}}};
const versionParams={type:'object',required:['id','entryId'],properties:{...docParams.properties,entryId:{type:'string',pattern:'^[1-9][0-9]{0,15}$'}}};
function disposition(entry:HistoryEntry){
 const title=Array.from(entry.title||'history-'+entry.id).slice(0,200).join('').replace(/[\\/\x00-\x1f\x7f]/g,'_'),name=title.toLowerCase().endsWith('.'+entry.format)?title:title+'.'+entry.format;
 const encoded=encodeURIComponent(Buffer.from(name,'utf8').toString('utf8')).replace(/[!'()*]/g,value=>'%'+value.charCodeAt(0).toString(16).toUpperCase());return `attachment; filename="history-${entry.id}.${entry.format}"; filename*=UTF-8''${encoded}`;
}
export function registerHistory(app:FastifyInstance,db:Database,store:BlobStore){
 const reader=new HistoryRead(db,store),active=new Set<AbortController>();
 app.addHook('preClose',async()=>{for(const controller of active)controller.abort(new DocumentError('HISTORY_CLOSED'));await reader.close();});
 function identity(request:FastifyRequest){const actor=authenticateSession(db,sessionCookie(request));if(!actor)throw new DocumentError('SESSION_REQUIRED');return actor;}
 function query(request:FastifyRequest,keys:string[]){const value=request.query as Record<string,unknown>;if(Object.keys(value).some(key=>!keys.includes(key)))throw new DocumentError('INVALID_REQUEST');return value;}
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){
  if(!(error instanceof DocumentError))throw error;const status=({SESSION_REQUIRED:401,NOT_FOUND:404,ACCESS_DENIED:403,INVALID_REQUEST:400,INVALID_RANGE:416,HISTORY_CORRUPT:422,HISTORY_BUSY:503,HISTORY_CLOSED:503,HISTORY_INTERRUPTED:503,HISTORY_UNAVAILABLE:503,HISTORY_VERIFY_LEASE_LOST:503,HISTORY_VERIFY_TIMEOUT:504} as Record<string,number>)[error.code]??500;
  const body=errorEnvelope(status===500?'INTERNAL_ERROR':error.code,request.id);if(error.code==='HISTORY_CORRUPT')body.recoveryActions=['refresh_history','download_current'];if(status===503)reply.header('retry-after','1');return reply.code(status).send(body);
 }
 app.get<{Params:{id:string}}>('/api/documents/:id/history',{schema:{params:docParams}},(request,reply)=>{
  try{const actor=identity(request),q=query(request,['after','limit']);if(q.after!==undefined&&typeof q.after!=='string'||q.limit!==undefined&&(typeof q.limit!=='string'||!/^[1-9][0-9]{0,2}$/.test(q.limit)))throw new DocumentError('INVALID_REQUEST');return reader.list(actor.userId,request.params.id,{after:q.after as string|undefined,limit:q.limit===undefined?undefined:Number(q.limit)});}catch(error){return fail(error,request,reply);}
 });
 app.get<{Params:{id:string;entryId:string}}>('/api/documents/:id/history/:entryId',{schema:{params:versionParams}},(request,reply)=>{
  try{const actor=identity(request);query(request,[]);return reader.entry(actor.userId,request.params.id,Number(request.params.entryId));}catch(error){return fail(error,request,reply);}
 });
 app.get<{Params:{id:string;entryId:string}}>('/api/documents/:id/history/:entryId/content',{schema:{params:versionParams}},async(request,reply)=>{
  const controller=new AbortController();active.add(controller);const abort=()=>controller.abort(new DocumentError('HISTORY_INTERRUPTED'));
  const cleanup=()=>{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed);active.delete(controller);};const closed=()=>{if(!reply.raw.writableFinished)abort();cleanup();};request.raw.once('aborted',abort);reply.raw.once('close',closed);let streaming=false;
  try{
   const actor=identity(request),token=sessionCookie(request),id=Number(request.params.entryId);query(request,[]);const snapshot=reader.entry(actor.userId,request.params.id,id);if(!snapshot.document.export)throw new DocumentError('ACCESS_DENIED');const range=byteRange(request.headers.range,snapshot.item.size);
   reply.header('accept-ranges','bytes');if(range===null)return reply.code(416).header('content-range',`bytes */${snapshot.item.size}`).send(errorEnvelope('INVALID_RANGE',request.id));
   const value=await reader.download(actor.userId,request.params.id,id,{range,signal:controller.signal,authorize:()=>{const current=authenticateSession(db,token);if(!current||current.userId!==actor.userId)throw new DocumentError('SESSION_REQUIRED');}});controller.signal.throwIfAborted();
   const stream=Readable.from(value.bytes,{objectMode:false});stream.once('close',cleanup);streaming=true;
   reply.type('application/octet-stream').header('content-disposition',disposition(value.entry)).header('content-length',range?range.end-range.start+1:value.entry.size).header('cross-origin-resource-policy','same-origin').header('content-security-policy',"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
   if(range)reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${value.entry.size}`);return reply.send(stream);
  }catch(error){return fail(error,request,reply);}finally{if(!streaming)cleanup();}
 });
}
