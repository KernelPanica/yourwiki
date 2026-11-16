/** Operator CLI. Default is a local preview; only move-originals uses Drive
 * metadata writes and it always requires an interactive typed confirmation. */
import Sqlite from 'better-sqlite3';
import {join,isAbsolute} from 'node:path';
import {access,open} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {applicationId} from '../schema.ts';
import {BlobStore} from '../storage/blobs.ts';
import {loadSecretCodec} from '../providers/secret-key.ts';
import {SecretConfigs} from '../providers/secret-config.ts';
import {GoogleAuthPool} from '../providers/google-auth-pool.ts';
import {GoogleControlHttp} from '../providers/google-control-http.ts';
import {migrationLinks,NativeLinkCleanup} from './native-link-cleanup.ts';
import {NativeOriginalMover,type MovePlan} from './native-link-moves.ts';

const usage='Usage: node apps/server/src/rclone/native-link-cleanup-main.ts WORKSPACE CONNECTION_ID [plan|apply|move-originals]';
if(process.argv.includes('--help')){console.info(usage);process.exit(0);}
const [workspace,connectionId,mode='plan',...extra]=process.argv.slice(2);
if(!workspace||!isAbsolute(workspace)||!connectionId||!['plan','apply','move-originals'].includes(mode)||extra.length)throw Error(usage);
await access(join(workspace,'database.sqlite3'));
const db=new Sqlite(join(workspace,'database.sqlite3'),{readonly:mode==='plan',fileMustExist:true});
db.pragma('foreign_keys = ON');db.pragma('busy_timeout = 5000');
let codec:Awaited<ReturnType<typeof loadSecretCodec>>|undefined,pool:GoogleAuthPool|undefined,http:GoogleControlHttp|undefined,audit:Awaited<ReturnType<typeof open>>|undefined;
const controller=new AbortController();for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort());
try{
 if(db.pragma('application_id',{simple:true})!==applicationId)throw Error('NOT_A_YOURWIKI_DATABASE');
 const connection=db.prepare("SELECT id,revision,encrypted_config FROM provider_connections WHERE id=? AND provider='google' AND enabled=1").get(connectionId) as {id:string;revision:number;encrypted_config:string}|undefined;
 if(!connection)throw Error('GOOGLE_CONNECTION_NOT_FOUND');
 const actor=db.prepare("SELECT id FROM users WHERE active=1 AND admin_role='giga' AND purged_at IS NULL ORDER BY id LIMIT 1").get() as {id:string}|undefined;
 if(!actor)throw Error('ACTIVE_GIGA_ADMIN_REQUIRED');
 const receipts=migrationLinks(db,connectionId);if(!receipts.length)throw Error('NO_COMMITTED_NATIVE_MIGRATIONS');
 const receiptSnapshot=JSON.stringify(receipts),mapping=new Map(receipts.map(row=>[row.original_reference,row.destination_reference]));
 const check=()=>{
  controller.signal.throwIfAborted();
  const current=db.prepare('SELECT enabled,revision FROM provider_connections WHERE id=?').get(connectionId) as {enabled:number;revision:number}|undefined;
  if(!current?.enabled||current.revision!==connection.revision||JSON.stringify(migrationLinks(db,connectionId))!==receiptSnapshot)throw Error('MIGRATION_OR_CONNECTION_CHANGED');
  if(!db.prepare("SELECT 1 FROM users WHERE id=? AND active=1 AND admin_role='giga' AND purged_at IS NULL").get(actor.id))throw Error('ADMIN_CHANGED');
 };
 const store=await BlobStore.open(join(workspace,'storage')),cleanup=new NativeLinkCleanup(db,store,mapping,actor.id),plan=await cleanup.scan();check();
 for(const row of plan)console.info(JSON.stringify({document:row.id,title:row.title,format:row.format,revision:row.revision,links:row.count,supported:row.supported,...(row.error?{error:row.error}:{})}));
 const total=plan.reduce((sum,row)=>sum+row.count,0),unsupported=plan.filter(row=>!row.supported);
 console.info(JSON.stringify({mode,migrations:receipts.length,documents:plan.length,links:total,unsupported:unsupported.length}));
 if(mode==='plan'){
  console.info('Preview only. Use apply to save new document versions. Office filenames, including [YourWiki UUID], stay unchanged.');
 }else{
  if(plan.some(row=>row.error))throw Error('SCAN_ERRORS_FIX_BEFORE_APPLY');
  const stamp=Date.now()+'-'+process.pid;
  const record=async(event:Record<string,unknown>)=>{if(!audit)throw Error('AUDIT_NOT_OPEN');await audit.writeFile(JSON.stringify({at:new Date().toISOString(),...event})+'\n');await audit.sync();};
  const beginAudit=async()=>{
   const backup=join(workspace,'before-native-link-cleanup-'+stamp+'.sqlite3');
   const reserved=await open(backup,'wx',0o600);await reserved.close();await db.backup(backup);
   const path=join(workspace,'native-link-cleanup-'+stamp+'.jsonl');audit=await open(path,'wx',0o600);
   await record({event:'start',mode,connectionId,backup,receipts});console.info(JSON.stringify({backup,audit:path}));
  };
  codec=await loadSecretCodec(join(workspace,'encryption.key'));const configs=new SecretConfigs(codec),config=configs.decrypt(connection.encrypted_config);
  pool=new GoogleAuthPool(db,configs);const auth=pool;
  http=new GoogleControlHttp({access:scope=>auth.access(connectionId,connection.revision,scope),invalidate:token=>auth.invalidate(connectionId,connection.revision,token)});
  const scope={check,signal:controller.signal};
  // An immutable receipt proves the cutover, not that the file still exists today.
  for(const receipt of receipts){
   const target=await http.call('GET','files/'+receipt.destination_reference,{fields:'id,name,mimeType,trashed'},undefined,scope);
   if(target.id!==receipt.destination_reference||target.trashed||typeof target.mimeType!=='string'||target.mimeType.startsWith('application/vnd.google-apps.')||typeof target.name!=='string'||!target.name.toLowerCase().endsWith('.'+receipt.format))throw Error('MIGRATED_OFFICE_FILE_UNAVAILABLE');
  }
  if(mode==='apply'){
   await beginAudit();await cleanup.apply(plan,record,check);
   console.info('Link updates saved as new versions; provider delivery queued. Wait for synchronization, then run move-originals to review and confirm native-object moves.');
   if(unsupported.length)console.info('Unsupported documents remain unchanged and will block move-originals; see the report above.');
  }else{
   if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('MOVE_REQUIRES_INTERACTIVE_TERMINAL');
   cleanup.assertSynchronized(plan);
   if(typeof config.root!=='string')throw Error('YOURWIKI_DRIVE_ROOT_MISSING');
   const moveCheck=()=>{check();cleanup.assertSynchronized(plan);};
   const isBound=(id:string)=>!!db.prepare('SELECT 1 FROM provider_source_bindings WHERE reference=? UNION ALL SELECT 1 FROM google_storage_exports WHERE reference=? LIMIT 1').get(id,id);
   const mover=new NativeOriginalMover(http,config.root,isBound,moveCheck),moves:MovePlan[]=[];
   for(const receipt of receipts){const move=await mover.plan(receipt.original_reference,receipt.destination_reference);moves.push(move);console.info(JSON.stringify({original:receipt.original_reference,status:move.status,from:move.status==='ready'?'YourWiki/'+move.relativePath:undefined,to:move.status==='ready'?'/'+move.relativePath:undefined}));}
   const ready=moves.filter(move=>move.status==='ready');
   // Distinct source folders with the same names must not collapse into duplicate destinations.
   if(new Set(ready.map(move=>move.relativePath)).size!==ready.length)throw Error('DUPLICATE_DESTINATION_PATH');
   if(!ready.length)console.info('No native originals under the YourWiki root need moving.');
   else{
    const prompt=createInterface({input:process.stdin,output:process.stdout});let answer:string;
    try{answer=await prompt.question(`Move ${ready.length} unused native Google objects to the paths above? Type MOVE ORIGINALS: `,{signal:controller.signal});}finally{prompt.close();}
    if(answer!=='MOVE ORIGINALS')console.info('Cancelled. No Drive objects moved.');
    else{
     moveCheck();await beginAudit();
     for(const move of ready){await mover.move(move,true,record);console.info(JSON.stringify({moved:move.original.id,to:'/'+move.relativePath}));}
    }
   }
  }
 }
}finally{await audit?.close();await http?.close();await pool?.close();codec?.close();db.close();}
