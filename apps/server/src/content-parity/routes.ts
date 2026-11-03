import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,sep,extname,isAbsolute} from 'node:path';
import type {Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {BlobTooLargeError} from '../storage/blobs.ts';
import {DocumentError} from '../document-errors.ts';
import {sessionCookie} from '../auth/routes.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {errorEnvelope} from '../errors.ts';
import type {SecretConfigs} from '../providers/secret-config.ts';
import {ContentParity} from './service.ts';
import {ContentAI} from './ai.ts';
import type {AiTransport} from './ai-http.ts';
import {graphBytes,attachmentBytes,invalid} from './validation.ts';
export type ContentParityOptions={secrets?:SecretConfigs;drawioRoot?:string;transport?:AiTransport};
export function registerContentParity(app:FastifyInstance,db:Database,store:BlobStore,publicUrl:string,options:ContentParityOptions={}){
 const content=new ContentParity(db,store),ai=new ContentAI(content,options),origin=new URL(publicUrl).origin;
 app.addHook('onClose',()=>ai.close());
 function identity(request:FastifyRequest,mutation:boolean){const actor=authenticateSession(db,sessionCookie(request));if(!actor)throw new DocumentError('SESSION_REQUIRED');if(mutation&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(actor,request.headers['x-csrf-token'])))throw new DocumentError('CSRF_REJECTED');return actor;}
 function guard(request:FastifyRequest,userId:string,mutation:boolean){return ()=>{if(request.raw.aborted)throw new DocumentError('REQUEST_ABORTED');const current=identity(request,mutation);if(current.userId!==userId)throw new DocumentError('SESSION_REQUIRED');};}
 function failure(error:unknown,request:FastifyRequest,reply:FastifyReply){if(error instanceof BlobTooLargeError)error=new DocumentError('PAYLOAD_TOO_LARGE');if(!(error instanceof DocumentError))throw error;const code=error.code,status=({NOT_FOUND:404,ACCESS_DENIED:403,SESSION_REQUIRED:401,CSRF_REJECTED:403,CONFLICT:409,OFFICE_ACTIVE:409,HISTORY_LIMIT:409,ANCHOR_UNSUPPORTED:409,CONTENT_LIMIT:409,INVALID_REQUEST:400,PAYLOAD_TOO_LARGE:413,CONTENT_UNAVAILABLE:503,REQUEST_ABORTED:499,AI_NOT_CONFIGURED:503,AI_KEY_REQUIRED:400,AI_BUSY:409,AI_RATE_LIMIT:429,AI_INPUT_TOO_LARGE:413,AI_TEXT_UNAVAILABLE:422,AI_PROVIDER_REJECTED:502,AI_RESPONSE_TOO_LARGE:502,AI_UNAVAILABLE:503,AI_INVALID_RESPONSE:502} as Record<string,number>)[code]??500;const envelope=errorEnvelope(status===500?'INTERNAL_ERROR':code,request.id);envelope.operationId=error.recoveryId;if(code==='CONFLICT')envelope.recoveryActions=['copy_changes','download_changes','reload'];return reply.code(status).send(envelope);}
 type Params={id:string;reviewId?:string;attachmentId?:string};
 function route(method:'GET'|'POST'|'PUT'|'DELETE',url:string,action:(userId:string,params:Params,body:unknown,check:()=>void,request:FastifyRequest,reply:FastifyReply)=>unknown,limit=16384){app.route<{Params:Params}>({method,url,bodyLimit:limit,handler:async(request,reply)=>{try{const actor=identity(request,method!=='GET');if(Object.values(request.params).some(id=>typeof id!=='string'||!id||id.length>128))invalid();if(method!=='GET'&&method!=='DELETE'&&request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')invalid();return await action(actor.userId,request.params,request.body,guard(request,actor.userId,method!=='GET'),request,reply);}catch(error){return failure(error,request,reply);}}});}
 route('POST','/api/graphs',(userId,_,body,check)=>content.createGraph(userId,body,check));
 route('GET','/api/documents/:id/graph',async(userId,{id},_,check)=>({...await content.graph(userId,id,check),drawioAvailable:!!options.drawioRoot}));
 route('PUT','/api/documents/:id/graph',(userId,{id},body,check)=>content.saveGraph(userId,id,body,check),2*graphBytes+4096);
 route('GET','/api/documents/:id/reviews',(userId,{id},_,__,request)=>content.listReviews(userId,id,cursor(request)));
 route('POST','/api/documents/:id/reviews',(userId,{id},body)=>content.createReview(userId,id,body),80000);
 route('PUT','/api/documents/:id/reviews/:reviewId',(userId,{id,reviewId},body)=>content.updateReview(userId,id,reviewId!,body),64000);
 route('POST','/api/documents/:id/reviews/:reviewId/status',(userId,{id,reviewId},body)=>content.statusReview(userId,id,reviewId!,body));
 route('POST','/api/documents/:id/reviews/:reviewId/accept',(userId,{id,reviewId},body,check)=>content.acceptReview(userId,id,reviewId!,body,check));
 route('GET','/api/documents/:id/attachments',(userId,{id},_,__,request)=>content.listAttachments(userId,id,cursor(request)));
 route('POST','/api/documents/:id/attachments',(userId,{id},body,check)=>content.upload(userId,id,body,check),Math.ceil(attachmentBytes/3)*4+4096);
 route('DELETE','/api/documents/:id/attachments/:attachmentId',(userId,{id,attachmentId})=>content.deleteAttachment(userId,id,attachmentId!));
 route('GET','/api/documents/:id/attachments/:attachmentId/content',async(userId,{id,attachmentId},_,check,__,reply)=>{if(!content.visible(userId,id).export)throw new DocumentError('ACCESS_DENIED');const {row,data}=await content.attachment(userId,id,attachmentId!,check);check();if(!content.visible(userId,id).export)throw new DocumentError('ACCESS_DENIED');return reply.type('application/octet-stream').header('content-security-policy',"sandbox; default-src 'none'; frame-ancestors 'none'").header('content-disposition',`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`).send(data);});
 // Old rich-text snapshots contain these URLs. Only inert, bounded PNG bytes render inline.
 app.get<{Params:{attachmentId:string}}>('/attachments/:attachmentId/',async(request,reply)=>{try{const actor=identity(request,false),row=db.prepare('SELECT document_id FROM content_attachments WHERE id=?').get(request.params.attachmentId) as {document_id:string}|undefined;if(!row)throw new DocumentError('NOT_FOUND');const {data}=await content.attachment(actor.userId,row.document_id,request.params.attachmentId,guard(request,actor.userId,false));if(data.length<24||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.readUInt32BE(16)*data.readUInt32BE(20)>40_000_000)throw new DocumentError('NOT_FOUND');return reply.type('image/png').header('content-security-policy',"sandbox; default-src 'none'").header('cross-origin-resource-policy','same-origin').send(data);}catch(error){return failure(error,request,reply);}});
 route('GET','/api/documents/:id/summary/providers',(userId,{id})=>ai.providers(userId,id));
 route('POST','/api/documents/:id/summary',(userId,{id},body,check)=>ai.summarize(userId,id,body,check));
 route('GET','/api/admin/ai-settings',userId=>ai.settings(userId));
 route('PUT','/api/admin/ai-settings',(userId,_,body)=>ai.updateSettings(userId,body),16384);
 if(options.drawioRoot){if(!isAbsolute(options.drawioRoot))throw new Error('Draw.io root must be absolute');const configuredRoot=options.drawioRoot;app.get<{Params:{'*':string}}>('/api/content/drawio/*',async(request,reply)=>{try{const actor=identity(request,false),check=guard(request,actor.userId,false),path=request.params['*'];if(!path||path.length>512||path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||/[\\\x00-\x1f]/.test(path))throw new DocumentError('NOT_FOUND');const root=await realpath(configuredRoot);check();const target=await realpath(resolve(root,path));check();if(!target.startsWith(root+sep))throw new DocumentError('NOT_FOUND');const info=await stat(target);check();if(!info.isFile()||info.size>64*1024**2)throw new DocumentError('NOT_FOUND');const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.gif':'image/gif','.jpg':'image/jpeg','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.xml':'application/xml','.txt':'text/plain'};reply.type(types[extname(path)]??'application/octet-stream').header('cache-control','private, no-store').header('cross-origin-resource-policy','same-origin').header('content-security-policy',"default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'");return reply.send(createReadStream(target));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')error=new DocumentError('NOT_FOUND');return failure(error,request,reply);}});}
 return {content,ai};
}
function cursor(request:FastifyRequest){const query=request.query as Record<string,unknown>;if(Object.keys(query).some(key=>key!=='after')||query.after!==undefined&&(typeof query.after!=='string'||query.after.length>128))invalid();return (query.after??'') as string;}
