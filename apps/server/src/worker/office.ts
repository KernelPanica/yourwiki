import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buffer } from 'node:stream/consumers';
import tar from 'tar-stream';
import sanitizeHtml from 'sanitize-html';
import type { BlobStore, BlobRef } from '../storage/blobs.ts';
import type { PreviewArtifact } from '../documents.ts';
import { ConversionError } from './errors.ts';
import type { ConversionResult } from './conversion.ts';

export const officeFormats = new Set(['doc','docx','docm','dotx','dotm','odt','ott','rtf','fodt','xlsx','xls','xlsm','xltx','xltm','xlsb','ods','ots','fods','csv','tsv','ppt','pptx','pptm','ppsx','potx','potm','odp','otp','fodp']);
const sheets = new Set(['xlsx','xls','xlsm','xltx','xltm','xlsb','ods','ots','fods','csv','tsv']);
const decks = new Set(['ppt','pptx','pptm','ppsx','potx','potm','odp','otp','fodp']);
export interface OfficeOptions { officeRoot?: string; bwrap?: string; prlimit?: string; timeoutMs?: number; outputLimit?: number; maxSlides?: number }

export function sanitizeOfficeHtml(html: string, images: Map<string, string>): string {
  return sanitizeHtml(html, {
    allowedTags: ['p','div','span','h1','h2','h3','h4','h5','h6','b','strong','i','em','u','s','sup','sub','pre','code','blockquote','ul','ol','li','br','hr','a','table','caption','thead','tbody','tfoot','tr','td','th','col','colgroup','font','img'],
    allowedAttributes: { '*': ['style','id'], a: ['href','name'], td: ['colspan','rowspan','width','height','align','valign','bgcolor'], th: ['colspan','rowspan','width','height','align','valign','bgcolor'],
      table: ['border','cellspacing','cellpadding','width'], col: ['width','span'], font: ['face','size','color'], img: ['src','alt','width','height'] },
    allowedSchemes: ['http','https','mailto'], allowedSchemesByTag: { img: [] }, allowProtocolRelative: false,
    allowedStyles: { '*': {
      'color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i], 'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
      'font-family': [/^[a-z0-9 ,"'-]{1,150}$/i], 'font-size': [/^\d+(?:\.\d+)?(?:pt|px|em|%)$/], 'font-weight': [/^(?:normal|bold|[1-9]00)$/], 'font-style': [/^(?:normal|italic)$/],
      'text-align': [/^(?:left|right|center|justify)$/], 'vertical-align': [/^(?:top|middle|bottom|baseline)$/], 'text-decoration': [/^(?:none|underline|line-through)$/],
      'width': [/^\d+(?:\.\d+)?(?:pt|px|cm|in|%)$/], 'height': [/^\d+(?:\.\d+)?(?:pt|px|cm|in|%)$/],
      'border': [/^[0-9.]+(?:pt|px) (?:solid|dashed|dotted) #[0-9a-f]{3,8}$/i],
      'padding': [/^\d+(?:\.\d+)?(?:pt|px|cm|in)(?: \d+(?:\.\d+)?(?:pt|px|cm|in)){0,3}$/],
    } },
    transformTags: { img: (_tag, attributes) => {
      const source = attributes.src ?? '';
      // Reject external/absolute/path-traversing references before basename.
      const name = /^[a-z0-9_.-]+$/i.test(source) ? images.get(source) : undefined;
      const attribs: Record<string,string> = name ? { ...attributes, src: name } : { alt: attributes.alt ?? '' };
      return { tagName: 'img', attribs };
    } },
  });
}

export async function readOfficeArchive(store: BlobStore, source: Readable, signal: AbortSignal, limit: number): Promise<PreviewArtifact[]> {
  const extract = tar.extract(), artifacts: PreviewArtifact[] = [];
  let total = 0, entries = 0;
  extract.on('entry', (header, stream, next) => {
    // extract.destroy() also destroys its active entry stream. Observe that
    // error even when a rejected header never reaches the blob reader.
    stream.on('error', () => {});
    const name = header.name.replace(/^\.\//,'');
    if (header.type === 'directory' && (name === '.' || name === '')) { stream.resume(); next(); return; }
    if (header.type !== 'file' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(name) || ++entries > 1024 || !Number.isSafeInteger(header.size) || header.size! < 0 || header.size! > limit-total || artifacts.some(item => item.name === name)) {
      extract.destroy(new ConversionError('INVALID_CONVERTER_OUTPUT')); stream.resume(); return;
    }
    total += header.size!;
    void store.put(stream as AsyncIterable<Uint8Array>, { maxBytes: header.size!, signal }).then(ref => {
      if (ref.size !== header.size) throw new ConversionError('INVALID_CONVERTER_OUTPUT');
      artifacts.push({ ...ref, name, mimeType: name.endsWith('.png') ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : name.endsWith('.gif') ? 'image/gif' : 'application/octet-stream' }); next();
    }).catch(error => { extract.destroy(error); });
  });
  await pipeline(source, extract);
  return artifacts;
}

const profile = '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>';

export async function convertOffice(store: BlobStore, source: BlobRef, format: string, signal: AbortSignal, options: OfficeOptions = {}, target: BlobStore = store): Promise<ConversionResult> {
  if (process.platform !== 'linux' || !officeFormats.has(format)) throw new ConversionError('PREVIEW_UNSUPPORTED');
  signal.throwIfAborted();
  const root = options.officeRoot ?? '/usr/lib/libreoffice', bwrap = options.bwrap ?? '/usr/bin/bwrap', prlimit = options.prlimit ?? '/usr/bin/prlimit';
  if (![root,bwrap,prlimit].every(isAbsolute)) throw new ConversionError('CONVERTER_UNAVAILABLE');
  try { for (const path of [join(root,'program','soffice'), bwrap, prlimit, '/usr/bin/tar','/usr/bin/pdfinfo','/usr/bin/pdftoppm']) if (!(await stat(path)).isFile()) throw new Error(); }
  catch { throw new ConversionError('CONVERTER_UNAVAILABLE', false); }
  const limit = options.outputLimit ?? 64 * 1024 ** 2, slidesLimit = options.maxSlides ?? 200;
  for (const value of [limit, slidesLimit, options.timeoutMs ?? 120_000]) if (!Number.isSafeInteger(value) || value < 1) throw new ConversionError('INVALID_CONVERTER_REQUEST');
  const presentation = decks.has(format), table = sheets.has(format);
  const work = await mkdtemp(join(tmpdir(), 'yourwiki-office-'));
  try {
    const runner = join(work,'runner.sh'), registry = join(work,'registry.xcu');
    const filter = presentation ? 'pdf:impress_pdf_Export' : table ? 'html:HTML (StarCalc)' : 'html:HTML (StarWriter)';
    const script = `#!/bin/sh
set -eu
/opt/office/program/soffice -env:UserInstallation=file:///profile --headless --nologo --nodefault --norestore --convert-to '${filter}' --outdir /out /input.${format} >&2
` + (presentation ? `test -s /out/input.pdf
pages=$(/usr/bin/pdfinfo /out/input.pdf | while read -r key value rest; do if [ "$key" = "Pages:" ]; then printf '%s\\n' "$value"; fi; done)
case "$pages" in ''|*[!0-9]*) exit 30;; esac
[ "$pages" -ge 1 ] && [ "$pages" -le ${slidesLimit} ] || exit 31
i=1
while [ "$i" -le "$pages" ]; do
/usr/bin/pdftoppm -f "$i" -l "$i" -singlefile -png -scale-to 1600 /out/input.pdf "/out/slide-$i"
/usr/bin/pdftoppm -f "$i" -l "$i" -singlefile -png -scale-to 240 /out/input.pdf "/out/thumb-$i"
i=$((i+1))
done
rm /out/input.pdf
` : 'test -s /out/input.html\n') + 'exec /usr/bin/tar -C /out -cf - .\n';
    await writeFile(runner, script, { mode: 0o400 }); await writeFile(registry, profile, { mode: 0o400 });
    const args = ['--as=8589934592', `--fsize=${limit}`, '--cpu=90', '--', bwrap, '--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL',
      '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
      '--ro-bind','/etc/fonts','/etc/fonts','--ro-bind-try','/etc/libreoffice','/etc/libreoffice','--ro-bind',root,'/opt/office','--ro-bind',await store.localFile(source.digest),`/input.${format}`,
      '--ro-bind',runner,'/runner.sh','--proc','/proc','--dev','/dev','--size','67108864','--tmpfs','/tmp',
      '--size','33554432','--tmpfs','/profile','--dir','/profile/user','--ro-bind',registry,'/profile/user/registrymodifications.xcu',
      '--size',String(limit),'--tmpfs','/out','--setenv','HOME','/profile','--setenv','TMPDIR','/tmp','--setenv','MALLOC_ARENA_MAX','2','--setenv','MAX_CONCURRENCY','2','--setenv','OMP_NUM_THREADS','1','--setenv','SAL_DISABLE_OPENCL','1','--setenv','LANG','C.UTF-8','--setenv','PATH','/usr/bin:/bin',
      '/bin/sh','/runner.sh'];
    signal.throwIfAborted();
    const child = spawn(prlimit, args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore','pipe','pipe'], detached: true });
    let timedOut = false, errorOutput = '';
    child.stderr.on('data', bytes => { if (errorOutput.length < 4096) errorOutput += bytes.toString().slice(0,4096-errorOutput.length); });
    const exit = new Promise<number | null>((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    signal.addEventListener('abort',kill,{ once: true });
    if (signal.aborted) kill();
    const timeout = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 120_000);
    try {
      const output = readOfficeArchive(target, child.stdout, signal, limit).catch(error => { kill(); throw error; });
      const [outputResult, exitResult] = await Promise.allSettled([output, exit]);
      signal.throwIfAborted();
      if (timedOut) throw new ConversionError('CONVERSION_TIMEOUT', false);
      if (exitResult.status === 'rejected') throw new ConversionError('CONVERTER_UNAVAILABLE', false);
      if (exitResult.value !== 0) {
        if (exitResult.value === 31 || /No space left|File size limit/i.test(errorOutput)) throw new ConversionError('PREVIEW_TOO_COMPLEX');
        throw new ConversionError('OFFICE_CONVERSION_FAILED');
      }
      if (outputResult.status === 'rejected') throw outputResult.reason;
      const artifacts = outputResult.value;
      async function* bytes(value: string) { yield Buffer.from(value); }
      if (presentation) {
        const slides = artifacts.filter(item => /^slide-\d+\.png$/.test(item.name)).sort((a,b) => Number(a.name.match(/\d+/)![0])-Number(b.name.match(/\d+/)![0]));
        if (!slides.length || slides.length > slidesLimit || slides.some((item,index) => item.name !== `slide-${index+1}.png` || !artifacts.some(thumb => thumb.name === `thumb-${index+1}.png`))) throw new ConversionError('INVALID_CONVERTER_OUTPUT');
        const index = { schemaVersion: 1, slides: slides.map((item,i) => ({ index: i+1, image: item.name, thumbnail: `thumb-${i+1}.png` })) };
        const ref = await target.put(bytes(JSON.stringify(index)), { maxBytes: limit, signal });
        return { kind: 'presentation', primary: 'content', artifacts: [{ ...ref, name: 'content', mimeType: 'application/json' }, ...artifacts] };
      }
      const html = artifacts.find(item => item.name === 'input.html');
      if (!html || html.size > Math.min(limit,16*1024**2)) throw new ConversionError('PREVIEW_TOO_COMPLEX');
      const images = new Map(artifacts.filter(item => item.mimeType.startsWith('image/')).map(item => [item.name,item.name]));
      const clean = sanitizeOfficeHtml((await buffer(await target.read(html.digest))).toString(), images);
      const ref = await target.put(bytes('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+clean), { maxBytes: limit, signal });
      return { kind: table ? 'table' : 'document', primary: 'content', artifacts: [{ ...ref, name: 'content', mimeType: 'text/html' }, ...artifacts.filter(item => images.has(item.name))] };
    } finally { clearTimeout(timeout); signal.removeEventListener('abort',kill); if (child.exitCode === null && child.signalCode === null) kill(); }
  } finally { await rm(work,{ recursive: true, force: true }); }
}
