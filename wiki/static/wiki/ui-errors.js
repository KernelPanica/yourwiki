(() => {
  const t=message=>window.gettext?.(message)||message;
  class UIError extends Error {constructor(message){super(t(message));this.userFacing=true;}}
  const messageFor=status=>({401:'Your session expired. Sign in again.',403:'Access denied or session expired. Reload the page and try again.',404:'This item is no longer available.',409:'The item changed. Review the current version before retrying.',413:'The file is too large. Choose a smaller file.',429:'Too many requests. Wait a moment and try again.',503:'Storage is temporarily unavailable. Your input has been kept.'}[status]||'The request could not be completed. Check whether the action finished before retrying.');
  function show(error,target){
    const message=error?.userFacing?error.message:t('The action could not be completed. Your input has been kept.');
    let box=target||document.getElementById('ui-error');
    if(!box){box=document.createElement('div');box.id='ui-error';box.className='ui-error';box.setAttribute('role','alert');box.tabIndex=-1;const text=document.createElement('span');text.dataset.errorMessage='';const close=document.createElement('button');close.type='button';close.className='icon-button';close.textContent='×';close.setAttribute('aria-label',t('Dismiss error'));close.onclick=()=>box.hidden=true;box.append(text,close);document.body.append(box);}
    (box.querySelector('[data-error-message]')||box).textContent=message;box.hidden=false;
    return message;
  }
  async function run(action,target){try{return await action();}catch(error){console.error('Yourwiki action failed',error);show(error?.userFacing?error:new UIError(error instanceof Error&&error.name==='Error'?error.message:'The action could not be completed. Your input has been kept.'),target);}}
  async function request(url,options={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
    try{return await fetch(url,{...options,signal:options.signal||controller.signal});}
    catch(error){throw new UIError(error.name==='AbortError'?'The request timed out. Check whether the action finished before retrying.':'Connection lost. Your input has been kept. Check whether the action finished before retrying.');}
    finally{clearTimeout(timer);}
  }
  async function payload(response){
    const contentType=response.headers.get('Content-Type')||'';
    if(contentType.includes('json')){
      try{const value=await response.json();if(!value||typeof value!=='object')throw new Error();return value;}catch{throw new UIError('The server returned an invalid response. Check whether the action finished before retrying.');}
    }
    const text=await response.text();
    if(!contentType.includes('html'))return {};
    const doc=new DOMParser().parseFromString(text,'text/html');
    const errors=[...doc.querySelectorAll('.errorlist li,[role="alert"],.login-card>p')].map(el=>el.textContent.trim()).filter(Boolean);
    const fields={};
    for(const list of doc.querySelectorAll('.errorlist')){
      const selector='input:not([type="hidden"])[name],select[name],textarea[name]';
      const input=(list.id&&doc.querySelector(`[aria-describedby~="${CSS.escape(list.id)}"]`))||(!list.parentElement.matches('form')&&list.parentElement.querySelector(selector))||list.nextElementSibling?.querySelector(selector);
      if(input)fields[input.name]=[...list.querySelectorAll('li')].map(item=>({message:item.textContent.trim()}));
    }
    return {error:errors.join(' '),errors:fields,page:doc};
  }
  async function check(response){
    const value=await payload(response);
    if(!response.ok){const message=response.headers.get('X-Yourwiki-Error')==='csrf'?'Your session expired. Reload the page before submitting again.':response.status>=500&&response.status!==503?messageFor(response.status):value.error||messageFor(response.status);const error=new UIError(message);error.fields=value.errors;throw error;}
    return value;
  }
  window.yourwikiUI={UIError,show,run,request,check,messageFor};
  window.addEventListener('error',event=>{if(event.error){console.error('Yourwiki UI error',event.error);show(new UIError('The action could not be completed. Your input has been kept.'));}else if(event.target instanceof HTMLElement&&event.target.matches('img[src],script[src],iframe[src]'))show(new UIError('A preview or interface component could not be loaded. Reload the page or download the original file.'));},true);
  window.addEventListener('unhandledrejection',event=>{console.error('Yourwiki UI promise failed',event.reason);show(new UIError('The action could not be completed. Your input has been kept.'));event.preventDefault();});
  document.addEventListener('submit',async event=>{
    const form=event.target;
    if(event.defaultPrevented||!(form instanceof HTMLFormElement)||form.method.toLowerCase()!=='post'||form.target||form.dataset.nativeSubmit!==undefined)return;
    const url=new URL(form.action,location.href);
    // OAuth redirects must be performed by browser navigation, not Fetch.
    if(url.origin!==location.origin||/\/account\/providers\/[^/]+\/connect\/$/.test(url.pathname)||['/login','/login/','/logout/','/mounts/','/storage/'].includes(url.pathname)||url.pathname.startsWith('/invite/'))return;
    event.preventDefault();
    if(form.dataset.submitting)return;
    let body;
    try{body=new FormData(form,event.submitter);}catch(error){show(new UIError('The action could not be completed. Your input has been kept.'));return;}
    const buttons=[...form.querySelectorAll('button,input[type="submit"]')].map(button=>[button,button.disabled]);
    form.dataset.submitting='true';form.setAttribute('aria-busy','true');buttons.forEach(([button])=>button.disabled=true);
    form.querySelectorAll('.ui-field-error').forEach(el=>el.remove());form.querySelectorAll('[aria-invalid]').forEach(el=>el.removeAttribute('aria-invalid'));
    try{
      const response=await request(url,{method:'POST',body,headers:{Accept:'application/json'}});
      const result=await check(response);
      form.dispatchEvent(new Event('yourwiki:form-success'));
      if(!response.redirected&&result.page){
        const next=result.page.querySelector('#main-content'),current=document.getElementById('main-content');
        if(next&&current){current.replaceChildren(...next.childNodes);return;}
      }
      const destination=new URL(result.url||response.url||url,location.href);
      if(destination.origin!==location.origin)throw new UIError('The server returned an invalid response. Check whether the action finished before retrying.');
      location.assign(destination.href);
    }catch(error){
      show(error);
      if(error.fields)for(const [name,errors]of Object.entries(error.fields)){
        const input=form.elements.namedItem(name);if(!(input instanceof HTMLElement))continue;
        input.setAttribute('aria-invalid','true');const text=document.createElement('p');text.className='ui-field-error';text.setAttribute('role','alert');text.textContent=errors.map(item=>item.message).join(' ');input.after(text);
      }
    }finally{delete form.dataset.submitting;form.removeAttribute('aria-busy');buttons.forEach(([button,disabled])=>button.disabled=disabled);}
  });
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href]');
    if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const url=new URL(link.href,location.href);
    if(url.origin!==location.origin||!/^\/documents\/[^/]+\/(export|history\/[^/]+\/download)\//.test(url.pathname)||url.searchParams.get('inline')==='1')return;
    event.preventDefault();if(link.dataset.downloading)return;link.dataset.downloading='true';link.setAttribute('aria-busy','true');
    void run(async()=>{
      const response=await request(url,{headers:{Accept:'application/json'}});
      if(!response.ok){await check(response);return;}
      if(response.redirected||response.headers.get('Content-Type')?.includes('html'))throw new UIError('Your session expired. Sign in again.');
      const blob=await response.blob(),objectURL=URL.createObjectURL(blob),download=document.createElement('a');
      const disposition=response.headers.get('Content-Disposition')||'';
      const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition),plain=/filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
      let name=plain?.[1]||plain?.[2]||'download';if(encoded)try{name=decodeURIComponent(encoded[1]);}catch{}
      download.download=name.split(/[\\/]/).at(-1);download.href=objectURL;download.click();setTimeout(()=>URL.revokeObjectURL(objectURL),60000);
    }).finally(()=>{delete link.dataset.downloading;link.removeAttribute('aria-busy');});
  });
})();
