(() => {
 const frame=document.getElementById('drawio-preview');
 const endLoading=window.yourwikiLoading?.begin(frame);
 const timeout=setTimeout(()=>endLoading?.(),30000);
 const finish=()=>{clearTimeout(timeout);endLoading?.();};
 frame.addEventListener('error',finish,{once:true});
 const status=document.getElementById('drawio-preview-status');
 const xml=JSON.parse(document.getElementById('drawio-source').textContent);
 window.addEventListener('message',event=>{
  if(event.source!==frame.contentWindow || event.origin!==location.origin)return;
  if(event.data?.event==='viewer-ready')frame.contentWindow.postMessage({action:'show-diagram',xml},location.origin);
  if(event.data?.event==='diagram-ready'){finish();status.hidden=true;}
  if(event.data?.event==='diagram-error'){finish();status.hidden=false;status.textContent=window.gettext('Could not open the diagram. Download the original file to view it locally.');status.setAttribute('role','alert');}
 });
 frame.src='/static/wiki/drawio-viewer.html';
})();
