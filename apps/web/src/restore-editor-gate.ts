import type {RestoreOperation} from './history-restore-client.ts';
type Options={dirty:()=>boolean;release:(action:()=>Promise<void>)=>Promise<boolean>;suspend:()=>void;unlock:()=>void;refresh:(operation:RestoreOperation)=>void};
/** Keep the original editor and warnings until its clean release has actually succeeded. */
export class RestoreEditorGate{
 private options:Options;private held=false;
 constructor(options:Options){this.options=options;}
 async release(action:()=>Promise<void>){if(this.options.dirty())return false;return this.options.release(async()=>{if(this.options.dirty())return;this.held=true;this.options.suspend();await action();});}
 settled(value:{state:'saved'|'discarded'|'not_started';operation:RestoreOperation|null}){
  if(value.state==='saved'&&value.operation){if(this.options.dirty())return;this.held=false;this.options.refresh(value.operation);}
  else if(this.held){this.held=false;this.options.unlock();}
 }
}
