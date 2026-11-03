import {ProviderError,type ProviderCheck} from './adapter.ts';
import {googleFileId,type GoogleReadHttp} from './google-read-http.ts';
type Reader=Pick<GoogleReadHttp,'file'|'permissions'>;
type Kind='binary'|'document'|'spreadsheet'|'presentation'|'folder';
export type GoogleFile=Readonly<{id:string;mimeType:string;version:string;parents:readonly string[];kind:Kind;size:number|null;md5:string|null;sha256:string|null;headRevision:string|null}>;
/** Internal trusted grant lookup, scoped to the same current connection as the reader.
 * Not a client-supplied allowlist and never a source of local Yourwiki rights. */
type ManagedRecipients=(fileId:string,options:ProviderCheck)=>Promise<readonly string[]>;
const prefix='application/vnd.google-apps.',folder=prefix+'folder';
const fields='id,mimeType,parents,version,ownedByMe,shared,driveId,trashed,size,md5Checksum,sha256Checksum,headRevisionId,capabilities(canDownload)';
function deny():never{throw new ProviderError('ACCESS_DENIED');}
function invalid():never{throw new ProviderError('PROVIDER_SOURCE_CHANGED');}
async function current(options:ProviderCheck){if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');await options.check();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');}
function decimal(value:unknown,max:bigint):bigint{if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,19})$/.test(value))invalid();const result=BigInt(value);if(result>max)invalid();return result;}
function parse(raw:Record<string,unknown>,requested:string):GoogleFile{
 const id=googleFileId(raw.id);if(requested!=='root'&&id!==requested)invalid();
 if(raw.ownedByMe!==true||raw.trashed!==false||raw.driveId!==undefined&&raw.driveId!=='')deny();
 decimal(raw.version,18446744073709551615n);
 const inputMime=raw.mimeType;if(typeof inputMime!=='string'||inputMime.length>255||! /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(inputMime))invalid();
 const mimeType=inputMime.toLowerCase();
 let kind:Kind='binary';
 if(mimeType.startsWith(prefix)){const native=mimeType.slice(prefix.length);if(!['document','spreadsheet','presentation','folder'].includes(native))invalid();kind=native as Kind;}
 const parents=raw.parents===undefined?[]:raw.parents;if(!Array.isArray(parents)||parents.length>1)invalid();const parentIds=parents.map(googleFileId);
 let size:number|null=null,md5:string|null=null,sha256:string|null=null,headRevision:string|null=null;
 if(kind!=='folder'){
  const capabilities=raw.capabilities;if(!capabilities||typeof capabilities!=='object'||(capabilities as Record<string,unknown>).canDownload!==true)deny();
  if(kind==='binary'){
   size=Number(decimal(raw.size,4294967296n));
   const checksum=(value:unknown,length:number)=>{if(value===undefined)return null;if(typeof value!=='string'||value.length!==length||!/^[a-f0-9]+$/i.test(value))invalid();return value.toLowerCase();};
   md5=checksum(raw.md5Checksum,32);sha256=checksum(raw.sha256Checksum,64);
   if(raw.headRevisionId!==undefined){if(typeof raw.headRevisionId!=='string'||raw.headRevisionId.length<1||raw.headRevisionId.length>1024||/[\x00-\x20\x7f]/.test(raw.headRevisionId)||Buffer.from(raw.headRevisionId).toString('utf8')!==raw.headRevisionId)invalid();headRevision=raw.headRevisionId;}
  }
 }
 return Object.freeze({id,mimeType,version:raw.version as string,parents:Object.freeze(parentIds),kind,size,md5,sha256,headRevision});
}
/** Worker-only metadata gate. No source bytes, grants, deletion or local commit side effects.
 * Caller must repeat verification after streaming and compare version/parents before acceptance. */
export class GoogleMetadata{
 private http:Reader;private managed:ManagedRecipients;
 constructor(http:Reader,managed:ManagedRecipients){this.http=http;this.managed=managed;}
 private async file(id:string,options:ProviderCheck):Promise<GoogleFile>{
  await current(options);const raw=await this.http.file(id,fields,options);await current(options);const result=parse(raw,id);
  if(raw.shared!==false){
   if(raw.shared!==true)deny();
   const recipients=await this.managed(result.id,options);await current(options);
   if(!Array.isArray(recipients)||recipients.length<1||recipients.length>10000||recipients.some(value=>typeof value!=='string'||value.length<1||value.length>320||/[\x00-\x20\x7f]/.test(value)))deny();
   const allowed=new Set(recipients.map(value=>value.toLowerCase()));
   const page=await this.http.permissions(result.id,options);await current(options);
   if(page.nextPageToken!==undefined&&page.nextPageToken!==''||!Array.isArray(page.permissions)||page.permissions.length>100)deny();
   for(const value of page.permissions){
    if(!value||typeof value!=='object')deny();const permission=value as Record<string,unknown>;
    if(typeof permission.id!=='string'||permission.id.length<1||permission.id.length>256||permission.type!=='user')deny();
    if(permission.role==='owner')continue;
    if(!['reader','writer','commenter'].includes(permission.role as string)||typeof permission.emailAddress!=='string'||!allowed.has(permission.emailAddress.toLowerCase()))deny();
   }
  }
  await current(options);return result;
 }
 async root(root:string,options:ProviderCheck):Promise<GoogleFile>{googleFileId(root);const info=await this.file(root,options);if(info.mimeType!==folder)deny();return info;}
 async verify(reference:string,root:string,options:ProviderCheck):Promise<GoogleFile>{
  googleFileId(reference);googleFileId(root);if(reference==='root')invalid();
  const rootInfo=await this.root(root,options);
  if(reference===rootInfo.id)invalid();
  const source=await this.file(reference,options);if(source.kind==='folder')invalid();
  const seen=new Set<string>([source.id]);let cursor=source;
  for(let depth=0;depth<34;depth++){
   const parent=cursor.parents[0];if(!parent||seen.has(parent))invalid();
   if(parent===rootInfo.id){await current(options);return source;}
   seen.add(parent);cursor=await this.file(parent,options);if(cursor.kind!=='folder')invalid();
  }
  invalid();
 }
}
