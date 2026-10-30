import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { api, ApiError, assetUrl } from './api.ts';
import type { DocumentView } from './api.ts';
import { registerNavigationGuard } from './navigation-guard.ts';
import { serializePdf } from './pdf-serialization.ts';
import { PdfPan } from './pdf-pan.ts';
import { pdfLabels } from './pdf-i18n.ts';
import { languageFor } from './i18n.ts';
import { PdfSaveState } from './pdf-save-state.ts';
declare const __PDF_ASSET_BASE__: string;
declare const __PDF_STYLESHEET__: string;
let styles:Promise<void>|undefined;
function loadStyles(){
  return styles??=new Promise<void>((resolve,reject)=>{
    const link=document.createElement('link');link.rel='stylesheet';link.href=__PDF_STYLESHEET__;
    link.onload=()=>resolve();link.onerror=()=>{link.remove();styles=undefined;reject(new Error('PDF_STYLE_FAILED'));};document.head.append(link);
  });
}
(globalThis as typeof globalThis & {pdfjsLib: typeof pdfjs}).pdfjsLib = pdfjs;
pdfjs.GlobalWorkerOptions.workerSrc = __PDF_ASSET_BASE__ + 'pdf.worker.mjs';
type PdfState = { baseRevision: number; layerRevision: number; state: 'saved'|'conflict'; layer: {baseRevision:number}|null };
type Actions = { changed:()=>void; pointerChanged:(target:Element)=>void; save:()=>Promise<void>; download:()=>Promise<void>; tool:(mode:number)=>void; pan:(active:boolean)=>void; zoomStep:(delta:number)=>void; page:(delta:number)=>void; zoom:(scale:string)=>void; jump:(page:number)=>void; undo:()=>void; redo:()=>void; parameter:(type:number,value:number|string)=>void };
const t=pdfLabels[languageFor(navigator.language)];
const empty:Actions = {changed:()=>{},pointerChanged:()=>{},save:async()=>{},download:async()=>{},tool:()=>{},pan:()=>{},zoomStep:()=>{},page:()=>{},zoom:()=>{},jump:()=>{},undo:()=>{},redo:()=>{},parameter:()=>{}};
export default function PdfWorkspace({view,csrf,onRefresh}:{view:DocumentView;csrf:string;onRefresh:()=>void}) {
  const container=useRef<HTMLDivElement>(null),actions=useRef<Actions>(empty);
  const panController=useRef(new PdfPan());
  const [panning,setPanning]=useState(false),[toolMode,setToolMode]=useState<number>(pdfjs.AnnotationEditorType.NONE),[zoomValue,setZoomValue]=useState('page-width');
  const [canWrite,setCanWrite]=useState(view.document.capabilities.write),[canExport,setCanExport]=useState(view.document.capabilities.export),[savedLayer,setSavedLayer]=useState(0);
  const [recoveryId,setRecoveryId]=useState<string|null>(null);
  const [status,setStatus]=useState(t.loading),[error,setError]=useState(''),[dirty,setDirty]=useState(false),[paused,setPaused]=useState(false),[ready,setReady]=useState(false),[page,setPage]=useState(1),[pages,setPages]=useState(0);
  const [staleRevision,setStaleRevision]=useState(0);
  const [stale,setStale]=useState(false),[replace,setReplace]=useState(false);
  useEffect(()=>{
    const abort=new AbortController(),base=`/api/documents/${encodeURIComponent(view.document.id)}/pdf`;
    let pdf:PDFDocumentProxy|undefined,viewer:PDFViewer|undefined,task:ReturnType<typeof pdfjs.getDocument>|undefined,saveState:PdfSaveState|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined,observer:ResizeObserver|undefined;
    let activeMode:number=pdfjs.AnnotationEditorType.NONE,selectedScale='page-width';
    let manager:{commitOrRemove:()=>void;endCurrentEditing:()=>void;undo:()=>void;redo:()=>void}|undefined,editable=view.document.capabilities.write,exportable=view.document.capabilities.export,checking=false;
    panController.current.reset();setPanning(false);setToolMode(pdfjs.AnnotationEditorType.NONE);setZoomValue('page-width');if(container.current)container.current.inert=false;setCanWrite(view.document.capabilities.write);setCanExport(view.document.capabilities.export);setSavedLayer(0);setReady(false);setRecoveryId(null);setPaused(false);setError('');setDirty(false);setStale(false);setStatus(t.loading);
    const report=(message:string)=>{if(!abort.signal.aborted)setError(message);};
    const changed=()=>{if(!editable||!saveState||abort.signal.aborted)return;saveState.changed();setDirty(true);setStatus(t.dirty);clearTimeout(timer);if(!saveState.paused)timer=setTimeout(()=>void save(),1500);};
    async function save(){
      if(!pdf||!saveState||!editable||abort.signal.aborted)return;
      (document.activeElement as HTMLElement|null)?.blur();manager?.endCurrentEditing();
      const snapshot=saveState.begin();if(!snapshot)return;
      clearTimeout(timer);setStatus(t.saving);
      try{
        const bytes=await serializePdf(pdf,changed);abort.signal.throwIfAborted();
        const receipt=await api<{baseRevision:number;layerRevision:number}>(`${base}/layer?baseRevision=${snapshot.baseRevision}&layerRevision=${snapshot.layerRevision}&replaceStaleLayer=${replace}`,{method:'PUT',signal:abort.signal,headers:{'content-type':'application/octet-stream','x-csrf-token':csrf},body:new Blob([new Uint8Array(bytes)],{type:'application/octet-stream'})});
        saveState.complete(snapshot,receipt);setSavedLayer(receipt.layerRevision);setDirty(saveState.dirty);setStatus(saveState.dirty?t.dirty:t.saved);setError('');
        if(saveState.dirty)timer=setTimeout(()=>void save(),1500);
      }catch(error){
        if(abort.signal.aborted)return;saveState.fail();setPaused(true);setDirty(true);if(error instanceof ApiError)setRecoveryId(error.operationId);
        report(error instanceof ApiError&&error.code==='CONFLICT'?t.conflict:t.uncertain);
      }
    }
    async function download(){
      if(!pdf||!exportable)return;
      try{
        const current=await api<DocumentView>(`/api/documents/${encodeURIComponent(view.document.id)}/view`,{signal:abort.signal});
        if(!current.document.capabilities.export)throw new Error('EXPORT_DENIED');
        (document.activeElement as HTMLElement|null)?.blur();manager?.endCurrentEditing();
        const bytes=view.document.capabilities.write?await pdf.saveDocument():await pdf.getData();abort.signal.throwIfAborted();
        const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=/\.pdf$/i.test(view.document.title)?view.document.title:view.document.title+'.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      }catch{report(t.downloadError);}
    }
    const leave=(event:BeforeUnloadEvent)=>{if(saveState?.dirty||saveState?.saving){event.preventDefault();event.returnValue='';}};
    const removeGuard=registerNavigationGuard(()=>!(saveState?.dirty||saveState?.saving)||window.confirm(t.leave));
    window.addEventListener('beforeunload',leave);
    function lockEditing(){
      manager?.endCurrentEditing();
      clearTimeout(timer);
      if(viewer&&activeMode!==pdfjs.AnnotationEditorType.DISABLE){try{viewer.annotationEditorMode={mode:pdfjs.AnnotationEditorType.NONE};}catch{/* Read-only PDF has no editor manager. */}}
      container.current?.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>('input,textarea,select,button').forEach(node=>{node.disabled=true;});
      container.current?.querySelectorAll<HTMLElement>('.annotationEditorLayer').forEach(node=>{node.inert=true;});
    }
    async function heartbeat(){
      if(abort.signal.aborted||document.hidden||checking||!saveState||saveState.saving)return;
      checking=true;
      try{
        const [remote,metadata]=await Promise.all([api<PdfState>(base,{signal:abort.signal}),api<DocumentView>(`/api/documents/${encodeURIComponent(view.document.id)}/view`,{signal:abort.signal})]);
        const wasEditable=editable;
        if(wasEditable&&!metadata.document.capabilities.write)manager?.endCurrentEditing();
        editable=metadata.document.capabilities.write;exportable=metadata.document.capabilities.export;
        setCanWrite(editable);setCanExport(exportable);
        if(!editable&&view.document.capabilities.write){saveState.paused=true;setPaused(true);lockEditing();report(t.writeRevoked);}
        if(metadata.document.manifestDigest!==view.document.manifestDigest&&!saveState.dirty){onRefresh();return;}
        const result=saveState.remote(remote.baseRevision,remote.layerRevision);
        if(result==='reload'){onRefresh();return;}
        if(result!=='unchanged'){clearTimeout(timer);setPaused(true);report(result==='conflict'?t.remoteConflict:t.remoteClean);}
      }catch(error){if(abort.signal.aborted)return;if(error instanceof ApiError&&['NOT_FOUND','ACCESS_DENIED','SESSION_REQUIRED'].includes(error.code)){editable=false;exportable=false;setCanWrite(false);setCanExport(false);if(container.current)container.current.inert=true;saveState.paused=true;clearTimeout(timer);setPaused(true);report(t.accessLost);}}
      finally{checking=false;}
    }
    const visible=()=>{if(!document.hidden)void heartbeat();};document.addEventListener('visibilitychange',visible);
    void (async()=>{
      try{
        await loadStyles();abort.signal.throwIfAborted();
        const initial=await api<PdfState>(base,{signal:abort.signal});abort.signal.throwIfAborted();
        // Keep the prepared old preview available while a newer original is processing.
        const pendingPreview=initial.baseRevision!==view.document.revision;
        if(pendingPreview)editable=false;
        saveState=new PdfSaveState(initial.baseRevision,initial.layerRevision);saveState.paused=pendingPreview||(initial.state==='conflict'&&!replace);setPaused(saveState.paused);setStale(!pendingPreview&&initial.state==='conflict');setStaleRevision(initial.layerRevision);setSavedLayer(initial.layerRevision);
        const {PDFViewer,EventBus,PDFLinkService}=await import('pdfjs-dist/web/pdf_viewer.mjs');abort.signal.throwIfAborted();
        const bus=new EventBus(),linkService=new PDFLinkService({eventBus:bus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
        viewer=new PDFViewer({container:container.current!,eventBus:bus,linkService,annotationEditorMode:editable&&!saveState.paused?pdfjs.AnnotationEditorType.NONE:pdfjs.AnnotationEditorType.DISABLE,annotationMode:editable&&!saveState.paused?pdfjs.AnnotationMode.ENABLE_FORMS:pdfjs.AnnotationMode.ENABLE,imageResourcesPath:__PDF_ASSET_BASE__+'images/',enablePermissions:true,maxCanvasPixels:8*1024*1024});
        linkService.setViewer(viewer);
        bus.on('annotationeditoruimanager',(event:{uiManager:typeof manager})=>{manager=event.uiManager;});
        bus.on('annotationlayerrendered',()=>{if(!editable)lockEditing();});
        bus.on('annotationeditormodechanged',(event:{mode:number})=>{activeMode=event.mode;if(!abort.signal.aborted)setToolMode(event.mode);});
        bus.on('pagechanging',(event:{pageNumber:number})=>{if(!abort.signal.aborted)setPage(event.pageNumber);});
        bus.on('pagesinit',()=>{if(viewer&&!abort.signal.aborted)viewer.currentScaleValue='page-width';});
        const url=initial.layer&&initial.layer.baseRevision===view.document.revision?`${base}/layers/${initial.layerRevision}`:assetUrl(view,view.manifest.primary);
        task=pdfjs.getDocument({url,cMapUrl:__PDF_ASSET_BASE__+'cmaps/',cMapPacked:true,standardFontDataUrl:__PDF_ASSET_BASE__+'standard_fonts/',wasmUrl:__PDF_ASSET_BASE__+'wasm/',enableXfa:false});
        const loaded=await task.promise;pdf=loaded;if(abort.signal.aborted){await task.destroy();return;}
        (loaded.annotationStorage as unknown as {onSetModified:()=>void}).onSetModified=changed;viewer.setDocument(loaded);linkService.setDocument(loaded);setPages(loaded.numPages);setReady(true);setStatus(pendingPreview?t.pending:t.ready);
        observer=new ResizeObserver(()=>{if(viewer?.pdfDocument&&['page-width','page-fit'].includes(selectedScale))viewer.currentScaleValue=selectedScale;});observer.observe(container.current!);
        actions.current={changed,pointerChanged:target=>{if(activeMode!==pdfjs.AnnotationEditorType.NONE||target.closest('.editToolbar'))changed();},save,download,tool:mode=>{try{if(viewer&&editable&&!saveState?.paused){setPanning(false);panController.current.reset();viewer.annotationEditorMode={mode};activeMode=mode;setToolMode(mode);}}catch{report(t.toolError);}},pan:active=>{manager?.endCurrentEditing();if(active&&viewer&&editable)viewer.annotationEditorMode={mode:pdfjs.AnnotationEditorType.NONE};setPanning(active);panController.current.reset();},zoomStep:delta=>{if(viewer){const scale=Math.max(.25,Math.min(5,Math.round((viewer.currentScale+delta)*100)/100));selectedScale=String(scale);viewer.currentScaleValue=selectedScale;setZoomValue(selectedScale);}},page:delta=>{if(viewer)viewer.currentPageNumber=Math.max(1,Math.min(pdf!.numPages,viewer.currentPageNumber+delta));},zoom:scale=>{if(viewer){selectedScale=scale;viewer.currentScaleValue=scale;setZoomValue(scale);}},jump:page=>{if(viewer&&Number.isInteger(page))viewer.currentPageNumber=Math.max(1,Math.min(pdf!.numPages,page));},undo:()=>{if(editable){manager?.undo();changed();}},redo:()=>{if(editable){manager?.redo();changed();}},parameter:(type,value)=>{if(editable)bus.dispatch('switchannotationeditorparams',{source:viewer,type,value});}};
        poll=setInterval(()=>void heartbeat(),15000);
      }catch(error){if(!abort.signal.aborted)report(t.openError);}
    })();
    return()=>{abort.abort();clearTimeout(timer);clearInterval(poll);observer?.disconnect();window.removeEventListener('beforeunload',leave);removeGuard();document.removeEventListener('visibilitychange',visible);actions.current=empty;viewer?.setDocument(null as unknown as PDFDocumentProxy);void task?.destroy().catch(()=>{});};
  },[view,csrf,replace]);
  function reload(){if(dirty&&!window.confirm(t.discard))return;onRefresh();}
  return <section className="pdf-workspace" aria-label="PDF"><div className="pdf-toolbar">
    <button type="button" disabled={!ready||page===1} onClick={()=>actions.current.page(-1)} aria-label={t.previous}>←</button><label>{t.page} <input className="pdf-page-number" aria-label={t.pageLabel} type="number" min="1" max={pages} value={page} onChange={e=>actions.current.jump(Number(e.target.value))}/> / {pages||'…'}</label><button type="button" disabled={!ready||page===pages} onClick={()=>actions.current.page(1)} aria-label={t.next}>→</button>
    <button type="button" disabled={!ready} aria-label={t.zoomOut} onClick={()=>actions.current.zoomStep(-.25)}>−</button><label>{t.zoom} <select aria-label={t.zoom} value={zoomValue} disabled={!ready} onChange={e=>actions.current.zoom(e.target.value)}><option value="page-width">{t.pageWidth}</option><option value="page-fit">{t.pageFit}</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option>{!['page-width','page-fit','0.5','0.75','1','1.25','1.5','2','3','4'].includes(zoomValue)&&<option value={zoomValue}>{Math.round(Number(zoomValue)*100)}%</option>}</select></label><button type="button" disabled={!ready} aria-label={t.zoomIn} onClick={()=>actions.current.zoomStep(.25)}>+</button><button type="button" disabled={!ready} aria-pressed={panning} onClick={()=>actions.current.pan(!panning)}>{t.pan}</button>
    {view.document.capabilities.write&&<fieldset className="pdf-edit-controls" disabled={!ready||!canWrite}><legend className="sr-only">{t.editControls}</legend><label>{t.tool} <select disabled={!ready||paused} aria-label={t.tool} value={toolMode} onChange={e=>actions.current.tool(Number(e.target.value))}><option value={pdfjs.AnnotationEditorType.NONE}>{t.select}</option><option value={pdfjs.AnnotationEditorType.FREETEXT}>{t.text}</option><option value={pdfjs.AnnotationEditorType.HIGHLIGHT}>{t.highlight}</option><option value={pdfjs.AnnotationEditorType.INK}>{t.ink}</option></select></label><details><summary>{t.parameters}</summary><div className="pdf-parameters"><button type="button" onClick={()=>actions.current.undo()}>{t.undo}</button><button type="button" onClick={()=>actions.current.redo()}>{t.redo}</button><label>{t.textSize} <input type="number" min="5" max="100" defaultValue="10" onChange={e=>{const value=Number(e.target.value);if(value>=5&&value<=100)actions.current.parameter(pdfjs.AnnotationEditorParamsType.FREETEXT_SIZE,value);}}/></label><label>{t.thickness} <input type="number" min="1" max="20" defaultValue="1" onChange={e=>{const value=Number(e.target.value);if(value>=1&&value<=20)actions.current.parameter(pdfjs.AnnotationEditorParamsType.INK_THICKNESS,value);}}/></label><label>{t.color} <input type="color" defaultValue="#000000" onChange={e=>{for(const type of [pdfjs.AnnotationEditorParamsType.FREETEXT_COLOR,pdfjs.AnnotationEditorParamsType.INK_COLOR,pdfjs.AnnotationEditorParamsType.HIGHLIGHT_COLOR])actions.current.parameter(type,e.target.value);}}/></label></div></details><button type="button" disabled={!ready||paused} onClick={()=>void actions.current.save()}>{t.save}</button></fieldset>}
    {canExport&&<button type="button" disabled={!ready} onClick={()=>void actions.current.download()}>{t.download}</button>}<span className="pdf-downloads">{canExport&&<><a className="button" href={`/api/documents/${encodeURIComponent(view.document.id)}/content`} download>{t.original}</a><a className="button" href={savedLayer?`/api/documents/${encodeURIComponent(view.document.id)}/pdf/layers/${savedLayer}`:`/api/documents/${encodeURIComponent(view.document.id)}/content`} download>{t.savedDownload}</a></>}</span><button type="button" onClick={reload}>{t.reload}</button><span role="status">{status}</span>
  </div>{error&&<div className="notice error" role="alert"><p>{error}</p>{recoveryId&&canExport&&<a href={`/api/documents/${encodeURIComponent(view.document.id)}/pdf/recovery/${encodeURIComponent(recoveryId)}`} download>{t.recovery}</a>}</div>}{stale&&!replace&&<div className="notice" role="alert"><p>{t.stale}</p>{canExport&&<a href={`/api/documents/${encodeURIComponent(view.document.id)}/pdf/layers/${staleRevision}`} download>{t.earlierLayer}</a>}{canWrite&&<button type="button" onClick={()=>{if(window.confirm(t.replaceConfirm))setReplace(true);}}>{t.newLayer}</button>}</div>}
    <div className="pdf-stage"><div className={"pdf-container"+(panning?" pdf-pan":"")} ref={container} tabIndex={0} role="region" aria-label={t.pageLabel} onPointerDownCapture={e=>{if(!panning)return;const node=e.currentTarget,rect=node.getBoundingClientRect();if(panController.current.begin({id:e.pointerId,x:e.clientX,y:e.clientY,button:e.button,type:e.pointerType},{left:rect.left,top:rect.top,width:node.clientWidth,height:node.clientHeight,scrollLeft:node.scrollLeft,scrollTop:node.scrollTop})){node.setPointerCapture(e.pointerId);e.preventDefault();e.stopPropagation();}}} onPointerMove={e=>{const scroll=panController.current.move({id:e.pointerId,x:e.clientX,y:e.clientY});if(scroll){e.currentTarget.scrollLeft=scroll.left;e.currentTarget.scrollTop=scroll.top;e.preventDefault();}}} onPointerCancel={e=>panController.current.end(e.pointerId)} onLostPointerCapture={e=>panController.current.end(e.pointerId)} onInput={()=>actions.current.changed()} onPointerUpCapture={e=>{if(panController.current.end(e.pointerId)){if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);return;}actions.current.pointerChanged(e.target as Element);}} onKeyUp={e=>{if(((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase()))||['Delete','Backspace'].includes(e.key))actions.current.changed();}}><div className="pdfViewer"/></div></div>
  </section>;
}
