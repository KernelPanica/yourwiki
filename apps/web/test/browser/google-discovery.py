"""Actual discovery API + background worker + owned Google HTTP, never live account data."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[4]
async def main():
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/google-connect-browser-server.ts',cwd=ROOT,env={**os.environ,'YOURWIKI_TEST_GOOGLE_AUTHORIZED':'1'},stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(value):
  server.stdin.write((value+'\n').encode());await server.stdin.drain();return json.loads(await asyncio.wait_for(server.stdout.readline(),15))
 try:
  assert b'Owned Google' in await asyncio.wait_for(server.stdout.readline(),20)
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852});page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));origin='http://localhost:39099'
   login=await context.request.post(origin+'/api/auth/login',headers={'origin':origin},data={'username':'qa','password':'yourwiki-qa'});assert login.status==200
   await page.goto(origin+'/settings');await expect(page.get_by_role('heading',name='Owned Google',exact=True)).to_be_visible();await page.get_by_text('Файлы Google',exact=True).click();panel=page.get_by_role('region',name='Файлы Google — Owned Google',exact=True);assert await command('discovery-stats')=={'tokens':0,'gets':0,'lists':0,'jobs':0}
   async def finish():
    await expect(panel.get_by_text('Поиск ожидает выполнения…',exact=True)).to_be_visible();assert await command('discover')=={'result':'discovered'};await expect(panel.get_by_text('Страница результатов готова.',exact=True)).to_be_visible()
   await panel.get_by_role('button',name='Найти файлы',exact=True).click();await finish();await expect(panel.get_by_text('Заметки.xlsx',exact=True)).to_be_visible();await expect(panel.get_by_text('Google Документ',exact=True)).to_be_visible();assert (await command('discovery-stats'))['lists']==1
   target=ROOT/'output/playwright/google-discovery-mobile.png';target.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(target),full_page=True);await panel.locator('.google-discovery-list').scroll_into_view_if_needed();await page.screenshot(path=str(target.with_name('google-discovery-mobile-results.png')),full_page=True);assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   await panel.get_by_role('button',name='Следующая страница',exact=True).click();await finish();await expect(panel.get_by_text('Результаты.docx',exact=True)).to_be_visible();await expect(panel.get_by_text('Заметки.xlsx',exact=True)).to_have_count(0);await expect(panel.get_by_role('button',name='Следующая страница',exact=True)).to_have_count(0)
   await panel.get_by_role('button',name='Обновить папку',exact=True).click();await finish();await panel.get_by_role('button',name='Рабочая папка',exact=True).click();await finish();await expect(panel.get_by_text('Слайды внутри папки',exact=True)).to_be_visible();await panel.get_by_role('button',name='На уровень выше',exact=True).click();await finish();await expect(panel.get_by_text('Заметки.xlsx',exact=True)).to_be_visible()
   posts=[]
   async def lost(route):
    posts.append(route.request.post_data)
    if len(posts)==1:
     response=await route.fetch();assert response.status==202;await route.abort('failed')
    else:await route.continue_()
   await page.route('**/api/admin/google/discovery',lost);before=await command('discovery-stats');await panel.get_by_role('button',name='Обновить папку',exact=True).click();await expect(panel.get_by_role('alert')).to_contain_text('Результат пока не подтверждён');await panel.get_by_role('button',name='Проверить задачу',exact=True).click();await finish();assert len(posts)==2 and posts[0]==posts[1];after=await command('discovery-stats');assert after['jobs']==before['jobs']+1 and after['lists']==before['lists']+1;await page.unroute('**/api/admin/google/discovery',lost)
   assert await command('deny-discovery')=={'ok':True};await panel.get_by_role('button',name='Обновить папку',exact=True).click();await expect(panel.get_by_role('alert')).to_contain_text('Доступ к обнаружению файлов утрачен');await expect(panel.get_by_text('Заметки.xlsx',exact=True)).to_have_count(0);assert not errors,errors
   assert 'PRIVATE_NEXT_CURSOR' not in await page.content();assert 'SYNTHETIC_REFRESH' not in await page.content();print(json.dumps({'googleDiscovery':'passed','pageOpenProviderRequests':0,'lostAckSameRequest':True,'roleRevocationClearsFiles':True,'errors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
asyncio.run(main())
