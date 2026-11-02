import {useEffect,useId,useRef,useState} from 'react';
import {OfficeRecovery} from './office-recovery.ts';
import type {RecoverySnapshot} from './office-recovery.ts';
import {subscribeChanges} from './live-updates.ts';
import {languageFor} from './i18n.ts';
import {recoveryLabels} from './office-recovery-i18n.ts';
const language=languageFor(navigator.language),t=recoveryLabels[language],numbers=new Intl.NumberFormat(language),dates=new Intl.DateTimeFormat(language,{dateStyle:'short',timeStyle:'medium'});
export default function OfficeRecoveryPanel({documentId,csrf,autoOpen=false,onSessionLost}:{documentId:string;csrf:string;autoOpen?:boolean;onSessionLost:()=>void}){
 const [open,setOpen]=useState(false),[state,setState]=useState<RecoverySnapshot>({items:[],nextCursor:null,loading:false,pendingId:null,blocked:false,errorCode:null});
 const client=useRef<OfficeRecovery|null>(null),opened=useRef(false),panel=useId();
 useEffect(()=>{
  const model=new OfficeRecovery({documentId,csrf,onSessionLost});client.current=model;setState(model.snapshot());const remove=model.subscribe(()=>setState(model.snapshot()));
  const changes=subscribeChanges(event=>{if(opened.current&&(event.type==='all'||event.documentIds.includes(documentId)))void model.load();});
  return()=>{remove();changes();model.dispose();if(client.current===model)client.current=null;};
 },[documentId,csrf]);
 useEffect(()=>{opened.current=open;if(open)void client.current?.load();},[open,documentId,csrf]);
 useEffect(()=>{if(autoOpen)setOpen(true);},[autoOpen]);
 const busy=state.loading||state.pendingId!==null||state.blocked;
 const error=state.blocked?t.session:state.errorCode==='RECOVERY_DISCARD_UNCERTAIN'?t.uncertain:state.errorCode==='RECOVERY_EXPORT_DENIED'?t.exportDenied:state.errorCode&&['ACCESS_DENIED','NOT_FOUND','RECOVERY_UNAVAILABLE'].includes(state.errorCode)?t.denied:state.errorCode?t.error:'';
 function download(id:string){void client.current?.download(id,url=>{const anchor=document.createElement('a');anchor.href=url;anchor.download='';anchor.click();});}
 return <section className="office-recovery" aria-label={t.title}>
  <button type="button" aria-expanded={open} aria-controls={panel} onClick={()=>setOpen(value=>!value)}>{t.title}</button>
  {open&&<div id={panel} className="recovery-panel">
   <p className="muted">{t.description}</p><div className="recovery-actions"><button type="button" disabled={busy} onClick={()=>void client.current?.load()}>{t.refresh}</button>{state.nextCursor&&<button type="button" disabled={busy} onClick={()=>void client.current?.next()}>{t.next}</button>}</div>
   {error&&<p className="notice" role="alert">{error}</p>}{state.loading&&<p role="status">{t.loading}</p>}
   <ul className="recovery-list">{state.items.map(item=><li key={item.id} className="recovery-item"><div className="recovery-summary"><strong>{t.copy} {item.id.slice(0,8)}</strong>{item.createdAt!==null&&<time dateTime={new Date(item.createdAt).toISOString()}>{dates.format(item.createdAt)}</time>}<span>{t.base}: {numbers.format(item.baseRevision)}{item.size!==null?` · ${numbers.format(item.size)} ${t.bytes}`:''}</span><span>{item.state==='receiving'?t.receiving:item.state==='failed'?t.failed:t.prepared}</span>{item.errorCode&&<small>{t.reason}: {item.errorCode}</small>}</div><div className="recovery-actions">
    {item.download&&<button type="button" disabled={busy} aria-label={`${t.download} ${item.id.slice(0,8)}`} onClick={()=>download(item.id)}>{t.download}</button>}
    {item.discard&&<button type="button" disabled={busy} aria-label={`${t.discard} ${item.id.slice(0,8)}`} onClick={()=>{if(window.confirm(`${t.confirm}\n${t.copy} ${item.id.slice(0,8)}`))void client.current?.discard(item.id);}}>{t.discard}</button>}
   </div></li>)}</ul>{!state.loading&&!state.items.length&&!error&&<p>{t.empty}</p>}
  </div>}
 </section>;
}
