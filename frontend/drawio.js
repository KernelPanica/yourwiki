import {t,format,boot,host,objects,readObjects,writeObjects,error,graphUndo} from './shared.js';
import {diagramData,diagramXML as toXML} from './diagram-xml.js';

export async function drawioEditor(){
  const reportFrameError=event=>{console.error('Diagram action failed',event.error||event.reason);error(t('The action could not be completed. Your input has been kept.'));};
  const undo=graphUndo();
  const frame=document.createElement('iframe');frame.className='drawio-frame';frame.title=t('draw.io diagram editor');
  frame.src='/static/drawio/index.html?embed=1&proto=json&spin=1&noSaveBtn=1&noExitBtn=1&offline=1&local=1&stealth=1&ui=kennedy&plugins=1&lang='+encodeURIComponent(document.documentElement.lang);host.append(frame);
  let ui=null,applying=false,last=readObjects(),timer,presenceChanged=()=>{},remotePresence=[],presenceLayer;
  function paintPresence(){
    if(!ui)return;const graph=ui.editor.graph,doc=frame.contentDocument;
    if(!presenceLayer||!presenceLayer.isConnected){presenceLayer=doc.createElement('div');presenceLayer.className='graph-presence-layer';Object.assign(presenceLayer.style,{position:'absolute',left:'0',top:'0',pointerEvents:'none',zIndex:'100'});graph.container.append(presenceLayer);}
    presenceLayer.replaceChildren();
    for(const entry of remotePresence){if(entry.selection?.kind!=='graph')continue;const color=/^#[0-9a-f]{6}$/i.test(entry.color||'')?entry.color:'#2563eb';let labelled=false;
      for(const reference of entry.selection.node_ids||[]){let id=reference;try{const scoped=JSON.parse(reference);if(Array.isArray(scoped)){if(scoped[0]!==ui.currentPage?.getId())continue;id=scoped[1];}}catch{}const state=graph.view.getState(graph.model.getCell(id));if(!state)continue;const box=doc.createElement('div');box.className='remote-presence-selection';Object.assign(box.style,{position:'absolute',left:state.x+'px',top:state.y+'px',width:state.width+'px',height:state.height+'px',outline:`3px solid ${color}`,pointerEvents:'none'});presenceLayer.append(box);if(!labelled){const label=doc.createElement('span');label.className='remote-presence-cursor';label.textContent=entry.name;Object.assign(label.style,{position:'absolute',left:state.x+'px',top:(state.y-20)+'px',background:color,color:'#fff',fontSize:'12px',padding:'2px 5px',whiteSpace:'nowrap',pointerEvents:'none'});presenceLayer.append(label);labelled=true;}}
    }
  }
  function send(data){frame.contentWindow.postMessage(JSON.stringify(data),location.origin);}
  function capture(){if(applying||!boot.write||!ui)return;try{
    const win=frame.contentWindow;
    // getFileData with forceXml produces uncompressed, multipage XML.
    const xml=ui.getFileData(true,null,null,null,true);
    const next=diagramData(xml,{decompress:text=>win.Graph.decompress(text),previous:last});
    if(next.order.length){writeObjects(next,last);last=structuredClone(next);}
  }catch(e){error(format('Diagram synchronization failed: %(message)s', {message:e.message}));}}
  function attach(){ui=frame.contentWindow.yourwikiEditor;if(!ui){timer=setTimeout(attach,100);return;}ui.editor.graph.setEnabled(boot.write);ui.actions.get('undo').funct=()=>undo.undo();ui.actions.get('redo').funct=()=>undo.redo();ui.editor.graph.model.addListener(frame.contentWindow.mxEvent.CHANGE,()=>{if(!applying){clearTimeout(timer);timer=setTimeout(capture,120);}});ui.editor.graph.getSelectionModel().addListener(frame.contentWindow.mxEvent.CHANGE,()=>presenceChanged());for(const event of ['SCALE','TRANSLATE','SCALE_AND_TRANSLATE'])ui.editor.graph.view.addListener(frame.contentWindow.mxEvent[event],paintPresence);ui.editor.addListener('pageSelected',()=>{if(!applying)capture();presenceChanged();paintPresence();});setInterval(capture,1000);paintPresence();}
  window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin)return;let data;try{data=JSON.parse(event.data);}catch{return;}if(data.event==='init'){frame.contentWindow.addEventListener('error',reportFrameError);frame.contentWindow.addEventListener('unhandledrejection',reportFrameError);send({action:'load',xml:toXML(last),autosave:1});attach();}else if(data.event==='autosave')capture();});
  objects.observe(event=>{if(event.transaction.origin==='local')return;capture();const next=readObjects();last=structuredClone(next);if(!ui){send({action:'load',xml:toXML(next),autosave:1});return;}applying=true;try{const win=frame.contentWindow,graph=ui.editor.graph,selected=graph.getSelectionCells().map(c=>c.id),view={scale:graph.view.scale,x:graph.view.translate.x,y:graph.view.translate.y};ui.setFileData(toXML(next));graph.view.scaleAndTranslate(view.scale,view.x,view.y);graph.setSelectionCells(selected.map(id=>graph.model.getCell(id)).filter(Boolean));}finally{applying=false;}});
  return {flush:capture,setEditable:value=>ui?.editor.graph.setEnabled(value),getPresenceSelection:()=>({kind:'graph',node_ids:ui?.editor.graph.getSelectionCells().map(cell=>JSON.stringify([ui.currentPage?.getId()||'',String(cell.id)]))||[]}),setPresenceChange:callback=>{presenceChanged=callback;},renderPresence:entries=>{remotePresence=entries;paintPresence();}};
}
