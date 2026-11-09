import {recoverSyncAction} from './sync-actions.ts';
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
   const rows=this.db.prepare(`SELECT b.document_id,c.enabled,r.trashed,s.sequence,s.due_at,j.state,j.created_at AS checked_at,
    (w.expires_at>? AND w.notified_at>0 AND w.connection_revision=c.revision AND w.binding_generation=b.generation AND w.reference=b.reference) AS watch_healthy,
    (c.provider='google' AND (
     EXISTS(SELECT 1 FROM document_presence p JOIN sessions parent ON parent.token_hash=p.browser_session_hash JOIN users u ON u.id=parent.user_id WHERE p.document_id=b.document_id AND p.expires_at>? AND parent.expires_at>? AND u.active=1 AND u.auth_version=parent.auth_version)
     OR EXISTS(SELECT 1 FROM office_sessions o JOIN office_tokens t ON t.office_session_id=o.id JOIN sessions parent ON parent.token_hash=t.browser_session_hash JOIN users u ON u.id=parent.user_id WHERE o.document_id=b.document_id AND o.superseded=0 AND o.expires_at>? AND t.expires_at>? AND parent.expires_at>? AND u.active=1 AND u.auth_version=parent.auth_version)
     OR EXISTS(SELECT 1 FROM office_openings o JOIN sessions parent ON parent.token_hash=o.browser_session_hash JOIN users u ON u.id=parent.user_id WHERE o.document_id=b.document_id AND o.state='pending' AND o.created_at>? AND parent.expires_at>? AND u.active=1 AND u.auth_version=parent.auth_version)
    )) AS active FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id JOIN resources r ON r.id=b.document_id LEFT JOIN provider_sync_checks s ON s.document_id=b.document_id LEFT JOIN jobs j ON j.id=s.job_id LEFT JOIN provider_google_watches w ON w.document_id=b.document_id WHERE b.document_id>? ORDER BY b.document_id LIMIT 50`).all(now,now,now,now,now,now,now-180000,now,cursor.after_document_id??'') as {document_id:string;enabled:number;trashed:number;sequence:number|null;due_at:number|null;state:string|null;checked_at:number|null;active:number;watch_healthy:number}[];
   let queued=0;
   for(const row of rows){
    recoverSyncAction(this.db,row.document_id,now);
    const interval=row.watch_healthy?(row.active?15000:60000):(row.active?2000:30000);
    const dueAt=row.active&&row.checked_at!==null?Math.min(row.due_at??0,row.checked_at+interval):row.due_at;
    if(!row.enabled||row.trashed||dueAt!==null&&dueAt>now||row.state==='queued'||row.state==='running')continue;
    const sequence=(row.sequence??0)+1;if(!Number.isSafeInteger(sequence))throw new Error('Provider poll sequence exhausted');
    const jobId=this.queue.enqueue({kind:'provider.pull',key:`${row.document_id}:${sequence}`,payload:{documentId:row.document_id}},now);
    this.db.prepare('INSERT INTO provider_sync_checks VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET sequence=excluded.sequence,due_at=excluded.due_at,job_id=excluded.job_id').run(row.document_id,sequence,now+interval,jobId);queued++;
   }
   this.db.prepare('UPDATE provider_sync_cursor SET after_document_id=? WHERE id=1').run(rows.length===50?rows.at(-1)!.document_id:null);
   return {scanned:rows.length,queued};
  });
 }
}
