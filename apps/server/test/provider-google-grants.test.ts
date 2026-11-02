import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {historyFixture} from './support/history-fixture.ts';
import {FernetCodec} from '../src/providers/fernet.ts';
import {SecretConfigs} from '../src/providers/secret-config.ts';
import {importLegacyConnection} from '../src/providers/connection-import.ts';
import {importLegacyGoogleGrant,googleManagedRecipients} from '../src/providers/google-grants.ts';
import {ProviderConnections} from '../src/providers/connections.ts';
import {openDatabase} from '../src/database.ts';
async function setup(t:any){
 const f=await historyFixture(t),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),configs=new SecretConfigs(codec);t.after(()=>codec.close());
 const connection={legacyKey:'backup-one:mount:1',id:'google',provider:'google' as const,label:'Google',path:'/',folderId:null,encryptedConfig:configs.encrypt({root:'rootId',client_id:'synthetic',refresh_token:'SYNTHETIC'}),now:10};
 importLegacyConnection(f.db,configs,connection);
 const grant={legacyKey:'backup-one:grant:1',connectionLegacyKey:connection.legacyKey,connectionId:'google',reference:'file',objectKey:createHash('sha256').update(':file').digest('hex'),legacyUserKey:'backup-one:user:7',recipient:'Editor@Example.org',desiredRole:'write',appliedRole:'write',permissionId:'permission_1',status:'synced',attemptedAt:123,now:100};
 return {...f,codec,configs,connection,grant,connections:new ProviderConnections(f.db,configs)};
}
const fails=(action:()=>unknown,code:string)=>assert.throws(action,(e:any)=>{assert.equal(e.code,code);assert.equal(e.message,code);return true;});
test('trusted stopped-source grant import preserves identity/status without giving local rights or exposing recipient in receipt',async t=>{
 const f=await setup(t),before=f.db.prepare('SELECT * FROM app_state').all(),users=f.db.prepare('SELECT * FROM users').all();
 const result=importLegacyGoogleGrant(f.db,f.grant);
 assert.deepEqual(result,{legacyKey:f.grant.legacyKey,connectionId:'google',state:'imported'});
 assert.equal(JSON.stringify(result).includes('Example'),false);assert.deepEqual(googleManagedRecipients(f.db,'google',1,'file'),['editor@example.org']);
 const row=f.db.prepare('SELECT * FROM provider_google_grant_imports').get() as any;assert.equal(row.recipient,f.grant.recipient);assert.equal(row.status,'synced');assert.equal(row.permission_id,'permission_1');assert.equal(row.legacy_user_key,f.grant.legacyUserKey);assert.equal(row.attempted_at,123);
 assert.deepEqual(f.db.prepare('SELECT * FROM app_state').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM users').all(),users);
 assert.deepEqual(googleManagedRecipients(f.db,'google',1,'different'),[]);
});
test('pending/failed/revoked and detached-user receipts retain legacy managed-recipient semantics without claiming applied access',async t=>{
 const f=await setup(t);
 for(const [i,status] of ['pending','failed','revoked'].entries())importLegacyGoogleGrant(f.db,{...f.grant,legacyKey:'backup-one:grant:'+i,status,legacyUserKey:null,desiredRole:'',appliedRole:'',permissionId:'',attemptedAt:null});
 assert.deepEqual(googleManagedRecipients(f.db,'google',1,'file'),['editor@example.org']);
 importLegacyGoogleGrant(f.db,{...f.grant,legacyKey:'backup-one:grant:blank',recipient:''});assert.deepEqual(googleManagedRecipients(f.db,'google',1,'file'),['editor@example.org']);
});
test('receipt replay after reopen/disable returns historical acknowledgement without modifying current state',async t=>{
 const f=await setup(t),receipt=importLegacyGoogleGrant(f.db,f.grant);f.connections.update('admin','google',{baseRevision:1,enabled:false});const db=openDatabase(f.path);t.after(()=>db.close());
 assert.deepEqual(importLegacyGoogleGrant(db,{...f.grant,now:200}),receipt);assert.equal((db.prepare('SELECT count(*) AS n FROM provider_google_grant_imports').get() as any).n,1);
 fails(()=>googleManagedRecipients(db,'google',1,'file'),'PROVIDER_CONFIG_CHANGED');fails(()=>googleManagedRecipients(db,'google',2,'file'),'PROVIDER_CONFIG_CHANGED');
 for(const change of [{recipient:'another@example.org'},{reference:'other',objectKey:createHash('sha256').update(':other').digest('hex')},{status:'revoked'},{connectionId:'other'},{permissionId:'p2'}])fails(()=>importLegacyGoogleGrant(db,{...f.grant,...change}),'MIGRATION_MISMATCH');
});
test('only matching imported Google mount/object namespace can receive a new grant receipt',async t=>{
 const f=await setup(t);
 for(const change of [{connectionLegacyKey:'wrong'},{connectionId:'wrong'},{objectKey:'a'.repeat(64)},{reference:'https://private.invalid/file'},{desiredRole:'owner'},{status:'unknown'},{recipient:'x\nprivate'},{attemptedAt:-1},{legacyUserKey:undefined}])fails(()=>importLegacyGoogleGrant(f.db,{...f.grant,...change}),'INVALID_REQUEST');
 f.db.exec("INSERT INTO resources(id,kind,owner_id,group_id) VALUES('folder','folder','admin','g')");
 const another={...f.connection,legacyKey:'backup-one:mount:2',id:'local',provider:'local' as const,path:'/local',folderId:'folder'};
 importLegacyConnection(f.db,f.configs,another);
 fails(()=>importLegacyGoogleGrant(f.db,{...f.grant,connectionId:'local',connectionLegacyKey:another.legacyKey}),'INVALID_REQUEST');
 assert.deepEqual(f.db.prepare('SELECT * FROM provider_google_grant_imports').all(),[]);
});
test('SQL prevents mutation/deletion and failed import leaves no partial authority or private errors',async t=>{
 const f=await setup(t);f.db.exec("CREATE TRIGGER owned_grant_failure BEFORE INSERT ON provider_google_grant_imports BEGIN SELECT RAISE(ABORT,'SYNTHETIC-PRIVATE');END");
 fails(()=>importLegacyGoogleGrant(f.db,f.grant),'CONFIG_UNAVAILABLE');assert.deepEqual(googleManagedRecipients(f.db,'google',1,'file'),[]);
 f.db.exec('DROP TRIGGER owned_grant_failure');importLegacyGoogleGrant(f.db,f.grant);
 assert.throws(()=>f.db.exec("UPDATE provider_google_grant_imports SET recipient='other@example.org'"),/immutable/);assert.throws(()=>f.db.exec('DELETE FROM provider_google_grant_imports'),/retained/);
 f.connections.update('admin','google',{baseRevision:1,label:'Renamed'});fails(()=>googleManagedRecipients(f.db,'google',1,'file'),'PROVIDER_CONFIG_CHANGED');assert.deepEqual(googleManagedRecipients(f.db,'google',2,'file'),['editor@example.org']);
 f.db.close();fails(()=>googleManagedRecipients(f.db,'google',2,'file'),'PROVIDER_CONFIG_CHANGED');
});
test('rejects getters and extra fields without executing migration input code',async t=>{
 const f=await setup(t);let calls=0;
 const value={...f.grant};Object.defineProperty(value,'recipient',{get(){calls++;return 'private';},enumerable:true});fails(()=>importLegacyGoogleGrant(f.db,value),'INVALID_REQUEST');assert.equal(calls,0);
 fails(()=>importLegacyGoogleGrant(f.db,{...f.grant,unrecognized:true} as any),'INVALID_REQUEST');
});
test('migration identity is independent of input property order and immutable SQL context cannot cross mounts',async t=>{
 const f=await setup(t),receipt=importLegacyGoogleGrant(f.db,f.grant);
 const reordered=Object.fromEntries(Object.entries(f.grant).reverse());assert.deepEqual(importLegacyGoogleGrant(f.db,reordered),receipt);
 assert.throws(()=>f.db.prepare("INSERT INTO provider_google_grant_imports SELECT 'other',connection_legacy_key,'missing',reference,object_key,legacy_user_key,recipient,desired_role,applied_role,permission_id,status,attempted_at,source_fingerprint,created_at FROM provider_google_grant_imports").run(),/context/);
});
test('same Google object retains managed receipts across mounts, while the querying connection must still be current',async t=>{
 const f=await setup(t);importLegacyGoogleGrant(f.db,f.grant);f.db.exec("INSERT INTO resources(id,kind,owner_id,group_id) VALUES('second-folder','folder','admin','g')");
 f.connections.create('admin',{id:'second',provider:'google',label:'Second',path:'/second',folderId:'second-folder',config:{root:'other-root'}});
 assert.deepEqual(googleManagedRecipients(f.db,'second',1,'file'),['editor@example.org']);assert.deepEqual(googleManagedRecipients(f.db,'second',1,'other-file'),[]);
 f.connections.update('admin','second',{baseRevision:1,enabled:false});fails(()=>googleManagedRecipients(f.db,'second',2,'file'),'PROVIDER_CONFIG_CHANGED');
});
test('large historical recipient evidence is bounded before building a worker allowlist',async t=>{
 const f=await setup(t);importLegacyGoogleGrant(f.db,f.grant);
 const insert=f.db.prepare("INSERT INTO provider_google_grant_imports SELECT ?,connection_legacy_key,connection_id,reference,object_key,legacy_user_key,recipient,desired_role,applied_role,permission_id,status,attempted_at,source_fingerprint,created_at FROM provider_google_grant_imports WHERE legacy_key=?");
 f.db.transaction(()=>{for(let i=0;i<10000;i++)insert.run('backup-one:extra:'+i,f.grant.legacyKey);})();
 fails(()=>googleManagedRecipients(f.db,'google',1,'file'),'PROVIDER_CONFIG_CHANGED');assert.deepEqual(googleManagedRecipients(f.db,'google',1,'other'),[]);
});
