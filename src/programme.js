/* ============ THE GYM'S MONTHLY PROGRAMME (backend/programme.js) ============ */
/* Coaches: Schedule → Programme. A month, its weeks (Mondays), each with a title, a note, YouTube videos and techniques; Publish when ready.
   Members: "This month" at the top of Train (week chips, this week's videos, catch-up, next month's preview) and a small card on Home.
   Everything here is its own: app.html and accounts.js only call progLearnTop, progHomeCard, progSchedRow and progClassHint. */
const PRG={me:null,meFor:null,meAt:0,meBusy:false,coach:{},view:{},saving:Promise.resolve()};
const PRG_MON=["January","February","March","April","May","June","July","August","September","October","November","December"];
const prgName=ym=>PRG_MON[Number(String(ym).slice(5,7))-1]||"";
const prgShort=ym=>prgName(ym).slice(0,3);
const prgAddM=(ym,n)=>{const [y,m]=ym.split("-").map(Number),d=new Date(y,m-1+n,1);return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`};
const prgDay=k=>fromYmd(k).toLocaleDateString(undefined,{day:"numeric",month:"short"});
const prgOn=()=>!inClaude()&&!!(API.me&&API.me.gym)&&!API.preview;
// A YouTube link → its video id (the server checks it again). Same rules as backend/programme.js ytId.
function prgYt(s){s=String(s||"").trim();if(!s||s.length>500)return null;let u;try{u=new URL(/^[a-z][a-z0-9+.-]*:/i.test(s)?s:"https://"+s)}catch(e){return null}
  if(!/^https?:$/.test(u.protocol)||u.username||u.password)return null;const h=u.hostname.toLowerCase().replace(/\.$/,"");let id=null;
  if(h==="youtu.be")id=u.pathname.split("/")[1];
  else if(["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com","youtube-nocookie.com","www.youtube-nocookie.com"].includes(h)){if(u.pathname==="/watch")id=u.searchParams.get("v");else{const m=u.pathname.match(/^\/(shorts|embed|live|v)\/([^/]+)/);if(m)id=m[2]}}
  return /^[A-Za-z0-9_-]{11}$/.test(id||"")?id:null}
const prgThumb=(v,cls="")=>`<span class="prgth${cls}"><img src="${ytThumb(v,"mqdefault")}" alt="" loading="lazy" decoding="async"><i aria-hidden="true">▶</i></span>`;
const prgN=(n,w)=>`${n} ${w}${n===1?"":"s"}`;

/* ----- members ----- */
async function prgLoad(force){if(!prgOn()||PRG.meBusy)return;const who=API.me.id;
  if(!force&&PRG.meFor===who&&Date.now()-PRG.meAt<120000)return;PRG.meBusy=true;
  let j=null;try{j=await api("GET","/programme")}catch(e){}finally{PRG.meBusy=false}
  if(API.me&&API.me.id===who){const was=PRG.meFor===who?JSON.stringify(PRG.me):"";PRG.me=j;PRG.meFor=who;PRG.meAt=Date.now();if((S.ui.tab==="home"||S.ui.tab==="train")&&!S.ui.sheet&&JSON.stringify(j)!==was)render()}}
const prgMine=()=>{if(!prgOn())return null;if(PRG.meFor!==API.me.id||Date.now()-PRG.meAt>=120000)prgLoad();return PRG.meFor===API.me.id?PRG.me:null};
// A week's state for this member: now, upcoming, done (trained or caught up) or missed.
function prgState(d,w){const t=d.today,end=addDays2(w.start,7);if(t>=w.start&&t<end)return "now";if(t<w.start)return "next";
  return (d.trained||[]).includes(w.start)||(d.caught||[]).includes(w.start)||isCoach()?"done":"miss"}
const prgLive=d=>d&&d.programme&&d.programme.published?d.programme:null;
const prgNow=(d,p)=>p.weeks.find(w=>prgState(d,w)==="now")||p.weeks.find(w=>prgState(d,w)==="next");
function prgVidRows(w,src){return w.videos.map((x,i)=>`<button class="prgvid" data-a="prgweek" data-v="${src}|${w.start}|${i}">${prgThumb(x.v)}<span class="prgvt"><b>${esc(x.title)}</b>${x.note?`<small>${esc(x.note)}</small>`:""}</span></button>`).join("")}
// The top of Train: this month's hero, this week's videos, what to catch up on and next month's preview.
function progLearnTop(){const d=prgMine();if(!d)return "";const p=prgLive(d),cu=d.catchUp||[];if(!p&&!d.next&&!cu.length)return "";
  let html="";
  if(p){const now=prgNow(d,p);
    const chip=w=>{const s=prgState(d,w);return `<button class="prgchip ${s}" data-a="prgweek" data-v="m|${w.start}" aria-label="Week ${w.n}${w.title?": "+esc(w.title):""}${s==="now"?", this week":s==="done"?", done":s==="miss"?", missed":""}">${w.n}${s==="done"?" ✓":s==="now"?" now":s==="miss"?`<i class="dot" aria-hidden="true"></i>`:""}</button>`};
    html+=`<section class="hero dk prghero" aria-label="This month"><div class="hero-t"><span class="eyebrow">This month · ${esc(prgName(p.month))}</span><h2>${esc(p.title)}</h2>${p.summary?`<p>${esc(p.summary)}</p>`:""}</div>
      <div class="prgchips" style="--n:${p.weeks.length}">${p.weeks.map(chip).join("")}</div></section>`;
    if(now)html+=`<section class="panel stack prgweekcard"><button class="row between prghead" data-a="prgweek" data-v="m|${now.start}"><span class="label prglab">${prgState(d,now)==="now"?"This week":"Starts "+esc(prgDay(now.start))}${now.title?" · "+esc(now.title):""}</span><span class="small muted">${now.videos.length?prgN(now.videos.length,"video"):now.ids.length?prgN(now.ids.length,"move"):""} ›</span></button>
      ${now.videos.length?`<div class="prgvids">${prgVidRows(now,"m")}</div>`:now.note?`<p class="small">${esc(now.note)}</p>`:""}</section>`}
  if(cu.length){const by={};cu.forEach(w=>{(by[w.month]=by[w.month]||[]).push(w)});
    html+=`<section class="panel stack warnp prgcatch"><div class="row between"><h2 class="label">Catch up · ${prgN(cu.length,"week")}</h2><span class="pill due">Missed</span></div>
      <p class="small">${Object.entries(by).map(([m,ws])=>`<b>${esc(prgName(m))}</b> ${ws.map(w=>`week ${w.n}${w.title?" "+esc(w.title):""}`).join(", ")}`).join(" · ")}</p>
      <button class="btn primary" data-a="prgcatch">Watch what you missed</button></section>`}
  if(d.next)html+=`<button class="panel prgnext" data-a="prgmonth" data-v="${d.next.month}"><span class="row between"><span class="label prglab">Next month</span><span class="pill plain">Preview</span></span><b>${esc(prgName(d.next.month))}: ${esc(d.next.title)}</b></button>`;
  return `<div class="stack prgtop">${html}</div>`}
// Home: one line, this week's topic, linking to Train.
function progHomeCard(){const d=prgMine();if(!d)return "";const p=prgLive(d);if(!p)return "";const w=prgNow(d,p);if(!w)return "";const cu=(d.catchUp||[]).length,now=prgState(d,w)==="now";
  return `<button class="panel prghome" data-a="prglearn"><span class="prgdot" aria-hidden="true">▶</span><span class="grow"><small class="prglab">${now?"This week":"Starts "+esc(prgDay(w.start))}</small><b>${esc(w.title||p.title)}</b></span><span class="small muted">${w.videos.length?prgN(w.videos.length,"video"):""}${cu?` <span class="pill due">${cu} to catch up</span>`:""} ›</span></button>`}
// Where a week comes from: m = this month, c = the catch-up list, or a month opened by itself (YYYY-MM).
function prgFind(src,start){const d=PRG.me||{};
  if(src==="m"){const p=prgLive(d)||(d.programme||null);return p&&p.weeks.find(w=>w.start===start)}
  if(src==="c")return (d.catchUp||[]).find(w=>w.start===start);
  const v=PRG.view[src];return v&&v.programme&&v.programme.weeks.find(w=>w.start===start)}
function prgWeekSheet(src,start,vi,keep){const w=prgFind(src,start);if(!w)return;const d=PRG.me||{},s=src==="m"||src==="c"?prgState(d,w):null,missed=s==="miss";
  const mon=src==="c"?w.month:src==="m"?(prgLive(d)||{}).month:src,was=S.ui.sheet,from=was&&was.k==="prgweek"?was.from:was&&(was.k==="prgcatch"||was.k==="prgmonth")?was:null;
  S.ui.sheet={k:"prgweek",src,start,from};S.ui.stack=from?["prg"]:[];
  const pill=s==="now"?`<span class="pill ok">This week</span>`:s==="done"?`<span class="pill ok">✓ Done</span>`:missed?`<span class="pill due">Missed</span>`:"";
  openSheet(`${sheetHead(esc(prgName(mon))+" · Week "+w.n)}<div class="stack-lg"><div class="stack" style="gap:6px"><div class="row between"><span class="small muted mono">${esc(prgDay(w.start))} – ${esc(prgDay(addDays2(w.start,6)))}</span>${pill}</div><h1>${esc(w.title||"Week "+w.n)}</h1>${w.note?`<p>${esc(w.note)}</p>`:""}</div>
    ${w.videos.length?`<section class="stack"><h2 class="label">Videos · ${w.videos.length}</h2>${w.videos.map((x,i)=>`<div class="prgplay" id="prgv-${i}">${ytMedia({v:x.v,title:x.title,channel:x.note},x.title,"")}</div>`).join("")}</section>`:""}
    ${w.ids.filter(id=>TM[id]).length?`<section class="stack"><h2 class="label">Moves to study</h2><div class="list">${w.ids.filter(id=>TM[id]).map(id=>tRow(TM[id])).join("")}</div></section>`:""}
    ${!w.videos.length&&!w.ids.length?`<p class="muted">Nothing here yet. Check again closer to the week.</p>`:""}</div>`,keep,
    missed?{act:`<button class="btn primary grow" data-a="prgcaught" data-v="${w.start}">Caught up</button>`}:undefined);
  if(vi!=null){const el=document.getElementById("prgv-"+vi);if(el&&Number(vi)>0)el.scrollIntoView({block:"start"})}}
function prgCatchSheet(){const d=PRG.me||{},cu=d.catchUp||[];S.ui.sheet={k:"prgcatch"};S.ui.stack=[];
  openSheet(`${sheetHead("Catch up")}<div class="stack-lg"><h1>What you missed</h1>${cu.length?cu.map(w=>`<section class="panel stack prgcu"><div class="row between"><span class="label prglab">${esc(prgName(w.month))} · week ${w.n}</span><span class="small muted">${w.videos.length?prgN(w.videos.length,"video"):prgN(w.ids.length,"move")}</span></div>
      <b>${esc(w.title||"Week "+w.n)}</b>${w.videos.length?`<div class="prgvids">${prgVidRows(w,"c")}</div>`:""}
      <div class="row"><button class="btn" data-a="prgweek" data-v="c|${w.start}">Open week</button><button class="btn" data-a="prgcaught" data-v="${w.start}">Caught up</button></div></section>`).join(""):`<div class="empty">All caught up. Nice.</div>`}</div>`)}
async function prgCaught(start){try{await api("POST","/me/programme/caught-up",{week:start});const d=PRG.me;if(d){d.caught=[...(d.caught||[]),start];d.catchUp=(d.catchUp||[]).filter(w=>w.start!==start)}
    toast("Caught up. Off your list.",{label:"Undo",fn:async()=>{try{await api("POST","/me/programme/caught-up",{week:start,on:false});await prgLoad(true);if(S.ui.sheet&&S.ui.sheet.k==="prgcatch")prgCatchSheet();else if(!S.ui.sheet)render()}catch(e){toast(e.message)}}});
    const sh=S.ui.sheet||{};if(sh.k==="prgcatch"||(sh.from&&sh.from.k==="prgcatch"))prgCatchSheet();else closeSheet()}catch(e){toast(e.message)}}
// Back from a week opened in the catch-up list or a month: to that list or month. From editing a week: to the planner (saved first).
function prgBack(k){const sh=S.ui.sheet||{};
  if(k==="prgweek"&&sh.from){if(sh.from.k==="prgcatch")prgCatchSheet();else prgMonthSheet(sh.from.ym);return true}
  if(k==="prgwk"){const ch=prgWeekFields();(ch?prgSave(PRG.sel):Promise.resolve()).then(()=>prgDraw(),()=>prgDraw());return true}
  return false}
// A month by itself (next month's preview): its title, its weeks.
async function prgMonthSheet(ym){S.ui.sheet={k:"prgmonth",ym};S.ui.stack=[];openSheet(`${sheetHead(esc(prgName(ym)))}<div class="empty">Loading…</div>`);
  let j;try{j=await api("GET","/programme?month="+ym)}catch(e){toast(e.message);return closeSheet()}PRG.view[ym]=j;const p=j.programme;
  if(!S.ui.sheet||S.ui.sheet.k!=="prgmonth"||S.ui.sheet.ym!==ym)return;
  openSheet(`${sheetHead(esc(prgName(ym)))}<div class="stack-lg">${p?`<div class="stack" style="gap:6px"><span class="pill plain" style="justify-self:start">Preview</span><h1>${esc(p.title)}</h1>${p.summary?`<p>${esc(p.summary)}</p>`:""}</div>
    <div class="stack">${p.weeks.map(w=>`<button class="panel prgwk" data-a="prgweek" data-v="${ym}|${w.start}"><span class="row between"><span class="label prglab">Week ${w.n} · ${esc(prgDay(w.start))}</span><span class="small muted">${w.videos.length?prgN(w.videos.length,"video"):""}</span></span><b>${esc(w.title||"Week "+w.n)}</b>${w.note?`<small>${esc(w.note)}</small>`:""}</button>`).join("")}</div>`:`<p class="muted">Not out yet.</p>`}</div>`,true)}

/* ----- coaches: Schedule → Programme ----- */
async function prgCoachLoad(ym){const j=await api("GET","/programme"+(ym?"?month="+ym:""));PRG.coach[j.month]=j;PRG.today=j.today;if(!ym)PRG.cur=j.month;return j}
function prgCur(){if(!PRG.cur&&!PRG.curBusy){PRG.curBusy=true;prgCoachLoad().then(()=>{if(S.ui.tab==="coach"&&COACH.view==="schedule"&&!S.ui.sheet)render()}).catch(()=>{}).finally(()=>{PRG.curBusy=false})}return PRG.cur?PRG.coach[PRG.cur]:null}
const prgStat=(months,m)=>{const x=(months||[]).find(y=>y.month===m);return x?x.published?"ok":"due":"plain"};
// The Programme row at the top of Schedule: this month's theme and a pill per month (published, draft, nothing yet).
function progSchedRow(){if(API.preview)return "";const d=prgCur();if(!d)return "";const cur=PRG.cur,p=d.programme,nx=prgAddM(cur,1);
  return `<button class="prgentry" data-a="prgopen"><span class="prgdot" aria-hidden="true">▶</span><span class="grow"><b>Programme</b><small>${p&&p.title?esc(prgName(cur)+": "+p.title):"Plan "+esc(prgName(cur))+"'s videos"}</small></span>
    <span class="pill ${prgStat(d.months,cur)}">${esc(prgShort(cur))}</span><span class="pill ${prgStat(d.months,nx)}">${esc(prgShort(nx))}</span><span aria-hidden="true">›</span></button>`}
async function prgOpen(ym){ym=ym||PRG.sel||(PRG.cur&&PRG.cur);S.ui.sheet={k:"prg"};S.ui.stack=[];
  if(!ym||!PRG.coach[ym]){openSheet(`${sheetHead("Programme")}<div class="empty">Loading…</div>`);try{const j=await prgCoachLoad(ym);ym=j.month}catch(e){toast(e.message);return closeSheet()}}
  PRG.sel=ym;prgDraw(true)}
function prgDraw(keep){const ym=PRG.sel,d=PRG.coach[ym];if(!d)return;const p=d.programme,months=[prgAddM(ym,-1),ym,prgAddM(ym,1)];S.ui.sheet={k:"prg",ym};S.ui.stack=[];
  const st=p?p.published?`<span class="pill ok">Published</span>`:`<span class="pill due">Draft</span>`:"";
  let body;
  if(!p)body=`<div class="empty">Nothing planned for ${esc(prgName(ym))} yet.</div><div class="stack"><button class="btn primary" data-a="prgstart">Start ${esc(prgName(ym))}</button>${d.prev?`<button class="btn" data-a="prgcopy">Copy ${esc(prgName(d.prev.month))}'s weeks</button>`:""}</div>`;
  else{const add=p.weeks.find(w=>!w.videos.length&&addDays2(w.start,6)>=(PRG.today||todayK()));
    body=`<form id="prgmform" class="stack prgmform" novalidate><input name="title" aria-label="Month's theme" maxlength="80" value="${esc(p.title)}" placeholder="This month's theme, e.g. Wrestling for BJJ"><input name="summary" aria-label="One line for members" maxlength="280" value="${esc(p.summary)}" placeholder="One line for members (optional)"></form>
      <div class="stack">${p.weeks.map((w,i)=>`<button class="panel prgwk" data-a="prgwkedit" data-v="${i}"><span class="row between"><span class="label prglab">Week ${w.n} · ${esc(prgDay(w.start))}</span>${w.videos.length?`<span class="small muted">${prgN(w.videos.length,"video")}</span>`:`<span class="pill due">Add videos</span>`}</span>
        ${w.title?`<b>${esc(w.title)}</b>`:`<b class="muted">Add a title</b>`}${w.note||w.ids.length?`<small>${esc(w.note||w.ids.filter(id=>TM[id]).map(id=>TM[id].n).join(", "))}</small>`:""}</button>`).join("")}</div>
      ${add?`<button class="btn" data-a="prgwkedit" data-v="${add.n-1}" data-k="add">+ Add a video to week ${add.n}</button>`:""}
      <div class="row prgfoot">${p.published?`<button class="linkbtn small" data-a="prgpub" data-v="0">Back to draft</button>`:""}${d.canDelete?`<button class="linkbtn small danger" data-a="prgdelask">Delete ${esc(prgName(ym))}</button>`:""}</div>`}
  openSheet(`${sheetHead("Schedule")}<div class="stack-lg"><div class="row between"><h1>Programme</h1>${st}</div>
    ${seg("Month","prgmon",months.map(m=>[m,m===ym?prgName(m):prgShort(m)]),ym,"seg3 prgseg")}${body}</div>`,keep,
    p&&!p.published?{act:`<button class="btn primary grow" data-a="prgpub" data-v="1">Publish ${esc(prgName(ym))}</button>`}:undefined)}
// Saves the open month (one save at a time, each with the version the last one returned).
function prgSave(ym){const run=async()=>{const d=PRG.coach[ym],p=d&&d.programme;if(!p)return;
    try{const j=await api("PUT","/coach/programme/"+ym,{title:p.title,summary:p.summary,was:p.updatedAt,weeks:p.weeks.map(w=>({title:w.title,note:w.note,ids:w.ids,videos:w.videos.map(v=>({v:v.v,title:v.title,note:v.note}))}))});
      d.programme=j.programme;prgMonths(d,j.programme);PRG.meAt=0}
    catch(e){toast(e.message);if(e.status===409&&e.data&&e.data.programme){d.programme=e.data.programme;prgRedraw()}throw e}};
  return PRG.saving=PRG.saving.then(run,run)}
function prgMonths(d,p){const ms=(PRG.coach[PRG.cur]||{}).months;if(!ms)return;const x=ms.find(m=>m.month===p.month);if(x)Object.assign(x,{title:p.title,published:p.published});else{ms.push({month:p.month,title:p.title,published:p.published});ms.sort((a,b)=>a.month<b.month?-1:1)}}
function prgRedraw(){const k=S.ui.sheet&&S.ui.sheet.k;if(k==="prg")prgDraw(true);else if(k==="prgwk")prgWeekEdit(S.ui.sheet.i,null,true)}
async function prgCreate(copy){const ym=PRG.sel;try{const j=copy?await api("POST",`/coach/programme/${ym}/copy`,{},"prgc"+ym+Date.now()):await api("PUT","/coach/programme/"+ym,{title:"",summary:"",weeks:[]});
    PRG.coach[ym].programme=j.programme;prgMonths(PRG.coach[ym],j.programme);prgDraw(true);if(copy)toast(`Copied ${prgName(j.from)}'s ${j.programme.weeks.length} weeks. Change the titles and add videos.`);
    const t=document.querySelector('#prgmform [name="title"]');if(t&&!copy)t.focus()}catch(e){toast(e.message)}}
