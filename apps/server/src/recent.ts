import {transaction,type Database} from './database.ts';
import {DocumentService,DocumentError} from './documents.ts';
type Cursor=[number,string];
function decode(value:string):Cursor{
 try{
  if(typeof value!=='string'||value.length>768||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw Error();const parsed:unknown=JSON.parse(bytes.toString('utf8'));
  if(!Array.isArray(parsed)||parsed.length!==2||!Number.isSafeInteger(parsed[0])||parsed[0]<0||typeof parsed[1]!=='string'||!parsed[1].length||parsed[1].length>128)throw Error();return parsed as Cursor;
 }catch{throw new DocumentError('INVALID_REQUEST');}
}
/** Personal distinct-document history. Stored rows never confer permission or copy titles. */
export class RecentDocuments{
 private db:Database;private documents:DocumentService;private options:{clock?:()=>number};
 constructor(db:Database,documents:DocumentService,options:{clock?:()=>number}={}){this.db=db;this.documents=documents;this.options=options;}
 record(userId:string,documentId:string){
  transaction(this.db,()=>{
   if(!this.documents.getPublished(userId,documentId))throw new DocumentError('NOT_FOUND');
   const last=this.db.prepare('SELECT opened_at FROM document_visits WHERE user_id=? ORDER BY opened_at DESC,document_id DESC LIMIT 1').get(userId) as {opened_at:number}|undefined;
   const now=Math.max((this.options.clock??Date.now)(),last?last.opened_at+1:0);if(!Number.isSafeInteger(now)||now<0)throw new DocumentError('INVALID_REQUEST');
   this.db.prepare('INSERT INTO document_visits(user_id,document_id,opened_at) VALUES(?,?,?) ON CONFLICT(user_id,document_id) DO UPDATE SET opened_at=excluded.opened_at').run(userId,documentId,now);
   this.db.prepare('DELETE FROM document_visits WHERE user_id=? AND document_id IN (SELECT document_id FROM document_visits WHERE user_id=? ORDER BY opened_at DESC,document_id DESC LIMIT -1 OFFSET 200)').run(userId,userId);
  });
 }
 list(userId:string,options:{after?:string;limit?:number}={}){
  const limit=options.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new DocumentError('INVALID_REQUEST');const cursor=options.after===undefined?null:decode(options.after);
  return transaction(this.db,()=>{
   const candidates=(cursor?this.db.prepare('SELECT document_id,opened_at FROM document_visits WHERE user_id=? AND (opened_at,document_id)<(?,?) ORDER BY opened_at DESC,document_id DESC LIMIT 201').all(userId,...cursor):this.db.prepare('SELECT document_id,opened_at FROM document_visits WHERE user_id=? ORDER BY opened_at DESC,document_id DESC LIMIT 201').all(userId)) as {document_id:string;opened_at:number}[];
   const items=[];let scanned=0,last:Cursor|null=null;
   for(const row of candidates.slice(0,200)){scanned++;last=[row.opened_at,row.document_id];const document=this.documents.getPublished(userId,row.document_id);if(document)items.push({...document,openedAt:row.opened_at});if(items.length>=limit)break;}
   return {items,nextCursor:scanned<candidates.length&&last?Buffer.from(JSON.stringify(last)).toString('base64url'):null};
  });
 }
}
