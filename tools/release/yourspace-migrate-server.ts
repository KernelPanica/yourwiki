import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const Sqlite=createRequire(new URL('../../apps/server/package.json',import.meta.url))('better-sqlite3');
import {issuerOrigin} from '../../apps/server/src/auth/yourspace-oidc.ts';
import {openDatabase} from '../../apps/server/src/database.ts';
import {migrateYourwikiAccounts} from './yourspace-account-migration.ts';
const root=process.env.YOURSPACE_MIGRATION_DIR!,source=process.env.YOURSPACE_MIGRATION_SOURCE!;
if(!root?.startsWith('/')||!source?.startsWith('/'))throw Error('EXPLICIT_PRIVATE_STAGING_PATHS_REQUIRED');
const issuer=issuerOrigin(process.env.YOURWIKI_YOURSPACE_ISSUER??''),wikiOrigin=issuerOrigin(process.env.YOURWIKI_PUBLIC_URL??'');
const {openDatabase:openSpace}=await import(pathToFileURL(join(source,'db.ts')).href),{cipherFromEnv,useCipher,sealedColumns,place}=await import(pathToFileURL(join(source,'crypto/data-cipher.ts')).href),{Accounts}=await import(pathToFileURL(join(source,'auth/accounts.ts')).href),{Oidc}=await import(pathToFileURL(join(source,'oidc/provider.ts')).href);
for(const name of ['wiki','space']){const db=new Sqlite(join(root,name+'.before.sqlite3'),{readonly:true,fileMustExist:true});try{await db.backup(join(root,name+'.staged.sqlite3'));}finally{db.close();}}
const wiki=openDatabase(join(root,'wiki.staged.sqlite3')),space=openSpace(join(root,'space.staged.sqlite3'));
try{
 const cipher=cipherFromEnv();useCipher(space,cipher);
 for(const col of sealedColumns())for(const r of space.prepare(`SELECT ${col.key} id,${col.column} value FROM ${col.table} WHERE ${col.column} IS NOT NULL`).all())cipher.open(r.value,place(col.table,col.column,r.id));
 const existing=space.prepare('SELECT * FROM users ORDER BY id').all(),factors=space.prepare('SELECT * FROM second_factor ORDER BY user_id').all();
 const fingerprint=(db:any,table:string)=>{const h=createHash('sha256');for(const r of db.prepare('SELECT * FROM '+table+' ORDER BY rowid').iterate())h.update(JSON.stringify(r));return h.digest('hex');};
 const unchanged=['users','groups','memberships','resources','document_versions','provider_connections','provider_source_bindings','app_state'];const before=Object.fromEntries(unchanged.map(t=>[t,fingerprint(wiki,t)]));
 let mapping={};try{mapping=JSON.parse(await readFile(join(root,'mapping.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const report=migrateYourwikiAccounts(wiki,space,issuer,Date.now(),mapping);
 for(const [table,value] of Object.entries(before))if(fingerprint(wiki,table)!==value)throw Error('WIKI_DATA_CHANGED:'+table);
 for(const old of existing)if(JSON.stringify(space.prepare('SELECT * FROM users WHERE id=?').get(old.id))!==JSON.stringify(old))throw Error('EXISTING_CENTRAL_ACCOUNT_CHANGED');
 if(JSON.stringify(space.prepare('SELECT * FROM second_factor ORDER BY user_id').all())!==JSON.stringify(factors))throw Error('EXISTING_MFA_CHANGED');
 const oidc=new Oidc(space,new Accounts(space,{origin:issuer}),{issuer,fallbackEmailDomain:'ageofsilence.net'});
 if(oidc.client('yourwiki'))throw Error('CLIENT_ALREADY_EXISTS');
 const client=oidc.addClient({id:'yourwiki',name:'YourWiki',redirectUris:[wikiOrigin+'/api/auth/yourspace/callback'],postLogoutRedirectUris:[wikiOrigin+'/']});
 await writeFile(join(root,'client.secret'),client.secret,{mode:0o400,flag:'wx'});
 for(const db of [wiki,space]){if(db.pragma('integrity_check',{simple:true})!=='ok'||db.pragma('foreign_key_check').length)throw Error('INVALID_STAGED_DATABASE');db.pragma('wal_checkpoint(TRUNCATE)');}
 await writeFile(join(root,'report.json'),JSON.stringify({...report,preservedTables:Object.keys(before),wikiUsers:wiki.prepare('SELECT count(*) n FROM users').get().n,spaceUsers:space.prepare('SELECT count(*) n FROM users').get().n}),{mode:0o600});
 console.log(JSON.stringify({staged:true,...report,existingCentralAccountsPreserved:existing.length,integrity:'ok'}));
}finally{wiki.close();space.close();}
