import {basename} from 'node:path';
type Output={imports?:readonly {path:string;kind:string;external?:boolean}[]};
/** Public immutable modules only. Optional editor imports remain lazy. */
export function modulePreloads(outputs:Record<string,Output>,entry:string):string[]{
 const seen=new Set<string>([entry]),names:string[]=[];
 function visit(path:string){
  const output=outputs[path];if(!output)throw new Error('Missing static module output');
  for(const item of output.imports??[]){if(item.external||item.kind!=='import-statement'||!item.path.endsWith('.js')||seen.has(item.path))continue;seen.add(item.path);names.push(basename(item.path));visit(item.path);}
 }
 visit(entry);return names;
}
