"""Global history setting through actual React, Fastify, SQLite, auth, source/PDF commits and network faults."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[4]
async def main():
 env={**os.environ,'YOURWIKI_BROWSER_PORT':'39085','YOURWIKI_BROWSER_CONTROL':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();result=json.loads(await asyncio.wait_for(server.stdout.readline(),20));assert result['ok'],result;return result
 try:
  assert b'Synthetic PDF' in await asyncio.wait_for(server.stdout.readline(),20)
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852});page=await context.new_page();page.set_default_timeout(7000);errors=[];requests=[]
   page.on('pageerror',lambda error:errors.append(str(error)));page.on('request',lambda req:requests.append((req.method,req.url)))
   await page.goto('http://127.0.0.1:39085/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='Настройки',exact=True).wait_for();assert not any('/api/admin/history-settings' in url for _,url in requests)
   await page.get_by_role('link',name='Настройки',exact=True).click();checkbox=page.get_by_role('checkbox',name='Сохранять историю всех документов',exact=True);await checkbox.wait_for();await page.reload();await checkbox.wait_for();assert not await checkbox.is_checked();await checkbox.focus();await checkbox.press('Space');await page.get_by_text('Настройка сохранена для всех документов.',exact=True).wait_for();assert await checkbox.is_checked();assert await checkbox.evaluate('(element)=>document.activeElement===element')
   first=await command('history-save-two');assert len(first['counts'])==2 and all(row['count']==1 for row in first['counts']),first
   await checkbox.uncheck();await page.get_by_text('Настройка сохранена для всех документов.',exact=True).wait_for();assert not await checkbox.is_checked();second=await command('history-save-two');assert second['counts']==first['counts'],second
   for doc in first['documents']:
    response=await page.request.get('http://127.0.0.1:39085/api/documents/'+doc+'/history');value=await response.json();assert not value['enabled'] and len(value['items'])==1,value
   geometry=await page.evaluate('()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert geometry['width']==geometry['scroll'],geometry
   artifact=ROOT/'output'/'playwright'/'history-settings-mobile.png';artifact.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(artifact))
   pattern='**/api/admin/history-settings'
   async def lost_ack(route):
    if route.request.method=='PUT':
     await route.fetch();await route.abort('failed')
    else:await route.continue_()
   await page.route(pattern,lost_ack);before=sum(method=='PUT' for method,url in requests if '/api/admin/history-settings' in url);await checkbox.check();await page.get_by_text('Настройка сохранена для всех документов.',exact=True).wait_for();assert await checkbox.is_checked();assert sum(method=='PUT' for method,url in requests if '/api/admin/history-settings' in url)==before+1;await page.unroute(pattern,lost_ack)
   raced=False
   async def conflict(route):
    nonlocal raced
    if route.request.method=='PUT' and not raced:
     raced=True;account=await (await page.request.get('http://127.0.0.1:39085/api/account')).json();current=await (await page.request.get('http://127.0.0.1:39085/api/admin/history-settings')).json()
     for enabled in [False,True]:
      response=await page.request.put('http://127.0.0.1:39085/api/admin/history-settings',headers={'origin':'http://127.0.0.1:39085','x-csrf-token':account['csrf']},data={'enabled':enabled,'baseRevision':current['revision']});assert response.ok;current=await response.json()
    await route.continue_()
   await page.route(pattern,conflict);before=sum(method=='PUT' for method,url in requests if '/api/admin/history-settings' in url);await checkbox.uncheck();await page.get_by_text('Другой администратор изменил настройку. Показано состояние сервера. Вы можете повторить своё изменение.',exact=True).wait_for();assert await checkbox.is_checked();assert sum(method=='PUT' for method,url in requests if '/api/admin/history-settings' in url)==before+1;await page.get_by_role('button',name='Повторить изменение',exact=True).click();await page.get_by_text('Настройка сохранена для всех документов.',exact=True).wait_for();assert not await checkbox.is_checked();await page.unroute(pattern,conflict)
   phase='lose'
   async def uncertain(route):
    nonlocal phase
    if route.request.method=='PUT' and phase=='lose':phase='offline';await route.abort('failed')
    elif route.request.method=='GET' and phase=='offline':await route.abort('failed')
    else:await route.continue_()
   await page.route(pattern,uncertain);before=sum(method=='PUT' for method,url in requests if '/api/admin/history-settings' in url);await checkbox.check();await page.get_by_text('Не удалось подтвердить результат изменения. Показано последнее подтверждённое состояние. Обновите его или явно повторите изменение.',exact=True).wait_for();await page.get_by_role('button',name='Повторить изменение',exact=True).wait_for();assert await checkbox.is_disabled();assert sum(method=='PUT' for method,url in requests if '/api/admin/history-settings' in url)==before+1;phase='recover';await page.get_by_role('button',name='Повторить изменение',exact=True).click();await page.get_by_text('Настройка сохранена для всех документов.',exact=True).wait_for();assert await checkbox.is_checked();await page.unroute(pattern,uncertain)
   await page.get_by_role('link',name='Документы',exact=True).click();await page.get_by_role('link',name='PDF PDF forms').click();field=page.locator('.pdf-container input').first;await field.wait_for();docurl=page.url;await page.evaluate('window.historySettingsPendingForm=document.querySelector(".pdf-container input")');await field.fill('Keep pending edits');page.once('dialog',lambda dialog:dialog.dismiss());await page.get_by_role('link',name='Настройки',exact=True).click();assert page.url==docurl;assert await field.input_value()=='Keep pending edits';assert await page.evaluate('window.historySettingsPendingForm===document.querySelector(".pdf-container input")');page.once('dialog',lambda dialog:dialog.accept());await page.get_by_role('link',name='Настройки',exact=True).click();await checkbox.wait_for();assert await checkbox.is_checked()
   started=asyncio.Event();release=asyncio.Event()
   async def late(route):
    if route.request.method=='PUT':
     response=await route.fetch();started.set();await release.wait()
     try:await route.fulfill(response=response)
     except Exception:pass
    else:await route.continue_()
   await page.route(pattern,late);await checkbox.uncheck();await asyncio.wait_for(started.wait(),10);await command('expire');await page.locator('input[name=username]').wait_for();release.set();await page.unroute(pattern,late);await page.locator('input[name=username]').fill('other');await page.locator('input[name=password]').fill('yourwiki-other');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_text('Настройки доступны только администраторам.',exact=True).wait_for();assert await page.get_by_role('checkbox').count()==0;assert await page.get_by_role('link',name='Настройки',exact=True).count()==0;assert (await page.request.get('http://127.0.0.1:39085/api/admin/history-settings')).status==403;assert not errors,errors
   print(json.dumps({'historySettings':'passed','globalSourceAndPdfFiles':2,'retainedWhenDisabled':True,'keyboardFocus':True,'mobileWidth':393,'lostAckReadback':True,'conflictExplicitRetry':True,'unknownExplicitRetry':True,'lateAccountReplyIgnored':True,'memberDenied':True,'dirtyNavigationRetainsEditor':True,'errors':errors}));await browser.close()
 finally:
  server.terminate();await asyncio.wait_for(server.wait(),15)
asyncio.run(main())
