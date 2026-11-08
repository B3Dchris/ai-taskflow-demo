/* ============ ACCOUNTS, SYNC, CLASSES AND THE COACH DASHBOARD (website only) ============ */
const API={on:false,me:null,classes:null,classesAt:0,status:{}};
const COACH={view:"classes",roster:null,classes:null,payments:null,loading:false,q:""};
async function api(method,url,body){
  const h=method==="GET"?{}:{"content-type":"application/json","x-jf":"1"};
  const r=await fetch("/api"+url,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),credentials:"same-origin"});
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok){const err=new Error(j.error||"Something went wrong. Try again.");err.status=r.status;throw err}
  return j;
}
const isCoach=()=>!!(API.me&&API.me.role==="coach"&&API.me.gym);
const money=(c,cur)=>{try{return new Intl.NumberFormat("en-ZA",{style:"currency",currency:cur||"ZAR",maximumFractionDigits:c%100?2:0}).format((c||0)/100)}catch(e){return "R "+((c||0)/100).toFixed(2)}};
const fmtWhen=iso=>{try{const d=new Date(iso);return d.toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short"})+" · "+d.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}catch(e){return iso}};
const joinURL=c=>location.origin+"/app/?join="+encodeURIComponent(c);
function readinessFor(m,belt){let s=0,w=0;TECH.forEach(t=>{if(t.p==="plus"||beltOf(t)!==belt)return;const k=t.p==="core"?2:1;w+=k;s+=k*Math.min(4,Number((m||{})[t.id])||0)/4});return w?Math.round(100*s/w):0}
function areasFor(m,belt){return AREAS.map(a=>{const ts=TECH.filter(t=>t.p!=="plus"&&beltOf(t)===belt&&a.f(t));return {n:a.n,f:a.f,pct:ts.length?Math.round(100*ts.reduce((x,t)=>x+Math.min(4,Number((m||{})[t.id])||0),0)/(ts.length*4)):0,count:ts.length}}).filter(a=>a.count)}
const goalOf=p=>RANK[p.goal]?p.goal:({white:"blue",blue:"purple",purple:"brown",brown:"black",black:"black"})[p.belt]||"blue";
const beltChip=(b,st)=>`<span class="beltchip" style="--bc:${BCOL[b]||"#F4F4F0"}"><i></i>${esc((b||"white")[0].toUpperCase()+(b||"white").slice(1))}${st?` · ${st} stripe${st>1?"s":""}`:""}</span>`;

/* ----- sign-in state and sync ----- */
async function acctInit(){
  if(inClaude()||!/^https?:$/.test(location.protocol))return;
  try{const j=await api("GET","/me");API.on=true;API.me=j.me;api("GET","/status").then(x=>{API.status=x}).catch(()=>{});
    if(API.me)await startSync();else if(lsGet("rtb.owner")){wipeLocal();S.mode="local"}} // signed out elsewhere or session expired: don't leave their data on the phone
  catch(e){API.on=false}
  const qs=new URLSearchParams(location.search),want=qs.has("signin")?"login":qs.has("start")?"gym":null;
  if(want){try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}
    if(API.on&&!API.me){S.ui.authMode=want;setTimeout(authSheet,50)}else if(!API.on)setTimeout(()=>toast("Sign-in isn't switched on for this site yet."),400)}
  const rt=qs.get("reset");
  if(rt){try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}
    if(API.on){S.ui.authMode="reset";S.ui.resetTok=rt;setTimeout(authSheet,50)}}
  const cl=qs.get("claim");if(cl)S.ui.claim=cl;
  const q=qs.get("join");
  if(q){try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}
    if(API.on&&!API.me){S.ui.authMode="register";S.ui.authCode=q.toUpperCase();setTimeout(authSheet,50)}
    else if(API.me&&!API.me.gym){S.ui.joinCode=q.toUpperCase()}}
  render();
}
let apTimer=null,apDirty=false;
/* Whose data is on this phone? "rtb.owner" holds the account id once someone signs in here.
   - Data that belongs to a different account is cleared before this account's data loads.
   - Data from before anyone signed in is only carried into an account that's being created now (adopt).
   - Signing out clears the phone; the data stays in the account. */
function wipeLocal(){S.progress=blankProgress();S.sessions=[];try{["rtb.progress","rtb.sessions","rtb.owner"].forEach(k=>localStorage.removeItem(k))}catch(e){}}
async function startSync(opts){
  opts=opts||{};S.mode="api";setSync("Saved to your account","db");
  const owner=lsGet("rtb.owner"),mine=String(API.me.id);
  const foreign=!!owner&&String(owner)!==mine,adopt=!owner&&!!opts.adopt;
  if(foreign||(!owner&&!adopt))wipeLocal();
  try{
    const [p,l]=await Promise.all([api("GET","/progress"),api("GET","/logs")]);
    if(p.data){S.progress=normalize(p.data)}else{if(!adopt)S.progress=blankProgress();await api("PUT","/progress",{data:clone(S.progress)})}
    lsSet("rtb.progress",S.progress);
    const have=new Set(l.logs.map(x=>x.id));const extra=adopt?S.sessions.filter(x=>x&&x.id&&!have.has(x.id)):[];
    for(const s of extra.slice(0,200)){try{await api("PUT","/logs/"+encodeURIComponent(s.id),{data:s})}catch(e){}}
    S.sessions=[...l.logs,...extra];lsSet("rtb.sessions",S.sessions);lsSet("rtb.owner",mine);
    setTimeout(()=>autoLog(true),300);
  }catch(e){setSync("Saved on this device","err");toast("Couldn't reach your account. Changes are kept on this device for now.");if(!foreign)lsSet("rtb.owner",mine)}
}
function apiSaveProgress(){clearTimeout(apTimer);apTimer=setTimeout(async()=>{apTimer=null;try{await api("PUT","/progress",{data:clone(S.progress)});apDirty=false;if(S.syncState==="err")setSync("Saved to your account","db")}catch(e){apDirty=true;setSync("Offline: saved on this device","err")}},700)}
addEventListener("online",()=>{if(S.mode==="api"&&apDirty)apiSaveProgress()});
async function signedIn(me,opts){API.me=me;API.classes=null;API.comps=null;API.mem=undefined;GYM.data=null;await startSync(opts);hideSheet();if(isCoach())setCoachMode("manage");else maybeOnboardAfterSync();isCoach()?coachGo("today"):go("today");toast(`Signed in as ${me.name}.`)}
function maybeOnboardAfterSync(){S.ui.obChecked=false;if(!P().settings.onboarded)maybeOnboard()}
async function signOut(){try{await api("POST","/auth/logout",{})}catch(e){}API.me=null;API.classes=null;API.comps=null;API.mem=undefined;GYM.data=null;COACH.roster=COACH.classes=COACH.payments=COACH.insights=null;wipeLocal();S.mode="local";setSync("Saved on this device","local");go("today");toast("Signed out. Your progress is saved in your account, not on this phone.")}

/* ----- account sheets ----- */
function authSheet(){
  const m=S.ui.authMode||"login",c=S.ui.authCode||"";S.ui.sheet={k:"auth"};S.ui.stack=[];
  if(m==="forgot"||m==="reset")return resetSheet(m);
  const tabs=[["login","Sign in"],["register","Create account"],["gym","Start a gym"]];
  openSheet(`${sheetHead("Your account")}<div class="stack-lg"><h1>${m==="gym"?"Start your gym":m==="register"?"Create your account":"Sign in"}</h1>
   <div class="seg3">${tabs.map(([k,l])=>`<button type="button" data-a="authmode" data-v="${k}" aria-pressed="${m===k}">${l}</button>`).join("")}</div>
   <p class="muted">${m==="gym"?"For coaches. You'll get an invite link to send your students.":m==="register"?"Save your progress online and use it on any device. Got a code from your coach? Add it to join your gym.":"Pick up where you left off on any device."}</p>
   <form id="authform" class="stack" novalidate>
    ${m==="gym"?`<label class="f">Gym name<input id="a-gym" name="gym" autocomplete="organization" required></label><label class="f">Your gym's website (optional)<input id="a-site" name="site" type="text" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="url" placeholder="yourgym.co.za"><span class="small muted">We'll read your timetable, prices, coaches and logo while you look around.</span></label>`:""}
    ${m!=="login"?`<label class="f">Your name<input id="a-name" name="name" autocomplete="name" required></label>`:""}
    <label class="f">Email<input id="a-email" name="email" type="email" autocomplete="email" required></label>
    <label class="f">Password<input id="a-pass" name="password" type="password" autocomplete="${m==="login"?"current-password":"new-password"}" minlength="8" required></label>
    ${m==="register"?`<label class="f">Gym code (optional)<input id="a-code" name="code" value="${esc(c)}" autocapitalize="characters" placeholder="From your coach"></label>`:""}
    ${m==="login"?`<p class="small"><button type="button" class="linkbtn" data-a="authmode" data-v="forgot">Forgot your password?</button></p>`:""}
    ${m!=="login"?`<p class="small muted">Your name, email, training log and payments (if your gym uses them) are stored on JitsFlow's server so you and your coach can see them. You can delete your account and data any time in Settings.</p>`:""}
   </form></div>`,false,{act:`<button class="btn primary grow" type="submit" form="authform">${m==="gym"?"Start gym":m==="register"?"Create account":"Sign in"}</button>`});
}
function resetSheet(m){
  const sent=S.ui.resetSent;
  openSheet(`${sheetHead("Your account")}<div class="stack-lg"><h1>${m==="reset"?"Choose a new password":"Reset your password"}</h1>
   ${m==="reset"?`<p class="muted">Pick a new password. You'll be signed out on your other devices.</p>`
     :sent?`<div class="panel accent"><p><b>Check your email.</b> If ${esc(sent)} has a JitsFlow account, a reset link is on its way. It works for 1 hour. Check spam if it isn't there in a few minutes.</p></div>`
     :`<p class="muted">Enter the email you signed up with and we'll send you a link to choose a new password.</p>`}
   <form id="authform" class="stack" novalidate>
    ${m==="reset"?`<label class="f">New password<input id="a-pass" name="password" type="password" autocomplete="new-password" minlength="8" required></label>`
      :`<label class="f">Email<input id="a-email" name="email" type="email" autocomplete="email" required value="${esc(sent||"")}"></label>`}
   </form>
   <p class="small"><button type="button" class="linkbtn" data-a="authmode" data-v="login">Back to sign in</button></p></div>`,false,{act:`<button class="btn primary grow" type="submit" form="authform">${m==="reset"?"Save new password":sent?"Send again":"Send reset link"}</button>`});
}
async function submitAuth(form){
  const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"",m=S.ui.authMode||"login";
  if(m==="forgot"||m==="reset"){const btn=document.querySelector('#sheetbar [type=submit]');if(btn)btn.disabled=true;
    try{if(m==="forgot"){await api("POST","/auth/forgot",{email:v("email")});S.ui.resetSent=v("email").trim();resetSheet("forgot")}
      else{const j=await api("POST","/auth/reset",{token:S.ui.resetTok,password:v("password")});S.ui.resetTok=null;S.ui.authMode="login";await signedIn(j.me);toast("Password changed. You're signed in.")}}
    catch(e){toast(e.message);if(btn)btn.disabled=false}
    return}
  const btn=document.querySelector('#sheetbar [type=submit]');if(btn){btn.disabled=true;btn.textContent="One moment…"}
  try{
    const tz=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){return ""}})();
    const j=m==="gym"?await api("POST","/auth/start-gym",{gym:v("gym"),name:v("name"),email:v("email"),password:v("password"),timezone:tz})
      :m==="register"?await api("POST","/auth/register",{name:v("name"),email:v("email"),password:v("password"),code:v("code"),claim:S.ui.claim||undefined})
      :await api("POST","/auth/login",{email:v("email"),password:v("password")});
    jfTrack(m==="login"?"login":"sign_up",{method:"email",role:m==="gym"?"coach":j.me.role,with_gym:!!j.me.gym});
    await signedIn(j.me,{adopt:m!=="login"});
    if(m==="gym"){const site=v("site");if(site)await impStart(site);setTimeout(welcomeSheet,250)}
  }catch(e){toast(e.message);if(btn){btn.disabled=false;btn.textContent=m==="gym"?"Start gym":m==="register"?"Create account":"Sign in"}}
}
function accountSection(){
  if(inClaude()||!API.on)return "";
  if(!API.me)return `<section class="panel accent"><h2 class="label">Your account</h2><p>Save your progress online so it's safe and on every device. Coaches can start a gym and invite students.</p>
    <div class="row"><button class="btn primary" data-a="auth" data-v="register">Create account</button><button class="btn" data-a="auth" data-v="login">Sign in</button><button class="btn" data-a="auth" data-v="gym">Start a gym</button></div></section>`;
  const g=API.me.gym;
  return `<section class="panel"><h2 class="label">Your account</h2><div><b>${esc(API.me.name)}</b><br><span class="small muted">${esc(API.me.email)}</span></div>
    <form id="phoneform" class="row" style="flex-wrap:nowrap"><input id="a-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="WhatsApp number (optional)" value="${esc(API.me.phone||"")}" aria-label="WhatsApp number" style="flex:1"><button class="btn" type="submit">Save</button></form>
    <p class="small muted" style="margin-top:-6px">${API.me.role==="coach"?"Shown to nobody; used for your own WhatsApp links.":"Lets your coach message you on WhatsApp. Only coaches see it."}</p>
    ${g?`<p class="small">${API.me.role==="coach"?"Coach at":"Training at"} <b>${esc(g.name)}</b></p>`:`<form id="joinform" class="row" style="flex-wrap:nowrap"><input id="j-code" name="code" placeholder="Gym code from your coach" value="${esc(S.ui.joinCode||"")}" autocapitalize="characters" style="flex:1"><button class="btn" type="submit">Join gym</button></form>`}
    <div class="row"><button class="btn" data-a="signout">Sign out</button>${S.ui.delOpen?"":`<button class="btn danger" data-a="delacct">Delete account</button>`}</div>
    ${S.ui.delOpen?`<form id="delform" class="stack"><p class="small">This permanently deletes your account, progress, training log and attendance from the server. Type your password to confirm.</p><input id="d-pass" name="password" type="password" autocomplete="current-password" placeholder="Password"><div class="row"><button class="btn danger" type="submit">Delete everything</button><button class="btn" type="button" data-a="delcancel">Keep my account</button></div></form>`:""}</section>`;
}

/* ----- next class (students and coaches) ----- */
async function loadClasses(force){if(!API.me||!API.me.gym)return;if(!force&&API.classes&&Date.now()-API.classesAt<60000)return;
  try{const j=await api("GET","/classes");API.classes=j.classes;API.classesAt=Date.now();if((S.ui.tab==="today"||S.ui.tab==="book")&&(!S.ui.sheet||S.ui.sheet.k==="book"))S.ui.sheet&&S.ui.sheet.k==="book"?bookSheet(S.ui.sheet.id):render()}catch(e){}}
function nextClassCard(){
  if(inClaude()||!API.me||!API.me.gym)return "";
  if(!API.classes){loadClasses();return ""}
  const up=API.classes.filter(c=>clsEnd(c)>Date.now()&&(c.kind!=="private"||c.myGoing||isCoach()));
  if(!up.length){if(!GYM.data)loadGym();const tu=ttUpcoming(3);
    return `<section class="panel"><h2 class="label">Next class</h2>${tu.length?`<div class="stack">${tu.map(x=>`<div class="ttline"><span class="mono">${x.k===0?"Today":x.k===1?"Tomorrow":TTD[(x.at.getDay()+6)%7]} ${esc(x.r.start)}</span><span>${esc(x.r.title)}${x.r.coach?` <span class="small muted">· ${esc(x.r.coach)}</span>`:""}</span></div>`).join("")}</div><p class="small muted">From ${esc(API.me.gym.name)}'s timetable.${isCoach()?" Add these to Classes from the Coach tab › Gym so students can book.":""}</p>`:`<p class="muted">No classes scheduled yet${isCoach()?". Plan one in the Coach tab.":"."}</p>`}</section>`}
  const c=up.find(x=>x.myGoing||x.myWaitlisted)||up.find(x=>x.kind!=="private")||up[0],p=c.plan||{};
  return `<section class="panel nextclass"><div class="row between"><h2 class="label">${c.myGoing?"Your next class":"Next class"}</h2><span class="small muted mono">${esc(spotsTxt(c))}</span></div>
    <div class="stack" style="gap:6px"><div><h3>${esc(c.title)}</h3><p class="small muted">${esc(fmtWhen(c.startsAt))} · ${c.durationMin} min${c.coach?" · with "+esc(c.coach):""}</p></div>${whoLine(c,4)}</div>
    ${p.focus||p.ids&&p.ids.length?`<p class="small"><b>Coach's plan${p.focus?": "+esc(p.focus):""}</b>${(p.ids||[]).filter(id=>TM[id]).length?` · <button class="linkbtn small" data-a="bookopen" data-v="${c.id}">${p.ids.filter(id=>TM[id]).length} technique${p.ids.filter(id=>TM[id]).length===1?"":"s"} to study</button>`:""}</p>`:""}
    ${isCoach()?"":`<div class="row">${bookActions(c)}</div>`}
    ${isCoach()?"":`<button class="linkbtn small" data-a="tab" data-v="book">All classes</button>`}</section>`;
}
function accountNudge(){if(inClaude()||!API.on||API.me)return "";
  return `<section class="panel"><h2 class="label">Keep your progress safe</h2><p class="small">Right now it's only on this phone. Create a free account to save it online and join your gym's classes.</p><div class="row"><button class="btn primary" data-a="auth" data-v="register">Create account</button><button class="btn" data-a="auth" data-v="login">Sign in</button></div></section>`}

/* ----- coach dashboard ----- */
async function coachLoad(what,around){
  COACH.loading=true;
  try{
    if(!what||what==="roster"){COACH.roster=await api("GET","/coach/roster");COACH.rosterAt=Date.now();COACH.insights=null}
    if(!what||what==="classes"){const base=fromYmd(around||(COACH.cal&&COACH.cal.anchor)||todayK()),f=new Date(base),t=new Date(base);f.setDate(f.getDate()-60);t.setDate(t.getDate()+100);
      COACH.classes=(await api("GET",`/classes?from=${encodeURIComponent(f.toISOString())}&to=${encodeURIComponent(t.toISOString())}`)).classes;COACH.rFrom=f;COACH.rTo=t;API.classes=null}
    if(!what||what==="payments")COACH.payments=(await api("GET","/coach/payments")).payments;
    if(!what||what==="payments"||what==="roster")COACH.money=null;
  }catch(e){toast(e.message)}
  COACH.loading=false;if(S.ui.tab==="coach")render();
}
/* Coaches get their own app: Today (the gym's day), Classes, Students, Comps, Money and Gym.
   Belts, Flow map and Log are study tools; a coach can switch to them from the Gym tab ("study mode"). */
const COACH_VIEWS=["today","classes","students","comps","money","gym"];
const coachMode=()=>{try{return localStorage.getItem("jf.coachMode")==="study"?"study":"manage"}catch(e){return "manage"}};
const managing=()=>isCoach()&&coachMode()!=="study";
function setCoachMode(m){try{if(m==="study")localStorage.setItem("jf.coachMode","study");else localStorage.removeItem("jf.coachMode")}catch(e){}}
function coachGo(v){const legacy={roster:["students","list"],insights:["students","insights"],payments:["money"]};const l=legacy[v];
  if(l){v=l[0];if(l[1])COACH.stuView=l[1]}if(!COACH_VIEWS.includes(v))v="today";COACH.view=v;go("coach-"+v)}
function viewCoach(){
  if(!isCoach())return `${header()}<div class="empty">This part is for coaches. Start a gym in Settings to use it.</div>`;
  if(!COACH.roster&&!COACH.loading)coachLoad();
  const v=COACH_VIEWS.includes(COACH.view)?COACH.view:"today";
  const title={today:"Today",classes:"Classes",students:"Students",comps:"Competitions",money:"Money",gym:"Your gym"}[v];
  const body=!COACH.roster?`<div class="empty">Loading your gym…</div>`:v==="classes"?coachClasses():v==="students"?coachStudents():v==="comps"?coachComps():v==="money"?coachMoney():v==="gym"?coachGym():coachToday();
  return `${header()}<div class="stack-lg"><section class="stack" style="gap:6px"><div class="gymhead"><div><p class="small muted" style="margin:0">${esc(API.me.gym.name)}</p><h1 style="font-size:34px;margin:0">${esc(title)}</h1></div></div></section>${body}</div>`;
}
function coachStudents(){const sv=COACH.stuView==="insights"?"insights":"list";
  return `<div class="seg2"><button data-a="stuview" data-v="list" aria-pressed="${sv==="list"}">Roster</button><button data-a="stuview" data-v="insights" aria-pressed="${sv==="insights"}">Insights</button></div>${sv==="insights"?coachInsights():coachRoster()}`}
/* ----- Money: This month (who owes what, reminders, history) · Payments (to check, record) · Setup (how students pay) ----- */
function coachMoney(){const v=COACH.moneyView||"month",pend=(COACH.payments||[]).filter(p=>p.status==="pending").length;
  return `<div class="seg3" role="tablist"><button data-a="moneyview" data-v="month" aria-pressed="${v==="month"}">This month</button><button data-a="moneyview" data-v="payments" aria-pressed="${v==="payments"}">Payments${pend?` (${pend})`:""}</button><button data-a="moneyview" data-v="setup" aria-pressed="${v==="setup"}">Setup</button></div>
    ${v==="payments"?coachPayments():v==="setup"?`${moneySetup()}${plansPanel()}`:moneyMonth()}`}
async function loadMoney(month){COACH.moneyLoading=true;try{COACH.money=await api("GET","/coach/money"+(month?`?month=${month}`:""))}catch(e){toast(e.message)}COACH.moneyLoading=false;if(S.ui.tab==="coach"&&COACH.view==="money")render()}
const monthLabel=m=>new Date(m+"-01T12:00:00").toLocaleDateString(undefined,{month:"long",year:"numeric"});
const monthShift=(m,n)=>{const d=new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7)-1+n,1));return d.toISOString().slice(0,7)};
function moneyStatus(s,M){const left=s.feeCents-s.paidCents;if(!s.feeCents)return ["nofee","No fee",""];if(left<=0)return ["paid","Paid","ok"];if(s.pendingCents)return ["checking","Checking","due"];
  const cur=M.today.slice(0,7),late=M.month<cur||(M.month===cur&&Number(M.today.slice(8,10))>M.dueDay+6);return late?["late","Overdue","bad"]:s.paidCents?["part","Part paid","due"]:["due","Due","due"]}
function remindText(s,M){const b=((COACH.payInfo||{}).pay)||{},left=s.feeCents-s.paidCents;
  return `Hi ${first(s.name)}, a friendly reminder that ${money(left,M.currency)} is due for ${monthLabel(M.month)} at ${gymName()}.${b.account?`\n\nEFT: ${b.bank?b.bank+" ":""}${b.account}${b.branch?`, branch ${b.branch}`:""}${b.holder?` (${b.holder})`:""}`:""}\nReference: ${s.reference}\n\nAlready paid? Send your proof of payment in JitsFlow: ${appLink("#book")}\nThanks!`}
function moneyMonth(){
  const want=COACH.moneyMonth||null,M=COACH.money;
  if(COACH.payInfo===undefined){COACH.payInfo=null;api("GET","/coach/gym/pay").then(j=>{COACH.payInfo=j;if(S.ui.tab==="coach")render()}).catch(()=>{})}
  if((!M||(want&&M.month!==want))&&!COACH.moneyLoading){loadMoney(want);return `<div class="empty">Loading…</div>`}
  if(!M)return `<div class="empty">Loading…</div>`;
  const cur=M.currency,st=M.students.map(s=>({...s,status:moneyStatus(s,M)})),billed=st.filter(s=>s.feeCents>0);
  const expected=billed.reduce((a,s)=>a+s.feeCents,0),owing=billed.filter(s=>["due","late","part"].includes(s.status[0])),outstanding=owing.reduce((a,s)=>a+s.feeCents-s.paidCents,0);
  const rate=expected?Math.min(100,Math.round(100*billed.reduce((a,s)=>a+Math.min(s.paidCents,s.feeCents),0)/expected)):0;
  const f=COACH.moneyFilter||"owing",shown=f==="all"?st:f==="paid"?st.filter(s=>s.status[0]==="paid"):f==="checking"?st.filter(s=>s.status[0]==="checking"):owing;
  const max=Math.max(1,...M.history.map(h=>Math.max(h.expectedCents,h.collectedCents))),isNow=M.month>=M.today.slice(0,7);
  const chip=(k,l,n)=>`<button class="chip" data-a="moneyfilter" data-v="${k}" aria-pressed="${f===k}">${l} <b>${n}</b></button>`;
  return `<section class="stack">
    <div class="row between" style="flex-wrap:nowrap"><button class="btn sm" data-a="moneymonth" data-v="-1" aria-label="Previous month">‹</button><h2 style="margin:0">${esc(monthLabel(M.month))}</h2><button class="btn sm" data-a="moneymonth" data-v="1" aria-label="Next month"${isNow?" disabled":""}>›</button></div>
    <div class="stats four"><div class="stat"><b>${money(M.collectedCents,cur)}</b><span>Collected</span></div><div class="stat"><b>${money(expected,cur)}</b><span>Expected</span></div><div class="stat"><b>${money(outstanding,cur)}</b><span>Outstanding</span></div><div class="stat"><b>${rate}%</b><span>Of fees paid</span></div></div>
    <figure class="mchart" aria-label="Collected against expected, last six months">${M.history.map(h=>`<button class="mcol${h.month===M.month?" on":""}" data-a="moneyjump" data-v="${h.month}" aria-label="${esc(monthLabel(h.month))}: ${money(h.collectedCents,cur)} of ${money(h.expectedCents,cur)}"><span class="mbar" style="height:${Math.round(100*Math.max(h.expectedCents,h.collectedCents)/max)}%"><i style="height:${h.expectedCents?Math.min(100,Math.round(100*h.collectedCents/Math.max(h.expectedCents,h.collectedCents))):100}%"></i></span><small>${esc(new Date(h.month+"-01T12:00:00").toLocaleDateString(undefined,{month:"short"}))}</small></button>`).join("")}
      <figcaption class="small muted"><i class="mkey"></i> collected · outline: expected from current fees</figcaption></figure>
    ${M.methods.length?`<p class="small muted">${M.methods.map(m=>`${esc(PMETH[m.method]||m.method)} ${money(m.cents,cur)} (${m.n})`).join(" · ")}</p>`:""}
    ${M.pendingCents?`<button class="insight warn" data-a="moneyview" data-v="payments" style="text-align:left;width:100%"><b>${money(M.pendingCents,cur)}</b> in proofs waiting to be checked ›</button>`:""}
    ${M.unmatchedCents?`<button class="insight warn" data-a="moneyview" data-v="payments" style="text-align:left;width:100%"><b>${money(M.unmatchedCents,cur)}</b> paid but not matched to a student ›</button>`:""}
    <div class="chips">${chip("owing","Owing",owing.length)}${chip("checking","Checking",st.filter(s=>s.status[0]==="checking").length)}${chip("paid","Paid",st.filter(s=>s.status[0]==="paid").length)}${chip("all","Everyone",st.length)}</div>
    ${shown.length?`<div class="list">${shown.map(s=>{const left=s.feeCents-s.paidCents,[k,l,tone]=s.status;
      return `<div class="mrow"><button class="mrow-main" data-a="student" data-v="${s.id}"><span class="nm">${esc(s.name)}${s.offline?` <span class="pill">Not on app</span>`:""}</span><span class="small muted">${[s.plan,s.feeCents?`${money(s.paidCents,cur)} of ${money(s.feeCents,cur)}`:"",s.lastPaid&&k!=="paid"?`last paid ${fmtDate(s.lastPaid)}`:""].filter(Boolean).map(esc).join(" · ")}</span></button>
        <span class="mrow-side">${tone?`<span class="pill ${tone}">${esc(l)}</span>`:`<span class="small muted">${esc(l)}</span>`}${["due","late","part"].includes(k)&&s.phone?waBtn(remindText(s,M),"Remind",{phone:s.phone,kind:"fee_reminder",cls:"sm"}):""}</span></div>`}).join("")}</div>`
      :`<div class="empty">${f==="owing"?(billed.length?"Everyone's paid for this month.":"No fees set yet. Add membership plans under Setup and put students on them."):"Nobody here."}</div>`}
    <div class="grid2"><button class="btn primary" data-a="paynew">Record a payment</button><label class="btn" for="pop-up" style="cursor:pointer">Upload proof</label></div><input type="file" id="pop-up" accept="image/*,application/pdf" hidden>
    <div class="grid2">${owing.some(s=>s.email)?`<button class="btn" data-a="remindall">Email ${owing.filter(s=>s.email).length} reminder${owing.filter(s=>s.email).length>1?"s":""}</button>`:"<span></span>"}<button class="btn" data-a="moneycsv">Download CSV</button></div>
    ${owing.some(s=>!s.phone&&!s.email)?`<p class="small muted">No WhatsApp number or email for ${esc(owing.filter(s=>!s.phone&&!s.email).map(s=>s.name).join(", "))}. Add one on their student page.</p>`:""}
  </section>`}
async function remindAll(){const M=COACH.money;if(!M)return;const ids=M.students.filter(s=>["due","late","part"].includes(moneyStatus(s,M)[0])&&s.email).map(s=>s.id);
  try{const j=await api("POST","/coach/money/remind",{month:M.month,userIds:ids});hideSheet();toast(`Sent ${j.sent} reminder${j.sent===1?"":"s"}.${j.noEmail.length?` No email for ${j.noEmail.join(", ")}.`:""}`);jfTrack("fee_reminders",{count:j.sent})}catch(e){toast(e.message)}}
function moneyCSV(){const M=COACH.money;if(!M)return;const q=v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`,r=c=>(c/100).toFixed(2);
  const rows=[["Student","Plan","Fee","Paid","Checking","Owing","Status","Reference","Email","WhatsApp"]].concat(M.students.map(s=>[s.name,s.plan||"",r(s.feeCents),r(s.paidCents),r(s.pendingCents),r(Math.max(0,s.feeCents-s.paidCents)),moneyStatus(s,M)[1],s.reference,s.email,s.phone]));
  const ps=(COACH.payments||[]).filter(p=>p.paidOn.slice(0,7)===M.month),by=Object.fromEntries(M.students.map(s=>[s.id,s.name]));
  const pay=[[],["Payments"],["Date","Student","Amount","Method","Reference","Status","Source"]].concat(ps.map(p=>[p.paidOn,by[p.userId]||"",r(p.amountCents),PMETH[p.method]||p.method||"",p.reference,p.status,p.source]));
  const csv=rows.concat(pay).map(x=>x.map(q).join(",")).join("\r\n");
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["﻿"+csv],{type:"text/csv"}));a.download=`${gymName().replace(/[^\w]+/g,"-")}-fees-${M.month}.csv`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}

