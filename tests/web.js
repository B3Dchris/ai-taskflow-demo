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
    const r1=await fetch(URL,{headers:{'Accept-Encoding':'gzip'}});ok(r1.status===200&&r1.headers.get('content-encoding')==='gzip'&&r1.headers.get('cache-control')==='no-cache'&&/default-src 'self'/.test(r1.headers.get('content-security-policy')||'')&&r1.headers.get('x-content-type-options')==='nosniff','index served compressed, uncached, with security headers');
    const r2=await fetch(URL+'icons/icon-192.png');ok(r2.status===200&&r2.headers.get('content-type')==='image/png'&&/max-age=604800/.test(r2.headers.get('cache-control')),'icons cached for a week');
    const r3=await fetch(URL+'sw.js');ok(r3.headers.get('cache-control')==='no-cache'&&/javascript/.test(r3.headers.get('content-type')),'service worker never cached');
    const r4=await fetch(URL+'some/deep/link');ok(r4.status===200&&/JitsFlow/.test(await r4.text()),'unknown pages fall back to the app');
    const r5=await fetch(URL+'missing.png');ok(r5.status===404,'missing files return 404');
    const r6=await fetch(URL+'..%2f..%2fserver.js');ok(r6.status!==200||!/createServer/.test(await r6.text()),'no access outside web/');
    const r7=await fetch(URL,{method:'POST'});ok(r7.status===405,'only GET and HEAD allowed');
    await p.goto(URL);await p.waitForTimeout(800);
    ok(await p.evaluate(()=>document.title==='JitsFlow'&&!window.claude),'website loads as JitsFlow without claude.ai');
    ok(await p.evaluate(()=>S.ui.sheet&&S.ui.sheet.k==='onboard'),'website shows first-run setup');
    await p.tap('#sheetbar [data-a="obdone"]');
    ok(await p.evaluate(()=>document.getElementById('sync').textContent==='Saved on this device'),'website saves on the device');
    const man=await p.evaluate(async()=>{const r=await fetch('/manifest.webmanifest');return r.ok?await r.json():null});
    ok(man&&man.name==='JitsFlow'&&man.icons.length===3&&man.display==='standalone','install manifest is valid');
    for(const ic of ['icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon.png']){const s=await p.evaluate(async u=>(await fetch(u)).status,'/icons/'+ic);ok(s===200,'icon '+ic)}
    ok(await p.evaluate(()=>!!document.querySelector('link[rel=manifest]')&&!!document.querySelector('link[rel=apple-touch-icon]')&&!!document.querySelector('meta[name=theme-color]')),'head has install tags');
    await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>!!navigator.serviceWorker.controller),'service worker controls the page');
    await p.evaluate(()=>{P().mastery.knee_cut=3;saveProgress()});
    await ctx.setOffline(true);await p.reload();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>document.querySelectorAll('nav.tabs button').length===5&&lv('knee_cut')===3),'works offline and keeps your data');
    await ctx.setOffline(false);
    await p.evaluate(()=>techSheet('knee_cut'));ok(await p.evaluate(()=>/youtube\.com\/results/.test(document.querySelector('#sheet a.yt').href)&&!document.getElementById('explain-box')&&!document.querySelector('label[for^="vid-"]')),'website: YouTube button present, claude.ai-only features hidden');
    ok(await p.evaluate(()=>document.documentElement.scrollWidth<=390),'no sideways scroll');
  }catch(e){fail++;fails.push('CRASH '+e.message)}
  const csp=await p.evaluate(()=>window.__csp||[]).catch(()=>[]);ok(csp.length===0,'no security policy violations: '+csp.join(' | '));
  ok(errs.length===0,'page errors: '+errs.join(' | '));
  console.log(`website: ${pass} passed, ${fail} failed`);fails.forEach(f=>console.log('  FAIL',f));
  await b.close();srv.kill();process.exit(fail?1:0)})();
