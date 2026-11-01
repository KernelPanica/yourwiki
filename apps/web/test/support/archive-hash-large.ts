/** Manual bounded-memory acceptance: node --max-old-space-size=48 apps/web/test/support/archive-hash-large.ts */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hashArchive} from '../../src/archive-hash.ts';
const size=4*1024**3+73,chunk=Buffer.alloc(1024*1024,0x5a),expected=createHash('sha256');let seen=0,maxSlice=0;
const source={size,slice:(start:number,end:number)=>{assert.equal(start,seen);maxSlice=Math.max(maxSlice,end-start);assert.ok(end-start<=chunk.length);return new Blob([chunk.subarray(0,end-start)]);}};
const start=performance.now(),digest=await hashArchive(source,new AbortController().signal,bytes=>{expected.update(chunk.subarray(0,bytes-seen));seen=bytes;});assert.equal(digest,expected.digest('hex'));assert.equal(seen,size);console.log(JSON.stringify({bytes:size,maxSlice,maxRssKiB:process.resourceUsage().maxRSS,heapLimitMiB:48,elapsedMs:Math.round(performance.now()-start),digestMatched:true}));
