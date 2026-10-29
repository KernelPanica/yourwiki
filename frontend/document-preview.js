import {loadDocumentFonts} from './google-fonts.js';
import {paginate,PAGE_HEIGHT,PAGE_MARGIN,PAGE_GAP} from './page-layout.js';
import './document-pages.css';

// Read-only page furniture never enters the saved document or its export.
const paper=document.querySelector('.paged-document');
if(paper){
  const fontsReady=loadDocumentFonts(paper,cause=>window.yourwikiUI?.show?.(new window.yourwikiUI.UIError(cause.message)));
  const endFontLoading=window.yourwikiLoading?.begin(paper);
  // Native rich_html renders its root document as a neutral div.
  if(paper.children.length===1&&paper.firstElementChild.tagName==='DIV'){
    const root=paper.firstElementChild;root.replaceWith(...root.childNodes);
  }
  let frame;
  const update=()=>{
    cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
      paper.querySelectorAll('.doc-page-gap').forEach(gap=>gap.remove());paper.normalize();
      const segments=[];
      for(const element of paper.children){
        const style=getComputedStyle(element),margin=(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);
        const height=element.getBoundingClientRect().height+margin;
        if(['P','H1','H2','H3','H4','H5','H6'].includes(element.tagName)&&height>PAGE_HEIGHT-2*PAGE_MARGIN){
          const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),lines=[];
          let text;
          while((text=walker.nextNode())){
            const rectAt=index=>{const range=document.createRange();range.setStart(text,index);range.setEnd(text,index+1);return range.getBoundingClientRect();};
            let offset=0;
            while(offset<text.length){
              const rect=rectAt(offset),previous=lines.at(-1);
              if(rect.height&&(!previous||Math.abs(previous.top-rect.top)>1))lines.push({pos:{text,offset},top:rect.top,height:Math.max(rect.height,parseFloat(style.lineHeight)||24)});
              let low=offset+1,high=text.length;
              while(low<high){const middle=Math.floor((low+high)/2);if(Math.abs(rectAt(middle).top-rect.top)<1)low=middle+1;else high=middle;}
              offset=low;
            }
          }
          if(lines.length){lines.at(-1).height+=margin;segments.push(...lines);continue;}
        }
        segments.push({pos:{element},height});
      }
      const result=paginate(segments);
      // Insert backwards so splitting a text node keeps all earlier offsets valid.
      for(const boundary of [...result.breaks].reverse()){
        const gap=document.createElement('span');gap.className='doc-page-gap';gap.style.height=boundary.height+'px';gap.style.setProperty('--page-band',Math.max(0,boundary.height-2*PAGE_MARGIN-PAGE_GAP)+PAGE_MARGIN+'px');gap.setAttribute('aria-hidden','true');
        const label=document.createElement('span');label.className='doc-page-label';label.textContent=paper.dataset.pageLabel+' '+boundary.page;gap.append(label);
        if(boundary.pos.element)boundary.pos.element.before(gap);
        else {const range=document.createRange();range.setStart(boundary.pos.text,boundary.pos.offset);range.collapse(true);range.insertNode(gap);}
      }
      paper.style.paddingBottom=result.bottom+'px';paper.dataset.pages=String(result.pages);
    });
  };
  window.addEventListener('resize',update);paper.addEventListener('load',update,true);document.fonts?.ready.then(update);
  fontsReady.then(update).finally(()=>endFontLoading?.());update();
}
