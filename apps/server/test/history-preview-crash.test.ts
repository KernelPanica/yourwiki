import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HistoryPreviews} from '../src/history-previews.ts';
import {PreviewWorker} from '../src/worker/preview-worker.ts';
import {historyFixture} from './support/history-fixture.ts';
for(const mode of ['ready','queued','creating'])test('SIGKILL historical '+mode+' preparation preserves durable source/receipts and fences restart',async t=>{
 const f=await historyFixture(t),previews=new HistoryPreviews(f.db,f.store);t.after(()=>previews.close());if(mode!=='ready')f.db.prepare('DELETE FROM previews WHERE document_id=? AND revision=1').run(f.first.documentId);
 const child=spawn(process.execPath,[fileURLToPath(new URL('./support/history-preview-crash-child.ts',import.meta.url)),f.path,join(f.root,'store'),f.first.documentId,String(f.entryId),mode],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});const lines=createInterface({input:child.stdout});let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk).slice(0,1000);});
 const state=await new Promise<{state:string;preparedId:string}>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Historical child did not reach '+mode+': '+errors)),10000);lines.once('line',line=>{clearTimeout(timer);try{resolve(JSON.parse(line));}catch(error){reject(error);}});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Historical child exited early: '+errors));});});assert.equal(state.state,mode);const exit=once(child,'exit');child.kill('SIGKILL');const result=await exit;assert.equal(result[1],'SIGKILL');lines.close();
 if(mode==='creating'){
  f.db.prepare("UPDATE worker_slots SET lease_until=1 WHERE name IN ('preview','history-integrity')").run();f.db.prepare("UPDATE jobs SET lease_until=1 WHERE kind='history.preview' AND state='running'").run();f.db.prepare('UPDATE history_previews SET lease_until=1 WHERE id=?').run(state.preparedId);assert.equal(await new PreviewWorker(f.db,f.store).runOnce(),'failed');assert.equal(previews.status('reader',f.first.documentId,f.entryId).errorCode,'HISTORY_PREVIEW_LEASE_LOST');await previews.cleanup();const fresh=await previews.request('reader',f.first.documentId,f.entryId,{retry:true});assert.notEqual(fresh.preparedId,state.preparedId);assert.equal(await new PreviewWorker(f.db,f.store).runOnce(),'published');assert.equal(previews.status('reader',f.first.documentId,f.entryId).preparedId,fresh.preparedId);
 }else{if(mode==='queued')assert.equal(await new PreviewWorker(f.db,f.store).runOnce(),'published');const retained=await previews.request('reader',f.first.documentId,f.entryId);assert.equal(retained.state,'ready');assert.equal(retained.preparedId,state.preparedId);assert.equal((await previews.view('reader',f.first.documentId,f.entryId,retained.preparedId!)).document.capabilities.write,false);}
 assert.equal(await f.store.verify(f.first.blob),true);assert.equal(await f.store.verify(f.next.blob),true);assert.equal((f.db.prepare('SELECT local_revision FROM documents WHERE id=?').get(f.first.documentId) as any).local_revision,2);assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM history_entries').get() as any).n,1);
});
