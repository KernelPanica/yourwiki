import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileGoogleDocsText} from '../src/providers/google-docs-text.ts';
import {nativeJournalFixture} from './support/google-native-journal-fixture.ts';
import {GoogleNativeJournal} from '../src/providers/google-native-journal.ts';

test('a native text edit compiles against the checked revision and dispatches through the durable journal',async t=>{
 const f=await nativeJournalFixture(t),s=await f.stage();
 const command=await compileGoogleDocsText(s.snapshot,[{tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'!'}]);
 assert.deepEqual(command,s.command);assert.ok(Object.isFrozen(command.requests));
 const journal=new GoogleNativeJournal(f.db,f.configs,{clock:f.clock});await journal.reserve(s.attempt,s.snapshot,command);await journal.dispatch(s.attempt,s.writer,s.gate);assert.deepEqual(f.stats(),{posts:1,writes:1});
});
test('text compilation refuses copied snapshots, changed expected text and structural edits',async t=>{
 const f=await nativeJournalFixture(t),s=await f.stage();
 await assert.rejects(compileGoogleDocsText({...s.snapshot},[{tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'!'}]),{code:'PROVIDER_SOURCE_CHANGED'});
 for(const edit of [
 {tabId:'t.0',startIndex:1,endIndex:4,expected:'BAD',text:'New'},
 {tabId:'other',startIndex:1,endIndex:4,expected:'Doc',text:'New'},
 {tabId:'t.0',startIndex:1,endIndex:5,expected:'Doc\n',text:'New'},
 {tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'\n'},
 {tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'\u0000'},
 {tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'\ud800'},
 ])await assert.rejects(compileGoogleDocsText(s.snapshot,[edit]),{code:'PROVIDER_SOURCE_CHANGED'});
 assert.deepEqual(f.stats(),{posts:0,writes:0});
});
test('multiple edits apply from the end without mutating the source snapshot',async t=>{
 const f=await nativeJournalFixture(t),s=await f.stage(),before=JSON.stringify(s.snapshot);
 const command=await compileGoogleDocsText(s.snapshot,[{tabId:'t.0',startIndex:1,endIndex:2,expected:'D',text:'B'},{tabId:'t.0',startIndex:3,endIndex:4,expected:'c',text:'x'}]);
 assert.deepEqual(command.requests,[{deleteContentRange:{range:{tabId:'t.0',startIndex:3,endIndex:4}}},{insertText:{location:{tabId:'t.0',index:3},text:'x'}},{deleteContentRange:{range:{tabId:'t.0',startIndex:1,endIndex:2}}},{insertText:{location:{tabId:'t.0',index:1},text:'B'}}]);
 assert.equal(JSON.stringify(s.snapshot),before);
 await assert.rejects(compileGoogleDocsText(s.snapshot,[{tabId:'t.0',startIndex:1,endIndex:3,expected:'Do',text:'a'},{tabId:'t.0',startIndex:2,endIndex:4,expected:'oc',text:'b'}]),{code:'PROVIDER_SOURCE_CHANGED'});
});

test('UTF-16 boundaries, nested tabs and table-cell text retain native coordinates',async t=>{
 const {createGoogleNativeSnapshotReader}=await import('../src/providers/google-native-snapshot.ts');
 const f=await nativeJournalFixture(t),s=await f.stage();
 const run=(content:string)=>({startIndex:1,endIndex:content.length+1,textRun:{content,textStyle:{bold:true}}});
 const request:typeof fetch=async(url,init)=>{if(new URL(String(url)).origin!=='https://docs.googleapis.com')return f.request(url,init);return Response.json({documentId:'native',revisionId:'native_1',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[]}},childTabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[{table:{tableRows:[{tableCells:[{content:[{paragraph:{elements:[run('A😀B\n')]}}]}]}]}}]}}}]}]});};
 const reader=createGoogleNativeSnapshotReader(f.vault,s.connection,{fetch:request});t.after(()=>reader.close());const snapshot=await reader.read({check(){}}),before=JSON.stringify(snapshot);
 const command=await compileGoogleDocsText(snapshot,[{tabId:'child',startIndex:2,endIndex:4,expected:'😀',text:'🙂'}]);assert.deepEqual(command.requests[0],{deleteContentRange:{range:{tabId:'child',startIndex:2,endIndex:4}}});assert.equal(JSON.stringify(snapshot),before);
 for(const edit of [{tabId:'child',startIndex:3,endIndex:3,expected:'',text:'X'},{tabId:'child',startIndex:2,endIndex:3,expected:'\ud83d',text:'X'}])await assert.rejects(compileGoogleDocsText(snapshot,[edit]),{code:'PROVIDER_SOURCE_CHANGED'});
});
test('suggested content, no-op edits, duplicate locations and active authority loss do not compile',async t=>{
 const {createGoogleNativeSnapshotReader}=await import('../src/providers/google-native-snapshot.ts');const f=await nativeJournalFixture(t),s=await f.stage();
 for(const edits of [[],[{tabId:'t.0',startIndex:1,endIndex:4,expected:'Doc',text:'Doc'}],[{tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'a'},{tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'b'}]])await assert.rejects(compileGoogleDocsText(s.snapshot,edits),{code:'PROVIDER_SOURCE_CHANGED'});
 const request:typeof fetch=async(url,init)=>{const response=await f.request(url,init);if(new URL(String(url)).origin!=='https://docs.googleapis.com')return response;const data=await response.json();data.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.suggestedInsertionIds=['suggestion'];return Response.json(data);};
 const reader=createGoogleNativeSnapshotReader(f.vault,s.connection,{fetch:request});t.after(()=>reader.close());const snapshot=await reader.read({check(){}});await assert.rejects(compileGoogleDocsText(snapshot,[{tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'!'}]),{code:'PROVIDER_SOURCE_CHANGED'});
 await s.source.close();await assert.rejects(compileGoogleDocsText(s.snapshot,[{tabId:'t.0',startIndex:4,endIndex:4,expected:'',text:'!'}]),{code:'PROVIDER_CANCELLED'});
});
