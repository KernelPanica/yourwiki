import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buffer} from 'node:stream/consumers';
import {BlobStore} from '../src/storage/blobs.ts';
import {convert} from '../src/worker/conversion.ts';
async function* bytes(value:string){yield Buffer.from(value);}
async function fixture(t:any){const root=await mkdtemp(join(tmpdir(),'yourwiki-separated-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));return {source:await BlobStore.open(join(root,'source')),target:await BlobStore.open(join(root,'target'))};}
test('historical text conversion writes only private derivatives while preserving the original store',async t=>{
 const f=await fixture(t),original=await f.source.put(bytes('# Historical\n\n**old**\n\n<script>alert(1)</script>'),{maxBytes:1000}),result=await convert(f.source,original,'md',new AbortController().signal,{},f.target);assert.equal(result.kind,'document');const html=(await buffer(await f.target.read(result.artifacts[0].digest))).toString();assert.match(html,/<strong>old<\/strong>/);assert.doesNotMatch(html,/<script>/);for(const artifact of result.artifacts){assert.equal(await f.target.verify(artifact),true);await assert.rejects(f.source.stat(artifact.digest),{code:'ENOENT'});}assert.equal(await f.source.verify(original),true);
});
test('historical PDF conversion references the original without copying a giant source into derivative storage',async t=>{
 const f=await fixture(t),original=await f.source.put(bytes('%PDF-1.7\nfixture\n%%EOF'),{maxBytes:1000}),result=await convert(f.source,original,'pdf',new AbortController().signal,{},f.target);assert.equal(result.kind,'pdf');assert.equal(result.artifacts[0].digest,original.digest);assert.equal(await f.source.verify(original),true);await assert.rejects(f.target.stat(original.digest),{code:'ENOENT'});
});
const native=process.env.YOURWIKI_TEST_OFFICE_ROOT?test:test.skip;
for(const [file,format,kind] of [['document.docx','docx','document'],['slides.pptx','pptx','presentation']] as const)native('historical '+format+' isolates sanitized artifacts and images/index in its output store',async t=>{
 const f=await fixture(t),original=await f.source.put(createReadStream(new URL('./fixtures/office/'+file,import.meta.url)),{maxBytes:1024**2}),result=await convert(f.source,original,format,new AbortController().signal,{office:{officeRoot:process.env.YOURWIKI_TEST_OFFICE_ROOT}},f.target);assert.equal(result.kind,kind);for(const artifact of result.artifacts){assert.equal(await f.target.verify(artifact),true);await assert.rejects(f.source.stat(artifact.digest),{code:'ENOENT'});}assert.equal(await f.source.verify(original),true);if(kind==='presentation'){const primary=result.artifacts.find(x=>x.name==='content')!,index=JSON.parse((await buffer(await f.target.read(primary.digest))).toString());assert.ok(index.slides.length>0);assert.ok(result.artifacts.some(x=>x.name===index.slides[0].thumbnail));}
});
