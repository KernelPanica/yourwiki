import {RcloneDriveAdapter} from '../rclone/adapter.ts';
import {createGoogleMarkdownAdapter} from './google-markdown-write.ts';
import type {CredentialVault,AdapterConnection} from './credential-vault.ts';
import type {AdapterResolver} from './delivery-worker.ts';
import type {IngressResolver} from './ingress-worker.ts';
import {LocalAdapter} from './local-adapter.ts';
import {createGoogleSourceReader} from './google-source.ts';
import {openGithubStorage} from './github-adapter.ts';
import {openOneDriveStorage} from './onedrive-adapter.ts';
import {openNetworkStorage} from './network-adapter.ts';
import {ProviderError} from './adapter.ts';
type Options={google?:{fetch?:typeof fetch;timeoutMs?:number;totalMs?:number}};
/** Direction-specific worker dispatch: a source reader never impersonates a safe writer. */
export function createProviderResolvers(vault:CredentialVault,options:Options={}):{incoming:IngressResolver;outgoing:AdapterResolver}{
 const google={...options.google};
 const local=async(connection:AdapterConnection)=>{if(connection.provider==='github')return openGithubStorage(connection.config);if(connection.provider==='onedrive')return openOneDriveStorage(connection.config,{onRefresh:async token=>{vault.persistRefresh(connection,token);}});if(connection.provider==='sftp'||connection.provider==='smb')return openNetworkStorage(connection.provider,connection.config);if(connection.provider!=='local'||typeof connection.config.root!=='string')throw new ProviderError('PROVIDER_CONFIG_CHANGED');return LocalAdapter.open(connection.config.root,{requireMount:connection.config.requireMount===true});};
 return {
  incoming:async connection=>{if(connection.provider!=='google')return local(connection);const source=vault.rcloneSource(connection);return source?new RcloneDriveAdapter(source):createGoogleSourceReader(vault,connection,google);},
  outgoing:async connection=>{if(connection.provider==='google'){const source=vault.rcloneSource(connection);if(!source)return createGoogleMarkdownAdapter(vault,connection,google);const authority=vault.googleWriteAuthority(connection),canonical=vault.googleSource(connection),check=source.check;source.check=()=>{check();authority.check();canonical.checkBaseline();};const adapter=new RcloneDriveAdapter(source);return {read:adapter.read.bind(adapter),changed:adapter.changed.bind(adapter),replace:input=>{if(input.operationId!==authority.operationId)throw new ProviderError('PROVIDER_INVALID_REFERENCE');return adapter.replace(input);},retire:adapter.retire.bind(adapter),close:adapter.close.bind(adapter)};}return local(connection);}
 };
}
