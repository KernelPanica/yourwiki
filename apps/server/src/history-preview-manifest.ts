import {DocumentError} from './document-errors.ts';
import type {ConversionResult} from './worker/conversion.ts';
export const historyPreviewVersion='history-preview-v1';
export const historyPreviewReservation=129*1024**2;
export type HistoryArtifact=ConversionResult['artifacts'][number]&{storage:'main'|'prepared'};
export type HistoryPreviewManifest={schemaVersion:1;documentId:string;entryId:number;preparedId:string;converterVersion:string;sourceDigest:string;sourceSize:number;format:string;kind:ConversionResult['kind'];primary:string;artifacts:HistoryArtifact[]};
export function validResult(value:ConversionResult){
 if(!value||!['document','table','presentation','pdf'].includes(value.kind)||!Array.isArray(value.artifacts)||!value.artifacts.length||value.artifacts.length>1024)throw new DocumentError('INVALID_PREVIEW');const names=new Set<string>();
 for(const asset of value.artifacts){if(!asset||typeof asset.name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(asset.name)||names.has(asset.name)||!(/^[a-f0-9]{64}$/).test(asset.digest)||!Number.isSafeInteger(asset.size)||asset.size<0||typeof asset.mimeType!=='string'||!(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).test(asset.mimeType))throw new DocumentError('INVALID_PREVIEW');names.add(asset.name);}
 const primary=value.artifacts.find(x=>x.name===value.primary),mime=value.kind==='presentation'?'application/json':value.kind==='pdf'?'application/pdf':'text/html';if(!primary||primary.mimeType!==mime)throw new DocumentError('INVALID_PREVIEW');
}
