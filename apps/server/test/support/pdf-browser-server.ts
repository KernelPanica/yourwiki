/** Synthetic loopback-only PDF browser fixture. Never use against production data. */
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
await docs.create({userId:'qa',title:'PDF forms',format:'pdf',groupId:'qa',parentId:null},createReadStream(process.env.YOURWIKI_BROWSER_PDF_FIXTURE??new URL('../fixtures/pdf/form.pdf',import.meta.url)));
const worker=new PreviewWorker(db,store);while(await worker.runOnce()!=='idle'){}
const port=Number(process.env.YOURWIKI_BROWSER_PORT??39077);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid test port');
const app=buildApp({database:db,storage:store,webRoot:fileURLToPath(new URL('../../../web/dist',import.meta.url)),publicUrl:`http://127.0.0.1:${port}`});
await app.listen({port,host:'127.0.0.1'});console.log(`Synthetic PDF test server: http://127.0.0.1:${port}`);
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();db.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
