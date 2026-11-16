import type {OfficeConnectionSnapshot} from './office-connection.ts';
import type {OfficeSnapshot} from './office-bridge.ts';

type Presentation={status:'loading'|'preview'|'stopped'|'closing'|'saving'|'saved'|'modified'|'ready';loading:boolean};
export function officePresentation(state:Pick<OfficeConnectionSnapshot,'phase'>,editor:Pick<OfficeSnapshot,'loaded'|'saving'|'phase'|'needsRecovery'>|null):Presentation {
 let status:Presentation['status'];
 if(state.phase==='closing')status='closing';
 else if(state.phase==='failed')status='preview';
 else if(state.phase==='paused'||state.phase==='closed'||editor?.phase==='paused'||editor?.phase==='failed')status='stopped';
 else if(!editor?.loaded)status='loading';
 else if(editor.saving)status='saving';
 else if(editor.phase==='saved')status='saved';
 else if(editor.needsRecovery)status='modified';
 else status='ready';
 return {status,loading:status==='loading'};
}
