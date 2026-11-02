import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createReadStream} from 'node:fs';
import {readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {buffer} from 'node:stream/consumers';
import {Readable} from 'node:stream';
import {HistoryPreviews} from '../src/history-previews.ts';
import {PreviewWorker} from '../src/worker/preview-worker.ts';
import {historyFixture} from './support/history-fixture.ts';
const native=process.env.YOURWIKI_TEST_OFFICE_ROOT?test:test.skip;
for(const [file,format,kind] of [['office/document.docx','docx','document'],['office/table.xlsx','xlsx','table'],['office/slides.pptx','pptx','presentation'],['pdf/form.pdf','pdf','pdf']] as const){
 const run=format==='pdf'?test:native;
 run('historical '+format+' fallback prepares real read-only '+kind+' without changing the current file',async t=>{
  const f=await historyFixture(t),previews=new HistoryPreviews(f.db,f.store);t.after(()=>previews.close());const blob=await f.store.put(createReadStream(new URL('./fixtures/'+file,import.meta.url)),{maxBytes:1024**2});const id=Number(f.db.prepare("INSERT INTO history_entries(document_id,kind,source_revision,digest,size,title,format,captured_by,captured_by_name,created_at) VALUES(?,'source',1,?,?,'Historical fixture',?,'writer','Writer',1)").run(f.first.documentId,blob.digest,blob.size,format).lastInsertRowid);const docs=f.db.prepare('SELECT * FROM documents ORDER BY id').all(),history=f.db.prepare('SELECT * FROM history_entries ORDER BY id').all();f.db.prepare('UPDATE resources SET export_disabled=1 WHERE id=?').run(f.first.documentId);const prepared=await previews.request('reader',f.first.documentId,id);assert.equal(prepared.state,'queued');assert.equal(await new PreviewWorker(f.db,f.store,{office:{officeRoot:process.env.YOURWIKI_TEST_OFFICE_ROOT}}).runOnce(),'published');const view=await previews.view('reader',f.first.documentId,id,prepared.preparedId!);assert.equal(view.manifest.kind,kind);assert.equal(view.document.capabilities.write,false);assert.equal(view.document.capabilities.office,false);assert.equal(view.document.capabilities.export,false);const primary=view.manifest.artifacts.find(x=>x.name===view.manifest.primary)!;assert.ok((await buffer(Readable.from((await previews.asset('reader',f.first.documentId,id,prepared.preparedId!,primary.name)).bytes))).length>0);if(kind==='presentation'){const slides=(view.presentation as any).slides;assert.ok(slides.length>=2);for(const slide of slides){assert.ok(view.manifest.artifacts.some(x=>x.name===slide.image));assert.ok(view.manifest.artifacts.some(x=>x.name===slide.thumbnail));}}
  if(kind==='pdf'){assert.equal(primary.storage,'main');assert.equal(primary.digest,blob.digest);const target=await f.store.existingUploadStore(prepared.preparedId!);await assert.rejects(target!.stat(blob.digest),{code:'ENOENT'});const url='/api/documents/'+f.first.documentId+'/history/'+id+'/previews/'+prepared.preparedId+'/assets/'+primary.name,response=await f.app.inject({url,headers:{...f.headers(),range:'bytes=0-4'}});assert.equal(response.statusCode,206,response.body);assert.equal(response.body,'%PDF-');}else for(const asset of view.manifest.artifacts){assert.equal(asset.storage,'prepared');await assert.rejects(f.store.stat(asset.digest),{code:'ENOENT'});}
  const directory=join(f.root,'store','uploads',prepared.preparedId!,'blobs');let actualBytes=0;for(const prefix of await readdir(directory)){for(const name of await readdir(join(directory,prefix)))actualBytes+=(await stat(join(directory,prefix,name))).size;}assert.equal((f.db.prepare('SELECT reserved_bytes FROM history_previews WHERE id=?').get(prepared.preparedId!) as any).reserved_bytes,actualBytes);
  assert.equal(await f.store.verify(blob),true);assert.deepEqual(f.db.prepare('SELECT * FROM documents ORDER BY id').all(),docs);assert.deepEqual(f.db.prepare('SELECT * FROM history_entries ORDER BY id').all(),history);
 });
}
