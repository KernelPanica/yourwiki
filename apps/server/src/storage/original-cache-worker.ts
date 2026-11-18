import {setTimeout as sleep} from 'node:timers/promises';
import {lstat,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {BlobStore} from './blobs.ts';
import {RcloneOriginalStore,originalDigests} from './rclone-originals.ts';
/** Low-memory maintenance. Receipts are checked again after hashing, and failures
 * preserve the local outbox. There is no remote delete/copy operation here. */
export class OriginalCacheWorker{
 private cursor=0;private due=0;private root:string;private database:string;private store:BlobStore;
 constructor(database:string,root:string,store:BlobStore){this.database=database;this.root=root;this.store=store;}
 async runOnce(signal?:AbortSignal){
  if(!(this.store instanceof RcloneOriginalStore)||Date.now()<this.due||signal?.aborted)return 'idle';
  this.due=Date.now()+30000;
  try{for(const file of await readdir(join(this.root,'read-cache'))){if(!/^[a-f0-9]{64}$/.test(file)&&!/^[-a-f0-9]+\.part$/.test(file))continue;const path=join(this.root,'read-cache',file);if((await lstat(path)).mtimeMs<Date.now()-300000)await rm(path,{force:true});}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')console.warn('PROCESSING_CACHE_CLEANUP_DEFERRED');}
  const digests=originalDigests(this.database),deadline=Date.now()+10000;let removed=0,bytes=0,examined=0,visited=0,failed=0;
  while(visited<digests.length&&examined<16&&Date.now()<deadline&&!signal?.aborted){
   const value=digests[this.cursor++%digests.length];visited++;
   try{await lstat(join(this.root,'blobs',value.slice(0,2),value.slice(2)));examined++;const size=await this.store.evictConfirmed(value);if(size){removed++;bytes+=size;}}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')failed++;}
  }
  if(removed||failed)console.info(JSON.stringify({originalCache:{removed,bytes,failed}}));
  return removed?'worked':'idle';
 }
 async run(signal:AbortSignal){while(!signal.aborted){await this.runOnce(signal);try{await sleep(1000,undefined,{signal});}catch{}}}
}
