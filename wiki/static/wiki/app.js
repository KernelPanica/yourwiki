const t = window.gettext;
const format = (message, values) => window.interpolate(t(message), values, true);
document.querySelectorAll('[data-creation-permissions]').forEach(section => {
  const mode = section.querySelector('[name="permissions_mode"]');
  const rules = section.querySelector('[data-explicit-permissions]');
  section.querySelectorAll('[data-group-permission-row]').forEach(row => {
    const enabled = row.querySelector('[data-group-permission-enabled]');
    const updateGroup = () => row.querySelectorAll('[data-group-permission-rule]').forEach(input => {
      input.disabled = !enabled.checked;
    });
    enabled.addEventListener('change', updateGroup);
    updateGroup();
  });
  const update = () => {
    rules.hidden = mode.value !== 'custom';
    rules.disabled = mode.value !== 'custom';
  };
  mode.addEventListener('change', update);
  update();
});
// Small progressive enhancements; all data and access decisions stay in Django.
const sidebar = document.querySelector('#workspace-sidebar');
const sidebarToggle = document.querySelector('[data-sidebar-open]');
const sidebarClosers = document.querySelectorAll('[data-sidebar-close]');
const sidebarToggleHome = document.createComment('Sidebar toggle position');
sidebarToggle?.before(sidebarToggleHome);
const sidebarMedia = matchMedia('(max-width:800px)');
let sidebarMobile = sidebarMedia.matches;
let desktopSidebarOpen = !document.body.classList.contains('editor-page');
try {const saved = localStorage.getItem('yourwiki:sidebar');if(saved !== null) desktopSidebarOpen = saved === 'open';} catch {}
const setSidebar = (open, focus = true, remember = true) => {
  if (!sidebar || !sidebarToggle) return;
  document.body.classList.toggle('sidebar-open', open);
  // One control remains reachable inside the mobile drawer while it is open.
  if (open && sidebarMedia.matches) sidebar.querySelector('.sidebar-head').append(sidebarToggle);
  else sidebarToggleHome.after(sidebarToggle);
  sidebar.inert = !open;
  sidebar.setAttribute('aria-hidden', String(!open));
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarToggle.setAttribute('aria-label', t(open ? 'Close file explorer' : 'Open file explorer'));
  if (remember && !sidebarMedia.matches) {
    desktopSidebarOpen = open;
    try {localStorage.setItem('yourwiki:sidebar', open ? 'open' : 'closed');} catch {}
  }
  if (focus) {if(open) sidebar.querySelector('a')?.focus();else sidebarToggle.focus();}
  window.dispatchEvent(new Event('resize'));
};
sidebarToggle?.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
sidebarClosers.forEach(button => button.addEventListener('click', () => setSidebar(false)));
setSidebar(sidebarMobile ? false : desktopSidebarOpen, false, false);
document.querySelectorAll('.explorer-branch[data-folder-id]').forEach(branch => {
  const key = `yourwiki:directory:${branch.dataset.folderId}`;
  try {
    const previous = sessionStorage.getItem(key);
    if (previous !== null) branch.open = previous === 'open';
    branch.addEventListener('toggle', () => {try{sessionStorage.setItem(key, branch.open ? 'open' : 'closed');}catch{/* Disclosure remains usable without browser storage. */}});
  } catch { /* Private browsing may disable storage; the disclosure still works. */ }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) setSidebar(false);
  if (event.key === '/' && !document.activeElement.isContentEditable && !document.querySelector('#visual-editor') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    const search = document.querySelector('#search') || document.querySelector('#workspace-search');
    if (search) { event.preventDefault(); search.focus(); }
  }
});
document.addEventListener('click', async event => {
  if(!event.target.closest('[data-copy]'))return;
  const input = document.querySelector('.invite-link');
  try { await navigator.clipboard.writeText(input.value); document.querySelector('#copy-status').textContent = t('Copied'); }
  catch { input.select(); document.querySelector('#copy-status').textContent = t('Select and copy the link above.'); }
});
let zoom = 1;
const movePolicies=document.getElementById('move-policies');
if(movePolicies){
  const values=JSON.parse(movePolicies.textContent),select=document.querySelector('select[name=destination]'),preview=document.getElementById('move-policy-preview');
  const show=()=>{const value=values[select.value];preview.replaceChildren();const title=document.createElement('p');title.textContent=t('Destination group: ')+value.group;preview.append(title);for(const [scope,actions] of Object.entries(value.policy)){const line=document.createElement('p');line.textContent=t(scope)+': '+(Object.entries(actions).filter(([,allowed])=>allowed).map(([action])=>t(action)).join(', ')||t('no access'));preview.append(line);}};
  select.addEventListener('change',show);show();
}
document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
  zoom = Math.max(0.5, Math.min(3, zoom + Number(button.dataset.zoom)));
  const graph = document.querySelector('.graph');
  graph.style.width = `${zoom * 100}%`; graph.style.maxHeight = 'none';
}));
const editor = document.querySelector('[data-editor]');
if (editor) {
  let dirty = false;
  editor.addEventListener('input', () => { dirty = true; });
  editor.addEventListener('submit', event => { if(!event.defaultPrevented)dirty = false; });
  editor.addEventListener('yourwiki:form-success', () => { dirty = false; });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
}

