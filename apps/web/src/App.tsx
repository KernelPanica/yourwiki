import ProviderSyncPanel from './ProviderSyncPanel.tsx';
import ProviderDeliveryPanel from './ProviderDeliveryPanel.tsx';
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
const AdminPage=lazy(()=>import('./administration/AdminPage.tsx'));
const AccountPreferences=lazy(()=>import('./administration/AccountPreferences.tsx'));
const Dashboard=lazy(()=>import('./administration/Dashboard.tsx'));
const Files=lazy(()=>import('./administration/Files.tsx'));
const Invitation=lazy(()=>import('./administration/Invitation.tsx'));
const ContentParityPanel=lazy(()=>import('./content-parity/ContentParityPanel.tsx'));
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
  const shown=items.filter(item=>item.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <main id={active?"content":undefined} className="library" aria-busy={pending}><div className="page-heading"><div><p className="eyebrow">Yourwiki</p><h1>{recent?t.recent:t.files}</h1></div><label className="search"><span className="sr-only">{t.search}</span><input type="search" placeholder={t.search} value={filter} onChange={e=>setFilter(e.target.value)}/></label></div>
    {error?<ErrorBox error={error} retry={()=>void load()}/>:null}
    {!recent&&<Suspense fallback={null}><Files inline csrf={account.csrf} groups={account.user.groups} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={onSessionLost}/></Suspense>}
    <ul className="file-list">{shown.map(item=><li key={item.id}><Link href={'/documents/'+encodeURIComponent(item.id)}><span className="file-format">{item.format.toUpperCase()}</span><span className="file-title">{item.title}{recent&&item.openedAt!==undefined&&<time className="file-opened" dateTime={new Date(item.openedAt).toISOString()}>{new Date(item.openedAt).toLocaleString(document.documentElement.lang,{dateStyle:"medium",timeStyle:"short"})}</time>}</span><span className="file-open" aria-hidden="true">↗</span></Link></li>)}</ul>
    {pending?<p role="status">{t.loading}</p>:shown.length===0&&!error?<p className="empty">{filter?t.noMatches:recent?t.recentEmpty:t.empty}</p>:null}
    {cursor&&<button type="button" disabled={pending} onClick={()=>void load(cursor)}>{t.more}</button>}
  </main>;
}
function DocumentPage({id,accountId,onSessionLost,csrf,admin}:{id:string;accountId:string;onSessionLost:()=>void;csrf:string;admin:boolean}) {
  const [view,setView]=useState<DocumentView|null>(null),[error,setError]=useState<unknown>(null),[attempt,setAttempt]=useState(0);
  const currentView=useRef<DocumentView|null>(null),officeMounted=useRef(false),visit=useRef<DocumentVisit|null>(null);
  const [visitFailed,setVisitFailed]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[detailsOpen,setDetailsOpen]=useState(false),[detailsVisited,setDetailsVisited]=useState(false);
  const historyButton=useRef<HTMLButtonElement|null>(null);
  const [restoreLocked,setRestoreLocked]=useState(false),[officeSuspended,setOfficeSuspended]=useState(false),[restoreTarget,setRestoreTarget]=useState<RestoreOperation|null>(null),[officeEpoch,setOfficeEpoch]=useState(0);
  const restoreGate=useRef<RestoreEditorGate|null>(null);
  if(!restoreGate.current)restoreGate.current=new RestoreEditorGate({dirty:hasUnsavedChanges,release:requestNavigation,suspend:()=>{setRestoreTarget(null);setRestoreLocked(true);setOfficeSuspended(true);},unlock:()=>{setRestoreLocked(false);setOfficeSuspended(false);setOfficeEpoch(n=>n+1);},refresh:operation=>{setRestoreLocked(true);setOfficeSuspended(true);setRestoreTarget(operation);setAttempt(n=>n+1);}});
  const restoreActions=useRef({editorDirty:hasUnsavedChanges,releaseEditor:(action:()=>Promise<void>)=>restoreGate.current!.release(action),settled:(value:{state:'saved'|'discarded'|'not_started';operation:RestoreOperation|null})=>restoreGate.current!.settled(value)}).current;
  useEffect(()=>{if(!restoreTarget?.receipt||!view||view.document.revision<restoreTarget.receipt.revision)return;setRestoreLocked(false);setOfficeSuspended(false);setOfficeEpoch(n=>n+1);setRestoreTarget(null);},[view,restoreTarget]);
  useEffect(()=>{const tracker=new DocumentVisit({documentId:id,csrf,recorded:publishRecentActivity,changed:state=>{setVisitFailed(state.phase==='error');if(state.error instanceof ApiError&&state.error.code==='SESSION_REQUIRED'&&!sessionSnapshot().blocked)onSessionLost();}});visit.current=tracker;return()=>{tracker.dispose();visit.current=null;};},[id,csrf]);
  useEffect(()=>{if(view)void visit.current?.opened();},[view,csrf]);
  useEffect(()=>{
    let request:AbortController|undefined,closed=false;setView(null);currentView.current=null;setError(null);
    function load(){
      if(closed||sessionSnapshot().blocked)return;request?.abort();const controller=new AbortController();request=controller;
      void api<DocumentView>(`/api/documents/${encodeURIComponent(id)}/view`,{signal:controller.signal}).then(value=>{
        if(closed||controller.signal.aborted||request!==controller)return;
        setError(null);if(JSON.stringify(value)!==JSON.stringify(currentView.current)){currentView.current=value;setView(value);}document.title=value.document.title+' · Yourwiki';
      }).catch(error=>{if(closed||controller.signal.aborted||isAborted(error))return;if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){if(!sessionSnapshot().blocked)onSessionLost();}else setError(error);});
    }
    load();const remove=subscribeChanges(event=>{if(currentView.current?.manifest.kind==='pdf')return;if(event.type==='all'||event.documentIds.includes(id))load();});
    return()=>{closed=true;request?.abort();remove();};
  },[id,attempt]);
  const preview=view?<PreviewBoundary key={['canvas','drawio'].includes(view.manifest.kind)?id:id+view.document.manifestDigest}><Suspense fallback={<p className="loading" role="status">{t.loading}</p>}>
      {['canvas','drawio'].includes(view.manifest.kind)?<GraphWorkspace documentId={id} csrf={csrf} canExport={view.document.capabilities.export} write={view.document.capabilities.write} format={view.document.format} onSessionLost={onSessionLost}/>:view.manifest.kind==='pdf'?<PdfWorkspace view={view} csrf={csrf} onRefresh={()=>setAttempt(x=>x+1)}/>:view.manifest.kind==='presentation'?<Presentation view={view} t={t}/>:['document','table'].includes(view.manifest.kind)?<iframe key={view.document.manifestDigest} className="document-frame" title={view.document.title} src={assetUrl(view,view.manifest.primary)} sandbox="allow-same-origin"/>:<p className="empty">{t.unsupported}</p>}
    </Suspense></PreviewBoundary>:null;
  if(view?.document.capabilities.office===true&&view.document.capabilities.write&&['document','table','presentation'].includes(view.manifest.kind))officeMounted.current=true;
  const office=officeMounted.current;
  return <main id="content" className="document-page"><div className="document-toolbar"><Link href="/" className="back">← {t.back}</Link><div className="document-name"><h1>{view?.document.title??t.preview}</h1>{view&&<span className="muted">{view.document.format.toUpperCase()} · {t.read}</span>}</div>{view&&<button type="button" aria-expanded={detailsOpen} onClick={()=>{setDetailsVisited(true);setDetailsOpen(x=>!x);}}>{preferredLanguage()==='ru'?'Отзывы, вложения и AI':'Reviews, attachments and AI'}</button>}{view&&<button ref={historyButton} type="button" aria-expanded={historyOpen} onClick={()=>setHistoryOpen(value=>!value)}>{t.history}</button>}{view?.googleOriginal&&<Suspense fallback={null}><GoogleOriginalControl key={JSON.stringify(view.googleOriginal)} initial={view.googleOriginal} documentId={id} csrf={csrf} onSessionLost={onSessionLost}/></Suspense>}{view?.document.capabilities.googleTrash&&<Suspense fallback={null}><GoogleTrashControl documentId={id} title={view.document.title} csrf={csrf} onSessionLost={onSessionLost} onRemoved={()=>{publishChanges({type:'all'});navigate('/settings');}}/></Suspense>}{view?.document.capabilities.export&&view.manifest.kind!=='pdf'&&<a className="button" href={`/api/documents/${encodeURIComponent(id)}/content`} download>{t.download}</a>}</div>
    {view&&<ProviderDeliveryPanel initial={view.sourceDelivery} documentId={id} accountId={accountId} csrf={csrf} write={view.document.capabilities.write} onSessionLost={onSessionLost}/>}
    {view&&<ProviderSyncPanel initial={view.sourceSync} initialAction={view.sourceSyncAction} csrf={csrf} write={view.document.capabilities.write} documentId={id} accountId={accountId} onSessionLost={onSessionLost}/>}
    {detailsVisited&&view&&<div hidden={!detailsOpen}><Suspense fallback={<p role="status">{t.loading}</p>}><ContentParityPanel documentId={id} csrf={csrf} canExport={view.document.capabilities.export} onDocumentChanged={()=>setAttempt(x=>x+1)} write={view.document.capabilities.write} onSessionLost={onSessionLost}/></Suspense></div>}
    {historyOpen&&<HistoryBoundary onClose={()=>{setHistoryOpen(false);requestAnimationFrame(()=>historyButton.current?.focus());}}><Suspense fallback={<p role="status">{t.loading}</p>}><HistoryPanel accountId={accountId} restoreActions={restoreActions} documentId={id} csrf={csrf} admin={admin} onSessionLost={onSessionLost} onClose={()=>{setHistoryOpen(false);requestAnimationFrame(()=>historyButton.current?.focus());}}/></Suspense></HistoryBoundary>}
    {visitFailed&&<p className="visit-notice" role="status">{t.visitFailed} <button type="button" onClick={()=>void visit.current?.retry()}>{t.retry}</button></p>}
    {error?<ErrorBox error={error} retry={!view?()=>setAttempt(x=>x+1):undefined}/>:null}
    {!office&&view?.document.capabilities.office===true&&<Suspense fallback={null}><OfficeRecoveryPanel documentId={id} csrf={csrf} onSessionLost={onSessionLost}/></Suspense>}
    {restoreLocked&&<p className="notice" role="status">{restoreTarget?restoreLabels[languageFor(navigator.language)].preparing:restoreLabels[languageFor(navigator.language)].locked} <button type="button" onClick={()=>setHistoryOpen(true)}>{restoreLabels[languageFor(navigator.language)].reopen}</button></p>}
    <div className="document-editor" inert={restoreLocked} aria-busy={restoreLocked}>{!view?!error&&<p className="loading" role="status">{t.loading}</p>:office&&!officeSuspended?<Suspense fallback={preview}><OfficeWorkspace key={officeEpoch} view={view} csrf={csrf} onSessionLost={onSessionLost}>{preview}</OfficeWorkspace></Suspense>:preview}</div>
  </main>;
}
function AccountPage({account,onSessionLost}:{account:Account;onSessionLost:()=>void}) {return <main id="content" className="account-page"><p className="eyebrow">Yourwiki</p><h1>{t.account}</h1><div className="profile-card"><span className="avatar" aria-hidden="true">{account.user.displayName.slice(0,1).toUpperCase()}</span><div><h2>{account.user.displayName}</h2><p className="muted">@{account.user.username}</p></div></div><dl><dt>{t.groups}</dt><dd>{account.user.groups.map(group=>group.name).join(', ')||'—'}</dd><dt>{t.role}</dt><dd>{account.user.adminRole==='giga'?t.giga:account.user.adminRole==='simple'?t.simple:t.member}</dd></dl><Suspense fallback={<p role="status">{t.loading}</p>}><AccountPreferences csrf={account.csrf} onSessionLost={onSessionLost}/></Suspense>{account.features?.googleIdentity&&<Suspense fallback={<p role="status">{t.loading}</p>}><GoogleIdentityPanel csrf={account.csrf} onSessionLost={onSessionLost}/></Suspense>}</main>;}
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
  if(path==='/invite')return <Suspense fallback={<p role="status">{t.loading}</p>}><Invitation/></Suspense>;
  if(account===undefined)return <main id="content" className="loading" role="status">{t.loading}</main>;
  if(!account)return <Login onLogin={value=>{resumeSession();setAuthPaused(false);setError(null);setAccount(value);authChannel?.postMessage('changed');}} notice={error}/>;
  let id='';try{if(path.startsWith('/documents/'))id=decodeURIComponent(path.slice('/documents/'.length));}catch{/* invalid URL handled below */}
  return <><a className="skip" href="#content">{t.skip}</a><header className="site-header"><Link href="/" className="brand">Yourwiki<span>·</span></Link><nav aria-label="Yourwiki"><Link href="/dashboard" aria-current={path==='/dashboard'?'page':undefined}>Dashboard</Link><Link href="/" aria-current={path==='/'?'page':undefined}>{t.files}</Link><Link href="/recent" aria-current={path==='/recent'?'page':undefined}>{t.recent}</Link><Link href="/account" aria-current={path==='/account'?'page':undefined}>{t.account}</Link>{['giga','simple'].includes(account.user.adminRole)&&<Link href="/settings" aria-current={path==='/settings'?'page':undefined}>{t.settings}</Link>}</nav><button type="button" className="sign-out" onClick={()=>authPaused?recoverSession():void signOut()}>{authPaused?t.signIn:t.signOut}</button></header>{error?<ErrorBox error={error}/>:null}{libraryVisited&&<div className="library-route" hidden={path!=='/'}><Library key={account.user.id+account.csrf} onSessionLost={sessionLost} account={account} active={path==='/'}/></div>}{recentVisited&&<div className="library-route" hidden={path!=='/recent'}><Library key={account.user.id+account.csrf} recent onSessionLost={sessionLost} account={account} active={path==='/recent'}/></div>}{path==='/dashboard'?<Suspense fallback={<p role="status">{t.loading}</p>}><Dashboard csrf={account.csrf} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={sessionLost}/></Suspense>:path.startsWith('/folders/')?<Suspense fallback={<p role="status">{t.loading}</p>}><Files key={path} parentId={decodeURIComponent(path.slice('/folders/'.length))} csrf={account.csrf} groups={account.user.groups} admin={['giga','simple'].includes(account.user.adminRole)} onSessionLost={sessionLost}/></Suspense>:id?<DocumentPage key={id} id={id} accountId={account.user.id} onSessionLost={sessionLost} csrf={account.csrf} admin={['giga','simple'].includes(account.user.adminRole)}/>:path==='/account'?<AccountPage account={account} onSessionLost={sessionLost}/>:path==='/settings'?['giga','simple'].includes(account.user.adminRole)?<Suspense fallback={<main id="content" className="loading" role="status">{t.loading}</main>}><div className="settings-container"><AdminPage csrf={account.csrf} onSessionLost={sessionLost}/>{account.user.adminRole==='giga'&&<AISettings csrf={account.csrf} onSessionLost={sessionLost}/>}<HistorySettingsPage sharingEnabled={account.features?.googleIdentity===true&&account.user.adminRole==='giga'} lifecycleEnabled={account.features?.googleLifecycle===true} trashEnabled={account.features?.googleTrash===true} canRestoreGoogle={account.user.adminRole==='giga'} importEnabled={account.features?.googleImport===true} discoveryEnabled={account.features?.googleDiscovery===true} googleEnabled={account.features?.googleConnect===true} key={account.user.id+account.csrf} csrf={account.csrf} onSessionLost={sessionLost}/></div></Suspense>:<main id="content" className="account-page"><h1>{t.settings}</h1><p role="alert">{t.settingsDenied}</p></main>:null}</>;
}
