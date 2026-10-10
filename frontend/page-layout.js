// Presentation only: stable document positions are never rewritten for pagination.
export const PAGE_HEIGHT=1123,PAGE_WIDTH=794,PAGE_MARGIN=72,PAGE_GAP=24;

export function paginate(segments,{height=PAGE_HEIGHT,margin=PAGE_MARGIN,gap=PAGE_GAP}={}){
  const body=height-margin*2,breaks=[];
  let used=0,page=1;
  for(const segment of segments){
    const size=Math.max(0,segment.height);
    if(used>0&&used+size>body+.5){
      breaks.push({pos:segment.pos,height:Math.max(0,body-used)+margin*2+gap,page:++page});
      used=0;
    }
    // An indivisible image/row can exceed a page; retain it rather than clip data.
    used+=size;
  }
  return {breaks,pages:page,bottom:Math.max(margin,body-used+margin)};
}
