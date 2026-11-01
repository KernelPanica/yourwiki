import type {BlobRef} from '../storage/blobs.ts';
export type ProviderCheck={signal?:AbortSignal;check:()=>void|Promise<void>};
export type ProviderReceipt={fingerprint:string;digest:string;size:number};
export type ReplaceSource=ProviderCheck&{operationId:string;reference:string;baseline:string;target:BlobRef;source:AsyncIterable<Uint8Array>};
export interface ProviderAdapter {
 read(reference:string,options:ProviderCheck):Promise<{fingerprint:string;size:number;bytes:AsyncIterable<Uint8Array>}>;
 replace(input:ReplaceSource):Promise<ProviderReceipt>;
 retire(input:{operationId:string;reference:string;signal?:AbortSignal}):Promise<void>;
 close():Promise<void>;
}
const providerCodes=['ACCESS_DENIED','LEASE_LOST','PROVIDER_CONFIG_CHANGED','PROVIDER_SOURCE_CHANGED','PROVIDER_CONFLICT','PROVIDER_CANCELLED','PROVIDER_INVALID_REFERENCE','PROVIDER_UNAVAILABLE','PROVIDER_UNKNOWN'];
export class ProviderError extends Error {
 code:string;outcome:'not_written'|'unknown';
 constructor(code:string,outcome:'not_written'|'unknown'='not_written'){const safe=providerCodes.includes(code)?code:'PROVIDER_UNAVAILABLE';super(safe);this.code=safe;this.outcome=outcome==='unknown'?'unknown':'not_written';}
}
function data(value:unknown,key:string):unknown{try{if(!value||typeof value!=='object')return;const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;}catch{return;}}
export function safeProviderError(error:unknown,uncertain=false):ProviderError {
 const raw=data(error,'code'),code=typeof raw==='string'&&providerCodes.includes(raw)?raw:'PROVIDER_UNAVAILABLE';
 return new ProviderError(code,uncertain||error instanceof ProviderError&&data(error,'outcome')==='unknown'?'unknown':'not_written');
}
