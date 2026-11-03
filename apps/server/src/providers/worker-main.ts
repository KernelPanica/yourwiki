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
  try{const db=openDatabase(args[0]);try{const store=await BlobStore.open(args[1]),configs=new SecretConfigs(codec),authPool=new GoogleAuthPool(db,configs),vault=new CredentialVault(db,configs,{authPool}),discovery=new GoogleDiscoveryWorker(db,configs,{authPool}),imports=new GoogleImportWorker(db,store,configs,{authPool}),controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
   try{console.info('Yourwiki provider worker started (one shared source slot).');const resolve=createProviderResolvers(vault);await new ProviderLoop(new IngressScheduler(db),new DeliveryWorker(db,store,vault,resolve.outgoing),new IngressWorker(db,store,vault,resolve.incoming),discovery,imports).run(controller.signal);}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await Promise.all([vault.close(),discovery.close(),imports.close()]);await authPool.close();}
  }finally{db.close();}}finally{codec.close();}
 }catch{console.error('Provider worker stopped: workspace initialization or source execution failed.');process.exitCode=1;}
}