async function prgPublish(on,changed){const ym=PRG.sel,d=PRG.coach[ym];try{if(changed)await prgSave(ym);else await PRG.saving}catch(e){return}
  try{const j=await api("POST",`/coach/programme/${ym}/publish`,{published:on},"prgp"+ym+Date.now());d.programme=j.programme;prgMonths(d,j.programme);PRG.meAt=0;prgDraw(true);
    toast(on?(j.told?`Published. Members can see ${prgName(ym)} now, and get a notice.`:`Published again.`):"Back to a draft. Members can't see it.")}catch(e){toast(e.message)}}
async function prgDelete(){const ym=PRG.sel;try{await api("DELETE","/coach/programme/"+ym);PRG.coach[ym].programme=null;const ms=(PRG.coach[PRG.cur]||{}).months;if(ms)(PRG.coach[PRG.cur].months=ms.filter(m=>m.month!==ym));PRG.meAt=0;
  S.ui.sheet={k:"prg"};prgDraw();toast(`${prgName(ym)} deleted.`)}catch(e){toast(e.message)}}
// One week: title, note, videos (paste a link, give it a title) and moves. Each change saves straight away.
function prgWeekEdit(i,focus,keep){const ym=PRG.sel,p=PRG.coach[ym].programme,w=p.weeks[i];if(!w)return;S.ui.sheet={k:"prgwk",i:Number(i)};S.ui.stack=["prg"];
  const vids=w.videos.map((x,j)=>`<div class="prgedv">${prgThumb(x.v)}<span class="prgvt"><b>${esc(x.title)}</b>${x.note?`<small>${esc(x.note)}</small>`:""}</span><span class="prgmv"><button type="button" class="btn sm" data-a="prgvmv" data-v="${j}:-1" aria-label="Move up"${j?"":" disabled"}>↑</button><button type="button" class="btn sm" data-a="prgvmv" data-v="${j}:1" aria-label="Move down"${j<w.videos.length-1?"":" disabled"}>↓</button><button type="button" class="btn sm" data-a="prgvrm" data-v="${j}" aria-label="Remove ${esc(x.title)}">×</button></span></div>`).join("");
  openSheet(`${sheetHead(esc(prgName(ym))+" · Week "+w.n)}<div class="stack-lg"><h1>Week ${w.n} · ${esc(prgDay(w.start))}</h1>
    <form id="prgwform" class="stack" novalidate><label class="f">Title<input name="title" maxlength="80" value="${esc(w.title)}" placeholder="e.g. Hand fighting"></label>
      <label class="f">Note<input name="note" maxlength="280" value="${esc(w.note)}" placeholder="One line, e.g. 2-on-1, collar tie, underhooks"></label></form>
    <section class="stack"><div class="row between"><h2 class="label">Videos</h2><span class="small muted mono">${w.videos.length}/12</span></div>
      ${vids?`<div class="prgedvs">${vids}</div>`:""}
      ${w.videos.length<12?`<form id="prgvform" class="stack prgadd" novalidate><input id="prg-url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste a YouTube link" aria-label="YouTube link">
        <div id="prg-prev" class="prgprev" hidden></div><input name="vtitle" maxlength="100" placeholder="Short title, e.g. Snap down to front headlock" aria-label="Video title"><input name="vnote" maxlength="120" placeholder="Variation or note (optional)" aria-label="Variation or note">
        <button class="btn" type="submit">Add video</button><p class="small muted" style="margin:0">Unlisted videos work. Speed is in YouTube's own settings.</p></form>`:`<p class="small muted">That's 12, the most for a week.</p>`}</section>
    <section class="stack"><h2 class="label">Moves (optional)</h2><select id="prg-add" aria-label="Add a move"><option value="">Add a move…</option>${techOptions()}</select>
      <div class="chips">${w.ids.filter(id=>TM[id]).map(id=>`<button type="button" class="chip" data-a="prgidrm" data-v="${id}">${esc(TM[id].n)} <span class="x">×</span></button>`).join("")}</div></section></div>`,keep,
    {back:"‹ Programme",act:`<button class="btn primary grow" data-a="prgwkdone">Done</button>`});
  if(focus==="add"){const u=document.getElementById("prg-url");if(u){u.scrollIntoView({block:"center"});u.focus({preventScroll:true})}}}
