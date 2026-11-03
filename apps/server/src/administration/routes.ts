import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {Administration,object,text} from './service.ts';
import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession,validCsrf,tokenHash} from '../auth/sessions.ts';
import {errorEnvelope} from '../errors.ts';
export function registerAdministration(app:FastifyInstance,db:Database,publicUrl:string){
 const service=new Administration(db),origin=new URL(publicUrl).origin;
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;return reply.code(({SESSION_REQUIRED:401,ACCESS_DENIED:403,NOT_FOUND:404,INVALID_REQUEST:400,CONFLICT:409,LAST_GIGA:409,PARENT_TRASHED:409,INVITATION_INVALID:400,RATE_LIMITED:429,REMOTE_TRASH_REQUIRED:409,PURGE_RETENTION_REQUIRED:409,TREE_TOO_LARGE:409} as Record<string,number>)[error.code]??500).send(errorEnvelope(error.code,request.id));}
 async function handle(request:FastifyRequest,reply:FastifyReply,mutation:boolean,action:(id:string)=>unknown){const actor=authenticateSession(db,sessionCookie(request));if(!actor)return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));if(mutation&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(actor,request.headers['x-csrf-token'])))return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));try {return await action(actor.userId);}catch(error){return fail(error,request,reply);}}
 const param=(r:FastifyRequest,key:string)=>text(object(r.params)[key]);
 app.get('/api/admin/overview',(r,p)=>handle(r,p,false,id=>service.overview(id)));
 app.post('/api/admin/users',(r,p)=>handle(r,p,true,id=>service.createUser(id,r.body,()=>{const current=authenticateSession(db,sessionCookie(r));if(!current||current.userId!==id)throw new DocumentError('SESSION_REQUIRED');})));
 app.patch('/api/admin/users/:id',(r,p)=>handle(r,p,true,id=>service.updateUser(id,param(r,'id'),r.body,()=>{const current=authenticateSession(db,sessionCookie(r));if(!current||current.userId!==id)throw new DocumentError('SESSION_REQUIRED');})));
 app.put('/api/admin/users/:id/groups',(r,p)=>handle(r,p,true,id=>service.membership(id,param(r,'id'),r.body)));
 app.post('/api/admin/groups',(r,p)=>handle(r,p,true,id=>service.group(id,undefined,r.body)));
 app.put('/api/admin/groups/:id',(r,p)=>handle(r,p,true,id=>service.group(id,param(r,'id'),r.body)));
 app.post('/api/admin/invitations',(r,p)=>handle(r,p,true,id=>{service.actor(id);return service.invitation(id,r.body);}));
 app.get('/api/invitations',(r,p)=>handle(r,p,false,id=>service.ownInvitations(id)));
 app.post('/api/invitations',(r,p)=>handle(r,p,true,id=>service.invitation(id,r.body)));
 app.post('/api/auth/accept-invitation',{bodyLimit:8192},async(r,p)=>{if(r.headers.origin!==origin)return p.code(403).send(errorEnvelope('CSRF_REJECTED',r.id));try {transaction(db,()=>{const key='invite:'+tokenHash(r.ip),now=Date.now(),old=db.prepare('SELECT attempts,window_start FROM login_attempts WHERE key=?').get(key) as {attempts:number;window_start:number}|undefined;if(old&&old.window_start>now-900000&&old.attempts>=10)throw new DocumentError('RATE_LIMITED');db.prepare('INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start>? THEN attempts+1 ELSE 1 END,window_start=CASE WHEN window_start>? THEN window_start ELSE excluded.window_start END').run(key,now,now-900000,now-900000);});return await service.acceptInvitation(r.body);}catch(error){return fail(error,r,p);}});
 app.put('/api/admin/site-settings',{bodyLimit:32768},(r,p)=>handle(r,p,true,id=>service.settings(id,r.body)));
 app.get('/api/admin/resources/:id/acl',(r,p)=>handle(r,p,false,id=>service.readAcl(id,param(r,'id'))));
 app.put('/api/admin/resources/:id/acl',{bodyLimit:262144},(r,p)=>handle(r,p,true,id=>service.acl(id,param(r,'id'),r.body)));
 app.get('/api/library',(r,p)=>handle(r,p,false,id=>{const q=object(r.query);return service.library(id,q.parent===undefined?null:text(q.parent));}));
 app.post('/api/folders',(r,p)=>handle(r,p,true,id=>service.folder(id,r.body)));
 app.get('/api/admin/trash',(r,p)=>handle(r,p,false,id=>service.listTrash(id)));
 app.get('/api/admin/trash/confirmation/:kind/:id',(r,p)=>handle(r,p,false,id=>service.confirmation(id,param(r,'kind'),param(r,'id'))));
 app.post('/api/admin/trash/objects/:kind/:id',(r,p)=>handle(r,p,true,id=>service.trash(id,param(r,'kind'),param(r,'id'),r.body)));
 app.post('/api/admin/trash/entries/:id/restore',(r,p)=>handle(r,p,true,id=>service.restore(id,param(r,'id'))));
 app.post('/api/admin/trash/entries/:id/purge',(r,p)=>handle(r,p,true,id=>service.purge(id,param(r,'id'),r.body)));
 app.get('/api/account/preferences',(r,p)=>handle(r,p,false,id=>service.preferences(id)));
 app.put('/api/account/preferences',{bodyLimit:140000},(r,p)=>handle(r,p,true,id=>service.savePreferences(id,r.body)));
 app.get('/api/dashboard',(r,p)=>handle(r,p,false,id=>service.readDashboard(id)));
 app.put('/api/dashboard',{bodyLimit:1048576},(r,p)=>handle(r,p,true,id=>service.dashboard(id,r.body)));
}
