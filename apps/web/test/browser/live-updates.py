"""Real SSE, SQLite changes, dirty PDF preservation and server-side session revocation."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[4]
async def main():
 env={**os.environ,'YOURWIKI_BROWSER_PORT':'39080','YOURWIKI_BROWSER_CONTROL':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action,**values):
  server.stdin.write((json.dumps({'action':action,**values})+'\n').encode());await server.stdin.drain()
  result=json.loads(await asyncio.wait_for(server.stdout.readline(),10));assert result['ok'],result
 try:
  ready=await asyncio.wait_for(server.stdout.readline(),15);assert b'Synthetic PDF' in ready,ready
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox'])
   context=await browser.new_context(locale='ru-RU');page=await context.new_page();errors=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   await page.goto('http://127.0.0.1:39080');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click()
   await page.get_by_role('link',name='PDF PDF forms').wait_for()
   await page.get_by_role('searchbox').fill('Live')
   await command('create',title='Live addition')
   await page.get_by_role('link',name='PDF Live addition').wait_for(timeout=5000)
   assert await page.get_by_role('searchbox').input_value()=='Live'
   captured=asyncio.Event();release=asyncio.Event();held_once=False
   async def hold_catalog(route):
    nonlocal held_once
    if not held_once:
     held_once=True;response=await route.fetch();captured.set();await release.wait()
     try:await route.fulfill(response=response)
     except Exception:pass
    else:await route.continue_()
   await page.route('**/api/documents',hold_catalog)
   await command('create',title='Live staged');await asyncio.wait_for(captured.wait(),5)
   await command('create',title='Live newest');await page.get_by_role('link',name='PDF Live newest').wait_for(timeout=5000)
   release.set();await page.wait_for_timeout(300);assert await page.get_by_role('link',name='PDF Live newest').count()==1
   await page.unroute('**/api/documents',hold_catalog)
   await context.set_offline(True);await page.wait_for_timeout(500);await command('create',title='Live while offline');await context.set_offline(False)
   await page.get_by_role('link',name='PDF Live while offline').wait_for(timeout=10000)
   await page.get_by_role('searchbox').fill('');await page.get_by_role('link',name='MD Live notes').click()
   await page.frame_locator('.document-frame').get_by_role('heading',name='Initial live notes').wait_for()
   await command('notes');await page.frame_locator('.document-frame').get_by_role('heading',name='Updated live notes').wait_for(timeout=5000)
   await page.get_by_role('link',name='← К документам',exact=True).click()
   await page.get_by_role('searchbox').fill('');await page.get_by_role('link',name='PDF PDF forms').click()
   field=page.locator('.pdf-container input').first;await field.wait_for();await page.evaluate('window.savedInput=document.querySelector(".pdf-container input")')
   await field.fill('Dirty SSE draft');await command('layer')
   await page.get_by_role('alert').filter(has_text='измен').wait_for(timeout=5000)
   assert await field.input_value()=='Dirty SSE draft';assert await page.evaluate('savedInput===document.querySelector(".pdf-container input")')
   assert await page.get_by_role('button',name='Сохранить',exact=True).is_disabled()
   await command('readonly');await page.wait_for_function('() => document.querySelector(".pdf-container input").disabled',timeout=5000)
   assert await field.input_value()=='Dirty SSE draft';assert await page.evaluate('savedInput===document.querySelector(".pdf-container input")')
   await command('deny');await page.get_by_role('alert').filter(has_text='доступ').wait_for(timeout=5000)
   assert await page.get_by_role('button',name='Скачать с изменениями',exact=True).count()==0
   assert await field.input_value()=='Dirty SSE draft'
   await command('expire');await page.get_by_role('button',name='Войти',exact=True).wait_for(timeout=5000)
   assert await field.input_value()=='Dirty SSE draft';assert await field.is_disabled();assert await page.evaluate('savedInput===document.querySelector(".pdf-container input")')
   assert errors==[],errors
   print(json.dumps({'realSseCatalogAddition':True,'lateCatalogResponseFenced':True,'reconnectRefreshesMissedChanges':True,'ordinaryPreviewUpdated':True,'readRevocationLocksWithoutDiscard':True,'filterPreserved':True,'remoteLayerConflictRetainsDirtyDom':True,'aclReadonlyApplied':True,'serverRevocationRetainsDraft':True,'scriptErrors':errors}))
   await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  await asyncio.wait_for(server.wait(),10)
  stderr=(await server.stderr.read()).decode()
  if server.returncode not in (0,-15):raise RuntimeError(stderr)
asyncio.run(main())
