import {randomUUID} from 'node:crypto';
import {JobQueue} from '../../src/jobs.ts';
import {ProviderIngress} from '../../src/providers/ingress-inbox.ts';
import {SyncActions} from '../../src/providers/sync-actions.ts';
import {createSession,authenticateSession} from '../../src/auth/sessions.ts';
import {IngressWorker} from '../../src/providers/ingress-worker.ts';
/** Owned loopback-browser fixture only. No HTTP control routes or live accounts. */
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Database} from '../../src/database.ts';
import type {BlobStore} from '../../src/storage/blobs.ts';
import type {DocumentService} from '../../src/documents.ts';
import {ProviderConnections} from '../../src/providers/connections.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {CredentialVault} from '../../src/providers/credential-vault.ts';
import {DeliveryWorker} from '../../src/providers/delivery-worker.ts';
import {LocalAdapter} from '../../src/providers/local-adapter.ts';
import {ProviderError} from '../../src/providers/adapter.ts';
import {bindExistingSource} from '../../src/providers/source-bindings.ts';
export class BrowserDeliveryControls {
 private db:Database;private store:BlobStore;private docs:DocumentService;private root:string;private pdf:string;private notes:string|undefined;private previews:()=>Promise<void>;private codec:FernetCodec|undefined;private worker:DeliveryWorker|undefined;private fault='none';private writes=0;
 constructor(db:Database,store:BlobStore,docs:DocumentService,root:string,pdf:string,notes:string|undefined,previews:()=>Promise<void>){this.db=db;this.store=store;this.docs=docs;this.root=join(root,'owned-originals');this.pdf=pdf;this.notes=notes;this.previews=previews;}
 close(){this.codec?.close();}
 private current(id:string){return this.db.prepare('SELECT d.local_revision,d.provider_revision,v.digest,v.size FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=d.local_revision WHERE d.id=?').get(id) as {local_revision:number;provider_revision:number;digest:string;size:number};}
 async handle(action:string):Promise<Record<string,unknown>|undefined>{
  let incomingResult:string|undefined;
  if(!action.startsWith('source-'))return;if(!this.notes)throw new Error('Owned notes fixture required');
  if(action==='source-fixtures'){
   if(this.worker)throw new Error('Source fixture already initialized');await mkdir(this.root);this.codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=');const configs=new SecretConfigs(this.codec);new ProviderConnections(this.db,configs).create('qa',{id:'owned-local',provider:'local',label:'Owned Local',path:'/',folderId:null,config:{root:this.root}});
   const adapter=await LocalAdapter.open(this.root);try{for(const [id,name] of [[this.notes,'notes.md'],[this.pdf,'form.pdf']]){const current=this.current(id);await writeFile(join(this.root,name),await readFile(await this.store.localFile(current.digest)));const proof=await adapter.read(name,{check:()=>{}});for await(const _ of proof.bytes){}bindExistingSource(this.db,{documentId:id,connectionId:'owned-local',reference:name,fingerprint:proof.fingerprint,confirmedRevision:current.local_revision,confirmedDigest:current.digest,confirmedSize:current.size,now:Date.now()});}}finally{await adapter.close();}
   this.worker=new DeliveryWorker(this.db,this.store,new CredentialVault(this.db,configs),async connection=>{const adapter=await LocalAdapter.open(String(connection.config.root));return {read:(r,o)=>adapter.read(r,o),retire:i=>adapter.retire(i),close:()=>adapter.close(),replace:async input=>{const fault=this.fault;this.fault='none';if(fault==='not-written')throw new ProviderError('PROVIDER_UNAVAILABLE');this.writes++;const receipt=await adapter.replace(input);if(fault==='lost-ack')throw new ProviderError('PROVIDER_UNKNOWN','unknown');return receipt;}};});
   const revision=this.current(this.notes).local_revision;await this.docs.save({userId:'qa',documentId:this.notes,baseRevision:revision},(async function*(){yield Buffer.from('# Source notes '+(revision+1));})());await this.previews();
  }else{
   if(!this.worker)throw new Error('Source fixture not initialized');
   if(action==='source-save'){const revision=this.current(this.notes).local_revision;await this.docs.save({userId:'qa',documentId:this.notes,baseRevision:revision},(async function*(){yield Buffer.from('# Source notes '+(revision+1));})());await this.previews();}
   else if(action==='source-work'){for(let n=0;n<12;n++){const state=await this.worker.runOnce();if(!['confirmed','superseded'].includes(state))break;}}
   else if(action==='source-not-written'||action==='source-lost-ack'){this.fault=action==='source-not-written'?'not-written':'lost-ack';await this.worker.runOnce();}
   else if(action==='source-pdf-conflict'){const current=this.current(this.pdf),bytes=await readFile(await this.store.localFile(current.digest));await this.docs.save({userId:'qa',documentId:this.pdf,baseRevision:current.local_revision},(async function*(){yield Buffer.concat([bytes,Buffer.from('\n% latest local original\n')]);})());await writeFile(join(this.root,'form.pdf'),Buffer.concat([bytes,Buffer.from('\n% external original\n')]));for(let n=0;n<12;n++){const state=await this.worker.runOnce();if(!['confirmed','superseded'].includes(state))break;}}
   else if(action==='source-incoming-pdf'){new JobQueue(this.db).enqueue({kind:'provider.pull',key:randomUUID(),payload:{documentId:this.pdf}});incomingResult=await new IngressWorker(this.db,this.store,new CredentialVault(this.db,new SecretConfigs(this.codec!)),async connection=>LocalAdapter.open(String(connection.config.root))).runOnce();}
   else if(action==='source-stage-notes'){
    await writeFile(join(this.root,'notes.md'),'# Incoming staged notes\n');const adapter=await LocalAdapter.open(this.root),queue=new JobQueue(this.db),now=Date.now();
    try{const proof=await adapter.read('notes.md',{check:()=>{}}),current=this.current(this.notes),binding=this.db.prepare('SELECT b.fingerprint,c.revision FROM provider_source_bindings b JOIN provider_connections c ON c.id=b.connection_id WHERE b.document_id=?').get(this.notes) as {fingerprint:string;revision:number};
     queue.enqueue({kind:'provider.pull',key:randomUUID(),payload:{documentId:this.notes}},now);const job=queue.claim(now,30000,'provider.pull');if(!job)throw new Error('Owned ingress job required');const slotToken=randomUUID();this.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slotToken,now+30000);
     try{const inbox=new ProviderIngress(this.db,this.store),snapshot=inbox.begin({job,slotToken,documentId:this.notes,connectionRevision:binding.revision,baseLocalRevision:current.local_revision,baseProviderRevision:current.provider_revision,baseFingerprint:binding.fingerprint,observedFingerprint:proof.fingerprint,declaredSize:proof.size,observedAt:now});await inbox.receive(snapshot.id,job,proof.bytes);queue.complete(job,Date.now());}
     finally{this.db.prepare('DELETE FROM worker_slots WHERE token=?').run(slotToken);}
    }finally{await adapter.close();}
   }
   else if(action==='source-incoming-work'){incomingResult=await new IngressWorker(this.db,this.store,new CredentialVault(this.db,new SecretConfigs(this.codec!)),async connection=>LocalAdapter.open(String(connection.config.root))).runOnce();if(incomingResult==='applied')await this.previews();}
   else if(action==='source-export-limit'||action==='source-read-conflict'){
    const session=createSession(this.db,'qa'),actor=authenticateSession(this.db,session.token)!,latest=this.db.prepare('SELECT id,state FROM provider_ingress_snapshots WHERE document_id=? ORDER BY generation DESC LIMIT 1').get(this.notes) as {id:string;state:string}|undefined;
    new SyncActions(this.db,this.store).request(actor,this.notes,'check',{requestId:randomUUID(),baseLocalRevision:this.current(this.notes).local_revision,snapshotId:latest&&latest.state!=='discarded'?latest.id:null});
    const vault=new CredentialVault(this.db,new SecretConfigs(this.codec!));try{incomingResult=await new IngressWorker(this.db,this.store,vault,async()=>({read:async()=>{throw new ProviderError(action==='source-export-limit'?'PROVIDER_EXPORT_LIMIT':'PROVIDER_CONFLICT');},replace:async()=>{throw new Error('Owned export must not replace');},retire:async()=>{},close:async()=>{}})).runOnce();}finally{await vault.close();}
   }
   else if(action!=='source-state')throw new Error('Unknown source fixture action');
  }
  const notes=this.current(this.notes),pdf=this.current(this.pdf);return {incomingResult,notes:this.notes,pdf:this.pdf,notesRevision:notes.local_revision,notesProviderRevision:notes.provider_revision,pdfRevision:pdf.local_revision,pdfProviderRevision:pdf.provider_revision,writes:this.writes,pdfDeliveryState:(this.db.prepare("SELECT state FROM provider_delivery_attempts WHERE document_id=? AND state NOT IN ('confirmed','retired')").get(this.pdf) as {state:string}|undefined)?.state??null,notesText:await readFile(join(this.root,'notes.md'),'utf8')};
 }
}
