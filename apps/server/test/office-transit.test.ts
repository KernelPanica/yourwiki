import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ZipFile} from 'yazl';
import {openPromise} from 'yauzl';
import {buffer} from 'node:stream/consumers';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transitOfficeFile} from '../src/office/transit.ts';
const ns='http://schemas.openxmlformats.org/package/2006/relationships';
async function fixture(t:any,rels:string){const root=await mkdtemp(join(tmpdir(),'yourwiki-transit-'));t.after(()=>rm(root,{recursive:true,force:true}));const zip=new ZipFile(),data=buffer(zip.outputStream);zip.addBuffer(Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),'[Content_Types].xml');zip.addBuffer(Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'),'word/document.xml');zip.addBuffer(Buffer.from(rels),'word/_rels/document.xml.rels');zip.addBuffer(Buffer.from('preserved macro payload'),'word/vbaProject.bin');zip.end();const original=await data,path=join(root,'input.docx');await writeFile(path,original);return {root,path,original};}
async function run(path:string,format='docx',options={}){const output=new PassThrough(),data=buffer(output);const result=await Promise.all([transitOfficeFile(path,format,output,new AbortController().signal,options),data]);return result[1];}
test('prefixed legacy OPC relationships are repaired while every other archive part is preserved',async t=>{
 const f=await fixture(t,`<ns0:Relationships xmlns:ns0="${ns}"><ns0:Relationship Id="r1" Type="urn:test" Target="styles.xml"/></ns0:Relationships>`),result=await run(f.path);assert.notDeepEqual(result,f.original);const path=join(f.root,'output.docx');await writeFile(path,result);const archive=await openPromise(path,{lazyEntries:true,autoClose:false});t.after(()=>archive.close());const parts=new Map<string,Buffer>();for await(const entry of archive.eachEntry())parts.set(entry.fileName,await buffer(await archive.openReadStreamPromise(entry)));
 assert.match(parts.get('word/_rels/document.xml.rels')!.toString(),new RegExp('<Relationships xmlns="'+ns+'"'));assert.equal(parts.get('word/vbaProject.bin')!.toString(),'preserved macro payload');assert.match(parts.get('word/_rels/document.xml.rels')!.toString(),/Target="styles.xml"/);
});
test('standard OPC uses exact original bytes instead of a needless archive rewrite',async t=>{
 const f=await fixture(t,`<Relationships xmlns="${ns}"><Relationship Id="r1" Type="urn:test" Target="styles.xml"/></Relationships>`);assert.deepEqual(await run(f.path),f.original);
});
test('unsupported nested relationships, DTD and oversized relationship parts fail explicitly',async t=>{
 for(const rels of [`<x:Relationships xmlns:x="${ns}"><x:Relationship><x:Nested/></x:Relationship></x:Relationships>`,`<!DOCTYPE x [<!ENTITY bad "expanded">]><x:Relationships xmlns:x="${ns}">&bad;</x:Relationships>`]){const f=await fixture(t,rels);await assert.rejects(run(f.path),/INVALID_OFFICE_FILE/);}
 const f=await fixture(t,`<x:Relationships xmlns:x="${ns}"><x:Relationship Id="${'x'.repeat(200)}"/></x:Relationships>`);await assert.rejects(run(f.path,'docx',{maxXmlBytes:100}),/OFFICE_FILE_BUDGET/);
});
test('native Markdown is converted in transit without changing the stored original',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yourwiki-transit-md-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'input.md'),source=JSON.stringify({format:'yourwiki',version:1,kind:'document',data:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Legacy'}]}]}});await writeFile(path,source);assert.equal((await run(path,'md')).toString(),'Legacy\n\n');
});

test('unrelated default namespaces do not change repaired relationship element namespaces',async t=>{
 const f=await fixture(t,`<r:Relationships xmlns:r="${ns}" xmlns="urn:unrelated"><r:Relationship xmlns="urn:child" Id="r1" Target="a&amp;b"/></r:Relationships>`),result=await run(f.path),path=join(f.root,'namespaces.docx');await writeFile(path,result);const archive=await openPromise(path,{autoClose:false,lazyEntries:true});t.after(()=>archive.close());for await(const entry of archive.eachEntry())if(entry.fileName==='word/_rels/document.xml.rels'){const xml=(await buffer(await archive.openReadStreamPromise(entry))).toString();assert.equal(xml.includes('xmlns="urn:unrelated"'),false);assert.equal(xml.includes('xmlns="urn:child"'),false);assert.match(xml,/Target="a&amp;b"/);}
});
