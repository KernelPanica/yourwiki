import {stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
/** Reuse the local client assets shipped by Docker or the native installation. */
export async function resolveDrawioAssets(configured?:string,bundled=fileURLToPath(new URL('../../../../wiki/static/drawio',import.meta.url))){
 const root=configured??bundled;if(!isAbsolute(root))throw new Error('Draw.io assets require an absolute directory');
 try{for(const name of ['index.html','js/PostConfig.js'])if(!(await stat(join(root,name))).isFile())throw new Error('Incomplete draw.io assets');return root;}
 catch(error){if(configured)throw error;return undefined;}
}
