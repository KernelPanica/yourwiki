export type Preferences={language:'auto'|'ru'|'en';theme:'auto'|'light'|'dark';animations:number;avatar:string|null;revision:number};
let themeFrame:number|undefined;
export function applyPreferences(p:Preferences){
 const root=document.documentElement,changed=root.dataset.theme!==p.theme;
 // Cross-fading foreground and background produces unreadable intermediate
 // colours. Snap theme colours, then restore ordinary interaction transitions.
 if(changed){root.dataset.themeChanging='true';if(themeFrame!==undefined)cancelAnimationFrame(themeFrame);}
 root.dataset.theme=p.theme;root.dataset.animations=p.animations?'on':'off';
 if(changed)themeFrame=requestAnimationFrame(()=>{themeFrame=requestAnimationFrame(()=>{delete root.dataset.themeChanging;themeFrame=undefined;});});
 window.dispatchEvent(new CustomEvent('yourwiki:preferences',{detail:{avatar:p.avatar}}));
 try{localStorage.setItem('yourwiki.preferences',JSON.stringify({language:p.language,theme:p.theme,animations:p.animations}));}catch{/* Appearance works without persistent browser storage. */}
}
