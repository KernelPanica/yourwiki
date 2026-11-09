import {test} from 'node:test';import assert from 'node:assert/strict';
import {historyFixture} from './support/history-fixture.ts';import {PasswordResets} from '../src/auth/password-reset.ts';import {verifyPassword} from '../src/auth/passwords.ts';
test('reset links are hashed, single-use, expiring, replaceable, role fenced and revoke sessions',async t=>{
 const f=await historyFixture(t);let now=Date.now();const s=new PasswordResets(f.db,()=>now),version=()=>Number((f.db.prepare("SELECT auth_version AS v FROM users WHERE id='reader'").get() as {v:number}).v);
 assert.throws(()=>s.create('reader','writer',1),/ACCESS_DENIED/);
 f.db.prepare("UPDATE users SET admin_role='simple' WHERE id='writer'").run();assert.throws(()=>s.create('writer','admin',1),/ACCESS_DENIED/);
 let link=s.create('writer','reader',version());assert(!JSON.stringify(f.db.prepare('SELECT * FROM password_reset_links').all()).includes(link.token));
 const old=link;link=s.create('admin','reader',version());await assert.rejects(s.redeem(old.token,'long-password-123','long-password-123'),/RESET_LINK_INVALID/);
 await assert.rejects(s.redeem(link.token,'long-password-123','different-password'),/PASSWORD_MISMATCH/);
 await s.redeem(link.token,'long-password-123','long-password-123');assert(await verifyPassword('long-password-123',(f.db.prepare("SELECT password_hash AS p FROM users WHERE id='reader'").get() as {p:string}).p));assert.equal((await f.app.inject({url:'/api/account',headers:f.headers('reader')})).statusCode,401);
 await assert.rejects(s.redeem(link.token,'another-password-123','another-password-123'),/RESET_LINK_INVALID/);
 link=s.create('admin','reader',version());now=link.expiresAt+1;await assert.rejects(s.redeem(link.token,'long-password-456','long-password-456'),/RESET_LINK_INVALID/);now=Date.now();
 link=s.create('writer','reader',version());f.db.prepare("UPDATE users SET admin_role='member',auth_version=auth_version+1 WHERE id='writer'").run();await assert.rejects(s.redeem(link.token,'long-password-456','long-password-456'),/RESET_LINK_INVALID/);
 link=s.create('admin','reader',version());f.db.prepare("UPDATE users SET active=0 WHERE id='reader'").run();await assert.rejects(s.redeem(link.token,'long-password-456','long-password-456'),/RESET_LINK_INVALID/);
});
test('reset HTTP enforces origin, CSRF, expiry and rate limits without needing a session to redeem',async t=>{
 const f=await historyFixture(t),base='/api/admin/users/reader/password-reset';
 assert.equal((await f.app.inject({method:'POST',url:base,headers:f.headers('reader'),payload:{baseRevision:1}})).statusCode,403);
 assert.equal((await f.app.inject({method:'POST',url:base,headers:{...f.headers('admin'),'x-csrf-token':'wrong'},payload:{baseRevision:1}})).statusCode,403);
 const r=await f.app.inject({method:'POST',url:base,headers:f.headers('admin'),payload:{baseRevision:1}});assert.equal(r.statusCode,200,r.body);const token=r.json().token;
 const payload={token,password:'new-password-123',passwordConfirmation:'new-password-123'};
 assert.equal((await f.app.inject({method:'POST',url:'/api/auth/reset-password',headers:{origin:'https://attacker.test'},payload})).statusCode,403);
 const accepted=await f.app.inject({method:'POST',url:'/api/auth/reset-password',headers:{origin:'https://wiki.test'},payload});assert.equal(accepted.statusCode,200,accepted.body);
 assert.equal((await f.app.inject({method:'POST',url:'/api/auth/reset-password',headers:{origin:'https://wiki.test'},payload})).statusCode,400);
 for(let i=0;i<22;i++)await f.app.inject({method:'POST',url:'/api/auth/reset-password',headers:{origin:'https://wiki.test'},payload:{...payload,token:'a'.repeat(43)}});
 assert.equal((await f.app.inject({method:'POST',url:'/api/auth/reset-password',headers:{origin:'https://wiki.test'},payload})).statusCode,429);
});
test('schema 65 upgrades to reset links without changing accounts, files, permissions or prior migration checksums',async t=>{
 const f=await historyFixture(t),tables=['users','resources','documents','document_versions'],before=Object.fromEntries(tables.map(table=>[table,f.db.prepare('SELECT * FROM '+table).all()])),checksums=f.db.prepare('SELECT * FROM schema_migrations WHERE version<=65').all(),{removeGoogleTablesFrom}=await import('./support/google-stage-schema.ts');
 removeGoogleTablesFrom(f.db,66);const {openDatabase}=await import('../src/database.ts'),{migrations}=await import('../src/schema.ts'),upgraded=openDatabase(f.path);try{assert.equal((upgraded.prepare('SELECT max(version) AS v FROM schema_migrations').get() as {v:number}).v,migrations.length);assert.deepEqual(upgraded.prepare('SELECT * FROM schema_migrations WHERE version<=65').all(),checksums);for(const table of tables)assert.deepEqual(upgraded.prepare('SELECT * FROM '+table).all(),before[table]);assert.deepEqual(upgraded.pragma('foreign_key_check'),[]);}finally{upgraded.close();}
});
test('simultaneous redemption commits once and cannot overwrite the winning password',async t=>{
 const f=await historyFixture(t),s=new PasswordResets(f.db),link=s.create('admin','reader',1),outcomes=await Promise.allSettled([s.redeem(link.token,'first-password-123','first-password-123'),s.redeem(link.token,'second-password-123','second-password-123')]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);const hash=(f.db.prepare("SELECT password_hash AS p FROM users WHERE id='reader'").get() as {p:string}).p;const matches=await Promise.all(['first-password-123','second-password-123'].map(p=>verifyPassword(p,hash)));assert.equal(matches.filter(Boolean).length,1);
});
