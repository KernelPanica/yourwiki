/** Disposable test child; parent owns and kills only this process. */
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {HistoryPreviews} from '../../src/history-previews.ts';
import {PreviewWorker} from '../../src/worker/preview-worker.ts';
const [path,root,docId,entryId,mode]=process.argv.slice(2),db=openDatabase(path),store=await BlobStore.open(root),previews=new HistoryPreviews(db,store);
const prepared=await previews.request('reader',docId,Number(entryId));
if(mode==='creating'){
 store.verify=async()=>{console.log(JSON.stringify({...prepared,state:'creating'}));return await new Promise<boolean>(()=>{});};
 await new PreviewWorker(db,store).runOnce();
}else{console.log(JSON.stringify(prepared));setInterval(()=>{},60000);}
