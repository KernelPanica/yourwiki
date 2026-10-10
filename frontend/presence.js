import {boot, host, t} from './shared.js';

// A page session survives socket reconnects, while separate tabs remain distinct.
export function createPresence(getEditor, send) {
  const sessionId = crypto.randomUUID();
  let entries = [], lastSelection = '', selectionTimer, renderFrame;
  function publish(force = false) {
    let selection;
    try { selection = getEditor()?.getPresenceSelection?.() || {}; }
    catch { return; } // Editor may be rebuilding after a remote structural edit.
    const signature = JSON.stringify(selection);
    if (!force && signature === lastSelection) return;
    if (send({type: 'presence', session_id: sessionId, selection})) lastSelection = signature;
  }
  function changed() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => publish(), 120);
  }
  function render() {
    const active = entries.filter(entry => Date.parse(entry.expires_at) > Date.now());
    const chips = document.getElementById('presence');
    if (chips) {
      chips.replaceChildren();
      for (const entry of active) {
        const chip = document.createElement('span');
        chip.className = 'presence-chip'; chip.dataset.sessionId = entry.id;
        chip.textContent = entry.name;
        chip.style.border = `2px solid ${entry.color}`;
        chip.title = entry.id === sessionId ? `${entry.name} · ${t('You')}` : entry.name;
        chips.append(chip);
      }
    }
    getEditor()?.renderPresence?.(active.filter(entry => entry.id !== sessionId));
  }
  function scheduleRender() {
    cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(render);
  }
  const heartbeat = setInterval(() => publish(true), 10000);
  const expiry = setInterval(render, 1000);
  document.addEventListener('selectionchange', changed);
  host.addEventListener('pointerup', changed);
  host.addEventListener('keyup', changed);
  host.addEventListener('focusout', changed);
  document.addEventListener('scroll', scheduleRender, true);
  window.addEventListener('resize', scheduleRender);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) publish(true); });
  window.addEventListener('pagehide', () => { clearInterval(heartbeat); clearInterval(expiry); });
  return {
    attach() { getEditor()?.setPresenceChange?.(changed); publish(true); },
    connected() { lastSelection = ''; publish(true); },
    update(sessions) { entries = sessions; render(); },
    disconnected() { entries = []; render(); },
  };
}
