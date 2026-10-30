import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfficeBridge} from '../src/office-bridge.ts';
function fixture(write=true,exportAllowed=true){const sent:any[]=[];const target={postMessage:(data:string,origin:string)=>sent.push({message:JSON.parse(data),origin})};const bridge=new OfficeBridge({origin:'https://wiki.example',frame:target,write,exportAllowed,exportFormat:'docx'});const receive=(MessageId:string,Values:any={})=>bridge.receive({source:target,origin:'https://wiki.example',data:JSON.stringify({MessageId,Values})});return {bridge,target,sent,receive};}
test('only messages from the configured frame and exact origin can advance readiness',()=>{
 const f=fixture();assert.equal(f.bridge.receive({source:{},origin:'https://wiki.example',data:{MessageId:'App_LoadingStatus',Values:{Status:'Document_Loaded'}}}),false);assert.equal(f.bridge.receive({source:f.target,origin:'https://evil.example',data:{MessageId:'App_LoadingStatus',Values:{Status:'Document_Loaded'}}}),false);assert.equal(f.bridge.snapshot().phase,'loading');
 f.receive('App_LoadingStatus',{Status:'Frame_Ready'});assert.equal(f.sent[0].message.MessageId,'Host_PostmessageReady');assert.equal(f.sent[0].origin,'https://wiki.example');f.receive('App_LoadingStatus',{Status:'Document_Loaded'});assert.equal(f.bridge.snapshot().phase,'ready');
});
test('modified false is not a durable save acknowledgement and cannot clear the leave guard',()=>{
 const f=fixture();f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.receive('Doc_ModifiedStatus',{Modified:true});assert.equal(f.bridge.snapshot().needsRecovery,true);f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.snapshot().needsRecovery,true);assert.equal(f.bridge.snapshot().engineModified,false);
 f.receive('Action_Save_Resp',{success:true});assert.equal(f.bridge.snapshot().needsRecovery,true);
});
test('a conflict is sticky and neither readiness nor modified status can hide it',()=>{
 const f=fixture();f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.bridge.status({changed:true,expired:false,write:true,export:true,errorCode:'CONFLICT'});f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.snapshot().phase,'conflict');assert.equal(f.bridge.snapshot().needsRecovery,true);
});
test('export revocation is enforced before outbound export and cannot be restored by stale status',()=>{
 const f=fixture();f.receive('App_LoadingStatus',{Status:'Document_Loaded'});assert.equal(f.bridge.exportCurrent(),true);f.bridge.status({changed:false,expired:false,write:true,export:false,errorCode:null});assert.equal(f.bridge.exportCurrent(),false);f.bridge.status({changed:false,expired:false,write:true,export:true,errorCode:null});assert.equal(f.bridge.exportCurrent(),false);assert.equal(f.sent.filter(item=>item.message.MessageId==='Action_Export').length,1);
});
test('authentication pause fences outbound actions while retaining a dirty editor for recovery',()=>{
 const f=fixture();f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.receive('Doc_ModifiedStatus',{Modified:true});f.bridge.pause('SESSION_REQUIRED');assert.equal(f.bridge.exportCurrent(),false);f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.snapshot().needsRecovery,true);assert.equal(f.bridge.snapshot().phase,'paused');
});
test('close requests expose a leave intent and never send a save or close command',()=>{
 const f=fixture();f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.receive('Doc_ModifiedStatus',{Modified:true});f.receive('UI_Close');assert.equal(f.bridge.snapshot().leaveRequested,true);assert.equal(f.sent.some(item=>['Action_Save','Action_Close'].includes(item.message.MessageId)),false);f.bridge.dispose();assert.equal(f.receive('UI_Close'),false);
});
test('invalid and excessive protocol payloads cannot affect state',()=>{
 const f=fixture();for(const data of ['not json','x'.repeat(65537),null,[],{MessageId:'Doc_ModifiedStatus',Values:{Modified:'true'}},{MessageId:'App_LoadingStatus',Values:{Status:{toString:'invalid'}}}])assert.equal(f.bridge.receive({source:f.target,origin:'https://wiki.example',data}),false);assert.equal(f.bridge.snapshot().needsRecovery,false);
});
test('readonly clients cannot become dirty or export when their original capability forbids it',()=>{
 const f=fixture(false,false);f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.receive('Doc_ModifiedStatus',{Modified:true});assert.equal(f.bridge.snapshot().needsRecovery,false);assert.equal(f.bridge.exportCurrent(),false);f.bridge.status({changed:false,expired:false,write:true,export:true,errorCode:null});assert.equal(f.bridge.snapshot().write,false);
});

