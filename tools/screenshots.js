// Takes the landing-page screenshots from the built app with example data. Usage: node tools/screenshots.js
const {chromium,devices}=require('playwright');const fs=require('fs');const path=require('path');
const ROOT=path.resolve(__dirname,'..');const PAGE=path.join(ROOT,'tests','shot.html');
fs.writeFileSync(PAGE,'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'+fs.readFileSync(path.join(ROOT,'dist','jitsflow-claude.html'),'utf8'));
(async()=>{const b=await chromium.launch();const ctx=await b.newContext({...devices['iPhone 13'],deviceScaleFactor:2,colorScheme:'light'});const p=await ctx.newPage();
  await p.goto('file://'+PAGE+'#today');await p.waitForTimeout(300);
  await p.evaluate(()=>{const st=P().settings;st.onboarded=true;st.goal='blue';st.perWeek=2;st.days=[1,3];st.priorHours=117;
    TECH.forEach((t,i)=>{if((t.b||'blue')==='blue'&&i%7!==3){P().mastery[t.id]=[1,2,2,3,1,4,2][i%7];ensureCard(t.id)}});
    const d=n=>addDays(today(),-n);S.sessions=[{id:'a',date:d(2),type:'Class',mins:90,rolls:5,taught:['knee_cut'],hits:['triangle'],tapped:['rnc'],stuck:['hg_bot'],worked:'',fix:''},{id:'b',date:d(6),type:'Class',mins:90,rolls:6,taught:[],hits:[],tapped:['guillotine'],stuck:['hg_bot','sc_bot'],worked:'',fix:''},{id:'c',date:d(9),type:'Open mat',mins:60,rolls:7,taught:[],hits:[],tapped:[],stuck:[],worked:'',fix:''}];
    hideSheet();render();document.getElementById('toast').hidden=true});
  const shot=async(name,fn)=>{await fn();await p.waitForTimeout(250);await p.evaluate(()=>{document.getElementById('toast').hidden=true;document.querySelectorAll('.fab').forEach(f=>f.remove())});await p.screenshot({path:path.join(ROOT,'web','img',name+'.png')})};
  await shot('today',async()=>{await p.evaluate(()=>{go('today')})});
  await shot('chains',async()=>{await p.evaluate(()=>{S.ui.flowSel='cg_bot';go('flow')});await p.evaluate(()=>{const h=[...document.querySelectorAll('h2.label')].find(x=>/Your attack chains/.test(x.textContent));window.scrollTo(0,h.getBoundingClientRect().top+window.scrollY-12)})});
  await shot('defense',async()=>{await p.evaluate(()=>{S.ui.flowSel='mount_bot';go('flow')});await p.evaluate(()=>{const h=[...document.querySelectorAll('h2.label')].find(x=>/Their attacks/.test(x.textContent));window.scrollTo(0,h.getBoundingClientRect().top+window.scrollY-12)})});
  await shot('belts',async()=>{await p.evaluate(()=>{S.ui.belt='purple';go('learn')})});
  await b.close();fs.unlinkSync(PAGE);console.log('screenshots written');})();
