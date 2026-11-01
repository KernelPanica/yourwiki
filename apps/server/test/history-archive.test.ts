import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {buffer} from 'node:stream/consumers';
import {Readable} from 'node:stream';
import {decodeHistoryArchive,encodeHistoryArchive} from '../src/history-archive.ts';
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function entry(value=Buffer.from('old original'),extra:Record<string,unknown>={}){return {saved_at:'2026-10-30T12:00:00.123456+03:00',revision:0,kind:'document',file_format:'',title:'Старый документ',author:{id:17,name:'Удалённый автор'},sha256:sha(value),state_reference:'provider:old',...extra,content_base64:value.toString('base64')};}
async function* parts(value:Uint8Array,width=17){for(let i=0;i<value.length;i+=width)yield value.subarray(i,i+width);}
function archive(entries:any[],extra:Record<string,unknown>={}){return Buffer.from(JSON.stringify({format:'yourwiki-history',version:1,entries,...extra}));}
async function decode(value:Uint8Array,options:Record<string,unknown>={}){const items:any[]=[];const result=await decodeHistoryArchive(parts(value),{...options,consume:async(source,index)=>({bytes:await buffer(Readable.from(source)),index}),accept:async(metadata,content,index)=>{items.push({metadata,...content,index});}});return {items,result};}
test('legacy streaming codec preserves zero/duplicate revisions, empty formats and deleted-author identities',async()=>{
 const original=Buffer.from([0,1,2,255,254,253]),entries=[entry(original),entry(Buffer.from('next'),{revision:0,kind:'table',author:null})],value=archive(entries);const decoded=await decode(value);assert.equal(decoded.result.entries,2);assert.equal(decoded.result.sha256,sha(value));assert.equal(decoded.result.size,value.length);assert.deepEqual(decoded.items.map(x=>x.metadata),entries.map(({content_base64,...metadata})=>metadata));assert.deepEqual(decoded.items[0].bytes,original);assert.equal(decoded.items[1].bytes.toString(),'next');
 const output=await buffer(Readable.from(encodeHistoryArchive((async function*(){for(const item of decoded.items)yield {metadata:item.metadata,content:parts(item.bytes,1)};})())));assert.deepEqual(JSON.parse(output.toString()),JSON.parse(value.toString()));
});
test('codec accepts arbitrary JSON field order, escaped base64 and multibyte boundaries',async()=>{
 const e=entry(Buffer.from([255,255,255]));const text='{"entries":[{"content_base64":"\\/\\/\\/\\/",'+JSON.stringify(e).slice(1).replace(/,"content_base64":"[^"]*"}/,'}')+'],"version":1,"format":"yourwiki-history"}';const result=await decodeHistoryArchive(parts(Buffer.from(text),1),{consume:async source=>buffer(Readable.from(source)),accept:async(meta,bytes)=>{assert.deepEqual(bytes,Buffer.from([255,255,255]));assert.equal(meta.title,e.title);}});assert.equal(result.entries,1);
});
test('codec refuses malformed JSON, duplicate keys, unsupported envelopes, invalid dates and author identities',async()=>{
 const bad=[Buffer.from('{"format":"yourwiki-history","version":1,"entries":[],"version":1}'),Buffer.from('{"format":"yourwiki-history","version":1,"entries":[]} trailing'),archive([entry()],{version:2}),archive([entry(Buffer.from('old original'),{saved_at:'yesterday'})]),archive([entry(Buffer.from('old original'),{revision:-1})]),archive([entry(Buffer.from('old original'),{author:{id:{},name:'bad'}})]),Buffer.from([0xff])];for(const value of bad)await assert.rejects(decode(value),/HISTORY_ARCHIVE_INVALID/);
});
test('codec rejects noncanonical base64, truncated content and mismatched digest before accepting any entry',async()=>{
 for(const encoded of ['YQ','Y===','YQ==YQ==','YQ=','YR==','Y Q==','$$$$']){const value=archive([{...entry(Buffer.from('a')),content_base64:encoded}]);await assert.rejects(decode(value),/HISTORY_ARCHIVE_INVALID/);}await assert.rejects(decode(archive([entry(Buffer.from('x'),{sha256:'a'.repeat(64)})])),/HISTORY_ARCHIVE_CORRUPT/);await assert.rejects(decode(archive([entry()]).subarray(0,-4)),/HISTORY_ARCHIVE_INVALID/);
});
test('codec bounds file, total, input, entry count and metadata without accepting a partial archive',async()=>{
 const value=archive([entry(Buffer.from('12345')),entry(Buffer.from('67890'))]);for(const options of [{maxFileBytes:4},{maxTotalBytes:9},{maxArchiveBytes:20},{maxEntries:1},{maxMetadataBytes:10}])await assert.rejects(decode(value,options),/HISTORY_ARCHIVE_LIMIT/);
});
test('codec requires sink consumption and closes the source on failure or cancellation',async()=>{
 let closed=false;async function* source(){try{yield archive([entry()]);}finally{closed=true;}}
 await assert.rejects(decodeHistoryArchive(source(),{consume:async()=>null,accept:async()=>{}}),/HISTORY_ARCHIVE_UNCONSUMED/);assert.equal(closed,true);const controller=new AbortController();controller.abort();await assert.rejects(decodeHistoryArchive(source(),{signal:controller.signal,consume:async s=>buffer(Readable.from(s)),accept:async()=>{}}),/abort/i);
});
test('streaming export rejects changed bytes and never emits a complete corrupt archive',async()=>{
 const metadata=entry();delete (metadata as any).content_base64;let completed='';await assert.rejects(async()=>{for await(const chunk of encodeHistoryArchive((async function*(){yield {metadata,content:parts(Buffer.from('changed'))};})()))completed+=Buffer.from(chunk).toString();},/HISTORY_ARCHIVE_CORRUPT/);assert.throws(()=>JSON.parse(completed));
});
test('streaming archive exceeds child heap without materializing the source, payload or JSON',async()=>{
 const {spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url');const child=spawn(process.execPath,['--max-old-space-size=48',fileURLToPath(new URL('./support/history-archive-stream-child.ts',import.meta.url)),String(64*1024**2)],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});const status=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(status,0,errors);const result=JSON.parse(output);assert.equal(result.totalBytes,64*1024**2);assert.equal(result.entries,1);assert.ok(result.size>64*1024**2);
});
test('codec refuses excessive nesting, missing payload, duplicate entry keys and calendar rollover dates',async()=>{
 const valid=entry(),{content_base64,...withoutPayload}=valid;const double=JSON.stringify(valid).replace('"revision":0','"revision":0,"revision":1');for(const input of [archive([withoutPayload]),archive([entry(Buffer.from('old original'),{saved_at:'2026-02-30T00:00:00Z'})]),Buffer.from('{"format":"yourwiki-history","version":1,"entries":['+double+']}'),archive([entry(Buffer.from('old original'),{extra:JSON.parse('['.repeat(18)+'0'+']'.repeat(18))})])])await assert.rejects(decode(input),/HISTORY_ARCHIVE_(?:INVALID|LIMIT)/);
});
test('streaming round-trip preserves every base64 remainder and empty originals across chunk boundaries',async()=>{
 for(const length of [0,1,2,3,4,5,7,8,31,64,65,257]){const value=Buffer.from(Array.from({length},(_,i)=>(i*71+length)%256)),{content_base64,...metadata}=entry(value);const encoded=await buffer(Readable.from(encodeHistoryArchive((async function*(){yield {metadata,content:parts(value,5)};})())));let accepted=false;await decodeHistoryArchive(parts(encoded,7),{consume:async source=>buffer(Readable.from(source)),accept:async(meta,content)=>{assert.deepEqual(content,value);assert.deepEqual(meta,metadata);accepted=true;}});assert.equal(accepted,true);}
});
