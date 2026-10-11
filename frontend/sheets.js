import {updateAxes,createAxisHistory} from './sheet-axes.js';
import {normalizeFormulaCells,availableFunctions} from './sheet-formulas.js';
import {createSheetTools} from './sheet-tools.js';
import './sheet-tools.css';
import {createElement} from 'react';
import {Univer,LocaleType,mergeLocales,LogLevel,IUndoRedoService,LocaleService,IUniverInstanceService} from '@univerjs/core';
import {FUniver} from '@univerjs/core/lib/facade';
import {UniverSheetsCorePreset,IFunctionService,IShortcutService,IRenderManagerService} from '@univerjs/preset-sheets-core';
import {UniverSheetsFilterPreset} from '@univerjs/preset-sheets-filter';
import coreEn from '@univerjs/preset-sheets-core/locales/en-US';
import filterEn from '@univerjs/preset-sheets-filter/locales/en-US';
import coreRu from '@univerjs/preset-sheets-core/locales/ru-RU';
import filterRu from '@univerjs/preset-sheets-filter/locales/ru-RU';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import {format,boot,host,objects,readObjects,writeObjects,graphUndo,error} from './shared.js';

const sorted=axis=>Object.keys(axis||{}).sort((a,b)=>axis[a]-axis[b]||a.localeCompare(b));
function createUniver({presets,...options}){const univer=new Univer({...options,logLevel:LogLevel.WARN});const plugins=new Map();for(const preset of presets)for(const entry of preset.plugins){const [plugin,config]=Array.isArray(entry)?entry:[entry];plugins.set(plugin.pluginName,[plugin,config]);}for(const [plugin,config] of plugins.values())univer.registerPlugin(plugin,config);return {univer,univerAPI:FUniver.newAPI(univer)};}
function hydrate(data){const out=structuredClone(data);const layout=out._layout||{};delete out._layout;for(const [id,sheet] of Object.entries(out.sheets||{})){if(!layout[id])continue;const rows=sorted(layout[id].rows),cols=sorted(layout[id].cols),cells={};for(const [r,row] of Object.entries(sheet.cellData||{})){const ri=rows.indexOf(r);if(ri<0)continue;for(const [c,v] of Object.entries(row)){const ci=cols.indexOf(c);if(ci>=0)(cells[ri]||={})[ci]=v;}}sheet.cellData=cells;sheet.rowCount=rows.length;sheet.columnCount=cols.length;}return out;}
function dehydrate(workbook,layout){const out=structuredClone(workbook);out._layout=structuredClone(layout);for(const [id,sheet] of Object.entries(out.sheets||{})){if(!out._layout[id])out._layout[id]={rows:Object.fromEntries(Array.from({length:sheet.rowCount||200},(_,i)=>[`r${i}`,i])),cols:Object.fromEntries(Array.from({length:sheet.columnCount||26},(_,i)=>[`c${i}`,i]))};const rows=sorted(out._layout[id].rows),cols=sorted(out._layout[id].cols),cells={};for(const [r,row] of Object.entries(sheet.cellData||{})){if(!rows[+r])continue;for(const [c,v] of Object.entries(row)){if(cols[+c])(cells[rows[+r]]||={})[cols[+c]]=v;}}sheet.cellData=cells;}return out;}

