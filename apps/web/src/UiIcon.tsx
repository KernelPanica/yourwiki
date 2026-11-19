import type {CSSProperties} from 'react';
export type IconName='info'|'edit'|'menu'|'close'|'chevron'|'dashboard'|'files'|'recent'|'settings'|'user'|'logout'|'panel'|'grip'|'plus'|'upload'|'folder'|'search'|'arrow'|'comments'|'history'|'sparkles'|'paperclip'|'shield'|'trash'|'external'|'move'|'document'|'spreadsheet'|'presentation'|'markdown'|'pdf'|'canvas'|'diagram'|'image'|'archive'|'code'|'fullscreen'|'restore'|'hand';
const paths:Record<IconName,string>={
 hand:'M8 13V5a2 2 0 0 1 4 0v7-9a2 2 0 0 1 4 0v9-7a2 2 0 0 1 4 0v11c0 4-3 6-7 6h-1c-2 0-4-2-5-4l-3-5a2 2 0 0 1 3-2l3 3',
 external:'M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5',
 move:'M4 12h16m-6-6 6 6-6 6',
 document:'M13.5 3H6a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V9L13.5 3Zm0 0v6h6M8 11h2m-2 3h8m-8 3h8',
 spreadsheet:'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 9h18M3 14.5h18M9 4v16m6-16v16',
 presentation:'M3 4h18m-2 0v12H5V4m7 12v5m-4 0 4-3 4 3M8 13l3-3 2 2 3-4',
 markdown:'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM6 15V9l3 3 3-3v6m5-6v6m-2-2 2 2 2-2',
 pdf:'M5 11V5a2 2 0 0 1 2-2h7l5 5v3m-5-8v5h5m0 11v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1M4 11h16v8H4Z',
 canvas:'M4 4h6v6H4ZM14 4h6v6h-6ZM14 14h6v6h-6ZM7 10v7h7M10 7h4',
 diagram:'M8 3h8v5H8ZM3 16h7v5H3ZM14 16h7v5h-7ZM12 8v4m-6 4v-4h12v4',
 image:'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 17l6-6 4 4 3-3 5 5M8 7h.01',
 archive:'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M10 3v2m0 3v2m0 3v2m-1 2h2v2H9Z',
 code:'M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16',
 fullscreen:'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
 restore:'M3 8h5V3M16 3v5h5M8 21v-5H3M21 16h-5v5',
 info:'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 edit:'m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z',
 menu:'M4 6h16M4 12h16M4 18h16',
 close:'m6 6 12 12M18 6 6 18',
 chevron:'m8 10 4 4 4-4',
 dashboard:'M10.5 3.5a8.5 8.5 0 1 0 10 10h-10zm3-1v8h8a8 8 0 0 0-8-8Z',
 files:'M8 3h8l4 4v12a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V4.5A1.5 1.5 0 0 1 8 3Zm8 0v4h4M3.5 7v11',
 recent:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 6.5V12l3.5 2',
 settings:'M10 3h4l.6 2.7 1.4.8 2.6-.9 2 3.5-2 1.8v1.7l2 1.8-2 3.5-2.6-.9-1.4.8-.6 2.7h-4l-.6-2.7-1.4-.8-2.6.9-2-3.5 2-1.8v-1.7l-2-1.8 2-3.5 2.6.9 1.4-.8L10 3ZM15.4 11.8a3.4 3.4 0 1 1-6.8 0 3.4 3.4 0 0 1 6.8 0Z',
 user:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-2a8 8 0 0 1 16 0v2',
 logout:'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M16 7l5 5-5 5M9 12h12',
 panel:'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM15 3v18',
 grip:'M9 5v14M15 5v14',
 plus:'M12 5v14M5 12h14',
 upload:'M12 16V3m-5 5 5-5 5 5M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4',
 folder:'M3 12V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v4M6 11V9h12v2',
 search:'m21 21-4.5-4.5M19 11a8 8 0 1 0-16 0 8 8 0 0 0 16 0',
 arrow:'m12 5-7 7 7 7M5 12h15',
 comments:'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2ZM7 7h10M7 11h7',
 history:'M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2',
 sparkles:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4M18 4h4',
 paperclip:'m21 11-9 9a6 6 0 0 1-8.5-8.5L13 2a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8L15 6',
 shield:'M12 3 3 7v5c0 5 6 8 9 10 3-2 9-5 9-10V7Zm-5 9 3 3 6-6',
 trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'
};
const terminalGlyphs:Record<IconName,string>={
 info:'ⓘ',edit:'✎',menu:'≡',close:'×',chevron:'⌄',dashboard:'◔',files:'▤',
 recent:'◴',settings:'⚙︎',user:'◎',logout:'⇥',panel:'◫',grip:'⋮',plus:'+',
 upload:'↑',folder:'▰',search:'⌕',arrow:'←',comments:'◩',history:'↶',sparkles:'✧',
 paperclip:'⤷',shield:'◇',trash:'⌫',external:'↗',move:'→',document:'▤',
 spreadsheet:'▦',presentation:'▣',markdown:'↧',pdf:'▧',canvas:'⊞',diagram:'⌘',
 image:'▨',archive:'▥',code:'‹›',fullscreen:'⛶',restore:'⊡',hand:'✋︎',
};
export default function UiIcon({name,size=20,style}:{name:IconName;size?:number;style?:CSSProperties}){return <><svg data-icon={name} className="ui-icon ui-icon-vector" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]}/>
 {name==='folder'&&<rect x="3" y="11" width="18" height="9" rx="2" fill="var(--accent-wash, transparent)"/>}
 {name==='pdf'&&<path d="M6.5 17v-4h1.25a1 1 0 0 1 0 2H6.5m4.25 2v-4H12a1.5 1.5 0 0 1 1.5 1.5v1A1.5 1.5 0 0 1 12 17ZM15.75 17v-4H18m-2.25 2h1.75" strokeWidth="1.1"/>}
 </svg><span className="ui-icon ui-icon-terminal" aria-hidden="true" style={{width:size,height:size,fontSize:size,...style}}>{terminalGlyphs[name]}</span></>;}
