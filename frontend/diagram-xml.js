// XML envelopes stay separate from editable cell maps, including mixed content.
const expanded=node=>node.namespaceURI?`{${node.namespaceURI}}${node.localName}`:node.nodeName;
export function elementData(node) {
  if(node.nodeType===8)return {tag:'#comment',text:node.data,tail:null,attrs:{},children:[]};
  if(node.nodeType===7)return {tag:'#pi',text:`${node.target} ${node.data}`,tail:null,attrs:{},children:[]};
  const value={tag:expanded(node),attrs:{},text:null,tail:null,children:[]};
  for(const attr of Array.from(node.attributes||[]))if(attr.namespaceURI!=='http://www.w3.org/2000/xmlns/')value.attrs[expanded(attr)]=attr.value;
  let previous=null;
  for(const child of Array.from(node.childNodes||[])){
    if(child.nodeType===3||child.nodeType===4){const target=previous||value,key=previous?'tail':'text';target[key]=(target[key]||'')+child.nodeValue;}
    else if([1,7,8].includes(child.nodeType)){previous=elementData(child);value.children.push(previous);}
  }
  return value;
}
const local=tag=>tag?.replace(/^\{[^}]+\}/,'');
const blank=tag=>({tag,attrs:{},text:null,tail:null,children:[]});

export function diagramData(xml,{parse=text=>new DOMParser().parseFromString(text,'text/xml'),decompress,previous}={}) {
  const parsed=parse(xml);
  if(parsed.getElementsByTagName('parsererror').length)throw new Error('Invalid diagram XML.');
  const envelope=elementData(parsed.documentElement),data={xml:structuredClone(envelope),pages:{},order:[]};
  const pages=local(envelope.tag)==='mxfile'?envelope.children.filter(child=>local(child.tag)==='diagram'):[envelope];
  const singleEnvelope=previous?.xml?.slot==='page'&&previous.order?.length===1&&pages.length===1;
  for(const [index,page] of pages.entries()){
    const id=singleEnvelope?previous.order[0]:page.attrs.id||`page-${index}`;
    if(data.pages[id])throw new Error('Duplicate diagram page identity.');
    let model=local(page.tag)==='mxGraphModel'?page:page.children.find(child=>local(child.tag)==='mxGraphModel');
    const template=structuredClone(page);
    if(!model&&page.text&&decompress){model=elementData(parse(decompress(page.text)).documentElement);template.text=null;template.children.unshift({slot:'model'});}
    if(!model)throw new Error('Invalid diagram page.');
    const root=model.children.find(child=>local(child.tag)==='root');
    if(!root)throw new Error('Invalid diagram root.');
    const rootTemplate=structuredClone(root),modelTemplate=structuredClone(model),cells={},order=[];
    root.children.forEach((cell,i)=>{
      const cid=cell.attrs?.id||cell.children?.find(child=>local(child.tag)==='mxCell')?.attrs?.id;
      if(!cid)return;
      if(cells[cid])throw new Error('Duplicate diagram cell identity.');
      cells[cid]=cell;order.push(cid);rootTemplate.children[i]={slot:'cell',id:cid};
    });
    modelTemplate.children[model.children.indexOf(root)]={slot:'root'};
    if(page!==model){const i=page.children.indexOf(model);if(i>=0)template.children[i]={slot:'model'};}
    const value={name:page.attrs.name||`Page ${index+1}`,attrs:model.attrs,cells,order,
      xml:page===model?{slot:'model'}:template,model:modelTemplate,root:rootTemplate};
    const old=previous?.pages?.[id];
    if(old){for(const field of ['xml','model','root'])value[field]=preserveEnvelope(old[field],value[field]);if(singleEnvelope&&old.xml?.slot==='model')value.xml=old.xml;value.attrs={...old.attrs,...value.attrs};}
    data.pages[id]=value;data.order.push(id);
    if(page===envelope)data.xml={slot:'page',id};
    else data.xml.children[envelope.children.indexOf(page)]={slot:'page',id};
  }
  if(previous?.xml)data.xml=singleEnvelope?previous.xml:preserveEnvelope(previous.xml,data.xml);
  return data;
}

