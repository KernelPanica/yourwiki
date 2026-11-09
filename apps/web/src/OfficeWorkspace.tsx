import {FileActionBar,FilePanelToggle,FileChromeContext} from './FileChrome.tsx';
import {googleFileError} from './google-errors.ts';
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
export default function OfficeWorkspace({view,csrf,children,onSessionLost,sourcePanel}:{view:DocumentView;csrf:string;children:ReactNode;sourcePanel?:ReactNode;onSessionLost:()=>void}){
 const frame=useRef<HTMLIFrameElement>(null),form=useRef<HTMLFormElement>(null),connection=useRef<OfficeConnection|null>(null),openingRevision=useRef(view.document.revision),restarting=useRef<OfficeConnection|null>(null);
 const name='yourwiki-office-'+useId().replace(/[^a-z0-9_-]/gi,'');
 const [state,setState]=useState<OfficeConnectionSnapshot>({phase:'idle',bootstrap:null,errorCode:null,readiness:'waiting'}),[editor,setEditor]=useState<OfficeSnapshot|null>(null),[full,setFull]=useState(()=>matchMedia('(max-width:850px)').matches),[openingEpoch,setOpeningEpoch]=useState(0),[closeHeld,setCloseHeld]=useState(false);
 useEffect(()=>{
  const client=new OfficeConnection({documentId:view.document.id,csrf,language,readonly:false,format:view.manifest.kind==='table'?'xlsx':view.manifest.kind==='presentation'?'pptx':'docx',onSessionLost});connection.current=client;openingRevision.current=view.document.revision;restarting.current=null;setEditor(null);setCloseHeld(false);setState(client.snapshot());
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
 },[view.document.id,csrf,openingEpoch]);
 useEffect(()=>{
  const client=connection.current,opened=state.bootstrap,target=frame.current?.contentWindow;
  if(!client||!opened||!target||state.phase!=='open'||client.bridge)return;
  let remove:undefined|(()=>void);
  try{const bridge=client.attach(target);setEditor(bridge.snapshot());remove=bridge.subscribe(setEditor);form.current?.submit();}catch{setState(previous=>({...previous,errorCode:'OFFICE_UNAVAILABLE'}));}
  return()=>{remove?.();};
 },[state.bootstrap?.sessionId]);
 function reopen(client:OfficeConnection){if(restarting.current===client)return;restarting.current=client;void client.close().then(closed=>{if(connection.current!==client)return;if(closed)setOpeningEpoch(value=>value+1);else restarting.current=null;});}
 useEffect(()=>{if(state.reloadRequested&&connection.current)reopen(connection.current);},[state.reloadRequested]);
 // Another collaborator's save can advance /view within the same valid room.
 // Only verified external-origin metadata or the room status proves replacement.
 useEffect(()=>{
  const client=connection.current,bridge=client?.bridge;if(!client||!bridge||state.phase!=='open'||!editor?.loaded)return;
  // The status may reopen a newer room before the matching /view arrives.
  // Its authenticated bootstrap identifies the bytes that this frame opened.
  if(state.bootstrap?.write&&view.document.capabilities.write===false){client.save?.dispose();bridge.pause('ACCESS_DENIED');return;}
  const base=Math.max(state.bootstrap?.baseRevision??openingRevision.current,editor.localRevision??0);
  if(view.document.revision<=base)return;
  if(!view.googleActivity||view.googleActivity.revision<=base){void client.check();return;}
  if(state.bootstrap?.write){client.markSourceChanged();return;}
  if(bridge.pendingSave())return;if(editor.needsRecovery){bridge.saveFailed('CONFLICT');return;}reopen(client);
 },[view.document.revision,view.googleActivity?.revision,view.document.capabilities.write,editor?.loaded,editor?.localRevision,editor?.needsRecovery,editor?.saving,state.phase]);
 useEffect(()=>{if(!editor?.leaveRequested)return;connection.current?.bridge?.cancelLeave();if(state.sourceChanged||editor.needsRecovery||editor.phase==='conflict'){setCloseHeld(true);return;}window.dispatchEvent(new CustomEvent('yourwiki:navigate',{detail:'/'}));},[editor?.leaveRequested,state.sourceChanged,editor?.needsRecovery,editor?.phase]);
 const googleSource=!!view.googleActivity||!!view.googleOriginal&&view.googleOriginal.reason!=='not_google';
 const loaded=!!editor?.loaded,paused=editor?.phase==='paused'||state.phase==='paused',closing=state.phase==='closing';
 const warning=state.errorCode==='OFFICE_RELEASE_UNCERTAIN'?t.release:paused?t.paused:editor?.phase==='conflict'||state.errorCode==='CONFLICT'?t.conflict:editor?.phase==='failed'?t.uncertain:state.errorCode?t.unavailable:state.readiness==='delayed'?t.delayed:'';
 const status=closing?t.closing:!loaded?(language==='ru'?'Открытие Collabora…':'Opening Collabora…'):editor?.saving?t.saving:editor?.phase==='saved'?t.saved:editor?.needsRecovery?t.modified:'Collabora';
 useEffect(()=>{if(!full)return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setFull(false);}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[full]);
 return <section className={'office-workspace'+(full?' office-fullscreen':'')} data-loaded={loaded} data-readiness={state.readiness} aria-label={view.document.title}>
  <div className="office-file-details">{sourcePanel}</div><FileActionBar recovery={<OfficeRecoveryPanel documentId={view.document.id} csrf={csrf} onSessionLost={onSessionLost} autoOpen={state.phase==='open'&&(editor?.phase==='conflict'||editor?.phase==='failed')}/>}/><div className="office-toolbar"><p role="status" aria-live="polite">{status}</p>{loaded&&<>
   {connection.current?.bridge?.pendingSave()&&<button type="button" disabled={closing||paused||editor?.phase==='conflict'} onClick={()=>void connection.current?.save?.checkNow()}>{t.check}</button>}

  </>}<button type="button" aria-pressed={full} onClick={()=>{setFull(value=>!value);}}>{full?t.restore:t.fullscreen}</button><FilePanelToggle fullscreen={full} onExitFullscreen={()=>setFull(false)}/></div>
  {warning&&<p className="notice" role="alert">{warning}</p>}
  {state.sourceChanged&&!paused&&<div className="office-source-changed file-source-banner" role="status"><p>{language==='ru'?`Оригинал изменён ${googleSource?'в Google':'в хранилище'}. Редактор оставлен открытым, автосохранение остановлено. Новая версия откроется после перезагрузки страницы. Перед этим скопируйте несохранённые правки или сохраните разрешённую копию.`:`The original changed in ${googleSource?'Google':'storage'}. The editor remains open and autosave has stopped. Reload the page to open the new version. Copy your unsaved changes or save an allowed copy first.`}</p></div>}
  {closeHeld&&<p className="notice" role="status">{language==='ru'?'Редактор оставлен открытым, чтобы сохранить ваши правки. Перед выходом скопируйте их или сохраните разрешённую копию.':'The editor remains open to preserve your changes. Copy them or save an allowed copy before leaving.'}</p>}
  {editor?.errorCode&&<p className="notice" role="alert">{googleFileError(editor.errorCode,language==='ru')}</p>}

  <div className="office-stage">
   <div className="office-preview" hidden={loaded}>{state.phase==='failed'?<FileChromeContext.Provider value={null}>{children}</FileChromeContext.Provider>:<p className="loading" role="status">{language==='ru'?'Открытие Collabora…':'Opening Collabora…'}</p>}</div>
   {state.bootstrap&&<>
    <iframe ref={frame} name={name} className={'office-frame'+(loaded?' office-frame-ready':'')} title={view.document.title} referrerPolicy="no-referrer" inert={paused||closing} sandbox="allow-scripts allow-same-origin allow-forms allow-popups"/>
    <form ref={form} action={state.bootstrap.actionUrl} method="post" target={name} hidden><input type="hidden" name="access_token" value={state.bootstrap.accessToken}/><input type="hidden" name="access_token_ttl" value={state.bootstrap.expiresAt}/></form>
   </>}
  </div>
 </section>;
}
