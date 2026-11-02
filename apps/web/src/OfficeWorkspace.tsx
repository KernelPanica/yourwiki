import OfficeRecoveryPanel from './OfficeRecoveryPanel.tsx';
import {useEffect,useId,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import type {DocumentView} from './api.ts';
import {OfficeConnection} from './office-connection.ts';
import type {OfficeConnectionSnapshot} from './office-connection.ts';
import type {OfficeSnapshot} from './office-bridge.ts';
import {registerNavigationGuard} from './navigation-guard.ts';
import {subscribeChanges} from './live-updates.ts';
import {languageFor} from './i18n.ts';
import {officeLabels} from './office-i18n.ts';
const language=languageFor(navigator.language),t=officeLabels[language];
export default function OfficeWorkspace({view,csrf,children,onSessionLost}:{view:DocumentView;csrf:string;children:ReactNode;onSessionLost:()=>void}){
 const frame=useRef<HTMLIFrameElement>(null),form=useRef<HTMLFormElement>(null),connection=useRef<OfficeConnection|null>(null);
 const name='yourwiki-office-'+useId().replace(/[^a-z0-9_-]/gi,'');
 const [state,setState]=useState<OfficeConnectionSnapshot>({phase:'idle',bootstrap:null,errorCode:null,readiness:'waiting'}),[editor,setEditor]=useState<OfficeSnapshot|null>(null),[full,setFull]=useState(false);
 useEffect(()=>{
  const client=new OfficeConnection({documentId:view.document.id,csrf,language,format:view.manifest.kind==='table'?'xlsx':view.manifest.kind==='presentation'?'pptx':'docx',onSessionLost});connection.current=client;
  const remove=client.subscribe(()=>setState(client.snapshot()));
  const removeGuard=registerNavigationGuard(async()=>{
   if(client.snapshot().phase==='closed')return true;
   if(client.bridge?.snapshot().needsRecovery&&!window.confirm(t.leave))return false;
   return client.close();
  },()=>client.snapshot().phase!=='closed'&&!!client.bridge?.snapshot().needsRecovery);
  const message=(event:MessageEvent)=>{client.receive(event);};window.addEventListener('message',message);
  const leave=(event:BeforeUnloadEvent)=>{if(client.snapshot().bootstrap&&client.snapshot().phase!=='closed'){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',leave);
  const removeChanges=subscribeChanges(event=>{if(event.type==='all'||event.documentIds.includes(view.document.id))void client.check();});
  const focus=()=>void client.check();window.addEventListener('focus',focus);
  void client.open();
  return()=>{removeChanges();removeGuard();remove();window.removeEventListener('message',message);window.removeEventListener('beforeunload',leave);window.removeEventListener('focus',focus);client.dispose();if(connection.current===client)connection.current=null;};
 },[view.document.id,csrf]);
 useEffect(()=>{
  const client=connection.current,opened=state.bootstrap,target=frame.current?.contentWindow;
  if(!client||!opened||!target||state.phase!=='open'||client.bridge)return;
  let remove:undefined|(()=>void);
  try{const bridge=client.attach(target);setEditor(bridge.snapshot());remove=bridge.subscribe(setEditor);form.current?.submit();}catch{setState(previous=>({...previous,errorCode:'OFFICE_UNAVAILABLE'}));}
  return()=>{remove?.();};
 },[state.bootstrap?.sessionId]);
 useEffect(()=>{if(!editor?.leaveRequested)return;connection.current?.bridge?.cancelLeave();window.dispatchEvent(new CustomEvent('yourwiki:navigate',{detail:'/'}));},[editor?.leaveRequested]);
 const loaded=!!editor?.loaded,paused=editor?.phase==='paused'||state.phase==='paused',closing=state.phase==='closing';
 const warning=state.errorCode==='OFFICE_RELEASE_UNCERTAIN'?t.release:paused?t.paused:editor?.phase==='conflict'?t.conflict:editor?.phase==='failed'?t.uncertain:state.errorCode?t.unavailable:state.readiness==='delayed'?t.delayed:'';
 const status=!loaded&&(state.readiness==='delayed'||state.phase==='failed')?t.preview:closing?t.closing:!loaded?t.loading:editor?.saving?t.saving:editor?.phase==='saved'?t.saved:editor?.needsRecovery?t.modified:t.ready;
 useEffect(()=>{if(!full)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setFull(false);};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[full]);
 return <section className={'office-workspace'+(full?' office-fullscreen':'')} data-loaded={loaded} data-readiness={state.readiness} aria-label={view.document.title}>
  <div className="office-toolbar"><p role="status" aria-live="polite">{status}</p>{loaded&&<>
   <button type="button" disabled={!editor?.write||closing||paused||!editor.needsRecovery||['failed','conflict'].includes(editor.phase)} onClick={()=>void connection.current?.save?.saveNow()}>{t.save}</button>
   {connection.current?.bridge?.pendingSave()&&<button type="button" disabled={closing||paused||editor?.phase==='conflict'} onClick={()=>void connection.current?.save?.checkNow()}>{t.check}</button>}
   {editor?.exportAllowed&&<button type="button" disabled={closing||paused} onClick={()=>void connection.current?.exportCurrent()}>{t.copy}</button>}
  </>}<button type="button" aria-pressed={full} onClick={()=>setFull(value=>!value)}>{full?t.restore:t.fullscreen}</button></div>
  {warning&&<p className="notice" role="alert">{warning}</p>}
  <OfficeRecoveryPanel documentId={view.document.id} csrf={csrf} onSessionLost={onSessionLost} autoOpen={state.phase==='open'&&(editor?.phase==='conflict'||editor?.phase==='failed')}/>
  <div className="office-stage">
   <div className="office-preview" hidden={loaded}>{children}</div>
   {state.bootstrap&&<>
    <iframe ref={frame} name={name} className={'office-frame'+(loaded?' office-frame-ready':'')} title={view.document.title} referrerPolicy="no-referrer" inert={paused||closing} sandbox={'allow-scripts allow-same-origin allow-forms allow-popups'+(editor?.exportAllowed??state.bootstrap.export?' allow-downloads':'')}/>
    <form ref={form} action={state.bootstrap.actionUrl} method="post" target={name} hidden><input type="hidden" name="access_token" value={state.bootstrap.accessToken}/><input type="hidden" name="access_token_ttl" value={state.bootstrap.expiresAt}/></form>
   </>}
  </div>
 </section>;
}
