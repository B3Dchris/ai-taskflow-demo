// End-to-end: a coach and a student using accounts, classes, the roster and payments in real browsers.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/accounts.js   (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg"); const { startGymSite, startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade"); await pool.end();
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
    await co.locator('.toplinks .signin').tap(); await co.waitForTimeout(900);
    ok(await ev(co, () => location.pathname === "/app/" && S.ui.sheet && S.ui.sheet.k === "auth" && S.ui.authMode === "login"), "landing 'Coach sign in' opens the sign-in sheet");
    await co.tap('[data-a="authmode"][data-v="gym"]');
    await co.fill("#a-gym", "JPB Martial Arts Academy"); await co.fill("#a-name", "Coach JP"); await co.fill("#a-email", "coach@example.com"); await co.fill("#a-pass", "coachpass1");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(900);
    ok(await ev(co, () => isCoach() && location.hash === "#coach-today" && !document.querySelector('nav.tabs [data-v="coach-classes"]').hidden && document.querySelector('nav.tabs [data-v="learn"]').hidden && document.querySelector('nav.tabs [data-v="flow"]').hidden), "coach lands on their gym's Today; the bar shows coach tabs, not Belts or Flow map");
    ok(await ev(co, () => /Coach/.test(document.querySelector(".sync.who").textContent)), "header shows who's signed in");
    ok(await ev(co, () => { hideSheet(); go("today"); return !!document.querySelector(".sync.who") && !document.querySelector('[data-a="auth"][data-v="login"].who'); }), "signed-in header shows the name, not Sign in");
    await co.tap('nav.tabs [data-v="coach-gym"]');
    const invite = await ev(co, () => document.querySelector(".codebox").textContent);
    ok(/\/app\/\?join=[A-Z0-9]{8}$/.test(invite), "gym tab shows the student invite link");
    await wide(co, "coach gym tab");
    // ---- coach plans a class
    await co.tap('nav.tabs [data-v="coach-classes"]'); await co.tap('[data-a="classnew"]');
    await co.fill("#c-title", "No-gi: half guard"); await co.locator(".planbox summary").tap(); await co.fill("#c-focus", "Half guard bottom");
    await co.selectOption("#c-add", "hg_frames"); await co.selectOption("#c-add", "hg_dogfight");
    ok(await ev(co, () => document.querySelectorAll("#cplan-chips .chip").length === 2), "techniques added to the plan");
    await co.fill("#c-notes", "Underhook battles, 3 x 3 min");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(700);
    ok(await ev(co, () => document.querySelectorAll(".calrow").length === 1 && /No-gi: half guard/.test(document.querySelector(".calrow").innerText) && document.querySelector(".wday.sel i").textContent === "1"), "class is planned and listed");
    await wide(co, "coach classes");
    // ---- student joins from the invite link
    const { c: sc, p: st } = await phone();
    await st.goto(invite); await st.waitForTimeout(900);
    ok(await ev(st, () => S.ui.sheet && S.ui.sheet.k === "auth" && document.getElementById("a-code").value.length === 8 && !/join=/.test(location.search)), "invite link opens sign-up with the code filled in");
    await st.fill("#a-name", "Chris"); await st.fill("#a-email", "chris@example.com"); await st.fill("#a-pass", "studentpass1");
    await st.tap('#sheetbar [type=submit]'); await st.waitForTimeout(900);
    ok(await ev(st, () => API.me && API.me.role === "student" && API.me.gym.name === "JPB Martial Arts Academy"), "student account created in the gym");
    if (await ev(st, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await st.tap('#sheetbar [data-a="obdone"]');
    ok(await ev(st, () => document.querySelector('nav.tabs [data-v="coach"]').hidden), "students don't see the Coach tab");
    await ev(st, () => { P().mastery.hg_frames = 2; P().mastery.knee_cut = 3; P().mastery.upa = 1; saveProgress(); });
    await st.waitForTimeout(1200);
    await st.tap('nav.tabs [data-v="today"]'); await st.waitForTimeout(600);
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
    await co.tap('nav.tabs [data-v="coach-today"]'); await co.tap('nav.tabs [data-v="coach-classes"]'); await ev(co, () => coachLoad()); await co.waitForTimeout(600);
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
    await co.tap('nav.tabs [data-v="coach-students"]'); await co.tap('[data-a="stuview"][data-v="list"]'); await ev(co, () => coachLoad("roster")); await co.waitForTimeout(500);
    ok(await ev(co, () => /Chris/.test(document.getElementById("roster-list").innerText)), "roster lists the student");
    await co.locator('#roster-list [data-a="student"]').first().tap(); await co.waitForTimeout(700);
    await co.selectOption("#s-belt", "blue"); await co.selectOption("#s-stripes", "1"); await co.fill("#s-fee", "850"); await co.fill("#s-notes", "Strong underhook");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(800);
    ok(await ev(co, () => /Blue · 1 stripe/.test(document.getElementById("roster-list").innerText) && /Due/.test(document.getElementById("roster-list").innerText)), "coach sets belt and fee; roster shows fee due");
    await co.tap('nav.tabs [data-v="coach-money"]'); await co.tap('[data-a="paynew"]');
    await co.selectOption("#p-user", { label: "Chris" }); await co.fill("#p-amt", "850"); await co.fill("#p-ref", "CHRIS NOV");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(900);
    ok(await ev(co, () => /R\s?850/.test(document.querySelector(".stats").innerText) && /Chris/.test(document.body.innerText)), "payment recorded and totals updated");
    await co.tap('nav.tabs [data-v="coach-students"]'); await co.tap('[data-a="stuview"][data-v="list"]');
    ok(await ev(co, () => /Paid/.test(document.getElementById("roster-list").innerText)), "roster shows the student as paid");
    await wide(co, "coach payments/roster");
    // ---- coach imports the gym's website, checks it and saves
    await co.tap('nav.tabs [data-v="coach-gym"]'); await co.waitForTimeout(400);
    await co.fill("#gi-url", site.url); await co.tap("#gymimpform [type=submit]");
    await co.waitForSelector("#gymeditform", { timeout: 20000 });
    ok(await ev(co, () => document.querySelectorAll("#gymeditform .edrow.tt").length === 9 && document.querySelectorAll(".logoopt img").length >= 1 && /Read 8 pages of your site/.test(document.getElementById("sheet").innerText)), "import preview shows the class times, logo and pages read");
    await wide(co, "import preview");
    await co.locator('#gymeditform [data-a="germ"][data-k="timetable"]').last().tap(); await co.waitForTimeout(200);
    ok(await ev(co, () => document.querySelectorAll("#gymeditform .edrow.tt").length === 8 && !/Competition Training/.test([...document.querySelectorAll('#gymeditform [name^="tt-title"]')].map((x) => x.value).join())), "coach removes a class time");
    await co.fill('#gymeditform [name="name"]', "JPB Martial Arts Academy");
    await co.locator('[data-a="geadd"][data-v="coaches"]').tap(); await co.waitForTimeout(200); await co.fill('#gymeditform [name="co-name-2"]', "JP Buys"); await co.fill('#gymeditform [name="co-rank-2"]', "Black belt, head coach");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    ok(await ev(co, () => /Standard fee set to/.test(document.getElementById("toast").textContent)), "monthly rate becomes the standard fee: " + (await toast(co)));
    ok(await ev(co, () => { const g = document.querySelector(".gymcard"); return g && g.querySelectorAll(".ttline").length === 8 && /JP Buys/.test(g.innerText) && /Witkoppen/.test(g.innerText) && !!g.querySelector("img.gymlogo") && g.querySelector("img.gymlogo").naturalWidth > 0; }), "gym card shows the saved timetable, coaches, address and logo");
    ok(await ev(co, () => /JPB Martial Arts Academy/.test(document.querySelector(".gymhead").innerText) && !!document.querySelector(".gymhead img.gymlogo.sm")), "coach header keeps the edited name and shows the logo");
    await wide(co, "coach gym profile");
    const nBefore = await ev(co, () => (COACH.classes || []).length);
    await co.selectOption("#tt-weeks", "1"); await co.tap('[data-a="ttclasses"]'); await co.waitForTimeout(1500);
    const nAfter = await ev(co, () => (COACH.classes || []).length);
    ok(nAfter >= nBefore + 5 && /Added \d+ class/.test(await toast(co)), `timetable is added to Classes (${nBefore} → ${nAfter})`);
    await co.tap('nav.tabs [data-v="coach-gym"]'); await co.selectOption("#tt-weeks", "1"); await co.tap('[data-a="ttclasses"]'); await co.waitForTimeout(1500);
    ok(/already there/.test(await toast(co)) && (await ev(co, () => (COACH.classes || []).length)) === nAfter, "adding again skips classes already there");
    // ---- the student sees their gym's details
    await st.tap('nav.tabs [data-v="settings"]'); await st.waitForTimeout(1000);
    ok(await ev(st, () => { const g = document.querySelector(".gymcard"); return g && g.querySelectorAll(".ttline").length === 8 && /R\s?850/.test(g.innerText) && !!g.querySelector('a[href^="tel:"]') && !!g.querySelector('a[href*="wa.me"]') && !document.querySelector('[data-a="gymedit"]'); }), "student sees the timetable, rates and contact buttons (and can't edit)");
    await wide(st, "student gym card");
    // ---- student signs out
    await st.tap('nav.tabs [data-v="settings"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
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
    await st.tap('nav.tabs [data-v="settings"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
    await st.goto(URL + "/app/?signin=1"); await st.waitForTimeout(900);
    await st.fill("#a-email", "chris@example.com"); await st.fill("#a-pass", "studentpass1"); await st.tap("#sheetbar [type=submit]"); await st.waitForTimeout(1500);
    ok(await ev(st, () => API.me.name === "Chris" && lv("knee_cut") === 3 && lv("upa") !== 3 && S.sessions.length === 1), "signing in on a shared phone shows that account's data, not the last person's");
    await st.tap('nav.tabs [data-v="settings"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
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
    await co.tap('nav.tabs [data-v="coach-classes"]'); await co.waitForTimeout(300);
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
    await co.tap('nav.tabs [data-v="coach-classes"]'); await co.tap('[data-a="privnew"]');
    await co.fill("#pv-times", "18:30"); await co.fill("#pv-price", "450"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(900);
    ok(await ev(co, () => [...document.querySelectorAll(".calrow.priv")].some((c) => /Open slot/.test(c.innerText) && /R\s?450/.test(c.innerText))), "coach adds a private lesson slot");
    await st.evaluate(() => { API.classes = null; }); await st.tap('nav.tabs [data-v="book"]'); await st.waitForTimeout(900);
    ok(await ev(st, () => !document.querySelector('nav.tabs [data-v="book"]').hidden && /No-gi: half guard/.test(document.getElementById("app").innerText) && !!document.querySelector(".bookcard.mine")), "student's Classes tab lists classes and marks their booking");
    await wide(st, "student classes");
    await st.tap('[data-a="bookview"][data-v="private"]'); await st.waitForTimeout(300);
    await st.locator('.bookcard.priv [data-a="rsvp"]').first().tap(); await st.waitForTimeout(900);
    ok(await ev(st, () => /Your private lessons/i.test(document.getElementById("app").innerText) && /You're booked/.test(document.querySelector(".bookcard.priv").innerText)), "student books the private lesson");
    await co.evaluate(() => coachLoad("classes")); await co.waitForTimeout(700);
    ok(await ev(co, () => [...document.querySelectorAll(".calrow.priv")].some((c) => /Booked by Chris/.test(c.innerText))), "coach sees who booked the private");
    await co.tap('nav.tabs [data-v="coach-money"]'); await co.tap('[data-a="planedit"][data-v="new"]');
    await co.fill('#planform [name="name"]', "2x a week"); await co.fill('#planform [name="price"]', "650"); await co.fill('#planform [name="cpw"]', "2");
    await co.tap('#planform [type=submit]'); await co.waitForTimeout(800);
    ok(await ev(co, () => /2x a week/.test(document.getElementById("app").innerText) && /2\/week/.test(document.getElementById("app").innerText)), "coach adds a membership plan");
    await co.tap('nav.tabs [data-v="coach-students"]'); await co.tap('[data-a="stuview"][data-v="list"]'); await co.locator('#roster-list [data-a="student"]').first().tap(); await co.waitForTimeout(700);
    await co.selectOption("#s-plan", { label: "2x a week · R 650" }).catch(async () => { const v = await ev(co, () => [...document.querySelectorAll("#s-plan option")].find((o) => /2x a week/.test(o.textContent)).value); await co.selectOption("#s-plan", v); });
    await co.fill("#s-fee", ""); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(800);
    ok(await ev(co, () => /2x a week/.test(document.getElementById("roster-list").innerText)), "coach puts the student on the plan");
    await st.evaluate(() => { API.mem = undefined; }); await st.tap('[data-a="bookview"][data-v="classes"]'); await st.waitForTimeout(900);
    ok(await ev(st, () => /2x a week/.test(document.querySelector(".memcard").innerText) && /1\/2/.test(document.querySelector(".memcard").innerText)), "student sees their plan and bookings used this week");
    await co.tap('nav.tabs [data-v="coach-students"]'); await co.tap('[data-a="stuview"][data-v="insights"]'); await co.waitForTimeout(1200);
    ok(await ev(co, () => !!document.querySelector(".chart svg .bar") && /Active members/i.test(document.getElementById("app").innerText) && document.querySelectorAll(".segpills button").length === 6 && /Chris/.test(document.getElementById("app").innerText)), "coach opens Insights: numbers, weekly chart, student groups");
    await co.locator(".chart .bar").last().tap(); ok(/visits by/.test(await toast(co)), "tapping a bar reads out the week");
    await wide(co, "insights");
    await co.tap('nav.tabs [data-v="coach-classes"]'); await co.locator(".calrow").first().tap(); await co.waitForTimeout(700);
    await co.tap('#sheetbar [data-a="back"]');
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e).toString().split("\n").slice(0, 3).join(" ")); }
  ok(errs.length === 0, "page errors: " + errs.join(" | "));
  await b.close(); srv.kill(); site.close(); sink.close();
  console.log(`accounts: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
