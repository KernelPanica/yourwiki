import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {transaction,type Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {ProviderError} from '../providers/adapter.ts';
import {RcloneClient,rcloneEntry} from './client.ts';
import {mountRuntime,drainNativeMigrations} from './storage-worker.ts';
/** Creates independent binary copies without holding the ordinary save/sync slot. */
export class NativeMigrationWorker {
 private db:Database;private store:BlobStore;
 constructor(db:Database,store:BlobStore){this.db=db;this.store=store;}
 async runOnce(signal?:AbortSignal){
  if(signal?.aborted)return 'idle';const token=randomUUID(),mount=transaction(this.db,()=>{
   if(this.db.prepare("SELECT 1 FROM worker_slots WHERE name='native-migration' AND lease_until>?").get(Date.now()))return null;
   const row=this.db.prepare(`SELECT m.*,c.revision FROM rclone_drive_mounts m JOIN provider_connections c ON c.id=m.connection_id JOIN google_storage_mounts g ON g.connection_id=c.id JOIN users u ON u.id=g.actor_id
    WHERE c.enabled=1 AND u.active=1 AND u.admin_role='giga' AND EXISTS(SELECT 1 FROM rclone_native_queue q JOIN provider_source_bindings b ON b.document_id=q.document_id JOIN resources r ON r.id=q.document_id
     WHERE b.connection_id=c.id AND r.trashed=0 AND q.next_attempt_at<=?) LIMIT 1`).get(Date.now()) as (Parameters<typeof mountRuntime>[0]&{connection_id:string;revision:number})|undefined;
   if(row)this.db.prepare("INSERT INTO worker_slots VALUES('native-migration',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(token,Date.now()+30000);return row;
  });if(!mount)return 'idle';
  const controller=new AbortController(),scope={signal:AbortSignal.any([controller.signal,...signal?[signal]:[]]),check:()=>{
   if(controller.signal.aborted||signal?.aborted)throw new ProviderError('PROVIDER_CANCELLED');
   if(!this.db.prepare("SELECT 1 FROM worker_slots WHERE name='native-migration' AND token=? AND lease_until>?").get(token,Date.now()))throw new ProviderError('LEASE_LOST');
   if(!this.db.prepare("SELECT 1 FROM provider_connections c JOIN google_storage_mounts g ON g.connection_id=c.id JOIN users u ON u.id=g.actor_id WHERE c.id=? AND c.enabled=1 AND c.revision=? AND u.active=1 AND u.admin_role='giga'").get(mount.connection_id,mount.revision))throw new ProviderError('PROVIDER_CONFIG_CHANGED');
  }},heartbeat=setInterval(()=>{try{scope.check();this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='native-migration' AND token=?").run(Date.now()+30000,token);}catch{controller.abort();}},10000);
  try{
   const entries=(this.db.prepare('SELECT metadata FROM rclone_drive_entries WHERE connection_id=?').all(mount.connection_id) as {metadata:string}[]).map(row=>rcloneEntry(JSON.parse(row.metadata)));
   const directories=new Map(entries.filter(e=>e.IsDir).map(e=>[e.Path,e.ID])),client=new RcloneClient(mountRuntime(mount),directories);
   await drainNativeMigrations(this.db,this.store,client,scope,entries,mount.connection_id);return 'worked';
  }catch(error){if(!signal?.aborted)console.warn(JSON.stringify({nativeMigrationWorker:'deferred',code:error instanceof ProviderError?error.code:'MIGRATION_FAILED'}));return 'deferred';}
  finally{clearInterval(heartbeat);controller.abort();this.db.prepare("DELETE FROM worker_slots WHERE name='native-migration' AND token=?").run(token);}
 }
 async run(signal:AbortSignal){while(!signal.aborted){await this.runOnce(signal);try{await delay(1000,undefined,{signal});}catch{if(!signal.aborted)throw Error('Migration polling failed');}}}
}
