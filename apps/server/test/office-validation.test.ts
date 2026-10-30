import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BlobStore} from '../src/storage/blobs.ts';
import {validateOfficeFile} from '../src/office/validation.ts';
async function fixture(t:any){const root=await mkdtemp(join(tmpdir(),'yourwiki-office-validate-'));t.after(()=>rm(root,{recursive:true,force:true}));return BlobStore.open(root);}
async function* bytes(value:Uint8Array|string){yield typeof value==='string'?Buffer.from(value):value;}
function zip(entries:[string,string|Buffer][]){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [name,value] of entries){const n=Buffer.from(name),data=typeof value==='string'?Buffer.from(value):value,h=Buffer.alloc(30),c=Buffer.alloc(46);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc32(data),14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc32(data),16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);local.push(h,n,data);central.push(c,n);offset+=h.length+n.length+data.length;}
 const end=Buffer.alloc(22),directory=Buffer.concat(central);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
test('real DOCX/XLSX/ODS/PPTX fixtures validate without loading whole files into a Buffer',async t=>{
 const store=await fixture(t);for(const [name,format] of [['document.docx','docx'],['table.xlsx','xlsx'],['table.ods','ods'],['slides.pptx','pptx']]){
  const blob=await store.put(createReadStream(new URL('./fixtures/office/'+name,import.meta.url)),{maxBytes:20*1024**2});await validateOfficeFile(store,blob,format!);
  if(format==='docx')await assert.rejects(validateOfficeFile(store,blob,'xlsx'),/INVALID_OFFICE_FILE/);
 }
});
test('text validates UTF8 and NUL, OLE/RTF/flat ODF validate format signatures',async t=>{
 const store=await fixture(t);for(const [format,value,valid] of [['md','Привет',true],['md','a\0b',false],['txt',Buffer.from([0xff]),false],['rtf','{\\rtf1 test}',true],['rtf','wrong',false],['doc',Buffer.from('d0cf11e0a1b11ae1','hex'),true],['fodt','<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',true]] as const){
  const blob=await store.put(bytes(value),{maxBytes:1000});if(valid)await validateOfficeFile(store,blob,format);else await assert.rejects(validateOfficeFile(store,blob,format),/INVALID_OFFICE_FILE/);
 }
});
test('archives reject unsafe paths, duplicate entries, wrong parts, XML entities and declared expansion budget',async t=>{
 const store=await fixture(t);const cases:[string,string][][]=[
  [['../escape','x'],['word/document.xml','<document/>'],['[Content_Types].xml','<types/>']],
  [['word/document.xml','<document/>'],['word/document.xml','<second/>'],['[Content_Types].xml','<types/>']],
  [['word/document.xml','<!DOCTYPE x [<!ENTITY e "x">]><document>&e;</document>'],['[Content_Types].xml','<types/>']],
  [['unrelated','text']],
 ];for(const entries of cases){const blob=await store.put(bytes(zip(entries)),{maxBytes:10000});await assert.rejects(validateOfficeFile(store,blob,'docx'),/INVALID_OFFICE_FILE/);}
 const blob=await store.put(bytes(zip([['word/document.xml','<document/>'],['[Content_Types].xml','<types/>']])),{maxBytes:10000});await assert.rejects(validateOfficeFile(store,blob,'docx',{maxExpandedBytes:2}),/OFFICE_FILE_BUDGET/);
});
test('large unfinished XML attributes are bounded and selected archive parts verify CRC',async t=>{
 const store=await fixture(t);const huge=zip([['word/document.xml','<doc attribute="'+'x'.repeat(1200000)+'"/>'],['[Content_Types].xml','<types/>']]);
 const blob=await store.put(bytes(huge),{maxBytes:2000000});await assert.rejects(validateOfficeFile(store,blob,'docx'),/OFFICE_FILE_BUDGET/);
 const corrupt=zip([['word/document.xml','<document/>'],['[Content_Types].xml','<types/>']]);corrupt[corrupt.indexOf(Buffer.from('<document/>'))+1]=68;
 const other=await store.put(bytes(corrupt),{maxBytes:10000});await assert.rejects(validateOfficeFile(store,other,'docx'),/INVALID_OFFICE_FILE/);
});
test('combined attribute values cannot grow an unclosed tag without bound',async t=>{
 const store=await fixture(t);const attributes=Array.from({length:80},(_,i)=>` a${i}="${'x'.repeat(16384)}"`).join('');
 const blob=await store.put(bytes(zip([['word/document.xml','<document'+attributes+'/>'],['[Content_Types].xml','<types/>']])),{maxBytes:2000000});await assert.rejects(validateOfficeFile(store,blob,'docx'),/OFFICE_FILE_BUDGET/);
});


test('valid UTF16 XML remains supported in office containers and flat ODF',async t=>{
 const store=await fixture(t);const xml='<?xml version="1.0" encoding="UTF-16"?><document/>';const utf16=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(xml,'utf16le')]);
 const archive=await store.put(bytes(zip([['word/document.xml',utf16],['[Content_Types].xml','<types/>']])),{maxBytes:10000});await validateOfficeFile(store,archive,'docx');
 const flat='<?xml version="1.0" encoding="UTF-16"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>';
 const be=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(flat,'utf16le')]).swap16();const blob=await store.put(bytes(be),{maxBytes:10000});await validateOfficeFile(store,blob,'fodt');
});
