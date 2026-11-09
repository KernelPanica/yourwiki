import type {ProviderAdapter,ProviderCheck,ProviderReceipt,ReplaceSource} from './adapter.ts';
export type RemoteFile={reference:string;name:string;kind:'file'|'folder';size?:number};
export interface RemoteStorage extends ProviderAdapter{list(reference:string,scope:ProviderCheck):Promise<RemoteFile[]>;create(input:Omit<ReplaceSource,'baseline'>):Promise<ProviderReceipt>;}
