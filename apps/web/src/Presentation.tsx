import {FilePreviewWorkspace} from './FileChrome.tsx';
import { useMemo,useRef,useState } from 'react';
import type { DocumentView } from './api.ts';
import { assetUrl } from './api.ts';
import { slidesFor,nextSlide } from './presentation-model.ts';
import type { Labels } from './i18n.ts';
export default function Presentation({view,t}:{view:DocumentView;t:Labels}) {
  const slides=useMemo(()=>slidesFor(view),[view]), [selection,setSelection]=useState({documentId:view.document.id,index:0});
  const rail=useRef<HTMLDivElement>(null),active=selection.documentId===view.document.id?Math.min(selection.index,slides.length-1):0;
  function choose(index:number) {setSelection({documentId:view.document.id,index:Math.max(0,Math.min(index,slides.length-1))});rail.current?.querySelector<HTMLButtonElement>(`[data-slide="${index}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});}
  return <FilePreviewWorkspace title={view.document.title}><section className="presentation" aria-label={t.slides} tabIndex={0} onKeyDown={event=>{
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    const index=nextSlide(active,event.key,slides.length);
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key)){event.preventDefault();choose(index);}
  }}>
    <div className="slide-rail" ref={rail} aria-label={t.slides}>{slides.map((slide,index)=><button type="button" key={slide.index} data-slide={index} aria-label={`${t.slide} ${index+1}`} aria-current={active===index?'true':undefined} onClick={()=>choose(index)}>
      <img src={assetUrl(view,slide.thumbnail)} alt="" loading={index<4?'eager':'lazy'} decoding="async"/><span>{index+1}</span>
    </button>)}</div>
    <div className="slide-stage"><div className="slide-image"><img key={slides[active].image} src={assetUrl(view,slides[active].image)} alt={`${view.document.title} — ${t.slide} ${active+1}`} fetchPriority="high" decoding="async"/></div>
      <div className="slide-controls"><button type="button" aria-label={t.previous} disabled={active===0} onClick={()=>choose(active-1)}>←</button><span role="status">{active+1} {t.of} {slides.length}</span><button type="button" aria-label={t.next} disabled={active===slides.length-1} onClick={()=>choose(active+1)}>→</button></div>
    </div>
  </section></FilePreviewWorkspace>;
}
