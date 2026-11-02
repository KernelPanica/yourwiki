import {createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {SecretError} from './secret-errors.ts';
const maxPlaintext=1048576,maxToken=2097152;
function decode(value:string,code:'INVALID_SECRET_KEY'|'INVALID_SECRET_TOKEN'){
 if(!/^[A-Za-z0-9_-]+={0,2}$/.test(value))throw new SecretError(code);
 const bytes=Buffer.from(value,'base64url'),canonical=bytes.toString('base64url');
 if(value!==canonical&&value!==bytes.toString('base64').replace(/\+/g,'-').replace(/\//g,'_')){bytes.fill(0);throw new SecretError(code);}return bytes;
}
/** Existing Fernet v0x80 configuration format; never use for large document payloads. */
export class FernetCodec{
 private key:Buffer;private closed=false;private limit:number;
 constructor(key:string|Uint8Array,options:{maxPlaintextBytes?:number}={}){
  this.limit=options.maxPlaintextBytes??maxPlaintext;if(!Number.isSafeInteger(this.limit)||this.limit<1||this.limit>maxPlaintext)throw new SecretError('INVALID_SECRET_CONFIG');
  if(!(typeof key==='string'||key instanceof Uint8Array)||key.length>44)throw new SecretError('INVALID_SECRET_KEY');const owned=decode(typeof key==='string'?key:Buffer.from(key).toString('utf8'),'INVALID_SECRET_KEY');if(owned.length!==32){owned.fill(0);throw new SecretError('INVALID_SECRET_KEY');}this.key=owned;
 }
 private active(){if(this.closed)throw new SecretError('SECRET_CLOSED');}
 encrypt(plaintext:Uint8Array):string{
  this.active();if(!(plaintext instanceof Uint8Array))throw new SecretError('INVALID_SECRET_CONFIG');if(plaintext.byteLength>this.limit)throw new SecretError('SECRET_TOO_LARGE');
  try{const iv=randomBytes(16),header=Buffer.alloc(25);header[0]=0x80;header.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000)),1);iv.copy(header,9);const cipher=createCipheriv('aes-128-cbc',this.key.subarray(16),iv),body=Buffer.concat([header,cipher.update(plaintext),cipher.final()]),mac=createHmac('sha256',this.key.subarray(0,16)).update(body).digest();return Buffer.concat([body,mac]).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');}
  catch{throw new SecretError('INVALID_SECRET_CONFIG');}
 }
 decrypt(token:string):Buffer{
  this.active();if(typeof token!=='string')throw new SecretError('INVALID_SECRET_TOKEN');if(token.length>maxToken)throw new SecretError('SECRET_TOO_LARGE');let decoded:Buffer|undefined;
  try{decoded=decode(token,'INVALID_SECRET_TOKEN');const payloadSize=decoded.length-57;if(decoded[0]!==0x80||payloadSize<16||payloadSize%16!==0)throw new SecretError('INVALID_SECRET_TOKEN');if(payloadSize>(Math.floor(this.limit/16)+1)*16)throw new SecretError('SECRET_TOO_LARGE');const body=decoded.subarray(0,-32),tag=decoded.subarray(-32),expected=createHmac('sha256',this.key.subarray(0,16)).update(body).digest();if(!timingSafeEqual(tag,expected))throw new SecretError('INVALID_SECRET_TOKEN');const decipher=createDecipheriv('aes-128-cbc',this.key.subarray(16),decoded.subarray(9,25)),plaintext=Buffer.concat([decipher.update(decoded.subarray(25,-32)),decipher.final()]);if(plaintext.length>this.limit){plaintext.fill(0);throw new SecretError('SECRET_TOO_LARGE');}return plaintext;}
  catch(error){if(error instanceof SecretError)throw error;throw new SecretError('INVALID_SECRET_TOKEN');}finally{decoded?.fill(0);}
 }
 close(){if(!this.closed){this.closed=true;this.key.fill(0);}}
}
