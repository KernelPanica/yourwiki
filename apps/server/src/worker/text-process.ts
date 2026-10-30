// Runs only as an isolated subprocess, never imported by the HTTP runtime.
import MarkdownIt from 'markdown-it';

const [format, limitValue] = process.argv.slice(2);
const limit = Number(limitValue);
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
try {
  if (!['md', 'markdown', 'txt', 'text'].includes(format) || !Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_CONVERTER_REQUEST');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error('PREVIEW_TOO_COMPLEX');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  let html: string;
  if (format === 'md' || format === 'markdown') {
    const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
    // External images must not leak private viewing activity. Attachment images
    // will be resolved through authenticated document references in a later step.
    md.renderer.rules.image = (tokens, index) => escape(tokens[index].content);
    html = md.render(text);
  } else html = '<pre>' + escape(text) + '</pre>';
  process.stdout.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + html + '</body></html>');
} catch (error) {
  const code = error instanceof TypeError ? 'INVALID_TEXT_ENCODING' : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CONVERSION_FAILED';
  process.stderr.write(code);
  process.exitCode = 1;
}
