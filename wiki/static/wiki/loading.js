(() => {
  const active = new Set(), targets = new WeakMap();
  let timer, navigation;
  const panel = document.createElement('div');
  panel.className = 'loading-indicator';panel.hidden = true;
  panel.setAttribute('role', 'status');panel.setAttribute('aria-live', 'polite');
  const spinner = document.createElement('span');spinner.className='loading-spinner';spinner.setAttribute('aria-hidden','true');
  const label = document.createElement('span');
  label.textContent = window.gettext?.('Loading…') || 'Загрузка…';panel.append(spinner,label);
  document.body.append(panel);
  function update() {
    if (!active.size) {clearTimeout(timer);timer=null;panel.hidden=true;return;}
    if (!timer && panel.hidden) timer=setTimeout(()=>{timer=null;if(active.size)panel.hidden=false;},180);
  }
  function begin(target) {
    const token = {};active.add(token);update();
    if(target){let state=targets.get(target);if(!state){state={count:0,previous:target.getAttribute('aria-busy')};targets.set(target,state);}state.count++;target.setAttribute('aria-busy','true');}
    let ended=false;
    return () => {if(ended)return;ended=true;active.delete(token);if(target){const state=targets.get(target);if(--state.count===0){if(state.previous===null)target.removeAttribute('aria-busy');else target.setAttribute('aria-busy',state.previous);targets.delete(target);}}update();};
  }
  window.yourwikiLoading={begin};
  const originalFetch=window.fetch.bind(window);
  window.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);
    const method=(options?.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    const background=method==='GET'&&/\/reviews\/?$/.test(url.pathname)||/\/storage-status\/?$|\/office\/status\/?$|\/presence\/?$|\/comments\/?$|\/suggestions\/?$/.test(url.pathname);
    const end=background?()=>{}:begin();
    try{return await originalFetch(input,options);}finally{end();}
  };
  function startNavigation() {navigation?.();const end=begin();navigation=end;setTimeout(()=>{end();if(navigation===end)navigation=null;},15000);}
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a[href]');
    if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.hasAttribute('download')||(link.target&&link.target!=='_self'))return;
    const url=new URL(link.href,location.href);
    if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol)||url.pathname===location.pathname&&url.search===location.search)return;
    if(/\/export\/?$|\/download\/?$|\/history\/?$/.test(url.pathname))return;
    queueMicrotask(()=>{if(!event.defaultPrevented)startNavigation();});
  });
  document.addEventListener('submit',event=>{
    if(!event.target.getAttribute('target'))queueMicrotask(()=>{if(!event.defaultPrevented)startNavigation();});
  });
  window.addEventListener('pageshow',()=>{navigation?.();navigation=null;});
  window.addEventListener('error',()=>{navigation?.();navigation=null;},true);
})();
