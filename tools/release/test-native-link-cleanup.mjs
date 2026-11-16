import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ZipFile} from '../../apps/server/node_modules/yazl/index.js';
import {fromBufferPromise} from '../../apps/server/node_modules/yauzl/index.js';
import {rewriteGoogleLinks,rewriteDocumentLinks} from '../../apps/server/src/rclone/native-link-content.ts';
const mapping=new Map([['old-doc','new-doc'],['old-sheet','new-sheet'],['old-slides','new-slides']]);
test('rewrites known Google URL forms with exact IDs and drops native editor query and fragments',()=>{
 const input='https://docs.google.com/document/d/old-doc/edit?usp=sharing#heading=h.x https://docs.google.com/spreadsheets/d/old-sheet/edit#gid=2 https://docs.google.com/presentation/d/old-slides/preview https://drive.google.com/open?id=old-doc&usp=drive_link https://drive.google.com/file/d/old-doc/view https://docs.google.com/document/d/old-doc-extra/edit';
 const result=rewriteGoogleLinks(input,mapping);
 assert.equal(result.count,5);
 assert.equal(result.text,Array(1).fill('https://drive.google.com/file/d/new-doc/view').concat(['https://drive.google.com/file/d/new-sheet/view','https://drive.google.com/file/d/new-slides/view','https://drive.google.com/file/d/new-doc/view','https://drive.google.com/file/d/new-doc/view','https://docs.google.com/document/d/old-doc-extra/edit']).join(' '));
 assert.equal(rewriteGoogleLinks(result.text,mapping).count,0);
 assert.equal(rewriteGoogleLinks('https://evil.test/docs.google.com/document/d/old-doc/edit https://docs.google.com.evil.test/document/d/old-doc/edit',mapping).count,0);
});
test('escaped JSON and XML URLs remain valid and unrelated names and IDs stay intact',async()=>{
 const source=String.raw`{"url":"https:\/\/docs.google.com\/document\/d\/old-doc\/edit?x=1&y=2","note":"old-doc"}`;
 const result=await rewriteDocumentLinks(Buffer.from(source),'canvas',mapping);
 assert.equal(JSON.parse(result.data.toString()).url,'https://drive.google.com/file/d/new-doc/view');
 assert.equal(JSON.parse(result.data.toString()).note,'old-doc');
 const xml=await rewriteDocumentLinks(Buffer.from('<x link="https://drive.google.com/open?usp=sharing&amp;id=old-doc"/>'),'drawio',mapping);
 assert.equal(xml.data.toString(),'<x link="https://drive.google.com/file/d/new-doc/view"/>');
});
async function zip(parts){const writer=new ZipFile();const chunks=[];const done=(async()=>{for await(const c of writer.outputStream)chunks.push(c);return Buffer.concat(chunks);})();for(const [name,data] of parts)writer.addBuffer(Buffer.from(data),name);writer.end();return done;}
test('rewrites Office relationships and shared strings while preserving media bytes',async()=>{
 const media=Buffer.from([0,1,255,4]);const input=await zip([['word/_rels/document.xml.rels','<Relationship Target="https://docs.google.com/document/d/old-doc/edit?x=1&amp;y=2"/>'],['word/media/image.png',media]]);
 const result=await rewriteDocumentLinks(input,'docx',mapping);assert.equal(result.count,1);
 const archive=await fromBufferPromise(result.data,{lazyEntries:true,autoClose:false});
 try{for await(const entry of archive.eachEntry()){const chunks=[];for await(const c of await archive.openReadStreamPromise(entry))chunks.push(c);const data=Buffer.concat(chunks);if(entry.fileName.endsWith('.png'))assert.deepEqual(data,media);else assert.match(data.toString(),/new-doc\/view/);}}finally{archive.close();}
 assert.equal((await rewriteDocumentLinks(input,'docx',new Map())).data,input);
 await assert.rejects(rewriteDocumentLinks(input,'docx',mapping,{maxExpandedBytes:4}),/LIMIT/);
 await assert.rejects(rewriteDocumentLinks(Buffer.from('bad zip'),'docx',mapping));
});
test('unsupported binary sources are reported and invalid UTF-8 is never rewritten',async()=>{
 assert.equal((await rewriteDocumentLinks(Buffer.from('%PDF-1.7'),'pdf',mapping)).supported,false);
 await assert.rejects(rewriteDocumentLinks(Buffer.from([255]),'md',mapping));
});

