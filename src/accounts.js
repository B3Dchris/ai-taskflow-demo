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
  try{const j=await api("GET","/me");API.on=true;API.me=j.me;api("GET","/status").then(x=>{API.status=x}).catch(()=>{});if(API.me)await startSync()}
  catch(e){API.on=false}
  const qs=new URLSearchParams(location.search),want=qs.has("signin")?"login":qs.has("start")?"gym":null;
  if(want){try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}
    if(API.on&&!API.me){S.ui.authMode=want;setTimeout(authSheet,50)}else if(!API.on)setTimeout(()=>toast("Sign-in isn't switched on for this site yet."),400)}
  const rt=qs.get("reset");
  if(rt){try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}
    if(API.on){S.ui.authMode="reset";S.ui.resetTok=rt;setTimeout(authSheet,50)}}
  const q=qs.get("join");
  if(q){try{history.replaceState(null,"",location.pathname+location.hash)}catch(e){}
    if(API.on&&!API.me){S.ui.authMode="register";S.ui.authCode=q.toUpperCase();setTimeout(authSheet,50)}
    else if(API.me&&!API.me.gym){S.ui.joinCode=q.toUpperCase()}}
  render();
}
let apTimer=null,apDirty=false;
async function startSync(){
  S.mode="api";setSync("Saved to your account","db");
  try{
    const [p,l]=await Promise.all([api("GET","/progress"),api("GET","/logs")]);
    if(p.data){S.progress=normalize(p.data);lsSet("rtb.progress",S.progress)}else{await api("PUT","/progress",{data:clone(S.progress)})}
    const have=new Set(l.logs.map(x=>x.id));const extra=S.sessions.filter(x=>x&&x.id&&!have.has(x.id));
    for(const s of extra.slice(0,200)){try{await api("PUT","/logs/"+encodeURIComponent(s.id),{data:s})}catch(e){}}
    S.sessions=[...l.logs,...extra];lsSet("rtb.sessions",S.sessions);
  }catch(e){setSync("Saved on this device","err");toast("Couldn't reach your account. Changes are kept on this device for now.")}
}
function apiSaveProgress(){clearTimeout(apTimer);apTimer=setTimeout(async()=>{apTimer=null;try{await api("PUT","/progress",{data:clone(S.progress)});apDirty=false;if(S.syncState==="err")setSync("Saved to your account","db")}catch(e){apDirty=true;setSync("Offline: saved on this device","err")}},700)}
addEventListener("online",()=>{if(S.mode==="api"&&apDirty)apiSaveProgress()});
async function signedIn(me){API.me=me;API.classes=null;GYM.data=null;await startSync();hideSheet();maybeOnboardAfterSync();go(isCoach()?"coach":"today");toast(`Signed in as ${me.name}.`)}
function maybeOnboardAfterSync(){S.ui.obChecked=false;if(!P().settings.onboarded)maybeOnboard()}
async function signOut(){try{await api("POST","/auth/logout",{})}catch(e){}API.me=null;API.classes=null;GYM.data=null;COACH.roster=COACH.classes=COACH.payments=null;S.mode="local";setSync("Saved on this device","local");go("today");toast("Signed out. Your progress stays saved to your account.")}

