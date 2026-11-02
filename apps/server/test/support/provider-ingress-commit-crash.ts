/** Owned fixtures only: pause around the atomic ingress receipt boundary. */
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {ProviderIngress} from '../../src/providers/ingress-inbox.ts';
const db=openDatabase(process.argv[2]!),store=await BlobStore.open(process.argv[3]!),id=process.argv[4]!,job=JSON.parse(process.argv[5]!),mode=process.argv[6]!;
if(mode==='before'){const adopt=store.adopt.bind(store);store.adopt=async(...args)=>{await adopt(...args);console.log('adopted-before-receipt');await new Promise(()=>{});throw new Error('unreachable');};}
const receipt=await new ProviderIngress(db,store).commit(id,job);console.log(JSON.stringify(receipt));setInterval(()=>{},60000);
