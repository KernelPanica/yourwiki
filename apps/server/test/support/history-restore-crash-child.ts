import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {HistoryRestore} from '../../src/history-restore.ts';
const [path,root,doc,entry,mode]=process.argv.slice(2),db=openDatabase(path),store=await BlobStore.open(root),service=new HistoryRestore(db,store),source=db.prepare('SELECT digest FROM document_versions WHERE document_id=? AND revision=2').get(doc) as {digest:string};
const value=service.request({operationId:'restore-crash',userId:'writer',documentId:doc,entryId:Number(entry),baseRevision:2,baseDigest:source.digest,layerRevision:0,layerDigest:null});
if(mode==='verifying'){store.verify=async()=>{console.log('verifying');return await new Promise<boolean>(()=>{});};await service.commit('writer','restore-crash');}
else{if(mode==='saved')await service.commit('writer','restore-crash');console.log(mode);setInterval(()=>{},60000);}
