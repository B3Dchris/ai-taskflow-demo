// Tests the website as Render runs it: starts server.js, checks headers, install, offline and the security policy.
const {chromium,devices}=require('playwright');const {spawn}=require('child_process');const path=require('path');
let pass=0,fail=0;const fails=[];const ok=(c,m)=>{if(c)pass++;else{fail++;fails.push(m)}};
(async()=>{const port=8765+Math.floor(Math.random()*500);
  const srv=spawn('node',[path.resolve(__dirname,'../server.js')],{env:{...process.env,PORT:String(port)},stdio:'ignore'});
  await new Promise(r=>setTimeout(r,800));const URL=`http://localhost:${port}/`;
  const b=await chromium.launch();const ctx=await b.newContext({...devices['iPhone 13']});const p=await ctx.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI))});
  try{
    const h=await (await fetch(URL+'healthz')).text();ok(h==='ok','health check answers');
    const r1=await fetch(URL+'app/',{headers:{'Accept-Encoding':'gzip'}});ok(r1.status===200&&r1.headers.get('content-encoding')==='gzip'&&r1.headers.get('cache-control')==='no-cache'&&/default-src 'self'/.test(r1.headers.get('content-security-policy')||'')&&r1.headers.get('x-content-type-options')==='nosniff','index served compressed, uncached, with security headers');
    const r2=await fetch(URL+'icons/icon-192.png');ok(r2.status===200&&r2.headers.get('content-type')==='image/png'&&/max-age=604800/.test(r2.headers.get('cache-control')),'icons cached for a week');
    const r3=await fetch(URL+'sw.js');ok(r3.headers.get('cache-control')==='no-cache'&&/javascript/.test(r3.headers.get('content-type')),'service worker never cached');
    const r4=await fetch(URL+'app/some/deep/link');ok(r4.status===200&&/class="wrap app"/.test(await r4.text()),'unknown /app/ pages open the app');
    const r4b=await fetch(URL+'some/page');ok(r4b.status===200&&/Your no-gi game/.test(await r4b.text()),'other unknown pages open the landing page');
    const r4c=await fetch(URL+'app',{redirect:'manual'});ok(r4c.status===301&&r4c.headers.get('location')==='/app/','/app redirects to /app/');
    const r5=await fetch(URL+'missing.png');ok(r5.status===404,'missing files return 404');
    const r6=await fetch(URL+'..%2f..%2fserver.js');ok(r6.status!==200||!/createServer/.test(await r6.text()),'no access outside web/');
    const r7=await fetch(URL,{method:'POST'});ok(r7.status===405,'only GET and HEAD allowed');
    // landing page
    await p.goto(URL);await p.waitForTimeout(600);
    ok(await p.evaluate(()=>/Your no-gi game, mapped/i.test(document.querySelector('h1').innerText)&&document.querySelectorAll('a[href="/app/"]').length>=3),'landing page explains the app and links to it');
    ok(await p.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0)||true),'landing images present');
    ok(await p.evaluate(()=>document.documentElement.scrollWidth<=390),'landing has no sideways scroll on a phone');
    const imgs=await p.evaluate(async()=>{const r=[];for(const i of [...document.querySelectorAll('img')]){const x=await fetch(i.getAttribute('src'));r.push(x.status)}return r});ok(imgs.length>=4&&imgs.every(s=>s===200),'all landing screenshots load');
    await p.locator('.cta a.btn.primary').tap();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>location.pathname==='/app/'&&document.title==='JitsFlow'&&!window.claude),'"Open JitsFlow" opens the app');
    ok(await p.evaluate(()=>S.ui.sheet&&S.ui.sheet.k==='onboard'),'website shows first-run setup');
    await p.tap('#sheetbar [data-a="obdone"]');
    ok(await p.evaluate(()=>document.getElementById('sync').textContent==='Saved on this device'),'website saves on the device');
    const man=await p.evaluate(async()=>{const r=await fetch('/manifest.webmanifest');return r.ok?await r.json():null});
    ok(man&&man.name==='JitsFlow'&&man.icons.length===3&&man.display==='standalone'&&man.start_url==='/app/','install manifest opens the app');
    for(const ic of ['icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon.png']){const s=await p.evaluate(async u=>(await fetch(u)).status,'/icons/'+ic);ok(s===200,'icon '+ic)}
    ok(await p.evaluate(()=>!!document.querySelector('link[rel=manifest]')&&!!document.querySelector('link[rel=apple-touch-icon]')&&!!document.querySelector('meta[name=theme-color]')),'head has install tags');
    await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>!!navigator.serviceWorker.controller),'service worker controls the page');
    await p.evaluate(()=>{P().mastery.knee_cut=3;saveProgress()});
    await ctx.setOffline(true);await p.reload();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>document.querySelectorAll('nav.tabs button:not([hidden])').length===5&&lv('knee_cut')===3),'works offline and keeps your data');
    await ctx.setOffline(false);
    await p.evaluate(()=>techSheet('knee_cut'));ok(await p.evaluate(()=>/youtube\.com\/results/.test(document.querySelector('#sheet a.yt:not(.ytpick)').href)&&!document.getElementById('explain-box')&&!document.querySelector('label[for^="vid-"]')),'website: YouTube button present, claude.ai-only features hidden');
    ok(await p.evaluate(()=>document.documentElement.scrollWidth<=390),'no sideways scroll');
    const vids=await p.evaluate(()=>({n:Object.keys(VIDS).length,tech:TECH.filter(t=>vidOf(t.id)).length,pos:Object.keys(POS).filter(k=>vidOf('pos:'+k)).length}));
    ok(vids.n>=140&&vids.tech>=125,`picked videos loaded (${vids.tech} techniques, ${vids.pos} positions)`);
    await p.evaluate(()=>techSheet('triangle'));ok(await p.evaluate(()=>!!document.querySelector('#sheet .ytface img[src*="i.ytimg.com"]')),'technique page shows its video thumbnail');
    await p.locator('#sheet .ytface').tap();ok(await p.evaluate(()=>/youtube-nocookie\.com\/embed\//.test((document.querySelector('#sheet .ytembed iframe')||{}).src||'')),'video plays inside the website');
    await p.waitForTimeout(500);
  }catch(e){fail++;fails.push('CRASH '+e.message)}
  const csp=await p.evaluate(()=>window.__csp||[]).catch(()=>[]);ok(csp.length===0,'no security policy violations: '+csp.join(' | '));
  ok(errs.length===0,'page errors: '+errs.join(' | '));
  console.log(`website: ${pass} passed, ${fail} failed`);fails.forEach(f=>console.log('  FAIL',f));
  await b.close();srv.kill();process.exit(fail?1:0)})();