// The title and note boxes into the month (true when they changed).
function prgWeekFields(){const f=document.getElementById("prgwform"),sh=S.ui.sheet;if(!f||!sh||sh.k!=="prgwk")return false;const w=PRG.coach[PRG.sel].programme.weeks[sh.i];
  const t=f.querySelector("[name=title]").value.trim(),n=f.querySelector("[name=note]").value.trim();if(t===w.title&&n===w.note)return false;w.title=t;w.note=n;return true}
function prgMonthFields(){const f=document.getElementById("prgmform"),d=PRG.coach[PRG.sel],p=d&&d.programme;if(!f||!p)return false;
  const t=f.querySelector("[name=title]").value.trim(),s=f.querySelector("[name=summary]").value.trim();if(t===p.title&&s===p.summary)return false;p.title=t;p.summary=s;return true}
const prgWeek=()=>PRG.coach[PRG.sel].programme.weeks[S.ui.sheet.i];
async function prgVidAdd(f){const v=n=>(f.querySelector(`[name="${n}"]`)||{}).value.trim(),id=prgYt(v("url"));
  if(!id){toast("That isn't a YouTube video link. Copy it from YouTube's Share button.");return}
  if(!v("vtitle")){toast("Give the video a short title.");f.querySelector("[name=vtitle]").focus();return}
  prgWeekFields();const w=prgWeek();w.videos.push({v:id,title:v("vtitle").slice(0,100),note:v("vnote").slice(0,120)});
  try{await prgSave(PRG.sel);prgWeekEdit(S.ui.sheet.i,"add",true);toast("Video added.")}catch(e){w.videos.pop()}}
