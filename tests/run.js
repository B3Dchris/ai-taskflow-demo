// End-to-end tests for Road to Blue. Usage: node run.js [local|db] [deviceName]
const {chromium,devices}=require('playwright');const fs=require('fs');const path=require('path');
const MODE=process.argv[2]||'local',DEV=process.argv[3]||'iPhone 13';
const SRC=path.resolve(__dirname,'../dist/jitsflow-claude.html'),PAGE=path.resolve(__dirname,'page.html');
fs.writeFileSync(PAGE,'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'+fs.readFileSync(SRC,'utf8'));
const URL='file://'+PAGE;let pass=0,fail=0;const fails=[];
const ok=(c,m)=>{if(c)pass++;else{fail++;fails.push(m)}};
const MOCK=()=>{ // simulated claude.ai runtime: per-user db with frozen snapshots + assets, persisted across reloads
  const K='__mockdb';const load=()=>{try{return JSON.parse(localStorage.getItem(K)||'{}')}catch(e){return {}}};const save=o=>localStorage.setItem(K,JSON.stringify(o));
  const deep=o=>{Object.values(o).forEach(v=>{if(v&&typeof v==='object')deep(v)});return Object.freeze(o)};
  const subs={};window.__writes=0;
  const snap=p=>{const st=load();return {id:p.split('/').pop(),exists:p in st,data:()=>p in st?deep(JSON.parse(JSON.stringify(st[p]))):undefined,metadata:{fromCache:false,hasPendingWrites:false}}};
  const fire=()=>Object.entries(subs).forEach(([k,fs])=>fs.forEach(f=>f()));
  const ref=p=>({id:p.split('/').pop(),path:p,set:async d=>{const st=load();st[p]=JSON.parse(JSON.stringify(d));save(st);window.__writes++;setTimeout(fire,10)},
    update:async d=>{},get:async()=>snap(p),delete:async()=>{const st=load();delete st[p];save(st);setTimeout(fire,10)},
    onSnapshot:(f)=>{(subs[p]=subs[p]||[]).push(()=>f(snap(p)));setTimeout(()=>f(snap(p)),20);return()=>{}},collection:c=>col(p+'/'+c)});
  const col=p=>{const q={orderBy(){return q},limit(){return q},doc:id=>ref(p+'/'+id),
    onSnapshot:f=>{const run=()=>{const st=load();const docs=Object.keys(st).filter(k=>k.startsWith(p+'/')&&k.split('/').length===p.split('/').length+1).map(snap).sort((a,b)=>a.data().date<b.data().date?1:-1);f({docs,metadata:{fromCache:false}})};(subs[p]=subs[p]||[]).push(run);setTimeout(run,20);return()=>{}}};return q};
  let n=0;window.claude={use:async name=>name==='db'?{doc:ref,collection:col}:name==='user'?{id:async()=>'u_test',isOwner:async()=>true}:name==='sample'?Object.assign(async(input,opts)=>{window.__asked=(window.__asked||0)+1;window.__lastPrompt=typeof input==='string'?input:'';const t='## Why it works\n- Your **underhook** lifts their arm.\n- Keep a crossface.\n\nDrill it 10 times.';await new Promise(r=>setTimeout(r,30));if(opts&&opts.signal&&opts.signal.aborted)throw {code:'cancelled'};opts&&opts.onText&&opts.onText({text:t,delta:t});return {text:t,truncated:false}},{json:async()=>({}),limits:async()=>({maxPromptBytes:262144})}):name==='assets'?{upload:async b=>{n++;return {id:String(n).padStart(32,'a'),url:'x'}},delete:async()=>({deleted:true})}:null};
};
(async()=>{
  const b=await chromium.launch();const ctx=await b.newContext({...devices[DEV],deviceScaleFactor:1});
  if(MODE==='db')await ctx.addInitScript(MOCK);
  const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/_blob|ERR_FILE_NOT_FOUND|Failed to load resource/.test(m.text()))errs.push(m.text())});
  const vw=devices[DEV].viewport.width;
  const overflow=async(label)=>{const w=await p.evaluate(()=>document.documentElement.scrollWidth);ok(w<=vw,`${label}: page scrolls sideways (${w}px > ${vw}px)`)};
  const ev=(f,a)=>p.evaluate(f,a);const sheetH1=()=>ev(()=>document.querySelector('#sheet h1')?.innerText||'');
  await p.goto(URL+'#today');await p.waitForTimeout(MODE==='db'?400:200);
  if(MODE==='db'){ok((await ev(()=>document.getElementById('sync').textContent))==='Saved to your account','db: sync label shows account saving');ok(await ev(()=>getComputedStyle(document.getElementById('sync')).display==='none'),'db: the saved status stays out of the way when all is saved')}
  // --- first-run setup
  await p.waitForTimeout(500);
  ok(await ev(()=>S.ui.sheet&&S.ui.sheet.k==='onboard'&&/Welcome to JitsFlow/.test(document.body.innerText)),'first launch shows setup');
  await p.locator('[data-a="obset"][data-k="belt"][data-v="white"]').tap();await p.locator('[data-a="obset"][data-k="pw"][data-v="2"]').tap();
  await p.selectOption('#ob-months','9');await p.locator('[data-a="obset"][data-k="hand"][data-v="left"]').tap();await p.tap('#sheetbar [data-a="obdone"]');
  ok(await ev(()=>goal()==='blue'&&P().settings.perWeek===2&&P().settings.onboarded===true&&P().settings.days.join()==='1,3'&&P().settings.priorHours===117),'setup saves belt goal, schedule and hours');
  // --- tabs render
  ok(await ev(()=>[...document.querySelectorAll('nav.tabs button:not([hidden])')].map(b=>b.textContent.trim()).join()==='Home,Learn,Journal,Me'),'self-study gets 4 plain tabs: Home, Learn, Journal, Me (no Classes without a gym)');
  for(const t of ['home','learn','journal','me']){await p.tap(`nav.tabs [data-v="${t}"]`);await p.waitForTimeout(60);ok(await ev(()=>document.getElementById('app').innerText.length>200),`tab ${t} renders`);await overflow('tab '+t)}
  await p.tap('nav.tabs [data-v="learn"]');
  for(const v of ['moves','map','belt']){await p.tap(`.learnseg [data-v="learn-${v}"]`);await p.waitForTimeout(60);ok(await ev(v=>S.ui.learnView===v&&location.hash===(v==='moves'?'#learn':'#learn-'+v)&&document.querySelector(`.learnseg [data-v="learn-${v}"]`).getAttribute('aria-pressed')==='true'&&document.getElementById('app').innerText.length>200,v),`Learn › ${v} renders`);await overflow('learn '+v)}
  await p.tap('nav.tabs [data-v="home"]');await p.tap('nav.tabs [data-v="learn"]');ok(await ev(()=>S.ui.learnView==='belt'),'Learn remembers the part you last had open');
  // --- old addresses open the new places
  for(const [h,want,lv] of [['flow','#learn-map','map'],['log','#journal'],['settings','#me'],['today','#home'],['learn','#learn','moves']]){await ev(h=>{location.hash=h},h);await p.waitForTimeout(80);ok(await ev(([w,lv])=>location.hash===w&&(!lv||S.ui.learnView===lv),[want,lv]),`#${h} opens ${want}`)}
  // --- first-visit tips: one line per tab, gone once closed or after 3 visits
  await p.tap('nav.tabs [data-v="journal"]');
  ok(await ev(()=>/training journal/i.test((document.querySelector('.tip')||{}).textContent||'')),'Journal shows its tip on the first visits');
  await p.tap('.tip [data-a="tipx"]');ok(await ev(()=>!document.querySelector('.tip')&&(lsGet('jf.tips.me')||{}).journal===-1),'closing a tip hides it');
  await p.tap('nav.tabs [data-v="home"]');await p.tap('nav.tabs [data-v="journal"]');ok(await ev(()=>!document.querySelector('.tip')),'a closed tip stays closed');
  await ev(()=>{const t=lsGet('jf.tips.me')||{};delete t.me;lsSet('jf.tips.me',t)});
  for(let i=1;i<=4;i++){await p.tap('nav.tabs [data-v="home"]');await p.tap('nav.tabs [data-v="me"]');ok(await ev(()=>!!document.querySelector('.tip'))===(i<=3),`Me tip on visit ${i}: ${i<=3?'shown':'gone'}`)}
  // --- every technique sheet
  const ids=await ev(()=>TECH.map(t=>t.id));
  for(const id of ids){await ev(id=>techSheet(id),id);const r=await ev(id=>({h:document.querySelector('#sheet h1')?.innerText,lead:document.querySelector('#sheet .lead')?.innerText||'',steps:document.querySelectorAll('#sheet ol.steps li').length,n:TM[id].s.length,name:TM[id].n,fig:!!document.querySelector('#sheet .posfig svg, #sheet .photo img, #sheet .posimg img, #sheet .ytembed iframe, #sheet a.ytpick'),yt:(document.querySelector('#sheet a.yt:not(.ytpick)')||{}).href||''}),id);
    ok(/^https:\/\/www\.youtube\.com\/results\?search_query=.+no%20gi%20bjj$/.test(r.yt),`technique ${id} has a YouTube link`);
    ok(r.h===r.name&&r.lead.length>40&&r.steps===r.n&&r.fig,`technique sheet ${id} incomplete`);}
  await overflow('technique sheet');await ev(()=>closeSheet());
  // --- every flow node
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-map"]');
  const pos=await ev(()=>Object.keys(POS));
  for(const k of pos){await p.locator(`.flowsvg g.node[data-v="${k}"]`).tap();const r=await ev(k=>({h3:document.querySelector('.panel h3')?.innerText,want:POS[k].L,d:document.querySelector('.panel')?.innerText.includes(PD[k].d),sel:!!document.querySelector(`.flowsvg g.node.sel[data-v="${k}"]`),yt:!!document.querySelector('.panel a.yt[href*="youtube.com/results"]')}),k);ok(r.yt,`position ${k} has a YouTube link`);ok(r.h3===r.want&&r.d&&r.sel,`flow node ${k}`)}
  await overflow('flow');
  // --- flow map: destination badges, progress bars, route finder, other side
  await p.locator('.flowsvg g.node[data-v="hg_bot"]').tap();
  ok(await ev(()=>{const outs=fromPos('hg_bot',flowMax()),ds=new Set(outs.map(t=>t.t).filter(d=>d!=='hg_bot'));return ds.size>0&&document.querySelectorAll('.flowsvg .edge').length===ds.size&&[...document.querySelectorAll('.flowsvg g.dest')].length===ds.size&&[...document.querySelectorAll('.flowsvg g.dest[data-v]')].every(g=>ds.has(g.dataset.v))&&document.querySelectorAll('.flowsvg g.dim').length>0}),'flow map: an arrow to every place you can go, those places highlighted, the rest faded');
  ok(await ev(()=>{const up=[...document.querySelectorAll('.flowsvg .edge.up')].length,want=new Set(fromPos('hg_bot',flowMax()).filter(t=>t.t!=='sub'&&t.t!=='hg_bot'&&POS[t.t].r<POS.hg_bot.r).map(t=>t.t)).size;return up===want}),'flow map: arrows to better positions are marked as going up');
  ok(await ev(()=>document.querySelectorAll('.flowsvg .kbar-bg').length>=18&&/how much of a position/.test(document.querySelector('.flowkey').innerText)),'flow map: a progress bar on every position, with a key');
  ok(await ev(()=>{const cards=[...document.querySelectorAll('.fsk-d')],lines=document.querySelectorAll('.fsk-lines path.fl');const outs=fromPos('hg_bot',flowMax());return cards.length===new Set(outs.map(t=>t.t)).size&&lines.length===cards.length&&cards.reduce((n,c)=>n+c.querySelectorAll('.fmv').length,0)===outs.length}),'from here: one line and one card per destination, listing every move');
  ok(await ev(()=>[...document.querySelectorAll('.fsk-lines path.fl')].every(l=>{const d=l.getAttribute('d');return /^M[\d.]+,[\d.]+ L/.test(d)&&!/NaN/.test(d)})),'from here: every line is drawn');
  {const dest=await ev(()=>document.querySelector('.fsk-d button.fsk-h').dataset.v);await p.locator('.fsk-d button.fsk-h').first().tap();ok(await ev(d=>S.ui.flowSel===d&&!!document.querySelector(`.flowsvg g.node.sel[data-v="${d}"]`),dest),'from here: Go moves the map to that position');await p.locator('.flowsvg g.node[data-v="hg_bot"]').tap();}
  ok(await ev(()=>Object.keys(POS).every(a=>Object.keys(POS).every(b=>{const r=routeFind(a,b,4);return r===null||(a===b?r.length===0:r.length>0&&r[0].f===a&&r[r.length-1].t===b&&r.every((t,i)=>i===0||r[i-1].t===t.f))}))),'every route found is a real chain of moves from start to finish');
  await p.selectOption('#rt-to','back_top');
  ok(await ev(()=>{const r=routeFind('hg_bot','back_top',flowMax());return r&&document.querySelectorAll('.routesteps .rmove').length===r.length&&document.querySelectorAll('.routesteps .rpos').length===r.length+1}),'route finder shows half guard to back control step by step');
  await p.locator('.routesteps .rmove [data-a="open"]').first().tap();ok(await ev(()=>S.ui.sheet&&S.ui.sheet.k==='tech'),'tapping a route move opens it');await ev(()=>closeSheet());
  await p.locator('.panel [data-a="pos"][data-v="hg_top"]').tap();ok(await ev(()=>S.ui.flowSel==='hg_top'),'"See it from the other side" flips to half guard top');
  await overflow('flow route');
  // --- quick rate everything via the bottom bar (mix of levels), with one skip
  await p.tap('nav.tabs [data-v="home"]');await p.tap('.panel.accent button[data-a="qr"]');
  const total=await ev(()=>S.ui.qr.q.length);const want=await ev(()=>rateable().length);ok(total===want&&total>54,`rate queue is ${total}, expected ${want}`);
  await p.tap('#sheetbar [data-a="qrnext"]');
  for(let i=1;i<total;i++){await p.tap(`#sheetbar [data-a="qrset"][data-v="${i%5}"]`)}
  await p.waitForTimeout(150);ok(await ev(()=>document.getElementById('sheet').hidden&&/Rated/.test(document.getElementById('toast').textContent)),'quick rate finishes by itself, no screen to close');
  const rq=await ev(()=>rateQueue().length);ok(rq===1,`one skipped technique left to rate (got ${rq})`);
  ok(await ev(t=>document.body.innerText.includes(`${t-1}/${t} rated`),total),'rate card shows one left to rate');
  ok(await ev(()=>readiness()>0),'readiness score above 0 after rating');
  if(MODE==='db'){await p.waitForTimeout(800);ok(await ev(()=>window.__writes>0),'db: ratings written to account')}
  // rating still works after a sync round-trip with read-only data (the original bug)
  await p.tap('.panel.accent button[data-a="qr"]');await p.tap('#sheetbar [data-a="qrset"][data-v="3"]');
  await p.waitForTimeout(150);ok(await ev(()=>document.getElementById('sheet').hidden&&/Rated/.test(document.getElementById('toast').textContent)),'rating works after data reloads from the account');
  ok(await ev(()=>!document.querySelector('.panel.accent [data-a="qr"]')||rateQueue().length===0),'rate card hides once everything is rated');
  // --- review
  const due=await ev(()=>dueList().length);ok(due>0,'review queue has cards after rating');
  await p.locator('button[data-a="review"]').tap();
  ok(await ev(()=>!document.querySelector('#sheetbar [data-a="reveal"]')&&document.querySelectorAll('#sheet ol.steps li').length>0),'review shows the steps straight away (no Show steps tap)');ok(await ev(()=>{const b=[...document.querySelectorAll('#sheetbar [data-a="rate"]')].map(x=>x.innerText.replace(/\s+/g,' '));return b.length===4&&/^Forgot tomorrow$/.test(b[0])&&/^Easy in \d+ (days|weeks|months)$/.test(b[3])&&!/later|soon/.test(b.join(' '))}),'review buttons say when each move comes back');
  for(let i=0;i<due;i++){ok(await ev(()=>document.querySelectorAll('#sheet ol.steps li').length>0),'review shows steps');await p.tap(`#sheetbar [data-a="rate"][data-v="${i%4}"]`)}
  await p.waitForTimeout(150);ok(await ev(()=>document.getElementById('sheet').hidden&&/reviewed/.test(document.getElementById('toast').textContent)),'review finishes by itself, no Done screen to close');
  await ev(()=>{P().settings.quiz=true;P().srs.knee_cut={due:today(),ivl:3,ease:2.3};S.ui.review={q:["knee_cut"],i:0,shown:false};reviewSheet()});
  ok(await ev(()=>!!document.querySelector('#sheetbar [data-a="reveal"]')&&!document.querySelector('#sheet ol.steps')),'quiz mode (a setting) hides the steps until Show steps');
  await ev(()=>{P().settings.quiz=false;S.ui.review=null;hideSheet()});
  ok(await ev(()=>dueList().length===0||dueList().every(id=>P().srs[id].due<=today())),'review rescheduled cards');
  // --- technique sheet: level, notes, chain + back stack, swipe back
  await ev(()=>techSheet('knee_cut'));await p.tap('#sheet [data-a="level"][data-v="3"]');ok(await ev(()=>lv('knee_cut')===3),'level set from technique sheet');
  await p.locator('#sheet textarea[data-note]').fill('Underhook first!');ok(await ev(()=>P().notes.knee_cut==='Underhook first!'),'note saved to progress');
  const chain=p.locator('#sheet .list .trow').first();await chain.scrollIntoViewIfNeeded();await chain.tap();
  ok((await ev(()=>document.querySelector('#sheetbar .back').innerText)).includes('Back'),'chained technique shows Back');
  await ev(()=>{const sh=document.getElementById('sheet');const mk=(type,x,y)=>{const t=new Touch({identifier:1,target:sh,clientX:x,clientY:y});sh.dispatchEvent(new TouchEvent(type,{touches:type==='touchend'?[]:[t],changedTouches:[t],bubbles:true}))};mk('touchstart',60,300);mk('touchend',220,310)});
  ok((await sheetH1())==='Knee cut (knee slice) pass','swipe right goes back one technique');
  await p.tap('#sheetbar .back');ok(await ev(()=>document.getElementById('sheet').hidden),'Close returns to the tab');
  // --- log: new, effects, edit, delete
  await p.tap('nav.tabs [data-v="journal"]');await p.tap('[data-a="lognew"]');
  await p.selectOption('#f-taught','over_under');await p.selectOption('#f-hits','triangle');await p.selectOption('#f-tapped','rnc');
  await p.locator('#sheet [data-a="stuck"][data-v="hg_bot"]').tap();await p.locator('#sheet [data-a="stuck"][data-v="sc_bot"]').tap();
  await p.locator('#f-worked').fill('Knee shield held up');await p.tap('#sheetbar button[type=submit]');await p.waitForTimeout(150);
  ok(await ev(()=>location.hash==='#journal'&&document.querySelectorAll('.sess').length===1),'session saved and listed');
  ok(await ev(()=>lv('triangle')===4&&lv('over_under')>=1),'logging updates technique levels');
  ok(await ev(()=>document.body.innerText.includes('Half guard')&&!!document.querySelector('.bar')),'stuck chart shows');
  await p.locator('.linkbtn[data-a="editlog"]').tap();ok((await ev(()=>document.querySelector('.sheettitle').innerText))==='Edit session','edit opens with title');
  ok(await ev(()=>document.getElementById('f-worked').value==='Knee shield held up'),'edit form prefilled');
  await p.locator('#f-mins').fill('75');await p.tap('#sheetbar button[type=submit]');await p.waitForTimeout(150);
  ok(await ev(()=>S.sessions.length===1&&Number(S.sessions[0].mins)===75),'edit updates the same session');
  await p.tap('nav.tabs [data-v="home"]');ok(await ev(()=>/weak spot/i.test(document.body.innerText)),'weak spot card on Today');
  ok(await ev(()=>/1 week streak/.test(document.querySelector('.lprog').innerText)&&weekStreak()===1),'week streak counts this week');
  await p.tap('nav.tabs [data-v="journal"]');await p.locator('.linkbtn[data-a="del"]').tap();await p.waitForTimeout(250);
  ok(await ev(()=>S.sessions.length===0&&/Session deleted/.test(document.getElementById('toast').textContent)),'session deletes in one tap, with Undo');
  await p.locator('#toast [data-a="toastact"]').tap();await p.waitForTimeout(400);ok(await ev(()=>S.sessions.length===1),'Undo brings the session back');
  await p.locator('.linkbtn[data-a="del"]').tap();await p.waitForTimeout(250);ok(await ev(()=>S.sessions.length===0),'and it deletes again');
  // --- flow map: tapping a position keeps your place on the page
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-map"]');await p.waitForTimeout(300);await ev(()=>window.scrollTo(0,120));await p.waitForTimeout(100);
  {const y0=await ev(()=>window.scrollY);await p.locator('.flowsvg g.node[data-v="mount_top"]').tap();await p.waitForTimeout(250);
   ok(await ev(y0=>S.ui.flowSel==='mount_top'&&Math.abs(window.scrollY-y0)<3,y0),'tapping a position on the map doesn\'t jump the page');}
  // --- smart search: typos, slang, initials; suggestions as you type
  ok(await ev(()=>{const top=q=>(searchAll(q,1)[0]||{}).id;return top('rnc')==='rnc'&&/kimura/.test(top('kimra'))&&/triangle/.test(top('trangle'))&&top('dbl leg')==='double_leg'&&/^Armbar/.test((searchAll('arm bar',1)[0]||{}).label)&&searchAll('xyzzy').length===0}),'search forgives typos, knows slang and initials (rnc, kimra, trangle, dbl leg)');
  ok(await ev(()=>{const top=q=>(searchAll(q,1)[0]||{}).id;return top('japanese neck tie')==='japanese_necktie'&&top('peruvian necktie')==='peruvian_necktie'&&searchAll('flag pole guillotine',8).some(x=>x.id==='flying_guillotine')&&!!VIDS.japanese_necktie&&!!VIDS.peruvian_necktie}),'lesser-known moves are in, with videos; an unknown word in a search is skipped');
  ok(await ev(()=>{const r=searchAll('half gaurd',3);return r[0].k==='p'&&/half guard/i.test(r[0].label)}),'a misspelt position finds the position first');
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');await p.locator('#q').tap();await p.keyboard.type('kimra');await p.waitForTimeout(400);
  ok(await ev(()=>{const rows=[...document.querySelectorAll('#qsugg .qsugg-row')];return rows.length>0&&/Kimura/.test(rows[0].innerText)&&document.activeElement.id==='q'&&[...document.querySelectorAll('#learn-groups .trow .nm')].some(n=>/Kimura/.test(n.innerText))}),'suggestions appear as you type and the list filters, keyboard stays up');
  await p.locator('#qsugg .qsugg-row').first().tap();ok(await ev(()=>S.ui.sheet&&S.ui.sheet.k==='tech'&&/kimura/.test(S.ui.sheet.id)),'tapping a suggestion opens it');await ev(()=>closeSheet());
  await p.fill('#q','');await p.waitForTimeout(250);ok(await ev(()=>!document.querySelector('#qsugg .qsugg-row')),'clearing the search clears the suggestions');
  // --- technique page: how you get here / where to from here
  ok(await ev(()=>{techSheet('knee_cut');const f=[...document.querySelectorAll('#sheet .flowsec')];return f.length===2&&/Moves that get you to passing/.test(f[0].innerText)&&/Side control/.test(f[1].innerText)&&!!f[1].querySelector('[data-a="open"]')}),'technique page: how you get here and where to from here, both tappable');
  ok(await ev(()=>{techSheet('upa');return /when your partner gets to/.test(document.querySelector('#sheet .flowsec').innerText)}),'a bad position explains how you end up there');
  ok(await ev(()=>{techSheet('rnc');return /If they defend, switch to/.test([...document.querySelectorAll('#sheet .flowsec')][1].innerText)}),'a submission says what to switch to if they defend');
  await ev(()=>closeSheet());
  // --- curriculum search keeps keyboard focus; filters; collapsible
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');await p.locator('#q').tap();await p.keyboard.type('armbar');await p.waitForTimeout(300);
  ok(await ev(()=>document.activeElement&&document.activeElement.id==='q'),'search keeps focus while typing');
  ok(await ev(()=>{const rows=[...document.querySelectorAll('#learn-groups details.grp[open] .trow')];const ids=searchTechIds('armbar');return rows.length===ids.size&&rows.length>=3&&rows.some(r=>/defense/i.test(r.innerText))&&rows.some(r=>/^Armbar/m.test(r.innerText))}),'search "armbar" finds attacks and defenses, across belts');
  await p.locator('#q').fill('zzzz');await p.waitForTimeout(250);await p.locator('[data-a="clearq"]').tap();
  ok(await ev(()=>S.ui.q===''&&document.querySelectorAll('#learn-groups details.grp').length===20),'clear search restores 20 groups');
  await p.locator('[data-a="filter"][data-v="plus"]').tap();ok(await ev(()=>document.querySelectorAll('#learn-groups .trow').length===TECH.filter(t=>t.p==='plus'&&beltOf(t)==='blue').length),'bonus filter');
  await p.locator('[data-a="filter"][data-v="all"]').first().tap();
  // --- solo drills
  await p.tap('nav.tabs [data-v="home"]');await ev(()=>{const d=document.querySelector('details.more');if(!d.open)d.querySelector('summary').click()});const c=p.locator('.check').first();await c.scrollIntoViewIfNeeded();await c.tap();ok(await ev(()=>P().solo.done.length===1),'solo drill ticks');
  // --- settings: hand, numbers, backup, import, reset
  await p.tap('nav.tabs [data-v="me"]');await p.evaluate(()=>document.querySelectorAll('details.more:not([open]) summary').forEach(x=>x.click()));await p.locator('[data-a="hand"][data-v="right"]').tap();ok(await ev(()=>document.documentElement.classList.contains('righty')),'right-hand mode');
  await p.locator('[data-a="hand"][data-v="left"]').tap();
  await p.locator('#s-pw').fill('3');ok(await ev(()=>P().settings.perWeek===3),'sessions per week saved');
  await p.locator('[data-a="export"]').tap();await p.waitForTimeout(100);
  const backup=await ev(()=>JSON.stringify({progress:P(),sessions:S.sessions}));
  await p.locator('[data-a="importshow"]').tap();await p.locator('#importtxt').fill('not json');await p.locator('[data-a="importdo"]').tap();
  ok(await ev(()=>/isn't a JitsFlow backup/.test(document.getElementById('toast').textContent)),'bad backup rejected with message');
  await p.locator('[data-a="reset"]').tap();await p.locator('[data-a="resetyes"]').tap();ok(await ev(()=>Object.keys(P().mastery).length===0),'reset clears ratings');
  await p.locator('[data-a="importshow"]').tap();await p.locator('#importtxt').fill(backup);await p.locator('[data-a="importdo"]').tap();
  ok(await ev(()=>Object.keys(P().mastery).length>=54),'backup restores ratings');
  // --- photos (account mode only)
  if(MODE==='db'){await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-map"]');await p.locator('.flowsvg g.node[data-v="hg_bot"]').tap();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
    await p.setInputFiles('#ph-hg_bot',{name:'a.png',mimeType:'image/png',buffer:png});await p.waitForTimeout(800);
    ok(await ev(()=>!!P().photos.hg_bot&&!!document.querySelector('.panel .photo img')&&!document.querySelector('.panel .posfig')),'photo upload replaces diagram');
    await p.locator('[data-a="phdel"]').tap();await p.locator('[data-a="phdelyes"]').tap();ok(await ev(()=>!P().photos.hg_bot&&!!document.querySelector('.panel .posfig')),'photo removed, diagram back');
    // reload: data comes back from the account
    await p.waitForTimeout(900);await p.reload();await p.waitForTimeout(500);
    ok(await ev(()=>Object.keys(P().mastery).length>=54&&P().notes.knee_cut==='Underhook first!'),'db: progress survives reload');
    await p.tap('nav.tabs [data-v="home"]');await ev(()=>{const d=document.querySelector('details.more');if(!d.open)d.querySelector('summary').click()});const c2=p.locator('.check').nth(2);await c2.scrollIntoViewIfNeeded();await c2.tap();ok(await ev(()=>P().solo.done.includes(2)),'db: edits work on reloaded read-only data');
  }
  // --- belt stages
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');
  for(const k of ['purple','brown','black','blue']){await p.locator(`.beltchips [data-v="${k}"]`).tap();const r=await ev(k=>({n:document.querySelectorAll('#learn-groups .trow').length,want:TECH.filter(t=>beltOf(t)===k).length}),k);ok(r.n===r.want&&r.want>0,`belt stage ${k} lists ${r.n} of ${r.want}`);await overflow('belt '+k)}
  await p.tap('.learnseg [data-v="learn-belt"]');await p.locator('.beltpath [data-v="purple"]').tap();await p.locator('[data-a="setgoal"]').tap();
  ok(await ev(()=>goal()==='purple'&&rateable().length>54&&curBlocks()!==BLOCKS&&curBlocks().every(b=>b.ids.every(id=>TM[id]))),'purple goal changes blocks and rating scope');
  await p.locator('.bstage details.grp summary').first().tap();await p.locator('.bstage [data-a="comp"]').first().tap();ok(await ev(()=>(P().comp.purple||[]).length===1),'coach checklist ticks');
  ok(await ev(()=>/Purple-belt skill readiness/.test(document.body.innerText)&&!!document.querySelector('.belt .b.blue')),'Belt shows purple goal on a blue belt');await overflow('belt purple');
  await p.tap('nav.tabs [data-v="home"]');ok(await ev(()=>/ready for Purple belt/.test(document.querySelector('.lprog').innerText)),'Home shows a short progress line for the goal');await overflow('home purple');
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-map"]');await p.locator('.flowsvg g.node[data-v="seated"]').tap();
  const upTo=await ev(()=>document.querySelectorAll('.list .trow').length);await p.locator('[data-a="flowbelt"][data-v="black"]').tap();const all=await ev(()=>document.querySelectorAll('.list .trow').length);
  await p.locator('[data-a="flowbelt"][data-v="blue"]').tap();const blueOnly=await ev(()=>document.querySelectorAll('.list .trow').length);ok(all>=upTo&&upTo>=blueOnly&&all>blueOnly,`flow belt filter (${blueOnly} ≤ ${upTo} ≤ ${all})`);
  await p.tap('nav.tabs [data-v="me"]');await p.evaluate(()=>document.querySelectorAll('details.more:not([open]) summary').forEach(x=>x.click()));await p.selectOption('#s-goal','blue');ok(await ev(()=>goal()==='blue'),'goal back to blue from settings');
  // --- video (account mode)
  if(MODE==='db'){await ev(()=>techSheet('knee_cut'));
    await p.setInputFiles('#vid-knee_cut',{name:'big.mp4',mimeType:'video/mp4',buffer:Buffer.alloc(21*1024*1024,1)});await p.waitForTimeout(200);
    ok(await ev(()=>/limit is 20 MB/.test(document.getElementById('toast').textContent)&&!P().videos.knee_cut),'oversized video rejected with message');
    await p.setInputFiles('#vid-knee_cut',{name:'clip.mov',mimeType:'video/quicktime',buffer:Buffer.alloc(4096,1)});await p.waitForTimeout(1500);
    ok(await ev(()=>!!P().videos.knee_cut&&!!document.querySelector('#sheet video#vidplayer')&&/Play video/.test(document.getElementById('sheetbar').innerText)),'video uploads and plays in the technique page');
    await p.tap('#sheetbar .back');await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');await p.locator('#learn-groups details.grp[data-g="open_top"] summary').tap();
    ok(await ev(()=>!!document.querySelector('.trow[data-v="knee_cut"] .thumb .play')),'technique row shows video marker');
    await ev(()=>techSheet('knee_cut'));await p.locator('[data-a="viddel"]').tap();await p.locator('[data-a="viddelyes"]').tap();ok(await ev(()=>!P().videos.knee_cut&&!document.querySelector('#sheet video')),'video removed');await p.tap('#sheetbar .back');
  }
  // --- chains: every attacking position has a tree; mirrors show defenses
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-map"]');
  for(const k of await ev(()=>Object.keys(CHAINS))){await p.locator(`.flowsvg g.node[data-v="${k}"]`).tap();
    const r=await ev(k=>({att:document.querySelectorAll('ul.tree.root')[0]?.querySelectorAll('.tnode').length||0,first:document.querySelector('.tree .tnode')?.dataset.v}),k);ok(r.att>0,`attack chain renders for ${k}`)}
  for(const [k,o] of await ev(()=>Object.entries(OPP).filter(([k,o])=>CHAINS[o]))){await p.locator(`.flowsvg g.node[data-v="${k}"]`).tap();
    const r=await ev(()=>({defs:document.querySelectorAll('.tdef').length,they:/They go for/.test(document.body.innerText)}));ok(r.defs>0&&r.they,`defense view for ${k} shows defenses (${r.defs})`)}
  await p.locator('.flowsvg g.node[data-v="cg_top"]').tap();
  ok(await ev(()=>/If you sit up tall to escape/.test(document.body.innerText)&&/Your defense:\s*Triangle defense/.test(document.body.innerText)),'defense view flips pronouns and links the triangle defense');
  await p.locator('.tnode[data-v="triangle"]').first().tap();ok((await sheetH1())==='Triangle choke','chain node opens technique');await p.tap('#sheetbar .back');
  await overflow('flow chains');
  // --- defense filter and tapped-by -> defense
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');await p.locator('[data-a="filter"][data-k="kind"][data-v="def"]').tap();
  ok(await ev(()=>{const r=[...document.querySelectorAll('#learn-groups .trow')].map(b=>TM[b.dataset.v]);return r.length>15&&r.every(t=>isDef(t))}),'defense filter shows only escapes and defenses');
  await p.locator('[data-a="filter"][data-k="kind"][data-v="all"]').tap();
  await p.tap('nav.tabs [data-v="journal"]');await p.tap('[data-a="lognew"]');await p.selectOption('#f-tapped','rnc');await p.tap('#sheetbar button[type=submit]');await p.waitForTimeout(150);
  ok(await ev(()=>!!document.querySelector('[data-a="open"][data-v="rnc_def"]')),'log links rear-naked choke to its defense');
  await p.tap('nav.tabs [data-v="home"]');ok(await ev(()=>/tapped most by/i.test(document.body.innerText)&&!!document.querySelector('.trow[data-v="rnc_def"]')),'Today suggests the defense for what tapped you');
  // --- name, Belts tab, belt path
  ok(await ev(()=>/JitsFlow$/.test(document.title)&&/JitsFlow/i.test(document.querySelector('.brand').textContent)),'app renamed to JitsFlow');
  ok(await ev(()=>document.querySelector('nav.tabs [data-v="learn"]').textContent.trim()==='Learn'),'tab is called Learn');
  for(const k of ['purple','brown','black','blue']){await p.tap('nav.tabs [data-v="home"]');await p.tap('.lprog [data-v="learn-belt"]');await p.locator(`.beltpath [data-v="${k}"]`).tap();
    ok(await ev(k=>location.hash==='#learn-belt'&&document.querySelector(`.beltpath [data-v="${k}"]`).getAttribute('aria-pressed')==='true',k),`belt path opens ${k} curriculum`)}
  // --- glossary terms
  await ev(()=>techSheet('hg_frames'));const terms=await ev(()=>[...document.querySelectorAll('#sheet .term')].map(b=>b.dataset.v));
  ok(terms.includes('Underhook')&&terms.length>=4,`technique page has tappable terms (${terms.join(', ')})`);
  await p.locator('#sheet .term[data-v="Underhook"]').first().tap();
  ok(await ev(()=>{const c=document.getElementById('termcard');return !c.hidden&&/Underhook/.test(c.innerText)&&/armpit/.test(c.innerText)}),'tapping a term shows its definition');
  await p.locator('#sheet h1').tap();ok(await ev(()=>document.getElementById('termcard').hidden),'tapping elsewhere closes the definition');
  ok(await ev(()=>GLOSS.every(g=>g.d.length>30)),'every glossary term has a definition');
  if(MODE==='local'){ok(await ev(()=>!document.getElementById('explain-box')),'no Claude section when Claude is unavailable')}
  if(MODE==='db'){
    ok(await ev(()=>!!document.querySelector('#explain-box [data-a="explain"]')),'Go deeper section shows');
    await p.locator('#explain-box [data-a="explain"]').tap();await p.waitForTimeout(300);
    ok(await ev(()=>/In more detail/.test(document.getElementById('explain-box').innerText)&&!!document.querySelector('#explain-box .ai h4')&&/Half guard bottom: knee shield/.test(window.__lastPrompt)),'explain in more detail answers with the move in the prompt');
    await p.locator('#ai-q').fill('What if they are much bigger?');await p.locator('#explain-box [data-a="ask"]').tap();await p.waitForTimeout(300);
    ok(await ev(()=>/You asked: What if they are much bigger\?/.test(document.getElementById('explain-box').innerText)&&/much bigger/.test(window.__lastPrompt)),'asking a question shows the answer');
    ok(await ev(()=>!!document.querySelector('#explain-box .ai .term')),'answers have tappable terms too');
    await p.locator('#sheet .term[data-v="Underhook"]').first().tap();await p.locator('#termcard [data-a="termmore"]').tap();await p.waitForTimeout(200);
    ok(await ev(()=>/Why it works/.test(document.getElementById('termcard').innerText)),'term card can explain in more detail');
    await p.locator('#termcard [data-a="termclose"]').tap();await p.waitForTimeout(700);
    await p.tap('#sheetbar .back');await p.reload();await p.waitForTimeout(600);await ev(()=>techSheet('hg_frames'));await p.waitForTimeout(300);
    ok(await ev(()=>document.querySelectorAll('#explain-box .aiitem').length===2),'saved answers come back after reload');
    await p.locator('#explain-box [data-a="airm"]').first().tap();ok(await ev(()=>document.querySelectorAll('#explain-box .aiitem').length===1),'remove an answer');
    await p.tap('#sheetbar .back');
  }else{await p.tap('#sheetbar .back')}
  // --- weekly plan, training days, coach review, video embed
  await p.tap('nav.tabs [data-v="home"]');
  ok(await ev(()=>document.querySelectorAll('.week .wd').length===7&&document.querySelectorAll('.week .wd.cls').length===(P().settings.days||[]).length&&!!document.querySelector('.week .wd.today')),'this week shows 7 days with class days and today');
  await p.locator('.week .wd.cls').first().tap();ok(await ev(()=>S.ui.sheet&&S.ui.sheet.k==='tech'),'class day opens its technique');await p.tap('#sheetbar .back');
  await p.tap('nav.tabs [data-v="me"]');await p.evaluate(()=>document.querySelectorAll('details.more:not([open]) summary').forEach(x=>x.click()));const before=await ev(()=>P().settings.days.length);await p.locator('[data-a="day"][data-v="5"]').tap();
  ok(await ev(n=>P().settings.days.length===n+1&&P().settings.perWeek===n+1,before),'adding a training day updates the plan');await p.locator('[data-a="day"][data-v="5"]').tap();
  await ev(()=>techSheet('buggy_choke'));ok(await ev(()=>/Check with your coach/.test(document.querySelector('.coachbox').innerText)),'flagged move asks for a coach check');
  await p.locator('[data-a="coachok"]').tap();ok(await ev(()=>coachOK('buggy_choke')&&/Coach checked/.test(document.querySelector('.coachbox').innerText)),'coach check can be ticked');await p.tap('#sheetbar .back');
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-belt"]');await p.locator('.beltpath [data-v="black"]').tap();
  ok(await ev(()=>/Coach review list/.test(document.body.innerText)&&/1 of \d+ checked/.test(document.body.innerText)),'belt shows coach review progress');await p.locator('.beltpath [data-v="blue"]').tap();
  await ev(()=>{window.__savedVid=VIDS.knee_cut;VIDS.knee_cut={v:'dQw4w9WgXcQ',title:'Knee cut pass',channel:'Test Channel',nogi:true};techSheet('knee_cut')});
  if(MODE==='local'){
    ok(await ev(()=>{const f=document.querySelector('#sheet .ytembed iframe');return f&&/youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/.test(f.src)&&f.getAttribute('loading')==='lazy'&&/autoplay/.test(f.getAttribute('allow'))&&/Test Channel/.test(document.querySelector('#sheet .ytcap').innerText)&&!document.querySelector('#sheet .ytface')}),'technique page shows YouTube\'s own player (lazy-loaded), so one tap plays it');
    ok(await ev(()=>/More Knee cut pass videos on YouTube/.test(document.querySelector('#sheet a.yt:not(.ytpick)').innerText)),'search button stays as "More videos"');
    await p.tap('#sheetbar .back');await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');await p.locator('#learn-groups details.grp[data-g="open_top"] summary').tap();
    ok(await ev(()=>/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/mqdefault/.test((document.querySelector('.trow[data-v="knee_cut"] .thumb img')||{}).src||'')),'technique list uses the video thumbnail');
  }else{
    ok(await ev(()=>!document.querySelector('#sheet .ytembed,#sheet .ytface')&&/youtube\.com\/watch\?v=dQw4w9WgXcQ/.test((document.querySelector('#sheet a.ytpick')||{}).href||'')),'claude.ai links to the picked video instead of embedding');
    await p.tap('#sheetbar .back');
  }
  await ev(()=>{if(window.__savedVid)VIDS.knee_cut=window.__savedVid;else delete VIDS.knee_cut});
  // --- screens and sheets for screen readers: <main>, a title per tab, a Home heading; a sheet is a named dialog that takes focus and gives it back
  await p.tap('nav.tabs [data-v="learn"]');ok(await ev(()=>document.querySelector('main#app')&&document.title==='Learn · JitsFlow'),'the screen is a <main> and the title says which tab: '+await ev(()=>document.title));
  await p.tap('nav.tabs [data-v="home"]');ok(await ev(()=>document.title==='Home · JitsFlow'&&!!document.querySelector('#app h1.vh')&&document.querySelector('#app h1.vh').getBoundingClientRect().width<=1),'Home has a heading for screen readers, not shown on screen');
  await p.tap('nav.tabs [data-v="learn"]');await p.tap('.learnseg [data-v="learn-moves"]');await p.locator('#learn-groups details.grp:not([open]) summary').first().tap();
  {const tid=await ev(()=>document.querySelector('#learn-groups .trow[data-a="open"]').dataset.v);await p.locator(`#learn-groups .trow[data-a="open"][data-v="${tid}"]`).first().focus();await p.keyboard.press('Enter');await p.waitForTimeout(150);
   ok(await ev(()=>{const sh=document.getElementById('sheet'),t=document.getElementById(sh.getAttribute('aria-labelledby'));return sh.getAttribute('role')==='dialog'&&sh.getAttribute('aria-modal')==='true'&&t&&t.tagName==='H1'&&document.activeElement===t}),'a sheet is a dialog named by its title, and focus moves to the title');
   await ev(id=>techSheet(id,true),tid);ok(await ev(()=>document.activeElement===document.getElementById('sheet-t')&&document.activeElement.tagName==='H1'),"a sheet that draws itself again (like a student's once their details load) keeps focus on its title");
   await p.keyboard.press('Escape');await p.waitForTimeout(150);
   ok(await ev(id=>document.activeElement&&document.activeElement.dataset.v===id&&!document.getElementById('sheet').getAttribute('role'),tid),'closing the sheet puts focus back on the row that opened it')}
  ok(await ev(()=>{const g=document.querySelector('.learnseg');return g.getAttribute('role')==='group'&&g.getAttribute('aria-label')==='Learn'&&[...g.querySelectorAll('button')].every(b=>b.hasAttribute('aria-pressed'))}),'switches are a labelled group of pressed buttons');
  // --- toasts: a polite live region that's always there; Undo stays 10s and waits while it's touched
  ok(await ev(()=>{const t=document.getElementById('toast');return t.getAttribute('role')==='status'&&t.getAttribute('aria-live')==='polite'&&!t.hidden}),'the toast is a polite live region that is always present');
  await ev(()=>toast('Saved.',{label:'Undo',fn:()=>{window.__undone=1}}));ok(await ev(()=>toast._ms===10000&&/Saved\./.test(document.getElementById('toast').textContent)),'a toast with Undo stays up for 10s');
  await ev(()=>{const t=document.getElementById('toast');t.dispatchEvent(new PointerEvent('pointerenter'));toast._ms=50;});await p.waitForTimeout(120);
  ok(await ev(()=>document.getElementById('toast').classList.contains('on')),'and stays while a finger or the keyboard is on it');
  await ev(()=>document.getElementById('toast').dispatchEvent(new PointerEvent('pointerleave')));await p.waitForTimeout(120);ok(await ev(()=>!document.getElementById('toast').classList.contains('on')&&document.getElementById('toast').textContent===''),'then goes');
  await ev(()=>{toast('Cancelled.');toast('Cancelled.')});ok(await ev(()=>document.getElementById('toast').textContent===''),'the same message twice is cleared first, so it is read again');await p.waitForTimeout(120);ok(await ev(()=>document.getElementById('toast').textContent==='Cancelled.'),'and then shown');
  // --- settings checkboxes keep their size; Prev says what it shows
  await p.tap('nav.tabs [data-v="me"]');await p.evaluate(()=>document.querySelectorAll('details.more:not([open]) summary').forEach(x=>x.click()));
  ok(await ev(()=>{const r=document.getElementById('set-quiz').getBoundingClientRect();return r.width>=20&&r.height>=20}),'the Quiz mode checkbox is a full-size box, not a sliver');
  ok(await ev(()=>/aria-label="Prev">‹ Prev/.test(prevNext('qr',{i:1}))),'the quiz Prev button is called Prev, as shown');
  // --- pasted kid and parent lines
  ok(await ev(()=>{const r=parseList(["Ayanda Dlamini (mom Thandi Dlamini) 072 500 1000","Lwazi, parent: Nomsa Khumalo, 082 111 2222","Kea Mokoena – Zanele Mokoena 083 222 3333","Thandi Dube - Sipho's dad 084 555 6666","Thabo Mokoena - 082 123 4567"].join("\n"));
    return JSON.stringify(r.map(x=>[x.name,x.parentName||""]))===JSON.stringify([["Ayanda Dlamini","Thandi Dlamini"],["Lwazi","Nomsa Khumalo"],["Kea Mokoena","Zanele Mokoena"],["Sipho","Thandi Dube"],["Thabo Mokoena",""]])&&r[0].phone==="072 500 1000"}),'pasted lines like "Kid (mom X)", "parent: X", "Kid – Parent" and "X - Kid\'s dad" become kids with their parent');
  ok(await ev(()=>hiName({name:"Ayanda Dlamini",parentName:"Thandi Dlamini"})==="Thandi"),'the parent is greeted by their own first name');
  ok(errs.length===0,'page errors: '+errs.join(' | '));
  console.log(`${MODE} on ${DEV}: ${pass} passed, ${fail} failed`);fails.forEach(f=>console.log('  FAIL',f));
  await b.close();fs.unlinkSync(PAGE);process.exit(fail?1:0);
})().catch(e=>{console.error('CRASH',e.message);process.exit(2)});
