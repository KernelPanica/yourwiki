/** Incremental SHA-256; the import worker keeps at most one 1MiB file slice in JS memory. */
const constants=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate=(word:number,bits:number)=>(word>>>bits)|(word<<(32-bits));
export class Sha256{
 private state=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);private words=new Uint32Array(64);private tail=new Uint8Array(64);private used=0;private length=0;private finished=false;
 private compress(bytes:Uint8Array,offset:number){
  const words=this.words;for(let i=0;i<16;i++){const at=offset+i*4;words[i]=(bytes[at]<<24)|(bytes[at+1]<<16)|(bytes[at+2]<<8)|bytes[at+3];}
  for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2],s0=rotate(a,7)^rotate(a,18)^(a>>>3),s1=rotate(b,17)^rotate(b,19)^(b>>>10);words[i]=(words[i-16]+s0+words[i-7]+s1)>>>0;}
  let [a,b,c,d,e,f,g,h]=this.state;
  for(let i=0;i<64;i++){const sum1=rotate(e,6)^rotate(e,11)^rotate(e,25),choose=(e&f)^(~e&g),t1=(h+sum1+choose+constants[i]+words[i])>>>0,sum0=rotate(a,2)^rotate(a,13)^rotate(a,22),majority=(a&b)^(a&c)^(b&c),t2=(sum0+majority)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
  const values=[a,b,c,d,e,f,g,h];for(let i=0;i<8;i++)this.state[i]=(this.state[i]+values[i])>>>0;
 }
 update(bytes:Uint8Array){if(this.finished||!Number.isSafeInteger(this.length+bytes.length))throw new Error('INVALID_HASH_STATE');this.length+=bytes.length;let offset=0;if(this.used){const count=Math.min(64-this.used,bytes.length);this.tail.set(bytes.subarray(0,count),this.used);this.used+=count;offset=count;if(this.used===64){this.compress(this.tail,0);this.used=0;}}
  while(offset+64<=bytes.length){this.compress(bytes,offset);offset+=64;}if(offset<bytes.length){this.tail.set(bytes.subarray(offset),this.used);this.used+=bytes.length-offset;}return this;
 }
 digest(){if(this.finished)throw new Error('INVALID_HASH_STATE');this.finished=true;const length=this.used<56?64:128,padded=new Uint8Array(length);padded.set(this.tail.subarray(0,this.used));padded[this.used]=128;new DataView(padded.buffer).setBigUint64(length-8,BigInt(this.length)*8n);for(let i=0;i<length;i+=64)this.compress(padded,i);return Array.from(this.state,n=>n.toString(16).padStart(8,'0')).join('');}
}
export async function hashArchive(blob:Pick<Blob,'size'|'slice'>,signal:AbortSignal,progress:(bytes:number)=>void=()=>{}){if(!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>64*1024**3)throw new Error('HISTORY_ARCHIVE_LIMIT');const hash=new Sha256();for(let offset=0;offset<blob.size;offset+=1024*1024){signal.throwIfAborted();const end=Math.min(blob.size,offset+1024*1024),bytes=new Uint8Array(await blob.slice(offset,end).arrayBuffer());signal.throwIfAborted();if(bytes.length!==end-offset)throw new Error('HISTORY_ARCHIVE_READ_FAILED');hash.update(bytes);progress(end);}signal.throwIfAborted();return hash.digest();}
