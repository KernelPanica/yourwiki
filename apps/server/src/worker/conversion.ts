import {validateGraph,graphBytes,decode} from '../content-parity/validation.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { buffer } from 'node:stream/consumers';
import type { BlobRef, BlobStore } from '../storage/blobs.ts';
import { BlobTooLargeError } from '../storage/blobs.ts';
import type { PreviewArtifact, PreviewManifest } from '../documents.ts';

import { ConversionError } from './errors.ts';
export { ConversionError } from './errors.ts';
import { convertOffice, officeFormats } from './office.ts';
import type { OfficeOptions } from './office.ts';

export interface ConversionOptions { nativeMarkdown?: boolean; textLimit?: number; outputLimit?: number; timeoutMs?: number; office?: OfficeOptions }
export type ConversionResult = { kind: PreviewManifest['kind']; primary: string; artifacts: PreviewArtifact[] };

export async function convert(store: BlobStore, source: BlobRef, format: string, signal: AbortSignal, options: ConversionOptions = {}, target: BlobStore = store): Promise<ConversionResult> {
  signal.throwIfAborted();
  if (format === 'canvas' || format === 'drawio') {
    if(source.size>graphBytes)throw new ConversionError('PREVIEW_TOO_COMPLEX');
    const chunks:Buffer[]=[];let size=0;const stream=await store.read(source.digest);
    try{for await(const chunk of stream){signal.throwIfAborted();size+=chunk.length;if(size>graphBytes)throw new ConversionError('PREVIEW_TOO_COMPLEX');chunks.push(Buffer.from(chunk));}}finally{stream.destroy();}
    try{validateGraph(decode(Buffer.concat(chunks)),format);}catch{throw new ConversionError('INVALID_GRAPH');}
    const artifact=target===store?source:await target.put((async function*(){yield Buffer.concat(chunks);})(),{maxBytes:graphBytes,signal});
    return {kind:format,primary:'content',artifacts:[{...artifact,name:'content',mimeType:format==='canvas'?'application/json':'text/plain'}]};
  }
  if (officeFormats.has(format)) return convertOffice(store, source, format, signal, options.office, target);
  if (format === 'pdf') {
    const prefix = source.size ? (await buffer(await store.read(source.digest, { start: 0, end: Math.min(1023, source.size - 1) }))).toString('latin1') : '';
    if (!prefix.includes('%PDF-')) throw new ConversionError('INVALID_PDF');
    return { kind: 'pdf', primary: 'content', artifacts: [{ ...source, name: 'content', mimeType: 'application/pdf' }] };
  }
  if (!['md', 'markdown', 'txt', 'text'].includes(format)) throw new ConversionError('PREVIEW_UNSUPPORTED');
  const textLimit = options.textLimit ?? 16 * 1024 ** 2;
  if (source.size > textLimit) throw new ConversionError('PREVIEW_TOO_COMPLEX');
  const child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./text-process.ts', import.meta.url)), format, String(textLimit), options.nativeMarkdown===false?'plain-v1':'native-v1'], {
    shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'production' },
  });
  let timedOut = false, stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 256) stderr += chunk.toString().slice(0, 256 - stderr.length); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const abort = () => { child.kill('SIGKILL'); };
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs ?? 30_000);
  try {
    const input = (async () => { await pipeline(await store.read(source.digest), child.stdin); })().catch(error => { abort(); throw error; });
    const output = target.put(child.stdout, { maxBytes: options.outputLimit ?? 64 * 1024 ** 2, signal }).catch(error => { abort(); throw error; });
    const [inputResult, outputResult, exitResult] = await Promise.allSettled([input, output, exit]);
    signal.throwIfAborted();
    if (timedOut) throw new ConversionError('CONVERSION_TIMEOUT', false);
    if (exitResult.status === 'rejected') throw new ConversionError('CONVERTER_UNAVAILABLE', false);
    if (outputResult.status === 'rejected' && outputResult.reason instanceof BlobTooLargeError) throw new ConversionError('PREVIEW_TOO_COMPLEX');
    if (exitResult.value !== 0) {
      const known = ['INVALID_TEXT_ENCODING', 'PREVIEW_TOO_COMPLEX', 'INVALID_CONVERTER_REQUEST', 'INVALID_NATIVE_DOCUMENT'];
      throw new ConversionError(known.includes(stderr) ? stderr : 'CONVERSION_FAILED', known.includes(stderr));
    }
    if (inputResult.status === 'rejected' || outputResult.status === 'rejected') throw new ConversionError('CONVERSION_IO_FAILED', false);
    if (outputResult.value.size === 0) throw new ConversionError('CONVERSION_FAILED', false);
    return { kind: 'document', primary: 'content', artifacts: [{ ...outputResult.value, name: 'content', mimeType: 'text/html' }] };
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null) abort();
  }
}