/* ----- account sheets ----- */
function authSheet(){
  const m=S.ui.authMode||"login",c=S.ui.authCode||"";S.ui.sheet={k:"auth"};S.ui.stack=[];
  if(m==="forgot"||m==="reset")return resetSheet(m);
  const tabs=[["login","Sign in"],["register","Create account"],["gym","Start a gym"]];
  openSheet(`${sheetHead("Your account")}<div class="stack-lg"><h1>${m==="gym"?"Start your gym":m==="register"?"Create your account":"Sign in"}</h1>
   <div class="seg3">${tabs.map(([k,l])=>`<button type="button" data-a="authmode" data-v="${k}" aria-pressed="${m===k}">${l}</button>`).join("")}</div>
   <p class="muted">${m==="gym"?"For coaches. You'll get an invite link to send your students.":m==="register"?"Save your progress online and use it on any device. Got a code from your coach? Add it to join your gym.":"Pick up where you left off on any device."}</p>
   <form id="authform" class="stack" novalidate>
    ${m==="gym"?`<label class="f">Gym name<input id="a-gym" name="gym" autocomplete="organization" required></label>`:""}
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
    const j=m==="gym"?await api("POST","/auth/start-gym",{gym:v("gym"),name:v("name"),email:v("email"),password:v("password")})
      :m==="register"?await api("POST","/auth/register",{name:v("name"),email:v("email"),password:v("password"),code:v("code")})
      :await api("POST","/auth/login",{email:v("email"),password:v("password")});
    await signedIn(j.me);
  }catch(e){toast(e.message);if(btn){btn.disabled=false;btn.textContent=m==="gym"?"Start gym":m==="register"?"Create account":"Sign in"}}
}
function accountSection(){
  if(inClaude()||!API.on)return "";
  if(!API.me)return `<section class="panel accent"><h2 class="label">Your account</h2><p>Save your progress online so it's safe and on every device. Coaches can start a gym and invite students.</p>
    <div class="row"><button class="btn primary" data-a="auth" data-v="register">Create account</button><button class="btn" data-a="auth" data-v="login">Sign in</button><button class="btn" data-a="auth" data-v="gym">Start a gym</button></div></section>`;
  const g=API.me.gym;
  return `<section class="panel"><h2 class="label">Your account</h2><div><b>${esc(API.me.name)}</b><br><span class="small muted">${esc(API.me.email)}</span></div>
    ${g?`<p class="small">${API.me.role==="coach"?"Coach at":"Training at"} <b>${esc(g.name)}</b></p>`:`<form id="joinform" class="row" style="flex-wrap:nowrap"><input id="j-code" name="code" placeholder="Gym code from your coach" value="${esc(S.ui.joinCode||"")}" autocapitalize="characters" style="flex:1"><button class="btn" type="submit">Join gym</button></form>`}
    <div class="row"><button class="btn" data-a="signout">Sign out</button>${S.ui.delOpen?"":`<button class="btn danger" data-a="delacct">Delete account</button>`}</div>
    ${S.ui.delOpen?`<form id="delform" class="stack"><p class="small">This permanently deletes your account, progress, training log and attendance from the server. Type your password to confirm.</p><input id="d-pass" name="password" type="password" autocomplete="current-password" placeholder="Password"><div class="row"><button class="btn danger" type="submit">Delete everything</button><button class="btn" type="button" data-a="delcancel">Keep my account</button></div></form>`:""}</section>`;
}

/* ----- next class (students and coaches) ----- */
async function loadClasses(force){if(!API.me||!API.me.gym)return;if(!force&&API.classes&&Date.now()-API.classesAt<60000)return;
  try{const j=await api("GET","/classes");API.classes=j.classes;API.classesAt=Date.now();if(S.ui.tab==="today")render()}catch(e){}}
function nextClassCard(){
  if(inClaude()||!API.me||!API.me.gym)return "";
  if(!API.classes){loadClasses();return ""}
  const up=API.classes.filter(c=>new Date(c.startsAt).getTime()+c.durationMin*6e4>Date.now());
  if(!up.length){if(!GYM.data)loadGym();const tu=ttUpcoming(3);
    return `<section class="panel"><h2 class="label">Next class</h2>${tu.length?`<div class="stack">${tu.map(x=>`<div class="ttline"><span class="mono">${x.k===0?"Today":x.k===1?"Tomorrow":TTD[(x.at.getDay()+6)%7]} ${esc(x.r.start)}</span><span>${esc(x.r.title)}${x.r.coach?` <span class="small muted">· ${esc(x.r.coach)}</span>`:""}</span></div>`).join("")}</div><p class="small muted">From ${esc(API.me.gym.name)}'s timetable.${isCoach()?" Add these to Classes from the Coach tab › Gym so students can say they're coming.":""}</p>`:`<p class="muted">No classes scheduled yet${isCoach()?". Plan one in the Coach tab.":"."}</p>`}</section>`}
  const c=up[0],p=c.plan||{};
  return `<section class="panel nextclass"><div class="row between"><h2 class="label">Next class</h2><span class="small muted mono">${c.going} going</span></div>
    <div><h3>${esc(c.title)}</h3><p class="small muted">${esc(fmtWhen(c.startsAt))} · ${c.durationMin} min</p></div>
    ${p.focus||p.ids&&p.ids.length||p.notes?`<div class="stack"><div class="small"><b>Coach's plan${p.focus?": "+esc(p.focus):""}</b></div>${(p.ids||[]).filter(id=>TM[id]).length?`<div class="list">${p.ids.filter(id=>TM[id]).map(id=>tRow(TM[id])).join("")}</div>`:""}${p.notes?`<p class="small">${esc(p.notes)}</p>`:""}<p class="small muted">Study these before class: read the steps and watch the videos.</p></div>`:""}
    ${isCoach()?"":`<div class="row"><button class="btn${c.myGoing?"":" primary"}" data-a="rsvp" data-v="${c.id}" data-going="${c.myGoing?0:1}">${c.myGoing?"Can't make it":"I'm going"}</button>${c.myGoing?`<span class="small" style="color:var(--good);font-weight:700">✓ You're going</span>`:""}</div>`}
    ${up.length>1?`<p class="small muted">Then: ${up.slice(1,3).map(x=>esc(x.title)+" ("+esc(fmtWhen(x.startsAt))+")").join(", ")}</p>`:""}</section>`;
}
function accountNudge(){if(inClaude()||!API.on||API.me)return "";
  return `<section class="panel"><h2 class="label">Keep your progress safe</h2><p class="small">Right now it's only on this phone. Create a free account to save it online and join your gym's classes.</p><div class="row"><button class="btn primary" data-a="auth" data-v="register">Create account</button><button class="btn" data-a="auth" data-v="login">Sign in</button></div></section>`}

/* ----- coach dashboard ----- */
async function coachLoad(what){
  COACH.loading=true;
  try{
    if(!what||what==="roster")COACH.roster=await api("GET","/coach/roster");
    if(!what||what==="classes"){const from=new Date(Date.now()-21*864e5).toISOString(),to=new Date(Date.now()+90*864e5).toISOString();COACH.classes=(await api("GET",`/classes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).classes;API.classes=null}
    if(!what||what==="payments")COACH.payments=(await api("GET","/coach/payments")).payments;
  }catch(e){toast(e.message)}
  COACH.loading=false;if(S.ui.tab==="coach")render();
}
function viewCoach(){
  if(!isCoach())return `${header()}<div class="empty">The Coach tab is for coaches. Start a gym in Settings to use it.</div>`;
  if(!COACH.roster&&!COACH.loading)coachLoad();
  const v=COACH.view,tabs=[["classes","Classes"],["roster","Roster"],["payments","Payments"],["gym","Gym"]];
  const body=!COACH.roster?`<div class="empty">Loading your gym…</div>`:v==="roster"?coachRoster():v==="payments"?coachPayments():v==="gym"?coachGym():coachClasses();
  return `${header()}<div class="stack-lg"><section class="stack"><div class="gymhead">${API.me.gym.logo?`<img src="${esc(API.me.gym.logo)}" alt="" class="gymlogo sm">`:""}<h1 style="font-size:34px">${esc(API.me.gym.name)}</h1></div>
    <div class="seg4">${tabs.map(([k,l])=>`<button data-a="coachview" data-v="${k}" aria-pressed="${v===k}">${l}</button>`).join("")}</div></section>${body}</div>`;
}
const students=()=>(COACH.roster?.people||[]).filter(p=>p.role==="student");
function coachClasses(){
  const now=Date.now(),cs=COACH.classes||[];const up=cs.filter(c=>new Date(c.startsAt).getTime()+c.durationMin*6e4>=now),past=cs.filter(c=>new Date(c.startsAt).getTime()+c.durationMin*6e4<now).reverse();
  const card=c=>`<button class="classcard" data-a="classopen" data-v="${c.id}"><span><b>${esc(c.title)}</b><br><span class="small muted">${esc(fmtWhen(c.startsAt))} · ${c.durationMin} min${c.plan&&c.plan.focus?" · "+esc(c.plan.focus):""}</span></span><span class="going mono">${c.going}<small>going</small></span></button>`;
  return `<section class="stack"><button class="btn primary full" data-a="classnew">+ Plan a class</button>
    <h2 class="label">Coming up</h2>${up.length?`<div class="stack">${up.map(card).join("")}</div>`:`<div class="empty">No classes planned. Plan the next few weeks so students can say they're coming.</div>`}
    ${past.length?`<h2 class="label">Recent</h2><div class="stack">${past.slice(0,8).map(card).join("")}</div>`:""}</section>`;
}
function classForm(c){
  const d=c?new Date(c.startsAt):new Date(Date.now()+864e5);const pad2=n=>String(n).padStart(2,"0");
  const date=`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`,time=c?`${pad2(d.getHours())}:${pad2(d.getMinutes())}`:"18:00";
  S.ui.cplan=S.ui.cplan||{ids:(c&&c.plan&&c.plan.ids||[]).slice()};
  const picked=S.ui.cplan.ids.filter(id=>TM[id]).map(id=>`<button type="button" class="chip" data-a="cplanrm" data-v="${id}">${esc(TM[id].n)} <span class="x">×</span></button>`).join("");
  S.ui.sheet={k:"classform",id:c&&c.id};S.ui.stack=[];
  openSheet(`${sheetHead(c?"Edit class":"Plan a class")}<form id="classform" class="stack-lg" novalidate>
    <label class="f">Title<input id="c-title" name="title" value="${esc(c?c.title:"No-gi fundamentals")}"></label>
    <div class="grid3"><label class="f">Date<input id="c-date" name="date" type="date" value="${date}"></label><label class="f">Time<input id="c-time" name="time" type="time" value="${time}"></label><label class="f">Minutes<input id="c-dur" name="dur" type="number" inputmode="numeric" min="15" max="600" value="${c?c.durationMin:90}"></label></div>
    <label class="f">Focus<input id="c-focus" name="focus" value="${esc(c&&c.plan?c.plan.focus||"":"")}" placeholder="e.g. Half guard bottom: underhook and dogfight"></label>
    <div class="stack"><label class="f" for="c-add">Techniques to teach</label><select id="c-add" data-cplan="1"><option value="">Add a technique…</option>${techOptions()}</select><div class="chips" id="cplan-chips">${picked}</div></div>
    <label class="f">Notes<textarea id="c-notes" name="notes" placeholder="Warm-up, drills, positional rounds…">${esc(c&&c.plan?c.plan.notes||"":"")}</textarea></label>
    <label class="row small"><input id="c-shared" name="shared" type="checkbox" style="width:auto"${!c||c.shared?" checked":""}> Show the plan to students so they can study before class</label>
    ${c?`<button class="btn danger" type="button" data-a="classdel" data-v="${c.id}">Delete class</button>`:""}
  </form>`,false,{act:`<button class="btn primary grow" type="submit" form="classform">${c?"Save class":"Plan class"}</button>`});
}
async function submitClass(form){
  const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  const when=new Date(`${v("date")}T${v("time")||"18:00"}`);if(isNaN(when)){toast("Pick a date and time.");return}
  const body={title:v("title"),startsAt:when.toISOString(),durationMin:Number(v("dur"))||60,shared:form.querySelector("[name=shared]").checked,plan:{focus:v("focus"),notes:v("notes"),ids:(S.ui.cplan||{ids:[]}).ids}};
  try{const id=S.ui.sheet&&S.ui.sheet.id;await api(id?"PUT":"POST",id?`/classes/${id}`:"/classes",body);S.ui.cplan=null;hideSheet();toast(id?"Class saved.":"Class planned. Students can see it now.");COACH.view="classes";await coachLoad("classes");go("coach")}
  catch(e){toast(e.message)}
}
async function classSheet(id){
  S.ui.sheet={k:"class",id};S.ui.stack=[];
  openSheet(`${sheetHead("Class")}<div class="empty">Loading who's coming…</div>`);
  let j;try{j=await api("GET",`/coach/classes/${id}`)}catch(e){toast(e.message);hideSheet();render();return}
  S.ui.classData=j;drawClassSheet();
}
function drawClassSheet(keep){
  const {class:c,attendees}=S.ui.classData;const going=attendees.filter(a=>a.going);
  const rows=attendees.map(a=>{const g=goalOf(a),ar=areasFor(a.mastery,g),lo=ar.slice().sort((x,y)=>x.pct-y.pct)[0];
    return `<div class="attrow"><div><b>${esc(a.name)}</b> ${beltChip(a.belt,a.stripes)}<br><span class="small muted">${readinessFor(a.mastery,g)}% ready for ${BELT[g].to}${lo?" · weakest: "+esc(lo.n):""}</span></div>
      <button class="chip" data-a="attend" data-v="${a.id}" aria-pressed="${!!a.attended}">${a.attended?"✓ Here":"Mark here"}</button></div>`}).join("");
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
    <section class="stack"><div class="row between"><h2 class="label">Who's coming</h2><span class="small muted mono">${going.length} going</span></div>${rows||`<div class="empty">Nobody has said they're coming yet. Students tap "I'm going" on their Today screen.</div>`}</section>
  </div>`,keep,{act:`<button class="btn grow" data-a="classedit" data-v="${c.id}">Edit plan</button>`});
}
function coachRoster(){
  const ppl=students(),cur=COACH.roster.currency,q=COACH.q.trim().toLowerCase();
  const due=ppl.filter(p=>p.active&&p.feeCents>0&&p.paidThisMonthCents<p.feeCents);
  const list=ppl.filter(p=>!q||p.name.toLowerCase().includes(q));
  return `<section class="stack"><div class="stats"><div class="stat"><b>${ppl.filter(p=>p.active).length}</b><span>Students</span></div><div class="stat"><b>${ppl.filter(p=>p.attended30>0||p.n30>0).length}</b><span>Trained · 30d</span></div><div class="stat"><b>${due.length}</b><span>Fees due</span></div></div>
    <input id="r-q" type="search" placeholder="Search students" value="${esc(COACH.q)}" aria-label="Search students">
    <div class="list" id="roster-list">${list.map(p=>{const g=goalOf(p),r=readinessFor(p.mastery,g),paid=p.feeCents>0?(p.paidThisMonthCents>=p.feeCents?`<span class="pill ok">Paid</span>`:`<span class="pill due">Due</span>`):"";
      return `<button class="trow" data-a="student" data-v="${p.id}" style="grid-template-columns:minmax(0,1fr) auto"><span><span class="nm">${esc(p.name)}${p.active?"":" (inactive)"}</span><span class="meta">${beltChip(p.belt,p.stripes)}<span>${r}% → ${BELT[g].to}</span><span>${p.last?"Trained "+esc(fmtDate(p.last)):"No sessions yet"}</span></span></span>${paid}</button>`}).join("")||`<div class="empty">No students yet. Send them your invite link from the Gym tab.</div>`}</div></section>`;
}
async function studentSheet(id){
  S.ui.sheet={k:"student",id};S.ui.stack=[];openSheet(`${sheetHead("Student")}<div class="empty">Loading…</div>`);
  let j;try{j=await api("GET",`/coach/students/${id}`)}catch(e){toast(e.message);hideSheet();render();return}
  const s=j.student,g=goalOf(s),ar=areasFor(s.mastery,g),cur=COACH.roster.currency;
  const stuck=Object.entries(s.stuck||{}).filter(([k])=>POS[k]).sort((a,b)=>b[1]-a[1]).slice(0,3),tapped=Object.entries(s.tapped||{}).filter(([k])=>TM[k]).sort((a,b)=>b[1]-a[1]).slice(0,3);
  openSheet(`${sheetHead("Student")}<div class="stack-lg"><div><h1>${esc(s.name)}</h1><p class="muted small">${esc(s.email)}</p></div>
    <section class="beltwrap"><div class="row between"><div><div class="bignum mono">${readinessFor(s.mastery,g)}%</div><p class="muted small">Ready for ${BELT[g].to} belt</p></div>${beltChip(s.belt,s.stripes)}</div>
      <div class="areas">${ar.map(x=>`<div class="area"><span>${esc(x.n)}</span><span class="track"><span class="fill" style="width:${x.pct}%"></span></span><span class="mono">${x.pct}%</span></div>`).join("")}</div>
      <p class="small muted">${s.n30} sessions logged and ${s.attended30} classes attended in the last 30 days.${stuck.length?" Stuck in: "+stuck.map(([k,n])=>esc(POS[k].l)+" ×"+n).join(", ")+".":""}${tapped.length?" Tapped by: "+tapped.map(([k,n])=>esc(TM[k].n)+" ×"+n).join(", ")+".":""}</p></section>
    <form id="studentform" class="stack"><h2 class="label">Rank, fee and notes</h2>
      <div class="grid2"><label class="f">Belt<select id="s-belt" name="belt">${["white","blue","purple","brown","black"].map(b=>`<option value="${b}"${s.belt===b?" selected":""}>${b[0].toUpperCase()+b.slice(1)}</option>`).join("")}</select></label>
      <label class="f">Stripes<select id="s-stripes" name="stripes">${[0,1,2,3,4].map(n=>`<option${s.stripes===n?" selected":""}>${n}</option>`).join("")}</select></label></div>
      <label class="f">Monthly fee (${esc(cur)})<input id="s-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="${(s.feeCents||0)/100}"></label>
      <label class="f">Coach notes (only coaches see these)<textarea id="s-notes" name="notes">${esc(s.notes||"")}</textarea></label>
      <label class="row small"><input id="s-active" name="active" type="checkbox" style="width:auto"${s.active?" checked":""}> Active student</label></form>
    <section class="stack"><div class="row between"><h2 class="label">Payments</h2><button class="btn" data-a="paynew" data-v="${s.id}">Record payment</button></div>
      ${j.payments.length?`<div class="list">${j.payments.map(p=>`<div class="sess"><div class="row between"><b>${money(p.amountCents,p.currency)}</b><span class="small muted">${esc(fmtDate(p.paidOn))}</span></div>${p.reference?`<span class="small muted">${esc(p.reference)}</span>`:""}</div>`).join("")}</div>`:`<div class="empty">No payments recorded.</div>`}</section>
    <section class="stack"><h2 class="label">Recent sessions</h2>${j.logs.length?j.logs.slice(0,8).map(l=>`<div class="sess"><b>${esc(fmtDate(l.date))} · ${esc(l.type||"Class")}</b><span class="small muted">${Number(l.mins)||0} min · ${Number(l.rolls)||0} rolls${(l.tapped||[]).filter(i=>TM[i]).length?" · tapped by "+l.tapped.filter(i=>TM[i]).map(i=>esc(TM[i].n)).join(", "):""}</span>${l.fix?`<span class="small">Fix: ${esc(l.fix)}</span>`:""}</div>`).join(""):`<div class="empty">No sessions logged yet.</div>`}</section>
  </div>`,false,{act:`<button class="btn primary grow" type="submit" form="studentform">Save</button>`});
}
async function submitStudent(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value;const id=S.ui.sheet.id;
  try{await api("PATCH",`/coach/students/${id}`,{belt:v("belt"),stripes:Number(v("stripes")),feeCents:Math.round(Number(v("fee")||0)*100),notes:v("notes"),active:form.querySelector("[name=active]").checked});
    toast("Student saved.");hideSheet();await coachLoad("roster");go("coach")}catch(e){toast(e.message)}}
