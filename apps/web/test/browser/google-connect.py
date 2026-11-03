"""Actual cross-site redirect + Strict cookies + one-shot callback/lost-ACK recovery. Owned providers only."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[4]
async def main():
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/google-connect-browser-server.ts',cwd=ROOT,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def stats():
  server.stdin.write(b'stats\n');await server.stdin.drain();return json.loads(await asyncio.wait_for(server.stdout.readline(),10))
 try:
  assert b'Owned Google' in await asyncio.wait_for(server.stdout.readline(),20)
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852});origin='http://localhost:39099'
   login=await context.request.post(origin+'/api/auth/login',headers={'origin':origin},data={'username':'qa','password':'yourwiki-qa'});assert login.status==200;assert 'SameSite=Strict' in login.headers['set-cookie'];account=await (await context.request.get(origin+'/api/account')).json();headers={'origin':origin,'x-csrf-token':account['csrf']}
   page=await context.new_page();errors=[];completions=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda req:completions.append(req.url) if req.method=='POST' and req.url.endswith('/connect/complete') else None)
   async def begin(revision):
    response=await context.request.post(origin+'/api/admin/google/connect/start',headers=headers,data={'connectionId':'google','baseRevision':revision});assert response.status==200;from urllib.parse import urlparse,parse_qs;return parse_qs(urlparse((await response.json())['authorizationUrl']).query)['state'][0]
   state=await begin(1);await page.goto('http://127.0.0.1:39100/start?state='+state);await page.get_by_role('link',name='Return to Yourwiki').click();await expect(page.get_by_role('status')).to_have_text('Google подключён. Можно вернуться в настройки.');await expect(page.get_by_role('button',name='Проверить результат')).to_be_hidden();assert page.url==origin+'/api/admin/google/oauth/callback';assert len(completions)==1;first=await stats();assert first=={'tokens':1,'gets':2,'callbackCookies':[False],'revision':2},first
   dropped=asyncio.Event()
   async def lost_ack(route):
    response=await route.fetch();assert response.status==200;await route.abort('failed');dropped.set()
   await page.route('**/api/admin/google/connect/complete',lost_ack);state=await begin(2);await page.goto('http://127.0.0.1:39100/start?state='+state);await page.get_by_role('link',name='Return to Yourwiki').click();await asyncio.wait_for(dropped.wait(),10);await expect(page.get_by_role('status')).to_have_text('Google подключён. Можно вернуться в настройки.');await page.unroute('**/api/admin/google/connect/complete',lost_ack);assert len(completions)==2;second=await stats();assert second=={'tokens':2,'gets':4,'callbackCookies':[False,False],'revision':3},second
   await page.reload();await expect(page.get_by_role('status')).to_have_text('Google подключён. Можно вернуться в настройки.');assert len(completions)==2;assert await stats()==second;storage=await page.evaluate('JSON.stringify(sessionStorage)');assert 'OWNED_CODE' not in storage and 'SYNTHETIC' not in storage;assert not errors,errors
   target=ROOT/'output/playwright/google-connect-callback-mobile.png';target.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(target));await page.goto(origin+'/api/admin/google/oauth/callback?error=access_denied&error_description=PRIVATE');await expect(page.get_by_role('alert')).to_have_text('Подключение не разрешено. Вернитесь в настройки.');assert 'PRIVATE' not in await page.locator('body').inner_text();assert (await stats())['tokens']==2
   print(json.dumps({'strictCrossSiteCallback':True,'lostAckReadOnlyRecovery':True,'reloadNoCodeReplay':True,'noCodeInStorage':True,'tokenPosts':2,'pageErrors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
asyncio.run(main())
