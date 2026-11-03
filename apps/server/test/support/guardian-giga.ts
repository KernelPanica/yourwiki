import type {Database} from '../../src/database.ts';
/** Keep the workspace administrable while a test revokes its actual target actor.
 * This account has no browser session or group memberships and never authors work.
 */
export const guardianGigaId='fixture-guardian-giga';
export function addGuardianGiga(db:Database){
 db.prepare("INSERT OR IGNORE INTO users(id,username,display_name,password_hash,admin_role) VALUES(?,?,'Fixture guardian','!disabled-fixture-login','giga')").run(guardianGigaId,guardianGigaId);
}
