"""Abrupt page loss versus real authenticated WOPI handoff; engine page is a fixture, not CODE."""
import asyncio,json,os
from pathlib import Path
from urllib.parse import parse_qs,urlsplit,urlencode
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[4]
async def main():
 port=int(os.environ.get('YOURWIKI_BROWSER_HANDOFF_PORT','39185'));base=f'http://127.0.0.1:{port}'
 env={**os.environ,'YOURWIKI_BROWSER_PORT':str(port),'YOURWIKI_BROWSER_CONTROL':'1','YOURWIKI_BROWSER_OFFICE':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();value=json.loads(await asyncio.wait_for(server.stdout.readline(),15));assert value['ok'],value;return value
 try:
  ready=await asyncio.wait_for(server.stdout.readline(),15)
  if b'Synthetic PDF' not in ready:raise RuntimeError((await server.stderr.read()).decode())
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU');page=await context.new_page();page.set_default_timeout(7000);errors=[];opened=[];claim_engine=False
   page.on('pageerror',lambda error:errors.append(str(error)))
   async def bootstrap(route):
    body=json.loads(route.request.post_data);body['readonly']=True;headers=dict(route.request.headers);headers.pop('content-length',None);response=await route.fetch(headers=headers,post_data=json.dumps(body));assert response.status==200;value=await response.json();assert value['handoffExpiresAt']>0;opened.append(value);await route.fulfill(response=response)
   await context.route('**/api/documents/*/office-opening',bootstrap)
   async def engine(route):
    data=parse_qs(route.request.post_data);source=parse_qs(urlsplit(route.request.url).query)['WOPISrc'][0];url=source+'?'+urlencode({'access_token':data['access_token'][0]})
    script=('fetch('+json.dumps(url)+').then(r=>{if(!r.ok)throw Error("WOPI metadata failed");return r.json();}).then(()=>parent.postMessage({MessageId:"App_LoadingStatus",Values:{Status:"Document_Loaded"}},location.origin));') if claim_engine else ''
    await route.fulfill(content_type='text/html',body='<html><body><p>Fixture engine</p><script>'+script+'</script></body></html>')
   await context.route('**/collabora/browser/build/cool.html?*',engine)
   await page.goto(base+'/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();docurl=page.url
   await page.frame_locator('iframe.office-frame').get_by_text('Fixture engine',exact=True).wait_for(state='attached');assert len(opened)==1;state=await command('opening-state');assert state['tokens']==1;assert state['openings'][0]['claimed_at'] is None;await page.close()
   claim_engine=True;live=await context.new_page();live.on('pageerror',lambda error:errors.append(str(error)));await live.goto(docurl);await live.locator('.office-workspace[data-loaded="true"]').wait_for();assert len(opened)==2;state=await command('opening-state');assert state['tokens']==2;assert sum(row['claimed_at'] is not None for row in state['openings'])==1
   account=await (await live.request.get(base+'/api/account')).json();csrf=account['csrf'];docid=docurl.split('/')[-1];legacy=await live.request.post(base+'/api/documents/'+docid+'/office-opening',headers={'origin':base,'x-csrf-token':csrf,'x-yourwiki-office-open':'legacy-handoff-browser-123'},data={'readonly':True});assert legacy.status==200;legacy_body=await legacy.json();assert 'handoffExpiresAt' not in legacy_body
   await command('expire-handoffs');state=await command('opening-state');assert state['tokens']==2;assert sum(row['state']=='cancelled' for row in state['openings'])==1
   def info(value):return base+'/wopi/files/'+value['sessionId']+'?'+urlencode({'access_token':value['accessToken']})
   assert (await live.request.get(info(opened[0]))).status==401;assert (await live.request.get(info(opened[1]))).status==200;assert (await live.request.get(info(legacy_body))).status==200
   scoped=await live.request.post(base+'/api/office/'+opened[1]['sessionId']+'/status',headers={'origin':base,'x-csrf-token':csrf},data={'accessToken':opened[1]['accessToken']});assert not (await scoped.json())['expired'];assert (await (await live.request.get(base+'/api/documents/'+docid)).json())['revision']==1;assert not errors,errors
   print(json.dumps({'realWopiHandoff':'passed','abruptPageLossReaped':True,'claimedPeerPreserved':True,'legacyPreserved':True,'originalRevision':1,'errors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  await asyncio.wait_for(server.wait(),15)
asyncio.run(main())
