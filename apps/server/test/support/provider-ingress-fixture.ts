import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ProviderIngress} from '../../src/providers/ingress-inbox.ts';
import {historyFixture} from './history-fixture.ts';
import {JobQueue} from '../../src/jobs.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {ProviderConnections} from '../../src/providers/connections.ts';
import {CredentialVault} from '../../src/providers/credential-vault.ts';
import {bindExistingSource} from '../../src/providers/source-bindings.ts';
export async function setupIngress(t:any,options:{providerRoot?:string;maxPendingBytes?:number;maxRecords?:number}={}){const f=await historyFixture(t),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=');t.after(()=>codec.close());new ProviderConnections(f.db,new SecretConfigs(codec)).create('admin',{id:'local',provider:'local',label:'Local',path:'/',folderId:null,config:{root:options.providerRoot??'/synthetic'}});bindExistingSource(f.db,{documentId:f.first.documentId,connectionId:'local',reference:'original.md',fingerprint:'baseline',confirmedRevision:2,confirmedDigest:f.next.blob.digest,confirmedSize:f.next.blob.size,now:Date.now()});const queue=new JobQueue(f.db);let now=Date.now();const inbox=new ProviderIngress(f.db,f.store,{clock:()=>now,...options});function claim(){queue.enqueue({kind:'provider.pull',key:randomUUID(),payload:{documentId:f.first.documentId}},now);const job=queue.claim(now,30000,'provider.pull');assert.ok(job);const slotToken=randomUUID();f.db.prepare("INSERT INTO worker_slots VALUES('provider-source',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slotToken,now+30000);return {job,slotToken,documentId:f.first.documentId,connectionRevision:1,baseLocalRevision:2,baseProviderRevision:2,baseFingerprint:'baseline',observedFingerprint:'external-version',declaredSize:3,observedAt:now};}return {...f,vault:new CredentialVault(f.db,new SecretConfigs(codec)),queue,inbox,claim,tick:(delta:number)=>now+=delta,clock:()=>now};}
