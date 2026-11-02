import {useEffect,useRef,useState} from 'react';
import {ProviderDeliveryClient,parseSourceDelivery,type DeliverySnapshot} from './provider-delivery-client.ts';
import {subscribeChanges} from './live-updates.ts';
import {deliveryLabels} from './provider-delivery-i18n.ts';
import {languageFor} from './i18n.ts';
const t=deliveryLabels[languageFor(navigator.language)];
export default function ProviderDeliveryPanel({documentId,accountId,csrf,write,onSessionLost,initial}:{initial?:unknown;documentId:string;accountId:string;csrf:string;write:boolean;onSessionLost:()=>void}){
 const client=useRef<ProviderDeliveryClient|null>(null),lost=useRef(onSessionLost);lost.current=onSessionLost;
 const [state,setState]=useState<DeliverySnapshot>(()=>{let value=null;try{if(initial!==undefined)value=parseSourceDelivery(initial,documentId);}catch{}return {value,busy:!value,blocked:false,uncertain:false,errorCode:null};});
 useEffect(()=>{const current=new ProviderDeliveryClient({documentId,csrf,write,initial,onSessionLost:()=>lost.current()});client.current=current;setState(current.snapshot());const unsubscribe=current.subscribe(()=>setState(current.snapshot())),changes=subscribeChanges(event=>{if(event.type==='all'||event.documentIds.includes(documentId))void current.load();});if(!current.snapshot().value)void current.load();return()=>{unsubscribe();changes();current.dispose();client.current=null;};},[documentId,accountId,csrf,write]);
 const value=state.value,preserve=value&&['unknown','conflict','retryable','blocked'].includes(value.state);
 return <aside className="source-delivery" aria-label={t.title}><div><p role="status" aria-live="polite">{state.busy?t.loading:value?t[value.state]:t.error}</p>{preserve&&<small>{t.preserve}</small>}{state.uncertain&&<p className="muted">{t.uncertain}</p>}{state.errorCode&&!state.uncertain&&<p className="muted">{t.error}</p>}</div><div className="source-delivery-actions"><button type="button" disabled={state.busy||state.blocked} onClick={()=>void client.current?.load()}>{t.refresh}</button>{write&&value?.operationId&&!state.blocked&&!state.uncertain&&value.state==='retryable'&&<button type="button" disabled={state.busy} onClick={()=>void client.current?.action('retry')}>{t.retry}</button>}{write&&value?.operationId&&!state.blocked&&!state.uncertain&&value.state==='unknown'&&<button type="button" disabled={state.busy} onClick={()=>void client.current?.action('check')}>{t.check}</button>}</div></aside>;
}
