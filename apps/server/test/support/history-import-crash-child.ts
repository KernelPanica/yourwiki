import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {HistoryImport} from '../../src/history-import.ts';
const [path,root,documentId,file,mode]=process.argv.slice(2),db=openDatabase(path),store=await BlobStore.open(root),service=new HistoryImport(db,store),data=await readFile(file);service.begin({operationId:'import-crash',userId:'admin',documentId,sourceKey:'crash-source',archiveDigest:createHash('sha256').update(data).digest('hex'),archiveSize:data.length});
if(mode==='receiving'){const upload=store.uploadStore;store.uploadStore=async function(id){const target=await upload.call(this,id),put=target.put;target.put=async function(...args:Parameters<typeof put>){const value=await put.apply(this,args);console.log('receiving');return await new Promise<typeof value>(()=>{});};return target;};}
await service.receive('admin','import-crash',(async function*(){yield data;})());
if(mode==='adopting'){const adopt=store.adopt;store.adopt=async function(...args:Parameters<typeof adopt>){const result=await adopt.apply(this,args);console.log('adopting');return await new Promise<typeof result>(()=>{});};}
if(mode==='adopting'||mode==='committed')await service.publish('admin','import-crash');console.log(mode);setInterval(()=>{},60000);
