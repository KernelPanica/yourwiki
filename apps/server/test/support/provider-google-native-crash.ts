/** Owned fixture only: stop after native export bytes actually reached private BlobStore. */
import {openDatabase} from '../../src/database.ts';
import {BlobStore} from '../../src/storage/blobs.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {CredentialVault} from '../../src/providers/credential-vault.ts';
import {createGoogleSourceReader} from '../../src/providers/google-source.ts';
import {IngressWorker} from '../../src/providers/ingress-worker.ts';
const db=openDatabase(process.argv[2]!),store=await BlobStore.open(process.argv[3]!),origin=process.argv[4]!,now=Number(process.argv[5]),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),upload=store.uploadStore.bind(store);let reported=false;
store.uploadStore=async id=>{const target=await upload(id),put=target.put.bind(target);target.put=(source,options)=>put((async function*(){let size=0;for await(const chunk of source){yield chunk;size+=chunk.byteLength;if(size>=4096&&!reported){reported=true;console.log(JSON.stringify({boundary:'native-private-bytes',namespace:id,size}));}}})(),options);return target;};
const request:typeof fetch=async(url,init)=>{const parsed=new URL(String(url));if(!['https://oauth2.googleapis.com','https://www.googleapis.com'].includes(parsed.origin))throw new Error('Owned fixture endpoint');return fetch(origin+parsed.pathname+parsed.search,init);},vault=new CredentialVault(db,new SecretConfigs(codec),{google:{fetch:request}});
try{await new IngressWorker(db,store,vault,async connection=>({...createGoogleSourceReader(vault,connection,{fetch:request}),replace:async()=>{throw new Error('must not write');},retire:async()=>{throw new Error('must not retire');}}),{clock:()=>now}).runOnce();}finally{await vault.close();codec.close();db.close();}
