"""Real opening/cancellation receipts and native MD preparation; no Collabora process."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright,Error as PlaywrightError
ROOT=Path(__file__).resolve().parents[4]
async def main():
 port=int(os.environ.get('YOURWIKI_BROWSER_OPENING_PORT','39184'));base=f'http://127.0.0.1:{port}'
 env={**os.environ,'YOURWIKI_BROWSER_PORT':str(port),'YOURWIKI_BROWSER_CONTROL':'1','YOURWIKI_BROWSER_OFFICE':'1','YOURWIKI_BROWSER_HOLD_OFFICE':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();value=json.loads(await asyncio.wait_for(server.stdout.readline(),15));assert value['ok'],value;return value
 try:
  ready=await asyncio.wait_for(server.stdout.readline(),15)
  if b'Synthetic PDF' not in ready:raise RuntimeError((await server.stderr.read()).decode())
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU');page=await context.new_page();page.set_default_timeout(7000);errors=[];requests=[];cancelled=asyncio.Event();ack=asyncio.Event();successful=asyncio.Event();late=asyncio.Event()
   page.on('pageerror',lambda error:errors.append(str(error)));page.on('request',lambda req:requests.append((req.method,req.url)))
   async def bootstrap(route):
    # Editing is still gated in production. Exercise the identical readonly opening lifecycle.
    body=json.loads(route.request.post_data);body['readonly']=True;headers=dict(route.request.headers);headers.pop('content-length',None);response=await route.fetch(headers=headers,post_data=json.dumps(body))
    if response.status==200:successful.set();await late.wait()
    try:await route.fulfill(response=response)
    except PlaywrightError:
     assert cancelled.is_set() or page.is_closed()
   await page.route('**/api/documents/*/office-opening',bootstrap)
   async def cancel(route):
    response=await route.fetch();assert response.status==204;cancelled.set();await ack.wait();await route.fulfill(response=response)
   await page.route('**/api/auth/office-opening-cancel',cancel)
   await page.goto(base+'/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();docurl=page.url
   for _ in range(100):
    state=await command('opening-state')
    if state['openings']:break
    await asyncio.sleep(.01)
   assert state['openings'][0]['state']=='pending';assert state['tokens']==0
   await page.get_by_role('link',name='Аккаунт',exact=True).click();await asyncio.wait_for(cancelled.wait(),5);state=await command('opening-state');assert state['openings'][0]['state']=='cancelled';assert state['tokens']==0;assert page.url==docurl;assert await page.locator('.office-preview').is_visible();ack.set();await page.wait_for_url('**/account')
   await command('release-discovery');await asyncio.sleep(.1);assert (await command('opening-state'))['tokens']==0
   await page.get_by_role('link',name='Yourwiki·',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await asyncio.wait_for(successful.wait(),7);state=await command('opening-state');assert state['tokens']==1;assert any(row['state']=='ready' for row in state['openings']);assert await page.locator('iframe.office-frame').count()==0
   await page.get_by_role('link',name='Аккаунт',exact=True).click();await page.wait_for_url('**/account');late.set();await asyncio.sleep(.1);state=await command('opening-state');assert state['tokens']==0;assert len(state['openings'])==2;assert all(row['state']=='cancelled' for row in state['openings']);assert not any('save-intents' in url or '/wopi/' in url for method,url in requests);assert not errors,errors
   print(json.dumps({'realOpeningCancellation':'passed','beforeAllocation':True,'afterAllocationBeforeReply':True,'lateReplyFenced':True,'retainedTokens':0,'editorFramesCreated':0,'errors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  await asyncio.wait_for(server.wait(),15)
asyncio.run(main())
