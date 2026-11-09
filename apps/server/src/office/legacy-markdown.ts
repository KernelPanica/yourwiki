import {createHash} from 'node:crypto';
type Node={type:string;text?:string;content?:Node[];marks?:{type:string;attrs?:Record<string,unknown>}[];attrs?:Record<string,unknown>};
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const markers=new Map([['bold','**'],['italic','*'],['strike','~~'],['code','`']]);
const parse=(text:string):unknown=>{try{return JSON.parse(text);}catch{return null;}};
const invalid=():never=>{throw new Error('INVALID_NATIVE_DOCUMENT');};
/** Legacy wiki.file_formats.read_markdown + wiki.native.markdown_export, without modifying source bytes. */
export function legacyMarkdown(value:string,maxOutputBytes=16*1024**2):string{
 if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1)throw new Error('PREVIEW_TOO_COMPLEX');
 let source=value.replace(/^\ufeff/,'');
 if(source.startsWith('---\n')){
  const end=source.indexOf('\n---\n',4);
  if(end>=0){const header=parse(source.slice(4,end));if(object(header)&&header.yourwiki!=null){
   const body=source.slice(end+5),meta=header.yourwiki;
   source=object(meta)&&meta.format==='yourwiki-embedded'&&meta.version===1&&meta.sha256===createHash('sha256').update(body).digest('hex')&&typeof meta.content==='string'&&meta.content?meta.content:body;
  }}
 }
 const snapshot=parse(source);
 const bounded=(text:string)=>{if(Buffer.byteLength(text)>maxOutputBytes)throw new Error('PREVIEW_TOO_COMPLEX');return text;};
 if(!object(snapshot)||snapshot.format!=='yourwiki'||snapshot.version!==1)return bounded(source);
 if(snapshot.kind!=='document'||!object(snapshot.data))invalid();
 const types=new Set(['doc','paragraph','text','heading','blockquote','bulletList','orderedList','listItem','codeBlock','hardBreak','horizontalRule','image','table','tableRow','tableCell','tableHeader','resourceReference']);
 let nodes=0,marks=0;
 function validate(node:unknown,depth=0):asserts node is Node{
  if(!object(node))throw new Error('INVALID_NATIVE_DOCUMENT');
  if(++nodes>50000||depth>40||!types.has(node.type)||node.text!==undefined&&typeof node.text!=='string'||node.attrs!==undefined&&!object(node.attrs)||node.content!==undefined&&!Array.isArray(node.content)||node.marks!==undefined&&!Array.isArray(node.marks))invalid();
  if(node.type==='heading'&&(!Number.isInteger(node.attrs?.level??2)||(node.attrs?.level??2)<1||(node.attrs?.level??2)>6))invalid();
  for(const mark of node.marks??[])if(++marks>50000||!object(mark)||typeof mark.type!=='string'||mark.attrs!==undefined&&!object(mark.attrs))invalid();
  for(const child of node.content??[])validate(child,depth+1);
 }
 validate(snapshot.data);
 const plain=(node:Node):string=>node.type==='text'?node.text??'':bounded((node.content??[]).map(plain).join('')+(['paragraph','heading','listItem','tableRow','hardBreak'].includes(node.type)?'\n':''));
 function render(node:Node):string{
  if(node.type==='text'){
   let text=node.text??'';
   for(const mark of node.marks??[]){const marker=markers.get(mark.type);if(marker)text=marker+text+marker;else if(mark.type==='link')text='['+text+']('+String(mark.attrs?.href??'')+')';bounded(text);}return bounded(text);
  }
  const content=bounded((node.content??[]).map(render).join(''));
  switch(node.type){
   case 'resourceReference':return '[[resource:'+String(node.attrs?.resourceId??'')+']]';
   case 'heading':return bounded('#'.repeat(Number(node.attrs?.level??2))+' '+content+'\n\n');
   case 'paragraph':return bounded(content+'\n\n');
   case 'listItem':return bounded('- '+content.trim()+'\n');
   case 'blockquote':return bounded(content.trim().split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/).map(line=>'> '+line).join('\n')+'\n\n');
   case 'codeBlock':return bounded('```\n'+plain(node).trim()+'\n```\n\n');
   case 'horizontalRule':return '\n---\n';
   case 'hardBreak':return '  \n';
   case 'image':return bounded('!['+String(node.attrs?.alt??'')+']('+String(node.attrs?.src??'')+')');
   case 'table':{
    const rows=(node.content??[]).map(row=>(row.content??[]).map(cell=>plain(cell).trim().replace(/\|/g,'\\|').replace(/\n/g,' ')));if(!rows.length)return '';
    return bounded('| '+rows[0]!.join(' | ')+' |\n| '+rows[0]!.map(()=>'---').join(' | ')+' |\n'+rows.slice(1).map(row=>'| '+row.join(' | ')+' |\n').join('')+'\n');
   }
   default:return content;
  }
 }
 return bounded(render(snapshot.data));
}
