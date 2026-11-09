import MarkdownWorkspace from '../MarkdownWorkspace.tsx';
import type {TextDocument} from '../text-editor-client.ts';
import type {ReactNode} from 'react';
import LoadingSkeleton from '../LoadingSkeleton.tsx';
import {Notice,tr,useWorkspace} from './shared.tsx';
export function DashboardFileSettings(_props:{csrf:string;onSessionLost:()=>void;onAssigned?:()=>void}){return <section className="dashboard-file-settings"><h3>Dashboard</h3><p>{tr('Локальная служебная страница. Содержимое редактируется двойным кликом на Dashboard. Удаление и замена файла отключены.','Local system page. Double-click Dashboard content to edit. File deletion and replacement are disabled.')}</p></section>;}
export default function Dashboard({csrf,onSessionLost}:{csrf:string;admin:boolean;onSessionLost:()=>void;renderDocument?:(id:string)=>ReactNode}){const s=useWorkspace<{documentId:string;snapshot:TextDocument&{previewHtml:string}}>('/api/dashboard',onSessionLost);return <main id="content" className="dashboard-page">{s.error?<Notice error={s.error}/>:!s.value?<LoadingSkeleton/>:<MarkdownWorkspace key={s.value.documentId} initialDocument={s.value.snapshot} documentId={s.value.documentId} csrf={csrf} write={s.value.snapshot.write} onSessionLost={onSessionLost} pageMode/>}</main>;}
