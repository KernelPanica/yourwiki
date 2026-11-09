import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoogleSettingsClient,parseGoogleConnections,parseGoogleAuthorization} from '../src/google-settings.ts';
import {ApiError} from '../src/api.ts';
import {resumeSession,blockSession} from '../src/session-fence.ts';
const item={id:'google',label:'Central',path:'/',revision:1,enabled:true,configurationReady:true,authorizationStored:false},page={items:[item],nextCursor:null};
function authorization(){return {authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:'owned',redirect_uri:'https://wiki.test/api/admin/google/oauth/callback',response_type:'code',scope:'https://www.googleapis.com/auth/drive',access_type:'offline',prompt:'consent',state:'S'.repeat(43),code_challenge:'C'.repeat(43),code_challenge_method:'S256'}),expiresAt:Date.now()+600000};}
function setup(t:any,request:(url:string,init?:RequestInit)=>Promise<unknown>,navigate:(url:string)=>void|Promise<void>=()=>{}){resumeSession();const client=new GoogleSettingsClient({csrf:'csrf',origin:'https://wiki.test',request,navigate});t.after(()=>client.dispose());return client;}
test('metadata is copied and authorization only starts after explicit action with current revision/CSRF',async t=>{
 const calls:any[]=[],navigations:string[]=[],client=setup(t,async(url,init)=>{calls.push({url,init});return init?.method==='POST'?authorization():page;},url=>{navigations.push(url);});await client.load();assert.equal(calls.length,1);const copy=client.snapshot();copy.items[0]!.revision=99;await client.connect('google');assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[1].init.body),{connectionId:'google',baseRevision:1});assert.equal(calls[1].init.headers['x-csrf-token'],'csrf');assert.equal(navigations.length,1);assert.match(navigations[0]!,/^https:\/\/accounts.google.com\//);
});
test('malformed metadata and unsafe authorization destinations never redirect the browser',async t=>{
 assert.throws(()=>parseGoogleConnections({items:[{...item,revision:'1'}],nextCursor:null}));for(const patch of [{authorizationUrl:'https://evil.invalid/'},{authorizationUrl:authorization().authorizationUrl+'&client_secret=PRIVATE'},{authorizationUrl:authorization().authorizationUrl.replace('wiki.test','other.test')}])assert.throws(()=>parseGoogleAuthorization({...authorization(),...patch},'https://wiki.test'));let navigations=0;const client=setup(t,async(_url,init)=>init?.method==='POST'?{authorizationUrl:'javascript:alert(1)',expiresAt:1}:page,()=>{navigations++;});await client.load();await client.connect('google');assert.equal(navigations,0);assert.equal(client.snapshot().phase,'unknown');
});
test('lost start response never automatically repeats a POST and reload is read-only',async t=>{
 let posts=0;const client=setup(t,async(_url,init)=>{if(init?.method==='POST'){posts++;throw new Error('lost ack');}return page;});await client.load();await client.connect('google');assert.equal(client.snapshot().phase,'unknown');await client.load();assert.equal(posts,1);assert.equal(client.snapshot().phase,'ready');
});
test('session revocation fences a late consent URL and clears stale metadata',async t=>{
 let release!:(value:unknown)=>void,navigations=0;const pending=new Promise<unknown>(r=>release=r),client=setup(t,async(_url,init)=>init?.method==='POST'?pending:page,()=>{navigations++;});await client.load();const starting=client.connect('google');blockSession();release(authorization());await starting;assert.equal(navigations,0);assert.deepEqual(client.snapshot().items,[]);resumeSession();assert.deepEqual(client.snapshot().items,[]);
});
test('disabled connections can request explicit reconnection; permission denial clears the list',async t=>{
 let posts=0,denied=false;const client=setup(t,async(_url,init)=>{if(denied)throw new ApiError('ACCESS_DENIED');if(init?.method==='POST')posts++;return {items:[{...item,enabled:false}],nextCursor:null};});await client.load();await client.connect('google');assert.equal(posts,1);denied=true;await client.load();assert.deepEqual(client.snapshot().items,[]);
});
test('configuration sends secrets only in one explicit CSRF POST and stores only safe metadata',async t=>{
 const calls:any[]=[],client=setup(t,async(url,init)=>{calls.push({url,init});return init?.method==='POST'?item:page;});await client.load();const configured=await client.configure({id:'google',label:'Central',path:'/',folderId:null,root:'rootId',clientId:'owned',clientSecret:'PRIVATE'});assert.equal(configured,true);assert.equal(calls.length,2);assert.equal(calls[1].url,'/api/admin/google/connections');assert.equal(calls[1].init.headers['x-csrf-token'],'csrf');assert.equal(JSON.parse(calls[1].init.body).clientSecret,'PRIVATE');assert.doesNotMatch(JSON.stringify(client.snapshot()),/PRIVATE|rootId|clientSecret/);assert.equal(client.snapshot().phase,'ready');
});
test('unknown configuration acknowledgement never repeats a write and a late result cannot repopulate another session',async t=>{
 let posts=0,release!:(value:unknown)=>void;const pending=new Promise<unknown>(r=>release=r),client=setup(t,async(_url,init)=>{if(init?.method==='POST'){posts++;return pending;}return page;});await client.load();const saving=client.configure({id:'google',label:'Central',path:'/',folderId:null,root:'rootId',clientId:'owned',clientSecret:'PRIVATE'});blockSession();release(item);assert.equal(await saving,false);assert.equal(posts,1);assert.deepEqual(client.snapshot().items,[]);
});

test('lost configuration reply requires read-only refresh and never automatically repeats its secret POST',async t=>{let posts=0;const client=setup(t,async(_url,init)=>{if(init?.method==='POST'){posts++;throw new Error('lost');}return page;});await client.load();assert.equal(await client.configure({id:'google',label:'Central',path:'/',folderId:null,root:'rootId',clientId:'owned',clientSecret:'PRIVATE'}),false);assert.equal(client.snapshot().phase,'unknown');await client.load();assert.equal(posts,1);assert.equal(client.snapshot().phase,'ready');assert.doesNotMatch(JSON.stringify(client.snapshot()),/PRIVATE/);});
