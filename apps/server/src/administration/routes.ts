import {UserPurge} from './user-purge.ts';
import {FolderMoves} from './folder-move.ts';
import {PasswordResets} from '../auth/password-reset.ts';
import {ensureGoogleDocumentTrash} from '../providers/google-trash-jobs.ts';
import {GoogleFolderTrashRequests} from '../providers/google-folder-trash.ts';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {Administration,object,text} from './service.ts';
import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {randomUUID} from 'node:crypto';
import type {GoogleTrashRequests} from '../providers/google-trash-jobs.ts';
import {errorEnvelope} from '../errors.ts';
export function registerAdministration(app:FastifyInstance,db:Database,publicUrl:string,options:{fileDashboard?:boolean;googleTrash?:GoogleTrashRequests}={}){
 if(options.googleTrash)ensureGoogleDocumentTrash(db);
 const service=new Administration(db),origin=new URL(publicUrl).origin;
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){if(!(error instanceof DocumentError))throw error;return reply.code(({SESSION_REQUIRED:401,ACCESS_DENIED:403,NOT_FOUND:404,INVALID_REQUEST:400,CONFLICT:409,LAST_GIGA:409,PARENT_TRASHED:409,INVITATION_INVALID:400,INVITATION_REQUIRED:409,RATE_LIMITED:429,REMOTE_TRASH_REQUIRED:409,PURGE_RETENTION_REQUIRED:409,TREE_TOO_LARGE:409,FOLDER_PROTECTED:409,INVALID_MOVE:400,DOCUMENT_BUSY:409,TRASH_PENDING:409,SOURCE_AMBIGUOUS:409,PROVIDER_CONFIG_CHANGED:409,TRASH_LIMIT:429} as Record<string,number>)[error.code]??500).send(errorEnvelope(error.code,request.id));}
 async function handle(request:FastifyRequest,reply:FastifyReply,mutation:boolean,action:(id:string)=>unknown){const actor=authenticateSession(db,sessionCookie(request));if(!actor)return reply.code(401).send(errorEnvelope('SESSION_REQUIRED',request.id));if(mutation&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(actor,request.headers['x-csrf-token'])))return reply.code(403).send(errorEnvelope('CSRF_REJECTED',request.id));try {return await action(actor.userId);}catch(error){return fail(error,request,reply);}}
 const param=(r:FastifyRequest,key:string)=>text(object(r.params)[key]);
 app.get('/api/admin/overview',(r,p)=>handle(r,p,false,id=>service.overview(id)));
 app.post('/api/admin/users',(r,p)=>handle(r,p,true,id=>service.createUser(id,r.body,()=>{const current=authenticateSession(db,sessionCookie(r));if(!current||current.userId!==id)throw new DocumentError('SESSION_REQUIRED');})));
 app.patch('/api/admin/users/:id',(r,p)=>handle(r,p,true,id=>service.updateUser(id,param(r,'id'),r.body,()=>{const current=authenticateSession(db,sessionCookie(r));if(!current||current.userId!==id)throw new DocumentError('SESSION_REQUIRED');})));
 app.post('/api/admin/users/:id/password-reset',{bodyLimit:4096},(r,p)=>handle(r,p,true,id=>new PasswordResets(db).create(id,param(r,'id'),object(r.body).baseRevision)));
 app.put('/api/admin/users/:id/groups',(r,p)=>handle(r,p,true,id=>service.membership(id,param(r,'id'),r.body)));
 app.get('/api/admin/groups/:id',(r,p)=>handle(r,p,false,id=>service.memberGroup(id,param(r,'id'))));
 app.put('/api/admin/groups/:id/members',(r,p)=>handle(r,p,true,id=>service.saveGroupMembers(id,param(r,'id'),r.body)));
 app.post('/api/admin/groups',(r,p)=>handle(r,p,true,id=>service.group(id,undefined,r.body)));
 app.put('/api/admin/groups/:id',(r,p)=>handle(r,p,true,id=>service.group(id,param(r,'id'),r.body)));
 app.post('/api/admin/invitations',(r,p)=>handle(r,p,true,id=>{service.actor(id);return service.invitation(id,r.body);}));
 app.get('/api/invitations',(r,p)=>handle(r,p,false,id=>service.ownInvitations(id)));
 app.post('/api/invitations',(r,p)=>handle(r,p,true,id=>service.invitation(id,r.body)));

 app.put('/api/admin/site-settings',{bodyLimit:32768},(r,p)=>handle(r,p,true,id=>service.settings(id,r.body)));
 app.get('/api/admin/resources/:id/acl',(r,p)=>handle(r,p,false,id=>service.readAcl(id,param(r,'id'))));
 app.put('/api/admin/resources/:id/acl',{bodyLimit:262144},(r,p)=>handle(r,p,true,id=>service.acl(id,param(r,'id'),r.body)));
 app.get('/api/library',(r,p)=>handle(r,p,false,id=>{const q=object(r.query);return service.library(id,q.parent===undefined?null:text(q.parent));}));
 app.post('/api/documents/:id/move',{bodyLimit:4096},(r,p)=>handle(r,p,true,id=>new FolderMoves(db).move(id,param(r,'id'),r.body,'document')));
 app.post('/api/folders/:id/move',{bodyLimit:4096},(r,p)=>handle(r,p,true,id=>new FolderMoves(db).move(id,param(r,'id'),r.body)));
 app.post('/api/folders',(r,p)=>handle(r,p,true,id=>service.folder(id,r.body)));
 app.get('/api/admin/trash/user-cleanup',(r,p)=>handle(r,p,false,id=>{service.actor(id,true);return new UserPurge(db).status();}));
 app.post('/api/admin/trash/user-cleanup/retry',{bodyLimit:4096},(r,p)=>handle(r,p,true,id=>{service.actor(id,true);const result=new UserPurge(db).retry();db.prepare("INSERT INTO administration_audit(actor_id,action,target,created_at) VALUES(?,'user.purge.retry','*',?)").run(id,Date.now());return result;}));
 app.get('/api/admin/trash/cleanup',(r,p)=>handle(r,p,false,id=>service.purgeStatus(id)));
 app.get('/api/admin/trash',(r,p)=>handle(r,p,false,id=>service.listTrash(id)));
 app.get('/api/admin/trash/confirmation/:kind/:id',(r,p)=>handle(r,p,false,id=>service.confirmation(id,param(r,'kind'),param(r,'id'))));
 app.post('/api/admin/trash/objects/:kind/:id',(r,p)=>handle(r,p,true,id=>{const kind=param(r,'kind'),target=param(r,'id');if(kind==='resource'&&options.googleTrash&&db.prepare('SELECT 1 FROM provider_google_folders WHERE resource_id=?').get(target)){const confirmation=service.confirmation(id,kind,target);if(object(r.body).confirmation!==confirmation.confirmation)throw new DocumentError('CONFLICT');const result=new GoogleFolderTrashRequests(db).request(id,target);p.code(202);return result;}if(kind==='resource'&&options.googleTrash&&db.prepare("SELECT 1 FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.provider='google'").get(target)){const confirmation=service.confirmation(id,kind,target);if(object(r.body).confirmation!==confirmation.confirmation)throw new DocumentError('CONFLICT');const result=options.googleTrash.request(id,target,{requestId:randomUUID(),trashed:true});p.code(['confirmed','failed'].includes(result.state)?200:202);return result;}return service.trash(id,kind,target,r.body);}));
 app.post('/api/admin/trash/entries/:id/check',(r,p)=>handle(r,p,true,id=>{const entry=db.prepare("SELECT object_id FROM local_trash WHERE id=? AND restored_at IS NULL AND purged_at IS NULL AND json_extract(details,'$.googleDocumentTrash')=1").get(param(r,'id')) as {object_id:string}|undefined;if(entry&&options.googleTrash){return options.googleTrash.checkEntry(id,entry.object_id);}return new GoogleFolderTrashRequests(db).check(id,param(r,'id'));}));
 app.post('/api/admin/trash/entries/:id/restore',(r,p)=>handle(r,p,true,id=>{const document=db.prepare("SELECT object_id FROM local_trash WHERE id=? AND restored_at IS NULL AND purged_at IS NULL AND json_extract(details,'$.googleDocumentTrash')=1").get(param(r,'id')) as {object_id:string}|undefined;if(document&&options.googleTrash){const result=options.googleTrash.restoreEntry(id,document.object_id);p.code(result.state==='restored'?200:202);return result;}const entry=db.prepare("SELECT object_id FROM local_trash WHERE id=? AND restored_at IS NULL AND purged_at IS NULL AND json_extract(details,'$.googleFolderTrash')=1").get(param(r,'id')) as {object_id:string}|undefined;if(entry&&options.googleTrash){const result=new GoogleFolderTrashRequests(db).request(id,entry.object_id,false);p.code(202);return result;}return service.restore(id,param(r,'id'));}));
 app.post('/api/admin/trash/entries/:id/purge',(r,p)=>handle(r,p,true,id=>service.purge(id,param(r,'id'),r.body)));
 app.get('/api/account/preferences',(r,p)=>handle(r,p,false,id=>service.preferences(id)));
 app.put('/api/account/preferences',{bodyLimit:140000},(r,p)=>handle(r,p,true,id=>service.savePreferences(id,r.body)));
 if(!options.fileDashboard)app.get('/api/dashboard',(r,p)=>handle(r,p,false,id=>service.readDashboard(id)));
 if(!options.fileDashboard)app.put('/api/dashboard',{bodyLimit:1048576},(r,p)=>handle(r,p,true,id=>service.dashboard(id,r.body)));
}
