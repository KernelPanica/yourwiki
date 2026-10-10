(() => {
 const frame=document.getElementById('drawio-preview');
 const status=document.getElementById('drawio-preview-status');
 const xml=JSON.parse(document.getElementById('drawio-source').textContent);
 window.addEventListener('message',event=>{
  if(event.source!==frame.contentWindow || event.origin!==location.origin)return;
  if(event.data?.event==='viewer-ready')frame.contentWindow.postMessage({action:'show-diagram',xml},location.origin);
  if(event.data?.event==='diagram-ready')status.hidden=true;
  if(event.data?.event==='diagram-error'){status.hidden=false;status.textContent=window.gettext('Could not open the diagram. Download the original file to view it locally.');status.setAttribute('role','alert');}
 });
 frame.src='/static/wiki/drawio-viewer.html';
})();
