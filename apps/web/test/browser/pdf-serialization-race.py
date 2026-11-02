import asyncio,json,os
from io import BytesIO
from pypdf import PdfReader
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox']);page=await browser.new_page(locale='ru-RU',viewport={'width':1365,'height':900})
  await page.add_init_script('''const send=Worker.prototype.postMessage;window.holdNextPdfSave=true;Worker.prototype.postMessage=function(message,transfer){if(message?.action==='SaveDocument'&&window.holdNextPdfSave){window.holdNextPdfSave=false;window.pdfSaveHeld=true;window.releasePdfSave=()=>send.call(this,message,transfer);return;}return send.call(this,message,transfer);};''')
  await page.goto(os.environ.get('YOURWIKI_BROWSER_BASE_URL','http://127.0.0.1:39077'));await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='PDF PDF forms').click();await page.locator('.pdf-container input').first.wait_for()
  url=page.url;await page.locator('.pdf-container input').first.fill('Dirty form');await page.locator('.pdf-container input').first.blur();await page.locator('.pdf-toolbar select').nth(1).select_option('15');layer=page.locator('.annotationEditorLayer').first;box=await layer.bounding_box()
  async def stroke(y):
   await page.mouse.move(box['x']+200,box['y']+y);await page.mouse.down();await page.mouse.move(box['x']+280,box['y']+y+30,steps=10);await page.mouse.up()
  await page.wait_for_timeout(250);box=await layer.bounding_box();await stroke(400);await page.wait_for_function('() => window.pdfSaveHeld===true');await stroke(500);await page.locator('.pdf-toolbar select').nth(1).select_option('0');await page.evaluate('window.releasePdfSave()');await asyncio.sleep(5)
  state=await(await page.request.get(url.replace('/documents/','/api/documents/')+'/pdf')).json();result=await page.request.get(url.replace('/documents/','/api/documents/')+'/pdf/layers/'+str(state['layerRevision']));reader=PdfReader(BytesIO(await result.body()))
  ink=[a.get_object() for a in reader.pages[0]['/Annots'] if a.get_object().get('/Subtype')=='/Ink'];paths=sum(len(a.get('/InkList',[])) for a in ink)
  print(json.dumps({'paths':paths,'layerRevision':state['layerRevision'],'status':await page.get_by_role('status').all_text_contents()}));assert paths>=2,'Second stroke during PDF.js serialization was lost'
  previous=state['layerRevision'];await page.locator('.pdf-toolbar select').nth(1).select_option('15');await page.wait_for_timeout(250);box=await layer.bounding_box();await stroke(580);await asyncio.sleep(3)
  state=await(await page.request.get(url.replace('/documents/','/api/documents/')+'/pdf')).json();assert state['layerRevision']>previous,'Ink-only gesture did not autosave'
  result=await page.request.get(url.replace('/documents/','/api/documents/')+'/pdf/layers/'+str(state['layerRevision']));reader=PdfReader(BytesIO(await result.body()));ink=[a.get_object() for a in reader.pages[0]['/Annots'] if a.get_object().get('/Subtype')=='/Ink'];assert sum(len(a.get('/InkList',[])) for a in ink)>=3
  print('Ink-only autosave passed');await browser.close()
asyncio.run(main())