const workspaceMenu = document.querySelector('.workspace-menu');
document.addEventListener('click', event => {
  if (workspaceMenu && !workspaceMenu.contains(event.target)) workspaceMenu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && workspaceMenu?.open) {
    workspaceMenu.open = false;
    workspaceMenu.querySelector('summary').focus();
  }
});

let draggedItem, hoverTimer, hoverTarget;
const clearDrop = () => {
  clearTimeout(hoverTimer);
  hoverTarget = null;
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
};
document.addEventListener('dragstart', event => {
  draggedItem = event.target.closest('[data-move-url]');
  if (!draggedItem) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/x-yourwiki-item', draggedItem.dataset.moveUrl);
  event.dataTransfer.setData('text/plain', draggedItem.dataset.moveUrl);
});
document.addEventListener('dragover', event => {
  const target = event.target.closest('[data-drop-folder]');
  if (!target || !(draggedItem || event.dataTransfer.types.includes('Files'))) return;
  if (draggedItem?.dataset.folderId === target.dataset.dropFolder) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = draggedItem ? 'move' : 'copy';
  if (target !== hoverTarget) {
    clearDrop();
    hoverTarget = target;
    target.classList.add('drop-target');
    document.getElementById('explorer-status').textContent = format(draggedItem ? 'Release to move into %(path)s' : 'Release to upload into %(path)s', {path:target.dataset.dropPath || t('this directory')});
    document.getElementById('explorer-status').dataset.dropHint = document.getElementById('explorer-status').textContent;
    const branch = target.closest('details.explorer-branch');
    if (branch && !branch.open) hoverTimer = setTimeout(() => { branch.open = true; }, 650);
  }
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget || !document.documentElement.contains(event.relatedTarget)) clearDrop();
});
document.addEventListener('dragend', () => {
  draggedItem = null; clearDrop();
  const status = document.getElementById('explorer-status');
  if (status?.textContent === status?.dataset.dropHint) status.textContent = '';
});
document.addEventListener('drop', async event => {
  const target = event.target.closest('[data-drop-folder]');
  if (!target || !(draggedItem || event.dataTransfer.files.length)) return;
  event.preventDefault();
  const source = draggedItem;
  draggedItem = null;
  clearDrop();
  const status = document.getElementById('explorer-status');
  const token = new FormData(document.getElementById('explorer-move-form'));
  let uploaded=0;
  try {
    let destinationUrl = target.href || target.querySelector(':scope > a[href]')?.href || location.href;
    if (source) {
      status.textContent = t('Moving…');
      token.set('destination', target.dataset.dropFolder);
      const response = await window.yourwikiUI.request(source.dataset.moveUrl, {method:'POST', body:token, headers:{Accept:'application/json'}});
      destinationUrl = (await window.yourwikiUI.check(response)).url;
    } else {
      const files = [...event.dataTransfer.files];
      for (const [index, file] of files.entries()) {
        status.textContent = format('Uploading %(index)s of %(total)s…', {index:index+1,total:files.length});
        const body = new FormData(document.getElementById('explorer-move-form'));
        body.set('path', target.dataset.dropPath || '/');
        if (target.dataset.dropFolder) body.set('folder', target.dataset.dropFolder);
        body.set('file', file);
        const response = await window.yourwikiUI.request('/files/upload/', {method:'POST', body,headers:{Accept:'application/json'}});
        await window.yourwikiUI.check(response);uploaded++;
      }
    }
    location.assign(destinationUrl);
  } catch (error) { const message=window.yourwikiUI.show(error,status);if(uploaded)status.textContent=format('Uploaded %(count)s file(s). %(message)s',{count:uploaded,message}); }
});

