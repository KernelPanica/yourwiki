import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Database} from '../database.ts';
import type {SecretConfigs} from '../providers/secret-config.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
import {Plugins} from './service.ts';
export function registerPlugins(app:FastifyInstance,db:Database,secrets:SecretConfigs|undefined,publicUrl:string){
 const service=secrets?new Plugins(db,secrets):null,origin=new URL(publicUrl).origin;
 app.addHook('preClose',async()=>{await service?.runner.close();});
 async function handle(r:FastifyRequest,p:FastifyReply,mutation:boolean,action:(actor:string,authorize:()=>void)=>unknown){const actor=authenticateSession(db,sessionCookie(r));if(!actor)return p.code(401).send(errorEnvelope('SESSION_REQUIRED',r.id));if(actor.adminRole!=='giga')return p.code(403).send(errorEnvelope('ACCESS_DENIED',r.id));if(mutation&&(r.headers.origin!==origin||typeof r.headers['x-csrf-token']!=='string'||!validCsrf(actor,r.headers['x-csrf-token'])))return p.code(403).send(errorEnvelope('CSRF_REJECTED',r.id));if(!service)return p.code(503).send(errorEnvelope('PLUGIN_UNAVAILABLE',r.id));try{return await action(actor.userId,()=>{const fresh=authenticateSession(db,sessionCookie(r));if(!fresh||fresh.userId!==actor.userId)throw new DocumentError('SESSION_REQUIRED');if(fresh.adminRole!=='giga')throw new DocumentError('ACCESS_DENIED');});}catch(e){if(!(e instanceof DocumentError))throw e;return p.code(({ACCESS_DENIED:403,SESSION_REQUIRED:401,NOT_FOUND:404,CONFLICT:409,INVALID_REQUEST:400,PLUGIN_INVALID:400,PLUGIN_LIMIT:409,PLUGIN_CONFIG_REQUIRED:400,PLUGIN_DISABLED:409,PLUGIN_BUSY:429,PLUGIN_TIMEOUT:504,PLUGIN_EXECUTION_FAILED:502,PLUGIN_UNAVAILABLE:503} as Record<string,number>)[e.code]??500).send(errorEnvelope(e.code,r.id));}}
 const id=(r:FastifyRequest)=>(r.params as {id:string}).id;
 app.get('/api/admin/plugins',(r,p)=>handle(r,p,false,a=>service!.list(a)));
 app.post('/api/admin/plugins',{bodyLimit:400000},(r,p)=>handle(r,p,true,(a,auth)=>service!.install(a,r.body,auth)));
 app.get('/api/admin/plugins/:id/source',(r,p)=>handle(r,p,false,a=>service!.source(a,id(r))));
 app.put('/api/admin/plugins/:id',{bodyLimit:400000},(r,p)=>handle(r,p,true,a=>service!.update(a,id(r),r.body)));
 app.delete('/api/admin/plugins/:id',{bodyLimit:4096},(r,p)=>handle(r,p,true,a=>service!.remove(a,id(r),r.body)));
 app.post('/api/admin/plugins/:id/execute',{bodyLimit:400000},(r,p)=>handle(r,p,true,(a,auth)=>service!.execute(a,id(r),r.body,auth)));
}
