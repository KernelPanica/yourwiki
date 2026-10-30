import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { api, ApiError, assetUrl } from './api.ts';
import type { DocumentView } from './api.ts';
import { registerNavigationGuard } from './navigation-guard.ts';
import { serializePdf } from './pdf-serialization.ts';
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
type Actions = { changed:()=>void; pointerChanged:(target:Element)=>void; save:()=>Promise<void>; download:()=>Promise<void>; tool:(mode:number)=>void; page:(delta:number)=>void; zoom:(scale:string)=>void; jump:(page:number)=>void; undo:()=>void; redo:()=>void; parameter:(type:number,value:number|string)=>void };
const empty:Actions = {changed:()=>{},pointerChanged:()=>{},save:async()=>{},download:async()=>{},tool:()=>{},page:()=>{},zoom:()=>{},jump:()=>{},undo:()=>{},redo:()=>{},parameter:()=>{}};
export default function PdfWorkspace({view,csrf,onRefresh}:{view:DocumentView;csrf:string;onRefresh:()=>void}) {
  const container=useRef<HTMLDivElement>(null),actions=useRef<Actions>(empty);
  const [recoveryId,setRecoveryId]=useState<string|null>(null);
  const [status,setStatus]=useState('Загрузка PDF…'),[error,setError]=useState(''),[dirty,setDirty]=useState(false),[paused,setPaused]=useState(false),[ready,setReady]=useState(false),[page,setPage]=useState(1),[pages,setPages]=useState(0),[attempt,setAttempt]=useState(0);
  const [staleRevision,setStaleRevision]=useState(0);
  const [stale,setStale]=useState(false),[replace,setReplace]=useState(false);
  useEffect(()=>{
    const abort=new AbortController(),base=`/api/documents/${encodeURIComponent(view.document.id)}/pdf`;
    let pdf:PDFDocumentProxy|undefined,viewer:PDFViewer|undefined,task:ReturnType<typeof pdfjs.getDocument>|undefined,saveState:PdfSaveState|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined,observer:ResizeObserver|undefined;
    let activeMode:number=pdfjs.AnnotationEditorType.NONE;
    let manager:{commitOrRemove:()=>void;endCurrentEditing:()=>void;undo:()=>void;redo:()=>void}|undefined,editable=view.document.capabilities.write,exportable=view.document.capabilities.export,checking=false;
    if(container.current)container.current.inert=false;setReady(false);setRecoveryId(null);setPaused(false);setError('');setDirty(false);setStale(false);setStatus('Загрузка PDF…');
    const report=(message:string)=>{if(!abort.signal.aborted)setError(message);};
    const changed=()=>{if(!editable||!saveState||abort.signal.aborted)return;saveState.changed();setDirty(true);setStatus('Есть несохранённые изменения');clearTimeout(timer);if(!saveState.paused)timer=setTimeout(()=>void save(),1500);};
    async function save(){
      if(!pdf||!saveState||!editable||abort.signal.aborted)return;
      (document.activeElement as HTMLElement|null)?.blur();manager?.endCurrentEditing();
      const snapshot=saveState.begin();if(!snapshot)return;
      clearTimeout(timer);setStatus('Сохранение PDF…');
      try{
        const bytes=await serializePdf(pdf,changed);abort.signal.throwIfAborted();
        const receipt=await api<{baseRevision:number;layerRevision:number}>(`${base}/layer?baseRevision=${snapshot.baseRevision}&layerRevision=${snapshot.layerRevision}&replaceStaleLayer=${replace}`,{method:'PUT',signal:abort.signal,headers:{'content-type':'application/octet-stream','x-csrf-token':csrf},body:new Blob([new Uint8Array(bytes)],{type:'application/octet-stream'})});
        saveState.complete(snapshot,receipt);setDirty(saveState.dirty);setStatus(saveState.dirty?'Есть несохранённые изменения':'PDF сохранён');setError('');
        if(saveState.dirty)timer=setTimeout(()=>void save(),1500);
      }catch(error){
        if(abort.signal.aborted)return;saveState.fail();setPaused(true);setDirty(true);if(error instanceof ApiError)setRecoveryId(error.operationId);
        report(error instanceof ApiError&&error.code==='CONFLICT'?'Оригинал или аннотации изменены другим редактором. Сохраните свою копию перед перезагрузкой.':'Сохранение не подтверждено. Изменения остаются в редакторе. Сохраните свою копию перед перезагрузкой.');
      }
    }
    async function download(){
      if(!pdf||!exportable)return;
      try{
        const current=await api<DocumentView>(`/api/documents/${encodeURIComponent(view.document.id)}/view`,{signal:abort.signal});
        if(!current.document.capabilities.export)throw new Error('EXPORT_DENIED');
        (document.activeElement as HTMLElement|null)?.blur();manager?.endCurrentEditing();
        const bytes=view.document.capabilities.write?await pdf.saveDocument():await pdf.getData();abort.signal.throwIfAborted();
        const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=view.document.title+'.pdf';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      }catch{report('Не удалось скачать PDF. Проверьте текущие права доступа.');}
    }
    const leave=(event:BeforeUnloadEvent)=>{if(saveState?.dirty||saveState?.saving){event.preventDefault();event.returnValue='';}};
    const removeGuard=registerNavigationGuard(()=>!(saveState?.dirty||saveState?.saving)||window.confirm('В PDF есть несохранённые изменения. Покинуть страницу без сохранения?'));
    window.addEventListener('beforeunload',leave);
    async function heartbeat(){
      if(abort.signal.aborted||document.hidden||checking||!saveState||saveState.saving)return;
      checking=true;
      try{
        const [remote,metadata]=await Promise.all([api<PdfState>(base,{signal:abort.signal}),api<DocumentView>(`/api/documents/${encodeURIComponent(view.document.id)}/view`,{signal:abort.signal})]);
        editable=metadata.document.capabilities.write;exportable=metadata.document.capabilities.export;
        if(!editable){if(container.current)container.current.inert=true;saveState.paused=true;setPaused(true);if(viewer)viewer.annotationEditorMode={mode:pdfjs.AnnotationEditorType.NONE};report('Право редактирования отозвано. Сохраните разрешённую копию изменений перед выходом.');}
        if(metadata.document.manifestDigest!==view.document.manifestDigest&&!saveState.dirty){onRefresh();return;}
        const result=saveState.remote(remote.baseRevision,remote.layerRevision);
        if(result==='reload'){onRefresh();return;}
        if(result!=='unchanged'){clearTimeout(timer);setPaused(true);report(result==='conflict'?'Оригинал или аннотации изменены. Автосохранение остановлено; сохраните свою копию.':'Документ обновлён. Перезагрузите просмотр, чтобы получить изменения.');}
      }catch(error){if(abort.signal.aborted)return;if(error instanceof ApiError&&['NOT_FOUND','ACCESS_DENIED','SESSION_REQUIRED'].includes(error.code)){editable=false;if(container.current)container.current.inert=true;saveState.paused=true;clearTimeout(timer);setPaused(true);report('Сессия завершена или доступ отозван. Автосохранение остановлено.');}}
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
        saveState=new PdfSaveState(initial.baseRevision,initial.layerRevision);saveState.paused=pendingPreview||(initial.state==='conflict'&&!replace);setPaused(saveState.paused);setStale(!pendingPreview&&initial.state==='conflict');setStaleRevision(initial.layerRevision);
        const {PDFViewer,EventBus,PDFLinkService}=await import('pdfjs-dist/web/pdf_viewer.mjs');abort.signal.throwIfAborted();
        const bus=new EventBus(),linkService=new PDFLinkService({eventBus:bus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
        viewer=new PDFViewer({container:container.current!,eventBus:bus,linkService,annotationEditorMode:editable&&!saveState.paused?pdfjs.AnnotationEditorType.NONE:pdfjs.AnnotationEditorType.DISABLE,annotationMode:editable&&!saveState.paused?pdfjs.AnnotationMode.ENABLE_FORMS:pdfjs.AnnotationMode.ENABLE,imageResourcesPath:__PDF_ASSET_BASE__+'images/',enablePermissions:true,maxCanvasPixels:8*1024*1024});
        linkService.setViewer(viewer);
        bus.on('annotationeditoruimanager',(event:{uiManager:typeof manager})=>{manager=event.uiManager;});
        bus.on('annotationeditormodechanged',(event:{mode:number})=>{activeMode=event.mode;});
        bus.on('pagechanging',(event:{pageNumber:number})=>{if(!abort.signal.aborted)setPage(event.pageNumber);});
        bus.on('pagesinit',()=>{if(viewer&&!abort.signal.aborted)viewer.currentScaleValue='page-width';});
        const url=initial.layer&&initial.layer.baseRevision===view.document.revision?`${base}/layers/${initial.layerRevision}`:assetUrl(view,view.manifest.primary);
        task=pdfjs.getDocument({url,cMapUrl:__PDF_ASSET_BASE__+'cmaps/',cMapPacked:true,standardFontDataUrl:__PDF_ASSET_BASE__+'standard_fonts/',wasmUrl:__PDF_ASSET_BASE__+'wasm/',enableXfa:false});
        const loaded=await task.promise;pdf=loaded;if(abort.signal.aborted){await task.destroy();return;}
        (loaded.annotationStorage as unknown as {onSetModified:()=>void}).onSetModified=changed;viewer.setDocument(loaded);linkService.setDocument(loaded);setPages(loaded.numPages);setReady(true);setStatus(pendingPreview?'Показана предыдущая версия. Готовится новый предпросмотр.':'PDF готов');
        observer=new ResizeObserver(()=>{if(viewer?.pdfDocument)viewer.currentScaleValue='page-width';});observer.observe(container.current!);
        actions.current={changed,pointerChanged:target=>{if(activeMode!==pdfjs.AnnotationEditorType.NONE||target.closest('.editToolbar'))changed();},save,download,tool:mode=>{try{if(viewer&&editable)viewer.annotationEditorMode={mode};activeMode=mode;}catch{report('Этот инструмент недоступен для данного PDF.');}},page:delta=>{if(viewer)viewer.currentPageNumber=Math.max(1,Math.min(pdf!.numPages,viewer.currentPageNumber+delta));},zoom:scale=>{if(viewer)viewer.currentScaleValue=scale;},jump:page=>{if(viewer&&Number.isInteger(page))viewer.currentPageNumber=Math.max(1,Math.min(pdf!.numPages,page));},undo:()=>{manager?.undo();changed();},redo:()=>{manager?.redo();changed();},parameter:(type,value)=>bus.dispatch('switchannotationeditorparams',{source:viewer,type,value})};
        poll=setInterval(()=>void heartbeat(),15000);
      }catch(error){if(!abort.signal.aborted)report('Не удалось открыть PDF. Повторите открытие или скачайте оригинал при наличии прав.');}
    })();
    return()=>{abort.abort();clearTimeout(timer);clearInterval(poll);observer?.disconnect();window.removeEventListener('beforeunload',leave);removeGuard();document.removeEventListener('visibilitychange',visible);actions.current=empty;viewer?.setDocument(null as unknown as PDFDocumentProxy);void task?.destroy().catch(()=>{});};
  },[view,csrf,attempt,replace]);
  function reload(){if(dirty&&!window.confirm('Отбросить несохранённые изменения PDF и открыть сохранённую версию?'))return;onRefresh();}
  return <section className="pdf-workspace" aria-label="PDF"><div className="pdf-toolbar">
    <button type="button" disabled={!ready||page===1} onClick={()=>actions.current.page(-1)} aria-label="Предыдущая страница">←</button><label>Страница <input className="pdf-page-number" aria-label="Страница PDF" type="number" min="1" max={pages} value={page} onChange={e=>actions.current.jump(Number(e.target.value))}/> / {pages||'…'}</label><button type="button" disabled={!ready||page===pages} onClick={()=>actions.current.page(1)} aria-label="Следующая страница">→</button>
    <label>Масштаб <select defaultValue="page-width" disabled={!ready} onChange={e=>actions.current.zoom(e.target.value)}><option value="page-width">По ширине</option><option value="page-fit">Страница</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option></select></label>
    {view.document.capabilities.write&&<><label>Инструмент <select disabled={!ready||paused} defaultValue={pdfjs.AnnotationEditorType.NONE} onChange={e=>actions.current.tool(Number(e.target.value))}><option value={pdfjs.AnnotationEditorType.NONE}>Выбор</option><option value={pdfjs.AnnotationEditorType.FREETEXT}>Текст</option><option value={pdfjs.AnnotationEditorType.HIGHLIGHT}>Выделение</option><option value={pdfjs.AnnotationEditorType.INK}>Рисование</option></select></label><details><summary>Параметры</summary><div className="pdf-parameters"><button type="button" onClick={()=>actions.current.undo()}>Отменить</button><button type="button" onClick={()=>actions.current.redo()}>Повторить</button><label>Размер текста <input type="number" min="5" max="100" defaultValue="10" onChange={e=>{const value=Number(e.target.value);if(value>=5&&value<=100)actions.current.parameter(pdfjs.AnnotationEditorParamsType.FREETEXT_SIZE,value);}}/></label><label>Толщина <input type="number" min="1" max="20" defaultValue="1" onChange={e=>{const value=Number(e.target.value);if(value>=1&&value<=20)actions.current.parameter(pdfjs.AnnotationEditorParamsType.INK_THICKNESS,value);}}/></label><label>Цвет <input type="color" defaultValue="#000000" onChange={e=>{for(const type of [pdfjs.AnnotationEditorParamsType.FREETEXT_COLOR,pdfjs.AnnotationEditorParamsType.INK_COLOR,pdfjs.AnnotationEditorParamsType.HIGHLIGHT_COLOR])actions.current.parameter(type,e.target.value);}}/></label></div></details><button type="button" disabled={!ready||paused} onClick={()=>void actions.current.save()}>Сохранить</button></>}
    {view.document.capabilities.export&&<button type="button" disabled={!ready} onClick={()=>void actions.current.download()}>Скачать с изменениями</button>}<button type="button" onClick={reload}>Перезагрузить</button><span role="status">{status}</span>
  </div>{error&&<div className="notice error" role="alert"><p>{error}</p>{recoveryId&&view.document.capabilities.export&&<a href={`/api/documents/${encodeURIComponent(view.document.id)}/pdf/recovery/${encodeURIComponent(recoveryId)}`} download>Скачать сохранённую конфликтующую копию</a>}</div>}{stale&&!replace&&<div className="notice" role="alert"><p>Сохранённые аннотации относятся к предыдущему оригиналу. Перед созданием нового слоя скачайте прежний при необходимости.</p>{view.document.capabilities.export&&<a href={`/api/documents/${encodeURIComponent(view.document.id)}/pdf/layers/${staleRevision}`} download>Прежний слой</a>}{view.document.capabilities.write&&<button type="button" onClick={()=>{if(window.confirm('Начать новый слой аннотаций для текущего оригинала?'))setReplace(true);}}>Начать новый слой</button>}</div>}
    <div className="pdf-stage"><div className="pdf-container" ref={container} onInput={()=>actions.current.changed()} onPointerUpCapture={e=>actions.current.pointerChanged(e.target as Element)} onKeyUp={e=>{if(((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase()))||['Delete','Backspace'].includes(e.key))actions.current.changed();}}><div className="pdfViewer"/></div></div>
  </section>;
}
