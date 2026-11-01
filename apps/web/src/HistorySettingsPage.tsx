import {useEffect,useId,useRef,useState} from 'react';
import {HistorySettingsClient,type HistorySettingsSnapshot} from './history-settings.ts';
import {historySettingsLabels} from './history-settings-i18n.ts';
import {languageFor} from './i18n.ts';
import './history-settings.css';
const t=historySettingsLabels[languageFor(navigator.language)];
export default function HistorySettingsPage({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const [state,setState]=useState<HistorySettingsSnapshot>({value:null,desired:null,phase:'loading',busy:true,errorCode:null}),client=useRef<HistorySettingsClient|null>(null),checkbox=useRef<HTMLInputElement|null>(null),returnFocus=useRef(false),description=useId(),budget=useId();
 useEffect(()=>{const model=new HistorySettingsClient({csrf,onSessionLost});client.current=model;const remove=model.subscribe(()=>setState(model.snapshot()));setState(model.snapshot());void model.load();return()=>{remove();model.dispose();if(client.current===model)client.current=null;};},[csrf]);
 useEffect(()=>{if(!state.busy&&returnFocus.current){returnFocus.current=false;if(document.activeElement===document.body||document.activeElement===checkbox.current)checkbox.current?.focus({preventScroll:true});}},[state.busy]);
 const uncertain=state.phase==='unknown'||state.phase==='conflict',error=state.phase==='blocked'?t.session:state.errorCode==='ACCESS_DENIED'||state.errorCode==='NOT_FOUND'?t.denied:state.phase==='error'?t.error:state.phase==='unknown'?t.unknown:state.phase==='conflict'?t.conflict:'';
 return <main id="content" className="history-settings-page" aria-busy={state.busy}><p className="eyebrow">Yourwiki</p><h1>{t.title}</h1><section className="history-settings-card" aria-labelledby={description+'-title'}><h2 id={description+'-title'}>{t.history}</h2><p id={description}>{t.description}</p>
  {state.value&&<label className="history-settings-checkbox"><input ref={checkbox} type="checkbox" checked={state.phase==='saving'?state.desired===true:state.value.enabled} disabled={state.busy||['unknown','error','blocked'].includes(state.phase)} aria-describedby={description+' '+budget} onChange={event=>{returnFocus.current=true;void client.current?.setEnabled(event.target.checked);}}/><span>{t.label}</span></label>}
  <p className="muted" id={budget}>{t.budget}</p>
  <p role="status" aria-live="polite" className="history-settings-status">{state.phase==='loading'?t.loading:state.phase==='saving'?t.saving:state.phase==='saved'?t.saved:state.value&&!uncertain&&state.phase==='ready'?state.value.enabled?t.enabled:t.disabled:''}</p>
  {error&&<p className="notice" role="alert">{error}</p>}
  <div className="history-settings-actions"><button type="button" disabled={state.busy||state.phase==='blocked'} onClick={()=>void client.current?.load()}>{t.refresh}</button>{uncertain&&<button type="button" disabled={state.busy} onClick={()=>void client.current?.retry()}>{t.retry}</button>}</div>
 </section></main>;
}
