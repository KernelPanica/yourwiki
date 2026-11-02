import type {Database} from './database.ts';
import {JobQueue} from './jobs.ts';
/** Joins the caller's accepted-source transaction; does not publish a preview. */
export function stagePreviewRequest(db:Database,id:string,revision:number,converterVersion:string,now:number):string{
 if(!db.inTransaction)throw new Error('Preview request requires its document transaction');
 db.prepare('UPDATE documents SET preview_generation=preview_generation+1 WHERE id=?').run(id);
 const row=db.prepare('SELECT preview_generation FROM documents WHERE id=?').get(id) as {preview_generation:number};
 const jobId=new JobQueue(db).enqueue({kind:'preview.prepare',key:`${id}:${revision}:${row.preview_generation}`,payload:{documentId:id,revision,converterVersion}},now);
 db.prepare('UPDATE documents SET preview_job_id=? WHERE id=?').run(jobId,id);return jobId;
}
