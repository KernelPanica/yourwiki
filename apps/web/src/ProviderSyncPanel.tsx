import {useEffect,useRef,useState} from 'react';
import {ProviderSyncClient,parseProviderSync,type SyncSnapshot} from './provider-sync-client.ts';
import {subscribeChanges} from './live-updates.ts';
import {syncLabels} from './provider-sync-i18n.ts';
import {languageFor} from './i18n.ts';
const t=syncLabels[languageFor(navigator.language)];
export default function ProviderSyncPanel({documentId,accountId,initial,onSessionLost}:{documentId:string;accountId:string;initial?:unknown;onSessionLost:()=>void}){
 const client=useRef<ProviderSyncClient|null>(null),lost=useRef(onSessionLost);lost.current=onSessionLost;
 const [holder,setHolder]=useState(()=>{let value=null;try{if(initial!==undefined)value=parseProviderSync(initial,documentId);}catch{}return {documentId,accountId,state:{value,busy:false,blocked:false,errorCode:null} as SyncSnapshot};});
 useEffect(()=>{const current=new ProviderSyncClient({documentId,initial,onSessionLost:()=>lost.current()});client.current=current;const update=()=>setHolder({documentId,accountId,state:current.snapshot()});update();const remove=current.subscribe(update),changes=subscribeChanges(event=>{if(event.type==='all'||event.documentIds.includes(documentId))void current.load();});if(!current.snapshot().value)void current.load();return()=>{remove();changes();current.dispose();client.current=null;};},[documentId,accountId]);
 if(holder.accountId!==accountId||holder.documentId!==documentId)return null;
 const state=holder.state,value=state.value;if(state.blocked)return null;
 const visible=value&&['staged','conflict','failed','interrupted','cleanup','blocked'].includes(value.state),label=value&&value.state in t?t[value.state as keyof typeof t]:null;
 if(!visible&&!state.errorCode)return null;
 return <aside className="source-delivery" aria-label={t.title}><div><p role="status" aria-live="polite">{state.errorCode?t.error:value?.errorCode==='INGRESS_QUOTA'?t.quota:label}</p>{value&&['conflict','staged'].includes(value.state)&&<small>{t.preserve}</small>}</div><div className="source-delivery-actions"><button type="button" disabled={state.busy} onClick={()=>void client.current?.load()}>{t.refresh}</button></div></aside>;
}
