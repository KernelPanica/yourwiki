/** Explicit owned native-disk 4GiB proof. Never run against an existing workspace. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,stat,open} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {DocumentService} from '../../src/documents.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {ProviderConnections} from '../../src/providers/connections.ts';
import {bindExistingSource} from '../../src/providers/source-bindings.ts';
import {CredentialVault} from '../../src/providers/credential-vault.ts';
import {DeliveryWorker} from '../../src/providers/delivery-worker.ts';
import {LocalAdapter} from '../../src/providers/local-adapter.ts';
const key='cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=',size=4*1024**3;
async function* bytes(value:string){yield Buffer.from(value);}
async function child(root:string,mode:string){
 const db=openDatabase(join(root,'db')),store=await BlobStore.open(join(root,'store')),codec=new FernetCodec(key);let replacements=0;
 try{const worker=new DeliveryWorker(db,store,new CredentialVault(db,new SecretConfigs(codec)),async connection=>{const adapter=await LocalAdapter.open(String(connection.config.root));return {read:(r,o)=>adapter.read(r,o),retire:i=>adapter.retire(i),close:()=>adapter.close(),replace:async input=>{replacements++;assert.equal(mode,'deliver','Read-back may never replace');const receipt=await adapter.replace(input);console.log(JSON.stringify({phase:'renamed',replacements,maxRssKiB:process.resourceUsage().maxRSS,heapUsed:process.memoryUsage().heapUsed}));await new Promise(()=>{});return receipt;}};});const result=await worker.runOnce();assert.equal(mode,'reconcile');assert.equal(result,'confirmed');assert.equal(replacements,0);console.log(JSON.stringify({phase:'confirmed',result,replacements,maxRssKiB:process.resourceUsage().maxRSS,heapUsed:process.memoryUsage().heapUsed}));}finally{codec.close();db.close();}
}
async function parent(directory:string){
 assert.ok(isAbsolute(directory),'Use an explicit owned native disk output directory');await mkdir(directory,{recursive:true});const root=await mkdtemp(join(directory,'provider-4g-')),started=Date.now();let active:ChildProcess|undefined;const db=openDatabase(join(root,'db')),codec=new FernetCodec(key);
 try{
  const store=await BlobStore.open(join(root,'store')),external=join(root,'external');await mkdir(external,{mode:0o700});await writeFile(join(external,'original.bin'),'baseline');db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('u','u','Owned synthetic user','!','giga');INSERT INTO groups(id,name) VALUES('g','Owned group')");const docs=new DocumentService(db,store),created=await docs.create({userId:'u',parentId:null,groupId:'g',title:'Owned four GiB original',format:'bin'},bytes('baseline'));
  new ProviderConnections(db,new SecretConfigs(codec)).create('u',{id:'owned',provider:'local',label:'Owned Local',path:'/',folderId:null,config:{root:external}});const adapter=await LocalAdapter.open(external);const baseline=await adapter.read('original.bin',{check:()=>{}});for await(const _ of baseline.bytes){}await adapter.close();bindExistingSource(db,{documentId:created.documentId,connectionId:'owned',reference:'original.bin',fingerprint:baseline.fingerprint,confirmedRevision:1,confirmedDigest:created.blob.digest,confirmedSize:created.blob.size,now:Date.now()});const expected=createHash('sha256');let generated=0;const saved=await docs.save({userId:'u',documentId:created.documentId,baseRevision:1},(async function*(){const chunk=Buffer.alloc(65536,0x5a);while(generated<size){generated+=chunk.length;expected.update(chunk);yield chunk;}})());assert.equal(saved.blob.size,size);assert.equal(saved.blob.digest,expected.digest('hex'));
  async function run(mode:string){const processChild=spawn(process.execPath,['--max-old-space-size=48',fileURLToPath(import.meta.url),'--worker',root,mode],{stdio:['ignore','pipe','pipe']});active=processChild;const ended=once(processChild,'exit'),lines=createInterface({input:processChild.stdout!});let errors='';processChild.stderr!.on('data',chunk=>errors=(errors+chunk).slice(-4096));try{const [line]=await Promise.race([once(lines,'line'),ended.then(()=>{throw new Error('Owned large worker exited early: '+errors);})]);const metadata=JSON.parse(line);if(mode==='deliver'){assert.equal(metadata.phase,'renamed');processChild.kill('SIGKILL');await ended;assert.equal(processChild.signalCode,'SIGKILL');}else{const [code]=await ended;assert.equal(code,0);assert.equal(metadata.phase,'confirmed');}active=undefined;return metadata;}finally{lines.close();}}
  const delivered=await run('deliver'),afterCrash=await stat(join(external,'original.bin'),{bigint:true});assert.equal(afterCrash.size,BigInt(size));const pending=db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(created.documentId) as any;assert.deepEqual(pending,{local_revision:2,provider_revision:1});assert.equal((db.prepare('SELECT state FROM provider_delivery_attempts').get() as any).state,'writing');
  // The owner is verified dead. Expire its synthetic leases rather than sleeping30s.
  db.exec("UPDATE worker_slots SET lease_until=1 WHERE name='provider-source';UPDATE jobs SET lease_until=1 WHERE kind='provider.deliver' AND state='running';UPDATE provider_delivery_attempts SET lease_until=1 WHERE state='writing'");
  const reconciled=await run('reconcile'),after=await stat(join(external,'original.bin'),{bigint:true});assert.equal(after.ino,afterCrash.ino);assert.equal(after.dev,afterCrash.dev);assert.equal(after.size,BigInt(size));const receipt=db.prepare('SELECT state,digest,size,receipt_fingerprint FROM provider_delivery_attempts').get() as any;assert.equal(receipt.state,'confirmed');assert.equal(receipt.digest,saved.blob.digest);assert.equal(receipt.size,size);assert.ok(receipt.receipt_fingerprint);assert.equal((db.prepare('SELECT provider_revision FROM documents WHERE id=?').get(created.documentId) as any).provider_revision,2);
  const file=await open(join(external,'original.bin'),'r');try{for(const [offset,length] of [[0,32],[size-257,257]]){const chunk=Buffer.alloc(length);assert.equal((await file.read(chunk,0,length,offset)).bytesRead,length);assert.ok(chunk.every(b=>b===0x5a));}}finally{await file.close();}
  console.log(JSON.stringify({nativeProvider4GiB:'passed',bytes:size,sha256:saved.blob.digest,generated,renamedWithoutAck:true,reconciledWithoutReplace:true,sameInodeAfterReconcile:true,exactTailBytes:257,providerRevision:2,deliver:delivered,reconcile:reconciled,parentMaxRssKiB:process.resourceUsage().maxRSS,parentHeapUsed:process.memoryUsage().heapUsed,elapsedMs:Date.now()-started}));
 }finally{if(active&&active.exitCode===null&&active.signalCode===null){const ended=once(active,'exit');active.kill('SIGKILL');await ended;}codec.close();db.close();await rm(root,{recursive:true,force:true});}
}
if(process.argv[2]==='--worker')await child(process.argv[3],process.argv[4]);else await parent(process.argv[2]??'');
