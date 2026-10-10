// Stable identities let provider operations move whole dimensions, including notes.
const sorted=axis=>Object.keys(axis).sort((a,b)=>axis[a]-axis[b]||a.localeCompare(b));
export function updateAxes(layout,id,params,newId=()=>crypto.randomUUID()) {
  if(!['sheet.mutation.insert-row','sheet.mutation.remove-rows','sheet.mutation.insert-col','sheet.mutation.remove-col','sheet.mutation.move-rows','sheet.mutation.move-columns'].includes(id))return;
  const isRow=id.includes('row'),axis=isRow?'rows':'cols',positions=layout[params.subUnitId]?.[axis];
  if(!positions)return;
  const keys=sorted(positions),startKey=isRow?'startRow':'startColumn',endKey=isRow?'endRow':'endColumn';
  if(id.includes('.move-')) {
    if(!params.sourceRange||!params.targetRange)return;
    const start=params.sourceRange[startKey],end=params.sourceRange[endKey],count=end-start+1;
    let destination=params.targetRange[startKey];
    if(destination>=start&&destination<=end+1)return;
    const moved=keys.splice(start,count);
    if(destination>start)destination-=count;
    // Reposition only the moved IDs, preserving other concurrent positions.
    const left=destination?positions[keys[destination-1]]:-1;
    const right=destination<keys.length?positions[keys[destination]]:left+count+1;
    moved.forEach((key,i)=>{positions[key]=left+(right-left)*(i+1)/(count+1);});
    return;
  }
  if(!params.range)return;
  const start=params.range[startKey],end=params.range[endKey],count=end-start+1;
  if(id.includes('remove')){
    const ids=keys.slice(start,start+count);
    for(const key of ids)delete positions[key];
  }
  else {
    const left=start?positions[keys[start-1]]:-1,right=start<keys.length?positions[keys[start]]:left+count+1;
    const ids=Array.from({length:count},()=>newId());
    for(let i=0;i<count;i++)positions[ids[i]]=left+(right-left)*(i+1)/(count+1);
  }
}


// Bind identity snapshots to Univer's actual undo items, not range-shaped guesses.
export function createAxisHistory({read,write,undo,redo}) {
  let snapshots=new WeakMap(),depth=0,root=null;
  return {
    before(command) {
      if(command.type!==0)return;
      if(depth++===0){
        const replay=command.id==='univer.command.undo'?'before':command.id==='univer.command.redo'?'after':null;
        const item=replay==='before'?undo():replay==='after'?redo():undo();
        root={replay,item,before:null,target:item?snapshots.get(item)?.[replay]:null};
      }
    },
    mutate(action) {
      if(root?.target)return;
      if(root&&!root.before)root.before=structuredClone(read());
      action();
    },
    after(command) {
      if(command.type!==0||depth===0||--depth)return;
      if(root.target)write(structuredClone(root.target));
      else if(!root.replay&&root.before){
        const item=undo(),after=read();
        if(item&&item!==root.item&&JSON.stringify(root.before)!==JSON.stringify(after))
          snapshots.set(item,{before:root.before,after:structuredClone(after)});
      }
      root=null;
    },
    reset(){snapshots=new WeakMap();depth=0;root=null;}
  };
}
