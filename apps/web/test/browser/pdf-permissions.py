import asyncio,json,os
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox'])
  page=await browser.new_page(locale='ru-RU');writes=[]
  page.on('request',lambda request:writes.append(request.url) if request.method=='PUT' else None)
  await page.goto(os.environ.get('YOURWIKI_BROWSER_BASE_URL','http://127.0.0.1:39077'))
  await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='PDF PDF forms').click()
  field=page.locator('.pdf-container input').first;await field.wait_for()
  await page.locator('.pdf-toolbar summary').click();await field.fill('Retained draft')
  async def revoke(route):
   response=await route.fetch();value=await response.json();value['document']['capabilities']={'write':False,'export':False};await route.fulfill(response=response,json=value)
  await page.route('**/api/documents/*/view',revoke)
  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
  await page.get_by_role('alert').filter(has_text='Право редактирования отозвано').wait_for()
  assert await page.get_by_role('button',name='Отменить',exact=True).is_disabled(),'Undo remained enabled after revocation'
  assert await page.get_by_role('button',name='Сохранить',exact=True).is_disabled()
  assert await field.is_disabled(),'Form remained enabled after revocation'
  assert await page.get_by_role('button',name='Скачать с изменениями',exact=True).count()==0
  assert await page.locator('a[download]').count()==0
  await asyncio.sleep(2);assert writes==[],writes
  assert await field.input_value()=='Retained draft'
  print(json.dumps({'writeControlsDisabled':True,'exportActionsHidden':True,'draftRetained':True,'writesAfterRevocation':writes}))
  await browser.close()
asyncio.run(main())
