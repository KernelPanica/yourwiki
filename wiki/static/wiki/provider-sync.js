(() => {
  const progress=document.getElementById('provider-sync-progress');
  if(!progress)return;
  const finish=document.getElementById('provider-setup-finish');
  const end=window.yourwikiLoading?.begin(progress);
  let stopped=false,timer;
  async function check(){
    if(stopped)return;
    try{
      const response=await fetch(progress.dataset.statusUrl,{cache:'no-store'});
      if(!response.ok)throw new Error();
      const state=await response.json();
      if(!state.pending){
        stopped=true;end?.();
        if(state.ready){
          finish.querySelector('button').disabled=false;
          if(progress.dataset.autofinish==='true')finish.requestSubmit();else location.reload();
        }else{
          progress.textContent='Не удалось подтвердить доступ в облаке. Повторите синхронизацию или обратитесь к администратору.';
          progress.setAttribute('role','alert');finish.querySelector('button').disabled=false;
        }
        return;
      }
    }catch{progress.textContent='Ожидаем подтверждения доступа. Проверка автоматически повторится.';}
    timer=setTimeout(check,2000);
  }
  timer=setTimeout(check,500);
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);end?.();},{once:true});
})();
