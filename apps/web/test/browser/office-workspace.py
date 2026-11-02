"""Synthetic trusted-frame protocol acceptance. Does NOT run or certify Collabora."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[4]
async def main():
 env={**os.environ,'YOURWIKI_BROWSER_PORT':'39082','YOURWIKI_BROWSER_CONTROL':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 try:
  assert b'Synthetic PDF' in await asyncio.wait_for(server.stdout.readline(),15)
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU');page=await context.new_page();errors=[];calls=[];changed=False;revoked=False;proof_saved=False;available=True;release_entered=asyncio.Event();release_gate=asyncio.Event()
   await page.clock.install();page.on('pageerror',lambda e:errors.append(str(e)))
   async def view(route):
    response=await route.fetch();value=await response.json();value['document']['capabilities']['office']=True;value['document']['capabilities']['write']=not revoked;await route.fulfill(response=response,json=value)
   await page.route('**/api/documents/*/view',view)
   async def office(route):
    calls.append(('open',route.request.method))
    if not available:
     await route.fulfill(status=503,json={'code':'OFFICE_NOT_READY'});return
    await route.fulfill(json={'sessionId':'browser-room','accessToken':'a'*43,'expiresAt':9999999999999,'write':True,'export':True,'actionUrl':'http://127.0.0.1:39082/test-office?WOPISrc=http%3A%2F%2F127.0.0.1%3A39082%2Fwopi%2Ffiles%2Fbrowser-room'})
   await page.route('**/api/documents/*/office-opening',office)
   await page.route('**/api/auth/office-opening-cancel',lambda route:route.fulfill(status=204))
   async def engine(route):
    calls.append(('engine',route.request.method));assert 'access_token=' in route.request.post_data;assert 'access_token=' not in route.request.url
    manual=sum(c[0]=='engine' for c in calls)==1
    await route.fulfill(content_type='text/html',body='''<html><body><label>Test editor<textarea aria-label="Test editor"></textarea></label><button id="close">Close test editor</button><button id="ready">Ready test editor</button><script>
window.fixtureSaveCount=0;const send=(MessageId,Values)=>parent.postMessage({MessageId,Values},location.origin);
window.addEventListener('message',e=>{if(e.source!==parent)return;const v=JSON.parse(e.data);if(v.MessageId==='Action_Save'){window.fixtureSaveCount++;send('Doc_ModifiedStatus',{Modified:false});}});
document.querySelector('#close').onclick=()=>send('UI_Close',{});
document.querySelector('textarea').oninput=()=>send('Doc_ModifiedStatus',{Modified:true});
document.querySelector('#ready').onclick=()=>send('App_LoadingStatus',{Status:'Document_Loaded'});
if(!__MANUAL__)setTimeout(()=>send('App_LoadingStatus',{Status:'Document_Loaded'}),700);
</script></body></html>'''.replace('__MANUAL__','true' if manual else 'false'))
   await page.route('**/test-office?*',engine)
   async def status(route):
    await route.fulfill(json={'sessionId':'browser-room','documentId':docid,'changed':changed,'expired':False,'write':not revoked,'export':True,'errorCode':None,'recovery':False})
   await page.route('**/api/office/browser-room/status',status)
   async def release(route):
    calls.append(('release',route.request.method));release_entered.set();await release_gate.wait();await route.fulfill(status=204)
   await page.route('**/api/office/browser-room/release',release)
   async def intent(route):
    calls.append(('save',route.request.method));await route.fulfill(json={'tag':'yourwiki-save-'+'b'*32,'baseRevision':1,'expiresAt':9999999999999})
   await page.route('**/api/office/browser-room/save-intents',intent)
   async def proof(route):
    await route.fulfill(json={'tag':'yourwiki-save-'+'b'*32,'state':'saved' if proof_saved else 'pending','currentRevision':2 if proof_saved else 1,'changed':False,'expired':False,'revision':2 if proof_saved else None,'operationId':'saved-operation' if proof_saved else None,'errorCode':None,'delivery':'local'})
   await page.route('**/api/office/browser-room/save-intents/*',proof)
   await page.goto('http://127.0.0.1:39082/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();docid=page.url.split('/')[-1]
   preview=page.locator('.office-preview');await preview.wait_for();assert await preview.is_visible()
   frame=page.frame_locator('iframe.office-frame');field=frame.get_by_role('textbox',name='Test editor');await field.wait_for(state='attached');await page.clock.fast_forward(30010);await page.get_by_role('alert').filter(has_text='Редактор открывается дольше обычного').wait_for();assert await preview.is_visible();assert sum(c[0]=='engine' for c in calls)==1
   delayed_artifact=ROOT/'output'/'playwright'/'office-delayed.png';delayed_artifact.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(delayed_artifact))
   await frame.get_by_role('button',name='Ready test editor').evaluate('(button)=>button.click()');await page.locator('.office-workspace[data-loaded="true"]').wait_for();assert not await preview.is_visible();assert await page.get_by_role('alert').filter(has_text='Редактор открывается дольше обычного').count()==0;assert sum(c[0]=='engine' for c in calls)==1
   await field.fill('Retain these edits');changed=True;revoked=True
   server.stdin.write(b'{"action":"notes"}\n');await server.stdin.drain();assert json.loads(await asyncio.wait_for(server.stdout.readline(),10))['ok']
   await page.get_by_role('alert').filter(has_text='Оригинал изменён').wait_for();assert await field.input_value()=='Retain these edits';assert sum(c[0]=='engine' for c in calls)==1
   saves_before_leaving=await field.evaluate('()=>window.fixtureSaveCount');document_url=page.url;dialogs=[]
   async def dismiss(d):
    dialogs.append(d.message);await d.dismiss()
   page.once('dialog',dismiss);await frame.get_by_role('button',name='Close test editor').click();await asyncio.sleep(.1);assert len(dialogs)==1,'UI_Close did not request guarded navigation';assert page.url==document_url;assert not release_entered.is_set()
   page.once('dialog',dismiss);await page.evaluate('()=>history.back()');await asyncio.sleep(.2);assert len(dialogs)==2;assert page.url==document_url;assert await field.input_value()=='Retain these edits'
   page.once('dialog',lambda d:d.dismiss());await page.get_by_role('link',name='Аккаунт',exact=True).click();await asyncio.sleep(.1);assert page.url==document_url;assert not release_entered.is_set()
   page.once('dialog',lambda d:d.accept());await page.get_by_role('link',name='Аккаунт',exact=True).click();await asyncio.wait_for(release_entered.wait(),5);assert page.url==document_url;assert await field.input_value()=='Retain these edits';assert await field.evaluate('()=>window.fixtureSaveCount')==saves_before_leaving
   await page.get_by_role('link',name='Аккаунт',exact=True).click();assert sum(c[0]=='release' for c in calls)==1
   release_gate.set();await page.wait_for_url('**/account');await page.get_by_role('heading',name='Аккаунт',exact=True).wait_for();assert not errors,errors
   changed=False;revoked=False;proof_saved=True
   await page.get_by_role('link',name='Yourwiki·',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.locator('.office-workspace[data-loaded="true"]').wait_for();await field.fill('Save through the mounted editor');await page.get_by_role('status').filter(has_text='Сохранено в YourWiki').wait_for();assert await field.evaluate('()=>window.fixtureSaveCount')==1
   await page.set_viewport_size({'width':393,'height':852});await page.get_by_role('button',name='На весь экран',exact=True).click();await page.locator('.office-fullscreen').wait_for();geometry=await page.evaluate('()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert geometry['width']==geometry['scroll'],geometry
   artifact=ROOT/'output'/'playwright'/'office-mobile.png';artifact.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(artifact));await page.get_by_role('button',name='Выйти из полного экрана',exact=True).click()
   await page.get_by_role('link',name='Аккаунт',exact=True).click();await page.wait_for_url('**/account');available=False;await page.get_by_role('link',name='Yourwiki·',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.get_by_role('alert').filter(has_text='Редактор пока недоступен').wait_for();assert await preview.is_visible();assert await page.locator('iframe.office-frame').count()==0;assert not errors,errors
   available=True;await page.get_by_role('link',name='Аккаунт',exact=True).click();await page.wait_for_url('**/account');await page.get_by_role('link',name='Yourwiki·',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();await page.locator('.office-workspace[data-loaded="true"]').wait_for();await field.fill('Retained after expiry')
   revocation_entered=asyncio.Event();revocation_gate=asyncio.Event()
   async def revoke_capability(route):
    body=json.loads(route.request.post_data);assert body=={'sessionId':'browser-room','accessToken':'a'*43};calls.append(('revoke',route.request.method));revocation_entered.set();await revocation_gate.wait();await route.fulfill(status=204)
   await page.route('**/api/auth/office-revoke',revoke_capability)
   server.stdin.write(b'{"action":"expire"}\n');await server.stdin.drain();assert json.loads(await asyncio.wait_for(server.stdout.readline(),10))['ok']
   await page.get_by_role('alert').filter(has_text='Сохранение остановлено').wait_for();assert await field.input_value()=='Retained after expiry';writes_before=await field.evaluate('()=>window.fixtureSaveCount')
   page.once('dialog',lambda d:d.dismiss());await page.get_by_role('button',name='Войти',exact=True).click();assert await field.input_value()=='Retained after expiry';assert not revocation_entered.is_set()
   page.once('dialog',lambda d:d.accept());await page.get_by_role('button',name='Войти',exact=True).click();await asyncio.wait_for(revocation_entered.wait(),5);assert await field.input_value()=='Retained after expiry';assert await field.evaluate('()=>window.fixtureSaveCount')==writes_before
   revocation_gate.set();await page.locator('input[name=username]').wait_for();assert await page.locator('iframe.office-frame').count()==0;assert not errors,errors
   print(json.dumps({'syntheticOffice':'passed','framePosts':sum(c[0]=='engine' for c in calls),'lateReadinessRetainsFrame':True,'saveOnLeave':False,'errors':errors}));await page.unroute_all(behavior='wait');await browser.close()
 finally:
  if server.returncode is None:server.terminate()
  try:await asyncio.wait_for(server.wait(),15)
  except asyncio.TimeoutError:
   server.kill();await server.wait()
asyncio.run(main())
