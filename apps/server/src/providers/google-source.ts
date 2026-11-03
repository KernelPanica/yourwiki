import {ProviderError,type ProviderCheck} from './adapter.ts';
import type {CredentialVault,AdapterConnection} from './credential-vault.ts';
import {GoogleBinaryReader} from './google-binary-reader.ts';
const types:Record<string,readonly string[]>={
 md:['text/markdown','text/x-markdown','text/plain'],pdf:['application/pdf'],
 doc:['application/msword'],docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],docm:['application/vnd.ms-word.document.macroEnabled.12'],odt:['application/vnd.oasis.opendocument.text'],rtf:['application/rtf','text/rtf'],
 xls:['application/vnd.ms-excel'],xlsx:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],xlsm:['application/vnd.ms-excel.sheet.macroEnabled.12'],xlsb:['application/vnd.ms-excel.sheet.binary.macroEnabled.12'],ods:['application/vnd.oasis.opendocument.spreadsheet'],csv:['text/csv','application/csv','text/plain','application/vnd.ms-excel'],tsv:['text/tab-separated-values','text/plain'],
 ppt:['application/vnd.ms-powerpoint'],pptx:['application/vnd.openxmlformats-officedocument.presentationml.presentation'],pptm:['application/vnd.ms-powerpoint.presentation.macroEnabled.12'],odp:['application/vnd.oasis.opendocument.presentation'],
 canvas:['application/json','text/plain'],drawio:['application/vnd.jgraph.mxfile','application/xml','text/xml','text/plain']
};
/** Generic Drive blob MIME is common for valid uploaded files; the existing converter still
 * validates actual structure before publishing. Never infer native type from a filename. */
export function googleBinaryMimeMatches(format:string,mime:string):boolean{
 if(typeof format!=='string'||!/^[a-z0-9][a-z0-9.-]{0,31}$/.test(format)||typeof mime!=='string')return false;const normalized=mime.toLowerCase();if(normalized.startsWith('application/vnd.google-apps.'))return false;
 if(normalized==='application/octet-stream')return true;return !Object.hasOwn(types,format)||types[format].some(type=>type.toLowerCase()===normalized);
}
/** Worker-only bound binary reader factory. Not a complete/native/write provider adapter. */
export function createGoogleBinarySource(vault:CredentialVault,connection:AdapterConnection,options:{fetch?:typeof fetch;timeoutMs?:number;totalMs?:number}={}){
 const source=vault.googleSource(connection),reader=new GoogleBinaryReader(source.root,vault.google(connection),vault.googleRecipients(connection),{...options,acceptMime:mime=>googleBinaryMimeMatches(source.format,mime)});
 return Object.freeze({
  read:async(reference:string,options:ProviderCheck)=>{
   source.check();if(reference!==source.reference)throw new ProviderError('PROVIDER_INVALID_REFERENCE');
   return reader.read(source.reference,{signal:options.signal,check:async()=>{source.check();await options.check();source.check();}});
  },
  close:()=>reader.close()
 });
}
