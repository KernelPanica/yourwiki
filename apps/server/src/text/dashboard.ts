import {Administration} from '../administration/service.ts';
import {transaction,type Database} from '../database.ts';
import type {BlobStore} from '../storage/blobs.ts';
import {DocumentService} from '../documents.ts';
const escape=(s:string)=>s.replace(/([\\`*_{}\[\]<>#+.!|~-])/g,'\\$1');
export function dashboardMarkdown(blocks:unknown):string{if(!Array.isArray(blocks))throw new Error('INVALID_DASHBOARD');return blocks.map(block=>{
 if(block.type==='heading')return '## '+escape(String(block.text??''));if(block.type==='text')return escape(String(block.text??'')).replace(/\n/g,'  \n');if(block.type==='reference')return '[[resource:'+String(block.resourceId)+']]';if(block.type==='link'){const url=new URL(block.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('INVALID_DASHBOARD');return '['+escape(String(block.title))+']('+url.href.replace(/\(/g,'%28').replace(/\)/g,'%29')+')';}throw new Error('INVALID_DASHBOARD');}).join('\n\n')+'\n';}
/** Idempotently retain the current source as a protected local-only dashboard. */
export async function ensureDashboardFile(db:Database,store:BlobStore):Promise<string|null>{
 for(let attempt=0;attempt<3;attempt++){
  const local=db.prepare('SELECT document_id FROM dashboard_local_file WHERE id=1').get() as {document_id:string}|undefined;if(local)return local.document_id;
  const old=db.prepare('SELECT document_id FROM dashboard_document WHERE id=1').get() as {document_id:string}|undefined;
  const owner=db.prepare("SELECT id FROM users WHERE active=1 AND admin_role='giga' ORDER BY id LIMIT 1").get() as {id:string}|undefined,group=db.prepare("SELECT id FROM groups WHERE trashed_at IS NULL AND purged_at IS NULL ORDER BY CASE WHEN name='Members' THEN 0 ELSE 1 END,id LIMIT 1").get() as {id:string}|undefined;if(!owner||!group)return null;
  const legacy=db.prepare('SELECT revision,blocks FROM dashboard WHERE id=1').get() as {revision:number;blocks:string};
  const version=old?db.prepare('SELECT revision,digest,size FROM document_versions WHERE document_id=? ORDER BY revision DESC LIMIT 1').get(old.document_id) as {revision:number;digest:string;size:number}|undefined:undefined;
  if(old&&!version)throw new Error('DASHBOARD_SOURCE_MISSING');
  const blob=version?await store.stat(version.digest):await store.put((async function*(){yield Buffer.from(dashboardMarkdown(JSON.parse(legacy.blocks)));})(),{maxBytes:4*1024**2});
  const result=transaction(db,()=>{const winner=db.prepare('SELECT document_id FROM dashboard_local_file WHERE id=1').get() as {document_id:string}|undefined;if(winner)return winner.document_id;const binding=db.prepare('SELECT document_id FROM dashboard_document WHERE id=1').get() as {document_id:string}|undefined;if(binding?.document_id!==old?.document_id)return null;if(version&&(db.prepare('SELECT local_revision AS revision FROM documents WHERE id=?').get(old!.document_id) as {revision:number}).revision!==version.revision)return null;
   const created=new DocumentService(db,store).commitPreparedCreate({localOnly:true,userId:owner.id,title:'Dashboard.md',format:'md',parentId:null,groupId:group.id},blob);
   if(old){const resource=db.prepare('SELECT owner_id FROM resources WHERE id=?').get(old.document_id) as {owner_id:string}|undefined;if(resource){const acl=new Administration(db).readAcl(owner.id,old.document_id,true);const inheritedExport=(db.prepare('WITH RECURSIVE chain(id,parent_id,export_disabled,n) AS (SELECT id,parent_id,export_disabled,0 FROM resources WHERE id=? UNION ALL SELECT r.id,r.parent_id,r.export_disabled,c.n+1 FROM resources r JOIN chain c ON r.id=c.parent_id WHERE c.n<32) SELECT MAX(export_disabled) AS disabled FROM chain').get(old.document_id) as {disabled:number}).disabled;db.prepare('UPDATE resources SET owner_id=?,group_id=?,policy=?,group_policies=?,user_policies=?,export_disabled=?,inherit_permissions=0 WHERE id=?').run(acl.effectiveOwnerId??resource.owner_id,acl.effectiveGroupId,JSON.stringify(acl.effectivePolicy),JSON.stringify(acl.effectiveGroupPolicies),JSON.stringify(acl.effectiveUserPolicies),inheritedExport,created.documentId);}}
   db.prepare('INSERT INTO dashboard_document VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET document_id=excluded.document_id').run(created.documentId,legacy.revision,Date.now());db.prepare('INSERT INTO dashboard_local_file VALUES(1,?,?)').run(created.documentId,old?.document_id??null);return created.documentId;});if(result)return result;
 }throw new Error('DASHBOARD_MIGRATION_CONFLICT');
}
