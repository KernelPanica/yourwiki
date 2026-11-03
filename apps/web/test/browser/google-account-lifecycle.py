"""Actual configured mobile UI, identity-only callback and durable native-folder creation; no real Google account."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[4]
async def main():
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/google-connect-browser-server.ts',cwd=ROOT,env={**os.environ,'YOURWIKI_TEST_GOOGLE_AUTHORIZED':'1'},stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(value):
  server.stdin.write((value+'\n').encode());await server.stdin.drain();return json.loads(await asyncio.wait_for(server.stdout.readline(),45))
 try:
  assert b'Owned Google' in await asyncio.wait_for(server.stdout.readline(),20)
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852});page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));origin='http://localhost:39099'
   login=await context.request.post(origin+'/api/auth/login',headers={'origin':origin},data={'username':'qa','password':'yourwiki-qa'});assert login.status==200
   await page.goto(origin+'/account');await expect(page.get_by_role('heading',name='Аккаунт Google',exact=True)).to_be_visible()
   async def consent(route):
    params=dict(__import__('urllib.parse',fromlist=['urlparse']).parse_qsl(__import__('urllib.parse',fromlist=['urlparse']).urlparse(route.request.url).query));assert params['scope']=='openid email';assert params['redirect_uri']==origin+'/api/google/identity/callback';await route.fulfill(status=302,headers={'location':'http://127.0.0.1:39100/start?flow=identity&state='+params['state']})
   await page.route('https://accounts.google.com/o/oauth2/v2/auth?*',consent);await page.get_by_role('button',name='Привязать Google',exact=True).click();await page.get_by_role('link',name='Return to Yourwiki',exact=True).click();await expect(page.get_by_role('status')).to_contain_text('Google подключён');await page.get_by_role('link',name='Вернуться в аккаунт',exact=True).click();await expect(page.get_by_text('qa@example.test',exact=True)).to_be_visible();await page.get_by_role('button',name='Отвязать аккаунт',exact=True).click();await expect(page.get_by_role('button',name='Привязать Google',exact=True)).to_be_visible()
   await page.goto(origin+'/settings');section=page.locator('section').filter(has=page.get_by_role('heading',name='Создание и перемещение в Google',exact=True));await expect(section.get_by_role('combobox',name='Подключение',exact=True)).to_be_visible();await section.get_by_role('combobox',name='Тип',exact=True).select_option('folder');await section.get_by_label('Название',exact=True).fill('Созданная папка');await section.get_by_role('button',name='Выполнить',exact=True).click();await expect(section.get_by_text('Созданная папка',exact=True)).to_be_visible();await section.get_by_label('Название',exact=True).fill('Черновик следующего файла');assert await command('lifecycle')=={'result':'created'};await section.get_by_role('button',name='Обновить операции',exact=True).click();await expect(section.get_by_text('Подтверждено',exact=True)).to_be_visible();await expect(section.get_by_label('Название',exact=True)).to_have_value('Черновик следующего файла');await expect(section.get_by_role('link',name='Открыть',exact=True)).to_have_count(0);await expect(section.get_by_role('combobox',name='Папка назначения',exact=True).locator('option').filter(has_text='Созданная папка')).to_have_count(1);assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth');target=ROOT/'output/playwright/google-account-lifecycle-mobile.png';target.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(target),full_page=True);assert not errors,errors;print(json.dumps({'googleIdentity':'passed','personalDriveScope':False,'folderCreation':'passed','folderIsNotDocument':True,'mobileOverflow':False,'pageErrors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
asyncio.run(main())
