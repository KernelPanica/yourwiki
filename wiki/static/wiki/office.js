(() => {
  const boot=JSON.parse(document.getElementById('office-bootstrap').textContent);
  const frame=document.getElementById('office-frame'),status=document.getElementById('office-status');
  const t=window.gettext,recovery=document.getElementById('office-recovery');
  const conflictPanel=document.getElementById('office-conflict');
  function warnConflict(message){
    const firstConflict=!conflicted;conflicted=true;conflictPanel.hidden=false;show(message? t(message):t('Your changes will not be saved'),true);
    if(firstConflict){conflictPanel.scrollIntoView({block:'nearest'});conflictPanel.focus({preventScroll:true});}
  }
  const endLoading=window.yourwikiLoading?.begin(frame);
  let loaded=false,running=false,modified=false,conflicted=false,allowLeave=false;
  const show=(message,failed=false)=>{status.textContent=message;status.setAttribute('role',failed?'alert':'status');};
  const post=(MessageId,Values={})=>frame.contentWindow.postMessage(JSON.stringify({MessageId,Values}),boot.origin);
  let detachFontFocus=()=>{},detachFontCatalogue=()=>{};
  const attachFontFocus=()=>{detachFontFocus();detachFontCatalogue();detachFontCatalogue=window.yourwikiOfficeFonts.attach(frame,boot.write);detachFontFocus=window.yourwikiOfficeFontFocus.attach(frame,()=>post('Grab_Focus'),boot.write);};
  frame.addEventListener('load',attachFontFocus);
  window.addEventListener('pagehide',()=>{detachFontFocus();detachFontCatalogue();},{once:true});
  const leaveMessage=()=>t(conflicted
    ? 'The original document changed. Copy your changes to the clipboard or download the current copy before leaving. Leave without saving?'
    : 'Some changes have not been saved yet. Copy or download them before leaving. Leave without saving?');
  function leave(url){
    if((modified||conflicted)&&!window.confirm(leaveMessage()))return;
    allowLeave=true;location.assign(url);
  }
  // Only trust messages from this configured editor and this iframe.
  window.addEventListener('message',event=>{
    if(event.source!==frame.contentWindow||event.origin!==boot.origin)return;
    let message;try{message=typeof event.data==='string'?JSON.parse(event.data):event.data;}catch{return;}
    if(message?.MessageId==='App_LoadingStatus'&&message.Values?.Status==='Frame_Ready')post('Host_PostmessageReady');
    if(message?.MessageId==='App_LoadingStatus'&&message.Values?.Status==='Document_Loaded'){
      loaded=true;endLoading?.();attachFontFocus();
      if(!conflicted)show(t(boot.write?'Office editor ready. Changes save automatically.':'Office editor ready. View only.'));
      post('Host_PostmessageReady');
    }
    if(message?.MessageId==='Doc_ModifiedStatus')modified=message.Values?.Modified===true;
    if(message?.MessageId==='UI_Close')leave(document.querySelector('.document-actions a').href);
  });
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href]');
    if(!link||link.target==='_blank'||link.hasAttribute('download')||link===recovery||!link.href.startsWith(location.origin)||link.href.includes('/export'))return;
    if(modified||conflicted){event.preventDefault();leave(link.href);}
  });
  document.getElementById('office-download-current').addEventListener('click',()=>{if(boot.export!==false)post('Action_Export',{Format:boot.export_format});});
  document.getElementById('office-reload').addEventListener('click',()=>{
    if(!window.confirm(t('Discard current editor changes and open the remote original?')))return;
    allowLeave=true;location.reload();
  });
  async function heartbeat(){
    if(running)return;running=true;
    try{
      const body=new FormData(document.getElementById('office-heartbeat'));body.set('session',boot.session);
      const response=await window.yourwikiUI.request(boot.status,{method:'POST',body,headers:{Accept:'application/json'}});
      const data=await window.yourwikiUI.check(response);
      if(data.export===false&&boot.export!==false){
        boot.export=false;
        const download=document.getElementById('office-download-current');download.hidden=true;download.disabled=true;
        show(t('Export permission was removed. Save your work and reopen the editor to update its toolbar.'),true);
      }
      if(recovery)recovery.hidden=boot.export===false||!data.recovery;
      if(data.changed){
        if(!boot.write){allowLeave=true;location.reload();return;}
        warnConflict(data.error);
      }else if(data.error){warnConflict(data.error);}
      else if(boot.write&&!data.write){
        warnConflict('Editing permission was removed. Copy or download your changes before leaving.');
      }else if(loaded&&!conflicted)show(t(boot.write?'Office editor ready. Changes save automatically.':'Office editor ready. View only.'));
    }catch(error){show(error.userFacing?error.message:t('The action could not be completed. Your input has been kept.'),true);}finally{running=false;}
  }
  const timer=setInterval(heartbeat,(boot.interval||30)*1000);
  window.addEventListener('beforeunload',event=>{if(!allowLeave&&(modified||conflicted)){event.preventDefault();event.returnValue='';}});
  // Leaving never requests a save; pending/conflicting bytes remain recoverable.
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  document.getElementById('office-launch').submit();heartbeat();
  setTimeout(()=>{endLoading?.();if(!loaded&&!conflicted)show(t('The office editor is still loading. Check the Collabora connection.'),true);},30000);
})();
