import {useEffect,useImperativeHandle,useRef,useState,type Ref} from 'react';
import {HistoryRestoreClient,type RestoreOperation,type RestoreSnapshot} from './history-restore-client.ts';
import {restoreLabels} from './history-restore-i18n.ts';
import {languageFor} from './i18n.ts';
export type RestoreActions={editorDirty:()=>boolean;releaseEditor:(action:()=>Promise<void>)=>Promise<boolean>;settled:(value:{state:'saved'|'discarded'|'not_started';operation:RestoreOperation|null})=>void};
export type RestoreHandle={prepare:(entryId:number)=>void};
const t=restoreLabels[languageFor(navigator.language)];
export default function HistoryRestorePanel({accountId,documentId,csrf,actions,onSessionLost,ref}:{accountId:string;documentId:string;csrf:string;actions:RestoreActions;onSessionLost:()=>void;ref:Ref<RestoreHandle>}){
 const model=useRef<HistoryRestoreClient|null>(null),region=useRef<HTMLElement|null>(null),[state,setState]=useState<RestoreSnapshot|null>(null);
 useEffect(()=>{const client=new HistoryRestoreClient({accountId,documentId,csrf,...actions,onSessionLost});model.current=client;const remove=client.subscribe(()=>setState(client.snapshot()));setState(client.snapshot());if(client.snapshot().phase==='recovery')void client.check();return()=>{remove();client.dispose();if(model.current===client)model.current=null;};},[accountId,documentId,csrf,actions]);
 useImperativeHandle(ref,()=>({prepare(entryId){void model.current?.prepare(entryId);requestAnimationFrame(()=>{region.current?.focus({preventScroll:true});region.current?.scrollIntoView({block:'nearest'});});}}),[]);
 if(!state||state.phase==='idle'||state.phase==='blocked')return null;
 const reason=state.errorCode??state.description?.blockedReason;
 const error=reason==='HISTORY_EDITOR_DIRTY'?t.dirty:reason==='CONFLICT'?t.conflict:reason==='OFFICE_ACTIVE'?t.office:reason==='SAVE_PENDING'?t.savePending:reason==='HISTORY_JOURNAL_UNAVAILABLE'?t.journal:reason&&['HISTORY_FORMAT_MISMATCH','HISTORY_FORMAT_UNSUPPORTED','PAYLOAD_TOO_LARGE','ACCESS_DENIED','NOT_FOUND'].includes(reason)?t.unavailable:reason?t.error:'';
 const pending=!!state.operationId&&!['saved','discarded'].includes(state.phase),canConfirm=!!state.description&&!state.operationId&&['confirm','conflict'].includes(state.phase)&&(!state.description.blockedReason||state.description.blockedReason==='OFFICE_ACTIVE');
 return <section className="history-restore" aria-label={t.title} tabIndex={-1} ref={region} aria-busy={state.busy}><h3>{t.title}</h3>{state.description&&<p><strong>{state.description.entry.title}</strong> · {state.description.entry.sourceRevision} · {new Date(state.description.entry.capturedAt).toLocaleString()}</p>}
 {['confirm','conflict'].includes(state.phase)&&<p>{t.explain}</p>}{error&&<p role="alert">{error}</p>}
 <p role="status" aria-live="polite">{state.phase==='loading'?t.loading:state.phase==='applying'?t.applying:state.phase==='saved'?t.saved:state.phase==='discarded'?t.discarded:state.phase==='unknown'?t.unknown:pending?t.pending:''}</p>
 <div className="history-actions">{canConfirm&&<button type="button" disabled={state.busy} onClick={()=>void model.current?.confirm()}>{t.confirm}</button>}{state.entryId!==null&&!pending&&!canConfirm&&!['saved','discarded','loading'].includes(state.phase)&&<button type="button" disabled={state.busy} onClick={()=>void model.current?.prepare(state.entryId!)}>{t.check}</button>}{pending&&<><button type="button" disabled={state.busy} onClick={()=>void model.current?.check()}>{t.check}</button>{state.operation?.state==='staged'&&state.phase!=='conflict'&&<button type="button" disabled={state.busy} onClick={()=>void model.current?.resume()}>{t.resume}</button>}<button type="button" disabled={state.busy} onClick={()=>void model.current?.discard()}>{t.discard}</button></>}</div>
 </section>;
}