/* ----- students a coach adds who aren't on the app ----- */
function addStudentSheet(){const plans=(COACH.roster.plans||[]).filter(p=>p.active);S.ui.sheet={k:"addstu"};S.ui.stack=[];
  openSheet(`${sheetHead("Add a student")}<form id="addstuform" class="stack-lg" novalidate><button type="button" class="btn" data-a="bulkopen">${canPickContacts()?"Add several from my contacts":"Add several: contacts file or a list"}</button><p class="small">For someone who isn't on the app (yet). You can record their payments, attendance and plan, and send them an invite later; when they sign up, it all carries over.</p>
    <label class="f">Name<input name="name" autocomplete="off" required></label>
    <label class="f">WhatsApp number<input name="phone" type="tel" inputmode="tel" placeholder="082 123 4567"></label>
    <label class="f">Email (optional)<input name="email" type="email" inputmode="email" autocomplete="off"></label>
    <div class="grid2"><label class="f">Belt<select name="belt">${["white","blue","purple","brown","black"].map(b=>`<option value="${b}">${cap1(b)}</option>`).join("")}</select></label><label class="f">Stripes<select name="stripes">${[0,1,2,3,4].map(n=>`<option>${n}</option>`).join("")}</select></label></div>
    ${plans.length?`<label class="f">Membership<select name="plan"><option value="">No plan</option>${plans.map(p=>`<option value="${p.id}">${esc(p.name)} · ${money(p.priceCents,COACH.roster.currency)}</option>`).join("")}</select></label>`:""}
    <label class="f">Notes<input name="notes" placeholder="e.g. pays cash on Mondays"></label></form>`,false,{act:`<button class="btn primary grow" type="submit" form="addstuform">Add student</button>`})}
async function submitAddStudent(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  try{const j=await api("POST","/coach/students",{name:v("name"),phone:v("phone"),email:v("email"),belt:v("belt"),stripes:Number(v("stripes")||0),planId:v("plan")||null,notes:v("notes")});
    hideSheet();await coachLoad("roster");COACH.money=null;toast("Student added.");studentSheet(j.id)}catch(e){toast(e.message)}}

/* ----- notices for students: classes cancelled or moved ----- */
async function loadNotices(){if(!API.me||!API.me.gym||isCoach())return;try{API.notices=await api("GET","/me/notices")}catch(e){}}
function noticesCard(){const N=API.notices;if(!N||!N.notices.length)return "";const recent=N.notices.filter(n=>n.unread||Date.now()-new Date(n.at).getTime()<3*864e5).slice(0,5);if(!recent.length)return "";
  if(N.unread&&!API.noticesSeenSent){API.noticesSeenSent=true;setTimeout(()=>api("POST","/me/notices/seen").then(()=>{N.unread=0}).catch(()=>{}),1500)}
  return `<section class="panel stack notices"><h2 class="label">Gym updates</h2>${recent.map(n=>`<div class="notice ${esc(n.kind)}${n.unread?" new":""}"><b>${esc(n.title)}</b><span class="small">${esc(n.body)}</span><span class="small muted">${esc(fmtDate(String(n.at).slice(0,10)))}</span></div>`).join("")}</section>`}

