import {GoogleImportRequests} from './providers/google-import-jobs.ts';
import {GoogleDiscoveryRequests} from './providers/google-discovery-jobs.ts';
import {isAbsolute} from 'node:path';
import {lstat} from 'node:fs/promises';
import Sqlite from 'better-sqlite3';
import type {FastifyInstance} from 'fastify';
import {buildApp} from './app.ts';
import {openDatabase,type Database} from './database.ts';
import {applicationId} from './schema.ts';
import {BlobStore} from './storage/blobs.ts';
import {loadSecretCodec} from './providers/secret-key.ts';
import type {FernetCodec} from './providers/fernet.ts';
import {SecretConfigs} from './providers/secret-config.ts';
import {ProviderConnections} from './providers/connections.ts';
import {GoogleConnect} from './providers/google-connect.ts';
export type ConfiguredAppOptions={databasePath:string;storagePath:string;secretKeyPath:string;webRoot:string;publicUrl:string};
/** Explicit initialized v2 workspace only. No legacy discovery, account/key generation or provider workers. */
export async function openConfiguredApp(input:ConfiguredAppOptions):Promise<FastifyInstance>{
 let codec:FernetCodec|undefined,db:Database|undefined,app:FastifyInstance|undefined,google:GoogleConnect|undefined;
 try{
  const options={...input};if(![options.databasePath,options.storagePath,options.secretKeyPath,options.webRoot].every(path=>typeof path==='string'&&isAbsolute(path)&&!path.includes('\0')))throw new Error();
  const origin=new URL(options.publicUrl);if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error();
  const [databaseInfo,storageInfo,webInfo]=await Promise.all([lstat(options.databasePath),lstat(options.storagePath),lstat(options.webRoot)]);if(!databaseInfo.isFile()||!databaseInfo.size||!storageInfo.isDirectory()||!webInfo.isDirectory())throw new Error();
  codec=await loadSecretCodec(options.secretKeyPath);
  // Verify the frontend before opening the workspace for migrations; never listen on the preflight app.
  const preflight=buildApp({webRoot:options.webRoot});try{await preflight.ready();}finally{await preflight.close();}
  const probe=new Sqlite(options.databasePath,{readonly:true,fileMustExist:true});try{if(probe.pragma('application_id',{simple:true})!==applicationId)throw new Error();}finally{probe.close();}
  db=openDatabase(options.databasePath);const database=db,ownedCodec=codec,configs=new SecretConfigs(codec);for(const row of database.prepare('SELECT encrypted_config FROM provider_connections').iterate() as Iterable<{encrypted_config:string}>)configs.decrypt(row.encrypted_config);const storage=await BlobStore.open(options.storagePath);google=new GoogleConnect(database,configs,origin.origin);
  app=buildApp({database,storage,webRoot:options.webRoot,publicUrl:origin.origin,googleConnect:google,googleDiscovery:new GoogleDiscoveryRequests(database,configs),googleImports:new GoogleImportRequests(database,configs),providerConnections:new ProviderConnections(database,configs),readiness:async()=>database.open&&Boolean(database.prepare('SELECT 1 AS ready').get())});
  app.addHook('onClose',()=>{if(database.open)database.close();ownedCodec.close();});await app.ready();return app;
 }catch{
  try{await app?.close();}catch{/* Cleanup continues even after partial app initialization. */}
  try{await google?.close();}catch{/* No unobserved provider operation may retain ownership. */}
  try{if(db?.open)db.close();}finally{codec?.close();}
  throw new Error('WORKSPACE_UNAVAILABLE');
 }
}
