// Explicit test-account fixture for the isolated local OnlyOffice volume.
import {openDatabase} from '../../apps/server/src/database.ts';
import {Administration} from '../../apps/server/src/administration/service.ts';
import {DocumentService} from '../../apps/server/src/documents.ts';
import {BlobStore} from '../../apps/server/src/storage/blobs.ts';
import {randomBytes} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
const db=openDatabase('/data/workspace/database.sqlite3');
try{
 const admin=db.prepare('SELECT id FROM users WHERE username=? AND admin_role=?').get('localadmin','giga');if(!admin)throw Error('LOCAL_TEST_WORKSPACE_REQUIRED');
 const service=new Administration(db),existing=db.prepare('SELECT id FROM users WHERE username=?').get('localreader');
 if(existing){console.log('Existing localreader preserved.');process.exit(0);}
 const group=service.group(admin.id,undefined,{name:'Читатели (локальный тест)'}),password=randomBytes(18).toString('base64url');
 const invitation=service.invitation(admin.id,{groups:[group.id],days:1,maxUses:1});
 const user=await service.acceptInvitation({token:invitation.token,username:'localreader',displayName:'Тестовый читатель',password});
 await writeFile('/data/onlyoffice-reader-credentials.json',JSON.stringify({url:'http://127.0.0.1:3010',username:'localreader',password})+'\n',{mode:0o600,flag:'wx'});
 const ownerGroup=db.prepare('SELECT group_id FROM memberships WHERE user_id=? LIMIT 1').get(admin.id).group_id;
 const folder=service.folder(admin.id,{name:'Проверка прав — только чтение',parentId:null,groupId:ownerGroup});
 const grant=id=>{const acl=service.readAcl(admin.id,id);return service.acl(admin.id,id,{baseEpoch:acl.baseEpoch,inheritPermissions:false,exportDisabled:false,policy:acl.effectivePolicy,groupPolicies:{...acl.effectiveGroupPolicies,[group.id]:{read:true,write:false}},userPolicies:acl.userPolicies});};
 grant(folder.id);
 const store=await BlobStore.open('/data/workspace/storage'),docs=new DocumentService(db,store),files=[];
 for(const format of ['docx','xlsx','pptx']){
  const source=await readFile(new URL(`../../apps/server/src/office/templates/blank.${format}`,import.meta.url));
  const file=await docs.create({localOnly:true,userId:admin.id,parentId:folder.id,title:'Только чтение.'+format,format},(async function*(){yield source;})());files.push({id:file.documentId,format});
 }
 for(const row of db.prepare("SELECT id FROM documents WHERE format IN ('docx','xlsx','pptx') AND id NOT IN (SELECT id FROM resources WHERE parent_id=?)").all(folder.id))grant(row.id);
 await writeFile('/data/onlyoffice-reader-fixture.json',JSON.stringify({userId:user.id,groupId:group.id,folderId:folder.id,files})+'\n',{mode:0o600});
 console.log({username:'localreader',folderId:folder.id,files});
}finally{db.close();}
