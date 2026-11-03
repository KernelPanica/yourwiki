/** Owned HTTP fixture only: stop after atomic config+receipt commit and before any caller acknowledgement. */
import {openDatabase} from '../../src/database.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {GoogleConnect} from '../../src/providers/google-connect.ts';
const db=openDatabase(process.argv[2]!),input=JSON.parse(process.argv[3]!),origin=process.argv[4]!,codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),service=new GoogleConnect(db,new SecretConfigs(codec),'https://wiki.test',{fetch:async(url,init)=>{const parsed=new URL(String(url));if(!['https://oauth2.googleapis.com','https://www.googleapis.com'].includes(parsed.origin))throw new Error('Owned Google origin');return fetch(origin+parsed.pathname+parsed.search,init);}});
await service.complete(input);console.log('connected');setInterval(()=>{},1000);