const intent=(letter='a')=>({tag:'yourwiki-save-'+letter.repeat(32),baseRevision:1,expiresAt:Date.now()+60000});
const proof=(tag:string,revision=2)=>({tag,state:'saved',operationId:'operation-1234',revision,currentRevision:revision,changed:false,expired:false,errorCode:null,delivery:'local',providerDelivery:'not_attempted'});
function dirty(){const f=fixture();f.receive('App_LoadingStatus',{Status:'Document_Loaded'});f.receive('Doc_ModifiedStatus',{Modified:true});return f;}
test('a registered save intent is sent as ExtendedData and only its durable receipt clears recovery',()=>{
 const f=dirty(),issued=intent();assert.ok(f.bridge.beginSave(issued));assert.equal(f.sent.at(-1).message.MessageId,'Action_Save');assert.equal(f.sent.at(-1).message.Values.ExtendedData,issued.tag);f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.acceptProof(proof(issued.tag)),'saved');assert.equal(f.bridge.snapshot().needsRecovery,false);assert.equal(f.bridge.snapshot().phase,'saved');
});
test('an acknowledgement cannot hide edits that arrived while saving',()=>{
 const f=dirty(),issued=intent();f.bridge.beginSave(issued);f.receive('Doc_ModifiedStatus',{Modified:true});f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.acceptProof(proof(issued.tag)),'superseded');assert.equal(f.bridge.snapshot().needsRecovery,true);assert.equal(f.bridge.snapshot().saving,false);
});
test('a receipt waits for engine clean state and still preserves intervening new edits',()=>{
 const f=dirty(),issued=intent();f.bridge.beginSave(issued);assert.equal(f.bridge.acceptProof(proof(issued.tag)),'pending');assert.equal(f.bridge.snapshot().needsRecovery,true);f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.snapshot().needsRecovery,false);
 const g=dirty(),second=intent('b');g.bridge.beginSave(second);g.bridge.acceptProof(proof(second.tag));g.receive('Doc_ModifiedStatus',{Modified:true});g.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(g.bridge.snapshot().needsRecovery,true);
});
test('foreign, malformed and provider-only receipts cannot acknowledge local changes',()=>{
 const f=dirty(),issued=intent();f.bridge.beginSave(issued);f.receive('Doc_ModifiedStatus',{Modified:false});for(const value of [proof(intent('z').tag),{...proof(issued.tag),delivery:'provider'},{...proof(issued.tag),revision:0},{...proof(issued.tag),currentRevision:1},{...proof(issued.tag),state:{toString:'bad'}}])assert.equal(f.bridge.acceptProof(value),'invalid');assert.equal(f.bridge.snapshot().needsRecovery,true);
});
test('conflict, session pause and disposal fence late proof and further saves',()=>{
 for(const mode of ['conflict','pause','dispose']){const f=dirty(),issued=intent();f.bridge.beginSave(issued);f.receive('Doc_ModifiedStatus',{Modified:false});if(mode==='pause')f.bridge.pause('SESSION_REQUIRED');else if(mode==='dispose')f.bridge.dispose();else f.bridge.status({changed:true,expired:false,write:true,export:true,errorCode:'CONFLICT'});assert.notEqual(f.bridge.acceptProof(proof(issued.tag)),'saved');assert.equal(f.bridge.snapshot().needsRecovery,true);assert.equal(f.bridge.beginSave(intent('b')),null);}
});
test('an uncertain save retains its ticket for read-only status checks instead of permitting a blind replay',()=>{
 const f=dirty(),issued=intent();f.bridge.beginSave(issued);f.bridge.saveFailed('NETWORK_ERROR');assert.equal(f.bridge.snapshot().needsRecovery,true);assert.equal(f.bridge.pendingSave()?.tag,issued.tag);assert.equal(f.bridge.beginSave(intent('b')),null);f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.acceptProof(proof(issued.tag)),'saved');
});
test('a later server revision and a failed operation retain recovery instead of claiming the current editor is saved',()=>{
 const f=dirty(),issued=intent();f.bridge.beginSave(issued);f.receive('Doc_ModifiedStatus',{Modified:false});assert.equal(f.bridge.acceptProof({...proof(issued.tag),currentRevision:3}),'superseded');assert.equal(f.bridge.snapshot().needsRecovery,true);
 const g=dirty();g.bridge.beginSave(issued);assert.equal(g.bridge.acceptProof({...proof(issued.tag),state:'failed',revision:null,errorCode:'CONFLICT'}),'failed');assert.equal(g.bridge.snapshot().phase,'conflict');assert.equal(g.bridge.snapshot().needsRecovery,true);
});


test('malformed bootstrap permission values cannot enable editing or export',()=>{
 const frame={postMessage:()=>{}};for(const value of [{write:'false',exportAllowed:true},{write:true,exportAllowed:'false'}])assert.throws(()=>new OfficeBridge({origin:'https://wiki.example',frame,exportFormat:'docx',...value} as any),/INVALID_OFFICE/);
});
