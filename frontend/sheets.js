import {Univer,LocaleType,mergeLocales,LogLevel} from '@univerjs/core';
import {FUniver} from '@univerjs/core/lib/facade';
import {UniverSheetsCorePreset} from '@univerjs/preset-sheets-core';
import {UniverSheetsFilterPreset} from '@univerjs/preset-sheets-filter';
import coreEn from '@univerjs/preset-sheets-core/locales/en-US';
import filterEn from '@univerjs/preset-sheets-filter/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import {boot,host,objects,readObjects,writeObjects,graphUndo,error} from './shared.js';

const sorted=axis=>Object.keys(axis||{}).sort((a,b)=>axis[a]-axis[b]||a.localeCompare(b));
function createUniver({presets,...options}){const univer=new Univer({...options,logLevel:LogLevel.WARN});const plugins=new Map();for(const preset of presets)for(const entry of preset.plugins){const [plugin,config]=Array.isArray(entry)?entry:[entry];plugins.set(plugin.pluginName,[plugin,config]);}for(const [plugin,config] of plugins.values())univer.registerPlugin(plugin,config);return {univer,univerAPI:FUniver.newAPI(univer)};}
function hydrate(data){const out=structuredClone(data);const layout=out._layout||{};delete out._layout;for(const [id,sheet] of Object.entries(out.sheets||{})){if(!layout[id])continue;const rows=sorted(layout[id].rows),cols=sorted(layout[id].cols),cells={};for(const [r,row] of Object.entries(sheet.cellData||{})){const ri=rows.indexOf(r);if(ri<0)continue;for(const [c,v] of Object.entries(row)){const ci=cols.indexOf(c);if(ci>=0)(cells[ri]||={})[ci]=v;}}sheet.cellData=cells;sheet.rowCount=rows.length;sheet.columnCount=cols.length;}return out;}
function dehydrate(workbook,layout){const out=structuredClone(workbook);out._layout=structuredClone(layout);for(const [id,sheet] of Object.entries(out.sheets||{})){if(!out._layout[id])out._layout[id]={rows:Object.fromEntries(Array.from({length:sheet.rowCount||200},(_,i)=>[`r${i}`,i])),cols:Object.fromEntries(Array.from({length:sheet.columnCount||26},(_,i)=>[`c${i}`,i]))};const rows=sorted(out._layout[id].rows),cols=sorted(out._layout[id].cols),cells={};for(const [r,row] of Object.entries(sheet.cellData||{})){if(!rows[+r])continue;for(const [c,v] of Object.entries(row)){if(cols[+c])(cells[rows[+r]]||={})[cols[+c]]=v;}}sheet.cellData=cells;}return out;}

export function sheetEditor(){
  graphUndo();const container=document.createElement('div');container.className='sheet-host';host.append(container);
  const {univerAPI}=createUniver({locale:LocaleType.EN_US,locales:{[LocaleType.EN_US]:mergeLocales(coreEn,filterEn)},presets:[UniverSheetsCorePreset({container}),UniverSheetsFilterPreset()]});
  let applying=true,last=readObjects(),layout=structuredClone(last._layout||{}),workbook=univerAPI.createWorkbook(hydrate(last));workbook.setEditable(boot.write);applying=false;let timer;
  function capture(){if(applying||!boot.write)return;const next=dehydrate(workbook.save(),layout);layout=structuredClone(next._layout);writeObjects(next,last);last=structuredClone(next);}
  univerAPI.addEvent(univerAPI.Event.CommandExecuted,event=>{
    if(applying||!boot.write)return;
    const command=event.command||event,params=command.params||{},id=command.id||'';
    if(!id.includes('mutation'))return;
    if(['sheet.mutation.insert-row','sheet.mutation.remove-rows','sheet.mutation.insert-col','sheet.mutation.remove-col'].includes(id)&&params.range){
      const axis=id.includes('row')?'rows':'cols',isRow=axis==='rows',start=params.range[isRow?'startRow':'startColumn'],end=params.range[isRow?'endRow':'endColumn'];
      const positions=layout[params.subUnitId]?.[axis];if(positions){const keys=sorted(positions),count=end-start+1;if(id.includes('remove'))for(const key of keys.slice(start,start+count))delete positions[key];else{const left=start?positions[keys[start-1]]:-1,right=start<keys.length?positions[keys[start]]:left+count+1;for(let i=0;i<count;i++)positions[crypto.randomUUID()]=left+(right-left)*(i+1)/(count+1);}}
    }
    clearTimeout(timer);timer=setTimeout(capture,40);
  });
  objects.observe(event=>{
    if(event.transaction.origin==='local')return;
    // Commit local command results before rebuilding from the merged shared state.
    clearTimeout(timer);capture();const next=readObjects();last=structuredClone(next);layout=structuredClone(next._layout||{});applying=true;
    try{const active=workbook.getActiveSheet()?.getSheetId();const snapshot=hydrate(next);univerAPI.disposeUnit(workbook.getId());workbook=univerAPI.createWorkbook(snapshot);if(active&&snapshot.sheets[active])workbook.setActiveSheet(active);workbook.setEditable(boot.write);}catch(e){error(`Spreadsheet refresh failed: ${e.message}`);}finally{applying=false;}
  });
  return {setEditable:value=>workbook.setEditable(value)};
}
