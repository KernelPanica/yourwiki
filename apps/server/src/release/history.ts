import {randomUUID} from 'node:crypto';
import {transaction,type Database} from '../database.ts';
import {HistoryCatalogue} from '../history-catalogue.ts';
import {decodeHistoryArchive} from '../history-archive.ts';
import type {BlobStore,BlobRef} from '../storage/blobs.ts';
/** Trusted offline migration boundary: canonical history may precede preview publication.
 * Parser, metadata preservation, quotas and catalogue publication use the runtime's normal implementation. */
export async function importOfflineHistory(db:Database,store:BlobStore,input:{documentId:string;authorId:string;archive:BlobRef}){
 const id='legacy-'+randomUUID(),token=randomUUID(),catalogue=new HistoryCatalogue(db),now=Date.now();
 db.prepare("INSERT INTO history_imports(id,author_id,document_id,source_key,archive_digest,archive_size,namespace_id,state,reserved_bytes,lease_token,lease_until,created_at,updated_at) VALUES(?,?,?,'legacy-history',?,?,?,'receiving',0,?,?,?,?)").run(id,input.authorId,input.documentId,input.archive.digest,input.archive.size,randomUUID(),token,now+3600000,now,now);
 try{const result=await decodeHistoryArchive(await store.read(input.archive.digest),{maxArchiveBytes:input.archive.size,consume:source=>store.put(source,{maxBytes:4*1024**3}),accept:async(meta,blob,ordinal)=>{catalogue.stageImportEntry({importId:id,generation:1,ordinal,metadata:JSON.stringify(meta),blob});}});
  if(result.sha256!==input.archive.digest||result.size!==input.archive.size)throw new Error('HISTORY_ARCHIVE_CORRUPT');
  return transaction(db,()=>{db.prepare("UPDATE history_imports SET state='prepared',entry_count=?,total_bytes=?,catalogue_ready=1,adoption_started=1,updated_at=? WHERE id=?").run(result.entries,result.totalBytes,Date.now(),id);return catalogue.publishImport({importId:id,generation:1,token,now:Date.now()});});
 }catch(error){db.prepare("UPDATE history_imports SET state='failed',lease_token=NULL,lease_until=0,error_code='HISTORY_MIGRATION_FAILED' WHERE id=?").run(id);throw error;}
}
