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

export function connectionGeometry(a,b,edge) {
  const anchor=(node,side)=>{
    const sides={top:[node.x+node.width/2,node.y,0,-1],right:[node.x+node.width,node.y+node.height/2,1,0],bottom:[node.x+node.width/2,node.y+node.height,0,1],left:[node.x,node.y+node.height/2,-1,0]};
    return sides[side]||sides.bottom;
  };
  const p=anchor(a,edge.fromSide||'bottom'),q=anchor(b,edge.toSide||'top');
  const bend=Math.max(40,Math.min(160,Math.hypot(q[0]-p[0],q[1]-p[1])/2));
  return {path:`M${p[0]},${p[1]} C${p[0]+p[2]*bend},${p[1]+p[3]*bend} ${q[0]+q[2]*bend},${q[1]+q[3]*bend} ${q[0]},${q[1]}`,x:(p[0]+q[0])/2,y:(p[1]+q[1])/2};
}

export function groupSelection(nodes,ids) {
  const result=new Set(ids);
  for(const id of ids){const group=nodes[id];if(group?.type!=='group')continue;
    for(const node of Object.values(nodes))if(node.x>=group.x&&node.y>=group.y&&node.x+node.width<=group.x+group.width&&node.y+node.height<=group.y+group.height)result.add(node.id);
  }
  return [...result];
}
