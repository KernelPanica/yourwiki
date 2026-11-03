import {Readable} from 'node:stream';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {AccessService} from '../access.ts';
import {authenticateSession} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {DocumentError} from '../document-errors.ts';
import {errorEnvelope} from '../errors.ts';
export function registerMigrationRecovery(app:FastifyInstance,db:Database,store:BlobStore){const access=new AccessService(db);
 function actor(r:FastifyRequest,id:string){const a=authenticateSession(db,sessionCookie(r));if(!a)throw new DocumentError('SESSION_REQUIRED');if(!access.allows(a.userId,id,'read'))throw new DocumentError('NOT_FOUND');return a;}
 function fail(e:unknown,r:FastifyRequest,p:FastifyReply){if(!(e instanceof DocumentError))throw e;return p.code(e.code==='SESSION_REQUIRED'?401:e.code==='ACCESS_DENIED'?403:404).send(errorEnvelope(e.code,r.id));}
 app.get<{Params:{id:string}}>('/api/documents/:id/migration-recovery',async(r,p)=>{try{const a=actor(r,r.params.id);const owner=(db.prepare('SELECT owner_id FROM resources WHERE id=?').get(r.params.id) as {owner_id:string}).owner_id;return {items:db.prepare(`SELECT id,reason,size,created_at AS createdAt FROM recovery_copies WHERE document_id=? AND reason LIKE 'LEGACY_%' AND (?='giga' OR author_id=? OR (author_id IS NULL AND ?=?)) ORDER BY created_at,id LIMIT 1000`).all(r.params.id,a.adminRole,a.userId,a.userId,owner),canDownload:access.allows(a.userId,r.params.id,'export')};}catch(e){return fail(e,r,p);}});
 app.get<{Params:{id:string;recoveryId:string}}>('/api/documents/:id/migration-recovery/:recoveryId/content',async(r,p)=>{try{const id=r.params.id;let a=actor(r,id);const row=db.prepare("SELECT * FROM recovery_copies WHERE id=? AND document_id=? AND reason LIKE 'LEGACY_%'").get(r.params.recoveryId,id) as {author_id:string|null;digest:string;size:number;reason:string}|undefined;const owner=(db.prepare('SELECT owner_id FROM resources WHERE id=?').get(id) as {owner_id:string}).owner_id;
 const check=()=>{a=actor(r,id);if(!row||a.adminRole!=='giga'&&a.userId!==(row.author_id??owner))throw new DocumentError('NOT_FOUND');if(!access.allows(a.userId,id,'export'))throw new DocumentError('ACCESS_DENIED');};check();const source=await store.read(row!.digest);check();const stream=Readable.from((async function*(){try{for await(const chunk of source){check();yield chunk;}}finally{source.destroy();}})());const extension=row!.reason==='LEGACY_CRDT_STATE'?'bin':(db.prepare('SELECT format FROM documents WHERE id=?').get(id) as {format:string}).format;return p.type('application/octet-stream').header('content-disposition',`attachment; filename="recovered.${/^[a-z0-9.-]{1,32}$/.test(extension)?extension:'bin'}"`).header('content-length',row!.size).send(stream);
 }catch(e){return fail(e,r,p);}});
}
