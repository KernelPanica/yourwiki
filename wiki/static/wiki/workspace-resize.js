/* Pointer capture keeps dragging reliable across the office iframe boundary. */
document.querySelectorAll('[data-workspace-resize]').forEach(pane => {
  const grip = pane.querySelector('.workspace-resizer');
  const key = 'yourwiki:workspace-height:' + pane.dataset.workspaceResize;
  const extra = Number(pane.dataset.workspaceExtraHeight) || 0;
  const ratio = Number(pane.dataset.workspaceMaxRatio) || 3;
  const min = 260, max = () => Math.max(1200, innerHeight * ratio);
  let preferred = null, drag = null;
  try {const saved = Number(localStorage.getItem(key));if(Number.isFinite(saved) && saved >= min) preferred = saved;} catch {}
  function apply(value) {
    const height = Math.round(Math.min(max(), Math.max(min, value)));
    pane.style.height = height + 'px';
    grip.setAttribute('aria-valuemin', String(min));
    grip.setAttribute('aria-valuemax', String(max()));
    grip.setAttribute('aria-valuenow', String(height));
    return height;
  }
  function render() {
    if(drag) return;
    const available = Math.min(innerHeight - 12, innerHeight - pane.getBoundingClientRect().top - window.scrollY - 12);
    apply(document.body.classList.contains('editor-fullscreen') ? available : preferred ?? available + extra);
  }
  function remember(value) {
    preferred = apply(value);
    try {localStorage.setItem(key, String(preferred));} catch {}
  }
  grip.addEventListener('pointerdown', event => {
    if(event.button !== 0 || drag) return;
    event.preventDefault();
    grip.focus();
    drag = {id:event.pointerId, y:event.clientY, height:pane.getBoundingClientRect().height};
    grip.setPointerCapture(event.pointerId);
    document.body.classList.add('workspace-resizing');
  });
  grip.addEventListener('pointermove', event => {
    if(drag?.id === event.pointerId) apply(drag.height + event.clientY - drag.y);
  });
  function finish(event) {
    if(!drag || drag.id !== event.pointerId) return;
    remember(pane.getBoundingClientRect().height);
    drag = null;
    document.body.classList.remove('workspace-resizing');
    if(grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  }
  ['pointerup','pointercancel','lostpointercapture'].forEach(name => grip.addEventListener(name, finish));
  grip.addEventListener('keydown', event => {
    const delta = {'ArrowUp':-32, 'ArrowDown':32, 'PageUp':-160, 'PageDown':160}[event.key];
    if(delta !== undefined || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      remember(event.key === 'Home' ? min : event.key === 'End' ? max() : pane.getBoundingClientRect().height + delta);
    }
  });
  grip.addEventListener('dblclick', () => {
    preferred = null;
    try {localStorage.removeItem(key);} catch {}
    render();
  });
  window.addEventListener('resize', render);
  render();
});
