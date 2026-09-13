// Real-browser responsive and accessibility regression tests. All remote requests are mocked.
// No registry downloads, real credentials, or monitor writes occur.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
const axe = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const server = createServer((_req,res) => {res.writeHead(200,{'Content-Type':'text/html'});res.end(html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin = 'http://127.0.0.1:'+server.address().port;
const browser = await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const now = Date.now(), at = n => new Date(now+n).toISOString();
const history = Array.from({length:160},(_,i)=>({at:at((i-159)*3600000),downloadCount:1000+i*10}));
const cogHistory = Array.from({length:20},(_,i)=>({at:at((i-19)*3600000),downloadCount:200+i*5}));
const failures = [], results = [];
const settings = {github:90,imac:1400,cognispec:1189};
const cases = [
  [1440,900,'dark'],[1440,900,'light'],[1366,768,'dark'],[1280,800,'dark'],
  [1024,768,'dark'],[820,1180,'light'],[390,844,'dark'],[390,844,'light'],
  [360,800,'dark'],[320,568,'dark'],
];
try {
  for (const [width,height,colorScheme] of cases) {
    const name = `${width}x${height}-${colorScheme}`, mobile=width<640;
    const context=await browser.newContext({viewport:{width,height},colorScheme,isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1,reducedMotion:'reduce'});
    const page=await context.newPage(), errors=[], posts=[];
    page.on('pageerror',err=>errors.push(err.message));
    await context.route('**/*',async route=>{
      const req=route.request(),url=req.url();
      if(url.startsWith(origin))return route.continue();
      const fulfill = body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
      if(url.includes('/api/settings')) {
        if(req.method()==='POST') {const body=req.postDataJSON();posts.push(body);settings[body.target]=body.total;return fulfill({ok:true,...body});}
        return fulfill({writable:true,repo:'AryanSudhirDev/promptr-install-smoke-tests',settings});
      }
      if(url.includes('status.json'))return fulfill({updatedAt:at(0),github:{day:new Date(now).toISOString().slice(0,10),countsComplete:true,dailyTotal:90,checksToday:60,failedToday:0,runsToday:42,lastRunAt:at(-60000)},imac:{dailyTotal:1400},cognispec:{dailyTotal:1189},extensions:{promptr:{version:'1.5.6',downloadCount:2600},cognispec:{version:'0.1.0',downloadCount:300}}});
      if(url.includes('downloads'))return route.fulfill({status:200,contentType:'text/plain',body:(url.includes('cognispec')?cogHistory:history).map(x=>JSON.stringify(x)).join('\n')});
      if(url.includes('open-vsx.org/api/'))return fulfill({version:url.includes('cognispec')?'0.1.0':'1.5.6',downloadCount:url.includes('cognispec')?300:2600,reviewCount:3});
      return route.abort();
    });
    await page.goto(origin);
    await page.waitForFunction(()=>document.getElementById('refresh').textContent==='Refresh now'&&document.getElementById('dl').textContent==='2,600');
    await page.waitForFunction(()=>document.querySelectorAll('.history-chart path').length>2);
    // Let the debounced ResizeObserver finish, rather than changing the viewport mid-render.
    await page.waitForTimeout(150);
    const layout=await page.locator('body').evaluate(el=>({height:el.scrollHeight,width:el.scrollWidth,viewportHeight:innerHeight,viewportWidth:innerWidth,footerBottom:document.querySelector('.page-footer').getBoundingClientRect().bottom}));
    console.log(name,JSON.stringify(layout));
    const one=await page.locator('.promptr').boundingBox(),two=await page.locator('.cognispec').boundingBox();
    if(layout.width>width+1)failures.push(name+': horizontal overflow '+layout.width);
    if(width>=1180&&height>=768&&layout.height>height+1)failures.push(name+': desktop overflow '+layout.height);
    if(width>=640&&Math.abs(one.y-two.y)>1)failures.push(name+': panels not side by side');
    if(width<640&&two.y<one.y+one.height)failures.push(name+': stacked panels overlap');
    for(const id of ['chart-promptr','chart-cognispec','bars-promptr','bars-cognispec']) {
      const el=page.locator('#'+id);
      assert.equal(await el.getAttribute('tabindex'),'0');
      assert.ok((await el.getAttribute('aria-label')).length>10);
    }
    if(mobile){
      for(const target of ['promptr','cognispec']) {
        await page.locator('#chart-'+target).tap();
        assert.equal(await page.locator('#tip').isVisible(),true);
        const text=await page.locator('#tip').innerText();
        assert.ok(text.includes('\n')&&!text.includes('\\n'));
        const box=await page.locator('#tip').boundingBox();
        assert.ok(box.x>=0&&box.x+box.width<=width+1);
      }
      for(const id of ['gh-total','im-total','cs-total','gh-save','im-save','cs-save'])assert.ok((await page.locator('#'+id).boundingBox()).height>=44,name+' '+id+' touch target >=44px');
    }else{
      await page.locator('#chart-cognispec').focus();
      await page.keyboard.press('End');
      assert.match(await page.locator('#tip').innerText(),/CogniSpec/);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#tip').isVisible(),false);
    }
    // Disclosure must fit even on the narrowest phone, without hiding the submit button.
    await page.locator('#tokbox > summary').click();
    const pop=await page.locator('.access-popover').boundingBox();
    assert.ok(pop.x>=0&&pop.x+pop.width<=width+1,name+' access popover fits');
    await page.locator('#token').fill('local-layout-test');
    await page.getByRole('button',{name:'Save key',exact:true}).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#tokbox').getAttribute('open'),null);
    // A dirty value must survive refresh; writes are intercepted by the local test route.
    if(width===390&&colorScheme==='dark'){
      await page.locator('#cs-total').fill('1200');
      await page.locator('#refresh').click();
      await page.waitForFunction(()=>document.getElementById('refresh').textContent==='Refresh now');
      assert.equal(await page.locator('#cs-total').inputValue(),'1200');
      await page.locator('#cs-save').click();
      await page.waitForFunction(()=>document.getElementById('cs-msg').textContent.startsWith('Accepted'));
      assert.deepEqual(posts,[{target:'cognispec',total:1200}]);
    }
    // Public viewing/default state should meet WCAG AA in light and dark themes.
    await page.locator('#gh-total').focus();await page.locator('#gh-total').blur();
    await page.evaluate(()=>window.scrollTo(0,0));
    if([1440,390].includes(width)){
      await page.addScriptTag({content:axe});
      const scan=await page.evaluate(async()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
      if(scan.violations.length)failures.push(name+': accessibility '+JSON.stringify(scan.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))));
    }
    if(errors.length)failures.push(name+': console '+errors.join('; '));
    if(process.env.LAYOUT_SCREENSHOT_DIR){await mkdir(process.env.LAYOUT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LAYOUT_SCREENSHOT_DIR,name+'.png'),fullPage:mobile});}
    results.push({name,...layout,sideBySide:width>=640});
    await context.close();
  }
  console.log(JSON.stringify({results,failures},null,2));
  assert.equal(failures.length,0,'All responsive and accessibility checks must pass');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