function coachPayments(){
  const ps=COACH.payments||[],cur=COACH.roster.currency,ppl=students(),byId=Object.fromEntries((COACH.roster.people||[]).map(p=>[p.id,p]));
  const mStart=new Date();mStart.setDate(1);const mk=ds(mStart);const month=ps.filter(p=>p.paidOn>=mk);
  const due=ppl.filter(p=>p.active&&p.feeCents>0&&p.paidThisMonthCents<p.feeCents);const unmatched=ps.filter(p=>!p.userId);
  return `<section class="stack"><div class="stats"><div class="stat"><b>${money(month.reduce((s,p)=>s+p.amountCents,0),cur)}</b><span>This month</span></div><div class="stat"><b>${ppl.filter(p=>p.active&&p.feeCents>0).length-due.length}</b><span>Paid</span></div><div class="stat"><b>${due.length}</b><span>Due</span></div></div>
    <button class="btn primary full" data-a="paynew">Record a payment</button>
    <div class="panel"><h2 class="label">Proof-of-payment emails</h2><p class="small">Coming next: forward bank proof-of-payment emails to your JitsFlow address and they're recorded and matched to the student automatically. Until then, record payments here.</p></div>
    ${unmatched.length?`<h2 class="label">Not matched to a student (${unmatched.length})</h2><div class="list">${unmatched.map(p=>`<div class="sess"><div class="row between"><b>${money(p.amountCents,p.currency)}</b><span class="small muted">${esc(fmtDate(p.paidOn))}</span></div><span class="small muted">${esc(p.reference||p.emailSubject||"")}</span><select data-assign="${p.id}" aria-label="Assign to a student"><option value="">Assign to…</option>${ppl.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></div>`).join("")}</div>`:""}
    ${due.length?`<h2 class="label">Due this month</h2><div class="list">${due.map(p=>`<button class="trow" data-a="student" data-v="${p.id}" style="grid-template-columns:minmax(0,1fr) auto"><span><span class="nm">${esc(p.name)}</span><span class="meta">${money(p.paidThisMonthCents,cur)} of ${money(p.feeCents,cur)} paid</span></span><span class="pill due">Due</span></button>`).join("")}</div>`:""}
    <h2 class="label">Recent payments</h2>${ps.filter(p=>p.userId).length?`<div class="list">${ps.filter(p=>p.userId).slice(0,40).map(p=>`<div class="sess"><div class="row between"><b>${esc((byId[p.userId]||{}).name||"Former student")}</b><b class="mono">${money(p.amountCents,p.currency)}</b></div><span class="small muted">${esc(fmtDate(p.paidOn))}${p.reference?" · "+esc(p.reference):""}${p.source==="email"?" · from email":""}</span></div>`).join("")}</div>`:`<div class="empty">No payments recorded yet.</div>`}</section>`;
}
function paySheet(forId){
  const ppl=students(),cur=COACH.roster.currency;S.ui.sheet={k:"pay",back:forId};S.ui.stack=[];
  openSheet(`${sheetHead("Record a payment")}<form id="payform" class="stack-lg" novalidate>
    <label class="f">Student<select id="p-user" name="user"><option value="">Not sure yet</option>${ppl.map(s=>`<option value="${s.id}"${s.id===forId?" selected":""}>${esc(s.name)}</option>`).join("")}</select></label>
    <div class="grid2"><label class="f">Amount (${esc(cur)})<input id="p-amt" name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${forId?((ppl.find(s=>s.id===forId)||{}).feeCents||0)/100:""}"></label><label class="f">Date paid<input id="p-date" name="date" type="date" value="${today()}"></label></div>
    <label class="f">Reference<input id="p-ref" name="ref" placeholder="e.g. CHRIS NOV"></label>
    <label class="f">Note<input id="p-note" name="note"></label></form>`,false,{act:`<button class="btn primary grow" type="submit" form="payform">Record payment</button>`});
}
async function submitPay(form){const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"";
  try{await api("POST","/coach/payments",{userId:v("user")||null,amountCents:Math.round(Number(v("amount"))*100),paidOn:v("date"),reference:v("ref"),note:v("note")});
    toast("Payment recorded.");hideSheet();await coachLoad();go("coach")}catch(e){toast(e.message)}}
