/** Owned test workspace only: stop after a private partial body has reached BlobStore. */
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {ProviderIngress,type IngressInput} from '../../src/providers/ingress-inbox.ts';
const db=openDatabase(process.argv[2]!),store=await BlobStore.open(process.argv[3]!),input=JSON.parse(process.argv[4]!) as IngressInput,inbox=new ProviderIngress(db,store),snapshot=inbox.begin(input);
async function* body(){yield Buffer.alloc(65536,42);console.log(JSON.stringify({id:snapshot.id,boundary:'partial-body'}));await new Promise(()=>{});}
await inbox.receive(snapshot.id,input.job,body());
