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
