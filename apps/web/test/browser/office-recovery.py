"""Recovery UI against real SQLite/private blobs/auth/ACL/HTTP; no Collabora process."""
import asyncio,json,os
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[4]
async def main():
 env={**os.environ,'YOURWIKI_BROWSER_PORT':'39083','YOURWIKI_BROWSER_CONTROL':'1','YOURWIKI_BROWSER_OFFICE':'1'}
 server=await asyncio.create_subprocess_exec('node','apps/server/test/support/pdf-browser-server.ts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
 async def command(action):
  server.stdin.write((json.dumps({'action':action})+'\n').encode());await server.stdin.drain();value=json.loads(await asyncio.wait_for(server.stdout.readline(),20));assert value['ok'],value
 try:
  assert b'Synthetic PDF' in await asyncio.wait_for(server.stdout.readline(),15);await command('recoveries')
  async with async_playwright() as p:
   browser=await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'],headless=True,args=['--no-sandbox']);context=await browser.new_context(locale='ru-RU',accept_downloads=True);page=await context.new_page();page.set_default_timeout(5000);errors=[];requests=[]
   page.on('pageerror',lambda error:errors.append(str(error)));page.on('request',lambda req:requests.append((req.method,req.url,req.headers)))
   await page.goto('http://127.0.0.1:39083/');await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='MD Live notes').click();docurl=page.url;docid=docurl.split('/')[-1]
   await page.get_by_role('button',name='Копии восстановления',exact=True).wait_for();assert not any('/office-recovery?' in r[1] for r in requests)
   async with page.expect_response(lambda r:'/office-recovery?limit=' in r.url) as response:
    await page.get_by_role('button',name='Копии восстановления',exact=True).click()
   listing=await (await response.value).json();assert len(listing['items'])==50;first_id=listing['items'][0]['id'];rows=page.locator('.recovery-item');await rows.nth(49).wait_for();assert await rows.count()==50
   await page.set_viewport_size({'width':393,'height':852});geometry=await page.evaluate('()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert geometry['width']==geometry['scroll'],geometry
   artifact=ROOT/'output'/'playwright'/'recovery-mobile.png';artifact.parent.mkdir(parents=True,exist_ok=True);await page.screenshot(path=str(artifact));await page.set_viewport_size({'width':1365,'height':900})
   async with page.expect_download() as downloading:
    await rows.first.get_by_role('button',name='Скачать копию',exact=False).click()
   download=await downloading.value;path=await download.path();assert Path(path).read_text().startswith('durable recovery copy ')
   await command('export-deny-notes');await page.get_by_role('button',name='Обновить копии',exact=True).click();await page.wait_for_timeout(300);assert await page.get_by_role('button',name='Скачать копию',exact=False).count()==0
   await page.get_by_role('button',name='Следующая страница копий',exact=True).click();await page.wait_for_timeout(200);assert await rows.count()==2;await page.get_by_role('button',name='Обновить копии',exact=True).click();await rows.nth(49).wait_for()
   posts_before=sum(r[0]=='POST' and '/discard' in r[1] for r in requests);page.once('dialog',lambda d:d.dismiss());await rows.first.get_by_role('button',name='Удалить копию',exact=False).click();assert await rows.count()==50;assert sum(r[0]=='POST' and '/discard' in r[1] for r in requests)==posts_before
   page.once('dialog',lambda d:d.accept());await rows.first.get_by_role('button',name='Удалить копию',exact=False).click();await page.wait_for_timeout(300);assert await rows.count()==49
   discard=[r for r in requests if r[0]=='POST' and '/discard' in r[1]][-1];assert discard[2].get('x-csrf-token');assert (await page.request.get('http://127.0.0.1:39083/api/office-recovery/'+first_id+'/contents')).status==404
   original=await page.request.get('http://127.0.0.1:39083/api/documents/'+docid);assert (await original.json())['revision']==1
   bootstraps=sum(r[0]=='POST' and r[1].endswith('/office-opening') for r in requests);await command('readonly-notes');await page.reload();await page.get_by_role('button',name='Копии восстановления',exact=True).click();await rows.nth(49).wait_for();assert sum(r[0]=='POST' and r[1].endswith('/office-opening') for r in requests)==bootstraps;assert await page.locator('iframe.office-frame').count()==0
   await command('expire');await page.locator('input[name=username]').wait_for();assert await rows.count()==0
   await page.locator('input[name=username]').fill('other');await page.locator('input[name=password]').fill('yourwiki-other');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('button',name='Копии восстановления',exact=True).click();await page.get_by_text('Нет сохранённых копий восстановления.',exact=True).wait_for();assert await rows.count()==0;assert not errors,errors
   print(json.dumps({'realRecoveryUI':'passed','boundedPage':50,'downloadedBlob':True,'exportRevocation':True,'confirmedDiscard':True,'originalRevision':1,'readonlyAuthorRecovery':True,'accountIsolation':True,'errors':errors}));await browser.close()
 finally:
  server.terminate();await asyncio.wait_for(server.wait(),15)
asyncio.run(main())
