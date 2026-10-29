(() => {
  for(const panel of document.querySelectorAll('[data-version-panel]')){
    if(panel.dataset.initialized)continue;panel.dataset.initialized='true';
    let loading=false;
    panel.addEventListener('toggle',async()=>{
      if(!panel.open||loading)return;loading=true;
      const status=panel.querySelector('[data-version-status]'),list=panel.querySelector('[data-version-list]');
      status.textContent='Загружаем историю…';
      try{
        const response=await window.yourwikiUI.request(panel.dataset.url,{headers:{Accept:'application/json'}});
        const data=await window.yourwikiUI.check(response);list.replaceChildren();
        status.textContent=data.versions.length?(data.enabled?'Сохранённые версии.':'Версионирование выключено. Ранее сохранённые версии доступны; текущее содержимое при восстановлении не попадёт в историю. Сначала скачайте текущий файл.'):'Сохранённых версий пока нет. Версионирование включает администратор в настройках сайта.';
        for(const version of data.versions){
          const row=document.createElement('div');row.className='version-row';
          const title=document.createElement('span');const date=new Date(version.saved_at);title.textContent=`Версия ${version.revision ?? version.index+1} · ${Number.isNaN(date.valueOf())?'Дата неизвестна':date.toLocaleString()}${version.author?' · '+version.author:''}`;row.append(title);
          const actions=document.createElement('div');actions.className='form-actions';
          for(const [label,url] of [['Просмотреть',version.view_url],['Скачать',version.download_url]]){if(!url)continue;const link=document.createElement('a');link.className='button';link.textContent=label;link.href=url;actions.append(link);}
          row.append(actions);list.append(row);
        }
      }catch(error){status.textContent=error.message||'Не удалось загрузить историю. Закройте и откройте панель для повторной попытки.';}
      finally{loading=false;}
    });
  }
})();
