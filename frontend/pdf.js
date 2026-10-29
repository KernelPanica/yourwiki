import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';

// The viewer component reads the PDF.js API from this global at module load.
globalThis.pdfjsLib = pdfjs;
const {PDFViewer, EventBus, PDFLinkService} = await import('pdfjs-dist/web/pdf_viewer.mjs');
const t = window.gettext;
const boot = JSON.parse(document.getElementById('pdf-bootstrap').textContent);
const originallyEditable=boot.write;
const assets = '/static/wiki/dist/pdf-assets/';
pdfjs.GlobalWorkerOptions.workerSrc = assets + 'pdf.worker.mjs';
const status = document.getElementById('pdf-status');
const container = document.getElementById('pdf-container');
const controls = document.getElementById('pdf-controls');
const zoom = document.getElementById('pdf-zoom');
const panButton = document.getElementById('pdf-pan');
const eventBus = new EventBus();
const linkService = new PDFLinkService({eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer'});
const viewer = new PDFViewer({container, eventBus, linkService,
  annotationEditorMode: boot.write ? pdfjs.AnnotationEditorType.NONE : pdfjs.AnnotationEditorType.DISABLE,
  annotationMode: boot.write ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
  imageResourcesPath: assets + 'images/', enablePermissions: true});
linkService.setViewer(viewer);
new ResizeObserver(() => {
 const scale=document.getElementById('pdf-zoom').value;
 if(viewer.pdfDocument && ['page-width','page-fit'].includes(scale))viewer.currentScaleValue=scale;
}).observe(container);
let pdf, manager, dirty = false, saving = false, conflicted = boot.layer_state==='conflict', saveTimer, version = 0;
const clientId=crypto.randomUUID();
const fail = message => {status.textContent = t(message); status.setAttribute('role', 'alert');};
const changed = () => {if (!boot.write) return; dirty = true;version++;status.textContent = t(conflicted?'Conflict · automatic saving paused':'Unsaved PDF changes');clearTimeout(saveTimer);if(!conflicted)saveTimer=setTimeout(()=>savePDF(),1500);};
eventBus.on('annotationeditoruimanager', event => {manager = event.uiManager;});
eventBus.on('pagesinit', () => {viewer.currentScaleValue = 'page-width'; controls.disabled = false;});
function updateNavigation() {
 document.getElementById('pdf-page').value = viewer.currentPageNumber;
 document.getElementById('pdf-previous').disabled = viewer.currentPageNumber <= 1;
 document.getElementById('pdf-next').disabled = viewer.currentPageNumber >= (pdf?.numPages || 1);
}
eventBus.on('pagechanging', updateNavigation);
eventBus.on('pagesinit', updateNavigation);
document.getElementById('pdf-previous').onclick = () => {viewer.currentPageNumber = Math.max(1,viewer.currentPageNumber-1);};
document.getElementById('pdf-next').onclick = () => {viewer.currentPageNumber = Math.min(pdf.numPages,viewer.currentPageNumber+1);};
for (const action of ['undo','redo']) document.getElementById(`pdf-${action}`)?.addEventListener('click',()=>manager?.[action]());
function parameter(type,value) {eventBus.dispatch('switchannotationeditorparams',{source:viewer,type,value});}
document.getElementById('pdf-text-size')?.addEventListener('change',event=>{
 const size=Number(event.target.value);if(size>=5 && size<=100)parameter(pdfjs.AnnotationEditorParamsType.FREETEXT_SIZE,size);
});
document.getElementById('pdf-line-width')?.addEventListener('change',event=>{
 const width=Number(event.target.value);if(width>=1 && width<=20)parameter(pdfjs.AnnotationEditorParamsType.INK_THICKNESS,width);
});
document.getElementById('pdf-color')?.addEventListener('input',event=>{
 for(const name of ['FREETEXT_COLOR','INK_COLOR','HIGHLIGHT_COLOR'])parameter(pdfjs.AnnotationEditorParamsType[name],event.target.value);
});
eventBus.on('editingstateschanged',event=>{
 if(!boot.write)return;
 document.getElementById('pdf-undo').disabled=!event.details.hasSomethingToUndo;
 document.getElementById('pdf-redo').disabled=!event.details.hasSomethingToRedo;
});
eventBus.on('annotationeditormodechanged', event => {const select=document.getElementById('pdf-tool');if(select)select.value=String(event.mode);});
container.addEventListener('input', () => {if (boot.write) changed();});
// Keep the unsaved warning without initiating a save while leaving.
window.addEventListener('beforeunload', event => {if (dirty) {event.preventDefault(); event.returnValue = '';}});
document.getElementById('pdf-page').onchange = event => {
  const page = Number(event.target.value);
  if (Number.isInteger(page) && page >= 1 && page <= pdf.numPages) viewer.currentPageNumber = page;
  else event.target.value = viewer.currentPageNumber;
};
// Retain the page point beneath the viewport centre when changing scale.
function setZoom(value) {
  if (!pdf) return;
  const page = viewer.getPageView(viewer.currentPageNumber - 1)?.div;
  const bounds = page?.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  const center = {x: viewport.left + container.clientWidth / 2, y: viewport.top + container.clientHeight / 2};
  const anchor = bounds && {x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height};
  viewer.currentScaleValue = value;
  if (anchor) requestAnimationFrame(() => {
    const updated = page.getBoundingClientRect();
    container.scrollLeft += updated.left + updated.width * anchor.x - center.x;
    container.scrollTop += updated.top + updated.height * anchor.y - center.y;
  });
}
function updateZoom() {
  const value = viewer.currentScaleValue;
  const preset = [...zoom.options].find(option => option.value !== 'custom' &&
    (option.value === value || Number(option.value) === viewer.currentScale));
  const custom = zoom.querySelector('[value="custom"]');
  custom.hidden = Boolean(preset);
  custom.textContent = `${Math.round(viewer.currentScale * 100)}%`;
  zoom.value = preset?.value || 'custom';
  document.getElementById('pdf-zoom-out').disabled = viewer.currentScale <= .25;
  document.getElementById('pdf-zoom-in').disabled = viewer.currentScale >= 5;
}
eventBus.on('scalechanging', updateZoom);
zoom.onchange = event => {if(event.target.value !== 'custom')setZoom(event.target.value);};
for (const [id, direction] of [['pdf-zoom-out', -1], ['pdf-zoom-in', 1]]) {
  document.getElementById(id).onclick = () => setZoom(String(Math.max(.25, Math.min(5,
    Math.round((viewer.currentScale + direction * .25) * 100) / 100))));
}
let panning = false, drag;
function setPan(active) {
  panning = active;
  panButton.setAttribute('aria-pressed', String(active));
  container.classList.toggle('pdf-pan', active);
  if (active && boot.write) {
    manager?.commitOrRemove();
    viewer.annotationEditorMode = {mode: pdfjs.AnnotationEditorType.NONE};
  }
}
panButton.onclick = () => setPan(!panning);
container.addEventListener('pointerdown', event => {
  // Native touch scrolling also supports both axes. Avoid intercepting scrollbars.
  if (!panning || event.pointerType === 'touch' || event.button !== 0) return;
  const rect = container.getBoundingClientRect();
  if (event.clientX >= rect.left + container.clientWidth || event.clientY >= rect.top + container.clientHeight) return;
  drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: container.scrollLeft, top: container.scrollTop};
  container.setPointerCapture(event.pointerId);
  container.classList.add('pdf-panning');
  event.preventDefault();
});
container.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  container.scrollLeft = drag.left + drag.x - event.clientX;
  container.scrollTop = drag.top + drag.y - event.clientY;
});
function endPan(event) {
  if (!drag || drag.id !== event.pointerId) return;
  drag = null;
  container.classList.remove('pdf-panning');
  if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])container.addEventListener(type, endPan);
