import asyncio,json,os
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'),headless=True,args=['--no-sandbox']);results=[]
  for locale,sign_in,save,pan,zoom,ready in [('en-US','Sign in','Save','Pan','Zoom','PDF ready'),('ru-RU','Войти','Сохранить','Панорамирование','Масштаб','PDF готов'),('es-ES','Iniciar sesión','Guardar','Desplazar','Zoom','PDF listo')]:
   context=await browser.new_context(locale=locale,viewport={'width':1365,'height':900});page=await context.new_page();resources=[];errors=[]
   page.on('request',lambda request:resources.append(request.url));page.on('pageerror',lambda error:errors.append(str(error)))
   await page.goto(os.environ.get('YOURWIKI_BROWSER_BASE_URL','http://127.0.0.1:39077'));await page.locator('input[name=username]').fill('qa');await page.locator('input[name=password]').fill('yourwiki-qa');await page.get_by_role('button',name=sign_in,exact=True).click();await page.get_by_role('link',name='PDF PDF forms').wait_for()
   assert not any('pdf-workspace-' in url for url in resources),'PDF stylesheet loaded before opening a PDF'
   await page.get_by_role('link',name='PDF PDF forms').click();await page.get_by_role('status').filter(has_text=ready).wait_for();await page.locator('.pdf-container input').first.wait_for();assert await page.get_by_role('button',name=save,exact=True).count()==0
   region=page.locator('.pdf-container');await region.focus();await page.keyboard.press('ArrowDown');await page.wait_for_timeout(150);assert await region.evaluate('(n)=>n.scrollTop>0'),'PDF region did not support keyboard scrolling'
   selector=page.get_by_role('combobox',name=zoom,exact=True);await selector.select_option('4')
   await page.wait_for_function("() => {const n=document.querySelector('.pdf-container');return n.scrollWidth>n.clientWidth+100;}")
   await page.get_by_role('button',name=pan,exact=True).click();node=page.locator('.pdf-container');await node.evaluate('(n)=>{n.scrollLeft=100;n.scrollTop=150}')
   before=await node.evaluate('(n)=>({left:n.scrollLeft,top:n.scrollTop})');box=await node.bounding_box();x=box['x']+300;y=box['y']+200
   await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-60,y-80,steps=10);await page.mouse.up();after=await node.evaluate('(n)=>({left:n.scrollLeft,top:n.scrollTop})');assert after['left']>before['left']+40 and after['top']>before['top']+60,(before,after)
   await page.set_viewport_size({'width':1100,'height':800});await page.wait_for_timeout(150);assert await selector.input_value()=='4','Resize discarded the selected zoom'
   await selector.select_option('page-width');await page.set_viewport_size({'width':393,'height':852});await page.wait_for_timeout(150)
   geometry=await page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight})');assert geometry['width']==geometry['scrollWidth'] and geometry['height']==geometry['scrollHeight'],geometry
   assert errors==[],errors;results.append({'locale':locale,'pan':after,'zoomPreserved':True,'lazyStyles':True,'mobile':geometry})
   if locale=='en-US':await page.screenshot(path='/tmp/yourwiki-pdf-controls-mobile.png')
   await context.close()
  print(json.dumps(results));await browser.close()
asyncio.run(main())
