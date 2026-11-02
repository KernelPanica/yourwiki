import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {buffer} from 'node:stream/consumers';
import {setupIngress} from './support/provider-ingress-fixture.ts';
import {LocalAdapter} from '../src/providers/local-adapter.ts';
test('explicit shared CLI imports owned external change and stops cleanly without replacing the original',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'yourwiki-sync-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'original.md'),'new');
 const f=await setupIngress(t,{providerRoot:root}),local=await LocalAdapter.open(root),baseline=await local.read('original.md',{check:()=>{}});await buffer(baseline.bytes);await local.close();f.db.prepare('UPDATE provider_source_bindings SET fingerprint=? WHERE document_id=?').run(baseline.fingerprint,f.first.documentId);await writeFile(join(root,'original.md'),'outside');const key=join(f.root,'synthetic.key');await writeFile(key,'cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=\n',{mode:0o600});
 const child=spawn(process.execPath,['--max-old-space-size=48',fileURLToPath(new URL('../src/providers/worker-main.ts',import.meta.url)),f.path,join(f.root,'store'),key],{stdio:['ignore','pipe','pipe']}),ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}});let output='';child.stdout.on('data',data=>output=(output+data).slice(-2000));child.stderr.on('data',data=>output=(output+data).slice(-2000));await Promise.race([once(child.stdout,'data'),ended.then(()=>{throw new Error('Owned CLI stopped before startup');})]);const until=Date.now()+5000;let revision=2;while(revision!==3&&Date.now()<until){revision=(f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision;await delay(10);}assert.equal(revision,3);assert.equal(await readFile(join(root,'original.md'),'utf8'),'outside');assert.equal(f.docs.getPublished('reader',f.first.documentId)?.revision,2);child.kill('SIGTERM');assert.deepEqual(await ended,[0,null]);assert.ok(!output.includes(root));assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='provider.deliver'").get() as any).n,0);await f.publish();assert.equal(f.docs.getPublished('reader',f.first.documentId)?.revision,3);
});
