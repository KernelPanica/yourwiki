let cataloguePromise;
const loaded=new Map();
export function catalogue(){
  return cataloguePromise||=(async()=>{const response=await fetch('/office/google-fonts.json',{headers:{Accept:'application/json'}});if(!response.ok)throw Error('Не удалось загрузить каталог шрифтов.');return (await response.json()).families;})().catch(error=>{cataloguePromise=null;throw error;});
}
export async function loadGoogleFont(name){
  name=name.replace(/^['"]|['"]$/g,'');
  if(loaded.has(name))return loaded.get(name);
  const promise=(async()=>{const family=(await catalogue()).find(item=>item.name===name);if(!family)return;
    await Promise.all(family.fonts.map(async font=>{const face=new FontFace(name,`url("${font.url}")`,{style:font.style,weight:font.weight});await face.load();document.fonts.add(face);}));
  })();loaded.set(name,promise);
  try{await promise;}catch(error){loaded.delete(name);throw Error(`Не удалось загрузить шрифт ${name}. Повторите выбор.`);}
}
export async function extendFontSelector(select,onError){
  select.classList.add('google-font-control');
  try{const existing=new Set([...select.options].map(option=>option.value));for(const family of await catalogue()){if(!existing.has(family.name)){select.add(new Option(family.name,family.name));existing.add(family.name);}}}
  catch(error){onError(error);}
}
export async function loadDocumentFonts(root,onError){
  const names=new Set();for(const element of root.querySelectorAll('[style*="font-family"]')){const value=element.style.fontFamily.split(',')[0].trim();if(value)names.add(value);}
  await Promise.all([...names].map(name=>loadGoogleFont(name).catch(onError)));
}
