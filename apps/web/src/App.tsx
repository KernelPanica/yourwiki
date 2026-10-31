import { Component,lazy,Suspense,useEffect,useRef,useState } from 'react';
import type { ErrorInfo,FormEvent,ReactNode } from 'react';
import { api,ApiError,assetUrl,isAborted } from './api.ts';
import type { Account,DocumentInfo,DocumentView } from './api.ts';
import { blockSession,resumeSession,sessionSnapshot } from './session-fence.ts';
import {startChangeFeed,publishChanges,subscribeChanges} from './live-updates.ts';
import { requestNavigation,hasUnsavedChanges } from './navigation-guard.ts';
import { labels,languageFor } from './i18n.ts';
import type { Labels } from './i18n.ts';
const OfficeRecoveryPanel=lazy(()=>import('./OfficeRecoveryPanel.tsx'));
const OfficeWorkspace=lazy(()=>import('./OfficeWorkspace.tsx'));
const PdfWorkspace=lazy(()=>import('./PdfWorkspace.tsx'));
const Presentation=lazy(()=>import('./Presentation.tsx'));
const authChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('yourwiki-auth'):null;
const t=labels[languageFor(navigator.language)];
document.documentElement.lang=languageFor(navigator.language);
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
function Library({onSessionLost,active}:{onSessionLost:()=>void;active:boolean}) {
  const [items,setItems]=useState<DocumentInfo[]>([]),[cursor,setCursor]=useState<string|null>(null),[pending,setPending]=useState(true),[error,setError]=useState<unknown>(null),[filter,setFilter]=useState('');
  const lifetime=useRef<AbortController|null>(null),request=useRef<AbortController|null>(null);
  useEffect(()=>{const controller=new AbortController();lifetime.current=controller;void load();const remove=subscribeChanges(()=>void load());return()=>{controller.abort();request.current?.abort();remove();};},[]);
  async function load(after?:string){
    if(lifetime.current?.signal.aborted||sessionSnapshot().blocked)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;const signal=controller.signal;
    setPending(true);setError(null);
    try{const page=await api<{items:DocumentInfo[];nextCursor:string|null}>('/api/documents'+(after?'?after='+encodeURIComponent(after):''),{signal});if(signal.aborted||request.current!==controller)return;setItems(old=>after?[...old,...page.items.filter(item=>!old.some(previous=>previous.id===item.id))]:page.items);setCursor(page.nextCursor);}
    catch(error){if(signal.aborted||isAborted(error))return;if(error instanceof ApiError&&error.code==='SESSION_REQUIRED'){if(!sessionSnapshot().blocked)onSessionLost();}else setError(error);}
    finally{if(!signal.aborted&&request.current===controller)setPending(false);}
  }
  const shown=items.filter(item=>item.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <main id={active?"content":undefined} className="library"><div className="page-heading"><div><p className="eyebrow">Yourwiki</p><h1>{t.files}</h1></div><label className="search"><span className="sr-only">{t.search}</span><input type="search" placeholder={t.search} value={filter} onChange={e=>setFilter(e.target.value)}/></label></div>
    {error?<ErrorBox error={error} retry={()=>void load()}/>:null}
    <ul className="file-list">{shown.map(item=><li key={item.id}><Link href={'/documents/'+encodeURIComponent(item.id)}><span className="file-format">{item.format.toUpperCase()}</span><span className="file-title">{item.title}</span><span className="file-open" aria-hidden="true">↗</span></Link></li>)}</ul>
    {pending?<p role="status">{t.loading}</p>:shown.length===0&&!error?<p className="empty">{t.empty}</p>:null}
    {cursor&&<button type="button" disabled={pending} onClick={()=>void load(cursor)}>{t.more}</button>}
  </main>;
}
function DocumentPage({id,onSessionLost,csrf}:{id:string;onSessionLost:()=>void;csrf:string}) {
  const [view,setView]=useState<DocumentView|null>(null),[error,setError]=useState<unknown>(null),[attempt,setAttempt]=useState(0);
  const currentView=useRef<DocumentView|null>(null),officeMounted=useRef(false);
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
  const preview=view?<PreviewBoundary key={id+view.document.manifestDigest}><Suspense fallback={<p className="loading" role="status">{t.loading}</p>}>
      {view.manifest.kind==='pdf'?<PdfWorkspace view={view} csrf={csrf} onRefresh={()=>setAttempt(x=>x+1)}/>:view.manifest.kind==='presentation'?<Presentation view={view} t={t}/>:['document','table'].includes(view.manifest.kind)?<iframe key={view.document.manifestDigest} className="document-frame" title={view.document.title} src={assetUrl(view,view.manifest.primary)} sandbox="allow-same-origin"/>:<p className="empty">{t.unsupported}</p>}
    </Suspense></PreviewBoundary>:null;
  if(view?.document.capabilities.office===true&&view.document.capabilities.write&&['document','table','presentation'].includes(view.manifest.kind))officeMounted.current=true;
  const office=officeMounted.current;
  return <main id="content" className="document-page"><div className="document-toolbar"><Link href="/" className="back">← {t.back}</Link><div className="document-name"><h1>{view?.document.title??t.preview}</h1>{view&&<span className="muted">{view.document.format.toUpperCase()} · {t.read}</span>}</div>{view?.document.capabilities.export&&view.manifest.kind!=='pdf'&&<a className="button" href={`/api/documents/${encodeURIComponent(id)}/content`} download>{t.download}</a>}</div>
    {error?<ErrorBox error={error} retry={!view?()=>setAttempt(x=>x+1):undefined}/>:null}
    {!office&&view?.document.capabilities.office===true&&<Suspense fallback={null}><OfficeRecoveryPanel documentId={id} csrf={csrf} onSessionLost={onSessionLost}/></Suspense>}
    {!view?!error&&<p className="loading" role="status">{t.loading}</p>:office?<Suspense fallback={preview}><OfficeWorkspace view={view} csrf={csrf} onSessionLost={onSessionLost}>{preview}</OfficeWorkspace></Suspense>:preview}
  </main>;
}
function AccountPage({account}:{account:Account}) {return <main id="content" className="account-page"><p className="eyebrow">Yourwiki</p><h1>{t.account}</h1><div className="profile-card"><span className="avatar" aria-hidden="true">{account.user.displayName.slice(0,1).toUpperCase()}</span><div><h2>{account.user.displayName}</h2><p className="muted">@{account.user.username}</p></div></div><dl><dt>{t.groups}</dt><dd>{account.user.groups.map(group=>group.name).join(', ')||'—'}</dd><dt>{t.role}</dt><dd>{account.user.adminRole==='giga'?t.giga:account.user.adminRole==='simple'?t.simple:t.member}</dd></dl></main>;}
export default function App() {
  const [authPaused,setAuthPaused]=useState(false);
  const [authEpoch,setAuthEpoch]=useState(0);
  useEffect(()=>{if(!authChannel)return;const changed=()=>{blockSession();setError(new ApiError('SESSION_REQUIRED'));if(hasUnsavedChanges()){setAuthPaused(true);return;}setAccount(undefined);setAuthEpoch(value=>value+1);};authChannel.addEventListener('message',changed);return()=>authChannel.removeEventListener('message',changed);},[]);
  const [libraryVisited,setLibraryVisited]=useState(location.pathname==='/');
  useEffect(()=>{const update=()=>{if(location.pathname==='/')setLibraryVisited(true);};window.addEventListener('popstate',update);return()=>window.removeEventListener('popstate',update);},[]);
  const [account,setAccount]=useState<Account|null|undefined>(undefined),[path,setPath]=useState(location.pathname),[error,setError]=useState<unknown>(null);
  useEffect(()=>{const generation=sessionSnapshot().generation,controller=new AbortController();void api<Account>('/api/account',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){resumeSession();setAuthPaused(false);setAccount(value);}}).catch(error=>{if(!controller.signal.aborted&&generation===sessionSnapshot().generation&&!isAborted(error)){if(!(error instanceof ApiError&&error.code==='SESSION_REQUIRED'))setError(error);setAccount(null);}});return()=>controller.abort();},[authEpoch]);
  useEffect(()=>{
    let previousPath=location.pathname,moving=false,live=true;let requested:string|null=null;
    const move=(next:string)=>{
      if(next===previousPath&&!moving)return;requested=next;if(moving)return;moving=true;
      void requestNavigation(()=>{if(!live||requested===null)return;if(location.pathname!==requested)history.pushState(null,'',requested);previousPath=requested;setPath(requested);if(requested==='/')setLibraryVisited(true);}).then(allowed=>{if(!allowed&&live&&location.pathname!==previousPath)history.pushState(null,'',previousPath);}).finally(()=>{moving=false;requested=null;});
    };
    const pop=()=>move(location.pathname),link=(event:Event)=>{const next=(event as CustomEvent<unknown>).detail;if(typeof next==='string'&&/^\/(?:$|account$|documents\/[^?#]+$)/.test(next))move(next);};
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
  if(account===undefined)return <main id="content" className="loading" role="status">{t.loading}</main>;
  if(!account)return <Login onLogin={value=>{resumeSession();setAuthPaused(false);setError(null);setAccount(value);authChannel?.postMessage('changed');}} notice={error}/>;
  let id='';try{if(path.startsWith('/documents/'))id=decodeURIComponent(path.slice('/documents/'.length));}catch{/* invalid URL handled below */}
  return <><a className="skip" href="#content">{t.skip}</a><header className="site-header"><Link href="/" className="brand">Yourwiki<span>·</span></Link><nav aria-label="Yourwiki"><Link href="/" aria-current={path==='/'?'page':undefined}>{t.files}</Link><Link href="/account" aria-current={path==='/account'?'page':undefined}>{t.account}</Link></nav><button type="button" className="sign-out" onClick={()=>authPaused?recoverSession():void signOut()}>{authPaused?t.signIn:t.signOut}</button></header>{error?<ErrorBox error={error}/>:null}{libraryVisited&&<div className="library-route" hidden={path!=='/'}><Library onSessionLost={sessionLost} active={path==='/'}/></div>}{id?<DocumentPage key={id} id={id} onSessionLost={sessionLost} csrf={account.csrf}/>:path==='/account'?<AccountPage account={account}/>:null}</>;
}
