import {isAbsolute} from 'node:path';
import {stat} from 'node:fs/promises';
import {openDatabase} from '../database.ts';
import {BlobStore} from '../storage/blobs.ts';
import {loadSecretCodec} from './secret-key.ts';
import {SecretConfigs} from './secret-config.ts';
import {CredentialVault} from './credential-vault.ts';
import {DeliveryWorker,type AdapterResolver} from './delivery-worker.ts';
import {IngressWorker} from './ingress-worker.ts';
import {IngressScheduler} from './ingress-scheduler.ts';
import {ProviderLoop} from './provider-loop.ts';
import {LocalAdapter} from './local-adapter.ts';
import {ProviderError} from './adapter.ts';
// Explicit initialized new workspace only; no production/legacy discovery or key creation.
const args=process.argv.slice(2);
if(args.length!==3||!args.every(isAbsolute)){
 console.error('Usage: npm run provider-worker -- /absolute/new-yourwiki-v2.sqlite3 /absolute/private-storage /absolute/existing-secret.key');process.exitCode=1;
}else{
 try{
  if(!(await stat(args[0])).isFile()||!(await stat(args[1])).isDirectory())throw new Error('Missing initialized workspace');const codec=await loadSecretCodec(args[2]);
  try{const db=openDatabase(args[0]);try{const store=await BlobStore.open(args[1]),vault=new CredentialVault(db,new SecretConfigs(codec)),controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
   try{console.info('Yourwiki provider worker started (one shared source slot).');const resolve:AdapterResolver=async connection=>{if(connection.provider!=='local'||typeof connection.config.root!=='string')throw new ProviderError('PROVIDER_CONFIG_CHANGED');return LocalAdapter.open(connection.config.root);};await new ProviderLoop(new IngressScheduler(db),new DeliveryWorker(db,store,vault,resolve),new IngressWorker(db,store,vault,resolve)).run(controller.signal);}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  }finally{db.close();}}finally{codec.close();}
 }catch{console.error('Provider worker stopped: workspace initialization or source execution failed.');process.exitCode=1;}
}
