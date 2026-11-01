import type {Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
function fail():never{throw new DocumentError('INVALID_PROVIDER_ORIGIN');}
/** Background service context only; this is not user authorization or a credential capability. */
export function providerOriginContext(db:Database,documentId:string){
 let id:string|null=documentId;const seen=new Set<string>();while(id!==null){if(seen.has(id)||seen.size>=33)fail();seen.add(id);const resource=db.prepare('SELECT kind,parent_id,trashed FROM resources WHERE id=?').get(id) as {kind:string;parent_id:string|null;trashed:number}|undefined;if(!resource||resource.trashed||resource.kind!==(id===documentId?'document':'folder'))fail();id=resource.parent_id;}
 const doc=db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(documentId) as {local_revision:number;provider_revision:number|null}|undefined;if(!doc)fail();return doc;
}
/** Trusted commit-only provenance. Caller independently verifies snapshot bytes, baseline and leases. */
export function stageProviderOrigin(db:Database,input:{documentId:string;revision:number;connectionId:string;fingerprint:string;observedAt:number}):void{
 if(!db.inTransaction)throw new Error('Provider origin requires a transaction');
 const {documentId,revision,connectionId,fingerprint,observedAt}=input;
 if(typeof documentId!=='string'||!documentId||documentId.length>128||typeof connectionId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(connectionId)||!Number.isSafeInteger(revision)||revision<1||typeof fingerprint!=='string'||!fingerprint||fingerprint.length>1024||/[\x00-\x1f\x7f]/.test(fingerprint)||Buffer.from(fingerprint).toString('utf8')!==fingerprint||!Number.isSafeInteger(observedAt)||observedAt<0)fail();
 const doc=providerOriginContext(db,documentId),connection=db.prepare('SELECT enabled FROM provider_connections WHERE id=?').get(connectionId) as {enabled:number}|undefined,binding=db.prepare('SELECT connection_id FROM provider_source_bindings WHERE document_id=?').get(documentId) as {connection_id:string}|undefined;
 if(!connection?.enabled||revision!==doc.local_revision+1||(binding?binding.connection_id!==connectionId:doc.local_revision!==0))fail();
 db.prepare('INSERT INTO document_provider_origins(document_id,revision,connection_id,fingerprint,observed_at) VALUES(?,?,?,?,?)').run(documentId,revision,connectionId,fingerprint,observedAt);
}
/** Trusted history capture needs a live verified binding, never a fake human user. */
export function assertProviderHistoryContext(db:Database,documentId:string):void{
 if(!db.inTransaction)throw new Error('Provider capture requires a transaction');providerOriginContext(db,documentId);
 if(!db.prepare('SELECT 1 FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.enabled=1').get(documentId))fail();
}
