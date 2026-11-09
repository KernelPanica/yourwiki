import '../google-trash.css';
import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../api.ts';
import {onSessionBlocked,sessionSnapshot} from '../session-fence.ts';
type Person={id:string;name:string;selection:{editor?:string}};
/** Reports our embedded editor, never guesses the state of an external browser tab. */
export default function DrawioPresenceNotice({documentId,csrf,editing,onSessionLost}:{documentId:string;csrf:string;editing:boolean;onSessionLost:()=>void}){
 const client=useRef(crypto.randomUUID()),[people,setPeople]=useState<Person[]>([]),ru=navigator.language.toLowerCase().startsWith('ru');
 useEffect(()=>{const controller=new AbortController(),clientId=client.current;let busy=false;const block=onSessionBlocked(()=>{controller.abort();setPeople([]);});
  async function tick(){if(busy||controller.signal.aborted||sessionSnapshot().blocked)return;busy=true;try{const value=await api<{items:Person[]}>('/api/documents/'+encodeURIComponent(documentId)+'/presence',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({clientId,selection:editing?{editor:'drawio'}:{}})});if(!controller.signal.aborted)setPeople(value.items.filter(p=>p.selection?.editor==='drawio'));}catch(e){if(!controller.signal.aborted){setPeople([]);if(e instanceof ApiError&&e.code==='SESSION_REQUIRED')onSessionLost();}}finally{busy=false;}}
  void tick();const timer=setInterval(()=>void tick(),5000);return()=>{clearInterval(timer);controller.abort();block();};
 },[documentId,csrf,editing]);
 if(!editing&&!people.length)return null;
 return <div className="file-source-banner" role="status">{editing&&(ru?'Диаграмма открыта для редактирования в draw.io.':'Diagram is open for editing in draw.io.')}{people.length>0&&<span>{ru?' Открыт редактор draw.io: ':' draw.io editor open: '}{[...new Set(people.map(p=>p.name))].join(', ')}.</span>}</div>;
}
