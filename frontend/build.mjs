import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const result=await build({entryPoints: ['frontend/editor.js', 'frontend/pdf.js'], bundle: true, minify: true, metafile:true,
  outdir: 'wiki/static/wiki/dist', format: 'esm', splitting:true, target: 'es2022',
  loader: {'.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'dataurl', '.gif': 'dataurl'},
  plugins: [{name: 'namespace-pdf-sidebar', setup(build) {
    build.onLoad({filter: /pdfjs-dist\/web\/pdf_viewer\.css$/}, async ({path}) => ({
      contents: (await readFile(path, 'utf8')).replaceAll('.sidebar{', '.pdf-frame .sidebar{'),
      loader: 'css', resolveDir: dirname(path),
    }));
  }}],
  define: {'process.env.NODE_ENV': '"production"'}});
if(Object.keys(result.metafile.inputs).some(path=>path.includes('@univerjs-pro/')))throw new Error('Commercial Univer packages must not enter the editor build.');

const pdfAssets = 'wiki/static/wiki/dist/pdf-assets';
await mkdir(pdfAssets, {recursive:true});
await cp('node_modules/pdfjs-dist/build/pdf.worker.mjs', `${pdfAssets}/pdf.worker.mjs`);
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${directory}`, `${pdfAssets}/${directory}`, {recursive:true});
await cp('node_modules/pdfjs-dist/web/images', `${pdfAssets}/images`, {recursive:true});
