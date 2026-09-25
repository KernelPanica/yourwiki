// Small progressive enhancements; all data and access decisions stay in Django.
const sidebar = document.querySelector('#workspace-sidebar');
const sidebarToggle = document.querySelector('[data-sidebar-open]');
const sidebarClosers = document.querySelectorAll('[data-sidebar-close]');
const setSidebar = open => {
  if (!sidebar || !sidebarToggle) return;
  document.body.classList.toggle('sidebar-open', open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  if (open) sidebar.querySelector('a')?.focus();
  else sidebarToggle.focus();
};
sidebarToggle?.addEventListener('click', () => setSidebar(true));
sidebarClosers.forEach(button => button.addEventListener('click', () => setSidebar(false)));
document.querySelectorAll('.explorer-branch[data-folder-id]').forEach(branch => {
  const key = `yourwiki:directory:${branch.dataset.folderId}`;
  try {
    const previous = sessionStorage.getItem(key);
    if (previous !== null) branch.open = previous === 'open';
    branch.addEventListener('toggle', () => sessionStorage.setItem(key, branch.open ? 'open' : 'closed'));
  } catch { /* Private browsing may disable storage; the disclosure still works. */ }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) setSidebar(false);
  if (event.key === '/' && !document.activeElement.isContentEditable && !document.querySelector('#visual-editor') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    const search = document.querySelector('#search');
    if (search) { event.preventDefault(); search.focus(); }
  }
});
document.querySelector('[data-copy]')?.addEventListener('click', async () => {
  const input = document.querySelector('.invite-link');
  try { await navigator.clipboard.writeText(input.value); document.querySelector('#copy-status').textContent = 'Copied'; }
  catch { input.select(); document.querySelector('#copy-status').textContent = 'Select and copy the link above.'; }
});
let zoom = 1;
const movePolicies=document.getElementById('move-policies');
if(movePolicies){
  const values=JSON.parse(movePolicies.textContent),select=document.querySelector('select[name=destination]'),preview=document.getElementById('move-policy-preview');
  const show=()=>{const value=values[select.value];preview.replaceChildren();const title=document.createElement('p');title.textContent='Destination group: '+value.group;preview.append(title);for(const [scope,actions] of Object.entries(value.policy)){const line=document.createElement('p');line.textContent=scope+': '+(Object.entries(actions).filter(([,allowed])=>allowed).map(([action])=>action).join(', ')||'no access');preview.append(line);}};
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
  editor.addEventListener('submit', () => { dirty = false; });
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
    document.getElementById('explorer-status').textContent = `Release to ${draggedItem ? 'move' : 'upload'} into ${target.dataset.dropPath || 'this directory'}`;
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
  if (status?.textContent.startsWith('Release to ')) status.textContent = '';
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
  try {
    let destinationUrl = target.href || target.querySelector(':scope > a[href]')?.href || location.href;
    if (source) {
      status.textContent = 'Moving…';
      token.set('destination', target.dataset.dropFolder);
      const response = await fetch(source.dataset.moveUrl, {method:'POST', body:token, headers:{Accept:'application/json'}});
      if (!response.ok) throw new Error('Could not move this item. Check directory access and destination.');
      destinationUrl = (await response.json()).url;
    } else {
      const files = [...event.dataTransfer.files];
      for (const [index, file] of files.entries()) {
        status.textContent = `Uploading ${index + 1} of ${files.length}…`;
        const body = new FormData(document.getElementById('explorer-move-form'));
        body.set('path', target.dataset.dropPath || '/');
        if (target.dataset.dropFolder) body.set('folder', target.dataset.dropFolder);
        body.set('file', file);
        const response = await fetch('/files/upload/', {method:'POST', body});
        if (!response.ok) throw new Error(`Could not upload ${file.name}. Files must be under 5 MB and you need write access.`);
      }
    }
    location.assign(destinationUrl);
  } catch (error) { status.textContent = error.message || 'Action failed. Please retry.'; }
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
  const status=document.getElementById('explorer-status');status.textContent='Moving…';
  try { const response=await fetch(drag.source.dataset.moveUrl,{method:'POST',body:token,headers:{Accept:'application/json'}});if(!response.ok)throw Error('Could not move this item. Check directory access and destination.');location.assign((await response.json()).url); }
  catch(error){status.textContent=error.message||'Move failed. Please retry.';}
});

const createFile = document.querySelector('[data-create-file]');
const fileKind = document.getElementById('id_kind');
if (createFile && fileKind) {
  const updateCreateLabel = () => { createFile.textContent = fileKind.value === 'file' ? 'Create file' : 'Create and open editor'; };
  fileKind.addEventListener('change', updateCreateLabel);
  updateCreateLabel();
}
