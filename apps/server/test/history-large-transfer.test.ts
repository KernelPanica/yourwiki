import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('native history transfer, durable publication, restore and export exceed the parent heap without materializing archives',async()=>{
 const child=spawn(process.execPath,['--max-old-space-size=48',fileURLToPath(new URL('./support/history-large-transfer-child.ts',import.meta.url)),String(64*1024**2)],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);const status=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(status,0,errors);const result=JSON.parse(output);assert.equal(result.sourceBytes,64*1024**2);assert.ok(result.archiveBytes>result.sourceBytes);assert.equal(result.exportedEntries,3);assert.equal(result.sourceRevision,3);assert.equal(result.sameAdoptedInode,true);assert.equal(result.rangeTailVerified,true);assert.equal(result.durableReceipt,true);assert.equal(result.sourceUnchangedBeforeRestore,true);
});

test('final publication reuses a bounded set of SQL statements instead of compiling statements per archive entry',async()=>{
 const child=spawn(process.execPath,['--max-old-space-size=48',fileURLToPath(new URL('./support/history-import-publish-latency.ts',import.meta.url)),'500'],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);const status=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(status,0,errors);const result=JSON.parse(output);assert.equal(result.withinPreparationBudget,true,JSON.stringify(result));
});
