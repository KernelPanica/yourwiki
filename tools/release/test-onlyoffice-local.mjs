import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficeDiscovery} from '../../apps/server/src/office/discovery.ts';
import {configuredOffice} from '../../apps/server/src/release/office-config.ts';
import {OfficeBridge} from '../../apps/web/src/office-bridge.ts';
const discovery=(path,engine='onlyoffice')=>new OfficeDiscovery({engine,publicUrl:'http://127.0.0.1:8082',internalUrl:'http://onlyoffice',fetch:async()=>new Response(`<wopi-discovery><net-zone><app><action ext="docx" name="edit" urlsrc="http://untrusted${path}"/></app></net-zone></wopi-discovery>`)});
test('OnlyOffice configuration is explicit and supports internal WOPI routing',()=>{
 assert.equal(configuredOffice({}),undefined);
 assert.deepEqual(configuredOffice({YOURWIKI_OFFICE_ENGINE:'onlyoffice',ONLYOFFICE_URL:'http://127.0.0.1:8082',ONLYOFFICE_INTERNAL_URL:'http://onlyoffice',ONLYOFFICE_WOPI_URL:'http://web:3100'}),{engine:'onlyoffice',publicUrl:'http://127.0.0.1:8082',internalUrl:'http://onlyoffice',wopiUrl:'http://web:3100'});
 assert.throws(()=>configuredOffice({YOURWIKI_OFFICE_ENGINE:'other'}));
 assert.throws(()=>configuredOffice({COLLABORA_URL:'http://127.0.0.1:9980',COLLABORA_WOPI_URL:'http://web:3100'}));
});
test('OnlyOffice discovery rewrites origin and rejects unrelated paths',async()=>{
 assert.equal(await discovery('/hosting/wopi/word/edit').action('docx',true),'http://127.0.0.1:8082/hosting/wopi/word/edit');
 for(const path of ['/arbitrary','/hosting/wopi/word/evil','/hosting/wopi/word/edit/extra'])await assert.rejects(discovery(path).action('docx',true));
 await assert.rejects(discovery('/hosting/wopi/word/edit','collabora').action('docx',true));
});
test('OnlyOffice edit notifications preserve unsaved guard and validate sender',()=>{
 const messages=[],frame={postMessage:message=>messages.push(JSON.parse(message))};
 const bridge=new OfficeBridge({engine:'onlyoffice',origin:'http://127.0.0.1:8082',frame,write:true,exportAllowed:true,exportFormat:'docx'});
 const receive=(MessageId,Values={},origin='http://127.0.0.1:8082')=>bridge.receive({source:frame,origin,data:{MessageId,Values}});
 assert.equal(receive('Edit_Notification',{},'http://evil.test'),false);
 receive('App_LoadingStatus',{Status:'Document_Loaded'});receive('Edit_Notification');
 assert.equal(bridge.snapshot().needsRecovery,true);
 assert.equal(bridge.snapshot().phase,'modified');
 assert.equal(messages.some(m=>m.MessageId==='Action_Save'),false);
});
test('standard WOPI saves without Collabora timestamps still require a live lock and preserve strict default',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {openDatabase}=await import('../../apps/server/src/database.ts'),{BlobStore}=await import('../../apps/server/src/storage/blobs.ts'),{DocumentService}=await import('../../apps/server/src/documents.ts');
 const {createSession}=await import('../../apps/server/src/auth/sessions.ts'),{OfficeSessions}=await import('../../apps/server/src/office/sessions.ts'),{OfficeIngress}=await import('../../apps/server/src/office/ingress.ts'),{OfficeSaves}=await import('../../apps/server/src/office/saves.ts');
 const root=await mkdtemp(join(tmpdir(),'wiki-onlyoffice-')),db=openDatabase(':memory:');let ingress;
 t.after(async()=>{await ingress?.close();db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash) VALUES('u','u','User','!');INSERT INTO groups(id,name) VALUES('g','Group');INSERT INTO memberships VALUES('u','g')");
 const bytes=async function*(text){yield Buffer.from(text);},store=await BlobStore.open(root),docs=new DocumentService(db,store),doc=await docs.create({localOnly:true,userId:'u',title:'Test.md',format:'md',parentId:null,groupId:'g'},bytes('old'));
 const browser=createSession(db,'u'),sessions=new OfficeSessions(db),opened=sessions.open(browser.token,doc.documentId);sessions.lock(opened.sessionId,opened.token,'LOCK','live-lock');
 ingress=new OfficeIngress(db,store);const input={sessionId:opened.sessionId,token:opened.token,lock:'live-lock',declaredSize:3,lastModifiedTime:null};
 const validator={validate:async()=>{}};
 await assert.rejects(new OfficeSaves(db,store,ingress,{validator}).save(input,bytes('new')),/CONFLICT/);
 const saves=new OfficeSaves(db,store,ingress,{validator,requireTimestamp:false});
 await assert.rejects(saves.save({...input,lock:'wrong'},bytes('new')),/OFFICE_LOCK_MISMATCH/);
 const {buildApp}=await import('../../apps/server/src/app.ts');const app=buildApp({database:db,storage:store,publicUrl:'http://127.0.0.1:3010',office:{engine:'onlyoffice',publicUrl:'http://127.0.0.1:8082'}});t.after(()=>app.close());
 const lockUrl=`/wopi/files/${opened.sessionId}?access_token=${opened.token}`,lockHeaders={'content-type':'application/x-www-form-urlencoded','x-wopi-override':'REFRESH_LOCK','x-wopi-lock':'live-lock'};
 assert.equal((await app.inject({method:'POST',url:lockUrl,headers:lockHeaders,payload:''})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:lockUrl,headers:lockHeaders,payload:'unexpected'})).statusCode,400);
 const saved=await saves.save(input,bytes('new'));assert.equal(saved.receipt.revision,2);
 assert.equal(db.prepare('SELECT local_revision FROM documents WHERE id=?').get(doc.documentId).local_revision,2);
 const {readFile}=await import('node:fs/promises');
 const mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
 for(const format of Object.keys(mime)){
  const source=await readFile(new URL(`../../apps/server/src/office/templates/blank.${format}`,import.meta.url));
  const next=await docs.create({localOnly:true,userId:'u',groupId:'g',title:'Test.'+format,format,parentId:null},(async function*(){yield source;})());
  const session=sessions.open(browser.token,next.documentId);sessions.lock(session.sessionId,session.token,'LOCK','format-lock');
  const url=`/wopi/files/${session.sessionId}/contents?access_token=${session.token}`,headers={'x-wopi-override':'PUT','x-wopi-lock':'format-lock','content-type':mime[format]};
  assert.equal((await app.inject({method:'POST',url,headers:{...headers,'content-type':'image/png'},payload:source})).statusCode,415);
  const response=await app.inject({method:'POST',url,headers,payload:source});assert.equal(response.statusCode,200,response.body);
 }

});
