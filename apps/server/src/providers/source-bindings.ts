import {transaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
/** Trusted import/connect boundary: caller has verified this exact remote original.
 * Never expose this function as a user-supplied arbitrary-reference route. */
export function bindExistingSource(db:Database,input:{documentId:string;connectionId:string;reference:string;fingerprint:string;confirmedRevision:number;confirmedDigest:string;confirmedSize:number;now:number}):void {
 const {documentId,connectionId,reference,fingerprint,confirmedRevision,confirmedDigest,confirmedSize,now}=input;
 if(![documentId,connectionId,reference,fingerprint].every(x=>typeof x==='string'&&x.length>0&&!/[\x00-\x1f\x7f]/.test(x))||reference.length>4096||fingerprint.length>1024||!Number.isSafeInteger(confirmedRevision)||confirmedRevision<1||!Number.isSafeInteger(confirmedSize)||confirmedSize<0||confirmedSize>4*1024**3||!Number.isSafeInteger(now)||now<0||!/^[a-f0-9]{64}$/.test(confirmedDigest))throw new DocumentError('INVALID_REQUEST');
 transaction(db,()=>{
  const version=db.prepare('SELECT digest,size FROM document_versions WHERE document_id=? AND revision=?').get(documentId,confirmedRevision) as {digest:string;size:number}|undefined;
  const current=db.prepare('SELECT d.local_revision,r.trashed FROM documents d JOIN resources r ON r.id=d.id WHERE d.id=?').get(documentId) as {local_revision:number;trashed:number}|undefined;
  const connection=db.prepare('SELECT enabled FROM provider_connections WHERE id=?').get(connectionId) as {enabled:number}|undefined;
  if(!version||version.digest!==confirmedDigest||version.size!==confirmedSize||!current||current.trashed||!connection?.enabled)throw new DocumentError('INVALID_REQUEST');
  const existing=db.prepare('SELECT * FROM provider_source_bindings WHERE document_id=?').get(documentId) as {connection_id:string;reference:string;confirmed_revision:number;fingerprint:string}|undefined;
  if(existing){if(existing.connection_id!==connectionId||existing.reference!==reference||existing.confirmed_revision!==confirmedRevision||existing.fingerprint!==fingerprint)throw new DocumentError('CONFLICT');return;}
  // Initial binding may not silently abandon newer local accepted bytes.
  if(current.local_revision!==confirmedRevision)throw new DocumentError('CONFLICT');
  db.prepare('INSERT INTO provider_source_bindings(document_id,connection_id,reference,fingerprint,confirmed_revision,created_at) VALUES(?,?,?,?,?,?)').run(documentId,connectionId,reference,fingerprint,confirmedRevision,now);
  db.prepare('UPDATE documents SET provider_revision=? WHERE id=?').run(confirmedRevision,documentId);
 });
}
