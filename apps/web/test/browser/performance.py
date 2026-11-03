"""Synthetic whole-page benchmark; Chromium emulation is NOT Redmi/iOS validation.
Run tools/performance-run.sh for an enforced 2 CPU / 4 GiB server scope.
The authenticated workload uses 15 distinct pre-created users; password hashing,
Google/Collabora, preview generation, uploads and write conflicts are excluded.
"""
import asyncio,json,math,os,statistics,time
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[4]
INIT=r'''(()=>{const tasks=[];try{new PerformanceObserver(list=>{for(const e of list.getEntries())tasks.push(e.duration)}).observe({type:'longtask',buffered:true})}catch{};
let finishing=false;function check(){const p=location.pathname;let ready=false,frameDocument=null;
const controls=!!document.querySelector('.site-header .sign-out:not(:disabled)')&&document.querySelectorAll('.site-header nav a').length>=3;
if(p==='/')ready=!!document.querySelector('main.library[aria-busy="false"] .file-list li')&&!!document.querySelector('main.library input[type="search"]:not(:disabled)');
else if(p==='/account')ready=!!document.querySelector('.account-page dl dd');
else if(p.startsWith('/documents/')){const frame=document.querySelector('.document-frame');try{frameDocument=frame?.contentDocument;ready=frameDocument?.readyState==='complete'&&!!frameDocument.querySelector('h1')}catch{};
ready=ready||!!document.querySelector('.pdf-container .page[data-loaded="true"] canvas')&&!!document.querySelector('.pdf-container .page[data-loaded="true"] .annotationLayer input:not(:disabled)')&&!!document.querySelector('.pdf-toolbar select:not(:disabled)');}
if(ready&&controls&&!finishing){finishing=true;Promise.all([document.fonts.ready,frameDocument?.fonts?.ready]).then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const nav=performance.getEntriesByType('navigation')[0],resources=performance.getEntriesByType('resource');window.__ywPerformance={readyMs:performance.now(),ttfbMs:nav.responseStart,domMs:nav.domContentLoadedEventEnd,fcpMs:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,longTasks:tasks.length,longTaskTotalMs:tasks.reduce((a,b)=>a+b,0),longTaskMaxMs:Math.max(0,...tasks),resources:resources.filter(e=>!e.name.includes('/events')).map(e=>({path:new URL(e.name).pathname,startMs:e.startTime,endMs:e.responseEnd,wireBytes:e.transferSize,decodedBytes:e.decodedBodySize}))};})));return;}requestAnimationFrame(check)}requestAnimationFrame(check)})();'''
def stats(values):
 values=sorted(values)
 return {'count':len(values),'medianMs':round(statistics.median(values),1),'p95Ms':round(values[max(0,math.ceil(len(values)*.95)-1)],1),'maxMs':round(max(values),1)}
