const key='yourwiki.layout.file-sidebar';
const defaultWidth=()=>typeof matchMedia==='function'&&matchMedia('(min-width:1200px)').matches?400:320;
export function readFilePanel():{open:boolean;width:number}{try{const value=JSON.parse(localStorage.getItem(key)??'{}');return {open:typeof value.open==='boolean'?value.open:true,width:typeof value.width==='number'&&Number.isFinite(value.width)?Math.max(280,Math.min(400,value.width)):defaultWidth()};}catch{return {open:true,width:defaultWidth()};}}
export function saveFilePanel(value:Partial<{open:boolean;width:number}>){try{localStorage.setItem(key,JSON.stringify({...readFilePanel(),...value}));}catch{/* Layout stays usable with storage disabled. */}}
