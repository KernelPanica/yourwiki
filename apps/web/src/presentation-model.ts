import type { DocumentView } from './api.ts';
import { ApiError } from './api.ts';
export interface Slide { index:number;image:string;thumbnail:string }
export function slidesFor(view:Pick<DocumentView,'presentation'>&{manifest:Pick<DocumentView['manifest'],'artifacts'>}):Slide[] {
  const value=view.presentation as {schemaVersion?:number;slides?:unknown[]}|null;
  if(value?.schemaVersion!==1||!Array.isArray(value.slides)||!value.slides.length||value.slides.length>500)throw new ApiError('INVALID_PREVIEW');
  const images=new Set(view.manifest.artifacts.filter(item=>item.mimeType==='image/png').map(item=>item.name));
  return value.slides.map((raw,index)=>{
    const slide=raw as Slide;
    if(slide.index!==index+1||!images.has(slide.image)||!images.has(slide.thumbnail))throw new ApiError('INVALID_PREVIEW');
    return slide;
  });
}
export function nextSlide(current:number,key:string,count:number):number {
  if(key==='Home')return 0;
  if(key==='End')return count-1;
  if(['ArrowRight','ArrowDown','PageDown'].includes(key))return Math.min(count-1,current+1);
  if(['ArrowLeft','ArrowUp','PageUp'].includes(key))return Math.max(0,current-1);
  return current;
}
