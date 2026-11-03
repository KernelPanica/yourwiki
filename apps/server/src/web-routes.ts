import {officeUrl} from './office/discovery.ts';
import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join,resolve } from 'node:path';
import { errorEnvelope } from './errors.ts';
type Asset={type:string;size:number;gzipSize:number;brSize:number};
function encoding(value:string|undefined):'br'|'gzip'|null {
  const weights=new Map((value??'').split(',').map(part=>{const [name,...params]=part.trim().split(';');const quality=params.find(p=>p.trim().startsWith('q='));return [name.trim(),quality?Number(quality.trim().slice(2)):1];}));
  const br=weights.get('br')??0,gzip=weights.get('gzip')??0;
  return br>0&&br>=gzip?'br':gzip>0?'gzip':null;
}
export function registerWeb(app:FastifyInstance,webRoot:string,officePublicUrl?:string) {
  const officeOrigin=officePublicUrl?' '+officeUrl(officePublicUrl).origin:'';
  app.register(async web=>{
    const root=resolve(webRoot);
    const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')) as {assets:Record<string,Asset>};
    for(const [name,asset] of Object.entries(manifest.assets))if(! /^(?:pdf-[a-f0-9]{16}\/(?:cmaps\/|standard_fonts\/|wasm\/|images\/)?)?[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)||!['text/javascript','text/css','font/woff2','font/otf','font/ttf','application/octet-stream','application/wasm','image/svg+xml','image/png','image/gif'].includes(asset.type)||![asset.size,asset.gzipSize,asset.brSize].every(size=>Number.isSafeInteger(size)&&size>=0))throw new Error('Invalid web asset manifest');
    const index=await readFile(join(root,'index.html'));
    web.get<{Params:{'*':string}}>('/assets/*',async(request,reply)=>{
      const asset=Object.hasOwn(manifest.assets,request.params['*'])?manifest.assets[request.params['*']]:null;
      if(!asset)return reply.code(404).send(errorEnvelope('NOT_FOUND',request.id));
      const compressed=encoding(request.headers['accept-encoding']);
      reply.type(asset.type).header('cache-control','public, max-age=31536000, immutable').header('vary','Accept-Encoding');
      if(compressed)reply.header('content-encoding',compressed);
      reply.header('content-length',compressed==='br'?asset.brSize:compressed==='gzip'?asset.gzipSize:asset.size);
      return reply.send(createReadStream(join(root,'assets',request.params['*']+(compressed==='br'?'.br':compressed==='gzip'?'.gz':''))));
    });
    const html=async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('text/html').header('content-security-policy',`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'${officeOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'${officeOrigin}; frame-ancestors 'self'`).send(index);
    web.get('/',html);web.get('/documents/:id',html);web.get('/account',html);web.get('/recent',html);web.get('/settings',html);web.get('/dashboard',html);web.get('/folders/:id',html);web.get('/invite',html);
  });
}