document.getElementById('pdf-tool')?.addEventListener('change', event => {
  setPan(false);
  try {viewer.annotationEditorMode = {mode: Number(event.target.value)};}
  catch {fail('PDF editing is unavailable for this file.');}
});
async function savePDF() {
  if (saving || !pdf || !boot.write || conflicted || !dirty) return;
  saving = true;clearTimeout(saveTimer);
  document.activeElement?.blur();manager?.commitOrRemove();
  const snapshotVersion=version;
  document.getElementById('pdf-save').disabled=true;
  status.textContent=t('Saving PDF…');
  try {
    const bytes=await pdf.saveDocument();
    const body=new FormData(document.getElementById('pdf-save-form'));
    body.set('file',new Blob([bytes],{type:'application/pdf'}),'edited.pdf');
    body.set('revision',boot.revision);body.set('client_id',clientId);
    if(boot.replace_stale_layer)body.set('replace_stale_layer','1');
    const response=await window.yourwikiUI.request(`/documents/${boot.id}/pdf/`,{method:'POST',body,headers:{Accept:'application/json'}});
    if(!response.ok){
      if(response.status===409){conflicted=true;document.getElementById('pdf-conflict').hidden=false;throw new Error(t('The original changed. Download your edits before leaving or reloading.'));}
      if(response.status===403||response.status===404){boot.write=false;throw new Error(t('Write access was revoked. Download your edits before leaving.'));}
      await window.yourwikiUI.check(response);
    }
    const saved=await window.yourwikiUI.check(response);
    if(!Number.isInteger(saved.revision))throw new window.yourwikiUI.UIError('The server returned an invalid response. Check whether the action finished before retrying.');
    boot.revision=saved.revision;
    dirty=version!==snapshotVersion;
    status.textContent=t(dirty?'Unsaved PDF changes':'PDF saved');
  }catch(error){dirty=true;fail(error.message);}
  finally{saving=false;document.getElementById('pdf-save').disabled=conflicted||!boot.write;if(dirty&&!conflicted&&boot.write)saveTimer=setTimeout(()=>savePDF(),3000);}
}
document.getElementById('pdf-save')?.addEventListener('click',()=>savePDF());
document.getElementById('pdf-start-layer')?.addEventListener('click',()=>{
  if(!window.confirm(t('Start a new annotation layer for this original? Download the earlier annotations first if you need them.')))return;
  boot.replace_stale_layer=true;conflicted=false;
  document.getElementById('pdf-stale-layer').hidden=true;
  document.getElementById('pdf-save').disabled=false;
  status.textContent=t(dirty?'Unsaved PDF changes':'PDF ready');
  if(dirty)void savePDF();
});
document.getElementById('pdf-reload')?.addEventListener('click',async()=>{
  if(!window.confirm(t('Discard local changes and reload the saved PDF?')))return;
  dirty=false;location.reload();
});
document.getElementById('pdf-conflict-download').onclick=()=>document.getElementById('pdf-download').click();
document.getElementById('pdf-download').onclick = async () => {
  if(boot.export===false)return;
  if (!pdf) return;
  try {
    document.activeElement?.blur(); manager?.commitOrRemove();
    const bytes = originallyEditable ? await pdf.saveDocument() : await pdf.getData();
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
    const link = document.createElement('a'); link.href = url; link.download = boot.title; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {fail('Could not download the PDF.');}
};
async function loadPDF({page=1,scale='page-width',remote=false,layerState=boot.layer_state}={}) {
  const started=version;
  const earlier=pdf;
  const next = await pdfjs.getDocument({url: `/documents/${boot.id}/export/?inline=1`,
    cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/', isEvalSupported: false, enableXfa: false}).promise;
  if(remote&&(dirty||version!==started)){
    await next.loadingTask.destroy();conflicted=true;clearTimeout(saveTimer);
    document.getElementById('pdf-conflict').hidden=false;
    fail('The original changed. Download your edits before reloading.');return false;
  }
  controls.disabled=true;
  viewer.setDocument(null);linkService.setDocument(null);
  pdf=next;
  if(earlier)await earlier.loadingTask.destroy();
  pdf.annotationStorage.onSetModified = changed;
  document.getElementById('pdf-page').max = pdf.numPages;
  document.getElementById('pdf-pages').textContent = pdf.numPages;
  viewer.setDocument(pdf); linkService.setDocument(pdf);
  eventBus.on('pagesinit',function restore(){viewer.currentScaleValue=scale;viewer.currentPageNumber=Math.min(page,pdf.numPages);eventBus.off('pagesinit',restore);});
  status.textContent = t('PDF ready');
  document.getElementById('pdf-stale-layer').hidden=layerState!=='conflict';
  if(boot.write)document.getElementById('pdf-save').disabled=layerState==='conflict';
  return true;
}
const endPDFLoading=window.yourwikiLoading?.begin(container);
try {await loadPDF();} catch {fail('Could not open the PDF. Download the original file to view it locally.');} finally {endPDFLoading?.();}
let storageFingerprint,checkingStorage=false;
async function heartbeat(){
  try {
    if(document.hidden||saving||checkingStorage)return;
    checkingStorage=true;
    const response=await fetch(`/api/docs/${boot.id}/storage-status`,{cache:'no-store'});
    if(!response.ok)return;
    const remote=await response.json();
    // Revision is supplied on first render, so even a first-poll change is seen.
    const changedOriginal=storageFingerprint===undefined?remote.revision!==boot.revision:storageFingerprint!==remote.fingerprint;
    if(changedOriginal){
      if(dirty){conflicted=true;clearTimeout(saveTimer);document.getElementById('pdf-conflict').hidden=false;fail('The original changed. Download your edits before reloading.');return;}
      const page=viewer.currentPageNumber,scale=viewer.currentScaleValue;
      if(!await loadPDF({page,scale,remote:true,layerState:remote.layer_state}))return;
      boot.revision=remote.revision;boot.layer_state=remote.layer_state;conflicted=remote.layer_state==='conflict';
    }
    storageFingerprint=remote.fingerprint;
  }catch(error){console.warn('PDF storage refresh deferred',error);}
  finally{checkingStorage=false;}
}
setInterval(heartbeat,30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void heartbeat();});
