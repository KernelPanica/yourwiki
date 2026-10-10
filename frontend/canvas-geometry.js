export function positionedNodes(data) {
  return Object.fromEntries(Object.entries(data.nodes||{}).map(([id,node])=>{
    const position={...node};
    for(const axis of ['x','y'])position[axis]=Number(node[axis]||0)+Object.values(data.translations?.[id]||{}).reduce((sum,op)=>sum+Number(op[axis]||0),0);
    return [id,position];
  }));
}

export function translateNodes(data,ids,x,y,operationId) {
  if(!Number.isFinite(x)||!Number.isFinite(y)||(!x&&!y))return;
  data.translations||={};
  for(const id of ids)if(data.nodes?.[id]){
    data.translations[id]||={};
    data.translations[id][operationId]={x,y};
  }
}

export function anchoredZoom(pan,zoom,next,point) {
  return {zoom:next,pan:{x:point.x-(point.x-pan.x)*next/zoom,y:point.y-(point.y-pan.y)*next/zoom}};
}
