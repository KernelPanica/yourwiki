import type {CredentialVault,AdapterConnection} from './credential-vault.ts';
import type {AdapterResolver} from './delivery-worker.ts';
import type {IngressResolver} from './ingress-worker.ts';
import {LocalAdapter} from './local-adapter.ts';
import {createGoogleSourceReader} from './google-source.ts';
import {ProviderError} from './adapter.ts';
type Options={google?:{fetch?:typeof fetch;timeoutMs?:number;totalMs?:number}};
/** Direction-specific worker dispatch: a source reader never impersonates a safe writer. */
export function createProviderResolvers(vault:CredentialVault,options:Options={}):{incoming:IngressResolver;outgoing:AdapterResolver}{
 const google={...options.google};
 const local=async(connection:AdapterConnection)=>{if(connection.provider!=='local'||typeof connection.config.root!=='string')throw new ProviderError('PROVIDER_CONFIG_CHANGED');return LocalAdapter.open(connection.config.root);};
 return {
  incoming:async connection=>connection.provider==='google'?createGoogleSourceReader(vault,connection,google):local(connection),
  outgoing:local
 };
}
