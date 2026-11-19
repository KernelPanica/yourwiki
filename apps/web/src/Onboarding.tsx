import {createContext,useContext,useEffect,useId,useState,type ReactNode} from 'react';
import {api,ApiError} from './api.ts';
import './onboarding.css';

const tips={
 welcome:['Заполните профиль, чтобы коллеги могли узнать вас и связаться с вами.','Complete your profile so teammates can recognize and contact you.'],
 profile:['В профиле YourSpace заполните доступные для редактирования поля. Лиды и ПМы по умолчанию видят рабочие контакты, роль и статус. Телефон, дополнительная почта и дата рождения видны вам и суперадмину. Другим участникам эти поля доступны только по отдельно выданным правам.','Complete the editable fields in YourSpace. Leads and project managers can see work contact details, role, and status by default. You and the superadmin can see your phone, secondary email, and birth date. Others need permission to see those fields.'],
 document:['Название и формат файла указаны вверху. Ниже находится рабочая область документа. По ссылке со стрелкой слева можно вернуться к списку файлов.','The file name and format appear at the top. The document workspace is below. Use the arrow link on the left to return to the file list.'],
 denied:['Если вам нужен доступ к документу, скопируйте ссылку ниже и отправьте её администратору или тому, кто поделился документом.','If you need access to this document, copy the link below and send it to an administrator or the person who shared the document.'],
 permissions:['При включённом наследовании действуют права родительской папки. Отключение наследования позволяет задать права для этого объекта отдельно.','When inheritance is on, permissions come from the parent folder. Turn inheritance off to manage permissions for this item separately.'],
 trash:['Перемещение в корзину скрывает документ из рабочего списка. Суперадмин может восстановить документ из корзины в настройках.','Moving a document to trash removes it from the working list. A superadmin can restore it from Trash in settings.'],
} as const;

export type GuideTopic=Exclude<keyof typeof tips,'welcome'|'profile'>;
export type ProcessNote={topic:GuideTopic;ru:string;en:string;link:string};
type Progress={disabled:boolean;seen:Partial<Record<keyof typeof tips,true>>};
const initial:Progress={disabled:false,seen:{}};
const Onboarding=createContext<{progress:Progress;save:(value:Progress)=>void;ru:boolean;notes:ProcessNote[];setNotes:(notes:ProcessNote[])=>void}|null>(null);

export function OnboardingProvider({userId,ru,notes,children}:{userId:string;ru:boolean;notes:ProcessNote[];children:ReactNode}){
 const key='yourwiki.onboarding.'+userId;
 const [progress,setProgress]=useState<Progress>(()=>{
  try{
   const value=JSON.parse(localStorage.getItem(key)??'null');
   return value&&typeof value.disabled==='boolean'&&value.seen&&typeof value.seen==='object'?value:initial;
  }catch{return initial;}
 });
 const [processNotes,setNotes]=useState(notes);
 function save(value:Progress){
  setProgress(value);
  try{localStorage.setItem(key,JSON.stringify(value));}catch{/* The current session still keeps the preference. */}
 }
 return <Onboarding.Provider value={{progress,save,ru,notes:processNotes,setNotes}}>{children}</Onboarding.Provider>;
}

export function GuideHint({topic,children}:{topic:keyof typeof tips;children?:ReactNode}){
 const state=useContext(Onboarding),id=useId();
 const visible=!!state&&!state.progress.disabled&&!state.progress.seen[topic];
 useEffect(()=>{
  if(!visible||!state)return;
  const {progress,save}=state;
  function escape(event:KeyboardEvent){
   const hint=document.getElementById(id);
   if(event.key==='Escape'&&!event.defaultPrevented&&hint?.getClientRects().length&&
      (document.querySelector('dialog:modal')?.contains(hint)??true)){
    event.preventDefault();
    save({...progress,seen:{...progress.seen,[topic]:true}});
   }
  }
  window.addEventListener('keydown',escape);
  return ()=>window.removeEventListener('keydown',escape);
 },[visible,state,topic,id]);
 if(!visible||!state)return null;
 const {ru,save,progress}=state;
 return <aside id={id} className="notice onboarding-hint" aria-label={ru?'Подсказка':'Tip'}>
  <p>{tips[topic][ru?0:1]}</p>
  <div className="onboarding-actions">
   {children}
   <button type="button" onClick={()=>save({...progress,seen:{...progress.seen,[topic]:true}})}>{ru?'Понятно':'Got it'}</button>
   <button type="button" onClick={()=>save({...progress,disabled:true})}>{ru?'Выключить подсказки':'Turn off tips'}</button>
  </div>
 </aside>;
}

