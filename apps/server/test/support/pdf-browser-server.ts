/** Synthetic loopback-only PDF browser fixture. Never use against production data. */
import {createInterface} from 'node:readline';
import {PdfLayerService} from '../../src/pdf-layers.ts';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/database.ts';
import { BlobStore } from '../../src/storage/blobs.ts';
import { DocumentService } from '../../src/documents.ts';
import { PreviewWorker } from '../../src/worker/preview-worker.ts';
import { buildApp } from '../../src/app.ts';
import { hashPassword } from '../../src/auth/passwords.ts';
const root=await mkdtemp(join(tmpdir(),'yourwiki-pdf-browser-')),db=openDatabase(':memory:');
db.prepare("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('qa','qa','PDF tester',?,'giga')").run(await hashPassword('yourwiki-qa'));
db.prepare("INSERT INTO users(id,username,display_name,password_hash) VALUES('other','other','Other viewer',?)").run(await hashPassword('yourwiki-other'));
db.exec("INSERT INTO groups VALUES('qa','Test group'); INSERT INTO memberships VALUES('qa','qa'),('other','qa')");
const store=await BlobStore.open(root),docs=new DocumentService(db,store);
const fixture=process.env.YOURWIKI_BROWSER_PDF_FIXTURE??new URL('../fixtures/pdf/form.pdf',import.meta.url);
const initial=await docs.create({userId:'qa',title:'PDF forms',format:'pdf',groupId:'qa',parentId:null},createReadStream(fixture));
const notes=process.env.YOURWIKI_BROWSER_CONTROL==='1'?await docs.create({userId:'qa',title:'Live notes',format:'md',groupId:'qa',parentId:null},(async function*(){yield Buffer.from('# Initial live notes');})()):null;
const worker=new PreviewWorker(db,store);while(await worker.runOnce()!=='idle'){}
const port=Number(process.env.YOURWIKI_BROWSER_PORT??39077);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid test port');
const app=buildApp({database:db,storage:store,webRoot:fileURLToPath(new URL('../../../web/dist',import.meta.url)),publicUrl:`http://127.0.0.1:${port}`});
await app.listen({port,host:'127.0.0.1'});console.log(`Synthetic PDF test server: http://127.0.0.1:${port}`);
// Test-only stdin control: no HTTP control surface is registered.
if(process.env.YOURWIKI_BROWSER_CONTROL==='1'){
 const input=createInterface({input:process.stdin});let chain=Promise.resolve();
 input.on('line',line=>{chain=chain.then(async()=>{
  try{
   const command=JSON.parse(line) as {action:string;title?:string};
   if(command.action==='create'){
    await docs.create({userId:'qa',title:command.title??'Live PDF',format:'pdf',groupId:'qa',parentId:null},createReadStream(fixture));
    while(await worker.runOnce()!=='idle'){}
   }else if(command.action==='layer'){
    const layers=new PdfLayerService(db,store),state=layers.state('qa',initial.documentId)!;
    await layers.save({userId:'qa',documentId:initial.documentId,baseRevision:state.baseRevision,layerRevision:state.layerRevision},createReadStream(fixture));
   }else if(command.action==='notes'){
    const revision=(db.prepare('SELECT local_revision AS revision FROM documents WHERE id=?').get(notes!.documentId) as {revision:number}).revision;
    await docs.save({userId:'qa',documentId:notes!.documentId,baseRevision:revision},(async function*(){yield Buffer.from('# Updated live notes');})());
    while(await worker.runOnce()!=='idle'){}
   }else if(command.action==='deny'){
    db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({qa:{read:false,write:false}}),initial.documentId);
   }else if(command.action==='readonly'){
    db.prepare("UPDATE users SET admin_role='member' WHERE id='qa'").run();
    db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({qa:{read:true,write:false}}),initial.documentId);
   }else if(command.action==='expire')db.prepare("DELETE FROM sessions WHERE user_id='qa'").run();
   else throw new Error('Unknown fixture command');
   console.log(JSON.stringify({ok:true,action:command.action}));
  }catch(error){console.log(JSON.stringify({ok:false,error:String(error)}));}
 });});
}
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();db.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
