import {SaxesParser} from 'saxes';
import {DocumentError} from '../document-errors.ts';
export const graphBytes=8*1024**2,attachmentBytes=10*1024**2,maxSummaryCharacters=100000;
export function invalid():never{throw new DocumentError('INVALID_REQUEST');}
export const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function shape(value:unknown,required:string[],optional:string[]=[]):Record<string,any>{if(!object(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))invalid();return value;}
export function integer(value:unknown,min=0):number{if(!Number.isSafeInteger(value)||(value as number)<min)invalid();return value as number;}
export function text(value:unknown,limit:number,empty=false):string{if(typeof value!=='string'||value.length>limit||(!empty&&!value.trim())||value.includes('\0'))invalid();return value;}
export function decode(bytes:Uint8Array):string{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return invalid();}}
/** Iterative depth/node limits also protect the retained unknown extension fields. */
export function boundedJSON(value:unknown,maxBytes:number){let encoded:string;try{encoded=JSON.stringify(value);}catch{return invalid();}if(!encoded||Buffer.byteLength(encoded)>maxBytes)invalid();let nodes=0;const stack:[unknown,number][]=[[value,0]];while(stack.length){const [item,depth]=stack.pop()!;if(++nodes>200000||depth>100)invalid();if(item!==null&&typeof item==='object')for(const child of Object.values(item))stack.push([child,depth+1]);}return encoded;}
/** Validate structure without reserializing source, retaining extension keys and compressed XML. */
export function validateGraph(source:string,format:string){
 if(Buffer.byteLength(source)>graphBytes)invalid();
 if(format==='canvas'||source.trimStart().startsWith('{')){let value:unknown;try{value=JSON.parse(source);}catch{return invalid();}boundedJSON(value,graphBytes);if(!object(value))invalid();
  const native=value.format==='yourwiki'&&value.version===1;if(native&&value.kind!==format)invalid();const data=native?value.data:value;if(!object(data))invalid();
  if(format==='canvas'){for(const [name,limit] of [['nodes',20000],['edges',40000]] as const){const items=data[name]??[];if(!Array.isArray(items)&&!object(items)||Object.keys(items).length>limit)invalid();for(const item of Object.values(items))if(!object(item))invalid();}}
  else if(format==='drawio'){if(!native||!object(data.pages)||!Array.isArray(data.order)||data.order.length>200)invalid();}else invalid();return;
 }
 if(format!=='drawio')invalid();let depth=0,count=0,root='';const parser=new SaxesParser();parser.on('doctype',()=>invalid());parser.on('opentag',tag=>{if(++depth>100||++count>200000)invalid();if(!root)root=tag.name;});parser.on('closetag',()=>depth--);parser.on('error',()=>invalid());try{parser.write(source).close();}catch{return invalid();}if(!['mxfile','mxGraphModel','diagram'].includes(root))invalid();
}