import {NativeOriginalMover} from '../../apps/server/src/rclone/native-link-moves.ts';
function driveFixture(){
 const files=new Map([
  ['root',{id:'root',name:'My Drive',mimeType:'application/vnd.google-apps.folder'}],
  ['wiki',{id:'wiki',name:'YourWiki',mimeType:'application/vnd.google-apps.folder',parents:['root']}],
  ['general',{id:'general',name:'0.General',mimeType:'application/vnd.google-apps.folder',parents:['wiki']}],
  ['old-doc',{id:'old-doc',name:'Файл',mimeType:'application/vnd.google-apps.document',parents:['general'],version:'1'}],
  ['new-doc',{id:'new-doc',name:'Файл [YourWiki UUID].docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',parents:['general'],version:'1'}],
 ]);const writes=[];
 const http={async call(method,path,query,body,scope){
  if(method==='GET'&&path==='files'){const parent=query.q.match(/^'([^']+)' in parents/)?.[1],name=query.q.match(/name = '([^']+)'/)?.[1];return {files:[...files.values()].filter(f=>f.parents?.includes(parent)&&f.name===name)};}
  if(method==='GET')return structuredClone(files.get(path.slice(6)));
  await scope.beforeDispatch();writes.push({method,path,query,body});
  if(method==='POST'){const file={id:'folder-'+writes.length,...body};files.set(file.id,file);return structuredClone(file);}
  const file=files.get(path.slice(6));file.parents=[query.addParents];file.version=String(Number(file.version??0)+1);return structuredClone(file);
 }};return {files,writes,http};
}
test('moves only confirmed, unbound native originals and preserves relative path and binary copy',async()=>{
 const f=driveFixture(),mover=new NativeOriginalMover(f.http,'wiki',()=>false),plan=await mover.plan('old-doc','new-doc');
 assert.equal(plan.relativePath,'0.General/Файл');assert.equal(f.writes.length,0);
 await assert.rejects(mover.move(plan,false),/CONFIRMATION/);assert.equal(f.writes.length,0);
 const events=[];await mover.move(plan,true,event=>{events.push(event);});
 assert.equal(f.writes.length,2);const folder=f.writes[0].body;assert.equal(folder.name,'0.General');assert.deepEqual(folder.parents,['root']);
 assert.deepEqual(f.files.get('new-doc').parents,['general']);
 assert.equal(f.files.get('old-doc').parents[0],'folder-1');assert.ok(events.length>=2);
 assert.equal((await mover.plan('old-doc','new-doc')).status,'outside-root');
});
test('bound, binary, ambiguous and concurrently changed originals cannot move',async()=>{
 const f=driveFixture();let bound=true;const mover=new NativeOriginalMover(f.http,'wiki',()=>bound);
 await assert.rejects(mover.plan('old-doc','new-doc'),/BOUND/);bound=false;
 await assert.rejects(mover.plan('new-doc','new-doc'),/NATIVE/);
 const plan=await mover.plan('old-doc','new-doc');f.files.get('old-doc').version='2';await assert.rejects(mover.move(plan,true),/CHANGED/);assert.equal(f.writes.length,0);
 f.files.get('old-doc').version='1';f.files.set('duplicate',{id:'duplicate',name:'0.General',mimeType:'application/vnd.google-apps.folder',parents:['root']});
 f.files.set('duplicate2',{id:'duplicate2',name:'0.General',mimeType:'application/vnd.google-apps.folder',parents:['root']});
 await assert.rejects(mover.plan('old-doc','new-doc'),/AMBIGUOUS/);assert.equal(f.writes.length,0);
});

