/** Owned synthetic source only; parent SIGKILLs this process at a durable boundary. */
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {GoogleImportRequests} from '../../src/providers/google-import-jobs.ts';
import {GoogleImportWorker} from '../../src/providers/google-import-worker.ts';
import {createHash} from 'node:crypto';
const [dbPath,storagePath,mode,encoded]=process.argv.slice(2),db=openDatabase(dbPath),store=await BlobStore.open(storagePath),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),content=Buffer.from(encoded,'base64');
setInterval(()=>{},1000);
const wait=()=>new Promise<never>(()=>{}),mark=(text:string)=>process.stdout.write(text+'\n');
if(mode==='staged')store.adopt=async()=>{mark('staged');return wait();};
if(mode==='committed'){const commit=GoogleImportRequests.prototype.commit;GoogleImportRequests.prototype.commit=function(...args){const result=commit.apply(this,args);mark('committed');return result;};}
const request:typeof fetch=async(url,init)=>{const u=new URL(String(url));if(u.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'SYNTHETIC',token_type:'Bearer',expires_in:3600});if(u.origin!=='https://www.googleapis.com'||init?.method!=='GET')throw new Error('Unexpected owned source request');if(u.searchParams.get('alt')==='media'){if(mode==='receiving'){mark('receiving');return wait();}return new Response(content);}const id=u.pathname.split('/').at(-1)!;return Response.json({id,mimeType:id==='source'?'text/markdown':'application/vnd.google-apps.folder',version:'1',parents:id==='rootId'?[]:['rootId'],ownedByMe:true,shared:false,trashed:false,capabilities:{canDownload:true},...(id==='source'?{size:String(content.length),sha256Checksum:createHash('sha256').update(content).digest('hex')}: {})});};
await new GoogleImportWorker(db,store,new SecretConfigs(codec),{fetch:request}).runOnce();await wait();
