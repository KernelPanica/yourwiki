/** Owned synthetic fixture only; never reads credentials from arguments/environment. */
import {openDatabase} from '../../src/database.ts';
import {FernetCodec} from '../../src/providers/fernet.ts';
import {SecretConfigs} from '../../src/providers/secret-config.ts';
import {OAuthRefreshes} from '../../src/providers/oauth-refresh.ts';
const db=openDatabase(process.argv[2]),codec=new FernetCodec('cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4='),mode=process.argv[3];
if(!['reserved','dispatched','accepted'].includes(mode))throw new Error('Invalid owned fixture phase');
const lease=new OAuthRefreshes(db,new SecretConfigs(codec),{clock:()=>1000}).claim('google',1);if(!lease)throw new Error('Owned refresh lease unavailable');
if(mode!=='reserved')lease.dispatch();if(mode==='accepted')lease.accept('SYNTHETIC-NEW');
console.log(JSON.stringify({phase:mode,requestId:lease.requestId}));setInterval(()=>{},60000);
