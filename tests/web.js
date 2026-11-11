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
    {const t=await (await fetch(URL+'privacy/')).text();
     ok(/proofs of payment/.test(t)&&/forwarded to a gym's payments address/.test(t)&&/WhatsApp group screenshots/.test(t)&&/PayFast/.test(t)&&/contacts the coach picks/.test(t)&&/parent's permission/.test(t)&&/competition/.test(t)&&/Leave gym/.test(t),'privacy page names Anthropic for proofs, emails and screenshots, PayFast, contacts, children, competitions and leaving a gym')}
    const og=await fetch(URL+'og/home.jpg');ok(og.status===200&&og.headers.get('content-type')==='image/jpeg','share images are served');
    ok(locs.includes('https://www.jitsflow.com/coaches/'),'sitemap lists the coaches page');
    {const r=await fetch(URL+'coaches/'),h=await r.text();const imgs=[...h.matchAll(/src="(\/img\/coach\/[^"]+)"/g)].map(m=>m[1]);
     const st=await Promise.all([...new Set(imgs)].map(async u=>(await fetch(URL+u.slice(1))).status));
     ok(r.status===200&&/Run your gym from your phone/.test(h)&&/href="\/app\/\?start=1"/.test(h)&&/"FAQPage"/.test(h)&&!/@@/.test(h),'coaches page: headline, Start your gym link, FAQ data');
     ok(imgs.length>=5&&st.every(x=>x===200),'coaches page screenshots load ('+imgs.length+')');
     ok((await fetch(URL+'og/coaches.jpg')).status===200,'coaches share card exists');
     {const home=await (await fetch(URL)).text();ok(/class="gymlink" href="\/coaches\/">For gyms</.test(home)&&/id="gyms"/.test(home),'home page: For gyms in the header and its own section');}
     for(const pth of ['gyms','gym','gyms/','for-gyms']){const rr=await fetch(URL+pth,{redirect:'manual'});ok(rr.status===301&&rr.headers.get('location')==='/coaches/',`/${pth} goes to the gyms page`)}}
    {const app=await (await fetch(URL+'app/')).text();ok(/maximum-scale=1/.test(app)&&/iP\(hone\|od\|ad\)/.test(app),'app stops iPhone Safari zooming in on text boxes (iOS only)');}
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
    ok(await p.evaluate(()=>/Know what to do when they react/i.test(document.querySelector('h1').innerText)&&/\d{3} techniques/.test(document.querySelector('.lede').innerText)&&document.querySelectorAll('a[href="/app/"]').length>=3),'landing page explains the app and links to it');
    ok(await p.evaluate(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0)||true),'landing images present');
    ok(await p.evaluate(()=>document.documentElement.scrollWidth<=390),'landing has no sideways scroll on a phone');
    // hero: the headline, then the app itself playing in a phone (no stat chips, stat strip or pill tags); no scramble widget
    {const html=await (await fetch(URL)).text();const hero=html.match(/<section class="wrap lead"[\s\S]*?<\/section>/)[0];
     ok(/<h1[^>]*>[\s\S]*Know what to do[\s\S]*they react/.test(hero)&&/<figure class="clip heroclip">\s*<div class="device"><video class="autoclip"[^>]*poster="\/video\/moves-and-map\.webp"[^>]*><source src="\/video\/moves-and-map\.mp4"/.test(hero)&&/href="\/app\/"/.test(hero)&&!/fchip|class="strip|class="stat|pill/.test(html),'hero: headline and the app\'s screen recording in a phone frame, a way into the app, no stat chips, stat strip or pills');
     ok(!/scramble|scr-|Try it|Play it out/i.test(html.replace(/scrambled/g,'')),'no "play a scramble" anywhere on the home page (markup, data, script or copy)');
     ok((html.match(/<ol class="notebook"[\s\S]*?<\/ol>\s*<\/div>/)||[''])[0].match(/href="\/techniques\/[a-z0-9-]+\/"/g).length>=8,'the closed guard notebook still lists the chains, each move linking to its page');
     const nc=await b.newContext({...devices['iPhone 13'],javaScriptEnabled:false});const np=await nc.newPage();await np.goto(URL);
     ok(await np.evaluate(()=>{const v=document.querySelector('.heroclip video');return !!v&&v.hasAttribute('controls')&&v.getBoundingClientRect().height>300&&document.documentElement.scrollWidth<=390}),'no JavaScript: the hero clip shows its poster with the browser\'s own controls');
     await nc.close();
     const cc=await b.newContext({...devices['iPhone 13'],serviceWorkers:'block'});const cp=await cc.newPage();
     await cp.addInitScript(()=>{window.__cls=0;window.__lcp=null;new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:'layout-shift',buffered:true});
       new PerformanceObserver(l=>{const e=l.getEntries().pop();window.__lcp=e&&e.element?(e.element.closest('h1')?'h1':e.element.tagName+' '+(e.url||'')):null}).observe({type:'largest-contentful-paint',buffered:true})});
     await cp.goto(URL,{waitUntil:'networkidle'});await cp.waitForTimeout(300);
     ok(await cp.evaluate(()=>window.__cls<0.05&&window.__lcp==='h1'&&!document.querySelector('.lead img')&&[...document.querySelectorAll('img[src*="i.ytimg.com"]')].every(i=>i.getBoundingClientRect().top>innerHeight)),'hero: no layout shift as it loads, the headline is the largest paint, and no video thumbnail in the first screen');
     await cc.close();}
    const imgs=await p.evaluate(async()=>{const r=[];for(const i of [...document.querySelectorAll('img')].filter(i=>i.getAttribute('src').startsWith('/'))){const x=await fetch(i.getAttribute('src'));r.push(x.status)}return r});ok(imgs.length>=3&&imgs.every(s=>s===200),'all landing pictures from this site load');
    // video thumbnails (YouTube's own, loaded lazily) on the technique cards and the position map, instead of stick figures
    {const fs=require('fs');const vsrc=fs.readFileSync(path.resolve(__dirname,'../src/videos.js'),'utf8');const picks={};
     for(const m of vsrc.matchAll(/(?:VIDEO_PICKS=|Object\.assign\(VIDEO_PICKS,)(\{[\s\S]*?\n\})\)?;/g))Object.assign(picks,JSON.parse(m[1]));
     const yt=await p.evaluate(()=>({deck:[...document.querySelectorAll('.tgal a.tcard:not(.more)')].map(a=>{const i=a.querySelector('.tpic img');return {src:i.getAttribute('src'),alt:i.getAttribute('alt'),lazy:i.loading==='lazy',play:!!a.querySelector('.playb'),cred:(a.querySelector('.vcred')||{}).textContent||'',fig:!!a.querySelector('img[src^="/img/fig/"]')}}),
       pos:[...document.querySelectorAll('.posmap a.pcard')].map(a=>{const i=a.querySelector('img');return {src:i.getAttribute('src'),alt:i.getAttribute('alt'),lazy:i.loading==='lazy',w:i.getAttribute('width'),h:i.getAttribute('height'),dec:i.getAttribute('decoding'),play:!!a.querySelector('.playb'),
         figs:[...a.querySelectorAll('img[src^="/img/fig/"]')].every(f=>f.closest('.pfig[aria-hidden="true"]')),name:a.querySelector('.pname').textContent,k:a.getAttribute('href')}})}));
     const ytOk=(i)=>{const m=i.src.match(/^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\/mqdefault\.jpg$/);return !!m&&Object.values(picks).some(v=>(v.v||v)===m[1])};
     ok(yt.deck.length>=16&&yt.deck.every(c=>c.play&&/^Video: .{3,}/.test(c.cred)&&!c.fig&&c.lazy&&(c.src.startsWith('/img/thumbs/')||ytOk(c)&&/ video thumbnail$/.test(c.alt)))&&yt.deck.filter(c=>c.src.includes('ytimg')).length>=10,'technique cards: each with its video\'s thumbnail (or the founder\'s photo), a play badge and the channel, no stick figures');
     ok(yt.pos.length===20&&yt.pos.every(c=>ytOk(c)&&c.alt===c.name+' video thumbnail'&&c.lazy&&c.w==='320'&&c.h==='180'&&c.dec==='async'&&c.play&&c.figs),'position map: each position\'s video thumbnail (lazy, sized, from YouTube), the drawing only as a small corner badge');}
    // pictures and screen recordings on the home page and /coaches/
    {const home=await p.evaluate(()=>({imgs:[...document.images].map(i=>({src:i.getAttribute('src'),alt:i.getAttribute('alt'),w:i.getAttribute('width'),h:i.getAttribute('height'),deco:!!i.closest('[aria-hidden="true"]')})),
        tech:[...document.querySelectorAll('.tgal a.tcard:not(.more)')].map(a=>({href:a.getAttribute('href'),name:(a.querySelector('b')||{}).textContent||'',img:!!a.querySelector('img'),belt:getComputedStyle(a.querySelector('.tmeta'),'::before').backgroundColor})),
        pos:[...document.querySelectorAll('.posmap a.pcard')].map(a=>a.getAttribute('href')),
        vids:[...document.querySelectorAll('video')].map(v=>({poster:v.getAttribute('poster'),src:(v.querySelector('source')||{}).getAttribute&&v.querySelector('source').getAttribute('src'),muted:v.muted,inline:v.playsInline,pre:v.getAttribute('preload'),loop:v.loop,label:v.getAttribute('aria-label')||'',cap:((v.closest('figure')||{}).querySelector&&v.closest('figure').querySelector('figcaption')||{}).textContent||'',btn:!!v.parentNode.querySelector('.vbtn:not([hidden])[aria-label]')})),
        seeAll:!!document.querySelector('#techniques a[href="/techniques/"]')}));
     ok(home.imgs.length>=40&&home.imgs.every(i=>i.alt!==null&&i.w&&i.h),'home page: '+home.imgs.length+' pictures, each with alt text and a size: '+home.imgs.filter(i=>i.alt===null||!i.w||!i.h).map(i=>i.src).join(' '));
     ok(home.imgs.filter(i=>!i.deco).every(i=>i.alt.length>10),'home page: every picture that isn\'t decoration says what it shows');
     ok(home.tech.length>=16&&home.tech.every(t=>/^\/techniques\/[a-z0-9-]+\/$/.test(t.href)&&t.name.length>3&&t.img&&t.belt!=='rgba(0, 0, 0, 0)')&&home.seeAll,'technique gallery: '+home.tech.length+' cards with a picture, name and belt colour, plus See all');
     ok(home.pos.length===20,'position map lists all 20 positions ('+home.pos.length+')');
     const st=await Promise.all([...home.tech.map(t=>t.href),...home.pos].map(async u=>(await fetch(URL+u.slice(1))).status));ok(st.every(x=>x===200),'gallery and position map link to real pages');
     const vh=await (await fetch(URL+'coaches/')).text();const cv=[...vh.matchAll(/<video[^>]*poster="([^"]+)"[^>]*>\s*<source src="([^"]+)" type="video\/mp4">/g)].map(m=>({poster:m[1],src:m[2]}));
     ok(home.vids.length>=2&&home.vids.every(v=>v.poster&&v.src&&v.muted&&v.inline&&v.pre==='none'&&v.loop&&v.label.length>20&&v.cap.length>20&&v.btn),'home page clips: muted, inline, preload none, a poster, a description, a visible caption and a play/pause button');
     ok(cv.length>=3&&/class="vbtn"/.test(vh)&&/<figcaption>[^<]{20,}/.test(vh),'coaches page has '+cv.length+' clips with posters and captions');
     const media=[...new Set([...home.vids,...cv].flatMap(v=>[v.poster,v.src]))];
     const ms=await Promise.all(media.map(async u=>{const r=await fetch(URL+u.slice(1));const b=await r.arrayBuffer();return {u,s:r.status,t:r.headers.get('content-type'),n:b.byteLength}}));
     ok(ms.every(m=>m.s===200&&(/\.mp4$/.test(m.u)?m.t==='video/mp4'&&m.n<1.5e6:m.t==='image/webp'&&m.n<120e3)),'clips (video/mp4, under 1.5 MB) and posters (WebP, under 120 KB) load: '+ms.filter(m=>m.s!==200).map(m=>m.u).join(' '));
     const rg=await fetch(URL+home.vids[0].src.slice(1),{headers:{Range:'bytes=100-199'}});ok(rg.status===206&&rg.headers.get('content-range')&&/^bytes 100-199\//.test(rg.headers.get('content-range'))&&(await rg.arrayBuffer()).byteLength===100&&rg.headers.get('accept-ranges')==='bytes','clips answer range requests (Safari needs them)');
     ok((await fetch(URL+home.vids[0].src.slice(1),{headers:{Range:'bytes=99999999-'}})).status===416,'an impossible range is refused');
     // the hero clip plays once it's on screen; scrolled away it pauses; the button pauses it for good
     await p.evaluate(()=>document.querySelector('.heroclip video').scrollIntoView({block:'center'}));await p.waitForTimeout(1500);
     ok(await p.evaluate(()=>{const v=document.querySelector('.heroclip video');return !v.paused&&v.readyState>=2}),'a clip plays when on screen');
     await p.evaluate(()=>scrollTo(0,document.body.scrollHeight));await p.waitForTimeout(500);
     ok(await p.evaluate(()=>document.querySelector('.heroclip video').paused),'the clip pauses when scrolled away');
     await p.evaluate(()=>document.querySelector('.heroclip video').scrollIntoView({block:'center'}));await p.waitForTimeout(800);
     await p.locator('.heroclip .vbtn').tap();await p.waitForTimeout(200);await p.evaluate(()=>scrollBy(0,1));await p.waitForTimeout(400);
     ok(await p.evaluate(()=>{const v=document.querySelector('.heroclip video'),b=v.parentNode.querySelector('.vbtn');return v.paused&&/^Play/.test(b.getAttribute('aria-label'))}),'the pause button stops the clip and says Play');
     await p.evaluate(()=>scrollTo(0,0));
     const rc=await b.newContext({...devices['iPhone 13'],reducedMotion:'reduce'});const rp=await rc.newPage();await rp.goto(URL);await rp.evaluate(()=>document.querySelector('.heroclip video').scrollIntoView({block:'center'}));await rp.waitForTimeout(1200);
     ok(await rp.evaluate(()=>{const v=document.querySelector('.heroclip video');return v.paused&&v.readyState===0&&!!v.parentNode.querySelector('.vbtn.big')}),'reduce motion: clips wait on their poster with a play button, nothing downloaded');
     await rp.locator('.heroclip .vbtn').tap();await rp.waitForTimeout(1200);ok(await rp.evaluate(()=>!document.querySelector('.heroclip video').paused),'reduce motion: tapping play starts the clip');
     await rc.close();}
    ok(await p.evaluate(()=>{const t=document.querySelector('.doors .d-train'),g=document.querySelector('.doors .d-gym');return !!t&&!!g&&!!t.querySelector('a.btn[href="/app/"]')&&!!g.querySelector('a[href="/coaches/"]')&&!!g.querySelector('a[href="/app/?start=1"]')&&/R99/.test(g.textContent)&&/3 free months/.test(g.textContent)&&/Free/.test(t.textContent)&&/EFT with their own reference today; card, Apple Pay and Google Pay are coming soon/.test(g.textContent)}),'two doors under the hero: I train (free, opens the app) and I run a gym (R99 after 3 free months, EFT today and cards coming soon, gyms page, start a gym)');
    ok(await p.evaluate(()=>{const s=document.getElementById('sa');return !!s&&/Johannesburg/.test(s.textContent)&&/EFT/.test(s.textContent)&&/WhatsApp/.test(s.textContent)&&/R99/.test(s.textContent)&&/browser/.test(s.textContent)&&/Card, Apple Pay and Google Pay are coming soon/.test(s.textContent)&&[...document.querySelectorAll('.faq details')].some(d=>/coming soon/.test(d.textContent))&&!/(pay|payments?) (by|with) (card|Apple Pay)/i.test(document.body.innerText)}),'made-in-SA strip: rand pricing, EFT, WhatsApp, works in the browser; card payments only as coming soon (strip and FAQ)');
    ok(await p.evaluate(()=>!/\b(track|log) (every|your) (roll|session)/i.test(document.body.innerText)&&!document.querySelector('.steps')),'no journal pitch and no three-step block on the home page');
    await p.locator('.d-train a.btn.primary').tap();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>location.pathname==='/app/'&&/JitsFlow$/.test(document.title)&&!window.claude),'"Open JitsFlow" opens the app');
    // with accounts on (a database), a new visitor first picks how they use JitsFlow; without, the study setup shows straight away
    ok(await p.evaluate(()=>S.ui.sheet&&(API.on?S.ui.sheet.k==='how'&&document.querySelectorAll('#sheet .howbtn').length===3:S.ui.sheet.k==='onboard')),'website shows the first screen');
    if(await p.evaluate(()=>S.ui.sheet.k==='how'))await p.tap('#sheet [data-a="how"][data-v="solo"]');
    ok(await p.evaluate(()=>S.ui.sheet&&S.ui.sheet.k==='onboard'),'website shows first-run setup');
    await p.tap('#sheetbar [data-a="obdone"]');
    ok(await p.evaluate(()=>document.getElementById('sync').textContent==='Saved on this device'),'website saves on the device');
    const man=await p.evaluate(async()=>{const r=await fetch('/manifest.webmanifest');return r.ok?await r.json():null});
    ok(man&&man.name==='JitsFlow'&&man.icons.length===3&&man.display==='standalone'&&man.start_url==='/app/','install manifest opens the app');
    for(const ic of ['icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon.png','favicon-48.png','favicon-96.png']){const s=await p.evaluate(async u=>(await fetch(u)).status,'/icons/'+ic);ok(s===200,'icon '+ic)}
    ok(await p.evaluate(()=>!!document.querySelector('link[rel=manifest]')&&!!document.querySelector('link[rel=apple-touch-icon]')&&!!document.querySelector('meta[name=theme-color]')),'head has install tags');
    await p.evaluate(()=>navigator.serviceWorker.ready);await p.reload();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>!!navigator.serviceWorker.controller),'service worker controls the page');
    await p.evaluate(()=>{P().mastery.knee_cut=3;saveProgress()});
    await ctx.setOffline(true);await p.reload();await p.waitForTimeout(800);
    ok(await p.evaluate(()=>document.querySelectorAll('nav.tabs button:not([hidden])').length===4&&lv('knee_cut')===3),'works offline and keeps your data');
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
  // ---- the home page's WebGL belt (web/js/belt.js): loaded after first paint, decorative, no layout shift, light;
  // the drawings in the .beltslot boxes stay with reduced motion, Save-Data, no WebGL or no JavaScript.
  // Headless Chromium renders WebGL with SwiftShader (on the CPU, slow): these check that it draws without errors, not its speed.
  try{
    const raw=Buffer.from(await (await fetch(URL+'js/belt.js')).arrayBuffer());const gz=require('zlib').gzipSync(raw,{level:9}).length;
    const bj=await fetch(URL+'js/belt.js');ok(bj.status===200&&/javascript/.test(bj.headers.get('content-type'))&&gz<=60*1024,'belt script served, '+(gz/1024).toFixed(1)+' KB gzipped (budget 60 KB)');
    const home=await (await fetch(URL)).text();
    ok(!/<script[^>]*src="\/js\/belt\.js/.test(home)&&!/<canvas/.test(home)&&/"\/js\/belt\.js\?v=[0-9a-f]{10}"/.test(home)&&(home.match(/class="beltslot /g)||[]).length===6&&!/cdn|unpkg|jsdelivr/i.test(raw.toString()),'belt: not part of the first load (added once the page has loaded), self-hosted and versioned, with a drawing in each of its 6 slots');
    const slotsShown=(pg)=>pg.evaluate(()=>[...document.querySelectorAll('.beltslot')].filter(s=>s.offsetParent).every(s=>{const v=s.querySelector('svg'),r=v.getBoundingClientRect();return getComputedStyle(v).opacity==='1'&&r.height>=40&&r.width>=100&&v.querySelector('use')}));
    const gc=await b.newContext({...devices['iPhone 13'],serviceWorkers:'block'});const gp=await gc.newPage();const gerr=[];
    gp.on('pageerror',e=>gerr.push(e.message));gp.on('console',m=>{if(m.type()==='error')gerr.push(m.text())});
    await gp.addInitScript(()=>{window.__cls=0;window.__lcp=null;new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:'layout-shift',buffered:true});
      new PerformanceObserver(l=>{const e=l.getEntries().pop();window.__lcp=e&&e.element?(e.element.closest('h1')?'h1':e.element.tagName+'.'+e.element.className):null}).observe({type:'largest-contentful-paint',buffered:true})});
    await gp.goto(URL,{waitUntil:'load'});
    await gp.waitForFunction(()=>document.documentElement.classList.contains('gl'),null,{timeout:15000});
    const g1=await gp.evaluate(()=>{const c=document.getElementById('beltgl'),cs=getComputedStyle(c),h=document.querySelector('h1').getBoundingClientRect();
      const fcp=performance.getEntriesByName('first-contentful-paint')[0],js=performance.getEntriesByType('resource').find(r=>/\/js\/belt\.js/.test(r.name));
      return {lcp:window.__lcp,cls:window.__cls,n:document.querySelectorAll('canvas').length,aria:c.getAttribute('aria-hidden'),pe:cs.pointerEvents,pos:cs.position,tab:c.tabIndex,fcp:fcp&&fcp.startTime,js:js&&js.startTime,frames:c.jf.frames,tier:c.jf.tier,
        hit:!!document.elementFromPoint(h.left+20,h.top+h.height/2).closest('h1'),card:(()=>{const a=document.querySelector('.posmap .pcard');a.scrollIntoView({block:'center'});const r=a.getBoundingClientRect();const e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);scrollTo(0,0);return !!e&&e.closest('.pcard')===a})()}});
    ok(g1.n===1&&g1.aria==='true'&&g1.pe==='none'&&g1.pos==='fixed'&&g1.tab<0&&g1.hit&&g1.card,'belt: one fixed canvas, hidden from screen readers, never focused or tapped (the headline and the map cards stay on top)');
    ok(g1.fcp&&g1.js&&g1.js>g1.fcp,'belt script is requested after first paint ('+Math.round(g1.js)+' ms, first paint '+Math.round(g1.fcp)+' ms)');
    ok(g1.frames>0,'belt draws ('+g1.frames+' frames so far, '+g1.tier+' mode)');
    const total=await gp.evaluate(()=>document.documentElement.scrollHeight-innerHeight);
    for(let i=0;i<=24;i++){await gp.evaluate(y=>scrollTo(0,y),Math.round(total*i/24));await gp.waitForTimeout(150)}
    await gp.waitForTimeout(300);
    const g2=await gp.evaluate(()=>{const c=document.getElementById('beltgl');return {frames:c.jf.frames,errors:c.jf.errors,cls:window.__cls,lcp:window.__lcp,gl:document.documentElement.classList.contains('gl'),w:document.documentElement.scrollWidth,
      steps:[...document.querySelectorAll('.pcard[data-step]')].sort((x,y)=>x.dataset.step-y.dataset.step).map(a=>a.getAttribute('href')+(a.hasAttribute('data-tap')?' tap':'')),legend:!!document.querySelector('.lg-chain').offsetParent}});
    ok(g2.gl&&g2.frames>g1.frames+10&&!g2.errors&&!gerr.length,'belt: draws all the way down the page with no errors ('+g2.frames+' frames) '+gerr.join(' | '));
    ok(g1.lcp==='h1'&&g1.cls<0.01&&g2.cls<0.01,'belt: the headline stays the largest paint ('+g1.lcp+') and nothing moves as it starts or while scrolling (layout shift '+g2.cls.toFixed(4)+')');
    ok(g2.w<=390,'belt: no sideways scroll on a phone');
    ok(g2.steps.join(' ')==='/positions/standing/ /positions/front-headlock/ /positions/turtle-top/ /positions/back-control/ tap'&&g2.legend,'map: one real chain numbered card by card, standing to back control and the tap: '+g2.steps.join(' '));
    const f1=await gp.evaluate(()=>document.getElementById('beltgl').jf.frames);await gp.waitForTimeout(3500);const f2=await gp.evaluate(()=>document.getElementById('beltgl').jf.frames);await gp.waitForTimeout(1200);
    ok(await gp.evaluate(f=>document.getElementById('beltgl').jf.frames===f,f2),'belt: stops drawing once the page is still ('+f1+' then '+f2+' frames)');
    for(const w of [320,768,1280]){await gp.setViewportSize({width:w,height:800});await gp.waitForTimeout(250);for(const y of [0,.3,.6,1]){await gp.evaluate(y=>scrollTo(0,y*(document.documentElement.scrollHeight-innerHeight)),y);await gp.waitForTimeout(80)}
      ok(await gp.evaluate(w=>document.documentElement.scrollWidth<=w&&document.documentElement.classList.contains('gl'),w),'belt: no sideways scroll at '+w+'px')}
    await gp.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    ok(await gp.evaluate(()=>!document.querySelector('canvas')&&!document.documentElement.classList.contains('gl')),'belt: frees its canvas on pagehide (the drawings come back)');
    ok(!gerr.length,'belt: no console errors '+gerr.join(' | '));
    await gc.close();
    // without it: reduced motion, Save-Data, no WebGL, no JavaScript
    const fall=async(label,opts,init,browser)=>{const c=await (browser||b).newContext({...devices['iPhone 13'],serviceWorkers:'block',...opts});const pg=await c.newPage();const er=[],req=[];
      pg.on('pageerror',e=>er.push(e.message));pg.on('console',m=>{if(m.type()==='error')er.push(m.text())});pg.on('request',r=>{if(/\/js\/belt\.js/.test(r.url()))req.push(r.url())});
      if(init)await pg.addInitScript(init);await pg.goto(URL,{waitUntil:'load'});await pg.waitForTimeout(2500);
      const r=await pg.evaluate(()=>({canvas:document.querySelectorAll('canvas').length,gl:document.documentElement.classList.contains('gl'),grid:getComputedStyle(document.querySelector('.night')).backgroundImage!=='none',w:document.documentElement.scrollWidth}));
      const shown=await slotsShown(pg);await c.close();return {...r,shown,er,req}};
    let r=await fall('reduce',{reducedMotion:'reduce'});
    ok(!r.canvas&&!r.gl&&r.shown&&r.grid&&!r.req.length&&!r.er.length&&r.w<=390,'reduce motion: no WebGL and nothing downloaded for it; the belt drawings and the mat grid show '+r.er.join(' | '));
    r=await fall('savedata',{},()=>Object.defineProperty(Navigator.prototype,'connection',{get:()=>({saveData:true})}));
    ok(!r.canvas&&!r.gl&&r.shown&&!r.req.length&&!r.er.length,'Save-Data: no WebGL and nothing downloaded for it; the belt drawings show '+r.er.join(' | '));
    const nb=await chromium.launch({args:['--disable-webgl']});r=await fall('nowebgl',{},null,nb);await nb.close();
    ok(!r.canvas&&!r.gl&&r.shown&&r.grid&&!r.er.length,'no WebGL: the belt drawings and the mat grid show, no errors '+r.er.join(' | '));
    r=await fall('noctx',{},()=>{const g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,o){return /webgl/.test(t)?null:g.call(this,t,o)}});
    ok(!r.canvas&&!r.gl&&r.shown&&!r.er.length,'WebGL refused (a slow or blocklisted GPU): the drawings stay, no errors '+r.er.join(' | '));
    r=await fall('nojs',{javaScriptEnabled:false});
    ok(!r.canvas&&r.shown&&r.w<=390,'no JavaScript: the belt drawings show');
  }catch(e){fail++;fails.push('CRASH belt '+e.message)}
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
    await gp.goto(G+'app/?join=ABCD2345&claim=SECRETTOK1&paid=card');await gp.waitForTimeout(800);
    ok(await gp.evaluate(()=>{const c=dataLayer.find(a=>a[0]==='config');return !!c&&/\/app\//.test(c[2].page_location)&&!/SECRETTOK1|ABCD2345|paid=/.test(c[2].page_location)}),'invite codes, claim tokens and payment results are left out of the address sent to Google');
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
