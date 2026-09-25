import { build } from 'esbuild';
const result=await build({entryPoints: ['frontend/editor.js'], bundle: true, minify: true, metafile:true,
  outdir: 'wiki/static/wiki/dist', format: 'esm', splitting:true, target: 'es2022',
  loader: {'.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'dataurl'},
  define: {'process.env.NODE_ENV': '"production"'}});
if(Object.keys(result.metafile.inputs).some(path=>path.includes('@univerjs-pro/')))throw new Error('Commercial Univer packages must not enter the editor build.');
