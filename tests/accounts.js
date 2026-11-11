// End-to-end: a coach and a student using accounts, classes, the roster and payments in real browsers.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/accounts.js   (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg"); const { startGymSite, startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade"); await pool.end();
  const port = 9800 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const site = await startGymSite(), sink = await startMailSink();
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, JF_IMPORT_ALLOW_LOOPBACK: "1", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test" }; delete env.ANTHROPIC_API_KEY;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
  const b = await chromium.launch(); const errs = [];
  const phone = async () => { const c = await b.newContext({ ...devices["iPhone 13"] }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.message)); return { c, p }; };
  const ev = (p, f, a) => p.evaluate(f, a); const toast = (p) => ev(p, () => document.getElementById("toast").textContent);
  const wide = async (p, label) => ok(await ev(p, () => document.documentElement.scrollWidth <= 390), label + ": no sideways scroll");
  try {
    // ---- coach finds sign-in from the landing page, then starts a gym
    const { p: co } = await phone();
    await co.goto(URL + "/"); await co.waitForTimeout(400);
    await co.locator('.toplinks .signin[href*="signin"]').tap(); await co.waitForTimeout(900);
    ok(await ev(co, () => location.pathname === "/app/" && S.ui.sheet && S.ui.sheet.k === "auth" && S.ui.authMode === "login"), "landing 'Coach sign in' opens the sign-in sheet");
    await co.tap('[data-a="authmode"][data-v="gym"]');
    await co.fill("#a-gym", "JPB Martial Arts Academy"); await co.fill("#a-name", "Coach JP"); await co.fill("#a-email", "coach@example.com"); await co.fill("#a-pass", "coachpass1");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(900);
    ok(await ev(co, () => !(S.ui.sheet && S.ui.sheet.k === "onboard")), "a new coach isn't asked the student study questions");
    ok(await ev(co, () => S.ui.sheet && S.ui.sheet.k === "welcome" && /contacts/.test(document.getElementById("sheet").innerText) && !/Ask JitsFlow/.test(document.getElementById("sheet").innerText)), "a new coach gets a short welcome (adding students, no assistant");
    ok(await ev(co, () => /Home is your gym's day/.test(document.getElementById("sheet").innerText) && !/Today is/.test(document.getElementById("sheet").innerText)), "the welcome names the Home tab, not Today");
    await co.tap('#sheetbar [data-a="back"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => /Getting started · \d of 4/i.test(document.getElementById("app").innerText)), "Today shows the Getting started checklist");
    ok(await ev(co, () => document.querySelector("#app h1").textContent === "Home"), "the coach's Home is called Home, like its tab");
    ok(await ev(co, () => isCoach() && location.hash === "#coach-home" && !document.querySelector('nav.tabs [data-v="coach-schedule"]').hidden && document.querySelector('nav.tabs [data-v="learn"]').hidden && [...document.querySelectorAll("nav.tabs button:not([hidden])")].map((b) => b.textContent.trim()).join() === "Home,Schedule,Members,Money,Gym"), "coach lands on their gym's Home; the bar shows Home, Schedule, Members, Money, Gym");
    ok(await ev(co, () => { const a = document.querySelector("header .avatar"); return a && a.textContent === "CJ" && a.getAttribute("aria-label") === "CJ: your gym and account" && /Coach JP/.test(a.title) && !document.querySelector('[data-a="auth"][data-v="login"].who'); }), "header shows a round initials button for who's signed in, not Sign in");
    ok(await ev(co, () => getComputedStyle(document.getElementById("sync")).display === "none" && !/Saved to your account/.test(document.querySelector("header").innerText)), "no always-on 'Saved' badge in the header");
    await co.tap("header .avatar"); ok(await ev(co, () => COACH.view === "gym" && location.hash === "#coach-gym"), "a coach's initials button opens Gym");
    await ev(co, () => coachGo("comps")); ok(await ev(co, () => document.querySelector('nav.tabs [data-v="coach-members"]').getAttribute("aria-current") === "page" && document.querySelector('[data-a="coachgo"][data-v="comps"]').getAttribute("aria-pressed") === "true" && !!document.getElementById("compimpform")), "Competitions sit inside Members");
    await ev(co, () => { location.hash = "coach-students"; }); await co.waitForTimeout(200); ok(await ev(co, () => COACH.view === "members" && location.hash === "#coach-members"), "old #coach-students opens Members");
    await ev(co, () => { location.hash = "coach-classes"; }); await co.waitForTimeout(200); ok(await ev(co, () => COACH.view === "schedule" && location.hash === "#coach-schedule"), "old #coach-classes opens Schedule");
    await ev(co, () => { location.hash = "coach-comps"; }); await co.waitForTimeout(200); ok(await ev(co, () => COACH.view === "comps" && document.querySelector('nav.tabs [data-v="coach-members"]').getAttribute("aria-current") === "page"), "#coach-comps opens Members › Competitions");
    // ---- "My training" on Gym switches to the study tabs; "Manage <gym>" on Home switches back
    await ev(co, () => coachGo("gym")); await co.tap('.mytraining [data-a="coachmode"][data-v="study"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => coachMode() === "study" && S.ui.tab === "home" && [...document.querySelectorAll("nav.tabs button:not([hidden])")].map((b) => b.dataset.v).join() === "home,learn,journal,me" && /^Manage JPB Martial Arts Academy$/.test(document.querySelector(".managebtn").textContent.trim())), "My training gives a coach 4 study tabs and a Manage button on Home");
    if (await ev(co, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await ev(co, () => goBack());
    await co.tap(".managebtn"); await co.waitForTimeout(300);
    ok(await ev(co, () => managing() && COACH.view === "home" && !document.querySelector('nav.tabs [data-v="coach-home"]').hidden), "Manage brings the coach back to their gym");
    await co.tap('nav.tabs [data-v="coach-gym"]');
    const invite = await ev(co, () => document.querySelector(".codebox").textContent);
    ok(/\/app\/\?join=[A-Z0-9]{8}$/.test(invite), "gym tab shows the student invite link");
    await wide(co, "coach gym tab");
    // ---- coach plans a class
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.tap('[data-a="classnew"]');
    ok(await ev(co, () => { const ls = [...document.querySelectorAll("#sheet label.f")].map((l) => l.firstChild.textContent.trim()); return ls.length > 4 && new Set(ls).size === ls.length && ls.includes("Group or private"); }), "every field in the add-a-class form has its own label (no two called Type)");
    await co.fill("#c-title", "No-gi: half guard"); await co.locator(".planbox summary").tap(); await co.fill("#c-focus", "Half guard bottom");
    await co.selectOption("#c-add", "hg_frames"); await co.selectOption("#c-add", "hg_dogfight");
    ok(await ev(co, () => document.querySelectorAll("#cplan-chips .chip").length === 2), "techniques added to the plan");
    await co.fill("#c-notes", "Underhook battles, 3 x 3 min");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(700);
    ok(await ev(co, () => document.querySelectorAll(".calrow").length === 1 && /No-gi: half guard/.test(document.querySelector(".calrow").innerText) && document.querySelector(".wday.sel i").textContent === "1"), "class is planned and listed");
    await wide(co, "coach classes");
    // ---- a brand-new visitor first picks how they use JitsFlow
    { const { c: nc, p: nv } = await phone();
      await nv.goto(URL + "/app/"); await nv.waitForTimeout(1200);
      ok(await ev(nv, () => S.ui.sheet && S.ui.sheet.k === "how" && /How are you using JitsFlow\?/.test(document.getElementById("sheet").innerText) && [...document.querySelectorAll("#sheet .howbtn b")].map((b) => b.textContent).join("|") === "I train at a gym|I run a gym|Just me" && !!document.querySelector('#sheet [data-a="how"][data-v="signin"]')), "a new visitor is asked how they use JitsFlow (gym, run a gym, just me, or sign in)");
      await wide(nv, "first screen");
      await nv.tap('#sheet [data-a="how"][data-v="gym"]'); await nv.waitForTimeout(200);
      ok(await ev(nv, () => !!document.getElementById("h-code") && /invite link/.test(document.getElementById("sheet").innerText)), "I train at a gym asks for the gym code and explains the invite link");
      await nv.fill("#h-code", "BADCODE1"); await nv.tap('#sheetbar [type=submit]'); await nv.waitForTimeout(700);
      ok(await ev(nv, () => S.ui.sheet.k === "how" && /gym code isn't right/.test(document.getElementById("h-code-err").textContent) && document.getElementById("h-code").getAttribute("aria-invalid") === "true"), "a wrong gym code is caught on the code step, before the sign-up form");
      await wide(nv, "wrong gym code");
      await nv.fill("#h-code", invite.split("join=")[1].toLowerCase()); await nv.tap('#sheetbar [type=submit]'); await nv.waitForTimeout(700);
      ok(await ev(nv, (c) => S.ui.sheet.k === "auth" && S.ui.authMode === "register" && document.getElementById("a-code").value === c && /Joining JPB Martial Arts Academy/.test(document.getElementById("a-joining").textContent), invite.split("join=")[1]), "then sign-up opens with the code filled in, and says which gym they're joining");
      await nv.tap('#sheetbar [data-a="back"]'); ok(await ev(nv, () => S.ui.sheet.k === "how" && !!document.getElementById("h-code")), "Back from sign-up returns to the code step");
      await nv.tap('#sheetbar [data-a="back"]'); ok(await ev(nv, () => S.ui.sheet.k === "how" && document.querySelectorAll("#sheet .howbtn").length === 3), "and Back again to the three choices");
      await nv.tap('#sheet [data-a="how"][data-v="run"]'); ok(await ev(nv, () => S.ui.sheet.k === "auth" && S.ui.authMode === "gym" && !!document.getElementById("a-gym")), "I run a gym opens Start your gym");
      await nv.tap('#sheetbar [data-a="back"]'); await nv.tap('#sheet [data-a="how"][data-v="signin"]'); ok(await ev(nv, () => S.ui.sheet.k === "auth" && S.ui.authMode === "login"), "Sign in is there for people with an account");
      await nv.tap('#sheetbar [data-a="back"]'); await nv.tap('#sheet [data-a="how"][data-v="solo"]'); ok(await ev(nv, () => S.ui.sheet.k === "onboard" && /Welcome to JitsFlow/.test(document.getElementById("sheet").innerText)), "Just me goes to the study setup questions");
      await nv.tap('#sheetbar [data-a="obdone"]'); await nv.waitForTimeout(300); await nv.reload(); await nv.waitForTimeout(1200);
      ok(await ev(nv, () => !S.ui.sheet && S.ui.tab === "home" && [...document.querySelectorAll("nav.tabs button:not([hidden])")].map((b) => b.dataset.v).join() === "home,learn,journal,me"), "once set up, the first screen doesn't come back; self-study gets 4 tabs");
      ok(await ev(nv, () => { const t = document.querySelector(".tip"); return t && /One thing to study today/.test(t.textContent) && !/class|owe/.test(t.textContent); }), "their Home tip is about studying, not classes and fees they don't have");
      await nv.goto(URL + "/app/?start=1"); await nv.waitForTimeout(1200); ok(await ev(nv, () => S.ui.sheet && S.ui.sheet.k === "auth" && S.ui.authMode === "gym"), "?start=1 still opens Start your gym");
      await nc.close(); }
    { const { c: nc, p: nv } = await phone(); await nv.goto(URL + "/app/?signin"); await nv.waitForTimeout(1200);
      ok(await ev(nv, () => S.ui.sheet && S.ui.sheet.k === "auth" && S.ui.authMode === "login"), "a sign-in link skips the first screen"); await nc.close(); }
    // ---- student joins from the invite link
    const { c: sc, p: st } = await phone();
    await st.goto(invite); await st.waitForTimeout(900);
    ok(await ev(st, () => S.ui.sheet && S.ui.sheet.k === "auth" && document.getElementById("a-code").value.length === 8 && !/join=/.test(location.search)), "invite link opens sign-up with the code filled in");
    await st.fill("#a-name", "Chris"); await st.fill("#a-email", "chris@example.com"); await st.fill("#a-pass", "studentpass1");
    await st.tap('#sheetbar [type=submit]'); await st.waitForTimeout(900);
    ok(await ev(st, () => API.me && API.me.role === "student" && API.me.gym.name === "JPB Martial Arts Academy"), "student account created in the gym");
    if (await ev(st, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await st.tap('#sheetbar [data-a="obdone"]');
    ok(await ev(st, () => [...document.querySelectorAll("nav.tabs button:not([hidden])")].map((b) => b.textContent.trim()).join() === "Home,Classes,Learn,Journal,Me"), "students get Home, Classes, Learn, Journal, Me (no coach tabs)");
    await st.tap("header .avatar"); ok(await ev(st, () => S.ui.tab === "me" && location.hash === "#me" && /Chris/.test(document.getElementById("app").innerText)), "a student's initials button opens Me");
    await ev(st, () => { P().mastery.hg_frames = 2; P().mastery.knee_cut = 3; P().mastery.upa = 1; saveProgress(); });
    await st.waitForTimeout(1200);
    await st.tap('nav.tabs [data-v="home"]'); await st.waitForTimeout(600);
    ok(await ev(st, () => /Next class/i.test(document.body.innerText) && /No-gi: half guard/.test(document.querySelector(".nextclass").innerText) && /2 techniques to study/.test(document.querySelector(".nextclass").innerText)), "student sees the next class and the coach's plan");
    await st.locator('.nextclass [data-a="rsvp"]').tap(); await st.waitForTimeout(700);
    ok(await ev(st, () => /You're booked/.test(document.querySelector(".nextclass").innerText) && /You/.test(document.querySelector(".nextclass .who-line").innerText)), "student books from Today and shows up in the booked list");
    await wide(st, "student today");
    // student logs a session (goes to the server)
    await st.tap(".homehero .logbtn"); await st.selectOption("#f-tapped", "rnc"); await st.locator('#sheet [data-a="stuck"][data-v="hg_bot"]').tap();
    await st.tap('#sheetbar button[type=submit]'); await st.waitForTimeout(700);
    ok(await ev(st, async () => (await (await fetch("/api/logs")).json()).logs.length === 1), "logged session is saved on the server");
    // clear the phone: progress comes back from the server
    await ev(st, () => { localStorage.clear(); }); await st.reload(); await st.waitForTimeout(1500);
    ok(await ev(st, () => S.mode === "api" && lv("knee_cut") === 3 && S.sessions.length === 1), "after clearing the phone, progress and log come back from the account");
    // ---- coach sees who's coming and plans with it
    await co.tap('nav.tabs [data-v="coach-home"]'); await co.tap('nav.tabs [data-v="coach-schedule"]'); await ev(co, () => coachLoad()); await co.waitForTimeout(600);
    ok(await ev(co, () => /1\s*booked/i.test(document.querySelector(".calrow").innerText)), "coach sees 1 booked");
    await co.locator(".calrow").first().tap(); await co.waitForTimeout(700);
    ok(await ev(co, () => /Chris/.test(document.getElementById("sheet").innerText) && /ready for Blue/i.test(document.getElementById("sheet").innerText)), "class shows who's coming with their level");
    ok(await ev(co, () => /Suggested focus/i.test(document.getElementById("sheet").innerText) && /Getting stuck in: Half guard ×1/.test(document.getElementById("sheet").innerText) && /Getting tapped by: Rear-naked choke ×1/.test(document.getElementById("sheet").innerText)), "suggested focus uses their weak spots");
    const before = await ev(co, () => S.ui.classData.class.plan.ids.length);
    const add = co.locator('#sheet [data-a="addtoplan"]').first(); if (await add.count()) { await add.tap(); await co.waitForTimeout(600); }
    ok(await ev(co, (n) => S.ui.classData.class.plan.ids.length === n + 1, before), "coach adds a suggested technique to the plan");
    await co.locator('#sheet [data-a="attend"]').first().tap(); await co.waitForTimeout(500);
    ok(await ev(co, () => /✓ Here/.test(document.querySelector('#sheet [data-a="attend"]').innerText)), "coach marks the student present");
    await wide(co, "class sheet");
    await co.tap('#sheetbar [data-a="back"]');
    // ---- roster + student + payment
    await co.tap('nav.tabs [data-v="coach-members"]'); await co.tap('[data-a="stuview"][data-v="list"]'); await ev(co, () => coachLoad("roster")); await co.waitForTimeout(500);
    ok(await ev(co, () => /Chris/.test(document.getElementById("roster-list").innerText)), "roster lists the student");
    await co.locator('#roster-list [data-a="student"]').first().tap(); await co.waitForTimeout(700);
    await co.selectOption("#s-belt", "blue"); await co.selectOption("#s-stripes", "1"); await co.fill("#s-fee", "850"); await co.fill("#s-notes", "Strong underhook");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(800);
    ok(await ev(co, () => /Blue · 1 stripe/.test(document.getElementById("roster-list").innerText) && /Due/.test(document.getElementById("roster-list").innerText)), "coach sets belt and fee; roster shows fee due");
    await co.tap('nav.tabs [data-v="coach-money"]'); await co.tap('[data-a="paynew"]');
    await co.selectOption("#p-user", { label: "Chris" }); await co.fill("#p-amt", "850"); await co.fill("#p-ref", "CHRIS NOV");
    ok(await ev(co, () => document.getElementById("p-months").value === "1" && document.querySelectorAll("#p-months option").length === 12), "a payment covers 1 month unless the coach picks more (up to 12)");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(2000);
    ok(await ev(co, () => (COACH.payments || []).some((p) => p.amountCents === 85000 && p.months === 1)), "the payment is saved with the months it covers");
    await co.tap('[data-a="moneyfilter"][data-v="paid"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => /R\s?850/.test(document.querySelector(".stats").innerText) && /Chris/.test(document.getElementById("app").innerText)), "payment recorded and totals updated");
    await co.tap('nav.tabs [data-v="coach-members"]'); await co.tap('[data-a="stuview"][data-v="list"]');
    ok(await ev(co, () => /Paid/.test(document.getElementById("roster-list").innerText)), "roster shows the student as paid");
    { // On a yearly plan, a payment suggests 12 months and the year's price.
      const id = await ev(co, async () => { const pl = (await api("POST", "/coach/plans", { name: "Year up front", priceCents: 960000, period: "year" })).plan, c = students().find((x) => x.name === "Chris");
        await api("PATCH", "/coach/students/" + c.id, { planId: pl.id, feeCents: null }); await coachLoad("roster"); paySheet(c.id); return c.id; });
      await co.waitForTimeout(300);
      ok(await ev(co, () => document.getElementById("p-months").value === "12" && Number(document.getElementById("p-amt").value) === 9600), "for a yearly plan the payment covers 12 months and the year's price");
      await ev(co, async (cid) => { hideSheet(); await api("PATCH", "/coach/students/" + cid, { planId: null, feeCents: 85000 }); await coachLoad("roster"); }, id); }
    await wide(co, "coach payments/roster");
    // ---- coach imports the gym's website, checks it and saves
    await co.tap('nav.tabs [data-v="coach-gym"]'); await co.waitForTimeout(400);
    await co.fill("#gi-url", site.url.replace("http://", "")); await co.tap("#gymimpform [type=submit]"); await co.waitForTimeout(400);
    ok(await ev(co, () => /Reading/.test(document.querySelector(".impban").innerText) && !S.ui.sheet), "the website is read in the background (address typed without http://) while the coach keeps going");
    await co.waitForSelector('.impban [data-a="impreview"]', { timeout: 30000 });
    ok(await ev(co, () => /We read/.test(document.querySelector(".impban").innerText) && /\d+ classes/.test(document.querySelector(".impban").innerText) && /\d+ coaches/.test(document.querySelector(".impban").innerText) && !/coachs/.test(document.querySelector(".impban").innerText)), "when it's done, the banner says what was found: " + (await ev(co, () => document.querySelector(".impban").innerText)));
    await co.tap('.impban [data-a="impreview"]');
    await co.waitForSelector("#gymeditform", { timeout: 20000 });
    ok(await ev(co, () => document.querySelectorAll("#gymeditform .edrow.tt").length === 10 && document.querySelectorAll(".logoopt img").length >= 1 && /Read 10 pages of your site/.test(document.getElementById("sheet").innerText)), "import preview shows the class times, logo and pages read");
    ok(await ev(co, () => [...document.querySelectorAll('#gymeditform .edrow.tt')].some((r) => r.querySelector('[name^="tt-title"]').value === "No-gi: half guard" && /Not on your website: keep it\?/.test(r.innerText))), "the weekly class added in the app stays in the list, marked as not on the website");
    await wide(co, "import preview");
    const ctRow = await ev(co, () => [...document.querySelectorAll('#gymeditform .edrow.tt')].findIndex((r) => /Competition Training/.test(r.querySelector('[name^="tt-title"]').value)));
    await co.locator('#gymeditform [data-a="germ"][data-k="timetable"]').nth(ctRow).tap(); await co.waitForTimeout(200);
    ok(await ev(co, () => document.querySelectorAll("#gymeditform .edrow.tt").length === 9 && !/Competition Training/.test([...document.querySelectorAll('#gymeditform [name^="tt-title"]')].map((x) => x.value).join())), "coach removes a class time");
    ok(await ev(co, () => { const t = document.getElementById("ge-does").innerText; return /Save will/i.test(t) && document.querySelector("#ge-does [type=checkbox][disabled]").checked
      && document.querySelector('[name="ge-plans"]').checked && /Create 2 membership plans \(Adult unlimited, Kids/.test(t)
      && document.querySelector('[name="ge-cal"]').checked && /Put your 8 new weekly classes on the calendar \(kept 8 weeks ahead\)/.test(t)
      && /Drop-in class, Joining fee once-off stay as prices/.test(t); }), "the import review says what Save will do, all ticked: details, 2 plans (not the joining fee or drop-in) and the 8 new weekly classes: " + (await ev(co, () => document.getElementById("ge-does").innerText)));
    await co.fill('#gymeditform [name="name"]', "JPB Martial Arts Academy");
    await co.locator('[data-a="geadd"][data-v="coaches"]').tap(); await co.waitForTimeout(200); await co.fill('#gymeditform [name="co-name-2"]', "JP Buys"); await co.fill('#gymeditform [name="co-rank-2"]', "Black belt, head coach");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    ok(await ev(co, () => /Standard fee set to/.test(document.getElementById("toast").textContent)), "monthly rate becomes the standard fee: " + (await toast(co)));
    ok(/2 membership plans added\. \d+ classes on the calendar\./.test(await toast(co)) && await ev(co, () => ["Adult unlimited", "Kids (6-12)"].every((n) => COACH.roster.plans.some((p) => p.name === n)) && !COACH.roster.plans.some((p) => /Joining|Drop-in/.test(p.name))), "Save finishes setup: the plans are made and the classes are on the calendar: " + (await toast(co)));
    ok(await ev(co, () => { const g = document.querySelector(".gymcard"); return g && g.querySelectorAll(".ttline").length === 9 && /JP Buys/.test(g.innerText) && /Witkoppen/.test(g.innerText) && !!g.querySelector("img.gymlogo") && g.querySelector("img.gymlogo").naturalWidth > 0; }), "gym card shows the saved timetable, coaches, address and logo");
    ok(await ev(co, () => /JPB Martial Arts Academy/.test(document.querySelector(".gymhead").innerText) && !document.querySelector(".gymhead img.gymlogo.sm") && document.querySelectorAll("img.gbl").length === 1 && /Powered by JitsFlow\.com/.test(document.querySelector(".gymbrand").innerText)), "coach header keeps the edited name, one logo, Powered by JitsFlow.com");
    ok(await ev(co, () => { const tt = gymProfile().timetable, r = tt.find((x) => tt.filter((y) => y.day === x.day && y.title === x.title).length === 1);
      const out = impTimetable([{ day: r.day, start: r.start === "05:00" ? "05:30" : "05:00", end: "", title: r.title }]), m = out.filter((x) => x.id === r.id);
      return m.length === 1 && m[0]._was === r.start && out.length === tt.length && out.filter((x) => x._kept).length === tt.length - 1; }), "a re-import where the website moved a class on its day is that class at a new time, not a second one");
    await wide(co, "coach gym profile");
    const nWeekly = await ev(co, () => (COACH.classes || []).filter((c) => c.weekly).length);
    ok(nWeekly >= 8 && await ev(co, () => !document.getElementById("tt-weeks") && !/Put the timetable in the calendar/.test(document.getElementById("app").innerText)), `the timetable is on the calendar by itself, and the 'Add classes' chore is gone (${nWeekly} loaded)`);
    // moving a class time in Gym details moves its classes (nobody has booked them), with no duplicates
    await co.tap('[data-a="gymedit"]'); await co.waitForTimeout(300);
    const ttRow = await ev(co, () => { const t = [...document.querySelectorAll('#gymeditform [name^="tt-title"]')].findIndex((x) => /Muay Thai/i.test(x.value)); return t >= 0 ? t : 0; });
    const ttWas = await ev(co, (i) => ({ title: document.querySelector(`[name="tt-title-${i}"]`).value, start: document.querySelector(`[name="tt-start-${i}"]`).value }), ttRow);
    await co.fill(`[name="tt-start-${ttRow}"]`, "05:45"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    ok(/\d+ classes? moved/.test(await toast(co)) && await ev(co, async (w) => { const tz = API.me.gym.timezone || "Africa/Johannesburg", f = (c, o) => new Date(c.startsAt).toLocaleString("en-GB", { timeZone: tz, ...o });
      const cs = (await api("GET", `/classes?to=${new Date(Date.now() + 60 * 864e5).toISOString()}`)).classes.filter((c) => c.title === w.title && new Date(c.startsAt) > new Date());
      const moved = cs.filter((c) => f(c, { hour: "2-digit", minute: "2-digit" }) === "05:45"), day = moved[0] && f(moved[0], { weekday: "short" });
      return moved.length >= 7 && !cs.some((c) => f(c, { weekday: "short" }) === day && f(c, { hour: "2-digit", minute: "2-digit" }) === w.start); }, ttWas), "changing a class time in Gym details moves its classes: " + (await toast(co)));
    await co.tap('[data-a="gymedit"]'); await co.waitForTimeout(300); await co.fill(`[name="tt-start-${ttRow}"]`, ttWas.start); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    // ---- reopening the app (no #) lands on Today, and the website's coaches are there without visiting the Gym tab
    await co.goto(URL + "/app/"); await co.waitForTimeout(1500);
    ok(await ev(co, () => location.hash === "#coach-home" && COACH.view === "home"), "a coach reopening the app lands on Home: " + (await ev(co, () => location.hash)));
    ok(await ev(co, () => !!GYM.data && (gymProfile().coaches || []).length >= 2), "the gym's profile (coaches, timetable, prices) loads without opening the Gym tab");
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.tap('[data-a="classnew"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => document.getElementById("c-coach").tagName === "SELECT" && /Anna/.test(document.getElementById("c-coach").innerText)), "so Plan a class offers the website's coaches");
    await ev(co, () => hideSheet());
    // ---- the student sees their gym's details
    await st.tap('nav.tabs [data-v="me"]'); await st.waitForTimeout(1000);
    ok(await ev(st, () => { const g = document.querySelector(".gymcard"); return g && g.querySelectorAll(".ttline").length === 9 && /R\s?850/.test(g.innerText) && !!g.querySelector('a[href^="tel:"]') && !!g.querySelector('a[href*="wa.me"]') && !document.querySelector('[data-a="gymedit"]'); }), "student sees the timetable, rates and contact buttons (and can't edit)");
    await wide(st, "student gym card");
    // ---- student signs out
    await st.tap('nav.tabs [data-v="me"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
    ok(await ev(st, () => !API.me && S.mode === "local" && /Saved on this device/.test(document.getElementById("sync").textContent)), "student signs out");
    ok(await ev(st, () => lv("knee_cut") === 0 && S.sessions.length === 0 && !localStorage.getItem("rtb.progress") && !localStorage.getItem("rtb.owner")), "signing out clears their progress and log off the phone");
    // Someone else's data is still on this phone (their session ran out without signing out), and a new person signs up
    await ev(st, () => { localStorage.setItem("rtb.owner", JSON.stringify("999999")); localStorage.setItem("rtb.progress", JSON.stringify({ ...P(), mastery: { knee_cut: 4, upa: 2 } })); localStorage.setItem("rtb.sessions", JSON.stringify([{ id: "sOld", date: "2026-01-01", type: "Class" }])); });
    await st.reload(); await st.waitForTimeout(1200);
    ok(await ev(st, () => lv("knee_cut") === 0 && S.sessions.length === 0), "a previous account's leftovers aren't shown to the next person");
    await st.goto(URL + "/app/?join=" + invite.split("join=")[1]); await st.waitForTimeout(900);
    await st.fill("#a-name", "Newbie"); await st.fill("#a-email", "newbie@example.com"); await st.fill("#a-pass", "newbiepass1"); await st.tap("#sheetbar [type=submit]"); await st.waitForTimeout(1200);
    if (await ev(st, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await st.tap('#sheetbar [data-a="obdone"]');
    ok(await ev(st, async () => API.me.name === "Newbie" && lv("knee_cut") === 0 && (await (await fetch("/api/logs")).json()).logs.length === 0 && !(await (await fetch("/api/progress")).json()).data.mastery.knee_cut), "a new account on a used phone starts clean (nothing copied from the last person)");
    // Chris signs in on the same phone: Chris's data, not Newbie's
    await ev(st, () => { P().mastery.upa = 3; saveProgress(); }); await st.waitForTimeout(1000);
    await st.tap('nav.tabs [data-v="me"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
    await st.goto(URL + "/app/?signin=1"); await st.waitForTimeout(900);
    await st.fill("#a-email", "chris@example.com"); await st.fill("#a-pass", "studentpass1"); await st.tap("#sheetbar [type=submit]"); await st.waitForTimeout(1500);
    ok(await ev(st, () => API.me.name === "Chris" && lv("knee_cut") === 3 && lv("upa") !== 3 && S.sessions.length === 1), "signing in on a shared phone shows that account's data, not the last person's");
    await st.tap('nav.tabs [data-v="me"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
    // ---- forgotten password by email
    await st.goto(URL + "/app/?signin=1"); await st.waitForTimeout(900);
    await st.locator('#sheet [data-a="authmode"][data-v="forgot"]').tap(); await st.fill("#a-email", "chris@example.com");
    await st.tap("#sheetbar [type=submit]"); await st.waitForTimeout(900);
    ok(await ev(st, () => /Check your email/.test(document.getElementById("sheet").innerText)), "student asks for a reset link");
    const rmail = sink.mails.filter((m) => m.to[0] === "chris@example.com" && /Reset/.test(m.subject)).pop();
    const tok = rmail && (rmail.text.match(/\?reset=([0-9a-f]{64})/) || [])[1];
    ok(!!tok, "reset email arrives with a link");
    await st.goto(URL + "/app/?reset=" + tok); await st.waitForTimeout(900);
    ok(await ev(st, () => /Choose a new password/.test(document.getElementById("sheet").innerText) && !/reset=/.test(location.search)), "reset link opens the new-password sheet (and drops the token from the address bar)");
    await st.fill("#a-pass", "newstudentpass"); await st.tap("#sheetbar [type=submit]"); await st.waitForTimeout(1200);
    ok(await ev(st, () => API.me && API.me.email === "chris@example.com"), "student is signed in with the new password");
    await wide(st, "reset");
    // ---- coach invites by email
    await co.tap('nav.tabs [data-v="coach-gym"]'); await co.waitForTimeout(300);
    await co.fill("#inv-emails", "newkid@example.com, chris@example.com"); await co.tap("#inviteform [type=submit]"); await co.waitForTimeout(900);
    ok(/Sent 1 invite\. 1 already in your gym/.test(await toast(co)) && sink.mails.some((m) => m.to[0] === "newkid@example.com"), "coach invites students by email: " + (await toast(co)));
    // ---- calendar and quick class input
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.waitForTimeout(300);
    const dayK = await ev(co, () => { const d = new Date(Date.now() + 9 * 864e5); return ymd(d); });
    await ev(co, (k) => { const st = calState("coach"); st.anchor = k; st.sel = k; render(); }, dayK);
    await co.tap(`[data-a="classnewday"][data-v="${dayK}"]`); await co.waitForTimeout(300);
    ok(await ev(co, (k) => document.getElementById("c-date").value === k, dayK), "+ Add on a day fills in that date");
    await co.fill("#c-title", "No-gi: half guard"); await co.locator("#c-title").dispatchEvent("change"); await co.waitForTimeout(200);
    ok(await ev(co, () => { const c = COACH.classes.find((x) => x.title === "No-gi: half guard"); return document.getElementById("c-dur").value === String(c.durationMin) && document.getElementById("c-time").value === fmtHM(c.startsAt) && document.getElementById("c-coach").value === c.coach; }), "choosing a class run before fills in its length, time and coach");
    ok(await ev(co, () => document.getElementById("c-repeat").value === "weekly" && [...document.getElementById("c-repeat").options].map((o) => o.text).join("|") === "Every week|Just this once"), "Repeat starts on Every week (or Just this once)");
    const yK = await ev(co, () => ymd(new Date(Date.now() - 864e5)));
    await co.fill("#c-date", yK); await co.locator("#c-date").dispatchEvent("change");
    ok(await ev(co, () => document.getElementById("c-repeat").value === "0"), "a day already gone switches Repeat to Just this once");
    await co.fill("#c-date", dayK); await co.locator("#c-date").dispatchEvent("change");
    ok(await ev(co, () => document.getElementById("c-repeat").value === "weekly"), "and a day ahead back to Every week");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => document.querySelector("#toast .toastbtn")?.textContent === "Undo"), "the 'Added' toast has Undo");
    ok(/on the calendar every \w+, 8 weeks ahead/.test(await toast(co)) && await ev(co, (k) => calState("coach").sel === k && document.querySelectorAll(".calrow").length >= 1 && (gymProfile().timetable || []).some((r) => r.title === "No-gi: half guard"), dayK), "an every-week class goes on the weekly timetable and jumps to the day: " + (await toast(co)));
    await co.tap('[data-a="calmode"][data-v="month"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => document.querySelectorAll(".mcell").length >= 28 && [...document.querySelectorAll(".mcell i")].length >= 2), "month view shows a grid with class counts");
    await wide(co, "month calendar");
    await co.tap('[data-a="calmode"][data-v="week"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => !document.querySelector('[data-a="copyweek"]')), "with a weekly timetable there's no 'copy this week' chore");
    await wide(co, "week calendar");
    // ---- bookings, private lessons, memberships, insights
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.tap('[data-a="privnew"]');
    ok(await ev(co, () => document.querySelectorAll("#pv-grid .tchip").length >= 16 && getComputedStyle(document.getElementById("pv-date")).width === getComputedStyle(document.getElementById("pv-rep")).width), "private slots: hour chips to tap, and the date box is as wide as the others");
    await co.tap('[data-a="pvclear"]'); await co.tap('[data-a="pvtime"][data-v="07:00"]'); await co.tap('[data-a="pvtime"][data-v="07:00"]');
    await co.fill("#pv-other", "18:30"); await co.tap('[data-a="pvadd"]');
    ok(await ev(co, () => document.querySelector('#pv-grid [data-v="18:30"][aria-pressed="true"]') && /^1 time = 1 slot$/.test(document.getElementById("pv-sum").textContent)), "private slots: an odd time can be added, toggling a chip twice unpicks it");
    await co.selectOption("#pv-rep", "4"); ok(await ev(co, () => /1 time × 4 weeks = 4 slots/.test(document.getElementById("pv-sum").textContent) && /Add 4 slots/.test(document.getElementById("pv-go").textContent)), "private slots: repeating weekly shows how many slots it will add");
    await co.selectOption("#pv-rep", "1");
    await co.fill("#pv-price", "450"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(900);
    ok(await ev(co, () => [...document.querySelectorAll(".calrow.priv")].some((c) => /Open slot/.test(c.innerText) && /R\s?450/.test(c.innerText))), "coach adds a private lesson slot");
    await st.evaluate(() => { API.classes = null; }); await st.tap('nav.tabs [data-v="classes"]'); await st.waitForTimeout(900);
    ok(await ev(st, () => !document.querySelector('nav.tabs [data-v="classes"]').hidden && /No-gi: half guard/.test(document.getElementById("app").innerText) && !!document.querySelector(".bookcard.mine")), "student's Classes tab lists classes and marks their booking");
    await wide(st, "student classes");
    await st.tap('[data-a="bookview"][data-v="private"]'); await st.waitForTimeout(300);
    await st.locator('.bookcard.priv [data-a="rsvp"]').first().tap(); await st.waitForTimeout(900);
    ok(await ev(st, () => /Your private lessons/i.test(document.getElementById("app").innerText) && /You're booked/.test(document.querySelector(".bookcard.priv").innerText)), "student books the private lesson");
    await co.evaluate(() => coachLoad("classes")); await co.waitForTimeout(700);
    ok(await ev(co, () => [...document.querySelectorAll(".calrow.priv")].some((c) => /Booked by Chris/.test(c.innerText))), "coach sees who booked the private");
    await co.tap('nav.tabs [data-v="coach-money"]'); await co.tap('[data-a="moneyview"][data-v="setup"]'); await co.tap('[data-a="planedit"][data-v="new"]');
    await co.fill('#planform [name="name"]', "2x a week"); await co.fill('#planform [name="price"]', "650"); await co.fill('#planform [name="cpw"]', "2");
    await co.tap('#planform [type=submit]'); await co.waitForTimeout(800);
    ok(await ev(co, () => /2x a week/.test(document.getElementById("app").innerText) && /2\/week/.test(document.getElementById("app").innerText)), "coach adds a membership plan");
    // ---- private lesson packs and the access fee (Money > Setup), then a pack bought and used
    await co.tap('[data-a="packedit"][data-v="new"]');
    await co.fill('#packform [name="name"]', "10 private lessons"); await co.fill('#packform [name="lessons"]', "10"); await co.fill('#packform [name="price"]', "4500");
    await co.tap('#packform [type=submit]'); await co.waitForTimeout(800);
    ok(/Pack added/.test(await toast(co)) && await ev(co, () => /10 private lessons/.test(document.getElementById("packs-panel").innerText) && /10 lessons · R\s?4[\s,]?500/.test(document.getElementById("packs-panel").innerText)), "the head coach adds a private-lesson pack: " + (await toast(co)));
    ok(await ev(co, () => document.querySelector('#accessform [name=mode][value=none]').checked && document.querySelector('#accessform [data-acc="fee"]').hidden), "private-only clients pay nothing extra to start with");
    await co.check('#accessform [name=mode][value=fee]'); ok(await ev(co, () => !document.querySelector('#accessform [data-acc="fee"]').hidden), "picking the access fee shows its amount");
    await co.fill("#acc-fee", "150"); await co.tap('#accessform [type=submit]'); await co.waitForTimeout(900);
    ok(/Access fee saved/.test(await toast(co)) && await ev(co, () => /access fee of R\s?150 per month/.test(document.getElementById("accessform").innerText)), "and an access fee for private-only clients");
    await wide(co, "money setup with packs");
    await st.evaluate(async () => { API.pay = undefined; API.classes = null; await loadClasses(true); go("me"); }); await st.waitForTimeout(1200);
    ok(await ev(st, () => { const c = API.classes.find((x) => x.kind === "private" && x.myGoing), same = dayKey(c.startsAt).slice(0, 7) === todayK().slice(0, 7);
      return !!document.querySelector(".feecard") && (!same || (/Private lesson, .*R\s?450/.test(document.querySelector(".feecard").innerText) && API.pay.privatesCents === 45000)); }), "with no lessons bought, the booked private's price shows in the student's fees");
    await st.tap('.feecard [data-a="mypay"]'); await st.waitForTimeout(400);
    ok(await ev(st, () => /10 private lessons/.test(document.getElementById("mypacks").innerText) && !!document.querySelector('#mypop-pack option[value]:not([value=""])')), "the Pay sheet offers the pack (by EFT with proof here; by card once PayFast is on)");
    await st.selectOption("#mypop-pack", { index: 1 }); ok(await ev(st, () => document.getElementById("mypop-amt").value === "4500"), "picking the pack fills in its price");
    await st.evaluate(() => hideSheet());
    const chrisId = await ev(co, () => students().find((x) => x.name === "Chris").id);
    await ev(co, (id) => paySheet(id), chrisId); await co.waitForTimeout(200); await co.selectOption("#p-pack", { index: 1 });
    ok(await ev(co, () => document.getElementById("p-amt").value === "4500" && document.getElementById("p-covers").hidden), "recording a pack payment: its price fills in, and 'covers months' goes away");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1000);
    await st.evaluate(() => { API.pay = undefined; go("classes"); }); await st.waitForTimeout(1000); await st.tap('[data-a="bookview"][data-v="private"]'); await st.waitForTimeout(500);
    ok(await ev(st, () => /9 privates left · 1 booked/.test(document.getElementById("app").innerText) && API.pay.privatesCents === 0), "the student sees 9 privates left (one held for the private they booked), and owes nothing for it now");
    await st.evaluate(() => go("me")); await st.waitForTimeout(300);
    ok(await ev(st, () => /9 privates left/.test(document.querySelector(".feecard").innerText)), "it shows on their fees card (Me) too");
    await st.evaluate(() => go("classes")); await st.waitForTimeout(300);
    const privId = await ev(co, () => COACH.classes.find((c) => c.kind === "private" && c.going).id);
    await ev(co, (id) => classSheet(id), privId); await co.waitForTimeout(900);
    ok(await ev(co, () => /9 privates left/.test(document.getElementById("sheet").innerText)), "the coach sees the client's balance on the private lesson's bookings");
    await ev(co, (id) => studentSheet(id), chrisId); await co.waitForTimeout(900);
    ok(await ev(co, () => /9 privates left/.test(document.getElementById("stu-privs").innerText) && /Bought/.test(document.getElementById("stu-privs").innerText)), "and on their student page, with the ledger");
    await ev(co, () => hideSheet()); await co.tap('nav.tabs [data-v="coach-money"]'); await co.tap('[data-a="moneyview"][data-v="setup"]'); await co.waitForTimeout(300);
    await co.tap('nav.tabs [data-v="coach-members"]'); await co.tap('[data-a="stuview"][data-v="list"]'); await co.locator('#roster-list [data-a="student"]').first().tap(); await co.waitForTimeout(700);
    await co.selectOption("#s-plan", { label: "2x a week · R 650" }).catch(async () => { const v = await ev(co, () => [...document.querySelectorAll("#s-plan option")].find((o) => /2x a week/.test(o.textContent)).value); await co.selectOption("#s-plan", v); });
    await co.fill("#s-fee", ""); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(800);
    ok(await ev(co, () => /2x a week/.test(document.getElementById("roster-list").innerText)), "coach puts the student on the plan");
    // ---- private lesson prices by membership (Money > Setup > Private lessons), with the website's private lesson price to tap
    const webPlans = () => ev(co, () => { const m = /Use my website prices \((\d+)\)/.exec(plansPanel()); return m ? Number(m[1]) : 0; }), web0 = await webPlans();
    await ev(co, async () => { const p = gymProfile(); await api("PUT", "/coach/gym/profile", { profile: { ...p, rates: (p.rates || []).concat([{ name: "Private lesson (1-on-1)", price: 1200, currency: "ZAR", period: "class", note: "" }]) } }); await loadGym(true); });
    ok(await webPlans() === web0, "a private lesson price on the website isn't offered as a membership plan");
    await co.tap('nav.tabs [data-v="coach-money"]'); await co.tap('[data-a="moneyview"][data-v="setup"]'); await co.waitForTimeout(500);
    ok(await ev(co, () => /Private lessons/.test(document.getElementById("privates-panel").textContent) && !!document.querySelector("#privates-panel #packs-panel") && !!document.querySelector("#privates-panel #accessform")
      && document.querySelectorAll('#privpriceform [data-a="ratefill"]').length === 1 && /1-on-1/.test(document.querySelector('#privpriceform [data-a="ratefill"]').innerText)), "Money > Setup has a Private lessons section (with the access fee and packs), offering the website's private lesson price");
    await co.tap('#privpriceform [data-a="ratefill"]'); ok(await ev(co, () => document.getElementById("pp-fee").value === "1200"), "tapping the website's price fills it in");
    await co.tap('#privpriceform [type=submit]'); await co.waitForTimeout(800);
    ok(/Saved: R\s?1[\s,]?200 a private for clients without a membership/.test(await toast(co)), "the head coach sets R1200 for clients without a membership: " + (await toast(co)));
    const plan2 = await ev(co, () => COACH.roster.plans.find((p) => p.name === "2x a week").id);
    await co.tap(`[data-a="planedit"][data-v="${plan2}"]`);
    ok(await ev(co, () => !!document.querySelector('#planform [data-a="ratefill"]') && document.getElementById("pl-priv").value === ""), "the plan form has a private lesson price, with the website's price to tap");
    await co.fill("#pl-priv", "900"); await co.tap('#planform [type=submit]'); await co.waitForTimeout(900);
    ok(await ev(co, () => /privates R\s?900/.test(document.getElementById("app").innerText) && /2x a week\s*R\s?900/.test(document.getElementById("privates-panel").innerText)), "the plan's private price shows in the plans list and under Private lessons");
    await wide(co, "private lesson prices");
    const pv2 = await ev(co, async () => (await api("POST", "/classes", { kind: "private", title: "Private lesson", startsAt: new Date(Date.now() + 2 * 864e5).toISOString(), durationMin: 60, priceCents: 45000 })).class.id);
    await st.evaluate(() => { API.classes = null; API.pay = undefined; }); await st.tap('nav.tabs [data-v="classes"]'); await st.waitForTimeout(600); await st.tap('[data-a="bookview"][data-v="private"]'); await st.waitForTimeout(900);
    ok(await ev(st, (id) => { const card = document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard"); return /Uses 1 of your 9 privates/.test(card.innerText) && /Uses 1 of your privates/.test(document.querySelector(".bookcard.mine").innerText); }, pv2), "a student with pack lessons sees a private uses one of them");
    { const { c: c6, p: s6 } = await phone();
      await s6.goto(invite); await s6.waitForTimeout(900);
      await s6.fill("#a-name", "Pat Privates"); await s6.fill("#a-email", "pat@example.com"); await s6.fill("#a-pass", "patpass123"); await s6.tap("#sheetbar [type=submit]"); await s6.waitForTimeout(1200);
      if (await ev(s6, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await s6.tap('#sheetbar [data-a="obdone"]');
      await ev(s6, () => { hideSheet(); API.classes = null; go("book"); }); await s6.waitForTimeout(900); await s6.tap('[data-a="bookview"][data-v="private"]'); await s6.waitForTimeout(500);
      ok(await ev(s6, (id) => { const t = document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").innerText; return /R\s?450 for you/.test(t) && !/No membership/.test(t); }, pv2), "on the gym's standard fee they're a member: the slot's price, not the 'No membership' one");
      // a private-only client: their monthly fee set to 0 (the same clients who pay the access fee)
      await ev(co, async (id) => api("PATCH", `/coach/students/${id}`, { feeCents: 0 }), await ev(s6, () => API.me.id));
      await ev(s6, () => { API.classes = null; go("book"); }); await s6.waitForTimeout(900); await s6.tap('[data-a="bookview"][data-v="private"]'); await s6.waitForTimeout(500);
      ok(await ev(s6, (id) => /R\s?1[\s,]?200 for you \+ R\s?150 access fee (this month|in \w+) · No membership/.test(document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").innerText), pv2), "a client without a membership sees R1200 for them on the slot, plus the access fee they'd pay that month");
      await ev(s6, (id) => bookSheet(id), pv2); await s6.waitForTimeout(300);
      ok(await ev(s6, () => /R\s?1[\s,]?200 for you \+ R\s?150 access fee (this month|in \w+) · No membership/.test(document.getElementById("sheet").innerText)), "and when they open it to book");
      await s6.tap('#sheetbar [data-a="rsvp"]'); await s6.waitForTimeout(1200);
      ok(/Booked\. R\s?1[\s,]?200 for you · No membership\./.test(await toast(s6)), "booking says what it costs them: " + (await toast(s6)));
      await wide(s6, "private with my price");
      // the head coach makes private-only clients join a membership to book: Pat sees how to join instead of Book
      await co.check('#accessform [name=mode][value=membership]');
      ok(await ev(co, () => !document.querySelector('#accessform [data-acc="membership"]').hidden && document.querySelector('#accessform [data-acc="fee"]').hidden), "picking 'Need a membership to book' shows the plans to tick");
      await co.tap('#accessform [type=submit]'); await co.waitForTimeout(700); ok(/Tick the plans/.test(await toast(co)), "with none ticked, it asks for one");
      await co.check(`#accessform [name=plan][value="${plan2}"]`); await co.tap('#accessform [type=submit]'); await co.waitForTimeout(900);
      ok(/Only members on 2x a week can book privates/.test(await toast(co)) && await ev(co, () => /need the 2x a week membership to book/.test(document.getElementById("accessform").innerText) && document.querySelector('#accessform [name=mode][value=membership]').checked), "the head coach saves it: " + (await toast(co)));
      await wide(co, "access choice");
      const pv3 = await ev(co, async () => (await api("POST", "/classes", { kind: "private", title: "Private lesson", startsAt: new Date(Date.now() + 3 * 864e5).toISOString(), durationMin: 60, priceCents: 45000 })).class.id);
      await ev(s6, () => { hideSheet(); API.classes = null; API.pay = undefined; go("book"); }); await s6.waitForTimeout(1200); await s6.tap('[data-a="bookview"][data-v="private"]'); await s6.waitForTimeout(500);
      ok(await ev(s6, (id) => { const j = document.getElementById("privjoin"), card = document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard");
        return /Join the 2x a week membership to book privates/.test(j.innerText) && /2x a week\s*R\s?650/.test(j.innerText) && !card.querySelector('[data-a="rsvp"]') && /Members only/.test(card.innerText) && !!card.querySelector('[data-a="mypay"]'); }, pv3), "a student without the membership sees how to join (plan and price) instead of Book");
      ok(await ev(s6, (id) => { const t = document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").innerText; return /R\s?900 on 2x a week/.test(t) && !/for you/.test(t); }, pv3), "a members-only slot shows the member price (R900 on 2x a week), not a price they can't book at");
      ok(await ev(s6, () => /You're booked/.test(document.querySelector(".bookcard.mine").innerText)), "the private they already booked stays booked");
      await wide(s6, "privates for members only");
      await s6.tap('#privjoin [data-a="mypay"]'); await s6.waitForTimeout(400);
      ok(await ev(s6, () => S.ui.sheet && S.ui.sheet.k === "mypay" && /Join the 2x a week membership to book privates/.test(document.getElementById("payjoin").innerText) && !!document.querySelector("#payjoin a.wa")), "'How to join and pay' opens the Pay sheet, which says how to join");
      ok(await ev(s6, () => { const p = API.pay, left = Math.max(0, p.dueCents - p.paidCents - p.pendingCents), t = document.getElementById("payjoin").innerText;
        return /To join, pay R\s?650 for 2x a week/.test(t) && (!left || /plus what's due now/.test(t)) && Math.round(Number(document.getElementById("mypop-amt").value) * 100) === left + 65000; }), "the Pay sheet gives the amount to join (the plan's price plus what's due now) and fills it in");
      // the app was open when the gym switched to members only: tapping Book shows how to join, not just a toast
      await ev(s6, () => { hideSheet(); API.privAccess = null; render(); }); await s6.waitForTimeout(200);
      await s6.tap(`.bookcard [data-a="rsvp"][data-v="${pv3}"]`); await s6.waitForTimeout(1500);
      ok(await ev(s6, (id) => !!document.getElementById("privjoin") && !!document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").querySelector('[data-a="mypay"]'), pv3), "a stale Book button that's refused reloads the list, so 'how to join' shows");
      // on the ticked plan, but paused: told to restart it, not to join
      const patId = await ev(s6, () => API.me.id);
      await ev(co, async (id) => api("PATCH", `/coach/students/${id}`, { planId: COACH.roster.plans.find((p) => p.name === "2x a week").id, planStatus: "paused" }), patId);
      await ev(s6, () => { API.classes = null; go("book"); }); await s6.waitForTimeout(1200);
      ok(await ev(s6, (id) => { const j = document.getElementById("privjoin").textContent, card = document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").textContent;
        return /Your membership is paused/.test(j) && /Your 2x a week membership is paused\. Ask your coach to restart it/.test(j) && !/Join the/.test(j) && /Membership paused/.test(card) && !/How to join/.test(card); }, pv3), "a student whose plan is paused is told to ask their coach to restart it");
      await ev(co, async (id) => api("PATCH", `/coach/students/${id}`, { planId: null, planStatus: "active", feeCents: 0 }), patId);
      ok(await ev(s6, async (id) => { try { await api("PUT", `/classes/${id}/rsvp`, { going: true }); return false; } catch (e) { return /Join the 2x a week membership/.test(e.message); } }, pv3), "and the server won't book it for them either");
      await ev(co, async () => { const j = await api("PATCH", "/coach/gym/access-fee", { mode: "fee", accessFeeCents: 15000 }); COACH.payInfo = { ...COACH.payInfo, ...j }; render(); });
      await ev(s6, () => { hideSheet(); API.classes = null; go("book"); }); await s6.waitForTimeout(1200);
      ok(await ev(s6, (id) => !document.getElementById("privjoin") && !!document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").querySelector('[data-a="rsvp"]'), pv3), "back on the access fee, they can book again");
      // the access fee shows before they book, in a month they have no private yet
      const pv4 = await ev(co, async () => (await api("POST", "/classes", { kind: "private", title: "Private later", startsAt: new Date(Date.now() + 40 * 864e5).toISOString(), durationMin: 60, priceCents: 45000 })).class.id);
      await ev(s6, () => { API.classes = null; go("book"); }); await s6.waitForTimeout(1200);
      ok(await ev(s6, (id) => /R\s?1[\s,]?200 for you \+ R\s?150 access fee in \w+/.test(document.querySelector(`.bookcard [data-v="${id}"]`).closest(".bookcard").innerText), pv4), "a private-only client sees the access fee on a slot before booking");
      await ev(s6, (id) => bookSheet(id), pv4); await s6.waitForTimeout(300);
      ok(await ev(s6, () => /\+ R\s?150 access fee/.test(document.getElementById("sheet").innerText) && /access fee of R\s?150 in each month you have a private/.test(document.getElementById("sheet").innerText)), "and on the booking sheet, with what it's for");
      await wide(s6, "private with access fee");
      await ev(s6, () => hideSheet()); await ev(co, async (id) => api("DELETE", "/classes/" + id, { notify: false }), pv4);
      // a coach puts someone on a private themselves (Add a student), even in members-only mode
      await ev(co, (id) => classSheet(id), pv3); await co.waitForTimeout(900);
      ok(await ev(co, () => /Students book from Classes or their Home screen/.test(document.getElementById("sheet").innerText)), "the empty class sheet points students to Classes or Home");
      await co.tap('#sheet [data-a="clsaddopen"]'); await co.waitForTimeout(500); await co.fill("#cls-q", "pat"); await co.waitForTimeout(100);
      ok(await ev(co, () => [...document.querySelectorAll("#clsadd .trow")].filter((b) => !b.hidden).map((b) => b.querySelector(".nm").textContent).join() === "Pat Privates"), "the coach searches their students to add one");
      await wide(co, "class sheet add a student");
      await co.tap('#clsadd .trow:not([hidden])'); await co.waitForTimeout(1200);
      ok(await ev(co, () => S.ui.classData.attendees.some((a) => a.name === "Pat Privates" && a.going && !a.attended) && /Pat Privates/.test(document.querySelector("#sheet .attrow").innerText) && !/Pat Privates/.test((document.getElementById("clsadd") || { innerText: "" }).innerText)), "and they're booked on the private (not checked in): " + (await toast(co)));
      await ev(s6, () => { API.classes = null; go("book"); }); await s6.waitForTimeout(1200);
      ok(await ev(s6, (id) => API.classes.find((c) => c.id === id).myGoing, pv3), "the student sees the private as booked");
      await ev(co, () => hideSheet());
      await ev(co, async (id) => api("DELETE", "/classes/" + id, { notify: false }), pv3);
      await c6.close(); }
    await ev(co, (id) => classSheet(id), pv2); await co.waitForTimeout(900);
    ok(await ev(co, () => /R\s?1[\s,]?200 · No membership/.test(document.getElementById("sheet").innerText)), "the head coach sees what the booking costs");
    await ev(co, (id) => classSheet(id), privId); await co.waitForTimeout(900);
    ok(await ev(co, () => /From a pack/.test(document.getElementById("sheet").innerText)), "and that a booking is paid from a pack");
    await ev(co, () => hideSheet());
    await st.evaluate(() => { API.mem = undefined; }); await st.tap('[data-a="bookview"][data-v="classes"]'); await st.waitForTimeout(900);
    ok(await ev(st, () => /2x a week/.test(document.querySelector(".memcard").innerText) && new RegExp((() => { const c = API.classes.find((x) => x.myGoing && x.kind !== "private"); const ws = weekStart(todayK()); const k = dayKey(c.startsAt); return (k >= ws && k <= addDays2(ws, 6) ? 1 : 0) + "\\/2"; })()).test(document.querySelector(".memcard").innerText)), "student sees their plan and bookings used this week");
    await co.tap('nav.tabs [data-v="coach-members"]'); await co.tap('[data-a="stuview"][data-v="insights"]'); await co.waitForTimeout(1200);
    ok(await ev(co, () => !!document.querySelector(".chart svg .bar") && /Active members/i.test(document.getElementById("app").innerText) && document.querySelectorAll(".segpills:not(.subseg) button").length === 6 && /Chris/.test(document.getElementById("app").innerText)), "coach opens Insights: numbers, weekly chart, student groups");
    await co.locator(".chart .bar").last().tap(); ok(/visits by/.test(await toast(co)), "tapping a bar reads out the week");
    await wide(co, "insights");
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.locator(".calrow").first().tap(); await co.waitForTimeout(700);
    await co.tap('#sheetbar [data-a="back"]');
    // ---- Today's money links open the right Money screen, and the checklist's import goes to the import box
    await co.tap('nav.tabs [data-v="coach-home"]'); await co.waitForTimeout(300);
    await ev(co, () => { COACH.moneyView = "setup"; COACH.payments = (COACH.payments || []).concat([{ id: "x1", status: "pending", amountCents: 100, paidOn: todayK(), userId: null }]); render(); });
    await co.tap('[data-a="moneygo"][data-v="payments"]'); await co.waitForTimeout(400);
    ok(await ev(co, () => COACH.view === "money" && COACH.moneyView === "payments" && document.querySelector('[data-a="moneyview"][data-v="payments"]').getAttribute("aria-pressed") === "true"), "Today's 'payments to check' opens Money > Payments, even after Setup was last used");
    await ev(co, () => { COACH.payments = COACH.payments.filter((p) => p.id !== "x1"); coachGo("today"); const b = document.createElement("button"); b.dataset.a = "setupgo"; b.dataset.v = "gym"; b.id = "t-setup"; document.getElementById("app").appendChild(b); });
    await co.tap("#t-setup"); await co.waitForTimeout(900);
    ok(await ev(co, () => { const r = document.getElementById("gymimpform").getBoundingClientRect(); return COACH.view === "gym" && r.top < innerHeight && r.bottom > 0 && document.activeElement && document.activeElement.id === "gi-url"; }), "checklist 'Import your website' scrolls to the import box and puts the cursor in it");
    // ---- bulk add: "Lerato's mom" with no name for the mom stays a kid, and her brother on the same number goes in too
    await ev(co, () => { hideSheet(); bulkSheet(intake(parseList("Lerato's mom 083 555 1234\nThabo's mom 083 555 1234"))); }); await co.waitForTimeout(200);
    await ev(co, () => bulkAdd()); await co.waitForTimeout(1200);
    ok(await ev(co, () => { const ro = COACH.roster.people, l = ro.find((p) => p.name === "Lerato"), t = ro.find((p) => p.name === "Thabo"); return l && t && l.parentName && t.parentName && l.phone === "083 555 1234"; }), "kids added as \"X's mom\" stay kids, and a sibling on the same number isn't skipped");
    ok(await ev(co, () => /Hi there/.test(remindText({ ...COACH.roster.people.find((p) => p.name === "Lerato"), feeCents: 85000, paidCents: 0, reference: "JFX" }, { currency: "ZAR", month: todayK().slice(0, 7) })) ), "and a reminder to that number greets the parent, not the kid");
    // ---- fee reminders for someone who isn't on the app carry their own invite link
    const thandi = await ev(co, async () => { const j = await api("POST", "/coach/students", { name: "Thandi Mokoena", phone: "082 555 0009" }); await api("PATCH", "/coach/students/" + j.id, { feeCents: 85000 }); await coachLoad("roster"); COACH.money = null; COACH.moneyView = "month"; COACH.moneyFilter = "owing"; coachGo("money"); return j.id; });
    await co.waitForTimeout(1500);
    ok(await ev(co, () => { const row = [...document.querySelectorAll(".mrow")].find((r) => /Thandi Mokoena/.test(r.innerText)), a = row && row.querySelector("a.wa"); return !!a && /claim=/.test(decodeURIComponent(a.href)) && !/#book/.test(decodeURIComponent(a.href)); }), "the WhatsApp reminder for a student who isn't on the app links to their invite (claim) link");
    // ---- someone the coach added signs up through the gym's link: "Are you ...?" links them to their record
    const sipho = await ev(co, async () => (await api("POST", "/coach/students", { name: "Sipho Ndlovu", phone: "082 555 0001" })).id);
    { const { c: c3, p: s3 } = await phone();
      await s3.goto(invite); await s3.waitForTimeout(900);
      await s3.fill("#a-name", "Sipho Ndlovu"); await s3.fill("#a-email", "sipho@example.com"); await s3.fill("#a-pass", "siphopass1"); await s3.tap("#sheetbar [type=submit]"); await s3.waitForTimeout(900);
      ok(await ev(s3, () => S.ui.sheet && S.ui.sheet.k === "authask" && /Are you Sipho Ndlovu\?/.test(document.getElementById("sheet").innerText) && !API.me), "signing up with the name the coach added asks 'Are you Sipho Ndlovu?'");
      await s3.tap('#sheetbar [data-a="authlink"]:not([data-v="no"])'); await s3.waitForTimeout(1200);
      ok(await ev(s3, (id) => API.me && API.me.id === id && API.me.gym, sipho), "saying yes signs them into that record");
      await c3.close(); }
    const lindi = await ev(co, async () => (await api("POST", "/coach/students", { name: "Lindiwe Zulu", phone: "082 555 0002" })).id);
    { const { c: c4, p: s4 } = await phone();
      await s4.goto(invite); await s4.waitForTimeout(900);
      await s4.fill("#a-name", "Lindi Z"); await s4.fill("#a-email", "lindi@example.com"); await s4.fill("#a-pass", "lindipass1"); await s4.fill("#a-wa", "+27 82 555 0002"); await s4.tap("#sheetbar [type=submit]"); await s4.waitForTimeout(900);
      ok(await ev(s4, () => S.ui.sheet && S.ui.sheet.k === "authask" && /Lindiwe Zulu/.test(document.getElementById("sheet").innerText)), "the same WhatsApp number asks too");
      await s4.tap('#sheetbar [data-a="authlink"][data-v="no"]'); await s4.waitForTimeout(1200);
      ok(await ev(s4, (id) => API.me && API.me.id !== id && API.me.gym, lindi), "saying no makes a new account");
      await c4.close(); }
    await ev(co, async () => { await coachLoad("roster"); COACH.stuView = "list"; coachGo("students"); }); await co.waitForTimeout(400);
    ok(await ev(co, () => /Possible duplicate/.test(document.getElementById("roster-list").innerText)), "the coach sees a possible duplicate in the roster");
    const lindiApp = await ev(co, () => COACH.roster.people.find((p) => p.name === "Lindi Z").id);
    await ev(co, (id) => studentSheet(id), lindiApp); await co.waitForTimeout(900);
    ok(await ev(co, () => /Possible duplicate/.test(document.getElementById("sheet").innerText) && !!document.querySelector('#sheet [data-a="mergeask"]')), "their student page offers a merge");
    await co.tap('#sheet [data-a="mergeask"]'); await co.waitForTimeout(300); await co.tap('#sheetbar [data-a="mergeyes"]'); await co.waitForTimeout(1500);
    ok(/Merged/.test(await toast(co)) && await ev(co, (id) => !COACH.roster.people.some((p) => p.id === id) && COACH.roster.people.some((p) => p.name === "Lindi Z" && !p.sameAs), lindi), "merging leaves one record");
    await ev(co, () => hideSheet());
    // ---- a signed-in student with no gym taps the invite link: they're asked to join
    { const { c: c5, p: s5 } = await phone();
      await s5.goto(URL + "/app/?signin=1"); await s5.waitForTimeout(900); await s5.tap('[data-a="authmode"][data-v="register"]');
      await s5.fill("#a-name", "Gymless Gail"); await s5.fill("#a-email", "gail@example.com"); await s5.fill("#a-pass", "gailpass11"); await s5.tap("#sheetbar [type=submit]"); await s5.waitForTimeout(1200);
      await s5.goto(invite); await s5.waitForTimeout(1200);
      ok(await ev(s5, () => S.ui.sheet && S.ui.sheet.k === "join" && /Join your gym/.test(document.getElementById("sheet").innerText)), "a signed-in student without a gym who opens the invite link is asked to join");
      await s5.tap('#sheetbar [data-a="joingym"]'); await s5.waitForTimeout(900);
      ok(await ev(s5, () => API.me.gym && API.me.gym.name === "JPB Martial Arts Academy"), "and joins with one tap");
      await ev(s5, () => { hideSheet(); go("settings"); }); await s5.waitForTimeout(300);
      await s5.tap('[data-a="leavegym"]'); await s5.waitForTimeout(300);
      ok(await ev(s5, () => /Leave your gym\?/.test(document.getElementById("sheet").innerText) && /keep your account/.test(document.getElementById("sheet").innerText)), "a student can leave their gym (it asks first)");
      await s5.tap('#sheetbar [data-a="leavegymyes"]'); await s5.waitForTimeout(900);
      ok(/left your gym/.test(await toast(s5)) && await ev(s5, () => API.me && !API.me.gym && !!document.getElementById("joinform")), "they keep their account, with no gym");
      await c5.close(); }
    // ---- a coach removes another coach from the Gym tab
    { const cc0 = await ev(co, () => API.me.gym.coachCode);
      const r2 = await fetch(URL + "/api/auth/register", { method: "POST", headers: { "content-type": "application/json", "x-jf": "1" }, body: JSON.stringify({ code: cc0, name: "Leaving Coach", email: "leaving@example.com", password: "leavingpass1" }) });
      const leaveCookie = (r2.headers.get("set-cookie") || "").split(";")[0];
      await ev(co, () => { hideSheet(); return coachLoad("roster"); }); await co.tap('nav.tabs [data-v="coach-gym"]'); await co.waitForTimeout(400);
      ok(r2.status === 201 && await ev(co, () => /Leaving Coach/.test(document.getElementById("coach-list").innerText) && !/Coach JP/.test(document.getElementById("coach-list").innerText)), "the Gym tab lists the other coaches (not yourself)");
      // the other coach's own app: no Money tab, no fees, and they're told who the head coach is
      { const c6 = await b.newContext({ ...devices["iPhone 13"] }); await c6.addCookies([{ name: "jf_s", value: leaveCookie.split("=")[1], url: URL }]); const k6 = await c6.newPage(); k6.on("pageerror", (e) => errs.push(e.message));
        await k6.goto(URL + "/app/#coach-money"); await k6.waitForTimeout(1800); await ev(k6, () => hideSheet());
        ok(await ev(k6, () => isCoach() && !isHead() && document.querySelector('nav.tabs [data-v="coach-money"]').hidden && !document.querySelector('nav.tabs [data-v="coach-members"]').hidden && !/Money/.test(document.querySelector(".gymhead h1").innerText)), "another coach has no Money tab (and its link opens Today)");
        ok(await ev(k6, () => !/to check|haven't paid/.test(document.getElementById("app").innerText) && !document.querySelector('[data-a="paynew"]')), "their Today has no money items");
        await k6.tap('nav.tabs [data-v="coach-members"]'); await k6.waitForTimeout(500);
        ok(await ev(k6, () => !/Fees due/.test(document.getElementById("app").innerText) && !document.querySelector("#roster-list .pill.due, #roster-list .pill.ok")), "their roster has no fees");
        await ev(k6, () => studentSheet(students().find((x) => x.name === "Chris").id)); await k6.waitForTimeout(900);
        ok(await ev(k6, () => !document.getElementById("s-fee") && !document.getElementById("s-plan") && !/Payments/.test(document.getElementById("sheet").innerText) && /9 privates left/.test(document.getElementById("sheet").innerText)), "a student's page has no plan, fee or payments, but shows their privates left");
        await k6.tap("#sheetbar [type=submit]"); await k6.waitForTimeout(800); ok(/Student saved/.test(await toast(k6)), "and they can still save it: " + (await toast(k6)));
        await ev(k6, () => { hideSheet(); coachGo("gym"); }); await k6.waitForTimeout(500);
        ok(await ev(k6, () => /Coach JP is the head coach/.test(document.getElementById("app").innerText) && !document.getElementById("g-fee") && !document.querySelector(".planpanel") && !document.querySelector('[data-a="headask"]') && /Head coach/.test(document.getElementById("coach-list").innerText) && !document.querySelector('#coach-list [data-a="coachdelask"]') && !document.getElementById("gymdel")), "their Gym tab names the head coach, who they can't remove, and has no fee, JitsFlow plan or Delete gym");
        await wide(k6, "second coach gym tab");
        await c6.close(); }
      // the head coach hands the role over (it asks first), and gets it back
      ok(await ev(co, () => /You see the money/.test(document.getElementById("app").innerText)), "the head coach is told the money is theirs");
      await co.locator('#coach-list [data-a="headask"]').tap(); await co.waitForTimeout(300);
      ok(await ev(co, () => /Make Leaving the head coach\?/.test(document.getElementById("sheet").innerText)), "handing over asks first");
      await co.tap('#sheetbar [data-a="headyes"], #sheet [data-a="headyes"]'); await co.waitForTimeout(1200);
      ok(/Leaving is the head coach now/.test(await toast(co)) && await ev(co, () => !isHead() && document.querySelector('nav.tabs [data-v="coach-money"]').hidden && /Leaving Coach is the head coach/.test(document.getElementById("app").innerText)), "after handing over, the Money tab goes: " + (await toast(co)));
      const back = await fetch(URL + "/api/coach/head", { method: "POST", headers: { "content-type": "application/json", "x-jf": "1", cookie: leaveCookie }, body: JSON.stringify({ userId: await ev(co, () => API.me.id) }) });
      await ev(co, async () => { API.me = (await api("GET", "/me")).me; await coachLoad(); coachGo("gym"); }); await co.waitForTimeout(500);
      ok(back.status === 200 && await ev(co, () => isHead() && !document.querySelector('nav.tabs [data-v="coach-money"]').hidden), "handed back, it returns");
      await co.locator('#coach-list [data-a="coachdelask"]').tap(); await co.waitForTimeout(300);
      ok(await ev(co, () => /Remove Leaving\?/.test(document.getElementById("sheet").innerText)), "removing a coach asks first");
      await co.tap('#sheetbar [data-a="coachdelyes"], #sheet [data-a="coachdelyes"]'); await co.waitForTimeout(900);
      ok(/Coach removed/.test(await toast(co)) && await ev(co, (c) => API.me.gym.coachCode !== c && !document.getElementById("coach-list") && document.body.innerText.includes(API.me.gym.coachCode), cc0), "they're removed and the coach code shown is the new one");
      const me2 = await (await fetch(URL + "/api/me", { headers: { cookie: leaveCookie } })).json();
      ok(me2.me === null, "the removed coach is signed out"); }
    // ---- money that adds up: running balances, the months a payment is for, trials that end, pauses with dates, bulk-add defaults, picking a plan
    { const { p: hb } = await phone(), pl = new Pool({ connectionString: DB });
      await hb.goto(URL + "/app/"); await hb.waitForTimeout(500);
      await ev(hb, () => api("POST", "/auth/start-gym", { gym: "Owe Gym", name: "Owe Head", email: "head@owe.test", password: "owehead11" }));
      await hb.reload(); await hb.waitForTimeout(900); await ev(hb, () => hideSheet());
      const g = await ev(hb, () => API.me.gym), zday = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }), M0 = zday(Date.now()).slice(0, 7);
      const mA = (n) => new Date(Date.UTC(+M0.slice(0, 4), +M0.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7), M1 = mA(-1);
      const mon = (m) => new Date(m + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
      const adult = (await ev(hb, () => api("POST", "/coach/plans", { name: "Adult", priceCents: 85000, period: "month" }))).plan;
      await ev(hb, () => api("POST", "/coach/plans", { name: "Kids", priceCents: 60000, period: "month" }));
      const add = (name) => ev(hb, (a) => api("POST", "/coach/students", { name: a[0], phone: "082 610 " + a[2], planId: a[1] }).then((j) => j.id), [name, adult.id, String(1000 + Math.floor(Math.random() * 8999))]);
      const johan = await add("Johan Arrears"), thabo = await add("Thabo Trial"), sbu = await add("Sbu Pause");
      await pl.query("update gyms set bill_start=$2 where id=$1", [g.id, M1 + "-01"]); await pl.query("update users set created_at=now() - interval '1 month 2 days' where gym_id=$1 and role='student'", [g.id]);
      await ev(hb, () => coachLoad()); await hb.waitForTimeout(800);
      ok(await ev(hb, () => /3\s*owe fees · R\s?5\s?100/.test(document.getElementById("app").innerText)), "Home counts everyone who owes, from any month: " + await ev(hb, () => (document.getElementById("app").innerText.match(/.*owe fees.*/) || [""])[0]));
      await ev(hb, () => { COACH.money = null; coachGo("money"); }); await hb.waitForTimeout(1200);
      const row = await ev(hb, (id) => { const b = document.querySelector(`.mrow [data-a="student"][data-v="${id}"]`); return b ? b.closest(".mrow").innerText : ""; }, johan);
      ok(/Owes R\s?1\s?700 · \w+ \+ \w+/.test(row) && /Overdue/.test(row), "a Money row shows the running balance and the months: " + row.replace(/\n/g, " "));
      ok(await ev(hb, (a) => remindText(COACH.money.students.find((s) => s.id === a[0]), COACH.money).includes(`is due for ${a[1]} and ${a[2]}`), [johan, mon(M1), mon(M0)]), "the WhatsApp reminder asks for both months, by name");
      // Record a payment: the months it will pay come from the server, from the date paid and the amount, and For is where they start
      { const forTxt = () => ev(hb, () => document.getElementById("p-for").options[0].textContent), hint = () => ev(hb, () => document.getElementById("p-for-hint").textContent), mt = (ms) => ev(hb, (a) => monthsTxt(a), ms);
        await ev(hb, (id) => paySheet(id), johan); await hb.waitForTimeout(900);
        ok(await forTxt() === `${await mt([M1, M0])} (worked out for you)`, "the sheet names both months R1 700 pays: " + await forTxt());
        await hb.fill("#p-amt", "850"); await hb.dispatchEvent("#p-amt", "change"); await hb.fill("#p-date", M1 + "-28"); await hb.dispatchEvent("#p-date", "change"); await hb.waitForTimeout(700);
        ok(await forTxt() === `${await mt([M1])} (worked out for you)`, "dated last month, R850 pays last month: " + await forTxt());
        await hb.fill("#p-date", await ev(hb, () => today())); await hb.dispatchEvent("#p-date", "change"); await hb.waitForTimeout(700);
        ok(await forTxt() === `${await mt([M0])} (worked out for you)`, "dated today, it pays this month: " + await forTxt());
        await hb.fill("#p-amt", "1700"); await hb.dispatchEvent("#p-amt", "change"); await hb.selectOption("#p-for", M1); await hb.waitForTimeout(700);
        ok(await hint() === `Pays ${await mt([M1, M0])}.`, "For last month with R1 700: it says it pays last month and this one: " + await hint());
        await ev(hb, () => hideSheet()); await hb.waitForTimeout(300); }
      await hb.tap(`[data-a="paidnow"][data-v="${johan}"]`); await hb.waitForTimeout(1200);
      ok(/Recorded R\s?1\s?700/.test(await toast(hb)) && await ev(hb, (id) => COACH.payments.some((p) => p.userId === id && p.forMonths && p.forMonths.length === 2), johan), "one tap on Paid records everything owed, for both months");
      // a trial that's run out: Make active from Home
      await ev(hb, (id) => api("PATCH", `/coach/students/${id}`, { planStatus: "trial" }), thabo); await pl.query("update users set trial_ends=current_date - 1 where id=$1", [thabo]);
      await ev(hb, () => coachGo("home")); await ev(hb, () => coachLoad("roster")); await hb.waitForTimeout(700);
      ok(await ev(hb, () => /Thabo's\s*trial ended/.test(document.getElementById("app").innerText)), "Home says when a trial has ended");
      await hb.tap(`[data-a="trialset"][data-v="${thabo}:active"]`); await hb.waitForTimeout(900);
      ok(/Thabo is active/.test(await toast(hb)) && await ev(hb, (id) => COACH.roster.people.find((p) => p.id === id).planStatus === "active", thabo), "one tap makes them active");
      // pausing from the student sheet: how long, and back to the same search on the roster after saving
      await ev(hb, () => { coachGo("members"); COACH.q = "Sbu"; render(); }); await hb.waitForTimeout(400);
      await hb.locator(`#roster-list [data-a="student"][data-v="${sbu}"]`).tap(); await hb.waitForTimeout(900);
      ok(await ev(hb, () => document.getElementById("s-pause").hidden), "the pause length only shows when pausing");
      await hb.selectOption("#s-status", "paused"); await hb.waitForTimeout(150);
      ok(await ev(hb, () => !document.getElementById("s-pause").hidden && document.querySelector('[name=pmonths]:checked').value === "1"), "pausing offers 1 month (the default), 2 months or until I say");
      await hb.check('[name=pmonths][value="2"]'); await hb.tap("#sheetbar [type=submit]"); await hb.waitForTimeout(1200);
      ok(/Paused\. Fees start again in/.test(await toast(hb)) && await ev(hb, (a) => { const p = COACH.roster.people.find((x) => x.id === a[0]); return p.planStatus === "paused" && p.pause && p.pause.until === a[1]; }, [sbu, mA(2)]), "saved: paused for 2 months, and it says when fees start again");
      ok(await ev(hb, () => !S.ui.sheet && COACH.view === "members" && document.getElementById("r-q").value === "Sbu" && document.querySelectorAll("#roster-list [data-a=student]").length === 1), "after saving, the roster is where it was, with the same search");
      // bulk add: one plan line, and billing from the next due date with a one-tap "bill this month too"
      await ev(hb, () => bulkSheet(intake([{ name: "Bulk Adult", phone: "082 611 0001" }, { name: "Bulk Kid", parentName: "Bulk Mom", phone: "082 611 0002" }]))); await hb.waitForTimeout(400);
      ok(await ev(hb, () => /Plan: Adult \(kids: Kids\) · change/.test(document.getElementById("bulk-plan").innerText)), "bulk add has one line for the plans: " + await ev(hb, () => document.getElementById("bulk-plan").innerText.split("\n")[0]));
      await hb.tap("#sheetbar [data-a=bulkadd]"); await hb.waitForTimeout(1500);
      ok(await ev(hb, (m) => /Billing starts/.test(document.getElementById("toast").innerText) && document.querySelector("#toast .toastbtn").textContent === `Bill ${m} too`, mon(M0)), "the toast says when billing starts, with Bill this month too: " + await toast(hb));
      await hb.tap("#toast .toastbtn"); await hb.waitForTimeout(1200);
      ok(new RegExp(`${mon(M0)} is billed too`).test(await toast(hb)) && await ev(hb, () => { const p = COACH.roster.people.find((x) => x.name === "Bulk Adult"), k = COACH.roster.people.find((x) => x.name === "Bulk Kid"); return p.planName === "Adult" && k.planName === "Kids" && p.owedCents === 85000 && k.owedCents === 60000; }), "one tap bills this month too, on the right plans");
      // a new member picks their plan
      const { p: nm } = await phone(); await nm.goto(URL + "/app/"); await nm.waitForTimeout(500);
      await ev(nm, (c) => api("POST", "/auth/register", { code: c, name: "Nia New", email: "nia@owe.test", password: "niapass11" }), g.studentCode || (await ev(hb, () => API.me.gym.studentCode)));
      await nm.reload(); await nm.waitForTimeout(900); await ev(nm, () => { hideSheet(); go("classes"); }); await nm.waitForTimeout(1200);
      ok(await ev(nm, () => /Pick your plan/.test(document.getElementById("pickplan").innerText) && /Adult/.test(document.getElementById("pickplan").innerText)), "a new member's membership card offers the gym's plans");
      await nm.tap(`#pickplan [data-a="pickplan"][data-v="${adult.id}"]`); await nm.waitForTimeout(1200);
      ok(/You picked Adult/.test(await toast(nm)) && await ev(nm, () => API.mem.status === "trial" && /Free trial/.test(document.getElementById("app").innerText)), "picking one starts a free trial");
      await ev(nm, () => myPaySheet()); await nm.waitForTimeout(300);
      ok(await ev(nm, () => [...document.querySelectorAll("#mypop-pack option")].some((o) => /^Joining: Adult/.test(o.textContent) && o.selected) && document.getElementById("mypop-amt").value === "850"), "the proof form's What's it for? has the plan, with its price");
      await nm.context().close(); await hb.context().close(); await pl.end(); }
    // ---- less admin: reminders that send themselves, and members who stopped coming
    { const { p: ha } = await phone(), pl = new Pool({ connectionString: DB });
      await ha.goto(URL + "/app/"); await ha.waitForTimeout(500);
      await ev(ha, () => api("POST", "/auth/start-gym", { gym: "Auto Gym", name: "Auto Head", email: "head@auto.test", password: "autohead11" }));
      await ha.reload(); await ha.waitForTimeout(900); await ev(ha, () => hideSheet());
      const g = await ev(ha, () => API.me.gym), plan = (await ev(ha, () => api("POST", "/coach/plans", { name: "Adult", priceCents: 85000, period: "month" }))).plan;
      const ids = []; for (const [i, n] of ["Gone Gina", "Gone Gus", "Here Hana", "Here Hugo", "Here Hlubi"].entries())
        ids.push(await ev(ha, (a) => api("POST", "/coach/students", { name: a[0], email: `s${a[2]}@auto.test`, planId: a[1] }).then((j) => j.id), [n, plan.id, i]));
      // someone added with only a WhatsApp number
      const gp = await ev(ha, (a) => api("POST", "/coach/students", { name: "Gone Phila", phone: "082 444 0101", planId: a }).then((j) => j.id), plan.id);
      const cls = (await ev(ha, () => api("POST", "/classes", { title: "Fundamentals", startsAt: new Date(Date.now() - 4 * 864e5).toISOString() }))).class.id;
      for (const id of ids.slice(2)) await ev(ha, (a) => api("PUT", `/coach/classes/${a[0]}/attendance`, { userId: a[1], attended: true }), [cls, id]);
      await pl.query("update users set created_at=now() - interval '90 days' where id = any($1)", [[...ids.slice(0, 2), gp].map(Number)]);
      await ev(ha, () => { coachGo("home"); return coachLoad(); }); await ha.waitForTimeout(900);
      ok(await ev(ha, () => /3\s*haven't trained in 60 days\.\s*Gone Gina, Gone Gus, Gone Phila/.test(document.getElementById("app").innerText) && !!document.querySelector('[data-a="idlepause"]') && !!document.querySelector('[data-a="idlekeep"]')), "Home: 3 haven't trained in 60 days, with Pause their fees and Keep");
      // a double tap (the second lands while the first is still going) pauses them once
      await ev(ha, () => { const b = document.querySelector('[data-a="idlepause"]'); b.click(); b.click(); }); await ha.waitForTimeout(1500);
      const gone = [...ids.slice(0, 2), gp];
      ok(await ev(ha, (a) => a.every((id) => COACH.roster.people.find((p) => p.id === id).planStatus === "paused") && !document.querySelector('#app [data-a="idlepause"]'), gone) && (await pl.query("select count(*)::int as n from plan_breaks where user_id = any($1) and reason='idle'", [gone.map(Number)])).rows[0].n === 3, "one tap pauses all three (a double tap, once each), and the card goes");
      ok(await ev(ha, () => { const t = document.getElementById("sheet").innerText, a = document.querySelector('#sheet a[data-wa="miss_you"]');
        return /Paused 3/.test(t) && /2 will get a friendly .we miss you. email\. 1 has no email: send them a WhatsApp/.test(t) && /Gone Phila/.test(t) && !!a && /wa\.me\/27824440101/.test(a.href) && /we miss you/.test(decodeURIComponent(a.href)); }), "Gone Phila has no email: the sheet says so and has a WhatsApp \"we miss you\" ready to send");
      await ha.tap('#sheetbar [data-a="idleundo"]'); await ha.waitForTimeout(1200);
      ok(/Undone/.test(await toast(ha)) && await ev(ha, (a) => a.every((id) => COACH.roster.people.find((p) => p.id === id).planStatus === "active") && !!document.querySelector('[data-a="idlepause"]'), gone), "Undo puts them back, and the card with them");
      await ha.tap('[data-a="idlekeep"]'); await ha.waitForTimeout(1000);
      ok(/30 days/.test(await toast(ha)) && await ev(ha, () => !document.querySelector('[data-a="idlepause"]')), "Keep hides the card");
      // The first "Email reminders" asks once whether to send them by themselves.
      await ev(ha, () => { COACH.money = null; coachGo("money"); }); await ha.waitForTimeout(1200);
      await ha.tap('[data-a="remindall"]'); await ha.waitForTimeout(300);
      ok(await ev(ha, () => /Send these automatically\?/.test(document.getElementById("sheet").innerText) && /7 days later/.test(document.getElementById("sheet").innerText) && !!document.querySelector('#sheetbar [data-a="remindyes"][data-v="auto"]') && !!document.querySelector('#sheetbar [data-a="remindyes"][data-v="once"]')), "the first time, it asks: Yes, automatically or Just this once");
      await ha.tap('#sheetbar [data-a="remindyes"][data-v="auto"]'); await ha.waitForTimeout(1200);
      ok(/Sent 5 reminders\. From now on they go by themselves/.test(await toast(ha)) && (await pl.query("select auto_remind from gyms where id=$1", [g.id])).rows[0].auto_remind === true, "Yes sends them now and switches it on: " + await toast(ha));
      await ha.waitForTimeout(600);
      ok(await ev(ha, () => (document.getElementById("app").innerText.match(/reminded today/g) || []).length === 5 && !document.querySelector('[data-a="remindall"]') && /Everyone with an email was reminded this week/.test(document.getElementById("app").innerText)), "Money then says who was reminded today, and there's no button to email them again");
      await pl.query("update users set reminded_at=now() - interval '7 days' where gym_id=$1", [g.id]); await ev(ha, () => loadMoney()); await ha.waitForTimeout(800);
      await ha.tap('[data-a="remindall"]'); await ha.waitForTimeout(300);
      ok(await ev(ha, () => /Email 5 reminders\?/.test(document.getElementById("sheet").innerText) && !/automatically\?/.test(document.getElementById("sheet").innerText)), "it isn't asked again");
      await ev(ha, () => hideSheet()); await ha.tap('[data-a="moneyview"][data-v="setup"]'); await ha.waitForTimeout(900);
      ok(await ev(ha, () => document.getElementById("m-auto") && document.getElementById("m-auto").checked), "Money › Setup shows them switched on");
      await ha.uncheck("#m-auto"); await ha.waitForTimeout(900);
      ok(/off/.test(await toast(ha)) && (await pl.query("select auto_remind from gyms where id=$1", [g.id])).rows[0].auto_remind === false, "and one tap switches them off");
      // What the job did today shows on Home.
      await pl.query(`update gyms set remind_log=jsonb_build_object('day', to_char(now() at time zone 'Africa/Johannesburg','YYYY-MM-DD'), 'sent', 4, 'to', '["Here Hana","Here Hugo","Here Hlubi","Gone Gus"]'::jsonb,
        'failed', '["Gone Gina"]'::jsonb, 'noEmail', '["Gone Phila"]'::jsonb, 'done', true) where id=$1`, [g.id]);
      await ev(ha, () => { coachGo("home"); return coachLoad("roster"); }); await ha.waitForTimeout(800);
      ok(await ev(ha, () => /Reminders sent to\s*4\s*today · 1 couldn't be sent · 1 with no email/.test(document.getElementById("app").innerText)), "Home: Reminders sent to 4 today, 1 couldn't be sent, 1 with no email");
      await ha.tap('[data-a="remindsee"]'); await ha.waitForTimeout(400);
      ok(await ev(ha, () => { const t = document.getElementById("sheet").innerText; return /Emailed \(4\)/i.test(t) && /Here Hana/.test(t) && /Gone Gus/.test(t) && /Couldn't be sent \(1\)\s*We'll try these again/i.test(t) && /Gone Gina/.test(t) && /No email \(1\)/i.test(t) && /Gone Phila/.test(t); }), "See who lists who was emailed, who couldn't be, and who has no email: " + await ev(ha, () => document.getElementById("sheet").innerText));
      await ha.tap('#sheetbar [data-a="remindmoney"]'); await ha.waitForTimeout(900);
      ok(await ev(ha, () => !!document.getElementById("sheet").hidden && COACH.view === "money"), "and Open Money goes to the owing list");
      await ev(ha, () => coachGo("home")); await ha.waitForTimeout(500);
      await wide(ha, "coach home with the automation cards");
      await ha.context().close(); await pl.end(); }
    // ---- a coach removes a student who has their own account
    { const lz = await ev(co, () => COACH.roster.people.find((p) => p.name === "Lindi Z").id);
      await ev(co, (id) => studentSheet(id), lz); await co.waitForTimeout(900);
      await co.tap('#sheet [data-a="studelask"]'); await co.waitForTimeout(300);
      ok(await ev(co, () => /keeps their JitsFlow account/.test(document.getElementById("sheet").innerText)), "removing a student with an account says they keep it");
      await co.tap('#sheetbar [data-a="studelyes"]'); await co.waitForTimeout(1200);
      ok(await ev(co, (id) => !COACH.roster.people.some((p) => p.id === id), lz), "and takes them off the list"); }
    // ---- the only coach closes the gym
    await ev(co, () => { hideSheet(); coachGo("gym"); }); await co.waitForTimeout(400);
    await co.tap('[data-a="delacct"]'); await co.fill("#d-pass", "coachpass1"); await co.tap('#delform [type=submit]'); await co.waitForTimeout(900);
    ok(/only coach/.test(await toast(co)) && /Gym tab/.test(await toast(co)) && await ev(co, () => !!API.me), "the only coach can't just delete their account: they're pointed to Delete gym");
    await co.tap('[data-a="gymdel"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => /permanently deletes JPB Martial Arts Academy/.test(document.getElementById("gymdel").innerText)), "Delete gym says what goes and asks for the password");
    await co.fill('#gymdelform [name=password]', "wrongpass1"); await co.tap('#gymdelform [type=submit]'); await co.waitForTimeout(700);
    ok(/password isn't right/.test(await toast(co)) && await ev(co, () => !!API.me.gym), "a wrong password keeps the gym");
    await co.fill('#gymdelform [name=password]', "coachpass1"); await co.tap('#gymdelform [type=submit]'); await co.waitForTimeout(1200);
    ok(/gym is deleted/.test(await toast(co)) && await ev(co, () => API.me && !API.me.gym && !isCoach() && location.hash === "#home"), "deleting the gym keeps the coach's own account, with no gym");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e).toString().split("\n").slice(0, 3).join(" ")); }
  ok(errs.length === 0, "page errors: " + errs.join(" | "));
  await b.close(); srv.kill(); site.close(); sink.close();
  console.log(`accounts: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
