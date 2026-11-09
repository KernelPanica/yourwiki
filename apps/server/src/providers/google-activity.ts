import {AccessService} from '../access.ts';
import {readTransaction,type Database} from '../database.ts';
import {DocumentError} from '../document-errors.ts';
/** Verified external bytes only. No provider calls, no per-view scan of version history. */
export class GoogleActivity {
 private db:Database;private access:AccessService;private binding;private latest;private proof;
 constructor(db:Database){this.db=db;this.access=new AccessService(db);this.binding=db.prepare("SELECT b.connection_id,b.generation,c.revision FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=? AND c.provider='google' AND c.enabled=1");this.latest=db.prepare('SELECT revision,fingerprint,observed_at FROM document_provider_origins WHERE document_id=? ORDER BY revision DESC LIMIT 1');this.proof=db.prepare("SELECT 1 FROM provider_ingress_snapshots WHERE document_id=? AND connection_id=? AND binding_generation=? AND connection_revision=? AND observed_fingerprint=? AND state='applied' AND json_extract(receipt,'$.changed')=1 LIMIT 1");}
 status(user:string,id:string,now=Date.now()){return readTransaction(this.db,()=>{if(!this.access.allows(user,id,'read'))throw new DocumentError('NOT_FOUND');const binding=this.binding.get(id) as {connection_id:string;generation:number;revision:number}|undefined;if(!binding)return null;const row=this.latest.get(id) as {revision:number;fingerprint:string;observed_at:number}|undefined;if(!row||row.revision<=1||!this.proof.get(id,binding.connection_id,binding.generation,binding.revision,row.fingerprint))return null;return {observedAt:row.observed_at,revision:row.revision,serverNow:now,activeForMs:Math.max(0,Math.min(60000,60000-(now-row.observed_at)))};});}
}
