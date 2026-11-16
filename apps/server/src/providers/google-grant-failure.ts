import {transaction,type Database} from '../database.ts';
import {ProviderError} from './adapter.ts';
/** Preserve uncertain mutation receipts, but never label a rejected check as pending. */
export function recordGoogleGrantFailure(db:Database,reference:string,error:unknown,now:number){
 const code=error instanceof ProviderError?error.code:'PROVIDER_UNAVAILABLE';
 transaction(db,()=>{
  for(const table of ['provider_google_grants','provider_google_export_rules'])db.prepare(`UPDATE ${table}
   SET state=CASE WHEN state='unknown' THEN state ELSE 'failed' END,error_code=?,checked_at=? WHERE reference=?`).run(code,now,reference);
 });
 return code;
}
