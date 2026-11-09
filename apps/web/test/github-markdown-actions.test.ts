import test from 'node:test';import assert from 'node:assert/strict';import {markdownAction,markdownTableFromTSV} from '../src/github-markdown-actions.ts';
test('formatting preserves surrounding source and selection, and toggles existing wrappers',()=>{const a=markdownAction('before word after',7,11,'bold');assert.equal(a.text,'before **word** after');assert.equal(markdownAction(a.text,a.from,a.to,'bold').text,'before word after');});
test('list and task commands apply to all selected lines',()=>{assert.equal(markdownAction('one\ntwo',0,7,'task').text,'- [ ] one\n- [ ] two');assert.equal(markdownAction('one\ntwo',0,7,'ordered').text,'1. one\n2. two');});
test('table paste escapes pipes and preserves rows',()=>{assert.equal(markdownTableFromTSV('A\tB\n1|2\t3'),'| A | B |\n| --- | --- |\n| 1\\|2 | 3 |');});
test('code fences do not corrupt existing backticks',()=>{const a=markdownAction('a```b',0,5,'codeblock');assert(a.text.includes('````'));});
test('insert commands provide real Markdown structures',()=>{for(const action of ['table','details','mermaid','math','footnote','alert','image','link','rule'] as const)assert(markdownAction('',0,0,action).text.length>0);});

test('formatting at the start of a document does not consume the leading newline',()=>{const result=markdownAction('\nBody',0,0,'quote');assert.equal(result.text,'> \nBody');});
