/** Disposable loopback-only benchmark fixture. Never use production data or credentials. */
import {createReadStream} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {openDatabase} from '../apps/server/src/database.ts';
import {BlobStore} from '../apps/server/src/storage/blobs.ts';
import {DocumentService} from '../apps/server/src/documents.ts';
import {PreviewWorker} from '../apps/server/src/worker/preview-worker.ts';
import {createSession} from '../apps/server/src/auth/sessions.ts';
import {buildApp} from '../apps/server/src/app.ts';

const port=Number(process.env.YOURWIKI_PERFORMANCE_PORT??39098);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid benchmark port');
const root=await mkdtemp(join(tmpdir(),'yourwiki-performance-'));
const db=openDatabase(join(root,'benchmark.sqlite')),store=await BlobStore.open(join(root,'blobs'));
const docs=new DocumentService(db,store);
db.prepare("INSERT INTO groups(id,name) VALUES('benchmark','Benchmark readers')").run();
const sessions=[];
for(let index=0;index<15;index++){
 const id='benchmark-'+index;
 db.prepare("INSERT INTO users(id,username,display_name,password_hash) VALUES(?,?,?,'!disabled-benchmark-login')").run(id,id,'Reader '+index);
 db.prepare("INSERT INTO memberships(user_id,group_id) VALUES(?,'benchmark')").run(id);
 const session=createSession(db,id);sessions.push({id,token:session.token});
}
const md=[];
for(let index=0;index<100;index++){
 const content=Buffer.from('# Prepared document '+index+'\n\n'+('A prepared paragraph with searchable business notes and a local preview.\n\n'.repeat(50)));
 const doc=await docs.create({userId:sessions[0].id,title:'Prepared document '+index,format:'md',groupId:'benchmark',parentId:null},(async function*(){yield content;})());md.push(doc.documentId);
}
const pdf=await docs.create({userId:sessions[0].id,title:'PDF forms',format:'pdf',groupId:'benchmark',parentId:null},createReadStream(new URL('../apps/server/test/fixtures/pdf/form.pdf',import.meta.url)));
const worker=new PreviewWorker(db,store);while(await worker.runOnce()!=='idle'){}
const origin=`http://127.0.0.1:${port}`;
const app=buildApp({database:db,storage:store,webRoot:fileURLToPath(new URL('../apps/web/dist',import.meta.url)),publicUrl:origin});
await app.listen({port,host:'127.0.0.1'});
const cgroup=(await readFile('/proc/self/cgroup','utf8')).trim().split('\n').find(line=>line.startsWith('0::'))?.slice(3);
async function limit(name:string){try{return (await readFile(resolve('/sys/fs/cgroup','.'+(cgroup??''),name),'utf8')).trim();}catch{return null;}}
// Tokens are consumed directly by the harness through its private stdout pipe, never written to reports.
console.log(JSON.stringify({origin,pid:process.pid,sessions,md,pdf:pdf.documentId,documents:101,cgroup:{path:cgroup,cpuMax:await limit('cpu.max'),memoryMax:await limit('memory.max')}}));
const input=createInterface({input:process.stdin});
input.on('line',async line=>{if(line==='metrics')console.log(JSON.stringify({memory:process.memoryUsage(),usage:process.resourceUsage(),cgroup:{memoryPeak:await limit('memory.peak'),memoryEvents:await limit('memory.events'),cpuStat:await limit('cpu.stat')}}));});
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();db.close();await rm(root,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
