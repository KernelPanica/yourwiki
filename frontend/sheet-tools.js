import {sheetInputValue,displayFormula} from './sheet-formulas.js';

export function createSheetTools({parent,getWorkbook,functions,russian,translate=value=>value,editable,onError}){
  const text=(ru,en)=>russian?ru:en;
  const toolbar=document.createElement('div');toolbar.className='sheet-tools';parent.append(toolbar);
  const controls=[];
  const activeRange=()=>getWorkbook()?.getActiveSheet()?.getActiveRange();
  const activeCell=()=>{const sheet=getWorkbook()?.getActiveSheet(),range=sheet?.getActiveRange()?.getRange();return range?sheet.getRange(range.startRow,range.startColumn):null;};
  const run=action=>{if(!editable)return;try{action();refresh();}catch(cause){onError(cause);}};
  const select=(label,items,action)=>{
    const control=document.createElement('select');control.setAttribute('aria-label',label);control.title=label;
    for(const [value,name] of items){const option=document.createElement('option');option.value=value;option.textContent=name;control.append(option);}
    control.addEventListener('change',()=>run(()=>{const range=activeRange();if(range)action(range,control.value);}));toolbar.append(control);controls.push(control);return control;
  };
  const font=select(text('Шрифт','Font'),['Arial','Calibri','Cambria','Georgia','Times New Roman','Verdana','Courier New','Comic Sans MS'].map(name=>[name,name]),(range,value)=>range.setFontFamily(value));
  const size=select(text('Размер шрифта','Font size'),[8,9,10,11,12,14,16,18,20,24,28,32,36,48,72].map(value=>[String(value),String(value)]),(range,value)=>range.setFontSize(Number(value)));
  const number=select(text('Формат числа','Number format'),[['',text('Автоматически','Automatic')],['0',text('Целое число','Integer')],['0.00',text('Число · 2 знака','Number · 2 decimals')],['#,##0.00',text('С разделителем тысяч','Thousands separator')],['0.00%',text('Проценты','Percent')],['₽#,##0.00',text('Рубли','Rubles')],['yyyy-mm-dd',text('Дата','Date')],['hh:mm:ss',text('Время','Time')],['@',text('Текст','Text')]],(range,value)=>range.setNumberFormat(value));
  const hint=document.createElement('span');hint.className='sheet-tools-hint';hint.textContent=text('Форматирование применяется к выделенным ячейкам','Formatting applies to selected cells');toolbar.append(hint);

  const bar=document.createElement('form');bar.className='sheet-formula-tools';parent.append(bar);
  const address=document.createElement('input');address.className='sheet-address';address.setAttribute('aria-label',text('Адрес ячейки или диапазона','Cell or range address'));address.title=text('Введите адрес, например A1 или A1:C10, и нажмите Enter','Enter an address such as A1 or A1:C10 and press Enter');
  address.addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();event.stopPropagation();try{const value=address.value.trim().toUpperCase();if(!/^\$?[A-Z]+\$?[1-9]\d*(?::\$?[A-Z]+\$?[1-9]\d*)?$/.test(value))throw Error(text('Неверный адрес ячейки','Invalid cell address'));getWorkbook()?.getActiveSheet()?.getRange(value).activate();refresh(true);}catch(cause){onError(cause);}});
  const label=document.createElement('label');label.textContent='fx';label.className='sheet-fx';
  const formula=document.createElement('input');formula.className='sheet-formula-input';formula.id='sheet-localized-formula';formula.autocomplete='off';formula.spellcheck=false;formula.setAttribute('aria-label',text('Значение или формула','Value or formula'));formula.placeholder=text('Например: =СУММ(A1:A10) или =ЕСЛИ(A1>0;"Да";"Нет")','For example: =SUM(A1:A10) or =IF(A1>0,"Yes","No")');label.htmlFor=formula.id;
  formula.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();refresh(true);formula.blur();}});
  const apply=document.createElement('button');apply.type='submit';apply.textContent=text('Применить','Apply');controls.push(formula,apply);
  bar.addEventListener('submit',event=>{event.preventDefault();run(()=>{const cell=activeCell();if(!cell)return;const value=formula.value;cell.setValue(sheetInputValue(value,cell.getNumberFormat()==='@'));formula.blur();});});
  const result=document.createElement('output');result.className='sheet-formula-result';result.setAttribute('aria-label',text('Результат формулы','Formula result'));result.setAttribute('aria-live','polite');bar.append(address,label,formula,apply,result);

  const panel=document.createElement('details');panel.className='sheet-function-panel';
  const summary=document.createElement('summary');summary.textContent=text('Функции','Functions');panel.append(summary);
  const body=document.createElement('div');body.className='sheet-function-body';
  const description=document.createElement('p');description.textContent=text('Русские и английские имена работают. Аргументы разделяются точкой с запятой (;) или запятой (,). Десятичные числа вводите с точкой. Выберите функцию, заполните аргументы и нажмите «Применить».','Russian and English names work. Separate arguments with semicolons (;) or commas (,). Use a dot for decimal numbers. Choose a function, fill in its arguments, then apply.');body.append(description);
  const search=document.createElement('input');search.type='search';search.placeholder=text('Найти: СУММ, SUM, дата…','Search: SUM, date…');search.setAttribute('aria-label',text('Поиск функций','Search functions'));body.append(search);
  const count=document.createElement('p');count.className='sheet-function-count';count.setAttribute('aria-live','polite');body.append(count);
  const list=document.createElement('div');list.className='sheet-function-list';body.append(list);panel.append(body);bar.append(panel);
  function renderFunctions(){
    const query=search.value.trim().toLocaleLowerCase();list.replaceChildren();let matches=0;
    for(const entry of functions){
      const info=entry.description,abstract=info?.abstract?translate(info.abstract):'';
      if(query&&!`${entry.localName} ${entry.name} ${abstract}`.toLocaleLowerCase().includes(query))continue;
      matches++;const item=document.createElement('div');item.className='sheet-function-item';
      const button=document.createElement('button');button.type='button';button.disabled=!editable;button.textContent=russian?entry.localName:entry.name;button.title=entry.name;
      button.addEventListener('click',()=>{if(!editable)return;formula.value=`=${russian?entry.localName:entry.name}()`;panel.open=false;formula.focus();formula.setSelectionRange(formula.value.length-1,formula.value.length-1);});item.append(button);
      const help=document.createElement('span');help.textContent=`${entry.localName!==entry.name?entry.name+' · ':''}${abstract}`;item.append(help);
      if(info?.functionParameter?.length){const signature=document.createElement('small');signature.textContent=info.functionParameter.map(parameter=>translate(parameter.name)).join(russian?'; ':', ');item.append(signature);}
      list.append(item);
    }
    count.textContent=text(`Найдено функций: ${matches} из ${functions.length}`,`${matches} of ${functions.length} functions`);
  }
  search.addEventListener('input',renderFunctions);renderFunctions();
  function refresh(force=false){
    const range=activeRange(),cell=activeCell();if(!range||!cell)return;
    if(document.activeElement!==address)address.value=range.getA1Notation();
    if(force||document.activeElement!==formula){const expression=cell.getFormula();formula.value=expression?displayFormula(expression,russian):String(cell.getValue()??'');}
    result.textContent=cell.getFormula()?cell.getDisplayValue():'';result.hidden=!cell.getFormula();
    const selectedFont=range.getFontFamily();if(selectedFont&&[...font.options].some(option=>option.value===selectedFont))font.value=selectedFont;
    const selectedSize=range.getFontSize()||11;if(selectedSize&&[...size.options].some(option=>option.value===String(selectedSize)))size.value=String(selectedSize);
    const selectedFormat=range.getNumberFormat();number.value=[...number.options].some(option=>option.value===selectedFormat)?selectedFormat:'';
  }
  function setEditable(value){editable=Boolean(value);for(const control of controls)control.disabled=!editable;renderFunctions();}
  setEditable(editable);refresh();
  return {refresh,setEditable};
}
