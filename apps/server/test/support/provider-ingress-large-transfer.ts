/** Explicit owned native-disk ingress proof. Default 4GiB; optional smaller smoke size. */
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
import {IngressWorker} from '../../src/providers/ingress-worker.ts';
import {ProviderIngress} from '../../src/providers/ingress-inbox.ts';
import {LocalAdapter} from '../../src/providers/local-adapter.ts';
import {JobQueue} from '../../src/jobs.ts';
const key='cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=';
const memory=()=>({maxRssKiB:process.resourceUsage().maxRSS,heapUsed:process.memoryUsage().heapUsed});
async function child(root:string,mode:string){
 const db=openDatabase(join(root,'db')),store=await BlobStore.open(join(root,'store')),codec=new FernetCodec(key);let resolves=0,reads=0,replacements=0;
 // Test-only method interception: hold at durable boundaries, not a product fault flag.
 const commit=ProviderIngress.prototype.commit,cleanup=ProviderIngress.prototype.cleanupApplied;
 if(mode==='stage')ProviderIngress.prototype.commit=async function(...args){console.log(JSON.stringify({phase:'staged',resolves,reads,replacements,...memory()}));await new Promise(()=>{});return commit.apply(this,args);};
 if(mode==='apply')ProviderIngress.prototype.cleanupApplied=async function(...args){console.log(JSON.stringify({phase:'applied-before-ack',resolves,reads,replacements,...memory()}));await new Promise(()=>{});return cleanup.apply(this,args);};
 try{const result=await new IngressWorker(db,store,new CredentialVault(db,new SecretConfigs(codec)),async connection=>{resolves++;const adapter=await LocalAdapter.open(String(connection.config.root));return {read:(r,o)=>{reads++;return adapter.read(r,o);},changed:(r,f,o)=>adapter.changed(r,f,o),replace:async()=>{replacements++;throw new Error('Ingress must never replace original');},retire:(i:Parameters<import('../../src/providers/adapter.ts').ProviderAdapter['retire']>[0])=>adapter.retire(i),close:()=>adapter.close()};}).runOnce();assert.equal(mode,'ack');assert.equal(result,'applied');assert.equal(resolves,0);assert.equal(reads,0);assert.equal(replacements,0);console.log(JSON.stringify({phase:'acknowledged',result,resolves,reads,replacements,...memory()}));}
 finally{ProviderIngress.prototype.commit=commit;ProviderIngress.prototype.cleanupApplied=cleanup;codec.close();db.close();}
}
async function parent(directory:string,size:number){
 assert.ok(isAbsolute(directory),'Use an explicit owned native-disk output directory');assert.ok(Number.isSafeInteger(size)&&size>=65536&&size<=4*1024**3);await mkdir(directory,{recursive:true});const root=await mkdtemp(join(directory,'ingress-large-')),started=Date.now();let active:ChildProcess|undefined;const db=openDatabase(join(root,'db')),codec=new FernetCodec(key);
 try{
  const store=await BlobStore.open(join(root,'store')),external=join(root,'external');await mkdir(external,{mode:0o700});const original=join(external,'original.bin');await writeFile(original,'baseline');db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('u','u','Owned synthetic user','!','giga');INSERT INTO groups(id,name) VALUES('g','Owned group')");const docs=new DocumentService(db,store),created=await docs.create({userId:'u',parentId:null,groupId:'g',title:'Owned ingress proof',format:'bin'},(async function*(){yield Buffer.from('baseline');})());
  new ProviderConnections(db,new SecretConfigs(codec)).create('u',{id:'owned',provider:'local',label:'Owned Local',path:'/',folderId:null,config:{root:external}});const adapter=await LocalAdapter.open(external);try{const baseline=await adapter.read('original.bin',{check:()=>{}});for await(const _ of baseline.bytes){}bindExistingSource(db,{documentId:created.documentId,connectionId:'owned',reference:'original.bin',fingerprint:baseline.fingerprint,confirmedRevision:1,confirmedDigest:created.blob.digest,confirmedSize:created.blob.size,now:Date.now()});}finally{await adapter.close();}
  const hash=createHash('sha256'),file=await open(original,'w');let generated=0;
  try{const chunk=Buffer.alloc(65536,0x6d);while(generated<size){const part=chunk.subarray(0,Math.min(chunk.length,size-generated));let written=0;while(written<part.length){const result=await file.write(part,written,part.length-written);assert.ok(result.bytesWritten>0);written+=result.bytesWritten;}hash.update(part);generated+=part.length;}await file.sync();}finally{await file.close();}
  const digest=hash.digest('hex'),sourceBefore=await stat(original,{bigint:true});assert.equal(sourceBefore.size,BigInt(size));new JobQueue(db).enqueue({kind:'provider.pull',key:'owned-large-ingress',payload:{documentId:created.documentId}});
  async function run(mode:string){
   const processChild=spawn(process.execPath,['--max-old-space-size=48',fileURLToPath(import.meta.url),'--worker',root,mode],{stdio:['ignore','pipe','pipe']});active=processChild;const ended=once(processChild,'exit'),lines=createInterface({input:processChild.stdout!});let errors='',timer:ReturnType<typeof setTimeout>|undefined;processChild.stderr!.on('data',chunk=>errors=(errors+chunk).slice(-4096));
   try{const [line]=await Promise.race([once(lines,'line'),ended.then(()=>{throw new Error('Owned ingress worker exited early: '+errors);}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned ingress worker deadline')),600000);})]);const metadata=JSON.parse(line);if(mode!=='ack'){assert.equal(metadata.phase,mode==='stage'?'staged':'applied-before-ack');processChild.kill('SIGKILL');await ended;assert.equal(processChild.signalCode,'SIGKILL');}else{const [code]=await ended;assert.equal(code,0);assert.equal(metadata.phase,'acknowledged');}active=undefined;return metadata;}finally{clearTimeout(timer);lines.close();}
  }
  const staged=await run('stage'),snapshot=db.prepare('SELECT * FROM provider_ingress_snapshots').get() as any;assert.equal(snapshot.state,'staged');assert.equal(snapshot.digest,digest);assert.equal(snapshot.size,size);assert.equal(snapshot.reserved_bytes,size);assert.deepEqual(db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(created.documentId),{local_revision:1,provider_revision:1});assert.equal((db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n,1);
  function expire(){// Only after SIGKILL and verified child death; never steal a live lease.
   db.exec("UPDATE worker_slots SET lease_until=1 WHERE name='provider-source';UPDATE jobs SET lease_until=1 WHERE kind='provider.pull' AND state='running';UPDATE provider_ingress_snapshots SET lease_until=1 WHERE state IN ('staged','applied')");
  }
  expire();const applied=await run('apply');assert.equal((db.prepare('SELECT state FROM jobs WHERE kind=\'provider.pull\'').get() as any).state,'running');const accepted=db.prepare('SELECT * FROM provider_ingress_snapshots').get() as any;assert.equal(accepted.state,'applied');const receipt=JSON.parse(accepted.receipt);assert.equal(receipt.revision,2);assert.equal(receipt.changed,true);assert.equal(accepted.reserved_bytes,size);expire();
  const acknowledged=await run('ack'),final=db.prepare('SELECT * FROM provider_ingress_snapshots').get() as any;assert.equal(final.id,snapshot.id);assert.equal(final.receipt,accepted.receipt);assert.equal(final.reserved_bytes,0);assert.equal(await store.existingUploadStore(final.namespace_id),null);assert.deepEqual(db.prepare('SELECT local_revision,provider_revision FROM documents WHERE id=?').get(created.documentId),{local_revision:2,provider_revision:2});assert.equal((db.prepare('SELECT COUNT(*) AS n FROM document_versions').get() as any).n,2);assert.equal((db.prepare('SELECT COUNT(*) AS n FROM document_provider_origins').get() as any).n,1);assert.equal((db.prepare('SELECT author_id FROM document_versions WHERE revision=2').get() as any).author_id,null);assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='provider.deliver'").get() as any).n,0);assert.equal((db.prepare("SELECT state FROM jobs WHERE kind='provider.pull'").get() as any).state,'succeeded');assert.equal((db.prepare('SELECT COUNT(*) AS n FROM provider_ingress_snapshots').get() as any).n,1);
  const sourceAfter=await stat(original,{bigint:true});assert.equal(sourceAfter.ino,sourceBefore.ino);assert.equal(sourceAfter.dev,sourceBefore.dev);assert.equal(sourceAfter.mtimeNs,sourceBefore.mtimeNs);assert.equal(sourceAfter.size,sourceBefore.size);assert.equal(await store.verify({digest,size}),true);
  const stored=await open(await store.localFile(digest),'r');try{for(const [offset,length] of [[0,32],[size-257,257]]){const chunk=Buffer.alloc(length);assert.equal((await stored.read(chunk,0,length,offset)).bytesRead,length);assert.ok(chunk.every(byte=>byte===0x6d));}}finally{await stored.close();}
  console.log(JSON.stringify({nativeIngress:'passed',bytes:size,sha256:digest,generated,stageCrash:true,acceptedBeforeAckCrash:true,oneReceipt:true,oneNewRevision:true,noOutboundJobs:true,originalUnchanged:true,exactTailBytes:257,namespaceReleased:true,staged,applied,acknowledged,parent:memory(),elapsedMs:Date.now()-started}));
 }finally{if(active&&active.exitCode===null&&active.signalCode===null){const ended=once(active,'exit');active.kill('SIGKILL');await ended;}codec.close();db.close();await rm(root,{recursive:true,force:true});}
}
if(process.argv[2]==='--worker')await child(process.argv[3],process.argv[4]);else await parent(process.argv[2]??'',Number(process.argv[3]??4*1024**3));
