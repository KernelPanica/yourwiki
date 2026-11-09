import {readFile} from 'node:fs/promises';
import {DocumentError} from '../document-errors.ts';
/** Trusted bundled blank documents; no conversion, network or Python at runtime. */
export async function blankOfficeSource(format:string):Promise<Buffer>{if(!['docx','xlsx','pptx'].includes(format))throw new DocumentError('INVALID_REQUEST');return readFile(new URL('./templates/blank.'+format,import.meta.url));}
