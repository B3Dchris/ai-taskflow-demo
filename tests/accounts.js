// End-to-end: a coach and a student using accounts, classes, the roster and payments in real browsers.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/accounts.js   (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade"); await pool.end();
  const port = 9800 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB }, stdio: ["ignore", "ignore", "inherit"] });
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
    ok(await ev(co, () => isCoach() && location.hash === "#coach" && !document.querySelector('nav.tabs [data-v="coach"]').hidden), "coach is signed in and sees the Coach tab");
    ok(await ev(co, () => /Coach/.test(document.querySelector(".sync.who").textContent)), "header shows who's signed in");
    ok(await ev(co, () => { hideSheet(); go("today"); return !!document.querySelector(".sync.who") && !document.querySelector('[data-a="auth"][data-v="login"].who'); }), "signed-in header shows the name, not Sign in");
    await co.tap('nav.tabs [data-v="coach"]');
    await co.tap('[data-a="coachview"][data-v="gym"]');
    const invite = await ev(co, () => document.querySelector(".codebox").textContent);
    ok(/\/app\/\?join=[A-Z0-9]{8}$/.test(invite), "gym tab shows the student invite link");
    await wide(co, "coach gym tab");
    // ---- coach plans a class
    await co.tap('[data-a="coachview"][data-v="classes"]'); await co.tap('[data-a="classnew"]');
    await co.fill("#c-title", "No-gi: half guard"); await co.fill("#c-focus", "Half guard bottom");
    await co.selectOption("#c-add", "hg_frames"); await co.selectOption("#c-add", "hg_dogfight");
    ok(await ev(co, () => document.querySelectorAll("#cplan-chips .chip").length === 2), "techniques added to the plan");
    await co.fill("#c-notes", "Underhook battles, 3 x 3 min");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(700);
    ok(await ev(co, () => document.querySelectorAll(".classcard").length === 1 && /No-gi: half guard/.test(document.querySelector(".classcard").innerText)), "class is planned and listed");
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
    ok(await ev(st, () => /Next class/i.test(document.body.innerText) && /No-gi: half guard/.test(document.querySelector(".nextclass").innerText) && document.querySelectorAll(".nextclass .trow").length === 2), "student sees the next class and the coach's plan");
    await st.locator('.nextclass [data-a="rsvp"]').tap(); await st.waitForTimeout(700);
    ok(await ev(st, () => /You're going/.test(document.querySelector(".nextclass").innerText)), "student taps I'm going");
    await wide(st, "student today");
    // student logs a session (goes to the server)
    await st.tap(".fab"); await st.selectOption("#f-tapped", "rnc"); await st.locator('#sheet [data-a="stuck"][data-v="hg_bot"]').tap();
    await st.tap('#sheetbar button[type=submit]'); await st.waitForTimeout(700);
    ok(await ev(st, async () => (await (await fetch("/api/logs")).json()).logs.length === 1), "logged session is saved on the server");
    // clear the phone: progress comes back from the server
    await ev(st, () => { localStorage.clear(); }); await st.reload(); await st.waitForTimeout(1500);
    ok(await ev(st, () => S.mode === "api" && lv("knee_cut") === 3 && S.sessions.length === 1), "after clearing the phone, progress and log come back from the account");
    // ---- coach sees who's coming and plans with it
    await co.tap('nav.tabs [data-v="today"]'); await co.tap('nav.tabs [data-v="coach"]'); await ev(co, () => coachLoad()); await co.waitForTimeout(600);
    ok(await ev(co, () => /1\s*going/i.test(document.querySelector(".classcard").innerText)), "coach sees 1 going");
    await co.locator(".classcard").first().tap(); await co.waitForTimeout(700);
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
    await co.tap('[data-a="coachview"][data-v="roster"]'); await ev(co, () => coachLoad("roster")); await co.waitForTimeout(500);
    ok(await ev(co, () => /Chris/.test(document.getElementById("roster-list").innerText)), "roster lists the student");
    await co.locator('#roster-list [data-a="student"]').first().tap(); await co.waitForTimeout(700);
    await co.selectOption("#s-belt", "blue"); await co.selectOption("#s-stripes", "1"); await co.fill("#s-fee", "850"); await co.fill("#s-notes", "Strong underhook");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(800);
    ok(await ev(co, () => /Blue · 1 stripe/.test(document.getElementById("roster-list").innerText) && /Due/.test(document.getElementById("roster-list").innerText)), "coach sets belt and fee; roster shows fee due");
    await co.tap('[data-a="coachview"][data-v="payments"]'); await co.tap('[data-a="paynew"]');
    await co.selectOption("#p-user", { label: "Chris" }); await co.fill("#p-amt", "850"); await co.fill("#p-ref", "CHRIS NOV");
    await co.tap('#sheetbar [type=submit]'); await co.waitForTimeout(900);
    ok(await ev(co, () => /R\s?850/.test(document.querySelector(".stats").innerText) && /Chris/.test(document.body.innerText)), "payment recorded and totals updated");
    await co.tap('[data-a="coachview"][data-v="roster"]');
    ok(await ev(co, () => /Paid/.test(document.getElementById("roster-list").innerText)), "roster shows the student as paid");
    await wide(co, "coach payments/roster");
    // ---- student signs out
    await st.tap('nav.tabs [data-v="settings"]'); await st.tap('[data-a="signout"]'); await st.waitForTimeout(500);
    ok(await ev(st, () => !API.me && S.mode === "local" && /Saved on this device/.test(document.getElementById("sync").textContent)), "student signs out");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e).toString().split("\n").slice(0, 3).join(" ")); }
  ok(errs.length === 0, "page errors: " + errs.join(" | "));
  await b.close(); srv.kill();
  console.log(`accounts: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
