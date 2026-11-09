import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Notice,tr} from './shared.tsx';
import './purge-confirmation.css';

export default function PurgeConfirmation({name,pending,error,onCancel,onConfirm}:{name:string;pending:boolean;error:unknown;onCancel:()=>void;onConfirm:(name:string)=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),[confirmation,setConfirmation]=useState('');
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};},[]);
 function submit(event:FormEvent){event.preventDefault();if(!pending&&confirmation===name)void onConfirm(confirmation);}
 return <dialog ref={dialog} className="purge-confirmation" aria-labelledby="purge-confirmation-title" aria-describedby="purge-confirmation-description" onCancel={event=>{event.preventDefault();if(!pending)onCancel();}}>
  <h2 id="purge-confirmation-title">{tr('Безвозвратное удаление','Permanent deletion')}</h2>
  <p id="purge-confirmation-description">{tr('Объект и его содержимое нельзя будет восстановить через YourWiki. Для подтверждения введите точное имя:','The object and its contents cannot be restored through YourWiki. Enter its exact name to confirm:')} <strong>{name}</strong></p>
  <form onSubmit={submit} aria-busy={pending}>
   <label>{tr('Имя объекта','Object name')}<input autoFocus autoComplete="off" spellCheck={false} required value={confirmation} disabled={pending} onChange={event=>setConfirmation(event.target.value)}/></label>
   <Notice error={error}/>
   {pending&&<p role="status">{tr('Удаление…','Deleting…')}</p>}
   <footer><button type="button" disabled={pending} onClick={onCancel}>{tr('Отмена','Cancel')}</button><button type="submit" disabled={pending||confirmation!==name}>{tr('Удалить навсегда','Purge permanently')}</button></footer>
  </form>
 </dialog>;
}
