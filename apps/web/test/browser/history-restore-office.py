"""Restore/editor lifecycle acceptance with a synthetic engine. Does not certify Collabora/CODE."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[4]
async def main():
 env={**os.environ,'YOURWIKI_BROWSER_PORT':'39089','YOURWIKI_BROWSER_CONTROL':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();value=json.loads(await asyncio.wait_for(server.stdout.readline(),30));assert value['ok'],value;return value
 try:
  assert b'Synthetic PDF' in await asyncio.wait_for(server.stdout.readline(),20);docs=await command('history-fixtures');docid=docs['notes']
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',viewport={'width':393,'height':852});page=await context.new_page();page.set_default_timeout(7000);errors=[];opened=[];writes=[];fail_release=True;released=asyncio.Event();release_gate=asyncio.Event()
   page.on('pageerror',lambda error:errors.append(str(error)));page.on('request',lambda req:writes.append(req.url) if req.method=='POST' and ('/restore' in req.url or '/history-restores/' in req.url) else None)
   async def view(route):
    response=await route.fetch();value=await response.json();value['document']['capabilities']['office']=True;await route.fulfill(response=response,json=value)
   await page.route('**/api/documents/*/view',view)
   async def opening(route):
    opened.append(route.request.post_data);await route.fulfill(json={'sessionId':'fixture-room','accessToken':'a'*43,'expiresAt':9999999999999,'write':True,'export':True,'actionUrl':'http://127.0.0.1:39089/fixture-editor?WOPISrc=http%3A%2F%2F127.0.0.1%3A39089%2Fwopi%2Ffiles%2Ffixture-room'})
   await page.route('**/api/documents/*/office-opening',opening);await page.route('**/api/auth/office-opening-cancel',lambda route:route.fulfill(status=204))
   async def engine(route):
    await route.fulfill(content_type='text/html',body='''<html><body><label>Editor<textarea aria-label="Fixture editor"></textarea></label><script>window.fixtureSaves=0;addEventListener('message',e=>{if(e.source===parent&&JSON.parse(e.data).MessageId==='Action_Save')fixtureSaves++});document.querySelector('textarea').oninput=()=>parent.postMessage({MessageId:'Doc_ModifiedStatus',Values:{Modified:true}},location.origin);setTimeout(()=>parent.postMessage({MessageId:'App_LoadingStatus',Values:{Status:'Document_Loaded'}},location.origin),100);</script></body></html>''')
   await page.route('**/fixture-editor?*',engine)
   await page.route('**/api/office/fixture-room/status',lambda route:route.fulfill(json={'sessionId':'fixture-room','documentId':docid,'changed':False,'expired':False,'write':True,'export':True,'errorCode':None,'recovery':False}))
   async def release(route):
    if fail_release:await route.fulfill(status=503,json={'code':'OFFICE_RELEASE_UNCERTAIN'});return
    released.set();await release_gate.wait();await route.fulfill(status=204)
   await page.route('**/api/office/fixture-room/release',release)
   async def stage(route):
    if route.request.method=='POST':
     response=await route.fetch();assert response.status==202;await route.abort('failed')
    else:await route.continue_()
   await page.route('**/history/*/restore',stage)
   await page.goto('http://127.0.0.1:39089/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.locator('.office-workspace[data-loaded="true"]').wait_for();await page.evaluate('window.originalRestoreOffice=document.querySelector("iframe.office-frame")');await page.get_by_role('button',name='История версий',exact=True).click();rows=page.locator('.history-list>li');await expect(rows).to_have_count(50);await rows.first.get_by_role('button',name='Восстановить версию',exact=True).click();await page.get_by_role('button',name='Подтвердить восстановление',exact=True).click();await page.get_by_role('alert').filter(has_text='Не удалось подтвердить').wait_for();assert not writes,writes;assert len(opened)==1;assert await page.evaluate('window.originalRestoreOffice===document.querySelector("iframe.office-frame")')
   # A failed close conservatively marks the editor as needing recovery. Restore must keep that warning.
   await rows.first.get_by_role('button',name='Восстановить версию',exact=True).click();await page.get_by_role('button',name='Подтвердить восстановление',exact=True).click();await page.get_by_text('В редакторе есть несохранённые правки. Сначала сохраните или скопируйте их; восстановление не начато.',exact=True).wait_for();assert not writes,writes
   fail_release=False;release_gate.set();page.once('dialog',lambda d:d.accept());await page.get_by_role('link',name='Аккаунт',exact=True).click();await page.wait_for_url('**/account');await page.get_by_role('link',name='Документы',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.locator('.office-workspace[data-loaded="true"]').wait_for();assert len(opened)==2;released.clear();release_gate.clear();await page.evaluate('window.originalRestoreOffice=document.querySelector("iframe.office-frame")');await page.get_by_role('button',name='История версий',exact=True).click();await expect(rows).to_have_count(50)
   await rows.first.get_by_role('button',name='Восстановить версию',exact=True).click();await page.get_by_role('button',name='Подтвердить восстановление',exact=True).click();await asyncio.wait_for(released.wait(),5);assert not writes,writes;assert await page.evaluate('window.originalRestoreOffice===document.querySelector("iframe.office-frame")');release_gate.set();await page.get_by_role('button',name='Продолжить восстановление',exact=True).wait_for();assert len(writes)==1,writes;assert len(opened)==2;await expect(page.locator('iframe.office-frame')).to_have_count(0)
   await page.get_by_role('button',name='Закрыть историю',exact=True).click();await page.get_by_role('button',name='Показать восстановление',exact=True).click();await page.get_by_role('button',name='Продолжить восстановление',exact=True).wait_for();assert len(opened)==2;await page.get_by_role('button',name='Отменить восстановление',exact=True).click();await page.locator('.office-workspace[data-loaded="true"]').wait_for();assert len(opened)==3;assert len(writes)==2
   field=page.frame_locator('iframe.office-frame').get_by_role('textbox',name='Fixture editor');await field.fill('Retain unsaved Office changes');await rows.first.get_by_role('button',name='Восстановить версию',exact=True).click();await page.get_by_role('button',name='Подтвердить восстановление',exact=True).click();await page.get_by_text('В редакторе есть несохранённые правки. Сначала сохраните или скопируйте их; восстановление не начато.',exact=True).wait_for();assert len(writes)==2;assert len(opened)==3;assert await field.input_value()=='Retain unsaved Office changes';assert await field.evaluate('()=>window.fixtureSaves')==0;assert not errors,errors
   print(json.dumps({'syntheticOfficeRestore':'passed','failedReleaseRetainsFrame':True,'waitsForRelease':True,'noReopenWhileStaged':True,'explicitDiscardReopens':True,'dirtyOfficeRetained':True,'saveOnRestoreExit':False,'errors':errors}));await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:server.kill();await server.wait()
asyncio.run(main())
