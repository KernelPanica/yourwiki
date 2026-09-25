import {boot,host,objects,readObjects,writeObjects,error,graphUndo} from './shared.js';

function cellData(node){return {tag:node.tagName,attrs:Object.fromEntries([...node.attributes].map(a=>[a.name,a.value])),text:node.firstChild?.nodeType===3?node.firstChild.nodeValue:null,tail:node.nextSibling?.nodeType===3?node.nextSibling.nodeValue:null,children:[...node.children].map(cellData)};}
function cellElement(value,doc){if(typeof value==='string')return doc.importNode(new DOMParser().parseFromString(value,'text/xml').documentElement,true);const element=doc.createElement(value.tag);for(const [k,v] of Object.entries(value.attrs||{}))element.setAttribute(k,v);if(value.text)element.append(doc.createTextNode(value.text));for(const child of value.children||[]){element.append(cellElement(child,doc));if(child.tail)element.append(doc.createTextNode(child.tail));}return element;}

function toXML(data){const doc=document.implementation.createDocument('','mxfile');for(const id of data.order||[]){const page=data.pages?.[id];if(!page)continue;const el=doc.createElement('diagram');el.setAttribute('id',id);el.setAttribute('name',page.name||'Page');const graph=doc.createElement('mxGraphModel');for(const [k,v] of Object.entries(page.attrs||{}))graph.setAttribute(k,v);const root=doc.createElement('root');for(const [cid,xml] of Object.entries(page.cells||{}).sort((a,b)=>(!['0','1'].includes(a[0]))-(!['0','1'].includes(b[0])))){root.append(cellElement(xml,doc));}graph.append(root);el.append(graph);doc.documentElement.append(el);}return new XMLSerializer().serializeToString(doc);}

export async function drawioEditor(){
  const undo=graphUndo();
  const frame=document.createElement('iframe');frame.className='drawio-frame';frame.title='draw.io diagram editor';
  frame.src='/static/drawio/index.html?embed=1&proto=json&spin=1&noSaveBtn=1&noExitBtn=1&offline=1&local=1&stealth=1&ui=kennedy&plugins=1';host.append(frame);
  let ui=null,applying=false,last=readObjects(),timer;
  function send(data){frame.contentWindow.postMessage(JSON.stringify(data),location.origin);}
  function capture(){if(applying||!boot.write||!ui)return;try{
    const win=frame.contentWindow;
    // getFileData with forceXml produces uncompressed, multipage XML.
    const xml=ui.getFileData(true,null,null,null,true);
    const parsed=new DOMParser().parseFromString(xml,'text/xml');const next={pages:{},order:[]};
    for(const page of parsed.querySelectorAll('diagram')){let model=page.querySelector('mxGraphModel');if(!model){const decoded=win.Graph.decompress(page.textContent);model=new DOMParser().parseFromString(decoded,'text/xml').documentElement;}
      const id=page.getAttribute('id');next.order.push(id);const cells={};for(const cell of model.querySelector('root').children){const cid=cell.getAttribute('id')||cell.querySelector('mxCell')?.getAttribute('id');if(cid)cells[cid]=cellData(cell);}next.pages[id]={name:page.getAttribute('name'),attrs:Object.fromEntries([...model.attributes].map(a=>[a.name,a.value])),cells};}
    if(next.order.length){writeObjects(next,last);last=structuredClone(next);}
  }catch(e){error(`Diagram synchronization failed: ${e.message}`);}}
  function attach(){ui=frame.contentWindow.yourwikiEditor;if(!ui){timer=setTimeout(attach,100);return;}ui.editor.graph.setEnabled(boot.write);ui.actions.get('undo').funct=()=>undo.undo();ui.actions.get('redo').funct=()=>undo.redo();ui.editor.graph.model.addListener(frame.contentWindow.mxEvent.CHANGE,()=>{if(!applying){clearTimeout(timer);timer=setTimeout(capture,120);}});ui.editor.addListener('pageSelected',()=>{if(!applying)capture();});setInterval(capture,1000);}
  window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin)return;let data;try{data=JSON.parse(event.data);}catch{return;}if(data.event==='init'){send({action:'load',xml:toXML(last),autosave:1});attach();}else if(data.event==='autosave')capture();});
  objects.observe(event=>{if(event.transaction.origin==='local')return;capture();const next=readObjects();last=structuredClone(next);if(!ui){send({action:'load',xml:toXML(next),autosave:1});return;}applying=true;try{const win=frame.contentWindow,graph=ui.editor.graph,selected=graph.getSelectionCells().map(c=>c.id),view={scale:graph.view.scale,x:graph.view.translate.x,y:graph.view.translate.y};ui.setFileData(toXML(next));graph.view.scaleAndTranslate(view.scale,view.x,view.y);graph.setSelectionCells(selected.map(id=>graph.model.getCell(id)).filter(Boolean));}finally{applying=false;}});
  return {setEditable:value=>ui?.editor.graph.setEnabled(value)};
}
