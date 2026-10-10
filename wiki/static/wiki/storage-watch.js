(() => {
  const watch=document.querySelector('[data-storage-watch]');
  if(!watch)return;
  let running=false;
  async function check(){
    if(document.hidden||running)return;
    running=true;
    try{
      const response=await fetch(`/api/docs/${watch.dataset.storageWatch}/storage-status`,{cache:'no-store'});
      if(!response.ok)return;
      const state=await response.json();
      if(state.revision!==Number(watch.dataset.revision))location.reload();
    }catch{/* Keep the current preview during a provider outage. */}
    finally{running=false;}
  }
  setInterval(check,30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void check();});
})();
