/** Synthetic loopback-only PDF browser fixture. Never use against production data. */
import {OfficeSessions} from '../../src/office/sessions.ts';
import {OfficeIngress} from '../../src/office/ingress.ts';
import {createSession,revokeSession} from '../../src/auth/sessions.ts';
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
let releaseDiscovery=()=>{};const discoveryGate=process.env.YOURWIKI_BROWSER_HOLD_OFFICE==='1'?new Promise<void>(resolve=>{releaseDiscovery=resolve;}):Promise.resolve();
const app=buildApp({database:db,storage:store,webRoot:fileURLToPath(new URL('../../../web/dist',import.meta.url)),publicUrl:`http://127.0.0.1:${port}`,...(process.env.YOURWIKI_BROWSER_OFFICE==='1'?{office:{publicUrl:`http://127.0.0.1:${port}/collabora`,fetch:async()=>{await discoveryGate;return new Response('<wopi-discovery><action ext="md" name="edit" urlsrc="https://ignored/collabora/browser/build/cool.html?"/></wopi-discovery>');}}}:{})});
await app.listen({port,host:'127.0.0.1'});console.log(`Synthetic PDF test server: http://127.0.0.1:${port}`);
// Test-only stdin control: no HTTP control surface is registered.
if(process.env.YOURWIKI_BROWSER_CONTROL==='1'){
 const input=createInterface({input:process.stdin});let chain=Promise.resolve();
 input.on('line',line=>{chain=chain.then(async()=>{
  try{
   const command=JSON.parse(line) as {action:string;title?:string};let result:Record<string,unknown>={};
   if(command.action==='release-discovery'){releaseDiscovery();}
   else if(command.action==='opening-state'){result={openings:db.prepare('SELECT open_id,state FROM office_openings').all(),tokens:(db.prepare('SELECT COUNT(*) AS n FROM office_tokens').get() as {n:number}).n};}
   else if(command.action==='recoveries'){
    if(!notes||process.env.YOURWIKI_BROWSER_OFFICE!=='1')throw new Error('Office fixture required');
    const browser=createSession(db,'qa'),office=new OfficeSessions(db),opened=office.open(browser.token,notes.documentId),ingress=new OfficeIngress(db,store);office.lock(opened.sessionId,opened.token,'LOCK','fixture-lock');
    try{for(let index=0;index<52;index++){const payload=Buffer.from('durable recovery copy '+index);await ingress.receive({sessionId:opened.sessionId,token:opened.token,lock:'fixture-lock',declaredSize:payload.length},(async function*(){yield payload;})());}}finally{await ingress.close();revokeSession(db,browser.token);}
   }else if(command.action==='export-deny-notes'){
    if(!notes)throw new Error('Notes fixture required');db.prepare("UPDATE users SET admin_role='member' WHERE id='qa'").run();db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(notes.documentId);
   }else if(command.action==='readonly-notes'){
    if(!notes)throw new Error('Notes fixture required');db.prepare('UPDATE resources SET user_policies=? WHERE id=?').run(JSON.stringify({qa:{read:true,write:false}}),notes.documentId);
   }else if(command.action==='create'){
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
   console.log(JSON.stringify({ok:true,action:command.action,...result}));
  }catch(error){console.log(JSON.stringify({ok:false,error:String(error)}));}
 });});
}
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();db.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
