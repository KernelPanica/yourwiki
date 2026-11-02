import { AccessService } from './access.ts';
import type { Database } from './database.ts';
import { authenticateSession } from './auth/sessions.ts';
export type ChangeSignal = {type:'access'|'session-expired'|'heartbeat'}|{type:'documents';documentIds:string[]};
type Listener={token:string;userId:string;epoch:number;since:number;lastSent:number;send:(event:ChangeSignal)=>boolean;close:()=>void};
/** Shared, bounded local polling. Signals confer no access and contain no document payload. */
export class ChangeFeed {
 private db:Database;private access:AccessService;private listeners=new Set<Listener>();private timer:ReturnType<typeof setInterval>|undefined;
 private cursor=0;private closed=false;private pollMs:number;private maxPerUser:number;private maxConnections:number;private clock:()=>number;
 constructor(db:Database,options:{pollMs?:number;maxPerUser?:number;maxConnections?:number;clock?:()=>number}={}){
  this.db=db;this.access=new AccessService(db);this.pollMs=options.pollMs??250;this.maxPerUser=options.maxPerUser??4;this.maxConnections=options.maxConnections??128;this.clock=options.clock??Date.now;
  if(!Number.isSafeInteger(this.pollMs)||this.pollMs<20||this.pollMs>60_000||![this.maxPerUser,this.maxConnections].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1024))throw new Error('Invalid change feed limits');
 }
 private snapshot(){return this.db.prepare('SELECT acl_epoch AS epoch,(SELECT COALESCE(MAX(id),0) FROM events) AS last FROM app_state WHERE id=1').get() as {epoch:number;last:number};}
 subscribe(token:string,send:Listener['send'],close:()=>void){
  if(this.closed)throw new Error('NOT_READY');
  const actor=authenticateSession(this.db,token,this.clock());if(!actor)throw new Error('SESSION_REQUIRED');
  if(this.listeners.size>=this.maxConnections||[...this.listeners].filter(item=>item.userId===actor.userId).length>=this.maxPerUser)throw new Error('CONNECTION_LIMIT');
  const state=this.snapshot();if(!this.listeners.size)this.cursor=state.last;
  const listener:Listener={token,userId:actor.userId,epoch:state.epoch,since:state.last,lastSent:this.clock(),send,close};this.listeners.add(listener);
  if(!this.timer){this.timer=setInterval(()=>this.tick(),this.pollMs);this.timer.unref();}
  return ()=>this.remove(listener,false);
 }
 private remove(listener:Listener,end:boolean){
  if(!this.listeners.delete(listener))return;
  if(!this.listeners.size){clearInterval(this.timer);this.timer=undefined;}
  if(end){try{listener.close();}catch{/* Teardown must not retain a connection. */}}
 }
 private deliver(listener:Listener,event:ChangeSignal){
  try{if(listener.send(event)){listener.lastSent=this.clock();return;} }catch{/* Broken stream. */}
  this.remove(listener,true);
 }
 tick(){
  if(this.closed||!this.listeners.size||this.db.inTransaction)return;
  try{
   const state=this.snapshot(),reset=state.last<this.cursor;
   if(reset)this.cursor=state.last;
   const rows=state.last>this.cursor?this.db.prepare('SELECT id,document_id FROM events WHERE id>? ORDER BY id LIMIT 256').all(this.cursor) as {id:number;document_id:string}[]:[];
   const through=rows.at(-1)?.id??this.cursor;
   for(const listener of [...this.listeners]){
    if(!authenticateSession(this.db,listener.token,this.clock())){this.deliver(listener,{type:'session-expired'});this.remove(listener,true);continue;}
    if(state.epoch!==listener.epoch){listener.epoch=state.epoch;this.deliver(listener,{type:'access'});}
    if(!this.listeners.has(listener))continue;
    const ids=new Set<string>();let overflow=false;
    for(const row of rows)if(row.id>listener.since&&this.access.allows(listener.userId,row.document_id,'read')){
     if(ids.size<16)ids.add(row.document_id);else if(!ids.has(row.document_id))overflow=true;
    }
    listener.since=reset?state.last:Math.max(listener.since,through);
    if(reset||ids.size)this.deliver(listener,{type:'documents',documentIds:overflow||reset?[]:[...ids]});
    if(this.listeners.has(listener)&&this.clock()-listener.lastSent>=15_000)this.deliver(listener,{type:'heartbeat'});
   }
   this.cursor=through;
  }catch{for(const listener of [...this.listeners])this.remove(listener,true);}
 }
 close(){if(this.closed)return;this.closed=true;for(const listener of [...this.listeners])this.remove(listener,true);clearInterval(this.timer);this.timer=undefined;}
}