function coachToday(){
  const t=todayK(),cs=COACH.classes||[],g=byDay(cs),todays=g[t]||[],ws=weekStart(t),week=cs.filter(c=>{const k=dayKey(c.startsAt);return k>=ws&&k<=addDays2(ws,6)});
  if(!API.comps)loadComps();
  const ppl=students(),pendN=(COACH.payments||[]).filter(p=>p.status==="pending").length,due=ppl.filter(p=>p.active&&p.feeCents>0&&p.paidThisMonthCents+(p.pendingThisMonthCents||0)<p.feeCents),fresh=ppl.filter(p=>Date.now()-new Date(p.joined).getTime()<7*864e5);
  const risk=ppl.filter(p=>p.visits&&p.visits.segment==="at_risk");
  const asking=upcomingComps().reduce((s,c)=>s+(c.requested||0),0);
  const full=cs.filter(c=>c.waiting&&clsEnd(c)>Date.now()&&dayKey(c.startsAt)<=addDays2(t,7));
  const item=(tone,txt,a,v,btn)=>`<div class="insight ${tone}"><div class="row between" style="flex-wrap:nowrap;gap:10px"><span>${txt}</span><button class="btn sm" data-a="${a}" data-v="${v}">${btn}</button></div></div>`;
  const needs=[
    asking&&item("warn",`<b>${asking}</b> asking to compete`,"coachgo","comps","Review"),
    ...full.slice(0,3).map(c=>item("warn",`<b>${esc(c.title)}</b> ${esc(dayLabel(c.startsAt).toLowerCase())} ${esc(fmtTime(c.startsAt))} is full with ${c.waiting} waiting`,"classopen",c.id,"Open")),
    pendN&&item("warn",`<b>${pendN}</b> payment${pendN>1?"s":""} to check`,"coachgo","money","Check"),
    due.length&&item("warn",`<b>${due.length}</b> haven't paid this month`,"coachgo","money","See who"),
    risk.length&&item("warn",`<b>${risk.length}</b> student${risk.length>1?"s":""} at risk of dropping off`,"coachgo","insights","See who"),
    fresh.length&&item("good",`<b>${fresh.length}</b> new student${fresh.length>1?"s":""} this week`,"coachgo","roster","Roster"),
  ].filter(Boolean);
  const booked=week.filter(c=>c.kind!=="private").reduce((s,c)=>s+c.going,0);
  impLoad();
  return `${impBanner()}${setupCard()}<section class="stack"><div class="row between"><h2 class="label">${esc(fromYmd(t).toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long"}))}</h2><button class="btn sm" data-a="classnewday" data-v="${t}">+ Add</button></div>
      ${todays.length?`<div class="calrows">${todays.map(calRow).join("")}</div>`:`<p class="small muted">No classes today.</p>`}</section>
    <section class="stack"><h2 class="label">Needs you</h2>${needs.length?needs.join(""):`<p class="small muted">Nothing waiting. Everyone's paid, nobody's stuck on a waitlist, no requests.</p>`}</section>
    <section class="stack"><h2 class="label">This week</h2><div class="stats"><div class="stat"><b>${week.filter(c=>c.kind!=="private").length}</b><span>Classes</span></div><div class="stat"><b>${booked}</b><span>Bookings</span></div><div class="stat"><b>${ppl.filter(p=>p.active).length}</b><span>Students</span></div></div></section>
    <section class="stack"><h2 class="label">Quick actions</h2><div class="quick">
      <button class="btn primary" data-a="classnew">+ Add a class</button><button class="btn" data-a="paynew">Record a payment</button>
      ${waBtn(WA_T.invite(),"Invite students on WhatsApp",{kind:"invite"})}${waBtn(WA_T.week(),"Send this week's classes",{kind:"week"})}<button class="btn" data-a="coachgo" data-v="comps">+ Competition</button></div></section>`;
}
const students=()=>(COACH.roster?.people||[]).filter(p=>p.role==="student");
/* ----- calendar (coach Classes tab and the student Classes tab) ----- */
const pad2=n=>String(n).padStart(2,"0");
const ymd=d=>`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const fromYmd=k=>{const [y,m,d]=k.split("-").map(Number);return new Date(y,m-1,d)};
const addDays2=(k,n)=>{const d=fromYmd(k);d.setDate(d.getDate()+n);return ymd(d)};
const weekStart=k=>{const d=fromYmd(k);d.setDate(d.getDate()-((d.getDay()+6)%7));return ymd(d)};
const todayK=()=>ymd(new Date());
function calState(who){const st=who==="coach"?(COACH.cal=COACH.cal||{mode:"week",sel:todayK(),anchor:todayK()}):(S.ui.bcal=S.ui.bcal||{mode:"week",sel:null,anchor:todayK()});return st}
function byDay(list){const g={};list.forEach(c=>{const k=dayKey(c.startsAt);(g[k]=g[k]||[]).push(c)});Object.values(g).forEach(a=>a.sort((x,y)=>new Date(x.startsAt)-new Date(y.startsAt)));return g}
function calHeader(who,st,g){
  const k=who==="coach"?"coach":"book",t=todayK();
  if(st.mode==="month"){
    const first=fromYmd(st.anchor.slice(0,8)+"01"),label=first.toLocaleDateString(undefined,{month:"long",year:"numeric"});
    let d=weekStart(ymd(first));const cells=[];
    for(let i=0;i<42;i++){const inM=fromYmd(d).getMonth()===first.getMonth();if(i>=35&&!inM)break;const n=(g[d]||[]).length;
      cells.push(`<button class="mcell${inM?"":" out"}${d===t?" today":""}${d===st.sel?" sel":""}" data-a="calday" data-k="${k}" data-v="${d}" aria-label="${esc(fromYmd(d).toDateString())}, ${n} class${n===1?"":"es"}"><span>${fromYmd(d).getDate()}</span>${n?`<i>${n}</i>`:""}</button>`);d=addDays2(d,1)}
    return `<div class="calnav"><button class="btn ghost" data-a="calnav" data-k="${k}" data-v="-1" aria-label="Previous month">‹</button><b>${esc(label)}</b><button class="btn ghost" data-a="calnav" data-k="${k}" data-v="1" aria-label="Next month">›</button></div>
      <div class="mgrid">${DN.map(n=>`<span class="mdow">${n[0]}</span>`).join("")}${cells.join("")}</div>`}
  const ws=weekStart(st.anchor),we=addDays2(ws,6),f=x=>fromYmd(x).toLocaleDateString(undefined,{day:"numeric",month:"short"});
  const days=[0,1,2,3,4,5,6].map(i=>{const d=addDays2(ws,i),n=(g[d]||[]).length;return `<button class="wday${d===t?" today":""}${d===st.sel?" sel":""}" data-a="calday" data-k="${k}" data-v="${d}" aria-label="${esc(fromYmd(d).toDateString())}, ${n} class${n===1?"":"es"}"><small>${DN[i]}</small><b>${fromYmd(d).getDate()}</b><i>${n?n:""}</i></button>`}).join("");
  return `<div class="calnav"><button class="btn ghost" data-a="calnav" data-k="${k}" data-v="-1" aria-label="Previous week">‹</button><b>${esc(f(ws))} – ${esc(f(we))}</b>${ws!==weekStart(t)?`<button class="linkbtn small" data-a="caltoday" data-k="${k}">Today</button>`:""}<button class="btn ghost" data-a="calnav" data-k="${k}" data-v="1" aria-label="Next week">›</button></div>
    <div class="wstrip">${days}</div>`}
function calRow(c){
  const priv=c.kind==="private",past=clsEnd(c)<Date.now(),fill=c.capacity?Math.min(100,Math.round(100*c.going/c.capacity)):null;
  const who=priv?(c.attendees&&c.attendees.length?esc(c.attendees.map(a=>a.name).join(", ")):"Open slot"):"";
  return swipeWrap(`<button class="calrow${priv?" priv":""}${past?" past":""}" data-a="classopen" data-v="${c.id}">
    <span class="cr-time mono"><span>${timeHTML(c.startsAt)}</span><small>${c.durationMin} min</small></span>
    <span class="cr-body"><b>${esc(c.title)}</b><small>${[priv?"Private":c.level,c.coach,priv&&c.priceCents?money(c.priceCents,API.me.gym.currency):""].filter(Boolean).map(esc).join(" · ")}</small>${priv?`<small class="${c.attendees&&c.attendees.length?"ok":""}">${priv&&c.attendees&&c.attendees.length?"Booked by ":""}${who}</small>`:""}</span>
    ${priv?"":`<span class="cr-cap mono"><b>${c.going}${c.capacity?`<small>/${c.capacity}</small>`:""}</b><small>${past?"came":"booked"}</small>${fill!==null?`<span class="cap"><i style="width:${fill}%"></i></span>`:""}${c.waiting?`<small class="w">+${c.waiting} waiting</small>`:""}</span>`}</button>`,{edit:["classeditid",c.id],del:["classdelask",c.id]})}
function coachClasses(){
  if(!API.comps)loadComps();
  const st=calState("coach"),cs=COACH.classes||[],g=byDay(cs),t=todayK();
  const ws=weekStart(st.anchor),weekHas=[0,1,2,3,4,5,6].some(i=>(g[addDays2(ws,i)]||[]).some(c=>c.kind!=="private"));
  const day=d=>`<section class="stack calday"><div class="row between"><h2 class="label">${esc(d===t?"Today":fromYmd(d).toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"short"}))}</h2>${d>=t?`<button class="btn sm" data-a="classnewday" data-v="${d}">+ Add</button>`:""}</div>
    ${(API.comps||[]).filter(c=>c.startsOn<=d&&(c.endsOn||c.startsOn)>=d).map(c=>`<button class="compbar" data-a="compopen" data-v="${c.id}">🏆 ${esc(c.name)} <small>${c.entered} on the team</small></button>`).join("")}
    ${(g[d]||[]).length?`<div class="calrows">${g[d].map(calRow).join("")}</div>${(()=>{try{return localStorage.getItem("jf.swiped")}catch(e){return 1}})()?"":`<p class="swipetip">Tip: swipe a class right to edit it, left to delete it.</p>`}`:`<p class="small muted">No classes${d>=t?". Tap + Add to plan one.":"."}</p>`}</section>`;
  return `<section class="stack">
    <div class="row" style="flex-wrap:nowrap"><button class="btn primary grow" data-a="classnew">+ Plan a class</button><button class="btn" data-a="privnew">+ Private slots</button></div>
    <div class="seg2"><button data-a="calmode" data-k="coach" data-v="week" aria-pressed="${st.mode==="week"}">Week</button><button data-a="calmode" data-k="coach" data-v="month" aria-pressed="${st.mode==="month"}">Month</button></div>
    ${calHeader("coach",st,g)}
    ${day(st.sel||t)}
    ${st.mode==="week"&&weekHas?`<button class="btn full" data-a="copyweek">Copy this week's classes to next week</button>`:""}
    ${!cs.length?`<div class="empty">No classes yet. Add them one at a time, or import your timetable in the Gym tab and tap Add classes.</div>`:""}
  </section>`}
async function calMove(k,dir){const st=calState(k==="coach"?"coach":"book");
  if(st.mode==="month"){const d=fromYmd(st.anchor.slice(0,8)+"01");d.setMonth(d.getMonth()+dir);st.anchor=ymd(d);st.sel=ymd(d)}
  else{st.anchor=addDays2(weekStart(st.anchor),7*dir);st.sel=k==="coach"||st.sel?(st.anchor<todayK()&&addDays2(st.anchor,6)>=todayK()?todayK():st.anchor):null}
  if(k==="coach")await ensureRange(st.anchor);else{const ok=API.classes;if(!ok)loadClasses(true)}render()}
async function ensureRange(k){const d=fromYmd(k);if(COACH.rFrom&&d>=COACH.rFrom&&d<=COACH.rTo)return;await coachLoad("classes",k)}
async function copyWeek(){
  const st=calState("coach"),ws=weekStart(st.anchor),list=(COACH.classes||[]).filter(c=>c.kind!=="private"&&dayKey(c.startsAt)>=ws&&dayKey(c.startsAt)<=addDays2(ws,6));
  const out=list.map(c=>{const d=new Date(c.startsAt);d.setDate(d.getDate()+7);return {title:c.title,startsAt:d.toISOString(),durationMin:c.durationMin,capacity:c.capacity,coach:c.coach,level:c.level,kind:"class",shared:c.shared,plan:{focus:"",notes:"",ids:[]}}});
  if(!out.length)return;
  try{const j=await api("POST","/coach/classes/bulk",{classes:out});st.anchor=addDays2(ws,7);st.sel=st.anchor;await coachLoad("classes",st.anchor);toast(`Copied ${j.added} class${j.added===1?"":"es"} to next week${j.skipped?` (${j.skipped} already there)`:""}.`)}catch(e){toast(e.message)}}

/* ----- adding and editing a class ----- */
function knownTitles(){const m=new Map();(gymProfile().timetable||[]).forEach(r=>{const t=r.title+(r.level&&!r.title.toLowerCase().includes(r.level.toLowerCase())?` (${r.level})`:"");if(!m.has(t.toLowerCase()))m.set(t.toLowerCase(),t)});
  (COACH.classes||[]).filter(c=>c.kind!=="private").forEach(c=>{if(!m.has(c.title.toLowerCase()))m.set(c.title.toLowerCase(),c.title)});return [...m.values()].sort()}
function classAutofill(title){
  const f=document.getElementById("classform");if(!f||!title)return;const tl=title.trim().toLowerCase();
  const last=(COACH.classes||[]).filter(c=>c.title.toLowerCase()===tl).sort((a,b)=>new Date(b.startsAt)-new Date(a.startsAt))[0];
  const tt=(gymProfile().timetable||[]).find(r=>(r.title+(r.level?` (${r.level})`:"")).toLowerCase()===tl||r.title.toLowerCase()===tl);
  const set=(id,v)=>{const el=document.getElementById(id);if(el&&v!==undefined&&v!==null&&v!=="")el.value=v};
  const cp=v=>setCoachPick(document.getElementById("c-coach"),v);
  if(last){set("c-dur",last.durationMin);set("c-cap",last.capacity||"");cp(last.coach);set("c-level",last.level);set("c-time",fmtHM(last.startsAt))}
  else if(tt){cp(tt.coach);set("c-level",tt.level);set("c-time",tt.start);if(tt.end){const [a,b]=tt.start.split(":").map(Number),[c2,d]=tt.end.split(":").map(Number);const m=(c2*60+d)-(a*60+b);if(m>=15)set("c-dur",m)}}}
/* Coach picker: the gym's coach accounts plus coaches from its profile; a free name for guests. */
function coachNames(){const m=new Map(),add=n=>{n=String(n||"").trim();if(n&&!m.has(n.toLowerCase()))m.set(n.toLowerCase(),n)};
  ((COACH.roster||{}).people||[]).filter(p=>p.role==="coach").map(p=>p.name).concat((gymProfile().coaches||[]).map(c=>c.name)).sort((a,b)=>String(a).localeCompare(String(b))).forEach(add);
  const me=String(API.me.name||"").trim(),rest=[...m.values()].filter(n=>n.toLowerCase()!==me.toLowerCase());return me?[me,...rest]:rest}
function coachField(id,cur,isEdit){const names=coachNames();cur=String(cur||"").trim();
  if(names.length<2)return `<label class="f">Coach<input id="${id}" name="coach" value="${esc(cur)}"></label>`;
  const has=names.some(n=>n.toLowerCase()===cur.toLowerCase()),opts=names.map(n=>`<option${n.toLowerCase()===cur.toLowerCase()?" selected":""}>${esc(n)}</option>`).join("");
  return `<label class="f">Coach<select id="${id}" name="coach" data-coachpick="1">${isEdit&&!cur?`<option value="" selected>Not set</option>`:""}${cur&&!has?`<option selected>${esc(cur)}</option>`:""}${opts}<option value="__other">Someone else…</option></select><input id="${id}-other" name="coachOther" placeholder="Coach's name" aria-label="Coach's name" hidden style="margin-top:8px"></label>`}
const coachVal=f=>{const s=f.querySelector('[name="coach"]'),o=f.querySelector('[name="coachOther"]');return s?(s.value==="__other"?(o&&o.value||"").trim():s.value.trim()):""};
function setCoachPick(el,v){if(!el||!v)return;if(el.tagName==="SELECT"&&![...el.options].some(o=>o.value===v)){const o=document.createElement("option");o.textContent=v;el.insertBefore(o,el.querySelector('option[value="__other"]'))}el.value=v;const x=document.getElementById(el.id+"-other");if(x)x.hidden=true}
const fmtHM=iso=>{const d=new Date(iso);return pad2(d.getHours())+":"+pad2(d.getMinutes())};
function classForm(c,onDay){
  const st=calState("coach"),def=onDay||(st.sel&&st.sel>todayK()?st.sel:addDays2(todayK(),1));
  const date=c?dayKey(c.startsAt):def,time=c?fmtHM(c.startsAt):"18:00";
  S.ui.cplan=S.ui.cplan||{ids:(c&&c.plan&&c.plan.ids||[]).slice()};
  const picked=S.ui.cplan.ids.filter(id=>TM[id]).map(id=>`<button type="button" class="chip" data-a="cplanrm" data-v="${id}">${esc(TM[id].n)} <span class="x">×</span></button>`).join("");
  const priv=c&&c.kind==="private",hasPlan=c&&c.plan&&(c.plan.focus||c.plan.notes||(c.plan.ids||[]).length);
  S.ui.sheet={k:"classform",id:c&&c.id};S.ui.stack=[];
  openSheet(`${sheetHead(c?"Edit class":"Add a class")}<form id="classform" class="stack-lg" novalidate>
    <label class="f">Class<input id="c-title" name="title" list="c-titles" autocomplete="off" value="${esc(c?c.title:"")}" placeholder="e.g. No-gi fundamentals"></label>
    <datalist id="c-titles">${knownTitles().map(t=>`<option value="${esc(t)}">`).join("")}</datalist>
    ${c?"":`<p class="small muted" style="margin-top:-12px">Pick a class you've run before and the rest fills itself in.</p>`}
    <div class="grid2"><label class="f">Date<input id="c-date" name="date" type="date" value="${date}"></label><label class="f">Start<input id="c-time" name="time" type="time" value="${time}"></label></div>
    <div class="grid2"><label class="f">Minutes<input id="c-dur" name="dur" type="number" inputmode="numeric" min="15" max="600" value="${c?c.durationMin:60}"></label><label class="f">Spots<input id="c-cap" name="cap" type="number" inputmode="numeric" min="1" max="500" value="${c&&c.capacity?c.capacity:""}" placeholder="No limit"></label></div>
    <div class="grid2">${coachField("c-coach",c?c.coach:API.me.name,!!c)}<label class="f">Level<input id="c-level" name="level" value="${esc(c?c.level||"":"")}" placeholder="All levels"></label></div>
    ${c?"":`<label class="f">Repeat<select id="c-repeat" name="repeat"><option value="0">Just this once</option><option value="4">Every week for 4 weeks</option><option value="8">Every week for 8 weeks</option><option value="12">Every week for 12 weeks</option></select></label>`}
    <div class="grid2"><label class="f">Type<select id="c-kind" name="kind"><option value="class"${priv?"":" selected"}>Group class</option><option value="private"${priv?" selected":""}>Private lesson</option></select></label>
      <label class="f" id="c-price-wrap"${priv?"":" hidden"}>Price (${esc(API.me.gym.currency||"ZAR")})<input id="c-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${c&&c.priceCents?c.priceCents/100:""}"></label></div>
    <details class="planbox"${hasPlan?" open":""}><summary>Lesson plan (optional)</summary><div class="stack-lg" style="padding-top:12px">
      <label class="f">Focus<input id="c-focus" name="focus" value="${esc(c&&c.plan?c.plan.focus||"":"")}" placeholder="e.g. Half guard bottom: underhook and dogfight"></label>
      <div class="stack"><label class="f" for="c-add">Techniques to teach</label><select id="c-add" data-cplan="1"><option value="">Add a technique…</option>${techOptions()}</select><div class="chips" id="cplan-chips">${picked}</div></div>
      <label class="f"><span class="row between" style="flex-wrap:nowrap">Notes${micBtn("c-notes")}</span><textarea id="c-notes" name="notes" placeholder="Warm-up, drills, positional rounds…">${esc(c&&c.plan?c.plan.notes||"":"")}</textarea></label>
      <label class="row small"><input id="c-shared" name="shared" type="checkbox" style="width:auto"${!c||c.shared?" checked":""}> Show the plan to students so they can study before class</label></div></details>
    ${c?`<button class="btn danger" type="button" data-a="classdel" data-v="${c.id}">Delete class</button>`:""}
  </form>`,false,{act:`<button class="btn primary grow" type="submit" form="classform">${c?"Save class":"Add class"}</button>`});
}
async function submitClass(form){
  const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  if(!v("title").trim()){toast("Give the class a name.");return}
  const when=new Date(`${v("date")}T${v("time")||"18:00"}`);if(isNaN(when)){toast("Pick a date and time.");return}
  const body={title:v("title").trim(),startsAt:when.toISOString(),durationMin:Number(v("dur"))||60,shared:form.querySelector("[name=shared]").checked,plan:{focus:v("focus"),notes:v("notes"),ids:(S.ui.cplan||{ids:[]}).ids},
    kind:v("kind")||"class",capacity:v("cap")?Number(v("cap")):null,coach:coachVal(form),level:v("level"),priceCents:v("kind")==="private"&&v("price")?Math.round(Number(v("price"))*100):null};
  const id=S.ui.sheet&&S.ui.sheet.id,reps=id?0:Number(v("repeat"))||0;
  try{
    if(reps>1){const list=[];for(let i=0;i<reps;i++){const d=new Date(when);d.setDate(d.getDate()+7*i);list.push({...body,startsAt:d.toISOString()})}
      const j=await api("POST","/coach/classes/bulk",{classes:list});toast(`Added ${j.added} weekly class${j.added===1?"":"es"}${j.skipped?` (${j.skipped} already there)`:""}.`)}
    else{await api(id?"PUT":"POST",id?`/classes/${id}`:"/classes",body);toast(id?"Class saved.":"Class added. Students can book it now.")}
    S.ui.cplan=null;hideSheet();const st=calState("coach");st.sel=ymd(when);st.anchor=st.sel;await coachLoad("classes",st.anchor);coachGo("classes")}
  catch(e){toast(e.message)}
}
async function classSheet(id){
  S.ui.sheet={k:"class",id};S.ui.stack=[];
  openSheet(`${sheetHead("Class")}<div class="empty">Loading who's coming…</div>`);
  let j;try{j=await api("GET",`/coach/classes/${id}`)}catch(e){toast(e.message);hideSheet();render();return}
  S.ui.classData=j;drawClassSheet();
}
function drawClassSheet(keep){
  const {class:c,attendees}=S.ui.classData,waitlist=S.ui.classData.waitlist||[];const going=attendees.filter(a=>a.going);
  const rows=attendees.map(a=>{const g=goalOf(a),ar=areasFor(a.mastery,g),lo=ar.slice().sort((x,y)=>x.pct-y.pct)[0];
    return `<div class="attrow"><div><b>${esc(a.name)}</b> ${beltChip(a.belt,a.stripes)}<br><span class="small muted">${readinessFor(a.mastery,g)}% ready for ${BELT[g].to}${lo?" · weakest: "+esc(lo.n):""}</span></div>
      <button class="chip" data-a="attend" data-v="${a.id}" aria-pressed="${!!a.attended}">${a.attended?(a.self?"✓ Checked in":"✓ Here"):"Mark here"}</button></div>`}).join("");
  // Suggested focus from everyone who's coming
  let sug="";
  if(going.length){
    const tot={};going.forEach(a=>areasFor(a.mastery,goalOf(a)).forEach(x=>{(tot[x.n]=tot[x.n]||{n:x.n,f:x.f,s:0,c:0});tot[x.n].s+=x.pct;tot[x.n].c++}));
    const areas=Object.values(tot).map(x=>({...x,avg:Math.round(x.s/x.c)})).sort((a,b)=>a.avg-b.avg);const weak=areas[0];
    const stuck={},tapped={};going.forEach(a=>{Object.entries(a.stuck||{}).forEach(([k,n])=>stuck[k]=(stuck[k]||0)+n);Object.entries(a.tapped||{}).forEach(([k,n])=>tapped[k]=(tapped[k]||0)+n)});
    const topStuck=Object.entries(stuck).filter(([k])=>POS[k]).sort((a,b)=>b[1]-a[1]).slice(0,3),topTap=Object.entries(tapped).filter(([k])=>TM[k]).sort((a,b)=>b[1]-a[1]).slice(0,3);
    const pool=TECH.filter(t=>t.p!=="plus"&&beltOf(t)==="blue"&&weak&&weak.f(t)).map(t=>({t,avg:going.reduce((s,a)=>s+Math.min(4,Number((a.mastery||{})[t.id])||0),0)/going.length})).sort((a,b)=>a.avg-b.avg).slice(0,4);
    const inPlan=new Set((c.plan&&c.plan.ids)||[]);
    sug=`<section class="panel accent"><h2 class="label">Suggested focus</h2>
      ${weak?`<p>Weakest area for the ${going.length} coming: <b>${esc(weak.n)}</b> (${weak.avg}% on average).</p>`:""}
      ${topStuck.length?`<p class="small">Getting stuck in: ${topStuck.map(([k,n])=>`${esc(POS[k].l)} ×${n}`).join(", ")}</p>`:""}
      ${topTap.length?`<p class="small">Getting tapped by: ${topTap.map(([k,n])=>`${esc(TM[k].n)} ×${n}`).join(", ")}</p>`:""}
      ${pool.length?`<div class="list">${pool.map(x=>`<div class="row between" style="flex-wrap:nowrap;border-top:1px solid var(--line);padding-block:6px"><span><b>${esc(x.t.n)}</b><br><span class="small muted">Group average: ${LEVELS[Math.round(x.avg)].n}</span></span>${inPlan.has(x.t.id)?`<span class="small" style="color:var(--good);font-weight:700">In plan</span>`:`<button class="btn" data-a="addtoplan" data-v="${x.t.id}">Add to plan</button>`}</div>`).join("")}</div>`:""}</section>`;
  }
  const p=c.plan||{};
  openSheet(`${sheetHead("Class")}<div class="stack-lg"><div><h1>${esc(c.title)}</h1><p class="muted">${esc(fmtWhen(c.startsAt))} · ${c.durationMin} min${c.shared?"":" · plan hidden from students"}</p></div>
    <section class="stack"><h2 class="label">The plan</h2>${p.focus?`<p><b>${esc(p.focus)}</b></p>`:""}${(p.ids||[]).filter(id=>TM[id]).length?`<div class="list">${p.ids.filter(id=>TM[id]).map(id=>tRow(TM[id])).join("")}</div>`:`<p class="small muted">No techniques picked yet.</p>`}${p.notes?`<p class="small">${esc(p.notes)}</p>`:""}</section>
    ${sug}
    <section class="stack"><div class="row between"><h2 class="label">Who's coming</h2><span class="small muted mono">${going.length}${c.capacity?"/"+c.capacity:""} going</span></div>${rows||`<div class="empty">Nobody has booked yet. Students book from Classes or their Today screen.</div>`}
      ${going.some(a=>!a.attended)&&new Date(c.startsAt).getTime()-Date.now()<3*36e5?`<button class="btn" data-a="attendall">Check in everyone booked (${going.filter(a=>!a.attended).length})</button>`:""}</section>
    ${waitlist.length?`<section class="stack"><h2 class="label">Waitlist (${waitlist.length})</h2><div class="list">${waitlist.map((a,i)=>`<div class="attrow"><span><b>${i+1}. ${esc(a.name)}</b> ${beltChip(a.belt,a.stripes)}</span><span class="small muted">gets the next spot</span></div>`).join("")}</div></section>`:""}
  </div>`,keep,{act:`<button class="btn grow" data-a="classedit" data-v="${c.id}">Edit plan</button>`});
}
function coachRoster(){
  const ppl=students(),cur=COACH.roster.currency,q=COACH.q.trim().toLowerCase();
  const due=ppl.filter(p=>p.active&&p.feeCents>0&&p.paidThisMonthCents<p.feeCents);
  const list=ppl.filter(p=>!q||p.name.toLowerCase().includes(q));
  return `<section class="stack"><div class="stats"><div class="stat"><b>${ppl.filter(p=>p.active).length}</b><span>Students</span></div><div class="stat"><b>${ppl.filter(p=>p.attended30>0||p.n30>0).length}</b><span>Trained · 30d</span></div><div class="stat"><b>${due.length}</b><span>Fees due</span></div></div>
    <div class="row" style="flex-wrap:nowrap"><input id="r-q" type="search" placeholder="Search students" value="${esc(COACH.q)}" aria-label="Search students" style="flex:1"><button class="btn" data-a="addstu">+ Add</button></div>
    <div class="list" id="roster-list">${list.map(p=>{const g=goalOf(p),r=readinessFor(p.mastery,g),paid=p.feeCents>0?(p.paidThisMonthCents>=p.feeCents?`<span class="pill ok">Paid</span>`:`<span class="pill due">Due</span>`):"";
      const vs=p.visits||{};return `<button class="trow" data-a="student" data-v="${p.id}" style="grid-template-columns:minmax(0,1fr) auto"><span><span class="nm">${esc(p.name)}${p.active?"":" (inactive)"}${p.offline?` <span class="pill">Not on app</span>`:""}</span><span class="meta">${beltChip(p.belt,p.stripes)}${vs.segment?`<span class="segtag ${vs.segment}">${esc(SEG[vs.segment][0])}</span>`:""}<span>${vs.d28||0} classes / 4 wks</span><span>${r}% → ${BELT[g].to}</span>${p.planName?`<span>${esc(p.planName)}${p.planStatus&&p.planStatus!=="active"?" ("+esc(p.planStatus)+")":""}</span>`:""}</span></span>${paid}</button>`}).join("")||`<div class="empty">No students yet. Send your invite link from the Gym tab, or tap + Add for someone who isn't on the app.</div>`}</div></section>`;
}
async function studentSheet(id){
  S.ui.sheet={k:"student",id};S.ui.stack=[];openSheet(`${sheetHead("Student")}<div class="empty">Loading…</div>`);
  let j;try{j=await api("GET",`/coach/students/${id}`)}catch(e){toast(e.message);hideSheet();render();return}
  let claim=null;if(j.student.offline){try{claim=(await api("POST",`/coach/students/${id}/claim-link`)).url}catch(e){}}
  const s=j.student,g=goalOf(s),ar=areasFor(s.mastery,g),cur=COACH.roster.currency;
  const stuck=Object.entries(s.stuck||{}).filter(([k])=>POS[k]).sort((a,b)=>b[1]-a[1]).slice(0,3),tapped=Object.entries(s.tapped||{}).filter(([k])=>TM[k]).sort((a,b)=>b[1]-a[1]).slice(0,3);
  openSheet(`${sheetHead("Student")}<div class="stack-lg"><div><h1>${esc(s.name)}</h1><p class="muted small">${esc(s.email)}${s.offline?`${s.email?" · ":""}<span class="pill">Not on the app</span>`:""}</p></div>
    ${s.offline?`<section class="panel stack"><p class="small">${esc(first(s.name))} isn't on the app yet. Their invite link signs them straight into this record, so their plan, payments and classes carry over.</p>${claim?`<div class="row">${s.phone?waBtn(`Hi ${first(s.name)}, join ${gymName()} on JitsFlow to book classes, see your membership and pay your fees: ${claim}`,"Invite on WhatsApp",{phone:s.phone,kind:"claim_invite"}):""}<input id="claim-url" value="${esc(claim)}" hidden><button class="btn" data-a="copytext" data-v="claim-url">Copy invite link</button></div>`:""}<button class="linkbtn small" style="color:var(--ink-2);justify-self:start" data-a="studelask" data-v="${s.id}">Remove ${esc(first(s.name))}</button></section>`:""}
    <section class="beltwrap"><div class="row between"><div><div class="bignum mono">${readinessFor(s.mastery,g)}%</div><p class="muted small">Ready for ${BELT[g].to} belt</p></div>${beltChip(s.belt,s.stripes)}</div>
      <div class="areas">${ar.map(x=>`<div class="area"><span>${esc(x.n)}</span><span class="track"><span class="fill" style="width:${x.pct}%"></span></span><span class="mono">${x.pct}%</span></div>`).join("")}</div>
      <p class="small muted">${s.visits?`${s.visits.d28} classes in the last 4 weeks (${s.visits.p28} the 4 before)${s.visits.streak>1?`, ${s.visits.streak}-week streak`:""}${s.visits.last?`, last trained ${esc(fmtDate(s.visits.last.slice(0,10)))}`:""}. ${s.visits.sinceRank} classes since their last promotion. `:""}${s.n30} sessions logged in 30 days.${stuck.length?" Stuck in: "+stuck.map(([k,n])=>esc(POS[k].l)+" ×"+n).join(", ")+".":""}${tapped.length?" Tapped by: "+tapped.map(([k,n])=>esc(TM[k].n)+" ×"+n).join(", ")+".":""}</p></section>
    <form id="studentform" class="stack"><h2 class="label">Rank, fee and notes</h2>
      <div class="grid2"><label class="f">Belt<select id="s-belt" name="belt">${["white","blue","purple","brown","black"].map(b=>`<option value="${b}"${s.belt===b?" selected":""}>${b[0].toUpperCase()+b.slice(1)}</option>`).join("")}</select></label>
      <label class="f">Stripes<select id="s-stripes" name="stripes">${[0,1,2,3,4].map(n=>`<option${s.stripes===n?" selected":""}>${n}</option>`).join("")}</select></label></div>
      <h2 class="label">Membership</h2>
      <div class="grid2"><label class="f">Plan<select id="s-plan" name="plan"><option value="">No plan</option>${(COACH.roster.plans||[]).map(p=>`<option value="${p.id}"${s.planId===p.id?" selected":""}>${esc(p.name)} · ${money(p.priceCents,cur)}</option>`).join("")}</select></label>
      <label class="f">Status<select id="s-status" name="pstatus">${["active","trial","paused","cancelled"].map(x=>`<option value="${x}"${(s.planStatus||"active")===x?" selected":""}>${cap1(x)}</option>`).join("")}</select></label></div>
      <label class="f">Started<input id="s-started" name="pstarted" type="date" value="${esc(s.planStarted||"")}"></label>
      <label class="f">Monthly fee override (${esc(cur)})<input id="s-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="${s.feeOverride!=null?s.feeOverride/100:""}" placeholder="${(s.feeCents||0)/100} from plan or gym fee"></label>
      <div class="row" style="flex-wrap:nowrap;align-items:flex-end"><label class="f" style="flex:1">WhatsApp number<input id="s-phone" name="phone" type="tel" inputmode="tel" value="${esc(s.phone||"")}" placeholder="e.g. 082 123 4567"></label>${s.phone?waBtn(`Hi ${first(s.name)}, `,"Message",{phone:s.phone,kind:"student"}):""}</div>
      <label class="f"><span class="row between" style="flex-wrap:nowrap">Coach notes (only coaches see these)${micBtn("s-notes")}</span><textarea id="s-notes" name="notes">${esc(s.notes||"")}</textarea></label>
      <label class="row small"><input id="s-active" name="active" type="checkbox" style="width:auto"${s.active?" checked":""}> Active student</label></form>
    <section class="stack"><div class="row between"><h2 class="label">Payments</h2><button class="btn" data-a="paynew" data-v="${s.id}">Record payment</button></div>
      ${j.payments.length?`<div class="list">${j.payments.map(p=>`<div class="sess"><div class="row between"><b>${money(p.amountCents,p.currency)}</b><span class="small muted">${esc(fmtDate(p.paidOn))}</span></div>${p.reference?`<span class="small muted">${esc(p.reference)}</span>`:""}</div>`).join("")}</div>`:`<div class="empty">No payments recorded.</div>`}</section>
    ${(j.classes||[]).length?`<section class="stack"><h2 class="label">Recent classes</h2><div class="list">${j.classes.slice(0,8).map(x=>`<div class="row between" style="border-top:1px solid var(--line);padding-block:6px"><span>${x.kind==="private"?"🔒 ":""}${esc(x.title)}</span><span class="small muted">${esc(fmtWhen(x.startsAt))}${x.attended?" · ✓":""}</span></div>`).join("")}</div></section>`:""}
    <section class="stack"><h2 class="label">Recent sessions</h2>${j.logs.length?j.logs.slice(0,8).map(l=>`<div class="sess"><b>${esc(fmtDate(l.date))} · ${esc(l.type||"Class")}</b><span class="small muted">${Number(l.mins)||0} min · ${Number(l.rolls)||0} rolls${(l.tapped||[]).filter(i=>TM[i]).length?" · tapped by "+l.tapped.filter(i=>TM[i]).map(i=>esc(TM[i].n)).join(", "):""}</span>${l.fix?`<span class="small">Fix: ${esc(l.fix)}</span>`:""}</div>`).join(""):`<div class="empty">No sessions logged yet.</div>`}</section>
  </div>`,false,{act:`<button class="btn primary grow" type="submit" form="studentform">Save</button>`});
}
async function submitStudent(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value;const id=S.ui.sheet.id;
  try{await api("PATCH",`/coach/students/${id}`,{belt:v("belt"),stripes:Number(v("stripes")),feeCents:v("fee")===""?null:Math.round(Number(v("fee"))*100),notes:v("notes"),phone:v("phone")||"",active:form.querySelector("[name=active]").checked,planId:v("plan")||null,planStatus:v("pstatus")||"active",planStarted:v("pstarted")||null});
    toast("Student saved.");hideSheet();await coachLoad("roster");coachGo("students")}catch(e){toast(e.message)}}
/* ----- money: proof of payment, EFT details, recording ----- */
const PMETH={eft:"EFT",cash:"Cash",card:"Card",snapscan:"SnapScan",payfast:"PayFast",other:"Other"};
const PSRC={student:"Sent by the student in the app",email:"Forwarded email",upload:"You uploaded it",manual:"Recorded by hand"};
// Big phone photos are shrunk to a JPEG before upload (this also turns iPhone HEIC photos into something every browser and Claude can read).
async function fileToProof(file){
  if(file.size>12*1024*1024)throw new Error("That file is too big. Send a screenshot of the payment instead.");
  const isPdf=file.type==="application/pdf"||/\.pdf$/i.test(file.name);
  if(!isPdf&&(file.size>1.5*1024*1024||!/^image\/(jpeg|png|webp|gif)$/.test(file.type))){
    try{const url=URL.createObjectURL(file);const img=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=url});
      const k=Math.min(1,2000/Math.max(img.naturalWidth,img.naturalHeight)),c=document.createElement("canvas");c.width=Math.round(img.naturalWidth*k);c.height=Math.round(img.naturalHeight*k);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);const d=c.toDataURL("image/jpeg",.85);return {name:file.name.replace(/\.\w+$/,"")+".jpg",data:d.split(",")[1]}}catch(e){}}
  const d=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=()=>no(new Error("Couldn't read that file."));r.readAsDataURL(file)});
  return {name:file.name,data:String(d).split(",")[1]}}
function proofLine(p){const r=p.read,cur=p.currency;if(!r)return "";if(r.reading)return `<span class="small muted">Reading the proof…</span>`;
  const bits=[r.amountCents?money(r.amountCents,cur):"",r.date?esc(fmtDate(r.date)):"",r.reference?`ref ${esc(r.reference)}`:"",r.payer?`from ${esc(r.payer)}`:"",r.bank?esc(r.bank):""].filter(Boolean);
  return bits.length?`<span class="small">Proof says: ${bits.join(" · ")}</span>`:r.error?`<span class="small muted">${esc(r.error)} Open it and fill in the amount.</span>`:""}
function proofFlags(p){const r=p.read||{},f=[];if(r.duplicateOf)f.push("Looks like a payment you already have");if(r.isPayment===false)f.push("Doesn't look like a proof of payment");
  if(r.amountCents&&p.amountCents&&r.amountCents!==p.amountCents)f.push(`Proof shows ${money(r.amountCents,p.currency)}`);if(r.match==="name")f.push("Matched by name: check it's the right person");if(r.otherRef)f.push(`Reference ${r.otherRef} is another student's`);if(r.match==="several names")f.push("More than one student could match");
  return f.map(x=>`<span class="pill due">${esc(x)}</span>`).join("")}
function popCard(p,byId){const who=p.userId?(byId[p.userId]||{}).name||"Former student":null,fl=proofFlags(p);
  return `<div class="panel stack popcard" data-pop="${p.id}"><div class="row between" style="flex-wrap:nowrap"><b class="mono">${p.amountCents?money(p.amountCents,p.currency):"Amount?"}</b><span class="small muted">${esc(fmtDate(p.paidOn))}</span></div>
    <div><b>${who?esc(who):`<span class="warn-t">Which student?</span>`}</b><br><span class="small muted">${esc(PSRC[p.source]||"")}${p.source==="email"&&p.emailFrom?`: ${esc(p.emailFrom)}`:""}</span></div>
    ${proofLine(p)}${fl?`<div class="row" style="gap:6px">${fl}</div>`:""}
    <div class="row">${p.hasProof?`<a class="btn sm" href="/api/payments/${p.id}/proof" target="_blank" rel="noopener">View proof</a>`:""}<button class="btn sm" data-a="popcheck" data-v="${p.id}">Check &amp; edit</button>${p.userId&&p.amountCents&&!(p.read||{}).duplicateOf?`<button class="btn sm primary" data-a="popok" data-v="${p.id}">Confirm</button>`:""}</div></div>`}
function bankRows(b){return [["Account holder",b.holder],["Bank",b.bank],["Account number",b.account,1],["Branch code",b.branch,1],["Account type",b.type]].filter(r=>r[1])
  .map(([k,v,c])=>`<div class="kv"><span class="small muted">${k}</span><span class="mono">${esc(v)}</span>${c?`<button class="linkbtn small" data-a="copy" data-v="${esc(String(v).replace(/\s/g,""))}">Copy</button>`:"<span></span>"}</div>`).join("")}
function coachPayments(){
  const ps=COACH.payments||[],cur=COACH.roster.currency,ppl=students(),byId=Object.fromEntries((COACH.roster.people||[]).map(p=>[p.id,p]));
  if(COACH.payInfo===undefined){COACH.payInfo=null;api("GET","/coach/gym/pay").then(j=>{COACH.payInfo=j;if(S.ui.tab==="coach")render()}).catch(()=>{})}
  const pi=COACH.payInfo,bank=(pi&&pi.pay)||{},ok=ps.filter(p=>p.status==="confirmed"),pend=ps.filter(p=>p.status==="pending");
  const mStart=new Date();mStart.setDate(1);const mk=ds(mStart);const month=ok.filter(p=>p.paidOn>=mk);
  const due=ppl.filter(p=>p.active&&p.feeCents>0&&p.paidThisMonthCents<p.feeCents),unmatched=ok.filter(p=>!p.userId),og=S.ui.openG||{};
  return `<section class="stack"><div class="stats"><div class="stat"><b>${money(month.reduce((s,p)=>s+p.amountCents,0),cur)}</b><span>This month</span></div><div class="stat"><b>${ppl.filter(p=>p.active&&p.feeCents>0).length-due.length}</b><span>Paid</span></div><div class="stat"><b>${due.length}</b><span>Due</span></div></div>
    ${pend.length?`<h2 class="label">To check (${pend.length})</h2><div class="stack">${pend.map(p=>popCard(p,byId)).join("")}</div>`:""}
    <div class="grid2"><label class="btn primary" for="pop-up" style="cursor:pointer">Upload proof</label><button class="btn" data-a="paynew">Record a payment</button></div>
    <input type="file" id="pop-up" accept="image/*,application/pdf" hidden>
    <p class="small muted" style="margin-top:-6px">Upload a PDF or screenshot someone sent you. JitsFlow reads the amount, date and reference and finds the student; you confirm.</p>
    ${unmatched.length?`<h2 class="label">Not matched to a student (${unmatched.length})</h2><div class="list">${unmatched.map(p=>`<div class="sess"><div class="row between"><b>${money(p.amountCents,p.currency)}</b><span class="small muted">${esc(fmtDate(p.paidOn))}</span></div><span class="small muted">${esc(p.reference||p.emailSubject||"")}</span><select data-assign="${p.id}" aria-label="Assign to a student"><option value="">Assign to…</option>${ppl.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div>`).join("")}</div>`:""}
    ${due.length?`<h2 class="label">Due this month</h2><div class="list">${due.map(p=>`<button class="trow" data-a="student" data-v="${p.id}" style="grid-template-columns:minmax(0,1fr) auto"><span><span class="nm">${esc(p.name)}</span><span class="meta">${money(p.paidThisMonthCents,cur)} of ${money(p.feeCents,cur)} paid${p.pendingThisMonthCents?` · ${money(p.pendingThisMonthCents,cur)} to check`:""}</span></span><span class="pill due">${p.pendingThisMonthCents?"Checking":"Due"}</span></button>`).join("")}</div>`:""}
    <h2 class="label">Recent payments</h2>${ok.filter(p=>p.userId).length?`<div class="list">${ok.filter(p=>p.userId).slice(0,40).map(p=>swipeWrap(`<div class="sess"><div class="row between"><b>${esc((byId[p.userId]||{}).name||"Former student")}</b><b class="mono">${money(p.amountCents,p.currency)}</b></div><span class="small muted">${esc(fmtDate(p.paidOn))}${p.method?" · "+esc(PMETH[p.method]||p.method):""}${p.reference?" · "+esc(p.reference):""}${p.source==="email"?" · from email":p.source==="student"?" · sent in the app":""}${p.hasProof?` · <a href="/api/payments/${p.id}/proof" target="_blank" rel="noopener">proof</a>`:""}</span></div>`,{del:["paydelask",p.id]})).join("")}</div>`:`<div class="empty">No payments recorded yet.</div>`}</section>`;
}
function moneySetup(){const pi=COACH.payInfo,bank=(pi&&pi.pay)||{},og=S.ui.openG||{};
  if(COACH.payInfo===undefined){COACH.payInfo=null;api("GET","/coach/gym/pay").then(j=>{COACH.payInfo=j;if(S.ui.tab==="coach")render()}).catch(()=>{})}
  return `<section class="stack">
    <details class="more" data-g="m-bank"${pi&&!bank.account&&!bank.link&&og["m-bank"]!==false||og["m-bank"]?" open":""}><summary><span><b>How students pay</b><br><span class="small muted">${bank.account?`${esc(bank.bank||"Bank")} · ${esc(bank.account)}`:bank.link?"Payment link":"Add your bank details"}</span></span><span class="chev" aria-hidden="true">›</span></summary><div class="body stack">
      <p class="small">Students see these details in their Classes tab with their own reference (like JF7KQ3M), so every EFT tells you who paid.</p>
      <form id="bankform" class="stack" novalidate>
        <div class="grid2"><label class="f">Account holder<input name="holder" value="${esc(bank.holder||API.me.gym.name)}"></label><label class="f">Bank<input name="bank" value="${esc(bank.bank||"")}" placeholder="FNB, Capitec…"></label></div>
        <div class="grid2"><label class="f">Account number<input name="account" inputmode="numeric" value="${esc(bank.account||"")}"></label><label class="f">Branch code<input name="branch" inputmode="numeric" value="${esc(bank.branch||"")}"></label></div>
        <div class="grid2"><label class="f">Account type<select name="type">${["","Cheque","Current","Savings","Business"].map(t=>`<option${t===(bank.type||"")?" selected":""}>${t}</option>`).join("")}</select></label><label class="f">Pay link (optional)<input name="link" type="url" value="${esc(bank.link||"")}" placeholder="https://pay.yoco.com/…"></label></div>
        <label class="f">Fees are due on<select name="dueDay">${Array.from({length:28},(_,i)=>i+1).map(d=>`<option value="${d}"${d===(bank.dueDay||1)?" selected":""}>the ${d}${d===1||d===21?"st":d===2||d===22?"nd":d===3||d===23?"rd":"th"} of the month</option>`).join("")}</select></label>
        <label class="f">Note for students (optional)<input name="note" value="${esc(bank.note||"")}" placeholder="Fees are due by the 3rd of each month"></label>
        <button class="btn" type="submit">Save payment details</button></form></div></details>
    <details class="more" data-g="m-mail"${og["m-mail"]?" open":""}><summary><span><b>Forward proof-of-payment emails</b><br><span class="small muted">A Gmail or Outlook rule to your JitsFlow address</span></span><span class="chev" aria-hidden="true">›</span></summary><div class="body stack">
      ${pi?`${pi.popReady?"":`<p class="small warn-t">Email forwarding is being switched on. You can set up the rule now; emails are read once it's live.</p>`}
      <div class="codebox" style="word-break:break-all">${esc(pi.popAddress)}</div><input id="pop-addr" value="${esc(pi.popAddress)}" hidden><div class="row"><button class="btn sm" data-a="copytext" data-v="pop-addr">Copy address</button><button class="linkbtn small" data-a="popnewaddr">Get a new address</button></div>
      ${pi.popNotice&&pi.popNotice.code?`<div class="insight good"><b>Gmail confirmation code: <span class="mono">${esc(pi.popNotice.code)}</span></b><br><span class="small">Enter it in Gmail › Settings › Forwarding${pi.popNotice.from?` for ${esc(pi.popNotice.from)}`:""} to finish.</span></div>`:""}
      <ol class="small steps qrsteps"><li><span><b>Gmail:</b> Settings › Forwarding › Add a forwarding address, and paste the address above. Gmail sends a code, which appears here within a minute.</span></li>
      <li><span>Then make a filter for your proof-of-payment emails (for example from your bank's notification address, or containing "proof of payment") and choose <i>Forward it to</i> this address.</span></li>
      <li><span><b>Outlook:</b> Settings › Mail › Rules › Add a rule › <i>Forward to</i> this address.</span></li>
      <li><span>Each email shows up under <b>To check</b> with the amount and student filled in. Nothing counts as paid until you confirm it.</span></li></ol>
      <p class="small muted">Keep this address private: anyone who has it can send proofs to your list (you still check each one).</p>`:`<p class="small muted">Loading…</p>`}</div></details>
  </section>`}
async function saveBank(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  try{const j=await api("PATCH","/coach/gym/pay",{holder:v("holder"),bank:v("bank"),account:v("account"),branch:v("branch"),type:v("type"),link:v("link"),note:v("note"),dueDay:Number(v("dueDay")||1)});COACH.money=null;COACH.payInfo={...(COACH.payInfo||{}),pay:j.pay};S.ui.openG={...(S.ui.openG||{}),"m-bank":false};render();toast("Payment details saved. Students see them in their Classes tab.")}catch(e){toast(e.message)}}
async function coachProof(file){toast("Reading the proof…");
  try{const f=await fileToProof(file);const j=await api("POST","/coach/payments/proof",f);await coachLoad("payments");const p=j.payment,who=p.userId&&(students().find(s=>s.id===p.userId)||{}).name;
    popSheet(p.id);toast(p.amountCents?`Read ${money(p.amountCents,p.currency)}${who?` from ${who}`:""}. Check it and confirm.`:"Added. Fill in the amount and confirm.")}catch(e){toast(e.message)}}
function popSheet(id){const p=(COACH.payments||[]).find(x=>x.id===id);if(!p)return;const ppl=students(),cur=COACH.roster.currency,fl=proofFlags(p);S.ui.sheet={k:"pop",id};S.ui.stack=[];
  openSheet(`${sheetHead("Check payment")}<form id="popform" class="stack-lg" novalidate><input type="hidden" name="id" value="${p.id}">
    ${proofLine(p)?`<div class="stack" style="gap:4px">${proofLine(p)}${fl?`<div class="row" style="gap:6px">${fl}</div>`:""}</div>`:""}
    ${p.hasProof?`<a class="btn" href="/api/payments/${p.id}/proof" target="_blank" rel="noopener">View the proof</a>`:""}
    <label class="f">Student<select name="user"><option value="">Pick the student</option>${ppl.map(s=>`<option value="${s.id}"${s.id===p.userId?" selected":""}>${esc(s.name)}</option>`).join("")}</select></label>
    <div class="grid2"><label class="f">Amount (${esc(cur)})<input name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${p.amountCents?p.amountCents/100:""}"></label><label class="f">Date paid<input name="date" type="date" value="${esc(p.paidOn)}"></label></div>
    <div class="grid2"><label class="f">Method<select name="method">${Object.entries(PMETH).map(([k,l])=>`<option value="${k}"${k===(p.method||"eft")?" selected":""}>${l}</option>`).join("")}</select></label><label class="f">Reference<input name="ref" value="${esc(p.reference||"")}"></label></div>
    <label class="f">Note<input name="note" value="${esc(p.note||"")}"></label></form>`,false,{act:`<button class="btn danger" data-a="poprej" data-v="${p.id}">Not a payment</button><button class="btn primary grow" type="submit" form="popform">Confirm payment</button>`})}
async function savePop(form,status){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  try{await api("PATCH",`/coach/payments/${v("id")}`,{userId:v("user")||null,amountCents:Math.round(Number(v("amount"))*100)||0,paidOn:v("date"),method:v("method"),reference:v("ref"),note:v("note"),status:status||"confirmed"});
    hideSheet();await coachLoad();toast(status==="rejected"?"Marked as not a payment.":"Payment confirmed.")}catch(e){toast(e.message)}}
async function popQuick(id,status){try{await api("PATCH",`/coach/payments/${id}`,{status});await coachLoad();toast(status==="confirmed"?"Payment confirmed.":"Marked as not a payment.")}catch(e){toast(e.message)}}

/* ----- students: fees and paying by EFT ----- */
async function loadPay(){if(!API.me||!API.me.gym||isCoach())return;try{API.pay=(await api("GET","/me/pay")).pay}catch(e){}}
const PSTAT={pending:["Checking","due"],confirmed:["Received","ok"],rejected:["Not accepted",""]};
function feesCard(){const p=API.pay;if(!p)return "";const left=Math.max(0,p.dueCents-p.paidCents),cur=p.currency,b=p.bank||{},ready=!!(b.account||b.link);
  const mon=new Date().toLocaleDateString(undefined,{month:"long"});
  const state=!p.dueCents?"":left<=0?`<span class="pill ok">Paid</span>`:p.pendingCents?`<span class="pill due">Checking</span>`:`<span class="pill due">${money(left,cur)} due</span>`;
  return `<section class="panel stack feecard"><div class="row between"><h2 class="label">Fees · ${esc(mon)}</h2>${state}</div>
    <p class="small">${p.dueCents?`${money(p.paidCents,cur)} of ${money(p.dueCents,cur)} paid${p.pendingCents?`, ${money(p.pendingCents,cur)} being checked by your coach`:""}.`:"Your coach hasn't set a fee for you."} Your payment reference: <b class="mono">${esc(p.reference)}</b></p>
    <button class="btn${left>0&&!p.pendingCents?" primary":""}" data-a="mypay">${ready?"How to pay":"Send proof of payment"}</button></section>`}
function myPaySheet(){const p=API.pay;if(!p)return;const b=p.bank||{},cur=p.currency,left=Math.max(0,p.dueCents-p.paidCents-p.pendingCents);S.ui.sheet={k:"mypay"};S.ui.stack=[];
  openSheet(`${sheetHead("Pay your fees")}<div class="stack-lg">
    ${b.account?`<section class="stack"><h2 class="label">Pay by EFT</h2><div class="panel stack" style="gap:8px">${bankRows(b)}
      <div class="kv refrow"><span class="small muted">Reference</span><b class="mono">${esc(p.reference)}</b><button class="linkbtn small" data-a="copy" data-v="${esc(p.reference)}">Copy</button></div></div>
      <p class="small">Always use <b class="mono">${esc(p.reference)}</b> as the reference. It tells your coach the payment is yours.${left?` Amount: <b>${money(left,cur)}</b>.`:""}</p></section>`:""}
    ${b.link?`<a class="btn${b.account?"":" primary"}" href="${esc(b.link)}" target="_blank" rel="noopener">Pay online</a>`:""}
    ${!b.account&&!b.link?`<p class="small">Your coach hasn't added payment details yet. Ask them how to pay, then send your proof of payment here. Your reference is <b class="mono">${esc(p.reference)}</b>.</p>`:""}
    ${b.note?`<p class="small muted">${esc(b.note)}</p>`:""}
    <section class="stack"><h2 class="label">Already paid?</h2><p class="small">Send the proof of payment (the PDF from your bank, or a screenshot). Your coach checks it and marks you as paid.</p>
      <label class="f">Amount you paid (${esc(cur)})<input id="mypop-amt" type="number" inputmode="decimal" min="0" step="0.01" value="${left?left/100:""}"></label>
      <label class="btn primary" for="mypop" style="cursor:pointer">Choose the proof of payment</label><input type="file" id="mypop" accept="image/*,application/pdf" hidden></section>
    ${(p.payments||[]).length?`<section class="stack"><h2 class="label">Your payments</h2><div class="list">${p.payments.map(x=>{const st=PSTAT[x.status]||["",""];return `<div class="sess"><div class="row between"><b class="mono">${x.amountCents?money(x.amountCents,x.currency):"Amount being checked"}</b><span class="pill ${st[1]}">${st[0]}</span></div><span class="small muted">${esc(fmtDate(x.paidOn))}${x.method?" · "+esc(PMETH[x.method]||x.method):""}${x.hasProof?` · <a href="/api/payments/${x.id}/proof" target="_blank" rel="noopener">proof</a>`:""}</span></div>`}).join("")}</div></section>`:""}
  </div>`)}
async function sendMyProof(file){const amt=Number((document.getElementById("mypop-amt")||{}).value||0);toast("Sending…");
  try{const f=await fileToProof(file);await api("POST","/me/pay/proof",{...f,amountCents:Math.round(amt*100)||0});await loadPay();myPaySheet();toast("Sent. Your coach will check it and mark you as paid.");jfTrack("pop_sent",{})}catch(e){toast(e.message)}}
function paySheet(forId){
  const ppl=students(),cur=COACH.roster.currency;S.ui.sheet={k:"pay",back:forId};S.ui.stack=[];
  openSheet(`${sheetHead("Record a payment")}<form id="payform" class="stack-lg" novalidate>
    <label class="f">Student<select id="p-user" name="user"><option value="">Not sure yet</option>${ppl.map(s=>`<option value="${s.id}"${s.id===forId?" selected":""}>${esc(s.name)}</option>`).join("")}</select></label>
    <div class="grid2"><label class="f">Amount (${esc(cur)})<input id="p-amt" name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${forId?((ppl.find(s=>s.id===forId)||{}).feeCents||0)/100:""}"></label><label class="f">Date paid<input id="p-date" name="date" type="date" value="${today()}"></label></div>
    <div class="grid2"><label class="f">Method<select id="p-method" name="method">${Object.entries(PMETH).filter(([k])=>k!=="payfast").map(([k,l])=>`<option value="${k}">${l}</option>`).join("")}</select></label><label class="f">Reference<input id="p-ref" name="ref" placeholder="e.g. CHRIS NOV"></label></div>
    <label class="f">Note<input id="p-note" name="note"></label></form>`,false,{act:`<button class="btn primary grow" type="submit" form="payform">Record payment</button>`});
}
async function submitPay(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  try{await api("POST","/coach/payments",{userId:v("user")||null,amountCents:Math.round(Number(v("amount"))*100),paidOn:v("date"),method:v("method"),reference:v("ref"),note:v("note")});
    toast("Payment recorded.");hideSheet();await coachLoad();coachGo("money")}catch(e){toast(e.message)}}
function coachGym(){const g=API.me.gym;
  return `<section class="stack">${impBanner()}${waPanel()}${gymCard(true)}${lookPanel()}
    <div class="panel stack"><h2 class="label">Bookings</h2><label class="row small" style="flex-wrap:nowrap"><input id="g-show" type="checkbox" style="width:auto"${g.showAttendees!==false?" checked":""}> Students can see who else has booked a class (first name, last initial and belt). Private lessons are never shown.</label>
      <label class="row small" style="flex-wrap:nowrap"><input id="g-invite" type="checkbox" style="width:auto"${g.studentsInvite!==false?" checked":""}> Students can invite friends to the gym (they get the student invite link to share; never the coach link).</label>
      <form id="gwaform" class="stack" style="gap:6px" novalidate><label class="f">WhatsApp number for lesson requests<span class="row" style="flex-wrap:nowrap"><input id="g-wa" name="wa" type="tel" inputmode="tel" placeholder="082 123 4567" value="${esc(g.waPhoneSet||API.me.phone||"")}" style="flex:1"><button class="btn" type="submit">Save</button></span></label>
        <span class="small muted">${g.waPhoneSet?"Students' \"Ask for a time\" button opens a chat with this number.":"Not saved yet: students' \"Ask for a time\" button opens WhatsApp without a contact until you save one."}</span></form></div>
    ${gymImportPanel()}${gymClassesPanel()}<div class="panel"><h2 class="label">Invite students</h2><p class="small">Send this link. It opens JitsFlow with your gym code filled in.</p><div class="codebox mono">${esc(joinURL(g.studentCode))}</div>
      <div class="row"><button class="btn primary" data-a="copy" data-v="${esc(joinURL(g.studentCode))}">Copy invite link</button><span class="small muted">Code: <b class="mono">${esc(g.studentCode)}</b></span></div></div>
    ${API.status.mail?`<form id="inviteform" class="panel stack"><h2 class="label">Invite by email</h2><p class="small">Paste your students' emails (one per line or separated by commas). Each gets an email with your invite link.</p><textarea id="inv-emails" name="emails" rows="3" placeholder="sam@example.com, lee@example.com" autocapitalize="none" inputmode="email"></textarea><button class="btn" type="submit">Send invites</button></form>`:""}
    <div class="panel"><h2 class="label">Add another coach</h2><p class="small">Only share this with coaches: it gives access to the roster and payments.</p><div class="row"><span class="mono"><b>${esc(g.coachCode)}</b></span><button class="btn" data-a="copy" data-v="${esc(joinURL(g.coachCode))}">Copy coach link</button></div></div>
    <form id="gymform" class="panel stack"><h2 class="label">Gym details</h2><label class="f">Gym name<input id="g-name" name="name" value="${esc(g.name)}"></label>
      <label class="f">Standard monthly fee (${esc(g.currency||"ZAR")})<input id="g-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="${(g.monthlyFeeCents||0)/100}"></label><button class="btn primary" type="submit">Save gym</button></form>
    <div class="row"><button class="btn" data-a="rotate" data-v="student">New student code</button><button class="btn" data-a="rotate" data-v="coach">New coach code</button></div>
    <p class="small muted">A new code stops the old link working. People already in your gym aren't affected.</p>
    ${accountSection()}${appearanceSection()}
    <section class="panel stack"><h2 class="label">Training yourself?</h2><p class="small">Belts, Flow map and Log are the study side of JitsFlow. Switch to them any time; a Coach button brings you back here.</p><button class="btn" data-a="coachmode" data-v="study">Open study tools</button></section></section>`}
async function sendInvites(form){const ta=form.querySelector("[name=emails]"),btn=form.querySelector("[type=submit]");btn.disabled=true;btn.textContent="Sending…";
  try{const j=await api("POST","/coach/invite",{emails:ta.value});ta.value="";if(j.sent)jfTrack("share",{method:"email",content_type:"gym_invite",count:j.sent});
    toast(`Sent ${j.sent} invite${j.sent===1?"":"s"}.${j.already.length?` ${j.already.length} already in your gym.`:""}${j.failed.length?` Couldn't send to ${j.failed.join(", ")}.`:""}`)}
  catch(e){toast(e.message)}btn.disabled=false;btn.textContent="Send invites"}
async function copyText(t){if(/[?&]join=/.test(t))jfTrack("share",{method:"copy",content_type:"gym_invite"});try{await navigator.clipboard.writeText(t);toast("Copied.")}catch(e){toast(t)}}

/* ----- gym profile: import from the gym's website, timetable, coaches, rates ----- */
const GYM={data:null,at:0,loading:false};
const TTD=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],TTDL=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const PERL={month:"/ month",week:"/ week",class:"/ class",year:"/ year",term:"/ term",once:"once-off",other:""};
const dayNow=()=>(new Date().getDay()+6)%7;
async function loadGym(force){if(!API.me||!API.me.gym||GYM.loading)return;if(!force&&GYM.data&&Date.now()-GYM.at<300000)return;
  GYM.loading=true;try{const j=await api("GET","/gym");GYM.data=j.gym;GYM.at=Date.now()}catch(e){}GYM.loading=false;if(["settings","coach","today"].includes(S.ui.tab)&&!S.ui.sheet)render()}
const gymProfile=()=>(GYM.data&&GYM.data.profile)||{};
const hasProfile=p=>!!(p&&((p.timetable||[]).length||(p.coaches||[]).length||(p.rates||[]).length||p.address||p.phone||p.email));
const priceTxt=(r,cur)=>{const c=r.currency||cur||"ZAR";try{return new Intl.NumberFormat("en-ZA",{style:"currency",currency:c,maximumFractionDigits:r.price%1?2:0}).format(r.price)}catch(e){return c+" "+r.price}};
function ttUpcoming(n){const tt=gymProfile().timetable||[];if(!tt.length)return [];const out=[],now=new Date();
  for(let k=0;k<8&&out.length<n;k++){const d=new Date(now);d.setDate(now.getDate()+k);const di=(d.getDay()+6)%7;
    tt.filter(r=>r.day===TTD[di]).forEach(r=>{const [h,m]=r.start.split(":").map(Number);const at=new Date(d);at.setHours(h,m,0,0);if(at>now)out.push({r,at,k})})}
  return out.sort((a,b)=>a.at-b.at).slice(0,n)}
function gymContact(p){const b=[];const L=(href,t)=>`<a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  if(p.phone)b.push(`<a class="btn" href="tel:${esc(p.phone.replace(/[^\d+]/g,""))}">Call</a>`);
  if(p.socials&&p.socials.whatsapp)b.push(L(p.socials.whatsapp,"WhatsApp"));
  if(p.email)b.push(`<a class="btn" href="mailto:${esc(p.email)}">Email</a>`);
  if(p.address)b.push(L("https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(p.address),"Directions"));
  if(p.socials&&p.socials.instagram)b.push(L(p.socials.instagram,"Instagram"));
  if(p.socials&&p.socials.facebook)b.push(L(p.socials.facebook,"Facebook"));
  if(p.website)b.push(L(p.website,"Website"));
  return b.length?`<div class="row gymlinks">${b.join("")}</div>`:""}
function gymTimetable(p){const tt=p.timetable||[];if(!tt.length)return "";const t=dayNow();
  return `<section class="stack"><h2 class="label">Weekly timetable</h2><div class="ttweek">${TTD.map((d,i)=>{const rows=tt.filter(r=>r.day===d);if(!rows.length)return "";
    return `<div class="ttday${i===t?" today":""}"><b>${TTDL[i]}${i===t?" · today":""}</b>${rows.map(r=>`<div class="ttline"><span class="mono">${esc(r.start)}${r.end?"–"+esc(r.end):""}</span><span>${esc(r.title)}${r.level?` <span class="muted small">· ${esc(r.level)}</span>`:""}${r.coach?`<br><span class="small muted">${esc(r.coach)}</span>`:""}</span></div>`).join("")}</div>`}).join("")}</div></section>`}
function gymCard(forCoach){
  if(inClaude()||!API.me||!API.me.gym)return "";
  if(!GYM.data){loadGym();return ""}
  const p=gymProfile(),g=API.me.gym,cur=g.currency;
  if(!hasProfile(p)&&!forCoach)return "";
  return `<section class="panel stack gymcard"><div class="gymhead">${g.logo?`<img src="${esc(g.logo)}" alt="" class="gymlogo">`:""}<div><h2 style="margin:0">${esc(g.name)}</h2>${p.tagline?`<p class="small muted">${esc(p.tagline)}</p>`:""}</div></div>
    ${p.address?`<p class="small">${esc(p.address)}</p>`:""}${gymContact(p)}
    ${gymTimetable(p)}
    ${(p.rates||[]).length?`<section class="stack"><h2 class="label">Rates</h2><div class="list">${p.rates.map(r=>`<div class="row between rate"><span><b>${esc(r.name)}</b>${r.note?`<br><span class="small muted">${esc(r.note)}</span>`:""}</span><span class="mono"><b>${esc(priceTxt(r,cur))}</b> <span class="small muted">${esc(PERL[r.period]||"")}</span></span></div>`).join("")}</div></section>`:""}
    ${(p.coaches||[]).length?`<section class="stack"><h2 class="label">Coaches</h2>${p.coaches.map(c=>`<div class="coachrow"><b>${esc(c.name)}</b>${c.rank?` <span class="small muted">· ${esc(c.rank)}</span>`:""}${c.bio?`<p class="small">${esc(c.bio)}</p>`:""}</div>`).join("")}</section>`:""}
    ${p.notes?`<p class="small">${esc(p.notes)}</p>`:""}
    ${forCoach&&!hasProfile(p)?`<p class="small muted">No timetable, rates or contact details yet. Import them from your website below, or add them by hand.</p>`:""}
    ${forCoach?`<div class="row"><button class="btn" data-a="gymedit">${hasProfile(p)?"Edit details":"Add details by hand"}</button></div>`:""}</section>`}
function gymImportPanel(){const p=gymProfile();
  return `<form id="gymimpform" class="panel stack"><h2 class="label">Import from your website</h2>
    <p class="small">Paste your gym's website. JitsFlow reads the public pages (home, timetable, prices, coaches, contact) and shows you what it found. Nothing is saved until you check it.</p>
    <div class="row" style="flex-wrap:nowrap"><input id="gi-url" name="url" type="text" inputmode="url" autocorrect="off" spellcheck="false" autocapitalize="none" autocomplete="url" placeholder="yourgym.co.za" value="${esc(p.website||"")}" style="flex:1" aria-label="Your gym's website"><button class="btn primary" type="submit">Import</button></div></form>`}
function gymClassesPanel(){const tt=gymProfile().timetable||[];if(!tt.length)return "";
  return `<div class="panel stack"><h2 class="label">Put the timetable in the calendar</h2><p class="small">Adds each class from your weekly timetable to Classes, so students can tap "I'm going" and you can plan them. Classes that are already there are skipped.</p>
    <div class="row" style="flex-wrap:nowrap"><select id="tt-weeks" aria-label="How many weeks" style="flex:1">${[1,2,4,8].map(n=>`<option value="${n}"${n===2?" selected":""}>Next ${n} week${n>1?"s":""}</option>`).join("")}</select><button class="btn primary" data-a="ttclasses">Add classes</button></div></div>`}
async function gymImport(form){const url=form.querySelector("[name=url]").value.trim();await impStart(url)}
function gymEditOpen(){const p=clone(gymProfile());p.name=p.name||API.me.gym.name;
  ["timetable","coaches","rates"].forEach(k=>p[k]=p[k]||[]);p.socials=p.socials||{};
  S.ui.gimp={profile:p,logos:[],logoPick:API.me.gym.logo?"keep":"none",imported:false};drawGymEdit()}
function drawGymEdit(keep){
  const G=S.ui.gimp,p=G.profile,cur=API.me.gym.currency||"ZAR";S.ui.sheet={k:"gymedit"};S.ui.stack=[];
  const sel=(name,opts,v)=>`<select name="${name}">${opts.map(([k,l])=>`<option value="${k}"${k===v?" selected":""}>${l}</option>`).join("")}</select>`;
  const x=(k,i)=>`<button type="button" class="btn ghost rm" data-a="germ" data-k="${k}" data-v="${i}" aria-label="Remove">✕</button>`;
  const logoOpts=[...G.logos.map((l,i)=>[String(i),`<img src="${l.dataUrl}" alt="Logo option ${i+1}">`]),...(API.me.gym.logo?[["keep",`<img src="${esc(API.me.gym.logo)}" alt="Current logo"><span class="small">Keep current</span>`]]:[]),["none",`<span class="small">No logo</span>`]];
  const soc=p.socials||{};
  openSheet(`${sheetHead(G.imported?"Check what we found":"Gym details")}<form id="gymeditform" class="stack-lg" novalidate>
    ${G.imported?`<div class="panel ${G.method==="claude"?"":"accent"}"><p class="small"><b>Read ${G.pages.length} page${G.pages.length===1?"":"s"} of your site</b>: ${G.pages.slice(0,6).map(x=>esc((x.title||x.url).split(/\s+[|–—-]\s+/)[0])).join(" · ")}${G.pages.length>6?` and ${G.pages.length-6} more`:""}</p>
      ${G.dropped&&(G.dropped.timetable||G.dropped.rates||G.dropped.coaches)?`<p class="small"><b>Left out ${[G.dropped.timetable?G.dropped.timetable+" class time"+(G.dropped.timetable>1?"s":""):"",G.dropped.rates?G.dropped.rates+" price"+(G.dropped.rates>1?"s":""):"",G.dropped.coaches?G.dropped.coaches+" coach"+(G.dropped.coaches>1?"es":""):""].filter(Boolean).join(", ")}</b> that we couldn't find written on your site. Add the real ones below.</p>`:""}
      ${G.method==="claude"&&!p.timetable.length?`<p class="small">No class times are written on your site${G.pages.length?"":" pages we could read"}. If your timetable is an image or on another site, add the times below.</p>`:""}
      <p class="small muted">${G.method==="claude"?"Read with Claude. Check the times and prices: anything wrong here is what your students will see.":"Basic read: timetables in grids or images, and price cards, are often missed. Check each section and fill in the gaps."}</p></div>`:""}
    <section class="stack"><h2 class="label">Logo</h2><div class="logopick">${logoOpts.map(([k,h])=>`<label class="logoopt"><input type="radio" name="logo" value="${k}"${G.logoPick===k?" checked":""}>${h}</label>`).join("")}</div></section>
    <section class="stack"><h2 class="label">Basics</h2>
      <label class="f">Gym name<input name="name" value="${esc(p.name)}"></label>
      <label class="f">Short description<textarea name="tagline" rows="2">${esc(p.tagline||"")}</textarea></label>
      <label class="f">Address<input name="address" value="${esc(p.address||"")}" autocomplete="street-address"></label>
      <div class="grid2"><label class="f">Phone<input name="phone" type="tel" value="${esc(p.phone||"")}"></label><label class="f">Email<input name="email" type="email" value="${esc(p.email||"")}"></label></div>
      <label class="f">Website<input name="website" type="url" value="${esc(p.website||"")}"></label>
      <div class="grid2">${[["instagram","Instagram"],["facebook","Facebook"],["whatsapp","WhatsApp link"],["youtube","YouTube"]].map(([k,l])=>`<label class="f">${l}<input name="soc-${k}" type="url" value="${esc(soc[k]||"")}" placeholder="https://"></label>`).join("")}</div></section>
    <section class="stack"><div class="row between"><h2 class="label">Weekly timetable (${p.timetable.length})</h2></div>
      ${p.timetable.map((r,i)=>`<div class="edrow tt"><div class="grid3">${sel(`tt-day-${i}`,TTD.map(d=>[d,d]),r.day)}<input name="tt-start-${i}" type="time" value="${esc(r.start)}" aria-label="Starts"><input name="tt-end-${i}" type="time" value="${esc(r.end||"")}" aria-label="Ends"></div>
        <div class="row" style="flex-wrap:nowrap"><input name="tt-title-${i}" value="${esc(r.title)}" placeholder="Class" aria-label="Class" style="flex:2"><input name="tt-coach-${i}" value="${esc(r.coach||"")}" placeholder="Coach" aria-label="Coach" style="flex:1">${x("timetable",i)}</div>
        <input type="hidden" name="tt-level-${i}" value="${esc(r.level||"")}"></div>`).join("")||`<p class="small muted">No class times found.</p>`}
      <button type="button" class="btn" data-a="geadd" data-v="timetable">+ Add a class time</button></section>
    <section class="stack"><h2 class="label">Rates (${p.rates.length})</h2>
      ${p.rates.map((r,i)=>`<div class="edrow"><div class="row" style="flex-wrap:nowrap"><input name="rt-name-${i}" value="${esc(r.name)}" placeholder="e.g. Adult unlimited" aria-label="Name" style="flex:1">${x("rates",i)}</div>
        <div class="grid2"><input name="rt-price-${i}" type="number" inputmode="decimal" min="0" step="0.01" value="${r.price}" aria-label="Price (${esc(r.currency||cur)})">${sel(`rt-period-${i}`,Object.keys(PERL).map(k=>[k,k==="once"?"Once-off":k==="other"?"Other":"Per "+k]),r.period)}</div>
        <input name="rt-note-${i}" value="${esc(r.note||"")}" placeholder="Note (optional)" aria-label="Note"><input type="hidden" name="rt-cur-${i}" value="${esc(r.currency||cur)}"></div>`).join("")||`<p class="small muted">No prices found.</p>`}
      <button type="button" class="btn" data-a="geadd" data-v="rates">+ Add a rate</button></section>
    <section class="stack"><h2 class="label">Coaches (${p.coaches.length})</h2>
      ${p.coaches.map((c,i)=>`<div class="edrow"><div class="row" style="flex-wrap:nowrap"><input name="co-name-${i}" value="${esc(c.name)}" placeholder="Name" aria-label="Name" style="flex:1">${x("coaches",i)}</div>
        <input name="co-rank-${i}" value="${esc(c.rank||"")}" placeholder="Rank or role, e.g. Black belt, head coach" aria-label="Rank"><textarea name="co-bio-${i}" rows="2" placeholder="Short bio (optional)" aria-label="Bio">${esc(c.bio||"")}</textarea></div>`).join("")||`<p class="small muted">No coaches found.</p>`}
      <button type="button" class="btn" data-a="geadd" data-v="coaches">+ Add a coach</button></section>
    <label class="f">Anything else students should know<textarea name="notes" rows="3" placeholder="Free trial, what to bring, kids' ages…">${esc(p.notes||"")}</textarea></label>
    <p class="small muted">Students in your gym see these details in the app. Coach notes and fees per student stay private.</p>
  </form>`,keep,{act:`<button class="btn primary grow" type="submit" form="gymeditform">Save to my gym</button>`});
}
function gimpRead(form){
  const G=S.ui.gimp,p=G.profile,v=n=>{const el=form.querySelector(`[name="${n}"]`);return el?el.value:""};
  ["name","tagline","address","phone","email","website","notes"].forEach(k=>p[k]=v(k).trim());
  p.socials={...(p.socials||{})};["instagram","facebook","whatsapp","youtube"].forEach(k=>{const s=v("soc-"+k).trim();if(s)p.socials[k]=s;else delete p.socials[k]});
  p.timetable=p.timetable.map((r,i)=>({day:v(`tt-day-${i}`),start:v(`tt-start-${i}`),end:v(`tt-end-${i}`),title:v(`tt-title-${i}`).trim(),coach:v(`tt-coach-${i}`).trim(),level:v(`tt-level-${i}`)}));
  p.rates=p.rates.map((r,i)=>({name:v(`rt-name-${i}`).trim(),price:Number(v(`rt-price-${i}`)),period:v(`rt-period-${i}`),note:v(`rt-note-${i}`).trim(),currency:v(`rt-cur-${i}`)}));
  p.coaches=p.coaches.map((c,i)=>({name:v(`co-name-${i}`).trim(),rank:v(`co-rank-${i}`).trim(),bio:v(`co-bio-${i}`).trim()}));
  const lp=form.querySelector("[name=logo]:checked");G.logoPick=lp?lp.value:G.logoPick;
}
function gimpChange(kind,i){const form=document.getElementById("gymeditform");if(!form)return;gimpRead(form);const p=S.ui.gimp.profile;
  if(i===null)p[kind].push(kind==="timetable"?{day:TTD[dayNow()],start:"18:00",end:"19:00",title:"",coach:"",level:""}:kind==="rates"?{name:"",price:"",period:"month",note:"",currency:API.me.gym.currency||"ZAR"}:{name:"",rank:"",bio:""});
  else p[kind].splice(i,1);
  drawGymEdit(true);
  if(i===null){const rows=document.querySelectorAll("#gymeditform .edrow");const last=[...rows].filter(r=>r.querySelector(`[name^="${kind==="timetable"?"tt":kind==="rates"?"rt":"co"}-"]`)).pop();if(last){last.scrollIntoView({block:"center"});const inp=last.querySelector(kind==="timetable"?"[name^=tt-title]":"input");if(inp)inp.focus()}}}
async function gymSave(form){
  gimpRead(form);const G=S.ui.gimp,p=G.profile;
  if(p.timetable.some(r=>!r.start)){toast("Each class time needs a start time.");return}
  const logoUrl=G.logoPick==="keep"?undefined:G.logoPick==="none"?null:(G.logos[Number(G.logoPick)]||{}).url;
  const btn=document.querySelector('#sheetbar [type=submit]');if(btn){btn.disabled=true;btn.textContent="Saving…"}
  const fromJob=S.ui.gimp&&S.ui.gimp.fromJob;
  try{const j=await api("PUT","/coach/gym/profile",{profile:p,logoUrl});API.me=j.me;S.ui.gimp=null;if(fromJob){COACH.imp=null;api("DELETE","/coach/import/job").catch(()=>{})}if(API.me.gym.logo&&!(API.me.gym.brand||{}).accent)setTimeout(()=>brandFromLogo(true),600);hideSheet();GYM.data=null;await loadGym(true);coachGo("gym");
    toast(j.logoNote||(j.feeSet?`Saved. Standard fee set to ${money(j.feeSet,API.me.gym.currency)} a month.`:"Saved. Your students can see these details now."))}
  catch(e){toast(e.message);if(btn){btn.disabled=false;btn.textContent="Save to my gym"}}
}
async function ttToClasses(weeks){
  const tt=gymProfile().timetable||[];if(!tt.length)return;const now=new Date(),out=[];
  for(let k=0;k<weeks*7;k++){const d=new Date(now);d.setDate(now.getDate()+k);const di=(d.getDay()+6)%7;
    tt.filter(r=>r.day===TTD[di]).forEach(r=>{const [h,m]=r.start.split(":").map(Number);const at=new Date(d);at.setHours(h,m,0,0);if(at<=now)return;
      let dur=60;if(r.end){const [eh,em]=r.end.split(":").map(Number);const x=(eh*60+em)-(h*60+m);if(x>=15)dur=x}
      out.push({title:r.title+(r.level&&!r.title.toLowerCase().includes(r.level.toLowerCase())?" ("+r.level+")":""),startsAt:at.toISOString(),durationMin:dur,shared:true,plan:{focus:"",notes:r.coach?"Coach: "+r.coach:"",ids:[]}})})}
  if(!out.length){toast("No upcoming classes in that range.");return}
  try{const j=await api("POST","/coach/classes/bulk",{classes:out});await coachLoad("classes");coachGo("classes");toast(`Added ${j.added} class${j.added===1?"":"es"}${j.skipped?` (${j.skipped} already there)`:""}.`)}
  catch(e){toast(e.message)}
}

/* ----- booking classes and private lessons (students) ----- */
const fmtTime=iso=>{try{return new Date(iso).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}catch(e){return ""}};
/* Short time for narrow columns: "18:00" on 24-hour phones, "6:00" with a small "pm" on 12-hour ones. */
const H12=(()=>{try{return /h1[12]/.test(new Intl.DateTimeFormat(undefined,{hour:"numeric"}).resolvedOptions().hourCycle||"")}catch(e){return false}})();
const timeHTML=iso=>{const d=new Date(iso),m=pad2(d.getMinutes());return H12?`${d.getHours()%12||12}:${m}<span class="ap">${d.getHours()<12?"am":"pm"}</span>`:`${pad2(d.getHours())}:${m}`};
const dayKey=iso=>{const d=new Date(iso);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
const dayLabel=iso=>{const k=dayKey(iso),t=dayKey(new Date().toISOString()),tm=dayKey(new Date(Date.now()+864e5).toISOString());return k===t?"Today":k===tm?"Tomorrow":new Date(iso).toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"short"})};
const clsEnd=c=>new Date(c.startsAt).getTime()+c.durationMin*6e4;
const canCheckIn=c=>{const s=new Date(c.startsAt).getTime(),n=Date.now();return n>=s-45*6e4&&n<=clsEnd(c)};
const isFull=c=>!!c.capacity&&c.going>=c.capacity;
async function loadMembership(){if(!API.me||!API.me.gym||isCoach())return;try{API.mem=(await api("GET","/me/membership")).membership}catch(e){}}
function spotsTxt(c){return c.kind==="private"?(c.priceCents?money(c.priceCents,(API.me.gym||{}).currency):"Private"):`${c.going}${c.capacity?"/"+c.capacity:""} booked${c.waiting?` · ${c.waiting} waiting`:""}`}
function whoLine(c,max){const a=c.attendees;if(!a||!a.length)return "";const n=max||3;
  return `<span class="who-line">${a.slice(0,n).map(x=>`<span class="whochip${x.me?" me":""}"><i style="--bc:${BCOL[x.belt]||"#F4F4F0"}"></i>${esc(x.me?"You":x.name)}</span>`).join("")}${a.length>n?`<span class="small muted">+${a.length-n}</span>`:""}</span>`}
function bookActions(c,big){
  const b=(a,v,going,label,cls)=>`<button class="btn${cls?" "+cls:""}${big?" grow":""}" data-a="${a}" data-v="${v}"${going!==null?` data-going="${going}"`:""}>${label}</button>`;
  if(new Date(c.startsAt).getTime()+c.durationMin*6e4<Date.now())return c.myAttended?`<span class="booked">✓ Trained</span>`:"";
  if(c.myAttended)return `<span class="booked">✓ Checked in</span>`;
  if(c.myGoing)return `${canCheckIn(c)?b("checkin",c.id,null,"Check in","primary"):`<span class="booked">✓ You're booked</span>`}${b("rsvp",c.id,0,"Cancel","ghost")}`;
  if(c.myWaitlisted)return `<span class="booked wait">Waitlist #${c.myPosition||"?"}</span>${b("rsvp",c.id,0,"Leave waitlist","ghost")}`;
  if(isFull(c))return c.kind==="private"?`<span class="small muted">Booked</span>`:b("rsvp",c.id,1,"Join waitlist","");
  return b("rsvp",c.id,1,c.kind==="private"?"Book this slot":"Book","primary");
}
function bookCard(c){
  const fill=c.capacity?Math.min(100,Math.round(100*c.going/c.capacity)):null;
  return `<div class="bookcard${c.myGoing?" mine":""}${c.kind==="private"?" priv":""}">
    <button class="bc-main" data-a="bookopen" data-v="${c.id}"><span class="bc-time mono"><span>${timeHTML(c.startsAt)}</span><small>${c.durationMin} min</small></span>
      <span class="bc-body"><b>${esc(c.title)}</b><span class="small muted">${[c.level,c.coach&&("with "+c.coach)].filter(Boolean).map(esc).join(" · ")}</span>
      <span class="small mono">${esc(spotsTxt(c))}</span>${fill!==null&&c.kind!=="private"?`<span class="cap" aria-hidden="true"><i style="width:${fill}%"></i></span>`:""}${whoLine(c)}</span></button>
    <div class="bc-act row">${bookActions(c)}</div></div>`}
function membershipCard(){const m=API.mem;if(!m)return "";const p=m.plan;
  return `<section class="panel memcard"><div class="row between"><h2 class="label">Your membership</h2>${m.status&&m.status!=="active"?`<span class="pill due">${esc(cap1(m.status))}</span>`:""}</div>
    <div class="row between" style="flex-wrap:nowrap"><div><b>${p?esc(p.name):"No plan set"}</b><br><span class="small muted">${p?`${money(p.priceCents,(API.me.gym||{}).currency)} ${esc(PERL[p.period]||"")}${p.classesPerWeek?` · ${p.classesPerWeek} classes a week`:" · unlimited classes"}`:"Your coach hasn't put you on a plan yet."}</span></div>
    ${p&&p.classesPerWeek?`<div class="mono" style="text-align:right"><b>${m.bookedThisWeek}/${p.classesPerWeek}</b><br><span class="small muted">booked this week</span></div>`:""}</div>
    <div class="stats"><div class="stat"><b>${m.visitsThisMonth}</b><span>Classes this month</span></div><div class="stat"><b>${m.streak}</b><span>Week streak</span></div><div class="stat"><b>${m.perWeek}</b><span>Per week</span></div></div></section>`}
const cap1=s=>String(s||"").charAt(0).toUpperCase()+String(s||"").slice(1);
function viewBook(){
  if(!API.me||!API.me.gym)return `${header()}<div class="empty">Join your gym (Settings › Your account) to book classes.</div>`;
  if(!API.classes){loadClasses(true);return `${header()}<div class="empty">Loading classes…</div>`}
  if(API.mem===undefined){API.mem=null;loadMembership().then(()=>{if(S.ui.tab==="book")render()})}
  if(API.notices===undefined){API.notices=null;loadNotices().then(()=>{if(["book","today"].includes(S.ui.tab)&&!S.ui.sheet)render()})}
  if(API.pay===undefined){API.pay=null;loadPay().then(()=>{if(S.ui.tab==="book"&&!S.ui.sheet)render()})}
  const v=S.ui.bookView||"classes",now=Date.now();
  const up=API.classes.filter(c=>clsEnd(c)>now);
  const groups=(list)=>{const g={};list.forEach(c=>{(g[dayKey(c.startsAt)]=g[dayKey(c.startsAt)]||[]).push(c)});return Object.values(g).map(cs=>`<section class="stack"><h2 class="label">${esc(dayLabel(cs[0].startsAt))}</h2>${cs.map(bookCard).join("")}</section>`).join("")};
  const cls=up.filter(c=>c.kind!=="private"),priv=up.filter(c=>c.kind==="private"),mineP=priv.filter(c=>c.myGoing),openP=priv.filter(c=>!c.myGoing&&!isFull(c));
  const mine=cls.filter(c=>c.myGoing||c.myWaitlisted);
  const p=gymProfile();
  return `${header()}<div class="stack-lg"><section class="stack"><h1 style="font-size:34px">Classes</h1>
    ${noticesCard()}<div class="seg3"><button data-a="bookview" data-v="classes" aria-pressed="${v==="classes"}">Classes</button><button data-a="bookview" data-v="private" aria-pressed="${v==="private"}">Privates${openP.length?` (${openP.length})`:""}</button><button data-a="bookview" data-v="comps" aria-pressed="${v==="comps"}">Comps${API.comps&&upcomingComps().length?` (${upcomingComps().length})`:""}</button></div></section>
    ${v==="comps"?compsList(false):v==="classes"?`${membershipCard()}${feesCard()}
      ${mine.length?`<p class="small"><b>You're booked for ${mine.filter(c=>c.myGoing).length} class${mine.filter(c=>c.myGoing).length===1?"":"es"}</b>${mine.some(c=>c.myWaitlisted)?` and waiting for ${mine.filter(c=>c.myWaitlisted).length}`:""}.</p>`:""}
      ${(()=>{if(!S.ui.bcal){const nx=cls.map(c=>dayKey(c.startsAt)).sort()[0];calState("book");if(nx&&nx>addDays2(weekStart(todayK()),6))S.ui.bcal.anchor=nx}/* nothing left this week (e.g. Sunday night): open on the week of the next class */
        const st=calState("book"),g=byDay(cls),ws=weekStart(st.anchor);
        const shown=st.sel?(g[st.sel]||[]):cls.filter(c=>{const k=dayKey(c.startsAt);return k>=ws&&k<=addDays2(ws,6)});
        return `${calHeader("book",st,g)}${st.sel?`<p class="small muted">Showing ${esc(dayLabel(fromYmd(st.sel).toISOString()))}. <button class="linkbtn small" data-a="calday" data-k="book" data-v="${st.sel}">Show the whole week</button></p>`:""}
          ${shown.length?groups(shown):`<div class="empty">${cls.length?(st.sel?"No classes that day.":"No classes this week. Try next week."):"No classes on the calendar yet. Your coach adds them in the Coach tab."}</div>`}`})()}`
    :`${mineP.length?`<section class="stack"><h2 class="label">Your private lessons</h2>${mineP.map(bookCard).join("")}</section>`:""}
      ${openP.length?groups(openP):`<div class="empty">No open private lesson slots right now.</div>`}
      <section class="panel stack"><h2 class="label">Want a different time?</h2><p class="small">Message your coach on WhatsApp. The message is written for you: add the day and time that suit you.</p>
        ${waBtn(privAskText(openP.concat(mineP)),"Ask for a time on WhatsApp",{phone:API.me.gym.waPhone,kind:"private_ask"})}
        ${API.me.gym.waPhone?"":`<p class="small muted">WhatsApp opens your chats: pick your coach.</p>`}${gymContact({phone:p.phone,email:p.email})}</section>`}
  </div>`}
function bookSheet(id){
  const c=(API.classes||[]).find(x=>x.id===id);if(!c)return;S.ui.sheet={k:"book",id};S.ui.stack=[];
  const pl=c.plan||{};const a=c.attendees;
  openSheet(`${sheetHead(c.kind==="private"?"Private lesson":"Class")}<div class="stack-lg"><div><h1>${esc(c.title)}</h1>
    <p class="muted">${esc(fmtWhen(c.startsAt))} · ${c.durationMin} min${c.coach?" · with "+esc(c.coach):""}${c.level?" · "+esc(c.level):""}</p>
    <p class="mono small">${esc(spotsTxt(c))}</p></div>
    ${pl&&(pl.focus||(pl.ids||[]).length||pl.notes)?`<section class="stack"><h2 class="label">Coach's plan</h2>${pl.focus?`<p><b>${esc(pl.focus)}</b></p>`:""}${(pl.ids||[]).filter(i=>TM[i]).length?`<div class="list">${pl.ids.filter(i=>TM[i]).map(i=>tRow(TM[i])).join("")}</div>`:""}${pl.notes?`<p class="small">${esc(pl.notes)}</p>`:""}</section>`:""}
    ${c.kind!=="private"?`<section class="stack"><h2 class="label">Who's booked${c.capacity?` (${c.going}/${c.capacity})`:` (${c.going})`}</h2>
      ${a?(a.length?`<div class="list">${a.map(x=>`<div class="attrow"><span><b>${esc(x.me?"You":x.name)}</b></span>${beltChip(x.belt,x.stripes)}</div>`).join("")}</div>`:`<p class="small muted">Nobody yet. Be the first.</p>`):`<p class="small muted">Your gym keeps the list private.</p>`}
      ${c.waiting?`<p class="small muted">${c.waiting} on the waitlist.</p>`:""}</section>`:""}
    ${c.myGoing&&c.kind!=="private"&&!inClaude()?waBtn(`I'm going to ${c.title} at ${gymName()}, ${fmtWhen(c.startsAt)}. Coming? Book here: ${appLink("#book")}`,"Ask a training partner to come",{kind:"class"}):""}
  </div>`,false,{act:`<div class="row grow" style="flex-wrap:nowrap;gap:8px;justify-content:flex-end">${bookActions(c,true)}</div>`});
}
async function doBook(id,going){
  try{const r=await api("PUT",`/classes/${id}/rsvp`,{going});jfTrack(going?"book":"cancel_booking",{waitlisted:!!r.waitlisted});
    toast(going?(r.waitlisted?`It's full, so you're on the waitlist at #${r.position}. We'll email you if a spot opens.`:"Booked. See you on the mat."):"Cancelled.");
    await loadClasses(true);API.mem=undefined;await loadMembership();afterBook(id)}
  catch(e){toast(e.message)}}
async function doCheckin(id){try{await api("POST",`/classes/${id}/checkin`);jfTrack("check_in",{});toast("Checked in. Have a good session.");await loadClasses(true);afterBook(id)}catch(e){toast(e.message)}}
function afterBook(id){if(S.ui.sheet&&S.ui.sheet.k==="book")bookSheet(id);else render()}

/* ----- coach: insights ----- */
const SEG={regular:["Regulars","1.5+ classes a week"],occasional:["Occasional","Trains, but less than weekly-plus"],at_risk:["At risk","Stopped or dropped off"],new:["New","Joined in the last 30 days"],inactive:["Not training","Nothing in 60 days"]};
const DOW=["","Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
async function loadInsights(){try{COACH.insights=await api("GET","/coach/insights")}catch(e){toast(e.message)}if(S.ui.tab==="coach"&&COACH.view==="students"&&COACH.stuView==="insights"&&!S.ui.sheet)render()}
function weekChart(weeks){
  const max=Math.max(1,...weeks.map(w=>w.visits)),W=340,H=150,pad=22,bw=Math.floor((W-8)/weeks.length)-2;
  const bars=weeks.map((w,i)=>{const h=Math.round((H-pad-14)*w.visits/max),x=4+i*(bw+2),y=H-pad-h;const lbl=new Date(w.wk+"T12:00:00").toLocaleDateString(undefined,{day:"numeric",month:"short"});
    return `<g class="bar" tabindex="0" aria-label="Week of ${esc(lbl)}: ${w.visits} visits by ${w.people} people"><rect class="hit" x="${x-1}" y="0" width="${bw+2}" height="${H-pad}" fill="transparent"/>${h?`<path d="M${x},${H-pad} V${y+4} q0,-4 4,-4 h${bw-8} q4,0 4,4 V${H-pad} Z" fill="var(--chart)"/>`:""}<title>Week of ${esc(lbl)}: ${w.visits} visits by ${w.people} people</title></g>`}).join("");
  const first=new Date(weeks[0].wk+"T12:00:00").toLocaleDateString(undefined,{day:"numeric",month:"short"});
  const last=weeks[weeks.length-1];
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Visits per week for the last 12 weeks, from ${weeks[0].visits} to ${last.visits}"><line x1="0" x2="${W}" y1="${H-pad}" y2="${H-pad}" stroke="var(--line)"/>${bars}
    <text x="4" y="${H-6}" class="ax">${esc(first)}</text><text x="${W-4}" y="${H-6}" text-anchor="end" class="ax">This week</text>${weeks.some(w=>w.visits)?`<text x="4" y="11" class="ax">${max} max</text>`:`<text x="${W/2}" y="${(H-pad)/2}" text-anchor="middle" class="ax">No visits recorded yet</text>`}</svg>
    <figcaption class="small muted">Visits per week. Bars count check-ins (or bookings, for classes nobody checked in at). Tap a bar for the number.</figcaption>
    <details class="small"><summary>Show as a table</summary><table class="tbl"><tr><th>Week of</th><th>Visits</th><th>People</th></tr>${weeks.map(w=>`<tr><td>${esc(w.wk)}</td><td>${w.visits}</td><td>${w.people}</td></tr>`).join("")}</table></details></figure>`}
function trend(a,b){if(!b&&!a)return "";if(!b)return `<span class="tr up">new</span>`;const p=Math.round(100*(a-b)/b);return p===0?`<span class="tr">±0%</span>`:`<span class="tr ${p>0?"up":"down"}">${p>0?"▲":"▼"} ${Math.abs(p)}%</span>`}
function coachInsights(){
  const I=COACH.insights;if(!I){loadInsights();return `<div class="empty">Working out who's training…</div>`}
  const cur=I.currency,k=I.kpis,f=COACH.segFilter||"";
  const st=I.students.map(s=>({...s,ready:readinessFor(s.mastery,goalOf(s))}));
  const atRisk=st.filter(s=>s.segment==="at_risk").sort((a,b)=>b.p28-a.p28);
  const review=st.filter(s=>(s.sinceRank>=24&&s.ready>=60)||s.sinceRank>=40).sort((a,b)=>b.sinceRank-a.sinceRank);
  const newQuiet=st.filter(s=>s.segment==="new"&&s.total180<=1);
  const busy=I.slots.filter(s=>(s.fill!==null&&s.fill>=85)||s.waitlisted>=2),quiet=I.slots.filter(s=>s.avg<3&&s.n>=3);
  const ids=a=>a.map(s=>s.id).join(",");
  const card=(tone,title,body,act)=>`<div class="insight ${tone}"><b>${title}</b><div class="small">${body}</div>${act?`<div class="row">${act}</div>`:""}</div>`;
  const nm=a=>a.slice(0,6).map(s=>`<button class="linkbtn" data-a="student" data-v="${s.id}">${esc(s.name)}</button>`).join(", ")+(a.length>6?` and ${a.length-6} more`:"");
  const byId={};st.forEach(x=>byId[x.id]=x);
  const mailBtn=(kind,a)=>{const one=a.length===1&&byId[a[0].id]&&byId[a[0].id].phone;const m=MSG[kind]||MSG.blank;
    return (API.status.mail?`<button class="btn" data-a="msgnew" data-k="${kind}" data-v="${ids(a)}">Email ${a.length===1?"them":"all "+a.length}</button>`:"")+waBtn((one?`Hi ${first(byId[a[0].id].name)}, `:"")+m[1].replace(/\n\n/g,"\n\n"),one?"WhatsApp them":"WhatsApp",{phone:one||"",kind:"insight_"+kind})};
  const cards=[
    atRisk.length&&card("warn",`${atRisk.length} student${atRisk.length>1?"s":""} at risk of dropping off`,`${nm(atRisk)}. They used to come regularly but have stopped or halved in the last 4 weeks. A short personal message often brings people back.`,mailBtn("risk",atRisk)),
    I.revenue.unpaid.length&&card("warn",`${I.revenue.unpaid.length} haven't paid this month`,`${I.revenue.unpaid.slice(0,6).map(u=>`<button class="linkbtn" data-a="student" data-v="${u.id}">${esc(u.name)}</button> (${money(u.dueCents,cur)})`).join(", ")}.`,mailBtn("pay",I.revenue.unpaid)),
    review.length&&card("good",`${review.length} might be ready for a stripe or belt review`,`${review.slice(0,6).map(s=>`<button class="linkbtn" data-a="student" data-v="${s.id}">${esc(s.name)}</button> (${s.sinceRank} classes since last promotion, ${s.ready}% of their next-belt techniques)`).join(", ")}.`,""),
    newQuiet.length&&card("",`${newQuiet.length} new member${newQuiet.length>1?"s":""} haven't really started`,`${nm(newQuiet)} joined recently and have trained once or not at all. Getting them to a few classes early helps them stick.`,mailBtn("welcome",newQuiet)),
    ...busy.slice(0,3).map(s=>card("good",`${DOW[s.dow]} ${esc(s.hm)} ${esc(s.title)} is busy`,`${s.fill!==null?`Runs ${s.fill}% full on average`:`Averages ${s.avg} people`}${s.waitlisted?`, with a waitlist ${s.waitlisted} of the last ${s.n} weeks`:""}. Consider raising the limit or adding a second session.`,"")),
    ...quiet.slice(0,3).map(s=>card("",`${DOW[s.dow]} ${esc(s.hm)} ${esc(s.title)} is quiet`,`Averages ${s.avg} ${s.avg===1?"person":"people"} over the last ${s.n} weeks. Move it, merge it, or turn it into an open mat or privates.`,"")),
    I.noPlan&&I.plans.length?card("",`${I.noPlan} student${I.noPlan>1?"s have":" has"} no membership plan`,`Put them on a plan in the Roster so fees and weekly limits work.`,`<button class="btn" data-a="coachgo" data-v="roster">Open roster</button>`):"",
  ].filter(Boolean);
  const list=st.filter(s=>!f||s.segment===f).sort((a,b)=>b.d28-a.d28||a.name.localeCompare(b.name));
  const ret=k.retention.base?Math.round(100*k.retention.retained/k.retention.base):null;
  const pct=I.revenue.expected?Math.min(100,Math.round(100*I.revenue.collected/I.revenue.expected)):0;
  return `<section class="stack-lg">
    <div class="stats four"><div class="stat"><b>${k.active}</b><span>Active members</span></div><div class="stat"><b>${k.perWeek}</b><span>Visits / week ${trend(k.visits28,k.prev28)}</span></div><div class="stat"><b>${k.perMember}</b><span>Per member / week</span></div><div class="stat"><b>${ret===null?"–":ret+"%"}</b><span>Still training after 90 days</span></div></div>
    ${weekChart(I.weeks)}
    <section class="stack"><h2 class="label">Needs your attention</h2>${cards.length?cards.join(""):`<p class="small muted">Nothing urgent. Everyone's training and paid up.</p>`}</section>
    <section class="stack"><h2 class="label">Students</h2>
      <div class="segpills">${["","regular","occasional","at_risk","new","inactive"].map(s=>`<button data-a="segf" data-v="${s}" aria-pressed="${f===s}">${s?esc(SEG[s][0]):"All"} <b>${s?I.segments[s]:st.length}</b></button>`).join("")}</div>
      ${f?`<p class="small muted">${esc(SEG[f][1])}.</p>`:""}
      <div class="list">${list.map(s=>`<button class="trow" data-a="student" data-v="${s.id}" style="grid-template-columns:minmax(0,1fr) auto"><span><span class="nm">${esc(s.name)}</span><span class="meta">${beltChip(s.belt,s.stripes)}<span class="segtag ${s.segment}">${esc(SEG[s.segment][0])}</span><span>${s.last?`Last ${s.daysSince===0?"today":s.daysSince===1?"yesterday":s.daysSince+" days ago"}`:"Never trained"}</span>${s.streak>1?`<span>${s.streak}-week streak</span>`:""}${s.planName?`<span>${esc(s.planName)}</span>`:""}</span></span><span class="mono" style="text-align:right"><b>${s.d28}</b><small class="muted"> / 4 wks</small><br>${trend(s.d28,s.p28)}</span></button>`).join("")||`<div class="empty">Nobody here.</div>`}</div></section>
    ${I.slots.length?`<section class="stack"><h2 class="label">Class times (last 8 weeks)</h2><table class="tbl"><tr><th>When</th><th>Class</th><th>Avg</th><th>Full</th></tr>${I.slots.map(s=>`<tr><td class="mono">${DOW[s.dow]} ${esc(s.hm)}</td><td>${esc(s.title)}</td><td class="mono">${s.avg}</td><td class="mono">${s.fill===null?"–":s.fill+"%"}${s.waitlisted?" · waitlist":""}</td></tr>`).join("")}</table></section>`:""}
    <section class="stack"><h2 class="label">Money this month</h2>
      <div class="meter"><div class="row between"><b class="mono">${money(I.revenue.collected,cur)}</b><span class="small muted">of ${money(I.revenue.expected,cur)} expected</span></div><span class="cap"><i style="width:${pct}%"></i></span></div>
      ${I.plans.length?`<table class="tbl"><tr><th>Plan</th><th>Members</th><th>Per month</th></tr>${I.plans.map(p=>`<tr><td>${esc(p.name)}</td><td class="mono">${p.members}</td><td class="mono">${money(p.monthlyCents,cur)}</td></tr>`).join("")}</table>`:`<p class="small muted">Add membership plans in the Gym tab to see revenue by plan.</p>`}</section>
  </section>`}

/* ----- coach: email students ----- */
const MSG={risk:["Missed you on the mats","Hey! We haven't seen you at training for a little while and wanted to check in.\n\nIf something's getting in the way (time, an injury, anything), reply and let us know. We'd love to see you back. Have a look at this week's classes in the app and book one."],
  comp:["Competition: what you need to know","Hi team!\n\nHere's what you need for the competition: weigh-in time, what to bring, and when we're meeting.\n\n"],
  pay:["Membership payment for this month","Hi! A quick reminder that this month's membership hasn't come through yet.\n\nIf you've already paid, reply with your proof of payment and we'll sort it out. Thanks!"],
  welcome:["How's your first month going?","Welcome to the gym! We noticed you haven't made it to many classes yet.\n\nThe first few weeks are the hardest. Book two classes this week in the app and come say hi. Questions? Just reply to this email."],
  blank:["",""]};
function msgSheet(kind,ids){
  const ppl=(COACH.insights?COACH.insights.students:[]).concat(COACH.roster?COACH.roster.people:[]);const by={};ppl.forEach(p=>by[p.id]=p);
  S.ui.msg={ids:ids.filter(i=>by[i]),kind};const m=MSG[kind]||MSG.blank;S.ui.sheet={k:"msg"};S.ui.stack=[];
  openSheet(`${sheetHead("Email students")}<form id="msgform" class="stack-lg" novalidate>
    <div class="stack"><span class="small muted">To</span><div class="chips">${S.ui.msg.ids.map(i=>`<span class="chip">${esc(by[i].name)}</span>`).join("")}</div><p class="small muted">Each person gets their own email. Replies come to ${esc(API.me.email)}.</p></div>
    <label class="f">Subject<input id="m-sub" name="subject" value="${esc(m[0])}"></label>
    <label class="f">Message<textarea id="m-text" name="text" rows="8">${esc(m[1])}</textarea></label></form>`,false,{act:`<button class="btn primary grow" type="submit" form="msgform">Send ${S.ui.msg.ids.length} email${S.ui.msg.ids.length===1?"":"s"}</button>`});
}
async function sendMsg(form){const btn=document.querySelector('#sheetbar [type=submit]');if(btn)btn.disabled=true;
  try{const j=await api("POST","/coach/message",{userIds:S.ui.msg.ids,subject:form.querySelector("[name=subject]").value,text:form.querySelector("[name=text]").value});
    jfTrack("coach_message",{kind:S.ui.msg.kind,count:j.sent});hideSheet();render();toast(`Sent ${j.sent} email${j.sent===1?"":"s"}.${j.failed.length?" Couldn't send to "+j.failed.join(", ")+".":""}${(j.noEmail||[]).length?` No email for ${j.noEmail.join(", ")}: use WhatsApp.`:""}`)}
  catch(e){toast(e.message);if(btn)btn.disabled=false}}

/* ----- coach: membership plans ----- */
function plansPanel(){const ps=(COACH.roster&&COACH.roster.plans)||[],cur=API.me.gym.currency,ed=S.ui.planEdit;
  const rates=(gymProfile().rates||[]).filter(r=>!ps.some(p=>p.name.toLowerCase()===r.name.toLowerCase()));
  const form=p=>`<form id="planform" class="stack" data-id="${p?p.id:""}"><div class="grid2"><label class="f">Plan name<input name="name" value="${esc(p?p.name:"")}" placeholder="e.g. Unlimited"></label><label class="f">Price (${esc(cur)})<input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${p?p.priceCents/100:""}"></label></div>
    <div class="grid2"><label class="f">Per<select name="period">${["month","week","year","term","class","once"].map(x=>`<option value="${x}"${(p?p.period:"month")===x?" selected":""}>${x==="once"?"Once-off":x==="term"?"Term (3 months)":cap1(x)}</option>`).join("")}</select></label><label class="f">Classes a week<input name="cpw" type="number" inputmode="numeric" min="1" max="30" value="${p&&p.classesPerWeek?p.classesPerWeek:""}" placeholder="Unlimited"></label></div>
    ${p?`<label class="row small"><input name="active" type="checkbox" style="width:auto"${p.active?" checked":""}> Offered to new members</label>`:""}
    <div class="row"><button class="btn primary" type="submit">${p?"Save plan":"Add plan"}</button><button class="btn ghost" type="button" data-a="planedit" data-v="">Cancel</button></div></form>`;
  return `<div class="panel stack"><h2 class="label">Membership plans</h2><p class="small">Put each student on a plan in the Roster. Weekly limits stop extra bookings, and Insights shows revenue by plan.</p>
    ${ps.length?`<div class="list">${ps.map(p=>ed===p.id?form(p):`<div class="row between" style="border-top:1px solid var(--line);padding-block:8px;flex-wrap:nowrap"><span><b>${esc(p.name)}</b>${p.active?"":" <span class='small muted'>(not offered)</span>"}<br><span class="small muted">${money(p.priceCents,cur)} ${esc(PERL[p.period]||"")}${p.classesPerWeek?` · ${p.classesPerWeek}/week`:" · unlimited"}</span></span><button class="btn ghost" data-a="planedit" data-v="${p.id}">Edit</button></div>`).join("")}</div>`:""}
    ${ed==="new"?form(null):`<div class="row"><button class="btn" data-a="planedit" data-v="new">+ Add a plan</button>${rates.length?`<button class="btn" data-a="plansfromrates">Use my website prices (${rates.length})</button>`:""}</div>`}</div>`}
async function savePlan(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";const id=form.dataset.id;
  const body={name:v("name"),priceCents:Math.round(Number(v("price"))*100),period:v("period"),classesPerWeek:v("cpw")?Number(v("cpw")):null,active:form.querySelector("[name=active]")?form.querySelector("[name=active]").checked:true};
  try{await api(id?"PATCH":"POST",id?`/coach/plans/${id}`:"/coach/plans",body);S.ui.planEdit=null;await coachLoad("roster");toast(id?"Plan saved.":"Plan added. Put students on it from the Roster.")}catch(e){toast(e.message)}}

/* ----- coach: private lesson slots ----- */
/* Private lesson slots: tap the hours you're free (no typing times on a phone keypad), add an odd time if needed, repeat weekly. */
const PV_HOURS=Array.from({length:16},(_,i)=>String(i+6).padStart(2,"0")+":00");
const pvChip=(t,on)=>`<button type="button" class="tchip" data-a="pvtime" data-v="${t}" aria-pressed="${on}">${t}</button>`;
function privSheet(){S.ui.sheet={k:"priv"};S.ui.stack=[];const ds2=addDays2(todayK(),1),last=lsGet("jf.pvTimes")||[],extra=last.filter(t=>!PV_HOURS.includes(t));
  openSheet(`${sheetHead("Private lesson slots")}<form id="privform" class="stack-lg" novalidate><p class="small">Tap the times you're free. Students see open slots under Classes › Privates and book one; a booked slot disappears for everyone else.</p>
    <label class="f">Date<input id="pv-date" name="date" type="date" value="${ds2}" min="${todayK()}"></label>
    <div class="stack"><div class="row between"><span class="flabel">Start times</span><button type="button" class="linkbtn small" data-a="pvclear">Clear</button></div>
      <div class="tgrid" id="pv-grid">${[...PV_HOURS,...extra].sort().map(t=>pvChip(t,last.includes(t))).join("")}</div>
      <div class="row" style="flex-wrap:nowrap"><input id="pv-other" type="time" step="900" aria-label="Another start time" style="flex:1"><button type="button" class="btn" data-a="pvadd">Add time</button></div></div>
    <label class="f">Repeat<select id="pv-rep" name="rep"><option value="1">Just this day</option><option value="4">Same times every week, 4 weeks</option><option value="8">Every week, 8 weeks</option><option value="12">Every week, 12 weeks</option></select></label>
    <div class="grid2"><label class="f">Minutes<select id="pv-dur" name="dur">${[30,45,60,75,90,120].map(m=>`<option${m===(lsGet("jf.pvDur")||60)?" selected":""}>${m}</option>`).join("")}</select></label><label class="f">Price (${esc(API.me.gym.currency||"ZAR")})<input id="pv-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${esc((lsGet("jf.pvPrice")??""))}"></label></div>
    <div class="grid2">${coachField("pv-coach",API.me.name,false)}<label class="f">People<select name="cap"><option value="1">1 (private)</option><option value="2">2 (semi-private)</option><option value="3">3</option></select></label></div>
    <label class="f">Title<input name="title" value="Private lesson"></label>
    <p class="small muted" id="pv-sum" aria-live="polite"></p></form>`,false,{act:`<button class="btn primary grow" type="submit" form="privform" id="pv-go">Add slots</button>`});pvSum()}
function pvPicked(){return [...document.querySelectorAll('#pv-grid .tchip[aria-pressed="true"]')].map(b=>b.dataset.v).sort()}
function pvSum(){const el=document.getElementById("pv-sum");if(!el)return;const n=pvPicked().length,w=Number((document.getElementById("pv-rep")||{}).value||1),go=document.getElementById("pv-go");
  el.textContent=n?`${n} time${n>1?"s":""}${w>1?` × ${w} weeks`:""} = ${n*w} slot${n*w>1?"s":""}`:"Pick at least one start time.";if(go)go.textContent=n?`Add ${n*w} slot${n*w>1?"s":""}`:"Add slots"}
function pvAdd(){const i=document.getElementById("pv-other"),t=(i&&i.value||"").slice(0,5);if(!/^\d{2}:\d{2}$/.test(t)){toast("Pick a time first.");return}
  const g=document.getElementById("pv-grid"),have=g.querySelector(`[data-v="${t}"]`);if(have)have.setAttribute("aria-pressed","true");
  else{const after=[...g.children].find(b=>b.dataset.v>t);after?after.insertAdjacentHTML("beforebegin",pvChip(t,true)):g.insertAdjacentHTML("beforeend",pvChip(t,true))}i.value="";pvSum()}
async function savePriv(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  const times=pvPicked();if(!times.length){toast("Tap at least one start time.");return}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v("date"))){toast("Pick a date.");return}
  const weeks=Math.max(1,Number(v("rep"))||1),dur=Number(v("dur"))||60;
  const classes=[];for(let w=0;w<weeks;w++){const day=addDays2(v("date"),7*w);for(const t of times)classes.push({kind:"private",title:v("title")||"Private lesson",startsAt:new Date(`${day}T${t}`).toISOString(),durationMin:dur,priceCents:v("price")?Math.round(Number(v("price"))*100):null,coach:coachVal(form),capacity:Number(v("cap"))||1})}
  const future=classes.filter(c=>new Date(c.startsAt)>Date.now());if(!future.length){toast("Those times have already passed. Pick a later time or another day.");return}
  lsSet("jf.pvTimes",times);lsSet("jf.pvDur",dur);lsSet("jf.pvPrice",v("price"));
  try{const j=await api("POST","/coach/classes/bulk",{classes:future});hideSheet();const st=calState("coach");st.sel=v("date");st.anchor=st.sel;await coachLoad("classes",st.anchor);coachGo("classes");toast(`Added ${j.added} private slot${j.added===1?"":"s"}${j.skipped?` (${j.skipped} already there)`:""}.`)}catch(e){toast(e.message)}}

/* ----- competitions ----- */
const CSTAT={requested:["Asked to enter","due"],entered:["On the team","ok"],declined:["Not this time",""],withdrawn:["Withdrawn",""]};
const STYLE={gi:"Gi",nogi:"No-gi",both:"Gi and no-gi"};
const compDates=c=>{const f=d=>fromYmd(d).toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short",year:"numeric"});return c.endsOn&&c.endsOn!==c.startsOn?`${f(c.startsOn)} – ${f(c.endsOn)}`:f(c.startsOn)};
const kg=w=>w&&/^\d+([.,]\d+)?$/.test(String(w).trim())?String(w).trim()+" kg":w;
const daysTo=d=>Math.round((fromYmd(d)-fromYmd(todayK()))/864e5);
const regLine=c=>{if(!c.registerBy)return "";const n=daysTo(c.registerBy);return n<0?`<span class="small muted">Registration closed</span>`:n===0?`<span class="small warn-t">Registration closes today</span>`:`<span class="small${n<=7?" warn-t":" muted"}">Registration closes in ${n} day${n===1?"":"s"}</span>`};
async function loadComps(force){if(!API.me||!API.me.gym)return;if(!force&&API.comps&&Date.now()-API.compsAt<60000)return;
  try{API.comps=(await api("GET","/competitions")).competitions;API.compsAt=Date.now();if(["book","coach","today"].includes(S.ui.tab)&&!S.ui.sheet)render();else if(S.ui.sheet&&S.ui.sheet.k==="comp")compSheet(S.ui.sheet.id,true)}catch(e){}}
const upcomingComps=()=>(API.comps||[]).filter(c=>(c.endsOn||c.startsOn)>=todayK());
function teamChips(c,max){const t=(c.team||[]).filter(x=>x.status==="entered");if(!t.length)return "";const n=max||5;
  return `<span class="who-line">${t.slice(0,n).map(x=>`<span class="whochip${x.me?" me":""}"><i style="--bc:${BCOL[x.belt]||"#F4F4F0"}"></i>${esc(x.me?"You":x.name)}</span>`).join("")}${t.length>n?`<span class="small muted">+${t.length-n}</span>`:""}</span>`}
function compCard(c,coach){const past=(c.endsOn||c.startsOn)<todayK(),m=c.mine,st=m&&CSTAT[m.status];
  const card=`<button class="compcard${past?" past":""}" data-a="compopen" data-v="${c.id}"><span class="cc-date mono"><b>${fromYmd(c.startsOn).getDate()}</b><small>${esc(fromYmd(c.startsOn).toLocaleDateString(undefined,{month:"short"}))}</small></span>
    <span class="cc-body"><b>${esc(c.name)}</b><small>${[compDates(c),c.city,STYLE[c.style]].filter(Boolean).map(esc).join(" · ")}</small>${past?"":regLine(c)}
    ${coach?`<small><b>${c.entered}</b> on the team${c.requested?` · <b class="warn-t">${c.requested} asking</b>`:""}</small>`:st?`<span class="pill ${st[1]}">${esc(st[0])}${m.status==="entered"&&m.division?" · "+esc(m.division):""}</span>`:""}${teamChips(c,4)}</span></button>`;
  return coach?swipeWrap(card,{edit:["compedit",c.id],del:["compdelask",c.id]}).replace('class="swipe"','class="swipe cardsw"'):card}
function compsList(coach){
  if(!API.comps){loadComps(true);return `<div class="empty">Loading competitions…</div>`}
  const up=upcomingComps(),past=(API.comps||[]).filter(c=>(c.endsOn||c.startsOn)<todayK()).reverse();
  return `${up.length?`<div class="stack">${up.map(c=>compCard(c,coach)).join("")}</div>`:`<div class="empty">${coach?"No competitions yet. Paste an event link above, or add one by hand.":"No competitions coming up yet. Your coach adds the ones the gym is entering."}</div>`}
    ${past.length?`<h2 class="label">Recent</h2><div class="stack">${past.map(c=>compCard(c,coach)).join("")}</div>`:""}`}
function coachComps(){
  return `<section class="stack">
    <form id="compimpform" class="panel stack"><h2 class="label">Add a competition from its web page</h2>
      <div class="row" style="flex-wrap:nowrap"><input id="ci-url" name="url" type="url" inputmode="url" autocapitalize="none" placeholder="Paste the event link" style="flex:1" aria-label="Competition web page"><button class="btn primary" type="submit">Read</button></div>
      <p class="small muted">JitsFlow reads the name, dates, venue, entry deadline, fees and divisions. You check them before saving.</p></form>
    <button class="btn" data-a="compnew">+ Add a competition by hand</button>
    ${compsList(true)}</section>`}
function compForm(c,imp){
  c=c||{};const cur=API.me.gym.currency||"ZAR";S.ui.sheet={k:"compform",id:c.id||null};S.ui.stack=[];
  openSheet(`${sheetHead(c.id?"Edit competition":"Add a competition")}<form id="compform" class="stack-lg" novalidate>
    ${imp?`<div class="panel ${imp.dateChecked?"":"accent"}"><p class="small"><b>Read from ${imp.pages.length} page${imp.pages.length===1?"":"s"}${imp.method==="claude"?" with Claude":""}.</b> ${imp.dateChecked?"The date was found on the page.":"Couldn't confirm the date on the page: check it."} Check everything before saving.</p></div>`:""}
    <label class="f">Name<input id="cp-name" name="name" value="${esc(c.name||"")}" placeholder="e.g. Gauteng Open No-Gi"></label>
    <div class="grid2"><label class="f">Date<input id="cp-start" name="startsOn" type="date" value="${esc(c.startsOn||"")}"></label><label class="f">Last day (if longer)<input id="cp-end" name="endsOn" type="date" value="${esc(c.endsOn||"")}"></label></div>
    <div class="grid2"><label class="f">Venue<input name="venue" value="${esc(c.venue||"")}"></label><label class="f">City<input name="city" value="${esc(c.city||"")}"></label></div>
    <div class="grid2"><label class="f">Registration closes<input id="cp-reg" name="registerBy" type="date" value="${esc(c.registerBy||"")}"></label><label class="f">Gi or no-gi<select name="style"><option value="">Not sure</option>${Object.entries(STYLE).map(([k,l])=>`<option value="${k}"${c.style===k?" selected":""}>${l}</option>`).join("")}</select></label></div>
    <label class="f">Entry fee<input name="fee" value="${esc(c.fee||"")}" placeholder="e.g. ${esc(cur)} 650, ${esc(cur)} 800 after the 1st"></label>
    <label class="f">Organiser<input name="organiser" value="${esc(c.organiser||"")}"></label>
    <label class="f">Event page<input name="url" type="url" value="${esc(c.url||"")}" placeholder="https://"></label>
    <label class="f">Divisions (one per line)<textarea name="divisions" rows="4" placeholder="Adult blue belt -76kg&#10;Masters white belt">${esc((c.divisions||[]).join("\n"))}</textarea></label>
    <label class="f">Details for students<textarea name="details" rows="3" placeholder="Weigh-in, rules, what to bring">${esc(c.details||"")}</textarea></label>
    ${c.id?`<button class="btn danger" type="button" data-a="compdel" data-v="${c.id}">Delete competition</button>`:""}
  </form>`,false,{act:`<button class="btn primary grow" type="submit" form="compform">${c.id?"Save":"Add competition"}</button>`})}
async function saveComp(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";const id=S.ui.sheet&&S.ui.sheet.id;
  const body={name:v("name"),startsOn:v("startsOn"),endsOn:v("endsOn")||null,venue:v("venue"),city:v("city"),registerBy:v("registerBy")||null,style:v("style"),fee:v("fee"),organiser:v("organiser"),url:v("url"),divisions:v("divisions").split("\n").map(x=>x.trim()).filter(Boolean),details:v("details")};
  try{const j=await api(id?"PUT":"POST",id?`/coach/competitions/${id}`:"/coach/competitions",body);jfTrack("competition_saved",{imported:!!S.ui.compImp});S.ui.compImp=null;await loadComps(true);compSheet(j.competition.id);toast(id?"Saved.":"Competition added. Students can see it and ask to enter.")}catch(e){toast(e.message)}}
async function compImport(form){const url=form.querySelector("[name=url]").value.trim();if(!url){toast("Paste the competition's link first.");return}
  const btn=form.querySelector("[type=submit]");btn.disabled=true;btn.textContent="Reading…";
  try{const j=await api("POST","/coach/competitions/import",{url});S.ui.compImp=j;compForm(j.event,j)}catch(e){toast(e.message)}btn.disabled=false;btn.textContent="Read"}
function compSheet(id,keep){
  const c=(API.comps||[]).find(x=>x.id===id);if(!c)return;S.ui.sheet={k:"comp",id};S.ui.stack=[];const coach=isCoach(),m=c.mine,past=(c.endsOn||c.startsOn)<todayK();
  const req=(c.team||[]).filter(x=>x.status==="requested"),team=(c.team||[]).filter(x=>x.status==="entered"),other=(c.team||[]).filter(x=>x.status==="declined"||x.status==="withdrawn");
  const row=x=>`<div class="attrow"><span><b>${esc(x.me?"You":x.name)}</b> ${beltChip(x.belt,x.stripes)}<br><span class="small muted">${[x.division,kg(x.weight),coach&&x.note?`“${x.note}”`:"",x.result?cap1(x.result):""].filter(Boolean).map(esc).join(" · ")||"Division not set"}${coach&&x.paid?" · <b class='ok-t'>Paid</b>":""}</span></span>${coach?`<button class="btn sm" data-a="compentry" data-v="${x.id}">Edit</button>`:""}</div>`;
  const notIn=coach&&COACH.roster?students().filter(p=>p.active&&!(c.team||[]).some(x=>x.id===p.id)):[];
  openSheet(`${sheetHead("Competition")}<div class="stack-lg"><div class="stack" style="gap:6px"><h1>${esc(c.name)}</h1>
      <p class="muted">${esc(compDates(c))}${c.venue||c.city?" · "+esc([c.venue,c.city].filter(Boolean).join(", ")):""}</p>${past?"":regLine(c)}
      <p class="small">${[STYLE[c.style],c.fee&&("Entry: "+c.fee),c.organiser&&("By "+c.organiser)].filter(Boolean).map(esc).join(" · ")}</p>
      <div class="row">${c.url?`<a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Event page</a>`:""}${coach?waBtn(WA_T.comp(c),"Share on WhatsApp",{kind:"comp"}):m&&m.status==="entered"?waBtn(`I'm competing at ${c.name} on ${compDates(c)}${m.division?` (${m.division})`:""}! Wish me luck 🤙`,"Share on WhatsApp",{kind:"comp_me"}):""}</div></div>
    ${c.details?`<p class="small">${esc(c.details)}</p>`:""}
    ${(c.divisions||[]).length?`<details class="planbox"><summary>Divisions (${c.divisions.length})</summary><ul class="small" style="margin:8px 0 0;padding-left:18px">${c.divisions.map(d=>`<li>${esc(d)}</li>`).join("")}</ul></details>`:""}
    ${!coach?`<section class="stack"><h2 class="label">You</h2>${!m||m.status==="withdrawn"?(past?`<p class="small muted">This one's over.</p>`:`<p class="small">${m?"You withdrew. Changed your mind?":"Want to compete? Ask your coach here."}</p><button class="btn primary" data-a="compreq" data-v="${c.id}">I want to compete</button>`)
      :m.status==="requested"?`<p><span class="pill due">Asked to enter</span> ${m.division?esc(m.division):""}</p><p class="small muted">Your coach will let you know. Usually it's about readiness and whether there's a division for you.</p><button class="btn ghost" data-a="compwithdraw" data-v="${c.id}">Withdraw request</button>`
      :m.status==="entered"?`<p><span class="pill ok">You're on the team</span> ${esc([m.division,kg(m.weight)].filter(Boolean).join(" · "))}</p>${m.coachNote?`<p class="small">Coach: ${esc(m.coachNote)}</p>`:""}${m.result?`<p><b>Result: ${esc(cap1(m.result))}</b></p>`:""}${past?"":`<button class="btn ghost" data-a="compwithdraw" data-v="${c.id}">Withdraw</button>`}`
      :`<p><span class="pill">Not this time</span></p>${m.coachNote?`<p class="small">Coach: ${esc(m.coachNote)}</p>`:""}`}</section>`:""}
    ${coach&&req.length?`<section class="stack"><h2 class="label">Asking to enter (${req.length})</h2><div class="list">${req.map(x=>`<div class="attrow"><span><b>${esc(x.name)}</b> ${beltChip(x.belt,x.stripes)}<br><span class="small muted">${esc([x.division,kg(x.weight),x.note&&`“${x.note}”`].filter(Boolean).join(" · ")||"No division given")}</span></span><span class="row" style="flex-wrap:nowrap;gap:6px"><button class="btn sm primary" data-a="compyes" data-v="${x.id}">Enter</button><button class="btn sm" data-a="compno" data-v="${x.id}">Not now</button></span></div>`).join("")}</div></section>`:""}
    <section class="stack"><div class="row between"><h2 class="label">The team (${team.length})</h2>${coach&&team.length&&API.status.mail?`<button class="btn sm" data-a="msgnew" data-k="comp" data-v="${team.map(x=>x.id).join(",")}">Email the team</button>`:""}</div>
      ${team.length?`<div class="list">${team.map(row).join("")}</div>`:`<p class="small muted">Nobody entered yet.</p>`}
      ${coach&&notIn.length&&!past?`<div class="row" style="flex-wrap:nowrap"><select id="comp-add" aria-label="Add a student" style="flex:1"><option value="">Add a student…</option>${notIn.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select><button class="btn" data-a="compadd" data-v="${c.id}">Add</button></div>`:""}</section>
    ${coach&&other.length?`<details class="planbox"><summary>Not entered (${other.length})</summary><div class="list">${other.map(x=>`<div class="attrow"><span>${esc(x.name)} <span class="small muted">· ${esc(CSTAT[x.status][0])}</span></span><button class="btn sm" data-a="compyes" data-v="${x.id}">Enter</button></div>`).join("")}</div></details>`:""}
  </div>`,keep,coach?{act:`<button class="btn grow" data-a="compedit" data-v="${c.id}">Edit details</button>`}:undefined)}
function compReqSheet(id){const c=(API.comps||[]).find(x=>x.id===id);if(!c)return;S.ui.sheet={k:"compreq",id};S.ui.stack=[];const m=c.mine||{};
  openSheet(`${sheetHead("Ask to compete")}<form id="compreqform" class="stack-lg" novalidate><div><h1>${esc(c.name)}</h1><p class="muted">${esc(compDates(c))}</p></div>
    <label class="f">Division<input name="division" list="cr-div" value="${esc(m.division||"")}" placeholder="e.g. Adult blue belt -76kg"><datalist id="cr-div">${(c.divisions||[]).map(d=>`<option value="${esc(d)}">`).join("")}</datalist></label>
    <label class="f">Your weight (kg)<input name="weight" inputmode="decimal" value="${esc(m.weight||"")}" placeholder="e.g. 74"></label>
    <label class="f">Anything your coach should know<textarea name="note" rows="3" placeholder="First competition, injuries, travel…">${esc(m.note||"")}</textarea></label>
    <p class="small muted">Your coach gets a message and decides who goes. You'll get an email either way.</p></form>`,false,{act:`<button class="btn primary grow" type="submit" form="compreqform">Send request</button>`})}
async function sendCompReq(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";const id=S.ui.sheet.id;
  try{await api("POST",`/competitions/${id}/request`,{division:v("division"),weight:v("weight"),note:v("note")});jfTrack("competition_request",{});toast("Request sent to your coach.");await loadComps(true);compSheet(id)}catch(e){toast(e.message)}}
function compEntrySheet(cid,uid){const c=(API.comps||[]).find(x=>x.id===cid),x=c&&(c.team||[]).find(t=>t.id===uid);if(!x)return;S.ui.sheet={k:"compentry",id:cid,uid};S.ui.stack=[];const past=(c.endsOn||c.startsOn)<todayK();
  openSheet(`${sheetHead("Competitor")}<form id="compentryform" class="stack-lg" novalidate><div><h1>${esc(x.name)}</h1><p class="muted">${esc(c.name)}</p></div>
    <label class="f">Division<input name="division" list="ce-div" value="${esc(x.division||"")}"><datalist id="ce-div">${(c.divisions||[]).map(d=>`<option value="${esc(d)}">`).join("")}</datalist></label>
    <div class="grid2"><label class="f">Weight (kg)<input name="weight" inputmode="decimal" value="${esc(x.weight||"")}"></label><label class="f">Status<select name="status">${Object.entries(CSTAT).map(([k,l])=>`<option value="${k}"${x.status===k?" selected":""}>${l[0]}</option>`).join("")}</select></label></div>
    <label class="row small"><input name="paid" type="checkbox" style="width:auto"${x.paid?" checked":""}> Entry fee paid</label>
    <label class="f">Result${past?"":" (after the event)"}<select name="result">${["","gold","silver","bronze","competed","didn't compete"].map(r=>`<option value="${r}"${x.result===r?" selected":""}>${r?cap1(r):"Not yet"}</option>`).join("")}</select></label>
    <label class="f">Note to the student<textarea name="coachNote" rows="2">${esc(x.coachNote||"")}</textarea></label>
    <button class="btn danger" type="button" data-a="compremove" data-v="${uid}">Remove from this competition</button></form>`,false,{act:`<button class="btn primary grow" type="submit" form="compentryform">Save</button>`})}
async function saveCompEntry(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";const {id,uid}=S.ui.sheet;
  try{await api("PUT",`/coach/competitions/${id}/competitors/${uid}`,{division:v("division"),weight:v("weight"),status:v("status"),paid:form.querySelector("[name=paid]").checked,result:v("result"),coachNote:v("coachNote")});await loadComps(true);compSheet(id);toast("Saved.")}catch(e){toast(e.message)}}
async function compSet(cid,uid,status){try{await api("PUT",`/coach/competitions/${cid}/competitors/${uid}`,{status});await loadComps(true);compSheet(cid,true);toast(status==="entered"?"Entered. They'll get an email.":"Done. They'll get an email.")}catch(e){toast(e.message)}}
function compTodayCard(){if(!API.me||!API.me.gym)return "";if(!API.comps){loadComps();return ""}
  const mine=upcomingComps().filter(c=>c.mine&&c.mine.status==="entered").filter(c=>daysTo(c.startsOn)<=45);
  return mine.map(c=>{const n=daysTo(c.startsOn);return `<section class="panel accent"><h2 class="label">Competing</h2><p><b>${esc(c.name)}</b> ${n<=0?"is today. Good luck!":`in ${n} day${n===1?"":"s"}`}</p><p class="small muted">${esc([compDates(c),c.city,c.mine.division].filter(Boolean).join(" · "))}</p><button class="btn" data-a="compopen" data-v="${c.id}">Details and team</button></section>`}).join("")}

/* ----- WhatsApp: opens WhatsApp with the message already written. With a number it opens that person's chat;
   without one, WhatsApp asks which chat or group to send it to. ----- */
const WA_CC={"Africa/Johannesburg":"27","Africa/Windhoek":"264","Africa/Gaborone":"267","Africa/Harare":"263","Africa/Maputo":"258","Africa/Nairobi":"254","Africa/Lagos":"234","Europe/London":"44","Europe/Dublin":"353","Europe/Lisbon":"351","Europe/Amsterdam":"31","Australia/Sydney":"61","Australia/Melbourne":"61","Australia/Perth":"61","Pacific/Auckland":"64","America/New_York":"1","America/Chicago":"1","America/Denver":"1","America/Los_Angeles":"1","America/Sao_Paulo":"55","Asia/Dubai":"971"};
function waNum(ph){const raw=String(ph||"").trim();let d=raw.replace(/\D/g,"");if(!d)return "";if(raw.startsWith("+"))return d;if(d.startsWith("00"))return d.slice(2);
  if(d.startsWith("0")){const tz=(API.me&&API.me.gym&&API.me.gym.timezone)||"Africa/Johannesburg";return (WA_CC[tz]||"27")+d.slice(1)}return d}
const waURL=(text,phone)=>`https://wa.me/${phone?waNum(phone):""}?text=${encodeURIComponent(text)}`;
const WA_ICON=`<svg class="waico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5l1.2-3.6A8 8 0 1 1 8.4 18.6z"/><path d="M9 9.2c.3 2.6 2.2 4.6 4.9 5.4l1.2-1.2 1.9.8-.5 1.8c-3.9.4-8-3.4-8.1-7.6l1.8-.4.7 1.9z"/></svg>`;
function waBtn(text,label,o){o=o||{};return `<a class="btn wa${o.cls?" "+o.cls:""}" href="${esc(waURL(text,o.phone))}" target="_blank" rel="noopener noreferrer" data-wa="${esc(o.kind||"share")}">${WA_ICON}<span>${esc(label||"WhatsApp")}</span></a>`}
const first=n=>String(n||"").trim().split(/\s+/)[0]||"";
// A private-lesson request for the student to finish: the coach's name if every slot is with the same coach, then blanks for day and time.
function privAskText(slots){const cs=[...new Set((slots||[]).map(c=>(c.coach||"").trim()).filter(Boolean))];const hi=cs.length===1?first(cs[0]):"coach";
  return `Hi ${hi}, it's ${first(API.me.name)} from ${gymName()}. Could I book a private lesson?\n\nDay: \nTime: \n\nThanks!`}
const appLink=h=>location.origin+"/app/"+(h||"");
const gymName=()=>(API.me&&API.me.gym&&API.me.gym.name)||"the gym";
function classLine(c){const left=c.capacity?Math.max(0,c.capacity-c.going):null;return `${fmtTime(c.startsAt)} ${c.title}${c.level&&!c.title.includes(c.level)?` (${c.level})`:""}${left===null?"":left===0?" (full, waitlist open)":` (${left} spot${left===1?"":"s"} left)`}`}
function classesText(from,days,heading){const list=(isCoach()?COACH.classes:API.classes)||[];const out=[];
  for(let i=0;i<days;i++){const k=addDays2(from,i),cs=list.filter(c=>c.kind!=="private"&&dayKey(c.startsAt)===k&&clsEnd(c)>Date.now()).sort((a,b)=>new Date(a.startsAt)-new Date(b.startsAt));
    if(cs.length)out.push(`*${fromYmd(k).toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"short"})}*\n${cs.map(c=>"• "+classLine(c)).join("\n")}`)}
  return out.length?`${heading}\n\n${out.join("\n\n")}\n\nBook your spot in JitsFlow: ${appLink("#book")}`:""}
const WA_T={
  invite:()=>`Join ${gymName()} on JitsFlow. You can book classes, see who's training, and study every technique between sessions.\n\nTap to join (our gym code is filled in for you):\n${joinURL(API.me.gym.studentCode)}`,
  week:()=>classesText(todayK(),7,`*${gymName()}: classes this week*`)||`No classes on the calendar for the next 7 days yet.`,
  tomorrow:()=>classesText(addDays2(todayK(),1),1,`*Tomorrow at ${gymName()}*`)||`No classes on the calendar tomorrow.`,
  fees:()=>`Hi everyone, a reminder that ${new Date().toLocaleDateString(undefined,{month:"long"})} fees are due. Please use your name as the payment reference and send your proof of payment to the gym. Thank you!`,
  coach:()=>`You're invited to coach at ${gymName()} on JitsFlow. This link gives coach access (the roster and payments), so please keep it to yourself:\n${joinURL(API.me.gym.coachCode)}`,
  comp:(c)=>{if(!c)return "";const team=(c.team||[]).filter(x=>x.status==="entered");
    return `*${c.name}*\n${compDates(c)}${c.city?" · "+c.city:""}${c.registerBy?`\nRegistration closes ${fromYmd(c.registerBy).toLocaleDateString(undefined,{day:"numeric",month:"long"})}`:""}${c.fee?`\nEntry: ${c.fee}`:""}${team.length?`\n\nOur team (${team.length}): ${team.map(x=>first(x.name)).join(", ")}`:""}\n\nWant to compete? Ask in JitsFlow: ${appLink("#book")}`},
};
const WA_KINDS=[["invite","Invite students"],["week","This week's classes"],["tomorrow","Tomorrow's classes"],["fees","Fees reminder"],["comp","A competition"],["coach","Invite a coach"]];
function waPanel(){const st=S.ui.wa=S.ui.wa||{kind:"invite"};const comps=upcomingComps();if(st.kind==="comp"&&!st.comp&&comps[0])st.comp=comps[0].id;
  if(st.kind==="week"||st.kind==="tomorrow"){if(!COACH.classes)coachLoad("classes")}
  const text=st.kind==="comp"?WA_T.comp(comps.find(c=>c.id===st.comp)):WA_T[st.kind]();
  return `<section class="panel stack" id="wa-panel"><h2 class="label">WhatsApp</h2><p class="small">Pick a message, change anything you like, then open WhatsApp and choose the chat or group to send it to.</p>
    <div class="chips" role="group" aria-label="Message">${WA_KINDS.map(([k,l])=>`<button class="chip" data-a="wakind" data-v="${k}" aria-pressed="${st.kind===k}">${l}</button>`).join("")}</div>
    ${st.kind==="comp"?(comps.length?`<select id="wa-comp" aria-label="Competition">${comps.map(c=>`<option value="${c.id}"${c.id===st.comp?" selected":""}>${esc(c.name)}</option>`).join("")}</select>`:`<p class="small muted">Add a competition in Comps first.</p>`):""}
    ${st.kind==="coach"?`<p class="small warn-t">This link gives coach access. Send it only to people you trust.</p>`:""}
    <textarea id="wa-text" rows="8" aria-label="Message">${esc(text)}</textarea>
    <div class="row"><a id="wa-go" class="btn wa primary-wa" href="${esc(waURL(text))}" target="_blank" rel="noopener noreferrer" data-wa="${st.kind}">${WA_ICON}<span>Open WhatsApp</span></a><button class="btn" data-a="copytext" data-v="wa-text">Copy text</button></div></section>`}
function studentWaSection(){if(inClaude()||!API.me||!API.me.gym||isCoach())return "";const g=API.me.gym,next=(API.classes||[]).find(c=>c.myGoing&&clsEnd(c)>Date.now());
  const inv=g.inviteCode?`Come train with me at ${g.name}! I use JitsFlow to book classes and study techniques between sessions. Join here (the gym code is filled in):\n${joinURL(g.inviteCode)}`:`I'm using JitsFlow to study no-gi between classes: every position, attack chain and escape, with videos. ${location.origin}`;
  return `<section class="stack"><h2 class="label">Share on WhatsApp</h2><div class="quick">${waBtn(inv,g.inviteCode?"Invite a friend to the gym":"Tell a friend about JitsFlow",{kind:"invite_friend"})}${next?waBtn(`I'm going to ${next.title} at ${g.name}, ${fmtWhen(next.startsAt)}. Coming? Book here: ${appLink("#book")}`,"Ask someone to join my next class",{kind:"class"}):""}</div></section>`}

/* ----- training log that fills itself in from the classes you attended ----- */
const bySess=(a,b)=>(a.date===b.date?String(b.time||"").localeCompare(String(a.time||"")):a.date<b.date?1:-1);
async function autoLog(force){
  if(S.mode!=="api"||!API.me||!API.me.gym||isCoach())return;
  if(!force&&API.autoLogAt&&Date.now()-API.autoLogAt<5*60e3)return;API.autoLogAt=Date.now();
  let cs;try{cs=(await api("GET","/me/attended?days=45")).classes}catch(e){return}
  const have=new Set(S.sessions.map(s=>s.classId).filter(Boolean)),skip=new Set(P().logSkip||[]);
  const add=cs.filter(c=>!have.has(c.id)&&!skip.has(c.id)).slice(0,40);if(!add.length)return;
  let n=0,fresh=0;
  for(const c of add){const taught=(c.ids||[]).filter(id=>TM[id]);
    const s={id:"k"+c.id,classId:c.id,auto:true,date:dayKey(c.startsAt),time:c.startsAt,type:c.kind==="private"?"Private":"Class",title:c.title,coach:c.coach,focus:c.focus,mins:c.durationMin,rolls:0,taught,hits:[],tapped:[],stuck:[],worked:"",fix:""};
    // anything taught that's new to you goes into your reviews
    taught.forEach(id=>{if(lv(id)<1){P().mastery[id]=1;ensureCard(id);fresh++}});
    if(await addSession(s))n++}
  if(fresh)saveProgress();
  if(n){if(["log","today"].includes(S.ui.tab)&&!S.ui.sheet)render();toast(`Logged ${n} class${n>1?"es":""} from your bookings${fresh?`; ${fresh} new move${fresh>1?"s":""} added to your reviews`:""}.`)}
}
/* What to do next, worked out from your last few weeks of training. */
function nextSteps(){const out=[],seen=new Set();
  const st=stuckCounts(21)[0];
  if(st){const p=st[0],t=fromPos(p).filter(t=>["escape","defense","sweep","guard"].includes(t.c)).sort((a,b)=>lv(a.id)-lv(b.id))[0];if(t){seen.add(t.id);out.push({why:`You got stuck in ${POS[p].l.toLowerCase()}${st[1]>1?` ${st[1]} times`:""} lately`,t})}}
  const tc={};recent(21).forEach(s=>(s.tapped||[]).forEach(id=>{if(TM[id])tc[id]=(tc[id]||0)+1}));
  const top=Object.entries(tc).sort((a,b)=>b[1]-a[1])[0];if(top){const d=defFor(top[0]);if(d&&!seen.has(d.id)){seen.add(d.id);out.push({why:`${TM[top[0]].n} got you${top[1]>1?` ${top[1]} times`:""}`,t:d})}}
  const taught=[...new Set(S.sessions.slice().sort(bySess).slice(0,6).flatMap(s=>s.taught||[]))].filter(id=>TM[id]&&lv(id)<3&&!seen.has(id));
  if(taught.length)out.push({why:"Taught in your recent classes",ids:taught.slice(0,8)});
  return out.slice(0,3)}
function nextStepsCard(){const n=nextSteps();if(!n.length)return "";
  return `<section class="panel stack nextsteps"><h2 class="label">What to work on next</h2>${n.map(x=>`<div class="nstep"><span class="small muted">${esc(x.why)}</span>${x.t?`<button class="btn" data-a="open" data-v="${x.t.id}">Study: ${esc(x.t.n)}</button>`:`<button class="btn" data-a="reviewids" data-v="${x.ids.join(",")}">Review ${x.ids.length} move${x.ids.length>1?"s":""}: ${esc(x.ids.slice(0,2).map(i=>TM[i].n).join(", "))}${x.ids.length>2?"…":""}</button>`}</div>`).join("")}</section>`}
function sessCard(s){
  const tags=[...(s.hits||[]).filter(i=>TM[i]).map(i=>`<span class="ltag ok">✓ ${esc(TM[i].n)}</span>`),...(s.tapped||[]).filter(i=>TM[i]).map(i=>`<span class="ltag bad">Tapped: ${esc(TM[i].n)}</span>`),...(s.stuck||[]).filter(p=>POS[p]).map(p=>`<span class="ltag warn">Stuck: ${esc(POS[p].l)}</span>`)];
  const note=[s.worked,s.fix].filter(Boolean).join(" · ");
  return swipeWrap(`<div class="sess lcard"><div class="row between" style="flex-wrap:nowrap;align-items:flex-start"><div style="min-width:0"><b>${esc(s.title||s.type||"Training")}</b><div class="small muted">${esc(fmtDate(s.date))}${s.time?` · ${esc(fmtTime(s.time))}`:""}${s.coach?` · ${esc(s.coach)}`:""}${Number(s.mins)?` · ${Number(s.mins)} min`:""}${Number(s.rolls)?` · ${Number(s.rolls)} rolls`:""}</div></div><span class="pill">${s.auto?"Booked":esc(s.type||"Class")}</span></div>
    ${(s.taught||[]).filter(i=>TM[i]).length?`<div class="small"><span class="muted">Taught:</span> ${s.taught.filter(i=>TM[i]).map(i=>`<button class="linkbtn" data-a="open" data-v="${i}">${esc(TM[i].n)}</button>`).join(", ")}</div>`:s.focus?`<div class="small"><span class="muted">Focus:</span> ${esc(s.focus)}</div>`:""}
    ${tags.length?`<div class="ltags">${tags.join("")}</div>`:""}${note?`<div class="small">${esc(note)}</div>`:""}
    <div class="qtags"><button class="chip" data-a="tag" data-k="hits" data-v="${s.id}" aria-label="What worked">✓ Worked</button><button class="chip" data-a="tag" data-k="tapped" data-v="${s.id}" aria-label="What got you">Tapped</button><button class="chip" data-a="tag" data-k="stuck" data-v="${s.id}" aria-label="Where you got stuck">Stuck</button><button class="chip" data-a="tag" data-k="note" data-v="${s.id}">${note?"Note ✎":"+ Note"}</button></div>
    <div class="row" style="justify-content:flex-end;gap:14px"><button class="linkbtn small" data-a="editlog" data-v="${s.id}">Edit</button><button class="linkbtn small" style="color:var(--ink-2)" data-a="del" data-v="${s.id}">Delete</button></div></div>`,{edit:["editlog",s.id],del:["del",s.id]})}
/* Today: the last class you went to, waiting for a quick tap or two. */
function lastClassCard(){const s=S.sessions.filter(x=>x.auto).sort(bySess)[0];if(!s)return "";
  if(Date.now()-new Date(s.time||s.date).getTime()>3*864e5||(s.hits||[]).length||(s.tapped||[]).length||(s.stuck||[]).length||s.worked)return "";
  return `<section class="panel stack"><div><h2 class="label">How did it go?</h2><b>${esc(s.title||"Class")}</b> <span class="small muted">${esc(fmtDate(s.date))}${s.time?` · ${esc(fmtTime(s.time))}`:""}</span></div>
    ${(s.taught||[]).filter(i=>TM[i]).length?`<p class="small"><span class="muted">Taught:</span> ${s.taught.filter(i=>TM[i]).map(i=>esc(TM[i].n)).join(", ")}. Already in your reviews.</p>`:""}
    <div class="qtags"><button class="chip" data-a="tag" data-k="hits" data-v="${s.id}" aria-label="What worked">✓ Worked</button><button class="chip" data-a="tag" data-k="tapped" data-v="${s.id}" aria-label="What got you">Tapped</button><button class="chip" data-a="tag" data-k="stuck" data-v="${s.id}" aria-label="Where you got stuck">Stuck</button><button class="chip" data-a="tag" data-k="note" data-v="${s.id}">+ Note</button></div></section>`}
/* One sheet per tag type; every tap saves straight away. */
function tagChoices(s,k,q){const sel=new Set(s[k]||[]);q=(q||"").trim().toLowerCase();
  const first=k==="hits"?(s.taught||[]).filter(i=>TM[i]):[...new Set(recent(90).flatMap(x=>x.tapped||[]))].filter(i=>TM[i]);
  const hit=q?searchTechIds(q):null;
  const pool=(k==="tapped"?TECH.filter(t=>t.t==="sub"):TECH).filter(t=>!hit||hit.has(t.id)).map(t=>t.id);
  const chip=i=>`<button class="tchip wide" data-a="tagset" data-k="${k}" data-v="${i}" aria-pressed="${sel.has(i)}">${esc(TM[i].n)}</button>`;
  const rest=pool.filter(i=>q||!first.includes(i));
  return `${first.length&&!q?`<h2 class="label">${k==="hits"?"Taught in this class":"Got you before"}</h2><div class="tlist">${first.map(chip).join("")}</div><h2 class="label">${k==="hits"?"Anything else":"Other submissions"}</h2>`:""}<div class="tlist">${rest.slice(0,q?80:30).map(chip).join("")}</div>${!q&&rest.length>30?`<p class="small muted">Search to find more.</p>`:""}${q&&!rest.length?`<p class="small muted">Nothing matches “${esc(q)}”.</p>`:""}`}
function tagSheet(id,k){const s=S.sessions.find(x=>x.id===id);if(!s)return;S.ui.sheet={k:"tag",id,kind:k};S.ui.stack=[];
  const head={hits:"What worked?",tapped:"What got you?",stuck:"Where did you get stuck?",note:"Notes"}[k];
  const body=k==="stuck"?`<p class="small muted">Tap every position you got stuck in. JitsFlow points you to its escapes.</p><div class="tgrid2">${ORDER.map(p=>`<button class="tchip" data-a="tagset" data-k="stuck" data-v="${p}" aria-pressed="${(s.stuck||[]).includes(p)}">${esc(POS[p].l)}</button>`).join("")}</div>`
    :k==="note"?`<div class="row" style="justify-content:flex-end">${micBtn("tag-note")}</div><textarea id="tag-note" rows="6" placeholder="What clicked, what to ask your coach, how you felt…">${esc([s.worked,s.fix].filter(Boolean).join("\n"))}</textarea><p class="small muted">Saved as you type.</p>`
    :`<p class="small muted">${k==="hits"?"Tap anything you landed or that worked in rolls. It moves up your progress.":"Tap what you got caught with. JitsFlow lines up the defense."}</p><input id="tag-q" type="search" placeholder="${k==="tapped"?"Find a submission":"Find a move"}" autocomplete="off"><div id="tag-list" class="stack">${tagChoices(s,k,"")}</div>`;
  openSheet(`${sheetHead(esc(s.title||s.type||"Session"))}<div class="stack-lg"><h1>${head}</h1>${body}</div>`,false,{back:"Done"})}
let tagNoteT=null;
function tagSet(el){const sh=S.ui.sheet;if(!sh||sh.k!=="tag")return;const s=S.sessions.find(x=>x.id===sh.id);if(!s)return;const k=el.dataset.k,v=el.dataset.v;
  const arr=s[k]=(s[k]||[]).slice(),on=!arr.includes(v);if(on)arr.push(v);else arr.splice(arr.indexOf(v),1);
  document.querySelectorAll(`#sheet [data-a="tagset"][data-v="${v}"]`).forEach(b=>b.setAttribute("aria-pressed",String(on)));
  // the app learns from it: what worked moves up to "live", what got you puts its defense in your reviews
  if(on&&k==="hits"&&lv(v)<4){P().mastery[v]=4;ensureCard(v);saveProgress()}
  if(on&&k==="tapped"){const d=defFor(v);if(d){if(lv(d.id)<1)P().mastery[d.id]=1;ensureCard(d.id);P().srs[d.id].due=today();saveProgress()}}
  addSession(s)}
function tagNote(v){const sh=S.ui.sheet;if(!sh||sh.k!=="tag")return;const s=S.sessions.find(x=>x.id===sh.id);if(!s)return;s.worked=String(v).slice(0,2000);s.fix="";clearTimeout(tagNoteT);tagNoteT=setTimeout(()=>addSession(s),600)}

/* ============ DICTATION: talk instead of type (any text box with a mic button) ============ */
const SRec=window.SpeechRecognition||window.webkitSpeechRecognition;let REC=null;
function dictate(targetId,btn){const el=document.getElementById(targetId);if(!el)return;
  if(!SRec){el.focus();toast("Tap the mic on your keyboard to dictate.");return}
  if(REC){try{REC.stop()}catch(e){}return}
  let r;try{r=new SRec()}catch(e){el.focus();toast("Tap the mic on your keyboard to dictate.");return}
  REC=r;r.lang=navigator.language||"en-ZA";r.interimResults=true;r.continuous=false;
  const base=el.value&&!/\s$/.test(el.value)?el.value+" ":el.value||"";
  r.onresult=e=>{let t="";for(const res of e.results)t+=res[0].transcript;el.value=base+t;el.dispatchEvent(new Event("input",{bubbles:true}))};
  const off=()=>{REC=null;if(btn)btn.classList.remove("on")};
  r.onend=()=>{off();if(el.id==="ast-in"&&el.value.trim()&&S.ui.sheet&&S.ui.sheet.k==="ast")astSend(el.value)};
  r.onerror=e=>{off();if(e.error==="not-allowed"||e.error==="service-not-allowed")toast("Allow the microphone to dictate, or use the mic on your keyboard.")};
  if(btn)btn.classList.add("on");try{r.start()}catch(e){off()}}
const micBtn=id=>`<button type="button" class="btn mic" data-a="dictate" data-v="${id}" aria-label="Dictate" title="Dictate"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>`;

/* ============ COACH ASSISTANT: "update my bank details", "add Thabo, blue belt…" ============ */
const AST={msgs:[],busy:false};
const AST_EXAMPLES=["Update my bank details","Add a student","Thabo paid R650 cash","Add a class every Monday at 18:00 for 8 weeks","Note for Ana: great guard retention today","Move Sipho to blue belt"];
function astBubble(m){return `<div class="bub ${m.role==="user"?"me":"ai"}"><div>${esc(m.text)}</div>${(m.actions||[]).map(a=>`<span class="ltag ok">✓ ${esc(a.summary)}</span>`).join("")}</div>`}
function assistantSheet(){S.ui.sheet={k:"ast"};S.ui.stack=[];
  const intro=AST.msgs.length?"":`<div class="stack"><p>Tell me what to change, in your own words. Type it, or tap the mic and say it. I'll ask if I need anything else.</p><div class="chips">${AST_EXAMPLES.map(x=>`<button class="chip" data-a="astsay" data-v="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>`;
  openSheet(`${sheetHead("Assistant")}<div class="stack-lg"><h1>Ask JitsFlow</h1>${intro}<div class="astlog" id="astlog">${AST.msgs.map(astBubble).join("")}${AST.busy?`<div class="bub ai"><span class="dots" aria-label="Thinking"><i></i><i></i><i></i></span></div>`:""}</div></div>`,true,
    {top:`<form id="astform" class="astbar" novalidate>${micBtn("ast-in")}<input id="ast-in" placeholder="e.g. Add Thabo, blue belt, 082 123 4567" autocomplete="off" enterkeyhint="send" aria-label="Message"><button class="btn primary" type="submit"${AST.busy?" disabled":""}>Send</button></form>`});
  setTimeout(()=>{const l=document.getElementById("astlog");if(l&&l.lastElementChild)l.lastElementChild.scrollIntoView({block:"end"})},30)}
async function astSend(text){text=String(text||"").trim();if(!text||AST.busy)return;
  AST.msgs.push({role:"user",text});AST.busy=true;assistantSheet();
  try{const j=await api("POST","/coach/assistant",{messages:AST.msgs.slice(-12).map(m=>({role:m.role,text:m.text}))});
    AST.msgs.push({role:"assistant",text:j.reply,actions:j.actions||[]});if(API.me.gym.setup)API.me.gym.setup.assistantUsed=true;await astRefresh(j.refresh||[]);jfTrack("assistant",{actions:(j.actions||[]).length})}
  catch(e){AST.msgs.push({role:"assistant",text:e.message})}
  AST.busy=false;if(S.ui.sheet&&S.ui.sheet.k==="ast")assistantSheet()}
async function astRefresh(kinds){if(!kinds.length)return;
  if(kinds.includes("pay"))COACH.payInfo=undefined;COACH.money=null;
  if(kinds.some(k=>["roster","payments","classes"].includes(k)))await coachLoad();
  if(kinds.includes("me")){try{API.me=(await api("GET","/me")).me;applyBrand()}catch(e){}}}

/* ============ WEBSITE IMPORT IN THE BACKGROUND ============ */
const impHost=u=>String(u||"").replace(/^[a-z]+:\/\//i,"").replace(/^www\./i,"").split(/[/?#\s]/)[0]||"your website";
async function impStart(url){url=String(url||"").trim();if(!url){toast("Type your gym's website first, like yourgym.co.za");return}
  try{const j=await api("POST","/coach/import/start",{url});COACH.imp=j.job;impPoll();if(S.ui.tab==="coach")render();toast("Reading your website in the background. Keep going: we'll show you what we found.");jfTrack("gym_import_start",{})}
  catch(e){toast(e.message)}}
function impPoll(){clearTimeout(COACH.impT);COACH.impT=setTimeout(async()=>{let j;try{j=(await api("GET","/coach/import/job")).job}catch(e){impPoll();return}
  const was=COACH.imp&&COACH.imp.status;COACH.imp=j;
  if(j&&j.status==="running"){impPoll();return}
  if(was==="running"&&j){toast(j.status==="done"?"Your website is read. Tap Review to add what we found.":j.error);jfTrack("gym_import",{ok:j.status==="done"})}
  if(S.ui.tab==="coach"&&!S.ui.sheet)render()},4000)}
async function impLoad(){if(COACH.imp!==undefined)return;COACH.imp=null;try{COACH.imp=(await api("GET","/coach/import/job")).job;if(COACH.imp&&COACH.imp.status==="running")impPoll();if(COACH.imp&&S.ui.tab==="coach"&&!S.ui.sheet)render()}catch(e){}}
function impBanner(){const j=COACH.imp;if(!j)return "";const host=esc(impHost(j.url));
  if(j.status==="running")return `<div class="impban run"><span class="spin" aria-hidden="true"></span><span><b>Reading ${host}…</b><br><span class="small">Usually under a minute. Keep using the app.</span></span></div>`;
  if(j.status==="error")return `<div class="impban err"><span><b>Couldn't read ${host}</b><br><span class="small">${esc(j.error||"")}</span></span><span class="row"><button class="btn sm" data-a="impretry">Try again</button><button class="linkbtn small" data-a="impdismiss">Hide</button></span></div>`;
  const r=j.result||{},p=r.profile||{},n=(a,w)=>a&&a.length?`${a.length} ${w}${a.length>1?(w==="class"?"es":"s"):""}`:"";
  const found=[n(p.timetable,"class"),n(p.coaches,"coach"),n(p.rates,"price"),(r.logos||[]).length?"your logo":""].filter(Boolean);
  return `<div class="impban ok"><span><b>We read ${host}</b><br><span class="small">${found.length?`Found ${found.join(", ")}.`:"Found your details."} Nothing's added until you check it.</span></span><span class="row"><button class="btn sm primary" data-a="impreview">Review and add</button><button class="linkbtn small" data-a="impdismiss">Hide</button></span></div>`}
function impReview(){const j=COACH.imp;if(!j||j.status!=="done")return;const r=j.result||{};
  S.ui.gimp={profile:r.profile,logos:r.logos||[],logoPick:r.logos&&r.logos.length?"0":(API.me.gym.logo?"keep":"none"),method:r.method,pages:r.pages||[],dropped:r.dropped||null,imported:true,fromJob:true};drawGymEdit()}

/* ============ GETTING STARTED (new coaches) ============ */
function welcomeSheet(){S.ui.sheet={k:"welcome"};S.ui.stack=[];
  openSheet(`${sheetHead("Welcome")}<div class="stack-lg"><h1>Welcome to JitsFlow</h1><p class="lead">${esc(API.me.gym.name)} is set up. Three things to know:</p>
    <ol class="steps qrsteps"><li><span><b>Today</b> is your gym's day: classes, who's booked, and what needs you (payments to check, people who haven't paid, requests).</span></li>
    <li><span><b>Students</b>: add them one by one, from your phone's contacts, or paste a list. They don't need the app for you to track their plan and payments.</span></li>
    <li><span><b>Getting started</b> on Today walks you through the rest, one tap at a time.</span></li></ol>
    ${COACH.imp&&COACH.imp.status==="running"?`<p class="small muted">We're reading ${esc(impHost(COACH.imp.url))} in the background. It shows up on Today when it's ready.</p>`:""}</div>`,false,{back:"Let's go"});
  api("PATCH","/coach/gym",{setup:{welcomed:true}}).then(j=>{API.me=j.me}).catch(()=>{})}
function setupCard(){const st=API.me.gym.setup||{};if(st.dismissed||!COACH.roster)return "";
  if(COACH.payInfo===undefined){COACH.payInfo=null;api("GET","/coach/gym/pay").then(j=>{COACH.payInfo=j;if(S.ui.tab==="coach"&&!S.ui.sheet)render()}).catch(()=>{})}
  const p=gymProfile()||{},pay=((COACH.payInfo||{}).pay)||{},plans=(COACH.roster.plans||[]).length;
  const items=[["Your gym's details",!!((p.timetable||[]).length||(p.rates||[]).length||API.me.gym.logo),"setupgo","gym","Import your website"],
    ["Classes on the calendar",(COACH.classes||[]).some(c=>c.kind!=="private"),"setupgo","classes","Add classes"],
    ["Plans and bank details",plans>0&&!!(pay.account||pay.link),"setupgo","money","Set up"],
    ["Your students",students().length>0,"setupgo","students","Add or invite"]];
  const done=items.filter(i=>i[1]).length;if(done===items.length)return "";
  return `<section class="panel stack setupcard"><div class="row between"><h2 class="label">Getting started · ${done} of ${items.length}</h2><button class="linkbtn small" data-a="setuphide">Hide</button></div>
    <div class="progress"><i style="width:${Math.round(100*done/items.length)}%"></i></div>
    ${items.map(([l,ok,a,v,b])=>`<div class="srow${ok?" ok":""}"><span>${ok?"✓":"○"} ${esc(l)}</span>${ok?"":`<button class="btn sm" data-a="${a}" data-v="${v}">${esc(b)}</button>`}</div>`).join("")}</section>`}

/* ============ ADD STUDENTS FROM CONTACTS / A PASTED LIST ============ */
const canPickContacts=()=>!!(navigator.contacts&&navigator.contacts.select&&window.ContactsManager);
function parseVcf(txt){const un=String(txt).replace(/\r?\n[ \t]/g,"");const out=[];
  for(const card of un.split(/BEGIN:VCARD/i).slice(1)){const L=card.split(/\r?\n/);const get=re=>{for(const l of L){const m=l.match(re);if(m)return m[1].trim()}return ""};
    let name=get(/^(?:item\d+\.)?FN[^:]*:(.+)$/i);if(!name){const n=get(/^(?:item\d+\.)?N[^:]*:(.+)$/i);if(n){const [ln,fn]=n.split(";");name=[fn,ln].filter(Boolean).join(" ")}}
    const tel=get(/^(?:item\d+\.)?TEL[^:]*:(.+)$/i),email=get(/^(?:item\d+\.)?EMAIL[^:]*:(.+)$/i);
    if(name&&(tel||email))out.push({name:name.replace(/\\,/g,",").replace(/\\/g,""),phone:tel,email})}
  return out}
function parseList(txt){const out=[];
  for(const raw of String(txt).split(/\r?\n/)){const l=raw.trim();if(!l)continue;
    const email=(l.match(/[^\s,;<>]+@[^\s,;<>]+\.[a-z]{2,}/i)||[""])[0],phone=(l.replace(email,"").match(/\+?\d[\d\s().-]{6,}\d/)||[""])[0];
    const name=l.replace(email,"").replace(phone,"").replace(/[<>(),;:|\t-]+/g," ").replace(/\s+/g," ").trim();
    if(name&&(phone||email))out.push({name,phone:phone.trim(),email})}
  return out}
function bulkSheet(people){const prev=S.ui.bulk||{people:[],pick:[]};if(!people)people=prev.people;const keep=people.length>=prev.people.length&&prev.people.every((p,i)=>people[i]===p);S.ui.bulk={people,pick:people.map((_,i)=>keep&&i<prev.pick.length?prev.pick[i]:true)};const b=S.ui.bulk;S.ui.sheet={k:"bulk"};S.ui.stack=[];
  const n=b.pick.filter(Boolean).length;
  openSheet(`${sheetHead("Add students")}<div class="stack-lg"><h1>Add students</h1>
    ${canPickContacts()?`<button class="btn primary" data-a="pickcontacts">Choose from my contacts</button>`:`<p class="small muted">iPhone: in Contacts, select the people (or a list), tap Share and save the file, then choose it below. Or paste names and numbers.</p>`}
    <label class="btn" for="vcf-in" style="cursor:pointer">Choose a contacts file (.vcf)</label><input type="file" id="vcf-in" accept=".vcf,text/vcard,text/x-vcard" hidden>
    <label class="f">Or paste a list, one person per line<textarea id="bulk-paste" rows="5" placeholder="Thabo Mokoena 082 123 4567&#10;Lerato Dlamini, lerato@gmail.com"></textarea></label><button class="btn" data-a="bulkparse">Read the list</button>
    ${b.people.length?`<section class="stack"><h2 class="label">${b.people.length} found · tap to leave someone out</h2><div class="list">${b.people.map((p,i)=>`<button class="trow bulkrow" data-a="bulkpick" data-v="${i}" aria-pressed="${!!b.pick[i]}" style="grid-template-columns:auto minmax(0,1fr)"><span class="bx">${b.pick[i]?"✓":""}</span><span><span class="nm">${esc(p.name)}</span><span class="meta">${esc([p.phone,p.email].filter(Boolean).join(" · "))}</span></span></button>`).join("")}</div></section>`:""}
  </div>`,true,{act:`<button class="btn primary grow" data-a="bulkadd"${n?"":" disabled"}>${n?`Add ${n} student${n>1?"s":""}`:"Add students"}</button>`})}
async function pickContacts(){try{const cs=await navigator.contacts.select(["name","tel","email"],{multiple:true});
  const ppl=cs.map(c=>({name:(c.name||[])[0]||"",phone:(c.tel||[])[0]||"",email:(c.email||[])[0]||""})).filter(p=>p.name&&(p.phone||p.email));
  bulkSheet(((S.ui.bulk||{}).people||[]).concat(ppl));if(!ppl.length)toast("None of those had a name with a number or email.")}catch(e){}}
async function bulkAdd(){const b=S.ui.bulk;if(!b)return;const people=b.people.filter((_,i)=>b.pick[i]);if(!people.length)return;
  try{const j=await api("POST","/coach/students/bulk",{people});hideSheet();S.ui.bulk=null;await coachLoad("roster");COACH.money=null;coachGo("students");
    toast(`Added ${j.added} student${j.added===1?"":"s"}${j.skipped?`; ${j.skipped} already on your list`:""}.`);jfTrack("bulk_students",{added:j.added})}catch(e){toast(e.message)}}

/* ============ THE GYM'S LOOK: their logo up top and their colour, still JitsFlow underneath ============ */
const hex2rgb=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)),rgb2hex=c=>"#"+c.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0")).join("");
const lumin=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};const [r,g,b]=c.map(f);return .2126*r+.7152*g+.0722*b};
const contrast=(a,b)=>{const x=lumin(a),y=lumin(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
function brandVars(accent){const c=hex2rgb(accent),W=[255,255,255],B=[12,18,32],LB=[238,241,245],DB=[12,15,20];
  let light=c,i=0;while(contrast(light,W)<4.5&&i++<20)light=mix(light,[0,0,0],.08);
  let dark=c;i=0;while(contrast(dark,DB)<5&&i++<20)dark=mix(dark,W,.1);
  return {light:{blue:rgb2hex(light),soft:rgb2hex(mix(LB,light,.14)),on:"#ffffff"},dark:{blue:rgb2hex(dark),soft:rgb2hex(mix([21,26,34],dark,.22)),on:rgb2hex(B)}}}
function applyBrand(){let st=document.getElementById("brandcss");const a=API.me&&API.me.gym&&API.me.gym.brand&&API.me.gym.brand.accent;
  if(!a){if(st)st.remove();return}
  if(!st){st=document.createElement("style");st.id="brandcss";document.head.appendChild(st)}
  const v=brandVars(a),L=`--blue:${v.light.blue};--blue-soft:${v.light.soft};--on-blue:${v.light.on}`,D=`--blue:${v.dark.blue};--blue-soft:${v.dark.soft};--on-blue:${v.dark.on}`;
  st.textContent=`:root{${L}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${D}}}:root[data-theme="dark"]{${D}}`;
  const m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",v.light.blue)}
/* the logo's main colour (skipping white, black and greys), to offer as the app colour */
function logoAccent(src){return new Promise(ok=>{const im=new Image();im.onload=()=>{try{const c=document.createElement("canvas"),n=48;c.width=n;c.height=n;const x=c.getContext("2d");x.drawImage(im,0,0,n,n);
  const d=x.getImageData(0,0,n,n).data,bins={};for(let i=0;i<d.length;i+=4){if(d[i+3]<128)continue;const r=d[i],g=d[i+1],b=d[i+2],mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/510,s=mx===mn?0:(mx-mn)/(255-Math.abs(mx+mn-255));
    if(s<.35||l<.12||l>.85)continue;const k=[r,g,b].map(v=>v>>5).join(",");(bins[k]=bins[k]||{n:0,c:[0,0,0]}).n++;bins[k].c=bins[k].c.map((v,j)=>v+[r,g,b][j])}
  const top=Object.values(bins).sort((a,b)=>b.n-a.n)[0];ok(top&&top.n>20?rgb2hex(top.c.map(v=>v/top.n)):null)}catch(e){ok(null)}};im.onerror=()=>ok(null);im.src=src})}
async function brandFromLogo(silent){if(!API.me.gym.logo)return;const a=await logoAccent(API.me.gym.logo);if(!a)return;
  try{const j=await api("PATCH","/coach/gym",{brandAccent:a});API.me=j.me;applyBrand();render();if(!silent)toast("App colour matched to your logo.")}catch(e){}}
const BRAND_SWATCHES=["#1d4fb5","#c62828","#2e7d32","#6a1b9a","#ef6c00","#00838f","#111827"];
function lookPanel(){const cur=(API.me.gym.brand||{}).accent||"";
  return `<div class="panel stack"><h2 class="label">Look</h2><p class="small">Your logo shows at the top of the app for you and your students, and buttons use your colour. The rest stays JitsFlow.</p>
    <div class="row" style="gap:8px">${(API.me.gym.logo?[`<button class="swatch fromlogo" data-a="brandlogo" title="Match my logo" aria-label="Match my logo"><img src="${esc(API.me.gym.logo)}" alt=""></button>`]:[]).join("")}${BRAND_SWATCHES.map(c=>`<button class="swatch" data-a="brandset" data-v="${c}" style="--sw:${c}" aria-pressed="${cur===c}" aria-label="Use ${c}"></button>`).join("")}<button class="swatch none" data-a="brandset" data-v="" aria-pressed="${!cur}" aria-label="JitsFlow blue">JF</button></div></div>`}
