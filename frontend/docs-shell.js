import {t,boot,toolbar,host,button} from './shared.js';

// Keep the editor's existing command nodes: permissions and selection handling
// remain shared with the other editors.
export function docsShell(editor){
  const shell=document.createElement('section');shell.className='docs-page';shell.setAttribute('aria-label',t('Visual editor'));
  const layout=document.querySelector('.live-layout');layout.before(shell);shell.append(layout);
  const heading=document.querySelector('.live-heading');
  const menus=document.createElement('nav');menus.className='docs-menus';menus.setAttribute('aria-label',t('Document menu'));
  shell.prepend(menus);
  const pages=document.createElement('output');pages.id='document-page-count';pages.setAttribute('aria-live','polite');
  const closeMenus=()=>menus.querySelectorAll('details').forEach(d=>d.open=false);
  const menu=label=>{
    const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label==='Edit menu'&&t(label)===label?'Edit':t(label);
    const items=document.createElement('div');items.className='docs-menu-items';
    details.append(summary,items);menus.append(details);
    details.addEventListener('toggle',()=>{if(details.open)menus.querySelectorAll('details').forEach(d=>{if(d!==details)d.open=false;});});
    details.addEventListener('keydown',event=>{
      const buttons=[...items.querySelectorAll('button:not(:disabled),a,select:not(:disabled),input:not(:disabled)')];
      if(event.key==='Escape'){details.open=false;summary.focus();}
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();details.open=true;const i=buttons.indexOf(document.activeElement);buttons[(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
    });
    items.addEventListener('click',event=>{if(event.target.closest('button,a'))closeMenus();});return items;
  };
  document.addEventListener('click',event=>{if(!menus.contains(event.target))closeMenus();});
  const actions=document.getElementById('document-actions');
  const edit=menu('Edit menu');
  const editing=toolbar.querySelector('[data-group="Editing"] .document-tool-controls');
  editing.querySelectorAll('button').forEach(el=>{const copy=el.cloneNode(true);copy.onclick=()=>el.click();edit.append(copy);});
  const view=menu('View');
  const insert=menu('Insert');insert.append(toolbar.querySelector('[data-group="Insert"]'));
  const format=menu('Format');
  const formatting=toolbar.querySelector('[data-group="Formatting"] .document-tool-controls');
  const clear=[...formatting.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')===t('Clear formatting'));
  if(clear){const copy=clear.cloneNode(true);copy.onclick=()=>clear.click();format.append(copy);}
  const tools=menu('Tools');
  const find=[...editing.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')===t('Find / replace'));if(find)tools.append(find);
  const wordCount=document.createElement('output');wordCount.className='docs-word-count';wordCount.setAttribute('aria-label',t('Word count'));tools.append(wordCount);
  const countWords=()=>{const text=editor.state.doc.textBetween(0,editor.state.doc.content.size,' ');const words=text.trim()?text.trim().split(/\s+/u).length:0;wordCount.textContent=`${t('Words')}: ${words} · ${t('Characters')}: ${[...text].length}`;};editor.on('update',countWords);countWords();
  const review=document.getElementById('review-panel');review.hidden=true;shell.before(review);
  function toggle(label,target){const b=document.createElement('button');b.type='button';b.textContent=t(label);b.setAttribute('aria-pressed',String(!target.hidden));b.onclick=()=>{target.hidden=!target.hidden;b.setAttribute('aria-pressed',String(!target.hidden));};view.append(b);return b;}
  const comments=document.createElement('button');comments.type='button';comments.className='button';comments.textContent=t('Comments and suggestions');comments.setAttribute('aria-controls','review-panel');comments.setAttribute('aria-expanded','false');comments.onclick=()=>{review.hidden=!review.hidden;comments.setAttribute('aria-expanded',String(!review.hidden));};actions.insertBefore(comments,actions.querySelector('.more-menu'));
  const ruler=document.createElement('div');ruler.className='docs-ruler';ruler.setAttribute('aria-hidden','true');for(let i=0;i<7;i++){const tick=document.createElement('span');tick.textContent=String(i);ruler.append(tick);}host.before(ruler);toggle('Ruler',ruler);
  menus.append(pages);
  const zoom=document.createElement('select');zoom.setAttribute('aria-label',t('Zoom'));zoom.add(new Option(t('Page width'),'fit'));for(const value of [50,75,90,100,125,150,200]){const option=new Option(value+'%',String(value),value===100,value===100);zoom.add(option);}
  const applyZoom=()=>{const paper=host.querySelector('.tiptap');if(paper)paper.style.zoom=zoom.value==='fit'?Math.min(1,(host.clientWidth-32)/794):Number(zoom.value)/100;};
  zoom.onchange=applyZoom;editing.append(zoom);
  let narrowViewport=window.innerWidth<=800;
  if(narrowViewport){zoom.value='fit';applyZoom();}
  const resizeObserver=new ResizeObserver(()=>{const narrow=window.innerWidth<=800;if(narrow&&!narrowViewport)zoom.value='fit';narrowViewport=narrow;if(zoom.value==='fit')applyZoom();});resizeObserver.observe(host);editor.on('destroy',()=>resizeObserver.disconnect());
  const symbols={'Undo':'↶','Redo':'↷','Bold':'B','Italic':'I','Underline':'U','Strike':'S','Bullet list':'• ≡','Numbered list':'1. ≡'};
  for(const el of toolbar.querySelectorAll('button'))for(const [label,symbol] of Object.entries(symbols)){if(el.getAttribute('aria-label')===t(label)){el.textContent=symbol;el.dataset.command=label;}}
  const outline=document.createElement('aside');outline.className='docs-outline';outline.hidden=true;outline.setAttribute('aria-label',t('Document outline'));host.before(outline);toggle('Document outline',outline);
  const renderOutline=()=>{outline.replaceChildren();const title=document.createElement('h2');title.textContent=t('Document outline');outline.append(title);let count=0;editor.state.doc.descendants((node,pos)=>{if(node.type.name!=='heading')return;count++;const b=document.createElement('button');b.textContent=node.textContent;b.style.paddingLeft=`${node.attrs.level*12}px`;b.onclick=()=>editor.chain().setTextSelection(pos+1).focus().scrollIntoView().run();outline.append(b);});if(!count){const p=document.createElement('p');p.textContent=t('Headings appear here');outline.append(p);}};editor.on('update',renderOutline);renderOutline();
  const title=heading.querySelector('a');title.title=t('Back to file');
}