function coachGym(){const g=API.me.gym;
  return `<section class="stack">${gymCard(true)}${gymImportPanel()}${gymClassesPanel()}<div class="panel"><h2 class="label">Invite students</h2><p class="small">Send this link. It opens JitsFlow with your gym code filled in.</p><div class="codebox mono">${esc(joinURL(g.studentCode))}</div>
      <div class="row"><button class="btn primary" data-a="copy" data-v="${esc(joinURL(g.studentCode))}">Copy invite link</button><span class="small muted">Code: <b class="mono">${esc(g.studentCode)}</b></span></div></div>
    ${API.status.mail?`<form id="inviteform" class="panel stack"><h2 class="label">Invite by email</h2><p class="small">Paste your students' emails (one per line or separated by commas). Each gets an email with your invite link.</p><textarea id="inv-emails" name="emails" rows="3" placeholder="sam@example.com, lee@example.com" autocapitalize="none" inputmode="email"></textarea><button class="btn" type="submit">Send invites</button></form>`:""}
    <div class="panel"><h2 class="label">Add another coach</h2><p class="small">Only share this with coaches: it gives access to the roster and payments.</p><div class="row"><span class="mono"><b>${esc(g.coachCode)}</b></span><button class="btn" data-a="copy" data-v="${esc(joinURL(g.coachCode))}">Copy coach link</button></div></div>
    <form id="gymform" class="panel stack"><h2 class="label">Gym details</h2><label class="f">Gym name<input id="g-name" name="name" value="${esc(g.name)}"></label>
      <label class="f">Standard monthly fee (${esc(g.currency||"ZAR")})<input id="g-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="${(g.monthlyFeeCents||0)/100}"></label><button class="btn primary" type="submit">Save gym</button></form>
    <div class="row"><button class="btn" data-a="rotate" data-v="student">New student code</button><button class="btn" data-a="rotate" data-v="coach">New coach code</button></div>
    <p class="small muted">A new code stops the old link working. People already in your gym aren't affected.</p></section>`}
async function sendInvites(form){const ta=form.querySelector("[name=emails]"),btn=form.querySelector("[type=submit]");btn.disabled=true;btn.textContent="Sending…";
  try{const j=await api("POST","/coach/invite",{emails:ta.value});ta.value="";
    toast(`Sent ${j.sent} invite${j.sent===1?"":"s"}.${j.already.length?` ${j.already.length} already in your gym.`:""}${j.failed.length?` Couldn't send to ${j.failed.join(", ")}.`:""}`)}
  catch(e){toast(e.message)}btn.disabled=false;btn.textContent="Send invites"}
async function copyText(t){try{await navigator.clipboard.writeText(t);toast("Copied.")}catch(e){toast(t)}}

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
    <div class="row" style="flex-wrap:nowrap"><input id="gi-url" name="url" type="url" inputmode="url" autocapitalize="none" autocomplete="url" placeholder="yourgym.co.za" value="${esc(p.website||"")}" style="flex:1" aria-label="Your gym's website"><button class="btn primary" type="submit">Import</button></div></form>`}
function gymClassesPanel(){const tt=gymProfile().timetable||[];if(!tt.length)return "";
  return `<div class="panel stack"><h2 class="label">Put the timetable in the calendar</h2><p class="small">Adds each class from your weekly timetable to Classes, so students can tap "I'm going" and you can plan them. Classes that are already there are skipped.</p>
    <div class="row" style="flex-wrap:nowrap"><select id="tt-weeks" aria-label="How many weeks" style="flex:1">${[1,2,4,8].map(n=>`<option value="${n}"${n===2?" selected":""}>Next ${n} week${n>1?"s":""}</option>`).join("")}</select><button class="btn primary" data-a="ttclasses">Add classes</button></div></div>`}
async function gymImport(form){
  const url=form.querySelector("[name=url]").value.trim();if(!url){toast("Paste your gym's website address first.");return}
  const btn=form.querySelector("[type=submit]");btn.disabled=true;btn.textContent="Reading…";
  S.ui.sheet={k:"gymedit"};S.ui.stack=[];openSheet(`${sheetHead("Import your gym")}<div class="stack-lg"><h1>Reading your site…</h1><p class="muted">Looking through the home page and pages like timetable, prices, coaches and contact. This can take up to a minute.</p><div class="loadbar"><i></i></div></div>`);
  try{const j=await api("POST","/coach/import",{url});S.ui.gimp={profile:j.profile,logos:j.logos||[],logoPick:j.logos&&j.logos.length?"0":(API.me.gym.logo?"keep":"none"),method:j.method,pages:j.pages||[],imported:true};drawGymEdit()}
  catch(e){hideSheet();render();toast(e.message)}
}
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
    ${G.imported?`<div class="panel ${G.method==="claude"?"":"accent"}"><p class="small"><b>Found on ${G.pages.length} page${G.pages.length===1?"":"s"}:</b> ${G.pages.map(x=>esc(x.title||x.url)).join(" · ")}</p>
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
  try{const j=await api("PUT","/coach/gym/profile",{profile:p,logoUrl});API.me=j.me;S.ui.gimp=null;hideSheet();GYM.data=null;await loadGym(true);COACH.view="gym";go("coach");
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
  try{const j=await api("POST","/coach/classes/bulk",{classes:out});await coachLoad("classes");COACH.view="classes";render();toast(`Added ${j.added} class${j.added===1?"":"es"}${j.skipped?` (${j.skipped} already there)`:""}.`)}
  catch(e){toast(e.message)}
}
