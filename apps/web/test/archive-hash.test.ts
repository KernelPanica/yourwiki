import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {Sha256,hashArchive} from '../src/archive-hash.ts';
test('incremental archive SHA256 matches independent crypto across padding and read-window boundaries',()=>{
 for(const size of [0,1,55,56,63,64,65,127,128,1000,1024*1024+73]){const bytes=Buffer.alloc(size);for(let i=0;i<size;i++)bytes[i]=(i*29+7)%256;for(const chunk of [1,7,64,1024*1024]){const hash=new Sha256();for(let i=0;i<size;i+=chunk)hash.update(bytes.subarray(i,i+chunk));assert.equal(hash.digest(),createHash('sha256').update(bytes).digest('hex'));assert.throws(()=>hash.update(new Uint8Array(1)));assert.throws(()=>hash.digest());}}
});
test('archive hashing reads bounded slices, reports progress and aborts without reading the whole blob',async()=>{
 const data=Buffer.alloc(1024*1024*3+7,25),reads:number[]=[],progress:number[]=[],blob=new Blob([data]);const source={size:blob.size,slice:(start:number,end:number)=>{reads.push(end-start);return blob.slice(start,end);}};const actual=await hashArchive(source,new AbortController().signal,n=>progress.push(n));assert.equal(actual,createHash('sha256').update(data).digest('hex'));assert.equal(reads.length,4);assert.ok(reads.every(n=>n<=1024*1024));assert.equal(progress.at(-1),data.length);
 const controller=new AbortController();let called=0;await assert.rejects(hashArchive(source,controller.signal,()=>{called++;controller.abort();}));assert.equal(called,1);
});