export function sheetEditor(){
  graphUndo();const workspace=document.createElement('div');workspace.className='sheet-workspace';host.append(workspace);const container=document.createElement('div');container.className='sheet-host';workspace.append(container);
  const {univer,univerAPI}=createUniver({locale:document.documentElement.lang==='ru'?LocaleType.RU_RU:LocaleType.EN_US,locales:{[LocaleType.EN_US]:mergeLocales(coreEn,filterEn),[LocaleType.RU_RU]:mergeLocales(coreRu,filterRu)},presets:[UniverSheetsCorePreset({container,formulaBar:false,disableAutoFocus:true,customFontFamily:{override:true,list:["Arial","Calibri","Cambria","Georgia","Times New Roman","Tinos","Oswald","Anton","Roboto","Open Sans","Arimo","Cousine","Impact","Verdana","Courier New","Comic Sans MS"].map(value=>({value,label:value}))}}),UniverSheetsFilterPreset()]});
  let applying=true,last=readObjects(),layout=structuredClone(last._layout||{}),workbook=univerAPI.createWorkbook(hydrate(last));workbook.setEditable(boot.write);applying=false;let timer;
  const injector=univer.__getInjector(),localeService=injector.get(LocaleService),instanceService=injector.get(IUniverInstanceService),shortcutService=injector.get(IShortcutService),renderManager=injector.get(IRenderManagerService);
  // Custom controls live outside Univer's DOM, but still operate on this sheet.
  // Update its logical focus without moving DOM focus out of the input.
  let escapeShortcuts;
  const releaseShortcuts=()=>{escapeShortcuts?.dispose();escapeShortcuts=null;};
  function focusReadySheet(){const target=workbook;const focus=()=>{if(workbook!==target)return;const canvas=renderManager.getRenderById(target.getId())?.engine.getCanvasElement();if(!canvas?.isConnected){requestAnimationFrame(focus);return;}instanceService.focusUnit(target.getId());};requestAnimationFrame(focus);}
  focusReadySheet();
  workspace.addEventListener('focusin',event=>{if(container.contains(event.target)){releaseShortcuts();return;}if(!escapeShortcuts)escapeShortcuts=shortcutService.forceDisable();queueMicrotask(focusReadySheet);});
  workspace.addEventListener('focusout',()=>queueMicrotask(()=>{if(!workspace.contains(document.activeElement)||container.contains(document.activeElement))releaseShortcuts();}));
  container.addEventListener('pointerdown',releaseShortcuts);
  const tools=createSheetTools({parent:workspace,getWorkbook:()=>workbook,functions:availableFunctions(injector.get(IFunctionService)),russian:document.documentElement.lang==='ru',translate:key=>localeService.t(key),editable:boot.write,onError:cause=>error(format('Spreadsheet action failed: %(message)s',{message:cause.message}))});workspace.append(container);
  let peers=[],presenceChange=()=>{},presenceMarks=[],presenceFrame;
  function clearPresence(){for(const mark of presenceMarks)mark?.dispose();presenceMarks=[];}
  function renderPresence(entries){
    peers=entries;clearPresence();const active=workbook.getActiveSheet();if(!active)return;
    // Presence popups subscribe to engine geometry; the new canvas must be attached.
    if(!renderManager.getRenderById(workbook.getId())?.engine.getCanvasElement()?.isConnected){if(!presenceFrame&&workspace.isConnected)presenceFrame=requestAnimationFrame(()=>{presenceFrame=null;renderPresence(peers);});return;}
    if(presenceFrame){cancelAnimationFrame(presenceFrame);presenceFrame=null;}
    for(const peer of peers){
      const selection=peer.selection;if(selection?.kind!=='table'||selection.sheet_id!==active.getSheetId()||!/^#[0-9a-f]{6}$/i.test(peer.color||''))continue;
      const axes=layout[selection.sheet_id];if(!axes)continue;
      const rows=sorted(axes.rows),cols=sorted(axes.cols),r0=rows.indexOf(selection.row_id),r1=rows.indexOf(selection.end_row_id||selection.row_id),c0=cols.indexOf(selection.column_id),c1=cols.indexOf(selection.end_column_id||selection.column_id);
      if([r0,r1,c0,c1].some(index=>index<0))continue;
      const range=active.getRange(Math.min(r0,r1),Math.min(c0,c1),Math.abs(r1-r0)+1,Math.abs(c1-c0)+1);
      try{
        presenceMarks.push(range.highlight({id:peer.id,stroke:peer.color,strokeWidth:2,fill:peer.color+'22'}));
        presenceMarks.push(range.attachRangePopup({direction:'top',componentKey:()=>createElement('span',{
          className:'remote-presence-cursor'+(r0!==r1||c0!==c1?' remote-presence-selection':''),
          'data-presence-id':peer.id,style:{background:peer.color,color:'white',fontSize:'11px',padding:'1px 4px',pointerEvents:'none',whiteSpace:'nowrap'}},peer.name||'')}));
      }catch{/* Deleted sheets and cells have no visible remote selection. */}
    }
  }
  function getPresenceSelection(){
    const active=workbook.getActiveSheet(),range=active?.getActiveRange()?.getRange();if(!active||!range)return null;
    const sheet_id=active.getSheetId(),axes=layout[sheet_id];if(!axes)return null;
    const rows=sorted(axes.rows),cols=sorted(axes.cols);
    const selection={kind:'table',sheet_id,row_id:rows[range.startRow],column_id:cols[range.startColumn],end_row_id:rows[range.endRow],end_column_id:cols[range.endColumn]};
    return Object.values(selection).some(value=>value==null)?null:selection;
  }
  univerAPI.addEvent(univerAPI.Event.SelectionChanged,()=>{tools.refresh(true);presenceChange();renderPresence(peers);});
  const undoService=univer.__getInjector().get(IUndoRedoService);
  const axisHistory=createAxisHistory({read:()=>layout,write:value=>{layout=value;},undo:()=>undoService.pitchTopUndoElement(),redo:()=>undoService.pitchTopRedoElement()});
  univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute,event=>{const command=event.command||event;if(!applying&&boot.write){if(command.id==='sheet.mutation.set-range-values')normalizeFormulaCells(command.params?.cellValue);axisHistory.before(command);}});
  function capture(){if(applying||!boot.write)return;const next=dehydrate(workbook.save(),layout);layout=structuredClone(next._layout);writeObjects(next,last);last=structuredClone(next);}
  univerAPI.addEvent(univerAPI.Event.CommandExecuted,event=>{
    if(applying||!boot.write)return;
    tools.refresh();
    const command=event.command||event,params=command.params||{},id=command.id||'';
    if(!id.includes('mutation')){axisHistory.after(command);return;}
    axisHistory.mutate(()=>updateAxes(layout,id,params));
    clearTimeout(timer);timer=setTimeout(capture,40);
  });
  objects.observe(event=>{
    if(event.transaction.origin==='local')return;
    // Commit local command results before rebuilding from the merged shared state.
    clearTimeout(timer);capture();const selection=getPresenceSelection();const next=readObjects();last=structuredClone(next);layout=structuredClone(next._layout||{});axisHistory.reset();applying=true;
    try{clearPresence();const active=workbook.getActiveSheet()?.getSheetId();const snapshot=hydrate(next);univerAPI.disposeUnit(workbook.getId());workbook=univerAPI.createWorkbook(snapshot);focusReadySheet();if(active&&snapshot.sheets[active])workbook.setActiveSheet(active);workbook.setEditable(boot.write);if(selection&&snapshot.sheets[selection.sheet_id]){const axes=layout[selection.sheet_id],rows=sorted(axes?.rows),cols=sorted(axes?.cols),r0=rows.indexOf(selection.row_id),r1=rows.indexOf(selection.end_row_id),c0=cols.indexOf(selection.column_id),c1=cols.indexOf(selection.end_column_id);if([r0,r1,c0,c1].every(index=>index>=0)){const sheet=workbook.getSheetBySheetId(selection.sheet_id);workbook.setActiveSheet(selection.sheet_id);sheet.getRange(Math.min(r0,r1),Math.min(c0,c1),Math.abs(r1-r0)+1,Math.abs(c1-c0)+1).activate();}}tools.refresh(true);renderPresence(peers);}catch(e){error(format('Spreadsheet refresh failed: %(message)s', {message:e.message}));}finally{applying=false;}
  });
  return {flush:capture,setEditable:value=>{workbook.setEditable(value);tools.setEditable(value);},getPresenceSelection,renderPresence,setPresenceChange:callback=>{presenceChange=callback;}};
}