async function prgWeekChange(fn){prgWeekFields();const i=S.ui.sheet.i;fn(prgWeek());prgWeekEdit(i,null,true);try{await prgSave(PRG.sel)}catch(e){}}
function prgAct(a,v,el){switch(a){
  case "prglearn": go("train-moves");break;
  case "prgweek": { const [src,start,vi]=String(v).split("|");prgWeekSheet(src,start,vi);break }
  case "prgcatch": prgCatchSheet();break;
  case "prgcaught": prgCaught(v);break;
  case "prgmonth": prgMonthSheet(v);break;
  case "prgopen": prgOpen();break;
  case "prgmon": { const ok=prgMonthFields();(ok?prgSave(PRG.sel):Promise.resolve()).catch(()=>{}).then(()=>{PRG.sel=v;if(PRG.coach[v])prgDraw(true);else prgCoachLoad(v).then(()=>prgDraw(true)).catch(e=>toast(e.message))});break }
  case "prgstart": prgCreate(false);break;
  case "prgcopy": prgCreate(true);break;
  case "prgpub": prgPublish(v==="1",prgMonthFields());break;
  case "prgdelask": confirmSheet(`Delete ${prgName(PRG.sel)}?`,`Its weeks and videos go, for everyone. Members stop seeing it.`,["prgdelyes",PRG.sel],"Delete");break;
  case "prgdelyes": prgDelete();break;
  case "prgwkedit": if(prgMonthFields())prgSave(PRG.sel).catch(()=>{});prgWeekEdit(Number(v),el.dataset.k||null);break;
  case "prgwkdone": { const ch=prgWeekFields();(ch?prgSave(PRG.sel):Promise.resolve()).then(()=>prgDraw(),()=>{});break }
  case "prgvmv": { const [j,dir]=String(v).split(":").map(Number);prgWeekChange(w=>{const k=j+dir;if(k<0||k>=w.videos.length)return;const x=w.videos.splice(j,1)[0];w.videos.splice(k,0,x)});break }
  case "prgvrm": { const j=Number(v),i=S.ui.sheet.i;let gone=null;prgWeekChange(w=>{gone=w.videos.splice(j,1)[0]});
    toast("Video removed.",{label:"Undo",fn:()=>{const w=PRG.coach[PRG.sel].programme.weeks[i];if(!gone)return;w.videos.splice(Math.min(j,w.videos.length),0,gone);if(S.ui.sheet&&S.ui.sheet.k==="prgwk")prgWeekEdit(i,null,true);prgSave(PRG.sel).catch(()=>{})}});break }
  case "prgidrm": prgWeekChange(w=>{w.ids=w.ids.filter(x=>x!==v)});break;
  case "prguse": prgUse(v);break;
}}
document.addEventListener("click",e=>{const el=e.target.closest("[data-a^='prg']");if(el)prgAct(el.dataset.a,el.dataset.v,el)});
// Enter in a title box: done typing (the change saves it).
document.addEventListener("submit",e=>{const id=e.target.getAttribute("id");if(id==="prgvform"){e.preventDefault();prgVidAdd(e.target)}else if(id==="prgmform"||id==="prgwform"){e.preventDefault();if(document.activeElement)document.activeElement.blur()}});
document.addEventListener("change",e=>{const t=e.target;
  if(t.id==="prg-add"&&t.value){const id=t.value;t.value="";prgWeekChange(w=>{if(!w.ids.includes(id)&&w.ids.length<30)w.ids.push(id)});return}
  if(t.closest&&t.closest("#prgmform")){if(prgMonthFields())prgSave(PRG.sel).catch(()=>{});return}
  if(t.closest&&t.closest("#prgwform")){if(prgWeekFields())prgSave(PRG.sel).catch(()=>{});return}
  if(t.id==="c-date"){const h=document.getElementById("prg-hint");if(h)h.outerHTML=progClassHint(t.value);return}});
