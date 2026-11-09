import type {Database} from '../database.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import type {ProviderCheck} from './adapter.ts';
import {DocumentError} from '../document-errors.ts';
import {GoogleControlHttp} from './google-control-http.ts';
import {googleFileId} from './google-read-http.ts';
/** Resolve only an owned folder directly in My Drive. A reserved ID makes a lost
 * create response recoverable without creating another folder on reconnect. */
export async function googleStorageRoot(db:Database,connectionId:string,accountId:string,auth:GoogleAuthorization,scope:ProviderCheck,request:typeof fetch){
 const http=new GoogleControlHttp(auth,{fetch:request});
 try{
  const page=await http.call('GET','files',{q:"name = 'Yourwiki' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and 'me' in owners and trashed = false",spaces:'drive',corpora:'user',pageSize:'100',fields:'files(id),nextPageToken,incompleteSearch'},undefined,scope);
  if(!Array.isArray(page.files)||page.nextPageToken||page.incompleteSearch||page.files.length>1)throw new DocumentError('GOOGLE_ROOT_AMBIGUOUS');
  if(page.files.length)return googleFileId((page.files[0] as Record<string,unknown>).id);
  let row=db.prepare('SELECT reference FROM google_root_reservations WHERE connection_id=? AND account_id=?').get(connectionId,accountId) as {reference:string}|undefined;
  if(!row){const ids=await http.call('GET','files/generateIds',{count:'1',space:'drive',type:'files'},undefined,scope);if(!Array.isArray(ids.ids)||ids.ids.length!==1)throw new DocumentError('CONFIG_UNAVAILABLE');await scope.check();db.prepare('INSERT INTO google_root_reservations VALUES(?,?,?) ON CONFLICT DO NOTHING').run(connectionId,accountId,googleFileId(ids.ids[0]));row=db.prepare('SELECT reference FROM google_root_reservations WHERE connection_id=? AND account_id=?').get(connectionId,accountId) as {reference:string};}
  try{const created=await http.call('POST','files',{fields:'id'}, {id:row.reference,name:'Yourwiki',mimeType:'application/vnd.google-apps.folder',parents:['root'],writersCanShare:false}, {...scope,beforeDispatch:scope.check});if(created.id!==row.reference)throw new DocumentError('CONFIG_UNAVAILABLE');}
  catch(error){if(!error||typeof error!=='object'||!('code' in error)||error.code!=='PROVIDER_CONFLICT')throw error;const existing=await http.call('GET','files/'+row.reference,{fields:'id,name,mimeType,trashed,ownedByMe,parents'},undefined,scope);if(existing.name!=='Yourwiki'||existing.mimeType!=='application/vnd.google-apps.folder'||existing.trashed!==false||existing.ownedByMe!==true)throw new DocumentError('CONFIG_UNAVAILABLE');}
  return row.reference;
 }finally{await http.close();}
}