// HTML drag events are not emitted reliably by iOS/Android browsers. Keep the
// same move endpoint and add a small pointer gesture for touch and pen input.
let touchDrag;
document.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse') return;
  const source = event.target.closest('[data-move-url]');
  if (!source) return;
  touchDrag = {source, pointerId:event.pointerId, x:event.clientX, y:event.clientY, target:null, ghost:null};
  source.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!touchDrag || event.pointerId !== touchDrag.pointerId) return;
  if (!touchDrag.ghost && Math.hypot(event.clientX-touchDrag.x, event.clientY-touchDrag.y) > 8) {
    touchDrag.ghost = touchDrag.source.cloneNode(true); touchDrag.ghost.classList.add('touch-drag-ghost');
    Object.assign(touchDrag.ghost.style,{position:'fixed',left:`${event.clientX+10}px`,top:`${event.clientY+10}px`,zIndex:70,pointerEvents:'none',width:`${touchDrag.source.getBoundingClientRect().width}px`});
    document.body.append(touchDrag.ghost);
  }
  if (!touchDrag.ghost) return;
  touchDrag.ghost.style.left=`${event.clientX+10}px`;touchDrag.ghost.style.top=`${event.clientY+10}px`;
  const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-drop-folder]');
  if (target !== touchDrag.target) { clearDrop(); touchDrag.target=target; target?.classList.add('drop-target'); }
  event.preventDefault();
},{passive:false});
document.addEventListener('pointerup', async event => {
  if (!touchDrag || event.pointerId !== touchDrag.pointerId) return;
  const drag=touchDrag; touchDrag=null; drag.ghost?.remove(); clearDrop();
  if (!drag.target || !drag.ghost) return;
  const token=new FormData(document.getElementById('explorer-move-form'));token.set('destination',drag.target.dataset.dropFolder);
  const status=document.getElementById('explorer-status');status.textContent=t('Moving…');
  try { const response=await window.yourwikiUI.request(drag.source.dataset.moveUrl,{method:'POST',body:token,headers:{Accept:'application/json'}});location.assign((await window.yourwikiUI.check(response)).url); }
  catch(error){window.yourwikiUI.show(error,status);}
});

