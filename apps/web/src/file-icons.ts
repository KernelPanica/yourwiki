/** Shared by the explorer and search results. Unknown extensions retain a file icon. */
export function fileIcon(format?:string,title=''){
 const extension=(format||title.split('.').pop()||'').toLowerCase().replace(/^\./,'');
 if(['doc','docx','odt','rtf','txt','gdoc','document'].includes(extension))return 'document';
 if(['xls','xlsx','ods','csv','tsv','gsheet','spreadsheet'].includes(extension))return 'spreadsheet';
 if(['ppt','pptx','odp','gslides','presentation'].includes(extension))return 'presentation';
 if(['md','markdown'].includes(extension))return 'markdown';
 if(extension==='pdf')return 'pdf';
 if(extension==='canvas')return 'canvas';
 if(['drawio','dio'].includes(extension))return 'diagram';
 if(['png','jpg','jpeg','gif','webp','avif','svg','bmp','heic'].includes(extension))return 'image';
 if(['zip','gz','7z','rar','tar'].includes(extension))return 'archive';
 if(['ts','tsx','js','jsx','json','html','css','xml','yaml','yml','sh'].includes(extension))return 'code';
 return 'files';
}
