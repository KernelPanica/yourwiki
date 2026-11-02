"""Owned actual Local storage, API and browser; lost ACK never repeats a POST/write."""
import asyncio,json,os
from pathlib import Path
from datetime import datetime,timezone,timedelta
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[4]
async def main():
 env={**os.environ,'YOURWIKI_BROWSER_PORT':'39096','YOURWIKI_BROWSER_CONTROL':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();value=json.loads(await asyncio.wait_for(server.stdout.readline(),30));assert value['ok'],value;return value
 try:
  assert b'Synthetic PDF' in await asyncio.wait_for(server.stdout.readline(),20);docs=await command('source-fixtures')
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852});page=await context.new_page();page.set_default_timeout(8000);errors=[];posts=[]
   page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda req:posts.append(req.url) if req.method=='POST' and '/provider-delivery/' in req.url else None)
   await page.goto('http://127.0.0.1:39096/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();panel=page.locator('.source-delivery');await expect(panel).to_contain_text('ожидает передачи');assert not posts
   result=await command('source-work');assert result['notesText']=='# Source notes 2';await expect(panel).to_contain_text('Исходный файл подтверждён в хранилище.')
   await command('source-save');await command('source-not-written');await panel.get_by_role('button',name='Повторить передачу сохранённого файла',exact=True).wait_for()
   async def drop_ack(route):
    response=await route.fetch();assert response.status==200;await route.abort('failed')
   await page.route('**/provider-delivery/retry',drop_ack);await panel.get_by_role('button',name='Повторить передачу сохранённого файла',exact=True).click();await expect(panel).to_contain_text('ожидает передачи');assert len(posts)==1,posts;await page.unroute('**/provider-delivery/retry',drop_ack);await page.reload();await expect(panel).to_contain_text('ожидает передачи');assert len(posts)==1,posts;result=await command('source-work');assert result['notesText']=='# Source notes 3';await expect(panel).to_contain_text('Исходный файл подтверждён в хранилище.')
   await command('source-save');result=await command('source-lost-ack');writes=result['writes'];await expect(panel).to_contain_text('Результат передачи исходного файла неизвестен.');assert len(posts)==1;await panel.get_by_role('button',name='Проверить результат без перезаписи',exact=True).click();assert len(posts)==2;result=await command('source-work');assert result['writes']==writes;await expect(panel).to_contain_text('Исходный файл подтверждён в хранилище.');assert result['notesText']=='# Source notes 4'
   await page.get_by_role('link',name='Документы',exact=True).click();await page.get_by_role('link',name='PDF PDF forms').click();field=page.locator('.pdf-container input').first;await field.wait_for();await page.clock.install();await page.clock.pause_at(datetime.now(timezone.utc)+timedelta(seconds=1));await page.evaluate('window.sourceRetainedField=document.querySelector(".pdf-container input")');await field.fill('Retain my unsaved source-conflict buffer');saves=[];page.on('request',lambda req:saves.append(req.url) if req.method in ['POST','PUT'] and ('/save-operations' in req.url or '/pdf/saves' in req.url or '/layer' in req.url) else None);result=await command('source-pdf-conflict');assert result['pdfDeliveryState']=='conflict',result;await panel.get_by_role('button',name='Обновить статус',exact=True).click();await expect(panel).to_contain_text('Оригинал изменён в хранилище.');assert result['pdfProviderRevision']==1;assert result['pdfRevision']==2;assert await page.evaluate('window.sourceRetainedField===document.querySelector(".pdf-container input")');assert await field.input_value()=='Retain my unsaved source-conflict buffer';assert not saves,saves;assert len(posts)==2;assert await page.evaluate('document.documentElement.scrollWidth===innerWidth');assert not errors,errors
   page.once('dialog',lambda dialog:dialog.dismiss());await page.get_by_role('link',name='Документы',exact=True).click();assert page.url.endswith('/documents/'+docs['pdf']);assert await field.input_value()=='Retain my unsaved source-conflict buffer';assert await page.evaluate('window.sourceRetainedField===document.querySelector(".pdf-container input")');assert not saves,saves
   incoming=await command('source-incoming-pdf');assert incoming['incomingResult']=='conflict';incoming_panel=page.get_by_role('complementary',name='Внешние изменения',exact=True);await expect(incoming_panel).to_contain_text('Текущая версия и входящий снимок сохранены раздельно.');assert await field.input_value()=='Retain my unsaved source-conflict buffer';assert await page.evaluate('window.sourceRetainedField===document.querySelector(".pdf-container input")');assert not saves,saves;assert len(posts)==2
   artifact=ROOT/'output/playwright/provider-delivery-mobile.png';artifact.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(artifact));print(json.dumps({'providerDelivery':'passed','actualLocalBytes':True,'explicitRetry':True,'lostAckReadOnlyRecovery':True,'reloadNoPost':True,'unknownReadBackNoRewrite':True,'dirtyPdfDomRetained':True,'sourceConflictNoExitWrite':True,'incomingConflictNoticeRetainsDirtyPdf':True,'posts':len(posts),'errors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
asyncio.run(main())
