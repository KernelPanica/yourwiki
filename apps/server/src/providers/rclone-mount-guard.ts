import {readFileSync} from 'node:fs';
import {ProviderError} from './adapter.ts';
function mountId(root:string,info:string):string|undefined{for(const line of info.split('\n')){const [left,right]=line.split(' - ');if(!right)continue;const fields=left.split(' '),path=fields[4]?.replace(/\\([0-7]{3})/g,(_,octal:string)=>String.fromCharCode(parseInt(octal,8)));if(path===root&&right.split(' ')[0]==='fuse.rclone')return fields[0];}return undefined;}
export function rcloneMounted(root:string,info:string){return mountId(root,info)!==undefined;}
export function assertRcloneMounted(root:string,expected?:string):string{let id:string|undefined;try{id=mountId(root,readFileSync('/proc/self/mountinfo','utf8'));}catch{}if(!id||expected!==undefined&&id!==expected)throw new ProviderError('PROVIDER_UNAVAILABLE');return id;}
