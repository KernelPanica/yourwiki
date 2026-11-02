import {FernetCodec} from './fernet.ts';
import {SecretError} from './secret-errors.ts';
const maxBytes=1048576,sources=['workspace','mount','site-ai','site-google-oauth','site-identity-oauth'] as const;
type Source=typeof sources[number];
export type LegacySecretRecord={source:Source;id:string;encrypted:string};
function invalid():never{throw new SecretError('INVALID_SECRET_CONFIG');}
/** Copy JSON data descriptors only; never invoke configuration getters/toJSON or drop unknown own keys. */
function jsonObject(value:unknown):Record<string,unknown>{
 let bytes=0,nodes=0;const ancestors=new Set<object>();const charge=(n:number)=>{bytes+=n;if(bytes>maxBytes)throw new SecretError('SECRET_TOO_LARGE');};
 const string=(text:string)=>{if(text.length>maxBytes)throw new SecretError('SECRET_TOO_LARGE');charge(Buffer.byteLength(JSON.stringify(text)));return text;};
 function copy(value:unknown,depth:number):unknown{
  if(depth>128||++nodes>100000)throw new SecretError('SECRET_TOO_LARGE');if(value===null){charge(4);return null;}if(typeof value==='string')return string(value);if(typeof value==='boolean'){charge(value?4:5);return value;}if(typeof value==='number'){if(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))invalid();charge(Object.is(value,-0)?4:String(value).length);return value;}if(typeof value!=='object')invalid();
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)invalid();if(ancestors.has(value)||Object.getOwnPropertySymbols(value).length)invalid();ancestors.add(value);
  try{const names=Object.getOwnPropertyNames(value),result:any=array?[]:Object.create(null);if(names.length>100001)throw new SecretError('SECRET_TOO_LARGE');charge(2);if(array&&((value as unknown[]).length>100000||names.length!==(value as unknown[]).length+1))invalid();let count=0;
   for(const name of names){if(array&&name==='length')continue;const descriptor=Object.getOwnPropertyDescriptor(value,name);if(!descriptor||!descriptor.enumerable||!('value' in descriptor))invalid();if(array&&name!==String(count))invalid();if(count++)charge(1);if(!array){string(name);charge(1);}Object.defineProperty(result,name,{value:copy(descriptor.value,depth+1),enumerable:true,writable:true,configurable:true});}return result;
  }finally{ancestors.delete(value);}
 }
 if(value===null||typeof value!=='object'||Array.isArray(value))invalid();return copy(value,0) as Record<string,unknown>;
}
/** Validated data only: avoid toJSON hooks and retain negative zero in both JS/Python. */
function encode(value:unknown):string{
 if(typeof value==='number'&&Object.is(value,-0))return '-0.0';
 if(Array.isArray(value))return '['+value.map(encode).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).map(name=>JSON.stringify(name)+':'+encode((value as Record<string,unknown>)[name])).join(',')+'}';
 return JSON.stringify(value);
}
/** Internal secret boundary. Nothing here registers routes, logs input or contacts a provider. */
export class SecretConfigs{
 private codec:FernetCodec;
 constructor(codec:FernetCodec){this.codec=codec;}
 encrypt(value:Record<string,unknown>):string{let plaintext:Buffer|undefined;try{plaintext=Buffer.from(encode(jsonObject(value)));return this.codec.encrypt(plaintext);}catch(error){if(error instanceof SecretError)throw error;return invalid();}finally{plaintext?.fill(0);}}
 decrypt(token:string):Record<string,unknown>{const plaintext=this.codec.decrypt(token);try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(plaintext));jsonObject(value);return value;}catch(error){if(error instanceof SecretError)throw error;return invalid();}finally{plaintext.fill(0);}}
 verifyLegacyRecord(record:LegacySecretRecord):{source:Source;id:string;state:'verified'|'empty'}{
  try{if(!record||typeof record!=='object'||Object.getOwnPropertyNames(record).length!==3||Object.getOwnPropertySymbols(record).length)invalid();const fields=Object.fromEntries(['source','id','encrypted'].map(name=>{const field=Object.getOwnPropertyDescriptor(record,name);if(!field||!('value' in field))invalid();return [name,field.value];})),{source,id,encrypted}=fields;if(!sources.includes(source)||typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)||typeof encrypted!=='string')invalid();if(!encrypted){if(!source.startsWith('site-'))invalid();return {source,id,state:'empty'};}this.decrypt(encrypted);return {source,id,state:'verified'};
  }catch(error){if(error instanceof SecretError)throw error;return invalid();}
 }
}
