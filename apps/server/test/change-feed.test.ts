import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/database.ts';
import { createSession } from '../src/auth/sessions.ts';
import { ChangeFeed } from '../src/change-feed.ts';
function fixture(t:any){
 const db=openDatabase(':memory:');db.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES('a','a','A','!'),('b','b','B','!'); INSERT INTO groups(id,name) VALUES('g','G'); INSERT INTO memberships VALUES('a','g'); INSERT INTO resources(id,kind,owner_id,group_id) VALUES('doc','document','a','g');`);
 const sessions={a:createSession(db,'a'),b:createSession(db,'b')};
 const feed=new ChangeFeed(db,{pollMs:60_000});t.after(()=>{feed.close();db.close();});
 return {db,feed,sessions};
}
test('change feed sends identifiers only for currently readable document events',t=>{
 const {db,feed,sessions}=fixture(t),a:any[]=[],b:any[]=[];
 feed.subscribe(sessions.a.token,event=>{a.push(event);return true;},()=>{});
 feed.subscribe(sessions.b.token,event=>{b.push(event);return true;},()=>{});
 db.prepare('INSERT INTO events(kind,document_id,payload,created_at) VALUES(?,?,?,?)').run('pdf.layer.saved','doc',JSON.stringify({private:'secret'}),Date.now());feed.tick();
 assert.deepEqual(a,[{type:'documents',documentIds:['doc']}]);assert.deepEqual(b,[]);
 assert.ok(!JSON.stringify(a).includes('secret'));
 db.prepare('UPDATE resources SET inherit_permissions=0,user_policies=? WHERE id=?').run(JSON.stringify({a:{read:false}}),'doc');
 db.prepare('INSERT INTO events(kind,document_id,payload,created_at) VALUES(?,?,?,?)').run('preview.ready','doc','{}',Date.now());feed.tick();
 assert.deepEqual(a.at(-1),{type:'access'});assert.deepEqual(b.at(-1),{type:'access'});
 assert.equal(a.filter(event=>event.type==='documents').length,1);
});
test('expired/revoked sessions close promptly without further document delivery',t=>{
 const {db,feed,sessions}=fixture(t),events:any[]=[];let closed=0;
 feed.subscribe(sessions.a.token,event=>{events.push(event);return true;},()=>closed++);
 db.exec("UPDATE users SET active=0 WHERE id='a'");feed.tick();feed.tick();
 assert.deepEqual(events,[{type:'session-expired'}]);assert.equal(closed,1);
});
test('feed bounds connections and releases a slow reader without retaining its slot',t=>{
 const {db,sessions}=fixture(t);const feed=new ChangeFeed(db,{pollMs:60_000,maxPerUser:1,maxConnections:1});t.after(()=>feed.close());
 let closed=0;feed.subscribe(sessions.a.token,()=>false,()=>closed++);
 assert.throws(()=>feed.subscribe(sessions.a.token,()=>true,()=>{}),/CONNECTION_LIMIT/);
 db.exec("UPDATE groups SET name='Changed' WHERE id='g'");feed.tick();assert.equal(closed,1);
 const stop=feed.subscribe(sessions.a.token,()=>true,()=>{});stop();
 const next=feed.subscribe(sessions.a.token,()=>true,()=>{});next();
});
test('a transient database read failure disconnects listeners but permits a fresh connection after recovery',t=>{
 const {db,sessions}=fixture(t);let fail=false,closed=0;
 const flaky=new Proxy(db,{get(target,key){const value=Reflect.get(target,key,target);if(key==='prepare')return (...args:any[])=>{if(fail)throw new Error('Temporary read failure');return value.apply(target,args);};return typeof value==='function'?value.bind(target):value;}});
 const feed=new ChangeFeed(flaky,{pollMs:60_000});t.after(()=>feed.close());feed.subscribe(sessions.a.token,()=>true,()=>closed++);
 fail=true;feed.tick();assert.equal(closed,1);fail=false;
 const events:any[]=[];const stop=feed.subscribe(sessions.a.token,event=>{events.push(event);return true;},()=>{});
 db.exec("UPDATE groups SET name='Recovered' WHERE id='g'");feed.tick();assert.deepEqual(events,[{type:'access'}]);stop();
});
test('large backlogs are processed in bounded batches and a new subscriber does not replay old events',t=>{
 const {db,feed,sessions}=fixture(t),first:any[]=[],later:any[]=[];
 feed.subscribe(sessions.a.token,event=>{first.push(event);return true;},()=>{});
 const insert=db.prepare('INSERT INTO events(kind,document_id,payload,created_at) VALUES(?,?,?,?)');
 for(let i=0;i<300;i++)insert.run('preview.ready','doc','{}',Date.now());
 feed.tick();assert.equal(first.length,1);
 feed.subscribe(sessions.a.token,event=>{later.push(event);return true;},()=>{});
 feed.tick();assert.equal(first.length,2);assert.deepEqual(later,[]);feed.tick();assert.equal(first.length,2);
});
test('coalesced document invalidations remain small when many visible files change',t=>{
 const {db,feed,sessions}=fixture(t);const ids=Array.from({length:20},(_,i)=>'doc'+i);
 for(const id of ids)db.prepare("INSERT INTO resources(id,kind,owner_id,group_id) VALUES(?,'document','a','g')").run(id);
 const events:any[]=[];feed.subscribe(sessions.a.token,event=>{events.push(event);return true;},()=>{});
 for(const id of ids)db.prepare('INSERT INTO events(kind,document_id,payload,created_at) VALUES(?,?,?,?)').run('preview.ready',id,'{}',Date.now());
 feed.tick();assert.deepEqual(events,[{type:'documents',documentIds:[]}]);
});
test('quiet streams stay alive but never outlive their authenticated session',t=>{
 const {db,sessions}=fixture(t);let now=Date.now();const feed=new ChangeFeed(db,{pollMs:60_000,clock:()=>now});t.after(()=>feed.close());
 const events:any[]=[];let closed=0;feed.subscribe(sessions.a.token,event=>{events.push(event);return true;},()=>closed++);
 now+=15_001;feed.tick();assert.deepEqual(events,[{type:'heartbeat'}]);
 now=sessions.a.expiresAt;feed.tick();assert.deepEqual(events.at(-1),{type:'session-expired'});assert.equal(closed,1);
});
