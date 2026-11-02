import {assertProviderHistoryContext} from './providers/version-origins.ts';
import type {Database} from './database.ts';
import {DocumentError} from './document-errors.ts';
import {historyPolicy} from './history-settings.ts';
type Prior={source_revision:number;layer_revision:number|null;digest:string;size:number;title:string;format:string};
/** An archive receipt joins its accepted original/layer commit; never call outside that transaction. */
function capture(db:Database,documentId:string,userId:string|null,nextDigest:string,now:number,kind:'source'|'pdf-layer',prior:()=>Prior|undefined){
 if(!db.inTransaction)throw new Error('History capture requires its document commit transaction');const policy=historyPolicy(db);if(!policy.enabled)return;const previous=prior();if(!previous||previous.digest===nextDigest)return;
 const usage=db.prepare('SELECT total_bytes,entry_count FROM history_usage WHERE document_id=?').get(documentId) as {total_bytes:number;entry_count:number}|undefined;
 if(previous.size>policy.byteLimit-(usage?.total_bytes??0)||(usage?.entry_count??0)>=policy.entryLimit)throw new DocumentError('HISTORY_LIMIT');
 const author=userId===null?null:db.prepare('SELECT display_name FROM users WHERE id=? AND active=1').get(userId) as {display_name:string}|undefined;if(userId!==null&&!author)throw new DocumentError('ACCESS_DENIED');
 db.prepare('INSERT INTO history_entries(document_id,kind,source_revision,layer_revision,digest,size,title,format,captured_by,captured_by_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(documentId,kind,previous.source_revision,previous.layer_revision,previous.digest,previous.size,previous.title,previous.format,userId,author?.display_name??'',now);
}
export function captureSourceHistory(db:Database,documentId:string,userId:string,nextDigest:string,now:number){
 if(typeof userId!=='string'||!userId)throw new DocumentError('ACCESS_DENIED');
 capture(db,documentId,userId,nextDigest,now,'source',()=>db.prepare('SELECT v.revision AS source_revision,NULL AS layer_revision,v.digest,v.size,d.title,d.format FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(documentId) as Prior|undefined);
}
export function capturePdfHistory(db:Database,documentId:string,userId:string,nextDigest:string,now:number){
 if(typeof userId!=='string'||!userId)throw new DocumentError('ACCESS_DENIED');
 capture(db,documentId,userId,nextDigest,now,'pdf-layer',()=>{
  const layer=db.prepare('SELECT p.base_revision AS source_revision,p.revision AS layer_revision,p.digest,p.size,d.title,d.format FROM pdf_layer_versions p JOIN documents d ON d.id=p.document_id WHERE p.document_id=? ORDER BY p.revision DESC LIMIT 1').get(documentId) as Prior|undefined;
  return layer??db.prepare('SELECT v.revision AS source_revision,0 AS layer_revision,v.digest,v.size,d.title,d.format FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(documentId) as Prior|undefined;
 });
}

/** Internal provider commit only: an unknown external human is not a Yourwiki account. */
export function captureProviderSourceHistory(db:Database,documentId:string,nextDigest:string,now:number){
 assertProviderHistoryContext(db,documentId);
 capture(db,documentId,null,nextDigest,now,'source',()=>db.prepare('SELECT v.revision AS source_revision,NULL AS layer_revision,v.digest,v.size,d.title,d.format FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(documentId) as Prior|undefined);
}