// Draw.io may omit extension metadata when serializing. Keep that metadata,
// while page/cell slots remain authoritative so actual deletions stay deleted.
export function preserveEnvelope(old,next) {
  if(!old||!next||old.slot||next.slot||old.tag!==next.tag)return next;
  const text=(before,after)=>before?.trim()&&!after?.trim()?before:after??before;
  const result={...next,attrs:{...old.attrs,...next.attrs},text:text(old.text,next.text),tail:text(old.tail,next.tail)};
  result.children=[...(next.children||[])];
  const used=new Set(),same=(a,b)=>a.slot||b.slot?a.slot===b.slot&&a.id===b.id:a.tag===b.tag&&a.attrs?.id===b.attrs?.id;
  for(const [oldIndex,child] of (old.children||[]).entries()){
    if(child.slot)continue;
    const index=result.children.findIndex(candidate=>!used.has(candidate)&&!candidate.slot&&same(candidate,child));
    if(index<0){const nextOld=old.children.slice(oldIndex+1);const anchor=result.children.findIndex(candidate=>nextOld.some(value=>same(candidate,value)));const copy=structuredClone(child);result.children.splice(anchor<0?result.children.length:anchor,0,copy);used.add(copy);continue;}
    const merged=preserveEnvelope(child,result.children[index]);used.add(merged);result.children[index]=merged;
  }
  return result;
}

function fill(template,slot,values,order){
  const result=structuredClone(template),used=new Set();
  result.children=(result.children||[]).flatMap(child=>{
    if(child.slot!==slot)return [child];
    const key=child.id||slot;if(!values[key])return [];
    used.add(key);return [structuredClone(values[key])];
  });
  for(const key of order)if(values[key]&&!used.has(key)){result.children.push(structuredClone(values[key]));used.add(key);}
  return result;
}

export function diagramTree(data){
  const pages={};
  for(const id of data.order||[]){
    const page=data.pages?.[id];if(!page)continue;
    const cells=page.cells||{},order=[...new Set([...(page.order||[]),...Object.keys(cells)])];
    const root=fill(page.root||blank('root'),'cell',cells,order);
    const model=fill(page.model||blank('mxGraphModel'),'root',{root},['root']);
    model.attrs={...model.attrs,...page.attrs};
    if(page.xml?.slot==='model')pages[id]=model;
    else {const diagram=fill(page.xml||blank('diagram'),'model',{model},['model']);diagram.attrs={...diagram.attrs,id,name:page.name||'Page'};pages[id]=diagram;}
  }
  return data.xml?.slot==='page'?pages[data.xml.id]:fill(data.xml||blank('mxfile'),'page',pages,data.order||[]);
}

function nameParts(name){const match=/^\{([^}]+)\}(.*)$/.exec(name);return match?[match[1],match[2]]:[null,name];}
export function elementNode(value,doc){
  if(typeof value==='string')return doc.importNode(new DOMParser().parseFromString(value,'text/xml').documentElement,true);
  if(value.tag==='#comment')return doc.createComment(value.text||'');
  if(value.tag==='#pi'){const [target,...rest]=(value.text||'').split(' ');return doc.createProcessingInstruction(target,rest.join(' '));}
  const [namespace,name]=nameParts(value.tag),node=doc.createElementNS(namespace,name);
  for(const [key,text] of Object.entries(value.attrs||{})){const [ns,localName]=nameParts(key);node.setAttributeNS(ns,localName,String(text));}
  if(value.text!=null)node.appendChild(doc.createTextNode(value.text));
  for(const child of value.children||[]){node.appendChild(elementNode(child,doc));if(child.tail!=null)node.appendChild(doc.createTextNode(child.tail));}
  return node;
}
export function diagramXML(data){const doc=document.implementation.createDocument(null,null);doc.appendChild(elementNode(diagramTree(data),doc));return new XMLSerializer().serializeToString(doc);}