const createFile = document.querySelector('[data-create-file]');
const fileKind = document.getElementById('id_kind');
if (createFile && fileKind) {
  const title = document.getElementById('id_title');
  const fileFormat = document.getElementById('id_file_format');
  const preview = document.getElementById('file-name-preview');
  const previewRow = document.querySelector('[data-file-preview]');
  const help = document.getElementById('id_file_format_helptext');
  let documentFormat = fileFormat.value || 'docx';
  const documentOptions = [...fileFormat.options].map(option => [option.value, option.text]);
  const extensions = {table:'ods', presentation:'pptx', drawio:'drawio', canvas:'canvas'};
  const formats = {table:'OpenDocument Spreadsheet (.ods)', presentation:'PowerPoint (.pptx)', drawio:'Draw.io (.drawio)', canvas:'Canvas (.canvas)', file:t('From file name')};
  document.querySelector('label[for="id_file_format"]').textContent = t('File format');
  const updateName = () => {
    const kind = fileKind.value;
    const extension = kind === 'document' ? documentFormat : extensions[kind];
    let name = title.value.trim();
    if (kind !== 'file') name = name.replace(/\.(docx|md|ods|pptx|drawio|canvas)$/i, '').trim();
    name = name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '').slice(0,160) || 'file';
    preview.textContent = name + (extension ? '.' + extension : '');
  };
  const updateType = () => {
    const isDocument = fileKind.value === 'document';
    fileFormat.replaceChildren();
    const options = isDocument ? documentOptions : [[extensions[fileKind.value] || '', formats[fileKind.value]]];
    for (const [value, label] of options) fileFormat.add(new Option(label, value));
    if (isDocument) fileFormat.value = documentFormat;
    fileFormat.disabled = !isDocument;
    if (help) help.textContent = isDocument ? t('Choose the document format.') : t('The format follows the selected file type.');
    createFile.textContent = fileKind.value === 'file' ? t('Create file') : t('Create and open editor');
    updateName();
  };
  fileFormat.addEventListener('change', () => {documentFormat = fileFormat.value;updateName();});
  title.addEventListener('input', updateName);
  fileKind.addEventListener('change', updateType);
  previewRow.hidden = false;
  updateType();
}

// Familiar navigation, shared across the explorer, forms, and editor pages.
const currentPath = location.pathname;
const currentSection = new URLSearchParams(location.search).get('section');
const activeNav = currentPath === '/' ? (currentSection === 'Recent' ? 'recent' : currentSection === 'Starred' ? 'starred' : 'all')
  : currentPath === '/trash/' ? 'trash'
  : currentPath === '/account/' ? 'account'
  : /^\/(settings|members|groups|mounts|storage|invitations|permissions)\//.test(currentPath) ? 'settings' : 'files';
document.querySelector(`[data-nav="${activeNav}"]`)?.setAttribute('aria-current', 'page');

// Native details retain a working no-JavaScript fallback. Closing a popup
// returns focus to its trigger; opening another closes the previous popup.
function closeDisclosure(details, focus = false) {
  details.open = false;
  if (focus) details.querySelector('summary')?.focus();
}
document.addEventListener('toggle', event => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.matches('[data-disclosure],.directory-menu') || !details.open) return;
  document.querySelectorAll('[data-disclosure][open],.directory-menu[open]').forEach(other => {
    if (other !== details && !other.contains(details)) closeDisclosure(other);
  });
}, true);
document.addEventListener('click', event => {
  document.querySelectorAll('[data-disclosure][open],.directory-menu[open]').forEach(details => {
    if (!details.contains(event.target)) closeDisclosure(details);
    else if (event.target.closest('button,a') && !event.target.closest('summary')) closeDisclosure(details);
    else if (event.target === details) closeDisclosure(details, true);
  });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelectorAll('[data-disclosure][open],.directory-menu[open]').forEach(details => closeDisclosure(details, true));
    if (document.body.classList.contains('editor-fullscreen')) exitEditorFullscreen();
  }
  if (event.key === 'Tab' && sidebarMedia.matches && document.body.classList.contains('sidebar-open')) {
    const items = [...sidebar.querySelectorAll('a,button,summary,input,select')].filter(el => el.getClientRects().length && !el.disabled);
    if (event.shiftKey && document.activeElement === items[0]) {event.preventDefault();items.at(-1)?.focus();}
    else if (!event.shiftKey && document.activeElement === items.at(-1)) {event.preventDefault();items[0]?.focus();}
  }
});

const fullScreenButton = document.querySelector('[data-editor-fullscreen]');
function updateFullscreen(active) {
  document.body.classList.toggle('editor-fullscreen', active);
  if (fullScreenButton) {
    fullScreenButton.textContent = t(active ? 'Exit full screen' : 'Full screen');
    fullScreenButton.setAttribute('aria-pressed', String(active));
  }
  window.dispatchEvent(new Event('resize'));
}
function exitEditorFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  updateFullscreen(false);fullScreenButton?.focus();
}
fullScreenButton?.addEventListener('click', async () => {
  if (document.body.classList.contains('editor-fullscreen')) {exitEditorFullscreen();return;}
  if (document.body.classList.contains('sidebar-open')) setSidebar(false);
  updateFullscreen(true);
  try {await document.getElementById('main-content').requestFullscreen?.();} catch { /* CSS layout also works when fullscreen is unavailable. */ }
});
document.addEventListener('fullscreenchange', () => {if (!document.fullscreenElement) updateFullscreen(false);});

