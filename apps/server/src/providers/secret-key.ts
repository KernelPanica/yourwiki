import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {FernetCodec} from './fernet.ts';
import {SecretError} from './secret-errors.ts';
/** Explicit existing installation key only. Never creates or changes a key/file. */
export async function loadSecretCodec(path:string):Promise<FernetCodec>{
 let handle:Awaited<ReturnType<typeof open>>|undefined,codec:FernetCodec|undefined;const buffer=Buffer.alloc(129);
 try{
  if(typeof path!=='string'||!path||path.includes('\0'))throw new SecretError('SECRET_KEY_UNAVAILABLE');
  handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.size>128)throw new SecretError('SECRET_KEY_UNAVAILABLE');
  let size=0;while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}if(size>128)throw new SecretError('SECRET_KEY_UNAVAILABLE');
  const encoded=buffer.subarray(0,size).toString('utf8').replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g,'');codec=new FernetCodec(encoded);return codec;
 }catch(error){if(error instanceof SecretError)throw error;throw new SecretError('SECRET_KEY_UNAVAILABLE');}
 finally{buffer.fill(0);try{await handle?.close();}catch{codec?.close();throw new SecretError('SECRET_KEY_UNAVAILABLE');}}
}
