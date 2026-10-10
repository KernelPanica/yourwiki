import {Extension} from '@tiptap/core';
import {Plugin,PluginKey} from '@tiptap/pm/state';
import {Decoration,DecorationSet} from '@tiptap/pm/view';
import {paginate,PAGE_HEIGHT,PAGE_MARGIN,PAGE_GAP} from './page-layout.js';
import './document-pages.css';

const key=new PluginKey('documentPages');

// Measure wrapped lines in logarithmic probes per line, without changing text.
function textLines(view,element,scale){
  const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT,{acceptNode(node){
    return node.parentElement.closest('.doc-page-gap,.remote-presence-cursor')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;
  }}),lines=[];
  let text;
  while((text=walker.nextNode())){
    const rectAt=index=>{const range=document.createRange();range.setStart(text,index);range.setEnd(text,index+1);return range.getBoundingClientRect();};
    let offset=0;
    while(offset<text.length){
      const rect=rectAt(offset);
      if(rect.height){
        const pos=view.posAtDOM(text,offset);
        const last=lines.at(-1);
        if(!last||Math.abs(last.top-rect.top)>1)lines.push({pos,top:rect.top,height:rect.height/scale});
        else last.height=Math.max(last.height,rect.height/scale);
      }
      let low=offset+1,high=text.length;
      while(low<high){const middle=Math.floor((low+high)/2);if(Math.abs(rectAt(middle).top-rect.top)<1)low=middle+1;else high=middle;}
      offset=low;
    }
  }
  return lines;
}

function measure(view){
  const paper=view.dom,scale=paper.getBoundingClientRect().width/paper.offsetWidth||1,segments=[];
  view.state.doc.forEach((node,pos)=>{
    const element=view.nodeDOM(pos);
    if(!(element instanceof HTMLElement))return;
    const style=getComputedStyle(element),margin=(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);
    const gaps=[...element.querySelectorAll('.doc-page-gap')].reduce((sum,gap)=>sum+gap.getBoundingClientRect().height/scale,0);
    const height=element.getBoundingClientRect().height/scale-gaps+margin;
    if(node.isTextblock&&height>PAGE_HEIGHT-2*PAGE_MARGIN){
      const lines=textLines(view,element,scale);
      if(lines.length){
        const lineHeight=parseFloat(style.lineHeight)||24;
        for(const [index,line] of lines.entries())segments.push({pos:line.pos,height:Math.max(line.height,lineHeight)+(index===lines.length-1?margin:0)});
        return;
      }
    }
    segments.push({pos,height});
  });
  return paginate(segments);
}

export function documentPages(t){
  return Extension.create({name:'documentPages',addProseMirrorPlugins(){return [new Plugin({
    key,state:{init:()=>({decorations:DecorationSet.empty,signature:''}),apply(tr,previous){
      return tr.getMeta(key)||{...previous,decorations:previous.decorations.map(tr.mapping,tr.doc)};
    }},props:{decorations(state){return key.getState(state).decorations;}},
    view(view){
      let frame,destroyed=false;
      const update=()=>{
        cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
          if(destroyed||view.composing)return;
          const result=measure(view),signature=JSON.stringify(result);
          if(signature===key.getState(view.state).signature)return;
          const decorations=result.breaks.map(boundary=>Decoration.widget(boundary.pos,()=>{
            const gap=document.createElement('span');gap.className='doc-page-gap';gap.contentEditable='false';
            gap.style.height=boundary.height+'px';gap.style.setProperty('--page-band',Math.max(0,boundary.height-2*PAGE_MARGIN-PAGE_GAP)+PAGE_MARGIN+'px');
            gap.setAttribute('aria-hidden','true');gap.dataset.page=String(boundary.page);
            const label=document.createElement('span');label.className='doc-page-label';label.textContent=t('Page')+' '+boundary.page;gap.append(label);return gap;
          },{side:-1,key:'page-'+boundary.page,ignoreSelection:true}));
          view.dom.style.paddingBottom=result.bottom+'px';view.dom.dataset.pages=String(result.pages);
          const indicator=document.getElementById('document-page-count');if(indicator)indicator.textContent=t('Pages')+': '+result.pages;
          view.dispatch(view.state.tr.setMeta(key,{decorations:DecorationSet.create(view.state.doc,decorations),signature}).setMeta('addToHistory',false));
        });
      };
      const resize=new ResizeObserver(update);resize.observe(view.dom);
      view.dom.addEventListener('load',update,true);document.fonts?.ready.then(update);update();
      return {update(view,previous){if(!view.state.doc.eq(previous.doc))update();},destroy(){destroyed=true;cancelAnimationFrame(frame);resize.disconnect();view.dom.removeEventListener('load',update,true);}};
    }
  })];}});
}
