import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../../apps/server/src/app.ts';
import {openDatabase} from '../../apps/server/src/database.ts';
import {BlobStore} from '../../apps/server/src/storage/blobs.ts';
import {DocumentService} from '../../apps/server/src/documents.ts';
import {createSession} from '../../apps/server/src/auth/sessions.ts';
import {bindExistingSource} from '../../apps/server/src/providers/source-bindings.ts';
import {renderGithubMarkdown} from '../../apps/server/src/text/github-markdown.ts';

const block = '```yourwiki-metrics\n```';

test('authenticated Markdown preview and dashboard calculate personal, ACL-filtered metrics', async t=>{
 const root=await mkdtemp(join(tmpdir(),'wiki-markdown-metrics-'));
 const db=openDatabase(':memory:');
 const store=await BlobStore.open(root);
 const origin='https://wiki.example.test';
 const app=buildApp({database:db,storage:store,publicUrl:origin});
 t.after(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});
 db.exec(`
   INSERT INTO users(id,username,display_name,password_hash) VALUES
    ('owner','owner','Owner','!'),('reader','reader','Reader','!');
   INSERT INTO groups(id,name) VALUES('team','Team');
   INSERT INTO memberships VALUES('owner','team'),('reader','team');
   INSERT INTO provider_connections VALUES('local','local','Local','cipher',1,1,1,1);
 `);
 const documents=new DocumentService(db,store);
 async function create(title,format,source='fixture'){
  const doc=await documents.create({localOnly:true,userId:'owner',groupId:'team',parentId:null,title,format},(async function*(){yield Buffer.from(source);})());
  bindExistingSource(db,{documentId:doc.documentId,connectionId:'local',reference:title,fingerprint:'verified',confirmedRevision:1,confirmedDigest:doc.blob.digest,confirmedSize:doc.blob.size,now:Date.now()});
  return doc.documentId;
 }
 const dashboard=await create('Dashboard.md','md',block);
 const sheet=await create('Private title.xlsx','xlsx');
 const pdf=await create('Private title.pdf','pdf');
 db.prepare('INSERT INTO dashboard_local_file(id,document_id) VALUES(1,?)').run(dashboard);
 const visit=db.prepare('INSERT INTO document_visits VALUES(?,?,?)');
 visit.run('reader',sheet,1);
 visit.run('owner',pdf,2);
 const sessions={owner:createSession(db,'owner'),reader:createSession(db,'reader')};
 const headers=id=>({
  cookie:'yourwiki_v2_session='+sessions[id].token,
  'x-csrf-token':sessions[id].csrf,
  'accept-language':'en',
  origin,
 });
 const preview=(id,source=block)=>app.inject({method:'POST',url:`/api/documents/${dashboard}/text/preview`,headers:headers(id),payload:{source}});
 const read=await preview('reader',block+'\n\n'+block);
 assert.equal(read.statusCode,200);
 assert.equal(read.headers['cache-control'],'no-store');
 assert.equal(read.json().html.match(/class="wiki-metrics"/g)?.length,1);
 assert.match(read.json().html,/<span>Spreadsheets<\/span><meter max="1" value="1">/);
 assert.match(read.json().html,/<span>PDF<\/span><meter max="1" value="0">/);
 assert.doesNotMatch(read.json().html,/Private title/);

 const dashboardResponse=await app.inject({url:'/api/dashboard',headers:headers('owner')});
 assert.equal(dashboardResponse.statusCode,200);
 assert.match(dashboardResponse.json().snapshot.previewHtml,/<span>PDF<\/span><meter max="1" value="1">/);
 db.prepare('UPDATE resources SET trashed=1 WHERE id=?').run(sheet);
 assert.match((await preview('reader')).json().html,/Open documents to see a chart here/);
 assert.match((await preview('owner')).json().html,/<span>PDF<\/span><meter max="1" value="1">/);
 assert.equal((await app.inject({method:'POST',url:`/api/documents/${dashboard}/text/preview`,payload:{source:block}})).statusCode,401);
});

test('static previews, normal code and lookalike fences do not call the plugin',()=>{
 assert.doesNotMatch(renderGithubMarkdown(block),/<meter/);
 const html=renderGithubMarkdown('```yourwiki-metrics\nuser=someone\n```\n\n````markdown\n'+block+'\n````',{
  renderMetrics(){assert.fail('only an empty, exact fence should call the plugin');},
 });
 assert.match(html,/user=someone/);
 assert.match(renderGithubMarkdown('Before\n\n'+block+'\n\nAfter',{renderMetrics:()=>'<figure class="wiki-metrics">Chart</figure>'}),/<figure class="wiki-metrics">Chart<\/figure>/);
});
