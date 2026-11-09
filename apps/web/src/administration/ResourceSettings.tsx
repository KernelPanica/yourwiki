import {useEffect,useRef} from 'react';
import {publishChanges} from '../live-updates.ts';
import {Notice,tr,useWorkspace} from './shared.tsx';
import AccessEditor from './AccessEditor.tsx';
export default function ResourceSettings({item,csrf,onClose,onSessionLost}:{item:{id:string;title:string;kind:string};csrf:string;onClose:()=>void;onSessionLost:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),s=useWorkspace<{groups:{id:string;name:string}[];users:{id:string;displayName:string}[]}>('/api/admin/overview',onSessionLost);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};},[]);
 async function save<R>(path:string,body:unknown,token:string,method?:string):Promise<R|undefined>{const value=await s.mutate<R>(path,body,token,method);if(value)publishChanges({type:'all'});return value;}
 return <dialog ref={dialog} className="resource-settings" onCancel={e=>{e.preventDefault();onClose();}} aria-labelledby={'resource-settings-title'}><header><h2 id="resource-settings-title">{tr('Настройки: ','Settings: ')}{item.title}</h2><button type="button" onClick={onClose} aria-label={tr('Закрыть настройки','Close settings')}>×</button></header><Notice error={s.error}/>{!s.value&&!s.error&&<p role="status">{tr('Загрузка…','Loading…')}</p>}{s.value&&<AccessEditor resourceId={item.id} csrf={csrf} groups={s.value.groups} users={s.value.users} mutate={save} setError={s.setError} pending={s.pending}/>}</dialog>;
}