import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../apps/server/src/database.ts';
import {BlobStore} from '../../apps/server/src/storage/blobs.ts';
import {DocumentService} from '../../apps/server/src/documents.ts';
import {bindExistingSource} from '../../apps/server/src/providers/source-bindings.ts';
import {NativeLinkCleanup} from '../../apps/server/src/rclone/native-link-cleanup.ts';
async function* bytes(data){yield Buffer.from(data);}
test('cleanup previews without writes, saves new revisions, queues delivery, rejects stale plans',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-link-cleanup-'));const db=openDatabase(join(root,'database.sqlite3')),store=await BlobStore.open(join(root,'storage'));
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 db.exec("INSERT INTO users(id,username,display_name,password_hash,admin_role) VALUES('admin','admin','Admin','!','giga');INSERT INTO groups(id,name) VALUES('g','Group')");
 const docs=new DocumentService(db,store),created=await docs.create({userId:'admin',groupId:'g',parentId:null,title:'Links',format:'md'},bytes('[Файл](https://docs.google.com/document/d/old-doc/edit)'));
 db.exec("INSERT INTO provider_connections(id,provider,label,encrypted_config,created_at,updated_at) VALUES('drive','google','Drive','encrypted',1,1)");
 bindExistingSource(db,{documentId:created.documentId,connectionId:'drive',reference:'content-file',fingerprint:'fingerprint',confirmedRevision:1,confirmedDigest:created.blob.digest,confirmedSize:created.blob.size,now:1});
 db.exec("INSERT INTO rclone_drive_mounts(connection_id,binary_path,config_path,mount_path,staging_path) VALUES('drive','/bin/false','/private/config','/private/mount','/private/staging')");
 db.prepare('INSERT INTO rclone_native_migrations(document_id,connection_id,original_reference,original_fingerprint,base_revision,digest,size,path,destination_reference,destination_fingerprint,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(created.documentId,'drive','old-doc','native-fingerprint',1,created.blob.digest,created.blob.size,'Links [YourWiki UUID].md','content-file','fingerprint',1);
 // No encryption.key exists: default preview must remain local and read-only.
 const savedArgv=process.argv,savedInfo=console.info,output=[];
 try{process.argv=[process.execPath,'native-link-cleanup-main.ts',root,'drive'];console.info=value=>output.push(value);await import('../../apps/server/src/rclone/native-link-cleanup-main.ts');}
 finally{process.argv=savedArgv;console.info=savedInfo;}
 const preview=output.join('\n');assert.match(preview,/"mode":"plan"/);assert.match(preview,/"links":1/);
 const cleanup=new NativeLinkCleanup(db,store,mapping,'admin'),plan=await cleanup.scan();assert.equal(plan[0].count,1);assert.equal(db.prepare('SELECT local_revision FROM documents').get().local_revision,1);
 await cleanup.apply(plan);assert.equal(db.prepare('SELECT local_revision FROM documents').get().local_revision,2);assert.equal(db.prepare('SELECT count(*) n FROM document_versions').get().n,2);
 const current=db.prepare('SELECT digest FROM document_versions WHERE revision=2').get();let data='';for await(const chunk of await store.read(current.digest))data+=chunk.toString();assert.match(data,/new-doc\/view/);
 await assert.rejects(cleanup.apply(plan),/CHANGED/);
 const clean=await cleanup.scan();assert.equal(clean[0].count,0);
 assert.equal(db.prepare('SELECT requested_revision FROM provider_delivery_requests WHERE document_id=?').get(created.documentId).requested_revision,2);
 assert.throws(()=>cleanup.assertSynchronized(clean),/SYNCHRONIZED/);
});

