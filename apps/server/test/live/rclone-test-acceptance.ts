/** Operator acceptance for the explicitly provisioned test mount only. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {DocumentService} from '../../src/documents.ts';
import {Administration} from '../../src/administration/service.ts';
import {loadSecretCodec} from '../../src/providers/secret-key.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {GoogleAuthPool} from '../../src/providers/google-auth-pool.ts';
import {GoogleControlHttp} from '../../src/providers/google-control-http.ts';
const [workspace,settingsPath]=process.argv.slice(2);if(!workspace||!settingsPath||process.env.YOURWIKI_RCLONE_ACCEPTANCE!=='yes')throw Error('Explicit test-mount acceptance opt-in required');
const s=JSON.parse(await readFile(settingsPath,'utf8'));assert.equal(s.localConnectionId,'rclone-test');const db=openDatabase(join(workspace,'database.sqlite3')),store=await BlobStore.open(join(workspace,'storage')),docs=new DocumentService(db,store),codec=await loadSecretCodec(join(workspace,'encryption.key')),pool=new GoogleAuthPool(db,new SecretConfigs(codec)),revision=(db.prepare('SELECT revision FROM provider_connections WHERE id=?').get(s.sourceConnectionId) as any).revision,http=new GoogleControlHttp({access:v=>pool.access(s.sourceConnectionId,revision,v),invalidate:v=>pool.invalidate(s.sourceConnectionId,revision,v)}),admin=(db.prepare("SELECT id FROM users WHERE active=1 AND admin_role='giga' ORDER BY username='admin' DESC,id LIMIT 1").get() as any).id,scope={check(){}};
async function* bytes(data:Buffer){yield data;}
async function until(check:()=>Promise<boolean>,label:string){for(let n=0;n<90;n++){if(await check())return;await sleep(500);}throw Error(label);}
try{
 const folder=new Administration(db).folder(admin,{name:'Проверка вложенности '+randomUUID().slice(0,8),parentId:s.folderId}),data=Buffer.from('# Проверка rclone\n\nСоздано через YourWiki.\n'),created=await docs.create({userId:admin,parentId:folder.id,title:'Проверка создания.md',format:'md'},bytes(data));
 await until(async()=>!!db.prepare('SELECT 1 FROM provider_source_bindings WHERE document_id=? AND connection_id=?').get(created.documentId,s.localConnectionId),'INITIAL_EXPORT_TIMEOUT');
 const binding=db.prepare('SELECT reference FROM provider_source_bindings WHERE document_id=?').get(created.documentId) as {reference:string};assert((await readFile(join(s.mountDir,binding.reference))).equals(data));
 const updated=Buffer.from(data.toString()+'\nИзменение из YourWiki отправлено через локальный провайдер.\n');await docs.save({userId:admin,documentId:created.documentId,baseRevision:1},bytes(updated));
 await until(async()=>!!db.prepare('SELECT 1 FROM documents WHERE id=? AND provider_revision=2').get(created.documentId),'EDIT_DELIVERY_TIMEOUT');
 let remote=s.remoteFolderId;for(const name of binding.reference.split('/')){const value=(await http.call('GET','files',{q:"'"+remote+"' in parents and trashed=false and name='"+name.replaceAll("'","\\'")+"'",fields:'files(id,md5Checksum)',pageSize:'10'},undefined,scope)).files as {id:string;md5Checksum?:string}[];await until(async()=>{const list=(await http.call('GET','files',{q:"'"+remote+"' in parents and trashed=false and name='"+name.replaceAll("'","\\'")+"'",fields:'files(id,md5Checksum)',pageSize:'10'},undefined,scope)).files as {id:string;md5Checksum?:string}[];if(list.length!==1)return false;value.splice(0,value.length,...list);return name!==binding.reference.split('/').at(-1)||list[0].md5Checksum===createHash('md5').update(updated).digest('hex');},'REMOTE_BYTES_TIMEOUT');assert.equal(value.length,1);remote=value[0].id;}
 console.log(JSON.stringify({initialCreateExported:true,nestedFolderExported:true,editorSaveDelivered:true,driveChecksumConfirmed:true,documentId:created.documentId,folderId:folder.id}));
}finally{await http.close();await pool.close();codec.close();db.close();}
