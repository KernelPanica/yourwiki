import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
import {SecretConfigs} from './secret-config.ts';
import {ProviderError,type ProviderCheck} from './adapter.ts';
import {GoogleReadHttp,googleFileId} from './google-read-http.ts';
import {GoogleMetadata} from './google-metadata.ts';
import {googleManagedRecipients} from './google-grants.ts';
import type {GoogleConnectStates} from './google-connect-state.ts';
import type {GoogleCodeExchange} from './google-code-exchange.ts';
type Lease=ReturnType<GoogleConnectStates['claim']>;
type Issued=Awaited<ReturnType<GoogleCodeExchange['exchange']>>;
/** Verify a newly consented central account before any token/config publication. */
export async function verifyGoogleAccount(db:Database,configs:SecretConfigs,lease:Lease,issued:Issued,options:ProviderCheck&{fetch?:typeof fetch}){
 const credentials=lease.credentials();issued.check();
 const current=()=>{lease.check();issued.check();const row=db.prepare("SELECT encrypted_config FROM provider_connections WHERE id=? AND provider='google' AND enabled=1 AND revision=?").get(credentials.connectionId,credentials.revision) as {encrypted_config:string}|undefined;if(!row)throw new DocumentError('CONFIG_UNAVAILABLE');try{return configs.decrypt(row.encrypted_config);}catch{throw new DocumentError('CONFIG_UNAVAILABLE');}};
 const config=current(),root=googleFileId(config.root),previous=config.google_account_id;
 if(previous!==undefined&&(typeof previous!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(previous)))throw new DocumentError('CONFIG_UNAVAILABLE');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
 const check=async()=>{if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');current();await options.check();current();if(signal.aborted)throw new ProviderError('PROVIDER_CANCELLED');};
 const http=new GoogleReadHttp({access:async()=>{current();return issued.credentials().accessToken;},invalidate:()=>{throw new ProviderError('PROVIDER_CONFIG_CHANGED');}},{fetch:options.fetch});
 try{
  const guard={check,signal},about=await http.about(guard),user=about.user as Record<string,unknown>|undefined;await check();
  if(!user||typeof user!=='object'||user.me!==true||typeof user.permissionId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(user.permissionId))throw new ProviderError('PROVIDER_SOURCE_CHANGED');
  const accountId=user.permissionId;if(previous!==undefined&&previous!==accountId)throw new ProviderError('ACCESS_DENIED');
  const metadata=new GoogleMetadata(http,async(reference,scope)=>{await scope.check();return googleManagedRecipients(db,credentials.connectionId,credentials.revision,reference);}),folder=await metadata.root(root,guard);
  if(previous===undefined&&root==='root'){
   const witness=db.prepare('SELECT reference FROM provider_source_bindings WHERE connection_id=? ORDER BY document_id LIMIT 1').get(credentials.connectionId) as {reference:string}|undefined;
   if(witness)await metadata.verify(witness.reference,folder.id,guard);
  }
  await check();return Object.freeze({accountId,rootId:folder.id,connectionId:credentials.connectionId,revision:credentials.revision,check:()=>{current();if(options.signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');const now=current();if(now.root!==root||now.google_account_id!==previous)throw new DocumentError('CONFIG_UNAVAILABLE');}});
 }finally{clearTimeout(timer);controller.abort();await http.close();}
}
