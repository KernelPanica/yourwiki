// Formula names are localized only at the UI boundary. Stored formulas use Univer's
// English tokens so XLSX/ODS export and collaborators with other locales agree.
export const russianFunctions=Object.freeze({
  SUM:'СУММ',AVERAGE:'СРЗНАЧ',MIN:'МИН',MAX:'МАКС',COUNT:'СЧЁТ',COUNTA:'СЧЁТЗ',COUNTBLANK:'СЧИТАТЬПУСТОТЫ',
  IF:'ЕСЛИ',IFS:'ЕСЛИМН',IFERROR:'ЕСЛИОШИБКА',IFNA:'ЕСНД',AND:'И',OR:'ИЛИ',NOT:'НЕ',TRUE:'ИСТИНА',FALSE:'ЛОЖЬ',XOR:'ИСКЛИЛИ',SWITCH:'ПЕРЕКЛЮЧ',
  SUMIF:'СУММЕСЛИ',SUMIFS:'СУММЕСЛИМН',COUNTIF:'СЧЁТЕСЛИ',COUNTIFS:'СЧЁТЕСЛИМН',AVERAGEIF:'СРЗНАЧЕСЛИ',AVERAGEIFS:'СРЗНАЧЕСЛИМН',
  ABS:'ABS',ROUND:'ОКРУГЛ',ROUNDUP:'ОКРУГЛВВЕРХ',ROUNDDOWN:'ОКРУГЛВНИЗ',INT:'ЦЕЛОЕ',MOD:'ОСТАТ',POWER:'СТЕПЕНЬ',SQRT:'КОРЕНЬ',PRODUCT:'ПРОИЗВЕД',SUMPRODUCT:'СУММПРОИЗВ',SUBTOTAL:'ПРОМЕЖУТОЧНЫЕ.ИТОГИ',
  RAND:'СЛЧИС',RANDBETWEEN:'СЛУЧМЕЖДУ',PI:'ПИ',SIGN:'ЗНАК',TRUNC:'ОТБР',CEILING:'ОКРВВЕРХ',FLOOR:'ОКРВНИЗ',MROUND:'ОКРУГЛТ',GCD:'НОД',LCM:'НОК',FACT:'ФАКТР',EXP:'EXP',LN:'LN',LOG:'ЛОГ',LOG10:'LOG10',
  VLOOKUP:'ВПР',HLOOKUP:'ГПР',XLOOKUP:'ПРОСМОТРX',LOOKUP:'ПРОСМОТР',INDEX:'ИНДЕКС',MATCH:'ПОИСКПОЗ',XMATCH:'ПОИСКПОЗX',CHOOSE:'ВЫБОР',OFFSET:'СМЕЩ',INDIRECT:'ДВССЫЛ',ROW:'СТРОКА',ROWS:'ЧСТРОК',COLUMN:'СТОЛБЕЦ',COLUMNS:'ЧИСЛСТОЛБ',ADDRESS:'АДРЕС',TRANSPOSE:'ТРАНСП',
  CONCAT:'СЦЕП',CONCATENATE:'СЦЕПИТЬ',TEXTJOIN:'ОБЪЕДИНИТЬ',LEFT:'ЛЕВСИМВ',RIGHT:'ПРАВСИМВ',MID:'ПСТР',LEN:'ДЛСТР',TRIM:'СЖПРОБЕЛЫ',UPPER:'ПРОПИСН',LOWER:'СТРОЧН',PROPER:'ПРОПНАЧ',FIND:'НАЙТИ',SEARCH:'ПОИСК',SUBSTITUTE:'ПОДСТАВИТЬ',REPLACE:'ЗАМЕНИТЬ',TEXT:'ТЕКСТ',VALUE:'ЗНАЧЕН',REPT:'ПОВТОР',EXACT:'СОВПАД',CLEAN:'ПЕЧСИМВ',CHAR:'СИМВОЛ',CODE:'КОДСИМВ',
  DATE:'ДАТА',TODAY:'СЕГОДНЯ',NOW:'ТДАТА',DAY:'ДЕНЬ',MONTH:'МЕСЯЦ',YEAR:'ГОД',TIME:'ВРЕМЯ',HOUR:'ЧАС',MINUTE:'МИНУТЫ',SECOND:'СЕКУНДЫ',WEEKDAY:'ДЕНЬНЕД',WEEKNUM:'НОМНЕДЕЛИ',DATEVALUE:'ДАТАЗНАЧ',TIMEVALUE:'ВРЕМЗНАЧ',EDATE:'ДАТАМЕС',EOMONTH:'КОНМЕСЯЦА',DAYS:'ДНИ',DAYS360:'ДНЕЙ360',NETWORKDAYS:'ЧИСТРАБДНИ',WORKDAY:'РАБДЕНЬ',DATEDIF:'РАЗНДАТ',
  MEDIAN:'МЕДИАНА',LARGE:'НАИБОЛЬШИЙ',SMALL:'НАИМЕНЬШИЙ',RANK:'РАНГ','RANK.EQ':'РАНГ.РВ','STDEV.S':'СТАНДОТКЛОН.В','STDEV.P':'СТАНДОТКЛОН.Г','VAR.S':'ДИСП.В','VAR.P':'ДИСП.Г',CORREL:'КОРРЕЛ',
  ISBLANK:'ЕПУСТО',ISNUMBER:'ЕЧИСЛО',ISTEXT:'ЕТЕКСТ',ISERROR:'ЕОШИБКА',ISNA:'ЕНД',ISLOGICAL:'ЕЛОГИЧ',NA:'НД',TYPE:'ТИП',N:'Ч',
  PMT:'ПЛТ',PV:'ПС',FV:'БС',NPV:'ЧПС',IRR:'ВСД',RATE:'СТАВКА',NPER:'КПЕР',
  FILTER:'ФИЛЬТР',SORT:'СОРТ',SORTBY:'СОРТПО',UNIQUE:'УНИК',SEQUENCE:'ПОСЛЕД',
});
const englishFunctions=new Map(Object.entries(russianFunctions).map(([en,ru])=>[ru,en]));
// Common keyboard spelling without ё is also accepted.
for(const [ru,en] of [...englishFunctions])englishFunctions.set(ru.replaceAll('Ё','Е'),en);
export const blockedFunctions=new Set(['IMPORTXML','IMPORTDATA','IMPORTHTML','IMPORTRANGE','IMAGE','WEBSERVICE','HYPERLINK']);

