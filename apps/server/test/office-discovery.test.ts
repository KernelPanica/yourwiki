import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OfficeDiscovery} from '../src/office/discovery.ts';
const xml=(actions:string)=>`<?xml version="1.0"?><wopi-discovery><net-zone name="external-https"><app name="writer">${actions}</app></net-zone></wopi-discovery>`;
const action=(ext='docx',name='edit',url='https://untrusted.example/collabora/browser/build/cool.html?bad=1')=>`<action ext="${ext}" name="${name}" urlsrc="${url.replaceAll('&','&amp;')}"/>`;
test('discovery single-flights, caches bounded XML and rebuilds actions on the configured public origin',async()=>{
 let calls=0;const discovery=new OfficeDiscovery({publicUrl:'https://wiki.example/collabora',internalUrl:'http://collabora:9980/collabora',fetch:async(url,options)=>{
  calls++;assert.equal(String(url),'http://collabora:9980/collabora/hosting/discovery');assert.equal(options?.redirect,'error');return new Response(xml(action()+action('docx','view')));
 }});
 const result=await Promise.all([discovery.action('docx',true),discovery.action('docx',false)]);assert.deepEqual(result,['https://wiki.example/collabora/browser/build/cool.html','https://wiki.example/collabora/browser/build/cool.html']);assert.equal(calls,1);
 await discovery.action('docx',true);assert.equal(calls,1);
});
test('invalid XML, DTD, oversized bodies and foreign service roots are rejected',async()=>{
 for(const body of ['<!DOCTYPE x [<!ENTITY a "boom">]><wopi-discovery/>','<invalid',xml(action('docx','edit','https://host/other/browser/build/cool.html')),xml(action())+' '.repeat(2*1024*1024)]){
  const discovery=new OfficeDiscovery({publicUrl:'https://wiki.example/collabora',fetch:async()=>new Response(body)});await assert.rejects(discovery.action('docx',true),/INVALID_OFFICE_DISCOVERY/);
 }
});
test('failed discovery does not poison retries; view may use edit while unsupported edit never uses view',async()=>{
 let calls=0;const discovery=new OfficeDiscovery({publicUrl:'https://wiki.example/collabora',fetch:async()=>{if(++calls===1)throw new Error('private network detail');return new Response(xml(action('docx','view')));}});
 await assert.rejects(discovery.action('docx',true),/OFFICE_UNAVAILABLE/);await assert.rejects(discovery.action('docx',true),/UNSUPPORTED_OFFICE_FORMAT/);assert.equal(calls,2);
 assert.match(await discovery.action('docx',false),/cool.html$/);
});
test('stalled discovery connection and body are bounded by one timeout',async()=>{
 for(const fetcher of [async()=>await new Promise<Response>(()=>{}),async()=>new Response(new ReadableStream<Uint8Array>({start(){}}))]){
  const discovery=new OfficeDiscovery({publicUrl:'https://wiki.example/collabora',fetch:fetcher,timeoutMs:20});await assert.rejects(discovery.action('docx',true),/OFFICE_UNAVAILABLE/);
 }
});
test('cache expiry refreshes discovery and never follows redirect responses',async()=>{
 let now=0,calls=0;const discovery=new OfficeDiscovery({publicUrl:'https://wiki.example/collabora',clock:()=>now,fetch:async()=>{calls++;return new Response(xml(action()));}});
 await discovery.action('docx',true);now=300000;await discovery.action('docx',true);assert.equal(calls,2);
 const redirect=new OfficeDiscovery({publicUrl:'https://wiki.example/collabora',fetch:async()=>new Response(null,{status:302,headers:{location:'https://private.example'}})});await assert.rejects(redirect.action('docx',true),/OFFICE_UNAVAILABLE/);
});
