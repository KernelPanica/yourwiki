import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {openDatabase} from '../../apps/server/src/database.ts';
const credentials=JSON.parse(await readFile('/data/onlyoffice-reader-credentials.json','utf8')),fixture=JSON.parse(await readFile('/data/onlyoffice-reader-fixture.json','utf8'));
const base='http://web:3100',origin='http://127.0.0.1:3010';
// This helper runs only against the isolated local fixture, never a supplied URL.
assert.equal(credentials.username,'localreader');
assert.deepEqual(fixture.files.map(x=>x.format).sort(),['docx','pptx','xlsx']);
function snapshot(){const db=openDatabase('/data/workspace/database.sqlite3');try{return fixture.files.map(f=>db.prepare('SELECT * FROM documents WHERE id=?').get(f.id));}finally{db.close();}}
const before=snapshot();
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:credentials.username,password:credentials.password})});assert.equal(login.status,200);const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];assert.ok(session.csrf);
const results=[];
async function request(name,path,expected=200,method='GET',body,type='application/json',extra={}){
 const response=await fetch(base+path,{method,headers:{cookie,origin,'x-csrf-token':session.csrf,...(body===undefined?{}:{'content-type':type}),...extra},...(body===undefined?{}:{body:type==='application/json'?JSON.stringify(body):body})});
 assert.equal(response.status,expected,name);results.push({name,status:response.status});
 return response.status===204?undefined:response.json();
}
const library=await request('folder visible',`/api/library?parent=${fixture.folderId}`);assert.equal(library.canCreate,false);assert.equal(library.items.length,3);assert.ok(library.items.every(x=>!x.canWrite&&!x.canMove));
await request('admin settings unavailable','/api/admin/overview',403);
await request('folder creation denied','/api/folders',403,'POST',{name:'Forbidden reader folder',parentId:fixture.folderId});
await request('ACL mutation denied',`/api/admin/resources/${fixture.folderId}/acl`,403,'PUT',{});
for(const file of fixture.files){
 const view=await request(file.format+' view',`/api/documents/${file.id}/view`);assert.equal(view.document.capabilities.write,false);
 await request(file.format+' content write denied',`/api/documents/${file.id}/content?baseRevision=1`,403,'PUT','forbidden','application/octet-stream');
 const opened=await request(file.format+' edit request remains readonly',`/api/documents/${file.id}/office`,200,'POST',{readonly:false,language:'ru'});
 try{
  assert.equal(opened.write,false);
  const info=await request(file.format+' WOPI readonly',`/wopi/files/${opened.sessionId}?access_token=${opened.accessToken}`);assert.equal(info.UserCanWrite,false);assert.equal(info.ReadOnly,true);
  // Exercise the real vendor WOPI view action, including its signed userAuth.
  // 9.2.1 incorrectly set forcedViewMode even when view was requested (-103).
  const action=new URL(opened.actionUrl);
  assert.equal(action.origin,origin.replace(':3010',':8082'));
  assert.ok(action.pathname.endsWith('/view'));
  action.protocol='http:';action.hostname='onlyoffice';action.port='';
  const page=await fetch(action,{method:'POST',body:new URLSearchParams({access_token:opened.accessToken,access_token_ttl:String(opened.expiresAt),docs_api_config:JSON.stringify({editorConfig:{mode:'view'}})})});
  assert.equal(page.status,200,file.format+' OnlyOffice view action');
  const html=await page.text(),match=html.match(/id="userAuthJsonData"[^>]*data-json="([^"]*)"/);
  assert.ok(match,file.format+' OnlyOffice userAuth present');
  const entities={'&quot;':'"','&#34;':'"','&#39;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'};
  const decode=value=>JSON.parse(value.replace(/&(?:quot|lt|gt|amp);|&#(?:34|39);/g,key=>entities[key]));
  const auth=decode(match[1]);
  const infoMatch=html.match(/id="fileInfoJsonData"[^>]*data-json="([^"]*)"/);
  assert.ok(infoMatch,file.format+' OnlyOffice file info present');
  const loadedInfo=decode(infoMatch[1]);
  assert.equal(loadedInfo.BaseFileName,view.document.title,file.format+' OnlyOffice actually loaded file info');
  assert.equal(loadedInfo.UserCanWrite,false);assert.equal(loadedInfo.ReadOnly,true);
  assert.equal(auth.mode,'view',file.format+' OnlyOffice view mode');
  assert.equal(auth.forcedViewMode,false,file.format+' must not emit forced-view warning -103');
  results.push({name:file.format+' OnlyOffice view without -103',passed:true});
  await request(file.format+' WOPI write denied',`/wopi/files/${opened.sessionId}/contents?access_token=${opened.accessToken}`,403,'POST','forbidden','application/octet-stream',{'x-wopi-override':'PUT','x-wopi-lock':'forged'});
 }finally{
  await request(file.format+' session released',`/api/office/${opened.sessionId}/release`,204,'POST',{accessToken:opened.accessToken});
 }
}
assert.deepEqual(snapshot(),before,'fixture documents must remain unchanged');
results.push({name:'fixture documents unchanged',passed:true});
await writeFile('/data/onlyoffice-reader-checks.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n',{mode:0o600});console.log(JSON.stringify(results,null,2));
