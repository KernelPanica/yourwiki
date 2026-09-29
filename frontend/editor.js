import {t,format,Y,ydoc,boot,b64,unb64,error,queueReviewUpdate,button,dialog,api} from './shared.js';

const status=document.getElementById('sync-status');
let socket,dirty=false,pending=new Map(),counter=0,closed=false,editor;
function sendUpdate(update){const id=++counter;pending.set(id,update);dirty=true;status.textContent=t('Saving locally…');if(socket?.readyState===1)socket.send(JSON.stringify({type:'update',id,update:b64(update)}));}
ydoc.on('update',(update,origin)=>{if(origin==='remote'||!boot.write)return;if(queueReviewUpdate(update))return;sendUpdate(update);});
let reconnectTimer, saveRequested=false;
function connect(){
  status.textContent=dirty?t('Reconnecting… Your edits are kept in this tab'):t('Connecting…');
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/documents/${boot.id}/`);
  socket.onopen=()=>{status.textContent=t('Connected · saving…');for(const [id,update] of pending)socket.send(JSON.stringify({type:'update',id,update:b64(update)}));if(saveRequested){socket.send(JSON.stringify({type:'save'}));saveRequested=false;}};
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.type==='state'){
      Y.applyUpdate(ydoc,unb64(message.update),'remote');boot.write=message.write;
      editor?.setEditable?.(boot.write);document.querySelectorAll('[data-write]').forEach(el=>el.disabled=!boot.write);
      const presence=document.getElementById('presence');presence.replaceChildren();for(const name of [...new Set(message.peers)]){const chip=document.createElement('span');chip.className='presence-chip';chip.textContent=name;presence.append(chip);}
      if(!pending.size)status.textContent=message.sequence===message.synced_sequence?t('Synced to storage'):t('Saved locally · syncing to storage…');
    }else if(message.type==='ack'){pending.delete(message.id);dirty=pending.size>0;if(!dirty)status.textContent=t('Saved locally · syncing to storage…');}
    else if(message.type==='saved'){status.textContent=t('Saved to storage');}
    else if(message.type==='error')error(message.message);
    else if(message.type==='rejected'){closed=true;socket.close();editor?.setEditable?.(false);error(format('Changes were not saved: %(message)s Copy your changes before reloading.', {message:message.message}));status.textContent=t('Not saved');}
  };
  socket.onclose=()=>{if(closed)return;status.textContent=dirty?t('Disconnected · edits kept locally'):t('Reconnecting…');clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,2000);};
}
document.getElementById('save-live').onclick=()=>{if(socket?.readyState===1){status.textContent=t('Saving to storage…');socket.send(JSON.stringify({type:'save'}));}else{saveRequested=true;status.textContent=t('Reconnecting… Your edits are kept in this tab');connect();}};
document.getElementById('print-live').onclick=()=>window.print();
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();document.getElementById('save-live').click();}});
try{
  button('Rename',async()=>{const values=await dialog('Rename file',[['title','Title',boot.title]]);if(!values)return;const result=await api(`/api/docs/${boot.id}/metadata`,{method:'POST',body:JSON.stringify(values)});boot.title=result.title;document.querySelector('.live-heading a').textContent='← '+result.title;});
  const factories={document:()=>import('./rich.js').then(m=>m.richEditor),table:()=>import('./sheets.js').then(m=>m.sheetEditor),canvas:()=>import('./canvas.js').then(m=>m.canvasEditor),drawio:()=>import('./drawio.js').then(m=>m.drawioEditor)};
  editor=await (await factories[boot.kind]())();connect();
}catch(e){error(format('Editor could not start: %(message)s', {message:e.message}));console.error(e);}
