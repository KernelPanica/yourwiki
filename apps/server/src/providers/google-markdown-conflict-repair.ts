import {createHash} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {AccessService} from '../access.ts';
import {JobQueue} from '../jobs.ts';
import type {CredentialVault} from './credential-vault.ts';
import type {IngressResolver} from './ingress-worker.ts';
import {sameGoogleBinaryContent} from './google-binary-baseline.ts';
import {supportsGoogleMarkdown,supportsGoogleBinary} from './google-markdown-write.ts';
/** A downloaded snapshot equal to an immutable acknowledged outgoing receipt is
 * our own write echoed by polling. Accept only that receipt, never import bytes,
 * rewind the binding or change the local revision. Private bytes remain until
 * ordinary ingress cleanup; genuine external changes are untouched. */
export function acknowledgeGoogleMarkdownEcho(db:Database,id:string,now=Date.now()){
 if(!db.inTransaction)throw new Error('Echo acknowledgement requires transaction');
 const row=db.prepare("SELECT s.*,d.format FROM provider_ingress_snapshots s JOIN documents d ON d.id=s.document_id JOIN provider_connections c ON c.id=s.connection_id JOIN provider_source_bindings b ON b.document_id=s.document_id WHERE s.id=? AND s.state IN ('staged','conflict') AND c.provider='google' AND c.enabled=1 AND c.revision=s.connection_revision AND b.connection_id=s.connection_id AND b.generation=s.binding_generation").get(id) as any;
 if(!row?.digest||!supportsGoogleBinary(row.format,row.observed_fingerprint))return null;
 // Let ingress accept confirmed-base metadata churn through its guarded path:
 // it preserves pending local bytes, updates the baseline and retries known failures.
 if(db.prepare('SELECT 1 FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.provider_revision WHERE d.id=? AND d.local_revision>d.provider_revision AND v.digest=? AND v.size=?').get(row.document_id,row.digest,row.size))return null;
 const receipts=db.prepare("SELECT a.id,a.revision,a.receipt_fingerprint FROM provider_delivery_attempts a WHERE a.document_id=? AND a.state='confirmed' AND a.digest=? AND a.size=? AND a.binding_generation=? AND a.connection_revision=? ORDER BY a.revision DESC LIMIT 50").all(row.document_id,row.digest,row.size,row.binding_generation,row.connection_revision) as {id:string;revision:number;receipt_fingerprint:string}[];
 const receipt=receipts.find(a=>sameGoogleBinaryContent(a.receipt_fingerprint,row.observed_fingerprint));if(!receipt)return null;
 const current=db.prepare('SELECT d.local_revision,d.provider_revision,b.fingerprint FROM documents d JOIN provider_source_bindings b ON b.document_id=d.id WHERE d.id=?').get(row.document_id) as any;
 if(current.local_revision===receipt.revision&&current.provider_revision===receipt.revision&&current.fingerprint===row.base_fingerprint&&!db.prepare("SELECT 1 FROM provider_delivery_attempts WHERE document_id=? AND state NOT IN ('confirmed','retired')").get(row.document_id))db.prepare('UPDATE provider_source_bindings SET fingerprint=? WHERE document_id=?').run(row.observed_fingerprint,row.document_id);
 const result={snapshotId:id,documentId:row.document_id,revision:receipt.revision,changed:false,previewJobId:null,echoOf:receipt.id};
 db.prepare("UPDATE provider_ingress_snapshots SET state='applied',receipt=?,error_code=NULL,updated_at=? WHERE id=?").run(JSON.stringify(result),now,id);
 db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.ingress',?,'{}',?)").run(row.document_id,now);return result;
}
/** Repair a definite metadata conflict or a legacy unsupported binary writer.
 * Read and hash the actual
 * remote bytes against the confirmed base before retiring the failed attempt.
 * New writes still run through the existing leased queue and strong If-Match.
 * No repair is possible for unknown dispatches, changed bytes or lost access. */
