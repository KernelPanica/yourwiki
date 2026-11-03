/** Owned local fixture only; report a committed journal boundary and wait for SIGKILL. */
import {openDatabase} from '../../src/database.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {GoogleUploadJournal} from '../../src/providers/google-upload-journal.ts';
import type {DeliveryAttempt} from '../../src/providers/delivery-attempts.ts';
const db=openDatabase(process.argv[2]!),attempt=JSON.parse(process.argv[3]!) as DeliveryAttempt,phase=process.argv[4],now=Number(process.argv[5]),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),journal=new GoogleUploadJournal(db,new SecretConfigs(codec));
if(!['initiating','dispatched'].includes(phase!))throw new Error('Owned journal boundary');journal.reserve(attempt,now);journal.markInitiating(attempt,now+1);if(phase==='dispatched'){journal.attach(attempt,'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=OWNED_PRIVATE_SESSION',now+2);journal.markDispatched(attempt,now+3);}console.log(phase);setInterval(()=>{},1000);
