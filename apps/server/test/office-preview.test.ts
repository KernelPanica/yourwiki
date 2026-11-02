import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { BlobStore } from '../src/storage/blobs.ts';
import tar from 'tar-stream';
import { convertOffice, sanitizeOfficeHtml, readOfficeArchive } from '../src/worker/office.ts';
const officeRoot = process.env.YOURWIKI_TEST_OFFICE_ROOT;
const integration = officeRoot ? test : test.skip;
async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'yourwiki-office-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await BlobStore.open(root);
  async function source(name: string) { return store.put(createReadStream(new URL('./fixtures/office/' + name, import.meta.url)), { maxBytes: 1024 ** 2 }); }
  return { store, source };
}

test('office sanitizer preserves merges/styles and rejects active or external resources', () => {
  const html = sanitizeOfficeHtml('<table><tr><td colspan="2" style="color:#ff0000;font-weight:bold;background-image:url(https://evil.test/x)">Merged</td></tr></table><script>evil()</script><img src="https://evil.test/x"><img src="input_html_a.png" onerror="evil()">', new Map([['input_html_a.png','image-1']]));
  assert.match(html, /colspan="2"/); assert.match(html, /font-weight:bold/);
  assert.match(html, /src="image-1"/); assert.ok(!html.includes('evil')); assert.ok(!html.includes('background-image'));
});

integration('real DOCX becomes HTML with merged cells and emphasis', async t => {
  const { store, source } = await setup(t);
  const result = await convertOffice(store, await source('document.docx'), 'docx', new AbortController().signal, { officeRoot });
  const html = (await buffer(await store.read(result.artifacts.find(item => item.name === result.primary)!.digest))).toString();
  assert.equal(result.kind, 'document'); assert.match(html, /Yourwiki\s+DOCX fixture/);
  assert.match(html, /colspan="2"/); assert.match(html, /bold\s+sample/);
  assert.ok(result.artifacts.some(item => item.mimeType.startsWith('image/')));
  assert.match(html, /<img[^>]+src="input_html_[^"]+"/);
});

integration('real XLSX and ODS display calculated values, preserving merged cells and sheets', async t => {
  const { store, source } = await setup(t);
  for (const format of ['xlsx','ods']) {
    const result = await convertOffice(store, await source('table.' + format), format, new AbortController().signal, { officeRoot });
    const html = (await buffer(await store.read(result.artifacts[0].digest))).toString();
    assert.equal(result.kind, 'table'); assert.match(html, />7</);
    if (format === 'xlsx') { assert.match(html, /colspan="3"/); assert.match(html, /Second sheet/); }
  }
});

integration('real PPTX yields ordered slides and small thumbnails', async t => {
  const { store, source } = await setup(t);
  const result = await convertOffice(store, await source('slides.pptx'), 'pptx', new AbortController().signal, { officeRoot });
  assert.equal(result.kind, 'presentation');
  const index = JSON.parse((await buffer(await store.read(result.artifacts.find(item => item.name === result.primary)!.digest))).toString());
  assert.equal(index.slides.length, 2); assert.equal(index.slides[0].image, 'slide-1.png');
  assert.ok(result.artifacts.some(item => item.name === 'thumb-2.png'));
  const slide = result.artifacts.find(item => item.name === 'slide-1.png')!;
  const png = await buffer(await store.read(slide.digest));
  assert.equal(png.subarray(1,4).toString(), 'PNG');
});

integration('abort during asynchronous setup never launches office conversion', async t => {
  const { store, source } = await setup(t);
  const original = store.localFile.bind(store), controller = new AbortController();
  store.localFile = async digest => { controller.abort(); return original(digest); };
  const started = Date.now();
  await assert.rejects(convertOffice(store, await source('document.docx'), 'docx', controller.signal, { officeRoot }), (error: any) => error.name === 'AbortError');
  assert.ok(Date.now()-started < 500);
});

integration('native converter observes timeout and presentation page budget', async t => {
  const { store, source } = await setup(t);
  const doc = await source('document.docx');
  await assert.rejects(convertOffice(store, doc, 'docx', new AbortController().signal, { officeRoot, timeoutMs: 1 }), /CONVERSION_TIMEOUT/);
  const deck = await source('slides.pptx');
  await assert.rejects(convertOffice(store, deck, 'pptx', new AbortController().signal, { officeRoot, maxSlides: 1 }), /PREVIEW_TOO_COMPLEX/);
});

test('office output rejects path traversal, links and excess declared bytes', async t => {
  const { store } = await setup(t);
  for (const header of [
    { name: '../escape.html', size: 1 },
    { name: 'linked.html', type: 'symlink' as const, linkname: '/etc/passwd', size: 0 },
    { name: 'large.html', size: 5 },
  ]) {
    const pack = tar.pack();
    if (header.type === 'symlink') pack.entry(header);
    else pack.entry(header, Buffer.alloc(header.size));
    pack.finalize();
    await assert.rejects(readOfficeArchive(store, Readable.from(pack as AsyncIterable<Uint8Array>), new AbortController().signal, 4), /INVALID_CONVERTER_OUTPUT/);
  }
});
