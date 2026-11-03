/** Owned crash fixture only. Every provider request is redirected to the parent loopback server. */
import {openDatabase} from '../../src/database.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {GoogleNativeJournal} from '../../src/providers/google-native-journal.ts';
import {GoogleNativeWrite} from '../../src/providers/google-native-write.ts';
import {CredentialVault} from '../../src/providers/credential-vault.ts';
import {createGoogleNativeSnapshotReader} from '../../src/providers/google-native-snapshot.ts';
import type {DeliveryAttempt} from '../../src/providers/delivery-attempts.ts';
const db=openDatabase(process.argv[2]!),attempt=JSON.parse(process.argv[3]!) as DeliveryAttempt,mode=process.argv[4],origin=new URL(process.argv[5]!),now=Number(process.argv[6]);if(!['reserved','dispatched','accepted'].includes(mode!)||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1')throw new Error('Owned journal boundary');
const codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),configs=new SecretConfigs(codec),journal=new GoogleNativeJournal(db,configs,{clock:()=>now}),request:typeof fetch=async(url,init)=>{const parsed=new URL(String(url));if(!['https://oauth2.googleapis.com','https://www.googleapis.com','https://docs.googleapis.com'].includes(parsed.origin))throw new Error('Owned Google origin');return fetch(origin.origin+parsed.pathname+parsed.search,init);};
setInterval(()=>{},1000);
if(mode==='reserved')console.log('reserved');else{
 const vault=new CredentialVault(db,configs,{google:{fetch:request}}),connection=vault.forAttempt(attempt),source=createGoogleNativeSnapshotReader(vault,connection,{fetch:request}),writer=new GoogleNativeWrite(vault.google(connection),{fetch:request});
 await journal.dispatch(attempt,{apply:async(command,options)=>{if(mode==='dispatched'){console.log('dispatched');return new Promise(()=>{});}await writer.apply(command,options);console.log('accepted');return new Promise(()=>{});}},{check(){},verify:async scope=>{const value=await source.read(scope);if(value.revision!==journal.load(attempt)!.command!.requiredRevisionId)throw new Error('Owned native baseline changed');}});
}
