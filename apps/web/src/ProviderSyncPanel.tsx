import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ProviderSyncClient,parseProviderSync,type SyncSnapshot} from './provider-sync-client.ts';
import {ProviderSyncActionClient,parseSyncAction,type SyncActionSnapshot,type SyncAction} from './provider-sync-action-client.ts';
import {subscribeChanges} from './live-updates.ts';
import {syncLabels} from './provider-sync-i18n.ts';
import {languageFor} from './i18n.ts';
const t=syncLabels[languageFor(navigator.language)];
export default function ProviderSyncPanel({documentId,accountId,initial,initialAction,csrf,write,onSessionLost,activity,delivery}:{activity?:ReactNode;delivery?:ReactNode;documentId:string;accountId:string;initial?:unknown;initialAction?:unknown;csrf:string;write:boolean;onSessionLost:()=>void}){
 const client=useRef<ProviderSyncClient|null>(null),actions=useRef<ProviderSyncActionClient|null>(null),lost=useRef(onSessionLost);lost.current=onSessionLost;
 const [holder,setHolder]=useState(()=>{let value=null,ticket=null;try{if(initial!==undefined)value=parseProviderSync(initial,documentId);if(initialAction!=null)ticket=parseSyncAction(initialAction,documentId);}catch{}return {documentId,accountId,state:{value,busy:false,blocked:false,errorCode:null} as SyncSnapshot,action:{ticket,busy:false,blocked:false,uncertain:false,errorCode:null} as SyncActionSnapshot};});
 useEffect(()=>{
  const current=new ProviderSyncClient({documentId,initial,onSessionLost:()=>lost.current()}),control=new ProviderSyncActionClient({documentId,csrf,write,initial:initialAction,onSessionLost:()=>lost.current()});client.current=current;actions.current=control;
  const update=()=>setHolder({documentId,accountId,state:current.snapshot(),action:control.snapshot()});update();const remove=current.subscribe(update),removeActions=control.subscribe(update),changes=subscribeChanges(event=>{if(event.type==='all'||event.documentIds.includes(documentId)){void current.load();void control.load();}});
  if(!current.snapshot().value)void current.load();if(initialAction===undefined)void control.load();
  return()=>{remove();removeActions();changes();current.dispose();control.dispose();client.current=null;actions.current=null;};
 },[documentId,accountId,csrf,write]);
 if(holder.accountId!==accountId||holder.documentId!==documentId)return null;
 const state=holder.state,action=holder.action,value=state.value;if(state.blocked||action.blocked)return null;
 const visible=value&&['staged','conflict','failed','interrupted','cleanup','blocked'].includes(value.state),label=value&&value.state in t?t[value.state as keyof typeof t]:null;
 const connected=value&&value.state!=='local_only'&&value.providerRevision!==null,disabled=state.busy||action.busy||action.uncertain||action.ticket?.state==='queued';
 const submit=(kind:SyncAction['action'])=>{if(kind==='discard'&&!window.confirm(t.discardConfirm))return;void actions.current?.submit(kind,value);};
 const controls=<div className="source-delivery-actions"><button type="button" disabled={state.busy||action.busy} onClick={()=>{void client.current?.load();void actions.current?.load();}}>{t.refresh}</button>{write&&connected&&<><button type="button" disabled={disabled} onClick={()=>submit('check')}>{t.check}</button>{value.snapshotId&&['staged','conflict'].includes(value.state)&&value.localRevision===value.providerRevision&&<button type="button" disabled={disabled} onClick={()=>submit('apply')}>{t.apply}</button>}{value.snapshotId&&['staged','conflict','failed','interrupted','cleanup','blocked'].includes(value.state)&&<button type="button" disabled={disabled} onClick={()=>submit('discard')}>{t.discard}</button>}</>}</div>;
 const actionLabel=action.uncertain?t.uncertain:action.errorCode?t.actionError:action.ticket?.errorCode==='PROVIDER_EXPORT_LIMIT'?t.exportLimit:action.ticket?t[action.ticket.state]:null;
 if(!visible&&!state.errorCode&&!actionLabel){if((!write||!connected)&&!activity&&!delivery)return null;return <details className="source-delivery-options"><summary>{t.title}</summary>{delivery}{activity}{controls}</details>;}
 return <aside className="source-delivery provider-sync" aria-label={t.title}><div><p role="status" aria-live="polite">{state.errorCode?t.error:value?.errorCode==='INGRESS_QUOTA'?t.quota:value?.errorCode==='PROVIDER_EXPORT_LIMIT'?t.exportLimit:value?.errorCode==='PROVIDER_CONFLICT'?t.sourceChanged:label}</p>{value&&(['conflict','staged'].includes(value.state)||value.errorCode==='PROVIDER_CONFLICT')&&<small>{t.preserve}</small>}{actionLabel&&<p role="status" aria-live="polite">{actionLabel}</p>}</div><details className="source-delivery-options"><summary>{t.actions}</summary>{delivery}{activity}{controls}</details></aside>;
}
