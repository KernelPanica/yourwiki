/* Integrate the lazy font catalogue into CODE's font dropdown (same origin). */
(() => {
  let cataloguePromise;
  async function catalogue() {
    if(!cataloguePromise)cataloguePromise=(async()=>{
      const response=await window.yourwikiUI.request('/office/google-fonts.json');
      const data=await window.yourwikiUI.check(response);
      return [...new Set(['Times New Roman','Impact','Arimo','Tinos','Anton','Oswald','Cousine','Roboto','Open Sans',...data.families.map(f=>f.name)])];
    })().catch(error=>{cataloguePromise=null;throw error;});
    return cataloguePromise;
  }
  function attach(frame,writable) {
    if(!writable)return ()=>{};
    let doc;
    try{doc=frame.contentDocument;}catch{return ()=>{};}
    if(!doc?.body)return ()=>{};
    const selector='[id^="fontnamecombobox"].modalpopup';
    let dialog,disposed=false;
    function close(){dialog?.remove();dialog=null;frame.contentWindow?.postMessage(JSON.stringify({MessageId:'Grab_Focus',Values:{}}),location.origin);}
    function open() {
      if(dialog){dialog.querySelector('input').focus();return;}
      dialog=doc.createElement('dialog');
      dialog.setAttribute('aria-label','Добавить шрифт');
      dialog.style.cssText='width:min(420px,85vw);max-height:80vh;overflow:auto;border:1px solid #888;border-radius:12px;padding:20px;background:var(--color-main-background,#fff);color:var(--color-main-text,#202124);box-shadow:0 10px 40px #0005;font:14px sans-serif;';
      const heading=doc.createElement('h2');heading.textContent='Добавить шрифт';heading.style.marginTop='0';
      const label=doc.createElement('label');label.textContent='Название шрифта';
      const input=doc.createElement('input');input.type='search';input.id='yourwiki-font-search';input.maxLength=200;input.autocomplete='off';input.placeholder='Например, Anton';input.setAttribute('list','yourwiki-font-catalogue');
      input.style.cssText='display:block;box-sizing:border-box;width:100%;padding:10px;margin:8px 0 12px;background:inherit;color:inherit;border:1px solid #888;border-radius:6px;';label.htmlFor=input.id;
      const list=doc.createElement('datalist');list.id='yourwiki-font-catalogue';
      const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Загрузка каталога…';
      const actions=doc.createElement('div');actions.style.cssText='display:flex;gap:8px;flex-wrap:wrap;';
      const load=doc.createElement('button');load.type='button';load.textContent='Подключить';load.disabled=true;
      const dismiss=doc.createElement('button');dismiss.type='button';dismiss.textContent='Закрыть';dismiss.onclick=close;
      for(const button of [load,dismiss])button.style.cssText='padding:8px 14px;cursor:pointer;border:1px solid #888;border-radius:6px;background:inherit;color:inherit;';
      actions.append(load,dismiss);dialog.append(heading,label,input,list,status,actions);doc.body.append(dialog);
      const current=dialog;
      current.addEventListener('cancel',event=>{event.preventDefault();close();});
      current.showModal();input.focus();
      catalogue().then(names=>{
        if(disposed||dialog!==current)return;
        for(const name of names){const option=doc.createElement('option');option.value=name;list.append(option);}
        status.textContent='Выберите шрифт. Загрузится только выбранное семейство.';load.disabled=false;
      }).catch(error=>{if(dialog===current)status.textContent=error.message;});
      load.onclick=async()=>{
        if(!input.value.trim()){input.focus();return;}
        load.disabled=true;status.textContent='Подключение шрифта…';
        try {
          const body=new FormData(document.getElementById('office-heartbeat'));
          body.set('name',input.value.trim());body.set('document',frame.dataset.document);
          const response=await window.yourwikiUI.request('/office/fonts/activate/',{method:'POST',body});
          const data=await window.yourwikiUI.check(response);
          if(dialog===current)status.textContent=`${data.name}: сервер подключит шрифт в течение минуты. Если он не появился в списке, сохраните документ и откройте редактор заново.`;
        }catch(error){if(dialog===current)status.textContent=error.message;}
        finally{if(dialog===current)load.disabled=false;}
      };
      input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();if(!load.disabled)load.click();}});
    }
    function install(popup) {
      if(popup.querySelector('[data-yourwiki-add-font]'))return;
      const button=doc.createElement('button');button.type='button';button.dataset.yourwikiAddFont='';button.textContent='Add font…';button.title='Добавить шрифт из каталога';
      button.style.cssText='display:block;width:100%;text-align:left;padding:8px 12px;border:0;border-top:1px solid #8885;background:inherit;color:inherit;cursor:pointer;';
      button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();open();});
      button.addEventListener('pointerdown',event=>event.stopPropagation());
      popup.append(button);
    }
    doc.querySelectorAll(selector).forEach(install);
    const observer=new MutationObserver(records=>{
      for(const record of records)for(const node of record.addedNodes){
        if(node.nodeType!==1)continue;
        if(node.matches(selector))install(node);
        node.querySelectorAll(selector).forEach(install);
      }
    });
    observer.observe(doc.body,{childList:true,subtree:true});
    return ()=>{disposed=true;observer.disconnect();dialog?.remove();doc.querySelectorAll('[data-yourwiki-add-font]').forEach(button=>button.remove());};
  }
  window.yourwikiOfficeFonts={attach};
})();
