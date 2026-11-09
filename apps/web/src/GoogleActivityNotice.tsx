import {useEffect,useRef,useState} from 'react';
import type {GoogleActivity} from './api.ts';
import {onSessionBlocked,sessionSnapshot} from './session-fence.ts';
import './google-trash.css';
/** A local expiry only; activity arrives with the existing document view. */
export default function GoogleActivityNotice({activity}:{activity:GoogleActivity|null|undefined}){
 const [active,setActive]=useState(false),[blocked,setBlocked]=useState(sessionSnapshot().blocked),lease=useRef<{key:string;until:number}|null>(null),ru=navigator.language.toLowerCase().startsWith('ru');
 useEffect(()=>onSessionBlocked(()=>{lease.current=null;setBlocked(true);setActive(false);}),[]);
 useEffect(()=>{
  if(blocked||!activity){lease.current=null;setActive(false);return;}
  const key=activity.revision+':'+activity.observedAt,now=performance.now(),until=now+Math.max(0,Math.min(60000,activity.activeForMs));
  lease.current={key,until:lease.current?.key===key?Math.min(lease.current.until,until):until};
  const remaining=lease.current.until-now;setActive(remaining>0);
  if(remaining>0){const timer=setTimeout(()=>setActive(false),remaining);return()=>clearTimeout(timer);}
 },[activity,blocked]);
 if(blocked||!activity||!Number.isFinite(activity.observedAt)||!Number.isFinite(activity.activeForMs))return null;
 const date=new Date(activity.observedAt),valid=Number.isFinite(date.getTime()),time=valid?date.toLocaleString(ru?'ru-RU':'en-US'):'';
 return <div className="google-activity file-source-banner" role="status" data-active={active}>{active?(ru?'В Google обнаружены правки. Возможна параллельная работа.':'Changes detected in Google. Parallel editing may be in progress.'):(ru?'Последнее внешнее изменение в Google: ':'Last external change in Google: ')}{valid&&<>{active?' ':''}<time dateTime={date.toISOString()}>{time}</time></>}</div>;
}