const typePicker = document.querySelector('[data-type-picker]');
if (typePicker && fileKind) {
  const options = [...typePicker.querySelectorAll('[data-create-kind]')];
  const reflectType = () => options.forEach(option => {
    const selected = option.dataset.createKind === fileKind.value;
    option.setAttribute('aria-checked', String(selected));option.tabIndex = selected ? 0 : -1;
  });
  options.forEach((option, index) => {
    option.onclick = () => {fileKind.value = option.dataset.createKind;fileKind.dispatchEvent(new Event('change', {bubbles:true}));};
    option.onkeydown = event => {
      let next;
      if (['ArrowRight','ArrowDown'].includes(event.key)) next = (index + 1) % options.length;
      else if (['ArrowLeft','ArrowUp'].includes(event.key)) next = (index + options.length - 1) % options.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      else return;
      event.preventDefault();options[next].click();options[next].focus();
    };
  });
  fileKind.addEventListener('change', reflectType);reflectType();
  typePicker.hidden = false;
  fileKind.closest('[data-field]').hidden = true;
}

// Label the two read/write controls on narrow screens. On small screens every checkbox gets a visible
// label beside it instead of relying on a distant or squeezed table heading.
document.querySelectorAll('.policy-table').forEach(table => {
  if (!table.querySelector('input[type=checkbox]')) return;
  table.classList.add('responsive-permissions');
  table.querySelectorAll('tbody tr').forEach(row => {
    [...row.querySelectorAll('td')].forEach((cell, index) => {cell.dataset.permissionLabel = [t('Read'),t('Write')][index] || '';});
  });
});
const memberFilter = document.querySelector('[data-filter-members]');
memberFilter?.addEventListener('input', () => {
  const query = memberFilter.value.trim().toLocaleLowerCase();let count = 0;
  document.querySelectorAll('[data-member-option]').forEach(row => {row.hidden = !row.textContent.toLocaleLowerCase().includes(query);if (!row.hidden) count++;});
  document.querySelector('[data-members-empty]').hidden = count > 0;
});

const reflectSidebar = () => {
  if (sidebarMobile !== sidebarMedia.matches) {
    sidebarMobile = sidebarMedia.matches;
    setSidebar(sidebarMobile ? false : desktopSidebarOpen, false, false);
  }
};
window.addEventListener('resize', reflectSidebar);

// Read/write dependencies are also enforced on the server.
document.querySelectorAll('[data-rw-policy]').forEach(form=>{
 const inherit=form.querySelector('[data-inherit-access]'), own=form.querySelector('[data-own-access]');
 const update=()=>{own.hidden=inherit.checked;};
 inherit.addEventListener('change',update);update();
 form.querySelectorAll('[data-rw-row]').forEach(row=>{
  const read=row.querySelector('[data-rw="read"]'),write=row.querySelector('[data-rw="write"]');
  const enabled=row.querySelector('[data-group-access]');
  if(enabled){const sync=()=>{read.disabled=write.disabled=!enabled.checked;};enabled.addEventListener('change',sync);sync();}
  write.addEventListener('change',()=>{if(write.checked)read.checked=true;});
  read.addEventListener('change',()=>{if(!read.checked)write.checked=false;});
 });
});

for(const search of document.querySelectorAll('[data-user-access-search]')){
  search.addEventListener('input',()=>{const value=search.value.trim().toLocaleLowerCase();for(const row of search.closest('details').querySelectorAll('[data-user-access-row]'))row.hidden=!row.textContent.toLocaleLowerCase().includes(value);});
}
