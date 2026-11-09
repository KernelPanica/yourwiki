import {useId,useRef,useState} from 'react';
import {tr} from './administration/shared.tsx';
/** Generated links stay in memory and are copied only after an explicit click. */
export default function CopyLink({value,label,note}:{value:string;label:string;note?:string}){
 const id=useId(),input=useRef<HTMLInputElement>(null),[status,setStatus]=useState<'idle'|'copying'|'copied'|'failed'>('idle');
 async function copy(){if(status==='copying')return;setStatus('copying');try{await navigator.clipboard.writeText(value);setStatus('copied');}catch{input.current?.focus();input.current?.select();setStatus('failed');}}
 return <div className="copy-link"><label htmlFor={id}>{label}</label><div className="copy-link-controls"><input id={id} ref={input} type="text" value={value} readOnly spellCheck={false} autoComplete="off" onFocus={event=>event.currentTarget.select()}/><button type="button" disabled={status==='copying'} onClick={()=>void copy()}>{tr('Скопировать','Copy')}</button></div>{note&&<small className="muted">{note}</small>}<span role="status" aria-live="polite">{status==='copied'?tr('Ссылка скопирована','Link copied'):status==='failed'?tr('Браузер не разрешил копирование. Ссылка выделена — скопируйте её вручную.','The browser blocked copying. The link is selected; copy it manually.'):''}</span></div>;
}
