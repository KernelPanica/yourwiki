/** Owned fixture: consume consent durably, POST once, then parent kills while awaiting response. */
import {openDatabase} from '../../src/database.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {GoogleConnectStates} from '../../src/providers/google-connect-state.ts';
import {GoogleCodeExchange} from '../../src/providers/google-code-exchange.ts';
const db=openDatabase(process.argv[2]!),actor=JSON.parse(process.argv[3]!),origin=process.argv[4]!,codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),states=new GoogleConnectStates(db,new SecretConfigs(codec),'https://wiki.test'),http=new GoogleCodeExchange({fetch:async(url,init)=>{if(url!=='https://oauth2.googleapis.com/token')throw new Error('Owned token endpoint');return fetch(origin+'/token',init);}});
try{await http.exchange(states.claim(actor),'OWNED_CODE',{check(){}});}finally{await http.close();codec.close();db.close();}
