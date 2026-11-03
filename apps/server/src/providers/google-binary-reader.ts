import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {GoogleAuthorization} from './credential-vault.ts';
import {GoogleSourceReader,type GoogleReaderOptions} from './google-reader.ts';
/** Explicit binary boundary used by binary delivery/read protocols; never falls through to export. */
export class GoogleBinaryReader{
 private reader:GoogleSourceReader;
 constructor(root:string,auth:GoogleAuthorization,managed:(reference:string,options:ProviderCheck)=>Promise<readonly string[]>,options:Omit<GoogleReaderOptions,'binaryOnly'|'format'>={}){this.reader=new GoogleSourceReader(root,auth,managed,{...options,binaryOnly:true});}
 changed(reference:string,baseline:string,options:ProviderCheck){return this.reader.changed(reference,baseline,options);}
 async read(reference:string,options:ProviderCheck):Promise<{fingerprint:string;size:number;bytes:AsyncIterable<Uint8Array>}>{const result=await this.reader.read(reference,options);if(result.size===null)throw new ProviderError('PROVIDER_SOURCE_CHANGED');return result;}
 close(){return this.reader.close();}
}
