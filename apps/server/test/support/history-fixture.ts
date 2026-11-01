import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {DocumentService} from '../../src/documents.ts';
import {JobQueue} from '../../src/jobs.ts';
import {HistoryRead} from '../../src/history-read.ts';
import {HistorySettings} from '../../src/history-settings.ts';
import {createSession} from '../../src/auth/sessions.ts';
import {buildApp} from '../../src/app.ts';
export async function* bytes(value:string|Uint8Array){yield typeof value==='string'?Buffer.from(value):value;}
export async function historyFixture(t:any,options:{original?:Uint8Array;parentDirectory?:string}={}){
 const root=await mkdtemp(join(options.parentDirectory??tmpdir(),'yourwiki-history-read-')),path=join(root,'db'),db=openDatabase(path),store=await BlobStore.open(join(root,'store')),docs=new DocumentService(db,store);
 db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('writer','writer','Writer','!','member'),('reader','reader','Reader','!','member'),('foreign','foreign','Foreign','!','member'),('admin','admin','Admin','!','giga');INSERT INTO groups VALUES('g','Group');INSERT INTO memberships VALUES('writer','g'),('reader','g')");
 const first=await docs.create({userId:'writer',groupId:'g',parentId:null,title:'Guide',format:'md'},bytes(options.original??Buffer.from('original'))),other=await docs.create({userId:'writer',groupId:'g',parentId:null,title:'Other',format:'md'},bytes('other'));
 const queue=new JobQueue(db),artifact=await store.put(bytes('<p>Prepared</p>'),{maxBytes:100});
 async function publish(){let job;while((job=queue.claim(Date.now()))){const id=String(job.payload.documentId),revision=Number(job.payload.revision),source=db.prepare('SELECT digest FROM document_versions WHERE document_id=? AND revision=?').get(id,revision) as {digest:string};await docs.publish(job,{schemaVersion:1,documentId:id,revision,sourceDigest:source.digest,converterVersion:'preview-v2',kind:'document',primary:'content',artifacts:[{...artifact,name:'content',mimeType:'text/html'}]});}}
 await publish();const settings=new HistorySettings(db);settings.update('admin',{enabled:true,baseRevision:0});const next=await docs.save({userId:'writer',documentId:first.documentId,baseRevision:1},bytes('new'));await publish();
 const reader=new HistoryRead(db,store),sessions=Object.fromEntries(['writer','reader','foreign','admin'].map(user=>[user,createSession(db,user)]));const origin='https://wiki.test',headers=(user='reader')=>({origin,cookie:'yourwiki_v2_session='+sessions[user].token,'x-csrf-token':sessions[user].csrf});const app=buildApp({database:db,storage:store,publicUrl:origin});
 t.after(async()=>{await app.close();await reader.close();db.close();await rm(root,{recursive:true,force:true});});return {root,path,db,store,docs,first,other,next,settings,reader,sessions,headers,app,publish,entryId:(db.prepare('SELECT id FROM history_entries WHERE document_id=?').get(first.documentId) as {id:number}).id};
}
