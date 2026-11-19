import type {RecentDocuments} from '../recent.ts';

export const recentMetricsBlock = 'yourwiki-metrics';

const formats = [
  ['doc','docx','odt','rtf','txt','text','md','markdown','gdoc'],
  ['xls','xlsx','ods','csv','tsv','gsheet'],
  ['ppt','pptx','odp','gslides'],
  ['pdf'],
];

export function renderRecentMetrics(recent:RecentDocuments,userId:string,language:'ru'|'en'){
  const {items} = recent.list(userId,{limit:200});
  const ru = language === 'ru';
  const title = ru ? 'Мои недавние документы по типам' : 'My recent documents by type';
  if (!items.length) {
    const empty = ru ? 'Здесь появится диаграмма после открытия документов.' : 'Open documents to see a chart here.';
    return `<figure class="wiki-metrics"><figcaption>${title}</figcaption><p>${empty}</p></figure>`;
  }

  const counts = [0,0,0,0,0];
  for (const {format} of items) {
    const index = formats.findIndex(group=>group.includes(format));
    counts[index === -1 ? 4 : index]!++;
  }
  const labels = ru ? ['Текст','Таблицы','Презентации','PDF','Другие'] : ['Text','Spreadsheets','Presentations','PDF','Other'];
  const rows = labels.map((label,index) =>
    `<label class="wiki-metrics-row"><span>${label}</span><meter max="${items.length}" value="${counts[index]}"></meter><span>${counts[index]}</span></label>`
  ).join('');
  return `<figure class="wiki-metrics"><figcaption>${title}</figcaption>${rows}</figure>`;
}