async def main():
 samples=int(os.environ.get('YOURWIKI_PERFORMANCE_SAMPLES','5'))
 assert samples>=3,'At least three samples required'
 report_path=Path(os.environ.get('YOURWIKI_PERFORMANCE_REPORT','/tmp/yourwiki-performance.json'))
 prefix=json.loads(os.environ.get('YOURWIKI_PERFORMANCE_SERVER_PREFIX','[]'))
 server=await asyncio.create_subprocess_exec(*prefix,'node','tools/performance-server.ts',cwd=ROOT,env=os.environ,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 stop=asyncio.Event();load_tasks=[];contexts=[];records=[];request_rows=[];errors=[];load_start=None
 try:
  fixture=json.loads(await asyncio.wait_for(server.stdout.readline(),90));origin=fixture['origin']
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox']);browser_version=browser.version
   async def reader(index):
    context=await p.request.new_context(base_url=origin,extra_http_headers={'cookie':'yourwiki_v2_session='+fixture['sessions'][index]['token']});contexts.append(context)
    iteration=0
    while not stop.is_set():
     document=fixture['md'][(index+iteration)%len(fixture['md'])];view=None
     for kind,path in [('account','/api/account'),('library','/api/documents'),('view','/api/documents/'+document+'/view'),('preview',None)]:
      if kind=='preview':
       if view is None:continue
       path='/api/documents/'+document+'/previews/'+view['document']['manifestDigest']+'/assets/'+view['manifest']['primary']
      started=time.perf_counter()
      try:
       response=await context.get(path,timeout=15000)
       body=await response.body()
       request_rows.append({'kind':kind,'ms':(time.perf_counter()-started)*1000,'status':response.status,'bytes':len(body)})
       if response.status!=200:errors.append({'kind':kind,'status':response.status})
       elif kind=='view':view=json.loads(body)
       elif kind=='account':assert json.loads(body)['user']['id']==fixture['sessions'][index]['id']
       elif kind=='library':
        listing=json.loads(body);assert len(listing['items'])==50 and listing['nextCursor'] is not None,'Expected first 50-item page with continuation'
       elif kind=='preview':assert b'Prepared document' in body
       await response.dispose()
      except Exception as error:errors.append({'kind':kind,'error':type(error).__name__+': '+str(error)})
     iteration+=1
     await asyncio.sleep(.25)
   server.stdin.write(b'metrics\n');await server.stdin.drain();initial_metrics=json.loads(await asyncio.wait_for(server.stdout.readline(),5))
   for index in range(15):load_tasks.append(asyncio.create_task(reader(index)))
   load_start=time.perf_counter();await asyncio.sleep(2)
   context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852})
   await context.add_cookies([{'name':'yourwiki_v2_session','value':fixture['sessions'][0]['token'],'url':origin}]);await context.add_init_script(INIT)
   for name,path in [('library','/'),('account','/account'),('document','/documents/'+fixture['md'][0]),('pdf','/documents/'+fixture['pdf'])]:
    page=await context.new_page();page.on('pageerror',lambda e:errors.append({'browser':str(e)}));cdp=await context.new_cdp_session(page)
    await cdp.send('Emulation.setCPUThrottlingRate',{'rate':4});await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':40,'downloadThroughput':125000000,'uploadThroughput':125000000})
    for cache in ['cold','warm']:
     for run in range(samples):
      if cache=='cold':await cdp.send('Network.clearBrowserCache')
      await page.goto(origin+path,wait_until='domcontentloaded');await page.wait_for_function('() => window.__ywPerformance !== undefined',timeout=30000)
      assert await page.evaluate("document.fonts.check('16px Inter')"),'Inter font is not ready'
      result=await page.evaluate('window.__ywPerformance');result.update({'page':name,'cache':cache,'run':run+1});records.append(result)
      if name=='library':
       search=page.locator('main.library input[type="search"]');await search.fill('__no_fixture_document_matches__');await page.wait_for_function("() => document.querySelectorAll('main.library .file-list li').length===0");await search.fill('')
      if name=='pdf':assert await page.locator('.pdf-toolbar select').first.is_enabled() and await page.locator('.annotationLayer input').first.is_editable()
    if name=='pdf':
     target=ROOT/'output/playwright/performance-pdf-mobile.png';target.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(target))
    await page.close()
   await browser.close()
   # Keep even a very fast run under sustained workload for at least twenty seconds.
   if time.perf_counter()-load_start<20:await asyncio.sleep(20-(time.perf_counter()-load_start))
   stop.set();await asyncio.gather(*load_tasks);load_seconds=time.perf_counter()-load_start
   for context in contexts:await context.dispose()
  server.stdin.write(b'metrics\n');await server.stdin.drain();metrics=json.loads(await asyncio.wait_for(server.stdout.readline(),5))
  summary=[]
  for name in ['library','account','document','pdf']:
   for cache in ['cold','warm']:
    rows=[r for r in records if r['page']==name and r['cache']==cache]
    summary.append({'page':name,'cache':cache,**stats([r['readyMs'] for r in rows]),'over500ms':sum(r['readyMs']>500 for r in rows),'maxLongTaskMs':round(max(r['longTaskMaxMs'] for r in rows),1)})
  cgroup=fixture['cgroup'];enforced=cgroup['cpuMax']=='200000 100000' and cgroup['memoryMax']=='4294967296'
  report={'profile':{'serverLimitsVerified':enforced,'serverCgroup':cgroup,'database':'temporary disk-backed SQLite/WAL','preparedDocuments':fixture['documents'],'viewport':'393x852 (emulation only)','cpuSlowdown':4,'network':'Top-page Chromium CDP nominal latency=40ms, download/upload=125000000 bytes/s; worker-target requests may not inherit this emulation; actual transport loopback HTTP, no TLS/DNS/WAN','targetHardware':False,'browser':'Chromium '+browser_version+' desktop headless; not Android or iOS','concurrentUsers':15,'workload':'15 distinct authenticated API users, four sequential GETs then 250ms think time; browser shares user 0','readiness':'Navigation start through account/data + loaded font set + two animation frames + header controls; MD iframe complete/fonts/h1; PDF first prepared single page canvas/form + enabled zoom select','cold':'Browser HTTP cache cleared before each navigation; server/data/preview already warm','warm':'Subsequent full navigation retaining HTTP cache; account/API still fetched','samplesPerPageCache':samples,'build':{key:value for key,value in json.loads((ROOT/'apps/web/dist/manifest.json').read_text()).items() if key!='assets'},'exclusions':['login/hash throughput','TLS/DNS/remote network','actual Redmi Note 12T/iOS hardware','Google/Collabora sessions','conversion queue','content uploads/edits/history restore (navigation visit metadata is included)','large files and long lists beyond 101 documents']},'summary':summary,'load':{'durationSeconds':round(load_seconds,2),'requests':len(request_rows),'requestsPerSecond':round(len(request_rows)/load_seconds,1),'errors':errors,'endpoints':{kind:stats([r['ms'] for r in request_rows if r['kind']==kind]) for kind in ['account','library','view','preview']},'server':metrics,'initialServer':initial_metrics},'records':records}
  report_path.parent.mkdir(parents=True,exist_ok=True);report_path.write_text(json.dumps(report,indent=2))
  print(json.dumps({'report':str(report_path),'serverLimitsVerified':enforced,'summary':summary,'load':{**report['load'],'errors':len(errors)}}))
  assert not errors,errors[:5]
  if os.environ.get('YOURWIKI_PERFORMANCE_REQUIRE_LIMITS')=='1':assert enforced,cgroup
 finally:
  stop.set()
  if load_tasks:await asyncio.gather(*load_tasks,return_exceptions=True)
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
  if server.returncode not in [0,-15]:print((await server.stderr.read()).decode())
asyncio.run(main())