import {inflateRawSync,deflateRawSync} from 'node:zlib';
test('compressed drawio pages, XML-escaped HTML and UTF-16 retain their structure',async()=>{
 const html='&lt;a href=&quot;https://docs.google.com/document/d/old-doc/edit&quot;&gt;Файл&lt;/a&gt;';
 const page='<mxGraphModel><root><mxCell value="'+html+'"/></root></mxGraphModel>';
 const encoded=deflateRawSync(Buffer.from(encodeURIComponent(page))).toString('base64');
 const source=Buffer.from('<mxfile><diagram id="p">'+encoded+'</diagram></mxfile>');
 const result=await rewriteDocumentLinks(source,'drawio',mapping);assert.equal(result.count,1);
 const decoded=decodeURIComponent(inflateRawSync(Buffer.from(result.data.toString().match(/<diagram[^>]*>([^<]+)/)[1],'base64')).toString());
 assert.equal(decoded,page.replace('https://docs.google.com/document/d/old-doc/edit','https://drive.google.com/file/d/new-doc/view'));
 const utf16=Buffer.from('\ufeff<x href="https://docs.google.com/document/d/old-doc/edit"/>','utf16le');
 const fixed=await rewriteDocumentLinks(utf16,'xml',mapping);assert.equal(fixed.data[0],255);assert.equal(fixed.data[1],254);assert.match(fixed.data.toString('utf16le'),/new-doc\/view/);
 const json=String.raw`{"url":"https://docs.google.com/document/d/old-doc/edit","note":"hello\nthere"}`;
 assert.equal(JSON.parse((await rewriteDocumentLinks(Buffer.from(json),'json',mapping)).data.toString()).note,'hello\nthere');
});
test('an original bound after preview and an existing destination are never moved',async()=>{
 const f=driveFixture();let bound=false;const mover=new NativeOriginalMover(f.http,'wiki',()=>bound),plan=await mover.plan('old-doc','new-doc');bound=true;
 await assert.rejects(mover.move(plan,true),/BOUND/);assert.equal(f.writes.length,0);bound=false;
 f.files.set('dest-folder',{id:'dest-folder',name:'0.General',mimeType:'application/vnd.google-apps.folder',parents:['root']});
 f.files.set('existing',{id:'existing',name:'Файл',mimeType:'application/vnd.google-apps.document',parents:['dest-folder']});
 await assert.rejects(mover.plan('old-doc','new-doc'),/DESTINATION_EXISTS/);assert.equal(f.writes.length,0);
});
test('CSV rewriting preserves adjacent cells and quoted commas in URLs',async()=>{
 const source='title,https://docs.google.com/document/d/old-doc/edit,owner\n"a,b","https://docs.google.com/document/d/old-doc/edit?x=1,2","o"\n';
 const result=await rewriteDocumentLinks(Buffer.from(source),'csv',mapping);
 assert.equal(result.data.toString(),'title,https://drive.google.com/file/d/new-doc/view,owner\n"a,b","https://drive.google.com/file/d/new-doc/view","o"\n');
 const semi=await rewriteDocumentLinks(Buffer.from('title;https://docs.google.com/document/d/old-doc/edit;owner'),'csv',mapping);
 assert.equal(semi.data.toString(),'title;https://drive.google.com/file/d/new-doc/view;owner');
});
test('VML drawing hyperlinks inside Office archives are covered',async()=>{
 const data=await zip([['xl/drawings/vmlDrawing1.vml','<v:shape href="https://docs.google.com/document/d/old-doc/edit"/>']]);
 assert.equal((await rewriteDocumentLinks(data,'xlsx',mapping)).count,1);
});
test('a binding established while fetching an OAuth token fences the actual move dispatch',async()=>{
 const f=driveFixture();let bound=false;const call=f.http.call;
 f.http.call=async(method,path,query,body,scope)=>{if(method==='PATCH')bound=true;return call(method,path,query,body,scope);};
 const mover=new NativeOriginalMover(f.http,'wiki',()=>bound),plan=await mover.plan('old-doc','new-doc');
 await assert.rejects(mover.move(plan,true),/BOUND/);assert.equal(f.writes.some(write=>write.method==='PATCH'),false);
});
test('plain text punctuation following an unquoted Google link is preserved',()=>{
 assert.equal(rewriteGoogleLinks('https://docs.google.com/document/d/old-doc/edit,прочитай',mapping).text,'https://drive.google.com/file/d/new-doc/view,прочитай');
});
