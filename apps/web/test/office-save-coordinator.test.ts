import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfficeBridge} from '../src/office-bridge.ts';
import {OfficeSaveCoordinator} from '../src/office-save-coordinator.ts';
import {blockSession,resumeSession} from '../src/session-fence.ts';
const tag='yourwiki-save-'+'a'.repeat(32),issued={tag,expiresAt:Date.now()+60000,baseRevision:1};
const proof={tag,state:'saved',operationId:'operation-1234',revision:2,currentRevision:2,changed:false,expired:false,errorCode:null,delivery:'local'};
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return {promise,resolve};}
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>,autoSave=false,ackWaitMs=60000){resumeSession();const sent:any[]=[],frame={postMessage:(data:string)=>sent.push(JSON.parse(data))},bridge=new OfficeBridge({origin:'https://wiki.example',frame,write:true,exportAllowed:true,exportFormat:'docx'}),receive=(MessageId:string,Values:any={})=>bridge.receive({source:frame,origin:'https://wiki.example',data:{MessageId,Values}});receive('App_LoadingStatus',{Status:'Document_Loaded'});const coordinator=new OfficeSaveCoordinator({bridge,sessionId:'room',accessToken:'a'.repeat(43),csrf:'csrf',request,autoSave,debounceMs:10,pollMs:10,ackWaitMs});t.after(()=>coordinator.dispose());return {bridge,coordinator,sent,receive};}
async function waitFor(predicate:()=>boolean){const deadline=Date.now()+1000;while(!predicate()){if(Date.now()>deadline)throw new Error('state did not settle');await new Promise(resolve=>setTimeout(resolve,5));}}
test('save requests use CSRF and a server intent; matched proof clears only a clean engine',async t=>{
 const calls:{url:string;init?:RequestInit}[]=[];let f:any;f=setup(t,async(url,init)=>{calls.push({url,init});if(init?.method==='POST')return issued;f.receive('Doc_ModifiedStatus',{Modified:false});return proof;});f.receive('Doc_ModifiedStatus',{Modified:true});await f.coordinator.saveNow();assert.equal(calls.length,2);assert.equal((calls[0].init!.headers as any)['x-csrf-token'],'csrf');assert.equal(f.sent.filter((item:any)=>item.MessageId==='Action_Save').length,1);assert.equal(f.bridge.snapshot().needsRecovery,false);
});
test('an intent response arriving after an account change cannot send a save into the iframe',async t=>{
 const pending=deferred(),f=setup(t,()=>pending.promise);f.receive('Doc_ModifiedStatus',{Modified:true});const saving=f.coordinator.saveNow();blockSession();pending.resolve(issued);await saving;assert.equal(f.sent.some(item=>item.MessageId==='Action_Save'),false);assert.equal(f.bridge.snapshot().phase,'paused');assert.equal(f.bridge.snapshot().needsRecovery,true);
});
test('a lost status reply is checked with GET, never by another write or intent',async t=>{
 const calls:string[]=[];let reads=0;const f=setup(t,async(_url,init)=>{calls.push(init?.method??'GET');if(init?.method==='POST')return issued;if(++reads===1)throw new Error('connection lost');return proof;});f.receive('Doc_ModifiedStatus',{Modified:true});await f.coordinator.saveNow();assert.equal(f.bridge.snapshot().needsRecovery,true);f.receive('Doc_ModifiedStatus',{Modified:false});await f.coordinator.checkNow();assert.equal(calls.filter(method=>method==='POST').length,1);assert.equal(f.sent.filter(item=>item.MessageId==='Action_Save').length,1);assert.equal(f.bridge.snapshot().needsRecovery,false);
});
test('new edits during save remain guarded after an older receipt',async t=>{
 const status=deferred(),f=setup(t,async(_url,init)=>init?.method==='POST'?issued:status.promise);f.receive('Doc_ModifiedStatus',{Modified:true});const saving=f.coordinator.saveNow();await waitFor(()=>f.sent.some(item=>item.MessageId==='Action_Save'));f.receive('Doc_ModifiedStatus',{Modified:true});f.receive('Doc_ModifiedStatus',{Modified:false});status.resolve(proof);await saving;assert.equal(f.bridge.snapshot().needsRecovery,true);assert.equal(f.bridge.snapshot().saving,false);
});
test('debounce coalesces changes and disposal never starts a save on leave',async t=>{
 let posts=0;const f=setup(t,async(_url,init)=>{if(init?.method==='POST'){posts++;return issued;}return {...proof,state:'pending',revision:null,operationId:null};},true);for(let i=0;i<5;i++)f.receive('Doc_ModifiedStatus',{Modified:true});await waitFor(()=>posts===1);f.coordinator.dispose();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(posts,1);assert.equal(f.sent.filter(item=>item.MessageId==='Action_Save').length,1);
});
test('disposal fences late proof and no concurrent poll can acknowledge it afterwards',async t=>{
 const status=deferred();let reads=0;const f=setup(t,async(_url,init)=>{if(init?.method==='POST')return issued;reads++;return status.promise;});f.receive('Doc_ModifiedStatus',{Modified:true});const saving=f.coordinator.saveNow();await waitFor(()=>reads===1);await f.coordinator.checkNow();assert.equal(reads,1);f.coordinator.dispose();f.receive('Doc_ModifiedStatus',{Modified:false});status.resolve(proof);await saving;assert.equal(f.bridge.snapshot().needsRecovery,true);
});

test('an acknowledgement timeout stops automatic polls and retains the ticket for an explicit later check',async t=>{
 let reads=0,done=false;const f=setup(t,async(_url,init)=>{if(init?.method==='POST')return issued;reads++;return done?proof:{...proof,state:'pending',revision:null,operationId:null};},false,20);f.receive('Doc_ModifiedStatus',{Modified:true});await f.coordinator.saveNow();await waitFor(()=>f.bridge.snapshot().phase==='failed');const stopped=reads;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(reads,stopped);assert.equal(f.bridge.pendingSave()?.tag,tag);done=true;f.receive('Doc_ModifiedStatus',{Modified:false});await f.coordinator.checkNow();assert.equal(f.bridge.snapshot().needsRecovery,false);
});
