"""Real HTTP personal Recent, no mocked documents or authentication."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[4]
async def main():
 port=int(os.environ.get('YOURWIKI_BROWSER_RECENT_PORT','39186'));base=f'http://127.0.0.1:{port}'
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env={**os.environ,'YOURWIKI_BROWSER_PORT':str(port),'YOURWIKI_BROWSER_CONTROL':'1'},stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();value=json.loads(await asyncio.wait_for(server.stdout.readline(),15));assert value['ok'],value;return value
 try:
  ready=await asyncio.wait_for(server.stdout.readline(),15)
  if b'Synthetic PDF' not in ready:raise RuntimeError((await server.stderr.read()).decode())
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU');page=await context.new_page();page.set_default_timeout(7000);errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   async def login(user,password):
    await page.locator('input[name=username]').fill(user);await page.locator('input[name=password]').fill(password);await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('button',name='Выйти',exact=True).wait_for()
   async def recent():
    if page.url!=base+'/recent':
     async with page.expect_response(lambda response:response.url==base+'/api/recent' and response.request.method=='GET') as pending:
      await page.get_by_role('link',name='Недавние',exact=True).click()
     response=await pending.value;assert response.status==200;
    await page.get_by_role('heading',name='Недавние',exact=True).wait_for();await expect(page.locator('.library-route:not([hidden]) main.library')).to_have_attribute('aria-busy','false')
   await page.goto(base+'/');await login('qa','yourwiki-qa');await recent();assert await page.get_by_text('Вы ещё не открывали документы',exact=True).is_visible();assert not (await command('recent-state'))['visits']
   await page.get_by_role('link',name='Документы',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.frame_locator('iframe.document-frame').get_by_role('heading',name='Initial live notes').wait_for();await page.wait_for_function("fetch('/api/recent').then(r=>r.json()).then(x=>x.items.length===1)")
   await recent();await expect(page.locator('.library-route:not([hidden]) .file-list a')).to_have_count(1);await expect(page.locator('.library-route:not([hidden]) time')).to_have_count(1)
   await page.get_by_role('link',name='Документы',exact=True).click();await page.get_by_role('link',name='PDF PDF forms').click();await page.locator('.pdf-workspace').wait_for();await page.wait_for_function("fetch('/api/recent').then(r=>r.json()).then(x=>x.items.length===2)");await recent();links=page.locator('.library-route:not([hidden]) .file-list a');assert 'PDF forms' in await links.nth(0).inner_text()
   await page.get_by_role('link',name='MD Live notes').click();await page.frame_locator('iframe.document-frame').get_by_role('heading',name='Initial live notes').wait_for();await page.wait_for_function("fetch('/api/recent').then(r=>r.json()).then(x=>x.items[0].title==='Live notes')");before=(await command('recent-state'))['visits'];await command('notes');await page.frame_locator('iframe.document-frame').get_by_role('heading',name='Updated live notes').wait_for();assert (await command('recent-state'))['visits']==before
   await recent();links=page.locator('.library-route:not([hidden]) .file-list a');assert 'Live notes' in await links.nth(0).inner_text()
   refresh_started=asyncio.Event();refresh_release=asyncio.Event();refresh_settled=asyncio.Event();refresh_held=False
   async def hold_refresh(route):
    nonlocal refresh_held
    if refresh_held:await route.continue_();return
    refresh_held=True;response=await route.fetch();refresh_started.set();await refresh_release.wait()
    try:await route.fulfill(response=response)
    finally:refresh_settled.set()
   await page.route('**/api/recent',hold_refresh);await command('notes');await asyncio.wait_for(refresh_started.wait(),7)
   try:await expect(page.locator('.library-route:not([hidden]) .file-list a')).to_have_count(2,timeout=1000)
   finally:refresh_release.set()
   await asyncio.wait_for(refresh_settled.wait(),7);await page.unroute('**/api/recent',hold_refresh);await expect(page.locator('.library-route:not([hidden]) main.library')).to_have_attribute('aria-busy','false')
   await command('deny-notes');await page.get_by_role('link',name='MD Live notes').wait_for(state='hidden');assert 'PDF forms' in await links.nth(0).inner_text()
   await page.reload();await recent();assert 'PDF forms' in await page.locator('.library-route:not([hidden]) .file-list a').nth(0).inner_text()
   await page.get_by_role('link',name='Аккаунт',exact=True).click();captured=asyncio.Event();release=asyncio.Event();settled=asyncio.Event();held=False
   async def delayed_recent(route):
    nonlocal held
    if held:await route.continue_();return
    held=True;response=await route.fetch();assert response.status==200;assert (await response.json())['items'][0]['title']=='PDF forms';captured.set();await release.wait()
    try:await route.fulfill(response=response)
    except Exception:pass # The old account's request may already have been aborted.
    finally:settled.set()
   await page.route('**/api/recent',delayed_recent);await page.get_by_role('link',name='Недавние',exact=True).click();await asyncio.wait_for(captured.wait(),7)
   await page.get_by_role('button',name='Выйти',exact=True).click();await login('other','yourwiki-other');await recent();release.set();await asyncio.wait_for(settled.wait(),7);await page.unroute('**/api/recent',delayed_recent);await page.get_by_text('Вы ещё не открывали документы',exact=True).wait_for();assert await page.locator('.library-route:not([hidden]) .file-list a').count()==0
   async def fail_visit(route):
    await route.fulfill(status=503,json={'code':'NOT_READY'})
   await page.route('**/api/documents/*/visit',fail_visit)
   await page.set_viewport_size({'width':393,'height':851});await page.get_by_role('link',name='Документы',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.frame_locator('iframe.document-frame').get_by_role('heading',name='Updated live notes').wait_for();await page.get_by_text('Не удалось обновить список недавних. Документ остаётся открытым.',exact=False).wait_for();assert not [row for row in (await command('recent-state'))['visits'] if row['user_id']=='other'];await page.unroute('**/api/documents/*/visit',fail_visit)
   visit_started=asyncio.Event();visit_release=asyncio.Event()
   async def delayed_visit(route):
    visit_started.set();await visit_release.wait();response=await route.fetch();assert response.status==204;await route.fulfill(response=response)
   await page.route('**/api/documents/*/visit',delayed_visit);await page.get_by_role('button',name='Повторить',exact=True).click();await asyncio.wait_for(visit_started.wait(),7);await recent();await page.get_by_text('Вы ещё не открывали документы',exact=True).wait_for();visit_release.set();await page.get_by_role('link',name='MD Live notes').wait_for();await page.unroute('**/api/documents/*/visit',delayed_visit);assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   await page.get_by_role('link',name='Аккаунт',exact=True).click();await page.get_by_role('link',name='Недавние',exact=True).focus();await page.get_by_role('link',name='Недавние',exact=True).press('Enter');await expect(page).to_have_url(base+'/recent');await recent()
   async with context.expect_page() as opened_tab:
    await page.get_by_role('link',name='MD Live notes').click(modifiers=['Control'])
   tab=await opened_tab.value;await tab.frame_locator('iframe.document-frame').get_by_role('heading',name='Updated live notes').wait_for();assert page.url==base+'/recent';await tab.close()
   assert not errors,errors;await page.screenshot(path=str(ROOT/'output/playwright/personal-recent-mobile.png'),full_page=True);print(json.dumps({'personalRecent':'passed','accountIsolation':True,'liveRevocation':True,'noSseVisit':True,'refreshRetainsList':True,'delayedAccountResponseFenced':True,'visitFailureRetry':True,'fastDepartureVisitRetained':True,'keyboardAndModifierLinks':True,'mobileWidth':393,'errors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
asyncio.run(main())
