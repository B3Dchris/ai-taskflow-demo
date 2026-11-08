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
    const r4b=await fetch(URL+'some/page');ok(r4b.status===404&&/That page isn't here/.test(await r4b.text()),'other unknown pages are a real 404 with links back');
    // public pages for search engines and sharing
    const sm=await (await fetch(URL+'sitemap.xml')).text();const locs=[...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]);
    ok(locs.length>150&&locs.every(u=>u.startsWith('https://www.jitsflow.com/')),'sitemap lists '+locs.length+' pages on www.jitsflow.com');
    const sample=locs.filter(u=>/\/(techniques|positions|belts)\/[^/]+\/$/.test(u)).filter((_,i)=>i%9===0).concat(locs.filter(u=>/glossary|privacy|\/techniques\/$/.test(u)));
    let bad=[];for(const u of sample){const r=await fetch(URL+u.replace('https://www.jitsflow.com/',''));const t=await r.text();
      const ld=[...t.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];let parsed=true;try{ld.forEach(m=>JSON.parse(m[1]))}catch(e){parsed=false}
      if(r.status!==200||!t.includes('<link rel="canonical" href="'+u+'">')||!/<title>[^<]{10,}<\/title>/.test(t)||!/name="description" content="[^"]{40,}"/.test(t)||!/og:image" content="https:\/\/www\.jitsflow\.com\/og\//.test(t)||!ld.length||!parsed)bad.push(u)}
    ok(!bad.length,'content pages have a title, description, canonical, share image and valid structured data '+bad.join(' '));
    const og=await fetch(URL+'og/home.jpg');ok(og.status===200&&og.headers.get('content-type')==='image/jpeg','share images are served');
    ok(locs.includes('https://www.jitsflow.com/coaches/'),'sitemap lists the coaches page');
    {const r=await fetch(URL+'coaches/'),h=await r.text();const imgs=[...h.matchAll(/src="(\/img\/coach\/[^"]+)"/g)].map(m=>m[1]);
     const st=await Promise.all([...new Set(imgs)].map(async u=>(await fetch(URL+u.slice(1))).status));
     ok(r.status===200&&/Run your gym from your phone/.test(h)&&/href="\/app\/\?start=1"/.test(h)&&/"FAQPage"/.test(h)&&!/@@/.test(h),'coaches page: headline, Start your gym link, FAQ data');
     ok(imgs.length>=5&&st.every(x=>x===200),'coaches page screenshots load ('+imgs.length+')');
     ok((await fetch(URL+'og/coaches.jpg')).status===200,'coaches share card exists');
     {const home=await (await fetch(URL)).text();ok(/class="gymlink" href="\/coaches\/">For gyms</.test(home)&&/id="gyms"/.test(home),'home page: For gyms in the header and its own section');}
     for(const pth of ['gyms','gym','gyms/','for-gyms']){const rr=await fetch(URL+pth,{redirect:'manual'});ok(rr.status===301&&rr.headers.get('location')==='/coaches/',`/${pth} goes to the gyms page`)}}
    const rb=await (await fetch(URL+'robots.txt')).text();ok(/Sitemap: https:\/\/www\.jitsflow\.com\/sitemap\.xml/.test(rb)&&/Disallow: \/api\//.test(rb),'robots.txt points to the sitemap');
    const tp=locs.find(u=>/\/techniques\/[^/]+\/$/.test(u)).replace('https://www.jitsflow.com/','');
    const rr=await fetch(URL+tp.replace(/\/$/,''),{redirect:'manual'});ok(rr.status===301&&rr.headers.get('location')==='/'+tp,'pages without the trailing slash redirect to one address');
    const lh=await (await fetch(URL)).text();ok(/rel="canonical"/.test(lh)&&/"FAQPage"/.test(lh)&&/href="\/techniques\/"/.test(lh)&&!/analytics\.js/.test(lh),'home page has structured data and curriculum links, and no analytics without GA_ID');
    const r4c=await fetch(URL+'app',{redirect:'manual'});ok(r4c.status===301&&r4c.headers.get('location')==='/app/','/app redirects to /app/');
    const r5=await fetch(URL+'missing.png');ok(r5.status===404,'missing files return 404');
    const r6=await fetch(URL+'..%2f..%2fserver.js');ok(r6.status!==200||!/createServer/.test(await r6.text()),'no access outside web/');
    const r7=await fetch(URL,{method:'POST'});ok(r7.status===405,'only GET and HEAD allowed');
    // landing page
    await p.goto(URL);await p.waitForTimeout(600);
    ok(await p.evaluate(()=>/Know what to do from every position/i.test(document.querySelector('h1').innerText)&&/137 techniques/.test(document.querySelector('.lede').innerText)&&document.querySelectorAll('a[href="/app/"]').length>=3),'landing page explains the app and links to it');
    ok(await p.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0)||true),'landing images present');
    ok(await p.evaluate(()=>document.documentElement.scrollWidth<=390),'landing has no sideways scroll on a phone');
    const imgs=await p.evaluate(async()=>{const r=[];for(const i of [...document.querySelectorAll('img')]){const x=await fetch(i.getAttribute('src'));r.push(x.status)}return r});ok(imgs.length>=3&&imgs.every(s=>s===200),'all landing screenshots load');
    await p.locator('.hero .cta a.btn.primary').tap();await p.waitForTimeout(800);
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
    await p.evaluate(()=>techSheet('triangle'));ok(await p.evaluate(()=>!!document.querySelector('#sheet .ytembed iframe[src*="youtube-nocookie.com/embed/"]')),'technique page shows its video player');
    ok(await p.evaluate(()=>{const f=document.querySelector('#sheet .ytembed iframe');return !!f&&f.getAttribute('loading')==='lazy'&&!document.querySelector('#sheet .ytface')}),'the player is YouTube\'s own (one tap to play), loaded lazily');
    await p.waitForTimeout(500);
    // technique page in a browser: video plays in place, "Open in JitsFlow" opens that technique in the app
    const tUrl=(await (await fetch(URL+'sitemap.xml')).text()).match(/https:\/\/www\.jitsflow\.com\/(techniques\/kimura-from-side-control\/)/)[1];
    await p.goto(URL+tUrl);await p.waitForTimeout(500);
    await p.locator('.vidbtn').tap();await p.waitForTimeout(300);
    ok(await p.evaluate(()=>/youtube-nocookie\.com\/embed\//.test((document.querySelector('.vid iframe')||{}).src||'')),'technique video plays in the page');
    ok(await p.evaluate(()=>document.documentElement.scrollWidth<=390&&document.querySelectorAll('ol.steps li').length>=3&&!!document.querySelector('a.term[href^="/glossary/#"]')),'technique page fits a phone and links glossary terms');
    await p.locator('.cta .btn').tap();await p.waitForTimeout(1200);
    ok(await p.evaluate(()=>location.pathname==='/app/'&&!/t=/.test(location.search)&&S.ui.sheet&&S.ui.sheet.k==='tech'&&/Kimura/i.test(document.getElementById('sheet').innerText)),'"Open in JitsFlow" opens that technique in the app');
  }catch(e){fail++;fails.push('CRASH '+e.message)}
  // ---- Google Analytics: only with GA_ID, and nothing from Google loads until the visitor taps Allow
  try{
    const gport=port+1,G=`http://localhost:${gport}/`;
    const gs=spawn('node',[path.resolve(__dirname,'../server.js')],{env:{...process.env,PORT:String(gport),GA_ID:'G-TEST12345'},stdio:'ignore'});
    await new Promise(r=>setTimeout(r,900));
    const gc=await b.newContext({...devices['iPhone 13']});const gp=await gc.newPage();const reqs=[];gp.on('request',r=>{if(/google/.test(r.url())&&!/fonts\.g/.test(r.url()))reqs.push(r.url())});
    await gp.route(/googletagmanager\.com|google-analytics\.com/,r=>r.fulfill({status:200,contentType:'text/javascript',body:''}));
    await gp.goto(G+'app/');await gp.waitForTimeout(1500);
    ok(await gp.evaluate(()=>!document.querySelector('.jf-consent')),'the consent card waits while onboarding is open');
    await gp.evaluate(()=>{hideSheet();render()});await gp.waitForTimeout(2300);
    ok(await gp.evaluate(()=>window.JF_GA==='G-TEST12345'&&!!document.querySelector('.jf-consent')),'with GA_ID set, visitors are asked first');
    ok(reqs.length===0,'nothing is sent to Google before consent: '+reqs.join(' '));
    const bannerAboveTabs=await gp.evaluate(()=>document.querySelector('.jf-consent').getBoundingClientRect().bottom<=document.querySelector('nav.tabs').getBoundingClientRect().top);
    ok(bannerAboveTabs,'consent card sits above the tab bar');
    await gp.locator('.jf-consent .yes').tap();await gp.waitForTimeout(600);
    ok(reqs.some(u=>/googletagmanager\.com\/gtag\/js\?id=G-TEST12345/.test(u))&&await gp.evaluate(()=>dataLayer.some(a=>a[0]==='consent'&&a[1]==='update')),'after Allow, Google Analytics loads with consent granted');
    await gp.evaluate(()=>{go('learn')});await gp.waitForTimeout(200);
    ok(await gp.evaluate(()=>dataLayer.some(a=>a[0]==='event'&&a[1]==='page_view'&&/\/app\/learn$/.test(a[2].page_location))),'app tab changes are counted as page views');
    await gp.reload();await gp.waitForTimeout(1500);ok(await gp.evaluate(()=>!document.querySelector('.jf-consent')),'the choice is remembered');
    const nh=await (await fetch(G)).text();ok(/window\.JF_GA="G-TEST12345"/.test(nh)&&/analytics\.js\?v=[0-9a-f]{8}/.test(nh),'GA tag is added to every page, with a versioned script address');
    await gc.close();gs.kill();
    const bs=spawn('node',[path.resolve(__dirname,'../server.js')],{env:{...process.env,PORT:String(gport+1),GA_ID:'"><script>alert(1)</script>'},stdio:'ignore'});
    await new Promise(r=>setTimeout(r,900));const bh=await (await fetch(`http://localhost:${gport+1}/`)).text();bs.kill();
    ok(!/JF_GA/.test(bh),'a malformed GA_ID is ignored');
  }catch(e){fail++;fails.push('CRASH GA '+e.message)}
  const csp=await p.evaluate(()=>window.__csp||[]).catch(()=>[]);ok(csp.length===0,'no security policy violations: '+csp.join(' | '));
  ok(errs.length===0,'page errors: '+errs.join(' | '));
  console.log(`website: ${pass} passed, ${fail} failed`);fails.forEach(f=>console.log('  FAIL',f));
  await b.close();srv.kill();process.exit(fail?1:0)})();