export function GuidePreferences(){
 const state=useContext(Onboarding);
 if(!state)return null;
 const {ru,progress,save}=state;
 return <section aria-label={ru?'Подсказки':'Tips'} className="onboarding-actions">
  <button type="button" onClick={()=>save({...progress,disabled:!progress.disabled})}>
   {progress.disabled?(ru?'Включить подсказки':'Turn on tips'):(ru?'Выключить подсказки':'Turn off tips')}
  </button>
  <button type="button" onClick={()=>save(initial)}>{ru?'Пройти обучение заново':'Restart onboarding'}</button>
 </section>;
}

export function HowWeWork({topic}:{topic:GuideTopic}){
 const state=useContext(Onboarding);
 const note=state?.notes.find(note=>note.topic===topic);
 if(!state||!note)return null;
 return <details className="onboarding-process">
  <summary>{state.ru?'Как у нас':'How we work'}</summary>
  <p>{state.ru?note.ru:note.en}</p>
  <a href={note.link}>{state.ru?'Открыть регламент':'Open team guidelines'}</a>
 </details>;
}

export function ProcessSettings({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const state=useContext(Onboarding);
 const [topic,setTopic]=useState<GuideTopic>('document');
 const [status,setStatus]=useState<'saved'|'error'|null>(null),[saving,setSaving]=useState(false);
 if(!state)return null;
 const {ru,notes,setNotes}=state;
 const note=notes.find(note=>note.topic===topic);
 const topics:Record<GuideTopic,string>=ru?{document:'Документ',denied:'Доступ',permissions:'Права папки',trash:'Корзина'}:{document:'Document',denied:'Access',permissions:'Folder permissions',trash:'Trash'};
 async function submit(value:ProcessNote){
  setSaving(true);
  setStatus(null);
  try{
   setNotes(await api<ProcessNote[]>('/api/admin/onboarding/process',{
    method:'PUT',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(value),
   }));
   setStatus('saved');
  }catch(error){
   if(error instanceof ApiError&&error.code==='SESSION_REQUIRED')onSessionLost();
   else setStatus('error');
  }finally{setSaving(false);}
 }
 return <section className="onboarding-process">
  <h2>{ru?'Как у нас':'How we work'}</h2>
  <label>{ru?'Рабочий экран':'Workspace'} <select value={topic} disabled={saving} onChange={event=>{setTopic(event.target.value as GuideTopic);setStatus(null);}}>
   {Object.entries(topics).map(([id,label])=><option key={id} value={id}>{label}</option>)}
  </select></label>
  <form key={topic+JSON.stringify(note??null)} onSubmit={event=>{
   event.preventDefault();
   const data=new FormData(event.currentTarget);
   void submit({topic,ru:String(data.get('ru')).trim(),en:String(data.get('en')).trim(),link:String(data.get('link')).trim()});
  }}>
   <label>Русский <textarea name="ru" required maxLength={500} defaultValue={note?.ru}/></label>
   <label>English <textarea name="en" required maxLength={500} defaultValue={note?.en}/></label>
   <label>{ru?'Ссылка на регламент в YourWiki':'Link to guidelines in YourWiki'} <input required name="link" maxLength={1024} defaultValue={note?.link}/></label>
   <div className="onboarding-actions">
    <button disabled={saving}>{ru?'Сохранить':'Save'}</button>
    {note&&<button type="button" disabled={saving} onClick={()=>void submit({topic,ru:'',en:'',link:''})}>{ru?'Убрать с рабочего экрана':'Remove from workspace'}</button>}
   </div>
   {status&&<p role={status==='error'?'alert':'status'}>{status==='saved'?(ru?'Сохранено.':'Saved.'):(ru?'Проверьте тексты и ссылку на документ YourWiki.':'Check the text and the link to a YourWiki document.')}</p>}
  </form>
 </section>;
}
