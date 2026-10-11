import {t,format,Y,ydoc,boot,b64,unb64,error,queueReviewUpdate,button,dialog,api,readObjects} from './shared.js';
import {createPresence} from './presence.js';

const status=document.getElementById('sync-status');
const saveButton=document.getElementById('save-live');
let socket,dirty=false,pending=new Map(),counter=0,closed=false,editor;
let reconnectTimer,saveTimer,saveRequested=false,conflicted=false,remotePending=false,unknown=false;
const presence=createPresence(()=>editor,message=>{if(socket?.readyState!==1)return false;socket.send(JSON.stringify(message));return true;});
let lastAckSequence=boot.sequence||0,lastSyncedSequence=0;
function conflict(message){
  const firstConflict=!conflicted;
  conflicted=true;remotePending=true;clearTimeout(saveTimer);saveButton.disabled=true;
  const banner=document.getElementById('save-conflict');banner.hidden=false;
  if(firstConflict){banner.scrollIntoView({block:'nearest'});banner.focus({preventScroll:true});}
  status.textContent=t('Conflict · automatic saving paused');
  if(message)error(message);
}
function pauseUnknown(message){unknown=true;remotePending=true;clearTimeout(saveTimer);status.textContent=t('Write result unknown · automatic saving paused');if(message)error(message);}
function confirmWrite(){if(unknown)document.getElementById('editor-error').hidden=true;unknown=false;}
function scheduleSave(){clearTimeout(saveTimer);if(!conflicted&&!unknown&&boot.write)saveTimer=setTimeout(()=>saveNow(),1500);}
function sendUpdate(update){
  const id=++counter;pending.set(id,update);dirty=true;remotePending=true;
  document.getElementById('conflict-copy-status').textContent='';
  status.textContent=t(conflicted?'Conflict · automatic saving paused':unknown?'Write result unknown · automatic saving paused':'Saving locally…');
  if(!conflicted&&socket?.readyState===1)socket.send(JSON.stringify({type:'update',id,update:b64(update),generation:boot.generation}));
  scheduleSave();
}
ydoc.on('update',(update,origin)=>{if(origin==='remote'||!boot.write)return;if(queueReviewUpdate(update))return;sendUpdate(update);});
function updateSaved(sequence){
  if(unknown)return;
  lastSyncedSequence=Math.max(lastSyncedSequence,sequence||0);
  if(!pending.size && lastSyncedSequence>=lastAckSequence){dirty=false;remotePending=false;status.textContent=t('Saved to storage');}
}
function connect(){
  if(closed||socket?.readyState===0||socket?.readyState===1)return;
  status.textContent=dirty?t('Reconnecting… Your edits are kept in this tab'):t('Connecting…');
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/documents/${boot.id}/`);
  socket.onopen=()=>{status.textContent=t('Connected · saving…');presence.connected();/* Wait for state before replay: it may contain a conflict. */};
  let initialized=false;
  const receiveMessage=event=>{
    const message=JSON.parse(event.data);
    if(message.type==='state'){
      if(message.generation!==boot.generation){
        if(dirty||pending.size||remotePending||conflicted||unknown){conflict(t('The original changed. Download your edits before reloading.'));return;}
        closed=true;socket.close();location.reload();return;
      }
      if(message.save_state==='conflict')conflict(message.save_error);
      if(message.save_state==='unknown')pauseUnknown(message.save_error);
      else if(message.save_state==='saved')confirmWrite();
      if(message.save_state==='denied') {error(message.save_error);remotePending=true;}
      Y.applyUpdate(ydoc,unb64(message.update),'remote');boot.write=message.write;
      editor?.setEditable?.(boot.write);document.querySelectorAll('[data-write]').forEach(el=>el.disabled=!boot.write);
      saveButton.disabled=!boot.write||conflicted;
      remotePending=conflicted||unknown||message.sequence!==message.synced_sequence;
      if(!conflicted&&!unknown&&message.save_state!=='denied'){
        if(message.save_state==='failed'){status.textContent=t('Saved locally · storage unavailable');error(message.save_error);}
        else if(!pending.size){lastAckSequence=Math.max(lastAckSequence,message.sequence);if(!remotePending)updateSaved(message.synced_sequence);else status.textContent=t('Saved locally · syncing to storage…');}
      }
      if(!initialized){initialized=true;if(!conflicted&&boot.write){for(const [id,update] of pending)socket.send(JSON.stringify({type:'update',id,update:b64(update),generation:boot.generation}));if(saveRequested){saveRequested=false;saveNow(true);}}}
    }else if(message.type==='presence'){presence.update(message.sessions);}
    else if(message.type==='presence-error'){console.warn(message.message);}
    else if(message.type==='unknown'){pauseUnknown(message.message);}
    else if(message.type==='ack'){
      pending.delete(message.id);lastAckSequence=Math.max(lastAckSequence,message.sequence);dirty=pending.size>0;remotePending=conflicted||lastAckSequence>lastSyncedSequence;
      if(!conflicted&&!unknown){status.textContent=t('Saved locally · syncing to storage…');if(lastSyncedSequence>=lastAckSequence)updateSaved(lastSyncedSequence);}
    }else if(message.type==='saved'){confirmWrite();if(!conflicted)updateSaved(message.synced_sequence);}
    else if(message.type==='conflict')conflict(message.message);
    else if(message.type==='error'){error(message.message);remotePending=true;}
    else if(message.type==='rejected'){closed=true;socket.close();editor?.setEditable?.(false);error(format('Changes were not saved: %(message)s Copy your changes before reloading.',{message:message.message}));status.textContent=t('Not saved');}
  };
  socket.onmessage=event=>{try{receiveMessage(event);}catch(e){error(t('The server returned an invalid response. Check whether the action finished before retrying.'));socket.close();}};
  socket.onerror=()=>{error(t('Connection lost. Your input has been kept. Check whether the action finished before retrying.'));};
  socket.onclose=()=>{presence.disconnected();if(closed)return;status.textContent=conflicted?t('Conflict · automatic saving paused'):unknown?t('Write result unknown · automatic saving paused'):dirty?t('Disconnected · edits kept locally'):t('Reconnecting…');clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,2000);};
}
function saveNow(manual=false){
  editor?.flush?.();
  if(conflicted||!boot.write||(unknown&&!manual))return;
  clearTimeout(saveTimer);
  if(socket?.readyState===1){status.textContent=t('Saving to storage…');socket.send(JSON.stringify({type:'save'}));}
  else{saveRequested=manual;connect();}
}
saveButton.onclick=()=>saveNow(true);
document.getElementById('print-live').onclick=()=>window.yourwikiUI.run(()=>window.print(),document.getElementById('editor-error'));
// Leaving only warns: never submit or flush edits as a navigation side effect.
window.addEventListener('beforeunload',event=>{if(dirty||remotePending||conflicted||unknown){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();saveNow(true);}});
function localSnapshot(){editor?.flush?.();return JSON.stringify({format:'yourwiki-recovery',version:1,kind:boot.kind,file_format:boot.file_format,state:b64(Y.encodeStateAsUpdate(ydoc))});}
function downloadSnapshot(){const url=URL.createObjectURL(new Blob([localSnapshot()],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=boot.title+'.recovery.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
document.getElementById('conflict-copy').onclick=()=>window.yourwikiUI.run(async()=>{try{await navigator.clipboard.writeText(editor?.getText?.()||localSnapshot());document.getElementById('conflict-copy-status').textContent=t('Copied');}catch{downloadSnapshot();error(t('Clipboard unavailable. A local snapshot was downloaded.'));}},document.getElementById('editor-error'));
document.getElementById('conflict-download').onclick=()=>window.yourwikiUI.run(downloadSnapshot,document.getElementById('editor-error'));
document.getElementById('conflict-save-copy').onclick=async()=>{
  try{const values=await dialog('Save a copy',[['title','Title',boot.title+' (copy)']]);if(!values)return;editor?.flush?.();const result=await api(`/api/docs/${boot.id}/recover`,{method:'POST',body:JSON.stringify({action:'copy',title:values.title,update:b64(Y.encodeStateAsUpdate(ydoc))})});closed=true;dirty=false;remotePending=false;conflicted=false;socket?.close();location.assign(result.url);}catch(e){error(e.message);}
};
document.getElementById('conflict-reload').onclick=async()=>{
  if(!window.confirm(t('Discard local changes and reload the original? Other active editors must be closed.')))return;
  closed=true;clearTimeout(reconnectTimer);clearTimeout(saveTimer);
  if(socket&&socket.readyState!==3)await new Promise(resolve=>{socket.addEventListener('close',resolve,{once:true});socket.close();setTimeout(resolve,2000);});
  try{await api(`/api/docs/${boot.id}/recover`,{method:'POST',body:JSON.stringify({action:'reload',discard:true})});dirty=false;remotePending=false;conflicted=false;location.reload();}catch(e){error(e.message);closed=false;connect();}
};
const endEditorLoading=window.yourwikiLoading?.begin(document.getElementById('visual-editor'));
try{
  button('Rename',async()=>{const values=await dialog('Rename file',[['title','Title',boot.title]]);if(!values)return;const result=await api(`/api/docs/${boot.id}/metadata`,{method:'POST',body:JSON.stringify(values)});boot.title=result.title;document.querySelector('.live-heading a span').textContent=result.title;document.title=result.title+' — Yourwiki';},{parent:document.querySelector('[data-secondary-actions]')});
  const factories={document:()=>import('./rich.js').then(m=>m.richEditor),table:()=>import('./sheets.js').then(m=>m.sheetEditor),canvas:()=>import('./canvas.js').then(m=>m.canvasEditor),drawio:()=>import('./drawio.js').then(m=>m.drawioEditor)};
  editor=await (await factories[boot.kind]())();presence.attach();connect();
}catch(e){error(format('Editor could not start: %(message)s',{message:e.message}));console.error(e);}finally{endEditorLoading?.();}