export class GoogleMarkdownConflictRepair{
 private db:Database;private vault:CredentialVault;private resolve:IngressResolver;private next=new Map<string,number>();private scanAt=0;
 constructor(db:Database,vault:CredentialVault,resolve:IngressResolver){if(!vault.belongsToDatabase(db))throw new Error('Wrong repair database');this.db=db;this.vault=vault;this.resolve=resolve;}
 async runOnce(signal?:AbortSignal){
  if(signal?.aborted)return 'idle';const now=Date.now();if(now<this.scanAt)return 'idle';this.scanAt=now+10000;
  const rows=this.db.prepare("SELECT a.id,a.state,a.error_code,a.document_id,a.revision,a.author_id,a.baseline,a.base_revision,a.binding_generation,a.connection_revision,b.connection_id,d.format,v.digest,v.size FROM provider_delivery_attempts a JOIN provider_source_bindings b ON b.document_id=a.document_id JOIN provider_connections c ON c.id=b.connection_id JOIN documents d ON d.id=a.document_id JOIN resources r ON r.id=d.id JOIN document_versions v ON v.document_id=a.document_id AND v.revision=a.base_revision WHERE ((a.state='conflict' AND a.error_code='PROVIDER_CONFLICT') OR (a.state='blocked' AND a.error_code IN ('SOURCE_SAVE_UNSUPPORTED','PROVIDER_UNAVAILABLE'))) AND c.provider='google' AND c.enabled=1 AND c.revision=a.connection_revision AND b.generation=a.binding_generation AND b.fingerprint=a.baseline AND b.confirmed_revision=a.base_revision AND d.local_revision=a.revision AND d.provider_revision=a.base_revision AND r.trashed=0 AND v.size<=4294967296 ORDER BY a.updated_at LIMIT 50").all() as any[];
  const row=rows.find(r=>(this.next.get(r.id)??0)<=now&&(r.state==='conflict'?supportsGoogleMarkdown(r.format,r.baseline):supportsGoogleBinary(r.format,r.baseline)));if(!row)return 'idle';this.next.set(row.id,now+120000);if(this.next.size>1000)for(const key of this.next.keys())if(!rows.some(r=>r.id===key))this.next.delete(key);
  let reader:Awaited<ReturnType<IngressResolver>>|undefined;
  const check=()=>{signal?.throwIfAborted();const a=this.db.prepare("SELECT 1 FROM provider_delivery_attempts a JOIN provider_source_bindings b ON b.document_id=a.document_id JOIN provider_connections c ON c.id=b.connection_id JOIN documents d ON d.id=a.document_id WHERE a.id=? AND a.state=? AND a.error_code=? AND a.baseline=b.fingerprint AND b.confirmed_revision=a.base_revision AND b.generation=a.binding_generation AND c.id=? AND c.enabled=1 AND c.revision=a.connection_revision AND d.local_revision=a.revision AND d.provider_revision=a.base_revision").get(row.id,row.state,row.error_code,row.connection_id);const access=new AccessService(this.db);if(!a||!access.allows(row.author_id,row.document_id,'write')||!access.allows(row.author_id,row.document_id,'read'))throw new Error('REPAIR_SCOPE_CHANGED');};
  try{check();const connection=this.vault.forBinding({documentId:row.document_id,connectionId:row.connection_id,connectionRevision:row.connection_revision,bindingGeneration:row.binding_generation});reader=await this.resolve(connection);const remote=await reader.read(connection.reference,{signal,check});check();if(!sameGoogleBinaryContent(remote.fingerprint,row.baseline)||remote.size!==row.size)return 'idle';const hash=createHash('sha256');let size=0;for await(const part of remote.bytes){check();size+=part.byteLength;if(size>row.size)throw new Error('REPAIR_SOURCE_CHANGED');hash.update(part);}check();if(size!==row.size||hash.digest('hex')!==row.digest)return 'idle';
   transaction(this.db,()=>{check();if(row.state==='conflict')this.db.prepare('INSERT INTO google_markdown_conflict_repairs VALUES(?,?,?,?,?)').run(row.id,remote.fingerprint,row.digest,size,Date.now());this.db.prepare("UPDATE provider_delivery_attempts SET state='retired',updated_at=? WHERE id=?").run(Date.now(),row.id);const job=new JobQueue(this.db).enqueue({kind:'provider.deliver',key:row.document_id+':metadata-repair:'+row.id,payload:{documentId:row.document_id,requestedRevision:row.revision}},Date.now());if(this.db.prepare('UPDATE provider_delivery_requests SET delivery_job_id=?,updated_at=? WHERE document_id=? AND requested_revision=?').run(job,Date.now(),row.document_id,row.revision).changes!==1)throw new Error('REPAIR_REQUEST_CHANGED');this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('provider.source-delivery',?,'{}',?)").run(row.document_id,Date.now());});return 'repaired';
  }catch{return 'idle';}finally{if(reader)await reader.close().catch(()=>{});}
 }
}
