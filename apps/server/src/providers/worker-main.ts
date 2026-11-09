import {RcloneStorageWorker} from '../rclone/storage-worker.ts';
import {GoogleWatchWorker} from './google-watch.ts';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {GoogleMarkdownConflictRepair} from './google-markdown-conflict-repair.ts';
import {GoogleStoragePush} from './google-storage-push.ts';
import {GoogleStorageWorker} from './google-storage-worker.ts';
import {GoogleLifecycleWorker} from './google-lifecycle-worker.ts';
import {GoogleGrantsWorker} from './google-grant-sync.ts';
import {GoogleTrashWorker} from './google-trash-worker.ts';
import {GoogleImportWorker} from './google-import-worker.ts';
import {GoogleDiscoveryWorker} from './google-discovery-worker.ts';
import {GoogleAuthPool} from './google-auth-pool.ts';
import {isAbsolute} from 'node:path';
import {stat} from 'node:fs/promises';
import {openDatabase} from '../database.ts';
import {BlobStore} from '../storage/blobs.ts';
import {loadSecretCodec} from './secret-key.ts';
import {SecretConfigs} from './secret-config.ts';
import {CredentialVault} from './credential-vault.ts';
import {DeliveryWorker} from './delivery-worker.ts';
import {IngressWorker} from './ingress-worker.ts';
import {IngressScheduler} from './ingress-scheduler.ts';
import {ProviderLoop} from './provider-loop.ts';
import {createProviderResolvers} from './provider-resolvers.ts';
// Explicit initialized new workspace only; no production/legacy discovery or key creation.
const args=process.argv.slice(2);
if(args.length!==3||!args.every(isAbsolute)){
 console.error('Usage: npm run provider-worker -- /absolute/new-yourwiki-v2.sqlite3 /absolute/private-storage /absolute/existing-secret.key');process.exitCode=1;
}else{
 try{
  if(!(await stat(args[0])).isFile()||!(await stat(args[1])).isDirectory())throw new Error('Missing initialized workspace');const codec=await loadSecretCodec(args[2]);
  let watchOrigin=process.env.YOURWIKI_PUBLIC_URL;try{watchOrigin??=JSON.parse(await readFile(join(dirname(args[0]),'installation.json'),'utf8')).publicUrl;}catch{/* Polling remains available. */}
  try{const db=openDatabase(args[0]);try{const store=await BlobStore.open(args[1]),configs=new SecretConfigs(codec),authPool=new GoogleAuthPool(db,configs),vault=new CredentialVault(db,configs,{authPool}),discovery=new GoogleDiscoveryWorker(db,configs,{authPool}),imports=new GoogleImportWorker(db,store,configs,{authPool}),trash=new GoogleTrashWorker(db,configs,{authPool}),grants=new GoogleGrantsWorker(db,configs,{authPool}),lifecycle=new GoogleLifecycleWorker(db,configs,{authPool}),watches=new GoogleWatchWorker(db,configs,watchOrigin,{authPool}),controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
   try{console.info('Yourwiki provider worker started (one shared source slot).');const resolve=createProviderResolvers(vault);const outgoing=new DeliveryWorker(db,store,vault,resolve.outgoing),incoming=new IngressWorker(db,store,vault,resolve.incoming);const loop=process.env.YOURWIKI_DRIVE_TRANSPORT==='rclone'?new ProviderLoop(new IngressScheduler(db),outgoing,incoming,undefined,undefined,trash,grants,new RcloneStorageWorker(db,store)):new ProviderLoop(new IngressScheduler(db),outgoing,incoming,discovery,imports,trash,grants,lifecycle,new GoogleStorageWorker(db,configs),new GoogleStoragePush(db,store,configs,authPool),new GoogleMarkdownConflictRepair(db,vault,resolve.incoming),watches);await loop.run(controller.signal);}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await Promise.all([watches.close(),vault.close(),discovery.close(),imports.close(),trash.close(),grants.close(),lifecycle.close()]);await authPool.close();}
  }finally{db.close();}}finally{codec.close();}
 }catch{console.error('Provider worker stopped: workspace initialization or source execution failed.');process.exitCode=1;}
}
