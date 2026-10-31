import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {transaction} from '../database.ts';
import type {Database} from '../database.ts';
import type {BlobStore,BlobRef} from '../storage/blobs.ts';
import {OfficeIngress,OfficeWriteError} from './ingress.ts';
import {OfficeOpenings} from './openings.ts';
import {OfficeSaveIntents} from './save-intents.ts';
import {OfficePrepared} from './prepared.ts';
import {OfficeSaves} from './saves.ts';
import type {Readable} from 'node:stream';
import {OfficeSessions,OfficeError} from './sessions.ts';
import {OfficeDiscovery,officeUrl} from './discovery.ts';
import {DocumentService} from '../documents.ts';
import {AccessService} from '../access.ts';
import {authenticateSession,validCsrf} from '../auth/sessions.ts';
import {sessionCookie} from '../auth/routes.ts';
import {errorEnvelope} from '../errors.ts';
import {byteRange} from '../http/byte-range.ts';
export type OfficeOptions={cleanupIntervalMs?:number;publicUrl:string;internalUrl?:string;wopiUrl?:string;fetch?:typeof fetch};
export function registerOffice(app:FastifyInstance,db:Database,store:BlobStore,publicUrl:string,options:OfficeOptions,limits:{maxFileBytes?:number;maxPendingBytes?:number}={}){
 const openings=new OfficeOpenings(db),intents=new OfficeSaveIntents(db),prepared=new OfficePrepared(db,store,limits),ingress=new OfficeIngress(db,store,limits),saves=new OfficeSaves(db,store,ingress,limits),office=new OfficeSessions(db),docs=new DocumentService(db,store),access=new AccessService(db),discovery=new OfficeDiscovery(options);
 const cleanupInterval=options.cleanupIntervalMs??60000;
 if(!Number.isSafeInteger(cleanupInterval)||cleanupInterval<10||cleanupInterval>300000)throw new Error('Invalid office cleanup interval');
 let stopping=false,interval:ReturnType<typeof setInterval>|undefined,cleaning:Promise<void>|undefined;
 const cleanup=()=>{if(stopping||cleaning)return;try{openings.cleanup();}catch{/* Retry bounded opening cleanup on the next maintenance pass. */}cleaning=Promise.all([ingress.cleanupExpired(),prepared.cleanup()]).then(()=>{},()=>{}).finally(()=>{cleaning=undefined;});};
 app.addHook('onReady',async()=>{if(stopping)return;cleanup();interval=setInterval(cleanup,cleanupInterval);interval.unref();});
 app.addHook('preClose',async()=>{stopping=true;openings.close();if(interval)clearInterval(interval);await Promise.all([ingress.close(),prepared.close()]);await cleaning;});
 const origin=new URL(publicUrl).origin,wopiBase=officeUrl(options.wopiUrl??publicUrl).href.replace(/\/$/,'');
 // Editing is enabled only after bounded PutFile/recovery is installed; never advertise a non-saving editor.
 const editingReady=false;
 const params={type:'object',required:['id'],properties:{id:{type:'string',minLength:1,maxLength:128}}};
 function browser(request:FastifyRequest,mutation=false){
  const actor=authenticateSession(db,sessionCookie(request));if(!actor)throw new OfficeError('SESSION_REQUIRED');
  if(mutation&&(request.headers.origin!==origin||typeof request.headers['x-csrf-token']!=='string'||!validCsrf(actor,request.headers['x-csrf-token'])))throw new OfficeError('CSRF_REJECTED');return actor;
 }
 function fail(error:unknown,request:FastifyRequest,reply:FastifyReply){
  if(!(error instanceof OfficeError))throw error;
  if(request.method==='POST'&&request.url.startsWith('/wopi/')&&!request.raw.complete)reply.header('connection','close');
  const status:Record<string,number>={OFFICE_OPEN_CANCELLED:409,OFFICE_OPEN_REUSED:409,OFFICE_OPEN_LIMIT:429,OFFICE_SAVE_INTENT_LIMIT:429,OFFICE_SAVE_INTENT_EXPIRED:410,OFFICE_PREPARING:503,OFFICE_PREPARED_MISSING:503,OFFICE_PREPARED_QUOTA:429,OFFICE_PREPARED_LEASE_LOST:503,OFFICE_PREPARATION_TIMEOUT:504,OFFICE_CLOSED:503,INVALID_REQUEST:400,UNSUPPORTED_MEDIA_TYPE:415,PAYLOAD_TOO_LARGE:413,INVALID_OFFICE_FILE:422,OFFICE_FILE_BUDGET:422,OFFICE_SIZE_MISMATCH:400,OFFICE_LOCK_MISMATCH:409,OFFICE_WRITE_BUSY:409,OFFICE_WRITE_LEASE_LOST:409,OFFICE_WRITE_DISCARDED:409,OFFICE_WRITE_QUOTA:429,PENDING_LIMIT:429,OFFICE_VALIDATOR_BUSY:503,OFFICE_VALIDATOR_UNAVAILABLE:503,OFFICE_VALIDATOR_FAILED:503,OFFICE_VALIDATOR_LEASE_LOST:503,OFFICE_VALIDATION_TIMEOUT:504,OFFICE_WRITE_TIMEOUT:408,OFFICE_RECOVERY_MISSING:404,SESSION_REQUIRED:401,INVALID_OFFICE_TOKEN:401,OFFICE_EXPIRED:401,ACCESS_DENIED:403,CSRF_REJECTED:403,NOT_FOUND:404,CONFLICT:409,INVALID_OFFICE_LOCK:400,INVALID_OFFICE_DISCOVERY:503,OFFICE_UNAVAILABLE:503,OFFICE_NOT_READY:503,OFFICE_LIMIT:429,UNSUPPORTED_OFFICE_FORMAT:422,UNSUPPORTED_OFFICE_OPERATION:501};
  const envelope:ReturnType<typeof errorEnvelope>&{COOLStatusCode?:number;LOOLStatusCode?:number}=errorEnvelope(error.code,request.id);if(['CONFLICT','OFFICE_EXPIRED','OFFICE_PREPARED_MISSING','OFFICE_SAVE_INTENT_EXPIRED'].includes(error.code))envelope.recoveryActions=['copy_changes','download_changes','reload'];
  if(error instanceof OfficeWriteError&&error.writeId){envelope.operationId=error.writeId;envelope.recoveryActions=['download_changes','reload'];}
  if(request.url.startsWith('/wopi/')&&(status[error.code]===409)){
   let lock=error instanceof OfficeWriteError?error.currentLock:undefined;
   if(lock===undefined){try{const actor=authorize(request);lock=actor.session.lock_expires_at>Date.now()?actor.session.lock_value:'';}catch{lock='';}}
   reply.header('x-wopi-lock',lock);
   // Storage.hpp / COOLStatusCode::DOC_CHANGED in pinned Collabora cp-26.04.5-1.
   if(error.code==='CONFLICT'){envelope.COOLStatusCode=1010;envelope.LOOLStatusCode=1010;}
  }
  if([429,503].includes(status[error.code]??500))reply.header('retry-after',5);
  return reply.code(status[error.code]??500).send(envelope);
 }
 async function handle(request:FastifyRequest,reply:FastifyReply,operation:()=>unknown|Promise<unknown>){try{return await operation();}catch(error){return fail(error,request,reply);}}
 async function prepareForRequest(request:FastifyRequest,reply:FastifyReply,sessionId:string,token:string,outerSignal?:AbortSignal){
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!reply.raw.writableFinished)abort();};request.raw.once('aborted',abort);reply.raw.once('close',closed);if(request.raw.aborted)abort();
  try{return await prepared.prepare(sessionId,token,outerSignal?AbortSignal.any([controller.signal,outerSignal]):controller.signal);}finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed);}
 }
 function requestToken(request:FastifyRequest){const token=(request.query as Record<string,unknown>).access_token;return typeof token==='string'?token:'';}
 async function interrupted<T>(operation:Promise<T>,signal:AbortSignal){
  signal.throwIfAborted();let abort!:()=>void;try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}
 }
 for(const officePath of ['/api/documents/:id/office','/api/documents/:id/office-opening'])app.post<{Params:{id:string};Body:{readonly?:boolean;language?:string}}>(officePath,{schema:{params,body:{type:'object',additionalProperties:false,properties:{readonly:{type:'boolean',default:false},language:{type:'string',enum:['ru','en','es'],default:'en'}}}}},(request,reply)=>handle(request,reply,async()=>{
  let actor=browser(request,true);const document=docs.getPublished(actor.userId,request.params.id);if(!document)throw new OfficeError('NOT_FOUND');
  const writable=request.body.readonly!==true&&access.allows(actor.userId,document.id,'write');
  if(writable&&!editingReady)throw new OfficeError('OFFICE_NOT_READY');
  const handoff=request.headers['x-yourwiki-office-handoff'];if(handoff!==undefined&&handoff!=='check-file-info-v1')throw new OfficeError('INVALID_REQUEST');const openId=request.headers['x-yourwiki-office-open'];if(officePath.endsWith('/office-opening')&&openId===undefined)throw new OfficeError('INVALID_REQUEST');if(handoff!==undefined&&(!openId||!officePath.endsWith('/office-opening')))throw new OfficeError('INVALID_REQUEST');if(openId!==undefined&&(typeof openId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(openId)))throw new OfficeError('INVALID_REQUEST');
  const parent=openId?openings.begin(sessionCookie(request),openId,document.id):actor.tokenHash,watch=openId?openings.watch(parent,openId):undefined,controller=new AbortController();
  const signal=watch?AbortSignal.any([watch.signal,controller.signal]):controller.signal;let opened:ReturnType<OfficeSessions['open']>|undefined;
  const cancel=()=>{controller.abort(new OfficeError('OFFICE_OPEN_CANCELLED'));try{if(openId)openings.cancelOwned(parent,openId);if(opened)office.revokeCapability(opened.sessionId,opened.token);}catch{/* Retained receipt/deadline remains available to cleanup. */}};
  const closed=()=>{if(!reply.raw.writableFinished)cancel();remove();},remove=()=>{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',closed);reply.raw.removeListener('finish',remove);};
  request.raw.once('aborted',cancel);reply.raw.once('close',closed);reply.raw.once('finish',remove);if(request.raw.aborted||reply.raw.destroyed)cancel();
  try{
   signal.throwIfAborted();const action=await interrupted(discovery.action(document.format,writable),signal);signal.throwIfAborted();actor=browser(request,true);if(openId)openings.assertActive(parent,openId);
   const current=docs.getPublished(actor.userId,document.id);if(!current)throw new OfficeError('NOT_FOUND');if(current.format!==document.format)throw new OfficeError('CONFLICT');
   opened=openId?openings.allocate(sessionCookie(request),openId,document.id,writable):office.open(sessionCookie(request),document.id,writable);const url=new URL(action);
   await prepareForRequest(request,reply,opened.sessionId,opened.token,signal);signal.throwIfAborted();actor=browser(request,true);const authorized=office.authorize(opened.sessionId,opened.token);original(authorized);const handoffExpiresAt=openId?openings.finish(parent,openId,handoff==='check-file-info-v1'):null;
   url.searchParams.set('WOPISrc',`${wopiBase}/wopi/files/${opened.sessionId}`);url.searchParams.set('lang',request.body.language??'en');
   return {sessionId:opened.sessionId,accessToken:opened.token,expiresAt:opened.expiresAt,write:authorized.write,export:access.allows(actor.userId,document.id,'export'),actionUrl:url.href,...(handoffExpiresAt!==null?{handoffExpiresAt}:{})};
  }catch(error){cancel();throw error;}finally{watch?.stop();}
 }));
 app.post<{Body:{openId:string;csrfToken:string}}>('/api/auth/office-opening-cancel',{bodyLimit:1024,schema:{body:{type:'object',additionalProperties:false,required:['openId','csrfToken'],properties:{openId:{type:'string',pattern:'^[A-Za-z0-9_-]{16,128}$'},csrfToken:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}}},(request,reply)=>handle(request,reply,()=>{
  if(request.headers.origin!==origin)throw new OfficeError('CSRF_REJECTED');if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new OfficeError('UNSUPPORTED_MEDIA_TYPE');openings.cancel(request.body.csrfToken,request.body.openId);return reply.code(204).send();
 }));
 app.post<{Params:{id:string};Body:{accessToken?:string}|undefined}>('/api/office/:id/status',{schema:{params}},(request,reply)=>handle(request,reply,()=>{browser(request,true);const body=request.body;if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='accessToken')||body.accessToken!==undefined&&(typeof body.accessToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.accessToken))))throw new OfficeError('INVALID_REQUEST');return office.status(sessionCookie(request),request.params.id,body?.accessToken);}));
 app.post<{Params:{id:string};Body:{accessToken:string}}>('/api/office/:id/save-intents',{schema:{params,body:{type:'object',additionalProperties:false,required:['accessToken'],properties:{accessToken:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}}},(request,reply)=>handle(request,reply,()=>{browser(request,true);return intents.issue(sessionCookie(request),request.params.id,request.body.accessToken);}));
 app.get<{Params:{id:string;tag:string}}>('/api/office/:id/save-intents/:tag',{schema:{params:{type:'object',required:['id','tag'],properties:{id:{type:'string',minLength:1,maxLength:128},tag:{type:'string',pattern:'^yourwiki-save-[A-Za-z0-9_-]{32}$'}}}}},(request,reply)=>handle(request,reply,()=>{browser(request);return intents.status(sessionCookie(request),request.params.id,request.params.tag);}));
 // Narrow revocation control: the opaque bearer authorizes its own deletion, including after cookie expiry.
 // Origin + JSON-only submission prevent ambient cross-site browser requests; responses disclose no token state.
 app.post<{Body:{sessionId:string;accessToken:string}}>('/api/auth/office-revoke',{bodyLimit:1024,schema:{body:{type:'object',additionalProperties:false,required:['sessionId','accessToken'],properties:{sessionId:{type:'string',pattern:'^[-A-Za-z0-9_]{1,128}$'},accessToken:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}}},(request,reply)=>handle(request,reply,()=>{
  if(request.headers.origin!==origin)throw new OfficeError('CSRF_REJECTED');
  if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw new OfficeError('UNSUPPORTED_MEDIA_TYPE');
  office.revokeCapability(request.body.sessionId,request.body.accessToken);return reply.code(204).send();
 }));
 app.post<{Params:{id:string};Body:{accessToken:string}}>('/api/office/:id/release',{schema:{params,body:{type:'object',required:['accessToken'],additionalProperties:false,properties:{accessToken:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}}},(request,reply)=>handle(request,reply,()=>{browser(request,true);office.release(sessionCookie(request),request.params.id,request.body.accessToken);return reply.code(204).send();}));
 function authorize(request:FastifyRequest){const id=(request.params as {id:string}).id,token=(request.query as Record<string,unknown>).access_token;return office.authorize(id,typeof token==='string'?token:'');}
 function original(actor:ReturnType<OfficeSessions['authorize']>){
  if(actor.session.superseded)throw new OfficeError('CONFLICT');
  const row=db.prepare('SELECT d.title,d.format,r.owner_id,v.size,v.digest,v.created_at FROM documents d JOIN resources r ON r.id=d.id JOIN document_versions v ON v.document_id=d.id AND v.revision=? WHERE d.id=?').get(actor.session.base_revision,actor.session.document_id) as {title:string;format:string;owner_id:string;size:number;digest:string;created_at:number}|undefined;
  if(!row||row.digest!==actor.session.base_digest)throw new OfficeError('CONFLICT');return row;
 }
 async function sendBytes(request:FastifyRequest,reply:FastifyReply,blob:BlobRef,recheck:()=>void,source:BlobStore=store){
  const range=byteRange(request.headers.range,blob.size);reply.header('accept-ranges','bytes').header('content-security-policy',"sandbox; default-src 'none'");
  if(range===null)return reply.code(416).header('content-range',`bytes */${blob.size}`).send(errorEnvelope('INVALID_RANGE',request.id));
  const stream=await source.read(blob.digest,range??undefined);try{recheck();}catch(error){stream.destroy();throw error;}
  reply.type('application/octet-stream').header('content-length',range?range.end-range.start+1:blob.size);
  if(range)reply.code(206).header('content-range',`bytes ${range.start}-${range.end}/${blob.size}`);
  return reply.send(stream);
 }
 app.get<{Params:{id:string}}>('/wopi/files/:id',{schema:{params}},(request,reply)=>handle(request,reply,async()=>{
  authorize(request);const receipt=await prepareForRequest(request,reply,request.params.id,requestToken(request));
  return openings.claim(request.params.id,requestToken(request),actor=>{const row=original(actor),user=db.prepare('SELECT display_name FROM users WHERE id=?').get(actor.userId) as {display_name:string};const write=editingReady&&actor.write;if(receipt.sourceRevision!==actor.session.base_revision||receipt.sourceDigest!==actor.session.base_digest||receipt.format!==row.format)throw new OfficeError('CONFLICT');
  return {BaseFileName:row.title.toLowerCase().endsWith('.'+row.format)?row.title:row.title+'.'+row.format,OwnerId:row.owner_id,Size:receipt.blob.size,Version:`${actor.session.base_revision}:${row.digest}`,LastModifiedTime:new Date(row.created_at).toISOString(),UserId:actor.userId,UserFriendlyName:user.display_name,
   UserCanWrite:write,ReadOnly:!write,SupportsUpdate:editingReady,SupportsLocks:true,SupportsGetLock:true,SupportsExtendedLockLength:true,UserCanNotWriteRelative:true,SupportsRename:false,PostMessageOrigin:origin,
   DisableExport:!actor.export,HideExportOption:!actor.export,DisablePrint:!actor.export,HidePrintOption:!actor.export,DisableCopy:!actor.export};});
 }));
 app.get<{Params:{id:string}}>('/wopi/files/:id/contents',{schema:{params}},(request,reply)=>handle(request,reply,async()=>{
  authorize(request);await prepareForRequest(request,reply,request.params.id,requestToken(request));const payload=await prepared.payload(request.params.id,requestToken(request)),row=payload.receipt;
  return sendBytes(request,reply,row.blob,()=>openings.claim(request.params.id,requestToken(request),current=>{if(current.session.base_digest!==row.sourceDigest||current.session.base_revision!==row.sourceRevision||prepared.get(request.params.id,requestToken(request)).id!==row.id)throw new OfficeError('CONFLICT');original(current);}),payload.store);
 }));
 app.register(async wopi=>{
  wopi.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
  wopi.addHook('onRequest',async(request,reply)=>{try{authorize(request);}catch(error){return fail(error,request,reply);}});
 wopi.post<{Params:{id:string}}>('/wopi/files/:id/contents',{schema:{params},onRequest:async(request,reply)=>handle(request,reply,()=>{
  const actor=authorize(request);if(!actor.write)throw new OfficeError('ACCESS_DENIED');
  if(request.headers['x-wopi-override']!=='PUT')throw new OfficeError('UNSUPPORTED_OFFICE_OPERATION');
  if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/octet-stream')throw new OfficeError('UNSUPPORTED_MEDIA_TYPE');
  const length=request.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))))throw new OfficeError('INVALID_REQUEST');
  if(length!==undefined&&Number(length)>(limits.maxFileBytes??4*1024**3))throw new OfficeError('PAYLOAD_TOO_LARGE');
  const cool=request.headers['x-cool-wopi-timestamp'],lool=request.headers['x-lool-wopi-timestamp'];
  if([cool,lool].some(value=>value!==undefined&&(typeof value!=='string'||value.length>128))||(cool!==undefined&&lool!==undefined&&cool!==lool))throw new OfficeError('INVALID_REQUEST');
 })},(request,reply)=>handle(request,reply,async()=>{
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!reply.raw.writableFinished)abort();};
  request.raw.once('aborted',abort);reply.raw.once('close',closed);if(request.raw.aborted)abort();
  try{
   const token=(request.query as Record<string,unknown>).access_token;
   const saved=await saves.save({sessionId:request.params.id,token:typeof token==='string'?token:'',lock:String(request.headers['x-wopi-lock']??''),declaredSize:request.headers['content-length']===undefined?null:Number(request.headers['content-length']),clientTag:(()=>{const data=request.headers['x-cool-wopi-extendeddata']??request.headers['x-lool-wopi-extendeddata'];return typeof data==='string'&&/^yourwiki-save-[A-Za-z0-9_-]{32}$/.test(data)?data:undefined;})(),lastModifiedTime:(request.headers['x-cool-wopi-timestamp']??request.headers['x-lool-wopi-timestamp']??null) as string|null,signal:controller.signal},(request.body??request.raw) as Readable);
   const receipt=saved.receipt!;const version=db.prepare('SELECT created_at FROM document_versions WHERE document_id=? AND revision=? AND digest=?').get(receipt.documentId,receipt.revision,saved.blob.digest) as {created_at:number};
   return reply.header('x-wopi-itemversion',`${receipt.revision}:${saved.blob.digest}`).code(200).send({LastModifiedTime:new Date(version.created_at).toISOString()});
  }finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed);}
 }));
 wopi.post<{Params:{id:string}}>('/wopi/files/:id',{schema:{params}},(request,reply)=>handle(request,reply,()=>{
  if(request.headers['transfer-encoding']||Number(request.headers['content-length']??0)>0){reply.header('connection','close');throw new OfficeError('INVALID_OFFICE_LOCK');}
  const token=(request.query as Record<string,unknown>).access_token;const result=office.lock(request.params.id,typeof token==='string'?token:'',String(request.headers['x-wopi-override']??''),String(request.headers['x-wopi-lock']??''),typeof request.headers['x-wopi-oldlock']==='string'?request.headers['x-wopi-oldlock']:undefined);
  if(result.lock!==undefined)reply.header('x-wopi-lock',result.lock);return reply.code(result.status).send();
 }));
 });
 function recoveryMetadata(userId:string,item:ReturnType<OfficeIngress['status']>){
  return {createdAt:item.createdAt,id:item.id,sessionId:item.sessionId,documentId:item.documentId,authorId:item.userId,state:item.state,baseRevision:item.baseRevision,size:item.blob?.size??null,errorCode:item.errorCode,
   download:!!item.blob&&['prepared','failed'].includes(item.state)&&access.allows(userId,item.documentId,'export'),discard:!['committed','discarded'].includes(item.state)};
 }
 app.get<{Params:{id:string};Querystring:{cursor?:string;limit?:number}}>('/api/documents/:id/office-recovery',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{cursor:{type:'string',maxLength:128},limit:{type:'integer',minimum:1,maximum:50,default:50}}}}},(request,reply)=>handle(request,reply,()=>{
  const actor=browser(request),page=ingress.recoveries(actor.userId,request.params.id,request.query.cursor,request.query.limit);
  return {items:page.items.map(item=>recoveryMetadata(actor.userId,item)),nextCursor:page.nextCursor};
 }));
 app.get<{Params:{id:string}}>('/api/office-recovery/:id',{schema:{params}},(request,reply)=>handle(request,reply,()=>{const actor=browser(request);return recoveryMetadata(actor.userId,ingress.status(actor.userId,request.params.id));}));
 app.get<{Params:{id:string}}>('/api/office-recovery/:id/contents',{schema:{params}},(request,reply)=>handle(request,reply,async()=>{
  const actor=browser(request),item=ingress.status(actor.userId,request.params.id);
  if(!item.blob||!['prepared','failed'].includes(item.state))throw new OfficeError('NOT_FOUND');
  if(!access.allows(actor.userId,item.documentId,'export'))throw new OfficeError('ACCESS_DENIED');
  const source=await ingress.payloadStore(actor.userId,item.id);
  const format=(db.prepare('SELECT format FROM documents WHERE id=?').get(item.documentId) as {format:string}).format;
  const check=()=>{const current=browser(request);if(current.userId!==actor.userId)throw new OfficeError('ACCESS_DENIED');const latest=ingress.status(current.userId,item.id);if(!['prepared','failed'].includes(latest.state)||latest.blob?.digest!==item.blob!.digest||latest.blob.size!==item.blob!.size)throw new OfficeError('NOT_FOUND');if(!access.allows(current.userId,item.documentId,'export'))throw new OfficeError('ACCESS_DENIED');};
  reply.header('content-disposition',`attachment; filename="office-recovery.${/^[a-z0-9]{1,8}$/.test(format)?format:'bin'}"`);
  return sendBytes(request,reply,item.blob,check,source);
 }));
 app.post<{Params:{id:string}}>('/api/office-recovery/:id/discard',{schema:{params}},(request,reply)=>handle(request,reply,async()=>{const actor=browser(request,true);await ingress.discard(actor.userId,request.params.id);return reply.code(204).send();}));
 app.get<{Params:{id:string}}>('/api/office/:id/recovery',{schema:{params}},(request,reply)=>handle(request,reply,async()=>{
  const initial=transaction(db,()=>{
   const actor=browser(request),status=office.status(sessionCookie(request),request.params.id);if(!status.recovery)throw new OfficeError('ACCESS_DENIED');
   const blob=db.prepare('SELECT p.digest,p.size,p.author_id,s.document_id,d.format FROM office_sessions s JOIN documents d ON d.id=s.document_id JOIN save_operations p ON p.id=s.pending_operation_id AND p.office_session_id=s.id AND p.document_id=s.document_id WHERE s.id=?').get(request.params.id) as (BlobRef&{author_id:string;document_id:string;format:string})|undefined;
   if(!blob)throw new OfficeError('NOT_FOUND');return {blob,userId:actor.userId};
  });
  const blob=initial.blob,check=()=>{const actor=browser(request);if(actor.userId!==initial.userId||(!access.allows(actor.userId,blob.document_id,'read'))||!access.allows(actor.userId,blob.document_id,'export')||(blob.author_id!==actor.userId&&actor.adminRole!=='giga'))throw new OfficeError('ACCESS_DENIED');};
  reply.header('content-disposition',`attachment; filename="office-recovery.${/^[a-z0-9]{1,8}$/.test(blob.format)?blob.format:'bin'}"`);return sendBytes(request,reply,blob,check);
 }));
}
