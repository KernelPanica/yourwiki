// Creates only the explicitly isolated local test volume. Never accepts an external data path.
import {bootstrap} from '../../apps/server/src/release/workspace.ts';
import {openDatabase} from '../../apps/server/src/database.ts';
import {BlobStore} from '../../apps/server/src/storage/blobs.ts';
import {DocumentService} from '../../apps/server/src/documents.ts';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
const root='/data',credentials=root+'/onlyoffice-local-credentials.json';
let existing=false;try{await stat(root+'/workspace/database.sqlite3');existing=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(!existing){
 const password=randomBytes(18).toString('base64url');
 await bootstrap(root,{username:'localadmin',displayName:'Локальный администратор',password,publicUrl:'http://127.0.0.1:3010'});
 await writeFile(credentials,JSON.stringify({url:'http://127.0.0.1:3010',username:'localadmin',password})+'\n',{mode:0o600,flag:'wx'});
}
await stat(credentials); // Never reset an existing account or overwrite its credentials.
const db=openDatabase(root+'/workspace/database.sqlite3');
try{
 const user=db.prepare('SELECT u.id,m.group_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.username=?').get('localadmin'),store=await BlobStore.open(root+'/workspace/storage'),docs=new DocumentService(db,store);
 for(const format of ['docx','xlsx','pptx']){
  if(db.prepare('SELECT 1 FROM documents WHERE title=?').get(`OnlyOffice тест.${format}`))continue;
  const bytes=await readFile(new URL(`../../apps/server/src/office/templates/blank.${format}`,import.meta.url));
  await docs.create({localOnly:true,userId:user.id,groupId:user.group_id,parentId:null,title:`OnlyOffice тест.${format}`,format},(async function*(){yield bytes;})());
 }
 console.log('Local test workspace initialized (DOCX, XLSX, PPTX).');
}finally{db.close();}