export function translateFormula(value,toRussian=false){
  if(typeof value!=='string'||!value.startsWith('='))return value;
  let output='',i=0,arrayDepth=0;
  while(i<value.length){
    const character=value[i];
    // Double-quoted strings and single-quoted sheet names escape quotes by doubling.
    if(character==='"'||character==="'"){
      const quote=character,start=i++;
      while(i<value.length){if(value[i++]===quote){if(value[i]===quote)i++;else break;}}
      output+=value.slice(start,i);continue;
    }
    // Structured references and external workbook names are not function tokens.
    if(character==='['){const start=i++;let depth=1;while(i<value.length&&depth){if(value[i]==='[')depth++;if(value[i]===']')depth--;i++;}output+=value.slice(start,i);continue;}
    if(character==='{')arrayDepth++;
    if(character==='}')arrayDepth=Math.max(0,arrayDepth-1);
    if(/[\p{L}_]/u.test(character)){
      const start=i++;while(i<value.length&&/[\p{L}\p{N}_.]/u.test(value[i]))i++;
      const name=value.slice(start,i),rest=value.slice(i),upper=name.toUpperCase();
      output+=/^\s*\(/.test(rest)?(toRussian?russianFunctions[upper]:englishFunctions.get(upper))||name:name;continue;
    }
    output+=!arrayDepth&&(toRussian?character===',':character===';')?(toRussian?';':','):character;i++;
  }
  return output;
}
export const canonicalFormula=value=>translateFormula(value);
export const displayFormula=(value,russian=true)=>translateFormula(value,russian);

// Normalize only actual formula fields, never text values starting with '=' (which
// may have deliberately been entered as plain text). Works for paste and undo too.
export function normalizeFormulaCells(matrix){
  if(!matrix||typeof matrix!=='object')return;
  for(const row of Object.values(matrix)){
    if(!row||typeof row!=='object')continue;
    for(const cell of Object.values(row))if(cell&&typeof cell==='object'&&typeof cell.f==='string')cell.f=canonicalFormula(cell.f);
  }
}
export function availableFunctions(service){
  return [...service.getExecutors().keys()].filter(name=>!blockedFunctions.has(name)).sort().map(name=>({name,localName:russianFunctions[name]||name,description:service.getDescription(name)}));
}

export function sheetInputValue(value,textFormat=false){
  if(value.startsWith("'"))return {v:value.slice(1),t:1,f:null,p:null};
  if(value.startsWith('='))return {f:canonicalFormula(value),v:null,p:null};
  if(textFormat)return {v:value,t:1,f:null,p:null};
  if(value==='')return {v:null,f:null,p:null};
  if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())){
    const number=Number(value);if(Number.isFinite(number))return number;
  }
  if(/^(TRUE|ИСТИНА)$/i.test(value))return true;
  if(/^(FALSE|ЛОЖЬ)$/i.test(value))return false;
  return value;
}
