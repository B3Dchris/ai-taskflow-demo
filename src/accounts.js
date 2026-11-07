/* ============ ACCOUNTS, SYNC, CLASSES AND THE COACH DASHBOARD (website only) ============ */
const API={on:false,me:null,classes:null,classesAt:0};
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
  try{const j=await api("GET","/me");API.on=true;API.me=j.me;if(API.me)await startSync()}
  catch(e){API.on=false}
  const q=new URLSearchParams(location.search).get("join");
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
async function signedIn(me){API.me=me;API.classes=null;await startSync();hideSheet();maybeOnboardAfterSync();go(isCoach()?"coach":"today");toast(`Signed in as ${me.name}.`)}
function maybeOnboardAfterSync(){S.ui.obChecked=false;if(!P().settings.onboarded)maybeOnboard()}
async function signOut(){try{await api("POST","/auth/logout",{})}catch(e){}API.me=null;API.classes=null;COACH.roster=COACH.classes=COACH.payments=null;S.mode="local";setSync("Saved on this device","local");go("today");toast("Signed out. Your progress stays saved to your account.")}

/* ----- account sheets ----- */
function authSheet(){
  const m=S.ui.authMode||"login",c=S.ui.authCode||"";S.ui.sheet={k:"auth"};S.ui.stack=[];
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
    ${m!=="login"?`<p class="small muted">Your name, email, training log and payments (if your gym uses them) are stored on JitsFlow's server so you and your coach can see them. You can delete your account and data any time in Settings.</p>`:""}
   </form></div>`,false,{act:`<button class="btn primary grow" type="submit" form="authform">${m==="gym"?"Start gym":m==="register"?"Create account":"Sign in"}</button>`});
}
async function submitAuth(form){
  const v=n=>(form.querySelector(`[name="${n}"]`)||{}).value||"",m=S.ui.authMode||"login";
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
  if(!up.length)return `<section class="panel"><h2 class="label">Next class</h2><p class="muted">No classes scheduled yet${isCoach()?". Plan one in the Coach tab.":"."}</p></section>`;
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
  return `${header()}<div class="stack-lg"><section class="stack"><h1 style="font-size:34px">${esc(API.me.gym.name)}</h1>
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
  return `<section class="stack"><div class="panel"><h2 class="label">Invite students</h2><p class="small">Send this link. It opens JitsFlow with your gym code filled in.</p><div class="codebox mono">${esc(joinURL(g.studentCode))}</div>
      <div class="row"><button class="btn primary" data-a="copy" data-v="${esc(joinURL(g.studentCode))}">Copy invite link</button><span class="small muted">Code: <b class="mono">${esc(g.studentCode)}</b></span></div></div>
    <div class="panel"><h2 class="label">Add another coach</h2><p class="small">Only share this with coaches: it gives access to the roster and payments.</p><div class="row"><span class="mono"><b>${esc(g.coachCode)}</b></span><button class="btn" data-a="copy" data-v="${esc(joinURL(g.coachCode))}">Copy coach link</button></div></div>
    <form id="gymform" class="panel stack"><h2 class="label">Gym details</h2><label class="f">Gym name<input id="g-name" name="name" value="${esc(g.name)}"></label>
      <label class="f">Standard monthly fee (${esc(g.currency||"ZAR")})<input id="g-fee" name="fee" type="number" inputmode="decimal" min="0" step="0.01" value="${(g.monthlyFeeCents||0)/100}"></label><button class="btn primary" type="submit">Save gym</button></form>
    <div class="row"><button class="btn" data-a="rotate" data-v="student">New student code</button><button class="btn" data-a="rotate" data-v="coach">New coach code</button></div>
    <p class="small muted">A new code stops the old link working. People already in your gym aren't affected.</p></section>`}
async function copyText(t){try{await navigator.clipboard.writeText(t);toast("Copied.")}catch(e){toast(t)}}
