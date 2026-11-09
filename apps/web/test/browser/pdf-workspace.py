import asyncio,json,os,uuid
from io import BytesIO
from pypdf import PdfReader
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox'])
  context=await browser.new_context(locale='ru-RU',viewport={'width':1365,'height':900});page=await context.new_page();errors=[];violations=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  await page.add_init_script("document.addEventListener('securitypolicyviolation',e=>console.error('CSP '+e.violatedDirective+' '+e.blockedURI))")
  page.on('console',lambda msg:violations.append(msg.text) if msg.type=='error' and msg.text.startswith('CSP ') else None)
  await page.goto(os.environ.get('YOURWIKI_BROWSER_BASE_URL','http://127.0.0.1:39077'));await page.locator('input[name="username"]').fill('qa');await page.locator('input[name="password"]').fill('yourwiki-qa');await page.get_by_role('button',name='Войти',exact=True).click();await page.get_by_role('link',name='PDF PDF forms').click()
  field=page.locator('.pdf-container input').first;await field.wait_for();await field.fill('');await field.fill('Saved project');await field.blur();await page.get_by_role('status').filter(has_text='PDF сохранён').wait_for();url=page.url
  await page.reload();await field.wait_for();assert await field.input_value()=='Saved project'
  await page.locator('.pdf-toolbar select').nth(1).select_option('3')
  await page.wait_for_function("() => document.querySelector('.annotationEditorLayer')?.classList.contains('freetextEditing')")
  position=await page.locator('.annotationEditorLayer').first.evaluate('''layer=>{const r=layer.getBoundingClientRect();for(const y of [220,300,380,460])for(const x of [850,1000,700,500]){const hit=document.elementFromPoint(r.left+x,r.top+y);if(x<r.width-30&&r.top+y<innerHeight-30&&hit===layer)return {x,y};}throw new Error('No blank annotation area');}''')
  await page.locator('.annotationEditorLayer').first.click(position=position)
  annotation=page.locator('.freeTextEditor [contenteditable="true"]').first;await annotation.wait_for();annotation_text='Browser annotation '+uuid.uuid4().hex;await annotation.fill(annotation_text)
  assert await page.get_by_role('button',name='Сохранить',exact=True).count()==0;await annotation.blur();await page.get_by_role('status').filter(has_text='PDF сохранён').wait_for()
  state=await (await page.request.get(url.replace('/documents/','/api/documents/')+'/pdf')).json()
  saved=await page.request.get(url.replace('/documents/','/api/documents/')+'/pdf/layers/'+str(state['layerRevision']))
  reader=PdfReader(BytesIO(await saved.body()));assert reader.get_fields()['project']['/V']=='Saved project'
  assert any(annotation_text in str(item.get_object().get('/Contents','')) for item in reader.pages[0]['/Annots'])
  await page.reload();await field.wait_for()
  other=await context.new_page();await other.goto(url);field2=other.locator('.pdf-container input').first;await field2.wait_for()
  concurrent=asyncio.Event();release=asyncio.Event();arrived=0
  async def hold_save(route):
   nonlocal arrived
   arrived+=1
   if arrived==2:concurrent.set()
   await release.wait();await route.continue_()
  await context.route('**/pdf/layer?*',hold_save)
  await field.fill('Client one');await field.blur();await field2.fill('Client two');await field2.blur();await asyncio.wait_for(concurrent.wait(),10);release.set();await asyncio.sleep(3);await context.unroute('**/pdf/layer?*',hold_save)
  alerts=await other.get_by_role('alert').all_text_contents();assert any('изменены другим' in text or 'Автосохранение остановлено' in text for text in alerts),alerts
  recovery=other.get_by_role('link',name='Скачать сохранённую конфликтующую копию');assert await recovery.count()==1
  response=await context.request.get(os.environ.get('YOURWIKI_BROWSER_BASE_URL','http://127.0.0.1:39077')+await recovery.get_attribute('href'));assert response.status==200
  await other.screenshot(path='/tmp/yourwiki-pdf-conflict.png')
  await other.close()
  puts=[];page.on('request',lambda req:puts.append(req.url) if req.method=='PUT' else None)
  await field.fill('discard me');await field.blur()
  page.once('dialog',lambda dialog:dialog.dismiss());await page.get_by_role('link',name='← К документам',exact=True).click();assert page.url==url
  page.once('dialog',lambda dialog:dialog.accept());await page.get_by_role('link',name='← К документам',exact=True).click();await asyncio.sleep(2);assert page.url.endswith('/');assert not puts,puts
  await page.goto(url);await field.wait_for();assert await field.input_value()=='Client one'
  await page.set_viewport_size({'width':393,'height':852});await asyncio.sleep(.5)
  geometry=await page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight})')
  assert geometry['width']==geometry['scrollWidth'],geometry
  await page.screenshot(path='/tmp/yourwiki-pdf-mobile.png')
  print(json.dumps({'formRoundTrip':True,'nativeAnnotationRoundTrip':True,'twoClientConflict':True,'recoveryDownload':response.status,'navigationCancelAndDiscard':True,'noSaveOnDeparture':True,'geometry':geometry,'scriptErrors':errors,'cspViolations':violations},ensure_ascii=False))
  await browser.close()
asyncio.run(main())
