import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {legacyMarkdown} from '../src/office/legacy-markdown.ts';
const text=(value:string,marks:any[]=[])=>({type:'text',text:value,marks});
const native=(content:any[])=>JSON.stringify({format:'yourwiki',version:1,kind:'document',data:{type:'doc',content}});
test('legacy native documents retain headings, marks, lists, quotes, code, images and tables as Markdown',()=>{
 const content=native([{type:'heading',attrs:{level:2},content:[text('Title')]},{type:'paragraph',content:[text('bold',[{type:'bold'}]),text(' link',[{type:'link',attrs:{href:'https://example.com'}}])]},{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[text('item')]}]}]},{type:'blockquote',content:[{type:'paragraph',content:[text('quote')]}]},{type:'codeBlock',content:[text('x = 1')]},{type:'image',attrs:{alt:'alt',src:'attachment:1'}},{type:'horizontalRule'},{type:'table',content:[{type:'tableRow',content:[{type:'tableHeader',content:[text('A|B')]}]},{type:'tableRow',content:[{type:'tableCell',content:[text('value')]}]}]}]);
 assert.equal(legacyMarkdown(content),'## Title\n\n**bold**[ link](https://example.com)\n\n- item\n> quote\n\n```\nx = 1\n```\n\n![alt](attachment:1)\n---\n| A\\|B |\n| --- |\n| value |\n\n');
});
test('embedded native metadata is used only when its visible body fingerprint still matches',()=>{
 const body='# Visible\n',content=native([{type:'paragraph',content:[text('Rich',[{type:'italic'}])]}]),meta={format:'yourwiki-embedded',version:1,sha256:createHash('sha256').update(body).digest('hex'),content};
 const file='---\n'+JSON.stringify({yourwiki:meta})+'\n---\n'+body;
 assert.equal(legacyMarkdown(file),'*Rich*\n\n');assert.equal(legacyMarkdown(file+'external edit'),'# Visible\nexternal edit');
 assert.equal(legacyMarkdown('\ufeff# Plain\n'),'# Plain\n');assert.equal(legacyMarkdown('---\ntitle: ordinary YAML\n---\nbody'),'---\ntitle: ordinary YAML\n---\nbody');
});
test('legacy structure and output budgets reject malformed or excessive snapshots explicitly',()=>{
 let node:any=text('deep');for(let i=0;i<43;i++)node={type:'paragraph',content:[node]};
 assert.throws(()=>legacyMarkdown(native([node])),/INVALID_NATIVE_DOCUMENT/);assert.throws(()=>legacyMarkdown(native([{type:'heading',attrs:{level:1000000},content:[text('bad')]}])),/INVALID_NATIVE_DOCUMENT/);
 assert.throws(()=>legacyMarkdown(native([{type:'paragraph',content:[text('large')]}]),3),/PREVIEW_TOO_COMPLEX/);
});

test('unknown text marks cannot resolve inherited JavaScript object properties',()=>{
 assert.equal(legacyMarkdown(native([{type:'paragraph',content:[text('safe',[{type:'toString'},{type:'constructor'},{type:'__proto__'}])]}])),'safe\n\n');
});
