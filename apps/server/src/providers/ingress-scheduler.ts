import {transaction,type Database} from '../database.ts';
import {JobQueue} from '../jobs.ts';
/** Bounded metadata-only scheduling. No credentials, network requests or document reads. */
export class IngressScheduler {
 private db:Database;private queue:JobQueue;
 constructor(db:Database){this.db=db;this.queue=new JobQueue(db);}
 tick(now=Date.now()):{scanned:number;queued:number}{
  if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-30000)throw new Error('Invalid provider poll time');
  return transaction(this.db,()=>{
   const cursor=this.db.prepare('SELECT after_document_id FROM provider_sync_cursor WHERE id=1').get() as {after_document_id:string|null};
   const rows=this.db.prepare(`SELECT b.document_id,c.enabled,r.trashed,s.sequence,s.due_at,j.state FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN resources r ON r.id=b.document_id LEFT JOIN provider_sync_checks s ON s.document_id=b.document_id LEFT JOIN jobs j ON j.id=s.job_id WHERE b.document_id>? ORDER BY b.document_id LIMIT 50`).all(cursor.after_document_id??'') as {document_id:string;enabled:number;trashed:number;sequence:number|null;due_at:number|null;state:string|null}[];
   let queued=0;
   for(const row of rows){
    if(!row.enabled||row.trashed||row.due_at!==null&&row.due_at>now||row.state==='queued'||row.state==='running')continue;
    const sequence=(row.sequence??0)+1;if(!Number.isSafeInteger(sequence))throw new Error('Provider poll sequence exhausted');
    const jobId=this.queue.enqueue({kind:'provider.pull',key:`${row.document_id}:${sequence}`,payload:{documentId:row.document_id}},now);
    this.db.prepare('INSERT INTO provider_sync_checks VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET sequence=excluded.sequence,due_at=excluded.due_at,job_id=excluded.job_id').run(row.document_id,sequence,now+30000,jobId);queued++;
   }
   this.db.prepare('UPDATE provider_sync_cursor SET after_document_id=? WHERE id=1').run(rows.length===50?rows.at(-1)!.document_id:null);
   return {scanned:rows.length,queued};
  });
 }
}