document.addEventListener("input",e=>{if(e.target.id!=="prg-url")return;const id=prgYt(e.target.value),box=document.getElementById("prg-prev");if(!box)return;
  box.hidden=!id;box.innerHTML=id?`${prgThumb(id)}<span class="small ok-t">YouTube video found</span>`:"";
  if(id&&e.inputType==="insertFromPaste"){const t=document.querySelector('#prgvform [name="vtitle"]');if(t&&!t.value)t.focus()}});

/* ----- planning a class: "Use this week" fills its plan from the programme ----- */
function prgWeekOn(date){const ym=String(date||"").slice(0,7),d=PRG.coach[ym],p=d&&d.programme;if(!p)return null;return p.weeks.find(w=>date>=w.start&&date<addDays2(w.start,7))||null}
function progClassHint(date){if(API.preview||!/^\d{4}-\d{2}-\d{2}$/.test(date||""))return `<div id="prg-hint"></div>`;const ym=date.slice(0,7);
  if(!PRG.coach[ym]){PRG.coach[ym]=null;prgCoachLoad(ym).then(()=>{const h=document.getElementById("prg-hint"),c=document.getElementById("c-date");if(h&&c&&c.value===date)h.outerHTML=progClassHint(date)}).catch(()=>{delete PRG.coach[ym]});return `<div id="prg-hint"></div>`}
  const w=prgWeekOn(date);if(!w||!(w.title||w.ids.length))return `<div id="prg-hint"></div>`;
  return `<div id="prg-hint"><button type="button" class="btn prguse" data-a="prguse" data-v="${date}"><span class="prgdot" aria-hidden="true">▶</span><span class="grow">Use this week: <b>${esc(w.title||"Week "+w.n)}</b></span></button></div>`}
function prgUse(date){const w=prgWeekOn(date),f=document.getElementById("classform");if(!w||!f)return;
  const box=f.querySelector("details.planbox");if(box)box.open=true;
  const set=(n,val)=>{const el=f.querySelector(`[name="${n}"]`);if(el&&val)el.value=val};
  set("focus",(w.title||"").slice(0,120));if(!(f.querySelector("[name=notes]")||{}).value)set("notes",w.note);
  S.ui.cplan=S.ui.cplan||{ids:[]};w.ids.forEach(id=>{if(TM[id]&&!S.ui.cplan.ids.includes(id))S.ui.cplan.ids.push(id)});
  const chips=document.getElementById("cplan-chips");if(chips)chips.innerHTML=S.ui.cplan.ids.filter(id=>TM[id]).map(id=>`<button type="button" class="chip" data-a="cplanrm" data-v="${id}">${esc(TM[id].n)} <span class="x">×</span></button>`).join("");
  toast(`Plan filled from week ${w.n}.`)}
