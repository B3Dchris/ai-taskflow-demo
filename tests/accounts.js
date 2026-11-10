// End-to-end: a coach and a student using accounts, classes, the roster and payments in real browsers.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/accounts.js   (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg"); const { startGymSite, startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade"); await pool.end();
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
    await st.tap(".fab"); await st.selectOption("#f-tapped", "rnc"); await st.locator('#sheet [data-a="stuck"][data-v="hg_bot"]').tap();
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
    ok(await ev(co, () => document.querySelectorAll("#gymeditform .edrow.tt").length === 9 && document.querySelectorAll(".logoopt img").length >= 1 && /Read 10 pages of your site/.test(document.getElementById("sheet").innerText)), "import preview shows the class times, logo and pages read");
    await wide(co, "import preview");
    await co.locator('#gymeditform [data-a="germ"][data-k="timetable"]').last().tap(); await co.waitForTimeout(200);
    ok(await ev(co, () => document.querySelectorAll("#gymeditform .edrow.tt").length === 8 && !/Competition Training/.test([...document.querySelectorAll('#gymeditform [name^="tt-title"]')].map((x) => x.value).join())), "coach removes a class time");
    await co.fill('#gymeditform [name="name"]', "JPB Martial Arts Academy");
    await co.locator('[data-a="geadd"][data-v="coaches"]').tap(); await co.waitForTimeout(200); await co.fill('#gymeditform [name="co-name-2"]', "JP Buys"); await co.fill('#gymeditform [name="co-rank-2"]', "Black belt, head coach");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    ok(await ev(co, () => /Standard fee set to/.test(document.getElementById("toast").textContent)), "monthly rate becomes the standard fee: " + (await toast(co)));
    ok(await ev(co, () => { const g = document.querySelector(".gymcard"); return g && g.querySelectorAll(".ttline").length === 8 && /JP Buys/.test(g.innerText) && /Witkoppen/.test(g.innerText) && !!g.querySelector("img.gymlogo") && g.querySelector("img.gymlogo").naturalWidth > 0; }), "gym card shows the saved timetable, coaches, address and logo");
    ok(await ev(co, () => /JPB Martial Arts Academy/.test(document.querySelector(".gymhead").innerText) && !document.querySelector(".gymhead img.gymlogo.sm") && document.querySelectorAll("img.gbl").length === 1 && /Powered by JitsFlow\.com/.test(document.querySelector(".gymbrand").innerText)), "coach header keeps the edited name, one logo, Powered by JitsFlow.com");
    await wide(co, "coach gym profile");
    const nBefore = await ev(co, () => (COACH.classes || []).length);
    await co.selectOption("#tt-weeks", "1"); await co.tap('[data-a="ttclasses"]'); await co.waitForTimeout(1500);
    const nAfter = await ev(co, () => (COACH.classes || []).length);
    ok(nAfter >= nBefore + 5 && /Added \d+ class/.test(await toast(co)), `timetable is added to Classes (${nBefore} → ${nAfter})`);
    await co.tap('nav.tabs [data-v="coach-gym"]'); await co.selectOption("#tt-weeks", "1"); await co.tap('[data-a="ttclasses"]'); await co.waitForTimeout(1500);
    ok(/already there/.test(await toast(co)) && (await ev(co, () => (COACH.classes || []).length)) === nAfter, "adding again skips classes already there");
    // ---- reopening the app (no #) lands on Today, and the website's coaches are there without visiting the Gym tab
    await co.goto(URL + "/app/"); await co.waitForTimeout(1500);
    ok(await ev(co, () => location.hash === "#coach-home" && COACH.view === "home"), "a coach reopening the app lands on Home: " + (await ev(co, () => location.hash)));
    ok(await ev(co, () => !!GYM.data && (gymProfile().coaches || []).length >= 2), "the gym's profile (coaches, timetable, prices) loads without opening the Gym tab");
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.tap('[data-a="classnew"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => document.getElementById("c-coach").tagName === "SELECT" && /Anna/.test(document.getElementById("c-coach").innerText)), "so Plan a class offers the website's coaches");
    await ev(co, () => hideSheet());
    // ---- the student sees their gym's details
    await st.tap('nav.tabs [data-v="me"]'); await st.waitForTimeout(1000);
    ok(await ev(st, () => { const g = document.querySelector(".gymcard"); return g && g.querySelectorAll(".ttline").length === 8 && /R\s?850/.test(g.innerText) && !!g.querySelector('a[href^="tel:"]') && !!g.querySelector('a[href*="wa.me"]') && !document.querySelector('[data-a="gymedit"]'); }), "student sees the timetable, rates and contact buttons (and can't edit)");
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
    await co.selectOption("#c-repeat", "4"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(/Added 4 weekly classes/.test(await toast(co)) && await ev(co, (k) => calState("coach").sel === k && document.querySelectorAll(".calrow").length >= 1, dayK), "repeat weekly adds 4 classes and jumps to the day: " + (await toast(co)));
    await co.tap('[data-a="calmode"][data-v="month"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => document.querySelectorAll(".mcell").length >= 28 && [...document.querySelectorAll(".mcell i")].length >= 2), "month view shows a grid with class counts");
    await wide(co, "month calendar");
    await co.tap('[data-a="calmode"][data-v="week"]'); await co.waitForTimeout(200);
    const before2 = await ev(co, () => COACH.classes.length);
    await co.tap('[data-a="copyweek"]'); await co.waitForTimeout(1500);
    ok(/already there|Copied/.test(await toast(co)) && (await ev(co, () => COACH.classes.length)) >= before2, "copy this week to next week: " + (await toast(co)));
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
