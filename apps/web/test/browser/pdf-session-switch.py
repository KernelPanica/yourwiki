import asyncio,json,os
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox'])
  context=await browser.new_context(locale='ru-RU');a=await context.new_page();b=await context.new_page();base=os.environ.get('YOURWIKI_BROWSER_BASE_URL','http://127.0.0.1:39077');writes=[];private=[]
  a.on('request',lambda request:writes.append(request.url) if request.method=='PUT' else None)
  await b.goto(base+'/account');await b.get_by_role('button',name='Войти',exact=True).wait_for()
  await a.goto(base);await a.locator('input[name=username]').fill('qa');await a.locator('input[name=password]').fill('yourwiki-qa');await a.get_by_role('button',name='Войти',exact=True).click()
  await b.get_by_role('heading',name='PDF tester',exact=True).wait_for()
  await a.get_by_role('link',name='PDF PDF forms').click();field=a.locator('.pdf-container input').first;await field.wait_for()
  held=asyncio.Event();release=asyncio.Event();cancelled=[]
  if os.environ.get('YOURWIKI_BROWSER_LARGE_PDF'):
   async def delay_range(route):
    if route.request.headers.get('range'):
     held.set();await release.wait()
     try:await route.continue_()
     except Exception:pass
    else:await route.continue_()
   a.on('requestfailed',lambda request:cancelled.append(request.url) if request.headers.get('range') else None)
   await a.route('**/api/documents/**/assets/**',delay_range)
   await a.get_by_role('button',name='Скачать с изменениями',exact=True).click()
   await asyncio.wait_for(held.wait(),10)
  await a.evaluate('window.savedForm=document.querySelector(".pdf-container input")');await field.fill('Retained pending edits')
  await b.get_by_role('button',name='Выйти',exact=True).click();await a.get_by_role('button',name='Войти',exact=True).wait_for()
  if os.environ.get('YOURWIKI_BROWSER_LARGE_PDF'):
   release.set();await a.wait_for_timeout(300);assert cancelled,'Outstanding PDF range was not aborted'
  assert await field.is_disabled();assert await field.input_value()=='Retained pending edits';assert await a.evaluate('window.savedForm===document.querySelector(".pdf-container input")')
  a.on('request',lambda request:private.append(request.url) if '/api/documents' in request.url else None)
  await b.locator('input[name=username]').fill('other');await b.locator('input[name=password]').fill('yourwiki-other');await b.get_by_role('button',name='Войти',exact=True).click();await b.get_by_role('heading',name='Other viewer',exact=True).wait_for()
  await a.wait_for_timeout(2000);assert writes==[],writes;assert private==[],private
  assert await field.input_value()=='Retained pending edits';assert await a.get_by_role('button',name='Скачать с изменениями',exact=True).count()==0
  a.once('dialog',lambda dialog:dialog.dismiss());await a.get_by_role('button',name='Войти',exact=True).click();assert await field.input_value()=='Retained pending edits'
  await a.unroute('**/api/documents/**/assets/**')
  a.once('dialog',lambda dialog:dialog.accept());await a.get_by_role('button',name='Войти',exact=True).click()
  await a.get_by_role('status').filter(has_text='PDF готов').wait_for();assert await a.get_by_role('button',name='Сохранить',exact=True).count()==0
  await a.get_by_role('link',name='Аккаунт',exact=True).click();await a.get_by_role('heading',name='Other viewer',exact=True).wait_for();assert writes==[],writes
  print(json.dumps({'cleanTabLoginSynced':True,'dirtyEditorPreserved':True,'writesStopped':True,'noCrossAccountPrivateRequests':True,'discardRequiresConfirmation':True,'recoveredAsServerAuthenticatedViewer':True}))
  await browser.close()
asyncio.run(main())
