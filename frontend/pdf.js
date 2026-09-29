import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';

// The viewer component reads the PDF.js API from this global at module load.
globalThis.pdfjsLib = pdfjs;
const {PDFViewer, EventBus, PDFLinkService} = await import('pdfjs-dist/web/pdf_viewer.mjs');
const t = window.gettext;
const boot = JSON.parse(document.getElementById('pdf-bootstrap').textContent);
const assets = '/static/wiki/dist/pdf-assets/';
pdfjs.GlobalWorkerOptions.workerSrc = assets + 'pdf.worker.mjs';
const status = document.getElementById('pdf-status');
const container = document.getElementById('pdf-container');
const controls = document.getElementById('pdf-controls');
const eventBus = new EventBus();
const linkService = new PDFLinkService({eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer'});
const viewer = new PDFViewer({container, eventBus, linkService,
  annotationEditorMode: boot.write ? pdfjs.AnnotationEditorType.NONE : pdfjs.AnnotationEditorType.DISABLE,
  annotationMode: boot.write ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
  imageResourcesPath: assets + 'images/', enablePermissions: true});
linkService.setViewer(viewer);
let pdf, manager, dirty = false, saving = false;
const fail = message => {status.textContent = t(message); status.setAttribute('role', 'alert');};
const changed = () => {dirty = true; status.textContent = t('Unsaved PDF changes');};
eventBus.on('annotationeditoruimanager', event => {manager = event.uiManager;});
eventBus.on('pagesinit', () => {viewer.currentScaleValue = 'page-width'; controls.disabled = false;});
eventBus.on('pagechanging', event => {document.getElementById('pdf-page').value = event.pageNumber;});
eventBus.on('annotationeditormodechanged', event => {document.getElementById('pdf-tool')?.setAttribute('data-mode', event.mode);});
container.addEventListener('input', () => {if (boot.write) changed();});
window.addEventListener('beforeunload', event => {if (dirty) {event.preventDefault(); event.returnValue = '';}});
document.getElementById('pdf-page').onchange = event => {
  const page = Number(event.target.value);
  if (Number.isInteger(page) && page >= 1 && page <= pdf.numPages) viewer.currentPageNumber = page;
  else event.target.value = viewer.currentPageNumber;
};
document.getElementById('pdf-zoom').onchange = event => {viewer.currentScaleValue = event.target.value;};
document.getElementById('pdf-tool')?.addEventListener('change', event => {
  try {viewer.annotationEditorMode = {mode: Number(event.target.value)};}
  catch {fail('PDF editing is unavailable for this file.');}
});
document.getElementById('pdf-save')?.addEventListener('click', async () => {
  if (saving || !pdf) return;
  saving = true;
  // Commit the focused text annotation before taking a PDF snapshot.
  document.activeElement?.blur();
  manager?.commitOrRemove();
  controls.disabled = true; container.inert = true;
  status.textContent = t('Saving PDF…');
  try {
    const bytes = await pdf.saveDocument();
    const body = new FormData(document.getElementById('pdf-save-form'));
    body.set('file', new Blob([bytes], {type: 'application/pdf'}), 'edited.pdf');
    body.set('revision', boot.revision);
    const response = await fetch(`/documents/${boot.id}/pdf/`, {method: 'POST', body, headers: {Accept: 'application/json'}});
    if (!response.ok) {
      if (response.status === 409) throw new Error(t('This PDF changed in another tab. Download your edits before reloading.'));
      throw new Error(t('PDF save failed. Your edits are still in this tab; download them before leaving.'));
    }
    boot.revision = (await response.json()).revision;
    dirty = false;
    status.textContent = t('PDF saved');
  } catch (error) {dirty = true; fail(error.message);}
  finally {saving = false; controls.disabled = false; container.inert = false;}
});
document.getElementById('pdf-download').onclick = async () => {
  if (!pdf) return;
  try {
    document.activeElement?.blur(); manager?.commitOrRemove();
    const bytes = boot.write ? await pdf.saveDocument() : await pdf.getData();
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
    const link = document.createElement('a'); link.href = url; link.download = boot.title; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {fail('Could not download the PDF.');}
};
try {
  pdf = await pdfjs.getDocument({url: `/documents/${boot.id}/export/?inline=1`,
    cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/',
    wasmUrl: assets + 'wasm/', isEvalSupported: false, enableXfa: false}).promise;
  pdf.annotationStorage.onSetModified = changed;
  document.getElementById('pdf-page').max = pdf.numPages;
  document.getElementById('pdf-pages').textContent = pdf.numPages;
  viewer.setDocument(pdf); linkService.setDocument(pdf);
  status.textContent = t('PDF ready');
} catch {fail('Could not open the PDF. Download the original file to view it locally.');}
