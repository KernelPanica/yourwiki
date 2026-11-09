import MarkdownIt from 'markdown-it';
import {createHash} from 'node:crypto';
import {DocumentError} from '../document-errors.ts';
import {legacyMarkdown} from '../office/legacy-markdown.ts';
type Json=Record<string,any>;
const object=(v:unknown):v is Json=>!!v&&typeof v==='object'&&!Array.isArray(v);
const parse=(s:string):unknown=>{try{return JSON.parse(s);}catch{return null;}};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function parts(source:string){const bom=source.startsWith('\ufeff')?'\ufeff':'';let raw=source.slice(bom.length),prefix=bom,header:Json|null=null;if(raw.startsWith('---\n')||raw.startsWith('---\r\n')){const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);if(match){prefix+=match[0];raw=raw.slice(match[0].length);const value=parse(match[1]);if(object(value))header=value;}}return {raw,prefix,header};}
const attrs:Record<string,string[]>={doc:[],paragraph:[],text:[],heading:['level'],blockquote:[],bulletList:[],orderedList:['start'],listItem:[],codeBlock:['language'],hardBreak:[],horizontalRule:[],image:['src','alt','title','width','height'],resourceReference:['resourceId']};
/** Only structures represented by the visual editor may be rewritten. Everything
 * else remains available through exact source editing, never flattened. */
export function visualDocument(value:unknown):boolean{let n=0;function visit(v:unknown,depth=0):boolean{if(!object(v)||++n>50000||depth>40||!Object.hasOwn(attrs,v.type)||Object.keys(v).some(k=>!['type','text','attrs','marks','content'].includes(k)))return false;if(v.attrs&&(!object(v.attrs)||Object.keys(v.attrs).some(k=>!attrs[v.type].includes(k))))return false;if(v.content&&(!Array.isArray(v.content)||!v.content.every((x:unknown)=>visit(x,depth+1))))return false;if(v.marks&&(!Array.isArray(v.marks)||v.marks.some((m:unknown)=>!object(m)||!['bold','italic','strike','code','link'].includes(m.type)||Object.keys(m).some(k=>!['type','attrs'].includes(k))||m.attrs&&(!object(m.attrs)||Object.keys(m.attrs).some(k=>!['href','target','rel','class','title'].includes(k))))))return false;return v.text===undefined||typeof v.text==='string';}return visit(value);}
export function decodeTextDocument(source:string,depth=0):{kind:'markdown'|'native'|'embedded';markdown:string;document:Json|null;visualAllowed:boolean;reason:string|null}{
 if(depth>2)throw new DocumentError('TEXT_FORMAT_UNSUPPORTED');const {raw,header}=parts(source),meta=header?.yourwiki;
 if(object(meta)&&meta.format==='yourwiki-embedded'&&meta.version===1&&meta.sha256===digest(raw)&&typeof meta.content==='string'&&meta.content){const inner=decodeTextDocument(meta.content,depth+1);return {...inner,kind:'embedded'};}
 const native=parse(raw);if(object(native)&&native.format==='yourwiki'&&native.version===1){const supported=native.kind==='document'&&visualDocument(native.data);let markdown='';try{markdown=legacyMarkdown(raw);}catch{/* Unknown native nodes remain editable as source. */}return {kind:'native',markdown,document:object(native.data)?native.data:null,visualAllowed:supported,reason:supported?null:'TEXT_FORMAT_UNSUPPORTED'};}
 // Embedded HTML, tables, task lists, footnotes and directives cannot safely pass
 // through the configured basic schema. The source editor preserves them exactly.
 const parser=new MarkdownIt({html:true}),tokens=parser.parse(raw,{});const opaque=tokens.some(token=>token.type.startsWith('table')||token.type==='html_block'||token.children?.some(child=>child.type==='html_inline'));
 const supported=!opaque&&!/^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/m.test(raw)&&!/(?:^|\n)\s*\$\$|(?<!\\)\$[^$\n]+\$/.test(raw)&&!/(^|\n)(?:\s*<\/?[A-Za-z!]|\s*\||\s*\[[^\]]+\]:|\s*[-*+]\s+\[[ xX]\]|\s*:::)/.test(raw);
 return {kind:'markdown',markdown:raw,document:null,visualAllowed:supported,reason:supported?null:'TEXT_FORMAT_UNSUPPORTED'};
}
export function encodeVisualDocument(source:string,input:{markdown?:string;document?:unknown},depth=0):string{
 const decoded=decodeTextDocument(source,depth);if(!decoded.visualAllowed)throw new DocumentError('TEXT_FORMAT_UNSUPPORTED');const {raw,prefix,header}=parts(source),meta=header?.yourwiki;
 if(decoded.kind==='embedded'&&object(meta)){const inner=encodeVisualDocument(meta.content,input,depth+1);if(inner===meta.content)return source;const body=legacyMarkdown(inner);const next={...header,yourwiki:{...meta,content:inner,sha256:digest(body)}};return (source.startsWith('\ufeff')?'\ufeff':'')+'---\n'+JSON.stringify(next)+'\n---\n'+body;}
 if(decoded.kind==='native'){if(!visualDocument(input.document))throw new DocumentError('TEXT_FORMAT_UNSUPPORTED');const snapshot=parse(raw) as Json;if(JSON.stringify(snapshot.data)===JSON.stringify(input.document))return source;return prefix+JSON.stringify({...snapshot,data:input.document});}
 if(typeof input.markdown!=='string')throw new DocumentError('INVALID_REQUEST');return input.markdown===raw?source:prefix+input.markdown;
}
