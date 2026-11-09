import {FileChromeContext,FilePreviewWorkspace} from './FileChrome.tsx';
import LoadingSkeleton from './LoadingSkeleton.tsx';
import SiteHeader from './SiteHeader.tsx';
import UiIcon from './UiIcon.tsx';
import {readFilePanel,saveFilePanel} from './workspace-preferences.ts';
import ProviderSyncPanel from './ProviderSyncPanel.tsx';
import ProviderDeliveryPanel from './ProviderDeliveryPanel.tsx';
import GoogleActivityNotice from './GoogleActivityNotice.tsx';
import { Component,lazy,Suspense,useEffect,useRef,useState } from 'react';
import type { ErrorInfo,FormEvent,ReactNode } from 'react';
import { api,ApiError,assetUrl,isAborted } from './api.ts';
import type { Account,DocumentInfo,DocumentView } from './api.ts';
import {DocumentVisit} from './document-visit.ts';
import {subscribeRecentActivity,publishRecentActivity} from './recent-activity.ts';
import { blockSession,resumeSession,sessionSnapshot,onSessionBlocked } from './session-fence.ts';
import {startChangeFeed,publishChanges,subscribeChanges} from './live-updates.ts';
import { requestNavigation,hasUnsavedChanges } from './navigation-guard.ts';
import {RestoreEditorGate} from './restore-editor-gate.ts';
import type {RestoreOperation} from './history-restore-client.ts';
import {restoreLabels} from './history-restore-i18n.ts';
import { labels,languageFor } from './i18n.ts';
import type { Labels } from './i18n.ts';
const Invitations=lazy(()=>import('./administration/Invitations.tsx'));
const AdminPage=lazy(()=>import('./administration/AdminPage.tsx'));
const AccountPreferences=lazy(()=>import('./administration/AccountPreferences.tsx'));
const Dashboard=lazy(()=>import('./administration/Dashboard.tsx'));
const Files=lazy(()=>import('./administration/Files.tsx'));
const ResetPassword=lazy(()=>import('./ResetPassword.tsx'));
const Invitation=lazy(()=>import('./administration/Invitation.tsx'));
const SettingsPage=lazy(()=>import('./SettingsPage.tsx'));
const DocumentSidebar=lazy(()=>import('./DocumentSidebar.tsx'));
const ContentParityPanel=lazy(()=>import('./content-parity/ContentParityPanel.tsx'));
const MarkdownWorkspace=lazy(()=>import('./MarkdownWorkspace.tsx'));
const GraphWorkspace=lazy(()=>import('./content-parity/GraphWorkspace.tsx'));
const AISettings=lazy(()=>import('./content-parity/AISettings.tsx'));
const GoogleIdentityPanel=lazy(()=>import('./GoogleIdentityPanel.tsx'));
const GoogleOriginalControl=lazy(()=>import('./GoogleOriginalControl.tsx'));
const GoogleTrashControl=lazy(()=>import('./GoogleTrashControl.tsx'));
const HistoryPanel=lazy(()=>import('./HistoryPanel.tsx'));
const HistorySettingsPage=lazy(()=>import('./HistorySettingsPage.tsx'));
const OfficeRecoveryPanel=lazy(()=>import('./OfficeRecoveryPanel.tsx'));
const OfficeWorkspace=lazy(()=>import('./OfficeWorkspace.tsx'));
const PdfWorkspace=lazy(()=>import('./PdfWorkspace.tsx'));
const Presentation=lazy(()=>import('./Presentation.tsx'));
const authChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('yourwiki-auth'):null;
function preferredLanguage(){try{const p=JSON.parse(localStorage.getItem('yourwiki.preferences')??'{}');if(p.language==='ru'||p.language==='en')return p.language as 'ru'|'en';}catch{}return languageFor(navigator.language);}
const t=labels[preferredLanguage()];
document.documentElement.lang=preferredLanguage();
try{const p=JSON.parse(localStorage.getItem('yourwiki.preferences')??'{}');document.documentElement.dataset.theme=p.theme??'auto';document.documentElement.dataset.animations=p.animations?'on':'off';}catch{}
function navigate(path:string) {if(location.pathname!==path)window.dispatchEvent(new CustomEvent('yourwiki:navigate',{detail:path}));}
function Link({href,children,...props}:{href:string;children:ReactNode;className?:string;'aria-current'?:'page'}) {
  return <a href={href} {...props} onClick={event=>{if(!event.defaultPrevented&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(href);}}}>{children}</a>;
}
function message(error:unknown) {
  if(error instanceof ApiError) {
    if(['NOT_FOUND','ACCESS_DENIED'].includes(error.code))return t.denied;
    if(error.code==='SESSION_REQUIRED')return t.session;
    if(error.code==='INVALID_CREDENTIALS')return t.credentials;
    if(error.code==='RATE_LIMITED')return t.limited;
  }
  return t.error;
}
function ErrorBox({error,retry}:{error:unknown;retry?:()=>void}) {return <div className="notice error" role="alert"><p>{message(error)}</p>{error instanceof ApiError&&error.requestId&&<small>ID: {error.requestId}</small>}{retry&&<button type="button" onClick={retry}>{t.retry}</button>}</div>;}
class PreviewBoundary extends Component<{children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(_error:Error,_info:ErrorInfo) { /* No private content in logs. */ }
  render(){return this.state.failed?<ErrorBox error={new ApiError('INVALID_PREVIEW')} retry={()=>location.reload()}/>:this.props.children;}
}
class HistoryBoundary extends Component<{children:ReactNode;onClose:()=>void},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(_error:Error,_info:ErrorInfo){ /* Keep the live editor mounted when optional history fails. */ }
  render(){return this.state.failed?<aside className="notice" role="alert"><p>{t.error}</p><button type="button" onClick={this.props.onClose}>{t.closeHistory}</button></aside>:this.props.children;}
}
function Login({onLogin,notice}:{onLogin:(account:Account)=>void;notice?:unknown}) {
  const [pending,setPending]=useState(false),[error,setError]=useState<unknown>(notice);
  const lifetime=useRef<AbortController|null>(null),busy=useRef(false);
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>controller.abort();},[]);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const signal=lifetime.current?.signal;if(!signal||signal.aborted||busy.current)return;busy.current=true;const data=new FormData(event.currentTarget);setPending(true);setError(null);
    try {await api('/api/auth/login',{signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:data.get('username'),password:data.get('password')})});const value=await api<Account>('/api/account',{signal});if(!signal.aborted)onLogin(value);}
    catch(error){if(!signal.aborted&&!isAborted(error))setError(error);}finally{busy.current=false;if(!signal.aborted)setPending(false);}
  }
  return <main id="content" className="login"><Link href="/" className="brand">Yourwiki<span>·</span></Link><h1>{t.signIn}</h1><p className="muted">{t.welcome}</p><form onSubmit={submit}><label>{t.username}<input name="username" autoComplete="username" required maxLength={150}/></label><label>{t.password}<input name="password" type="password" autoComplete="current-password" required maxLength={1024}/></label>{error?<ErrorBox error={error}/>:null}<button className="primary" disabled={pending}>{pending?t.loading:t.signIn}</button></form></main>;
}
function StorageUploadNotice({id,onReady,onSessionLost}:{id:string;onReady:()=>void;onSessionLost:()=>void}){
 useEffect(()=>{const control=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;async function poll(){if(control.signal.aborted||sessionSnapshot().blocked)return;try{const doc=await api<DocumentInfo>('/api/documents/'+encodeURIComponent(id),{signal:control.signal});if(control.signal.aborted)return;if(!doc.storagePending){onReady();return;}}catch(error){if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){onSessionLost();return;}if(control.signal.aborted)return;}timer=setTimeout(()=>void poll(),2000);}void poll();return()=>{control.abort();clearTimeout(timer);};},[id]);
 return <p className="notice" role="status">{preferredLanguage()==='ru'?'Файл отправляется в Google Drive. Предпросмотр доступен; редактирование включится после подтверждения отправки. При задержке проверьте подключение Google в настройках.':'Uploading to Google Drive. Preview is available; editing starts after upload confirmation. Check Google connection settings if uploading is delayed.'}</p>;
}
function Library({onSessionLost,active,recent=false,account}:{onSessionLost:()=>void;active:boolean;recent?:boolean;account:Account}) {
  const [items,setItems]=useState<(DocumentInfo&{openedAt?:number})[]>([]),[cursor,setCursor]=useState<string|null>(null),[pending,setPending]=useState(true),[error,setError]=useState<unknown>(null),[filter,setFilter]=useState('');
  const lifetime=useRef<AbortController|null>(null),request=useRef<AbortController|null>(null),activeRef=useRef(active);activeRef.current=active;
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;const clear=()=>{request.current?.abort();setItems([]);setCursor(null);setError(null);};const remove=subscribeChanges(event=>{if(event.type==='all')clear();else request.current?.abort();if(activeRef.current)void load();});const unblock=onSessionBlocked(clear),unrecent=subscribeRecentActivity(()=>{if(recent&&activeRef.current)void load();});return()=>{controller.abort();request.current?.abort();remove();unblock();unrecent();};},[]);
  useEffect(()=>{if(active)void load();},[active]);
  async function load(after?:string){
    if(lifetime.current?.signal.aborted||sessionSnapshot().blocked)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;const signal=controller.signal;
    setPending(true);setError(null);
    try{const page=await api<{items:(DocumentInfo&{openedAt?:number})[];nextCursor:string|null}>((recent?'/api/recent':'/api/documents')+(after?'?after='+encodeURIComponent(after):''),{signal});if(signal.aborted||request.current!==controller)return;setItems(old=>after?[...old,...page.items.filter(item=>!old.some(previous=>previous.id===item.id))]:page.items);setCursor(page.nextCursor);}
    catch(error){if(signal.aborted||isAborted(error))return;setItems([]);setCursor(null);if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){if(!sessionSnapshot().blocked)onSessionLost();}else setError(error);}
    finally{if(!signal.aborted&&request.current===controller)setPending(false);}
  }
  const treeShown=!recent&&!filter.trim();
  const shown=items.filter(item=>item.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <main id={active?"content":undefined} className="library" aria-busy={pending}><div className="page-heading"><div><p className="eyebrow">Yourwiki</p><h1>{recent?t.recent:t.files}</h1></div><label className="search"><UiIcon name="search"/><span className="sr-only">{t.search}</span><input type="search" placeholder={t.search} value={filter} onChange={e=>setFilter(e.target.value)}/></label></div>
    {!treeShown&&error?<ErrorBox error={error} retry={()=>void load()}/>:null}
    {!recent&&<Suspense fallback={null}><Files inline active={active} showTree={treeShown} csrf={account.csrf} groups={account.user.groups} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={onSessionLost}/></Suspense>}
    {!treeShown&&<><ul className="file-list">{shown.map(item=><li key={item.id}><Link href={'/documents/'+encodeURIComponent(item.id)}><span className="file-format">{item.format.toUpperCase()}</span><span className="file-title">{item.title}{recent&&item.openedAt!==undefined&&<time className="file-opened" dateTime={new Date(item.openedAt).toISOString()}>{new Date(item.openedAt).toLocaleString(document.documentElement.lang,{dateStyle:"medium",timeStyle:"short"})}</time>}</span><span className="file-open" aria-hidden="true">↗</span></Link></li>)}</ul>
    {pending?<p role="status">{t.loading}</p>:shown.length===0&&!error?<p className="empty">{filter?t.noMatches:recent?t.recentEmpty:t.empty}</p>:null}
    {cursor&&<button type="button" disabled={pending} onClick={()=>void load(cursor)}>{t.more}</button>}</>}
  </main>;
}
const ResourceSettings=lazy(()=>import('./administration/ResourceSettings.tsx'));
function DocumentPage({id,accountId,onSessionLost,csrf,admin,pageMode=false}:{pageMode?:boolean;id:string;accountId:string;onSessionLost:()=>void;csrf:string;admin:boolean}) {
  const [fileSettings,setFileSettings]=useState(false),[trashBusy,setTrashBusy]=useState(false);
  const [view,setView]=useState<DocumentView|null>(null),[error,setError]=useState<unknown>(null),[attempt,setAttempt]=useState(0);
  const currentView=useRef<DocumentView|null>(null),officeMounted=useRef(false),visit=useRef<DocumentVisit|null>(null);
  const [visitFailed,setVisitFailed]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[detailsOpen,setDetailsOpen]=useState(false),[detailsVisited,setDetailsVisited]=useState(false);
  const historyButton=useRef<HTMLButtonElement|null>(null),[sidebarOpen,setSidebarOpen]=useState(()=>!matchMedia('(max-width:850px)').matches&&readFilePanel().open);
  useEffect(()=>{const media=matchMedia('(max-width:850px)'),update=()=>setSidebarOpen(media.matches?false:readFilePanel().open);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  function toggleSidebar(){setSidebarOpen(value=>{if(!matchMedia('(max-width:850px)').matches)saveFilePanel({open:!value});return !value;});}
  const [restoreLocked,setRestoreLocked]=useState(false),[officeSuspended,setOfficeSuspended]=useState(false),[restoreTarget,setRestoreTarget]=useState<RestoreOperation|null>(null),[officeEpoch,setOfficeEpoch]=useState(0);
  const restoreGate=useRef<RestoreEditorGate|null>(null);
  if(!restoreGate.current)restoreGate.current=new RestoreEditorGate({dirty:hasUnsavedChanges,release:requestNavigation,suspend:()=>{setRestoreTarget(null);setRestoreLocked(true);setOfficeSuspended(true);},unlock:()=>{setRestoreLocked(false);setOfficeSuspended(false);setOfficeEpoch(n=>n+1);},refresh:operation=>{setRestoreLocked(true);setOfficeSuspended(true);setRestoreTarget(operation);setAttempt(n=>n+1);}});
  const restoreActions=useRef({editorDirty:hasUnsavedChanges,releaseEditor:(action:()=>Promise<void>)=>restoreGate.current!.release(action),settled:(value:{state:'saved'|'discarded'|'not_started';operation:RestoreOperation|null})=>restoreGate.current!.settled(value)}).current;
  useEffect(()=>{if(!restoreTarget?.receipt||!view||view.document.revision<restoreTarget.receipt.revision)return;setRestoreLocked(false);setOfficeSuspended(false);setOfficeEpoch(n=>n+1);setRestoreTarget(null);},[view,restoreTarget]);
  useEffect(()=>{const tracker=new DocumentVisit({documentId:id,csrf,recorded:publishRecentActivity,changed:state=>{setVisitFailed(state.phase==='error');if(state.error instanceof ApiError&&state.error.code==='SESSION_REQUIRED'&&!sessionSnapshot().blocked)onSessionLost();}});visit.current=tracker;return()=>{tracker.dispose();visit.current=null;};},[id,csrf]);
  useEffect(()=>{if(view)void visit.current?.opened();},[view,csrf]);
  useEffect(()=>{
    let request:AbortController|undefined,closed=false,pollTimer:ReturnType<typeof setTimeout>|undefined;setView(null);currentView.current=null;setError(null);
    function load(){
      if(closed||sessionSnapshot().blocked)return;request?.abort();const controller=new AbortController();request=controller;
      void api<DocumentView>(`/api/documents/${encodeURIComponent(id)}/view`,{signal:controller.signal}).then(value=>{
        if(closed||controller.signal.aborted||request!==controller)return;
        setError(null);if(JSON.stringify(value)!==JSON.stringify(currentView.current)){currentView.current=value;setView(value);}document.title=value.document.title+' · Yourwiki';
      }).catch(async error=>{if(closed||controller.signal.aborted||isAborted(error))return;if(error instanceof ApiError&&error.code==='NOT_FOUND'){try{const status=await api<{state:string;errorCode:string|null}>('/api/documents/'+encodeURIComponent(id)+'/processing',{signal:controller.signal});if(closed||controller.signal.aborted)return;if(['queued','preparing'].includes(status.state)){setError(null);pollTimer=setTimeout(load,500);return;}if(status.state==='failed'){setError(new ApiError(status.errorCode??'PREVIEW_FAILED'));return;}}catch{/* Ordinary missing or inaccessible file. */}}if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){if(!sessionSnapshot().blocked)onSessionLost();}else setError(error);});
    }
    load();const remove=subscribeChanges(event=>{if(currentView.current?.manifest.kind==='pdf')return;if(event.type==='all'||event.documentIds.includes(id))load();});
    return()=>{closed=true;clearTimeout(pollTimer);request?.abort();remove();};
  },[id,attempt]);
  const sourceDenied=error instanceof ApiError&&['SESSION_REQUIRED','NOT_FOUND','ACCESS_DENIED'].includes(error.code);
  const sourcePanel=null;
  const preview=view?<PreviewBoundary key={['canvas','drawio'].includes(view.manifest.kind)||['md','markdown','txt','text'].includes(view.document.format)?id:id+view.document.manifestDigest}><Suspense fallback={<LoadingSkeleton label={t.loading}/>}>
      {['md','markdown','txt','text'].includes(view.document.format)?<MarkdownWorkspace sourcePanel={sourcePanel} pageMode={pageMode} fallback={<iframe className="document-frame" title={view.document.title} src={assetUrl(view,view.manifest.primary)} sandbox="allow-same-origin"/>} documentId={id} csrf={csrf} write={view.document.capabilities.write} onSessionLost={onSessionLost}/>:['canvas','drawio'].includes(view.manifest.kind)?<GraphWorkspace sourcePanel={sourcePanel} documentId={id} csrf={csrf} canExport={view.document.capabilities.export} write={view.document.capabilities.write} format={view.document.format} onSessionLost={onSessionLost}/>:view.manifest.kind==='pdf'?<PdfWorkspace view={view} csrf={csrf}/>:view.manifest.kind==='presentation'?<Presentation view={view} t={t}/>:['document','table'].includes(view.manifest.kind)?<FilePreviewWorkspace title={view.document.title}><iframe key={view.document.manifestDigest} className="document-frame" title={view.document.title} src={assetUrl(view,view.manifest.primary)} sandbox="allow-same-origin"/></FilePreviewWorkspace>:<p className="empty">{t.unsupported}</p>}
    </Suspense></PreviewBoundary>:null;
  if(pageMode){const denied=error instanceof ApiError&&['NOT_FOUND','ACCESS_DENIED'].includes(error.code);return <main id="content" className="dashboard-page">{error?<ErrorBox error={error} retry={!view?()=>setAttempt(x=>x+1):undefined}/>:null}{!denied&&(view?preview:!error&&<p role="status">{t.loading}</p>)}</main>;}
  if(view?.document.capabilities.office===true&&!['md','markdown','txt','text'].includes(view.document.format)&&['document','table','presentation'].includes(view.manifest.kind))officeMounted.current=true;
  const office=officeMounted.current;
  const chrome={sidebarOpen,toggleSidebar,openSidebar:()=>{setSidebarOpen(true);if(!matchMedia('(max-width:850px)').matches)saveFilePanel({open:true});},trash:view?.document.capabilities.googleTrash?<Suspense fallback={null}><GoogleTrashControl documentId={id} title={view.document.title} csrf={csrf} onSessionLost={onSessionLost} onRemoved={()=>{publishChanges({type:'all'});navigate('/settings');}}/></Suspense>:view&&admin?<button type="button" disabled={trashBusy} onClick={()=>{if(trashBusy)return;setTrashBusy(true);void requestNavigation(async()=>{try{const confirmation=await api<{confirmation:string;name:string}>('/api/admin/trash/confirmation/resource/'+encodeURIComponent(id));if(!window.confirm((document.documentElement.lang==='ru'?'Переместить в корзину: ':'Move to trash: ')+confirmation.name+'?'))return;await api('/api/admin/trash/objects/resource/'+encodeURIComponent(id),{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(confirmation)});publishChanges({type:'all'});navigate('/');}catch(e){setError(e);}}).finally(()=>setTrashBusy(false));}}>{document.documentElement.lang==='ru'?'В корзину':'Move to trash'}</button>:null,settings:view&&admin?<button type="button" onClick={()=>setFileSettings(true)}>{document.documentElement.lang==='ru'?'Настройки файла':'File settings'}</button>:null,external:view?<ProviderSyncPanel delivery={<ProviderDeliveryPanel initial={view.sourceDelivery} documentId={id} accountId={accountId} csrf={csrf} write={view.document.capabilities.write} onSessionLost={onSessionLost}/>} activity={!sourceDenied&&view.googleActivity?<GoogleActivityNotice key={id} activity={view.googleActivity}/>:null} initial={view.sourceSync} initialAction={view.sourceSyncAction} csrf={csrf} write={view.document.capabilities.write} documentId={id} accountId={accountId} onSessionLost={onSessionLost}/>:null,recovery:view?<Suspense fallback={null}><OfficeRecoveryPanel documentId={id} csrf={csrf} onSessionLost={onSessionLost}/></Suspense>:null,original:view&&!sourceDenied&&view.googleOriginal&&view.googleOriginal.reason!=='not_google'?<Suspense fallback={null}><GoogleOriginalControl key={id+JSON.stringify(view.googleOriginal)} initial={view.googleOriginal} documentId={id} csrf={csrf} onSessionLost={onSessionLost}/></Suspense>:null};
  return <FileChromeContext.Provider value={chrome}><main id="content" className="document-page">{fileSettings&&view&&<Suspense fallback={null}><ResourceSettings item={{id,title:view.document.title,kind:'document'}} csrf={csrf} onSessionLost={onSessionLost} onClose={()=>setFileSettings(false)}/></Suspense>}<div className="document-toolbar"><Link href="/" className="back">← {t.back}</Link><div className="document-name"><h1>{view?.document.title??t.preview}</h1>{view&&<span className="muted">{view.document.format.toUpperCase()} · {t.read}</span>}</div></div>
    {view&&!office&&!['canvas','drawio'].includes(view.manifest.kind)&&!['md','markdown','txt','text'].includes(view.document.format)&&sourcePanel}
    {view?.document.storagePending&&<StorageUploadNotice id={id} onReady={()=>setAttempt(n=>n+1)} onSessionLost={onSessionLost}/> }
    {visitFailed&&<p className="visit-notice" role="status">{t.visitFailed} <button type="button" onClick={()=>void visit.current?.retry()}>{t.retry}</button></p>}
    {error?<ErrorBox error={error} retry={!view?()=>setAttempt(x=>x+1):undefined}/>:null}

    {restoreLocked&&<p className="notice" role="status">{restoreTarget?restoreLabels[languageFor(navigator.language)].preparing:restoreLabels[languageFor(navigator.language)].locked} <button type="button" onClick={()=>{setSidebarOpen(true);setHistoryOpen(true);}}>{restoreLabels[languageFor(navigator.language)].reopen}</button></p>}
    <div className="document-workspace" data-sidebar-open={sidebarOpen}><div className="document-editor" inert={restoreLocked} aria-busy={restoreLocked}>{!view?!error&&<LoadingSkeleton label={t.loading}/>:office&&!officeSuspended?<Suspense fallback={<p className="loading" role="status">Collabora…</p>}><OfficeWorkspace sourcePanel={sourcePanel} key={officeEpoch} view={view} csrf={csrf} onSessionLost={onSessionLost}>{preview}</OfficeWorkspace></Suspense>:preview}</div>{view&&<Suspense fallback={null}><DocumentSidebar open={sidebarOpen} onClose={()=>{setSidebarOpen(false);if(!matchMedia('(max-width:850px)').matches)saveFilePanel({open:false});}} key={accountId+csrf} documentId={id} csrf={csrf} write={view.document.capabilities.write} canExport={view.document.capabilities.export} onDocumentChanged={()=>setAttempt(x=>x+1)} onSessionLost={onSessionLost} historyOpen={historyOpen} historyButton={historyButton} onHistory={()=>setHistoryOpen(v=>!v)} editors={null} history={<>{historyOpen&&<HistoryBoundary onClose={()=>{setHistoryOpen(false);requestAnimationFrame(()=>historyButton.current?.focus());}}><Suspense fallback={<p role="status">{t.loading}</p>}><HistoryPanel accountId={accountId} restoreActions={restoreActions} documentId={id} csrf={csrf} admin={admin} onSessionLost={onSessionLost} onClose={()=>{setHistoryOpen(false);requestAnimationFrame(()=>historyButton.current?.focus());}}/></Suspense></HistoryBoundary>}</>}/></Suspense>}</div>
  </main></FileChromeContext.Provider>;
}
function AccountPage({account,onSessionLost}:{account:Account;onSessionLost:()=>void}) {return <main id="content" className="account-page account-hub"><p className="eyebrow">Yourwiki</p><h1>{t.account}</h1><div className="account-layout"><aside className="account-identity"><div className="profile-card"><span className="avatar" aria-hidden="true">{account.user.displayName.slice(0,1).toUpperCase()}</span><div><h2>{account.user.displayName}</h2><p className="muted">@{account.user.username}</p></div></div><dl><dt>{t.groups}</dt><dd>{account.user.groups.map(group=>group.name).join(', ')||'—'}</dd><dt>{t.role}</dt><dd>{account.user.adminRole==='giga'?t.giga:account.user.adminRole==='simple'?t.simple:t.member}</dd></dl></aside><div className="account-settings"><Suspense fallback={<p role="status">{t.loading}</p>}><AccountPreferences csrf={account.csrf} onSessionLost={onSessionLost}/></Suspense>{account.user.canInvite&&<Suspense fallback={<p role="status">{t.loading}</p>}><Invitations csrf={account.csrf} onSessionLost={onSessionLost}/></Suspense>}{account.features?.googleIdentity&&<Suspense fallback={<p role="status">{t.loading}</p>}><GoogleIdentityPanel csrf={account.csrf} onSessionLost={onSessionLost}/></Suspense>}</div></div></main>;}
export default function App() {
  const [authPaused,setAuthPaused]=useState(false);
  const [authEpoch,setAuthEpoch]=useState(0);
  useEffect(()=>{if(!authChannel)return;const changed=()=>{blockSession();setError(new ApiError('SESSION_REQUIRED'));if(hasUnsavedChanges()){setAuthPaused(true);return;}setAccount(undefined);setAuthEpoch(value=>value+1);};authChannel.addEventListener('message',changed);return()=>authChannel.removeEventListener('message',changed);},[]);
  const [libraryVisited,setLibraryVisited]=useState(location.pathname==='/'),[recentVisited,setRecentVisited]=useState(location.pathname==='/recent');
  useEffect(()=>{const update=()=>{if(location.pathname==='/')setLibraryVisited(true);};window.addEventListener('popstate',update);return()=>window.removeEventListener('popstate',update);},[]);
  const [account,setAccount]=useState<Account|null|undefined>(undefined),[path,setPath]=useState(location.pathname),[error,setError]=useState<unknown>(null);
  useEffect(()=>{const generation=sessionSnapshot().generation,controller=new AbortController();void api<Account>('/api/account',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){resumeSession();setAuthPaused(false);setAccount(value);}}).catch(error=>{if(!controller.signal.aborted&&generation===sessionSnapshot().generation&&!isAborted(error)){if(!(error instanceof ApiError&&error.code==='SESSION_REQUIRED'))setError(error);setAccount(null);}});return()=>controller.abort();},[authEpoch]);
  useEffect(()=>{
    let previousPath=location.pathname,moving=false,live=true;let requested:string|null=null;
    const move=(next:string)=>{
      if(next===previousPath&&!moving)return;requested=next;if(moving)return;moving=true;
      void requestNavigation(()=>{if(!live||requested===null)return;if(location.pathname!==requested)history.pushState(null,'',requested);previousPath=requested;setPath(requested);if(requested==='/')setLibraryVisited(true);if(requested==='/recent')setRecentVisited(true);}).then(allowed=>{if(!allowed&&live&&location.pathname!==previousPath)history.pushState(null,'',previousPath);}).finally(()=>{moving=false;requested=null;});
    };
    const pop=()=>move(location.pathname),link=(event:Event)=>{const next=(event as CustomEvent<unknown>).detail;if(typeof next==='string'&&/^\/(?:$|account$|settings$|recent$|dashboard$|invite$|folders\/[^?#]+$|documents\/[^?#]+$)/.test(next))move(next);};
    window.addEventListener('popstate',pop);window.addEventListener('yourwiki:navigate',link);return()=>{live=false;window.removeEventListener('popstate',pop);window.removeEventListener('yourwiki:navigate',link);};
  },[]);
  useEffect(()=>{
    if(!account||authPaused)return;
    const controller=new AbortController();
    const stop=startChangeFeed({changed:publishChanges,expired:sessionLost,verify:async()=>{
      try{const current=await api<Account>('/api/account',{signal:controller.signal});return current.user.id===account.user.id&&current.csrf===account.csrf;}
      catch(error){if(error instanceof ApiError&&error.code==='SESSION_REQUIRED')return false;throw error;}
    }});
    return()=>{controller.abort();stop();};
  },[account,authPaused]);
  function sessionLost(){blockSession();setAuthPaused(true);setError(new ApiError('SESSION_REQUIRED'));if(!hasUnsavedChanges())setAccount(null);}
  function recoverSession(){void requestNavigation(()=>{setAccount(undefined);setAuthEpoch(value=>value+1);});}
  async function signOut(){await requestNavigation(async()=>{try{await api('/api/auth/logout',{method:'POST',headers:{'x-csrf-token':account!.csrf}});blockSession();setAccount(null);setError(null);authChannel?.postMessage('changed');}catch(error){if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){blockSession();setAccount(null);setError(error);}else setError(error);}});}
  useEffect(()=>{if(!path.startsWith('/documents/'))document.title='Yourwiki';},[path]);
  if(path==='/reset-password')return <Suspense fallback={<p role="status">{t.loading}</p>}><ResetPassword/></Suspense>;
  if(path==='/invite')return <Suspense fallback={<p role="status">{t.loading}</p>}><Invitation/></Suspense>;
  if(account===undefined)return <main id="content" className="loading"><LoadingSkeleton label={t.loading}/></main>;
  if(!account)return <Login onLogin={value=>{resumeSession();setAuthPaused(false);setError(null);setAccount(value);authChannel?.postMessage('changed');}} notice={error}/>;
  let id='';try{if(path.startsWith('/documents/'))id=decodeURIComponent(path.slice('/documents/'.length));}catch{/* invalid URL handled below */}
  return <><a className="skip" href="#content">{t.skip}</a><SiteHeader account={account} path={path} paused={authPaused} onSignOut={()=>authPaused?recoverSession():void signOut()}/>{error?<ErrorBox error={error}/>:null}{libraryVisited&&<div className="library-route" hidden={path!=='/'}><Library key={account.user.id+account.csrf} onSessionLost={sessionLost} account={account} active={path==='/'}/></div>}{recentVisited&&<div className="library-route" hidden={path!=='/recent'}><Library key={account.user.id+account.csrf} recent onSessionLost={sessionLost} account={account} active={path==='/recent'}/></div>}{path==='/dashboard'?<Suspense fallback={<p role="status">{t.loading}</p>}><Dashboard key={account.user.id+account.csrf} csrf={account.csrf} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={sessionLost} renderDocument={id=><DocumentPage pageMode key={id} id={id} accountId={account.user.id} csrf={account.csrf} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={sessionLost}/>}/></Suspense>:path.startsWith('/folders/')?<Suspense fallback={<p role="status">{t.loading}</p>}><Files key={path} parentId={decodeURIComponent(path.slice('/folders/'.length))} csrf={account.csrf} groups={account.user.groups} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={sessionLost}/></Suspense>:id?<DocumentPage key={id} id={id} accountId={account.user.id} onSessionLost={sessionLost} csrf={account.csrf} admin={['giga','simple'].includes(account.user.adminRole)}/>:path==='/account'?<AccountPage account={account} onSessionLost={sessionLost}/>:path==='/settings'?['giga','simple'].includes(account.user.adminRole)?<Suspense fallback={<main id="content" className="loading"><LoadingSkeleton label={t.loading}/></main>}><SettingsPage key={account.user.id+account.csrf} account={account} onSessionLost={sessionLost}/></Suspense>:<main id="content" className="account-page"><h1>{t.settings}</h1><p role="alert">{t.settingsDenied}</p></main>:null}</>;
}
