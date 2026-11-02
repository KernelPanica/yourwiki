import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,stat,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buffer} from 'node:stream/consumers';
import {LocalAdapter} from '../src/providers/local-adapter.ts';
const check=()=>{};
async function fixture(t:any){const root=await mkdtemp(join(tmpdir(),'yourwiki-local-probe-')),path=join(root,'original');await writeFile(path,'original');await utimes(path,1700000000,1700000000);const adapter=await LocalAdapter.open(root);t.after(async()=>{await adapter.close();await rm(root,{recursive:true,force:true});});const baseline=await adapter.read('original',{check});await buffer(baseline.bytes);return {root,path,adapter,baseline:baseline.fingerprint};}
test('unchanged Local probe performs no file content reads and malformed baseline conservatively requests a read',async t=>{const f=await fixture(t),paths=(f.adapter as any).paths,own=paths.own.bind(paths);let reads=0;paths.own=async(...args:any[])=>{const handle=await own(...args),read=handle.read.bind(handle);handle.read=async(...input:any[])=>{reads++;return read(...input);};return handle;};assert.equal(await f.adapter.changed('original',f.baseline,{check}),false);for(const malformed of ['', '{}',JSON.stringify(['local-v1']),f.baseline.replace('local-v1','local-v99')])assert.equal(await f.adapter.changed('original',malformed,{check}),true);assert.equal(reads,0);});
test('same-size content with restored mtime is changed and symbolic links are never followed by probe',async t=>{const f=await fixture(t),before=await stat(f.path,{bigint:true});await writeFile(f.path,'changed!');await utimes(f.path,1700000000,1700000000);const after=await stat(f.path,{bigint:true});assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.size,before.size);assert.notEqual(after.ctimeNs,before.ctimeNs);assert.equal(await f.adapter.changed('original',f.baseline,{check}),true);await symlink(f.path,join(f.root,'link'));await assert.rejects(()=>f.adapter.changed('link',f.baseline,{check}));await assert.rejects(()=>f.adapter.changed('../original',f.baseline,{check}));});
