import {ProviderError} from './adapter.ts';
import {assertGoogleNativeSnapshot,type GoogleNativeSnapshot} from './google-native-snapshot.ts';
import {encodeGoogleNativeUpdate,type GoogleNativeUpdate} from './google-native-write.ts';
export type GoogleDocsTextEdit=Readonly<{tabId:string;startIndex:number;endIndex:number;expected:string;text:string}>;
const refused=()=>new ProviderError('PROVIDER_SOURCE_CHANGED');
const object=(value:unknown):Record<string,any>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:undefined;
const suggestions=(value:Record<string,any>)=>Object.keys(value).some(key=>key.startsWith('suggested')&&value[key]!==null&&typeof value[key]==='object'&&Object.keys(value[key]).length>0);
const boundary=(text:string,index:number)=>!(index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index]));
/** Exact native-body text operations, with Google's ordinary inserted-text style inheritance.
 * Never interprets an Office export as a native baseline. Structural/style edits, generated
 * content, suggestions and cross-run replacements require separate compilers. Not a save receipt. */
export async function compileGoogleDocsText(snapshot:GoogleNativeSnapshot,input:readonly GoogleDocsTextEdit[]):Promise<GoogleNativeUpdate>{
 // Reuse the descriptor-only bounded codec to capture caller data before the authority await.
 let edits:GoogleDocsTextEdit[];
 try{if(!Array.isArray(input)||input.length<1||input.length>500)throw refused();const captured=encodeGoogleNativeUpdate({kind:'document',reference:snapshot.reference,requiredRevisionId:snapshot.revision,requests:[{edits:input}]});edits=JSON.parse(captured.body).requests[0].edits;}catch{throw refused();}
 const source=await assertGoogleNativeSnapshot(snapshot,{kind:'document',reference:snapshot.reference,baseline:snapshot.baseline});
 const tabs=new Map<string,Record<string,any>>(),pending=[...(source.data.tabs as unknown[])];
 while(pending.length){const tab=object(pending.pop()),id=tab?.tabProperties?.tabId;if(typeof id!=='string'||tabs.has(id))throw refused();tabs.set(id,tab!);if(Array.isArray(tab?.childTabs))pending.push(...tab.childTabs);}
 for(const edit of edits){
  if(!object(edit)||Object.keys(edit).sort().join(',')!=='endIndex,expected,startIndex,tabId,text'||typeof edit.tabId!=='string'||!Number.isSafeInteger(edit.startIndex)||!Number.isSafeInteger(edit.endIndex)||edit.startIndex<1||edit.endIndex<edit.startIndex||typeof edit.expected!=='string'||typeof edit.text!=='string'||edit.expected===edit.text||/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff]/.test(edit.text)||/[\r\n]/.test(edit.expected))throw refused();
  const tab=tabs.get(edit.tabId),content=tab?.documentTab?.body?.content;if(!Array.isArray(content)||suggestions(tab!.documentTab))throw refused();const blocks=[...content];let matches=0;
  while(blocks.length){const block=object(blocks.pop());if(!block)throw refused();if(block.table){for(const row of block.table.tableRows??[])for(const cell of row.tableCells??[])if(Array.isArray(cell.content))blocks.push(...cell.content);}
   const paragraph=object(block.paragraph);if(!paragraph||suggestions(block)||suggestions(paragraph))continue;
   for(const raw of paragraph.elements??[]){const element=object(raw),run=object(element?.textRun);if(!element||!run||typeof run.content!=='string'||suggestions(element)||suggestions(run))continue;
    const start=element.startIndex,end=element.endIndex;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end-start!==run.content.length)continue;
    const a=edit.startIndex-start,b=edit.endIndex-start;if(a<0||b>run.content.length||a>=run.content.length||!boundary(run.content,a)||!boundary(run.content,b)||run.content.slice(a,b)!==edit.expected)continue;
    // Insertion is permitted before a paragraph's final newline, never after it.
    if(run.content.slice(0,a).includes('\n')||run.content.slice(a,b).includes('\n'))continue;matches++;
   }
  }
  if(matches!==1)throw refused();
 }
 edits.sort((a,b)=>a.tabId.localeCompare(b.tabId)||b.startIndex-a.startIndex);
 for(let i=1;i<edits.length;i++){const higher=edits[i-1],lower=edits[i];if(lower.tabId===higher.tabId&&(lower.startIndex===higher.startIndex||lower.endIndex>higher.startIndex))throw refused();}
 const requests:Record<string,unknown>[]=[];
 for(const edit of edits){if(edit.endIndex>edit.startIndex)requests.push({deleteContentRange:{range:{tabId:edit.tabId,startIndex:edit.startIndex,endIndex:edit.endIndex}}});if(edit.text)requests.push({insertText:{location:{tabId:edit.tabId,index:edit.startIndex},text:edit.text}});}
 const command={kind:'document' as const,reference:source.reference,requiredRevisionId:source.revision,requests};
 // Return only the codec's immutable data snapshot; no mutable input reaches the journal.
 const encoded=encodeGoogleNativeUpdate(command),copied=JSON.parse(encoded.body).requests;
 const freeze=(value:any):any=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 return Object.freeze({...command,requests:freeze(copied)});
}
