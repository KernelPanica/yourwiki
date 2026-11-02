import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Database } from './database.ts';
import { ChangeFeed } from './change-feed.ts';
import { authenticateSession } from './auth/sessions.ts';
import { sessionCookie } from './auth/routes.ts';
import { errorEnvelope } from './errors.ts';
export function registerChanges(app:FastifyInstance,db:Database,publicUrl:string,pollMs?:number){
 const feed=new ChangeFeed(db,{pollMs}),origin=new URL(publicUrl).origin;
 app.addHook('preClose',async()=>{feed.close();});
 app.get('/api/changes',{schema:{querystring:{type:'object',additionalProperties:false,properties:{}}}},async(request,reply)=>{
  if(request.url.includes('?'))return reply.code(400).send(errorEnvelope('INVALID_REQUEST',request.id));
  const token=sessionCookie(request);
  if(!authenticateSession(db,token))return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));
  if(request.headers.origin!==undefined&&request.headers.origin!==origin)return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));
  const stream=new PassThrough({highWaterMark:4096});let stop=()=>{},killer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{stop();clearTimeout(killer);stream.destroy();};
  const end=()=>{stream.end();killer=setTimeout(()=>{stream.destroy();reply.raw.destroy();},1000);killer.unref();};
  try{
   stop=feed.subscribe(token,event=>stream.write(event.type==='heartbeat'?': keep-alive\n\n':`event: ${event.type}\ndata: ${JSON.stringify(event.type==='documents'?{documentIds:event.documentIds}:{})}\n\n`),end);
  }catch(error){
   stream.destroy();const code=error instanceof Error?error.message:'NOT_READY';
   return reply.code(code==='CONNECTION_LIMIT'?429:code==='SESSION_REQUIRED'?401:503).send(errorEnvelope(code==='CONNECTION_LIMIT'?'RATE_LIMITED':code==='SESSION_REQUIRED'?'SESSION_REQUIRED':'NOT_READY',request.id));
  }
  reply.raw.once('close',cleanup);reply.raw.once('finish',()=>clearTimeout(killer));stream.once('close',stop);
  stream.write('retry: 1500\nevent: ready\ndata: {}\n\n');
  return reply.type('text/event-stream').header('x-accel-buffering','no').header('connection','keep-alive').send(stream);
 });
}
