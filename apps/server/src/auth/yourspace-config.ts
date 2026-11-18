import {open,constants} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {issuerOrigin,type YourspaceLoginOptions} from './yourspace-oidc.ts';
export async function configuredYourspaceLogin(env:NodeJS.ProcessEnv):Promise<YourspaceLoginOptions|undefined>{
 const clientId=env.YOURWIKI_YOURSPACE_CLIENT_ID,file=env.YOURWIKI_YOURSPACE_CLIENT_SECRET_FILE;if(!clientId&&!file)return undefined;
 if(!clientId||!file||!isAbsolute(file)||!env.YOURWIKI_YOURSPACE_ISSUER)throw Error('INVALID_YOURSPACE_CONFIG');
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile()||stat.size>1024||(stat.mode&0o077)!==0)throw Error('INVALID_YOURSPACE_CONFIG');const secret=(await handle.readFile('utf8')).trim();if(!secret||secret.length>512)throw Error('INVALID_YOURSPACE_CONFIG');return {issuer:issuerOrigin(env.YOURWIKI_YOURSPACE_ISSUER),clientId,clientSecret:secret};}finally{await handle.close();}
}
